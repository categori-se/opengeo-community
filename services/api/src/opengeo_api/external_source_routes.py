import ipaddress
import json
import logging
import math
import re
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from urllib.parse import SplitResult, urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.external_sources import (
    ExternalSource,
    ExternalSourceAccessDenied,
    ExternalSourceConflict,
    ExternalSourceDraft,
    ExternalSourceNotFound,
    ExternalSourceRepository,
    ExternalSourceRevision,
    ExternalSourceStoreUnavailable,
    ExternalSourceUpdate,
    PostgresExternalSourceRepository,
)
from opengeo_api.ingestion import DatasetClassification, Page
from opengeo_api.logging import get_request_id
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["governed external sources"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)
]
SourceUrl = Annotated[str, StringConstraints(strip_whitespace=True, min_length=9, max_length=2048)]
Attribution = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]
SourceLicense = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
HexSha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Tag = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=64),
]
ChangeMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
OgcName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9_.:-]+$",
    ),
]

_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
_BLOCKED_HOSTS = frozenset({"localhost", "localhost.localdomain"})
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class XYZSourceDefinition(RequestModel):
    type: Literal["xyz"]
    url: SourceUrl
    min_zoom: int = Field(default=0, ge=0, le=24)
    max_zoom: int = Field(default=22, ge=0, le=24)
    tile_size: Literal[256, 512] = 256
    scheme: Literal["xyz", "tms"] = "xyz"
    attribution: Attribution | None = None
    presentation_role: Literal["regional_basemap"] | None = None
    license: SourceLicense | None = None
    coverage_bounds: list[float] | None = Field(default=None, min_length=4, max_length=4)
    coordinate_behavior: Literal["wgs84_web_mercator", "gcj02_offset"] | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        _validate_public_https_url(value, allow_query=True)
        placeholders = _PLACEHOLDER.findall(value)
        if set(placeholders) != {"z", "x", "y"} or len(placeholders) != 3:
            raise ValueError("XYZ URL must contain exactly {z}, {x}, and {y}")
        if value.count("{") != 3 or value.count("}") != 3:
            raise ValueError("XYZ URL contains an unsupported placeholder")
        return value

    @model_validator(mode="after")
    def validate_zoom_range(self) -> "XYZSourceDefinition":
        if self.min_zoom > self.max_zoom:
            raise ValueError("min_zoom must not exceed max_zoom")
        regional_fields = (
            self.license,
            self.coverage_bounds,
            self.coordinate_behavior,
        )
        if self.presentation_role is None:
            if any(value is not None for value in regional_fields):
                raise ValueError("regional basemap metadata requires presentation_role")
            return self
        if any(value is None for value in regional_fields) or self.attribution is None:
            raise ValueError(
                "regional basemaps require attribution, license, coverage_bounds, "
                "and coordinate_behavior"
            )
        assert self.coverage_bounds is not None
        west, south, east, north = self.coverage_bounds
        if (
            any(not math.isfinite(value) for value in self.coverage_bounds)
            or not -180 <= west < east <= 180
            or not -90 <= south < north <= 90
        ):
            raise ValueError("coverage_bounds must be ordered WGS84 longitude/latitude bounds")
        return self

    def configuration(self) -> dict[str, Any]:
        configuration: dict[str, Any] = {
            "min_zoom": self.min_zoom,
            "max_zoom": self.max_zoom,
            "tile_size": self.tile_size,
            "scheme": self.scheme,
            "attribution": self.attribution,
        }
        if self.presentation_role is not None:
            configuration.update(
                {
                    "presentation_role": self.presentation_role,
                    "license": self.license,
                    "coverage_bounds": self.coverage_bounds,
                    "coordinate_behavior": self.coordinate_behavior,
                }
            )
        return configuration


