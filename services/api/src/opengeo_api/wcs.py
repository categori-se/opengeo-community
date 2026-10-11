import hashlib
import math
import re
from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, InvalidOperation
from typing import Literal
from xml.etree import ElementTree as ET

from opengeo_api.coverages import CoverageDerivativeSpec, SpatialCoverage

WCS_VERSION = "2.0.1"
WCS_GET_KVP_PROFILE = "http://www.opengis.net/spec/WCS_protocol-binding_get-kvp/1.0/conf/get-kvp"
WCS_GML_PROFILE = "http://www.opengis.net/spec/GMLCOV/1.0/conf/gml"
WCS_NS = "http://www.opengis.net/wcs/2.0"
OWS_NS = "http://www.opengis.net/ows/2.0"
GML_NS = "http://www.opengis.net/gml/3.2"
SWE_NS = "http://www.opengis.net/swe/2.0"
GMLCOV_NS = "http://www.opengis.net/gmlcov/1.0"
XLINK_NS = "http://www.w3.org/1999/xlink"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"
MAXIMUM_WCS_SUBSETS = 8
MAXIMUM_WCS_DESCRIPTIONS = 16

for prefix, namespace in (
    ("wcs", WCS_NS),
    ("ows", OWS_NS),
    ("gml", GML_NS),
    ("swe", SWE_NS),
    ("gmlcov", GMLCOV_NS),
    ("xlink", XLINK_NS),
    ("xsi", XSI_NS),
):
    ET.register_namespace(prefix, namespace)


class WcsRequestError(ValueError):
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
class WcsRequest:
    operation: str
    coverage_id: str | None = None
    format: str | None = None
    media_type: str | None = None
    subsets: tuple["WcsSubset", ...] = ()
    coverage_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class WcsSubset:
    dimension: str
    lower: Decimal | Literal["*"]
    upper: Decimal | Literal["*"] | None = None


@dataclass(frozen=True, slots=True)
class WcsSubsetPlan:
    subsets: tuple[WcsSubset, ...]
    extent: tuple[float, float, float, float]
    sliced_axes: tuple[str, ...]
    canonical_key: str


@dataclass(frozen=True, slots=True)
class WcsCoverageView:
    coverage_id: str
    crs: str
    extent: tuple[float, float, float, float]
    width: int
    height: int
    bands: tuple[dict[str, object], ...]


