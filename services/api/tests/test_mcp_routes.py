import asyncio
import base64
import json
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from opengeo_api import mcp_routes
from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
from opengeo_api.config import Settings
from opengeo_api.mcp_auth import (
    require_mcp_session,
    require_mcp_settings,
    validate_mcp_origin,
)

PREFIX = "io.modelcontextprotocol/"
MODERN = "2026-07-28"
LEGACY = "2025-11-25"
MEMBERSHIP = OrganizationMembership(UUID("10000000-0000-4000-8000-000000000001"), "member")
SESSION = AuthSession(
    Principal(
        UUID("20000000-0000-4000-8000-000000000001"),
        "subject",
        "reader@example.test",
        "Reader",
        (MEMBERSHIP,),
    ),
    MEMBERSHIP,
)


@pytest.fixture
def transport(monkeypatch):
    app = FastAPI()
    app.state.settings = Settings(
        env="test",
        cognito_region="us-east-1",
        cognito_user_pool_id="us-east-1_example",
        cognito_client_id="test-client",
        mcp_resource_url="https://api.example.invalid/mcp",
        mcp_allowed_origins="https://studio.example.invalid",
    )
    app.state.ingestion_repository = object()
    app.state.workspace_repository = object()
    calls = []

    async def authorized(request: Request):
        validate_mcp_origin(request, require_mcp_settings(request))
        return SESSION

    async def execute(session, name, arguments, **repositories):
        calls.append((session, name, arguments, repositories))
        return {"projects": [], "limit": 20, "offset": 0, "returned": 0}

    app.dependency_overrides[require_mcp_session] = authorized
    app.include_router(mcp_routes.router)
    monkeypatch.setattr(mcp_routes, "execute_read_tool", execute)
    mcp_routes._tool_calls.clear()
    yield TestClient(app), calls
    mcp_routes._tool_calls.clear()


def message(method="server/discover", *, version=MODERN, identifier=1, **params):
    if version == MODERN:
        params["_meta"] = {PREFIX + "protocolVersion": MODERN, PREFIX + "clientCapabilities": {}}
    return {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}


def headers(method="server/discover", *, version=MODERN, name=None):
    result = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": version}
    if version == MODERN:
        result["Mcp-Method"] = method
        if name is not None:
            result["Mcp-Name"] = name
    return result


def call(client, method="server/discover", *, version=MODERN, **params):
    return client.post(
        "/mcp",
        json=message(method, version=version, **params),
        headers=headers(method, version=version, name=params.get("name")),
    )


def test_current_discovery_is_stateless_and_does_not_require_client_info(transport):
    client, calls = transport
    response = call(client)
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["supportedVersions"] == [MODERN, LEGACY]
    assert result["capabilities"] == {"tools": {}}
    assert result["resultType"] == "complete"
    assert result["_meta"][PREFIX + "serverInfo"]["name"] == "opengeo"
    assert response.headers["cache-control"] == "no-store"
    assert "mcp-session-id" not in response.headers
    assert calls == []


def test_legacy_initialize_initialized_and_following_independent_requests(transport):
    client, _ = transport
    initialize = message(
        "initialize",
        version=LEGACY,
        protocolVersion="2024-11-05",
        capabilities={},
        clientInfo={"name": "legacy-ide", "version": "1"},
    )
    response = client.post(
        "/mcp", json=initialize, headers={"Accept": "application/json, text/event-stream"}
    )
    assert response.status_code == 200
    assert response.json()["result"]["protocolVersion"] == LEGACY
    assert "resultType" not in response.json()["result"]
    assert "mcp-session-id" not in response.headers
    initialized = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    response = client.post("/mcp", json=initialized, headers=headers(version=LEGACY))
    assert response.status_code == 202
    assert response.content == b""
    assert call(client, "ping", version=LEGACY).json()["result"] == {}
    assert len(call(client, "tools/list", version=LEGACY).json()["result"]["tools"]) == 4


@pytest.mark.parametrize("version", [MODERN, LEGACY])
def test_tool_call_bridges_verified_session_and_repositories_with_compatible_content(
    transport, version
):
    client, calls = transport
    response = call(
        client, "tools/call", version=version, name="list_projects", arguments={"limit": 20}
    )
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["isError"] is False
    assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
    assert calls == [
        (
            SESSION,
            "list_projects",
            {"limit": 20},
            {
                "ingestion_repository": client.app.state.ingestion_repository,
                "workspace_repository": client.app.state.workspace_repository,
            },
        )
    ]


def test_current_header_name_encoded_sentinel_matches_tool_name(transport):
    client, calls = transport
    request_headers = headers(
        "tools/call", name="=?base64?" + base64.b64encode(b"list_projects").decode() + "?="
    )
    response = client.post(
        "/mcp", json=message("tools/call", name="list_projects"), headers=request_headers
    )
    assert response.status_code == 200
    assert len(calls) == 1


