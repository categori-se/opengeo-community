from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    Roles,
    authorize,
    is_allowed,
)
from opengeo_api.dataset_refresh_review import (
    VERSION_EVIDENCE_SQL,
    capture_review_evidence,
    upload_review_evidence,
)
from opengeo_api.metadata_refresh import (
    REFRESH_DOCUMENT_SQL,
    MetadataRefresh,
    append_refresh_source,
)
from opengeo_api.resource_knowledge import (
    empty_knowledge,
    validate_knowledge,
    verify_retained_sources_unchanged,
)
from opengeo_api.s3_uploads import StoredObject, UploadForm, UploadSpec, UploadStorage
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

DatasetClassification = Literal["public", "internal", "confidential", "restricted"]
DatasetSourceType = Literal[
    "upload",
    "xyz",
    "wms",
    "pmtiles",
    "geojson",
    "arcgis",
    "wfs",
    "repository",
    "imageserver",
    "mapserver",
    "cog",
    "postgis",
]
DatasetFormat = Literal[
    "kml",
    "geojson",
    "csv",
    "shapefile",
    "geopackage",
    "geoparquet",
    "cog",
    "pmtiles",
    "png",
    "jpeg",
    "pdf",
    "odt",
    "xyz",
    "wms",
    "arcgis",
    "wfs",
    "imageserver",
    "mapserver",
    "postgis",
]
UploadDatasetFormat = Literal[
    "kml",
    "geojson",
    "csv",
    "shapefile",
    "geopackage",
    "geoparquet",
    "cog",
    "pmtiles",
    "png",
    "jpeg",
    "pdf",
    "odt",
]
DatasetStatus = Literal["draft", "processing", "active", "failed", "archived"]
DatasetVersionState = Literal["queued", "processing", "active", "failed", "preserved"]
ProcessingJobState = Literal["queued", "running", "completed", "failed", "cancelled"]
ProjectRole = Literal["owner", "editor", "reviewer", "viewer"]
UploadIntentState = Literal["pending", "completed"]
UploadPurpose = Literal["ingest", "pmtiles_original"]


class IngestionStoreUnavailable(RuntimeError):
    pass


class IngestionAccessDenied(RuntimeError):
    pass


class IngestionNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class IngestionConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class IngestionProcessingHeld(RuntimeError):
    def __init__(self, purpose: UploadPurpose) -> None:
        self.code = (
            "shared_worker_processing_held"
            if purpose == "ingest"
            else "pmtiles_original_preservation_held"
        )
        super().__init__(self.code)


@dataclass(frozen=True, slots=True)
class Page:
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True, slots=True)
class CatalogFilters:
    query: str | None = None
    owner_user_id: UUID | None = None
    tag: str | None = None
    geometry_type: str | None = None
    format: DatasetFormat | None = None
    classification: DatasetClassification | None = None
    source_type: DatasetSourceType | None = None
    updated_after: datetime | None = None
    updated_before: datetime | None = None
    bbox: tuple[float, float, float, float] | None = None
    place_uri: str | None = None


@dataclass(frozen=True, slots=True)
class DatasetCapabilities:
    read: bool
    edit: bool
    download: bool
    manage_permissions: bool


@dataclass(frozen=True, slots=True)
class Dataset:
    dataset_id: UUID
    project_id: UUID
    name: str
    description: str | None
    classification: DatasetClassification
    source_type: DatasetSourceType
    format: DatasetFormat
    status: DatasetStatus
    owner_user_id: UUID
    current_version_id: UUID | None
    current_version_number: int | None
    current_version_state: DatasetVersionState | None
    feature_count: int | None
    extent: list[float] | None
    crs: str | None
    geometry_type: str | None
    quality_results: dict[str, Any]
    processing_job_state: ProcessingJobState | None
    processing_error_code: str | None
    tags: tuple[str, ...]
    created_at: datetime
    updated_at: datetime
    capabilities: DatasetCapabilities
    spatial_search_available: bool | None = None
    preservation_summary: dict[str, Any] | None = None
    source_spatial_metadata: dict[str, Any] | None = None
    catalog_match_count: int | None = None


@dataclass(frozen=True, slots=True)
class UploadDraft:
    name: str
    description: str | None
    classification: DatasetClassification
    format: DatasetFormat
    original_filename: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    tags: tuple[str, ...]
    purpose: UploadPurpose = "ingest"


@dataclass(frozen=True, slots=True)
class UploadRegistration:
    dataset_id: UUID
    upload_id: UUID
    project_id: UUID
    object_key: str
    bucket: str
    expires_at: datetime
    draft: UploadDraft


@dataclass(frozen=True, slots=True)
class UploadIntent:
    upload_id: UUID
    dataset_id: UUID
    project_id: UUID
    object_key: str
    bucket: str
    original_filename: str
    content_type: str
    expected_size_bytes: int
    expected_sha256: str
    state: UploadIntentState
    expires_at: datetime
    completed_object_id: UUID | None
    staged_base_version_id: UUID | None = None
    purpose: UploadPurpose = "ingest"


@dataclass(frozen=True, slots=True)
class UploadTicket:
    upload_id: UUID
    dataset: Dataset
    upload: UploadForm
    purpose: UploadPurpose = "ingest"


@dataclass(frozen=True, slots=True)
class UploadCompletion:
    dataset: Dataset
    dataset_version_id: UUID
    version_number: int
    processing_job_id: UUID | None
    processing_job_state: ProcessingJobState | None
    purpose: UploadPurpose = "ingest"


@dataclass(frozen=True, slots=True)
class RepositoryObjectDraft:
    connection_id: UUID
    expected_target_revision: int
    relative_path: str
    provider_version_id: str
    name: str
    description: str | None
    classification: DatasetClassification
    format: UploadDatasetFormat
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    provider_checksum_sha256: str | None
    tags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RepositoryObjectSource:
    dataset_id: UUID
    connection_id: UUID
    connection_target_revision: int
    provider: Literal["s3"]
    bucket_name: str
    region_name: str
    object_prefix: str
    relative_path: str
    provider_version_id: str
    size_bytes: int
    last_modified: datetime
    content_type: str | None
    etag: str
    storage_class: str | None
    provider_checksum_sha256: str | None
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RepositoryObjectRegistration:
    dataset: Dataset
    source: RepositoryObjectSource
    created: bool
    attached: bool


