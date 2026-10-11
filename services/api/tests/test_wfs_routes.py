from uuid import UUID
from xml.etree import ElementTree as ET

import pytest

from opengeo_api.wfs import (
    FES_NAMESPACE,
    GML_2_NAMESPACE,
    GML_NAMESPACE,
    OGC_11_FILTER_NAMESPACE,
    OGC_FILTER_NAMESPACE,
    OPENGEO_NAMESPACE,
    OWS_NAMESPACE,
    WFS_1_1_EPSG3857,
    WFS_1_1_VERSION,
    WFS_1_NAMESPACE,
    WFS_CRS84,
    WFS_GET_FEATURE_BY_ID,
    WFS_NAMESPACE,
    XLINK_NAMESPACE,
    XSD_NAMESPACE,
)
from test_feature_routes import (
    DATASET_ID,
    FEATURE_ID,
    LOCK_TOKEN,
    PROJECT_ID,
    MemoryFeatureRepository,
    api_client,
    collection_payload,
    headers,
)

WFS_URL = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/wfs"
SECOND_FEATURE_ID = UUID("90000000-0000-4000-8000-000000000122")


def _prepared_client():
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    created = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    assert created.status_code == 201
    return repository, client


def _xml(response):
    return ET.fromstring(response.content)


def _transaction(operation: str) -> str:
    return (
        f'<wfs:Transaction service="WFS" version="2.0.0" '
        f'xmlns:wfs="{WFS_NAMESPACE}" xmlns:fes="{FES_NAMESPACE}" '
        f'xmlns:gml="http://www.opengis.net/gml/3.2" '
        f'xmlns:opengeo="{OPENGEO_NAMESPACE}">{operation}</wfs:Transaction>'
    )


def _update(version: int, name: str = "Station revised") -> str:
    return _transaction(
        f'<wfs:Update typeName="opengeo:features">'
        f"<wfs:Property><wfs:ValueReference>opengeo:name</wfs:ValueReference>"
        f"<wfs:Value>{name}</wfs:Value></wfs:Property>"
        f"<wfs:Property><wfs:ValueReference>opengeo:opengeo_version</wfs:ValueReference>"
        f"<wfs:Value>{version}</wfs:Value></wfs:Property>"
        f'<fes:Filter><fes:ResourceId rid="features.{FEATURE_ID}"/></fes:Filter>'
        f"</wfs:Update>"
    )


