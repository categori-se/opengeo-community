"""No-egress conversion of one sealed managed vector object to PMTiles."""

import hashlib
import json
import math
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.config import Settings
from opengeo_worker.models import (
    PmtilesDerivativeClaim,
    PmtilesDerivativeMetadata,
    ValidationFailure,
)

MAX_PMTILES_BYTES = 2_147_483_648
PMTILES_DERIVATIVE_REQUEST_SCHEMA = "opengeo.pmtiles-derivative-request.1.0.0"
PMTILES_DERIVATIVE_RECIPE = "gdal-pmtiles-v1"
_PMTILES_MAGIC = b"PMTiles\x03"


class PmtilesDerivativeGenerator:
    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self._runner = runner or CommandRunner(
            settings.workspace_root,
            timeout_seconds=settings.command_timeout_seconds,
            output_bytes=settings.command_output_bytes,
        )

    def generate(
        self,
        source: Path,
        claim: PmtilesDerivativeClaim,
        target: Path,
        workdir: Path,
    ) -> PmtilesDerivativeMetadata:
        claim.require_claimed()
        assert claim.job_id is not None
        assert claim.organization_id is not None
        assert claim.project_id is not None
        assert claim.dataset_id is not None
        assert claim.dataset_version_id is not None
        assert claim.source is not None
        assert claim.bounds is not None
        assert claim.minimum_zoom is not None
        assert claim.maximum_zoom is not None
        assert claim.source_layer is not None
        assert claim.request_checksum_sha256 is not None
        assert claim.output_object_key is not None

        _validate_request(claim)
        if pmtiles_derivative_request_checksum(claim) != claim.request_checksum_sha256:
            raise ValidationFailure("pmtiles_derivative_request_checksum_mismatch")
        expected_key = (
            f"organizations/{claim.organization_id}/projects/{claim.project_id}/"
            f"datasets/{claim.dataset_id}/versions/{claim.dataset_version_id}/"
            f"derivatives/tiles/custom/{claim.job_id}.pmtiles"
        )
        if claim.output_object_key != expected_key:
            raise ValidationFailure("pmtiles_derivative_output_key_mismatch")

        resolved_workdir = workdir.resolve()
        resolved_source = source.resolve()
        resolved_target = target.resolve()
        if (
            target.exists()
            or source.is_symlink()
            or not source.is_file()
            or not 1 <= source.stat().st_size <= MAX_PMTILES_BYTES
            or not resolved_source.is_relative_to(resolved_workdir)
            or not resolved_target.is_relative_to(resolved_workdir)
        ):
            raise ValidationFailure("pmtiles_derivative_workspace_invalid")

        west, south, east, north = claim.bounds
        self._runner.run(
            "ogr2ogr",
            [
                "-f",
                "PMTiles",
                "-dsco",
                "NAME=OpenGeo custom PMTiles derivative",
                "-dsco",
                f"MINZOOM={claim.minimum_zoom}",
                "-dsco",
                f"MAXZOOM={claim.maximum_zoom}",
                "-lco",
                f"MINZOOM={claim.minimum_zoom}",
                "-lco",
                f"MAXZOOM={claim.maximum_zoom}",
                "-t_srs",
                "EPSG:3857",
                "-spat_srs",
                "EPSG:4326",
                "-spat",
                _number(west),
                _number(south),
                _number(east),
                _number(north),
                "-nln",
                claim.source_layer,
                str(target),
                str(source),
                claim.source_layer,
            ],
            cwd=workdir,
            maximum_file_bytes=MAX_PMTILES_BYTES,
        )
        if not target.is_file() or not 1 <= target.stat().st_size <= MAX_PMTILES_BYTES:
            raise ValidationFailure("pmtiles_derivative_output_invalid")
        with target.open("rb") as output:
            if output.read(len(_PMTILES_MAGIC)) != _PMTILES_MAGIC:
                raise ValidationFailure("pmtiles_derivative_output_invalid")

        inspected = self._runner.run(
            "ogrinfo",
            ["-ro", "-so", "-al", "-json", str(target)],
            cwd=workdir,
            maximum_file_bytes=MAX_PMTILES_BYTES,
        )
        try:
            document = json.loads(inspected.stdout)
        except (ValueError, UnicodeError) as error:
            raise ValidationFailure("pmtiles_derivative_metadata_invalid") from error
        return _metadata(document, claim)


def pmtiles_derivative_request_checksum(claim: PmtilesDerivativeClaim) -> str:
    return hashlib.sha256(pmtiles_derivative_request_canonical_bytes(claim)).hexdigest()


def pmtiles_derivative_request_canonical_bytes(claim: PmtilesDerivativeClaim) -> bytes:
    """Return the versioned, plain-decimal JSON sealed by the API."""
    claim.require_claimed()
    assert claim.project_id is not None
    assert claim.dataset_id is not None
    assert claim.dataset_version_id is not None
    assert claim.source is not None
    assert claim.bounds is not None
    assert claim.minimum_zoom is not None
    assert claim.maximum_zoom is not None
    assert claim.source_layer is not None
    request = {
        "schema": PMTILES_DERIVATIVE_REQUEST_SCHEMA,
        "recipe": PMTILES_DERIVATIVE_RECIPE,
        "bounds": list(claim.bounds),
        "dataset_id": str(claim.dataset_id),
        "dataset_version_id": str(claim.dataset_version_id),
        "maximum_zoom": claim.maximum_zoom,
        "minimum_zoom": claim.minimum_zoom,
        "project_id": str(claim.project_id),
        "source_layer": claim.source_layer,
        "source_object_id": str(claim.source.object_id),
    }
    return _canonical_json_bytes(request)


