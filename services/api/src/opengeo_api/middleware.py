import logging
import re
import time
from typing import Any
from uuid import uuid4

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from opengeo_api.logging import reset_request_id, set_request_id

logger = logging.getLogger(__name__)
REQUEST_ID_HEADER = "X-Request-ID"
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


def safe_request_id(value: str | None) -> str:
    if value is not None and _SAFE_REQUEST_ID.fullmatch(value):
        return value
    return str(uuid4())


class RequestContextMiddleware:
    """Attach a safe correlation id and emit one structured completion event."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = safe_request_id(Headers(scope=scope).get(REQUEST_ID_HEADER))
        token = set_request_id(request_id)
        started = time.perf_counter()
        status_code = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                MutableHeaders(scope=message).append(REQUEST_ID_HEADER, request_id)
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        except Exception as error:
            self._log_request(scope, started, status_code, error)
            raise
        else:
            self._log_request(scope, started, status_code)
        finally:
            reset_request_id(token)

    @staticmethod
    def _log_request(
        scope: Scope,
        started: float,
        status_code: int,
        error: Exception | None = None,
    ) -> None:
        extra: dict[str, Any] = {
            "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            "http_method": scope.get("method", "UNKNOWN"),
            "http_path": scope.get("path", ""),
            "http_status": status_code,
        }
        if error is not None:
            extra["error_type"] = type(error).__name__
            logger.error("request.failed", extra=extra)
        else:
            logger.info("request.completed", extra=extra)
