import asyncio
from collections import deque
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.data_preservation import (
    CopyEstimateSpec,
    DataPreservationAccessDenied,
    DataPreservationConflict,
    DataPreservationStoreUnavailable,
    ExactObjectScope,
    FeatureCollectionScope,
    PmtilesDerivativeRequest,
    PostgresDataPreservationRepository,
    ProtectedCopyRequest,
    WmsBoundedImageScope,
    pmtiles_derivative_request_checksum,
    seal_copy_estimate,
)
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000258")
USER_ID = UUID("20000000-0000-4000-8000-000000000258")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000258")
SOURCE_DATASET_ID = UUID("80000000-0000-4000-8000-000000000258")
DATASET_VERSION_ID = UUID("82000000-0000-4000-8000-000000000258")
SOURCE_OBJECT_ID = UUID("81000000-0000-4000-8000-000000000258")
ESTIMATE_ID = UUID("83000000-0000-4000-8000-000000000258")
IDEMPOTENCY_KEY = UUID("84000000-0000-4000-8000-000000000258")
NOW = datetime(2026, 8, 28, 22, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, rows: list[tuple[Any, ...] | None]) -> None:
        self.rows = deque(rows)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.rows, f"unexpected fetch_one: {statement}"
        return self.rows.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        assert self.rows, f"unexpected fetch_all: {statement}"
        row = self.rows.popleft()
        assert isinstance(row, list)
        return row

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class FakeExecutor:
    def __init__(self, transaction: FakeTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transaction)

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct query not expected")


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def access_row(*, project_role: str | None = "editor", dataset_role: str | None = None):
    return ("member", project_role, dataset_role, False, "upload", "geojson", "active")


def estimate_row(*, source_type: str = "wms") -> tuple[Any, ...]:
    if source_type == "wms":
        scope = {
            "kind": "bounded_image",
            "bounds": [-73.6, 41.1, -69.8, 42.9],
            "width": 1024,
            "height": 512,
        }
        method = "bounded_map_capture"
        output_format = "png"
        content_type = "image/png"
        maximum_bytes = 2_162_688
        cost = Decimal("0.000055")
    else:
        scope = {"kind": "exact_object"}
        method = "exact_object_copy"
        output_format = "pmtiles"
        content_type = "application/vnd.pmtiles"
        maximum_bytes = 536_870_912
        cost = Decimal("0.012354")
    sealed = seal_copy_estimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        spec=CopyEstimateSpec(
            source_type,  # type: ignore[arg-type]
            WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 1024, 512)
            if source_type == "wms"
            else ExactObjectScope(),
        ),
        created_by=USER_ID,
        created_at=NOW,
    )
    return (
        ESTIMATE_ID,
        PROJECT_ID,
        SOURCE_DATASET_ID,
        3,
        source_type,
        method,
        scope,
        output_format,
        content_type,
        1,
        maximum_bytes,
        cost,
        sealed.estimate_checksum_sha256,
        USER_ID,
        NOW,
        NOW.replace(minute=52),
    )


def test_server_seals_bounded_wms_and_exact_pmtiles_estimates() -> None:
    wms = seal_copy_estimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        spec=CopyEstimateSpec("wms", WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 1024, 512)),
        created_by=USER_ID,
        created_at=NOW,
    )
    exact = seal_copy_estimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        spec=CopyEstimateSpec("pmtiles", ExactObjectScope()),
        created_by=USER_ID,
        created_at=NOW,
    )

    assert wms.capture_scope["kind"] == "bounded_image"
    assert wms.output_format == "png"
    assert wms.maximum_requests == 1
    assert wms.maximum_output_bytes == 1024 * 512 * 4 + 65_536
    assert wms.expires_at.isoformat() == "2026-08-28T22:30:00+00:00"
    assert exact.capture_scope == {"kind": "exact_object"}
    assert exact.output_format == "pmtiles"
    assert exact.maximum_output_bytes == 536_870_912
    assert wms.estimate_checksum_sha256 != exact.estimate_checksum_sha256
    assert len(wms.estimate_checksum_sha256) == 64