def test_wfs_discovery_and_reads_use_shared_auth_without_claiming_conformance() -> None:
    repository, client = _prepared_client()

    assert client.get(WFS_URL).status_code == 401
    capabilities = client.get(
        WFS_URL,
        headers=headers(),
        params={"service": "WFS", "request": "GetCapabilities", "acceptVersions": "2.0.0"},
    )
    root = _xml(capabilities)
    operation_elements = root.findall(f".//{{{OWS_NAMESPACE}}}Operation")
    operations = {item.attrib["name"] for item in operation_elements}
    constraints = {
        item.attrib["name"]: item.findtext(f"{{{OWS_NAMESPACE}}}DefaultValue")
        for item in root.iter()
        if item.tag
        in {
            f"{{{OWS_NAMESPACE}}}Constraint",
            f"{{{FES_NAMESPACE}}}Constraint",
        }
    }

    assert capabilities.status_code == 200
    assert capabilities.headers["cache-control"] == "private, no-store"
    assert root.tag == f"{{{WFS_NAMESPACE}}}WFS_Capabilities"
    assert root.attrib["version"] == "2.0.0"
    assert operations == {
        "GetCapabilities",
        "DescribeFeatureType",
        "ListStoredQueries",
        "DescribeStoredQueries",
        "GetFeature",
        "Transaction",
    }
    assert root.findtext(f".//{{{WFS_NAMESPACE}}}Name") == "opengeo:features"
    assert root.findtext(f".//{{{OPENGEO_NAMESPACE}}}ConformanceClaimed") == "false"
    assert constraints["KVPEncoding"] == "TRUE"
    assert constraints["XMLEncoding"] == "FALSE"
    assert constraints["ImplementsMinSpatialFilter"] == "FALSE"
    assert constraints["ImplementsMinStandardFilter"] == "FALSE"
    assert constraints["ImplementsMinTemporalFilter"] == "FALSE"
    assert constraints["ImplementsSimpleWFS"] == "FALSE"
    assert constraints["ManageStoredQueries"] == "FALSE"
    for operation in operation_elements:
        if operation.attrib["name"] == "Transaction":
            continue
        endpoint = operation.find(f".//{{{OWS_NAMESPACE}}}Get")
        assert endpoint is not None
        assert endpoint.attrib[f"{{{XLINK_NAMESPACE}}}href"].endswith(WFS_URL)
        assert operation.find(f".//{{{OWS_NAMESPACE}}}Post") is None
    assert repository.calls[-1][1].organization_id == UUID(headers()["X-OpenGeo-Organization"])

    described = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
            "typeNames": "opengeo:features",
        },
    )
    schema = _xml(described)
    elements = {
        item.attrib["name"]: item.attrib
        for item in schema.findall(f".//{{{XSD_NAMESPACE}}}element")
        if "name" in item.attrib
    }
    assert schema.attrib["targetNamespace"] == OPENGEO_NAMESPACE
    assert elements["geometry"]["type"] == "gml:PointPropertyType"
    assert elements["name"]["minOccurs"] == "1"
    assert elements["count"]["type"] == "xsd:long"
    assert elements["opengeo_version"]["type"] == "xsd:positiveInteger"
    assert elements["opengeo_created_at"]["type"] == "xsd:dateTime"
    assert elements["opengeo_updated_at"]["type"] == "xsd:dateTime"

    namespace_qualified = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
            "typeNames": "client:features",
            "namespaces": (f"xmlns(client,{OPENGEO_NAMESPACE}),xmlns(wfs,{WFS_NAMESPACE})"),
        },
    )
    assert namespace_qualified.status_code == 200
    assert _xml(namespace_qualified).attrib["targetNamespace"] == OPENGEO_NAMESPACE
    for namespaces in (
        "xmlns(client,https://example.com/not-opengeo)",
        "xmlns(client,https://opengeo.tools/ns/wfs",
        f"xmlns(client,{OPENGEO_NAMESPACE}),xmlns(client,{OPENGEO_NAMESPACE})",
    ):
        rejected_namespace = client.get(
            WFS_URL,
            headers=headers(),
            params={
                "service": "WFS",
                "version": "2.0.0",
                "request": "DescribeFeatureType",
                "typeNames": "client:features",
                "namespaces": namespaces,
            },
        )
        assert rejected_namespace.status_code == 400
        assert _xml(rejected_namespace).find(f"{{{OWS_NAMESPACE}}}Exception").attrib == {
            "exceptionCode": "InvalidParameterValue",
            "locator": "typeNames" if "not-opengeo" in namespaces else "namespaces",
        }

    geojson = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "opengeo:features",
            "outputFormat": "application/geo+json",
            "bbox": f"-78,38,-76,40,{WFS_CRS84}",
            "count": "1",
        },
    )
    assert geojson.status_code == 200
    assert geojson.headers["content-type"].startswith("application/geo+json")
    assert geojson.json()["features"][0]["id"] == f"features.{FEATURE_ID}"
    assert geojson.json()["features"][0]["properties"]["opengeo_version"] == 1
    assert geojson.json()["features"][0]["properties"]["opengeo_created_at"] == (
        "2026-08-20T15:00:00Z"
    )
    assert geojson.json()["features"][0]["properties"]["opengeo_updated_at"] == (
        "2026-08-20T15:00:00Z"
    )
    assert geojson.json()["opengeo:conformanceClaimed"] is False

    gml = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "opengeo:features",
            "resourceId": f"features.{FEATURE_ID}",
        },
    )
    gml_root = _xml(gml)
    assert gml.status_code == 200
    assert gml.headers["content-type"].startswith("application/gml+xml")
    assert gml_root.attrib["numberMatched"] == "1"
    assert gml_root.find(f".//{{{OPENGEO_NAMESPACE}}}features") is not None
    assert gml_root.findtext(f".//{{{OPENGEO_NAMESPACE}}}opengeo_created_at") == (
        "2026-08-20T15:00:00Z"
    )


def test_wfs_simple_get_binding_rejects_missing_service_and_describes_all_types() -> None:
    _, client = _prepared_client()

    missing_service = client.get(
        WFS_URL,
        headers=headers(),
        params={"request": "GetCapabilities"},
    )
    missing_exception = _xml(missing_service).find(f".//{{{OWS_NAMESPACE}}}Exception")
    assert missing_service.status_code == 400
    assert missing_exception is not None
    assert missing_exception.attrib == {
        "exceptionCode": "MissingParameterValue",
        "locator": "service",
    }

    described_all = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
        },
    )
    schema = _xml(described_all)
    assert described_all.status_code == 200
    assert schema.tag == f"{{{XSD_NAMESPACE}}}schema"
    assert schema.find(f".//{{{XSD_NAMESPACE}}}element[@name='features']") is not None

    unknown = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
            "typeNames": "foreign:unknown",
        },
    )
    unknown_exception = _xml(unknown).find(f".//{{{OWS_NAMESPACE}}}Exception")
    assert unknown.status_code == 400
    assert unknown_exception is not None
    assert unknown_exception.attrib["exceptionCode"] == "InvalidParameterValue"


