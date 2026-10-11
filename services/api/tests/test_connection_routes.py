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
from opengeo_api.connections import (
    ConnectionCapabilities,
    ConnectionStoreUnavailable,
    ExternalConnection,
    ExternalConnectionRevision,
    ExternalConnectionVerification,
    ExternalConnectionVerificationSubmission,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000479")
ORG_ID = UUID("10000000-0000-4000-8000-000000000479")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000478")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000479")
CONNECTION_ID = UUID("70000000-0000-4000-8000-000000000479")
REVISION_ID = UUID("71000000-0000-4000-8000-000000000479")
VERIFICATION_ID = UUID("81000000-0000-4000-8000-000000000479")
NOW = datetime(2026, 8, 23, 12, tzinfo=UTC)


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
            email="owner@example.test",
            display_name="Owner",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def connection() -> ExternalConnection:
    return ExternalConnection(
        connection_id=CONNECTION_ID,
        project_id=PROJECT_ID,
        provider="postgresql",
        display_name="Research warehouse",
        endpoint_host="gis.example.test",
        endpoint_port=5432,
        database_name="research",
        allowed_schemas=("public", "observations"),
        read_only=True,
        tls_mode="verify_full",
        network_mode="public_internet",
        configured_secret_fields=("password", "username"),
        status="configuration_valid",
        current_revision_number=1,
        last_verified_at=None,
        schema_fingerprint_sha256=None,
        sanitized_error_code=None,
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
        capabilities=ConnectionCapabilities(read=True, manage=True),
    )


def verification(state: str = "queued") -> ExternalConnectionVerification:
    return ExternalConnectionVerification(
        verification_id=VERIFICATION_ID,
        connection_id=CONNECTION_ID,
        connection_revision_number=1,
        state=state,
        attempt_count=0,
        network_reachable=False,
        tls_verified=False,
        credentials_verified=False,
        postgis_verified=False,
        sanitized_error_code="verification_cancelled" if state == "cancelled" else None,
        duration_ms=None,
        requested_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=NOW if state == "cancelled" else None,
    )


class FakeConnectionRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_connections(self, context, project_id):
        self.calls.append(("list", context, project_id))
        return (connection(),)

    async def get_connection(self, context, project_id, connection_id):
        self.calls.append(("get", context, project_id, connection_id))
        return connection()

    async def list_revisions(self, context, project_id, connection_id):
        self.calls.append(("revisions", context, project_id, connection_id))
        return (
            ExternalConnectionRevision(
                revision_id=REVISION_ID,
                connection_id=CONNECTION_ID,
                revision_number=1,
                configuration={
                    "provider": "postgresql",
                    "endpointHost": "gis.example.test",
                    "endpointPort": 5432,
                    "databaseName": "research",
                    "allowedSchemas": ["public", "observations"],
                    "readOnly": True,
                    "tlsMode": "verify_full",
                    "networkMode": "public_internet",
                },
                change_summary="Initial connection registration",
                created_by=USER_ID,
                created_at=NOW,
            ),
        )

    async def create_connection(self, context, project_id, draft, request_id):
        self.calls.append(("create", context, project_id, draft, request_id))
        return connection()

    async def request_verification(self, context, project_id, connection_id, request_id):
        self.calls.append(("request_verification", context, project_id, connection_id, request_id))
        return ExternalConnectionVerificationSubmission(verification(), True)

    async def list_verifications(self, context, project_id, connection_id):
        self.calls.append(("list_verifications", context, project_id, connection_id))
        return (verification(),)

    async def cancel_verification(
        self, context, project_id, connection_id, verification_id, request_id
    ):
        self.calls.append(
            (
                "cancel_verification",
                context,
                project_id,
                connection_id,
                verification_id,
                request_id,
            )
        )
        return verification("cancelled")


class VerificationDispatcher:
    def __init__(self, *, available: bool = True) -> None:
        self._available = available
        self.dispatched: list[UUID] = []

    @property
    def available(self) -> bool:
        return self._available

    async def dispatch_connection_verification(self, verification_id: UUID) -> None:
        self.dispatched.append(verification_id)


class FailingConnectionRepository(FakeConnectionRepository):
    async def list_connections(self, *args, **kwargs):
        del args, kwargs
        raise ConnectionStoreUnavailable("password=must-not-leak")


def api_app(
    repository: FakeConnectionRepository,
    dispatcher: VerificationDispatcher | None = None,
) -> FastAPI:
    return create_app(
        settings=Settings(env="test", expose_docs=True),
        readiness_probe=PassingProbe(),
        token_verifier=FakeVerifier(),
        principal_repository=FakePrincipalRepository(),
        connection_repository=repository,
        connection_verification_dispatcher=dispatcher,
    )


@dataclass(frozen=True)
class AsgiResponse:
    status_code: int
    content: bytes

    @property
    def text(self) -> str:
        return self.content.decode("utf-8")

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
    header_items = list((request_headers or {}).items())
    if json_body is not None:
        header_items.extend(
            [("content-type", "application/json"), ("content-length", str(len(body)))]
        )

    async def invoke() -> AsgiResponse:
        incoming = [{"type": "http.request", "body": body, "more_body": False}]
        outgoing = []

        async def receive():
            if incoming:
                return incoming.pop(0)
            return {"type": "http.disconnect"}

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
                "headers": [(key.lower().encode(), value.encode()) for key, value in header_items],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        start = next(message for message in outgoing if message["type"] == "http.response.start")
        response_body = b"".join(
            message.get("body", b"")
            for message in outgoing
            if message["type"] == "http.response.body"
        )
        return AsgiResponse(start["status"], response_body)

    return asyncio.run(invoke())


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-connection-123",
    }


