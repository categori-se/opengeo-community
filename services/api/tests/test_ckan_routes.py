from dataclasses import replace
from types import SimpleNamespace

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
from opengeo_api.auth_routes import current_session
from opengeo_api.ckan import CkanClient
from opengeo_api.config import Settings
from opengeo_api.resources import (
    MetadataResourceImportResult,
    ResourceConflict,
    ResourceStoreUnavailable,
)
from opengeo_api.workspaces import WorkspaceAccessDenied
from test_ckan import URL, Fetcher, envelope, package
from test_resource_routes import ORG_ID, PROJECT_ID, USER_ID, resource


class Workspace:
    def __init__(self, role="editor"):
        self.role = role

    async def get_project(self, context, project_id):
        assert context.organization_id == ORG_ID and project_id == PROJECT_ID
        if self.role is None:
            raise WorkspaceAccessDenied()
        return SimpleNamespace(caller_role=self.role)


class Repository:
    def __init__(self):
        self.plans = []
        self.existing = {}

    async def import_metadata_resource(self, context, project_id, plan, request_id):
        assert context.organization_id == ORG_ID and project_id == PROJECT_ID
        self.plans.append(plan)
        previous = self.existing.get(plan.source_identifier)
        if previous and previous != plan.source_sha256:
            raise ResourceConflict("metadata_source_identifier_collision")
        self.existing[plan.source_identifier] = plan.source_sha256
        source = SimpleNamespace(conversion_report=plan.conversion_report)
        record = resource(kind="dataset")
        record = replace(record, summary=replace(record.summary, title=plan.draft.metadata.title))
        return MetadataResourceImportResult(record, source, previous is not None)


def client(fetcher, *, role="editor", authenticated=True, repository=None):
    repository = repository or Repository()
    app = create_app(
        settings=Settings(), workspace_repository=Workspace(role), resource_repository=repository
    )
    app.state.ckan_client = CkanClient(fetcher)
    if authenticated:
        membership = OrganizationMembership(ORG_ID, "member")
        session = AuthSession(
            Principal(USER_ID, "subject", "user@example.org", "User", (membership,)), membership
        )
        app.dependency_overrides[current_session] = lambda: session
    return TestClient(app), repository


def test_search_inspect_import_reuse_and_stale_snapshot_denial():
    source = package()
    fetcher = Fetcher(
        envelope({"count": 1, "results": [source]}),
        envelope(source),
        envelope(source),
        envelope(source),
        envelope(package(notes="changed")),
    )
    api, repository = client(fetcher)
    path = f"/projects/{PROJECT_ID}/ckan"
    assert api.post(path + "/search", json={"source_url": URL}).status_code == 200
    inspected = api.post(path + "/inspect", json={"source_url": URL, "dataset_id": source["id"]})
    assert inspected.status_code == 200
    payload = {
        "source_url": URL,
        "dataset_id": source["id"],
        "package_sha256": inspected.json()["package_sha256"],
    }
    first = api.post(path + "/import", json=payload)
    second = api.post(path + "/import", json=payload)
    assert first.status_code == second.status_code == 201
    assert first.json()["idempotent"] is False and second.json()["idempotent"] is True
    changed = api.post(path + "/import", json=payload)
    assert (
        changed.status_code == 409 and changed.json()["detail"]["code"] == "ckan_snapshot_changed"
    )
    assert len(repository.plans) == 2
    assert len(fetcher.calls) == 5


def test_no_network_or_writes_before_authentication_and_workspace_authority():
    for role, authenticated, expected in [(None, True, 403), ("editor", False, 401)]:
        fetcher = Fetcher()
        api, repository = client(fetcher, role=role, authenticated=authenticated)
        response = api.post(f"/projects/{PROJECT_ID}/ckan/search", json={"source_url": URL})
        assert response.status_code == expected
        assert not fetcher.calls and not repository.plans
    fetcher = Fetcher()
    api, repository = client(fetcher, role="viewer")
    response = api.post(
        f"/projects/{PROJECT_ID}/ckan/import",
        json={
            "source_url": URL,
            "dataset_id": "dataset-1",
            "package_sha256": "a" * 64,
        },
    )
    assert response.status_code == 403 and not fetcher.calls and not repository.plans


def test_datastore_preview_checks_package_membership_before_read():
    fetcher = Fetcher(envelope(package()))
    api, repository = client(fetcher)
    response = api.post(
        f"/projects/{PROJECT_ID}/ckan/preview",
        json={
            "source_url": URL,
            "dataset_id": "dataset-1",
            "resource_id": "another-resource",
        },
    )
    assert response.status_code == 422 and len(fetcher.calls) == 1 and not repository.plans


def test_bulk_registration_reports_committed_rows_and_stops_on_shared_failure():
    class FailingRepository(Repository):
        async def import_metadata_resource(self, *args):
            if len(self.plans) == 1:
                raise ResourceStoreUnavailable()
            return await super().import_metadata_resource(*args)

    fetcher = Fetcher()
    api, repository = client(fetcher, repository=FailingRepository())
    response = api.post(
        f"/projects/{PROJECT_ID}/ckan/imports",
        json={
            "source_url": URL,
            "packages": [package(id=f"dataset-{i}") for i in range(1, 4)],
        },
    )
    assert response.status_code == 200
    assert response.json()["counts"] == {"created": 1, "reused": 0, "unresolved": 2}
    assert response.json()["outcomes"][2]["error"] == "batch_stopped"
    assert len(repository.plans) == 1 and not fetcher.calls


def test_bulk_duplicate_and_unknown_credentials_reject_before_write():
    api, repository = client(Fetcher())
    response = api.post(
        f"/projects/{PROJECT_ID}/ckan/imports",
        json={
            "source_url": URL,
            "packages": [package(), package()],
        },
    )
    assert response.status_code == 422 and not repository.plans
    response = api.post(
        f"/projects/{PROJECT_ID}/ckan/search",
        json={
            "source_url": URL,
            "api_token": "must-never-be-echoed",
        },
    )
    assert response.status_code == 422 and "must-never-be-echoed" not in response.text
