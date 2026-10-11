import asyncio
import base64
import json
from collections.abc import Mapping
from typing import Any

import pytest

from opengeo_api.app import create_app
from opengeo_api.config import Settings
from opengeo_api.lambda_handler import ApiGatewayV2Adapter, _preflight_response
from opengeo_api.lambda_runtime import LambdaRuntimeContext, resolve_handler


def event(**changes: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "version": "2.0",
        "rawPath": "/echo",
        "rawQueryString": "tag=roads&tag=water",
        "headers": {
            "content-type": "application/octet-stream",
            "x-forwarded-proto": "https",
        },
        "cookies": ["session=abc", "theme=dark"],
        "requestContext": {
            "domainName": "api.example.test",
            "http": {
                "method": "POST",
                "path": "/echo",
                "protocol": "HTTP/1.1",
                "sourceIp": "192.0.2.10",
            },
        },
        "body": base64.b64encode(b"\x00opengeo\xff").decode(),
        "isBase64Encoded": True,
    }
    value.update(changes)
    return value


def test_adapter_preserves_request_scope_body_and_binary_response() -> None:
    observed: dict[str, Any] = {}

    async def application(scope, receive, send) -> None:
        observed["scope"] = scope
        observed["request"] = await receive()
        await send(
            {
                "type": "http.response.start",
                "status": 201,
                "headers": [
                    (b"content-type", b"application/octet-stream"),
                    (b"set-cookie", b"download=ready; Secure"),
                    (b"x-value", b"one"),
                    (b"x-value", b"two"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"\x00result\xff"})

    response = asyncio.run(ApiGatewayV2Adapter(application).invoke(event()))

    scope = observed["scope"]
    assert scope["method"] == "POST"
    assert scope["path"] == "/echo"
    assert scope["query_string"] == b"tag=roads&tag=water"
    assert scope["server"] == ("api.example.test", 443)
    assert scope["client"] == ("192.0.2.10", 0)
    assert (b"cookie", b"session=abc; theme=dark") in scope["headers"]
    assert observed["request"] == {
        "type": "http.request",
        "body": b"\x00opengeo\xff",
        "more_body": False,
    }
    assert response == {
        "statusCode": 201,
        "headers": {
            "content-type": "application/octet-stream",
            "x-value": "one,two",
        },
        "cookies": ["download=ready; Secure"],
        "body": base64.b64encode(b"\x00result\xff").decode(),
        "isBase64Encoded": True,
    }


def test_adapter_collects_streamed_response_body() -> None:
    async def application(scope, receive, send) -> None:
        del scope, receive
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"open", "more_body": True})
        await send({"type": "http.response.body", "body": b"geo"})

    response = asyncio.run(ApiGatewayV2Adapter(application).invoke(event(body=None)))

    assert base64.b64decode(response["body"]) == b"opengeo"


def test_adapter_waits_for_terminal_body_before_reporting_disconnect() -> None:
    async def application(scope, receive, send) -> None:
        del scope
        await receive()
        disconnected = asyncio.create_task(receive())
        try:
            await asyncio.sleep(0)
            assert not disconnected.done()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"open", "more_body": True})
            await asyncio.sleep(0)
            assert not disconnected.done()
            await send({"type": "http.response.body", "body": b"geo"})
            assert await asyncio.wait_for(disconnected, 1) == {"type": "http.disconnect"}
        finally:
            if not disconnected.done():
                disconnected.cancel()
            await asyncio.gather(disconnected, return_exceptions=True)

    response = asyncio.run(ApiGatewayV2Adapter(application).invoke(event(body=None)))

    assert base64.b64decode(response["body"]) == b"opengeo"


def test_adapter_preserves_fastapi_streaming_response_and_cleanup() -> None:
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse

    application = FastAPI()
    observed = []

    async def chunks():
        try:
            yield b"open"
            await asyncio.sleep(0.01)
            yield b"geo"
        finally:
            observed.append("closed")

    @application.post("/echo")
    async def streaming():
        return StreamingResponse(chunks(), media_type="text/plain")

    response = asyncio.run(
        asyncio.wait_for(ApiGatewayV2Adapter(application).invoke(event(body=None)), 1)
    )

    assert response["statusCode"] == 200
    assert base64.b64decode(response["body"]) == b"opengeo"
    assert observed == ["closed"]


