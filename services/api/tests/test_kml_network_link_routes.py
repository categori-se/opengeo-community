import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

import opengeo_api.kml_network_link_routes as network_link_routes
from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.kml_network_link_routes import (
    NetworkLinkGateFailure,
    NetworkLinkRequestGate,
    PostgresNetworkLinkRequestGate,
)
from opengeo_api.kml_network_links import NetworkLinkFailure, NetworkLinkFetchReceipt
from opengeo_api.tenant_database import TenantContext, TenantDatabaseUnavailable
from opengeo_api.workspaces import Project, WorkspaceAccessDenied

USER_ID = UUID("20000000-0000-4000-8000-000000000001")
ORG_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 24, 12, tzinfo=UTC)


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
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


class FakeWorkspaceRepository:
    def __init__(self, *, archived: bool = False, denied: bool = False) -> None:
        self.archived = archived
        self.denied = denied
        self.calls: list[tuple[TenantContext, UUID]] = []

    async def get_project(self, context: TenantContext, project_id: UUID) -> Project:
        self.calls.append((context, project_id))
        if self.denied:
            raise WorkspaceAccessDenied("private role detail")
        return Project(
            project_id=project_id,
            client_id=None,
            name="NetworkLink project",
            project_code="NETWORK",
            description=None,
            status="archived" if self.archived else "active",
            created_at=NOW,
            updated_at=NOW,
            caller_role="viewer",
        )


class FakeFetcher:
    def __init__(self, failure: NetworkLinkFailure | None = None) -> None:
        self.failure = failure
        self.calls = []

    async def fetch(self, request):
        self.calls.append(request)
        if self.failure is not None:
            raise self.failure
        body = '<kml xmlns="http://www.opengis.net/kml/2.2"/>'
        return NetworkLinkFetchReceipt(
            request_url=request.request_url,
            final_url=request.request_url,
            status=200,
            redirects=0,
            dns_pinned=True,
            all_addresses_public=True,
            tls_verified=True,
            credentials_sent=False,
            media_type="application/vnd.google-earth.kml+xml",
            byte_length=len(body.encode()),
            fetched_at=datetime.now(UTC),
            expires_at=None,
            etag='"revision-2"',
            last_modified=None,
            body_text=body,
            body_base64=None,
        )


def request_payload(*, requested_at: datetime | None = None) -> dict[str, object]:
    return {
        "schema_version": "1.0.0",
        "link_id": "live-sites",
        "reason": "manual",
        "source_href": "https://data.opengeo.tools/live.kml?collection=sites",
        "request_url": "https://data.opengeo.tools/live.kml?collection=sites&bbox=1,2,3,4",
        "requested_at": (requested_at or datetime.now(UTC)).isoformat(),
        "maximum_bytes": 262_144,
        "timeout_milliseconds": 10_000,
        "accept": [
            "application/vnd.google-earth.kml+xml",
            "application/vnd.google-earth.kmz",
            "application/xml",
            "text/xml",
        ],
        "conditional": {"etag": '"revision-1"', "last_modified": None},
        "transport": {
            "credentials": "omit",
            "redirect": "error",
            "referrerPolicy": "no-referrer",
            "cache": "no-store",
        },
        "security_contract": "public-https-dns-pinned-no-redirect-no-credentials-v1",
    }


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "network-link-route-123",
    }


def api_client(
    repository: FakeWorkspaceRepository,
    fetcher: FakeFetcher,
    *,
    enabled: bool,
    gate: NetworkLinkRequestGate | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(
                env="test",
                expose_docs=True,
                kml_network_link_fetch_enabled=enabled,
            ),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            workspace_repository=repository,
            kml_network_link_fetcher=fetcher,  # type: ignore[arg-type]
            kml_network_link_request_gate=gate,
        )
    )


def test_route_is_absent_by_default_even_when_a_fetcher_is_injected() -> None:
    repository = FakeWorkspaceRepository()
    fetcher = FakeFetcher()
    client = api_client(repository, fetcher, enabled=False)

    response = client.post(
        f"/projects/{PROJECT_ID}/kml-network-links/refresh",
        headers=headers(),
        json=request_payload(),
    )

    assert response.status_code == 404
    assert repository.calls == []
    assert fetcher.calls == []
    assert "kml-network-links" not in client.get("/openapi.json").text


