import asyncio
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID

import anyio.to_thread
import pytest
from fastapi import FastAPI

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.discussions import (
    DiscussionAssignmentReceipt,
    DiscussionCommentReceipt,
    DiscussionConflict,
    DiscussionCreationReceipt,
    DiscussionModerationReceipt,
    DiscussionSubscriptionReceipt,
    DiscussionTransitionReceipt,
    FeatureDiscussionTarget,
    NotificationReadReceipt,
    ObjectDiscussionTarget,
    ProjectDiscussion,
    ProjectDiscussionComment,
    ProjectDiscussionModeration,
    ProjectDiscussionParticipant,
    ProjectDiscussionSubscription,
    ProjectNotification,
)
from opengeo_api.tenant_database import TenantContext

USER_ID = UUID("20000000-0000-4000-8000-000000000075")
ORG_ID = UUID("10000000-0000-4000-8000-000000000075")
OTHER_ORG_ID = UUID("10000000-0000-4000-8000-000000000076")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000075")
DISCUSSION_ID = UUID("d5000000-0000-4000-8000-000000000075")
COMMENT_ID = UUID("c5000000-0000-4000-8000-000000000075")
REPLY_ID = UUID("c5000000-0000-4000-8000-000000000076")
NOTIFICATION_ID = UUID("e5000000-0000-4000-8000-000000000075")
MODERATION_ID = UUID("a5000000-0000-4000-8000-000000000080")
MAP_ID = UUID("60000000-0000-4000-8000-000000000075")
DATASET_ID = UUID("70000000-0000-4000-8000-000000000075")
FEATURE_ID = UUID("80000000-0000-4000-8000-000000000075")
NOW = datetime(2026, 9, 2, 16, tzinfo=UTC)


