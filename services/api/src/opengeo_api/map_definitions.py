import json
import math
import re
from dataclasses import dataclass
from itertools import pairwise
from typing import Any, TypeGuard, cast
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from opengeo_api.map_filters import validate_map_filter
from opengeo_api.render_fonts import validate_render_font_reference

MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.3.0"
STYLE_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.4.0"
PATH_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.2.0"
PROCESSING_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.1.0"
LEGACY_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.0.0"
MAX_MAP_DEFINITION_BYTES = 262_144
MAX_MAP_DEFINITION_DEPTH = 24
MAX_MAP_DEFINITION_NODES = 20_000
MAX_MAP_LAYERS = 256
MAX_PROCESSING_MODELS = 100
MAX_PROCESSING_MODEL_STEPS = 16
MAX_PROCESSING_HISTORY = 100
MAX_PATH_MEASUREMENTS = 50
MAX_MEASUREMENT_VERTICES = 128
MAX_MEASUREMENT_SAMPLES = 128
TARGET_MEASUREMENT_SAMPLE_SPACING_METERS = 250
PORTAL_CONFIGURATION_SCHEMA_VERSION = "opengeo.portal-configuration.1.0.0"
SPATIAL_BODY_SCHEMA_VERSION = "opengeo.spatial-body.1.0.0"

_SPATIAL_BODIES: dict[str, dict[str, Any]] = {
    "earth": {
        "schemaVersion": SPATIAL_BODY_SCHEMA_VERSION,
        "id": "earth",
        "title": "Earth",
        "coordinateSystem": "wgs84-longitude-latitude-degrees",
        "rendererProjection": "web-mercator-angular",
        "rendererBounds": [-180, -85.05112878, 180, 85.05112878],
        "ellipsoid": {
            "semiMajorAxisMeters": 6_378_137,
            "inverseFlattening": 298.257223563,
        },
        "measurement": {
            "model": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
        },
        "camera": {"model": "maplibre-angular-zoom", "physicalAltitude": False},
    },
    "moon": {
        "schemaVersion": SPATIAL_BODY_SCHEMA_VERSION,
        "id": "moon",
        "title": "Moon",
        "coordinateSystem": "east-positive-longitude-planetocentric-latitude-degrees",
        "rendererProjection": "web-mercator-angular",
        "rendererBounds": [-180, -85.05112878, 180, 85.05112878],
        "ellipsoid": {"semiMajorAxisMeters": 1_737_400, "inverseFlattening": 0},
        "measurement": {
            "model": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
        },
        "camera": {"model": "maplibre-angular-zoom", "physicalAltitude": False},
    },
    "mars": {
        "schemaVersion": SPATIAL_BODY_SCHEMA_VERSION,
        "id": "mars",
        "title": "Mars",
        "coordinateSystem": "east-positive-longitude-planetocentric-latitude-degrees",
        "rendererProjection": "web-mercator-angular",
        "rendererBounds": [-180, -85.05112878, 180, 85.05112878],
        "ellipsoid": {
            "semiMajorAxisMeters": 3_396_190,
            "inverseFlattening": 169.894447,
        },
        "measurement": {
            "model": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
        },
        "camera": {"model": "maplibre-angular-zoom", "physicalAltitude": False},
    },
}

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
_SOURCE_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_XML_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$")
_PORTAL_SENSITIVE_NAME = re.compile(
    r"^(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|credential|client[-_]?secret|private[-_]?key|key)$",
    re.IGNORECASE,
)
_PORTAL_SENSITIVE_QUERY = re.compile(
    r"(?:api[-_]?key|access[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|signature|authorization|credential)",
    re.IGNORECASE,
)
_PROTOTYPE_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_SENSITIVE_KEYS = frozenset(
    {
        "accesskey",
        "accesskeyid",
        "accesstoken",
        "authorization",
        "clientsecret",
        "cookie",
        "credential",
        "credentials",
        "password",
        "passwd",
        "secret",
        "secretaccesskey",
        "sessiontoken",
        "token",
    }
)


@dataclass(frozen=True, slots=True)
class MapDatasetReference:
    dataset_id: UUID
    dataset_version_id: UUID | None = None
    dataset_version_number: int | None = None
    source_type: str | None = None
    source_version: int | None = None
    source_url: str | None = None
    source_configuration: dict[str, Any] | None = None


def validate_map_definition(
    definition: dict[str, Any],
    *,
    allow_import_references: bool = False,
    require_current: bool = False,
) -> dict[str, Any]:
    _validate_json_limits(definition)
    extensions = definition.get("extensions", {})
    if not isinstance(extensions, dict):
        raise ValueError("map definition extensions must be an object")
    if "opengeoRenderer" in extensions:
        renderer = extensions["opengeoRenderer"]
        if (
            not isinstance(renderer, dict)
            or set(renderer) != {"id"}
            or renderer["id"] not in ("maplibre", "mapbox", "cesium")
        ):
            raise ValueError("map renderer preference must contain only a supported id")
    schema_version = definition.get("schemaVersion")
    if schema_version is not None and schema_version not in {
        LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
        PROCESSING_MAP_DEFINITION_SCHEMA_VERSION,
        PATH_MAP_DEFINITION_SCHEMA_VERSION,
        MAP_DEFINITION_SCHEMA_VERSION,
        STYLE_MAP_DEFINITION_SCHEMA_VERSION,
    }:
        raise ValueError(
            "map definition schemaVersion must be "
            f"{MAP_DEFINITION_SCHEMA_VERSION} or readable legacy "
            f"{LEGACY_MAP_DEFINITION_SCHEMA_VERSION}"
        )
    if require_current and schema_version is None:
        raise ValueError("map definition schemaVersion is required for writes")
    if require_current and schema_version not in {
        MAP_DEFINITION_SCHEMA_VERSION,
        STYLE_MAP_DEFINITION_SCHEMA_VERSION,
    }:
        raise ValueError(
            f"map definition schemaVersion must be {MAP_DEFINITION_SCHEMA_VERSION} "
            f"or {STYLE_MAP_DEFINITION_SCHEMA_VERSION} for writes"
        )

    layers = definition.get("layers", [])
    if not isinstance(layers, list):
        raise ValueError("map definition layers must be an array")
    if len(layers) > MAX_MAP_LAYERS:
        raise ValueError(f"map definition exceeds {MAX_MAP_LAYERS} layers")

    for layer in layers:
        if isinstance(layer, dict) and "styleReference" in layer:
            if schema_version != STYLE_MAP_DEFINITION_SCHEMA_VERSION or allow_import_references:
                raise ValueError("styleReference requires native map definition 1.4.0")
            validate_map_style_reference(layer["styleReference"])
            if layer.get("datasetId") == "kml-places":
                raise ValueError("styleReference requires a governed dataset")

    # Definitions saved before the versioned contract remain readable and may be
    # resaved by the current client. New versioned writes use the complete rules.
    if schema_version is None:
        return definition

    required_fields = (
        "mapViews",
        "basemaps",
        "bookmarks",
        "activeLayerId",
        "projection",
        "colorMode",
        "layers",
    )
    missing_fields = [field for field in required_fields if field not in definition]
    if missing_fields:
        raise ValueError(f"map definition is missing required field {missing_fields[0]}")

    if schema_version in {
        PROCESSING_MAP_DEFINITION_SCHEMA_VERSION,
        PATH_MAP_DEFINITION_SCHEMA_VERSION,
        MAP_DEFINITION_SCHEMA_VERSION,
        STYLE_MAP_DEFINITION_SCHEMA_VERSION,
    }:
        processing_fields = ("activeProcessingModelId", "models", "processingHistory")
        missing_processing_fields = [
            field for field in processing_fields if field not in definition
        ]
        if missing_processing_fields:
            raise ValueError(
                f"map definition is missing required field {missing_processing_fields[0]}"
            )
        _validate_processing_state(definition)

    layer_ids: set[str] = set()
    for index, layer in enumerate(layers):
        _validate_layer(layer, index, layer_ids, allow_import_references)

    active_layer_id = definition.get("activeLayerId")
    if active_layer_id is not None and (
        not isinstance(active_layer_id, str) or active_layer_id not in layer_ids
    ):
        raise ValueError("activeLayerId must identify a saved layer")

    _validate_views(definition.get("mapViews", []))
    _validate_bounded_object_array(definition.get("bookmarks", []), "bookmarks", 100)
    spatial_body = _validate_spatial_body(definition.get("spatialBody"))
    if schema_version in {
        PATH_MAP_DEFINITION_SCHEMA_VERSION,
        MAP_DEFINITION_SCHEMA_VERSION,
        STYLE_MAP_DEFINITION_SCHEMA_VERSION,
    }:
        if "measurements" not in definition:
            raise ValueError("map definition is missing required field measurements")
        _validate_path_measurements(
            definition.get("measurements"),
            spatial_body,
            allow_area=schema_version
            in {MAP_DEFINITION_SCHEMA_VERSION, STYLE_MAP_DEFINITION_SCHEMA_VERSION},
        )
    _validate_basemaps(definition.get("basemaps", []), spatial_body)
    if definition.get("portal") is not None:
        _validate_portal_configuration(definition["portal"])
        _validate_portal_layer_bindings(definition)
    elif any(layer.get("portalCatalogSource") is not None for layer in layers):
        raise ValueError("portalCatalogSource requires a portal configuration")

    projection = definition.get("projection")
    if projection is not None and projection not in {"mercator", "globe"}:
        raise ValueError("projection must be mercator or globe")
    color_mode = definition.get("colorMode")
    if color_mode is not None and color_mode not in {"light", "dark"}:
        raise ValueError("colorMode must be light or dark")
    return definition


