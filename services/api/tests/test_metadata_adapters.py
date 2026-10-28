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
        }
    ]
    assert reparsed.draft.metadata.extensions["opengeo"]["quality"] == [
        {
            "measure": "completeness",
            "result": 0.98,
            "description": "Sampled against imagery.",
        }
    ]
    assert reparsed.draft.metadata.extensions["opengeo"]["schemaVersion"] == "1.3.0"
    assert (
        reparsed.draft.metadata.extensions["opengeo"]["acquisition"]
        == (plan.draft.metadata.extensions["opengeo"]["acquisition"])
    )
    assert "metadata_extensions.opengeo.acquisition" in exported["report"]["mapped"]
    assert (
        "metadata_extensions.opengeo.distributions[0].checksumSha256"
        in exported["report"]["unmapped"]
    )
    assert "metadata_extensions.opengeo.quality[0].unit" in exported["report"]["unmapped"]
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
