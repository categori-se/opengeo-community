from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import ssl
import tempfile
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast
from urllib.parse import parse_qsl, quote, urlencode, urlsplit
from uuid import UUID
from xml.etree import ElementTree

from opengeo_api.connection_verification import (
    AddressResolver,
    SystemAddressResolver,
    VerificationFailure,
    public_connection_address,
)
from opengeo_api.s3_endpoints import object_path, regional_s3_host

if TYPE_CHECKING:
    from opengeo_api.cognito_provisioning import AwsCredentials, CredentialProvider

ArchiveSourceType = Literal["wms", "pmtiles", "arcgis", "wfs"]
ArchiveCopyMethod = Literal["bounded_map_capture", "exact_object_copy", "bounded_feature_capture"]
ArchiveContentType = Literal["image/png", "application/vnd.pmtiles", "application/geo+json"]
PublicFileContentType = Literal["image/tiff", "image/geotiff"]
FetchedContentType = ArchiveContentType | PublicFileContentType | Literal["application/json"]
ArchiveFailureCode = Literal[
    "archive_cancelled",
    "archive_timeout",
    "destination_conflict",
    "destination_integrity_failed",
    "destination_unavailable",
    "dns_resolution_failed",
    "redirect_rejected",
    "response_invalid",
    "source_count_mismatch",
    "response_magic_rejected",
    "response_media_rejected",
    "response_too_large",
    "source_contract_invalid",
    "tls_verification_failed",
    "unsafe_network_target",
    "upstream_rejected",
    "upstream_unavailable",
]

MAXIMUM_URL_CHARACTERS = 2_048
MAXIMUM_HEADER_BYTES = 32 * 1_024
MAXIMUM_HEADER_COUNT = 100
MAXIMUM_DNS_ANSWERS = 8
MAXIMUM_PINNED_ATTEMPTS = 2
MAXIMUM_OUTPUT_BYTES = 536_870_912
FETCH_TIMEOUT_SECONDS = 120.0
FEATURE_FETCH_TIMEOUT_SECONDS = 300.0
S3_TIMEOUT_SECONDS = 120.0
MAXIMUM_FEATURE_OUTPUT_BYTES = 134_217_728
MAXIMUM_PUBLIC_FILE_BYTES = 67_108_864
MAXIMUM_FEATURE_PROPERTY_NODES = 10_000
MAXIMUM_FEATURE_PROPERTY_DEPTH = 16
MAXIMUM_FEATURE_POSITIONS = 1_000_000
WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066
_WEB_MERCATOR_RADIUS = 6_378_137.0
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_PMTILES_MAGIC = b"PMTiles\x03"
_HEX_ETAG = re.compile(r"^[A-Fa-f0-9]{16,128}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
DISCOVERY_METADATA_KEY = re.compile(
    r"discovery-metadata/organizations/(?P<organization>[0-9a-f-]{36})/"
    r"projects/(?P<project>[0-9a-f-]{36})/jobs/(?P<job>[0-9a-f-]{36})/response[.]bin"
)


def discovery_metadata_key(organization_id: UUID, project_id: UUID, job_id: UUID) -> str:
    return (
        f"discovery-metadata/organizations/{organization_id}/projects/{project_id}/"
        f"jobs/{job_id}/response.bin"
    )


def valid_discovery_metadata_key(key: str) -> bool:
    match = DISCOVERY_METADATA_KEY.fullmatch(key)
    if match is None:
        return False
    try:
        return all(str(UUID(value)) == value for value in match.groupdict().values())
    except ValueError:
        return False


_OGC_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_CREDENTIAL_QUERY_KEY = re.compile(
    r"^(?:authorization|token|access[_-]?token|id[_-]?token|api[_-]?key|apikey|key|"
    r"signature|sig|credential|password|passwd|secret|session|x-amz-.+)$",
    re.IGNORECASE,
)
_UNSAFE_HOST_SUFFIX = re.compile(
    r"(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|arpa)$",
    re.IGNORECASE,
)
_METADATA_PARAMETER_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")
_METADATA_MEDIA_TYPES = frozenset(
    {"application/json", "application/xml", "text/xml", "application/vnd.ogc.wfs_xml"}
)


class SourceArchiveFailure(RuntimeError):
    def __init__(self, code: ArchiveFailureCode, *, retryable: bool) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(code)


@dataclass(frozen=True, slots=True, repr=False)
class ArchiveFetchSpec:
    source_type: ArchiveSourceType
    source_url: str
    source_configuration: Mapping[str, Any]
    copy_method: ArchiveCopyMethod
    capture_scope: Mapping[str, Any]
    maximum_requests: int
    maximum_output_bytes: int
    output_content_type: ArchiveContentType


@dataclass(frozen=True, slots=True)
class FetchedArchive:
    content_type: FetchedContentType
    size_bytes: int
    checksum_sha256: str
    count_evidence: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class StoredArchive:
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: ArchiveContentType
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True, repr=False)
class _HttpsTarget:
    host: str
    path_and_query: str


@dataclass(frozen=True, slots=True, repr=False)
class _FetchRequest:
    accept: str
    maximum_bytes: int
    accepted_media_types: frozenset[str] | None = None
    output_content_type: FetchedContentType | None = None

    def __post_init__(self) -> None:
        output = self.output_content_type or cast(ArchiveContentType, self.accept)
        accepted = self.accepted_media_types or frozenset({self.accept})
        object.__setattr__(self, "output_content_type", output)
        object.__setattr__(self, "accepted_media_types", accepted)


class ArchiveTlsConnector(Protocol):
    async def connect(
        self,
        pinned_address: str,
        host: str,
        context: ssl.SSLContext,
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]: ...


class SystemArchiveTlsConnector:
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


class PinnedArchiveTransport(Protocol):
    async def fetch(
        self,
        target: _HttpsTarget,
        pinned_address: str,
        request: _FetchRequest,
        destination: Path,
    ) -> FetchedArchive: ...


class AsyncioPinnedArchiveTransport:
    def __init__(self, connector: ArchiveTlsConnector | None = None) -> None:
        self._connector = connector or SystemArchiveTlsConnector()
        context = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        self._ssl_context = context

    async def fetch(
        self,
        target: _HttpsTarget,
        pinned_address: str,
        request: _FetchRequest,
        destination: Path,
    ) -> FetchedArchive:
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await self._connector.connect(
                pinned_address,
                target.host,
                self._ssl_context,
            )
            writer.write(_request_bytes(target, request))
            await writer.drain()
            return await _read_response(reader, request, destination)
        except asyncio.CancelledError:
            raise
        except SourceArchiveFailure:
            raise
        except (ssl.CertificateError, ssl.SSLCertVerificationError, ssl.SSLError) as error:
            raise SourceArchiveFailure("tls_verification_failed", retryable=True) from error
        except (ConnectionError, OSError, asyncio.IncompleteReadError) as error:
            raise SourceArchiveFailure("upstream_unavailable", retryable=True) from error
        finally:
            if writer is not None:
                writer.close()
                with suppress(ConnectionError, OSError, ssl.SSLError):
                    await writer.wait_closed()


