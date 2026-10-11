import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    ProjectRole,
    Roles,
    authorize,
)
from opengeo_api.document_previews import (
    DOCUMENT_PREVIEW_SCHEMA,
    MAX_DOCUMENT_PREVIEW_BYTES,
    PDF_DOCUMENT_PREVIEW_SCHEMA,
    PDF_OCR_DOCUMENT_PREVIEW_SCHEMA,
    DocumentPreviewInvalid,
    parse_document_preview,
)
from opengeo_api.s3_downloads import (
    DownloadSpec,
    DownloadStorage,
    DownloadTicket,
    ExactObjectSpec,
)
from opengeo_api.spatial_previews import (
    MAX_SPATIAL_PREVIEW_BYTES,
    SPATIAL_PREVIEW_SCHEMA,
    SpatialPreviewInvalid,
    parse_spatial_preview,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

DatasetVersionState = Literal["queued", "processing", "active", "failed"]
DataObjectRole = Literal["original", "working", "published", "tile", "derived", "thumbnail"]
DatasetLineageOriginKind = Literal[
    "managed_upload", "external_source_archive", "repository_object_copy"
]
DATASET_VERSION_LINEAGE_SCHEMA: Literal["opengeo.dataset-version-lineage.1.0.0"] = (
    "opengeo.dataset-version-lineage.1.0.0"
)


class CatalogStoreUnavailable(RuntimeError):
    pass


class CatalogAccessDenied(RuntimeError):
    pass


class CatalogNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class CatalogConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class DatasetObject:
    object_id: UUID
    role: DataObjectRole
    filename: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class DatasetVersion:
    version_id: UUID
    version_number: int
    parent_version_id: UUID | None
    state: DatasetVersionState
    change_message: str | None
    feature_count: int | None
    extent: list[float] | None
    crs: str | None
    geometry_type: str | None
    schema_definition: dict[str, Any]
    quality_results: dict[str, Any]
    created_by: UUID
    created_at: datetime
    current: bool
    objects: tuple[DatasetObject, ...]


@dataclass(frozen=True, slots=True)
class DatasetLineageOrigin:
    kind: DatasetLineageOriginKind
    operation_id: UUID
    source_dataset_id: UUID | None
    source_dataset_name: str | None
    source_revision_number: int | None
    input_object_id: UUID
    acquired_at: datetime


@dataclass(frozen=True, slots=True)
class DatasetDerivativeLineage:
    kind: Literal["pmtiles"]
    operation_id: UUID
    recipe: Literal["gdal-pmtiles-v1"]
    source_object_id: UUID
    output_object_id: UUID
    bounds: tuple[float, float, float, float]
    minimum_zoom: int
    maximum_zoom: int
    source_layer: str
    request_checksum_sha256: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class DatasetVersionLineage:
    dataset_id: UUID
    version_id: UUID
    version_number: int
    origins: tuple[DatasetLineageOrigin, ...]
    derivatives: tuple[DatasetDerivativeLineage, ...]
    derivatives_truncated: bool


@dataclass(frozen=True, slots=True)
class DatasetPermission:
    user_id: UUID
    email: str
    display_name: str
    role: DatasetPermissionRole
    granted_by: UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class PermissionGrant:
    user_id: UUID
    role: DatasetPermissionRole


@dataclass(frozen=True, slots=True)
class DownloadTarget:
    dataset_id: UUID
    version_id: UUID
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    filename: str


@dataclass(frozen=True, slots=True)
class DocumentPreviewTarget:
    dataset_id: UUID
    version_id: UUID
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class SpatialPreviewTarget:
    dataset_id: UUID
    version_id: UUID
    object_id: UUID
    bucket: str
    key: str
    s3_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    feature_count: int | None


class CatalogRepository(Protocol):
    async def list_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        limit: int,
        offset: int,
    ) -> list[DatasetVersion]: ...

    async def get_version_lineage(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> DatasetVersionLineage: ...

    async def list_permissions(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> list[DatasetPermission]: ...

    async def put_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        grant: PermissionGrant,
        request_id: str,
    ) -> DatasetPermission: ...

    async def delete_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None: ...

    async def request_download(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
        object_id: UUID,
        request_id: str,
    ) -> DownloadTicket: ...

    async def get_document_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> dict[str, Any]: ...

    async def get_spatial_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> dict[str, Any]: ...


ResultT = TypeVar("ResultT")


class PostgresCatalogRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        storage: DownloadStorage,
    ) -> None:
        self._executor = executor
        self._storage = storage

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise CatalogConflict("catalog_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise CatalogStoreUnavailable("catalog operation failed") from error

    async def list_versions(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        limit: int,
        offset: int,
    ) -> list[DatasetVersion]:
        async def operation(transaction: TenantTransaction) -> list[DatasetVersion]:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_VERSION_READ, roles)
            rows = await transaction.fetch_all(
                """
                WITH selected_versions AS (
                  SELECT version.*,
                         version.id = dataset.current_version_id AS current
                  FROM app.dataset_versions version
                  JOIN app.datasets dataset
                    ON dataset.organization_id = version.organization_id
                   AND dataset.id = version.dataset_id
                  WHERE version.organization_id = %s
                    AND version.dataset_id = %s
                  ORDER BY version.version_number DESC
                  LIMIT %s OFFSET %s
                )
                SELECT version.id, version.version_number, version.parent_version_id,
                       version.state::text, version.change_message,
                       version.feature_count, version.extent, version.crs,
                       version.geometry_type, version.schema_definition,
                       version.quality_results, version.created_by,
                       version.created_at, version.current,
                       object.id, object.role::text,
                       COALESCE(intent.original_filename,
                                regexp_replace(object.object_key, '^.*/', '')),
                       object.content_type, object.size_bytes,
                       object.checksum_sha256, object.created_at
                FROM selected_versions version
                LEFT JOIN app.dataset_version_objects link
                  ON link.organization_id = version.organization_id
                 AND link.dataset_version_id = version.id
                LEFT JOIN app.data_objects object
                  ON object.organization_id = link.organization_id
                 AND object.id = link.data_object_id
                LEFT JOIN app.upload_intents intent
                  ON intent.organization_id = object.organization_id
                 AND intent.completed_object_id = object.id
                ORDER BY version.version_number DESC, object.role, object.id
                """,
                (context.organization_id, dataset_id, limit, offset),
            )
            return self._versions(rows)

        return await self._run(context, operation)

    async def get_version_lineage(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> DatasetVersionLineage:
        async def operation(transaction: TenantTransaction) -> DatasetVersionLineage:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_VERSION_READ, roles)
            version = await transaction.fetch_one(
                """
                SELECT version.version_number
                FROM app.dataset_versions version
                WHERE version.organization_id = %s
                  AND version.dataset_id = %s
                  AND version.id = %s
                """,
                (context.organization_id, dataset_id, version_id),
            )
            if version is None:
                raise CatalogNotFound("dataset_version")
            origin_rows = await transaction.fetch_all(
                """
                WITH specific_origins AS (
                  SELECT 'external_source_archive'::text AS kind,
                         lineage.snapshot_job_id AS operation_id,
                         lineage.source_dataset_id,
                         source.name AS source_dataset_name,
                         lineage.source_revision_number,
                         job.output_object_id AS input_object_id,
                         lineage.retrieved_at AS acquired_at
                  FROM app.dataset_version_external_source_lineage lineage
                  JOIN app.datasets source
                    ON source.organization_id = lineage.organization_id
                   AND source.id = lineage.source_dataset_id
                  JOIN app.external_source_snapshot_jobs job
                    ON job.organization_id = lineage.organization_id
                   AND job.id = lineage.snapshot_job_id
                  WHERE lineage.organization_id = %s
                    AND lineage.destination_dataset_id = %s
                    AND lineage.destination_dataset_version_id = %s
                  UNION ALL
                  SELECT 'repository_object_copy'::text,
                         lineage.copy_job_id,
                         lineage.source_dataset_id,
                         source.name,
                         NULL::bigint,
                         job.output_object_id,
                         lineage.retrieved_at
                  FROM app.dataset_version_repository_object_lineage lineage
                  JOIN app.datasets source
                    ON source.organization_id = lineage.organization_id
                   AND source.id = lineage.source_dataset_id
                  JOIN app.repository_object_copy_jobs job
                    ON job.organization_id = lineage.organization_id
                   AND job.id = lineage.copy_job_id
                  WHERE lineage.organization_id = %s
                    AND lineage.destination_dataset_id = %s
                    AND lineage.destination_dataset_version_id = %s
                )
                SELECT kind, operation_id, source_dataset_id, source_dataset_name,
                       source_revision_number, input_object_id, acquired_at
                FROM specific_origins
                UNION ALL
                SELECT 'managed_upload'::text, intent.id, NULL::uuid, NULL::text,
                       NULL::bigint, intent.completed_object_id, intent.completed_at
                FROM app.upload_intents intent
                JOIN app.dataset_version_objects link
                  ON link.organization_id = intent.organization_id
                 AND link.dataset_id = intent.dataset_id
                 AND link.data_object_id = intent.completed_object_id
                WHERE intent.organization_id = %s
                  AND intent.dataset_id = %s
                  AND link.dataset_version_id = %s
                  AND intent.state = 'completed'
                  AND NOT EXISTS (SELECT 1 FROM specific_origins)
                ORDER BY acquired_at, operation_id
                """,
                (
                    context.organization_id,
                    dataset_id,
                    version_id,
                    context.organization_id,
                    dataset_id,
                    version_id,
                    context.organization_id,
                    dataset_id,
                    version_id,
                ),
            )
            derivative_rows = await transaction.fetch_all(
                """
                SELECT lineage.pmtiles_job_id, lineage.recipe,
                       lineage.source_object_id, lineage.output_object_id,
                       job.bounds, job.minimum_zoom, job.maximum_zoom,
                       job.source_layer, job.request_checksum_sha256,
                       lineage.created_at
                FROM app.dataset_version_derivative_lineage lineage
                JOIN app.pmtiles_derivative_jobs job
                  ON job.organization_id = lineage.organization_id
                 AND job.id = lineage.pmtiles_job_id
                WHERE lineage.organization_id = %s
                  AND lineage.dataset_id = %s
                  AND lineage.dataset_version_id = %s
                ORDER BY lineage.created_at, lineage.output_object_id
                LIMIT 101
                """,
                (context.organization_id, dataset_id, version_id),
            )
            return DatasetVersionLineage(
                dataset_id=dataset_id,
                version_id=version_id,
                version_number=cast(int, version[0]),
                origins=tuple(self._lineage_origin(row) for row in origin_rows),
                derivatives=tuple(self._derivative_lineage(row) for row in derivative_rows[:100]),
                derivatives_truncated=len(derivative_rows) > 100,
            )

        return await self._run(context, operation)

    async def list_permissions(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> list[DatasetPermission]:
        async def operation(transaction: TenantTransaction) -> list[DatasetPermission]:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_PERMISSIONS_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT permission.user_id, identity.email, identity.display_name,
                       permission.role::text, permission.granted_by,
                       permission.created_at, permission.updated_at
                FROM app.dataset_permissions permission
                JOIN app.users identity ON identity.id = permission.user_id
                WHERE permission.organization_id = %s
                  AND permission.dataset_id = %s
                ORDER BY lower(identity.display_name), identity.id
                """,
                (context.organization_id, dataset_id),
            )
            return [self._permission(row) for row in rows]

        return await self._run(context, operation)

    async def put_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        grant: PermissionGrant,
        request_id: str,
    ) -> DatasetPermission:
        async def operation(transaction: TenantTransaction) -> DatasetPermission:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_PERMISSIONS_MANAGE, roles)
            target = await transaction.fetch_one(
                """
                SELECT identity.id, identity.email, identity.display_name
                FROM app.organization_memberships membership
                JOIN app.users identity ON identity.id = membership.user_id
                WHERE membership.organization_id = %s AND membership.user_id = %s
                """,
                (context.organization_id, grant.user_id),
            )
            if target is None:
                raise CatalogNotFound("organization_member")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.dataset_permissions
                  (organization_id, dataset_id, user_id, role, granted_by)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (organization_id, dataset_id, user_id)
                DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by
                RETURNING role::text, granted_by, created_at, updated_at
                """,
                (
                    context.organization_id,
                    dataset_id,
                    grant.user_id,
                    grant.role,
                    context.user_id,
                ),
            )
            if row is None:
                raise CatalogStoreUnavailable("permission upsert returned no row")
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.permission.granted",
                request_id,
                {"user_id": str(grant.user_id), "role": grant.role},
            )
            return DatasetPermission(
                user_id=cast(UUID, target[0]),
                email=cast(str, target[1]),
                display_name=cast(str, target[2]),
                role=cast(DatasetPermissionRole, row[0]),
                granted_by=cast(UUID, row[1]),
                created_at=cast(datetime, row[2]),
                updated_at=cast(datetime, row[3]),
            )

        return await self._run(context, operation)

    async def delete_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_PERMISSIONS_MANAGE, roles)
            deleted = await transaction.execute(
                """
                DELETE FROM app.dataset_permissions
                WHERE organization_id = %s AND dataset_id = %s AND user_id = %s
                """,
                (context.organization_id, dataset_id, user_id),
            )
            if deleted != 1:
                raise CatalogNotFound("dataset_permission")
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.permission.revoked",
                request_id,
                {"user_id": str(user_id)},
            )

        await self._run(context, operation)

    async def request_download(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
        object_id: UUID,
        request_id: str,
    ) -> DownloadTicket:
        async def prepare(transaction: TenantTransaction) -> DownloadTarget:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_DOWNLOAD, roles)
            return await self._download_target(
                transaction, context, dataset_id, version_id, object_id
            )

        target = await self._run(context, prepare)
        ticket = await self._storage.create_download_url(
            DownloadSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.s3_version_id,
                filename=target.filename,
            )
        )

        async def attribute(transaction: TenantTransaction) -> None:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_DOWNLOAD, roles)
            checked = await self._download_target(
                transaction, context, dataset_id, version_id, object_id
            )
            if checked != target:
                raise CatalogConflict("download_target_changed")
            await self._event(
                transaction,
                context,
                project_id,
                dataset_id,
                "dataset.download.issued",
                request_id,
                {"dataset_version_id": str(version_id), "data_object_id": str(object_id)},
            )

        await self._run(context, attribute)
        return ticket

    async def get_document_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> dict[str, Any]:
        async def resolve(transaction: TenantTransaction) -> DocumentPreviewTarget:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_VERSION_READ, roles)
            return await self._document_preview_target(transaction, context, dataset_id, version_id)

        target = await self._run(context, resolve)
        exact = await self._storage.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.s3_version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=MAX_DOCUMENT_PREVIEW_BYTES,
            )
        )
        checked = await self._run(context, resolve)
        if checked != target:
            raise CatalogConflict("document_preview_target_changed")
        return self._parse_document_preview(exact.body)

    async def get_spatial_preview(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        version_id: UUID,
    ) -> dict[str, Any]:
        async def resolve(transaction: TenantTransaction) -> SpatialPreviewTarget:
            roles = await self._access(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_VERSION_READ, roles)
            return await self._spatial_preview_target(transaction, context, dataset_id, version_id)

        target = await self._run(context, resolve)
        exact = await self._storage.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.s3_version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=MAX_SPATIAL_PREVIEW_BYTES,
            )
        )
        checked = await self._run(context, resolve)
        if checked != target:
            raise CatalogConflict("spatial_preview_target_changed")
        geojson = self._parse_spatial_preview(exact.body)
        number_returned = len(cast(list[object], geojson["features"]))
        if target.feature_count is not None and number_returned > target.feature_count:
            raise CatalogConflict("spatial_preview_invalid")
        return {
            "schema_version": SPATIAL_PREVIEW_SCHEMA,
            "dataset_version_id": str(version_id),
            "number_returned": number_returned,
            "number_matched": target.feature_count,
            "may_be_truncated": (
                target.feature_count is None or number_returned < target.feature_count
            ),
            "geojson": geojson,
        }

    @staticmethod
    async def _access(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> Roles:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text,
                   permission.role::text, dataset.owner_user_id = %s
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = project.organization_id
             AND project_dataset.project_id = project.id
             AND project_dataset.dataset_id = %s
            JOIN app.datasets dataset
              ON dataset.organization_id = project_dataset.organization_id
             AND dataset.id = project_dataset.dataset_id
            LEFT JOIN app.dataset_permissions permission
              ON permission.organization_id = dataset.organization_id
             AND permission.dataset_id = dataset.id
             AND permission.user_id = organization.user_id
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            """,
            (
                context.user_id,
                project_id,
                dataset_id,
                context.organization_id,
                context.user_id,
            ),
        )
        if row is None:
            raise CatalogNotFound("dataset")
        return Roles(
            organization=cast(OrganizationRole, row[0]),
            project=cast(ProjectRole | None, row[1]),
            dataset=cast(DatasetPermissionRole | None, row[2]),
            dataset_owner=cast(bool, row[3]),
        )

    @staticmethod
    async def _download_target(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        version_id: UUID,
        object_id: UUID,
    ) -> DownloadTarget:
        row = await transaction.fetch_one(
            """
            SELECT object.bucket, object.object_key, object.s3_version_id,
                   COALESCE(intent.original_filename,
                            regexp_replace(object.object_key, '^.*/', ''))
            FROM app.dataset_version_objects link
            JOIN app.data_objects object
              ON object.organization_id = link.organization_id
             AND object.id = link.data_object_id
            LEFT JOIN app.upload_intents intent
              ON intent.organization_id = object.organization_id
             AND intent.completed_object_id = object.id
            WHERE link.organization_id = %s
              AND link.dataset_id = %s
              AND link.dataset_version_id = %s
              AND link.data_object_id = %s
            """,
            (context.organization_id, dataset_id, version_id, object_id),
        )
        if row is None:
            raise CatalogNotFound("data_object")
        return DownloadTarget(
            dataset_id=dataset_id,
            version_id=version_id,
            object_id=object_id,
            bucket=cast(str, row[0]),
            key=cast(str, row[1]),
            s3_version_id=cast(str, row[2]),
            filename=PostgresCatalogRepository._safe_filename(cast(str, row[3])),
        )

    @staticmethod
    async def _document_preview_target(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        version_id: UUID,
    ) -> DocumentPreviewTarget:
        rows = await transaction.fetch_all(
            """
            SELECT object.id, object.bucket, object.object_key,
                   object.s3_version_id, object.content_type,
                   object.size_bytes, object.checksum_sha256
            FROM app.datasets dataset
            JOIN app.dataset_versions version
              ON version.organization_id = dataset.organization_id
             AND version.dataset_id = dataset.id
             AND version.id = %s
            JOIN app.dataset_version_objects link
              ON link.organization_id = version.organization_id
             AND link.dataset_id = version.dataset_id
             AND link.dataset_version_id = version.id
            JOIN app.data_objects object
              ON object.organization_id = link.organization_id
             AND object.id = link.data_object_id
            WHERE dataset.organization_id = %s
              AND dataset.id = %s
              AND dataset.format::text IN ('odt', 'pdf')
              AND version.state = 'active'
              AND version.geometry_type = 'document'
              AND (
                (
                  dataset.format::text = 'odt'
                  AND version.schema_definition #>> '{document,kind}' = 'odf_text'
                  AND version.schema_definition #>> '{document,source_format}' = 'odt'
                  AND version.schema_definition #>> '{document,accessible_preview_schema}' = %s
                ) OR (
                  dataset.format::text = 'pdf'
                  AND version.schema_definition #>> '{document,kind}' = 'pdf'
                  AND version.schema_definition #>> '{document,source_format}' = 'pdf'
                  AND version.schema_definition #>> '{document,reading_order}' = 'heuristic'
                  AND (
                    (
                      version.schema_definition #>> '{document,text_extraction}' =
                        'poppler_pdftotext'
                      AND version.schema_definition #>> '{document,ocr_performed}' = 'false'
                      AND version.schema_definition #>> '{document,accessible_preview_schema}' = %s
                    ) OR (
                      version.schema_definition #>> '{document,text_extraction}' =
                        'poppler_pdftotext_tesseract'
                      AND version.schema_definition #>> '{document,ocr_performed}' = 'true'
                      AND version.schema_definition #>> '{document,accessible_preview_schema}' = %s
                    )
                  )
                )
              )
              AND object.role = 'derived'
              AND object.content_type = 'application/json'
              AND object.object_key LIKE '%%/document/accessible-preview.json'
            """,
            (
                version_id,
                context.organization_id,
                dataset_id,
                DOCUMENT_PREVIEW_SCHEMA,
                PDF_DOCUMENT_PREVIEW_SCHEMA,
                PDF_OCR_DOCUMENT_PREVIEW_SCHEMA,
            ),
        )
        if len(rows) != 1:
            raise CatalogNotFound("document_preview")
        row = rows[0]
        return DocumentPreviewTarget(
            dataset_id=dataset_id,
            version_id=version_id,
            object_id=cast(UUID, row[0]),
            bucket=cast(str, row[1]),
            key=cast(str, row[2]),
            s3_version_id=cast(str, row[3]),
            content_type=cast(str, row[4]),
            size_bytes=cast(int, row[5]),
            checksum_sha256=cast(str, row[6]),
        )

    @staticmethod
    async def _spatial_preview_target(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        version_id: UUID,
    ) -> SpatialPreviewTarget:
        rows = await transaction.fetch_all(
            """
            SELECT object.id, object.bucket, object.object_key,
                   object.s3_version_id, object.content_type,
                   object.size_bytes, object.checksum_sha256,
                   version.feature_count
            FROM app.datasets dataset
            JOIN app.dataset_versions version
              ON version.organization_id = dataset.organization_id
             AND version.dataset_id = dataset.id
             AND version.id = %s
            JOIN app.dataset_version_objects link
              ON link.organization_id = version.organization_id
             AND link.dataset_id = version.dataset_id
             AND link.dataset_version_id = version.id
            JOIN app.data_objects object
              ON object.organization_id = link.organization_id
             AND object.id = link.data_object_id
            WHERE dataset.organization_id = %s
              AND dataset.id = %s
              AND dataset.format::text IN
                ('geojson', 'csv', 'shapefile', 'geopackage', 'geoparquet')
              AND version.state = 'active'
              AND version.geometry_type IS NOT NULL
              AND version.geometry_type NOT IN ('document', 'image', 'raster')
              AND object.role = 'derived'
              AND object.content_type = 'application/geo+json'
              AND object.object_key LIKE '%%/preview/preview.geojson'
              AND object.size_bytes BETWEEN 1 AND %s
            """,
            (version_id, context.organization_id, dataset_id, MAX_SPATIAL_PREVIEW_BYTES),
        )
        if len(rows) != 1:
            raise CatalogNotFound("spatial_preview")
        row = rows[0]
        return SpatialPreviewTarget(
            dataset_id=dataset_id,
            version_id=version_id,
            object_id=cast(UUID, row[0]),
            bucket=cast(str, row[1]),
            key=cast(str, row[2]),
            s3_version_id=cast(str, row[3]),
            content_type=cast(str, row[4]),
            size_bytes=cast(int, row[5]),
            checksum_sha256=cast(str, row[6]),
            feature_count=cast(int | None, row[7]),
        )

    @classmethod
    def _parse_document_preview(cls, content: bytes) -> dict[str, Any]:
        try:
            return parse_document_preview(content)
        except DocumentPreviewInvalid as error:
            raise CatalogConflict("document_preview_invalid") from error

    @classmethod
    def _parse_spatial_preview(cls, content: bytes) -> dict[str, Any]:
        try:
            return parse_spatial_preview(content)
        except SpatialPreviewInvalid as error:
            raise CatalogConflict("spatial_preview_invalid") from error

    @staticmethod
    def _safe_filename(value: str) -> str:
        basename = PurePosixPath(value.replace("\\", "/")).name
        safe = re.sub(r"[^A-Za-z0-9._ -]", "_", basename).strip(" .")[:180]
        return safe or "dataset-download"

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise CatalogAccessDenied("action forbidden") from error

    @staticmethod
    def _versions(rows: list[tuple[Any, ...]]) -> list[DatasetVersion]:
        versions: list[DatasetVersion] = []
        for row in rows:
            if not versions or versions[-1].version_id != row[0]:
                extent = None if row[6] is None else [float(value) for value in row[6]]
                versions.append(
                    DatasetVersion(
                        version_id=cast(UUID, row[0]),
                        version_number=cast(int, row[1]),
                        parent_version_id=cast(UUID | None, row[2]),
                        state=cast(DatasetVersionState, row[3]),
                        change_message=cast(str | None, row[4]),
                        feature_count=cast(int | None, row[5]),
                        extent=extent,
                        crs=cast(str | None, row[7]),
                        geometry_type=cast(str | None, row[8]),
                        schema_definition=cast(dict[str, Any], row[9]),
                        quality_results=cast(dict[str, Any], row[10]),
                        created_by=cast(UUID, row[11]),
                        created_at=cast(datetime, row[12]),
                        current=cast(bool, row[13]),
                        objects=(),
                    )
                )
            if row[14] is not None:
                version = versions[-1]
                object_record = DatasetObject(
                    object_id=cast(UUID, row[14]),
                    role=cast(DataObjectRole, row[15]),
                    filename=PostgresCatalogRepository._safe_filename(cast(str, row[16])),
                    content_type=cast(str, row[17]),
                    size_bytes=cast(int, row[18]),
                    checksum_sha256=cast(str, row[19]),
                    created_at=cast(datetime, row[20]),
                )
                versions[-1] = replace(version, objects=(*version.objects, object_record))
        return versions

    @staticmethod
    def _lineage_origin(row: tuple[Any, ...]) -> DatasetLineageOrigin:
        return DatasetLineageOrigin(
            kind=cast(DatasetLineageOriginKind, row[0]),
            operation_id=cast(UUID, row[1]),
            source_dataset_id=cast(UUID | None, row[2]),
            source_dataset_name=cast(str | None, row[3]),
            source_revision_number=cast(int | None, row[4]),
            input_object_id=cast(UUID, row[5]),
            acquired_at=cast(datetime, row[6]),
        )

    @staticmethod
    def _derivative_lineage(row: tuple[Any, ...]) -> DatasetDerivativeLineage:
        raw_bounds = cast(list[int | float], row[4])
        if len(raw_bounds) != 4:
            raise CatalogConflict("dataset_lineage_invalid")
        bounds = tuple(float(value) for value in raw_bounds)
        return DatasetDerivativeLineage(
            kind="pmtiles",
            operation_id=cast(UUID, row[0]),
            recipe=cast(Literal["gdal-pmtiles-v1"], row[1]),
            source_object_id=cast(UUID, row[2]),
            output_object_id=cast(UUID, row[3]),
            bounds=cast(tuple[float, float, float, float], bounds),
            minimum_zoom=cast(int, row[5]),
            maximum_zoom=cast(int, row[6]),
            source_layer=cast(str, row[7]),
            request_checksum_sha256=cast(str, row[8]),
            created_at=cast(datetime, row[9]),
        )

    @staticmethod
    def _permission(row: tuple[Any, ...]) -> DatasetPermission:
        return DatasetPermission(
            user_id=cast(UUID, row[0]),
            email=cast(str, row[1]),
            display_name=cast(str, row[2]),
            role=cast(DatasetPermissionRole, row[3]),
            granted_by=cast(UUID, row[4]),
            created_at=cast(datetime, row[5]),
            updated_at=cast(datetime, row[6]),
        )

    @staticmethod
    async def _event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        event_type: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'dataset', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                dataset_id,
                request_id,
                Jsonb(payload),
            ),
        )