def test_server_seals_bounded_arcgis_and_wfs_feature_estimates() -> None:
    arcgis = seal_copy_estimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        spec=CopyEstimateSpec(
            "arcgis",
            FeatureCollectionScope((-73.6, 41.1, -69.8, 42.9), 2_500, 1_000),
        ),
        created_by=USER_ID,
        created_at=NOW,
    )
    wfs = seal_copy_estimate(
        estimate_id=ESTIMATE_ID,
        project_id=PROJECT_ID,
        source_dataset_id=SOURCE_DATASET_ID,
        source_revision_number=3,
        spec=CopyEstimateSpec(
            "wfs",
            FeatureCollectionScope((-73.6, 41.1, -69.8, 42.9), 2_500, 1_000),
        ),
        created_by=USER_ID,
        created_at=NOW,
    )

    assert arcgis.capture_scope == {
        "kind": "bounded_features",
        "bounds": [-73.6, 41.1, -69.8, 42.9],
        "maximum_features": 2_500,
        "page_size": 1_000,
    }
    assert arcgis.copy_method == "bounded_feature_capture"
    assert arcgis.output_format == "geojson"
    assert arcgis.output_content_type == "application/geo+json"
    assert arcgis.maximum_requests == 4
    assert arcgis.maximum_output_bytes == 2_500 * 16_384 + 65_536
    assert arcgis.estimate_checksum_sha256 != wfs.estimate_checksum_sha256


def test_feature_estimate_rejects_unbounded_request_fanout_and_invalid_limits() -> None:
    for scope in (
        FeatureCollectionScope((-73.6, 41.1, -69.8, 42.9), 50_000, 500),
        FeatureCollectionScope((-73.6, 41.1, -69.8, 42.9), 1, 2_001),
        FeatureCollectionScope((-69.8, 42.9, -73.6, 41.1), 100, 100),
    ):
        with pytest.raises(ValueError):
            seal_copy_estimate(
                estimate_id=ESTIMATE_ID,
                project_id=PROJECT_ID,
                source_dataset_id=SOURCE_DATASET_ID,
                source_revision_number=3,
                spec=CopyEstimateSpec("arcgis", scope),
                created_by=USER_ID,
                created_at=NOW,
            )


def test_estimate_rejects_unbounded_images_and_wrong_scope_family() -> None:
    with pytest.raises(ValueError, match="pixel limit"):
        seal_copy_estimate(
            estimate_id=ESTIMATE_ID,
            project_id=PROJECT_ID,
            source_dataset_id=SOURCE_DATASET_ID,
            source_revision_number=3,
            spec=CopyEstimateSpec(
                "wms", WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 4096, 4097)
            ),
            created_by=USER_ID,
            created_at=NOW,
        )
    with pytest.raises(ValueError, match="exact-object"):
        seal_copy_estimate(
            estimate_id=ESTIMATE_ID,
            project_id=PROJECT_ID,
            source_dataset_id=SOURCE_DATASET_ID,
            source_revision_number=3,
            spec=CopyEstimateSpec(
                "pmtiles", WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 1, 1)
            ),
            created_by=USER_ID,
            created_at=NOW,
        )


def test_pmtiles_checksum_pins_exact_object_recipe_and_parameters() -> None:
    request = PmtilesDerivativeRequest(
        bounds=(-73.6, 41.1, -69.8, 42.9),
        minimum_zoom=4,
        maximum_zoom=14,
        source_layer="environmental_screening",
        idempotency_key=IDEMPOTENCY_KEY,
    )
    checksum = pmtiles_derivative_request_checksum(
        project_id=PROJECT_ID,
        dataset_id=SOURCE_DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        source_object_id=SOURCE_OBJECT_ID,
        request=request,
    )
    changed = pmtiles_derivative_request_checksum(
        project_id=PROJECT_ID,
        dataset_id=SOURCE_DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        source_object_id=SOURCE_OBJECT_ID,
        request=PmtilesDerivativeRequest(
            bounds=request.bounds,
            minimum_zoom=4,
            maximum_zoom=13,
            source_layer=request.source_layer,
            idempotency_key=IDEMPOTENCY_KEY,
        ),
    )
    same_request_new_retry_key = pmtiles_derivative_request_checksum(
        project_id=PROJECT_ID,
        dataset_id=SOURCE_DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        source_object_id=SOURCE_OBJECT_ID,
        request=PmtilesDerivativeRequest(
            bounds=request.bounds,
            minimum_zoom=request.minimum_zoom,
            maximum_zoom=request.maximum_zoom,
            source_layer=request.source_layer,
            idempotency_key=UUID("84000000-0000-4000-8000-000000000259"),
        ),
    )
    assert len(checksum) == 64
    assert checksum != changed
    assert checksum == same_request_new_retry_key


