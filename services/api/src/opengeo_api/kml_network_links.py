import asyncio
import base64
import re
import ssl
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Literal, Protocol
from urllib.parse import parse_qsl, urlsplit

from opengeo_api.connection_verification import (
    AddressResolver,
    SystemAddressResolver,
    VerificationFailure,
)

NetworkLinkFailureCode = Literal[
    "active_xml_rejected",
    "dns_resolution_failed",
    "redirect_rejected",
    "response_invalid",
    "response_media_rejected",
    "response_too_large",
    "tls_verification_failed",
    "unsafe_network_target",
    "upstream_rejected",
    "upstream_unavailable",
    "request_cancelled",
    "request_timeout",
]

MAXIMUM_URL_CHARACTERS = 2_048
MAXIMUM_RESPONSE_BYTES = 256 * 1024
MAXIMUM_HEADER_BYTES = 32 * 1024
MAXIMUM_HEADER_COUNT = 100
MAXIMUM_DNS_ATTEMPTS = 2
REQUEST_TIMEOUT_SECONDS = 10.0
MAXIMUM_FRESHNESS_SECONDS = 86_400
SECURITY_CONTRACT = "public-https-dns-pinned-no-redirect-no-credentials-v1"
ALLOWED_MEDIA_TYPES = frozenset(
    {
        "application/vnd.google-earth.kml+xml",
        "application/vnd.google-earth.kmz",
        "application/xml",
        "text/xml",
    }
)
ALLOWED_REASONS = frozenset(
    {"initial", "manual", "interval", "expire", "view-stop", "view-request", "region"}
)

_CREDENTIAL_QUERY_KEY = re.compile(
    r"^(?:authorization|token|access[_-]?token|id[_-]?token|api[_-]?key|apikey|key|"
    r"signature|sig|credential|password|passwd|secret|session|x-amz-.+)$",
    re.IGNORECASE,
)
_UNSAFE_HOST_SUFFIX = re.compile(
    r"(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|arpa)$",
    re.IGNORECASE,
)
_LINK_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,159}$")
_ETAG = re.compile(r'^(?:W/)?"[\x20-\x21\x23-\x7e]{0,506}"$')
_ACTIVE_XML_MARKERS = (b"<!doctype", b"<!entity", b"<?xml-stylesheet")


class NetworkLinkFailure(RuntimeError):
    def __init__(self, code: NetworkLinkFailureCode) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class NetworkLinkConditional:
    etag: str | None = None
    last_modified: str | None = None


@dataclass(frozen=True, slots=True)
class NetworkLinkFetchRequest:
    link_id: str
    reason: str
    source_href: str
    request_url: str
    requested_at: datetime
    maximum_bytes: int
    timeout_milliseconds: int
    accept: tuple[str, ...]
    conditional: NetworkLinkConditional


@dataclass(frozen=True, slots=True)
class NetworkLinkFetchReceipt:
    request_url: str
    final_url: str
    status: int
    redirects: int
    dns_pinned: bool
    all_addresses_public: bool
    tls_verified: bool
    credentials_sent: bool
    media_type: str
    byte_length: int
    fetched_at: datetime
    expires_at: datetime | None
    etag: str | None
    last_modified: str | None
    body_text: str | None
    body_base64: str | None


@dataclass(frozen=True, slots=True)
class _Target:
    original_url: str
    host: str
    path_and_query: str


@dataclass(frozen=True, slots=True)
class _HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class PinnedHttpTransport(Protocol):
    async def fetch(
        self,
        target: _Target,
        pinned_address: str,
        request: NetworkLinkFetchRequest,
    ) -> _HttpResponse: ...