def _validate_request(claim: PmtilesDerivativeClaim) -> None:
    assert claim.bounds is not None
    assert claim.minimum_zoom is not None
    assert claim.maximum_zoom is not None
    assert claim.source_layer is not None
    assert claim.request_checksum_sha256 is not None
    west, south, east, north = claim.bounds
    if (
        any(not math.isfinite(value) for value in claim.bounds)
        or not -180 <= west < east <= 180
        or not -90 <= south < north <= 90
        or isinstance(claim.minimum_zoom, bool)
        or isinstance(claim.maximum_zoom, bool)
        or not 0 <= claim.minimum_zoom <= claim.maximum_zoom <= 22
        or claim.source_layer != claim.source_layer.strip()
        or not 1 <= len(claim.source_layer) <= 200
        or claim.source_layer.startswith("-")
        or re.search(r"[\x00-\x1f\x7f]", claim.source_layer) is not None
        or re.fullmatch(r"[0-9a-f]{64}", claim.request_checksum_sha256) is None
    ):
        raise ValidationFailure("pmtiles_derivative_request_invalid")


def _metadata(document: object, claim: PmtilesDerivativeClaim) -> PmtilesDerivativeMetadata:
    assert claim.bounds is not None
    assert claim.minimum_zoom is not None
    assert claim.maximum_zoom is not None
    assert claim.source_layer is not None
    if not isinstance(document, dict) or document.get("driverShortName") != "PMTiles":
        raise ValidationFailure("pmtiles_derivative_metadata_invalid")
    layers = document.get("layers")
    root_metadata = document.get("metadata")
    metadata = root_metadata.get("") if isinstance(root_metadata, dict) else None
    if (
        not isinstance(layers, list)
        or len(layers) != 1
        or not isinstance(layers[0], dict)
        or not isinstance(metadata, dict)
        or metadata.get("format") != "pbf"
        or metadata.get("scheme") != "xyz"
    ):
        raise ValidationFailure("pmtiles_derivative_metadata_invalid")
    layer = cast(dict[str, object], layers[0])
    feature_count = layer.get("featureCount")
    if (
        layer.get("name") != claim.source_layer
        or not isinstance(feature_count, int)
        or isinstance(feature_count, bool)
        or feature_count < 0
    ):
        raise ValidationFailure("pmtiles_derivative_metadata_invalid")
    try:
        minimum_zoom = int(str(metadata["minzoom"]))
        maximum_zoom = int(str(metadata["maxzoom"]))
    except (KeyError, TypeError, ValueError) as error:
        raise ValidationFailure("pmtiles_derivative_metadata_invalid") from error
    if minimum_zoom != claim.minimum_zoom or maximum_zoom != claim.maximum_zoom:
        raise ValidationFailure("pmtiles_derivative_zoom_mismatch")
    _validate_output_crs(layer)
    _validate_output_bounds(metadata.get("bounds"), claim.bounds)
    return PmtilesDerivativeMetadata(
        layer_name=claim.source_layer,
        feature_count=feature_count,
        minimum_zoom=minimum_zoom,
        maximum_zoom=maximum_zoom,
    )


def _validate_output_crs(layer: dict[str, object]) -> None:
    geometry_fields = layer.get("geometryFields")
    if not isinstance(geometry_fields, list) or not geometry_fields:
        raise ValidationFailure("pmtiles_derivative_crs_invalid")
    for field in geometry_fields:
        if not isinstance(field, dict):
            raise ValidationFailure("pmtiles_derivative_crs_invalid")
        coordinate_system = field.get("coordinateSystem")
        projjson = (
            coordinate_system.get("projjson") if isinstance(coordinate_system, dict) else None
        )
        identifier = projjson.get("id") if isinstance(projjson, dict) else None
        if not isinstance(identifier, dict) or identifier.get("authority") != "EPSG":
            raise ValidationFailure("pmtiles_derivative_crs_invalid")
        if identifier.get("code") not in {3857, "3857"}:
            raise ValidationFailure("pmtiles_derivative_crs_invalid")


def _validate_output_bounds(value: object, requested: tuple[float, float, float, float]) -> None:
    if not isinstance(value, str):
        raise ValidationFailure("pmtiles_derivative_bounds_invalid")
    try:
        bounds = tuple(float(coordinate) for coordinate in value.split(","))
    except ValueError as error:
        raise ValidationFailure("pmtiles_derivative_bounds_invalid") from error
    if len(bounds) != 4 or any(not math.isfinite(coordinate) for coordinate in bounds):
        raise ValidationFailure("pmtiles_derivative_bounds_invalid")
    west, south, east, north = bounds
    tolerance = 1e-5
    if (
        west > east
        or south > north
        or west < requested[0] - tolerance
        or south < requested[1] - tolerance
        or east > requested[2] + tolerance
        or north > requested[3] + tolerance
    ):
        raise ValidationFailure("pmtiles_derivative_bounds_invalid")


def _number(value: float) -> str:
    if not math.isfinite(value):
        raise ValidationFailure("pmtiles_derivative_bounds_invalid")
    return _canonical_json(value)


def _canonical_json_bytes(value: Any) -> bytes:
    return _canonical_json(value).encode("utf-8")


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValidationFailure("pmtiles_derivative_bounds_invalid")
        if value == 0:
            return "0"
        rendered = format(Decimal(repr(value)), "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return rendered
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("canonical JSON object keys must be strings")
        return (
            "{"
            + ",".join(
                f"{_canonical_json(key)}:{_canonical_json(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    raise TypeError("value is not JSON serializable")