def test_repository_estimate_accepts_team_effective_editor_and_persists_no_url() -> None:
    transaction = FakeTransaction(
        [
            access_row(project_role="editor"),
            (
                "wms",
                {
                    "layers": ["screening"],
                    "format": "image/png",
                    "attribution": "MassGIS",
                },
            ),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", now=lambda: NOW
    )

    estimate = asyncio.run(
        repository.create_copy_estimate(
            context(),
            PROJECT_ID,
            SOURCE_DATASET_ID,
            3,
            CopyEstimateSpec("wms", WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 1024, 512)),
            "preservation-request-258",
        )
    )

    assert estimate.output_format == "png"
    inserted = next(
        call for call in transaction.calls if "external_source_copy_estimates" in call[1]
    )
    assert "https://" not in repr(inserted[2])
    event = transaction.calls[-1]
    assert event[2][-1].obj["estimate_checksum_sha256"] == estimate.estimate_checksum_sha256


def test_repository_rejects_jpeg_only_wms_before_sealing_an_unreachable_copy() -> None:
    transaction = FakeTransaction(
        [
            access_row(project_role="editor"),
            ("wms", {"layers": ["screening"], "format": "image/jpeg"}),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", now=lambda: NOW
    )

    with pytest.raises(DataPreservationConflict) as error:
        asyncio.run(
            repository.create_copy_estimate(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                3,
                CopyEstimateSpec(
                    "wms",
                    WmsBoundedImageScope((-73.6, 41.1, -69.8, 42.9), 1024, 512),
                ),
                "preservation-request-jpeg",
            )
        )
    assert error.value.code == "protected_copy_wms_png_required"


def test_repository_feature_estimate_cannot_exceed_registered_page_size() -> None:
    transaction = FakeTransaction(
        [
            access_row(project_role="editor"),
            (
                "arcgis",
                {
                    "object_id_field": "OBJECTID",
                    "fields": ["OBJECTID", "name"],
                    "geometry_type": "Point",
                    "page_size": 500,
                    "attribution": "Example",
                },
            ),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", now=lambda: NOW
    )

    with pytest.raises(DataPreservationConflict) as error:
        asyncio.run(
            repository.create_copy_estimate(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                3,
                CopyEstimateSpec(
                    "arcgis",
                    FeatureCollectionScope((-73.6, 41.1, -69.8, 42.9), 1_000, 1_000),
                ),
                "preservation-request-feature-page",
            )
        )
    assert error.value.code == "protected_copy_feature_scope_invalid"


def test_repository_denies_viewer_before_reading_source_revision() -> None:
    transaction = FakeTransaction([access_row(project_role="viewer")])
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", now=lambda: NOW
    )

    with pytest.raises(DataPreservationAccessDenied):
        asyncio.run(
            repository.create_copy_estimate(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                3,
                CopyEstimateSpec("pmtiles", ExactObjectScope()),
                "preservation-request-259",
            )
        )

    assert len(transaction.calls) == 1


def test_protected_copy_uses_server_bucket_and_persists_accepted_estimate() -> None:
    estimate = estimate_row()
    estimate_checksum = estimate[12]
    transaction = FakeTransaction(
        [
            access_row(project_role="editor", dataset_role=None),
            estimate,
            (None,),
            (None,),
            None,
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-managed-geodata", now=lambda: NOW
    )
    request = ProtectedCopyRequest(
        estimate_id=ESTIMATE_ID,
        estimate_checksum_sha256=estimate_checksum,
        idempotency_key=IDEMPOTENCY_KEY,
        destination_name="MassGIS screening snapshot",
        destination_description="Bounded reviewed source copy",
        destination_classification="public",
        rights_basis="MassGIS public data terms reviewed",
        attribution="MassGIS",
    )

    submission = asyncio.run(
        repository.request_protected_copy(
            context(), PROJECT_ID, SOURCE_DATASET_ID, 3, request, "preservation-request-260"
        )
    )

    assert submission.dispatch_required is True
    assert submission.job.destination_name == "MassGIS screening snapshot"
    job_insert = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "INSERT INTO app.external_source_snapshot_jobs" in call[1]
    )
    assert "opengeo-managed-geodata" in job_insert[2]
    assert "application_bucket" not in repr(job_insert[2])
    assert request.idempotency_key in job_insert[2]
    advisory_locks = [call for call in transaction.calls if "pg_advisory_xact_lock" in call[1]]
    assert len(advisory_locks) == 2
    assert "idempotency" in advisory_locks[0][2][0]
    assert "checksum" in advisory_locks[1][2][0]


def test_dataset_only_edit_grant_cannot_create_project_scoped_pmtiles_job() -> None:
    transaction = FakeTransaction([access_row(project_role=None, dataset_role="edit")])
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", now=lambda: NOW
    )
    request = PmtilesDerivativeRequest(
        bounds=(-73.6, 41.1, -69.8, 42.9),
        minimum_zoom=4,
        maximum_zoom=14,
        source_layer="environmental_screening",
        idempotency_key=IDEMPOTENCY_KEY,
    )

    with pytest.raises(DataPreservationAccessDenied):
        asyncio.run(
            repository.request_pmtiles_derivative(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                DATASET_VERSION_ID,
                request,
                "preservation-request-dataset-only",
            )
        )

    assert len(transaction.calls) == 1


