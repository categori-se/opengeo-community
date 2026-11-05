import json
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

from opengeo_api.app import create_app
from opengeo_api.config import Settings
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_adapters import (
    MetadataImportInvalid,
    assert_safe_metadata_source,
    build_metadata_import_plan,
    metadata_source_checksum,
)
from opengeo_api.metadata_profiles import (
    export_datacite_4_7,
    export_dcat_3,
    export_geodcat_ap_3_1,
    export_iso_19115_3,
    export_schema_org_dataset,
    export_stac_1_1,
)

ROOT = Path(__file__).parents[3]
NOW = datetime(2026, 8, 20, tzinfo=UTC)
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000a1")


def fixture(name: str) -> dict:
    return json.loads((ROOT / "parity" / "fixtures" / "data" / name).read_text())


def resource_from_plan(plan):
    draft = plan.draft
    metadata = draft.metadata
    summary = SimpleNamespace(
        resource_id=RESOURCE_ID,
        kind=draft.kind,
        version_number=1,
        created_at=NOW,
        updated_at=NOW,
        title=metadata.title,
        abstract=metadata.abstract,
        language=metadata.language,
        license=metadata.license,
        attribution=metadata.attribution,
        keywords=metadata.keywords,
        spatial_extent=metadata.spatial_extent,
        temporal_start=metadata.temporal_start,
        temporal_end=metadata.temporal_end,
    )
    return SimpleNamespace(
        summary=summary,
        translations=metadata.translations,
        metadata_extensions=metadata.extensions,
        provenance=draft.provenance,
        relationships=(),
    )