def test_wfs_schema_represents_conditionally_required_fields_as_optional() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    payload = collection_payload()
    payload["fields"].append(
        {
            "name": "detail",
            "type": "string",
            "required": True,
            "visible_when": {"field": "count", "equals": 2},
        }
    )
    payload["features"][0]["properties"]["detail"] = "inspected"
    created = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=payload,
    )
    assert created.status_code == 201

    described = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
            "typeNames": "opengeo:features",
        },
    )
    elements = {
        item.attrib["name"]: item.attrib
        for item in _xml(described).findall(f".//{{{XSD_NAMESPACE}}}element")
        if "name" in item.attrib
    }

    assert elements["detail"]["minOccurs"] == "0"
    assert elements["detail"]["nillable"] == "true"


def test_wfs_exposes_structured_groups_as_canonical_json_compatibility_values() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    payload = collection_payload()
    payload["fields"] = [
        {
            "name": "samples",
            "type": "group",
            "required": True,
            "repeat": True,
            "min_items": 1,
            "max_items": 4,
            "fields": [{"name": "value", "type": "number", "required": True}],
        }
    ]
    payload["features"][0]["properties"] = {"samples": [{"value": 2.5}]}
    created = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=payload,
    )
    assert created.status_code == 201

    described = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeFeatureType",
            "typeNames": "opengeo:features",
        },
    )
    element = _xml(described).find(f".//{{{XSD_NAMESPACE}}}element[@name='samples']")
    assert element is not None
    assert element.attrib["type"] == "xsd:string"

    fetched = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "opengeo:features",
            "resourceId": f"features.{FEATURE_ID}",
        },
    )
    assert fetched.status_code == 200
    assert _xml(fetched).findtext(f".//{{{OPENGEO_NAMESPACE}}}samples") == '[{"value":2.5}]'


def test_wfs_simple_stored_query_discovery_and_get_feature_by_id_are_bounded() -> None:
    repository, client = _prepared_client()

    listed = client.get(
        WFS_URL,
        headers=headers(),
        params={"service": "WFS", "version": "2.0.0", "request": "ListStoredQueries"},
    )
    listed_root = _xml(listed)
    stored_query = listed_root.find(f".//{{{WFS_NAMESPACE}}}StoredQuery")
    assert listed.status_code == 200
    assert stored_query is not None
    assert stored_query.attrib["id"] == WFS_GET_FEATURE_BY_ID
    assert stored_query.findtext(f"{{{WFS_NAMESPACE}}}ReturnFeatureType") == "opengeo:features"

    described = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeStoredQueries",
            "storedquery_id": WFS_GET_FEATURE_BY_ID,
        },
    )
    described_root = _xml(described)
    description = described_root.find(f".//{{{WFS_NAMESPACE}}}StoredQueryDescription")
    assert described.status_code == 200
    assert description is not None
    assert description.attrib["id"] == WFS_GET_FEATURE_BY_ID
    assert description.find(f"{{{WFS_NAMESPACE}}}Parameter").attrib == {
        "name": "id",
        "type": "xsd:string",
    }
    expression = description.find(f"{{{WFS_NAMESPACE}}}QueryExpressionText")
    assert expression is not None
    assert expression.attrib["returnFeatureTypes"] == "opengeo:features"

    fetched = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "storedquery_id": WFS_GET_FEATURE_BY_ID,
            "id": f"features.{FEATURE_ID}",
        },
    )
    fetched_root = _xml(fetched)
    assert fetched.status_code == 200
    assert fetched_root.tag == f"{{{OPENGEO_NAMESPACE}}}features"
    assert fetched_root.attrib[f"{{{GML_NAMESPACE}}}id"] == f"features.{FEATURE_ID}"
    assert fetched_root.findtext(f"{{{OPENGEO_NAMESPACE}}}id") == str(FEATURE_ID)
    assert repository.calls[-1][1].organization_id == UUID(headers()["X-OpenGeo-Organization"])


