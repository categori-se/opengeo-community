import asyncio
import ssl
from datetime import UTC, datetime

import pytest

from opengeo_api.kml_network_links import (
    MAXIMUM_RESPONSE_BYTES,
    AsyncioPinnedHttpTransport,
    NetworkLinkConditional,
    NetworkLinkFailure,
    NetworkLinkFetcher,
    NetworkLinkFetchRequest,
    _HttpResponse,
    _read_response,
    validate_network_link_request,
)


def request(**changes: object) -> NetworkLinkFetchRequest:
    values: dict[str, object] = {
        "link_id": "live-sites",
        "reason": "manual",
        "source_href": "https://data.opengeo.tools/live.kml?collection=sites",
        "request_url": "https://data.opengeo.tools/live.kml?collection=sites&bbox=1,2,3,4",
        "requested_at": datetime(2026, 8, 24, 12, tzinfo=UTC),
        "maximum_bytes": MAXIMUM_RESPONSE_BYTES,
        "timeout_milliseconds": 10_000,
        "accept": (
            "application/vnd.google-earth.kml+xml",
            "application/vnd.google-earth.kmz",
            "application/xml",
            "text/xml",
        ),
        "conditional": NetworkLinkConditional(etag='"revision-1"'),
    }
    values.update(changes)
    return NetworkLinkFetchRequest(**values)  # type: ignore[arg-type]


class FakeResolver:
    def __init__(self, *addresses: str) -> None:
        self.addresses = addresses
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        self.calls.append((host, port))
        return self.addresses


class FakeTransport:
    def __init__(self, responses: list[_HttpResponse | NetworkLinkFailure]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str]] = []

    async def fetch(self, target, pinned_address, fetch_request):
        del fetch_request
        self.calls.append((target.host, pinned_address))
        response = self.responses.pop(0)
        if isinstance(response, NetworkLinkFailure):
            raise response
        return response


class FakeWriter:
    def __init__(self) -> None:
        self.bytes = b""
        self.closed = False

    def write(self, value: bytes) -> None:
        self.bytes += value

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        pass


class FakeConnector:
    def __init__(self, response: bytes) -> None:
        self.response = response
        self.calls: list[tuple[str, str, ssl.SSLContext]] = []
        self.writer = FakeWriter()

    async def connect(self, pinned_address, host, context):
        self.calls.append((pinned_address, host, context))
        reader = asyncio.StreamReader()
        reader.feed_data(self.response)
        reader.feed_eof()
        return reader, self.writer


def response(
    body: bytes = b'<kml xmlns="http://www.opengis.net/kml/2.2"/>',
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> _HttpResponse:
    return _HttpResponse(
        status=status,
        headers=headers
        or {
            "content-type": "application/vnd.google-earth.kml+xml; charset=utf-8",
            "etag": '"revision-2"',
            "cache-control": "public, max-age=60",
        },
        body=body,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://data.opengeo.tools/live.kml",
        "https://localhost/live.kml",
        "https://127.0.0.1/live.kml",
        "https://169.254.169.254/latest/meta-data/",
        "https://metadata.google.internal/",
        "https://user:secret@data.opengeo.tools/live.kml",
        "https://data.opengeo.tools:8443/live.kml",
        "https://data.opengeo.tools/live.kml?X-Amz-Signature=secret",
        "https://data.opengeo.tools/live.kml#fragment",
        "https://data.opengeo.tools./live.kml",
    ],
)
def test_request_validation_rejects_unsafe_or_credential_shaped_urls(url: str) -> None:
    with pytest.raises(NetworkLinkFailure, match="unsafe_network_target"):
        validate_network_link_request(request(request_url=url))


def test_request_validation_rechecks_closed_transport_and_same_origin_path() -> None:
    validate_network_link_request(request())
    for invalid in [
        request(maximum_bytes=1024),
        request(timeout_milliseconds=9_999),
        request(accept=("text/html",)),
        request(request_url="https://other.opengeo.tools/live.kml"),
        request(request_url="https://data.opengeo.tools/other.kml"),
        request(conditional=NetworkLinkConditional(etag="header\r\ninjection")),
    ]:
        with pytest.raises(NetworkLinkFailure):
            validate_network_link_request(invalid)


def test_fetcher_resolves_once_pins_only_public_answers_and_returns_strict_receipt() -> None:
    async def scenario():
        resolver = FakeResolver("203.0.113.10", "2001:db8::10")
        transport = FakeTransport([response()])
        receipt = await NetworkLinkFetcher(resolver=resolver, transport=transport).fetch(request())
        return resolver, transport, receipt

    resolver, transport, receipt = asyncio.run(scenario())

    assert resolver.calls == [("data.opengeo.tools", 443)]
    assert transport.calls == [("data.opengeo.tools", "203.0.113.10")]
    assert receipt.request_url == request().request_url
    assert receipt.final_url == request().request_url
    assert receipt.status == 200
    assert receipt.redirects == 0
    assert receipt.dns_pinned is True
    assert receipt.all_addresses_public is True
    assert receipt.tls_verified is True
    assert receipt.credentials_sent is False
    assert receipt.body_text is not None
    assert receipt.body_base64 is None
    assert receipt.expires_at is not None


