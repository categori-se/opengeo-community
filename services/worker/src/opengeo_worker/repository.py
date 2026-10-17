import json
import math
from collections.abc import Mapping, Sequence
from typing import Any, cast
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from opengeo_worker.config import Settings
from opengeo_worker.models import (
    CoverageDerivativeClaim,
    CoverageDerivativeMetadata,
    CoverageDerivativeReclamationClaim,
    InspectionResult,
    JobClaim,
    ObjectReference,
    PmtilesDerivativeClaim,
    RenderClaim,
    RenderLayerClaim,
    StoredArtifact,
    TileCacheReclamationClaim,
    TileCacheReclamationTarget,
    TransientFailure,
)


class WorkerRepository:
    """Function-only database adapter for the opengeo_worker role."""

    def __init__(self, settings: Settings, *, pmtiles_profile: str = "v1") -> None:
        if pmtiles_profile not in {"v1", "v2"}:
            raise ValueError("Unknown PMTiles worker profile")
        self._pmtiles_profile = pmtiles_profile
        self._connection_options = settings.database_connection_kwargs()
        self._statement_timeout_ms = settings.statement_timeout_seconds * 1000

    def claim(
        self,
        bucket: str,
        key: str,
        version_id: str,
        worker_token: UUID,
        lease_seconds: int,
    ) -> JobClaim:
        row = self._fetch_one(
            "SELECT * FROM app.claim_dataset_ingest(%s, %s, %s, %s, %s)",
            (bucket, key, version_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_claim_empty")
        return JobClaim(
            status=cast(Any, row[0]),
            job_id=row[1],
            organization_id=row[2],
            project_id=row[3],
            dataset_id=row[4],
            dataset_version_id=row[5],
            original_object_id=row[6],
            original_filename=row[7],
            dataset_format=cast(Any, row[8]),
            content_type=row[9],
            size_bytes=row[10],
            checksum_sha256=row[11],
            attempt_count=row[12],
            output_prefix=row[13],
        )

    def heartbeat(self, job_id: UUID, worker_token: UUID, lease_seconds: int) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_dataset_ingest(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def complete(
        self,
        job_id: UUID,
        worker_token: UUID,
        inspection: InspectionResult,
        artifacts: Sequence[StoredArtifact],
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.complete_dataset_ingest(%s, %s, %s, %s)",
            (
                job_id,
                worker_token,
                Jsonb(inspection.metadata_record()),
                Jsonb([artifact.as_record() for artifact in artifacts]),
            ),
        )
        return bool(row and row[0])

    def fail(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        quality_results: Mapping[str, object],
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_dataset_ingest(%s, %s, %s, %s)",
            (job_id, worker_token, error_code, Jsonb(dict(quality_results))),
        )
        return bool(row and row[0])

    def release(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str:
        row = self._fetch_one(
            "SELECT app.release_dataset_ingest(%s, %s, %s, %s)",
            (job_id, worker_token, error_code, max_attempts),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_release_invalid")
        return str(row[0])

    def claim_render(
        self,
        job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> RenderClaim:
        row = self._fetch_one(
            "SELECT * FROM app.claim_map_render(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_render_claim_empty")
        source = None
        if row[7] is not None:
            source = ObjectReference(
                object_id=row[7],
                bucket=row[8],
                object_key=row[9],
                s3_version_id=row[10],
                etag=row[11],
                content_type=row[12],
                size_bytes=row[13],
                checksum_sha256=row[14],
            )
        bbox = None
        if row[21] is not None:
            bbox = tuple(float(value) for value in row[21])
            if len(bbox) != 4:
                raise TransientFailure("database_render_claim_invalid")
        configuration = dict(row[19]) if row[19] is not None else None
        background_color = None
        transparent = False
        if row[0] == "claimed":
            presentation = self._fetch_one(
                "SELECT * FROM app.get_map_render_presentation(%s, %s)",
                (job_id, worker_token),
            )
            if presentation is None:
                raise TransientFailure("database_render_presentation_invalid")
            background_color = presentation[0]
            transparent = bool(presentation[1])
        layers: tuple[RenderLayerClaim, ...] = ()
        if row[0] == "claimed":
            layer_rows = self._fetch_all(
                "SELECT * FROM app.get_map_render_layers(%s, %s)",
                (job_id, worker_token),
            )
            layers = tuple(self._render_layer(layer_row) for layer_row in layer_rows)
            if not layers or tuple(layer.position for layer in layers) != tuple(
                range(1, len(layers) + 1)
            ):
                raise TransientFailure("database_render_layers_invalid")
        return RenderClaim(
            status=cast(Any, row[0]),
            job_id=row[1],
            organization_id=row[2],
            project_id=row[3],
            resource_id=row[4],
            dataset_id=row[5],
            dataset_version_id=row[6],
            source=source,
            profile_id=row[15],
            profile_version_id=row[16],
            style_id=row[17],
            style_version_id=row[18],
            configuration=configuration,
            configuration_checksum_sha256=row[20],
            bbox=cast(tuple[float, float, float, float] | None, bbox),
            crs=cast(Any, row[22]),
            width=row[23],
            height=row[24],
            format=cast(Any, row[25]),
            background_color=background_color,
            transparent=transparent,
            request_checksum_sha256=row[26],
            attempt_count=row[27],
            output_prefix=row[28],
            layers=layers,
        )

    @staticmethod
    def _render_layer(row: tuple[Any, ...]) -> RenderLayerClaim:
        if len(row) != 18 or row[4] is None or row[16] is None:
            raise TransientFailure("database_render_layers_invalid")
        source = ObjectReference(
            object_id=row[4],
            bucket=row[5],
            object_key=row[6],
            s3_version_id=row[7],
            etag=row[8],
            content_type=row[9],
            size_bytes=row[10],
            checksum_sha256=row[11],
        )
        return RenderLayerClaim(
            position=row[0],
            resource_id=row[1],
            dataset_id=row[2],
            dataset_version_id=row[3],
            source=source,
            profile_id=row[12],
            profile_version_id=row[13],
            style_id=row[14],
            style_version_id=row[15],
            configuration=dict(row[16]),
            configuration_checksum_sha256=row[17],
        )

    def heartbeat_render(self, job_id: UUID, worker_token: UUID, lease_seconds: int) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_map_render(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def complete_render(self, job_id: UUID, worker_token: UUID, artifact: StoredArtifact) -> bool:
        row = self._fetch_one(
            "SELECT app.complete_map_render(%s, %s, %s)",
            (job_id, worker_token, Jsonb(artifact.as_record())),
        )
        return bool(row and row[0])

    def fail_render(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_map_render(%s, %s, %s)",
            (job_id, worker_token, error_code),
        )
        return bool(row and row[0])

    def release_render(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str:
        row = self._fetch_one(
            "SELECT app.release_map_render(%s, %s, %s, %s)",
            (job_id, worker_token, error_code, max_attempts),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_render_release_invalid")
        return str(row[0])

    def claim_coverage_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> CoverageDerivativeClaim:
        row = self._fetch_one(
            "SELECT * FROM app.claim_spatial_coverage_derivative(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_coverage_derivative_claim_empty")
        source = None
        if row[8] is not None:
            source = ObjectReference(
                object_id=row[8],
                bucket=row[9],
                object_key=row[10],
                s3_version_id=row[11],
                etag=row[12],
                content_type=row[13],
                size_bytes=row[14],
                checksum_sha256=row[15],
            )
        source_extent = self._extent(row[17])
        subset_extent = self._extent(row[26])
        bands = None
        if row[21] is not None:
            if not isinstance(row[21], list) or not all(isinstance(band, dict) for band in row[21]):
                raise TransientFailure("database_coverage_derivative_claim_invalid")
            bands = tuple(dict(band) for band in row[21])
        band_indexes = None
        if row[23] is not None:
            if not isinstance(row[23], list) or not all(
                isinstance(value, int) for value in row[23]
            ):
                raise TransientFailure("database_coverage_derivative_claim_invalid")
            band_indexes = tuple(cast(list[int], row[23]))
        requested_resolution = self._resolution(row[25])
        return CoverageDerivativeClaim(
            status=cast(Any, row[0]),
            job_id=row[1],
            organization_id=row[2],
            project_id=row[3],
            service_id=row[4],
            coverage_id=row[5],
            dataset_id=row[6],
            dataset_version_id=row[7],
            source=source,
            source_crs=row[16],
            source_extent=source_extent,
            source_width=row[18],
            source_height=row[19],
            source_band_count=row[20],
            source_bands=bands,
            request_schema_version=row[22],
            band_indexes=band_indexes,
            scale_mode=row[24],
            requested_resolution=requested_resolution,
            subset_extent=subset_extent,
            target_crs=row[27],
            target_width=row[28],
            target_height=row[29],
            resampling=cast(Any, row[30]),
            request_checksum_sha256=row[31],
            attempt_count=row[32],
            output_prefix=row[33],
        )

    @staticmethod
    def _extent(value: object) -> tuple[float, float, float, float] | None:
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or len(value) != 4
            or not all(isinstance(coordinate, (int, float)) for coordinate in value)
        ):
            raise TransientFailure("database_coverage_derivative_claim_invalid")
        return cast(
            tuple[float, float, float, float], tuple(float(coordinate) for coordinate in value)
        )

    @staticmethod
    def _resolution(value: object) -> tuple[float, float] | None:
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or len(value) != 2
            or not all(isinstance(coordinate, (int, float)) for coordinate in value)
        ):
            raise TransientFailure("database_coverage_derivative_claim_invalid")
        return cast(tuple[float, float], tuple(float(coordinate) for coordinate in value))

    def heartbeat_coverage_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_spatial_coverage_derivative(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def complete_coverage_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        artifact: StoredArtifact,
        metadata: CoverageDerivativeMetadata,
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.complete_spatial_coverage_derivative(%s, %s, %s, %s)",
            (
                job_id,
                worker_token,
                Jsonb(artifact.as_record()),
                Jsonb(metadata.as_record()),
            ),
        )
        return bool(row and row[0])

    def fail_coverage_derivative(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_spatial_coverage_derivative(%s, %s, %s)",
            (job_id, worker_token, error_code),
        )
        return bool(row and row[0])

    def release_coverage_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str:
        row = self._fetch_one(
            "SELECT app.release_spatial_coverage_derivative(%s, %s, %s, %s)",
            (job_id, worker_token, error_code, max_attempts),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_coverage_derivative_release_invalid")
        return str(row[0])

    def claim_pmtiles_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> PmtilesDerivativeClaim:
        configurable = getattr(self, "_pmtiles_profile", "v1") == "v2"
        statement = (
            "SELECT * FROM app.claim_pmtiles_derivative_v2(%s, %s, %s)"
            if configurable
            else "SELECT * FROM app.claim_pmtiles_derivative(%s, %s, %s)"
        )
        row = self._fetch_one(
            statement,
            (job_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_pmtiles_derivative_claim_empty")
        if len(row) != (23 if configurable else 21):
            raise TransientFailure("database_pmtiles_derivative_claim_invalid")
        source = None
        if row[6] is not None:
            source = ObjectReference(
                object_id=row[6],
                bucket=row[7],
                object_key=row[8],
                s3_version_id=row[9],
                etag=row[10],
                content_type=row[11],
                size_bytes=row[12],
                checksum_sha256=row[13],
            )
        bounds = self._pmtiles_bounds(row[14])
        if row[0] == "claimed" and (
            source is None
            or bounds is None
            or not isinstance(row[15], int)
            or isinstance(row[15], bool)
            or not isinstance(row[16], int)
            or isinstance(row[16], bool)
            or not isinstance(row[17], str)
            or not isinstance(row[18], str)
            or not isinstance(row[19], int)
            or isinstance(row[19], bool)
            or not isinstance(row[20], str)
        ):
            raise TransientFailure("database_pmtiles_derivative_claim_invalid")
        return PmtilesDerivativeClaim(
            status=cast(Any, row[0]),
            job_id=row[1],
            organization_id=row[2],
            project_id=row[3],
            dataset_id=row[4],
            dataset_version_id=row[5],
            source=source,
            bounds=bounds,
            minimum_zoom=row[15],
            maximum_zoom=row[16],
            source_layer=row[17],
            request_checksum_sha256=row[18],
            attempt_count=row[19],
            output_object_key=row[20],
            options=row[21] if configurable else None,
            worker_image_digest=row[22] if configurable else None,
        )

    @staticmethod
    def _pmtiles_bounds(value: object) -> tuple[float, float, float, float] | None:
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or len(value) != 4
            or not all(
                isinstance(coordinate, (int, float))
                and not isinstance(coordinate, bool)
                and math.isfinite(coordinate)
                for coordinate in value
            )
        ):
            raise TransientFailure("database_pmtiles_derivative_claim_invalid")
        return cast(
            tuple[float, float, float, float], tuple(float(coordinate) for coordinate in value)
        )

    def heartbeat_pmtiles_derivative(
        self, job_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_pmtiles_derivative(%s, %s, %s)",
            (job_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def complete_pmtiles_derivative(
        self,
        job_id: UUID,
        worker_token: UUID,
        artifact: StoredArtifact,
        validation: dict[str, object] | None = None,
    ) -> bool:
        if validation is not None:
            row = self._fetch_one(
                "SELECT app.complete_pmtiles_derivative(%s, %s, %s, %s)",
                (job_id, worker_token, Jsonb(artifact.as_record()), Jsonb(validation)),
            )
            return bool(row and row[0])
        row = self._fetch_one(
            "SELECT app.complete_pmtiles_derivative(%s, %s, %s)",
            (job_id, worker_token, Jsonb(artifact.as_record())),
        )
        return bool(row and row[0])

    def fail_pmtiles_derivative(self, job_id: UUID, worker_token: UUID, error_code: str) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_pmtiles_derivative(%s, %s, %s)",
            (job_id, worker_token, error_code),
        )
        return bool(row and row[0])

    def release_pmtiles_derivative(self, job_id: UUID, worker_token: UUID, error_code: str) -> str:
        row = self._fetch_one(
            "SELECT app.release_pmtiles_derivative(%s, %s, %s)",
            (job_id, worker_token, error_code),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_pmtiles_derivative_release_invalid")
        return str(row[0])

    def claim_coverage_derivative_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> CoverageDerivativeReclamationClaim:
        row = self._fetch_one(
            "SELECT * FROM app.claim_spatial_coverage_derivative_reclamation(%s, %s, %s)",
            (reclamation_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_coverage_reclamation_claim_empty")
        target = None
        if row[3] is not None:
            target = ObjectReference(
                object_id=row[3],
                bucket=row[4],
                object_key=row[5],
                s3_version_id=row[6],
                etag=row[7],
                content_type=row[8],
                size_bytes=row[9],
                checksum_sha256=row[10],
            )
        return CoverageDerivativeReclamationClaim(
            status=cast(Any, row[0]),
            reclamation_id=row[1],
            derivative_job_id=row[2],
            target=target,
            delete_started_at=row[11],
            attempt_count=row[12],
        )

    def heartbeat_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_spatial_coverage_derivative_reclamation(%s, %s, %s)",
            (reclamation_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def start_coverage_derivative_delete(self, reclamation_id: UUID, worker_token: UUID) -> bool:
        row = self._fetch_one(
            "SELECT app.start_spatial_coverage_derivative_delete(%s, %s)",
            (reclamation_id, worker_token),
        )
        return bool(row and row[0])

    def complete_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.complete_spatial_coverage_derivative_reclamation(%s, %s)",
            (reclamation_id, worker_token),
        )
        return bool(row and row[0])

    def fail_coverage_derivative_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, error_code: str
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_spatial_coverage_derivative_reclamation(%s, %s, %s)",
            (reclamation_id, worker_token, error_code),
        )
        return bool(row and row[0])

    def release_coverage_derivative_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str:
        row = self._fetch_one(
            "SELECT app.release_spatial_coverage_derivative_reclamation(%s, %s, %s, %s)",
            (reclamation_id, worker_token, error_code, max_attempts),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_coverage_reclamation_release_invalid")
        return str(row[0])

    def claim_tile_cache_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        lease_seconds: int,
    ) -> TileCacheReclamationClaim:
        row = self._fetch_one(
            "SELECT * FROM app.claim_spatial_tile_cache_reclamation(%s, %s, %s)",
            (reclamation_id, worker_token, lease_seconds),
        )
        if row is None:
            raise TransientFailure("database_tile_cache_reclamation_claim_empty")
        targets: tuple[TileCacheReclamationTarget, ...] = ()
        if row[0] == "claimed":
            target_rows = self._fetch_all(
                "SELECT * FROM app.get_spatial_tile_cache_reclamation_targets(%s, %s)",
                (reclamation_id, worker_token),
            )
            targets = tuple(
                TileCacheReclamationTarget(
                    position=target[0],
                    render_job_id=target[1],
                    target=ObjectReference(
                        object_id=target[2],
                        bucket=target[3],
                        object_key=target[4],
                        s3_version_id=target[5],
                        etag=target[6],
                        content_type=target[7],
                        size_bytes=target[8],
                        checksum_sha256=target[9],
                    ),
                    delete_started_at=target[10],
                )
                for target in target_rows
            )
        return TileCacheReclamationClaim(
            status=cast(Any, row[0]),
            reclamation_id=row[1],
            target_count=row[2],
            target_size_bytes=row[3],
            attempt_count=row[4],
            targets=targets,
        )

    def heartbeat_tile_cache_reclamation(
        self, reclamation_id: UUID, worker_token: UUID, lease_seconds: int
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.heartbeat_spatial_tile_cache_reclamation(%s, %s, %s)",
            (reclamation_id, worker_token, lease_seconds),
        )
        return bool(row and row[0])

    def start_tile_cache_reclamation_item_delete(
        self, reclamation_id: UUID, position: int, worker_token: UUID
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.start_spatial_tile_cache_reclamation_item_delete(%s, %s, %s)",
            (reclamation_id, position, worker_token),
        )
        return bool(row and row[0])

    def complete_tile_cache_reclamation_item(
        self, reclamation_id: UUID, position: int, worker_token: UUID
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.complete_spatial_tile_cache_reclamation_item(%s, %s, %s)",
            (reclamation_id, position, worker_token),
        )
        return bool(row and row[0])

    def fail_tile_cache_reclamation_item(
        self,
        reclamation_id: UUID,
        position: int,
        worker_token: UUID,
        error_code: str,
    ) -> bool:
        row = self._fetch_one(
            "SELECT app.fail_spatial_tile_cache_reclamation_item(%s, %s, %s, %s)",
            (reclamation_id, position, worker_token, error_code),
        )
        return bool(row and row[0])

    def finish_tile_cache_reclamation(self, reclamation_id: UUID, worker_token: UUID) -> str:
        row = self._fetch_one(
            "SELECT app.finish_spatial_tile_cache_reclamation(%s, %s)",
            (reclamation_id, worker_token),
        )
        if row is None or row[0] not in {"completed", "failed", "not_ready", "lost"}:
            raise TransientFailure("database_tile_cache_reclamation_finish_invalid")
        return str(row[0])

    def release_tile_cache_reclamation(
        self,
        reclamation_id: UUID,
        worker_token: UUID,
        error_code: str,
        max_attempts: int,
    ) -> str:
        row = self._fetch_one(
            "SELECT app.release_spatial_tile_cache_reclamation(%s, %s, %s, %s)",
            (reclamation_id, worker_token, error_code, max_attempts),
        )
        if row is None or row[0] not in {"queued", "failed", "lost"}:
            raise TransientFailure("database_tile_cache_reclamation_release_invalid")
        return str(row[0])

    def _fetch_one(self, statement: str, parameters: Sequence[object]) -> tuple[Any, ...] | None:
        try:
            with (
                psycopg.connect(**self._connection_options) as connection,
                connection.cursor() as cursor,
            ):
                cursor.execute(
                    "SELECT set_config('statement_timeout', %s, true)",
                    (str(self._statement_timeout_ms),),
                )
                cursor.execute(statement, tuple(parameters))
                return cursor.fetchone()
        except psycopg.Error as error:
            raise TransientFailure("database_unavailable") from error

    def _fetch_all(self, statement: str, parameters: Sequence[object]) -> list[tuple[Any, ...]]:
        try:
            with (
                psycopg.connect(**self._connection_options) as connection,
                connection.cursor() as cursor,
            ):
                cursor.execute(
                    "SELECT set_config('statement_timeout', %s, true)",
                    (str(self._statement_timeout_ms),),
                )
                cursor.execute(statement, tuple(parameters))
                return list(cursor.fetchall())
        except psycopg.Error as error:
            raise TransientFailure("database_unavailable") from error


def bounded_json(value: Mapping[str, object], maximum_bytes: int) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode()) > maximum_bytes:
        raise ValueError("JSON exceeds worker boundary")
    return encoded
