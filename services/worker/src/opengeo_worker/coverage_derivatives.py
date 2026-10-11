"""Bounded, deterministic raster subset/scale/reprojection to immutable COG."""

import hashlib
import json
import math
import re
from pathlib import Path
from typing import cast

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.config import Settings
from opengeo_worker.models import (
    CoverageDerivativeClaim,
    CoverageDerivativeMetadata,
    ValidationFailure,
)

MAX_DERIVATIVE_BYTES = 536_870_912


class CoverageDerivativeGenerator:
    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self._runner = runner or CommandRunner(
            settings.workspace_root,
            timeout_seconds=settings.command_timeout_seconds,
            output_bytes=settings.command_output_bytes,
        )

    def generate(
        self,
        source: Path,
        claim: CoverageDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> CoverageDerivativeMetadata:
        claim.require_claimed()
        assert claim.source_crs is not None
        assert claim.subset_extent is not None
        assert claim.target_crs is not None
        assert claim.target_width is not None
        assert claim.target_height is not None
        assert claim.source_band_count is not None
        assert claim.source_bands is not None
        assert claim.band_indexes is not None
        assert claim.request_schema_version is not None
        assert claim.scale_mode is not None
        assert claim.resampling is not None
        assert claim.request_checksum_sha256 is not None
        if (
            claim.request_schema_version not in {1, 2}
            or not claim.band_indexes
            or claim.band_indexes != tuple(sorted(set(claim.band_indexes)))
            or claim.band_indexes[0] < 1
            or claim.band_indexes[-1] > claim.source_band_count
            or (
                claim.request_schema_version == 1
                and claim.band_indexes != tuple(range(1, claim.source_band_count + 1))
            )
            or claim.scale_mode not in {"size", "resolution"}
            or (claim.scale_mode == "size" and claim.requested_resolution is not None)
            or (claim.scale_mode == "resolution" and claim.requested_resolution is None)
            or (
                claim.requested_resolution is not None
                and (
                    claim.target_crs != claim.source_crs
                    or not all(
                        math.isfinite(value) and 0 < value <= 1e100
                        for value in claim.requested_resolution
                    )
                )
            )
        ):
            raise ValidationFailure("coverage_derivative_request_invalid")
        request_document: dict[str, object] = {
            "height": claim.target_height,
            "resampling": claim.resampling,
            "subset": [format(value, ".15g") for value in claim.subset_extent],
            "target_crs": claim.target_crs,
            "width": claim.target_width,
        }
        if claim.request_schema_version == 2:
            request_document.update(
                {
                    "band_indexes": list(claim.band_indexes),
                    "resolution": (
                        None
                        if claim.requested_resolution is None
                        else [format(value, ".15g") for value in claim.requested_resolution]
                    ),
                    "scale_mode": claim.scale_mode,
                }
            )
        request_body = json.dumps(request_document, separators=(",", ":"), sort_keys=True).encode()
        if hashlib.sha256(request_body).hexdigest() != claim.request_checksum_sha256:
            raise ValidationFailure("coverage_derivative_request_checksum_mismatch")
        if target.exists() or not source.is_file() or source.stat().st_size < 1:
            raise ValidationFailure("coverage_derivative_workspace_invalid")
        west, south, east, north = claim.subset_extent
        band_arguments = [
            argument for index in claim.band_indexes for argument in ("-b", str(index))
        ]
        self._runner.run(
            "gdalwarp",
            [
                "-overwrite",
                "-if",
                "GTiff",
                "-of",
                "COG",
                *band_arguments,
                "-te",
                _number(west),
                _number(south),
                _number(east),
                _number(north),
                "-te_srs",
                claim.source_crs,
                "-t_srs",
                claim.target_crs,
                "-ts",
                str(claim.target_width),
                str(claim.target_height),
                "-r",
                claim.resampling,
                "-wo",
                "NUM_THREADS=1",
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "BIGTIFF=IF_SAFER",
                "-co",
                "NUM_THREADS=1",
                str(source),
                str(target),
            ],
            cwd=workdir,
            maximum_file_bytes=MAX_DERIVATIVE_BYTES,
        )
        if not target.is_file() or not 1 <= target.stat().st_size <= MAX_DERIVATIVE_BYTES:
            raise ValidationFailure("coverage_derivative_output_invalid")
        inspected = self._runner.run(
            "gdalinfo",
            ["-json", str(target)],
            cwd=workdir,
            maximum_file_bytes=MAX_DERIVATIVE_BYTES,
        )
        try:
            document = json.loads(inspected.stdout)
        except (ValueError, UnicodeError) as error:
            raise ValidationFailure("coverage_derivative_metadata_invalid") from error
        inspected_crs = self._runner.run(
            "gdalsrsinfo",
            ["-o", "epsg", str(target)],
            cwd=workdir,
            maximum_file_bytes=MAX_DERIVATIVE_BYTES,
        )
        crs = _epsg_identifier(inspected_crs.stdout)
        return self._metadata(document, claim, crs)

    @staticmethod
    def _metadata(
        document: object, claim: CoverageDerivativeClaim, crs: str
    ) -> CoverageDerivativeMetadata:
        assert claim.target_crs is not None
        assert claim.target_width is not None
        assert claim.target_height is not None
        assert claim.source_band_count is not None
        assert claim.source_bands is not None
        assert claim.band_indexes is not None
        if not isinstance(document, dict) or document.get("driverShortName") != "GTiff":
            raise ValidationFailure("coverage_derivative_metadata_invalid")
        metadata = document.get("metadata")
        image_structure = metadata.get("IMAGE_STRUCTURE") if isinstance(metadata, dict) else None
        size = document.get("size")
        bands = document.get("bands")
        geotransform = document.get("geoTransform")
        if (
            not isinstance(image_structure, dict)
            or image_structure.get("LAYOUT") != "COG"
            or size != [claim.target_width, claim.target_height]
            or not isinstance(bands, list)
            or len(bands) != len(claim.band_indexes)
            or len(claim.source_bands) != claim.source_band_count
            or not isinstance(geotransform, list)
            or len(geotransform) != 6
            or not all(
                isinstance(value, (int, float)) and math.isfinite(value) for value in geotransform
            )
            or float(geotransform[1]) <= 0
            or float(geotransform[5]) >= 0
            or abs(float(geotransform[2])) > 1e-12
            or abs(float(geotransform[4])) > 1e-12
        ):
            raise ValidationFailure("coverage_derivative_metadata_invalid")
        if crs != claim.target_crs:
            raise ValidationFailure("coverage_derivative_crs_mismatch")
        # gdalinfo's display-oriented cornerCoordinates are rounded. Derive
        # the sealed extent from the validated affine grid instead.
        transform = cast(list[float], geotransform)
        west, north = transform[0], transform[3]
        east = west + claim.target_width * transform[1]
        south = north + claim.target_height * transform[5]
        extent = (west, south, east, north)
        if not all(math.isfinite(value) for value in extent) or west >= east or south >= north:
            raise ValidationFailure("coverage_derivative_extent_invalid")
        output_bands: list[dict[str, object]] = []
        for fallback, (raw_band, source_index) in enumerate(
            zip(bands, claim.band_indexes, strict=True), 1
        ):
            if not isinstance(raw_band, dict):
                raise ValidationFailure("coverage_derivative_metadata_invalid")
            index = raw_band.get("band")
            data_type = raw_band.get("type")
            color = raw_band.get("colorInterpretation")
            if (
                not isinstance(index, int)
                or index != fallback
                or not isinstance(data_type, str)
                or len(data_type) > 50
                or (color is not None and (not isinstance(color, str) or len(color) > 100))
            ):
                raise ValidationFailure("coverage_derivative_metadata_invalid")
            source_band = claim.source_bands[source_index - 1]
            if source_band.get("data_type") != data_type:
                raise ValidationFailure("coverage_derivative_band_type_mismatch")
            output_bands.append(
                {
                    "index": index,
                    "source_index": source_index,
                    "data_type": data_type,
                    "color_interpretation": color,
                }
            )
        return CoverageDerivativeMetadata(
            crs=crs,
            extent=extent,
            width=claim.target_width,
            height=claim.target_height,
            band_count=len(output_bands),
            bands=tuple(output_bands),
        )


def _epsg_identifier(value: str) -> str:
    match = re.fullmatch(r"\s*EPSG:([1-9][0-9]{2,7})\s*", value)
    if match is None:
        raise ValidationFailure("coverage_derivative_crs_invalid")
    return f"EPSG:{match.group(1)}"


def _number(value: float) -> str:
    if not math.isfinite(value):
        raise ValidationFailure("coverage_derivative_extent_invalid")
    return format(value, ".15g")