def parse_wcs_request(items: list[tuple[str, str]]) -> WcsRequest:
    parameters: dict[str, str] = {}
    spellings: dict[str, str] = {}
    raw_subsets: list[str] = []
    for raw_name, raw_value in items:
        name = raw_name.upper()
        if len(raw_name) > 64 or len(raw_value) > 2048:
            raise WcsRequestError(
                "InvalidParameterValue", raw_name[:64], "The parameter exceeds its bound."
            )
        if name == "SUBSET":
            if len(raw_subsets) >= MAXIMUM_WCS_SUBSETS:
                raise WcsRequestError(
                    "InvalidParameterValue",
                    raw_name,
                    "The request exceeds the bounded number of subsets.",
                )
            raw_subsets.append(raw_value)
            spellings.setdefault(name, raw_name)
            continue
        if name in parameters:
            raise WcsRequestError(
                "InvalidParameterValue",
                raw_name,
                "Duplicate parameters are not accepted by this bounded WCS surface.",
            )
        parameters[name] = raw_value
        spellings[name] = raw_name

    service = parameters.get("SERVICE")
    if service is None:
        raise WcsRequestError("MissingParameterValue", "SERVICE", "SERVICE is required.")
    if service.upper() != "WCS":
        raise WcsRequestError("InvalidParameterValue", "SERVICE", "SERVICE must be WCS.")
    request = parameters.get("REQUEST")
    if request is None:
        raise WcsRequestError("MissingParameterValue", "REQUEST", "REQUEST is required.")
    operation = {
        "GETCAPABILITIES": "GetCapabilities",
        "DESCRIBECOVERAGE": "DescribeCoverage",
        "GETCOVERAGE": "GetCoverage",
    }.get(request.upper())
    if operation is None:
        raise WcsRequestError(
            "OperationNotSupported",
            "REQUEST",
            "Only WCS discovery and exact retrieval are supported.",
        )

    allowed = {
        "GetCapabilities": {"SERVICE", "REQUEST", "VERSION", "ACCEPTVERSIONS"},
        "DescribeCoverage": {"SERVICE", "REQUEST", "VERSION", "COVERAGEID"},
        "GetCoverage": {
            "SERVICE",
            "REQUEST",
            "VERSION",
            "COVERAGEID",
            "FORMAT",
            "MEDIATYPE",
            "SUBSET",
        },
    }[operation]
    present = tuple(parameters) + (("SUBSET",) if raw_subsets else ())
    unknown = next((name for name in present if name not in allowed), None)
    if unknown is not None:
        raise WcsRequestError(
            "InvalidParameterValue",
            spellings[unknown],
            "This parameter is outside the bounded exact-coverage profile.",
        )

    if operation == "GetCapabilities":
        version = parameters.get("VERSION")
        accepted = parameters.get("ACCEPTVERSIONS")
        if version is not None and version != WCS_VERSION:
            raise WcsRequestError(
                "VersionNegotiationFailed", "VERSION", f"Only {WCS_VERSION} is available."
            )
        if accepted is not None and WCS_VERSION not in {
            value.strip() for value in accepted.split(",")
        }:
            raise WcsRequestError(
                "VersionNegotiationFailed",
                "ACCEPTVERSIONS",
                f"Only {WCS_VERSION} is available.",
            )
        return WcsRequest(operation)

    if parameters.get("VERSION") != WCS_VERSION:
        code = "MissingParameterValue" if "VERSION" not in parameters else "InvalidParameterValue"
        raise WcsRequestError(code, "VERSION", f"VERSION must be {WCS_VERSION}.")
    coverage_id = parameters.get("COVERAGEID")
    if coverage_id is None:
        raise WcsRequestError("MissingParameterValue", "COVERAGEID", "COVERAGEID is required.")
    if operation == "DescribeCoverage":
        identifiers = tuple(coverage_id.split(","))
        if len(identifiers) > MAXIMUM_WCS_DESCRIPTIONS or any(
            not _is_coverage_identifier(identifier) for identifier in identifiers
        ):
            raise WcsRequestError(
                "InvalidParameterValue",
                "COVERAGEID",
                "Provide one to sixteen valid coverage identifiers.",
            )
        return WcsRequest(operation, coverage_id=identifiers[0], coverage_ids=identifiers)
    if not _is_coverage_identifier(coverage_id):
        raise WcsRequestError(
            "InvalidParameterValue", "COVERAGEID", "The coverage identifier is invalid."
        )
    output_format = parameters.get("FORMAT")
    if output_format is not None and output_format.lower() not in {"image/tiff", "image/geotiff"}:
        raise WcsRequestError(
            "InvalidParameterValue",
            "FORMAT",
            "Only exact GeoTIFF delivery is available.",
            status_code=501,
        )
    media_type = parameters.get("MEDIATYPE")
    if media_type is not None and media_type.lower() != "multipart/related":
        raise WcsRequestError(
            "InvalidParameterValue",
            "MEDIATYPE",
            "MEDIATYPE, when supplied, must be multipart/related.",
        )
    return WcsRequest(
        operation,
        coverage_id=coverage_id,
        format="image/tiff" if output_format is not None else None,
        media_type="multipart/related" if media_type is not None else None,
        subsets=tuple(_parse_subset(value) for value in raw_subsets),
    )


