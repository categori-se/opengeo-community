import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.discussions import (
    DiscussionAccessDenied,
    DiscussionAssignmentReceipt,
    DiscussionCommentReceipt,
    DiscussionConflict,
    DiscussionCreationReceipt,
    DiscussionModerationReceipt,
    DiscussionNotFound,
    DiscussionRepository,
    DiscussionState,
    DiscussionStoreUnavailable,
    DiscussionSubscriptionReceipt,
    DiscussionTarget,
    DiscussionTransitionReceipt,
    FeatureDiscussionTarget,
    NotificationReadReceipt,
    ObjectDiscussionKind,
    ObjectDiscussionTarget,
    ProjectDiscussion,
    ProjectDiscussionComment,
    ProjectDiscussionMention,
    ProjectDiscussionModeration,
    ProjectDiscussionParticipant,
    ProjectDiscussionSubscription,
    ProjectNotification,
)
from opengeo_api.logging import get_request_id
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Project discussions"])

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
CommentBody = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
]
ModerationReason = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]
LayerId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FeatureDiscussionTargetRequest(RequestModel):
    map_id: UUID
    map_version: int = Field(ge=1, le=9_007_199_254_740_991)
    layer_id: LayerId
    dataset_id: UUID
    feature_id: UUID


class ObjectDiscussionTargetRequest(RequestModel):
    kind: ObjectDiscussionKind
    object_id: UUID
    version: int = Field(ge=1, le=9_007_199_254_740_991)


DiscussionTargetRequest = FeatureDiscussionTargetRequest | ObjectDiscussionTargetRequest


class MentionRequestModel(RequestModel):
    mentioned_user_ids: tuple[UUID, ...] = Field(default=(), max_length=20)

    @field_validator("mentioned_user_ids")
    @classmethod
    def mentions_are_unique(cls, value: tuple[UUID, ...]) -> tuple[UUID, ...]:
        if len(set(value)) != len(value):
            raise ValueError("mentioned_user_ids must be unique")
        return tuple(sorted(value, key=str))


class CreateDiscussionRequest(MentionRequestModel):
    discussion_id: UUID
    initial_comment_id: UUID
    title: Title
    body: CommentBody
    target: DiscussionTargetRequest | None = None
    assigned_to: UUID | None = None


class CreateDiscussionCommentRequest(MentionRequestModel):
    comment_id: UUID
    body: CommentBody


class TransitionDiscussionRequest(RequestModel):
    state: DiscussionState
    expected_version: int = Field(ge=1, le=2_147_483_647)


class AssignDiscussionRequest(RequestModel):
    assigned_to: UUID | None
    expected_version: int = Field(ge=1, le=2_147_483_647)


class MarkNotificationReadRequest(RequestModel):
    expected_version: int = Field(ge=1, le=2_147_483_647)


class SetDiscussionSubscriptionRequest(RequestModel):
    subscribed: bool
    expected_version: int | None = Field(default=None, ge=1, le=2_147_483_647)


class ModerateDiscussionCommentRequest(RequestModel):
    moderation_id: UUID
    reason: ModerationReason


class ProjectDiscussionResponse(BaseModel):
    id: UUID
    project_id: UUID
    initial_comment_id: UUID
    title: str
    state: DiscussionState
    version_number: int
    created_by: UUID
    created_by_name: str
    resolved_by: UUID | None
    resolved_by_name: str | None
    resolved_at: datetime | None
    created_at: datetime
    updated_at: datetime
    comment_count: int
    latest_comment_at: datetime
    can_moderate: bool
    target: DiscussionTargetRequest | None
    assigned_to: UUID | None
    assigned_to_name: str | None
    assigned_by: UUID | None
    assigned_by_name: str | None
    assigned_at: datetime | None


class ProjectDiscussionParticipantResponse(BaseModel):
    user_id: UUID
    display_name: str
    project_role: Literal["administrator", "owner", "editor", "reviewer", "viewer"]


class ProjectDiscussionMentionResponse(BaseModel):
    user_id: UUID
    display_name: str


class ProjectDiscussionModerationResponse(BaseModel):
    id: UUID
    action: Literal["redact"]
    reason: str
    actor_user_id: UUID
    actor_name: str
    created_at: datetime


class ProjectDiscussionCommentResponse(BaseModel):
    id: UUID
    project_id: UUID
    discussion_id: UUID
    body: str
    created_by: UUID
    created_by_name: str
    created_at: datetime
    mentions: list[ProjectDiscussionMentionResponse]
    moderation: ProjectDiscussionModerationResponse | None


