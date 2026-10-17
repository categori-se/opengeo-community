import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote_plus
from uuid import UUID, uuid5

import pytest

from opengeo_worker.config import Settings
from opengeo_worker.models import (
    ArtifactFile,
    CoverageDerivativeClaim,
    CoverageDerivativeMetadata,
    CoverageDerivativeReclamationClaim,
    InspectionResult,
    JobClaim,
    ObjectReference,
    PmtilesDerivativeClaim,
    PmtilesDerivativeMetadata,
    QueueMessage,
    RenderClaim,
    RenderLayerClaim,
    StoredArtifact,
    TileCacheReclamationClaim,
    TileCacheReclamationTarget,
    TransientFailure,
    ValidationFailure,
)
from opengeo_worker.processor import WorkerProcessor

JOB_ID = UUID("50000000-0000-4000-8000-000000000005")
VERSION_ID = UUID("60000000-0000-4000-8000-000000000006")
RENDER_JOB_ID = UUID("a6000000-0000-4000-8000-000000000001")
COVERAGE_JOB_ID = UUID("b6000000-0000-4000-8000-000000000001")
PMTILES_JOB_ID = UUID("b9000000-0000-4000-8000-000000000001")
RECLAMATION_ID = UUID("b7000000-0000-4000-8000-000000000001")
TILE_RECLAMATION_ID = UUID("b8000000-0000-4000-8000-000000000001")
SOURCE = b'{"type":"FeatureCollection","features":[]}'
COVERAGE_SOURCE = b"II*\x00source-cog"
PMTILES_SOURCE = b"PAR1source-vectorPAR1"


def settings(tmp_path: Path) -> Settings:
    return Settings(
        aws_region="us-east-1",
        geodata_bucket="opengeo-test-geodata",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012"
        ),
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


def body() -> str:
    key = (
        "organizations/10000000-0000-4000-8000-000000000001/"
        "projects/20000000-0000-4000-8000-000000000002/"
        "datasets/30000000-0000-4000-8000-000000000003/"
        "uploads/40000000-0000-4000-8000-000000000004/original/source.geojson"
    )
    return json.dumps(
        {
            "Records": [
                {
                    "eventSource": "aws:s3",
                    "eventName": "ObjectCreated:Put",
                    "awsRegion": "us-east-1",
                    "s3": {
                        "bucket": {"name": "opengeo-test-geodata"},
                        "object": {
                            "key": quote_plus(key),
                            "versionId": "source-version",
                            "size": len(SOURCE),
                            "eTag": "0123456789abcdef",
                            "sequencer": "ABC123",
                        },
                    },
                }
            ]
        }
    )


def claim(status: str = "claimed") -> JobClaim:
    if status != "claimed":
        return JobClaim(status=status)  # type: ignore[arg-type]
    return JobClaim(
        status="claimed",
        job_id=JOB_ID,
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("20000000-0000-4000-8000-000000000002"),
        dataset_id=UUID("30000000-0000-4000-8000-000000000003"),
        dataset_version_id=VERSION_ID,
        original_object_id=UUID("70000000-0000-4000-8000-000000000007"),
        original_filename="source.geojson",
        dataset_format="geojson",
        content_type="application/geo+json",
        size_bytes=len(SOURCE),
        checksum_sha256=hashlib.sha256(SOURCE).hexdigest(),
        attempt_count=1,
        output_prefix=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            f"versions/{VERSION_ID}/derivatives/"
        ),
    )


def render_claim(status: str = "claimed") -> RenderClaim:
    if status != "claimed":
        return RenderClaim(status=status)  # type: ignore[arg-type]
    return RenderClaim(
        status="claimed",
        job_id=RENDER_JOB_ID,
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("20000000-0000-4000-8000-000000000002"),
        resource_id=UUID("a0000000-0000-4000-8000-000000000001"),
        dataset_id=UUID("30000000-0000-4000-8000-000000000003"),
        dataset_version_id=VERSION_ID,
        source=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000007"),
            "opengeo-test-geodata",
            "organizations/source/derivatives/preview/preview.geojson",
            "preview-version",
            "0123456789abcdef",
            "application/geo+json",
            len(SOURCE),
            hashlib.sha256(SOURCE).hexdigest(),
        ),
        profile_id=UUID("a4000000-0000-4000-8000-000000000001"),
        profile_version_id=UUID("a5000000-0000-4000-8000-000000000001"),
        style_id=UUID("a2000000-0000-4000-8000-000000000001"),
        style_version_id=UUID("a3000000-0000-4000-8000-000000000001"),
        configuration={"schema": "opengeo.render.v1"},
        configuration_checksum_sha256="a" * 64,
        bbox=(-1.0, -1.0, 1.0, 1.0),
        crs="CRS:84",
        width=640,
        height=480,
        format="svg",
        request_checksum_sha256="b" * 64,
        attempt_count=1,
        output_prefix=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            f"versions/{VERSION_ID}/derivatives/"
        ),
    )