class WMSSourceDefinition(RequestModel):
    type: Literal["wms"]
    url: SourceUrl
    version: Literal["1.3.0", "1.1.1"] = "1.3.0"
    layers: list[OgcName] = Field(min_length=1, max_length=32)
    styles: list[OgcName | Literal[""]] = Field(default_factory=list, max_length=32)
    image_format: Literal["image/png", "image/jpeg"] = "image/png"
    transparent: bool = True
    crs: Literal["EPSG:3857"] = "EPSG:3857"
    tile_size: Literal[256, 512] = 256
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if not parsed.path.startswith("/"):
            raise ValueError("WMS URL must contain an absolute path")
        return value

    @field_validator("layers", mode="after")
    @classmethod
    def unique_layers(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("WMS layers must be unique")
        return values

    @model_validator(mode="after")
    def validate_styles(self) -> "WMSSourceDefinition":
        if self.styles and len(self.styles) != len(self.layers):
            raise ValueError("WMS styles must be empty or align one-to-one with layers")
        if self.image_format == "image/jpeg" and self.transparent:
            raise ValueError("transparent JPEG WMS tiles are not supported")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "layers": self.layers,
            "styles": self.styles or [""] * len(self.layers),
            "format": self.image_format,
            "transparent": self.transparent,
            "crs": self.crs,
            "tile_size": self.tile_size,
            "attribution": self.attribution,
        }


class PMTilesSourceDefinition(RequestModel):
    type: Literal["pmtiles"]
    url: SourceUrl
    tile_type: Literal["vector", "raster"]
    source_layer: OgcName | None = None
    geometry_type: Literal["Point", "LineString", "Polygon"] | None = None
    min_zoom: int = Field(default=0, ge=0, le=24)
    max_zoom: int = Field(default=24, ge=0, le=24)
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if not parsed.path.lower().endswith(".pmtiles"):
            raise ValueError("PMTiles URL path must end with .pmtiles")
        return value

    @model_validator(mode="after")
    def validate_render_contract(self) -> "PMTilesSourceDefinition":
        if self.min_zoom > self.max_zoom:
            raise ValueError("min_zoom must not exceed max_zoom")
        if self.tile_type == "vector" and (self.source_layer is None or self.geometry_type is None):
            raise ValueError("vector PMTiles requires source_layer and geometry_type")
        if self.tile_type == "raster" and (
            self.source_layer is not None or self.geometry_type is not None
        ):
            raise ValueError("raster PMTiles must not declare vector fields")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "tile_type": self.tile_type,
            "source_layer": self.source_layer,
            "geometry_type": self.geometry_type,
            "min_zoom": self.min_zoom,
            "max_zoom": self.max_zoom,
            "attribution": self.attribution,
        }


class ImageServerSourceDefinition(RequestModel):
    """Anonymous display requests, not analytical pixels or an archive capture."""

    type: Literal["imageserver"]
    url: SourceUrl
    tile_size: Literal[256, 512] = 256
    image_format: Literal["png32", "jpg"] = "png32"
    interpolation: Literal["RSP_NearestNeighbor", "RSP_BilinearInterpolation"] = (
        "RSP_NearestNeighbor"
    )
    band_ids: list[Annotated[int, Field(strict=True, ge=0, le=255)]] = Field(
        default_factory=list, max_length=3
    )
    raster_ids: list[Annotated[int, Field(strict=True, ge=0, le=2147483647)]] = Field(
        default_factory=list, max_length=32
    )
    min_zoom: int = Field(default=0, ge=0, le=24)
    max_zoom: int = Field(default=22, ge=0, le=24)
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if re.search(r"/ImageServer/?$", parsed.path) is None:
            raise ValueError("ImageServer URL must identify an image service, not an operation")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_display(self) -> "ImageServerSourceDefinition":
        if len(self.band_ids) not in (0, 1, 3):
            raise ValueError("band_ids must select one or three zero-based display bands")
        if len(set(self.raster_ids)) != len(self.raster_ids):
            raise ValueError("raster_ids must select unique raster records")
        if self.min_zoom > self.max_zoom:
            raise ValueError("min_zoom must not exceed max_zoom")
        return self

    def configuration(self) -> dict[str, Any]:
        configuration = {
            "service_kind": "imageserver",
            "tile_size": self.tile_size,
            "image_format": self.image_format,
            "interpolation": self.interpolation,
            "band_ids": self.band_ids,
            "min_zoom": self.min_zoom,
            "max_zoom": self.max_zoom,
            "attribution": self.attribution,
        }
        if self.raster_ids:
            configuration["raster_ids"] = self.raster_ids
        return configuration