@pytest.fixture(autouse=True)
def inline_threadpool(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_sync(function, *args, **kwargs):
        del kwargs
        return function(*args)

    monkeypatch.setattr(anyio.to_thread, "run_sync", run_sync)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="owner@example.test",
            display_name="Owner",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


def feature_target() -> FeatureDiscussionTarget:
    return FeatureDiscussionTarget(MAP_ID, 3, "wetlands", DATASET_ID, FEATURE_ID)


def discussion(
    state: str = "open",
    version: int = 1,
    target: FeatureDiscussionTarget | None = None,
) -> ProjectDiscussion:
    return ProjectDiscussion(
        DISCUSSION_ID,
        PROJECT_ID,
        COMMENT_ID,
        "Review the flood layer",
        state,  # type: ignore[arg-type]
        version,
        USER_ID,
        "Owner",
        USER_ID if state == "resolved" else None,
        "Owner" if state == "resolved" else None,
        NOW if state == "resolved" else None,
        NOW,
        NOW,
        1,
        NOW,
        True,
        target,
    )


def comment(
    comment_id: UUID = COMMENT_ID, body: str = "Check the source date."
) -> ProjectDiscussionComment:
    return ProjectDiscussionComment(
        comment_id, PROJECT_ID, DISCUSSION_ID, body, USER_ID, "Owner", NOW
    )


def notification(*, read: bool = False) -> ProjectNotification:
    return ProjectNotification(
        NOTIFICATION_ID,
        PROJECT_ID,
        DISCUSSION_ID,
        "Review the flood layer",
        1,
        COMMENT_ID,
        "reply",
        USER_ID,
        "Owner",
        2 if read else 1,
        NOW if read else None,
        NOW,
    )


class FakeDiscussionRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_discussions(self, context, project_id, state, limit, offset):
        self.calls.append(("list", context, project_id, state, limit, offset))
        return [discussion()]

    async def list_participants(self, context, project_id):
        self.calls.append(("participants", context, project_id))
        return [ProjectDiscussionParticipant(USER_ID, "Owner", "owner")]

    async def create_discussion(
        self,
        context,
        project_id,
        discussion_id,
        initial_comment_id,
        title,
        body,
        request_id,
        target=None,
        assigned_to=None,
        mentioned_user_ids=(),
    ):
        self.calls.append(
            (
                "create",
                context,
                project_id,
                discussion_id,
                initial_comment_id,
                title,
                body,
                request_id,
                target,
                assigned_to,
                mentioned_user_ids,
            )
        )
        record = discussion(target=target)
        if assigned_to is not None:
            record = replace(
                record,
                assigned_to=assigned_to,
                assigned_to_name="Owner",
                assigned_by=USER_ID,
                assigned_by_name="Owner",
                assigned_at=NOW,
            )
        return DiscussionCreationReceipt(record, True)

    async def list_comments(self, context, project_id, discussion_id, limit, offset):
        self.calls.append(("comments", context, project_id, discussion_id, limit, offset))
        return [comment()]

    async def add_comment(
        self,
        context,
        project_id,
        discussion_id,
        comment_id,
        body,
        request_id,
        mentioned_user_ids=(),
    ):
        self.calls.append(
            (
                "reply",
                context,
                project_id,
                discussion_id,
                comment_id,
                body,
                request_id,
                mentioned_user_ids,
            )
        )
        return DiscussionCommentReceipt(comment(comment_id, body), True)

    async def transition_discussion(
        self, context, project_id, discussion_id, state, expected_version, request_id
    ):
        self.calls.append(
            (
                "transition",
                context,
                project_id,
                discussion_id,
                state,
                expected_version,
                request_id,
            )
        )
        return DiscussionTransitionReceipt(discussion(state, expected_version + 1), True)

    async def assign_discussion(
        self, context, project_id, discussion_id, assigned_to, expected_version, request_id
    ):
        self.calls.append(
            (
                "assign",
                context,
                project_id,
                discussion_id,
                assigned_to,
                expected_version,
                request_id,
            )
        )
        return DiscussionAssignmentReceipt(discussion(version=expected_version + 1), True)

    async def list_notifications(self, context, project_id, unread_only, limit, offset):
        self.calls.append(("notifications", context, project_id, unread_only, limit, offset))
        return [notification()]

    async def mark_notification_read(self, context, project_id, notification_id, expected_version):
        self.calls.append(
            ("notification_read", context, project_id, notification_id, expected_version)
        )
        return NotificationReadReceipt(notification(read=True), True)

    async def get_subscription(self, context, project_id, discussion_id):
        self.calls.append(("get_subscription", context, project_id, discussion_id))
        return ProjectDiscussionSubscription(discussion_id, 1, NOW, None)

    async def set_subscription(
        self, context, project_id, discussion_id, subscribed, expected_version, request_id
    ):
        self.calls.append(
            (
                "set_subscription",
                context,
                project_id,
                discussion_id,
                subscribed,
                expected_version,
                request_id,
            )
        )
        record = ProjectDiscussionSubscription(
            discussion_id,
            (expected_version or 0) + 1,
            NOW,
            None if subscribed else NOW,
        )
        return DiscussionSubscriptionReceipt(record, True)

    async def moderate_comment(
        self,
        context,
        project_id,
        discussion_id,
        comment_id,
        moderation_id,
        reason,
        request_id,
    ):
        self.calls.append(
            (
                "moderate",
                context,
                project_id,
                discussion_id,
                comment_id,
                moderation_id,
                reason,
                request_id,
            )
        )
        moderated = replace(
            comment(comment_id, "[Comment redacted]"),
            moderation=ProjectDiscussionModeration(
                moderation_id,
                "redact",
                reason,
                USER_ID,
                "Owner",
                NOW,
            ),
        )
        return DiscussionModerationReceipt(moderated, True)


class ConflictingDiscussionRepository(FakeDiscussionRepository):
    async def transition_discussion(self, *args, **kwargs):
        del args, kwargs
        raise DiscussionConflict("discussion_version_conflict", current_version=4)


def api_app(repository: FakeDiscussionRepository) -> FastAPI:
    return create_app(
        settings=Settings(env="test", expose_docs=True),
        readiness_probe=PassingProbe(),
        token_verifier=FakeVerifier(),
        principal_repository=FakePrincipalRepository(),
        discussion_repository=repository,
    )


@dataclass(frozen=True)
class AsgiResponse:
    status_code: int
    content: bytes

    def json(self):
        return json.loads(self.content)


def request(
    app: FastAPI,
    method: str,
    target: str,
    *,
    request_headers: dict[str, str] | None = None,
    json_body: dict | None = None,
) -> AsgiResponse:
    body = b"" if json_body is None else json.dumps(json_body).encode()
    headers = list((request_headers or {}).items())
    if json_body is not None:
        headers.extend([("content-type", "application/json"), ("content-length", str(len(body)))])
    parsed = urlsplit(target)

    async def invoke() -> AsgiResponse:
        incoming = [{"type": "http.request", "body": body, "more_body": False}]
        outgoing = []

        async def receive():
            return incoming.pop(0) if incoming else {"type": "http.disconnect"}

        async def send(message):
            outgoing.append(message)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": parsed.path,
                "raw_path": parsed.path.encode(),
                "query_string": parsed.query.encode(),
                "root_path": "",
                "headers": [(key.lower().encode(), value.encode()) for key, value in headers],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        start = next(item for item in outgoing if item["type"] == "http.response.start")
        content = b"".join(
            item.get("body", b"") for item in outgoing if item["type"] == "http.response.body"
        )
        return AsgiResponse(start["status"], content)

    return asyncio.run(invoke())


def headers(organization_id: UUID = ORG_ID) -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(organization_id),
        "X-Request-ID": "request-discussion-75",
    }


