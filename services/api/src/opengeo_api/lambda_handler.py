import asyncio
import base64
import binascii
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager, nullcontext
from functools import lru_cache
from typing import Any, Protocol, cast

AsgiMessage = dict[str, Any]
AsgiReceive = Callable[[], Awaitable[AsgiMessage]]
AsgiSend = Callable[[AsgiMessage], Awaitable[None]]
_MAX_REQUEST_BODY_BYTES = 524_289
_MAX_RESPONSE_BODY_BYTES = 4_194_304
_MAX_HEADER_BYTES = 32_768
_MAX_COOKIE_BYTES = 16_384


class AsgiApplication(Protocol):
    async def __call__(
        self,
        scope: dict[str, Any],
        receive: AsgiReceive,
        send: AsgiSend,
    ) -> None: ...


class ApiGatewayV2Adapter:
    """Translate an API Gateway HTTP API payload-v2 event to one ASGI request."""

    def __init__(
        self,
        application: AsgiApplication,
        *,
        invocation_scope: Callable[[], AbstractAsyncContextManager[Any]] | None = None,
    ) -> None:
        self._application = application
        self._invocation_scope = invocation_scope or nullcontext

    async def invoke(self, event: Mapping[str, Any]) -> dict[str, Any]:
        scope, request_body = self._request(event)
        request_sent = False
        response_started = False
        status_code = 500
        response_headers: list[tuple[bytes, bytes]] = []
        response_body = bytearray()
        response_complete = asyncio.Event()

        async def receive() -> AsgiMessage:
            nonlocal request_sent
            if request_sent:
                # Gateway buffers the body without a live peer-disconnect signal.
                # Body exhaustion must not cancel work before its response finishes.
                await response_complete.wait()
                return {"type": "http.disconnect"}
            request_sent = True
            return {"type": "http.request", "body": request_body, "more_body": False}

        async def send(message: AsgiMessage) -> None:
            nonlocal response_started, status_code, response_headers
            message_type = message.get("type")
            if message_type == "http.response.start":
                if response_started:
                    raise RuntimeError("ASGI response started more than once")
                status = message.get("status")
                headers = message.get("headers", [])
                if not isinstance(status, int) or not 100 <= status <= 599:
                    raise RuntimeError("ASGI response status is invalid")
                if not isinstance(headers, list):
                    raise RuntimeError("ASGI response headers are invalid")
                parsed_headers: list[tuple[bytes, bytes]] = []
                for item in headers:
                    if (
                        not isinstance(item, tuple | list)
                        or len(item) != 2
                        or not isinstance(item[0], bytes)
                        or not isinstance(item[1], bytes)
                    ):
                        raise RuntimeError("ASGI response header is invalid")
                    parsed_headers.append((bytes(item[0]), bytes(item[1])))
                response_started = True
                status_code = status
                response_headers = parsed_headers
                return
            if message_type == "http.response.body":
                if not response_started:
                    raise RuntimeError("ASGI response body preceded its status")
                body = message.get("body", b"")
                if not isinstance(body, bytes):
                    raise RuntimeError("ASGI response body is invalid")
                if len(response_body) + len(body) > _MAX_RESPONSE_BODY_BYTES:
                    raise RuntimeError("ASGI response body exceeds the Lambda boundary")
                response_body.extend(body)
                if not message.get("more_body", False):
                    response_complete.set()
                return
            raise RuntimeError("ASGI response message is invalid")

        # The custom Lambda runtime creates a new event loop per invocation.
        # Own and close async resources inside that loop, including failures.
        async with self._invocation_scope():
            try:
                await self._application(scope, receive, send)
            finally:
                response_complete.set()
        if not response_started:
            raise RuntimeError("ASGI application returned no response")
        return self._response(status_code, response_headers, bytes(response_body))

    @staticmethod
    def _request(event: Mapping[str, Any]) -> tuple[dict[str, Any], bytes]:
        if event.get("version") != "2.0":
            raise ValueError("only API Gateway payload format 2.0 is supported")
        request_context = event.get("requestContext")
        if not isinstance(request_context, dict):
            raise ValueError("API Gateway request context is invalid")
        http = request_context.get("http")
        if not isinstance(http, dict):
            raise ValueError("API Gateway HTTP context is invalid")

        method = http.get("method")
        path = event.get("rawPath")
        raw_query = event.get("rawQueryString", "")
        if not isinstance(method, str) or not method or len(method) > 32:
            raise ValueError("API Gateway method is invalid")
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 8192:
            raise ValueError("API Gateway path is invalid")
        if not isinstance(raw_query, str) or len(raw_query) > 16_384:
            raise ValueError("API Gateway query string is invalid")

        headers_value = event.get("headers", {})
        if not isinstance(headers_value, dict) or len(headers_value) > 256:
            raise ValueError("API Gateway headers are invalid")
        headers: list[tuple[bytes, bytes]] = []
        header_bytes = 0
        for key, value in headers_value.items():
            if (
                not isinstance(key, str)
                or not isinstance(value, str)
                or not key
                or len(key) > 256
                or len(value) > 8192
            ):
                raise ValueError("API Gateway header is invalid")
            try:
                encoded_header = (key.lower().encode("latin-1"), value.encode("latin-1"))
            except UnicodeEncodeError as error:
                raise ValueError("API Gateway header is invalid") from error
            header_bytes += len(encoded_header[0]) + len(encoded_header[1])
            if header_bytes > _MAX_HEADER_BYTES:
                raise ValueError("API Gateway headers are too large")
            headers.append(encoded_header)

        cookies_value = event.get("cookies", [])
        if (
            not isinstance(cookies_value, list)
            or len(cookies_value) > 64
            or not all(isinstance(cookie, str) for cookie in cookies_value)
            or sum(len(cookie.encode("utf-8")) for cookie in cookies_value) > _MAX_COOKIE_BYTES
        ):
            raise ValueError("API Gateway cookies are invalid")
        if cookies_value:
            try:
                headers.append((b"cookie", "; ".join(cookies_value).encode("latin-1")))
            except UnicodeEncodeError as error:
                raise ValueError("API Gateway cookie is invalid") from error

        body_value = event.get("body")
        if body_value is None:
            body = b""
        elif not isinstance(body_value, str):
            raise ValueError("API Gateway body is invalid")
        elif event.get("isBase64Encoded") is True:
            try:
                body = base64.b64decode(body_value, validate=True)
            except (binascii.Error, ValueError) as error:
                raise ValueError("API Gateway body encoding is invalid") from error
        else:
            body = body_value.encode("utf-8")
        if len(body) > _MAX_REQUEST_BODY_BYTES:
            raise ValueError("API Gateway body exceeds the adapter boundary")

        domain = request_context.get("domainName", "lambda")
        source_ip = http.get("sourceIp", "0.0.0.0")
        protocol = http.get("protocol", "HTTP/1.1")
        if (
            not isinstance(domain, str)
            or not isinstance(source_ip, str)
            or not 1 <= len(domain) <= 253
            or not 1 <= len(source_ip) <= 64
        ):
            raise ValueError("API Gateway network context is invalid")
        http_version = protocol.removeprefix("HTTP/") if isinstance(protocol, str) else "1.1"
        scheme = str(headers_value.get("x-forwarded-proto", "https")).lower()
        if scheme not in {"http", "https"}:
            scheme = "https"

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": http_version,
            "method": method.upper(),
            "scheme": scheme,
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": raw_query.encode("utf-8"),
            "root_path": "",
            "headers": headers,
            "server": (domain, 443 if scheme == "https" else 80),
            "client": (source_ip, 0),
            "state": {},
        }
        return scope, body

    @staticmethod
    def _response(
        status_code: int,
        raw_headers: list[tuple[bytes, bytes]],
        body: bytes,
    ) -> dict[str, Any]:
        headers: dict[str, str] = {}
        cookies: list[str] = []
        for raw_name, raw_value in raw_headers:
            try:
                name = raw_name.decode("latin-1").lower()
                value = raw_value.decode("latin-1")
            except UnicodeDecodeError as error:
                raise RuntimeError("ASGI response header is invalid") from error
            if name == "set-cookie":
                cookies.append(value)
            elif name in headers:
                headers[name] = f"{headers[name]},{value}"
            else:
                headers[name] = value
        response: dict[str, Any] = {
            "statusCode": status_code,
            "headers": headers,
            "body": base64.b64encode(body).decode("ascii"),
            "isBase64Encoded": True,
        }
        if cookies:
            response["cookies"] = cookies
        return response


