import logging
import math
import re
from collections.abc import Awaitable
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.data_preservation import (
    WEB_MERCATOR_MAX_LATITUDE,
    CopyEstimate,
    CopyEstimateSpec,
    DataPreservationAccessDenied,
    DataPreservationConflict,
    DataPreservationNotFound,
    DataPreservationRepository,
    DataPreservationStoreUnavailable,
    ExactObjectScope,
    FeatureCollectionScope,
    PmtilesDerivativeJob,
    PmtilesDerivativeRequest,
    ProtectedCopyJob,
    ProtectedCopyRequest,
    RepositoryCopyEstimate,
    RepositoryProtectedCopyJob,
    WmsBoundedImageScope,
)
from opengeo_api.ingestion import DatasetClassification, Page, ProcessingJobState
from opengeo_api.logging import get_request_id
from opengeo_api.pmtiles_options import normalize_pmtiles_options
from opengeo_api.processing_dispatch import (
    ExternalSourceSnapshotDispatcher,
    PmtilesDerivativeDispatcher,
    ProcessingDispatchUnavailable,
    RepositoryObjectCopyDispatcher,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["durable data preservation"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)
]
RightsBasis = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Attribution = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]
Checksum = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
SourceLayer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Bounds = tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WmsBoundedImageRequest(RequestModel):
    kind: Literal["bounded_image"]
    bounds: Bounds
    width: int = Field(ge=1, le=4096)
    height: int = Field(ge=1, le=4096)

    @field_validator("bounds", mode="after")
    @classmethod
    def validate_bounds(cls, value: Bounds) -> Bounds:
        bounds = _ordered_bounds(value)
        if bounds[1] < -WEB_MERCATOR_MAX_LATITUDE or bounds[3] > WEB_MERCATOR_MAX_LATITUDE:
            raise ValueError("bounds exceed the EPSG:3857 latitude limit")
        return bounds

    @model_validator(mode="after")
    def validate_pixel_limit(self) -> "WmsBoundedImageRequest":
        if self.width * self.height > 16_777_216:
            raise ValueError("bounded image exceeds the 16,777,216 pixel limit")
        return self


class ExactObjectRequest(RequestModel):
    kind: Literal["exact_object"]


class WmsCopyEstimateRequest(RequestModel):
    source_type: Literal["wms"]
    scope: WmsBoundedImageRequest


class PmtilesCopyEstimateRequest(RequestModel):
    source_type: Literal["pmtiles"]
    scope: ExactObjectRequest


class FeatureCollectionRequest(RequestModel):
    kind: Literal["bounded_features"]
    bounds: Bounds
    maximum_features: int = Field(ge=1, le=50_000)
    page_size: int = Field(ge=1, le=2_000)

    @field_validator("bounds", mode="after")
    @classmethod
    def validate_bounds(cls, value: Bounds) -> Bounds:
        return _ordered_bounds(value)

    @model_validator(mode="after")
    def validate_request_count(self) -> "FeatureCollectionRequest":
        requests = (self.maximum_features + self.page_size - 1) // self.page_size
        if requests > 64:
            raise ValueError("bounded feature extraction exceeds 64 requests")
        return self


class ArcgisCopyEstimateRequest(RequestModel):
    source_type: Literal["arcgis"]
    scope: FeatureCollectionRequest


class WfsCopyEstimateRequest(RequestModel):
    source_type: Literal["wfs"]
    scope: FeatureCollectionRequest


CopyEstimateRequest = Annotated[
    WmsCopyEstimateRequest
    | PmtilesCopyEstimateRequest
    | ArcgisCopyEstimateRequest
    | WfsCopyEstimateRequest,
    Field(discriminator="source_type"),
]


class AcceptedEstimateRequest(RequestModel):
    estimate_id: UUID
    estimate_checksum_sha256: Checksum
    accepted: Literal[True]


class RightsConfirmationRequest(RequestModel):
    confirmed: Literal[True]
    basis: RightsBasis
    attribution: Attribution


class ProtectedCopyDestinationRequest(RequestModel):
    name: Name
    description: Description | None = None
    classification: DatasetClassification = "internal"


