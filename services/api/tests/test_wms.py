from uuid import UUID
from xml.etree import ElementTree as ET

import pytest

from opengeo_api.wms import (
    OGC_NAMESPACE,
    WMS_CRS84,
    WMS_EPSG3857,
    WMS_EPSG4326,
    WMS_MEDIA_TYPES,
    WMS_NAMESPACE,
    WMS_VERSION_111,
    WmsCapabilitiesRequest,
    WmsLayer,
    WmsMapRequest,
    WmsRequestError,
    WmsStyle,
    capabilities_xml,
    exception_xml,
    parse_wms_request,
)

LAYER_ID = UUID("a0000000-0000-4000-8000-0000000000c1")
STYLE_ID = UUID("a1000000-0000-4000-8000-0000000000c1")
SECOND_LAYER_ID = UUID("a0000000-0000-4000-8000-0000000000c2")
SECOND_STYLE_ID = UUID("a1000000-0000-4000-8000-0000000000c2")


def map_parameters() -> list[tuple[str, str]]:
    return [
        ("service", "wms"),
        ("VERSION", "1.3.0"),
        ("Request", "GetMap"),
        ("LAYERS", str(LAYER_ID)),
        ("STYLES", str(STYLE_ID)),
        ("CRS", "CRS:84"),
        ("BBOX", "84,27,86,29"),
        ("WIDTH", "800"),
        ("HEIGHT", "600"),
        ("FORMAT", "image/svg+xml"),
        ("TRANSPARENT", "FALSE"),
        ("BGCOLOR", "0xFFFFFF"),
        ("EXCEPTIONS", "XML"),
    ]


def legacy_map_parameters() -> list[tuple[str, str]]:
    return [
        ("SERVICE", "WMS"),
        ("VERSION", "1.1.1"),
        ("REQUEST", "GetMap"),
        ("LAYERS", str(LAYER_ID)),
        ("STYLES", ""),
        ("SRS", "EPSG:4326"),
        ("BBOX", "84,27,86,29"),
        ("WIDTH", "800"),
        ("HEIGHT", "600"),
        ("FORMAT", "image/png"),
        ("TRANSPARENT", "TRUE"),
    ]


def test_wms_kvp_parses_case_insensitive_names_and_bounded_getmap() -> None:
    request = parse_wms_request(map_parameters())

    assert request == WmsMapRequest(
        layer_id=str(LAYER_ID),
        style_id=STYLE_ID,
        bbox=(84.0, 27.0, 86.0, 29.0),
        crs="CRS:84",
        width=800,
        height=600,
        format="svg",
        background_color="#ffffff",
        transparent=False,
    )


def test_wms_getmap_allows_omitted_service_but_rejects_an_explicit_wrong_service() -> None:
    parameters = [item for item in map_parameters() if item[0].upper() != "SERVICE"]

    assert parse_wms_request(parameters) == parse_wms_request(map_parameters())

    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request([*parameters, ("SERVICE", "WFS")])
    assert raised.value.code == "InvalidParameterValue"
    assert raised.value.locator == "SERVICE"


def test_wms_111_getmap_translates_srs_and_longitude_latitude_axis_order() -> None:
    request = parse_wms_request(legacy_map_parameters())

    assert request == WmsMapRequest(
        layer_id=str(LAYER_ID),
        style_id=None,
        bbox=(84.0, 27.0, 86.0, 29.0),
        crs="CRS:84",
        width=800,
        height=600,
        format="png",
        background_color="#ffffff",
        transparent=True,
        version="1.1.1",
    )


def test_wms_111_getmap_accepts_web_mercator_and_rejects_crs_parameter_ambiguity() -> None:
    parameters = dict(legacy_map_parameters())
    parameters.update(SRS="EPSG:3857", BBOX="9000000,3000000,10000000,4000000")
    request = parse_wms_request(parameters.items())

    assert isinstance(request, WmsMapRequest)
    assert request.crs == "EPSG:3857"
    assert request.version == WMS_VERSION_111

    parameters["CRS"] = "CRS:84"
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters.items())
    assert raised.value.code == "InvalidParameterValue"
    assert raised.value.locator == "CRS"