class ProjectDiscussionSubscriptionResponse(BaseModel):
    discussion_id: UUID
    subscribed: bool
    version_number: int
    subscribed_at: datetime
    unsubscribed_at: datetime | None


class ProjectNotificationResponse(BaseModel):
    id: UUID
    project_id: UUID
    discussion_id: UUID
    discussion_title: str
    discussion_version: int
    comment_id: UUID | None
    kind: Literal["assignment", "mention", "reply", "state"]
    actor_user_id: UUID
    actor_name: str
    version_number: int
    read_at: datetime | None
    created_at: datetime


class DiscussionCreationResponse(BaseModel):
    created: bool
    discussion: ProjectDiscussionResponse


class DiscussionCommentCreationResponse(BaseModel):
    created: bool
    comment: ProjectDiscussionCommentResponse


class DiscussionTransitionResponse(BaseModel):
    changed: bool
    discussion: ProjectDiscussionResponse


class DiscussionAssignmentResponse(BaseModel):
    changed: bool
    discussion: ProjectDiscussionResponse


class NotificationReadResponse(BaseModel):
    changed: bool
    notification: ProjectNotificationResponse


class DiscussionSubscriptionResponse(BaseModel):
    changed: bool
    subscription: ProjectDiscussionSubscriptionResponse | None


class DiscussionModerationResponse(BaseModel):
    created: bool
    comment: ProjectDiscussionCommentResponse


