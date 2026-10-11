from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from urllib.parse import quote_plus, urlencode, urlsplit
from uuid import UUID
from xml.etree import ElementTree

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
    IdentityProvisioningUnavailable,
)
from opengeo_api.processing_dispatch import DispatchTransport, UrlDispatchTransport
from opengeo_api.source_archiver import StoredArchive

_QUEUE_URL = re.compile(
    r"https://sqs\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com/"
    r"(?P<account>\d{12})/[A-Za-z0-9_-]{1,80}"
)
_ARCHIVE_KEY = re.compile(
    r"organizations/(?P<organization>[0-9a-f-]{36})/"
    r"projects/(?P<project>[0-9a-f-]{36})/"
    r"datasets/(?P<dataset>[0-9a-f-]{36})/"
    r"uploads/(?P<job>[0-9a-f-]{36})/original/"
    r"(?P<filename>snapshot\.png|source\."
    r"(?:geojson|csv|zip|gpkg|parquet|tif|pmtiles|png|jpg|pdf|odt))"
)
_ARCHIVE_CONTENT_TYPES: dict[str, frozenset[str]] = {
    "snapshot.png": frozenset({"image/png"}),
    "source.geojson": frozenset({"application/geo+json", "application/json"}),
    "source.csv": frozenset({"text/csv", "application/csv"}),
    "source.zip": frozenset({"application/zip", "application/x-zip-compressed"}),
    "source.gpkg": frozenset(
        {
            "application/geopackage+sqlite3",
            "application/vnd.sqlite3",
            "application/octet-stream",
        }
    ),
    "source.parquet": frozenset(
        {
            "application/vnd.apache.parquet",
            "application/x-parquet",
            "application/octet-stream",
        }
    ),
    "source.tif": frozenset({"image/tiff", "image/geotiff", "application/geotiff"}),
    "source.pmtiles": frozenset({"application/vnd.pmtiles", "application/octet-stream"}),
    "source.png": frozenset({"image/png"}),
    "source.jpg": frozenset({"image/jpeg"}),
    "source.pdf": frozenset({"application/pdf"}),
    "source.odt": frozenset({"application/vnd.oasis.opendocument.text"}),
}
_ETAG = re.compile(r"[A-Fa-f0-9]{16,128}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_MAXIMUM_MESSAGE_BYTES = 32_768


class SourceArchiveDispatchUnavailable(RuntimeError):
    pass


class SourceArchiveIngestionDispatcher:
    """Send exact completed archive facts to the ordinary ingestion queue."""

    def __init__(
        self,
        *,
        region: str,
        account_id: str,
        queue_url: str,
        credentials: CredentialProvider | None = None,
        transport: DispatchTransport | None = None,
        now: Callable[[], datetime] | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        queue_match = _QUEUE_URL.fullmatch(queue_url)
        if (
            re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region) is None
            or re.fullmatch(r"\d{12}", account_id) is None
            or queue_match is None
            or queue_match.group(1) != region
            or queue_match.group("account") != account_id
            or not 1.0 <= timeout_seconds <= 30.0
        ):
            raise ValueError("source archive ingestion dispatch configuration is invalid")
        parsed = urlsplit(queue_url)
        self._region = region
        self._url = queue_url
        self._host = parsed.netloc
        self._path = parsed.path
        self._credentials = credentials or AwsCredentialProvider(timeout_seconds=2.0)
        self._transport = transport or UrlDispatchTransport()
        self._now = now or (lambda: datetime.now(UTC))
        self._timeout_seconds = timeout_seconds

    async def dispatch(self, snapshot_job_id: UUID, artifact: StoredArchive) -> None:
        message = _ingestion_message(self._region, snapshot_job_id, artifact)
        await asyncio.to_thread(self._send, message)

    def _send(self, message: Mapping[str, object]) -> None:
        serialized = json.dumps(message, separators=(",", ":"), sort_keys=True)
        if len(serialized.encode("utf-8")) > _MAXIMUM_MESSAGE_BYTES:
            raise SourceArchiveDispatchUnavailable("source archive ingestion event is too large")
        body = urlencode(
            {
                "Action": "SendMessage",
                "MessageBody": serialized,
                "Version": "2012-11-05",
            }
        ).encode()
        payload_hash = hashlib.sha256(body).hexdigest()
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        try:
            credentials = self._credentials.load()
        except IdentityProvisioningUnavailable as error:
            raise SourceArchiveDispatchUnavailable(
                "source archive ingestion credentials are unavailable"
            ) from error
        canonical = {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            "host": self._host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{name}:{canonical[name]}\n" for name in sorted(canonical))
        canonical_request = "\n".join(
            ["POST", self._path, "", canonical_headers, signed_names, payload_hash]
        )
        scope = f"{date_stamp}/{self._region}/sqs/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            _signing_key(credentials, date_stamp, self._region),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_names}, Signature={signature}"
            ),
        }
        try:
            status, response = self._transport.call(
                self._url,
                headers,
                body,
                self._timeout_seconds,
            )
        except Exception as error:
            raise SourceArchiveDispatchUnavailable(
                "source archive ingestion queue is unavailable"
            ) from error
        if status != 200 or len(response) > 65_536:
            raise SourceArchiveDispatchUnavailable(
                "source archive ingestion queue rejected the event"
            )
        try:
            root = ElementTree.fromstring(response)
        except ElementTree.ParseError as error:
            raise SourceArchiveDispatchUnavailable(
                "source archive ingestion queue returned invalid XML"
            ) from error
        message_id = next(
            (
                element.text
                for element in root.iter()
                if element.tag.rsplit("}", 1)[-1] == "MessageId"
            ),
            None,
        )
        if not message_id or not 1 <= len(message_id) <= 128:
            raise SourceArchiveDispatchUnavailable(
                "source archive ingestion queue returned no message id"
            )