def coverage_claim(status: str = "claimed") -> CoverageDerivativeClaim:
    if status != "claimed":
        return CoverageDerivativeClaim(status=status)  # type: ignore[arg-type]
    return CoverageDerivativeClaim(
        status="claimed",
        job_id=COVERAGE_JOB_ID,
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("20000000-0000-4000-8000-000000000002"),
        service_id=UUID("b1000000-0000-4000-8000-000000000001"),
        coverage_id=UUID("b2000000-0000-4000-8000-000000000001"),
        dataset_id=UUID("30000000-0000-4000-8000-000000000003"),
        dataset_version_id=VERSION_ID,
        source=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000007"),
            "opengeo-test-geodata",
            "organizations/source/original/source.tif",
            "source-version",
            "0123456789abcdef",
            "image/tiff",
            len(COVERAGE_SOURCE),
            hashlib.sha256(COVERAGE_SOURCE).hexdigest(),
        ),
        source_crs="EPSG:4326",
        source_extent=(-10.0, -5.0, 10.0, 5.0),
        source_width=100,
        source_height=50,
        source_band_count=1,
        source_bands=({"index": 1, "data_type": "Byte"},),
        request_schema_version=1,
        band_indexes=(1,),
        scale_mode="size",
        requested_resolution=None,
        subset_extent=(-5.0, -2.5, 5.0, 2.5),
        target_crs="EPSG:3857",
        target_width=64,
        target_height=32,
        resampling="bilinear",
        request_checksum_sha256="c" * 64,
        attempt_count=1,
        output_prefix=(
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            f"versions/{VERSION_ID}/derivatives/"
        ),
    )


def pmtiles_claim(status: str = "claimed") -> PmtilesDerivativeClaim:
    if status != "claimed":
        return PmtilesDerivativeClaim(status=status)  # type: ignore[arg-type]
    organization_id = UUID("10000000-0000-4000-8000-000000000001")
    project_id = UUID("20000000-0000-4000-8000-000000000002")
    dataset_id = UUID("30000000-0000-4000-8000-000000000003")
    return PmtilesDerivativeClaim(
        status="claimed",
        job_id=PMTILES_JOB_ID,
        organization_id=organization_id,
        project_id=project_id,
        dataset_id=dataset_id,
        dataset_version_id=VERSION_ID,
        source=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000007"),
            "opengeo-test-geodata",
            (
                f"organizations/{organization_id}/projects/{project_id}/datasets/{dataset_id}/"
                f"versions/{VERSION_ID}/derivatives/working/layer-001.parquet"
            ),
            "source-version",
            "0123456789abcdef",
            "application/vnd.apache.parquet",
            len(PMTILES_SOURCE),
            hashlib.sha256(PMTILES_SOURCE).hexdigest(),
        ),
        bounds=(-72.0, 41.0, -70.0, 43.0),
        minimum_zoom=2,
        maximum_zoom=12,
        source_layer="layer-001",
        request_checksum_sha256="f" * 64,
        attempt_count=1,
        output_object_key=(
            f"organizations/{organization_id}/projects/{project_id}/datasets/{dataset_id}/"
            f"versions/{VERSION_ID}/derivatives/tiles/custom/{PMTILES_JOB_ID}.pmtiles"
        ),
    )


def reclamation_claim(status: str = "claimed") -> CoverageDerivativeReclamationClaim:
    if status != "claimed":
        return CoverageDerivativeReclamationClaim(status=status)  # type: ignore[arg-type]
    return CoverageDerivativeReclamationClaim(
        status="claimed",
        reclamation_id=RECLAMATION_ID,
        derivative_job_id=COVERAGE_JOB_ID,
        target=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000008"),
            "opengeo-test-geodata",
            (
                "organizations/10000000-0000-4000-8000-000000000001/"
                "projects/20000000-0000-4000-8000-000000000002/"
                "datasets/30000000-0000-4000-8000-000000000003/"
                f"versions/{VERSION_ID}/derivatives/coverages/{COVERAGE_JOB_ID}.tif"
            ),
            "derived-version",
            "fedcba9876543210",
            "image/tiff",
            8192,
            "d" * 64,
        ),
        delete_started_at=None,
        attempt_count=1,
    )


def tile_reclamation_claim(status: str = "claimed") -> TileCacheReclamationClaim:
    if status != "claimed":
        return TileCacheReclamationClaim(status=status)  # type: ignore[arg-type]
    return TileCacheReclamationClaim(
        status="claimed",
        reclamation_id=TILE_RECLAMATION_ID,
        target_count=1,
        target_size_bytes=4096,
        attempt_count=1,
        targets=(
            TileCacheReclamationTarget(
                position=1,
                render_job_id=RENDER_JOB_ID,
                target=ObjectReference(
                    UUID("70000000-0000-4000-8000-000000000009"),
                    "opengeo-test-geodata",
                    (
                        "organizations/10000000-0000-4000-8000-000000000001/"
                        "projects/20000000-0000-4000-8000-000000000002/"
                        "datasets/30000000-0000-4000-8000-000000000003/"
                        f"versions/{VERSION_ID}/derivatives/renders/{RENDER_JOB_ID}.png"
                    ),
                    "render-version",
                    "0123456789abcdef",
                    "image/png",
                    4096,
                    "e" * 64,
                ),
            ),
        ),
    )


