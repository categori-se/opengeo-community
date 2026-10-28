"""Bounded JSON Streamable HTTP for MCP 2026-07-28 and 2025-11-25.

The current protocol is per-request, while the legacy revision uses initialize.
Neither mode stores sessions or offers an SSE stream. Authorization is renewed
for every POST; protocol metadata never supplies identity or account authority.
"""

import asyncio
import base64
import binascii
import json
import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from opengeo_api.auth_models import AuthSession
from opengeo_api.mcp_auth import (
    require_mcp_session,
    require_mcp_settings,
    validate_mcp_origin,
)
from opengeo_api.mcp_tools import execute_read_tool, tool_definitions

router = APIRouter(tags=["MCP read-only"])
logger = logging.getLogger(__name__)
MODERN_VERSION = "2026-07-28"
LEGACY_VERSION = "2025-11-25"
SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION]
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_JSON_DEPTH = 24
MAX_JSON_NODES = 4096
TOOL_TIMEOUT_SECONDS = 10.0
TOOL_CALLS_PER_MINUTE = 30
MAX_RATE_PRINCIPALS = 1024
_PREFIX = "io.modelcontextprotocol/"
_SERVER_INFO = {"name": "opengeo", "version": "0.1.0"}
_CAPABILITIES: dict[str, Any] = {"tools": {}}
_tool_calls: dict[UUID, deque[float]] = {}


@dataclass
class ProtocolError(Exception):
    code: int
    message: str
    status: int = 400
    data: dict[str, Any] | None = None


def _error(error: ProtocolError, request_id: str | int | None = None) -> JSONResponse:
    detail: dict[str, Any] = {"code": error.code, "message": error.message}
    if error.data is not None:
        detail["data"] = error.data
    envelope: dict[str, Any] = {"jsonrpc": "2.0", "error": detail}
    if request_id is not None:
        envelope["id"] = request_id
    headers = {"Cache-Control": "no-store"}
    if error.status == 429:
        headers["Retry-After"] = "60"
    return JSONResponse(envelope, status_code=error.status, headers=headers)


def _result(request_id: str | int, result: dict[str, Any], *, modern: bool) -> Response:
    if modern:
        result = {
            **result,
            "resultType": "complete",
            "_meta": {_PREFIX + "serverInfo": _SERVER_INFO},
        }
    try:
        body = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "result": result},
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return _error(ProtocolError(-32603, "Tool result could not be encoded", 500), request_id)
    if len(body) > MAX_RESPONSE_BYTES:
        return _error(ProtocolError(-32603, "Tool result exceeds response limit", 500), request_id)
    return Response(body, media_type="application/json", headers={"Cache-Control": "no-store"})


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def _bounded_json(value: Any) -> None:
    pending = [(value, 0)]
    nodes = 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if depth > MAX_JSON_DEPTH or nodes > MAX_JSON_NODES:
            raise ProtocolError(-32600, "JSON structure exceeds request limits")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, float) and not math.isfinite(item):
            raise ProtocolError(-32600, "Non-finite JSON numbers are invalid")


def _accepts_json_and_sse(value: str) -> bool:
    accepted = set()
    for entry in value.split(","):
        media, *parameters = entry.strip().lower().split(";")
        quality = 1.0
        for parameter in parameters:
            key, _, item = parameter.strip().partition("=")
            if key == "q":
                try:
                    quality = float(item)
                except ValueError:
                    return False
        if math.isfinite(quality) and 0 < quality <= 1:
            accepted.add(media)
    return {"application/json", "text/event-stream"} <= accepted


def _implementation(value: Any) -> bool:
    return isinstance(value, dict) and all(
        isinstance(value.get(field), str) and bool(value[field]) for field in ("name", "version")
    )


def _header_name(value: str | None) -> str | None:
    if value is None:
        return None
    if value.startswith("=?base64?") and value.endswith("?="):
        try:
            decoded = base64.b64decode(value[9:-2], validate=True).decode("utf-8")
        except (ValueError, binascii.Error, UnicodeError) as error:
            raise ProtocolError(-32020, "Invalid MCP name header") from error
        return decoded
    if value != value.strip() or any(not 32 <= ord(character) <= 126 for character in value):
        raise ProtocolError(-32020, "Invalid MCP name header")
    return value