@pytest.mark.parametrize(
    "header,value,code",
    [
        ("MCP-Protocol-Version", None, -32020),
        ("MCP-Protocol-Version", "2099-01-01", -32022),
        ("Mcp-Method", None, -32020),
        ("Mcp-Method", "tools/list", -32020),
        ("Mcp-Name", None, -32020),
        ("Mcp-Name", "get_project", -32020),
        ("Mcp-Name", "=?base64?!!!?=", -32020),
    ],
)
def test_current_required_header_mirrors_fail_before_tool_execution(transport, header, value, code):
    client, calls = transport
    request_headers = headers("tools/call", name="list_projects")
    if value is None:
        del request_headers[header]
    else:
        request_headers[header] = value
    response = client.post(
        "/mcp", json=message("tools/call", name="list_projects"), headers=request_headers
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == code
    if code == -32022:
        assert response.json()["error"]["data"] == {
            "supported": [MODERN, LEGACY],
            "requested": value,
        }
    assert calls == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("protocolVersion", None),
        ("clientCapabilities", None),
        ("clientCapabilities", []),
        ("clientInfo", None),
        ("clientInfo", {"name": "ide"}),
    ],
)
def test_current_metadata_schema_is_validated(transport, field, value):
    client, _ = transport
    body = message()
    body["params"]["_meta"][PREFIX + field] = value
    response = client.post("/mcp", json=body, headers=headers())
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32602


def test_unknown_rpc_and_tool_and_invalid_call_envelopes_are_protocol_errors(transport):
    client, calls = transport
    unknown = call(client, "resources/list")
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == -32601
    for params in (
        {"name": "write_project"},
        {"name": "list_projects", "arguments": []},
        {"name": "list_projects", "account_id": "client-cannot-choose"},
    ):
        response = call(client, "tools/call", **params)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == -32602
    assert calls == []


@pytest.mark.parametrize("status", [403, 404, 409, 413, 422, 503])
def test_repository_and_tool_validation_failures_are_sanitized_tool_results(
    transport, monkeypatch, status
):
    client, _ = transport

    async def rejected(*args, **kwargs):
        raise HTTPException(status, detail="private-source-and-query")

    monkeypatch.setattr(mcp_routes, "execute_read_tool", rejected)
    response = call(client, "tools/call", name="list_projects")
    assert response.status_code == 200
    assert response.json()["result"]["isError"] is True
    assert "private-source-and-query" not in response.text
    assert "structuredContent" not in response.json()["result"]


@pytest.mark.parametrize(
    "body,code",
    [
        ('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600),
        ('{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}', -32700),
        ('{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600),
        ('{"jsonrpc":"2.0","id":true,"method":"ping"}', -32600),
        ('{"jsonrpc":"2.0","id":1,"method":"ping","extra":1}', -32600),
        ('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":NaN}}', -32700),
    ],
)
def test_bounded_single_request_envelope_rejects_ambiguous_json(transport, body, code):
    client, calls = transport
    response = client.post(
        "/mcp", content=body, headers={**headers("ping"), "Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == code
    assert calls == []


def test_request_body_and_structure_and_accept_limits(transport):
    client, calls = transport
    response = client.post(
        "/mcp",
        content=b" " * (mcp_routes.MAX_REQUEST_BYTES + 1),
        headers={**headers(), "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    body = message()
    body["params"]["_meta"]["nested"] = [[[[[[[[[[[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]]]]]]]]]]
    response = client.post("/mcp", json=body, headers=headers())
    assert response.status_code == 400
    assert "limits" in response.json()["error"]["message"]
    for accept in ("application/json", "application/json, text/event-stream;q=0"):
        response = client.post("/mcp", json=message(), headers={**headers(), "Accept": accept})
        assert response.status_code == 406
    assert calls == []


def test_origin_and_no_stream_no_session_method_boundary(transport):
    client, _ = transport
    for method in ("POST", "GET", "DELETE"):
        response = client.request(
            method,
            "/mcp",
            json=message(),
            headers={**headers(), "Origin": "https://attacker.invalid"},
        )
        assert response.status_code == 403
    response = client.post(
        "/mcp", json=message(), headers={**headers(), "Origin": "https://studio.example.invalid"}
    )
    assert response.status_code == 200
    for method in ("GET", "DELETE"):
        response = client.request(method, "/mcp", headers={"Mcp-Session-Id": "ignored"})
        assert response.status_code == 405
        assert response.headers["allow"] == "POST"
        assert "mcp-session-id" not in response.headers
    client.app.state.settings = Settings(env="test")
    assert call(client).status_code == 404
    assert client.get("/mcp").status_code == 404


def test_tool_rate_limit_does_not_block_discovery(transport, monkeypatch):
    client, calls = transport
    monkeypatch.setattr(mcp_routes, "TOOL_CALLS_PER_MINUTE", 1)
    assert call(client, "tools/call", name="list_projects").status_code == 200
    limited = call(client, "tools/call", name="list_projects")
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert len(calls) == 1
    assert call(client).status_code == 200


def test_tool_timeout_and_oversize_response_are_explicit_without_partial_data(
    transport, monkeypatch
):
    client, _ = transport

    async def slow(*args, **kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(mcp_routes, "TOOL_TIMEOUT_SECONDS", 0.001)
    monkeypatch.setattr(mcp_routes, "execute_read_tool", slow)
    response = call(client, "tools/call", name="list_projects")
    assert response.json()["result"]["isError"] is True
    assert "timed out" in response.json()["result"]["content"][0]["text"]

    async def oversized(*args, **kwargs):
        return {"data": "private-long-result" * 100}

    monkeypatch.setattr(mcp_routes, "execute_read_tool", oversized)
    monkeypatch.setattr(mcp_routes, "MAX_RESPONSE_BYTES", 1024)
    response = call(client, "tools/call", name="list_projects")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == -32603
    assert "private-long-result" not in response.text
