import asyncio
import json
from collections import deque
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.map_definitions import MAP_DEFINITION_SCHEMA_VERSION
from opengeo_api.rds_data import DataApiResult, compile_data_api_statement
from opengeo_api.tenant_database import RdsDataApiTenantQueryExecutor, TenantContext
from opengeo_api.workspaces import (
    ClientDraft,
    MapDraft,
    Page,
    PostgresWorkspaceRepository,
    WorkspaceAccessDenied,
    WorkspaceConflict,
    WorkspaceNotFound,
    WorkspaceStoreUnavailable,
)
from test_tenant_database import FakeDataApiClient, data_api_settings

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
CLIENT_ID = UUID("30000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
MAP_ID = UUID("60000000-0000-4000-8000-000000000001")
DATASET_ID = UUID("70000000-0000-4000-8000-000000000001")
DATASET_VERSION_ID = UUID("71000000-0000-4000-8000-000000000001")
BASEMAP_BINDING_ID = UUID("c1000000-0000-4000-8000-000000000056")
NOW = datetime(2026, 8, 18, 12, tzinfo=UTC)


class FakeTransaction:
    def __init__(
        self,
        *,
        one: list[tuple[Any, ...] | None] | None = None,
        all_rows: list[list[tuple[Any, ...]]] | None = None,
    ) -> None:
        self.one = deque(one or [])
        self.all_rows = deque(all_rows or [])
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.one, f"unexpected fetch_one: {statement}"
        return self.one.popleft()

    async def fetch_all(self, statement: str, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        assert self.all_rows, f"unexpected fetch_all: {statement}"
        return self.all_rows.popleft()

    async def execute(self, statement: str, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class FakeExecutor:
    def __init__(self, transaction: FakeTransaction) -> None:
        self.transaction = transaction
        self.contexts: list[TenantContext] = []

    async def run(self, context, operation):
        self.contexts.append(context)
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        self.contexts.append(context)
        return await self.transaction.fetch_one(statement, parameters)


def context() -> TenantContext:
    return TenantContext(user_id=USER_ID, organization_id=ORG_ID)


def client_row() -> tuple[Any, ...]:
    return (CLIENT_ID, "Acme", "ACME", "Client", "active", NOW, NOW)


def project_row(role: str | None = "owner") -> tuple[Any, ...]:
    return (
        PROJECT_ID,
        CLIENT_ID,
        "Atlas",
        "ATLAS",
        "Project",
        "active",
        NOW,
        NOW,
        role,
        "internal",
        None,
        None,
    )


def definition_bytes(definition: dict[str, Any] | None = None) -> bytes:
    return json.dumps(
        definition or {"layers": [], "bookmarks": []},
        separators=(", ", ": "),
        sort_keys=True,
    ).encode()


def definition_rows(definition: dict[str, Any] | None = None) -> list[tuple[Any, ...]]:
    encoded = definition_bytes(definition)
    return [
        (MAP_ID, index, encoded[offset : offset + 24_576])
        for index, offset in enumerate(range(0, len(encoded), 24_576))
    ]


def map_row(
    version: int = 1,
    name: str = "Atlas map",
    definition: dict[str, Any] | None = None,
) -> tuple[Any, ...]:
    return (
        MAP_ID,
        PROJECT_ID,
        name,
        "Map",
        "active",
        len(definition_bytes(definition)),
        version,
        NOW,
        NOW,
    )


def governed_xyz_definition(source_url: str = "https://tiles.example.test/{z}/{x}/{y}.png"):
    return {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": "source_roads",
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [
            {
                "layerId": "source_roads",
                "datasetId": str(DATASET_ID),
                "title": "Road tiles",
                "sourceType": "xyz-raster",
                "sourceVersion": 2,
                "sourceUrl": source_url,
                "sourceConfiguration": {
                    "minZoom": 0,
                    "maxZoom": 18,
                    "tileSize": 256,
                    "scheme": "xyz",
                    "attribution": "Example",
                },
                "visible": True,
                "opacity": 0.8,
                "order": 10,
                "style": {},
                "labels": {"enabled": False, "field": None},
            }
        ],
    }


def current_empty_definition(**overrides):
    return {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [],
        **overrides,
    }


def governed_dataset_definition():
    return current_empty_definition(
        activeLayerId="managed_data",
        layers=[
            {
                "layerId": "managed_data",
                "datasetId": str(DATASET_ID),
                "datasetVersionId": str(DATASET_VERSION_ID),
                "title": "Managed data",
                "sourceType": "governed-dataset",
                "sourceVersion": 3,
                "visible": True,
                "opacity": 1,
                "order": 0,
                "style": {},
                "labels": {"enabled": False, "field": None},
            }
        ],
    )


def connected_basemap_definition():
    return current_empty_definition(
        basemaps=[
            {
                "basemapId": f"provider-protomaps-{BASEMAP_BINDING_ID}-dark",
                "title": "Protomaps Dark",
                "kind": "provider-style",
                "provider": "protomaps",
                "connectionBindingId": str(BASEMAP_BINDING_ID),
                "flavor": "dark",
                "attribution": "Protomaps · © OpenStreetMap contributors",
                "visible": True,
                "opacity": 1,
            }
        ]
    )


def governed_regional_basemap_definition():
    return current_empty_definition(
        basemaps=[
            {
                "basemapId": f"governed-xyz-{DATASET_ID}-v3",
                "title": "Mountain district imagery",
                "kind": "governed-raster",
                "datasetId": str(DATASET_ID),
                "sourceType": "xyz-raster",
                "sourceVersion": 3,
                "sourceUrl": "https://tiles.example.test/{z}/{x}/{y}.png",
                "sourceConfiguration": {
                    "minZoom": 2,
                    "maxZoom": 18,
                    "tileSize": 256,
                    "scheme": "tms",
                    "attribution": "Example mapping agency",
                    "presentationRole": "regional_basemap",
                    "license": "CC-BY-4.0",
                    "coverageBounds": [80, 26, 89, 31],
                    "coordinateBehavior": "wgs84_web_mercator",
                },
                "attribution": "Example mapping agency",
                "visible": True,
                "opacity": 0.85,
            }
        ]
    )


def test_client_create_checks_current_role_and_audits_in_one_transaction() -> None:
    transaction = FakeTransaction(one=[("admin",), client_row()])
    executor = FakeExecutor(transaction)
    repository = PostgresWorkspaceRepository(executor)

    result = asyncio.run(
        repository.create_client(
            context(),
            ClientDraft(name="Acme", client_code="ACME", description="Client"),
            "request-123",
        )
    )

    assert result.client_id == CLIENT_ID
    assert executor.contexts == [context()]
    assert [call[0] for call in transaction.calls] == ["one", "one", "execute"]
    audit = transaction.calls[-1]
    assert "INSERT INTO app.activity_events" in audit[1]
    assert audit[2][0:2] == (ORG_ID, USER_ID)
    assert audit[2][3:7] == ("client.created", "client", CLIENT_ID, "request-123")


def test_member_cannot_create_client_and_no_write_is_attempted() -> None:
    transaction = FakeTransaction(one=[("member",)])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceAccessDenied):
        asyncio.run(
            repository.create_client(
                context(),
                ClientDraft(name="Denied", client_code=None, description=None),
                "request-123",
            )
        )

    assert len(transaction.calls) == 1


def test_project_list_filters_non_admin_to_direct_or_team_effective_role() -> None:
    transaction = FakeTransaction(one=[("member",)], all_rows=[[project_row("editor")]])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    projects = asyncio.run(repository.list_projects(context(), CLIENT_ID, Page()))

    assert projects[0].caller_role == "editor"
    query = transaction.calls[1]
    assert "app.effective_project_role(project.id, %s) IS NOT NULL" in query[1]
    assert query[2] == (ORG_ID, CLIENT_ID, CLIENT_ID, False, USER_ID, 50, 0)


@pytest.mark.parametrize("organization_role", ["admin", "member", "guest"])
def test_project_list_search_is_literal_and_permission_scoped_before_pagination(
    organization_role: str,
) -> None:
    transaction = FakeTransaction(one=[(organization_role,)], all_rows=[[project_row("viewer")]])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))
    literal = "%_\\probe"

    projects = asyncio.run(
        repository.list_projects(
            context(), CLIENT_ID, Page(limit=25, offset=100), literal, "archived"
        )
    )

    assert projects[0].project_id == PROJECT_ID
    statement, parameters = transaction.calls[1][1:]
    assert literal not in statement
    assert "project.organization_id = %s" in statement
    assert "app.effective_project_role(project.id, %s) IS NOT NULL" in statement
    assert statement.index("project.status::text = %s") < statement.index("LIMIT %s OFFSET %s")
    assert statement.index("LIKE lower(%s) ESCAPE %s") < statement.index("LIMIT %s OFFSET %s")
    assert "ORDER BY lower(project.name), project.id" in statement
    assert parameters == (
        ORG_ID,
        CLIENT_ID,
        CLIENT_ID,
        organization_role == "admin",
        USER_ID,
        "archived",
        "%\\%\\_\\\\probe%",
        "\\",
        25,
        100,
    )
    if organization_role == "guest":
        assert "app.clients" not in statement
    else:
        assert "client.organization_id = project.organization_id" in statement
        assert "client.id = project.client_id" in statement


