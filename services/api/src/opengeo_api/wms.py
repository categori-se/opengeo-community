import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal, cast
from urllib.parse import urlsplit
from uuid import UUID
from xml.etree import ElementTree as ET

WMS_VERSION: Literal["1.3.0"] = "1.3.0"
WMS_VERSION_111: Literal["1.1.1"] = "1.1.1"
WMS_VERSIONS = frozenset({WMS_VERSION, WMS_VERSION_111})
WMS_CRS84 = "CRS:84"
WMS_EPSG4326 = "EPSG:4326"
WMS_EPSG3857 = "EPSG:3857"
WMS_MEDIA_TYPES: dict[Literal["svg", "png"], str] = {
    "png": "image/png",
    "svg": "image/svg+xml",
}
WEB_MERCATOR_LIMIT = 20_037_508.342789244
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
WMS_MAX_ABSOLUTE_COORDINATE = 1_000_000_000.0
WMS_NAMESPACE = "http://www.opengis.net/wms"
OGC_NAMESPACE = "http://www.opengis.net/ogc"
XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"
XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"
_CAPABILITIES_SCHEMA = "http://schemas.opengis.net/wms/1.3.0/capabilities_1_3_0.xsd"
_EXCEPTION_SCHEMA = "http://schemas.opengis.net/wms/1.3.0/exceptions_1_3_0.xsd"
_CAPABILITIES_DTD_111 = "http://schemas.opengis.net/wms/1.1.1/WMS_MS_Capabilities.dtd"
_EXCEPTION_DTD_111 = "http://schemas.opengis.net/wms/1.1.1/exception_1_1_1.dtd"
_PARAMETER_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_LAYER_NAME = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,62}(?::[A-Za-z][A-Za-z0-9._-]{0,62})?")

ET.register_namespace("xlink", XLINK_NAMESPACE)
ET.register_namespace("xsi", XSI_NAMESPACE)


class WmsRequestError(ValueError):
    def __init__(
        self,
        code: str,
        locator: str,
        message: str,
        *,
        status_code: int = 400,
    ) -> None:
        self.code = code
        self.locator = locator
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class WmsCapabilitiesRequest:
    version: Literal["1.3.0", "1.1.1"] = WMS_VERSION
    operation: Literal["GetCapabilities"] = "GetCapabilities"


@dataclass(frozen=True, slots=True)
class WmsMapRequest:
    layer_id: str
    style_id: UUID | None
    bbox: tuple[float, float, float, float]
    crs: Literal["CRS:84", "EPSG:3857"]
    width: int
    height: int
    format: Literal["svg", "png"]
    background_color: str
    transparent: bool
    additional_layers: tuple[tuple[str, UUID | None], ...] = ()
    version: Literal["1.3.0", "1.1.1"] = WMS_VERSION
    operation: Literal["GetMap"] = "GetMap"

    @property
    def layers(self) -> tuple[tuple[str, UUID | None], ...]:
        return ((self.layer_id, self.style_id), *self.additional_layers)


WmsRequest = WmsCapabilitiesRequest | WmsMapRequest


@dataclass(frozen=True, slots=True)
class WmsStyle:
    name: str
    title: str


@dataclass(frozen=True, slots=True)
class WmsLayer:
    name: str
    title: str
    abstract: str | None
    attribution: str | None
    bbox: tuple[float, float, float, float]
    styles: tuple[WmsStyle, ...]