class TlsStreamConnector(Protocol):
    async def connect(
        self,
        pinned_address: str,
        host: str,
        context: ssl.SSLContext,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...


class SystemTlsStreamConnector:
    async def connect(
        self,
        pinned_address: str,
        host: str,
        context: ssl.SSLContext,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        return await asyncio.open_connection(
            host=pinned_address,
            port=443,
            ssl=context,
            server_hostname=host,
            limit=MAXIMUM_HEADER_BYTES + 1,
        )


class AsyncioPinnedHttpTransport:
    def __init__(self, connector: TlsStreamConnector | None = None) -> None:
        self._connector = connector or SystemTlsStreamConnector()
        context = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        self._ssl_context = context

    async def fetch(
        self,
        target: _Target,
        pinned_address: str,
        request: NetworkLinkFetchRequest,
    ) -> _HttpResponse:
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await self._connector.connect(
                pinned_address,
                target.host,
                self._ssl_context,
            )
            writer.write(_request_bytes(target, request))
            await writer.drain()
            return await _read_response(reader, request.maximum_bytes)
        except asyncio.CancelledError:
            raise
        except NetworkLinkFailure:
            raise
        except (ssl.CertificateError, ssl.SSLCertVerificationError) as error:
            raise NetworkLinkFailure("tls_verification_failed") from error
        except ssl.SSLError as error:
            raise NetworkLinkFailure("tls_verification_failed") from error
        except (ConnectionError, OSError, asyncio.IncompleteReadError) as error:
            raise NetworkLinkFailure("upstream_unavailable") from error
        finally:
            if writer is not None:
                writer.close()
                with suppress(ConnectionError, OSError, ssl.SSLError):
                    await writer.wait_closed()


class NetworkLinkFetcher:
    def __init__(
        self,
        *,
        resolver: AddressResolver | None = None,
        transport: PinnedHttpTransport | None = None,
    ) -> None:
        self._resolver = resolver or SystemAddressResolver()
        self._transport = transport or AsyncioPinnedHttpTransport()

    async def fetch(self, request: NetworkLinkFetchRequest) -> NetworkLinkFetchReceipt:
        target = validate_network_link_request(request)
        try:
            async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
                addresses = await self._resolver.resolve(target.host, 443)
                response = await self._fetch_pinned(target, addresses, request)
                return _receipt(target, request, response)
        except asyncio.CancelledError as error:
            raise NetworkLinkFailure("request_cancelled") from error
        except TimeoutError as error:
            raise NetworkLinkFailure("request_timeout") from error
        except VerificationFailure as error:
            if error.code == "unsafe_network_target":
                raise NetworkLinkFailure("unsafe_network_target") from error
            raise NetworkLinkFailure("dns_resolution_failed") from error

    async def _fetch_pinned(
        self,
        target: _Target,
        addresses: Sequence[str],
        request: NetworkLinkFetchRequest,
    ) -> _HttpResponse:
        last_error: NetworkLinkFailure | None = None
        for address in addresses[:MAXIMUM_DNS_ATTEMPTS]:
            try:
                return await self._transport.fetch(target, address, request)
            except NetworkLinkFailure as error:
                last_error = error
                if error.code not in {"upstream_unavailable", "tls_verification_failed"}:
                    raise
        raise last_error or NetworkLinkFailure("upstream_unavailable")


def validate_network_link_request(request: NetworkLinkFetchRequest) -> _Target:
    if not _LINK_ID.fullmatch(request.link_id) or request.reason not in ALLOWED_REASONS:
        raise NetworkLinkFailure("response_invalid")
    if request.requested_at.tzinfo is None:
        raise NetworkLinkFailure("response_invalid")
    if (
        request.maximum_bytes != MAXIMUM_RESPONSE_BYTES
        or request.timeout_milliseconds != round(REQUEST_TIMEOUT_SECONDS * 1_000)
        or not request.accept
        or len(request.accept) > len(ALLOWED_MEDIA_TYPES)
        or len(set(request.accept)) != len(request.accept)
        or any(value not in ALLOWED_MEDIA_TYPES for value in request.accept)
    ):
        raise NetworkLinkFailure("response_invalid")
    _validate_optional_header(request.conditional.etag, etag=True)
    _validate_optional_header(request.conditional.last_modified, etag=False)
    source = _target(request.source_href)
    target = _target(request.request_url)
    if (source.host, source.path_and_query.split("?", 1)[0]) != (
        target.host,
        target.path_and_query.split("?", 1)[0],
    ):
        raise NetworkLinkFailure("unsafe_network_target")
    return target


def _target(value: str) -> _Target:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not 1 <= len(value) <= MAXIMUM_URL_CHARACTERS
        or any(character in value for character in "\\\r\n\0")
    ):
        raise NetworkLinkFailure("unsafe_network_target")
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise NetworkLinkFailure("unsafe_network_target") from error
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
        or not _public_dns_name(parsed.hostname)
    ):
        raise NetworkLinkFailure("unsafe_network_target")
    if len(parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)) > 64:
        raise NetworkLinkFailure("unsafe_network_target")
    for key, _value in parse_qsl(parsed.query, keep_blank_values=True):
        if len(key) > 128 or _CREDENTIAL_QUERY_KEY.fullmatch(key):
            raise NetworkLinkFailure("unsafe_network_target")
    assert parsed.hostname is not None
    path = parsed.path or "/"
    return _Target(
        original_url=value,
        host=parsed.hostname.lower(),
        path_and_query=f"{path}?{parsed.query}" if parsed.query else path,
    )


