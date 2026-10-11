import json
import math
from typing import Any, cast

SPATIAL_PREVIEW_SCHEMA = "opengeo.spatial-preview.1.0.0"
MAX_SPATIAL_PREVIEW_BYTES = 4 * 1024 * 1024
MAX_SPATIAL_PREVIEW_FEATURES = 5_000
MAX_SPATIAL_PREVIEW_POSITIONS = 200_000
MAX_SPATIAL_PREVIEW_JSON_NODES = 400_000


class SpatialPreviewInvalid(ValueError):
    pass


class _Budget:
    def __init__(self) -> None:
        self.positions = 0
        self.nodes = 0

    def node(self, count: int = 1) -> None:
        self.nodes += count
        if self.nodes > MAX_SPATIAL_PREVIEW_JSON_NODES:
            raise SpatialPreviewInvalid("spatial_preview_invalid")

    def position(self) -> None:
        self.positions += 1
        if self.positions > MAX_SPATIAL_PREVIEW_POSITIONS:
            raise SpatialPreviewInvalid("spatial_preview_invalid")


def parse_spatial_preview(content: bytes) -> dict[str, Any]:
    """Parse the exact bounded RFC 7946 derivative emitted by the GIS worker."""
    if not 1 <= len(content) <= MAX_SPATIAL_PREVIEW_BYTES:
        raise SpatialPreviewInvalid("spatial_preview_invalid")

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise SpatialPreviewInvalid("spatial_preview_invalid")
            result[key] = value
        return result

    try:
        raw = json.loads(
            content.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                SpatialPreviewInvalid("spatial_preview_invalid")
            ),
        )
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise SpatialPreviewInvalid("spatial_preview_invalid") from error
    if not isinstance(raw, dict) or len(raw) > 256:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    if raw.get("type") != "FeatureCollection":
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    name = raw.get("name")
    if name is not None and (
        not isinstance(name, str) or not 1 <= len(name) <= 300 or "\0" in name
    ):
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    if "bbox" in raw:
        _bbox(raw["bbox"])
    features = raw.get("features")
    if not isinstance(features, list) or len(features) > MAX_SPATIAL_PREVIEW_FEATURES:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    budget = _Budget()
    budget.node(len(features) + 1)
    preview_members = {"type", "name", "bbox", "features"}
    for key, value in raw.items():
        if key in preview_members:
            continue
        if (
            key in {"crs", "coordinates", "geometries", "geometry", "properties"}
            or not 1 <= len(key) <= 256
            or "\0" in key
        ):
            raise SpatialPreviewInvalid("spatial_preview_invalid")
        # RFC 7946 foreign members do not affect geometry or initiate reads.
        # Bound them with the same global JSON budget, then omit them from the
        # served preview. The exact archived source and provenance stay intact.
        _json_value(value, budget, 0)
    for feature in features:
        _feature(feature, budget)
    return {key: value for key, value in raw.items() if key in preview_members}


def _feature(value: object, budget: _Budget) -> None:
    if not isinstance(value, dict) or not set(value) <= {
        "type",
        "id",
        "bbox",
        "geometry",
        "properties",
    }:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    if value.get("type") != "Feature" or "geometry" not in value or "properties" not in value:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    budget.node()
    identifier = value.get("id")
    if identifier is not None and (
        isinstance(identifier, bool)
        or not isinstance(identifier, (str, int, float))
        or (
            isinstance(identifier, str)
            and (not identifier or len(identifier) > 512 or "\0" in identifier)
        )
        or (isinstance(identifier, (int, float)) and not math.isfinite(identifier))
    ):
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    if "bbox" in value:
        _bbox(value["bbox"])
    geometry = value["geometry"]
    if geometry is not None:
        _geometry(geometry, budget, 0)
    properties = value["properties"]
    if properties is None:
        return
    if not isinstance(properties, dict) or len(properties) > 256:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    for key, item in properties.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 256 or "\0" in key:
            raise SpatialPreviewInvalid("spatial_preview_invalid")
        _json_value(item, budget, 0)


