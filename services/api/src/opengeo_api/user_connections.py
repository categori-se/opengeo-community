import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import Action, AuthorizationDenied, ProjectRole, Roles, authorize
from opengeo_api.connections import (
    ConnectionSecretStoreUnavailable,
    StoredConnectionSecret,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

logger = logging.getLogger(__name__)

DatasetConnectionProvider = Literal["s3"]
DatasetCredentialMode = Literal["workload_identity", "assume_role", "access_key"]
DatasetConnectionStatus = Literal["draft", "unverified", "verified", "error", "disabled"]
UserDatasetVerificationState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
DatasetConnectionHealth = Literal[
    "healthy",
    "checking",
    "needs_verification",
    "check_failed",
    "needs_credentials",
    "disabled",
]
ResultT = TypeVar("ResultT")


class UserConnectionStoreUnavailable(RuntimeError):
    pass


class UserConnectionAccessDenied(RuntimeError):
    pass


class UserConnectionNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class UserConnectionConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class UserDatasetConnection:
    connection_id: UUID
    owner_user_id: UUID
    provider: DatasetConnectionProvider
    display_name: str
    bucket_name: str
    region_name: str
    object_prefix: str
    credential_mode: DatasetCredentialMode
    role_arn: str | None
    configured_secret_fields: tuple[str, ...]
    credential_revision: int
    target_revision: int
    status: DatasetConnectionStatus
    last_verified_at: datetime | None
    sanitized_error_code: str | None
    created_at: datetime
    updated_at: datetime
    owned_by_caller: bool


@dataclass(frozen=True, slots=True)
class ProjectDatasetConnectionBinding:
    binding_id: UUID
    project_id: UUID
    display_name: str
    created_by: UUID
    created_at: datetime
    connection: UserDatasetConnection


@dataclass(frozen=True, slots=True)
class UserDatasetConnectionDraft:
    provider: DatasetConnectionProvider
    display_name: str
    bucket_name: str
    region_name: str
    object_prefix: str
    credential_mode: DatasetCredentialMode
    role_arn: str | None


@dataclass(frozen=True, slots=True, repr=False)
class UserDatasetCredentials:
    values: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class UserDatasetConnectionVerification:
    verification_id: UUID
    connection_id: UUID
    target_revision: int
    credential_revision: int
    state: UserDatasetVerificationState
    attempt_count: int
    bucket_access_confirmed: bool
    object_access_confirmed: bool
    deny_canaries_confirmed: bool
    objects_observed: int
    sanitized_error_code: str | None
    duration_ms: int | None
    requested_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class UserDatasetConnectionVerificationSubmission:
    verification: UserDatasetConnectionVerification
    created: bool


@dataclass(frozen=True, slots=True)
class UserDatasetConnectionProjectReference:
    binding_id: UUID
    project_id: UUID
    project_name: str
    project_status: Literal["active", "archived"]
    display_name: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class UserDatasetConnectionOverview:
    connection_id: UUID
    target_revision: int
    credential_revision: int
    health: DatasetConnectionHealth
    latest_verification: UserDatasetConnectionVerification | None
    project_references: tuple[UserDatasetConnectionProjectReference, ...]


class UserDatasetConnectionSecretStore(Protocol):
    async def create_user_dataset_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        credentials: Mapping[str, str],
    ) -> StoredConnectionSecret: ...

    async def discard(self, reference: str) -> None: ...


