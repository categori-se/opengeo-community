from __future__ import annotations

import base64
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit
from xml.etree import ElementTree

from opengeo_api.source_archiver import AnonymousSourceFetcher, SourceArchiveFailure

DiscoverySourceType = Literal["arcgis", "wfs"]
DiscoveryKind = Literal["catalog", "collection"]
GeometryType = Literal[
    "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]

_DISCOVERY_SCHEMA = "opengeo.external-source-discovery-result.1.0.0"
_OGC_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_ARCGIS_SERVICE_PATH = re.compile(r"/(?:FeatureServer|MapServer)/?$")
_ARCGIS_LAYER_REF = re.compile(r"^(?:0|[1-9][0-9]{0,4})$")
_XML_MEDIA = frozenset({"application/xml", "text/xml", "application/vnd.ogc.wfs_xml"})
_JSON_MEDIA = frozenset({"application/json"})
_MAXIMUM_DOCUMENT_BYTES = 2_097_152
_MAXIMUM_COLLECTIONS = 100
_MAXIMUM_FIELDS = 256
_MAXIMUM_JSON_NODES = 50_000
_MAXIMUM_XML_NODES = 20_000
_MAXIMUM_XML_DEPTH = 32


class SourceDiscoveryFailure(RuntimeError):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(code)


@dataclass(frozen=True, slots=True, repr=False)
class SourceDiscoverySpec:
    source_type: DiscoverySourceType
    kind: DiscoveryKind
    service_url: str
    collection_ref: str | None = None

    def __post_init__(self) -> None:
        _validate_spec(self)


@dataclass(frozen=True, slots=True)
class SourceDiscoveryResult:
    source_type: DiscoverySourceType
    kind: DiscoveryKind
    service_url: str
    collections: tuple[Mapping[str, Any], ...]
    source_definition: Mapping[str, Any] | None
    limitations: tuple[str, ...]
    source_document: dict[str, Any] | None = field(default=None, repr=False)
    source_body: bytes | None = field(default=None, repr=False)

    def json_value(self) -> dict[str, Any]:
        return {
            "schema_version": _DISCOVERY_SCHEMA,
            "source_type": self.source_type,
            "kind": self.kind,
            "service_url": self.service_url,
            "collections": [dict(item) for item in self.collections],
            "source_definition": (
                dict(self.source_definition) if self.source_definition is not None else None
            ),
            "limitations": list(self.limitations),
        }


class DiscoveryDocumentFetcher(Protocol):
    async def fetch_document(
        self,
        url: str,
        *,
        parameters: list[tuple[str, str]],
        accept: str,
        accepted_media_types: frozenset[str],
        maximum_bytes: int,
    ) -> bytes: ...


class SourceDiscoveryEngine:
    def __init__(self, fetcher: DiscoveryDocumentFetcher | None = None) -> None:
        self._fetcher = fetcher or AnonymousSourceFetcher(timeout_seconds=15.0)

    async def discover(self, spec: SourceDiscoverySpec) -> SourceDiscoveryResult:
        try:
            if spec.source_type == "arcgis":
                return await self._discover_arcgis(spec)
            return await self._discover_wfs(spec)
        except SourceArchiveFailure as error:
            raise SourceDiscoveryFailure(error.code, retryable=error.retryable) from error

    async def _discover_arcgis(self, spec: SourceDiscoverySpec) -> SourceDiscoveryResult:
        target = spec.service_url
        if spec.kind == "collection":
            assert spec.collection_ref is not None
            target = f"{target.rstrip('/')}/{spec.collection_ref}"
        body = await self._fetcher.fetch_document(
            target,
            parameters=[("f", "json")],
            accept="application/json",
            accepted_media_types=_JSON_MEDIA,
            maximum_bytes=_MAXIMUM_DOCUMENT_BYTES,
        )
        if spec.kind == "catalog":
            result = parse_arcgis_catalog(spec.service_url, body)
        else:
            assert spec.collection_ref is not None
            result = parse_arcgis_collection(spec.service_url, spec.collection_ref, body)
        return replace(result, source_document=retained_document(body), source_body=body)

    async def _discover_wfs(self, spec: SourceDiscoverySpec) -> SourceDiscoveryResult:
        parameters = [
            ("SERVICE", "WFS"),
            ("VERSION", "2.0.0"),
            ("REQUEST", "GetCapabilities" if spec.kind == "catalog" else "DescribeFeatureType"),
        ]
        if spec.kind == "collection":
            assert spec.collection_ref is not None
            parameters.append(("TYPENAMES", spec.collection_ref))
        body = await self._fetcher.fetch_document(
            spec.service_url,
            parameters=parameters,
            accept="application/xml, text/xml;q=0.9, application/vnd.ogc.wfs_xml;q=0.8",
            accepted_media_types=_XML_MEDIA,
            maximum_bytes=_MAXIMUM_DOCUMENT_BYTES,
        )
        if spec.kind == "catalog":
            result = parse_wfs_catalog(spec.service_url, body)
        else:
            assert spec.collection_ref is not None
            result = parse_wfs_collection(spec.service_url, spec.collection_ref, body)
        return replace(result, source_document=retained_document(body), source_body=body)


def parse_discovery_document(spec: SourceDiscoverySpec, body: bytes) -> SourceDiscoveryResult:
    """Reopen the first retained response without another provider request."""
    if not 1 <= len(body) <= _MAXIMUM_DOCUMENT_BYTES:
        raise SourceDiscoveryFailure("discovery_response_too_large")
    if spec.source_type == "arcgis":
        result = (
            parse_arcgis_catalog(spec.service_url, body)
            if spec.kind == "catalog"
            else parse_arcgis_collection(spec.service_url, spec.collection_ref or "", body)
        )
    else:
        result = (
            parse_wfs_catalog(spec.service_url, body)
            if spec.kind == "catalog"
            else parse_wfs_collection(spec.service_url, spec.collection_ref or "", body)
        )
    return replace(result, source_document=retained_document(body), source_body=body)


def retained_document(body: bytes) -> dict[str, Any]:
    """Keep exact response-body bytes, never reconstructed JSON/XML or a truncation."""
    retained = len(body) <= 32_768
    return {
        "status": "retained" if retained else "not_retained_size",
        "body_base64": base64.b64encode(body).decode("ascii") if retained else None,
        "byte_length": len(body),
        "sha256": sha256(body).hexdigest(),
        "retrieved_at": datetime.now(UTC).isoformat(),
    }


def parse_arcgis_catalog(service_url: str, body: bytes) -> SourceDiscoveryResult:
    payload = _json_document(body)
    _reject_arcgis_error(payload)
    raw_layers = payload.get("layers")
    if not isinstance(raw_layers, list) or not raw_layers:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    if len(raw_layers) > _MAXIMUM_COLLECTIONS:
        raise SourceDiscoveryFailure("discovery_response_too_large")
    collections: list[dict[str, Any]] = []
    identities: set[int] = set()
    for raw in raw_layers:
        if not isinstance(raw, dict) or raw.get("type") != "Feature Layer":
            continue
        layer_id = _bounded_integer(raw.get("id"), minimum=0, maximum=99_999)
        if layer_id in identities:
            raise SourceDiscoveryFailure("discovery_response_invalid")
        identities.add(layer_id)
        name = _bounded_text(raw.get("name"), 200)
        geometry = _arcgis_geometry(raw.get("geometryType"), required=False)
        collections.append(
            {
                "ref": str(layer_id),
                "name": name,
                "title": name,
                "geometry_type": geometry,
                "bounds": None,
            }
        )
    if not collections:
        raise SourceDiscoveryFailure("discovery_no_collections")
    return SourceDiscoveryResult(
        "arcgis",
        "catalog",
        service_url,
        tuple(collections),
        None,
        ("Select one layer to inspect its fields and stable identity.",),
    )


def parse_arcgis_collection(
    service_url: str,
    collection_ref: str,
    body: bytes,
) -> SourceDiscoveryResult:
    payload = _json_document(body)
    _reject_arcgis_error(payload)
    if payload.get("type") != "Feature Layer":
        raise SourceDiscoveryFailure("discovery_collection_unsupported")
    name = _bounded_text(payload.get("name"), 200)
    object_id_field = payload.get("objectIdField")
    if not isinstance(object_id_field, str) or _OGC_NAME.fullmatch(object_id_field) is None:
        raise SourceDiscoveryFailure("discovery_identity_unsupported")
    raw_fields = payload.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    if len(raw_fields) > _MAXIMUM_FIELDS:
        raise SourceDiscoveryFailure("discovery_response_too_large")
    advanced = payload.get("advancedQueryCapabilities")
    if (
        not isinstance(advanced, dict)
        or advanced.get("supportsPagination") is not True
        or advanced.get("supportsOrderBy") is not True
    ):
        raise SourceDiscoveryFailure("discovery_collection_unsupported")
    fields: list[str] = []
    excluded = 0
    identity_is_oid = False
    for raw in raw_fields:
        field_name = raw.get("name") if isinstance(raw, dict) else None
        if not isinstance(field_name, str) or _OGC_NAME.fullmatch(field_name) is None:
            excluded += 1
            continue
        if field_name in fields:
            raise SourceDiscoveryFailure("discovery_response_invalid")
        fields.append(field_name)
        if field_name == object_id_field and raw.get("type") == "esriFieldTypeOID":
            identity_is_oid = True
    if object_id_field not in fields or not identity_is_oid:
        raise SourceDiscoveryFailure("discovery_identity_unsupported")
    geometry = _arcgis_geometry(payload.get("geometryType"), required=True)
    page_size = payload.get("maxRecordCount", 1_000)
    if isinstance(page_size, bool) or not isinstance(page_size, int) or page_size < 1:
        page_size = 1_000
    page_size = min(page_size, 2_000)
    default_fields = fields if len(fields) <= 64 else [object_id_field]
    definition = {
        "type": "arcgis",
        "url": f"{service_url.rstrip('/')}/{collection_ref}",
        "object_id_field": object_id_field,
        "fields": default_fields,
        "available_fields": fields,
        "geometry_type": geometry,
        "page_size": page_size,
        "attribution": None,
        "requires_field_selection": len(fields) > 64,
        "excluded_field_count": excluded,
    }
    return SourceDiscoveryResult(
        "arcgis",
        "collection",
        service_url,
        (
            {
                "ref": collection_ref,
                "name": name,
                "title": name,
                "geometry_type": geometry,
                "bounds": None,
            },
        ),
        definition,
        (
            "The user must review fields, stable identity, rights, and attribution "
            "before registration.",
        ),
    )


def parse_wfs_catalog(service_url: str, body: bytes) -> SourceDiscoveryResult:
    root = _xml_document(body)
    if _local_name(root.tag) not in {"WFS_Capabilities", "ExceptionReport"}:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    if _local_name(root.tag) == "ExceptionReport":
        raise SourceDiscoveryFailure("discovery_upstream_rejected")
    version = root.attrib.get("version")
    if version != "2.0.0":
        raise SourceDiscoveryFailure("discovery_version_unsupported")
    collections: list[dict[str, Any]] = []
    identities: set[str] = set()
    for feature_type in (
        element for element in root.iter() if _local_name(element.tag) == "FeatureType"
    ):
        name = _child_text(feature_type, "Name", required=True)
        if _OGC_NAME.fullmatch(name) is None or name in identities:
            raise SourceDiscoveryFailure("discovery_response_invalid")
        identities.add(name)
        title = _child_text(feature_type, "Title", required=False) or name
        bounds = _wgs84_bounds(feature_type)
        collections.append(
            {
                "ref": name,
                "name": name,
                "title": title,
                "geometry_type": None,
                "bounds": bounds,
            }
        )
        if len(collections) > _MAXIMUM_COLLECTIONS:
            raise SourceDiscoveryFailure("discovery_response_too_large")
    if not collections:
        raise SourceDiscoveryFailure("discovery_no_collections")
    return SourceDiscoveryResult(
        "wfs",
        "catalog",
        service_url,
        tuple(collections),
        None,
        ("Select one feature type to inspect its schema and choose a stable sort field.",),
    )


def parse_wfs_collection(
    service_url: str,
    collection_ref: str,
    body: bytes,
) -> SourceDiscoveryResult:
    root = _xml_document(body)
    if _local_name(root.tag) == "ExceptionReport":
        raise SourceDiscoveryFailure("discovery_upstream_rejected")
    if _local_name(root.tag) != "schema":
        raise SourceDiscoveryFailure("discovery_response_invalid")
    local_ref = collection_ref.rsplit(":", 1)[-1]
    root_element = next(
        (
            element
            for element in root
            if _local_name(element.tag) == "element" and element.attrib.get("name") == local_ref
        ),
        None,
    )
    if root_element is None:
        raise SourceDiscoveryFailure("discovery_collection_missing")
    type_ref = root_element.attrib.get("type", "").rsplit(":", 1)[-1]
    if type_ref:
        complex_type = next(
            (
                element
                for element in root
                if _local_name(element.tag) == "complexType"
                and element.attrib.get("name") == type_ref
            ),
            None,
        )
    else:
        complex_type = next(
            (element for element in root_element if _local_name(element.tag) == "complexType"),
            None,
        )
    if complex_type is None:
        raise SourceDiscoveryFailure("discovery_schema_unsupported")
    fields: list[str] = []
    geometry_name: str | None = None
    geometry_type: GeometryType | None = None
    excluded = 0
    for element in complex_type.iter():
        if _local_name(element.tag) != "element":
            continue
        name = element.attrib.get("name")
        type_name = element.attrib.get("type", "").rsplit(":", 1)[-1]
        mapped_geometry = _wfs_geometry(type_name)
        if mapped_geometry is not None:
            if geometry_name is not None:
                raise SourceDiscoveryFailure("discovery_schema_unsupported")
            if not isinstance(name, str) or _OGC_NAME.fullmatch(name) is None:
                raise SourceDiscoveryFailure("discovery_schema_unsupported")
            geometry_name = name
            geometry_type = mapped_geometry
            continue
        if not isinstance(name, str) or _OGC_NAME.fullmatch(name) is None:
            excluded += 1
            continue
        if name in fields:
            raise SourceDiscoveryFailure("discovery_response_invalid")
        fields.append(name)
        if len(fields) > _MAXIMUM_FIELDS:
            raise SourceDiscoveryFailure("discovery_response_too_large")
    if geometry_name is None or geometry_type is None or not fields:
        raise SourceDiscoveryFailure("discovery_schema_unsupported")
    default_fields = fields[:64]
    definition = {
        "type": "wfs",
        "url": service_url,
        "version": "2.0.0",
        "type_name": collection_ref,
        "geometry_name": geometry_name,
        "fields": default_fields,
        "available_fields": fields,
        "sort_by": default_fields[0],
        "geometry_type": geometry_type,
        "page_size": 1_000,
        "attribution": None,
        "requires_field_selection": len(fields) > 64,
        "requires_sort_confirmation": True,
        "excluded_field_count": excluded,
    }
    return SourceDiscoveryResult(
        "wfs",
        "collection",
        service_url,
        (
            {
                "ref": collection_ref,
                "name": collection_ref,
                "title": collection_ref,
                "geometry_type": geometry_type,
                "bounds": None,
            },
        ),
        definition,
        (
            "WFS schema does not prove stable ordering; the user must confirm the sort field.",
            "The user must review fields, rights, and attribution before registration.",
        ),
    )


def _validate_spec(spec: SourceDiscoverySpec) -> None:
    parsed = urlsplit(spec.service_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 443}
        or parsed.query
        or parsed.fragment
        or len(spec.service_url) > 2_048
    ):
        raise ValueError("source discovery URL is invalid")
    if spec.source_type == "arcgis" and _ARCGIS_SERVICE_PATH.search(parsed.path) is None:
        raise ValueError("ArcGIS discovery URL must identify one service")
    if spec.kind == "catalog" and spec.collection_ref is not None:
        raise ValueError("catalog discovery cannot select a collection")
    if spec.kind == "collection":
        if spec.collection_ref is None or _OGC_NAME.fullmatch(spec.collection_ref) is None:
            raise ValueError("collection discovery requires one safe collection reference")
        if (
            spec.source_type == "arcgis"
            and _ARCGIS_LAYER_REF.fullmatch(spec.collection_ref) is None
        ):
            raise ValueError("ArcGIS collection reference must be a layer id")


