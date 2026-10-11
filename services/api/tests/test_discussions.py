import asyncio
from collections import deque
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.discussions import (
    DiscussionAccessDenied,
    DiscussionConflict,
    DiscussionNotFound,
    FeatureDiscussionTarget,
    ObjectDiscussionTarget,
    PostgresDiscussionRepository,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000075")
ORG_ID = UUID("10000000-0000-4000-8000-000000000075")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000075")
DISCUSSION_ID = UUID("d5000000-0000-4000-8000-000000000075")
COMMENT_ID = UUID("c5000000-0000-4000-8000-000000000075")
MAP_ID = UUID("60000000-0000-4000-8000-000000000075")
DATASET_ID = UUID("70000000-0000-4000-8000-000000000075")
FEATURE_ID = UUID("80000000-0000-4000-8000-000000000075")
PARTICIPANT_ID = UUID("20000000-0000-4000-8000-000000000079")
NOTIFICATION_ID = UUID("e5000000-0000-4000-8000-000000000079")
NOW = datetime(2026, 9, 2, 16, tzinfo=UTC)
CONTEXT = TenantContext(USER_ID, ORG_ID)


class ScriptedTransaction:
    def __init__(self, rows: list[tuple[Any, ...] | None]) -> None:
        self.rows = deque(rows)
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch_one(self, statement: str, parameters=()):
        del statement, parameters
        return self.rows.popleft()

    async def fetch_all(self, statement: str, parameters=()):
        del statement, parameters
        raise AssertionError("list query was not expected")

    async def execute(self, statement: str, parameters=()):
        self.executions.append((statement, tuple(parameters)))


class SingleTransactionExecutor:
    def __init__(self, transaction: ScriptedTransaction) -> None:
        self.transaction = transaction

    async def run(self, context, operation):
        assert context == CONTEXT
        return await operation(self.transaction)


def discussion_row(
    *,
    state: str = "open",
    version: int = 1,
    target: FeatureDiscussionTarget | ObjectDiscussionTarget | None = None,
    assigned_to: UUID | None = None,
) -> tuple[Any, ...]:
    resolved = state == "resolved"
    feature_target = target if isinstance(target, FeatureDiscussionTarget) else None
    object_target = target if isinstance(target, ObjectDiscussionTarget) else None
    return (
        DISCUSSION_ID,
        PROJECT_ID,
        COMMENT_ID,
        "Review the flood layer",
        state,
        version,
        USER_ID,
        "Aaron Dennis",
        USER_ID if resolved else None,
        "Aaron Dennis" if resolved else None,
        NOW if resolved else None,
        NOW,
        NOW,
        1,
        NOW,
        object_target.kind if object_target else "feature" if feature_target else "project",
        feature_target.map_id if feature_target else None,
        feature_target.map_version if feature_target else None,
        feature_target.layer_id if feature_target else None,
        feature_target.dataset_id if feature_target else None,
        feature_target.feature_id if feature_target else None,
        object_target.object_id if object_target else None,
        object_target.version if object_target else None,
        assigned_to,
        "Project Reviewer" if assigned_to else None,
        USER_ID if assigned_to else None,
        "Aaron Dennis" if assigned_to else None,
        NOW if assigned_to else None,
    )


def comment_row(body: str) -> tuple[Any, ...]:
    return (COMMENT_ID, PROJECT_ID, DISCUSSION_ID, body, USER_ID, "Aaron Dennis", NOW, [])


def moderated_comment_row(body: str = "[Comment redacted]") -> tuple[Any, ...]:
    return (
        COMMENT_ID,
        PROJECT_ID,
        DISCUSSION_ID,
        body,
        USER_ID,
        "Aaron Dennis",
        NOW,
        [],
        UUID("a5000000-0000-4000-8000-000000000080"),
        "redact",
        "Contains a private credential.",
        USER_ID,
        "Aaron Dennis",
        NOW,
    )


def notification_row(*, read: bool = False) -> tuple[Any, ...]:
    return (
        NOTIFICATION_ID,
        PROJECT_ID,
        DISCUSSION_ID,
        "Review the flood layer",
        2,
        None,
        "assignment",
        USER_ID,
        "Aaron Dennis",
        2 if read else 1,
        NOW if read else None,
        NOW,
    )


def test_creates_thread_initial_comment_and_activity_atomically() -> None:
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("editor",),
            None,
            discussion_row(),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    receipt = asyncio.run(
        repository.create_discussion(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            COMMENT_ID,
            "Review the flood layer",
            "Check the source date.",
            "request-discussion-75",
        )
    )

    assert receipt.created is True
    assert receipt.discussion.discussion_id == DISCUSSION_ID
    assert len(transaction.executions) == 3
    assert "INSERT INTO app.project_discussions" in transaction.executions[0][0]
    assert "INSERT INTO app.project_discussion_comments" in transaction.executions[1][0]
    assert transaction.executions[2][1][3] == "project.discussion.created"
    assert transaction.executions[2][1][6] == "request-discussion-75"


def test_viewer_cannot_assign_responsibility_while_creating_a_thread() -> None:
    participant_id = UUID("20000000-0000-4000-8000-000000000079")
    transaction = ScriptedTransaction([("member",), ("viewer",)])
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    with pytest.raises(DiscussionAccessDenied, match=r"project\.discussions\.moderate"):
        asyncio.run(
            repository.create_discussion(
                CONTEXT,
                PROJECT_ID,
                DISCUSSION_ID,
                COMMENT_ID,
                "Assign review",
                "Please review this source.",
                "request-discussion-assignment-79",
                assigned_to=participant_id,
            )
        )

    assert transaction.executions == []


def test_validates_and_creates_immutable_feature_target() -> None:
    target = FeatureDiscussionTarget(MAP_ID, 3, "wetlands", DATASET_ID, FEATURE_ID)
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("editor",),
            None,
            (1,),
            discussion_row(target=target),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    receipt = asyncio.run(
        repository.create_discussion(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            COMMENT_ID,
            "Review mapped feature",
            "Confirm the wetland boundary.",
            "request-feature-discussion-77",
            target,
        )
    )

    assert receipt.discussion.target == target
    discussion_parameters = transaction.executions[0][1]
    assert discussion_parameters[6:12] == (
        "feature",
        MAP_ID,
        3,
        "wetlands",
        DATASET_ID,
        FEATURE_ID,
    )


def test_rejects_missing_or_stale_feature_target_before_writing() -> None:
    target = FeatureDiscussionTarget(MAP_ID, 3, "wetlands", DATASET_ID, FEATURE_ID)
    transaction = ScriptedTransaction([("member",), ("editor",), None, None])
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    with pytest.raises(DiscussionNotFound, match="discussion_target"):
        asyncio.run(
            repository.create_discussion(
                CONTEXT,
                PROJECT_ID,
                DISCUSSION_ID,
                COMMENT_ID,
                "Review mapped feature",
                "Confirm the wetland boundary.",
                "request-feature-discussion-missing-77",
                target,
            )
        )

    assert transaction.executions == []


def test_creates_exact_object_thread_with_assignment_mentions_and_notifications() -> None:
    target = ObjectDiscussionTarget("dataset", DATASET_ID, 4)
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("editor",),
            None,
            (1,),
            (1,),
            discussion_row(target=target, assigned_to=PARTICIPANT_ID),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    receipt = asyncio.run(
        repository.create_discussion(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            COMMENT_ID,
            "Review governed dataset",
            "Confirm version four.",
            "request-object-discussion-79",
            target,
            PARTICIPANT_ID,
            (PARTICIPANT_ID,),
        )
    )

    assert receipt.discussion.target == target
    assert receipt.discussion.assigned_to == PARTICIPANT_ID
    assert len(transaction.executions) == 6
    assert transaction.executions[0][1][6:15] == (
        "dataset",
        None,
        None,
        None,
        None,
        None,
        DATASET_ID,
        4,
        PARTICIPANT_ID,
    )
    assert "project_discussion_comment_mentions" in transaction.executions[2][0]
    assert "notify_project_discussion_recipients" in transaction.executions[3][0]
    assert "notify_project_discussion_recipients" in transaction.executions[4][0]
    assert transaction.executions[5][1][3] == "project.discussion.created"


def test_idempotent_replay_cannot_retarget_an_existing_discussion() -> None:
    target = FeatureDiscussionTarget(MAP_ID, 3, "wetlands", DATASET_ID, FEATURE_ID)
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("editor",),
            discussion_row(),
            comment_row("Check the source date."),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    with pytest.raises(DiscussionConflict, match="discussion_id_conflict"):
        asyncio.run(
            repository.create_discussion(
                CONTEXT,
                PROJECT_ID,
                DISCUSSION_ID,
                COMMENT_ID,
                "Review the flood layer",
                "Check the source date.",
                "request-feature-discussion-replay-77",
                target,
            )
        )

    assert transaction.executions == []


def test_reply_rejects_resolved_thread_before_writing() -> None:
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("viewer",),
            ("resolved",),
            None,
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    with pytest.raises(DiscussionConflict, match="discussion_resolved"):
        asyncio.run(
            repository.add_comment(
                CONTEXT,
                PROJECT_ID,
                DISCUSSION_ID,
                COMMENT_ID,
                "This thread is already resolved.",
                "request-discussion-reply-75",
            )
        )

    assert transaction.executions == []


def test_reviewer_resolves_with_version_and_attributed_activity() -> None:
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("reviewer",),
            ("open", 1, USER_ID, None),
            discussion_row(state="resolved", version=2),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(transaction))

    receipt = asyncio.run(
        repository.transition_discussion(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            "resolved",
            1,
            "request-discussion-resolve-75",
        )
    )

    assert receipt.changed is True
    assert receipt.discussion.state == "resolved"
    assert receipt.discussion.version_number == 2
    assert len(transaction.executions) == 3
    update_parameters = transaction.executions[0][1]
    assert update_parameters[:3] == ("resolved", USER_ID, "resolved")
    event_parameters = transaction.executions[1][1]
    assert event_parameters[3] == "project.discussion.resolved"
    assert event_parameters[6] == "request-discussion-resolve-75"
    assert "notify_project_discussion_recipients" in transaction.executions[2][0]


