import base64
import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

import pytest

from opengeo_worker.aws_clients import (
    AwsCredentials,
    HttpResponse,
    S3Storage,
    SigV4Signer,
    SqsQueue,
)
from opengeo_worker.config import Settings
from opengeo_worker.models import (
    ArtifactFile,
    JobClaim,
    ObjectReference,
    S3ObjectEvent,
    ValidationFailure,
)

CONTENT = b'{"type":"FeatureCollection","features":[]}'
CHECKSUM = hashlib.sha256(CONTENT).hexdigest()
KMS_ARN = "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"


class Credentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "example-secret", "session-token")


class StorageTransport:
    def __init__(self) -> None:
        self.download_calls: list[tuple[str, dict[str, str], int]] = []
        self.upload_calls: list[tuple[str, dict[str, str], bytes]] = []
        self.head_calls: list[tuple[str, dict[str, str]]] = []
        self.delete_calls: list[tuple[str, dict[str, str]]] = []
        self.upload_status = 200
        self.head_checksum = CHECKSUM
        self.download_headers = {
            "Content-Length": str(len(CONTENT)),
            "Content-Type": "application/geo+json",
            "ETag": '"0123456789abcdef"',
            "X-Amz-Version-Id": "version-123",
            "X-Amz-Server-Side-Encryption": "aws:kms",
            "X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id": KMS_ARN,
        }

    def head(self, url: str, headers: dict[str, str], timeout_seconds: float) -> HttpResponse:
        del timeout_seconds
        self.head_calls.append((url, dict(headers)))
        return HttpResponse(
            200,
            {
                **self.download_headers,
                "X-Amz-Checksum-Sha256": base64.b64encode(
                    bytes.fromhex(self.head_checksum)
                ).decode(),
            },
        )

    def delete(self, url: str, headers: dict[str, str], timeout_seconds: float) -> HttpResponse:
        del timeout_seconds
        self.delete_calls.append((url, dict(headers)))
        return HttpResponse(204, {"X-Amz-Version-Id": "version-123"})

    def download(
        self,
        url: str,
        headers: dict[str, str],
        target: BinaryIO,
        max_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse:
        del timeout_seconds
        self.download_calls.append((url, dict(headers), max_bytes))
        target.write(CONTENT)
        return HttpResponse(200, self.download_headers)

    def upload(
        self,
        url: str,
        headers: dict[str, str],
        source: BinaryIO,
        size_bytes: int,
        timeout_seconds: float,
    ) -> HttpResponse:
        del timeout_seconds
        body = source.read(size_bytes)
        self.upload_calls.append((url, dict(headers), body))
        if self.upload_status != 200:
            return HttpResponse(self.upload_status, {})
        return HttpResponse(
            200,
            {
                "ETag": '"fedcba9876543210"',
                "X-Amz-Version-Id": "artifact-version-1",
                "X-Amz-Checksum-Sha256": base64.b64encode(
                    bytes.fromhex(hashlib.sha256(body).hexdigest())
                ).decode(),
            },
        )


class QueryTransport:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, str], bytes]] = []

    def call(
        self, url: str, headers: dict[str, str], body: bytes, timeout_seconds: float
    ) -> HttpResponse:
        del timeout_seconds
        self.calls.append((url, dict(headers), body))
        return self.response


def settings(tmp_path: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="storage.opengeo.tools",
        geodata_kms_key_arn=KMS_ARN,
        processing_queue_url=(
            "https://sqs.us-east-1.amazonaws.com/111111111111/opengeo-processing"
        ),
        db_host="database.internal",
        db_port=5432,
        db_name="opengeo",
        db_user="opengeo_worker",
        db_password="secret",
        db_sslrootcert="/root.pem",
        workspace_root=tmp_path,
    )


def signer() -> SigV4Signer:
    return SigV4Signer(
        "us-east-1",
        Credentials(),
        now=lambda: datetime(2026, 8, 20, 12, tzinfo=UTC),
    )


def claim() -> JobClaim:
    return JobClaim(
        status="claimed",
        job_id=UUID("50000000-0000-4000-8000-000000000005"),
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("20000000-0000-4000-8000-000000000002"),
        dataset_id=UUID("30000000-0000-4000-8000-000000000003"),
        dataset_version_id=UUID("60000000-0000-4000-8000-000000000006"),
        original_object_id=UUID("70000000-0000-4000-8000-000000000007"),
        original_filename="source roads.geojson",
        dataset_format="geojson",
        content_type="application/geo+json",
        size_bytes=len(CONTENT),
        checksum_sha256=CHECKSUM,
        attempt_count=1,
        output_prefix=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/derivatives/"
        ),
    )


