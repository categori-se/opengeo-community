import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.resource_ratings import (
    PostgresResourceRatingRepository,
    ResourceRatingConflict,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000080")
ORG_ID = UUID("10000000-0000-4000-8000-000000000080")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000080")
RESOURCE_ID = UUID("90000000-0000-4000-8000-000000000080")
NOW = datetime(2026, 9, 3, 12, tzinfo=UTC)
CONTEXT = TenantContext(USER_ID, ORG_ID)


class ScriptedTransaction:
    def __init__(self, rows: list[tuple[Any, ...] | None]) -> None:
        self.rows = deque(rows)
        self.fetches: list[tuple[str, tuple[Any, ...]]] = []
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        self.fetches.append((statement, tuple(parameters)))
        return self.rows.popleft()

    async def fetch_all(self, statement: str, parameters=()):
        del statement, parameters
        raise AssertionError("rating operations do not list identity rows")

    async def execute(self, statement: str, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class SingleTransactionExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == CONTEXT
        return await operation(self.transaction)


def roles_row(project_role: str = "viewer") -> tuple[Any, ...]:
    return ("member", project_role, None, False)


def summary_row(
    count: int,
    total: int,
    caller_score: int | None,
    caller_version: int | None,
    withdrawn_at: datetime | None = None,
) -> tuple[Any, ...]:
    return (count, total, NOW, caller_score, caller_version, withdrawn_at)


def repository(transaction: ScriptedTransaction) -> PostgresResourceRatingRepository:
    return PostgresResourceRatingRepository(SingleTransactionExecutor(transaction))


def test_reads_identity_free_aggregate_with_only_the_callers_private_rating() -> None:
    transaction = ScriptedTransaction([roles_row(), summary_row(4, 18, 5, 2)])

    summary = asyncio.run(repository(transaction).get_summary(CONTEXT, PROJECT_ID, RESOURCE_ID))

    assert summary.rating_count == 4
    assert summary.rating_average == 4.5
    assert summary.caller_score == 5
    assert summary.caller_version == 2
    assert summary.caller_withdrawn is False
    statement, parameters = transaction.fetches[1]
    assert "rating.user_id = %s" in statement
    assert "rating_count" in statement
    assert parameters[0] == USER_ID


def test_creates_one_private_rating_and_records_attributed_activity() -> None:
    transaction = ScriptedTransaction([roles_row(), None, summary_row(1, 5, 5, 1)])

    receipt = asyncio.run(
        repository(transaction).set_rating(
            CONTEXT, PROJECT_ID, RESOURCE_ID, 5, None, "request-rating-80"
        )
    )

    assert receipt.changed is True
    assert receipt.summary.caller_score == 5
    assert len(transaction.executions) == 2
    assert "INSERT INTO app.governed_resource_ratings" in transaction.executions[0][0]
    assert transaction.executions[0][1] == (ORG_ID, PROJECT_ID, RESOURCE_ID, USER_ID, 5)
    assert transaction.executions[1][1][3] == "resource.rating.created"
    assert transaction.executions[1][1][5] == "request-rating-80"


def test_withdraws_without_deleting_identity_or_history() -> None:
    transaction = ScriptedTransaction([roles_row(), (4, 3, None), summary_row(2, 8, None, 4, NOW)])

    receipt = asyncio.run(
        repository(transaction).set_rating(
            CONTEXT, PROJECT_ID, RESOURCE_ID, None, 3, "request-rating-withdraw-80"
        )
    )

    assert receipt.changed is True
    assert receipt.summary.caller_withdrawn is True
    update, event = transaction.executions
    assert "UPDATE app.governed_resource_ratings" in update[0]
    assert "DELETE" not in update[0]
    assert event[1][3] == "resource.rating.withdrawn"


def test_rejects_stale_or_out_of_range_rating_before_mutation() -> None:
    stale = ScriptedTransaction([roles_row(), (4, 3, None)])
    with pytest.raises(ResourceRatingConflict) as stale_error:
        asyncio.run(
            repository(stale).set_rating(
                CONTEXT, PROJECT_ID, RESOURCE_ID, 5, 2, "request-rating-stale-80"
            )
        )
    assert stale_error.value.code == "resource_rating_version_conflict"
    assert stale_error.value.current_version == 3
    assert stale.executions == []

    invalid = ScriptedTransaction([])
    with pytest.raises(ResourceRatingConflict, match="resource_rating_score_invalid"):
        asyncio.run(
            repository(invalid).set_rating(
                CONTEXT, PROJECT_ID, RESOURCE_ID, 6, None, "request-rating-invalid-80"
            )
        )
    assert invalid.fetches == []