def parse_wms_request(items: Iterable[tuple[str, str]], *, layer_limit: int = 1) -> WmsRequest:
    if not 1 <= layer_limit <= 16:
        raise ValueError("WMS layer limit must be between 1 and 16")
    parameters: dict[str, str] = {}
    for raw_name, value in items:
        legacy_cross_origin = raw_name.lower() == "cross-origin"
        valid_name = legacy_cross_origin or _PARAMETER_NAME.fullmatch(raw_name) is not None
        name = "CROSS_ORIGIN" if legacy_cross_origin else raw_name.upper()
        maximum_value_length = 4_096 if name in {"LAYERS", "STYLES"} else 500
        if (
            not valid_name
            or len(value) > maximum_value_length
            or (legacy_cross_origin and value != "anonymous")
        ):
            raise WmsRequestError(
                "InvalidParameterValue", "QUERY", "The WMS query contains an invalid parameter."
            )
        # GeoMoose 3.15.2 copies its browser-only cross-origin source option
        # into the ImageWMS KVP bag. Accept only its exact non-credentialed
        # value as an ignored vendor hint; no other hyphenated key is widened.
        if name in parameters:
            raise WmsRequestError(
                "InvalidParameterValue", name, f"WMS parameter {name} must occur once."
            )
        parameters[name] = value
    if len(parameters) > 20:
        raise WmsRequestError(
            "InvalidParameterValue", "QUERY", "The WMS query contains too many parameters."
        )
    operation = parameters.get("REQUEST", "").lower()
    if operation == "getcapabilities":
        if parameters.get("SERVICE", "").upper() != "WMS":
            raise WmsRequestError("InvalidParameterValue", "SERVICE", "SERVICE must be WMS.")
        return _capabilities_request(parameters)
    if operation == "getmap":
        service = parameters.get("SERVICE")
        if service is not None and service.upper() != "WMS":
            raise WmsRequestError("InvalidParameterValue", "SERVICE", "SERVICE must be WMS.")
        return _map_request(parameters, layer_limit)
    if not operation:
        raise WmsRequestError(
            "MissingParameterValue", "REQUEST", "WMS parameter REQUEST is required."
        )
    raise WmsRequestError(
        "OperationNotSupported", "REQUEST", "Only GetCapabilities and GetMap are supported."
    )


def _capabilities_request(parameters: dict[str, str]) -> WmsCapabilitiesRequest:
    version = parameters.get("VERSION")
    if version is not None and re.fullmatch(r"[0-9]{1,9}(?:\.[0-9]{1,9}){2}", version) is None:
        raise WmsRequestError(
            "InvalidParameterValue",
            "VERSION",
            "VERSION must contain three integer components.",
        )
    # The service advertises no updateSequence, so the supplied value is ignored.
    # It also has exactly one capabilities representation and returns it for an
    # absent, recognized, or unrecognized FORMAT hint. An absent or unsupported
    # version negotiates the highest implemented version; an exact 1.1.1 request
    # retains the legacy representation needed by GeoMoose 3.15.2.
    negotiated = version if version in WMS_VERSIONS else WMS_VERSION
    return WmsCapabilitiesRequest(version=cast(Literal["1.3.0", "1.1.1"], negotiated))