def test_database_configured_app_uses_the_distributed_gate_by_default() -> None:
    app = create_app(
        settings=Settings(
            env="test",
            database_url="postgresql://runtime:secret@database.example.test/opengeo",
        )
    )

    assert isinstance(app.state.kml_network_link_request_gate, PostgresNetworkLinkRequestGate)


def test_enabled_route_authorizes_project_before_fetch_and_returns_closed_receipt(
    monkeypatch,
) -> None:
    repository = FakeWorkspaceRepository()
    fetcher = FakeFetcher()
    client = api_client(repository, fetcher, enabled=True)
    log_calls: list[tuple[str, dict[str, object]]] = []

    class FakeLogger:
        def info(self, message: str, *, extra: dict[str, object]) -> None:
            log_calls.append((message, extra))

    monkeypatch.setattr(network_link_routes, "logger", FakeLogger())
    response = client.post(
        f"/projects/{PROJECT_ID}/kml-network-links/refresh",
        headers=headers(),
        json=request_payload(),
    )

    assert response.status_code == 200
    assert repository.calls == [
        (TenantContext(user_id=USER_ID, organization_id=ORG_ID), PROJECT_ID)
    ]
    assert len(fetcher.calls) == 1
    assert fetcher.calls[0].conditional.etag == '"revision-1"'
    assert response.json() == {
        "request_url": "https://data.opengeo.tools/live.kml?collection=sites&bbox=1,2,3,4",
        "final_url": "https://data.opengeo.tools/live.kml?collection=sites&bbox=1,2,3,4",
        "status": 200,
        "redirects": 0,
        "dns_pinned": True,
        "all_addresses_public": True,
        "tls_verified": True,
        "credentials_sent": False,
        "media_type": "application/vnd.google-earth.kml+xml",
        "byte_length": 45,
        "fetched_at": response.json()["fetched_at"],
        "expires_at": None,
        "etag": '"revision-2"',
        "last_modified": None,
        "body_text": '<kml xmlns="http://www.opengis.net/kml/2.2"/>',
        "body_base64": None,
    }
    message, fields = log_calls[0]
    assert message == "kml_network_link_fetch_completed"
    assert fields["target_sha256"]
    assert "request_url" not in fields
    assert "collection=sites" not in str(fields)


def test_denied_or_archived_project_never_reaches_the_fetcher() -> None:
    for repository, expected in [
        (FakeWorkspaceRepository(denied=True), 403),
        (FakeWorkspaceRepository(archived=True), 409),
    ]:
        fetcher = FakeFetcher()
        response = api_client(repository, fetcher, enabled=True).post(
            f"/projects/{PROJECT_ID}/kml-network-links/refresh",
            headers=headers(),
            json=request_payload(),
        )
        assert response.status_code == expected
        assert fetcher.calls == []


def test_route_rejects_stale_or_widened_client_contract_before_fetch() -> None:
    for patch in [
        {"requested_at": (datetime.now(UTC) - timedelta(minutes=2)).isoformat()},
        {"maximum_bytes": 262_145},
        {"timeout_milliseconds": 10_001},
        {"security_contract": "browser-direct"},
        {"transport": {"credentials": "include"}},
    ]:
        repository = FakeWorkspaceRepository()
        fetcher = FakeFetcher()
        payload = request_payload()
        payload.update(patch)
        response = api_client(repository, fetcher, enabled=True).post(
            f"/projects/{PROJECT_ID}/kml-network-links/refresh",
            headers=headers(),
            json=payload,
        )
        assert response.status_code == 422
        assert fetcher.calls == []


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        ("unsafe_network_target", 422),
        ("dns_resolution_failed", 502),
        ("redirect_rejected", 502),
        ("tls_verification_failed", 502),
        ("response_too_large", 502),
        ("request_timeout", 504),
    ],
)
def test_route_maps_only_sanitized_fetch_failures(failure: str, expected: int) -> None:
    fetcher = FakeFetcher(NetworkLinkFailure(failure))  # type: ignore[arg-type]
    response = api_client(FakeWorkspaceRepository(), fetcher, enabled=True).post(
        f"/projects/{PROJECT_ID}/kml-network-links/refresh",
        headers=headers(),
        json=request_payload(),
    )
    assert response.status_code == expected
    assert response.json() == {"detail": f"kml_network_link_{failure}"}
    assert "data.opengeo.tools" not in response.text