class AnonymousSourceFetcher:
    """Fetch one sealed anonymous source through a DNS-pinned TLS connection."""

    def __init__(
        self,
        *,
        resolver: AddressResolver | None = None,
        transport: PinnedArchiveTransport | None = None,
        timeout_seconds: float = FETCH_TIMEOUT_SECONDS,
    ) -> None:
        if not 1.0 <= timeout_seconds <= FETCH_TIMEOUT_SECONDS:
            raise ValueError("archive timeout is outside the accepted bound")
        self._resolver = resolver or SystemAddressResolver()
        self._transport = transport or AsyncioPinnedArchiveTransport()
        self._timeout_seconds = timeout_seconds

    async def fetch(self, spec: ArchiveFetchSpec, destination: Path) -> FetchedArchive:
        targets = archive_targets(spec)
        if spec.source_type in {"arcgis", "wfs"}:
            return await self._fetch_feature_pages(spec, targets, destination)
        target = targets[0]
        request = _FetchRequest(
            spec.output_content_type,
            spec.maximum_output_bytes,
            frozenset({spec.output_content_type}),
            spec.output_content_type,
        )
        return await self._fetch_one(target, request, destination)

    async def fetch_public_file(
        self,
        url: str,
        *,
        content_type: PublicFileContentType,
        size_bytes: int,
        checksum_sha256: str,
        destination: Path,
    ) -> FetchedArchive:
        """Stage exact anonymous TIFF bytes without retaining an archive copy."""
        if (
            not isinstance(content_type, str)
            or content_type not in {"image/tiff", "image/geotiff"}
            or type(size_bytes) is not int
            or not 1 <= size_bytes <= MAXIMUM_PUBLIC_FILE_BYTES
            or not isinstance(checksum_sha256, str)
            or _SHA256.fullmatch(checksum_sha256) is None
        ):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        target = _https_target(url)
        if "?" in url or any(ord(character) < 33 or ord(character) == 127 for character in url):
            raise SourceArchiveFailure("unsafe_network_target", retryable=False)
        if await asyncio.to_thread(os.path.lexists, destination):
            raise SourceArchiveFailure("destination_conflict", retryable=False)
        try:
            # A private sibling keeps every failure's partial bytes separate from
            # the caller's destination and allows exclusive publication on one FS.
            with tempfile.TemporaryDirectory(
                prefix="opengeo-public-file-", dir=destination.parent
            ) as directory:
                staged = Path(directory) / "response.bin"
                fetched = await self._fetch_one(
                    target,
                    _FetchRequest(
                        content_type, size_bytes, frozenset({content_type}), content_type
                    ),
                    staged,
                )
                if (
                    fetched.content_type != content_type
                    or fetched.size_bytes != size_bytes
                    or not hmac.compare_digest(fetched.checksum_sha256, checksum_sha256)
                ):
                    raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
                _publish_public_file(staged, destination)
                return fetched
        except FileExistsError as error:
            raise SourceArchiveFailure("destination_conflict", retryable=False) from error
        except OSError as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error

    async def fetch_document(
        self,
        url: str,
        *,
        parameters: list[tuple[str, str]],
        accept: str,
        accepted_media_types: frozenset[str],
        maximum_bytes: int,
    ) -> bytes:
        """Retrieve one bounded anonymous metadata document through the archive network path."""
        if (
            not parameters
            or not 1 <= len(parameters) <= 16
            or not 1 <= len(accept) <= 256
            or any(ord(character) < 32 or ord(character) > 126 for character in accept)
            or not accepted_media_types
            or not accepted_media_types.issubset(_METADATA_MEDIA_TYPES)
            or not 1 <= maximum_bytes <= 2_097_152
        ):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        parameter_names: set[str] = set()
        for name, value in parameters:
            normalized_name = name.casefold()
            if (
                _METADATA_PARAMETER_NAME.fullmatch(name) is None
                or normalized_name in parameter_names
                or not 1 <= len(value) <= 500
                or any(ord(character) < 32 or ord(character) > 126 for character in value)
            ):
                raise SourceArchiveFailure("source_contract_invalid", retryable=False)
            parameter_names.add(normalized_name)
        base = _https_target(url)
        if "?" in base.path_and_query:
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        query = urlencode(parameters, doseq=False, safe=",:", quote_via=quote)
        target = _HttpsTarget(base.host, f"{base.path_and_query}?{query}")
        with tempfile.TemporaryDirectory(prefix="opengeo-source-metadata-") as directory:
            destination = Path(directory) / "response.bin"
            await self._fetch_one(
                target,
                _FetchRequest(
                    accept,
                    maximum_bytes,
                    accepted_media_types,
                    cast(ArchiveContentType, sorted(accepted_media_types)[0]),
                ),
                destination,
            )
            try:
                return await asyncio.to_thread(destination.read_bytes)
            except OSError as error:
                raise SourceArchiveFailure("destination_unavailable", retryable=True) from error

    async def _fetch_one(
        self,
        target: _HttpsTarget,
        request: _FetchRequest,
        destination: Path,
    ) -> FetchedArchive:
        try:
            async with asyncio.timeout(self._timeout_seconds):
                addresses = await self._resolver.resolve(target.host, 443)
                if not 1 <= len(addresses) <= MAXIMUM_DNS_ANSWERS or any(
                    not public_connection_address(address) for address in addresses
                ):
                    raise SourceArchiveFailure("unsafe_network_target", retryable=False)
                last_error: SourceArchiveFailure | None = None
                for address in addresses[:MAXIMUM_PINNED_ATTEMPTS]:
                    try:
                        return await self._transport.fetch(target, address, request, destination)
                    except SourceArchiveFailure as error:
                        last_error = error
                        if not error.retryable:
                            raise
                raise last_error or SourceArchiveFailure("upstream_unavailable", retryable=True)
        except asyncio.CancelledError as error:
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("archive_cancelled", retryable=True) from error
        except TimeoutError as error:
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("archive_timeout", retryable=True) from error
        except VerificationFailure as error:
            code: ArchiveFailureCode = (
                "unsafe_network_target"
                if error.code == "unsafe_network_target"
                else "dns_resolution_failed"
            )
            raise SourceArchiveFailure(
                code,
                retryable=code == "dns_resolution_failed",
            ) from error

    async def _fetch_feature_pages(
        self,
        spec: ArchiveFetchSpec,
        targets: tuple[_HttpsTarget, ...],
        destination: Path,
    ) -> FetchedArchive:
        try:
            async with asyncio.timeout(FEATURE_FETCH_TIMEOUT_SECONDS):
                return await self._fetch_feature_pages_within_deadline(
                    spec,
                    targets,
                    destination,
                )
        except asyncio.CancelledError as error:
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("archive_cancelled", retryable=True) from error
        except TimeoutError as error:
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("archive_timeout", retryable=True) from error

    async def _fetch_feature_pages_within_deadline(
        self,
        spec: ArchiveFetchSpec,
        targets: tuple[_HttpsTarget, ...],
        destination: Path,
    ) -> FetchedArchive:
        identities: set[tuple[str, str | int | float]] = set()
        feature_count = 0
        page_evidence: list[dict[str, Any]] = []
        matched_count: int | None = None
        count_query: dict[str, Any] | None = None
        total_bytes = 0
        digest = hashlib.sha256()
        maximum_features = int(spec.capture_scope["maximum_features"])
        page_size = int(spec.capture_scope["page_size"])
        fields = cast(list[str], spec.source_configuration["fields"])
        identity_field = str(
            spec.source_configuration[
                "object_id_field" if spec.source_type == "arcgis" else "sort_by"
            ]
        )
        geometry_type = str(spec.source_configuration["geometry_type"])
        prefix = b'{"type":"FeatureCollection","features":['
        suffix = b"]}"
        try:
            if spec.source_type == "arcgis" and spec.maximum_requests == len(targets) + 1:
                count_path = destination.with_name(f"{destination.name}.count")
                try:
                    target = _arcgis_count_target(targets[0])
                    await self._fetch_one(
                        target,
                        _FetchRequest(
                            "application/json",
                            65_536,
                            frozenset({"application/json"}),
                            "application/json",
                        ),
                        count_path,
                    )
                    count_query = await asyncio.to_thread(_read_arcgis_count, count_path)
                    matched_count = count_query["count"]
                finally:
                    with suppress(OSError):
                        _remove_file(count_path)
            await asyncio.to_thread(destination.write_bytes, prefix)
            digest.update(prefix)
            total_bytes = len(prefix)
            for index, target in enumerate(targets):
                page_path = destination.with_name(f"{destination.name}.page-{index}")
                try:
                    await self._fetch_one(
                        target,
                        _FetchRequest(
                            "application/geo+json, application/json;q=0.9",
                            min(spec.maximum_output_bytes, 33_554_432),
                            frozenset({"application/geo+json", "application/json"}),
                            "application/geo+json",
                        ),
                        page_path,
                    )
                    page, counts = await asyncio.to_thread(
                        _read_feature_page,
                        page_path,
                        fields=fields,
                        identity_field=identity_field,
                        geometry_type=geometry_type,
                        remaining=min(page_size, maximum_features - feature_count),
                        identities=identities,
                    )
                    declared = counts["numberMatched"]
                    if declared is not None:
                        if matched_count is not None and matched_count != declared:
                            raise SourceArchiveFailure("source_count_mismatch", retryable=False)
                        matched_count = declared
                    if matched_count is not None and feature_count + len(page) > matched_count:
                        raise SourceArchiveFailure("source_count_mismatch", retryable=False)
                    page_evidence.append(counts)
                    chunk = await asyncio.to_thread(
                        _canonical_feature_page_bytes,
                        page,
                        feature_count > 0,
                    )
                    if total_bytes + len(chunk) + len(suffix) > spec.maximum_output_bytes:
                        raise SourceArchiveFailure("response_too_large", retryable=False)
                    await asyncio.to_thread(_append_file, destination, chunk)
                    digest.update(chunk)
                    total_bytes += len(chunk)
                    feature_count += len(page)
                    if len(page) < page_size or feature_count >= maximum_features:
                        break
                finally:
                    with suppress(OSError):
                        _remove_file(page_path)
            if matched_count is not None and feature_count != min(matched_count, maximum_features):
                raise SourceArchiveFailure("source_count_mismatch", retryable=False)
            evidence = {
                "schemaVersion": "opengeo.feature-capture-counts.1.0.0",
                "scope": dict(spec.capture_scope),
                "sourceType": spec.source_type,
                "fetchedCount": feature_count,
                "numberMatched": matched_count,
                "countStatus": "matched_bounded_scope" if matched_count is not None else "unknown",
                "limitedByMaximumFeatures": (
                    matched_count > maximum_features if matched_count is not None else None
                ),
                "pages": page_evidence,
                "countQuery": count_query,
            }
            suffix = (
                b'],"opengeo:capture":'
                + json.dumps(
                    evidence, sort_keys=True, separators=(",", ":"), allow_nan=False
                ).encode()
                + b"}"
            )
            if total_bytes + len(suffix) > spec.maximum_output_bytes:
                raise SourceArchiveFailure("response_too_large", retryable=False)
            await asyncio.to_thread(_append_file, destination, suffix)
            digest.update(suffix)
            total_bytes += len(suffix)
        except SourceArchiveFailure:
            with suppress(OSError):
                _remove_file(destination)
            raise
        except OSError as error:
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        # Page details remain in the checksum-bound archive. Keep completion metadata small.
        summary = {key: value for key, value in evidence.items() if key != "pages"}
        if count_query is not None:
            summary["countQuery"] = {
                key: value for key, value in count_query.items() if key != "reported"
            }
        return FetchedArchive("application/geo+json", total_bytes, digest.hexdigest(), summary)