def test_openlayers_wfs_2_xml_get_feature_bbox_and_resource_id_pass_the_service() -> None:
    repository, client = _prepared_client()
    bbox_request = (
        f'<GetFeature xmlns="{WFS_NAMESPACE}" service="WFS" version="2.0.0" '
        f'outputFormat="application/geo+json" count="20">'
        f'<Query typeNames="opengeo:features" srsName="{WFS_CRS84}" '
        f'xmlns:opengeo="{OPENGEO_NAMESPACE}">'
        f'<Filter xmlns="{FES_NAMESPACE}"><BBOX><ValueReference>geometry</ValueReference>'
        f'<Envelope xmlns="http://www.opengis.net/gml/3.2" srsName="{WFS_CRS84}">'
        f"<lowerCorner>-78 38</lowerCorner><upperCorner>-76 40</upperCorner>"
        f"</Envelope></BBOX></Filter></Query></GetFeature>"
    )
    bbox = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=bbox_request,
    )
    assert bbox.status_code == 200
    assert bbox.headers["content-type"].startswith("application/geo+json")
    assert bbox.json()["numberReturned"] == 1
    assert repository.calls[-1][0] == "query"
    assert repository.calls[-1][4][0].relation == "intersects"
    assert repository.calls[-1][4][0].geometry["coordinates"] == [
        [
            [-78.0, 38.0],
            [-76.0, 38.0],
            [-76.0, 40.0],
            [-78.0, 40.0],
            [-78.0, 38.0],
        ]
    ]

    resource_request = (
        f'<GetFeature xmlns="{WFS_NAMESPACE}" service="WFS" version="2.0.0" '
        f'outputFormat="application/geo+json" count="1">'
        f'<Query typeNames="opengeo:features" srsName="{WFS_CRS84}" '
        f'xmlns:opengeo="{OPENGEO_NAMESPACE}">'
        f'<Filter xmlns="{FES_NAMESPACE}"><ResourceId rid="features.{FEATURE_ID}"/>'
        f"</Filter></Query></GetFeature>"
    )
    resource = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=resource_request,
    )
    assert resource.status_code == 200
    assert resource.json()["features"][0]["id"] == f"features.{FEATURE_ID}"


def test_geomoose_wfs_1_1_xml_query_returns_exact_gml2_profile() -> None:
    repository, client = _prepared_client()
    request = (
        f'<GetFeature xmlns="{WFS_1_NAMESPACE}" service="WFS" '
        f'version="{WFS_1_1_VERSION}" outputFormat="text/xml; subtype=gml/2.1.2" '
        f'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        f'xsi:schemaLocation="{WFS_1_NAMESPACE} http://schemas.opengis.net/wfs/1.1.0/wfs.xsd">'
        f'<Query typeName="opengeo:features" srsName="EPSG:4326">'
        f'<Filter xmlns="{OGC_FILTER_NAMESPACE}"><PropertyIsEqualTo>'
        f"<PropertyName>name</PropertyName><Literal>Station</Literal>"
        f"</PropertyIsEqualTo></Filter></Query></GetFeature>"
    )

    assert (
        client.post(
            WFS_URL,
            headers={"Content-Type": "application/xml"},
            content=request,
        ).status_code
        == 401
    )
    response = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=request,
    )
    root = _xml(response)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/xml; subtype=gml/2.1.2")
    assert root.tag == f"{{{WFS_1_NAMESPACE}}}FeatureCollection"
    assert root.attrib["numberOfFeatures"] == "1"
    feature = root.find(f".//{{{OPENGEO_NAMESPACE}}}features")
    assert feature is not None
    assert feature.attrib["fid"] == f"features.{FEATURE_ID}"
    assert feature.findtext(f"{{{OPENGEO_NAMESPACE}}}name") == "Station"
    point = feature.find(f".//{{{GML_2_NAMESPACE}}}Point")
    assert point is not None
    assert point.attrib["srsName"] == "EPSG:4326"
    assert point.findtext(f"{{{GML_2_NAMESPACE}}}coordinates") == "38.9,-77.03"
    assert repository.calls[-1][0] == "query"
    assert repository.calls[-1][4][0].field == "name"


def test_geomoose_wfs_1_1_kvp_web_mercator_bbox_is_normalized_and_returned() -> None:
    repository, client = _prepared_client()
    response = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": WFS_1_1_VERSION,
            "request": "GetFeature",
            "typeName": "opengeo:features",
            "srsName": WFS_1_1_EPSG3857,
            "bbox": (
                "-8682920.28187534,4579425.8128701,-8460281.30028879,"
                f"4865942.27950318,{WFS_1_1_EPSG3857}"
            ),
        },
    )
    root = _xml(response)

    assert response.status_code == 200
    assert root.attrib["numberOfFeatures"] == "1"
    point = root.find(f".//{{{GML_2_NAMESPACE}}}Point")
    assert point is not None
    assert point.attrib["srsName"] == WFS_1_1_EPSG3857
    coordinates = point.findtext(f"{{{GML_2_NAMESPACE}}}coordinates")
    assert coordinates is not None
    x, y = (float(item) for item in coordinates.split(","))
    assert x == pytest.approx(-8574940.37580586)
    assert y == pytest.approx(4707357.53626792)
    assert repository.calls[-1][0] == "list"
    west, south, east, north = repository.calls[-1][4]
    assert west == pytest.approx(-78)
    assert south == pytest.approx(38)
    assert east == pytest.approx(-76)
    assert north == pytest.approx(40)