def test_recent_projects_are_current_user_activity_ordered_and_permission_scoped() -> None:
    recent_at = datetime(2026, 8, 20, 15, tzinfo=UTC)
    transaction = FakeTransaction(
        one=[("member",)],
        all_rows=[
            [
                (*project_row("editor"), recent_at, "map.updated"),
            ]
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    records = asyncio.run(repository.list_recent_projects(context(), Page(limit=5)))

    assert records[0].project.project_id == PROJECT_ID
    assert records[0].last_activity_at == recent_at
    assert records[0].last_event_type == "map.updated"
    query = transaction.calls[1]
    assert "JOIN LATERAL" in query[1]
    assert "event.actor_user_id = %s" in query[1]
    assert "app.effective_project_role(project.id, %s) IS NOT NULL" in query[1]
    assert "ORDER BY recent_activity.occurred_at DESC" in query[1]
    assert query[2] == (USER_ID, ORG_ID, False, USER_ID, 5, 0)


@pytest.mark.parametrize("status", ["archived", "active"])
def test_project_status_update_casts_data_api_enum_and_preserves_access(status: str) -> None:
    before = list(project_row("owner"))
    before[5] = "active" if status == "archived" else "archived"
    after = list(before)
    after[5] = status
    transaction = FakeTransaction(one=[("member",), tuple(before), tuple(after)])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.update_project(context(), PROJECT_ID, {"status": status}, "request-status")
    )

    update = transaction.calls[2]
    sql, bindings = compile_data_api_statement(update[1], update[2])
    assert "status = CAST(:p0 AS app.record_status)" in sql
    assert bindings[0] == {"name": "p0", "value": {"stringValue": status}}
    assert "visibility =" not in sql
    assert result.status == status
    assert result.visibility == "internal"
    assert result.caller_role == "owner"
    audit = transaction.calls[3]
    assert audit[2][3] == ("project.archived" if status == "archived" else "project.updated")


def test_project_publication_visibility_records_actor_and_audit_event() -> None:
    published = (*project_row("owner")[:9], "published", NOW, USER_ID)
    transaction = FakeTransaction(one=[("member",), project_row("owner"), published])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.update_project(
            context(), PROJECT_ID, {"visibility": "published"}, "request-publish"
        )
    )

    assert result.visibility == "published"
    update = transaction.calls[2]
    assert "visibility = %s::app.project_visibility" in update[1]
    assert "published_by = CASE" in update[1]
    assert update[2] == (
        "published",
        "published",
        "published",
        USER_ID,
        ORG_ID,
        PROJECT_ID,
        "owner",
    )
    audit = transaction.calls[3]
    assert audit[2][3] == "project.published"