def _geometry(value: object, budget: _Budget, depth: int) -> None:
    if (
        depth > 2
        or not isinstance(value, dict)
        or not set(value) <= {"type", "bbox", "coordinates", "geometries"}
    ):
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    kind = value.get("type")
    if kind not in {
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
        "GeometryCollection",
    }:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    budget.node()
    if "bbox" in value:
        _bbox(value["bbox"])
    if kind == "GeometryCollection":
        if (
            set(value) - {"type", "bbox", "geometries"}
            or not isinstance(value.get("geometries"), list)
            or len(cast(list[object], value["geometries"])) > 64
        ):
            raise SpatialPreviewInvalid("spatial_preview_invalid")
        for geometry in cast(list[object], value["geometries"]):
            _geometry(geometry, budget, depth + 1)
        return
    if set(value) - {"type", "bbox", "coordinates"} or "coordinates" not in value:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    coordinates = value["coordinates"]
    if kind == "Point":
        _position(coordinates, budget)
    elif kind in {"MultiPoint", "LineString"}:
        _positions(coordinates, budget, 1 if kind == "MultiPoint" else 2)
    elif kind in {"MultiLineString", "Polygon"}:
        _position_groups(coordinates, budget, closed=kind == "Polygon")
    else:
        if not isinstance(coordinates, list) or len(coordinates) > 4_096:
            raise SpatialPreviewInvalid("spatial_preview_invalid")
        for group in coordinates:
            _position_groups(group, budget, closed=kind == "MultiPolygon")


def _position_groups(value: object, budget: _Budget, *, closed: bool) -> None:
    if not isinstance(value, list) or len(value) > 4_096:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    for positions in value:
        _positions(positions, budget, 4 if closed else 2, closed=closed)


def _positions(value: object, budget: _Budget, minimum: int, *, closed: bool = False) -> None:
    if not isinstance(value, list) or not minimum <= len(value) <= MAX_SPATIAL_PREVIEW_POSITIONS:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    for position in value:
        _position(position, budget)
    if closed and value[0][:2] != value[-1][:2]:
        raise SpatialPreviewInvalid("spatial_preview_invalid")


def _position(value: object, budget: _Budget) -> None:
    if (
        not isinstance(value, list)
        or len(value) not in {2, 3}
        or any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value)
        or any(not math.isfinite(item) for item in value)
        or not -180 <= value[0] <= 180
        or not -90 <= value[1] <= 90
    ):
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    budget.position()


def _bbox(value: object) -> None:
    # RFC 7946 section 5.2 permits west > east when a box crosses the
    # antimeridian. Latitude, and altitude when present, still increase from
    # the southwest/lower position to the northeast/upper position.
    if not isinstance(value, list) or len(value) not in {4, 6}:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    dimensions = len(value) // 2
    if (
        any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value)
        or any(not math.isfinite(item) for item in value)
        or not -180 <= value[0] <= 180
        or not -180 <= value[dimensions] <= 180
        or not -90 <= value[1] <= 90
        or not -90 <= value[dimensions + 1] <= 90
        or value[1] > value[dimensions + 1]
        or (dimensions == 3 and value[2] > value[5])
    ):
        raise SpatialPreviewInvalid("spatial_preview_invalid")


def _json_value(value: object, budget: _Budget, depth: int) -> None:
    if depth > 8:
        raise SpatialPreviewInvalid("spatial_preview_invalid")
    budget.node()
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(value):
            return
    elif isinstance(value, str):
        if len(value) <= 8_192 and "\0" not in value:
            return
    elif isinstance(value, list) and len(value) <= 1_024:
        for item in value:
            _json_value(item, budget, depth + 1)
        return
    elif isinstance(value, dict) and len(value) <= 256:
        for key, item in value.items():
            if not isinstance(key, str) or not 1 <= len(key) <= 256 or "\0" in key:
                break
            _json_value(item, budget, depth + 1)
        else:
            return
    raise SpatialPreviewInvalid("spatial_preview_invalid")
