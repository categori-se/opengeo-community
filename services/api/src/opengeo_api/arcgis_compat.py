"""Bounded ArcGIS REST representations for governed feature collections."""

import json
import math
import re
from hashlib import sha256
from typing import Any, cast
from uuid import UUID

from opengeo_api.features import FeatureField, FeaturePage, FeatureRecord

ARCGIS_MAX_FEATURES = 100
ARCGIS_MAX_QUERY_BYTES = 8_192
ARCGIS_WEB_MERCATOR_WKIDS = frozenset({3857, 102100, 102113})
ARCGIS_CRS84_WKID = 4326
WEB_MERCATOR_LIMIT = 20_037_508.342789244
_CALLBACK = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]{0,63}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,63}){0,3}$")
_FIELD_TYPES = {
    "string": "esriFieldTypeString",
    "integer": "esriFieldTypeInteger",
    "number": "esriFieldTypeDouble",
    "boolean": "esriFieldTypeSmallInteger",
    "group": "esriFieldTypeString",
}
_GEOMETRY_TYPES = {
    "Point": "esriGeometryPoint",
    "MultiPoint": "esriGeometryMultipoint",
    "LineString": "esriGeometryPolyline",
    "MultiLineString": "esriGeometryPolyline",
    "Polygon": "esriGeometryPolygon",
    "MultiPolygon": "esriGeometryPolygon",
}
_RESERVED_FIELDS = frozenset({"objectid", "opengeo_feature_id", "opengeo_version"})


