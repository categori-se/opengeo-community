from datetime import UTC, datetime
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspaces import (
    Client,
    CompositionSummary,
    MapRecord,
    MapVersionRecord,
    MapVersionSummary,
    Project,
    RecentProject,
    WorkspaceAccessDenied,
    WorkspaceConflict,
    WorkspaceStoreUnavailable,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000002")
CLIENT_ID = UUID("30000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
MAP_ID = UUID("60000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 18, 12, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken(
            subject="subject-123",
            client_id="client-123",
            username="ada",
            scopes=(),
            groups=(),
        )


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject-123"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="ada@example.test",
            display_name="Ada",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


class FakeWorkspaceRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def create_client(self, context, draft, request_id):
        self.calls.append(("create_client", context, draft, request_id))
        return Client(
            client_id=CLIENT_ID,
            name=draft.name,
            client_code=draft.client_code,
            description=draft.description,
            status="active",
            created_at=NOW,
            updated_at=NOW,
        )

    async def list_recent_projects(self, context, page):
        self.calls.append(("list_recent_projects", context, page))
        return [
            RecentProject(
                project=Project(
                    project_id=PROJECT_ID,
                    client_id=CLIENT_ID,
                    name="Atlas",
                    project_code="ATLAS",
                    description="Project",
                    status="active",
                    created_at=NOW,
                    updated_at=NOW,
                    caller_role="owner",
                ),
                last_activity_at=NOW,
                last_event_type="map.updated",
            )
        ]

    async def update_project(self, context, project_id, changes, request_id):
        self.calls.append(("update_project", context, project_id, changes, request_id))
        return Project(
            project_id=project_id,
            client_id=CLIENT_ID,
            name="Atlas",
            project_code="ATLAS",
            description="Project",
            status="active",
            created_at=NOW,
            updated_at=NOW,
            caller_role="owner",
            visibility=changes.get("visibility", "internal"),
            published_at=NOW if changes.get("visibility") == "published" else None,
            published_by=USER_ID if changes.get("visibility") == "published" else None,
        )

    async def update_map(
        self,
        context,
        project_id,
        map_id,
        expected_version,
        changes,
        change_message,
        request_id,
    ):
        self.calls.append(
            (
                "update_map",
                context,
                project_id,
                map_id,
                expected_version,
                changes,
                change_message,
                request_id,
            )
        )
        return MapRecord(
            map_id=MAP_ID,
            project_id=PROJECT_ID,
            name=str(changes.get("name", "Atlas map")),
            description=None,
            status="active",
            definition={"layers": []},
            version=expected_version + 1,
            created_at=NOW,
            updated_at=NOW,
        )


class ConflictingWorkspaceRepository(FakeWorkspaceRepository):
    async def update_map(self, *args, **kwargs):
        del args, kwargs
        raise WorkspaceConflict("map_version_conflict", 7)


class DenyingWorkspaceRepository(FakeWorkspaceRepository):
    async def create_client(self, *args, **kwargs):
        del args, kwargs
        raise WorkspaceAccessDenied("private role reason")


class FailingWorkspaceRepository(FakeWorkspaceRepository):
    async def create_client(self, *args, **kwargs):
        del args, kwargs
        raise WorkspaceStoreUnavailable("password=must-not-leak")


def api_client(repository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            workspace_repository=repository,
        )
    )


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-route-123",
    }


