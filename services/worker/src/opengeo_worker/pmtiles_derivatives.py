"""No-egress conversion of one sealed managed vector object to PMTiles."""

import hashlib
import json
import math
import re
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.config import Settings
from opengeo_worker.models import (
    PmtilesDerivativeClaim,
    PmtilesDerivativeMetadata,
    StoredArtifact,
    ValidationFailure,
)
from opengeo_worker.pmtiles_options import normalize_pmtiles_options

MAX_PMTILES_BYTES = 2_147_483_648
PMTILES_DERIVATIVE_REQUEST_SCHEMA = "opengeo.pmtiles-derivative-request.1.0.0"
PMTILES_DERIVATIVE_RECIPE = "gdal-pmtiles-v1"
PMTILES_CONFIGURABLE_REQUEST_SCHEMA = "opengeo.pmtiles-derivative-request.1.1.0"
PMTILES_CONFIGURABLE_RECIPE = "gdal-pmtiles-v2"
PMTILES_CONFIGURABLE_GDAL = "3.13.1"
PMTILES_CONFIGURABLE_BASE = (
    "ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@"
    "sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59"
)
_PMTILES_MAGIC = b"PMTiles\x03"
PMTILES_DISPLAY_VALIDATION_SCHEMA = "opengeo.pmtiles-display-validation.1"
_GEOMETRY_TYPES = frozenset(
    {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}
)