def _json_document(body: bytes) -> dict[str, Any]:
    if not 1 <= len(body) <= _MAXIMUM_DOCUMENT_BYTES:
        raise SourceDiscoveryFailure("discovery_response_too_large")

    def reject_constant(value: str) -> None:
        del value
        raise ValueError("non-finite JSON")

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = value
        return result

    try:
        payload = json.loads(
            body.decode("utf-8"),
            parse_constant=reject_constant,
            object_pairs_hook=unique_object,
        )
    except (RecursionError, UnicodeDecodeError, ValueError) as error:
        raise SourceDiscoveryFailure("discovery_response_invalid") from error
    if not isinstance(payload, dict):
        raise SourceDiscoveryFailure("discovery_response_invalid")
    nodes = 0
    stack: list[tuple[Any, int]] = [(payload, 0)]
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > _MAXIMUM_JSON_NODES or depth > _MAXIMUM_XML_DEPTH:
            raise SourceDiscoveryFailure("discovery_response_too_large")
        if isinstance(value, dict):
            stack.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            stack.extend((child, depth + 1) for child in value)
        elif isinstance(value, float) and not math.isfinite(value):
            raise SourceDiscoveryFailure("discovery_response_invalid")
    return payload


def _xml_document(body: bytes) -> ElementTree.Element:
    if not 1 <= len(body) <= _MAXIMUM_DOCUMENT_BYTES:
        raise SourceDiscoveryFailure("discovery_response_too_large")
    upper = body[:8_192].upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as error:
        raise SourceDiscoveryFailure("discovery_response_invalid") from error
    nodes = 0
    stack = [(root, 0)]
    while stack:
        element, depth = stack.pop()
        nodes += 1
        if nodes > _MAXIMUM_XML_NODES or depth > _MAXIMUM_XML_DEPTH:
            raise SourceDiscoveryFailure("discovery_response_too_large")
        stack.extend((child, depth + 1) for child in element)
    return root


