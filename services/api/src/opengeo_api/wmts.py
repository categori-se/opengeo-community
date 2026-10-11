from dataclasses import dataclass
from typing import Literal, cast
from xml.etree import ElementTree

WMTS_VERSION = "1.0.0"
WEB_MERCATOR_QUAD = "WebMercatorQuad"
WEB_MERCATOR_QUAD_URI = "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
EPSG3857_URN = "urn:ogc:def:crs:EPSG::3857"
WEB_MERCATOR_LIMIT = 20_037_508.342789244
ZOOM_ZERO_SCALE_DENOMINATOR = 559_082_264.0287178

WMTS = "http://www.opengis.net/wmts/1.0"
OWS = "http://www.opengis.net/ows/1.1"
XLINK = "http://www.w3.org/1999/xlink"
OPEN_GEO = "https://categori.se/ns/opengeo/1.0"
ElementTree.register_namespace("", WMTS)
ElementTree.register_namespace("ows", OWS)
ElementTree.register_namespace("xlink", XLINK)
ElementTree.register_namespace("opengeo", OPEN_GEO)


class WmtsRequestError(ValueError):
    def __init__(self, code: str, locator: str, message: str, status_code: int = 400) -> None:
        self.code = code
        self.locator = locator
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class WmtsCapabilitiesRequest:
    operation: Literal["GetCapabilities"] = "GetCapabilities"


@dataclass(frozen=True, slots=True)
class WmtsTileRequest:
    layer: str
    style: str
    format: str
    tile_matrix_set: str
    tile_matrix: int
    tile_row: int
    tile_col: int
    operation: Literal["GetTile"] = "GetTile"


WmtsRequest = WmtsCapabilitiesRequest | WmtsTileRequest


def parse_wmts_request(items: list[tuple[str, str]]) -> WmtsRequest:
    allowed = {
        "service",
        "request",
        "version",
        "layer",
        "style",
        "format",
        "tilematrixset",
        "tilematrix",
        "tilerow",
        "tilecol",
    }
    values: dict[str, str] = {}
    for raw_name, value in items:
        name = raw_name.lower()
        if name not in allowed:
            raise WmtsRequestError("InvalidParameterValue", raw_name, "unknown parameter")
        if name in values:
            raise WmtsRequestError("InvalidParameterValue", raw_name, "duplicate parameter")
        values[name] = value
    if values.get("service", "").upper() != "WMTS":
        raise WmtsRequestError("InvalidParameterValue", "SERVICE", "SERVICE must be WMTS")
    operation = values.get("request", "").lower()
    if operation not in {"getcapabilities", "gettile"}:
        raise WmtsRequestError("OperationNotSupported", "REQUEST", "unsupported operation")
    version = values.get("version")
    if operation == "gettile" and version != WMTS_VERSION:
        raise WmtsRequestError("InvalidParameterValue", "VERSION", "VERSION must be 1.0.0")
    if operation == "getcapabilities":
        extras = set(values) - {"service", "request", "version"}
        if extras:
            name = sorted(extras)[0]
            raise WmtsRequestError("InvalidParameterValue", name.upper(), "unexpected parameter")
        if version is not None and version != WMTS_VERSION:
            raise WmtsRequestError("VersionNegotiationFailed", "VERSION", "unsupported version")
        return WmtsCapabilitiesRequest()
    required = (
        "layer",
        "style",
        "format",
        "tilematrixset",
        "tilematrix",
        "tilerow",
        "tilecol",
    )
    for name in required:
        if not values.get(name):
            raise WmtsRequestError("MissingParameterValue", name.upper(), "required parameter")
    try:
        tile_matrix = int(values["tilematrix"])
        tile_row = int(values["tilerow"])
        tile_col = int(values["tilecol"])
    except ValueError as error:
        raise WmtsRequestError(
            "InvalidParameterValue", "TILEMATRIX/TILEROW/TILECOL", "integer required"
        ) from error
    if tile_matrix < 0 or tile_row < 0 or tile_col < 0:
        raise WmtsRequestError(
            "InvalidParameterValue", "TILEMATRIX/TILEROW/TILECOL", "nonnegative integer required"
        )
    if tile_matrix > 22 or tile_row >= (1 << tile_matrix) or tile_col >= (1 << tile_matrix):
        raise WmtsRequestError(
            "TileOutOfRange",
            "TILEMATRIX/TILEROW/TILECOL",
            "tile coordinate is outside WebMercatorQuad",
            404,
        )
    return WmtsTileRequest(
        values["layer"],
        values["style"],
        values["format"].lower(),
        values["tilematrixset"],
        tile_matrix,
        tile_row,
        tile_col,
    )


def exception_xml(error: WmtsRequestError) -> bytes:
    root = ElementTree.Element(
        f"{{{OWS}}}ExceptionReport",
        {"version": WMTS_VERSION, "xml:lang": "en"},
    )
    exception = ElementTree.SubElement(
        root,
        f"{{{OWS}}}Exception",
        {"exceptionCode": error.code, "locator": error.locator},
    )
    ElementTree.SubElement(exception, f"{{{OWS}}}ExceptionText").text = error.message
    return cast(bytes, ElementTree.tostring(root, encoding="utf-8", xml_declaration=True))


@dataclass(frozen=True, slots=True)
class WmtsLayer:
    identifier: str
    title: str
    minimum_tile_matrix: int
    maximum_tile_matrix: int


