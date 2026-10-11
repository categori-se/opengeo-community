import asyncio
from collections import deque
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.metadata_profiles import (
    MetadataAccessDenied,
    MetadataConflict,
    MetadataProfileDraft,
    MetadataProfileUpdate,
    PostgresMetadataProfileRepository,
    export_datacite_4_7,
    export_datacite_4_7_xml,
    export_dcat_3,
    export_geodcat_ap_3_1,
    export_iso_19115_3,
    export_schema_org_dataset,
    export_stac_1_1,
    metadata_definition_checksum,
    resource_metadata_document,
    validate_metadata_document,
)
from opengeo_api.resources import ResourceRelationship, ResourceSummary
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-0000000000d3")
ORG_ID = UUID("10000000-0000-4000-8000-0000000000d3")
PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000d3")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000d3")
TARGET_ID = UUID("a0000000-0000-4000-8000-0000000000d4")
PROFILE_ID = UUID("c0000000-0000-4000-8000-0000000000d3")
PROFILE_VERSION_ID = UUID("d0000000-0000-4000-8000-0000000000d3")
NOW = datetime(2026, 8, 20, 16, tzinfo=UTC)


def profile_definition() -> dict[str, Any]:
    return {
        "schema_version": "1.0.0",
        "required_core": ["title", "abstract", "license", "spatial_extent"],
        "core_vocabularies": {"license": ["CC-BY-4.0", "CC0-1.0"]},
        "extension_fields": [
            {
                "namespace": "research",
                "name": "doi",
                "type": "doi",
                "title": "DOI",
                "description": None,
                "required": True,
                "vocabulary": [],
            },
            {
                "namespace": "research",
                "name": "contacts",
                "type": "contacts",
                "title": "Contacts",
                "description": None,
                "required": True,
                "vocabulary": [],
            },
        ],
    }


def governed_resource(
    *,
    kind: str = "dataset",
    extent: bool = True,
    translations: dict[str, dict[str, Any]] | None = None,
) -> Any:
    summary = ResourceSummary(
        resource_id=RESOURCE_ID,
        project_id=PROJECT_ID,
        kind=kind,  # type: ignore[arg-type]
        slug="roads",
        dataset_id=None,
        map_id=None,
        visibility="organization",
        state="published",
        version_number=3,
        title="Road network",
        abstract="A curated road network.",
        language="en",
        license="CC-BY-4.0",
        attribution="Research team",
        keywords=("roads", "transport"),
        spatial_extent=(-77.2, 38.7, -76.8, 39.1) if extent else None,
        temporal_start=NOW,
        temporal_end=None,
        owner_user_id=USER_ID,
        origin_namespace=None,
        origin_identifier=None,
        relationship_count=1,
        created_at=NOW,
        updated_at=NOW,
    )
    return SimpleNamespace(
        summary=summary,
        translations=translations or {},
        metadata_extensions={
            "research": {
                "doi": "10.1234/roads.2026",
                "contacts": [{"name": "Researcher", "role": "author"}],
                "unregistered": "preserved",
            },
            "local": {"review_note": "preserved"},
        },
        provenance={"method": "survey"},
        content={"blocks": []},
        relationships=(
            ResourceRelationship(
                relationship_id=UUID("e0000000-0000-4000-8000-0000000000d3"),
                source_resource_id=RESOURCE_ID,
                target_resource_id=TARGET_ID,
                relation="derived_from",
                created_by=USER_ID,
                created_at=NOW,
            ),
        ),
    )


class ScriptedTransaction:
    def __init__(self, one: list[tuple[Any, ...]]) -> None:
        self.one = deque(one)
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        del statement, parameters
        return self.one.popleft()

    async def fetch_all(self, statement, parameters=()):
        del statement, parameters
        return []

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class ScriptedExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction
        self.calls = 0

    async def run(self, context, operation):
        del context
        self.calls += 1
        return await operation(self.transaction)