def _version(request: Request, method: str, params: dict[str, Any]) -> bool:
    """Return modern/legacy mode without trusting prior HTTP connection state."""
    header = request.headers.get("mcp-protocol-version")
    meta = params.get("_meta", {})
    if not isinstance(meta, dict):
        raise ProtocolError(-32602, "Request metadata must be an object")
    version = meta.get(_PREFIX + "protocolVersion")
    if method == "initialize" and version is None:
        # Legacy negotiation can offer our supported legacy revision when the
        # client's requested revision is unsupported; no session is minted.
        requested = params.get("protocolVersion")
        if not isinstance(requested, str) or not requested:
            raise ProtocolError(-32602, "initialize requires protocolVersion")
        if header is not None and header != requested:
            raise ProtocolError(-32020, "Protocol header does not match initialize")
        return False
    if header == LEGACY_VERSION and version is None:
        return False
    if header is None:
        raise ProtocolError(-32020, "MCP-Protocol-Version header is required")
    if header not in SUPPORTED_VERSIONS:
        raise ProtocolError(
            -32022,
            "Unsupported protocol version",
            data={"supported": SUPPORTED_VERSIONS, "requested": header},
        )
    if version is None:
        raise ProtocolError(-32602, "protocolVersion metadata is required")
    if version != header:
        raise ProtocolError(-32020, "Protocol header does not match request metadata")
    if version != MODERN_VERSION:
        raise ProtocolError(-32602, "Per-request protocol metadata requires the modern revision")
    if not isinstance(meta.get(_PREFIX + "clientCapabilities"), dict):
        raise ProtocolError(-32602, "clientCapabilities metadata is required")
    info = meta.get(_PREFIX + "clientInfo")
    if _PREFIX + "clientInfo" in meta and not _implementation(info):
        raise ProtocolError(-32602, "clientInfo metadata is invalid")
    if request.headers.get("mcp-method") != method:
        raise ProtocolError(-32020, "Mcp-Method header is missing or mismatched")
    if method == "tools/call" and _header_name(request.headers.get("mcp-name")) != params.get(
        "name"
    ):
        raise ProtocolError(-32020, "Mcp-Name header is missing or mismatched")
    return True


def _parameters(params: dict[str, Any], allowed: set[str]) -> None:
    if set(params) - allowed - {"_meta"}:
        raise ProtocolError(-32602, "Unsupported request parameters")


def _tool_rate(session: AuthSession) -> None:
    """Bound local tool pressure; this is per-process, not a distributed quota."""
    now = time.monotonic()
    for principal, calls in list(_tool_calls.items()):
        while calls and calls[0] <= now - 60:
            calls.popleft()
        if not calls:
            del _tool_calls[principal]
    principal = session.principal.user_id
    if principal not in _tool_calls and len(_tool_calls) >= MAX_RATE_PRINCIPALS:
        raise ProtocolError(-32603, "Tool request capacity reached", 429)
    calls = _tool_calls.setdefault(principal, deque())
    if len(calls) >= TOOL_CALLS_PER_MINUTE:
        raise ProtocolError(-32603, "Tool rate limit reached", 429)
    calls.append(now)


def _tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


async def _call_tool(
    request: Request, session: AuthSession, params: dict[str, Any]
) -> dict[str, Any]:
    _parameters(params, {"name", "arguments"})
    name, arguments = params.get("name"), params.get("arguments", {})
    if not isinstance(name, str) or not name or not isinstance(arguments, dict):
        raise ProtocolError(-32602, "tools/call requires a tool name and object arguments")
    if name not in {definition["name"] for definition in tool_definitions()}:
        raise ProtocolError(-32602, "Unknown tool")
    _tool_rate(session)
    try:
        async with asyncio.timeout(TOOL_TIMEOUT_SECONDS):
            result = await execute_read_tool(
                session,
                name,
                arguments,
                ingestion_repository=request.app.state.ingestion_repository,
                workspace_repository=request.app.state.workspace_repository,
            )
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        result, separators=(",", ":"), ensure_ascii=False, allow_nan=False
                    ),
                }
            ],
            "structuredContent": result,
            "isError": False,
        }
    except HTTPException as error:
        messages = {
            403: "Resource unavailable or access denied.",
            404: "Resource unavailable or access denied.",
            409: "Select an authorized account before calling this tool.",
            413: "Tool result exceeds the supported size limit.",
            422: "Invalid tool arguments.",
            503: "Read service is temporarily unavailable.",
        }
        return _tool_error(
            messages.get(error.status_code, "Read operation could not be completed.")
        )
    except TimeoutError:
        return _tool_error("Read operation timed out.")
    except Exception as error:
        logger.error("mcp.tool_failed", extra={"error_type": type(error).__name__})
        return _tool_error("Read operation could not be completed.")