class COGSourceDefinition(RequestModel):
    """A public raster reference, not an upload or a claim of verified COG layout."""

    type: Literal["cog"]
    url: SourceUrl
    bands: list[Annotated[int, Field(strict=True, ge=1, le=64)]] = Field(
        default_factory=lambda: [1, 2, 3], min_length=1, max_length=3
    )
    bounds: list[float] = Field(min_length=4, max_length=4)
    size_bytes: int | None = Field(default=None, strict=True, ge=1, le=1_099_511_627_776)
    attribution: Attribution | None = None
    license: SourceLicense | None = None
    reference_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if not parsed.path.lower().endswith((".tif", ".tiff")):
            raise ValueError("A COG reference must name a query-free TIFF object")
        return value

    @model_validator(mode="after")
    def validate_reference(self) -> "COGSourceDefinition":
        west, south, east, north = self.bounds
        if (
            any(not math.isfinite(value) for value in self.bounds)
            or not -180 <= west < east <= 180
            or not -90 <= south < north <= 90
        ):
            raise ValueError("COG bounds must be ordered WGS84 bounds")
        if len(self.bands) not in (1, 3) or len(set(self.bands)) != len(self.bands):
            raise ValueError("Select one or three distinct one-based display bands")
        if len(json.dumps(self.reference_metadata, allow_nan=False).encode("utf-8")) > 262_144:
            raise ValueError("COG reference metadata exceeds 256 KiB")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "service_kind": "cog",
            "bands": self.bands,
            "bounds": self.bounds,
            "size_bytes": self.size_bytes,
            "attribution": self.attribution,
            "license": self.license,
            "reference_metadata": self.reference_metadata,
        }


class MapServerSourceDefinition(RequestModel):
    """Live map rendering; exported images are not original raster datasets."""

    type: Literal["mapserver"]
    url: SourceUrl
    layer_ids: list[Annotated[int, Field(strict=True, ge=0, le=1000000)]] = Field(
        min_length=1, max_length=32
    )
    tile_size: Literal[256, 512] = 256
    image_format: Literal["png32"] = "png32"
    min_zoom: int = Field(default=0, ge=0, le=24)
    max_zoom: int = Field(default=22, ge=0, le=24)
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if re.search(r"/MapServer/?$", parsed.path) is None:
            raise ValueError("MapServer URL must identify the service, not a layer or operation")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_display(self) -> "MapServerSourceDefinition":
        if len(set(self.layer_ids)) != len(self.layer_ids) or self.min_zoom > self.max_zoom:
            raise ValueError("Layer IDs must be unique and zoom limits ordered")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "service_kind": "mapserver",
            "layer_ids": self.layer_ids,
            "tile_size": self.tile_size,
            "image_format": self.image_format,
            "min_zoom": self.min_zoom,
            "max_zoom": self.max_zoom,
            "attribution": self.attribution,
        }


class ArcgisSourceDefinition(RequestModel):
    type: Literal["arcgis"]
    url: SourceUrl
    object_id_field: OgcName
    fields: list[OgcName] = Field(min_length=1, max_length=64)
    geometry_type: Literal[
        "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
    ]
    page_size: int = Field(default=1000, ge=1, le=2000)
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if re.search(r"/(?:FeatureServer|MapServer)/[0-9]{1,5}/?$", parsed.path) is None:
            raise ValueError("ArcGIS URL must identify one FeatureServer or MapServer layer")
        return value.rstrip("/")

    @field_validator("fields", mode="after")
    @classmethod
    def unique_fields(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("ArcGIS fields must be unique")
        return values

    @model_validator(mode="after")
    def validate_identity_field(self) -> "ArcgisSourceDefinition":
        if self.object_id_field not in self.fields:
            raise ValueError("ArcGIS fields must include object_id_field")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "object_id_field": self.object_id_field,
            "fields": self.fields,
            "geometry_type": self.geometry_type,
            "page_size": self.page_size,
            "attribution": self.attribution,
        }