def render_layers() -> tuple[RenderLayerClaim, RenderLayerClaim]:
    base = render_claim()
    assert base.resource_id is not None
    assert base.dataset_id is not None
    assert base.dataset_version_id is not None
    assert base.source is not None
    assert base.profile_id is not None
    assert base.profile_version_id is not None
    assert base.style_id is not None
    assert base.style_version_id is not None
    assert base.configuration is not None
    assert base.configuration_checksum_sha256 is not None
    first = RenderLayerClaim(
        1,
        base.resource_id,
        base.dataset_id,
        base.dataset_version_id,
        base.source,
        base.profile_id,
        base.profile_version_id,
        base.style_id,
        base.style_version_id,
        base.configuration,
        base.configuration_checksum_sha256,
    )
    return (
        first,
        replace(
            first,
            position=2,
            resource_id=UUID("a0000000-0000-4000-8000-000000000002"),
            profile_id=UUID("a4000000-0000-4000-8000-000000000002"),
            profile_version_id=UUID("a5000000-0000-4000-8000-000000000002"),
        ),
    )


class Queue:
    def __init__(self, message_body: str = body()) -> None:
        self.message = QueueMessage("message-1", "receipt-1", message_body, 1)
        self.deleted: list[str] = []
        self.visibility: list[int] = []

    def receive(self, visibility_seconds: int) -> QueueMessage | None:
        self.visibility.append(visibility_seconds)
        return self.message

    def delete(self, receipt_handle: str) -> None:
        self.deleted.append(receipt_handle)

    def change_visibility(self, receipt_handle: str, visibility_seconds: int) -> None:
        assert receipt_handle == "receipt-1"
        self.visibility.append(visibility_seconds)