def test_wms_111_rejects_unadvertised_srs_with_legacy_exception_code() -> None:
    parameters = dict(legacy_map_parameters())
    parameters["SRS"] = "EPSG:4322"

    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters.items())

    assert raised.value.code == "InvalidSRS"
    assert raised.value.locator == "SRS"


def test_wms_getmap_accepts_exponent_and_outside_domain_bbox_with_numeric_bound() -> None:
    parameters = dict(map_parameters())
    parameters["BBOX"] = "-1E1,9E1,+1E1,1.1E2"

    request = parse_wms_request(parameters.items())

    assert isinstance(request, WmsMapRequest)
    assert request.bbox == (-10.0, 90.0, 10.0, 110.0)

    parameters["BBOX"] = "-1E10,90,10,110"
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters.items())
    assert raised.value.code == "InvalidParameterValue"
    assert raised.value.locator == "BBOX"


def test_wms_missing_request_uses_the_required_exception_code() -> None:
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request([("SERVICE", "WMS")])

    assert raised.value.code == "MissingParameterValue"
    assert raised.value.locator == "REQUEST"


def test_wms_getcapabilities_negotiates_one_version_and_ignores_optional_hints() -> None:
    assert (
        parse_wms_request([("SERVICE", "WMS"), ("REQUEST", "GetCapabilities")])
        == WmsCapabilitiesRequest()
    )
    assert (
        parse_wms_request(
            [
                ("SERVICE", "WMS"),
                ("REQUEST", "getcapabilities"),
                ("VERSION", "100.0.0"),
                ("FORMAT", "not/a-format"),
                ("UPDATESEQUENCE", "ignored-because-none-is-advertised"),
            ]
        )
        == WmsCapabilitiesRequest()
    )

    with pytest.raises(WmsRequestError, match="three integer components") as raised:
        parse_wms_request([("SERVICE", "WMS"), ("REQUEST", "GetCapabilities"), ("VERSION", "one")])
    assert raised.value.code == "InvalidParameterValue"


def test_wms_getcapabilities_negotiates_exact_legacy_version() -> None:
    assert parse_wms_request(
        [("SERVICE", "WMS"), ("REQUEST", "GetCapabilities"), ("VERSION", "1.1.1")]
    ) == WmsCapabilitiesRequest(version="1.1.1")


def test_wms_non_advertised_getfeatureinfo_is_explicitly_unsupported() -> None:
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request([("SERVICE", "WMS"), ("VERSION", "1.3.0"), ("REQUEST", "GetFeatureInfo")])

    assert raised.value.code == "OperationNotSupported"
    assert raised.value.locator == "REQUEST"


@pytest.mark.parametrize(
    ("replacement", "code", "locator"),
    [
        (("CRS", "EPSG:4326"), "InvalidCRS", "CRS"),
        (("BBOX", "86,27,84,29"), "InvalidParameterValue", "BBOX"),
        (("WIDTH", "0"), "InvalidParameterValue", "WIDTH"),
        (("HEIGHT", "2049"), "InvalidParameterValue", "HEIGHT"),
        (("FORMAT", "image/jpeg"), "InvalidFormat", "FORMAT"),
        (("TRANSPARENT", "sometimes"), "InvalidParameterValue", "TRANSPARENT"),
        (("BGCOLOR", "#000000"), "InvalidParameterValue", "BGCOLOR"),
        (("LAYERS", "not/a/layer"), "LayerNotDefined", "LAYERS"),
        (("STYLES", "not-a-style"), "StyleNotDefined", "STYLES"),
    ],
)
def test_wms_getmap_rejects_unsupported_or_ambiguous_parameters(
    replacement: tuple[str, str], code: str, locator: str
) -> None:
    parameters = [item for item in map_parameters() if item[0].upper() != replacement[0]]
    parameters.append(replacement)

    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters)

    assert raised.value.code == code
    assert raised.value.locator == locator


