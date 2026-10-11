import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import anyio.to_thread
import pytest
from fastapi import FastAPI

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.teams import ProjectTeamGrant, Team, TeamConflict, TeamMember
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000050")
MEMBER_ID = UUID("20000000-0000-4000-8000-000000000052")
ORG_ID = UUID("10000000-0000-4000-8000-000000000050")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000059")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000050")
TEAM_ID = UUID("90000000-0000-4000-8000-000000000050")
GRANT_ID = UUID("91000000-0000-4000-8000-000000000050")
NOW = datetime(2026, 8, 24, 15, tzinfo=UTC)


@pytest.fixture(autouse=True)
def inline_threadpool(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_sync(function, *args, **kwargs):
        del kwargs
        return function(*args)

    monkeypatch.setattr(anyio.to_thread, "run_sync", run_sync)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="admin@example.test",
            display_name="Admin",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


def team() -> Team:
    return Team(TEAM_ID, "Research team", "Shared research", "active", "owner", NOW, NOW)


def member() -> TeamMember:
    return TeamMember(MEMBER_ID, "member@example.test", "Member", "member", NOW, NOW)


def grant() -> ProjectTeamGrant:
    return ProjectTeamGrant(GRANT_ID, PROJECT_ID, TEAM_ID, "Research team", "editor", NOW, NOW)


class FakeTeamRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_teams(self, context):
        self.calls.append(("list_teams", context))
        return [team()]

    async def create_team(self, context, name, description, request_id):
        self.calls.append(("create_team", context, name, description, request_id))
        return team()

    async def list_members(self, context, team_id):
        self.calls.append(("list_members", context, team_id))
        return [member()]

    async def add_member(self, context, team_id, user_id, role, request_id):
        self.calls.append(("add_member", context, team_id, user_id, role, request_id))
        return member()

    async def update_member(self, context, team_id, user_id, role, request_id):
        self.calls.append(("update_member", context, team_id, user_id, role, request_id))
        return member()

    async def remove_member(self, context, team_id, user_id, request_id):
        self.calls.append(("remove_member", context, team_id, user_id, request_id))

    async def list_project_grants(self, context, project_id):
        self.calls.append(("list_grants", context, project_id))
        return [grant()]

    async def create_project_grant(self, context, project_id, team_id, role, request_id):
        self.calls.append(("create_grant", context, project_id, team_id, role, request_id))
        return grant()

    async def update_project_grant(self, context, project_id, team_id, role, request_id):
        self.calls.append(("update_grant", context, project_id, team_id, role, request_id))
        return grant()

    async def remove_project_grant(self, context, project_id, team_id, request_id):
        self.calls.append(("remove_grant", context, project_id, team_id, request_id))


class ConflictingTeamRepository(FakeTeamRepository):
    async def create_project_grant(self, *args, **kwargs):
        del args, kwargs
        raise TeamConflict("project_team_grant_exists")


def api_app(repository: FakeTeamRepository) -> FastAPI:
    return create_app(
        settings=Settings(env="test", expose_docs=True),
        readiness_probe=PassingProbe(),
        token_verifier=FakeVerifier(),
        principal_repository=FakePrincipalRepository(),
        team_repository=repository,
    )


@dataclass(frozen=True)
class AsgiResponse:
    status_code: int
    content: bytes

    @property
    def text(self) -> str:
        return self.content.decode()

    def json(self):
        return json.loads(self.content)


def request(
    app: FastAPI,
    method: str,
    path: str,
    *,
    request_headers: dict[str, str] | None = None,
    json_body: dict | None = None,
) -> AsgiResponse:
    body = b"" if json_body is None else json.dumps(json_body).encode()
    headers = list((request_headers or {}).items())
    if json_body is not None:
        headers.extend([("content-type", "application/json"), ("content-length", str(len(body)))])

    async def invoke() -> AsgiResponse:
        incoming = [{"type": "http.request", "body": body, "more_body": False}]
        outgoing = []

        async def receive():
            return incoming.pop(0) if incoming else {"type": "http.disconnect"}

        async def send(message):
            outgoing.append(message)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": [(key.lower().encode(), value.encode()) for key, value in headers],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        start = next(item for item in outgoing if item["type"] == "http.response.start")
        content = b"".join(
            item.get("body", b"") for item in outgoing if item["type"] == "http.response.body"
        )
        return AsgiResponse(start["status"], content)

    return asyncio.run(invoke())


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-team-50",
    }


def test_team_creation_is_tenant_scoped_and_normalized() -> None:
    repository = FakeTeamRepository()
    response = request(
        api_app(repository),
        "POST",
        "/teams",
        request_headers=headers(),
        json_body={"name": " Research team ", "description": " Shared research "},
    )

    assert response.status_code == 201
    assert response.json()["caller_role"] == "owner"
    assert repository.calls == [
        (
            "create_team",
            TenantContext(USER_ID, ORG_ID),
            "Research team",
            "Shared research",
            "request-team-50",
        )
    ]


def test_team_membership_and_project_grant_are_separate_routes() -> None:
    repository = FakeTeamRepository()
    app = api_app(repository)
    added = request(
        app,
        "POST",
        f"/teams/{TEAM_ID}/members",
        request_headers=headers(),
        json_body={"user_id": str(MEMBER_ID), "role": "member"},
    )
    granted = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/team-grants",
        request_headers=headers(),
        json_body={"team_id": str(TEAM_ID), "role": "editor"},
    )

    assert added.status_code == 201
    assert granted.status_code == 201
    assert granted.json()["team_name"] == "Research team"
    assert [call[0] for call in repository.calls] == ["add_member", "create_grant"]


def test_invalid_roles_and_forged_tenant_are_rejected_before_repository_calls() -> None:
    repository = FakeTeamRepository()
    app = api_app(repository)
    invalid = request(
        app,
        "POST",
        f"/teams/{TEAM_ID}/members",
        request_headers=headers(),
        json_body={"user_id": str(MEMBER_ID), "role": "project_owner"},
    )
    forged = request(app, "GET", "/teams", request_headers=headers(OTHER_ORG_ID))

    assert invalid.status_code == 422
    assert forged.status_code == 403
    assert repository.calls == []


def test_team_conflict_is_machine_readable_and_sanitized() -> None:
    response = request(
        api_app(ConflictingTeamRepository()),
        "POST",
        f"/projects/{PROJECT_ID}/team-grants",
        request_headers=headers(),
        json_body={"team_id": str(TEAM_ID), "role": "editor"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "project_team_grant_exists"}}


def test_openapi_exposes_team_and_project_grant_contracts() -> None:
    paths = request(api_app(FakeTeamRepository()), "GET", "/openapi.json").json()["paths"]

    assert {
        "/teams",
        "/teams/{team_id}/members",
        "/teams/{team_id}/members/{user_id}",
        "/projects/{project_id}/team-grants",
        "/projects/{project_id}/team-grants/{team_id}",
    } <= set(paths)