def test_map_create_records_initial_version_and_activity_atomically() -> None:
    definition = current_empty_definition()
    transaction = FakeTransaction(
        one=[("member",), ("editor",), map_row(definition=definition), (1,), (True,)],
        all_rows=[definition_rows(definition)],
    )
    executor = FakeExecutor(transaction)
    repository = PostgresWorkspaceRepository(executor)

    result = asyncio.run(
        repository.create_map(
            context(),
            PROJECT_ID,
            MapDraft(
                name="Atlas map",
                description="Map",
                definition=definition,
            ),
            "request-map",
        )
    )

    assert result.version == 1
    assert result.owner_user_id == USER_ID
    assert executor.contexts == [context()]
    assert [call[0] for call in transaction.calls] == [
        "one",
        "one",
        "one",
        "all",
        "execute",
        "one",
        "execute",
        "execute",
        "one",
        "execute",
        "execute",
    ]
    assert "INSERT INTO app.map_versions" in transaction.calls[4][1]
    owner_insert = transaction.calls[6]
    assert "INSERT INTO app.governed_resources" in owner_insert[1]
    assert owner_insert[2][6] == result.map_id
    assert owner_insert[2][7:9] == ("restricted", "draft")
    assert owner_insert[2][10:] == (USER_ID, USER_ID, USER_ID)
    assert transaction.calls[7][2][6] == "und"
    assert transaction.calls[8][1] == "SELECT app.bind_map_resource_version(%s, %s, %s)"
    assert transaction.calls[8][2][-1] == 1
    assert transaction.calls[9][2][3] == "resource.created"
    assert "INSERT INTO app.activity_events" in transaction.calls[-1][1]


def test_map_duplicate_assigns_new_owner_after_history_without_copying_source_governance(
    monkeypatch,
) -> None:
    duplicate_id = UUID("60000000-0000-4000-8000-000000000002")
    monkeypatch.setattr("opengeo_api.workspaces.uuid4", lambda: duplicate_id)
    definition = current_empty_definition()
    transaction = FakeTransaction(
        one=[
            ("member",), ("editor",), map_row(version=7, definition=definition),
            (duplicate_id, *map_row(definition=definition)[1:]), (1,), (True,),
        ],
        all_rows=[
            definition_rows(definition),
            [(duplicate_id, index, chunk) for _, index, chunk in definition_rows(definition)],
        ],
    )
    executor = FakeExecutor(transaction)
    result = asyncio.run(
        PostgresWorkspaceRepository(executor).duplicate_map(
            context(), PROJECT_ID, MAP_ID, "New composition", "request-duplicate"
        )
    )

    assert result.map_id == duplicate_id
    assert result.owner_user_id == USER_ID
    assert result.definition == definition
    assert executor.contexts == [context()]
    queries = [call[1] for call in transaction.calls]
    history_index = next(
        i for i, query in enumerate(queries) if "INSERT INTO app.map_versions" in query
    )
    owner_index = next(
        i for i, query in enumerate(queries) if "INSERT INTO app.governed_resources" in query
    )
    assert history_index < owner_index
    assert transaction.calls[owner_index][2][6:9] == (duplicate_id, "restricted", "draft")
    assert transaction.calls[owner_index][2][10:] == (USER_ID, USER_ID, USER_ID)
    resource_version = transaction.calls[owner_index + 1][2]
    assert resource_version[6] == "und"
    assert resource_version[7:9] == (None, None)
    assert resource_version[17].obj["sourceMapId"] == str(MAP_ID)
    assert resource_version[17].obj["sourceMapVersion"] == 7
    assert resource_version[17].obj["mapVersion"] == 1
    assert all("UPDATE app." not in query for query in queries)
    assert transaction.calls[-1][2][3] == "map.duplicated"