def test_adapter_preserves_analysis_preview_longer_than_disconnect_poll() -> None:
    from uuid import UUID

    from fastapi import FastAPI

    from opengeo_api.auth_models import AuthSession, OrganizationMembership, Principal
    from opengeo_api.feature_routes import current_session, repository_from_request, router

    owner = UUID("20000000-0000-4000-8000-000000000121")
    organization = UUID("10000000-0000-4000-8000-000000000121")
    workspace = UUID("50000000-0000-4000-8000-000000000121")
    dataset = UUID("80000000-0000-4000-8000-000000000121")
    membership = OrganizationMembership(organization, "member")
    session = AuthSession(
        Principal(owner, "fixture", "owner@example.test", "Owner", (membership,)),
        membership,
    )
    observed = []

    class DelayedRepository:
        async def preview_analysis(self, context, project_id, dataset_id, request):
            assert context.user_id == owner and context.organization_id == organization
            assert project_id == workspace and dataset_id == dataset
            assert request.operation == "centroid" and request.source_generation == 1
            await asyncio.sleep(0.15)
            observed.append("completed")
            return {"type": "FeatureCollection", "features": []}

    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[current_session] = lambda: session
    application.dependency_overrides[repository_from_request] = lambda: DelayedRepository()
    request = event(
        rawPath=f"/projects/{workspace}/datasets/{dataset}/analysis-preview",
        rawQueryString="",
        headers={"content-type": "application/json"},
        cookies=[],
        body=json.dumps({"operation": "centroid", "source_generation": 1}),
        isBase64Encoded=False,
    )

    response = asyncio.run(asyncio.wait_for(ApiGatewayV2Adapter(application).invoke(request), 2))

    assert response["statusCode"] == 200
    assert response["headers"]["cache-control"] == "private, no-store"
    assert json.loads(base64.b64decode(response["body"])) == {
        "type": "FeatureCollection",
        "features": [],
    }
    assert observed == ["completed"]


def test_adapter_rejects_response_body_over_lambda_boundary() -> None:
    async def application(scope, receive, send) -> None:
        del scope, receive
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"x" * 4_194_305})

    with pytest.raises(RuntimeError, match="response body"):
        asyncio.run(ApiGatewayV2Adapter(application).invoke(event(body=None)))


def test_adapter_runs_the_real_fastapi_middleware_and_liveness_route() -> None:
    application = create_app(Settings(env="test"))
    request = event(
        rawPath="/health/live",
        rawQueryString="",
        headers={"x-request-id": "lambda-request-1"},
        cookies=[],
        body=None,
        isBase64Encoded=False,
        requestContext={
            "domainName": "api.example.test",
            "http": {
                "method": "GET",
                "path": "/health/live",
                "protocol": "HTTP/1.1",
                "sourceIp": "192.0.2.10",
            },
        },
    )

    response = asyncio.run(
        asyncio.wait_for(ApiGatewayV2Adapter(application).invoke(request), timeout=5)
    )

    assert response["statusCode"] == 200
    assert response["headers"]["x-request-id"] == "lambda-request-1"
    assert json.loads(base64.b64decode(response["body"])) == {
        "status": "ok",
        "service": "opengeo-api",
        "version": "0.1.0",
    }


@pytest.mark.parametrize(
    "invalid_event",
    [
        {},
        event(version="1.0"),
        event(rawPath="relative"),
        event(body="not-base64!", isBase64Encoded=True),
        event(headers={"x-invalid": object()}),
        event(headers={"x-large": "x" * 8193}),
        event(cookies=["x" * 16_385]),
        event(body=base64.b64encode(b"x" * 524_290).decode(), isBase64Encoded=True),
    ],
)
def test_adapter_rejects_invalid_gateway_events(invalid_event: Mapping[str, Any]) -> None:
    async def application(scope, receive, send) -> None:
        del scope, receive, send

    with pytest.raises(ValueError):
        asyncio.run(ApiGatewayV2Adapter(application).invoke(invalid_event))


def test_runtime_resolves_only_a_bounded_callable_reference() -> None:
    handler = resolve_handler("opengeo_api.lambda_handler.handler")

    assert callable(handler)
    with pytest.raises(ValueError, match="reference"):
        resolve_handler("opengeo_api.lambda_handler:handler")
    with pytest.raises(ValueError, match="callable"):
        resolve_handler("opengeo_api.lambda_handler.base64")