class UserDatasetConnectionRepository(Protocol):
    async def list_my_connections(
        self, context: TenantContext
    ) -> tuple[UserDatasetConnection, ...]: ...

    async def get_my_connection(
        self, context: TenantContext, connection_id: UUID
    ) -> UserDatasetConnection: ...

    async def create_connection(
        self,
        context: TenantContext,
        draft: UserDatasetConnectionDraft,
        request_id: str,
    ) -> UserDatasetConnection: ...

    async def update_connection(
        self,
        context: TenantContext,
        connection_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> UserDatasetConnection: ...

    async def rotate_credentials(
        self,
        context: TenantContext,
        connection_id: UUID,
        expected_revision: int,
        credentials: UserDatasetCredentials,
        request_id: str,
    ) -> UserDatasetConnection: ...

    async def request_verification(
        self,
        context: TenantContext,
        connection_id: UUID,
        request_id: str,
    ) -> UserDatasetConnectionVerificationSubmission: ...

    async def list_verifications(
        self, context: TenantContext, connection_id: UUID
    ) -> tuple[UserDatasetConnectionVerification, ...]: ...

    async def get_my_connection_overview(
        self, context: TenantContext, connection_id: UUID
    ) -> UserDatasetConnectionOverview: ...

    async def list_project_bindings(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ProjectDatasetConnectionBinding, ...]: ...

    async def create_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        display_name: str,
        request_id: str,
    ) -> ProjectDatasetConnectionBinding: ...

    async def remove_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> None: ...


class PostgresUserDatasetConnectionRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        secret_store: UserDatasetConnectionSecretStore,
    ) -> None:
        self._executor = executor
        self._secret_store = secret_store

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except (UserConnectionAccessDenied, UserConnectionNotFound, UserConnectionConflict):
            raise
        except TenantDatabaseConflict as error:
            raise UserConnectionConflict("user_connection_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise UserConnectionStoreUnavailable("connection database unavailable") from error

    async def list_my_connections(
        self, context: TenantContext
    ) -> tuple[UserDatasetConnection, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[UserDatasetConnection, ...]:
            await self._organization_role(transaction, context)
            rows = await transaction.fetch_all(
                f"""{self._connection_select()}
                WHERE connection.organization_id = %s
                  AND connection.owner_user_id = %s
                ORDER BY lower(connection.display_name), connection.id
                """,
                (context.organization_id, context.user_id),
            )
            return tuple(self._connection(row, context.user_id) for row in rows)

        return await self._run(context, operation)

    async def get_my_connection(
        self, context: TenantContext, connection_id: UUID
    ) -> UserDatasetConnection:
        async def operation(transaction: TenantTransaction) -> UserDatasetConnection:
            await self._organization_role(transaction, context)
            return await self._load_owned_connection(transaction, context, connection_id)

        return await self._run(context, operation)

    async def create_connection(
        self,
        context: TenantContext,
        draft: UserDatasetConnectionDraft,
        request_id: str,
    ) -> UserDatasetConnection:
        async def operation(transaction: TenantTransaction) -> UserDatasetConnection:
            await self._organization_role(transaction, context)
            connection_id = uuid4()
            status_value = "draft" if draft.credential_mode == "access_key" else "unverified"
            row = await transaction.fetch_one(
                f"""
                INSERT INTO app.user_dataset_connections
                  (id, organization_id, owner_user_id, provider, display_name,
                   bucket_name, region_name, object_prefix, credential_mode,
                   role_arn, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {self._connection_returning()}
                """,
                (
                    connection_id,
                    context.organization_id,
                    context.user_id,
                    draft.provider,
                    draft.display_name,
                    draft.bucket_name,
                    draft.region_name,
                    draft.object_prefix,
                    draft.credential_mode,
                    draft.role_arn,
                    status_value,
                ),
            )
            connection = self._connection_required(row, context.user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_dataset_connection.created",
                connection.connection_id,
                None,
                {"provider": connection.provider, "credential_mode": connection.credential_mode},
            )
            return connection

        return await self._run(context, operation)

    async def update_connection(
        self,
        context: TenantContext,
        connection_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> UserDatasetConnection:
        async def operation(transaction: TenantTransaction) -> UserDatasetConnection:
            await self._organization_role(transaction, context)
            current = await self._load_owned_connection(transaction, context, connection_id)
            assignments: list[str] = []
            values: list[Any] = []
            columns = {
                "display_name": "display_name",
                "bucket_name": "bucket_name",
                "region_name": "region_name",
                "object_prefix": "object_prefix",
                "role_arn": "role_arn",
            }
            for field, value in changes.items():
                if field == "enabled":
                    continue
                column = columns.get(field)
                if column is None:
                    raise UserConnectionConflict("unsupported_connection_update")
                if field == "role_arn" and current.credential_mode != "assume_role":
                    raise UserConnectionConflict("role_arn_requires_assume_role")
                assignments.append(f"{column} = %s")
                values.append(value)
            configuration_changed = any(field != "enabled" for field in changes)
            if configuration_changed and "enabled" not in changes:
                assignments.extend(
                    [
                        "status = CASE WHEN credential_mode = 'access_key' "
                        "AND credential_revision = 0 THEN 'draft' "
                        "ELSE 'unverified' END",
                        "last_verified_at = NULL",
                        "sanitized_error_code = NULL",
                    ]
                )
            if "enabled" in changes:
                assignments.extend(
                    [
                        "status = CASE WHEN %s::boolean = false THEN 'disabled' "
                        "WHEN credential_mode = 'access_key' AND credential_revision = 0 "
                        "THEN 'draft' ELSE 'unverified' END",
                        "last_verified_at = NULL",
                        "sanitized_error_code = NULL",
                    ]
                )
                values.append(bool(changes["enabled"]))
            if not assignments:
                raise UserConnectionConflict("empty_connection_update")
            row = await transaction.fetch_one(
                f"""
                UPDATE app.user_dataset_connections
                SET {", ".join(assignments)}
                WHERE organization_id = %s AND owner_user_id = %s AND id = %s
                RETURNING {self._connection_returning()}
                """,
                (*values, context.organization_id, context.user_id, connection_id),
            )
            connection = self._connection_required(row, context.user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_dataset_connection.updated",
                connection.connection_id,
                None,
                {"changed_fields": sorted(changes)},
            )
            return connection

        return await self._run(context, operation)

    async def rotate_credentials(
        self,
        context: TenantContext,
        connection_id: UUID,
        expected_revision: int,
        credentials: UserDatasetCredentials,
        request_id: str,
    ) -> UserDatasetConnection:
        async def prepare(
            transaction: TenantTransaction,
        ) -> tuple[DatasetCredentialMode, str | None, int]:
            await self._organization_role(transaction, context)
            row = await transaction.fetch_one(
                "SELECT * FROM app.prepare_user_dataset_connection_credential_rotation(%s)",
                (connection_id,),
            )
            if row is None:
                raise UserConnectionNotFound("user_connection")
            mode = self._credential_mode(row[0])
            revision = int(row[2])
            if revision != expected_revision:
                raise UserConnectionConflict("stale_credential_revision")
            self._validate_credentials(mode, credentials.values)
            return mode, str(row[1]) if row[1] is not None else None, revision

        _mode, previous_reference, revision = await self._run(context, prepare)
        credential_version_id = uuid4()
        try:
            stored = await self._secret_store.create_user_dataset_connection(
                context.organization_id,
                context.user_id,
                connection_id,
                credential_version_id,
                credentials.values,
            )
        except ConnectionSecretStoreUnavailable as error:
            raise UserConnectionStoreUnavailable("connection secret storage failed") from error

        async def commit(transaction: TenantTransaction) -> UserDatasetConnection:
            await self._organization_role(transaction, context)
            row = await transaction.fetch_one(
                """
                SELECT app.commit_user_dataset_connection_credential_rotation(
                  %s, %s, %s, %s
                )
                """,
                (connection_id, revision, stored.reference, list(stored.configured_fields)),
            )
            if row is None or not bool(row[0]):
                raise UserConnectionConflict("stale_credential_revision")
            connection = await self._load_owned_connection(transaction, context, connection_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_dataset_connection.credentials_replaced",
                connection_id,
                None,
                {
                    "credential_revision": connection.credential_revision,
                    "configured_secret_fields": list(connection.configured_secret_fields),
                },
            )
            return connection

        try:
            connection = await self._run(context, commit)
        except Exception:
            await self._discard_without_masking(stored.reference)
            raise
        if previous_reference is not None:
            await self._discard_without_masking(previous_reference)
        return connection

    async def request_verification(
        self,
        context: TenantContext,
        connection_id: UUID,
        request_id: str,
    ) -> UserDatasetConnectionVerificationSubmission:
        async def operation(
            transaction: TenantTransaction,
        ) -> UserDatasetConnectionVerificationSubmission:
            await self._organization_role(transaction, context)
            await self._load_owned_connection(transaction, context, connection_id)
            queued = await transaction.fetch_one(
                """
                SELECT verification_id, created
                FROM app.request_user_dataset_connection_verification(%s, %s, %s)
                """,
                (connection_id, context.user_id, request_id),
            )
            if queued is None:
                raise UserConnectionStoreUnavailable(
                    "dataset verification request returned no result"
                )
            verification = await self._load_verification(
                transaction, context, connection_id, cast(UUID, queued[0])
            )
            return UserDatasetConnectionVerificationSubmission(verification, cast(bool, queued[1]))

        return await self._run(context, operation)

    async def list_verifications(
        self, context: TenantContext, connection_id: UUID
    ) -> tuple[UserDatasetConnectionVerification, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[UserDatasetConnectionVerification, ...]:
            await self._organization_role(transaction, context)
            await self._load_owned_connection(transaction, context, connection_id)
            rows = await transaction.fetch_all(
                f"""{self._verification_select()}
                WHERE verification.organization_id = %s
                  AND verification.owner_user_id = %s
                  AND verification.connection_id = %s
                ORDER BY verification.created_at DESC, verification.id DESC
                LIMIT 50
                """,
                (context.organization_id, context.user_id, connection_id),
            )
            return tuple(self._verification(row) for row in rows)

        return await self._run(context, operation)

    async def get_my_connection_overview(
        self, context: TenantContext, connection_id: UUID
    ) -> UserDatasetConnectionOverview:
        async def operation(transaction: TenantTransaction) -> UserDatasetConnectionOverview:
            await self._organization_role(transaction, context)
            connection = await self._load_owned_connection(transaction, context, connection_id)
            verification_row = await transaction.fetch_one(
                f"""{self._verification_select()}
                WHERE verification.organization_id = %s
                  AND verification.owner_user_id = %s
                  AND verification.connection_id = %s
                ORDER BY verification.created_at DESC, verification.id DESC
                LIMIT 1
                """,
                (context.organization_id, context.user_id, connection_id),
            )
            latest = self._verification(verification_row) if verification_row is not None else None
            binding_rows = await transaction.fetch_all(
                """
                SELECT binding.id, binding.project_id, project.name,
                       project.status::text, binding.display_name, binding.created_at
                FROM app.project_dataset_connection_bindings binding
                JOIN app.projects project
                  ON project.organization_id = binding.organization_id
                 AND project.id = binding.project_id
                WHERE binding.organization_id = %s
                  AND binding.connection_id = %s
                ORDER BY lower(project.name), project.id
                LIMIT 250
                """,
                (context.organization_id, connection_id),
            )
            references = tuple(self._project_reference(row) for row in binding_rows)
            return UserDatasetConnectionOverview(
                connection_id=connection.connection_id,
                target_revision=connection.target_revision,
                credential_revision=connection.credential_revision,
                health=self._connection_health(connection, latest),
                latest_verification=latest,
                project_references=references,
            )

        return await self._run(context, operation)

    async def list_project_bindings(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ProjectDatasetConnectionBinding, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ProjectDatasetConnectionBinding, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            rows = await transaction.fetch_all(
                f"""
                SELECT binding.id, binding.project_id, binding.display_name,
                       binding.created_by, binding.created_at,
                       {self._connection_columns("connection")}
                FROM app.project_dataset_connection_bindings binding
                JOIN app.user_dataset_connections connection
                  ON connection.organization_id = binding.organization_id
                 AND connection.id = binding.connection_id
                WHERE binding.organization_id = %s AND binding.project_id = %s
                ORDER BY lower(binding.display_name), binding.id
                """,
                (context.organization_id, project_id),
            )
            return tuple(self._binding(row, context.user_id) for row in rows)

        return await self._run(context, operation)

    async def create_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        display_name: str,
        request_id: str,
    ) -> ProjectDatasetConnectionBinding:
        async def operation(transaction: TenantTransaction) -> ProjectDatasetConnectionBinding:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)
            connection = await self._load_owned_connection(transaction, context, connection_id)
            if connection.status == "disabled":
                raise UserConnectionConflict("connection_disabled")
            binding_id = uuid4()
            await transaction.execute(
                """
                INSERT INTO app.project_dataset_connection_bindings
                  (id, organization_id, project_id, connection_id, display_name, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    binding_id,
                    context.organization_id,
                    project_id,
                    connection_id,
                    display_name,
                    context.user_id,
                ),
            )
            binding = await self._load_binding(transaction, context, project_id, binding_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.dataset_connection.bound",
                binding_id,
                project_id,
                {"connection_id": str(connection_id)},
            )
            return binding

        return await self._run(context, operation)

    async def remove_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> None:
        async def operation(transaction: TenantTransaction) -> None:
            roles = await self._project_roles(transaction, context, project_id)
            binding = await self._load_binding(transaction, context, project_id, binding_id)
            if not binding.connection.owned_by_caller:
                self._require(Action.CONNECTION_MANAGE, roles)
            await transaction.execute(
                """
                DELETE FROM app.project_dataset_connection_bindings
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, binding_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.dataset_connection.unbound",
                binding_id,
                project_id,
                {"connection_id": str(binding.connection.connection_id)},
            )

        await self._run(context, operation)

    async def _load_owned_connection(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        connection_id: UUID,
    ) -> UserDatasetConnection:
        row = await transaction.fetch_one(
            f"""{self._connection_select()}
            WHERE connection.organization_id = %s
              AND connection.owner_user_id = %s AND connection.id = %s
            """,
            (context.organization_id, context.user_id, connection_id),
        )
        if row is None:
            raise UserConnectionNotFound("user_connection")
        return self._connection(row, context.user_id)

    async def _load_binding(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
    ) -> ProjectDatasetConnectionBinding:
        row = await transaction.fetch_one(
            f"""
            SELECT binding.id, binding.project_id, binding.display_name,
                   binding.created_by, binding.created_at,
                   {self._connection_columns("connection")}
            FROM app.project_dataset_connection_bindings binding
            JOIN app.user_dataset_connections connection
              ON connection.organization_id = binding.organization_id
             AND connection.id = binding.connection_id
            WHERE binding.organization_id = %s
              AND binding.project_id = %s AND binding.id = %s
            """,
            (context.organization_id, project_id, binding_id),
        )
        if row is None:
            raise UserConnectionNotFound("project_connection_binding")
        return self._binding(row, context.user_id)

    async def _load_verification(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        connection_id: UUID,
        verification_id: UUID,
    ) -> UserDatasetConnectionVerification:
        row = await transaction.fetch_one(
            f"""{self._verification_select()}
            WHERE verification.organization_id = %s
              AND verification.owner_user_id = %s
              AND verification.connection_id = %s
              AND verification.id = %s
            """,
            (
                context.organization_id,
                context.user_id,
                connection_id,
                verification_id,
            ),
        )
        if row is None:
            raise UserConnectionNotFound("user_connection_verification")
        return self._verification(row)

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
            raise UserConnectionNotFound("project")
        return Roles(organization_role, self._project_role(row[0]))

    @staticmethod
    async def _organization_role(
        transaction: TenantTransaction, context: TenantContext
    ) -> OrganizationRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if row is None:
            raise UserConnectionAccessDenied("organization membership required")
        return cast(OrganizationRole, str(row[0]))

    async def _discard_without_masking(self, reference: str) -> None:
        try:
            await asyncio.shield(self._secret_store.discard(reference))
        except ConnectionSecretStoreUnavailable:
            logger.error("user_connection.secret_cleanup_failed")

    @staticmethod
    def _validate_credentials(mode: DatasetCredentialMode, credentials: Mapping[str, str]) -> None:
        fields = tuple(sorted(credentials))
        if mode == "assume_role" and fields != ("external_id",):
            raise UserConnectionConflict("assume_role_external_id_required")
        if mode == "access_key" and fields not in {
            ("access_key_id", "secret_access_key"),
            ("access_key_id", "secret_access_key", "session_token"),
        }:
            raise UserConnectionConflict("access_key_fields_invalid")
        if mode == "workload_identity":
            raise UserConnectionConflict("workload_identity_has_no_user_secret")

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise UserConnectionAccessDenied(action) from error

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        event_type: str,
        resource_id: UUID,
        project_id: UUID | None,
        payload: Mapping[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type, resource_type,
               resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'dataset_connection', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_id,
                request_id,
                Jsonb(dict(payload)),
            ),
        )

    @staticmethod
    def _connection_columns(alias: str) -> str:
        return f"""
        {alias}.id, {alias}.owner_user_id, {alias}.provider::text,
        {alias}.display_name, {alias}.bucket_name, {alias}.region_name,
        {alias}.object_prefix, {alias}.credential_mode::text, {alias}.role_arn,
        {alias}.configured_secret_fields, {alias}.credential_revision,
        {alias}.target_revision, {alias}.status::text, {alias}.last_verified_at,
        {alias}.sanitized_error_code, {alias}.created_at, {alias}.updated_at
        """

    @classmethod
    def _connection_select(cls) -> str:
        return (
            f"SELECT {cls._connection_columns('connection')} "
            "FROM app.user_dataset_connections connection"
        )

    @staticmethod
    def _connection_returning() -> str:
        return """
        id, owner_user_id, provider::text, display_name, bucket_name, region_name,
        object_prefix, credential_mode::text, role_arn, configured_secret_fields,
        credential_revision, target_revision, status::text, last_verified_at, sanitized_error_code,
        created_at, updated_at
        """

    @staticmethod
    def _verification_select() -> str:
        return """
        SELECT verification.id, verification.connection_id,
               verification.target_revision, verification.credential_revision,
               verification.state::text, verification.attempt_count,
               verification.bucket_access_confirmed,
               verification.object_access_confirmed,
               verification.deny_canaries_confirmed,
               verification.objects_observed, verification.sanitized_error_code,
               verification.duration_ms, verification.requested_by,
               verification.created_at, verification.started_at,
               verification.finished_at
        FROM app.user_dataset_connection_verifications verification
        """

    @classmethod
    def _connection_required(
        cls, row: tuple[Any, ...] | None, caller_user_id: UUID
    ) -> UserDatasetConnection:
        if row is None:
            raise UserConnectionStoreUnavailable("connection mutation returned no row")
        return cls._connection(row, caller_user_id)

    @staticmethod
    def _connection(row: tuple[Any, ...], caller_user_id: UUID) -> UserDatasetConnection:
        owner_user_id = UUID(str(row[1]))
        return UserDatasetConnection(
            connection_id=UUID(str(row[0])),
            owner_user_id=owner_user_id,
            provider=cast(DatasetConnectionProvider, str(row[2])),
            display_name=str(row[3]),
            bucket_name=str(row[4]),
            region_name=str(row[5]),
            object_prefix=str(row[6]),
            credential_mode=PostgresUserDatasetConnectionRepository._credential_mode(row[7]),
            role_arn=str(row[8]) if row[8] is not None else None,
            configured_secret_fields=tuple(cast(list[str], row[9])),
            credential_revision=int(row[10]),
            target_revision=int(row[11]),
            status=cast(DatasetConnectionStatus, str(row[12])),
            last_verified_at=cast(datetime | None, row[13]),
            sanitized_error_code=str(row[14]) if row[14] is not None else None,
            created_at=cast(datetime, row[15]),
            updated_at=cast(datetime, row[16]),
            owned_by_caller=owner_user_id == caller_user_id,
        )

    @classmethod
    def _binding(
        cls, row: tuple[Any, ...], caller_user_id: UUID
    ) -> ProjectDatasetConnectionBinding:
        return ProjectDatasetConnectionBinding(
            binding_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            display_name=str(row[2]),
            created_by=UUID(str(row[3])),
            created_at=cast(datetime, row[4]),
            connection=cls._connection(row[5:], caller_user_id),
        )

    @staticmethod
    def _verification(row: tuple[Any, ...]) -> UserDatasetConnectionVerification:
        return UserDatasetConnectionVerification(
            verification_id=UUID(str(row[0])),
            connection_id=UUID(str(row[1])),
            target_revision=int(row[2]),
            credential_revision=int(row[3]),
            state=cast(UserDatasetVerificationState, str(row[4])),
            attempt_count=int(row[5]),
            bucket_access_confirmed=bool(row[6]),
            object_access_confirmed=bool(row[7]),
            deny_canaries_confirmed=bool(row[8]),
            objects_observed=int(row[9]),
            sanitized_error_code=str(row[10]) if row[10] is not None else None,
            duration_ms=int(row[11]) if row[11] is not None else None,
            requested_by=UUID(str(row[12])),
            created_at=cast(datetime, row[13]),
            started_at=cast(datetime | None, row[14]),
            finished_at=cast(datetime | None, row[15]),
        )

    @staticmethod
    def _project_reference(row: tuple[Any, ...]) -> UserDatasetConnectionProjectReference:
        status = str(row[3])
        if status not in {"active", "archived"}:
            raise UserConnectionStoreUnavailable("invalid project status")
        return UserDatasetConnectionProjectReference(
            binding_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            project_name=str(row[2]),
            project_status=cast(Literal["active", "archived"], status),
            display_name=str(row[4]),
            created_at=cast(datetime, row[5]),
        )

    @staticmethod
    def _connection_health(
        connection: UserDatasetConnection,
        latest: UserDatasetConnectionVerification | None,
    ) -> DatasetConnectionHealth:
        if connection.status == "disabled":
            return "disabled"
        if connection.credential_mode == "access_key" and connection.credential_revision == 0:
            return "needs_credentials"
        current = latest is not None and (
            latest.target_revision == connection.target_revision
            and latest.credential_revision == connection.credential_revision
        )
        if current and latest is not None and latest.state in {"queued", "running"}:
            return "checking"
        if (
            current
            and latest is not None
            and latest.state == "succeeded"
            and connection.status == "verified"
            and latest.bucket_access_confirmed
            and latest.object_access_confirmed
            and latest.deny_canaries_confirmed
        ):
            return "healthy"
        if connection.status == "error" or (
            current and latest is not None and latest.state in {"failed", "cancelled"}
        ):
            return "check_failed"
        return "needs_verification"

    @staticmethod
    def _credential_mode(value: Any) -> DatasetCredentialMode:
        mode = str(value)
        if mode not in {"workload_identity", "assume_role", "access_key"}:
            raise UserConnectionStoreUnavailable("invalid credential mode")
        return cast(DatasetCredentialMode, mode)

    @staticmethod
    def _project_role(value: Any) -> ProjectRole | None:
        if value is None:
            return None
        role = str(value)
        if role not in {"owner", "editor", "reviewer", "viewer"}:
            raise UserConnectionStoreUnavailable("invalid project role")
        return cast(ProjectRole, role)
