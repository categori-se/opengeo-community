from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    Roles,
    authorize,
    is_allowed,
)
from opengeo_api.ingestion import DatasetClassification, DatasetStatus, Page, ProjectRole
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

ExternalSourceType = Literal[
    "xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog"
]
ExternalSourceAccessMode = Literal["direct_browser"]
ExternalSourceCredentialMode = Literal["none"]
ExternalSourceVerificationState = Literal["syntax_only"]


class ExternalSourceStoreUnavailable(RuntimeError):
    pass


class ExternalSourceAccessDenied(RuntimeError):
    pass


class ExternalSourceNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class ExternalSourceConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ExternalSourceCapabilities:
    read: bool
    edit: bool
    manage_classification: bool = False


@dataclass(frozen=True, slots=True)
class ExternalSource:
    dataset_id: UUID
    project_id: UUID
    name: str
    description: str | None
    classification: DatasetClassification
    status: DatasetStatus
    owner_user_id: UUID
    source_type: ExternalSourceType
    access_mode: ExternalSourceAccessMode
    credential_mode: ExternalSourceCredentialMode
    version_number: int
    source_url: str
    configuration: dict[str, Any]
    verification_state: ExternalSourceVerificationState
    created_at: datetime
    updated_at: datetime
    capabilities: ExternalSourceCapabilities


@dataclass(frozen=True, slots=True)
class ExternalSourceRevision:
    dataset_id: UUID
    version_number: int
    source_url: str
    configuration: dict[str, Any]
    verification_state: ExternalSourceVerificationState
    change_message: str | None
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ExternalSourceDraft:
    name: str
    description: str | None
    classification: DatasetClassification
    source_type: ExternalSourceType
    source_url: str
    configuration: dict[str, Any]
    tags: tuple[str, ...]
    discovery_job_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ExternalSourceUpdate:
    expected_version: int
    source_type: ExternalSourceType | None = None
    source_url: str | None = None
    configuration: dict[str, Any] | None = None
    change_message: str | None = None
    classification: DatasetClassification | None = None
    expected_classification: DatasetClassification | None = None
    public_eligibility_reviewed: bool = False


