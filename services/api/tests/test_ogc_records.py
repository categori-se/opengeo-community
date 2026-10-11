from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import HTTPException

from opengeo_api.ogc_records import (
    OGC_RECORD_PROFILE,
    catalog_document,
    export_ogc_record,
    record_collection,
    records_api_document,
)
from opengeo_api.record_routes import (
    _parse_bbox,
    _parse_datetime,
    _parse_ids,
    _parse_kinds,
    _parse_language,
    _require_collection,
    _search_expression,
)
from opengeo_api.resources import RecordResource, ResourceExternalIdentifier, ResourceSummary

PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000e1")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000e1")
NOW = datetime(2026, 8, 20, 18, tzinfo=UTC)


def record_resource() -> RecordResource:
    return RecordResource(
        summary=ResourceSummary(
            resource_id=RESOURCE_ID,
            project_id=PROJECT_ID,
            kind="dataset",
            slug="roads",
            dataset_id=None,
            map_id=None,
            visibility="organization",
            state="published",
            version_number=3,
            title="Road network",
            abstract="Curated road network.",
            language="en",
            license="CC-BY-4.0",
            attribution="Research team",
            keywords=("roads", "transport"),
            spatial_extent=(-77.2, 38.7, -76.8, 39.1),
            temporal_start=datetime(2026, 1, 1, tzinfo=UTC),
            temporal_end=None,
            owner_user_id=UUID("20000000-0000-4000-8000-0000000000e1"),
            origin_namespace=None,
            origin_identifier=None,
            relationship_count=0,
            created_at=NOW,
            updated_at=NOW,
        ),
        translations={
            "fr": {
                "title": "Réseau routier",
                "abstract": "Réseau routier organisé.",
                "keywords": ["routes", "transport"],
            },
            "ne": {"title": "सडक सञ्जाल"},
        },
        external_identifiers=(
            ResourceExternalIdentifier(
                namespace="doi",
                identifier="10.1234/roads",
                source_url="https://example.test/roads",
                source_version="1",
                source_payload_sha256="a" * 64,
                imported_at=NOW,
            ),
        ),
    )


def test_ogc_record_projects_one_requested_language_and_preserves_alternates() -> None:
    exported = export_ogc_record(record_resource(), PROJECT_ID, "fr")
    record = exported["document"]

    assert exported["targetVersion"] == "1.0.0"
    assert record["type"] == "Feature"
    assert record["geometry"]["type"] == "Polygon"
    assert record["time"]["interval"] == ["2026-01-01T00:00:00Z", ".."]
    assert record["properties"]["title"] == "Réseau routier"
    assert record["properties"]["language"] == {"code": "fr"}
    assert record["properties"]["languages"] == [
        {"code": "en"},
        {"code": "ne"},
    ]
    assert record["properties"]["externalIds"] == [{"scheme": "doi", "value": "10.1234/roads"}]
    assert {link.get("hreflang") for link in record["links"] if "hreflang" in link} == {
        "en",
        "fr",
        "ne",
    }
    assert any(link["href"] == OGC_RECORD_PROFILE for link in record["links"])
    assert any(link["rel"] == "collection" for link in record["links"])
    assert "extent" not in record


def test_ogc_record_falls_back_explicitly_without_mixing_primary_text() -> None:
    exported = export_ogc_record(record_resource(), PROJECT_ID, "de")
    properties = exported["document"]["properties"]

    assert properties["language"] == {"code": "en"}
    assert properties["title"] == "Road network"
    assert properties["opengeo:languageFallback"] == {"requested": "de", "selected": "en"}
    assert exported["report"]["fallback"] is True
    assert exported["report"]["conformanceClaimed"] is False


def test_record_collection_reports_counts_and_page_links() -> None:
    collection = record_collection(
        (record_resource(),),
        PROJECT_ID,
        "ne",
        12,
        "/records?limit=1",
        "/records?limit=1&offset=1",
        None,
    )

    assert collection["type"] == "FeatureCollection"
    assert collection["numberMatched"] == 12
    assert collection["numberReturned"] == 1
    assert collection["features"][0]["properties"]["title"] == "सडक सञ्जाल"
    assert any(link["rel"] == "next" for link in collection["links"])


def test_record_catalog_uses_structured_language_and_required_links() -> None:
    catalog = catalog_document(PROJECT_ID)

    assert catalog["type"] == "Collection"
    assert catalog["itemType"] == "record"
    assert catalog["language"] == {"code": "en"}
    assert {link["rel"] for link in catalog["links"]} >= {"self", "items"}


def test_records_api_document_exposes_mandatory_query_parameters_without_claim() -> None:
    document = records_api_document(PROJECT_ID)
    operation = document["paths"]["/collections/{collectionId}/items"]["get"]
    parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}

    assert document["openapi"] == "3.0.3"
    assert document["servers"] == [
        {
            "url": f"/projects/{PROJECT_ID}/records",
            "description": "Project-scoped Records API",
        }
    ]
    assert set(parameters) >= {
        "collectionId",
        "bbox",
        "datetime",
        "externalIds",
        "ids",
        "limit",
        "q",
        "type",
    }
    assert parameters["bbox"]["explode"] is False
    assert document["x-opengeo-conformance-claimed"] is False


def test_record_query_parsers_are_bounded_and_fail_closed() -> None:
    assert _parse_kinds("dataset,service") == ("dataset", "service")
    assert _parse_ids(str(RESOURCE_ID)) == (RESOURCE_ID,)
    assert _parse_bbox("-77.2,38.7,-76.8,39.1") == (-77.2, 38.7, -76.8, 39.1)
    assert _parse_bbox("-77.2,38.7,-100,-76.8,39.1,200") == (
        -77.2,
        38.7,
        -76.8,
        39.1,
    )
    assert _parse_datetime("2026-01-01/..") == (
        datetime(2026, 1, 1, tzinfo=UTC),
        None,
    )
    assert _parse_language("FR-ca") == "fr-ca"
    assert _search_expression("ocean,climate change") == '"ocean" OR "climate change"'
    with pytest.raises(HTTPException):
        _parse_bbox("0,0,200,90")
    with pytest.raises(HTTPException):
        _parse_bbox("0,0,10,1,1,-10")
    with pytest.raises(HTTPException):
        _parse_kinds("executable")
    with pytest.raises(HTTPException):
        _parse_language("../../secret")
    with pytest.raises(HTTPException) as missing:
        _require_collection("unknown")
    assert missing.value.status_code == 404
