import asyncio
import logging
import math
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import ProcessingDispatchUnavailable, RenderDispatcher
from opengeo_api.render_routes import (
    DIRECT_MAP_MAX_BYTES,
    _map_job_matches,
    _map_render_request,
    dispatcher_from_request,
    execute_render,
)
from opengeo_api.render_routes import (
    repository_from_request as render_repository_from_request,
)
from opengeo_api.rendering import RenderRepository
from opengeo_api.resource_routes import tenant_context
from opengeo_api.spatial_service_routes import (
    execute_service,
    web_mercator_tile_bbox,
)
from opengeo_api.spatial_service_routes import (
    repository_from_request as spatial_repository_from_request,
)
from opengeo_api.spatial_services import (
    RetiredSpatialTileCacheVersion,
    SpatialServiceAccessDenied,
    SpatialServiceCollection,
    SpatialServiceNotFound,
    SpatialServiceRepository,
    SpatialServiceStoreUnavailable,
    SpatialTileCacheEntry,
    SpatialTileCachePolicy,
    SpatialTileCacheReclamation,
    SpatialTileCacheReclamationPreview,
    SpatialTileCoordinate,
    SpatialTileSeedPlan,
    SpatialTileSeedPlanPreview,
)
from opengeo_api.wmts import (
    WEB_MERCATOR_QUAD,
    WmtsLayer,
    WmtsRequestError,
    WmtsTileRequest,
    capabilities_xml,
    exception_xml,
    parse_wmts_request,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["durable tile cache and WMTS"])