class WfsSourceDefinition(RequestModel):
    type: Literal["wfs"]
    url: SourceUrl
    version: Literal["2.0.0"] = "2.0.0"
    type_name: OgcName
    geometry_name: OgcName
    fields: list[OgcName] = Field(min_length=1, max_length=64)
    sort_by: OgcName
    geometry_type: Literal[
        "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
    ]
    page_size: int = Field(default=1000, ge=1, le=1000)
    attribution: Attribution | None = None

    @field_validator("url", mode="after")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if not parsed.path.startswith("/"):
            raise ValueError("WFS URL must contain an absolute path")
        return value

    @field_validator("fields", mode="after")
    @classmethod
    def unique_fields(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("WFS fields must be unique")
        return values

    @model_validator(mode="after")
    def validate_sort_field(self) -> "WfsSourceDefinition":
        if self.sort_by not in self.fields:
            raise ValueError("WFS fields must include sort_by")
        if self.geometry_name in self.fields:
            raise ValueError("WFS geometry_name must be separate from attribute fields")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "type_name": self.type_name,
            "geometry_name": self.geometry_name,
            "fields": self.fields,
            "sort_by": self.sort_by,
            "geometry_type": self.geometry_type,
            "page_size": self.page_size,
            "attribution": self.attribution,
        }


class GeoJsonArchiveSourceDefinition(RequestModel):
    type: Literal["geojson"]
    url: SourceUrl
    content_encoding: Literal["identity", "gzip"]
    object_sha256: HexSha256
    decoded_sha256: HexSha256
    size_bytes: int = Field(ge=1, le=33_554_432)
    decoded_size_bytes: int = Field(ge=1, le=134_217_728)
    feature_count: int = Field(ge=1, le=250_000)
    geometry_type: Literal[
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
    ]
    bounds: list[float] = Field(min_length=4, max_length=4)
    attribution: Attribution
    license: SourceLicense
    authoritative_url: SourceUrl
    rights_url: SourceUrl

    @field_validator("url", mode="after")
    @classmethod
    def validate_archive_url(cls, value: str) -> str:
        parsed = _validate_public_https_url(value, allow_query=False)
        if not parsed.path.lower().endswith((".geojson", ".geojson.gz")):
            raise ValueError("GeoJSON archive URL must end with .geojson or .geojson.gz")
        return value

    @field_validator("authoritative_url", "rights_url", mode="after")
    @classmethod
    def validate_reference_url(cls, value: str) -> str:
        _validate_public_https_url(value, allow_query=True)
        return value

    @field_validator("bounds", mode="after")
    @classmethod
    def validate_bounds(cls, value: list[float]) -> list[float]:
        west, south, east, north = value
        if (
            any(not math.isfinite(coordinate) for coordinate in value)
            or not -180 <= west < east <= 180
            or not -90 <= south < north <= 90
        ):
            raise ValueError("GeoJSON archive bounds must be ordered WGS84 bounds")
        return value

    @model_validator(mode="after")
    def validate_archive_shape(self) -> "GeoJsonArchiveSourceDefinition":
        gzip_path = self.url.lower().endswith(".geojson.gz")
        if gzip_path != (self.content_encoding == "gzip"):
            raise ValueError("GeoJSON archive encoding must match its filename")
        if self.content_encoding == "identity" and (
            self.object_sha256 != self.decoded_sha256 or self.size_bytes != self.decoded_size_bytes
        ):
            raise ValueError("Uncompressed GeoJSON object and decoded facts must match")
        if self.content_encoding == "gzip" and self.decoded_size_bytes < self.size_bytes:
            raise ValueError("Gzip GeoJSON decoded size must not be smaller than the object")
        return self

    def configuration(self) -> dict[str, Any]:
        return {
            "content_encoding": self.content_encoding,
            "object_sha256": self.object_sha256,
            "decoded_sha256": self.decoded_sha256,
            "size_bytes": self.size_bytes,
            "decoded_size_bytes": self.decoded_size_bytes,
            "feature_count": self.feature_count,
            "geometry_type": self.geometry_type,
            "bounds": self.bounds,
            "attribution": self.attribution,
            "license": self.license,
            "authoritative_url": self.authoritative_url,
            "rights_url": self.rights_url,
        }