def test_geomoose_wfs_1_1_exact_spatial_filter_and_bounded_and_pass() -> None:
    repository, client = _prepared_client()
    intersects = (
        f"<Intersects><PropertyName>geometry</PropertyName>"
        f'<Point xmlns="{GML_2_NAMESPACE}"><pos srsDimension="2">-77.03 38.9</pos>'
        f"</Point></Intersects>"
    )

    def request(predicate: str) -> str:
        return (
            f'<GetFeature xmlns="{WFS_1_NAMESPACE}" service="WFS" version="1.1.0" '
            f'outputFormat="application/geo+json"><Query typeName="opengeo:features" '
            f'srsName="EPSG:4326"><Filter xmlns="{OGC_FILTER_NAMESPACE}">'
            f"{predicate}</Filter></Query></GetFeature>"
        )

    spatial = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=request(intersects),
    )
    combined = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=request(
            "<And><PropertyIsEqualTo><PropertyName>name</PropertyName>"
            f"<Literal>Station</Literal></PropertyIsEqualTo>{intersects}</And>"
        ),
    )
    unsupported_or = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=request(f"<Or>{intersects}{intersects}</Or>"),
    )

    assert spatial.status_code == 200
    assert spatial.json()["numberReturned"] == 1
    assert repository.calls[-4][0] == "query"
    assert repository.calls[-4][4][0].geometry == {
        "type": "Point",
        "coordinates": [-77.03, 38.9],
    }
    assert combined.status_code == 200
    assert combined.json()["numberReturned"] == 1
    assert repository.calls[-2][0] == "query"
    assert len(repository.calls[-2][4]) == 2
    assert unsupported_or.status_code == 400


def test_geomoose_wfs_1_1_profile_rejects_dialect_and_crs_ambiguity() -> None:
    _, client = _prepared_client()
    mismatched_bbox = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": WFS_1_1_VERSION,
            "request": "GetFeature",
            "typeName": "opengeo:features",
            "srsName": "EPSG:4326",
            "bbox": "-78,38,-76,40,EPSG:3857",
        },
    )
    wrong_filter_namespace = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=(
            f'<GetFeature xmlns="{WFS_1_NAMESPACE}" service="WFS" version="1.1.0">'
            f'<Query typeName="opengeo:features" srsName="EPSG:4326">'
            f'<Filter xmlns="{FES_NAMESPACE}"><PropertyIsEqualTo>'
            f"<ValueReference>name</ValueReference><Literal>Station</Literal>"
            f"</PropertyIsEqualTo></Filter></Query></GetFeature>"
        ),
    )
    wfs_2_max_features = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=(
            f'<GetFeature xmlns="{WFS_NAMESPACE}" service="WFS" version="2.0.0" '
            f'maxFeatures="10"><Query typeNames="opengeo:features"/></GetFeature>'
        ),
    )
    legacy_count = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": WFS_1_1_VERSION,
            "request": "GetFeature",
            "typeName": "opengeo:features",
            "count": "10",
        },
    )
    wfs_2_max_features_kvp = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "opengeo:features",
            "maxFeatures": "10",
        },
    )
    ambiguous_type_name_kvp = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": WFS_1_1_VERSION,
            "request": "GetFeature",
            "typeName": "opengeo:features",
            "typeNames": "opengeo:features",
        },
    )
    ambiguous_type_name_xml = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=(
            f'<GetFeature xmlns="{WFS_1_NAMESPACE}" service="WFS" version="1.1.0">'
            f'<Query typeName="opengeo:features" typeNames="opengeo:features"/>'
            f"</GetFeature>"
        ),
    )

    assert mismatched_bbox.status_code == 400
    assert wrong_filter_namespace.status_code == 400
    assert wfs_2_max_features.status_code == 400
    assert legacy_count.status_code == 400
    assert wfs_2_max_features_kvp.status_code == 400
    assert ambiguous_type_name_kvp.status_code == 400
    assert ambiguous_type_name_xml.status_code == 400