def test_map_creation_key_replay_never_assigns_owner_to_an_existing_map() -> None:
    definition = current_empty_definition()
    draft = MapDraft(
        name="Atlas map", description="Map", definition=definition,
        creation_key=UUID("80000000-0000-4000-8000-000000000001"),
    )
    request_hash = sha256(json.dumps(
        {"project_id": str(PROJECT_ID), "name": draft.name,
         "description": draft.description, "definition": definition},
        sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()).hexdigest()
    transaction = FakeTransaction(
        one=[
            ("member",), ("editor",), (None,), (MAP_ID, PROJECT_ID, request_hash),
            map_row(definition=definition),
        ],
        all_rows=[definition_rows(definition)],
    )
    result = asyncio.run(
        PostgresWorkspaceRepository(FakeExecutor(transaction)).create_map(
            context(), PROJECT_ID, draft, "request-replay"
        )
    )

    assert result.map_id == MAP_ID
    assert result.owner_user_id is None
    assert all(call[0] != "execute" for call in transaction.calls)
    assert all("app.governed_resources" not in call[1] for call in transaction.calls)


def test_failed_new_map_owner_binding_rolls_back_the_existing_transaction() -> None:
    definition = current_empty_definition()
    client = FakeDataApiClient()
    client.results = [
        DataApiResult(records=(("context-set",),), updated=0),
        DataApiResult(records=(("member",),), updated=0),
        DataApiResult(records=(("editor",),), updated=0),
        DataApiResult(records=(map_row(definition=definition),), updated=0),
        DataApiResult(records=tuple(definition_rows(definition)), updated=0),
        DataApiResult(records=(), updated=1),
        DataApiResult(records=((1,),), updated=0),
        DataApiResult(records=(), updated=1),
        DataApiResult(records=(), updated=1),
        DataApiResult(records=((False,),), updated=0),
    ]
    executor = RdsDataApiTenantQueryExecutor(data_api_settings(), client)  # type: ignore[arg-type]

    with pytest.raises(WorkspaceConflict, match="map_version_conflict"):
        asyncio.run(PostgresWorkspaceRepository(executor).create_map(
            context(), PROJECT_ID,
            MapDraft(name="Atlas map", description="Map", definition=definition),
            "request-owner-binding-failure",
        ))

    assert client.events[0] == ("begin",)
    assert client.events[-1] == ("rollback", "transaction-1")
    assert ("commit", "transaction-1") not in client.events
    statements = [event for event in client.events if event[0] == "execute"]
    assert all(event[3] == "transaction-1" for event in statements)
    assert any("INSERT INTO app.map_versions" in event[1] for event in statements)
    assert any("INSERT INTO app.governed_resources" in event[1] for event in statements)
    assert statements[-1][1] == "SELECT app.bind_map_resource_version(%s, %s, %s)"
    assert not any("INSERT INTO app.activity_events" in event[1] for event in statements)


def test_map_create_requires_project_link_and_exact_external_source_revision() -> None:
    definition = governed_xyz_definition()
    database_configuration = {
        "min_zoom": 0,
        "max_zoom": 18,
        "tile_size": 256,
        "scheme": "xyz",
        "attribution": "Example",
    }
    transaction = FakeTransaction(
        one=[("member",), ("editor",), map_row(definition=definition), (1,), (True,)],
        all_rows=[
            [(DATASET_ID,)],
            [
                (
                    DATASET_ID,
                    2,
                    "xyz",
                    "https://tiles.example.test/{z}/{x}/{y}.png",
                    database_configuration,
                )
            ],
            definition_rows(definition),
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.create_map(
            context(),
            PROJECT_ID,
            MapDraft(name="Road map", description=None, definition=definition),
            "request-governed-map",
        )
    )

    assert result.definition == definition
    assert any("app.project_datasets" in call[1] for call in transaction.calls)
    assert any("app.external_source_revisions" in call[1] for call in transaction.calls)
    assert any("INSERT INTO app.maps" in call[1] for call in transaction.calls)


def test_map_create_locks_and_requires_the_exact_project_basemap_binding() -> None:
    definition = connected_basemap_definition()
    transaction = FakeTransaction(
        one=[("member",), ("editor",), map_row(definition=definition), (1,), (True,)],
        all_rows=[[(BASEMAP_BINDING_ID,)], definition_rows(definition)],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.create_map(
            context(),
            PROJECT_ID,
            MapDraft(name="Connected basemap", description=None, definition=definition),
            "request-connected-basemap",
        )
    )

    assert result.definition == definition
    binding_query = next(
        call for call in transaction.calls if "app.project_basemap_connection_bindings" in call[1]
    )
    assert "binding.organization_id = %s" in binding_query[1]
    assert "binding.project_id = %s" in binding_query[1]
    assert "FOR KEY SHARE OF binding" in binding_query[1]


def test_map_create_requires_linked_exact_regional_basemap_source_revision() -> None:
    definition = governed_regional_basemap_definition()
    database_configuration = {
        "min_zoom": 2,
        "max_zoom": 18,
        "tile_size": 256,
        "scheme": "tms",
        "attribution": "Example mapping agency",
        "presentation_role": "regional_basemap",
        "license": "CC-BY-4.0",
        "coverage_bounds": [80, 26, 89, 31],
        "coordinate_behavior": "wgs84_web_mercator",
    }
    transaction = FakeTransaction(
        one=[("member",), ("editor",), map_row(definition=definition), (1,), (True,)],
        all_rows=[
            [(DATASET_ID,)],
            [
                (
                    DATASET_ID,
                    3,
                    "xyz",
                    "https://tiles.example.test/{z}/{x}/{y}.png",
                    database_configuration,
                )
            ],
            definition_rows(definition),
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.create_map(
            context(),
            PROJECT_ID,
            MapDraft(name="Regional atlas", description=None, definition=definition),
            "request-regional-basemap",
        )
    )

    assert result.definition == definition
    assert any("app.project_datasets" in call[1] for call in transaction.calls)
    assert any("app.external_source_revisions" in call[1] for call in transaction.calls)


def test_map_create_rejects_an_unlinked_basemap_binding_before_write() -> None:
    definition = connected_basemap_definition()
    transaction = FakeTransaction(one=[("member",), ("editor",)], all_rows=[[]])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.create_map(
                context(),
                PROJECT_ID,
                MapDraft(name="Forged basemap", description=None, definition=definition),
                "request-forged-basemap",
            )
        )

    assert caught.value.code == "map_basemap_connection_not_linked"
    assert all("INSERT INTO app.maps" not in call[1] for call in transaction.calls)


def test_map_create_rejects_dataset_not_linked_to_project_before_write() -> None:
    definition = governed_xyz_definition()
    transaction = FakeTransaction(one=[("member",), ("editor",)], all_rows=[[]])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.create_map(
                context(),
                PROJECT_ID,
                MapDraft(name="Unlinked", description=None, definition=definition),
                "request-unlinked-map",
            )
        )

    assert caught.value.code == "map_dataset_not_linked"
    assert all("INSERT INTO app.maps" not in call[1] for call in transaction.calls)


def test_map_definition_rejects_a_forged_exact_dataset_version() -> None:
    transaction = FakeTransaction(
        all_rows=[[(DATASET_ID,)], []],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository._require_map_definition_references(
                transaction,
                context(),
                PROJECT_ID,
                governed_dataset_definition(),
            )
        )

    assert caught.value.code == "map_dataset_version_invalid"
    assert any("JOIN app.dataset_versions" in call[1] for call in transaction.calls)


def test_map_definition_accepts_the_linked_exact_dataset_version() -> None:
    transaction = FakeTransaction(
        all_rows=[
            [(DATASET_ID,)],
            [(DATASET_ID, DATASET_VERSION_ID, 3)],
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    asyncio.run(
        repository._require_map_definition_references(
            transaction,
            context(),
            PROJECT_ID,
            governed_dataset_definition(),
        )
    )

    version_query = next(
        call for call in transaction.calls if "JOIN app.dataset_versions" in call[1]
    )
    assert version_query[2][1] == ORG_ID
    assert "version.state = 'active'::app.dataset_version_state" in version_query[1]
    assert "FOR KEY SHARE" not in version_query[1]
    assert any("FOR KEY SHARE OF project_dataset" in call[1] for call in transaction.calls)


def test_map_create_rejects_changed_external_source_snapshot_before_write() -> None:
    definition = governed_xyz_definition(source_url="https://attacker.example/{z}/{x}/{y}.png")
    transaction = FakeTransaction(
        one=[("member",), ("editor",)],
        all_rows=[
            [(DATASET_ID,)],
            [
                (
                    DATASET_ID,
                    2,
                    "xyz",
                    "https://tiles.example.test/{z}/{x}/{y}.png",
                    {
                        "min_zoom": 0,
                        "max_zoom": 18,
                        "tile_size": 256,
                        "scheme": "xyz",
                        "attribution": "Example",
                    },
                )
            ],
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.create_map(
                context(),
                PROJECT_ID,
                MapDraft(name="Changed source", description=None, definition=definition),
                "request-changed-source",
            )
        )

    assert caught.value.code == "map_source_revision_invalid"
    assert all("INSERT INTO app.maps" not in call[1] for call in transaction.calls)


def test_map_update_rejects_new_unlinked_dataset_before_write() -> None:
    definition = governed_xyz_definition()
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row()],
        all_rows=[definition_rows(), []],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.update_map(
                context(),
                PROJECT_ID,
                MAP_ID,
                1,
                {"definition": definition},
                "Add roads",
                "request-unlinked-update",
            )
        )

    assert caught.value.code == "map_dataset_not_linked"
    assert all("UPDATE app.maps" not in call[1] for call in transaction.calls)


def test_map_duplicate_rechecks_source_dataset_links_before_write() -> None:
    definition = governed_xyz_definition()
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(definition=definition)],
        all_rows=[definition_rows(definition), []],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.duplicate_map(
                context(),
                PROJECT_ID,
                MAP_ID,
                "Road map copy",
                "request-unlinked-duplicate",
            )
        )

    assert caught.value.code == "map_dataset_not_linked"
    assert all("INSERT INTO app.maps" not in call[1] for call in transaction.calls)