class CreateProtectedCopyRequest(RequestModel):
    idempotency_key: UUID
    estimate: AcceptedEstimateRequest
    rights: RightsConfirmationRequest
    destination: ProtectedCopyDestinationRequest


class CaptureRefreshTarget(RequestModel):
    dataset_id: UUID
    expected_base_version_id: UUID


class CreateSourceCaptureRequest(CreateProtectedCopyRequest):
    refresh_target: CaptureRefreshTarget | None = None


class CreatePmtilesDerivativeRequest(RequestModel):
    idempotency_key: UUID
    bounds: Bounds
    min_zoom: int = Field(ge=0, le=22)
    max_zoom: int = Field(ge=0, le=22)
    source_layer: SourceLayer
    options: dict[str, Any] | None = None

    @field_validator("options", mode="before")
    @classmethod
    def normalize_options(cls, value: object) -> dict[str, Any] | None:
        return normalize_pmtiles_options(value) if value is not None else None

    @field_validator("bounds", mode="after")
    @classmethod
    def validate_bounds(cls, value: Bounds) -> Bounds:
        return _ordered_bounds(value)

    @field_validator("source_layer", mode="after")
    @classmethod
    def reject_control_characters(cls, value: str) -> str:
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("source_layer contains a control character")
        return value

    @model_validator(mode="after")
    def validate_zoom_range(self) -> "CreatePmtilesDerivativeRequest":
        if self.min_zoom > self.max_zoom:
            raise ValueError("min_zoom must not exceed max_zoom")
        if (
            self.options is not None
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,62}", self.source_layer) is None
        ):
            raise ValueError("source_layer must be a supported output tile identifier")
        return self


class CopyEstimateResponse(BaseModel):
    schema_version: Literal["opengeo.external-source-copy-estimate.1.0.0"] = (
        "opengeo.external-source-copy-estimate.1.0.0"
    )
    estimate_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    source_revision_number: int
    source_type: Literal["wms", "pmtiles", "arcgis", "wfs"]
    copy_method: str
    capture_scope: dict[str, Any]
    output_format: str
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    created_at: datetime
    expires_at: datetime


class ProtectedCopyResponse(BaseModel):
    schema_version: Literal["opengeo.protected-copy-job.1.0.0"] = "opengeo.protected-copy-job.1.0.0"
    job_id: UUID
    project_id: UUID
    estimate_id: UUID
    source_dataset_id: UUID
    source_revision_number: int
    destination_dataset_id: UUID
    destination_name: str
    destination_classification: DatasetClassification
    copy_method: str
    capture_scope: dict[str, Any]
    output_format: str
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
    cancellable: bool


class RepositoryCopyEstimateResponse(BaseModel):
    schema_version: Literal["opengeo.repository-object-copy-estimate.1.0.0"] = (
        "opengeo.repository-object-copy-estimate.1.0.0"
    )
    estimate_id: UUID
    project_id: UUID
    source_dataset_id: UUID
    connection_target_revision: int
    provider_version_id: str
    copy_method: Literal["exact_object_copy"] = "exact_object_copy"
    output_format: str
    output_content_type: str
    maximum_requests: int
    maximum_output_bytes: int
    estimated_cost_usd: Decimal
    estimate_checksum_sha256: str
    created_at: datetime
    expires_at: datetime


class RepositoryProtectedCopyResponse(BaseModel):
    schema_version: Literal["opengeo.repository-object-protected-copy-job.1.0.0"] = (
        "opengeo.repository-object-protected-copy-job.1.0.0"
    )
    job_id: UUID
    project_id: UUID
    estimate_id: UUID
    source_dataset_id: UUID
    destination_dataset_id: UUID
    destination_name: str
    destination_classification: DatasetClassification
    connection_target_revision: int
    provider_version_id: str
    copy_method: Literal["exact_object_copy"] = "exact_object_copy"
    output_format: str
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
    cancellable: bool


class _PmtilesDerivativeResponseFields(BaseModel):
    schema_version: str = "opengeo.pmtiles-derivative-job.1.0.0"
    job_id: UUID
    project_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    source_object_id: UUID
    bounds: Bounds
    min_zoom: int
    max_zoom: int
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
    cancellable: bool


class PmtilesDerivativeResponse(_PmtilesDerivativeResponseFields):
    schema_version: Literal["opengeo.pmtiles-derivative-job.1.0.0"] = (
        "opengeo.pmtiles-derivative-job.1.0.0"
    )