def test_lists_bounded_project_discussions() -> None:
    repository = FakeDiscussionRepository()
    response = request(
        api_app(repository),
        "GET",
        f"/projects/{PROJECT_ID}/discussions?state=open&limit=20&offset=2",
        request_headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()[0]["comment_count"] == 1
    assert response.json()[0]["can_moderate"] is True
    assert response.json()[0]["assigned_to"] is None
    assert repository.calls == [("list", TenantContext(USER_ID, ORG_ID), PROJECT_ID, "open", 20, 2)]


def test_creates_normalized_idempotency_bound_thread() -> None:
    repository = FakeDiscussionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/projects/{PROJECT_ID}/discussions",
        request_headers=headers(),
        json_body={
            "discussion_id": str(DISCUSSION_ID),
            "initial_comment_id": str(COMMENT_ID),
            "title": " Review the flood layer ",
            "body": " Check the source date. ",
        },
    )

    assert response.status_code == 200
    assert response.json()["created"] is True
    assert repository.calls[0][5:7] == ("Review the flood layer", "Check the source date.")
    assert repository.calls[0][7] == "request-discussion-75"
    assert repository.calls[0][8:] == (None, None, ())


def test_creates_feature_targeted_thread_with_exact_context() -> None:
    repository = FakeDiscussionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/projects/{PROJECT_ID}/discussions",
        request_headers=headers(),
        json_body={
            "discussion_id": str(DISCUSSION_ID),
            "initial_comment_id": str(COMMENT_ID),
            "title": "Review feature",
            "body": "Confirm this mapped wetland.",
            "target": {
                "map_id": str(MAP_ID),
                "map_version": 3,
                "layer_id": "wetlands",
                "dataset_id": str(DATASET_ID),
                "feature_id": str(FEATURE_ID),
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["discussion"]["target"] == {
        "map_id": str(MAP_ID),
        "map_version": 3,
        "layer_id": "wetlands",
        "dataset_id": str(DATASET_ID),
        "feature_id": str(FEATURE_ID),
    }
    assert repository.calls[0][8] == feature_target()


def test_creates_object_targeted_assigned_thread_with_sorted_mentions() -> None:
    repository = FakeDiscussionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/projects/{PROJECT_ID}/discussions",
        request_headers=headers(),
        json_body={
            "discussion_id": str(DISCUSSION_ID),
            "initial_comment_id": str(COMMENT_ID),
            "title": "Review map",
            "body": "Confirm the published map configuration.",
            "target": {"kind": "map", "object_id": str(MAP_ID), "version": 3},
            "assigned_to": str(USER_ID),
            "mentioned_user_ids": [str(USER_ID)],
        },
    )

    assert response.status_code == 200
    assert response.json()["discussion"]["target"] == {
        "kind": "map",
        "object_id": str(MAP_ID),
        "version": 3,
    }
    assert response.json()["discussion"]["assigned_to"] == str(USER_ID)
    assert repository.calls[0][8:] == (
        ObjectDiscussionTarget("map", MAP_ID, 3),
        USER_ID,
        (USER_ID,),
    )


def test_replies_and_transitions_with_explicit_client_ids_and_version() -> None:
    repository = FakeDiscussionRepository()
    app = api_app(repository)
    reply = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/comments",
        request_headers=headers(),
        json_body={"comment_id": str(REPLY_ID), "body": "Ready for review."},
    )
    resolved = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/state",
        request_headers=headers(),
        json_body={"state": "resolved", "expected_version": 1},
    )

    assert reply.status_code == 200
    assert reply.json()["comment"]["id"] == str(REPLY_ID)
    assert reply.json()["comment"]["mentions"] == []
    assert resolved.status_code == 200
    assert resolved.json()["discussion"]["state"] == "resolved"
    assert resolved.json()["discussion"]["version_number"] == 2
    assert [call[0] for call in repository.calls] == ["reply", "transition"]


