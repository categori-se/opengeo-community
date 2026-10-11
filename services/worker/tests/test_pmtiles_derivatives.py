import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from opengeo_worker.command_runner import CommandResult
from opengeo_worker.config import Settings
from opengeo_worker.models import ObjectReference, PmtilesDerivativeClaim, ValidationFailure
from opengeo_worker.pmtiles_derivatives import (
    MAX_PMTILES_BYTES,
    PmtilesDerivativeGenerator,
    pmtiles_derivative_request_checksum,
)

JOB_ID = UUID("b9000000-0000-4000-8000-000000000001")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-000000000001")
PROJECT_ID = UUID("20000000-0000-4000-8000-000000000002")
DATASET_ID = UUID("30000000-0000-4000-8000-000000000003")
VERSION_ID = UUID("60000000-0000-4000-8000-000000000006")


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
                        "coordinateSystem": {
                            "projjson": {
                                "id": {"authority": "EPSG", "code": crs},
                            }
                        }
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
