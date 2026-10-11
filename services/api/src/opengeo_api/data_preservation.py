from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    Roles,
    authorize,
)
from opengeo_api.ingestion import (
    DatasetClassification,
    DatasetFormat,
    DatasetStatus,
    Page,
    ProcessingJobState,
    ProjectRole,
    UploadDatasetFormat,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

CopySourceType = Literal["wms", "pmtiles", "arcgis", "wfs"]
CopyMethod = Literal["bounded_map_capture", "exact_object_copy", "bounded_feature_capture"]
CopyOutputFormat = Literal["png", "pmtiles", "geojson"]

MAX_WMS_DIMENSION = 4096
MAX_WMS_PIXELS = 16_777_216
WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066
MAX_PROTECTED_COPY_BYTES = 536_870_912
MAX_PM_TILES_ZOOM = 22
MAX_FEATURE_COPY_COUNT = 50_000
MAX_FEATURE_COPY_PAGE_SIZE = 2_000
MAX_FEATURE_COPY_REQUESTS = 64
PMTILES_DERIVATIVE_REQUEST_SCHEMA = "opengeo.pmtiles-derivative-request.1.0.0"
PMTILES_DERIVATIVE_RECIPE = "gdal-pmtiles-v1"
ESTIMATE_LIFETIME = timedelta(minutes=30)
_STORAGE_USD_PER_GB_MONTH = Decimal("0.023")
_PUT_REQUEST_USD = Decimal("0.000005")
_USD_QUANTUM = Decimal("0.000001")
_PMTILES_SOURCE_CONTENT_TYPES = frozenset(
    {
        "application/geo+json",
        "application/geopackage+sqlite3",
        "application/vnd.apache.parquet",
        "application/zip",
        "text/csv",
    }
)
_REPOSITORY_COPY_CONTENT_TYPES: dict[UploadDatasetFormat, frozenset[str]] = {
    "geojson": frozenset({"application/geo+json", "application/json"}),
    "csv": frozenset({"text/csv", "application/csv"}),
    "shapefile": frozenset({"application/zip", "application/x-zip-compressed"}),
    "geopackage": frozenset(
        {"application/geopackage+sqlite3", "application/vnd.sqlite3", "application/octet-stream"}
    ),
    "geoparquet": frozenset(
        {"application/vnd.apache.parquet", "application/x-parquet", "application/octet-stream"}
    ),
    "cog": frozenset({"image/tiff", "image/geotiff", "application/geotiff"}),
    "pmtiles": frozenset({"application/vnd.pmtiles", "application/octet-stream"}),
    "png": frozenset({"image/png"}),
    "jpeg": frozenset({"image/jpeg"}),
    "pdf": frozenset({"application/pdf"}),
    "odt": frozenset({"application/vnd.oasis.opendocument.text"}),
}


class DataPreservationStoreUnavailable(RuntimeError):
    pass


class DataPreservationAccessDenied(RuntimeError):
    pass


class DataPreservationNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class DataPreservationConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class WmsBoundedImageScope:
    bounds: tuple[float, float, float, float]
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ExactObjectScope:
    pass


@dataclass(frozen=True, slots=True)
class FeatureCollectionScope:
    bounds: tuple[float, float, float, float]
    maximum_features: int
    page_size: int


CopyScope = WmsBoundedImageScope | ExactObjectScope | FeatureCollectionScope


@dataclass(frozen=True, slots=True)
class CopyEstimateSpec:
    source_type: CopySourceType
    scope: CopyScope


@dataclass(frozen=True, slots=True)
class CopyEstimate:
    estimate_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    source_revision_number: int
    source_type: CopySourceType
    copy_method: CopyMethod
    capture_scope: dict[str, Any]
    output_format: CopyOutputFormat
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    created_by: UUID
    created_at: datetime
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ProtectedCopyRequest:
    estimate_id: UUID
    estimate_checksum_sha256: str
    idempotency_key: UUID
    destination_name: str
    destination_description: str | None
    destination_classification: DatasetClassification
    rights_basis: str
    attribution: str

    target_dataset_id: UUID | None = None
    expected_base_version_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ProtectedCopyJob:
    job_id: UUID
    project_id: UUID
    estimate_id: UUID
    source_dataset_id: UUID
    source_revision_number: int
    destination_dataset_id: UUID
    destination_name: str
    destination_classification: DatasetClassification
    copy_method: CopyMethod
    capture_scope: dict[str, Any]
    output_format: CopyOutputFormat
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    estimate_expires_at: datetime
    rights_basis: str
    attribution: str
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    output_object_id: UUID | None
    output_dataset_version_id: UUID | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeRequest:
    bounds: tuple[float, float, float, float]
    minimum_zoom: int
    maximum_zoom: int
    source_layer: str
    idempotency_key: UUID


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeJob:
    job_id: UUID
    project_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    source_object_id: UUID
    bounds: tuple[float, float, float, float]
    minimum_zoom: int
    maximum_zoom: int
    source_layer: str
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    output_object_id: UUID | None
    output_size_bytes: int | None
    output_checksum_sha256: str | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class ProtectedCopySubmission:
    job: ProtectedCopyJob
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class RepositoryCopyEstimate:
    estimate_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    connection_target_revision: int
    provider_version_id: str
    output_format: UploadDatasetFormat
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    created_by: UUID
    created_at: datetime
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class RepositoryProtectedCopyJob:
    job_id: UUID
    project_id: UUID
    estimate_id: UUID
    source_dataset_id: UUID
    destination_dataset_id: UUID
    destination_name: str
    destination_classification: DatasetClassification
    connection_target_revision: int
    provider_version_id: str
    output_format: UploadDatasetFormat
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    estimate_expires_at: datetime
    rights_basis: str
    attribution: str
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    output_object_id: UUID | None
    output_dataset_version_id: UUID | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class RepositoryProtectedCopySubmission:
    job: RepositoryProtectedCopyJob
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeSubmission:
    job: PmtilesDerivativeJob
    dispatch_required: bool


class DataPreservationRepository(Protocol):
    async def create_copy_estimate(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        source_revision_number: int,
        spec: CopyEstimateSpec,
        request_id: str,
    ) -> CopyEstimate: ...

    async def request_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        source_revision_number: int,
        request: ProtectedCopyRequest,
        request_id: str,
    ) -> ProtectedCopySubmission: ...

    async def list_protected_copies(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        page: Page,
    ) -> tuple[ProtectedCopyJob, ...]: ...

    async def get_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> ProtectedCopyJob: ...

    async def cancel_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> ProtectedCopyJob: ...

    async def create_repository_copy_estimate(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        request_id: str,
    ) -> RepositoryCopyEstimate: ...

    async def request_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        request: ProtectedCopyRequest,
        request_id: str,
    ) -> RepositoryProtectedCopySubmission: ...

    async def list_repository_protected_copies(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        page: Page,
    ) -> tuple[RepositoryProtectedCopyJob, ...]: ...

    async def get_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> RepositoryProtectedCopyJob: ...

    async def cancel_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> RepositoryProtectedCopyJob: ...

    async def request_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        request: PmtilesDerivativeRequest,
        request_id: str,
    ) -> PmtilesDerivativeSubmission: ...

    async def list_pmtiles_derivatives(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        page: Page,
    ) -> tuple[PmtilesDerivativeJob, ...]: ...

    async def get_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        job_id: UUID,
    ) -> PmtilesDerivativeJob: ...

    async def cancel_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> PmtilesDerivativeJob: ...