def test_dcat_import_preserves_source_and_round_trips_supported_semantics() -> None:
    document = fixture("metadata-001-dcat3.json")
    plan = build_metadata_import_plan(
        "dcat_3",
        "example.catalog",
        "road-access-dcat",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    exported = export_dcat_3(resource_from_plan(plan))["document"]

    assert plan.source_document == document
    assert plan.source_identifier == "road-access-2026"
    assert plan.draft.metadata.spatial_extent == (84.0, 27.0, 86.0, 29.0)
    assert plan.draft.metadata.temporal_start == datetime(2026, 1, 1, tzinfo=UTC)
    assert plan.conversion_report["unmapped"] == ["@id"]
    assert plan.draft.metadata.extensions["opengeo"]["contacts"] == [
        {"name": "Example newsroom", "role": "publisher"}
    ]
    assert plan.conversion_report["preservedSource"]["syntacticIdentity"] is False
    assert exported["dct:title"] == document["dct:title"]
    assert exported["dct:description"] == document["dct:description"]
    assert exported["dct:license"] == document["dct:license"]
    assert exported["dct:rights"] == document["dct:rights"]
    assert exported["dcat:keyword"] == document["dcat:keyword"]
    assert exported["dct:spatial"] == document["dct:spatial"]


def test_stac_import_preserves_source_and_round_trips_supported_semantics() -> None:
    document = fixture("metadata-001-stac11.json")
    plan = build_metadata_import_plan(
        "stac_1_1",
        "example.catalog",
        "road-access-stac",
        "organization",
        document,
        metadata_source_checksum(document),
    )
    exported = export_stac_1_1(resource_from_plan(plan))["document"]

    assert plan.source_document == document
    assert plan.draft.kind == "dataset"
    assert plan.draft.state == "review"
    assert plan.conversion_report["unmapped"] == ["links", "stac_extensions", "summaries"]
    assert exported["title"] == document["title"]
    assert exported["description"] == document["description"]
    assert exported["license"] == document["license"]
    assert exported["keywords"] == document["keywords"]
    assert exported["extent"]["spatial"] == document["extent"]["spatial"]
    assert datetime.fromisoformat(
        exported["extent"]["temporal"]["interval"][0][0]
    ) == datetime.fromisoformat(document["extent"]["temporal"]["interval"][0][0])


def test_stac_partitions_are_union_mapped_and_reported_instead_of_silently_dropped() -> None:
    document = fixture("metadata-001-stac11.json")
    document["extent"]["spatial"]["bbox"].append([80.0, 20.0, 82.0, 25.0])
    document["extent"]["temporal"]["interval"].append(
        ["2025-01-01T00:00:00Z", "2025-12-31T00:00:00Z"]
    )
    plan = build_metadata_import_plan(
        "stac_1_1",
        "example.catalog",
        "partitioned",
        "restricted",
        document,
        metadata_source_checksum(document),
    )

    assert plan.draft.metadata.spatial_extent == (80.0, 20.0, 86.0, 29.0)
    assert plan.draft.metadata.temporal_start == datetime(2025, 1, 1, tzinfo=UTC)
    assert plan.draft.metadata.temporal_end == datetime(2026, 8, 20, tzinfo=UTC)
    assert plan.conversion_report["derived"] == [
        "multiple spatial bboxes unioned",
        "multiple temporal intervals unioned",
    ]


def test_dcat_multilingual_values_round_trip_into_versioned_translations() -> None:
    document = fixture("metadata-001-dcat3.json")
    document["dct:language"] = ["en", "fr"]
    document["dct:title"] = [
        {"@value": "Road access survey", "@language": "en"},
        {"@value": "Enquête sur l'accès routier", "@language": "fr"},
    ]
    document["dct:description"] = [
        {"@value": "Verified roads metadata.", "@language": "en"},
        {"@value": "Métadonnées routières vérifiées.", "@language": "fr"},
    ]
    document["dcat:keyword"] = [
        {"@value": "roads", "@language": "en"},
        {"@value": "routes", "@language": "fr"},
    ]

    plan = build_metadata_import_plan(
        "dcat_3",
        "example.catalog",
        "multilingual-roads",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    exported = export_dcat_3(resource_from_plan(plan))

    assert plan.draft.metadata.language == "en"
    assert plan.draft.metadata.translations["fr"] == {
        "title": "Enquête sur l'accès routier",
        "abstract": "Métadonnées routières vérifiées.",
        "keywords": ["routes"],
    }
    assert "language-tagged values->translations" in plan.conversion_report["mapped"]
    assert exported["document"]["dct:title"] == document["dct:title"]


def test_metadata_import_rejects_checksum_mismatch_credentials_and_unsupported_shapes() -> None:
    document = fixture("metadata-001-stac11.json")
    with pytest.raises(MetadataImportInvalid, match="checksum"):
        build_metadata_import_plan(
            "stac_1_1", "example.catalog", "roads", "restricted", document, "0" * 64
        )

    document["links"] = [{"href": "https://example.test/data?access_token=private"}]
    with pytest.raises(MetadataImportInvalid, match="secret"):
        assert_safe_metadata_source(document)

    dcat = fixture("metadata-001-dcat3.json")
    dcat["dct:spatial"]["locn:geometry"]["@value"] = "POINT (84 27)"
    with pytest.raises(MetadataImportInvalid, match="WKT polygon"):
        build_metadata_import_plan(
            "dcat_3",
            "example.catalog",
            "roads",
            "restricted",
            dcat,
            metadata_source_checksum(dcat),
        )

    datacite = fixture("metadata-004-datacite47.json")
    datacite["data"]["attributes"]["creators"] = [
        {"name": f"Researcher {index} " + "x" * 280} for index in range(32)
    ]
    with pytest.raises(MetadataImportInvalid, match="extensions exceed 8192"):
        build_metadata_import_plan(
            "datacite_4_7",
            "example.datacite",
            "oversized-mapped-extensions",
            "restricted",
            datacite,
            metadata_source_checksum(datacite),
        )


def test_schema_org_30_import_and_export_preserve_supported_multilingual_semantics() -> None:
    document = fixture("metadata-003-schemaorg30-dataset.json")
    plan = build_metadata_import_plan(
        "schema_org_dataset",
        "example.schema",
        "road-access-schema",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    exported = export_schema_org_dataset(resource_from_plan(plan))

    assert plan.source_version == "30.0"
    assert plan.source_identifier == "road-access-2026"
    assert plan.draft.metadata.translations["fr"]["title"] == ("Enquête sur l'accès routier")
    assert plan.draft.metadata.spatial_extent == (84.0, 27.0, 86.0, 29.0)
    assert plan.conversion_report["unmapped"] == ["variableMeasured"]
    assert {
        contact["role"] for contact in plan.draft.metadata.extensions["opengeo"]["contacts"]
    } == {
        "creator",
        "publisher",
    }
    assert exported["document"]["name"] == document["name"]
    assert exported["document"]["spatialCoverage"] == document["spatialCoverage"]


def test_datacite_47_import_and_export_preserve_citation_and_extent_semantics() -> None:
    document = fixture("metadata-004-datacite47.json")
    document["data"]["attributes"]["fundingReferences"] = [
        {
            "funderName": "Open Research Foundation",
            "funderIdentifier": "https://ror.org/03yrm5c26",
            "funderIdentifierType": "ROR",
            "schemeUri": "https://ror.org",
            "awardNumber": "ORF-2026-0042",
            "awardUri": "https://awards.example.test/ORF-2026-0042",
            "awardTitle": "Open spatial evidence infrastructure",
        }
    ]
    plan = build_metadata_import_plan(
        "datacite_4_7",
        "example.datacite",
        "road-access-datacite",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    exported = export_datacite_4_7(resource_from_plan(plan))
    attributes = exported["document"]["data"]["attributes"]

    assert plan.source_version == "4.7"
    assert plan.source_identifier == "10.1234/road-access.2026"
    assert plan.draft.metadata.extensions["datacite"]["publicationYear"] == 2026
    assert plan.draft.metadata.extensions["opengeo"]["schemaVersion"] == "1.1.0"
    assert (
        plan.draft.metadata.extensions["opengeo"]["funding"]
        == (document["data"]["attributes"]["fundingReferences"])
    )
    assert [
        contact["role"] for contact in plan.draft.metadata.extensions["opengeo"]["contacts"]
    ] == ["creator", "publisher"]
    assert plan.draft.metadata.translations["fr"]["abstract"] == (
        "Métadonnées routières vérifiées."
    )
    assert attributes["doi"] == "10.1234/road-access.2026"
    assert attributes["titles"] == document["data"]["attributes"]["titles"]
    assert attributes["geoLocations"] == document["data"]["attributes"]["geoLocations"]
    assert attributes["fundingReferences"] == document["data"]["attributes"]["fundingReferences"]


def test_geodcat_ap_31_round_trip_preserves_fields_without_conformance_claim() -> None:
    document = fixture("metadata-005-geodcat-ap31.json")
    plan = build_metadata_import_plan(
        "geodcat_ap_3_1",
        "example.geodcat",
        "road-access-geodcat",
        "organization",
        document,
        metadata_source_checksum(document),
    )
    exported = export_geodcat_ap_3_1(resource_from_plan(plan))

    assert plan.source_version == "3.1.0"
    assert plan.draft.metadata.extensions["geodcat_ap"]["dcat:theme"] == (document["dcat:theme"])
    assert exported["document"]["geodcatap:topicCategory"] == [
        {
            "@id": document["geodcatap:topicCategory"],
            "@type": "skos:Concept",
            "skos:prefLabel": {"@value": "transportation", "@language": "en"},
        }
    ]
    assert exported["document"]["dcat:spatialResolutionInMeters"] == {
        "@value": "10",
        "@type": "xsd:decimal",
    }
    assert exported["report"]["conformanceClaimed"] is False


def test_geodcat_catalog_fields_map_into_native_metadata_and_back() -> None:
    document = fixture("metadata-005-geodcat-ap31.json")
    document.update(
        {
            "dcat:contactPoint": {
                "@type": "vcard:Kind",
                "vcard:fn": "Ada Researcher",
                "vcard:hasEmail": {"@id": "mailto:ada@example.test"},
            },
            "dct:publisher": {"foaf:name": "Open Research Lab"},
            "dcat:distribution": {
                "@type": "dcat:Distribution",
                "dct:title": "Roads GeoJSON",
                "dcat:downloadURL": "https://data.example.test/roads.geojson",
                "dcat:mediaType": "application/geo+json",
                "dcat:byteSize": {"@value": 4096},
                "spdx:checksum": {"spdx:checksumValue": "a" * 64},
            },
            "dct:provenance": "Field observations were checked before publication.",
            "prov:wasDerivedFrom": "urn:uuid:10000000-0000-4000-8000-000000000001",
            "dqv:hasQualityMeasurement": {
                "dqv:isMeasurementOf": "completeness",
                "dqv:value": 0.98,
                "sdmx-attribute:unitMeasure": "ratio",
            },
            "dct:accrualPeriodicity": "annual",
            "dct:accessRights": "public",
        }
    )
    plan = build_metadata_import_plan(
        "geodcat_ap_3_1",
        "example.geodcat",
        "catalog-fields",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    catalog = plan.draft.metadata.extensions["opengeo"]
    exported = export_geodcat_ap_3_1(resource_from_plan(plan))

    assert catalog["schemaVersion"] == "1.0.0"
    assert [contact["role"] for contact in catalog["contacts"]] == [
        "pointOfContact",
        "publisher",
    ]
    assert catalog["distributions"][0]["byteSize"] == 4096
    assert catalog["referenceSystems"][0]["identifier"] == "4326"
    assert catalog["lineage"]["sources"] == ["urn:uuid:10000000-0000-4000-8000-000000000001"]
    assert catalog["quality"][0]["result"] == 0.98
    assert exported["document"]["dcat:distribution"][0]["dcat:downloadURL"] == {
        "@id": "https://data.example.test/roads.geojson"
    }
    assert exported["document"]["dqv:hasQualityMeasurement"][0]["dqv:value"] == 0.98
    assert "metadata_extensions.opengeo.referenceSystems" in exported["report"]["mapped"]


def test_iso_19115_3_exact_xml_import_and_semantic_export_are_bounded() -> None:
    document = (ROOT / "parity/fixtures/data/metadata-006-iso19115-3.xml").read_text()
    plan = build_metadata_import_plan(
        "iso_19115_3",
        "example.iso",
        "road-access-iso",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    plan.draft.metadata.extensions["opengeo"].update(
        {
            "schemaVersion": "1.3.0",
            "distributions": [
                {
                    "title": "Roads GeoJSON",
                    "downloadUrl": "https://data.example.test/roads.geojson",
                    "format": "GeoJSON",
                    "mediaType": "application/geo+json",
                    "checksumSha256": "a" * 64,
                }
            ],
            "quality": [
                {
                    "measure": "completeness",
                    "result": 0.98,
                    "unit": "ratio",
                    "description": "Sampled against imagery.",
                }
            ],
            "acquisition": {
                "instruments": [
                    {
                        "identifier": "CAM-01",
                        "type": "multispectral camera",
                        "description": "Field survey camera.",
                    }
                ],
                "platforms": [
                    {
                        "identifier": "UAV-01",
                        "description": "Uncrewed aerial survey platform.",
                        "instrumentIdentifiers": ["CAM-01"],
                    }
                ],
                "operations": [
                    {
                        "identifier": "MISSION-2026-07",
                        "description": "July field collection mission.",
                        "status": "completed",
                        "type": "real",
                        "eventIdentifiers": ["EVENT-2026-07-START"],
                    }
                ],
                "platformPasses": [
                    {
                        "identifier": "PASS-2026-07-A",
                        "eventIdentifiers": ["EVENT-2026-07-START"],
                    }
                ],
                "events": [
                    {
                        "identifier": "EVENT-2026-07-START",
                        "trigger": "automatic",
                        "context": "acquisition",
                        "sequence": "start",
                        "time": "2026-07-01T09:00:00Z",
                        "passIdentifier": "PASS-2026-07-A",
                        "instrumentIdentifiers": ["CAM-01"],
                        "objectiveIdentifiers": ["OBJECTIVE-2026-07"],
                    }
                ],
                "objectives": [
                    {
                        "identifier": "OBJECTIVE-2026-07",
                        "priority": "Document post-storm road access.",
                        "types": ["survey"],
                        "functions": ["damage assessment"],
                        "instrumentIdentifiers": ["CAM-01"],
                        "passIdentifiers": ["PASS-2026-07-A"],
                        "eventIdentifiers": ["EVENT-2026-07-START"],
                    }
                ],
                "requirements": [
                    {
                        "identifier": "REQUIREMENT-2026-07",
                        "requestors": ["Investigations desk"],
                        "recipients": ["Public data team"],
                        "priority": "highImportance",
                        "requestedDate": {
                            "requestedDateOfCollection": "2026-07-01T09:00:00Z",
                            "latestAcceptableDate": "2026-07-31T18:00:00Z",
                        },
                        "expiryDate": "2026-08-31T18:00:00Z",
                    }
                ],
                "plans": [
                    {
                        "identifier": "PLAN-2026-07",
                        "status": "planned",
                        "type": "areal",
                        "operationIdentifiers": ["MISSION-2026-07"],
                        "requirementIdentifiers": ["REQUIREMENT-2026-07"],
                    }
                ],
            },
        }
    )
    exported = export_iso_19115_3(resource_from_plan(plan))
    reparsed = build_metadata_import_plan(
        "iso_19115_3",
        "example.iso",
        "road-access-iso-export",
        "restricted",
        exported["documentText"],
        metadata_source_checksum(exported["documentText"]),
    )

    assert plan.source_document == document
    assert plan.conversion_report["preservedSource"] == {
        "status": "exact_utf8_preserved",
        "checksumBasis": "raw_utf8",
        "syntacticIdentity": True,
    }
    assert plan.draft.metadata.spatial_extent == (84.0, 27.0, 86.0, 29.0)
    assert plan.draft.metadata.extensions["opengeo"]["contacts"] == [
        {"organization": "Research team", "role": "pointOfContact"}
    ]
    assert reparsed.draft.metadata.extensions["opengeo"]["distributions"] == [
        {
            "title": "Roads GeoJSON",
            "downloadUrl": "https://data.example.test/roads.geojson",
            "format": "GeoJSON",
            "isoTransfer": {
                "formats": [{"citation": {"title": "GeoJSON"}}],
                "onlineResources": [
                    {
                        "linkage": "https://data.example.test/roads.geojson",
                        "function": "download",
                        "name": "Roads GeoJSON",
                    }
                ],
                "projections": {"downloadUrl": 0, "title": 0, "format": 0},
            },
        }
    ]
    assert reparsed.draft.metadata.extensions["opengeo"]["quality"] == [
        {
            "measure": "completeness",
            "result": 0.98,
            "unit": "ratio",
            "description": "Sampled against imagery.",
        }
    ]
    assert reparsed.draft.metadata.extensions["opengeo"]["schemaVersion"] == "1.5.0"
    assert (
        reparsed.draft.metadata.extensions["opengeo"]["acquisition"]
        == (plan.draft.metadata.extensions["opengeo"]["acquisition"])
    )
    assert "metadata_extensions.opengeo.acquisition" in exported["report"]["mapped"]
    assert (
        "metadata_extensions.opengeo.distributions[0].checksumSha256"
        in exported["report"]["unmapped"]
    )
    assert "metadata_extensions.opengeo.quality[0].unit" not in exported["report"]["unmapped"]
    assert reparsed.draft.metadata.title == plan.draft.metadata.title
    assert reparsed.draft.metadata.temporal_end == plan.draft.metadata.temporal_end
    assert exported["report"]["schemaValidated"] is False
    with pytest.raises(MetadataImportInvalid, match="DTD or entity"):
        assert_safe_metadata_source(
            '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>'
            '<mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0" />'
        )
    with pytest.raises(MetadataImportInvalid, match="ISO 19115-3:2023"):
        assert_safe_metadata_source(
            '<mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/1.0" />'
        )


def test_iso_quantitative_quality_units_round_trip_exact_labels_and_unique_ids() -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    quality = [
        {"measure": "concentration", "result": 3.5, "unit": "µg & m⁻³"},
        {"measure": "completeness", "result": 1, "unit": "ratio"},
        {"measure": "observations", "result": 12},
    ]
    resource.metadata_extensions["opengeo"]["quality"] = quality
    exported = export_iso_19115_3(resource)
    assert export_iso_19115_3(resource)["documentText"] == exported["documentText"]
    assert "µg &amp; m⁻³" in exported["documentText"]
    root = ET.fromstring(exported["documentText"])
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    gml = "{http://www.opengis.net/gml/3.2}"
    results = list(root.iter(f"{mdq}DQ_QuantitativeResult"))
    assert len(results) == 3
    assert [[node.tag for node in result] for result in results] == [
        [f"{mdq}value", f"{mdq}valueUnit"],
        [f"{mdq}value", f"{mdq}valueUnit"],
        [f"{mdq}value"],
    ]
    definitions = list(root.iter(f"{gml}UnitDefinition"))
    assert [node.get(f"{gml}id") for node in definitions] == ["quality-unit-0", "quality-unit-1"]
    assert [node[0].text for node in definitions] == ["µg & m⁻³", "ratio"]
    assert all(node[0].attrib == {"codeSpace": ""} for node in definitions)
    assert not any(
        "quality[" in path and path.endswith(".unit") for path in exported["report"]["unmapped"]
    )
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["quality"] == quality
    assert resource.metadata_extensions["opengeo"]["quality"] == quality
    assert (
        "mdq:valueUnit->metadata_extensions.opengeo.quality[0].unit"
        in reopened.conversion_report["mapped"]
    )
    assert reopened.source_document == exported["documentText"]


@pytest.mark.parametrize(
    "invalid_character",
    ["\x00", "\x1f", "\r", "\ud800", "\ufffe", "\uffff"],
    ids=["nul", "control", "cr", "surrogate", "fffe", "ffff"],
)
def test_iso_quality_unit_unsupported_labels_remain_explicit_losses(
    invalid_character: str,
) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    unit = f"native{invalid_character}unit"
    resource.metadata_extensions["opengeo"]["quality"] = [
        {"measure": "completeness", "result": 0.98, "unit": unit}
    ]
    exported = export_iso_19115_3(resource)
    root = ET.fromstring(exported["documentText"])
    assert not list(root.iter("{http://www.opengis.net/gml/3.2}UnitDefinition"))
    assert "metadata_extensions.opengeo.quality[0].unit" in exported["report"]["unmapped"]
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["quality"] == [
        {"measure": "completeness", "result": 0.98}
    ]
    assert resource.metadata_extensions["opengeo"]["quality"][0]["unit"] == unit


def test_iso_descriptive_quality_unit_remains_an_explicit_loss() -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"]["quality"] = [
        {"measure": "review", "result": "Accepted with caveats", "unit": "category"}
    ]
    exported = export_iso_19115_3(resource)
    assert "valueUnit" not in exported["documentText"]
    assert "metadata_extensions.opengeo.quality[0].unit" in exported["report"]["unmapped"]
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["quality"] == [
        {"measure": "review", "result": "Accepted with caveats"}
    ]
    assert resource.metadata_extensions["opengeo"]["quality"][0]["unit"] == "category"


@pytest.mark.parametrize("unsupported", ["reference", "complex", "foreign", "ambiguous"])
def test_iso_unsupported_quality_unit_shapes_preserve_source_and_report_loss(
    unsupported: str,
) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"]["quality"] = [
        {"measure": "completeness", "result": 0.98, "unit": "ratio"}
    ]
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    gml = "{http://www.opengis.net/gml/3.2}"
    unit_scope = next(root.iter(f"{mdq}valueUnit"))
    definition = unit_scope[0]
    if unsupported == "reference":
        unit_scope.clear()
        unit_scope.set("{http://www.w3.org/1999/xlink}href", "https://example.invalid/unit/ratio")
    elif unsupported == "complex":
        ET.SubElement(definition, f"{gml}quantityType").text = "dimensionless"
    elif unsupported == "foreign":
        definition.tag = "{https://example.invalid/foreign}UnitDefinition"
    else:
        ET.SubElement(definition, f"{gml}identifier", {"codeSpace": ""}).text = "percent"
    document = ET.tostring(root, encoding="unicode")
    plan = iso_import(document)
    assert plan.draft.metadata.extensions["opengeo"]["quality"] == [
        {"measure": "completeness", "result": 0.98}
    ]
    assert "dataQualityInfo.quality[0].valueUnit[unsupported]" in plan.conversion_report["unmapped"]
    assert plan.source_document == document
    assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)


@pytest.mark.parametrize("reciprocal_forward", [False, True])
def test_iso_acquisition_reverse_links_restore_graph_and_dedupe_reciprocals(
    reciprocal_forward: bool,
) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    catalog = fixture("metadata-012-opengeo-acquisition-planning.json")
    second_plan = dict(catalog["acquisition"]["plans"][0], identifier="PLAN-SECOND")
    catalog["acquisition"]["plans"].append(second_plan)
    resource.metadata_extensions["opengeo"] = catalog
    exported = export_iso_19115_3(resource)
    root = ET.fromstring(exported["documentText"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    href_attribute = "{http://www.w3.org/1999/xlink}href"
    requirement = next(root.iter(f"{mac}MI_Requirement"))
    assert [node.tag for node in requirement][-3:] == [
        f"{mac}expiryDate",
        f"{mac}satisifiedPlan",
        f"{mac}satisifiedPlan",
    ]
    assert [node.get(href_attribute) for node in requirement.findall(f"{mac}satisifiedPlan")] == [
        "#opengeo-plan-1",
        "#opengeo-plan-2",
    ]
    if not reciprocal_forward:
        for plan in root.iter(f"{mac}MI_Plan"):
            for reference in plan.findall(f"{mac}satisfiedRequirement"):
                plan.remove(reference)
    document = ET.tostring(root, encoding="unicode")
    reopened = iso_import(document)
    assert (
        reopened.draft.metadata.extensions["opengeo"]["acquisition"]["plans"]
        == catalog["acquisition"]["plans"]
    )
    assert (
        "mac:satisifiedPlan->metadata_extensions.opengeo.acquisition.plans.requirementIdentifiers"
        in reopened.conversion_report["mapped"]
    )
    assert not any("satisifiedPlan" in path for path in reopened.conversion_report["unmapped"])
    assert reopened.source_document == document
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(document)


@pytest.mark.parametrize("unsupported", ["external", "unresolved", "foreign", "ambiguous"])
def test_iso_acquisition_reverse_unsupported_refs_preserve_source_without_joins(
    unsupported: str,
) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    catalog = fixture("metadata-012-opengeo-acquisition-planning.json")
    catalog["acquisition"]["plans"].append(
        dict(catalog["acquisition"]["plans"][0], identifier="PLAN-SECOND")
    )
    resource.metadata_extensions["opengeo"] = catalog
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    href_attribute = "{http://www.w3.org/1999/xlink}href"
    plans = list(root.iter(f"{mac}MI_Plan"))
    for plan in plans:
        for reference in plan.findall(f"{mac}satisfiedRequirement"):
            plan.remove(reference)
    requirement = next(root.iter(f"{mac}MI_Requirement"))
    references = requirement.findall(f"{mac}satisifiedPlan")
    reference = references[0]
    requirement.remove(references[1])
    if unsupported == "external":
        reference.set(href_attribute, "https://example.invalid/plan.xml#opengeo-plan-1")
    elif unsupported == "unresolved":
        reference.set(href_attribute, "#absent-plan")
    elif unsupported == "foreign":
        reference.tag = "{https://example.invalid/foreign}satisifiedPlan"
    else:
        plans[1].set("id", plans[0].get("id"))
    document = ET.tostring(root, encoding="unicode")
    reopened = iso_import(document)
    imported_plans = reopened.draft.metadata.extensions["opengeo"]["acquisition"]["plans"]
    assert all("requirementIdentifiers" not in plan for plan in imported_plans)
    assert any(
        path.endswith(".satisifiedPlan[unsupported]")
        for path in reopened.conversion_report["unmapped"]
    )
    assert reopened.source_document == document
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(document)


def localized_iso_document() -> str:
    document = (ROOT / "parity/fixtures/data/metadata-006-iso19115-3.xml").read_text()
    document = document.replace(
        "<mdb:MD_Metadata ",
        '<mdb:MD_Metadata xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ',
        1,
    )
    locales = """
      <mdb:otherLocale><lan:PT_Locale id="locale-fr"><lan:language>
        <lan:LanguageCode
          codeList="https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml"
          codeListValue="fr">fr</lan:LanguageCode>
      </lan:language><lan:characterEncoding><lan:MD_CharacterSetCode
        codeList="https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_CharacterSetCode"
        codeListValue="utf8">utf8</lan:MD_CharacterSetCode>
      </lan:characterEncoding></lan:PT_Locale></mdb:otherLocale>
      <mdb:otherLocale><lan:PT_Locale id="locale-ne"><lan:language>
        <lan:LanguageCode
          codeList="https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml"
          codeListValue="ne">ne</lan:LanguageCode>
      </lan:language><lan:characterEncoding><lan:MD_CharacterSetCode
        codeList="https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_CharacterSetCode"
        codeListValue="utf8">utf8</lan:MD_CharacterSetCode>
      </lan:characterEncoding></lan:PT_Locale></mdb:otherLocale>
    """
    document = document.replace("<mdb:identificationInfo>", locales + "<mdb:identificationInfo>", 1)
    for property_name, original, localized in (
        (
            "cit:title",
            "Road access survey",
            """
          <lan:PT_FreeText>
            <lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-fr">Enquête routière
            </lan:LocalisedCharacterString>
          </lan:textGroup>
            <lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-ne">सडक पहुँच सर्वेक्षण
            </lan:LocalisedCharacterString>
          </lan:textGroup>
          </lan:PT_FreeText>
        """,
        ),
        (
            "mri:abstract",
            "Verified roads metadata.",
            """
          <lan:PT_FreeText><lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-fr">Métadonnées vérifiées.
            </lan:LocalisedCharacterString>
          </lan:textGroup></lan:PT_FreeText>
        """,
        ),
        (
            "mri:credit",
            "Research team",
            """
          <lan:PT_FreeText><lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-fr">Équipe &amp; partenaires
            </lan:LocalisedCharacterString>
          </lan:textGroup></lan:PT_FreeText>
        """,
        ),
        (
            "mri:keyword",
            "roads",
            """
          <lan:PT_FreeText><lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-fr">routes
            </lan:LocalisedCharacterString>
          </lan:textGroup></lan:PT_FreeText>
        """,
        ),
        (
            "mri:keyword",
            "transport",
            """
          <lan:PT_FreeText><lan:textGroup>
            <lan:LocalisedCharacterString locale="#locale-fr">mobilité
            </lan:LocalisedCharacterString>
          </lan:textGroup></lan:PT_FreeText>
        """,
        ),
    ):
        document = document.replace(
            f"<{property_name}><gco:CharacterString>{original}</gco:CharacterString>",
            f'<{property_name} xsi:type="lan:PT_FreeText_PropertyType">'
            f"<gco:CharacterString>{original}</gco:CharacterString>{localized}",
            1,
        )
    return document


def iso_import(document: str):
    return build_metadata_import_plan(
        "iso_19115_3",
        "example.iso",
        "localized-roads",
        "restricted",
        document,
        metadata_source_checksum(document),
    )


def test_iso_localized_metadata_survives_xml_export_and_fresh_import() -> None:
    document = localized_iso_document()
    plan = iso_import(document)
    expected = {
        "fr": {
            "title": "Enquête routière",
            "abstract": "Métadonnées vérifiées.",
            "attribution": "Équipe & partenaires",
            "keywords": ["routes", "mobilité"],
        },
        "ne": {"title": "सडक पहुँच सर्वेक्षण"},
    }
    assert plan.draft.metadata.translations == expected
    assert plan.draft.metadata.language == "en"
    assert plan.draft.metadata.keywords == ("roads", "transport")
    assert plan.source_document == document
    assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
    assert "lan:PT_FreeText->translations" in plan.conversion_report["mapped"]
    assert not any(
        "LocalisedCharacterString" in item for item in plan.conversion_report["unmapped"]
    )

    exported = export_iso_19115_3(resource_from_plan(plan))
    root = ET.fromstring(exported["documentText"])
    namespaces = {
        "lan": "http://standards.iso.org/iso/19115/-3/lan/1.0",
        "cit": "http://standards.iso.org/iso/19115/-3/cit/2.0",
    }
    title = root.find(".//cit:title", namespaces)
    assert title is not None
    assert (
        title.get("{http://www.w3.org/2001/XMLSchema-instance}type")
        == "lan:PT_FreeText_PropertyType"
    )
    assert len(root.findall(".//lan:PT_FreeText", namespaces)) == 5
    assert "translations" in exported["report"]["mapped"]
    assert "translations" not in exported["report"]["unmapped"]
    assert exported["report"]["conformanceClaimed"] is False
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.translations == expected
    assert reopened.draft.metadata.title == plan.draft.metadata.title
    assert reopened.draft.metadata.abstract == plan.draft.metadata.abstract
    assert reopened.draft.metadata.attribution == plan.draft.metadata.attribution
    assert reopened.draft.metadata.keywords == plan.draft.metadata.keywords


@pytest.mark.parametrize("language", ["fr-CA", "fr-ca"])
def test_iso_primary_language_country_survives_export_and_fresh_import(language: str) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.summary.language = language
    exported = export_iso_19115_3(resource)
    root = ET.fromstring(exported["documentText"])
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    locale = root.find(f"{mdb}defaultLocale/{lan}PT_Locale")
    assert locale is not None
    assert [node.tag for node in locale] == [
        f"{lan}language",
        f"{lan}country",
        f"{lan}characterEncoding",
    ]
    code = locale.find(f"{lan}language/{lan}LanguageCode")
    country = locale.find(f"{lan}country/{lan}CountryCode")
    assert code is not None and code.get("codeListValue") == code.text == "fr"
    assert country is not None
    assert country.get("codeList") == "ISO3166Part1"
    assert country.get("codeListValue") == country.text == "CA"
    assert "language.case->ISO_lowercase_language_uppercase_country" in exported["report"]["mapped"]
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.language == "fr-ca"
    assert reopened.draft.metadata.translations == resource.translations
    assert "mdb:defaultLocale.CountryCode->language.region" in reopened.conversion_report["mapped"]
    assert reopened.source_document == exported["documentText"]
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(
        exported["documentText"]
    )
    assert resource.summary.language == language


@pytest.mark.parametrize("language", ["sr-Latn", "fr-ZZ"])
def test_iso_primary_unsupported_tags_are_explicit_without_fake_codes(language: str) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.summary.language = language
    exported = export_iso_19115_3(resource)
    assert exported["status"] == "not_exportable_missing_required_metadata"
    assert exported["documentText"] is None
    assert exported["report"]["missingRequired"] == ["language"]
    assert exported["report"]["unmappedValues"] == {"language": language}
    assert "language" in exported["report"]["unmapped"]
    assert exported["report"]["conformanceClaimed"] is False
    assert resource.summary.language == language


@pytest.mark.parametrize("invalid_country", ["foreign-code-list", "duplicate-code"])
def test_iso_primary_untrusted_country_is_retained_without_guessing(invalid_country: str) -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.summary.language = "fr-CA"
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    country_scope = root.find(f"{mdb}defaultLocale/{lan}PT_Locale/{lan}country")
    assert country_scope is not None
    if invalid_country == "foreign-code-list":
        country_scope[0].set("codeList", "https://example.invalid/foreign-countries")
    else:
        ET.SubElement(
            country_scope, f"{lan}CountryCode", {"codeList": "ISO3166Part1", "codeListValue": "US"}
        ).text = "US"
    document = ET.tostring(root, encoding="unicode")
    plan = iso_import(document)
    assert plan.draft.metadata.language == "fr"
    assert "mdb:defaultLocale.country" in plan.conversion_report["unmapped"]
    assert plan.source_document == document
    assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)


def test_iso_primary_legacy_compound_code_retains_source_and_reexports_country() -> None:
    root = ET.fromstring(localized_iso_document())
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    code = root.find(f"{mdb}defaultLocale/{lan}PT_Locale/{lan}language/{lan}LanguageCode")
    assert code is not None
    code.text = "fr-CA"
    code.set("codeListValue", "fr-CA")
    document = ET.tostring(root, encoding="unicode")
    plan = iso_import(document)
    assert plan.draft.metadata.language == "fr-ca"
    assert (
        "mdb:defaultLocale.LanguageCode[compound-tag-preserved]"
        in plan.conversion_report["unmapped"]
    )
    assert plan.source_document == document
    exported = export_iso_19115_3(resource_from_plan(plan))
    reopened = iso_import(exported["documentText"])
    assert reopened.draft.metadata.language == "fr-ca"
    assert "mdb:defaultLocale.CountryCode->language.region" in reopened.conversion_report["mapped"]


def test_iso_export_retains_native_region_and_script_locales_as_explicit_losses() -> None:
    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.translations = {
        "fr-CA": {"title": "Enquête sur les routes du Québec", "keywords": ["routes"]},
        "sr-Latn": {"title": "Istraživanje puteva", "abstract": "Provereni podaci."},
        "fr": {"title": "Enquête routière"},
    }
    original = json.loads(json.dumps(resource.translations))
    exported = export_iso_19115_3(resource)
    root = ET.fromstring(exported["documentText"])
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    codes = [node.get("codeListValue") for node in root.iter(f"{lan}LanguageCode")]
    assert codes == ["en", "fr"]
    assert {"translations.fr-CA", "translations.sr-Latn"} <= set(exported["report"]["unmapped"])
    assert "translations" not in exported["report"]["mapped"]
    assert "translations.fr" in exported["report"]["mapped"]
    assert resource.translations == original
    assert iso_import(exported["documentText"]).draft.metadata.translations == {
        "fr": {"title": "Enquête routière"}
    }

    resource.translations.pop("fr")
    unsupported_only = export_iso_19115_3(resource)
    assert not any(item.startswith("translations") for item in unsupported_only["report"]["mapped"])
    assert {"translations.fr-CA", "translations.sr-Latn"} <= set(
        unsupported_only["report"]["unmapped"]
    )


@pytest.mark.parametrize("locale_tag", ["fr-CA", "sr-Latn"])
def test_iso_locale_tags_are_unmapped_without_guessing_language_country_or_script(
    locale_tag: str,
) -> None:
    original = iso_import(localized_iso_document())
    document = localized_iso_document().replace(
        'codeListValue="fr"', f'codeListValue="{locale_tag}"'
    )
    document = document.replace(">fr</lan:LanguageCode>", f">{locale_tag}</lan:LanguageCode>")
    plan = iso_import(document)
    assert plan.draft.metadata.translations == {"ne": {"title": "सडक पहुँच सर्वेक्षण"}}
    assert "fr" in original.draft.metadata.translations
    assert len([item for item in plan.conversion_report["unmapped"] if "Localised" in item]) == 5
    assert plan.source_document == document
    assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
    for field in ("title", "abstract", "attribution", "language", "license", "keywords"):
        assert getattr(plan.draft.metadata, field) == getattr(original.draft.metadata, field)


@pytest.mark.parametrize(
    "original,replacement",
    [
        ('locale="#locale-fr"', 'locale="#unknown"'),
        ('locale="#locale-fr"', 'locale="https://invalid.example/locale.xml#locale-fr"'),
        ('codeListValue="fr"', 'codeListValue="fr_CA"'),
        ('id="locale-ne"', 'id="locale-fr"'),
        (
            "</lan:language><lan:characterEncoding>",
            "</lan:language><lan:country>CA</lan:country><lan:characterEncoding>",
        ),
    ],
)
def test_iso_unresolved_or_ambiguous_locales_stay_in_exact_source_and_loss_report(
    original: str,
    replacement: str,
) -> None:
    document = localized_iso_document().replace(original, replacement)
    plan = iso_import(document)
    assert "fr" not in plan.draft.metadata.translations
    assert plan.source_document == document
    assert any("LocalisedCharacterString" in item for item in plan.conversion_report["unmapped"])


def test_iso_localized_abstract_without_translated_title_is_explicitly_unmapped() -> None:
    document = localized_iso_document().replace("Enquête routière", "ignored title")
    document = document.replace(
        'locale="#locale-fr">ignored title', 'locale="#unknown">ignored title'
    )
    plan = iso_import(document)
    assert "fr" not in plan.draft.metadata.translations
    assert len([item for item in plan.conversion_report["unmapped"] if "Localised" in item]) == 5
    assert plan.source_document == document


def test_iso_conflicting_translated_titles_and_entities_are_rejected_before_import() -> None:
    document = localized_iso_document()
    conflicting = document.replace('locale="#locale-ne"', 'locale="#locale-fr"', 1)
    with pytest.raises(MetadataImportInvalid, match="multiple values"):
        iso_import(conflicting)
    entity_document = document.replace(
        "<mdb:MD_Metadata ",
        '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><mdb:MD_Metadata ',
        1,
    ).replace("Enquête routière", "&secret;")
    with pytest.raises(MetadataImportInvalid, match="DTD or entity"):
        iso_import(entity_document)


def test_iso_localized_rights_and_foreign_namespace_text_remain_explicit_source_losses() -> None:
    document = localized_iso_document().replace(
        "<mco:useLimitation><gco:CharacterString>CC-BY-4.0</gco:CharacterString>",
        '<mco:useLimitation xsi:type="lan:PT_FreeText_PropertyType">'
        "<gco:CharacterString>CC-BY-4.0</gco:CharacterString><lan:PT_FreeText>"
        '<lan:textGroup><lan:LocalisedCharacterString locale="#locale-fr">'
        "Conditions particulières</lan:LocalisedCharacterString></lan:textGroup></lan:PT_FreeText>",
    )
    document = document.replace(
        "</mdb:MD_Metadata>",
        '<other:LocalisedCharacterString xmlns:other="https://invalid.example/namespace" '
        'locale="#locale-fr">Foreign value</other:LocalisedCharacterString></mdb:MD_Metadata>',
    )
    plan = iso_import(document)
    assert plan.draft.metadata.license == "CC-BY-4.0"
    assert "license" not in plan.draft.metadata.translations["fr"]
    assert len([item for item in plan.conversion_report["unmapped"] if "Localised" in item]) == 2
    assert plan.source_document == document


@pytest.mark.parametrize("property_name", ["keyword", "title", "abstract", "credit"])
def test_iso_foreign_property_cannot_turn_localized_text_into_canonical_metadata(
    property_name: str,
) -> None:
    document = localized_iso_document()
    primary_values = {
        "title": "Road access survey",
        "abstract": "Verified roads metadata.",
        "credit": "Research team",
    }
    primary = (
        f"<gco:CharacterString>{primary_values[property_name]}</gco:CharacterString>"
        if property_name in primary_values
        else ""
    )
    foreign_property = (
        f'<other:{property_name} xmlns:other="https://invalid.example/namespace">'
        f"{primary}"
        '<lan:PT_FreeText><lan:textGroup><lan:LocalisedCharacterString locale="#locale-fr">'
        f"Foreign value</lan:LocalisedCharacterString></lan:textGroup></lan:PT_FreeText>"
        f"</other:{property_name}>"
    )
    insertion = {
        "keyword": "</mri:MD_Keywords>",
        "title": "<mri:citation>",
        "abstract": "<mri:abstract",
        "credit": "<mri:credit",
    }[property_name]
    document = document.replace(insertion, foreign_property + insertion, 1)
    plan = iso_import(document)
    assert plan.draft.metadata.translations["fr"] == {
        "title": "Enquête routière",
        "abstract": "Métadonnées vérifiées.",
        "attribution": "Équipe & partenaires",
        "keywords": ["routes", "mobilité"],
    }
    assert len([item for item in plan.conversion_report["unmapped"] if "Localised" in item]) == 1
    assert plan.source_document == document


def test_iso_translation_bounds_reject_excess_languages_and_bytes() -> None:
    document = localized_iso_document()
    locale = document[
        document.index("<mdb:otherLocale>") : document.index("</mdb:otherLocale>")
        + len("</mdb:otherLocale>")
    ]
    text_group = document[
        document.index("<lan:textGroup>") : document.index("</lan:textGroup>")
        + len("</lan:textGroup>")
    ]
    languages = ("de", "es", "it", "pt", "nl", "pl", "sv")
    added_locales = "".join(
        locale.replace("locale-fr", f"locale-{language}")
        .replace('"fr"', f'"{language}"')
        .replace(">fr</", f">{language}</")
        for language in languages
    )
    added_text_groups = "".join(
        text_group.replace("locale-fr", f"locale-{language}") for language in languages
    )
    too_many = document.replace(
        "<mdb:identificationInfo>", added_locales + "<mdb:identificationInfo>"
    )
    too_many = too_many.replace("</lan:PT_FreeText>", added_text_groups + "</lan:PT_FreeText>", 1)
    with pytest.raises(MetadataImportInvalid, match="exceed 8 languages"):
        iso_import(too_many)
    oversized = document.replace("Métadonnées vérifiées.", "é" * 8_000)
    oversized = oversized.replace("Équipe &amp; partenaires", "é" * 1_000)
    with pytest.raises(MetadataImportInvalid, match="16384 canonical bytes"):
        iso_import(oversized)


def test_openapi_exposes_all_metadata_representations_without_http_threads() -> None:
    document = create_app(Settings(env="test", expose_docs=True)).openapi()
    import_parameters = document["paths"][
        "/projects/{project_id}/resources/imports/metadata/{source_format}"
    ]["post"]["parameters"]
    export_parameters = document["paths"][
        "/projects/{project_id}/resources/{resource_id}/metadata/export/{target}"
    ]["get"]["parameters"]
    source_format = next(item for item in import_parameters if item["name"] == "source_format")
    target = next(item for item in export_parameters if item["name"] == "target")

    assert source_format["schema"]["enum"] == [
        "dcat_3",
        "stac_1_1",
        "iso_19115_3",
        "schema_org_dataset",
        "datacite_4_7",
        "geodcat_ap_3_1",
    ]
    assert target["schema"]["enum"] == [
        "dcat_3",
        "stac_1_1",
        "ogc_records_1_0",
        "iso_19115_3",
        "schema_org_dataset",
        "datacite_4_7",
        "datacite_4_7_xml",
        "geodcat_ap_3_1",
    ]
    request_schema = document["components"]["schemas"]["ImportResourceMetadataRequest"]
    assert [item["type"] for item in request_schema["properties"]["document"]["anyOf"]] == [
        "object",
        "string",
    ]
    export_schema = document["components"]["schemas"]["MetadataExportResponse"]
    assert "document_text" in export_schema["required"]


def test_canonical_json_uses_code_point_order_plain_decimals_and_json_types_only() -> None:
    value = {
        "\U00010000": 84.0,
        "\ue000": 1e21,
        "small": [1e-7, -0.0],
    }

    assert canonical_json_bytes(value).decode("utf-8") == (
        '{"small":[0.0000001,0],"\ue000":1000000000000000000000,"\U00010000":84}'
    )
    with pytest.raises(TypeError, match="not JSON serializable"):
        canonical_json_bytes(("not", "a", "JSON", "array"))


def acquisition_context_resource():
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        fixture("metadata-014-opengeo-acquisition-context.json")
    )
    return resource


@pytest.mark.parametrize(
    "precision", ["representative", "integer-and-nanosecond", "finite-large-float"]
)
def test_iso_acquisition_context_round_trip_preserves_fields_identity_and_graph(
    precision: str,
) -> None:
    resource = acquisition_context_resource()
    if precision == "integer-and-nanosecond":
        acquisition = resource.metadata_extensions["opengeo"]["acquisition"]
        acquisition["environmentalConditions"]["maxAltitude"] = 9_007_199_254_740_993
        acquisition["platformPasses"][0]["extent"]["temporal"] = {
            "start": "2026-07-01T09:00:00.000000001Z",
            "end": "2026-07-01T09:00:00.000000002Z",
        }
    elif precision == "finite-large-float":
        environmental = resource.metadata_extensions["opengeo"]["acquisition"][
            "environmentalConditions"
        ]
        environmental["maxAltitude"] = 1e308
        environmental["maxRelativeHumidity"] = 1e-308
    expected = resource.metadata_extensions["opengeo"]
    exported = export_iso_19115_3(resource)
    document = exported["documentText"]
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]

    assert actual["schemaVersion"] == "1.4.0"
    assert actual["acquisition"] == expected["acquisition"]
    assert actual["acquisition"]["plans"][0]["identifier"] == "PLAN-2026-07"
    assert actual["acquisition"]["plans"][0]["citation"]["title"] != "PLAN-2026-07"
    assert reopened.draft.metadata.spatial_extent == resource.summary.spatial_extent
    assert reopened.draft.metadata.temporal_start == resource.summary.temporal_start
    assert reopened.draft.metadata.temporal_end == resource.summary.temporal_end
    assert reopened.source_document == document
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
    assert not any("acquisition" in path for path in exported["report"]["unmapped"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    environment = next(ET.fromstring(document).iter(f"{mac}MI_EnvironmentalRecord"))
    assert [child.tag for child in environment] == [
        f"{mac}{name}"
        for name in (
            "averageAirTemperature",
            "maxRelativeHumidity",
            "maxAltitude",
            "meterologicalConditions",
            "solarAzimuth",
            "solarElevation",
        )
    ]


@pytest.mark.parametrize(
    "unsupported", ["polygon", "time-instant", "foreign", "reversed-submicrosecond"]
)
def test_iso_acquisition_context_unsupported_extents_preserve_source_and_resource_bounds(
    unsupported: str,
) -> None:
    resource = acquisition_context_resource()
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    gex = "{http://standards.iso.org/iso/19115/-3/gex/1.0}"
    gml = "{http://www.opengis.net/gml/3.2}"
    objective = next(root.iter(f"{mac}MI_Objective"))
    extents = objective.findall(f"{mac}extent/{gex}EX_Extent")
    if unsupported == "polygon":
        geographic = ET.SubElement(extents[0], f"{gex}geographicElement")
        ET.SubElement(geographic, f"{gex}EX_BoundingPolygon")
    elif unsupported == "time-instant":
        period = next(extents[1].iter(f"{gml}TimePeriod"))
        period.tag = f"{gml}TimeInstant"
    elif unsupported == "foreign":
        extents[0].tag = "{https://example.invalid/foreign}EX_Extent"
    else:
        period = next(extents[1].iter(f"{gml}TimePeriod"))
        begin = period.find(f"{gml}beginPosition")
        end = period.find(f"{gml}endPosition")
        assert begin is not None and end is not None
        begin.text = "2026-07-01T09:00:00.000000002Z"
        end.text = "2026-07-01T09:00:00.000000001Z"
    document = ET.tostring(root, encoding="unicode")
    reopened = iso_import(document)

    assert reopened.source_document == document
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
    assert reopened.draft.metadata.spatial_extent == resource.summary.spatial_extent
    assert reopened.draft.metadata.temporal_start == resource.summary.temporal_start
    assert any("extent" in path.lower() for path in reopened.conversion_report["unmapped"])
    assert (
        reopened.draft.metadata.extensions["opengeo"]["acquisition"]["plans"][0]["identifier"]
        == "PLAN-2026-07"
    )


@pytest.mark.parametrize("unsupported", ["duplicate", "malformed"])
def test_iso_acquisition_context_bad_plan_carrier_cannot_reassign_graph(
    unsupported: str,
) -> None:
    resource = acquisition_context_resource()
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    mcc = "{http://standards.iso.org/iso/19115/-3/mcc/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    plan = next(root.iter(f"{mac}MI_Plan"))
    citation = plan.find(f"{mac}citation/{cit}CI_Citation")
    assert citation is not None
    carriers = [
        item
        for item in citation.findall(f"{cit}identifier")
        if item.findtext(f"{mcc}MD_Identifier/{mcc}codeSpace/{gco}CharacterString")
        == "urn:opengeo:catalog:acquisition-plan"
    ]
    assert len(carriers) == 1
    if unsupported == "duplicate":
        duplicate = ET.fromstring(ET.tostring(carriers[0]))
        code = duplicate.find(f"{mcc}MD_Identifier/{mcc}code/{gco}CharacterString")
        assert code is not None
        code.text = "OTHER-PLAN"
        citation.append(duplicate)
    else:
        carriers[0].set("unexpected", "malformed")
    document = ET.tostring(root, encoding="unicode")
    reopened = iso_import(document)

    assert not reopened.draft.metadata.extensions["opengeo"]["acquisition"].get("plans")
    assert reopened.source_document == document
    assert any("citation" in path.lower() for path in reopened.conversion_report["unmapped"])


@pytest.mark.parametrize("unsupported", ["foreign", "carriage-return"])
def test_iso_acquisition_context_environment_unsupported_values_are_not_silently_changed(
    unsupported: str,
) -> None:
    resource = acquisition_context_resource()
    root = ET.fromstring(export_iso_19115_3(resource)["documentText"])
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    environment = next(root.iter(f"{mac}MI_EnvironmentalRecord"))
    meteorology = environment.find(f"{mac}meterologicalConditions")
    assert meteorology is not None
    if unsupported == "foreign":
        meteorology.tag = "{https://example.invalid/foreign}meterologicalConditions"
    else:
        text = meteorology.find(f"{gco}CharacterString")
        assert text is not None
        text.text = "OPEN_GEO_CR_MARKER"
    document = ET.tostring(root, encoding="unicode").replace("OPEN_GEO_CR_MARKER", "clear&#13;calm")
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]["acquisition"]["environmentalConditions"]

    assert "meteorologicalConditions" not in actual
    assert actual["averageAirTemperature"] == actual["solarAzimuth"] == 0
    assert reopened.source_document == document
    assert any(
        "meterological" in path or "meteorological" in path
        for path in reopened.conversion_report["unmapped"]
    )


@pytest.mark.parametrize(
    ("field", "unsafe"),
    [
        ("environment", "clear\rcalm"),
        ("environment", "clear\x01calm"),
        ("extent", "survey\rcorridor"),
        ("citation", "survey\ufffeplan"),
    ],
)
def test_iso_acquisition_context_unsafe_native_text_keeps_native_value_with_loss(
    field: str,
    unsafe: str,
) -> None:
    resource = acquisition_context_resource()
    acquisition = resource.metadata_extensions["opengeo"]["acquisition"]
    if field == "environment":
        record, key = acquisition["environmentalConditions"], "meteorologicalConditions"
    elif field == "extent":
        record, key = acquisition["objectives"][0]["extents"][0], "description"
    else:
        record, key = acquisition["plans"][0]["citation"], "title"
    record[key] = unsafe
    exported = export_iso_19115_3(resource)

    ET.fromstring(exported["documentText"])
    assert record[key] == unsafe
    assert unsafe not in exported["documentText"]
    assert any(key in path for path in exported["report"]["unmapped"])


def test_iso_acquisition_context_xml_expansion_stays_bounded_with_explicit_losses() -> None:
    from opengeo_api.metadata_catalog import validate_catalog_metadata
    from opengeo_api.resource_routes import ResourceMetadataRequest

    box = {key: 5e-324 for key in ("west", "east", "south", "north")}
    native = {
        "schemaVersion": "1.4.0",
        "acquisition": {
            "instruments": [{"identifier": "CAM-BOUND", "type": "camera"}],
            "objectives": [
                {
                    "identifier": f"OBJECTIVE-{index}",
                    "extents": [
                        {"geographicBounds": [dict(box) for _ in range(4)]} for _ in range(4)
                    ],
                }
                for index in range(4)
            ],
        },
    }
    request = ResourceMetadataRequest(title="Survey", extensions={"opengeo": native})
    resource = acquisition_context_resource()
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        request.extensions["opengeo"]
    )
    exported = export_iso_19115_3(resource)
    document = exported["documentText"]

    assert len(document.encode("utf-8")) <= 49_152
    ET.fromstring(document)
    assert resource.metadata_extensions["opengeo"] == native
    assert any(".extents[" in path for path in exported["report"]["unmapped"])
    reopened = iso_import(document)
    assert reopened.source_document == document
    assert len(canonical_json_bytes(reopened.draft.metadata.extensions)) <= 8_192
    assert any("size-limit" in path for path in reopened.conversion_report["unmapped"])
    assert reopened.draft.metadata.extensions["opengeo"]["acquisition"]["instruments"] == [
        {"identifier": "CAM-BOUND", "type": "camera"}
    ]


def test_iso_acquisition_context_large_citation_reports_canonical_loss_keeps_graph() -> None:
    resource = acquisition_context_resource()
    acquisition = resource.metadata_extensions["opengeo"]["acquisition"]
    acquisition["plans"][0]["citation"]["alternateTitles"] = [
        f"Alternative {index}: " + "x" * 980 for index in range(8)
    ]
    document = export_iso_19115_3(resource)["documentText"]
    assert len(document.encode("utf-8")) <= 49_152
    reopened = iso_import(document)
    plan = reopened.draft.metadata.extensions["opengeo"]["acquisition"]["plans"][0]

    assert plan["identifier"] == "PLAN-2026-07"
    assert plan["operationIdentifiers"] == ["MISSION-2026-07"]
    assert plan["requirementIdentifiers"] == ["REQUIREMENT-2026-07"]
    assert "citation" not in plan
    assert reopened.source_document == document
    assert reopened.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
    assert len(canonical_json_bytes(reopened.draft.metadata.extensions)) <= 8_192
    assert any(
        "citation" in path and "size-limit" in path
        for path in reopened.conversion_report["unmapped"]
    )
    assert not any(
        "->metadata_extensions.opengeo.acquisition.plans[0].citation" in path
        for path in reopened.conversion_report["mapped"]
    )


def test_iso_acquisition_context_env_only_budget_loss_removes_empty_acquisition() -> None:
    from opengeo_api.resource_routes import ResourceMetadataRequest

    native = {
        "schemaVersion": "1.4.0",
        "contacts": [
            {"organization": f"Contact {index:02d} " + "x" * 280, "role": "pointOfContact"}
            for index in range(21)
        ],
        "acquisition": {
            "environmentalConditions": {
                name: 1e308
                for name in (
                    "averageAirTemperature",
                    "maxRelativeHumidity",
                    "maxAltitude",
                    "solarAzimuth",
                    "solarElevation",
                )
            }
        },
    }
    request = ResourceMetadataRequest(title="Survey", extensions={"opengeo": native})
    resource = acquisition_context_resource()
    resource.metadata_extensions["opengeo"] = request.extensions["opengeo"]
    document = export_iso_19115_3(resource)["documentText"]
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]

    assert actual["schemaVersion"] == "1.0.0"
    assert "acquisition" not in actual
    assert actual["contacts"] == native["contacts"]
    assert resource.metadata_extensions["opengeo"] == native
    assert reopened.source_document == document
    assert len(canonical_json_bytes(reopened.draft.metadata.extensions)) <= 8_192
    assert any("size-limit" in path for path in reopened.conversion_report["unmapped"])
    assert not any(
        "->metadata_extensions.opengeo.acquisition" in path
        for path in reopened.conversion_report["mapped"]
    )


def datacite_registration_document() -> dict:
    document = fixture("metadata-004-datacite47.json")
    attributes = document["data"]["attributes"]
    attributes["creators"][0].update(
        {
            "nameIdentifiers": [
                {
                    "nameIdentifier": "https://orcid.org/0000-0002-1825-0097",
                    "nameIdentifierScheme": "ORCID",
                    "schemeUri": "https://orcid.org",
                }
            ],
            "affiliation": [
                {
                    "name": "Open Research",
                    "affiliationIdentifier": "https://ror.org/03yrm5c26",
                    "affiliationIdentifierScheme": "ROR",
                    "schemeUri": "https://ror.org",
                }
            ],
        }
    )
    attributes.update(
        {
            "contributors": [
                {
                    "name": "Curator, Marie",
                    "nameType": "Personal",
                    "givenName": "Marie",
                    "familyName": "Curator",
                    "lang": "fr",
                    "contributorType": "DataCurator",
                    "nameIdentifiers": [
                        {"nameIdentifier": "curator-42", "nameIdentifierScheme": "Local"}
                    ],
                    "affiliation": ["Open Research"],
                }
            ],
            "alternateIdentifiers": [
                {"alternateIdentifier": "archive:roads-2026", "alternateIdentifierType": "Local"}
            ],
            "formats": ["application/geo+json"],
            "sizes": ["42 MB"],
            "relatedIdentifiers": [
                {
                    "relatedIdentifier": "https://example.test/source",
                    "relatedIdentifierType": "URL",
                    "relationType": "IsDerivedFrom",
                }
            ],
        }
    )
    return document


def datacite_registration_resource(document=None):
    document = datacite_registration_document() if document is None else document
    plan = build_metadata_import_plan(
        "datacite_4_7",
        "example.datacite",
        "registration",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    return plan, resource_from_plan(plan)


def test_datacite_registration_json_survives_fresh_reimport() -> None:
    original = datacite_registration_document()
    plan, resource = datacite_registration_resource(original)
    exported = export_datacite_4_7(resource)
    attributes = exported["document"]["data"]["attributes"]
    for key in (
        "creators",
        "contributors",
        "alternateIdentifiers",
        "formats",
        "sizes",
        "relatedIdentifiers",
    ):
        assert attributes[key] == original["data"]["attributes"][key]
    fresh, _ = datacite_registration_resource(exported["document"])
    for key in ("contributors", "alternateIdentifiers", "formats", "sizes", "relatedIdentifiers"):
        assert fresh.draft.metadata.extensions["datacite"][key] == attributes[key]
    assert plan.source_document == original
    assert resource.summary.kind == "dataset"


def test_datacite_registration_xml_emits_bibliographic_values() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    _, resource = datacite_registration_resource()
    root = ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])
    ns = {"d": "http://datacite.org/schema/kernel-4"}
    identifier = root.find("d:creators/d:creator/d:nameIdentifier", ns)
    assert identifier.text == "https://orcid.org/0000-0002-1825-0097"
    assert identifier.attrib == {"nameIdentifierScheme": "ORCID", "schemeURI": "https://orcid.org"}
    assert (
        root.find("d:creators/d:creator/d:affiliation", ns).get("affiliationIdentifierScheme")
        == "ROR"
    )
    contributor = root.find("d:contributors/d:contributor", ns)
    assert contributor.get("contributorType") == "DataCurator"
    assert (
        contributor.find("d:contributorName", ns).get("{http://www.w3.org/XML/1998/namespace}lang")
        == "fr"
    )
    for path, value in [
        ("d:alternateIdentifiers/d:alternateIdentifier", "archive:roads-2026"),
        ("d:formats/d:format", "application/geo+json"),
        ("d:sizes/d:size", "42 MB"),
    ]:
        assert root.find(path, ns).text == value