class ExternalSourceRepository(Protocol):
    async def resolve_referenced_file(
        self,
        context: TenantContext,
        project_id: UUID,
        *,
        dataset_id: UUID,
        source_version: int,
        resource_id: UUID,
        resource_version_id: UUID,
        distribution_id: str,
        relative_path: str,
    ) -> dict[str, Any]: ...

    async def list_sources(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[ExternalSource]: ...

    async def get_source(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> ExternalSource: ...

    async def list_source_revisions(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID, page: Page
    ) -> list[ExternalSourceRevision]: ...

    async def create_source(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ExternalSourceDraft,
        request_id: str,
    ) -> ExternalSource: ...

    async def update_source(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        update: ExternalSourceUpdate,
        request_id: str,
    ) -> ExternalSource: ...


OperationResult = TypeVar("OperationResult")


class PostgresExternalSourceRepository:
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
            raise ExternalSourceConflict("external_source_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ExternalSourceStoreUnavailable("external source operation failed") from error

    async def resolve_referenced_file(
        self,
        context: TenantContext,
        project_id: UUID,
        *,
        dataset_id: UUID,
        source_version: int,
        resource_id: UUID,
        resource_version_id: UUID,
        distribution_id: str,
        relative_path: str,
    ) -> dict[str, Any]:
        """Resolve saved public TIFF facts under current Layer and metadata access.

        This metadata operation does not fetch, copy or publish the referenced file.
        Its digest is an expected byte identity, to be verified by the eventual reader.
        """
        from opengeo_api.external_source_routes import _validate_public_https_url
        from opengeo_api.metadata_catalog import CatalogMetadataInvalid, catalog_metadata
        from opengeo_api.observable_sources import (
            ObservableSourceConflict,
            validate_observable_attachment_path,
        )
        from opengeo_api.resources import PostgresResourceRepository, ResourceNotFound

        if (
            type(source_version) is not int
            or not 1 <= source_version <= 9_007_199_254_740_991
            or not isinstance(distribution_id, str)
            or not 1 <= len(distribution_id) <= 1000
            or not isinstance(relative_path, str)
            or not relative_path.lower().endswith((".tif", ".tiff"))
        ):
            raise ExternalSourceConflict("referenced_file_selection_invalid")
        try:
            validate_observable_attachment_path(relative_path)
        except ObservableSourceConflict as error:
            raise ExternalSourceConflict("referenced_file_selection_invalid") from error

        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            roles = await self._project_roles(transaction, context, project_id)
            source = await self._load_source(
                transaction, context, project_id, dataset_id, roles=roles
            )
            if (
                source.status != "active"
                or source.source_type != "cog"
                or source.access_mode != "direct_browser"
                or source.credential_mode != "none"
            ):
                raise ExternalSourceConflict("referenced_file_source_ineligible")
            try:
                metadata_roles = await PostgresResourceRepository._resource_roles(
                    transaction, context, project_id, resource_id
                )
            except ResourceNotFound as error:
                raise ExternalSourceNotFound("referenced_file_metadata") from error
            self._require(Action.RESOURCE_READ, metadata_roles)
            row = await transaction.fetch_one(
                """SELECT metadata.id, metadata.version_number,
                          metadata.metadata_extensions, revision.source_url
                   FROM app.governed_resources resource
                   JOIN app.governed_resource_versions metadata
                     ON metadata.organization_id = resource.organization_id
                    AND metadata.resource_id = resource.id AND metadata.id = %s
                   JOIN app.external_source_revisions revision
                     ON revision.organization_id = resource.organization_id
                    AND revision.dataset_id = resource.dataset_id
                    AND revision.version_number = %s
                   WHERE resource.organization_id = %s AND resource.project_id = %s
                     AND resource.id = %s AND resource.dataset_id = %s
                     AND resource.kind = 'dataset' AND resource.state <> 'archived'
                     AND metadata.provenance->>'externalSourceVersion' = %s
                     AND metadata.provenance->>'externalSourceUrl' = revision.source_url
                   FOR SHARE OF resource""",
                (
                    resource_version_id, source_version, context.organization_id,
                    project_id, resource_id, dataset_id, str(source_version),
                ),
            )
            if row is None:
                raise ExternalSourceNotFound("referenced_file_metadata")
            try:
                metadata = catalog_metadata(cast(dict[str, Any], row[2]))
            except CatalogMetadataInvalid as error:
                raise ExternalSourceConflict("referenced_file_metadata_invalid") from error
            matches = [
                item for item in metadata.get("distributions", [])
                if item.get("identifier") == distribution_id
            ]
            if len(matches) != 1:
                raise ExternalSourceConflict("referenced_file_distribution_invalid")
            distribution = matches[0]
            size = distribution.get("byteSize")
            checksum = distribution.get("checksumSha256")
            url = distribution.get("downloadUrl")
            media = distribution.get("mediaType")
            if (
                type(size) is not int or not 1 <= size <= 67_108_864
                or not isinstance(checksum, str) or len(checksum) != 64
                or url != row[3] or media not in {"image/tiff", "image/geotiff"}
            ):
                raise ExternalSourceConflict("referenced_file_distribution_invalid")
            try:
                _validate_public_https_url(cast(str, url), allow_query=False)
            except ValueError as error:
                raise ExternalSourceConflict("referenced_file_distribution_invalid") from error
            return {
                "kind": "referenced-public-file", "custody": "referenced",
                "path": relative_path, "datasetId": str(dataset_id),
                "sourceVersion": source_version, "resourceId": str(resource_id),
                "resourceVersionId": str(row[0]), "resourceVersionNumber": row[1],
                "distributionId": distribution_id, "url": url, "contentType": media,
                "sizeBytes": size, "checksumSha256": checksum,
            }

        return await self._run(context, operation)

    async def list_sources(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[ExternalSource]:
        async def operation(transaction: TenantTransaction) -> list[ExternalSource]:
            roles = await self._project_roles(transaction, context, project_id)
            unrestricted = is_allowed(Action.DATASET_SOURCE_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._source_select()}
                WHERE dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND (%s OR caller_permission.role IS NOT NULL
                           OR dataset.owner_user_id = app.current_user_id())
                ORDER BY dataset.updated_at DESC, lower(dataset.name), dataset.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, unrestricted, page.limit, page.offset),
            )
            records = [self._source(row, roles) for row in rows]
            return [record for record in records if record.capabilities.read]

        return await self._run(context, operation)

    async def get_source(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> ExternalSource:
        async def operation(transaction: TenantTransaction) -> ExternalSource:
            roles = await self._project_roles(transaction, context, project_id)
            return await self._load_source(
                transaction, context, project_id, dataset_id, roles=roles
            )

        return await self._run(context, operation)

    async def list_source_revisions(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID, page: Page
    ) -> list[ExternalSourceRevision]:
        async def operation(transaction: TenantTransaction) -> list[ExternalSourceRevision]:
            roles = await self._project_roles(transaction, context, project_id)
            await self._load_source(transaction, context, project_id, dataset_id, roles=roles)
            rows = await transaction.fetch_all(
                """
                SELECT revision.dataset_id, revision.version_number,
                       revision.source_url, revision.configuration,
                       revision.verification_state::text, revision.change_message,
                       revision.created_by, revision.created_at
                FROM app.external_source_revisions revision
                WHERE revision.organization_id = %s AND revision.dataset_id = %s
                ORDER BY revision.version_number DESC
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, dataset_id, page.limit, page.offset),
            )
            return [self._revision(row) for row in rows]

        return await self._run(context, operation)

    async def create_source(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ExternalSourceDraft,
        request_id: str,
    ) -> ExternalSource:
        dataset_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ExternalSource:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_SOURCE_CREATE, roles)
            if draft.discovery_job_id is not None:
                # Completed jobs are immutable under the database transition trigger.
                # A row lock would require UPDATE privileges the API must not have.
                discovery = await transaction.fetch_one(
                    """
                    SELECT id, service_url, collection_ref FROM app.external_source_discovery_jobs
                    WHERE organization_id = %s AND project_id = %s AND id = %s
                      AND state = 'completed' AND discovery_kind = 'collection'
                      AND source_type = %s AND result->'source_definition'->>'url' = %s
                      AND (%s <> 'wfs' OR collection_ref = %s)
                    """,
                    (
                        context.organization_id,
                        project_id,
                        draft.discovery_job_id,
                        draft.source_type,
                        draft.source_url,
                        draft.source_type,
                        draft.configuration.get("type_name"),
                    ),
                )
                if discovery is None:
                    raise ExternalSourceConflict("source_discovery_binding_invalid")
            await transaction.execute(
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, description, classification,
                   source_type, format, status, owner_user_id, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s::app.dataset_classification,
                        %s::app.dataset_source_type, %s::app.dataset_format,
                        'active', %s, %s, %s)
                """,
                (
                    dataset_id,
                    context.organization_id,
                    draft.name,
                    draft.description,
                    draft.classification,
                    draft.source_type,
                    draft.source_type,
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
            await self._insert_tags(transaction, context, dataset_id, draft.tags)
            await transaction.execute(
                """
                INSERT INTO app.external_sources
                  (organization_id, dataset_id, source_type, created_by)
                VALUES (%s, %s, %s::app.dataset_source_type, %s)
                """,
                (context.organization_id, dataset_id, draft.source_type, context.user_id),
            )
            await transaction.execute(
                """
                INSERT INTO app.external_source_revisions
                  (organization_id, dataset_id, version_number, source_url,
                   configuration, change_message, created_by)
                VALUES (%s, %s, 1, %s, %s, 'Initial source registration', %s)
                """,
                (
                    context.organization_id,
                    dataset_id,
                    draft.source_url,
                    Jsonb(draft.configuration),
                    context.user_id,
                ),
            )
            if draft.discovery_job_id is not None:
                assert discovery is not None
                await transaction.execute(
                    """
                    INSERT INTO app.dataset_source_discoveries
                      (organization_id, dataset_id, discovery_job_id, source_type,
                       service_url, collection_ref, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        context.organization_id,
                        dataset_id,
                        draft.discovery_job_id,
                        draft.source_type,
                        discovery[1],
                        discovery[2],
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
                {"source_type": draft.source_type, "version_number": 1},
            )
            return await self._load_source(
                transaction, context, project_id, dataset_id, roles=roles
            )

        return await self._run(context, operation)

    async def update_source(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        update: ExternalSourceUpdate,
        request_id: str,
    ) -> ExternalSource:
        async def operation(transaction: TenantTransaction) -> ExternalSource:
            roles = await self._project_roles(transaction, context, project_id)
            locked = await transaction.fetch_one(
                """
                SELECT id, classification::text FROM app.datasets
                WHERE organization_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, dataset_id),
            )
            current = await self._load_source(
                transaction, context, project_id, dataset_id, roles=roles
            )
            if not current.capabilities.edit:
                raise ExternalSourceAccessDenied("action forbidden")
            if (
                update.classification is not None
                and not current.capabilities.manage_classification
            ):
                raise ExternalSourceAccessDenied("classification management forbidden")
            if update.source_type is not None and current.source_type != update.source_type:
                raise ExternalSourceConflict(
                    "external_source_type_immutable", current_version=current.version_number
                )
            latest = await transaction.fetch_one(
                """
                SELECT max(version_number)
                FROM app.external_source_revisions
                WHERE organization_id = %s AND dataset_id = %s
                """,
                (context.organization_id, dataset_id),
            )
            current_version = cast(int | None, latest[0] if latest else None)
            if current_version is None:
                raise ExternalSourceStoreUnavailable("external source has no revision")
            if current_version != update.expected_version:
                raise ExternalSourceConflict(
                    "external_source_version_conflict", current_version=current_version
                )
            if update.classification is not None:
                if (
                    update.source_type is not None
                    or update.source_url is not None
                    or update.configuration is not None
                ):
                    raise ExternalSourceConflict(
                        "external_source_classification_requires_separate_decision"
                    )
                if locked is None or locked[1] != update.expected_classification:
                    raise ExternalSourceConflict("external_source_classification_conflict")
                if update.classification == "public":
                    if update.public_eligibility_reviewed is not True:
                        raise ExternalSourceConflict("external_source_public_review_required")
                    if (
                        current.status != "active"
                        or current.access_mode != "direct_browser"
                        or current.credential_mode != "none"
                    ):
                        raise ExternalSourceConflict("external_source_public_ineligible")
                    metadata = await transaction.fetch_all(
                        """SELECT resource.id, permission.role::text
                           FROM app.governed_resources resource
                           JOIN app.governed_resource_versions metadata
                             ON metadata.organization_id=resource.organization_id
                            AND metadata.resource_id=resource.id
                            AND metadata.id=resource.current_version_id
                           LEFT JOIN app.governed_resource_permissions permission
                             ON permission.organization_id=resource.organization_id
                            AND permission.resource_id=resource.id AND permission.user_id=%s
                           WHERE resource.organization_id=%s AND resource.project_id=%s
                             AND resource.dataset_id=%s AND resource.kind='dataset'
                             AND resource.state='published' AND resource.visibility='public'
                             AND length(trim(metadata.license))>0
                             AND length(trim(metadata.attribution))>0
                             AND metadata.provenance->>'externalSourceVersion'=%s
                             AND metadata.provenance->>'externalSourceUrl'=%s
                           FOR SHARE OF resource""",
                        (
                            context.user_id, context.organization_id, project_id, dataset_id,
                            str(current_version), current.source_url,
                        ),
                    )
                    if not metadata:
                        raise ExternalSourceConflict("external_source_public_metadata_required")
                    if not (
                        roles.organization == "admin" or roles.project == "owner"
                        or current.owner_user_id == context.user_id
                        or any(row[1] in {"manage", "publish"} for row in metadata)
                    ):
                        raise ExternalSourceAccessDenied(
                            "source publication authority required"
                        )
                if locked[1] != update.classification:
                    await transaction.execute(
                        """UPDATE app.datasets
                           SET classification=%s::app.dataset_classification, updated_by=%s
                           WHERE organization_id=%s AND id=%s""",
                        (
                            update.classification, context.user_id,
                            context.organization_id, dataset_id,
                        ),
                    )
                    await self._record_event(
                        transaction, context, project_id, "dataset.source.classification.changed",
                        dataset_id, request_id,
                        {
                            "previous_classification": locked[1],
                            "classification": update.classification,
                            "version_number": current_version,
                        },
                    )
                return await self._load_source(
                    transaction, context, project_id, dataset_id, roles=roles
                )
            if update.source_url is None or update.configuration is None:
                raise ExternalSourceConflict("external_source_definition_required")
            next_version = current_version + 1
            await transaction.execute(
                """
                INSERT INTO app.external_source_revisions
                  (organization_id, dataset_id, version_number, source_url,
                   configuration, change_message, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    dataset_id,
                    next_version,
                    update.source_url,
                    Jsonb(update.configuration),
                    update.change_message,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.datasets SET updated_by = %s
                WHERE organization_id = %s AND id = %s
                """,
                (context.user_id, context.organization_id, dataset_id),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "dataset.source.updated",
                dataset_id,
                request_id,
                {"source_type": current.source_type, "version_number": next_version},
            )
            return await self._load_source(
                transaction, context, project_id, dataset_id, roles=roles
            )

        return await self._run(context, operation)

    async def _load_source(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        roles: Roles,
    ) -> ExternalSource:
        row = await transaction.fetch_one(
            f"""{self._source_select()}
            WHERE dataset.organization_id = %s
              AND project_dataset.project_id = %s
              AND dataset.id = %s
            """,
            (context.organization_id, project_id, dataset_id),
        )
        if row is None:
            raise ExternalSourceNotFound("external_source")
        source = self._source(row, roles)
        if not source.capabilities.read:
            raise ExternalSourceNotFound("external_source")
        return source

    @staticmethod
    def _source_select() -> str:
        return """
            SELECT dataset.id, project_dataset.project_id, dataset.name,
                   dataset.description, dataset.classification::text,
                   dataset.status::text, dataset.owner_user_id,
                   source.source_type::text, source.access_mode::text,
                   source.credential_mode::text, revision.version_number,
                   revision.source_url, revision.configuration,
                   revision.verification_state::text, source.created_at,
                   revision.created_at, caller_permission.role::text,
                   dataset.owner_user_id = app.current_user_id(),
                   caller_project_membership.role::text
            FROM app.external_sources source
            JOIN app.datasets dataset
              ON dataset.organization_id = source.organization_id
             AND dataset.id = source.dataset_id
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = dataset.organization_id
             AND project_dataset.dataset_id = dataset.id
            JOIN LATERAL (
              SELECT source_revision.version_number, source_revision.source_url,
                     source_revision.configuration,
                     source_revision.verification_state,
                     source_revision.created_at
              FROM app.external_source_revisions source_revision
              WHERE source_revision.organization_id = source.organization_id
                AND source_revision.dataset_id = source.dataset_id
              ORDER BY source_revision.version_number DESC
              LIMIT 1
            ) revision ON true
            LEFT JOIN app.dataset_permissions caller_permission
              ON caller_permission.organization_id = dataset.organization_id
             AND caller_permission.dataset_id = dataset.id
             AND caller_permission.user_id = app.current_user_id()
            CROSS JOIN LATERAL (
              SELECT app.effective_project_role(project_dataset.project_id)::text AS role
            ) caller_project_membership
        """

    @classmethod
    def _source(cls, row: tuple[Any, ...], project_roles: Roles) -> ExternalSource:
        roles = Roles(
            organization=project_roles.organization,
            project=project_roles.project or cast(ProjectRole | None, row[18]),
            dataset=cast(DatasetPermissionRole | None, row[16]),
            dataset_owner=cast(bool, row[17]),
        )
        return ExternalSource(
            dataset_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            name=cast(str, row[2]),
            description=cast(str | None, row[3]),
            classification=cast(DatasetClassification, row[4]),
            status=cast(DatasetStatus, row[5]),
            owner_user_id=cast(UUID, row[6]),
            source_type=cast(ExternalSourceType, row[7]),
            access_mode=cast(ExternalSourceAccessMode, row[8]),
            credential_mode=cast(ExternalSourceCredentialMode, row[9]),
            version_number=cast(int, row[10]),
            source_url=cast(str, row[11]),
            configuration=cast(dict[str, Any], row[12]),
            verification_state=cast(ExternalSourceVerificationState, row[13]),
            created_at=cast(datetime, row[14]),
            updated_at=cast(datetime, row[15]),
            capabilities=ExternalSourceCapabilities(
                read=is_allowed(Action.DATASET_SOURCE_READ, roles),
                edit=is_allowed(Action.DATASET_SOURCE_UPDATE, roles),
                manage_classification=is_allowed(Action.DATASET_SOURCE_UPDATE, roles)
                and is_allowed(Action.DATASET_PERMISSIONS_MANAGE, roles),
            ),
        )

    @staticmethod
    def _revision(row: tuple[Any, ...]) -> ExternalSourceRevision:
        return ExternalSourceRevision(
            dataset_id=cast(UUID, row[0]),
            version_number=cast(int, row[1]),
            source_url=cast(str, row[2]),
            configuration=cast(dict[str, Any], row[3]),
            verification_state=cast(ExternalSourceVerificationState, row[4]),
            change_message=cast(str | None, row[5]),
            created_by=cast(UUID, row[6]),
            created_at=cast(datetime, row[7]),
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
            raise ExternalSourceAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise ExternalSourceNotFound("project")
        return Roles(
            organization=cast(Any, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise ExternalSourceAccessDenied("action forbidden") from error

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
                raise ExternalSourceStoreUnavailable("tag registration returned no row")
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
        dataset_id: UUID,
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
