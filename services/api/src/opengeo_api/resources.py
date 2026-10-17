import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    ResourcePermissionRole,
    Roles,
    authorize,
    is_allowed,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_profiles import canonical_metadata_json, validate_metadata_document
from opengeo_api.s3_downloads import DownloadStorage, ExactObjectSpec, UnavailableDownloadStorage
from opengeo_api.s3_uploads import (
    StoredObject,
    UnavailableUploadStorage,
    UploadForm,
    UploadSpec,
    UploadStorage,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

ResourceKind = Literal["dataset", "map", "document", "story", "dashboard", "service"]
ResourceVisibility = Literal["restricted", "organization", "public"]
ResourceState = Literal["draft", "review", "published", "archived"]
ResourceRelation = Literal["references", "has_part", "is_part_of", "derived_from", "documents"]
ResourceStyleFormat = Literal["maplibre", "geostyler", "sld_1_0", "sld_1_1", "mapserver_mapfile"]
MetadataSourceFormat = Literal[
    "dcat_3",
    "stac_1_1",
    "iso_19115_3",
    "schema_org_dataset",
    "datacite_4_7",
    "geodcat_ap_3_1",
]
MetadataSourceValue = dict[str, Any] | str
OperationResult = TypeVar("OperationResult")


class ResourceStoreUnavailable(RuntimeError):
    pass


class ResourceAccessDenied(RuntimeError):
    pass


class ResourceNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class ResourceConflict(RuntimeError):
    def __init__(
        self,
        code: str,
        *,
        current_version: int | None = None,
        current_draft_revision: int | None = None,
    ) -> None:
        self.code = code
        self.current_version = current_version
        self.current_draft_revision = current_draft_revision
        super().__init__(code)


class ResourceSearchInvalid(ValueError):
    pass


class ResourceMetadataInvalid(RuntimeError):
    def __init__(self, report: dict[str, Any]) -> None:
        self.report = report
        super().__init__("metadata_profile_validation_failed")


@dataclass(frozen=True, slots=True)
class ResourceMetadata:
    title: str
    abstract: str | None
    language: str
    license: str | None
    attribution: str | None
    keywords: tuple[str, ...]
    spatial_extent: tuple[float, float, float, float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None
    profile: str
    extensions: dict[str, Any]
    translations: dict[str, dict[str, Any]] = field(default_factory=dict)
    managed_profile_id: UUID | None = None
    managed_profile_version: int | None = None


@dataclass(frozen=True, slots=True)
class ResourceExternalIdentifier:
    namespace: str
    identifier: str
    source_url: str
    source_version: str
    source_payload_sha256: str
    imported_at: datetime


@dataclass(frozen=True, slots=True)
class ResourceRelationship:
    relationship_id: UUID
    source_resource_id: UUID
    target_resource_id: UUID
    relation: ResourceRelation
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ResourcePermission:
    user_id: UUID
    email: str
    display_name: str
    role: ResourcePermissionRole
    granted_by: UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ResourcePermissionGrant:
    user_id: UUID
    role: ResourcePermissionRole


@dataclass(frozen=True, slots=True)
class ResourceCapabilities:
    can_read: bool
    can_update: bool
    can_publish: bool
    can_manage_permissions: bool


@dataclass(frozen=True, slots=True)
class ResourceStyle:
    style_id: UUID
    resource_id: UUID
    slug: str
    format: ResourceStyleFormat
    version_number: int
    title: str
    media_type: str
    definition: str
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    archived: bool = False


@dataclass(frozen=True, slots=True)
class ResourceStyleDraft:
    slug: str
    format: ResourceStyleFormat
    title: str
    media_type: str
    definition: str
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class ResourceStyleUpdate:
    expected_version: int
    format: ResourceStyleFormat
    title: str
    media_type: str
    definition: str
    checksum_sha256: str
    change_message: str | None


@dataclass(frozen=True, slots=True)
class ResourceWorkflowEvent:
    event_id: UUID
    source_state: ResourceState
    target_state: ResourceState
    reason: str | None
    actor_user_id: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ResourceSummary:
    resource_id: UUID
    project_id: UUID
    kind: ResourceKind
    slug: str
    dataset_id: UUID | None
    map_id: UUID | None
    visibility: ResourceVisibility
    state: ResourceState
    version_number: int
    title: str
    abstract: str | None
    language: str
    license: str | None
    attribution: str | None
    keywords: tuple[str, ...]
    spatial_extent: tuple[float, float, float, float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None
    owner_user_id: UUID
    origin_namespace: str | None
    origin_identifier: str | None
    relationship_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class MapResourceSnapshot:
    map_id: UUID
    map_version_id: UUID
    map_version: int
    definition_checksum_sha256: str


@dataclass(frozen=True, slots=True)
class GovernedResource:
    summary: ResourceSummary
    metadata_profile: str
    metadata_extensions: dict[str, Any]
    content: dict[str, Any]
    provenance: dict[str, Any]
    change_message: str | None
    version_created_by: UUID
    version_created_at: datetime
    external_identifiers: tuple[ResourceExternalIdentifier, ...]
    relationships: tuple[ResourceRelationship, ...]
    managed_metadata_profile_id: UUID | None = None
    managed_metadata_profile_version: int | None = None
    metadata_validation: dict[str, Any] | None = None
    translations: dict[str, dict[str, Any]] = field(default_factory=dict)
    map_snapshot: MapResourceSnapshot | None = None
    current_version_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ResourceDraft:
    kind: ResourceKind
    slug: str
    dataset_id: UUID | None
    map_id: UUID | None
    visibility: ResourceVisibility
    state: ResourceState
    metadata: ResourceMetadata
    content: dict[str, Any]
    provenance: dict[str, Any]
    expected_map_version: int | None = None


@dataclass(frozen=True, slots=True)
class ResourceUpdate:
    expected_version: int
    visibility: ResourceVisibility
    metadata: ResourceMetadata
    content: dict[str, Any]
    provenance: dict[str, Any]
    change_message: str | None
    expected_map_version: int | None = None


@dataclass(frozen=True, slots=True)
class PageSourceUploadDraft:
    expected_resource_version: int
    source_block_id: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class PageSourceUploadTicket:
    upload_id: UUID
    resource_id: UUID
    expected_resource_version: int
    source_block_id: str
    upload: UploadForm


@dataclass(frozen=True, slots=True)
class PageSource:
    source_id: UUID
    resource_id: UUID
    resource_version_id: UUID
    resource_version_number: int
    parent_version_number: int | None
    source_block_id: str
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    dialect: str
    dialect_version: str
    compiler_version: str
    change_summary: str
    created_by: UUID
    created_at: datetime
    source_markdown: str | None = None


@dataclass(frozen=True, slots=True)
class PageVersion:
    resource: GovernedResource
    source: PageSource


@dataclass(frozen=True, slots=True)
class PageWorkingDraft:
    draft_id: UUID
    resource_id: UUID
    owner_user_id: UUID
    base_resource_version: int
    revision_number: int
    visibility: ResourceVisibility
    metadata: dict[str, Any]
    content: dict[str, Any]
    provenance: dict[str, Any]
    source_block_id: str | None
    source_markdown: str
    change_summary: str | None
    document_checksum_sha256: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class PageWorkingDraftUpdate:
    expected_resource_version: int
    expected_draft_revision: int
    visibility: ResourceVisibility
    metadata: dict[str, Any]
    content: dict[str, Any]
    provenance: dict[str, Any]
    source_block_id: str | None
    source_markdown: str
    change_summary: str | None


@dataclass(frozen=True, slots=True)
class _PageSourceIntent:
    upload_id: UUID
    resource_id: UUID
    expected_resource_version: int
    source_block_id: str
    expected_size_bytes: int
    expected_sha256: str
    bucket: str
    object_key: str
    state: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ResourceFilters:
    query: str | None = None
    kind: ResourceKind | None = None
    visibility: ResourceVisibility | None = None
    state: ResourceState | None = None
    bbox: tuple[float, float, float, float] | None = None
    temporal_start: datetime | None = None
    temporal_end: datetime | None = None
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True, slots=True)
class RecordFilters:
    stac_collections: bool = False
    stac_items: bool = False
    stac_ids: tuple[str, ...] = ()
    intersects: dict[str, Any] | None = None
    query: str | None = None
    kinds: tuple[ResourceKind, ...] = ()
    ids: tuple[UUID, ...] = ()
    external_ids: tuple[str, ...] = ()
    bbox: tuple[float, float, float, float] | None = None
    temporal_start: datetime | None = None
    temporal_end: datetime | None = None
    limit: int = 10
    offset: int = 0


@dataclass(frozen=True, slots=True)
class RecordResource:
    summary: ResourceSummary
    translations: dict[str, dict[str, Any]]
    external_identifiers: tuple[ResourceExternalIdentifier, ...]
    metadata_extensions: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RecordResourcePage:
    resources: tuple[RecordResource, ...]
    number_matched: int


@dataclass(frozen=True, slots=True)
class ImportedResource:
    identifier: str
    source_payload_sha256: str
    draft: ResourceDraft


@dataclass(frozen=True, slots=True)
class ImportedRelationship:
    source_identifier: str
    target_identifier: str
    relation: ResourceRelation


@dataclass(frozen=True, slots=True)
class ResourceImportPlan:
    namespace: Literal["geonode"]
    source_url: str
    source_version: Literal["5.1.0"]
    resources: tuple[ImportedResource, ...]
    relationships: tuple[ImportedRelationship, ...]
    report: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ResourceImportResult:
    resources: tuple[GovernedResource, ...]
    report: dict[str, Any]
    idempotent: bool


@dataclass(frozen=True, slots=True)
class MetadataSourceDocument:
    source_document_id: UUID
    resource_id: UUID
    resource_version_id: UUID
    source_format: MetadataSourceFormat
    source_version: str
    source_namespace: str
    source_identifier: str
    source_document: MetadataSourceValue
    source_sha256: str
    conversion_report: dict[str, Any]
    imported_by: UUID
    imported_at: datetime


@dataclass(frozen=True, slots=True)
class MetadataResourceImportPlan:
    source_format: MetadataSourceFormat
    source_version: str
    source_namespace: str
    source_identifier: str
    source_sha256: str
    source_document: MetadataSourceValue
    conversion_report: dict[str, Any]
    draft: ResourceDraft


@dataclass(frozen=True, slots=True)
class MetadataResourceImportResult:
    resource: GovernedResource
    source: MetadataSourceDocument
    idempotent: bool


class ResourceRepository(Protocol):
    async def list_dataset_resources(
        self, context: TenantContext, dataset_id: UUID, limit: int, offset: int
    ) -> list[ResourceSummary]: ...

    async def list_resources(
        self, context: TenantContext, project_id: UUID, filters: ResourceFilters
    ) -> list[ResourceSummary]: ...

    async def get_resource(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> GovernedResource: ...

    async def get_record_version(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, version: int
    ) -> RecordResource: ...

    async def list_record_resources(
        self, context: TenantContext, project_id: UUID, filters: RecordFilters
    ) -> RecordResourcePage: ...

    async def create_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ResourceDraft,
        request_id: str,
    ) -> GovernedResource: ...

    async def update_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        update: ResourceUpdate,
        request_id: str,
    ) -> GovernedResource: ...

    async def request_page_source_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: PageSourceUploadDraft,
        request_id: str,
    ) -> PageSourceUploadTicket: ...

    async def create_page_version(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
        update: ResourceUpdate,
        request_id: str,
    ) -> PageVersion: ...

    async def get_page_working_draft(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> PageWorkingDraft | None: ...

    async def save_page_working_draft(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        update: PageWorkingDraftUpdate,
    ) -> PageWorkingDraft: ...

    async def discard_page_working_draft(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_resource_version: int,
        expected_draft_revision: int,
    ) -> bool: ...

    async def list_page_versions(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[PageSource]: ...

    async def get_page_source(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None = None,
    ) -> PageSource: ...

    async def add_relationship(
        self,
        context: TenantContext,
        project_id: UUID,
        source_resource_id: UUID,
        target_resource_id: UUID,
        relation: ResourceRelation,
        request_id: str,
    ) -> GovernedResource: ...

    async def import_resources(
        self,
        context: TenantContext,
        project_id: UUID,
        plan: ResourceImportPlan,
        request_id: str,
    ) -> ResourceImportResult: ...

    async def import_metadata_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        plan: MetadataResourceImportPlan,
        request_id: str,
    ) -> MetadataResourceImportResult: ...

    async def get_metadata_source(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> MetadataSourceDocument: ...

    async def bind_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        dataset_id: UUID | None,
        map_id: UUID | None,
        request_id: str,
    ) -> GovernedResource: ...

    async def transition_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        target_state: ResourceState,
        visibility: ResourceVisibility | None,
        reason: str | None,
        request_id: str,
    ) -> GovernedResource: ...

    async def set_publication_visibility(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        expected_visibility: ResourceVisibility,
        visibility: ResourceVisibility,
        request_id: str,
    ) -> GovernedResource: ...

    async def get_capabilities(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> ResourceCapabilities: ...

    async def list_permissions(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[ResourcePermission]: ...

    async def put_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        grant: ResourcePermissionGrant,
        request_id: str,
    ) -> ResourcePermission: ...

    async def delete_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None: ...

    async def list_styles(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        *,
        include_archived: bool = False,
    ) -> list[ResourceStyle]: ...

    async def get_style_version(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        version_number: int,
    ) -> ResourceStyle: ...

    async def create_style(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: ResourceStyleDraft,
        request_id: str,
    ) -> ResourceStyle: ...

    async def update_style(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        update: ResourceStyleUpdate,
        request_id: str,
    ) -> ResourceStyle: ...

    async def set_style_archived(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        expected_version: int,
        archived: bool,
        request_id: str,
    ) -> ResourceStyle: ...

    async def list_workflow_events(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[ResourceWorkflowEvent]: ...


class PostgresResourceRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        source_upload_storage: UploadStorage | None = None,
        source_download_storage: DownloadStorage | None = None,
    ) -> None:
        self._executor = executor
        self._source_upload_storage = source_upload_storage or UnavailableUploadStorage()
        self._source_download_storage = source_download_storage or UnavailableDownloadStorage()

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise ResourceConflict("resource_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ResourceStoreUnavailable("resource operation failed") from error

    async def list_dataset_resources(
        self, context: TenantContext, dataset_id: UUID, limit: int, offset: int
    ) -> list[ResourceSummary]:
        """List only records independently readable under RESOURCE_READ policy."""

        async def operation(transaction: TenantTransaction) -> list[ResourceSummary]:
            rows = await transaction.fetch_all(
                f"""{self._summary_select()}
                JOIN app.organization_memberships membership
                  ON membership.organization_id = resource.organization_id
                 AND membership.user_id = %s
                WHERE resource.organization_id = %s AND resource.dataset_id = %s
                  AND (
                    membership.role::text = 'admin'
                    OR resource.owner_user_id = membership.user_id
                    OR app.effective_project_role(resource.project_id, membership.user_id)
                       IS NOT NULL
                    OR EXISTS (
                      SELECT 1 FROM app.governed_resource_permissions permission
                      WHERE permission.organization_id = resource.organization_id
                        AND permission.resource_id = resource.id
                        AND permission.user_id = membership.user_id
                        AND permission.role::text IN ('manage', 'edit', 'publish', 'view')
                    )
                  )
                ORDER BY resource.id
                LIMIT %s OFFSET %s
                """,
                (context.user_id, context.organization_id, dataset_id, limit, offset),
            )
            return [self._summary(row) for row in rows]

        return await self._run(context, operation)

    async def list_resources(
        self, context: TenantContext, project_id: UUID, filters: ResourceFilters
    ) -> list[ResourceSummary]:
        async def operation(transaction: TenantTransaction) -> list[ResourceSummary]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.RESOURCE_READ, roles)
            bbox = filters.bbox or (None, None, None, None)
            rows = await transaction.fetch_all(
                f"""{self._summary_select()}
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND (%s::app.governed_resource_kind IS NULL
                       OR resource.kind = %s::app.governed_resource_kind)
                  AND (%s::app.governed_resource_visibility IS NULL
                       OR resource.visibility = %s::app.governed_resource_visibility)
                  AND (%s::app.governed_resource_state IS NULL
                       OR resource.state = %s::app.governed_resource_state)
                  AND (
                    %s::text IS NULL
                    OR version.search_document @@ websearch_to_tsquery('simple', %s::text)
                    OR EXISTS (
                      SELECT 1 FROM unnest(version.keywords) keyword
                      WHERE lower(keyword) LIKE '%%' || lower(%s::text) || '%%'
                    )
                  )
                  AND (
                    %s::double precision IS NULL
                    OR (version.spatial_extent IS NOT NULL AND (
                      (version.spatial_extent->>0)::double precision <= %s::double precision
                      AND (version.spatial_extent->>2)::double precision >= %s::double precision
                      AND (version.spatial_extent->>1)::double precision <= %s::double precision
                      AND (version.spatial_extent->>3)::double precision >= %s::double precision
                    ))
                  )
                  AND (%s::timestamptz IS NULL OR version.temporal_end IS NULL
                       OR version.temporal_end >= %s::timestamptz)
                  AND (%s::timestamptz IS NULL OR version.temporal_start IS NULL
                       OR version.temporal_start <= %s::timestamptz)
                ORDER BY lower(version.title), resource.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    filters.kind,
                    filters.kind,
                    filters.visibility,
                    filters.visibility,
                    filters.state,
                    filters.state,
                    filters.query,
                    filters.query,
                    filters.query,
                    bbox[0],
                    bbox[2],
                    bbox[0],
                    bbox[3],
                    bbox[1],
                    filters.temporal_start,
                    filters.temporal_start,
                    filters.temporal_end,
                    filters.temporal_end,
                    filters.limit,
                    filters.offset,
                ),
            )
            return [self._summary(row) for row in rows]

        return await self._run(context, operation)

    async def request_page_source_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: PageSourceUploadDraft,
        request_id: str,
    ) -> PageSourceUploadTicket:
        async def preauthorize(transaction: TenantTransaction) -> None:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            row = await transaction.fetch_one(
                """
                SELECT resource.kind::text, version.version_number
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                """,
                (context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise ResourceNotFound("resource")
            if cast(str, row[0]) not in {"document", "story", "dashboard"}:
                raise ResourceConflict("page_source_kind_unsupported")
            current_version = cast(int, row[1])
            if current_version != draft.expected_resource_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)

        await self._run(context, preauthorize)
        upload_id = uuid4()
        next_version = draft.expected_resource_version + 1
        object_key = (
            f"organizations/{context.organization_id}/projects/{project_id}/"
            f"pages/{resource_id}/versions/{next_version}/uploads/{upload_id}/source.md"
        )
        upload_form = await self._source_upload_storage.create_upload_form(
            UploadSpec(
                key=object_key,
                content_type="text/markdown",
                size_bytes=draft.size_bytes,
                checksum_sha256=draft.checksum_sha256,
            )
        )

        async def register(transaction: TenantTransaction) -> None:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT version.version_number, resource.kind::text
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                """,
                (context.organization_id, project_id, resource_id),
            )
            if current is None:
                raise ResourceNotFound("resource")
            current_version = cast(int, current[0])
            if cast(str, current[1]) not in {"document", "story", "dashboard"}:
                raise ResourceConflict("page_source_kind_unsupported")
            if current_version != draft.expected_resource_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)
            await transaction.execute(
                """
                INSERT INTO app.page_source_upload_intents
                  (id, organization_id, project_id, resource_id,
                   expected_resource_version, source_block_id,
                   expected_size_bytes, expected_sha256, bucket, object_key,
                   created_by, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    upload_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    draft.expected_resource_version,
                    draft.source_block_id,
                    draft.size_bytes,
                    draft.checksum_sha256,
                    self._source_upload_storage.bucket,
                    object_key,
                    context.user_id,
                    upload_form.expires_at,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "page.source.upload.requested",
                resource_id,
                request_id,
                {
                    "uploadId": str(upload_id),
                    "expectedResourceVersion": draft.expected_resource_version,
                    "sourceBlockId": draft.source_block_id,
                    "expectedSizeBytes": draft.size_bytes,
                },
            )

        await self._run(context, register)
        return PageSourceUploadTicket(
            upload_id=upload_id,
            resource_id=resource_id,
            expected_resource_version=draft.expected_resource_version,
            source_block_id=draft.source_block_id,
            upload=upload_form,
        )

    async def get_page_working_draft(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> PageWorkingDraft | None:
        async def operation(transaction: TenantTransaction) -> PageWorkingDraft | None:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            return await self._load_page_working_draft(
                transaction, context, project_id, resource_id, lock=False
            )

        return await self._run(context, operation)

    async def save_page_working_draft(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        update: PageWorkingDraftUpdate,
    ) -> PageWorkingDraft:
        checksum = self._page_working_draft_checksum(update)

        async def operation(transaction: TenantTransaction) -> PageWorkingDraft:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT resource.kind::text, version.version_number
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR SHARE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if current is None:
                raise ResourceNotFound("resource")
            if cast(str, current[0]) not in {"document", "story", "dashboard"}:
                raise ResourceConflict("page_source_kind_unsupported")
            current_version = cast(int, current[1])
            if current_version != update.expected_resource_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)

            if update.expected_draft_revision == 0:
                await transaction.fetch_one(
                    """
                    INSERT INTO app.page_working_drafts
                      (id, organization_id, project_id, resource_id, owner_user_id,
                       base_resource_version)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (organization_id, resource_id, owner_user_id) DO NOTHING
                    RETURNING id
                    """,
                    (
                        uuid4(),
                        context.organization_id,
                        project_id,
                        resource_id,
                        context.user_id,
                        update.expected_resource_version,
                    ),
                )
            head = await transaction.fetch_one(
                """
                SELECT id, base_resource_version, current_revision_number,
                       current_document_checksum_sha256
                FROM app.page_working_drafts
                WHERE organization_id = %s AND project_id = %s
                  AND resource_id = %s AND owner_user_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, resource_id, context.user_id),
            )
            if head is None:
                raise ResourceConflict("page_draft_missing", current_draft_revision=0)
            draft_id = cast(UUID, head[0])
            base_version = cast(int, head[1])
            revision_number = cast(int, head[2])
            current_checksum = cast(str | None, head[3])
            if base_version != update.expected_resource_version:
                raise ResourceConflict(
                    "page_draft_base_conflict",
                    current_version=current_version,
                    current_draft_revision=revision_number,
                )
            if current_checksum == checksum:
                loaded = await self._load_page_working_draft(
                    transaction, context, project_id, resource_id, lock=False
                )
                if loaded is None:
                    raise ResourceNotFound("page_draft")
                return loaded
            if revision_number != update.expected_draft_revision:
                raise ResourceConflict(
                    "page_draft_revision_conflict",
                    current_draft_revision=revision_number,
                )
            if revision_number >= 512:
                raise ResourceConflict(
                    "page_draft_revision_limit", current_draft_revision=revision_number
                )
            next_revision = revision_number + 1
            await transaction.execute(
                """
                INSERT INTO app.page_working_draft_revisions
                  (id, organization_id, project_id, resource_id, draft_id,
                   owner_user_id, base_resource_version, revision_number,
                   visibility, metadata, content, provenance, source_block_id,
                   source_markdown, change_summary, document_checksum_sha256)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                        %s::app.governed_resource_visibility, %s, %s, %s,
                        %s, %s, %s, %s)
                """,
                (
                    uuid4(),
                    context.organization_id,
                    project_id,
                    resource_id,
                    draft_id,
                    context.user_id,
                    base_version,
                    next_revision,
                    update.visibility,
                    Jsonb(update.metadata),
                    Jsonb(update.content),
                    Jsonb(update.provenance),
                    update.source_block_id,
                    update.source_markdown,
                    update.change_summary,
                    checksum,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.page_working_drafts
                SET current_revision_number = %s,
                    current_document_checksum_sha256 = %s
                WHERE organization_id = %s AND id = %s
                  AND owner_user_id = %s AND current_revision_number = %s
                """,
                (
                    next_revision,
                    checksum,
                    context.organization_id,
                    draft_id,
                    context.user_id,
                    revision_number,
                ),
            )
            loaded = await self._load_page_working_draft(
                transaction, context, project_id, resource_id, lock=False
            )
            if loaded is None:
                raise ResourceNotFound("page_draft")
            return loaded

        return await self._run(context, operation)

    async def discard_page_working_draft(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_resource_version: int,
        expected_draft_revision: int,
    ) -> bool:
        async def operation(transaction: TenantTransaction) -> bool:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            draft = await self._load_page_working_draft(
                transaction, context, project_id, resource_id, lock=True
            )
            if draft is None:
                return False
            if draft.base_resource_version != expected_resource_version:
                raise ResourceConflict(
                    "page_draft_base_conflict",
                    current_version=draft.base_resource_version,
                    current_draft_revision=draft.revision_number,
                )
            if draft.revision_number != expected_draft_revision:
                raise ResourceConflict(
                    "page_draft_revision_conflict",
                    current_draft_revision=draft.revision_number,
                )
            row = await transaction.fetch_one(
                """
                SELECT app.discard_page_working_draft(%s, %s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    resource_id,
                    context.user_id,
                    expected_resource_version,
                    expected_draft_revision,
                ),
            )
            return row is not None and row[0] is True

        return await self._run(context, operation)

    async def create_page_version(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
        update: ResourceUpdate,
        request_id: str,
    ) -> PageVersion:
        if update.change_message is None:
            raise ResourceConflict("page_change_summary_required")

        async def load(transaction: TenantTransaction) -> _PageSourceIntent:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            return await self._load_page_source_intent(
                transaction, context, project_id, resource_id, upload_id, lock=False
            )

        intent = await self._run(context, load)
        if intent.state != "pending":
            raise ResourceConflict("page_source_upload_completed")
        if intent.expires_at <= datetime.now(UTC):
            raise ResourceConflict("page_source_upload_expired")
        if update.expected_version != intent.expected_resource_version:
            raise ResourceConflict("page_source_upload_version_mismatch")
        self._verify_page_source_content(update.content, intent)
        stored = await self._source_upload_storage.inspect_object(intent.object_key)
        self._verify_page_source_object(intent, stored)
        version_id = uuid4()
        source_id = uuid4()

        async def commit(transaction: TenantTransaction) -> PageVersion:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            locked_intent = await self._load_page_source_intent(
                transaction, context, project_id, resource_id, upload_id, lock=True
            )
            if locked_intent.state != "pending":
                raise ResourceConflict("page_source_upload_completed")
            expiry = await transaction.fetch_one(
                """
                SELECT expires_at > clock_timestamp()
                FROM app.page_source_upload_intents
                WHERE organization_id = %s AND id = %s
                """,
                (context.organization_id, upload_id),
            )
            if expiry is None or expiry[0] is not True:
                raise ResourceConflict("page_source_upload_expired")
            self._verify_page_source_object(locked_intent, stored)
            self._verify_page_source_content(update.content, locked_intent)
            current = await transaction.fetch_one(
                """
                SELECT version.version_number, resource.state::text, resource.kind::text
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR UPDATE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if current is None:
                raise ResourceNotFound("resource")
            if cast(str, current[2]) not in {"document", "story", "dashboard"}:
                raise ResourceConflict("page_source_kind_unsupported")
            current_version = cast(int, current[0])
            if current_version != locked_intent.expected_resource_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)
            next_version = current_version + 1
            await self._insert_version(
                transaction,
                context,
                resource_id,
                version_id,
                next_version,
                update.metadata,
                update.content,
                update.provenance,
                update.change_message,
            )
            await transaction.execute(
                """
                INSERT INTO app.page_source_objects
                  (id, organization_id, project_id, resource_id,
                   resource_version_id, upload_intent_id, source_block_id,
                   bucket, object_key, s3_version_id, etag, content_type,
                   size_bytes, checksum_sha256, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    source_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    version_id,
                    upload_id,
                    locked_intent.source_block_id,
                    stored.bucket,
                    stored.key,
                    stored.version_id,
                    stored.etag,
                    stored.content_type,
                    stored.size_bytes,
                    stored.checksum_sha256,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.governed_resources
                SET current_version_id = %s,
                    visibility = %s::app.governed_resource_visibility,
                    updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    version_id,
                    update.visibility,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                ),
            )
            await transaction.execute(
                """
                UPDATE app.page_source_upload_intents
                SET state = 'completed', completed_source_object_id = %s,
                    completed_at = clock_timestamp()
                WHERE organization_id = %s AND id = %s AND state = 'pending'
                """,
                (source_id, context.organization_id, upload_id),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "page.version.created",
                resource_id,
                request_id,
                {
                    "version": next_version,
                    "sourceBlockId": locked_intent.source_block_id,
                    "sourceSha256": stored.checksum_sha256,
                    "state": cast(str, current[1]),
                },
            )
            await transaction.fetch_one(
                """
                SELECT app.discard_page_working_draft(%s, %s, %s, %s, %s, NULL)
                """,
                (
                    context.organization_id,
                    project_id,
                    resource_id,
                    context.user_id,
                    current_version,
                ),
            )
            resource = await self._load_resource(transaction, context, project_id, resource_id)
            source = await self._load_page_source(
                transaction, context, project_id, resource_id, next_version
            )
            return PageVersion(resource=resource, source=source)

        return await self._run(context, commit)

    async def list_page_versions(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[PageSource]:
        async def operation(transaction: TenantTransaction) -> list[PageSource]:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._page_source_select()}
                WHERE source.organization_id = %s
                  AND source.project_id = %s
                  AND source.resource_id = %s
                ORDER BY version.version_number DESC
                """,
                (context.organization_id, project_id, resource_id),
            )
            return [self._page_source(row) for row in rows]

        return await self._run(context, operation)

    async def get_page_source(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None = None,
    ) -> PageSource:
        async def load(transaction: TenantTransaction) -> PageSource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            return await self._load_page_source(
                transaction, context, project_id, resource_id, version_number
            )

        source = await self._run(context, load)
        exact = await self._source_download_storage.read_exact_object(
            ExactObjectSpec(
                bucket=source.bucket,
                key=source.object_key,
                version_id=source.s3_version_id,
                content_type=source.content_type,
                size_bytes=source.size_bytes,
                checksum_sha256=source.checksum_sha256,
                maximum_bytes=65_536,
            )
        )
        try:
            markdown = exact.body.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ResourceConflict("page_source_utf8_invalid") from error
        return PageSource(
            source_id=source.source_id,
            resource_id=source.resource_id,
            resource_version_id=source.resource_version_id,
            resource_version_number=source.resource_version_number,
            parent_version_number=source.parent_version_number,
            source_block_id=source.source_block_id,
            bucket=source.bucket,
            object_key=source.object_key,
            s3_version_id=source.s3_version_id,
            etag=source.etag,
            content_type=source.content_type,
            size_bytes=source.size_bytes,
            checksum_sha256=source.checksum_sha256,
            dialect=source.dialect,
            dialect_version=source.dialect_version,
            compiler_version=source.compiler_version,
            change_summary=source.change_summary,
            created_by=source.created_by,
            created_at=source.created_at,
            source_markdown=markdown,
        )

    async def list_record_resources(
        self, context: TenantContext, project_id: UUID, filters: RecordFilters
    ) -> RecordResourcePage:
        async def operation(transaction: TenantTransaction) -> RecordResourcePage:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.RESOURCE_READ, roles)
            bbox = filters.bbox or (None, None, None, None)
            kinds = list(filters.kinds) or None
            ids = list(filters.ids) or None
            external_ids = list(filters.external_ids) or None
            where = """
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND (%s::text[] IS NULL OR resource.kind::text = ANY(%s::text[]))
                  AND (%s::uuid[] IS NULL OR resource.id = ANY(%s::uuid[]))
                  AND (
                    %s::text[] IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM app.governed_resource_external_identifiers identifier
                      WHERE identifier.organization_id = resource.organization_id
                        AND identifier.resource_id = resource.id
                        AND (
                          identifier.identifier = ANY(%s::text[])
                          OR identifier.namespace || ':' || identifier.identifier
                             = ANY(%s::text[])
                          OR identifier.namespace || ':' = ANY(%s::text[])
                        )
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM app.governed_metadata_source_documents source
                      WHERE source.organization_id = resource.organization_id
                        AND source.resource_id = resource.id
                        AND (
                          source.source_identifier = ANY(%s::text[])
                          OR source.source_namespace || ':' || source.source_identifier
                             = ANY(%s::text[])
                          OR source.source_namespace || ':' = ANY(%s::text[])
                        )
                    )
                  )
                  AND (
                    %s::text IS NULL
                    OR version.search_document @@ websearch_to_tsquery('simple', %s)
                    OR EXISTS (
                      SELECT 1 FROM unnest(version.keywords) keyword
                      WHERE to_tsvector('simple', keyword)
                            @@ websearch_to_tsquery('simple', %s)
                    )
                  )
                  AND (
                    %s::double precision IS NULL OR (version.spatial_extent IS NOT NULL AND (
                      (version.spatial_extent->>0)::double precision <= %s
                      AND (version.spatial_extent->>2)::double precision >= %s
                      AND (version.spatial_extent->>1)::double precision <= %s
                      AND (version.spatial_extent->>3)::double precision >= %s
                    ))
                  )
                  AND (%s::timestamptz IS NULL OR version.temporal_end IS NULL
                       OR version.temporal_end >= %s)
                  AND (%s::timestamptz IS NULL OR version.temporal_start IS NULL
                       OR version.temporal_start <= %s)
            """
            parameters: tuple[Any, ...] = (
                context.organization_id,
                project_id,
                kinds,
                kinds,
                ids,
                ids,
                external_ids,
                external_ids,
                external_ids,
                external_ids,
                external_ids,
                external_ids,
                external_ids,
                filters.query,
                filters.query,
                filters.query,
                bbox[0],
                bbox[2],
                bbox[0],
                bbox[3],
                bbox[1],
                filters.temporal_start,
                filters.temporal_start,
                filters.temporal_end,
                filters.temporal_end,
            )
            if filters.stac_items or filters.stac_collections:
                where += """
                  AND resource.kind::text IN ('dataset','service')
                  AND resource.state::text <> 'archived'
                """
            if filters.stac_items:
                where += """
                  AND version.temporal_start IS NOT NULL
                  AND version.temporal_end IS NOT NULL
                  AND version.temporal_start <= version.temporal_end
                """
                if filters.stac_ids:
                    where += (
                        " AND (resource.id::text || '-v' || version.version_number::text)"
                        " = ANY(%s::text[])"
                    )
                    parameters = (*parameters, list(filters.stac_ids))
            if filters.intersects is not None:
                from opengeo_api.features import FeatureInvalid, normalize_query_geometry

                if not filters.stac_items or filters.bbox is not None:
                    raise ResourceSearchInvalid("intersects requires STAC search without bbox")
                try:
                    geometry = normalize_query_geometry(filters.intersects)
                except (FeatureInvalid, OverflowError) as error:
                    raise ResourceSearchInvalid(str(error)) from error
                valid = await transaction.fetch_one(
                    "SELECT ST_IsValid(ST_GeomFromGeoJSON(%s::text))", (Jsonb(geometry),)
                )
                if valid is None or valid[0] is not True:
                    raise ResourceSearchInvalid("invalid intersects geometry topology")
                where += (
                    " AND version.spatial_extent IS NOT NULL AND ST_Intersects("
                    + _record_extent_sql()
                    + ", ST_SetSRID(ST_GeomFromGeoJSON(%s::text),4326))"
                )
                parameters = (*parameters, Jsonb(geometry))
            count_row = await transaction.fetch_one(
                f"""
                SELECT count(*)::bigint
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                {where}
                """,
                parameters,
            )
            number_matched = cast(int, count_row[0]) if count_row is not None else 0
            include_metadata = filters.stac_items or filters.stac_collections
            record_select = self._summary_select().replace(
                "resource.created_at, resource.updated_at",
                "resource.created_at, resource.updated_at, version.localized_metadata"
                + (", version.metadata_extensions" if include_metadata else ""),
            )
            rows = await transaction.fetch_all(
                f"""{record_select}
                {where}
                ORDER BY lower(version.title), resource.id
                LIMIT %s OFFSET %s
                """,
                (*parameters, filters.limit, filters.offset),
            )
            resource_ids = [cast(UUID, row[0]) for row in rows]
            external_rows = (
                await transaction.fetch_all(
                    """
                    SELECT resource_id, namespace, identifier, source_url,
                           source_version, source_payload_sha256, imported_at
                    FROM app.governed_resource_external_identifiers
                    WHERE organization_id = %s AND resource_id = ANY(%s::uuid[])
                    ORDER BY resource_id, namespace, identifier
                    """,
                    (context.organization_id, resource_ids),
                )
                if resource_ids
                else []
            )
            external_by_resource: dict[UUID, list[ResourceExternalIdentifier]] = {}
            for item in external_rows:
                external_by_resource.setdefault(cast(UUID, item[0]), []).append(
                    ResourceExternalIdentifier(
                        namespace=cast(str, item[1]),
                        identifier=cast(str, item[2]),
                        source_url=cast(str, item[3]),
                        source_version=cast(str, item[4]),
                        source_payload_sha256=cast(str, item[5]),
                        imported_at=cast(datetime, item[6]),
                    )
                )
            return RecordResourcePage(
                resources=tuple(
                    RecordResource(
                        summary=self._summary(row[:24]),
                        metadata_extensions=(
                            cast(dict[str, Any], row[25]) if include_metadata else {}
                        ),
                        translations=cast(dict[str, dict[str, Any]], row[24]),
                        external_identifiers=tuple(
                            external_by_resource.get(cast(UUID, row[0]), [])
                        ),
                    )
                    for row in rows
                ),
                number_matched=number_matched,
            )

        return await self._run(context, operation)

    async def import_metadata_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        plan: MetadataResourceImportPlan,
        request_id: str,
    ) -> MetadataResourceImportResult:
        source_bytes = (
            plan.source_document.encode("utf-8")
            if isinstance(plan.source_document, str)
            else canonical_json_bytes(plan.source_document)
        )
        if sha256(source_bytes).hexdigest() != plan.source_sha256:
            raise ResourceConflict("metadata_source_checksum_mismatch")
        if len(source_bytes) > 49_152:
            raise ResourceConflict("metadata_source_document_too_large")
        report_bytes = canonical_metadata_json(plan.conversion_report)
        if len(report_bytes) > 16_384:
            raise ResourceConflict("metadata_conversion_report_too_large")

        async def operation(transaction: TenantTransaction) -> MetadataResourceImportResult:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.RESOURCE_CREATE, roles)
            lock_key = ":".join(
                (
                    str(context.organization_id),
                    plan.source_format,
                    plan.source_namespace,
                    plan.source_identifier,
                )
            )
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (lock_key,),
            )
            existing = await transaction.fetch_one(
                """
                SELECT source.id, source.resource_id, source.resource_version_id,
                       source.source_version, source.checksum_sha256,
                       resource.project_id, resource.slug, version.metadata_profile,
                       version.metadata_profile_id, managed.version_number
                FROM app.governed_metadata_source_documents source
                JOIN app.governed_resources resource
                  ON resource.organization_id = source.organization_id
                 AND resource.id = source.resource_id
                JOIN app.governed_resource_versions version
                  ON version.organization_id = source.organization_id
                 AND version.resource_id = source.resource_id
                 AND version.id = source.resource_version_id
                LEFT JOIN app.metadata_profile_versions managed
                  ON managed.organization_id = version.organization_id
                 AND managed.id = version.metadata_profile_version_id
                WHERE source.organization_id = %s
                  AND source.source_format = %s::app.metadata_source_format
                  AND source.source_namespace = %s
                  AND source.source_identifier = %s
                FOR UPDATE OF resource
                """,
                (
                    context.organization_id,
                    plan.source_format,
                    plan.source_namespace,
                    plan.source_identifier,
                ),
            )
            if existing is not None:
                if (
                    existing[3] != plan.source_version
                    or existing[4] != plan.source_sha256
                    or existing[5] != project_id
                    or existing[6] != plan.draft.slug
                    or existing[7] != plan.draft.metadata.profile
                    or existing[8] != plan.draft.metadata.managed_profile_id
                    or existing[9] != plan.draft.metadata.managed_profile_version
                ):
                    raise ResourceConflict("metadata_source_identifier_collision")
                resource_id = cast(UUID, existing[1])
                resource = await self._load_resource(transaction, context, project_id, resource_id)
                source = await self._load_metadata_source(
                    transaction,
                    context,
                    resource_id,
                    cast(UUID, existing[2]),
                )
                return MetadataResourceImportResult(resource, source, True)

            resource_id = uuid4()
            version_id = uuid4()
            source_id = uuid4()
            await self._insert_resource(
                transaction,
                context,
                project_id,
                resource_id,
                version_id,
                plan.draft,
            )
            await transaction.execute(
                """
                INSERT INTO app.governed_metadata_source_documents
                  (id, organization_id, resource_id, resource_version_id,
                   source_format, source_version, source_namespace,
                   source_identifier, document, checksum_sha256,
                   conversion_report, imported_by)
                VALUES (%s, %s, %s, %s, %s::app.metadata_source_format, %s, %s,
                        %s, %s, %s, %s, %s)
                """,
                (
                    source_id,
                    context.organization_id,
                    resource_id,
                    version_id,
                    plan.source_format,
                    plan.source_version,
                    plan.source_namespace,
                    plan.source_identifier,
                    source_bytes.decode("utf-8"),
                    plan.source_sha256,
                    Jsonb(plan.conversion_report),
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.metadata.imported",
                resource_id,
                request_id,
                {
                    "sourceFormat": plan.source_format,
                    "sourceVersion": plan.source_version,
                    "sourceNamespace": plan.source_namespace,
                    "sourceIdentifier": plan.source_identifier,
                    "sourceSha256": plan.source_sha256,
                    "resourceVersion": 1,
                },
                resource_type="metadata_source_document",
            )
            resource = await self._load_resource(transaction, context, project_id, resource_id)
            source = await self._load_metadata_source(transaction, context, resource_id, version_id)
            return MetadataResourceImportResult(resource, source, False)

        return await self._run(context, operation)

    async def get_metadata_source(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> MetadataSourceDocument:
        async def operation(transaction: TenantTransaction) -> MetadataSourceDocument:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            source_version = await transaction.fetch_one(
                """
                SELECT source.resource_version_id
                FROM app.governed_metadata_source_documents source
                JOIN app.governed_resources resource
                  ON resource.organization_id = source.organization_id
                 AND resource.id = source.resource_id
                WHERE source.organization_id = %s AND resource.project_id = %s
                  AND source.resource_id = %s
                ORDER BY source.imported_at DESC, source.id DESC
                LIMIT 1
                """,
                (context.organization_id, project_id, resource_id),
            )
            if source_version is None:
                raise ResourceNotFound("metadata_source")
            return await self._load_metadata_source(
                transaction, context, resource_id, cast(UUID, source_version[0])
            )

        return await self._run(context, operation)

    async def get_resource(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> GovernedResource:
        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def get_record_version(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, version: int
    ) -> RecordResource:
        async def operation(transaction: TenantTransaction) -> RecordResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            statement = (
                self._summary_select()
                .replace(
                    "resource.created_at, resource.updated_at",
                    "resource.created_at, resource.updated_at, version.localized_metadata, "
                    "version.metadata_extensions",
                )
                .replace(
                    "AND version.id = resource.current_version_id",
                    "AND version.version_number = %s",
                )
            )
            row = await transaction.fetch_one(
                statement + " WHERE resource.organization_id = %s AND resource.project_id = %s"
                " AND resource.id = %s AND resource.kind::text IN ('dataset','service')"
                " AND resource.state::text <> 'archived'",
                (version, context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise ResourceNotFound("resource_version")
            return RecordResource(
                summary=self._summary(row[:24]),
                translations=cast(dict[str, dict[str, Any]], row[24]),
                metadata_extensions=cast(dict[str, Any], row[25]),
                external_identifiers=(),
            )

        return await self._run(context, operation)

    async def create_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: ResourceDraft,
        request_id: str,
    ) -> GovernedResource:
        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.RESOURCE_CREATE, roles)
            resource_id = await self._create_resource(
                transaction, context, project_id, draft, request_id
            )
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def _create_resource(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        draft: ResourceDraft,
        request_id: str,
    ) -> UUID:
        """Create within a caller's transaction after its RESOURCE_CREATE authorization."""
        resource_id = uuid4()
        version_id = uuid4()
        await self._validate_binding(transaction, context, project_id, draft)
        await self._insert_resource(
            transaction, context, project_id, resource_id, version_id, draft
        )
        await self._record_event(
            transaction,
            context,
            project_id,
            "resource.created",
            resource_id,
            request_id,
            {"kind": draft.kind, "version": 1},
        )
        return resource_id

    async def update_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        update: ResourceUpdate,
        request_id: str,
    ) -> GovernedResource:
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT version.version_number, resource.state::text, resource.kind::text,
                       resource.map_id
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR UPDATE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if current is None:
                raise ResourceNotFound("resource")
            current_version = cast(int, current[0])
            if cast(str, current[2]) in {"document", "story", "dashboard"}:
                raise ResourceConflict("page_source_version_required")
            if current_version != update.expected_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)
            kind = cast(ResourceKind, current[2])
            if update.expected_map_version is not None:
                if kind != "map" or current[3] is None:
                    raise ResourceConflict("resource_binding_kind_mismatch")
                if current[1] not in {"draft", "review"}:
                    raise ResourceConflict("map_resource_revision_requires_draft")
            next_version = current_version + 1
            await self._insert_version(
                transaction,
                context,
                resource_id,
                version_id,
                next_version,
                update.metadata,
                update.content,
                update.provenance,
                update.change_message,
            )
            if kind == "map" and current[3] is not None:
                await self._bind_map_snapshot(
                    transaction, resource_id, version_id, update.expected_map_version
                )
            await transaction.execute(
                """
                UPDATE app.governed_resources
                SET current_version_id = %s,
                    visibility = %s::app.governed_resource_visibility,
                    updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    version_id,
                    update.visibility,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.version.created",
                resource_id,
                request_id,
                {
                    "version": next_version,
                    "state": cast(str, current[1]),
                    **(
                        {"map_version": update.expected_map_version}
                        if update.expected_map_version is not None
                        else {}
                    ),
                },
            )
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def add_relationship(
        self,
        context: TenantContext,
        project_id: UUID,
        source_resource_id: UUID,
        target_resource_id: UUID,
        relation: ResourceRelation,
        request_id: str,
    ) -> GovernedResource:
        if source_resource_id == target_resource_id:
            raise ResourceConflict("resource_relationship_self_reference")
        relationship_id = uuid4()

        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, source_resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            rows = await transaction.fetch_all(
                """
                SELECT id FROM app.governed_resources
                WHERE organization_id = %s AND project_id = %s AND id IN (%s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    source_resource_id,
                    target_resource_id,
                ),
            )
            if len(rows) != 2:
                raise ResourceNotFound("resource")
            await transaction.execute(
                """
                INSERT INTO app.governed_resource_relationships
                  (id, organization_id, project_id, source_resource_id,
                   target_resource_id, relation, created_by)
                VALUES (%s, %s, %s, %s, %s, %s::app.governed_resource_relation, %s)
                """,
                (
                    relationship_id,
                    context.organization_id,
                    project_id,
                    source_resource_id,
                    target_resource_id,
                    relation,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.relationship.created",
                relationship_id,
                request_id,
                {
                    "sourceResourceId": str(source_resource_id),
                    "targetResourceId": str(target_resource_id),
                    "relation": relation,
                },
                resource_type="resource_relationship",
            )
            return await self._load_resource(transaction, context, project_id, source_resource_id)

        return await self._run(context, operation)

    async def bind_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        dataset_id: UUID | None,
        map_id: UUID | None,
        request_id: str,
    ) -> GovernedResource:
        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            row = await transaction.fetch_one(
                """
                SELECT resource.kind::text, resource.dataset_id, resource.map_id,
                       version.version_number
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR UPDATE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise ResourceNotFound("resource")
            current_version = cast(int, row[3])
            if current_version != expected_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)
            kind = cast(ResourceKind, row[0])
            if dataset_id is not None and kind not in {"dataset", "service"}:
                raise ResourceConflict("resource_binding_kind_mismatch")
            if map_id is not None and kind != "map":
                raise ResourceConflict("resource_binding_kind_mismatch")
            if row[1] is not None or row[2] is not None:
                if row[1] == dataset_id and row[2] == map_id:
                    return await self._load_resource(transaction, context, project_id, resource_id)
                raise ResourceConflict("resource_already_bound")
            await self._validate_binding_ids(transaction, context, project_id, dataset_id, map_id)
            await transaction.execute(
                """
                UPDATE app.governed_resources
                SET dataset_id = %s, map_id = %s, updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    dataset_id,
                    map_id,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.bound",
                resource_id,
                request_id,
                {
                    "datasetId": str(dataset_id) if dataset_id else None,
                    "mapId": str(map_id) if map_id else None,
                    "version": current_version,
                },
            )
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def transition_resource(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        target_state: ResourceState,
        visibility: ResourceVisibility | None,
        reason: str | None,
        request_id: str,
    ) -> GovernedResource:
        event_id = uuid4()

        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            action = (
                Action.RESOURCE_PUBLISH
                if target_state in {"published", "archived"}
                else Action.RESOURCE_UPDATE
            )
            self._require(action, roles)
            row = await transaction.fetch_one(
                """
                SELECT resource.state::text, resource.visibility::text,
                       version.version_number
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR UPDATE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise ResourceNotFound("resource")
            current_version = cast(int, row[2])
            if current_version != expected_version:
                raise ResourceConflict("resource_version_conflict", current_version=current_version)
            source_state = cast(ResourceState, row[0])
            allowed = {
                "draft": {"review", "archived"},
                "review": {"published", "archived"},
                "published": {"archived"},
            }
            if target_state not in allowed.get(source_state, set()):
                raise ResourceConflict("invalid_resource_state_transition")
            if target_state == "published" and visibility not in {"organization", "public"}:
                raise ResourceConflict("published_resource_visibility_required")
            if target_state != "published" and visibility is not None:
                raise ResourceConflict("resource_transition_visibility_not_allowed")
            next_visibility = visibility or cast(ResourceVisibility, row[1])
            await transaction.execute(
                """
                UPDATE app.governed_resources
                SET state = %s::app.governed_resource_state,
                    visibility = %s::app.governed_resource_visibility,
                    updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    target_state,
                    next_visibility,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.governed_resource_workflow_events
                  (id, organization_id, project_id, resource_id, source_state,
                   target_state, reason, actor_user_id)
                VALUES (%s, %s, %s, %s, %s::app.governed_resource_state,
                        %s::app.governed_resource_state, %s, %s)
                """,
                (
                    event_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    source_state,
                    target_state,
                    reason,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                f"resource.{target_state}",
                resource_id,
                request_id,
                {
                    "sourceState": source_state,
                    "targetState": target_state,
                    "visibility": next_visibility,
                    "version": current_version,
                },
            )
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def set_publication_visibility(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        expected_version: int,
        expected_visibility: ResourceVisibility,
        visibility: ResourceVisibility,
        request_id: str,
    ) -> GovernedResource:
        """Change current published audience without rewriting content or editions."""

        async def operation(transaction: TenantTransaction) -> GovernedResource:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_PUBLISH, roles)
            row = await transaction.fetch_one(
                """
                SELECT resource.state::text, resource.visibility::text,
                       version.version_number
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                FOR UPDATE OF resource
                """,
                (context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise ResourceNotFound("resource")
            if row[2] != expected_version:
                raise ResourceConflict("resource_version_conflict", current_version=row[2])
            if row[0] != "published":
                raise ResourceConflict("resource_publication_visibility_requires_published")
            if row[1] != expected_visibility:
                raise ResourceConflict("resource_visibility_conflict")
            if visibility not in {"organization", "public"}:
                raise ResourceConflict("published_resource_visibility_required")
            if row[1] == visibility:
                return await self._load_resource(transaction, context, project_id, resource_id)
            await transaction.execute(
                """
                UPDATE app.governed_resources
                SET visibility = %s::app.governed_resource_visibility, updated_by = %s
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (visibility, context.user_id, context.organization_id, project_id, resource_id),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.publication_visibility.changed",
                resource_id,
                request_id,
                {"previousVisibility": row[1], "visibility": visibility, "version": row[2]},
            )
            return await self._load_resource(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def get_capabilities(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> ResourceCapabilities:
        async def operation(transaction: TenantTransaction) -> ResourceCapabilities:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            return ResourceCapabilities(
                can_read=True,
                can_update=is_allowed(Action.RESOURCE_UPDATE, roles),
                can_publish=is_allowed(Action.RESOURCE_PUBLISH, roles),
                can_manage_permissions=is_allowed(Action.RESOURCE_PERMISSIONS_MANAGE, roles),
            )

        return await self._run(context, operation)

    async def list_permissions(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[ResourcePermission]:
        async def operation(transaction: TenantTransaction) -> list[ResourcePermission]:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_PERMISSIONS_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT permission.user_id, identity.email, identity.display_name,
                       permission.role::text, permission.granted_by,
                       permission.created_at, permission.updated_at
                FROM app.governed_resource_permissions permission
                JOIN app.users identity ON identity.id = permission.user_id
                WHERE permission.organization_id = %s
                  AND permission.resource_id = %s
                ORDER BY lower(identity.display_name), identity.id
                """,
                (context.organization_id, resource_id),
            )
            return [self._permission(row) for row in rows]

        return await self._run(context, operation)

    async def put_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        grant: ResourcePermissionGrant,
        request_id: str,
    ) -> ResourcePermission:
        async def operation(transaction: TenantTransaction) -> ResourcePermission:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_PERMISSIONS_MANAGE, roles)
            member = await transaction.fetch_one(
                """
                SELECT identity.email, identity.display_name
                FROM app.organization_memberships membership
                JOIN app.users identity ON identity.id = membership.user_id
                WHERE membership.organization_id = %s AND membership.user_id = %s
                """,
                (context.organization_id, grant.user_id),
            )
            if member is None:
                raise ResourceNotFound("organization_member")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.governed_resource_permissions
                  (organization_id, resource_id, user_id, role, granted_by)
                VALUES (%s, %s, %s, %s::app.governed_resource_permission_role, %s)
                ON CONFLICT (organization_id, resource_id, user_id)
                DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by
                RETURNING role::text, granted_by, created_at, updated_at
                """,
                (
                    context.organization_id,
                    resource_id,
                    grant.user_id,
                    grant.role,
                    context.user_id,
                ),
            )
            if row is None:
                raise ResourceStoreUnavailable("permission upsert returned no row")
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.permission.granted",
                resource_id,
                request_id,
                {"userId": str(grant.user_id), "role": grant.role},
            )
            return ResourcePermission(
                user_id=grant.user_id,
                email=cast(str, member[0]),
                display_name=cast(str, member[1]),
                role=cast(ResourcePermissionRole, row[0]),
                granted_by=cast(UUID, row[1]),
                created_at=cast(datetime, row[2]),
                updated_at=cast(datetime, row[3]),
            )

        return await self._run(context, operation)

    async def delete_permission(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_PERMISSIONS_MANAGE, roles)
            deleted = await transaction.fetch_one(
                """
                DELETE FROM app.governed_resource_permissions
                WHERE organization_id = %s AND resource_id = %s AND user_id = %s
                RETURNING 1
                """,
                (context.organization_id, resource_id, user_id),
            )
            if deleted is None:
                raise ResourceNotFound("resource_permission")
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.permission.revoked",
                resource_id,
                request_id,
                {"userId": str(user_id)},
            )

        await self._run(context, operation)

    async def list_styles(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        *,
        include_archived: bool = False,
    ) -> list[ResourceStyle]:
        async def operation(transaction: TenantTransaction) -> list[ResourceStyle]:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._style_select()}
                WHERE style.organization_id = %s
                  AND style.project_id = %s
                  AND style.resource_id = %s
                  AND (%s OR style.archived_at IS NULL)
                ORDER BY style.slug, style.id
                """,
                (context.organization_id, project_id, resource_id, include_archived),
            )
            return [self._style(row) for row in rows]

        return await self._run(context, operation)

    async def get_style_version(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        version_number: int,
    ) -> ResourceStyle:
        async def operation(transaction: TenantTransaction) -> ResourceStyle:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            row = await transaction.fetch_one(
                f"""{self._style_select(current=False)}
                WHERE style.organization_id = %s
                  AND style.project_id = %s
                  AND style.resource_id = %s
                  AND style.id = %s
                  AND version.version_number = %s
                """,
                (context.organization_id, project_id, resource_id, style_id, version_number),
            )
            if row is None:
                raise ResourceNotFound("resource_style_version_not_found")
            return self._style(row)

        return await self._run(context, operation)

    async def create_style(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: ResourceStyleDraft,
        request_id: str,
    ) -> ResourceStyle:
        style_id = uuid4()
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ResourceStyle:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            self._verify_style_checksum(draft.definition, draft.checksum_sha256)
            await transaction.execute(
                """
                INSERT INTO app.governed_resource_styles
                  (id, organization_id, project_id, resource_id, slug, format,
                   current_version_id, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s::app.governed_style_format,
                        %s, %s, %s)
                """,
                (
                    style_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    draft.slug,
                    draft.format,
                    version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await self._insert_style_version(
                transaction,
                context,
                style_id,
                version_id,
                1,
                draft.title,
                draft.media_type,
                draft.definition,
                draft.checksum_sha256,
                None,
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.style.created",
                style_id,
                request_id,
                {"resourceId": str(resource_id), "format": draft.format, "version": 1},
                resource_type="governed_resource_style",
            )
            return await self._load_style(transaction, context, project_id, resource_id, style_id)

        return await self._run(context, operation)

    async def update_style(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        update: ResourceStyleUpdate,
        request_id: str,
    ) -> ResourceStyle:
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> ResourceStyle:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            self._verify_style_checksum(update.definition, update.checksum_sha256)
            current = await transaction.fetch_one(
                """
                SELECT version.version_number, style.format::text,
                       style.archived_at IS NOT NULL
                FROM app.governed_resource_styles style
                JOIN app.governed_resource_style_versions version
                  ON version.organization_id = style.organization_id
                 AND version.style_id = style.id
                 AND version.id = style.current_version_id
                WHERE style.organization_id = %s AND style.project_id = %s
                  AND style.resource_id = %s AND style.id = %s
                FOR UPDATE OF style
                """,
                (context.organization_id, project_id, resource_id, style_id),
            )
            if current is None:
                raise ResourceNotFound("resource_style")
            current_version = cast(int, current[0])
            if current_version != update.expected_version:
                raise ResourceConflict(
                    "resource_style_version_conflict", current_version=current_version
                )
            if current[2]:
                raise ResourceConflict("resource_style_archived")
            if current[1] != update.format:
                raise ResourceConflict("resource_style_format_immutable")
            next_version = current_version + 1
            await self._insert_style_version(
                transaction,
                context,
                style_id,
                version_id,
                next_version,
                update.title,
                update.media_type,
                update.definition,
                update.checksum_sha256,
                update.change_message,
            )
            await transaction.execute(
                """
                UPDATE app.governed_resource_styles
                SET current_version_id = %s, updated_by = %s
                WHERE organization_id = %s AND project_id = %s
                  AND resource_id = %s AND id = %s
                """,
                (
                    version_id,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    style_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.style.version.created",
                style_id,
                request_id,
                {"resourceId": str(resource_id), "version": next_version},
                resource_type="governed_resource_style",
            )
            return await self._load_style(transaction, context, project_id, resource_id, style_id)

        return await self._run(context, operation)

    async def set_style_archived(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
        expected_version: int,
        archived: bool,
        request_id: str,
    ) -> ResourceStyle:
        """Serialize reversible head changes without changing definition revisions.

        Same-state retries are idempotent. Opposing commands serialize; the expected
        version protects against newer definitions, not intervening lifecycle commands.
        """

        async def operation(transaction: TenantTransaction) -> ResourceStyle:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_UPDATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT version.version_number, style.archived_at IS NOT NULL
                FROM app.governed_resource_styles style
                JOIN app.governed_resource_style_versions version
                  ON version.organization_id = style.organization_id
                 AND version.style_id = style.id
                 AND version.id = style.current_version_id
                WHERE style.organization_id = %s AND style.project_id = %s
                  AND style.resource_id = %s AND style.id = %s
                FOR UPDATE OF style
                """,
                (context.organization_id, project_id, resource_id, style_id),
            )
            if current is None:
                raise ResourceNotFound("resource_style")
            if current[0] != expected_version:
                raise ResourceConflict(
                    "resource_style_version_conflict", current_version=current[0]
                )
            if current[1] != archived:
                await transaction.execute(
                    """
                    UPDATE app.governed_resource_styles
                    SET archived_at = CASE WHEN %s THEN clock_timestamp() ELSE NULL END,
                        archived_by = CASE WHEN %s THEN %s::uuid ELSE NULL END,
                        updated_by = %s
                    WHERE organization_id = %s AND project_id = %s
                      AND resource_id = %s AND id = %s
                    """,
                    (
                        archived,
                        archived,
                        context.user_id,
                        context.user_id,
                        context.organization_id,
                        project_id,
                        resource_id,
                        style_id,
                    ),
                )
                await self._record_event(
                    transaction,
                    context,
                    project_id,
                    "resource.style.archived" if archived else "resource.style.restored",
                    style_id,
                    request_id,
                    {"resourceId": str(resource_id), "version": expected_version},
                    resource_type="governed_resource_style",
                )
            return await self._load_style(transaction, context, project_id, resource_id, style_id)

        return await self._run(context, operation)

    async def list_workflow_events(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[ResourceWorkflowEvent]:
        async def operation(transaction: TenantTransaction) -> list[ResourceWorkflowEvent]:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require(Action.RESOURCE_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT id, source_state::text, target_state::text, reason,
                       actor_user_id, created_at
                FROM app.governed_resource_workflow_events
                WHERE organization_id = %s AND project_id = %s AND resource_id = %s
                ORDER BY created_at, id
                """,
                (context.organization_id, project_id, resource_id),
            )
            return [
                ResourceWorkflowEvent(
                    event_id=cast(UUID, row[0]),
                    source_state=cast(ResourceState, row[1]),
                    target_state=cast(ResourceState, row[2]),
                    reason=cast(str | None, row[3]),
                    actor_user_id=cast(UUID, row[4]),
                    created_at=cast(datetime, row[5]),
                )
                for row in rows
            ]

        return await self._run(context, operation)

    async def import_resources(
        self,
        context: TenantContext,
        project_id: UUID,
        plan: ResourceImportPlan,
        request_id: str,
    ) -> ResourceImportResult:
        async def operation(transaction: TenantTransaction) -> ResourceImportResult:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.RESOURCE_CREATE, roles)
            resolved: dict[str, UUID] = {}
            existing_count = 0
            for candidate in plan.resources:
                existing = await transaction.fetch_one(
                    """
                    SELECT identifier.resource_id, identifier.source_url,
                           identifier.source_version, identifier.source_payload_sha256,
                           resource.project_id
                    FROM app.governed_resource_external_identifiers identifier
                    JOIN app.governed_resources resource
                      ON resource.organization_id = identifier.organization_id
                     AND resource.id = identifier.resource_id
                    WHERE identifier.organization_id = %s
                      AND identifier.namespace = %s
                      AND identifier.identifier = %s
                    FOR UPDATE OF resource
                    """,
                    (context.organization_id, plan.namespace, candidate.identifier),
                )
                if existing is None:
                    continue
                if (
                    existing[1] != plan.source_url
                    or existing[2] != plan.source_version
                    or existing[3] != candidate.source_payload_sha256
                    or existing[4] != project_id
                ):
                    raise ResourceConflict("external_resource_identifier_collision")
                resolved[candidate.identifier] = cast(UUID, existing[0])
                existing_count += 1

            for candidate in plan.resources:
                if candidate.identifier in resolved:
                    continue
                resource_id = uuid4()
                version_id = uuid4()
                await self._insert_resource(
                    transaction,
                    context,
                    project_id,
                    resource_id,
                    version_id,
                    candidate.draft,
                )
                await transaction.execute(
                    """
                    INSERT INTO app.governed_resource_external_identifiers
                      (organization_id, resource_id, namespace, identifier,
                       source_url, source_version, source_payload_sha256, imported_by)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        context.organization_id,
                        resource_id,
                        plan.namespace,
                        candidate.identifier,
                        plan.source_url,
                        plan.source_version,
                        candidate.source_payload_sha256,
                        context.user_id,
                    ),
                )
                resolved[candidate.identifier] = resource_id

            for relationship in plan.relationships:
                source_id = resolved.get(relationship.source_identifier)
                target_id = resolved.get(relationship.target_identifier)
                if source_id is None or target_id is None:
                    raise ResourceConflict("external_resource_relationship_unresolved")
                await transaction.execute(
                    """
                    INSERT INTO app.governed_resource_relationships
                      (id, organization_id, project_id, source_resource_id,
                       target_resource_id, relation, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s::app.governed_resource_relation, %s)
                    ON CONFLICT (
                      organization_id, project_id, source_resource_id,
                      target_resource_id, relation
                    ) DO NOTHING
                    """,
                    (
                        uuid4(),
                        context.organization_id,
                        project_id,
                        source_id,
                        target_id,
                        relationship.relation,
                        context.user_id,
                    ),
                )

            await self._record_event(
                transaction,
                context,
                project_id,
                "resource.geonode.imported",
                project_id,
                request_id,
                {
                    "sourceVersion": plan.source_version,
                    "resourceCount": len(plan.resources),
                    "relationshipCount": len(plan.relationships),
                    "idempotent": existing_count == len(plan.resources),
                },
                resource_type="resource_import",
            )
            resources = tuple(
                [
                    await self._load_resource(
                        transaction, context, project_id, resolved[candidate.identifier]
                    )
                    for candidate in plan.resources
                ]
            )
            return ResourceImportResult(
                resources=resources,
                report=plan.report,
                idempotent=existing_count == len(plan.resources),
            )

        return await self._run(context, operation)

    async def _insert_resource(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_id: UUID,
        draft: ResourceDraft,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.governed_resources
              (id, organization_id, project_id, kind, slug, dataset_id, map_id,
               visibility, state, current_version_id, owner_user_id,
               created_by, updated_by)
            VALUES (%s, %s, %s, %s::app.governed_resource_kind, %s, %s, %s,
                    %s::app.governed_resource_visibility,
                    %s::app.governed_resource_state, %s, %s, %s, %s)
            """,
            (
                resource_id,
                context.organization_id,
                project_id,
                draft.kind,
                draft.slug,
                draft.dataset_id,
                draft.map_id,
                draft.visibility,
                draft.state,
                version_id,
                context.user_id,
                context.user_id,
                context.user_id,
            ),
        )
        await self._insert_version(
            transaction,
            context,
            resource_id,
            version_id,
            1,
            draft.metadata,
            draft.content,
            draft.provenance,
            None,
        )
        if draft.kind == "map" and draft.map_id is not None:
            await self._bind_map_snapshot(
                transaction, resource_id, version_id, draft.expected_map_version
            )

    @staticmethod
    async def _bind_map_snapshot(
        transaction: TenantTransaction,
        resource_id: UUID,
        version_id: UUID,
        expected_map_version: int | None,
    ) -> None:
        if expected_map_version is not None and (
            type(expected_map_version) is not int
            or not 1 <= expected_map_version <= 9_007_199_254_740_991
        ):
            raise ResourceConflict("map_version_conflict")
        bound = await transaction.fetch_one(
            "SELECT app.bind_map_resource_version(%s, %s, %s)",
            (resource_id, version_id, expected_map_version),
        )
        if bound is None or bound[0] is not True:
            raise ResourceConflict(
                "map_version_conflict"
                if expected_map_version is not None
                else "map_resource_snapshot_required"
            )

    @classmethod
    async def _insert_version(
        cls,
        transaction: TenantTransaction,
        context: TenantContext,
        resource_id: UUID,
        version_id: UUID,
        version_number: int,
        metadata: ResourceMetadata,
        content: dict[str, Any],
        provenance: dict[str, Any],
        change_message: str | None,
    ) -> None:
        (
            managed_profile_id,
            managed_profile_version_id,
            validation,
        ) = await cls._resolve_managed_metadata(transaction, context, metadata)
        await transaction.execute(
            """
            INSERT INTO app.governed_resource_versions
              (id, organization_id, resource_id, version_number, title, abstract,
               language, license, attribution, keywords, spatial_extent,
               temporal_start, temporal_end, metadata_profile,
               metadata_extensions, localized_metadata, content, provenance,
               change_message, created_by,
               metadata_profile_id, metadata_profile_version_id, metadata_validation)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                resource_id,
                version_number,
                metadata.title,
                metadata.abstract,
                metadata.language,
                metadata.license,
                metadata.attribution,
                list(metadata.keywords),
                Jsonb(list(metadata.spatial_extent))
                if metadata.spatial_extent is not None
                else None,
                metadata.temporal_start,
                metadata.temporal_end,
                metadata.profile,
                Jsonb(metadata.extensions),
                Jsonb(metadata.translations),
                Jsonb(content),
                Jsonb(provenance),
                change_message,
                context.user_id,
                managed_profile_id,
                managed_profile_version_id,
                Jsonb(validation) if validation is not None else None,
            ),
        )

    @staticmethod
    async def _resolve_managed_metadata(
        transaction: TenantTransaction,
        context: TenantContext,
        metadata: ResourceMetadata,
    ) -> tuple[UUID | None, UUID | None, dict[str, Any] | None]:
        if metadata.managed_profile_id is None:
            return None, None, None
        row = await transaction.fetch_one(
            """
            SELECT profile.slug, version.id, version.version_number, version.definition
            FROM app.metadata_profiles profile
            JOIN app.metadata_profile_versions version
              ON version.organization_id = profile.organization_id
             AND version.profile_id = profile.id
             AND version.id = profile.current_version_id
            WHERE profile.organization_id = %s AND profile.id = %s
            FOR SHARE OF profile
            """,
            (context.organization_id, metadata.managed_profile_id),
        )
        if row is None:
            raise ResourceNotFound("metadata_profile")
        profile_slug = cast(str, row[0])
        profile_version_id = cast(UUID, row[1])
        current_version = cast(int, row[2])
        if metadata.managed_profile_version != current_version:
            raise ResourceConflict(
                "metadata_profile_version_conflict", current_version=current_version
            )
        if metadata.profile != profile_slug:
            raise ResourceMetadataInvalid(
                {
                    "schemaVersion": "1.0.0",
                    "status": "invalid",
                    "errors": 1,
                    "warnings": 0,
                    "issues": [
                        {
                            "severity": "error",
                            "path": "profile",
                            "code": "metadata_profile_slug_mismatch",
                            "message": "profile must match the selected managed profile slug",
                        }
                    ],
                }
            )
        report = validate_metadata_document(
            {
                "title": metadata.title,
                "abstract": metadata.abstract,
                "language": metadata.language,
                "license": metadata.license,
                "attribution": metadata.attribution,
                "keywords": list(metadata.keywords),
                "spatial_extent": list(metadata.spatial_extent)
                if metadata.spatial_extent is not None
                else None,
                "temporal_start": metadata.temporal_start.isoformat()
                if metadata.temporal_start is not None
                else None,
                "temporal_end": metadata.temporal_end.isoformat()
                if metadata.temporal_end is not None
                else None,
                "extensions": metadata.extensions,
                "translations": metadata.translations,
            },
            cast(dict[str, Any], row[3]),
        )
        if report["status"] != "valid":
            raise ResourceMetadataInvalid(report)
        return metadata.managed_profile_id, profile_version_id, report

    @staticmethod
    async def _insert_style_version(
        transaction: TenantTransaction,
        context: TenantContext,
        style_id: UUID,
        version_id: UUID,
        version_number: int,
        title: str,
        media_type: str,
        definition: str,
        checksum_sha256: str,
        change_message: str | None,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.governed_resource_style_versions
              (id, organization_id, style_id, version_number, title, media_type,
               definition, checksum_sha256, change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                style_id,
                version_number,
                title,
                media_type,
                definition,
                checksum_sha256,
                change_message,
                context.user_id,
            ),
        )

    async def _load_resource(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> GovernedResource:
        row = await transaction.fetch_one(
            f"""{self._detail_select()}
            WHERE resource.organization_id = %s
              AND resource.project_id = %s
              AND resource.id = %s
            """,
            (context.organization_id, project_id, resource_id),
        )
        if row is None:
            raise ResourceNotFound("resource")
        map_snapshot = None
        if row[2] == "map" and row[5] is not None:
            snapshot = await transaction.fetch_one(
                """
                SELECT binding.map_id, map_version.id, binding.map_version,
                       map_version.definition
                FROM app.governed_resources resource
                JOIN app.map_resource_version_bindings binding
                  ON binding.organization_id = resource.organization_id
                 AND binding.project_id = resource.project_id
                 AND binding.resource_id = resource.id
                 AND binding.resource_version_id = resource.current_version_id
                JOIN app.map_versions map_version
                  ON map_version.organization_id = binding.organization_id
                 AND map_version.map_id = binding.map_id
                 AND map_version.version = binding.map_version
                WHERE resource.organization_id = %s AND resource.project_id = %s
                  AND resource.id = %s AND resource.map_id = binding.map_id
                """,
                (context.organization_id, project_id, resource_id),
            )
            if snapshot is not None:
                map_snapshot = MapResourceSnapshot(
                    map_id=cast(UUID, snapshot[0]),
                    map_version_id=cast(UUID, snapshot[1]),
                    map_version=cast(int, snapshot[2]),
                    definition_checksum_sha256=sha256(
                        canonical_json_bytes(cast(dict[str, Any], snapshot[3]))
                    ).hexdigest(),
                )
        external_rows = await transaction.fetch_all(
            """
            SELECT namespace, identifier, source_url, source_version,
                   source_payload_sha256, imported_at
            FROM app.governed_resource_external_identifiers
            WHERE organization_id = %s AND resource_id = %s
            ORDER BY namespace, identifier
            """,
            (context.organization_id, resource_id),
        )
        relationship_rows = await transaction.fetch_all(
            """
            SELECT id, source_resource_id, target_resource_id, relation::text,
                   created_by, created_at
            FROM app.governed_resource_relationships
            WHERE organization_id = %s AND project_id = %s
              AND (source_resource_id = %s OR target_resource_id = %s)
            ORDER BY created_at, id
            """,
            (context.organization_id, project_id, resource_id, resource_id),
        )
        return GovernedResource(
            summary=self._summary(row[:24]),
            metadata_profile=cast(str, row[24]),
            metadata_extensions=cast(dict[str, Any], row[25]),
            translations=cast(dict[str, dict[str, Any]], row[26]),
            content=cast(dict[str, Any], row[27]),
            provenance=cast(dict[str, Any], row[28]),
            change_message=cast(str | None, row[29]),
            version_created_by=cast(UUID, row[30]),
            version_created_at=cast(datetime, row[31]),
            external_identifiers=tuple(
                ResourceExternalIdentifier(
                    namespace=cast(str, item[0]),
                    identifier=cast(str, item[1]),
                    source_url=cast(str, item[2]),
                    source_version=cast(str, item[3]),
                    source_payload_sha256=cast(str, item[4]),
                    imported_at=cast(datetime, item[5]),
                )
                for item in external_rows
            ),
            relationships=tuple(
                ResourceRelationship(
                    relationship_id=cast(UUID, item[0]),
                    source_resource_id=cast(UUID, item[1]),
                    target_resource_id=cast(UUID, item[2]),
                    relation=cast(ResourceRelation, item[3]),
                    created_by=cast(UUID, item[4]),
                    created_at=cast(datetime, item[5]),
                )
                for item in relationship_rows
            ),
            managed_metadata_profile_id=cast(UUID | None, row[32]),
            managed_metadata_profile_version=cast(int | None, row[33]),
            metadata_validation=cast(dict[str, Any] | None, row[34]),
            map_snapshot=map_snapshot,
            current_version_id=cast(UUID, row[35]),
        )

    @staticmethod
    async def _load_page_source_intent(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
        *,
        lock: bool,
    ) -> _PageSourceIntent:
        row = await transaction.fetch_one(
            """
            SELECT id, resource_id, expected_resource_version, source_block_id,
                   expected_size_bytes, expected_sha256, bucket, object_key,
                   state::text, expires_at
            FROM app.page_source_upload_intents
            WHERE organization_id = %s AND project_id = %s
              AND resource_id = %s AND id = %s
            """
            + (" FOR UPDATE" if lock else ""),
            (context.organization_id, project_id, resource_id, upload_id),
        )
        if row is None:
            raise ResourceNotFound("page_source_upload")
        return _PageSourceIntent(
            upload_id=cast(UUID, row[0]),
            resource_id=cast(UUID, row[1]),
            expected_resource_version=cast(int, row[2]),
            source_block_id=cast(str, row[3]),
            expected_size_bytes=cast(int, row[4]),
            expected_sha256=cast(str, row[5]),
            bucket=cast(str, row[6]),
            object_key=cast(str, row[7]),
            state=cast(str, row[8]),
            expires_at=cast(datetime, row[9]),
        )

    async def _load_page_source(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None,
    ) -> PageSource:
        row = await transaction.fetch_one(
            f"""{self._page_source_select()}
            WHERE source.organization_id = %s
              AND source.project_id = %s
              AND source.resource_id = %s
              AND (%s::bigint IS NULL OR version.version_number = %s)
            ORDER BY version.version_number DESC
            LIMIT 1
            """,
            (
                context.organization_id,
                project_id,
                resource_id,
                version_number,
                version_number,
            ),
        )
        if row is None:
            raise ResourceNotFound("page_source")
        return self._page_source(row)

    @staticmethod
    async def _load_page_working_draft(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        *,
        lock: bool,
    ) -> PageWorkingDraft | None:
        row = await transaction.fetch_one(
            """
            SELECT head.id, head.resource_id, head.owner_user_id,
                   head.base_resource_version, head.current_revision_number,
                   revision.visibility::text, revision.metadata, revision.content,
                   revision.provenance, revision.source_block_id,
                   revision.source_markdown, revision.change_summary,
                   revision.document_checksum_sha256,
                   head.created_at, head.updated_at
            FROM app.page_working_drafts head
            JOIN app.page_working_draft_revisions revision
              ON revision.organization_id = head.organization_id
             AND revision.draft_id = head.id
             AND revision.revision_number = head.current_revision_number
            WHERE head.organization_id = %s AND head.project_id = %s
              AND head.resource_id = %s AND head.owner_user_id = %s
            """
            + (" FOR UPDATE OF head" if lock else ""),
            (context.organization_id, project_id, resource_id, context.user_id),
        )
        if row is None:
            return None
        return PageWorkingDraft(
            draft_id=cast(UUID, row[0]),
            resource_id=cast(UUID, row[1]),
            owner_user_id=cast(UUID, row[2]),
            base_resource_version=cast(int, row[3]),
            revision_number=cast(int, row[4]),
            visibility=cast(ResourceVisibility, row[5]),
            metadata=cast(dict[str, Any], row[6]),
            content=cast(dict[str, Any], row[7]),
            provenance=cast(dict[str, Any], row[8]),
            source_block_id=cast(str | None, row[9]),
            source_markdown=cast(str, row[10]),
            change_summary=cast(str | None, row[11]),
            document_checksum_sha256=cast(str, row[12]),
            created_at=cast(datetime, row[13]),
            updated_at=cast(datetime, row[14]),
        )

    @staticmethod
    def _page_working_draft_checksum(update: PageWorkingDraftUpdate) -> str:
        return sha256(
            canonical_json_bytes(
                {
                    "visibility": update.visibility,
                    "metadata": update.metadata,
                    "content": update.content,
                    "provenance": update.provenance,
                    "sourceBlockId": update.source_block_id,
                    "sourceMarkdown": update.source_markdown,
                    "changeSummary": update.change_summary,
                }
            )
        ).hexdigest()

    @staticmethod
    def _page_source_select() -> str:
        return """
            SELECT source.id, source.resource_id, source.resource_version_id,
                   version.version_number, source.source_block_id,
                   source.bucket, source.object_key, source.s3_version_id,
                   source.etag, source.content_type, source.size_bytes,
                   source.checksum_sha256, source.dialect,
                   source.dialect_version, source.compiler_version,
                   version.change_message, source.created_by, source.created_at
            FROM app.page_source_objects source
            JOIN app.governed_resource_versions version
              ON version.organization_id = source.organization_id
             AND version.resource_id = source.resource_id
             AND version.id = source.resource_version_id
        """

    @staticmethod
    def _page_source(row: tuple[Any, ...]) -> PageSource:
        version_number = cast(int, row[3])
        change_summary = cast(str | None, row[15])
        if change_summary is None:
            raise ResourceConflict("page_change_summary_missing")
        return PageSource(
            source_id=cast(UUID, row[0]),
            resource_id=cast(UUID, row[1]),
            resource_version_id=cast(UUID, row[2]),
            resource_version_number=version_number,
            parent_version_number=version_number - 1 if version_number > 1 else None,
            source_block_id=cast(str, row[4]),
            bucket=cast(str, row[5]),
            object_key=cast(str, row[6]),
            s3_version_id=cast(str, row[7]),
            etag=cast(str, row[8]),
            content_type=cast(str, row[9]),
            size_bytes=cast(int, row[10]),
            checksum_sha256=cast(str, row[11]),
            dialect=cast(str, row[12]),
            dialect_version=cast(str, row[13]),
            compiler_version=cast(str, row[14]),
            change_summary=change_summary,
            created_by=cast(UUID, row[16]),
            created_at=cast(datetime, row[17]),
        )

    @staticmethod
    def _verify_page_source_content(content: dict[str, Any], intent: _PageSourceIntent) -> None:
        blocks = content.get("blocks")
        if not isinstance(blocks, list):
            raise ResourceConflict("page_source_block_mismatch")
        matching = [
            block
            for block in blocks
            if isinstance(block, dict)
            and block.get("id") == intent.source_block_id
            and block.get("type") == "markdown"
        ]
        if len(matching) != 1 or not isinstance(matching[0].get("markdown"), str):
            raise ResourceConflict("page_source_block_mismatch")
        markdown = cast(str, matching[0]["markdown"])
        encoded = markdown.encode("utf-8")
        if (
            len(encoded) != intent.expected_size_bytes
            or sha256(encoded).hexdigest() != intent.expected_sha256
        ):
            raise ResourceConflict("page_source_block_mismatch")

    @staticmethod
    def _verify_page_source_object(intent: _PageSourceIntent, stored: StoredObject) -> None:
        if (
            stored.bucket != intent.bucket
            or stored.key != intent.object_key
            or stored.content_type != "text/markdown"
            or stored.size_bytes != intent.expected_size_bytes
            or stored.checksum_sha256 != intent.expected_sha256
        ):
            raise ResourceConflict("page_source_upload_verification_failed")

    @staticmethod
    async def _load_metadata_source(
        transaction: TenantTransaction,
        context: TenantContext,
        resource_id: UUID,
        resource_version_id: UUID,
    ) -> MetadataSourceDocument:
        row = await transaction.fetch_one(
            """
            SELECT id, resource_id, resource_version_id, source_format::text,
                   source_version, source_namespace, source_identifier,
                   checksum_sha256, conversion_report, imported_by, imported_at
            FROM app.governed_metadata_source_documents
            WHERE organization_id = %s AND resource_id = %s
              AND resource_version_id = %s
            """,
            (context.organization_id, resource_id, resource_version_id),
        )
        if row is None:
            raise ResourceNotFound("metadata_source")
        document_row = await transaction.fetch_one(
            """
            SELECT document
            FROM app.governed_metadata_source_documents
            WHERE organization_id = %s AND resource_id = %s
              AND resource_version_id = %s
            """,
            (context.organization_id, resource_id, resource_version_id),
        )
        if document_row is None:
            raise ResourceNotFound("metadata_source")
        raw_document = cast(str, document_row[0])
        if row[3] == "iso_19115_3":
            source_document: MetadataSourceValue = raw_document
        else:
            source_document = json.loads(raw_document)
            if not isinstance(source_document, dict):
                raise ResourceConflict("metadata_source_document_invalid")
        return MetadataSourceDocument(
            source_document_id=cast(UUID, row[0]),
            resource_id=cast(UUID, row[1]),
            resource_version_id=cast(UUID, row[2]),
            source_format=cast(MetadataSourceFormat, row[3]),
            source_version=cast(str, row[4]),
            source_namespace=cast(str, row[5]),
            source_identifier=cast(str, row[6]),
            source_document=source_document,
            source_sha256=cast(str, row[7]),
            conversion_report=cast(dict[str, Any], row[8]),
            imported_by=cast(UUID, row[9]),
            imported_at=cast(datetime, row[10]),
        )

    async def _load_style(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
    ) -> ResourceStyle:
        row = await transaction.fetch_one(
            f"""{self._style_select()}
            WHERE style.organization_id = %s AND style.project_id = %s
              AND style.resource_id = %s AND style.id = %s
            """,
            (context.organization_id, project_id, resource_id, style_id),
        )
        if row is None:
            raise ResourceNotFound("resource_style")
        return self._style(row)

    @staticmethod
    def _summary_select() -> str:
        return """
            SELECT resource.id, resource.project_id, resource.kind::text,
                   resource.slug, resource.dataset_id, resource.map_id,
                   resource.visibility::text, resource.state::text,
                   version.version_number, version.title, version.abstract,
                   version.language, version.license, version.attribution,
                   version.keywords, version.spatial_extent,
                   version.temporal_start, version.temporal_end,
                   resource.owner_user_id,
                   COALESCE(
                     (
                       SELECT identifier.namespace
                       FROM app.governed_resource_external_identifiers identifier
                       WHERE identifier.organization_id = resource.organization_id
                         AND identifier.resource_id = resource.id
                       ORDER BY identifier.namespace LIMIT 1
                     ),
                     (
                       SELECT source.source_namespace
                       FROM app.governed_metadata_source_documents source
                       WHERE source.organization_id = resource.organization_id
                         AND source.resource_id = resource.id
                       ORDER BY source.imported_at DESC, source.id DESC LIMIT 1
                     )
                   ) AS origin_namespace,
                   COALESCE(
                     (
                       SELECT identifier.identifier
                       FROM app.governed_resource_external_identifiers identifier
                       WHERE identifier.organization_id = resource.organization_id
                         AND identifier.resource_id = resource.id
                       ORDER BY identifier.namespace LIMIT 1
                     ),
                     (
                       SELECT source.source_identifier
                       FROM app.governed_metadata_source_documents source
                       WHERE source.organization_id = resource.organization_id
                         AND source.resource_id = resource.id
                       ORDER BY source.imported_at DESC, source.id DESC LIMIT 1
                     )
                   ) AS origin_identifier,
                   (
                     SELECT count(*)::bigint
                     FROM app.governed_resource_relationships relationship
                     WHERE relationship.organization_id = resource.organization_id
                       AND relationship.project_id = resource.project_id
                       AND (
                         relationship.source_resource_id = resource.id
                         OR relationship.target_resource_id = resource.id
                       )
                   ) AS relationship_count,
                   resource.created_at, resource.updated_at
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id
             AND version.id = resource.current_version_id
        """

    @staticmethod
    def _style_select(*, current: bool = True) -> str:
        statement = """
            SELECT style.id, style.resource_id, style.slug, style.format::text,
                   version.version_number, version.title, version.media_type,
                   version.definition, version.checksum_sha256,
                   version.change_message, version.created_by, version.created_at,
                   style.updated_at, style.archived_at IS NOT NULL
            FROM app.governed_resource_styles style
            JOIN app.governed_resource_style_versions version
              ON version.organization_id = style.organization_id
             AND version.style_id = style.id
        """
        if current:
            statement += " AND version.id = style.current_version_id"
        return statement

    @classmethod
    def _detail_select(cls) -> str:
        extra_columns = (
            "resource.created_at, resource.updated_at,\n"
            "                   version.metadata_profile, version.metadata_extensions,\n"
            "                   version.localized_metadata, version.content,\n"
            "                   version.provenance,\n"
            "                   version.change_message, version.created_by,\n"
            "                   version.created_at AS version_created_at,\n"
            "                   version.metadata_profile_id,\n"
            "                   managed_version.version_number AS metadata_profile_version,\n"
            "                   version.metadata_validation, version.id AS current_version_id"
        )
        statement = cls._summary_select().replace(
            "resource.created_at, resource.updated_at", extra_columns
        )
        return statement.replace(
            "AND version.id = resource.current_version_id",
            "AND version.id = resource.current_version_id\n"
            "            LEFT JOIN app.metadata_profile_versions managed_version\n"
            "              ON managed_version.organization_id = version.organization_id\n"
            "             AND managed_version.profile_id = version.metadata_profile_id\n"
            "             AND managed_version.id = version.metadata_profile_version_id",
        )

    @staticmethod
    def _summary(row: tuple[Any, ...]) -> ResourceSummary:
        extent_value = cast(list[Any] | None, row[15])
        extent = (
            cast(tuple[float, float, float, float], tuple(float(value) for value in extent_value))
            if extent_value is not None
            else None
        )
        return ResourceSummary(
            resource_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            kind=cast(ResourceKind, row[2]),
            slug=cast(str, row[3]),
            dataset_id=cast(UUID | None, row[4]),
            map_id=cast(UUID | None, row[5]),
            visibility=cast(ResourceVisibility, row[6]),
            state=cast(ResourceState, row[7]),
            version_number=cast(int, row[8]),
            title=cast(str, row[9]),
            abstract=cast(str | None, row[10]),
            language=cast(str, row[11]),
            license=cast(str | None, row[12]),
            attribution=cast(str | None, row[13]),
            keywords=tuple(cast(list[str], row[14])),
            spatial_extent=extent,
            temporal_start=cast(datetime | None, row[16]),
            temporal_end=cast(datetime | None, row[17]),
            owner_user_id=cast(UUID, row[18]),
            origin_namespace=cast(str | None, row[19]),
            origin_identifier=cast(str | None, row[20]),
            relationship_count=cast(int, row[21]),
            created_at=cast(datetime, row[22]),
            updated_at=cast(datetime, row[23]),
        )

    @staticmethod
    def _style(row: tuple[Any, ...]) -> ResourceStyle:
        return ResourceStyle(
            style_id=cast(UUID, row[0]),
            resource_id=cast(UUID, row[1]),
            slug=cast(str, row[2]),
            format=cast(ResourceStyleFormat, row[3]),
            version_number=cast(int, row[4]),
            title=cast(str, row[5]),
            media_type=cast(str, row[6]),
            definition=cast(str, row[7]),
            checksum_sha256=cast(str, row[8]),
            change_message=cast(str | None, row[9]),
            created_by=cast(UUID, row[10]),
            created_at=cast(datetime, row[11]),
            updated_at=cast(datetime, row[12]),
            archived=cast(bool, row[13]),
        )

    @staticmethod
    def _permission(row: tuple[Any, ...]) -> ResourcePermission:
        return ResourcePermission(
            user_id=cast(UUID, row[0]),
            email=cast(str, row[1]),
            display_name=cast(str, row[2]),
            role=cast(ResourcePermissionRole, row[3]),
            granted_by=cast(UUID, row[4]),
            created_at=cast(datetime, row[5]),
            updated_at=cast(datetime, row[6]),
        )

    @staticmethod
    def _verify_style_checksum(definition: str, checksum: str) -> None:
        if sha256(definition.encode("utf-8")).hexdigest() != checksum:
            raise ResourceConflict("resource_style_checksum_mismatch")

    async def _validate_binding(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        draft: ResourceDraft,
    ) -> None:
        if draft.expected_map_version is not None and (draft.kind != "map" or draft.map_id is None):
            raise ResourceConflict("resource_binding_kind_mismatch")
        await self._validate_binding_ids(
            transaction, context, project_id, draft.dataset_id, draft.map_id
        )

    @staticmethod
    async def _validate_binding_ids(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID | None,
        map_id: UUID | None,
    ) -> None:
        if dataset_id is not None:
            linked = await transaction.fetch_one(
                """
                SELECT 1 FROM app.project_datasets
                WHERE organization_id = %s AND project_id = %s AND dataset_id = %s
                """,
                (context.organization_id, project_id, dataset_id),
            )
            if linked is None:
                raise ResourceNotFound("dataset")
        if map_id is not None:
            linked = await transaction.fetch_one(
                """
                SELECT 1 FROM app.maps
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, map_id),
            )
            if linked is None:
                raise ResourceNotFound("map")

    @staticmethod
    async def _resource_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> Roles:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text,
                   permission.role::text, resource.owner_user_id = %s
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            JOIN app.governed_resources resource
              ON resource.organization_id = project.organization_id
             AND resource.project_id = project.id
             AND resource.id = %s
            LEFT JOIN app.governed_resource_permissions permission
              ON permission.organization_id = resource.organization_id
             AND permission.resource_id = resource.id
             AND permission.user_id = organization.user_id
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            """,
            (
                context.user_id,
                project_id,
                resource_id,
                context.organization_id,
                context.user_id,
            ),
        )
        if row is None:
            raise ResourceNotFound("resource")
        return Roles(
            organization=cast(Any, row[0]),
            project=cast(ProjectRole | None, row[1]),
            resource=cast(ResourcePermissionRole | None, row[2]),
            resource_owner=cast(bool, row[3]),
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
            raise ResourceAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise ResourceNotFound("project")
        return Roles(
            organization=cast(Any, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise ResourceAccessDenied("action forbidden") from error

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
        resource_type: str = "governed_resource",
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


def _record_extent_sql() -> str:
    """Same extent geometry as STAC Items, including points, lines and date line."""
    west, south, east, north = (
        f"(version.spatial_extent->>{index})::double precision" for index in range(4)
    )

    def rectangle(left: str, right: str) -> str:
        first = f"ST_SetSRID(ST_MakePoint({left},{south}),4326)"
        last = f"ST_SetSRID(ST_MakePoint({right},{north}),4326)"
        return (
            f"CASE WHEN {left}={right} AND {south}={north} THEN {first} "
            f"WHEN {left}={right} OR {south}={north} THEN ST_MakeLine({first},{last}) "
            f"ELSE ST_MakeEnvelope({left},{south},{right},{north},4326) END"
        )

    return (
        f"CASE WHEN {west}>{east} THEN ST_Collect({rectangle(west, '180')},"
        f"{rectangle('-180', east)}) ELSE {rectangle(west, east)} END"
    )
