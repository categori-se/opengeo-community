import asyncio
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from opengeo_api.spatial_services import PostgresSpatialServiceRepository
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000190")
USER_ID = UUID("20000000-0000-4000-8000-000000000190")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000190")
SERVICE_ID = UUID("60000000-0000-4000-8000-000000000190")
BINDING_ID = UUID("61000000-0000-4000-8000-000000000190")
CACHE_ID = UUID("62000000-0000-4000-8000-000000000190")
CACHE_VERSION_ID = UUID("63000000-0000-4000-8000-000000000190")
RECLAMATION_ID = UUID("64000000-0000-4000-8000-000000000190")
NOW = datetime(2026, 8, 21, 17, tzinfo=UTC)


class FakeTransaction:
    def __init__(self, rows, row_sets) -> None:
        self.rows = deque(rows)
        self.row_sets = deque(row_sets)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.rows, f"unexpected fetch_one: {statement}"
        return self.rows.popleft()

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, tuple(parameters)))
        assert self.row_sets, f"unexpected fetch_all: {statement}"
        return self.row_sets.popleft()

    async def execute(self, statement, parameters=()):
        del statement, parameters
        raise AssertionError("execute not expected")


class FakeExecutor:
    def __init__(self, transactions) -> None:
        self.transactions = deque(transactions)

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transactions.popleft())


def candidate_rows() -> list[tuple[Any, ...]]:
    return [
        (
            UUID(int=index + 1),
            UUID(int=index + 101),
            1_000 + index,
            f"{index:064x}",
            NOW - timedelta(days=2) + timedelta(minutes=index),
        )
        for index in range(65)
    ]


def reclamation_row(checksum: str, expires_at: datetime) -> tuple[Any, ...]:
    return (
        RECLAMATION_ID,
        CACHE_ID,
        CACHE_VERSION_ID,
        1,
        64,
        sum(1_000 + index for index in range(64)),
        "queued",
        None,
        0,
        0,
        0,
        checksum,
        expires_at,
        USER_ID,
        NOW,
        None,
        None,
    )


def test_preview_and_confirmation_queue_only_one_bounded_opaque_batch() -> None:
    targets = candidate_rows()
    preview_transaction = FakeTransaction([("member", "owner"), (CACHE_ID, 1)], [targets])
    preview_repository = PostgresSpatialServiceRepository(
        FakeExecutor([preview_transaction]), now=lambda: NOW
    )

    preview = asyncio.run(
        preview_repository.preview_tile_cache_reclamation(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
            CACHE_VERSION_ID,
        )
    )

    assert preview.target_count == 64
    assert preview.remaining_eligible_target_count == 1
    assert preview.target_size_bytes == sum(1_000 + index for index in range(64))
    assert preview.expires_at == NOW + timedelta(minutes=15)
    assert len(preview.preview_checksum_sha256) == 64

    confirm_transaction = FakeTransaction(
        [
            ("member", "owner"),
            None,
            (CACHE_ID, 1),
            (RECLAMATION_ID,),
            reclamation_row(preview.preview_checksum_sha256, preview.expires_at),
        ],
        [targets],
    )
    repository = PostgresSpatialServiceRepository(
        FakeExecutor([confirm_transaction]), now=lambda: NOW
    )
    submission = asyncio.run(
        repository.confirm_tile_cache_reclamation(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
            CACHE_VERSION_ID,
            preview.preview_checksum_sha256,
            preview.expires_at,
            "tile-cache-reclaim-190",
        )
    )

    assert submission.dispatch_required is True
    assert submission.reclamation.reclamation_id == RECLAMATION_ID
    queue_call = next(
        call
        for call in confirm_transaction.calls
        if "queue_spatial_tile_cache_reclamation" in call[1]
    )
    assert queue_call[2][5] == [row[0] for row in targets[:64]]
    assert len(queue_call[2][5]) == 64
    assert "storage_bucket" not in queue_call[1]
    assert "storage_key" not in queue_call[1]
    assert "storage_version_id" not in queue_call[1]
