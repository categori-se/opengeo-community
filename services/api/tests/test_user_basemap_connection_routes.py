import asyncio
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from uuid import UUID

import anyio.to_thread
import pytest
from fastapi import FastAPI

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.user_basemap_connections import (
    ProjectBasemapConnectionBinding,
    ResolvedBasemapStyle,
    UserBasemapConnection,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000056")
ORG_ID = UUID("10000000-0000-4000-8000-000000000056")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000056")
CONNECTION_ID = UUID("c0000000-0000-4000-8000-000000000056")
BINDING_ID = UUID("c1000000-0000-4000-8000-000000000056")
NOW = datetime(2026, 8, 26, 20, tzinfo=UTC)


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
            email="2301690+aaronkyle@users.noreply.github.com",
            display_name="Aaron Dennis",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


def connection(**changes) -> UserBasemapConnection:
    record = UserBasemapConnection(
        connection_id=CONNECTION_ID,
        owner_user_id=USER_ID,
        provider="protomaps",
        display_name="Protomaps hosted API",
        allowed_origins=("https://studio.opengeo.tools",),
        configured_secret_fields=(),
        credential_revision=0,
        status="draft",
        created_at=NOW,
        updated_at=NOW,
        owned_by_caller=True,
    )
    return replace(record, **changes)


def binding() -> ProjectBasemapConnectionBinding:
    return ProjectBasemapConnectionBinding(
        binding_id=BINDING_ID,
        project_id=PROJECT_ID,
        display_name="Project basemap",
        created_by=USER_ID,
        created_at=NOW,
        connection=connection(
            configured_secret_fields=("api_key",),
            credential_revision=1,
            status="configured",
        ),
    )


class FakeRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_my_connections(self, context):
        self.calls.append(("list", context))
        return (connection(),)

    async def create_connection(self, context, draft, request_id):
        self.calls.append(("create", context, draft, request_id))
        return connection(
            display_name=draft.display_name,
            allowed_origins=draft.allowed_origins,
        )

    async def update_connection(self, context, connection_id, changes, request_id):
        self.calls.append(("update", context, connection_id, changes, request_id))
        return connection(**changes)

    async def rotate_api_key(self, context, connection_id, expected_revision, api_key, request_id):
        self.calls.append(
            ("rotate", context, connection_id, expected_revision, api_key, request_id)
        )
        return connection(
            configured_secret_fields=("api_key",),
            credential_revision=1,
            status="configured",
        )

    async def list_project_bindings(self, context, project_id):
        self.calls.append(("list_bindings", context, project_id))
        return (binding(),)

    async def create_project_binding(
        self, context, project_id, connection_id, display_name, request_id
    ):
        self.calls.append(("bind", context, project_id, connection_id, display_name, request_id))
        return binding()

    async def remove_project_binding(self, context, project_id, binding_id, request_id):
        self.calls.append(("unbind", context, project_id, binding_id, request_id))

    async def resolve_style(self, context, project_id, binding_id, flavor, request_id):
        self.calls.append(("resolve", context, project_id, binding_id, flavor, request_id))
        return ResolvedBasemapStyle(
            binding_id=BINDING_ID,
            connection_id=CONNECTION_ID,
            provider="protomaps",
            connection_name="Protomaps hosted API",
            flavor=flavor,
            resource_kind="maplibre-style",
            resource_url=(
                f"https://api.protomaps.com/styles/v5/{flavor}/en.json?"
                "key=client-visible-browser-key"
            ),
            attribution="Protomaps · © OpenStreetMap contributors",
            credential_revision=1,
        )


class CartoRepository(FakeRepository):
    async def resolve_style(self, context, project_id, binding_id, flavor, request_id):
        self.calls.append(("resolve", context, project_id, binding_id, flavor, request_id))
        return ResolvedBasemapStyle(
            binding_id=BINDING_ID,
            connection_id=CONNECTION_ID,
            provider="carto",
            connection_name="CARTO basemaps",
            flavor=flavor,
            resource_kind="raster",
            resource_url=(
                "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?"
                "key=client-visible-browser-key"
            ),
            attribution="© CARTO · © OpenStreetMap contributors",
            credential_revision=1,
        )


def api_app(repository: FakeRepository) -> FastAPI:
    return create_app(
        settings=Settings(env="test", expose_docs=True),
        readiness_probe=PassingProbe(),
        token_verifier=FakeVerifier(),
        principal_repository=FakePrincipalRepository(),
        user_basemap_connection_repository=repository,
    )


@dataclass(frozen=True)
class AsgiResponse:
    status_code: int
    content: bytes
    headers: dict[str, str]

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
    json_body: dict | None = None,
) -> AsgiResponse:
    body = b"" if json_body is None else json.dumps(json_body).encode()
    headers = [
        ("authorization", "Bearer valid-token"),
        ("x-opengeo-organization", str(ORG_ID)),
        ("x-request-id", "request-basemap-connection-56"),
    ]
    if json_body is not None:
        headers.extend([("content-type", "application/json"), ("content-length", str(len(body)))])

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
                "scheme": "https",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": [(key.encode(), value.encode()) for key, value in headers],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 443),
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
        response_headers = {
            key.decode().lower(): value.decode() for key, value in start.get("headers", [])
        }
        return AsgiResponse(start["status"], response_body, response_headers)

    return asyncio.run(invoke())