def test_project_listing_search_is_bounded_before_pagination_and_keeps_default_calls() -> None:
    class ListingRepository(FakeWorkspaceRepository):
        async def list_projects(self, context, client_id, page, *filters):
            self.calls.append((context, client_id, page.limit, page.offset, filters))
            return [
                Project(
                    PROJECT_ID,
                    CLIENT_ID,
                    "Later archived workspace",
                    "CODE",
                    "Description",
                    "archived",
                    NOW,
                    NOW,
                    "viewer",
                )
            ]

    repository = ListingRepository()
    client = api_client(repository)
    response = client.get(
        f"/projects?limit=25&offset=100&client_id={CLIENT_ID}&q=%20Later%20&status=archived",
        headers=headers(),
    )
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()[0]["id"] == str(PROJECT_ID)
    assert response.json()[0]["status"] == "archived"
    assert "definition" not in response.json()[0]
    assert repository.calls == [
        (TenantContext(USER_ID, ORG_ID), CLIENT_ID, 25, 100, ("Later", "archived"))
    ]
    assert client.get("/projects?limit=101", headers=headers()).status_code == 422
    assert client.get("/projects?offset=10001", headers=headers()).status_code == 422
    assert client.get("/projects?status=deleted", headers=headers()).status_code == 422
    assert client.get("/projects?q=" + "a" * 201, headers=headers()).status_code == 422
    assert len(repository.calls) == 1
    assert client.get("/projects", headers=headers()).status_code == 200
    assert client.get("/projects?status=all&q=%20%20", headers=headers()).status_code == 200
    assert repository.calls[1:] == [
        (TenantContext(USER_ID, ORG_ID), None, 50, 0, ()),
        (TenantContext(USER_ID, ORG_ID), None, 50, 0, ()),
    ]

    class DefaultOnlyRepository(FakeWorkspaceRepository):
        async def list_projects(self, context, client_id, page):
            self.calls.append((context, client_id, page))
            return []

    default_repository = DefaultOnlyRepository()
    assert api_client(default_repository).get("/projects", headers=headers()).status_code == 200
    assert len(default_repository.calls) == 1


def test_create_client_propagates_verified_tenant_actor_and_request_id() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).post(
        "/clients",
        headers=headers(),
        json={"name": "  Acme  ", "client_code": "ACME", "description": " Client "},
    )

    assert response.status_code == 201
    assert response.json()["id"] == str(CLIENT_ID)
    assert response.json()["name"] == "Acme"
    call = repository.calls[0]
    assert call[1] == TenantContext(user_id=USER_ID, organization_id=ORG_ID)
    assert call[2].description == "Client"
    assert call[3] == "request-route-123"


def test_forged_organization_fails_before_workspace_repository() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).post(
        "/clients",
        headers=headers(OTHER_ORG_ID),
        json={"name": "Denied"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "organization_access_denied"}
    assert repository.calls == []


def test_map_patch_passes_only_changed_fields_and_expected_version() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).patch(
        f"/projects/{PROJECT_ID}/maps/{MAP_ID}",
        headers=headers(),
        json={
            "expected_version": 4,
            "name": " Renamed map ",
            "change_message": " Rename ",
        },
    )

    assert response.status_code == 200
    assert response.json()["version"] == 5
    call = repository.calls[0]
    assert call[4] == 4
    assert call[5] == {"name": "Renamed map"}
    assert call[6] == "Rename"
    assert call[7] == "request-route-123"


def test_recent_projects_expose_bounded_user_activity_without_payloads() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).get(
        "/projects/recent?limit=5",
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()[0]["id"] == str(PROJECT_ID)
    assert response.json()[0]["last_event_type"] == "map.updated"
    assert response.json()[0]["last_activity_at"] == NOW.isoformat().replace("+00:00", "Z")
    assert "payload" not in response.json()[0]
    call = repository.calls[0]
    assert call[0] == "list_recent_projects"
    assert call[1] == TenantContext(user_id=USER_ID, organization_id=ORG_ID)
    assert call[2].limit == 5


def test_project_owner_can_mark_publication_visibility_without_opening_anonymous_reads() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).patch(
        f"/projects/{PROJECT_ID}",
        headers=headers(),
        json={"visibility": "published"},
    )

    assert response.status_code == 200
    assert response.json()["visibility"] == "published"
    assert response.json()["published_by"] == str(USER_ID)
    call = repository.calls[0]
    assert call[:4] == (
        "update_project",
        TenantContext(user_id=USER_ID, organization_id=ORG_ID),
        PROJECT_ID,
        {"visibility": "published"},
    )


def test_map_version_conflict_returns_machine_readable_current_version() -> None:
    response = api_client(ConflictingWorkspaceRepository()).patch(
        f"/projects/{PROJECT_ID}/maps/{MAP_ID}",
        headers=headers(),
        json={"expected_version": 6, "name": "Stale"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "map_version_conflict", "current_version": 7}}


