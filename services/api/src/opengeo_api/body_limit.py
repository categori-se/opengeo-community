import json

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_REQUEST_BODY_BYTES = 512 * 1024


class RequestBodyLimitMiddleware:
    """Reject oversized fixed or chunked bodies before framework JSON parsing."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = Headers(scope=scope).get("content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError:
                await self._reject(send, 400, "invalid_content_length")
                return
            if declared_length < 0:
                await self._reject(send, 400, "invalid_content_length")
                return
            if declared_length > self.max_bytes:
                await self._reject(send, 413, "request_body_too_large")
                return

        buffered: list[Message] = []
        received = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] == "http.disconnect":
                await self.app(scope, self._replay(buffered, receive), send)
                return
            if message["type"] != "http.request":
                continue
            received += len(message.get("body", b""))
            if received > self.max_bytes:
                await self._reject(send, 413, "request_body_too_large")
                return
            if not message.get("more_body", False):
                break

        await self.app(scope, self._replay(buffered, receive), send)

    @staticmethod
    def _replay(messages: list[Message], upstream: Receive) -> Receive:
        pending = iter(messages)

        async def receive() -> Message:
            try:
                return next(pending)
            except StopIteration:
                return await upstream()

        return receive

    @staticmethod
    async def _reject(send: Send, status_code: int, detail: str) -> None:
        body = json.dumps({"detail": detail}, separators=(",", ":")).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status_code,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