def archive_target(spec: ArchiveFetchSpec) -> _HttpsTarget:
    return archive_targets(spec)[0]


def archive_targets(spec: ArchiveFetchSpec) -> tuple[_HttpsTarget, ...]:
    _validate_fetch_spec(spec)
    if spec.source_type == "wms":
        return (_wms_target(spec),)
    if spec.source_type == "pmtiles":
        return (_https_target(spec.source_url, require_pmtiles=True),)
    return _feature_targets(spec)


def _validate_fetch_spec(spec: ArchiveFetchSpec) -> None:
    if (
        isinstance(spec.maximum_requests, bool)
        or not isinstance(spec.maximum_requests, int)
        or not 1 <= spec.maximum_requests <= 64
        or isinstance(spec.maximum_output_bytes, bool)
        or not isinstance(spec.maximum_output_bytes, int)
        or not 1 <= spec.maximum_output_bytes <= MAXIMUM_OUTPUT_BYTES
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    if spec.source_type == "wms":
        if (
            spec.maximum_requests != 1
            or spec.copy_method != "bounded_map_capture"
            or spec.output_content_type != "image/png"
        ):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        _validate_wms_configuration(spec.source_configuration)
        _validate_wms_scope(spec.capture_scope)
        return
    if spec.source_type == "pmtiles":
        if (
            spec.maximum_requests != 1
            or spec.copy_method != "exact_object_copy"
            or spec.output_content_type != "application/vnd.pmtiles"
            or spec.capture_scope != {"kind": "exact_object"}
        ):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        _validate_pmtiles_configuration(spec.source_configuration)
        return
    if spec.source_type in {"arcgis", "wfs"}:
        if (
            spec.copy_method != "bounded_feature_capture"
            or spec.output_content_type != "application/geo+json"
            or spec.maximum_output_bytes > MAXIMUM_FEATURE_OUTPUT_BYTES
        ):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        _validate_feature_configuration(spec.source_type, spec.source_configuration)
        _validate_feature_scope(
            spec.capture_scope,
            spec.maximum_requests,
            int(spec.source_configuration["page_size"]),
            allow_count_request=spec.source_type == "arcgis",
        )
        return
    raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _validate_wms_configuration(value: Mapping[str, Any]) -> None:
    expected = {
        "version",
        "layers",
        "styles",
        "format",
        "transparent",
        "crs",
        "tile_size",
        "attribution",
    }
    layers = value.get("layers")
    styles = value.get("styles")
    attribution = value.get("attribution")
    if (
        set(value) != expected
        or value.get("version") not in {"1.1.1", "1.3.0"}
        or not isinstance(layers, list)
        or not 1 <= len(layers) <= 32
        or any(not isinstance(item, str) or _OGC_NAME.fullmatch(item) is None for item in layers)
        or len(set(layers)) != len(layers)
        or not isinstance(styles, list)
        or len(styles) != len(layers)
        or any(
            not isinstance(item, str) or (item and _OGC_NAME.fullmatch(item) is None)
            for item in styles
        )
        or value.get("format") not in {"image/png", "image/jpeg"}
        or not isinstance(value.get("transparent"), bool)
        or value.get("crs") != "EPSG:3857"
        or value.get("tile_size") not in {256, 512}
        or (
            attribution is not None
            and (not isinstance(attribution, str) or not 1 <= len(attribution) <= 1_000)
        )
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _validate_pmtiles_configuration(value: Mapping[str, Any]) -> None:
    expected = {
        "tile_type",
        "source_layer",
        "geometry_type",
        "min_zoom",
        "max_zoom",
        "attribution",
    }
    minimum = value.get("min_zoom")
    maximum = value.get("max_zoom")
    tile_type = value.get("tile_type")
    source_layer = value.get("source_layer")
    geometry_type = value.get("geometry_type")
    attribution = value.get("attribution")
    vector_shape = (
        tile_type == "vector"
        and isinstance(source_layer, str)
        and _OGC_NAME.fullmatch(source_layer) is not None
        and geometry_type in {"Point", "LineString", "Polygon"}
    )
    raster_shape = tile_type == "raster" and source_layer is None and geometry_type is None
    if (
        set(value) != expected
        or not (vector_shape or raster_shape)
        or isinstance(minimum, bool)
        or not isinstance(minimum, int)
        or isinstance(maximum, bool)
        or not isinstance(maximum, int)
        or not 0 <= minimum <= maximum <= 24
        or (
            attribution is not None
            and (not isinstance(attribution, str) or not 1 <= len(attribution) <= 1_000)
        )
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _validate_feature_configuration(
    source_type: ArchiveSourceType,
    value: Mapping[str, Any],
) -> None:
    common = {"fields", "geometry_type", "page_size", "attribution"}
    expected = common | (
        {"object_id_field"}
        if source_type == "arcgis"
        else {"version", "type_name", "geometry_name", "sort_by"}
    )
    fields = value.get("fields")
    page_size = value.get("page_size")
    attribution = value.get("attribution")
    if (
        set(value) != expected
        or not isinstance(fields, list)
        or not 1 <= len(fields) <= 64
        or any(not isinstance(item, str) or _OGC_NAME.fullmatch(item) is None for item in fields)
        or len(set(fields)) != len(fields)
        or isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= (2000 if source_type == "arcgis" else 1000)
        or value.get("geometry_type")
        not in {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}
        or (
            attribution is not None
            and (not isinstance(attribution, str) or not 1 <= len(attribution) <= 1_000)
        )
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    if source_type == "arcgis":
        identity = value.get("object_id_field")
        if not isinstance(identity, str) or identity not in fields:
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    else:
        if value.get("version") != "2.0.0":
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        named = [value.get("type_name"), value.get("geometry_name"), value.get("sort_by")]
        if any(not isinstance(item, str) or _OGC_NAME.fullmatch(item) is None for item in named):
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        if value.get("sort_by") not in fields or value.get("geometry_name") in fields:
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _validate_feature_scope(
    value: Mapping[str, Any],
    maximum_requests: int,
    configured_page_size: int,
    *,
    allow_count_request: bool = False,
) -> None:
    bounds = value.get("bounds")
    maximum_features = value.get("maximum_features")
    page_size = value.get("page_size")
    if (
        set(value) != {"kind", "bounds", "maximum_features", "page_size"}
        or value.get("kind") != "bounded_features"
        or not isinstance(bounds, list)
        or len(bounds) != 4
        or any(isinstance(item, bool) or not isinstance(item, int | float) for item in bounds)
        or any(not math.isfinite(float(item)) for item in bounds)
        or not -180 <= float(bounds[0]) < float(bounds[2]) <= 180
        or not -90 <= float(bounds[1]) < float(bounds[3]) <= 90
        or isinstance(maximum_features, bool)
        or not isinstance(maximum_features, int)
        or not 1 <= maximum_features <= 50_000
        or isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= 2_000
        or page_size > configured_page_size
        or maximum_requests
        not in {
            (maximum_features + page_size - 1) // page_size,
            (maximum_features + page_size - 1) // page_size + int(allow_count_request),
        }
        or not 1 <= maximum_requests <= 64
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _feature_targets(spec: ArchiveFetchSpec) -> tuple[_HttpsTarget, ...]:
    base = _https_target(spec.source_url)
    if "?" in base.path_and_query:
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    if (
        spec.source_type == "arcgis"
        and re.search(
            r"/(?:FeatureServer|MapServer)/[0-9]{1,5}/?$",
            base.path_and_query,
        )
        is None
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    scope = spec.capture_scope
    configuration = spec.source_configuration
    bounds = cast(list[float], scope["bounds"])
    page_size = int(scope["page_size"])
    targets: list[_HttpsTarget] = []
    for index in range((int(scope["maximum_features"]) + page_size - 1) // page_size):
        offset = index * page_size
        request_page_size = min(
            page_size,
            int(scope["maximum_features"]) - offset,
        )
        if request_page_size < 1:
            raise SourceArchiveFailure("source_contract_invalid", retryable=False)
        if spec.source_type == "arcgis":
            parameters = [
                ("f", "geojson"),
                ("where", "1=1"),
                ("outFields", ",".join(cast(list[str], configuration["fields"]))),
                ("returnGeometry", "true"),
                ("outSR", "4326"),
                ("orderByFields", f"{configuration['object_id_field']} ASC"),
                ("resultOffset", str(offset)),
                ("resultRecordCount", str(request_page_size)),
                ("geometry", ",".join(_format_coordinate(float(item)) for item in bounds)),
                ("geometryType", "esriGeometryEnvelope"),
                ("inSR", "4326"),
                ("spatialRel", "esriSpatialRelIntersects"),
            ]
            path = f"{base.path_and_query.rstrip('/')}/query"
        else:
            fields = [
                *cast(list[str], configuration["fields"]),
                str(configuration["geometry_name"]),
            ]
            parameters = [
                ("SERVICE", "WFS"),
                ("VERSION", "2.0.0"),
                ("REQUEST", "GetFeature"),
                ("TYPENAMES", str(configuration["type_name"])),
                ("OUTPUTFORMAT", "application/json"),
                ("SRSNAME", "urn:ogc:def:crs:OGC::CRS84"),
                ("PROPERTYNAME", ",".join(fields)),
                ("SORTBY", f"{configuration['sort_by']} A"),
                ("COUNT", str(request_page_size)),
                ("STARTINDEX", str(offset)),
                (
                    "BBOX",
                    ",".join(
                        [
                            *(_format_coordinate(float(item)) for item in bounds),
                            "urn:ogc:def:crs:OGC::CRS84",
                        ]
                    ),
                ),
            ]
            path = base.path_and_query
        query = urlencode(parameters, doseq=False, safe=",:", quote_via=quote)
        targets.append(_HttpsTarget(base.host, f"{path}?{query}"))
    return tuple(targets)


def _arcgis_count_target(page: _HttpsTarget) -> _HttpsTarget:
    path, query = page.path_and_query.split("?", 1)
    # Derive scope from the actual feature query; pagination/output options do not
    # constrain a count. Do not introduce a second interpretation of the bounds.
    filters = {"where", "geometry", "geometryType", "inSR", "spatialRel"}
    parameters = [(key, value) for key, value in parse_qsl(query) if key in filters]
    parameters.extend([("f", "json"), ("returnCountOnly", "true")])
    return _HttpsTarget(page.host, path + "?" + urlencode(parameters, safe=",:", quote_via=quote))


def _read_arcgis_count(path: Path) -> dict[str, Any]:
    body = path.read_bytes()
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise SourceArchiveFailure("response_invalid", retryable=False) from error
    if not isinstance(value, dict):
        raise SourceArchiveFailure("response_invalid", retryable=False)
    count = value.get("count")
    if type(count) is not int or not 0 <= count <= 9_007_199_254_740_991:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    return {
        "method": "arcgis_returnCountOnly",
        "count": count,
        "sha256": hashlib.sha256(body).hexdigest(),
        "byteLength": len(body),
        "reported": value,
    }


def _validate_wms_scope(value: Mapping[str, Any]) -> None:
    bounds = value.get("bounds")
    width = value.get("width")
    height = value.get("height")
    if (
        set(value) != {"kind", "bounds", "width", "height"}
        or value.get("kind") != "bounded_image"
        or not isinstance(bounds, list)
        or len(bounds) != 4
        or any(isinstance(item, bool) or not isinstance(item, int | float) for item in bounds)
        or any(not math.isfinite(float(item)) for item in bounds)
        or not -180 <= float(bounds[0]) < float(bounds[2]) <= 180
        or not -90 <= float(bounds[1]) < float(bounds[3]) <= 90
        or float(bounds[1]) < -WEB_MERCATOR_MAX_LATITUDE
        or float(bounds[3]) > WEB_MERCATOR_MAX_LATITUDE
        or isinstance(width, bool)
        or not isinstance(width, int)
        or isinstance(height, bool)
        or not isinstance(height, int)
        or not 1 <= width <= 4096
        or not 1 <= height <= 4096
        or width * height > 16_777_216
    ):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)


def _wms_target(spec: ArchiveFetchSpec) -> _HttpsTarget:
    base = _https_target(spec.source_url)
    if "?" in base.path_and_query:
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    configuration = spec.source_configuration
    scope = spec.capture_scope
    raw_bounds = scope["bounds"]
    assert isinstance(raw_bounds, list)
    bounds = (
        float(raw_bounds[0]),
        float(raw_bounds[1]),
        float(raw_bounds[2]),
        float(raw_bounds[3]),
    )
    version = str(configuration["version"])
    crs = str(configuration["crs"])
    projected = _project_wgs84_bounds(bounds, crs)
    bbox = _wms_bbox(projected, version, crs)
    layers = configuration["layers"]
    styles = configuration["styles"]
    assert isinstance(layers, list) and isinstance(styles, list)
    parameters: list[tuple[str, str]] = [
        ("SERVICE", "WMS"),
        ("REQUEST", "GetMap"),
        ("VERSION", version),
        ("LAYERS", ",".join(str(item) for item in layers)),
        ("STYLES", ",".join(str(item) for item in styles)),
        ("FORMAT", "image/png"),
        ("TRANSPARENT", "TRUE" if configuration["transparent"] else "FALSE"),
        ("WIDTH", str(scope["width"])),
        ("HEIGHT", str(scope["height"])),
        ("CRS" if version == "1.3.0" else "SRS", crs),
        ("BBOX", ",".join(_format_coordinate(item) for item in bbox)),
    ]
    query = urlencode(parameters, doseq=False, safe=",:", quote_via=quote)
    return _HttpsTarget(base.host, f"{base.path_and_query}?{query}")


def _project_wgs84_bounds(
    bounds: tuple[float, float, float, float], crs: str
) -> tuple[float, float, float, float]:
    if crs == "EPSG:4326":
        return bounds
    if crs != "EPSG:3857":
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    west, south, east, north = bounds
    if south < -WEB_MERCATOR_MAX_LATITUDE or north > WEB_MERCATOR_MAX_LATITUDE:
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)

    def project(longitude: float, latitude: float) -> tuple[float, float]:
        x = _WEB_MERCATOR_RADIUS * math.radians(longitude)
        y = _WEB_MERCATOR_RADIUS * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2))
        return x, y

    min_x, min_y = project(west, south)
    max_x, max_y = project(east, north)
    return min_x, min_y, max_x, max_y


def _wms_bbox(
    bounds: tuple[float, float, float, float], version: str, crs: str
) -> tuple[float, float, float, float]:
    west, south, east, north = bounds
    if version == "1.3.0" and crs == "EPSG:4326":
        return south, west, north, east
    return west, south, east, north


def _format_coordinate(value: float) -> str:
    normalized = f"{value:.8f}".rstrip("0").rstrip(".")
    return "0" if normalized in {"-0", ""} else normalized


def _https_target(value: str, *, require_pmtiles: bool = False) -> _HttpsTarget:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or not 1 <= len(value) <= MAXIMUM_URL_CHARACTERS
        or any(character in value for character in "\\\r\n\0")
    ):
        raise SourceArchiveFailure("unsafe_network_target", retryable=False)
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise SourceArchiveFailure("unsafe_network_target", retryable=False) from error
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
        or not _public_dns_name(parsed.hostname)
    ):
        raise SourceArchiveFailure("unsafe_network_target", retryable=False)
    parameters = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)
    if len(parameters) > 64 or any(
        len(key) > 128 or _CREDENTIAL_QUERY_KEY.fullmatch(key) for key, _ in parameters
    ):
        raise SourceArchiveFailure("unsafe_network_target", retryable=False)
    path = parsed.path or "/"
    if require_pmtiles and not path.casefold().endswith(".pmtiles"):
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    assert parsed.hostname is not None
    return _HttpsTarget(
        parsed.hostname.casefold(),
        f"{path}?{parsed.query}" if parsed.query else path,
    )


