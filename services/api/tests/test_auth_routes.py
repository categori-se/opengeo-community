import asyncio
import json
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends, HTTPException
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import (
    AuthSession,
    OrganizationMembership,
    Principal,
    VerifiedAccessToken,
)
from opengeo_api.auth_routes import current_session, principal_for_token
from opengeo_api.auth_tokens import TokenVerificationError
from opengeo_api.config import Settings
from opengeo_api.logging import JsonFormatter
from opengeo_api.principals import PrincipalBackendUnavailable
from opengeo_api.rds_data import RdsDataApiUnavailable
from opengeo_api.session_app import create_session_app

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_A = UUID("10000000-0000-4000-8000-000000000001")
ORG_B = UUID("10000000-0000-4000-8000-000000000002")
ORG_FORGED = UUID("10000000-0000-4000-8000-000000000099")


@pytest.fixture(params=["full", "session"], autouse=True)
def session_factory(request, monkeypatch):
    if request.param == "session":
        monkeypatch.setattr(
            __import__(__name__, fromlist=["client"]),
            "client",
            lambda repository: TestClient(
                create_session_app(Settings(env="test"), FakeVerifier(), repository)
            ),
        )


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        if token != "valid-token":
            raise TokenVerificationError("sensitive verifier reason")
        return VerifiedAccessToken(
            subject="subject-123",
            client_id="client-123",
            username="ada",
            scopes=(),
            groups=(),
        )


class FakeRepository:
    def __init__(self, principal: Principal | None) -> None:
        self.principal = principal
        self.subjects: list[str] = []

    async def resolve(self, subject: str) -> Principal | None:
        self.subjects.append(subject)
        return self.principal


def principal(*memberships: OrganizationMembership) -> Principal:
    return Principal(
        user_id=USER_ID,
        subject="subject-123",
        email="ada@example.test",
        display_name="Ada",
        memberships=tuple(memberships),
    )


def client(repository: FakeRepository) -> TestClient:
    app = create_app(
        Settings(env="test"),
        PassingProbe(),
        FakeVerifier(),
        repository,
    )
    return TestClient(app)


def auth_headers(organization_id: UUID | None = None) -> dict[str, str]:
    headers = {"Authorization": "Bearer valid-token"}
    if organization_id is not None:
        headers["X-OpenGeo-Organization"] = str(organization_id)
    return headers


def test_session_requires_bearer_token() -> None:
    response = client(FakeRepository(principal())).get("/auth/session")

    assert response.status_code == 401
    assert response.json() == {"detail": "invalid_token"}
    assert response.headers["WWW-Authenticate"] == 'Bearer error="invalid_token"'