def test_wms_getmap_supports_default_style_and_tolerates_unknown_parameters() -> None:
    default_parameters = [
        (name, "" if name.upper() == "STYLES" else value) for name, value in map_parameters()
    ]
    request = parse_wms_request(default_parameters)
    assert isinstance(request, WmsMapRequest)
    assert request.style_id is None
    widened = parse_wms_request([*map_parameters(), ("TIME", "2026-08-20")])
    assert isinstance(widened, WmsMapRequest)

    for extra in (
        [("SERVICE", "WMS")],
        [("LAYERS", str(LAYER_ID))],
    ):
        with pytest.raises(WmsRequestError, match="parameter"):
            parse_wms_request([*map_parameters(), *extra])


def test_project_wms_parses_ordered_multi_layer_and_style_pairs_with_limit() -> None:
    parameters = dict(map_parameters())
    parameters["LAYERS"] = f"{LAYER_ID},{SECOND_LAYER_ID}"
    parameters["STYLES"] = f",{SECOND_STYLE_ID}"

    request = parse_wms_request(parameters.items(), layer_limit=16)

    assert isinstance(request, WmsMapRequest)
    assert request.layers == (
        (str(LAYER_ID), None),
        (str(SECOND_LAYER_ID), SECOND_STYLE_ID),
    )
    parameters["STYLES"] = ""
    defaults = parse_wms_request(parameters.items(), layer_limit=16)
    assert isinstance(defaults, WmsMapRequest)
    assert defaults.layers == (
        (str(LAYER_ID), None),
        (str(SECOND_LAYER_ID), None),
    )
    parameters["STYLES"] = str(STYLE_ID)
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters.items(), layer_limit=16)
    assert raised.value.code == "StyleNotDefined"
    parameters["STYLES"] = f",{SECOND_STYLE_ID}"
    with pytest.raises(WmsRequestError) as raised:
        parse_wms_request(parameters.items())
    assert raised.value.code == "LayerNotDefined"

    parameters["LAYERS"] = f"{LAYER_ID},{LAYER_ID}"
    parameters["STYLES"] = f"{STYLE_ID},{STYLE_ID}"
    repeated = parse_wms_request(parameters.items(), layer_limit=16)
    assert isinstance(repeated, WmsMapRequest)
    assert repeated.layers == (
        (str(LAYER_ID), STYLE_ID),
        (str(LAYER_ID), STYLE_ID),
    )


def test_project_wms_layer_limit_accepts_sixteen_bounded_uuid_style_pairs() -> None:
    parameters = dict(map_parameters())
    parameters["LAYERS"] = ",".join([str(LAYER_ID)] * 16)
    parameters["STYLES"] = ",".join([str(STYLE_ID)] * 16)

    request = parse_wms_request(parameters.items(), layer_limit=16)

    assert isinstance(request, WmsMapRequest)
    assert len(request.layers) == 16

    parameters["STYLES"] = "a" * 4_097
    with pytest.raises(WmsRequestError, match="invalid parameter"):
        parse_wms_request(parameters.items(), layer_limit=16)


def test_project_wms_preserves_exact_qualified_publication_names() -> None:
    parameters = dict(map_parameters())
    parameters["LAYERS"] = "cite:MapNeatline,cite:Lakes"
    parameters["STYLES"] = ","

    request = parse_wms_request(parameters.items(), layer_limit=16)

    assert isinstance(request, WmsMapRequest)
    assert request.layers == (("cite:MapNeatline", None), ("cite:Lakes", None))
    for invalid in ("cite:", ":Lakes", "cite/Lakes", " cite:Lakes", "cite:Lakes "):
        parameters["LAYERS"] = invalid
        parameters["STYLES"] = ""
        with pytest.raises(WmsRequestError) as raised:
            parse_wms_request(parameters.items(), layer_limit=16)
        assert raised.value.code == "LayerNotDefined"