def test_datacite_registration_native_creators_and_publisher_win_conflicts() -> None:
    _, resource = datacite_registration_resource()
    for contact in resource.metadata_extensions["opengeo"]["contacts"]:
        if contact["role"] == "creator":
            contact["name"] = "Curated creator"
        if contact["role"] == "publisher":
            contact["name"] = "Curated press"
            contact["organization"] = "Curated press"
    exported = export_datacite_4_7(resource)
    attributes = exported["document"]["data"]["attributes"]
    assert attributes["creators"] == [{"name": "Curated creator"}]
    assert attributes["publisher"] == "Curated press"
    assert any(
        "retained-source-conflicts-with-native-creators" in path
        for path in exported["report"]["unmapped"]
    )
    assert any(
        "retained-source-conflicts-with-native-publisher" in path
        for path in exported["report"]["unmapped"]
    )


def test_datacite_registration_rejected_records_have_no_false_mappings() -> None:
    document = datacite_registration_document()
    values = document["data"]["attributes"]
    values["contributors"][0]["contributorType"] = {}
    values["creators"][0]["nameType"] = []
    values["creators"][0]["nameIdentifiers"] = [{"nameIdentifier": "orphan"}]
    plan, resource = datacite_registration_resource(document)
    exported = export_datacite_4_7(resource)
    assert exported["document"] is not None
    assert "contributors" not in exported["document"]["data"]["attributes"]
    assert not any(path.startswith("contributors[") for path in exported["report"]["mapped"])
    assert "contributors[0].contributorType" in exported["report"]["unmapped"]
    assert "creators[0].nameType" in exported["report"]["unmapped"]
    assert plan.source_document == document