class Repository:
    def __init__(self, job_claim: JobClaim) -> None:
        self.job_claim = job_claim
        self.completed: list[tuple] = []
        self.failed: list[str] = []
        self.released: list[str] = []
        self.release_state = "queued"
        self.render_job_claim = render_claim()
        self.render_completed: list[tuple] = []
        self.render_failed: list[str] = []
        self.render_released: list[str] = []
        self.coverage_job_claim = coverage_claim()
        self.coverage_completed: list[tuple] = []
        self.coverage_failed: list[str] = []
        self.coverage_released: list[str] = []
        self.pmtiles_job_claim = pmtiles_claim()
        self.pmtiles_completed: list[tuple] = []
        self.pmtiles_failed: list[str] = []
        self.pmtiles_released: list[str] = []
        self.reclamation_job_claim = reclamation_claim()
        self.reclamation_started = 0
        self.reclamation_completed = 0
        self.reclamation_failed: list[str] = []
        self.reclamation_released: list[str] = []
        self.tile_reclamation_job_claim = tile_reclamation_claim()
        self.tile_reclamation_started: list[int] = []
        self.tile_reclamation_completed: list[int] = []
        self.tile_reclamation_failed: list[tuple[int, str]] = []
        self.tile_reclamation_released: list[str] = []
        self.tile_reclamation_finished = 0

    def claim(self, *args: object) -> JobClaim:
        return self.job_claim

    def heartbeat(self, *args: object) -> bool:
        return True

    def complete(self, *args: object) -> bool:
        self.completed.append(args)
        return True

    def fail(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        quality_results: dict[str, object],
    ) -> bool:
        del job_id, worker_token, quality_results
        self.failed.append(error_code)
        return True

    def release(self, *args: object) -> str:
        self.released.append(str(args[2]))
        return self.release_state

    def claim_render(self, *args: object) -> RenderClaim:
        return self.render_job_claim

    def heartbeat_render(self, *args: object) -> bool:
        return True

    def complete_render(self, *args: object) -> bool:
        self.render_completed.append(args)
        return True

    def fail_render(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        del job_id, worker_token
        self.render_failed.append(error_code)
        return True

    def release_render(self, *args: object) -> str:
        self.render_released.append(str(args[2]))
        return self.release_state

    def claim_coverage_derivative(self, *args: object) -> CoverageDerivativeClaim:
        return self.coverage_job_claim

    def heartbeat_coverage_derivative(self, *args: object) -> bool:
        return True

    def complete_coverage_derivative(self, *args: object) -> bool:
        self.coverage_completed.append(args)
        return True

    def fail_coverage_derivative(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        del job_id, worker_token
        self.coverage_failed.append(error_code)
        return True

    def release_coverage_derivative(self, *args: object) -> str:
        self.coverage_released.append(str(args[2]))
        return self.release_state

    def claim_pmtiles_derivative(self, *args: object) -> PmtilesDerivativeClaim:
        return self.pmtiles_job_claim

    def heartbeat_pmtiles_derivative(self, *args: object) -> bool:
        return True

    def complete_pmtiles_derivative(self, *args: object) -> bool:
        self.pmtiles_completed.append(args)
        return True

    def fail_pmtiles_derivative(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        del job_id, worker_token
        self.pmtiles_failed.append(error_code)
        return True

    def release_pmtiles_derivative(self, *args: object) -> str:
        self.pmtiles_released.append(str(args[2]))
        return self.release_state

    def claim_coverage_derivative_reclamation(
        self, *args: object
    ) -> CoverageDerivativeReclamationClaim:
        return self.reclamation_job_claim

    def heartbeat_coverage_derivative_reclamation(self, *args: object) -> bool:
        return True

    def start_coverage_derivative_delete(self, *args: object) -> bool:
        self.reclamation_started += 1
        return True

    def complete_coverage_derivative_reclamation(self, *args: object) -> bool:
        self.reclamation_completed += 1
        return True

    def fail_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, error_code: str
    ) -> bool:
        del reclamation_id, worker_token
        self.reclamation_failed.append(error_code)
        return True

    def release_coverage_derivative_reclamation(self, *args: object) -> str:
        self.reclamation_released.append(str(args[2]))
        return self.release_state

    def claim_tile_cache_reclamation(self, *args: object) -> TileCacheReclamationClaim:
        return self.tile_reclamation_job_claim

    def heartbeat_tile_cache_reclamation(self, *args: object) -> bool:
        return True

    def start_tile_cache_reclamation_item_delete(self, *args: object) -> bool:
        self.tile_reclamation_started.append(int(args[1]))
        return True

    def complete_tile_cache_reclamation_item(self, *args: object) -> bool:
        self.tile_reclamation_completed.append(int(args[1]))
        return True

    def fail_tile_cache_reclamation_item(
        self, reclamation_id: UUID, position: int, worker_token: UUID, error_code: str
    ) -> bool:
        del reclamation_id, worker_token
        self.tile_reclamation_failed.append((position, error_code))
        return True

    def finish_tile_cache_reclamation(self, *args: object) -> str:
        self.tile_reclamation_finished += 1
        return "completed" if not self.tile_reclamation_failed else "failed"

    def release_tile_cache_reclamation(self, *args: object) -> str:
        self.tile_reclamation_released.append(str(args[2]))
        return self.release_state


class Storage:
    def __init__(self) -> None:
        self.artifact_ids: list[UUID] = []
        self.reference_downloads: list[UUID] = []
        self.failure: TransientFailure | None = None
        self.reclamation_failure: TransientFailure | ValidationFailure | None = None
        self.reclamation_verifications = 0
        self.reclamation_deletes: list[bool] = []
        self.tile_reclamation_failure: TransientFailure | ValidationFailure | None = None
        self.tile_reclamation_verifications = 0
        self.tile_reclamation_deletes: list[bool] = []

    def download(self, event: object, job_claim: object, target: Path) -> None:
        del event, job_claim
        if self.failure:
            raise self.failure
        target.write_bytes(SOURCE)

    def download_reference(self, reference: ObjectReference, target: Path) -> None:
        self.reference_downloads.append(reference.object_id)
        if self.failure:
            raise self.failure
        target.write_bytes(SOURCE)

    def download_coverage_source(self, reference: ObjectReference, target: Path) -> None:
        self.reference_downloads.append(reference.object_id)
        if self.failure:
            raise self.failure
        target.write_bytes(COVERAGE_SOURCE)

    def download_pmtiles_source(self, reference: ObjectReference, target: Path) -> None:
        self.reference_downloads.append(reference.object_id)
        if self.failure:
            raise self.failure
        target.write_bytes(PMTILES_SOURCE)

    def verify_coverage_derivative_reclamation(self, reference: ObjectReference) -> None:
        del reference
        self.reclamation_verifications += 1
        if self.reclamation_failure:
            raise self.reclamation_failure

    def delete_coverage_derivative_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None:
        del reference
        self.reclamation_deletes.append(allow_missing)
        if self.reclamation_failure:
            raise self.reclamation_failure

    def verify_render_cache_reclamation(self, reference: ObjectReference) -> None:
        del reference
        self.tile_reclamation_verifications += 1
        if self.tile_reclamation_failure:
            raise self.tile_reclamation_failure

    def delete_render_cache_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None:
        del reference
        self.tile_reclamation_deletes.append(allow_missing)
        if self.tile_reclamation_failure:
            raise self.tile_reclamation_failure

    def upload(
        self, artifact: ArtifactFile, *, output_prefix: str, artifact_id: UUID
    ) -> StoredArtifact:
        self.artifact_ids.append(artifact_id)
        return StoredArtifact(
            artifact_id,
            artifact.role,
            "opengeo-test-geodata",
            output_prefix + artifact.relative_key,
            "artifact-version",
            "fedcba9876543210",
            artifact.content_type,
            artifact.path.stat().st_size,
            hashlib.sha256(artifact.path.read_bytes()).hexdigest(),
        )

    def upload_pmtiles_derivative(
        self,
        artifact: ArtifactFile,
        *,
        object_key: str,
        artifact_id: UUID,
    ) -> StoredArtifact:
        self.artifact_ids.append(artifact_id)
        return StoredArtifact(
            artifact_id,
            artifact.role,
            "opengeo-test-geodata",
            object_key,
            "artifact-version",
            "fedcba9876543210",
            artifact.content_type,
            artifact.path.stat().st_size,
            hashlib.sha256(artifact.path.read_bytes()).hexdigest(),
        )


class Inspector:
    def __init__(self) -> None:
        self.failure: ValidationFailure | None = None

    def inspect(self, source: Path, dataset_format: str, workdir: Path) -> InspectionResult:
        assert source.read_bytes() == SOURCE
        assert dataset_format == "geojson"
        if self.failure:
            raise self.failure
        artifact = workdir / "working.parquet"
        artifact.write_bytes(b"parquet")
        return InspectionResult(
            0,
            None,
            None,
            None,
            {"layers": []},
            {"valid": True},
            (
                ArtifactFile(
                    "working", "working/data.parquet", "application/vnd.apache.parquet", artifact
                ),
            ),
        )


class Renderer:
    def __init__(self) -> None:
        self.failure: ValidationFailure | None = None
        self.composition_calls: list[tuple[int, ...]] = []

    def render(self, source: Path, job_claim: RenderClaim, target: Path) -> None:
        assert source.read_bytes() == SOURCE
        assert job_claim.job_id == RENDER_JOB_ID
        if self.failure:
            raise self.failure
        if job_claim.format == "png":
            target.write_bytes(b"\x89PNG\r\n\x1a\n")
        else:
            target.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')

    def render_composition(
        self,
        sources: list[Path],
        layers: tuple[RenderLayerClaim, ...],
        job_claim: RenderClaim,
        target: Path,
    ) -> None:
        assert all(source.read_bytes() == SOURCE for source in sources)
        assert job_claim.job_id == RENDER_JOB_ID
        self.composition_calls.append(tuple(layer.position for layer in layers))
        if self.failure:
            raise self.failure
        target.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')


class CoverageGenerator:
    def __init__(self) -> None:
        self.failure: ValidationFailure | None = None
        self.calls: list[CoverageDerivativeClaim] = []

    def generate(
        self,
        source: Path,
        job_claim: CoverageDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> CoverageDerivativeMetadata:
        del workdir
        assert source.read_bytes() == COVERAGE_SOURCE
        self.calls.append(job_claim)
        if self.failure:
            raise self.failure
        target.write_bytes(b"II*\x00derived-cog")
        return CoverageDerivativeMetadata(
            crs="EPSG:3857",
            extent=(-556597.0, -278387.0, 556597.0, 278387.0),
            width=64,
            height=32,
            band_count=1,
            bands=({"index": 1, "data_type": "Byte"},),
        )


class PmtilesGenerator:
    def __init__(self) -> None:
        self.failure: ValidationFailure | None = None
        self.calls: list[PmtilesDerivativeClaim] = []
        self.feature_count = 5

    def generate(
        self,
        source: Path,
        job_claim: PmtilesDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> PmtilesDerivativeMetadata:
        del workdir
        assert source.read_bytes() == PMTILES_SOURCE
        assert source.name == "layer-001.parquet"
        self.calls.append(job_claim)
        if self.failure:
            raise self.failure
        target.write_bytes(b"PMTiles\x03derived-vector-tiles")
        return PmtilesDerivativeMetadata(
            layer_name="layer-001",
            feature_count=self.feature_count,
            minimum_zoom=2,
            maximum_zoom=12,
        )


def processor(
    tmp_path: Path,
    job_claim: JobClaim | None = None,
) -> tuple[WorkerProcessor, Queue, Repository, Storage, Inspector]:
    queue = Queue()
    repository = Repository(job_claim or claim())
    storage = Storage()
    inspector = Inspector()
    return (
        WorkerProcessor(settings(tmp_path), queue, repository, storage, inspector),
        queue,
        repository,
        storage,
        inspector,
    )


def test_success_uploads_deterministic_artifacts_completes_and_acknowledges(tmp_path: Path) -> None:
    worker, queue, repository, storage, _ = processor(tmp_path)

    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    assert len(repository.completed) == 1
    first_artifact_id = storage.artifact_ids[0]

    worker, _, _, second_storage, _ = processor(tmp_path)
    assert worker.process_once() == "completed"
    assert second_storage.artifact_ids == [first_artifact_id]


def test_early_event_is_deferred_without_acknowledgement(tmp_path: Path) -> None:
    worker, queue, _, _, _ = processor(tmp_path, claim("not_ready"))
    assert worker.process_once() == "retry"
    assert queue.deleted == []
    assert queue.visibility[-1] == 30


def test_duplicate_terminal_event_is_acknowledged_without_storage(tmp_path: Path) -> None:
    worker, queue, _, storage, _ = processor(tmp_path, claim("already_completed"))
    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    assert storage.artifact_ids == []


def test_actionable_validation_failure_is_finalized_and_acknowledged(tmp_path: Path) -> None:
    worker, queue, repository, _, inspector = processor(tmp_path)
    inspector.failure = ValidationFailure("dataset_magic_mismatch")

    assert worker.process_once() == "completed"
    assert repository.failed == ["dataset_magic_mismatch"]
    assert queue.deleted == ["receipt-1"]


def test_transient_failure_requeues_without_ack_until_attempts_are_exhausted(
    tmp_path: Path,
) -> None:
    worker, queue, repository, storage, _ = processor(tmp_path)
    storage.failure = TransientFailure("s3_download_unavailable")

    assert worker.process_once() == "retry"
    assert repository.released == ["s3_download_unavailable"]
    assert queue.deleted == []

    repository.release_state = "failed"
    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]


def test_poison_message_is_safely_discarded_before_claim(tmp_path: Path) -> None:
    worker, queue, repository, _, _ = processor(tmp_path)
    queue.message = QueueMessage("message-1", "receipt-1", "not-json", 1)

    assert worker.process_once() == "discarded"
    assert queue.deleted == ["receipt-1"]
    assert repository.completed == []


def test_render_command_uses_exact_claim_and_completes_one_svg(tmp_path: Path) -> None:
    queue = Queue(
        json.dumps(
            {
                "schema": "opengeo.render.command.v1",
                "render_job_id": str(RENDER_JOB_ID),
            }
        )
    )
    repository = Repository(claim())
    storage = Storage()
    renderer = Renderer()
    worker = WorkerProcessor(settings(tmp_path), queue, repository, storage, Inspector(), renderer)

    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    assert len(repository.render_completed) == 1
    assert storage.artifact_ids == [UUID("5b3e0f04-9442-5741-b22a-cd8f551416e7")]


def test_render_command_uses_format_specific_png_identity_and_media_type(tmp_path: Path) -> None:
    queue = Queue(
        json.dumps(
            {
                "schema": "opengeo.render.command.v1",
                "render_job_id": str(RENDER_JOB_ID),
            }
        )
    )
    repository = Repository(claim())
    repository.render_job_claim = replace(render_claim(), format="png")
    storage = Storage()
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )

    assert worker.process_once() == "completed"
    artifact = repository.render_completed[0][2]
    assert isinstance(artifact, StoredArtifact)
    assert artifact.object_key.endswith(f"renders/{RENDER_JOB_ID}.png")
    assert artifact.content_type == "image/png"
    assert storage.artifact_ids == [uuid5(RENDER_JOB_ID, "output.png")]


def test_render_command_downloads_and_composes_every_ordered_layer(tmp_path: Path) -> None:
    queue = Queue(
        json.dumps(
            {
                "schema": "opengeo.render.command.v1",
                "render_job_id": str(RENDER_JOB_ID),
            }
        )
    )
    repository = Repository(claim())
    layers = render_layers()
    repository.render_job_claim = replace(render_claim(), layers=layers)
    storage = Storage()
    renderer = Renderer()
    worker = WorkerProcessor(settings(tmp_path), queue, repository, storage, Inspector(), renderer)

    assert worker.process_once() == "completed"
    assert renderer.composition_calls == [(1, 2)]
    assert storage.reference_downloads == [layer.source.object_id for layer in layers]
    assert len(repository.render_completed) == 1
    assert queue.deleted == ["receipt-1"]


def test_render_validation_failure_is_final_and_transient_download_retries(
    tmp_path: Path,
) -> None:
    render_body = json.dumps(
        {"schema": "opengeo.render.command.v1", "render_job_id": str(RENDER_JOB_ID)}
    )
    queue = Queue(render_body)
    repository = Repository(claim())
    renderer = Renderer()
    renderer.failure = ValidationFailure("render_geometry_invalid")
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, Storage(), Inspector(), renderer
    )

    assert worker.process_once() == "completed"
    assert repository.render_failed == ["render_geometry_invalid"]
    assert queue.deleted == ["receipt-1"]

    queue = Queue(render_body)
    repository = Repository(claim())
    storage = Storage()
    storage.failure = TransientFailure("s3_download_unavailable")
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )
    assert worker.process_once() == "retry"
    assert repository.render_released == ["s3_download_unavailable"]
    assert queue.deleted == []