def test_role_denial_and_backend_failure_are_sanitized() -> None:
    denied = api_client(DenyingWorkspaceRepository()).post(
        "/clients",
        headers=headers(),
        json={"name": "Denied"},
    )
    failed = api_client(FailingWorkspaceRepository()).post(
        "/clients",
        headers=headers(),
        json={"name": "Failure"},
    )

    assert denied.status_code == 403
    assert denied.json() == {"detail": "action_forbidden"}
    assert failed.status_code == 503
    assert failed.json() == {"detail": "workspace_store_unavailable"}
    assert "password" not in failed.text


def test_empty_map_patch_and_unknown_fields_are_rejected_before_repository() -> None:
    repository = FakeWorkspaceRepository()
    client = api_client(repository)

    empty = client.patch(
        f"/projects/{PROJECT_ID}/maps/{MAP_ID}",
        headers=headers(),
        json={"expected_version": 1},
    )
    unknown = client.post(
        "/clients",
        headers=headers(),
        json={"name": "Acme", "organization_id": str(OTHER_ORG_ID)},
    )

    assert empty.status_code == 422
    assert unknown.status_code == 422
    assert repository.calls == []


def test_map_definition_size_is_bounded_before_repository() -> None:
    repository = FakeWorkspaceRepository()

    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/maps",
        headers=headers(),
        json={"name": "Huge", "definition": {"value": "x" * 262_144}},
    )

    assert response.status_code == 422
    assert repository.calls == []


def test_versioned_map_definition_rejects_untracked_or_sensitive_layers() -> None:
    repository = FakeWorkspaceRepository()
    client = api_client(repository)
    base = {
        "schemaVersion": "opengeo.map-definition.1.1.0",
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [],
    }

    untracked = client.post(
        f"/projects/{PROJECT_ID}/maps",
        headers=headers(),
        json={
            "name": "Untracked",
            "definition": {
                **base,
                "layers": [
                    {
                        "layerId": "scratch",
                        "datasetId": "scratch",
                        "title": "Scratch",
                        "sourceType": "browser-edit",
                        "visible": True,
                        "opacity": 1,
                        "order": 1,
                        "style": {},
                        "labels": {},
                    }
                ],
            },
        },
    )
    sensitive = client.post(
        f"/projects/{PROJECT_ID}/maps",
        headers=headers(),
        json={"name": "Sensitive", "definition": {**base, "access_token": "secret"}},
    )
    legacy = client.post(
        f"/projects/{PROJECT_ID}/maps",
        headers=headers(),
        json={"name": "Legacy", "definition": {"layers": [], "bookmarks": []}},
    )

    assert untracked.status_code == 422
    assert sensitive.status_code == 422
    assert legacy.status_code == 422
    assert repository.calls == []


def test_request_body_and_collection_page_are_bounded() -> None:
    repository = FakeWorkspaceRepository()
    client = api_client(repository)

    oversized = client.post(
        "/clients",
        headers=headers(),
        content=b"x" * (512 * 1024 + 1),
    )
    invalid_page = client.get(
        "/clients?limit=101&offset=10001",
        headers=headers(),
    )

    assert oversized.status_code == 413
    assert oversized.json() == {"detail": "request_body_too_large"}
    assert oversized.headers["X-Request-ID"] == "request-route-123"
    assert invalid_page.status_code == 422
    assert repository.calls == []


def test_openapi_exposes_the_m1_vertical_slice() -> None:
    document = api_client(FakeWorkspaceRepository()).get("/openapi.json").json()

    assert {
        "/organizations/current/memberships",
        "/clients",
        "/clients/{client_id}",
        "/projects",
        "/projects/recent",
        "/projects/{project_id}",
        "/projects/{project_id}/memberships",
        "/projects/{project_id}/maps",
        "/projects/{project_id}/maps/{map_id}",
        "/projects/{project_id}/maps/{map_id}/duplicate",
    } <= set(document["paths"])