SourceDefinition = Annotated[
    XYZSourceDefinition
    | WMSSourceDefinition
    | PMTilesSourceDefinition
    | GeoJsonArchiveSourceDefinition
    | ArcgisSourceDefinition
    | MapServerSourceDefinition
    | ImageServerSourceDefinition
    | COGSourceDefinition
    | WfsSourceDefinition,
    Field(discriminator="type"),
]


class CreateExternalSourceRequest(RequestModel):
    discovery_job_id: UUID | None = None
    name: Name
    description: Description | None = None
    classification: DatasetClassification = "internal"
    tags: list[Tag] = Field(default_factory=list, max_length=12)
    source: SourceDefinition

    @field_validator("tags", mode="after")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(values))
        if len(normalized) != len(values):
            raise ValueError("tags must be unique")
        return normalized


class UpdateExternalSourceRequest(RequestModel):
    expected_version: int = Field(ge=1)
    change_message: ChangeMessage | None = None
    source: SourceDefinition | None = None
    classification: DatasetClassification | None = None
    expected_classification: DatasetClassification | None = None
    public_eligibility_reviewed: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def separate_access_decision(self) -> "UpdateExternalSourceRequest":
        if (self.source is None) == (self.classification is None):
            raise ValueError("Choose a source revision or a classification decision")
        if self.classification is None:
            if self.expected_classification is not None or self.public_eligibility_reviewed:
                raise ValueError("Access review belongs to a classification decision")
        elif self.expected_classification is None:
            raise ValueError("Classification decisions require the previous classification")
        elif self.classification == "public" and not self.public_eligibility_reviewed:
            raise ValueError("Public source eligibility must be reviewed explicitly")
        return self


class ExternalSourceCapabilitiesResponse(BaseModel):
    read: bool
    edit: bool
    manage_classification: bool = False


class ExternalSourceResponse(BaseModel):
    dataset_id: UUID
    project_id: UUID
    name: str
    description: str | None
    classification: DatasetClassification
    status: str
    owner_user_id: UUID
    source_type: str
    access_mode: str
    credential_mode: str
    version_number: int
    source_url: str
    configuration: dict[str, Any]
    verification_state: str
    created_at: datetime
    updated_at: datetime
    capabilities: ExternalSourceCapabilitiesResponse


class ExternalSourceRevisionResponse(BaseModel):
    dataset_id: UUID
    version_number: int
    source_url: str
    configuration: dict[str, Any]
    verification_state: str
    change_message: str | None
    created_by: UUID
    created_at: datetime


def repository_from_request(request: Request) -> ExternalSourceRepository:
    repository = request.app.state.external_source_repository
    if not isinstance(repository, PostgresExternalSourceRepository):
        return cast(ExternalSourceRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit, offset)


PageDependency = Annotated[Page, Depends(page_parameters)]