def map_basemap_connection_references(definition: dict[str, Any]) -> tuple[UUID, ...]:
    references: list[UUID] = []
    for basemap in definition.get("basemaps", []):
        if not isinstance(basemap, dict) or basemap.get("kind") not in {
            "provider-style",
            "provider-raster",
        }:
            continue
        try:
            references.append(UUID(str(basemap.get("connectionBindingId"))))
        except (TypeError, ValueError, AttributeError):
            continue
    return tuple(references)


def map_dataset_references(definition: dict[str, Any]) -> tuple[MapDatasetReference, ...]:
    references: list[MapDatasetReference] = []
    records = [
        *definition.get("layers", []),
        *(
            basemap
            for basemap in definition.get("basemaps", [])
            if isinstance(basemap, dict) and basemap.get("kind") == "governed-raster"
        ),
    ]
    for record in records:
        if not isinstance(record, dict):
            continue
        raw_dataset_id = record.get("datasetId")
        try:
            dataset_id = UUID(str(raw_dataset_id))
        except (TypeError, ValueError, AttributeError):
            continue
        source_type = _external_source_type(record.get("sourceType"))
        raw_dataset_version_id = record.get("datasetVersionId")
        dataset_version_id = (
            UUID(str(raw_dataset_version_id)) if raw_dataset_version_id is not None else None
        )
        dataset_version_number = (
            cast(int, record.get("sourceVersion")) if dataset_version_id is not None else None
        )
        if source_type is None:
            references.append(
                MapDatasetReference(
                    dataset_id=dataset_id,
                    dataset_version_id=dataset_version_id,
                    dataset_version_number=dataset_version_number,
                )
            )
            continue
        references.append(
            MapDatasetReference(
                dataset_id=dataset_id,
                source_type=source_type,
                source_version=cast(int, record.get("sourceVersion")),
                source_url=cast(str, record.get("sourceUrl")),
                source_configuration=cast(dict[str, Any], record.get("sourceConfiguration")),
            )
        )
    return tuple(references)


def _validate_basemaps(value: Any, spatial_body: dict[str, Any]) -> None:
    _validate_bounded_object_array(value, "basemaps", 16)
    planetary_ids: list[str] = []
    visible_planetary_ids: list[str] = []
    visible_non_planetary = False
    for index, basemap in enumerate(value):
        if basemap.get("kind") == "planetary-blank":
            body_id = _validate_planetary_blank_basemap(basemap, index)
            planetary_ids.append(body_id)
            if basemap.get("visible") is True:
                visible_planetary_ids.append(body_id)
            continue
        if basemap.get("visible") is True:
            visible_non_planetary = True
        if basemap.get("kind") == "governed-raster":
            _validate_governed_raster_basemap(basemap, index)
            continue
        if basemap.get("kind") not in {"provider-style", "provider-raster"}:
            _reject_unbound_basemap_credentials(basemap, index)
            continue
        label = f"map definition basemap {index + 1}"
        required = {
            "basemapId",
            "title",
            "kind",
            "provider",
            "connectionBindingId",
            "flavor",
            "attribution",
            "visible",
            "opacity",
        }
        if set(basemap) != required:
            raise ValueError(f"{label} provider basemap fields are invalid")
        provider = basemap.get("provider")
        kind = basemap.get("kind")
        if (provider, kind) not in {
            ("protomaps", "provider-style"),
            ("carto", "provider-raster"),
        }:
            raise ValueError(f"{label} provider is invalid")
        flavor = basemap.get("flavor")
        flavors = (
            {"light", "dark", "white", "grayscale", "black"}
            if provider == "protomaps"
            else {"voyager", "positron", "dark-matter"}
        )
        if flavor not in flavors:
            raise ValueError(f"{label} flavor is invalid")
        try:
            binding_id = UUID(str(basemap.get("connectionBindingId")))
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"{label} connectionBindingId is invalid") from error
        expected_id = f"provider-{provider}-{binding_id}-{flavor}"
        if basemap.get("basemapId") != expected_id:
            raise ValueError(f"{label} basemapId does not match its binding and flavor")
        title = basemap.get("title")
        attribution = basemap.get("attribution")
        if (
            not isinstance(title, str)
            or title != title.strip()
            or not 1 <= len(title) <= 240
            or not isinstance(attribution, str)
            or attribution != attribution.strip()
            or not 1 <= len(attribution) <= 500
        ):
            raise ValueError(f"{label} presentation text is invalid")
        if not isinstance(basemap.get("visible"), bool):
            raise ValueError(f"{label} visibility is invalid")
        opacity = basemap.get("opacity")
        if (
            isinstance(opacity, bool)
            or not isinstance(opacity, int | float)
            or not math.isfinite(opacity)
            or not 0 <= opacity <= 1
        ):
            raise ValueError(f"{label} opacity is invalid")
    if planetary_ids and set(planetary_ids) != {spatial_body["id"]}:
        raise ValueError("map definition planetary basemap must match spatialBody")
    if spatial_body["id"] != "earth" and (
        planetary_ids != [spatial_body["id"]] or visible_planetary_ids != [spatial_body["id"]]
    ):
        raise ValueError(
            "a non-Earth spatialBody requires exactly one visible matching planetary basemap"
        )
    if spatial_body["id"] != "earth" and visible_non_planetary:
        raise ValueError("a non-Earth spatialBody cannot display an Earth basemap")


def _validate_spatial_body(value: Any) -> dict[str, Any]:
    if value is None:
        return _SPATIAL_BODIES["earth"]
    if not isinstance(value, dict):
        raise ValueError("map definition spatialBody must be an object")
    body_id = value.get("id")
    expected = _SPATIAL_BODIES.get(body_id) if isinstance(body_id, str) else None
    if expected is None or value != expected:
        raise ValueError("map definition spatialBody must match the OpenGeo body registry")
    return expected


def _validate_planetary_blank_basemap(basemap: dict[str, Any], index: int) -> str:
    label = f"map definition basemap {index + 1}"
    required = {
        "basemapId",
        "title",
        "kind",
        "spatialBodyId",
        "attribution",
        "visible",
        "opacity",
    }
    if set(basemap) != required:
        raise ValueError(f"{label} planetary blank fields are invalid")
    body_id = basemap.get("spatialBodyId")
    if not isinstance(body_id, str) or body_id not in {"moon", "mars"}:
        raise ValueError(f"{label} spatialBodyId is invalid")
    if basemap.get("basemapId") != f"planetary-blank-{body_id}":
        raise ValueError(f"{label} basemapId does not match its spatial body")
    for field, maximum in (("title", 240), ("attribution", 500)):
        text = basemap.get(field)
        if not isinstance(text, str) or text != text.strip() or not 1 <= len(text) <= maximum:
            raise ValueError(f"{label} {field} is invalid")
    if not isinstance(basemap.get("visible"), bool):
        raise ValueError(f"{label} visibility is invalid")
    opacity = basemap.get("opacity")
    if not _finite_number(opacity) or not 0 <= float(opacity) <= 1:
        raise ValueError(f"{label} opacity is invalid")
    return body_id