def test_composition_route_separates_authored_identity_from_access_context() -> None:
    class CompositionRepository(FakeWorkspaceRepository):
        async def get_composition(self, context, composition_id):
            self.calls.append((context, composition_id))
            return MapRecord(
                map_id=MAP_ID,
                project_id=PROJECT_ID,
                name="Composition",
                description=None,
                status="active",
                definition={"layers": []},
                version=1,
                created_at=NOW,
                updated_at=NOW,
                owner_user_id=UUID("20000000-0000-4000-8000-000000000002"),
            )

    repository = CompositionRepository()
    response = api_client(repository).get(f"/compositions/{MAP_ID}", headers=headers())
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()["id"] == str(MAP_ID)
    assert response.json()["resource_type"] == "project"
    assert response.json()["access_container_id"] == str(PROJECT_ID)
    assert response.json()["owner_user_id"] == "20000000-0000-4000-8000-000000000002"
    assert "project_id" not in response.json()
    assert repository.calls == [(TenantContext(USER_ID, ORG_ID), MAP_ID)]


def test_composition_history_routes_bound_pages_and_return_exact_definition() -> None:
    class HistoryRepository(FakeWorkspaceRepository):
        async def list_composition_versions(self, context, composition_id, limit, before_version):
            self.calls.append(("list", context, composition_id, limit, before_version))
            return [MapVersionSummary(2, 16, "Saved scene", USER_ID, NOW)]

        async def get_composition_version(self, context, composition_id, version):
            self.calls.append(("get", context, composition_id, version))
            return MapVersionRecord(
                summary=MapVersionSummary(2, 16, "Saved scene", USER_ID, NOW),
                definition={"layers": []},
            )

    repository = HistoryRepository()
    client = api_client(repository)
    listed = client.get(
        f"/compositions/{MAP_ID}/versions?limit=25&before_version=3", headers=headers()
    )
    exact = client.get(f"/compositions/{MAP_ID}/versions/2", headers=headers())

    assert listed.status_code == exact.status_code == 200
    assert listed.headers["Cache-Control"] == exact.headers["Cache-Control"] == "no-store"
    assert listed.json()[0]["version"] == 2
    assert "definition" not in listed.json()[0]
    assert exact.json()["definition"] == {"layers": []}
    assert repository.calls == [
        ("list", TenantContext(USER_ID, ORG_ID), MAP_ID, 25, 3),
        ("get", TenantContext(USER_ID, ORG_ID), MAP_ID, 2),
    ]
    assert (
        client.get(f"/compositions/{MAP_ID}/versions?limit=101", headers=headers()).status_code
        == 422
    )
    assert (
        client.get(
            f"/compositions/{MAP_ID}/versions?before_version=0", headers=headers()
        ).status_code
        == 422
    )
    assert client.get(f"/compositions/{MAP_ID}/versions/0", headers=headers()).status_code == 422
    assert len(repository.calls) == 2


def test_composition_listing_is_bounded_filtered_and_metadata_only() -> None:
    class ListingRepository(FakeWorkspaceRepository):
        async def list_compositions(self, context, page, query, status):
            self.calls.append((context, page.limit, page.offset, query, status))
            return [
                CompositionSummary(
                    MAP_ID, PROJECT_ID, "Shared access", "Analysis", None, "active", 2, NOW,
                    UUID("20000000-0000-4000-8000-000000000002"),
                )
            ]

    repository = ListingRepository()
    client = api_client(repository)
    response = client.get(
        "/compositions?limit=25&offset=50&q=%20Analysis%20&status=all", headers=headers()
    )
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert repository.calls == [(TenantContext(USER_ID, ORG_ID), 25, 50, "Analysis", None)]
    assert response.json()[0]["id"] == str(MAP_ID)
    assert response.json()[0]["access_container_id"] == str(PROJECT_ID)
    assert response.json()[0]["owner_user_id"] == "20000000-0000-4000-8000-000000000002"
    assert "definition" not in response.json()[0]
    assert client.get("/compositions?limit=101", headers=headers()).status_code == 422
    assert client.get("/compositions?status=unknown", headers=headers()).status_code == 422
    assert len(repository.calls) == 1