def plan_wcs_subsets(coverage: SpatialCoverage, subsets: tuple[WcsSubset, ...]) -> WcsSubsetPlan:
    west, south, east, north = (Decimal(str(value)) for value in coverage.extent)
    if coverage.crs.upper() == "EPSG:4326":
        axes = (("Lat", south, north, "y"), ("Long", west, east, "x"))
    else:
        axes = (("x", west, east, "x"), ("y", south, north, "y"))
    known = {name: (lower, upper, coordinate) for name, lower, upper, coordinate in axes}
    selected: dict[str, WcsSubset] = {}
    for subset in subsets:
        bounds = known.get(subset.dimension)
        if bounds is None:
            raise WcsRequestError(
                "InvalidAxisLabel",
                "SUBSET",
                f"{subset.dimension} is not an axis of the selected coverage.",
                status_code=404,
            )
        if subset.dimension in selected:
            raise WcsRequestError(
                "InvalidAxisLabel",
                "SUBSET",
                f"{subset.dimension} may be subset only once.",
                status_code=404,
            )
        axis_lower, axis_upper, coordinate = bounds
        pixels = coverage.width if coordinate == "x" else coverage.height
        # Native clients serialize binary floating-point bounds. Snap only a
        # few representational ULPs, capped far below a source pixel; this is
        # not permission to extend a requested window beyond the coverage.
        tolerance = min(
            Decimal(str(max(math.ulp(float(axis_lower)), math.ulp(float(axis_upper))) * 4)),
            (axis_upper - axis_lower) / pixels / Decimal("1000000000"),
        )

        def canonical_bound(
            value: Decimal,
            axis_lower: Decimal = axis_lower,
            axis_upper: Decimal = axis_upper,
            tolerance: Decimal = tolerance,
        ) -> Decimal:
            if abs(value - axis_lower) <= tolerance:
                return axis_lower
            if abs(value - axis_upper) <= tolerance:
                return axis_upper
            return value

        subset = WcsSubset(
            subset.dimension,
            canonical_bound(axis_lower if subset.lower == "*" else subset.lower),
            None
            if subset.upper is None
            else canonical_bound(axis_upper if subset.upper == "*" else subset.upper),
        )
        assert isinstance(subset.lower, Decimal)
        assert subset.upper is None or isinstance(subset.upper, Decimal)
        subset_upper = subset.lower if subset.upper is None else subset.upper
        if (
            subset.lower < axis_lower
            or subset.lower > axis_upper
            or subset_upper < axis_lower
            or subset_upper > axis_upper
            or subset.lower > subset_upper
        ):
            raise WcsRequestError(
                "InvalidSubsetting",
                "SUBSET",
                f"{subset.dimension} is outside the selected coverage envelope.",
                status_code=404,
            )
        selected[subset.dimension] = subset

    canonical = tuple(selected[name] for name, *_ in axes if name in selected)
    output = {"x": (west, east), "y": (south, north)}
    for subset in canonical:
        _, _, coordinate = known[subset.dimension]
        assert isinstance(subset.lower, Decimal)
        assert subset.upper is None or isinstance(subset.upper, Decimal)
        output[coordinate] = (
            subset.lower,
            subset.lower if subset.upper is None else subset.upper,
        )
    x_lower, x_upper = output["x"]
    y_lower, y_upper = output["y"]
    return WcsSubsetPlan(
        canonical,
        (float(x_lower), float(y_lower), float(x_upper), float(y_upper)),
        tuple(subset.dimension for subset in canonical if subset.upper is None),
        "|".join(_canonical_subset(subset) for subset in canonical),
    )


def wcs_subset_derivative_spec(
    coverage: SpatialCoverage, plan: WcsSubsetPlan
) -> CoverageDerivativeSpec:
    west, south, east, north = (Decimal(str(value)) for value in coverage.extent)
    requested_west, requested_south, requested_east, requested_north = (
        Decimal(str(value)) for value in plan.extent
    )
    pixel_width = (east - west) / coverage.width
    pixel_height = (north - south) / coverage.height

    output_west, output_east, width = _materialize_wcs_axis(
        requested_west,
        requested_east,
        west,
        east,
        pixel_width,
        coverage.width,
        is_slice=("Long" if coverage.crs.upper() == "EPSG:4326" else "x") in plan.sliced_axes,
    )
    output_south, output_north, height = _materialize_wcs_axis(
        requested_south,
        requested_north,
        south,
        north,
        pixel_height,
        coverage.height,
        is_slice=("Lat" if coverage.crs.upper() == "EPSG:4326" else "y") in plan.sliced_axes,
    )
    return CoverageDerivativeSpec(
        subset_extent=(
            float(output_west),
            float(output_south),
            float(output_east),
            float(output_north),
        ),
        target_crs=coverage.crs,
        width=width,
        height=height,
        resolution=None,
        band_indexes=None,
        resampling="nearest",
    )