def coverage_body() -> str:
    return json.dumps(
        {
            "schema": "opengeo.coverage-derivative.command.v1",
            "coverage_derivative_job_id": str(COVERAGE_JOB_ID),
        }
    )


def pmtiles_body() -> str:
    return json.dumps(
        {
            "schema": "opengeo.pmtiles-derivative.command.v1",
            "pmtiles_derivative_job_id": str(PMTILES_JOB_ID),
        }
    )


def reclamation_body() -> str:
    return json.dumps(
        {
            "schema": "opengeo.coverage-derivative-reclamation.command.v1",
            "coverage_derivative_reclamation_id": str(RECLAMATION_ID),
        }
    )


def tile_reclamation_body() -> str:
    return json.dumps(
        {
            "schema": "opengeo.render-cache-reclamation.command.v1",
            "render_cache_reclamation_id": str(TILE_RECLAMATION_ID),
        }
    )


def test_coverage_derivative_uses_exact_source_and_completes_one_cog(tmp_path: Path) -> None:
    queue = Queue(coverage_body())
    repository = Repository(claim())
    storage = Storage()
    generator = CoverageGenerator()
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        storage,
        Inspector(),
        Renderer(),
        generator,
    )

    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    assert generator.calls == [repository.coverage_job_claim]
    assert storage.artifact_ids == [uuid5(COVERAGE_JOB_ID, "output.tif")]
    artifact = repository.coverage_completed[0][2]
    assert isinstance(artifact, StoredArtifact)
    assert artifact.object_key.endswith(f"derivatives/coverages/{COVERAGE_JOB_ID}.tif")
    assert artifact.content_type == "image/tiff"


