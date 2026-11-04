import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest

from opengeo_api.geonode_adapter import (
    GEONODE_COMMIT,
    assert_safe_geonode_tree,
    build_geonode_import_plan,
    export_geonode_resource,
)
from opengeo_api.resource_routes import GeoNodeImportRequest
from opengeo_api.resources import (
    GovernedResource,
    ResourceExternalIdentifier,
    ResourceRelationship,
    ResourceSummary,
)

NOW = datetime(2026, 8, 20, 12, tzinfo=UTC)
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000091")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000091")
OTHER_RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000092")
USER_ID = UUID("20000000-0000-4000-8000-000000000091")
RELATIONSHIP_ID = UUID("c0000000-0000-4000-8000-000000000091")
GEONODE_DATASET_ID = "11111111-1111-4111-8111-111111111111"
GEONODE_STORY_ID = "22222222-2222-4222-8222-222222222222"


def source_resources() -> tuple[dict, ...]:
    return (
        {
            "pk": 17,
            "uuid": GEONODE_DATASET_ID,
            "resource_type": "dataset",
            "title": "Road network",
            "abstract": "Verified roads",
            "language": "en",
            "license": {"name": "CC-BY-4.0"},
            "keywords": ["roads", {"name": "transport"}],
            "extent": {"coords": [84.0, 27.0, 86.0, 29.0], "srid": "EPSG:4326"},
            "temporal_extent_start": NOW,
            "is_approved": True,
            "is_published": True,
            "detail_url": "https://catalog.example.test/catalogue/17",
            "perms": {"users": {"reporter@example.test": ["view_resourcebase"]}},
            "styles": [{"name": "roads", "format": "sld", "body": "preserved"}],
            "custom_research_field": {"reviewed": True},
        },
        {
            "pk": 18,
            "uuid": GEONODE_STORY_ID,
            "resource_type": "geoapp",
            "subtype": "geostory",
            "title": "Road access story",
            "language": "en",
            "data": {"pages": [{"title": "Access"}]},
            "detail_url": "https://catalog.example.test/catalogue/18",
        },
    )


def test_import_maps_types_metadata_extensions_and_relationships_deterministically() -> None:
    relationships = (
        {
            "source_uuid": GEONODE_STORY_ID,
            "target_uuid": GEONODE_DATASET_ID,
            "relation": "references",
        },
    )
    first = build_geonode_import_plan(
        source_url="https://catalog.example.test",
        resources=source_resources(),
        relationships=relationships,
    )
    second = build_geonode_import_plan(
        source_url="https://catalog.example.test",
        resources=source_resources(),
        relationships=relationships,
    )

    assert [item.draft.kind for item in first.resources] == ["dataset", "story"]
    assert first.resources[0].draft.state == "review"
    assert first.resources[0].draft.visibility == "restricted"
    assert first.resources[0].draft.metadata.license == "CC-BY-4.0"
    assert first.resources[0].draft.metadata.spatial_extent == (84.0, 27.0, 86.0, 29.0)
    assert first.resources[0].draft.metadata.extensions["geonode"]["unmapped"] == {
        "custom_research_field": {"reviewed": True}
    }
    assert first.resources[1].draft.content["blocks"][1]["namespace"] == "geonode.geoapp"
    assert first.relationships[0].target_identifier == GEONODE_DATASET_ID
    assert first.resources[0].source_payload_sha256 == second.resources[0].source_payload_sha256
    assert first.report["summary"]["resources"] == 2
    assert first.report["summary"]["heldPublicationStates"] == 1
    assert first.report["summary"]["permissionBindingsRequired"] == 1
    assert first.report["summary"]["styleAttachmentsRequired"] == 1
    assert first.resources[0].draft.metadata.extensions["geonode"]["permissions"] == {
        "users": {"reporter@example.test": ["view_resourcebase"]}
    }
    outcomes = {item["path"]: item for item in first.report["fields"]}
    assert outcomes["resources[0].perms"]["outcome"] == "preserved_extension"
    assert outcomes["resources[0].styles"]["target"].endswith("styles")


