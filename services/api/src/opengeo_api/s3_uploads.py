import asyncio
import base64
import hashlib
import hmac
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
)
from opengeo_api.config import Settings
from opengeo_api.s3_endpoints import bucket_path, object_path, regional_s3_host


class UploadStorageUnavailable(RuntimeError):
    pass


class UploadObjectNotFound(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class UploadSpec:
    key: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class UploadForm:
    url: str
    method: str
    fields: Mapping[str, str]
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class StoredObject:
    bucket: str
    key: str
    version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


class UploadStorage(Protocol):
    @property
    def bucket(self) -> str: ...

    async def create_upload_form(self, spec: UploadSpec) -> UploadForm: ...

    async def inspect_object(self, key: str) -> StoredObject: ...


class UnavailableUploadStorage:
    @property
    def bucket(self) -> str:
        raise UploadStorageUnavailable("upload storage is not configured")

    async def create_upload_form(self, spec: UploadSpec) -> UploadForm:
        del spec
        raise UploadStorageUnavailable("upload storage is not configured")

    async def inspect_object(self, key: str) -> StoredObject:
        del key
        raise UploadStorageUnavailable("upload storage is not configured")


class S3HeadTransport(Protocol):
    def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class UrlS3HeadTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str]]:
        request = Request(url, headers=dict(headers), method="HEAD")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return response.status, dict(response.headers.items())
        except HTTPError as error:
            return error.code, dict(error.headers.items())
        except (URLError, TimeoutError, OSError) as error:
            raise UploadStorageUnavailable("S3 could not be reached") from error


class AwsS3UploadStorage:
    """Create exact-policy browser POSTs and verify the immutable S3 version on completion."""

    def __init__(
        self,
        settings: Settings,
        bucket: str | None = None,
        credentials: CredentialProvider | None = None,
        transport: S3HeadTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not settings.upload_configured:
            raise ValueError("upload storage must be configured")
        assert settings.aws_region is not None
        assert settings.geodata_bucket is not None
        assert settings.geodata_kms_key_arn is not None
        self._region = settings.aws_region
        self._bucket = bucket or settings.geodata_bucket
        self._host = regional_s3_host(self._region)
        self._kms_key_arn = settings.geodata_kms_key_arn
        self._ttl_seconds = settings.upload_url_ttl_seconds
        self._timeout_seconds = settings.cognito_http_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.cognito_http_timeout_seconds
        )
        self._transport = transport or UrlS3HeadTransport()
        self._now = now or (lambda: datetime.now(UTC))

    @property
    def bucket(self) -> str:
        return self._bucket

    async def create_upload_form(self, spec: UploadSpec) -> UploadForm:
        return await asyncio.to_thread(self._create_upload_form, spec)

    def _create_upload_form(self, spec: UploadSpec) -> UploadForm:
        credentials = self._credentials.load()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        scope = f"{date_stamp}/{self._region}/s3/aws4_request"
        credential = f"{credentials.access_key_id}/{scope}"
        checksum = base64.b64encode(bytes.fromhex(spec.checksum_sha256)).decode("ascii")
        expiration = timestamp + timedelta(seconds=self._ttl_seconds)
        conditions: list[object] = [
            {"bucket": self._bucket},
            ["eq", "$key", spec.key],
            ["eq", "$Content-Type", spec.content_type],
            ["content-length-range", spec.size_bytes, spec.size_bytes],
            {"x-amz-checksum-sha256": checksum},
            {"x-amz-server-side-encryption": "aws:kms"},
            {"x-amz-server-side-encryption-aws-kms-key-id": self._kms_key_arn},
            {"x-amz-algorithm": "AWS4-HMAC-SHA256"},
            {"x-amz-credential": credential},
            {"x-amz-date": amz_date},
        ]
        if credentials.session_token:
            conditions.append({"x-amz-security-token": credentials.session_token})
        policy_document = {
            "expiration": expiration.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "conditions": conditions,
        }
        policy = base64.b64encode(
            json.dumps(policy_document, separators=(",", ":"), sort_keys=True).encode()
        ).decode("ascii")
        signature = hmac.new(
            self._signing_key(credentials, date_stamp),
            policy.encode(),
            hashlib.sha256,
        ).hexdigest()
        fields = {
            "key": spec.key,
            "Content-Type": spec.content_type,
            "x-amz-checksum-sha256": checksum,
            "x-amz-server-side-encryption": "aws:kms",
            "x-amz-server-side-encryption-aws-kms-key-id": self._kms_key_arn,
            "x-amz-algorithm": "AWS4-HMAC-SHA256",
            "x-amz-credential": credential,
            "x-amz-date": amz_date,
            "policy": policy,
            "x-amz-signature": signature,
        }
        if credentials.session_token:
            fields["x-amz-security-token"] = credentials.session_token
        return UploadForm(
            url=f"https://{self._host}{bucket_path(self._bucket)}",
            method="POST",
            fields=fields,
            expires_at=expiration,
        )

    async def inspect_object(self, key: str) -> StoredObject:
        return await asyncio.to_thread(self._inspect_object, key)

    def _inspect_object(self, key: str) -> StoredObject:
        credentials = self._credentials.load()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = self._host
        canonical_uri = object_path(self._bucket, key)
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
                "HEAD",
                canonical_uri,
                "",
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
            self._signing_key(credentials, date_stamp),
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
        status_code, response_headers = self._transport.head(
            f"https://{host}{canonical_uri}",
            headers,
            self._timeout_seconds,
        )
        if status_code == 404:
            raise UploadObjectNotFound("uploaded object does not exist")
        if status_code != 200:
            raise UploadStorageUnavailable("S3 object verification failed")
        normalized = {name.lower(): value for name, value in response_headers.items()}
        try:
            version_id = normalized["x-amz-version-id"]
            etag = normalized["etag"].strip('"')
            content_type = normalized["content-type"].split(";", 1)[0].strip().lower()
            size_bytes = int(normalized["content-length"])
            checksum_bytes = base64.b64decode(normalized["x-amz-checksum-sha256"], validate=True)
        except (KeyError, ValueError) as error:
            raise UploadStorageUnavailable("S3 verification metadata is incomplete") from error
        if not version_id or version_id == "null" or not etag or len(checksum_bytes) != 32:
            raise UploadStorageUnavailable("S3 verification metadata is invalid")
        return StoredObject(
            bucket=self._bucket,
            key=key,
            version_id=version_id,
            etag=etag,
            content_type=content_type,
            size_bytes=size_bytes,
            checksum_sha256=checksum_bytes.hex(),
        )

    def _signing_key(self, credentials: AwsCredentials, date_stamp: str) -> bytes:
        date_key = hmac.new(
            f"AWS4{credentials.secret_access_key}".encode(),
            date_stamp.encode(),
            hashlib.sha256,
        ).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, b"s3", hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()