def _validate_governed_raster_basemap(basemap: dict[str, Any], index: int) -> None:
    label = f"map definition basemap {index + 1}"
    required = {
        "basemapId",
        "title",
        "kind",
        "datasetId",
        "sourceType",
        "sourceVersion",
        "sourceUrl",
        "sourceConfiguration",
        "attribution",
        "visible",
        "opacity",
    }
    if set(basemap) != required:
        raise ValueError(f"{label} governed raster fields are invalid")
    try:
        dataset_id = UUID(str(basemap.get("datasetId")))
    except (TypeError, ValueError, AttributeError) as error:
        raise ValueError(f"{label} datasetId must be a governed UUID") from error
    version = basemap.get("sourceVersion")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError(f"{label} sourceVersion must be a positive integer")
    if basemap.get("sourceType") != "xyz-raster":
        raise ValueError(f"{label} sourceType must be xyz-raster")
    expected_id = f"governed-xyz-{dataset_id}-v{version}"
    if basemap.get("basemapId") != expected_id:
        raise ValueError(f"{label} basemapId does not match its source revision")
    source_url = basemap.get("sourceUrl")
    if (
        not isinstance(source_url, str)
        or not source_url.startswith("https://")
        or len(source_url) > 2048
        or "\\" in source_url
        or any(ord(character) < 32 or ord(character) == 127 for character in source_url)
    ):
        raise ValueError(f"{label} sourceUrl must be bounded HTTPS")
    configuration = basemap.get("sourceConfiguration")
    required_configuration = {
        "minZoom",
        "maxZoom",
        "tileSize",
        "scheme",
        "attribution",
        "presentationRole",
        "license",
        "coverageBounds",
        "coordinateBehavior",
    }
    if not isinstance(configuration, dict) or set(configuration) != required_configuration:
        raise ValueError(f"{label} sourceConfiguration is invalid")
    if configuration.get("presentationRole") != "regional_basemap":
        raise ValueError(f"{label} presentationRole is invalid")
    if configuration.get("coordinateBehavior") != "wgs84_web_mercator":
        raise ValueError(f"{label} coordinate behavior requires a supported transform")
    for field, maximum in (("attribution", 1000), ("license", 500)):
        text = configuration.get(field)
        if not isinstance(text, str) or text != text.strip() or not 1 <= len(text) <= maximum:
            raise ValueError(f"{label} {field} is invalid")
    if basemap.get("attribution") != configuration.get("attribution"):
        raise ValueError(f"{label} attribution does not match its source revision")
    title = basemap.get("title")
    if not isinstance(title, str) or title != title.strip() or not 1 <= len(title) <= 240:
        raise ValueError(f"{label} title is invalid")
    coverage = configuration.get("coverageBounds")
    if (
        not isinstance(coverage, list)
        or len(coverage) != 4
        or any(not _finite_number(coordinate) for coordinate in coverage)
        or not -180 <= float(coverage[0]) < float(coverage[2]) <= 180
        or not -90 <= float(coverage[1]) < float(coverage[3]) <= 90
    ):
        raise ValueError(f"{label} coverageBounds are invalid")
    min_zoom = configuration.get("minZoom")
    max_zoom = configuration.get("maxZoom")
    if (
        isinstance(min_zoom, bool)
        or isinstance(max_zoom, bool)
        or not isinstance(min_zoom, int)
        or not isinstance(max_zoom, int)
        or not 0 <= min_zoom <= max_zoom <= 24
        or configuration.get("tileSize") not in {256, 512}
        or configuration.get("scheme") not in {"xyz", "tms"}
    ):
        raise ValueError(f"{label} XYZ render configuration is invalid")
    if not isinstance(basemap.get("visible"), bool):
        raise ValueError(f"{label} visibility is invalid")
    opacity = basemap.get("opacity")
    if not _finite_number(opacity) or not 0 <= float(opacity) <= 1:
        raise ValueError(f"{label} opacity is invalid")


def _reject_unbound_basemap_credentials(basemap: dict[str, Any], index: int) -> None:
    label = f"map definition basemap {index + 1}"
    for field in ("url", "styleUrl", "style_url"):
        value = basemap.get(field)
        if not isinstance(value, str):
            continue
        parsed = urlsplit(value)
        if (
            parsed.username is not None
            or parsed.password is not None
            or re.search(
                r"(^|\.)(protomaps\.com|cartocdn\.com|mapbox\.com)$",
                parsed.hostname or "",
                re.IGNORECASE,
            )
            or any(
                _PORTAL_SENSITIVE_NAME.fullmatch(key) or _PORTAL_SENSITIVE_QUERY.search(key)
                for key, _ in parse_qsl(parsed.query, keep_blank_values=True)
            )
        ):
            raise ValueError(f"{label} must use a reusable provider connection")


def external_map_configuration(source_type: str, configuration: dict[str, Any]) -> dict[str, Any]:
    if source_type == "cog":
        return {
            "serviceKind": "cog", "bands": configuration.get("bands"),
            "bounds": configuration.get("bounds"),
            "sizeBytes": configuration.get("size_bytes"),
            "attribution": configuration.get("attribution"),
            "license": configuration.get("license"),
            "referenceMetadata": configuration.get("reference_metadata"),
        }
    if source_type == "mapserver":
        return {
            "serviceKind": "mapserver",
            "layerIds": configuration.get("layer_ids"),
            "tileSize": configuration.get("tile_size"),
            "imageFormat": configuration.get("image_format"),
            "minZoom": configuration.get("min_zoom"),
            "maxZoom": configuration.get("max_zoom"),
            "attribution": configuration.get("attribution"),
        }
    if source_type == "imageserver":
        snapshot = {
            "serviceKind": "imageserver",
            "tileSize": configuration.get("tile_size"),
            "imageFormat": configuration.get("image_format"),
            "interpolation": configuration.get("interpolation"),
            "bandIds": configuration.get("band_ids"),
            "minZoom": configuration.get("min_zoom"),
            "maxZoom": configuration.get("max_zoom"),
            "attribution": configuration.get("attribution"),
        }
        if configuration.get("raster_ids"):
            snapshot["rasterIds"] = configuration["raster_ids"]
        return snapshot
    if source_type == "xyz":
        snapshot = {
            "minZoom": configuration.get("min_zoom"),
            "maxZoom": configuration.get("max_zoom"),
            "tileSize": configuration.get("tile_size"),
            "scheme": configuration.get("scheme"),
            "attribution": configuration.get("attribution"),
        }
        if configuration.get("presentation_role") is not None:
            snapshot.update(
                {
                    "presentationRole": configuration.get("presentation_role"),
                    "license": configuration.get("license"),
                    "coverageBounds": configuration.get("coverage_bounds"),
                    "coordinateBehavior": configuration.get("coordinate_behavior"),
                }
            )
        return snapshot
    if source_type == "wms":
        return {
            "version": configuration.get("version"),
            "layers": configuration.get("layers"),
            "styles": configuration.get("styles"),
            "imageFormat": configuration.get("format"),
            "transparent": configuration.get("transparent"),
            "crs": configuration.get("crs"),
            "tileSize": configuration.get("tile_size"),
            "attribution": configuration.get("attribution"),
        }
    if source_type == "pmtiles":
        return {
            "tileType": configuration.get("tile_type"),
            "sourceLayer": configuration.get("source_layer"),
            "geometryType": configuration.get("geometry_type"),
            "minZoom": configuration.get("min_zoom"),
            "maxZoom": configuration.get("max_zoom"),
            "attribution": configuration.get("attribution"),
        }
    if source_type == "geojson":
        return {
            "contentEncoding": configuration.get("content_encoding"),
            "objectSha256": configuration.get("object_sha256"),
            "decodedSha256": configuration.get("decoded_sha256"),
            "sizeBytes": configuration.get("size_bytes"),
            "decodedSizeBytes": configuration.get("decoded_size_bytes"),
            "featureCount": configuration.get("feature_count"),
            "geometryType": configuration.get("geometry_type"),
            "bounds": configuration.get("bounds"),
            "attribution": configuration.get("attribution"),
            "license": configuration.get("license"),
            "authoritativeUrl": configuration.get("authoritative_url"),
            "rightsUrl": configuration.get("rights_url"),
        }
    raise ValueError("unsupported external map source type")