def test_fetcher_tries_at_most_two_pinned_addresses_and_never_follows_redirects() -> None:
    resolver = FakeResolver("203.0.113.1", "203.0.113.2", "203.0.113.3")
    transport = FakeTransport(
        [NetworkLinkFailure("upstream_unavailable"), NetworkLinkFailure("redirect_rejected")]
    )

    async def scenario() -> None:
        with pytest.raises(NetworkLinkFailure, match="redirect_rejected"):
            await NetworkLinkFetcher(resolver=resolver, transport=transport).fetch(request())

    asyncio.run(scenario())
    assert transport.calls == [
        ("data.opengeo.tools", "203.0.113.1"),
        ("data.opengeo.tools", "203.0.113.2"),
    ]


def test_tls_transport_connects_to_the_pinned_ip_with_original_hostname_verification() -> None:
    body = b'<kml xmlns="http://www.opengis.net/kml/2.2"/>'
    connector = FakeConnector(
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: application/vnd.google-earth.kml+xml\r\n"
        + f"Content-Length: {len(body)}\r\n".encode()
        + b'ETag: "revision-2"\r\n\r\n'
        + body
    )
    transport = AsyncioPinnedHttpTransport(connector)
    target = validate_network_link_request(request())

    parsed = asyncio.run(transport.fetch(target, "203.0.113.10", request()))

    pinned, hostname, context = connector.calls[0]
    assert pinned == "203.0.113.10"
    assert hostname == "data.opengeo.tools"
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    assert parsed.body == body
    sent = connector.writer.bytes.decode("ascii")
    assert sent.startswith("GET /live.kml?collection=sites&bbox=1,2,3,4 HTTP/1.1\r\n")
    assert "Host: data.opengeo.tools\r\n" in sent
    assert "Accept-Encoding: identity\r\n" in sent
    assert 'If-None-Match: "revision-1"\r\n' in sent
    assert all(name not in sent.casefold() for name in ("authorization:", "cookie:", "referer:"))
    assert connector.writer.closed is True


def test_http_reader_bounds_headers_bodies_chunking_compression_and_redirects() -> None:
    async def read(raw: bytes, maximum: int = MAXIMUM_RESPONSE_BYTES):
        reader = asyncio.StreamReader(limit=MAXIMUM_RESPONSE_BYTES + 1)
        reader.feed_data(raw)
        reader.feed_eof()
        return await _read_response(reader, maximum)

    async def scenario() -> None:
        chunked = await read(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n4\r\n<kml\r\n2\r\n/>\r\n0\r\n\r\n"
        )
        assert chunked.body == b"<kml/>"
        for raw, code in [
            (
                b"HTTP/1.1 302 Found\r\nLocation: https://private.invalid/\r\n\r\n",
                "redirect_rejected",
            ),
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Encoding: gzip\r\n"
                b"Content-Length: 1\r\n\r\nx",
                "response_invalid",
            ),
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 9\r\n"
                b"Content-Length: 9\r\n\r\n123456789",
                "response_invalid",
            ),
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: 9\r\n\r\n123456789",
                "response_too_large",
            ),
        ]:
            with pytest.raises(NetworkLinkFailure, match=code):
                await read(raw, 8)

    asyncio.run(scenario())


def test_fetcher_rejects_active_xml_and_encodes_kmz_without_persisting_it() -> None:
    active = FakeTransport(
        [response(b'<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>')]
    )

    async def scenario():
        with pytest.raises(NetworkLinkFailure, match="active_xml_rejected"):
            await NetworkLinkFetcher(resolver=FakeResolver("203.0.113.10"), transport=active).fetch(
                request()
            )

        archive = b"PK\x03\x04bounded-kmz"
        kmz = FakeTransport(
            [response(archive, headers={"content-type": "application/vnd.google-earth.kmz"})]
        )
        receipt = await NetworkLinkFetcher(
            resolver=FakeResolver("203.0.113.10"), transport=kmz
        ).fetch(request())
        return archive, receipt

    archive, receipt = asyncio.run(scenario())
    assert receipt.body_text is None
    assert receipt.body_base64 is not None
    assert receipt.byte_length == len(archive)


def test_fetcher_propagates_cancellation_and_caps_total_wall_time(monkeypatch) -> None:
    class PendingTransport:
        async def fetch(self, target, pinned_address, fetch_request):
            del target, pinned_address, fetch_request
            await asyncio.Future()
            raise AssertionError("unreachable")

    async def scenario() -> None:
        fetcher = NetworkLinkFetcher(
            resolver=FakeResolver("203.0.113.10"), transport=PendingTransport()
        )
        task = asyncio.create_task(fetcher.fetch(request()))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(NetworkLinkFailure, match="request_cancelled"):
            await task

        class ImmediateTimeout:
            async def __aenter__(self):
                raise TimeoutError

            async def __aexit__(self, *args):
                del args

        monkeypatch.setattr(asyncio, "timeout", lambda _seconds: ImmediateTimeout())
        with pytest.raises(NetworkLinkFailure, match="request_timeout"):
            await fetcher.fetch(request())

    asyncio.run(scenario())