def test_datacite_registration_merges_native_relationships_without_replacing_source() -> None:
    _, resource = datacite_registration_resource()
    resource.relationships = (
        SimpleNamespace(
            source_resource_id=RESOURCE_ID,
            target_resource_id=UUID("a0000000-0000-4000-8000-0000000000b2"),
            relation="derived_from",
        ),
    )
    attributes = export_datacite_4_7(resource)["document"]["data"]["attributes"]
    assert attributes["relatedIdentifiers"][0]["relatedIdentifier"] == "https://example.test/source"
    assert (
        attributes["relatedIdentifiers"][1]["relatedIdentifier"]
        == "urn:uuid:a0000000-0000-4000-8000-0000000000b2"
    )


def test_datacite_registration_unsupported_text_is_preserved_and_reported() -> None:
    document = datacite_registration_document()
    document["data"]["attributes"]["formats"] = ["bad\rformat", "application/geo+json"]
    plan, resource = datacite_registration_resource(document)
    exported = export_datacite_4_7(resource)
    assert exported["document"]["data"]["attributes"]["formats"] == ["application/geo+json"]
    assert "formats[0]" in exported["report"]["unmapped"]
    assert "formats[0]" not in exported["report"]["mapped"]
    assert plan.source_document == document


def test_datacite_registration_organization_creator_and_unsafe_publisher() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    _, resource = datacite_registration_resource()
    resource.metadata_extensions["opengeo"]["contacts"] = [
        {"organization": "Curated institute", "role": "creator"},
        {"name": "Open Research Press", "organization": "Open Research Press", "role": "publisher"},
    ]
    resource.metadata_extensions["datacite"]["publisher"]["lang"] = "\x00"
    result = export_datacite_4_7(resource)
    assert result["document"]["data"]["attributes"]["creators"] == [{"name": "Curated institute"}]
    assert "lang" not in result["document"]["data"]["attributes"]["publisher"]
    assert "publisher.lang" in result["report"]["unmapped"]
    ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])


