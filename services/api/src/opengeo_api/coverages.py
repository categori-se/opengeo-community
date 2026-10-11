import hashlib
import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from typing import Any, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    Roles,
    authorize,
)
from opengeo_api.s3_downloads import (
    DownloadSpec,
    DownloadStorage,
    DownloadStorageUnavailable,
    DownloadTicket,
    ExactObject,
    ExactObjectSpec,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


class CoverageStoreUnavailable(RuntimeError):
    pass


class CoverageAccessDenied(RuntimeError):
    pass


class CoverageNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class CoverageConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


MAX_DERIVATIVE_AXIS_PIXELS = 8_192
MAX_DERIVATIVE_PIXELS = 16_777_216
MAX_DERIVATIVE_SAMPLES = 67_108_864
MAX_DERIVATIVE_JOBS_PER_COVERAGE = 64
MAX_ACTIVE_DERIVATIVE_JOBS_PER_COVERAGE = 4
MINIMUM_DERIVATIVE_RECLAMATION_AGE = timedelta(hours=24)
DERIVATIVE_RECLAMATION_PREVIEW_TTL = timedelta(minutes=15)


@dataclass(frozen=True, slots=True)
class SpatialCoverage:
    coverage_id: UUID
    project_id: UUID
    service_id: UUID
    coverage_name: str
    dataset_id: UUID
    dataset_version_id: UUID
    data_object_id: UUID
    sealed_dataset_version_number: int
    crs: str
    extent: tuple[float, float, float, float]
    width: int
    height: int
    band_count: int
    bands: tuple[dict[str, Any], ...]
    bucket: str
    object_key: str
    storage_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    current_dataset_version_id: UUID
    current_dataset_version_number: int
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None
    target_active: bool
    metadata_resource_id: UUID | None = None

    @property
    def stale(self) -> bool:
        return (
            not self.target_active
            or self.current_dataset_version_id != self.dataset_version_id
            or self.current_dataset_version_number != self.sealed_dataset_version_number
        )


@dataclass(frozen=True, slots=True)
class CoverageDerivativeSpec:
    subset_extent: tuple[float, float, float, float]
    target_crs: str
    width: int | None
    height: int | None
    resolution: tuple[float, float] | None
    band_indexes: tuple[int, ...] | None
    resampling: str

    def materialize(self, coverage: SpatialCoverage) -> "CoverageDerivativeRequest":
        band_indexes = self.band_indexes or tuple(range(1, coverage.band_count + 1))
        if not band_indexes or band_indexes != tuple(sorted(set(band_indexes))):
            raise CoverageConflict("spatial_coverage_derivative_range_invalid")
        if band_indexes[0] < 1 or band_indexes[-1] > coverage.band_count:
            raise CoverageConflict("spatial_coverage_derivative_range_invalid")
        if self.resolution is None:
            if self.width is None or self.height is None:
                raise CoverageConflict("spatial_coverage_derivative_scale_invalid")
            width, height = self.width, self.height
            scale_mode = "size"
        else:
            if (
                self.width is not None
                or self.height is not None
                or self.target_crs != coverage.crs
                or not all(math.isfinite(value) and 0 < value <= 1e100 for value in self.resolution)
            ):
                raise CoverageConflict("spatial_coverage_derivative_resolution_crs_invalid")
            west, south, east, north = (Decimal(str(value)) for value in self.subset_extent)
            resolution_x, resolution_y = (Decimal(str(value)) for value in self.resolution)
            width = int(((east - west) / resolution_x).to_integral_value(rounding=ROUND_CEILING))
            height = int(((north - south) / resolution_y).to_integral_value(rounding=ROUND_CEILING))
            scale_mode = "resolution"
        if (
            not 1 <= width <= MAX_DERIVATIVE_AXIS_PIXELS
            or not 1 <= height <= MAX_DERIVATIVE_AXIS_PIXELS
            or width * height > MAX_DERIVATIVE_PIXELS
            or width * height * len(band_indexes) > MAX_DERIVATIVE_SAMPLES
        ):
            raise CoverageConflict("spatial_coverage_derivative_scale_invalid")
        return CoverageDerivativeRequest(
            subset_extent=self.subset_extent,
            target_crs=self.target_crs,
            width=width,
            height=height,
            resampling=self.resampling,
            request_schema_version=2,
            band_indexes=band_indexes,
            scale_mode=scale_mode,
            resolution=self.resolution,
        )


@dataclass(frozen=True, slots=True)
class CoverageDerivativeRequest:
    subset_extent: tuple[float, float, float, float]
    target_crs: str
    width: int
    height: int
    resampling: str
    request_schema_version: int
    band_indexes: tuple[int, ...]
    scale_mode: str
    resolution: tuple[float, float] | None

    @property
    def checksum_sha256(self) -> str:
        document: dict[str, object] = {
            "height": self.height,
            "resampling": self.resampling,
            "subset": [format(value, ".15g") for value in self.subset_extent],
            "target_crs": self.target_crs,
            "width": self.width,
        }
        if self.request_schema_version == 2:
            document.update(
                {
                    "band_indexes": list(self.band_indexes),
                    "resolution": (
                        None
                        if self.resolution is None
                        else [format(value, ".15g") for value in self.resolution]
                    ),
                    "scale_mode": self.scale_mode,
                }
            )
        body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode()
        return hashlib.sha256(body).hexdigest()


@dataclass(frozen=True, slots=True)
class CoverageProcessingPolicy:
    request_schema_version: int = 2
    maximum_axis_pixels: int = MAX_DERIVATIVE_AXIS_PIXELS
    maximum_pixels: int = MAX_DERIVATIVE_PIXELS
    maximum_samples: int = MAX_DERIVATIVE_SAMPLES
    maximum_retained_jobs_per_coverage: int = MAX_DERIVATIVE_JOBS_PER_COVERAGE
    maximum_active_jobs_per_coverage: int = MAX_ACTIVE_DERIVATIVE_JOBS_PER_COVERAGE
    maximum_output_bytes: int = 536_870_912
    supported_resampling: tuple[str, ...] = ("nearest", "bilinear", "cubic")
    cancellation_states: tuple[str, ...] = ("queued",)
    minimum_reclamation_age_hours: int = 24
    reclamation_preview_ttl_seconds: int = 900
    physical_reclamation: str = "preview_then_explicit_exact_version_worker_delete"
    ordinary_reads_create_work: bool = False


@dataclass(frozen=True, slots=True)
class CoverageDerivativeJob:
    job_id: UUID
    project_id: UUID
    service_id: UUID
    coverage_id: UUID
    coverage_name: str
    request: CoverageDerivativeRequest
    request_checksum_sha256: str
    state: str
    output_object_id: UUID | None
    output_crs: str | None
    output_extent: tuple[float, float, float, float] | None
    output_width: int | None
    output_height: int | None
    output_band_count: int | None
    output_bands: tuple[dict[str, Any], ...] | None
    output_content_type: str | None
    output_size_bytes: int | None
    output_checksum_sha256: str | None
    output_bucket: str | None
    output_object_key: str | None
    output_storage_version_id: str | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    source_available: bool
    reclamation_state: str | None
    output_available: bool


@dataclass(frozen=True, slots=True)
class CoverageDerivativeSubmission:
    job: CoverageDerivativeJob
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class CoverageDerivativeReclamationPreview:
    derivative_job_id: UUID
    output_object_id: UUID
    size_bytes: int
    checksum_sha256: str
    derivative_finished_at: datetime
    expires_at: datetime
    preview_checksum_sha256: str
    physical_action: str = "delete_exact_storage_version"
    history_retained: bool = True
    ordinary_reads_create_work: bool = False


@dataclass(frozen=True, slots=True)
class CoverageDerivativeReclamation:
    reclamation_id: UUID
    derivative_job_id: UUID
    output_object_id: UUID
    state: str
    size_bytes: int
    checksum_sha256: str
    preview_checksum_sha256: str
    preview_expires_at: datetime
    error_code: str | None
    attempt_count: int
    delete_started_at: datetime | None
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class CoverageDerivativeReclamationSubmission:
    reclamation: CoverageDerivativeReclamation
    dispatch_required: bool


class CoverageRepository(Protocol):
    async def create_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_name: str,
        dataset_id: UUID,
        dataset_version_id: UUID,
        data_object_id: UUID,
        expected_dataset_version: int,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialCoverage: ...

    async def list_coverages(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        include_withdrawn: bool,
    ) -> tuple[SpatialCoverage, ...]: ...

    async def resolve_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
    ) -> SpatialCoverage: ...

    async def withdraw_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request_id: str,
    ) -> SpatialCoverage: ...

    async def request_coverage_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
        request_id: str,
    ) -> DownloadTicket: ...

    async def read_coverage_object(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
        maximum_bytes: int,
    ) -> ExactObject: ...

    async def request_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request: CoverageDerivativeSpec,
        request_id: str,
    ) -> CoverageDerivativeSubmission: ...

    async def find_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request: CoverageDerivativeSpec,
    ) -> CoverageDerivativeJob | None: ...

    async def get_processing_policy(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> CoverageProcessingPolicy: ...

    async def list_derivatives(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
    ) -> tuple[CoverageDerivativeJob, ...]: ...

    async def get_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
    ) -> CoverageDerivativeJob: ...

    async def cancel_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> CoverageDerivativeJob: ...

    async def request_derivative_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket: ...

    async def read_derivative_object(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
    ) -> ExactObject: ...

    async def preview_derivative_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
    ) -> CoverageDerivativeReclamationPreview: ...

    async def confirm_derivative_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> CoverageDerivativeReclamationSubmission: ...