def test_request_gate_caps_rate_concurrency_and_refuses_limit_widening() -> None:
    key = (ORG_ID, PROJECT_ID, USER_ID)

    async def scenario() -> None:
        gate = NetworkLinkRequestGate(
            maximum_per_minute=2,
            maximum_per_key_concurrent=1,
            maximum_runtime_concurrent=1,
        )
        async with gate.slot(key):
            with pytest.raises(NetworkLinkGateFailure, match="network_link_busy"):
                async with gate.slot(key):
                    pass
        async with gate.slot(key):
            pass
        with pytest.raises(NetworkLinkGateFailure, match="network_link_rate_limited"):
            async with gate.slot(key):
                pass

    asyncio.run(scenario())
    with pytest.raises(ValueError, match="cannot be widened"):
        NetworkLinkRequestGate(maximum_per_minute=61)


def test_postgres_gate_acquires_and_releases_one_distributed_lease() -> None:
    class FakeExecutor:
        def __init__(self) -> None:
            self.calls: list[tuple[TenantContext, str, tuple[object, ...]]] = []

        async def fetch_one(self, context, statement, parameters=()):
            self.calls.append((context, statement, tuple(parameters)))
            if "acquire_kml_network_link_request_slot" in statement:
                return ("acquired",)
            if "release_kml_network_link_request_slot" in statement:
                return (True,)
            raise AssertionError("unexpected quota statement")

    executor = FakeExecutor()
    gate = PostgresNetworkLinkRequestGate(executor)  # type: ignore[arg-type]

    async def scenario() -> None:
        async with gate.slot((ORG_ID, PROJECT_ID, USER_ID)):
            assert len(executor.calls) == 1

    asyncio.run(scenario())
    assert len(executor.calls) == 2
    assert all(
        call[0] == TenantContext(user_id=USER_ID, organization_id=ORG_ID) for call in executor.calls
    )
    acquire_parameters = executor.calls[0][2]
    release_parameters = executor.calls[1][2]
    assert acquire_parameters == release_parameters
    assert acquire_parameters[1:] == (PROJECT_ID, USER_ID)


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ("rate_limited", "network_link_rate_limited"),
        ("busy", "network_link_busy"),
        ("unexpected", "network_link_gate_unavailable"),
    ],
)
def test_postgres_gate_fails_closed_for_quota_results(result: str, expected: str) -> None:
    class FakeExecutor:
        async def fetch_one(self, context, statement, parameters=()):
            del context, statement, parameters
            return (result,)

    async def scenario() -> None:
        gate = PostgresNetworkLinkRequestGate(FakeExecutor())  # type: ignore[arg-type]
        with pytest.raises(NetworkLinkGateFailure, match=expected):
            async with gate.slot((ORG_ID, PROJECT_ID, USER_ID)):
                pass

    asyncio.run(scenario())


def test_postgres_gate_fails_closed_when_database_is_unavailable() -> None:
    class UnavailableExecutor:
        async def fetch_one(self, context, statement, parameters=()):
            del context, statement, parameters
            raise TenantDatabaseUnavailable("unavailable")

    async def scenario() -> None:
        gate = PostgresNetworkLinkRequestGate(UnavailableExecutor())  # type: ignore[arg-type]
        with pytest.raises(NetworkLinkGateFailure, match="network_link_gate_unavailable"):
            async with gate.slot((ORG_ID, PROJECT_ID, USER_ID)):
                pass

    asyncio.run(scenario())


def test_route_returns_sanitized_503_when_the_distributed_gate_is_unavailable() -> None:
    class UnavailableGate:
        @asynccontextmanager
        async def slot(self, key):
            del key
            raise NetworkLinkGateFailure("network_link_gate_unavailable")
            yield

    response = api_client(
        FakeWorkspaceRepository(),
        FakeFetcher(),
        enabled=True,
        gate=UnavailableGate(),  # type: ignore[arg-type]
    ).post(
        f"/projects/{PROJECT_ID}/kml-network-links/refresh",
        headers=headers(),
        json=request_payload(),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "network_link_gate_unavailable"}
    assert response.headers["retry-after"] == "1"
    assert "data.opengeo.tools" not in response.text