def _map_request(parameters: dict[str, str], layer_limit: int) -> WmsMapRequest:
    version = parameters.get("VERSION")
    if version is None:
        raise WmsRequestError(
            "MissingParameterValue", "VERSION", "WMS parameter VERSION is required."
        )
    if version not in WMS_VERSIONS:
        raise WmsRequestError(
            "InvalidParameterValue",
            "VERSION",
            f"GetMap requires WMS {WMS_VERSION} or {WMS_VERSION_111}.",
        )
    coordinate_parameter = "CRS" if version == WMS_VERSION else "SRS"
    alternate_coordinate_parameter = "SRS" if coordinate_parameter == "CRS" else "CRS"
    required = {
        "VERSION",
        "LAYERS",
        "STYLES",
        coordinate_parameter,
        "BBOX",
        "WIDTH",
        "HEIGHT",
        "FORMAT",
    }
    missing = sorted(required - parameters.keys())
    if missing:
        raise WmsRequestError(
            "MissingParameterValue", missing[0], f"WMS parameter {missing[0]} is required."
        )
    if alternate_coordinate_parameter in parameters:
        raise WmsRequestError(
            "InvalidParameterValue",
            alternate_coordinate_parameter,
            f"WMS {version} uses {coordinate_parameter}, not {alternate_coordinate_parameter}.",
        )
    layers = parameters["LAYERS"].split(",")
    styles = parameters["STYLES"].split(",")
    if not 1 <= len(layers) <= layer_limit or any(not layer for layer in layers):
        raise WmsRequestError(
            "LayerNotDefined",
            "LAYERS",
            f"Between one and {layer_limit} advertised layers are supported.",
        )
    if parameters["STYLES"] == "":
        styles = [""] * len(layers)
    if len(styles) != len(layers):
        raise WmsRequestError(
            "StyleNotDefined", "STYLES", "One style entry is required for every layer."
        )
    layer_names = tuple(_layer_name(layer) for layer in layers)
    style_ids = tuple(
        None if style == "" else _uuid(style, "StyleNotDefined", "STYLES") for style in styles
    )
    requested_crs = parameters[coordinate_parameter].upper()
    supported_crs = (
        {WMS_CRS84, WMS_EPSG3857} if version == WMS_VERSION else {WMS_EPSG4326, WMS_EPSG3857}
    )
    if requested_crs not in supported_crs:
        raise WmsRequestError(
            "InvalidCRS" if version == WMS_VERSION else "InvalidSRS",
            coordinate_parameter,
            f"Only {' and '.join(sorted(supported_crs))} are supported for WMS {version}.",
        )
    crs = cast(
        Literal["CRS:84", "EPSG:3857"],
        WMS_CRS84 if requested_crs == WMS_EPSG4326 else requested_crs,
    )
    bbox = _bbox(parameters["BBOX"], crs)
    width = _integer(parameters["WIDTH"], "WIDTH")
    height = _integer(parameters["HEIGHT"], "HEIGHT")
    if width * height > 4_194_304:
        raise WmsRequestError(
            "InvalidParameterValue", "WIDTH", "The requested map exceeds the pixel budget."
        )
    requested_media_type = parameters["FORMAT"].lower()
    output_format = next(
        (
            name
            for name, media_type in WMS_MEDIA_TYPES.items()
            if media_type == requested_media_type
        ),
        None,
    )
    if output_format is None:
        raise WmsRequestError(
            "InvalidFormat", "FORMAT", "Only image/svg+xml and image/png are supported."
        )
    transparent = _boolean(parameters.get("TRANSPARENT", "FALSE"), "TRANSPARENT")
    background = parameters.get("BGCOLOR", "0xFFFFFF")
    if re.fullmatch(r"0[xX][0-9A-Fa-f]{6}", background) is None:
        raise WmsRequestError(
            "InvalidParameterValue",
            "BGCOLOR",
            "BGCOLOR must use the 0xRRGGBB hexadecimal form.",
        )
    # XML is the required Basic WMS exception representation. Clause 7.3.3.11
    # permits the default representation when a requested exception format is
    # unsupported, so EXCEPTIONS is deliberately accepted as a bounded hint.
    return WmsMapRequest(
        layer_id=layer_names[0],
        style_id=style_ids[0],
        bbox=bbox,
        crs=crs,
        width=width,
        height=height,
        format=output_format,
        background_color=f"#{background[2:].lower()}",
        transparent=transparent,
        additional_layers=tuple(zip(layer_names[1:], style_ids[1:], strict=True)),
        version=cast(Literal["1.3.0", "1.1.1"], version),
    )


def _boolean(value: str, locator: str) -> bool:
    normalized = value.lower()
    if normalized in {"1", "true"}:
        return True
    if normalized in {"0", "false"}:
        return False
    raise WmsRequestError(
        "InvalidParameterValue",
        locator,
        f"{locator} must be an XML Schema boolean.",
    )


def _uuid(value: str, code: str, locator: str) -> UUID:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise WmsRequestError(
            code, locator, f"{locator} is not advertised by this service."
        ) from error
    if str(parsed) != value.lower():
        raise WmsRequestError(code, locator, f"{locator} is not advertised by this service.")
    return parsed


