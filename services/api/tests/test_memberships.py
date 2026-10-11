import asyncio
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import ProvisionedIdentity
from opengeo_api.memberships import (
    InvitationDraft,
    MembershipAccessDenied,
    MembershipConflict,
    PostgresMembershipRepository,
)
from opengeo_api.tenant_database import TenantContext, UserContext

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
INVITED_ID = UUID("20000000-0000-4000-8000-000000000002")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
INVITATION_ID = UUID("70000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 19, 12, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, one: list[tuple[Any, ...] | None] | None = None) -> None:
        self.one = deque(one or [])
        self.all_rows: deque[list[tuple[Any, ...]]] = deque()
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


class SequenceExecutor:
    def __init__(self, transactions: list[FakeTransaction]) -> None:
        self.transactions = deque(transactions)
        self.contexts: list[TenantContext] = []

    async def run(self, context, operation):
        self.contexts.append(context)
        assert self.transactions
        return await operation(self.transactions.popleft())

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("not used")


class FakeUserExecutor:
    def __init__(
        self,
        row: tuple[Any, ...] | None = None,
        rows: list[tuple[Any, ...]] | None = None,
    ) -> None:
        self.row = row
        self.rows = rows or []
        self.calls: list[tuple[UserContext, str, tuple[Any, ...]]] = []

    async def fetch_one(self, context, statement, parameters=()):
        self.calls.append((context, statement, tuple(parameters)))
        return self.row

    async def fetch_all(self, context, statement, parameters=()):
        self.calls.append((context, statement, tuple(parameters)))
        return self.rows


class FakeProvisioner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def ensure_user(self, email: str, display_name: str) -> ProvisionedIdentity:
        self.calls.append((email, display_name))
        return ProvisionedIdentity("invited-subject", email, display_name)


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def invitation_row(status: str = "pending") -> tuple[Any, ...]:
    return (
        INVITATION_ID,
        "invitee@example.test",
        "Invitee",
        "member",
        None,
        None,
        status,
        NOW + timedelta(days=7),
        NOW if status == "accepted" else None,
        NOW if status == "revoked" else None,
        NOW,
    )


@pytest.mark.parametrize("status", ["pending", "accepted", "expired", "revoked"])
def test_invitation_list_keeps_audit_rows_without_a_visible_user_profile(status):
    transaction = FakeTransaction(one=[("admin",)])
    row = list(invitation_row(status))
    row[2] = row[1]  # SQL fallback is the already-authorized invitation email.
    transaction.all_rows.append([tuple(row)])
    store, _, _ = repository([transaction])
    records = asyncio.run(store.list_invitations(context(), 100, 0))
    assert records[0].status == status
    assert records[0].display_name == records[0].email
    query = next(call for call in transaction.calls if call[0] == "all")
    assert "LEFT JOIN app.users identity" in query[1]
    assert "COALESCE(identity.display_name, invitation.email)" in query[1]
    assert query[2] == (ORG_ID, 100, 0)


def repository(
    transactions: list[FakeTransaction],
    *,
    user_row: tuple[Any, ...] | None = None,
) -> tuple[PostgresMembershipRepository, FakeProvisioner, FakeUserExecutor]:
    provisioner = FakeProvisioner()
    user_executor = FakeUserExecutor(user_row)
    return (
        PostgresMembershipRepository(SequenceExecutor(transactions), user_executor, provisioner),
        provisioner,
        user_executor,
    )


def test_invitation_authorizes_before_cognito_then_rechecks_and_audits() -> None:
    authorize_transaction = FakeTransaction(one=[("admin",)])
    create_transaction = FakeTransaction(
        one=[("admin",), (INVITED_ID,), None, None, invitation_row()]
    )
    repo, provisioner, _ = repository([authorize_transaction, create_transaction])

    result = asyncio.run(
        repo.create_invitation(
            context(),
            InvitationDraft(
                email="invitee@example.test",
                display_name="Invitee",
                organization_role="member",
                project_id=None,
                project_role=None,
                expires_at=NOW + timedelta(days=7),
            ),
            "request-invite",
        )
    )

    assert result.invitation_id == INVITATION_ID
    assert provisioner.calls == [("invitee@example.test", "Invitee")]
    assert "provision_invited_user" in create_transaction.calls[1][1]
    invitation_insert = create_transaction.calls[4]
    assert "INSERT INTO app.membership_invitations" in invitation_insert[1]
    assert "%s::app.organization_role" in invitation_insert[1]
    assert "%s::app.project_role" in invitation_insert[1]
    audit = create_transaction.calls[-1]
    assert audit[0] == "execute"
    assert audit[2][3:7] == (
        "membership.invitation.created",
        "membership_invitation",
        invitation_insert[2][0],
        "request-invite",
    )


def test_denied_inviter_never_calls_cognito() -> None:
    transaction = FakeTransaction(one=[("member",)])
    repo, provisioner, _ = repository([transaction])

    with pytest.raises(MembershipAccessDenied):
        asyncio.run(
            repo.create_invitation(
                context(),
                InvitationDraft(
                    email="denied@example.test",
                    display_name="Denied",
                    organization_role="member",
                    project_id=None,
                    project_role=None,
                    expires_at=NOW + timedelta(days=7),
                ),
                "request-denied",
            )
        )

    assert provisioner.calls == []
    assert len(transaction.calls) == 1


def test_last_organization_admin_cannot_be_demoted() -> None:
    transaction = FakeTransaction(one=[(ORG_ID,), ("admin",), ("admin",), (1,)])
    repo, _, _ = repository([transaction])

    with pytest.raises(MembershipConflict) as caught:
        asyncio.run(repo.update_organization_member(context(), USER_ID, "member", "request-demote"))

    assert caught.value.code == "last_organization_admin"
    assert all(call[0] != "execute" for call in transaction.calls)


def test_organization_revocation_preserves_each_projects_last_owner() -> None:
    transaction = FakeTransaction(one=[(ORG_ID,), ("admin",), ("member",), (PROJECT_ID,)])
    repo, _, _ = repository([transaction])

    with pytest.raises(MembershipConflict) as caught:
        asyncio.run(repo.revoke_organization_member(context(), INVITED_ID, "request-revoke"))

    assert caught.value.code == "last_project_owner"
    assert all(call[0] != "execute" for call in transaction.calls)


def test_last_project_owner_cannot_be_revoked() -> None:
    transaction = FakeTransaction(
        one=[
            (PROJECT_ID,),
            ("member",),
            ("owner",),
            ("owner",),
            (1,),
        ]
    )
    repo, _, _ = repository([transaction])

    with pytest.raises(MembershipConflict) as caught:
        asyncio.run(repo.revoke_project_member(context(), PROJECT_ID, USER_ID, "request-owner"))

    assert caught.value.code == "last_project_owner"
    assert all(call[0] != "execute" for call in transaction.calls)


def test_project_owner_can_add_only_an_existing_organization_member() -> None:
    transaction = FakeTransaction(
        one=[
            (PROJECT_ID,),
            ("member",),
            ("owner",),
            ("member",),
            None,
        ]
    )
    repo, _, _ = repository([transaction])

    asyncio.run(
        repo.create_project_member(
            context(), PROJECT_ID, INVITED_ID, "editor", "request-project-member"
        )
    )

    insert = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "INSERT INTO app.project_memberships" in call[1]
    )
    assert insert[2] == (ORG_ID, PROJECT_ID, INVITED_ID, "editor")
    assert "%s::app.project_role" in insert[1]
    assert "INSERT INTO app.activity_events" in transaction.calls[-1][1]