def test_runtime_context_reports_nonnegative_remaining_time(monkeypatch) -> None:
    monkeypatch.setattr("time.time", lambda: 100.0)
    context = LambdaRuntimeContext("request-1", 101_250, "arn:function")

    assert context.get_remaining_time_in_millis() == 1_250


def test_gateway_response_is_json_serializable() -> None:
    async def application(scope, receive, send) -> None:
        del scope, receive
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    response = asyncio.run(ApiGatewayV2Adapter(application).invoke(event()))

    assert json.loads(json.dumps(response))["statusCode"] == 204


def test_preflight_response_is_bounded_and_does_not_require_the_application() -> None:
    request = event(
        rawPath="/teams",
        rawQueryString="",
        headers={
            "origin": "http://127.0.0.1:3000",
            "access-control-request-method": "GET",
        },
        cookies=[],
        body=None,
        isBase64Encoded=False,
        requestContext={
            "domainName": "api.example.test",
            "http": {
                "method": "OPTIONS",
                "path": "/teams",
                "protocol": "HTTP/1.1",
                "sourceIp": "192.0.2.10",
            },
        },
    )

    assert _preflight_response(request) == {
        "statusCode": 204,
        "headers": {},
        "body": "",
        "isBase64Encoded": True,
    }
    assert _preflight_response(event()) is None

    request["rawPath"] = "relative"
    with pytest.raises(ValueError, match="path"):
        _preflight_response(request)


def test_default_lambda_adapter_runs_lifespan_per_event_loop_and_cleans_failure(
    monkeypatch,
) -> None:
    from contextlib import asynccontextmanager

    from fastapi import FastAPI

    from opengeo_api import app as app_module
    from opengeo_api import lambda_handler

    events = []
    active = []

    @asynccontextmanager
    async def lifespan(_app):
        loop = asyncio.get_running_loop()
        assert not active
        active.append(loop)
        events.append("open")
        try:
            yield
        finally:
            assert active.pop() is loop
            events.append("close")

    application = FastAPI(lifespan=lifespan)

    @application.post("/echo")
    async def echo():
        assert active == [asyncio.get_running_loop()]
        events.append("request")
        return {"ok": True}

    @application.post("/failure")
    async def failure():
        assert active
        raise RuntimeError("bounded failure")

    monkeypatch.setattr(app_module, "create_app", lambda: application)
    lambda_handler._default_adapter.cache_clear()
    try:
        assert lambda_handler.handler(event(), None)["statusCode"] == 200
        assert lambda_handler.handler(event(), None)["statusCode"] == 200
        with pytest.raises(RuntimeError, match="bounded failure"):
            lambda_handler.handler(event(rawPath="/failure"), None)
        assert events == ["open", "request", "close", "open", "request", "close", "open", "close"]
        assert active == []
    finally:
        lambda_handler._default_adapter.cache_clear()


@pytest.mark.parametrize(
    ("method", "path", "selected"),
    [
        ("GET", "/auth/session", "session"),
        ("get", "/auth/session", "session"),
        ("HEAD", "/auth/session", "full"),
        ("POST", "/auth/session", "full"),
        ("GET", "/auth/session/", "full"),
        ("GET", "/auth/session-other", "full"),
        ("GET", "/organizations/current", "session"),
        ("get", "/organizations/current", "session"),
        ("HEAD", "/organizations/current", "full"),
        ("POST", "/organizations/current", "full"),
        ("GET", "/organizations/current/", "full"),
        ("GET", "/organizations/current/memberships", "full"),
    ],
)
def test_lambda_dispatches_only_exact_validated_account_gets(
    monkeypatch, method, path, selected
):
    from opengeo_api import lambda_handler

    calls = []

    class Adapter:
        def __init__(self, name):
            self.name = name

        async def invoke(self, _event):
            calls.append(self.name)
            return {"statusCode": 200}

    monkeypatch.setattr(lambda_handler, "_session_adapter", lambda: Adapter("session"))
    monkeypatch.setattr(lambda_handler, "_default_adapter", lambda: Adapter("full"))
    request = event(rawPath=path)
    request["requestContext"]["http"]["method"] = method
    assert lambda_handler.handler(request, None)["statusCode"] == 200
    assert calls == [selected]
    request["version"] = "1.0"
    with pytest.raises(ValueError, match="payload format"):
        lambda_handler.handler(request, None)
    assert calls == [selected]


