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
    TeamRole,
    authorize,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

RecordStatus = Literal["active", "archived"]


class TeamStoreUnavailable(RuntimeError):
    pass


class TeamAccessDenied(RuntimeError):
    pass


class TeamNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class TeamConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class Team:
    team_id: UUID
    name: str
    description: str | None
    status: RecordStatus
    caller_role: TeamRole | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class TeamMember:
    user_id: UUID
    email: str
    display_name: str
    role: TeamRole
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ProjectTeamGrant:
    grant_id: UUID
    project_id: UUID
    team_id: UUID
    team_name: str
    role: ProjectRole
    created_at: datetime
    updated_at: datetime


class TeamRepository(Protocol):
    async def list_teams(self, context: TenantContext) -> list[Team]: ...

    async def create_team(
        self,
        context: TenantContext,
        name: str,
        description: str | None,
        request_id: str,
    ) -> Team: ...

    async def list_members(self, context: TenantContext, team_id: UUID) -> list[TeamMember]: ...

    async def add_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        role: TeamRole,
        request_id: str,
    ) -> TeamMember: ...

    async def update_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        role: TeamRole,
        request_id: str,
    ) -> TeamMember: ...

    async def remove_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None: ...

    async def list_project_grants(
        self, context: TenantContext, project_id: UUID
    ) -> list[ProjectTeamGrant]: ...

    async def create_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> ProjectTeamGrant: ...

    async def update_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> ProjectTeamGrant: ...

    async def remove_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        request_id: str,
    ) -> None: ...


ResultT = TypeVar("ResultT")


class PostgresTeamRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except (TeamAccessDenied, TeamNotFound, TeamConflict):
            raise
        except TenantDatabaseConflict as error:
            raise TeamConflict("team_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise TeamStoreUnavailable("team database unavailable") from error

    async def list_teams(self, context: TenantContext) -> list[Team]:
        async def operation(transaction: TenantTransaction) -> list[Team]:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.TEAM_LIST, Roles(organization_role))
            rows = await transaction.fetch_all(
                """
                SELECT team.id, team.name, team.description, team.status::text,
                       membership.role::text, team.created_at, team.updated_at
                FROM app.teams team
                LEFT JOIN app.team_memberships membership
                  ON membership.organization_id = team.organization_id
                 AND membership.team_id = team.id
                 AND membership.user_id = %s
                WHERE team.organization_id = %s
                  AND team.status = 'active'
                  AND (%s OR membership.user_id IS NOT NULL)
                ORDER BY lower(team.name), team.id
                """,
                (context.user_id, context.organization_id, organization_role == "admin"),
            )
            return [self._team(row) for row in rows]

        return await self._run(context, operation)

    async def create_team(
        self,
        context: TenantContext,
        name: str,
        description: str | None,
        request_id: str,
    ) -> Team:
        async def operation(transaction: TenantTransaction) -> Team:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.TEAM_CREATE, Roles(organization_role))
            row = await transaction.fetch_one(
                """
                INSERT INTO app.teams
                  (organization_id, name, description, created_by)
                VALUES (%s, %s, %s, %s)
                RETURNING id, name, description, status::text, 'owner'::text,
                          created_at, updated_at
                """,
                (context.organization_id, name, description, context.user_id),
            )
            team = self._team_required(row)
            await transaction.execute(
                """
                INSERT INTO app.team_memberships
                  (organization_id, team_id, user_id, role, created_by)
                VALUES (%s, %s, %s, 'owner', %s)
                """,
                (context.organization_id, team.team_id, context.user_id, context.user_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "team.created",
                "team",
                team.team_id,
                None,
                {"name": team.name},
            )
            return team

        return await self._run(context, operation)

    async def list_members(self, context: TenantContext, team_id: UUID) -> list[TeamMember]:
        async def operation(transaction: TenantTransaction) -> list[TeamMember]:
            roles = await self._team_roles(transaction, context, team_id)
            self._require(Action.TEAM_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT identity.id, identity.email, identity.display_name,
                       membership.role::text, membership.created_at, membership.updated_at
                FROM app.team_memberships membership
                JOIN app.users identity ON identity.id = membership.user_id
                WHERE membership.organization_id = %s AND membership.team_id = %s
                ORDER BY CASE membership.role
                  WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'member' THEN 3 END,
                  lower(identity.display_name), identity.id
                """,
                (context.organization_id, team_id),
            )
            return [self._member(row) for row in rows]

        return await self._run(context, operation)

    async def add_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        role: TeamRole,
        request_id: str,
    ) -> TeamMember:
        async def operation(transaction: TenantTransaction) -> TeamMember:
            await self._lock_team(transaction, context, team_id)
            roles = await self._team_roles(transaction, context, team_id)
            self._require(Action.TEAM_MEMBERS_MANAGE, roles)
            await self._require_organization_member(transaction, context, user_id)
            row = await transaction.fetch_one(
                """
                INSERT INTO app.team_memberships
                  (organization_id, team_id, user_id, role, created_by)
                VALUES (%s, %s, %s, %s::app.team_role, %s)
                ON CONFLICT (organization_id, team_id, user_id) DO NOTHING
                RETURNING user_id, role::text, created_at, updated_at
                """,
                (context.organization_id, team_id, user_id, role, context.user_id),
            )
            if row is None:
                raise TeamConflict("team_membership_exists")
            member = await self._load_member(transaction, context, team_id, user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "team.membership.created",
                "team_membership",
                user_id,
                None,
                {"team_id": str(team_id), "role": role},
            )
            return member

        return await self._run(context, operation)

    async def update_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        role: TeamRole,
        request_id: str,
    ) -> TeamMember:
        async def operation(transaction: TenantTransaction) -> TeamMember:
            await self._lock_team(transaction, context, team_id)
            roles = await self._team_roles(transaction, context, team_id)
            self._require(Action.TEAM_MEMBERS_MANAGE, roles)
            current = await self._member_role(transaction, context, team_id, user_id)
            if current == role:
                return await self._load_member(transaction, context, team_id, user_id)
            if current == "owner" and role != "owner":
                await self._require_another_owner(transaction, context, team_id)
            await transaction.execute(
                """
                UPDATE app.team_memberships SET role = %s::app.team_role
                WHERE organization_id = %s AND team_id = %s AND user_id = %s
                """,
                (role, context.organization_id, team_id, user_id),
            )
            member = await self._load_member(transaction, context, team_id, user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "team.membership.updated",
                "team_membership",
                user_id,
                None,
                {"team_id": str(team_id), "previous_role": current, "role": role},
            )
            return member

        return await self._run(context, operation)

    async def remove_member(
        self,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_team(transaction, context, team_id)
            roles = await self._team_roles(transaction, context, team_id)
            self._require(Action.TEAM_MEMBERS_MANAGE, roles)
            current = await self._member_role(transaction, context, team_id, user_id)
            if current == "owner":
                await self._require_another_owner(transaction, context, team_id)
            await transaction.execute(
                """
                DELETE FROM app.team_memberships
                WHERE organization_id = %s AND team_id = %s AND user_id = %s
                """,
                (context.organization_id, team_id, user_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "team.membership.revoked",
                "team_membership",
                user_id,
                None,
                {"team_id": str(team_id), "previous_role": current},
            )

        await self._run(context, operation)

    async def list_project_grants(
        self, context: TenantContext, project_id: UUID
    ) -> list[ProjectTeamGrant]:
        async def operation(transaction: TenantTransaction) -> list[ProjectTeamGrant]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_TEAMS_READ, roles)
            rows = await transaction.fetch_all(
                """
                SELECT grant_record.id, grant_record.project_id, grant_record.team_id,
                       team.name, grant_record.role::text,
                       grant_record.created_at, grant_record.updated_at
                FROM app.project_team_grants grant_record
                JOIN app.teams team
                  ON team.organization_id = grant_record.organization_id
                 AND team.id = grant_record.team_id
                WHERE grant_record.organization_id = %s AND grant_record.project_id = %s
                ORDER BY lower(team.name), team.id
                """,
                (context.organization_id, project_id),
            )
            return [self._grant(row) for row in rows]

        return await self._run(context, operation)

    async def create_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> ProjectTeamGrant:
        async def operation(transaction: TenantTransaction) -> ProjectTeamGrant:
            await self._lock_project(transaction, context, project_id)
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_TEAMS_MANAGE, roles)
            await self._require_active_team(transaction, context, team_id)
            row = await transaction.fetch_one(
                """
                INSERT INTO app.project_team_grants
                  (organization_id, project_id, team_id, role, created_by)
                VALUES (%s, %s, %s, %s::app.project_role, %s)
                ON CONFLICT (organization_id, project_id, team_id) DO NOTHING
                RETURNING id
                """,
                (context.organization_id, project_id, team_id, role, context.user_id),
            )
            if row is None:
                raise TeamConflict("project_team_grant_exists")
            grant = await self._load_grant(transaction, context, project_id, team_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.team_grant.created",
                "project_team_grant",
                grant.grant_id,
                project_id,
                {"team_id": str(team_id), "role": role},
            )
            return grant

        return await self._run(context, operation)

    async def update_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> ProjectTeamGrant:
        async def operation(transaction: TenantTransaction) -> ProjectTeamGrant:
            await self._lock_project(transaction, context, project_id)
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_TEAMS_MANAGE, roles)
            current = await self._load_grant(transaction, context, project_id, team_id)
            if current.role == role:
                return current
            await transaction.execute(
                """
                UPDATE app.project_team_grants SET role = %s::app.project_role
                WHERE organization_id = %s AND project_id = %s AND team_id = %s
                """,
                (role, context.organization_id, project_id, team_id),
            )
            grant = await self._load_grant(transaction, context, project_id, team_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.team_grant.updated",
                "project_team_grant",
                grant.grant_id,
                project_id,
                {"team_id": str(team_id), "previous_role": current.role, "role": role},
            )
            return grant

        return await self._run(context, operation)

    async def remove_project_grant(
        self,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_project(transaction, context, project_id)
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_TEAMS_MANAGE, roles)
            current = await self._load_grant(transaction, context, project_id, team_id)
            await transaction.execute(
                """
                DELETE FROM app.project_team_grants
                WHERE organization_id = %s AND project_id = %s AND team_id = %s
                """,
                (context.organization_id, project_id, team_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.team_grant.revoked",
                "project_team_grant",
                current.grant_id,
                project_id,
                {"team_id": str(team_id), "previous_role": current.role},
            )

        await self._run(context, operation)

    async def _organization_role(
        self, transaction: TenantTransaction, context: TenantContext
    ) -> OrganizationRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if row is None:
            raise TeamAccessDenied("organization membership required")
        return cast(OrganizationRole, str(row[0]))

    async def _team_roles(
        self, transaction: TenantTransaction, context: TenantContext, team_id: UUID
    ) -> Roles:
        organization_role = await self._organization_role(transaction, context)
        row = await transaction.fetch_one(
            """
            SELECT membership.role::text
            FROM app.teams team
            LEFT JOIN app.team_memberships membership
              ON membership.organization_id = team.organization_id
             AND membership.team_id = team.id
             AND membership.user_id = %s
            WHERE team.organization_id = %s AND team.id = %s AND team.status = 'active'
            """,
            (context.user_id, context.organization_id, team_id),
        )
        if row is None:
            raise TeamNotFound("team")
        return Roles(organization_role, team=self._team_role(row[0]))

    async def _project_roles(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization_role = await self._organization_role(transaction, context)
        row = await transaction.fetch_one(
            """
            SELECT app.effective_project_role(project.id, %s)::text
            FROM app.projects project
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if row is None:
            raise TeamNotFound("project")
        return Roles(organization_role, self._project_role(row[0]))

    @staticmethod
    async def _require_organization_member(
        transaction: TenantTransaction, context: TenantContext, user_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT 1 FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, user_id),
        )
        if row is None:
            raise TeamNotFound("organization_member")

    @staticmethod
    async def _require_active_team(
        transaction: TenantTransaction, context: TenantContext, team_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            "SELECT 1 FROM app.teams WHERE organization_id = %s AND id = %s AND status = 'active'",
            (context.organization_id, team_id),
        )
        if row is None:
            raise TeamNotFound("team")

    @staticmethod
    async def _lock_team(
        transaction: TenantTransaction, context: TenantContext, team_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            "SELECT id FROM app.teams WHERE organization_id = %s AND id = %s FOR UPDATE",
            (context.organization_id, team_id),
        )
        if row is None:
            raise TeamNotFound("team")

    @staticmethod
    async def _lock_project(
        transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            "SELECT id FROM app.projects WHERE organization_id = %s AND id = %s FOR UPDATE",
            (context.organization_id, project_id),
        )
        if row is None:
            raise TeamNotFound("project")

    async def _member_role(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
    ) -> TeamRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.team_memberships
            WHERE organization_id = %s AND team_id = %s AND user_id = %s
            FOR UPDATE
            """,
            (context.organization_id, team_id, user_id),
        )
        if row is None:
            raise TeamNotFound("team_member")
        role = self._team_role(row[0])
        if role is None:
            raise TeamStoreUnavailable("invalid team role")
        return role

    async def _load_member(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        team_id: UUID,
        user_id: UUID,
    ) -> TeamMember:
        row = await transaction.fetch_one(
            """
            SELECT identity.id, identity.email, identity.display_name,
                   membership.role::text, membership.created_at, membership.updated_at
            FROM app.team_memberships membership
            JOIN app.users identity ON identity.id = membership.user_id
            WHERE membership.organization_id = %s
              AND membership.team_id = %s AND membership.user_id = %s
            """,
            (context.organization_id, team_id, user_id),
        )
        if row is None:
            raise TeamNotFound("team_member")
        return self._member(row)

    async def _load_grant(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        team_id: UUID,
    ) -> ProjectTeamGrant:
        row = await transaction.fetch_one(
            """
            SELECT grant_record.id, grant_record.project_id, grant_record.team_id,
                   team.name, grant_record.role::text,
                   grant_record.created_at, grant_record.updated_at
            FROM app.project_team_grants grant_record
            JOIN app.teams team
              ON team.organization_id = grant_record.organization_id
             AND team.id = grant_record.team_id
            WHERE grant_record.organization_id = %s
              AND grant_record.project_id = %s AND grant_record.team_id = %s
            """,
            (context.organization_id, project_id, team_id),
        )
        if row is None:
            raise TeamNotFound("project_team_grant")
        return self._grant(row)

    @staticmethod
    async def _require_another_owner(
        transaction: TenantTransaction, context: TenantContext, team_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT count(*) FROM app.team_memberships
            WHERE organization_id = %s AND team_id = %s AND role = 'owner'
            """,
            (context.organization_id, team_id),
        )
        if row is None or int(row[0]) <= 1:
            raise TeamConflict("last_team_owner")

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        project_id: UUID | None,
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
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise TeamAccessDenied(action) from error

    @staticmethod
    def _team(row: tuple[Any, ...]) -> Team:
        return Team(
            team_id=UUID(str(row[0])),
            name=str(row[1]),
            description=str(row[2]) if row[2] is not None else None,
            status=cast(RecordStatus, str(row[3])),
            caller_role=PostgresTeamRepository._team_role(row[4]),
            created_at=cast(datetime, row[5]),
            updated_at=cast(datetime, row[6]),
        )

    @classmethod
    def _team_required(cls, row: tuple[Any, ...] | None) -> Team:
        if row is None:
            raise TeamStoreUnavailable("team mutation returned no row")
        return cls._team(row)

    @staticmethod
    def _member(row: tuple[Any, ...]) -> TeamMember:
        role = PostgresTeamRepository._team_role(row[3])
        if role is None:
            raise TeamStoreUnavailable("invalid team member role")
        return TeamMember(
            user_id=UUID(str(row[0])),
            email=str(row[1]),
            display_name=str(row[2]),
            role=role,
            created_at=cast(datetime, row[4]),
            updated_at=cast(datetime, row[5]),
        )

    @staticmethod
    def _grant(row: tuple[Any, ...]) -> ProjectTeamGrant:
        role = PostgresTeamRepository._project_role(row[4])
        if role is None:
            raise TeamStoreUnavailable("invalid project team role")
        return ProjectTeamGrant(
            grant_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            team_id=UUID(str(row[2])),
            team_name=str(row[3]),
            role=role,
            created_at=cast(datetime, row[5]),
            updated_at=cast(datetime, row[6]),
        )

    @staticmethod
    def _team_role(value: Any) -> TeamRole | None:
        if value is None:
            return None
        role = str(value)
        if role not in {"owner", "manager", "member"}:
            raise TeamStoreUnavailable("invalid team role")
        return cast(TeamRole, role)

    @staticmethod
    def _project_role(value: Any) -> ProjectRole | None:
        if value is None:
            return None
        role = str(value)
        if role not in {"owner", "editor", "reviewer", "viewer"}:
            raise TeamStoreUnavailable("invalid project role")
        return cast(ProjectRole, role)
