import hashlib
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from opengeo_worker.command_runner import CommandResult
from opengeo_worker.config import Settings
from opengeo_worker.models import (
    ObjectReference,
    PmtilesDerivativeClaim,
    PmtilesDerivativeMetadata,
    StoredArtifact,
    ValidationFailure,
)
from opengeo_worker.pmtiles_derivatives import (
    MAX_PMTILES_BYTES,
    PmtilesDerivativeGenerator,
    pmtiles_derivative_request_checksum,
    pmtiles_display_validation,
)
from opengeo_worker.pmtiles_options import normalize_pmtiles_options

JOB_ID = UUID("b9000000-0000-4000-8000-000000000001")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("20000000-0000-4000-8000-000000000002")
DATASET_ID = UUID("30000000-0000-4000-8000-000000000003")
VERSION_ID = UUID("60000000-0000-4000-8000-000000000006")
WORKER_IMAGE = "sha256:" + "d" * 64


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
        pmtiles_worker_image_digest=WORKER_IMAGE,
    )


def claim() -> PmtilesDerivativeClaim:
    initial = PmtilesDerivativeClaim(
        status="claimed",
        job_id=JOB_ID,
        organization_id=ORGANIZATION_ID,
        project_id=PROJECT_ID,
        dataset_id=DATASET_ID,
        dataset_version_id=VERSION_ID,
        source=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000007"),
            "opengeo-test-geodata",
            (
                f"organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/"
                f"datasets/{DATASET_ID}/versions/{VERSION_ID}/"
                "derivatives/working/layer-001.parquet"
            ),
            "source-version",
            "0123456789abcdef",
            "application/vnd.apache.parquet",
            4096,
            "1" * 64,
        ),
        bounds=(-72.0, 41.0, -70.0, 43.0),
        minimum_zoom=2,
        maximum_zoom=12,
        source_layer="environmental_screening",
        request_checksum_sha256="0" * 64,
        attempt_count=1,
        output_object_key=(
            f"organizations/{ORGANIZATION_ID}/projects/{PROJECT_ID}/"
            f"datasets/{DATASET_ID}/versions/{VERSION_ID}/"
            f"derivatives/tiles/custom/{JOB_ID}.pmtiles"
        ),
    )
    return replace(
        initial,
        request_checksum_sha256=pmtiles_derivative_request_checksum(initial),
    )


def metadata(
    *,
    crs: int = 3857,
    minimum_zoom: str = "2",
    maximum_zoom: str = "12",
    bounds: str = "-71.9,41.1,-70.1,42.9",
) -> dict[str, object]:
    return {
        "driverShortName": "PMTiles",
        "layers": [
            {
                "name": "environmental_screening",
                "featureCount": 5,
                "geometryFields": [
                    {
                        "type": "MultiLineString",
                        "coordinateSystem": {
                            "projjson": {
                                "id": {"authority": "EPSG", "code": crs},
                            }
                        },
                    }
                ],
            }
        ],
        "metadata": {
            "": {
                "format": "pbf",
                "scheme": "xyz",
                "minzoom": minimum_zoom,
                "maxzoom": maximum_zoom,
                "bounds": bounds,
            }
        },
    }


class Runner:
    def __init__(self, document: dict[str, object] | None = None, *, magic: bytes = b"PMTiles\x03"):
        self.document = document or metadata()
        self.magic = magic
        self.calls: list[tuple[str, list[str], Path, int]] = []

    def run(
        self,
        program: str,
        arguments: list[str],
        *,
        cwd: Path,
        maximum_file_bytes: int,
    ) -> CommandResult:
        self.calls.append((program, list(arguments), cwd, maximum_file_bytes))
        if program == "ogr2ogr":
            Path(arguments[-3]).write_bytes(self.magic + b"bounded-output")
            return CommandResult("", "")
        assert program == "ogrinfo"
        return CommandResult(json.dumps(self.document), "")