ResultT = TypeVar("ResultT")


class PostgresCoverageRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        storage: DownloadStorage,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._executor = executor
        self._storage = storage
        self._now = now or (lambda: datetime.now(UTC))

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise CoverageConflict("coverage_store_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise CoverageStoreUnavailable("coverage store failed") from error

    async def create_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_name: str,
        dataset_id: UUID,
        dataset_version_id: UUID,
        data_object_id: UUID,
        expected_dataset_version: int,
        title: str,
        description: str | None,
        request_id: str,
    ) -> SpatialCoverage:
        async def operation(transaction: TenantTransaction) -> SpatialCoverage:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            service = await transaction.fetch_one(
                """
                SELECT disabled_at FROM app.spatial_services
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, service_id),
            )
            if service is None:
                raise CoverageNotFound("spatial_service")
            if service[0] is not None:
                raise CoverageConflict("spatial_service_disabled")
            count = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_service_coverages
                WHERE organization_id = %s AND service_id = %s AND withdrawn_at IS NULL
                """,
                (context.organization_id, service_id),
            )
            if count is not None and cast(int, count[0]) >= 32:
                raise CoverageConflict("spatial_service_coverage_limit_reached")
            target = await transaction.fetch_one(
                """
                SELECT version.id, version.version_number, version.crs, version.extent,
                       (version.schema_definition #>> '{raster,width}')::integer,
                       (version.schema_definition #>> '{raster,height}')::integer,
                       (version.schema_definition #>> '{raster,band_count}')::integer,
                       version.schema_definition #> '{raster,bands}',
                       object.bucket, object.object_key, object.s3_version_id,
                       object.content_type, object.size_bytes, object.checksum_sha256
                FROM app.project_datasets project_dataset
                JOIN app.datasets dataset
                  ON dataset.organization_id = project_dataset.organization_id
                 AND dataset.id = project_dataset.dataset_id
                JOIN app.dataset_versions version
                  ON version.organization_id = dataset.organization_id
                 AND version.dataset_id = dataset.id
                 AND version.id = dataset.current_version_id
                JOIN app.dataset_version_objects link
                  ON link.organization_id = version.organization_id
                 AND link.dataset_id = version.dataset_id
                 AND link.dataset_version_id = version.id
                 AND link.data_object_id = version.original_object_id
                JOIN app.data_objects object
                  ON object.organization_id = link.organization_id
                 AND object.dataset_id = link.dataset_id
                 AND object.id = link.data_object_id
                WHERE project_dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND project_dataset.dataset_id = %s
                  AND version.id = %s
                  AND object.id = %s
                  AND dataset.status = 'active'
                  AND dataset.source_type = 'upload'
                  AND dataset.format = 'cog'
                  AND version.state = 'active'
                  AND version.geometry_type = 'raster'
                  AND version.quality_results @> '{
                    "valid": true,
                    "checks": [{"code": "cog_layout_verified", "status": "passed"}]
                  }'::jsonb
                  AND object.role = 'original'
                  AND object.content_type IN ('image/tiff', 'image/geotiff')
                """,
                (
                    context.organization_id,
                    project_id,
                    dataset_id,
                    dataset_version_id,
                    data_object_id,
                ),
            )
            if target is None:
                raise CoverageConflict("spatial_service_coverage_target_invalid")
            version_number = cast(int, target[1])
            if version_number != expected_dataset_version:
                raise CoverageConflict("spatial_service_coverage_target_changed")
            coverage_id = uuid4()
            row = await transaction.fetch_one(
                f"""
                INSERT INTO app.spatial_service_coverages
                  (id, organization_id, project_id, service_id, coverage_name,
                   dataset_id, dataset_version_id, data_object_id,
                   sealed_dataset_version_number, sealed_crs, sealed_extent,
                   sealed_width, sealed_height, sealed_band_count, sealed_bands,
                   sealed_bucket, sealed_object_key, sealed_storage_version_id,
                   sealed_content_type, sealed_size_bytes, sealed_checksum_sha256,
                   title, description, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {self._coverage_insert_columns()}
                """,
                (
                    coverage_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_name,
                    dataset_id,
                    dataset_version_id,
                    data_object_id,
                    version_number,
                    target[2],
                    Jsonb(target[3]),
                    target[4],
                    target[5],
                    target[6],
                    Jsonb(target[7]),
                    target[8],
                    target[9],
                    target[10],
                    target[11],
                    target[12],
                    target[13],
                    title,
                    description,
                    context.user_id,
                ),
            )
            assert row is not None
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.coverage.created",
                request_id,
                {
                    "coverage_id": str(coverage_id),
                    "coverage_name": coverage_name,
                    "dataset_id": str(dataset_id),
                    "dataset_version_id": str(dataset_version_id),
                    "data_object_id": str(data_object_id),
                    "dataset_version": version_number,
                    "checksum_sha256": cast(str, target[13]),
                },
            )
            return self._coverage(row)

        return await self._run(context, operation)

    async def list_coverages(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        *,
        include_withdrawn: bool,
    ) -> tuple[SpatialCoverage, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[SpatialCoverage, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            service = await transaction.fetch_one(
                """
                SELECT 1 FROM app.spatial_services
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, service_id),
            )
            if service is None:
                raise CoverageNotFound("spatial_service")
            rows = await transaction.fetch_all(
                f"""
                {self._coverage_select()}
                WHERE coverage.organization_id = %s
                  AND coverage.project_id = %s
                  AND coverage.service_id = %s
                  {"" if include_withdrawn else "AND coverage.withdrawn_at IS NULL"}
                ORDER BY lower(coverage.coverage_name), coverage.id
                LIMIT 100
                """,
                (context.organization_id, project_id, service_id),
            )
            return tuple(self._coverage(row) for row in rows)

        return await self._run(context, operation)

    async def resolve_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
    ) -> SpatialCoverage:
        async def operation(transaction: TenantTransaction) -> SpatialCoverage:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            return await self._resolve(
                transaction, context, project_id, service_slug, coverage_name
            )

        return await self._run(context, operation)

    async def withdraw_coverage(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request_id: str,
    ) -> SpatialCoverage:
        async def operation(transaction: TenantTransaction) -> SpatialCoverage:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            current_row = await transaction.fetch_one(
                f"""
                {self._coverage_select()}
                WHERE coverage.organization_id = %s AND coverage.project_id = %s
                  AND coverage.service_id = %s AND coverage.id = %s
                FOR UPDATE OF coverage
                """,
                (context.organization_id, project_id, service_id, coverage_id),
            )
            if current_row is None:
                raise CoverageNotFound("spatial_service_coverage")
            current = self._coverage(current_row)
            if current.withdrawn_at is not None:
                return current
            updated = await transaction.execute(
                """
                UPDATE app.spatial_service_coverages coverage
                SET withdrawn_by = %s, withdrawn_at = clock_timestamp()
                WHERE coverage.organization_id = %s AND coverage.project_id = %s
                  AND coverage.service_id = %s AND coverage.id = %s
                  AND coverage.withdrawn_at IS NULL
                """,
                (
                    context.user_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                ),
            )
            if updated != 1:
                raise CoverageConflict("spatial_service_coverage_withdraw_conflict")
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.coverage.withdrawn",
                request_id,
                {
                    "coverage_id": str(coverage_id),
                    "coverage_name": current.coverage_name,
                },
            )
            withdrawn_row = await transaction.fetch_one(
                f"""
                {self._coverage_select()}
                WHERE coverage.organization_id = %s AND coverage.project_id = %s
                  AND coverage.service_id = %s AND coverage.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id),
            )
            assert withdrawn_row is not None
            return self._coverage(withdrawn_row)

        return await self._run(context, operation)

    async def request_coverage_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
        request_id: str,
    ) -> DownloadTicket:
        async def resolve(transaction: TenantTransaction) -> SpatialCoverage:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            coverage = await self._resolve(
                transaction, context, project_id, service_slug, coverage_name
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            return coverage

        target = await self._run(context, resolve)
        try:
            ticket = await self._storage.create_download_url(
                DownloadSpec(
                    bucket=target.bucket,
                    key=target.object_key,
                    version_id=target.storage_version_id,
                    filename=f"{target.coverage_name}.tif",
                )
            )
        except DownloadStorageUnavailable as error:
            raise CoverageStoreUnavailable("coverage download unavailable") from error

        async def attribute(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            checked = await self._resolve(
                transaction, context, project_id, service_slug, coverage_name
            )
            if checked.stale or checked != target:
                raise CoverageConflict("spatial_service_coverage_target_changed")
            await self._event(
                transaction,
                context,
                project_id,
                target.service_id,
                "spatial_service.coverage.download.issued",
                request_id,
                {
                    "coverage_id": str(target.coverage_id),
                    "dataset_version_id": str(target.dataset_version_id),
                    "data_object_id": str(target.data_object_id),
                    "checksum_sha256": target.checksum_sha256,
                },
            )

        await self._run(context, attribute)
        return ticket

    async def read_coverage_object(
        self,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
        maximum_bytes: int,
    ) -> ExactObject:
        async def resolve(transaction: TenantTransaction) -> SpatialCoverage:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            coverage = await self._resolve(
                transaction, context, project_id, service_slug, coverage_name
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            if coverage.size_bytes > maximum_bytes:
                raise CoverageConflict("spatial_service_coverage_direct_read_too_large")
            return coverage

        target = await self._run(context, resolve)
        try:
            exact = await self._storage.read_exact_object(
                ExactObjectSpec(
                    bucket=target.bucket,
                    key=target.object_key,
                    version_id=target.storage_version_id,
                    content_type=target.content_type,
                    size_bytes=target.size_bytes,
                    checksum_sha256=target.checksum_sha256,
                    maximum_bytes=maximum_bytes,
                )
            )
        except DownloadStorageUnavailable as error:
            raise CoverageStoreUnavailable("coverage direct read unavailable") from error

        async def verify(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            checked = await self._resolve(
                transaction, context, project_id, service_slug, coverage_name
            )
            if checked.stale or checked != target:
                raise CoverageConflict("spatial_service_coverage_target_changed")

        await self._run(context, verify)
        return exact

    async def request_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request: CoverageDerivativeSpec,
        request_id: str,
    ) -> CoverageDerivativeSubmission:
        async def operation(transaction: TenantTransaction) -> CoverageDerivativeSubmission:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            coverage = await self._resolve_by_id(
                transaction, context, project_id, service_id, coverage_id
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            materialized = request.materialize(coverage)
            existing = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s
                  AND job.subset_extent = %s
                  AND job.target_crs = %s AND job.target_width = %s
                  AND job.target_height = %s AND job.resampling = %s
                  AND job.request_schema_version = %s AND job.band_indexes = %s
                  AND job.scale_mode = %s
                  AND job.requested_resolution IS NOT DISTINCT FROM %s
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    Jsonb(list(materialized.subset_extent)),
                    materialized.target_crs,
                    materialized.width,
                    materialized.height,
                    materialized.resampling,
                    materialized.request_schema_version,
                    Jsonb(list(materialized.band_indexes)),
                    materialized.scale_mode,
                    None
                    if materialized.resolution is None
                    else Jsonb(list(materialized.resolution)),
                ),
            )
            if existing is not None:
                job = self._derivative(existing)
                if job.reclamation_state == "completed":
                    raise CoverageConflict("spatial_coverage_derivative_reclaimed")
                return CoverageDerivativeSubmission(job, job.state == "queued")
            count = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_coverage_derivative_jobs
                WHERE organization_id = %s AND service_id = %s AND coverage_id = %s
                  AND NOT EXISTS (
                    SELECT 1
                    FROM app.spatial_coverage_derivative_reclamations reclamation
                    WHERE reclamation.organization_id =
                          spatial_coverage_derivative_jobs.organization_id
                      AND reclamation.derivative_job_id =
                          spatial_coverage_derivative_jobs.id
                      AND reclamation.state = 'completed'
                  )
                """,
                (context.organization_id, service_id, coverage_id),
            )
            if count is not None and cast(int, count[0]) >= MAX_DERIVATIVE_JOBS_PER_COVERAGE:
                raise CoverageConflict("spatial_coverage_derivative_limit_reached")
            active = await transaction.fetch_one(
                """
                SELECT count(*)::bigint FROM app.spatial_coverage_derivative_jobs
                WHERE organization_id = %s AND service_id = %s AND coverage_id = %s
                  AND state IN ('queued', 'running')
                """,
                (context.organization_id, service_id, coverage_id),
            )
            if (
                active is not None
                and cast(int, active[0]) >= MAX_ACTIVE_DERIVATIVE_JOBS_PER_COVERAGE
            ):
                raise CoverageConflict("spatial_coverage_derivative_active_limit_reached")
            job_id = uuid4()
            inserted = await transaction.fetch_one(
                """
                INSERT INTO app.spatial_coverage_derivative_jobs
                  (id, organization_id, project_id, service_id, coverage_id,
                   subset_extent, target_crs, target_width, target_height,
                   resampling, request_schema_version, band_indexes, scale_mode,
                   requested_resolution, request_checksum_sha256, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    Jsonb(list(materialized.subset_extent)),
                    materialized.target_crs,
                    materialized.width,
                    materialized.height,
                    materialized.resampling,
                    materialized.request_schema_version,
                    Jsonb(list(materialized.band_indexes)),
                    materialized.scale_mode,
                    None
                    if materialized.resolution is None
                    else Jsonb(list(materialized.resolution)),
                    materialized.checksum_sha256,
                    context.user_id,
                ),
            )
            assert inserted is not None
            await self._event(
                transaction,
                context,
                project_id,
                service_id,
                "spatial_service.coverage.derivative.requested",
                request_id,
                {
                    "coverage_id": str(coverage_id),
                    "derivative_job_id": str(job_id),
                    "request_checksum_sha256": materialized.checksum_sha256,
                    "target_crs": materialized.target_crs,
                    "target_width": materialized.width,
                    "target_height": materialized.height,
                    "resampling": materialized.resampling,
                    "band_indexes": list(materialized.band_indexes),
                    "scale_mode": materialized.scale_mode,
                },
            )
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.id = %s
                """,
                (context.organization_id, job_id),
            )
            assert row is not None
            return CoverageDerivativeSubmission(self._derivative(row), True)

        return await self._run(context, operation)

    async def find_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        request: CoverageDerivativeSpec,
    ) -> CoverageDerivativeJob | None:
        async def operation(transaction: TenantTransaction) -> CoverageDerivativeJob | None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            coverage = await self._resolve_by_id(
                transaction, context, project_id, service_id, coverage_id
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            materialized = request.materialize(coverage)
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s
                  AND job.subset_extent = %s
                  AND job.target_crs = %s AND job.target_width = %s
                  AND job.target_height = %s AND job.resampling = %s
                  AND job.request_schema_version = %s AND job.band_indexes = %s
                  AND job.scale_mode = %s
                  AND job.requested_resolution IS NOT DISTINCT FROM %s
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    Jsonb(list(materialized.subset_extent)),
                    materialized.target_crs,
                    materialized.width,
                    materialized.height,
                    materialized.resampling,
                    materialized.request_schema_version,
                    Jsonb(list(materialized.band_indexes)),
                    materialized.scale_mode,
                    None
                    if materialized.resolution is None
                    else Jsonb(list(materialized.resolution)),
                ),
            )
            if row is None:
                return None
            job = self._derivative(row)
            if job.reclamation_state == "completed":
                return None
            return job

        return await self._run(context, operation)

    async def get_processing_policy(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> CoverageProcessingPolicy:
        async def operation(transaction: TenantTransaction) -> CoverageProcessingPolicy:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            row = await transaction.fetch_one(
                """
                SELECT 1 FROM app.spatial_services
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, service_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_service")
            return CoverageProcessingPolicy()

        return await self._run(context, operation)

    async def list_derivatives(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
    ) -> tuple[CoverageDerivativeJob, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[CoverageDerivativeJob, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            await self._resolve_by_id(
                transaction,
                context,
                project_id,
                service_id,
                coverage_id,
                include_withdrawn=True,
            )
            rows = await transaction.fetch_all(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s
                ORDER BY job.created_at DESC, job.id DESC LIMIT 100
                """,
                (context.organization_id, project_id, service_id, coverage_id),
            )
            return tuple(self._derivative(row) for row in rows)

        return await self._run(context, operation)

    async def get_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
    ) -> CoverageDerivativeJob:
        async def operation(transaction: TenantTransaction) -> CoverageDerivativeJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            return self._derivative(row)

        return await self._run(context, operation)

    async def cancel_derivative(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> CoverageDerivativeJob:
        async def operation(transaction: TenantTransaction) -> CoverageDerivativeJob:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            if cast(str, row[15]) != "queued":
                raise CoverageConflict("spatial_coverage_derivative_not_cancellable")
            cancelled = await transaction.fetch_one(
                """
                SELECT app.cancel_spatial_coverage_derivative(
                  %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    job_id,
                    context.user_id,
                    request_id,
                ),
            )
            if cancelled is None or not cancelled[0]:
                raise CoverageConflict("spatial_coverage_derivative_cancel_conflict")
            checked = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.id = %s
                """,
                (context.organization_id, job_id),
            )
            assert checked is not None
            return self._derivative(checked)

        return await self._run(context, operation)

    async def request_derivative_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket:
        async def resolve(transaction: TenantTransaction) -> CoverageDerivativeJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            coverage = await self._resolve_by_id(
                transaction, context, project_id, service_id, coverage_id
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                """,
                (
                    context.organization_id,
                    project_id,
                    coverage.service_id,
                    coverage.coverage_id,
                    job_id,
                ),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            job = self._derivative(row)
            if (
                job.state != "completed"
                or any(
                    value is None
                    for value in (
                        job.output_bucket,
                        job.output_object_key,
                        job.output_storage_version_id,
                        job.output_checksum_sha256,
                    )
                )
                or not job.output_available
            ):
                raise CoverageConflict("spatial_coverage_derivative_not_ready")
            return job

        target = await self._run(context, resolve)
        assert target.output_bucket is not None
        assert target.output_object_key is not None
        assert target.output_storage_version_id is not None
        try:
            ticket = await self._storage.create_download_url(
                DownloadSpec(
                    bucket=target.output_bucket,
                    key=target.output_object_key,
                    version_id=target.output_storage_version_id,
                    filename=f"{target.coverage_name}-{target.job_id}.tif",
                )
            )
        except DownloadStorageUnavailable as error:
            raise CoverageStoreUnavailable("coverage derivative download unavailable") from error

        async def attribute(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            checked = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND service.disabled_at IS NULL
                  AND job.coverage_id = %s AND coverage.withdrawn_at IS NULL
                  AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if checked is None or self._derivative(checked) != target:
                raise CoverageConflict("spatial_coverage_derivative_target_changed")
            await self._event(
                transaction,
                context,
                project_id,
                target.service_id,
                "spatial_service.coverage.derivative.download.issued",
                request_id,
                {
                    "coverage_id": str(target.coverage_id),
                    "derivative_job_id": str(target.job_id),
                    "output_object_id": str(target.output_object_id),
                    "output_checksum_sha256": target.output_checksum_sha256,
                },
            )

        await self._run(context, attribute)
        return ticket

    async def read_derivative_object(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
    ) -> ExactObject:
        async def resolve(transaction: TenantTransaction) -> CoverageDerivativeJob:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            coverage = await self._resolve_by_id(
                transaction, context, project_id, service_id, coverage_id
            )
            if coverage.stale:
                raise CoverageConflict("spatial_service_coverage_stale")
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            job = self._derivative(row)
            if (
                job.state != "completed"
                or not job.output_available
                or job.output_bucket is None
                or job.output_object_key is None
                or job.output_storage_version_id is None
                or job.output_content_type is None
                or job.output_size_bytes is None
                or job.output_checksum_sha256 is None
            ):
                raise CoverageConflict("spatial_coverage_derivative_not_ready")
            if job.output_size_bytes > maximum_bytes:
                raise CoverageConflict("spatial_coverage_derivative_direct_read_too_large")
            return job

        target = await self._run(context, resolve)
        assert target.output_bucket is not None
        assert target.output_object_key is not None
        assert target.output_storage_version_id is not None
        assert target.output_content_type is not None
        assert target.output_size_bytes is not None
        assert target.output_checksum_sha256 is not None
        try:
            exact = await self._storage.read_exact_object(
                ExactObjectSpec(
                    bucket=target.output_bucket,
                    key=target.output_object_key,
                    version_id=target.output_storage_version_id,
                    content_type=target.output_content_type,
                    size_bytes=target.output_size_bytes,
                    checksum_sha256=target.output_checksum_sha256,
                    maximum_bytes=maximum_bytes,
                )
            )
        except DownloadStorageUnavailable as error:
            raise CoverageStoreUnavailable("coverage derivative direct read unavailable") from error

        async def verify(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_READ, roles)
            checked = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND service.disabled_at IS NULL
                  AND job.coverage_id = %s AND coverage.withdrawn_at IS NULL
                  AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if checked is None or self._derivative(checked) != target:
                raise CoverageConflict("spatial_coverage_derivative_target_changed")

        await self._run(context, verify)
        return exact

    async def preview_derivative_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
    ) -> CoverageDerivativeReclamationPreview:
        async def operation(
            transaction: TenantTransaction,
        ) -> CoverageDerivativeReclamationPreview:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            job = self._derivative(row)
            now = self._now().astimezone(UTC)
            if (
                job.state != "completed"
                or not job.output_available
                or job.output_object_id is None
                or job.output_size_bytes is None
                or job.output_checksum_sha256 is None
                or job.finished_at is None
                or job.finished_at > now - MINIMUM_DERIVATIVE_RECLAMATION_AGE
                or job.reclamation_state in {"queued", "running", "completed"}
            ):
                raise CoverageConflict("spatial_coverage_derivative_not_reclaimable")
            expires_at = now + DERIVATIVE_RECLAMATION_PREVIEW_TTL
            checksum = self._reclamation_preview_checksum(
                context.organization_id,
                project_id,
                service_id,
                coverage_id,
                job,
                expires_at,
            )
            return CoverageDerivativeReclamationPreview(
                derivative_job_id=job.job_id,
                output_object_id=job.output_object_id,
                size_bytes=job.output_size_bytes,
                checksum_sha256=job.output_checksum_sha256,
                derivative_finished_at=job.finished_at,
                expires_at=expires_at,
                preview_checksum_sha256=checksum,
            )

        return await self._run(context, operation)

    async def confirm_derivative_reclamation(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job_id: UUID,
        preview_checksum_sha256: str,
        preview_expires_at: datetime,
        request_id: str,
    ) -> CoverageDerivativeReclamationSubmission:
        async def operation(
            transaction: TenantTransaction,
        ) -> CoverageDerivativeReclamationSubmission:
            roles = await self._project_roles(transaction, context, project_id, lock=True)
            self._require(Action.SPATIAL_SERVICE_MANAGE, roles)
            existing = await transaction.fetch_one(
                f"""
                {self._reclamation_select()}
                WHERE reclamation.organization_id = %s
                  AND reclamation.project_id = %s
                  AND reclamation.service_id = %s
                  AND reclamation.coverage_id = %s
                  AND reclamation.derivative_job_id = %s
                  AND reclamation.state IN ('queued', 'running', 'completed')
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if existing is not None:
                reclamation = self._reclamation(existing)
                if (
                    reclamation.preview_checksum_sha256 != preview_checksum_sha256
                    or reclamation.preview_expires_at != preview_expires_at.astimezone(UTC)
                ):
                    raise CoverageConflict("spatial_coverage_derivative_reclamation_changed")
                return CoverageDerivativeReclamationSubmission(
                    reclamation, reclamation.state == "queued"
                )
            row = await transaction.fetch_one(
                f"""
                {self._derivative_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.service_id = %s AND job.coverage_id = %s AND job.id = %s
                FOR UPDATE OF job
                """,
                (context.organization_id, project_id, service_id, coverage_id, job_id),
            )
            if row is None:
                raise CoverageNotFound("spatial_coverage_derivative")
            job = self._derivative(row)
            now = self._now().astimezone(UTC)
            expires_at = preview_expires_at.astimezone(UTC)
            if (
                job.state != "completed"
                or not job.output_available
                or job.output_object_id is None
                or job.output_size_bytes is None
                or job.output_checksum_sha256 is None
                or job.finished_at is None
                or job.finished_at > now - MINIMUM_DERIVATIVE_RECLAMATION_AGE
                or expires_at <= now
                or expires_at > now + DERIVATIVE_RECLAMATION_PREVIEW_TTL
                or self._reclamation_preview_checksum(
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    job,
                    expires_at,
                )
                != preview_checksum_sha256
            ):
                raise CoverageConflict("spatial_coverage_derivative_reclamation_changed")
            queued = await transaction.fetch_one(
                """
                SELECT app.queue_spatial_coverage_derivative_reclamation(
                  %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    context.organization_id,
                    project_id,
                    service_id,
                    coverage_id,
                    job_id,
                    preview_checksum_sha256,
                    expires_at,
                    context.user_id,
                    request_id,
                ),
            )
            if queued is None:
                raise CoverageConflict("spatial_coverage_derivative_reclamation_conflict")
            reclaimed = await transaction.fetch_one(
                f"""
                {self._reclamation_select()}
                WHERE reclamation.organization_id = %s AND reclamation.id = %s
                """,
                (context.organization_id, cast(UUID, queued[0])),
            )
            assert reclaimed is not None
            reclamation = self._reclamation(reclaimed)
            return CoverageDerivativeReclamationSubmission(reclamation, True)

        return await self._run(context, operation)

    @staticmethod
    async def _resolve(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_slug: str,
        coverage_name: str,
    ) -> SpatialCoverage:
        row = await transaction.fetch_one(
            f"""
            {PostgresCoverageRepository._coverage_select()}
            JOIN app.spatial_services service
              ON service.organization_id = coverage.organization_id
             AND service.project_id = coverage.project_id
             AND service.id = coverage.service_id
            WHERE coverage.organization_id = %s
              AND coverage.project_id = %s
              AND service.slug = %s
              AND service.disabled_at IS NULL
              AND coverage.coverage_name = %s
              AND coverage.withdrawn_at IS NULL
            """,
            (context.organization_id, project_id, service_slug, coverage_name),
        )
        if row is None:
            raise CoverageNotFound("spatial_service_coverage")
        return PostgresCoverageRepository._coverage(row)

    @staticmethod
    async def _resolve_by_id(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        *,
        include_withdrawn: bool = False,
    ) -> SpatialCoverage:
        row = await transaction.fetch_one(
            f"""
            {PostgresCoverageRepository._coverage_select()}
            JOIN app.spatial_services service
              ON service.organization_id = coverage.organization_id
             AND service.project_id = coverage.project_id
             AND service.id = coverage.service_id
            WHERE coverage.organization_id = %s AND coverage.project_id = %s
              AND coverage.service_id = %s AND coverage.id = %s
              {"" if include_withdrawn else "AND coverage.withdrawn_at IS NULL"}
            """,
            (context.organization_id, project_id, service_id, coverage_id),
        )
        if row is None:
            raise CoverageNotFound("spatial_service_coverage")
        return PostgresCoverageRepository._coverage(row)

    @staticmethod
    async def _project_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        *,
        lock: bool = False,
    ) -> Roles:
        row = await transaction.fetch_one(
            f"""
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            {"FOR UPDATE OF project" if lock else ""}
            """,
            (project_id, context.organization_id, context.user_id),
        )
        if row is None:
            raise CoverageNotFound("project")
        return Roles(
            organization=cast(OrganizationRole, row[0]),
            project=cast(ProjectRole | None, row[1]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise CoverageAccessDenied("action forbidden") from error

    @staticmethod
    async def _event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        event_type: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'spatial_service', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                service_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _metadata_resource_sql(alias: str) -> str:
        # Internal aliases only. The unique dataset binding identifies the resource;
        # its current terms do not seal the raster version.
        return f"""(
            SELECT resource.id FROM app.governed_resources resource
            WHERE resource.organization_id = {alias}.organization_id
              AND resource.project_id = {alias}.project_id
              AND resource.dataset_id = {alias}.dataset_id
              AND resource.kind = 'dataset'
              AND resource.state <> 'archived'
        )"""

    @staticmethod
    def _coverage_insert_columns() -> str:
        return f"""
          id, project_id, service_id, coverage_name, dataset_id,
          dataset_version_id, data_object_id, sealed_dataset_version_number,
          sealed_crs, sealed_extent, sealed_width, sealed_height,
          sealed_band_count, sealed_bands, sealed_bucket, sealed_object_key,
          sealed_storage_version_id, sealed_content_type, sealed_size_bytes,
          sealed_checksum_sha256, dataset_version_id,
          sealed_dataset_version_number, title, description, created_by, created_at,
          withdrawn_by, withdrawn_at, true,
          {PostgresCoverageRepository._metadata_resource_sql("spatial_service_coverages")}
        """

    @staticmethod
    def _coverage_select() -> str:
        return f"""
          SELECT coverage.id, coverage.project_id, coverage.service_id,
                 coverage.coverage_name, coverage.dataset_id,
                 coverage.dataset_version_id, coverage.data_object_id,
                 coverage.sealed_dataset_version_number, coverage.sealed_crs,
                 coverage.sealed_extent, coverage.sealed_width,
                 coverage.sealed_height, coverage.sealed_band_count,
                 coverage.sealed_bands, coverage.sealed_bucket,
                 coverage.sealed_object_key, coverage.sealed_storage_version_id,
                 coverage.sealed_content_type, coverage.sealed_size_bytes,
                 coverage.sealed_checksum_sha256,
                 COALESCE(dataset.current_version_id, coverage.dataset_version_id),
                 COALESCE(current_version.version_number,
                          coverage.sealed_dataset_version_number), coverage.title,
                 coverage.description, coverage.created_by, coverage.created_at,
                 coverage.withdrawn_by, coverage.withdrawn_at,
                 COALESCE((dataset.status = 'active'
                  AND current_version.state = 'active'
                  AND dataset.format = 'cog'
                  AND current_version.geometry_type = 'raster'), false),
                 {PostgresCoverageRepository._metadata_resource_sql("coverage")}
          FROM app.spatial_service_coverages coverage
          JOIN app.datasets dataset
            ON dataset.organization_id = coverage.organization_id
           AND dataset.id = coverage.dataset_id
          LEFT JOIN app.dataset_versions current_version
            ON current_version.organization_id = dataset.organization_id
           AND current_version.dataset_id = dataset.id
           AND current_version.id = dataset.current_version_id
        """

    @staticmethod
    def _coverage(row: tuple[Any, ...]) -> SpatialCoverage:
        extent = cast(list[int | float], row[9])
        bands = cast(list[dict[str, Any]], row[13])
        return SpatialCoverage(
            coverage_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            coverage_name=cast(str, row[3]),
            dataset_id=cast(UUID, row[4]),
            dataset_version_id=cast(UUID, row[5]),
            data_object_id=cast(UUID, row[6]),
            sealed_dataset_version_number=cast(int, row[7]),
            crs=cast(str, row[8]),
            extent=cast(tuple[float, float, float, float], tuple(float(value) for value in extent)),
            width=cast(int, row[10]),
            height=cast(int, row[11]),
            band_count=cast(int, row[12]),
            bands=tuple(bands),
            bucket=cast(str, row[14]),
            object_key=cast(str, row[15]),
            storage_version_id=cast(str, row[16]),
            content_type=cast(str, row[17]),
            size_bytes=cast(int, row[18]),
            checksum_sha256=cast(str, row[19]),
            current_dataset_version_id=cast(UUID, row[20]),
            current_dataset_version_number=cast(int, row[21]),
            title=cast(str, row[22]),
            description=cast(str | None, row[23]),
            created_by=cast(UUID, row[24]),
            created_at=cast(datetime, row[25]),
            withdrawn_by=cast(UUID | None, row[26]),
            withdrawn_at=cast(datetime | None, row[27]),
            target_active=cast(bool, row[28]),
            metadata_resource_id=cast(UUID | None, row[29]),
        )

    @staticmethod
    def _derivative_select() -> str:
        return """
          SELECT job.id, job.project_id, job.service_id, job.coverage_id,
                 coverage.coverage_name, job.subset_extent, job.target_crs,
                 job.target_width, job.target_height, job.resampling,
                 job.request_schema_version, job.band_indexes, job.scale_mode,
                 job.requested_resolution, job.request_checksum_sha256, job.state::text,
                 job.output_object_id, job.output_crs, job.output_extent,
                 job.output_width, job.output_height, job.output_band_count,
                 job.output_bands, job.output_content_type,
                 job.output_size_bytes, job.output_checksum_sha256,
                 output.bucket, output.object_key, output.s3_version_id,
                 job.error_code, job.attempt_count, job.created_by,
                 job.created_at, job.started_at, job.finished_at,
                 COALESCE(coverage.withdrawn_at IS NULL
                   AND service.disabled_at IS NULL
                   AND dataset.status = 'active'
                   AND dataset.format = 'cog'
                   AND dataset.current_version_id = coverage.dataset_version_id
                   AND current_version.state = 'active'
                   AND current_version.geometry_type = 'raster'
                   AND current_version.version_number =
                       coverage.sealed_dataset_version_number, false),
                 reclamation.state::text,
                 output.id IS NOT NULL
          FROM app.spatial_coverage_derivative_jobs job
          JOIN app.spatial_service_coverages coverage
            ON coverage.organization_id = job.organization_id
           AND coverage.id = job.coverage_id
          JOIN app.spatial_services service
            ON service.organization_id = job.organization_id
           AND service.id = job.service_id
          JOIN app.datasets dataset
            ON dataset.organization_id = job.organization_id
           AND dataset.id = coverage.dataset_id
          LEFT JOIN app.dataset_versions current_version
            ON current_version.organization_id = dataset.organization_id
           AND current_version.dataset_id = dataset.id
           AND current_version.id = dataset.current_version_id
          LEFT JOIN app.data_objects output
            ON output.organization_id = job.organization_id
           AND output.id = job.output_object_id
          LEFT JOIN LATERAL (
            SELECT plan.state
            FROM app.spatial_coverage_derivative_reclamations plan
            WHERE plan.organization_id = job.organization_id
              AND plan.derivative_job_id = job.id
            ORDER BY plan.created_at DESC, plan.id DESC
            LIMIT 1
          ) reclamation ON true
        """

    @staticmethod
    def _derivative(row: tuple[Any, ...]) -> CoverageDerivativeJob:
        subset = cast(list[int | float], row[5])
        band_indexes = cast(list[int], row[11])
        resolution_value = cast(list[int | float] | None, row[13])
        output_extent_value = cast(list[int | float] | None, row[18])
        output_bands_value = cast(list[dict[str, Any]] | None, row[22])
        return CoverageDerivativeJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            service_id=cast(UUID, row[2]),
            coverage_id=cast(UUID, row[3]),
            coverage_name=cast(str, row[4]),
            request=CoverageDerivativeRequest(
                subset_extent=cast(
                    tuple[float, float, float, float],
                    tuple(float(value) for value in subset),
                ),
                target_crs=cast(str, row[6]),
                width=cast(int, row[7]),
                height=cast(int, row[8]),
                resampling=cast(str, row[9]),
                request_schema_version=cast(int, row[10]),
                band_indexes=tuple(band_indexes),
                scale_mode=cast(str, row[12]),
                resolution=(
                    None
                    if resolution_value is None
                    else cast(
                        tuple[float, float],
                        tuple(float(value) for value in resolution_value),
                    )
                ),
            ),
            request_checksum_sha256=cast(str, row[14]),
            state=cast(str, row[15]),
            output_object_id=cast(UUID | None, row[16]),
            output_crs=cast(str | None, row[17]),
            output_extent=(
                None
                if output_extent_value is None
                else cast(
                    tuple[float, float, float, float],
                    tuple(float(value) for value in output_extent_value),
                )
            ),
            output_width=cast(int | None, row[19]),
            output_height=cast(int | None, row[20]),
            output_band_count=cast(int | None, row[21]),
            output_bands=None if output_bands_value is None else tuple(output_bands_value),
            output_content_type=cast(str | None, row[23]),
            output_size_bytes=cast(int | None, row[24]),
            output_checksum_sha256=cast(str | None, row[25]),
            output_bucket=cast(str | None, row[26]),
            output_object_key=cast(str | None, row[27]),
            output_storage_version_id=cast(str | None, row[28]),
            error_code=cast(str | None, row[29]),
            attempt_count=cast(int, row[30]),
            created_by=cast(UUID, row[31]),
            created_at=cast(datetime, row[32]),
            started_at=cast(datetime | None, row[33]),
            finished_at=cast(datetime | None, row[34]),
            source_available=cast(bool, row[35]),
            reclamation_state=cast(str | None, row[36]),
            output_available=cast(bool, row[37]),
        )

    @staticmethod
    def _reclamation_select() -> str:
        return """
          SELECT reclamation.id, reclamation.derivative_job_id,
                 reclamation.output_object_id, reclamation.state::text,
                 reclamation.sealed_size_bytes,
                 reclamation.sealed_checksum_sha256,
                 reclamation.preview_checksum_sha256,
                 reclamation.preview_expires_at, reclamation.error_code,
                 reclamation.attempt_count, reclamation.delete_started_at,
                 reclamation.created_by, reclamation.created_at,
                 reclamation.started_at, reclamation.finished_at
          FROM app.spatial_coverage_derivative_reclamations reclamation
        """

    @staticmethod
    def _reclamation(row: tuple[Any, ...]) -> CoverageDerivativeReclamation:
        return CoverageDerivativeReclamation(
            reclamation_id=cast(UUID, row[0]),
            derivative_job_id=cast(UUID, row[1]),
            output_object_id=cast(UUID, row[2]),
            state=cast(str, row[3]),
            size_bytes=cast(int, row[4]),
            checksum_sha256=cast(str, row[5]),
            preview_checksum_sha256=cast(str, row[6]),
            preview_expires_at=cast(datetime, row[7]),
            error_code=cast(str | None, row[8]),
            attempt_count=cast(int, row[9]),
            delete_started_at=cast(datetime | None, row[10]),
            created_by=cast(UUID, row[11]),
            created_at=cast(datetime, row[12]),
            started_at=cast(datetime | None, row[13]),
            finished_at=cast(datetime | None, row[14]),
        )

    @staticmethod
    def _reclamation_preview_checksum(
        organization_id: UUID,
        project_id: UUID,
        service_id: UUID,
        coverage_id: UUID,
        job: CoverageDerivativeJob,
        expires_at: datetime,
    ) -> str:
        assert job.output_object_id is not None
        assert job.output_size_bytes is not None
        assert job.output_checksum_sha256 is not None
        assert job.finished_at is not None
        document = {
            "schema": "opengeo.coverage-derivative-reclamation-preview.v1",
            "organization_id": str(organization_id),
            "project_id": str(project_id),
            "service_id": str(service_id),
            "coverage_id": str(coverage_id),
            "derivative_job_id": str(job.job_id),
            "output_object_id": str(job.output_object_id),
            "size_bytes": job.output_size_bytes,
            "checksum_sha256": job.output_checksum_sha256,
            "derivative_finished_at": PostgresCoverageRepository._utc(job.finished_at),
            "expires_at": PostgresCoverageRepository._utc(expires_at),
        }
        body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode()
        return hashlib.sha256(body).hexdigest()

    @staticmethod
    def _utc(value: datetime) -> str:
        return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
