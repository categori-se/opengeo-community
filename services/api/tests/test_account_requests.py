import asyncio
import hashlib
import json
import unittest
from collections import deque
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch
from uuid import UUID

from fastapi.testclient import TestClient

from opengeo_api.account_requests import AccountRequest
from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.cognito_provisioning import ProvisionedIdentity
from opengeo_api.config import Settings
from opengeo_api.lambda_handler import ApiGatewayV2Adapter
from opengeo_api.memberships import (
    InvitationDraft,
    MembershipConflict,
    MembershipNotFound,
    PostgresMembershipRepository,
)
from opengeo_api.tenant_database import TenantContext

OWNER = UUID("20000000-0000-4000-8000-000000000001")
OTHER = UUID("20000000-0000-4000-8000-000000000002")
ORG = UUID("10000000-0000-4000-8000-000000000001")
REQUEST = UUID("70000000-0000-4000-8000-000000000001")
INVITATION = UUID("70000000-0000-4000-8000-000000000002")
NOW = datetime(2026, 11, 1, tzinfo=UTC)
HEADERS = {"Authorization": "Bearer valid", "X-OpenGeo-Organization": str(ORG)}
DRAFT = {
    "display_name": "Requested Person",
    "email": "Person@Example.test",
    "purpose": "Analyze regional geospatial data.",
}


class Verifier:
    async def verify(self, token):
        return VerifiedAccessToken("subject", "client", "user", (), ())


class Principals:
    def __init__(self, user_id, role):
        self.user_id, self.role = user_id, role

    async def resolve(self, subject):
        if self.user_id is None:
            return None
        return Principal(
            self.user_id,
            subject,
            "owner@example.test",
            "Owner",
            (OrganizationMembership(ORG, self.role),),
        )


class Requests:
    def __init__(self):
        self.calls = []
        self.result = "pending"
        self.record = AccountRequest(
            REQUEST,
            "person@example.test",
            DRAFT["display_name"],
            DRAFT["purpose"],
            "pending",
            None,
            NOW,
            None,
        )

    async def submit(self, *args):
        self.calls.append(("submit", args))
        return self.result

    async def list_requests(self, context, limit, offset):
        self.calls.append(("list", context, limit, offset))
        return [self.record]

    async def get(self, context, request_id):
        assert request_id == REQUEST
        self.calls.append(("get", context, request_id))
        return self.record

    async def reject(self, context, request_id):
        if self.record.state == "approved":
            raise MembershipConflict("account_request_already_approved")
        self.record = replace(self.record, state="rejected", reviewed_at=NOW)
        return self.record


class Memberships:
    def __init__(self, requests):
        self.requests = requests
        self.calls = []

    async def create_invitation(self, context, draft, request_id):
        self.calls.append((context, draft, request_id))
        if self.requests.record.state == "rejected":
            raise MembershipConflict("account_request_rejected")
        self.requests.record = replace(
            self.requests.record, state="approved", invitation_id=INVITATION, reviewed_at=NOW
        )


def client(*, user_id=OWNER, role="admin", configured=True):
    requests = Requests()
    memberships = Memberships(requests)
    settings = Settings(
        env="test",
        log_level="CRITICAL",
        **(
            {"account_request_organization_id": ORG, "account_request_reviewer_user_id": OWNER}
            if configured
            else {}
        ),
    )
    application = create_app(
        settings=settings,
        token_verifier=Verifier(),
        principal_repository=Principals(user_id, role),
        membership_repository=memberships,
        account_request_repository=requests,
    )
    return TestClient(application), requests, memberships