class ConfigurablePmtilesDerivativeResponse(_PmtilesDerivativeResponseFields):
    schema_version: Literal["opengeo.pmtiles-derivative-job.1.1.0"] = (
        "opengeo.pmtiles-derivative-job.1.1.0"
    )
    recipe: Literal["gdal-pmtiles-v2"] = "gdal-pmtiles-v2"
    options: dict[str, Any]
    worker_image_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


def repository_from_request(request: Request) -> DataPreservationRepository:
    return cast(DataPreservationRepository, request.app.state.data_preservation_repository)


def snapshot_dispatcher_from_request(request: Request) -> ExternalSourceSnapshotDispatcher:
    return cast(
        ExternalSourceSnapshotDispatcher,
        request.app.state.external_source_snapshot_dispatcher,
    )


def repository_copy_dispatcher_from_request(request: Request) -> RepositoryObjectCopyDispatcher:
    return cast(
        RepositoryObjectCopyDispatcher,
        request.app.state.repository_object_copy_dispatcher,
    )


def pmtiles_dispatcher_from_request(request: Request) -> PmtilesDerivativeDispatcher:
    return cast(PmtilesDerivativeDispatcher, request.app.state.pmtiles_derivative_dispatcher)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit, offset)


PageDependency = Annotated[Page, Depends(page_parameters)]