def _validate_json_limits(definition: dict[str, Any]) -> None:
    try:
        encoded = json.dumps(
            definition,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (RecursionError, TypeError, ValueError) as error:
        raise ValueError("map definition must be finite JSON") from error
    if len(encoded) > MAX_MAP_DEFINITION_BYTES:
        raise ValueError("map definition exceeds 256 KiB")

    nodes = 0
    pending: list[tuple[Any, int]] = [(definition, 0)]
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if nodes > MAX_MAP_DEFINITION_NODES:
            raise ValueError("map definition contains too many values")
        if depth > MAX_MAP_DEFINITION_DEPTH:
            raise ValueError("map definition nesting is too deep")
        if isinstance(value, dict):
            for key, child in value.items():
                if not isinstance(key, str) or not key or len(key) > 256:
                    raise ValueError("map definition contains an invalid object key")
                normalized = key.lower().replace("-", "").replace("_", "")
                if key.lower() in _PROTOTYPE_KEYS:
                    raise ValueError("map definition contains a forbidden object key")
                if normalized in _SENSITIVE_KEYS:
                    raise ValueError("map definitions must not contain credentials")
                pending.append((child, depth + 1))
        elif isinstance(value, list):
            pending.extend((child, depth + 1) for child in value)


def _validate_layer(
    layer: Any, index: int, layer_ids: set[str], allow_import_references: bool
) -> None:
    label = f"map definition layer {index + 1}"
    if not isinstance(layer, dict):
        raise ValueError(f"{label} must be an object")
    layer_id = layer.get("layerId")
    if not isinstance(layer_id, str) or _IDENTIFIER.fullmatch(layer_id) is None:
        raise ValueError(f"{label} layerId is invalid")
    if layer_id in layer_ids:
        raise ValueError("map definition layerId values must be unique")
    layer_ids.add(layer_id)

    title = layer.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 240:
        raise ValueError(f"{label} title is invalid")
    source_type = layer.get("sourceType")
    if not isinstance(source_type, str) or _SOURCE_TYPE.fullmatch(source_type) is None:
        raise ValueError(f"{label} sourceType is invalid")

    dataset_id = layer.get("datasetId")
    import_reference = (
        allow_import_references and isinstance(dataset_id, str) and dataset_id.startswith("import:")
    )
    if dataset_id == "kml-places":
        if source_type != "kml-places":
            raise ValueError("kml-places must use the kml-places source type")
    elif import_reference:
        pass
    else:
        try:
            UUID(str(dataset_id))
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"{label} datasetId must be a governed UUID") from error

    dataset_version_id = layer.get("datasetVersionId")
    if dataset_version_id is not None:
        try:
            UUID(str(dataset_version_id))
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"{label} datasetVersionId must be a governed UUID") from error
        source_version = layer.get("sourceVersion")
        if source_type != "governed-dataset":
            raise ValueError(f"{label} datasetVersionId requires governed-dataset sourceType")
        if (
            isinstance(source_version, bool)
            or not isinstance(source_version, int)
            or source_version < 1
        ):
            raise ValueError(f"{label} sourceVersion must identify the dataset version number")

    object_id = layer.get("objectId")
    if object_id is not None and not (
        allow_import_references
        and isinstance(object_id, str)
        and object_id.startswith("pending-import:")
    ):
        try:
            UUID(str(object_id))
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError(f"{label} objectId must be a governed UUID") from error

    shared_source_id = layer.get("sharedSourceId")
    if shared_source_id is not None and (
        not isinstance(shared_source_id, str) or _IDENTIFIER.fullmatch(shared_source_id) is None
    ):
        raise ValueError(f"{label} sharedSourceId is invalid")

    visible = layer.get("visible")
    if not isinstance(visible, bool):
        raise ValueError(f"{label} visible must be boolean")
    opacity_mode = layer.get("opacityMode", "feature")
    if opacity_mode not in ("feature", "composite"):
        raise ValueError(f"{label} opacity blending is invalid")
    if opacity_mode == "composite" and (
        layer.get("geometryType")
        not in ("LineString", "MultiLineString", "Polygon", "MultiPolygon")
        or source_type
        not in ("governed-dataset", "geojson-object", "arcgis-feature-layer-snapshot")
    ):
        raise ValueError(f"{label} composite opacity requires supported line or polygon data")
    opacity = layer.get("opacity")
    if not _finite_number(opacity) or not 0 <= float(opacity) <= 1:
        raise ValueError(f"{label} opacity must be between 0 and 1")
    order = layer.get("order")
    if (
        isinstance(order, bool)
        or not isinstance(order, int)
        or not -1_000_000 <= order <= 1_000_000
    ):
        raise ValueError(f"{label} order is invalid")
    for field in ("style", "labels"):
        if not isinstance(layer.get(field), dict):
            raise ValueError(f"{label} {field} must be an object")
    if layer["labels"].get("drawOrder", "with-layer") not in ("with-layer", "above-data"):
        raise ValueError("invalid label drawing order")
    if "filter" in layer:
        validate_map_filter(layer["filter"])
    if "fontRef" in layer["labels"]:
        validate_render_font_reference(layer["labels"]["fontRef"])

    bbox = layer.get("bbox")
    if bbox is not None and (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or any(not _finite_number(value) for value in bbox)
        or float(bbox[0]) > float(bbox[2])
        or float(bbox[1]) > float(bbox[3])
    ):
        raise ValueError(f"{label} bbox is invalid")

    external_type = _external_source_type(source_type)
    if external_type is not None:
        version = layer.get("sourceVersion")
        url = layer.get("sourceUrl")
        configuration = layer.get("sourceConfiguration")
        if not (import_reference and version is None) and (
            isinstance(version, bool) or not isinstance(version, int) or version < 1
        ):
            raise ValueError(f"{label} sourceVersion must be a positive integer")
        if (
            not isinstance(url, str)
            or not url.startswith("https://")
            or len(url) > 2048
            or "\\" in url
            or any(ord(character) < 32 or ord(character) == 127 for character in url)
        ):
            raise ValueError(f"{label} sourceUrl must be bounded HTTPS")
        if not isinstance(configuration, dict):
            raise ValueError(f"{label} sourceConfiguration must be an object")

    portal_catalog_source = layer.get("portalCatalogSource")
    if portal_catalog_source is not None and (
        not isinstance(portal_catalog_source, str)
        or not portal_catalog_source
        or len(portal_catalog_source) > 320
    ):
        raise ValueError(f"{label} portalCatalogSource is invalid")


def _external_source_type(source_type: Any) -> str | None:
    if source_type == "cog-raster":
        return "cog"
    if source_type == "mapserver-raster":
        return "mapserver"
    if source_type == "imageserver-raster":
        return "imageserver"
    if source_type == "xyz-raster":
        return "xyz"
    if source_type == "wms-raster":
        return "wms"
    if source_type in {"pmtiles-vector", "pmtiles-raster"}:
        return "pmtiles"
    if source_type == "geojson-archive":
        return "geojson"
    return None


def _validate_views(value: Any) -> None:
    _validate_bounded_object_array(value, "mapViews", 8)
    for index, view in enumerate(value):
        center = view.get("center")
        if (
            not isinstance(center, list)
            or len(center) != 2
            or any(not _finite_number(coordinate) for coordinate in center)
            or not -180 <= float(center[0]) <= 180
            or not -90 <= float(center[1]) <= 90
        ):
            raise ValueError(f"map view {index + 1} center is invalid")
        zoom = view.get("zoom")
        if not _finite_number(zoom) or not -2 <= float(zoom) <= 24:
            raise ValueError(f"map view {index + 1} zoom is invalid")
        for field, minimum, maximum in (("pitch", 0, 85), ("bearing", -360, 360)):
            camera_value = view.get(field, 0)
            if not _finite_number(camera_value) or not minimum <= float(camera_value) <= maximum:
                raise ValueError(f"map view {index + 1} {field} is invalid")


def _validate_bounded_object_array(value: Any, field: str, maximum: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"{field} must be an array of at most {maximum} objects")
    if any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{field} must contain only objects")
    return cast(list[dict[str, Any]], value)


def _validate_path_measurements(
    value: Any, spatial_body: dict[str, Any], *, allow_area: bool = False
) -> None:
    measurements = _validate_bounded_object_array(value, "path measurements", MAX_PATH_MEASUREMENTS)
    measurement_ids: set[str] = set()
    for index, measurement in enumerate(measurements):
        label = f"measurement {index + 1}"
        measurement_id = measurement.get("id")
        if (
            not isinstance(measurement_id, str)
            or _IDENTIFIER.fullmatch(measurement_id) is None
            or measurement_id in measurement_ids
        ):
            raise ValueError(f"{label} id is invalid or duplicated")
        measurement_ids.add(measurement_id)
        if measurement.get("kind") in {"polygon-area", "circle-area"}:
            if not allow_area:
                raise ValueError(f"{label} kind is not available in this schema version")
            _validate_area_measurement(measurement, spatial_body, label)
            continue
        required = {
            "schemaVersion",
            "id",
            "title",
            "kind",
            "spatialBodyId",
            "measurementModel",
            "distanceUnit",
            "coordinates",
            "horizontalDistanceMeters",
            "terrainProfile",
        }
        if set(measurement) != required:
            raise ValueError(f"{label} fields are invalid")
        if (
            measurement.get("schemaVersion") != "opengeo.path-measurement.1.0.0"
            or measurement.get("kind") != "path-profile"
            or measurement.get("spatialBodyId") != spatial_body["id"]
            or measurement.get("measurementModel") != spatial_body["measurement"]["model"]
            or measurement.get("distanceUnit") != "meter"
        ):
            raise ValueError(f"{label} identity is invalid")
        _validate_processing_text(measurement.get("title"), 200, f"{label} title")
        coordinates = _validate_measurement_coordinates(measurement.get("coordinates"), label)
        horizontal = _path_distance_meters(coordinates, spatial_body)
        if not _close_measurement_number(measurement.get("horizontalDistanceMeters"), horizontal):
            raise ValueError(f"{label} horizontal distance is invalid")
        _validate_terrain_profile(
            measurement.get("terrainProfile"),
            coordinates,
            horizontal,
            spatial_body,
            label,
        )