def test_metadata_creation_normalizes_origins_without_accepting_a_key() -> None:
    repository = FakeRepository()
    response = request(
        api_app(repository),
        "POST",
        "/me/basemap-connections",
        json_body={
            "display_name": " Protomaps hosted API ",
            "allowed_origins": ["HTTPS://STUDIO.OPENGEO.TOOLS/"],
        },
    )

    assert response.status_code == 201
    assert response.json()["allowed_origins"] == ["https://studio.opengeo.tools"]
    assert response.json()["browser_key_exposure"] == "client_visible"
    assert "api_key" not in response.text
    assert repository.calls[0][2].allowed_origins == ("https://studio.opengeo.tools",)


def test_browser_key_rotation_is_write_only_in_connection_metadata() -> None:
    repository = FakeRepository()
    response = request(
        api_app(repository),
        "PUT",
        f"/me/basemap-connections/{CONNECTION_ID}/browser-key",
        json_body={
            "expected_credential_revision": 0,
            "api_key": "client-visible-browser-key",
        },
    )

    assert response.status_code == 200
    assert response.json()["credential_revision"] == 1
    assert response.json()["configured_secret_fields"] == ["api_key"]
    assert "client-visible-browser-key" not in response.text
    assert repository.calls[0][4] == "client-visible-browser-key"


def test_authorized_style_resolution_is_explicitly_client_visible_and_no_store() -> None:
    repository = FakeRepository()
    response = request(
        api_app(repository),
        "GET",
        f"/projects/{PROJECT_ID}/basemap-connection-bindings/{BINDING_ID}/styles/dark",
    )

    assert response.status_code == 200
    assert response.json()["browser_key_exposure"] == "client_visible"
    assert response.json()["resource_kind"] == "maplibre-style"
    assert response.json()["resource_url"].endswith("?key=client-visible-browser-key")
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_authorized_carto_resolution_returns_a_bounded_keyed_raster_template() -> None:
    repository = CartoRepository()
    response = request(
        api_app(repository),
        "GET",
        f"/projects/{PROJECT_ID}/basemap-connection-bindings/{BINDING_ID}/styles/positron",
    )

    assert response.status_code == 200
    assert response.json()["provider"] == "carto"
    assert response.json()["resource_kind"] == "raster"
    assert response.json()["resource_url"] == (
        "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=client-visible-browser-key"
    )
    assert response.headers["cache-control"] == "private, no-store"


def test_invalid_origin_paths_duplicate_origins_and_short_keys_are_rejected() -> None:
    app = api_app(FakeRepository())
    path_origin = request(
        app,
        "POST",
        "/me/basemap-connections",
        json_body={
            "display_name": "Bad origin",
            "allowed_origins": ["https://studio.opengeo.tools/path"],
        },
    )
    duplicates = request(
        app,
        "POST",
        "/me/basemap-connections",
        json_body={
            "display_name": "Duplicate origin",
            "allowed_origins": [
                "https://studio.opengeo.tools",
                "https://STUDIO.OPENGEO.TOOLS/",
            ],
        },
    )
    short_key = request(
        app,
        "PUT",
        f"/me/basemap-connections/{CONNECTION_ID}/browser-key",
        json_body={"expected_credential_revision": 0, "api_key": "short"},
    )

    assert path_origin.status_code == 422
    assert duplicates.status_code == 422
    assert short_key.status_code == 422


def test_openapi_exposes_account_binding_and_style_resolution_contracts() -> None:
    paths = request(api_app(FakeRepository()), "GET", "/openapi.json").json()["paths"]
    assert {
        "/me/basemap-connections",
        "/me/basemap-connections/{connection_id}",
        "/me/basemap-connections/{connection_id}/browser-key",
        "/projects/{project_id}/basemap-connection-bindings",
        "/projects/{project_id}/basemap-connection-bindings/{binding_id}",
        "/projects/{project_id}/basemap-connection-bindings/{binding_id}/styles/{flavor}",
    } <= set(paths)
