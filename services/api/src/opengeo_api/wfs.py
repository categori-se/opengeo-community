"""Bounded WFS 2.0 serialization, stored queries, and transaction parsing."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4
from xml.etree import ElementTree as ET

from opengeo_api.features import (
    AttributeQueryStep,
    FeatureCollection,
    FeatureDraft,
    FeatureField,
    FeaturePage,
    FeatureQueryStep,
    FeatureRecord,
    SpatialQueryStep,
    TemporalQueryStep,
    feature_draft,
)

WFS_NAMESPACE = "http://www.opengis.net/wfs/2.0"
WFS_1_NAMESPACE = "http://www.opengis.net/wfs"
OWS_NAMESPACE = "http://www.opengis.net/ows/1.1"
FES_NAMESPACE = "http://www.opengis.net/fes/2.0"
OGC_FILTER_NAMESPACE = "http://www.opengis.net/ogc"
OGC_11_FILTER_NAMESPACE = "http://www.opengis.net/ogc/1.1"
GML_NAMESPACE = "http://www.opengis.net/gml/3.2"
GML_2_NAMESPACE = "http://www.opengis.net/gml"
XSD_NAMESPACE = "http://www.w3.org/2001/XMLSchema"
XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance"
XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"
OPENGEO_NAMESPACE = "https://opengeo.tools/ns/wfs"
WFS_VERSION = "2.0.0"
WFS_1_1_VERSION = "1.1.0"
WFS_CRS84 = "urn:ogc:def:crs:OGC::CRS84"
WFS_CRS84_ALIASES = frozenset(
    {
        WFS_CRS84,
        "OGC:CRS84",
        "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
    }
)
WFS_1_1_EPSG4326 = "EPSG:4326"
WFS_1_1_EPSG3857 = "EPSG:3857"
WFS_1_1_SRS_NAMES = frozenset({WFS_1_1_EPSG4326, WFS_1_1_EPSG3857})
WEB_MERCATOR_LIMIT = 20_037_508.342789244
WFS_SCHEMA_LOCATION = "http://schemas.opengis.net/wfs/2.0/wfs.xsd"
WFS_GET_FEATURE_BY_ID = "urn:ogc:def:query:OGC-WFS::GetFeatureById"
WFS_GET_FEATURE_BY_ID_HTTP = "http://www.opengis.net/def/query/OGC-WFS/0/GetFeatureById"
WFS_GET_FEATURE_BY_ID_IDS = frozenset({WFS_GET_FEATURE_BY_ID, WFS_GET_FEATURE_BY_ID_HTTP})
WFS_QUERY_LANGUAGE = "urn:ogc:def:queryLanguage:OGC-WFS::WFSQueryExpression"
MAX_TRANSACTION_BYTES = 256 * 1024
MAX_GET_FEATURE_BYTES = 64 * 1024
MAX_XML_ELEMENTS = 512
MAX_XML_DEPTH = 20
MAX_XML_ATTRIBUTES = 1024
MAX_XML_TEXT_BYTES = 128 * 1024

for prefix, namespace in (
    ("wfs", WFS_NAMESPACE),
    ("ows", OWS_NAMESPACE),
    ("fes", FES_NAMESPACE),
    ("gml", GML_NAMESPACE),
    ("xsd", XSD_NAMESPACE),
    ("xsi", XSI_NAMESPACE),
    ("xlink", XLINK_NAMESPACE),
    ("opengeo", OPENGEO_NAMESPACE),
    ("wfs1", WFS_1_NAMESPACE),
    ("gml2", GML_2_NAMESPACE),
):
    ET.register_namespace(prefix, namespace)


class WfsRequestError(ValueError):
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
class InsertCommand:
    draft: FeatureDraft
    version: str


@dataclass(frozen=True, slots=True)
class UpdateCommand:
    feature_id: UUID
    expected_version: int | None
    geometry: dict[str, Any] | None
    properties: dict[str, Any]
    version: str


@dataclass(frozen=True, slots=True)
class DeleteCommand:
    feature_id: UUID
    expected_version: int | None
    version: str


TransactionCommand = InsertCommand | UpdateCommand | DeleteCommand


@dataclass(frozen=True, slots=True)
class ParsedGetFeatureRequest:
    parameters: dict[str, str]
    query_steps: tuple[FeatureQueryStep, ...] = ()


def feature_type_name() -> str:
    return "opengeo:features"


def target_namespace() -> str:
    """Return the stable QName namespace for the dataset-scoped feature type."""
    return OPENGEO_NAMESPACE


def xml_bytes(root: ET.Element) -> bytes:
    return cast(
        bytes,
        ET.tostring(root, encoding="utf-8", xml_declaration=True, short_empty_elements=True),
    )


def capabilities_document(
    endpoint: str,
    project_id: UUID,
    dataset_id: UUID,
    collection: FeatureCollection,
) -> bytes:
    root = ET.Element(
        _q(WFS_NAMESPACE, "WFS_Capabilities"),
        {
            "version": WFS_VERSION,
            "updateSequence": str(collection.generation),
            _q(XSI_NAMESPACE, "schemaLocation"): f"{WFS_NAMESPACE} {WFS_SCHEMA_LOCATION}",
        },
    )
    identification = ET.SubElement(root, _q(OWS_NAMESPACE, "ServiceIdentification"))
    ET.SubElement(
        identification, _q(OWS_NAMESPACE, "Title")
    ).text = "OpenGeo governed feature service"
    ET.SubElement(
        identification, _q(OWS_NAMESPACE, "Abstract")
    ).text = "Authenticated bounded WFS 2.0 compatibility for one governed feature collection."
    ET.SubElement(identification, _q(OWS_NAMESPACE, "ServiceType")).text = "WFS"
    ET.SubElement(identification, _q(OWS_NAMESPACE, "ServiceTypeVersion")).text = WFS_VERSION
    ET.SubElement(identification, _q(OWS_NAMESPACE, "Fees")).text = "NONE"
    ET.SubElement(
        identification, _q(OWS_NAMESPACE, "AccessConstraints")
    ).text = "shared auth.categori.se authority and selected organization required"

    provider = ET.SubElement(root, _q(OWS_NAMESPACE, "ServiceProvider"))
    ET.SubElement(provider, _q(OWS_NAMESPACE, "ProviderName")).text = "OpenGeo"
    ET.SubElement(provider, _q(OWS_NAMESPACE, "ServiceContact"))

    operations = ET.SubElement(root, _q(OWS_NAMESPACE, "OperationsMetadata"))
    for name in (
        "GetCapabilities",
        "DescribeFeatureType",
        "ListStoredQueries",
        "DescribeStoredQueries",
        "GetFeature",
        "Transaction",
    ):
        operation = ET.SubElement(operations, _q(OWS_NAMESPACE, "Operation"), {"name": name})
        dcp = ET.SubElement(operation, _q(OWS_NAMESPACE, "DCP"))
        http = ET.SubElement(dcp, _q(OWS_NAMESPACE, "HTTP"))
        if name != "Transaction":
            ET.SubElement(http, _q(OWS_NAMESPACE, "Get"), {_q(XLINK_NAMESPACE, "href"): endpoint})
        if name == "Transaction":
            ET.SubElement(http, _q(OWS_NAMESPACE, "Post"), {_q(XLINK_NAMESPACE, "href"): endpoint})
        if name == "GetFeature":
            parameter = ET.SubElement(
                operation, _q(OWS_NAMESPACE, "Parameter"), {"name": "resolve"}
            )
            allowed = ET.SubElement(parameter, _q(OWS_NAMESPACE, "AllowedValues"))
            ET.SubElement(allowed, _q(OWS_NAMESPACE, "Value")).text = "local"

    for name, value in (
        ("ImplementsSimpleWFS", False),
        ("ImplementsBasicWFS", False),
        ("ImplementsTransactionalWFS", False),
        ("ImplementsLockingWFS", False),
        ("KVPEncoding", True),
        # XML POST remains a bounded compatibility path for GetFeature and
        # Transaction, not a global WFS binding.  The official ETS treats this
        # constraint as authority to POST every selected operation, so it must
        # remain false until each advertised operation has an XML binding.
        ("XMLEncoding", False),
        ("SOAPEncoding", False),
        ("ImplementsInheritance", False),
        ("ImplementsRemoteResolve", False),
        ("ImplementsResultPaging", False),
        ("ImplementsStandardJoins", False),
        ("ImplementsSpatialJoins", False),
        ("ImplementsTemporalJoins", False),
        ("ImplementsFeatureVersioning", False),
        ("ManageStoredQueries", False),
    ):
        _boolean_domain(operations, OWS_NAMESPACE, "Constraint", name, value)

    extended = ET.SubElement(operations, _q(OWS_NAMESPACE, "ExtendedCapabilities"))
    ET.SubElement(extended, _q(OPENGEO_NAMESPACE, "ConformanceClaimed")).text = "false"
    ET.SubElement(extended, _q(OPENGEO_NAMESPACE, "MaximumFeatures")).text = "100"
    ET.SubElement(
        extended, _q(OPENGEO_NAMESPACE, "TransactionOperations")
    ).text = "one insert, update, or delete per request"
    ET.SubElement(extended, _q(OPENGEO_NAMESPACE, "ProjectId")).text = str(project_id)

    feature_types = ET.SubElement(root, _q(WFS_NAMESPACE, "FeatureTypeList"))
    feature_type = ET.SubElement(feature_types, _q(WFS_NAMESPACE, "FeatureType"))
    ET.SubElement(feature_type, _q(WFS_NAMESPACE, "Name")).text = feature_type_name()
    ET.SubElement(feature_type, _q(WFS_NAMESPACE, "Title")).text = "Governed features"
    abstract = ET.SubElement(feature_type, _q(WFS_NAMESPACE, "Abstract"))
    abstract.text = (
        f"Dataset {dataset_id}; generation {collection.generation}; "
        "edits are versioned and audited."
    )
    ET.SubElement(feature_type, _q(WFS_NAMESPACE, "DefaultCRS")).text = WFS_CRS84
    bbox = ET.SubElement(feature_type, _q(OWS_NAMESPACE, "WGS84BoundingBox"))
    ET.SubElement(bbox, _q(OWS_NAMESPACE, "LowerCorner")).text = "-180 -90"
    ET.SubElement(bbox, _q(OWS_NAMESPACE, "UpperCorner")).text = "180 90"

    filter_capabilities = ET.SubElement(root, _q(FES_NAMESPACE, "Filter_Capabilities"))
    filter_conformance = ET.SubElement(filter_capabilities, _q(FES_NAMESPACE, "Conformance"))
    for name, value in (
        ("ImplementsQuery", True),
        ("ImplementsAdHocQuery", False),
        ("ImplementsResourceId", False),
        ("ImplementsMinStandardFilter", False),
        ("ImplementsStandardFilter", False),
        ("ImplementsMinSpatialFilter", False),
        ("ImplementsSpatialFilter", False),
        ("ImplementsMinTemporalFilter", False),
        ("ImplementsTemporalFilter", False),
        ("ImplementsVersionNav", False),
        ("ImplementsSorting", False),
        ("ImplementsExtendedOperators", False),
        ("ImplementsMinimumXPath", False),
        ("ImplementsSchemaElementFunc", False),
    ):
        _boolean_domain(filter_conformance, FES_NAMESPACE, "Constraint", name, value)
    id_capabilities = ET.SubElement(filter_capabilities, _q(FES_NAMESPACE, "Id_Capabilities"))
    ET.SubElement(
        id_capabilities, _q(FES_NAMESPACE, "ResourceIdentifier"), {"name": "fes:ResourceId"}
    )
    return xml_bytes(root)


def _boolean_domain(
    parent: ET.Element,
    namespace: str,
    element_name: str,
    name: str,
    value: bool,
) -> None:
    domain = ET.SubElement(parent, _q(namespace, element_name), {"name": name})
    reference = ET.SubElement(
        domain,
        _q(OWS_NAMESPACE, "ValuesReference"),
        {_q(OWS_NAMESPACE, "reference"): "http://www.w3.org/2001/XMLSchema#boolean"},
    )
    reference.text = "XML Schema boolean"
    ET.SubElement(domain, _q(OWS_NAMESPACE, "DefaultValue")).text = str(value).upper()


def list_stored_queries_document() -> bytes:
    root = ET.Element(
        _q(WFS_NAMESPACE, "ListStoredQueriesResponse"),
        {
            "xmlns:opengeo": OPENGEO_NAMESPACE,
            _q(XSI_NAMESPACE, "schemaLocation"): f"{WFS_NAMESPACE} {WFS_SCHEMA_LOCATION}",
        },
    )
    query = ET.SubElement(root, _q(WFS_NAMESPACE, "StoredQuery"), {"id": WFS_GET_FEATURE_BY_ID})
    ET.SubElement(query, _q(WFS_NAMESPACE, "Title")).text = "Get feature by identifier"
    ET.SubElement(query, _q(WFS_NAMESPACE, "ReturnFeatureType")).text = feature_type_name()
    return xml_bytes(root)


def describe_stored_queries_document(query_ids: tuple[str, ...]) -> bytes:
    selected = query_ids or (WFS_GET_FEATURE_BY_ID,)
    if any(query_id not in WFS_GET_FEATURE_BY_ID_IDS for query_id in selected):
        raise WfsRequestError(
            "InvalidParameterValue",
            "storedquery_id",
            "stored query identifier is not supported",
        )
    root = ET.Element(
        _q(WFS_NAMESPACE, "DescribeStoredQueriesResponse"),
        {
            "xmlns:opengeo": OPENGEO_NAMESPACE,
            "xmlns:xsd": XSD_NAMESPACE,
            _q(XSI_NAMESPACE, "schemaLocation"): f"{WFS_NAMESPACE} {WFS_SCHEMA_LOCATION}",
        },
    )
    for query_id in selected:
        description = ET.SubElement(
            root, _q(WFS_NAMESPACE, "StoredQueryDescription"), {"id": query_id}
        )
        ET.SubElement(description, _q(WFS_NAMESPACE, "Title")).text = "Get feature by identifier"
        ET.SubElement(
            description, _q(WFS_NAMESPACE, "Abstract")
        ).text = "Returns the single governed feature whose gml:id matches the required id."
        parameter = ET.SubElement(
            description,
            _q(WFS_NAMESPACE, "Parameter"),
            {"name": "id", "type": "xsd:string"},
        )
        ET.SubElement(parameter, _q(WFS_NAMESPACE, "Title")).text = "Feature identifier"
        expression = ET.SubElement(
            description,
            _q(WFS_NAMESPACE, "QueryExpressionText"),
            {
                "returnFeatureTypes": feature_type_name(),
                "language": WFS_QUERY_LANGUAGE,
                "isPrivate": "false",
            },
        )
        query = ET.SubElement(
            expression, _q(WFS_NAMESPACE, "Query"), {"typeNames": feature_type_name()}
        )
        predicate = ET.SubElement(query, _q(FES_NAMESPACE, "Filter"))
        ET.SubElement(predicate, _q(FES_NAMESPACE, "ResourceId"), {"rid": "${id}"})
    return xml_bytes(root)


def describe_feature_type_document(
    project_id: UUID,
    dataset_id: UUID,
    collection: FeatureCollection,
) -> bytes:
    namespace = target_namespace()
    root = ET.Element(
        _q(XSD_NAMESPACE, "schema"),
        {
            "targetNamespace": namespace,
            "elementFormDefault": "qualified",
            "version": "1.0",
            "xmlns:gml": GML_NAMESPACE,
            "xmlns:opengeo": namespace,
        },
    )
    ET.SubElement(
        root,
        _q(XSD_NAMESPACE, "import"),
        {
            "namespace": GML_NAMESPACE,
            "schemaLocation": "http://schemas.opengis.net/gml/3.2.1/gml.xsd",
        },
    )
    ET.SubElement(
        root,
        _q(XSD_NAMESPACE, "element"),
        {
            "name": "features",
            "type": "opengeo:featuresType",
            "substitutionGroup": "gml:AbstractFeature",
        },
    )
    complex_type = ET.SubElement(root, _q(XSD_NAMESPACE, "complexType"), {"name": "featuresType"})
    complex_content = ET.SubElement(complex_type, _q(XSD_NAMESPACE, "complexContent"))
    extension = ET.SubElement(
        complex_content,
        _q(XSD_NAMESPACE, "extension"),
        {"base": "gml:AbstractFeatureType"},
    )
    sequence = ET.SubElement(extension, _q(XSD_NAMESPACE, "sequence"))
    ET.SubElement(
        sequence,
        _q(XSD_NAMESPACE, "element"),
        {"name": "id", "type": "xsd:string", "minOccurs": "1", "maxOccurs": "1"},
    )
    ET.SubElement(
        sequence,
        _q(XSD_NAMESPACE, "element"),
        {
            "name": "geometry",
            "type": _gml_property_type(collection.geometry_type),
            "minOccurs": "1",
            "maxOccurs": "1",
            "nillable": "false",
        },
    )
    for field in collection.fields:
        conditionally_visible = field.visible_when is not None
        attributes = {
            "name": field.name,
            "type": _xsd_type(field),
            "minOccurs": "1" if field.required and not conditionally_visible else "0",
            "maxOccurs": "1",
            "nillable": "false" if field.required and not conditionally_visible else "true",
        }
        ET.SubElement(sequence, _q(XSD_NAMESPACE, "element"), attributes)
    ET.SubElement(
        sequence,
        _q(XSD_NAMESPACE, "element"),
        {
            "name": "opengeo_version",
            "type": "xsd:positiveInteger",
            "minOccurs": "1",
            "maxOccurs": "1",
        },
    )
    for name in ("opengeo_created_at", "opengeo_updated_at"):
        ET.SubElement(
            sequence,
            _q(XSD_NAMESPACE, "element"),
            {
                "name": name,
                "type": "xsd:dateTime",
                "minOccurs": "1",
                "maxOccurs": "1",
            },
        )
    return xml_bytes(root)


def feature_collection_gml(
    project_id: UUID,
    dataset_id: UUID,
    page: FeaturePage,
) -> bytes:
    namespace = target_namespace()
    root = ET.Element(
        _q(WFS_NAMESPACE, "FeatureCollection"),
        {
            "numberMatched": str(page.number_matched),
            "numberReturned": str(len(page.features)),
            "timeStamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            _q(XSI_NAMESPACE, "schemaLocation"): (
                f"{WFS_NAMESPACE} {WFS_SCHEMA_LOCATION} {namespace} "
                f"/projects/{project_id}/datasets/{dataset_id}/wfs?"
                "service=WFS&version=2.0.0&request=DescribeFeatureType&"
                "typeNames=opengeo%3Afeatures"
            ),
        },
    )
    for record in page.features:
        member = ET.SubElement(root, _q(WFS_NAMESPACE, "member"))
        _feature_element(member, namespace, record)
    return xml_bytes(root)


def feature_gml(record: FeatureRecord) -> bytes:
    """Serialize the direct feature entity required by GetFeatureById."""
    namespace = target_namespace()
    root = ET.Element(
        _q(namespace, "features"),
        {_q(GML_NAMESPACE, "id"): f"features.{record.feature_id}"},
    )
    _populate_feature_element(root, namespace, record)
    return xml_bytes(root)


def feature_collection_gml2(
    page: FeaturePage,
    *,
    srs_name: str,
) -> bytes:
    """Serialize the bounded GML2 profile consumed by exact GeoMoose 3.15.2."""
    if srs_name not in WFS_1_1_SRS_NAMES:
        raise WfsRequestError(
            "InvalidParameterValue", "srsName", "legacy GML2 output requires EPSG:4326 or EPSG:3857"
        )
    namespace = target_namespace()
    root = ET.Element(
        _q(WFS_1_NAMESPACE, "FeatureCollection"),
        {
            "numberOfFeatures": str(len(page.features)),
            "timeStamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        },
    )
    if page.features:
        west = min(record.bbox[0] for record in page.features)
        south = min(record.bbox[1] for record in page.features)
        east = max(record.bbox[2] for record in page.features)
        north = max(record.bbox[3] for record in page.features)
        lower = _legacy_position([west, south], srs_name)
        upper = _legacy_position([east, north], srs_name)
        bounded_by = ET.SubElement(root, _q(GML_2_NAMESPACE, "boundedBy"))
        box = ET.SubElement(bounded_by, _q(GML_2_NAMESPACE, "Box"), {"srsName": srs_name})
        ET.SubElement(
            box,
            _q(GML_2_NAMESPACE, "coordinates"),
            {"cs": ",", "ts": " "},
        ).text = f"{_coordinate(lower)} {_coordinate(upper)}"
    for record in page.features:
        member = ET.SubElement(root, _q(GML_2_NAMESPACE, "featureMember"))
        _feature_element_gml2(member, namespace, record, srs_name)
    return xml_bytes(root)


def feature_collection_geojson(page: FeaturePage) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "timeStamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "numberMatched": page.number_matched,
        "numberReturned": len(page.features),
        "features": [
            {
                "type": "Feature",
                "id": f"features.{record.feature_id}",
                "bbox": list(record.bbox),
                "geometry": record.geometry,
                "properties": {
                    "id": str(record.feature_id),
                    **record.properties,
                    "opengeo_version": record.version_number,
                    "opengeo_created_at": _utc_instant(record.created_at),
                    "opengeo_updated_at": _utc_instant(record.updated_at),
                },
            }
            for record in page.features
        ],
        "opengeo:collectionGeneration": page.collection.generation,
        "opengeo:conformanceClaimed": False,
    }


def parse_transaction(body: bytes, collection: FeatureCollection) -> TransactionCommand:
    root = _bounded_xml_root(body, maximum_bytes=MAX_TRANSACTION_BYTES, operation="transaction")
    namespace = _namespace(root.tag)
    version = root.attrib.get("version")
    if root.tag not in {
        _q(WFS_NAMESPACE, "Transaction"),
        _q(WFS_1_NAMESPACE, "Transaction"),
    }:
        raise WfsRequestError(
            "OperationNotSupported", "request", "only WFS Transaction is supported"
        )
    expected_version = WFS_VERSION if namespace == WFS_NAMESPACE else "1.0.0"
    if root.attrib.get("service", "WFS").upper() != "WFS" or version != expected_version:
        raise WfsRequestError(
            "VersionNegotiationFailed",
            "version",
            "transaction version must match its WFS 2.0 or WFS 1.0 namespace",
        )
    if root.attrib.get("lockId"):
        raise WfsRequestError("OptionNotSupported", "lockId", "feature locks are not implemented")
    if root.attrib.get("releaseAction", "ALL").upper() != "ALL":
        raise WfsRequestError("OptionNotSupported", "releaseAction", "releaseAction must be ALL")
    operations = [
        child
        for child in root
        if _namespace(child.tag) == namespace
        and _local(child.tag) in {"Insert", "Update", "Delete"}
    ]
    if len(operations) != 1 or len(root) != 1:
        raise WfsRequestError(
            "OptionNotSupported",
            "Transaction",
            "exactly one insert, update, or delete is allowed per transaction",
        )
    operation = operations[0]
    name = _local(operation.tag)
    if name == "Insert":
        return _parse_insert(operation, collection, expected_version)
    if name == "Update":
        return _parse_update(operation, collection, expected_version)
    return _parse_delete(operation, expected_version)


def xml_request_operation(body: bytes) -> str:
    """Return the bounded WFS XML request operation without trusting its attributes."""
    root = _bounded_xml_root(
        body,
        maximum_bytes=MAX_TRANSACTION_BYTES,
        operation="WFS request",
    )
    return _local(root.tag) if _namespace(root.tag) in {WFS_NAMESPACE, WFS_1_NAMESPACE} else ""


def parse_get_feature_request(
    body: bytes,
    collection: FeatureCollection,
) -> ParsedGetFeatureRequest:
    """Parse bounded WFS 2 or exact GeoMoose WFS 1.1 XML read profiles."""
    root = _bounded_xml_root(
        body,
        maximum_bytes=MAX_GET_FEATURE_BYTES,
        operation="GetFeature",
    )
    namespace = _namespace(root.tag)
    version = root.attrib.get("version")
    legacy = namespace == WFS_1_NAMESPACE and version == WFS_1_1_VERSION
    current = namespace == WFS_NAMESPACE and version == WFS_VERSION
    if _local(root.tag) != "GetFeature" or not (current or legacy):
        raise WfsRequestError(
            "OperationNotSupported",
            "request",
            "XML read operation must be WFS 2.0 or the GeoMoose WFS 1.1 GetFeature profile",
        )
    if root.attrib.get("service", "WFS").upper() != "WFS":
        raise WfsRequestError(
            "InvalidParameterValue", "service", "XML GetFeature service must be WFS"
        )
    allowed_root_attributes = {
        "service",
        "version",
        "outputFormat",
        "resultType",
        _q(XSI_NAMESPACE, "schemaLocation"),
    }
    allowed_root_attributes.update({"maxFeatures"} if legacy else {"count", "startIndex"})
    if any(name not in allowed_root_attributes for name in root.attrib):
        raise WfsRequestError(
            "OptionNotSupported", "GetFeature", "XML GetFeature contains an unsupported option"
        )
    queries = [child for child in root if child.tag == _q(namespace, "Query")]
    if len(root) != 1 or len(queries) != 1:
        raise WfsRequestError(
            "OptionNotSupported", "Query", "XML GetFeature requires exactly one Query"
        )
    query = queries[0]
    type_attribute = "typeName" if legacy else "typeNames"
    if any(name not in {type_attribute, "srsName"} for name in query.attrib):
        raise WfsRequestError(
            "OptionNotSupported", "Query", "XML GetFeature Query contains an unsupported option"
        )
    if query.attrib.get(type_attribute) not in {"features", feature_type_name()}:
        raise WfsRequestError(
            "InvalidParameterValue", "typeNames", "typeNames must be opengeo:features"
        )
    srs_name = query.attrib.get("srsName", WFS_1_1_EPSG4326 if legacy else WFS_CRS84)
    allowed_srs_names = WFS_1_1_SRS_NAMES if legacy else WFS_CRS84_ALIASES
    if srs_name not in allowed_srs_names:
        message = (
            "GeoMoose WFS 1.1 requires EPSG:4326 or EPSG:3857"
            if legacy
            else "only CRS84 is supported"
        )
        raise WfsRequestError("InvalidParameterValue", "srsName", message)

    parameters = {
        "service": "WFS",
        "request": "GetFeature",
        "version": WFS_1_1_VERSION if legacy else WFS_VERSION,
        "typenames": feature_type_name(),
        "srsname": srs_name,
    }
    for xml_name, parameter_name in (
        ("outputFormat", "outputformat"),
        ("count", "count"),
        ("startIndex", "startindex"),
        ("resultType", "resulttype"),
        ("maxFeatures", "maxfeatures"),
    ):
        if xml_name in root.attrib:
            parameters[parameter_name] = root.attrib[xml_name]

    if not list(query):
        return ParsedGetFeatureRequest(parameters)
    filter_namespace = OGC_FILTER_NAMESPACE if legacy else FES_NAMESPACE
    filters = [child for child in query if child.tag == _q(filter_namespace, "Filter")]
    if len(query) != 1 or len(filters) != 1 or len(filters[0]) != 1:
        raise WfsRequestError(
            "OptionNotSupported", "filter", "XML GetFeature accepts one bounded filter"
        )
    predicate = filters[0][0]
    if not legacy and predicate.tag == _q(FES_NAMESPACE, "ResourceId"):
        identifier = predicate.attrib.get("rid")
        if not identifier or len(predicate.attrib) != 1 or list(predicate):
            raise WfsRequestError(
                "InvalidParameterValue", "resourceId", "ResourceId requires one rid"
            )
        parse_resource_id(identifier)
        parameters["resourceid"] = identifier
        return ParsedGetFeatureRequest(parameters)
    steps = (
        _parse_get_feature_predicate_1_1(predicate, collection, srs_name=srs_name)
        if legacy
        else _parse_get_feature_predicate(predicate, collection)
    )
    return ParsedGetFeatureRequest(parameters, steps)


def _parse_get_feature_predicate_1_1(
    predicate: ET.Element,
    collection: FeatureCollection,
    *,
    srs_name: str,
    depth: int = 1,
) -> tuple[FeatureQueryStep, ...]:
    if depth > 4:
        raise WfsRequestError("OptionNotSupported", "filter", "filter depth exceeds four")
    if predicate.tag == _q(OGC_FILTER_NAMESPACE, "PropertyIsEqualTo"):
        return (
            _parse_get_feature_equal(
                predicate,
                collection,
                filter_namespace=OGC_FILTER_NAMESPACE,
                reference_name="PropertyName",
            ),
        )
    if predicate.tag == _q(OGC_FILTER_NAMESPACE, "Intersects"):
        return (_parse_get_feature_intersects_1_1(predicate, srs_name=srs_name),)
    if predicate.tag == _q(OGC_FILTER_NAMESPACE, "And"):
        if predicate.attrib or not 2 <= len(predicate) <= 4:
            raise WfsRequestError(
                "OptionNotSupported", "filter", "And requires two to four predicates"
            )
        steps = tuple(
            step
            for child in predicate
            for step in _parse_get_feature_predicate_1_1(
                child,
                collection,
                srs_name=srs_name,
                depth=depth + 1,
            )
        )
        if not 2 <= len(steps) <= 4:
            raise WfsRequestError(
                "OptionNotSupported", "filter", "combined filter exceeds four predicates"
            )
        return steps
    raise WfsRequestError(
        "OptionNotSupported",
        "filter",
        "GeoMoose WFS 1.1 supports PropertyIsEqualTo, Intersects, or bounded And",
    )


def _parse_get_feature_intersects_1_1(
    predicate: ET.Element,
    *,
    srs_name: str,
) -> SpatialQueryStep:
    if predicate.attrib:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "Intersects attributes are invalid"
        )
    children = list(predicate)
    references = [
        child for child in children if child.tag == _q(OGC_FILTER_NAMESPACE, "PropertyName")
    ]
    geometries = [child for child in children if _namespace(child.tag) == GML_2_NAMESPACE]
    if (
        len(children) != 2
        or len(references) != 1
        or (references[0].text or "").strip().split(":")[-1] != "geometry"
        or len(geometries) != 1
    ):
        raise WfsRequestError(
            "InvalidParameterValue",
            "filter",
            "Intersects requires opengeo:geometry and one GML geometry",
        )
    container = ET.Element("geometry")
    container.append(geometries[0])
    geometry = _parse_geometry_container(container, allowed_srs_names=WFS_1_1_SRS_NAMES)
    geometry_srs = geometries[0].attrib.get("srsName", srs_name)
    if geometry_srs != srs_name:
        raise WfsRequestError(
            "InvalidParameterValue", "srsName", "filter geometry CRS must match the Query CRS"
        )
    return SpatialQueryStep("intersects", _legacy_geometry_to_crs84(geometry, srs_name))


def _parse_get_feature_predicate(
    predicate: ET.Element,
    collection: FeatureCollection,
    *,
    depth: int = 1,
) -> tuple[FeatureQueryStep, ...]:
    if depth > 4:
        raise WfsRequestError("OptionNotSupported", "filter", "filter depth exceeds four")
    if predicate.tag == _q(FES_NAMESPACE, "BBOX"):
        bbox = parse_bbox(_parse_get_feature_bbox(predicate))
        assert bbox is not None
        min_x, min_y, max_x, max_y = bbox
        return (
            SpatialQueryStep(
                "intersects",
                {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [min_x, min_y],
                            [max_x, min_y],
                            [max_x, max_y],
                            [min_x, max_y],
                            [min_x, min_y],
                        ]
                    ],
                },
            ),
        )
    if predicate.tag == _q(FES_NAMESPACE, "PropertyIsEqualTo"):
        return (_parse_get_feature_equal(predicate, collection),)
    if predicate.tag == _q(FES_NAMESPACE, "During"):
        return (_parse_get_feature_during(predicate),)
    if predicate.tag == _q(FES_NAMESPACE, "And"):
        if predicate.attrib or not 2 <= len(predicate) <= 4:
            raise WfsRequestError(
                "OptionNotSupported", "filter", "And requires two to four predicates"
            )
        steps = tuple(
            step
            for child in predicate
            for step in _parse_get_feature_predicate(child, collection, depth=depth + 1)
        )
        if not 2 <= len(steps) <= 4:
            raise WfsRequestError(
                "OptionNotSupported", "filter", "combined filter exceeds four predicates"
            )
        return steps
    raise WfsRequestError(
        "OptionNotSupported",
        "filter",
        "XML GetFeature supports BBOX, PropertyIsEqualTo, During, ResourceId, or bounded And",
    )


def _parse_get_feature_equal(
    predicate: ET.Element,
    collection: FeatureCollection,
    *,
    filter_namespace: str = FES_NAMESPACE,
    reference_name: str = "ValueReference",
) -> AttributeQueryStep:
    if set(predicate.attrib) - {"matchCase"}:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "PropertyIsEqualTo attributes are invalid"
        )
    match_case_value = predicate.attrib.get("matchCase", "true").lower()
    if match_case_value not in {"true", "false"}:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "PropertyIsEqualTo matchCase is invalid"
        )
    children = list(predicate)
    references = [child for child in children if child.tag == _q(filter_namespace, reference_name)]
    literals = [child for child in children if child.tag == _q(filter_namespace, "Literal")]
    if len(children) != 2 or len(references) != 1 or len(literals) != 1:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "PropertyIsEqualTo requires one field and literal"
        )
    if any(item.attrib or list(item) for item in (references[0], literals[0])):
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "comparison field and literal must be scalar"
        )
    field_name = (references[0].text or "").strip().split(":")[-1]
    try:
        field = next(field for field in collection.fields if field.name == field_name)
    except StopIteration as error:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "comparison field is not in the collection schema"
        ) from error
    value = _parse_get_feature_literal((literals[0].text or "").strip(), field)
    return AttributeQueryStep(
        field.name,
        "equals",
        value,
        case_sensitive=field.type == "string" and match_case_value == "true",
    )


def _parse_get_feature_literal(value: str, field: FeatureField) -> str | int | float | bool:
    if not value or len(value.encode("utf8")) > 500:
        raise WfsRequestError("InvalidParameterValue", "filter", "comparison literal is invalid")
    try:
        if field.type == "integer":
            parsed_integer = int(value)
            if str(parsed_integer) != value:
                raise ValueError
            return parsed_integer
        if field.type == "number":
            parsed_number = float(value)
            if not math.isfinite(parsed_number):
                raise ValueError
            return parsed_number
        if field.type == "boolean":
            if value.lower() not in {"true", "false"}:
                raise ValueError
            return value.lower() == "true"
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "comparison literal does not match its field type"
        ) from error
    return value


def _parse_get_feature_during(predicate: ET.Element) -> TemporalQueryStep:
    if predicate.attrib:
        raise WfsRequestError("InvalidParameterValue", "filter", "During attributes are invalid")
    references = [child for child in predicate if child.tag == _q(FES_NAMESPACE, "ValueReference")]
    periods = [
        child
        for child in predicate
        if child.tag
        in {
            _q(GML_NAMESPACE, "TimePeriod"),
            _q(GML_2_NAMESPACE, "TimePeriod"),
        }
    ]
    if len(predicate) != 2 or len(references) != 1 or len(periods) != 1:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "During requires one system time and period"
        )
    field_name = (references[0].text or "").strip().split(":")[-1]
    if field_name not in {"opengeo_created_at", "opengeo_updated_at"}:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "During supports OpenGeo created or updated time"
        )
    positions = [
        item
        for item in periods[0].iter()
        if _local(item.tag) == "timePosition"
        and _namespace(item.tag) in {GML_NAMESPACE, GML_2_NAMESPACE}
    ]
    if len(positions) != 2:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "During period requires begin and end instants"
        )
    begin, end = (_parse_get_feature_instant(item.text or "") for item in positions)
    if begin >= end:
        raise WfsRequestError("InvalidParameterValue", "filter", "During interval is reversed")
    return TemporalQueryStep(
        cast(Literal["opengeo_created_at", "opengeo_updated_at"], field_name),
        begin,
        end,
    )


def _parse_get_feature_instant(value: str) -> datetime:
    text = value.strip()
    if len(text) > 40 or not text.endswith("Z"):
        raise WfsRequestError("InvalidParameterValue", "filter", "time instant must be UTC")
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "time instant is invalid"
        ) from error
    if parsed.tzinfo is None:
        raise WfsRequestError("InvalidParameterValue", "filter", "time instant must include a zone")
    return parsed.astimezone(UTC)


def _parse_get_feature_bbox(predicate: ET.Element) -> str:
    if predicate.attrib:
        raise WfsRequestError("InvalidParameterValue", "bbox", "BBOX attributes are unsupported")
    children = list(predicate)
    references = [child for child in children if child.tag == _q(FES_NAMESPACE, "ValueReference")]
    envelopes = [child for child in children if child.tag == _q(GML_NAMESPACE, "Envelope")]
    if (
        len(children) != 2
        or len(references) != 1
        or (references[0].text or "").strip() not in {"geometry", "opengeo:geometry"}
        or len(envelopes) != 1
    ):
        raise WfsRequestError(
            "InvalidParameterValue", "bbox", "BBOX requires geometry and one CRS84 Envelope"
        )
    envelope = envelopes[0]
    if set(envelope.attrib) != {"srsName"} or envelope.attrib["srsName"] not in WFS_CRS84_ALIASES:
        raise WfsRequestError("InvalidParameterValue", "bbox", "BBOX Envelope must use CRS84")
    lower = envelope.findall(_q(GML_NAMESPACE, "lowerCorner"))
    upper = envelope.findall(_q(GML_NAMESPACE, "upperCorner"))
    if len(envelope) != 2 or len(lower) != 1 or len(upper) != 1:
        raise WfsRequestError("InvalidParameterValue", "bbox", "BBOX Envelope requires two corners")
    lower_values = _numbers(lower[0].text or "", expected=2)
    upper_values = _numbers(upper[0].text or "", expected=2)
    serialized = ",".join(format(value, ".15g") for value in (*lower_values, *upper_values))
    parse_bbox(serialized)
    return serialized


def _bounded_xml_root(body: bytes, *, maximum_bytes: int, operation: str) -> ET.Element:
    if not body or len(body) > maximum_bytes:
        raise WfsRequestError(
            "OperationParsingFailed", "body", f"{operation} body is empty or too large"
        )
    upper = body.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise WfsRequestError(
            "OperationParsingFailed", "body", "DTD and entity declarations are forbidden"
        )
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise WfsRequestError(
            "OperationParsingFailed", "body", f"{operation} XML is invalid"
        ) from error
    _audit_xml(root)
    return root


def transaction_response(
    command: TransactionCommand,
    *,
    feature_id: UUID,
    collection_generation: int,
    feature_version: int | None,
) -> bytes:
    if command.version == "1.0.0":
        return _transaction_response_1(
            command,
            feature_id=feature_id,
            collection_generation=collection_generation,
            feature_version=feature_version,
        )
    root = ET.Element(
        _q(WFS_NAMESPACE, "TransactionResponse"),
        {
            "version": WFS_VERSION,
            _q(XSI_NAMESPACE, "schemaLocation"): f"{WFS_NAMESPACE} {WFS_SCHEMA_LOCATION}",
        },
    )
    summary = ET.SubElement(root, _q(WFS_NAMESPACE, "TransactionSummary"))
    inserted = 1 if isinstance(command, InsertCommand) else 0
    updated = 1 if isinstance(command, UpdateCommand) else 0
    deleted = 1 if isinstance(command, DeleteCommand) else 0
    ET.SubElement(summary, _q(WFS_NAMESPACE, "totalInserted")).text = str(inserted)
    ET.SubElement(summary, _q(WFS_NAMESPACE, "totalUpdated")).text = str(updated)
    ET.SubElement(summary, _q(WFS_NAMESPACE, "totalDeleted")).text = str(deleted)
    if inserted:
        results = ET.SubElement(root, _q(WFS_NAMESPACE, "InsertResults"))
        feature = ET.SubElement(results, _q(WFS_NAMESPACE, "Feature"))
        ET.SubElement(
            feature,
            _q(FES_NAMESPACE, "ResourceId"),
            {"rid": f"features.{feature_id}"},
        )
    status = ET.SubElement(root, _q(OPENGEO_NAMESPACE, "TransactionStatus"))
    status.set("collectionGeneration", str(collection_generation))
    status.set("featureId", str(feature_id))
    if feature_version is not None:
        status.set("featureVersion", str(feature_version))
    status.set("conformanceClaimed", "false")
    return xml_bytes(root)


def _transaction_response_1(
    command: TransactionCommand,
    *,
    feature_id: UUID,
    collection_generation: int,
    feature_version: int | None,
) -> bytes:
    root = ET.Element(
        _q(WFS_1_NAMESPACE, "WFS_TransactionResponse"),
        {"version": "1.0.0"},
    )
    result = ET.SubElement(root, _q(WFS_1_NAMESPACE, "TransactionResult"))
    status = ET.SubElement(result, _q(WFS_1_NAMESPACE, "Status"))
    ET.SubElement(status, _q(WFS_1_NAMESPACE, "SUCCESS"))
    if isinstance(command, InsertCommand):
        inserted = ET.SubElement(root, _q(WFS_1_NAMESPACE, "InsertResult"))
        ET.SubElement(
            inserted,
            _q(OGC_FILTER_NAMESPACE, "FeatureId"),
            {"fid": f"features.{feature_id}"},
        )
    extension = ET.SubElement(root, _q(OPENGEO_NAMESPACE, "TransactionStatus"))
    extension.set("collectionGeneration", str(collection_generation))
    extension.set("featureId", str(feature_id))
    if feature_version is not None:
        extension.set("featureVersion", str(feature_version))
    extension.set("conformanceClaimed", "false")
    return xml_bytes(root)


def exception_report(code: str, locator: str, message: str) -> bytes:
    root = ET.Element(
        _q(OWS_NAMESPACE, "ExceptionReport"),
        {
            "version": WFS_VERSION,
            _q(XSI_NAMESPACE, "schemaLocation"): (
                f"{OWS_NAMESPACE} http://schemas.opengis.net/ows/1.1.0/owsExceptionReport.xsd"
            ),
        },
    )
    exception = ET.SubElement(
        root,
        _q(OWS_NAMESPACE, "Exception"),
        {"exceptionCode": code, "locator": locator},
    )
    ET.SubElement(exception, _q(OWS_NAMESPACE, "ExceptionText")).text = message[:500]
    return xml_bytes(root)


def parse_bbox(value: str | None) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    parts = value.split(",")
    if len(parts) == 5:
        if parts[4] not in WFS_CRS84_ALIASES:
            raise WfsRequestError("InvalidParameterValue", "bbox", "bbox CRS must be CRS84")
        parts = parts[:4]
    if len(parts) != 4:
        raise WfsRequestError("InvalidParameterValue", "bbox", "bbox must contain four values")
    try:
        values = tuple(float(value) for value in parts)
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "bbox", "bbox values must be numbers"
        ) from error
    if (
        any(not math.isfinite(value) for value in values)
        or not -180 <= values[0] < values[2] <= 180
        or not -90 <= values[1] < values[3] <= 90
    ):
        raise WfsRequestError("InvalidParameterValue", "bbox", "bbox is outside CRS84 bounds")
    return cast(tuple[float, float, float, float], values)


def parse_wfs_1_1_bbox(
    value: str | None,
    srs_name: str,
) -> tuple[float, float, float, float] | None:
    """Normalize the exact GeoMoose WFS 1.1 XY bbox profile to internal CRS84."""
    if value is None:
        return None
    if srs_name not in WFS_1_1_SRS_NAMES:
        raise WfsRequestError(
            "InvalidParameterValue", "srsName", "WFS 1.1 bbox requires EPSG:4326 or EPSG:3857"
        )
    parts = value.split(",")
    if len(parts) == 5:
        if parts[4] != srs_name:
            raise WfsRequestError(
                "InvalidParameterValue", "bbox", "WFS 1.1 bbox CRS must match srsName"
            )
        parts = parts[:4]
    if len(parts) != 4:
        raise WfsRequestError("InvalidParameterValue", "bbox", "bbox must contain four values")
    try:
        values = tuple(float(item) for item in parts)
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "bbox", "bbox values must be numbers"
        ) from error
    if any(not math.isfinite(item) for item in values) or not (
        values[0] < values[2] and values[1] < values[3]
    ):
        raise WfsRequestError("InvalidParameterValue", "bbox", "bbox bounds are invalid")
    if srs_name == WFS_1_1_EPSG4326:
        return parse_bbox(",".join(format(item, ".15g") for item in values))
    if any(not -WEB_MERCATOR_LIMIT <= item <= WEB_MERCATOR_LIMIT for item in values):
        raise WfsRequestError(
            "InvalidParameterValue", "bbox", "EPSG:3857 bbox is outside Web Mercator bounds"
        )
    lower = _web_mercator_to_lon_lat(values[0], values[1])
    upper = _web_mercator_to_lon_lat(values[2], values[3])
    return (*lower, *upper)


def parse_resource_id(value: str) -> UUID:
    identifier = value.rsplit(".", 1)[-1]
    try:
        return UUID(identifier)
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "resourceId", "resource id is invalid"
        ) from error


def _feature_element(parent: ET.Element, namespace: str, record: FeatureRecord) -> None:
    feature = ET.SubElement(
        parent,
        _q(namespace, "features"),
        {_q(GML_NAMESPACE, "id"): f"features.{record.feature_id}"},
    )
    _populate_feature_element(feature, namespace, record)


def _populate_feature_element(
    feature: ET.Element,
    namespace: str,
    record: FeatureRecord,
) -> None:
    ET.SubElement(feature, _q(namespace, "id")).text = str(record.feature_id)
    geometry = ET.SubElement(feature, _q(namespace, "geometry"))
    _append_geometry(geometry, record.geometry)
    for name, value in record.properties.items():
        property_element = ET.SubElement(feature, _q(namespace, name))
        if value is None:
            property_element.set(_q(XSI_NAMESPACE, "nil"), "true")
        else:
            property_element.text = _property_text(value)
    ET.SubElement(feature, _q(namespace, "opengeo_version")).text = str(record.version_number)
    ET.SubElement(feature, _q(namespace, "opengeo_created_at")).text = _utc_instant(
        record.created_at
    )
    ET.SubElement(feature, _q(namespace, "opengeo_updated_at")).text = _utc_instant(
        record.updated_at
    )


def _feature_element_gml2(
    parent: ET.Element,
    namespace: str,
    record: FeatureRecord,
    srs_name: str,
) -> None:
    feature = ET.SubElement(
        parent,
        _q(namespace, "features"),
        {"fid": f"features.{record.feature_id}"},
    )
    ET.SubElement(feature, _q(namespace, "id")).text = str(record.feature_id)
    geometry = ET.SubElement(feature, _q(namespace, "geometry"))
    _append_geometry_gml2(geometry, record.geometry, srs_name)
    for name, value in record.properties.items():
        property_element = ET.SubElement(feature, _q(namespace, name))
        if value is None:
            property_element.set(_q(XSI_NAMESPACE, "nil"), "true")
        else:
            property_element.text = _property_text(value)
    ET.SubElement(feature, _q(namespace, "opengeo_version")).text = str(record.version_number)
    ET.SubElement(feature, _q(namespace, "opengeo_created_at")).text = _utc_instant(
        record.created_at
    )
    ET.SubElement(feature, _q(namespace, "opengeo_updated_at")).text = _utc_instant(
        record.updated_at
    )


def _append_geometry(parent: ET.Element, geometry: dict[str, Any]) -> None:
    geometry_type = geometry["type"]
    coordinates = geometry["coordinates"]
    attributes = {"srsName": WFS_CRS84, "srsDimension": "2"}
    if geometry_type == "Point":
        point = ET.SubElement(parent, _q(GML_NAMESPACE, "Point"), attributes)
        ET.SubElement(point, _q(GML_NAMESPACE, "pos")).text = _position(coordinates)
    elif geometry_type == "MultiPoint":
        multi = ET.SubElement(parent, _q(GML_NAMESPACE, "MultiPoint"), attributes)
        for position in coordinates:
            member = ET.SubElement(multi, _q(GML_NAMESPACE, "pointMember"))
            point = ET.SubElement(member, _q(GML_NAMESPACE, "Point"), attributes)
            ET.SubElement(point, _q(GML_NAMESPACE, "pos")).text = _position(position)
    elif geometry_type == "LineString":
        _append_line(parent, coordinates, attributes)
    elif geometry_type == "MultiLineString":
        multi = ET.SubElement(parent, _q(GML_NAMESPACE, "MultiCurve"), attributes)
        for line_coordinates in coordinates:
            member = ET.SubElement(multi, _q(GML_NAMESPACE, "curveMember"))
            _append_line(member, line_coordinates, attributes)
    elif geometry_type == "Polygon":
        _append_polygon(parent, coordinates, attributes)
    else:
        multi = ET.SubElement(parent, _q(GML_NAMESPACE, "MultiSurface"), attributes)
        for polygon_coordinates in coordinates:
            member = ET.SubElement(multi, _q(GML_NAMESPACE, "surfaceMember"))
            _append_polygon(member, polygon_coordinates, attributes)


def _append_geometry_gml2(
    parent: ET.Element,
    geometry: dict[str, Any],
    srs_name: str,
) -> None:
    geometry_type = geometry["type"]
    coordinates = _legacy_coordinates(geometry["coordinates"], srs_name)
    attributes = {"srsName": srs_name}
    if geometry_type == "Point":
        point = ET.SubElement(parent, _q(GML_2_NAMESPACE, "Point"), attributes)
        _append_gml2_coordinates(point, [coordinates])
    elif geometry_type == "MultiPoint":
        multi = ET.SubElement(parent, _q(GML_2_NAMESPACE, "MultiPoint"), attributes)
        for position in coordinates:
            member = ET.SubElement(multi, _q(GML_2_NAMESPACE, "pointMember"))
            point = ET.SubElement(member, _q(GML_2_NAMESPACE, "Point"), attributes)
            _append_gml2_coordinates(point, [position])
    elif geometry_type == "LineString":
        _append_gml2_line(parent, coordinates, attributes)
    elif geometry_type == "MultiLineString":
        multi = ET.SubElement(parent, _q(GML_2_NAMESPACE, "MultiLineString"), attributes)
        for line_coordinates in coordinates:
            member = ET.SubElement(multi, _q(GML_2_NAMESPACE, "lineStringMember"))
            _append_gml2_line(member, line_coordinates, attributes)
    elif geometry_type == "Polygon":
        _append_gml2_polygon(parent, coordinates, attributes)
    else:
        multi = ET.SubElement(parent, _q(GML_2_NAMESPACE, "MultiPolygon"), attributes)
        for polygon_coordinates in coordinates:
            member = ET.SubElement(multi, _q(GML_2_NAMESPACE, "polygonMember"))
            _append_gml2_polygon(member, polygon_coordinates, attributes)


def _append_gml2_line(
    parent: ET.Element,
    coordinates: list[list[float]],
    attributes: dict[str, str],
) -> None:
    line = ET.SubElement(parent, _q(GML_2_NAMESPACE, "LineString"), attributes)
    _append_gml2_coordinates(line, coordinates)


def _append_gml2_polygon(
    parent: ET.Element,
    coordinates: list[list[list[float]]],
    attributes: dict[str, str],
) -> None:
    polygon = ET.SubElement(parent, _q(GML_2_NAMESPACE, "Polygon"), attributes)
    for index, ring_coordinates in enumerate(coordinates):
        boundary_name = "outerBoundaryIs" if index == 0 else "innerBoundaryIs"
        boundary = ET.SubElement(polygon, _q(GML_2_NAMESPACE, boundary_name))
        ring = ET.SubElement(boundary, _q(GML_2_NAMESPACE, "LinearRing"), attributes)
        _append_gml2_coordinates(ring, ring_coordinates)


def _append_gml2_coordinates(parent: ET.Element, coordinates: list[list[float]]) -> None:
    ET.SubElement(
        parent,
        _q(GML_2_NAMESPACE, "coordinates"),
        {"cs": ",", "ts": " "},
    ).text = " ".join(_coordinate(position) for position in coordinates)


def _append_line(parent: ET.Element, coordinates: list[Any], attributes: dict[str, str]) -> None:
    line = ET.SubElement(parent, _q(GML_NAMESPACE, "LineString"), attributes)
    ET.SubElement(line, _q(GML_NAMESPACE, "posList")).text = _position_list(coordinates)


def _append_polygon(parent: ET.Element, coordinates: list[Any], attributes: dict[str, str]) -> None:
    polygon = ET.SubElement(parent, _q(GML_NAMESPACE, "Polygon"), attributes)
    for index, ring_coordinates in enumerate(coordinates):
        boundary_name = "exterior" if index == 0 else "interior"
        boundary = ET.SubElement(polygon, _q(GML_NAMESPACE, boundary_name))
        ring = ET.SubElement(boundary, _q(GML_NAMESPACE, "LinearRing"), attributes)
        ET.SubElement(ring, _q(GML_NAMESPACE, "posList")).text = _position_list(ring_coordinates)


def _parse_insert(
    operation: ET.Element, collection: FeatureCollection, version: str
) -> InsertCommand:
    children = list(operation)
    if len(children) != 1 or children[0].tag != _q(target_namespace(), "features"):
        raise WfsRequestError(
            "InvalidParameterValue",
            "Insert",
            "insert must contain one opengeo:features element",
        )
    feature = children[0]
    values = _feature_values(feature, collection)
    geometry = values.pop("geometry", None)
    if geometry is None:
        raise WfsRequestError("MissingParameterValue", "geometry", "insert geometry is required")
    identifier = values.pop("id", None)
    values.pop("opengeo_version", None)
    try:
        feature_id = UUID(identifier) if identifier else uuid4()
    except ValueError as error:
        raise WfsRequestError("InvalidParameterValue", "id", "insert id must be a UUID") from error
    return InsertCommand(feature_draft(geometry, values, collection.fields, feature_id), version)


def _parse_update(
    operation: ET.Element, collection: FeatureCollection, version: str
) -> UpdateCommand:
    _require_type_name(operation)
    wfs_namespace = _namespace(operation.tag)
    children = list(operation)
    property_elements = operation.findall(_q(wfs_namespace, "Property"))
    filters = [child for child in operation if _local(child.tag) == "Filter"]
    if not property_elements or len(filters) != 1 or len(children) != len(property_elements) + 1:
        raise WfsRequestError(
            "InvalidParameterValue",
            "Update",
            "update must contain properties followed by one ResourceId filter",
        )
    properties: dict[str, Any] = {}
    geometry: dict[str, Any] | None = None
    expected_version: int | None = None
    seen: set[str] = set()
    for property_element in property_elements:
        reference = property_element.find(_q(wfs_namespace, "ValueReference"))
        if reference is None:
            reference = property_element.find(_q(wfs_namespace, "Name"))
        value = property_element.find(_q(wfs_namespace, "Value"))
        if reference is None or value is None or not reference.text:
            raise WfsRequestError(
                "InvalidParameterValue", "Property", "update property is incomplete"
            )
        name = reference.text.rsplit("/", 1)[-1].split(":")[-1]
        if name in seen:
            raise WfsRequestError("InvalidParameterValue", name, "update property is duplicated")
        seen.add(name)
        if name == "geometry":
            geometry = _parse_geometry_container(value)
        elif name == "opengeo_version":
            expected_version = _positive_integer(value.text, "opengeo_version")
        elif name == "id":
            raise WfsRequestError("OptionNotSupported", "id", "feature id cannot be updated")
        else:
            field = _field(collection.fields, name)
            properties[name] = _parse_scalar(value, field)
    return UpdateCommand(
        _filter_feature_id(operation),
        expected_version,
        geometry,
        properties,
        version,
    )


def _parse_delete(operation: ET.Element, version: str) -> DeleteCommand:
    _require_type_name(operation)
    if (
        len(operation) != 1
        or _local(operation[0].tag) != "Filter"
        or _namespace(operation[0].tag)
        not in {FES_NAMESPACE, OGC_FILTER_NAMESPACE, OGC_11_FILTER_NAMESPACE}
    ):
        raise WfsRequestError(
            "InvalidParameterValue", "Delete", "delete must contain one ResourceId filter"
        )
    version_text = operation.attrib.get(_q(OPENGEO_NAMESPACE, "expectedVersion"))
    expected_version = _positive_integer(version_text, "expectedVersion") if version_text else None
    return DeleteCommand(_filter_feature_id(operation), expected_version, version)


def _feature_values(feature: ET.Element, collection: FeatureCollection) -> dict[str, Any]:
    values: dict[str, Any] = {}
    allowed = {field.name for field in collection.fields} | {
        "id",
        "geometry",
        "opengeo_version",
    }
    for element in feature:
        name = _local(element.tag)
        if name not in allowed or name in values:
            raise WfsRequestError(
                "InvalidParameterValue", name, "feature property is unknown or duplicated"
            )
        if name == "geometry":
            values[name] = _parse_geometry_container(element)
        elif name == "id":
            values[name] = (element.text or "").strip()
        elif name == "opengeo_version":
            values[name] = _positive_integer(element.text, name)
        else:
            values[name] = _parse_scalar(element, _field(collection.fields, name))
    return values


def _parse_geometry_container(
    container: ET.Element,
    *,
    allowed_srs_names: frozenset[str] = WFS_CRS84_ALIASES,
) -> dict[str, Any]:
    roots = [
        element
        for element in container
        if _namespace(element.tag) in {GML_NAMESPACE, GML_2_NAMESPACE}
        if _local(element.tag)
        in {
            "Point",
            "MultiPoint",
            "LineString",
            "MultiCurve",
            "MultiLineString",
            "Polygon",
            "MultiSurface",
            "MultiPolygon",
        }
    ]
    if len(roots) != 1 or len(container) != 1:
        raise WfsRequestError(
            "MissingParameterValue", "geometry", "exactly one GML geometry is required"
        )
    root = roots[0]
    srs_name = root.attrib.get("srsName")
    if srs_name and srs_name not in allowed_srs_names:
        raise WfsRequestError("InvalidParameterValue", "srsName", "geometry CRS is unsupported")
    name = _local(root.tag)
    if name == "Point":
        geometry = {"type": "Point", "coordinates": _parse_pos(root)}
    elif name == "MultiPoint":
        geometry = {
            "type": "MultiPoint",
            "coordinates": [_parse_pos(item) for item in root.iter() if _is_gml(item, "Point")],
        }
    elif name == "LineString":
        geometry = {"type": "LineString", "coordinates": _parse_pos_list(root)}
    elif name in {"MultiCurve", "MultiLineString"}:
        geometry = {
            "type": "MultiLineString",
            "coordinates": [
                _parse_pos_list(item) for item in root.iter() if _is_gml(item, "LineString")
            ],
        }
    elif name == "Polygon":
        geometry = {"type": "Polygon", "coordinates": _parse_polygon(root)}
    else:
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                _parse_polygon(item) for item in root.iter() if _is_gml(item, "Polygon")
            ],
        }
    return geometry


def _parse_polygon(polygon: ET.Element) -> list[list[list[float]]]:
    rings = [_parse_pos_list(ring) for ring in polygon.iter() if _is_gml(ring, "LinearRing")]
    if not rings:
        raise WfsRequestError("InvalidParameterValue", "geometry", "polygon has no rings")
    return rings


def _parse_pos(element: ET.Element) -> list[float]:
    pos = next((item for item in element.iter() if _is_gml(item, "pos")), None)
    if pos is not None and pos.text:
        return _numbers(pos.text, expected=2)
    positions = _parse_coordinates(element)
    if len(positions) != 1:
        raise WfsRequestError("InvalidParameterValue", "geometry", "GML position is missing")
    return positions[0]


def _parse_pos_list(element: ET.Element) -> list[list[float]]:
    pos_list = next((item for item in element.iter() if _is_gml(item, "posList")), None)
    if pos_list is not None and pos_list.text:
        numbers = _numbers(pos_list.text)
        if len(numbers) % 2:
            raise WfsRequestError(
                "InvalidParameterValue", "geometry", "GML position list is uneven"
            )
        return [numbers[index : index + 2] for index in range(0, len(numbers), 2)]
    positions = [
        _numbers(pos.text or "", expected=2) for pos in element.iter() if _is_gml(pos, "pos")
    ]
    if not positions:
        positions = _parse_coordinates(element)
    if not positions:
        raise WfsRequestError("InvalidParameterValue", "geometry", "GML position list is missing")
    return positions


def _parse_coordinates(element: ET.Element) -> list[list[float]]:
    coordinates = next((item for item in element.iter() if _is_gml(item, "coordinates")), None)
    if coordinates is None or not coordinates.text:
        return []
    if coordinates.attrib.get("cs", ",") != "," or coordinates.attrib.get("ts", " ") != " ":
        raise WfsRequestError(
            "InvalidParameterValue", "geometry", "GML coordinate separators are unsupported"
        )
    return [_numbers(item.replace(",", " "), expected=2) for item in coordinates.text.split()]


def _numbers(value: str, *, expected: int | None = None) -> list[float]:
    try:
        numbers = [float(item) for item in value.split()]
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", "geometry", "GML coordinates are invalid"
        ) from error
    if (expected is not None and len(numbers) != expected) or any(
        not math.isfinite(item) for item in numbers
    ):
        raise WfsRequestError("InvalidParameterValue", "geometry", "GML coordinates are invalid")
    return numbers


def _parse_scalar(element: ET.Element, field: FeatureField) -> Any:
    if element.attrib.get(_q(XSI_NAMESPACE, "nil"), "false").lower() == "true":
        if field.required and field.visible_when is None:
            raise WfsRequestError(
                "InvalidParameterValue", field.name, "required value cannot be nil"
            )
        return None
    value = (element.text or "").strip()
    if field.type == "group":
        try:
            structured = json.loads(value)
        except (json.JSONDecodeError, ValueError) as error:
            raise WfsRequestError(
                "InvalidParameterValue", field.name, "structured JSON value is invalid"
            ) from error
        expected = list if field.repeat else dict
        if not isinstance(structured, expected):
            raise WfsRequestError(
                "InvalidParameterValue", field.name, "structured JSON value has the wrong shape"
            )
        return structured
    if field.type == "string":
        return value
    if field.type == "integer":
        try:
            return int(value)
        except ValueError as error:
            raise WfsRequestError(
                "InvalidParameterValue", field.name, "integer value is invalid"
            ) from error
    if field.type == "number":
        try:
            return float(value)
        except ValueError as error:
            raise WfsRequestError(
                "InvalidParameterValue", field.name, "number value is invalid"
            ) from error
    if value.lower() not in {"true", "false", "1", "0"}:
        raise WfsRequestError("InvalidParameterValue", field.name, "boolean value is invalid")
    return value.lower() in {"true", "1"}


def _filter_feature_id(operation: ET.Element) -> UUID:
    filters = [
        child
        for child in operation
        if _local(child.tag) == "Filter"
        and _namespace(child.tag) in {FES_NAMESPACE, OGC_FILTER_NAMESPACE, OGC_11_FILTER_NAMESPACE}
    ]
    identifiers = (
        [
            child
            for child in filters[0]
            if child.tag
            in {
                _q(FES_NAMESPACE, "ResourceId"),
                _q(OGC_FILTER_NAMESPACE, "FeatureId"),
                _q(OGC_11_FILTER_NAMESPACE, "FeatureId"),
            }
        ]
        if len(filters) == 1
        else []
    )
    identifier = None
    if identifiers:
        identifier = identifiers[0].attrib.get("rid") or identifiers[0].attrib.get("fid")
    if len(filters) != 1 or len(filters[0]) != 1 or len(identifiers) != 1 or not identifier:
        raise WfsRequestError(
            "MissingParameterValue",
            "filter",
            "one fes:ResourceId or ogc:FeatureId is required",
        )
    return parse_resource_id(identifier)


def _require_type_name(operation: ET.Element) -> None:
    if "typeName" in operation.attrib and "typeNames" in operation.attrib:
        raise WfsRequestError(
            "InvalidParameterValue",
            "typeName",
            "typeName and typeNames cannot be combined",
        )
    value = operation.attrib.get("typeName") or operation.attrib.get("typeNames")
    if value not in {"features", feature_type_name()}:
        raise WfsRequestError(
            "InvalidParameterValue", "typeName", "typeName must be opengeo:features"
        )


def _audit_xml(root: ET.Element) -> None:
    count = 0
    attributes = 0
    text_bytes = 0
    stack = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        count += 1
        attributes += len(element.attrib)
        text_bytes += len((element.text or "").encode("utf8"))
        text_bytes += len((element.tail or "").encode("utf8"))
        if (
            count > MAX_XML_ELEMENTS
            or depth > MAX_XML_DEPTH
            or attributes > MAX_XML_ATTRIBUTES
            or text_bytes > MAX_XML_TEXT_BYTES
        ):
            raise WfsRequestError(
                "OperationParsingFailed", "body", "transaction XML exceeds structural limits"
            )
        stack.extend((child, depth + 1) for child in element)


def _field(fields: tuple[FeatureField, ...], name: str) -> FeatureField:
    try:
        return next(field for field in fields if field.name == name)
    except StopIteration as error:
        raise WfsRequestError(
            "InvalidParameterValue", name, "feature property is unknown"
        ) from error


def _positive_integer(value: str | None, locator: str) -> int:
    try:
        parsed = int(value or "")
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", locator, "value must be a positive integer"
        ) from error
    if parsed < 1 or str(parsed) != value:
        raise WfsRequestError("InvalidParameterValue", locator, "value must be a positive integer")
    return parsed


def _gml_property_type(geometry_type: str) -> str:
    return {
        "Point": "gml:PointPropertyType",
        "MultiPoint": "gml:MultiPointPropertyType",
        "LineString": "gml:CurvePropertyType",
        "MultiLineString": "gml:MultiCurvePropertyType",
        "Polygon": "gml:SurfacePropertyType",
        "MultiPolygon": "gml:MultiSurfacePropertyType",
    }[geometry_type]


def _xsd_type(field: FeatureField) -> str:
    return {
        "string": "xsd:string",
        "integer": "xsd:long",
        "number": "xsd:double",
        "boolean": "xsd:boolean",
        "group": "xsd:string",
    }[field.type]


def _property_text(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, dict | list):
        return json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True
        )
    return str(value)


def _position(value: list[float]) -> str:
    return " ".join(format(float(item), ".15g") for item in value)


def _position_list(values: list[list[float]]) -> str:
    return " ".join(_position(value) for value in values)


def _coordinate(value: list[float]) -> str:
    return ",".join(format(float(item), ".15g") for item in value)


def _legacy_position(value: list[float], srs_name: str) -> list[float]:
    if srs_name == WFS_1_1_EPSG4326:
        # WFS 1.1/GML2 readers honor the EPSG latitude/longitude axis order.
        return [float(value[1]), float(value[0])]
    if srs_name == WFS_1_1_EPSG3857:
        return list(_lon_lat_to_web_mercator(float(value[0]), float(value[1])))
    raise WfsRequestError("InvalidParameterValue", "srsName", "legacy output CRS is unsupported")


def _legacy_coordinates(value: Any, srs_name: str) -> Any:
    if (
        isinstance(value, list)
        and len(value) == 2
        and all(isinstance(item, int | float) and not isinstance(item, bool) for item in value)
    ):
        return _legacy_position(value, srs_name)
    if not isinstance(value, list):
        raise WfsRequestError(
            "InvalidParameterValue", "geometry", "legacy geometry coordinates are invalid"
        )
    return [_legacy_coordinates(item, srs_name) for item in value]


def _legacy_geometry_to_crs84(geometry: dict[str, Any], srs_name: str) -> dict[str, Any]:
    if srs_name == WFS_1_1_EPSG4326:
        return geometry

    def transform(value: Any) -> Any:
        if (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, int | float) and not isinstance(item, bool) for item in value)
        ):
            return list(_web_mercator_to_lon_lat(float(value[0]), float(value[1])))
        if not isinstance(value, list):
            raise WfsRequestError(
                "InvalidParameterValue", "geometry", "legacy geometry coordinates are invalid"
            )
        return [transform(item) for item in value]

    return {"type": geometry["type"], "coordinates": transform(geometry["coordinates"])}


def _lon_lat_to_web_mercator(longitude: float, latitude: float) -> tuple[float, float]:
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise WfsRequestError(
            "InvalidParameterValue", "geometry", "CRS84 coordinate is outside world bounds"
        )
    bounded_latitude = max(-85.0511287798066, min(85.0511287798066, latitude))
    x = longitude * WEB_MERCATOR_LIMIT / 180
    y = (
        math.log(math.tan((90 + bounded_latitude) * math.pi / 360))
        / (math.pi / 180)
        * WEB_MERCATOR_LIMIT
        / 180
    )
    return x, y


def _web_mercator_to_lon_lat(x: float, y: float) -> tuple[float, float]:
    if not (
        -WEB_MERCATOR_LIMIT <= x <= WEB_MERCATOR_LIMIT
        and -WEB_MERCATOR_LIMIT <= y <= WEB_MERCATOR_LIMIT
    ):
        raise WfsRequestError(
            "InvalidParameterValue", "geometry", "EPSG:3857 coordinate is outside world bounds"
        )
    longitude = x / WEB_MERCATOR_LIMIT * 180
    latitude = math.degrees(2 * math.atan(math.exp(y / WEB_MERCATOR_LIMIT * math.pi)) - math.pi / 2)
    return longitude, latitude


def _utc_instant(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("feature timestamp must be timezone-aware")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _q(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _namespace(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def _is_gml(element: ET.Element, name: str) -> bool:
    return (
        _namespace(element.tag) in {GML_NAMESPACE, GML_2_NAMESPACE} and _local(element.tag) == name
    )