def repository_from_request(request: Request) -> DiscussionRepository:
    return cast(DiscussionRepository, request.app.state.discussion_repository)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_discussion[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except DiscussionAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except DiscussionNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except DiscussionConflict as error:
        detail: dict[str, object] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except DiscussionStoreUnavailable as error:
        logger.error("discussion.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="discussion_store_unavailable") from error


@router.get(
    "/projects/{project_id}/discussions",
    response_model=list[ProjectDiscussionResponse],
)
async def project_discussions(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
    state: Annotated[DiscussionState | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[ProjectDiscussionResponse]:
    records = await execute_discussion(
        repository.list_discussions(tenant_context(session), project_id, state, limit, offset)
    )
    return [discussion_response(record) for record in records]


@router.get(
    "/projects/{project_id}/discussion-participants",
    response_model=list[ProjectDiscussionParticipantResponse],
)
async def project_discussion_participants(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> list[ProjectDiscussionParticipantResponse]:
    records = await execute_discussion(
        repository.list_participants(tenant_context(session), project_id)
    )
    return [participant_response(record) for record in records]


@router.post(
    "/projects/{project_id}/discussions",
    response_model=DiscussionCreationResponse,
)
async def create_project_discussion(
    project_id: UUID,
    payload: CreateDiscussionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionCreationResponse:
    receipt = await execute_discussion(
        repository.create_discussion(
            tenant_context(session),
            project_id,
            payload.discussion_id,
            payload.initial_comment_id,
            payload.title,
            payload.body,
            get_request_id(),
            discussion_target(payload.target),
            payload.assigned_to,
            payload.mentioned_user_ids,
        )
    )
    return creation_response(receipt)


@router.get(
    "/projects/{project_id}/discussions/{discussion_id}/comments",
    response_model=list[ProjectDiscussionCommentResponse],
)
async def project_discussion_comments(
    project_id: UUID,
    discussion_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[ProjectDiscussionCommentResponse]:
    records = await execute_discussion(
        repository.list_comments(tenant_context(session), project_id, discussion_id, limit, offset)
    )
    return [comment_response(record) for record in records]


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/comments",
    response_model=DiscussionCommentCreationResponse,
)
async def create_project_discussion_comment(
    project_id: UUID,
    discussion_id: UUID,
    payload: CreateDiscussionCommentRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionCommentCreationResponse:
    receipt = await execute_discussion(
        repository.add_comment(
            tenant_context(session),
            project_id,
            discussion_id,
            payload.comment_id,
            payload.body,
            get_request_id(),
            payload.mentioned_user_ids,
        )
    )
    return comment_creation_response(receipt)


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/comments/{comment_id}/moderation",
    response_model=DiscussionModerationResponse,
)
async def moderate_project_discussion_comment(
    project_id: UUID,
    discussion_id: UUID,
    comment_id: UUID,
    payload: ModerateDiscussionCommentRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionModerationResponse:
    receipt = await execute_discussion(
        repository.moderate_comment(
            tenant_context(session),
            project_id,
            discussion_id,
            comment_id,
            payload.moderation_id,
            payload.reason,
            get_request_id(),
        )
    )
    return moderation_response(receipt)


@router.get(
    "/projects/{project_id}/discussions/{discussion_id}/subscription",
    response_model=ProjectDiscussionSubscriptionResponse | None,
)
async def project_discussion_subscription(
    project_id: UUID,
    discussion_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> ProjectDiscussionSubscriptionResponse | None:
    record = await execute_discussion(
        repository.get_subscription(tenant_context(session), project_id, discussion_id)
    )
    return subscription_response(record) if record is not None else None


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/subscription",
    response_model=DiscussionSubscriptionResponse,
)
async def set_project_discussion_subscription(
    project_id: UUID,
    discussion_id: UUID,
    payload: SetDiscussionSubscriptionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionSubscriptionResponse:
    receipt = await execute_discussion(
        repository.set_subscription(
            tenant_context(session),
            project_id,
            discussion_id,
            payload.subscribed,
            payload.expected_version,
            get_request_id(),
        )
    )
    return subscription_receipt_response(receipt)


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/state",
    response_model=DiscussionTransitionResponse,
)
async def transition_project_discussion(
    project_id: UUID,
    discussion_id: UUID,
    payload: TransitionDiscussionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionTransitionResponse:
    receipt = await execute_discussion(
        repository.transition_discussion(
            tenant_context(session),
            project_id,
            discussion_id,
            payload.state,
            payload.expected_version,
            get_request_id(),
        )
    )
    return transition_response(receipt)


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/assignment",
    response_model=DiscussionAssignmentResponse,
)
async def assign_project_discussion(
    project_id: UUID,
    discussion_id: UUID,
    payload: AssignDiscussionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> DiscussionAssignmentResponse:
    receipt = await execute_discussion(
        repository.assign_discussion(
            tenant_context(session),
            project_id,
            discussion_id,
            payload.assigned_to,
            payload.expected_version,
            get_request_id(),
        )
    )
    return assignment_response(receipt)


@router.get(
    "/projects/{project_id}/discussion-notifications",
    response_model=list[ProjectNotificationResponse],
)
async def project_discussion_notifications(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
    unread_only: Annotated[bool, Query()] = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[ProjectNotificationResponse]:
    records = await execute_discussion(
        repository.list_notifications(
            tenant_context(session), project_id, unread_only, limit, offset
        )
    )
    return [notification_response(record) for record in records]


@router.post(
    "/projects/{project_id}/discussion-notifications/{notification_id}/read",
    response_model=NotificationReadResponse,
)
async def read_project_discussion_notification(
    project_id: UUID,
    notification_id: UUID,
    payload: MarkNotificationReadRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DiscussionRepository, Depends(repository_from_request)],
) -> NotificationReadResponse:
    receipt = await execute_discussion(
        repository.mark_notification_read(
            tenant_context(session), project_id, notification_id, payload.expected_version
        )
    )
    return notification_read_response(receipt)


def discussion_response(record: ProjectDiscussion) -> ProjectDiscussionResponse:
    return ProjectDiscussionResponse(
        id=record.discussion_id,
        project_id=record.project_id,
        initial_comment_id=record.initial_comment_id,
        title=record.title,
        state=record.state,
        version_number=record.version_number,
        created_by=record.created_by,
        created_by_name=record.created_by_name,
        resolved_by=record.resolved_by,
        resolved_by_name=record.resolved_by_name,
        resolved_at=record.resolved_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
        comment_count=record.comment_count,
        latest_comment_at=record.latest_comment_at,
        can_moderate=record.can_moderate,
        target=target_response(record.target),
        assigned_to=record.assigned_to,
        assigned_to_name=record.assigned_to_name,
        assigned_by=record.assigned_by,
        assigned_by_name=record.assigned_by_name,
        assigned_at=record.assigned_at,
    )


def discussion_target(target: DiscussionTargetRequest | None) -> DiscussionTarget | None:
    if target is None:
        return None
    if isinstance(target, ObjectDiscussionTargetRequest):
        return ObjectDiscussionTarget(
            kind=target.kind,
            object_id=target.object_id,
            version=target.version,
        )
    return FeatureDiscussionTarget(
        map_id=target.map_id,
        map_version=target.map_version,
        layer_id=target.layer_id,
        dataset_id=target.dataset_id,
        feature_id=target.feature_id,
    )


def target_response(target: DiscussionTarget | None) -> DiscussionTargetRequest | None:
    if target is None:
        return None
    if isinstance(target, ObjectDiscussionTarget):
        return ObjectDiscussionTargetRequest(
            kind=target.kind,
            object_id=target.object_id,
            version=target.version,
        )
    return FeatureDiscussionTargetRequest(
        map_id=target.map_id,
        map_version=target.map_version,
        layer_id=target.layer_id,
        dataset_id=target.dataset_id,
        feature_id=target.feature_id,
    )


def participant_response(
    record: ProjectDiscussionParticipant,
) -> ProjectDiscussionParticipantResponse:
    return ProjectDiscussionParticipantResponse(
        user_id=record.user_id,
        display_name=record.display_name,
        project_role=record.project_role,
    )


def mention_response(record: ProjectDiscussionMention) -> ProjectDiscussionMentionResponse:
    return ProjectDiscussionMentionResponse(
        user_id=record.user_id,
        display_name=record.display_name,
    )


def moderation_detail_response(
    record: ProjectDiscussionModeration,
) -> ProjectDiscussionModerationResponse:
    return ProjectDiscussionModerationResponse(
        id=record.moderation_id,
        action=record.action,
        reason=record.reason,
        actor_user_id=record.actor_user_id,
        actor_name=record.actor_name,
        created_at=record.created_at,
    )


def comment_response(record: ProjectDiscussionComment) -> ProjectDiscussionCommentResponse:
    return ProjectDiscussionCommentResponse(
        id=record.comment_id,
        project_id=record.project_id,
        discussion_id=record.discussion_id,
        body=record.body,
        created_by=record.created_by,
        created_by_name=record.created_by_name,
        created_at=record.created_at,
        mentions=[mention_response(mention) for mention in record.mentions],
        moderation=(
            moderation_detail_response(record.moderation) if record.moderation is not None else None
        ),
    )


def subscription_response(
    record: ProjectDiscussionSubscription,
) -> ProjectDiscussionSubscriptionResponse:
    return ProjectDiscussionSubscriptionResponse(
        discussion_id=record.discussion_id,
        subscribed=record.subscribed,
        version_number=record.version_number,
        subscribed_at=record.subscribed_at,
        unsubscribed_at=record.unsubscribed_at,
    )


def notification_response(record: ProjectNotification) -> ProjectNotificationResponse:
    return ProjectNotificationResponse(
        id=record.notification_id,
        project_id=record.project_id,
        discussion_id=record.discussion_id,
        discussion_title=record.discussion_title,
        discussion_version=record.discussion_version,
        comment_id=record.comment_id,
        kind=record.kind,
        actor_user_id=record.actor_user_id,
        actor_name=record.actor_name,
        version_number=record.version_number,
        read_at=record.read_at,
        created_at=record.created_at,
    )


def creation_response(receipt: DiscussionCreationReceipt) -> DiscussionCreationResponse:
    return DiscussionCreationResponse(
        created=receipt.created, discussion=discussion_response(receipt.discussion)
    )


def comment_creation_response(
    receipt: DiscussionCommentReceipt,
) -> DiscussionCommentCreationResponse:
    return DiscussionCommentCreationResponse(
        created=receipt.created, comment=comment_response(receipt.comment)
    )


def transition_response(
    receipt: DiscussionTransitionReceipt,
) -> DiscussionTransitionResponse:
    return DiscussionTransitionResponse(
        changed=receipt.changed, discussion=discussion_response(receipt.discussion)
    )


def assignment_response(
    receipt: DiscussionAssignmentReceipt,
) -> DiscussionAssignmentResponse:
    return DiscussionAssignmentResponse(
        changed=receipt.changed, discussion=discussion_response(receipt.discussion)
    )


def notification_read_response(receipt: NotificationReadReceipt) -> NotificationReadResponse:
    return NotificationReadResponse(
        changed=receipt.changed,
        notification=notification_response(receipt.notification),
    )


def subscription_receipt_response(
    receipt: DiscussionSubscriptionReceipt,
) -> DiscussionSubscriptionResponse:
    return DiscussionSubscriptionResponse(
        changed=receipt.changed,
        subscription=(
            subscription_response(receipt.subscription)
            if receipt.subscription is not None
            else None
        ),
    )


def moderation_response(receipt: DiscussionModerationReceipt) -> DiscussionModerationResponse:
    return DiscussionModerationResponse(
        created=receipt.created,
        comment=comment_response(receipt.comment),
    )