def test_checksum_fixture_validates_through_the_http_model_and_keeps_typed_time() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "parity"
        / "fixtures"
        / "data"
        / "geonode-5.1-resources.json"
    )
    payload = GeoNodeImportRequest.model_validate(json.loads(fixture_path.read_text()))
    plan = build_geonode_import_plan(
        source_url=payload.source_url,
        resources=tuple(
            resource.model_dump(mode="python", exclude_none=False) for resource in payload.resources
        ),
        relationships=tuple(
            relationship.model_dump(mode="python") for relationship in payload.relationships
        ),
    )

    assert [item.draft.kind for item in plan.resources] == ["dataset", "document", "story"]
    assert plan.resources[0].draft.metadata.temporal_start == datetime(2025, 1, 1, tzinfo=UTC)
    assert plan.resources[0].draft.metadata.extensions["geonode"]["unmapped"] == {
        "custom_research_field": {"reviewed": True, "method": "field-survey"}
    }
    assert len(plan.relationships) == 2


def test_import_rejects_unknown_types_duplicate_ids_and_unresolved_relationships() -> None:
    unknown = list(source_resources())
    unknown[0] = {**unknown[0], "resource_type": "notebook"}
    duplicates = (source_resources()[0], source_resources()[0])

    with pytest.raises(ValueError, match="unsupported GeoNode resource type"):
        build_geonode_import_plan(
            source_url="https://catalog.example.test",
            resources=tuple(unknown),
            relationships=(),
        )
    with pytest.raises(ValueError, match="UUIDs must be unique"):
        build_geonode_import_plan(
            source_url="https://catalog.example.test",
            resources=duplicates,
            relationships=(),
        )
    with pytest.raises(ValueError, match="resolve inside"):
        build_geonode_import_plan(
            source_url="https://catalog.example.test",
            resources=source_resources(),
            relationships=(
                {
                    "source_uuid": GEONODE_STORY_ID,
                    "target_uuid": "33333333-3333-4333-8333-333333333333",
                    "relation": "references",
                },
            ),
        )


def test_sensitive_or_excessively_nested_source_fields_fail_closed() -> None:
    with pytest.raises(ValueError, match="sensitive field"):
        assert_safe_geonode_tree({"resource": {"access-token": "secret"}})
    nested: dict = {}
    cursor = nested
    for _ in range(34):
        cursor["child"] = {}
        cursor = cursor["child"]
    with pytest.raises(ValueError, match="nesting limit"):
        assert_safe_geonode_tree(nested)


def governed_resource() -> GovernedResource:
    summary = ResourceSummary(
        resource_id=RESOURCE_ID,
        project_id=PROJECT_ID,
        kind="story",
        slug="geonode-story",
        dataset_id=None,
        map_id=None,
        visibility="organization",
        state="review",
        version_number=2,
        title="Road access story",
        abstract="Access analysis",
        language="en",
        license="CC-BY-4.0",
        attribution="Research team",
        keywords=("roads",),
        spatial_extent=(84.0, 27.0, 86.0, 29.0),
        temporal_start=NOW,
        temporal_end=None,
        owner_user_id=USER_ID,
        origin_namespace="geonode",
        origin_identifier=GEONODE_STORY_ID,
        relationship_count=1,
        created_at=NOW,
        updated_at=NOW,
    )
    resource = GovernedResource(
        summary=summary,
        metadata_profile="opengeo.core.v1",
        metadata_extensions={"geonode": {"pk": 18}, "research": {"review": "passed"}},
        content={"blocks": [{"id": "intro", "type": "markdown", "markdown": "# Access"}]},
        provenance={"sourceSystem": "geonode"},
        change_message="Editorial revision",
        version_created_by=USER_ID,
        version_created_at=NOW,
        external_identifiers=(
            ResourceExternalIdentifier(
                namespace="geonode",
                identifier=GEONODE_STORY_ID,
                source_url="https://catalog.example.test",
                source_version="5.1.0",
                source_payload_sha256="a" * 64,
                imported_at=NOW,
            ),
        ),
        relationships=(
            ResourceRelationship(
                relationship_id=RELATIONSHIP_ID,
                source_resource_id=RESOURCE_ID,
                target_resource_id=OTHER_RESOURCE_ID,
                relation="references",
                created_by=USER_ID,
                created_at=NOW,
            ),
        ),
    )

    return resource