def _public_dns_name(value: str | None) -> bool:
    if (
        value is None
        or len(value) > 253
        or value.endswith(".")
        or _UNSAFE_HOST_SUFFIX.search(value)
    ):
        return False
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        return False
    labels = value.split(".")
    return len(labels) >= 2 and all(
        1 <= len(label) <= 63
        and re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) is not None
        for label in labels
    )


def _request_bytes(target: _HttpsTarget, request: _FetchRequest) -> bytes:
    return (
        "\r\n".join(
            [
                f"GET {target.path_and_query} HTTP/1.1",
                f"Host: {target.host}",
                "User-Agent: OpenGeo-SourceArchiver/1.0",
                f"Accept: {request.accept}",
                "Accept-Encoding: identity",
                "Connection: close",
            ]
        )
        + "\r\n\r\n"
    ).encode("ascii")


async def _read_response(
    reader: asyncio.StreamReader,
    request: _FetchRequest,
    destination: Path,
) -> FetchedArchive:
    try:
        header_bytes = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
        raise SourceArchiveFailure("response_invalid", retryable=False) from error
    if len(header_bytes) > MAXIMUM_HEADER_BYTES:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    status, headers = _parse_headers(header_bytes)
    if 300 <= status <= 399:
        raise SourceArchiveFailure("redirect_rejected", retryable=False)
    if status != 200:
        raise SourceArchiveFailure("upstream_rejected", retryable=status >= 500)
    content_encoding = headers.get("content-encoding")
    if content_encoding is not None and content_encoding.casefold() != "identity":
        raise SourceArchiveFailure("response_invalid", retryable=False)
    media_type = _media_type(headers.get("content-type"))
    accepted_media_types = request.accepted_media_types
    output_content_type = request.output_content_type
    if accepted_media_types is None or output_content_type is None:
        raise SourceArchiveFailure("source_contract_invalid", retryable=False)
    if media_type not in accepted_media_types:
        raise SourceArchiveFailure("response_media_rejected", retryable=False)

    digest = hashlib.sha256()
    first_bytes = bytearray()
    try:
        with destination.open("wb") as output:
            size = await _stream_body(
                reader,
                headers,
                request.maximum_bytes,
                output.write,
                digest,
                first_bytes,
            )
    except OSError as error:
        raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
    magic = {
        "image/png": _PNG_MAGIC,
        "application/vnd.pmtiles": _PMTILES_MAGIC,
    }.get(output_content_type)
    if magic is not None and bytes(first_bytes[: len(magic)]) != magic:
        with suppress(OSError):
            _remove_file(destination)
        raise SourceArchiveFailure("response_magic_rejected", retryable=False)
    if output_content_type == "application/geo+json":
        try:
            prefix = (await asyncio.to_thread(destination.read_bytes))[:256].lstrip()
        except OSError as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        if not prefix.startswith(b"{"):
            with suppress(OSError):
                _remove_file(destination)
            raise SourceArchiveFailure("response_magic_rejected", retryable=False)
    return FetchedArchive(output_content_type, size, digest.hexdigest())


