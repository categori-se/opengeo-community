import json
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize
from opengeo_api.external_sources import ExternalSourceType
from opengeo_api.ingestion import DatasetClassification, DatasetFormat, ProjectRole
from opengeo_api.map_definitions import (
    LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
    MAP_DEFINITION_SCHEMA_VERSION,
    PATH_MAP_DEFINITION_SCHEMA_VERSION,
    PROCESSING_MAP_DEFINITION_SCHEMA_VERSION,
    validate_map_definition,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)
from opengeo_api.workspaces import (
    _MAP_DEFINITION_CHUNK_BYTES,
    PostgresWorkspaceRepository,
    WorkspaceConflict,
    WorkspaceStoreUnavailable,
)

ProjectImportState = Literal["open", "completed"]
ProjectImportItemKind = Literal["external_source", "embedded_dataset"]
ProjectImportItemState = Literal["pending", "bound"]
OperationResult = TypeVar("OperationResult")


class ProjectImportStoreUnavailable(RuntimeError):
    pass


class ProjectImportAccessDenied(RuntimeError):
    pass


class ProjectImportNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class ProjectImportConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ExternalImportCandidate:
    import_ref: str
    name: str
    description: str | None
    classification: DatasetClassification
    source_type: ExternalSourceType
    source_url: str
    configuration: dict[str, Any]
    tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class EmbeddedImportCandidate:
    import_ref: str
    name: str
    description: str | None
    classification: DatasetClassification
    format: Literal["geojson"]
    filename: str
    content_type: Literal["application/geo+json"]
    size_bytes: int
    checksum_sha256: str
    tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProjectImportDraft:
    idempotency_key: UUID
    map_id: UUID
    expected_map_version: int
    source_product: Literal["geolibre"]
    source_version: str
    source_sha256: str
    plan_digest: str
    map_definition: dict[str, Any]
    conversion_report: dict[str, Any]
    external_sources: tuple[ExternalImportCandidate, ...]
    embedded_datasets: tuple[EmbeddedImportCandidate, ...]


@dataclass(frozen=True, slots=True)
class ProjectImportItem:
    import_ref: str
    kind: ProjectImportItemKind
    expected_source_type: str
    expected_format: DatasetFormat
    candidate: dict[str, Any]
    state: ProjectImportItemState
    dataset_id: UUID | None
    bound_at: datetime | None


@dataclass(frozen=True, slots=True)
class ProjectImport:
    import_id: UUID
    project_id: UUID
    map_id: UUID
    idempotency_key: UUID
    source_product: str
    source_version: str
    source_sha256: str
    plan_digest: str
    expected_map_version: int
    state: ProjectImportState
    items: tuple[ProjectImportItem, ...]
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    final_map_version: int | None = None

    @property
    def ready(self) -> bool:
        return self.state == "open" and all(item.state == "bound" for item in self.items)


class ProjectImportRepository(Protocol):
    async def create_import(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ProjectImportDraft,
        request_id: str,
    ) -> ProjectImport: ...

    async def get_import(
        self, context: TenantContext, project_id: UUID, import_id: UUID
    ) -> ProjectImport: ...

    async def bind_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        import_id: UUID,
        import_ref: str,
        dataset_id: UUID,
        request_id: str,
    ) -> ProjectImport: ...

    async def finalize_import(
        self,
        context: TenantContext,
        project_id: UUID,
        import_id: UUID,
        request_id: str,
    ) -> ProjectImport: ...


class PostgresProjectImportRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise ProjectImportConflict("project_import_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ProjectImportStoreUnavailable("project import operation failed") from error

    async def create_import(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ProjectImportDraft,
        request_id: str,
    ) -> ProjectImport:
        import_id = uuid4()
        source_ids = {candidate.import_ref: uuid4() for candidate in draft.external_sources}

        async def operation(transaction: TenantTransaction) -> ProjectImport:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.MAP_UPDATE, roles)
            self._require(Action.DATASET_SOURCE_CREATE, roles)
            existing = await transaction.fetch_one(
                """
                SELECT id, source_sha256, plan_digest, map_id, expected_map_version
                FROM app.project_import_operations
                WHERE organization_id = %s AND project_id = %s AND idempotency_key = %s
                """,
                (context.organization_id, project_id, draft.idempotency_key),
            )
            if existing is not None:
                if (
                    existing[1] != draft.source_sha256
                    or existing[2] != draft.plan_digest
                    or existing[3] != draft.map_id
                    or existing[4] != draft.expected_map_version
                ):
                    raise ProjectImportConflict("project_import_idempotency_mismatch")
                return await self._load_import(
                    transaction, context, project_id, cast(UUID, existing[0])
                )
            map_row = await transaction.fetch_one(
                """
                SELECT version FROM app.maps
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, draft.map_id),
            )
            if map_row is None:
                raise ProjectImportNotFound("map")
            current_version = cast(int, map_row[0])
            if current_version != draft.expected_map_version:
                raise ProjectImportConflict("map_version_conflict", current_version=current_version)
            await self._require_geolibre_return(
                transaction,
                context,
                project_id,
                draft.map_id,
                draft.expected_map_version,
                draft.map_definition,
                {candidate.import_ref for candidate in draft.external_sources}
                | {candidate.import_ref for candidate in draft.embedded_datasets},
            )
            await transaction.execute(
                """
                INSERT INTO app.project_import_operations
                  (id, organization_id, project_id, map_id, idempotency_key,
                   source_product, source_version, source_sha256, plan_digest,
                   expected_map_version, map_definition, conversion_report, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    import_id,
                    context.organization_id,
                    project_id,
                    draft.map_id,
                    draft.idempotency_key,
                    draft.source_product,
                    draft.source_version,
                    draft.source_sha256,
                    draft.plan_digest,
                    draft.expected_map_version,
                    Jsonb(draft.map_definition),
                    Jsonb(draft.conversion_report),
                    context.user_id,
                ),
            )
            for source_candidate in draft.external_sources:
                dataset_id = source_ids[source_candidate.import_ref]
                await self._create_external_source(
                    transaction,
                    context,
                    project_id,
                    dataset_id,
                    source_candidate,
                    request_id,
                )
                await transaction.execute(
                    """
                    INSERT INTO app.project_import_items
                      (organization_id, import_id, import_ref, kind,
                       expected_source_type, expected_format, candidate,
                       state, dataset_id, bound_at)
                    VALUES (%s, %s, %s, 'external_source', %s, %s, %s,
                            'bound', %s, clock_timestamp())
                    """,
                    (
                        context.organization_id,
                        import_id,
                        source_candidate.import_ref,
                        source_candidate.source_type,
                        source_candidate.source_type,
                        Jsonb(self._external_candidate_record(source_candidate)),
                        dataset_id,
                    ),
                )
            for embedded_candidate in draft.embedded_datasets:
                await transaction.execute(
                    """
                    INSERT INTO app.project_import_items
                      (organization_id, import_id, import_ref, kind,
                       expected_source_type, expected_format, candidate)
                    VALUES (%s, %s, %s, 'embedded_dataset', 'upload', %s, %s)
                    """,
                    (
                        context.organization_id,
                        import_id,
                        embedded_candidate.import_ref,
                        embedded_candidate.format,
                        Jsonb(self._embedded_candidate_record(embedded_candidate)),
                    ),
                )
            await self._record_event(
                transaction,
                context,
                project_id,
                "project.import.created",
                import_id,
                request_id,
                {
                    "source_product": draft.source_product,
                    "source_version": draft.source_version,
                    "map_id": str(draft.map_id),
                    "external_source_count": len(draft.external_sources),
                    "embedded_dataset_count": len(draft.embedded_datasets),
                },
            )
            return await self._load_import(transaction, context, project_id, import_id)

        return await self._run(context, operation)

    async def get_import(
        self, context: TenantContext, project_id: UUID, import_id: UUID
    ) -> ProjectImport:
        async def operation(transaction: TenantTransaction) -> ProjectImport:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.MAP_READ, roles)
            return await self._load_import(transaction, context, project_id, import_id)

        return await self._run(context, operation)

    async def bind_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        import_id: UUID,
        import_ref: str,
        dataset_id: UUID,
        request_id: str,
    ) -> ProjectImport:
        async def operation(transaction: TenantTransaction) -> ProjectImport:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.MAP_UPDATE, roles)
            self._require(Action.DATASET_UPLOAD, roles)
            imported = await self._load_import(
                transaction, context, project_id, import_id, lock=True
            )
            if imported.state == "completed":
                raise ProjectImportConflict("project_import_completed")
            item = next((entry for entry in imported.items if entry.import_ref == import_ref), None)
            if item is None:
                raise ProjectImportNotFound("project_import_item")
            if item.kind != "embedded_dataset":
                raise ProjectImportConflict("project_import_item_not_bindable")
            if item.state == "bound":
                if item.dataset_id != dataset_id:
                    raise ProjectImportConflict("project_import_item_already_bound")
                return imported
            dataset = await transaction.fetch_one(
                """
                SELECT dataset.source_type::text, dataset.format::text,
                       dataset.current_version_id
                FROM app.datasets dataset
                JOIN app.project_datasets project_dataset
                  ON project_dataset.organization_id = dataset.organization_id
                 AND project_dataset.dataset_id = dataset.id
                WHERE dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND dataset.id = %s
                """,
                (context.organization_id, project_id, dataset_id),
            )
            if dataset is None:
                raise ProjectImportNotFound("dataset")
            if (
                dataset[0] != item.expected_source_type
                or dataset[1] != item.expected_format
                or dataset[2] is None
            ):
                raise ProjectImportConflict("project_import_dataset_not_ready")
            await transaction.execute(
                """
                UPDATE app.project_import_items
                SET state = 'bound', dataset_id = %s, bound_at = clock_timestamp()
                WHERE organization_id = %s AND import_id = %s AND import_ref = %s
                  AND state = 'pending'
                """,
                (dataset_id, context.organization_id, import_id, import_ref),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "project.import.dataset.bound",
                import_id,
                request_id,
                {"import_ref": import_ref, "dataset_id": str(dataset_id)},
            )
            return await self._load_import(transaction, context, project_id, import_id)

        return await self._run(context, operation)

    async def finalize_import(
        self,
        context: TenantContext,
        project_id: UUID,
        import_id: UUID,
        request_id: str,
    ) -> ProjectImport:
        async def operation(transaction: TenantTransaction) -> ProjectImport:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.MAP_UPDATE, roles)
            imported = await self._load_import(
                transaction, context, project_id, import_id, lock=True
            )
            if imported.state == "completed":
                return imported
            if not imported.ready:
                raise ProjectImportConflict("project_import_incomplete")
            definition_rows = await transaction.fetch_all(
                """
                SELECT chunk.chunk_index,
                       substring(convert_to(operation.map_definition::text, 'UTF8')
                         FROM chunk.chunk_index * %s::integer + 1 FOR %s::integer),
                       octet_length(operation.map_definition::text)
                FROM app.project_import_operations operation
                CROSS JOIN LATERAL generate_series(
                  0, (octet_length(operation.map_definition::text) - 1) / %s::integer
                ) AS chunk(chunk_index)
                WHERE operation.organization_id = %s AND operation.id = %s
                ORDER BY chunk.chunk_index
                """,
                (
                    _MAP_DEFINITION_CHUNK_BYTES,
                    _MAP_DEFINITION_CHUNK_BYTES,
                    _MAP_DEFINITION_CHUNK_BYTES,
                    context.organization_id,
                    import_id,
                ),
            )
            if not definition_rows:
                raise ProjectImportNotFound("project_import")
            try:
                return_definition = PostgresWorkspaceRepository._decode_map_definition_chunks(
                    [(row[0], row[1]) for row in definition_rows], int(definition_rows[0][2])
                )
            except (WorkspaceStoreUnavailable, ValueError, TypeError, IndexError) as error:
                raise ProjectImportStoreUnavailable("invalid project import definition") from error
            reviewed_return = await self._require_geolibre_return(
                transaction,
                context,
                project_id,
                imported.map_id,
                imported.expected_map_version,
                return_definition,
                {item.import_ref for item in imported.items},
            )
            replacements = await self._replacement_records(transaction, context, imported)
            definition = rewrite_import_definition(return_definition, replacements)
            definition = upgrade_import_map_definition(definition)
            try:
                validate_map_definition(definition, require_current=True)
            except ValueError as error:
                raise ProjectImportConflict("project_import_definition_invalid") from error
            # A completed upload can still be queued for conversion. Its exact
            # current binding is checked by _replacement_records; ordinary saved
            # references keep requiring active versions. Do not exclude retained
            # Layers, external sources, Styles or basemap connections.
            embedded_refs = {
                item.import_ref for item in imported.items if item.kind == "embedded_dataset"
            }
            bound_output_ids = {
                layer["layerId"]
                for layer in return_definition["layers"]
                if layer.get("importRef") in embedded_refs
            }
            governed_definition = {
                **definition,
                "layers": [
                    layer
                    for layer in definition["layers"]
                    if layer["layerId"] not in bound_output_ids
                ],
            }
            if governed_definition.get("activeLayerId") in bound_output_ids:
                governed_definition["activeLayerId"] = None
            try:
                await PostgresWorkspaceRepository(
                    self._executor
                )._require_map_definition_references(
                    transaction, context, project_id, governed_definition
                )
            except WorkspaceConflict as error:
                raise ProjectImportConflict(
                    error.code, current_version=error.current_version
                ) from error
            encoded = json.dumps(
                definition, allow_nan=False, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            if len(encoded) > 262_144:
                raise ProjectImportConflict("project_import_definition_too_large")
            map_row = await transaction.fetch_one(
                """
                SELECT version FROM app.maps
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, imported.map_id),
            )
            if map_row is None:
                raise ProjectImportNotFound("map")
            current_version = cast(int, map_row[0])
            if current_version != imported.expected_map_version:
                raise ProjectImportConflict("map_version_conflict", current_version=current_version)
            next_version = current_version + 1
            await transaction.execute(
                """
                UPDATE app.maps
                SET definition = %s, version = %s, updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                  AND version = %s
                """,
                (
                    Jsonb(definition),
                    next_version,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    imported.map_id,
                    current_version,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.map_versions
                  (organization_id, map_id, version, definition, change_message, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    imported.map_id,
                    next_version,
                    Jsonb(definition),
                    "GeoLibre reviewed return" if reviewed_return else "GeoLibre governed import",
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.project_import_operations
                SET state = 'completed', completed_at = clock_timestamp()
                WHERE organization_id = %s AND id = %s AND state = 'open'
                """,
                (context.organization_id, import_id),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "project.import.completed",
                import_id,
                request_id,
                {
                    "map_id": str(imported.map_id),
                    "map_version": next_version,
                    "dataset_count": len(imported.items),
                },
            )
            completed = await self._load_import(transaction, context, project_id, import_id)
            return replace(completed, final_map_version=next_version)

        return await self._run(context, operation)

    async def _require_geolibre_return(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        expected_map_version: int,
        definition: dict[str, Any],
        import_refs: set[str],
    ) -> bool:
        metadata = geolibre_return_metadata(definition)
        if metadata is None:
            return False
        base = metadata["base"]
        # Scope history through its original map and access container. Returning
        # into another map never permits borrowing history from another project.
        rows = await transaction.fetch_all(
            """
            SELECT chunk.chunk_index,
                   substring(convert_to(history.definition::text, 'UTF8')
                     FROM chunk.chunk_index * %s::integer + 1 FOR %s::integer),
                   octet_length(history.definition::text)
            FROM app.map_versions history
            JOIN app.maps map ON map.organization_id = history.organization_id
              AND map.id = history.map_id AND map.project_id = %s
            CROSS JOIN LATERAL generate_series(
              0, (octet_length(history.definition::text) - 1) / %s::integer
            ) AS chunk(chunk_index)
            WHERE history.organization_id = %s AND history.map_id = %s
              AND history.version = %s
            ORDER BY chunk.chunk_index
            """,
            (
                _MAP_DEFINITION_CHUNK_BYTES,
                _MAP_DEFINITION_CHUNK_BYTES,
                project_id,
                _MAP_DEFINITION_CHUNK_BYTES,
                context.organization_id,
                UUID(base["mapId"]),
                base["mapVersion"],
            ),
        )
        if not rows:
            raise ProjectImportConflict("geolibre_return_base_unavailable")
        try:
            base_definition = PostgresWorkspaceRepository._decode_map_definition_chunks(
                [(row[0], row[1]) for row in rows], int(rows[0][2])
            )
        except (WorkspaceStoreUnavailable, ValueError, TypeError, IndexError) as error:
            raise ProjectImportStoreUnavailable("invalid GeoLibre return base history") from error
        validate_geolibre_return(
            definition, base_definition, map_id, expected_map_version, import_refs
        )
        try:
            await PostgresWorkspaceRepository(self._executor)._require_map_definition_references(
                transaction, context, project_id, upgrade_import_map_definition(base_definition)
            )
        except WorkspaceConflict as error:
            raise ProjectImportConflict(
                error.code, current_version=error.current_version
            ) from error
        return True

    async def _create_external_source(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        candidate: ExternalImportCandidate,
        request_id: str,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.datasets
              (id, organization_id, name, description, classification,
               source_type, format, status, owner_user_id, created_by, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'active', %s, %s, %s)
            """,
            (
                dataset_id,
                context.organization_id,
                candidate.name,
                candidate.description,
                candidate.classification,
                candidate.source_type,
                candidate.source_type,
                context.user_id,
                context.user_id,
                context.user_id,
            ),
        )
        await transaction.execute(
            """
            INSERT INTO app.project_datasets
              (organization_id, project_id, dataset_id, linked_by)
            VALUES (%s, %s, %s, %s)
            """,
            (context.organization_id, project_id, dataset_id, context.user_id),
        )
        await self._insert_tags(transaction, context, dataset_id, candidate.tags)
        await transaction.execute(
            """
            INSERT INTO app.external_sources
              (organization_id, dataset_id, source_type, created_by)
            VALUES (%s, %s, %s, %s)
            """,
            (context.organization_id, dataset_id, candidate.source_type, context.user_id),
        )
        await transaction.execute(
            """
            INSERT INTO app.external_source_revisions
              (organization_id, dataset_id, version_number, source_url,
               configuration, change_message, created_by)
            VALUES (%s, %s, 1, %s, %s, 'GeoLibre project import', %s)
            """,
            (
                context.organization_id,
                dataset_id,
                candidate.source_url,
                Jsonb(candidate.configuration),
                context.user_id,
            ),
        )
        await self._record_event(
            transaction,
            context,
            project_id,
            "dataset.source.created",
            dataset_id,
            request_id,
            {
                "source_type": candidate.source_type,
                "version_number": 1,
                "import_ref": candidate.import_ref,
            },
            resource_type="dataset",
        )

    async def _replacement_records(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        imported: ProjectImport,
    ) -> dict[str, dict[str, Any]]:
        replacements: dict[str, dict[str, Any]] = {}
        for item in imported.items:
            if item.dataset_id is None:
                raise ProjectImportConflict("project_import_incomplete")
            if item.kind == "external_source":
                row = await transaction.fetch_one(
                    """
                    SELECT source.source_type::text, revision.version_number,
                           revision.source_url, revision.configuration
                    FROM app.external_sources source
                    JOIN app.project_datasets project_dataset
                      ON project_dataset.organization_id = source.organization_id
                     AND project_dataset.dataset_id = source.dataset_id
                    JOIN LATERAL (
                      SELECT version_number, source_url, configuration
                      FROM app.external_source_revisions
                      WHERE organization_id = source.organization_id
                        AND dataset_id = source.dataset_id
                      ORDER BY version_number DESC LIMIT 1
                    ) revision ON true
                    WHERE source.organization_id = %s AND source.dataset_id = %s
                      AND project_dataset.project_id = %s
                    FOR KEY SHARE OF project_dataset
                    """,
                    (context.organization_id, item.dataset_id, imported.project_id),
                )
                if row is None:
                    raise ProjectImportConflict("project_import_source_missing")
                replacements[item.import_ref] = {
                    "datasetId": str(item.dataset_id),
                    "sourceType": cast(str, row[0]),
                    "sourceVersion": cast(int, row[1]),
                    "sourceUrl": cast(str, row[2]),
                    "sourceConfiguration": map_source_configuration(
                        cast(ExternalSourceType, row[0]), cast(dict[str, Any], row[3])
                    ),
                }
            else:
                row = await transaction.fetch_one(
                    """
                    SELECT version.original_object_id, version.id, version.version_number
                    FROM app.datasets dataset
                    JOIN app.project_datasets project_dataset
                      ON project_dataset.organization_id = dataset.organization_id
                     AND project_dataset.dataset_id = dataset.id
                    JOIN app.dataset_versions version
                      ON version.organization_id = dataset.organization_id
                     AND version.dataset_id = dataset.id
                     AND version.id = dataset.current_version_id
                    WHERE dataset.organization_id = %s AND dataset.id = %s
                      AND project_dataset.project_id = %s
                      AND dataset.source_type::text = %s AND dataset.format::text = %s
                      AND version.state IN ('queued', 'processing', 'active')
                    FOR KEY SHARE OF project_dataset
                    """,
                    (
                        context.organization_id,
                        item.dataset_id,
                        imported.project_id,
                        item.expected_source_type,
                        item.expected_format,
                    ),
                )
                if row is None:
                    raise ProjectImportConflict("project_import_dataset_not_ready")
                replacements[item.import_ref] = {
                    "datasetId": str(item.dataset_id),
                    "objectId": str(cast(UUID, row[0])),
                    "sourceType": "governed-dataset",
                    "datasetVersionId": str(cast(UUID, row[1])),
                    "sourceVersion": cast(int, row[2]),
                }
        return replacements

    async def _load_import(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        import_id: UUID,
        *,
        lock: bool = False,
    ) -> ProjectImport:
        row = await transaction.fetch_one(
            f"""
            SELECT id, project_id, map_id, idempotency_key, source_product,
                   source_version, source_sha256, plan_digest, expected_map_version,
                   state::text, created_by, created_at, updated_at, completed_at
            FROM app.project_import_operations
            WHERE organization_id = %s AND project_id = %s AND id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, project_id, import_id),
        )
        if row is None:
            raise ProjectImportNotFound("project_import")
        item_rows = await transaction.fetch_all(
            """
            SELECT import_ref, kind::text, expected_source_type::text,
                   expected_format::text, candidate, state::text,
                   dataset_id, bound_at
            FROM app.project_import_items
            WHERE organization_id = %s AND import_id = %s
            ORDER BY import_ref
            """,
            (context.organization_id, import_id),
        )
        items = tuple(
            ProjectImportItem(
                import_ref=cast(str, item[0]),
                kind=cast(ProjectImportItemKind, item[1]),
                expected_source_type=cast(str, item[2]),
                expected_format=cast(DatasetFormat, item[3]),
                candidate=cast(dict[str, Any], item[4]),
                state=cast(ProjectImportItemState, item[5]),
                dataset_id=cast(UUID | None, item[6]),
                bound_at=cast(datetime | None, item[7]),
            )
            for item in item_rows
        )
        state = cast(ProjectImportState, row[9])
        expected_map_version = cast(int, row[8])
        return ProjectImport(
            import_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            map_id=cast(UUID, row[2]),
            idempotency_key=cast(UUID, row[3]),
            source_product=cast(str, row[4]),
            source_version=cast(str, row[5]),
            source_sha256=cast(str, row[6]),
            plan_digest=cast(str, row[7]),
            expected_map_version=expected_map_version,
            state=state,
            items=items,
            created_by=cast(UUID, row[10]),
            created_at=cast(datetime, row[11]),
            updated_at=cast(datetime, row[12]),
            completed_at=cast(datetime | None, row[13]),
            final_map_version=expected_map_version + 1 if state == "completed" else None,
        )

    async def _project_roles(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise ProjectImportAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise ProjectImportNotFound("project")
        return Roles(
            organization=cast(Any, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise ProjectImportAccessDenied("action forbidden") from error

    @staticmethod
    async def _insert_tags(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        tags: tuple[str, ...],
    ) -> None:
        for tag_name in tags:
            tag = await transaction.fetch_one(
                """
                INSERT INTO app.tags (organization_id, name, created_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (organization_id, name) DO NOTHING
                RETURNING id
                """,
                (context.organization_id, tag_name, context.user_id),
            )
            if tag is None:
                tag = await transaction.fetch_one(
                    """
                    SELECT id FROM app.tags
                    WHERE organization_id = %s AND name = %s
                    """,
                    (context.organization_id, tag_name),
                )
            if tag is None:
                raise ProjectImportStoreUnavailable("tag registration returned no row")
            await transaction.execute(
                """
                INSERT INTO app.dataset_tags
                  (organization_id, dataset_id, tag_id, tagged_by)
                VALUES (%s, %s, %s, %s)
                """,
                (context.organization_id, dataset_id, cast(UUID, tag[0]), context.user_id),
            )

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        event_type: str,
        resource_id: UUID,
        request_id: str,
        payload: dict[str, Any],
        *,
        resource_type: str = "project_import",
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _external_candidate_record(candidate: ExternalImportCandidate) -> dict[str, Any]:
        return {
            "name": candidate.name,
            "description": candidate.description,
            "classification": candidate.classification,
            "sourceType": candidate.source_type,
            "sourceUrl": candidate.source_url,
            "configuration": candidate.configuration,
            "tags": list(candidate.tags),
        }

    @staticmethod
    def _embedded_candidate_record(candidate: EmbeddedImportCandidate) -> dict[str, Any]:
        return {
            "name": candidate.name,
            "description": candidate.description,
            "classification": candidate.classification,
            "format": candidate.format,
            "filename": candidate.filename,
            "contentType": candidate.content_type,
            "sizeBytes": candidate.size_bytes,
            "checksumSha256": candidate.checksum_sha256,
            "tags": list(candidate.tags),
        }


def geolibre_return_metadata(definition: dict[str, Any]) -> dict[str, Any] | None:
    extensions = definition.get("extensions", {})
    if not isinstance(extensions, dict) or "opengeoGeoLibreReturn" not in extensions:
        return None
    metadata = extensions["opengeoGeoLibreReturn"]
    code = "geolibre_return_metadata_invalid"
    if not isinstance(metadata, dict) or set(metadata) != {
        "schemaVersion",
        "base",
        "inputs",
        "outputs",
    }:
        raise ProjectImportConflict(code)
    if metadata["schemaVersion"] != "opengeo.geolibre-return.1.0.0":
        raise ProjectImportConflict(code)
    base = metadata["base"]
    if not isinstance(base, dict) or set(base) != {"mapId", "mapVersion", "definitionSha256"}:
        raise ProjectImportConflict(code)
    try:
        if str(UUID(base["mapId"])) != base["mapId"]:
            raise ValueError("noncanonical map ID")
    except (ValueError, TypeError, AttributeError) as error:
        raise ProjectImportConflict(code) from error
    if (
        isinstance(base["mapVersion"], bool)
        or not isinstance(base["mapVersion"], int)
        or base["mapVersion"] < 1
        or not isinstance(base["definitionSha256"], str)
        or re.fullmatch(r"[a-f0-9]{64}", base["definitionSha256"]) is None
    ):
        raise ProjectImportConflict(code)
    for key in ("inputs", "outputs"):
        if not isinstance(metadata[key], list) or len(metadata[key]) > 200:
            raise ProjectImportConflict(code)
    for entry in metadata["inputs"]:
        if (
            not isinstance(entry, dict)
            or set(entry)
            not in ({"layerId", "datasetId"}, {"layerId", "datasetId", "datasetVersionId"})
            or any(not isinstance(value, str) or not value for value in entry.values())
        ):
            raise ProjectImportConflict(code)
    for entry in metadata["outputs"]:
        if (
            not isinstance(entry, dict)
            or set(entry)
            not in (
                {"layerId", "importRef", "inputLayerIds", "retention", "reproducible"},
                {
                    "layerId",
                    "importRef",
                    "inputLayerIds",
                    "retention",
                    "reproducible",
                    "inputLinkMethod",
                },
            )
            or not isinstance(entry["layerId"], str)
            or not isinstance(entry["importRef"], str)
            or entry["retention"] != "retained-output"
            or entry["reproducible"] is not False
            or ("inputLinkMethod" in entry and entry["inputLinkMethod"] != "user-declared")
            or not isinstance(entry["inputLayerIds"], list)
            or any(not isinstance(value, str) for value in entry["inputLayerIds"])
            or len(set(entry["inputLayerIds"])) != len(entry["inputLayerIds"])
        ):
            raise ProjectImportConflict(code)
    return cast(dict[str, Any], metadata)


def validate_geolibre_return(
    definition: dict[str, Any],
    base_definition: dict[str, Any],
    target_map_id: UUID,
    expected_map_version: int,
    import_refs: set[str],
) -> None:
    """Validate declarations against authorized immutable history, never the return file."""
    metadata = geolibre_return_metadata(definition)
    if metadata is None:
        raise ProjectImportConflict("geolibre_return_metadata_invalid")
    base = metadata["base"]
    if (
        sha256(_legacy_geolibre_json(base_definition).encode()).hexdigest()
        != base["definitionSha256"]
    ):
        raise ProjectImportConflict("geolibre_return_base_mismatch")
    if UUID(base["mapId"]) == target_map_id and base["mapVersion"] != expected_map_version:
        raise ProjectImportConflict("geolibre_return_base_version_conflict")
    base_layers = {layer["layerId"]: layer for layer in base_definition.get("layers", [])}
    expected_inputs = {
        layer_id: {
            "layerId": layer_id,
            "datasetId": layer["datasetId"],
            **(
                {"datasetVersionId": layer["datasetVersionId"]}
                if layer.get("datasetVersionId") is not None
                else {}
            ),
        }
        for layer_id, layer in base_layers.items()
    }
    inputs = {entry["layerId"]: entry for entry in metadata["inputs"]}
    if len(inputs) != len(metadata["inputs"]) or inputs != expected_inputs:
        raise ProjectImportConflict("geolibre_return_inputs_invalid")
    outputs = {entry["layerId"]: entry for entry in metadata["outputs"]}
    if (
        len(outputs) != len(metadata["outputs"])
        or {entry["importRef"] for entry in outputs.values()} != import_refs
    ):
        raise ProjectImportConflict("geolibre_return_outputs_invalid")
    if len(outputs) != len(import_refs):
        raise ProjectImportConflict("geolibre_return_outputs_invalid")
    imported_layers = {
        layer["layerId"]: layer for layer in definition.get("layers", []) if "importRef" in layer
    }
    if set(imported_layers) != set(outputs):
        raise ProjectImportConflict("geolibre_return_outputs_invalid")
    for layer_id, output in outputs.items():
        if (
            layer_id in base_layers
            or imported_layers[layer_id]["importRef"] != output["importRef"]
            or not set(output["inputLayerIds"]).issubset(base_layers)
        ):
            raise ProjectImportConflict("geolibre_return_outputs_invalid")
    # Only presentation can change on a retained Layer. Comparing the remainder
    # preserves unknown future identity fields and source generation/configuration.
    presentation = {"title", "visible", "opacity", "opacityMode", "order", "style", "labels"}
    for layer in definition.get("layers", []):
        if "importRef" in layer:
            continue
        original = base_layers.get(layer["layerId"])
        if original is not None and "styleReference" not in layer:
            # A local style edit can deliberately detach the governed binding;
            # it cannot substitute a different Style identity in a return file.
            original = {key: value for key, value in original.items() if key != "styleReference"}
        if original is None or _legacy_geolibre_json(
            {key: value for key, value in layer.items() if key not in presentation}
        ) != _legacy_geolibre_json(
            {key: value for key, value in original.items() if key not in presentation}
        ):
            raise ProjectImportConflict("geolibre_return_layer_identity_invalid")


def _legacy_geolibre_json(value: Any) -> str:
    """Serialize the legacy sorted-object/JSON.stringify GeoLibre hash format.

    JSON.stringify uses ECMAScript decimal/exponent thresholds and enumerates
    integer-index keys first, even after the legacy code-point key sort.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("GeoLibre return base must contain finite numbers")
        if number == 0:
            return "0"
        decimal = Decimal(repr(number))
        if 1e-6 <= abs(number) < 1e21:
            rendered = format(decimal, "f")
            return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered
        coefficient, exponent = format(decimal.normalize(), "e").split("e")
        exponent_number = int(exponent)
        return f"{coefficient}e{'+' if exponent_number >= 0 else '-'}{abs(exponent_number)}"
    if isinstance(value, list):
        return "[" + ",".join(_legacy_geolibre_json(item) for item in value) + "]"
    if isinstance(value, dict):
        indexes = sorted(
            (
                key
                for key in value
                if key.isascii()
                and key.isdecimal()
                and str(int(key)) == key
                and int(key) < 4_294_967_295
            ),
            key=int,
        )
        keys = [*indexes, *(key for key in sorted(value) if key not in indexes)]
        return (
            "{"
            + ",".join(
                f"{_legacy_geolibre_json(key)}:{_legacy_geolibre_json(value[key])}" for key in keys
            )
            + "}"
        )
    raise ValueError("GeoLibre return base must be JSON")


def upgrade_import_map_definition(definition: dict[str, Any]) -> dict[str, Any]:
    upgraded = dict(definition)
    if upgraded.get("schemaVersion") in {
        None,
        LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
        PROCESSING_MAP_DEFINITION_SCHEMA_VERSION,
        PATH_MAP_DEFINITION_SCHEMA_VERSION,
    }:
        upgraded["schemaVersion"] = MAP_DEFINITION_SCHEMA_VERSION
        upgraded.setdefault("activeProcessingModelId", None)
        upgraded.setdefault("models", [])
        upgraded.setdefault("processingHistory", [])
        upgraded.setdefault("measurements", [])
    return upgraded


def rewrite_import_definition(
    definition: dict[str, Any], replacements: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    rewritten = json.loads(json.dumps(definition, allow_nan=False))
    layers = rewritten.get("layers")
    if not isinstance(layers, list):
        raise ProjectImportConflict("project_import_layers_invalid")
    used: set[str] = set()
    for layer in layers:
        if not isinstance(layer, dict):
            raise ProjectImportConflict("project_import_layer_invalid")
        import_ref = layer.get("importRef")
        if not isinstance(import_ref, str):
            continue
        replacement = replacements.get(import_ref)
        if replacement is None or import_ref in used:
            raise ProjectImportConflict("project_import_reference_invalid")
        used.add(import_ref)
        layer.update(replacement)
        layer.pop("importRef", None)
        if replacement.get("sourceType") in {
            "xyz",
            "wms",
            "pmtiles",
            "geojson",
            "arcgis",
            "wfs",
        }:
            source_type = cast(str, replacement["sourceType"])
            configuration = cast(dict[str, Any], replacement["sourceConfiguration"])
            if source_type == "pmtiles":
                layer["sourceType"] = f"pmtiles-{configuration['tileType']}"
            elif source_type == "geojson":
                layer["sourceType"] = "geojson-archive"
            elif source_type in {"arcgis", "wfs"}:
                layer["sourceType"] = "external-feature-reference"
            else:
                layer["sourceType"] = f"{source_type}-raster"
    if used != set(replacements):
        raise ProjectImportConflict("project_import_reference_invalid")
    basemaps = rewritten.get("basemaps", [])
    if (
        geolibre_return_metadata(rewritten) is None
        and isinstance(basemaps, list)
        and any(
            isinstance(basemap, dict)
            and basemap.get("kind") in {"provider-style", "provider-raster"}
            for basemap in basemaps
        )
    ):
        raise ProjectImportConflict("project_import_basemap_connection_required")
    serialized = json.dumps(rewritten, allow_nan=False)
    if '"datasetId": "import:' in serialized or '"objectId": "pending-import:' in serialized:
        raise ProjectImportConflict("project_import_placeholder_remaining")
    return_metadata = geolibre_return_metadata(rewritten)
    if return_metadata is not None:
        # Durable output identity comes only from the governed registration and
        # upload binding, never a client-provided provenance assertion.
        for output in return_metadata["outputs"]:
            replacement = replacements[output["importRef"]]
            output["datasetId"] = replacement["datasetId"]
            if "datasetVersionId" in replacement:
                output["datasetVersionId"] = replacement["datasetVersionId"]
    return cast(dict[str, Any], rewritten)


def map_source_configuration(
    source_type: ExternalSourceType, configuration: dict[str, Any]
) -> dict[str, Any]:
    if source_type == "xyz":
        return {
            "minZoom": configuration["min_zoom"],
            "maxZoom": configuration["max_zoom"],
            "tileSize": configuration["tile_size"],
            "scheme": configuration["scheme"],
            "attribution": configuration["attribution"],
        }
    if source_type == "wms":
        return {
            "version": configuration["version"],
            "layers": configuration["layers"],
            "styles": configuration["styles"],
            "imageFormat": configuration["format"],
            "transparent": configuration["transparent"],
            "crs": configuration["crs"],
            "tileSize": configuration["tile_size"],
            "attribution": configuration["attribution"],
        }
    if source_type == "geojson":
        return {
            "contentEncoding": configuration["content_encoding"],
            "objectSha256": configuration["object_sha256"],
            "decodedSha256": configuration["decoded_sha256"],
            "sizeBytes": configuration["size_bytes"],
            "decodedSizeBytes": configuration["decoded_size_bytes"],
            "featureCount": configuration["feature_count"],
            "geometryType": configuration["geometry_type"],
            "bounds": configuration["bounds"],
            "attribution": configuration["attribution"],
            "license": configuration["license"],
            "authoritativeUrl": configuration["authoritative_url"],
            "rightsUrl": configuration["rights_url"],
        }
    if source_type == "arcgis":
        return {
            "objectIdField": configuration["object_id_field"],
            "fields": configuration["fields"],
            "geometryType": configuration["geometry_type"],
            "pageSize": configuration["page_size"],
            "attribution": configuration["attribution"],
        }
    if source_type == "wfs":
        return {
            "version": configuration["version"],
            "typeName": configuration["type_name"],
            "geometryName": configuration["geometry_name"],
            "fields": configuration["fields"],
            "sortBy": configuration["sort_by"],
            "geometryType": configuration["geometry_type"],
            "pageSize": configuration["page_size"],
            "attribution": configuration["attribution"],
        }
    return {
        "tileType": configuration["tile_type"],
        "sourceLayer": configuration["source_layer"],
        "geometryType": configuration["geometry_type"],
        "minZoom": configuration["min_zoom"],
        "maxZoom": configuration["max_zoom"],
        "attribution": configuration["attribution"],
    }