class AccountRequestTests(unittest.TestCase):
    def test_gateway_source_ip_is_used_instead_of_caller_forwarded_header(self):
        api, requests, _ = client()
        event = {
            "version": "2.0",
            "rawPath": "/auth/account-requests",
            "rawQueryString": "",
            "headers": {"content-type": "application/json", "x-forwarded-for": "203.0.113.99"},
            "requestContext": {
                "domainName": "api.example.test",
                "http": {
                    "method": "POST",
                    "path": "/auth/account-requests",
                    "protocol": "HTTP/1.1",
                    "sourceIp": "192.0.2.10",
                },
            },
            "body": json.dumps(DRAFT),
            "isBase64Encoded": False,
        }
        response = asyncio.run(ApiGatewayV2Adapter(api.app).invoke(event))
        assert response["statusCode"] == 202
        assert requests.calls[0][1][5] == hashlib.sha256(f"{OWNER}:192.0.2.10".encode()).hexdigest()

    def test_anonymous_request_is_pending_normalized_and_never_provisions_identity(self):
        api, requests, memberships = client()
        for _ in range(2):
            response = api.post("/auth/account-requests", json=DRAFT)
            assert response.status_code == 202
            assert response.json() == {"status": "pending"}
            assert response.headers["cache-control"] == "no-store"
        assert requests.calls[0][1][:5] == (
            ORG,
            OWNER,
            "person@example.test",
            DRAFT["display_name"],
            DRAFT["purpose"],
        )
        assert len(requests.calls[0][1][5]) == 64
        assert memberships.calls == []
        assert api.get("/auth/session", headers=HEADERS).status_code == 200

    def test_requests_reject_unbounded_or_privileged_input(self):
        for payload in [
            {**DRAFT, "email": "invalid"},
            {**DRAFT, "purpose": " " * 12},
            {**DRAFT, "organization_role": "admin"},
            {**DRAFT, "purpose": "a" * 2001},
        ]:
            with self.subTest(payload=payload):
                api, requests, memberships = client()
                assert api.post("/auth/account-requests", json=payload).status_code == 422
                assert requests.calls == memberships.calls == []

    def test_missing_deployment_configuration_fails_closed(self):
        api, requests, memberships = client(configured=False)
        response = api.post("/auth/account-requests", json=DRAFT)
        assert response.status_code == 503
        assert response.json() == {"detail": "account_requests_unavailable"}
        assert requests.calls == memberships.calls == []

    def test_honeypot_returns_same_receipt_without_any_store_or_provisioner_call(self):
        api, requests, memberships = client()
        assert api.post("/auth/account-requests", json={**DRAFT, "website": "spam"}).json() == {
            "status": "pending"
        }
        assert requests.calls == memberships.calls == []

    def test_persistent_rate_limit_is_reported_without_request_details(self):
        api, requests, memberships = client()
        requests.result = "rate_limited"
        response = api.post("/auth/account-requests", json=DRAFT)
        assert response.status_code == 429
        assert response.json() == {"detail": "account_request_rate_limited"}
        assert response.headers["retry-after"] == "3600"
        assert memberships.calls == []

    def test_other_admins_members_and_unprovisioned_users_cannot_read_or_review(self):
        for user_id, role in [(OTHER, "admin"), (OWNER, "member"), (None, "admin")]:
            with self.subTest(user_id=user_id, role=role):
                api, requests, memberships = client(user_id=user_id, role=role)
                assert api.get("/auth/account-requests", headers=HEADERS).status_code == 403
                assert (
                    api.post(
                        f"/auth/account-requests/{REQUEST}/review",
                        headers=HEADERS,
                        json={"decision": "approve"},
                    ).status_code
                    == 403
                )
                assert requests.calls == memberships.calls == []

    def test_anonymous_callers_cannot_read_or_review(self):
        api, requests, memberships = client()
        assert api.get("/auth/account-requests").status_code == 401
        assert (
            api.post(
                f"/auth/account-requests/{REQUEST}/review", json={"decision": "approve"}
            ).status_code
            == 401
        )
        assert requests.calls == memberships.calls == []

    def test_designated_owner_reviews_request_through_existing_pending_invitation(self):
        api, _requests, memberships = client()
        response = api.get("/auth/account-requests", headers=HEADERS)
        assert response.json()[0]["state"] == "pending"
        response = api.post(
            f"/auth/account-requests/{REQUEST}/review",
            headers=HEADERS,
            json={"decision": "approve"},
        )
        assert response.status_code == 200
        assert response.json()["state"] == "approved"
        assert response.json()["invitation_id"] == str(INVITATION)
        context, draft, _ = memberships.calls[0]
        assert context.user_id == OWNER and context.organization_id == ORG
        assert draft.account_request_id == REQUEST
        assert draft.organization_role == "member"
        assert draft.project_id is None and draft.project_role is None

    def test_rejection_is_repeatable_and_never_provisions_or_grants_access(self):
        api, _requests, memberships = client()
        for _ in range(2):
            response = api.post(
                f"/auth/account-requests/{REQUEST}/review",
                headers=HEADERS,
                json={"decision": "reject"},
            )
            assert response.status_code == 200 and response.json()["state"] == "rejected"
        assert memberships.calls == []
        response = api.post(
            f"/auth/account-requests/{REQUEST}/review",
            headers=HEADERS,
            json={"decision": "approve"},
        )
        assert response.status_code == 409

    def test_reviewer_needs_the_configured_account_scope_and_bounded_paging(self):
        api, requests, memberships = client()
        response = api.get(
            "/auth/account-requests", headers={**HEADERS, "X-OpenGeo-Organization": str(OTHER)}
        )
        assert response.status_code == 403
        assert api.get("/auth/account-requests?limit=101", headers=HEADERS).status_code == 422
        assert requests.calls == memberships.calls == []