@pytest.mark.parametrize(
    ("options", "preserved"),
    [
        (None, False),
        ({"extent": 8192, "attribute_names": ["name"]}, False),
        ({"extent": 8192, "attribute_names": ["name"]}, True),
    ],
)
def test_pmtiles_request_pins_original_object_and_server_checksum(options, preserved) -> None:
    transaction = FakeTransaction(
        [
            (*access_row(project_role="owner")[:-1], "draft" if preserved else "active"),
            (
                "preserved" if preserved else "active",
                SOURCE_OBJECT_ID,
                "application/geo+json",
                4096,
            ),
            *([(True,)] if preserved else []),
            (None,),
            (None,),
            None,
            *([({"ready": True, "reason": "ready"},)] if options is not None else []),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction),
        "opengeo-geodata",
        now=lambda: NOW,
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
        pmtiles_queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2",
    )
    request = PmtilesDerivativeRequest(
        bounds=(-73.6, 41.1, -69.8, 42.9),
        minimum_zoom=4,
        maximum_zoom=14,
        source_layer="environmental_screening",
        idempotency_key=IDEMPOTENCY_KEY,
        options=options,
    )

    submission = asyncio.run(
        repository.request_pmtiles_derivative(
            context(),
            PROJECT_ID,
            SOURCE_DATASET_ID,
            DATASET_VERSION_ID,
            request,
            "preservation-request-261",
        )
    )

    assert submission.job.source_object_id == SOURCE_OBJECT_ID
    assert len(submission.job.request_checksum_sha256) == 64
    job_insert = next(
        call
        for call in transaction.calls
        if call[0] == "execute" and "INSERT INTO app.pmtiles_derivative_jobs" in call[1]
    )
    assert SOURCE_OBJECT_ID in job_insert[2]
    assert request.idempotency_key in job_insert[2]
    eligibility = [
        call for call in transaction.calls if "pmtiles_preserved_original_eligible" in call[1]
    ]
    if preserved:
        assert eligibility[0][2] == (
            ORG_ID,
            PROJECT_ID,
            SOURCE_DATASET_ID,
            DATASET_VERSION_ID,
            SOURCE_OBJECT_ID,
        )
    else:
        assert eligibility == []
    if options is not None:
        from opengeo_api.pmtiles_options import normalize_pmtiles_options

        assert submission.job.options == normalize_pmtiles_options(options)
        assert submission.job.worker_image_digest == "sha256:" + "d" * 64
        assert job_insert[2][-1] == submission.job.worker_image_digest
        assert submission.job.request_checksum_sha256 == pmtiles_derivative_request_checksum(
            project_id=PROJECT_ID,
            dataset_id=SOURCE_DATASET_ID,
            dataset_version_id=DATASET_VERSION_ID,
            source_object_id=SOURCE_OBJECT_ID,
            request=replace(request, worker_image_digest=submission.job.worker_image_digest),
        )
    else:
        assert submission.job.worker_image_digest is None
        assert job_insert[2][-2:] == (None, None)


