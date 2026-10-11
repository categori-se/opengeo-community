import logging
import re
import tempfile
import threading
from collections.abc import Callable, Sequence
from pathlib import Path, PurePosixPath
from types import TracebackType
from typing import Literal, Protocol, Self
from uuid import UUID, uuid4, uuid5

from opengeo_worker.config import Settings
from opengeo_worker.coverage_derivatives import CoverageDerivativeGenerator
from opengeo_worker.events import (
    parse_coverage_derivative_command,
    parse_coverage_derivative_reclamation_command,
    parse_pmtiles_derivative_command,
    parse_render_command,
    parse_s3_events,
    parse_tile_cache_reclamation_command,
)
from opengeo_worker.inspector import DatasetInspector
from opengeo_worker.maplibre_renderer import DispatchingMapRenderer
from opengeo_worker.models import (
    ArtifactFile,
    CoverageDerivativeClaim,
    CoverageDerivativeMetadata,
    CoverageDerivativeReclamationClaim,
    InspectionResult,
    JobClaim,
    LeaseLost,
    ObjectReference,
    PmtilesDerivativeClaim,
    PmtilesDerivativeMetadata,
    QueueMessage,
    RenderClaim,
    RenderLayerClaim,
    S3ObjectEvent,
    StoredArtifact,
    TileCacheReclamationClaim,
    TransientFailure,
    ValidationFailure,
)
from opengeo_worker.pmtiles_derivatives import PmtilesDerivativeGenerator

logger = logging.getLogger(__name__)
ProcessOutcome = Literal["empty", "completed", "discarded", "retry"]

_SOURCE_FILENAMES = {
    "kml": "source.kml",
    "geojson": "source.geojson",
    "csv": "source.csv",
    "shapefile": "source.zip",
    "geopackage": "source.gpkg",
    "geoparquet": "source.parquet",
    "cog": "source.tif",
    "pmtiles": "source.pmtiles",
    "png": "source.png",
    "jpeg": "source.jpg",
    "pdf": "source.pdf",
    "odt": "source.odt",
}
_PMTILES_SOURCE_FILENAMES = {
    "application/geo+json": "source.geojson",
    "application/geopackage+sqlite3": "source.gpkg",
    "application/vnd.apache.parquet": "source.parquet",
    "application/zip": "source.zip",
    "text/csv": "source.csv",
}


class QueueClient(Protocol):
    def receive(self, visibility_seconds: int) -> QueueMessage | None: ...

    def delete(self, receipt_handle: str) -> None: ...

    def change_visibility(self, receipt_handle: str, visibility_seconds: int) -> None: ...


class Repository(Protocol):
    def claim(
        self,
        bucket: str,
        key: str,
        version_id: str,
        worker_token: UUID,
        lease_seconds: int,
    ) -> JobClaim: ...

    def heartbeat(self, job_id: UUID, worker_token: UUID, lease_seconds: int) -> bool: ...

    def complete(
        self,
        job_id: UUID,
        worker_token: UUID,
        inspection: InspectionResult,
        artifacts: Sequence[StoredArtifact],
    ) -> bool: ...

    def fail(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        quality_results: dict[str, object],
    ) -> bool: ...

    def release(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str: ...

    def claim_render(self, job_id: UUID, worker_token: UUID, lease_seconds: int) -> RenderClaim: ...

    def heartbeat_render(self, job_id: UUID, worker_token: UUID, lease_seconds: int) -> bool: ...

    def complete_render(
        self, job_id: UUID, worker_token: UUID, artifact: StoredArtifact
    ) -> bool: ...

    def fail_render(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool: ...

    def release_render(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str: ...

    def claim_coverage_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> CoverageDerivativeClaim: ...

    def heartbeat_coverage_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool: ...

    def complete_coverage_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        artifact: StoredArtifact,
        metadata: CoverageDerivativeMetadata,
    ) -> bool: ...

    def fail_coverage_derivative(
        self, job_id: UUID, worker_token: UUID, error_code: str
    ) -> bool: ...

    def release_coverage_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str: ...

    def claim_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> PmtilesDerivativeClaim: ...

    def heartbeat_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool: ...

    def complete_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, artifact: StoredArtifact
    ) -> bool: ...

    def fail_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, error_code: str
    ) -> bool: ...

    def release_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, error_code: str
    ) -> str: ...

    def claim_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> CoverageDerivativeReclamationClaim: ...

    def heartbeat_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool: ...

    def start_coverage_derivative_delete(
        self, reclamation_id: UUID, worker_token: UUID
    ) -> bool: ...

    def complete_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID
    ) -> bool: ...

    def fail_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, error_code: str
    ) -> bool: ...

    def release_coverage_derivative_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str: ...

    def claim_tile_cache_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> TileCacheReclamationClaim: ...

    def heartbeat_tile_cache_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool: ...

    def start_tile_cache_reclamation_item_delete(
        self, reclamation_id: UUID, position: int, worker_token: UUID
    ) -> bool: ...

    def complete_tile_cache_reclamation_item(
        self, reclamation_id: UUID, position: int, worker_token: UUID
    ) -> bool: ...

    def fail_tile_cache_reclamation_item(
        self,
        reclamation_id: UUID,
        position: int,
        worker_token: UUID,
        error_code: str,
    ) -> bool: ...

    def finish_tile_cache_reclamation(self, reclamation_id: UUID, worker_token: UUID) -> str: ...

    def release_tile_cache_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str: ...