def test_coverage_derivative_defers_early_claim_and_finalizes_invalid_output(
    tmp_path: Path,
) -> None:
    queue = Queue(coverage_body())
    repository = Repository(claim())
    repository.coverage_job_claim = coverage_claim("not_ready")
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, Storage(), Inspector(), Renderer()
    )
    assert worker.process_once() == "retry"
    assert queue.deleted == []
    assert queue.visibility[-1] == 30

    queue = Queue(coverage_body())
    repository = Repository(claim())
    generator = CoverageGenerator()
    generator.failure = ValidationFailure("coverage_derivative_crs_mismatch")
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        Storage(),
        Inspector(),
        Renderer(),
        generator,
    )
    assert worker.process_once() == "completed"
    assert repository.coverage_failed == ["coverage_derivative_crs_mismatch"]
    assert queue.deleted == ["receipt-1"]


def test_coverage_derivative_transient_download_releases_without_acknowledgement(
    tmp_path: Path,
) -> None:
    queue = Queue(coverage_body())
    repository = Repository(claim())
    storage = Storage()
    storage.failure = TransientFailure("s3_download_unavailable")
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        storage,
        Inspector(),
        Renderer(),
        CoverageGenerator(),
    )

    assert worker.process_once() == "retry"
    assert repository.coverage_released == ["s3_download_unavailable"]
    assert queue.deleted == []


