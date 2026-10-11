import asyncio
import base64
import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.s3_downloads import (
    AwsS3DownloadStorage,
    DownloadSpec,
    DownloadStorageUnavailable,
    ExactObjectSpec,
)


class StaticCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret", "session-token")


def test_exact_metadata_read_accepts_only_the_dedicated_canonical_namespace():
    from uuid import UUID

    from opengeo_api.source_archiver import discovery_metadata_key

    body = b" " * 32_769
    transport = RecordingGetTransport(
        body,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(body)),
            "x-amz-version-id": "immutable-version-123",
            "x-amz-checksum-sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
        },
    )
    storage = AwsS3DownloadStorage(settings(), credentials=StaticCredentials(), transport=transport)
    key = discovery_metadata_key(*(UUID(f"10000000-0000-4000-8000-{n:012d}") for n in (1, 2, 3)))
    spec = ExactObjectSpec(
        "storage.opengeo.tools",
        key,
        "immutable-version-123",
        "application/octet-stream",
        len(body),
        hashlib.sha256(body).hexdigest(),
        2_097_152,
    )
    assert asyncio.run(storage.read_exact_object(spec)).body == body
    assert "versionId=immutable-version-123" in transport.calls[0][0]
    assert not storage._valid_key(key.replace("/response.bin", "/arbitrary.bin"))


class RecordingGetTransport:
    def __init__(
        self,
        body: bytes,
        *,
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
        self.body = body
        self.status_code = status_code
        self.headers = headers or {
            "Content-Type": "image/svg+xml",
            "Content-Length": str(len(body)),
            "x-amz-version-id": "immutable-version-123",
            "x-amz-checksum-sha256": checksum,
        }
        self.calls: list[tuple[str, Mapping[str, str], float, int]] = []

    def get(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout_seconds: float,
        maximum_bytes: int,
    ) -> tuple[int, Mapping[str, str], bytes]:
        self.calls.append((url, headers, timeout_seconds, maximum_bytes))
        return self.status_code, self.headers, self.body


def settings() -> Settings:
    return Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="storage.opengeo.tools",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        download_url_ttl_seconds=120,
    )