def test_xml_get_feature_accepts_bounded_comparison_temporal_and_filters() -> None:
    repository, client = _prepared_client()
    comparison = (
        f'<GetFeature xmlns="{WFS_NAMESPACE}" service="WFS" version="2.0.0" '
        f'outputFormat="application/geo+json">'
        f'<Query typeNames="opengeo:features" srsName="{WFS_CRS84}">'
        f'<Filter xmlns="{FES_NAMESPACE}"><PropertyIsEqualTo>'
        f"<ValueReference>name</ValueReference><Literal>Station</Literal>"
        f"</PropertyIsEqualTo></Filter></Query></GetFeature>"
    )
    compared = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=comparison,
    )
    assert compared.status_code == 200
    assert compared.json()["numberReturned"] == 1
    assert repository.calls[-1][0] == "query"
    assert repository.calls[-1][4][0].field == "name"

    typed_comparison = comparison.replace(
        "<ValueReference>name</ValueReference><Literal>Station</Literal>",
        "<ValueReference>count</ValueReference><Literal>2</Literal>",
    )
    typed_safe = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=typed_comparison,
    )
    assert typed_safe.status_code == 200
    assert typed_safe.json()["numberReturned"] == 1
    assert repository.calls[-1][4][0].case_sensitive is False

    during_predicate = (
        f"<During><ValueReference>opengeo_updated_at</ValueReference>"
        f'<TimePeriod xmlns="{GML_NAMESPACE}"><begin><TimeInstant><timePosition>'
        f"2026-08-01T00:00:00Z</timePosition></TimeInstant></begin>"
        f"<end><TimeInstant><timePosition>2026-09-01T00:00:00Z</timePosition>"
        f"</TimeInstant></end></TimePeriod></During>"
    )
    temporal = comparison.replace(
        "<PropertyIsEqualTo><ValueReference>name</ValueReference><Literal>Station</Literal>"
        "</PropertyIsEqualTo>",
        during_predicate,
    )
    temporally_filtered = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=temporal,
    )
    assert temporally_filtered.status_code == 200
    assert temporally_filtered.json()["numberReturned"] == 1
    assert repository.calls[-1][4][0].field == "opengeo_updated_at"

    combined = comparison.replace(
        "<PropertyIsEqualTo><ValueReference>name</ValueReference><Literal>Station</Literal>"
        "</PropertyIsEqualTo>",
        "<And><PropertyIsEqualTo><ValueReference>name</ValueReference><Literal>Station</Literal>"
        f"</PropertyIsEqualTo>{during_predicate}</And>",
    )
    conjunction = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=combined,
    )
    assert conjunction.status_code == 200
    assert conjunction.json()["numberReturned"] == 1
    assert len(repository.calls[-1][4]) == 2


def test_xml_get_feature_rejects_unbounded_or_undeclared_openlayers_filters() -> None:
    _, client = _prepared_client()
    comparison = (
        f'<GetFeature xmlns="{WFS_NAMESPACE}" service="WFS" version="2.0.0">'
        f'<Query typeNames="opengeo:features" srsName="{WFS_CRS84}">'
        f'<Filter xmlns="{FES_NAMESPACE}"><Or>'
        f"<PropertyIsEqualTo><ValueReference>name</ValueReference><Literal>Station</Literal>"
        f"</PropertyIsEqualTo><PropertyIsEqualTo><ValueReference>name</ValueReference>"
        f"<Literal>Elsewhere</Literal></PropertyIsEqualTo></Or></Filter></Query></GetFeature>"
    )
    rejected = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=comparison,
    )
    assert rejected.status_code == 400
    exception = _xml(rejected)
    node = exception.find(f".//{{{OWS_NAMESPACE}}}Exception")
    assert node is not None
    assert node.attrib == {"exceptionCode": "OptionNotSupported", "locator": "filter"}

    oversized = comparison.encode() + (b" " * (64 * 1024))
    too_large = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=oversized,
    )
    assert too_large.status_code == 413

    missing_id = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "storedquery_id": WFS_GET_FEATURE_BY_ID,
        },
    )
    mixed_selector = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "storedquery_id": WFS_GET_FEATURE_BY_ID,
            "id": str(FEATURE_ID),
            "typeNames": "opengeo:features",
        },
    )
    unknown_query = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "2.0.0",
            "request": "DescribeStoredQueries",
            "storedquery_id": "urn:example:unknown",
        },
    )

    assert missing_id.status_code == 400
    assert mixed_selector.status_code == 400
    assert unknown_query.status_code == 400


