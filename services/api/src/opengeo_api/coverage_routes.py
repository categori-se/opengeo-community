import logging
import math
import re
from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.coverages import (
    CoverageAccessDenied,
    CoverageConflict,
    CoverageDerivativeJob,
    CoverageDerivativeReclamation,
    CoverageDerivativeReclamationPreview,
    CoverageDerivativeSpec,
    CoverageNotFound,
    CoverageProcessingPolicy,
    CoverageRepository,
    CoverageStoreUnavailable,
    SpatialCoverage,
)
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import (
    ProcessingDispatchUnavailable,
    RenderDispatcher,
)
from opengeo_api.resource_routes import tenant_context
from opengeo_api.spatial_service_routes import Description, Slug, Title
from opengeo_api.spatial_services import (
    SpatialServiceAccessDenied,
    SpatialServiceNotFound,
    SpatialServiceRepository,
    SpatialServiceStoreUnavailable,
)
from opengeo_api.tenant_database import TenantContext
from opengeo_api.wcs import (
    WcsCoverageView,
    WcsRequestError,
    capabilities_xml,
    describe_coverages_xml,
    exception_report_xml,
    multipart_coverage_response,
    parse_wcs_request,
    plan_wcs_subsets,
    wcs_subset_derivative_spec,
)

router = APIRouter(tags=["WCS coverage services"])
WCS_MEDIA_TYPE = "application/xml"
MAXIMUM_WCS_MULTIPART_RASTER_BYTES = 3_000_000
logger = logging.getLogger(__name__)
OGC_COVERAGE_REL = "http://www.opengis.net/def/rel/ogc/1.0/coverage"
OGC_DOMAINSET_REL = "http://www.opengis.net/def/rel/ogc/1.0/coverage-domainset"
OGC_RANGETYPE_REL = "http://www.opengis.net/def/rel/ogc/1.0/coverage-rangetype"


@dataclass(frozen=True, slots=True)
class CoverageView:
    crs: str
    extent: tuple[float, float, float, float]
    width: int
    height: int
    bands: tuple[dict[str, Any], ...]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateCoverageRequest(RequestModel):
    coverage_name: Slug
    dataset_id: UUID
    dataset_version_id: UUID
    data_object_id: UUID
    expected_dataset_version: int = Field(ge=1)
    title: Title
    description: Description = None


class CreateCoverageDerivativeRequest(RequestModel):
    subset_extent: tuple[float, float, float, float]
    target_crs: str = Field(pattern=r"^EPSG:[1-9][0-9]{2,7}$")
    width: int | None = Field(default=None, ge=1, le=8192)
    height: int | None = Field(default=None, ge=1, le=8192)
    resolution: tuple[float, float] | None = None
    band_indexes: tuple[int, ...] | None = None
    resampling: Literal["nearest", "bilinear", "cubic"] = "nearest"

    @model_validator(mode="after")
    def validate_bounds(self) -> "CreateCoverageDerivativeRequest":
        west, south, east, north = self.subset_extent
        if (
            not all(math.isfinite(value) for value in self.subset_extent)
            or west >= east
            or south >= north
            or (self.width is None) != (self.height is None)
            or (self.width is None) == (self.resolution is None)
            or (
                self.width is not None
                and self.height is not None
                and self.width * self.height > 16_777_216
            )
            or (
                self.resolution is not None
                and (
                    not all(math.isfinite(value) and value > 0 for value in self.resolution)
                    or any(value > 1e100 for value in self.resolution)
                )
            )
            or (
                self.band_indexes is not None
                and (
                    not 1 <= len(self.band_indexes) <= 64
                    or self.band_indexes != tuple(sorted(set(self.band_indexes)))
                    or not all(1 <= value <= 64 for value in self.band_indexes)
                )
            )
        ):
            raise ValueError("coverage derivative bounds are invalid")
        return self


class CoverageResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    coverage_name: str
    dataset_id: UUID
    dataset_version_id: UUID
    data_object_id: UUID
    sealed_dataset_version_number: int
    current_dataset_version_id: UUID
    current_dataset_version_number: int
    crs: str
    extent: tuple[float, float, float, float]
    width: int
    height: int
    band_count: int
    bands: tuple[dict[str, object], ...]
    content_type: str
    size_bytes: int
    checksum_sha256: str
    stale: bool
    target_active: bool
    title: str
    description: str | None
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None


class CoverageDerivativeResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    coverage_id: UUID
    coverage_name: str
    subset_extent: tuple[float, float, float, float]
    target_crs: str
    target_width: int
    target_height: int
    resampling: str
    request_schema_version: int
    band_indexes: tuple[int, ...]
    scale_mode: str
    requested_resolution: tuple[float, float] | None
    request_checksum_sha256: str
    state: str
    output_object_id: UUID | None
    output_crs: str | None
    output_extent: tuple[float, float, float, float] | None
    output_width: int | None
    output_height: int | None
    output_band_count: int | None
    output_bands: tuple[dict[str, object], ...] | None
    output_content_type: str | None
    output_size_bytes: int | None
    output_checksum_sha256: str | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    source_available: bool
    reclamation_state: str | None
    output_available: bool


class WcsSubsetPlanResponse(BaseModel):
    coverage_id: UUID
    service_id: UUID
    dataset_version_id: UUID
    request_checksum_sha256: str
    derivative_request: CreateCoverageDerivativeRequest
    ordinary_reads_create_work: Literal[False] = False


class ConfirmCoverageDerivativeReclamationRequest(RequestModel):
    preview_checksum_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    preview_expires_at: datetime


class CoverageDerivativeReclamationPreviewResponse(BaseModel):
    derivative_job_id: UUID
    output_object_id: UUID
    size_bytes: int
    checksum_sha256: str
    derivative_finished_at: datetime
    expires_at: datetime
    preview_checksum_sha256: str
    physical_action: str
    history_retained: bool
    ordinary_reads_create_work: bool


class CoverageDerivativeReclamationResponse(BaseModel):
    id: UUID
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


class DownloadTicketResponse(BaseModel):
    url: str
    method: str
    expires_at: datetime


class CoverageProcessingPolicyResponse(BaseModel):
    request_schema_version: int
    maximum_axis_pixels: int
    maximum_pixels: int
    maximum_samples: int
    maximum_retained_jobs_per_coverage: int
    maximum_active_jobs_per_coverage: int
    maximum_output_bytes: int
    supported_resampling: tuple[str, ...]
    cancellation_states: tuple[str, ...]
    minimum_reclamation_age_hours: int
    reclamation_preview_ttl_seconds: int
    physical_reclamation: str
    ordinary_reads_create_work: bool


def repository_from_request(request: Request) -> CoverageRepository:
    return cast(CoverageRepository, request.app.state.coverage_repository)


def service_repository_from_request(request: Request) -> SpatialServiceRepository:
    return cast(SpatialServiceRepository, request.app.state.spatial_service_repository)


def dispatcher_from_request(request: Request) -> RenderDispatcher:
    if request.app.state.settings.worker_processing_mode != "shared":
        raise HTTPException(status_code=503, detail="shared_worker_processing_held")
    return cast(RenderDispatcher, request.app.state.render_dispatcher)


