from typing import Any
from uuid import UUID

import pytest

from opengeo_worker.models import StoredArtifact, TransientFailure
from opengeo_worker.repository import WorkerRepository


class StubRepository(WorkerRepository):
    def __init__(
        self,
        row: tuple[Any, ...],
        presentation: tuple[str | None, bool] = ("#102030", True),
    ) -> None:
        self.row = row
        self.presentation = presentation

    def _fetch_one(self, statement: str, parameters: tuple[object, ...]):
        if statement == "SELECT * FROM app.claim_map_render(%s, %s, %s)":
            assert parameters[2] == 900
            return self.row
        assert statement == "SELECT * FROM app.get_map_render_presentation(%s, %s)"
        return self.presentation

    def _fetch_all(self, statement: str, parameters: tuple[object, ...]):
        del parameters
        assert statement == "SELECT * FROM app.get_map_render_layers(%s, %s)"
        return [render_layer_row()]


class CoverageStubRepository(WorkerRepository):
    def __init__(self, row: tuple[Any, ...]) -> None:
        self.row = row

    def _fetch_one(self, statement: str, parameters: tuple[object, ...]):
        assert statement == "SELECT * FROM app.claim_spatial_coverage_derivative(%s, %s, %s)"
        assert parameters[2] == 900
        return self.row


class ReclamationStubRepository(WorkerRepository):
    def __init__(self, row: tuple[Any, ...]) -> None:
        self.row = row

    def _fetch_one(self, statement: str, parameters: tuple[object, ...]):
        assert statement == (
            "SELECT * FROM app.claim_spatial_coverage_derivative_reclamation(%s, %s, %s)"
        )
        assert parameters[2] == 900
        return self.row


class PmtilesStubRepository(WorkerRepository):
    def __init__(self, row: tuple[Any, ...], *, profile: str = "v1") -> None:
        self.row = row
        self._pmtiles_profile = profile

    def _fetch_one(self, statement: str, parameters: tuple[object, ...]):
        function = (
            "claim_pmtiles_derivative_v2"
            if self._pmtiles_profile == "v2"
            else "claim_pmtiles_derivative"
        )
        assert statement == f"SELECT * FROM app.{function}(%s, %s, %s)"
        assert parameters[2] == 900
        return self.row


def render_layer_row() -> tuple[object, ...]:
    return (
        1,
        UUID("a0000000-0000-4000-8000-000000000001"),
        UUID("80000000-0000-4000-8000-000000000001"),
        UUID("82000000-0000-4000-8000-000000000001"),
        UUID("81000000-0000-4000-8000-000000000001"),
        "opengeo-test-geodata",
        "organizations/source/derivatives/preview/preview.geojson",
        "preview-v1",
        "fedcba9876543210",
        "application/geo+json",
        512,
        "1" * 64,
        UUID("a4000000-0000-4000-8000-000000000001"),
        UUID("a5000000-0000-4000-8000-000000000001"),
        UUID("a2000000-0000-4000-8000-000000000001"),
        UUID("a3000000-0000-4000-8000-000000000001"),
        {"schema": "opengeo.render.v1"},
        "2" * 64,
    )


def render_claim_row(bbox: object = (-1_000_000, -1_000_000, 1_000_000, 1_000_000)):
    return (
        "claimed",
        UUID("a6000000-0000-4000-8000-000000000001"),
        UUID("10000000-0000-4000-8000-000000000001"),
        UUID("50000000-0000-4000-8000-000000000001"),
        UUID("a0000000-0000-4000-8000-000000000001"),
        UUID("80000000-0000-4000-8000-000000000001"),
        UUID("82000000-0000-4000-8000-000000000001"),
        UUID("81000000-0000-4000-8000-000000000001"),
        "opengeo-test-geodata",
        "organizations/source/derivatives/preview/preview.geojson",
        "preview-v1",
        "fedcba9876543210",
        "application/geo+json",
        512,
        "1" * 64,
        UUID("a4000000-0000-4000-8000-000000000001"),
        UUID("a5000000-0000-4000-8000-000000000001"),
        UUID("a2000000-0000-4000-8000-000000000001"),
        UUID("a3000000-0000-4000-8000-000000000001"),
        {"schema": "opengeo.render.v1"},
        "2" * 64,
        bbox,
        "EPSG:3857",
        320,
        240,
        "png",
        "3" * 64,
        2,
        "organizations/output/derivatives/",
    )