def test_lists_participants_assigns_and_acknowledges_recipient_notification() -> None:
    repository = FakeDiscussionRepository()
    app = api_app(repository)
    participants = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/discussion-participants",
        request_headers=headers(),
    )
    assignment = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/assignment",
        request_headers=headers(),
        json_body={"assigned_to": str(USER_ID), "expected_version": 1},
    )
    notifications = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/discussion-notifications?unread_only=true&limit=20",
        request_headers=headers(),
    )
    acknowledged = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussion-notifications/{NOTIFICATION_ID}/read",
        request_headers=headers(),
        json_body={"expected_version": 1},
    )

    assert participants.status_code == 200
    assert participants.json()[0]["project_role"] == "owner"
    assert assignment.status_code == 200
    assert notifications.status_code == 200
    assert notifications.json()[0]["kind"] == "reply"
    assert acknowledged.status_code == 200
    assert acknowledged.json()["notification"]["version_number"] == 2
    assert [call[0] for call in repository.calls] == [
        "participants",
        "assign",
        "notifications",
        "notification_read",
    ]


def test_subscribes_with_exact_version_and_redacts_with_append_only_decision() -> None:
    repository = FakeDiscussionRepository()
    app = api_app(repository)
    subscription = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/subscription",
        request_headers=headers(),
    )
    toggled = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/subscription",
        request_headers=headers(),
        json_body={"subscribed": False, "expected_version": 1},
    )
    moderated = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/comments/{COMMENT_ID}/moderation",
        request_headers=headers(),
        json_body={
            "moderation_id": str(MODERATION_ID),
            "reason": " Contains a private credential. ",
        },
    )

    assert subscription.status_code == 200
    assert subscription.json()["subscribed"] is True
    assert toggled.status_code == 200
    assert toggled.json()["subscription"]["subscribed"] is False
    assert moderated.status_code == 200
    assert moderated.json()["comment"]["body"] == "[Comment redacted]"
    assert moderated.json()["comment"]["moderation"] == {
        "id": str(MODERATION_ID),
        "action": "redact",
        "reason": "Contains a private credential.",
        "actor_user_id": str(USER_ID),
        "actor_name": "Owner",
        "created_at": NOW.isoformat().replace("+00:00", "Z"),
    }
    assert [call[0] for call in repository.calls] == [
        "get_subscription",
        "set_subscription",
        "moderate",
    ]
    assert repository.calls[2][6] == "Contains a private credential."


def test_rejects_unbounded_or_forged_requests_before_repository_calls() -> None:
    repository = FakeDiscussionRepository()
    app = api_app(repository)
    unbounded = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/discussions?limit=101",
        request_headers=headers(),
    )
    extra = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/discussions",
        request_headers=headers(),
        json_body={
            "discussion_id": str(DISCUSSION_ID),
            "initial_comment_id": str(COMMENT_ID),
            "title": "Review",
            "body": "Body",
            "project_id": str(PROJECT_ID),
        },
    )
    forged = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/discussions",
        request_headers=headers(OTHER_ORG_ID),
    )

    assert (unbounded.status_code, extra.status_code, forged.status_code) == (422, 422, 403)
    assert repository.calls == []


def test_version_conflict_is_machine_readable_and_sanitized() -> None:
    response = request(
        api_app(ConflictingDiscussionRepository()),
        "POST",
        f"/projects/{PROJECT_ID}/discussions/{DISCUSSION_ID}/state",
        request_headers=headers(),
        json_body={"state": "resolved", "expected_version": 3},
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": {"code": "discussion_version_conflict", "current_version": 4}
    }


def test_openapi_exposes_only_the_bounded_project_discussion_routes() -> None:
    paths = request(api_app(FakeDiscussionRepository()), "GET", "/openapi.json").json()["paths"]
    assert {
        "/projects/{project_id}/discussions",
        "/projects/{project_id}/discussions/{discussion_id}/comments",
        "/projects/{project_id}/discussions/{discussion_id}/comments/{comment_id}/moderation",
        "/projects/{project_id}/discussions/{discussion_id}/subscription",
        "/projects/{project_id}/discussions/{discussion_id}/state",
        "/projects/{project_id}/discussion-participants",
        "/projects/{project_id}/discussions/{discussion_id}/assignment",
        "/projects/{project_id}/discussion-notifications",
        "/projects/{project_id}/discussion-notifications/{notification_id}/read",
    } <= set(paths)
