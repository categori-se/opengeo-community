from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

DatasetFormat = Literal[
    "kml",
    "geojson",
    "csv",
    "shapefile",
    "geopackage",
    "geoparquet",
    "cog",
    "pmtiles",
    "png",
    "jpeg",
    "pdf",
    "odt",
]
ArtifactRole = Literal["working", "tile", "derived", "thumbnail"]
ClaimStatus = Literal[
    "claimed",
    "not_ready",
    "busy",
    "already_completed",
    "already_failed",
    "already_cancelled",
]
RenderFormat = Literal["svg", "png"]
RenderCrs = Literal["CRS:84", "EPSG:3857"]
CoverageResampling = Literal["nearest", "bilinear", "cubic"]


@dataclass(frozen=True, slots=True)
class QueueMessage:
    message_id: str
    receipt_handle: str
    body: str
    receive_count: int


@dataclass(frozen=True, slots=True)
class S3ObjectEvent:
    bucket: str
    key: str
    version_id: str
    size_bytes: int
    etag: str
    sequencer: str


@dataclass(frozen=True, slots=True)
class RenderCommand:
    render_job_id: UUID


@dataclass(frozen=True, slots=True)
class CoverageDerivativeCommand:
    coverage_derivative_job_id: UUID


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeCommand:
    pmtiles_derivative_job_id: UUID


@dataclass(frozen=True, slots=True)
class CoverageDerivativeReclamationCommand:
    coverage_derivative_reclamation_id: UUID


@dataclass(frozen=True, slots=True)
class TileCacheReclamationCommand:
    render_cache_reclamation_id: UUID