def test_export_maps_core_fields_and_preserves_opengeo_extensions() -> None:
    exported = export_geonode_resource(governed_resource())

    assert exported["resource"]["uuid"] == GEONODE_STORY_ID
    assert exported["resource"]["resource_type"] == "geostory"
    assert exported["resource"]["extent"]["srid"] == "EPSG:4326"
    assert exported["resource"]["_opengeo"]["content"]["blocks"][0]["type"] == "markdown"
    assert (
        exported["resource"]["_opengeo"]["externalIdentifiers"][0]["sourcePayloadSHA256"]
        == "a" * 64
    )
    assert exported["report"]["target"]["commit"] == GEONODE_COMMIT


def portable_plan(document: dict):
    payload = GeoNodeImportRequest.model_validate(
        {
            "source_product": "geonode",
            "source_version": "5.1.0",
            "source_commit": GEONODE_COMMIT,
            "source_url": "https://catalog.example.test",
            "resources": [document],
        }
    )
    return build_geonode_import_plan(
        source_url=payload.source_url,
        resources=tuple(item.model_dump(mode="python") for item in payload.resources),
        relationships=(),
        normalized_metadata=tuple(item.to_resource_metadata() for item in payload.resources),
    )


def test_native_portable_roundtrip_preserves_metadata_without_restoring_authority() -> None:
    original = governed_resource()
    translations = {
        "fr": {
            "title": "Réseau routier",
            "abstract": "Routes vérifiées",
            "attribution": "Équipe",
            "keywords": ["routes"],
        }
    }
    source_fields = {
        "edition": "2026",
        "purpose": "Public research",
        "regions": [{"name": "Study area"}],
        "constraints_other": "Cite source",
    }
    source_style = [{"name": "roads", "format": "sld", "body": "inert source"}]
    publication = {"dataset": "source evidence, not an authorization"}
    resource = replace(
        original,
        summary=replace(original.summary, kind="document", state="published", visibility="public"),
        metadata_profile="organization.managed",
        managed_metadata_profile_id=OTHER_RESOURCE_ID,
        managed_metadata_profile_version=7,
        metadata_extensions={
            "research": {"review": "passed", "lineage": ["survey"]},
            "opengeo.style-publications": publication,
            "geonode": {
                "metadata": source_fields,
                "detailUrl": "https://catalog.example.test/document/7",
                "styles": source_style,
                "permissions": {"groups": {"readers": ["view"]}},
                "unmapped": {"custom_research_field": {"reviewed": True}},
            },
        },
        translations=translations,
        external_identifiers=(),
        provenance={"sourceSystem": "native", "checksum": "b" * 64},
    )
    exported = export_geonode_resource(resource)
    doc = exported["resource"]
    assert doc["pk"] is None and doc["uuid"] == str(RESOURCE_ID)
    assert doc["detail_url"] == "https://catalog.example.test/document/7"
    assert all(doc[name] == value for name, value in source_fields.items())
    assert doc["custom_research_field"] == {"reviewed": True}
    plan = portable_plan(doc)
    draft = plan.resources[0].draft
    assert draft.metadata.translations == translations
    assert draft.metadata.extensions["research"] == resource.metadata_extensions["research"]
    assert "opengeo.style-publications" not in draft.metadata.extensions
    custody = draft.metadata.extensions["geonode"]
    assert custody["metadata"] == source_fields and custody["styles"] == source_style
    assert custody["opengeo"]["sourceAuthorityExtensions"] == {
        "opengeo.style-publications": publication
    }
    assert custody["opengeo"]["provenance"] == resource.provenance
    assert custody["opengeo"]["content"] == resource.content
    assert draft.state == "review" and draft.visibility == "restricted"
    assert draft.dataset_id is None and draft.map_id is None
    assert draft.metadata.profile == "opengeo.core.v1"
    assert (
        draft.metadata.managed_profile_id is None and draft.metadata.managed_profile_version is None
    )
    assert draft.content["blocks"][0]["url"] == doc["detail_url"]
    assert draft.provenance["sourceSystem"] == "geonode"
    assert draft.provenance["sourceUrl"] == "https://catalog.example.test"

    # Source custody is stable; repeating the same exchange does not nest carriers.
    sizes = []
    for _ in range(3):
        restored = replace(
            resource,
            metadata_extensions=draft.metadata.extensions,
            translations=draft.metadata.translations,
            provenance=draft.provenance,
        )
        next_export = export_geonode_resource(restored)
        draft = portable_plan(next_export["resource"]).resources[0].draft
        assert draft.metadata.extensions["research"] == resource.metadata_extensions["research"]
        assert draft.metadata.extensions["geonode"]["metadata"] == source_fields
        sizes.append(len(json.dumps(draft.metadata.extensions)))
        assert len(json.dumps(next_export["report"]).encode()) <= 16_384
    assert sizes[-1] == sizes[-2]  # Fixed first/current custody, no recursive envelope growth.
    paths = {item["path"]: item for item in exported["report"]["fields"]}
    assert paths["_opengeo.translations.fr.title"]["outcome"] == "preserved_extension"
    assert paths["pk"]["outcome"] == "not_present"
    assert "regions" in paths and "constraints_other" in paths
    assert paths["regions"]["outcome"] == "preserved_source"
    assert paths["is_published"]["outcome"] == "editorial_hint"
    assert exported["report"]["summary"]["mapped"] == sum(
        row["outcome"] == "mapped" for row in exported["report"]["fields"]
    )


