import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from urllib.parse import urlencode
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import Action, AuthorizationDenied, ProjectRole, Roles, authorize
from opengeo_api.connections import ConnectionSecretStoreUnavailable, StoredConnectionSecret
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)
from opengeo_api.user_connections import (
    UserConnectionAccessDenied,
    UserConnectionConflict,
    UserConnectionNotFound,
    UserConnectionStoreUnavailable,
)

logger = logging.getLogger(__name__)

BasemapConnectionProvider = Literal["protomaps", "carto"]
BasemapConnectionStatus = Literal["draft", "configured", "disabled"]
ProtomapsFlavor = Literal["light", "dark", "white", "grayscale", "black"]
CartoFlavor = Literal["voyager", "positron", "dark-matter"]
BasemapFlavor = ProtomapsFlavor | CartoFlavor
BasemapResourceKind = Literal["maplibre-style", "raster"]
ResultT = TypeVar("ResultT")


@dataclass(frozen=True, slots=True)
class UserBasemapConnection:
    connection_id: UUID
    owner_user_id: UUID
    provider: BasemapConnectionProvider
    display_name: str
    allowed_origins: tuple[str, ...]
    configured_secret_fields: tuple[str, ...]
    credential_revision: int
    status: BasemapConnectionStatus
    created_at: datetime
    updated_at: datetime
    owned_by_caller: bool


@dataclass(frozen=True, slots=True)
class UserBasemapConnectionDraft:
    provider: BasemapConnectionProvider
    display_name: str
    allowed_origins: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProjectBasemapConnectionBinding:
    binding_id: UUID
    project_id: UUID
    display_name: str
    created_by: UUID
    created_at: datetime
    connection: UserBasemapConnection


@dataclass(frozen=True, slots=True, repr=False)
class ResolvedBasemapStyle:
    binding_id: UUID
    connection_id: UUID
    provider: BasemapConnectionProvider
    connection_name: str
    flavor: BasemapFlavor
    resource_kind: BasemapResourceKind
    resource_url: str
    attribution: str
    credential_revision: int


class UserBasemapConnectionSecretStore(Protocol):
    async def create_user_basemap_connection(
        self,
        organization_id: UUID,
        owner_user_id: UUID,
        connection_id: UUID,
        credential_version_id: UUID,
        api_key: str,
    ) -> StoredConnectionSecret: ...

    async def get_user_basemap_connection_api_key(self, reference: str) -> str: ...

    async def discard(self, reference: str) -> None: ...


class UserBasemapConnectionRepository(Protocol):
    async def list_my_connections(
        self, context: TenantContext
    ) -> tuple[UserBasemapConnection, ...]: ...

    async def create_connection(
        self,
        context: TenantContext,
        draft: UserBasemapConnectionDraft,
        request_id: str,
    ) -> UserBasemapConnection: ...

    async def update_connection(
        self,
        context: TenantContext,
        connection_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> UserBasemapConnection: ...

    async def rotate_api_key(
        self,
        context: TenantContext,
        connection_id: UUID,
        expected_revision: int,
        api_key: str,
        request_id: str,
    ) -> UserBasemapConnection: ...

    async def list_project_bindings(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ProjectBasemapConnectionBinding, ...]: ...

    async def create_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        connection_id: UUID,
        display_name: str,
        request_id: str,
    ) -> ProjectBasemapConnectionBinding: ...

    async def remove_project_binding(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        request_id: str,
    ) -> None: ...

    async def resolve_style(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        flavor: BasemapFlavor,
        request_id: str,
    ) -> ResolvedBasemapStyle: ...


class PostgresUserBasemapConnectionRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        secret_store: UserBasemapConnectionSecretStore,
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
            raise UserConnectionConflict("basemap_connection_constraint_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise UserConnectionStoreUnavailable(
                "basemap connection database unavailable"
            ) from error

    async def list_my_connections(
        self, context: TenantContext
    ) -> tuple[UserBasemapConnection, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[UserBasemapConnection, ...]:
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

    async def create_connection(
        self,
        context: TenantContext,
        draft: UserBasemapConnectionDraft,
        request_id: str,
    ) -> UserBasemapConnection:
        async def operation(transaction: TenantTransaction) -> UserBasemapConnection:
            await self._organization_role(transaction, context)
            connection_id = uuid4()
            row = await transaction.fetch_one(
                f"""
                INSERT INTO app.user_basemap_connections
                  (id, organization_id, owner_user_id, provider, display_name,
                   allowed_origins, status)
                VALUES (%s, %s, %s, %s, %s, %s, 'draft')
                RETURNING {self._connection_returning()}
                """,
                (
                    connection_id,
                    context.organization_id,
                    context.user_id,
                    draft.provider,
                    draft.display_name,
                    list(draft.allowed_origins),
                ),
            )
            connection = self._connection_required(row, context.user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_basemap_connection.created",
                connection.connection_id,
                None,
                {"provider": connection.provider},
            )
            return connection

        return await self._run(context, operation)

    async def update_connection(
        self,
        context: TenantContext,
        connection_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> UserBasemapConnection:
        async def operation(transaction: TenantTransaction) -> UserBasemapConnection:
            await self._organization_role(transaction, context)
            assignments: list[str] = []
            values: list[Any] = []
            for field, value in changes.items():
                if field == "display_name":
                    assignments.append("display_name = %s")
                    values.append(value)
                elif field == "allowed_origins":
                    assignments.append("allowed_origins = %s")
                    values.append(list(cast(tuple[str, ...], value)))
                elif field == "enabled":
                    assignments.append(
                        "status = CASE WHEN %s::boolean = false THEN 'disabled' "
                        "WHEN credential_revision = 0 THEN 'draft' ELSE 'configured' END"
                    )
                    values.append(bool(value))
                else:
                    raise UserConnectionConflict("unsupported_basemap_connection_update")
            if not assignments:
                raise UserConnectionConflict("empty_basemap_connection_update")
            row = await transaction.fetch_one(
                f"""
                UPDATE app.user_basemap_connections
                SET {", ".join(assignments)}
                WHERE organization_id = %s AND owner_user_id = %s AND id = %s
                RETURNING {self._connection_returning()}
                """,
                (*values, context.organization_id, context.user_id, connection_id),
            )
            if row is None:
                raise UserConnectionNotFound("user_basemap_connection")
            connection = self._connection(row, context.user_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_basemap_connection.updated",
                connection.connection_id,
                None,
                {"changed_fields": sorted(changes)},
            )
            return connection

        return await self._run(context, operation)

    async def rotate_api_key(
        self,
        context: TenantContext,
        connection_id: UUID,
        expected_revision: int,
        api_key: str,
        request_id: str,
    ) -> UserBasemapConnection:
        async def prepare(transaction: TenantTransaction) -> tuple[str | None, int]:
            await self._organization_role(transaction, context)
            row = await transaction.fetch_one(
                "SELECT * FROM app.prepare_user_basemap_connection_credential_rotation(%s)",
                (connection_id,),
            )
            if row is None:
                raise UserConnectionNotFound("user_basemap_connection")
            revision = int(row[1])
            if revision != expected_revision:
                raise UserConnectionConflict("stale_credential_revision")
            return str(row[0]) if row[0] is not None else None, revision

        previous_reference, revision = await self._run(context, prepare)
        credential_version_id = uuid4()
        try:
            stored = await self._secret_store.create_user_basemap_connection(
                context.organization_id,
                context.user_id,
                connection_id,
                credential_version_id,
                api_key,
            )
        except ConnectionSecretStoreUnavailable as error:
            raise UserConnectionStoreUnavailable("basemap secret storage failed") from error

        async def commit(transaction: TenantTransaction) -> UserBasemapConnection:
            await self._organization_role(transaction, context)
            row = await transaction.fetch_one(
                "SELECT app.commit_user_basemap_connection_credential_rotation(%s, %s, %s)",
                (connection_id, revision, stored.reference),
            )
            if row is None or not bool(row[0]):
                raise UserConnectionConflict("stale_credential_revision")
            connection = await self._load_owned_connection(transaction, context, connection_id)
            await self._record_event(
                transaction,
                context,
                request_id,
                "user_basemap_connection.api_key_replaced",
                connection_id,
                None,
                {"credential_revision": connection.credential_revision},
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

    async def list_project_bindings(
        self, context: TenantContext, project_id: UUID
    ) -> tuple[ProjectBasemapConnectionBinding, ...]:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[ProjectBasemapConnectionBinding, ...]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            rows = await transaction.fetch_all(
                f"""
                SELECT binding.id, binding.project_id, binding.display_name,
                       binding.created_by, binding.created_at,
                       {self._connection_columns("connection")}
                FROM app.project_basemap_connection_bindings binding
                JOIN app.user_basemap_connections connection
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
    ) -> ProjectBasemapConnectionBinding:
        async def operation(transaction: TenantTransaction) -> ProjectBasemapConnectionBinding:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_MANAGE, roles)
            connection = await self._load_owned_connection(transaction, context, connection_id)
            if connection.status == "disabled":
                raise UserConnectionConflict("connection_disabled")
            binding_id = uuid4()
            await transaction.execute(
                """
                INSERT INTO app.project_basemap_connection_bindings
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
                "project.basemap_connection.bound",
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
                DELETE FROM app.project_basemap_connection_bindings
                WHERE organization_id = %s AND project_id = %s AND id = %s
                """,
                (context.organization_id, project_id, binding_id),
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.basemap_connection.unbound",
                binding_id,
                project_id,
                {"connection_id": str(binding.connection.connection_id)},
            )

        await self._run(context, operation)

    async def resolve_style(
        self,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
        flavor: BasemapFlavor,
        request_id: str,
    ) -> ResolvedBasemapStyle:
        async def prepare(
            transaction: TenantTransaction,
        ) -> tuple[BasemapConnectionProvider, UUID, str, str, int]:
            roles = await self._project_roles(transaction, context, project_id)
            self._require(Action.CONNECTION_READ, roles)
            row = await transaction.fetch_one(
                "SELECT * FROM app.prepare_project_basemap_style_resolution(%s, %s)",
                (project_id, binding_id),
            )
            if row is None:
                raise UserConnectionNotFound("project_basemap_connection")
            provider = self._provider(row[0])
            return provider, UUID(str(row[1])), str(row[2]), str(row[3]), int(row[4])

        provider, connection_id, connection_name, reference, revision = await self._run(
            context, prepare
        )
        try:
            api_key = await self._secret_store.get_user_basemap_connection_api_key(reference)
        except ConnectionSecretStoreUnavailable as error:
            raise UserConnectionStoreUnavailable("basemap style resolution failed") from error
        if provider == "protomaps":
            if flavor not in {"light", "dark", "white", "grayscale", "black"}:
                raise UserConnectionNotFound("project_basemap_flavor")
            resource_kind: BasemapResourceKind = "maplibre-style"
            resource_url = (
                f"https://api.protomaps.com/styles/v5/{flavor}/en.json?"
                f"{urlencode({'key': api_key})}"
            )
            attribution = "Protomaps · © OpenStreetMap contributors"
        else:
            carto_paths = {
                "voyager": "rastertiles/voyager",
                "positron": "light_all",
                "dark-matter": "dark_all",
            }
            path = carto_paths.get(flavor)
            if path is None:
                raise UserConnectionNotFound("project_basemap_flavor")
            resource_kind = "raster"
            resource_url = (
                f"https://basemaps.cartocdn.com/{path}/{{z}}/{{x}}/{{y}}.png?"
                f"{urlencode({'key': api_key})}"
            )
            attribution = "© CARTO · © OpenStreetMap contributors"

        async def record(transaction: TenantTransaction) -> None:
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.basemap_style.resolved",
                binding_id,
                project_id,
                {"connection_id": str(connection_id), "flavor": flavor},
            )

        await self._run(context, record)
        return ResolvedBasemapStyle(
            binding_id=binding_id,
            connection_id=connection_id,
            provider=provider,
            connection_name=connection_name,
            flavor=flavor,
            resource_kind=resource_kind,
            resource_url=resource_url,
            attribution=attribution,
            credential_revision=revision,
        )

    async def _load_owned_connection(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        connection_id: UUID,
    ) -> UserBasemapConnection:
        row = await transaction.fetch_one(
            f"""{self._connection_select()}
            WHERE connection.organization_id = %s
              AND connection.owner_user_id = %s AND connection.id = %s
            """,
            (context.organization_id, context.user_id, connection_id),
        )
        if row is None:
            raise UserConnectionNotFound("user_basemap_connection")
        return self._connection(row, context.user_id)

    async def _load_binding(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        binding_id: UUID,
    ) -> ProjectBasemapConnectionBinding:
        row = await transaction.fetch_one(
            f"""
            SELECT binding.id, binding.project_id, binding.display_name,
                   binding.created_by, binding.created_at,
                   {self._connection_columns("connection")}
            FROM app.project_basemap_connection_bindings binding
            JOIN app.user_basemap_connections connection
              ON connection.organization_id = binding.organization_id
             AND connection.id = binding.connection_id
            WHERE binding.organization_id = %s
              AND binding.project_id = %s AND binding.id = %s
            """,
            (context.organization_id, project_id, binding_id),
        )
        if row is None:
            raise UserConnectionNotFound("project_basemap_connection_binding")
        return self._binding(row, context.user_id)

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
            logger.error("user_basemap_connection.secret_cleanup_failed")

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
            VALUES (%s, %s, %s, %s, 'basemap_connection', %s, %s, %s)
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
        {alias}.display_name, {alias}.allowed_origins,
        {alias}.configured_secret_fields, {alias}.credential_revision,
        {alias}.status::text, {alias}.created_at, {alias}.updated_at
        """

    @classmethod
    def _connection_select(cls) -> str:
        return (
            f"SELECT {cls._connection_columns('connection')} "
            "FROM app.user_basemap_connections connection"
        )

    @staticmethod
    def _connection_returning() -> str:
        return """
        id, owner_user_id, provider::text, display_name, allowed_origins,
        configured_secret_fields, credential_revision, status::text,
        created_at, updated_at
        """

    @classmethod
    def _connection_required(
        cls, row: tuple[Any, ...] | None, caller_user_id: UUID
    ) -> UserBasemapConnection:
        if row is None:
            raise UserConnectionStoreUnavailable("basemap connection mutation returned no row")
        return cls._connection(row, caller_user_id)

    @staticmethod
    def _connection(row: tuple[Any, ...], caller_user_id: UUID) -> UserBasemapConnection:
        owner_user_id = UUID(str(row[1]))
        return UserBasemapConnection(
            connection_id=UUID(str(row[0])),
            owner_user_id=owner_user_id,
            provider=PostgresUserBasemapConnectionRepository._provider(row[2]),
            display_name=str(row[3]),
            allowed_origins=tuple(cast(list[str], row[4])),
            configured_secret_fields=tuple(cast(list[str], row[5])),
            credential_revision=int(row[6]),
            status=cast(BasemapConnectionStatus, str(row[7])),
            created_at=cast(datetime, row[8]),
            updated_at=cast(datetime, row[9]),
            owned_by_caller=owner_user_id == caller_user_id,
        )

    @classmethod
    def _binding(
        cls, row: tuple[Any, ...], caller_user_id: UUID
    ) -> ProjectBasemapConnectionBinding:
        return ProjectBasemapConnectionBinding(
            binding_id=UUID(str(row[0])),
            project_id=UUID(str(row[1])),
            display_name=str(row[2]),
            created_by=UUID(str(row[3])),
            created_at=cast(datetime, row[4]),
            connection=cls._connection(row[5:], caller_user_id),
        )

    @staticmethod
    def _provider(value: Any) -> BasemapConnectionProvider:
        provider = str(value)
        if provider not in {"protomaps", "carto"}:
            raise UserConnectionStoreUnavailable("invalid basemap provider")
        return cast(BasemapConnectionProvider, provider)

    @staticmethod
    def _project_role(value: Any) -> ProjectRole | None:
        if value is None:
            return None
        role = str(value)
        if role not in {"owner", "editor", "reviewer", "viewer"}:
            raise UserConnectionStoreUnavailable("invalid project role")
        return cast(ProjectRole, role)