def test_project_capabilities_advertise_ordered_catalog_and_layer_limit() -> None:
    document = capabilities_xml(
        (
            WmsLayer(
                name=str(LAYER_ID),
                title="Roads",
                abstract=None,
                attribution=None,
                bbox=(84.0, 27.0, 86.0, 29.0),
                styles=(WmsStyle(str(STYLE_ID), "Roads"),),
            ),
            WmsLayer(
                name=str(SECOND_LAYER_ID),
                title="Lakes",
                abstract=None,
                attribution=None,
                bbox=(83.0, 26.0, 87.0, 30.0),
                styles=(WmsStyle(str(SECOND_STYLE_ID), "Lakes"),),
            ),
        ),
        "https://api.example.test/projects/p/wms",
        service_title="Research project",
        layer_limit=16,
    )

    root = ET.fromstring(document)
    namespace = {"wms": WMS_NAMESPACE}
    assert root.findtext("wms:Service/wms:Title", namespaces=namespace) == (
        "OpenGeo — Research project"
    )
    assert root.findtext("wms:Service/wms:LayerLimit", namespaces=namespace) == "16"
    children = root.findall("wms:Capability/wms:Layer/wms:Layer", namespace)
    assert [child.findtext("wms:Name", namespaces=namespace) for child in children] == [
        str(LAYER_ID),
        str(SECOND_LAYER_ID),
    ]


def test_wms_getmap_accepts_bounded_epsg3857_png() -> None:
    parameters = dict(map_parameters())
    parameters.update(
        CRS="EPSG:3857",
        BBOX="9000000,3000000,10000000,4000000",
        FORMAT="image/png",
    )

    request = parse_wms_request(parameters.items())

    assert isinstance(request, WmsMapRequest)
    assert request.crs == "EPSG:3857"
    assert request.format == "png"
    assert request.bbox == (9_000_000.0, 3_000_000.0, 10_000_000.0, 4_000_000.0)


@pytest.mark.parametrize("value", ["TRUE", "true", "1"])
def test_wms_getmap_honors_transparent_png_background_and_one_pixel_dimensions(
    value: str,
) -> None:
    parameters = dict(map_parameters())
    parameters.update(
        WIDTH="+1",
        HEIGHT="1",
        FORMAT="image/png",
        TRANSPARENT=value,
        BGCOLOR="0X10aBcF",
        EXCEPTIONS="INIMAGE",
        VENDOR_HINT="bounded-and-ignored",
    )

    request = parse_wms_request(parameters.items())

    assert isinstance(request, WmsMapRequest)
    assert request.width == 1
    assert request.height == 1
    assert request.background_color == "#10abcf"
    assert request.transparent is True


def test_capabilities_xml_advertises_exact_layer_style_extent_and_operations_safely() -> None:
    document = capabilities_xml(
        WmsLayer(
            name=str(LAYER_ID),
            title="Roads <review>",
            abstract="Curated & governed",
            attribution="Open data office",
            bbox=(84.0, 27.0, 86.0, 29.0),
            styles=(WmsStyle(str(STYLE_ID), "Roads SVG"),),
        ),
        "https://api.example.test/projects/p/resources/r/wms",
    )

    assert b"Roads &lt;review&gt;" in document
    assert b"Curated &amp; governed" in document
    root = ET.fromstring(document)
    namespace = {"wms": WMS_NAMESPACE}
    assert root.tag == f"{{{WMS_NAMESPACE}}}WMS_Capabilities"
    assert root.attrib["version"] == "1.3.0"
    assert root.findtext("wms:Service/wms:Name", namespaces=namespace) == "WMS"
    assert root.findtext("wms:Service/wms:LayerLimit", namespaces=namespace) == "1"
    assert root.findtext("wms:Service/wms:MaxWidth", namespaces=namespace) == "2048"
    assert root.findtext("wms:Service/wms:MaxHeight", namespaces=namespace) == "2048"
    assert {
        element.text
        for element in root.findall("wms:Capability/wms:Request/wms:GetMap/wms:Format", namespace)
    } == set(WMS_MEDIA_TYPES.values())
    assert (
        root.findtext("wms:Capability/wms:Request/wms:GetMap/wms:Format", namespaces=namespace)
        == "image/png"
    )
    assert {
        element.text for element in root.findall("wms:Capability/wms:Layer/wms:CRS", namespace)
    } == {WMS_CRS84, WMS_EPSG3857}
    child = root.findall("wms:Capability/wms:Layer/wms:Layer", namespace)[0]
    assert child.attrib["queryable"] == "0"
    assert child.attrib["opaque"] == "0"
    assert child.findtext("wms:Name", namespaces=namespace) == str(LAYER_ID)
    assert {element.text for element in child.findall("wms:CRS", namespace)} == {
        WMS_CRS84,
        WMS_EPSG3857,
    }
    bounding_boxes = {
        element.attrib["CRS"]: element.attrib
        for element in child.findall("wms:BoundingBox", namespace)
    }
    assert bounding_boxes[WMS_CRS84] == {
        "CRS": WMS_CRS84,
        "minx": "84",
        "miny": "27",
        "maxx": "86",
        "maxy": "29",
    }
    assert float(bounding_boxes[WMS_EPSG3857]["minx"]) == pytest.approx(9_350_837.226634981)
    assert child.findtext("wms:Style/wms:Name", namespaces=namespace) == str(STYLE_ID)