@router.post("/mcp", include_in_schema=False)
async def mcp_post(
    request: Request,
    session: Annotated[AuthSession, Depends(require_mcp_session)],
) -> Response:
    request_id: str | int | None = None
    try:
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/json"
        ):
            raise ProtocolError(-32600, "Content-Type must be application/json", 415)
        if not _accepts_json_and_sse(request.headers.get("accept", "")):
            raise ProtocolError(
                -32600, "Accept must include application/json and text/event-stream", 406
            )
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                raise ProtocolError(-32600, "MCP request body exceeds limit", 413)
            body.extend(chunk)
        try:
            envelope = json.loads(
                body.decode("utf-8"),
                object_pairs_hook=_unique_object,
                parse_constant=_invalid_constant,
            )
        except (ValueError, UnicodeError, RecursionError) as error:
            raise ProtocolError(-32700, "Parse error") from error
        _bounded_json(envelope)
        if not isinstance(envelope, dict) or set(envelope) - {"jsonrpc", "id", "method", "params"}:
            raise ProtocolError(-32600, "Expected one JSON-RPC request or notification")
        identifier = envelope.get("id")
        if "id" in envelope:
            if type(identifier) not in (str, int):
                raise ProtocolError(-32600, "Request ID must be a string or integer")
            request_id = identifier
        method, params = envelope.get("method"), envelope.get("params", {})
        if envelope.get("jsonrpc") != "2.0" or not isinstance(method, str) or not method:
            raise ProtocolError(-32600, "Invalid JSON-RPC request")
        if not isinstance(params, dict):
            raise ProtocolError(-32602, "Request parameters must be an object")
        modern = _version(request, method, params)
        if "id" not in envelope:
            if not modern and method == "notifications/initialized":
                _parameters(params, set())
                return Response(status_code=202, headers={"Cache-Control": "no-store"})
            raise ProtocolError(-32600, "Unsupported notification")
        assert request_id is not None
        if method == "initialize" and not modern:
            _parameters(params, {"protocolVersion", "capabilities", "clientInfo"})
            if not isinstance(params.get("capabilities"), dict) or not _implementation(
                params.get("clientInfo")
            ):
                raise ProtocolError(-32602, "initialize requires capabilities and clientInfo")
            result = {
                "protocolVersion": LEGACY_VERSION,
                "capabilities": _CAPABILITIES,
                "serverInfo": _SERVER_INFO,
            }
        elif method == "server/discover" and modern:
            _parameters(params, set())
            result = {"supportedVersions": SUPPORTED_VERSIONS, "capabilities": _CAPABILITIES}
        elif method == "ping":
            _parameters(params, set())
            result = {}
        elif method == "tools/list":
            _parameters(params, {"cursor"})
            if "cursor" in params:
                raise ProtocolError(-32602, "No additional tool-list page exists")
            result = {"tools": tool_definitions()}
        elif method == "tools/call":
            result = await _call_tool(request, session, params)
        else:
            raise ProtocolError(-32601, "Method not found", 404 if modern else 200)
        return _result(request_id, result, modern=modern)
    except ProtocolError as error:
        return _error(error, request_id)


@router.api_route(
    "/mcp", methods=["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"], include_in_schema=False
)
async def mcp_method_not_allowed(request: Request) -> Response:
    settings = require_mcp_settings(request)
    validate_mcp_origin(request, settings)
    return Response(status_code=405, headers={"Allow": "POST", "Cache-Control": "no-store"})
