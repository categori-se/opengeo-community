from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, TypeVar, cast
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    ResourcePermissionRole,
    Roles,
    authorize,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)


class ResourceRatingStoreUnavailable(RuntimeError):
    pass


class ResourceRatingAccessDenied(RuntimeError):
    pass


class ResourceRatingNotFound(RuntimeError):
    pass


class ResourceRatingConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ResourceRatingSummary:
    project_id: UUID
    resource_id: UUID
    rating_count: int
    rating_average: float | None
    caller_score: int | None
    caller_version: int | None
    caller_withdrawn: bool
    updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class ResourceRatingMutationReceipt:
    changed: bool
    summary: ResourceRatingSummary


class ResourceRatingRepository(Protocol):
    async def get_summary(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> ResourceRatingSummary: ...

    async def set_rating(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        score: int | None,
        expected_version: int | None,
        request_id: str,
    ) -> ResourceRatingMutationReceipt: ...


ResultT = TypeVar("ResultT")


class PostgresResourceRatingRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except (
            ResourceRatingAccessDenied,
            ResourceRatingNotFound,
            ResourceRatingConflict,
        ):
            raise
        except TenantDatabaseConflict as error:
            raise ResourceRatingConflict("resource_rating_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise ResourceRatingStoreUnavailable("resource rating database unavailable") from error

    async def get_summary(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> ResourceRatingSummary:
        async def operation(transaction: TenantTransaction) -> ResourceRatingSummary:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require_read(roles)
            return await self._load_summary(transaction, context, project_id, resource_id)

        return await self._run(context, operation)

    async def set_rating(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        score: int | None,
        expected_version: int | None,
        request_id: str,
    ) -> ResourceRatingMutationReceipt:
        if score is not None and not 1 <= score <= 5:
            raise ResourceRatingConflict("resource_rating_score_invalid")

        async def operation(transaction: TenantTransaction) -> ResourceRatingMutationReceipt:
            roles = await self._resource_roles(transaction, context, project_id, resource_id)
            self._require_read(roles)
            current = await transaction.fetch_one(
                """
                SELECT score, version_number, withdrawn_at
                FROM app.governed_resource_ratings
                WHERE organization_id = %s AND project_id = %s
                  AND resource_id = %s AND user_id = %s
                FOR UPDATE
                """,
                (context.organization_id, project_id, resource_id, context.user_id),
            )
            if current is None:
                if expected_version is not None:
                    raise ResourceRatingConflict(
                        "resource_rating_version_conflict", current_version=0
                    )
                if score is None:
                    return ResourceRatingMutationReceipt(
                        False,
                        await self._load_summary(transaction, context, project_id, resource_id),
                    )
                await transaction.execute(
                    """
                    INSERT INTO app.governed_resource_ratings
                      (organization_id, project_id, resource_id, user_id, score)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        context.organization_id,
                        project_id,
                        resource_id,
                        context.user_id,
                        score,
                    ),
                )
                event_type = "resource.rating.created"
            else:
                current_score = int(current[0]) if current[0] is not None else None
                current_version = int(current[1])
                if expected_version != current_version:
                    raise ResourceRatingConflict(
                        "resource_rating_version_conflict",
                        current_version=current_version,
                    )
                if current_score == score:
                    return ResourceRatingMutationReceipt(
                        False,
                        await self._load_summary(transaction, context, project_id, resource_id),
                    )
                await transaction.execute(
                    """
                    WITH moment AS (SELECT clock_timestamp() AS value)
                    UPDATE app.governed_resource_ratings rating
                    SET score = %s,
                        version_number = rating.version_number + 1,
                        withdrawn_at = CASE WHEN %s::smallint IS NULL
                          THEN moment.value ELSE NULL END,
                        updated_at = moment.value
                    FROM moment
                    WHERE rating.organization_id = %s AND rating.project_id = %s
                      AND rating.resource_id = %s AND rating.user_id = %s
                    """,
                    (
                        score,
                        score,
                        context.organization_id,
                        project_id,
                        resource_id,
                        context.user_id,
                    ),
                )
                event_type = (
                    "resource.rating.withdrawn" if score is None else "resource.rating.updated"
                )
            await transaction.execute(
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                VALUES (%s, %s, %s, %s, 'governed_resource', %s, %s, %s)
                """,
                (
                    context.organization_id,
                    context.user_id,
                    project_id,
                    event_type,
                    resource_id,
                    request_id,
                    Jsonb({"score": score}),
                ),
            )
            return ResourceRatingMutationReceipt(
                True,
                await self._load_summary(transaction, context, project_id, resource_id),
            )

        return await self._run(context, operation)

    @staticmethod
    async def _load_summary(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> ResourceRatingSummary:
        row = await transaction.fetch_one(
            """
            SELECT COALESCE(summary.rating_count, 0),
                   COALESCE(summary.rating_sum, 0), summary.updated_at,
                   rating.score, rating.version_number, rating.withdrawn_at
            FROM app.governed_resources resource
            LEFT JOIN app.governed_resource_rating_summaries summary
              ON summary.organization_id = resource.organization_id
             AND summary.project_id = resource.project_id
             AND summary.resource_id = resource.id
            LEFT JOIN app.governed_resource_ratings rating
              ON rating.organization_id = resource.organization_id
             AND rating.project_id = resource.project_id
             AND rating.resource_id = resource.id
             AND rating.user_id = %s
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = %s
            """,
            (context.user_id, context.organization_id, project_id, resource_id),
        )
        if row is None:
            raise ResourceRatingNotFound("resource")
        rating_count = int(row[0])
        rating_sum = int(row[1])
        return ResourceRatingSummary(
            project_id=project_id,
            resource_id=resource_id,
            rating_count=rating_count,
            rating_average=(rating_sum / rating_count if rating_count else None),
            caller_score=int(row[3]) if row[3] is not None else None,
            caller_version=int(row[4]) if row[4] is not None else None,
            caller_withdrawn=row[4] is not None and row[3] is None,
            updated_at=cast(datetime | None, row[2]),
        )

    @staticmethod
    async def _resource_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> Roles:
        row = await transaction.fetch_one(
            """
            SELECT membership.role::text,
                   app.effective_project_role(%s, %s)::text,
                   permission.role::text,
                   resource.owner_user_id = %s
            FROM app.governed_resources resource
            JOIN app.organization_memberships membership
              ON membership.organization_id = resource.organization_id
             AND membership.user_id = %s
            LEFT JOIN app.governed_resource_permissions permission
              ON permission.organization_id = resource.organization_id
             AND permission.resource_id = resource.id
             AND permission.user_id = %s
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = %s
            """,
            (
                project_id,
                context.user_id,
                context.user_id,
                context.user_id,
                context.user_id,
                context.organization_id,
                project_id,
                resource_id,
            ),
        )
        if row is None:
            raise ResourceRatingNotFound("resource")
        return Roles(
            organization=cast(OrganizationRole, str(row[0])),
            project=(
                cast(ProjectRole, str(row[1]))
                if row[1] in {"owner", "editor", "reviewer", "viewer"}
                else None
            ),
            resource=(
                cast(ResourcePermissionRole, str(row[2]))
                if row[2] in {"manage", "edit", "publish", "view"}
                else None
            ),
            resource_owner=bool(row[3]),
        )

    @staticmethod
    def _require_read(roles: Roles) -> None:
        try:
            authorize(Action.RESOURCE_READ, roles)
        except AuthorizationDenied as error:
            raise ResourceRatingAccessDenied("resource.read") from error