def _public_dns_name(value: str | None) -> bool:
    if (
        value is None
        or len(value) > 253
        or value.endswith(".")
        or _UNSAFE_HOST_SUFFIX.search(value)
    ):
        return False
    labels = value.split(".")
    return len(labels) >= 2 and all(
        1 <= len(label) <= 63
        and re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) is not None
        for label in labels
    )


def _request_bytes(target: _Target, request: NetworkLinkFetchRequest) -> bytes:
    lines = [
        f"GET {target.path_and_query} HTTP/1.1",
        f"Host: {target.host}",
        "User-Agent: OpenGeo-NetworkLink/1.0",
        f"Accept: {', '.join(request.accept)}",
        "Accept-Encoding: identity",
        "Connection: close",
    ]
    if request.conditional.etag is not None:
        lines.append(f"If-None-Match: {request.conditional.etag}")
    if request.conditional.last_modified is not None:
        lines.append(f"If-Modified-Since: {request.conditional.last_modified}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


async def _read_response(reader: asyncio.StreamReader, maximum_bytes: int) -> _HttpResponse:
    try:
        header_bytes = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
        raise NetworkLinkFailure("response_invalid") from error
    if len(header_bytes) > MAXIMUM_HEADER_BYTES:
        raise NetworkLinkFailure("response_invalid")
    status, headers = _parse_headers(header_bytes)
    if 300 <= status <= 399:
        raise NetworkLinkFailure("redirect_rejected")
    if status not in {200, 304}:
        raise NetworkLinkFailure("upstream_rejected")
    if status == 304:
        return _HttpResponse(status, headers, b"")
    content_encoding = headers.get("content-encoding")
    if content_encoding is not None and content_encoding.casefold() != "identity":
        raise NetworkLinkFailure("response_invalid")
    body = await _read_body(reader, headers, maximum_bytes)
    return _HttpResponse(status, headers, body)


def _parse_headers(value: bytes) -> tuple[int, dict[str, str]]:
    try:
        lines = value[:-4].decode("iso-8859-1").split("\r\n")
    except UnicodeDecodeError as error:
        raise NetworkLinkFailure("response_invalid") from error
    if not lines or len(lines) > MAXIMUM_HEADER_COUNT + 1:
        raise NetworkLinkFailure("response_invalid")
    status_match = re.fullmatch(r"HTTP/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?", lines[0])
    if status_match is None:
        raise NetworkLinkFailure("response_invalid")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or line[0] in " \t" or ":" not in line:
            raise NetworkLinkFailure("response_invalid")
        name, raw = line.split(":", 1)
        if re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}", name) is None:
            raise NetworkLinkFailure("response_invalid")
        normalized = name.casefold()
        content = raw.strip(" \t")
        if normalized in headers or any(
            ord(character) < 32 and character != "\t" for character in content
        ):
            raise NetworkLinkFailure("response_invalid")
        if len(content) > 8_192:
            raise NetworkLinkFailure("response_invalid")
        headers[normalized] = content
    return int(status_match.group(1)), headers


async def _read_body(
    reader: asyncio.StreamReader,
    headers: Mapping[str, str],
    maximum_bytes: int,
) -> bytes:
    transfer_encoding = headers.get("transfer-encoding")
    content_length = headers.get("content-length")
    if transfer_encoding is not None and content_length is not None:
        raise NetworkLinkFailure("response_invalid")
    if transfer_encoding is not None:
        if transfer_encoding.casefold() != "chunked":
            raise NetworkLinkFailure("response_invalid")
        return await _read_chunked(reader, maximum_bytes)
    if content_length is not None:
        if re.fullmatch(r"[0-9]{1,9}", content_length) is None:
            raise NetworkLinkFailure("response_invalid")
        length = int(content_length)
        if length > maximum_bytes:
            raise NetworkLinkFailure("response_too_large")
        try:
            return await reader.readexactly(length)
        except asyncio.IncompleteReadError as error:
            raise NetworkLinkFailure("response_invalid") from error
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await reader.read(min(65_536, maximum_bytes + 1 - total))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        total += len(chunk)
        if total > maximum_bytes:
            raise NetworkLinkFailure("response_too_large")