def test_pmtiles_derivative_uses_exact_source_and_server_built_output_key(
    tmp_path: Path,
) -> None:
    queue = Queue(pmtiles_body())
    repository = Repository(claim())
    storage = Storage()
    generator = PmtilesGenerator()
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        storage,
        Inspector(),
        Renderer(),
        CoverageGenerator(),
        generator,
    )

    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    assert generator.calls == [repository.pmtiles_job_claim]
    assert storage.reference_downloads == [UUID("70000000-0000-4000-8000-000000000007")]
    assert storage.artifact_ids == [uuid5(PMTILES_JOB_ID, "output.pmtiles")]
    artifact = repository.pmtiles_completed[0][2]
    assert isinstance(artifact, StoredArtifact)
    assert artifact.object_key == repository.pmtiles_job_claim.output_object_key
    assert artifact.content_type == "application/vnd.pmtiles"
    assert len(repository.pmtiles_completed[0]) == 3


@pytest.mark.parametrize("feature_count", [5, 100_001])
def test_pmtiles_completion_retains_validation_and_exact_versioned_index_when_needed(
    tmp_path: Path, feature_count: int
) -> None:
    queue = Queue(pmtiles_body())
    repository = Repository(claim())
    storage = Storage()
    generator = PmtilesGenerator()
    generator.feature_count = feature_count
    worker = WorkerProcessor(
        replace(settings(tmp_path), geodata_expected_owner="222222222222"),
        queue,
        repository,
        storage,
        Inspector(),
        Renderer(),
        CoverageGenerator(),
        generator,
    )

    assert worker.process_once() == "completed"
    assert queue.deleted == ["receipt-1"]
    completion = repository.pmtiles_completed[0]
    assert len(completion) == 4
    validation = completion[3]
    assert validation["expected_owner"] == "222222222222"
    assert validation["output_checksum_sha256"] == completion[2].checksum_sha256
    assert validation["output_layer"]["reported_fragment_count"] == feature_count
    body = b"PMTiles\x03derived-vector-tiles"
    block_digest = hashlib.sha256(body).digest()
    if feature_count <= 100_000:
        assert storage.artifact_ids == [uuid5(PMTILES_JOB_ID, "output.pmtiles")]
        assert validation["block_sha256"] == [block_digest.hex()]
        assert "block_index_artifact" not in validation
    else:
        assert storage.artifact_ids == [
            uuid5(PMTILES_JOB_ID, "output.pmtiles"),
            uuid5(PMTILES_JOB_ID, "output.blocks.sha256"),
        ]
        index = validation["block_index_artifact"]
        assert index["object_key"] == repository.pmtiles_job_claim.output_object_key.replace(
            ".pmtiles", ".blocks.sha256"
        )
        assert index["role"] == "derived"
        assert index["s3_version_id"] == "artifact-version"
        assert index["size_bytes"] == 32
        assert index["checksum_sha256"] == hashlib.sha256(block_digest).hexdigest()
        assert "block_sha256" not in validation