@lru_cache(maxsize=1)
def _default_adapter() -> ApiGatewayV2Adapter:
    # Import the full application after the custom runtime has registered with
    # Lambda. This keeps the platform's 10-second initialization phase small;
    # the first bounded invocation owns the heavier application import.
    from opengeo_api.app import create_app

    application = create_app()
    return ApiGatewayV2Adapter(
        cast(AsgiApplication, application),
        invocation_scope=lambda: application.router.lifespan_context(application),
    )


@lru_cache(maxsize=1)
def _session_adapter() -> ApiGatewayV2Adapter:
    from opengeo_api.session_app import create_session_app

    application = create_session_app()
    return ApiGatewayV2Adapter(
        cast(AsgiApplication, application),
        invocation_scope=lambda: application.router.lifespan_context(application),
    )


def handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    del context
    preflight = _preflight_response(event)
    if preflight is not None:
        return preflight
    scope, _body = ApiGatewayV2Adapter._request(event)
    adapter = (
        _session_adapter()
        if scope["method"] == "GET" and scope["path"] in {"/auth/session", "/organizations/current"}
        else _default_adapter()
    )
    return asyncio.run(adapter.invoke(event))


def _preflight_response(event: Mapping[str, Any]) -> dict[str, Any] | None:
    request_context = event.get("requestContext")
    http = request_context.get("http") if isinstance(request_context, dict) else None
    method = http.get("method") if isinstance(http, dict) else None
    if not isinstance(method, str) or method.upper() != "OPTIONS":
        return None
    # Reuse the full adapter parser so malformed preflight requests cannot
    # bypass its request-size, path, header, and payload-format boundaries.
    ApiGatewayV2Adapter._request(event)
    return ApiGatewayV2Adapter._response(204, [], b"")