class PmtilesDerivativeGenerator:
    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self._worker_image_digest = settings.pmtiles_worker_image_digest
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
        options = claim.options
        input_layer = claim.source_layer
        extra_arguments: list[str] = []
        input_arguments: list[str] = []
        software = None
        if options is not None:
            # A preserved GeoJSON original has not passed shared ingestion. Force
            # its declared parser instead of autodetecting another GDAL format.
            if claim.source.content_type == "application/geo+json":
                input_arguments = ["-if", "GeoJSON"]
            if claim.worker_image_digest != self._worker_image_digest:
                raise ValidationFailure("pmtiles_derivative_runtime_image_mismatch")
            version = self._runner.run(
                "ogrinfo", ["--version"], cwd=workdir, maximum_file_bytes=MAX_PMTILES_BYTES
            ).stdout.strip()
            if re.match(r"GDAL\s+3\.13\.1(?:[ ,]|$)", version) is None:
                raise ValidationFailure("pmtiles_derivative_runtime_version_mismatch")
            software = {
                "gdal": PMTILES_CONFIGURABLE_GDAL,
                "workerBaseImage": PMTILES_CONFIGURABLE_BASE,
                "projNetwork": "disabled",
                "versionOutput": version,
                "runtimeImageDigest": self._worker_image_digest,
            }
            inspected_source = self._runner.run(
                "ogrinfo",
                ["-ro", "-so", "-al", "-json", *input_arguments, str(source)],
                cwd=workdir,
                maximum_file_bytes=MAX_PMTILES_BYTES,
            )
            try:
                source_document = json.loads(inspected_source.stdout)
                source_layers = source_document["layers"]
                if (
                    not isinstance(source_layers, list)
                    or not source_layers
                    or not all(
                        isinstance(layer, dict) and isinstance(layer.get("name"), str)
                        for layer in source_layers
                    )
                ):
                    raise ValueError("Invalid source layers")
            except (ValueError, TypeError, KeyError) as error:
                raise ValidationFailure("pmtiles_derivative_source_layers_invalid") from error
            input_layer = options["input_layer"]
            if input_layer is None:
                if len(source_layers) != 1:
                    raise ValidationFailure("pmtiles_derivative_input_layer_required")
                input_layer = source_layers[0]["name"]
            selected = [layer for layer in source_layers if layer["name"] == input_layer]
            if (
                len(selected) != 1
                or not input_layer
                or input_layer.startswith("-")
                or len(input_layer) > 200
                or re.search(r"[\x00-\x1f\x7f]", input_layer)
            ):
                raise ValidationFailure("pmtiles_derivative_input_layer_invalid")
            fields = options["attribute_names"]
            if fields is not None:
                names = {
                    field.get("name")
                    for field in selected[0].get("fields", [])
                    if isinstance(field, dict)
                }
                if not set(fields) <= names:
                    raise ValidationFailure("pmtiles_derivative_attribute_missing")
                extra_arguments.extend(["-select", ",".join(fields)])
            for key, setting in (
                ("extent", "EXTENT"),
                ("simplification", "SIMPLIFICATION"),
                ("simplification_max_zoom", "SIMPLIFICATION_MAX_ZOOM"),
                ("buffer", "BUFFER"),
                ("max_size", "MAX_SIZE"),
                ("max_features", "MAX_FEATURES"),
            ):
                extra_arguments.extend(["-dsco", f"{setting}={_number(options[key])}"])
        self._runner.run(
            "ogr2ogr",
            [
                "-f",
                "PMTiles",
                *input_arguments,
                "-dsco",
                "NAME=OpenGeo custom PMTiles derivative",
                "-dsco",
                f"MINZOOM={claim.minimum_zoom}",
                "-dsco",
                f"MAXZOOM={claim.maximum_zoom}",
                *extra_arguments,
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
                input_layer,
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
        return replace(_metadata(document, claim), software=software, input_layer=input_layer)


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
        "schema": PMTILES_CONFIGURABLE_REQUEST_SCHEMA
        if claim.options is not None
        else PMTILES_DERIVATIVE_REQUEST_SCHEMA,
        "recipe": PMTILES_CONFIGURABLE_RECIPE
        if claim.options is not None
        else PMTILES_DERIVATIVE_RECIPE,
        "bounds": list(claim.bounds),
        "dataset_id": str(claim.dataset_id),
        "dataset_version_id": str(claim.dataset_version_id),
        "maximum_zoom": claim.maximum_zoom,
        "minimum_zoom": claim.minimum_zoom,
        "project_id": str(claim.project_id),
        "source_layer": claim.source_layer,
        "source_object_id": str(claim.source.object_id),
        **(
            {
                "options": normalize_pmtiles_options(claim.options),
                "worker_image_digest": claim.worker_image_digest,
            }
            if claim.options is not None
            else {}
        ),
    }
    return _canonical_json_bytes(request)


def _validate_request(claim: PmtilesDerivativeClaim) -> None:
    assert claim.bounds is not None
    assert claim.minimum_zoom is not None
    assert claim.maximum_zoom is not None
    assert claim.source_layer is not None
    assert claim.request_checksum_sha256 is not None
    west, south, east, north = claim.bounds
    if claim.options is not None:
        try:
            if (
                normalize_pmtiles_options(claim.options) != claim.options
                or re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,62}", claim.source_layer) is None
            ):
                raise ValueError("Unnormalized options")
            if (
                not isinstance(claim.worker_image_digest, str)
                or re.fullmatch(r"sha256:[0-9a-f]{64}", claim.worker_image_digest) is None
            ):
                raise ValueError("Unpinned v2 runtime")
        except ValueError as error:
            raise ValidationFailure("pmtiles_derivative_request_invalid") from error
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
        geometry_type=_geometry_type(layer),
    )


def _geometry_type(layer: dict[str, object]) -> str | None:
    fields = layer.get("geometryFields")
    if not isinstance(fields, list) or len(fields) != 1 or not isinstance(fields[0], dict):
        return None
    value = fields[0].get("type")
    return value if isinstance(value, str) and value in _GEOMETRY_TYPES else None