OperationResult = TypeVar("OperationResult")


@dataclass(frozen=True, slots=True)
class _DatasetAccess:
    roles: Roles
    source_type: str
    format: DatasetFormat
    status: DatasetStatus


@dataclass(frozen=True, slots=True)
class _PmtilesSource:
    object_id: UUID
    content_type: str
    size_bytes: int


class PostgresDataPreservationRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        destination_bucket: str | None,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._executor = executor
        self._destination_bucket = destination_bucket
        self._now = now or (lambda: datetime.now(UTC))

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise DataPreservationConflict("data_preservation_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise DataPreservationStoreUnavailable("data preservation operation failed") from error

    async def create_copy_estimate(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        source_revision_number: int,
        spec: CopyEstimateSpec,
        request_id: str,
    ) -> CopyEstimate:
        async def operation(transaction: TenantTransaction) -> CopyEstimate:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            source = await transaction.fetch_one(
                """
                SELECT source.source_type::text, revision.configuration
                FROM app.external_sources source
                JOIN app.external_source_revisions revision
                  ON revision.organization_id = source.organization_id
                 AND revision.dataset_id = source.dataset_id
                 AND revision.version_number = %s
                WHERE source.organization_id = %s AND source.dataset_id = %s
                """,
                (source_revision_number, context.organization_id, source_dataset_id),
            )
            if source is None:
                raise DataPreservationNotFound("external_source_revision")
            actual_source_type = cast(str, source[0])
            if actual_source_type not in {"wms", "pmtiles", "arcgis", "wfs"}:
                raise DataPreservationConflict("protected_copy_source_type_unsupported")
            if actual_source_type != spec.source_type:
                raise DataPreservationConflict("protected_copy_source_type_mismatch")
            source_configuration = source[1]
            if actual_source_type == "wms" and (
                not isinstance(source_configuration, dict)
                or source_configuration.get("format") != "image/png"
            ):
                raise DataPreservationConflict("protected_copy_wms_png_required")
            if actual_source_type in {"arcgis", "wfs"}:
                if not isinstance(source_configuration, dict):
                    raise DataPreservationConflict("protected_copy_feature_configuration_invalid")
                configured_page_size = source_configuration.get("page_size")
                if (
                    not isinstance(spec.scope, FeatureCollectionScope)
                    or isinstance(configured_page_size, bool)
                    or not isinstance(configured_page_size, int)
                    or spec.scope.page_size > configured_page_size
                ):
                    raise DataPreservationConflict("protected_copy_feature_scope_invalid")
            now = self._utc_now()
            estimate = seal_copy_estimate(
                estimate_id=uuid4(),
                project_id=project_id,
                source_dataset_id=source_dataset_id,
                source_revision_number=source_revision_number,
                spec=spec,
                created_by=context.user_id,
                created_at=now,
            )
            await transaction.execute(
                """
                INSERT INTO app.external_source_copy_estimates
                  (id, organization_id, project_id, source_dataset_id,
                   source_revision_number, copy_method, capture_scope,
                   output_format, output_content_type, maximum_requests,
                   maximum_output_bytes, estimated_cost_usd,
                   estimate_checksum_sha256, created_by, created_at, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s)
                """,
                (
                    estimate.estimate_id,
                    context.organization_id,
                    project_id,
                    source_dataset_id,
                    source_revision_number,
                    estimate.copy_method,
                    Jsonb(estimate.capture_scope),
                    estimate.output_format,
                    estimate.output_content_type,
                    estimate.maximum_requests,
                    estimate.maximum_output_bytes,
                    estimate.estimated_cost_usd,
                    estimate.estimate_checksum_sha256,
                    context.user_id,
                    estimate.created_at,
                    estimate.expires_at,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                "dataset.source.copy.estimate.created",
                source_dataset_id,
                request_id,
                {
                    "estimate_id": str(estimate.estimate_id),
                    "source_revision_number": source_revision_number,
                    "copy_method": estimate.copy_method,
                    "maximum_requests": estimate.maximum_requests,
                    "maximum_output_bytes": estimate.maximum_output_bytes,
                    "estimate_checksum_sha256": estimate.estimate_checksum_sha256,
                },
            )
            return estimate

        return await self._run(context, operation)

    async def request_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        source_revision_number: int,
        request: ProtectedCopyRequest,
        request_id: str,
    ) -> ProtectedCopySubmission:
        if (request.target_dataset_id is None) != (request.expected_base_version_id is None):
            raise DataPreservationConflict("source_refresh_target_incomplete")
        destination_bucket = self._destination_bucket
        if destination_bucket is None:
            raise DataPreservationStoreUnavailable("managed geodata storage is not configured")

        async def operation(transaction: TenantTransaction) -> ProtectedCopySubmission:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            if request.target_dataset_id is not None:
                target_access = await self._dataset_access(
                    transaction, context, project_id, request.target_dataset_id
                )
                self._require(Action.DATASET_EDIT, target_access.roles)
            estimate = await self._load_estimate(
                transaction,
                context,
                project_id,
                source_dataset_id,
                source_revision_number,
                request.estimate_id,
            )
            if estimate.created_by != context.user_id:
                raise DataPreservationAccessDenied("estimate belongs to another actor")
            if estimate.estimate_checksum_sha256 != request.estimate_checksum_sha256:
                raise DataPreservationConflict("protected_copy_estimate_checksum_mismatch")
            if estimate.expires_at <= self._utc_now():
                raise DataPreservationConflict("protected_copy_estimate_expired")
            checksum = protected_copy_request_checksum(
                project_id=project_id,
                source_dataset_id=source_dataset_id,
                source_revision_number=source_revision_number,
                request=request,
                destination_bucket=destination_bucket,
            )
            await self._request_locks(
                transaction,
                context,
                "protected-copy",
                project_id,
                request.idempotency_key,
                checksum,
            )
            existing = await transaction.fetch_one(
                f"""
                {self._snapshot_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND (job.idempotency_key = %s OR job.request_checksum_sha256 = %s)
                ORDER BY (job.idempotency_key = %s) DESC
                LIMIT 1
                """,
                (
                    context.organization_id,
                    project_id,
                    request.idempotency_key,
                    checksum,
                    request.idempotency_key,
                ),
            )
            if existing is not None:
                job = self._snapshot(existing)
                if job.request_checksum_sha256 != checksum:
                    raise DataPreservationConflict("protected_copy_idempotency_conflict")
                return ProtectedCopySubmission(job, job.state == "queued")

            destination_dataset_id = request.target_dataset_id or uuid4()
            target_row = None
            if request.target_dataset_id is not None:
                target_row = await transaction.fetch_one(
                    """SELECT name, classification::text FROM app.datasets
                    WHERE organization_id=%s AND id=%s AND current_version_id=%s
                      AND status='active' AND source_type='upload' AND format=%s
                    FOR UPDATE""",
                    (
                        context.organization_id,
                        destination_dataset_id,
                        request.expected_base_version_id,
                        estimate.output_format,
                    ),
                )
                if target_row is None or estimate.copy_method != "bounded_feature_capture":
                    raise DataPreservationConflict("source_refresh_target_changed")

            job_id = uuid4()
            created_at = self._utc_now()
            if request.target_dataset_id is None:
                await transaction.execute(
                    """
                    INSERT INTO app.datasets
                      (id, organization_id, name, description, classification,
                       source_type, format, status, owner_user_id, created_by, updated_by,
                       created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, 'upload', %s, 'draft', %s, %s, %s,
                            %s, %s)
                    """,
                    (
                        destination_dataset_id,
                        context.organization_id,
                        request.destination_name,
                        request.destination_description,
                        request.destination_classification,
                        estimate.output_format,
                        context.user_id,
                        context.user_id,
                        context.user_id,
                        created_at,
                        created_at,
                    ),
                )
                await transaction.execute(
                    """
                    INSERT INTO app.project_datasets
                      (organization_id, project_id, dataset_id, linked_by, linked_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        context.organization_id,
                        project_id,
                        destination_dataset_id,
                        context.user_id,
                        created_at,
                    ),
                )
            await transaction.execute(
                """
                INSERT INTO app.external_source_snapshot_jobs
                  (id, organization_id, project_id, estimate_id,
                   source_dataset_id, source_revision_number,
                   destination_dataset_id, destination_bucket, rights_basis,
                   attribution, request_checksum_sha256, idempotency_key,
                   request_id, created_by, created_at, staged_base_version_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s)
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    estimate.estimate_id,
                    source_dataset_id,
                    source_revision_number,
                    destination_dataset_id,
                    destination_bucket,
                    request.rights_basis,
                    request.attribution,
                    checksum,
                    request.idempotency_key,
                    request_id,
                    context.user_id,
                    created_at,
                    request.expected_base_version_id,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                "dataset.source.snapshot.requested",
                destination_dataset_id,
                request_id,
                {
                    "snapshot_job_id": str(job_id),
                    "estimate_id": str(estimate.estimate_id),
                    "source_dataset_id": str(source_dataset_id),
                    "source_revision_number": source_revision_number,
                    "request_checksum_sha256": checksum,
                },
            )
            job = ProtectedCopyJob(
                job_id=job_id,
                project_id=project_id,
                estimate_id=estimate.estimate_id,
                source_dataset_id=source_dataset_id,
                source_revision_number=source_revision_number,
                destination_dataset_id=destination_dataset_id,
                destination_name=target_row[0] if target_row else request.destination_name,
                destination_classification=target_row[1]
                if target_row
                else request.destination_classification,
                copy_method=estimate.copy_method,
                capture_scope=estimate.capture_scope,
                output_format=estimate.output_format,
                output_content_type=estimate.output_content_type,
                maximum_requests=estimate.maximum_requests,
                maximum_output_bytes=estimate.maximum_output_bytes,
                estimated_cost_usd=estimate.estimated_cost_usd,
                estimate_checksum_sha256=estimate.estimate_checksum_sha256,
                estimate_expires_at=estimate.expires_at,
                rights_basis=request.rights_basis,
                attribution=request.attribution,
                request_checksum_sha256=checksum,
                idempotency_key=request.idempotency_key,
                state="queued",
                output_object_id=None,
                output_dataset_version_id=None,
                error_code=None,
                attempt_count=0,
                created_by=context.user_id,
                created_at=created_at,
                started_at=None,
                finished_at=None,
            )
            return ProtectedCopySubmission(job, True)

        return await self._run(context, operation)

    async def list_protected_copies(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        page: Page,
    ) -> tuple[ProtectedCopyJob, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[ProtectedCopyJob, ...]:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            rows = await transaction.fetch_all(
                f"""
                {self._snapshot_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.source_dataset_id = %s
                ORDER BY job.created_at DESC, job.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    source_dataset_id,
                    page.limit,
                    page.offset,
                ),
            )
            return tuple(self._snapshot(row) for row in rows)

        return await self._run(context, operation)

    async def get_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> ProtectedCopyJob:
        async def operation(transaction: TenantTransaction) -> ProtectedCopyJob:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            return await self._load_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )

        return await self._run(context, operation)

    async def cancel_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> ProtectedCopyJob:
        async def operation(transaction: TenantTransaction) -> ProtectedCopyJob:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            current = await self._load_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )
            if current.state != "queued":
                raise DataPreservationConflict("protected_copy_not_cancellable")
            cancelled = await transaction.fetch_one(
                """
                SELECT app.cancel_external_source_snapshot(%s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    job_id,
                    context.user_id,
                    request_id,
                ),
            )
            if cancelled is None or not cast(bool, cancelled[0]):
                raise DataPreservationConflict("protected_copy_not_cancellable")
            return await self._load_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )

        return await self._run(context, operation)

    async def create_repository_copy_estimate(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        request_id: str,
    ) -> RepositoryCopyEstimate:
        async def operation(transaction: TenantTransaction) -> RepositoryCopyEstimate:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            if access.source_type != "repository" or access.status != "active":
                raise DataPreservationConflict("repository_copy_source_ineligible")
            source = await transaction.fetch_one(
                """
                SELECT source.connection_target_revision,
                       source.provider_version_id, source.size_bytes,
                       lower(source.content_type), dataset.format::text
                FROM app.repository_object_sources source
                JOIN app.datasets dataset
                  ON dataset.organization_id = source.organization_id
                 AND dataset.id = source.dataset_id
                WHERE source.organization_id = %s AND source.dataset_id = %s
                """,
                (context.organization_id, source_dataset_id),
            )
            if source is None:
                raise DataPreservationNotFound("repository_object_source")
            output_format = cast(UploadDatasetFormat, source[4])
            output_content_type = cast(str | None, source[3])
            maximum_output_bytes = cast(int, source[2])
            if (
                output_format not in _REPOSITORY_COPY_CONTENT_TYPES
                or output_content_type not in _REPOSITORY_COPY_CONTENT_TYPES[output_format]
                or not 1 <= maximum_output_bytes <= MAX_PROTECTED_COPY_BYTES
            ):
                raise DataPreservationConflict("repository_copy_source_ineligible")
            now = self._utc_now()
            estimated_cost = _estimated_copy_cost(maximum_output_bytes)
            checksum = repository_copy_estimate_checksum(
                project_id=project_id,
                source_dataset_id=source_dataset_id,
                connection_target_revision=cast(int, source[0]),
                provider_version_id=cast(str, source[1]),
                output_format=output_format,
                output_content_type=output_content_type,
                maximum_output_bytes=maximum_output_bytes,
                estimated_cost_usd=estimated_cost,
            )
            estimate = RepositoryCopyEstimate(
                estimate_id=uuid4(),
                project_id=project_id,
                source_dataset_id=source_dataset_id,
                connection_target_revision=cast(int, source[0]),
                provider_version_id=cast(str, source[1]),
                output_format=output_format,
                output_content_type=output_content_type,
                maximum_requests=1,
                maximum_output_bytes=maximum_output_bytes,
                estimated_cost_usd=estimated_cost,
                estimate_checksum_sha256=checksum,
                created_by=context.user_id,
                created_at=now,
                expires_at=now + ESTIMATE_LIFETIME,
            )
            await transaction.execute(
                """
                INSERT INTO app.repository_object_copy_estimates
                  (id, organization_id, project_id, source_dataset_id,
                   output_format, output_content_type, maximum_requests,
                   maximum_output_bytes, estimated_cost_usd,
                   estimate_checksum_sha256, created_by, created_at, expires_at)
                VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s, %s, %s, %s, %s)
                """,
                (
                    estimate.estimate_id,
                    context.organization_id,
                    project_id,
                    source_dataset_id,
                    output_format,
                    output_content_type,
                    maximum_output_bytes,
                    estimated_cost,
                    checksum,
                    context.user_id,
                    now,
                    estimate.expires_at,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                "dataset.repository.copy.estimate.created",
                source_dataset_id,
                request_id,
                {
                    "estimate_id": str(estimate.estimate_id),
                    "connection_target_revision": estimate.connection_target_revision,
                    "provider_version_id": estimate.provider_version_id,
                    "maximum_requests": 1,
                    "maximum_output_bytes": maximum_output_bytes,
                    "estimate_checksum_sha256": checksum,
                },
            )
            return estimate

        return await self._run(context, operation)

    async def request_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        request: ProtectedCopyRequest,
        request_id: str,
    ) -> RepositoryProtectedCopySubmission:
        destination_bucket = self._destination_bucket
        if destination_bucket is None:
            raise DataPreservationStoreUnavailable("managed geodata storage is not configured")

        async def operation(transaction: TenantTransaction) -> RepositoryProtectedCopySubmission:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            estimate = await self._load_repository_estimate(
                transaction, context, project_id, source_dataset_id, request.estimate_id
            )
            if estimate.created_by != context.user_id:
                raise DataPreservationAccessDenied("estimate belongs to another actor")
            if estimate.estimate_checksum_sha256 != request.estimate_checksum_sha256:
                raise DataPreservationConflict("repository_copy_estimate_checksum_mismatch")
            if estimate.expires_at <= self._utc_now():
                raise DataPreservationConflict("repository_copy_estimate_expired")
            checksum = repository_protected_copy_request_checksum(
                project_id=project_id,
                source_dataset_id=source_dataset_id,
                request=request,
                destination_bucket=destination_bucket,
            )
            await self._request_locks(
                transaction,
                context,
                "repository-protected-copy",
                project_id,
                request.idempotency_key,
                checksum,
            )
            existing = await transaction.fetch_one(
                f"""
                {self._repository_snapshot_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND (job.idempotency_key = %s OR job.request_checksum_sha256 = %s)
                ORDER BY (job.idempotency_key = %s) DESC
                LIMIT 1
                """,
                (
                    context.organization_id,
                    project_id,
                    request.idempotency_key,
                    checksum,
                    request.idempotency_key,
                ),
            )
            if existing is not None:
                job = self._repository_snapshot(existing)
                if job.request_checksum_sha256 != checksum:
                    raise DataPreservationConflict("repository_copy_idempotency_conflict")
                return RepositoryProtectedCopySubmission(job, job.state == "queued")

            destination_dataset_id = uuid4()
            job_id = uuid4()
            created_at = self._utc_now()
            await transaction.execute(
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, description, classification,
                   source_type, format, status, owner_user_id, created_by, updated_by,
                   created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, 'upload', %s, 'draft', %s, %s, %s,
                        %s, %s)
                """,
                (
                    destination_dataset_id,
                    context.organization_id,
                    request.destination_name,
                    request.destination_description,
                    request.destination_classification,
                    estimate.output_format,
                    context.user_id,
                    context.user_id,
                    context.user_id,
                    created_at,
                    created_at,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by, linked_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    destination_dataset_id,
                    context.user_id,
                    created_at,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.repository_object_copy_jobs
                  (id, organization_id, project_id, estimate_id,
                   source_dataset_id, destination_dataset_id, destination_bucket,
                   rights_basis, attribution, request_checksum_sha256,
                   idempotency_key, request_id, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    estimate.estimate_id,
                    source_dataset_id,
                    destination_dataset_id,
                    destination_bucket,
                    request.rights_basis,
                    request.attribution,
                    checksum,
                    request.idempotency_key,
                    request_id,
                    context.user_id,
                    created_at,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                "dataset.repository.copy.requested",
                destination_dataset_id,
                request_id,
                {
                    "copy_job_id": str(job_id),
                    "estimate_id": str(estimate.estimate_id),
                    "source_dataset_id": str(source_dataset_id),
                    "provider_version_id": estimate.provider_version_id,
                    "request_checksum_sha256": checksum,
                },
            )
            row = await transaction.fetch_one(
                f"""
                {self._repository_snapshot_select()}
                WHERE job.organization_id = %s AND job.id = %s
                """,
                (context.organization_id, job_id),
            )
            if row is None:
                raise DataPreservationStoreUnavailable("repository copy insert returned no row")
            return RepositoryProtectedCopySubmission(self._repository_snapshot(row), True)

        return await self._run(context, operation)

    async def list_repository_protected_copies(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        page: Page,
    ) -> tuple[RepositoryProtectedCopyJob, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[RepositoryProtectedCopyJob, ...]:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            rows = await transaction.fetch_all(
                f"""
                {self._repository_snapshot_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.source_dataset_id = %s
                ORDER BY job.created_at DESC, job.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    source_dataset_id,
                    page.limit,
                    page.offset,
                ),
            )
            return tuple(self._repository_snapshot(row) for row in rows)

        return await self._run(context, operation)

    async def get_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> RepositoryProtectedCopyJob:
        async def operation(transaction: TenantTransaction) -> RepositoryProtectedCopyJob:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            return await self._load_repository_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )

        return await self._run(context, operation)

    async def cancel_repository_protected_copy(
        self,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> RepositoryProtectedCopyJob:
        async def operation(transaction: TenantTransaction) -> RepositoryProtectedCopyJob:
            access = await self._dataset_access(transaction, context, project_id, source_dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            current = await self._load_repository_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )
            if current.state != "queued":
                raise DataPreservationConflict("repository_copy_not_cancellable")
            cancelled = await transaction.fetch_one(
                "SELECT app.cancel_repository_object_copy(%s, %s, %s, %s, %s, %s)",
                (
                    context.organization_id,
                    project_id,
                    source_dataset_id,
                    job_id,
                    context.user_id,
                    request_id,
                ),
            )
            if cancelled is None or not cast(bool, cancelled[0]):
                raise DataPreservationConflict("repository_copy_not_cancellable")
            return await self._load_repository_snapshot(
                transaction, context, project_id, source_dataset_id, job_id
            )

        return await self._run(context, operation)

    async def request_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        request: PmtilesDerivativeRequest,
        request_id: str,
    ) -> PmtilesDerivativeSubmission:
        async def operation(transaction: TenantTransaction) -> PmtilesDerivativeSubmission:
            access = await self._dataset_access(transaction, context, project_id, dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            source = await self._load_pmtiles_source(
                transaction,
                context,
                dataset_id,
                dataset_version_id,
                access,
            )
            checksum = pmtiles_derivative_request_checksum(
                project_id=project_id,
                dataset_id=dataset_id,
                dataset_version_id=dataset_version_id,
                source_object_id=source.object_id,
                request=request,
            )
            await self._request_locks(
                transaction,
                context,
                "pmtiles-derivative",
                project_id,
                request.idempotency_key,
                checksum,
            )
            existing = await transaction.fetch_one(
                f"""
                {self._pmtiles_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND (job.idempotency_key = %s OR job.request_checksum_sha256 = %s)
                ORDER BY (job.idempotency_key = %s) DESC
                LIMIT 1
                """,
                (
                    context.organization_id,
                    project_id,
                    request.idempotency_key,
                    checksum,
                    request.idempotency_key,
                ),
            )
            if existing is not None:
                job = self._pmtiles(existing)
                if job.request_checksum_sha256 != checksum:
                    raise DataPreservationConflict("pmtiles_derivative_idempotency_conflict")
                return PmtilesDerivativeSubmission(job, job.state == "queued")
            job_id = uuid4()
            created_at = self._utc_now()
            await transaction.execute(
                """
                INSERT INTO app.pmtiles_derivative_jobs
                  (id, organization_id, project_id, dataset_id,
                   dataset_version_id, source_object_id, bounds, minimum_zoom,
                   maximum_zoom, source_layer, request_checksum_sha256,
                   idempotency_key, request_id, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s)
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    dataset_id,
                    dataset_version_id,
                    source.object_id,
                    Jsonb(list(request.bounds)),
                    request.minimum_zoom,
                    request.maximum_zoom,
                    request.source_layer,
                    checksum,
                    request.idempotency_key,
                    request_id,
                    context.user_id,
                    created_at,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                "dataset.pmtiles.derivative.requested",
                dataset_id,
                request_id,
                {
                    "pmtiles_job_id": str(job_id),
                    "dataset_version_id": str(dataset_version_id),
                    "source_object_id": str(source.object_id),
                    "request_checksum_sha256": checksum,
                },
            )
            job = PmtilesDerivativeJob(
                job_id=job_id,
                project_id=project_id,
                dataset_id=dataset_id,
                dataset_version_id=dataset_version_id,
                source_object_id=source.object_id,
                bounds=request.bounds,
                minimum_zoom=request.minimum_zoom,
                maximum_zoom=request.maximum_zoom,
                source_layer=request.source_layer,
                request_checksum_sha256=checksum,
                idempotency_key=request.idempotency_key,
                state="queued",
                output_object_id=None,
                output_size_bytes=None,
                output_checksum_sha256=None,
                error_code=None,
                attempt_count=0,
                created_by=context.user_id,
                created_at=created_at,
                started_at=None,
                finished_at=None,
            )
            return PmtilesDerivativeSubmission(job, True)

        return await self._run(context, operation)

    async def list_pmtiles_derivatives(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        page: Page,
    ) -> tuple[PmtilesDerivativeJob, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[PmtilesDerivativeJob, ...]:
            access = await self._dataset_access(transaction, context, project_id, dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            rows = await transaction.fetch_all(
                f"""
                {self._pmtiles_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.dataset_id = %s AND job.dataset_version_id = %s
                ORDER BY job.created_at DESC, job.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.organization_id,
                    project_id,
                    dataset_id,
                    dataset_version_id,
                    page.limit,
                    page.offset,
                ),
            )
            return tuple(self._pmtiles(row) for row in rows)

        return await self._run(context, operation)

    async def get_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        job_id: UUID,
    ) -> PmtilesDerivativeJob:
        async def operation(transaction: TenantTransaction) -> PmtilesDerivativeJob:
            access = await self._dataset_access(transaction, context, project_id, dataset_id)
            self._require(Action.PROJECT_READ, access.roles)
            return await self._load_pmtiles(
                transaction, context, project_id, dataset_id, dataset_version_id, job_id
            )

        return await self._run(context, operation)

    async def cancel_pmtiles_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> PmtilesDerivativeJob:
        async def operation(transaction: TenantTransaction) -> PmtilesDerivativeJob:
            access = await self._dataset_access(transaction, context, project_id, dataset_id)
            self._require(Action.PROJECT_DATASETS_MANAGE, access.roles)
            current = await self._load_pmtiles(
                transaction, context, project_id, dataset_id, dataset_version_id, job_id
            )
            if current.state != "queued":
                raise DataPreservationConflict("pmtiles_derivative_not_cancellable")
            cancelled = await transaction.fetch_one(
                """
                SELECT app.cancel_pmtiles_derivative(%s, %s, %s, %s, %s, %s)
                """,
                (
                    context.organization_id,
                    project_id,
                    dataset_id,
                    job_id,
                    context.user_id,
                    request_id,
                ),
            )
            if cancelled is None or not cast(bool, cancelled[0]):
                raise DataPreservationConflict("pmtiles_derivative_not_cancellable")
            return await self._load_pmtiles(
                transaction, context, project_id, dataset_id, dataset_version_id, job_id
            )

        return await self._run(context, operation)

    async def _dataset_access(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> _DatasetAccess:
        row = await transaction.fetch_one(
            """
            SELECT membership.role::text,
                   app.effective_project_role(project.id, %s)::text,
                   permission.role::text,
                   dataset.owner_user_id = app.current_user_id(),
                   dataset.source_type::text, dataset.format::text,
                   dataset.status::text
            FROM app.organization_memberships membership
            JOIN app.projects project
              ON project.organization_id = membership.organization_id
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
             AND permission.user_id = app.current_user_id()
            WHERE membership.organization_id = %s AND membership.user_id = %s
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
            raise DataPreservationNotFound("dataset")
        return _DatasetAccess(
            roles=Roles(
                organization=cast(Any, row[0]),
                project=cast(ProjectRole | None, row[1]),
                dataset=cast(DatasetPermissionRole | None, row[2]),
                dataset_owner=cast(bool, row[3]),
            ),
            source_type=cast(str, row[4]),
            format=cast(DatasetFormat, row[5]),
            status=cast(DatasetStatus, row[6]),
        )

    async def _load_estimate(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        source_revision_number: int,
        estimate_id: UUID,
    ) -> CopyEstimate:
        row = await transaction.fetch_one(
            f"""
            {self._estimate_select()}
            WHERE estimate.organization_id = %s AND estimate.project_id = %s
              AND estimate.source_dataset_id = %s
              AND estimate.source_revision_number = %s AND estimate.id = %s
            """,
            (
                context.organization_id,
                project_id,
                source_dataset_id,
                source_revision_number,
                estimate_id,
            ),
        )
        if row is None:
            raise DataPreservationNotFound("protected_copy_estimate")
        return self._estimate(row)

    async def _load_snapshot(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> ProtectedCopyJob:
        row = await transaction.fetch_one(
            f"""
            {self._snapshot_select()}
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.source_dataset_id = %s AND job.id = %s
            """,
            (context.organization_id, project_id, source_dataset_id, job_id),
        )
        if row is None:
            raise DataPreservationNotFound("protected_copy")
        return self._snapshot(row)

    async def _load_repository_estimate(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        estimate_id: UUID,
    ) -> RepositoryCopyEstimate:
        row = await transaction.fetch_one(
            f"""
            {self._repository_estimate_select()}
            WHERE estimate.organization_id = %s AND estimate.project_id = %s
              AND estimate.source_dataset_id = %s AND estimate.id = %s
            """,
            (context.organization_id, project_id, source_dataset_id, estimate_id),
        )
        if row is None:
            raise DataPreservationNotFound("repository_copy_estimate")
        return self._repository_estimate(row)

    async def _load_repository_snapshot(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        source_dataset_id: UUID,
        job_id: UUID,
    ) -> RepositoryProtectedCopyJob:
        row = await transaction.fetch_one(
            f"""
            {self._repository_snapshot_select()}
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.source_dataset_id = %s AND job.id = %s
            """,
            (context.organization_id, project_id, source_dataset_id, job_id),
        )
        if row is None:
            raise DataPreservationNotFound("repository_protected_copy")
        return self._repository_snapshot(row)

    async def _load_pmtiles_source(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        dataset_version_id: UUID,
        access: _DatasetAccess,
    ) -> _PmtilesSource:
        row = await transaction.fetch_one(
            """
            SELECT version.state::text, version.original_object_id,
                   object.content_type, object.size_bytes
            FROM app.dataset_versions version
            JOIN app.data_objects object
              ON object.organization_id = version.organization_id
             AND object.dataset_id = version.dataset_id
             AND object.id = version.original_object_id
            WHERE version.organization_id = %s AND version.dataset_id = %s
              AND version.id = %s
            """,
            (context.organization_id, dataset_id, dataset_version_id),
        )
        if row is None:
            raise DataPreservationNotFound("dataset_version")
        content_type = cast(str, row[2])
        size_bytes = cast(int, row[3])
        if (
            access.source_type != "upload"
            or access.status != "active"
            or cast(str, row[0]) != "active"
            or content_type not in _PMTILES_SOURCE_CONTENT_TYPES
            or not 1 <= size_bytes <= MAX_PROTECTED_COPY_BYTES
        ):
            raise DataPreservationConflict("pmtiles_derivative_source_ineligible")
        return _PmtilesSource(cast(UUID, row[1]), content_type, size_bytes)

    async def _load_pmtiles(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        dataset_version_id: UUID,
        job_id: UUID,
    ) -> PmtilesDerivativeJob:
        row = await transaction.fetch_one(
            f"""
            {self._pmtiles_select()}
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.dataset_id = %s AND job.dataset_version_id = %s
              AND job.id = %s
            """,
            (
                context.organization_id,
                project_id,
                dataset_id,
                dataset_version_id,
                job_id,
            ),
        )
        if row is None:
            raise DataPreservationNotFound("pmtiles_derivative")
        return self._pmtiles(row)

    @staticmethod
    async def _request_locks(
        transaction: TenantTransaction,
        context: TenantContext,
        kind: str,
        project_id: UUID,
        idempotency_key: UUID,
        request_checksum_sha256: str,
    ) -> None:
        lock_keys = (
            f"{kind}:idempotency:{context.organization_id}:{project_id}:{idempotency_key}",
            f"{kind}:checksum:{context.organization_id}:{request_checksum_sha256}",
        )
        for lock_key in lock_keys:
            await transaction.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (lock_key,),
            )

    @staticmethod
    def _estimate_select() -> str:
        return """
            SELECT estimate.id, estimate.project_id, estimate.source_dataset_id,
                   estimate.source_revision_number, source.source_type::text,
                   estimate.copy_method, estimate.capture_scope,
                   estimate.output_format::text, estimate.output_content_type,
                   estimate.maximum_requests, estimate.maximum_output_bytes,
                   estimate.estimated_cost_usd, estimate.estimate_checksum_sha256,
                   estimate.created_by, estimate.created_at, estimate.expires_at
            FROM app.external_source_copy_estimates estimate
            JOIN app.external_sources source
              ON source.organization_id = estimate.organization_id
             AND source.dataset_id = estimate.source_dataset_id
        """

    @staticmethod
    def _snapshot_select() -> str:
        return """
            SELECT job.id, job.project_id, job.estimate_id,
                   job.source_dataset_id, job.source_revision_number,
                   job.destination_dataset_id, destination.name,
                   destination.classification::text, estimate.copy_method,
                   estimate.capture_scope, estimate.output_format::text,
                   estimate.output_content_type, estimate.maximum_requests,
                   estimate.maximum_output_bytes, estimate.estimated_cost_usd,
                   estimate.estimate_checksum_sha256, estimate.expires_at,
                   job.rights_basis, job.attribution, job.request_checksum_sha256,
                   job.idempotency_key, job.state::text, job.output_object_id,
                   job.output_dataset_version_id, job.error_code, job.attempt_count,
                   job.created_by, job.created_at, job.started_at, job.finished_at
            FROM app.external_source_snapshot_jobs job
            JOIN app.external_source_copy_estimates estimate
              ON estimate.organization_id = job.organization_id
             AND estimate.id = job.estimate_id
            JOIN app.datasets destination
              ON destination.organization_id = job.organization_id
             AND destination.id = job.destination_dataset_id
        """

    @staticmethod
    def _repository_estimate_select() -> str:
        return """
            SELECT estimate.id, estimate.project_id, estimate.source_dataset_id,
                   source.connection_target_revision, source.provider_version_id,
                   estimate.output_format::text, estimate.output_content_type,
                   estimate.maximum_requests, estimate.maximum_output_bytes,
                   estimate.estimated_cost_usd, estimate.estimate_checksum_sha256,
                   estimate.created_by, estimate.created_at, estimate.expires_at
            FROM app.repository_object_copy_estimates estimate
            JOIN app.repository_object_sources source
              ON source.organization_id = estimate.organization_id
             AND source.dataset_id = estimate.source_dataset_id
        """

    @staticmethod
    def _repository_snapshot_select() -> str:
        return """
            SELECT job.id, job.project_id, job.estimate_id,
                   job.source_dataset_id, job.destination_dataset_id,
                   destination.name, destination.classification::text,
                   source.connection_target_revision, source.provider_version_id,
                   estimate.output_format::text, estimate.output_content_type,
                   estimate.maximum_requests, estimate.maximum_output_bytes,
                   estimate.estimated_cost_usd, estimate.estimate_checksum_sha256,
                   estimate.expires_at, job.rights_basis, job.attribution,
                   job.request_checksum_sha256, job.idempotency_key,
                   job.state::text, job.output_object_id,
                   job.output_dataset_version_id, job.error_code, job.attempt_count,
                   job.created_by, job.created_at, job.started_at, job.finished_at
            FROM app.repository_object_copy_jobs job
            JOIN app.repository_object_copy_estimates estimate
              ON estimate.organization_id = job.organization_id
             AND estimate.id = job.estimate_id
            JOIN app.repository_object_sources source
              ON source.organization_id = job.organization_id
             AND source.dataset_id = job.source_dataset_id
            JOIN app.datasets destination
              ON destination.organization_id = job.organization_id
             AND destination.id = job.destination_dataset_id
        """

    @staticmethod
    def _pmtiles_select() -> str:
        return """
            SELECT job.id, job.project_id, job.dataset_id,
                   job.dataset_version_id, job.source_object_id, job.bounds,
                   job.minimum_zoom, job.maximum_zoom, job.source_layer,
                   job.request_checksum_sha256, job.idempotency_key,
                   job.state::text, job.output_object_id, job.output_size_bytes,
                   job.output_checksum_sha256, job.error_code, job.attempt_count,
                   job.created_by, job.created_at, job.started_at, job.finished_at
            FROM app.pmtiles_derivative_jobs job
        """

    @staticmethod
    def _estimate(row: tuple[Any, ...]) -> CopyEstimate:
        return CopyEstimate(
            estimate_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            source_dataset_id=cast(UUID, row[2]),
            source_revision_number=cast(int, row[3]),
            source_type=cast(CopySourceType, row[4]),
            copy_method=cast(CopyMethod, row[5]),
            capture_scope=cast(dict[str, Any], row[6]),
            output_format=cast(CopyOutputFormat, row[7]),
            output_content_type=cast(str, row[8]),
            maximum_requests=cast(int, row[9]),
            maximum_output_bytes=cast(int, row[10]),
            estimated_cost_usd=cast(Decimal, row[11]),
            estimate_checksum_sha256=cast(str, row[12]),
            created_by=cast(UUID, row[13]),
            created_at=cast(datetime, row[14]),
            expires_at=cast(datetime, row[15]),
        )

    @staticmethod
    def _snapshot(row: tuple[Any, ...]) -> ProtectedCopyJob:
        return ProtectedCopyJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            estimate_id=cast(UUID, row[2]),
            source_dataset_id=cast(UUID, row[3]),
            source_revision_number=cast(int, row[4]),
            destination_dataset_id=cast(UUID, row[5]),
            destination_name=cast(str, row[6]),
            destination_classification=cast(DatasetClassification, row[7]),
            copy_method=cast(CopyMethod, row[8]),
            capture_scope=cast(dict[str, Any], row[9]),
            output_format=cast(CopyOutputFormat, row[10]),
            output_content_type=cast(str, row[11]),
            maximum_requests=cast(int, row[12]),
            maximum_output_bytes=cast(int, row[13]),
            estimated_cost_usd=cast(Decimal, row[14]),
            estimate_checksum_sha256=cast(str, row[15]),
            estimate_expires_at=cast(datetime, row[16]),
            rights_basis=cast(str, row[17]),
            attribution=cast(str, row[18]),
            request_checksum_sha256=cast(str, row[19]),
            idempotency_key=cast(UUID, row[20]),
            state=cast(ProcessingJobState, row[21]),
            output_object_id=cast(UUID | None, row[22]),
            output_dataset_version_id=cast(UUID | None, row[23]),
            error_code=cast(str | None, row[24]),
            attempt_count=cast(int, row[25]),
            created_by=cast(UUID, row[26]),
            created_at=cast(datetime, row[27]),
            started_at=cast(datetime | None, row[28]),
            finished_at=cast(datetime | None, row[29]),
        )

    @staticmethod
    def _repository_estimate(row: tuple[Any, ...]) -> RepositoryCopyEstimate:
        return RepositoryCopyEstimate(
            estimate_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            source_dataset_id=cast(UUID, row[2]),
            connection_target_revision=cast(int, row[3]),
            provider_version_id=cast(str, row[4]),
            output_format=cast(UploadDatasetFormat, row[5]),
            output_content_type=cast(str, row[6]),
            maximum_requests=cast(int, row[7]),
            maximum_output_bytes=cast(int, row[8]),
            estimated_cost_usd=cast(Decimal, row[9]),
            estimate_checksum_sha256=cast(str, row[10]),
            created_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            expires_at=cast(datetime, row[13]),
        )

    @staticmethod
    def _repository_snapshot(row: tuple[Any, ...]) -> RepositoryProtectedCopyJob:
        return RepositoryProtectedCopyJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            estimate_id=cast(UUID, row[2]),
            source_dataset_id=cast(UUID, row[3]),
            destination_dataset_id=cast(UUID, row[4]),
            destination_name=cast(str, row[5]),
            destination_classification=cast(DatasetClassification, row[6]),
            connection_target_revision=cast(int, row[7]),
            provider_version_id=cast(str, row[8]),
            output_format=cast(UploadDatasetFormat, row[9]),
            output_content_type=cast(str, row[10]),
            maximum_requests=cast(int, row[11]),
            maximum_output_bytes=cast(int, row[12]),
            estimated_cost_usd=cast(Decimal, row[13]),
            estimate_checksum_sha256=cast(str, row[14]),
            estimate_expires_at=cast(datetime, row[15]),
            rights_basis=cast(str, row[16]),
            attribution=cast(str, row[17]),
            request_checksum_sha256=cast(str, row[18]),
            idempotency_key=cast(UUID, row[19]),
            state=cast(ProcessingJobState, row[20]),
            output_object_id=cast(UUID | None, row[21]),
            output_dataset_version_id=cast(UUID | None, row[22]),
            error_code=cast(str | None, row[23]),
            attempt_count=cast(int, row[24]),
            created_by=cast(UUID, row[25]),
            created_at=cast(datetime, row[26]),
            started_at=cast(datetime | None, row[27]),
            finished_at=cast(datetime | None, row[28]),
        )

    @staticmethod
    def _pmtiles(row: tuple[Any, ...]) -> PmtilesDerivativeJob:
        bounds = cast(list[float], row[5])
        return PmtilesDerivativeJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            dataset_id=cast(UUID, row[2]),
            dataset_version_id=cast(UUID, row[3]),
            source_object_id=cast(UUID, row[4]),
            bounds=(bounds[0], bounds[1], bounds[2], bounds[3]),
            minimum_zoom=cast(int, row[6]),
            maximum_zoom=cast(int, row[7]),
            source_layer=cast(str, row[8]),
            request_checksum_sha256=cast(str, row[9]),
            idempotency_key=cast(UUID, row[10]),
            state=cast(ProcessingJobState, row[11]),
            output_object_id=cast(UUID | None, row[12]),
            output_size_bytes=cast(int | None, row[13]),
            output_checksum_sha256=cast(str | None, row[14]),
            error_code=cast(str | None, row[15]),
            attempt_count=cast(int, row[16]),
            created_by=cast(UUID, row[17]),
            created_at=cast(datetime, row[18]),
            started_at=cast(datetime | None, row[19]),
            finished_at=cast(datetime | None, row[20]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise DataPreservationAccessDenied("action forbidden") from error

    @staticmethod
    async def _event(
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

    def _utc_now(self) -> datetime:
        value = self._now().astimezone(UTC)
        return value


def seal_copy_estimate(
    *,
    estimate_id: UUID,
    project_id: UUID,
    source_dataset_id: UUID,
    source_revision_number: int,
    spec: CopyEstimateSpec,
    created_by: UUID,
    created_at: datetime,
) -> CopyEstimate:
    if source_revision_number < 1:
        raise ValueError("source revision number must be positive")
    if spec.source_type == "wms":
        if not isinstance(spec.scope, WmsBoundedImageScope):
            raise ValueError("WMS protected copies require a bounded image scope")
        _validate_web_mercator_bounds(spec.scope.bounds)
        if (
            not 1 <= spec.scope.width <= MAX_WMS_DIMENSION
            or not 1 <= spec.scope.height <= MAX_WMS_DIMENSION
            or spec.scope.width * spec.scope.height > MAX_WMS_PIXELS
        ):
            raise ValueError("WMS protected-copy dimensions are outside the bounded pixel limit")
        capture_scope: dict[str, Any] = {
            "kind": "bounded_image",
            "bounds": list(spec.scope.bounds),
            "width": spec.scope.width,
            "height": spec.scope.height,
        }
        copy_method: CopyMethod = "bounded_map_capture"
        output_format: CopyOutputFormat = "png"
        output_content_type = "image/png"
        maximum_requests = 1
        maximum_output_bytes = min(
            MAX_PROTECTED_COPY_BYTES,
            spec.scope.width * spec.scope.height * 4 + 65_536,
        )
    elif spec.source_type == "pmtiles":
        if not isinstance(spec.scope, ExactObjectScope):
            raise ValueError("PMTiles protected copies require an exact-object scope")
        capture_scope = {"kind": "exact_object"}
        copy_method = "exact_object_copy"
        output_format = "pmtiles"
        output_content_type = "application/vnd.pmtiles"
        maximum_requests = 1
        maximum_output_bytes = MAX_PROTECTED_COPY_BYTES
    elif spec.source_type in {"arcgis", "wfs"}:
        if not isinstance(spec.scope, FeatureCollectionScope):
            raise ValueError("feature-service protected copies require a bounded feature scope")
        _validate_bounds(spec.scope.bounds)
        if (
            not 1 <= spec.scope.maximum_features <= MAX_FEATURE_COPY_COUNT
            or not 1 <= spec.scope.page_size <= MAX_FEATURE_COPY_PAGE_SIZE
        ):
            raise ValueError("feature protected-copy limits are outside the accepted range")
        maximum_requests = (
            spec.scope.maximum_features + spec.scope.page_size - 1
        ) // spec.scope.page_size
        if spec.source_type == "arcgis":
            maximum_requests += 1  # independent count uses the same bounded query scope
        if maximum_requests > MAX_FEATURE_COPY_REQUESTS:
            raise ValueError("feature protected-copy request count exceeds the accepted limit")
        capture_scope = {
            "kind": "bounded_features",
            "bounds": list(spec.scope.bounds),
            "maximum_features": spec.scope.maximum_features,
            "page_size": spec.scope.page_size,
        }
        copy_method = "bounded_feature_capture"
        output_format = "geojson"
        output_content_type = "application/geo+json"
        maximum_output_bytes = min(
            134_217_728,
            spec.scope.maximum_features * 16_384 + 65_536,
        )
    else:
        raise ValueError("protected-copy source type is unsupported")
    estimated_cost = _estimated_copy_cost(maximum_output_bytes)
    checksum = _checksum(
        {
            "schema": "opengeo.external-source-copy-estimate.1.0.0",
            "project_id": str(project_id),
            "source_dataset_id": str(source_dataset_id),
            "source_revision_number": source_revision_number,
            "source_type": spec.source_type,
            "copy_method": copy_method,
            "capture_scope": capture_scope,
            "output_format": output_format,
            "output_content_type": output_content_type,
            "maximum_requests": maximum_requests,
            "maximum_output_bytes": maximum_output_bytes,
            "estimated_cost_usd": format(estimated_cost, "f"),
        }
    )
    normalized_created_at = created_at.astimezone(UTC)
    return CopyEstimate(
        estimate_id=estimate_id,
        project_id=project_id,
        source_dataset_id=source_dataset_id,
        source_revision_number=source_revision_number,
        source_type=spec.source_type,
        copy_method=copy_method,
        capture_scope=capture_scope,
        output_format=output_format,
        output_content_type=output_content_type,
        maximum_requests=maximum_requests,
        maximum_output_bytes=maximum_output_bytes,
        estimated_cost_usd=estimated_cost,
        estimate_checksum_sha256=checksum,
        created_by=created_by,
        created_at=normalized_created_at,
        expires_at=normalized_created_at + ESTIMATE_LIFETIME,
    )


def protected_copy_request_checksum(
    *,
    project_id: UUID,
    source_dataset_id: UUID,
    source_revision_number: int,
    request: ProtectedCopyRequest,
    destination_bucket: str,
) -> str:
    return _checksum(
        {
            "schema": "opengeo.protected-copy-request.1.0.0",
            "project_id": str(project_id),
            "source_dataset_id": str(source_dataset_id),
            "source_revision_number": source_revision_number,
            "estimate_id": str(request.estimate_id),
            "estimate_checksum_sha256": request.estimate_checksum_sha256,
            "destination": {
                "name": request.destination_name,
                "description": request.destination_description,
                "classification": request.destination_classification,
                "bucket": destination_bucket,
            },
            **(
                {
                    "refresh_target": {
                        "dataset_id": str(request.target_dataset_id),
                        "base_version_id": str(request.expected_base_version_id),
                    }
                }
                if request.target_dataset_id is not None
                else {}
            ),
            "rights": {
                "basis": request.rights_basis,
                "attribution": request.attribution,
            },
        }
    )


def repository_copy_estimate_checksum(
    *,
    project_id: UUID,
    source_dataset_id: UUID,
    connection_target_revision: int,
    provider_version_id: str,
    output_format: UploadDatasetFormat,
    output_content_type: str,
    maximum_output_bytes: int,
    estimated_cost_usd: Decimal,
) -> str:
    return _checksum(
        {
            "schema": "opengeo.repository-object-copy-estimate.1.0.0",
            "project_id": str(project_id),
            "source_dataset_id": str(source_dataset_id),
            "connection_target_revision": connection_target_revision,
            "provider_version_id": provider_version_id,
            "copy_method": "exact_object_copy",
            "output_format": output_format,
            "output_content_type": output_content_type,
            "maximum_requests": 1,
            "maximum_output_bytes": maximum_output_bytes,
            "estimated_cost_usd": format(estimated_cost_usd, "f"),
        }
    )


def repository_protected_copy_request_checksum(
    *,
    project_id: UUID,
    source_dataset_id: UUID,
    request: ProtectedCopyRequest,
    destination_bucket: str,
) -> str:
    return _checksum(
        {
            "schema": "opengeo.repository-object-protected-copy-request.1.0.0",
            "project_id": str(project_id),
            "source_dataset_id": str(source_dataset_id),
            "estimate_id": str(request.estimate_id),
            "estimate_checksum_sha256": request.estimate_checksum_sha256,
            "destination": {
                "name": request.destination_name,
                "description": request.destination_description,
                "classification": request.destination_classification,
                "bucket": destination_bucket,
            },
            "rights": {
                "basis": request.rights_basis,
                "attribution": request.attribution,
            },
        }
    )


def pmtiles_derivative_request_checksum(
    *,
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    source_object_id: UUID,
    request: PmtilesDerivativeRequest,
) -> str:
    return sha256(
        pmtiles_derivative_request_canonical_bytes(
            project_id=project_id,
            dataset_id=dataset_id,
            dataset_version_id=dataset_version_id,
            source_object_id=source_object_id,
            request=request,
        )
    ).hexdigest()


def pmtiles_derivative_request_canonical_bytes(
    *,
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    source_object_id: UUID,
    request: PmtilesDerivativeRequest,
) -> bytes:
    """Return the versioned, plain-decimal JSON hashed by API and worker."""
    _validate_bounds(request.bounds)
    if (
        not 0 <= request.minimum_zoom <= request.maximum_zoom <= MAX_PM_TILES_ZOOM
        or not request.source_layer
        or request.source_layer != request.source_layer.strip()
        or len(request.source_layer) > 200
        or request.source_layer.startswith("-")
        or any(ord(character) < 32 or ord(character) == 127 for character in request.source_layer)
    ):
        raise ValueError("PMTiles derivative parameters are outside supported bounds")
    return canonical_json_bytes(
        {
            "schema": PMTILES_DERIVATIVE_REQUEST_SCHEMA,
            "recipe": PMTILES_DERIVATIVE_RECIPE,
            "project_id": str(project_id),
            "dataset_id": str(dataset_id),
            "dataset_version_id": str(dataset_version_id),
            "source_object_id": str(source_object_id),
            "bounds": list(request.bounds),
            "minimum_zoom": request.minimum_zoom,
            "maximum_zoom": request.maximum_zoom,
            "source_layer": request.source_layer,
        }
    )


def _validate_bounds(bounds: tuple[float, float, float, float]) -> None:
    west, south, east, north = bounds
    if not -180 <= west < east <= 180 or not -90 <= south < north <= 90:
        raise ValueError("bounds must be ordered WGS84 coordinates")


def _validate_web_mercator_bounds(bounds: tuple[float, float, float, float]) -> None:
    _validate_bounds(bounds)
    if bounds[1] < -WEB_MERCATOR_MAX_LATITUDE or bounds[3] > WEB_MERCATOR_MAX_LATITUDE:
        raise ValueError("bounds exceed the EPSG:3857 latitude limit")


def _estimated_copy_cost(maximum_output_bytes: int) -> Decimal:
    storage = Decimal(maximum_output_bytes) / Decimal(1_000_000_000)
    return (storage * _STORAGE_USD_PER_GB_MONTH + _PUT_REQUEST_USD).quantize(
        _USD_QUANTUM, rounding=ROUND_CEILING
    )


def _checksum(value: dict[str, Any]) -> str:
    return sha256(canonical_json_bytes(value)).hexdigest()