def _layer_name(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError:
        parsed = None
    if parsed is not None and str(parsed) == value.lower():
        return str(parsed)
    if _LAYER_NAME.fullmatch(value) is not None:
        return value
    raise WmsRequestError("LayerNotDefined", "LAYERS", "LAYERS is not advertised by this service.")


def _integer(value: str, locator: str) -> int:
    if re.fullmatch(r"\+?[0-9]+", value, flags=re.ASCII) is None:
        raise WmsRequestError(
            "InvalidParameterValue", locator, f"{locator} must be a positive integer."
        )
    number = int(value)
    if not 1 <= number <= 2_048:
        raise WmsRequestError(
            "InvalidParameterValue", locator, f"{locator} must be between 1 and 2048."
        )
    return number


def _bbox(value: str, crs: Literal["CRS:84", "EPSG:3857"]) -> tuple[float, float, float, float]:
    parts = value.split(",")
    try:
        if len(parts) != 4:
            raise ValueError
        bbox = tuple(float(part) for part in parts)
    except ValueError as error:
        raise WmsRequestError(
            "InvalidParameterValue", "BBOX", "BBOX must contain four numbers."
        ) from error
    west, south, east, north = bbox
    # WMS 1.3 requires an image even when a valid ordered BBOX falls partly or
    # wholly outside the CRS domain; out-of-domain areas render as background.
    # A generous absolute bound retains predictable arithmetic and storage.
    supported = (
        west < east
        and south < north
        and all(abs(number) <= WMS_MAX_ABSOLUTE_COORDINATE for number in bbox)
    )
    if not all(math.isfinite(number) for number in bbox) or not supported:
        raise WmsRequestError(
            "InvalidParameterValue",
            "BBOX",
            f"BBOX must be a finite ordered {crs} extent within the numeric safety bound.",
        )
    return west, south, east, north


def capabilities_xml(
    layer: WmsLayer | Sequence[WmsLayer],
    endpoint: str,
    *,
    service_title: str | None = None,
    layer_limit: int = 1,
    version: Literal["1.3.0", "1.1.1"] = WMS_VERSION,
) -> bytes:
    layers = (layer,) if isinstance(layer, WmsLayer) else tuple(layer)
    if not layers or not 1 <= layer_limit <= 16 or len(layers) > 1_000:
        raise ValueError("WMS layer catalog is invalid")
    parsed_endpoint = urlsplit(endpoint)
    if (
        parsed_endpoint.scheme not in {"http", "https"}
        or not parsed_endpoint.netloc
        or parsed_endpoint.username is not None
        or parsed_endpoint.password is not None
        or parsed_endpoint.query
        or parsed_endpoint.fragment
        or len(endpoint) > 2_048
    ):
        raise ValueError("WMS endpoint is invalid")
    if version not in WMS_VERSIONS:
        raise ValueError("WMS capabilities version is invalid")
    if version == WMS_VERSION_111:
        return _capabilities_xml_111(
            layers,
            endpoint,
            service_title=service_title,
            layer_limit=layer_limit,
        )
    root = ET.Element(
        "WMS_Capabilities",
        {
            "xmlns": WMS_NAMESPACE,
            "version": WMS_VERSION,
            f"{{{XSI_NAMESPACE}}}schemaLocation": f"{WMS_NAMESPACE} {_CAPABILITIES_SCHEMA}",
        },
    )
    service = ET.SubElement(root, "Service")
    ET.SubElement(service, "Name").text = "WMS"
    title = service_title or layers[0].title
    ET.SubElement(service, "Title").text = f"OpenGeo — {title}"
    ET.SubElement(service, "Abstract").text = (
        "Authenticated WMS 1.3.0 compatibility facade. Exact governed CRS:84 and "
        "EPSG:3857 SVG/PNG maps are available; cache misses wait for one bounded immutable "
        "render and return a retryable service exception if processing is unavailable."
    )
    _online_resource(service, endpoint)
    ET.SubElement(service, "Fees").text = "none"
    ET.SubElement(
        service, "AccessConstraints"
    ).text = (
        "Bearer authentication, organization selection, and governed resource permission required"
    )
    ET.SubElement(service, "LayerLimit").text = str(layer_limit)
    ET.SubElement(service, "MaxWidth").text = "2048"
    ET.SubElement(service, "MaxHeight").text = "2048"

    capability = ET.SubElement(root, "Capability")
    request = ET.SubElement(capability, "Request")
    _operation(request, "GetCapabilities", ("text/xml",), endpoint)
    _operation(request, "GetMap", tuple(WMS_MEDIA_TYPES.values()), endpoint)
    exception = ET.SubElement(capability, "Exception")
    ET.SubElement(exception, "Format").text = "XML"
    root_layer = ET.SubElement(capability, "Layer", {"queryable": "0", "opaque": "0"})
    ET.SubElement(root_layer, "Title").text = f"{title} maps"
    ET.SubElement(root_layer, "CRS").text = WMS_CRS84
    ET.SubElement(root_layer, "CRS").text = WMS_EPSG3857
    for advertised_layer in layers:
        child = ET.SubElement(root_layer, "Layer", {"queryable": "0", "opaque": "0"})
        ET.SubElement(child, "Name").text = advertised_layer.name
        ET.SubElement(child, "Title").text = advertised_layer.title
        if advertised_layer.abstract:
            ET.SubElement(child, "Abstract").text = advertised_layer.abstract
        ET.SubElement(child, "CRS").text = WMS_CRS84
        ET.SubElement(child, "CRS").text = WMS_EPSG3857
        _extent(child, advertised_layer.bbox)
        if advertised_layer.attribution:
            attribution = ET.SubElement(child, "Attribution")
            ET.SubElement(attribution, "Title").text = advertised_layer.attribution
        for style in advertised_layer.styles:
            style_node = ET.SubElement(child, "Style")
            ET.SubElement(style_node, "Name").text = style.name
            ET.SubElement(style_node, "Title").text = style.title
    return cast(
        bytes,
        ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True),
    )


