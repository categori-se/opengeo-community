"""Repository and HTTP contracts for deliberately versioning saved-map resources.

Database tests own immutable history, tenant isolation and transaction behavior.
These tests verify the ordinary API invokes that boundary and reports its facts.
"""

import asyncio
from dataclasses import replace
from hashlib import sha256
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from opengeo_api.authorization import Roles
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.resource_routes import resource_response
from opengeo_api.resources import (
    MapResourceSnapshot,
    PostgresResourceRepository,
    ResourceAccessDenied,
    ResourceConflict,
    ResourceDraft,
    ResourceUpdate,
)
from opengeo_api.tenant_database import TenantContext
from test_resource_routes import (
    FakeResourceRepository,
    api_client,
    create_payload,
    headers,
    resource,
)
from test_resources import (
    ORG_ID,
    PROJECT_ID,
    RESOURCE_ID,
    RESOURCE_VERSION_ID,
    USER_ID,
    ScriptedExecutor,
    ScriptedTransaction,
    detail_row,
    managed_metadata,
)

MAP_ID = UUID("40000000-0000-4000-8000-000000000093")
MAP_VERSION_ID = UUID("41000000-0000-4000-8000-000000000093")
CONTEXT = TenantContext(USER_ID, ORG_ID)


def update(*, expected_map_version=None):
    return ResourceUpdate(
        expected_version=2,
        visibility="organization",
        metadata=replace(managed_metadata(), managed_profile_id=None, managed_profile_version=None),
        content={},
        provenance={"mapVersion": 999, "note": "Authored notes are not revision bindings"},
        change_message="Use the reviewed saved map",
        expected_map_version=expected_map_version,
    )


def repository(transaction, *, role="editor"):
    result = PostgresResourceRepository(ScriptedExecutor(transaction))
    roles = Roles(organization="member", project=role)
    result._resource_roles = AsyncMock(return_value=roles)
    result._project_roles = AsyncMock(return_value=roles)
    result._load_resource = AsyncMock(return_value="loaded-resource")
    result._record_event = AsyncMock()
    return result


def test_map_creation_pins_server_history_inside_the_resource_transaction():
    transaction = ScriptedTransaction(one=[(1,), (True,)])
    store = repository(transaction)
    draft = ResourceDraft(
        kind="map",
        slug="review-map",
        dataset_id=None,
        map_id=MAP_ID,
        visibility="restricted",
        state="draft",
        metadata=update().metadata,
        content={},
        provenance={"mapVersion": 999},
        expected_map_version=7,
    )
    assert asyncio.run(store.create_resource(CONTEXT, PROJECT_ID, draft, "create-map")) == (
        "loaded-resource"
    )
    assert "FROM app.maps" in transaction.fetches[0]
    assert transaction.fetches[-1] == "SELECT app.bind_map_resource_version(%s, %s, %s)"
    assert len(transaction.executions) == 2
    assert "INSERT INTO app.governed_resources" in transaction.executions[0][0]
    assert transaction.executions[0][1][10:] == (USER_ID, USER_ID, USER_ID)
    assert "INSERT INTO app.governed_resource_versions" in transaction.executions[1][0]


@pytest.mark.parametrize("expected", [None, 7])
def test_map_update_inherits_or_deliberately_advances_through_the_same_guard(expected):
    transaction = ScriptedTransaction(one=[(2, "draft", "map", MAP_ID), (True,)])
    calls = []
    fetch = transaction.fetch_one

    async def capture(statement, parameters=()):
        calls.append((statement, tuple(parameters)))
        return await fetch(statement, parameters)

    transaction.fetch_one = capture
    store = repository(transaction)
    assert (
        asyncio.run(
            store.update_resource(
                CONTEXT,
                PROJECT_ID,
                RESOURCE_ID,
                update(expected_map_version=expected),
                "update-map",
            )
        )
        == "loaded-resource"
    )
    assert calls[-1][1][0] == RESOURCE_ID
    assert "resource.map_id" in calls[0][0], "The SQL projection must supply the binding column"
    assert isinstance(calls[-1][1][1], UUID)
    assert calls[-1][1][2] == expected  # Never the authored provenance value 999.
    assert "INSERT INTO app.governed_resource_versions" in transaction.executions[0][0]
    assert "SET current_version_id" in transaction.executions[1][0]
    assert store._record_event.await_args.args[-1].get("map_version") == expected


@pytest.mark.parametrize(
    "expected,code",
    [
        (7, "map_version_conflict"),
        (None, "map_resource_snapshot_required"),
    ],
)
def test_failed_map_binding_never_advances_resource_head_or_records_success(expected, code):
    transaction = ScriptedTransaction(one=[(2, "draft", "map", MAP_ID), (False,)])
    store = repository(transaction)
    with pytest.raises(ResourceConflict, match=code):
        asyncio.run(
            store.update_resource(
                CONTEXT, PROJECT_ID, RESOURCE_ID, update(expected_map_version=expected), "conflict"
            )
        )
    assert all("SET current_version_id" not in sql for sql, _ in transaction.executions)
    store._record_event.assert_not_awaited()
    store._load_resource.assert_not_awaited()


