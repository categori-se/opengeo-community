import hashlib
import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import pytest

from opengeo_worker.command_runner import CommandResult
from opengeo_worker.config import Settings
from opengeo_worker.coverage_derivatives import CoverageDerivativeGenerator
from opengeo_worker.models import CoverageDerivativeClaim, ObjectReference, ValidationFailure


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


def claim() -> CoverageDerivativeClaim:
    return CoverageDerivativeClaim(
        status="claimed",
        job_id=UUID("b6000000-0000-4000-8000-000000000001"),
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("20000000-0000-4000-8000-000000000002"),
        service_id=UUID("b1000000-0000-4000-8000-000000000001"),
        coverage_id=UUID("b2000000-0000-4000-8000-000000000001"),
        dataset_id=UUID("30000000-0000-4000-8000-000000000003"),
        dataset_version_id=UUID("60000000-0000-4000-8000-000000000006"),
        source=ObjectReference(
            UUID("70000000-0000-4000-8000-000000000007"),
            "opengeo-test-geodata",
            "organizations/source/original/source.tif",
            "source-version",
            "0123456789abcdef",
            "image/tiff",
            1024,
            "1" * 64,
        ),
        source_crs="EPSG:4326",
        source_extent=(-10.0, -5.0, 10.0, 5.0),
        source_width=100,
        source_height=50,
        source_band_count=1,
        source_bands=({"index": 1, "data_type": "UInt16"},),
        request_schema_version=1,
        band_indexes=(1,),
        scale_mode="size",
        requested_resolution=None,
        subset_extent=(-5.0, -2.5, 5.0, 2.5),
        target_crs="EPSG:3857",
        target_width=64,
        target_height=32,
        resampling="bilinear",
        request_checksum_sha256=hashlib.sha256(
            b'{"height":32,"resampling":"bilinear","subset":["-5","-2.5","5","2.5"],'
            b'"target_crs":"EPSG:3857","width":64}'
        ).hexdigest(),
        attempt_count=1,
        output_prefix="organizations/output/derivatives/",
    )


def metadata(*, layout: str = "COG", crs: int = 3857, data_type: str = "UInt16") -> dict:
    return {
        "driverShortName": "GTiff",
        "size": [64, 32],
        "coordinateSystem": {"projjson": {"id": {"authority": "EPSG", "code": crs}}},
        "geoTransform": [-556597.0, 17393.65625, 0.0, 278387.0, 0.0, -17399.1875],
        "cornerCoordinates": {
            "upperLeft": [-556597.0, 278387.0],
            "lowerLeft": [-556597.0, -278387.0],
            "lowerRight": [556597.0, -278387.0],
            "upperRight": [556597.0, 278387.0],
        },
        "metadata": {"IMAGE_STRUCTURE": {"LAYOUT": layout}},
        "bands": [{"band": 1, "type": data_type, "colorInterpretation": "Gray"}],
    }


class Runner:
    def __init__(self, document: dict | None = None) -> None:
        self.document = document or metadata()
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
        if program == "gdalwarp":
            Path(arguments[-1]).write_bytes(b"II*\x00bounded-cog")
            return CommandResult("", "")
        if program == "gdalinfo":
            return CommandResult(json.dumps(self.document), "")
        assert program == "gdalsrsinfo"
        code = self.document["coordinateSystem"]["projjson"]["id"]["code"]
        return CommandResult(f"EPSG:{code}\n", "")