def test_import_reports_each_source_field_and_declares_named_value_normalization() -> None:
    source = {
        **source_resources()[0],
        "regions": [{"name": "Study area"}],
        "constraints_other": "Cite source",
        "doi": "10.1234/example",
    }
    plan = build_geonode_import_plan(
        source_url="https://catalog.example.test", resources=(source,), relationships=()
    )
    rows = {row["path"]: row for row in plan.report["fields"]}
    for name in ["regions", "constraints_other", "doi", "custom_research_field", "perms", "styles"]:
        assert rows["resources[0]." + name]["outcome"] == "preserved_extension"
    assert rows["resources[0].license"]["outcome"] == "normalized"
    assert rows["resources[0].keywords"]["outcome"] == "normalized"
    assert plan.report["summary"]["normalizedFields"] == 2
    assert len(json.dumps(plan.report).encode()) <= 16_384


@pytest.mark.parametrize(
    "change",
    [
        {"translations": {"en": {"title": "Duplicate primary"}}},
        {"translations": {"fr": {"title": "A", "keywords": ["Same", "same"]}}},
        {"translations": {"fr": {"title": "A"}, "FR": {"title": "B"}}},
        {"metadataExtensions": {"research": {"api_token": "must-not-restore"}}},
        {"metadataExtensions": {"research": {"large": "x" * 8192}}},
        {"translations": {"fr": {"title": "A", "abstract": "x" * 16_384}}},
    ],
)
def test_portable_fields_use_existing_native_metadata_limits(change: dict) -> None:
    document = export_geonode_resource(governed_resource())["resource"]
    document["_opengeo"].update(change)
    with pytest.raises(ValueError):
        portable_plan(document)