@pytest.mark.parametrize("path", ["/auth/session", "/organizations/current"])
def test_session_lambda_handler_uses_actual_lean_authentication_boundary(monkeypatch, path):
    from opengeo_api import lambda_handler, session_app

    monkeypatch.setattr(session_app, "get_settings", lambda: Settings(env="test"))

    def reject_full_adapter():
        pytest.fail("The session GET must use the actual lean application")

    monkeypatch.setattr(lambda_handler, "_default_adapter", reject_full_adapter)
    lambda_handler._session_adapter.cache_clear()
    request = event(
        rawPath=path,
        rawQueryString="",
        headers={},
        cookies=[],
        body=None,
        isBase64Encoded=False,
    )
    request["requestContext"]["http"].update(method="GET", path=path)
    try:
        response = lambda_handler.handler(request, None)
        assert response["statusCode"] == 401
        assert json.loads(base64.b64decode(response["body"])) == {"detail": "invalid_token"}
        assert response["headers"]["www-authenticate"] == 'Bearer error="invalid_token"'
        assert response["headers"]["x-request-id"]
        assert lambda_handler._session_adapter.cache_info().currsize == 1
    finally:
        lambda_handler._session_adapter.cache_clear()


def test_account_lambda_handler_keeps_fresh_principal_and_tenant_transaction(monkeypatch):
    from uuid import UUID

    from opengeo_api import lambda_handler, session_app
    from opengeo_api.auth_models import VerifiedAccessToken
    from opengeo_api.rds_data import RdsDataApiClient
    from test_rds_data import FakeTransport, StaticCredentials, settings

    user = "20000000-0000-4000-8000-000000000001"
    organization = "10000000-0000-4000-8000-000000000001"
    principal_response = {"columnMetadata": [{"typeName": "text"}] * 5,
        "records": [[{"stringValue": value} for value in
        [user, "ada@example.test", "Ada", organization, "admin"]]]}
    transport = FakeTransport([
        (200, {}, principal_response),
        (200, {}, {"transactionId": "bootstrap-transaction"}),
        (200, {}, {"records": []}),
        (200, {}, {"columnMetadata": [{"typeName": "text"}] * 4,
            "records": [[{"stringValue": value} for value in
            [organization, "Organization A", "organization-a", "active"]]]}),
        (200, {}, {}),
        # A subsequent changed/forged account must recheck the principal first.
        (200, {}, principal_response),
    ])
    config = settings()
    data_client = RdsDataApiClient(config, StaticCredentials(), transport)

    class Verifier:
        async def verify(self, token):
            assert token == "valid-token"
            return VerifiedAccessToken("subject-123", "client-123", None, (), ())

    original_factory = session_app.create_session_app
    monkeypatch.setattr(session_app, "RdsDataApiClient", lambda _settings: data_client)
    monkeypatch.setattr(session_app, "create_session_app",
        lambda: original_factory(config, Verifier()))
    monkeypatch.setattr(lambda_handler, "_default_adapter",
        lambda: pytest.fail("Account bootstrap must not import the full API"))
    lambda_handler._session_adapter.cache_clear()
    request = event(rawPath="/organizations/current", rawQueryString="", cookies=[],
        headers={"authorization": "Bearer valid-token",
                 "x-opengeo-organization": organization}, body=None, isBase64Encoded=False)
    request["requestContext"]["http"]["method"] = "GET"
    try:
        response = lambda_handler.handler(request, None)
        assert response["statusCode"] == 200
        assert json.loads(base64.b64decode(response["body"]))["caller_role"] == "admin"
        assert [call[0].rsplit("/", 1)[-1] for call in transport.calls] == [
            "Execute", "BeginTransaction", "Execute", "Execute", "CommitTransaction"]
        context_parameters = transport.calls[2][2]["parameters"]
        assert context_parameters[0]["value"] == {"stringValue": user}
        assert context_parameters[1]["value"] == {"stringValue": organization}
        request["headers"]["x-opengeo-organization"] = str(UUID(int=99))
        assert lambda_handler.handler(request, None)["statusCode"] == 403
        assert len(transport.calls) == 6
        assert "resolve_principal" in transport.calls[-1][2]["sql"]
    finally:
        lambda_handler._session_adapter.cache_clear()