def test_map_duplicate_requires_legacy_definition_to_be_upgraded_first() -> None:
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row()],
        all_rows=[definition_rows()],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.duplicate_map(
                context(),
                PROJECT_ID,
                MAP_ID,
                "Legacy map copy",
                "request-legacy-duplicate",
            )
        )

    assert caught.value.code == "map_definition_invalid"
    assert all("INSERT INTO app.maps" not in call[1] for call in transaction.calls)


def test_stale_map_update_fails_before_mutation_or_activity() -> None:
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(version=3)],
        all_rows=[definition_rows()],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.update_map(
                context(),
                PROJECT_ID,
                MAP_ID,
                2,
                {"name": "Stale"},
                None,
                "request-stale",
            )
        )

    assert caught.value.code == "map_version_conflict"
    assert caught.value.current_version == 3
    assert all("UPDATE app.maps" not in call[1] for call in transaction.calls)
    assert all(call[0] != "execute" for call in transaction.calls)


def test_map_update_uses_compare_and_swap_then_versions_and_audits() -> None:
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(), map_row(version=2, name="Renamed")],
        all_rows=[definition_rows(), definition_rows()],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.update_map(
            context(),
            PROJECT_ID,
            MAP_ID,
            1,
            {"name": "Renamed"},
            "Rename map",
            "request-update",
        )
    )

    assert result.version == 2
    update = next(call for call in transaction.calls if "UPDATE app.maps" in call[1])
    assert "version = version + 1" in update[1]
    assert "AND version = %s" in update[1]
    assert update[2][-1] == 1
    assert "INSERT INTO app.map_versions" in transaction.calls[-2][1]
    assert "INSERT INTO app.activity_events" in transaction.calls[-1][1]