@pytest.mark.parametrize(
    "current,code",
    [
        ((3, "draft", "map", MAP_ID), "resource_version_conflict"),
        ((2, "published", "map", MAP_ID), "map_resource_revision_requires_draft"),
        ((2, "archived", "map", MAP_ID), "map_resource_revision_requires_draft"),
        ((2, "draft", "dataset", None), "resource_binding_kind_mismatch"),
        ((2, "draft", "map", None), "resource_binding_kind_mismatch"),
    ],
)
def test_map_refresh_rejects_stale_resource_or_wrong_workflow_before_writes(current, code):
    transaction = ScriptedTransaction(one=[current])
    store = repository(transaction)
    with pytest.raises(ResourceConflict, match=code):
        asyncio.run(
            store.update_resource(
                CONTEXT, PROJECT_ID, RESOURCE_ID, update(expected_map_version=7), "reject"
            )
        )
    assert transaction.executions == []


def test_read_only_resource_member_cannot_refresh_a_map_version():
    transaction = ScriptedTransaction()
    store = repository(transaction, role="viewer")
    with pytest.raises(ResourceAccessDenied):
        asyncio.run(
            store.update_resource(
                CONTEXT, PROJECT_ID, RESOURCE_ID, update(expected_map_version=7), "deny"
            )
        )
    assert transaction.executions == []
    assert transaction.fetches == []


@pytest.mark.parametrize("expected", [True, False, 0, -1, 1.5, "7", 9_007_199_254_740_992])
def test_repository_rejects_non_integer_or_unbounded_map_revision(expected):
    transaction = ScriptedTransaction()
    with pytest.raises(ResourceConflict, match="map_version_conflict"):
        asyncio.run(
            PostgresResourceRepository._bind_map_snapshot(
                transaction, RESOURCE_ID, RESOURCE_VERSION_ID, expected
            )
        )
    assert transaction.fetches == []


@pytest.mark.parametrize("has_binding", [True, False])
def test_map_detail_reports_immutable_revision_not_current_map_or_authored_provenance(has_binding):
    row = list(detail_row())
    row[2], row[5], row[28] = "map", MAP_ID, {"mapVersion": 999}
    definition = {"layers": [{"layerId": "water", "order": 0}], "bookmarks": []}
    snapshot = (MAP_ID, MAP_VERSION_ID, 7, definition) if has_binding else None
    transaction = ScriptedTransaction(one=[tuple(row), snapshot], all_rows=[[], []])
    store = PostgresResourceRepository(ScriptedExecutor(transaction))
    result = asyncio.run(store._load_resource(transaction, CONTEXT, PROJECT_ID, RESOURCE_ID))
    expected = (
        MapResourceSnapshot(
            MAP_ID, MAP_VERSION_ID, 7, sha256(canonical_json_bytes(definition)).hexdigest()
        )
        if has_binding
        else None
    )
    assert result.map_snapshot == expected
    assert result.provenance["mapVersion"] == 999
    assert transaction.executions == []
    assert "binding.resource_version_id = resource.current_version_id" in transaction.fetches[1]
    assert "map_version.version = binding.map_version" in transaction.fetches[1]


def test_resource_response_exposes_binding_identity_without_map_definition():
    snapshot = MapResourceSnapshot(MAP_ID, MAP_VERSION_ID, 7, "a" * 64)
    result = resource_response(replace(resource(kind="map"), map_snapshot=snapshot))
    assert result.model_dump(mode="json")["map_snapshot"] == {
        "map_id": str(MAP_ID),
        "map_version_id": str(MAP_VERSION_ID),
        "map_version": 7,
        "definition_checksum_sha256": "a" * 64,
    }
    assert resource_response(resource()).map_snapshot is None


def test_http_create_and_update_pass_explicit_map_revision_to_repository():
    store = FakeResourceRepository()
    client = api_client(store)
    payload = create_payload()
    payload.update(kind="map", map_id=str(MAP_ID), expected_map_version=7)
    payload.pop("dataset_id", None)
    response = client.post(f"/projects/{PROJECT_ID}/resources", headers=headers(), json=payload)
    assert response.status_code == 201, response.text
    assert store.calls[-1][3].expected_map_version == 7
    edit = {key: payload[key] for key in ["metadata", "content", "provenance", "visibility"]}
    edit.update(expected_version=2, expected_map_version=8)
    response = client.put(
        f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}", headers=headers(), json=edit
    )
    assert response.status_code == 200, response.text
    assert store.calls[-1][4].expected_map_version == 8


@pytest.mark.parametrize("expected", [True, 0, -1, 1.5, "7", 9_007_199_254_740_992])
def test_http_rejects_invalid_expected_map_version_without_repository_call(expected):
    store = FakeResourceRepository()
    client = api_client(store)
    payload = create_payload()
    payload.update(kind="map", map_id=str(MAP_ID), expected_map_version=expected)
    response = client.post(f"/projects/{PROJECT_ID}/resources", headers=headers(), json=payload)
    assert response.status_code == 422
    assert store.calls == []


def test_http_rejects_map_revision_on_a_non_map_resource():
    store = FakeResourceRepository()
    client = api_client(store)
    payload = create_payload()
    payload["expected_map_version"] = 7
    response = client.post(f"/projects/{PROJECT_ID}/resources", headers=headers(), json=payload)
    assert response.status_code == 422
    assert store.calls == []