def test_assignment_and_notification_read_are_exact_version_transitions() -> None:
    assign_transaction = ScriptedTransaction(
        [
            ("member",),
            ("editor",),
            (1, None),
            (1,),
            discussion_row(version=2, assigned_to=PARTICIPANT_ID),
        ]
    )
    repository = PostgresDiscussionRepository(SingleTransactionExecutor(assign_transaction))

    assigned = asyncio.run(
        repository.assign_discussion(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            PARTICIPANT_ID,
            1,
            "request-discussion-assign-79",
        )
    )

    assert assigned.changed is True
    assert assigned.discussion.version_number == 2
    assert len(assign_transaction.executions) == 3
    assert "UPDATE app.project_discussions" in assign_transaction.executions[0][0]
    assert assign_transaction.executions[1][1][3] == "project.discussion.assigned"
    assert "notify_project_discussion_recipients" in assign_transaction.executions[2][0]

    read_transaction = ScriptedTransaction(
        [("member",), ("viewer",), (1, None), notification_row(read=True)]
    )
    read_repository = PostgresDiscussionRepository(SingleTransactionExecutor(read_transaction))
    acknowledged = asyncio.run(
        read_repository.mark_notification_read(CONTEXT, PROJECT_ID, NOTIFICATION_ID, 1)
    )

    assert acknowledged.changed is True
    assert acknowledged.notification.version_number == 2
    assert len(read_transaction.executions) == 1
    assert "UPDATE app.project_notifications" in read_transaction.executions[0][0]


