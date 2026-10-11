import base64
import hashlib
import hmac
import http.client
import json
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
from uuid import UUID
from xml.etree import ElementTree

from opengeo_worker.config import Settings
from opengeo_worker.models import (
    ArtifactFile,
    JobClaim,
    ObjectReference,
    QueueMessage,
    S3ObjectEvent,
    StoredArtifact,
    TransientFailure,
    ValidationFailure,
)

_OUTPUT_PREFIX = re.compile(
    r"organizations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"datasets/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/derivatives/"
)
_COVERAGE_DERIVATIVE_KEY = re.compile(
    r"organizations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"datasets/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"derivatives/coverages/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tif"
)
_RENDER_CACHE_KEY = re.compile(
    r"organizations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"datasets/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"derivatives/renders/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:svg|png)"
)
_PMTILES_DERIVATIVE_KEY = re.compile(
    r"organizations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"datasets/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"derivatives/tiles/custom/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pmtiles"
)
_MANAGED_VECTOR_SOURCE_KEY = re.compile(
    r"organizations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"projects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"datasets/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"(?:uploads/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"original/[A-Za-z0-9][A-Za-z0-9._ -]{2,254}|"
    r"versions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/"
    r"derivatives/working/layer-[0-9]{3}\.parquet)"
)
_PMTILES_SOURCE_CONTENT_TYPES = frozenset(
    {
        "application/geo+json",
        "application/geopackage+sqlite3",
        "application/vnd.apache.parquet",
        "application/zip",
        "text/csv",
    }
)


@dataclass(frozen=True, slots=True)
class AwsCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


class CredentialProvider(Protocol):
    def load(self) -> AwsCredentials: ...


class AwsCredentialProvider:
    """Load only explicit or ECS task-role credentials from the fixed link-local endpoint."""

    def __init__(
        self,
        environ: Mapping[str, str] | None = None,
        opener: Callable[..., Any] = urlopen,
        timeout_seconds: float = 2.0,
    ) -> None:
        self._environ = environ if environ is not None else os.environ
        self._opener = opener
        self._timeout_seconds = timeout_seconds

    def load(self) -> AwsCredentials:
        access_key = self._environ.get("AWS_ACCESS_KEY_ID")
        secret_key = self._environ.get("AWS_SECRET_ACCESS_KEY")
        if access_key and secret_key:
            return self._validate(
                AwsCredentials(access_key, secret_key, self._environ.get("AWS_SESSION_TOKEN"))
            )
        relative_uri = self._environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        if (
            not relative_uri
            or re.fullmatch(r"/[A-Za-z0-9/_-]{1,1024}", relative_uri) is None
            or ".." in relative_uri
        ):
            raise TransientFailure("aws_credentials_unavailable")
        request = Request(f"http://169.254.170.2{relative_uri}")
        try:
            with self._opener(request, timeout=self._timeout_seconds) as response:
                body = response.read(16_385)
            if len(body) > 16_384:
                raise ValueError("credential response too large")
            payload = json.loads(body)
            credentials = AwsCredentials(
                access_key_id=payload["AccessKeyId"],
                secret_access_key=payload["SecretAccessKey"],
                session_token=payload["Token"],
            )
        except (
            HTTPError,
            URLError,
            TimeoutError,
            OSError,
            ValueError,
            KeyError,
            TypeError,
        ) as error:
            raise TransientFailure("aws_credentials_unavailable") from error
        return self._validate(credentials)

    @staticmethod
    def _validate(credentials: AwsCredentials) -> AwsCredentials:
        values = (credentials.access_key_id, credentials.secret_access_key)
        if any(not isinstance(value, str) or not 8 <= len(value) <= 256 for value in values) or (
            credentials.session_token is not None
            and not 1 <= len(credentials.session_token) <= 4096
        ):
            raise TransientFailure("aws_credentials_invalid")
        return credentials


class SigV4Signer:
    def __init__(
        self,
        region: str,
        credentials: CredentialProvider,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._region = region
        self._credentials = credentials
        self._now = now or (lambda: datetime.now(UTC))

    def sign(
        self,
        *,
        method: str,
        service: str,
        host: str,
        path: str,
        query: Mapping[str, str] | None,
        headers: Mapping[str, str],
        payload_hash: str,
    ) -> dict[str, str]:
        credentials = self._credentials.load()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        canonical_headers = {
            key.lower().strip(): " ".join(value.strip().split()) for key, value in headers.items()
        }
        canonical_headers.update(
            {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
        )
        if credentials.session_token:
            canonical_headers["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical_headers))
        serialized_headers = "".join(
            f"{name}:{canonical_headers[name]}\n" for name in sorted(canonical_headers)
        )
        canonical_query = "&".join(
            f"{_aws_quote(name)}={_aws_quote(value)}"
            for name, value in sorted((query or {}).items())
        )
        canonical_request = "\n".join(
            [
                method,
                path,
                canonical_query,
                serialized_headers,
                signed_names,
                payload_hash,
            ]
        )
        scope = f"{date_stamp}/{self._region}/{service}/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._signing_key(credentials.secret_access_key, date_stamp, service),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        return {
            **canonical_headers,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }

    def _signing_key(self, secret: str, date_stamp: str, service: str) -> bytes:
        date_key = hmac.new(f"AWS4{secret}".encode(), date_stamp.encode(), hashlib.sha256).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, service.encode(), hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes = b""


class QueryTransport(Protocol):
    def call(
        self, url: str, headers: Mapping[str, str], body: bytes, timeout_seconds: float
    ) -> HttpResponse: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        return None


class UrlQueryTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def call(
        self, url: str, headers: Mapping[str, str], body: bytes, timeout_seconds: float
    ) -> HttpResponse:
        request = Request(url, data=body, headers=dict(headers), method="POST")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                response_body = response.read(1_048_577)
                return HttpResponse(response.status, dict(response.headers.items()), response_body)
        except HTTPError as error:
            return HttpResponse(error.code, dict(error.headers.items()), error.read(65_537))
        except (URLError, TimeoutError, OSError) as error:
            raise TransientFailure("aws_service_unavailable") from error


class SqsQueue:
    def __init__(
        self,
        settings: Settings,
        signer: SigV4Signer | None = None,
        transport: QueryTransport | None = None,
    ) -> None:
        parsed = urlsplit(settings.processing_queue_url)
        self._url = settings.processing_queue_url
        self._host = parsed.netloc
        self._path = parsed.path
        self._timeout = settings.http_timeout_seconds
        self._signer = signer or SigV4Signer(
            settings.aws_region, AwsCredentialProvider(timeout_seconds=2)
        )
        self._transport = transport or UrlQueryTransport()

    def receive(self, visibility_seconds: int) -> QueueMessage | None:
        response = self._action(
            {
                "Action": "ReceiveMessage",
                "AttributeName.1": "ApproximateReceiveCount",
                "MaxNumberOfMessages": "1",
                "VisibilityTimeout": str(visibility_seconds),
                "WaitTimeSeconds": "20",
                "Version": "2012-11-05",
            }
        )
        root = self._xml(response)
        message = _first_xml(root, "Message")
        if message is None:
            return None
        message_id = _required_xml_text(message, "MessageId")
        receipt = _required_xml_text(message, "ReceiptHandle")
        body = _required_xml_text(message, "Body")
        receive_count = 1
        for attribute in _xml_children(message, "Attribute"):
            if _required_xml_text(attribute, "Name") == "ApproximateReceiveCount":
                try:
                    receive_count = int(_required_xml_text(attribute, "Value"))
                except ValueError as error:
                    raise TransientFailure("sqs_response_invalid") from error
        if not 1 <= len(message_id) <= 128 or not 1 <= len(receipt) <= 4096 or receive_count < 1:
            raise TransientFailure("sqs_response_invalid")
        return QueueMessage(message_id, receipt, body, receive_count)

    def delete(self, receipt_handle: str) -> None:
        self._xml(
            self._action(
                {
                    "Action": "DeleteMessage",
                    "ReceiptHandle": receipt_handle,
                    "Version": "2012-11-05",
                }
            )
        )

    def change_visibility(self, receipt_handle: str, visibility_seconds: int) -> None:
        self._xml(
            self._action(
                {
                    "Action": "ChangeMessageVisibility",
                    "ReceiptHandle": receipt_handle,
                    "VisibilityTimeout": str(visibility_seconds),
                    "Version": "2012-11-05",
                }
            )
        )

    def _action(self, values: Mapping[str, str]) -> HttpResponse:
        body = urlencode(values).encode()
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = self._signer.sign(
            method="POST",
            service="sqs",
            host=self._host,
            path=self._path,
            query=None,
            headers={"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
            payload_hash=payload_hash,
        )
        return self._transport.call(self._url, headers, body, self._timeout)

    @staticmethod
    def _xml(response: HttpResponse) -> ElementTree.Element:
        if response.status != 200 or len(response.body) > 1_048_576:
            raise TransientFailure("sqs_request_failed")
        try:
            return ElementTree.fromstring(response.body)
        except ElementTree.ParseError as error:
            raise TransientFailure("sqs_response_invalid") from error


class StorageTransport(Protocol):
    def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> HttpResponse: ...

    def delete(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> HttpResponse: ...

    def download(
        self,
        url: str,
        headers: Mapping[str, str],
        target: "BinaryWriter",
        max_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse: ...

    def upload(
        self,
        url: str,
        headers: Mapping[str, str],
        source: BinaryIO,
        size_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse: ...


class UrlStorageTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect)

    def download(
        self,
        url: str,
        headers: Mapping[str, str],
        target: "BinaryWriter",
        max_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse:
        request = Request(url, headers=dict(headers), method="GET")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                total = 0
                while chunk := response.read(min(1_048_576, max_bytes + 1 - total)):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValidationFailure("source_object_too_large")
                    target.write(chunk)
                return HttpResponse(response.status, dict(response.headers.items()))
        except HTTPError as error:
            return HttpResponse(error.code, dict(error.headers.items()), error.read(65_537))
        except ValidationFailure:
            raise
        except (URLError, TimeoutError, OSError) as error:
            raise TransientFailure("s3_download_unavailable") from error

    def head(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> HttpResponse:
        request = Request(url, headers=dict(headers), method="HEAD")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return HttpResponse(response.status, dict(response.headers.items()))
        except HTTPError as error:
            return HttpResponse(error.code, dict(error.headers.items()))
        except (URLError, TimeoutError, OSError) as error:
            raise TransientFailure("s3_head_unavailable") from error

    def delete(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> HttpResponse:
        request = Request(url, headers=dict(headers), method="DELETE")
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return HttpResponse(
                    response.status,
                    dict(response.headers.items()),
                    response.read(65_537),
                )
        except HTTPError as error:
            return HttpResponse(error.code, dict(error.headers.items()), error.read(65_537))
        except (URLError, TimeoutError, OSError) as error:
            raise TransientFailure("s3_delete_unavailable") from error

    def upload(
        self,
        url: str,
        headers: Mapping[str, str],
        source: BinaryIO,
        size_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse:
        parsed = urlsplit(url)
        if parsed.hostname is None:
            raise TransientFailure("s3_upload_unavailable")
        connection = http.client.HTTPSConnection(parsed.hostname, timeout=timeout_seconds)
        try:
            connection.putrequest("PUT", parsed.path, skip_host=True, skip_accept_encoding=True)
            for name, value in headers.items():
                connection.putheader(name, value)
            connection.endheaders()
            remaining = size_bytes
            while remaining:
                chunk = source.read(min(1_048_576, remaining))
                if not chunk:
                    raise TransientFailure("artifact_changed_during_upload")
                connection.send(chunk)
                remaining -= len(chunk)
            response = connection.getresponse()
            body = response.read(65_537)
            return HttpResponse(response.status, dict(response.getheaders()), body)
        except TransientFailure:
            raise
        except (OSError, TimeoutError, http.client.HTTPException) as error:
            raise TransientFailure("s3_upload_unavailable") from error
        finally:
            connection.close()


class S3Storage:
    def __init__(
        self,
        settings: Settings,
        signer: SigV4Signer | None = None,
        transport: StorageTransport | None = None,
    ) -> None:
        self._bucket = settings.geodata_bucket
        self._region = settings.aws_region
        self._kms_key_arn = settings.geodata_kms_key_arn
        self._max_object_bytes = settings.max_object_bytes
        self._timeout = settings.http_timeout_seconds
        self._host = f"s3.{self._region}.amazonaws.com"
        self._bucket_path = f"/{quote(self._bucket, safe='-_.~')}"
        self._signer = signer or SigV4Signer(
            settings.aws_region, AwsCredentialProvider(timeout_seconds=2)
        )
        self._transport = transport or UrlStorageTransport()

    def download(self, event: S3ObjectEvent, claim: JobClaim, target: Path) -> None:
        claim.require_claimed()
        if (
            event.bucket != self._bucket
            or event.size_bytes != claim.size_bytes
            or claim.size_bytes is None
            or claim.size_bytes > self._max_object_bytes
        ):
            raise ValidationFailure("source_object_facts_mismatch")
        assert claim.content_type is not None
        assert claim.checksum_sha256 is not None
        self._download_exact(
            key=event.key,
            version_id=event.version_id,
            expected_etag=event.etag,
            expected_content_type=claim.content_type,
            expected_size=claim.size_bytes,
            expected_checksum=claim.checksum_sha256,
            target=target,
            mismatch_code="source_object_facts_mismatch",
        )

    def download_reference(self, reference: ObjectReference, target: Path) -> None:
        if (
            reference.bucket != self._bucket
            or not 1 <= reference.size_bytes <= min(self._max_object_bytes, 16_777_216)
            or reference.content_type != "application/geo+json"
            or not reference.object_key.endswith("/derivatives/preview/preview.geojson")
            or not re.fullmatch(r"[0-9a-f]{64}", reference.checksum_sha256)
            or not reference.s3_version_id
            or reference.s3_version_id == "null"
        ):
            raise ValidationFailure("render_source_facts_mismatch")
        self._download_exact(
            key=reference.object_key,
            version_id=reference.s3_version_id,
            expected_etag=reference.etag,
            expected_content_type=reference.content_type,
            expected_size=reference.size_bytes,
            expected_checksum=reference.checksum_sha256,
            target=target,
            mismatch_code="render_source_facts_mismatch",
        )

    def download_coverage_source(self, reference: ObjectReference, target: Path) -> None:
        if (
            reference.bucket != self._bucket
            or not 1 <= reference.size_bytes <= min(self._max_object_bytes, 536_870_912)
            or reference.content_type not in {"image/tiff", "image/geotiff"}
            or not re.fullmatch(r"[0-9a-f]{64}", reference.checksum_sha256)
            or not reference.s3_version_id
            or reference.s3_version_id == "null"
            or not re.fullmatch(r"[A-Fa-f0-9]{16,128}", reference.etag)
        ):
            raise ValidationFailure("coverage_derivative_source_facts_mismatch")
        self._download_exact(
            key=reference.object_key,
            version_id=reference.s3_version_id,
            expected_etag=reference.etag.lower(),
            expected_content_type=reference.content_type,
            expected_size=reference.size_bytes,
            expected_checksum=reference.checksum_sha256,
            target=target,
            mismatch_code="coverage_derivative_source_facts_mismatch",
        )

    def download_pmtiles_source(self, reference: ObjectReference, target: Path) -> None:
        if (
            reference.bucket != self._bucket
            or _MANAGED_VECTOR_SOURCE_KEY.fullmatch(reference.object_key) is None
            or not 1 <= reference.size_bytes <= 2_147_483_648
            or reference.content_type not in _PMTILES_SOURCE_CONTENT_TYPES
            or (
                "/derivatives/working/" in reference.object_key
                and reference.content_type != "application/vnd.apache.parquet"
            )
            or re.fullmatch(r"[0-9a-f]{64}", reference.checksum_sha256) is None
            or not reference.s3_version_id
            or reference.s3_version_id == "null"
            or re.fullmatch(r"[A-Fa-f0-9]{16,128}", reference.etag) is None
        ):
            raise ValidationFailure("pmtiles_derivative_source_facts_mismatch")
        self._download_exact(
            key=reference.object_key,
            version_id=reference.s3_version_id,
            expected_etag=reference.etag.lower(),
            expected_content_type=reference.content_type,
            expected_size=reference.size_bytes,
            expected_checksum=reference.checksum_sha256,
            target=target,
            mismatch_code="pmtiles_derivative_source_facts_mismatch",
        )

    def verify_coverage_derivative_reclamation(self, reference: ObjectReference) -> None:
        self._validate_reclamation_reference(reference)
        self._verify_reclamation_reference(
            reference, "coverage_derivative_reclamation_target_mismatch"
        )

    def verify_render_cache_reclamation(self, reference: ObjectReference) -> None:
        self._validate_render_cache_reclamation_reference(reference)
        self._verify_reclamation_reference(reference, "render_cache_reclamation_target_mismatch")

    def _verify_reclamation_reference(self, reference: ObjectReference, mismatch_code: str) -> None:
        path = self._object_path(reference.object_key)
        query = {"versionId": reference.s3_version_id}
        payload_hash = hashlib.sha256(b"").hexdigest()
        headers = self._signer.sign(
            method="HEAD",
            service="s3",
            host=self._host,
            path=path,
            query=query,
            headers={"x-amz-checksum-mode": "ENABLED"},
            payload_hash=payload_hash,
        )
        url = f"https://{self._host}{path}?versionId={_aws_quote(reference.s3_version_id)}"
        response = self._transport.head(url, headers, self._timeout)
        if response.status != 200:
            raise TransientFailure("s3_reclamation_head_failed")
        normalized = {name.lower(): value for name, value in response.headers.items()}
        expected_checksum = base64.b64encode(bytes.fromhex(reference.checksum_sha256)).decode()
        try:
            actual_size = int(normalized["content-length"])
            actual_version = normalized["x-amz-version-id"]
            actual_etag = normalized["etag"].strip('"').lower()
            actual_type = normalized["content-type"].split(";", 1)[0].strip().lower()
        except (KeyError, ValueError) as error:
            raise TransientFailure("s3_reclamation_metadata_incomplete") from error
        if (
            actual_size != reference.size_bytes
            or actual_version != reference.s3_version_id
            or actual_etag != reference.etag.lower()
            or actual_type != reference.content_type
            or normalized.get("x-amz-checksum-sha256") != expected_checksum
            or normalized.get("x-amz-server-side-encryption") != "aws:kms"
            or normalized.get("x-amz-server-side-encryption-aws-kms-key-id") != self._kms_key_arn
        ):
            raise ValidationFailure(mismatch_code)

    def delete_coverage_derivative_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None:
        self._validate_reclamation_reference(reference)
        self._delete_reclamation_reference(
            reference,
            allow_missing=allow_missing,
            mismatch_code="coverage_derivative_reclamation_version_mismatch",
        )

    def delete_render_cache_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None:
        self._validate_render_cache_reclamation_reference(reference)
        self._delete_reclamation_reference(
            reference,
            allow_missing=allow_missing,
            mismatch_code="render_cache_reclamation_version_mismatch",
        )

    def _delete_reclamation_reference(
        self,
        reference: ObjectReference,
        *,
        allow_missing: bool,
        mismatch_code: str,
    ) -> None:
        path = self._object_path(reference.object_key)
        query = {"versionId": reference.s3_version_id}
        payload_hash = hashlib.sha256(b"").hexdigest()
        headers = self._signer.sign(
            method="DELETE",
            service="s3",
            host=self._host,
            path=path,
            query=query,
            headers={},
            payload_hash=payload_hash,
        )
        url = f"https://{self._host}{path}?versionId={_aws_quote(reference.s3_version_id)}"
        response = self._transport.delete(url, headers, self._timeout)
        if allow_missing and response.status == 404:
            return
        if response.status != 204 or len(response.body) > 65_536:
            raise TransientFailure("s3_reclamation_delete_failed")
        returned_version = {name.lower(): value for name, value in response.headers.items()}.get(
            "x-amz-version-id"
        )
        if returned_version is not None and returned_version != reference.s3_version_id:
            raise ValidationFailure(mismatch_code)

    def _validate_reclamation_reference(self, reference: ObjectReference) -> None:
        if (
            reference.bucket != self._bucket
            or _COVERAGE_DERIVATIVE_KEY.fullmatch(reference.object_key) is None
            or not reference.s3_version_id
            or reference.s3_version_id == "null"
            or not re.fullmatch(r"[A-Fa-f0-9]{16,128}", reference.etag)
            or reference.content_type != "image/tiff"
            or not 1 <= reference.size_bytes <= min(self._max_object_bytes, 536_870_912)
            or re.fullmatch(r"[0-9a-f]{64}", reference.checksum_sha256) is None
        ):
            raise ValidationFailure("coverage_derivative_reclamation_target_invalid")

    def _validate_render_cache_reclamation_reference(self, reference: ObjectReference) -> None:
        expected_type = "image/svg+xml" if reference.object_key.endswith(".svg") else "image/png"
        if (
            reference.bucket != self._bucket
            or _RENDER_CACHE_KEY.fullmatch(reference.object_key) is None
            or not reference.s3_version_id
            or reference.s3_version_id == "null"
            or not re.fullmatch(r"[A-Fa-f0-9]{16,128}", reference.etag)
            or reference.content_type != expected_type
            or not 1 <= reference.size_bytes <= min(self._max_object_bytes, 20_971_520)
            or re.fullmatch(r"[0-9a-f]{64}", reference.checksum_sha256) is None
        ):
            raise ValidationFailure("render_cache_reclamation_target_invalid")

    def _download_exact(
        self,
        *,
        key: str,
        version_id: str,
        expected_etag: str,
        expected_content_type: str,
        expected_size: int,
        expected_checksum: str,
        target: Path,
        mismatch_code: str,
    ) -> None:
        path = self._object_path(key)
        query = {"versionId": version_id}
        payload_hash = hashlib.sha256(b"").hexdigest()
        headers = self._signer.sign(
            method="GET",
            service="s3",
            host=self._host,
            path=path,
            query=query,
            headers={"x-amz-checksum-mode": "ENABLED"},
            payload_hash=payload_hash,
        )
        url = f"https://{self._host}{path}?versionId={_aws_quote(version_id)}"
        digest = hashlib.sha256()
        try:
            with target.open("xb") as raw_target:
                response = self._transport.download(
                    url,
                    headers,
                    _HashingWriter(raw_target, digest),
                    expected_size,
                    self._timeout,
                )
        except FileExistsError as error:
            raise TransientFailure("workspace_collision") from error
        if response.status != 200:
            raise TransientFailure("s3_download_failed")
        normalized = {name.lower(): value for name, value in response.headers.items()}
        try:
            actual_size = int(normalized["content-length"])
            actual_version = normalized["x-amz-version-id"]
            actual_etag = normalized["etag"].strip('"').lower()
            actual_type = normalized["content-type"].split(";", 1)[0].strip().lower()
        except (KeyError, ValueError) as error:
            raise TransientFailure("s3_download_metadata_incomplete") from error
        if (
            actual_size != expected_size
            or target.stat().st_size != expected_size
            or actual_version != version_id
            or actual_etag != expected_etag
            or actual_type != expected_content_type
            or normalized.get("x-amz-server-side-encryption") != "aws:kms"
            or normalized.get("x-amz-server-side-encryption-aws-kms-key-id") != self._kms_key_arn
            or digest.hexdigest() != expected_checksum
        ):
            raise ValidationFailure(mismatch_code)

    def upload(
        self,
        artifact: ArtifactFile,
        *,
        output_prefix: str,
        artifact_id: UUID,
    ) -> StoredArtifact:
        key_parts = PureKey.parts(artifact.relative_key)
        if (
            re.fullmatch(r"[a-z0-9][A-Za-z0-9._/-]{0,511}", artifact.relative_key) is None
            or any(part in {"", ".", ".."} for part in key_parts)
            or artifact.relative_key.startswith("/")
            or _OUTPUT_PREFIX.fullmatch(output_prefix) is None
        ):
            raise ValidationFailure("artifact_key_invalid")
        object_key = f"{output_prefix}{artifact.relative_key}"
        return self._upload_to_key(artifact, object_key=object_key, artifact_id=artifact_id)

    def upload_pmtiles_derivative(
        self,
        artifact: ArtifactFile,
        *,
        object_key: str,
        artifact_id: UUID,
    ) -> StoredArtifact:
        if (
            artifact.role != "tile"
            or artifact.content_type != "application/vnd.pmtiles"
            or _PMTILES_DERIVATIVE_KEY.fullmatch(object_key) is None
        ):
            raise ValidationFailure("pmtiles_derivative_artifact_invalid")
        return self._upload_to_key(artifact, object_key=object_key, artifact_id=artifact_id)

    def _upload_to_key(
        self,
        artifact: ArtifactFile,
        *,
        object_key: str,
        artifact_id: UUID,
    ) -> StoredArtifact:
        size_bytes, checksum = _file_facts(artifact.path)
        checksum_base64 = base64.b64encode(bytes.fromhex(checksum)).decode()
        path = self._object_path(object_key)
        headers = self._signer.sign(
            method="PUT",
            service="s3",
            host=self._host,
            path=path,
            query=None,
            headers={
                "content-length": str(size_bytes),
                "content-type": artifact.content_type,
                "if-none-match": "*",
                "x-amz-checksum-sha256": checksum_base64,
                "x-amz-server-side-encryption": "aws:kms",
                "x-amz-server-side-encryption-aws-kms-key-id": self._kms_key_arn,
            },
            payload_hash=checksum,
        )
        with artifact.path.open("rb") as source:
            response = self._transport.upload(
                f"https://{self._host}{path}", headers, source, size_bytes, self._timeout
            )
        if response.status == 412:
            return self._recover_uploaded_artifact(
                artifact,
                object_key=object_key,
                artifact_id=artifact_id,
                size_bytes=size_bytes,
                checksum=checksum,
                checksum_base64=checksum_base64,
            )
        if response.status != 200 or len(response.body) > 65_536:
            raise TransientFailure("s3_upload_failed")
        normalized = {name.lower(): value for name, value in response.headers.items()}
        version_id = normalized.get("x-amz-version-id", "")
        etag = normalized.get("etag", "").strip('"').lower()
        returned_checksum = normalized.get("x-amz-checksum-sha256")
        if (
            not version_id
            or version_id == "null"
            or re.fullmatch(r"[A-Fa-f0-9]{16,128}", etag) is None
            or returned_checksum != checksum_base64
        ):
            return self._recover_uploaded_artifact(
                artifact,
                object_key=object_key,
                artifact_id=artifact_id,
                size_bytes=size_bytes,
                checksum=checksum,
                checksum_base64=checksum_base64,
            )
        return StoredArtifact(
            artifact_id=artifact_id,
            role=artifact.role,
            bucket=self._bucket,
            object_key=object_key,
            s3_version_id=version_id,
            etag=etag,
            content_type=artifact.content_type,
            size_bytes=size_bytes,
            checksum_sha256=checksum,
        )

    def _recover_uploaded_artifact(
        self,
        artifact: ArtifactFile,
        *,
        object_key: str,
        artifact_id: UUID,
        size_bytes: int,
        checksum: str,
        checksum_base64: str,
    ) -> StoredArtifact:
        path = self._object_path(object_key)
        payload_hash = hashlib.sha256(b"").hexdigest()
        headers = self._signer.sign(
            method="HEAD",
            service="s3",
            host=self._host,
            path=path,
            query=None,
            headers={"x-amz-checksum-mode": "ENABLED"},
            payload_hash=payload_hash,
        )
        response = self._transport.head(f"https://{self._host}{path}", headers, self._timeout)
        if response.status != 200:
            raise TransientFailure("s3_upload_recovery_failed")
        normalized = {name.lower(): value for name, value in response.headers.items()}
        try:
            actual_size = int(normalized["content-length"])
            version_id = normalized["x-amz-version-id"]
            etag = normalized["etag"].strip('"').lower()
            content_type = normalized["content-type"].split(";", 1)[0].strip().lower()
        except (KeyError, ValueError) as error:
            raise TransientFailure("s3_upload_recovery_metadata_incomplete") from error
        if (
            not version_id
            or version_id == "null"
            or re.fullmatch(r"[A-Fa-f0-9]{16,128}", etag) is None
        ):
            raise TransientFailure("s3_upload_recovery_metadata_incomplete")
        if (
            actual_size != size_bytes
            or content_type != artifact.content_type
            or normalized.get("x-amz-checksum-sha256") != checksum_base64
            or normalized.get("x-amz-server-side-encryption") != "aws:kms"
            or normalized.get("x-amz-server-side-encryption-aws-kms-key-id") != self._kms_key_arn
        ):
            raise ValidationFailure("artifact_key_conflict")
        return StoredArtifact(
            artifact_id=artifact_id,
            role=artifact.role,
            bucket=self._bucket,
            object_key=object_key,
            s3_version_id=version_id,
            etag=etag,
            content_type=artifact.content_type,
            size_bytes=size_bytes,
            checksum_sha256=checksum,
        )

    def _object_path(self, key: str) -> str:
        return f"{self._bucket_path}/{quote(key, safe='/-_.~')}"


class PureKey:
    @staticmethod
    def parts(value: str) -> tuple[str, ...]:
        return tuple(value.split("/"))


class BinaryWriter(Protocol):
    def write(self, value: bytes) -> int: ...


class _HashingWriter:
    def __init__(self, target: BinaryIO, digest: Any) -> None:
        self._target = target
        self._digest = digest

    def write(self, value: bytes) -> int:
        self._digest.update(value)
        return self._target.write(value)


def _file_facts(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1_048_576):
            size += len(chunk)
            digest.update(chunk)
    if size < 1 or size > 5_368_709_120:
        raise ValidationFailure("artifact_size_invalid")
    return size, digest.hexdigest()


def _aws_quote(value: str) -> str:
    return quote(value, safe="-_.~")


def _xml_local_name(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _xml_children(element: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    return [child for child in element.iter() if _xml_local_name(child) == name]


def _first_xml(element: ElementTree.Element, name: str) -> ElementTree.Element | None:
    return next(iter(_xml_children(element, name)), None)


def _required_xml_text(element: ElementTree.Element, name: str) -> str:
    child = _first_xml(element, name)
    if child is None or child.text is None:
        raise TransientFailure("sqs_response_invalid")
    return child.text