@pytest.mark.parametrize("options", [None, {}])
def test_preserved_original_requires_v2_and_database_preservation_seal(options) -> None:
    transaction = FakeTransaction(
        [
            (*access_row(project_role="owner")[:-1], "draft"),
            ("preserved", SOURCE_OBJECT_ID, "application/geo+json", 4096),
            *([(False,)] if options is not None else []),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction),
        "opengeo-geodata",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
    )
    request = PmtilesDerivativeRequest(
        (-73.6, 41.1, -69.8, 42.9), 4, 14, "features", IDEMPOTENCY_KEY, options=options
    )
    with pytest.raises(DataPreservationConflict, match="source_ineligible"):
        asyncio.run(
            repository.request_pmtiles_derivative(
                context(), PROJECT_ID, SOURCE_DATASET_ID, DATASET_VERSION_ID, request, "unsealed"
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)
    assert len(transaction.calls) == (3 if options is not None else 2)


def test_unconfigured_v2_runtime_rejects_before_any_database_mutation() -> None:
    transaction = FakeTransaction([])
    repository = PostgresDataPreservationRepository(FakeExecutor(transaction), "opengeo-geodata")
    request = PmtilesDerivativeRequest(
        (-73.6, 41.1, -69.8, 42.9), 4, 14, "features", IDEMPOTENCY_KEY, options={}
    )
    with pytest.raises(DataPreservationStoreUnavailable, match="runtime image is not configured"):
        asyncio.run(
            repository.request_pmtiles_derivative(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                DATASET_VERSION_ID,
                request,
                "unconfigured-v2",
            )
        )
    assert transaction.calls == []


def test_unprobed_input_driver_rejects_before_a_job_insert() -> None:
    transaction = FakeTransaction([(*access_row(project_role="owner")[:5], "geoparquet", "active")])
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction),
        "opengeo-geodata",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
    )
    request = PmtilesDerivativeRequest(
        (-73.6, 41.1, -69.8, 42.9), 4, 14, "features", IDEMPOTENCY_KEY, options={}
    )
    with pytest.raises(DataPreservationConflict, match="source_format_unavailable"):
        asyncio.run(
            repository.request_pmtiles_derivative(
                context(),
                PROJECT_ID,
                SOURCE_DATASET_ID,
                DATASET_VERSION_ID,
                request,
                "unprobed-driver",
            )
        )
    assert len(transaction.calls) == 1