def pmtiles_display_validation(
    output: Path,
    metadata: PmtilesDerivativeMetadata,
    claim: PmtilesDerivativeClaim,
    artifact: StoredArtifact,
    expected_owner: str,
) -> tuple[dict[str, object], bytes | None]:
    """Seal display facts from local bytes; this never admits or enables a display."""
    claim.require_claimed()
    assert claim.source is not None
    assert claim.bounds is not None
    if (
        re.fullmatch(r"[0-9]{12}", expected_owner) is None
        or artifact.object_key != claim.output_object_key
        or artifact.bucket != claim.source.bucket
        or not 1 <= artifact.size_bytes <= MAX_PMTILES_BYTES
        or output.is_symlink()
        or not output.is_file()
        or output.stat().st_size != artifact.size_bytes
    ):
        raise ValidationFailure("pmtiles_display_output_facts_mismatch")
    digest = hashlib.sha256()
    blocks: list[str] = []
    size = 0
    with output.open("rb") as source:
        while block := source.read(65536):
            size += len(block)
            if size > artifact.size_bytes:
                raise ValidationFailure("pmtiles_display_output_facts_mismatch")
            digest.update(block)
            blocks.append(hashlib.sha256(block).hexdigest())
    if size != artifact.size_bytes or digest.hexdigest() != artifact.checksum_sha256:
        raise ValidationFailure("pmtiles_display_output_facts_mismatch")
    tile_layers: list[dict[str, object]] = []
    if (
        metadata.geometry_type in _GEOMETRY_TYPES
        and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,62}", metadata.layer_name) is not None
        and 0 <= metadata.feature_count <= 10_000_000
    ):
        tile_layers.append(
            {
                "source_layer": metadata.layer_name,
                "title": metadata.layer_name,
                "geometry_type": metadata.geometry_type,
                "feature_count": metadata.feature_count,
                "geometry_method": (
                    "Quantized, clipped and simplified tiled display; not analytical geometry. "
                    "Counts are GDAL-reported tile fragments, not source records. "
                    "Source geometry and attributes remain preserved separately."
                ),
            }
        )
    validation: dict[str, object] = {
        "schema_version": PMTILES_DISPLAY_VALIDATION_SCHEMA,
        "recipe": PMTILES_CONFIGURABLE_RECIPE
        if claim.options is not None
        else PMTILES_DERIVATIVE_RECIPE,
        "source_object_id": str(claim.source.object_id),
        "source_checksum_sha256": claim.source.checksum_sha256,
        "source_s3_version_id": claim.source.s3_version_id,
        "request_checksum_sha256": claim.request_checksum_sha256,
        "output_checksum_sha256": artifact.checksum_sha256,
        "output_size_bytes": artifact.size_bytes,
        "expected_owner": expected_owner,
        "bounds": list(claim.bounds),
        "min_zoom": metadata.minimum_zoom,
        "max_zoom": metadata.maximum_zoom,
        "output_layer": {
            "name": metadata.layer_name,
            "reported_fragment_count": metadata.feature_count,
            "geometry_type": metadata.geometry_type,
            "crs": metadata.crs,
        },
        "tile_layers": tile_layers,
        "count_semantics": "gdal-reported-tile-fragments-not-source-records",
        "losses": {
            "geometry": "quantized-clipped-simplified-display-not-analysis",
            "attributes": "not-independently-verified-null-values-may-be-omitted",
            "feature_ids": "not-guaranteed-to-retain-source-fids",
            "source_record_count": None,
            "preservation_verified": False,
        },
    }
    if claim.options is not None:
        if metadata.software is None:
            raise ValidationFailure("pmtiles_derivative_runtime_version_missing")
        validation["options"] = claim.options
        validation["software"] = metadata.software
        validation["input_layer"] = metadata.input_layer
        losses = cast(dict[str, object], validation["losses"])
        losses["adaptive_tile_limits"] = (
            "Tile byte and feature limits may reduce precision or omit display features; "
            "source data remains preserved."
        )
        losses["attribute_selection"] = claim.options["attribute_names"]
    if artifact.size_bytes <= 64 * 1024**2 and metadata.feature_count <= 100_000:
        validation["block_sha256"] = blocks
        return validation, None
    return validation, bytes.fromhex("".join(blocks))


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