async def _read_chunked(reader: asyncio.StreamReader, maximum_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        try:
            line = await reader.readuntil(b"\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            raise NetworkLinkFailure("response_invalid") from error
        if len(line) > 128 or re.fullmatch(rb"[0-9A-Fa-f]{1,8}\r\n", line) is None:
            raise NetworkLinkFailure("response_invalid")
        length = int(line[:-2], 16)
        if length == 0:
            try:
                if await reader.readexactly(2) != b"\r\n":
                    raise NetworkLinkFailure("response_invalid")
            except asyncio.IncompleteReadError as error:
                raise NetworkLinkFailure("response_invalid") from error
            return b"".join(chunks)
        total += length
        if total > maximum_bytes:
            raise NetworkLinkFailure("response_too_large")
        try:
            chunk = await reader.readexactly(length)
            if await reader.readexactly(2) != b"\r\n":
                raise NetworkLinkFailure("response_invalid")
        except asyncio.IncompleteReadError as error:
            raise NetworkLinkFailure("response_invalid") from error
        chunks.append(chunk)


def _receipt(
    target: _Target,
    request: NetworkLinkFetchRequest,
    response: _HttpResponse,
) -> NetworkLinkFetchReceipt:
    media_type = _media_type(response.headers.get("content-type"), request.accept, response.status)
    body_text: str | None = None
    body_base64: str | None = None
    if response.status == 200:
        if media_type == "application/vnd.google-earth.kmz":
            body_base64 = base64.b64encode(response.body).decode("ascii")
        else:
            try:
                body_text = response.body.decode("utf-8", errors="strict")
            except UnicodeDecodeError as error:
                raise NetworkLinkFailure("response_invalid") from error
            folded = response.body.lower()
            if any(marker in folded for marker in _ACTIVE_XML_MARKERS):
                raise NetworkLinkFailure("active_xml_rejected")
    fetched_at = datetime.now(UTC)
    return NetworkLinkFetchReceipt(
        request_url=target.original_url,
        final_url=target.original_url,
        status=response.status,
        redirects=0,
        dns_pinned=True,
        all_addresses_public=True,
        tls_verified=True,
        credentials_sent=False,
        media_type=media_type,
        byte_length=len(response.body),
        fetched_at=fetched_at,
        expires_at=_freshness(response.headers, fetched_at),
        etag=_response_header(response.headers.get("etag"), etag=True),
        last_modified=_response_header(response.headers.get("last-modified"), etag=False),
        body_text=body_text,
        body_base64=body_base64,
    )


def _media_type(value: str | None, accepted: Sequence[str], status: int) -> str:
    if value is None and status == 304:
        return accepted[0]
    if value is None:
        raise NetworkLinkFailure("response_media_rejected")
    parts = [part.strip() for part in value.split(";")]
    media_type = parts[0].casefold()
    if media_type not in ALLOWED_MEDIA_TYPES or media_type not in accepted:
        raise NetworkLinkFailure("response_media_rejected")
    for parameter in parts[1:]:
        if parameter.casefold() not in {"charset=utf-8", 'charset="utf-8"'}:
            raise NetworkLinkFailure("response_media_rejected")
    return media_type


def _freshness(headers: Mapping[str, str], fetched_at: datetime) -> datetime | None:
    maximum = fetched_at + timedelta(seconds=MAXIMUM_FRESHNESS_SECONDS)
    cache_control = headers.get("cache-control", "")
    max_age_match = re.search(r"(?:^|,)\s*max-age=([0-9]{1,8})\s*(?:,|$)", cache_control)
    if max_age_match is not None:
        seconds = min(MAXIMUM_FRESHNESS_SECONDS, int(max_age_match.group(1)))
        return fetched_at + timedelta(seconds=seconds) if seconds > 0 else None
    expires = headers.get("expires")
    if expires is None:
        return None
    try:
        parsed = parsedate_to_datetime(expires).astimezone(UTC)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed <= fetched_at:
        return None
    return min(parsed, maximum)


def _validate_optional_header(value: str | None, *, etag: bool) -> None:
    if value is None:
        return
    if not value.isascii() or not 1 <= len(value) <= 512 or "\r" in value or "\n" in value:
        raise NetworkLinkFailure("response_invalid")
    if etag and _ETAG.fullmatch(value) is None:
        raise NetworkLinkFailure("response_invalid")


def _response_header(value: str | None, *, etag: bool) -> str | None:
    try:
        _validate_optional_header(value, etag=etag)
    except NetworkLinkFailure:
        return None
    return value