def _reject_arcgis_error(payload: Mapping[str, Any]) -> None:
    if "error" in payload:
        raise SourceDiscoveryFailure("discovery_upstream_rejected")


def _arcgis_geometry(value: Any, *, required: bool) -> GeometryType | None:
    mapped: dict[str, GeometryType] = {
        "esriGeometryPoint": "Point",
        "esriGeometryMultipoint": "MultiPoint",
        "esriGeometryPolyline": "MultiLineString",
        "esriGeometryPolygon": "MultiPolygon",
    }
    result = mapped.get(value) if isinstance(value, str) else None
    if result is None and required:
        raise SourceDiscoveryFailure("discovery_geometry_unsupported")
    return result


def _wfs_geometry(value: str) -> GeometryType | None:
    mapped: dict[str, GeometryType] = {
        "PointPropertyType": "Point",
        "MultiPointPropertyType": "MultiPoint",
        "CurvePropertyType": "LineString",
        "LineStringPropertyType": "LineString",
        "MultiCurvePropertyType": "MultiLineString",
        "MultiLineStringPropertyType": "MultiLineString",
        "SurfacePropertyType": "Polygon",
        "PolygonPropertyType": "Polygon",
        "MultiSurfacePropertyType": "MultiPolygon",
        "MultiPolygonPropertyType": "MultiPolygon",
    }
    return mapped.get(value)