async def execute_coverage[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except CoverageAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except CoverageNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except CoverageConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except CoverageStoreUnavailable as error:
        raise HTTPException(status_code=503, detail="coverage_store_unavailable") from error


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/coverages",
    response_model=list[CoverageResponse],
)
async def list_coverages(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    include_withdrawn: bool = False,
) -> list[CoverageResponse]:
    records = await execute_coverage(
        repository.list_coverages(
            tenant_context(session),
            project_id,
            service_id,
            include_withdrawn=include_withdrawn,
        )
    )
    return [_coverage_response(record) for record in records]


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages",
    response_model=CoverageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_coverage(
    project_id: UUID,
    service_id: UUID,
    payload: CreateCoverageRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageResponse:
    record = await execute_coverage(
        repository.create_coverage(
            tenant_context(session),
            project_id,
            service_id,
            payload.coverage_name,
            payload.dataset_id,
            payload.dataset_version_id,
            payload.data_object_id,
            payload.expected_dataset_version,
            payload.title,
            payload.description,
            get_request_id(),
        )
    )
    return _coverage_response(record)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/withdraw",
    response_model=CoverageResponse,
)
async def withdraw_coverage(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageResponse:
    record = await execute_coverage(
        repository.withdraw_coverage(
            tenant_context(session), project_id, service_id, coverage_id, get_request_id()
        )
    )
    return _coverage_response(record)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/coverage-processing-policy",
    response_model=CoverageProcessingPolicyResponse,
)
async def get_coverage_processing_policy(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageProcessingPolicyResponse:
    policy = await execute_coverage(
        repository.get_processing_policy(tenant_context(session), project_id, service_id)
    )
    return _processing_policy_response(policy)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/derivatives",
    response_model=list[CoverageDerivativeResponse],
)
async def list_coverage_derivatives(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> list[CoverageDerivativeResponse]:
    records = await execute_coverage(
        repository.list_derivatives(tenant_context(session), project_id, service_id, coverage_id)
    )
    return [_derivative_response(record) for record in records]


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/derivatives",
    response_model=CoverageDerivativeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_coverage_derivative(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    payload: CreateCoverageDerivativeRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> CoverageDerivativeResponse:
    submission = await execute_coverage(
        repository.request_derivative(
            tenant_context(session),
            project_id,
            service_id,
            coverage_id,
            CoverageDerivativeSpec(
                subset_extent=payload.subset_extent,
                target_crs=payload.target_crs,
                width=payload.width,
                height=payload.height,
                resolution=payload.resolution,
                band_indexes=payload.band_indexes,
                resampling=payload.resampling,
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_coverage_derivative(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("coverage_derivative.dispatch_unavailable")
            raise HTTPException(
                status_code=503, detail="coverage_derivative_dispatch_unavailable"
            ) from error
    return _derivative_response(submission.job)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/"
    "{coverage_id}/derivatives/{job_id}",
    response_model=CoverageDerivativeResponse,
)
async def get_coverage_derivative(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageDerivativeResponse:
    return _derivative_response(
        await execute_coverage(
            repository.get_derivative(
                tenant_context(session), project_id, service_id, coverage_id, job_id
            )
        )
    )


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/"
    "{coverage_id}/derivatives/{job_id}/cancel",
    response_model=CoverageDerivativeResponse,
)
async def cancel_coverage_derivative(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageDerivativeResponse:
    return _derivative_response(
        await execute_coverage(
            repository.cancel_derivative(
                tenant_context(session),
                project_id,
                service_id,
                coverage_id,
                job_id,
                get_request_id(),
            )
        )
    )


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/"
    "{coverage_id}/derivatives/{job_id}/download",
    response_model=DownloadTicketResponse,
)
async def download_coverage_derivative(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> DownloadTicketResponse:
    ticket = await execute_coverage(
        repository.request_derivative_download(
            tenant_context(session),
            project_id,
            service_id,
            coverage_id,
            job_id,
            get_request_id(),
        )
    )
    return DownloadTicketResponse(
        url=ticket.url, method=ticket.method, expires_at=ticket.expires_at
    )


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/"
    "{coverage_id}/derivatives/{job_id}/reclamation-preview",
    response_model=CoverageDerivativeReclamationPreviewResponse,
)
async def preview_coverage_derivative_reclamation(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
) -> CoverageDerivativeReclamationPreviewResponse:
    preview = await execute_coverage(
        repository.preview_derivative_reclamation(
            tenant_context(session), project_id, service_id, coverage_id, job_id
        )
    )
    return _reclamation_preview_response(preview)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/coverages/"
    "{coverage_id}/derivatives/{job_id}/reclaim",
    response_model=CoverageDerivativeReclamationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def reclaim_coverage_derivative(
    project_id: UUID,
    service_id: UUID,
    coverage_id: UUID,
    job_id: UUID,
    payload: ConfirmCoverageDerivativeReclamationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> CoverageDerivativeReclamationResponse:
    submission = await execute_coverage(
        repository.confirm_derivative_reclamation(
            tenant_context(session),
            project_id,
            service_id,
            coverage_id,
            job_id,
            payload.preview_checksum_sha256,
            payload.preview_expires_at,
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_coverage_derivative_reclamation(
                submission.reclamation.reclamation_id
            )
        except ProcessingDispatchUnavailable as error:
            logger.error("coverage_derivative_reclamation.dispatch_unavailable")
            raise HTTPException(
                status_code=503,
                detail="coverage_derivative_reclamation_dispatch_unavailable",
            ) from error
    return _reclamation_response(submission.reclamation)


@router.get(
    "/projects/{project_id}/services/{service_slug}/coverages/{coverage_name}/subset-plan",
    response_model=WcsSubsetPlanResponse,
    summary="Preview the exact derivative needed for a WCS subset without creating work",
)
async def preview_wcs_subset(
    project_id: UUID,
    service_slug: Slug,
    coverage_name: Annotated[str, Field(min_length=1, max_length=100)],
    request: Request,
    response: Response,
    subset: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=256)]], Query(min_length=1, max_length=2)
    ],
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    service_repository: Annotated[
        SpatialServiceRepository, Depends(service_repository_from_request)
    ],
) -> WcsSubsetPlanResponse:
    response.headers.update(_private_headers())
    if any(name != "subset" for name in request.query_params):
        raise HTTPException(status_code=400, detail={"code": "coverage_query_invalid"})
    context = tenant_context(session)
    try:
        service = await service_repository.get_active_service(context, project_id, service_slug)
        if "wcs_2_0" not in service.enabled_protocols:
            raise HTTPException(status_code=404, detail={"code": "wcs_not_enabled"})
        coverage = await repository.resolve_coverage(
            context, project_id, service_slug, coverage_name
        )
        if coverage.stale:
            raise HTTPException(status_code=409, detail={"code": "coverage_seal_stale"})
        parsed = parse_wcs_request(
            [
                ("SERVICE", "WCS"),
                ("VERSION", "2.0.1"),
                ("REQUEST", "GetCoverage"),
                ("COVERAGEID", coverage_name),
                *(("SUBSET", value) for value in subset),
            ]
        )
        specification = wcs_subset_derivative_spec(
            coverage, plan_wcs_subsets(coverage, parsed.subsets)
        )
        materialized = specification.materialize(coverage)
        return WcsSubsetPlanResponse(
            coverage_id=coverage.coverage_id,
            service_id=coverage.service_id,
            dataset_version_id=coverage.dataset_version_id,
            request_checksum_sha256=materialized.checksum_sha256,
            derivative_request=CreateCoverageDerivativeRequest(
                subset_extent=materialized.subset_extent,
                target_crs=materialized.target_crs,
                width=materialized.width,
                height=materialized.height,
                band_indexes=materialized.band_indexes,
                resampling="nearest",
            ),
        )
    except WcsRequestError as error:
        raise HTTPException(
            status_code=error.status_code, detail={"code": error.code, "locator": error.locator}
        ) from error
    except (CoverageAccessDenied, SpatialServiceAccessDenied) as error:
        raise HTTPException(status_code=403, detail={"code": "coverage_access_denied"}) from error
    except (CoverageNotFound, SpatialServiceNotFound) as error:
        raise HTTPException(status_code=404, detail={"code": "coverage_not_found"}) from error
    except CoverageConflict as error:
        raise HTTPException(status_code=409, detail={"code": "coverage_subset_conflict"}) from error
    except (CoverageStoreUnavailable, SpatialServiceStoreUnavailable) as error:
        raise HTTPException(status_code=503, detail={"code": "coverage_unavailable"}) from error


@router.get("/projects/{project_id}/services/{service_slug}/wcs", name="wcs_service")
async def wcs_service(
    project_id: UUID,
    service_slug: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    service_repository: Annotated[
        SpatialServiceRepository, Depends(service_repository_from_request)
    ],
) -> Response:
    try:
        parsed = parse_wcs_request(list(request.query_params.multi_items()))
        context = tenant_context(session)
        service = await service_repository.get_active_service(context, project_id, service_slug)
        if "wcs_2_0" not in service.enabled_protocols:
            raise WcsRequestError(
                "OperationNotSupported",
                "SERVICE",
                "WCS is not enabled for this spatial service.",
                status_code=404,
            )
        if parsed.operation == "GetCapabilities":
            records = await repository.list_coverages(
                context, project_id, service.service_id, include_withdrawn=False
            )
            fresh = tuple(record for record in records if not record.stale)
            body = capabilities_xml(
                service.title,
                service.description,
                str(
                    request.url_for("wcs_service", project_id=project_id, service_slug=service_slug)
                ),
                fresh,
            )
            return _xml(body)

        if parsed.operation == "DescribeCoverage":
            descriptions = {}
            for identifier in dict.fromkeys(parsed.coverage_ids):
                described = await repository.resolve_coverage(
                    context, project_id, service_slug, identifier
                )
                if described.stale:
                    raise WcsRequestError(
                        "NoSuchCoverage",
                        "COVERAGEID",
                        "A requested coverage seal is stale.",
                        status_code=409,
                    )
                descriptions[identifier] = described
            return _xml(
                describe_coverages_xml(
                    tuple(descriptions[identifier] for identifier in parsed.coverage_ids)
                )
            )

        assert parsed.coverage_id is not None
        coverage = await repository.resolve_coverage(
            context, project_id, service_slug, parsed.coverage_id
        )
        if coverage.stale:
            raise WcsRequestError(
                "NoSuchCoverage",
                "COVERAGEID",
                "The coverage is unavailable because its immutable seal is stale.",
                status_code=409,
            )
        subset_plan = plan_wcs_subsets(coverage, parsed.subsets)
        derivative: CoverageDerivativeJob | None = None
        specification = wcs_subset_derivative_spec(coverage, subset_plan)
        source_grid = (
            not subset_plan.sliced_axes
            and specification.subset_extent == coverage.extent
            and specification.width == coverage.width
            and specification.height == coverage.height
        )
        if parsed.subsets and not source_grid:
            derivative = await repository.find_derivative(
                context,
                project_id,
                coverage.service_id,
                coverage.coverage_id,
                specification,
            )
            if (
                derivative is None
                or derivative.state != "completed"
                or not derivative.output_available
                or derivative.output_content_type != "image/tiff"
                or derivative.output_checksum_sha256 is None
                or derivative.output_crs is None
                or derivative.output_extent is None
                or derivative.output_width is None
                or derivative.output_height is None
                or derivative.output_bands is None
            ):
                pending = WcsRequestError(
                    "NoApplicableCode",
                    "SUBSET",
                    "The bounded subset is not materialized; prepare it and retry this request.",
                    status_code=503,
                )
                response = _xml(exception_report_xml(pending), status_code=503)
                response.headers["Retry-After"] = "5"
                return response

        if parsed.media_type is not None:
            if derivative is None:
                if coverage.size_bytes > MAXIMUM_WCS_MULTIPART_RASTER_BYTES:
                    raise WcsRequestError(
                        "OperationNotSupported",
                        "MEDIATYPE",
                        "The exact raster exceeds the bounded multipart response size.",
                        status_code=501,
                    )
                exact = await repository.read_coverage_object(
                    context,
                    project_id,
                    service_slug,
                    coverage.coverage_name,
                    MAXIMUM_WCS_MULTIPART_RASTER_BYTES,
                )
                view = WcsCoverageView(
                    coverage.coverage_name,
                    coverage.crs,
                    coverage.extent,
                    coverage.width,
                    coverage.height,
                    tuple(coverage.bands),
                )
            else:
                if (
                    derivative.output_size_bytes is None
                    or derivative.output_size_bytes > MAXIMUM_WCS_MULTIPART_RASTER_BYTES
                ):
                    raise WcsRequestError(
                        "OperationNotSupported",
                        "MEDIATYPE",
                        "The exact derivative exceeds the bounded multipart response size.",
                        status_code=501,
                    )
                exact = await repository.read_derivative_object(
                    context,
                    project_id,
                    coverage.service_id,
                    coverage.coverage_id,
                    derivative.job_id,
                    MAXIMUM_WCS_MULTIPART_RASTER_BYTES,
                )
                assert derivative.output_crs is not None
                assert derivative.output_extent is not None
                assert derivative.output_width is not None
                assert derivative.output_height is not None
                assert derivative.output_bands is not None
                view = WcsCoverageView(
                    coverage.coverage_name,
                    derivative.output_crs,
                    derivative.output_extent,
                    derivative.output_width,
                    derivative.output_height,
                    tuple(derivative.output_bands),
                )
            body, content_type = multipart_coverage_response(
                view, exact.body, exact.checksum_sha256
            )
            response = Response(content=body, media_type=None)
            response.headers.update(_private_headers())
            response.headers["Content-Type"] = content_type
            response.headers["X-OpenGeo-Coverage-Checksum-SHA256"] = exact.checksum_sha256
            return response

        if derivative is not None:
            assert derivative.output_checksum_sha256 is not None
            ticket = await repository.request_derivative_download(
                context,
                project_id,
                coverage.service_id,
                coverage.coverage_id,
                derivative.job_id,
                get_request_id(),
            )
            response = RedirectResponse(ticket.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
            response.headers.update(_private_headers())
            response.headers["X-OpenGeo-Coverage-Checksum-SHA256"] = (
                derivative.output_checksum_sha256
            )
            return response
        ticket = await repository.request_coverage_download(
            context, project_id, service_slug, parsed.coverage_id, get_request_id()
        )
        response = RedirectResponse(ticket.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
        response.headers.update(_private_headers())
        response.headers["X-OpenGeo-Coverage-Checksum-SHA256"] = coverage.checksum_sha256
        return response
    except WcsRequestError as error:
        return _xml(exception_report_xml(error), status_code=error.status_code)
    except CoverageAccessDenied as error:
        return _wcs_error("AccessDenied", "authorization", "Access denied.", 403, error)
    except (CoverageNotFound, SpatialServiceNotFound) as error:
        return _wcs_error(
            "NoSuchCoverage", "COVERAGEID", "The requested coverage does not exist.", 404, error
        )
    except CoverageConflict as error:
        return _wcs_error(
            "NoApplicableCode", "coverage", "The coverage changed during the request.", 409, error
        )
    except (CoverageStoreUnavailable, SpatialServiceStoreUnavailable) as error:
        return _wcs_error(
            "NoApplicableCode", "service", "The coverage service is unavailable.", 503, error
        )
    except SpatialServiceAccessDenied as error:
        return _wcs_error("AccessDenied", "authorization", "Access denied.", 403, error)


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/{coverage_name}/coverage"
)
async def ogc_coverage(
    project_id: UUID,
    service_slug: Slug,
    coverage_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    derivative: Annotated[UUID | None, Query()] = None,
) -> RedirectResponse:
    _known_ogc_query(request, {"derivative"})
    context = tenant_context(session)
    coverage = await execute_coverage(
        repository.resolve_coverage(context, project_id, service_slug, coverage_name)
    )
    if coverage.stale:
        raise HTTPException(status_code=409, detail={"code": "spatial_service_coverage_stale"})
    if derivative is None:
        ticket = await execute_coverage(
            repository.request_coverage_download(
                context, project_id, service_slug, coverage_name, get_request_id()
            )
        )
        checksum = coverage.checksum_sha256
    else:
        job = await execute_coverage(
            repository.get_derivative(
                context,
                project_id,
                coverage.service_id,
                coverage.coverage_id,
                derivative,
            )
        )
        ticket = await execute_coverage(
            repository.request_derivative_download(
                context,
                project_id,
                coverage.service_id,
                coverage.coverage_id,
                derivative,
                get_request_id(),
            )
        )
        assert job.output_checksum_sha256 is not None
        checksum = job.output_checksum_sha256
    response = RedirectResponse(ticket.url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    response.headers.update(_private_headers())
    response.headers["X-OpenGeo-Coverage-Checksum-SHA256"] = checksum
    return response


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/"
    "{coverage_name}/coverage/domainset"
)
async def ogc_coverage_domainset(
    project_id: UUID,
    service_slug: Slug,
    coverage_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    derivative: Annotated[UUID | None, Query()] = None,
) -> JSONResponse:
    _known_ogc_query(request, {"derivative"})
    coverage = await execute_coverage(
        repository.resolve_coverage(
            tenant_context(session), project_id, service_slug, coverage_name
        )
    )
    view = await _coverage_view(repository, tenant_context(session), coverage, derivative)
    return _json(
        {
            "type": "GeneralGridCoverage",
            "axisLabels": ["x", "y"],
            "grid": {"low": [0, 0], "high": [view.width - 1, view.height - 1]},
            "extent": list(view.extent),
            "storageCRS": _crs_uri(view.crs),
            "opengeo:derivativeId": None if derivative is None else str(derivative),
            "opengeo:conformanceClaimed": False,
        }
    )


@router.get(
    "/projects/{project_id}/services/{service_slug}/ogc/collections/"
    "{coverage_name}/coverage/rangetype"
)
async def ogc_coverage_rangetype(
    project_id: UUID,
    service_slug: Slug,
    coverage_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    derivative: Annotated[UUID | None, Query()] = None,
) -> JSONResponse:
    _known_ogc_query(request, {"derivative"})
    coverage = await execute_coverage(
        repository.resolve_coverage(
            tenant_context(session), project_id, service_slug, coverage_name
        )
    )
    view = await _coverage_view(repository, tenant_context(session), coverage, derivative)
    return _json(
        {
            "type": "DataRecordType",
            "field": [_range_field(band, index) for index, band in enumerate(view.bands, 1)],
            "opengeo:derivativeId": None if derivative is None else str(derivative),
            "opengeo:conformanceClaimed": False,
        }
    )


@router.get("/projects/{project_id}/services/{service_slug}/ogc/collections/{coverage_name}/schema")
async def ogc_coverage_schema(
    project_id: UUID,
    service_slug: Slug,
    coverage_name: Slug,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[CoverageRepository, Depends(repository_from_request)],
    derivative: Annotated[UUID | None, Query()] = None,
) -> JSONResponse:
    _known_ogc_query(request, {"derivative"})
    coverage = await execute_coverage(
        repository.resolve_coverage(
            tenant_context(session), project_id, service_slug, coverage_name
        )
    )
    view = await _coverage_view(repository, tenant_context(session), coverage, derivative)
    properties = {
        _band_name(band, index): {
            "type": _json_type(band.get("data_type")),
            "title": str(band.get("color_interpretation") or _band_name(band, index)),
        }
        for index, band in enumerate(view.bands, 1)
    }
    return _json(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
            "x-opengeo-derivative-id": None if derivative is None else str(derivative),
            "x-opengeo-conformance-claimed": False,
        }
    )


async def _coverage_view(
    repository: CoverageRepository,
    context: TenantContext,
    coverage: SpatialCoverage,
    derivative: UUID | None,
) -> CoverageView:
    if derivative is None:
        return CoverageView(
            coverage.crs,
            coverage.extent,
            coverage.width,
            coverage.height,
            coverage.bands,
        )
    job = await execute_coverage(
        repository.get_derivative(
            context,
            coverage.project_id,
            coverage.service_id,
            coverage.coverage_id,
            derivative,
        )
    )
    if (
        job.state != "completed"
        or not job.source_available
        or any(
            value is None
            for value in (
                job.output_crs,
                job.output_extent,
                job.output_width,
                job.output_height,
                job.output_bands,
            )
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "spatial_coverage_derivative_not_ready"},
        )
    assert job.output_crs is not None
    assert job.output_extent is not None
    assert job.output_width is not None
    assert job.output_height is not None
    assert job.output_bands is not None
    return CoverageView(
        job.output_crs,
        job.output_extent,
        job.output_width,
        job.output_height,
        job.output_bands,
    )


def _coverage_response(record: SpatialCoverage) -> CoverageResponse:
    return CoverageResponse(
        id=record.coverage_id,
        project_id=record.project_id,
        service_id=record.service_id,
        coverage_name=record.coverage_name,
        dataset_id=record.dataset_id,
        dataset_version_id=record.dataset_version_id,
        data_object_id=record.data_object_id,
        sealed_dataset_version_number=record.sealed_dataset_version_number,
        current_dataset_version_id=record.current_dataset_version_id,
        current_dataset_version_number=record.current_dataset_version_number,
        crs=record.crs,
        extent=record.extent,
        width=record.width,
        height=record.height,
        band_count=record.band_count,
        bands=cast(tuple[dict[str, object], ...], record.bands),
        content_type=record.content_type,
        size_bytes=record.size_bytes,
        checksum_sha256=record.checksum_sha256,
        stale=record.stale,
        target_active=record.target_active,
        title=record.title,
        description=record.description,
        created_by=record.created_by,
        created_at=record.created_at,
        withdrawn_by=record.withdrawn_by,
        withdrawn_at=record.withdrawn_at,
    )


def _derivative_response(record: CoverageDerivativeJob) -> CoverageDerivativeResponse:
    return CoverageDerivativeResponse(
        id=record.job_id,
        project_id=record.project_id,
        service_id=record.service_id,
        coverage_id=record.coverage_id,
        coverage_name=record.coverage_name,
        subset_extent=record.request.subset_extent,
        target_crs=record.request.target_crs,
        target_width=record.request.width,
        target_height=record.request.height,
        resampling=record.request.resampling,
        request_schema_version=record.request.request_schema_version,
        band_indexes=record.request.band_indexes,
        scale_mode=record.request.scale_mode,
        requested_resolution=record.request.resolution,
        request_checksum_sha256=record.request_checksum_sha256,
        state=record.state,
        output_object_id=record.output_object_id,
        output_crs=record.output_crs,
        output_extent=record.output_extent,
        output_width=record.output_width,
        output_height=record.output_height,
        output_band_count=record.output_band_count,
        output_bands=(
            None
            if record.output_bands is None
            else tuple(
                {
                    **band,
                    "source_index": band.get("source_index", record.request.band_indexes[index]),
                }
                for index, band in enumerate(record.output_bands)
            )
        ),
        output_content_type=record.output_content_type,
        output_size_bytes=record.output_size_bytes,
        output_checksum_sha256=record.output_checksum_sha256,
        error_code=record.error_code,
        attempt_count=record.attempt_count,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        source_available=record.source_available,
        reclamation_state=record.reclamation_state,
        output_available=record.output_available,
    )


def _reclamation_preview_response(
    preview: CoverageDerivativeReclamationPreview,
) -> CoverageDerivativeReclamationPreviewResponse:
    return CoverageDerivativeReclamationPreviewResponse(
        derivative_job_id=preview.derivative_job_id,
        output_object_id=preview.output_object_id,
        size_bytes=preview.size_bytes,
        checksum_sha256=preview.checksum_sha256,
        derivative_finished_at=preview.derivative_finished_at,
        expires_at=preview.expires_at,
        preview_checksum_sha256=preview.preview_checksum_sha256,
        physical_action=preview.physical_action,
        history_retained=preview.history_retained,
        ordinary_reads_create_work=preview.ordinary_reads_create_work,
    )


def _reclamation_response(
    reclamation: CoverageDerivativeReclamation,
) -> CoverageDerivativeReclamationResponse:
    return CoverageDerivativeReclamationResponse(
        id=reclamation.reclamation_id,
        derivative_job_id=reclamation.derivative_job_id,
        output_object_id=reclamation.output_object_id,
        state=reclamation.state,
        size_bytes=reclamation.size_bytes,
        checksum_sha256=reclamation.checksum_sha256,
        preview_checksum_sha256=reclamation.preview_checksum_sha256,
        preview_expires_at=reclamation.preview_expires_at,
        error_code=reclamation.error_code,
        attempt_count=reclamation.attempt_count,
        delete_started_at=reclamation.delete_started_at,
        created_by=reclamation.created_by,
        created_at=reclamation.created_at,
        started_at=reclamation.started_at,
        finished_at=reclamation.finished_at,
    )


def _processing_policy_response(
    policy: CoverageProcessingPolicy,
) -> CoverageProcessingPolicyResponse:
    return CoverageProcessingPolicyResponse(
        request_schema_version=policy.request_schema_version,
        maximum_axis_pixels=policy.maximum_axis_pixels,
        maximum_pixels=policy.maximum_pixels,
        maximum_samples=policy.maximum_samples,
        maximum_retained_jobs_per_coverage=policy.maximum_retained_jobs_per_coverage,
        maximum_active_jobs_per_coverage=policy.maximum_active_jobs_per_coverage,
        maximum_output_bytes=policy.maximum_output_bytes,
        supported_resampling=policy.supported_resampling,
        cancellation_states=policy.cancellation_states,
        minimum_reclamation_age_hours=policy.minimum_reclamation_age_hours,
        reclamation_preview_ttl_seconds=policy.reclamation_preview_ttl_seconds,
        physical_reclamation=policy.physical_reclamation,
        ordinary_reads_create_work=policy.ordinary_reads_create_work,
    )


def coverage_collection_document(record: SpatialCoverage, base: str) -> dict[str, Any]:
    root = f"{base}/collections/{record.coverage_name}"
    return {
        "id": record.coverage_name,
        "title": record.title,
        "description": record.description,
        "itemType": "coverage",
        "crs": [_crs_uri(record.crs)],
        "storageCRS": _crs_uri(record.crs),
        "extent": {
            "spatial": {
                "bbox": [list(record.extent)],
                "crs": _crs_uri(record.crs),
            }
        },
        "links": [
            {"href": root, "rel": "self", "type": "application/json"},
            {
                "href": f"{root}/coverage",
                "rel": OGC_COVERAGE_REL,
                "type": "image/tiff; application=geotiff",
            },
            {
                "href": f"{root}/coverage/domainset",
                "rel": OGC_DOMAINSET_REL,
                "type": "application/json",
            },
            {
                "href": f"{root}/coverage/rangetype",
                "rel": OGC_RANGETYPE_REL,
                "type": "application/json",
            },
            {
                "href": f"{root}/schema",
                "rel": "http://www.opengis.net/def/rel/ogc/1.0/schema",
                "type": "application/schema+json",
            },
        ],
        "opengeo:coverageId": str(record.coverage_id),
        "opengeo:datasetId": str(record.dataset_id),
        "opengeo:datasetVersionId": str(record.dataset_version_id),
        "opengeo:shape": [record.width, record.height],
        "opengeo:bandCount": record.band_count,
        "opengeo:stale": record.stale,
        "opengeo:targetActive": record.target_active,
        "opengeo:derivativesAreExplicit": True,
        "opengeo:conformanceClaimed": False,
    }


def _json(body: dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status_code, headers=_private_headers())


def _known_ogc_query(request: Request, allowed: set[str]) -> None:
    items = list(request.query_params.multi_items())
    if len(items) != len({name for name, _ in items}) or any(
        name not in allowed for name, _ in items
    ):
        raise HTTPException(status_code=400, detail="coverage_query_invalid")


def _crs_uri(crs: str) -> str:
    match = re.fullmatch(r"EPSG:([1-9][0-9]{2,7})", crs.upper())
    return f"http://www.opengis.net/def/crs/EPSG/0/{match.group(1)}" if match else crs


def _band_name(band: dict[str, Any], fallback: int) -> str:
    index = band.get("source_index", band.get("index"))
    return f"band-{index if isinstance(index, int) else fallback}"


def _range_field(band: dict[str, Any], fallback: int) -> dict[str, Any]:
    name = _band_name(band, fallback)
    return {
        "name": name,
        "type": "QuantityType",
        "definition": str(band.get("data_type") or "unknown"),
        "label": str(band.get("color_interpretation") or name),
        "uom": {"code": "1"},
    }


def _json_type(data_type: object) -> str:
    return "integer" if data_type in {"Byte", "UInt16", "Int16", "UInt32", "Int32"} else "number"


def _xml(body: bytes, *, status_code: int = 200) -> Response:
    response = Response(body, status_code=status_code, media_type=WCS_MEDIA_TYPE)
    response.headers.update(_private_headers())
    return response


def _private_headers() -> dict[str, str]:
    return {
        "Cache-Control": "private, no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "X-OpenGeo-Conformance-Claimed": "false",
    }


def _wcs_error(
    code: str,
    locator: str,
    message: str,
    status_code: int,
    cause: Exception,
) -> Response:
    del cause
    error = WcsRequestError(code, locator, message, status_code=status_code)
    return _xml(exception_report_xml(error), status_code=status_code)
