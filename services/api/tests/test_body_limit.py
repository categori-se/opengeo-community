import asyncio
import json

from opengeo_api.body_limit import RequestBodyLimitMiddleware


def scope(content_length: str | None = None) -> dict:
    headers = [] if content_length is None else [(b"content-length", content_length.encode())]
    return {
        "type": "http",
        "method": "POST",
        "path": "/clients",
        "headers": headers,
    }


def messages(*chunks: tuple[bytes, bool]):
    queue = [
        {"type": "http.request", "body": body, "more_body": more_body} for body, more_body in chunks
    ]

    async def receive():
        return queue.pop(0)

    return receive


def test_declared_oversized_body_is_rejected_without_reading_or_calling_app() -> None:
    called = False
    read = False
    sent = []

    async def app(_scope, _receive, _send):
        nonlocal called
        called = True

    async def receive():
        nonlocal read
        read = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(app, max_bytes=10)
    asyncio.run(middleware(scope("11"), receive, send))

    assert called is False
    assert read is False
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"]) == {"detail": "request_body_too_large"}


def test_chunked_body_is_counted_before_downstream_parsing() -> None:
    called = False
    sent = []

    async def app(_scope, _receive, _send):
        nonlocal called
        called = True

    async def send(message):
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(app, max_bytes=10)
    asyncio.run(
        middleware(
            scope(),
            messages((b"123456", True), (b"78901", False)),
            send,
        )
    )

    assert called is False
    assert sent[0]["status"] == 413


def test_allowed_chunked_body_is_replayed_exactly() -> None:
    received = []
    sent = []

    async def app(_scope, receive, send):
        received.append(await receive())
        received.append(await receive())
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def send(message):
        sent.append(message)

    middleware = RequestBodyLimitMiddleware(app, max_bytes=10)
    asyncio.run(
        middleware(
            scope(),
            messages((b"123", True), (b"456", False)),
            send,
        )
    )

    assert [message["body"] for message in received] == [b"123", b"456"]
    assert sent[0]["status"] == 204