def event() -> S3ObjectEvent:
    return S3ObjectEvent(
        bucket="storage.opengeo.tools",
        key=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "uploads/40000000-0000-4000-8000-000000000004/original/source roads.geojson"
        ),
        version_id="version-123",
        size_bytes=len(CONTENT),
        etag="0123456789abcdef",
        sequencer="abc123",
    )


def reference() -> ObjectReference:
    return ObjectReference(
        UUID("90000000-0000-4000-8000-000000000009"),
        "storage.opengeo.tools",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/preview/preview.geojson"
        ),
        "version-123",
        "0123456789abcdef",
        "application/geo+json",
        len(CONTENT),
        CHECKSUM,
    )


def coverage_reference() -> ObjectReference:
    return ObjectReference(
        UUID("90000000-0000-4000-8000-000000000010"),
        "storage.opengeo.tools",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "uploads/40000000-0000-4000-8000-000000000004/original/source.tif"
        ),
        "version-123",
        "0123456789abcdef",
        "image/tiff",
        len(CONTENT),
        CHECKSUM,
    )


def pmtiles_source_reference() -> ObjectReference:
    return ObjectReference(
        UUID("90000000-0000-4000-8000-000000000012"),
        "storage.opengeo.tools",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/working/layer-001.parquet"
        ),
        "version-123",
        "0123456789abcdef",
        "application/vnd.apache.parquet",
        len(CONTENT),
        CHECKSUM,
    )


def reclamation_reference() -> ObjectReference:
    return ObjectReference(
        UUID("90000000-0000-4000-8000-000000000011"),
        "storage.opengeo.tools",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/coverages/b6000000-0000-4000-8000-000000000001.tif"
        ),
        "version-123",
        "0123456789abcdef",
        "image/tiff",
        len(CONTENT),
        CHECKSUM,
    )


def render_cache_reclamation_reference() -> ObjectReference:
    return ObjectReference(
        object_id=UUID("81000000-0000-4000-8000-000000000009"),
        bucket="storage.opengeo.tools",
        object_key=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/50000000-0000-4000-8000-000000000005/derivatives/renders/"
            "b8000000-0000-4000-8000-000000000001.png"
        ),
        s3_version_id="version-123",
        etag="0123456789abcdef",
        content_type="image/png",
        size_bytes=len(CONTENT),
        checksum_sha256=CHECKSUM,
    )


def test_exact_version_download_is_signed_verified_and_hashed(tmp_path: Path) -> None:
    transport = StorageTransport()
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)
    target = tmp_path / "source.geojson"

    storage.download(event(), claim(), target)

    assert target.read_bytes() == CONTENT
    url, headers, maximum = transport.download_calls[0]
    assert url.startswith("https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/organizations/")
    assert url.endswith("source%20roads.geojson?versionId=version-123")
    assert headers["host"] == "s3.us-east-1.amazonaws.com"
    assert headers["x-amz-checksum-mode"] == "ENABLED"
    assert "session-token" not in headers["authorization"]
    assert maximum == len(CONTENT)


def test_download_fails_closed_on_exact_fact_or_encryption_mismatch(tmp_path: Path) -> None:
    transport = StorageTransport()
    transport.download_headers["X-Amz-Version-Id"] = "wrong-version"
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    with pytest.raises(ValidationFailure, match="source_object_facts_mismatch"):
        storage.download(event(), claim(), tmp_path / "source.geojson")


def test_render_source_download_uses_only_the_persisted_exact_object_facts(
    tmp_path: Path,
) -> None:
    transport = StorageTransport()
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    storage.download_reference(reference(), tmp_path / "preview.geojson")

    url, _, maximum = transport.download_calls[0]
    assert url.endswith("/derivatives/preview/preview.geojson?versionId=version-123")
    assert maximum == len(CONTENT)

    invalid = reference()
    object.__setattr__(invalid, "content_type", "text/html")
    with pytest.raises(ValidationFailure, match="render_source_facts_mismatch"):
        storage.download_reference(invalid, tmp_path / "invalid.geojson")


