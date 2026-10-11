import asyncio
import base64
import hashlib
import hmac
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    CredentialProvider,
)
from opengeo_api.config import Settings
from opengeo_api.s3_endpoints import object_path, regional_s3_host
from opengeo_api.source_archiver import valid_discovery_metadata_key

EXACT_OBJECT_CONTENT_TYPES = frozenset(
    {
        "application/csv",
        "application/geo+json",
        "application/vnd.google-earth.kml+xml",
        "application/geopackage+sqlite3",
        "application/json",
        "application/octet-stream",
        "application/vnd.apache.parquet",
        "application/vnd.pmtiles",
        "application/vnd.sqlite3",
        "application/x-parquet",
        "application/x-ipynb+json",
        "application/x-zip-compressed",
        "application/zip",
        "image/geotiff",
        "image/png",
        "image/jpeg",
        "image/svg+xml",
        "image/tiff",
        "text/csv",
        "text/css",
        "text/html",
        "text/javascript",
        "text/markdown",
        "text/plain",
    }
)


class DownloadStorageUnavailable(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DownloadSpec:
    bucket: str
    key: str
    version_id: str
    filename: str
    disposition: Literal["attachment", "inline"] = "attachment"
    ttl_seconds: int | None = None


@dataclass(frozen=True, slots=True)
class DownloadTicket:
    url: str
    method: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ExactObjectSpec:
    bucket: str
    key: str
    version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    maximum_bytes: int


@dataclass(frozen=True, slots=True)
class ExactObject:
    body: bytes
    content_type: str
    size_bytes: int
    checksum_sha256: str
    version_id: str


class DownloadStorage(Protocol):
    async def create_download_url(self, spec: DownloadSpec) -> DownloadTicket: ...

    async def read_exact_object(self, spec: ExactObjectSpec) -> ExactObject: ...


class UnavailableDownloadStorage:
    async def create_download_url(self, spec: DownloadSpec) -> DownloadTicket:
        del spec
        raise DownloadStorageUnavailable("download storage is not configured")

    async def read_exact_object(self, spec: ExactObjectSpec) -> ExactObject:
        del spec
        raise DownloadStorageUnavailable("download storage is not configured")


class S3GetTransport(Protocol):
    def get(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class UrlS3GetTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def get(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(url, headers=dict(headers), method="GET")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                body = response.read(maximum_bytes + 1)
                return response.status, dict(response.headers.items()), body
        except HTTPError as error:
            return error.code, dict(error.headers.items()), b""
        except (URLError, TimeoutError, OSError) as error:
            raise DownloadStorageUnavailable("S3 could not be reached") from error


class AwsS3DownloadStorage:
    """Presign downloads and read a bounded immutable S3 object version."""

    def __init__(
        self,
        settings: Settings,
        bucket: str | None = None,
        credentials: CredentialProvider | None = None,
        transport: S3GetTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.upload_configured:
            raise ValueError("download storage must be configured")
        assert settings.aws_region is not None
        assert settings.geodata_bucket is not None
        self._region = settings.aws_region
        self._bucket = bucket or settings.geodata_bucket
        self._host = regional_s3_host(self._region)
        self._ttl_seconds = settings.download_url_ttl_seconds
        self._timeout_seconds = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlS3GetTransport()
        self._now = now or (lambda: datetime.now(UTC))

    async def create_download_url(self, spec: DownloadSpec) -> DownloadTicket:
        return await asyncio.to_thread(self._create_download_url, spec)

    async def read_exact_object(self, spec: ExactObjectSpec) -> ExactObject:
        return await asyncio.to_thread(self._read_exact_object, spec)

    def _create_download_url(self, spec: DownloadSpec) -> DownloadTicket:
        if (
            spec.bucket != self._bucket
            or not spec.key
            or not spec.version_id
            or re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._ -]{0,179}", spec.filename) is None
            or spec.disposition not in {"attachment", "inline"}
            or (
                spec.ttl_seconds is not None
                and (type(spec.ttl_seconds) is not int or not 1 <= spec.ttl_seconds <= 900)
            )
            or (spec.disposition == "inline" and not spec.filename.endswith(".html"))
        ):
            raise DownloadStorageUnavailable("download object is outside configured storage")
        credentials = self._credentials.load()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        scope = f"{date_stamp}/{self._region}/s3/aws4_request"
        host = self._host
        canonical_uri = object_path(self._bucket, spec.key)
        disposition = f'{spec.disposition}; filename="{spec.filename}"'
        ttl_seconds = min(self._ttl_seconds, spec.ttl_seconds or self._ttl_seconds)
        parameters = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{credentials.access_key_id}/{scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(ttl_seconds),
            "X-Amz-SignedHeaders": "host",
            "response-content-disposition": disposition,
            "versionId": spec.version_id,
        }
        if spec.disposition == "inline":
            # The share gate authorizes a retained HTML edition. Its bytes are
            # served by S3, with no browser/proxy cache or attachment conversion.
            parameters["response-content-type"] = "text/html; charset=utf-8"
            parameters["response-cache-control"] = "private, no-store"
        if credentials.session_token:
            parameters["X-Amz-Security-Token"] = credentials.session_token
        canonical_query = self._query(parameters)
        canonical_request = "\n".join(
            ["GET", canonical_uri, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"]
        )
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._signing_key(credentials.secret_access_key, date_stamp),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        return DownloadTicket(
            url=f"https://{host}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}",
            method="GET",
            expires_at=timestamp + timedelta(seconds=ttl_seconds),
        )

    def _read_exact_object(self, spec: ExactObjectSpec) -> ExactObject:
        if (
            spec.bucket != self._bucket
            or not self._valid_key(spec.key)
            or not spec.version_id
            or spec.content_type not in EXACT_OBJECT_CONTENT_TYPES
            or not 1 <= spec.size_bytes <= spec.maximum_bytes <= 4_194_304
            or re.fullmatch(r"[0-9a-f]{64}", spec.checksum_sha256) is None
        ):
            raise DownloadStorageUnavailable("exact object is outside the direct-read boundary")
        credentials = self._credentials.load()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = self._host
        canonical_uri = object_path(self._bucket, spec.key)
        canonical_query = self._query({"versionId": spec.version_id})
        payload_hash = hashlib.sha256(b"").hexdigest()
        canonical_headers = {
            "host": host,
            "x-amz-checksum-mode": "ENABLED",
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if credentials.session_token:
            canonical_headers["x-amz-security-token"] = credentials.session_token
        signed_header_names = ";".join(sorted(canonical_headers))
        serialized_headers = "".join(
            f"{name}:{canonical_headers[name]}\n" for name in sorted(canonical_headers)
        )
        canonical_request = "\n".join(
            [
                "GET",
                canonical_uri,
                canonical_query,
                serialized_headers,
                signed_header_names,
                payload_hash,
            ]
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
            self._signing_key(credentials.secret_access_key, date_stamp),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical_headers,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_header_names}, Signature={signature}"
            ),
        }
        status_code, response_headers, body = self._transport.get(
            f"https://{host}{canonical_uri}?{canonical_query}",
            headers,
            self._timeout_seconds,
            spec.maximum_bytes,
        )
        if status_code != 200:
            raise DownloadStorageUnavailable("exact S3 object read failed")
        normalized = {name.lower(): value for name, value in response_headers.items()}
        try:
            version_id = normalized["x-amz-version-id"]
            content_type = normalized["content-type"].split(";", 1)[0].strip().lower()
            size_bytes = int(normalized["content-length"])
            checksum = base64.b64decode(normalized["x-amz-checksum-sha256"], validate=True).hex()
        except (KeyError, ValueError) as error:
            raise DownloadStorageUnavailable("exact S3 response metadata is incomplete") from error
        if (
            version_id != spec.version_id
            or content_type != spec.content_type
            or normalized.get("content-encoding") not in {None, "identity"}
            or "content-range" in normalized
            or size_bytes != spec.size_bytes
            or len(body) != spec.size_bytes
            or len(body) > spec.maximum_bytes
            or checksum != spec.checksum_sha256
            or hashlib.sha256(body).hexdigest() != spec.checksum_sha256
        ):
            raise DownloadStorageUnavailable("exact S3 response does not match recorded output")
        return ExactObject(
            body=body,
            content_type=content_type,
            size_bytes=size_bytes,
            checksum_sha256=checksum,
            version_id=version_id,
        )

    @staticmethod
    def _query(parameters: dict[str, str]) -> str:
        encoded = [
            (quote(name, safe="-_.~"), quote(value, safe="-_.~"))
            for name, value in parameters.items()
        ]
        return "&".join(f"{name}={value}" for name, value in sorted(encoded))

    @staticmethod
    def _valid_key(key: str) -> bool:
        return (
            (key.startswith("organizations/") or valid_discovery_metadata_key(key))
            and len(key) <= 1_024
            and "\\" not in key
            and not any(ord(character) < 32 or ord(character) == 127 for character in key)
            and all(segment not in {"", ".", ".."} for segment in key.split("/"))
        )

    def _signing_key(self, secret_access_key: str, date_stamp: str) -> bytes:
        date_key = hmac.new(
            f"AWS4{secret_access_key}".encode(), date_stamp.encode(), hashlib.sha256
        ).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