@pytest.mark.parametrize("status", ["archived", "active"])
def test_map_status_update_casts_data_api_enum_and_preserves_definition(status: str) -> None:
    definition = governed_xyz_definition()
    before = list(map_row(version=2, definition=definition))
    before[4] = "active" if status == "archived" else "archived"
    after = list(map_row(version=3, definition=definition))
    after[4] = status
    transaction = FakeTransaction(
        one=[("member",), ("owner",), tuple(before), tuple(after)],
        all_rows=[definition_rows(definition), definition_rows(definition)],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.update_map(
            context(),
            PROJECT_ID,
            MAP_ID,
            2,
            {"status": status},
            "Change visibility in the directory",
            "request-status-update",
        )
    )

    update = next(call for call in transaction.calls if "UPDATE app.maps" in call[1])
    sql, bindings = compile_data_api_statement(update[1], update[2])
    assert "status = CAST(:p0 AS app.record_status)" in sql
    assert bindings[0] == {"name": "p0", "value": {"stringValue": status}}
    assert "AND version = :p5" in sql
    assert bindings[-1] == {"name": "p5", "value": {"longValue": 2}}
    assert "definition =" not in sql
    assert result.status == status
    assert result.version == 3
    assert result.definition == definition
    assert "INSERT INTO app.map_versions" in transaction.calls[-2][1]
    event = transaction.calls[-1]
    assert "INSERT INTO app.activity_events" in event[1]
    assert ("map.archived" if status == "archived" else "map.updated") in event[2]


def test_racing_map_update_reports_the_latest_committed_version() -> None:
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(), None, (2,)],
        all_rows=[definition_rows()],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceConflict) as caught:
        asyncio.run(
            repository.update_map(
                context(),
                PROJECT_ID,
                MAP_ID,
                1,
                {"name": "Lost race"},
                None,
                "request-race",
            )
        )

    assert caught.value.current_version == 2
    assert all(call[0] != "execute" for call in transaction.calls)


def test_unauthorized_project_is_hidden_before_map_query() -> None:
    transaction = FakeTransaction(one=[("guest",), (None,)])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceNotFound) as caught:
        asyncio.run(repository.get_map(context(), PROJECT_ID, MAP_ID))

    assert caught.value.resource == "map"
    assert len(transaction.calls) == 2