def test_presigned_download_binds_fixed_bucket_key_version_disposition_and_short_expiry() -> None:
    storage = AwsS3DownloadStorage(
        settings(),
        credentials=StaticCredentials(),
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    ticket = asyncio.run(
        storage.create_download_url(
            DownloadSpec(
                bucket="storage.opengeo.tools",
                key="organizations/a/versions/v1/derived/source map.parquet",
                version_id="immutable-version-123",
                filename="source map.parquet",
            )
        )
    )

    parsed = urlsplit(ticket.url)
    query = parse_qs(parsed.query)
    assert ticket.method == "GET"
    assert ticket.expires_at == datetime(2026, 8, 20, 12, 2, tzinfo=UTC)
    assert parsed.scheme == "https"
    assert parsed.netloc == "s3.us-east-1.amazonaws.com"
    assert parsed.path == (
        "/storage.opengeo.tools/organizations/a/versions/v1/derived/source%20map.parquet"
    )
    assert query["versionId"] == ["immutable-version-123"]
    assert query["X-Amz-Expires"] == ["120"]
    assert query["X-Amz-SignedHeaders"] == ["host"]
    assert query["X-Amz-Security-Token"] == ["session-token"]
    assert query["response-content-disposition"] == ['attachment; filename="source map.parquet"']
    assert len(query["X-Amz-Signature"][0]) == 64


def test_download_signing_rejects_an_unconfigured_bucket_or_missing_exact_version() -> None:
    storage = AwsS3DownloadStorage(settings(), credentials=StaticCredentials())
    for spec in (
        DownloadSpec("attacker-bucket", "organizations/a/file", "version", "file"),
        DownloadSpec("storage.opengeo.tools", "organizations/a/file", "", "file"),
        DownloadSpec(
            "storage.opengeo.tools",
            "organizations/a/file",
            "version",
            'file"\r\nX-Injected: true',
        ),
    ):
        with pytest.raises(DownloadStorageUnavailable):
            asyncio.run(storage.create_download_url(spec))


def test_exact_read_binds_and_verifies_the_recorded_s3_object_version() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    checksum = hashlib.sha256(body).hexdigest()
    transport = RecordingGetTransport(body)
    storage = AwsS3DownloadStorage(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )

    exact = asyncio.run(
        storage.read_exact_object(
            ExactObjectSpec(
                bucket="storage.opengeo.tools",
                key="organizations/a/versions/v1/derivatives/render/map.svg",
                version_id="immutable-version-123",
                content_type="image/svg+xml",
                size_bytes=len(body),
                checksum_sha256=checksum,
                maximum_bytes=4_194_304,
            )
        )
    )

    assert exact.body == body
    assert exact.version_id == "immutable-version-123"
    assert exact.checksum_sha256 == checksum
    assert len(transport.calls) == 1
    url, headers, timeout_seconds, maximum_bytes = transport.calls[0]
    assert url == (
        "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/"
        "organizations/a/versions/v1/derivatives/render/map.svg?"
        "versionId=immutable-version-123"
    )
    assert headers["host"] == "s3.us-east-1.amazonaws.com"
    assert headers["x-amz-checksum-mode"] == "ENABLED"
    assert headers["x-amz-security-token"] == "session-token"
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert timeout_seconds == 5.0
    assert maximum_bytes == 4_194_304


@pytest.mark.parametrize(
    ("overrides", "body_suffix", "status_code"),
    [
        ({"x-amz-version-id": "different-version"}, b"", 200),
        ({"Content-Type": "text/html"}, b"", 200),
        ({"Content-Length": "999"}, b"", 200),
        ({"Content-Encoding": "gzip"}, b"", 200),
        ({"Content-Range": "bytes 0-40/41"}, b"", 200),
        ({"x-amz-checksum-sha256": base64.b64encode(bytes(32)).decode()}, b"", 200),
        ({}, b"extra", 200),
        ({}, b"", 307),
    ],
)
def test_exact_read_fails_closed_when_s3_response_drifts(
    overrides: Mapping[str, str], body_suffix: bytes, status_code: int
) -> None:
    expected = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    response_body = expected + body_suffix
    response_headers = {
        "Content-Type": "image/svg+xml",
        "Content-Length": str(len(expected)),
        "x-amz-version-id": "immutable-version-123",
        "x-amz-checksum-sha256": base64.b64encode(hashlib.sha256(expected).digest()).decode(),
        **overrides,
    }
    transport = RecordingGetTransport(
        response_body, status_code=status_code, headers=response_headers
    )
    storage = AwsS3DownloadStorage(settings(), credentials=StaticCredentials(), transport=transport)

    with pytest.raises(DownloadStorageUnavailable):
        asyncio.run(
            storage.read_exact_object(
                ExactObjectSpec(
                    bucket="storage.opengeo.tools",
                    key="organizations/a/versions/v1/derivatives/render/map.svg",
                    version_id="immutable-version-123",
                    content_type="image/svg+xml",
                    size_bytes=len(expected),
                    checksum_sha256=hashlib.sha256(expected).hexdigest(),
                    maximum_bytes=4_194_304,
                )
            )
        )


def test_exact_read_rejects_objects_outside_the_bounded_render_namespace() -> None:
    body = b"svg"
    storage = AwsS3DownloadStorage(
        settings(), credentials=StaticCredentials(), transport=RecordingGetTransport(body)
    )
    valid = {
        "bucket": "storage.opengeo.tools",
        "key": "organizations/a/render.svg",
        "version_id": "version",
        "content_type": "image/svg+xml",
        "size_bytes": len(body),
        "checksum_sha256": hashlib.sha256(body).hexdigest(),
        "maximum_bytes": 4_194_304,
    }
    invalid = (
        {**valid, "bucket": "attacker-bucket"},
        {**valid, "key": "../render.svg"},
        {**valid, "content_type": "text/html"},
        {**valid, "maximum_bytes": 4_194_305},
        {**valid, "size_bytes": 4_194_305},
        {**valid, "checksum_sha256": "not-a-checksum"},
    )

    for values in invalid:
        with pytest.raises(DownloadStorageUnavailable):
            asyncio.run(storage.read_exact_object(ExactObjectSpec(**values)))


def test_exact_read_accepts_a_checksum_verified_png_render() -> None:
    body = b"\x89PNG\r\n\x1a\nexact-render"
    checksum = hashlib.sha256(body).hexdigest()
    transport = RecordingGetTransport(
        body,
        headers={
            "Content-Type": "image/png",
            "Content-Length": str(len(body)),
            "x-amz-version-id": "immutable-png-version",
            "x-amz-checksum-sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
        },
    )
    storage = AwsS3DownloadStorage(settings(), credentials=StaticCredentials(), transport=transport)

    exact = asyncio.run(
        storage.read_exact_object(
            ExactObjectSpec(
                bucket="storage.opengeo.tools",
                key="organizations/a/versions/v1/derivatives/render/map.png",
                version_id="immutable-png-version",
                content_type="image/png",
                size_bytes=len(body),
                checksum_sha256=checksum,
                maximum_bytes=4_194_304,
            )
        )
    )

    assert exact.body == body
    assert exact.content_type == "image/png"


@pytest.mark.parametrize(
    "content_type, filename",
    [
        ("application/geo+json", "source.geojson"),
        ("application/x-ipynb+json", "index.ipynb"),
    ],
)
def test_exact_read_accepts_a_bounded_checksum_verified_asset(
    content_type: str, filename: str
) -> None:
    body = b'{"type":"FeatureCollection","features":[]}'
    checksum = hashlib.sha256(body).hexdigest()
    transport = RecordingGetTransport(
        body,
        headers={
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "x-amz-version-id": "immutable-asset-version",
            "x-amz-checksum-sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(),
        },
    )
    storage = AwsS3DownloadStorage(settings(), credentials=StaticCredentials(), transport=transport)

    exact = asyncio.run(
        storage.read_exact_object(
            ExactObjectSpec(
                bucket="storage.opengeo.tools",
                key=f"organizations/a/versions/v1/{filename}",
                version_id="immutable-asset-version",
                content_type=content_type,
                size_bytes=len(body),
                checksum_sha256=checksum,
                maximum_bytes=4_194_304,
            )
        )
    )

    assert exact.body == body
    assert exact.content_type == content_type