def test_datacite_registration_attribute_whitespace_cannot_silently_normalize() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    document = datacite_registration_document()
    attributes = document["data"]["attributes"]
    attributes["creators"][0]["nameIdentifiers"][0]["nameIdentifierScheme"] = "Local\nname"
    attributes["publisher"]["publisherIdentifier"] = "local\tvalue"
    _, resource = datacite_registration_resource(document)
    result = export_datacite_4_7(resource)
    exported = result["document"]["data"]["attributes"]
    assert "nameIdentifiers" not in exported["creators"][0]
    assert "publisherIdentifier" not in exported["publisher"]
    assert "publisher.publisherIdentifier" in result["report"]["unmapped"]
    assert not any(
        path.startswith("creators[0].nameIdentifiers[0].") for path in result["report"]["mapped"]
    )
    ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])


def datacite_complete_document() -> dict:
    return fixture("metadata-015-datacite47-complete.json")


def datacite_complete_resource(document=None):
    document = datacite_complete_document() if document is None else document
    plan = build_metadata_import_plan(
        "datacite_4_7",
        "example.datacite",
        "complete-registration",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    return plan, resource_from_plan(plan)


def test_datacite_complete_registration_fresh_json_reimport() -> None:
    document = datacite_complete_document()
    plan, resource = datacite_complete_resource(document)
    exported = export_datacite_4_7(resource)
    attributes = exported["document"]["data"]["attributes"]
    for name in (
        "titles",
        "subjects",
        "contributors",
        "dates",
        "alternateIdentifiers",
        "relatedIdentifiers",
        "sizes",
        "formats",
        "version",
        "rightsList",
        "descriptions",
        "geoLocations",
        "fundingReferences",
        "relatedItems",
        "types",
    ):
        assert attributes[name] == document["data"]["attributes"][name], name
    fresh, _ = datacite_complete_resource(exported["document"])
    for name in ("titles", "descriptions", "rightsList", "relatedItems", "geoLocations"):
        assert fresh.draft.metadata.extensions["datacite"][name] == attributes[name]
    assert plan.source_document == document
    assert len(canonical_json_bytes(plan.draft.metadata.extensions)) <= 8192
    assert len(canonical_json_bytes(exported["report"])) <= 16384


def test_datacite_complete_registration_has_all_normative_xml_groups() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    _, resource = datacite_complete_resource()
    xml = ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])
    ns = {"d": "http://datacite.org/schema/kernel-4"}
    assert {node.tag.rsplit("}", 1)[-1] for node in xml} == {
        "identifier",
        "creators",
        "titles",
        "publisher",
        "publicationYear",
        "resourceType",
        "subjects",
        "contributors",
        "dates",
        "language",
        "alternateIdentifiers",
        "relatedIdentifiers",
        "sizes",
        "formats",
        "version",
        "rightsList",
        "descriptions",
        "geoLocations",
        "fundingReferences",
        "relatedItems",
    }
    assert xml.find("d:contributors/d:contributor", ns).get("contributorType") == "Translator"
    assert (
        xml.find("d:creators/d:creator/d:nameIdentifier", ns).get("schemeURI") == "https://ror.org"
    )
    identifier = xml.find("d:relatedItems/d:relatedItem/d:relatedItemIdentifier", ns)
    assert identifier.get("schemeURI") == "https://example.test/ddi"
    assert xml.find("d:relatedItems/d:relatedItem/d:number", ns).get("numberType") == "Chapter"
    assert (
        xml.find("d:geoLocations/d:geoLocation/d:geoLocationPolygon/d:inPolygonPoint", ns)
        is not None
    )


def test_datacite_complete_resource_types_and_translator_are_pinned() -> None:
    from opengeo_api.metadata_profiles import _DATACITE_REGISTRATION_VOCABULARIES

    vocabularies = _DATACITE_REGISTRATION_VOCABULARIES
    assert len(vocabularies["resourceType"]) == 34
    assert len(vocabularies["contributorType"]) == 22
    assert "Translator" in vocabularies["contributorType"]
    for general in vocabularies["resourceType"]:
        document = datacite_complete_document()
        document["data"]["attributes"]["types"]["resourceTypeGeneral"] = general
        plan, _ = datacite_complete_resource(document)
        expected = (
            "dataset"
            if general in {"Dataset", "Collection"}
            else ("service" if general == "Service" else "document")
        )
        assert plan.draft.kind == expected, general
        exported = export_datacite_4_7(resource_from_plan(plan))
        assert exported["document"]["data"]["attributes"]["types"]["resourceTypeGeneral"] == general
        fresh, _ = datacite_complete_resource(exported["document"])
        assert fresh.draft.kind == expected
    document["data"]["attributes"]["types"]["resourceTypeGeneral"] = "FutureUnknownType"
    with pytest.raises(MetadataImportInvalid, match="resourceTypeGeneral"):
        datacite_complete_resource(document)


def test_datacite_complete_native_edits_and_clears_override_retained_core() -> None:
    document = datacite_complete_document()
    plan, resource = datacite_complete_resource(document)
    resource.summary.title = "Curated road survey"
    resource.summary.abstract = None
    resource.summary.license = None
    resource.summary.keywords = ()
    resource.summary.spatial_extent = None
    resource.summary.temporal_start = None
    resource.summary.temporal_end = None
    resource.summary.version_number = 9
    resource.translations = {}
    attributes = export_datacite_4_7(resource)["document"]["data"]["attributes"]
    assert attributes["titles"][0]["title"] == "Curated road survey"
    assert not any(value.get("lang") == "fr" for value in attributes["titles"])
    assert not any(
        value.get("descriptionType") == "Abstract" for value in attributes.get("descriptions", [])
    )
    assert any(value["descriptionType"] == "Methods" for value in attributes["descriptions"])
    assert not attributes.get("subjects")
    assert not attributes.get("rightsList")
    assert not attributes.get("geoLocations")
    assert not any(value["dateType"] == "Coverage" for value in attributes.get("dates", []))
    assert any(value["dateType"] == "Created" for value in attributes["dates"])
    assert attributes["version"] == "release-2"
    assert plan.source_document == document


def test_datacite_complete_malformed_values_and_unsafe_attributes_fail_closed() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    document = datacite_complete_document()
    document["data"]["attributes"]["titles"][2]["titleType"] = {"future": []}
    plan, resource = datacite_complete_resource(document)
    retained = json.loads(json.dumps(resource.metadata_extensions["datacite"]))
    retained["contributors"][0]["contributorType"] = {"unexpected": []}
    retained["relatedItems"][0]["relatedItemIdentifier"]["schemeURI"] = (
        "https://example.test/\nunsafe"
    )
    resource.metadata_extensions["datacite"] = retained
    result = export_datacite_4_7(resource)
    attributes = result["document"]["data"]["attributes"]
    assert attributes["titles"][0]["title"] == "Road access survey"
    assert not attributes.get("contributors")
    assert any("titleType" in path for path in result["report"]["unmapped"])
    assert any("contributorType" in path for path in result["report"]["unmapped"])
    assert any("schemeURI" in path for path in result["report"]["unmapped"])
    xml = ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])
    assert all(
        not any(character in value for character in "\r\n\t")
        for node in xml.iter()
        for value in node.attrib.values()
    )
    assert len(canonical_json_bytes(result["report"])) <= 16384
    assert plan.source_document == document


def test_datacite_complete_polygon_alias_and_existing_size_gate() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    document = datacite_complete_document()
    polygon = document["data"]["attributes"]["geoLocations"][0]["geoLocationPolygon"][0]
    polygon["polygonPoint"] = polygon.pop("polygonPoints")
    _, resource = datacite_complete_resource(document)
    attributes = export_datacite_4_7(resource)["document"]["data"]["attributes"]
    assert attributes["geoLocations"] == document["data"]["attributes"]["geoLocations"]
    xml = ET.fromstring(export_datacite_4_7_xml(resource)["documentText"])
    assert len(xml.findall(".//{http://datacite.org/schema/kernel-4}polygonPoint")) == 4
    polygon["polygonPoints"] = polygon["polygonPoint"]
    _, resource = datacite_complete_resource(document)
    result = export_datacite_4_7(resource)
    assert any("geoLocationPolygon" in path for path in result["report"]["unmapped"])
    document = datacite_complete_document()
    document["data"]["attributes"]["relatedItems"][0]["titles"][0]["title"] = "x" * 8192
    with pytest.raises(MetadataImportInvalid, match="8192"):
        datacite_complete_resource(document)


def test_datacite_complete_coarse_coverage_source_preserved() -> None:
    document = datacite_complete_document()
    document["data"]["attributes"]["dates"][0] = {
        "date": "2026",
        "dateType": "Coverage",
        "dateInformation": "Year precision",
    }
    plan, resource = datacite_complete_resource(document)
    assert plan.draft.metadata.temporal_start is None
    assert plan.draft.metadata.temporal_end is None
    assert any("dates[0]" in path for path in plan.conversion_report["unmapped"])
    assert "data.attributes.dates->temporal_extent" not in plan.conversion_report["mapped"]
    exported = export_datacite_4_7(resource)
    assert (
        exported["document"]["data"]["attributes"]["dates"]
        == document["data"]["attributes"]["dates"]
    )
    fresh, _ = datacite_complete_resource(exported["document"])
    assert (
        fresh.draft.metadata.extensions["datacite"]["dates"]
        == document["data"]["attributes"]["dates"]
    )
    assert plan.source_document == document


def test_datacite_complete_same_language_variants_survive_unchanged() -> None:
    document = datacite_complete_document()
    attributes = document["data"]["attributes"]
    attributes["titles"].extend(
        [
            {"title": "Second main", "lang": "en"},
            {"title": "English translation", "titleType": "TranslatedTitle", "lang": "en"},
            {"title": "French variant", "titleType": "TranslatedTitle", "lang": "fr"},
        ]
    )
    attributes["descriptions"].append(
        {
            "description": "Second abstract",
            "descriptionType": "Abstract",
            "lang": "en",
        }
    )
    plan, resource = datacite_complete_resource(document)
    assert resource.summary.title == "Road access survey"
    assert resource.summary.abstract == "Verified roads metadata."
    unchanged = export_datacite_4_7(resource)["document"]["data"]["attributes"]
    assert unchanged["titles"] == attributes["titles"]
    assert unchanged["descriptions"] == attributes["descriptions"]
    resource.summary.title = "Edited primary title"
    resource.summary.abstract = None
    resource.translations = {}
    edited = export_datacite_4_7(resource)["document"]["data"]["attributes"]
    assert edited["titles"][0]["title"] == "Edited primary title"
    assert not any(
        value["title"] in {"Second main", "English translation", "French variant"}
        for value in edited["titles"]
    )
    assert not any(value.get("lang") == "fr" for value in edited["titles"])
    assert not any(
        value["descriptionType"] == "Abstract" for value in edited.get("descriptions", [])
    )
    assert plan.source_document == document


def test_datacite_complete_native_contact_funding_clears_do_not_restore_source() -> None:
    for remove_key in (False, True):
        _, resource = datacite_complete_resource()
        catalog = resource.metadata_extensions["opengeo"]
        if remove_key:
            catalog.pop("contacts")
        else:
            catalog["contacts"] = []
        result = export_datacite_4_7(resource)
        assert result["document"] is None
        assert {"creators", "publisher"} <= set(result["report"]["missingRequired"])
        assert resource.metadata_extensions["datacite"]["creators"]
        assert resource.metadata_extensions["datacite"]["publisher"]

        _, resource = datacite_complete_resource()
        catalog = resource.metadata_extensions["opengeo"]
        assert catalog["contacts"]
        if remove_key:
            catalog.pop("funding")
        else:
            catalog["funding"] = []
        result = export_datacite_4_7(resource)
        assert result["document"] is not None
        assert not result["document"]["data"]["attributes"].get("fundingReferences")
        assert resource.metadata_extensions["datacite"]["fundingReferences"]