def test_raw_portable_import_requires_native_validation_and_report_limit_is_explicit() -> None:
    document = export_geonode_resource(governed_resource())["resource"]
    with pytest.raises(ValueError, match="native request validation"):
        build_geonode_import_plan(
            source_url="https://catalog.example.test", resources=(document,), relationships=()
        )
    oversized_report = {
        **source_resources()[0],
        **{f"source_field_{index}": index for index in range(200)},
    }
    with pytest.raises(ValueError, match="report exceeds the 16 KiB"):
        build_geonode_import_plan(
            source_url="https://catalog.example.test",
            resources=(oversized_report,),
            relationships=(),
        )


def test_edited_source_and_carrier_values_replace_stale_values_with_first_evidence() -> None:
    original = replace(
        governed_resource(),
        metadata_extensions={
            "geonode": {
                "pk": 18,
                "metadata": {"purpose": "Original purpose", "edition": "Original edition"},
                "unmapped": {"custom_field": {"value": "original"}},
            },
        },
    )
    first = portable_plan(export_geonode_resource(original)["resource"]).resources[0].draft
    current = replace(original, metadata_extensions=first.metadata.extensions)
    document = export_geonode_resource(current)["resource"]
    document["purpose"] = "Edited purpose"
    document["edition"] = None
    document["custom_field"] = {"value": "edited"}
    document["empty_source_field"] = {}
    document["_opengeo"]["provenance"] = {"sourceSystem": "edited evidence"}
    result = portable_plan(document)
    custody = result.resources[0].draft.metadata.extensions["geonode"]
    assert custody["metadata"]["purpose"] == "Edited purpose"
    assert custody["metadata"]["edition"] is None
    assert custody["unmapped"]["custom_field"] == {"value": "edited"}
    assert custody["unmapped"]["empty_source_field"] == {}
    assert custody["sourceFieldsFirst"]["metadata"]["purpose"] == "Original purpose"
    assert custody["sourceFieldsFirst"]["metadata"]["edition"] == "Original edition"
    assert custody["sourceFieldsFirst"]["unmapped"]["custom_field"] == {"value": "original"}
    assert custody["opengeo"]["provenance"] == {"sourceSystem": "edited evidence"}
    assert custody["opengeoFirst"]["provenance"] == original.provenance
    rows = {row["path"]: row for row in result.report["fields"]}
    assert rows["resources[0].purpose"]["target"] == "metadata.extensions.geonode.metadata.purpose"
    assert rows["resources[0].edition"]["outcome"] == "preserved_extension"
    assert rows["resources[0].empty_source_field"]["outcome"] == "preserved_extension"


def test_nonobject_native_geonode_namespace_preserves_value_and_reports_actual_custody() -> None:
    original = replace(governed_resource(), metadata_extensions={"geonode": "opaque native value"})
    document = export_geonode_resource(original)["resource"]
    document["purpose"] = "Source purpose"
    document["custom_field"] = {"value": "retained"}
    result = portable_plan(document)
    metadata = result.resources[0].draft.metadata
    assert metadata.extensions["geonode"] == "opaque native value"
    assert metadata.extensions["geonode.import"]["metadata"]["purpose"] == "Source purpose"
    rows = {row["path"]: row for row in result.report["fields"]}
    assert (
        rows["resources[0].purpose"]["target"]
        == "metadata.extensions.geonode.import.metadata.purpose"
    )
    assert rows["resources[0].custom_field"]["target"].startswith(
        "metadata.extensions.geonode.import."
    )
    assert (
        rows["resources[0]._opengeo.provenance"]["target"]
        == "metadata.extensions.geonode.import.opengeo.provenance"
    )
    restored = replace(original, metadata_extensions=metadata.extensions)
    exported = export_geonode_resource(restored)
    assert exported["resource"]["purpose"] == "Source purpose"
    assert exported["resource"]["custom_field"] == {"value": "retained"}