def capabilities_xml(
    service_title: str,
    service_description: str | None,
    endpoint: str,
    coverages: tuple[SpatialCoverage, ...],
    *,
    profiles: tuple[str, ...] = (),
) -> bytes:
    root = ET.Element(
        _q(WCS_NS, "Capabilities"),
        {
            "version": WCS_VERSION,
            _q(XSI_NS, "schemaLocation"): (
                f"{WCS_NS} https://schemas.opengis.net/wcs/2.0/wcsAll.xsd"
            ),
        },
    )
    identification = ET.SubElement(root, _q(OWS_NS, "ServiceIdentification"))
    _text(identification, OWS_NS, "Title", service_title)
    if service_description:
        _text(identification, OWS_NS, "Abstract", service_description)
    _text(identification, OWS_NS, "ServiceType", "WCS")
    _text(identification, OWS_NS, "ServiceTypeVersion", WCS_VERSION)
    for profile in profiles:
        if profile not in {WCS_GET_KVP_PROFILE, WCS_GML_PROFILE}:
            raise ValueError("unsupported WCS profile declaration")
        _text(identification, OWS_NS, "Profile", profile)

    operations = ET.SubElement(root, _q(OWS_NS, "OperationsMetadata"))
    for name in ("GetCapabilities", "DescribeCoverage", "GetCoverage"):
        operation = ET.SubElement(operations, _q(OWS_NS, "Operation"), {"name": name})
        dcp = ET.SubElement(operation, _q(OWS_NS, "DCP"))
        http = ET.SubElement(dcp, _q(OWS_NS, "HTTP"))
        ET.SubElement(http, _q(OWS_NS, "Get"), {_q(XLINK_NS, "href"): endpoint})

    metadata = ET.SubElement(root, _q(WCS_NS, "ServiceMetadata"))
    _text(metadata, WCS_NS, "formatSupported", "image/tiff")
    contents = ET.SubElement(root, _q(WCS_NS, "Contents"))
    for coverage in coverages:
        summary = ET.SubElement(contents, _q(WCS_NS, "CoverageSummary"))
        _text(summary, WCS_NS, "CoverageId", coverage.coverage_name)
        _text(summary, WCS_NS, "CoverageSubtype", "RectifiedGridCoverage")
    return _serialize(root)


def describe_coverages_xml(coverages: tuple[SpatialCoverage, ...]) -> bytes:
    if not 1 <= len(coverages) <= MAXIMUM_WCS_DESCRIPTIONS:
        raise ValueError("WCS descriptions exceed the bounded response size")
    if len(coverages) == 1:
        return describe_coverage_xml(coverages[0])
    root = ET.fromstring(describe_coverage_xml(coverages[0]))
    del root[:]
    for index, coverage in enumerate(coverages):
        document = ET.fromstring(describe_coverage_xml(coverage))
        for node in document.iter():
            if _q(GML_NS, "id") in node.attrib:
                node.attrib[_q(GML_NS, "id")] += f"-description-{index}"
        root.extend(document)
    return _serialize(root)


