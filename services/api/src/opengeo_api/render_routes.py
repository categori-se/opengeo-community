import asyncio
import json
import logging
import math
import time
from collections.abc import Awaitable, Sequence
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID, uuid5

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from starlette.responses import RedirectResponse

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import (
    ProcessingDispatchUnavailable,
    RenderDispatcher,
)
from opengeo_api.rendering import (
    MapCollection,
    PostgresRenderRepository,
    PublicWmsService,
    RenderAccessDenied,
    RenderConflict,
    RenderCrs,
    RenderedMapOutput,
    RenderFormat,
    RenderJob,
    RenderLayerSelection,
    RenderNotFound,
    RenderProfile,
    RenderProfileDraft,
    RenderRepository,
    RenderRequest,
    RenderStoreUnavailable,
    WmsLayerPublication,
    render_request_checksum,
)
from opengeo_api.s3_downloads import DownloadStorageUnavailable, DownloadTicket
from opengeo_api.s3_uploads import UploadObjectNotFound, UploadStorageUnavailable
from opengeo_api.saved_map_jobs import SavedMapRenderRequest
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported
from opengeo_api.tenant_database import TenantContext
from opengeo_api.wms import (
    WmsCapabilitiesRequest,
    WmsLayer,
    WmsMapRequest,
    WmsRequestError,
    WmsStyle,
    capabilities_xml,
    exception_xml,
    parse_wms_request,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["governed rendering"])
OGC_CRS84_URI = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
EPSG3857_URI = "http://www.opengis.net/def/crs/EPSG/0/3857"
WEB_MERCATOR_LIMIT = 20_037_508.342789244
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
MapCrsUri = Literal[
    "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
    "http://www.opengis.net/def/crs/EPSG/0/3857",
]
MapMediaType = Literal["image/svg+xml", "image/png"]
MAP_CRS_CODES: dict[MapCrsUri, RenderCrs] = {
    cast(MapCrsUri, OGC_CRS84_URI): "CRS:84",
    cast(MapCrsUri, EPSG3857_URI): "EPSG:3857",
}
MAP_CRS_URIS: dict[RenderCrs, MapCrsUri] = {value: key for key, value in MAP_CRS_CODES.items()}
MAP_MEDIA_TYPES: dict[RenderFormat, MapMediaType] = {
    "svg": "image/svg+xml",
    "png": "image/png",
}
MAP_REQUEST_NAMESPACE = UUID("7d872b2d-279c-5f77-a48f-af79d03a834d")
DIRECT_MAP_MAX_BYTES = 4_194_304
PUBLIC_WMS_USER_ID = UUID("00000000-0000-0000-0000-000000000000")

Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$",
    ),
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
LayerId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
BackgroundColor = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=7,
        max_length=7,
        pattern=r"^#[0-9a-f]{6}$",
    ),
]
WmsPublicationName = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=127,
        pattern=r"^[A-Za-z][A-Za-z0-9._-]{0,62}(?::[A-Za-z][A-Za-z0-9._-]{0,62})?$",
    ),
]
PublicWmsTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateSavedMapRenderRequest(RequestModel):
    idempotency_key: UUID
    expected_resource_version: int = Field(strict=True, ge=1, le=9_007_199_254_740_991)
    expected_map_version: int = Field(strict=True, ge=1, le=9_007_199_254_740_991)
    width: int = Field(strict=True, ge=64, le=2048)
    height: int = Field(strict=True, ge=64, le=2048)
    format: Literal["png"] = "png"

    @model_validator(mode="after")
    def validate_dimensions(self) -> "CreateSavedMapRenderRequest":
        if self.width * self.height > 4_194_304:
            raise ValueError("image exceeds the pixel limit")
        return self


class RenderProfileFields(RequestModel):
    title: Title
    style_id: UUID
    geometry_layer_id: LayerId
    label_layer_id: LayerId | None = None
    minimum_scale_denominator: float | None = Field(default=None, gt=0, le=1_000_000_000)
    maximum_scale_denominator: float | None = Field(default=None, gt=0, le=1_000_000_000)
    include_legend: bool = True
    change_message: ChangeMessage | None = None

    @model_validator(mode="after")
    def validate_profile(self) -> "RenderProfileFields":
        if self.geometry_layer_id == self.label_layer_id:
            raise ValueError("geometry and label layer ids must differ")
        if (
            self.minimum_scale_denominator is not None
            and self.maximum_scale_denominator is not None
            and self.minimum_scale_denominator > self.maximum_scale_denominator
        ):
            raise ValueError("minimum scale denominator cannot exceed maximum")
        values = (self.minimum_scale_denominator, self.maximum_scale_denominator)
        if any(value is not None and not math.isfinite(value) for value in values):
            raise ValueError("scale denominators must be finite")
        return self


class CreateRenderProfileRequest(RenderProfileFields):
    slug: Slug


class UpdateRenderProfileRequest(RenderProfileFields):
    expected_version: int = Field(ge=1)


class CreateWmsPublicationRequest(RequestModel):
    name: WmsPublicationName
    default_profile_id: UUID


class CreatePublicWmsServiceRequest(RequestModel):
    title: PublicWmsTitle


class CreateRenderRequest(RequestModel):
    idempotency_key: UUID
    bbox: tuple[float, float, float, float]
    crs: Literal["CRS:84", "EPSG:3857"] = "CRS:84"
    width: int = Field(ge=1, le=2048)
    height: int = Field(ge=1, le=2048)
    format: Literal["svg", "png"] = "svg"
    background_color: BackgroundColor | None = None
    transparent: bool = False

    @model_validator(mode="after")
    def validate_request(self) -> "CreateRenderRequest":
        if not all(math.isfinite(value) for value in self.bbox):
            raise ValueError("bbox must contain finite coordinates")
        if not _bbox_supported(self.bbox, self.crs):
            raise ValueError(f"bbox must be an ordered extent within {self.crs}")
        if self.width * self.height > 4_194_304:
            raise ValueError("render dimensions exceed the pixel budget")
        return self


class RenderProfileResponse(BaseModel):
    id: UUID
    project_id: UUID
    resource_id: UUID
    slug: str
    version_number: int
    title: str
    resource_version_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    configuration: dict[str, Any]
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime


class RenderJobResponse(BaseModel):
    saved_map_snapshot: dict[str, Any] | None = None
    id: UUID
    project_id: UUID
    resource_id: UUID
    profile_id: UUID
    profile_version_id: UUID
    profile_version_number: int
    dataset_id: UUID
    dataset_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    bbox: tuple[float, float, float, float]
    crs: Literal["CRS:84", "EPSG:3857"]
    width: int
    height: int
    format: Literal["svg", "png"]
    background_color: str | None
    transparent: bool
    request_checksum_sha256: str
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    attempt_count: int
    output_object_id: UUID | None
    output_content_type: str | None
    output_size_bytes: int | None
    output_checksum_sha256: str | None
    error_code: str | None
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class DownloadTicketResponse(BaseModel):
    url: str
    method: str
    expires_at: datetime


class WmsPublicationResponse(BaseModel):
    id: UUID
    project_id: UUID
    resource_id: UUID
    name: str
    default_profile_id: UUID
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None


class PublicWmsServiceResponse(BaseModel):
    id: UUID
    project_id: UUID
    title: str
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


class MapLinkResponse(BaseModel):
    rel: Literal["monitor"]
    href: str
    type: Literal["application/json"] = "application/json"


class MapRequestResponse(BaseModel):
    status: Literal["accepted", "running"]
    media_type: MapMediaType
    crs: MapCrsUri
    job: RenderJobResponse
    links: list[MapLinkResponse]


class OgcLinkResponse(BaseModel):
    href: str
    rel: str
    type: str
    title: str | None = None


class OgcLandingResponse(BaseModel):
    title: str
    description: str
    links: list[OgcLinkResponse]


class OgcConformanceResponse(BaseModel):
    conformsTo: list[str]


class OgcSpatialExtentResponse(BaseModel):
    bbox: list[tuple[float, float, float, float]]
    crs: str = OGC_CRS84_URI


class OgcTemporalExtentResponse(BaseModel):
    interval: list[tuple[datetime | None, datetime | None]]


class OgcExtentResponse(BaseModel):
    spatial: OgcSpatialExtentResponse | None = None
    temporal: OgcTemporalExtentResponse | None = None


class OgcCollectionResponse(BaseModel):
    id: str
    title: str
    description: str | None = None
    attribution: str | None = None
    extent: OgcExtentResponse | None = None
    crs: list[str]
    links: list[OgcLinkResponse]


