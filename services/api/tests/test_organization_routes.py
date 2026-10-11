from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.auth_tokens import TokenVerificationError
from opengeo_api.config import Settings
from opengeo_api.organizations import Organization, OrganizationBackendUnavailable
from opengeo_api.session_app import create_session_app
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_A = UUID("10000000-0000-4000-8000-000000000001")
ORG_B = UUID("10000000-0000-4000-8000-000000000002")
ORG_FORGED = UUID("10000000-0000-4000-8000-000000000099")


@pytest.fixture(params=["full", "account"], autouse=True)
def organization_factory(request, monkeypatch):
    if request.param == "account":
        monkeypatch.setattr(
            __import__(__name__, fromlist=["client"]),
            "client",
            lambda principal_record, repository: TestClient(
                create_session_app(
                    Settings(env="test"), FakeVerifier(),
                    FakePrincipalRepository(principal_record), repository,
                )
            ),
        )


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        if token != "valid-token":
            raise TokenVerificationError("private verification reason")
        return VerifiedAccessToken(
            subject="subject-123",
            client_id="client-123",
            username="ada",
            scopes=(),
            groups=(),
        )


class FakePrincipalRepository:
    def __init__(self, principal: Principal | None) -> None:
        self.principal = principal

    async def resolve(self, subject: str) -> Principal | None:
        assert subject == "subject-123"
        return self.principal


class FakeOrganizationRepository:
    def __init__(self, organization: Organization | None) -> None:
        self.organization = organization
        self.contexts: list[TenantContext] = []

    async def get_current(self, context: TenantContext) -> Organization | None:
        self.contexts.append(context)
        return self.organization


class FailingOrganizationRepository:
    async def get_current(self, context: TenantContext) -> Organization | None:
        del context
        raise OrganizationBackendUnavailable("password=must-not-leak")


def principal(*memberships: OrganizationMembership) -> Principal:
    return Principal(
        user_id=USER_ID,
        subject="subject-123",
        email="ada@example.test",
        display_name="Ada",
        memberships=tuple(memberships),
    )


def organization(organization_id: UUID = ORG_A) -> Organization:
    return Organization(
        organization_id=organization_id,
        name="Organization A",
        slug="organization-a",
        status="active",
    )


def client(
    principal_record: Principal | None,
    organization_repository,
) -> TestClient:
    return TestClient(
        create_app(
            Settings(env="test"),
            PassingProbe(),
            FakeVerifier(),
            FakePrincipalRepository(principal_record),
            organization_repository,
        )
    )


def auth_headers(organization_id: UUID | str | None = None) -> dict[str, str]:
    headers = {"Authorization": "Bearer valid-token"}
    if organization_id is not None:
        headers["X-OpenGeo-Organization"] = str(organization_id)
    return headers


def test_current_organization_uses_verified_transaction_context() -> None:
    repository = FakeOrganizationRepository(organization())
    response = client(
        principal(
            OrganizationMembership(ORG_A, "admin"),
            OrganizationMembership(ORG_B, "member"),
        ),
        repository,
    ).get("/organizations/current", headers=auth_headers(ORG_A))

    assert response.status_code == 200
    assert response.json() == {
        "id": str(ORG_A),
        "name": "Organization A",
        "slug": "organization-a",
        "status": "active",
        "caller_role": "admin",
    }
    assert repository.contexts == [TenantContext(user_id=USER_ID, organization_id=ORG_A)]


def test_single_membership_is_safe_to_auto_select() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        repository,
    ).get("/organizations/current", headers=auth_headers())

    assert response.status_code == 200
    assert repository.contexts == [TenantContext(user_id=USER_ID, organization_id=ORG_A)]


def test_missing_token_fails_before_tenant_query() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        repository,
    ).get("/organizations/current")

    assert response.status_code == 401
    assert repository.contexts == []


def test_unprovisioned_subject_fails_before_tenant_query() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(None, repository).get(
        "/organizations/current",
        headers=auth_headers(ORG_A),
    )

    assert response.status_code == 403
    assert repository.contexts == []


def test_multiple_memberships_without_scope_fail_before_tenant_query() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(
        principal(
            OrganizationMembership(ORG_A, "admin"),
            OrganizationMembership(ORG_B, "member"),
        ),
        repository,
    ).get("/organizations/current", headers=auth_headers())

    assert response.status_code == 409
    assert response.json() == {"detail": "organization_scope_required"}
    assert repository.contexts == []


def test_malformed_scope_fails_before_tenant_query() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        repository,
    ).get("/organizations/current", headers=auth_headers("not-a-uuid"))

    assert response.status_code == 400
    assert repository.contexts == []


def test_cross_organization_scope_fails_before_tenant_query() -> None:
    repository = FakeOrganizationRepository(organization())

    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        repository,
    ).get("/organizations/current", headers=auth_headers(ORG_FORGED))

    assert response.status_code == 403
    assert response.json() == {"detail": "organization_access_denied"}
    assert repository.contexts == []


def test_rls_hidden_organization_is_reported_as_not_found() -> None:
    repository = FakeOrganizationRepository(None)

    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        repository,
    ).get("/organizations/current", headers=auth_headers())

    assert response.status_code == 404
    assert response.json() == {"detail": "organization_not_found"}


def test_backend_failure_is_sanitized() -> None:
    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        FailingOrganizationRepository(),
    ).get("/organizations/current", headers=auth_headers())

    assert response.status_code == 503
    assert response.json() == {"detail": "organization_store_unavailable"}
    assert "password" not in response.text


def test_repository_scope_mismatch_fails_closed() -> None:
    response = client(
        principal(OrganizationMembership(ORG_A, "admin")),
        FakeOrganizationRepository(organization(ORG_B)),
    ).get("/organizations/current", headers=auth_headers())

    assert response.status_code == 503
    assert response.json() == {"detail": "organization_store_unavailable"}