def test_subscription_is_private_exact_version_state_not_a_deleted_row() -> None:
    subscribed = ScriptedTransaction(
        [
            ("member",),
            ("viewer",),
            (1,),
            None,
            (1, NOW, None),
        ]
    )
    created = asyncio.run(
        PostgresDiscussionRepository(SingleTransactionExecutor(subscribed)).set_subscription(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            True,
            None,
            "request-subscribe-80",
        )
    )
    assert created.changed is True
    assert created.subscription is not None and created.subscription.subscribed is True
    assert "INSERT INTO app.project_discussion_subscriptions" in subscribed.executions[0][0]
    assert subscribed.executions[1][1][3] == "project.discussion.subscribed"

    unsubscribed = ScriptedTransaction(
        [
            ("member",),
            ("viewer",),
            (1,),
            (1, NOW, None),
            (2, NOW, NOW),
        ]
    )
    removed = asyncio.run(
        PostgresDiscussionRepository(SingleTransactionExecutor(unsubscribed)).set_subscription(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            False,
            1,
            "request-unsubscribe-80",
        )
    )
    assert removed.changed is True
    assert removed.subscription is not None and removed.subscription.subscribed is False
    assert "UPDATE app.project_discussion_subscriptions" in unsubscribed.executions[0][0]
    assert all("DELETE" not in statement for statement, _ in unsubscribed.executions)


def test_comment_redaction_is_append_only_and_projects_a_marker() -> None:
    moderation_id = UUID("a5000000-0000-4000-8000-000000000080")
    transaction = ScriptedTransaction(
        [
            ("member",),
            ("reviewer",),
            (1,),
            comment_row("secret value"),
            None,
            moderated_comment_row(),
        ]
    )

    receipt = asyncio.run(
        PostgresDiscussionRepository(SingleTransactionExecutor(transaction)).moderate_comment(
            CONTEXT,
            PROJECT_ID,
            DISCUSSION_ID,
            COMMENT_ID,
            moderation_id,
            "Contains a private credential.",
            "request-redact-80",
        )
    )

    assert receipt.created is True
    assert receipt.comment.body == "[Comment redacted]"
    assert receipt.comment.moderation is not None
    assert receipt.comment.moderation.moderation_id == moderation_id
    assert "INSERT INTO app.project_discussion_comment_moderations" in transaction.executions[0][0]
    assert all(
        "UPDATE app.project_discussion_comments" not in item[0] for item in transaction.executions
    )
    assert transaction.executions[1][1][3] == "project.discussion.comment.redacted"