def iso_online_distribution_resource():
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        fixture("metadata-016-opengeo-online-distribution.json")
    )
    return resource


def iso_offline_distribution_resource():
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        fixture("metadata-018-opengeo-offline-distribution.json")
    )
    return resource


def test_iso_offline_distribution_round_trip_preserves_owned_media_and_lexical_values() -> None:
    resource = iso_offline_distribution_resource()
    expected = json.loads(json.dumps(resource.metadata_extensions["opengeo"]))
    exported = export_iso_19115_3(resource)
    document = exported["documentText"]
    assert export_iso_19115_3(resource)["documentText"] == document
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    dtos = list(ET.fromstring(document).iter(f"{mrd}MD_DigitalTransferOptions"))
    assert [len(dto.findall(f"{mrd}offLine")) for dto in dtos] == [2, 1, 1]
    assert [len(dto.findall(f"{mrd}onLine")) for dto in dtos] == [0, 1, 0]
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]
    assert actual["schemaVersion"] == "1.7.0"
    assert len(actual["distributions"]) == 3
    for index, distribution in enumerate(actual["distributions"]):
        assert distribution["isoTransfer"] == expected["distributions"][index]["isoTransfer"]
    first = actual["distributions"][0]["isoTransfer"]["offlineMedia"][0]
    assert set(first) == {
        "name",
        "density",
        "densityUnits",
        "volumes",
        "mediumFormats",
        "mediumNote",
        "identifier",
    }
    assert first["density"] == "-1.00" and first["volumes"] == -2
    assert first["mediumFormats"] == ["iso9660", "example-custom-format", "iso9660"]
    assert actual["distributions"][0]["isoTransfer"]["offlineMedia"][1]["density"] == "1.00"
    for index in (0, 2):
        assert not actual["distributions"][index].get("accessUrl")
        assert not actual["distributions"][index].get("downloadUrl")
    assert reopened.source_document == document
    assert resource.metadata_extensions["opengeo"] == expected


def test_iso_offline_distribution_native_edits_and_clears_do_not_restore_source() -> None:
    source = export_iso_19115_3(iso_offline_distribution_resource())["documentText"]
    resource = resource_from_plan(iso_import(source))
    distributions = resource.metadata_extensions["opengeo"]["distributions"]
    media = distributions[0]["isoTransfer"]["offlineMedia"]
    media[0]["name"]["title"] = "Curated archive"
    media[0]["density"] = "-2.00"
    media[0]["mediumFormats"] = ["curated-format", "curated-format"]
    media[0].pop("mediumNote")
    media.pop(1)
    distributions[1]["isoTransfer"].pop("offlineMedia")
    distributions.pop(2)
    document = export_iso_19115_3(resource)["documentText"]
    actual = iso_import(document).draft.metadata.extensions["opengeo"]["distributions"]
    assert len(actual) == 2
    assert actual[0]["isoTransfer"]["offlineMedia"] == media
    assert "offlineMedia" not in actual[1]["isoTransfer"]
    assert actual[1]["accessUrl"] == "https://data.example.test/survey"
    assert "Supplementary survey archive" not in document
    assert "Independent archive owner" not in document


def test_iso_offline_distribution_unsupported_owned_shapes_preserve_source_and_loss() -> None:
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    mcc = "{http://standards.iso.org/iso/19115/-3/mcc/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    href = "{http://www.w3.org/1999/xlink}href"
    source = export_iso_19115_3(iso_offline_distribution_resource())["documentText"]
    for mutation in ("foreign", "nested", "duplicate", "codeList", "identifier", "href", "tail"):
        xml = ET.fromstring(source)
        medium = next(xml.iter(f"{mrd}MD_Medium"))
        if mutation == "foreign":
            medium.find(f"{mrd}densityUnits").tag = "{urn:foreign}densityUnits"
        elif mutation == "nested":
            wrapper = ET.SubElement(medium, "{urn:foreign}unowned")
            nested = ET.SubElement(ET.SubElement(wrapper, f"{mrd}offLine"), f"{mrd}MD_Medium")
            ET.SubElement(
                ET.SubElement(nested, f"{mrd}mediumNote"), f"{gco}CharacterString"
            ).text = "UNOWNED MEDIUM"
        elif mutation == "duplicate":
            duplicate = ET.fromstring(ET.tostring(medium.find(f"{mrd}density")))
            medium.append(duplicate)
        elif mutation == "codeList":
            next(medium.iter(f"{mrd}MD_MediumFormatCode")).set(
                "codeList", "https://example.invalid/foreign-code-list"
            )
        elif mutation == "identifier":
            identifier = next(medium.iter(f"{mcc}MD_Identifier"))
            ET.SubElement(
                ET.SubElement(identifier, f"{mcc}description"), f"{gco}CharacterString"
            ).text = "Unsupported identifier detail"
        elif mutation == "href":
            note = medium.find(f"{mrd}mediumNote")
            note.clear()
            note.set(href, "https://example.invalid/remote-note")
        else:
            medium.find(f"{mrd}density").tail = "retained mixed property tail"
        document = ET.tostring(xml, encoding="unicode")
        plan = iso_import(document)
        assert plan.source_document == document
        assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
        actual = plan.draft.metadata.extensions["opengeo"]["distributions"]
        assert len(actual) == 3
        assert "UNOWNED MEDIUM" not in canonical_json_bytes(actual).decode()
        marker = {
            "foreign": "densityUnits",
            "nested": "unowned",
            "duplicate": "density",
            "codeList": "mediumFormat",
            "identifier": "identifier",
            "href": "mediumNote",
            "tail": "tail",
        }[mutation]
        assert any(marker in path for path in plan.conversion_report["unmapped"])
        first = actual[0]["isoTransfer"]["offlineMedia"][0]
        if mutation in {"foreign", "duplicate", "href"}:
            field = {"foreign": "densityUnits", "duplicate": "density", "href": "mediumNote"}[
                mutation
            ]
            assert field not in first
        if mutation == "codeList":
            assert first["mediumFormats"] == ["example-custom-format", "iso9660"]
        if mutation == "identifier":
            assert first.get("identifier", {}).get("description") is None


def test_iso_offline_distribution_nonfinite_and_invalid_integer_source_are_explicit_losses() -> (
    None
):
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    source = export_iso_19115_3(iso_offline_distribution_resource())["documentText"]
    for field, value in (
        ("density", "NaN"),
        ("density", "INF"),
        ("density", "1e9999"),
        ("volumes", "1.5"),
        ("volumes", "true"),
        ("volumes", "1000000000000000001"),
    ):
        xml = ET.fromstring(source)
        medium = next(xml.iter(f"{mrd}MD_Medium"))
        medium.find(f"{mrd}{field}")[0].text = value
        document = ET.tostring(xml, encoding="unicode")
        plan = iso_import(document)
        media = plan.draft.metadata.extensions["opengeo"]["distributions"][0]["isoTransfer"][
            "offlineMedia"
        ]
        assert field not in media[0]
        assert any(field in path for path in plan.conversion_report["unmapped"])
        assert plan.source_document == document


def test_iso_offline_distribution_byte_limit_does_not_fabricate_online_records() -> None:
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    xml = ET.fromstring(export_iso_19115_3(iso_offline_distribution_resource())["documentText"])
    dtos = list(xml.iter(f"{mrd}MD_DigitalTransferOptions"))
    for dto in dtos:
        for item in list(dto):
            if item.tag == f"{mrd}offLine":
                dto.remove(item)
        for _ in range(8):
            medium = ET.SubElement(ET.SubElement(dto, f"{mrd}offLine"), f"{mrd}MD_Medium")
            ET.SubElement(
                ET.SubElement(medium, f"{mrd}mediumNote"), f"{gco}CharacterString"
            ).text = "é" * 700
    document = ET.tostring(xml, encoding="unicode")
    assert len(document.encode()) <= 49152
    plan = iso_import(document)
    assert plan.source_document == document
    assert len(canonical_json_bytes(plan.draft.metadata.extensions)) <= 8192
    assert any("size-limit" in path for path in plan.conversion_report["unmapped"])
    distributions = plan.draft.metadata.extensions["opengeo"].get("distributions", [])
    assert all(
        value.get("accessUrl")
        or value.get("downloadUrl")
        or value.get("isoTransfer", {}).get("offlineMedia")
        for value in distributions
    )
    assert all(
        not value.get("accessUrl") or value["accessUrl"] == "https://data.example.test/survey"
        for value in distributions
    )


def test_iso_offline_distribution_non_iso_loss_and_stac_exact_preservation() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    _, resource = datacite_complete_resource()
    catalog = resource.metadata_extensions.setdefault("opengeo", {})
    catalog.update(fixture("metadata-018-opengeo-offline-distribution.json"))
    expected = json.loads(json.dumps(catalog))
    for exporter in (
        export_dcat_3,
        export_geodcat_ap_3_1,
        export_schema_org_dataset,
        export_datacite_4_7,
        export_datacite_4_7_xml,
    ):
        result = exporter(resource)
        assert result["status"] in {
            "mapped",
            "mapped_with_preserved_extensions",
            "mapped_with_explicit_losses",
            "mapped_with_defaults",
        }
        assert any(
            path.startswith("metadata_extensions.opengeo.distributions")
            and path.endswith(".isoTransfer.offlineMedia")
            for path in result["report"]["unmapped"]
        )
        if exporter is export_datacite_4_7_xml:
            ET.fromstring(result["documentText"])
        else:
            assert isinstance(result["document"], dict)
    stac = export_stac_1_1(resource)
    assert stac["status"] in {"mapped", "mapped_with_defaults"}
    assert stac["document"]["opengeo:metadataExtensions"]["opengeo"] == expected
    assert not stac["document"].get("assets")
    assert resource.metadata_extensions["opengeo"] == expected


def iso_distributor_order_resource():
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    resource = resource_from_plan(iso_import(localized_iso_document()))
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        fixture("metadata-019-opengeo-distributor-order-graph.json")
    )
    return resource