@pytest.mark.parametrize(
    "reason",
    ["runtime_disabled", "runtime_not_ready", "runtime_budget_exhausted", "runtime_job_pending"],
)
def test_pmtiles_admission_rejects_before_new_job_insert(reason) -> None:
    transaction = FakeTransaction(
        [
            access_row(project_role="owner"),
            ("active", SOURCE_OBJECT_ID, "application/geo+json", 4096),
            (None,),
            (None,),
            None,
            ({"ready": False, "reason": reason},),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction),
        "opengeo-geodata",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
        pmtiles_queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2",
    )
    request = PmtilesDerivativeRequest(
        (-73.6, 41.1, -69.8, 42.9), 4, 14, "features", IDEMPOTENCY_KEY, options={}
    )
    with pytest.raises(DataPreservationConflict, match=reason):
        asyncio.run(
            repository.request_pmtiles_derivative(
                context(), PROJECT_ID, SOURCE_DATASET_ID, DATASET_VERSION_ID, request, "not-ready"
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)
    assert transaction.calls[-1][1] == "SELECT app.pmtiles_v2_admission(%s, %s, %s)"
    assert transaction.calls[-1][2][-1] is True


def test_pmtiles_existing_same_key_job_returns_without_requiring_another_window() -> None:
    from opengeo_api.pmtiles_options import normalize_pmtiles_options

    digest = "sha256:" + "d" * 64
    request = PmtilesDerivativeRequest(
        (-73.6, 41.1, -69.8, 42.9),
        4,
        14,
        "features",
        IDEMPOTENCY_KEY,
        options={},
        worker_image_digest=digest,
    )
    checksum = pmtiles_derivative_request_checksum(
        project_id=PROJECT_ID,
        dataset_id=SOURCE_DATASET_ID,
        dataset_version_id=DATASET_VERSION_ID,
        source_object_id=SOURCE_OBJECT_ID,
        request=request,
    )
    row = (
        UUID("87000000-0000-4000-8000-000000000001"),
        PROJECT_ID,
        SOURCE_DATASET_ID,
        DATASET_VERSION_ID,
        SOURCE_OBJECT_ID,
        list(request.bounds),
        4,
        14,
        "features",
        checksum,
        IDEMPOTENCY_KEY,
        "queued",
        None,
        None,
        None,
        None,
        0,
        USER_ID,
        NOW,
        None,
        None,
        normalize_pmtiles_options({}),
        digest,
    )
    transaction = FakeTransaction(
        [
            access_row(project_role="owner"),
            ("active", SOURCE_OBJECT_ID, "application/geo+json", 4096),
            (None,),
            (None,),
            row,
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-geodata", pmtiles_worker_image_digest=digest
    )
    result = asyncio.run(
        repository.request_pmtiles_derivative(
            context(), PROJECT_ID, SOURCE_DATASET_ID, DATASET_VERSION_ID, request, "existing-job"
        )
    )
    assert result.job.job_id == row[0]
    assert result.dispatch_required is True
    assert not any(
        "pmtiles_v2_admission" in call[1] or call[0] == "execute" for call in transaction.calls
    )


def test_pmtiles_capability_read_is_read_only_and_uses_the_same_server_binding() -> None:
    transaction = FakeTransaction([({"ready": False, "reason": "runtime_budget_exhausted"},)])
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction),
        "opengeo-geodata",
        pmtiles_worker_image_digest="sha256:" + "d" * 64,
        pmtiles_queue_url="https://sqs.us-east-1.amazonaws.com/111111111111/pmtiles-v2",
    )
    assert asyncio.run(repository.pmtiles_admission_status(context())) == {
        "ready": False,
        "reason": "runtime_budget_exhausted",
    }
    assert len(transaction.calls) == 1
    assert transaction.calls[0][2][-1] is False


def test_capture_refresh_reuses_target_without_rewriting_layer_metadata():
    estimate = list(estimate_row())
    estimate[4:9] = [
        "arcgis",
        "bounded_feature_capture",
        {"kind": "bounded_features", "maximum_features": 3},
        "geojson",
        "application/geo+json",
    ]
    target = UUID("80000000-0000-4000-8000-000000000299")
    transaction = FakeTransaction(
        [
            access_row(project_role="editor"),
            access_row(project_role="editor"),
            tuple(estimate),
            (None,),
            (None,),
            None,
            ("Existing Layer", "internal"),
        ]
    )
    repository = PostgresDataPreservationRepository(
        FakeExecutor(transaction), "opengeo-managed-geodata", now=lambda: NOW
    )
    request = ProtectedCopyRequest(
        estimate_id=ESTIMATE_ID,
        estimate_checksum_sha256=estimate[12],
        idempotency_key=IDEMPOTENCY_KEY,
        destination_name="Ignored new title",
        destination_description=None,
        destination_classification="public",
        rights_basis="Reviewed",
        attribution="Provider",
        target_dataset_id=target,
        expected_base_version_id=DATASET_VERSION_ID,
    )
    submission = asyncio.run(
        repository.request_protected_copy(
            context(), PROJECT_ID, SOURCE_DATASET_ID, 3, request, "refresh-fixture"
        )
    )
    assert submission.job.destination_dataset_id == target
    assert submission.job.destination_name == "Existing Layer"
    assert submission.job.destination_classification == "internal"
    assert not any("INSERT INTO app.datasets" in call[1] for call in transaction.calls)
    assert not any("INSERT INTO app.project_datasets" in call[1] for call in transaction.calls)
    inserted = next(
        call
        for call in transaction.calls
        if "INSERT INTO app.external_source_snapshot_jobs" in call[1]
    )
    assert inserted[2][-1] == DATASET_VERSION_ID