def payload(**changes):
    value = {
        "provider": "postgresql",
        "display_name": " Research warehouse ",
        "endpoint_host": "GIS.EXAMPLE.TEST.",
        "endpoint_port": 5432,
        "database_name": "research",
        "allowed_schemas": ["public", "observations"],
        "read_only": True,
        "tls_mode": "verify_full",
        "network_mode": "public_internet",
        "credentials": {"username": "reader", "password": "sensitive-password"},
    }
    value.update(changes)
    return value


def test_create_accepts_credentials_once_and_returns_only_non_secret_facts() -> None:
    repository = FakeConnectionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/projects/{PROJECT_ID}/connections",
        request_headers=headers(),
        json_body=payload(),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["connection_id"] == str(CONNECTION_ID)
    assert body["configured_secret_fields"] == ["password", "username"]
    assert body["status"] == "configuration_valid"
    assert body["verification_available"] is False
    assert body["snapshot_available"] is False
    serialized = response.text.lower()
    assert "sensitive-password" not in serialized
    assert "secret_arn" not in serialized
    assert "arn:aws" not in serialized

    call = repository.calls[0]
    assert call[1] == TenantContext(USER_ID, ORG_ID)
    assert call[2] == PROJECT_ID
    assert call[3].display_name == "Research warehouse"
    assert call[3].endpoint_host == "gis.example.test"
    assert call[3].username == "reader"
    assert call[3].password == "sensitive-password"
    assert call[4] == "request-connection-123"


def test_validation_rejects_unsafe_targets_and_duplicates_without_secret_echo() -> None:
    app = api_app(FakeConnectionRepository())
    invalid = [
        payload(endpoint_host="127.0.0.1"),
        payload(endpoint_host="metadata.internal"),
        payload(read_only=False),
        payload(allowed_schemas=["public", "public"]),
        payload(endpoint_host="single-label"),
    ]
    for item in invalid:
        response = request(
            app,
            "POST",
            f"/projects/{PROJECT_ID}/connections",
            request_headers=headers(),
            json_body=item,
        )
        assert response.status_code == 422
        assert "sensitive-password" not in response.text


def test_list_get_and_revision_contracts_remain_secret_free() -> None:
    repository = FakeConnectionRepository()
    app = api_app(repository)
    responses = [
        request(app, "GET", f"/projects/{PROJECT_ID}/connections", request_headers=headers()),
        request(
            app,
            "GET",
            f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}",
            request_headers=headers(),
        ),
        request(
            app,
            "GET",
            f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/revisions",
            request_headers=headers(),
        ),
    ]
    assert all(response.status_code == 200 for response in responses)
    serialized = "".join(response.text.lower() for response in responses)
    assert "password" not in responses[2].text.lower()
    assert "secret_arn" not in serialized
    assert "arn:aws" not in serialized


def test_tenant_selection_and_backend_errors_fail_closed_without_detail_leakage() -> None:
    app = api_app(FailingConnectionRepository())
    mismatch = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/connections",
        request_headers=headers(OTHER_ORG_ID),
    )
    unavailable = request(
        app, "GET", f"/projects/{PROJECT_ID}/connections", request_headers=headers()
    )

    assert mismatch.status_code == 403
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "external_connection_store_unavailable"}
    assert "must-not-leak" not in unavailable.text


def test_openapi_marks_credentials_as_write_only_and_exposes_no_secret_reference() -> None:
    schema = request(api_app(FakeConnectionRepository()), "GET", "/openapi.json").json()
    credential_schema = schema["components"]["schemas"]["PostgreSqlCredentials"]
    assert credential_schema["properties"]["username"]["format"] == "password"
    assert credential_schema["properties"]["password"]["format"] == "password"
    response_schema = schema["components"]["schemas"]["ExternalConnectionResponse"]
    assert "secret_arn" not in response_schema["properties"]
    assert "credentials" not in response_schema["properties"]


def test_owner_can_queue_list_and_cancel_identity_only_verification_work() -> None:
    repository = FakeConnectionRepository()
    dispatcher = VerificationDispatcher()
    app = api_app(repository, dispatcher)

    queued = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    listed = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    cancelled = request(
        app,
        "DELETE",
        f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/verifications/{VERIFICATION_ID}",
        request_headers=headers(),
    )

    assert queued.status_code == 202
    assert queued.json()["verification"]["state"] == "queued"
    assert queued.json()["created"] is True
    assert dispatcher.dispatched == [VERIFICATION_ID]
    assert listed.status_code == 200
    assert listed.json()[0]["verification_id"] == str(VERIFICATION_ID)
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    serialized = queued.text + listed.text + cancelled.text
    assert "secret" not in serialized.lower()
    assert "endpoint" not in serialized.lower()


def test_verification_request_fails_before_persistence_when_runtime_is_unavailable() -> None:
    repository = FakeConnectionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "connection_verification_unavailable"}
    assert repository.calls == []


def test_connection_capability_reflects_the_dedicated_dispatcher() -> None:
    response = request(
        api_app(FakeConnectionRepository(), VerificationDispatcher()),
        "GET",
        f"/projects/{PROJECT_ID}/connections/{CONNECTION_ID}",
        request_headers=headers(),
    )
    assert response.status_code == 200
    assert response.json()["verification_available"] is True