async def execute_source[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except ExternalSourceAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except ExternalSourceNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except ExternalSourceConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except ExternalSourceStoreUnavailable as error:
        logger.error("external_source.store_unavailable")
        raise HTTPException(status_code=503, detail="external_source_store_unavailable") from error


def source_response(source: ExternalSource) -> ExternalSourceResponse:
    return ExternalSourceResponse(
        dataset_id=source.dataset_id,
        project_id=source.project_id,
        name=source.name,
        description=source.description,
        classification=source.classification,
        status=source.status,
        owner_user_id=source.owner_user_id,
        source_type=source.source_type,
        access_mode=source.access_mode,
        credential_mode=source.credential_mode,
        version_number=source.version_number,
        source_url=source.source_url,
        configuration=source.configuration,
        verification_state=source.verification_state,
        created_at=source.created_at,
        updated_at=source.updated_at,
        capabilities=ExternalSourceCapabilitiesResponse(
            read=source.capabilities.read,
            edit=source.capabilities.edit,
            manage_classification=source.capabilities.manage_classification,
        ),
    )


def revision_response(revision: ExternalSourceRevision) -> ExternalSourceRevisionResponse:
    return ExternalSourceRevisionResponse(
        dataset_id=revision.dataset_id,
        version_number=revision.version_number,
        source_url=revision.source_url,
        configuration=revision.configuration,
        verification_state=revision.verification_state,
        change_message=revision.change_message,
        created_by=revision.created_by,
        created_at=revision.created_at,
    )


@router.get("/projects/{project_id}/sources", response_model=list[ExternalSourceResponse])
async def list_sources(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalSourceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[ExternalSourceResponse]:
    records = await execute_source(
        repository.list_sources(tenant_context(session), project_id, page)
    )
    return [source_response(record) for record in records]


@router.post(
    "/projects/{project_id}/sources",
    response_model=ExternalSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_source(
    project_id: UUID,
    payload: CreateExternalSourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalSourceRepository, Depends(repository_from_request)],
) -> ExternalSourceResponse:
    definition = payload.source
    record = await execute_source(
        repository.create_source(
            tenant_context(session),
            project_id,
            ExternalSourceDraft(
                name=payload.name,
                description=payload.description,
                classification=payload.classification,
                source_type=definition.type,
                source_url=definition.url,
                configuration=definition.configuration(),
                tags=tuple(payload.tags),
                discovery_job_id=payload.discovery_job_id,
            ),
            get_request_id(),
        )
    )
    return source_response(record)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/source",
    response_model=ExternalSourceResponse,
)
async def get_source(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalSourceRepository, Depends(repository_from_request)],
) -> ExternalSourceResponse:
    record = await execute_source(
        repository.get_source(tenant_context(session), project_id, dataset_id)
    )
    return source_response(record)


@router.patch(
    "/projects/{project_id}/datasets/{dataset_id}/source",
    response_model=ExternalSourceResponse,
)
async def update_source(
    project_id: UUID,
    dataset_id: UUID,
    payload: UpdateExternalSourceRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalSourceRepository, Depends(repository_from_request)],
) -> ExternalSourceResponse:
    definition = payload.source
    record = await execute_source(
        repository.update_source(
            tenant_context(session),
            project_id,
            dataset_id,
            ExternalSourceUpdate(
                expected_version=payload.expected_version,
                source_type=definition.type if definition is not None else None,
                source_url=definition.url if definition is not None else None,
                configuration=definition.configuration() if definition is not None else None,
                change_message=payload.change_message,
                classification=payload.classification,
                expected_classification=payload.expected_classification,
                public_eligibility_reviewed=payload.public_eligibility_reviewed,
            ),
            get_request_id(),
        )
    )
    return source_response(record)


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/source/revisions",
    response_model=list[ExternalSourceRevisionResponse],
)
async def list_source_revisions(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ExternalSourceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[ExternalSourceRevisionResponse]:
    records = await execute_source(
        repository.list_source_revisions(tenant_context(session), project_id, dataset_id, page)
    )
    return [revision_response(record) for record in records]


def _validate_public_https_url(value: str, *, allow_query: bool) -> SplitResult:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("source URL contains a control character")
    if "\\" in value:
        raise ValueError("source URL contains a backslash")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("source URL is invalid") from error
    if parsed.scheme != "https" or not parsed.netloc or not parsed.hostname:
        raise ValueError("source URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("source URL must not contain credentials")
    if parsed.fragment:
        raise ValueError("source URL must not contain a fragment")
    if not allow_query and parsed.query:
        raise ValueError("source URL must not contain query parameters")
    if port not in {None, 443}:
        raise ValueError("source URL may only use the default HTTPS port")
    host = parsed.hostname.lower().rstrip(".")
    if host in _BLOCKED_HOSTS or host.endswith(_BLOCKED_SUFFIXES):
        raise ValueError("source URL host is not public")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or any(not _HOST_LABEL.fullmatch(label) for label in host.split(".")):
            raise ValueError("source URL host is invalid") from None
    else:
        raise ValueError("source URL must use a public DNS host name")
    return parsed