class ConfigurableRunner(Runner):
    def __init__(self, *, layers=None, version="GDAL 3.13.1, released 2026/09/01"):
        super().__init__()
        self.layers = (
            layers
            if layers is not None
            else [{"name": "actual_input", "fields": [{"name": "name"}, {"name": "class"}]}]
        )
        self.version = version

    def run(self, program, arguments, **kwargs):
        if program == "ogrinfo" and arguments == ["--version"]:
            self.calls.append(
                (program, list(arguments), kwargs["cwd"], kwargs["maximum_file_bytes"])
            )
            return CommandResult(self.version, "")
        if program == "ogrinfo" and Path(arguments[-1]).name in {
            "source.parquet",
            "source.geojson",
        }:
            self.calls.append(
                (program, list(arguments), kwargs["cwd"], kwargs["maximum_file_bytes"])
            )
            return CommandResult(json.dumps({"layers": self.layers}), "")
        return super().run(program, arguments, **kwargs)


def configurable_claim(options=None):
    initial = replace(
        claim(), options=normalize_pmtiles_options(options or {}), worker_image_digest=WORKER_IMAGE
    )
    return replace(initial, request_checksum_sha256=pmtiles_derivative_request_checksum(initial))


def test_configurable_recipe_autoselects_actual_input_and_binds_typed_options_and_runtime(tmp_path):
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")
    runner = ConfigurableRunner()
    job = configurable_claim(
        {"extent": 8192, "simplification": 0.5, "attribute_names": ["class", "name"]}
    )
    result = PmtilesDerivativeGenerator(settings(tmp_path), runner).generate(
        source, job, tmp_path / "output.pmtiles", tmp_path
    )
    args = next(call[1] for call in runner.calls if call[0] == "ogr2ogr")
    assert args[-1] == "actual_input"
    assert args[args.index("-nln") + 1] == job.source_layer
    assert args[args.index("-select") + 1] == "class,name"
    for setting in [
        "EXTENT=8192",
        "SIMPLIFICATION=0.5",
        "SIMPLIFICATION_MAX_ZOOM=1",
        "BUFFER=80",
        "MAX_SIZE=500000",
        "MAX_FEATURES=200000",
    ]:
        assert setting in args
    assert result.input_layer == "actual_input"
    assert result.software["gdal"] == "3.13.1"
    assert result.software["runtimeImageDigest"] == WORKER_IMAGE
    assert result.software["versionOutput"] == runner.version


@pytest.mark.parametrize("configurable", [False, True])
def test_v2_geojson_forces_declared_parser_without_changing_v1(tmp_path, configurable):
    source = tmp_path / "source.geojson"
    source.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    job = configurable_claim() if configurable else claim()
    job = replace(job, source=replace(job.source, content_type="application/geo+json"))
    job = replace(job, request_checksum_sha256=pmtiles_derivative_request_checksum(job))
    runner = ConfigurableRunner() if configurable else Runner()
    PmtilesDerivativeGenerator(settings(tmp_path), runner).generate(
        source, job, tmp_path / "output.pmtiles", tmp_path
    )
    parsed_source_calls = [
        arguments
        for program, arguments, _, _ in runner.calls
        if program == "ogr2ogr" or arguments[-1] == str(source)
    ]
    assert len(parsed_source_calls) == (2 if configurable else 1)
    for arguments in parsed_source_calls:
        if configurable:
            assert arguments[arguments.index("-if") + 1] == "GeoJSON"
        else:
            assert "-if" not in arguments