def describe_coverage_xml(coverage: SpatialCoverage) -> bytes:
    x_resolution = (coverage.extent[2] - coverage.extent[0]) / coverage.width
    y_resolution = (coverage.extent[3] - coverage.extent[1]) / coverage.height
    lower_corner = (coverage.extent[0], coverage.extent[1])
    upper_corner = (coverage.extent[2], coverage.extent[3])
    origin_coordinates = (
        coverage.extent[0] + x_resolution / 2,
        coverage.extent[3] - y_resolution / 2,
    )
    column_offset = (x_resolution, 0.0)
    row_offset = (0.0, -y_resolution)
    envelope_axis_labels = "x y"
    if coverage.crs.upper() == "EPSG:4326":
        # EPSG:4326 has latitude/longitude authority order. Dataset extents and
        # raster grid transforms use traditional GIS x/y order, so serialize
        # GML coordinate tuples and vectors in the CRS's declared axis order.
        lower_corner = (lower_corner[1], lower_corner[0])
        upper_corner = (upper_corner[1], upper_corner[0])
        origin_coordinates = (origin_coordinates[1], origin_coordinates[0])
        column_offset = (column_offset[1], column_offset[0])
        row_offset = (row_offset[1], row_offset[0])
        envelope_axis_labels = "Lat Long"

    root = ET.Element(
        _q(WCS_NS, "CoverageDescriptions"),
        {
            _q(XSI_NS, "schemaLocation"): (
                f"{WCS_NS} https://schemas.opengis.net/wcs/2.0/wcsDescribeCoverage.xsd"
            )
        },
    )
    description = ET.SubElement(
        root,
        _q(WCS_NS, "CoverageDescription"),
        {_q(GML_NS, "id"): f"coverage-{coverage.coverage_name}"},
    )
    bounded = ET.SubElement(description, _q(GML_NS, "boundedBy"))
    envelope = ET.SubElement(
        bounded,
        _q(GML_NS, "Envelope"),
        {
            "srsName": _crs_uri(coverage.crs),
            "axisLabels": envelope_axis_labels,
            "srsDimension": "2",
        },
    )
    _text(envelope, GML_NS, "lowerCorner", _pair(*lower_corner))
    _text(envelope, GML_NS, "upperCorner", _pair(*upper_corner))
    _text(description, WCS_NS, "CoverageId", coverage.coverage_name)

    function = ET.SubElement(description, _q(GML_NS, "coverageFunction"))
    grid_function = ET.SubElement(function, _q(GML_NS, "GridFunction"))
    sequence = ET.SubElement(grid_function, _q(GML_NS, "sequenceRule"), {"axisOrder": "+1 +2"})
    sequence.text = "Linear"
    _text(grid_function, GML_NS, "startPoint", "0 0")

    domain = ET.SubElement(description, _q(GML_NS, "domainSet"))
    grid = ET.SubElement(
        domain,
        _q(GML_NS, "RectifiedGrid"),
        {_q(GML_NS, "id"): f"grid-{coverage.coverage_name}", "dimension": "2"},
    )
    limits = ET.SubElement(grid, _q(GML_NS, "limits"))
    envelope_grid = ET.SubElement(limits, _q(GML_NS, "GridEnvelope"))
    _text(envelope_grid, GML_NS, "low", "0 0")
    _text(envelope_grid, GML_NS, "high", f"{coverage.width - 1} {coverage.height - 1}")
    _text(grid, GML_NS, "axisLabels", "x y")
    origin = ET.SubElement(grid, _q(GML_NS, "origin"))
    point = ET.SubElement(
        origin,
        _q(GML_NS, "Point"),
        {_q(GML_NS, "id"): f"origin-{coverage.coverage_name}", "srsName": _crs_uri(coverage.crs)},
    )
    _text(
        point,
        GML_NS,
        "pos",
        _pair(*origin_coordinates),
    )
    _text(grid, GML_NS, "offsetVector", _pair(*column_offset))
    _text(grid, GML_NS, "offsetVector", _pair(*row_offset))

    range_type = ET.SubElement(description, _q(GMLCOV_NS, "rangeType"))
    record = ET.SubElement(range_type, _q(SWE_NS, "DataRecord"))
    for index, band in enumerate(coverage.bands, start=1):
        band_index = band.get("index")
        name = f"band-{band_index if isinstance(band_index, int) else index}"
        field = ET.SubElement(record, _q(SWE_NS, "field"), {"name": name})
        quantity = ET.SubElement(field, _q(SWE_NS, "Quantity"))
        label = band.get("color_interpretation")
        _text(quantity, SWE_NS, "label", str(label) if label else name)
        ET.SubElement(quantity, _q(SWE_NS, "uom"), {"code": "1"})
        constraint = ET.SubElement(quantity, _q(SWE_NS, "constraint"))
        allowed = ET.SubElement(constraint, _q(SWE_NS, "AllowedValues"))
        data_type = band.get("data_type")
        _text(allowed, SWE_NS, "interval", _band_interval(data_type))

    parameters = ET.SubElement(description, _q(WCS_NS, "ServiceParameters"))
    _text(parameters, WCS_NS, "CoverageSubtype", "RectifiedGridCoverage")
    _text(parameters, WCS_NS, "nativeFormat", "image/tiff")
    return _serialize(root)