def _wgs84_bounds(feature_type: ElementTree.Element) -> list[float] | None:
    bbox = next(
        (element for element in feature_type if _local_name(element.tag) == "WGS84BoundingBox"),
        None,
    )
    if bbox is None:
        return None
    lower = _child_text(bbox, "LowerCorner", required=True).split()
    upper = _child_text(bbox, "UpperCorner", required=True).split()
    if len(lower) != 2 or len(upper) != 2:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    try:
        bounds = [float(lower[0]), float(lower[1]), float(upper[0]), float(upper[1])]
    except ValueError as error:
        raise SourceDiscoveryFailure("discovery_response_invalid") from error
    if (
        not all(math.isfinite(value) for value in bounds)
        or not -180 <= bounds[0] < bounds[2] <= 180
        or not -90 <= bounds[1] < bounds[3] <= 90
    ):
        raise SourceDiscoveryFailure("discovery_response_invalid")
    return bounds


def _child_text(parent: ElementTree.Element, name: str, *, required: bool) -> str:
    matches = [child for child in parent if _local_name(child.tag) == name]
    if len(matches) > 1:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    if not matches:
        if required:
            raise SourceDiscoveryFailure("discovery_response_invalid")
        return ""
    value = (matches[0].text or "").strip()
    if (required and not value) or len(value) > 500:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    return value


def _local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def _bounded_text(value: Any, maximum: int) -> str:
    if not isinstance(value, str):
        raise SourceDiscoveryFailure("discovery_response_invalid")
    normalized = value.strip()
    if not 1 <= len(normalized) <= maximum or any(ord(character) < 32 for character in normalized):
        raise SourceDiscoveryFailure("discovery_response_invalid")
    return normalized


def _bounded_integer(value: Any, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise SourceDiscoveryFailure("discovery_response_invalid")
    return value