def coverage_claim_row(source_extent: object = [-10, -5, 10, 5]):
    return (
        "claimed",
        UUID("b6000000-0000-4000-8000-000000000001"),
        UUID("10000000-0000-4000-8000-000000000001"),
        UUID("20000000-0000-4000-8000-000000000002"),
        UUID("b1000000-0000-4000-8000-000000000001"),
        UUID("b2000000-0000-4000-8000-000000000001"),
        UUID("30000000-0000-4000-8000-000000000003"),
        UUID("60000000-0000-4000-8000-000000000006"),
        UUID("70000000-0000-4000-8000-000000000007"),
        "opengeo-test-geodata",
        "organizations/source/original/source.tif",
        "source-version",
        "0123456789abcdef",
        "image/tiff",
        4096,
        "1" * 64,
        "EPSG:4326",
        source_extent,
        100,
        50,
        1,
        [{"index": 1, "data_type": "Byte"}],
        2,
        [1],
        "size",
        None,
        [-5, -2.5, 5, 2.5],
        "EPSG:3857",
        64,
        32,
        "bilinear",
        "2" * 64,
        2,
        "organizations/output/derivatives/",
    )


def reclamation_claim_row():
    return (
        "claimed",
        UUID("b7000000-0000-4000-8000-000000000001"),
        UUID("b6000000-0000-4000-8000-000000000001"),
        UUID("81000000-0000-4000-8000-000000000001"),
        "opengeo-test-geodata",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/coverages/b6000000-0000-4000-8000-000000000001.tif"
        ),
        "derived-version",
        "fedcba9876543210",
        "image/tiff",
        8192,
        "3" * 64,
        None,
        1,
    )


def pmtiles_claim_row(bounds: object = [-72, 41, -70, 43]):
    return (
        "claimed",
        UUID("b9000000-0000-4000-8000-000000000001"),
        UUID("10000000-0000-4000-8000-000000000001"),
        UUID("20000000-0000-4000-8000-000000000002"),
        UUID("30000000-0000-4000-8000-000000000003"),
        UUID("60000000-0000-4000-8000-000000000006"),
        UUID("70000000-0000-4000-8000-000000000007"),
        "opengeo-test-geodata",
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/working/layer-001.parquet"
        ),
        "source-version",
        "0123456789abcdef",
        "application/vnd.apache.parquet",
        4096,
        "1" * 64,
        bounds,
        2,
        12,
        "environmental_screening",
        "2" * 64,
        1,
        (
            "organizations/10000000-0000-4000-8000-000000000001/"
            "projects/20000000-0000-4000-8000-000000000002/"
            "datasets/30000000-0000-4000-8000-000000000003/"
            "versions/60000000-0000-4000-8000-000000000006/"
            "derivatives/tiles/custom/b9000000-0000-4000-8000-000000000001.pmtiles"
        ),
    )


def test_render_claim_adapter_preserves_crs_format_and_shifted_columns() -> None:
    repository = StubRepository(render_claim_row())

    claim = repository.claim_render(
        UUID("a6000000-0000-4000-8000-000000000001"),
        UUID("a7000000-0000-4000-8000-000000000001"),
        900,
    )

    assert claim.require_claimed() is claim
    assert claim.bbox == (-1_000_000.0, -1_000_000.0, 1_000_000.0, 1_000_000.0)
    assert claim.crs == "EPSG:3857"
    assert claim.width == 320
    assert claim.height == 240
    assert claim.format == "png"
    assert claim.background_color == "#102030"
    assert claim.transparent is True
    assert claim.attempt_count == 2
    assert claim.output_prefix == "organizations/output/derivatives/"
    assert len(claim.layers) == 1
    assert claim.layers[0].position == 1
    assert claim.layers[0].profile_version_id == claim.profile_version_id


def test_render_claim_adapter_rejects_malformed_database_bbox() -> None:
    repository = StubRepository(render_claim_row((1, 2, 3)))

    with pytest.raises(TransientFailure, match="database_render_claim_invalid"):
        repository.claim_render(
            UUID("a6000000-0000-4000-8000-000000000001"),
            UUID("a7000000-0000-4000-8000-000000000001"),
            900,
        )


def test_coverage_derivative_claim_preserves_exact_source_and_grid() -> None:
    repository = CoverageStubRepository(coverage_claim_row())

    claim = repository.claim_coverage_derivative(
        UUID("b6000000-0000-4000-8000-000000000001"),
        UUID("b7000000-0000-4000-8000-000000000001"),
        900,
    )

    assert claim.require_claimed() is claim
    assert claim.source is not None
    assert claim.source.s3_version_id == "source-version"
    assert claim.source_extent == (-10.0, -5.0, 10.0, 5.0)
    assert claim.subset_extent == (-5.0, -2.5, 5.0, 2.5)
    assert claim.target_crs == "EPSG:3857"
    assert (claim.target_width, claim.target_height) == (64, 32)
    assert claim.resampling == "bilinear"
    assert claim.source_bands == ({"index": 1, "data_type": "Byte"},)
    assert claim.request_schema_version == 2
    assert claim.band_indexes == (1,)
    assert claim.scale_mode == "size"
    assert claim.requested_resolution is None