def test_coverage_source_download_requires_exact_versioned_kms_tiff_facts(
    tmp_path: Path,
) -> None:
    transport = StorageTransport()
    transport.download_headers["Content-Type"] = "image/tiff"
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    storage.download_coverage_source(coverage_reference(), tmp_path / "source.tif")

    url, headers, maximum = transport.download_calls[0]
    assert url.endswith("/original/source.tif?versionId=version-123")
    assert headers["x-amz-checksum-mode"] == "ENABLED"
    assert maximum == len(CONTENT)

    invalid = coverage_reference()
    object.__setattr__(invalid, "content_type", "application/octet-stream")
    with pytest.raises(ValidationFailure, match="coverage_derivative_source_facts_mismatch"):
        storage.download_coverage_source(invalid, tmp_path / "invalid.tif")


def test_pmtiles_source_download_requires_an_exact_managed_vector_version(
    tmp_path: Path,
) -> None:
    transport = StorageTransport()
    transport.download_headers["Content-Type"] = "application/vnd.apache.parquet"
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    storage.download_pmtiles_source(pmtiles_source_reference(), tmp_path / "source.parquet")

    url, headers, maximum = transport.download_calls[0]
    assert url.endswith("/derivatives/working/layer-001.parquet?versionId=version-123")
    assert headers["x-amz-checksum-mode"] == "ENABLED"
    assert maximum == len(CONTENT)

    invalid = pmtiles_source_reference()
    object.__setattr__(invalid, "object_key", "organizations/unsealed/source.parquet")
    with pytest.raises(ValidationFailure, match="pmtiles_derivative_source_facts_mismatch"):
        storage.download_pmtiles_source(invalid, tmp_path / "invalid.parquet")


def test_coverage_reclamation_heads_then_deletes_only_the_sealed_version(
    tmp_path: Path,
) -> None:
    transport = StorageTransport()
    transport.download_headers["Content-Type"] = "image/tiff"
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    storage.verify_coverage_derivative_reclamation(reclamation_reference())
    storage.delete_coverage_derivative_reclamation(reclamation_reference(), allow_missing=False)

    assert transport.head_calls[0][0].endswith(
        "/derivatives/coverages/b6000000-0000-4000-8000-000000000001.tif?versionId=version-123"
    )
    assert transport.head_calls[0][1]["x-amz-checksum-mode"] == "ENABLED"
    assert transport.delete_calls[0][0].endswith("?versionId=version-123")
    invalid = reclamation_reference()
    object.__setattr__(invalid, "object_key", "organizations/unsealed.tif")
    with pytest.raises(ValidationFailure, match="reclamation_target_invalid"):
        storage.delete_coverage_derivative_reclamation(invalid, allow_missing=False)


def test_render_cache_reclamation_heads_then_deletes_only_the_sealed_version(
    tmp_path: Path,
) -> None:
    transport = StorageTransport()
    transport.download_headers["Content-Type"] = "image/png"
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)

    storage.verify_render_cache_reclamation(render_cache_reclamation_reference())
    storage.delete_render_cache_reclamation(
        render_cache_reclamation_reference(), allow_missing=False
    )

    assert transport.head_calls[0][0].endswith(
        "/derivatives/renders/b8000000-0000-4000-8000-000000000001.png?versionId=version-123"
    )
    assert transport.delete_calls[0][0].endswith("?versionId=version-123")
    invalid = render_cache_reclamation_reference()
    object.__setattr__(invalid, "content_type", "image/svg+xml")
    with pytest.raises(ValidationFailure, match="render_cache_reclamation_target_invalid"):
        storage.delete_render_cache_reclamation(invalid, allow_missing=False)


def test_artifact_upload_binds_checksum_type_kms_and_exact_prefix(tmp_path: Path) -> None:
    path = tmp_path / "artifact.parquet"
    path.write_bytes(b"parquet-output")
    transport = StorageTransport()
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)
    artifact = ArtifactFile(
        "working", "working/layer-001.parquet", "application/vnd.apache.parquet", path
    )

    stored = storage.upload(
        artifact,
        output_prefix=claim().output_prefix or "",
        artifact_id=UUID("80000000-0000-4000-8000-000000000008"),
    )

    assert stored.s3_version_id == "artifact-version-1"
    assert stored.object_key.endswith("derivatives/working/layer-001.parquet")
    url, headers, body = transport.upload_calls[0]
    assert url.startswith("https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/organizations/")
    assert headers["host"] == "s3.us-east-1.amazonaws.com"
    assert body == b"parquet-output"
    assert headers["x-amz-server-side-encryption"] == "aws:kms"
    assert headers["x-amz-server-side-encryption-aws-kms-key-id"] == KMS_ARN
    assert headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert headers["if-none-match"] == "*"