def _parse_headers(value: bytes) -> tuple[int, dict[str, str]]:
    try:
        lines = value[:-4].decode("iso-8859-1").split("\r\n")
    except UnicodeDecodeError as error:
        raise SourceArchiveFailure("response_invalid", retryable=False) from error
    if not lines or len(lines) > MAXIMUM_HEADER_COUNT + 1:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    status_match = re.fullmatch(r"HTTP/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?", lines[0])
    if status_match is None:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or line[0] in " \t" or ":" not in line:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        name, raw_value = line.split(":", 1)
        if re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}", name) is None:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        normalized = name.casefold()
        content = raw_value.strip(" \t")
        if (
            normalized in headers
            or len(content) > 8_192
            or any(ord(character) < 32 and character != "\t" for character in content)
        ):
            raise SourceArchiveFailure("response_invalid", retryable=False)
        headers[normalized] = content
    return int(status_match.group(1)), headers


async def _stream_body(
    reader: asyncio.StreamReader,
    headers: Mapping[str, str],
    maximum_bytes: int,
    write: Callable[[bytes], int],
    digest: Any,
    first_bytes: bytearray,
) -> int:
    transfer_encoding = headers.get("transfer-encoding")
    content_length = headers.get("content-length")
    if transfer_encoding is not None and content_length is not None:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    if transfer_encoding is not None:
        if transfer_encoding.casefold() != "chunked":
            raise SourceArchiveFailure("response_invalid", retryable=False)
        return await _stream_chunked(reader, maximum_bytes, write, digest, first_bytes)
    if content_length is not None:
        if re.fullmatch(r"[0-9]{1,10}", content_length) is None:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        length = int(content_length)
        if length > maximum_bytes:
            raise SourceArchiveFailure("response_too_large", retryable=False)
        return await _stream_exact(reader, length, write, digest, first_bytes)

    total = 0
    while True:
        chunk = await reader.read(min(65_536, maximum_bytes + 1 - total))
        if not chunk:
            return total
        total += len(chunk)
        if total > maximum_bytes:
            raise SourceArchiveFailure("response_too_large", retryable=False)
        _write_chunk(chunk, write, digest, first_bytes)


async def _stream_exact(
    reader: asyncio.StreamReader,
    length: int,
    write: Callable[[bytes], int],
    digest: Any,
    first_bytes: bytearray,
) -> int:
    remaining = length
    while remaining:
        try:
            chunk = await reader.readexactly(min(65_536, remaining))
        except asyncio.IncompleteReadError as error:
            raise SourceArchiveFailure("response_invalid", retryable=False) from error
        _write_chunk(chunk, write, digest, first_bytes)
        remaining -= len(chunk)
    return length