def test_single_operation_wfs_transactions_are_versioned_and_audited() -> None:
    repository, client = _prepared_client()
    insert = _transaction(
        f"<wfs:Insert><opengeo:features>"
        f"<opengeo:id>{SECOND_FEATURE_ID}</opengeo:id>"
        f'<opengeo:geometry><gml:Point srsName="{WFS_CRS84}">'
        f"<gml:pos>-77.02 38.91</gml:pos></gml:Point></opengeo:geometry>"
        f"<opengeo:name>New station</opengeo:name><opengeo:count>4</opengeo:count>"
        f"</opengeo:features></wfs:Insert>"
    )

    xml_headers = {**headers(), "Content-Type": "application/xml"}
    inserted = client.post(WFS_URL, headers=xml_headers, content=insert)
    insert_root = _xml(inserted)
    assert inserted.status_code == 200
    assert insert_root.findtext(f".//{{{WFS_NAMESPACE}}}totalInserted") == "1"
    resource = insert_root.find(f".//{{{FES_NAMESPACE}}}ResourceId")
    assert resource is not None
    assert resource.attrib["rid"] == f"features.{SECOND_FEATURE_ID}"
    assert repository.history[SECOND_FEATURE_ID][0].change_message == "WFS 2.0.0 Transaction insert"

    updated = client.post(WFS_URL, headers=xml_headers, content=_update(1))
    update_root = _xml(updated)
    assert updated.status_code == 200
    assert update_root.findtext(f".//{{{WFS_NAMESPACE}}}totalUpdated") == "1"
    assert repository.features[FEATURE_ID].properties == {"name": "Station revised", "count": 2}
    assert repository.features[FEATURE_ID].version_number == 2
    assert repository.history[FEATURE_ID][-1].change_message == "WFS 2.0.0 Transaction update"

    stale = client.post(WFS_URL, headers=xml_headers, content=_update(1, "Stale edit"))
    stale_root = _xml(stale)
    assert stale.status_code == 409
    stale_exception = stale_root.find(f".//{{{OWS_NAMESPACE}}}Exception")
    assert stale_exception is not None
    assert stale_exception.attrib["exceptionCode"] == "OperationProcessingFailed"
    assert "current version is 2" in stale_root.findtext(f".//{{{OWS_NAMESPACE}}}ExceptionText", "")

    delete = _transaction(
        f'<wfs:Delete typeName="opengeo:features" opengeo:expectedVersion="2">'
        f'<fes:Filter><fes:ResourceId rid="features.{FEATURE_ID}"/></fes:Filter>'
        f"</wfs:Delete>"
    )
    deleted = client.post(WFS_URL, headers=xml_headers, content=delete)
    delete_root = _xml(deleted)
    assert deleted.status_code == 200
    assert delete_root.findtext(f".//{{{WFS_NAMESPACE}}}totalDeleted") == "1"
    assert FEATURE_ID not in repository.features
    assert repository.history[FEATURE_ID][-1].change_message == "WFS 2.0.0 Transaction delete"


def test_wfs_transaction_cannot_bypass_an_active_feature_reservation() -> None:
    repository, client = _prepared_client()
    reserved = client.put(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/{FEATURE_ID}/lock",
        headers=headers(),
        json={
            "expected_version": 1,
            "lock_token": str(LOCK_TOKEN),
            "lease_seconds": 120,
        },
    )
    assert reserved.status_code == 200

    response = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=_update(1, "External edit without reservation token"),
    )
    root = _xml(response)

    assert response.status_code == 409
    exception = root.find(f".//{{{OWS_NAMESPACE}}}Exception")
    assert exception is not None
    assert exception.attrib["exceptionCode"] == "OperationProcessingFailed"
    assert "feature_locked" in root.findtext(f".//{{{OWS_NAMESPACE}}}ExceptionText", "")
    assert repository.features[FEATURE_ID].properties == {"name": "Station", "count": 2}
    assert repository.features[FEATURE_ID].version_number == 1


def test_openlayers_10_wfs_2_feature_id_filter_dialect_is_bounded() -> None:
    repository, client = _prepared_client()
    update = _transaction(
        f'<wfs:Update typeName="opengeo:features" '
        f'xmlns:ogc11="{OGC_11_FILTER_NAMESPACE}">'
        f"<wfs:Property><wfs:ValueReference>name</wfs:ValueReference>"
        f"<wfs:Value>OpenLayers update</wfs:Value></wfs:Property>"
        f"<wfs:Property><wfs:ValueReference>opengeo_version</wfs:ValueReference>"
        f"<wfs:Value>1</wfs:Value></wfs:Property>"
        f'<ogc11:Filter><ogc11:FeatureId fid="features.{FEATURE_ID}"/></ogc11:Filter>'
        f"</wfs:Update>"
    )

    response = client.post(
        WFS_URL,
        headers={**headers(), "Content-Type": "application/xml"},
        content=update,
    )

    assert response.status_code == 200
    assert _xml(response).findtext(f".//{{{WFS_NAMESPACE}}}totalUpdated") == "1"
    assert repository.features[FEATURE_ID].properties["name"] == "OpenLayers update"
    assert repository.features[FEATURE_ID].version_number == 2


