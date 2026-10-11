from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize
from opengeo_api.cognito_provisioning import IdentityProvisioner, ProvisionedIdentity
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
    UserContext,
    UserQueryExecutor,
)

ProjectRole = Literal["owner", "editor", "reviewer", "viewer"]
InvitationStatus = Literal["pending", "accepted", "expired", "revoked"]


class MembershipStoreUnavailable(RuntimeError):
    pass


class MembershipAccessDenied(RuntimeError):
    pass


class MembershipNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class MembershipConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class InvitationDraft:
    email: str
    display_name: str
    organization_role: OrganizationRole
    project_id: UUID | None
    project_role: ProjectRole | None
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class MembershipInvitation:
    invitation_id: UUID
    email: str
    display_name: str
    organization_role: OrganizationRole
    project_id: UUID | None
    project_role: ProjectRole | None
    status: InvitationStatus
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class MembershipAcceptance:
    invitation_id: UUID
    organization_id: UUID
    project_id: UUID | None
    organization_role: OrganizationRole
    project_role: ProjectRole | None
    accepted_at: datetime


@dataclass(frozen=True, slots=True)
class PendingMembershipInvitation:
    invitation_id: UUID
    organization_id: UUID
    organization_name: str
    project_id: UUID | None
    project_name: str | None
    organization_role: OrganizationRole
    project_role: ProjectRole | None
    expires_at: datetime
    created_at: datetime


class MembershipRepository(Protocol):
    async def list_pending_invitations(
        self, user_id: UUID
    ) -> list[PendingMembershipInvitation]: ...

    async def list_invitations(
        self, context: TenantContext, limit: int, offset: int
    ) -> list[MembershipInvitation]: ...

    async def create_invitation(
        self, context: TenantContext, draft: InvitationDraft, request_id: str
    ) -> MembershipInvitation: ...

    async def revoke_invitation(
        self, context: TenantContext, invitation_id: UUID, request_id: str
    ) -> MembershipInvitation: ...

    async def accept_invitation(
        self, user_id: UUID, invitation_id: UUID, request_id: str
    ) -> MembershipAcceptance: ...

    async def update_organization_member(
        self,
        context: TenantContext,
        user_id: UUID,
        role: OrganizationRole,
        request_id: str,
    ) -> None: ...

    async def revoke_organization_member(
        self, context: TenantContext, user_id: UUID, request_id: str
    ) -> None: ...

    async def create_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> None: ...

    async def update_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> None: ...

    async def revoke_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None: ...


ResultT = TypeVar("ResultT")


class PostgresMembershipRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        user_executor: UserQueryExecutor,
        identity_provisioner: IdentityProvisioner,
    ) -> None:
        self._executor = executor
        self._user_executor = user_executor
        self._identity_provisioner = identity_provisioner

    async def list_pending_invitations(self, user_id: UUID) -> list[PendingMembershipInvitation]:
        try:
            rows = await self._user_executor.fetch_all(
                UserContext(user_id),
                "SELECT * FROM app.list_pending_membership_invitations()",
            )
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("invitation discovery failed") from error
        return [self._pending_invitation(row) for row in rows]

    async def list_invitations(
        self, context: TenantContext, limit: int, offset: int
    ) -> list[MembershipInvitation]:
        async def operation(transaction: TenantTransaction) -> list[MembershipInvitation]:
            role = await self._organization_role(transaction, context)
            self._require(Action.MEMBERSHIP_INVITATIONS_MANAGE, Roles(role))
            rows = await transaction.fetch_all(
                f"""{self._invitation_select()}
                WHERE invitation.organization_id = %s
                ORDER BY invitation.created_at DESC, invitation.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, limit, offset),
            )
            return [self._invitation(row) for row in rows]

        return await self._run(context, operation)

    async def create_invitation(
        self, context: TenantContext, draft: InvitationDraft, request_id: str
    ) -> MembershipInvitation:
        async def authorize_operation(transaction: TenantTransaction) -> None:
            role = await self._organization_role(transaction, context)
            self._require(Action.MEMBERSHIP_INVITATIONS_MANAGE, Roles(role))
            if draft.project_id is not None:
                await self._require_project(transaction, context, draft.project_id)

        await self._run(context, authorize_operation)
        identity = await self._identity_provisioner.ensure_user(draft.email, draft.display_name)

        async def create_operation(transaction: TenantTransaction) -> MembershipInvitation:
            role = await self._organization_role(transaction, context)
            self._require(Action.MEMBERSHIP_INVITATIONS_MANAGE, Roles(role))
            if draft.project_id is not None:
                await self._require_project(transaction, context, draft.project_id)
            user_id = await self._provision_user(transaction, identity)
            existing_membership = await transaction.fetch_one(
                """
                SELECT role::text
                FROM app.organization_memberships
                WHERE organization_id = %s AND user_id = %s
                """,
                (context.organization_id, user_id),
            )
            if existing_membership is not None:
                raise MembershipConflict("organization_membership_exists")

            pending = await transaction.fetch_one(
                """
                SELECT id, expires_at
                FROM app.membership_invitations
                WHERE organization_id = %s AND invitee_user_id = %s
                  AND project_id IS NOT DISTINCT FROM %s AND state = 'pending'
                FOR UPDATE
                """,
                (context.organization_id, user_id, draft.project_id),
            )
            if pending is not None:
                if cast(datetime, pending[1]) > datetime.now(UTC):
                    raise MembershipConflict("invitation_pending")
                await transaction.execute(
                    """
                    UPDATE app.membership_invitations
                    SET state = 'revoked', revoked_at = clock_timestamp()
                    WHERE organization_id = %s AND id = %s AND state = 'pending'
                    """,
                    (context.organization_id, pending[0]),
                )
                await self._record_event(
                    transaction,
                    context,
                    request_id,
                    "membership.invitation.revoked",
                    "membership_invitation",
                    UUID(str(pending[0])),
                    draft.project_id,
                    {"reason": "expired_superseded"},
                )

            invitation_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.membership_invitations
                  (id, organization_id, invitee_user_id, email, organization_role,
                   project_id, project_role, invited_by, expires_at)
                VALUES (
                  %s, %s, %s, %s, %s::app.organization_role,
                  %s, %s::app.project_role, %s, %s
                )
                RETURNING id, email, %s::text, organization_role::text, project_id,
                          project_role::text, 'pending'::text, expires_at, accepted_at,
                          revoked_at, created_at
                """,
                (
                    invitation_id,
                    context.organization_id,
                    user_id,
                    identity.email,
                    draft.organization_role,
                    draft.project_id,
                    draft.project_role,
                    context.user_id,
                    draft.expires_at,
                    identity.display_name,
                ),
            )
            invitation = self._invitation_required(row)
            await self._record_event(
                transaction,
                context,
                request_id,
                "membership.invitation.created",
                "membership_invitation",
                invitation_id,
                draft.project_id,
                {
                    "email": identity.email,
                    "organization_role": draft.organization_role,
                    "project_role": draft.project_role,
                    "expires_at": draft.expires_at.isoformat(),
                },
            )
            return invitation

        return await self._run(context, create_operation)

    async def revoke_invitation(
        self, context: TenantContext, invitation_id: UUID, request_id: str
    ) -> MembershipInvitation:
        async def operation(transaction: TenantTransaction) -> MembershipInvitation:
            role = await self._organization_role(transaction, context)
            self._require(Action.MEMBERSHIP_INVITATIONS_MANAGE, Roles(role))
            state = await transaction.fetch_one(
                """
                SELECT state::text
                FROM app.membership_invitations
                WHERE organization_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, invitation_id),
            )
            if state is None:
                raise MembershipNotFound("invitation")
            if str(state[0]) != "pending":
                raise MembershipConflict(f"invitation_{state[0]}")
            row = await transaction.fetch_one(
                """
                UPDATE app.membership_invitations invitation
                SET state = 'revoked', revoked_at = clock_timestamp()
                WHERE invitation.organization_id = %s AND invitation.id = %s
                RETURNING invitation.id, invitation.email,
                          COALESCE((SELECT identity.display_name FROM app.users identity
                           WHERE identity.id = invitation.invitee_user_id), invitation.email),
                          invitation.organization_role::text, invitation.project_id,
                          invitation.project_role::text, 'revoked'::text,
                          invitation.expires_at, invitation.accepted_at,
                          invitation.revoked_at, invitation.created_at
                """,
                (context.organization_id, invitation_id),
            )
            invitation = self._invitation_required(row)
            await self._record_event(
                transaction,
                context,
                request_id,
                "membership.invitation.revoked",
                "membership_invitation",
                invitation_id,
                invitation.project_id,
                {"reason": "administrator_revoked"},
            )
            return invitation

        return await self._run(context, operation)

    async def accept_invitation(
        self, user_id: UUID, invitation_id: UUID, request_id: str
    ) -> MembershipAcceptance:
        try:
            row = await self._user_executor.fetch_one(
                UserContext(user_id),
                "SELECT * FROM app.accept_membership_invitation(%s, %s)",
                (invitation_id, request_id),
            )
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("invitation acceptance failed") from error
        if row is None:
            raise MembershipStoreUnavailable("invitation acceptance returned no result")
        code = str(row[0])
        if code == "not_found":
            raise MembershipNotFound("invitation")
        if code in {"already_accepted", "expired", "revoked"}:
            raise MembershipConflict(f"invitation_{code}")
        if code != "accepted":
            raise MembershipStoreUnavailable("invitation acceptance returned an invalid result")
        try:
            organization_role = self._organization_role_value(row[4])
            project_role = self._project_role_value(row[5])
            if row[6] is None:
                raise ValueError("accepted timestamp is missing")
            return MembershipAcceptance(
                invitation_id=UUID(str(row[1])),
                organization_id=UUID(str(row[2])),
                project_id=UUID(str(row[3])) if row[3] is not None else None,
                organization_role=organization_role,
                project_role=project_role,
                accepted_at=cast(datetime, row[6]),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise MembershipStoreUnavailable("invalid invitation acceptance row") from error

    async def update_organization_member(
        self,
        context: TenantContext,
        user_id: UUID,
        role: OrganizationRole,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_organization(transaction, context)
            actor_role = await self._organization_role(transaction, context)
            self._require(Action.ORGANIZATION_MEMBERS_MANAGE, Roles(actor_role))
            target = await self._organization_member_role(transaction, context, user_id)
            if target == role:
                return
            if target == "admin" and role != "admin":
                await self._require_another_admin(transaction, context)
            await transaction.execute(
                """
                UPDATE app.organization_memberships
                SET role = %s::app.organization_role
                WHERE organization_id = %s AND user_id = %s
                """,
                (role, context.organization_id, user_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "organization.membership.updated",
                "organization_membership",
                user_id,
                None,
                {"previous_role": target, "role": role},
            )

        await self._run(context, operation)

    async def revoke_organization_member(
        self, context: TenantContext, user_id: UUID, request_id: str
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_organization(transaction, context)
            actor_role = await self._organization_role(transaction, context)
            self._require(Action.ORGANIZATION_MEMBERS_MANAGE, Roles(actor_role))
            target = await self._organization_member_role(transaction, context, user_id)
            if target == "admin":
                await self._require_another_admin(transaction, context)
            sole_owner = await transaction.fetch_one(
                """
                SELECT owned.project_id
                FROM app.project_memberships owned
                WHERE owned.organization_id = %s
                  AND owned.user_id = %s
                  AND owned.role = 'owner'
                  AND NOT EXISTS (
                    SELECT 1 FROM app.project_memberships other_owner
                    WHERE other_owner.organization_id = owned.organization_id
                      AND other_owner.project_id = owned.project_id
                      AND other_owner.role = 'owner'
                      AND other_owner.user_id <> owned.user_id
                  )
                LIMIT 1
                """,
                (context.organization_id, user_id),
            )
            if sole_owner is not None:
                raise MembershipConflict("last_project_owner")
            await transaction.execute(
                "DELETE FROM app.client_memberships WHERE organization_id = %s AND user_id = %s",
                (context.organization_id, user_id),
            )
            await transaction.execute(
                "DELETE FROM app.project_memberships WHERE organization_id = %s AND user_id = %s",
                (context.organization_id, user_id),
            )
            await transaction.execute(
                """
                DELETE FROM app.organization_memberships
                WHERE organization_id = %s AND user_id = %s
                """,
                (context.organization_id, user_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "organization.membership.revoked",
                "organization_membership",
                user_id,
                None,
                {"previous_role": target},
            )

        await self._run(context, operation)

    async def create_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_project(transaction, context, project_id)
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.PROJECT_MEMBERS_MANAGE, roles)
            await self._organization_member_role(transaction, context, user_id)
            existing = await transaction.fetch_one(
                """
                SELECT role::text FROM app.project_memberships
                WHERE organization_id = %s AND project_id = %s AND user_id = %s
                """,
                (context.organization_id, project_id, user_id),
            )
            if existing is not None:
                raise MembershipConflict("project_membership_exists")
            await transaction.execute(
                """
                INSERT INTO app.project_memberships (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, %s::app.project_role)
                """,
                (context.organization_id, project_id, user_id, role),
            )
            await self._record_project_membership_event(
                transaction, context, request_id, "created", project_id, user_id, {"role": role}
            )

        await self._run(context, operation)

    async def update_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        role: ProjectRole,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_project(transaction, context, project_id)
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.PROJECT_MEMBERS_MANAGE, roles)
            target = await self._project_member_role(transaction, context, project_id, user_id)
            if target == role:
                return
            if target == "owner" and role != "owner":
                await self._require_another_owner(transaction, context, project_id)
            await transaction.execute(
                """
                UPDATE app.project_memberships SET role = %s::app.project_role
                WHERE organization_id = %s AND project_id = %s AND user_id = %s
                """,
                (role, context.organization_id, project_id, user_id),
            )
            await self._record_project_membership_event(
                transaction,
                context,
                request_id,
                "updated",
                project_id,
                user_id,
                {"previous_role": target, "role": role},
            )

        await self._run(context, operation)

    async def revoke_project_member(
        self,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            await self._lock_project(transaction, context, project_id)
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.PROJECT_MEMBERS_MANAGE, roles)
            target = await self._project_member_role(transaction, context, project_id, user_id)
            if target == "owner":
                await self._require_another_owner(transaction, context, project_id)
            await transaction.execute(
                """
                DELETE FROM app.project_memberships
                WHERE organization_id = %s AND project_id = %s AND user_id = %s
                """,
                (context.organization_id, project_id, user_id),
            )
            await self._record_project_membership_event(
                transaction,
                context,
                request_id,
                "revoked",
                project_id,
                user_id,
                {"previous_role": target},
            )

        await self._run(context, operation)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except MembershipAccessDenied:
            raise
        except MembershipNotFound:
            raise
        except MembershipConflict:
            raise
        except TenantDatabaseConflict as error:
            raise MembershipConflict("membership_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise MembershipStoreUnavailable("membership database unavailable") from error

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
            raise MembershipAccessDenied("organization membership no longer exists")
        return self._organization_role_value(row[0])

    async def _organization_member_role(
        self, transaction: TenantTransaction, context: TenantContext, user_id: UUID
    ) -> OrganizationRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            FOR UPDATE
            """,
            (context.organization_id, user_id),
        )
        if row is None:
            raise MembershipNotFound("organization_member")
        return self._organization_role_value(row[0])

    async def _roles_for_project(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Roles:
        organization_role = await self._organization_role(transaction, context)
        row = await transaction.fetch_one(
            """
            SELECT membership.role::text
            FROM app.projects project
            LEFT JOIN app.project_memberships membership
              ON membership.organization_id = project.organization_id
             AND membership.project_id = project.id
             AND membership.user_id = %s
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.user_id, context.organization_id, project_id),
        )
        if row is None:
            raise MembershipNotFound("project")
        return Roles(organization_role, self._project_role_value(row[0]))

    async def _project_member_role(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        user_id: UUID,
    ) -> ProjectRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.project_memberships
            WHERE organization_id = %s AND project_id = %s AND user_id = %s
            FOR UPDATE
            """,
            (context.organization_id, project_id, user_id),
        )
        if row is None:
            raise MembershipNotFound("project_member")
        role = self._project_role_value(row[0])
        if role is None:
            raise MembershipStoreUnavailable("invalid project membership role")
        return role

    async def _require_project(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            "SELECT id FROM app.projects WHERE organization_id = %s AND id = %s",
            (context.organization_id, project_id),
        )
        if row is None:
            raise MembershipNotFound("project")

    @staticmethod
    async def _lock_organization(transaction: TenantTransaction, context: TenantContext) -> None:
        row = await transaction.fetch_one(
            "SELECT id FROM app.organizations WHERE id = %s FOR UPDATE",
            (context.organization_id,),
        )
        if row is None:
            raise MembershipNotFound("organization")

    @staticmethod
    async def _lock_project(
        transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            "SELECT id FROM app.projects WHERE organization_id = %s AND id = %s FOR UPDATE",
            (context.organization_id, project_id),
        )
        if row is None:
            raise MembershipNotFound("project")

    @staticmethod
    async def _require_another_admin(
        transaction: TenantTransaction, context: TenantContext
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT count(*) FROM app.organization_memberships
            WHERE organization_id = %s AND role = 'admin'
            """,
            (context.organization_id,),
        )
        if row is None or int(row[0]) <= 1:
            raise MembershipConflict("last_organization_admin")

    @staticmethod
    async def _require_another_owner(
        transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT count(*) FROM app.project_memberships
            WHERE organization_id = %s AND project_id = %s AND role = 'owner'
            """,
            (context.organization_id, project_id),
        )
        if row is None or int(row[0]) <= 1:
            raise MembershipConflict("last_project_owner")

    @staticmethod
    async def _provision_user(
        transaction: TenantTransaction, identity: ProvisionedIdentity
    ) -> UUID:
        row = await transaction.fetch_one(
            "SELECT app.provision_invited_user(%s, %s, %s)",
            (identity.subject, identity.email, identity.display_name),
        )
        if row is None:
            raise MembershipStoreUnavailable("identity provisioning returned no user")
        try:
            return UUID(str(row[0]))
        except (TypeError, ValueError) as error:
            raise MembershipStoreUnavailable(
                "identity provisioning returned an invalid user"
            ) from error

    async def _record_project_membership_event(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        verb: str,
        project_id: UUID,
        user_id: UUID,
        payload: dict[str, Any],
    ) -> None:
        await self._record_event(
            transaction,
            context,
            request_id,
            f"project.membership.{verb}",
            "project_membership",
            user_id,
            project_id,
            payload,
        )

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
            raise MembershipAccessDenied(action) from error

    @staticmethod
    def _invitation_select() -> str:
        return """
        SELECT invitation.id, invitation.email,
               COALESCE(identity.display_name, invitation.email),
               invitation.organization_role::text, invitation.project_id,
               invitation.project_role::text,
               CASE
                 WHEN invitation.state = 'pending' AND invitation.expires_at <= clock_timestamp()
                   THEN 'expired'
                 ELSE invitation.state::text
               END,
               invitation.expires_at, invitation.accepted_at, invitation.revoked_at,
               invitation.created_at
        FROM app.membership_invitations invitation
        LEFT JOIN app.users identity ON identity.id = invitation.invitee_user_id
        """

    @classmethod
    def _invitation_required(cls, row: tuple[Any, ...] | None) -> MembershipInvitation:
        if row is None:
            raise MembershipStoreUnavailable("invitation write returned no row")
        return cls._invitation(row)

    @classmethod
    def _invitation(cls, row: tuple[Any, ...]) -> MembershipInvitation:
        try:
            status = str(row[6])
            if status not in {"pending", "accepted", "expired", "revoked"}:
                raise ValueError("invalid status")
            return MembershipInvitation(
                invitation_id=UUID(str(row[0])),
                email=str(row[1]),
                display_name=str(row[2]),
                organization_role=cls._organization_role_value(row[3]),
                project_id=UUID(str(row[4])) if row[4] is not None else None,
                project_role=cls._project_role_value(row[5]),
                status=cast(InvitationStatus, status),
                expires_at=cast(datetime, row[7]),
                accepted_at=cast(datetime | None, row[8]),
                revoked_at=cast(datetime | None, row[9]),
                created_at=cast(datetime, row[10]),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise MembershipStoreUnavailable("invalid invitation row") from error

    @classmethod
    def _pending_invitation(cls, row: tuple[Any, ...]) -> PendingMembershipInvitation:
        try:
            return PendingMembershipInvitation(
                invitation_id=UUID(str(row[0])),
                organization_id=UUID(str(row[1])),
                organization_name=str(row[2]),
                project_id=UUID(str(row[3])) if row[3] is not None else None,
                project_name=str(row[4]) if row[4] is not None else None,
                organization_role=cls._organization_role_value(row[5]),
                project_role=cls._project_role_value(row[6]),
                expires_at=cast(datetime, row[7]),
                created_at=cast(datetime, row[8]),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise MembershipStoreUnavailable("invalid pending invitation row") from error

    @staticmethod
    def _organization_role_value(value: Any) -> OrganizationRole:
        role = str(value)
        if role not in {"admin", "member", "guest"}:
            raise MembershipStoreUnavailable("invalid organization role")
        return cast(OrganizationRole, role)

    @staticmethod
    def _project_role_value(value: Any) -> ProjectRole | None:
        if value is None:
            return None
        role = str(value)
        if role not in {"owner", "editor", "reviewer", "viewer"}:
            raise MembershipStoreUnavailable("invalid project role")
        return cast(ProjectRole, role)