def exception_xml(
    code: str,
    locator: str,
    message: str,
    *,
    version: Literal["1.3.0", "1.1.1"] = WMS_VERSION,
) -> bytes:
    if version not in WMS_VERSIONS:
        raise ValueError("WMS exception version is invalid")
    if version == WMS_VERSION_111:
        root = ET.Element("ServiceExceptionReport", {"version": WMS_VERSION_111})
        attributes = {"code": code}
        if locator:
            attributes["locator"] = locator
        ET.SubElement(root, "ServiceException", attributes).text = message[:500]
        document = cast(bytes, ET.tostring(root, encoding="utf-8", short_empty_elements=True))
        return (
            b'<?xml version="1.0" encoding="utf-8"?>\n'
            + f'<!DOCTYPE ServiceExceptionReport SYSTEM "{_EXCEPTION_DTD_111}">\n'.encode()
            + document
        )
    root = ET.Element(
        "ServiceExceptionReport",
        {
            "xmlns": OGC_NAMESPACE,
            "version": WMS_VERSION,
            f"{{{XSI_NAMESPACE}}}schemaLocation": f"{OGC_NAMESPACE} {_EXCEPTION_SCHEMA}",
        },
    )
    attributes = {"code": code}
    if locator:
        attributes["locator"] = locator
    ET.SubElement(root, "ServiceException", attributes).text = message[:500]
    return cast(
        bytes,
        ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True),
    )


def _capabilities_xml_111(
    layers: tuple[WmsLayer, ...],
    endpoint: str,
    *,
    service_title: str | None,
    layer_limit: int,
) -> bytes:
    root = ET.Element("WMT_MS_Capabilities", {"version": WMS_VERSION_111})
    service = ET.SubElement(root, "Service")
    ET.SubElement(service, "Name").text = "OGC:WMS"
    title = service_title or layers[0].title
    ET.SubElement(service, "Title").text = f"OpenGeo — {title}"
    ET.SubElement(service, "Abstract").text = (
        "WMS 1.1.1 compatibility facade for GeoMoose and legacy GIS clients. Exact governed "
        "EPSG:4326 and EPSG:3857 SVG/PNG maps share the same authorization, immutable render, "
        "and bounded cache behavior as the canonical WMS 1.3.0 representation."
    )
    _online_resource(service, endpoint)
    ET.SubElement(service, "Fees").text = "none"
    ET.SubElement(
        service, "AccessConstraints"
    ).text = (
        "Bearer authentication, organization selection, and governed resource permission required"
    )

    capability = ET.SubElement(root, "Capability")
    request = ET.SubElement(capability, "Request")
    _operation(request, "GetCapabilities", ("application/vnd.ogc.wms_xml",), endpoint)
    _operation(request, "GetMap", tuple(WMS_MEDIA_TYPES.values()), endpoint)
    exception = ET.SubElement(capability, "Exception")
    ET.SubElement(exception, "Format").text = "application/vnd.ogc.se_xml"
    root_layer = ET.SubElement(capability, "Layer", {"queryable": "0", "opaque": "0"})
    ET.SubElement(root_layer, "Title").text = f"{title} maps"
    ET.SubElement(root_layer, "SRS").text = WMS_EPSG4326
    ET.SubElement(root_layer, "SRS").text = WMS_EPSG3857
    for advertised_layer in layers:
        child = ET.SubElement(root_layer, "Layer", {"queryable": "0", "opaque": "0"})
        ET.SubElement(child, "Name").text = advertised_layer.name
        ET.SubElement(child, "Title").text = advertised_layer.title
        if advertised_layer.abstract:
            ET.SubElement(child, "Abstract").text = advertised_layer.abstract
        ET.SubElement(child, "SRS").text = WMS_EPSG4326
        ET.SubElement(child, "SRS").text = WMS_EPSG3857
        _extent_111(child, advertised_layer.bbox)
        if advertised_layer.attribution:
            attribution = ET.SubElement(child, "Attribution")
            ET.SubElement(attribution, "Title").text = advertised_layer.attribution
        for style in advertised_layer.styles:
            style_node = ET.SubElement(child, "Style")
            ET.SubElement(style_node, "Name").text = style.name
            ET.SubElement(style_node, "Title").text = style.title
    document = cast(bytes, ET.tostring(root, encoding="utf-8", short_empty_elements=True))
    return (
        b'<?xml version="1.0" encoding="utf-8"?>\n'
        + f'<!DOCTYPE WMT_MS_Capabilities SYSTEM "{_CAPABILITIES_DTD_111}">\n'.encode()
        + document
    )


