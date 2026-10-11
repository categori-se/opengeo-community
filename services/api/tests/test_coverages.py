import asyncio
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.coverages import (
    CoverageAccessDenied,
    CoverageConflict,
    CoverageDerivativeSpec,
    PostgresCoverageRepository,
)
from opengeo_api.s3_downloads import DownloadTicket, ExactObject
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000181")
USER_ID = UUID("20000000-0000-4000-8000-000000000181")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000181")
SERVICE_ID = UUID("60000000-0000-4000-8000-000000000181")
COVERAGE_ID = UUID("70000000-0000-4000-8000-000000000181")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000181")
DATASET_VERSION_ID = UUID("82000000-0000-4000-8000-000000000181")
OBJECT_ID = UUID("81000000-0000-4000-8000-000000000181")
DERIVATIVE_ID = UUID("71000000-0000-4000-8000-000000000181")
DERIVATIVE_OBJECT_ID = UUID("81100000-0000-4000-8000-000000000181")
RECLAMATION_ID = UUID("71100000-0000-4000-8000-000000000181")
NEXT_VERSION_ID = UUID("82000000-0000-4000-8000-000000000182")
NOW = datetime(2026, 8, 21, 17, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, rows) -> None:
        self.rows = deque(rows)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.rows, f"unexpected fetch_one: {statement}"
        return self.rows.popleft()

    async def fetch_all(self, statement, parameters=()):
        del statement, parameters
        raise AssertionError("fetch_all not expected")

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class FakeExecutor:
    def __init__(self, transactions) -> None:
        self.transactions = deque(transactions)

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transactions.popleft())

    async def fetch_one(self, context, statement, parameters=()):
        del context, statement, parameters
        raise AssertionError("direct fetch not expected")


class FakeStorage:
    def __init__(self) -> None:
        self.specs = []
        self.exact_specs = []

    async def create_download_url(self, spec):
        self.specs.append(spec)
        return DownloadTicket(
            "https://geodata.example.test/elevation.tif?versionId=source-v4",
            "GET",
            NOW + timedelta(minutes=5),
        )

    async def read_exact_object(self, spec):
        self.exact_specs.append(spec)
        return ExactObject(
            b"II*\x00exact-raster",
            spec.content_type,
            spec.size_bytes,
            spec.checksum_sha256,
            spec.version_id,
        )


def context() -> TenantContext:
    return TenantContext(USER_ID, ORG_ID)


def coverage_row(
    *,
    current_version_id: UUID = DATASET_VERSION_ID,
    current_version_number: int = 4,
) -> tuple[Any, ...]:
    return (
        COVERAGE_ID,
        PROJECT_ID,
        SERVICE_ID,
        "elevation",
        DATASET_ID,
        DATASET_VERSION_ID,
        OBJECT_ID,
        4,
        "EPSG:4326",
        [-77.25, 38.75, -76.75, 39.25],
        512,
        256,
        1,
        [{"index": 1, "data_type": "UInt16", "color_interpretation": "Gray"}],
        "geodata-test",
        "organizations/o/projects/p/datasets/d/elevation.tif",
        "source-v4",
        "image/tiff",
        4096,
        "a" * 64,
        current_version_id,
        current_version_number,
        "Elevation",
        "Validated exact COG",
        USER_ID,
        NOW,
        None,
        None,
        True,
        None,
    )


def derivative_row() -> tuple[Any, ...]:
    return (
        DERIVATIVE_ID,
        PROJECT_ID,
        SERVICE_ID,
        COVERAGE_ID,
        "elevation",
        [-77.2, 38.8, -76.8, 39.2],
        "EPSG:3857",
        256,
        128,
        "bilinear",
        2,
        [1],
        "size",
        None,
        "b" * 64,
        "completed",
        DERIVATIVE_OBJECT_ID,
        "EPSG:3857",
        [-8590000, 4690000, -8550000, 4750000],
        256,
        128,
        1,
        [{"index": 1, "source_index": 1, "data_type": "UInt16"}],
        "image/tiff",
        8192,
        "c" * 64,
        "geodata-test",
        "organizations/o/projects/p/datasets/d/versions/v/derivatives/coverages/job.tif",
        "derived-v1",
        None,
        1,
        USER_ID,
        NOW - timedelta(days=2),
        NOW - timedelta(days=2),
        NOW - timedelta(days=2),
        True,
        None,
        True,
    )


def reclamation_row(preview_checksum: str, expires_at: datetime) -> tuple[Any, ...]:
    return (
        RECLAMATION_ID,
        DERIVATIVE_ID,
        DERIVATIVE_OBJECT_ID,
        "queued",
        8192,
        "c" * 64,
        preview_checksum,
        expires_at,
        None,
        0,
        None,
        USER_ID,
        NOW,
        None,
        None,
    )


def test_exact_download_reauthorizes_and_attributes_the_sealed_s3_version() -> None:
    prepare = FakeTransaction([("member", "viewer"), coverage_row()])
    attribute = FakeTransaction([("member", "viewer"), coverage_row()])
    storage = FakeStorage()
    repository = PostgresCoverageRepository(FakeExecutor([prepare, attribute]), storage)

    ticket = asyncio.run(
        repository.request_coverage_download(
            context(), PROJECT_ID, "earth-observation", "elevation", "coverage-request-181"
        )
    )

    assert ticket.method == "GET"
    assert storage.specs[0].bucket == "geodata-test"
    assert storage.specs[0].version_id == "source-v4"
    assert storage.specs[0].filename == "elevation.tif"
    event = next(call for call in attribute.calls if call[0] == "execute")
    assert "spatial_service.coverage.download.issued" in event[2]
    assert event[2][-1].obj["checksum_sha256"] == "a" * 64