def test_generates_one_bounded_cog_with_fixed_subset_grid_and_resampling(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.tif"
    target = tmp_path / "output.tif"
    source.write_bytes(b"II*\x00source")
    runner = Runner()

    result = CoverageDerivativeGenerator(settings(tmp_path), runner).generate(
        source, claim(), target, tmp_path
    )

    assert result.crs == "EPSG:3857"
    assert result.extent == (-556597.0, -278387.0, 556597.0, 278387.0)
    assert (result.width, result.height, result.band_count) == (64, 32, 1)
    program, arguments, _, maximum = runner.calls[0]
    assert program == "gdalwarp"
    assert arguments[0:16] == [
        "-overwrite",
        "-if",
        "GTiff",
        "-of",
        "COG",
        "-b",
        "1",
        "-te",
        "-5",
        "-2.5",
        "5",
        "2.5",
        "-te_srs",
        "EPSG:4326",
        "-t_srs",
        "EPSG:3857",
    ]
    assert arguments[16:22] == ["-ts", "64", "32", "-r", "bilinear", "-wo"]
    assert "NUM_THREADS=1" in arguments
    assert "-multi" not in arguments
    assert maximum == 536_870_912


def test_selects_ordered_source_bands_and_verifies_schema_two_resolution_request(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.tif"
    target = tmp_path / "output.tif"
    source.write_bytes(b"II*\x00source")
    document = metadata(crs=4326)
    document["size"] = [40, 20]
    document["bands"] = [
        {"band": 1, "type": "UInt16", "colorInterpretation": "Gray"},
        {"band": 2, "type": "UInt16", "colorInterpretation": "Undefined"},
    ]
    selected = replace(
        claim(),
        source_band_count=3,
        source_bands=(
            {"index": 1, "data_type": "UInt16"},
            {"index": 2, "data_type": "Byte"},
            {"index": 3, "data_type": "UInt16"},
        ),
        request_schema_version=2,
        band_indexes=(1, 3),
        scale_mode="resolution",
        requested_resolution=(0.25, 0.25),
        target_crs="EPSG:4326",
        target_width=40,
        target_height=20,
        request_checksum_sha256=hashlib.sha256(
            b'{"band_indexes":[1,3],"height":20,"resampling":"bilinear",'
            b'"resolution":["0.25","0.25"],"scale_mode":"resolution",'
            b'"subset":["-5","-2.5","5","2.5"],"target_crs":"EPSG:4326",'
            b'"width":40}'
        ).hexdigest(),
    )
    runner = Runner(document)

    result = CoverageDerivativeGenerator(settings(tmp_path), runner).generate(
        source, selected, target, tmp_path
    )

    arguments = runner.calls[0][1]
    assert arguments[5:9] == ["-b", "1", "-b", "3"]
    assert result.band_count == 2
    assert result.bands[0]["source_index"] == 1
    assert result.bands[1]["source_index"] == 3


def test_extent_uses_affine_precision_not_rounded_display_corners(tmp_path: Path) -> None:
    source = tmp_path / "source.tif"
    source.write_bytes(b"II*\x00source")
    document = metadata()
    document["geoTransform"] = [-71.11953125, 0.00234375, 0, 42.4078125, 0, -0.0046875]
    document["cornerCoordinates"] = {"upperLeft": [-71.1195312, 42.4078125]}
    result = CoverageDerivativeGenerator(settings(tmp_path), Runner(document)).generate(
        source, claim(), tmp_path / "output.tif", tmp_path
    )
    assert result.extent == pytest.approx(
        (-71.11953125, 42.2578125, -70.96953125, 42.4078125), rel=0, abs=1e-12
    )


@pytest.mark.parametrize(
    ("document", "code"),
    [
        (metadata(layout="TILED"), "coverage_derivative_metadata_invalid"),
        (metadata(crs=4326), "coverage_derivative_crs_mismatch"),
        (metadata(data_type="Byte"), "coverage_derivative_band_type_mismatch"),
    ],
)
def test_rejects_output_that_does_not_match_the_immutable_request(
    tmp_path: Path, document: dict, code: str
) -> None:
    source = tmp_path / "source.tif"
    source.write_bytes(b"II*\x00source")

    with pytest.raises(ValidationFailure, match=code):
        CoverageDerivativeGenerator(settings(tmp_path), Runner(document)).generate(
            source, claim(), tmp_path / "output.tif", tmp_path
        )


def test_rejects_a_request_checksum_that_does_not_bind_the_claim(tmp_path: Path) -> None:
    source = tmp_path / "source.tif"
    source.write_bytes(b"II*\x00source")

    with pytest.raises(ValidationFailure, match="coverage_derivative_request_checksum_mismatch"):
        CoverageDerivativeGenerator(settings(tmp_path), Runner()).generate(
            source,
            replace(claim(), request_checksum_sha256="0" * 64),
            tmp_path / "output.tif",
            tmp_path,
        )