@dataclass(frozen=True, slots=True)
class ObjectReference:
    object_id: UUID
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class CoverageDerivativeReclamationClaim:
    status: ClaimStatus
    reclamation_id: UUID | None = None
    derivative_job_id: UUID | None = None
    target: ObjectReference | None = None
    delete_started_at: datetime | None = None
    attempt_count: int | None = None

    def require_claimed(self) -> "CoverageDerivativeReclamationClaim":
        if self.status != "claimed" or any(
            value is None
            for value in (
                self.reclamation_id,
                self.derivative_job_id,
                self.target,
                self.attempt_count,
            )
        ):
            raise ValueError("coverage derivative reclamation claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class TileCacheReclamationTarget:
    position: int
    render_job_id: UUID
    target: ObjectReference
    delete_started_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class TileCacheReclamationClaim:
    status: ClaimStatus
    reclamation_id: UUID | None = None
    target_count: int | None = None
    target_size_bytes: int | None = None
    attempt_count: int | None = None
    targets: tuple[TileCacheReclamationTarget, ...] = ()

    def require_claimed(self) -> "TileCacheReclamationClaim":
        if (
            self.status != "claimed"
            or self.reclamation_id is None
            or self.target_count is None
            or self.target_size_bytes is None
            or self.attempt_count is None
            or not self.targets
            or len(self.targets) > 64
        ):
            raise ValueError("tile cache reclamation claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class RenderLayerClaim:
    position: int
    resource_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    source: ObjectReference
    profile_id: UUID
    profile_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    configuration: dict[str, object]
    configuration_checksum_sha256: str


@dataclass(frozen=True, slots=True)
class JobClaim:
    status: ClaimStatus
    job_id: UUID | None = None
    organization_id: UUID | None = None
    project_id: UUID | None = None
    dataset_id: UUID | None = None
    dataset_version_id: UUID | None = None
    original_object_id: UUID | None = None
    original_filename: str | None = None
    dataset_format: DatasetFormat | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    checksum_sha256: str | None = None
    attempt_count: int | None = None
    output_prefix: str | None = None

    def require_claimed(self) -> "JobClaim":
        if self.status != "claimed" or any(
            value is None
            for value in (
                self.job_id,
                self.organization_id,
                self.project_id,
                self.dataset_id,
                self.dataset_version_id,
                self.original_object_id,
                self.original_filename,
                self.dataset_format,
                self.content_type,
                self.size_bytes,
                self.checksum_sha256,
                self.attempt_count,
                self.output_prefix,
            )
        ):
            raise ValueError("job claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class RenderClaim:
    status: ClaimStatus
    job_id: UUID | None = None
    organization_id: UUID | None = None
    project_id: UUID | None = None
    resource_id: UUID | None = None
    dataset_id: UUID | None = None
    dataset_version_id: UUID | None = None
    source: ObjectReference | None = None
    profile_id: UUID | None = None
    profile_version_id: UUID | None = None
    style_id: UUID | None = None
    style_version_id: UUID | None = None
    configuration: dict[str, object] | None = None
    configuration_checksum_sha256: str | None = None
    bbox: tuple[float, float, float, float] | None = None
    crs: RenderCrs | None = None
    width: int | None = None
    height: int | None = None
    format: RenderFormat | None = None
    background_color: str | None = None
    transparent: bool = False
    request_checksum_sha256: str | None = None
    attempt_count: int | None = None
    output_prefix: str | None = None
    layers: tuple[RenderLayerClaim, ...] = ()

    def require_claimed(self) -> "RenderClaim":
        if self.status != "claimed" or any(
            value is None
            for value in (
                self.job_id,
                self.organization_id,
                self.project_id,
                self.resource_id,
                self.dataset_id,
                self.dataset_version_id,
                self.source,
                self.profile_id,
                self.profile_version_id,
                self.style_id,
                self.style_version_id,
                self.configuration,
                self.configuration_checksum_sha256,
                self.bbox,
                self.crs,
                self.width,
                self.height,
                self.format,
                self.request_checksum_sha256,
                self.attempt_count,
                self.output_prefix,
            )
        ):
            raise ValueError("render claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class CoverageDerivativeClaim:
    status: ClaimStatus
    job_id: UUID | None = None
    organization_id: UUID | None = None
    project_id: UUID | None = None
    service_id: UUID | None = None
    coverage_id: UUID | None = None
    dataset_id: UUID | None = None
    dataset_version_id: UUID | None = None
    source: ObjectReference | None = None
    source_crs: str | None = None
    source_extent: tuple[float, float, float, float] | None = None
    source_width: int | None = None
    source_height: int | None = None
    source_band_count: int | None = None
    source_bands: tuple[dict[str, object], ...] | None = None
    request_schema_version: int | None = None
    band_indexes: tuple[int, ...] | None = None
    scale_mode: str | None = None
    requested_resolution: tuple[float, float] | None = None
    subset_extent: tuple[float, float, float, float] | None = None
    target_crs: str | None = None
    target_width: int | None = None
    target_height: int | None = None
    resampling: CoverageResampling | None = None
    request_checksum_sha256: str | None = None
    attempt_count: int | None = None
    output_prefix: str | None = None

    def require_claimed(self) -> "CoverageDerivativeClaim":
        if self.status != "claimed" or any(
            value is None
            for value in (
                self.job_id,
                self.organization_id,
                self.project_id,
                self.service_id,
                self.coverage_id,
                self.dataset_id,
                self.dataset_version_id,
                self.source,
                self.source_crs,
                self.source_extent,
                self.source_width,
                self.source_height,
                self.source_band_count,
                self.source_bands,
                self.request_schema_version,
                self.band_indexes,
                self.scale_mode,
                self.subset_extent,
                self.target_crs,
                self.target_width,
                self.target_height,
                self.resampling,
                self.request_checksum_sha256,
                self.attempt_count,
                self.output_prefix,
            )
        ):
            raise ValueError("coverage derivative claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeClaim:
    status: ClaimStatus
    job_id: UUID | None = None
    organization_id: UUID | None = None
    project_id: UUID | None = None
    dataset_id: UUID | None = None
    dataset_version_id: UUID | None = None
    source: ObjectReference | None = None
    bounds: tuple[float, float, float, float] | None = None
    minimum_zoom: int | None = None
    maximum_zoom: int | None = None
    source_layer: str | None = None
    request_checksum_sha256: str | None = None
    attempt_count: int | None = None
    output_object_key: str | None = None
    options: dict[str, Any] | None = None
    worker_image_digest: str | None = None

    def require_claimed(self) -> "PmtilesDerivativeClaim":
        if self.status != "claimed" or any(
            value is None
            for value in (
                self.job_id,
                self.organization_id,
                self.project_id,
                self.dataset_id,
                self.dataset_version_id,
                self.source,
                self.bounds,
                self.minimum_zoom,
                self.maximum_zoom,
                self.source_layer,
                self.request_checksum_sha256,
                self.attempt_count,
                self.output_object_key,
            )
        ):
            raise ValueError("PMTiles derivative claim is incomplete")
        return self


@dataclass(frozen=True, slots=True)
class PmtilesDerivativeMetadata:
    layer_name: str
    feature_count: int
    minimum_zoom: int
    maximum_zoom: int
    crs: str = "EPSG:3857"
    geometry_type: str | None = None
    software: dict[str, Any] | None = None
    input_layer: str | None = None


@dataclass(frozen=True, slots=True)
class CoverageDerivativeMetadata:
    crs: str
    extent: tuple[float, float, float, float]
    width: int
    height: int
    band_count: int
    bands: tuple[dict[str, object], ...]
    cog_layout_verified: bool = True

    def as_record(self) -> dict[str, object]:
        return {
            "crs": self.crs,
            "extent": list(self.extent),
            "width": self.width,
            "height": self.height,
            "band_count": self.band_count,
            "bands": list(self.bands),
            "cog_layout_verified": self.cog_layout_verified,
        }


@dataclass(frozen=True, slots=True)
class ArtifactFile:
    role: ArtifactRole
    relative_key: str
    content_type: str
    path: Path


@dataclass(frozen=True, slots=True)
class StoredArtifact:
    artifact_id: UUID
    role: ArtifactRole
    bucket: str
    object_key: str
    s3_version_id: str
    etag: str
    content_type: str
    size_bytes: int
    checksum_sha256: str

    def as_record(self) -> dict[str, object]:
        return {
            "id": str(self.artifact_id),
            "role": self.role,
            "bucket": self.bucket,
            "object_key": self.object_key,
            "s3_version_id": self.s3_version_id,
            "etag": self.etag,
            "content_type": self.content_type,
            "size_bytes": self.size_bytes,
            "checksum_sha256": self.checksum_sha256,
        }


@dataclass(frozen=True, slots=True)
class InspectionResult:
    feature_count: int | None
    extent: tuple[float, float, float, float] | None
    crs: str | None
    geometry_type: str | None
    schema_definition: dict[str, object]
    quality_results: dict[str, object]
    artifacts: tuple[ArtifactFile, ...]

    def metadata_record(self) -> dict[str, object]:
        return {
            "feature_count": self.feature_count,
            "extent": list(self.extent) if self.extent is not None else None,
            "crs": self.crs,
            "geometry_type": self.geometry_type,
            "schema_definition": self.schema_definition,
            "quality_results": self.quality_results,
        }


class WorkerError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class ValidationFailure(WorkerError):
    def __init__(self, code: str, *, quality_results: dict[str, object] | None = None) -> None:
        self.quality_results = quality_results or {
            "valid": False,
            "errors": [{"code": code}],
            "warnings": [],
        }
        super().__init__(code)


class TransientFailure(WorkerError):
    pass


class LeaseLost(TransientFailure):
    def __init__(self) -> None:
        super().__init__("processing_lease_lost")