def profile_row() -> tuple[Any, ...]:
    definition = profile_definition()
    return (
        PROFILE_ID,
        "research.core",
        "Research core",
        "Required research metadata",
        1,
        definition,
        metadata_definition_checksum(definition),
        None,
        USER_ID,
        USER_ID,
        NOW,
        NOW,
        NOW,
    )


def test_profile_validation_preserves_unknown_extensions_with_explicit_warnings() -> None:
    metadata = resource_metadata_document(governed_resource())

    report = validate_metadata_document(metadata, profile_definition())

    assert report["status"] == "valid"
    assert report["errors"] == 0
    assert report["warnings"] == 2
    assert {issue["code"] for issue in report["issues"]} == {
        "extension_field_preserved",
        "extension_namespace_preserved",
    }
    metadata["license"] = "proprietary"
    metadata["extensions"]["research"]["doi"] = "not-a-doi"
    invalid = validate_metadata_document(metadata, profile_definition())
    assert invalid["status"] == "invalid"
    assert invalid["errors"] == 2


def test_profile_validation_requires_case_normalized_language_revisions() -> None:
    metadata = resource_metadata_document(governed_resource())
    definition = {**profile_definition(), "required_languages": ["EN", "fr"]}

    missing = validate_metadata_document(metadata, definition)
    assert [issue["path"] for issue in missing["issues"] if issue["severity"] == "error"] == [
        "translations.fr"
    ]

    metadata["translations"] = {"FR": {"title": "Réseau routier"}}
    valid = validate_metadata_document(metadata, definition)
    assert not [issue for issue in valid["issues"] if issue["severity"] == "error"]


def test_dcat_and_stac_exports_are_version_pinned_and_report_loss() -> None:
    resource = governed_resource()

    dcat = export_dcat_3(resource)
    stac = export_stac_1_1(resource)

    assert dcat["targetVersion"] == "W3C Recommendation 2024-08-22"
    assert dcat["document"]["@type"] == "dcat:Dataset"
    assert dcat["document"]["prov:wasDerivedFrom"] == [f"urn:uuid:{TARGET_ID}"]
    assert dcat["report"]["preservedExtensions"] == ["local", "research"]
    assert stac["targetVersion"] == "1.1.0"
    assert stac["document"]["type"] == "Collection"
    assert stac["document"]["extent"]["spatial"]["bbox"][0] == [
        -77.2,
        38.7,
        -76.8,
        39.1,
    ]
    assert export_stac_1_1(governed_resource(kind="story"))["status"] == "not_applicable"


def test_multilingual_dcat_maps_language_values_and_stac_reports_boundary() -> None:
    resource = governed_resource(
        translations={
            "fr": {
                "title": "Réseau routier",
                "abstract": "Réseau organisé.",
                "attribution": "Équipe de recherche",
                "keywords": ["routes"],
            }
        }
    )

    dcat = export_dcat_3(resource)
    assert dcat["document"]["dct:title"][1] == {
        "@value": "Réseau routier",
        "@language": "fr",
    }
    assert dcat["report"]["multilingualLanguages"] == ["en", "fr"]
    assert "translations" in dcat["report"]["mapped"]
    assert "translations" in export_stac_1_1(resource)["report"]["unmapped"]