class Transaction:
    def __init__(self, rows):
        self.rows = deque(rows)
        self.calls = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append((statement, parameters))
        return self.rows.popleft()

    async def execute(self, statement, parameters=()):
        self.calls.append((statement, parameters))
        return 1


class Transactions:
    def __init__(self, transactions):
        self.transactions = deque(transactions)

    async def run(self, context, operation):
        return await operation(self.transactions.popleft())


def invitation_row(role="member"):
    return (
        INVITATION,
        "person@example.test",
        DRAFT["display_name"],
        role,
        None,
        None,
        "pending",
        NOW + timedelta(days=7),
        None,
        None,
        NOW,
    )


class AccountRequestInvitationTests(unittest.TestCase):
    def store(self, transactions):
        provisioner = AsyncMock()
        provisioner.ensure_user.return_value = ProvisionedIdentity(
            "new-subject", "person@example.test", DRAFT["display_name"]
        )
        return PostgresMembershipRepository(
            Transactions(transactions), AsyncMock(), provisioner
        ), provisioner

    def draft(self):
        return InvitationDraft(
            "person@example.test",
            DRAFT["display_name"],
            "member",
            None,
            None,
            NOW + timedelta(days=7),
            account_request_id=REQUEST,
        )

    def test_approved_retry_returns_original_invitation_without_another_provider_call(self):
        transaction = Transaction(
            [
                ("admin",),
                ("approved", "person@example.test", DRAFT["display_name"], INVITATION),
                invitation_row(),
            ]
        )
        store, provisioner = self.store([transaction])
        invitation = asyncio.run(
            store.create_invitation(TenantContext(OWNER, ORG), self.draft(), "review")
        )
        assert invitation.invitation_id == INVITATION
        provisioner.ensure_user.assert_not_called()

    def test_missing_or_rejected_requests_never_reach_identity_provider(self):
        for row in [None, ("rejected", "person@example.test", DRAFT["display_name"], None)]:
            with self.subTest(row=row):
                store, provisioner = self.store([Transaction([("admin",), row])])
                with self.assertRaises((MembershipConflict, MembershipNotFound)):
                    asyncio.run(
                        store.create_invitation(TenantContext(OWNER, ORG), self.draft(), "review")
                    )
                provisioner.ensure_user.assert_not_called()

    def test_approval_and_invitation_share_one_transaction_without_membership_grants(self):
        row = ("pending", "person@example.test", DRAFT["display_name"], None)
        create = Transaction([("admin",), row, (OTHER,), None, None, invitation_row()])
        store, provisioner = self.store([Transaction([("admin",), row]), create])
        with patch("opengeo_api.memberships.uuid4", return_value=INVITATION):
            invitation = asyncio.run(
                store.create_invitation(TenantContext(OWNER, ORG), self.draft(), "review")
            )
        assert invitation.invitation_id == INVITATION
        provisioner.ensure_user.assert_awaited_once()
        assert any(
            "UPDATE app.account_access_requests" in statement for statement, _ in create.calls
        )
        assert not any(
            "INSERT INTO app.organization_memberships" in statement for statement, _ in create.calls
        )

    def test_pending_admin_invitation_is_preserved_without_approval_scope_escalation(self):
        row = ("pending", "person@example.test", DRAFT["display_name"], None)
        create = Transaction(
            [
                ("admin",),
                row,
                (OTHER,),
                None,
                (INVITATION, NOW + timedelta(days=7)),
                invitation_row("admin"),
            ]
        )
        store, _ = self.store([Transaction([("admin",), row]), create])
        with self.assertRaisesRegex(
            MembershipConflict, "account_request_invitation_scope_mismatch"
        ):
            asyncio.run(store.create_invitation(TenantContext(OWNER, ORG), self.draft(), "review"))
        assert not any(
            "UPDATE app.account_access_requests" in statement for statement, _ in create.calls
        )