class IngestionRepository(Protocol):
    async def search_layers(
        self, context: TenantContext, **filters: Any
    ) -> list[dict[str, Any]]: ...
    async def search_datasets(
        self,
        context: TenantContext,
        page: Page,
        filters: CatalogFilters | None = None,
        client_id: UUID | None = None,
        project_id: UUID | None = None,
    ) -> list[Dataset]: ...

    async def list_datasets(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
        filters: CatalogFilters | None = None,
    ) -> list[Dataset]: ...

    async def accept_dataset_refresh_review(
        self,
        context: TenantContext,
        dataset_id: UUID,
        review_id: UUID,
        base_id: UUID,
        evidence_sha256: str,
    ) -> dict[str, Any]: ...

    async def create_dataset_refresh_review(
        self, context: TenantContext, dataset_id: UUID, base_id: UUID, candidate_id: UUID
    ) -> dict[str, Any]: ...

    async def get_dataset_knowledge(
        self, context: TenantContext, dataset_id: UUID, version: int | None = None
    ) -> dict[str, Any]: ...

    async def save_dataset_knowledge(
        self,
        context: TenantContext,
        dataset_id: UUID,
        document: dict[str, Any],
        expected_version: int,
        *,
        refresh: MetadataRefresh | None = None,
    ) -> dict[str, Any]: ...

    async def get_catalog_dataset(self, context: TenantContext, dataset_id: UUID) -> Dataset: ...

    async def get_dataset(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> Dataset: ...

    async def attach_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request_id: str,
    ) -> Dataset: ...

    async def detach_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request_id: str,
    ) -> None: ...

    async def request_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: UploadDraft,
        request_id: str,
        *,
        staged_target: tuple[UUID, UUID] | None = None,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadTicket: ...

    async def renew_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        upload_id: UUID,
        request_id: str,
        *,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadTicket: ...

    async def complete_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        upload_id: UUID,
        request_id: str,
        *,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadCompletion: ...

    async def register_repository_object(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: RepositoryObjectDraft,
        request_id: str,
    ) -> RepositoryObjectRegistration: ...

    async def get_repository_object_source(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> RepositoryObjectSource: ...


OperationResult = TypeVar("OperationResult")


class PostgresIngestionRepository:
    async def search_layers(self, context: TenantContext, **filters: Any) -> list[dict[str, Any]]:
        from opengeo_api.layer_catalog import search_layer_records

        try:
            return await search_layer_records(self._executor, context, **filters)
        except TenantDatabaseUnavailable as error:
            raise IngestionStoreUnavailable("layer catalog unavailable") from error

    def __init__(
        self,
        executor: TenantTransactionExecutor,
        storage: UploadStorage,
    ) -> None:
        self._executor = executor
        self._storage = storage

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise IngestionConflict("ingestion_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise IngestionStoreUnavailable("ingestion operation failed") from error

    async def list_datasets(
        self,
        context: TenantContext,
        project_id: UUID,
        page: Page,
        filters: CatalogFilters | None = None,
    ) -> list[Dataset]:
        catalog_filters = filters or CatalogFilters()

        async def operation(transaction: TenantTransaction) -> list[Dataset]:
            roles = await self._project_roles(transaction, context, project_id)
            unrestricted = is_allowed(Action.DATASET_LIST, roles)
            rows = await transaction.fetch_all(
                f"""{self._dataset_select()}
                WHERE dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND (%s OR caller_permission.role IS NOT NULL
                           OR dataset.owner_user_id = app.current_user_id())
                  AND (%s::text IS NULL OR
                       dataset.search_document @@ websearch_to_tsquery('simple', %s)
                       OR EXISTS (
                         SELECT 1
                         FROM app.dataset_tags search_dataset_tag
                         JOIN app.tags search_tag
                           ON search_tag.organization_id = search_dataset_tag.organization_id
                          AND search_tag.id = search_dataset_tag.tag_id
                         WHERE search_dataset_tag.organization_id = dataset.organization_id
                           AND search_dataset_tag.dataset_id = dataset.id
                           AND strpos(lower(search_tag.name), lower(%s)) > 0
                       ))
                  AND (%s::uuid IS NULL OR dataset.owner_user_id = %s)
                  AND (%s::text IS NULL OR EXISTS (
                    SELECT 1
                    FROM app.dataset_tags filter_dataset_tag
                    JOIN app.tags filter_tag
                      ON filter_tag.organization_id = filter_dataset_tag.organization_id
                     AND filter_tag.id = filter_dataset_tag.tag_id
                    WHERE filter_dataset_tag.organization_id = dataset.organization_id
                      AND filter_dataset_tag.dataset_id = dataset.id
                      AND filter_tag.name = %s
                  ))
                  AND (%s::text IS NULL OR lower(version.geometry_type) = lower(%s))
                  AND (%s::text IS NULL OR dataset.format::text = %s)
                  AND (%s::text IS NULL OR dataset.classification::text = %s)
                  AND (%s::text IS NULL OR dataset.source_type::text = %s)
                  AND (%s::timestamptz IS NULL OR dataset.updated_at >= %s)
                  AND (%s::timestamptz IS NULL OR dataset.updated_at <= %s)
                  AND (%s::jsonb IS NULL OR ST_Intersects(
                    COALESCE(version.catalog_geometry, knowledge.catalog_geometry),
                    app.catalog_extent_geometry(%s::jsonb, 'OGC:CRS84')))
                  AND (%s::text IS NULL OR %s::text = ANY(COALESCE((
                    SELECT knowledge.place_uris FROM app.dataset_knowledge_revisions knowledge
                    WHERE knowledge.organization_id = dataset.organization_id
                      AND knowledge.dataset_id = dataset.id
                    ORDER BY knowledge.version_number DESC LIMIT 1
                  ), ARRAY[]::text[])))
                ORDER BY
                  CASE WHEN %s::text IS NULL THEN 0
                       ELSE ts_rank(dataset.search_document,
                                    websearch_to_tsquery('simple', %s)) END DESC,
                  dataset.updated_at DESC,
                  lower(dataset.name), dataset.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    unrestricted,
                    catalog_filters.query,
                    catalog_filters.query,
                    catalog_filters.query,
                    catalog_filters.owner_user_id,
                    catalog_filters.owner_user_id,
                    catalog_filters.tag,
                    catalog_filters.tag,
                    catalog_filters.geometry_type,
                    catalog_filters.geometry_type,
                    catalog_filters.format,
                    catalog_filters.format,
                    catalog_filters.classification,
                    catalog_filters.classification,
                    catalog_filters.source_type,
                    catalog_filters.source_type,
                    catalog_filters.updated_after,
                    catalog_filters.updated_after,
                    catalog_filters.updated_before,
                    catalog_filters.updated_before,
                    Jsonb(list(catalog_filters.bbox)) if catalog_filters.bbox is not None else None,
                    Jsonb(list(catalog_filters.bbox)) if catalog_filters.bbox is not None else None,
                    catalog_filters.place_uri,
                    catalog_filters.place_uri,
                    catalog_filters.query,
                    catalog_filters.query,
                    page.limit,
                    page.offset,
                ),
            )
            return [self._dataset(row, roles) for row in rows]

        return await self._run(context, operation)

    async def search_datasets(
        self,
        context: TenantContext,
        page: Page,
        filters: CatalogFilters | None = None,
        client_id: UUID | None = None,
        project_id: UUID | None = None,
    ) -> list[Dataset]:
        catalog_filters = filters or CatalogFilters()

        async def operation(transaction: TenantTransaction) -> list[Dataset]:
            organization = await transaction.fetch_one(
                """
                SELECT role::text
                FROM app.organization_memberships
                WHERE organization_id = %s AND user_id = %s
                """,
                (context.organization_id, context.user_id),
            )
            if organization is None:
                raise IngestionAccessDenied("organization membership required")
            organization_role = cast(Any, organization[0])
            rows = await transaction.fetch_all(
                f"""
                WITH authorized_links AS (
                  SELECT DISTINCT ON (project_dataset.dataset_id)
                         project_dataset.organization_id,
                         project_dataset.dataset_id,
                         project_dataset.project_id
                  FROM app.project_datasets project_dataset
                  JOIN app.projects project
                    ON project.organization_id = project_dataset.organization_id
                   AND project.id = project_dataset.project_id
                  JOIN app.datasets authorized_dataset
                    ON authorized_dataset.organization_id = project_dataset.organization_id
                   AND authorized_dataset.id = project_dataset.dataset_id
                  CROSS JOIN LATERAL (
                    SELECT app.effective_project_role(project_dataset.project_id)::text AS role
                  ) membership
                  LEFT JOIN app.dataset_permissions permission
                    ON permission.organization_id = project_dataset.organization_id
                   AND permission.dataset_id = project_dataset.dataset_id
                   AND permission.user_id = app.current_user_id()
                  WHERE project_dataset.organization_id = %s
                    AND (%s OR membership.role IS NOT NULL OR permission.role IS NOT NULL
                             OR authorized_dataset.owner_user_id = app.current_user_id())
                    AND (%s::uuid IS NULL OR project.client_id = %s)
                    AND (%s::uuid IS NULL OR project.id = %s)
                  ORDER BY project_dataset.dataset_id,
                           CASE membership.role
                             WHEN 'owner' THEN 1 WHEN 'editor' THEN 2
                             WHEN 'reviewer' THEN 3 WHEN 'viewer' THEN 4 ELSE 5
                           END,
                           project_dataset.project_id
                )
                {self._dataset_select("authorized_links project_dataset", catalog_count=True)}
                WHERE dataset.organization_id = %s
                  AND (%s::text IS NULL OR
                       dataset.search_document @@ websearch_to_tsquery('simple', %s)
                       OR EXISTS (
                         SELECT 1 FROM app.dataset_tags search_dataset_tag
                         JOIN app.tags search_tag
                           ON search_tag.organization_id = search_dataset_tag.organization_id
                          AND search_tag.id = search_dataset_tag.tag_id
                         WHERE search_dataset_tag.organization_id = dataset.organization_id
                           AND search_dataset_tag.dataset_id = dataset.id
                           AND strpos(lower(search_tag.name), lower(%s)) > 0
                       ))
                  AND (%s::uuid IS NULL OR dataset.owner_user_id = %s)
                  AND (%s::text IS NULL OR EXISTS (
                    SELECT 1 FROM app.dataset_tags filter_dataset_tag
                    JOIN app.tags filter_tag
                      ON filter_tag.organization_id = filter_dataset_tag.organization_id
                     AND filter_tag.id = filter_dataset_tag.tag_id
                    WHERE filter_dataset_tag.organization_id = dataset.organization_id
                      AND filter_dataset_tag.dataset_id = dataset.id
                      AND filter_tag.name = %s
                  ))
                  AND (%s::text IS NULL OR lower(version.geometry_type) = lower(%s))
                  AND (%s::text IS NULL OR dataset.format::text = %s)
                  AND (%s::text IS NULL OR dataset.classification::text = %s)
                  AND (%s::text IS NULL OR dataset.source_type::text = %s)
                  AND (%s::timestamptz IS NULL OR dataset.updated_at >= %s)
                  AND (%s::timestamptz IS NULL OR dataset.updated_at <= %s)
                  AND (%s::jsonb IS NULL OR ST_Intersects(
                    COALESCE(version.catalog_geometry, knowledge.catalog_geometry),
                    app.catalog_extent_geometry(%s::jsonb, 'OGC:CRS84')))
                  AND (%s::text IS NULL OR %s::text = ANY(COALESCE((
                    SELECT knowledge.place_uris FROM app.dataset_knowledge_revisions knowledge
                    WHERE knowledge.organization_id = dataset.organization_id
                      AND knowledge.dataset_id = dataset.id
                    ORDER BY knowledge.version_number DESC LIMIT 1
                  ), ARRAY[]::text[])))
                ORDER BY
                  CASE WHEN %s::text IS NULL THEN 0
                       ELSE ts_rank(dataset.search_document,
                                    websearch_to_tsquery('simple', %s)) END DESC,
                  dataset.updated_at DESC, lower(dataset.name), dataset.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    organization_role == "admin",
                    client_id,
                    client_id,
                    project_id,
                    project_id,
                    context.organization_id,
                    catalog_filters.query,
                    catalog_filters.query,
                    catalog_filters.query,
                    catalog_filters.owner_user_id,
                    catalog_filters.owner_user_id,
                    catalog_filters.tag,
                    catalog_filters.tag,
                    catalog_filters.geometry_type,
                    catalog_filters.geometry_type,
                    catalog_filters.format,
                    catalog_filters.format,
                    catalog_filters.classification,
                    catalog_filters.classification,
                    catalog_filters.source_type,
                    catalog_filters.source_type,
                    catalog_filters.updated_after,
                    catalog_filters.updated_after,
                    catalog_filters.updated_before,
                    catalog_filters.updated_before,
                    Jsonb(list(catalog_filters.bbox)) if catalog_filters.bbox is not None else None,
                    Jsonb(list(catalog_filters.bbox)) if catalog_filters.bbox is not None else None,
                    catalog_filters.place_uri,
                    catalog_filters.place_uri,
                    catalog_filters.query,
                    catalog_filters.query,
                    page.limit,
                    page.offset,
                ),
            )
            base_roles = Roles(organization=organization_role)
            records = [self._dataset(row, base_roles) for row in rows]
            return [record for record in records if record.capabilities.read]

        return await self._run(context, operation)

    async def get_catalog_dataset(self, context: TenantContext, dataset_id: UUID) -> Dataset:
        async def operation(transaction: TenantTransaction) -> Dataset:
            return await self._load_catalog_dataset(transaction, context, dataset_id)

        return await self._run(context, operation)

    async def _load_catalog_dataset(
        self, transaction: TenantTransaction, context: TenantContext, dataset_id: UUID
    ) -> Dataset:
        # The selected project link is access context, never resource identity.
        organization = await transaction.fetch_one(
            """SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s""",
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise IngestionAccessDenied("organization membership required")
        row = await transaction.fetch_one(
            f"""{self._dataset_select()}
            WHERE dataset.organization_id = %s AND dataset.id = %s
              AND (%s OR caller_project_membership.role IS NOT NULL
                   OR caller_permission.role IS NOT NULL
                   OR dataset.owner_user_id = app.current_user_id())
            ORDER BY CASE caller_project_membership.role
              WHEN 'owner' THEN 1 WHEN 'editor' THEN 2
              WHEN 'reviewer' THEN 3 WHEN 'viewer' THEN 4 ELSE 5 END,
              project_dataset.project_id
            LIMIT 1
            """,
            (context.organization_id, dataset_id, organization[0] == "admin"),
        )
        if row is None:
            raise IngestionNotFound("dataset")
        dataset = self._dataset(row, Roles(organization=cast(OrganizationRole, organization[0])))
        if not dataset.capabilities.read:
            raise IngestionNotFound("dataset")
        return dataset

    async def _review_version_evidence(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        base: dict[str, Any],
        candidate: dict[str, Any],
    ) -> dict[str, Any]:
        capture = candidate.get("capture")
        if capture is None:
            return upload_review_evidence(
                str(context.organization_id), str(dataset_id), base, candidate
            )
        source_id = UUID(capture["sourceDatasetId"])
        # Source edits also lock their Layer. Hold that lock through acceptance so
        # the latest revision check and pointer promotion cannot race an edit.
        await transaction.fetch_one(
            "SELECT id FROM app.datasets WHERE organization_id=%s AND id=%s FOR SHARE",
            (context.organization_id, source_id),
        )
        await self._load_catalog_dataset(transaction, context, source_id)
        latest = await transaction.fetch_one(
            """SELECT max(version_number) FROM app.external_source_revisions
            WHERE organization_id=%s AND dataset_id=%s""",
            (context.organization_id, source_id),
        )
        if latest is None or latest[0] != capture["sourceRevision"]:
            raise IngestionConflict("refresh_source_revision_changed")
        return capture_review_evidence(
            str(context.organization_id), str(dataset_id), base, candidate
        )

    async def accept_dataset_refresh_review(
        self,
        context: TenantContext,
        dataset_id: UUID,
        review_id: UUID,
        base_id: UUID,
        evidence_sha256: str,
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            await transaction.fetch_one(
                "SELECT id FROM app.datasets WHERE organization_id = %s AND id = %s FOR UPDATE",
                (context.organization_id, dataset_id),
            )
            dataset = await self._load_catalog_dataset(transaction, context, dataset_id)
            if not dataset.capabilities.edit:
                raise IngestionAccessDenied("refresh acceptance requires dataset edit access")
            review = await transaction.fetch_one(
                """SELECT base_version_id, candidate_version_id, decision,
                          evidence, evidence_sha256, source_revision
                FROM app.dataset_refresh_reviews
                WHERE organization_id = %s AND dataset_id = %s AND id = %s""",
                (context.organization_id, dataset_id, review_id),
            )
            if review is None:
                raise IngestionNotFound("refresh_review")
            if review[4] != evidence_sha256 or review[0] != base_id:
                raise IngestionConflict("refresh_review_changed")
            consumed = await transaction.fetch_one(
                """SELECT id FROM app.dataset_refresh_acceptances
                WHERE organization_id = %s AND dataset_id = %s AND review_id = %s""",
                (context.organization_id, dataset_id, review_id),
            )
            if consumed is not None:
                raise IngestionConflict("refresh_review_already_accepted")
            if (
                dataset.current_version_id != base_id
                or dataset.status != "active"
                or dataset.source_type != "upload"
            ):
                raise IngestionConflict("refresh_base_changed")
            if (
                review[2] not in ("review_required", "ready")
                or review[5] is not None
                or review[3].get("sourceKind") not in {"staged_upload", "staged_source_capture"}
            ):
                raise IngestionConflict("refresh_review_not_acceptable")
            base = await transaction.fetch_one(
                VERSION_EVIDENCE_SQL, (context.organization_id, dataset_id, base_id)
            )
            candidate = await transaction.fetch_one(
                VERSION_EVIDENCE_SQL, (context.organization_id, dataset_id, review[1])
            )
            if (
                base is None
                or candidate is None
                or base[0]["state"] != "active"
                or candidate[0]["state"] != "active"
                or candidate[0]["parentVersionId"] != str(base_id)
            ):
                raise IngestionConflict("refresh_version_unavailable")
            try:
                current_evidence = await self._review_version_evidence(
                    transaction, context, dataset_id, base[0], candidate[0]
                )
            except ValueError as error:
                raise IngestionConflict("refresh_evidence_too_large") from error
            if current_evidence != review[3]:
                raise IngestionConflict("refresh_evidence_changed")
            # The Layer lock serializes competing acceptances. Both statements commit
            # together; failed ledger insertion cannot leave the pointer promoted.
            await transaction.execute(
                """UPDATE app.datasets SET current_version_id = %s, updated_by = %s
                WHERE organization_id = %s AND id = %s AND current_version_id = %s""",
                (review[1], context.user_id, context.organization_id, dataset_id, base_id),
            )
            accepted = await transaction.fetch_one(
                """INSERT INTO app.dataset_refresh_acceptances
                (organization_id, dataset_id, review_id, evidence_sha256, accepted_by)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, accepted_at""",
                (context.organization_id, dataset_id, review_id, evidence_sha256, context.user_id),
            )
            assert accepted is not None
            return {
                "id": str(accepted[0]),
                "dataset_id": str(dataset_id),
                "review_id": str(review_id),
                "current_version_id": str(review[1]),
                "previous_version_id": str(base_id),
                "evidence_sha256": evidence_sha256,
                "accepted_by": str(context.user_id),
                "accepted_at": accepted[1],
            }

        return await self._run(context, operation)

    async def create_dataset_refresh_review(
        self, context: TenantContext, dataset_id: UUID, base_id: UUID, candidate_id: UUID
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            await transaction.fetch_one(
                "SELECT id FROM app.datasets WHERE organization_id = %s AND id = %s FOR UPDATE",
                (context.organization_id, dataset_id),
            )
            dataset = await self._load_catalog_dataset(transaction, context, dataset_id)
            if not dataset.capabilities.edit:
                raise IngestionAccessDenied("refresh review requires dataset edit access")
            if (
                dataset.current_version_id != base_id
                or dataset.status != "active"
                or dataset.source_type != "upload"
                or base_id == candidate_id
            ):
                raise IngestionConflict("refresh_base_changed")
            staged = await transaction.fetch_one(
                """SELECT version.id FROM app.dataset_versions version
                JOIN app.upload_intents intent
                  ON intent.organization_id = version.organization_id
                 AND intent.dataset_id = version.dataset_id
                 AND intent.completed_object_id = version.original_object_id
                 AND intent.staged_base_version_id = version.parent_version_id
                JOIN app.processing_jobs job
                  ON job.organization_id = version.organization_id
                 AND job.dataset_id = version.dataset_id AND job.dataset_version_id = version.id
                WHERE version.organization_id = %s AND version.dataset_id = %s
                  AND version.id = %s AND version.parent_version_id = %s
                  AND version.state = 'active' AND intent.state = 'completed'
                  AND job.job_type = 'dataset.ingest' AND job.state = 'completed'""",
                (context.organization_id, dataset_id, candidate_id, base_id),
            )
            if staged is None:
                raise IngestionConflict("refresh_candidate_not_ready")
            response_sql = """SELECT jsonb_build_object(
              'id', id, 'dataset_id', dataset_id, 'base_version_id', base_version_id,
              'candidate_version_id', candidate_version_id, 'decision', decision,
              'evidence', evidence, 'evidence_sha256', evidence_sha256,
              'created_at', created_at, 'created_by', created_by)
              FROM app.dataset_refresh_reviews
              WHERE organization_id = %s AND dataset_id = %s AND candidate_version_id = %s"""
            params = (context.organization_id, dataset_id, candidate_id)
            existing = await transaction.fetch_one(response_sql, params)
            if existing is not None:
                return cast(dict[str, Any], existing[0])
            base = await transaction.fetch_one(
                VERSION_EVIDENCE_SQL, (context.organization_id, dataset_id, base_id)
            )
            candidate = await transaction.fetch_one(VERSION_EVIDENCE_SQL, params)
            if base is None or candidate is None or base[0]["state"] != "active":
                raise IngestionConflict("refresh_version_unavailable")
            try:
                evidence = await self._review_version_evidence(
                    transaction, context, dataset_id, base[0], candidate[0]
                )
            except ValueError as error:
                raise IngestionConflict("refresh_evidence_too_large") from error
            await transaction.execute(
                """INSERT INTO app.dataset_refresh_reviews
                  (organization_id, dataset_id, base_version_id, candidate_version_id,
                   decision, evidence, created_by)
                  VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    context.organization_id,
                    dataset_id,
                    base_id,
                    candidate_id,
                    evidence["decision"],
                    Jsonb(evidence),
                    context.user_id,
                ),
            )
            result = await transaction.fetch_one(response_sql, params)
            assert result is not None
            return cast(dict[str, Any], result[0])

        return await self._run(context, operation)

    async def get_dataset_knowledge(
        self, context: TenantContext, dataset_id: UUID, version: int | None = None
    ) -> dict[str, Any]:
        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            dataset = await self._load_catalog_dataset(transaction, context, dataset_id)
            row = await transaction.fetch_one(
                """SELECT version_number, document, created_by, created_at
                FROM app.dataset_knowledge_revisions
                WHERE organization_id = %s AND dataset_id = %s
                  AND (%s::integer IS NULL OR version_number = %s)
                ORDER BY version_number DESC LIMIT 1""",
                (context.organization_id, dataset_id, version, version),
            )
            if row is None and version is not None:
                raise IngestionNotFound("metadata_revision")
            return self._knowledge_response(dataset, row)

        return await self._run(context, operation)

    async def save_dataset_knowledge(
        self,
        context: TenantContext,
        dataset_id: UUID,
        document: dict[str, Any],
        expected_version: int,
        *,
        refresh: MetadataRefresh | None = None,
    ) -> dict[str, Any]:
        validated = validate_knowledge(document)

        async def operation(transaction: TenantTransaction) -> dict[str, Any]:
            # Serialize metadata writers without altering data version/build state.
            await transaction.fetch_one(
                "SELECT id FROM app.datasets WHERE organization_id = %s AND id = %s FOR UPDATE",
                (context.organization_id, dataset_id),
            )
            dataset = await self._load_catalog_dataset(transaction, context, dataset_id)
            if not dataset.capabilities.edit:
                raise IngestionAccessDenied("metadata edit requires dataset edit access")
            latest = await transaction.fetch_one(
                """SELECT version_number, document FROM app.dataset_knowledge_revisions
                WHERE organization_id = %s AND dataset_id = %s
                ORDER BY version_number DESC LIMIT 1""",
                (context.organization_id, dataset_id),
            )
            version = latest[0] if latest else 0
            if version != expected_version:
                raise IngestionConflict("metadata_version_conflict")
            candidate = validated
            if refresh is not None:
                self._require(
                    Action.PROJECT_DATASETS_MANAGE,
                    await self._project_roles(transaction, context, refresh.project_id),
                )
                source = await transaction.fetch_one(
                    REFRESH_DOCUMENT_SQL,
                    (dataset_id, context.organization_id, refresh.project_id, refresh.job_id),
                )
                if source is None or source[4] != refresh.source_revision:
                    raise IngestionConflict("metadata_refresh_source_conflict")
                try:
                    candidate = append_refresh_source(
                        latest[1] if latest else empty_knowledge(),
                        source,
                        refresh.job_id,
                        dataset_id=dataset_id,
                        project_id=refresh.project_id,
                        verified_document=refresh.verified_document,
                    )
                except (ValueError, KeyError, TypeError) as error:
                    raise IngestionConflict("metadata_refresh_response_invalid") from error
            else:
                try:
                    verify_retained_sources_unchanged(
                        candidate, latest[1] if latest else empty_knowledge(), dataset_id
                    )
                except ValueError as error:
                    raise IngestionConflict("metadata_retained_source_conflict") from error
            row = await transaction.fetch_one(
                """INSERT INTO app.dataset_knowledge_revisions
                (organization_id, dataset_id, version_number, document, created_by)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING version_number, document, created_by, created_at""",
                (
                    context.organization_id,
                    dataset_id,
                    version + 1,
                    Jsonb(candidate),
                    context.user_id,
                ),
            )
            return self._knowledge_response(dataset, row)

        return await self._run(context, operation)

    @staticmethod
    def _knowledge_response(dataset: Dataset, row: tuple[Any, ...] | None) -> dict[str, Any]:
        return {
            "dataset_id": dataset.dataset_id,
            "version": row[0] if row else 0,
            "document": row[1] if row else empty_knowledge(),
            "created_by": row[2] if row else None,
            "created_at": row[3] if row else None,
            "can_edit": dataset.capabilities.edit,
        }

    async def get_dataset(
        self, context: TenantContext, project_id: UUID, dataset_id: UUID
    ) -> Dataset:
        async def operation(transaction: TenantTransaction) -> Dataset:
            roles = await self._project_roles(transaction, context, project_id)
            return await self._load_dataset(
                transaction, context, project_id, dataset_id, roles=roles
            )

        return await self._run(context, operation)

    async def attach_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request_id: str,
    ) -> Dataset:
        async def operation(transaction: TenantTransaction) -> Dataset:
            target_roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, target_roles)
            source_roles = await self._dataset_sharing_roles(
                transaction, context, dataset_id, target_roles.organization
            )
            self._require(Action.DATASET_PERMISSIONS_MANAGE, source_roles)
            inserted = await transaction.execute(
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (organization_id, project_id, dataset_id) DO NOTHING
                """,
                (
                    context.organization_id,
                    project_id,
                    dataset_id,
                    context.user_id,
                ),
            )
            if inserted == 1:
                await self._record_event(
                    transaction,
                    context,
                    project_id,
                    "project.dataset.attached",
                    dataset_id,
                    request_id,
                    {},
                )
            return await self._load_dataset(
                transaction, context, project_id, dataset_id, roles=target_roles
            )

        return await self._run(context, operation)

    async def detach_dataset(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, roles)
            link = await transaction.fetch_one(
                """
                SELECT 1
                FROM app.project_datasets
                WHERE organization_id = %s AND project_id = %s AND dataset_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, dataset_id),
            )
            if link is None:
                raise IngestionNotFound("dataset")
            dependencies = await transaction.fetch_one(
                """
                SELECT
                  EXISTS (
                    SELECT 1
                    FROM app.maps map
                    CROSS JOIN LATERAL jsonb_array_elements(
                      CASE WHEN jsonb_typeof(map.definition->'layers') = 'array'
                           THEN map.definition->'layers' ELSE '[]'::jsonb END
                    ) layer
                    WHERE map.organization_id = %s
                      AND map.project_id = %s
                      AND layer->>'datasetId' = %s
                  )
                  OR EXISTS (
                    SELECT 1 FROM app.governed_resources resource
                    WHERE resource.organization_id = %s
                      AND resource.project_id = %s
                      AND resource.dataset_id = %s
                  )
                  OR EXISTS (
                    SELECT 1 FROM app.spatial_service_collections collection
                    WHERE collection.organization_id = %s
                      AND collection.project_id = %s
                      AND collection.dataset_id = %s
                  )
                  OR EXISTS (
                    SELECT 1 FROM app.spatial_service_coverages coverage
                    WHERE coverage.organization_id = %s
                      AND coverage.project_id = %s
                      AND coverage.dataset_id = %s
                  )
                  OR EXISTS (
                    SELECT 1 FROM app.external_source_snapshot_jobs snapshot
                    WHERE snapshot.organization_id = %s
                      AND snapshot.project_id = %s
                      AND (snapshot.source_dataset_id = %s
                        OR snapshot.destination_dataset_id = %s)
                      AND snapshot.state IN ('queued', 'running')
                  )
                  OR EXISTS (
                    SELECT 1 FROM app.pmtiles_derivative_jobs derivative
                    WHERE derivative.organization_id = %s
                      AND derivative.project_id = %s
                      AND derivative.dataset_id = %s
                      AND derivative.state IN ('queued', 'running')
                  )
                """,
                (
                    context.organization_id,
                    project_id,
                    str(dataset_id),
                    context.organization_id,
                    project_id,
                    dataset_id,
                    context.organization_id,
                    project_id,
                    dataset_id,
                    context.organization_id,
                    project_id,
                    dataset_id,
                    context.organization_id,
                    project_id,
                    dataset_id,
                    dataset_id,
                    context.organization_id,
                    project_id,
                    dataset_id,
                ),
            )
            if dependencies is None:
                raise IngestionStoreUnavailable("dataset dependency check returned no row")
            if bool(dependencies[0]):
                raise IngestionConflict("project_dataset_in_use")
            deleted = await transaction.execute(
                """
                DELETE FROM app.project_datasets
                WHERE organization_id = %s AND project_id = %s AND dataset_id = %s
                """,
                (context.organization_id, project_id, dataset_id),
            )
            if deleted != 1:
                raise IngestionConflict("project_dataset_changed")
            await self._record_event(
                transaction,
                context,
                project_id,
                "project.dataset.detached",
                dataset_id,
                request_id,
                {},
            )

        await self._run(context, operation)

    async def register_repository_object(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: RepositoryObjectDraft,
        request_id: str,
    ) -> RepositoryObjectRegistration:
        async def operation(transaction: TenantTransaction) -> RepositoryObjectRegistration:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_SOURCE_CREATE, roles)
            connection = await transaction.fetch_one(
                """
                SELECT provider::text, bucket_name, region_name, object_prefix,
                       target_revision, status::text
                FROM app.user_dataset_connections
                WHERE organization_id = %s AND owner_user_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, context.user_id, draft.connection_id),
            )
            if connection is None:
                raise IngestionNotFound("dataset_connection")
            if str(connection[5]) != "verified":
                raise IngestionConflict("connection_not_verified")
            if int(connection[4]) != draft.expected_target_revision:
                raise IngestionConflict("connection_target_changed")
            if draft.provider_version_id == "null":
                raise IngestionConflict("repository_object_version_mutable")

            source_row = await transaction.fetch_one(
                f"""{self._repository_object_source_select()}
                WHERE source.organization_id = %s
                  AND source.connection_id = %s
                  AND source.connection_target_revision = %s
                  AND source.relative_path = %s
                  AND source.provider_version_id = %s
                """,
                (
                    context.organization_id,
                    draft.connection_id,
                    draft.expected_target_revision,
                    draft.relative_path,
                    draft.provider_version_id,
                ),
            )
            if source_row is not None:
                source = self._repository_object_source(source_row)
                attached_count = await transaction.execute(
                    """
                    INSERT INTO app.project_datasets
                      (organization_id, project_id, dataset_id, linked_by)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (organization_id, project_id, dataset_id) DO NOTHING
                    """,
                    (
                        context.organization_id,
                        project_id,
                        source.dataset_id,
                        context.user_id,
                    ),
                )
                attached = attached_count == 1
                if attached:
                    await self._record_event(
                        transaction,
                        context,
                        project_id,
                        "project.dataset.attached",
                        source.dataset_id,
                        request_id,
                        {"source_type": "repository"},
                    )
                dataset = await self._load_dataset(
                    transaction, context, project_id, source.dataset_id, roles=roles
                )
                return RepositoryObjectRegistration(dataset, source, False, attached)

            dataset_id = uuid4()
            await transaction.execute(
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, description, classification,
                   source_type, format, status, owner_user_id, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, 'repository', %s, 'active', %s, %s, %s)
                """,
                (
                    dataset_id,
                    context.organization_id,
                    draft.name,
                    draft.description,
                    draft.classification,
                    draft.format,
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
            await self._insert_dataset_tags(transaction, context, dataset_id, draft.tags)
            source_row = await transaction.fetch_one(
                """
                INSERT INTO app.repository_object_sources
                  (organization_id, dataset_id, connection_id,
                   connection_target_revision, provider, bucket_name, region_name,
                   object_prefix, relative_path, provider_version_id, size_bytes,
                   last_modified, content_type, etag, storage_class,
                   provider_checksum_sha256, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s)
                RETURNING dataset_id, connection_id, connection_target_revision,
                          provider::text, bucket_name, region_name, object_prefix,
                          relative_path, provider_version_id, size_bytes,
                          last_modified, content_type, etag, storage_class,
                          provider_checksum_sha256, created_by, created_at
                """,
                (
                    context.organization_id,
                    dataset_id,
                    draft.connection_id,
                    draft.expected_target_revision,
                    str(connection[0]),
                    str(connection[1]),
                    str(connection[2]),
                    str(connection[3]),
                    draft.relative_path,
                    draft.provider_version_id,
                    draft.size_bytes,
                    draft.last_modified,
                    draft.content_type,
                    draft.etag,
                    draft.storage_class,
                    draft.provider_checksum_sha256,
                    context.user_id,
                ),
            )
            if source_row is None:
                raise IngestionStoreUnavailable("repository source insert returned no row")
            await self._record_event(
                transaction,
                context,
                project_id,
                "dataset.repository_object.registered",
                dataset_id,
                request_id,
                {
                    "connection_id": str(draft.connection_id),
                    "connection_target_revision": draft.expected_target_revision,
                    "source_type": "repository",
                    "format": draft.format,
                    "exact_provider_version": True,
                },
            )
            dataset = await self._load_dataset(
                transaction, context, project_id, dataset_id, roles=roles
            )
            return RepositoryObjectRegistration(
                dataset,
                self._repository_object_source(source_row),
                True,
                True,
            )

        return await self._run(context, operation)

    async def get_repository_object_source(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> RepositoryObjectSource:
        async def operation(transaction: TenantTransaction) -> RepositoryObjectSource:
            roles = await self._project_roles(transaction, context, project_id)
            await self._load_dataset(transaction, context, project_id, dataset_id, roles=roles)
            row = await transaction.fetch_one(
                f"""{self._repository_object_source_select()}
                JOIN app.project_datasets project_dataset
                  ON project_dataset.organization_id = source.organization_id
                 AND project_dataset.dataset_id = source.dataset_id
                WHERE source.organization_id = %s
                  AND source.dataset_id = %s
                  AND project_dataset.project_id = %s
                """,
                (context.organization_id, dataset_id, project_id),
            )
            if row is None:
                raise IngestionNotFound("repository_object_source")
            return self._repository_object_source(row)

        return await self._run(context, operation)

    async def _check_staged_target(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        target: tuple[UUID, UUID],
        file_format: str | None,
        roles: Roles,
    ) -> Dataset:
        dataset = await self._load_dataset(transaction, context, project_id, target[0], roles=roles)
        if not dataset.capabilities.edit:
            raise IngestionAccessDenied("staging requires Layer edit access")
        if (
            dataset.source_type != "upload"
            or dataset.status != "active"
            or dataset.current_version_state != "active"
            or (file_format is not None and dataset.format != file_format)
        ):
            raise IngestionConflict("staged_upload_target_unsupported")
        if dataset.current_version_id != target[1]:
            raise IngestionConflict("staged_upload_base_changed")
        return dataset

    @staticmethod
    def _require_upload_purpose(
        purpose: UploadPurpose, allowed_purposes: frozenset[UploadPurpose]
    ) -> None:
        if purpose not in allowed_purposes:
            raise IngestionProcessingHeld(purpose)

    @staticmethod
    def _check_preservation_target(
        dataset: Dataset, *, content_type: str, size_bytes: int, staged: bool
    ) -> None:
        if (
            staged
            or dataset.source_type != "upload"
            or dataset.format != "geojson"
            or content_type != "application/geo+json"
            or not 1 <= size_bytes <= 512 * 1024 * 1024
        ):
            raise IngestionConflict("pmtiles_original_upload_unsupported")
        if dataset.status != "draft" or dataset.current_version_id is not None:
            raise IngestionConflict("upload_dataset_changed")

    async def request_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: UploadDraft,
        request_id: str,
        *,
        staged_target: tuple[UUID, UUID] | None = None,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadTicket:
        self._require_upload_purpose(draft.purpose, allowed_purposes)
        if draft.purpose == "pmtiles_original" and (
            staged_target is not None
            or draft.format != "geojson"
            or draft.content_type != "application/geo+json"
            or not 1 <= draft.size_bytes <= 512 * 1024 * 1024
        ):
            raise IngestionConflict("pmtiles_original_upload_unsupported")

        async def preauthorize(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            if staged_target:
                await self._check_staged_target(
                    transaction, context, project_id, staged_target, draft.format, roles
                )

        await self._run(context, preauthorize)
        dataset_id = staged_target[0] if staged_target else uuid4()
        upload_id = uuid4()
        object_key = self._object_key(
            context.organization_id,
            project_id,
            dataset_id,
            upload_id,
            draft.original_filename,
        )
        upload_form = await self._storage.create_upload_form(
            UploadSpec(
                key=object_key,
                content_type=draft.content_type,
                size_bytes=draft.size_bytes,
                checksum_sha256=draft.checksum_sha256,
            )
        )
        registration = UploadRegistration(
            dataset_id=dataset_id,
            upload_id=upload_id,
            project_id=project_id,
            object_key=object_key,
            bucket=self._storage.bucket,
            expires_at=upload_form.expires_at,
            draft=draft,
        )

        async def create(transaction: TenantTransaction) -> Dataset:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            if staged_target:
                await transaction.fetch_one(
                    "SELECT id FROM app.datasets WHERE organization_id=%s AND id=%s FOR UPDATE",
                    (context.organization_id, dataset_id),
                )
                await self._check_staged_target(
                    transaction, context, project_id, staged_target, draft.format, roles
                )
            else:
                await transaction.execute(
                    """
                    INSERT INTO app.datasets
                      (id, organization_id, name, description, classification, format,
                       owner_user_id, created_by, updated_by)
                    VALUES (%s, %s, %s, %s, %s::app.dataset_classification,
                            %s::app.dataset_format, %s, %s, %s)
                    """,
                    (
                        registration.dataset_id,
                        context.organization_id,
                        draft.name,
                        draft.description,
                        draft.classification,
                        draft.format,
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
                    (
                        context.organization_id,
                        project_id,
                        registration.dataset_id,
                        context.user_id,
                    ),
                )
                for tag_name in draft.tags:
                    tag = await transaction.fetch_one(
                        """
                        INSERT INTO app.tags (organization_id, name, created_by)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (organization_id, name)
                        DO NOTHING
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
                        raise IngestionStoreUnavailable("tag registration returned no row")
                    await transaction.execute(
                        """
                        INSERT INTO app.dataset_tags
                          (organization_id, dataset_id, tag_id, tagged_by)
                        VALUES (%s, %s, %s, %s)
                        """,
                        (
                            context.organization_id,
                            registration.dataset_id,
                            cast(UUID, tag[0]),
                            context.user_id,
                        ),
                    )
            await transaction.execute(
                """
                INSERT INTO app.upload_intents
                  (id, organization_id, project_id, dataset_id, created_by,
                   original_filename, content_type, expected_size_bytes,
                   expected_sha256, bucket, object_key, expires_at, staged_base_version_id,
                   purpose)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    registration.upload_id,
                    context.organization_id,
                    project_id,
                    registration.dataset_id,
                    context.user_id,
                    draft.original_filename,
                    draft.content_type,
                    draft.size_bytes,
                    draft.checksum_sha256,
                    registration.bucket,
                    registration.object_key,
                    registration.expires_at,
                    staged_target[1] if staged_target else None,
                    draft.purpose,
                ),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "dataset.upload.requested",
                registration.dataset_id,
                request_id,
                {
                    "upload_id": str(registration.upload_id),
                    "format": draft.format,
                    "expected_size_bytes": draft.size_bytes,
                    "purpose": draft.purpose,
                },
            )
            return await self._load_dataset(
                transaction, context, project_id, registration.dataset_id, roles=roles
            )

        dataset = await self._run(context, create)
        return UploadTicket(
            upload_id=upload_id, dataset=dataset, upload=upload_form, purpose=draft.purpose
        )

    async def renew_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        upload_id: UUID,
        request_id: str,
        *,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadTicket:
        async def authorize(
            transaction: TenantTransaction,
            *,
            lock: bool,
        ) -> tuple[UploadIntent, Dataset]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            intent = await self._load_upload_intent(
                transaction, context, project_id, upload_id, lock=lock
            )
            if intent.state != "pending":
                raise IngestionConflict("upload_already_completed")
            self._require_upload_purpose(intent.purpose, allowed_purposes)
            if intent.bucket != self._storage.bucket:
                raise IngestionConflict("upload_storage_changed")
            if intent.staged_base_version_id:
                await self._check_staged_target(
                    transaction,
                    context,
                    project_id,
                    (intent.dataset_id, intent.staged_base_version_id),
                    None,
                    roles,
                )
            dataset = await self._load_dataset(
                transaction, context, project_id, intent.dataset_id, roles=roles
            )
            if intent.purpose == "pmtiles_original":
                self._check_preservation_target(
                    dataset,
                    content_type=intent.content_type,
                    size_bytes=intent.expected_size_bytes,
                    staged=intent.staged_base_version_id is not None,
                )
            if not intent.staged_base_version_id and dataset.status != "draft":
                raise IngestionConflict("upload_dataset_changed")
            return intent, dataset

        async def preauthorize(transaction: TenantTransaction) -> tuple[UploadIntent, Dataset]:
            return await authorize(transaction, lock=False)

        intent, _ = await self._run(context, preauthorize)
        form = await self._storage.create_upload_form(
            UploadSpec(
                key=intent.object_key,
                content_type=intent.content_type,
                size_bytes=intent.expected_size_bytes,
                checksum_sha256=intent.expected_sha256,
            )
        )

        async def renew(transaction: TenantTransaction) -> Dataset:
            locked, dataset = await authorize(transaction, lock=True)
            await transaction.execute(
                """UPDATE app.upload_intents
                   SET expires_at = GREATEST(expires_at, %s)
                   WHERE organization_id = %s AND project_id = %s AND id = %s""",
                (form.expires_at, context.organization_id, project_id, upload_id),
            )
            await self._record_event(
                transaction,
                context,
                project_id,
                "dataset.upload.renewed",
                locked.dataset_id,
                request_id,
                {"upload_id": str(upload_id)},
            )
            return dataset

        dataset = await self._run(context, renew)
        return UploadTicket(
            upload_id=upload_id, dataset=dataset, upload=form, purpose=intent.purpose
        )

    async def complete_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        upload_id: UUID,
        request_id: str,
        *,
        allowed_purposes: frozenset[UploadPurpose] = frozenset({"ingest"}),
    ) -> UploadCompletion:
        async def load(transaction: TenantTransaction) -> UploadIntent:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            intent = await self._load_upload_intent(
                transaction, context, project_id, upload_id, lock=False
            )
            if intent.state != "completed":
                self._require_upload_purpose(intent.purpose, allowed_purposes)
                if intent.purpose == "pmtiles_original":
                    dataset = await self._load_dataset(
                        transaction, context, project_id, intent.dataset_id, roles=roles
                    )
                    self._check_preservation_target(
                        dataset,
                        content_type=intent.content_type,
                        size_bytes=intent.expected_size_bytes,
                        staged=intent.staged_base_version_id is not None,
                    )
            if intent.state != "completed" and intent.staged_base_version_id:
                await self._check_staged_target(
                    transaction,
                    context,
                    project_id,
                    (intent.dataset_id, intent.staged_base_version_id),
                    None,
                    roles,
                )
            return intent

        intent = await self._run(context, load)
        if intent.state == "completed":
            return await self._existing_completion(
                context, project_id, intent.dataset_id, intent.completed_object_id, intent.purpose
            )
        if intent.expires_at <= datetime.now(UTC):
            raise IngestionConflict("upload_expired")
        stored = await self._storage.inspect_object(intent.object_key)
        self._verify_stored_object(intent, stored)

        async def complete(transaction: TenantTransaction) -> UploadCompletion:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            locked = await self._load_upload_intent(
                transaction, context, project_id, upload_id, lock=True
            )
            if locked.state == "completed":
                return await self._load_completion(
                    transaction,
                    context,
                    project_id,
                    locked.dataset_id,
                    original_object_id=locked.completed_object_id,
                    roles=roles,
                    purpose=locked.purpose,
                )
            self._require_upload_purpose(locked.purpose, allowed_purposes)
            expiry = await transaction.fetch_one(
                "SELECT expires_at > clock_timestamp() FROM app.upload_intents WHERE id = %s",
                (upload_id,),
            )
            if expiry is None or expiry[0] is not True:
                raise IngestionConflict("upload_expired")
            self._verify_stored_object(locked, stored)
            await transaction.fetch_one(
                """
                SELECT id
                FROM app.datasets
                WHERE organization_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, locked.dataset_id),
            )
            if locked.purpose == "pmtiles_original":
                dataset = await self._load_dataset(
                    transaction, context, project_id, locked.dataset_id, roles=roles
                )
                self._check_preservation_target(
                    dataset,
                    content_type=locked.content_type,
                    size_bytes=locked.expected_size_bytes,
                    staged=locked.staged_base_version_id is not None,
                )
            if locked.staged_base_version_id:
                await self._check_staged_target(
                    transaction,
                    context,
                    project_id,
                    (locked.dataset_id, locked.staged_base_version_id),
                    None,
                    roles,
                )
            version_row = await transaction.fetch_one(
                """
                SELECT COALESCE(max(version_number), 0) + 1
                FROM app.dataset_versions
                WHERE organization_id = %s AND dataset_id = %s
                """,
                (context.organization_id, locked.dataset_id),
            )
            if version_row is None:
                raise IngestionStoreUnavailable("dataset version allocation failed")
            version_number = cast(int, version_row[0])
            object_id = uuid4()
            version_id = uuid4()
            job_id = uuid4() if locked.purpose == "ingest" else None
            await transaction.execute(
                """
                INSERT INTO app.data_objects
                  (id, organization_id, dataset_id, role, bucket, object_key,
                   s3_version_id, etag, content_type, size_bytes, checksum_sha256,
                   created_by)
                VALUES (%s, %s, %s, 'original', %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    object_id,
                    context.organization_id,
                    locked.dataset_id,
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
                INSERT INTO app.dataset_versions
                  (id, organization_id, dataset_id, version_number,
                   original_object_id, state, change_message, created_by, parent_version_id)
                VALUES (%s, %s, %s, %s, %s, %s::app.dataset_version_state,
                        %s, %s, %s)
                """,
                (
                    version_id,
                    context.organization_id,
                    locked.dataset_id,
                    version_number,
                    object_id,
                    "preserved" if locked.purpose == "pmtiles_original" else "queued",
                    (
                        "Preserved original for PMTiles conversion"
                        if locked.purpose == "pmtiles_original"
                        else "Uploaded data version"
                    ),
                    context.user_id,
                    locked.staged_base_version_id,
                ),
            )
            if locked.purpose == "ingest" and locked.staged_base_version_id is None:
                await transaction.execute(
                    """
                    UPDATE app.datasets
                    SET status = 'processing', current_version_id = %s, updated_by = %s
                    WHERE organization_id = %s AND id = %s
                    """,
                    (version_id, context.user_id, context.organization_id, locked.dataset_id),
                )
            await transaction.execute(
                """
                UPDATE app.upload_intents
                SET state = 'completed', completed_at = clock_timestamp(),
                    completed_object_id = %s
                WHERE organization_id = %s AND id = %s AND state = 'pending'
                """,
                (object_id, context.organization_id, upload_id),
            )
            if locked.purpose == "pmtiles_original":
                updated = await transaction.execute(
                    """
                    UPDATE app.datasets
                    SET current_version_id = %s, updated_by = %s
                    WHERE organization_id = %s AND id = %s AND status = 'draft'
                      AND current_version_id IS NULL
                    """,
                    (version_id, context.user_id, context.organization_id, locked.dataset_id),
                )
                if updated != 1:
                    raise IngestionConflict("upload_dataset_changed")
            else:
                await transaction.execute(
                    """
                    INSERT INTO app.processing_jobs
                  (id, organization_id, project_id, dataset_id, dataset_version_id,
                   job_type, parameters, created_by)
                VALUES (%s, %s, %s, %s, %s, 'dataset.ingest', %s, %s)
                    """,
                    (
                        job_id,
                        context.organization_id,
                        project_id,
                        locked.dataset_id,
                        version_id,
                        Jsonb(
                            {
                                "upload_id": str(upload_id),
                                "object_id": str(object_id),
                                "s3_version_id": stored.version_id,
                            }
                        ),
                        context.user_id,
                    ),
                )
            await self._record_event(
                transaction,
                context,
                project_id,
                "dataset.upload.completed",
                locked.dataset_id,
                request_id,
                {
                    "upload_id": str(upload_id),
                    "dataset_version_id": str(version_id),
                    "version_number": version_number,
                    "processing_job_id": str(job_id) if job_id else None,
                    "purpose": locked.purpose,
                },
            )
            dataset = await self._load_dataset(
                transaction, context, project_id, locked.dataset_id, roles=roles
            )
            return UploadCompletion(
                dataset,
                version_id,
                version_number,
                job_id,
                "queued" if job_id else None,
                locked.purpose,
            )

        return await self._run(context, complete)

    async def _existing_completion(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        original_object_id: UUID | None,
        purpose: UploadPurpose,
    ) -> UploadCompletion:
        async def operation(transaction: TenantTransaction) -> UploadCompletion:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.DATASET_UPLOAD, roles)
            return await self._load_completion(
                transaction,
                context,
                project_id,
                dataset_id,
                original_object_id=original_object_id,
                roles=roles,
                purpose=purpose,
            )

        return await self._run(context, operation)

    async def _load_completion(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        roles: Roles,
        original_object_id: UUID | None,
        purpose: UploadPurpose,
    ) -> UploadCompletion:
        if original_object_id is None:
            raise IngestionStoreUnavailable("completed upload has no original object")
        dataset = await self._load_dataset(
            transaction, context, project_id, dataset_id, roles=roles
        )
        row = await transaction.fetch_one(
            f"""
            SELECT version.id, version.version_number, job.id, job.state::text
            FROM app.dataset_versions version
            {"LEFT JOIN" if purpose == "pmtiles_original" else "JOIN"} app.processing_jobs job
              ON job.organization_id = version.organization_id
             AND job.dataset_version_id = version.id
             AND job.job_type = 'dataset.ingest'
            WHERE version.organization_id = %s
              AND version.dataset_id = %s
              AND version.original_object_id = %s
              {"AND version.state::text = 'preserved'" if purpose == "pmtiles_original" else ""}
            """,
            (context.organization_id, dataset_id, original_object_id),
        )
        if row is None or (purpose == "pmtiles_original" and row[2] is not None):
            raise IngestionStoreUnavailable("completed upload has no matching completion")
        return UploadCompletion(
            dataset=dataset,
            dataset_version_id=cast(UUID, row[0]),
            version_number=cast(int, row[1]),
            processing_job_id=cast(UUID | None, row[2]),
            processing_job_state=cast(ProcessingJobState | None, row[3]),
            purpose=purpose,
        )

    async def _load_upload_intent(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        upload_id: UUID,
        *,
        lock: bool,
    ) -> UploadIntent:
        row = await transaction.fetch_one(
            f"""
            SELECT id, dataset_id, project_id, object_key, bucket, original_filename,
                   content_type, expected_size_bytes, expected_sha256, state::text,
                   expires_at, completed_object_id, purpose, staged_base_version_id
            FROM app.upload_intents
            WHERE organization_id = %s AND project_id = %s AND id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, project_id, upload_id),
        )
        if row is None:
            raise IngestionNotFound("upload")
        return UploadIntent(
            upload_id=cast(UUID, row[0]),
            dataset_id=cast(UUID, row[1]),
            project_id=cast(UUID, row[2]),
            object_key=cast(str, row[3]),
            bucket=cast(str, row[4]),
            original_filename=cast(str, row[5]),
            content_type=cast(str, row[6]),
            expected_size_bytes=cast(int, row[7]),
            expected_sha256=cast(str, row[8]),
            state=cast(UploadIntentState, row[9]),
            expires_at=cast(datetime, row[10]),
            completed_object_id=cast(UUID | None, row[11]),
            purpose=cast(UploadPurpose, row[12]),
            staged_base_version_id=cast(UUID | None, row[13]),
        )

    async def _load_dataset(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        roles: Roles,
    ) -> Dataset:
        row = await transaction.fetch_one(
            f"""{self._dataset_select()}
            WHERE dataset.organization_id = %s
              AND project_dataset.project_id = %s
              AND dataset.id = %s
            """,
            (context.organization_id, project_id, dataset_id),
        )
        if row is None:
            raise IngestionNotFound("dataset")
        dataset = self._dataset(row, roles)
        if not dataset.capabilities.read:
            raise IngestionNotFound("dataset")
        return dataset

    @staticmethod
    async def _insert_dataset_tags(
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
                ON CONFLICT (organization_id, name)
                DO NOTHING
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
                raise IngestionStoreUnavailable("tag registration returned no row")
            await transaction.execute(
                """
                INSERT INTO app.dataset_tags
                  (organization_id, dataset_id, tag_id, tagged_by)
                VALUES (%s, %s, %s, %s)
                """,
                (context.organization_id, dataset_id, cast(UUID, tag[0]), context.user_id),
            )

    @staticmethod
    def _repository_object_source_select() -> str:
        return """
            SELECT source.dataset_id, source.connection_id,
                   source.connection_target_revision, source.provider::text,
                   source.bucket_name, source.region_name, source.object_prefix,
                   source.relative_path, source.provider_version_id,
                   source.size_bytes, source.last_modified, source.content_type,
                   source.etag, source.storage_class,
                   source.provider_checksum_sha256, source.created_by,
                   source.created_at
            FROM app.repository_object_sources source
        """

    @staticmethod
    def _repository_object_source(row: tuple[Any, ...]) -> RepositoryObjectSource:
        provider = str(row[3])
        if provider != "s3":
            raise IngestionStoreUnavailable("unsupported repository source provider")
        return RepositoryObjectSource(
            dataset_id=UUID(str(row[0])),
            connection_id=UUID(str(row[1])),
            connection_target_revision=int(row[2]),
            provider="s3",
            bucket_name=str(row[4]),
            region_name=str(row[5]),
            object_prefix=str(row[6]),
            relative_path=str(row[7]),
            provider_version_id=str(row[8]),
            size_bytes=int(row[9]),
            last_modified=cast(datetime, row[10]),
            content_type=str(row[11]) if row[11] is not None else None,
            etag=str(row[12]),
            storage_class=str(row[13]) if row[13] is not None else None,
            provider_checksum_sha256=str(row[14]) if row[14] is not None else None,
            created_by=UUID(str(row[15])),
            created_at=cast(datetime, row[16]),
        )

    @staticmethod
    def _dataset_select(
        project_relation: str = "app.project_datasets project_dataset",
        *,
        catalog_count: bool = False,
    ) -> str:
        return f"""
            SELECT dataset.id, project_dataset.project_id, dataset.name,
                   dataset.description, dataset.classification::text,
                   dataset.source_type::text, dataset.format::text,
                   dataset.status::text, dataset.owner_user_id,
                   dataset.current_version_id, version.version_number,
                   version.state::text, version.feature_count, version.extent,
                   version.crs, version.geometry_type, version.quality_results,
                   job.state::text, job.error_code,
                   COALESCE(
                     (SELECT array_agg(tag.name ORDER BY tag.name)
                      FROM app.dataset_tags dataset_tag
                      JOIN app.tags tag
                        ON tag.organization_id = dataset_tag.organization_id
                       AND tag.id = dataset_tag.tag_id
                      WHERE dataset_tag.organization_id = dataset.organization_id
                        AND dataset_tag.dataset_id = dataset.id),
                     '{{}}'::text[]
                   ),
                   dataset.created_at, dataset.updated_at,
                   caller_permission.role::text,
                   dataset.owner_user_id = app.current_user_id(),
                   caller_project_membership.role::text,
                   COALESCE(version.catalog_geometry, knowledge.catalog_geometry) IS NOT NULL,
                   jsonb_build_object(
                     'source_version', source_revision.version_number,
                     'connection_validation', source_revision.verification_state,
                     'connection_recorded_at', source_revision.created_at,
                     'map_archives', (SELECT count(*) FROM app.layer_archive_distributions archive
                       WHERE archive.organization_id = dataset.organization_id
                         AND archive.dataset_id = dataset.id AND archive.enabled
                         AND (archive.source_version = source_revision.version_number
                           OR archive.dataset_version_id = version.id)),
                     'data_preserved', COALESCE(knowledge.document->'metadata'->'normalized'
                       @> '[{{"subject":"resource",
                         "property":"https://opengeo.tools/ns/preservedDataInventory"}}]'::jsonb,
                       false),
                     'metadata_preserved', COALESCE(knowledge.document->'metadata'->'normalized'
                       @> '[{{"subject":"resource",
                         "property":"https://opengeo.tools/ns/archiveCapture"}}]'::jsonb, false)
                   ),
                   (SELECT jsonb_build_object(
                      'geometryType', observation.value->'value'->'geometryType',
                      'extent', COALESCE(observation.value->'value'->'extent',
                        observation.value->'value'->'fullExtent'),
                      'spatialReference', COALESCE(
                        observation.value->'value'->'extent'->'spatialReference',
                        observation.value->'value'->'spatialReference',
                        observation.value->'value'->'sourceSpatialReference'))
                    FROM jsonb_array_elements(knowledge.document->'metadata'->'normalized')
                      WITH ORDINALITY observation(value, ordinal)
                    WHERE observation.value->>'subject' = 'resource'
                      AND observation.value->>'property' = 'https://opengeo.tools/ns/arcgisLayerMetadata'
                    ORDER BY observation.ordinal DESC LIMIT 1),
                   {"count(*) OVER ()" if catalog_count else "NULL::bigint"}
            FROM app.datasets dataset
            JOIN {project_relation}
              ON project_dataset.organization_id = dataset.organization_id
             AND project_dataset.dataset_id = dataset.id
            LEFT JOIN app.dataset_versions version
              ON version.organization_id = dataset.organization_id
             AND version.dataset_id = dataset.id
             AND version.id = dataset.current_version_id
            LEFT JOIN app.processing_jobs job
              ON job.organization_id = version.organization_id
             AND job.dataset_version_id = version.id
             AND job.job_type = 'dataset.ingest'
            LEFT JOIN app.dataset_permissions caller_permission
              ON caller_permission.organization_id = dataset.organization_id
             AND caller_permission.dataset_id = dataset.id
             AND caller_permission.user_id = app.current_user_id()
            LEFT JOIN LATERAL (
              SELECT revision.version_number, revision.verification_state::text,
                     revision.created_at
              FROM app.external_source_revisions revision
              WHERE revision.organization_id = dataset.organization_id
                AND revision.dataset_id = dataset.id
              ORDER BY revision.version_number DESC LIMIT 1
            ) source_revision ON true
            LEFT JOIN LATERAL (
              SELECT revision.document, revision.catalog_geometry
              FROM app.dataset_knowledge_revisions revision
              WHERE revision.organization_id = dataset.organization_id
                AND revision.dataset_id = dataset.id
              ORDER BY revision.version_number DESC LIMIT 1
            ) knowledge ON true
            CROSS JOIN LATERAL (
              SELECT app.effective_project_role(project_dataset.project_id)::text AS role
            ) caller_project_membership
        """

    @staticmethod
    def _dataset(row: tuple[Any, ...], project_roles: Roles) -> Dataset:
        extent_value = row[13]
        extent = None if extent_value is None else [float(value) for value in extent_value]
        roles = Roles(
            organization=project_roles.organization,
            project=project_roles.project or cast(ProjectRole | None, row[24]),
            dataset=cast(DatasetPermissionRole | None, row[22]),
            dataset_owner=cast(bool, row[23]),
        )
        return Dataset(
            spatial_search_available=cast(bool, row[25]) if len(row) > 25 else None,
            preservation_summary=cast(dict[str, Any], row[26]) if len(row) > 26 else None,
            source_spatial_metadata=cast(dict[str, Any] | None, row[27]) if len(row) > 27 else None,
            catalog_match_count=cast(int | None, row[28]) if len(row) > 28 else None,
            dataset_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            name=cast(str, row[2]),
            description=cast(str | None, row[3]),
            classification=cast(DatasetClassification, row[4]),
            source_type=cast(DatasetSourceType, row[5]),
            format=cast(DatasetFormat, row[6]),
            status=cast(DatasetStatus, row[7]),
            owner_user_id=cast(UUID, row[8]),
            current_version_id=cast(UUID | None, row[9]),
            current_version_number=cast(int | None, row[10]),
            current_version_state=cast(DatasetVersionState | None, row[11]),
            feature_count=cast(int | None, row[12]),
            extent=extent,
            crs=cast(str | None, row[14]),
            geometry_type=cast(str | None, row[15]),
            quality_results=cast(dict[str, Any], row[16] or {}),
            processing_job_state=cast(ProcessingJobState | None, row[17]),
            processing_error_code=cast(str | None, row[18]),
            tags=tuple(cast(list[str], row[19])),
            created_at=cast(datetime, row[20]),
            updated_at=cast(datetime, row[21]),
            capabilities=DatasetCapabilities(
                read=is_allowed(Action.DATASET_READ, roles),
                edit=is_allowed(Action.DATASET_EDIT, roles),
                download=is_allowed(Action.DATASET_DOWNLOAD, roles),
                manage_permissions=is_allowed(Action.DATASET_PERMISSIONS_MANAGE, roles),
            ),
        )

    async def _project_roles(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text
            FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise IngestionAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT project.id, app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise IngestionNotFound("project")
        return Roles(
            organization=cast(Any, organization[0]),
            project=cast(ProjectRole | None, project[1]),
        )

    @staticmethod
    async def _dataset_sharing_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        organization_role: OrganizationRole,
    ) -> Roles:
        row = await transaction.fetch_one(
            """
            SELECT dataset.id,
                   dataset.owner_user_id = app.current_user_id(),
                   permission.role::text,
                   (
                     SELECT app.effective_project_role(link.project_id)::text
                     FROM app.project_datasets link
                     WHERE link.organization_id = dataset.organization_id
                       AND link.dataset_id = dataset.id
                       AND app.effective_project_role(link.project_id) IS NOT NULL
                     ORDER BY CASE app.effective_project_role(link.project_id)
                       WHEN 'owner' THEN 1 WHEN 'editor' THEN 2
                       WHEN 'reviewer' THEN 3 WHEN 'viewer' THEN 4
                     END, link.project_id
                     LIMIT 1
                   )
            FROM app.datasets dataset
            LEFT JOIN app.dataset_permissions permission
              ON permission.organization_id = dataset.organization_id
             AND permission.dataset_id = dataset.id
             AND permission.user_id = app.current_user_id()
            WHERE dataset.organization_id = %s AND dataset.id = %s
            FOR SHARE OF dataset
            """,
            (context.organization_id, dataset_id),
        )
        if row is None:
            raise IngestionNotFound("dataset")
        return Roles(
            organization=organization_role,
            project=cast(ProjectRole | None, row[3]),
            dataset=cast(DatasetPermissionRole | None, row[2]),
            dataset_owner=cast(bool, row[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise IngestionAccessDenied("action forbidden") from error

    @staticmethod
    def _verify_stored_object(intent: UploadIntent, stored: StoredObject) -> None:
        if (
            stored.bucket != intent.bucket
            or stored.key != intent.object_key
            or stored.content_type != intent.content_type
            or stored.size_bytes != intent.expected_size_bytes
            or stored.checksum_sha256 != intent.expected_sha256
        ):
            raise IngestionConflict("upload_verification_failed")

    @staticmethod
    def _object_key(
        organization_id: UUID,
        project_id: UUID,
        dataset_id: UUID,
        upload_id: UUID,
        filename: str,
    ) -> str:
        return (
            f"organizations/{organization_id}/projects/{project_id}/datasets/{dataset_id}/"
            f"uploads/{upload_id}/original/{filename}"
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