class Storage(Protocol):
    def download(self, event: S3ObjectEvent, claim: JobClaim, target: Path) -> None: ...

    def upload(
        self, artifact: ArtifactFile, *, output_prefix: str, artifact_id: UUID
    ) -> StoredArtifact: ...

    def download_reference(self, reference: ObjectReference, target: Path) -> None: ...

    def download_coverage_source(self, reference: ObjectReference, target: Path) -> None: ...

    def download_pmtiles_source(self, reference: ObjectReference, target: Path) -> None: ...

    def upload_pmtiles_derivative(
        self,
        artifact: ArtifactFile,
        *,
        object_key: str,
        artifact_id: UUID,
    ) -> StoredArtifact: ...

    def verify_coverage_derivative_reclamation(self, reference: ObjectReference) -> None: ...

    def delete_coverage_derivative_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None: ...

    def verify_render_cache_reclamation(self, reference: ObjectReference) -> None: ...

    def delete_render_cache_reclamation(
        self, reference: ObjectReference, *, allow_missing: bool
    ) -> None: ...


class Inspector(Protocol):
    def inspect(self, source: Path, dataset_format: str, workdir: Path) -> InspectionResult: ...


class Renderer(Protocol):
    def render(self, source: Path, claim: RenderClaim, target: Path) -> None: ...

    def render_composition(
        self,
        sources: Sequence[Path],
        layers: Sequence[RenderLayerClaim],
        claim: RenderClaim,
        target: Path,
    ) -> None: ...