async def execute_preservation[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except DataPreservationAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except DataPreservationNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except DataPreservationConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except DataPreservationStoreUnavailable as error:
        logger.error("data_preservation.store_unavailable")
        raise HTTPException(
            status_code=503, detail="data_preservation_store_unavailable"
        ) from error


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/source/revisions/"
    "{source_revision_number}/copy-estimates",
    response_model=CopyEstimateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_copy_estimate(
    project_id: UUID,
    source_dataset_id: UUID,
    source_revision_number: int,
    payload: CopyEstimateRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> CopyEstimateResponse:
    if source_revision_number < 1:
        raise HTTPException(status_code=422, detail="source_revision_number_must_be_positive")
    if isinstance(payload, WmsCopyEstimateRequest):
        spec = CopyEstimateSpec(
            "wms",
            WmsBoundedImageScope(
                payload.scope.bounds,
                payload.scope.width,
                payload.scope.height,
            ),
        )
    elif isinstance(payload, PmtilesCopyEstimateRequest):
        spec = CopyEstimateSpec("pmtiles", ExactObjectScope())
    else:
        spec = CopyEstimateSpec(
            payload.source_type,
            FeatureCollectionScope(
                payload.scope.bounds,
                payload.scope.maximum_features,
                payload.scope.page_size,
            ),
        )
    record = await execute_preservation(
        repository.create_copy_estimate(
            tenant_context(session),
            project_id,
            source_dataset_id,
            source_revision_number,
            spec,
            get_request_id(),
        )
    )
    return copy_estimate_response(record)


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/source/revisions/"
    "{source_revision_number}/protected-copies",
    response_model=ProtectedCopyResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    source_revision_number: int,
    payload: CreateSourceCaptureRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        ExternalSourceSnapshotDispatcher, Depends(snapshot_dispatcher_from_request)
    ],
) -> ProtectedCopyResponse:
    submission = await execute_preservation(
        repository.request_protected_copy(
            tenant_context(session),
            project_id,
            source_dataset_id,
            source_revision_number,
            ProtectedCopyRequest(
                estimate_id=payload.estimate.estimate_id,
                estimate_checksum_sha256=payload.estimate.estimate_checksum_sha256,
                idempotency_key=payload.idempotency_key,
                destination_name=payload.destination.name,
                destination_description=payload.destination.description,
                destination_classification=payload.destination.classification,
                rights_basis=payload.rights.basis,
                attribution=payload.rights.attribution,
                target_dataset_id=payload.refresh_target.dataset_id
                if payload.refresh_target
                else None,
                expected_base_version_id=(
                    payload.refresh_target.expected_base_version_id
                    if payload.refresh_target
                    else None
                ),
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_external_source_snapshot(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("external_source_snapshot.dispatch_unavailable")
            raise HTTPException(
                status_code=503, detail="external_source_snapshot_dispatch_unavailable"
            ) from error
    return protected_copy_response(submission.job)


@router.get(
    "/projects/{project_id}/datasets/{source_dataset_id}/protected-copies",
    response_model=list[ProtectedCopyResponse],
)
async def list_protected_copies(
    project_id: UUID,
    source_dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[ProtectedCopyResponse]:
    records = await execute_preservation(
        repository.list_protected_copies(
            tenant_context(session), project_id, source_dataset_id, page
        )
    )
    return [protected_copy_response(record) for record in records]


@router.get(
    "/projects/{project_id}/datasets/{source_dataset_id}/protected-copies/{job_id}",
    response_model=ProtectedCopyResponse,
)
async def get_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> ProtectedCopyResponse:
    record = await execute_preservation(
        repository.get_protected_copy(
            tenant_context(session), project_id, source_dataset_id, job_id
        )
    )
    return protected_copy_response(record)


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/protected-copies/{job_id}/cancel",
    response_model=ProtectedCopyResponse,
)
async def cancel_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> ProtectedCopyResponse:
    record = await execute_preservation(
        repository.cancel_protected_copy(
            tenant_context(session),
            project_id,
            source_dataset_id,
            job_id,
            get_request_id(),
        )
    )
    return protected_copy_response(record)


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/repository-copy-estimates",
    response_model=RepositoryCopyEstimateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_repository_copy_estimate(
    project_id: UUID,
    source_dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> RepositoryCopyEstimateResponse:
    record = await execute_preservation(
        repository.create_repository_copy_estimate(
            tenant_context(session), project_id, source_dataset_id, get_request_id()
        )
    )
    return repository_copy_estimate_response(record)


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/repository-protected-copies",
    response_model=RepositoryProtectedCopyResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_repository_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    payload: CreateProtectedCopyRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    dispatcher: Annotated[
        RepositoryObjectCopyDispatcher, Depends(repository_copy_dispatcher_from_request)
    ],
) -> RepositoryProtectedCopyResponse:
    submission = await execute_preservation(
        repository.request_repository_protected_copy(
            tenant_context(session),
            project_id,
            source_dataset_id,
            ProtectedCopyRequest(
                estimate_id=payload.estimate.estimate_id,
                estimate_checksum_sha256=payload.estimate.estimate_checksum_sha256,
                idempotency_key=payload.idempotency_key,
                destination_name=payload.destination.name,
                destination_description=payload.destination.description,
                destination_classification=payload.destination.classification,
                rights_basis=payload.rights.basis,
                attribution=payload.rights.attribution,
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_repository_object_copy(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("repository_object_copy.dispatch_unavailable")
            raise HTTPException(
                status_code=503, detail="repository_object_copy_dispatch_unavailable"
            ) from error
    return repository_protected_copy_response(submission.job)


@router.get(
    "/projects/{project_id}/datasets/{source_dataset_id}/repository-protected-copies",
    response_model=list[RepositoryProtectedCopyResponse],
)
async def list_repository_protected_copies(
    project_id: UUID,
    source_dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[RepositoryProtectedCopyResponse]:
    records = await execute_preservation(
        repository.list_repository_protected_copies(
            tenant_context(session), project_id, source_dataset_id, page
        )
    )
    return [repository_protected_copy_response(record) for record in records]


@router.get(
    "/projects/{project_id}/datasets/{source_dataset_id}/repository-protected-copies/{job_id}",
    response_model=RepositoryProtectedCopyResponse,
)
async def get_repository_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> RepositoryProtectedCopyResponse:
    record = await execute_preservation(
        repository.get_repository_protected_copy(
            tenant_context(session), project_id, source_dataset_id, job_id
        )
    )
    return repository_protected_copy_response(record)


@router.post(
    "/projects/{project_id}/datasets/{source_dataset_id}/repository-protected-copies/"
    "{job_id}/cancel",
    response_model=RepositoryProtectedCopyResponse,
)
async def cancel_repository_protected_copy(
    project_id: UUID,
    source_dataset_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> RepositoryProtectedCopyResponse:
    record = await execute_preservation(
        repository.cancel_repository_protected_copy(
            tenant_context(session),
            project_id,
            source_dataset_id,
            job_id,
            get_request_id(),
        )
    )
    return repository_protected_copy_response(record)


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/versions/"
    "{dataset_version_id}/pmtiles-derivatives",
    response_model=PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_pmtiles_derivative(
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    payload: CreatePmtilesDerivativeRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    dispatcher: Annotated[PmtilesDerivativeDispatcher, Depends(pmtiles_dispatcher_from_request)],
) -> PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse:
    recipe = "gdal-pmtiles-v2" if payload.options is not None else "gdal-pmtiles-v1"
    if not dispatcher.supports_recipe(recipe):
        raise HTTPException(status_code=503, detail="pmtiles_derivative_recipe_unavailable")
    submission = await execute_preservation(
        repository.request_pmtiles_derivative(
            tenant_context(session),
            project_id,
            dataset_id,
            dataset_version_id,
            PmtilesDerivativeRequest(
                bounds=payload.bounds,
                minimum_zoom=payload.min_zoom,
                maximum_zoom=payload.max_zoom,
                source_layer=payload.source_layer,
                idempotency_key=payload.idempotency_key,
                options=payload.options,
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_pmtiles_derivative(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("pmtiles_derivative.dispatch_unavailable")
            raise HTTPException(
                status_code=503, detail="pmtiles_derivative_dispatch_unavailable"
            ) from error
    return pmtiles_derivative_response(submission.job)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/"
    "{dataset_version_id}/pmtiles-derivatives",
    response_model=list[PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse],
)
async def list_pmtiles_derivatives(
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse]:
    records = await execute_preservation(
        repository.list_pmtiles_derivatives(
            tenant_context(session), project_id, dataset_id, dataset_version_id, page
        )
    )
    return [pmtiles_derivative_response(record) for record in records]


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/"
    "{dataset_version_id}/pmtiles-derivatives/{job_id}",
    response_model=PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse,
)
async def get_pmtiles_derivative(
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse:
    record = await execute_preservation(
        repository.get_pmtiles_derivative(
            tenant_context(session), project_id, dataset_id, dataset_version_id, job_id
        )
    )
    return pmtiles_derivative_response(record)


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/versions/"
    "{dataset_version_id}/pmtiles-derivatives/{job_id}/cancel",
    response_model=PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse,
)
async def cancel_pmtiles_derivative(
    project_id: UUID,
    dataset_id: UUID,
    dataset_version_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse:
    record = await execute_preservation(
        repository.cancel_pmtiles_derivative(
            tenant_context(session),
            project_id,
            dataset_id,
            dataset_version_id,
            job_id,
            get_request_id(),
        )
    )
    return pmtiles_derivative_response(record)


def copy_estimate_response(record: CopyEstimate) -> CopyEstimateResponse:
    return CopyEstimateResponse(
        estimate_id=record.estimate_id,
        project_id=record.project_id,
        source_dataset_id=record.source_dataset_id,
        source_revision_number=record.source_revision_number,
        source_type=record.source_type,
        copy_method=record.copy_method,
        capture_scope=record.capture_scope,
        output_format=record.output_format,
        output_content_type=record.output_content_type,
        maximum_requests=record.maximum_requests,
        maximum_output_bytes=record.maximum_output_bytes,
        estimated_cost_usd=record.estimated_cost_usd,
        estimate_checksum_sha256=record.estimate_checksum_sha256,
        created_at=record.created_at,
        expires_at=record.expires_at,
    )


def protected_copy_response(record: ProtectedCopyJob) -> ProtectedCopyResponse:
    return ProtectedCopyResponse(
        job_id=record.job_id,
        project_id=record.project_id,
        estimate_id=record.estimate_id,
        source_dataset_id=record.source_dataset_id,
        source_revision_number=record.source_revision_number,
        destination_dataset_id=record.destination_dataset_id,
        destination_name=record.destination_name,
        destination_classification=record.destination_classification,
        copy_method=record.copy_method,
        capture_scope=record.capture_scope,
        output_format=record.output_format,
        output_content_type=record.output_content_type,
        maximum_requests=record.maximum_requests,
        maximum_output_bytes=record.maximum_output_bytes,
        estimated_cost_usd=record.estimated_cost_usd,
        estimate_checksum_sha256=record.estimate_checksum_sha256,
        estimate_expires_at=record.estimate_expires_at,
        rights_basis=record.rights_basis,
        attribution=record.attribution,
        request_checksum_sha256=record.request_checksum_sha256,
        idempotency_key=record.idempotency_key,
        state=record.state,
        output_object_id=record.output_object_id,
        output_dataset_version_id=record.output_dataset_version_id,
        error_code=record.error_code,
        attempt_count=record.attempt_count,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        cancellable=record.state == "queued",
    )


def repository_copy_estimate_response(
    record: RepositoryCopyEstimate,
) -> RepositoryCopyEstimateResponse:
    return RepositoryCopyEstimateResponse(
        estimate_id=record.estimate_id,
        project_id=record.project_id,
        source_dataset_id=record.source_dataset_id,
        connection_target_revision=record.connection_target_revision,
        provider_version_id=record.provider_version_id,
        output_format=record.output_format,
        output_content_type=record.output_content_type,
        maximum_requests=record.maximum_requests,
        maximum_output_bytes=record.maximum_output_bytes,
        estimated_cost_usd=record.estimated_cost_usd,
        estimate_checksum_sha256=record.estimate_checksum_sha256,
        created_at=record.created_at,
        expires_at=record.expires_at,
    )


def repository_protected_copy_response(
    record: RepositoryProtectedCopyJob,
) -> RepositoryProtectedCopyResponse:
    return RepositoryProtectedCopyResponse(
        job_id=record.job_id,
        project_id=record.project_id,
        estimate_id=record.estimate_id,
        source_dataset_id=record.source_dataset_id,
        destination_dataset_id=record.destination_dataset_id,
        destination_name=record.destination_name,
        destination_classification=record.destination_classification,
        connection_target_revision=record.connection_target_revision,
        provider_version_id=record.provider_version_id,
        output_format=record.output_format,
        output_content_type=record.output_content_type,
        maximum_requests=record.maximum_requests,
        maximum_output_bytes=record.maximum_output_bytes,
        estimated_cost_usd=record.estimated_cost_usd,
        estimate_checksum_sha256=record.estimate_checksum_sha256,
        estimate_expires_at=record.estimate_expires_at,
        rights_basis=record.rights_basis,
        attribution=record.attribution,
        request_checksum_sha256=record.request_checksum_sha256,
        idempotency_key=record.idempotency_key,
        state=record.state,
        output_object_id=record.output_object_id,
        output_dataset_version_id=record.output_dataset_version_id,
        error_code=record.error_code,
        attempt_count=record.attempt_count,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        cancellable=record.state == "queued",
    )


def pmtiles_derivative_response(
    record: PmtilesDerivativeJob,
) -> PmtilesDerivativeResponse | ConfigurablePmtilesDerivativeResponse:
    response = PmtilesDerivativeResponse(
        job_id=record.job_id,
        project_id=record.project_id,
        dataset_id=record.dataset_id,
        dataset_version_id=record.dataset_version_id,
        source_object_id=record.source_object_id,
        bounds=record.bounds,
        min_zoom=record.minimum_zoom,
        max_zoom=record.maximum_zoom,
        source_layer=record.source_layer,
        request_checksum_sha256=record.request_checksum_sha256,
        idempotency_key=record.idempotency_key,
        state=record.state,
        output_object_id=record.output_object_id,
        output_size_bytes=record.output_size_bytes,
        output_checksum_sha256=record.output_checksum_sha256,
        error_code=record.error_code,
        attempt_count=record.attempt_count,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        cancellable=record.state == "queued",
    )
    if record.options is not None:
        return ConfigurablePmtilesDerivativeResponse(
            **{
                **response.model_dump(),
                "schema_version": "opengeo.pmtiles-derivative-job.1.1.0",
                "options": record.options,
                "worker_image_digest": record.worker_image_digest,
            }
        )
    return response


def _ordered_bounds(value: Bounds) -> Bounds:
    west, south, east, north = value
    if (
        not all(math.isfinite(coordinate) for coordinate in value)
        or not -180 <= west < east <= 180
        or not -90 <= south < north <= 90
    ):
        raise ValueError("bounds must be ordered WGS84 longitude/latitude coordinates")
    return value
