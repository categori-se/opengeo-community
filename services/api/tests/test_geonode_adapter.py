import json
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


def test_export_maps_core_fields_and_preserves_opengeo_extensions() -> None:
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

    exported = export_geonode_resource(resource)

    assert exported["resource"]["uuid"] == GEONODE_STORY_ID
    assert exported["resource"]["resource_type"] == "geostory"
    assert exported["resource"]["extent"]["srid"] == "EPSG:4326"
    assert exported["resource"]["_opengeo"]["content"]["blocks"][0]["type"] == "markdown"
    assert exported["report"]["target"]["commit"] == GEONODE_COMMIT