class ArcgisCompatibilityError(ValueError):
    """A fail-closed error in the declared ArcGIS compatibility profile."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def validate_callback(value: str | None) -> str | None:
    if value is not None and (len(value) > 256 or _CALLBACK.fullmatch(value) is None):
        raise ArcgisCompatibilityError("arcgis_callback_invalid")
    return value


def parse_wkid(value: str, *, field: str, allowed: frozenset[int]) -> int:
    try:
        wkid = int(value)
    except ValueError as error:
        raise ArcgisCompatibilityError(f"arcgis_{field}_invalid") from error
    if wkid not in allowed:
        raise ArcgisCompatibilityError(f"arcgis_{field}_unsupported")
    return wkid


def parse_spatial_reference(value: str, *, expected_wkid: int) -> None:
    if len(value.encode("utf8")) > 256:
        raise ArcgisCompatibilityError("arcgis_spatial_reference_too_large")
    try:
        document = json.loads(value)
    except json.JSONDecodeError as error:
        raise ArcgisCompatibilityError("arcgis_spatial_reference_invalid") from error
    if not isinstance(document, dict) or set(document) != {"wkid"}:
        raise ArcgisCompatibilityError("arcgis_spatial_reference_invalid")
    if document["wkid"] != expected_wkid:
        raise ArcgisCompatibilityError("arcgis_spatial_reference_mismatch")


def parse_envelope(value: str, *, in_wkid: int) -> tuple[float, float, float, float]:
    if len(value.encode("utf8")) > 512:
        raise ArcgisCompatibilityError("arcgis_geometry_too_large")
    try:
        document = json.loads(value)
    except json.JSONDecodeError as error:
        raise ArcgisCompatibilityError("arcgis_geometry_invalid") from error
    if not isinstance(document, dict) or set(document) != {"xmin", "ymin", "xmax", "ymax"}:
        raise ArcgisCompatibilityError("arcgis_geometry_invalid")
    values = tuple(document[name] for name in ("xmin", "ymin", "xmax", "ymax"))
    if any(
        not isinstance(item, int | float)
        or isinstance(item, bool)
        or not math.isfinite(float(item))
        for item in values
    ):
        raise ArcgisCompatibilityError("arcgis_geometry_invalid")
    west, south, east, north = (float(item) for item in values)
    if not west < east or not south < north:
        raise ArcgisCompatibilityError("arcgis_geometry_invalid")
    if in_wkid in ARCGIS_WEB_MERCATOR_WKIDS:
        if any(not -WEB_MERCATOR_LIMIT <= item <= WEB_MERCATOR_LIMIT for item in values):
            raise ArcgisCompatibilityError("arcgis_geometry_outside_world")
        west, south = web_mercator_to_lon_lat(west, south)
        east, north = web_mercator_to_lon_lat(east, north)
    elif in_wkid == ARCGIS_CRS84_WKID:
        if not -180 <= west < east <= 180 or not -90 <= south < north <= 90:
            raise ArcgisCompatibilityError("arcgis_geometry_outside_world")
    else:
        raise ArcgisCompatibilityError("arcgis_in_sr_unsupported")
    return west, south, east, north


def parse_object_ids(value: str | None) -> tuple[int, ...] | None:
    if value is None:
        return None
    if not value or len(value.encode("ascii", errors="ignore")) != len(value) or len(value) > 2_000:
        raise ArcgisCompatibilityError("arcgis_object_ids_invalid")
    parts = value.split(",")
    if len(parts) > ARCGIS_MAX_FEATURES:
        raise ArcgisCompatibilityError("arcgis_object_ids_limit_exceeded")
    try:
        identifiers = tuple(int(item) for item in parts)
    except ValueError as error:
        raise ArcgisCompatibilityError("arcgis_object_ids_invalid") from error
    if any(item <= 0 or item > (1 << 48) for item in identifiers):
        raise ArcgisCompatibilityError("arcgis_object_ids_invalid")
    if len(set(identifiers)) != len(identifiers):
        raise ArcgisCompatibilityError("arcgis_object_ids_duplicate")
    return identifiers


def arcgis_object_id(feature_id: UUID) -> int:
    """Return one deterministic JSON-safe opaque OID; the UUID remains explicit in attributes."""
    return int.from_bytes(sha256(feature_id.bytes).digest()[:6], "big") + 1


def feature_ids_document(page: FeaturePage) -> dict[str, Any]:
    object_ids = _object_ids(page.features)
    return {
        "objectIdFieldName": "OBJECTID",
        "objectIds": list(object_ids),
        "exceededTransferLimit": page.number_matched > len(page.features),
    }


def feature_page_document(
    page: FeaturePage,
    *,
    out_wkid: int,
    object_ids: tuple[int, ...],
) -> dict[str, Any]:
    if any(field.name.casefold() in _RESERVED_FIELDS for field in page.collection.fields):
        raise ArcgisCompatibilityError("arcgis_field_name_collision")
    identifiers = _object_ids(page.features)
    requested = set(object_ids)
    records = tuple(
        (identifier, record)
        for identifier, record in zip(identifiers, page.features, strict=True)
        if identifier in requested
    )
    fields = [
        _field("OBJECTID", "esriFieldTypeOID", nullable=False),
        _field("opengeo_feature_id", "esriFieldTypeString", nullable=False, length=36),
        _field("opengeo_version", "esriFieldTypeInteger", nullable=False),
        *(_feature_field(field) for field in page.collection.fields),
    ]
    return {
        "objectIdFieldName": "OBJECTID",
        "geometryType": _GEOMETRY_TYPES[page.collection.geometry_type],
        "spatialReference": spatial_reference(out_wkid),
        "fields": fields,
        "features": [
            {
                "attributes": {
                    "OBJECTID": identifier,
                    "opengeo_feature_id": str(record.feature_id),
                    "opengeo_version": record.version_number,
                    **{
                        key: (
                            int(value)
                            if isinstance(value, bool)
                            else json.dumps(
                                value,
                                ensure_ascii=False,
                                allow_nan=False,
                                separators=(",", ":"),
                                sort_keys=True,
                            )
                            if isinstance(value, dict | list)
                            else value
                        )
                        for key, value in record.properties.items()
                    },
                },
                "geometry": feature_geometry(record, out_wkid=out_wkid),
            }
            for identifier, record in records
        ],
        "exceededTransferLimit": page.number_matched > len(page.features),
    }


def spatial_reference(wkid: int) -> dict[str, int]:
    if wkid in ARCGIS_WEB_MERCATOR_WKIDS:
        return {"wkid": 102100, "latestWkid": 3857}
    if wkid == ARCGIS_CRS84_WKID:
        return {"wkid": 4326}
    raise ArcgisCompatibilityError("arcgis_out_sr_unsupported")


def feature_geometry(record: FeatureRecord, *, out_wkid: int) -> dict[str, Any]:
    geometry_type = record.geometry_type
    coordinates = record.geometry["coordinates"]
    reference = spatial_reference(out_wkid)
    if geometry_type == "Point":
        point = _point(coordinates, out_wkid)
        return {"x": point[0], "y": point[1], "spatialReference": reference}
    if geometry_type == "MultiPoint":
        return {
            "points": [_point(point, out_wkid) for point in coordinates],
            "spatialReference": reference,
        }
    if geometry_type == "LineString":
        return {
            "paths": [[_point(point, out_wkid) for point in coordinates]],
            "spatialReference": reference,
        }
    if geometry_type == "MultiLineString":
        return {
            "paths": [[_point(point, out_wkid) for point in path] for path in coordinates],
            "spatialReference": reference,
        }
    if geometry_type == "Polygon":
        return {
            "rings": [
                _arcgis_ring(ring, out_wkid, clockwise=index == 0)
                for index, ring in enumerate(coordinates)
            ],
            "spatialReference": reference,
        }
    if geometry_type == "MultiPolygon":
        return {
            "rings": [
                _arcgis_ring(ring, out_wkid, clockwise=index == 0)
                for polygon in coordinates
                for index, ring in enumerate(polygon)
            ],
            "spatialReference": reference,
        }
    raise ArcgisCompatibilityError("arcgis_geometry_type_unsupported")


def web_mercator_to_lon_lat(x: float, y: float) -> tuple[float, float]:
    longitude = x / WEB_MERCATOR_LIMIT * 180
    latitude = math.degrees(2 * math.atan(math.exp(y / WEB_MERCATOR_LIMIT * math.pi)) - math.pi / 2)
    return longitude, latitude


def lon_lat_to_web_mercator(longitude: float, latitude: float) -> tuple[float, float]:
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise ArcgisCompatibilityError("arcgis_coordinate_outside_world")
    bounded_latitude = max(-85.0511287798066, min(85.0511287798066, latitude))
    x = longitude * WEB_MERCATOR_LIMIT / 180
    y = (
        math.log(math.tan((90 + bounded_latitude) * math.pi / 360))
        / (math.pi / 180)
        * WEB_MERCATOR_LIMIT
        / 180
    )
    return x, y


def _point(value: Any, out_wkid: int) -> list[float]:
    if (
        not isinstance(value, list)
        or len(value) != 2
        or any(not isinstance(item, int | float) or isinstance(item, bool) for item in value)
    ):
        raise ArcgisCompatibilityError("arcgis_coordinate_invalid")
    longitude, latitude = cast(list[float], value)
    if out_wkid in ARCGIS_WEB_MERCATOR_WKIDS:
        return list(lon_lat_to_web_mercator(float(longitude), float(latitude)))
    if out_wkid == ARCGIS_CRS84_WKID:
        return [float(longitude), float(latitude)]
    raise ArcgisCompatibilityError("arcgis_out_sr_unsupported")


def _arcgis_ring(value: Any, out_wkid: int, *, clockwise: bool) -> list[list[float]]:
    if not isinstance(value, list):
        raise ArcgisCompatibilityError("arcgis_coordinate_invalid")
    ring = [_point(point, out_wkid) for point in value]
    signed_area = sum(
        (ring[index][0] * ring[index + 1][1]) - (ring[index + 1][0] * ring[index][1])
        for index in range(len(ring) - 1)
    )
    is_clockwise = signed_area < 0
    return list(reversed(ring)) if is_clockwise != clockwise else ring


def _object_ids(records: tuple[FeatureRecord, ...]) -> tuple[int, ...]:
    identifiers = tuple(arcgis_object_id(record.feature_id) for record in records)
    if len(set(identifiers)) != len(identifiers):
        raise ArcgisCompatibilityError("arcgis_object_id_collision")
    return identifiers


def _field(
    name: str,
    field_type: str,
    *,
    nullable: bool,
    length: int | None = None,
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "name": name,
        "alias": name,
        "type": field_type,
        "nullable": nullable,
        "editable": False,
    }
    if length is not None:
        document["length"] = length
    return document


def _feature_field(field: FeatureField) -> dict[str, Any]:
    return _field(
        field.name,
        _FIELD_TYPES[field.type],
        nullable=not field.required or field.visible_when is not None,
        length=32_768 if field.type == "group" else 2_000 if field.type == "string" else None,
    )
