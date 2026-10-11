import asyncio
import base64
import json
from collections.abc import Mapping
from datetime import UTC, datetime

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.s3_uploads import (
    AwsS3UploadStorage,
    UploadObjectNotFound,
    UploadSpec,
    UploadStorageUnavailable,
)


class StaticCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret", "session-token")


class ScriptedHeadTransport:
    def __init__(self, response: tuple[int, Mapping[str, str]]) -> None:
        self.response = response
        self.calls: list[tuple[str, Mapping[str, str], float]] = []

    def head(self, url, headers, timeout_seconds):
        self.calls.append((url, headers, timeout_seconds))
        return self.response


def settings() -> Settings:
    return Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="storage.opengeo.tools",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
        upload_url_ttl_seconds=600,
    )


def storage(transport: ScriptedHeadTransport | None = None) -> AwsS3UploadStorage:
    return AwsS3UploadStorage(
        settings(),
        credentials=StaticCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )


def test_signed_post_policy_binds_key_type_size_checksum_encryption_and_expiry() -> None:
    checksum = "ab" * 32
    result = asyncio.run(
        storage().create_upload_form(
            UploadSpec(
                key="organizations/org/uploads/upload/source roads.gpkg",
                content_type="application/geopackage+sqlite3",
                size_bytes=1234,
                checksum_sha256=checksum,
            )
        )
    )

    assert result.url == "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools"
    assert result.method == "POST"
    assert result.expires_at == datetime(2026, 8, 20, 12, 10, tzinfo=UTC)
    assert result.fields["key"].endswith("source roads.gpkg")
    assert result.fields["x-amz-security-token"] == "session-token"
    assert len(result.fields["x-amz-signature"]) == 64
    policy = json.loads(base64.b64decode(result.fields["policy"]))
    assert policy["expiration"] == "2026-08-20T12:10:00Z"
    assert ["content-length-range", 1234, 1234] in policy["conditions"]
    assert ["eq", "$Content-Type", "application/geopackage+sqlite3"] in policy["conditions"]
    assert {"x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(checksum)).decode()} in policy[
        "conditions"
    ]
    assert {
        "x-amz-server-side-encryption-aws-kms-key-id": settings().geodata_kms_key_arn
    } in policy["conditions"]


def test_head_verification_signs_fixed_s3_endpoint_and_returns_exact_version() -> None:
    checksum = bytes.fromhex("cd" * 32)
    transport = ScriptedHeadTransport(
        (
            200,
            {
                "Content-Length": "456",
                "Content-Type": "application/geo+json",
                "ETag": '"etag-value"',
                "X-Amz-Version-Id": "version-123",
                "X-Amz-Checksum-Sha256": base64.b64encode(checksum).decode(),
            },
        )
    )

    result = asyncio.run(storage(transport).inspect_object("organizations/a/source map.geojson"))

    assert result.version_id == "version-123"
    assert result.etag == "etag-value"
    assert result.size_bytes == 456
    assert result.checksum_sha256 == checksum.hex()
    url, headers, _timeout = transport.calls[0]
    assert url == (
        "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/"
        "organizations/a/source%20map.geojson"
    )
    assert headers["host"] == "s3.us-east-1.amazonaws.com"
    assert headers["x-amz-checksum-mode"] == "ENABLED"
    assert (
        "SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;" in headers["authorization"]
    )
    assert "Signature=" in headers["authorization"]


def test_missing_or_incomplete_object_metadata_fails_closed() -> None:
    missing = ScriptedHeadTransport((404, {}))
    with pytest.raises(UploadObjectNotFound):
        asyncio.run(storage(missing).inspect_object("organizations/a/missing.gpkg"))

    incomplete = ScriptedHeadTransport(
        (200, {"Content-Length": "123", "Content-Type": "application/octet-stream"})
    )
    with pytest.raises(UploadStorageUnavailable):
        asyncio.run(storage(incomplete).inspect_object("organizations/a/incomplete.gpkg"))


def test_redirect_or_access_denial_is_not_followed_or_exposed_as_missing() -> None:
    for status_code in (301, 307, 403, 500):
        transport = ScriptedHeadTransport((status_code, {"location": "https://evil.test"}))
        with pytest.raises(UploadStorageUnavailable):
            asyncio.run(storage(transport).inspect_object("organizations/a/object.gpkg"))