def test_composition_history_is_authorized_and_cursor_bounded() -> None:
    definition = {"layers": [], "bookmarks": []}
    size = len(definition_bytes(definition))
    transaction = FakeTransaction(
        one=[(PROJECT_ID,), ("member",), ("viewer",)],
        all_rows=[[(3, size, "Newest", USER_ID, NOW), (2, size, "Earlier", USER_ID, NOW)]],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(repository.list_composition_versions(context(), MAP_ID, 2, 4))

    assert [item.version for item in result] == [3, 2]
    assert result[0].change_message == "Newest"
    query = transaction.calls[-1]
    assert "FROM app.map_versions history" in query[1]
    assert "history.version < %s::bigint" in query[1]
    assert query[2] == (ORG_ID, MAP_ID, 4, 4, 2)
    assert transaction.calls[0][2] == (ORG_ID, MAP_ID)


def test_composition_history_hides_revoked_reader_before_version_query() -> None:
    transaction = FakeTransaction(one=[(PROJECT_ID,), ("member",), (None,)])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceNotFound) as caught:
        asyncio.run(repository.list_composition_versions(context(), MAP_ID, 50, None))

    assert caught.value.resource == "composition"
    assert len(transaction.calls) == 3


def test_exact_composition_version_reassembles_large_retained_definition() -> None:
    definition = {"layers": [{"id": "roads", "style": "x" * 70_000}], "bookmarks": []}
    encoded = definition_bytes(definition)
    chunks = [(index, chunk) for _, index, chunk in definition_rows(definition)]
    transaction = FakeTransaction(
        one=[
            (PROJECT_ID,),
            ("member",),
            ("viewer",),
            (2, len(encoded), "Saved scene", USER_ID, NOW),
        ],
        all_rows=[chunks],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(repository.get_composition_version(context(), MAP_ID, 2))

    assert result.summary.version == 2
    assert result.definition == definition
    assert len(encoded) > 65_536
    chunk_query = transaction.calls[-1]
    assert "convert_to(history.definition::text, 'UTF8')" in chunk_query[1]
    assert chunk_query[2] == (24_576, 24_576, 24_576, ORG_ID, MAP_ID, 2)
    assert all(len(chunk) <= 24_576 for _, chunk in chunks)


def test_large_map_definition_is_reassembled_from_bounded_rows() -> None:
    definition = {
        "layers": [{"id": "roads", "style": "x" * 70_000}],
        "bookmarks": [],
    }
    encoded = definition_bytes(definition)
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(definition=definition)],
        all_rows=[definition_rows(definition)],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(repository.get_map(context(), PROJECT_ID, MAP_ID))

    assert result.definition == definition
    chunk_query = transaction.calls[-1]
    assert chunk_query[0] == "all"
    assert "convert_to(map.definition::text, 'UTF8')" in chunk_query[1]
    assert chunk_query[1].count("%s::integer") == 3
    assert chunk_query[2][0:3] == (24_576, 24_576, 24_576)
    assert max(len(row[2]) for row in definition_rows(definition)) <= 24_576
    metadata_query = transaction.calls[-2][1]
    assert "octet_length(definition::text)" in metadata_query
    assert " status::text, definition," not in metadata_query
    assert len(encoded) > 65_536


def test_map_definition_chunks_fail_closed_when_incomplete() -> None:
    definition = {"value": "x" * 30_000}
    chunks = definition_rows(definition)
    transaction = FakeTransaction(
        one=[("member",), ("owner",), map_row(definition=definition)],
        all_rows=[chunks[:-1]],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    with pytest.raises(WorkspaceStoreUnavailable, match="incomplete"):
        asyncio.run(repository.get_map(context(), PROJECT_ID, MAP_ID))


def test_map_write_never_returns_the_definition_as_one_row() -> None:
    definition = current_empty_definition(extensions={"padding": "x" * 70_000})
    transaction = FakeTransaction(
        one=[("member",), ("editor",), map_row(definition=definition), (1,), (True,)],
        all_rows=[definition_rows(definition)],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(
        repository.create_map(
            context(),
            PROJECT_ID,
            MapDraft(name="Large map", description=None, definition=definition),
            "request-large-map",
        )
    )

    insert = next(call for call in transaction.calls if "INSERT INTO app.maps" in call[1])
    assert "RETURNING id, project_id, name" in insert[1]
    assert "octet_length(definition::text)" in insert[1]
    assert "status::text, definition" not in insert[1]
    assert result.definition == definition


def test_map_list_batches_small_definitions_in_one_bounded_query() -> None:
    other_map_id = UUID("60000000-0000-4000-8000-000000000002")
    first_definition = {"layers": [{"id": "roads"}]}
    second_definition = {"layers": [{"id": "water"}]}
    first_row = map_row(name="Roads", definition=first_definition)
    second_row = (
        other_map_id,
        *map_row(name="Water", definition=second_definition)[1:],
    )
    second_chunks = [
        (other_map_id, index, chunk) for _, index, chunk in definition_rows(second_definition)
    ]
    transaction = FakeTransaction(
        one=[("member",), ("owner",)],
        all_rows=[
            [first_row, second_row],
            [*definition_rows(first_definition), *second_chunks],
        ],
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))

    result = asyncio.run(repository.list_maps(context(), PROJECT_ID, Page()))

    assert [record.definition for record in result] == [first_definition, second_definition]
    chunk_calls = [call for call in transaction.calls if "jsonb_array_elements_text" in call[1]]
    assert len(chunk_calls) == 1
    requested_ids = chunk_calls[0][2][-1]
    assert requested_ids.obj == [str(MAP_ID), str(other_map_id)]


@pytest.mark.parametrize(
    "roles,style_row,allowed",
    [
        (("member", "viewer", None, False), (DATASET_VERSION_ID,), True),
        (("member", None, "view", False), (DATASET_VERSION_ID,), True),
        (("member", None, None, False), None, False),
        (("member", "viewer", None, False), None, False),
    ],
)
def test_map_style_binding_requires_access_and_exact_dataset_revision_match(
    roles, style_row, allowed
) -> None:
    document = governed_dataset_definition()
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    document["layers"][0]["styleReference"] = {
        "projectId": "50000000-0000-4000-8000-000000000002",
        "resourceId": "a0000000-0000-4000-8000-000000000002",
        "styleId": "d0000000-0000-4000-8000-000000000002",
        "versionNumber": 2,
        "checksumSha256": "a" * 64,
        "format": "maplibre",
    }
    transaction = FakeTransaction(
        one=[roles, style_row], all_rows=[[(DATASET_ID,)], [(DATASET_ID, DATASET_VERSION_ID, 3)]]
    )
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))
    operation = repository._require_map_definition_references(
        transaction, context(), PROJECT_ID, document
    )
    if allowed:
        asyncio.run(operation)
        query = next(call for call in transaction.calls if "SELECT version.id" in call[1])
        assert query[2] == (
            ORG_ID,
            UUID("50000000-0000-4000-8000-000000000002"),
            UUID("a0000000-0000-4000-8000-000000000002"),
            UUID("d0000000-0000-4000-8000-000000000002"),
            2,
            "a" * 64,
            "maplibre",
            DATASET_ID,
        )
        assert "resource.dataset_id = %s" in query[1]
        assert "current_version_id" not in query[1]
    else:
        with pytest.raises(WorkspaceConflict) as error:
            asyncio.run(operation)
        assert error.value.code == "map_style_reference_unavailable"
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_composition_identity_hides_unreadable_container_before_loading_definition() -> None:
    transaction = FakeTransaction(one=[(PROJECT_ID,), ("member",), (None,)])
    repository = PostgresWorkspaceRepository(FakeExecutor(transaction))
    with pytest.raises(WorkspaceNotFound) as caught:
        asyncio.run(repository.get_composition(context(), MAP_ID))
    assert caught.value.resource == "composition"
    assert len(transaction.calls) == 3
    assert transaction.calls[0][2] == (context().organization_id, MAP_ID)
    assert all(call[0] != "execute" for call in transaction.calls)