def test_coverage_derivative_claim_rejects_malformed_database_extent() -> None:
    repository = CoverageStubRepository(coverage_claim_row([1, 2, 3]))

    with pytest.raises(TransientFailure, match="database_coverage_derivative_claim_invalid"):
        repository.claim_coverage_derivative(
            UUID("b6000000-0000-4000-8000-000000000001"),
            UUID("b7000000-0000-4000-8000-000000000001"),
            900,
        )


def test_coverage_reclamation_claim_preserves_only_the_exact_delete_target() -> None:
    repository = ReclamationStubRepository(reclamation_claim_row())

    claim = repository.claim_coverage_derivative_reclamation(
        UUID("b7000000-0000-4000-8000-000000000001"),
        UUID("b8000000-0000-4000-8000-000000000001"),
        900,
    )

    assert claim.require_claimed() is claim
    assert claim.target is not None
    assert claim.target.s3_version_id == "derived-version"
    assert claim.target.object_key.endswith(
        "/derivatives/coverages/b6000000-0000-4000-8000-000000000001.tif"
    )
    assert claim.attempt_count == 1


def test_pmtiles_claim_preserves_exact_source_bounds_zoom_and_output_key() -> None:
    repository = PmtilesStubRepository(pmtiles_claim_row())

    claim = repository.claim_pmtiles_derivative(
        UUID("b9000000-0000-4000-8000-000000000001"),
        UUID("ba000000-0000-4000-8000-000000000001"),
        900,
    )

    assert claim.require_claimed() is claim
    assert claim.source is not None
    assert claim.source.s3_version_id == "source-version"
    assert claim.source.content_type == "application/vnd.apache.parquet"
    assert claim.bounds == (-72.0, 41.0, -70.0, 43.0)
    assert (claim.minimum_zoom, claim.maximum_zoom) == (2, 12)
    assert claim.source_layer == "environmental_screening"
    assert claim.output_object_key is not None
    assert claim.output_object_key.endswith(
        "/derivatives/tiles/custom/b9000000-0000-4000-8000-000000000001.pmtiles"
    )


def test_pmtiles_v2_claim_returns_immutable_conversion_options_and_runtime_pin() -> None:
    from opengeo_worker.pmtiles_options import normalize_pmtiles_options

    options = normalize_pmtiles_options({"attribute_names": ["name"]})
    digest = "sha256:" + "d" * 64
    repository = PmtilesStubRepository((*pmtiles_claim_row(), options, digest), profile="v2")
    claim = repository.claim_pmtiles_derivative(
        UUID("b9000000-0000-4000-8000-000000000001"),
        UUID("ba000000-0000-4000-8000-000000000001"),
        900,
    )
    assert claim.options == options
    assert claim.worker_image_digest == digest


@pytest.mark.parametrize("bounds", [[-72, 41, -70], [-72, True, -70, 43], "-72,41,-70,43"])
def test_pmtiles_claim_rejects_malformed_database_bounds(bounds: object) -> None:
    repository = PmtilesStubRepository(pmtiles_claim_row(bounds))

    with pytest.raises(TransientFailure, match="database_pmtiles_derivative_claim_invalid"):
        repository.claim_pmtiles_derivative(
            UUID("b9000000-0000-4000-8000-000000000001"),
            UUID("ba000000-0000-4000-8000-000000000001"),
            900,
        )


@pytest.mark.parametrize("validation", [None, {"schema_version": "retained-validation"}])
def test_pmtiles_completion_preserves_legacy_call_and_passes_validation_atomically(
    validation: dict[str, object] | None,
) -> None:
    class CompletionRepository(WorkerRepository):
        def __init__(self):
            self.calls = []

        def _fetch_one(self, statement, parameters):
            self.calls.append((statement, parameters))
            return (True,)

    repository = CompletionRepository()
    job = UUID("b9000000-0000-4000-8000-000000000001")
    token = UUID("ba000000-0000-4000-8000-000000000001")
    artifact = StoredArtifact(
        job,
        "tile",
        "opengeo-test-geodata",
        "exact-output-key",
        "version",
        "fedcba9876543210",
        "application/vnd.pmtiles",
        128,
        "a" * 64,
    )
    assert repository.complete_pmtiles_derivative(job, token, artifact, validation)
    statement, parameters = repository.calls[0]
    assert parameters[:2] == (job, token)
    assert parameters[2].obj == artifact.as_record()
    if validation is None:
        assert statement == "SELECT app.complete_pmtiles_derivative(%s, %s, %s)"
        assert len(parameters) == 3
    else:
        assert statement == "SELECT app.complete_pmtiles_derivative(%s, %s, %s, %s)"
        assert parameters[3].obj == validation