def test_qgis_legacy_wfs_transaction_dialect_is_bounded() -> None:
    repository, client = _prepared_client()
    xml_headers = {**headers(), "Content-Type": "application/xml"}
    insert = (
        f'<Transaction xmlns="{WFS_1_NAMESPACE}" version="1.0.0" service="WFS" '
        f'xmlns:opengeo="{OPENGEO_NAMESPACE}" xmlns:gml="{GML_2_NAMESPACE}">'
        f"<Insert><opengeo:features>"
        f"<opengeo:id>{SECOND_FEATURE_ID}</opengeo:id>"
        f'<opengeo:geometry><gml:Point srsName="OGC:CRS84">'
        f'<gml:coordinates cs="," ts=" ">-77.02,38.91</gml:coordinates>'
        f"</gml:Point></opengeo:geometry>"
        f"<opengeo:name>QGIS legacy insert</opengeo:name><opengeo:count>5</opengeo:count>"
        f"</opengeo:features></Insert></Transaction>"
    )

    response = client.post(
        WFS_URL,
        headers=xml_headers,
        params={"service": "WFS", "request": "Transaction"},
        content=insert,
    )
    root = _xml(response)

    assert response.status_code == 200
    assert root.tag == f"{{{WFS_1_NAMESPACE}}}WFS_TransactionResponse"
    assert root.find(f".//{{{WFS_1_NAMESPACE}}}SUCCESS") is not None
    inserted = root.find(f".//{{{OGC_FILTER_NAMESPACE}}}FeatureId")
    assert inserted is not None
    assert inserted.attrib["fid"] == f"features.{SECOND_FEATURE_ID}"
    assert repository.features[SECOND_FEATURE_ID].geometry == {
        "type": "Point",
        "coordinates": [-77.02, 38.91],
    }
    assert repository.history[SECOND_FEATURE_ID][0].change_message == "WFS 1.0.0 Transaction insert"


def test_wfs_surface_rejects_ambiguous_queries_and_unsafe_transactions() -> None:
    _, client = _prepared_client()
    xml_headers = {**headers(), "Content-Type": "application/xml"}

    wrong_version = client.get(
        WFS_URL,
        headers=headers(),
        params={
            "service": "WFS",
            "version": "1.2.0",
            "request": "GetFeature",
            "typeNames": "opengeo:features",
        },
    )
    unknown_query = client.get(
        WFS_URL,
        headers=headers(),
        params={"service": "WFS", "request": "GetCapabilities", "filter": "unsafe"},
    )
    dtd = client.post(
        WFS_URL,
        headers=xml_headers,
        content='<!DOCTYPE x [<!ENTITY y "unsafe">]><x>&y;</x>',
    )
    multiple = client.post(
        WFS_URL, headers=xml_headers, content=_transaction("<wfs:Insert/><wfs:Delete/>")
    )
    malformed_filter_namespace = client.post(
        WFS_URL,
        headers=xml_headers,
        content=_transaction(
            f'<wfs:Delete typeName="opengeo:features" xmlns:bad="https://example.test/bad">'
            f'<bad:Filter><fes:ResourceId rid="features.{FEATURE_ID}"/></bad:Filter>'
            "</wfs:Delete>"
        ),
    )
    multiple_geometries = client.post(
        WFS_URL,
        headers=xml_headers,
        content=_transaction(
            "<wfs:Insert><opengeo:features><opengeo:geometry>"
            f'<gml:Point srsName="{WFS_CRS84}"><gml:pos>-77 39</gml:pos></gml:Point>'
            f'<gml:Point srsName="{WFS_CRS84}"><gml:pos>-76 39</gml:pos></gml:Point>'
            "</opengeo:geometry><opengeo:name>Two geometries</opengeo:name>"
            "</opengeo:features></wfs:Insert>"
        ),
    )
    unsupported_crs = client.post(
        WFS_URL,
        headers=xml_headers,
        content=_transaction(
            "<wfs:Insert><opengeo:features>"
            '<opengeo:geometry><gml:Point srsName="EPSG:4326">'
            "<gml:pos>-77 39</gml:pos></gml:Point></opengeo:geometry>"
            "<opengeo:name>Unsafe CRS</opengeo:name>"
            "</opengeo:features></wfs:Insert>"
        ),
    )

    assert wrong_version.status_code == 400
    assert (
        _xml(wrong_version).find(f".//{{{OWS_NAMESPACE}}}Exception").attrib["exceptionCode"]
        == "VersionNegotiationFailed"
    )
    assert unknown_query.status_code == 400
    assert dtd.status_code == 400
    assert multiple.status_code == 400
    assert malformed_filter_namespace.status_code == 400
    assert multiple_geometries.status_code == 400
    assert unsupported_crs.status_code == 400
