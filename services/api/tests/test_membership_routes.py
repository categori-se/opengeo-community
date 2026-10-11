from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.memberships import (
    MembershipAcceptance,
    MembershipConflict,
    MembershipInvitation,
    PendingMembershipInvitation,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
INVITED_ID = UUID("20000000-0000-4000-8000-000000000002")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000002")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
INVITATION_ID = UUID("70000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 19, 12, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    def __init__(self, memberships: tuple[OrganizationMembership, ...]) -> None:
        self.memberships = memberships

    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="admin@example.test",
            display_name="Admin",
            memberships=self.memberships,
        )


class FakeMembershipRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def create_invitation(self, context, draft, request_id):
        self.calls.append(("create_invitation", context, draft, request_id))
        return MembershipInvitation(
            invitation_id=INVITATION_ID,
            email=draft.email,
            display_name=draft.display_name,
            organization_role=draft.organization_role,
            project_id=draft.project_id,
            project_role=draft.project_role,
            status="pending",
            expires_at=draft.expires_at,
            accepted_at=None,
            revoked_at=None,
            created_at=NOW,
        )

    async def list_pending_invitations(self, user_id):
        self.calls.append(("list_pending_invitations", user_id))
        return [
            PendingMembershipInvitation(
                invitation_id=INVITATION_ID,
                organization_id=ORG_ID,
                organization_name="Organization A",
                project_id=PROJECT_ID,
                project_name="Project A",
                organization_role="guest",
                project_role="viewer",
                expires_at=NOW + timedelta(days=7),
                created_at=NOW,
            )
        ]

    async def accept_invitation(self, user_id, invitation_id, request_id):
        self.calls.append(("accept_invitation", user_id, invitation_id, request_id))
        return MembershipAcceptance(
            invitation_id=invitation_id,
            organization_id=ORG_ID,
            project_id=PROJECT_ID,
            organization_role="guest",
            project_role="viewer",
            accepted_at=NOW,
        )

    async def update_organization_member(self, context, user_id, role, request_id):
        self.calls.append(("update_organization_member", context, user_id, role, request_id))


class ConflictingMembershipRepository(FakeMembershipRepository):
    async def accept_invitation(self, *args, **kwargs):
        del args, kwargs
        raise MembershipConflict("invitation_already_accepted")


def api_client(
    repository: FakeMembershipRepository,
    *,
    memberships: tuple[OrganizationMembership, ...] = (OrganizationMembership(ORG_ID, "admin"),),
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(memberships),
            membership_repository=repository,
        )
    )


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-membership-123",
    }


def test_invitation_request_is_normalized_scoped_and_bounded() -> None:
    repository = FakeMembershipRepository()

    response = api_client(repository).post(
        "/organizations/current/invitations",
        headers=headers(),
        json={
            "email": " Invitee@Example.Test ",
            "display_name": " Invitee ",
            "organization_role": "guest",
            "project_id": str(PROJECT_ID),
            "project_role": "viewer",
            "expires_in_days": 3,
        },
    )

    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    call = repository.calls[0]
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[2].email == "invitee@example.test"
    assert call[2].display_name == "Invitee"
    assert timedelta(days=2, hours=23) < call[2].expires_at - datetime.now(UTC) <= timedelta(days=3)
    assert call[3] == "request-membership-123"


def test_incomplete_project_scope_and_excessive_expiry_are_rejected() -> None:
    repository = FakeMembershipRepository()
    client = api_client(repository)

    incomplete = client.post(
        "/organizations/current/invitations",
        headers=headers(),
        json={
            "email": "invitee@example.test",
            "display_name": "Invitee",
            "project_id": str(PROJECT_ID),
        },
    )
    excessive = client.post(
        "/organizations/current/invitations",
        headers=headers(),
        json={
            "email": "invitee@example.test",
            "display_name": "Invitee",
            "expires_in_days": 31,
        },
    )

    assert incomplete.status_code == 422
    assert excessive.status_code == 422
    assert repository.calls == []


def test_invitation_acceptance_needs_a_principal_but_not_existing_membership() -> None:
    repository = FakeMembershipRepository()

    response = api_client(repository, memberships=()).post(
        f"/auth/invitations/{INVITATION_ID}/accept",
        headers={
            "Authorization": "Bearer valid-token",
            "X-Request-ID": "request-accept-123",
        },
    )

    assert response.status_code == 200
    assert response.json()["organization_id"] == str(ORG_ID)
    assert repository.calls == [("accept_invitation", USER_ID, INVITATION_ID, "request-accept-123")]


def test_replay_conflict_is_machine_readable() -> None:
    response = api_client(ConflictingMembershipRepository(), memberships=()).post(
        f"/auth/invitations/{INVITATION_ID}/accept",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "invitation_already_accepted"}}


def test_invited_principal_can_discover_only_its_pending_invitations() -> None:
    repository = FakeMembershipRepository()

    response = api_client(repository, memberships=()).get(
        "/auth/invitations",
        headers={"Authorization": "Bearer valid-token"},
    )

    assert response.status_code == 200
    assert response.json()[0]["organization_name"] == "Organization A"
    assert response.json()[0]["project_name"] == "Project A"
    assert repository.calls == [("list_pending_invitations", USER_ID)]


def test_forged_tenant_is_rejected_before_membership_mutation() -> None:
    repository = FakeMembershipRepository()

    response = api_client(repository).patch(
        f"/organizations/current/memberships/{INVITED_ID}",
        headers=headers(OTHER_ORG_ID),
        json={"role": "admin"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "organization_access_denied"}
    assert repository.calls == []


def test_openapi_exposes_membership_administration_contracts() -> None:
    paths = api_client(FakeMembershipRepository()).get("/openapi.json").json()["paths"]

    assert {
        "/organizations/current/invitations",
        "/organizations/current/invitations/{invitation_id}",
        "/auth/invitations",
        "/auth/invitations/{invitation_id}/accept",
        "/organizations/current/memberships/{user_id}",
        "/projects/{project_id}/memberships",
        "/projects/{project_id}/memberships/{user_id}",
    } <= set(paths)