async def _stream_chunked(
    reader: asyncio.StreamReader,
    maximum_bytes: int,
    write: Callable[[bytes], int],
    digest: Any,
    first_bytes: bytearray,
) -> int:
    total = 0
    while True:
        try:
            line = await reader.readuntil(b"\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            raise SourceArchiveFailure("response_invalid", retryable=False) from error
        if len(line) > 128 or re.fullmatch(rb"[0-9A-Fa-f]{1,8}\r\n", line) is None:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        length = int(line[:-2], 16)
        if length == 0:
            try:
                terminator = await reader.readexactly(2)
            except asyncio.IncompleteReadError as error:
                raise SourceArchiveFailure("response_invalid", retryable=False) from error
            if terminator != b"\r\n":
                raise SourceArchiveFailure("response_invalid", retryable=False)
            return total
        total += length
        if total > maximum_bytes:
            raise SourceArchiveFailure("response_too_large", retryable=False)
        await _stream_exact(reader, length, write, digest, first_bytes)
        try:
            terminator = await reader.readexactly(2)
        except asyncio.IncompleteReadError as error:
            raise SourceArchiveFailure("response_invalid", retryable=False) from error
        if terminator != b"\r\n":
            raise SourceArchiveFailure("response_invalid", retryable=False)


def _write_chunk(
    chunk: bytes,
    write: Callable[[bytes], int],
    digest: Any,
    first_bytes: bytearray,
) -> None:
    if len(first_bytes) < 8:
        first_bytes.extend(chunk[: 8 - len(first_bytes)])
    if write(chunk) != len(chunk):
        raise SourceArchiveFailure("destination_unavailable", retryable=True)
    digest.update(chunk)


def _media_type(value: str | None) -> str:
    if value is None or len(value) > 256:
        raise SourceArchiveFailure("response_media_rejected", retryable=False)
    media_type = value.split(";", 1)[0].strip().casefold()
    if media_type not in {
        "image/png",
        "image/tiff",
        "image/geotiff",
        "application/vnd.pmtiles",
        "application/geo+json",
        "application/json",
        "application/xml",
        "text/xml",
        "application/vnd.ogc.wfs_xml",
    }:
        raise SourceArchiveFailure("response_media_rejected", retryable=False)
    return media_type


def _read_feature_page(
    path: Path,
    *,
    fields: list[str],
    identity_field: str,
    geometry_type: str,
    remaining: int,
    identities: set[tuple[str, str | int | float]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        body = path.read_bytes()
        value = json.loads(body.decode("utf-8"))
    except (
        OSError,
        RecursionError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ) as error:
        raise SourceArchiveFailure("response_invalid", retryable=False) from error
    if not isinstance(value, dict) or value.get("type") != "FeatureCollection":
        raise SourceArchiveFailure("response_invalid", retryable=False)
    raw_features = value.get("features")
    if not isinstance(raw_features, list) or len(raw_features) > remaining:
        raise SourceArchiveFailure("response_invalid", retryable=False)
    counts: dict[str, Any] = {
        "sha256": hashlib.sha256(body).hexdigest(),
        "byteLength": len(body),
        "fetchedCount": len(raw_features),
        "reported": {
            key: value[key] for key in ("numberMatched", "numberReturned") if key in value
        },
    }
    for key in ("numberMatched", "numberReturned"):
        count = value.get(key)
        if count is None or (key == "numberMatched" and count == "unknown"):
            counts[key] = None
        elif type(count) is int and 0 <= count <= 9_007_199_254_740_991:
            counts[key] = count
        else:
            raise SourceArchiveFailure("response_invalid", retryable=False)
    if counts["numberReturned"] is not None and counts["numberReturned"] != len(raw_features):
        raise SourceArchiveFailure("response_invalid", retryable=False)
    allowed_fields = set(fields)
    result: list[dict[str, Any]] = []
    for raw in raw_features:
        if not isinstance(raw, dict) or raw.get("type") != "Feature":
            raise SourceArchiveFailure("response_invalid", retryable=False)
        properties = raw.get("properties")
        geometry = raw.get("geometry")
        if (
            not isinstance(properties, dict)
            or not set(properties).issubset(allowed_fields)
            or identity_field not in properties
            or not isinstance(geometry, dict)
            or geometry.get("type") != geometry_type
        ):
            raise SourceArchiveFailure("response_invalid", retryable=False)
        identity_value = properties[identity_field]
        if isinstance(identity_value, bool) or not isinstance(identity_value, str | int | float):
            raise SourceArchiveFailure("response_invalid", retryable=False)
        _validate_feature_properties(properties)
        # JSON numbers have one numeric identity: 1 and 1.0 (or 0 and -0.0)
        # must not evade cross-page duplicate detection. Preserve source values;
        # distinguish strings from numbers without converting either to floats.
        identity = ("string" if isinstance(identity_value, str) else "number", identity_value)
        if identity in identities:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        identities.add(identity)
        coordinates = geometry.get("coordinates")
        _validate_feature_coordinates(coordinates, geometry_type)
        normalized: dict[str, Any] = {
            "type": "Feature",
            "properties": {field: properties[field] for field in fields if field in properties},
            "geometry": {"type": geometry_type, "coordinates": coordinates},
        }
        feature_id = raw.get("id")
        if (
            isinstance(feature_id, str | int | float)
            and not isinstance(feature_id, bool)
            and (not isinstance(feature_id, float) or math.isfinite(feature_id))
        ):
            normalized["id"] = feature_id
        result.append(normalized)
    return result, counts


def _validate_feature_properties(value: Mapping[str, Any]) -> None:
    nodes = 0

    def visit(node: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > MAXIMUM_FEATURE_PROPERTY_NODES or depth > MAXIMUM_FEATURE_PROPERTY_DEPTH:
            raise SourceArchiveFailure("response_too_large", retryable=False)
        if node is None or isinstance(node, bool | int | str):
            return
        if isinstance(node, float):
            if not math.isfinite(node):
                raise SourceArchiveFailure("response_invalid", retryable=False)
            return
        if isinstance(node, list):
            for child in node:
                visit(child, depth + 1)
            return
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key) > 1_000:
                    raise SourceArchiveFailure("response_invalid", retryable=False)
                visit(child, depth + 1)
            return
        raise SourceArchiveFailure("response_invalid", retryable=False)

    visit(value, 0)


def _validate_feature_coordinates(value: Any, geometry_type: str) -> None:
    positions = 0

    def position(node: Any) -> tuple[float, ...]:
        nonlocal positions
        if (
            not isinstance(node, list)
            or not 2 <= len(node) <= 4
            or any(isinstance(item, bool) or not isinstance(item, int | float) for item in node)
        ):
            raise SourceArchiveFailure("response_invalid", retryable=False)
        normalized = tuple(float(item) for item in node)
        if (
            not all(math.isfinite(item) for item in normalized)
            or not -180 <= normalized[0] <= 180
            or not -90 <= normalized[1] <= 90
        ):
            raise SourceArchiveFailure("response_invalid", retryable=False)
        positions += 1
        if positions > MAXIMUM_FEATURE_POSITIONS:
            raise SourceArchiveFailure("response_too_large", retryable=False)
        return normalized

    def positions_list(node: Any, *, minimum: int) -> list[tuple[float, ...]]:
        if not isinstance(node, list) or len(node) < minimum:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        return [position(child) for child in node]

    def line(node: Any) -> None:
        positions_list(node, minimum=2)

    def ring(node: Any) -> None:
        normalized = positions_list(node, minimum=4)
        if normalized[0] != normalized[-1]:
            raise SourceArchiveFailure("response_invalid", retryable=False)

    def nested(node: Any, validator: Callable[[Any], None]) -> None:
        if not isinstance(node, list) or not node:
            raise SourceArchiveFailure("response_invalid", retryable=False)
        for child in node:
            validator(child)

    if geometry_type == "Point":
        position(value)
    elif geometry_type == "MultiPoint":
        positions_list(value, minimum=1)
    elif geometry_type == "LineString":
        line(value)
    elif geometry_type == "MultiLineString":
        nested(value, line)
    elif geometry_type == "Polygon":
        nested(value, ring)
    elif geometry_type == "MultiPolygon":
        nested(value, lambda polygon: nested(polygon, ring))
    else:
        raise SourceArchiveFailure("response_invalid", retryable=False)


class ArchiveS3Transport(Protocol):
    async def get(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]: ...

    async def put(
        self,
        url: str,
        headers: Mapping[str, str],
        source: Path,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]: ...

    async def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]: ...


class HttpxArchiveS3Transport:
    async def get(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]:
        import httpx2

        try:
            async with (
                httpx2.AsyncClient(timeout=timeout_seconds, follow_redirects=False) as client,
                client.stream("GET", url, headers=dict(headers)) as response,
            ):
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    try:
                        length = int(declared_length)
                    except ValueError as error:
                        raise SourceArchiveFailure(
                            "destination_integrity_failed", retryable=False
                        ) from error
                    if not 0 <= length <= maximum_bytes:
                        raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
                body = bytearray()
                async for chunk in response.aiter_raw():
                    if len(body) + len(chunk) > maximum_bytes:
                        raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
                    body.extend(chunk)
                return response.status_code, dict(response.headers.items()), bytes(body)
        except (httpx2.HTTPError, OSError) as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error

    async def put(
        self,
        url: str,
        headers: Mapping[str, str],
        source: Path,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]:
        import httpx2

        try:
            async with httpx2.AsyncClient(
                timeout=timeout_seconds, follow_redirects=False
            ) as client:
                response = await client.put(
                    url,
                    headers=dict(headers),
                    content=_file_chunks(source),
                )
        except (httpx2.HTTPError, OSError) as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        return response.status_code, dict(response.headers.items())

    async def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]:
        import httpx2

        try:
            async with httpx2.AsyncClient(
                timeout=timeout_seconds, follow_redirects=False
            ) as client:
                response = await client.head(url, headers=dict(headers))
        except httpx2.HTTPError as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        return response.status_code, dict(response.headers.items())


async def _file_chunks(source: Path) -> AsyncIterator[bytes]:
    with source.open("rb") as stream:
        while chunk := _read_file_chunk(stream):
            yield chunk


class AwsS3ArchiveStorage:
    """Conditionally create one immutable, checksummed, KMS-encrypted S3 object."""

    def __init__(
        self,
        *,
        region: str,
        bucket: str,
        kms_key_arn: str,
        credentials: CredentialProvider | None = None,
        transport: ArchiveS3Transport | None = None,
        now: Callable[[], datetime] | None = None,
        timeout_seconds: float = S3_TIMEOUT_SECONDS,
    ) -> None:
        if (
            re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region) is None
            or not _valid_bucket(bucket)
            or re.fullmatch(
                rf"arn:aws(?:-us-gov)?:kms:{re.escape(region)}:\d{{12}}:key/[A-Za-z0-9-]+",
                kms_key_arn,
            )
            is None
            or not 1.0 <= timeout_seconds <= S3_TIMEOUT_SECONDS
        ):
            raise ValueError("source archive storage configuration is invalid")
        self._region = region
        self._bucket = bucket
        self._kms_key_arn = kms_key_arn
        if credentials is None:
            from opengeo_api.cognito_provisioning import AwsCredentialProvider

            credentials = AwsCredentialProvider(timeout_seconds=2.0)
        self._credentials = credentials
        self._transport = transport or HttpxArchiveS3Transport()
        self._now = now or (lambda: datetime.now(UTC))
        self._timeout_seconds = timeout_seconds

    @property
    def bucket(self) -> str:
        return self._bucket

    def _discovery_receipt(self, key: str, headers: Mapping[str, str]) -> dict[str, Any]:
        values = {name.casefold(): value for name, value in headers.items()}
        try:
            size = int(values["content-length"])
            checksum = base64.b64decode(values["x-amz-checksum-sha256"], validate=True).hex()
            retrieved = values["x-amz-meta-opengeo-retrieved-at"]
            observed = datetime.fromisoformat(retrieved)
            version = values["x-amz-version-id"]
            etag = values["etag"].strip('"').casefold()
            if (
                not 32_769 <= size <= 2_097_152
                or observed.tzinfo is None
                or not version
                or version == "null"
                or len(version) > 1_024
                or _HEX_ETAG.fullmatch(etag) is None
                or _SHA256.fullmatch(checksum) is None
                or values.get("x-amz-meta-opengeo-sha256") != checksum
                or values.get("content-type") != "application/octet-stream"
                or values.get("content-encoding") not in {None, "identity"}
                or "content-range" in values
                or values.get("x-amz-server-side-encryption") != "aws:kms"
                or values.get("x-amz-server-side-encryption-aws-kms-key-id") != self._kms_key_arn
            ):
                raise ValueError("invalid receipt")
        except (KeyError, ValueError) as error:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False) from error
        return {
            "status": "retained_object",
            "body_base64": None,
            "byte_length": size,
            "sha256": checksum,
            "retrieved_at": retrieved,
            "object": {
                "bucket": self._bucket,
                "key": key,
                "version_id": version,
                "etag": etag,
                "content_type": "application/octet-stream",
            },
        }

    async def read_discovery_document(self, key: str) -> tuple[bytes, dict[str, Any]] | None:
        """Recover a committed first response before retrying the provider."""
        from opengeo_api.cognito_provisioning import IdentityProvisioningUnavailable

        if not valid_discovery_metadata_key(key):
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        empty_hash = hashlib.sha256(b"").hexdigest()
        listing_headers = {"x-amz-content-sha256": empty_hash}
        url, signed = self._signed_request(
            "GET",
            "",
            listing_headers,
            empty_hash,
            credentials,
            self._now().astimezone(UTC),
            query_parameters={"list-type": "2", "max-keys": "1", "prefix": key},
        )
        status, _, listing = await self._transport.get(url, signed, self._timeout_seconds, 16_384)
        if status != 200:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        namespace = "{http://s3.amazonaws.com/doc/2006-03-01/}"
        try:
            if b"<!DOCTYPE" in listing.upper() or b"<!ENTITY" in listing.upper():
                raise ValueError("invalid listing")
            root = ElementTree.fromstring(listing)
            contents = root.findall(f"{namespace}Contents")
            count = root.findtext(f"{namespace}KeyCount")
            truncated = root.findtext(f"{namespace}IsTruncated")
            if (
                root.tag != f"{namespace}ListBucketResult"
                or root.findtext(f"{namespace}Prefix") != key
                or root.findtext(f"{namespace}MaxKeys") != "1"
                or count not in {"0", "1"}
                or len(contents) != int(count)
                or truncated not in {"true", "false"}
                or (not contents and truncated != "false")
                or (contents and contents[0].findtext(f"{namespace}Key") != key)
            ):
                raise ValueError("invalid listing")
        except (ElementTree.ParseError, ValueError) as error:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False) from error
        if not contents:
            return None
        headers = {"x-amz-checksum-mode": "ENABLED", "x-amz-content-sha256": empty_hash}
        # The GET returns an internally coherent body, checksum and immutable
        # version. No caller supplied a pinned version here. A preceding checksum
        # HEAD would repeat the same receipt lookup and can require another KMS
        # operation; the bounded transport rejects oversized headers before reading.
        url, signed = self._signed_request(
            "GET",
            key,
            headers,
            empty_hash,
            credentials,
            self._now().astimezone(UTC),
        )
        status, response_headers, body = await self._transport.get(
            url, signed, self._timeout_seconds, 2_097_152
        )
        if status != 200:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        document = self._discovery_receipt(key, response_headers)
        if (
            len(body) != document["byte_length"]
            or hashlib.sha256(body).hexdigest() != document["sha256"]
        ):
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
        return body, document

    async def store_discovery_document(
        self, key: str, body: bytes, retrieved_at: str
    ) -> tuple[bytes, dict[str, Any]]:
        """Retain metadata separately from the unchanged Layer capture contract."""
        from opengeo_api.cognito_provisioning import IdentityProvisioningUnavailable

        if not valid_discovery_metadata_key(key) or not 32_769 <= len(body) <= 2_097_152:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
        try:
            if datetime.fromisoformat(retrieved_at).tzinfo is None:
                raise ValueError("missing time zone")
            credentials = self._credentials.load()
        except ValueError as error:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False) from error
        except IdentityProvisioningUnavailable as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        checksum = hashlib.sha256(body).hexdigest()
        headers = {
            "content-length": str(len(body)),
            "content-type": "application/octet-stream",
            "if-none-match": "*",
            "x-amz-content-sha256": checksum,
            "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(checksum)).decode("ascii"),
            "x-amz-meta-opengeo-sha256": checksum,
            "x-amz-meta-opengeo-retrieved-at": retrieved_at,
            "x-amz-server-side-encryption": "aws:kms",
            "x-amz-server-side-encryption-aws-kms-key-id": self._kms_key_arn,
        }
        url, signed = self._signed_request(
            "PUT", key, headers, checksum, credentials, self._now().astimezone(UTC)
        )
        with tempfile.TemporaryDirectory(prefix="opengeo-discovery-response-") as directory:
            source = Path(directory) / "response.bin"
            source.write_bytes(body)
            status, response_headers = await self._transport.put(
                url, signed, source, self._timeout_seconds
            )
        if status in {409, 412}:
            existing = await self.read_discovery_document(key)
            if existing is not None:
                return existing
        if status != 200:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        # Length/type/retrieval metadata were fixed in the signed request. S3 supplies
        # the actual immutable version, ETag and checksum in the successful response.
        receipt_headers = {**headers, **{k.casefold(): v for k, v in response_headers.items()}}
        document = self._discovery_receipt(key, receipt_headers)
        return body, document

    async def store(
        self,
        object_key: str,
        source: Path,
        fetched: FetchedArchive,
    ) -> StoredArchive:
        source_size = _file_size(source)
        if (
            not _safe_object_key(object_key)
            or source_size != fetched.size_bytes
            or _SHA256.fullmatch(fetched.checksum_sha256) is None
            or fetched.content_type in {"image/tiff", "image/geotiff"}
        ):
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
        timestamp = self._now().astimezone(UTC)
        from opengeo_api.cognito_provisioning import IdentityProvisioningUnavailable

        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise SourceArchiveFailure("destination_unavailable", retryable=True) from error
        checksum_b64 = base64.b64encode(bytes.fromhex(fetched.checksum_sha256)).decode("ascii")
        headers = {
            "content-length": str(fetched.size_bytes),
            "content-type": fetched.content_type,
            "if-none-match": "*",
            "x-amz-checksum-sha256": checksum_b64,
            "x-amz-content-sha256": fetched.checksum_sha256,
            "x-amz-meta-opengeo-sha256": fetched.checksum_sha256,
            "x-amz-server-side-encryption": "aws:kms",
            "x-amz-server-side-encryption-aws-kms-key-id": self._kms_key_arn,
        }
        url, signed = self._signed_request(
            "PUT", object_key, headers, fetched.checksum_sha256, credentials, timestamp
        )
        status, response_headers = await self._transport.put(
            url, signed, source, self._timeout_seconds
        )
        if status in {409, 412}:
            return await self._reconcile(object_key, fetched, credentials)
        if status != 200:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        return _stored_archive(
            self._bucket,
            object_key,
            fetched,
            response_headers,
            require_metadata=False,
        )

    async def _reconcile(
        self,
        object_key: str,
        fetched: FetchedArchive,
        credentials: AwsCredentials,
    ) -> StoredArchive:
        timestamp = self._now().astimezone(UTC)
        payload_hash = hashlib.sha256(b"").hexdigest()
        url, headers = self._signed_request(
            "HEAD",
            object_key,
            {"x-amz-checksum-mode": "ENABLED", "x-amz-content-sha256": payload_hash},
            payload_hash,
            credentials,
            timestamp,
        )
        status, response_headers = await self._transport.head(url, headers, self._timeout_seconds)
        if status == 404:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        if status != 200:
            raise SourceArchiveFailure("destination_unavailable", retryable=True)
        return _stored_archive(
            self._bucket,
            object_key,
            fetched,
            response_headers,
            require_metadata=True,
        )

    def _signed_request(
        self,
        method: str,
        object_key: str,
        extra_headers: Mapping[str, str],
        payload_hash: str,
        credentials: AwsCredentials,
        timestamp: datetime,
        version_id: str | None = None,
        *,
        query_parameters: Mapping[str, str] | None = None,
    ) -> tuple[str, dict[str, str]]:
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = regional_s3_host(self._region)
        canonical_uri = object_path(self._bucket, object_key)
        canonical = {
            "host": host,
            "x-amz-date": amz_date,
            **{name.casefold(): value for name, value in extra_headers.items()},
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical))
        serialized = "".join(
            f"{name}:{' '.join(canonical[name].strip().split())}\n" for name in sorted(canonical)
        )
        parameters = dict(query_parameters or {})
        if version_id is not None:
            parameters["versionId"] = version_id
        query = "&".join(
            f"{quote(name, safe='-_.~')}={quote(value, safe='-_.~')}"
            for name, value in sorted(parameters.items())
        )
        canonical_request = "\n".join(
            [method, canonical_uri, query, serialized, signed_names, payload_hash]
        )
        scope = f"{date_stamp}/{self._region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            _aws_signing_key(credentials.secret_access_key, date_stamp, self._region),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        return f"https://{host}{canonical_uri}" + (f"?{query}" if query else ""), {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }


def _stored_archive(
    bucket: str,
    object_key: str,
    fetched: FetchedArchive,
    response_headers: Mapping[str, str],
    *,
    require_metadata: bool,
) -> StoredArchive:
    content_type = fetched.content_type
    if content_type not in {"image/png", "application/vnd.pmtiles", "application/geo+json"}:
        # Metadata and referenced files are intermediate reads, not Layer captures.
        raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
    normalized = {name.casefold(): value for name, value in response_headers.items()}
    version_id = normalized.get("x-amz-version-id", "")
    etag = normalized.get("etag", "").strip('"')
    checksum = normalized.get("x-amz-checksum-sha256")
    metadata_checksum = normalized.get("x-amz-meta-opengeo-sha256")
    if (
        not version_id
        or version_id == "null"
        or len(version_id) > 1_024
        or _HEX_ETAG.fullmatch(etag) is None
    ):
        raise SourceArchiveFailure("destination_integrity_failed", retryable=False)
    if checksum is not None:
        try:
            checksum_hex = base64.b64decode(checksum, validate=True).hex()
        except ValueError as error:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False) from error
        if checksum_hex != fetched.checksum_sha256:
            raise SourceArchiveFailure("destination_conflict", retryable=False)
    if require_metadata:
        try:
            length = int(normalized["content-length"])
            media_type = normalized["content-type"].split(";", 1)[0].strip().casefold()
        except (KeyError, ValueError) as error:
            raise SourceArchiveFailure("destination_integrity_failed", retryable=False) from error
        if (
            metadata_checksum != fetched.checksum_sha256
            or length != fetched.size_bytes
            or media_type != fetched.content_type
        ):
            raise SourceArchiveFailure("destination_conflict", retryable=False)
    return StoredArchive(
        bucket,
        object_key,
        version_id,
        etag.casefold(),
        content_type,
        fetched.size_bytes,
        fetched.checksum_sha256,
    )