def _ingestion_message(
    region: str,
    snapshot_job_id: UUID,
    artifact: StoredArchive,
) -> dict[str, object]:
    match = _ARCHIVE_KEY.fullmatch(artifact.object_key)
    expected_content_types = _ARCHIVE_CONTENT_TYPES.get(match.group("filename")) if match else None
    if (
        match is None
        or not _canonical_uuid(match.group("organization"))
        or not _canonical_uuid(match.group("project"))
        or not _canonical_uuid(match.group("dataset"))
        or not _canonical_uuid(match.group("job"))
        or UUID(match.group("job")) != snapshot_job_id
        or not _valid_bucket(artifact.bucket)
        or not isinstance(artifact.s3_version_id, str)
        or artifact.s3_version_id in {"", "null"}
        or len(artifact.s3_version_id) > 1_024
        or any(ord(character) < 32 or ord(character) == 127 for character in artifact.s3_version_id)
        or _ETAG.fullmatch(artifact.etag) is None
        or expected_content_types is None
        or artifact.content_type not in expected_content_types
        or isinstance(artifact.size_bytes, bool)
        or not 1 <= artifact.size_bytes <= 536_870_912
        or _SHA256.fullmatch(artifact.checksum_sha256) is None
    ):
        raise SourceArchiveDispatchUnavailable(
            "completed source archive facts cannot form an ingestion event"
        )
    sequencer = hashlib.sha256(
        (
            f"opengeo-source-archive\0{snapshot_job_id}\0{artifact.bucket}\0"
            f"{artifact.object_key}\0{artifact.s3_version_id}\0{artifact.etag.casefold()}"
        ).encode()
    ).hexdigest()
    return {
        "Records": [
            {
                "eventVersion": "2.1",
                "eventSource": "aws:s3",
                "awsRegion": region,
                "eventName": "ObjectCreated:Put",
                "s3": {
                    "s3SchemaVersion": "1.0",
                    "configurationId": "opengeo-source-archive-post-completion",
                    "bucket": {"name": artifact.bucket},
                    "object": {
                        "key": quote_plus(artifact.object_key, safe="/"),
                        "size": artifact.size_bytes,
                        "eTag": artifact.etag.casefold(),
                        "versionId": artifact.s3_version_id,
                        "sequencer": sequencer,
                    },
                },
            }
        ]
    }


def _signing_key(credentials: AwsCredentials, date_stamp: str, region: str) -> bytes:
    date_key = hmac.new(
        f"AWS4{credentials.secret_access_key}".encode(),
        date_stamp.encode(),
        hashlib.sha256,
    ).digest()
    region_key = hmac.new(date_key, region.encode(), hashlib.sha256).digest()
    service_key = hmac.new(region_key, b"sqs", hashlib.sha256).digest()
    return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def _canonical_uuid(value: str) -> bool:
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _valid_bucket(value: str) -> bool:
    return bool(
        re.fullmatch(r"(?=.{3,63}\Z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value)
        and ".." not in value
        and ".-" not in value
        and "-." not in value
        and re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", value) is None
    )