def test_iso_distributor_order_graph_optional_shapes_and_identity_losses() -> None:
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    for group in (
        {},
        {"transferOptions": [{}]},
        {"transferOptions": [{"unitsOfDistribution": "archive"}]},
        {"transferOptions": [{"offlineMedia": [{}]}]},
    ):
        resource = iso_distributor_order_resource()
        resource.metadata_extensions["opengeo"]["isoDistributionGroups"] = [group]
        source = export_iso_19115_3(resource)["documentText"]
        catalog = iso_import(source).draft.metadata.extensions["opengeo"]
        assert catalog["isoDistributionGroups"] == [group]
        assert not catalog.get("distributions")
        assert "accessUrl" not in canonical_json_bytes(catalog).decode()
        assert "downloadUrl" not in canonical_json_bytes(catalog).decode()

    resource = iso_distributor_order_resource()
    groups = resource.metadata_extensions["opengeo"]["isoDistributionGroups"]
    groups[0]["distributors"][0]["contact"]["parties"][0]["contacts"] = [{}, {"addresses": [{}]}]
    reopened = iso_import(export_iso_19115_3(resource)["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["isoDistributionGroups"] == groups

    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    source = export_iso_19115_3(iso_distributor_order_resource())["documentText"]
    for mutation in ("empty-id", "xml-id-collision", "gml-id-collision"):
        xml = ET.fromstring(source)
        if mutation == "empty-id":
            next(xml.iter(f"{mrd}MD_Format")).set("id", "")
        else:
            attribute = (
                "{http://www.w3.org/XML/1998/namespace}id"
                if mutation == "xml-id-collision"
                else "{http://www.opengis.net/gml/3.2}id"
            )
            ET.SubElement(xml, "{urn:unowned}identity", {attribute: "format-a"})
        document = ET.tostring(xml, encoding="unicode")
        plan = iso_import(document)
        catalog = plan.draft.metadata.extensions["opengeo"]
        validate_catalog_metadata(catalog)
        assert plan.source_document == document
        assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
        assert any(
            "id" in path.lower() and "[" in path for path in plan.conversion_report["unmapped"]
        )
        pending = [catalog.get("isoDistributionGroups", [])]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                assert value.get("ref") != "format-a"
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)


def test_iso_distributor_order_graph_fresh_round_trip_preserves_all_owned_groups() -> None:
    resource = iso_distributor_order_resource()
    expected = json.loads(json.dumps(resource.metadata_extensions["opengeo"]))
    document = export_iso_19115_3(resource)["documentText"]
    assert export_iso_19115_3(resource)["documentText"] == document
    plan = iso_import(document)
    actual = plan.draft.metadata.extensions["opengeo"]
    assert actual["schemaVersion"] == "1.8.0"
    assert actual["isoDistributionGroups"] == expected["isoDistributionGroups"]
    assert not actual.get("distributions")
    global_contacts = canonical_json_bytes(actual.get("contacts", [])).decode()
    assert not any(
        value in global_contacts
        for value in (
            "Archive contact",
            "Repeated office name",
            "Deputy contact",
            "Second deputy",
            "first@example.test",
            "second@example.test",
            "third@example.test",
            "fourth@example.test",
            "office-a@example.test",
            "deputy@example.test",
            "office-b@example.test",
            "independent@example.test",
        )
    )
    groups = actual["isoDistributionGroups"]
    assert [group["description"] for group in groups] == ["Repeated owner label"] * 2
    first, second = [group["distributors"][0] for group in groups]
    assert first["orders"][0]["plannedAvailableDateTime"] == "2026-12-01T09:30:00"
    assert second["orders"][0]["plannedAvailableDateTime"] == "2026-12-02T10:45:00Z"
    assert set(first["orders"][0]) == {
        "id",
        "fees",
        "plannedAvailableDateTime",
        "orderingInstructions",
        "turnaround",
        "orderOptionsType",
        "orderOptions",
    }
    assert first["contact"]["parties"][0]["contacts"][0]["addresses"][0]["emails"] == [
        "first@example.test",
        "second@example.test",
    ]
    assert groups[0]["transferOptions"] == [{"ref": "dto-a"}, {"ref": "dto-a"}]
    assert first["formats"][0]["distributors"] == [{"ref": "distributor-a"}]
    assert plan.source_document == document
    assert resource.metadata_extensions["opengeo"] == expected


def test_iso_distributor_order_graph_curator_changes_and_clears_win() -> None:
    source = export_iso_19115_3(iso_distributor_order_resource())["documentText"]
    resource = resource_from_plan(iso_import(source))
    groups = resource.metadata_extensions["opengeo"]["isoDistributionGroups"]
    groups[0]["description"] = "Curated first owner"
    groups[0].pop("formats")
    groups[0]["transferOptions"].pop()
    distributor = groups[0]["distributors"][0]
    distributor["orders"][0]["fees"] = "Curated fee"
    distributor["orders"][0].pop("orderOptions")
    distributor["contact"]["parties"][0]["name"] = "Curated contact"
    distributor["contact"]["parties"][0].pop("contacts")
    distributor["formats"][0]["media"][0].pop("mediumNote")
    actual = iso_import(export_iso_19115_3(resource)["documentText"])
    assert actual.draft.metadata.extensions["opengeo"]["isoDistributionGroups"] == groups
    resource.metadata_extensions["opengeo"].pop("isoDistributionGroups")
    cleared = iso_import(export_iso_19115_3(resource)["documentText"])
    assert not cleared.draft.metadata.extensions["opengeo"].get("isoDistributionGroups")
    assert not cleared.draft.metadata.extensions["opengeo"].get("distributions")


def test_iso_distributor_order_graph_typed_local_refs_do_not_join_invalid_targets() -> None:
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    href = "{http://www.w3.org/1999/xlink}href"
    source = export_iso_19115_3(iso_distributor_order_resource())["documentText"]
    for mutation in ("dangling", "kind-mismatch", "duplicate-id", "remote"):
        xml = ET.fromstring(source)
        if mutation == "duplicate-id":
            next(node for node in xml.iter(f"{mrd}MD_Format") if node.get("id") == "format-b").set(
                "id", "format-a"
            )
        else:
            reference = next(node for node in xml.iter() if node.get(href) == "#format-a")
            reference.set(
                href,
                {
                    "dangling": "#missing-format",
                    "kind-mismatch": "#medium-a",
                    "remote": "https://example.invalid/remote-format",
                }[mutation],
            )
        document = ET.tostring(xml, encoding="unicode")
        plan = iso_import(document)
        catalog = plan.draft.metadata.extensions["opengeo"]
        validate_catalog_metadata(catalog)
        assert not catalog.get("distributions")
        assert plan.source_document == document
        assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(document)
        assert plan.conversion_report["unmapped"]
        assert any(
            "distribution" in path.lower() or "format" in path.lower()
            for path in plan.conversion_report["unmapped"]
        )
        assert "missing-format" not in canonical_json_bytes(catalog).decode()
        assert "https://example.invalid/remote-format" not in canonical_json_bytes(catalog).decode()
    resource = iso_distributor_order_resource()
    groups = resource.metadata_extensions["opengeo"]["isoDistributionGroups"]
    groups.append({"ref": "group-a"})
    reopened = iso_import(export_iso_19115_3(resource)["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["isoDistributionGroups"] == groups


def test_iso_distributor_order_graph_unsupported_contacts_records_and_ownership_keep_source() -> (
    None
):
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    source = export_iso_19115_3(iso_distributor_order_resource())["documentText"]
    for mutation in ("foreign", "nested", "duplicate", "phone", "record", "role-codeList"):
        xml = ET.fromstring(source)
        distributor = next(xml.iter(f"{mrd}MD_Distributor"))
        if mutation == "foreign":
            distributor.find(
                f"{mrd}distributionOrderProcess"
            ).tag = "{urn:foreign}distributionOrderProcess"
            marker = "distributionOrderProcess"
        elif mutation == "nested":
            wrapper = ET.SubElement(distributor, "{urn:foreign}unowned")
            order = ET.SubElement(
                ET.SubElement(wrapper, f"{mrd}distributionOrderProcess"),
                f"{mrd}MD_StandardOrderProcess",
            )
            ET.SubElement(
                ET.SubElement(order, f"{mrd}fees"), f"{gco}CharacterString"
            ).text = "UNOWNED ORDER"
            marker = "unowned"
        elif mutation == "duplicate":
            distributor.append(
                ET.fromstring(ET.tostring(distributor.find(f"{mrd}distributorContact")))
            )
            marker = "distributorContact"
        elif mutation == "phone":
            contact = next(distributor.iter(f"{cit}CI_Contact"))
            ET.SubElement(ET.SubElement(contact, f"{cit}phone"), f"{cit}CI_Telephone")
            marker = "phone"
        elif mutation == "record":
            record = next(distributor.iter(f"{gco}Record"))
            ET.SubElement(record, "{urn:foreign}field").text = "UNSUPPORTED RECORD FIELD"
            marker = "orderOptions"
        else:
            next(distributor.iter(f"{cit}CI_RoleCode")).set(
                "codeList", "https://example.invalid/foreign-roles"
            )
            marker = "role"
        document = ET.tostring(xml, encoding="unicode")
        plan = iso_import(document)
        assert plan.source_document == document
        catalog = plan.draft.metadata.extensions["opengeo"]
        global_contacts = canonical_json_bytes(catalog.get("contacts", [])).decode()
        assert not any(
            value in global_contacts
            for value in (
                "Archive contact",
                "Repeated office name",
                "Deputy contact",
                "Second deputy",
                "first@example.test",
                "second@example.test",
                "third@example.test",
                "fourth@example.test",
                "office-a@example.test",
                "deputy@example.test",
                "office-b@example.test",
                "independent@example.test",
            )
        )
        assert not catalog.get("distributions")
        projected = canonical_json_bytes(catalog).decode()
        assert "UNOWNED ORDER" not in projected
        assert "UNSUPPORTED RECORD FIELD" not in projected
        assert any(marker in path for path in plan.conversion_report["unmapped"])


def test_iso_distributor_order_graph_bounds_fail_closed_without_dangling_refs() -> None:
    from opengeo_api.metadata_catalog import CatalogMetadataInvalid, validate_catalog_metadata

    for mutation in ("depth", "duplicate-id", "wrong-kind"):
        catalog = fixture("metadata-019-opengeo-distributor-order-graph.json")
        if mutation == "depth":
            catalog = {
                "schemaVersion": "1.8.0",
                "isoDistributionGroups": [
                    {
                        "distributors": [
                            {
                                "contact": {
                                    "role": "distributor",
                                    "parties": [{"type": "individual", "name": "Nested contact"}],
                                }
                            }
                        ]
                    }
                ],
            }
            distributor = catalog["isoDistributionGroups"][0]["distributors"][0]
            for _ in range(18):
                child = {
                    "contact": {
                        "role": "distributor",
                        "parties": [{"type": "individual", "name": "Nested contact"}],
                    }
                }
                distributor["formats"] = [
                    {"citation": {"title": "Nested format"}, "distributors": [child]}
                ]
                distributor = child
        elif mutation == "duplicate-id":
            catalog["isoDistributionGroups"][1]["id"] = "group-a"
        else:
            catalog["isoDistributionGroups"][0]["formats"][0] = {"ref": "medium-a"}
        with pytest.raises(CatalogMetadataInvalid):
            validate_catalog_metadata(catalog)
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    xml = ET.fromstring(export_iso_19115_3(iso_distributor_order_resource())["documentText"])
    group = next(xml.iter(f"{mrd}MD_Distribution"))
    for child in list(group):
        group.remove(child)
    for _ in range(8):
        distributor = ET.SubElement(
            ET.SubElement(group, f"{mrd}distributor"), f"{mrd}MD_Distributor"
        )
        contact = ET.SubElement(
            ET.SubElement(distributor, f"{mrd}distributorContact"),
            "{http://standards.iso.org/iso/19115/-3/cit/2.0}CI_Responsibility",
        )
        cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
        ET.SubElement(
            ET.SubElement(contact, f"{cit}role"),
            f"{cit}CI_RoleCode",
            {
                "codeList": "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_RoleCode",
                "codeListValue": "distributor",
            },
        ).text = "distributor"
        person = ET.SubElement(ET.SubElement(contact, f"{cit}party"), f"{cit}CI_Individual")
        ET.SubElement(
            ET.SubElement(person, f"{cit}name"), f"{gco}CharacterString"
        ).text = "Budget contact"
        order = ET.SubElement(
            ET.SubElement(distributor, f"{mrd}distributionOrderProcess"),
            f"{mrd}MD_StandardOrderProcess",
        )
        ET.SubElement(ET.SubElement(order, f"{mrd}fees"), f"{gco}CharacterString").text = "é" * 1000
    document = ET.tostring(xml, encoding="unicode")
    assert len(document.encode()) <= 49152
    plan = iso_import(document)
    assert plan.source_document == document
    assert len(canonical_json_bytes(plan.draft.metadata.extensions)) <= 8192
    assert any("size-limit" in path for path in plan.conversion_report["unmapped"])
    validate_catalog_metadata(plan.draft.metadata.extensions["opengeo"])


def test_iso_distributor_order_graph_legacy_fallback_and_non_iso_losses_stay_explicit() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    legacy = iso_import(export_iso_19115_3(iso_offline_distribution_resource())["documentText"])
    assert legacy.draft.metadata.extensions["opengeo"]["schemaVersion"] == "1.7.0"
    assert not legacy.draft.metadata.extensions["opengeo"].get("isoDistributionGroups")
    combined = iso_distributor_order_resource()
    combined.metadata_extensions["opengeo"]["qualityReports"] = fixture(
        "metadata-017-opengeo-quality-reports.json"
    )["qualityReports"]
    reopened = iso_import(export_iso_19115_3(combined)["documentText"])
    for field in ("qualityReports", "isoDistributionGroups"):
        assert (
            reopened.draft.metadata.extensions["opengeo"][field]
            == combined.metadata_extensions["opengeo"][field]
        )
    _, resource = datacite_complete_resource()
    catalog = resource.metadata_extensions.setdefault("opengeo", {})
    catalog.update(fixture("metadata-019-opengeo-distributor-order-graph.json"))
    expected = json.loads(json.dumps(catalog))
    for exporter in (
        export_dcat_3,
        export_geodcat_ap_3_1,
        export_schema_org_dataset,
        export_datacite_4_7,
        export_datacite_4_7_xml,
    ):
        result = exporter(resource)
        assert result["status"] in {
            "mapped",
            "mapped_with_preserved_extensions",
            "mapped_with_explicit_losses",
            "mapped_with_defaults",
        }
        assert "metadata_extensions.opengeo.isoDistributionGroups" in result["report"]["unmapped"]
        if exporter is export_datacite_4_7_xml:
            ET.fromstring(result["documentText"])
        else:
            assert isinstance(result["document"], dict)
    stac = export_stac_1_1(resource)
    assert stac["status"] in {"mapped", "mapped_with_defaults"}
    assert stac["document"]["opengeo:metadataExtensions"]["opengeo"] == expected
    assert resource.metadata_extensions["opengeo"] == expected


def quality_reports_resource(document=None):
    from opengeo_api.metadata_catalog import validate_catalog_metadata

    resource = resource_from_plan(iso_import(document or localized_iso_document()))
    resource.metadata_extensions["opengeo"] = validate_catalog_metadata(
        fixture("metadata-017-opengeo-quality-reports.json")
    )
    return resource


def test_quality_reports_non_iso_preservation_or_explicit_loss() -> None:
    from opengeo_api.metadata_profiles import export_datacite_4_7_xml

    _, resource = datacite_complete_resource()
    catalog = resource.metadata_extensions.setdefault("opengeo", {})
    catalog.update(fixture("metadata-017-opengeo-quality-reports.json"))
    expected = json.loads(json.dumps(catalog["qualityReports"]))
    loss_path = "metadata_extensions.opengeo.qualityReports"
    for exporter in (
        export_dcat_3,
        export_geodcat_ap_3_1,
        export_schema_org_dataset,
        export_datacite_4_7,
        export_datacite_4_7_xml,
    ):
        exported = exporter(resource)
        assert exported["status"] in {
            "mapped_with_preserved_extensions",
            "mapped_with_explicit_losses",
        }
        assert loss_path in exported["report"]["unmapped"]
        if exporter is export_datacite_4_7_xml:
            ET.fromstring(exported["documentText"])
        else:
            assert isinstance(exported["document"], dict)
    stac = export_stac_1_1(resource)
    assert stac["status"] in {"mapped", "mapped_with_defaults"}
    assert stac["document"]["opengeo:metadataExtensions"]["opengeo"]["qualityReports"] == expected
    assert resource.metadata_extensions["opengeo"]["qualityReports"] == expected


def test_iso_quality_reports_round_trip_preserves_groups_results_and_local_links() -> None:
    resource = quality_reports_resource()
    original = json.loads(json.dumps(resource.metadata_extensions["opengeo"]))
    exported = export_iso_19115_3(resource)
    document = exported["documentText"]
    assert export_iso_19115_3(resource)["documentText"] == document
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]
    assert actual["schemaVersion"] == "1.6.0"
    assert actual["qualityReports"] == original["qualityReports"]
    assert not actual.get("quality")
    results = actual["qualityReports"][0]["reports"][0]["results"]
    assert results[0]["values"][0] == "0.123456789012345678901234567890"
    assert actual["qualityReports"][0]["reports"][1]["results"][0]["pass"] is False
    assert resource.metadata_extensions["opengeo"] == original
    assert reopened.source_document == document
    assert exported["report"]["schemaValidated"] is False


def test_iso_quality_reports_curator_changes_and_clears_override_retained_source() -> None:
    document = export_iso_19115_3(quality_reports_resource())["documentText"]
    resource = resource_from_plan(iso_import(document))
    groups = resource.metadata_extensions["opengeo"]["qualityReports"]
    first = groups[0]["reports"][0]
    first.pop("measure")
    first.pop("evaluation")
    first.pop("derivedReports")
    first["results"] = [{"type": "DQ_DescriptiveResult", "statement": "Curator revision"}]
    groups[0]["reports"][1]["results"][0]["pass"] = True
    groups[1]["scope"]["level"] = "collection"
    reopened = iso_import(export_iso_19115_3(resource)["documentText"])
    assert reopened.draft.metadata.extensions["opengeo"]["qualityReports"] == groups
    resource.metadata_extensions["opengeo"].pop("qualityReports")
    cleared = iso_import(export_iso_19115_3(resource)["documentText"])
    assert not cleared.draft.metadata.extensions["opengeo"].get("qualityReports")


def test_iso_quality_reports_all_concrete_types_and_evaluations_round_trip() -> None:
    report_types = (
        "DQ_CompletenessCommission",
        "DQ_CompletenessOmission",
        "DQ_ConceptualConsistency",
        "DQ_DomainConsistency",
        "DQ_FormatConsistency",
        "DQ_TopologicalConsistency",
        "DQ_AbsoluteExternalPositionalAccuracy",
        "DQ_RelativeInternalPositionalAccuracy",
        "DQ_GriddedDataPositionalAccuracy",
        "DQ_AccuracyOfATimeMeasurement",
        "DQ_TemporalConsistency",
        "DQ_TemporalValidity",
        "DQ_ThematicClassificationCorrectness",
        "DQ_NonQuantitativeAttributeCorrectness",
        "DQ_QuantitativeAttributeAccuracy",
        "DQ_UsabilityElement",
        "DQ_Confidence",
        "DQ_Homogeneity",
        "DQ_Representativity",
    )
    evaluations = [
        {"type": "DQ_EvaluationMethod", "methodType": "directInternal"},
        {"type": "DQ_AggregationDerivation", "description": "Aggregate the observations"},
        {"type": "DQ_FullInspection", "methodType": "directExternal"},
        {"type": "DQ_IndirectEvaluation", "deductiveSources": ["Survey register"]},
        {
            "type": "DQ_SampleBasedInspection",
            "samplingScheme": "Every tenth row",
            "lotDescription": "2026 observations",
            "samplingRatio": "1:10",
        },
    ]
    assert len(set(report_types)) == 19
    for index, report_type in enumerate(report_types):
        resource = quality_reports_resource()
        groups = [
            {
                "scope": {"level": "dataset"},
                "reports": [
                    {
                        "id": f"quality-kind-{index}",
                        "type": report_type,
                        "measure": {"identifier": {"code": f"measure-{index}"}},
                        "evaluation": evaluations[index % len(evaluations)],
                        "results": [
                            {"type": "DQ_QuantitativeResult", "values": ["1.00000000000000000001"]},
                            {"type": "DQ_DescriptiveResult", "statement": "Separate second result"},
                        ],
                    }
                ],
            }
        ]
        resource.metadata_extensions["opengeo"]["qualityReports"] = groups
        document = export_iso_19115_3(resource)["documentText"]
        assert f"{report_type}" in document
        reopened = iso_import(document)
        assert reopened.draft.metadata.extensions["opengeo"]["qualityReports"] == groups
        assert not reopened.draft.metadata.extensions["opengeo"].get("quality")


def test_iso_quality_reports_foreign_and_nested_properties_are_not_owned() -> None:
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    document = export_iso_19115_3(quality_reports_resource())["documentText"]
    for mutation in ("foreign-result", "nested-report", "mixed-tail"):
        xml = ET.fromstring(document)
        report = next(xml.iter(f"{mdq}DQ_CompletenessCommission"))
        if mutation == "foreign-result":
            result = report.find(f"{mdq}result")
            result.tag = "{urn:foreign}result"
        elif mutation == "nested-report":
            wrapper = ET.SubElement(report, "{urn:foreign}unowned")
            nested = ET.SubElement(
                ET.SubElement(wrapper, f"{mdq}report"), f"{mdq}DQ_UsabilityElement"
            )
            result = ET.SubElement(
                ET.SubElement(nested, f"{mdq}result"), f"{mdq}DQ_DescriptiveResult"
            )
            ET.SubElement(
                ET.SubElement(result, f"{mdq}statement"), f"{gco}CharacterString"
            ).text = "FOREIGN REPORT MUST NOT PROJECT"
        else:
            report.find(f"{mdq}result").tail = "retained mixed-content text"
        source = ET.tostring(xml, encoding="unicode")
        plan = iso_import(source)
        assert plan.source_document == source
        assert plan.draft.provenance["sourceSha256"] == metadata_source_checksum(source)
        assert (
            "FOREIGN REPORT MUST NOT PROJECT"
            not in canonical_json_bytes(plan.draft.metadata.extensions).decode()
        )
        assert plan.conversion_report["unmapped"]
        loss_marker = {
            "foreign-result": "result",
            "nested-report": "unowned",
            "mixed-tail": "tail",
        }[mutation]
        assert any(loss_marker in path for path in plan.conversion_report["unmapped"])
        if mutation == "foreign-result":
            typed = plan.draft.metadata.extensions["opengeo"]["qualityReports"]
            assert not any(
                value["type"] == "DQ_QuantitativeResult"
                for group in typed
                for item in group["reports"]
                for value in item["results"]
            )


def test_iso_quality_reports_duplicate_ids_and_dangling_refs_are_not_joined() -> None:
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    href = "{http://www.w3.org/1999/xlink}href"
    document = export_iso_19115_3(quality_reports_resource())["documentText"]
    for mutation in ("duplicate-id", "dangling-ref", "remote-ref"):
        xml = ET.fromstring(document)
        if mutation == "duplicate-id":
            next(xml.iter(f"{mdq}DQ_Confidence")).set("id", "completeness")
        else:
            reference = next(xml.iter(f"{mdq}derivedElement"))
            reference.set(
                href,
                "#missing-report"
                if mutation == "dangling-ref"
                else "https://example.invalid/report",
            )
        source = ET.tostring(xml, encoding="unicode")
        plan = iso_import(source)
        groups = plan.draft.metadata.extensions["opengeo"].get("qualityReports", [])
        reports = [item for group in groups for item in group["reports"]]
        ids = [item["id"] for item in reports if "id" in item]
        assert len(ids) == len(set(ids))
        for item in reports:
            assert all(value in ids for value in item.get("derivedReports", []))
            assert all(value in ids for value in item.get("relatedReports", []))
        assert plan.source_document == source
        assert plan.conversion_report["unmapped"]
        assert any(
            "id" in path.lower() or "derived" in path.lower()
            for path in plan.conversion_report["unmapped"]
        )
        assert "missing-report" not in canonical_json_bytes(groups).decode()
        assert "https://example.invalid/report" not in canonical_json_bytes(groups).decode()


def test_iso_quality_reports_canonical_budget_retains_source_and_explicit_loss() -> None:
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    xml = ET.fromstring(export_iso_19115_3(quality_reports_resource())["documentText"])
    group = next(xml.iter(f"{mdq}DQ_DataQuality"))
    for child in list(group):
        if child.tag == f"{mdq}report":
            group.remove(child)
    for index in range(12):
        report = ET.SubElement(
            ET.SubElement(group, f"{mdq}report"),
            f"{mdq}DQ_CompletenessCommission",
            {"id": f"budget-report-{index}"},
        )
        ET.SubElement(
            ET.SubElement(report, f"{mdq}standaloneQualityReportDetails"), f"{gco}CharacterString"
        ).text = "é" * 500
        result = ET.SubElement(ET.SubElement(report, f"{mdq}result"), f"{mdq}DQ_DescriptiveResult")
        ET.SubElement(
            ET.SubElement(result, f"{mdq}statement"), f"{gco}CharacterString"
        ).text = "Retain original source"
    source = ET.tostring(xml, encoding="unicode")
    assert len(source.encode()) <= 49152
    plan = iso_import(source)
    assert plan.source_document == source
    assert len(canonical_json_bytes(plan.draft.metadata.extensions)) <= 8192
    assert any("size-limit" in path for path in plan.conversion_report["unmapped"])


def test_iso_quality_reports_legacy_scalar_group_stays_legacy_without_duplication() -> None:
    resource = quality_reports_resource()
    legacy = [{"measure": "completeness", "result": 0.98, "unit": "ratio"}]
    resource.metadata_extensions["opengeo"] = {"schemaVersion": "1.6.0", "quality": legacy}
    document = export_iso_19115_3(resource)["documentText"]
    plan = iso_import(document)
    assert plan.draft.metadata.extensions["opengeo"]["quality"] == legacy
    assert not plan.draft.metadata.extensions["opengeo"].get("qualityReports")
    assert plan.source_document == document


def test_iso_online_distribution_round_trip_owns_dto_contexts() -> None:
    resource = iso_online_distribution_resource()
    original = json.loads(json.dumps(resource.metadata_extensions["opengeo"]))
    exported = export_iso_19115_3(resource)
    document = exported["documentText"]
    xml = ET.fromstring(document)
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    assert len(xml.findall(f".//{mrd}MD_DigitalTransferOptions")) == 2
    reopened = iso_import(document)
    actual = reopened.draft.metadata.extensions["opengeo"]
    assert actual["schemaVersion"] == "1.5.0"
    assert len(actual["distributions"]) == 2
    for index, value in enumerate(actual["distributions"]):
        assert value["isoTransfer"] == original["distributions"][index]["isoTransfer"]
        assert value["accessUrl"] == original["distributions"][index]["accessUrl"]
        assert value["downloadUrl"] == original["distributions"][index]["downloadUrl"]
    assert "byteSize" not in actual["distributions"][0]
    assert actual["distributions"][0]["isoTransfer"]["transferSizeMegabytes"] == 2.5
    assert resource.metadata_extensions["opengeo"] == original
    assert reopened.source_document == document


def test_iso_online_distribution_native_edits_and_clears_override_bound_leaves() -> None:
    resource = iso_online_distribution_resource()
    first = resource.metadata_extensions["opengeo"]["distributions"][0]
    first.update(accessUrl="https://data.example.test/edited", title="Curated", format="Updated")
    reopened = iso_import(export_iso_19115_3(resource)["documentText"])
    context = reopened.draft.metadata.extensions["opengeo"]["distributions"][0]["isoTransfer"]
    assert context["onlineResources"][0]["linkage"] == "https://data.example.test/edited"
    assert context["onlineResources"][0]["name"] == "Curated"
    assert context["formats"][0]["citation"]["title"] == "Updated"
    assert context["onlineResources"][1]["name"] == "Download copy"
    assert context["formats"][1]["citation"]["title"] == "CSV"
    for field in ("accessUrl", "title", "format"):
        first.pop(field)
    exported = export_iso_19115_3(resource)
    context = iso_import(exported["documentText"]).draft.metadata.extensions["opengeo"][
        "distributions"
    ][0]["isoTransfer"]
    assert not any(
        value["linkage"] == "https://data.example.test/roads"
        for value in context["onlineResources"]
    )
    assert not any(value.get("name") == "Roads" for value in context["onlineResources"])
    assert [value["citation"]["title"] for value in context["formats"]] == ["CSV"]
    assert context["onlineResources"][0]["name"] == "Download copy"


def test_iso_online_distribution_same_url_functions_remain_distinct() -> None:
    document = export_iso_19115_3(iso_online_distribution_resource())["documentText"]
    distributions = iso_import(document).draft.metadata.extensions["opengeo"]["distributions"]
    secondary = distributions[1]
    assert secondary["accessUrl"] == secondary["downloadUrl"] == "https://data.example.test/both"
    values = secondary["isoTransfer"]["onlineResources"]
    assert [value["function"] for value in values] == ["information", "download"]
    assert secondary["isoTransfer"]["transferSizeMegabytes"] == 0.25


def test_iso_online_distribution_unsafe_and_unknown_source_values_keep_source() -> None:
    xml = ET.fromstring(export_iso_19115_3(iso_online_distribution_resource())["documentText"])
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    dto = xml.find(f".//{mrd}MD_DigitalTransferOptions")
    online = ET.SubElement(ET.SubElement(dto, f"{mrd}onLine"), f"{cit}CI_OnlineResource")
    ET.SubElement(
        ET.SubElement(online, f"{cit}linkage"), f"{gco}CharacterString"
    ).text = "http://data.example.test/insecure"
    ET.SubElement(dto, f"{mrd}unknownTransfer").text = "retained source"
    dto.find(f"{mrd}unitsOfDistribution").tail = "unmapped property tail"
    document = ET.tostring(xml, encoding="unicode")
    plan = iso_import(document)
    assert plan.source_document == document
    assert (
        "http://data.example.test/insecure"
        not in canonical_json_bytes(plan.draft.metadata.extensions).decode()
    )
    assert any("unknownTransfer" in path for path in plan.conversion_report["unmapped"])
    assert any("tail" in path for path in plan.conversion_report["unmapped"])
    assert any("onLine" in path or "linkage" in path for path in plan.conversion_report["unmapped"])

    xml = ET.fromstring(export_iso_19115_3(iso_online_distribution_resource())["documentText"])
    size = xml.find(f".//{mrd}transferSize/{gco}Real")
    assert size is not None
    size.text = "1.234567890123456789"
    document = ET.tostring(xml, encoding="unicode")
    plan = iso_import(document)
    first = plan.draft.metadata.extensions["opengeo"]["distributions"][0]
    assert "transferSizeMegabytes" not in first["isoTransfer"]
    assert plan.source_document == document
    assert "1.234567890123456789" in plan.source_document
    assert any("transferSize" in path for path in plan.conversion_report["unmapped"])

    xml = ET.fromstring(export_iso_19115_3(iso_online_distribution_resource())["documentText"])
    function = xml.find(
        f".//{mrd}MD_DigitalTransferOptions/{mrd}onLine/{cit}CI_OnlineResource/{cit}function"
    )
    assert function is not None
    for child in list(function):
        function.remove(child)
    ET.SubElement(function, "{urn:foreign}CI_OnLineFunctionCode").text = "information"
    document = ET.tostring(xml, encoding="unicode")
    plan = iso_import(document)
    first = plan.draft.metadata.extensions["opengeo"]["distributions"][0]
    assert "accessUrl" not in first
    assert "accessUrl" not in first["isoTransfer"]["projections"]
    assert first["downloadUrl"] == "https://data.example.test/roads.geojson"
    assert plan.source_document == document
    assert any("function" in path for path in plan.conversion_report["unmapped"])


def test_iso_online_distribution_foreign_and_distributor_descendants_are_not_owned() -> None:
    xml = ET.fromstring(export_iso_19115_3(iso_online_distribution_resource())["documentText"])
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    distribution = xml.find(f".//{mrd}MD_Distribution")
    distributor = ET.SubElement(
        ET.SubElement(distribution, f"{mrd}distributor"), f"{mrd}MD_Distributor"
    )
    nested = ET.SubElement(
        ET.SubElement(distributor, f"{mrd}distributorTransferOptions"),
        f"{mrd}MD_DigitalTransferOptions",
    )
    dto = xml.find(f".//{mrd}MD_DigitalTransferOptions")
    for parent, wrapper in ((nested, f"{mrd}onLine"), (dto, "{urn:foreign}onLine")):
        online = ET.SubElement(ET.SubElement(parent, wrapper), f"{cit}CI_OnlineResource")
        ET.SubElement(
            ET.SubElement(online, f"{cit}linkage"), f"{gco}CharacterString"
        ).text = "https://data.example.test/not-owned"
    document = ET.tostring(xml, encoding="unicode")
    plan = iso_import(document)
    distributions = plan.draft.metadata.extensions["opengeo"]["distributions"]
    assert len(distributions) == 2
    assert "https://data.example.test/not-owned" not in canonical_json_bytes(distributions).decode()
    assert plan.source_document == document
    assert any("distributor" in path for path in plan.conversion_report["unmapped"])


def test_iso_online_distribution_canonical_budget_keeps_source_and_native_urls() -> None:
    xml = ET.fromstring(export_iso_19115_3(iso_online_distribution_resource())["documentText"])
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    dto = xml.find(f".//{mrd}MD_DigitalTransferOptions")
    for child in list(dto):
        if child.tag == f"{mrd}distributionFormat":
            dto.remove(child)
    for _ in range(8):
        value = ET.SubElement(ET.SubElement(dto, f"{mrd}distributionFormat"), f"{mrd}MD_Format")
        citation = ET.SubElement(
            ET.SubElement(value, f"{mrd}formatSpecificationCitation"), f"{cit}CI_Citation"
        )
        ET.SubElement(ET.SubElement(citation, f"{cit}title"), f"{gco}CharacterString").text = (
            "é" * 700
        )
    document = ET.tostring(xml, encoding="unicode")
    assert len(document.encode()) <= 49152
    plan = iso_import(document)
    assert plan.source_document == document
    assert len(canonical_json_bytes(plan.draft.metadata.extensions)) <= 8192
    assert (
        plan.draft.metadata.extensions["opengeo"]["distributions"][0]["downloadUrl"]
        == "https://data.example.test/roads.geojson"
    )
    assert any("size-limit" in path for path in plan.conversion_report["unmapped"])


def test_iso_quality_reports_legacy_fallback_keeps_lexical_type_units_and_reference_multiplicity():
    for raw in ("001", "unavailable", "1.00", "-0", "true"):
        resource = quality_reports_resource()
        result = {"type": "DQ_QuantitativeResult", "values": [raw]}
        if raw == "true":
            result["unit"] = "ratio"
        groups = [
            {
                "scope": {"level": "dataset"},
                "reports": [
                    {
                        "type": "DQ_UsabilityElement",
                        "measure": {"names": ["sample"]},
                        "results": [result],
                    }
                ],
            }
        ]
        resource.metadata_extensions["opengeo"] = {
            "schemaVersion": "1.6.0",
            "qualityReports": groups,
        }
        reopened = iso_import(export_iso_19115_3(resource)["documentText"])
        actual = reopened.draft.metadata.extensions["opengeo"]
        assert actual["qualityReports"] == groups
        assert not actual.get("quality")

    resource = quality_reports_resource()
    groups = resource.metadata_extensions["opengeo"]["qualityReports"]
    groups[0]["reports"][0]["derivedReports"] = ["conformance", "conformance"]
    groups[1]["reports"][0]["relatedReports"] = ["completeness", "completeness"]
    reopened = iso_import(export_iso_19115_3(resource)["documentText"])
    actual = reopened.draft.metadata.extensions["opengeo"]
    assert actual["qualityReports"] == groups
    assert not actual.get("quality")