def _online_resource(parent: ET.Element, endpoint: str) -> None:
    ET.SubElement(
        parent,
        "OnlineResource",
        {
            f"{{{XLINK_NAMESPACE}}}type": "simple",
            f"{{{XLINK_NAMESPACE}}}href": f"{endpoint}?",
        },
    )


def _operation(
    parent: ET.Element, name: str, output_formats: tuple[str, ...], endpoint: str
) -> None:
    operation = ET.SubElement(parent, name)
    for output_format in output_formats:
        ET.SubElement(operation, "Format").text = output_format
    dcp = ET.SubElement(operation, "DCPType")
    http = ET.SubElement(dcp, "HTTP")
    get = ET.SubElement(http, "Get")
    _online_resource(get, endpoint)


def _extent(parent: ET.Element, bbox: tuple[float, float, float, float]) -> None:
    west, south, east, north = bbox
    geographic = ET.SubElement(parent, "EX_GeographicBoundingBox")
    ET.SubElement(geographic, "westBoundLongitude").text = _coordinate(west)
    ET.SubElement(geographic, "eastBoundLongitude").text = _coordinate(east)
    ET.SubElement(geographic, "southBoundLatitude").text = _coordinate(south)
    ET.SubElement(geographic, "northBoundLatitude").text = _coordinate(north)
    ET.SubElement(
        parent,
        "BoundingBox",
        {
            "CRS": WMS_CRS84,
            "minx": _coordinate(west),
            "miny": _coordinate(south),
            "maxx": _coordinate(east),
            "maxy": _coordinate(north),
        },
    )
    projected = _web_mercator_bbox(bbox)
    ET.SubElement(
        parent,
        "BoundingBox",
        {
            "CRS": WMS_EPSG3857,
            "minx": _coordinate(projected[0]),
            "miny": _coordinate(projected[1]),
            "maxx": _coordinate(projected[2]),
            "maxy": _coordinate(projected[3]),
        },
    )


def _extent_111(parent: ET.Element, bbox: tuple[float, float, float, float]) -> None:
    west, south, east, north = bbox
    ET.SubElement(
        parent,
        "LatLonBoundingBox",
        {
            "minx": _coordinate(west),
            "miny": _coordinate(south),
            "maxx": _coordinate(east),
            "maxy": _coordinate(north),
        },
    )
    ET.SubElement(
        parent,
        "BoundingBox",
        {
            "SRS": WMS_EPSG4326,
            "minx": _coordinate(west),
            "miny": _coordinate(south),
            "maxx": _coordinate(east),
            "maxy": _coordinate(north),
        },
    )
    projected = _web_mercator_bbox(bbox)
    ET.SubElement(
        parent,
        "BoundingBox",
        {
            "SRS": WMS_EPSG3857,
            "minx": _coordinate(projected[0]),
            "miny": _coordinate(projected[1]),
            "maxx": _coordinate(projected[2]),
            "maxy": _coordinate(projected[3]),
        },
    )


def _web_mercator_bbox(
    bbox: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west, south, east, north = bbox

    def longitude(value: float) -> float:
        return value * WEB_MERCATOR_LIMIT / 180

    def latitude(value: float) -> float:
        bounded = max(-WEB_MERCATOR_LATITUDE_LIMIT, min(WEB_MERCATOR_LATITUDE_LIMIT, value))
        return WEB_MERCATOR_LIMIT * math.log(math.tan((90 + bounded) * math.pi / 360)) / math.pi

    return longitude(west), latitude(south), longitude(east), latitude(north)


def _coordinate(value: float) -> str:
    return format(value, ".15g")