def _validate_area_measurement(
    measurement: dict[str, Any], spatial_body: dict[str, Any], label: str
) -> None:
    common = {
        "schemaVersion",
        "id",
        "title",
        "kind",
        "spatialBodyId",
        "measurementModel",
        "distanceUnit",
        "areaUnit",
    }
    kind = measurement.get("kind")
    required = common | (
        {"coordinates", "perimeterMeters", "areaSquareMeters"}
        if kind == "polygon-area"
        else {
            "center",
            "radiusPoint",
            "radiusMeters",
            "circumferenceMeters",
            "areaSquareMeters",
        }
    )
    if set(measurement) != required:
        raise ValueError(f"{label} fields are invalid")
    if (
        measurement.get("schemaVersion") != "opengeo.area-measurement.1.0.0"
        or measurement.get("spatialBodyId") != spatial_body["id"]
        or measurement.get("measurementModel") != spatial_body["measurement"]["model"]
        or measurement.get("distanceUnit") != "meter"
        or measurement.get("areaUnit") != "square-meter"
    ):
        raise ValueError(f"{label} identity is invalid")
    _validate_processing_text(measurement.get("title"), 200, f"{label} title")
    if kind == "polygon-area":
        coordinates = _validate_polygon_measurement_coordinates(
            measurement.get("coordinates"), label
        )
        perimeter = sum(
            _spatial_body_distance_meters(
                coordinates[index], coordinates[(index + 1) % len(coordinates)], spatial_body
            )
            for index in range(len(coordinates))
        )
        area = _spherical_polygon_area_square_meters(coordinates, spatial_body)
        _validate_area_magnitude(perimeter, area, label)
        if not _close_measurement_number(measurement.get("perimeterMeters"), perimeter):
            raise ValueError(f"{label} perimeter is invalid")
    else:
        center = _validate_measurement_coordinate(measurement.get("center"), label)
        radius_point = _validate_measurement_coordinate(measurement.get("radiusPoint"), label)
        body_radius = _spatial_body_mean_radius_meters(spatial_body)
        radius = _spatial_body_distance_meters(center, radius_point, spatial_body)
        angular_radius = radius / body_radius
        circumference = 2 * math.pi * body_radius * math.sin(angular_radius)
        area = 2 * math.pi * body_radius**2 * (1 - math.cos(angular_radius))
        _validate_area_magnitude(radius, area, label)
        if (
            not math.isfinite(circumference)
            or not 0 < circumference <= 2_000_000_000
            or not _close_measurement_number(measurement.get("radiusMeters"), radius)
            or not _close_measurement_number(measurement.get("circumferenceMeters"), circumference)
        ):
            raise ValueError(f"{label} circle dimensions are invalid")
    if not _close_area_number(measurement.get("areaSquareMeters"), area):
        raise ValueError(f"{label} area is invalid")


def _validate_polygon_measurement_coordinates(value: Any, label: str) -> list[list[float]]:
    if not isinstance(value, list) or not 3 <= len(value) <= MAX_MEASUREMENT_VERTICES:
        raise ValueError(f"{label} polygon coordinates are invalid")
    coordinates = [_validate_measurement_coordinate(item, label) for item in value]
    if (
        len({(item[0], item[1]) for item in coordinates}) != len(coordinates)
        or max(item[0] for item in coordinates) - min(item[0] for item in coordinates) > 180
        or _polygon_measurement_self_intersects(coordinates)
    ):
        raise ValueError(f"{label} polygon geometry is invalid")
    return coordinates


def _polygon_measurement_self_intersects(coordinates: list[list[float]]) -> bool:
    edges = [
        (coordinates[index], coordinates[(index + 1) % len(coordinates)])
        for index in range(len(coordinates))
    ]
    for first in range(len(edges)):
        for second in range(first + 1, len(edges)):
            if second == first + 1 or (first == 0 and second == len(edges) - 1):
                continue
            if _measurement_segments_intersect(*edges[first], *edges[second]):
                return True
    return False


def _measurement_segments_intersect(
    first_start: list[float],
    first_end: list[float],
    second_start: list[float],
    second_end: list[float],
) -> bool:
    def orientation(start: list[float], end: list[float], point: list[float]) -> float:
        return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (
            point[0] - start[0]
        )

    first = orientation(first_start, first_end, second_start)
    second = orientation(first_start, first_end, second_end)
    third = orientation(second_start, second_end, first_start)
    fourth = orientation(second_start, second_end, first_end)
    return first * second <= 0 and third * fourth <= 0


def _spherical_polygon_area_square_meters(
    coordinates: list[list[float]], spatial_body: dict[str, Any]
) -> float:
    origin = _measurement_unit_vector(coordinates[0])
    signed_excess = 0.0
    for index in range(1, len(coordinates) - 1):
        second = _measurement_unit_vector(coordinates[index])
        third = _measurement_unit_vector(coordinates[index + 1])
        determinant = _measurement_dot(origin, _measurement_cross(second, third))
        denominator = (
            1
            + _measurement_dot(origin, second)
            + _measurement_dot(second, third)
            + _measurement_dot(third, origin)
        )
        signed_excess += 2 * math.atan2(determinant, denominator)
    radius = _spatial_body_mean_radius_meters(spatial_body)
    full_sphere = 4 * math.pi * radius**2
    raw_area = abs(signed_excess) * radius**2
    return full_sphere - raw_area if raw_area > full_sphere / 2 else raw_area


def _measurement_unit_vector(coordinate: list[float]) -> tuple[float, float, float]:
    longitude = math.radians(coordinate[0])
    latitude = math.radians(coordinate[1])
    return (
        math.cos(latitude) * math.cos(longitude),
        math.cos(latitude) * math.sin(longitude),
        math.sin(latitude),
    )


def _measurement_cross(
    first: tuple[float, float, float], second: tuple[float, float, float]
) -> tuple[float, float, float]:
    return (
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
    )


def _measurement_dot(
    first: tuple[float, float, float], second: tuple[float, float, float]
) -> float:
    return sum(left * right for left, right in zip(first, second, strict=True))


def _validate_area_magnitude(distance: float, area: float, label: str) -> None:
    if not math.isfinite(distance) or not 0 < distance <= 2_000_000_000:
        raise ValueError(f"{label} distance is invalid")
    if not math.isfinite(area) or not 0 < area <= 1_000_000_000_000_000:
        raise ValueError(f"{label} area is invalid")


def _validate_measurement_coordinates(value: Any, label: str) -> list[list[float]]:
    if not isinstance(value, list) or not 2 <= len(value) <= MAX_MEASUREMENT_VERTICES:
        raise ValueError(f"{label} coordinates are invalid")
    coordinates: list[list[float]] = []
    for coordinate in value:
        coordinates.append(_validate_measurement_coordinate(coordinate, label))
    return coordinates


def _validate_measurement_coordinate(value: Any, label: str) -> list[float]:
    if (
        not isinstance(value, list)
        or len(value) != 2
        or any(not _finite_number(item) for item in value)
        or not -180 <= float(value[0]) <= 180
        or not -85.05112878 <= float(value[1]) <= 85.05112878
    ):
        raise ValueError(f"{label} coordinate is invalid")
    return [float(value[0]), float(value[1])]