def capabilities_xml(
    service_title: str,
    endpoint: str,
    layers: tuple[WmtsLayer, ...],
) -> bytes:
    root = ElementTree.Element(
        f"{{{WMTS}}}Capabilities",
        {"version": WMTS_VERSION},
    )
    identification = ElementTree.SubElement(root, f"{{{OWS}}}ServiceIdentification")
    ElementTree.SubElement(identification, f"{{{OWS}}}Title").text = service_title
    ElementTree.SubElement(identification, f"{{{OWS}}}ServiceType").text = "OGC WMTS"
    ElementTree.SubElement(identification, f"{{{OWS}}}ServiceTypeVersion").text = WMTS_VERSION
    operations = ElementTree.SubElement(root, f"{{{OWS}}}OperationsMetadata")
    for operation_name in ("GetCapabilities", "GetTile"):
        operation = ElementTree.SubElement(
            operations, f"{{{OWS}}}Operation", {"name": operation_name}
        )
        dcp = ElementTree.SubElement(operation, f"{{{OWS}}}DCP")
        http = ElementTree.SubElement(dcp, f"{{{OWS}}}HTTP")
        get = ElementTree.SubElement(http, f"{{{OWS}}}Get", {f"{{{XLINK}}}href": endpoint})
        constraint = ElementTree.SubElement(get, f"{{{OWS}}}Constraint", {"name": "GetEncoding"})
        allowed = ElementTree.SubElement(constraint, f"{{{OWS}}}AllowedValues")
        ElementTree.SubElement(allowed, f"{{{OWS}}}Value").text = "KVP"
    contents = ElementTree.SubElement(root, f"{{{WMTS}}}Contents")
    for layer in layers:
        layer_node = ElementTree.SubElement(contents, f"{{{WMTS}}}Layer")
        ElementTree.SubElement(layer_node, f"{{{OWS}}}Title").text = layer.title
        ElementTree.SubElement(layer_node, f"{{{OWS}}}Identifier").text = layer.identifier
        style = ElementTree.SubElement(layer_node, f"{{{WMTS}}}Style", {"isDefault": "true"})
        ElementTree.SubElement(style, f"{{{OWS}}}Identifier").text = "default"
        ElementTree.SubElement(layer_node, f"{{{WMTS}}}Format").text = "image/png"
        link = ElementTree.SubElement(layer_node, f"{{{WMTS}}}TileMatrixSetLink")
        ElementTree.SubElement(link, f"{{{WMTS}}}TileMatrixSet").text = WEB_MERCATOR_QUAD
        limits = ElementTree.SubElement(link, f"{{{WMTS}}}TileMatrixSetLimits")
        for zoom in range(layer.minimum_tile_matrix, layer.maximum_tile_matrix + 1):
            matrix_limit = ElementTree.SubElement(limits, f"{{{WMTS}}}TileMatrixLimits")
            ElementTree.SubElement(matrix_limit, f"{{{WMTS}}}TileMatrix").text = str(zoom)
            maximum = str((1 << zoom) - 1)
            ElementTree.SubElement(matrix_limit, f"{{{WMTS}}}MinTileRow").text = "0"
            ElementTree.SubElement(matrix_limit, f"{{{WMTS}}}MaxTileRow").text = maximum
            ElementTree.SubElement(matrix_limit, f"{{{WMTS}}}MinTileCol").text = "0"
            ElementTree.SubElement(matrix_limit, f"{{{WMTS}}}MaxTileCol").text = maximum
    matrix_set = ElementTree.SubElement(contents, f"{{{WMTS}}}TileMatrixSet")
    ElementTree.SubElement(matrix_set, f"{{{OWS}}}Identifier").text = WEB_MERCATOR_QUAD
    ElementTree.SubElement(matrix_set, f"{{{OWS}}}SupportedCRS").text = EPSG3857_URN
    ElementTree.SubElement(matrix_set, f"{{{WMTS}}}WellKnownScaleSet").text = WEB_MERCATOR_QUAD_URI
    maximum_zoom = max((layer.maximum_tile_matrix for layer in layers), default=0)
    for zoom in range(maximum_zoom + 1):
        matrix = ElementTree.SubElement(matrix_set, f"{{{WMTS}}}TileMatrix")
        ElementTree.SubElement(matrix, f"{{{OWS}}}Identifier").text = str(zoom)
        ElementTree.SubElement(matrix, f"{{{WMTS}}}ScaleDenominator").text = format(
            ZOOM_ZERO_SCALE_DENOMINATOR / (1 << zoom), ".15g"
        )
        ElementTree.SubElement(
            matrix, f"{{{WMTS}}}TopLeftCorner"
        ).text = f"{-WEB_MERCATOR_LIMIT:.15f} {WEB_MERCATOR_LIMIT:.15f}"
        ElementTree.SubElement(matrix, f"{{{WMTS}}}TileWidth").text = "256"
        ElementTree.SubElement(matrix, f"{{{WMTS}}}TileHeight").text = "256"
        ElementTree.SubElement(matrix, f"{{{WMTS}}}MatrixWidth").text = str(1 << zoom)
        ElementTree.SubElement(matrix, f"{{{WMTS}}}MatrixHeight").text = str(1 << zoom)
    ElementTree.SubElement(root, f"{{{OPEN_GEO}}}ConformanceClaimed").text = "false"
    ElementTree.SubElement(
        root, f"{{{OPEN_GEO}}}AuthenticationAuthority"
    ).text = "https://auth.categori.se"
    ElementTree.SubElement(root, f"{{{OPEN_GEO}}}CacheMode").text = "seeded-cache-only"
    return cast(bytes, ElementTree.tostring(root, encoding="utf-8", xml_declaration=True))