class OgcCollectionsResponse(BaseModel):
    collections: list[OgcCollectionResponse]
    links: list[OgcLinkResponse]


def repository_from_request(request: Request) -> RenderRepository:
    repository = request.app.state.render_repository
    if not isinstance(repository, PostgresRenderRepository):
        return cast(RenderRepository, repository)
    return repository


def dispatcher_from_request(request: Request) -> RenderDispatcher:
    if request.app.state.settings.worker_processing_mode != "shared" and request.method not in {
        "GET",
        "HEAD",
    }:
        raise HTTPException(status_code=503, detail="shared_worker_processing_held")
    return cast(RenderDispatcher, request.app.state.render_dispatcher)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def public_tenant_context(organization_id: UUID) -> TenantContext:
    return TenantContext(PUBLIC_WMS_USER_ID, organization_id)


async def execute_render[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except RenderAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except RenderNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except SavedMapRenderUnsupported as error:
        raise HTTPException(
            status_code=409,
            detail={
                "code": error.code,
                "message": error.message,
                "layer_id": error.layer_id,
            },
        ) from error
    except RenderConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except UploadObjectNotFound as error:
        raise HTTPException(
            status_code=409, detail={"code": "artifact_upload_object_missing"}
        ) from error
    except UploadStorageUnavailable as error:
        raise HTTPException(status_code=503, detail="artifact_upload_unavailable") from error
    except DownloadStorageUnavailable as error:
        logger.error("render.download_storage_unavailable")
        raise HTTPException(status_code=503, detail="render_download_unavailable") from error
    except RenderStoreUnavailable as error:
        logger.error("render.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="render_store_unavailable") from error


def profile_response(record: RenderProfile) -> RenderProfileResponse:
    return RenderProfileResponse(
        id=record.profile_id,
        project_id=record.project_id,
        resource_id=record.resource_id,
        slug=record.slug,
        version_number=record.version_number,
        title=record.title,
        resource_version_id=record.resource_version_id,
        dataset_id=record.dataset_id,
        dataset_version_id=record.dataset_version_id,
        style_id=record.style_id,
        style_version_id=record.style_version_id,
        configuration=record.configuration,
        checksum_sha256=record.checksum_sha256,
        change_message=record.change_message,
        created_by=record.created_by,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def wms_publication_response(record: WmsLayerPublication) -> WmsPublicationResponse:
    return WmsPublicationResponse(
        id=record.publication_id,
        project_id=record.project_id,
        resource_id=record.resource_id,
        name=record.name,
        default_profile_id=record.default_profile_id,
        created_by=record.created_by,
        created_at=record.created_at,
        withdrawn_by=record.withdrawn_by,
        withdrawn_at=record.withdrawn_at,
    )


def public_wms_service_response(record: PublicWmsService) -> PublicWmsServiceResponse:
    return PublicWmsServiceResponse(
        id=record.service_id,
        project_id=record.project_id,
        title=record.title,
        created_by=record.created_by,
        created_at=record.created_at,
        disabled_by=record.disabled_by,
        disabled_at=record.disabled_at,
    )


def job_response(record: RenderJob) -> RenderJobResponse:
    return RenderJobResponse(
        saved_map_snapshot=record.saved_map_snapshot,
        id=record.job_id,
        project_id=record.project_id,
        resource_id=record.resource_id,
        profile_id=record.profile_id,
        profile_version_id=record.profile_version_id,
        profile_version_number=record.profile_version_number,
        dataset_id=record.dataset_id,
        dataset_version_id=record.dataset_version_id,
        style_id=record.style_id,
        style_version_id=record.style_version_id,
        bbox=record.bbox,
        crs=record.crs,
        width=record.width,
        height=record.height,
        format=record.format,
        background_color=record.background_color,
        transparent=record.transparent,
        request_checksum_sha256=record.request_checksum_sha256,
        state=record.state,
        attempt_count=record.attempt_count,
        output_object_id=record.output_object_id,
        output_content_type=record.output_content_type,
        output_size_bytes=record.output_size_bytes,
        output_checksum_sha256=record.output_checksum_sha256,
        error_code=record.error_code,
        created_by=record.created_by,
        created_at=record.created_at,
        started_at=record.started_at,
        finished_at=record.finished_at,
    )


def profile_draft(payload: RenderProfileFields, slug: str) -> RenderProfileDraft:
    return RenderProfileDraft(
        slug=slug,
        title=payload.title,
        style_id=payload.style_id,
        geometry_layer_id=payload.geometry_layer_id,
        label_layer_id=payload.label_layer_id,
        minimum_scale_denominator=payload.minimum_scale_denominator,
        maximum_scale_denominator=payload.maximum_scale_denominator,
        include_legend=payload.include_legend,
        change_message=payload.change_message,
    )


def _bbox_supported(bbox: tuple[float, float, float, float], crs: RenderCrs) -> bool:
    west, south, east, north = bbox
    if crs == "CRS:84":
        return -180 <= west < east <= 180 and -90 <= south < north <= 90
    return (
        -WEB_MERCATOR_LIMIT <= west < east <= WEB_MERCATOR_LIMIT
        and -WEB_MERCATOR_LIMIT <= south < north <= WEB_MERCATOR_LIMIT
    )


def _wms_bbox_supported(bbox: tuple[float, float, float, float]) -> bool:
    west, south, east, north = bbox
    return west < east and south < north and all(abs(value) <= 1_000_000_000 for value in bbox)


def _longitude_to_web_mercator(value: float) -> float:
    return value * WEB_MERCATOR_LIMIT / 180


def _latitude_to_web_mercator(value: float) -> float:
    bounded = max(-WEB_MERCATOR_LATITUDE_LIMIT, min(WEB_MERCATOR_LATITUDE_LIMIT, value))
    return WEB_MERCATOR_LIMIT * math.log(math.tan((90 + bounded) * math.pi / 360)) / math.pi


def _web_mercator_bbox(
    bbox: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west, south, east, north = bbox
    return (
        _longitude_to_web_mercator(west),
        _latitude_to_web_mercator(south),
        _longitude_to_web_mercator(east),
        _latitude_to_web_mercator(north),
    )


def _map_render_request(
    profile: RenderProfile,
    bbox_text: str,
    width: int,
    height: int,
    crs: RenderCrs,
    output_format: RenderFormat,
    background_color: str | None = None,
    transparent: bool = False,
    *,
    allow_wms_outside_crs: bool = False,
    composition_profiles: Sequence[RenderProfile] = (),
) -> RenderRequest:
    try:
        parts = bbox_text.split(",")
        if len(parts) != 4:
            raise ValueError
        bbox = cast(tuple[float, float, float, float], tuple(float(part) for part in parts))
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_bbox", "message": "bbox must contain four numbers"},
        ) from error
    bbox_supported = _bbox_supported(bbox, crs) or (
        allow_wms_outside_crs and _wms_bbox_supported(bbox)
    )
    if not all(math.isfinite(value) for value in bbox) or not bbox_supported:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_bbox",
                "message": "bbox must be an ordered finite extent allowed by this route",
            },
        )
    if width * height > 4_194_304:
        raise HTTPException(
            status_code=400,
            detail={"code": "pixel_budget_exceeded"},
        )
    canonical_request = json.dumps(
        {
            "bbox": list(bbox),
            "background_color": background_color,
            "crs": crs,
            "format": output_format,
            "height": height,
            "profile_checksum_sha256": profile.checksum_sha256,
            "profile_id": str(profile.profile_id),
            "profile_version": profile.version_number,
            "transparent": transparent,
            "width": width,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    request = RenderRequest(
        idempotency_key=uuid5(MAP_REQUEST_NAMESPACE, canonical_request),
        bbox=bbox,
        crs=crs,
        width=width,
        height=height,
        format=output_format,
        background_color=background_color,
        transparent=transparent,
        expected_profile_version=profile.version_number,
    )
    if composition_profiles:
        request = RenderRequest(
            idempotency_key=uuid5(
                MAP_REQUEST_NAMESPACE,
                render_request_checksum(composition_profiles, request),
            ),
            bbox=request.bbox,
            crs=request.crs,
            width=request.width,
            height=request.height,
            format=request.format,
            background_color=request.background_color,
            transparent=request.transparent,
            expected_profile_version=request.expected_profile_version,
        )
    return request


def _accepts_map_response(header: str, media_type: str) -> bool:
    allowed = {"*/*", "image/*", media_type, "application/*", "application/json"}
    for representation in header.lower().split(","):
        parts = [part.strip() for part in representation.split(";")]
        if not parts or parts[0] not in allowed:
            continue
        quality = 1.0
        for parameter in parts[1:]:
            if parameter.startswith("q="):
                try:
                    quality = float(parameter[2:])
                except ValueError:
                    quality = 0
        if quality > 0:
            return True
    return False


def _accepts_requested_map(http_request: Request, media_type: str) -> bool:
    # WMS negotiates the representation with its mandatory FORMAT parameter.
    # This private scope flag is set only by the WMS adapter after strict KVP
    # validation; ordinary OGC-shaped map requests continue to honor Accept.
    if http_request.scope.get("opengeo.wms_getmap") is True:
        return True
    return _accepts_map_response(http_request.headers.get("accept", "*/*"), media_type)


def _map_job_matches(
    job: RenderJob,
    profile: RenderProfile,
    request: RenderRequest,
    composition_profiles: Sequence[RenderProfile] = (),
) -> bool:
    profiles = composition_profiles or (profile,)
    return (
        job.profile_id == profile.profile_id
        and job.profile_version_number == profile.version_number
        and job.bbox == request.bbox
        and job.crs == request.crs
        and job.width == request.width
        and job.height == request.height
        and job.format == request.format
        and job.background_color == request.background_color
        and job.transparent == request.transparent
        and (
            not composition_profiles
            or job.request_checksum_sha256 == render_request_checksum(profiles, request)
        )
    )


async def _wait_for_wms_map_job(
    repository: RenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    current_job: RenderJob,
    wait_seconds: float,
    poll_seconds: float,
    *,
    composition: bool = False,
) -> RenderJob:
    deadline = time.monotonic() + wait_seconds
    delay_seconds = poll_seconds
    while current_job.state in {"queued", "running"}:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            read = (
                repository.get_composite_job(context, project_id, current_job.job_id)
                if composition
                else repository.get_job(context, project_id, resource_id, current_job.job_id)
            )
            current_job = await asyncio.wait_for(execute_render(read), timeout=remaining)
        except TimeoutError:
            break
        if current_job.state not in {"queued", "running"}:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        # Keep the first refresh immediate, then reduce repeated Data API/secret
        # reads while a worker is pending. Recheck authority on every refresh;
        # the one-second cap and original deadline bound detection latency.
        await asyncio.sleep(min(delay_seconds, remaining))
        delay_seconds = min(delay_seconds * 2, 1.0)
    return current_job


async def _wait_for_public_wms_map_job(
    repository: RenderRepository,
    context: TenantContext,
    project_id: UUID,
    service_id: UUID,
    resource_ids: tuple[UUID, ...],
    idempotency_key: UUID,
    current_job: RenderJob,
    wait_seconds: float,
    poll_seconds: float,
) -> RenderJob:
    deadline = time.monotonic() + wait_seconds
    delay_seconds = poll_seconds
    while current_job.state in {"queued", "running"}:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            read = (
                repository.find_public_composite_job_by_idempotency(
                    context,
                    project_id,
                    service_id,
                    resource_ids,
                    idempotency_key,
                )
                if len(resource_ids) > 1
                else repository.find_public_job_by_idempotency(
                    context,
                    project_id,
                    service_id,
                    resource_ids[0],
                    idempotency_key,
                )
            )
            refreshed = await asyncio.wait_for(execute_render(read), timeout=remaining)
        except TimeoutError:
            break
        if refreshed is None:
            break
        current_job = refreshed
        if current_job.state not in {"queued", "running"}:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        await asyncio.sleep(min(delay_seconds, remaining))
        delay_seconds = min(delay_seconds * 2, 1.0)
    return current_job


def _map_bbox_header(bbox: tuple[float, float, float, float]) -> str:
    return ",".join(format(value, ".15g") for value in bbox)


def _ogc_base(project_id: UUID, resource_id: UUID) -> str:
    return f"/projects/{project_id}/resources/{resource_id}/ogc"


def _ogc_collection_response(
    record: MapCollection, profiles: list[RenderProfile], project_id: UUID
) -> OgcCollectionResponse:
    base = _ogc_base(project_id, record.resource_id)
    collection_href = f"{base}/collections/{record.resource_id}"
    spatial = (
        None
        if record.spatial_extent is None
        else OgcSpatialExtentResponse(bbox=[record.spatial_extent])
    )
    temporal = (
        None
        if record.temporal_start is None and record.temporal_end is None
        else OgcTemporalExtentResponse(interval=[(record.temporal_start, record.temporal_end)])
    )
    extent = (
        None
        if spatial is None and temporal is None
        else OgcExtentResponse(spatial=spatial, temporal=temporal)
    )
    links = [
        OgcLinkResponse(
            href=collection_href,
            rel="self",
            type="application/json",
            title=record.title,
        )
    ]
    links.extend(
        OgcLinkResponse(
            href=(
                f"{collection_href}/styles/{profile.profile_id}/map"
                + ("" if output_format == "svg" else "?f=png")
            ),
            rel="https://www.opengis.net/def/rel/ogc/1.0/map",
            type=media_type,
            title=f"{profile.title} ({output_format.upper()})",
        )
        for profile in profiles
        for output_format, media_type in MAP_MEDIA_TYPES.items()
    )
    return OgcCollectionResponse(
        id=str(record.resource_id),
        title=record.title,
        description=record.description,
        attribution=record.attribution,
        extent=extent,
        crs=[OGC_CRS84_URI, EPSG3857_URI],
        links=links,
    )


def _wms_xml_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "Vary": "Accept",
        "X-Content-Type-Options": "nosniff",
    }


def _wms_exception_response(
    code: str,
    locator: str,
    message: str,
    status_code: int,
    extra_headers: dict[str, str] | None = None,
) -> Response:
    return Response(
        content=exception_xml(code, locator, message),
        status_code=status_code,
        media_type="text/xml",
        headers={**_wms_xml_headers(), **(extra_headers or {})},
    )


def _wms_http_exception(error: HTTPException) -> Response:
    detail = cast(Any, error.detail)
    detail_code = detail.get("code") if isinstance(detail, dict) else None
    if error.status_code == 400 and detail_code == "unsupported_crs":
        return _wms_exception_response(
            "InvalidCRS", "CRS", "The requested coordinate reference system is unsupported.", 400
        )
    if error.status_code == 400:
        return _wms_exception_response(
            "InvalidParameterValue", "QUERY", "The WMS map request is invalid.", 400
        )
    if error.status_code == 403:
        return _wms_exception_response(
            "AccessDenied", "", "The current principal cannot access this map.", 403
        )
    if error.status_code == 404:
        return _wms_exception_response(
            "LayerNotDefined", "LAYERS", "The requested layer is not available.", 404
        )
    if error.status_code == 406:
        return _wms_exception_response(
            "InvalidFormat", "FORMAT", "The requested map format is unsupported.", 406
        )
    if error.status_code == 503:
        return _wms_exception_response(
            "ServerBusy", "REQUEST", "The map service is temporarily unavailable.", 503
        )
    return _wms_exception_response(
        "NoApplicableCode", "REQUEST", "The map request could not be completed.", error.status_code
    )


def _no_map_composition() -> None:
    return None


@router.get(
    "/projects/{project_id}/resources/{resource_id}/ogc",
    response_model=OgcLandingResponse,
    summary="Discover the governed map API for one resource",
)
async def get_ogc_landing(
    project_id: UUID,
    resource_id: UUID,
    http_request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> OgcLandingResponse:
    record = await execute_render(
        repository.get_map_collection(tenant_context(session), project_id, resource_id)
    )
    base = _ogc_base(project_id, resource_id)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Accept"
    links = [
        OgcLinkResponse(
            href=base,
            rel="self",
            type="application/json",
            title="Map API landing page",
        )
    ]
    if http_request.app.state.settings.expose_docs:
        links.append(
            OgcLinkResponse(
                href="/openapi.json",
                rel="service-desc",
                type="application/json",
                title="OpenAPI definition",
            )
        )
    links.extend(
        [
            OgcLinkResponse(
                href=f"{base}/conformance",
                rel="conformance",
                type="application/json",
                title="Conformance declaration",
            ),
            OgcLinkResponse(
                href=f"{base}/collections",
                rel="data",
                type="application/json",
                title="Map collections",
            ),
        ]
    )
    return OgcLandingResponse(
        title=f"{record.title} maps",
        description=(
            "Authenticated discovery for governed SVG and PNG maps. Formal OGC conformance "
            "is not claimed while an uncached render uses asynchronous 202 processing."
        ),
        links=links,
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/ogc/conformance",
    response_model=OgcConformanceResponse,
    summary="Report currently claimed OGC conformance classes",
)
async def get_ogc_conformance(
    project_id: UUID,
    resource_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> OgcConformanceResponse:
    await execute_render(
        repository.get_map_collection(tenant_context(session), project_id, resource_id)
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Accept"
    return OgcConformanceResponse(conformsTo=[])


@router.get(
    "/projects/{project_id}/resources/{resource_id}/ogc/collections",
    response_model=OgcCollectionsResponse,
    response_model_exclude_none=True,
    summary="List the resource-scoped map collection",
)
async def list_ogc_collections(
    project_id: UUID,
    resource_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> OgcCollectionsResponse:
    context = tenant_context(session)
    record = await execute_render(repository.get_map_collection(context, project_id, resource_id))
    profiles = await execute_render(repository.list_profiles(context, project_id, resource_id))
    base = _ogc_base(project_id, resource_id)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Accept"
    return OgcCollectionsResponse(
        collections=[_ogc_collection_response(record, profiles, project_id)],
        links=[
            OgcLinkResponse(
                href=f"{base}/collections",
                rel="self",
                type="application/json",
                title="Map collections",
            )
        ],
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/ogc/collections/{collection_id}",
    response_model=OgcCollectionResponse,
    response_model_exclude_none=True,
    summary="Describe one governed map collection",
)
async def get_ogc_collection(
    project_id: UUID,
    resource_id: UUID,
    collection_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> OgcCollectionResponse:
    if collection_id != resource_id:
        raise HTTPException(status_code=404, detail="map_collection_not_found")
    context = tenant_context(session)
    record = await execute_render(repository.get_map_collection(context, project_id, resource_id))
    profiles = await execute_render(repository.list_profiles(context, project_id, resource_id))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Vary"] = "Accept"
    return _ogc_collection_response(record, profiles, project_id)


@router.get(
    "/projects/{project_id}/wms-publications",
    response_model=list[WmsPublicationResponse],
    summary="List governed WMS publication history for a project",
)
async def list_wms_publications(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> list[WmsPublicationResponse]:
    records = await execute_render(
        repository.list_wms_publications(tenant_context(session), project_id)
    )
    return [wms_publication_response(record) for record in records]


@router.post(
    "/projects/{project_id}/resources/{resource_id}/wms-publications",
    response_model=WmsPublicationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Publish one governed resource under a stable WMS layer name",
)
async def create_wms_publication(
    project_id: UUID,
    resource_id: UUID,
    payload: CreateWmsPublicationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> WmsPublicationResponse:
    record = await execute_render(
        repository.create_wms_publication(
            tenant_context(session),
            project_id,
            resource_id,
            payload.name,
            payload.default_profile_id,
            get_request_id(),
        )
    )
    return wms_publication_response(record)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/wms-publications/{publication_id}/withdraw",
    response_model=WmsPublicationResponse,
    summary="Irreversibly withdraw one governed WMS layer publication",
)
async def withdraw_wms_publication(
    project_id: UUID,
    resource_id: UUID,
    publication_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> WmsPublicationResponse:
    record = await execute_render(
        repository.withdraw_wms_publication(
            tenant_context(session),
            project_id,
            resource_id,
            publication_id,
            get_request_id(),
        )
    )
    return wms_publication_response(record)


@router.get(
    "/projects/{project_id}/public-wms-services",
    response_model=list[PublicWmsServiceResponse],
    summary="List governed public WMS service history for a project",
)
async def list_public_wms_services(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> list[PublicWmsServiceResponse]:
    records = await execute_render(
        repository.list_public_wms_services(tenant_context(session), project_id)
    )
    return [public_wms_service_response(record) for record in records]


@router.post(
    "/projects/{project_id}/public-wms-services",
    response_model=PublicWmsServiceResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an opaque read-only public WMS service boundary",
)
async def create_public_wms_service(
    project_id: UUID,
    payload: CreatePublicWmsServiceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> PublicWmsServiceResponse:
    record = await execute_render(
        repository.create_public_wms_service(
            tenant_context(session), project_id, payload.title, get_request_id()
        )
    )
    return public_wms_service_response(record)


@router.post(
    "/projects/{project_id}/public-wms-services/{service_id}/disable",
    response_model=PublicWmsServiceResponse,
    summary="Irreversibly disable one public WMS service boundary",
)
async def disable_public_wms_service(
    project_id: UUID,
    service_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> PublicWmsServiceResponse:
    record = await execute_render(
        repository.disable_public_wms_service(
            tenant_context(session), project_id, service_id, get_request_id()
        )
    )
    return public_wms_service_response(record)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/render-profiles",
    response_model=list[RenderProfileResponse],
)
async def list_profiles(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> list[RenderProfileResponse]:
    records = await execute_render(
        repository.list_profiles(tenant_context(session), project_id, resource_id)
    )
    return [profile_response(record) for record in records]


@router.post(
    "/projects/{project_id}/resources/{resource_id}/render-profiles",
    response_model=RenderProfileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_profile(
    project_id: UUID,
    resource_id: UUID,
    payload: CreateRenderProfileRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> RenderProfileResponse:
    record = await execute_render(
        repository.create_profile(
            tenant_context(session),
            project_id,
            resource_id,
            profile_draft(payload, payload.slug),
            get_request_id(),
        )
    )
    return profile_response(record)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}",
    response_model=RenderProfileResponse,
)
async def get_profile(
    project_id: UUID,
    resource_id: UUID,
    profile_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> RenderProfileResponse:
    return profile_response(
        await execute_render(
            repository.get_profile(tenant_context(session), project_id, resource_id, profile_id)
        )
    )


@router.put(
    "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}",
    response_model=RenderProfileResponse,
)
async def update_profile(
    project_id: UUID,
    resource_id: UUID,
    profile_id: UUID,
    payload: UpdateRenderProfileRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> RenderProfileResponse:
    current = await execute_render(
        repository.get_profile(tenant_context(session), project_id, resource_id, profile_id)
    )
    record = await execute_render(
        repository.update_profile(
            tenant_context(session),
            project_id,
            resource_id,
            profile_id,
            payload.expected_version,
            profile_draft(payload, current.slug),
            get_request_id(),
        )
    )
    return profile_response(record)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}/map",
    response_model=MapRequestResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Negotiate an exact governed SVG or PNG map",
    description=(
        "An authenticated, OGC API Maps-shaped first increment. The endpoint accepts "
        "CRS84 or EPSG:3857 bbox, width, height, and SVG or PNG format parameters, "
        "reuses an exact existing "
        "render when present, queues bounded activation-only work when authorized, and "
        "returns bounded completed output directly after an exact-version read and a second "
        "authorization check. Larger output redirects to an exact signed object version. It "
        "is not yet an OGC API Maps conformance claim because an uncached request returns 202."
    ),
    responses={
        200: {"description": "The exact completed map body."},
        303: {"description": "The exact completed map is available at the signed Location."},
        400: {"description": "The bbox or CRS is invalid or unsupported."},
        406: {"description": "The requested representation is unsupported."},
        409: {"description": "The deterministic render failed, was cancelled, or collided."},
    },
)
async def get_map(
    project_id: UUID,
    resource_id: UUID,
    profile_id: UUID,
    bbox: Annotated[str, Query(min_length=7, max_length=200)],
    http_request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
    composition_profiles: Annotated[tuple[RenderProfile, ...] | None, Depends(_no_map_composition)],
    width: Annotated[int, Query(ge=1, le=2048)] = 640,
    height: Annotated[int, Query(ge=1, le=2048)] = 480,
    crs: Annotated[str, Query(min_length=1, max_length=100)] = OGC_CRS84_URI,
    output_format: Annotated[str, Query(alias="f", min_length=1, max_length=20)] = "svg",
    background_color: Annotated[BackgroundColor | None, Query()] = None,
    transparent: Annotated[bool, Query()] = False,
    expected_profile_version: Annotated[int | None, Query(ge=1)] = None,
) -> MapRequestResponse | RedirectResponse | Response:
    if output_format not in MAP_MEDIA_TYPES:
        raise HTTPException(status_code=406, detail={"code": "map_representation_unsupported"})
    render_format = output_format
    media_type = MAP_MEDIA_TYPES[render_format]
    if not _accepts_requested_map(http_request, media_type):
        raise HTTPException(status_code=406, detail={"code": "map_representation_unsupported"})
    if crs not in MAP_CRS_CODES:
        raise HTTPException(
            status_code=400,
            detail={"code": "unsupported_crs", "supported": list(MAP_CRS_CODES)},
        )
    render_crs = MAP_CRS_CODES[crs]
    context = tenant_context(session)
    if composition_profiles is None:
        profile = await execute_render(
            repository.get_profile(context, project_id, resource_id, profile_id)
        )
        profiles: tuple[RenderProfile, ...] = ()
    else:
        if (
            not 2 <= len(composition_profiles) <= 16
            or composition_profiles[0].resource_id != resource_id
            or composition_profiles[0].profile_id != profile_id
        ):
            raise HTTPException(status_code=409, detail={"code": "map_composition_invalid"})
        profile = composition_profiles[0]
        profiles = composition_profiles
    if expected_profile_version is not None and profile.version_number != expected_profile_version:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "map_profile_version_conflict",
                "expected_version": expected_profile_version,
                "current_version": profile.version_number,
            },
        )
    render_request = _map_render_request(
        profile,
        bbox,
        width,
        height,
        render_crs,
        render_format,
        background_color,
        transparent,
        allow_wms_outside_crs=http_request.scope.get("opengeo.wms_getmap") is True,
        composition_profiles=profiles,
    )
    existing_read = (
        repository.find_composite_job_by_idempotency(
            context, project_id, render_request.idempotency_key
        )
        if profiles
        else repository.find_job_by_idempotency(
            context,
            project_id,
            resource_id,
            render_request.idempotency_key,
        )
    )
    existing = await execute_render(existing_read)
    shared_worker_available = http_request.app.state.settings.worker_processing_mode == "shared"
    if existing is None:
        if not shared_worker_available:
            raise HTTPException(status_code=503, detail="shared_worker_processing_held")
        submit = (
            repository.request_composite_render(
                context,
                project_id,
                tuple(
                    RenderLayerSelection(item.resource_id, item.profile_id, item.version_number)
                    for item in profiles
                ),
                render_request,
                get_request_id(),
            )
            if profiles
            else repository.request_render(
                context,
                project_id,
                resource_id,
                profile_id,
                render_request,
                get_request_id(),
            )
        )
        submission = await execute_render(submit)
        current_job = submission.job
    elif existing.state == "queued" and shared_worker_available:
        try:
            resubmit = (
                repository.request_composite_render(
                    context,
                    project_id,
                    tuple(
                        RenderLayerSelection(item.resource_id, item.profile_id, item.version_number)
                        for item in profiles
                    ),
                    render_request,
                    get_request_id(),
                )
                if profiles
                else repository.request_render(
                    context,
                    project_id,
                    resource_id,
                    profile_id,
                    render_request,
                    get_request_id(),
                )
            )
            submission = await execute_render(resubmit)
            current_job = submission.job
        except HTTPException as error:
            if error.status_code != 403:
                raise
            submission = None
            current_job = existing
    else:
        submission = None
        current_job = existing

    if submission is not None and submission.dispatch_required:
        try:
            await dispatcher.dispatch_render(current_job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("render.dispatch_unavailable")
            raise HTTPException(status_code=503, detail="render_dispatch_unavailable") from error

    if not _map_job_matches(current_job, profile, render_request, profiles):
        raise HTTPException(status_code=409, detail={"code": "map_request_collision"})

    if http_request.scope.get("opengeo.wms_getmap") is True and current_job.state in {
        "queued",
        "running",
    }:
        settings = http_request.app.state.settings
        current_job = await _wait_for_wms_map_job(
            repository,
            context,
            project_id,
            resource_id,
            current_job,
            settings.wms_sync_wait_seconds,
            settings.wms_sync_poll_seconds,
            composition=bool(profiles),
        )
        if not _map_job_matches(current_job, profile, render_request, profiles):
            raise HTTPException(status_code=409, detail={"code": "map_request_collision"})

    monitor_href = f"/projects/{project_id}/resources/{resource_id}/renders/{current_job.job_id}"
    if current_job.state == "completed":
        if (
            current_job.output_content_type == media_type
            and current_job.output_size_bytes is not None
            and 1 <= current_job.output_size_bytes <= DIRECT_MAP_MAX_BYTES
            and current_job.output_checksum_sha256 is not None
        ):
            output_read = (
                repository.read_composite_map_output(
                    context,
                    project_id,
                    current_job.job_id,
                    DIRECT_MAP_MAX_BYTES,
                    get_request_id(),
                )
                if profiles
                else repository.read_map_output(
                    context,
                    project_id,
                    resource_id,
                    current_job.job_id,
                    DIRECT_MAP_MAX_BYTES,
                    get_request_id(),
                )
            )
            output: RenderedMapOutput = await execute_render(output_read)
            if (
                output.content_type != current_job.output_content_type
                or output.size_bytes != current_job.output_size_bytes
                or output.checksum_sha256 != current_job.output_checksum_sha256
            ):
                raise HTTPException(status_code=409, detail={"code": "map_output_changed"})
            return Response(
                content=output.body,
                status_code=status.HTTP_200_OK,
                media_type=output.content_type,
                headers={
                    "Cache-Control": "no-store",
                    "Content-Bbox": _map_bbox_header(current_job.bbox),
                    "Content-Crs": f"<{MAP_CRS_URIS[current_job.crs]}>",
                    "Content-Disposition": f'inline; filename="{output.filename}"',
                    "Content-Security-Policy": "default-src 'none'; sandbox",
                    "ETag": f'"{output.checksum_sha256}"',
                    "Referrer-Policy": "no-referrer",
                    "Vary": "Accept",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        ticket_read = (
            repository.request_composite_download(
                context,
                project_id,
                current_job.job_id,
                get_request_id(),
            )
            if profiles
            else repository.request_download(
                context,
                project_id,
                resource_id,
                current_job.job_id,
                get_request_id(),
            )
        )
        ticket = await execute_render(ticket_read)
        if ticket.method != "GET":
            raise HTTPException(status_code=409, detail={"code": "map_output_unavailable"})
        return RedirectResponse(
            ticket.url,
            status_code=status.HTTP_303_SEE_OTHER,
            headers={
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Vary": "Accept",
            },
        )
    if current_job.state in {"failed", "cancelled"}:
        raise HTTPException(
            status_code=409,
            detail={
                "code": f"map_render_{current_job.state}",
                "job_id": str(current_job.job_id),
            },
        )

    response.headers["Cache-Control"] = "no-store"
    response.headers["Location"] = monitor_href
    response.headers["Link"] = f'<{monitor_href}>; rel="monitor"; type="application/json"'
    response.headers["Retry-After"] = "5"
    response.headers["Vary"] = "Accept"
    return MapRequestResponse(
        status="accepted" if current_job.state == "queued" else "running",
        media_type=media_type,
        crs=MAP_CRS_URIS[render_crs],
        job=job_response(current_job),
        links=[MapLinkResponse(rel="monitor", href=monitor_href)],
    )


@router.get(
    (
        "/projects/{project_id}/resources/{resource_id}/ogc/collections/{collection_id}"
        "/styles/{profile_id}/map"
    ),
    response_model=MapRequestResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Retrieve a styled map through resource-scoped OGC discovery",
    description=(
        "Returns 200 for a bounded exact cached SVG or PNG, 202 plus a monitor link for "
        "activation-only rendering, or 303 for an exact completed output above the direct "
        "response boundary."
    ),
    responses={
        200: {"description": "The exact completed map body."},
        303: {"description": "The exact completed map is available at the signed Location."},
    },
)
async def get_ogc_collection_map(
    project_id: UUID,
    resource_id: UUID,
    collection_id: UUID,
    profile_id: UUID,
    http_request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
    bbox: Annotated[str | None, Query(min_length=7, max_length=200)] = None,
    width: Annotated[int, Query(ge=1, le=2048)] = 640,
    height: Annotated[int, Query(ge=1, le=2048)] = 480,
    crs: Annotated[str, Query(min_length=1, max_length=100)] = OGC_CRS84_URI,
    output_format: Annotated[str, Query(alias="f", min_length=1, max_length=20)] = "svg",
    background_color: Annotated[BackgroundColor | None, Query()] = None,
    transparent: Annotated[bool, Query()] = False,
) -> MapRequestResponse | RedirectResponse | Response:
    if collection_id != resource_id:
        raise HTTPException(status_code=404, detail="map_collection_not_found")
    collection = await execute_render(
        repository.get_map_collection(tenant_context(session), project_id, resource_id)
    )
    default_bbox = collection.spatial_extent or (-180.0, -90.0, 180.0, 90.0)
    if crs == EPSG3857_URI:
        default_bbox = _web_mercator_bbox(default_bbox)
    bbox_text = _map_bbox_header(default_bbox)
    return await get_map(
        project_id=project_id,
        resource_id=resource_id,
        profile_id=profile_id,
        bbox=bbox or bbox_text,
        http_request=http_request,
        response=response,
        session=session,
        repository=repository,
        dispatcher=dispatcher,
        composition_profiles=None,
        width=width,
        height=height,
        crs=crs,
        output_format=output_format,
        background_color=background_color,
        transparent=transparent,
    )


@router.get(
    "/public/organizations/{organization_id}/projects/{project_id}/wms/{service_id}",
    response_class=Response,
    summary="Read a governed public WMS 1.3.0/1.1.1 service without authentication",
    description=(
        "Advertises only active exact-name publications of published resources whose governed "
        "visibility is public. GetMap accepts one to sixteen ordered advertised layer/style "
        "occurrences, including standards-defined repeats, and "
        "is deliberately cache-only: an anonymous request can read an exact immutable output that "
        "an authenticated operator prewarmed, but can never create, "
        "resubmit, or dispatch paid rendering work. Cache misses return a retryable ServerBusy "
        "service exception. The opaque service id can be disabled irreversibly through the "
        "authenticated management API."
    ),
    responses={
        200: {"description": "Public WMS capabilities XML or an exact governed map."},
        303: {"description": "A larger exact map is available at its signed object version."},
        400: {"description": "A WMS XML service exception."},
        404: {"description": "The public service or requested layer is unavailable."},
        503: {"description": "The exact request was not prewarmed or is still rendering."},
    },
)
async def public_project_wms_service(
    organization_id: UUID,
    project_id: UUID,
    service_id: UUID,
    http_request: Request,
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> Response:
    try:
        wms_request = parse_wms_request(http_request.query_params.multi_items(), layer_limit=16)
    except (ValueError, WmsRequestError) as error:
        if isinstance(error, WmsRequestError):
            return _wms_exception_response(
                error.code, error.locator, error.message, error.status_code
            )
        return _wms_exception_response(
            "NoApplicableCode", "REQUEST", "The WMS request is invalid.", 400
        )

    context = public_tenant_context(organization_id)
    try:
        catalog = await execute_render(
            repository.get_public_project_map_catalog(context, project_id, service_id)
        )
    except HTTPException as error:
        return _wms_http_exception(error)
    if not catalog.layers:
        return _wms_exception_response(
            "LayerNotDefined", "LAYERS", "No public map layer is available.", 404
        )

    if isinstance(wms_request, WmsCapabilitiesRequest):
        advertised = tuple(
            WmsLayer(
                name=layer.publication.name,
                title=layer.collection.title,
                abstract=layer.collection.description,
                attribution=layer.collection.attribution,
                bbox=layer.collection.spatial_extent or (-180.0, -90.0, 180.0, 90.0),
                styles=tuple(
                    WmsStyle(str(profile.profile_id), profile.title) for profile in layer.profiles
                ),
            )
            for layer in catalog.layers
        )
        endpoint = str(http_request.url).split("?", 1)[0]
        try:
            document = capabilities_xml(
                advertised,
                endpoint,
                service_title=catalog.title,
                layer_limit=16,
                version=wms_request.version,
            )
        except ValueError:
            logger.error("wms.public_endpoint_invalid")
            return _wms_exception_response(
                "NoApplicableCode", "REQUEST", "The map service endpoint is invalid.", 503
            )
        return Response(
            content=document,
            status_code=status.HTTP_200_OK,
            media_type="text/xml",
            headers=_wms_xml_headers(),
        )

    assert isinstance(wms_request, WmsMapRequest)
    catalog_by_name = {layer.publication.name: layer for layer in catalog.layers}
    selected_profiles: list[RenderProfile] = []
    for layer_id, style_id in wms_request.layers:
        layer = catalog_by_name.get(layer_id)
        if layer is None:
            return _wms_exception_response(
                "LayerNotDefined", "LAYERS", "A requested layer is not advertised.", 404
            )
        selected = (
            layer.profiles[0]
            if style_id is None
            else next((item for item in layer.profiles if item.profile_id == style_id), None)
        )
        if selected is None:
            return _wms_exception_response(
                "StyleNotDefined", "STYLES", "A requested style is not advertised.", 404
            )
        selected_profiles.append(selected)
    profiles = tuple(selected_profiles)
    profile = profiles[0]
    resource_ids = tuple(item.resource_id for item in profiles)
    composition_profiles: tuple[RenderProfile, ...] = profiles if len(profiles) > 1 else ()

    try:
        render_request = _map_render_request(
            profile,
            _map_bbox_header(wms_request.bbox),
            wms_request.width,
            wms_request.height,
            wms_request.crs,
            wms_request.format,
            wms_request.background_color,
            wms_request.transparent,
            allow_wms_outside_crs=True,
            composition_profiles=composition_profiles,
        )
        job_read = (
            repository.find_public_composite_job_by_idempotency(
                context,
                project_id,
                service_id,
                resource_ids,
                render_request.idempotency_key,
            )
            if composition_profiles
            else repository.find_public_job_by_idempotency(
                context,
                project_id,
                service_id,
                resource_ids[0],
                render_request.idempotency_key,
            )
        )
        current_job = await execute_render(job_read)
    except HTTPException as error:
        return _wms_http_exception(error)
    if current_job is None:
        return _wms_exception_response(
            "ServerBusy",
            "REQUEST",
            "The exact public map is not prewarmed; an authenticated operator must render it.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"Retry-After": "5"},
        )
    if not _map_job_matches(current_job, profile, render_request, composition_profiles):
        return _wms_exception_response(
            "NoApplicableCode", "REQUEST", "The cached map request does not match.", 409
        )

    if current_job.state in {"queued", "running"}:
        settings = http_request.app.state.settings
        try:
            current_job = await _wait_for_public_wms_map_job(
                repository,
                context,
                project_id,
                service_id,
                resource_ids,
                render_request.idempotency_key,
                current_job,
                settings.wms_sync_wait_seconds,
                settings.wms_sync_poll_seconds,
            )
        except HTTPException as error:
            return _wms_http_exception(error)
        if not _map_job_matches(current_job, profile, render_request, composition_profiles):
            return _wms_exception_response(
                "NoApplicableCode", "REQUEST", "The cached map request does not match.", 409
            )

    if current_job.state in {"queued", "running"}:
        return _wms_exception_response(
            "ServerBusy",
            "REQUEST",
            "The exact public map is still rendering; retry the same request.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"Retry-After": "5"},
        )
    if current_job.state in {"failed", "cancelled"}:
        return _wms_exception_response(
            "NoApplicableCode", "REQUEST", "The cached map could not be completed.", 409
        )

    media_type = MAP_MEDIA_TYPES[render_request.format]
    if (
        current_job.output_content_type == media_type
        and current_job.output_size_bytes is not None
        and 1 <= current_job.output_size_bytes <= DIRECT_MAP_MAX_BYTES
        and current_job.output_checksum_sha256 is not None
    ):
        try:
            output_read = (
                repository.read_public_composite_map_output(
                    context,
                    project_id,
                    service_id,
                    resource_ids,
                    current_job.job_id,
                    DIRECT_MAP_MAX_BYTES,
                )
                if composition_profiles
                else repository.read_public_map_output(
                    context,
                    project_id,
                    service_id,
                    resource_ids[0],
                    current_job.job_id,
                    DIRECT_MAP_MAX_BYTES,
                )
            )
            output = await execute_render(output_read)
        except HTTPException as error:
            return _wms_http_exception(error)
        if (
            output.content_type != current_job.output_content_type
            or output.size_bytes != current_job.output_size_bytes
            or output.checksum_sha256 != current_job.output_checksum_sha256
        ):
            return _wms_exception_response(
                "NoApplicableCode", "REQUEST", "The cached map output changed.", 409
            )
        return Response(
            content=output.body,
            status_code=status.HTTP_200_OK,
            media_type=output.content_type,
            headers={
                "Cache-Control": "no-store",
                "Content-Bbox": _map_bbox_header(current_job.bbox),
                "Content-Crs": f"<{MAP_CRS_URIS[current_job.crs]}>",
                "Content-Disposition": f'inline; filename="{output.filename}"',
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "ETag": f'"{output.checksum_sha256}"',
                "Referrer-Policy": "no-referrer",
                "Vary": "Accept",
                "X-Content-Type-Options": "nosniff",
            },
        )

    try:
        download_read = (
            repository.request_public_composite_download(
                context,
                project_id,
                service_id,
                resource_ids,
                current_job.job_id,
            )
            if composition_profiles
            else repository.request_public_download(
                context,
                project_id,
                service_id,
                resource_ids[0],
                current_job.job_id,
            )
        )
        ticket = await execute_render(download_read)
    except HTTPException as error:
        return _wms_http_exception(error)
    if ticket.method != "GET":
        return _wms_exception_response(
            "NoApplicableCode", "REQUEST", "The cached map output is unavailable.", 409
        )
    return RedirectResponse(
        ticket.url,
        status_code=status.HTTP_303_SEE_OTHER,
        headers={
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Vary": "Accept",
        },
    )


@router.get(
    "/projects/{project_id}/wms",
    response_class=Response,
    summary="Use the project-scoped WMS 1.3.0/1.1.1 catalog and composition facade",
    description=(
        "Advertises active exact-name publications for governed project map layers and accepts "
        "ordered one-to-sixteen-layer CRS:84/EPSG:3857 SVG/PNG GetMap requests. Publication "
        "discovery requires project membership; multi-layer requests snapshot every exact "
        "profile version into one immutable activation-only job. "
        "This remains a partial compatibility facade, not a Basic WMS conformance claim."
    ),
    responses={
        200: {"description": "Project WMS capabilities XML or an exact governed map."},
        303: {"description": "A larger exact map is available at its signed object version."},
        400: {"description": "A WMS XML service exception."},
        503: {"description": "Rendering did not finish inside the bounded synchronous window."},
    },
)
async def project_wms_service(
    project_id: UUID,
    http_request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> Response:
    try:
        wms_request = parse_wms_request(http_request.query_params.multi_items(), layer_limit=16)
    except (ValueError, WmsRequestError) as error:
        if isinstance(error, WmsRequestError):
            return _wms_exception_response(
                error.code, error.locator, error.message, error.status_code
            )
        return _wms_exception_response(
            "NoApplicableCode", "REQUEST", "The WMS request is invalid.", 400
        )
    context = tenant_context(session)
    try:
        catalog = await execute_render(repository.get_project_map_catalog(context, project_id))
    except HTTPException as error:
        return _wms_http_exception(error)
    if not catalog.layers:
        return _wms_exception_response(
            "LayerNotDefined", "LAYERS", "No governed map layer is available.", 404
        )
    if isinstance(wms_request, WmsCapabilitiesRequest):
        advertised = tuple(
            WmsLayer(
                name=layer.publication.name,
                title=layer.collection.title,
                abstract=layer.collection.description,
                attribution=layer.collection.attribution,
                bbox=layer.collection.spatial_extent or (-180.0, -90.0, 180.0, 90.0),
                styles=tuple(
                    WmsStyle(str(profile.profile_id), profile.title) for profile in layer.profiles
                ),
            )
            for layer in catalog.layers
        )
        endpoint = str(http_request.url).split("?", 1)[0]
        try:
            document = capabilities_xml(
                advertised,
                endpoint,
                service_title=catalog.title,
                layer_limit=16,
                version=wms_request.version,
            )
        except ValueError:
            logger.error("wms.project_endpoint_invalid")
            return _wms_exception_response(
                "NoApplicableCode", "REQUEST", "The map service endpoint is invalid.", 503
            )
        return Response(
            content=document,
            status_code=status.HTTP_200_OK,
            media_type="text/xml",
            headers=_wms_xml_headers(),
        )

    assert isinstance(wms_request, WmsMapRequest)
    catalog_by_name = {layer.publication.name: layer for layer in catalog.layers}
    selected_profiles: list[RenderProfile] = []
    for layer_id, style_id in wms_request.layers:
        layer = catalog_by_name.get(layer_id)
        if layer is None:
            return _wms_exception_response(
                "LayerNotDefined", "LAYERS", "A requested layer is not advertised.", 404
            )
        selected = (
            layer.profiles[0]
            if style_id is None
            else next(
                (profile for profile in layer.profiles if profile.profile_id == style_id),
                None,
            )
        )
        if selected is None:
            return _wms_exception_response(
                "StyleNotDefined", "STYLES", "A requested style is not advertised.", 404
            )
        selected_profiles.append(selected)
    profiles = tuple(selected_profiles)
    first = profiles[0]
    map_scope = dict(http_request.scope)
    map_scope["opengeo.wms_getmap"] = True
    try:
        result = await get_map(
            project_id=project_id,
            resource_id=first.resource_id,
            profile_id=first.profile_id,
            bbox=_map_bbox_header(wms_request.bbox),
            http_request=Request(map_scope),
            response=response,
            session=session,
            repository=repository,
            dispatcher=dispatcher,
            composition_profiles=(profiles if len(profiles) > 1 else None),
            width=wms_request.width,
            height=wms_request.height,
            crs=MAP_CRS_URIS[wms_request.crs],
            output_format=wms_request.format,
            background_color=wms_request.background_color,
            transparent=wms_request.transparent,
        )
    except HTTPException as error:
        return _wms_http_exception(error)
    if isinstance(result, MapRequestResponse):
        return _wms_exception_response(
            "ServerBusy",
            "REQUEST",
            "The exact governed map did not finish inside the synchronous window; retry the same "
            "request.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"Retry-After": "5"},
        )
    return result


@router.get(
    "/projects/{project_id}/resources/{resource_id}/wms",
    response_class=Response,
    summary="Use the resource-scoped WMS 1.3.0/1.1.1 compatibility facade",
    description=(
        "Supports strict GetCapabilities and one-layer CRS:84 or EPSG:3857 SVG/PNG GetMap "
        "requests. Exact cached output returns normally; an uncached request queues one immutable "
        "render and waits for a bounded interval. Fast completion returns the exact image, while "
        "inactive or saturated processing returns a retryable XML service exception. This route "
        "does not yet make a Basic WMS conformance claim."
    ),
    responses={
        200: {"description": "WMS capabilities XML or an exact governed map."},
        303: {"description": "A larger exact map is available at its signed object version."},
        400: {"description": "A WMS XML service exception."},
        503: {"description": "Rendering did not finish inside the bounded synchronous window."},
    },
)
async def wms_service(
    project_id: UUID,
    resource_id: UUID,
    http_request: Request,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> Response:
    try:
        wms_request = parse_wms_request(http_request.query_params.multi_items())
    except WmsRequestError as error:
        return _wms_exception_response(error.code, error.locator, error.message, error.status_code)

    context = tenant_context(session)
    try:
        collection = await execute_render(
            repository.get_map_collection(context, project_id, resource_id)
        )
        profiles = await execute_render(repository.list_profiles(context, project_id, resource_id))
    except HTTPException as error:
        return _wms_http_exception(error)

    if not profiles:
        return _wms_exception_response(
            "StyleNotDefined", "STYLES", "No governed render style is available.", 404
        )
    if isinstance(wms_request, WmsCapabilitiesRequest):
        layer = WmsLayer(
            name=str(collection.resource_id),
            title=collection.title,
            abstract=collection.description,
            attribution=collection.attribution,
            bbox=collection.spatial_extent or (-180.0, -90.0, 180.0, 90.0),
            styles=tuple(
                WmsStyle(name=str(profile.profile_id), title=profile.title) for profile in profiles
            ),
        )
        endpoint = str(http_request.url).split("?", 1)[0]
        try:
            document = capabilities_xml(layer, endpoint, version=wms_request.version)
        except ValueError:
            logger.error("wms.endpoint_invalid")
            return _wms_exception_response(
                "NoApplicableCode", "REQUEST", "The map service endpoint is invalid.", 503
            )
        return Response(
            content=document,
            status_code=status.HTTP_200_OK,
            media_type="text/xml",
            headers=_wms_xml_headers(),
        )

    assert isinstance(wms_request, WmsMapRequest)
    if wms_request.layer_id != str(resource_id):
        return _wms_exception_response(
            "LayerNotDefined", "LAYERS", "The requested layer is not advertised.", 404
        )
    selected_profile = (
        profiles[0]
        if wms_request.style_id is None
        else next(
            (profile for profile in profiles if profile.profile_id == wms_request.style_id),
            None,
        )
    )
    if selected_profile is None:
        return _wms_exception_response(
            "StyleNotDefined", "STYLES", "The requested style is not advertised.", 404
        )
    map_scope = dict(http_request.scope)
    map_scope["opengeo.wms_getmap"] = True
    map_http_request = Request(map_scope)
    try:
        result = await get_map(
            project_id=project_id,
            resource_id=resource_id,
            profile_id=selected_profile.profile_id,
            bbox=_map_bbox_header(wms_request.bbox),
            http_request=map_http_request,
            response=response,
            session=session,
            repository=repository,
            dispatcher=dispatcher,
            composition_profiles=None,
            width=wms_request.width,
            height=wms_request.height,
            crs=MAP_CRS_URIS[wms_request.crs],
            output_format=wms_request.format,
            background_color=wms_request.background_color,
            transparent=wms_request.transparent,
        )
    except HTTPException as error:
        return _wms_http_exception(error)
    if isinstance(result, MapRequestResponse):
        return _wms_exception_response(
            "ServerBusy",
            "REQUEST",
            "The exact governed map did not finish inside the synchronous window; retry the same "
            "request.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"Retry-After": "5"},
        )
    return result


@router.get(
    "/projects/{project_id}/resources/{resource_id}/renders",
    response_model=list[RenderJobResponse],
)
async def list_resource_renders(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> list[RenderJobResponse]:
    records = await execute_render(
        repository.list_resource_renders(tenant_context(session), project_id, resource_id)
    )
    return [job_response(record) for record in records]


@router.post(
    "/projects/{project_id}/resources/{resource_id}/saved-map-renders",
    response_model=RenderJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_saved_map_render(
    project_id: UUID,
    resource_id: UUID,
    payload: CreateSavedMapRenderRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> RenderJobResponse:
    submission = await execute_render(
        repository.request_saved_map_render(
            tenant_context(session),
            project_id,
            resource_id,
            SavedMapRenderRequest(**payload.model_dump()),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_render(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("render.dispatch_unavailable")
            raise HTTPException(status_code=503, detail="render_dispatch_unavailable") from error
    return job_response(submission.job)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/render-profiles/{profile_id}/renders",
    response_model=RenderJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_render(
    project_id: UUID,
    resource_id: UUID,
    profile_id: UUID,
    payload: CreateRenderRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    dispatcher: Annotated[RenderDispatcher, Depends(dispatcher_from_request)],
) -> RenderJobResponse:
    submission = await execute_render(
        repository.request_render(
            tenant_context(session),
            project_id,
            resource_id,
            profile_id,
            RenderRequest(
                idempotency_key=payload.idempotency_key,
                bbox=payload.bbox,
                crs=payload.crs,
                width=payload.width,
                height=payload.height,
                format=payload.format,
                background_color=payload.background_color,
                transparent=payload.transparent,
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_render(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("render.dispatch_unavailable")
            raise HTTPException(status_code=503, detail="render_dispatch_unavailable") from error
    return job_response(submission.job)


@router.get(
    "/projects/{project_id}/resources/{resource_id}/renders/{job_id}",
    response_model=RenderJobResponse,
)
async def get_render(
    project_id: UUID,
    resource_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> RenderJobResponse:
    return job_response(
        await execute_render(
            repository.get_job(tenant_context(session), project_id, resource_id, job_id)
        )
    )


class ArtifactRegistrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0, le=2_147_483_646, strict=True)


class ArtifactCurrentRequest(ArtifactRegistrationRequest):
    version_number: int = Field(ge=1, le=2_147_483_647, strict=True)


@router.post("/projects/{project_id}/resources/{resource_id}/renders/{job_id}/artifact-edition")
async def register_artifact_edition(
    project_id: UUID,
    resource_id: UUID,
    job_id: UUID,
    body: ArtifactRegistrationRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.register_artifact_edition(
            tenant_context(session), project_id, resource_id, job_id, body.expected_revision
        )
    )


class PortableArtifactUploadRequest(ArtifactRegistrationRequest):
    manifest_json: str = Field(min_length=1, max_length=49_152)


def portable_manifest_bytes(value: str) -> bytes:
    try:
        encoded = value.encode("utf-8")
    except UnicodeError as error:
        raise HTTPException(
            status_code=422, detail={"code": "artifact_manifest_invalid"}
        ) from error
    if len(encoded) > 49_152:
        raise HTTPException(status_code=422, detail={"code": "artifact_manifest_size_invalid"})
    return encoded


@router.post("/projects/{project_id}/resources/{resource_id}/artifact/uploads")
async def request_portable_artifact_upload(
    project_id: UUID,
    resource_id: UUID,
    body: PortableArtifactUploadRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.request_portable_upload(
            tenant_context(session),
            project_id,
            resource_id,
            portable_manifest_bytes(body.manifest_json),
            body.expected_revision,
        )
    )


@router.post("/projects/{project_id}/resources/{resource_id}/artifact/uploads/{upload_id}/complete")
async def complete_portable_artifact_upload(
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.complete_portable_upload(
            tenant_context(session),
            project_id,
            resource_id,
            upload_id,
        )
    )


@router.post("/projects/{project_id}/resources/{resource_id}/artifact/uploads/{upload_id}/cleanup")
async def cleanup_portable_artifact_upload(
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.cleanup_portable_upload(
            tenant_context(session),
            project_id,
            resource_id,
            upload_id,
        )
    )


@router.get("/projects/{project_id}/resources/{resource_id}/artifact/uploads/{upload_id}/cleanup")
async def list_portable_artifact_cleanup(
    project_id: UUID,
    resource_id: UUID,
    upload_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> list[dict[str, Any]]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.list_portable_cleanup_attempts(
            tenant_context(session),
            project_id,
            resource_id,
            upload_id,
        )
    )


class PortableArtifactRegistrationRequest(ArtifactRegistrationRequest):
    output_object_id: UUID
    manifest_json: str = Field(min_length=1, max_length=49_152)


@router.post("/projects/{project_id}/resources/{resource_id}/artifact/portable-editions")
async def register_portable_artifact_edition(
    project_id: UUID,
    resource_id: UUID,
    body: PortableArtifactRegistrationRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    encoded = portable_manifest_bytes(body.manifest_json)
    return await execute_render(
        repository.register_retained_portable_edition(
            tenant_context(session),
            project_id,
            resource_id,
            body.output_object_id,
            encoded,
            body.expected_revision,
        )
    )


@router.get("/projects/{project_id}/resources/{resource_id}/artifact")
async def read_artifact_edition(
    project_id: UUID,
    resource_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    version_number: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
    metadata_only: bool = False,
    representation: Literal["saved-map-image", "portable-map-html"] = "saved-map-image",
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.read_artifact_edition(
            tenant_context(session),
            project_id,
            resource_id,
            version_number,
            metadata_only,
            **({"representation": representation} if representation != "saved-map-image" else {}),
        )
    )


@router.put("/projects/{project_id}/resources/{resource_id}/artifact/current")
async def select_artifact_current(
    project_id: UUID,
    resource_id: UUID,
    body: ArtifactCurrentRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    representation: Literal["saved-map-image", "portable-map-html"] = "saved-map-image",
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.select_artifact_current(
            tenant_context(session),
            project_id,
            resource_id,
            body.version_number,
            body.expected_revision,
            **({"representation": representation} if representation != "saved-map-image" else {}),
        )
    )


@router.get(
    "/projects/{project_id}/resources/{resource_id}/renders/{job_id}/artifact-manifest",
)
async def get_project_artifact(
    project_id: UUID,
    resource_id: UUID,
    job_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return await execute_render(
        repository.get_project_artifact(tenant_context(session), project_id, resource_id, job_id)
    )


@router.post(
    "/projects/{project_id}/resources/{resource_id}/renders/{job_id}/download",
    response_model=DownloadTicketResponse,
)
async def download_render(
    project_id: UUID,
    resource_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
) -> DownloadTicketResponse:
    ticket: DownloadTicket = await execute_render(
        repository.request_download(
            tenant_context(session), project_id, resource_id, job_id, get_request_id()
        )
    )
    return DownloadTicketResponse(
        url=ticket.url, method=ticket.method, expires_at=ticket.expires_at
    )


@router.post(
    "/projects/{project_id}/resources/{resource_id}/artifact/portable-download",
    response_model=DownloadTicketResponse,
)
async def download_portable_artifact(
    project_id: UUID,
    resource_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[RenderRepository, Depends(repository_from_request)],
    version_number: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
) -> DownloadTicketResponse:
    response.headers["Cache-Control"] = "no-store"
    ticket = await execute_render(
        repository.request_portable_download(
            tenant_context(session), project_id, resource_id, version_number
        )
    )
    return DownloadTicketResponse(
        url=ticket.url, method=ticket.method, expires_at=ticket.expires_at
    )
