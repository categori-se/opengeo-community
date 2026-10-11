import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.features import FeatureDraft
from opengeo_api.field_capture import FieldCaptureConflict, PostgresFieldCaptureRepository
from opengeo_api.tenant_database import TenantContext

ORG_ID = UUID("10000000-0000-4000-8000-000000000173")
USER_ID = UUID("20000000-0000-4000-8000-000000000173")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000173")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000173")
FEATURE_ID = UUID("90000000-0000-4000-8000-000000000173")
FORM_ID = UUID("a0000000-0000-4000-8000-000000000173")
SUBMISSION_ID = UUID("b0000000-0000-4000-8000-000000000173")
LOCK_TOKEN = UUID("c0000000-0000-4000-8000-000000000173")
OTHER_USER_ID = UUID("20000000-0000-4000-8000-000000000174")
NOW = datetime(2026, 9, 1, 12, tzinfo=UTC)
GEOMETRY = {"type": "Point", "coordinates": [-71.06, 42.36]}
PROPERTIES = {"name": "Inspected station"}


class ScriptedTransaction:
    def __init__(self, rows: list[tuple[Any, ...] | None]) -> None:
        self.rows = deque(rows)
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        self.calls.append(("one", statement, tuple(parameters)))
        assert self.rows, f"unexpected fetch_one: {statement}"
        return self.rows.popleft()

    async def fetch_all(self, statement: str, parameters=()):
        raise AssertionError(f"unexpected fetch_all: {statement} {parameters}")

    async def execute(self, statement: str, parameters=()):
        self.calls.append(("execute", statement, tuple(parameters)))
        return 1


class ScriptedExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        return await operation(self.transaction)


def submission_row(*, state: str, review_version: int):
    return (
        SUBMISSION_ID,
        DATASET_ID,
        FORM_ID,
        1,
        None,
        "update",
        FEATURE_ID,
        3,
        "a" * 64,
        "Point",
        GEOMETRY,
        PROPERTIES,
        state,
        review_version,
        USER_ID,
        NOW,
        USER_ID if state != "submitted" else None,
        NOW if state != "submitted" else None,
        "Reviewed" if state == "accepted" else None,
        FEATURE_ID if state == "accepted" else None,
    )


def feature_row(version: int, properties: dict[str, Any] = PROPERTIES):
    return (
        FEATURE_ID,
        version,
        "Point",
        properties,
        GEOMETRY,
        (-71.06, 42.36, -71.06, 42.36),
        USER_ID,
        NOW,
        USER_ID,
        NOW,
    )


def test_exact_base_update_promotion_uses_the_postgres_mutation_path() -> None:
    transaction = ScriptedTransaction(
        [
            ("member", "editor", None, False, "active", "geojson"),
            submission_row(state="in_review", review_version=2),
            (
                DATASET_ID,
                "Point",
                {
                    "schemaVersion": "1.0.0",
                    "fields": [{"name": "name", "type": "string", "required": True}],
                },
                8,
                1,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            ),
            feature_row(3, {"name": "Existing station"}),
            None,
            feature_row(4),
            (9, 1, NOW),
            submission_row(state="accepted", review_version=3),
        ]
    )
    repository = PostgresFieldCaptureRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    result = asyncio.run(
        repository.review_submission(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            SUBMISSION_ID,
            2,
            "accept",
            "Reviewed",
            "field-update-review-173",
        )
    )

    assert result.submission.state == "accepted"
    assert result.submission.promoted_feature_id == FEATURE_ID
    assert result.promotion is not None
    assert result.promotion.feature.feature_id == FEATURE_ID
    assert result.promotion.feature.version_number == 4
    assert result.promotion.collection.generation == 9
    assert result.promotion.collection.feature_count == 1
    assert not transaction.rows

    feature_update = next(
        call for call in transaction.calls if "UPDATE app.dataset_features" in call[1]
    )
    assert feature_update[2][0] == 4
    assert feature_update[2][-1] == 3
    collection_update = next(
        call for call in transaction.calls if "UPDATE app.feature_collections" in call[1]
    )
    assert collection_update[2][0] == 0
    revision = next(
        call for call in transaction.calls if "INSERT INTO app.dataset_feature_revisions" in call[1]
    )
    assert revision[2][2:5] == (FEATURE_ID, 4, "update")


def test_exact_base_field_update_cannot_bypass_an_active_feature_lock() -> None:
    transaction = ScriptedTransaction(
        [
            ("member", "editor", None, False, "active", "geojson"),
            submission_row(state="in_review", review_version=2),
            (
                DATASET_ID,
                "Point",
                {
                    "schemaVersion": "1.0.0",
                    "fields": [{"name": "name", "type": "string", "required": True}],
                },
                8,
                1,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            ),
            feature_row(3, {"name": "Existing station"}),
            (LOCK_TOKEN, OTHER_USER_ID, 3),
        ]
    )
    repository = PostgresFieldCaptureRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    with pytest.raises(FieldCaptureConflict) as conflict:
        asyncio.run(
            repository.review_submission(
                TenantContext(USER_ID, ORG_ID),
                PROJECT_ID,
                DATASET_ID,
                SUBMISSION_ID,
                2,
                "accept",
                "Reviewed",
                "field-update-review-locked-173",
            )
        )

    assert conflict.value.code == "field_submission_target_locked"
    assert conflict.value.current_version == 3
    assert not transaction.rows
    assert not any(
        "UPDATE app.dataset_features" in statement
        for _kind, statement, _parameters in transaction.calls
    )


def test_update_submission_insert_seals_operation_target_and_base() -> None:
    transaction = ScriptedTransaction(
        [
            ("member", "editor", None, False, "active", "geojson"),
            (
                FORM_ID,
                DATASET_ID,
                1,
                "Station inspection",
                None,
                8,
                "Point",
                {
                    "schemaVersion": "1.0.0",
                    "fields": [{"name": "name", "type": "string", "required": True}],
                },
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            ),
            (3, None),
            None,
            submission_row(state="submitted", review_version=1),
        ]
    )
    repository = PostgresFieldCaptureRepository(ScriptedExecutor(transaction))  # type: ignore[arg-type]

    receipt = asyncio.run(
        repository.create_submission(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            DATASET_ID,
            FORM_ID,
            1,
            SUBMISSION_ID,
            None,
            "update",
            FEATURE_ID,
            3,
            FeatureDraft(
                FEATURE_ID,
                "Point",
                GEOMETRY,
                (-71.06, 42.36, -71.06, 42.36),
                PROPERTIES,
            ),
            "field-update-submit-173",
        )
    )

    assert receipt.created is True
    assert receipt.submission.operation == "update"
    assert receipt.submission.target_feature_id == FEATURE_ID
    assert receipt.submission.target_feature_version == 3
    assert not transaction.rows
    insert = next(
        call for call in transaction.calls if "INSERT INTO app.field_submissions" in call[1]
    )
    assert insert[1].count("%s") == len(insert[2]) == 15
    assert insert[2][6:9] == ("update", FEATURE_ID, 3)