def test_wms_111_capabilities_advertise_legacy_root_srs_and_exact_layers() -> None:
    document = capabilities_xml(
        WmsLayer(
            name=str(LAYER_ID),
            title="Roads <review>",
            abstract="Curated & governed",
            attribution="Open data office",
            bbox=(84.0, 27.0, 86.0, 29.0),
            styles=(WmsStyle(str(STYLE_ID), "Roads PNG"),),
        ),
        "https://api.example.test/projects/p/resources/r/wms",
        version="1.1.1",
    )

    assert b"WMS_MS_Capabilities.dtd" in document
    assert b"Roads &lt;review&gt;" in document
    root = ET.fromstring(document)
    assert root.tag == "WMT_MS_Capabilities"
    assert root.attrib["version"] == WMS_VERSION_111
    assert root.findtext("Service/Name") == "OGC:WMS"
    child = root.findall("Capability/Layer/Layer")[0]
    assert child.findtext("Name") == str(LAYER_ID)
    assert {element.text for element in child.findall("SRS")} == {
        WMS_EPSG4326,
        WMS_EPSG3857,
    }
    assert child.find("LatLonBoundingBox").attrib == {
        "minx": "84",
        "miny": "27",
        "maxx": "86",
        "maxy": "29",
    }
    bounding_boxes = {
        element.attrib["SRS"]: element.attrib for element in child.findall("BoundingBox")
    }
    assert bounding_boxes[WMS_EPSG4326]["minx"] == "84"
    assert float(bounding_boxes[WMS_EPSG3857]["minx"]) == pytest.approx(9_350_837.226634981)


def test_wms_111_exception_uses_legacy_report_without_inflating_130_claims() -> None:
    document = exception_xml("InvalidSRS", "SRS", "Unsupported <legacy> SRS", version="1.1.1")

    assert b"exception_1_1_1.dtd" in document
    assert b"Unsupported &lt;legacy&gt; SRS" in document
    root = ET.fromstring(document)
    assert root.tag == "ServiceExceptionReport"
    assert root.attrib["version"] == WMS_VERSION_111
    exception = root.find("ServiceException")
    assert exception is not None
    assert exception.attrib == {"code": "InvalidSRS", "locator": "SRS"}


def test_wms_exception_xml_is_bounded_namespaced_and_escaped() -> None:
    document = exception_xml(
        "InvalidParameterValue", "BBOX", "Invalid <bbox> & request" + "x" * 600
    )

    assert b"&lt;bbox&gt; &amp; request" in document
    root = ET.fromstring(document)
    exception = root.find(f"{{{OGC_NAMESPACE}}}ServiceException")
    assert root.tag == f"{{{OGC_NAMESPACE}}}ServiceExceptionReport"
    assert exception is not None
    assert exception.attrib == {"code": "InvalidParameterValue", "locator": "BBOX"}
    assert exception.text is not None
    assert len(exception.text) == 500


def test_wms_capabilities_rejects_an_endpoint_with_embedded_credentials() -> None:
    with pytest.raises(ValueError):
        capabilities_xml(
            WmsLayer(
                name=str(LAYER_ID),
                title="Roads",
                abstract=None,
                attribution=None,
                bbox=(84.0, 27.0, 86.0, 29.0),
                styles=(WmsStyle(str(STYLE_ID), "Roads SVG"),),
            ),
            "https://user:secret@api.example.test/wms",
        )