class CoverageGenerator(Protocol):
    def generate(
        self,
        source: Path,
        claim: CoverageDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> CoverageDerivativeMetadata: ...


class PmtilesGenerator(Protocol):
    def generate(
        self,
        source: Path,
        claim: PmtilesDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> PmtilesDerivativeMetadata: ...


class WorkerProcessor:
    def __init__(
        self,
        settings: Settings,
        queue: QueueClient,
        repository: Repository,
        storage: Storage,
        inspector: Inspector | None = None,
        renderer: Renderer | None = None,
        coverage_derivative_generator: CoverageGenerator | None = None,
        pmtiles_derivative_generator: PmtilesGenerator | None = None,
    ) -> None:
        self._settings = settings
        self._queue = queue
        self._repository = repository
        self._storage = storage
        self._inspector = inspector or DatasetInspector(settings)
        self._renderer = renderer or DispatchingMapRenderer()
        self._coverage_derivative_generator = (
            coverage_derivative_generator or CoverageDerivativeGenerator(settings)
        )
        self._pmtiles_derivative_generator = (
            pmtiles_derivative_generator or PmtilesDerivativeGenerator(settings)
        )

    def process_once(self) -> ProcessOutcome:
        message = self._queue.receive(self._settings.visibility_seconds)
        if message is None:
            return "empty"
        try:
            tile_reclamation_command = parse_tile_cache_reclamation_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
            if tile_reclamation_command is not None:
                outcome = self._process_tile_cache_reclamation(
                    tile_reclamation_command.render_cache_reclamation_id, message
                )
                if outcome != "retry":
                    self._queue.delete(message.receipt_handle)
                return outcome
            reclamation_command = parse_coverage_derivative_reclamation_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
            if reclamation_command is not None:
                outcome = self._process_coverage_derivative_reclamation(
                    reclamation_command.coverage_derivative_reclamation_id, message
                )
                if outcome != "retry":
                    self._queue.delete(message.receipt_handle)
                return outcome
            render_command = parse_render_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
            if render_command is not None:
                outcome = self._process_render(render_command.render_job_id, message)
                if outcome != "retry":
                    self._queue.delete(message.receipt_handle)
                return outcome
            coverage_command = parse_coverage_derivative_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
            if coverage_command is not None:
                outcome = self._process_coverage_derivative(
                    coverage_command.coverage_derivative_job_id, message
                )
                if outcome != "retry":
                    self._queue.delete(message.receipt_handle)
                return outcome
            pmtiles_command = parse_pmtiles_derivative_command(
                message.body, max_message_bytes=self._settings.max_message_bytes
            )
            if pmtiles_command is not None:
                outcome = self._process_pmtiles_derivative(
                    pmtiles_command.pmtiles_derivative_job_id, message
                )
                if outcome != "retry":
                    self._queue.delete(message.receipt_handle)
                return outcome
            events = parse_s3_events(
                message.body,
                expected_bucket=self._settings.geodata_bucket,
                expected_region=self._settings.aws_region,
                max_message_bytes=self._settings.max_message_bytes,
                max_object_bytes=self._settings.max_object_bytes,
            )
        except ValidationFailure as error:
            logger.warning("discarding invalid queue message", extra={"error_code": error.code})
            self._queue.delete(message.receipt_handle)
            return "discarded"
        if not events:
            self._queue.delete(message.receipt_handle)
            return "discarded"

        for event in events:
            outcome = self._process_event(event, message)
            if outcome == "retry":
                return "retry"
        self._queue.delete(message.receipt_handle)
        return "completed"

    def _process_event(self, event: S3ObjectEvent, message: QueueMessage) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim(
            event.bucket,
            event.key,
            event.version_id,
            worker_token,
            self._settings.lease_seconds,
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.job_id is not None
        assert claim.dataset_version_id is not None
        assert claim.dataset_format is not None
        assert claim.output_prefix is not None

        self._prepare_workspace_root()
        try:
            with (
                tempfile.TemporaryDirectory(
                    prefix=f"job-{claim.job_id}-", dir=self._settings.workspace_root
                ) as directory,
                LeaseMaintainer(
                    heartbeat=self._repository.heartbeat,
                    queue=self._queue,
                    message=message,
                    job_id=claim.job_id,
                    worker_token=worker_token,
                    lease_seconds=self._settings.lease_seconds,
                    heartbeat_seconds=self._settings.heartbeat_seconds,
                    visibility_seconds=self._settings.visibility_seconds,
                ) as lease,
            ):
                workdir = Path(directory)
                source = workdir / _SOURCE_FILENAMES[claim.dataset_format]
                self._storage.download(event, claim, source)
                lease.assert_active()
                inspection = self._inspector.inspect(source, claim.dataset_format, workdir)
                artifacts = []
                for artifact in inspection.artifacts:
                    lease.assert_active()
                    artifacts.append(
                        self._storage.upload(
                            artifact,
                            output_prefix=claim.output_prefix,
                            artifact_id=uuid5(claim.dataset_version_id, artifact.relative_key),
                        )
                    )
                lease.renew_now()
                if not self._repository.complete(claim.job_id, worker_token, inspection, artifacts):
                    raise LeaseLost
        except ValidationFailure as error:
            if not self._repository.fail(
                claim.job_id, worker_token, error.code, error.quality_results
            ):
                return "retry"
            logger.info(
                "dataset validation failed job_id=%s error_code=%s", claim.job_id, error.code
            )
            return "completed"
        except LeaseLost:
            logger.warning("processing lease lost job_id=%s", claim.job_id)
            return "retry"
        except TransientFailure as error:
            state = self._repository.release(
                claim.job_id,
                worker_token,
                error.code,
                self._settings.max_attempts,
            )
            logger.warning(
                "transient dataset processing failure job_id=%s error_code=%s release_state=%s",
                claim.job_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info("dataset ingestion completed job_id=%s", claim.job_id)
        return "completed"

    def _process_render(self, render_job_id: UUID, message: QueueMessage) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim_render(
            render_job_id, worker_token, self._settings.lease_seconds
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.job_id is not None
        assert claim.source is not None
        assert claim.output_prefix is not None
        self._prepare_workspace_root()
        try:
            with (
                tempfile.TemporaryDirectory(
                    prefix=f"render-{claim.job_id}-", dir=self._settings.workspace_root
                ) as directory,
                LeaseMaintainer(
                    heartbeat=self._repository.heartbeat_render,
                    queue=self._queue,
                    message=message,
                    job_id=claim.job_id,
                    worker_token=worker_token,
                    lease_seconds=self._settings.lease_seconds,
                    heartbeat_seconds=self._settings.heartbeat_seconds,
                    visibility_seconds=self._settings.visibility_seconds,
                ) as lease,
            ):
                workdir = Path(directory)
                source = workdir / "preview.geojson"
                assert claim.format is not None
                extension = claim.format
                content_type = {
                    "svg": "image/svg+xml",
                    "png": "image/png",
                }[extension]
                output = workdir / f"output.{extension}"
                if len(claim.layers) > 1:
                    layer_sources: list[Path] = []
                    for layer in claim.layers:
                        layer_source = workdir / f"layer-{layer.position}.geojson"
                        self._storage.download_reference(layer.source, layer_source)
                        layer_sources.append(layer_source)
                        lease.assert_active()
                    self._renderer.render_composition(layer_sources, claim.layers, claim, output)
                else:
                    self._storage.download_reference(claim.source, source)
                    lease.assert_active()
                    self._renderer.render(source, claim, output)
                lease.assert_active()
                artifact = self._storage.upload(
                    ArtifactFile(
                        "derived",
                        f"renders/{claim.job_id}.{extension}",
                        content_type,
                        output,
                    ),
                    output_prefix=claim.output_prefix,
                    artifact_id=uuid5(claim.job_id, f"output.{extension}"),
                )
                lease.renew_now()
                if not self._repository.complete_render(claim.job_id, worker_token, artifact):
                    raise LeaseLost
        except ValidationFailure as error:
            if not self._repository.fail_render(claim.job_id, worker_token, error.code):
                return "retry"
            logger.info("map render failed job_id=%s error_code=%s", claim.job_id, error.code)
            return "completed"
        except LeaseLost:
            logger.warning("map render lease lost job_id=%s", claim.job_id)
            return "retry"
        except TransientFailure as error:
            state = self._repository.release_render(
                claim.job_id, worker_token, error.code, self._settings.max_attempts
            )
            logger.warning(
                "transient map render failure job_id=%s error_code=%s release_state=%s",
                claim.job_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info("map render completed job_id=%s", claim.job_id)
        return "completed"

    def _process_coverage_derivative(self, job_id: UUID, message: QueueMessage) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim_coverage_derivative(
            job_id, worker_token, self._settings.lease_seconds
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.job_id is not None
        assert claim.source is not None
        assert claim.output_prefix is not None
        self._prepare_workspace_root()
        try:
            with (
                tempfile.TemporaryDirectory(
                    prefix=f"coverage-{claim.job_id}-", dir=self._settings.workspace_root
                ) as directory,
                LeaseMaintainer(
                    heartbeat=self._repository.heartbeat_coverage_derivative,
                    queue=self._queue,
                    message=message,
                    job_id=claim.job_id,
                    worker_token=worker_token,
                    lease_seconds=self._settings.lease_seconds,
                    heartbeat_seconds=self._settings.heartbeat_seconds,
                    visibility_seconds=self._settings.visibility_seconds,
                ) as lease,
            ):
                workdir = Path(directory)
                source = workdir / "source.tif"
                output = workdir / "output.tif"
                self._storage.download_coverage_source(claim.source, source)
                lease.assert_active()
                metadata = self._coverage_derivative_generator.generate(
                    source, claim, output, workdir
                )
                lease.assert_active()
                artifact = self._storage.upload(
                    ArtifactFile("derived", f"coverages/{claim.job_id}.tif", "image/tiff", output),
                    output_prefix=claim.output_prefix,
                    artifact_id=uuid5(claim.job_id, "output.tif"),
                )
                lease.renew_now()
                if not self._repository.complete_coverage_derivative(
                    claim.job_id, worker_token, artifact, metadata
                ):
                    raise LeaseLost
        except ValidationFailure as error:
            if not self._repository.fail_coverage_derivative(
                claim.job_id, worker_token, error.code
            ):
                return "retry"
            logger.info(
                "coverage derivative failed job_id=%s error_code=%s",
                claim.job_id,
                error.code,
            )
            return "completed"
        except LeaseLost:
            logger.warning("coverage derivative lease lost job_id=%s", claim.job_id)
            return "retry"
        except TransientFailure as error:
            state = self._repository.release_coverage_derivative(
                claim.job_id,
                worker_token,
                error.code,
                self._settings.max_attempts,
            )
            logger.warning(
                "transient coverage derivative failure job_id=%s error_code=%s release_state=%s",
                claim.job_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info("coverage derivative completed job_id=%s", claim.job_id)
        return "completed"

    def _process_pmtiles_derivative(self, job_id: UUID, message: QueueMessage) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim_pmtiles_derivative(
            job_id, worker_token, self._settings.lease_seconds
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.job_id is not None
        assert claim.source is not None
        assert claim.output_object_key is not None
        self._prepare_workspace_root()
        try:
            source_filename = _pmtiles_source_filename(claim.source)
            if source_filename is None:
                raise ValidationFailure("pmtiles_derivative_source_facts_mismatch")
            with (
                tempfile.TemporaryDirectory(
                    prefix=f"pmtiles-{claim.job_id}-", dir=self._settings.workspace_root
                ) as directory,
                LeaseMaintainer(
                    heartbeat=self._repository.heartbeat_pmtiles_derivative,
                    queue=self._queue,
                    message=message,
                    job_id=claim.job_id,
                    worker_token=worker_token,
                    lease_seconds=self._settings.lease_seconds,
                    heartbeat_seconds=self._settings.heartbeat_seconds,
                    visibility_seconds=self._settings.visibility_seconds,
                ) as lease,
            ):
                workdir = Path(directory)
                source = workdir / source_filename
                output = workdir / "output.pmtiles"
                self._storage.download_pmtiles_source(claim.source, source)
                lease.assert_active()
                self._pmtiles_derivative_generator.generate(source, claim, output, workdir)
                lease.assert_active()
                artifact = self._storage.upload_pmtiles_derivative(
                    ArtifactFile(
                        "tile",
                        f"tiles/custom/{claim.job_id}.pmtiles",
                        "application/vnd.pmtiles",
                        output,
                    ),
                    object_key=claim.output_object_key,
                    artifact_id=uuid5(claim.job_id, "output.pmtiles"),
                )
                lease.renew_now()
                if not self._repository.complete_pmtiles_derivative(
                    claim.job_id, worker_token, artifact
                ):
                    raise LeaseLost
        except ValidationFailure as error:
            if not self._repository.fail_pmtiles_derivative(claim.job_id, worker_token, error.code):
                return "retry"
            logger.info(
                "PMTiles derivative failed job_id=%s error_code=%s",
                claim.job_id,
                error.code,
            )
            return "completed"
        except LeaseLost:
            logger.warning("PMTiles derivative lease lost job_id=%s", claim.job_id)
            return "retry"
        except TransientFailure as error:
            state = self._repository.release_pmtiles_derivative(
                claim.job_id,
                worker_token,
                error.code,
            )
            logger.warning(
                "transient PMTiles derivative failure job_id=%s error_code=%s release_state=%s",
                claim.job_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info("PMTiles derivative completed job_id=%s", claim.job_id)
        return "completed"

    def _process_coverage_derivative_reclamation(
        self, reclamation_id: UUID, message: QueueMessage
    ) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim_coverage_derivative_reclamation(
            reclamation_id, worker_token, self._settings.lease_seconds
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.reclamation_id is not None
        assert claim.target is not None
        delete_started = claim.delete_started_at is not None
        try:
            with LeaseMaintainer(
                heartbeat=self._repository.heartbeat_coverage_derivative_reclamation,
                queue=self._queue,
                message=message,
                job_id=claim.reclamation_id,
                worker_token=worker_token,
                lease_seconds=self._settings.lease_seconds,
                heartbeat_seconds=self._settings.heartbeat_seconds,
                visibility_seconds=self._settings.visibility_seconds,
            ) as lease:
                if not delete_started:
                    self._storage.verify_coverage_derivative_reclamation(claim.target)
                    lease.assert_active()
                    if not self._repository.start_coverage_derivative_delete(
                        claim.reclamation_id, worker_token
                    ):
                        raise LeaseLost
                    delete_started = True
                self._storage.delete_coverage_derivative_reclamation(
                    claim.target,
                    allow_missing=claim.delete_started_at is not None,
                )
                lease.renew_now()
                if not self._repository.complete_coverage_derivative_reclamation(
                    claim.reclamation_id, worker_token
                ):
                    raise LeaseLost
        except ValidationFailure as error:
            if delete_started:
                state = self._repository.release_coverage_derivative_reclamation(
                    claim.reclamation_id,
                    worker_token,
                    error.code,
                    self._settings.max_attempts,
                )
                return "completed" if state == "failed" else "retry"
            if not self._repository.fail_coverage_derivative_reclamation(
                claim.reclamation_id, worker_token, error.code
            ):
                return "retry"
            logger.info(
                "coverage derivative reclamation failed reclamation_id=%s error_code=%s",
                claim.reclamation_id,
                error.code,
            )
            return "completed"
        except LeaseLost:
            logger.warning(
                "coverage derivative reclamation lease lost reclamation_id=%s",
                claim.reclamation_id,
            )
            return "retry"
        except TransientFailure as error:
            state = self._repository.release_coverage_derivative_reclamation(
                claim.reclamation_id,
                worker_token,
                error.code,
                self._settings.max_attempts,
            )
            logger.warning(
                "transient coverage derivative reclamation failure "
                "reclamation_id=%s error_code=%s release_state=%s",
                claim.reclamation_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info(
            "coverage derivative reclamation completed reclamation_id=%s",
            claim.reclamation_id,
        )
        return "completed"

    def _process_tile_cache_reclamation(
        self, reclamation_id: UUID, message: QueueMessage
    ) -> ProcessOutcome:
        worker_token = uuid4()
        claim = self._repository.claim_tile_cache_reclamation(
            reclamation_id, worker_token, self._settings.lease_seconds
        )
        if claim.status == "not_ready":
            self._queue.change_visibility(message.receipt_handle, 30)
            return "retry"
        if claim.status != "claimed":
            return "completed"
        claim.require_claimed()
        assert claim.reclamation_id is not None
        try:
            with LeaseMaintainer(
                heartbeat=self._repository.heartbeat_tile_cache_reclamation,
                queue=self._queue,
                message=message,
                job_id=claim.reclamation_id,
                worker_token=worker_token,
                lease_seconds=self._settings.lease_seconds,
                heartbeat_seconds=self._settings.heartbeat_seconds,
                visibility_seconds=self._settings.visibility_seconds,
            ) as lease:
                for item in claim.targets:
                    delete_started = item.delete_started_at is not None
                    try:
                        if not delete_started:
                            self._storage.verify_render_cache_reclamation(item.target)
                            lease.assert_active()
                            if not self._repository.start_tile_cache_reclamation_item_delete(
                                claim.reclamation_id, item.position, worker_token
                            ):
                                raise LeaseLost
                            delete_started = True
                        self._storage.delete_render_cache_reclamation(
                            item.target,
                            allow_missing=item.delete_started_at is not None,
                        )
                        lease.renew_now()
                        if not self._repository.complete_tile_cache_reclamation_item(
                            claim.reclamation_id, item.position, worker_token
                        ):
                            raise LeaseLost
                    except ValidationFailure as error:
                        if delete_started:
                            state = self._repository.release_tile_cache_reclamation(
                                claim.reclamation_id,
                                worker_token,
                                error.code,
                                self._settings.max_attempts,
                            )
                            return "completed" if state == "failed" else "retry"
                        if not self._repository.fail_tile_cache_reclamation_item(
                            claim.reclamation_id,
                            item.position,
                            worker_token,
                            error.code,
                        ):
                            raise LeaseLost from error
                        logger.info(
                            "tile cache reclamation item failed reclamation_id=%s "
                            "position=%s error_code=%s",
                            claim.reclamation_id,
                            item.position,
                            error.code,
                        )
                lease.assert_active()
                state = self._repository.finish_tile_cache_reclamation(
                    claim.reclamation_id, worker_token
                )
                if state in {"not_ready", "lost"}:
                    raise LeaseLost
        except LeaseLost:
            logger.warning(
                "tile cache reclamation lease lost reclamation_id=%s",
                claim.reclamation_id,
            )
            return "retry"
        except TransientFailure as error:
            state = self._repository.release_tile_cache_reclamation(
                claim.reclamation_id,
                worker_token,
                error.code,
                self._settings.max_attempts,
            )
            logger.warning(
                "transient tile cache reclamation failure reclamation_id=%s "
                "error_code=%s release_state=%s",
                claim.reclamation_id,
                error.code,
                state,
            )
            return "completed" if state == "failed" else "retry"
        logger.info(
            "tile cache reclamation finished reclamation_id=%s",
            claim.reclamation_id,
        )
        return "completed"

    def _prepare_workspace_root(self) -> None:
        root = self._settings.workspace_root
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.is_symlink() or not root.is_dir():
            raise TransientFailure("workspace_unavailable")
        root.chmod(0o700)


def _pmtiles_source_filename(reference: ObjectReference) -> str | None:
    if "/derivatives/working/" in reference.object_key:
        filename = PurePosixPath(reference.object_key).name
        if (
            reference.content_type != "application/vnd.apache.parquet"
            or re.fullmatch(r"layer-[0-9]{3}\.parquet", filename) is None
        ):
            return None
        return filename
    return _PMTILES_SOURCE_FILENAMES.get(reference.content_type)


class LeaseMaintainer:
    def __init__(
        self,
        *,
        heartbeat: Callable[[UUID, UUID, int], bool],
        queue: QueueClient,
        message: QueueMessage,
        job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
        heartbeat_seconds: int,
        visibility_seconds: int,
    ) -> None:
        self._heartbeat = heartbeat
        self._queue = queue
        self._message = message
        self._job_id = job_id
        self._worker_token = worker_token
        self._lease_seconds = lease_seconds
        self._heartbeat_seconds = heartbeat_seconds
        self._visibility_seconds = visibility_seconds
        self._stop = threading.Event()
        self._lost = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"lease-{self._job_id}",
            daemon=True,
        )

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self._stop.set()
        self._thread.join(timeout=5)

    def assert_active(self) -> None:
        if self._lost.is_set():
            raise LeaseLost

    def renew_now(self) -> None:
        try:
            active = self._heartbeat(self._job_id, self._worker_token, self._lease_seconds)
        except TransientFailure:
            self._lost.set()
            raise LeaseLost from None
        if not active:
            self._lost.set()
            raise LeaseLost
        try:
            self._queue.change_visibility(self._message.receipt_handle, self._visibility_seconds)
        except TransientFailure:
            logger.warning("queue visibility renewal failed job_id=%s", self._job_id)

    def _run(self) -> None:
        while not self._stop.wait(self._heartbeat_seconds):
            try:
                self.renew_now()
            except LeaseLost:
                return