def test_exact_download_discards_ticket_when_target_changes_after_signing() -> None:
    prepare = FakeTransaction([("member", "viewer"), coverage_row()])
    changed = FakeTransaction(
        [
            ("member", "viewer"),
            coverage_row(
                current_version_id=NEXT_VERSION_ID,
                current_version_number=5,
            ),
        ]
    )
    storage = FakeStorage()
    repository = PostgresCoverageRepository(FakeExecutor([prepare, changed]), storage)

    with pytest.raises(CoverageConflict, match="target_changed"):
        asyncio.run(
            repository.request_coverage_download(
                context(), PROJECT_ID, "earth-observation", "elevation", "coverage-request-182"
            )
        )

    assert len(storage.specs) == 1
    assert all(call[0] != "execute" for call in changed.calls)


def test_exact_download_denies_before_resolving_or_signing() -> None:
    denied = FakeTransaction([("guest", None)])
    storage = FakeStorage()
    repository = PostgresCoverageRepository(FakeExecutor([denied]), storage)

    with pytest.raises(CoverageAccessDenied):
        asyncio.run(
            repository.request_coverage_download(
                context(), PROJECT_ID, "earth-observation", "elevation", "coverage-request-183"
            )
        )

    assert storage.specs == []
    assert len(denied.calls) == 1


def test_bounded_coverage_read_reauthorizes_the_exact_object_without_writes() -> None:
    prepare = FakeTransaction([("member", "viewer"), coverage_row()])
    verify = FakeTransaction([("member", "viewer"), coverage_row()])
    storage = FakeStorage()
    repository = PostgresCoverageRepository(FakeExecutor([prepare, verify]), storage)

    exact = asyncio.run(
        repository.read_coverage_object(
            context(), PROJECT_ID, "earth-observation", "elevation", 3_000_000
        )
    )

    assert exact.body == b"II*\x00exact-raster"
    assert exact.checksum_sha256 == "a" * 64
    assert storage.exact_specs[0].version_id == "source-v4"
    assert storage.exact_specs[0].maximum_bytes == 3_000_000
    assert all(call[0] != "execute" for call in prepare.calls + verify.calls)


def test_prepared_derivative_lookup_is_read_only_and_exact() -> None:
    transaction = FakeTransaction([("member", "viewer"), coverage_row(), derivative_row()])
    repository = PostgresCoverageRepository(FakeExecutor([transaction]), FakeStorage())
    request = CoverageDerivativeSpec(
        subset_extent=(-77.2, 38.8, -76.8, 39.2),
        target_crs="EPSG:3857",
        width=256,
        height=128,
        resolution=None,
        band_indexes=(1,),
        resampling="bilinear",
    )

    found = asyncio.run(
        repository.find_derivative(context(), PROJECT_ID, SERVICE_ID, COVERAGE_ID, request)
    )

    assert found is not None
    assert found.job_id == DERIVATIVE_ID
    assert found.output_checksum_sha256 == "c" * 64
    assert all(call[0] != "execute" for call in transaction.calls)
    lookup = transaction.calls[-1]
    assert lookup[0] == "one"
    assert lookup[2][4].obj == [-77.2, 38.8, -76.8, 39.2]
    assert lookup[2][10].obj == [1]


def test_prepared_derivative_lookup_returns_none_on_an_exact_cache_miss() -> None:
    transaction = FakeTransaction([("member", "viewer"), coverage_row(), None])
    repository = PostgresCoverageRepository(FakeExecutor([transaction]), FakeStorage())

    found = asyncio.run(
        repository.find_derivative(
            context(),
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
            CoverageDerivativeSpec(
                subset_extent=(-77.1, 38.9, -76.9, 39.1),
                target_crs="EPSG:4326",
                width=205,
                height=103,
                resolution=None,
                band_indexes=None,
                resampling="nearest",
            ),
        )
    )

    assert found is None
    assert all(call[0] != "execute" for call in transaction.calls)


def test_reclamation_preview_is_opaque_and_confirmation_queues_persisted_exact_plan() -> None:
    preview_transaction = FakeTransaction([("member", "owner"), derivative_row()])
    storage = FakeStorage()
    preview_repository = PostgresCoverageRepository(
        FakeExecutor([preview_transaction]), storage, now=lambda: NOW
    )

    preview = asyncio.run(
        preview_repository.preview_derivative_reclamation(
            context(), PROJECT_ID, SERVICE_ID, COVERAGE_ID, DERIVATIVE_ID
        )
    )

    assert preview.output_object_id == DERIVATIVE_OBJECT_ID
    assert preview.expires_at == NOW + timedelta(minutes=15)
    assert len(preview.preview_checksum_sha256) == 64
    confirm_transaction = FakeTransaction(
        [
            ("member", "owner"),
            None,
            derivative_row(),
            (RECLAMATION_ID,),
            reclamation_row(preview.preview_checksum_sha256, preview.expires_at),
        ]
    )
    repository = PostgresCoverageRepository(
        FakeExecutor([confirm_transaction]), storage, now=lambda: NOW
    )
    submission = asyncio.run(
        repository.confirm_derivative_reclamation(
            context(),
            PROJECT_ID,
            SERVICE_ID,
            COVERAGE_ID,
            DERIVATIVE_ID,
            preview.preview_checksum_sha256,
            preview.expires_at,
            "coverage-reclaim-181",
        )
    )

    assert submission.dispatch_required is True
    assert submission.reclamation.reclamation_id == RECLAMATION_ID
    queue_call = next(
        call
        for call in confirm_transaction.calls
        if "queue_spatial_coverage_derivative_reclamation" in call[1]
    )
    assert queue_call[2][4] == DERIVATIVE_ID
    assert queue_call[2][5] == preview.preview_checksum_sha256
    assert "sealed_bucket" not in queue_call[1]