ChangeMessage = Annotated[
    str | None,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConfigureTileCacheRequest(RequestModel):
    expected_version: int = Field(ge=0)
    minimum_tile_matrix: int = Field(default=0, ge=0, le=22)
    maximum_tile_matrix: int = Field(ge=0, le=22)
    maximum_entries: int = Field(ge=1, le=10_000)
    change_message: ChangeMessage = None

    @model_validator(mode="after")
    def validate_matrix_range(self) -> "ConfigureTileCacheRequest":
        if self.maximum_tile_matrix < self.minimum_tile_matrix:
            raise ValueError("maximum_tile_matrix must not be less than minimum_tile_matrix")
        return self


class InvalidateTileCacheRequest(RequestModel):
    expected_version: int = Field(ge=1)
    change_message: ChangeMessage = None


class SeedTileRequest(RequestModel):
    expected_cache_version: int = Field(ge=1)
    tile_matrix: int = Field(ge=0, le=22)
    tile_row: int = Field(ge=0, le=(1 << 22) - 1)
    tile_col: int = Field(ge=0, le=(1 << 22) - 1)


class ConfirmTileCacheReclamationRequest(RequestModel):
    preview_checksum_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    preview_expires_at: datetime


class TileCoordinateRequest(RequestModel):
    tile_matrix: int = Field(ge=0, le=22)
    tile_row: int = Field(ge=0, le=(1 << 22) - 1)
    tile_col: int = Field(ge=0, le=(1 << 22) - 1)


class TileSeedPlanSelector(RequestModel):
    expected_cache_version: int = Field(ge=1)
    mode: Literal["tiles", "bbox"]
    tiles: list[TileCoordinateRequest] | None = Field(default=None, max_length=64)
    bbox: tuple[float, float, float, float] | None = None
    minimum_tile_matrix: int | None = Field(default=None, ge=0, le=22)
    maximum_tile_matrix: int | None = Field(default=None, ge=0, le=22)

    @model_validator(mode="after")
    def validate_selector(self) -> "TileSeedPlanSelector":
        if self.mode == "tiles":
            if not self.tiles or self.bbox is not None:
                raise ValueError("tiles mode requires tiles and forbids bbox")
            if self.minimum_tile_matrix is not None or self.maximum_tile_matrix is not None:
                raise ValueError("tiles mode derives its zoom range from the coordinates")
        else:
            if self.tiles is not None or self.bbox is None:
                raise ValueError("bbox mode requires bbox and forbids tiles")
            if self.minimum_tile_matrix is None or self.maximum_tile_matrix is None:
                raise ValueError("bbox mode requires a zoom range")
            if self.maximum_tile_matrix < self.minimum_tile_matrix:
                raise ValueError("maximum_tile_matrix must not be less than minimum_tile_matrix")
            west, south, east, north = self.bbox
            if (
                not all(math.isfinite(value) for value in self.bbox)
                or not -180 <= west < east <= 180
                or not -85.05112878 <= south < north <= 85.05112878
            ):
                raise ValueError("bbox must be a non-wrapping CRS84 Web Mercator extent")
        return self


class ConfirmTileSeedPlanRequest(TileSeedPlanSelector):
    preview_checksum_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    preview_expires_at: datetime


class TileCachePolicyResponse(BaseModel):
    id: UUID
    project_id: UUID
    service_id: UUID
    binding_id: UUID
    version_id: UUID
    version_number: int
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    maximum_entries: int
    current_entries: int
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime
    cache_mode: str = "seeded-cache-only"
    fixed_inactive_compute_cost: str = "$0"


class SeedTileResponse(BaseModel):
    cache_id: UUID
    cache_version: int
    tile_matrix: int
    tile_row: int
    tile_col: int
    render_job_id: UUID
    render_state: str
    tile_available: bool


class RetiredTileCacheVersionResponse(BaseModel):
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    maximum_entries: int
    change_message: str | None
    created_at: datetime
    retired_at: datetime
    entry_count: int
    render_output_count: int
    reclamation_id: UUID | None
    reclamation_state: str | None
    reclamation_target_count: int | None
    reclamation_completed_count: int
    reclamation_failed_count: int


class TileCacheReclamationPreviewResponse(BaseModel):
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    target_count: int
    remaining_eligible_target_count: int
    target_size_bytes: int
    oldest_render_finished_at: datetime
    newest_render_finished_at: datetime
    expires_at: datetime
    preview_checksum_sha256: str
    physical_action: str
    render_history_retained: bool
    cache_history_retained: bool
    ordinary_reads_create_work: bool
    batch_limit: int = 64
    minimum_reclamation_age_hours: int = 24
    fixed_inactive_compute_cost: str = "$0"


class TileCacheReclamationResponse(BaseModel):
    id: UUID
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    target_count: int
    target_size_bytes: int
    state: str
    error_code: str | None
    attempt_count: int
    completed_target_count: int
    failed_target_count: int
    preview_checksum_sha256: str
    preview_expires_at: datetime
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class TileCoordinateResponse(BaseModel):
    tile_matrix: int
    tile_row: int
    tile_col: int


class TileSeedPlanPreviewResponse(BaseModel):
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    mode: str
    bbox: tuple[float, float, float, float] | None
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    requested_count: int
    existing_count: int
    target_count: int
    targets: list[TileCoordinateResponse]
    expires_at: datetime
    preview_checksum_sha256: str
    expansion_order: str = "tile_matrix,tile_row,tile_col"
    batch_limit: int = 64
    confirmation_required: bool = True
    ordinary_reads_create_work: bool = False
    fixed_inactive_compute_cost: str = "$0"


class TileSeedPlanItemResponse(TileCoordinateResponse):
    position: int
    render_job_id: UUID | None
    state: str
    error_code: str | None
    started_at: datetime | None
    finished_at: datetime | None


class TileSeedPlanResponse(BaseModel):
    id: UUID
    cache_id: UUID
    cache_version_id: UUID
    cache_version_number: int
    mode: str
    bbox: tuple[float, float, float, float] | None
    minimum_tile_matrix: int
    maximum_tile_matrix: int
    requested_count: int
    existing_count: int
    target_count: int
    preview_checksum_sha256: str
    preview_expires_at: datetime
    state: str
    error_code: str | None
    created_by: UUID
    created_at: datetime
    dispatch_started_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    items: list[TileSeedPlanItemResponse]
    cancel_available: bool
    activation: str = "explicit-confirmation-only"
    ordinary_reads_create_work: bool = False
    fixed_inactive_compute_cost: str = "$0"


def _policy_response(record: SpatialTileCachePolicy) -> TileCachePolicyResponse:
    return TileCachePolicyResponse(
        id=record.cache_id,
        project_id=record.project_id,
        service_id=record.service_id,
        binding_id=record.binding_id,
        version_id=record.version_id,
        version_number=record.version_number,
        minimum_tile_matrix=record.minimum_tile_matrix,
        maximum_tile_matrix=record.maximum_tile_matrix,
        maximum_entries=record.maximum_entries,
        current_entries=record.current_entries,
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at,
        updated_by=record.updated_by,
        updated_at=record.updated_at,
    )


def _retired_version_response(
    record: RetiredSpatialTileCacheVersion,
) -> RetiredTileCacheVersionResponse:
    return RetiredTileCacheVersionResponse(
        cache_id=record.cache_id,
        cache_version_id=record.cache_version_id,
        cache_version_number=record.cache_version_number,
        minimum_tile_matrix=record.minimum_tile_matrix,
        maximum_tile_matrix=record.maximum_tile_matrix,
        maximum_entries=record.maximum_entries,
        change_message=record.change_message,
        created_at=record.created_at,
        retired_at=record.retired_at,
        entry_count=record.entry_count,
        render_output_count=record.render_output_count,
        reclamation_id=record.reclamation_id,
        reclamation_state=record.reclamation_state,
        reclamation_target_count=record.reclamation_target_count,
        reclamation_completed_count=record.reclamation_completed_count,
        reclamation_failed_count=record.reclamation_failed_count,
    )


def _reclamation_preview_response(
    record: SpatialTileCacheReclamationPreview,
) -> TileCacheReclamationPreviewResponse:
    return TileCacheReclamationPreviewResponse(
        cache_id=record.cache_id,
        cache_version_id=record.cache_version_id,
        cache_version_number=record.cache_version_number,
        target_count=record.target_count,
        remaining_eligible_target_count=record.remaining_eligible_target_count,
        target_size_bytes=record.target_size_bytes,
        oldest_render_finished_at=record.oldest_render_finished_at,
        newest_render_finished_at=record.newest_render_finished_at,
        expires_at=record.expires_at,
        preview_checksum_sha256=record.preview_checksum_sha256,
        physical_action=record.physical_action,
        render_history_retained=record.render_history_retained,
        cache_history_retained=record.cache_history_retained,
        ordinary_reads_create_work=record.ordinary_reads_create_work,
    )


def _reclamation_response(
    record: SpatialTileCacheReclamation,
) -> TileCacheReclamationResponse:
    return TileCacheReclamationResponse(
        id=record.reclamation_id,
        cache_id=record.cache_id,
        cache_version_id=record.cache_version_id,
        cache_version_number=record.cache_version_number,
        target_count=record.target_count,
        target_size_bytes=record.target_size_bytes,
        state=record.state,
        error_code=record.error_code,
        attempt_count=record.attempt_count,
        completed_target_count=record.completed_target_count,
        failed_target_count=record.failed_target_count,
        preview_checksum_sha256=record.preview_checksum_sha256,
        preview_expires_at=record.preview_expires_at,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
    )


def _coordinate_response(record: SpatialTileCoordinate) -> TileCoordinateResponse:
    return TileCoordinateResponse(
        tile_matrix=record.tile_matrix,
        tile_row=record.tile_row,
        tile_col=record.tile_col,
    )


def _seed_plan_preview_response(
    record: SpatialTileSeedPlanPreview,
) -> TileSeedPlanPreviewResponse:
    return TileSeedPlanPreviewResponse(
        cache_id=record.cache_id,
        cache_version_id=record.cache_version_id,
        cache_version_number=record.cache_version_number,
        mode=record.mode,
        bbox=record.request_bbox,
        minimum_tile_matrix=record.minimum_tile_matrix,
        maximum_tile_matrix=record.maximum_tile_matrix,
        requested_count=record.requested_count,
        existing_count=record.existing_count,
        target_count=len(record.targets),
        targets=[_coordinate_response(item) for item in record.targets],
        expires_at=record.expires_at,
        preview_checksum_sha256=record.preview_checksum_sha256,
    )


def _seed_plan_response(record: SpatialTileSeedPlan) -> TileSeedPlanResponse:
    return TileSeedPlanResponse(
        id=record.plan_id,
        cache_id=record.cache_id,
        cache_version_id=record.cache_version_id,
        cache_version_number=record.cache_version_number,
        mode=record.mode,
        bbox=record.request_bbox,
        minimum_tile_matrix=record.minimum_tile_matrix,
        maximum_tile_matrix=record.maximum_tile_matrix,
        requested_count=record.requested_count,
        existing_count=record.existing_count,
        target_count=record.target_count,
        preview_checksum_sha256=record.preview_checksum_sha256,
        preview_expires_at=record.preview_expires_at,
        state=record.state,
        error_code=record.error_code,
        created_by=record.created_by,
        created_at=record.created_at,
        dispatch_started_at=record.dispatch_started_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
        items=[
            TileSeedPlanItemResponse(
                position=item.position,
                tile_matrix=item.coordinate.tile_matrix,
                tile_row=item.coordinate.tile_row,
                tile_col=item.coordinate.tile_col,
                render_job_id=item.render_job_id,
                state=item.state,
                error_code=item.error_code,
                started_at=item.started_at,
                finished_at=item.finished_at,
            )
            for item in record.items
        ],
        cancel_available=record.state == "preparing",
    )


def _bbox_tile_coordinates(
    bbox: tuple[float, float, float, float], minimum_zoom: int, maximum_zoom: int
) -> tuple[SpatialTileCoordinate, ...]:
    west, south, east, north = bbox

    def longitude_x(longitude: float, width: int) -> float:
        return (longitude + 180.0) / 360.0 * width

    def latitude_y(latitude: float, width: int) -> float:
        radians = math.radians(latitude)
        return (1.0 - math.asinh(math.tan(radians)) / math.pi) / 2.0 * width

    coordinates: list[SpatialTileCoordinate] = []
    for tile_matrix in range(minimum_zoom, maximum_zoom + 1):
        width = 1 << tile_matrix
        first_col = max(0, min(width - 1, math.floor(longitude_x(west, width))))
        last_col = max(
            0,
            min(
                width - 1,
                math.floor(math.nextafter(longitude_x(east, width), -math.inf)),
            ),
        )
        first_row = max(0, min(width - 1, math.floor(latitude_y(north, width))))
        last_row = max(
            0,
            min(
                width - 1,
                math.floor(math.nextafter(latitude_y(south, width), -math.inf)),
            ),
        )
        for tile_row in range(first_row, last_row + 1):
            for tile_col in range(first_col, last_col + 1):
                coordinates.append(SpatialTileCoordinate(tile_matrix, tile_row, tile_col))
                if len(coordinates) > 64:
                    raise HTTPException(
                        status_code=422,
                        detail={"code": "spatial_tile_seed_plan_batch_limit"},
                    )
    return tuple(coordinates)


def _seed_plan_selector(
    payload: TileSeedPlanSelector,
) -> tuple[
    str,
    tuple[float, float, float, float] | None,
    int,
    int,
    tuple[SpatialTileCoordinate, ...],
]:
    if payload.mode == "bbox":
        assert payload.bbox is not None
        assert payload.minimum_tile_matrix is not None
        assert payload.maximum_tile_matrix is not None
        return (
            payload.mode,
            payload.bbox,
            payload.minimum_tile_matrix,
            payload.maximum_tile_matrix,
            _bbox_tile_coordinates(
                payload.bbox, payload.minimum_tile_matrix, payload.maximum_tile_matrix
            ),
        )
    assert payload.tiles is not None
    coordinates = tuple(
        sorted(
            {
                SpatialTileCoordinate(item.tile_matrix, item.tile_row, item.tile_col)
                for item in payload.tiles
            }
        )
    )
    if len(coordinates) != len(payload.tiles):
        raise HTTPException(
            status_code=422,
            detail={"code": "spatial_tile_seed_plan_duplicate_coordinate"},
        )
    for coordinate in coordinates:
        width = 1 << coordinate.tile_matrix
        if coordinate.tile_row >= width or coordinate.tile_col >= width:
            raise HTTPException(
                status_code=422,
                detail={"code": "spatial_tile_seed_plan_coordinate_outside_matrix"},
            )
    zooms = [item.tile_matrix for item in coordinates]
    return payload.mode, None, min(zooms), max(zooms), coordinates


async def _admin_binding(
    repository: SpatialServiceRepository,
    session: AuthSession,
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
) -> SpatialServiceCollection:
    records = await execute_service(
        repository.list_collections(
            tenant_context(session), project_id, service_id, include_withdrawn=True
        )
    )
    record = next((item for item in records if item.binding_id == binding_id), None)
    if record is None:
        raise HTTPException(status_code=404, detail="spatial_service_collection_not_found")
    return record


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache",
    response_model=TileCachePolicyResponse,
)
async def get_tile_cache_policy(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileCachePolicyResponse:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    return _policy_response(
        await execute_service(
            repository.get_tile_cache(tenant_context(session), project_id, binding_id)
        )
    )


@router.put(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache",
    response_model=TileCachePolicyResponse,
)
async def configure_tile_cache_policy(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    payload: ConfigureTileCacheRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileCachePolicyResponse:
    binding = await _admin_binding(repository, session, project_id, service_id, binding_id)
    if binding.withdrawn_at is not None or binding.stale:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
        )
    return _policy_response(
        await execute_service(
            repository.configure_tile_cache(
                tenant_context(session),
                project_id,
                service_id,
                binding_id,
                payload.expected_version,
                payload.minimum_tile_matrix,
                payload.maximum_tile_matrix,
                payload.maximum_entries,
                payload.change_message,
                get_request_id(),
            )
        )
    )


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache/invalidate",
    response_model=TileCachePolicyResponse,
)
async def invalidate_tile_cache_policy(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    payload: InvalidateTileCacheRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileCachePolicyResponse:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    return _policy_response(
        await execute_service(
            repository.invalidate_tile_cache(
                tenant_context(session),
                project_id,
                service_id,
                binding_id,
                payload.expected_version,
                payload.change_message,
                get_request_id(),
            )
        )
    )


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/retired-versions",
    response_model=list[RetiredTileCacheVersionResponse],
)
async def list_retired_tile_cache_versions(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> list[RetiredTileCacheVersionResponse]:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    records = await execute_service(
        repository.list_retired_tile_cache_versions(
            tenant_context(session), project_id, service_id, binding_id
        )
    )
    return [_retired_version_response(record) for record in records]


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/versions/{cache_version_id}/reclamation-preview",
    response_model=TileCacheReclamationPreviewResponse,
)
async def preview_tile_cache_reclamation(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    cache_version_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileCacheReclamationPreviewResponse:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    preview = await execute_service(
        repository.preview_tile_cache_reclamation(
            tenant_context(session),
            project_id,
            service_id,
            binding_id,
            cache_version_id,
        )
    )
    return _reclamation_preview_response(preview)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/versions/{cache_version_id}/reclaim",
    response_model=TileCacheReclamationResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def reclaim_tile_cache_outputs(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    cache_version_id: UUID,
    payload: ConfirmTileCacheReclamationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> TileCacheReclamationResponse:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    submission = await execute_service(
        repository.confirm_tile_cache_reclamation(
            tenant_context(session),
            project_id,
            service_id,
            binding_id,
            cache_version_id,
            payload.preview_checksum_sha256,
            payload.preview_expires_at,
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_tile_cache_reclamation(submission.reclamation.reclamation_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("tile_cache_reclamation.dispatch_unavailable")
            raise HTTPException(
                status_code=503,
                detail="tile_cache_reclamation_dispatch_unavailable",
            ) from error
    return _reclamation_response(submission.reclamation)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/seed-plans/preview",
    response_model=TileSeedPlanPreviewResponse,
)
async def preview_tile_seed_plan(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    payload: TileSeedPlanSelector,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileSeedPlanPreviewResponse:
    binding = await _admin_binding(repository, session, project_id, service_id, binding_id)
    if binding.withdrawn_at is not None or binding.stale:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
        )
    mode, bbox, minimum_zoom, maximum_zoom, coordinates = _seed_plan_selector(payload)
    preview = await execute_service(
        repository.preview_tile_seed_plan(
            tenant_context(session),
            project_id,
            service_id,
            binding_id,
            payload.expected_cache_version,
            mode,
            bbox,
            minimum_zoom,
            maximum_zoom,
            coordinates,
        )
    )
    return _seed_plan_preview_response(preview)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/seed-plans",
    response_model=TileSeedPlanResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def confirm_tile_seed_plan(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    payload: ConfirmTileSeedPlanRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    spatial_repository: Annotated[
        SpatialServiceRepository, Depends(spatial_repository_from_request)
    ],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> TileSeedPlanResponse:
    binding = await _admin_binding(spatial_repository, session, project_id, service_id, binding_id)
    if binding.withdrawn_at is not None or binding.stale:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
        )
    mode, bbox, minimum_zoom, maximum_zoom, coordinates = _seed_plan_selector(payload)
    context = tenant_context(session)
    request_id = get_request_id()
    plan = await execute_service(
        spatial_repository.confirm_tile_seed_plan(
            context,
            project_id,
            service_id,
            binding_id,
            payload.expected_cache_version,
            mode,
            bbox,
            minimum_zoom,
            maximum_zoom,
            coordinates,
            payload.preview_checksum_sha256,
            payload.preview_expires_at,
            request_id,
        )
    )
    if plan.state == "preparing":
        profile = await execute_render(
            render_repository.get_profile(
                context, project_id, binding.resource_id, binding.default_profile_id
            )
        )
        if profile.version_number != binding.sealed_profile_version_number:
            raise HTTPException(
                status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
            )
        for item in plan.items:
            if item.render_job_id is not None:
                continue
            coordinate = item.coordinate
            tile_bbox = web_mercator_tile_bbox(
                coordinate.tile_matrix, coordinate.tile_row, coordinate.tile_col
            )
            render_request = _map_render_request(
                profile,
                ",".join(repr(value) for value in tile_bbox),
                256,
                256,
                "EPSG:3857",
                "png",
                transparent=True,
            )
            submission = await execute_render(
                render_repository.request_render(
                    context,
                    project_id,
                    binding.resource_id,
                    binding.default_profile_id,
                    render_request,
                    request_id,
                )
            )
            if (
                submission.job.profile_version_id != binding.sealed_profile_version_id
                or not _map_job_matches(submission.job, profile, render_request)
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "spatial_tile_cache_render_collision"},
                )
            plan = await execute_service(
                spatial_repository.attach_tile_seed_plan_render(
                    context,
                    project_id,
                    service_id,
                    binding_id,
                    plan.plan_id,
                    item.position,
                    submission.job.job_id,
                )
            )
        plan = await execute_service(
            spatial_repository.begin_tile_seed_plan_dispatch(
                context,
                project_id,
                service_id,
                binding_id,
                plan.plan_id,
                request_id,
            )
        )
    queued_render_ids = tuple(
        item.render_job_id
        for item in plan.items
        if item.state == "queued" and item.render_job_id is not None
    )
    if queued_render_ids:
        try:
            await asyncio.gather(
                *(dispatcher.dispatch_render(job_id) for job_id in queued_render_ids)
            )
        except ProcessingDispatchUnavailable as error:
            logger.error("tile_seed_plan.render_dispatch_unavailable")
            raise HTTPException(status_code=503, detail="render_dispatch_unavailable") from error
    return _seed_plan_response(plan)


@router.get(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/seed-plans",
    response_model=list[TileSeedPlanResponse],
)
async def list_tile_seed_plans(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> list[TileSeedPlanResponse]:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    plans = await execute_service(
        repository.list_tile_seed_plans(tenant_context(session), project_id, service_id, binding_id)
    )
    return [_seed_plan_response(plan) for plan in plans]


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/"
    "tile-cache/seed-plans/{plan_id}/cancel",
    response_model=TileSeedPlanResponse,
)
async def cancel_tile_seed_plan(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    plan_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SpatialServiceRepository, Depends(spatial_repository_from_request)],
) -> TileSeedPlanResponse:
    await _admin_binding(repository, session, project_id, service_id, binding_id)
    plan = await execute_service(
        repository.cancel_tile_seed_plan(
            tenant_context(session),
            project_id,
            service_id,
            binding_id,
            plan_id,
            get_request_id(),
        )
    )
    return _seed_plan_response(plan)


@router.post(
    "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache/seeds",
    response_model=SeedTileResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def seed_tile_cache_entry(
    project_id: UUID,
    service_id: UUID,
    binding_id: UUID,
    payload: SeedTileRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    spatial_repository: Annotated[
        SpatialServiceRepository, Depends(spatial_repository_from_request)
    ],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> SeedTileResponse:
    binding = await _admin_binding(spatial_repository, session, project_id, service_id, binding_id)
    if binding.withdrawn_at is not None or binding.stale:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
        )
    policy = await execute_service(
        spatial_repository.get_tile_cache(tenant_context(session), project_id, binding_id)
    )
    if policy.version_number != payload.expected_cache_version:
        raise HTTPException(status_code=409, detail={"code": "spatial_tile_cache_version_conflict"})
    if not policy.minimum_tile_matrix <= payload.tile_matrix <= policy.maximum_tile_matrix:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_policy_excludes_tile"}
        )
    bbox = web_mercator_tile_bbox(payload.tile_matrix, payload.tile_row, payload.tile_col)
    context = tenant_context(session)
    profile = await execute_render(
        render_repository.get_profile(
            context, project_id, binding.resource_id, binding.default_profile_id
        )
    )
    if profile.version_number != binding.sealed_profile_version_number:
        raise HTTPException(
            status_code=409, detail={"code": "spatial_tile_cache_binding_not_fresh"}
        )
    render_request = _map_render_request(
        profile,
        ",".join(repr(value) for value in bbox),
        256,
        256,
        "EPSG:3857",
        "png",
        transparent=True,
    )
    submission = await execute_render(
        render_repository.request_render(
            context,
            project_id,
            binding.resource_id,
            binding.default_profile_id,
            render_request,
            get_request_id(),
        )
    )
    if (
        submission.job.profile_version_id != binding.sealed_profile_version_id
        or not _map_job_matches(submission.job, profile, render_request)
    ):
        raise HTTPException(status_code=409, detail={"code": "spatial_tile_cache_render_collision"})
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_render(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("tile_cache.render_dispatch_unavailable")
            raise HTTPException(status_code=503, detail="render_dispatch_unavailable") from error
    entry = await execute_service(
        spatial_repository.record_tile_cache_entry(
            context,
            project_id,
            binding_id,
            payload.expected_cache_version,
            payload.tile_matrix,
            payload.tile_row,
            payload.tile_col,
            submission.job.job_id,
            get_request_id(),
        )
    )
    return _seed_response(entry, submission.job.state)


def _seed_response(entry: SpatialTileCacheEntry, render_state: str) -> SeedTileResponse:
    return SeedTileResponse(
        cache_id=entry.cache_id,
        cache_version=entry.cache_version_number,
        tile_matrix=entry.tile_matrix,
        tile_row=entry.tile_row,
        tile_col=entry.tile_col,
        render_job_id=entry.render_job_id,
        render_state=render_state,
        tile_available=render_state == "completed",
    )


def _wmts_error(error: WmtsRequestError) -> Response:
    return Response(
        content=exception_xml(error),
        status_code=error.status_code,
        media_type="application/xml",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/projects/{project_id}/services/{service_slug}/wmts")
async def wmts_kvp(
    project_id: UUID,
    service_slug: str,
    http_request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    spatial_repository: Annotated[
        SpatialServiceRepository, Depends(spatial_repository_from_request)
    ],
    render_repository: Annotated[RenderRepository, Depends(render_repository_from_request)],
) -> Response:
    try:
        operation = parse_wmts_request(list(http_request.query_params.multi_items()))
    except WmtsRequestError as error:
        return _wmts_error(error)
    context = tenant_context(session)
    if not isinstance(operation, WmtsTileRequest):
        service = await execute_service(
            spatial_repository.get_active_service(context, project_id, service_slug)
        )
        bindings = await execute_service(
            spatial_repository.list_collections(
                context, project_id, service.service_id, include_withdrawn=False
            )
        )
        policies = await execute_service(
            spatial_repository.list_tile_caches(context, project_id, service.service_id)
        )
        policies_by_binding = {policy.binding_id: policy for policy in policies}
        layers = tuple(
            WmtsLayer(
                binding.collection_name,
                binding.title,
                policies_by_binding[binding.binding_id].minimum_tile_matrix,
                policies_by_binding[binding.binding_id].maximum_tile_matrix,
            )
            for binding in bindings
            if not binding.stale and binding.binding_id in policies_by_binding
        )
        endpoint = str(http_request.url.replace(query=None))
        return Response(
            content=capabilities_xml(service.title, endpoint, layers),
            media_type="application/xml",
            headers={
                "Cache-Control": "private, no-cache",
                "Vary": "Authorization, X-OpenGeo-Organization",
                "X-Content-Type-Options": "nosniff",
            },
        )
    if operation.style != "default":
        return _wmts_error(
            WmtsRequestError("StyleNotDefined", "STYLE", "only the default style is available")
        )
    if operation.format not in {"image/png", "png"}:
        return _wmts_error(
            WmtsRequestError("InvalidParameterValue", "FORMAT", "FORMAT must be image/png")
        )
    if operation.tile_matrix_set != WEB_MERCATOR_QUAD:
        return _wmts_error(
            WmtsRequestError(
                "InvalidParameterValue",
                "TILEMATRIXSET",
                "only WebMercatorQuad is available",
            )
        )
    try:
        binding = await spatial_repository.resolve_collection(
            context, project_id, service_slug, operation.layer
        )
        if binding.stale:
            raise WmtsRequestError(
                "TileNotAvailable", "LAYER", "the layer seal is stale", status_code=409
            )
        policy = await spatial_repository.get_tile_cache(context, project_id, binding.binding_id)
        if not policy.minimum_tile_matrix <= operation.tile_matrix <= policy.maximum_tile_matrix:
            raise WmtsRequestError(
                "TileOutOfRange", "TILEMATRIX", "the tile matrix is outside policy", 404
            )
        web_mercator_tile_bbox(operation.tile_matrix, operation.tile_row, operation.tile_col)
        entry = await spatial_repository.resolve_tile_cache_entry(
            context,
            project_id,
            binding.binding_id,
            operation.tile_matrix,
            operation.tile_row,
            operation.tile_col,
        )
    except WmtsRequestError as error:
        return _wmts_error(error)
    except SpatialServiceNotFound as error:
        code = (
            "TileNotAvailable"
            if error.resource == "spatial_tile_cache_entry"
            else "LayerNotDefined"
        )
        locator = "TILEMATRIX" if code == "TileNotAvailable" else "LAYER"
        return _wmts_error(WmtsRequestError(code, locator, "cached tile is unavailable", 404))
    except SpatialServiceAccessDenied:
        return _wmts_error(WmtsRequestError("AccessDenied", "LAYER", "action forbidden", 403))
    except SpatialServiceStoreUnavailable:
        return _wmts_error(WmtsRequestError("NoApplicableCode", "LAYER", "store unavailable", 503))
    bbox = web_mercator_tile_bbox(operation.tile_matrix, operation.tile_row, operation.tile_col)
    profile = await execute_render(
        render_repository.get_profile(
            context, project_id, binding.resource_id, binding.default_profile_id
        )
    )
    render_request = _map_render_request(
        profile,
        ",".join(repr(value) for value in bbox),
        256,
        256,
        "EPSG:3857",
        "png",
        transparent=True,
    )
    job = await execute_render(
        render_repository.get_job(context, project_id, binding.resource_id, entry.render_job_id)
    )
    if job.profile_version_id != binding.sealed_profile_version_id or not _map_job_matches(
        job, profile, render_request
    ):
        return _wmts_error(
            WmtsRequestError("TileNotAvailable", "TILEMATRIX", "tile render seal mismatch", 409)
        )
    if job.state in {"queued", "running"}:
        return _wmts_error(
            WmtsRequestError("TileNotAvailable", "TILEMATRIX", "tile render is pending", 503)
        )
    if job.state != "completed":
        return _wmts_error(
            WmtsRequestError("TileNotAvailable", "TILEMATRIX", "tile render failed", 409)
        )
    if (
        job.output_content_type != "image/png"
        or job.output_size_bytes is None
        or not 1 <= job.output_size_bytes <= DIRECT_MAP_MAX_BYTES
        or job.output_checksum_sha256 is None
    ):
        return _wmts_error(
            WmtsRequestError("TileNotAvailable", "TILEMATRIX", "tile output is invalid", 409)
        )
    output = await execute_render(
        render_repository.read_map_output(
            context,
            project_id,
            binding.resource_id,
            job.job_id,
            DIRECT_MAP_MAX_BYTES,
            get_request_id(),
        )
    )
    if (
        output.content_type != job.output_content_type
        or output.size_bytes != job.output_size_bytes
        or output.checksum_sha256 != job.output_checksum_sha256
    ):
        return _wmts_error(
            WmtsRequestError("TileNotAvailable", "TILEMATRIX", "tile output changed", 409)
        )
    return Response(
        content=output.body,
        media_type="image/png",
        headers={
            "Cache-Control": "private, no-cache",
            "Content-Disposition": f'inline; filename="{output.filename}"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "ETag": f'"{output.checksum_sha256}"',
            "Referrer-Policy": "no-referrer",
            "Vary": "Authorization, X-OpenGeo-Organization",
            "X-Content-Type-Options": "nosniff",
            "X-OpenGeo-Cache-Version": str(entry.cache_version_number),
        },
    )