def coverage_result_xml(view: WcsCoverageView, content_id: str) -> bytes:
    x_resolution = (view.extent[2] - view.extent[0]) / view.width
    y_resolution = (view.extent[3] - view.extent[1]) / view.height
    lower_corner = (view.extent[0], view.extent[1])
    upper_corner = (view.extent[2], view.extent[3])
    origin_coordinates = (
        view.extent[0] + x_resolution / 2,
        view.extent[3] - y_resolution / 2,
    )
    column_offset = (x_resolution, 0.0)
    row_offset = (0.0, -y_resolution)
    envelope_axis_labels = "x y"
    if view.crs.upper() == "EPSG:4326":
        lower_corner = (lower_corner[1], lower_corner[0])
        upper_corner = (upper_corner[1], upper_corner[0])
        origin_coordinates = (origin_coordinates[1], origin_coordinates[0])
        column_offset = (column_offset[1], column_offset[0])
        row_offset = (row_offset[1], row_offset[0])
        envelope_axis_labels = "Lat Long"

    root = ET.Element(
        _q(GMLCOV_NS, "RectifiedGridCoverage"),
        {
            _q(GML_NS, "id"): f"coverage-{view.coverage_id}",
            _q(XSI_NS, "schemaLocation"): (
                f"{GMLCOV_NS} https://schemas.opengis.net/gmlcov/1.0/gmlcovAll.xsd"
            ),
        },
    )
    bounded = ET.SubElement(root, _q(GML_NS, "boundedBy"))
    envelope = ET.SubElement(
        bounded,
        _q(GML_NS, "Envelope"),
        {
            "srsName": _crs_uri(view.crs),
            "axisLabels": envelope_axis_labels,
            "srsDimension": "2",
        },
    )
    _text(envelope, GML_NS, "lowerCorner", _pair(*lower_corner))
    _text(envelope, GML_NS, "upperCorner", _pair(*upper_corner))

    domain = ET.SubElement(root, _q(GML_NS, "domainSet"))
    grid = ET.SubElement(
        domain,
        _q(GML_NS, "RectifiedGrid"),
        {_q(GML_NS, "id"): f"grid-{view.coverage_id}", "dimension": "2"},
    )
    limits = ET.SubElement(grid, _q(GML_NS, "limits"))
    grid_envelope = ET.SubElement(limits, _q(GML_NS, "GridEnvelope"))
    _text(grid_envelope, GML_NS, "low", "0 0")
    _text(grid_envelope, GML_NS, "high", f"{view.width - 1} {view.height - 1}")
    _text(grid, GML_NS, "axisLabels", "x y")
    origin = ET.SubElement(grid, _q(GML_NS, "origin"))
    point = ET.SubElement(
        origin,
        _q(GML_NS, "Point"),
        {
            _q(GML_NS, "id"): f"origin-{view.coverage_id}",
            "srsName": _crs_uri(view.crs),
        },
    )
    _text(point, GML_NS, "pos", _pair(*origin_coordinates))
    _text(grid, GML_NS, "offsetVector", _pair(*column_offset))
    _text(grid, GML_NS, "offsetVector", _pair(*row_offset))

    range_set = ET.SubElement(root, _q(GML_NS, "rangeSet"))
    file_element = ET.SubElement(range_set, _q(GML_NS, "File"))
    ET.SubElement(
        file_element,
        _q(GML_NS, "rangeParameters"),
        {
            _q(XLINK_NS, "href"): f"cid:{content_id}",
            _q(XLINK_NS, "role"): (
                "http://www.opengis.net/spec/WCS_coverage-encoding_geotiff/1.0/"
            ),
            _q(XLINK_NS, "arcrole"): "fileReference",
        },
    )
    _text(file_element, GML_NS, "fileReference", f"cid:{content_id}")
    ET.SubElement(file_element, _q(GML_NS, "fileStructure"))
    _text(file_element, GML_NS, "mimeType", "image/tiff")

    function = ET.SubElement(root, _q(GML_NS, "coverageFunction"))
    grid_function = ET.SubElement(function, _q(GML_NS, "GridFunction"))
    sequence = ET.SubElement(grid_function, _q(GML_NS, "sequenceRule"), {"axisOrder": "+1 +2"})
    sequence.text = "Linear"
    _text(grid_function, GML_NS, "startPoint", "0 0")

    range_type = ET.SubElement(root, _q(GMLCOV_NS, "rangeType"))
    record = ET.SubElement(range_type, _q(SWE_NS, "DataRecord"))
    for index, band in enumerate(view.bands, start=1):
        band_index = band.get("index")
        name = f"band-{band_index if isinstance(band_index, int) else index}"
        field = ET.SubElement(record, _q(SWE_NS, "field"), {"name": name})
        quantity = ET.SubElement(field, _q(SWE_NS, "Quantity"))
        label = band.get("color_interpretation")
        _text(quantity, SWE_NS, "label", str(label) if label else name)
        ET.SubElement(quantity, _q(SWE_NS, "uom"), {"code": "1"})
        constraint = ET.SubElement(quantity, _q(SWE_NS, "constraint"))
        allowed = ET.SubElement(constraint, _q(SWE_NS, "AllowedValues"))
        _text(allowed, SWE_NS, "interval", _band_interval(band.get("data_type")))
    return _serialize(root)


