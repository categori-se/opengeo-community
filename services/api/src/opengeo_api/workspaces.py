import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    DatasetPermissionRole,
    Roles,
    authorize,
    is_allowed,
)
from opengeo_api.features import _like_pattern
from opengeo_api.map_definitions import (
    external_map_configuration,
    map_basemap_connection_references,
    map_dataset_references,
    validate_map_definition,
)
from opengeo_api.resources import (
    PostgresResourceRepository,
    ResourceAccessDenied,
    ResourceConflict,
    ResourceDraft,
    ResourceMetadata,
    ResourceNotFound,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

RecordStatus = Literal["active", "archived"]
ProjectRole = Literal["owner", "editor", "reviewer", "viewer"]
ProjectVisibility = Literal["internal", "published"]

# Aurora RDS Data API rejects a returned row above 64 KiB and an entire response
# above 1 MiB. A 24 KiB bytea value remains below the row limit even after the
# API's base64/JSON envelope. The external request contract remains 256 KiB;
# this larger bound accommodates PostgreSQL jsonb's canonical whitespace while
# rejecting unexpectedly oversized values before a chunk query is attempted.
_MAP_DEFINITION_CHUNK_BYTES = 24_576
_MAX_STORED_MAP_DEFINITION_BYTES = 524_288
_MAP_DEFINITION_BATCH_BYTES = 524_288


@dataclass(frozen=True, slots=True)
class Page:
    limit: int = 50
    offset: int = 0


class WorkspaceStoreUnavailable(RuntimeError):
    pass


class WorkspaceAccessDenied(RuntimeError):
    pass


class WorkspaceNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class WorkspaceConflict(RuntimeError):
    def __init__(self, code: str, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class OrganizationMember:
    user_id: UUID
    email: str
    display_name: str
    role: OrganizationRole


@dataclass(frozen=True, slots=True)
class Client:
    client_id: UUID
    name: str
    client_code: str | None
    description: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ClientDraft:
    name: str
    client_code: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class Project:
    project_id: UUID
    client_id: UUID | None
    name: str
    project_code: str | None
    description: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime
    caller_role: ProjectRole | None
    visibility: ProjectVisibility = "internal"
    published_at: datetime | None = None
    published_by: UUID | None = None


@dataclass(frozen=True, slots=True)
class RecentProject:
    project: Project
    last_activity_at: datetime
    last_event_type: str


@dataclass(frozen=True, slots=True)
class ProjectDraft:
    client_id: UUID | None
    name: str
    project_code: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class ProjectMember:
    user_id: UUID
    email: str
    display_name: str
    role: ProjectRole


@dataclass(frozen=True, slots=True)
class CompositionSummary:
    composition_id: UUID
    access_container_id: UUID
    access_container_name: str
    name: str
    description: str | None
    status: RecordStatus
    version: int
    updated_at: datetime
    owner_user_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class MapRecord:
    map_id: UUID
    project_id: UUID
    name: str
    description: str | None
    status: RecordStatus
    definition: dict[str, Any]
    version: int
    created_at: datetime
    updated_at: datetime
    owner_user_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class MapVersionSummary:
    version: int
    definition_bytes: int
    change_message: str | None
    created_by: UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class MapVersionRecord:
    summary: MapVersionSummary
    definition: dict[str, Any]


@dataclass(frozen=True, slots=True)
class MapDraft:
    name: str
    description: str | None
    definition: dict[str, Any]
    creation_key: UUID | None = None


class WorkspaceRepository(Protocol):
    async def list_organization_members(
        self, context: TenantContext, page: Page
    ) -> list[OrganizationMember]: ...

    async def list_clients(self, context: TenantContext, page: Page) -> list[Client]: ...

    async def get_client(self, context: TenantContext, client_id: UUID) -> Client: ...

    async def create_client(
        self, context: TenantContext, draft: ClientDraft, request_id: str
    ) -> Client: ...

    async def update_client(
        self,
        context: TenantContext,
        client_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> Client: ...

    async def list_projects(
        self,
        context: TenantContext,
        client_id: UUID | None,
        page: Page,
        query: str = "",
        status: RecordStatus | None = None,
    ) -> list[Project]: ...

    async def list_recent_projects(
        self, context: TenantContext, page: Page
    ) -> list[RecentProject]: ...

    async def get_project(self, context: TenantContext, project_id: UUID) -> Project: ...

    async def create_project(
        self, context: TenantContext, draft: ProjectDraft, request_id: str
    ) -> Project: ...

    async def update_project(
        self,
        context: TenantContext,
        project_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> Project: ...

    async def list_project_members(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[ProjectMember]: ...

    async def list_maps(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[MapRecord]: ...

    async def list_compositions(
        self, context: TenantContext, page: Page, query: str, status: RecordStatus | None
    ) -> list[CompositionSummary]: ...

    async def get_composition(self, context: TenantContext, composition_id: UUID) -> MapRecord: ...

    async def list_composition_versions(
        self, context: TenantContext, composition_id: UUID, limit: int, before_version: int | None
    ) -> list[MapVersionSummary]: ...

    async def get_composition_version(
        self, context: TenantContext, composition_id: UUID, version: int
    ) -> MapVersionRecord: ...

    async def get_map(
        self, context: TenantContext, project_id: UUID, map_id: UUID
    ) -> MapRecord: ...

    async def create_map(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: MapDraft,
        request_id: str,
    ) -> MapRecord: ...

    async def update_map(
        self,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        expected_version: int,
        changes: Mapping[str, Any],
        change_message: str | None,
        request_id: str,
    ) -> MapRecord: ...

    async def duplicate_map(
        self,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        name: str | None,
        request_id: str,
    ) -> MapRecord: ...


OperationResult = TypeVar("OperationResult")


class PostgresWorkspaceRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[OperationResult]],
    ) -> OperationResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise WorkspaceConflict("resource_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise WorkspaceStoreUnavailable("workspace operation failed") from error

    async def list_organization_members(
        self, context: TenantContext, page: Page
    ) -> list[OrganizationMember]:
        async def operation(transaction: TenantTransaction) -> list[OrganizationMember]:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.ORGANIZATION_MEMBERS_READ, Roles(organization_role))
            rows = await transaction.fetch_all(
                """
                SELECT identity.id, identity.email, identity.display_name, membership.role::text
                FROM app.organization_memberships membership
                JOIN app.users identity ON identity.id = membership.user_id
                WHERE membership.organization_id = %s
                ORDER BY lower(identity.display_name), identity.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, page.limit, page.offset),
            )
            return [self._organization_member(row) for row in rows]

        return await self._run(context, operation)

    async def list_clients(self, context: TenantContext, page: Page) -> list[Client]:
        async def operation(transaction: TenantTransaction) -> list[Client]:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.CLIENT_READ, Roles(organization_role))
            rows = await transaction.fetch_all(
                f"""{self._client_select()}
                WHERE organization_id = %s
                ORDER BY lower(name), id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, page.limit, page.offset),
            )
            return [self._client(row) for row in rows]

        return await self._run(context, operation)

    async def get_client(self, context: TenantContext, client_id: UUID) -> Client:
        async def operation(transaction: TenantTransaction) -> Client:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.CLIENT_READ, Roles(organization_role))
            return await self._load_client(transaction, context, client_id)

        return await self._run(context, operation)

    async def create_client(
        self, context: TenantContext, draft: ClientDraft, request_id: str
    ) -> Client:
        async def operation(transaction: TenantTransaction) -> Client:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.CLIENT_CREATE, Roles(organization_role))
            client_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.clients
                  (id, organization_id, name, client_code, description, created_by)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id, name, client_code, description, status::text, created_at, updated_at
                """,
                (
                    client_id,
                    context.organization_id,
                    draft.name,
                    draft.client_code,
                    draft.description,
                    context.user_id,
                ),
            )
            client = self._client_required(row)
            await self._record_event(
                transaction,
                context,
                request_id,
                "client.created",
                "client",
                client.client_id,
                None,
                {"status": client.status},
            )
            return client

        return await self._run(context, operation)

    async def update_client(
        self,
        context: TenantContext,
        client_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> Client:
        async def operation(transaction: TenantTransaction) -> Client:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.CLIENT_UPDATE, Roles(organization_role))
            await self._load_client(transaction, context, client_id)
            assignments, values = self._assignments(
                changes,
                {
                    "name": "name",
                    "client_code": "client_code",
                    "description": "description",
                    "status": "status",
                },
            )
            row = await transaction.fetch_one(
                f"""
                UPDATE app.clients
                SET {", ".join(assignments)}
                WHERE organization_id = %s AND id = %s
                RETURNING id, name, client_code, description, status::text, created_at, updated_at
                """,
                (*values, context.organization_id, client_id),
            )
            client = self._client_required(row)
            event_type = (
                "client.archived" if changes.get("status") == "archived" else "client.updated"
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                event_type,
                "client",
                client_id,
                None,
                {"changed_fields": sorted(changes)},
            )
            return client

        return await self._run(context, operation)

    async def list_projects(
        self,
        context: TenantContext,
        client_id: UUID | None,
        page: Page,
        query: str = "",
        status: RecordStatus | None = None,
    ) -> list[Project]:
        async def operation(transaction: TenantTransaction) -> list[Project]:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.PROJECT_LIST, Roles(organization_role))
            filters: list[str] = []
            parameters: list[Any] = [
                context.organization_id,
                client_id,
                client_id,
                organization_role == "admin",
                context.user_id,
            ]
            if status is not None:
                filters.append("AND project.status::text = %s")
                parameters.append(status)
            if query:
                searchable = (
                    "project.name || ' ' || coalesce(project.description, '') || ' ' || "
                    "coalesce(project.project_code, '')"
                )
                if is_allowed(Action.CLIENT_READ, Roles(organization_role)):
                    searchable += (
                        " || ' ' || coalesce((SELECT client.name FROM app.clients client "
                        "WHERE client.organization_id = project.organization_id "
                        "AND client.id = project.client_id), '')"
                    )
                filters.append(f"AND lower({searchable}) LIKE lower(%s) ESCAPE %s")
                parameters.extend((_like_pattern(query, contains=True), "\\"))
            parameters.extend((page.limit, page.offset))
            rows = await transaction.fetch_all(
                f"""{self._project_select()}
                WHERE project.organization_id = %s
                  AND (%s::uuid IS NULL OR project.client_id = %s)
                  AND (
                    %s::boolean
                    OR app.effective_project_role(project.id, %s) IS NOT NULL
                )
                {" ".join(filters)}
                ORDER BY lower(project.name), project.id
                LIMIT %s OFFSET %s
                """,
                tuple(parameters),
            )
            return [self._project(row) for row in rows]

        return await self._run(context, operation)

    async def list_recent_projects(self, context: TenantContext, page: Page) -> list[RecentProject]:
        async def operation(transaction: TenantTransaction) -> list[RecentProject]:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.PROJECT_LIST, Roles(organization_role))
            rows = await transaction.fetch_all(
                """
                SELECT project.id, project.client_id, project.name, project.project_code,
                       project.description, project.status::text, project.created_at,
                       project.updated_at,
                       app.effective_project_role(project.id)::text AS caller_role,
                       project.visibility::text, project.published_at, project.published_by,
                       recent_activity.occurred_at,
                       recent_activity.event_type
                FROM app.projects project
                JOIN LATERAL (
                  SELECT event.occurred_at, event.event_type
                  FROM app.activity_events event
                  WHERE event.organization_id = project.organization_id
                    AND event.project_id = project.id
                    AND event.actor_user_id = %s
                  ORDER BY event.occurred_at DESC, event.id DESC
                  LIMIT 1
                ) recent_activity ON TRUE
                WHERE project.organization_id = %s
                  AND project.status = 'active'
                  AND (
                    %s::boolean
                    OR app.effective_project_role(project.id, %s) IS NOT NULL
                  )
                ORDER BY recent_activity.occurred_at DESC, project.id
                LIMIT %s OFFSET %s
                """,
                (
                    context.user_id,
                    context.organization_id,
                    organization_role == "admin",
                    context.user_id,
                    page.limit,
                    page.offset,
                ),
            )
            return [self._recent_project(row) for row in rows]

        return await self._run(context, operation)

    async def get_project(self, context: TenantContext, project_id: UUID) -> Project:
        async def operation(transaction: TenantTransaction) -> Project:
            organization_role = await self._organization_role(transaction, context)
            project = await self._load_project(transaction, context, project_id)
            self._require_hidden(
                Action.PROJECT_READ,
                Roles(organization_role, project.caller_role),
                "project",
            )
            return project

        return await self._run(context, operation)

    async def create_project(
        self, context: TenantContext, draft: ProjectDraft, request_id: str
    ) -> Project:
        async def operation(transaction: TenantTransaction) -> Project:
            organization_role = await self._organization_role(transaction, context)
            self._require(Action.PROJECT_CREATE, Roles(organization_role))
            if draft.client_id is not None:
                client = await self._load_client(transaction, context, draft.client_id)
                if client.status != "active":
                    raise WorkspaceConflict("client_archived")
            project_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.projects
                  (id, organization_id, client_id, name, project_code, description, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, client_id, name, project_code, description, status::text,
                          created_at, updated_at, 'owner'::text,
                          visibility::text, published_at, published_by
                """,
                (
                    project_id,
                    context.organization_id,
                    draft.client_id,
                    draft.name,
                    draft.project_code,
                    draft.description,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, 'owner')
                """,
                (context.organization_id, project_id, context.user_id),
            )
            project = self._project_required(row)
            await self._record_event(
                transaction,
                context,
                request_id,
                "project.created",
                "project",
                project_id,
                project_id,
                {"client_id": str(draft.client_id) if draft.client_id else None},
            )
            return project

        return await self._run(context, operation)

    async def update_project(
        self,
        context: TenantContext,
        project_id: UUID,
        changes: Mapping[str, Any],
        request_id: str,
    ) -> Project:
        async def operation(transaction: TenantTransaction) -> Project:
            organization_role = await self._organization_role(transaction, context)
            existing = await self._load_project(transaction, context, project_id)
            self._require(Action.PROJECT_UPDATE, Roles(organization_role, existing.caller_role))
            assignments: list[str] = []
            values: list[Any] = []
            allowed = {
                "name": "name",
                "project_code": "project_code",
                "description": "description",
                "status": "status",
            }
            for field, value in changes.items():
                if field == "visibility":
                    assignments.extend(
                        [
                            "visibility = %s::app.project_visibility",
                            (
                                "published_at = CASE WHEN %s = 'published' "
                                "THEN clock_timestamp() ELSE NULL END"
                            ),
                            "published_by = CASE WHEN %s = 'published' THEN %s::uuid ELSE NULL END",
                        ]
                    )
                    values.extend([value, value, value, context.user_id])
                    continue
                column = allowed.get(field)
                if column is None:
                    raise WorkspaceStoreUnavailable("unsupported update field")
                parameter = "CAST(%s AS app.record_status)" if field == "status" else "%s"
                assignments.append(f"{column} = {parameter}")
                values.append(value)
            if not assignments:
                raise WorkspaceConflict("empty_update")
            row = await transaction.fetch_one(
                f"""
                UPDATE app.projects project
                SET {", ".join(assignments)}
                WHERE project.organization_id = %s AND project.id = %s
                RETURNING project.id, project.client_id, project.name, project.project_code,
                          project.description, project.status::text, project.created_at,
                          project.updated_at, %s::text, project.visibility::text,
                          project.published_at, project.published_by
                """,
                (*values, context.organization_id, project_id, existing.caller_role),
            )
            project = self._project_required(row)
            event_type = (
                "project.archived"
                if changes.get("status") == "archived"
                else "project.published"
                if changes.get("visibility") == "published"
                else "project.unpublished"
                if changes.get("visibility") == "internal"
                else "project.updated"
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                event_type,
                "project",
                project_id,
                project_id,
                {"changed_fields": sorted(changes)},
            )
            return project

        return await self._run(context, operation)

    async def list_project_members(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[ProjectMember]:
        async def operation(transaction: TenantTransaction) -> list[ProjectMember]:
            organization_role = await self._organization_role(transaction, context)
            project = await self._load_project(transaction, context, project_id)
            self._require_hidden(
                Action.PROJECT_MEMBERS_READ,
                Roles(organization_role, project.caller_role),
                "project",
            )
            rows = await transaction.fetch_all(
                """
                SELECT identity.id, identity.email, identity.display_name, membership.role::text
                FROM app.project_memberships membership
                JOIN app.users identity ON identity.id = membership.user_id
                WHERE membership.organization_id = %s AND membership.project_id = %s
                ORDER BY lower(identity.display_name), identity.id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, page.limit, page.offset),
            )
            return [self._project_member(row) for row in rows]

        return await self._run(context, operation)

    async def list_maps(
        self, context: TenantContext, project_id: UUID, page: Page
    ) -> list[MapRecord]:
        async def operation(transaction: TenantTransaction) -> list[MapRecord]:
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require_hidden(Action.MAP_READ, roles, "project")
            rows = await transaction.fetch_all(
                f"""{self._map_select()}
                WHERE organization_id = %s AND project_id = %s
                ORDER BY lower(name), id
                LIMIT %s OFFSET %s
                """,
                (context.organization_id, project_id, page.limit, page.offset),
            )
            definitions = await self._load_map_definitions(
                transaction,
                context,
                project_id,
                rows,
            )
            return [self._map(row, definitions[self._map_id(row)]) for row in rows]

        return await self._run(context, operation)

    async def list_compositions(
        self, context: TenantContext, page: Page, query: str, status: RecordStatus | None
    ) -> list[CompositionSummary]:
        async def operation(transaction: TenantTransaction) -> list[CompositionSummary]:
            rows = await transaction.fetch_all(
                """
                SELECT map.id, map.project_id, project.name, map.name, map.description,
                       map.status::text, map.version, map.updated_at, resource.owner_user_id
                FROM app.maps map
                JOIN app.projects project ON project.organization_id = map.organization_id
                  AND project.id = map.project_id
                LEFT JOIN app.governed_resources resource
                  ON resource.organization_id = map.organization_id
                  AND resource.project_id = map.project_id AND resource.map_id = map.id
                  AND resource.kind = 'map'
                JOIN app.organization_memberships membership
                  ON membership.organization_id = map.organization_id AND membership.user_id = %s
                WHERE map.organization_id = %s
                  AND (membership.role::text = 'admin'
                       OR app.effective_project_role(project.id, membership.user_id) IS NOT NULL)
                  AND (%s::text IS NULL OR map.status::text = %s)
                  AND (%s = '' OR position(lower(%s) in lower(map.name || ' ' ||
                       coalesce(map.description, '') || ' ' || project.name)) > 0)
                ORDER BY map.updated_at DESC, map.id DESC
                LIMIT %s OFFSET %s
                """,
                (
                    context.user_id,
                    context.organization_id,
                    status,
                    status,
                    query,
                    query,
                    page.limit,
                    page.offset,
                ),
            )
            return [CompositionSummary(*row) for row in rows]

        return await self._run(context, operation)

    async def get_composition(self, context: TenantContext, composition_id: UUID) -> MapRecord:
        """Resolve authored identity without treating its access container as the Project."""

        async def operation(transaction: TenantTransaction) -> MapRecord:
            project_id = await self._require_composition_read(transaction, context, composition_id)
            return await self._load_map(
                transaction, context, project_id, composition_id, include_owner=True
            )

        return await self._run(context, operation)

    async def list_composition_versions(
        self, context: TenantContext, composition_id: UUID, limit: int, before_version: int | None
    ) -> list[MapVersionSummary]:
        async def operation(transaction: TenantTransaction) -> list[MapVersionSummary]:
            await self._require_composition_read(transaction, context, composition_id)
            rows = await transaction.fetch_all(
                """
                SELECT history.version, octet_length(history.definition::text),
                       left(history.change_message, 500), history.created_by, history.created_at
                FROM app.map_versions history
                WHERE history.organization_id = %s AND history.map_id = %s
                  AND (%s::bigint IS NULL OR history.version < %s::bigint)
                ORDER BY history.version DESC
                LIMIT %s
                """,
                (
                    context.organization_id,
                    composition_id,
                    before_version,
                    before_version,
                    limit,
                ),
            )
            return [self._map_version_summary(row) for row in rows]

        return await self._run(context, operation)

    async def get_composition_version(
        self, context: TenantContext, composition_id: UUID, version: int
    ) -> MapVersionRecord:
        async def operation(transaction: TenantTransaction) -> MapVersionRecord:
            await self._require_composition_read(transaction, context, composition_id)
            row = await transaction.fetch_one(
                """
                SELECT history.version, octet_length(history.definition::text),
                       left(history.change_message, 500), history.created_by, history.created_at
                FROM app.map_versions history
                WHERE history.organization_id = %s AND history.map_id = %s
                  AND history.version = %s
                """,
                (context.organization_id, composition_id, version),
            )
            if row is None:
                raise WorkspaceNotFound("composition_version")
            summary = self._map_version_summary(row)
            self._validate_map_definition_size(summary.definition_bytes)
            rows = await transaction.fetch_all(
                """
                SELECT chunk.chunk_index,
                       substring(
                         convert_to(history.definition::text, 'UTF8')
                         FROM chunk.chunk_index * %s::integer + 1
                         FOR %s::integer
                       )
                FROM app.map_versions history
                CROSS JOIN LATERAL generate_series(
                  0,
                  (octet_length(history.definition::text) - 1) / %s::integer
                ) AS chunk(chunk_index)
                WHERE history.organization_id = %s AND history.map_id = %s
                  AND history.version = %s
                ORDER BY chunk.chunk_index
                """,
                (
                    _MAP_DEFINITION_CHUNK_BYTES,
                    _MAP_DEFINITION_CHUNK_BYTES,
                    _MAP_DEFINITION_CHUNK_BYTES,
                    context.organization_id,
                    composition_id,
                    version,
                ),
            )
            definition = self._decode_map_definition_chunks(rows, summary.definition_bytes)
            return MapVersionRecord(summary=summary, definition=definition)

        return await self._run(context, operation)

    async def _require_composition_read(
        self, transaction: TenantTransaction, context: TenantContext, composition_id: UUID
    ) -> UUID:
        row = await transaction.fetch_one(
            "SELECT project_id FROM app.maps WHERE organization_id = %s AND id = %s",
            (context.organization_id, composition_id),
        )
        if row is None:
            raise WorkspaceNotFound("composition")
        try:
            project_id = UUID(str(row[0]))
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid composition access container") from error
        roles = await self._roles_for_project(transaction, context, project_id)
        self._require_hidden(Action.MAP_READ, roles, "composition")
        return project_id

    async def get_map(self, context: TenantContext, project_id: UUID, map_id: UUID) -> MapRecord:
        async def operation(transaction: TenantTransaction) -> MapRecord:
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require_hidden(Action.MAP_READ, roles, "map")
            return await self._load_map(transaction, context, project_id, map_id)

        return await self._run(context, operation)

    async def create_map(
        self,
        context: TenantContext,
        project_id: UUID,
        draft: MapDraft,
        request_id: str,
    ) -> MapRecord:
        async def operation(transaction: TenantTransaction) -> MapRecord:
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.MAP_CREATE, roles)
            await self._require_map_definition_references(
                transaction, context, project_id, draft.definition
            )
            request_hash = sha256(
                json.dumps(
                    {
                        "project_id": str(project_id),
                        "name": draft.name,
                        "description": draft.description,
                        "definition": draft.definition,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode()
            ).hexdigest()
            if draft.creation_key is not None:
                await transaction.fetch_one(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 126))::text",
                    (f"{context.organization_id}/{context.user_id}/{draft.creation_key}",),
                )
                previous = await transaction.fetch_one(
                    """SELECT map_id, project_id, request_sha256
                       FROM app.map_creation_requests
                       WHERE organization_id=%s AND created_by=%s AND creation_key=%s""",
                    (context.organization_id, context.user_id, draft.creation_key),
                )
                if previous is not None:
                    if previous[1] != project_id or previous[2] != request_hash:
                        raise WorkspaceConflict("map_creation_key_conflict")
                    return await self._load_map(transaction, context, project_id, previous[0])
            self._require(Action.RESOURCE_CREATE, roles)
            map_id = uuid4()
            row = await transaction.fetch_one(
                """
                INSERT INTO app.maps
                  (id, organization_id, project_id, name, description, definition,
                   created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, project_id, name, description, status::text,
                          octet_length(definition::text), version, created_at, updated_at
                """,
                (
                    map_id,
                    context.organization_id,
                    project_id,
                    draft.name,
                    draft.description,
                    Jsonb(draft.definition),
                    context.user_id,
                    context.user_id,
                ),
            )
            map_record = await self._map_required_with_definition(
                transaction,
                context,
                project_id,
                row,
            )
            if draft.creation_key is not None:
                await transaction.fetch_one(
                    """INSERT INTO app.map_creation_requests
                       (organization_id,created_by,creation_key,project_id,map_id,request_sha256)
                       VALUES (%s,%s,%s,%s,%s,%s) RETURNING map_id""",
                    (
                        context.organization_id,
                        context.user_id,
                        draft.creation_key,
                        project_id,
                        map_id,
                        request_hash,
                    ),
                )
            await self._record_map_version(transaction, context, map_record, "Initial version")
            map_record = await self._create_map_resource(
                transaction, context, map_record, request_id
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "map.created",
                "map",
                map_id,
                project_id,
                {"version": 1},
            )
            return map_record

        return await self._run(context, operation)

    async def update_map(
        self,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        expected_version: int,
        changes: Mapping[str, Any],
        change_message: str | None,
        request_id: str,
    ) -> MapRecord:
        async def operation(transaction: TenantTransaction) -> MapRecord:
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.MAP_UPDATE, roles)
            existing = await self._load_map(transaction, context, project_id, map_id)
            if existing.version != expected_version:
                raise WorkspaceConflict("map_version_conflict", existing.version)
            if "definition" in changes:
                await self._require_map_definition_references(
                    transaction,
                    context,
                    project_id,
                    cast(dict[str, Any], changes["definition"]),
                )

            assignments, values = self._assignments(
                changes,
                {
                    "name": "name",
                    "description": "description",
                    "status": "status",
                    "definition": "definition",
                },
                json_fields={"definition"},
                field_casts={"status": "app.record_status"},
            )
            assignments.extend(["version = version + 1", "updated_by = %s"])
            values.append(context.user_id)
            row = await transaction.fetch_one(
                f"""
                UPDATE app.maps
                SET {", ".join(assignments)}
                WHERE organization_id = %s AND project_id = %s AND id = %s AND version = %s
                RETURNING id, project_id, name, description, status::text,
                          octet_length(definition::text), version, created_at, updated_at
                """,
                (
                    *values,
                    context.organization_id,
                    project_id,
                    map_id,
                    expected_version,
                ),
            )
            if row is None:
                latest = await transaction.fetch_one(
                    """
                    SELECT version
                    FROM app.maps
                    WHERE organization_id = %s AND project_id = %s AND id = %s
                    """,
                    (context.organization_id, project_id, map_id),
                )
                if latest is None:
                    raise WorkspaceNotFound("map")
                try:
                    current_version = int(latest[0])
                except (IndexError, TypeError, ValueError) as error:
                    raise WorkspaceStoreUnavailable("invalid current map version") from error
                raise WorkspaceConflict("map_version_conflict", current_version)
            map_record = await self._map_required_with_definition(
                transaction,
                context,
                project_id,
                row,
            )
            await self._record_map_version(transaction, context, map_record, change_message)
            event_type = "map.archived" if changes.get("status") == "archived" else "map.updated"
            await self._record_event(
                transaction,
                context,
                request_id,
                event_type,
                "map",
                map_id,
                project_id,
                {"changed_fields": sorted(changes), "version": map_record.version},
            )
            return map_record

        return await self._run(context, operation)

    async def duplicate_map(
        self,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        name: str | None,
        request_id: str,
    ) -> MapRecord:
        async def operation(transaction: TenantTransaction) -> MapRecord:
            roles = await self._roles_for_project(transaction, context, project_id)
            self._require(Action.MAP_CREATE, roles)
            self._require(Action.RESOURCE_CREATE, roles)
            source = await self._load_map(transaction, context, project_id, map_id)
            await self._require_map_definition_references(
                transaction, context, project_id, source.definition
            )
            duplicate_id = uuid4()
            duplicate_name = name or f"{source.name[:195]} copy"
            row = await transaction.fetch_one(
                """
                INSERT INTO app.maps
                  (id, organization_id, project_id, name, description, definition,
                   created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id, project_id, name, description, status::text,
                          octet_length(definition::text), version, created_at, updated_at
                """,
                (
                    duplicate_id,
                    context.organization_id,
                    project_id,
                    duplicate_name,
                    source.description,
                    Jsonb(source.definition),
                    context.user_id,
                    context.user_id,
                ),
            )
            duplicate = await self._map_required_with_definition(
                transaction,
                context,
                project_id,
                row,
            )
            await self._record_map_version(
                transaction,
                context,
                duplicate,
                f"Duplicated from {map_id}",
            )
            duplicate = await self._create_map_resource(
                transaction, context, duplicate, request_id,
                source_map_id=map_id, source_map_version=source.version,
            )
            await self._record_event(
                transaction,
                context,
                request_id,
                "map.duplicated",
                "map",
                duplicate_id,
                project_id,
                {"source_map_id": str(map_id), "version": 1},
            )
            return duplicate

        return await self._run(context, operation)

    async def _create_map_resource(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        map_record: MapRecord,
        request_id: str,
        *,
        source_map_id: UUID | None = None,
        source_map_version: int | None = None,
    ) -> MapRecord:
        """Assign an explicit owner only for a new map with retained first history."""
        provenance: dict[str, Any] = {
            "source": "opengeo_map_duplication" if source_map_id else "opengeo_map_creation",
            "mapId": str(map_record.map_id),
            "mapVersion": map_record.version,
        }
        if source_map_id is not None:
            provenance["sourceMapId"] = str(source_map_id)
            provenance["sourceMapVersion"] = source_map_version
        draft = ResourceDraft(
            kind="map",
            slug=f"map-{map_record.map_id}",
            dataset_id=None,
            map_id=map_record.map_id,
            visibility="restricted",
            state="draft",
            metadata=ResourceMetadata(
                title=map_record.name,
                abstract=map_record.description,
                language="und",
                license=None,
                attribution=None,
                keywords=(),
                spatial_extent=None,
                temporal_start=None,
                temporal_end=None,
                profile="opengeo.core.v1",
                extensions={},
            ),
            content={"blocks": []},
            provenance=provenance,
            expected_map_version=map_record.version,
        )
        try:
            await PostgresResourceRepository(self._executor)._create_resource(
                transaction, context, map_record.project_id, draft, request_id
            )
        except ResourceConflict as error:
            raise WorkspaceConflict(error.code, error.current_version) from error
        except ResourceNotFound as error:
            raise WorkspaceNotFound(error.resource) from error
        return replace(map_record, owner_user_id=context.user_id)

    async def _require_map_definition_references(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        definition: dict[str, Any],
    ) -> None:
        try:
            validate_map_definition(definition, require_current=True)
        except ValueError as error:
            raise WorkspaceConflict("map_definition_invalid") from error
        checked_styles: set[tuple[str, str, str, int, str, str, str]] = set()
        for layer in definition.get("layers", []):
            reference = layer.get("styleReference")
            if reference is None:
                continue
            style_key = (
                reference["projectId"],
                reference["resourceId"],
                reference["styleId"],
                reference["versionNumber"],
                reference["checksumSha256"],
                reference["format"],
                layer["datasetId"],
            )
            if style_key in checked_styles:
                continue
            try:
                roles = await PostgresResourceRepository._resource_roles(
                    transaction,
                    context,
                    UUID(reference["projectId"]),
                    UUID(reference["resourceId"]),
                )
                PostgresResourceRepository._require(Action.RESOURCE_READ, roles)
            except (ResourceAccessDenied, ResourceNotFound) as error:
                raise WorkspaceConflict("map_style_reference_unavailable") from error
            row = await transaction.fetch_one(
                """
                SELECT version.id
                FROM app.governed_resource_styles style
                JOIN app.governed_resources resource
                  ON resource.organization_id = style.organization_id
                 AND resource.project_id = style.project_id
                 AND resource.id = style.resource_id
                JOIN app.governed_resource_style_versions version
                  ON version.organization_id = style.organization_id
                 AND version.style_id = style.id
                WHERE style.organization_id = %s AND style.project_id = %s
                  AND style.resource_id = %s AND style.id = %s
                  AND version.version_number = %s AND version.checksum_sha256 = %s
                  AND style.format::text = %s AND resource.dataset_id = %s
                """,
                (
                    context.organization_id,
                    UUID(reference["projectId"]),
                    UUID(reference["resourceId"]),
                    UUID(reference["styleId"]),
                    reference["versionNumber"],
                    reference["checksumSha256"],
                    reference["format"],
                    UUID(layer["datasetId"]),
                ),
            )
            if row is None:
                raise WorkspaceConflict("map_style_reference_unavailable")
            checked_styles.add(style_key)
        basemap_binding_ids = sorted(
            {str(binding_id) for binding_id in map_basemap_connection_references(definition)}
        )
        if basemap_binding_ids:
            binding_rows = await transaction.fetch_all(
                """
                SELECT binding.id
                FROM jsonb_array_elements_text(%s::jsonb) requested(binding_id)
                JOIN app.project_basemap_connection_bindings binding
                  ON binding.organization_id = %s
                 AND binding.project_id = %s
                 AND binding.id = requested.binding_id::uuid
                ORDER BY binding.id
                FOR KEY SHARE OF binding
                """,
                (Jsonb(basemap_binding_ids), context.organization_id, project_id),
            )
            linked_binding_ids = {str(row[0]) for row in binding_rows}
            if linked_binding_ids != set(basemap_binding_ids):
                raise WorkspaceConflict("map_basemap_connection_not_linked")
        references = map_dataset_references(definition)
        if not references:
            return

        dataset_ids = sorted({str(reference.dataset_id) for reference in references})
        unversioned_raw_ids = {
            str(reference.dataset_id)
            for reference in references
            if reference.dataset_version_id is None
            and reference.managed_display_id is None
            and reference.source_type is None
        }
        current_version_selection = (
            """,
                   EXISTS (
                     SELECT 1 FROM app.datasets dataset
                     JOIN app.dataset_versions current_version
                       ON current_version.organization_id = dataset.organization_id
                      AND current_version.dataset_id = dataset.id
                      AND current_version.id = dataset.current_version_id
                     WHERE dataset.organization_id = project_dataset.organization_id
                       AND dataset.id = project_dataset.dataset_id
                       AND current_version.state::text = 'preserved'
                   ) AS current_version_preserved"""
            if unversioned_raw_ids
            else ""
        )
        linked_rows = await transaction.fetch_all(
            f"""
            SELECT project_dataset.dataset_id{current_version_selection}
            FROM jsonb_array_elements_text(%s::jsonb) requested(dataset_id)
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = %s
             AND project_dataset.project_id = %s
             AND project_dataset.dataset_id = requested.dataset_id::uuid
            ORDER BY project_dataset.dataset_id
            FOR KEY SHARE OF project_dataset
            """,
            (Jsonb(dataset_ids), context.organization_id, project_id),
        )
        linked_ids = {str(row[0]) for row in linked_rows}
        if linked_ids != set(dataset_ids):
            raise WorkspaceConflict("map_dataset_not_linked")
        if unversioned_raw_ids and any(
            str(row[0]) in unversioned_raw_ids and row[1] for row in linked_rows
        ):
            raise WorkspaceConflict("map_dataset_version_invalid")

        # A display cannot authorize a second, raw reference to its source version.
        version_references = [
            reference
            for reference in references
            if reference.dataset_version_id is not None and reference.managed_display_id is None
        ]
        if version_references:
            requested_versions = sorted(
                {
                    (
                        str(reference.dataset_id),
                        str(reference.dataset_version_id),
                        cast(int, reference.dataset_version_number),
                    )
                    for reference in version_references
                }
            )
            version_rows = await transaction.fetch_all(
                # Exact versions are read-only to the runtime role. A locking
                # SELECT would require UPDATE authority on dataset_versions.
                # Retain the project-link lock above; validate the pinned
                # version's tenant, dataset, number and active state by reading.
                """
                SELECT requested.dataset_id, requested.dataset_version_id,
                       requested.dataset_version_number
                FROM jsonb_to_recordset(%s::jsonb)
                  AS requested(dataset_id uuid, dataset_version_id uuid,
                               dataset_version_number bigint)
                JOIN app.dataset_versions version
                  ON version.organization_id = %s
                 AND version.dataset_id = requested.dataset_id
                 AND version.id = requested.dataset_version_id
                 AND version.version_number = requested.dataset_version_number
                 AND version.state = 'active'::app.dataset_version_state
                ORDER BY requested.dataset_id, requested.dataset_version_id
                """,
                (
                    Jsonb(
                        [
                            {
                                "dataset_id": dataset_id,
                                "dataset_version_id": dataset_version_id,
                                "dataset_version_number": dataset_version_number,
                            }
                            for dataset_id, dataset_version_id, dataset_version_number in (
                                requested_versions
                            )
                        ]
                    ),
                    context.organization_id,
                ),
            )
            found_versions = {(str(row[0]), str(row[1]), int(row[2])) for row in version_rows}
            if found_versions != set(requested_versions):
                raise WorkspaceConflict("map_dataset_version_invalid")

        requested_displays = sorted(
            {
                (
                    str(reference.dataset_id),
                    str(reference.dataset_version_id),
                    cast(int, reference.dataset_version_number),
                    str(reference.managed_display_id),
                )
                for reference in references
                if reference.managed_display_id is not None
            }
        )
        if requested_displays:
            # One bounded metadata read for every unique display reference. It
            # issues no storage tickets and carries no consent into the map.
            # Legacy active displays retain their admission behavior. An
            # uninspected original requires its exact reviewed v2 derivative.
            display_rows = await transaction.fetch_all(
                """
                SELECT requested.dataset_id, requested.dataset_version_id,
                       requested.dataset_version_number, requested.managed_display_id,
                       membership.role::text,
                       app.effective_project_role(project.id, membership.user_id)::text,
                       permission.role::text, dataset.owner_user_id = membership.user_id
                FROM jsonb_to_recordset(%s::jsonb)
                  AS requested(dataset_id uuid, dataset_version_id uuid,
                               dataset_version_number bigint, managed_display_id uuid)
                JOIN app.layer_archive_distributions display
                  ON display.organization_id = %s AND display.project_id = %s
                 AND display.dataset_id = requested.dataset_id
                 AND display.dataset_version_id = requested.dataset_version_id
                 AND display.id = requested.managed_display_id
                 AND display.source_version IS NULL AND display.enabled
                 AND display.descriptor->>'format' = 'pmtiles'
                JOIN app.datasets dataset ON dataset.organization_id = display.organization_id
                 AND dataset.id = display.dataset_id
                JOIN app.projects project ON project.organization_id = display.organization_id
                 AND project.id = display.project_id AND project.status = 'active'
                JOIN app.dataset_versions version
                  ON version.organization_id = display.organization_id
                 AND version.dataset_id = display.dataset_id
                 AND version.id = requested.dataset_version_id
                 AND version.version_number = requested.dataset_version_number
                JOIN app.organization_memberships membership
                  ON membership.organization_id = display.organization_id
                 AND membership.user_id = %s
                LEFT JOIN app.dataset_permissions permission
                  ON permission.organization_id = dataset.organization_id
                 AND permission.dataset_id = dataset.id AND permission.user_id = membership.user_id
                WHERE (dataset.status = 'active' AND version.state = 'active')
                   OR EXISTS (
                    SELECT 1 FROM app.pmtiles_derivative_jobs job
                    JOIN app.dataset_version_derivative_lineage lineage
                      ON lineage.organization_id = job.organization_id
                     AND lineage.dataset_id = job.dataset_id
                     AND lineage.dataset_version_id = job.dataset_version_id
                     AND lineage.pmtiles_job_id = job.id
                     AND lineage.source_object_id = job.source_object_id
                     AND lineage.output_object_id = job.output_object_id
                     AND lineage.recipe = 'gdal-pmtiles-v2'
                    JOIN app.pmtiles_display_validations validation
                      ON validation.organization_id = job.organization_id
                     AND validation.project_id = job.project_id
                     AND validation.dataset_id = job.dataset_id
                     AND validation.dataset_version_id = job.dataset_version_id
                     AND validation.pmtiles_job_id = job.id
                     AND validation.output_object_id = job.output_object_id
                    JOIN app.data_objects original
                      ON original.organization_id = job.organization_id
                     AND original.dataset_id = job.dataset_id
                     AND original.id = job.source_object_id
                     AND original.checksum_sha256 = validation.validation->>'source_checksum_sha256'
                     AND original.s3_version_id = validation.validation->>'source_s3_version_id'
                    JOIN app.data_objects output
                      ON output.organization_id = job.organization_id
                     AND output.dataset_id = job.dataset_id AND output.id = job.output_object_id
                     AND output.checksum_sha256 = job.output_checksum_sha256
                     AND output.size_bytes = job.output_size_bytes
                    WHERE job.organization_id = display.organization_id
                      AND job.project_id = display.project_id
                      AND job.dataset_id = display.dataset_id
                      AND job.dataset_version_id = version.id AND job.id = display.pmtiles_job_id
                      AND display.id = job.id AND job.state = 'completed'
                      AND job.conversion_options IS NOT NULL
                      AND app.pmtiles_preserved_original_eligible(job.organization_id,
                        job.project_id, job.dataset_id,
                        job.dataset_version_id, job.source_object_id)
                      AND display.descriptor->'provenance' @> jsonb_build_object(
                        'pmtiles_job_id', job.id, 'recipe', 'gdal-pmtiles-v2',
                        'source_object_id', job.source_object_id,
                        'output_object_id', job.output_object_id,
                        'request_checksum_sha256', job.request_checksum_sha256,
                        'review_sha256', validation.review_sha256)
                      AND jsonb_array_length(display.descriptor->'objects') = 1
                      AND display.descriptor->'objects'->0 @> jsonb_build_object(
                        'bucket', output.bucket, 'key', output.object_key,
                        'version_id', output.s3_version_id, 'size_bytes', output.size_bytes,
                        'sha256', output.checksum_sha256)
                      AND display.descriptor->'tile_layers' = validation.validation->'tile_layers'
                      AND display.descriptor->'min_zoom' = validation.validation->'min_zoom'
                      AND display.descriptor->'max_zoom' = validation.validation->'max_zoom'
                   )
                ORDER BY requested.dataset_id, requested.dataset_version_id,
                         requested.managed_display_id
                """,
                (
                    Jsonb(
                        [
                            {
                                "dataset_id": dataset_id,
                                "dataset_version_id": version_id,
                                "dataset_version_number": version_number,
                                "managed_display_id": display_id,
                            }
                            for dataset_id, version_id, version_number, display_id in (
                                requested_displays
                            )
                        ]
                    ),
                    context.organization_id,
                    project_id,
                    context.user_id,
                ),
            )
            found_displays = set()
            for row in display_rows:
                roles = Roles(
                    organization=cast(OrganizationRole, row[4]),
                    project=cast(ProjectRole | None, row[5]),
                    dataset=cast(DatasetPermissionRole | None, row[6]),
                    dataset_owner=cast(bool, row[7]),
                )
                if not is_allowed(Action.DATASET_VERSION_READ, roles):
                    raise WorkspaceConflict("map_managed_display_unavailable")
                found_displays.add((str(row[0]), str(row[1]), int(row[2]), str(row[3])))
            if found_displays != set(requested_displays):
                raise WorkspaceConflict("map_managed_display_unavailable")

        snapshots = [reference for reference in references if reference.source_type is not None]
        if not snapshots:
            return
        requested_snapshots = sorted(
            {
                (str(reference.dataset_id), cast(int, reference.source_version))
                for reference in snapshots
            }
        )
        source_rows = await transaction.fetch_all(
            """
            SELECT requested.dataset_id, requested.source_version,
                   source.source_type::text, revision.source_url, revision.configuration
            FROM jsonb_to_recordset(%s::jsonb)
              AS requested(dataset_id uuid, source_version bigint)
            JOIN app.external_sources source
              ON source.organization_id = %s
             AND source.dataset_id = requested.dataset_id
            JOIN app.external_source_revisions revision
              ON revision.organization_id = source.organization_id
             AND revision.dataset_id = source.dataset_id
             AND revision.version_number = requested.source_version
            ORDER BY requested.dataset_id, requested.source_version
            """,
            (
                Jsonb(
                    [
                        {"dataset_id": dataset_id, "source_version": source_version}
                        for dataset_id, source_version in requested_snapshots
                    ]
                ),
                context.organization_id,
            ),
        )
        source_records = {
            (str(row[0]), int(row[1])): (
                str(row[2]),
                str(row[3]),
                external_map_configuration(str(row[2]), cast(dict[str, Any], row[4])),
            )
            for row in source_rows
        }
        if set(source_records) != set(requested_snapshots):
            raise WorkspaceConflict("map_source_revision_invalid")
        for reference in snapshots:
            key = (str(reference.dataset_id), cast(int, reference.source_version))
            source_type, source_url, source_configuration = source_records[key]
            if (
                source_type != reference.source_type
                or source_url != reference.source_url
                or source_configuration != reference.source_configuration
            ):
                raise WorkspaceConflict("map_source_revision_invalid")

    async def _organization_role(
        self, transaction: TenantTransaction, context: TenantContext
    ) -> OrganizationRole:
        row = await transaction.fetch_one(
            """
            SELECT role::text
            FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if row is None:
            raise WorkspaceAccessDenied("organization membership no longer exists")
        try:
            role = str(row[0])
        except (IndexError, TypeError) as error:
            raise WorkspaceStoreUnavailable("invalid organization membership row") from error
        if role not in {"admin", "member", "guest"}:
            raise WorkspaceStoreUnavailable("invalid organization membership role")
        return cast(OrganizationRole, role)

    async def _roles_for_project(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
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
            raise WorkspaceNotFound("project")
        project_role = self._optional_project_role(row)
        return Roles(organization_role, project_role)

    async def _load_client(
        self, transaction: TenantTransaction, context: TenantContext, client_id: UUID
    ) -> Client:
        row = await transaction.fetch_one(
            f"""{self._client_select()}
            WHERE organization_id = %s AND id = %s
            """,
            (context.organization_id, client_id),
        )
        if row is None:
            raise WorkspaceNotFound("client")
        return self._client(row)

    async def _load_project(
        self, transaction: TenantTransaction, context: TenantContext, project_id: UUID
    ) -> Project:
        row = await transaction.fetch_one(
            f"""{self._project_select()}
            WHERE project.organization_id = %s AND project.id = %s
            """,
            (context.organization_id, project_id),
        )
        if row is None:
            raise WorkspaceNotFound("project")
        return self._project(row)

    async def _load_map(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        *,
        include_owner: bool = False,
    ) -> MapRecord:
        row = await transaction.fetch_one(
            f"""{self._map_select(include_owner=include_owner)}
            WHERE organization_id = %s AND project_id = %s AND id = %s
            """,
            (context.organization_id, project_id, map_id),
        )
        if row is None:
            raise WorkspaceNotFound("map")
        definition = await self._load_map_definition(
            transaction,
            context,
            project_id,
            map_id,
            self._map_definition_size(row),
        )
        return self._map(row, definition, owner_user_id=row[9] if include_owner else None)

    async def _map_required_with_definition(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        row: tuple[Any, ...] | None,
    ) -> MapRecord:
        if row is None:
            raise WorkspaceStoreUnavailable("map write returned no row")
        map_id = self._map_id(row)
        definition = await self._load_map_definition(
            transaction,
            context,
            project_id,
            map_id,
            self._map_definition_size(row),
        )
        return self._map(row, definition)

    async def _load_map_definition(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        map_id: UUID,
        definition_bytes: int,
    ) -> dict[str, Any]:
        definitions = await self._load_map_definition_batch(
            transaction,
            context,
            project_id,
            {map_id: definition_bytes},
        )
        return definitions[map_id]

    async def _load_map_definitions(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        metadata_rows: list[tuple[Any, ...]],
    ) -> dict[UUID, dict[str, Any]]:
        definitions: dict[UUID, dict[str, Any]] = {}
        batch: dict[UUID, int] = {}
        batch_bytes = 0
        for row in metadata_rows:
            map_id = self._map_id(row)
            definition_bytes = self._map_definition_size(row)
            if map_id in definitions or map_id in batch:
                raise WorkspaceStoreUnavailable("duplicate map metadata row")
            if batch and batch_bytes + definition_bytes > _MAP_DEFINITION_BATCH_BYTES:
                definitions.update(
                    await self._load_map_definition_batch(
                        transaction,
                        context,
                        project_id,
                        batch,
                    )
                )
                batch = {}
                batch_bytes = 0
            batch[map_id] = definition_bytes
            batch_bytes += definition_bytes
        if batch:
            definitions.update(
                await self._load_map_definition_batch(
                    transaction,
                    context,
                    project_id,
                    batch,
                )
            )
        return definitions

    async def _load_map_definition_batch(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        expected_sizes: Mapping[UUID, int],
    ) -> dict[UUID, dict[str, Any]]:
        if not expected_sizes:
            return {}
        for definition_bytes in expected_sizes.values():
            self._validate_map_definition_size(definition_bytes)
        rows = await transaction.fetch_all(
            """
            SELECT map.id, chunk.chunk_index,
                   substring(
                     convert_to(map.definition::text, 'UTF8')
                     FROM chunk.chunk_index * %s::integer + 1
                     FOR %s::integer
                   )
            FROM app.maps map
            CROSS JOIN LATERAL generate_series(
              0,
              (octet_length(map.definition::text) - 1) / %s::integer
            ) AS chunk(chunk_index)
            WHERE map.organization_id = %s
              AND map.project_id = %s
              AND map.id IN (
                SELECT value::uuid
                FROM jsonb_array_elements_text(%s::jsonb) requested(value)
              )
            ORDER BY map.id, chunk.chunk_index
            """,
            (
                _MAP_DEFINITION_CHUNK_BYTES,
                _MAP_DEFINITION_CHUNK_BYTES,
                _MAP_DEFINITION_CHUNK_BYTES,
                context.organization_id,
                project_id,
                Jsonb([str(map_id) for map_id in expected_sizes]),
            ),
        )
        grouped: dict[UUID, list[tuple[Any, ...]]] = {map_id: [] for map_id in expected_sizes}
        for row in rows:
            try:
                map_id = UUID(str(row[0]))
                chunk_row = (row[1], row[2])
            except (IndexError, TypeError, ValueError) as error:
                raise WorkspaceStoreUnavailable("map definition chunk row is invalid") from error
            if map_id not in grouped:
                raise WorkspaceStoreUnavailable("map definition chunk scope is invalid")
            grouped[map_id].append(chunk_row)
        return {
            map_id: self._decode_map_definition_chunks(
                chunk_rows,
                expected_sizes[map_id],
            )
            for map_id, chunk_rows in grouped.items()
        }

    @staticmethod
    def _decode_map_definition_chunks(
        rows: list[tuple[Any, ...]],
        definition_bytes: int,
    ) -> dict[str, Any]:
        PostgresWorkspaceRepository._validate_map_definition_size(definition_bytes)
        chunk_count = (definition_bytes + _MAP_DEFINITION_CHUNK_BYTES - 1) // (
            _MAP_DEFINITION_CHUNK_BYTES
        )
        if len(rows) != chunk_count:
            raise WorkspaceStoreUnavailable("map definition chunks are incomplete")

        chunks: list[bytes] = []
        for expected_index, row in enumerate(rows):
            try:
                chunk_index = int(row[0])
                value = row[1]
            except (IndexError, TypeError, ValueError) as error:
                raise WorkspaceStoreUnavailable("map definition chunk row is invalid") from error
            if chunk_index != expected_index or not isinstance(
                value, bytes | bytearray | memoryview
            ):
                raise WorkspaceStoreUnavailable("map definition chunk row is invalid")
            chunk = bytes(value)
            if not chunk or len(chunk) > _MAP_DEFINITION_CHUNK_BYTES:
                raise WorkspaceStoreUnavailable("map definition chunk size is invalid")
            if expected_index < chunk_count - 1 and len(chunk) != _MAP_DEFINITION_CHUNK_BYTES:
                raise WorkspaceStoreUnavailable("map definition chunks are incomplete")
            chunks.append(chunk)

        encoded = b"".join(chunks)
        if len(encoded) != definition_bytes:
            raise WorkspaceStoreUnavailable("map definition storage size changed")
        try:
            definition = json.loads(encoded.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("map definition storage is invalid") from error
        if not isinstance(definition, dict):
            raise WorkspaceStoreUnavailable("map definition storage is invalid")
        return cast(dict[str, Any], definition)

    @staticmethod
    def _validate_map_definition_size(definition_bytes: int) -> None:
        if definition_bytes < 2 or definition_bytes > _MAX_STORED_MAP_DEFINITION_BYTES:
            raise WorkspaceStoreUnavailable("map definition storage size is invalid")

    async def _record_map_version(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        map_record: MapRecord,
        change_message: str | None,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.map_versions
              (organization_id, map_id, version, definition, change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                map_record.map_id,
                map_record.version,
                Jsonb(map_record.definition),
                change_message,
                context.user_id,
            ),
        )

    async def _record_event(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        project_id: UUID | None,
        payload: Mapping[str, Any],
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
                Jsonb(dict(payload)),
            ),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise WorkspaceAccessDenied(action) from error

    @staticmethod
    def _require_hidden(action: Action, roles: Roles, resource: str) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise WorkspaceNotFound(resource) from error

    @staticmethod
    def _assignments(
        changes: Mapping[str, Any],
        allowed: Mapping[str, str],
        *,
        json_fields: set[str] | None = None,
        field_casts: Mapping[str, str] | None = None,
    ) -> tuple[list[str], list[Any]]:
        assignments: list[str] = []
        values: list[Any] = []
        for field, value in changes.items():
            column = allowed.get(field)
            if column is None:
                raise WorkspaceStoreUnavailable("unsupported update field")
            # Data API string bindings are typed text, unlike native unknown
            # parameters. Enum assignments require a trusted SQL-side cast.
            field_type = field_casts.get(field) if field_casts else None
            parameter = f"CAST(%s AS {field_type})" if field_type else "%s"
            assignments.append(f"{column} = {parameter}")
            values.append(Jsonb(value) if json_fields and field in json_fields else value)
        if not assignments:
            raise WorkspaceConflict("empty_update")
        return assignments, values

    @staticmethod
    def _client_select() -> str:
        return """
        SELECT id, name, client_code, description, status::text, created_at, updated_at
        FROM app.clients
        """

    @staticmethod
    def _project_select() -> str:
        return """
        SELECT project.id, project.client_id, project.name, project.project_code,
               project.description, project.status::text, project.created_at,
               project.updated_at,
               app.effective_project_role(project.id)::text AS caller_role,
               project.visibility::text, project.published_at, project.published_by
        FROM app.projects project
        """

    @staticmethod
    def _map_select(*, include_owner: bool = False) -> str:
        # Only the exact canonical governed map resource establishes ownership.
        # A composition without that binding has no authoritative owner here.
        owner_select = ""
        if include_owner:
            owner_select = """
               , (SELECT resource.owner_user_id FROM app.governed_resources resource
                  WHERE resource.organization_id = app.maps.organization_id
                    AND resource.project_id = app.maps.project_id
                    AND resource.map_id = app.maps.id AND resource.kind = 'map')
            """
        return f"""
        SELECT id, project_id, name, description, status::text,
               octet_length(definition::text), version, created_at, updated_at
               {owner_select}
        FROM app.maps
        """

    @classmethod
    def _organization_member(cls, row: tuple[Any, ...]) -> OrganizationMember:
        try:
            role = str(row[3])
            if role not in {"admin", "member", "guest"}:
                raise ValueError("invalid role")
            return OrganizationMember(
                user_id=UUID(str(row[0])),
                email=str(row[1]),
                display_name=str(row[2]),
                role=cast(OrganizationRole, role),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid organization member row") from error

    @classmethod
    def _client(cls, row: tuple[Any, ...]) -> Client:
        try:
            return Client(
                client_id=UUID(str(row[0])),
                name=str(row[1]),
                client_code=cls._optional_text(row[2]),
                description=cls._optional_text(row[3]),
                status=cls._status(row[4]),
                created_at=cls._datetime(row[5]),
                updated_at=cls._datetime(row[6]),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid client row") from error

    @classmethod
    def _client_required(cls, row: tuple[Any, ...] | None) -> Client:
        if row is None:
            raise WorkspaceStoreUnavailable("client write returned no row")
        return cls._client(row)

    @classmethod
    def _project(cls, row: tuple[Any, ...]) -> Project:
        try:
            return Project(
                project_id=UUID(str(row[0])),
                client_id=UUID(str(row[1])) if row[1] is not None else None,
                name=str(row[2]),
                project_code=cls._optional_text(row[3]),
                description=cls._optional_text(row[4]),
                status=cls._status(row[5]),
                created_at=cls._datetime(row[6]),
                updated_at=cls._datetime(row[7]),
                caller_role=cls._optional_project_role((row[8],) if row[8] is not None else None),
                visibility=cls._project_visibility(row[9]),
                published_at=cls._datetime(row[10]) if row[10] is not None else None,
                published_by=UUID(str(row[11])) if row[11] is not None else None,
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid project row") from error

    @classmethod
    def _project_required(cls, row: tuple[Any, ...] | None) -> Project:
        if row is None:
            raise WorkspaceStoreUnavailable("project write returned no row")
        return cls._project(row)

    @classmethod
    def _recent_project(cls, row: tuple[Any, ...]) -> RecentProject:
        try:
            event_type = str(row[13])
            if not event_type or len(event_type) > 200:
                raise ValueError("invalid event type")
            return RecentProject(
                project=cls._project(row),
                last_activity_at=cls._datetime(row[12]),
                last_event_type=event_type,
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid recent project row") from error

    @classmethod
    def _project_member(cls, row: tuple[Any, ...]) -> ProjectMember:
        try:
            role = cls._project_role(row[3])
            return ProjectMember(
                user_id=UUID(str(row[0])),
                email=str(row[1]),
                display_name=str(row[2]),
                role=role,
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid project member row") from error

    @classmethod
    def _map(
        cls,
        row: tuple[Any, ...],
        definition: dict[str, Any],
        *,
        owner_user_id: UUID | None = None,
    ) -> MapRecord:
        try:
            version = int(row[6])
            if version < 1:
                raise ValueError("version must be positive")
            return MapRecord(
                map_id=UUID(str(row[0])),
                project_id=UUID(str(row[1])),
                name=str(row[2]),
                description=cls._optional_text(row[3]),
                status=cls._status(row[4]),
                definition=definition,
                version=version,
                created_at=cls._datetime(row[7]),
                updated_at=cls._datetime(row[8]),
                owner_user_id=UUID(str(owner_user_id)) if owner_user_id is not None else None,
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid map row") from error

    @staticmethod
    def _map_id(row: tuple[Any, ...]) -> UUID:
        try:
            return UUID(str(row[0]))
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid map row") from error

    @classmethod
    def _map_version_summary(cls, row: tuple[Any, ...]) -> MapVersionSummary:
        try:
            version = int(row[0])
            definition_bytes = int(row[1])
            if version < 1:
                raise ValueError("invalid map version")
            cls._validate_map_definition_size(definition_bytes)
            return MapVersionSummary(
                version=version,
                definition_bytes=definition_bytes,
                change_message=cls._optional_text(row[2]),
                created_by=UUID(str(row[3])),
                created_at=cls._datetime(row[4]),
            )
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid map version row") from error

    @staticmethod
    def _map_definition_size(row: tuple[Any, ...]) -> int:
        try:
            definition_bytes = int(row[5])
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid map row") from error
        PostgresWorkspaceRepository._validate_map_definition_size(definition_bytes)
        return definition_bytes

    @staticmethod
    def _status(value: Any) -> RecordStatus:
        status = str(value)
        if status not in {"active", "archived"}:
            raise ValueError("invalid status")
        return cast(RecordStatus, status)

    @staticmethod
    def _project_role(value: Any) -> ProjectRole:
        role = str(value)
        if role not in {"owner", "editor", "reviewer", "viewer"}:
            raise ValueError("invalid project role")
        return cast(ProjectRole, role)

    @staticmethod
    def _project_visibility(value: Any) -> ProjectVisibility:
        visibility = str(value)
        if visibility not in {"internal", "published"}:
            raise ValueError("invalid project visibility")
        return cast(ProjectVisibility, visibility)

    @classmethod
    def _optional_project_role(cls, row: tuple[Any, ...] | None) -> ProjectRole | None:
        if row is None:
            return None
        try:
            if row[0] is None:
                return None
            return cls._project_role(row[0])
        except (IndexError, TypeError, ValueError) as error:
            raise WorkspaceStoreUnavailable("invalid project membership row") from error

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        return None if value is None else str(value)

    @staticmethod
    def _datetime(value: Any) -> datetime:
        if not isinstance(value, datetime):
            raise ValueError("invalid timestamp")
        return value