def test_invalid_token_response_does_not_leak_verifier_reason() -> None:
    response = client(FakeRepository(principal())).get(
        "/auth/session",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401
    assert "sensitive" not in response.text


def test_single_membership_is_selected_from_database() -> None:
    repository = FakeRepository(principal(OrganizationMembership(ORG_A, "admin")))

    response = client(repository).get("/auth/session", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["selected_organization_id"] == str(ORG_A)
    assert response.json()["selected_organization_role"] == "admin"
    assert repository.subjects == ["subject-123"]


def test_multiple_memberships_require_an_explicit_selection() -> None:
    repository = FakeRepository(
        principal(
            OrganizationMembership(ORG_A, "admin"),
            OrganizationMembership(ORG_B, "member"),
        )
    )

    response = client(repository).get("/auth/session", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["selected_organization_id"] is None
    assert len(response.json()["memberships"]) == 2


def test_requested_organization_is_selected_only_after_membership_check() -> None:
    repository = FakeRepository(
        principal(
            OrganizationMembership(ORG_A, "admin"),
            OrganizationMembership(ORG_B, "member"),
        )
    )

    response = client(repository).get(
        "/auth/session",
        headers=auth_headers(ORG_B),
    )

    assert response.status_code == 200
    assert response.json()["selected_organization_id"] == str(ORG_B)
    assert response.json()["selected_organization_role"] == "member"


def test_forged_organization_header_is_denied() -> None:
    repository = FakeRepository(principal(OrganizationMembership(ORG_A, "admin")))

    response = client(repository).get(
        "/auth/session",
        headers=auth_headers(ORG_FORGED),
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "organization_access_denied"}


def test_invalid_organization_header_is_rejected() -> None:
    response = client(FakeRepository(principal(OrganizationMembership(ORG_A, "admin")))).get(
        "/auth/session",
        headers={
            "Authorization": "Bearer valid-token",
            "X-OpenGeo-Organization": "not-a-uuid",
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_organization_scope"}


def test_verified_but_unprovisioned_subject_is_denied() -> None:
    response = client(FakeRepository(None)).get(
        "/auth/session",
        headers=auth_headers(),
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "principal_not_provisioned"}


def test_session_startup_lookup_is_route_only_and_checks_fresh_membership() -> None:
    class StartupRepository(FakeRepository):
        def __init__(self):
            super().__init__(principal(OrganizationMembership(ORG_A, "admin")))
            self.startup_subjects = []

        async def resolve_for_startup(self, subject):
            self.startup_subjects.append(subject)
            return self.principal

    repository = StartupRepository()
    test_client = client(repository)

    @test_client.app.get("/auth/session-other")
    async def other_session(session: Annotated[AuthSession, Depends(current_session)]):
        return {"user_id": str(session.principal.user_id)}

    response = test_client.get("/auth/session?startup=true", headers=auth_headers(ORG_A))
    assert response.status_code == 200
    assert repository.startup_subjects == ["subject-123"]
    assert repository.subjects == []
    repository.principal = principal(OrganizationMembership(ORG_B, "member"))
    response = test_client.get("/auth/session", headers=auth_headers(ORG_A))
    assert response.status_code == 403
    assert response.json() == {"detail": "organization_access_denied"}
    assert repository.startup_subjects == ["subject-123", "subject-123"]
    assert test_client.get("/auth/session-other", headers=auth_headers()).status_code == 200
    assert repository.subjects == ["subject-123"]
    assert test_client.post("/auth/session", headers=auth_headers()).status_code == 405
    assert len(repository.startup_subjects) == 2
    assert (
        test_client.get(
            "/auth/session", headers={"Authorization": "Bearer invalid-token"}
        ).status_code
        == 401
    )
    assert len(repository.startup_subjects) == 2


def test_session_startup_failure_uses_existing_sanitized_mapping(capsys) -> None:
    class UnavailableStartupRepository(FakeRepository):
        async def resolve_for_startup(self, subject):
            raise PrincipalBackendUnavailable("sensitive startup details") from TimeoutError(
                "sensitive upstream details"
            )

    response = client(UnavailableStartupRepository(principal())).get(
        "/auth/session", headers=auth_headers()
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "identity_store_unavailable"}
    logs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    record = next(row for row in logs if row["event"] == "principal.unavailable")
    assert record["cause_type"] == "TimeoutError"
    assert "sensitive" not in json.dumps(logs)


def test_principal_failure_logs_cause_type_without_sensitive_exception_text(caplog) -> None:
    class UnavailableRepository:
        async def resolve(self, subject):
            try:
                try:
                    raise TimeoutError("sensitive query and credentials")
                except TimeoutError as error:
                    raise RdsDataApiUnavailable("sensitive upstream message") from error
            except RdsDataApiUnavailable as error:
                raise PrincipalBackendUnavailable("principal lookup failed") from error

    async def resolve():
        token = await FakeVerifier().verify("valid-token")
        return await principal_for_token(token, UnavailableRepository())

    with pytest.raises(HTTPException) as caught:
        asyncio.run(resolve())
    assert caught.value.status_code == 503
    record = next(r for r in caplog.records if r.message == "principal.unavailable")
    serialized = JsonFormatter().format(record)
    assert json.loads(serialized)["cause_type"] == "TimeoutError"
    assert "sensitive" not in serialized
    assert caught.value.detail == "identity_store_unavailable"