def multipart_coverage_response(
    view: WcsCoverageView,
    raster: bytes,
    checksum_sha256: str,
) -> tuple[bytes, str]:
    raster_content_id = f"{view.coverage_id}.tif"
    document_content_id = f"{view.coverage_id}.xml"
    document = coverage_result_xml(view, raster_content_id)
    seed = hashlib.sha256(document + checksum_sha256.encode("ascii")).hexdigest()[:32]
    boundary = f"opengeo-wcs-{seed}"
    while boundary.encode("ascii") in document or boundary.encode("ascii") in raster:
        boundary += "x"
    body = b"".join(
        (
            f"--{boundary}\r\n".encode("ascii"),
            b"Content-Type: application/gml+xml\r\n",
            f"Content-ID: <{document_content_id}>\r\n\r\n".encode("ascii"),
            document,
            b"\r\n",
            f"--{boundary}\r\n".encode("ascii"),
            b"Content-Type: image/tiff\r\n",
            b"Content-Transfer-Encoding: binary\r\n",
            f"Content-ID: <{raster_content_id}>\r\n\r\n".encode("ascii"),
            raster,
            b"\r\n",
            f"--{boundary}--\r\n".encode("ascii"),
        )
    )
    content_type = (
        f'multipart/related; type="application/gml+xml"; '
        f'start="<{document_content_id}>"; boundary={boundary}'
    )
    return body, content_type


def exception_report_xml(error: WcsRequestError) -> bytes:
    root = ET.Element(
        _q(OWS_NS, "ExceptionReport"),
        {
            "version": "2.0.0",
            _q(XSI_NS, "schemaLocation"): (
                f"{OWS_NS} https://schemas.opengis.net/ows/2.0/owsExceptionReport.xsd"
            ),
        },
    )
    exception = ET.SubElement(
        root,
        _q(OWS_NS, "Exception"),
        {"exceptionCode": error.code, "locator": error.locator},
    )
    _text(exception, OWS_NS, "ExceptionText", error.message)
    return _serialize(root)