def test_composition_list_uses_exact_governed_owner_with_current_account_authority() -> None:
    owner_id = UUID("20000000-0000-4000-8000-000000000002")
    transaction = FakeTransaction(
        all_rows=[[
            (MAP_ID, PROJECT_ID, "Shared access", "Analysis", None, "active", 2, NOW, owner_id),
            (MAP_ID, PROJECT_ID, "Shared access", "Unbound", None, "active", 1, NOW, None),
        ]]
    )
    executor = FakeExecutor(transaction)
    result = asyncio.run(
        PostgresWorkspaceRepository(executor).list_compositions(context(), Page(25, 0), "", None)
    )

    assert [item.owner_user_id for item in result] == [owner_id, None]
    assert executor.contexts == [context()]
    query = transaction.calls[0]
    assert "LEFT JOIN app.governed_resources resource" in query[1]
    assert "resource.organization_id = map.organization_id" in query[1]
    assert "resource.project_id = map.project_id AND resource.map_id = map.id" in query[1]
    assert "resource.kind = 'map'" in query[1]
    assert "membership.role::text = 'admin'" in query[1]
    assert "app.effective_project_role(project.id, membership.user_id) IS NOT NULL" in query[1]
    assert "WHERE map.organization_id = %s" in query[1]
    assert query[2] == (USER_ID, ORG_ID, None, None, "", "", 25, 0)
    assert "created_by" not in query[1]
    assert len(transaction.calls) == 1


@pytest.mark.parametrize("owner_id", [UUID("20000000-0000-4000-8000-000000000002"), None])
def test_composition_get_reads_exact_governed_owner_after_current_permission(owner_id) -> None:
    transaction = FakeTransaction(
        one=[(PROJECT_ID,), ("member",), ("viewer",), (*map_row(), owner_id)],
        all_rows=[definition_rows()],
    )
    executor = FakeExecutor(transaction)
    result = asyncio.run(PostgresWorkspaceRepository(executor).get_composition(context(), MAP_ID))

    assert result.owner_user_id == owner_id
    assert result.map_id == MAP_ID
    assert result.project_id == PROJECT_ID
    assert executor.contexts == [context()]
    query = transaction.calls[3]
    assert "SELECT resource.owner_user_id FROM app.governed_resources resource" in query[1]
    assert "resource.organization_id = app.maps.organization_id" in query[1]
    assert "resource.project_id = app.maps.project_id" in query[1]
    assert "resource.map_id = app.maps.id AND resource.kind = 'map'" in query[1]
    assert query[2] == (ORG_ID, PROJECT_ID, MAP_ID)
    assert "created_by" not in query[1]
    assert all(call[0] != "execute" for call in transaction.calls)