@pytest.mark.parametrize(
    ("options", "layers", "version", "code"),
    [
        ({}, [{"name": "one"}, {"name": "two"}], "GDAL 3.13.1", "input_layer_required"),
        (
            {"input_layer": "missing"},
            [{"name": "actual_input"}],
            "GDAL 3.13.1",
            "input_layer_invalid",
        ),
        (
            {"attribute_names": ["missing"]},
            [{"name": "actual_input", "fields": []}],
            "GDAL 3.13.1",
            "attribute_missing",
        ),
        ({}, [{"name": "actual_input"}], "GDAL 3.13.0", "runtime_version_mismatch"),
    ],
)
def test_configurable_recipe_rejects_ambiguous_source_missing_attributes_and_wrong_binary(
    tmp_path, options, layers, version, code
):
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")
    runner = ConfigurableRunner(layers=layers, version=version)
    with pytest.raises(ValidationFailure, match="pmtiles_derivative_" + code):
        PmtilesDerivativeGenerator(settings(tmp_path), runner).generate(
            source, configurable_claim(options), tmp_path / "output.pmtiles", tmp_path
        )
    assert not any(call[0] == "ogr2ogr" for call in runner.calls)


def test_configurable_recipe_rejects_another_runtime_image_before_conversion(tmp_path):
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")
    runner = ConfigurableRunner()
    with pytest.raises(ValidationFailure, match="runtime_image_mismatch"):
        PmtilesDerivativeGenerator(
            replace(settings(tmp_path), pmtiles_worker_image_digest="sha256:" + "e" * 64), runner
        ).generate(source, configurable_claim(), tmp_path / "output.pmtiles", tmp_path)
    assert runner.calls == []


