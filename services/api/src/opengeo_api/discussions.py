from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    Roles,
    authorize,
    is_allowed,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

DiscussionState = Literal["open", "resolved"]
ObjectDiscussionKind = Literal["map", "dataset", "resource", "site"]
NotificationKind = Literal["assignment", "mention", "reply", "state"]
ParticipantRole = Literal["administrator", "owner", "editor", "reviewer", "viewer"]
ModerationAction = Literal["redact"]


class DiscussionStoreUnavailable(RuntimeError):
    pass


class DiscussionAccessDenied(RuntimeError):
    pass


class DiscussionNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class DiscussionConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class FeatureDiscussionTarget:
    map_id: UUID
    map_version: int
    layer_id: str
    dataset_id: UUID
    feature_id: UUID


@dataclass(frozen=True, slots=True)
class ObjectDiscussionTarget:
    kind: ObjectDiscussionKind
    object_id: UUID
    version: int


DiscussionTarget = FeatureDiscussionTarget | ObjectDiscussionTarget


@dataclass(frozen=True, slots=True)
class ProjectDiscussionParticipant:
    user_id: UUID
    display_name: str
    project_role: ParticipantRole


@dataclass(frozen=True, slots=True)
class ProjectDiscussionMention:
    user_id: UUID
    display_name: str


@dataclass(frozen=True, slots=True)
class ProjectDiscussionModeration:
    moderation_id: UUID
    action: ModerationAction
    reason: str
    actor_user_id: UUID
    actor_name: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ProjectDiscussion:
    discussion_id: UUID
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
    target: DiscussionTarget | None = None
    assigned_to: UUID | None = None
    assigned_to_name: str | None = None
    assigned_by: UUID | None = None
    assigned_by_name: str | None = None
    assigned_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ProjectDiscussionComment:
    comment_id: UUID
    project_id: UUID
    discussion_id: UUID
    body: str
    created_by: UUID
    created_by_name: str
    created_at: datetime
    mentions: tuple[ProjectDiscussionMention, ...] = ()
    moderation: ProjectDiscussionModeration | None = None


@dataclass(frozen=True, slots=True)
class ProjectDiscussionSubscription:
    discussion_id: UUID
    version_number: int
    subscribed_at: datetime
    unsubscribed_at: datetime | None

    @property
    def subscribed(self) -> bool:
        return self.unsubscribed_at is None


@dataclass(frozen=True, slots=True)
class ProjectNotification:
    notification_id: UUID
    project_id: UUID
    discussion_id: UUID
    discussion_title: str
    discussion_version: int
    comment_id: UUID | None
    kind: NotificationKind
    actor_user_id: UUID
    actor_name: str
    version_number: int
    read_at: datetime | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class DiscussionCreationReceipt:
    discussion: ProjectDiscussion
    created: bool


@dataclass(frozen=True, slots=True)
class DiscussionCommentReceipt:
    comment: ProjectDiscussionComment
    created: bool


@dataclass(frozen=True, slots=True)
class DiscussionTransitionReceipt:
    discussion: ProjectDiscussion
    changed: bool


@dataclass(frozen=True, slots=True)
class DiscussionAssignmentReceipt:
    discussion: ProjectDiscussion
    changed: bool


@dataclass(frozen=True, slots=True)
class NotificationReadReceipt:
    notification: ProjectNotification
    changed: bool


@dataclass(frozen=True, slots=True)
class DiscussionSubscriptionReceipt:
    subscription: ProjectDiscussionSubscription | None
    changed: bool


@dataclass(frozen=True, slots=True)
class DiscussionModerationReceipt:
    comment: ProjectDiscussionComment
    created: bool


class DiscussionRepository(Protocol):
    async def list_participants(
        self,
        context: TenantContext,
        project_id: UUID,
    ) -> list[ProjectDiscussionParticipant]: ...

    async def list_discussions(
        self,
        context: TenantContext,
        project_id: UUID,
        state: DiscussionState | None,
        limit: int,
        offset: int,
    ) -> list[ProjectDiscussion]: ...

    async def create_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        initial_comment_id: UUID,
        title: str,
        body: str,
        request_id: str,
        target: DiscussionTarget | None = None,
        assigned_to: UUID | None = None,
        mentioned_user_ids: tuple[UUID, ...] = (),
    ) -> DiscussionCreationReceipt: ...

    async def list_comments(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        limit: int,
        offset: int,
    ) -> list[ProjectDiscussionComment]: ...

    async def add_comment(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
        body: str,
        request_id: str,
        mentioned_user_ids: tuple[UUID, ...] = (),
    ) -> DiscussionCommentReceipt: ...

    async def transition_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        state: DiscussionState,
        expected_version: int,
        request_id: str,
    ) -> DiscussionTransitionReceipt: ...

    async def assign_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        assigned_to: UUID | None,
        expected_version: int,
        request_id: str,
    ) -> DiscussionAssignmentReceipt: ...

    async def list_notifications(
        self,
        context: TenantContext,
        project_id: UUID,
        unread_only: bool,
        limit: int,
        offset: int,
    ) -> list[ProjectNotification]: ...

    async def mark_notification_read(
        self,
        context: TenantContext,
        project_id: UUID,
        notification_id: UUID,
        expected_version: int,
    ) -> NotificationReadReceipt: ...

    async def get_subscription(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
    ) -> ProjectDiscussionSubscription | None: ...

    async def set_subscription(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        subscribed: bool,
        expected_version: int | None,
        request_id: str,
    ) -> DiscussionSubscriptionReceipt: ...

    async def moderate_comment(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
        moderation_id: UUID,
        reason: str,
        request_id: str,
    ) -> DiscussionModerationReceipt: ...


ResultT = TypeVar("ResultT")


class PostgresDiscussionRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except (DiscussionAccessDenied, DiscussionNotFound, DiscussionConflict):
            raise
        except TenantDatabaseConflict as error:
            raise DiscussionConflict("discussion_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise DiscussionStoreUnavailable("discussion database unavailable") from error

    async def list_participants(
        self,
        context: TenantContext,
        project_id: UUID,
    ) -> list[ProjectDiscussionParticipant]:
        async def operation(transaction: TenantTransaction) -> list[ProjectDiscussionParticipant]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT member.user_id, user_record.display_name,
                       COALESCE(
                         app.effective_project_role(%s, member.user_id)::text,
                         CASE WHEN member.role = 'admin' THEN 'administrator' END
                       ) AS effective_role
                FROM app.organization_memberships member
                JOIN app.users user_record ON user_record.id = member.user_id
                WHERE member.organization_id = %s
                  AND (
                    member.role = 'admin'
                    OR app.effective_project_role(%s, member.user_id) IS NOT NULL
                  )
                ORDER BY lower(user_record.display_name), member.user_id
                """,
                (project_id, context.organization_id, project_id),
            )
            return [
                ProjectDiscussionParticipant(
                    user_id=UUID(str(row[0])),
                    display_name=str(row[1]),
                    project_role=cast(ParticipantRole, str(row[2])),
                )
                for row in rows
            ]

        return await self._run(context, operation)

    async def list_discussions(
        self,
        context: TenantContext,
        project_id: UUID,
        state: DiscussionState | None,
        limit: int,
        offset: int,
    ) -> list[ProjectDiscussion]:
        async def operation(transaction: TenantTransaction) -> list[ProjectDiscussion]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            rows = await transaction.fetch_all(
                self._discussion_query(
                    "discussion.organization_id = %s AND discussion.project_id = %s "
                    "AND (%s::text IS NULL OR discussion.state::text = %s::text)"
                )
                + " ORDER BY latest_comment_at DESC, discussion.id LIMIT %s OFFSET %s",
                (
                    context.organization_id,
                    project_id,
                    state,
                    state,
                    limit,
                    offset,
                ),
            )
            can_moderate = is_allowed(Action.PROJECT_DISCUSSIONS_MODERATE, roles)
            return [self._discussion(row, can_moderate) for row in rows]

        return await self._run(context, operation)

    async def create_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        initial_comment_id: UUID,
        title: str,
        body: str,
        request_id: str,
        target: DiscussionTarget | None = None,
        assigned_to: UUID | None = None,
        mentioned_user_ids: tuple[UUID, ...] = (),
    ) -> DiscussionCreationReceipt:
        mentioned_user_ids = self._mention_ids(mentioned_user_ids)

        async def operation(transaction: TenantTransaction) -> DiscussionCreationReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_COMMENT, roles)
            if assigned_to is not None:
                self._require(Action.PROJECT_DISCUSSIONS_MODERATE, roles)
            existing = await self._load_discussion_optional(
                transaction, context, project_id, discussion_id, roles
            )
            if existing is not None:
                comment = await self._load_comment_optional(
                    transaction, context, project_id, discussion_id, initial_comment_id
                )
                if (
                    existing.initial_comment_id != initial_comment_id
                    or existing.title != title
                    or existing.created_by != context.user_id
                    or comment is None
                    or comment.body != body
                    or comment.created_by != context.user_id
                    or existing.target != target
                    or existing.assigned_to != assigned_to
                    or tuple(mention.user_id for mention in comment.mentions)
                    != tuple(sorted(mentioned_user_ids, key=str))
                ):
                    raise DiscussionConflict("discussion_id_conflict")
                return DiscussionCreationReceipt(existing, False)

            if target is not None:
                await self._require_target(transaction, context, project_id, target)
            await self._require_participants(
                transaction,
                context,
                project_id,
                tuple(
                    dict.fromkeys(
                        (*mentioned_user_ids, *((assigned_to,) if assigned_to is not None else ()))
                    )
                ),
            )

            await transaction.execute(
                """
                INSERT INTO app.project_discussions
                  (id, organization_id, project_id, initial_comment_id, title, created_by,
                   target_kind, target_map_id, target_map_version, target_layer_id,
                   target_dataset_id, target_feature_id, target_object_id,
                   target_object_version, assigned_to, assigned_by, assigned_at)
                VALUES (%s, %s, %s, %s, %s, %s,
                        %s::app.project_discussion_target_kind, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        CASE WHEN %s IS NULL THEN NULL ELSE clock_timestamp() END)
                """,
                (
                    discussion_id,
                    context.organization_id,
                    project_id,
                    initial_comment_id,
                    title,
                    context.user_id,
                    self._target_kind(target),
                    target.map_id if isinstance(target, FeatureDiscussionTarget) else None,
                    target.map_version if isinstance(target, FeatureDiscussionTarget) else None,
                    target.layer_id if isinstance(target, FeatureDiscussionTarget) else None,
                    target.dataset_id if isinstance(target, FeatureDiscussionTarget) else None,
                    target.feature_id if isinstance(target, FeatureDiscussionTarget) else None,
                    target.object_id if isinstance(target, ObjectDiscussionTarget) else None,
                    target.version if isinstance(target, ObjectDiscussionTarget) else None,
                    assigned_to,
                    context.user_id if assigned_to is not None else None,
                    assigned_to,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_discussion_comments
                  (id, organization_id, project_id, discussion_id, body, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    initial_comment_id,
                    context.organization_id,
                    project_id,
                    discussion_id,
                    body,
                    context.user_id,
                ),
            )
            await self._insert_mentions(
                transaction,
                context,
                project_id,
                discussion_id,
                initial_comment_id,
                mentioned_user_ids,
            )
            if assigned_to is not None:
                await self._notify(
                    transaction,
                    context,
                    project_id,
                    discussion_id,
                    1,
                    None,
                    "assignment",
                    (assigned_to,),
                )
            await self._notify(
                transaction,
                context,
                project_id,
                discussion_id,
                1,
                initial_comment_id,
                "mention",
                mentioned_user_ids,
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.discussion.created",
                "project_discussion",
                discussion_id,
                project_id,
                {
                    "title": title,
                    "initial_comment_id": str(initial_comment_id),
                    "target": self._target_payload(target),
                    "assigned_to": str(assigned_to) if assigned_to is not None else None,
                    "mentioned_user_ids": [str(value) for value in mentioned_user_ids],
                },
            )
            discussion = await self._load_discussion(
                transaction, context, project_id, discussion_id, roles
            )
            return DiscussionCreationReceipt(discussion, True)

        return await self._run(context, operation)

    async def list_comments(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        limit: int,
        offset: int,
    ) -> list[ProjectDiscussionComment]:
        async def operation(transaction: TenantTransaction) -> list[ProjectDiscussionComment]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            await self._require_discussion(transaction, context, project_id, discussion_id)
            rows = await transaction.fetch_all(
                self._comment_query(
                    "comment.organization_id = %s AND comment.project_id = %s "
                    "AND comment.discussion_id = %s"
                )
                + " ORDER BY comment.created_at, comment.id LIMIT %s OFFSET %s",
                (context.organization_id, project_id, discussion_id, limit, offset),
            )
            return [self._comment(row) for row in rows]

        return await self._run(context, operation)

    async def add_comment(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
        body: str,
        request_id: str,
        mentioned_user_ids: tuple[UUID, ...] = (),
    ) -> DiscussionCommentReceipt:
        mentioned_user_ids = self._mention_ids(mentioned_user_ids)

        async def operation(transaction: TenantTransaction) -> DiscussionCommentReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_COMMENT, roles)
            thread = await transaction.fetch_one(
                """
                SELECT state::text, version_number, created_by, assigned_to
                FROM app.project_discussions
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, discussion_id),
            )
            if thread is None:
                raise DiscussionNotFound("discussion")
            existing = await self._load_comment_optional(
                transaction, context, project_id, discussion_id, comment_id
            )
            if existing is not None:
                if (
                    existing.body != body
                    or existing.created_by != context.user_id
                    or tuple(mention.user_id for mention in existing.mentions)
                    != tuple(sorted(mentioned_user_ids, key=str))
                ):
                    raise DiscussionConflict("discussion_comment_id_conflict")
                return DiscussionCommentReceipt(existing, False)
            if str(thread[0]) != "open":
                raise DiscussionConflict("discussion_resolved")
            await self._require_participants(transaction, context, project_id, mentioned_user_ids)

            await transaction.execute(
                """
                INSERT INTO app.project_discussion_comments
                  (id, organization_id, project_id, discussion_id, body, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    comment_id,
                    context.organization_id,
                    project_id,
                    discussion_id,
                    body,
                    context.user_id,
                ),
            )
            await self._insert_mentions(
                transaction,
                context,
                project_id,
                discussion_id,
                comment_id,
                mentioned_user_ids,
            )
            await self._notify(
                transaction,
                context,
                project_id,
                discussion_id,
                int(thread[1]),
                comment_id,
                "mention",
                mentioned_user_ids,
            )
            reply_recipients = tuple(
                dict.fromkeys(
                    value
                    for value in (thread[2], thread[3])
                    if value is not None
                    and UUID(str(value)) != context.user_id
                    and UUID(str(value)) not in mentioned_user_ids
                )
            )
            await self._notify(
                transaction,
                context,
                project_id,
                discussion_id,
                int(thread[1]),
                comment_id,
                "reply",
                tuple(UUID(str(value)) for value in reply_recipients),
                include_subscribers=True,
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.discussion.comment.created",
                "project_discussion_comment",
                comment_id,
                project_id,
                {
                    "discussion_id": str(discussion_id),
                    "mentioned_user_ids": [str(value) for value in mentioned_user_ids],
                },
            )
            comment = await self._load_comment_optional(
                transaction, context, project_id, discussion_id, comment_id
            )
            if comment is None:
                raise DiscussionStoreUnavailable("discussion comment insert returned no row")
            return DiscussionCommentReceipt(comment, True)

        return await self._run(context, operation)

    async def transition_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        state: DiscussionState,
        expected_version: int,
        request_id: str,
    ) -> DiscussionTransitionReceipt:
        async def operation(transaction: TenantTransaction) -> DiscussionTransitionReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_MODERATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT state::text, version_number, created_by, assigned_to
                FROM app.project_discussions
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, discussion_id),
            )
            if current is None:
                raise DiscussionNotFound("discussion")
            current_state = cast(DiscussionState, str(current[0]))
            current_version = int(current[1])
            if current_version != expected_version:
                raise DiscussionConflict(
                    "discussion_version_conflict", current_version=current_version
                )
            if current_state == state:
                discussion = await self._load_discussion(
                    transaction, context, project_id, discussion_id, roles
                )
                return DiscussionTransitionReceipt(discussion, False)

            resolved_by = context.user_id if state == "resolved" else None
            await transaction.execute(
                """
                UPDATE app.project_discussions
                SET state = %s::app.project_discussion_state,
                    version_number = version_number + 1,
                    resolved_by = %s,
                    resolved_at = CASE WHEN %s::text = 'resolved'
                      THEN clock_timestamp() ELSE NULL END
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    state,
                    resolved_by,
                    state,
                    context.organization_id,
                    project_id,
                    discussion_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                (
                    "project.discussion.resolved"
                    if state == "resolved"
                    else "project.discussion.reopened"
                ),
                "project_discussion",
                discussion_id,
                project_id,
                {"previous_state": current_state, "version_number": current_version + 1},
            )
            await self._notify(
                transaction,
                context,
                project_id,
                discussion_id,
                current_version + 1,
                None,
                "state",
                tuple(
                    UUID(str(value))
                    for value in dict.fromkeys(
                        value
                        for value in (current[2], current[3])
                        if value is not None and UUID(str(value)) != context.user_id
                    )
                ),
                include_subscribers=True,
            )
            discussion = await self._load_discussion(
                transaction, context, project_id, discussion_id, roles
            )
            return DiscussionTransitionReceipt(discussion, True)

        return await self._run(context, operation)

    async def assign_discussion(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        assigned_to: UUID | None,
        expected_version: int,
        request_id: str,
    ) -> DiscussionAssignmentReceipt:
        async def operation(transaction: TenantTransaction) -> DiscussionAssignmentReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_MODERATE, roles)
            current = await transaction.fetch_one(
                """
                SELECT version_number, assigned_to
                FROM app.project_discussions
                WHERE organization_id = %s AND project_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, discussion_id),
            )
            if current is None:
                raise DiscussionNotFound("discussion")
            current_version = int(current[0])
            current_assignee = UUID(str(current[1])) if current[1] is not None else None
            if current_version != expected_version:
                raise DiscussionConflict(
                    "discussion_version_conflict", current_version=current_version
                )
            if current_assignee == assigned_to:
                discussion = await self._load_discussion(
                    transaction, context, project_id, discussion_id, roles
                )
                return DiscussionAssignmentReceipt(discussion, False)
            if assigned_to is not None:
                await self._require_participants(transaction, context, project_id, (assigned_to,))

            await transaction.execute(
                """
                UPDATE app.project_discussions
                SET assigned_to = %s,
                    assigned_by = CASE WHEN %s IS NULL THEN NULL ELSE %s END,
                    assigned_at = CASE WHEN %s IS NULL THEN NULL ELSE clock_timestamp() END,
                    version_number = version_number + 1
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (
                    assigned_to,
                    assigned_to,
                    context.user_id,
                    assigned_to,
                    context.organization_id,
                    project_id,
                    discussion_id,
                ),
            )
            next_version = current_version + 1
            await self._record_event(
                transaction,
                context,
                request_id,
                (
                    "project.discussion.unassigned"
                    if assigned_to is None
                    else "project.discussion.assigned"
                ),
                "project_discussion",
                discussion_id,
                project_id,
                {
                    "previous_assigned_to": (
                        str(current_assignee) if current_assignee is not None else None
                    ),
                    "assigned_to": str(assigned_to) if assigned_to is not None else None,
                    "version_number": next_version,
                },
            )
            if assigned_to is not None:
                await self._notify(
                    transaction,
                    context,
                    project_id,
                    discussion_id,
                    next_version,
                    None,
                    "assignment",
                    (assigned_to,),
                )
            discussion = await self._load_discussion(
                transaction, context, project_id, discussion_id, roles
            )
            return DiscussionAssignmentReceipt(discussion, True)

        return await self._run(context, operation)

    async def list_notifications(
        self,
        context: TenantContext,
        project_id: UUID,
        unread_only: bool,
        limit: int,
        offset: int,
    ) -> list[ProjectNotification]:
        async def operation(transaction: TenantTransaction) -> list[ProjectNotification]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            rows = await transaction.fetch_all(
                self._notification_query(
                    "notification.organization_id = %s "
                    "AND notification.project_id = %s "
                    "AND notification.recipient_user_id = %s "
                    "AND (NOT %s::boolean OR notification.read_at IS NULL)"
                )
                + " ORDER BY notification.created_at DESC, notification.id LIMIT %s OFFSET %s",
                (
                    context.organization_id,
                    project_id,
                    context.user_id,
                    unread_only,
                    limit,
                    offset,
                ),
            )
            return [self._notification(row) for row in rows]

        return await self._run(context, operation)

    async def mark_notification_read(
        self,
        context: TenantContext,
        project_id: UUID,
        notification_id: UUID,
        expected_version: int,
    ) -> NotificationReadReceipt:
        async def operation(transaction: TenantTransaction) -> NotificationReadReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            current = await transaction.fetch_one(
                """
                SELECT version_number, read_at
                FROM app.project_notifications
                WHERE organization_id = %s AND project_id = %s
                  AND recipient_user_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, context.user_id, notification_id),
            )
            if current is None:
                raise DiscussionNotFound("discussion_notification")
            current_version = int(current[0])
            if current_version != expected_version:
                raise DiscussionConflict(
                    "discussion_notification_version_conflict",
                    current_version=current_version,
                )
            if current[1] is not None:
                notification = await self._load_notification(
                    transaction, context, project_id, notification_id
                )
                return NotificationReadReceipt(notification, False)
            await transaction.execute(
                """
                UPDATE app.project_notifications
                SET read_at = clock_timestamp(), version_number = version_number + 1
                WHERE organization_id = %s AND project_id = %s
                  AND recipient_user_id = %s AND id = %s
                """,
                (context.organization_id, project_id, context.user_id, notification_id),
            )
            notification = await self._load_notification(
                transaction, context, project_id, notification_id
            )
            return NotificationReadReceipt(notification, True)

        return await self._run(context, operation)

    async def get_subscription(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
    ) -> ProjectDiscussionSubscription | None:
        async def operation(
            transaction: TenantTransaction,
        ) -> ProjectDiscussionSubscription | None:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            await self._require_discussion(transaction, context, project_id, discussion_id)
            return await self._load_subscription_optional(
                transaction, context, project_id, discussion_id
            )

        return await self._run(context, operation)

    async def set_subscription(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        subscribed: bool,
        expected_version: int | None,
        request_id: str,
    ) -> DiscussionSubscriptionReceipt:
        async def operation(transaction: TenantTransaction) -> DiscussionSubscriptionReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_READ, roles)
            await self._require_discussion(transaction, context, project_id, discussion_id)
            row = await transaction.fetch_one(
                """
                SELECT version_number, subscribed_at, unsubscribed_at
                FROM app.project_discussion_subscriptions
                WHERE organization_id = %s AND project_id = %s
                  AND discussion_id = %s AND user_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, discussion_id, context.user_id),
            )
            if row is None:
                if expected_version is not None:
                    raise DiscussionConflict(
                        "discussion_subscription_version_conflict", current_version=0
                    )
                if not subscribed:
                    return DiscussionSubscriptionReceipt(None, False)
                await transaction.execute(
                    """
                    INSERT INTO app.project_discussion_subscriptions
                      (organization_id, project_id, discussion_id, user_id)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (context.organization_id, project_id, discussion_id, context.user_id),
                )
                event_type = "project.discussion.subscribed"
            else:
                current_version = int(row[0])
                if expected_version != current_version:
                    raise DiscussionConflict(
                        "discussion_subscription_version_conflict",
                        current_version=current_version,
                    )
                current_subscribed = row[2] is None
                if current_subscribed == subscribed:
                    return DiscussionSubscriptionReceipt(
                        self._subscription(discussion_id, row), False
                    )
                await transaction.execute(
                    """
                    WITH moment AS (SELECT clock_timestamp() AS value)
                    UPDATE app.project_discussion_subscriptions subscription
                    SET version_number = subscription.version_number + 1,
                        subscribed_at = CASE WHEN %s::boolean
                          THEN moment.value ELSE subscription.subscribed_at END,
                        unsubscribed_at = CASE WHEN %s::boolean
                          THEN NULL ELSE moment.value END,
                        updated_at = moment.value
                    FROM moment
                    WHERE subscription.organization_id = %s
                      AND subscription.project_id = %s
                      AND subscription.discussion_id = %s
                      AND subscription.user_id = %s
                    """,
                    (
                        subscribed,
                        subscribed,
                        context.organization_id,
                        project_id,
                        discussion_id,
                        context.user_id,
                    ),
                )
                event_type = (
                    "project.discussion.subscribed"
                    if subscribed
                    else "project.discussion.unsubscribed"
                )
            await self._record_event(
                transaction,
                context,
                request_id,
                event_type,
                "project_discussion",
                discussion_id,
                project_id,
                {"subscribed": subscribed},
            )
            subscription = await self._load_subscription_optional(
                transaction, context, project_id, discussion_id
            )
            if subscription is None:
                raise DiscussionStoreUnavailable("discussion subscription write returned no row")
            return DiscussionSubscriptionReceipt(subscription, True)

        return await self._run(context, operation)

    async def moderate_comment(
        self,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
        moderation_id: UUID,
        reason: str,
        request_id: str,
    ) -> DiscussionModerationReceipt:
        async def operation(transaction: TenantTransaction) -> DiscussionModerationReceipt:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_DISCUSSIONS_MODERATE, roles)
            await self._require_discussion(transaction, context, project_id, discussion_id)
            comment = await self._load_comment_optional(
                transaction, context, project_id, discussion_id, comment_id
            )
            if comment is None:
                raise DiscussionNotFound("discussion_comment")
            existing = await transaction.fetch_one(
                """
                SELECT id, action::text, reason, actor_user_id
                FROM app.project_discussion_comment_moderations
                WHERE organization_id = %s AND project_id = %s
                  AND discussion_id = %s AND comment_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, discussion_id, comment_id),
            )
            if existing is not None:
                if (
                    UUID(str(existing[0])) != moderation_id
                    or str(existing[1]) != "redact"
                    or str(existing[2]) != reason
                    or UUID(str(existing[3])) != context.user_id
                ):
                    raise DiscussionConflict("discussion_comment_already_moderated")
                current = await self._load_comment_optional(
                    transaction, context, project_id, discussion_id, comment_id
                )
                if current is None:
                    raise DiscussionStoreUnavailable("moderated comment disappeared")
                return DiscussionModerationReceipt(current, False)

            await transaction.execute(
                """
                INSERT INTO app.project_discussion_comment_moderations
                  (id, organization_id, project_id, discussion_id, comment_id,
                   action, reason, actor_user_id)
                VALUES (%s, %s, %s, %s, %s,
                        'redact'::app.project_discussion_moderation_action, %s, %s)
                """,
                (
                    moderation_id,
                    context.organization_id,
                    project_id,
                    discussion_id,
                    comment_id,
                    reason,
                    context.user_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.discussion.comment.redacted",
                "project_discussion_comment",
                comment_id,
                project_id,
                {
                    "discussion_id": str(discussion_id),
                    "moderation_id": str(moderation_id),
                    "reason": reason,
                },
            )
            current = await self._load_comment_optional(
                transaction, context, project_id, discussion_id, comment_id
            )
            if current is None:
                raise DiscussionStoreUnavailable("moderated comment insert returned no row")
            return DiscussionModerationReceipt(current, True)

        return await self._run(context, operation)

    async def _load_discussion(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        roles: Roles,
    ) -> ProjectDiscussion:
        discussion = await self._load_discussion_optional(
            transaction, context, project_id, discussion_id, roles
        )
        if discussion is None:
            raise DiscussionNotFound("discussion")
        return discussion

    @staticmethod
    async def _require_target(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        target: DiscussionTarget,
    ) -> None:
        if isinstance(target, FeatureDiscussionTarget):
            statement = """
                SELECT 1
                FROM app.maps map
                JOIN app.map_versions map_version
                  ON map_version.organization_id = map.organization_id
                 AND map_version.map_id = map.id
                 AND map_version.version = %s
                JOIN app.project_datasets project_dataset
                  ON project_dataset.organization_id = map.organization_id
                 AND project_dataset.project_id = map.project_id
                 AND project_dataset.dataset_id = %s
                JOIN app.dataset_features feature
                  ON feature.organization_id = project_dataset.organization_id
                 AND feature.dataset_id = project_dataset.dataset_id
                 AND feature.id = %s
                 AND feature.deleted_at IS NULL
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(map_version.definition->'layers') = 'array'
                      THEN map_version.definition->'layers'
                    ELSE '[]'::jsonb
                  END
                ) layer
                WHERE map.organization_id = %s
                  AND map.project_id = %s
                  AND map.id = %s
                  AND map.status = 'active'
                  AND layer->>'layerId' = %s
                  AND layer->>'datasetId' = %s
                LIMIT 1
            """
            parameters: tuple[object, ...] = (
                target.map_version,
                target.dataset_id,
                target.feature_id,
                context.organization_id,
                project_id,
                target.map_id,
                target.layer_id,
                str(target.dataset_id),
            )
        elif target.kind == "map":
            statement = """
                SELECT 1 FROM app.maps map
                JOIN app.map_versions version
                  ON version.organization_id = map.organization_id
                 AND version.map_id = map.id AND version.version = %s
                WHERE map.organization_id = %s AND map.project_id = %s
                  AND map.id = %s AND map.version = %s AND map.status = 'active'
                LIMIT 1
            """
            parameters = (
                target.version,
                context.organization_id,
                project_id,
                target.object_id,
                target.version,
            )
        elif target.kind == "dataset":
            statement = """
                SELECT 1 FROM app.project_datasets project_dataset
                JOIN app.datasets dataset
                  ON dataset.organization_id = project_dataset.organization_id
                 AND dataset.id = project_dataset.dataset_id
                JOIN app.dataset_versions version
                  ON version.organization_id = dataset.organization_id
                 AND version.dataset_id = dataset.id
                 AND version.id = dataset.current_version_id
                 AND version.version_number = %s
                WHERE project_dataset.organization_id = %s
                  AND project_dataset.project_id = %s
                  AND project_dataset.dataset_id = %s
                  AND dataset.status <> 'archived'
                LIMIT 1
            """
            parameters = (
                target.version,
                context.organization_id,
                project_id,
                target.object_id,
            )
        elif target.kind == "resource":
            statement = """
                SELECT 1 FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                 AND version.version_number = %s
                WHERE resource.organization_id = %s AND resource.project_id = %s
                  AND resource.id = %s AND resource.state <> 'archived'
                LIMIT 1
            """
            parameters = (
                target.version,
                context.organization_id,
                project_id,
                target.object_id,
            )
        else:
            statement = """
                SELECT 1 FROM app.project_sites site
                JOIN app.project_site_versions version
                  ON version.organization_id = site.organization_id
                 AND version.project_id = site.project_id
                 AND version.site_id = site.id
                 AND version.id = site.current_version_id
                 AND version.version_number = %s
                WHERE site.organization_id = %s AND site.project_id = %s
                  AND site.id = %s AND site.current_version_number = %s
                LIMIT 1
            """
            parameters = (
                target.version,
                context.organization_id,
                project_id,
                target.object_id,
                target.version,
            )
        row = await transaction.fetch_one(statement, parameters)
        if row is None:
            raise DiscussionNotFound("discussion_target")

    @staticmethod
    async def _require_participants(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        user_ids: tuple[UUID, ...],
    ) -> None:
        if not user_ids:
            return
        row = await transaction.fetch_one(
            """
            SELECT count(*)::integer
            FROM app.organization_memberships member
            WHERE member.organization_id = %s
              AND member.user_id = ANY(%s::uuid[])
              AND (
                member.role = 'admin'
                OR app.effective_project_role(%s, member.user_id) IS NOT NULL
              )
            """,
            (context.organization_id, list(user_ids), project_id),
        )
        if row is None or int(row[0]) != len(user_ids):
            raise DiscussionNotFound("discussion_participant")

    @staticmethod
    async def _insert_mentions(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
        user_ids: tuple[UUID, ...],
    ) -> None:
        if not user_ids:
            return
        await transaction.execute(
            """
            INSERT INTO app.project_discussion_comment_mentions
              (organization_id, project_id, discussion_id, comment_id,
               mentioned_user_id, mentioned_by)
            SELECT %s, %s, %s, %s, mentioned_user_id, %s
            FROM unnest(%s::uuid[]) AS mentioned_user_id
            ORDER BY mentioned_user_id
            """,
            (
                context.organization_id,
                project_id,
                discussion_id,
                comment_id,
                context.user_id,
                list(user_ids),
            ),
        )

    @staticmethod
    async def _notify(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        discussion_version: int,
        comment_id: UUID | None,
        kind: NotificationKind,
        user_ids: tuple[UUID, ...],
        *,
        include_subscribers: bool = False,
    ) -> None:
        recipients = tuple(value for value in dict.fromkeys(user_ids) if value != context.user_id)
        if not recipients and not include_subscribers:
            return
        await transaction.execute(
            """
            SELECT app.notify_project_discussion_recipients(
              %s, %s, %s, %s, %s, %s::app.project_notification_kind, %s::uuid[], %s
            )
            """,
            (
                context.organization_id,
                project_id,
                discussion_id,
                discussion_version,
                comment_id,
                kind,
                list(recipients),
                include_subscribers,
            ),
        )

    @staticmethod
    async def _load_subscription_optional(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
    ) -> ProjectDiscussionSubscription | None:
        row = await transaction.fetch_one(
            """
            SELECT version_number, subscribed_at, unsubscribed_at
            FROM app.project_discussion_subscriptions
            WHERE organization_id = %s AND project_id = %s
              AND discussion_id = %s AND user_id = %s
            """,
            (context.organization_id, project_id, discussion_id, context.user_id),
        )
        return (
            None if row is None else PostgresDiscussionRepository._subscription(discussion_id, row)
        )

    async def _load_discussion_optional(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        roles: Roles,
    ) -> ProjectDiscussion | None:
        row = await transaction.fetch_one(
            self._discussion_query(
                "discussion.organization_id = %s AND discussion.project_id = %s "
                "AND discussion.id = %s"
            ),
            (context.organization_id, project_id, discussion_id),
        )
        return (
            None
            if row is None
            else self._discussion(row, is_allowed(Action.PROJECT_DISCUSSIONS_MODERATE, roles))
        )

    @staticmethod
    async def _load_comment_optional(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
        comment_id: UUID,
    ) -> ProjectDiscussionComment | None:
        row = await transaction.fetch_one(
            PostgresDiscussionRepository._comment_query(
                "comment.organization_id = %s AND comment.project_id = %s "
                "AND comment.discussion_id = %s AND comment.id = %s"
            ),
            (context.organization_id, project_id, discussion_id, comment_id),
        )
        return None if row is None else PostgresDiscussionRepository._comment(row)

    async def _load_notification(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        notification_id: UUID,
    ) -> ProjectNotification:
        row = await transaction.fetch_one(
            self._notification_query(
                "notification.organization_id = %s AND notification.project_id = %s "
                "AND notification.recipient_user_id = %s AND notification.id = %s"
            ),
            (context.organization_id, project_id, context.user_id, notification_id),
        )
        if row is None:
            raise DiscussionNotFound("discussion_notification")
        return self._notification(row)

    @staticmethod
    async def _require_discussion(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        discussion_id: UUID,
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT 1 FROM app.project_discussions
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (context.organization_id, project_id, discussion_id),
        )
        if row is None:
            raise DiscussionNotFound("discussion")

    async def _project_roles(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if organization is None:
            raise DiscussionAccessDenied("organization membership required")
        project = await transaction.fetch_one(
            """
            SELECT app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if project is None:
            raise DiscussionNotFound("project")
        return Roles(cast(OrganizationRole, str(organization[0])), self._project_role(project[0]))

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        project_id: UUID,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type, resource_type,
               resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _discussion_query(where: str) -> str:
        return f"""
            SELECT discussion.id, discussion.project_id, discussion.initial_comment_id,
                   discussion.title, discussion.state::text, discussion.version_number,
                   discussion.created_by, creator.display_name,
                   discussion.resolved_by, resolver.display_name, discussion.resolved_at,
                   discussion.created_at, discussion.updated_at,
                   count(comment.id)::integer,
                   COALESCE(max(comment.created_at), discussion.created_at) AS latest_comment_at,
                   discussion.target_kind::text, discussion.target_map_id,
                   discussion.target_map_version, discussion.target_layer_id,
                   discussion.target_dataset_id, discussion.target_feature_id,
                   discussion.target_object_id, discussion.target_object_version,
                   discussion.assigned_to, assignee.display_name,
                   discussion.assigned_by, assigner.display_name, discussion.assigned_at
            FROM app.project_discussions discussion
            JOIN app.users creator ON creator.id = discussion.created_by
            LEFT JOIN app.users resolver ON resolver.id = discussion.resolved_by
            LEFT JOIN app.users assignee ON assignee.id = discussion.assigned_to
            LEFT JOIN app.users assigner ON assigner.id = discussion.assigned_by
            LEFT JOIN app.project_discussion_comments comment
              ON comment.organization_id = discussion.organization_id
             AND comment.project_id = discussion.project_id
             AND comment.discussion_id = discussion.id
            WHERE {where}
            GROUP BY discussion.id, discussion.project_id, discussion.initial_comment_id,
                     discussion.title, discussion.state, discussion.version_number,
                     discussion.created_by, creator.display_name,
                     discussion.resolved_by, resolver.display_name, discussion.resolved_at,
                     discussion.created_at, discussion.updated_at,
                     discussion.target_kind, discussion.target_map_id,
                     discussion.target_map_version, discussion.target_layer_id,
                     discussion.target_dataset_id, discussion.target_feature_id,
                     discussion.target_object_id, discussion.target_object_version,
                     discussion.assigned_to, assignee.display_name,
                     discussion.assigned_by, assigner.display_name, discussion.assigned_at
        """

    @staticmethod
    def _comment_query(where: str) -> str:
        return f"""
            SELECT comment.id, comment.project_id, comment.discussion_id,
                   CASE WHEN moderation.id IS NULL
                     THEN comment.body ELSE '[Comment redacted]' END,
                   comment.created_by, creator.display_name, comment.created_at,
                   COALESCE(
                     (
                       SELECT jsonb_agg(
                         jsonb_build_object(
                           'user_id', mention.mentioned_user_id,
                           'display_name', mentioned_user.display_name
                         ) ORDER BY lower(mentioned_user.display_name), mention.mentioned_user_id
                       )
                       FROM app.project_discussion_comment_mentions mention
                       JOIN app.users mentioned_user
                         ON mentioned_user.id = mention.mentioned_user_id
                       WHERE mention.organization_id = comment.organization_id
                         AND mention.project_id = comment.project_id
                         AND mention.discussion_id = comment.discussion_id
                         AND mention.comment_id = comment.id
                     ),
                     '[]'::jsonb
                   ) AS mentions,
                   moderation.id, moderation.action::text, moderation.reason,
                   moderation.actor_user_id, moderator.display_name, moderation.created_at
            FROM app.project_discussion_comments comment
            JOIN app.users creator ON creator.id = comment.created_by
            LEFT JOIN app.project_discussion_comment_moderations moderation
              ON moderation.organization_id = comment.organization_id
             AND moderation.project_id = comment.project_id
             AND moderation.discussion_id = comment.discussion_id
             AND moderation.comment_id = comment.id
            LEFT JOIN app.users moderator ON moderator.id = moderation.actor_user_id
            WHERE {where}
        """

    @staticmethod
    def _notification_query(where: str) -> str:
        return f"""
            SELECT notification.id, notification.project_id,
                   notification.discussion_id, discussion.title,
                   notification.discussion_version, notification.comment_id,
                   notification.kind::text, notification.actor_user_id,
                   actor.display_name, notification.version_number,
                   notification.read_at, notification.created_at
            FROM app.project_notifications notification
            JOIN app.project_discussions discussion
              ON discussion.organization_id = notification.organization_id
             AND discussion.project_id = notification.project_id
             AND discussion.id = notification.discussion_id
            JOIN app.users actor ON actor.id = notification.actor_user_id
            WHERE {where}
        """

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise DiscussionAccessDenied(action) from error

    @staticmethod
    def _discussion(row: tuple[Any, ...], can_moderate: bool) -> ProjectDiscussion:
        target_kind = str(row[15])
        target: DiscussionTarget | None
        if target_kind == "feature":
            target = FeatureDiscussionTarget(
                map_id=UUID(str(row[16])),
                map_version=int(row[17]),
                layer_id=str(row[18]),
                dataset_id=UUID(str(row[19])),
                feature_id=UUID(str(row[20])),
            )
        elif target_kind in {"map", "dataset", "resource", "site"}:
            target = ObjectDiscussionTarget(
                kind=cast(ObjectDiscussionKind, target_kind),
                object_id=UUID(str(row[21])),
                version=int(row[22]),
            )
        else:
            target = None
        return ProjectDiscussion(
            discussion_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            initial_comment_id=UUID(str(row[2])),
            title=str(row[3]),
            state=cast(DiscussionState, str(row[4])),
            version_number=int(row[5]),
            created_by=UUID(str(row[6])),
            created_by_name=str(row[7]),
            resolved_by=UUID(str(row[8])) if row[8] is not None else None,
            resolved_by_name=str(row[9]) if row[9] is not None else None,
            resolved_at=cast(datetime | None, row[10]),
            created_at=cast(datetime, row[11]),
            updated_at=cast(datetime, row[12]),
            comment_count=int(row[13]),
            latest_comment_at=cast(datetime, row[14]),
            can_moderate=can_moderate,
            target=target,
            assigned_to=UUID(str(row[23])) if row[23] is not None else None,
            assigned_to_name=str(row[24]) if row[24] is not None else None,
            assigned_by=UUID(str(row[25])) if row[25] is not None else None,
            assigned_by_name=str(row[26]) if row[26] is not None else None,
            assigned_at=cast(datetime | None, row[27]),
        )

    @staticmethod
    def _target_payload(target: DiscussionTarget | None) -> dict[str, object]:
        if target is None:
            return {"kind": "project"}
        if isinstance(target, ObjectDiscussionTarget):
            return {
                "kind": target.kind,
                "object_id": str(target.object_id),
                "version": target.version,
            }
        return {
            "kind": "feature",
            "map_id": str(target.map_id),
            "map_version": target.map_version,
            "layer_id": target.layer_id,
            "dataset_id": str(target.dataset_id),
            "feature_id": str(target.feature_id),
        }

    @staticmethod
    def _target_kind(target: DiscussionTarget | None) -> str:
        if target is None:
            return "project"
        return target.kind if isinstance(target, ObjectDiscussionTarget) else "feature"

    @staticmethod
    def _comment(row: tuple[Any, ...]) -> ProjectDiscussionComment:
        raw_mentions = row[7] if len(row) > 7 and row[7] is not None else []
        moderation = (
            ProjectDiscussionModeration(
                moderation_id=UUID(str(row[8])),
                action=cast(ModerationAction, str(row[9])),
                reason=str(row[10]),
                actor_user_id=UUID(str(row[11])),
                actor_name=str(row[12]),
                created_at=cast(datetime, row[13]),
            )
            if len(row) > 13 and row[8] is not None
            else None
        )
        return ProjectDiscussionComment(
            comment_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            discussion_id=UUID(str(row[2])),
            body=str(row[3]),
            created_by=UUID(str(row[4])),
            created_by_name=str(row[5]),
            created_at=cast(datetime, row[6]),
            mentions=tuple(
                ProjectDiscussionMention(
                    user_id=UUID(str(mention["user_id"])),
                    display_name=str(mention["display_name"]),
                )
                for mention in raw_mentions
            ),
            moderation=moderation,
        )

    @staticmethod
    def _subscription(discussion_id: UUID, row: tuple[Any, ...]) -> ProjectDiscussionSubscription:
        return ProjectDiscussionSubscription(
            discussion_id=discussion_id,
            version_number=int(row[0]),
            subscribed_at=cast(datetime, row[1]),
            unsubscribed_at=cast(datetime | None, row[2]),
        )

    @staticmethod
    def _notification(row: tuple[Any, ...]) -> ProjectNotification:
        return ProjectNotification(
            notification_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            discussion_id=UUID(str(row[2])),
            discussion_title=str(row[3]),
            discussion_version=int(row[4]),
            comment_id=UUID(str(row[5])) if row[5] is not None else None,
            kind=cast(NotificationKind, str(row[6])),
            actor_user_id=UUID(str(row[7])),
            actor_name=str(row[8]),
            version_number=int(row[9]),
            read_at=cast(datetime | None, row[10]),
            created_at=cast(datetime, row[11]),
        )

    @staticmethod
    def _mention_ids(user_ids: tuple[UUID, ...]) -> tuple[UUID, ...]:
        if len(user_ids) > 20 or len(set(user_ids)) != len(user_ids):
            raise DiscussionConflict("discussion_mentions_invalid")
        return tuple(sorted(user_ids, key=str))

    @staticmethod
    def _project_role(value: object) -> ProjectRole | None:
        return (
            cast(ProjectRole, str(value))
            if value in {"owner", "editor", "reviewer", "viewer"}
            else None
        )