def test_extended_exports_are_version_pinned_bounded_and_fail_closed() -> None:
    resource = governed_resource(
        translations={
            "fr": {
                "title": "Réseau routier",
                "abstract": "Réseau organisé.",
                "attribution": None,
                "keywords": [],
            }
        }
    )

    schema_org = export_schema_org_dataset(resource)
    datacite = export_datacite_4_7(resource)
    datacite_xml = export_datacite_4_7_xml(resource)
    geodcat = export_geodcat_ap_3_1(resource)
    iso = export_iso_19115_3(resource)

    assert schema_org["targetVersion"] == "30.0"
    assert schema_org["document"]["@type"] == "Dataset"
    assert datacite["targetVersion"] == "4.7"
    assert datacite["document"]["data"]["attributes"]["publicationYear"] == 2026
    assert geodcat["targetVersion"] == "3.1.0"
    assert datacite_xml["targetVersion"] == "4.7"
    assert datacite_xml["document"] is None
    assert datacite_xml["documentText"].startswith("<?xml")
    assert 'identifierType="DOI"' in datacite_xml["documentText"]
    assert 'relatedIdentifierType="URN"' in datacite_xml["documentText"]
    assert geodcat["document"]["geodcatap:resourceType"]["@id"].endswith("/dataset")
    assert geodcat["document"]["geodcatap:resourceType"]["@type"] == "skos:Concept"
    assert geodcat["document"]["dct:language"][0]["@type"] == "dct:LinguisticSystem"
    assert iso["targetVersion"] == "ISO 19115-3:2023"
    assert iso["document"] is None
    assert iso["documentText"].startswith("<?xml")
    assert all(
        export["report"]["conformanceClaimed"] is False
        for export in (schema_org, datacite, geodcat, iso)
    )

    resource.metadata_extensions["datacite"] = {
        "doi": "10.1234/roads.2026",
        "creators": [{"name": "Researcher"}],
        "publisher": {"name": "Research team"},
        "publicationYear": True,
    }
    invalid = export_datacite_4_7(resource)
    assert invalid["status"] == "not_exportable_missing_required_metadata"
    assert invalid["report"]["missingRequired"] == ["publicationYear"]
    invalid_xml = export_datacite_4_7_xml(resource)
    assert invalid_xml["status"] == "not_exportable_missing_required_metadata"
    assert invalid_xml["documentText"] is None


def test_official_shape_exports_fail_closed_when_required_metadata_is_missing() -> None:
    resource = governed_resource()
    resource.summary = replace(resource.summary, abstract=None)

    geodcat = export_geodcat_ap_3_1(resource)
    iso = export_iso_19115_3(resource)

    assert geodcat["status"] == "not_exportable_missing_required_metadata"
    assert geodcat["report"]["missingRequired"] == ["abstract"]
    assert iso["status"] == "not_exportable_missing_required_metadata"
    assert iso["report"]["missingRequired"] == ["abstract"]


def test_repository_rechecks_definition_checksum_before_database_access() -> None:
    transaction = ScriptedTransaction([])
    executor = ScriptedExecutor(transaction)
    repository = PostgresMetadataProfileRepository(executor)  # type: ignore[arg-type]

    with pytest.raises(MetadataConflict, match="metadata_profile_checksum_mismatch"):
        asyncio.run(
            repository.create_profile(
                TenantContext(USER_ID, ORG_ID),
                MetadataProfileDraft(
                    slug="research.core",
                    title="Research core",
                    description=None,
                    definition=profile_definition(),
                    checksum_sha256="0" * 64,
                ),
                "metadata-checksum",
            )
        )

    assert executor.calls == 0


def test_only_organization_admin_can_create_or_update_profiles() -> None:
    definition = profile_definition()
    member_transaction = ScriptedTransaction([("member",)])
    member_repository = PostgresMetadataProfileRepository(  # type: ignore[arg-type]
        ScriptedExecutor(member_transaction)
    )
    with pytest.raises(MetadataAccessDenied, match="action forbidden"):
        asyncio.run(
            member_repository.create_profile(
                TenantContext(USER_ID, ORG_ID),
                MetadataProfileDraft(
                    slug="research.core",
                    title="Research core",
                    description=None,
                    definition=definition,
                    checksum_sha256=metadata_definition_checksum(definition),
                ),
                "metadata-member-denied",
            )
        )
    assert member_transaction.executions == []

    admin_transaction = ScriptedTransaction([("admin",), profile_row()])
    admin_repository = PostgresMetadataProfileRepository(  # type: ignore[arg-type]
        ScriptedExecutor(admin_transaction)
    )
    created = asyncio.run(
        admin_repository.create_profile(
            TenantContext(USER_ID, ORG_ID),
            MetadataProfileDraft(
                slug="research.core",
                title="Research core",
                description="Required research metadata",
                definition=definition,
                checksum_sha256=metadata_definition_checksum(definition),
            ),
            "metadata-admin-create",
        )
    )
    assert created.profile_id == PROFILE_ID
    statements = "\n".join(statement for statement, _ in admin_transaction.executions)
    assert "metadata_profiles" in statements
    assert "metadata_profile_versions" in statements
    assert "activity_events" in statements