def _valid_bucket(value: str) -> bool:
    return bool(
        re.fullmatch(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value)
        and ".." not in value
        and ".-" not in value
        and "-." not in value
        and re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", value) is None
    )


def _safe_object_key(value: str) -> bool:
    return bool(
        isinstance(value, str)
        and 1 <= len(value.encode("utf-8")) <= 1_024
        and value.startswith("organizations/")
        and value == value.strip()
        and "//" not in value
        and not value.endswith("/")
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def _file_size(source: Path) -> int | None:
    try:
        if not source.is_file():
            return None
        return source.stat().st_size
    except OSError:
        return None


def _remove_file(source: Path) -> None:
    source.unlink()


def _publish_public_file(source: Path, destination: Path) -> None:
    with source.open("rb") as stream:
        prefix = stream.read(8)
    if prefix[:4] not in {b"II*\0", b"MM\0*"} and prefix not in {
        b"II+\0\x08\0\0\0",
        b"MM\0+\0\x08\0\0",
    }:
        raise SourceArchiveFailure("response_magic_rejected", retryable=False)
    # link() refuses existing files and symlinks, including a destination raced
    # into existence after the initial check. TemporaryDirectory owns the source.
    os.link(source, destination)


def _append_file(destination: Path, body: bytes) -> None:
    with destination.open("ab") as stream:
        if stream.write(body) != len(body):
            raise OSError("short archive write")


def _canonical_feature_page_bytes(
    features: list[dict[str, Any]],
    leading_comma: bool,
) -> bytes:
    if not features:
        return b""
    try:
        encoded = json.dumps(
            features,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (RecursionError, TypeError, ValueError) as error:
        raise SourceArchiveFailure("response_invalid", retryable=False) from error
    body = encoded[1:-1]
    return b"," + body if leading_comma else body


def _read_file_chunk(stream: Any) -> bytes:
    return cast(bytes, stream.read(1024 * 1024))


def _aws_signing_key(secret: str, date_stamp: str, region: str) -> bytes:
    date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def canonical_artifact_json(stored: StoredArchive, artifact_id: str) -> dict[str, Any]:
    if (
        re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            artifact_id,
        )
        is None
    ):
        raise ValueError("artifact id must be a canonical UUIDv4")
    return {
        "id": artifact_id,
        "role": "original",
        "bucket": stored.bucket,
        "object_key": stored.object_key,
        "s3_version_id": stored.s3_version_id,
        "etag": stored.etag,
        "content_type": stored.content_type,
        "size_bytes": stored.size_bytes,
        "checksum_sha256": stored.checksum_sha256,
    }


def artifact_json_bytes(stored: StoredArchive, artifact_id: str) -> bytes:
    """Expose a deterministic bounded form for tests and database transport."""

    return json.dumps(
        canonical_artifact_json(stored, artifact_id),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