def _materialize_wcs_axis(
    requested_lower: Decimal,
    requested_upper: Decimal,
    source_lower: Decimal,
    source_upper: Decimal,
    pixel_size: Decimal,
    source_pixels: int,
    *,
    is_slice: bool,
) -> tuple[Decimal, Decimal, int]:
    if not is_slice:
        # WCS Core trimming selects existing grid points in a closed interval;
        # it does not rescale the requested rectangle onto a new grid.
        first = int(
            (((requested_lower - source_lower) / pixel_size) - Decimal("0.5")).to_integral_value(
                rounding=ROUND_CEILING
            )
        )
        last = int(
            (((requested_upper - source_lower) / pixel_size) - Decimal("0.5")).to_integral_value(
                rounding=ROUND_FLOOR
            )
        )
        first, last = max(0, first), min(source_pixels - 1, last)
        if first > last:
            raise WcsRequestError(
                "InvalidSubsetting",
                "SUBSET",
                "The trim contains no source grid points.",
                status_code=404,
            )
        return (
            source_lower + pixel_size * first,
            source_lower + pixel_size * (last + 1),
            last - first + 1,
        )

    index = int(
        ((requested_lower - source_lower) / pixel_size).to_integral_value(rounding=ROUND_FLOOR)
    )
    index = min(max(index, 0), source_pixels - 1)
    lower = source_lower + pixel_size * index
    upper = min(source_upper, lower + pixel_size)
    return lower, upper, 1


def _parse_subset(value: str) -> WcsSubset:
    match = re.fullmatch(
        r"([A-Za-z_][A-Za-z0-9_.-]{0,63})\(([^,()]+)(?:,([^,()]+))?\)",
        value.strip(),
    )
    if match is None:
        raise WcsRequestError(
            "InvalidParameterValue",
            "SUBSET",
            "SUBSET must be an axis trim or slice in native coverage coordinates.",
        )
    dimension, raw_lower, raw_upper = match.groups()
    try:
        lower: Decimal | Literal["*"] = (
            "*" if raw_lower.strip() == "*" else Decimal(raw_lower.strip())
        )
        upper: Decimal | Literal["*"] | None = (
            None
            if raw_upper is None
            else "*"
            if raw_upper.strip() == "*"
            else Decimal(raw_upper.strip())
        )
    except InvalidOperation as error:
        raise WcsRequestError(
            "InvalidParameterValue", "SUBSET", "SUBSET coordinates must be numeric."
        ) from error
    if (
        (lower == "*" and upper is None)
        or (isinstance(lower, Decimal) and not lower.is_finite())
        or (isinstance(upper, Decimal) and not upper.is_finite())
    ):
        raise WcsRequestError(
            "InvalidParameterValue",
            "SUBSET",
            "SUBSET coordinates must be finite; * is allowed only as a trim bound.",
        )
    return WcsSubset(dimension, lower, upper)


def _canonical_subset(subset: WcsSubset) -> str:
    lower = "*" if subset.lower == "*" else _decimal_text(subset.lower)
    if subset.upper is None:
        return f"{subset.dimension}({lower})"
    upper = "*" if subset.upper == "*" else _decimal_text(subset.upper)
    return f"{subset.dimension}({lower},{upper})"


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    if normalized == 0:
        return "0"
    return format(normalized, "f")


def _is_coverage_identifier(value: str) -> bool:
    return re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value) is not None


def _crs_uri(crs: str) -> str:
    authority, separator, code = crs.upper().partition(":")
    if separator and authority == "EPSG" and code.isdigit():
        return f"http://www.opengis.net/def/crs/EPSG/0/{code}"
    return crs


def _band_interval(data_type: object) -> str:
    default = "-1.7976931348623157e308 1.7976931348623157e308"
    if not isinstance(data_type, str):
        return default
    return {
        "Byte": "0 255",
        "UInt16": "0 65535",
        "Int16": "-32768 32767",
        "UInt32": "0 4294967295",
        "Int32": "-2147483648 2147483647",
        "Float32": "-3.4028235e38 3.4028235e38",
        "Float64": "-1.7976931348623157e308 1.7976931348623157e308",
    }.get(data_type, default)


def _pair(first: float, second: float) -> str:
    return f"{format(first, '.15g')} {format(second, '.15g')}"


def _q(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _text(parent: ET.Element, namespace: str, name: str, value: str) -> ET.Element:
    child = ET.SubElement(parent, _q(namespace, name))
    child.text = value
    return child


def _serialize(root: ET.Element) -> bytes:
    serialized = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    if not isinstance(serialized, bytes):
        raise TypeError("XML byte serialization failed")
    return serialized