def test_retry_recovers_the_exact_existing_version_without_creating_another(
    tmp_path: Path,
) -> None:
    path = tmp_path / "artifact.pmtiles"
    path.write_bytes(b"PMTiles\x03deterministic-output")
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    transport = StorageTransport()
    transport.upload_status = 412
    transport.head_checksum = checksum
    transport.download_headers.update(
        {
            "Content-Length": str(path.stat().st_size),
            "Content-Type": "application/vnd.pmtiles",
        }
    )
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)
    job_id = UUID("b9000000-0000-4000-8000-000000000001")
    object_key = (
        "organizations/10000000-0000-4000-8000-000000000001/"
        "projects/20000000-0000-4000-8000-000000000002/"
        "datasets/30000000-0000-4000-8000-000000000003/"
        "versions/60000000-0000-4000-8000-000000000006/"
        f"derivatives/tiles/custom/{job_id}.pmtiles"
    )

    stored = storage.upload_pmtiles_derivative(
        ArtifactFile(
            "tile",
            f"tiles/custom/{job_id}.pmtiles",
            "application/vnd.pmtiles",
            path,
        ),
        object_key=object_key,
        artifact_id=UUID("80000000-0000-4000-8000-000000000008"),
    )

    assert len(transport.upload_calls) == 1
    assert len(transport.head_calls) == 1
    assert transport.upload_calls[0][1]["if-none-match"] == "*"
    assert transport.head_calls[0][0].endswith(f"/tiles/custom/{job_id}.pmtiles")
    assert "?versionId=" not in transport.head_calls[0][0]
    assert transport.head_calls[0][1]["x-amz-checksum-mode"] == "ENABLED"
    assert stored.s3_version_id == "version-123"
    assert stored.checksum_sha256 == checksum


def test_retry_rejects_a_different_object_at_the_deterministic_key(tmp_path: Path) -> None:
    path = tmp_path / "artifact.pmtiles"
    path.write_bytes(b"PMTiles\x03deterministic-output")
    transport = StorageTransport()
    transport.upload_status = 412
    transport.download_headers.update(
        {
            "Content-Length": str(path.stat().st_size),
            "Content-Type": "application/vnd.pmtiles",
        }
    )
    storage = S3Storage(settings(tmp_path), signer=signer(), transport=transport)
    object_key = (
        "organizations/10000000-0000-4000-8000-000000000001/"
        "projects/20000000-0000-4000-8000-000000000002/"
        "datasets/30000000-0000-4000-8000-000000000003/"
        "versions/60000000-0000-4000-8000-000000000006/"
        "derivatives/tiles/custom/b9000000-0000-4000-8000-000000000001.pmtiles"
    )

    with pytest.raises(ValidationFailure, match="artifact_key_conflict"):
        storage.upload_pmtiles_derivative(
            ArtifactFile(
                "tile",
                "tiles/custom/b9000000-0000-4000-8000-000000000001.pmtiles",
                "application/vnd.pmtiles",
                path,
            ),
            object_key=object_key,
            artifact_id=UUID("80000000-0000-4000-8000-000000000008"),
        )


def test_sqs_query_client_parses_receive_and_signs_delete(tmp_path: Path) -> None:
    xml = b"""<ReceiveMessageResponse xmlns="http://queue.amazonaws.com/doc/2012-11-05/">
      <ReceiveMessageResult><Message><MessageId>message-1</MessageId>
      <ReceiptHandle>receipt-1</ReceiptHandle><Body>{}</Body>
      <Attribute><Name>ApproximateReceiveCount</Name><Value>2</Value></Attribute>
      </Message></ReceiveMessageResult></ReceiveMessageResponse>"""
    transport = QueryTransport(HttpResponse(200, {}, xml))
    queue = SqsQueue(settings(tmp_path), signer=signer(), transport=transport)

    message = queue.receive(900)

    assert message is not None and message.receive_count == 2
    assert b"Action=ReceiveMessage" in transport.calls[0][2]
    assert transport.calls[0][1]["content-type"].startswith("application/x-www-form-urlencoded")

    transport.response = HttpResponse(200, {}, b"<DeleteMessageResponse/>")
    queue.delete("receipt-1")
    assert b"Action=DeleteMessage" in transport.calls[1][2]