def test_acceptance_is_user_bound_and_replay_is_a_conflict() -> None:
    accepted_row = (
        "accepted",
        INVITATION_ID,
        ORG_ID,
        PROJECT_ID,
        "guest",
        "viewer",
        NOW,
    )
    repo, _, user_executor = repository([], user_row=accepted_row)

    accepted = asyncio.run(repo.accept_invitation(INVITED_ID, INVITATION_ID, "request-accept"))

    assert accepted.organization_role == "guest"
    assert user_executor.calls[0][0] == UserContext(INVITED_ID)
    assert user_executor.calls[0][2] == (INVITATION_ID, "request-accept")

    replay_repo, _, _ = repository(
        [],
        user_row=(
            "already_accepted",
            INVITATION_ID,
            ORG_ID,
            PROJECT_ID,
            "guest",
            "viewer",
            NOW,
        ),
    )
    with pytest.raises(MembershipConflict) as caught:
        asyncio.run(replay_repo.accept_invitation(INVITED_ID, INVITATION_ID, "request-replay"))
    assert caught.value.code == "invitation_already_accepted"


def test_pending_invitation_discovery_is_bound_to_the_verified_user() -> None:
    provisioner = FakeProvisioner()
    user_executor = FakeUserExecutor(
        rows=[
            (
                INVITATION_ID,
                ORG_ID,
                "Organization A",
                PROJECT_ID,
                "Project A",
                "guest",
                "viewer",
                NOW + timedelta(days=7),
                NOW,
            )
        ]
    )
    repo = PostgresMembershipRepository(SequenceExecutor([]), user_executor, provisioner)

    invitations = asyncio.run(repo.list_pending_invitations(INVITED_ID))

    assert invitations[0].organization_name == "Organization A"
    assert invitations[0].project_name == "Project A"
    assert user_executor.calls[0][0] == UserContext(INVITED_ID)
    assert "list_pending_membership_invitations" in user_executor.calls[0][1]