def test_generates_one_fixed_no_network_pmtiles_archive_from_wgs84_bounds(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.parquet"
    target = tmp_path / "output.pmtiles"
    source.write_bytes(b"PAR1sourcePAR1")
    runner = Runner()

    result = PmtilesDerivativeGenerator(settings(tmp_path), runner).generate(
        source, claim(), target, tmp_path
    )

    assert result.layer_name == "environmental_screening"
    assert result.feature_count == 5
    assert result.geometry_type == "MultiLineString"
    assert (result.minimum_zoom, result.maximum_zoom, result.crs) == (2, 12, "EPSG:3857")
    program, arguments, _, maximum = runner.calls[0]
    assert program == "ogr2ogr"
    assert maximum == MAX_PMTILES_BYTES
    assert arguments[:2] == ["-f", "PMTiles"]
    assert arguments[arguments.index("-spat_srs") : arguments.index("-spat_srs") + 2] == [
        "-spat_srs",
        "EPSG:4326",
    ]
    spat = arguments.index("-spat")
    assert arguments[spat : spat + 5] == ["-spat", "-72", "41", "-70", "43"]
    assert "MAXZOOM=12" in arguments
    assert "MINZOOM=2" in arguments
    assert "EPSG:3857" in arguments
    assert "-makevalid" not in arguments
    assert all("http:" not in value and "https:" not in value for value in arguments)


@pytest.mark.parametrize(
    ("changed", "code"),
    [
        ({"request_checksum_sha256": "f" * 64}, "pmtiles_derivative_request_checksum_mismatch"),
        ({"maximum_zoom": 23}, "pmtiles_derivative_request_invalid"),
        ({"source_layer": "-oo"}, "pmtiles_derivative_request_invalid"),
        (
            {"output_object_key": "organizations/unsealed.pmtiles"},
            "pmtiles_derivative_output_key_mismatch",
        ),
    ],
)
def test_rejects_unsealed_or_unsafe_conversion_requests(
    tmp_path: Path, changed: dict[str, object], code: str
) -> None:
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")

    with pytest.raises(ValidationFailure, match=code):
        PmtilesDerivativeGenerator(settings(tmp_path), Runner()).generate(
            source,
            replace(claim(), **changed),
            tmp_path / "output.pmtiles",
            tmp_path,
        )


@pytest.mark.parametrize(
    ("document", "code"),
    [
        (metadata(crs=4326), "pmtiles_derivative_crs_invalid"),
        (metadata(maximum_zoom="13"), "pmtiles_derivative_zoom_mismatch"),
        (
            metadata(bounds="-73,41,-70,43"),
            "pmtiles_derivative_bounds_invalid",
        ),
    ],
)
def test_rejects_output_metadata_that_does_not_match_the_sealed_request(
    tmp_path: Path, document: dict[str, object], code: str
) -> None:
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")

    with pytest.raises(ValidationFailure, match=code):
        PmtilesDerivativeGenerator(settings(tmp_path), Runner(document)).generate(
            source, claim(), tmp_path / "output.pmtiles", tmp_path
        )


def test_rejects_an_output_without_pmtiles_v3_magic(tmp_path: Path) -> None:
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")

    with pytest.raises(ValidationFailure, match="pmtiles_derivative_output_invalid"):
        PmtilesDerivativeGenerator(settings(tmp_path), Runner(magic=b"not-pmti")).generate(
            source, claim(), tmp_path / "output.pmtiles", tmp_path
        )


@pytest.mark.parametrize("feature_count", [54, 100_001])
def test_display_validation_binds_local_blocks_and_discloses_fragment_counts(
    tmp_path: Path, feature_count: int
) -> None:
    content = b"PMTiles\x03" + b"a" * 65536 + b"b" * 65536
    output = tmp_path / "output.pmtiles"
    output.write_bytes(content)
    job = claim()
    assert job.output_object_key is not None
    assert job.source is not None
    artifact = StoredArtifact(
        JOB_ID,
        "tile",
        job.source.bucket,
        job.output_object_key,
        "exact-output-version",
        "fedcba9876543210",
        "application/vnd.pmtiles",
        len(content),
        hashlib.sha256(content).hexdigest(),
    )
    output_metadata = PmtilesDerivativeMetadata(
        "environmental_screening", feature_count, 2, 12, geometry_type="MultiLineString"
    )

    validation, index = pmtiles_display_validation(
        output, output_metadata, job, artifact, "222222222222"
    )

    expected = [
        hashlib.sha256(content[i : i + 65536]).hexdigest() for i in range(0, len(content), 65536)
    ]
    assert validation["source_object_id"] == str(job.source.object_id)
    assert validation["source_checksum_sha256"] == job.source.checksum_sha256
    assert validation["source_s3_version_id"] == "source-version"
    assert validation["request_checksum_sha256"] == job.request_checksum_sha256
    assert validation["output_checksum_sha256"] == artifact.checksum_sha256
    assert validation["expected_owner"] == "222222222222"
    assert validation["count_semantics"] == "gdal-reported-tile-fragments-not-source-records"
    assert validation["losses"]["preservation_verified"] is False
    assert validation["losses"]["source_record_count"] is None
    assert validation["tile_layers"][0]["feature_count"] == feature_count
    if feature_count <= 100_000:
        assert validation["block_sha256"] == expected
        assert index is None
    else:
        assert "block_sha256" not in validation
        assert index == bytes.fromhex("".join(expected))

    output.write_bytes(content[:-1] + b"x")
    with pytest.raises(ValidationFailure, match="pmtiles_display_output_facts_mismatch"):
        pmtiles_display_validation(output, output_metadata, job, artifact, "222222222222")


def test_unknown_geometry_remains_completed_metadata_without_admissible_tile_layers(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.parquet"
    source.write_bytes(b"PAR1sourcePAR1")
    document = metadata()
    document["layers"][0]["geometryFields"][0]["type"] = "Unknown"
    output = tmp_path / "output.pmtiles"
    job = claim()
    result = PmtilesDerivativeGenerator(settings(tmp_path), Runner(document)).generate(
        source, job, output, tmp_path
    )
    assert result.geometry_type is None
    assert job.output_object_key is not None and job.source is not None
    content = output.read_bytes()
    artifact = StoredArtifact(
        JOB_ID,
        "tile",
        job.source.bucket,
        job.output_object_key,
        "exact-output-version",
        "fedcba9876543210",
        "application/vnd.pmtiles",
        len(content),
        hashlib.sha256(content).hexdigest(),
    )
    validation, _ = pmtiles_display_validation(output, result, job, artifact, "222222222222")
    assert validation["tile_layers"] == []
    assert validation["output_layer"]["geometry_type"] is None
    assert validation["output_layer"]["reported_fragment_count"] == 5