def test_pmtiles_derivative_defers_early_claim_and_finalizes_invalid_output(
    tmp_path: Path,
) -> None:
    queue = Queue(pmtiles_body())
    repository = Repository(claim())
    repository.pmtiles_job_claim = pmtiles_claim("not_ready")
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, Storage(), Inspector(), Renderer()
    )
    assert worker.process_once() == "retry"
    assert queue.deleted == []
    assert queue.visibility[-1] == 30

    queue = Queue(pmtiles_body())
    repository = Repository(claim())
    generator = PmtilesGenerator()
    generator.failure = ValidationFailure("pmtiles_derivative_metadata_invalid")
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        Storage(),
        Inspector(),
        Renderer(),
        CoverageGenerator(),
        generator,
    )
    assert worker.process_once() == "completed"
    assert repository.pmtiles_failed == ["pmtiles_derivative_metadata_invalid"]
    assert queue.deleted == ["receipt-1"]


def test_pmtiles_derivative_transient_download_releases_without_acknowledgement(
    tmp_path: Path,
) -> None:
    queue = Queue(pmtiles_body())
    repository = Repository(claim())
    storage = Storage()
    storage.failure = TransientFailure("s3_download_unavailable")
    worker = WorkerProcessor(
        settings(tmp_path),
        queue,
        repository,
        storage,
        Inspector(),
        Renderer(),
        CoverageGenerator(),
        PmtilesGenerator(),
    )

    assert worker.process_once() == "retry"
    assert repository.pmtiles_released == ["s3_download_unavailable"]
    assert queue.deleted == []


def test_coverage_reclamation_verifies_starts_and_deletes_exact_version(tmp_path: Path) -> None:
    queue = Queue(reclamation_body())
    repository = Repository(claim())
    storage = Storage()
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )

    assert worker.process_once() == "completed"
    assert storage.reclamation_verifications == 1
    assert storage.reclamation_deletes == [False]
    assert repository.reclamation_started == 1
    assert repository.reclamation_completed == 1
    assert queue.deleted == ["receipt-1"]


def test_coverage_reclamation_retry_after_delete_start_accepts_missing_version(
    tmp_path: Path,
) -> None:
    queue = Queue(reclamation_body())
    repository = Repository(claim())
    repository.reclamation_job_claim = replace(
        reclamation_claim(), delete_started_at=datetime(2026, 8, 21, tzinfo=UTC)
    )
    storage = Storage()
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )

    assert worker.process_once() == "completed"
    assert storage.reclamation_verifications == 0
    assert storage.reclamation_deletes == [True]
    assert repository.reclamation_started == 0
    assert repository.reclamation_completed == 1


def test_tile_cache_reclamation_processes_exact_batch_and_retains_message_boundary(
    tmp_path: Path,
) -> None:
    queue = Queue(tile_reclamation_body())
    repository = Repository(claim())
    storage = Storage()
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )

    assert worker.process_once() == "completed"
    assert storage.tile_reclamation_verifications == 1
    assert storage.tile_reclamation_deletes == [False]
    assert repository.tile_reclamation_started == [1]
    assert repository.tile_reclamation_completed == [1]
    assert repository.tile_reclamation_finished == 1
    assert queue.deleted == ["receipt-1"]


def test_tile_cache_reclamation_post_delete_ambiguity_retries_with_allow_missing(
    tmp_path: Path,
) -> None:
    queue = Queue(tile_reclamation_body())
    repository = Repository(claim())
    started_target = replace(
        tile_reclamation_claim().targets[0],
        delete_started_at=datetime(2026, 8, 21, tzinfo=UTC),
    )
    repository.tile_reclamation_job_claim = replace(
        tile_reclamation_claim(), targets=(started_target,)
    )
    storage = Storage()
    worker = WorkerProcessor(
        settings(tmp_path), queue, repository, storage, Inspector(), Renderer()
    )

    assert worker.process_once() == "completed"
    assert storage.tile_reclamation_verifications == 0
    assert storage.tile_reclamation_deletes == [True]
    assert repository.tile_reclamation_started == []
    assert repository.tile_reclamation_completed == [1]