def test_profile_update_conflict_returns_the_current_version_without_writes() -> None:
    definition = profile_definition()
    transaction = ScriptedTransaction([("admin",), (3,)])
    repository = PostgresMetadataProfileRepository(  # type: ignore[arg-type]
        ScriptedExecutor(transaction)
    )

    with pytest.raises(MetadataConflict) as caught:
        asyncio.run(
            repository.update_profile(
                TenantContext(USER_ID, ORG_ID),
                PROFILE_ID,
                MetadataProfileUpdate(
                    expected_version=2,
                    title="Research core",
                    description=None,
                    definition=definition,
                    checksum_sha256=metadata_definition_checksum(definition),
                    change_message="Require contacts",
                ),
                "metadata-conflict",
            )
        )
    assert caught.value.code == "metadata_profile_version_conflict"
    assert caught.value.current_version == 3
    assert transaction.executions == []


def test_stac_preserves_distribution_terms_without_inheriting_collection_license() -> None:
    from copy import deepcopy

    resource = governed_resource()
    distributions = [
        {
            "identifier": "download",
            "downloadUrl": "https://example.org/data.geojson",
            "accessUrl": "https://example.org/review",
            "mediaType": "application/geo+json",
            "license": "CC0-1.0",
        },
        {
            "identifier": "service",
            "accessUrl": "https://example.org/service",
            "license": "Display only",
        },
        {"identifier": "unknown", "downloadUrl": "https://example.org/unknown.zip"},
    ]
    resource.metadata_extensions["opengeo"] = {
        "schemaVersion": "1.0.0",
        "distributions": distributions,
    }
    before = deepcopy(resource.metadata_extensions)
    result = export_stac_1_1(resource)
    document = result["document"]
    assert document["license"] == "other"
    assert document["opengeo:license"] == "CC-BY-4.0"
    assert document["opengeo:metadataExtensions"] == before
    assert list(document["assets"]) == ["distribution-1", "distribution-3"]
    assert document["assets"]["distribution-1"]["href"] == distributions[0]["downloadUrl"]
    assert document["assets"]["distribution-1"]["opengeo:distribution"] == distributions[0]
    assert "license" not in document["assets"]["distribution-3"]["opengeo:distribution"]
    assert any("terms differ or are unknown" in value for value in result["report"]["defaulted"])
    document["opengeo:metadataExtensions"]["opengeo"]["distributions"][0]["license"] = "changed"
    assert resource.metadata_extensions == before


def test_stac_items_preserve_unknown_time_and_distribution_rights():
    from opengeo_api.stac import StacItemUnavailable, stac_item

    resource = governed_resource()
    with pytest.raises(StacItemUnavailable):
        stac_item(resource, "https://example.test/collection")
    resource.summary = replace(resource.summary, temporal_end=NOW)
    resource.metadata_extensions["opengeo"] = {
        "schemaVersion": "1.0.0",
        "distributions": [
            {"downloadUrl": "https://example.test/a", "license": "CC0-1.0"},
            {"downloadUrl": "https://example.test/b"},
            {"accessUrl": "https://example.test/service", "license": "Display only"},
        ],
    }
    document = stac_item(resource, "https://example.test/collection")
    assert document["id"] == f"{RESOURCE_ID}-v3"
    assert document["properties"]["datetime"] == NOW.isoformat()
    assert len(document["assets"]) == 2
    assert "license" not in document["assets"]["distribution-2"]["opengeo:distribution"]
    assert document["properties"]["opengeo:metadataExtensions"] == resource.metadata_extensions
    resource.summary = replace(
        resource.summary, spatial_extent=None, temporal_end=datetime(2027, 1, 1, tzinfo=UTC)
    )
    interval = stac_item(resource, "https://example.test/collection")
    assert interval["geometry"] is None and "bbox" not in interval
    assert interval["properties"]["datetime"] is None
    assert interval["properties"]["end_datetime"].startswith("2027-")