def _validate_terrain_profile(
    value: Any,
    coordinates: list[list[float]],
    horizontal_distance: float,
    spatial_body: dict[str, Any],
    label: str,
) -> None:
    required = {"status", "source", "samples", "summary"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError(f"{label} terrain profile fields are invalid")
    status = value.get("status")
    if status not in {"complete", "partial", "unavailable"}:
        raise ValueError(f"{label} terrain profile status is invalid")
    _validate_measurement_terrain_source(value.get("source"), status, label)
    samples = value.get("samples")
    if not isinstance(samples, list) or not 2 <= len(samples) <= MAX_MEASUREMENT_SAMPLES:
        raise ValueError(f"{label} terrain samples are invalid")
    expected_samples = _measurement_sample_axis(coordinates, spatial_body, horizontal_distance)
    if len(samples) != len(expected_samples):
        raise ValueError(f"{label} terrain sample inventory is invalid")
    normalized_samples: list[tuple[float, list[float], float | None]] = []
    previous_distance = -1.0
    for sample, (expected_distance, expected_coordinate) in zip(
        samples, expected_samples, strict=True
    ):
        if not isinstance(sample, dict) or set(sample) != {
            "distanceMeters",
            "coordinate",
            "elevationMeters",
        }:
            raise ValueError(f"{label} terrain sample fields are invalid")
        distance = sample.get("distanceMeters")
        if (
            not _finite_number(distance)
            or float(distance) < previous_distance
            or float(distance) < 0
        ):
            raise ValueError(f"{label} terrain sample distance is invalid")
        sample_coordinate = _validate_measurement_coordinate(sample.get("coordinate"), label)
        if not _same_measurement_coordinate(sample_coordinate, expected_coordinate) or not (
            _close_measurement_number(distance, expected_distance)
        ):
            raise ValueError(f"{label} terrain sample axis is invalid")
        elevation = sample.get("elevationMeters")
        if elevation is not None and (
            not _finite_number(elevation)
            or float(elevation) == -32_768
            or abs(float(elevation)) > 100_000
        ):
            raise ValueError(f"{label} terrain sample elevation is invalid")
        previous_distance = float(distance)
        normalized_samples.append(
            (
                float(distance),
                sample_coordinate,
                None if elevation is None else float(elevation),
            )
        )
    if (
        not _same_measurement_coordinate(normalized_samples[0][1], coordinates[0])
        or not _same_measurement_coordinate(normalized_samples[-1][1], coordinates[-1])
        or not _close_measurement_number(normalized_samples[-1][0], horizontal_distance)
    ):
        raise ValueError(f"{label} terrain sample endpoints are invalid")
    elevations = [sample[2] for sample in normalized_samples if sample[2] is not None]
    expected_status = (
        "complete"
        if len(elevations) == len(normalized_samples)
        else "partial"
        if elevations
        else "unavailable"
    )
    if status != expected_status:
        raise ValueError(f"{label} terrain profile status does not match its samples")
    expected_summary = _measurement_summary(normalized_samples)
    summary = value.get("summary")
    if not isinstance(summary, dict) or set(summary) != set(expected_summary):
        raise ValueError(f"{label} terrain summary fields are invalid")
    for field, expected in expected_summary.items():
        actual = summary.get(field)
        if expected is None:
            if actual is not None:
                raise ValueError(f"{label} terrain summary {field} is invalid")
        elif not _close_measurement_number(actual, expected):
            raise ValueError(f"{label} terrain summary {field} is invalid")


def _validate_measurement_terrain_source(value: Any, status: str, label: str) -> None:
    if status == "unavailable":
        if value is not None:
            raise ValueError(f"{label} unavailable terrain profile must not name a source")
        return
    required = {"sourceId", "provider", "queryMode", "termsUrl", "observedAt"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError(f"{label} terrain source fields are invalid")
    source_id = value.get("sourceId")
    if not isinstance(source_id, str) or _IDENTIFIER.fullmatch(source_id) is None:
        raise ValueError(f"{label} terrain source id is invalid")
    _validate_processing_text(value.get("provider"), 120, f"{label} terrain provider")
    if value.get("queryMode") != "renderer-unexaggerated-point-sample":
        raise ValueError(f"{label} terrain query mode is invalid")
    terms_url = value.get("termsUrl")
    if not isinstance(terms_url, str) or len(terms_url) > 2_048:
        raise ValueError(f"{label} terrain terms URL is invalid")
    parsed = urlsplit(terms_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError(f"{label} terrain terms URL is invalid")
    observed_at = value.get("observedAt")
    if not isinstance(observed_at, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", observed_at) is None:
        raise ValueError(f"{label} terrain observedAt is invalid")


def _measurement_summary(
    samples: list[tuple[float, list[float], float | None]],
) -> dict[str, float | None]:
    elevations = [sample[2] for sample in samples if sample[2] is not None]
    if len(elevations) != len(samples):
        return {
            "threeDimensionalDistanceMeters": None,
            "minimumElevationMeters": min(elevations) if elevations else None,
            "maximumElevationMeters": max(elevations) if elevations else None,
            "ascentMeters": None,
            "descentMeters": None,
        }
    distance_3d = 0.0
    ascent = 0.0
    descent = 0.0
    for previous, current in pairwise(samples):
        horizontal = current[0] - previous[0]
        vertical = cast(float, current[2]) - cast(float, previous[2])
        distance_3d += math.hypot(horizontal, vertical)
        if vertical > 0:
            ascent += vertical
        else:
            descent += abs(vertical)
    return {
        "threeDimensionalDistanceMeters": distance_3d,
        "minimumElevationMeters": min(elevations),
        "maximumElevationMeters": max(elevations),
        "ascentMeters": ascent,
        "descentMeters": descent,
    }


def _path_distance_meters(coordinates: list[list[float]], spatial_body: dict[str, Any]) -> float:
    distance = sum(
        _spatial_body_distance_meters(previous, current, spatial_body)
        for previous, current in pairwise(coordinates)
    )
    if not math.isfinite(distance) or not 0 < distance <= 2_000_000_000:
        raise ValueError("path measurement horizontal distance is invalid")
    return distance


def _measurement_sample_axis(
    coordinates: list[list[float]], spatial_body: dict[str, Any], total_distance: float
) -> list[tuple[float, list[float]]]:
    sample_count = min(
        MAX_MEASUREMENT_SAMPLES,
        max(2, math.ceil(total_distance / TARGET_MEASUREMENT_SAMPLE_SPACING_METERS) + 1),
    )
    segments: list[tuple[list[float], list[float], float, float]] = []
    cursor = 0.0
    for previous, current in pairwise(coordinates):
        length = _spatial_body_distance_meters(previous, current, spatial_body)
        segments.append((previous, current, cursor, cursor + length))
        cursor += length
    sample_coordinates: list[list[float]] = []
    for index in range(sample_count):
        target = total_distance * index / (sample_count - 1)
        segment = next((item for item in segments if target <= item[3]), segments[-1])
        start, end, segment_start, segment_end = segment
        ratio = (
            0.0
            if segment_end == segment_start
            else ((target - segment_start) / (segment_end - segment_start))
        )
        ratio = max(0.0, min(1.0, ratio))
        longitude_delta = (end[0] - start[0] + 540) % 360 - 180
        longitude = start[0] + longitude_delta * ratio
        if longitude > 180:
            longitude -= 360
        if longitude < -180:
            longitude += 360
        sample_coordinates.append(
            [round(longitude, 9), round(start[1] + (end[1] - start[1]) * ratio, 9)]
        )
    sample_coordinates[0] = list(coordinates[0])
    sample_coordinates[-1] = list(coordinates[-1])
    samples: list[tuple[float, list[float]]] = []
    distance = 0.0
    for index, coordinate in enumerate(sample_coordinates):
        if index > 0:
            distance += _spatial_body_distance_meters(
                sample_coordinates[index - 1], coordinate, spatial_body
            )
        samples.append((distance, coordinate))
    samples[-1] = (total_distance, samples[-1][1])
    return samples


def _spatial_body_distance_meters(
    first: list[float], second: list[float], spatial_body: dict[str, Any]
) -> float:
    radius = _spatial_body_mean_radius_meters(spatial_body)
    latitude_delta = math.radians(second[1] - first[1])
    longitude_delta = math.radians(second[0] - first[0])
    first_latitude = math.radians(first[1])
    second_latitude = math.radians(second[1])
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(first_latitude) * math.cos(second_latitude) * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * radius * math.asin(min(1, math.sqrt(haversine)))


def _spatial_body_mean_radius_meters(spatial_body: dict[str, Any]) -> float:
    semi_major = float(spatial_body["ellipsoid"]["semiMajorAxisMeters"])
    inverse_flattening = float(spatial_body["ellipsoid"]["inverseFlattening"])
    radius = semi_major
    if inverse_flattening > 0:
        polar = semi_major * (1 - 1 / inverse_flattening)
        radius = (2 * semi_major + polar) / 3
    return radius


def _same_measurement_coordinate(first: list[float], second: list[float]) -> bool:
    return all(abs(left - right) <= 1e-9 for left, right in zip(first, second, strict=True))


def _close_measurement_number(value: Any, expected: float) -> bool:
    return _finite_number(value) and abs(float(value) - expected) <= 0.01


def _close_area_number(value: Any, expected: float) -> bool:
    return _finite_number(value) and abs(float(value) - expected) <= 0.1


def _validate_processing_state(definition: dict[str, Any]) -> None:
    models = _validate_bounded_object_array(
        definition.get("models"), "processing models", MAX_PROCESSING_MODELS
    )
    model_ids: set[str] = set()
    for model_index, model in enumerate(models):
        label = f"processing model {model_index + 1}"
        if set(model) != {"id", "name", "steps"}:
            raise ValueError(f"{label} fields are invalid")
        model_id = model.get("id")
        if not isinstance(model_id, str) or _IDENTIFIER.fullmatch(model_id) is None:
            raise ValueError(f"{label} id is invalid")
        if model_id in model_ids:
            raise ValueError("processing model ids must be unique")
        model_ids.add(model_id)
        _validate_processing_text(model.get("name"), 200, f"{label} name")
        steps = _validate_bounded_object_array(
            model.get("steps"), f"{label} steps", MAX_PROCESSING_MODEL_STEPS
        )
        if not steps:
            raise ValueError(f"{label} must contain at least one step")
        step_ids: set[str] = set()
        for step_index, step in enumerate(steps):
            step_label = f"{label} step {step_index + 1}"
            if set(step) - {"id", "toolId", "parameters", "inputParam"}:
                raise ValueError(f"{step_label} fields are invalid")
            if not {"id", "toolId", "parameters"}.issubset(step):
                raise ValueError(f"{step_label} is missing required fields")
            step_id = step.get("id")
            tool_id = step.get("toolId")
            if not isinstance(step_id, str) or _IDENTIFIER.fullmatch(step_id) is None:
                raise ValueError(f"{step_label} id is invalid")
            if step_id in step_ids:
                raise ValueError(f"{label} step ids must be unique")
            step_ids.add(step_id)
            if not isinstance(tool_id, str) or _IDENTIFIER.fullmatch(tool_id) is None:
                raise ValueError(f"{step_label} toolId is invalid")
            if not isinstance(step.get("parameters"), dict):
                raise ValueError(f"{step_label} parameters must be an object")
            if step.get("inputParam") is not None and (
                not isinstance(step["inputParam"], str)
                or _IDENTIFIER.fullmatch(step["inputParam"]) is None
            ):
                raise ValueError(f"{step_label} inputParam is invalid")

    active_model_id = definition.get("activeProcessingModelId")
    if active_model_id is not None and (
        not isinstance(active_model_id, str) or active_model_id not in model_ids
    ):
        raise ValueError("activeProcessingModelId must identify a saved processing model")

    history = _validate_bounded_object_array(
        definition.get("processingHistory"),
        "processing history",
        MAX_PROCESSING_HISTORY,
    )
    history_ids: set[str] = set()
    allowed_history_fields = {
        "id",
        "kind",
        "toolId",
        "toolName",
        "engine",
        "parameters",
        "inputLayerNames",
        "outputLayerNames",
        "startedAt",
        "durationMs",
        "status",
        "error",
        "opengeo",
    }
    required_history_fields = {
        "id",
        "kind",
        "toolId",
        "toolName",
        "engine",
        "parameters",
        "status",
    }
    for history_index, entry in enumerate(history):
        label = f"processing history entry {history_index + 1}"
        if set(entry) - allowed_history_fields or not required_history_fields.issubset(entry):
            raise ValueError(f"{label} fields are invalid")
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or _IDENTIFIER.fullmatch(entry_id) is None:
            raise ValueError(f"{label} id is invalid")
        if entry_id in history_ids:
            raise ValueError("processing history ids must be unique")
        history_ids.add(entry_id)
        for field, maximum in (
            ("kind", 40),
            ("toolId", 160),
            ("toolName", 200),
            ("engine", 80),
        ):
            _validate_processing_text(entry.get(field), maximum, f"{label} {field}")
        if entry.get("status") not in {"success", "error"}:
            raise ValueError(f"{label} status is invalid")
        if not isinstance(entry.get("parameters"), dict):
            raise ValueError(f"{label} parameters must be an object")
        if entry.get("startedAt") is not None:
            _validate_processing_text(entry["startedAt"], 40, f"{label} startedAt")
        duration = entry.get("durationMs")
        if duration is not None and (
            not _finite_number(duration) or not 0 <= float(duration) <= 86_400_000
        ):
            raise ValueError(f"{label} durationMs is invalid")
        if entry.get("error") is not None:
            _validate_processing_text(entry["error"], 500, f"{label} error")
        if entry.get("inputLayerNames") is not None:
            _validate_processing_layer_names(entry["inputLayerNames"], label)
        if entry.get("outputLayerNames") is not None:
            names = entry["outputLayerNames"]
            if not isinstance(names, list) or len(names) > 16:
                raise ValueError(f"{label} outputLayerNames is invalid")
            for name in names:
                _validate_processing_text(name, 200, f"{label} output layer name")
        if entry.get("opengeo") is not None:
            _validate_processing_receipt_extension(entry["opengeo"], label)


def _validate_processing_layer_names(value: Any, label: str) -> None:
    if not isinstance(value, dict) or len(value) > 16:
        raise ValueError(f"{label} inputLayerNames is invalid")
    for layer_id, layer_name in value.items():
        if not isinstance(layer_id, str) or _IDENTIFIER.fullmatch(layer_id) is None:
            raise ValueError(f"{label} input layer id is invalid")
        _validate_processing_text(layer_name, 200, f"{label} input layer name")


def _validate_processing_receipt_extension(value: Any, label: str) -> None:
    required = {
        "schemaVersion",
        "toolVersion",
        "deterministic",
        "input",
        "output",
        "limits",
        "logs",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError(f"{label} OpenGeo receipt fields are invalid")
    if value.get("schemaVersion") != "opengeo.processing-run.1.0.0":
        raise ValueError(f"{label} OpenGeo receipt schemaVersion is invalid")
    tool_version = value.get("toolVersion")
    if (
        not isinstance(tool_version, str)
        or len(tool_version) > 40
        or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", tool_version) is None
    ):
        raise ValueError(f"{label} OpenGeo receipt toolVersion is invalid")
    if not isinstance(value.get("deterministic"), bool):
        raise ValueError(f"{label} OpenGeo receipt deterministic is invalid")
    for field in ("input", "output", "limits"):
        if not isinstance(value.get(field), dict):
            raise ValueError(f"{label} OpenGeo receipt {field} must be an object")
    logs = value.get("logs")
    if not isinstance(logs, list) or not 1 <= len(logs) <= 20:
        raise ValueError(f"{label} OpenGeo receipt logs are invalid")
    for log in logs:
        _validate_processing_text(log, 240, f"{label} OpenGeo receipt log")


def _validate_processing_text(value: Any, maximum: int, label: str) -> None:
    if (
        not isinstance(value, str)
        or not value.strip()
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 32 and character not in "\t\n\r" for character in value)
        or "\x7f" in value
    ):
        raise ValueError(f"{label} is invalid")


def _validate_portal_configuration(value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError("portal configuration must be an object")
    if value.get("schemaVersion") != PORTAL_CONFIGURATION_SCHEMA_VERSION:
        raise ValueError(
            f"portal configuration schemaVersion must be {PORTAL_CONFIGURATION_SCHEMA_VERSION}"
        )
    revision = value.get("revision")
    if (
        isinstance(revision, bool)
        or not isinstance(revision, int)
        or not 1 <= revision <= 1_000_000
    ):
        raise ValueError("portal configuration revision is invalid")
    required = {
        "schemaVersion",
        "revision",
        "sources",
        "catalog",
        "tools",
        "searches",
        "services",
        "locations",
        "theme",
    }
    if not required.issubset(value):
        raise ValueError("portal configuration is missing required fields")
    if set(value) - (required | {"upstream"}):
        raise ValueError("portal configuration contains unsupported fields")

    sources = _validate_bounded_object_array(value.get("sources"), "portal sources", 128)
    source_names: set[str] = set()
    xml_state = {"nodes": 0, "attributes": 0, "text": 0}
    for index, source in enumerate(sources):
        if set(source) != {"name", "type", "title", "element"}:
            raise ValueError("portal source fields are invalid")
        name = source.get("name")
        source_type = source.get("type")
        title = source.get("title")
        if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
            raise ValueError(f"portal source {index + 1} name is invalid")
        if name in source_names:
            raise ValueError("portal source names must be unique")
        source_names.add(name)
        if not isinstance(source_type, str) or _IDENTIFIER.fullmatch(source_type) is None:
            raise ValueError(f"portal source {index + 1} type is invalid")
        _validate_portal_text(title, 240, f"portal source {index + 1} title")
        _validate_portal_xml_node(source.get("element"), 0, xml_state)
        if source["element"].get("name") != "map-source":
            raise ValueError("portal source element must be map-source")
        element_attributes = source["element"].get("attributes", {})
        if element_attributes.get("name") != name or element_attributes.get("type") != source_type:
            raise ValueError("portal source identity must match its map-source element")

    catalog = _validate_bounded_object_array(value.get("catalog"), "portal catalog", 512)
    catalog_state = {"nodes": 0}
    for node in catalog:
        _validate_portal_catalog_node(node, 0, catalog_state)

    tools = _validate_bounded_object_array(value.get("tools"), "portal tools", 128)
    tool_state = {"nodes": 0}
    for node in tools:
        _validate_portal_tool_node(node, 0, tool_state)

    _validate_portal_named_records(value.get("searches"), "portal searches", 64, True)
    _validate_portal_named_records(value.get("services"), "portal services", 128, False)
    locations = _validate_bounded_object_array(value.get("locations"), "portal locations", 100)
    location_ids: set[str] = set()
    for location in locations:
        if set(location) != {"id", "title", "center", "zoom"}:
            raise ValueError("portal location fields are invalid")
        location_id = location.get("id")
        if not isinstance(location_id, str) or _IDENTIFIER.fullmatch(location_id) is None:
            raise ValueError("portal location id is invalid")
        if location_id in location_ids:
            raise ValueError("portal location ids must be unique")
        location_ids.add(location_id)
        _validate_portal_text(location.get("title"), 240, "portal location title")
        center = location.get("center")
        if (
            not isinstance(center, list)
            or len(center) != 2
            or any(not _finite_number(coordinate) for coordinate in center)
            or not -180 <= float(center[0]) <= 180
            or not -90 <= float(center[1]) <= 90
        ):
            raise ValueError("portal location center is invalid")
        zoom = location.get("zoom")
        if not _finite_number(zoom) or not -2 <= float(zoom) <= 24:
            raise ValueError("portal location zoom is invalid")

    theme = value.get("theme")
    if not isinstance(theme, dict) or set(theme) != {"id", "title", "colorMode"}:
        raise ValueError("portal theme is invalid")
    if not isinstance(theme.get("id"), str) or _IDENTIFIER.fullmatch(theme["id"]) is None:
        raise ValueError("portal theme id is invalid")
    _validate_portal_text(theme.get("title"), 240, "portal theme title")
    if theme.get("colorMode") not in {"light", "dark"}:
        raise ValueError("portal theme colorMode is invalid")

    upstream = value.get("upstream")
    if upstream is not None and upstream != {
        "product": "geomoose",
        "version": "3.15.2",
        "commit": "6eb12a80c9d379b5634126da6ad047071fa85b92",
    }:
        raise ValueError("portal upstream identity is invalid")


def _validate_portal_layer_bindings(definition: dict[str, Any]) -> None:
    portal = cast(dict[str, Any], definition["portal"])
    source_contracts: dict[str, tuple[str, dict[str, int]]] = {}
    for source in cast(list[dict[str, Any]], portal["sources"]):
        layers: dict[str, int] = {}
        for child in cast(list[dict[str, Any]], source["element"].get("children", [])):
            layer_name = (
                child.get("attributes", {}).get("name") if child.get("name") == "layer" else None
            )
            if isinstance(layer_name, str):
                layers[layer_name] = layers.get(layer_name, 0) + 1
        source_contracts[cast(str, source["name"])] = (cast(str, source["type"]), layers)
    references: set[str] = set()
    pending = list(cast(list[dict[str, Any]], definition["portal"]["catalog"]))
    while pending:
        node = pending.pop()
        if node.get("kind") == "layer" and isinstance(node.get("source"), str):
            references.add(cast(str, node["source"]))
        pending.extend(cast(list[dict[str, Any]], node.get("children", [])))

    bound: set[str] = set()
    for layer in cast(list[dict[str, Any]], definition["layers"]):
        reference = layer.get("portalCatalogSource")
        if reference is None:
            continue
        if cast(str, reference) not in references:
            raise ValueError("portalCatalogSource must identify a configured catalog layer")
        if cast(str, reference) in bound:
            raise ValueError("portal catalog layers may be bound only once")
        external_type = _external_source_type(layer.get("sourceType"))
        if external_type is None:
            raise ValueError("portal catalog bindings require a governed external source")
        parts = cast(str, reference).split(";")
        if len(parts) != 1 or parts[0].count("/") != 1:
            raise ValueError("portal catalog binding source type does not match its configuration")
        source_name, layer_name = parts[0].split("/", 1)
        contract = source_contracts.get(source_name)
        if contract is None or contract[1].get(layer_name) != 1:
            raise ValueError(
                "portal catalog binding must resolve to one declared portal source layer"
            )
        if contract[0] != external_type:
            raise ValueError("portal catalog binding source type does not match its configuration")
        bound.add(cast(str, reference))


def _validate_portal_xml_node(value: Any, depth: int, state: dict[str, int]) -> None:
    if not isinstance(value, dict) or set(value) != {"name", "attributes", "text", "children"}:
        raise ValueError("portal XML node is invalid")
    if depth > 16:
        raise ValueError("portal XML nesting is too deep")
    state["nodes"] += 1
    if state["nodes"] > 4_000:
        raise ValueError("portal XML has too many elements")
    name = value.get("name")
    if not isinstance(name, str) or _XML_NAME.fullmatch(name) is None:
        raise ValueError("portal XML element name is invalid")
    attributes = value.get("attributes")
    if not isinstance(attributes, dict):
        raise ValueError("portal XML attributes are invalid")
    state["attributes"] += len(attributes)
    if state["attributes"] > 16_000:
        raise ValueError("portal XML has too many attributes")
    for key, attribute in attributes.items():
        if not isinstance(key, str) or _XML_NAME.fullmatch(key) is None:
            raise ValueError("portal XML attribute name is invalid")
        _validate_portal_text(attribute, 2_048, "portal XML attribute", allow_empty=True)
        if key in {"href", "url", "src"}:
            _validate_portal_url(attribute, "portal XML URL")
    if name == "param" and _PORTAL_SENSITIVE_NAME.fullmatch(str(attributes.get("name", ""))):
        raise ValueError("portal XML must not contain credential-like parameters")
    text = value.get("text")
    _validate_portal_text(text, 16_384, "portal XML text", allow_empty=True)
    if name == "url":
        _validate_portal_url(text, "portal XML URL")
    state["text"] += len(cast(str, text))
    if state["text"] > 131_072:
        raise ValueError("portal XML contains too much text")
    children = _validate_bounded_object_array(value.get("children"), "portal XML children", 4_000)
    for child in children:
        _validate_portal_xml_node(child, depth + 1, state)


def _validate_portal_catalog_node(value: Any, depth: int, state: dict[str, int]) -> None:
    if not isinstance(value, dict) or set(value) != {
        "kind",
        "title",
        "source",
        "attributes",
        "metadata",
        "children",
    }:
        raise ValueError("portal catalog node is invalid")
    if depth > 12:
        raise ValueError("portal catalog nesting is too deep")
    state["nodes"] += 1
    if state["nodes"] > 512:
        raise ValueError("portal catalog has too many nodes")
    if value.get("kind") not in {"group", "layer"}:
        raise ValueError("portal catalog kind is invalid")
    _validate_portal_text(value.get("title"), 240, "portal catalog title")
    source = value.get("source")
    if source is not None:
        _validate_portal_text(source, 320, "portal catalog source")
    _validate_portal_attributes(value.get("attributes"))
    metadata = value.get("metadata")
    if not isinstance(metadata, list) or len(metadata) > 16:
        raise ValueError("portal catalog metadata is invalid")
    for entry in metadata:
        _validate_portal_text(entry, 2_048, "portal catalog metadata", allow_empty=True)
    children = _validate_bounded_object_array(value.get("children"), "portal catalog children", 512)
    for child in children:
        _validate_portal_catalog_node(child, depth + 1, state)


def _validate_portal_tool_node(value: Any, depth: int, state: dict[str, int]) -> None:
    if not isinstance(value, dict) or set(value) != {
        "kind",
        "name",
        "title",
        "type",
        "tip",
        "href",
        "cssClass",
        "attributes",
        "children",
    }:
        raise ValueError("portal tool node is invalid")
    if depth > 8:
        raise ValueError("portal tool nesting is too deep")
    state["nodes"] += 1
    if state["nodes"] > 128:
        raise ValueError("portal configuration has too many tools")
    if value.get("kind") not in {"tool", "drawer"}:
        raise ValueError("portal tool kind is invalid")
    name = value.get("name")
    if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
        raise ValueError("portal tool name is invalid")
    _validate_portal_text(value.get("title"), 240, "portal tool title")
    _validate_portal_text(value.get("type"), 80, "portal tool type")
    for field, maximum in (("tip", 500), ("href", 2_048), ("cssClass", 160)):
        if value.get(field) is not None:
            _validate_portal_text(value[field], maximum, f"portal tool {field}")
    if value.get("href") is not None:
        _validate_portal_url(value["href"], "portal tool href")
    _validate_portal_attributes(value.get("attributes"))
    children = _validate_bounded_object_array(value.get("children"), "portal tool children", 128)
    for child in children:
        _validate_portal_tool_node(child, depth + 1, state)


def _validate_portal_named_records(
    value: Any, field: str, maximum: int, require_service: bool
) -> None:
    records = _validate_bounded_object_array(value, field, maximum)
    expected = {"name", "title", "service"} if require_service else {"name", "title"}
    names: set[str] = set()
    for item in records:
        if set(item) != expected:
            raise ValueError(f"{field} fields are invalid")
        name = item.get("name")
        if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
            raise ValueError(f"{field} name is invalid")
        if name in names:
            raise ValueError(f"{field} names must be unique")
        names.add(name)
        _validate_portal_text(item.get("title"), 240, f"{field} title")
        if require_service:
            service = item.get("service")
            if not isinstance(service, str) or _IDENTIFIER.fullmatch(service) is None:
                raise ValueError(f"{field} service is invalid")


def _validate_portal_attributes(value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError("portal attributes must be an object")
    for key, attribute in value.items():
        if not isinstance(key, str) or _XML_NAME.fullmatch(key) is None:
            raise ValueError("portal attribute name is invalid")
        _validate_portal_text(attribute, 2_048, "portal attribute", allow_empty=True)


def _validate_portal_text(
    value: Any, maximum: int, label: str, *, allow_empty: bool = False
) -> None:
    if (
        not isinstance(value, str)
        or (not allow_empty and not value.strip())
        or len(value) > maximum
        or any(ord(character) < 32 and character not in "\t\n\r" for character in value)
        or "\x7f" in value
    ):
        raise ValueError(f"{label} is invalid")


def _validate_portal_url(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.lower().startswith(("http://", "https://")):
        return
    try:
        parsed = urlsplit(value)
        query_keys = [key for key, _value in parse_qsl(parsed.query, keep_blank_values=True)]
    except ValueError as error:
        raise ValueError(f"{label} is invalid") from error
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or any(_PORTAL_SENSITIVE_QUERY.search(key) for key in query_keys)
    ):
        raise ValueError(f"{label} must not contain credentials or sensitive query fields")


def _finite_number(value: Any) -> TypeGuard[int | float]:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def validate_map_style_reference(value: Any) -> dict[str, Any]:
    fields = {"projectId", "resourceId", "styleId", "versionNumber", "checksumSha256", "format"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("styleReference must contain exactly its versioned identity fields")
    for field in ("projectId", "resourceId", "styleId"):
        if not isinstance(value[field], str):
            raise ValueError(f"styleReference {field} must be a UUID")
        try:
            parsed = UUID(value[field])
        except ValueError as error:
            raise ValueError(f"styleReference {field} must be a UUID") from error
        if str(parsed) != value[field]:
            raise ValueError(f"styleReference {field} must be a canonical UUID")
    version = value["versionNumber"]
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or not 1 <= version <= 9007199254740991
    ):
        raise ValueError("styleReference versionNumber must be a positive safe integer")
    if (
        not isinstance(value["checksumSha256"], str)
        or re.fullmatch(r"[0-9a-f]{64}", value["checksumSha256"]) is None
    ):
        raise ValueError("styleReference checksumSha256 must be a SHA-256 digest")
    if value["format"] not in ("maplibre", "geostyler", "sld_1_0", "sld_1_1", "mapserver_mapfile"):
        raise ValueError("styleReference format is unsupported")
    return value
