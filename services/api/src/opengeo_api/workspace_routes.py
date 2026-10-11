import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from opengeo_api.auth_models import AuthSession, OrganizationRole
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.logging import get_request_id
from opengeo_api.map_definitions import (
    MAP_DEFINITION_SCHEMA_VERSION,
    validate_map_definition,
)
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspaces import (
    Client,
    ClientDraft,
    MapDraft,
    MapRecord,
    MapVersionRecord,
    MapVersionSummary,
    Page,
    PostgresWorkspaceRepository,
    Project,
    ProjectDraft,
    ProjectRole,
    RecentProject,
    RecordStatus,
    WorkspaceAccessDenied,
    WorkspaceConflict,
    WorkspaceNotFound,
    WorkspaceRepository,
    WorkspaceStoreUnavailable,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["workspace"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Code = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000),
]
ChangeMessage = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OrganizationMemberResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    role: OrganizationRole


class ClientResponse(BaseModel):
    id: UUID
    name: str
    client_code: str | None
    description: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class CreateClientRequest(RequestModel):
    name: Name
    client_code: Code | None = None
    description: Description | None = None


class UpdateClientRequest(RequestModel):
    name: Name | None = None
    client_code: Code | None = None
    description: Description | None = None
    status: RecordStatus | None = None

    @model_validator(mode="after")
    def require_change(self) -> "UpdateClientRequest":
        if not self.model_fields_set:
            raise ValueError("at least one client field is required")
        return self


class ProjectResponse(BaseModel):
    id: UUID
    client_id: UUID | None
    name: str
    project_code: str | None
    description: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime
    caller_role: ProjectRole | None
    visibility: Literal["internal", "published"]
    published_at: datetime | None
    published_by: UUID | None


class RecentProjectResponse(ProjectResponse):
    last_activity_at: datetime
    last_event_type: Code


class CreateProjectRequest(RequestModel):
    client_id: UUID | None = None
    name: Name
    project_code: Code | None = None
    description: Description | None = None


class UpdateProjectRequest(RequestModel):
    name: Name | None = None
    project_code: Code | None = None
    description: Description | None = None
    status: RecordStatus | None = None
    visibility: Literal["internal", "published"] | None = None

    @model_validator(mode="after")
    def require_change(self) -> "UpdateProjectRequest":
        if not self.model_fields_set:
            raise ValueError("at least one project field is required")
        return self


class ProjectMemberResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    role: ProjectRole


class MapResponse(BaseModel):
    id: UUID
    project_id: UUID
    name: str
    description: str | None
    status: RecordStatus
    definition: dict[str, Any]
    version: int
    created_at: datetime
    updated_at: datetime


class CompositionSummaryResponse(BaseModel):
    id: UUID
    resource_type: Literal["project"] = "project"
    access_container_id: UUID
    access_container_name: str
    name: str
    description: str | None
    status: RecordStatus
    version: int
    updated_at: datetime
    owner_user_id: UUID | None = None


class CompositionResponse(BaseModel):
    id: UUID
    resource_type: Literal["project"] = "project"
    access_container_id: UUID
    name: str
    description: str | None
    status: RecordStatus
    definition: dict[str, Any]
    version: int
    created_at: datetime
    updated_at: datetime
    owner_user_id: UUID | None = None


class CompositionVersionSummaryResponse(BaseModel):
    version: int
    definition_bytes: int
    change_message: str | None
    created_by: UUID
    created_at: datetime


class CompositionVersionResponse(CompositionVersionSummaryResponse):
    definition: dict[str, Any]


def validate_definition(definition: dict[str, Any]) -> dict[str, Any]:
    return validate_map_definition(definition, require_current=True)


class CreateMapRequest(RequestModel):
    creation_key: UUID | None = None
    name: Name
    description: Description | None = None
    definition: dict[str, Any] = Field(
        default_factory=lambda: {
            "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
            "mapViews": [],
            "basemaps": [],
            "bookmarks": [],
            "activeLayerId": None,
            "activeProcessingModelId": None,
            "models": [],
            "processingHistory": [],
            "projection": "mercator",
            "colorMode": "dark",
            "layers": [],
        }
    )

    @model_validator(mode="after")
    def check_definition(self) -> "CreateMapRequest":
        validate_definition(self.definition)
        return self


class UpdateMapRequest(RequestModel):
    expected_version: int = Field(ge=1)
    name: Name | None = None
    description: Description | None = None
    status: RecordStatus | None = None
    definition: dict[str, Any] | None = None
    change_message: ChangeMessage | None = None

    @model_validator(mode="after")
    def require_and_check_change(self) -> "UpdateMapRequest":
        changed = self.model_fields_set - {"expected_version", "change_message"}
        if not changed:
            raise ValueError("at least one map field is required")
        if self.definition is not None:
            validate_definition(self.definition)
        return self


class DuplicateMapRequest(RequestModel):
    name: Name | None = None


def repository_from_request(request: Request) -> WorkspaceRepository:
    repository = request.app.state.workspace_repository
    if not isinstance(repository, PostgresWorkspaceRepository):
        return cast(WorkspaceRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(
        user_id=session.principal.user_id,
        organization_id=membership.organization_id,
    )


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit=limit, offset=offset)


PageDependency = Annotated[Page, Depends(page_parameters)]


async def execute_workspace[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except WorkspaceAccessDenied as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="action_forbidden",
        ) from error
    except WorkspaceNotFound as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{error.resource}_not_found",
        ) from error
    except WorkspaceConflict as error:
        detail: dict[str, str | int] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from error
    except WorkspaceStoreUnavailable as error:
        logger.error("workspace.unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="workspace_store_unavailable",
        ) from error


def client_response(client: Client) -> ClientResponse:
    return ClientResponse(
        id=client.client_id,
        name=client.name,
        client_code=client.client_code,
        description=client.description,
        status=client.status,
        created_at=client.created_at,
        updated_at=client.updated_at,
    )


def project_response(project: Project) -> ProjectResponse:
    return ProjectResponse(
        id=project.project_id,
        client_id=project.client_id,
        name=project.name,
        project_code=project.project_code,
        description=project.description,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
        caller_role=project.caller_role,
        visibility=project.visibility,
        published_at=project.published_at,
        published_by=project.published_by,
    )


def recent_project_response(recent: RecentProject) -> RecentProjectResponse:
    project = project_response(recent.project)
    return RecentProjectResponse(
        **project.model_dump(),
        last_activity_at=recent.last_activity_at,
        last_event_type=recent.last_event_type,
    )


def map_response(map_record: MapRecord) -> MapResponse:
    return MapResponse(
        id=map_record.map_id,
        project_id=map_record.project_id,
        name=map_record.name,
        description=map_record.description,
        status=map_record.status,
        definition=map_record.definition,
        version=map_record.version,
        created_at=map_record.created_at,
        updated_at=map_record.updated_at,
    )


def composition_version_summary_response(
    summary: MapVersionSummary,
) -> CompositionVersionSummaryResponse:
    return CompositionVersionSummaryResponse(
        version=summary.version,
        definition_bytes=summary.definition_bytes,
        change_message=summary.change_message,
        created_by=summary.created_by,
        created_at=summary.created_at,
    )


def composition_version_response(record: MapVersionRecord) -> CompositionVersionResponse:
    return CompositionVersionResponse(
        **composition_version_summary_response(record.summary).model_dump(),
        definition=record.definition,
    )


@router.get(
    "/organizations/current/memberships",
    response_model=list[OrganizationMemberResponse],
)
async def organization_memberships(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[OrganizationMemberResponse]:
    records = await execute_workspace(
        repository.list_organization_members(tenant_context(session), page)
    )
    return [
        OrganizationMemberResponse(
            user_id=record.user_id,
            email=record.email,
            display_name=record.display_name,
            role=record.role,
        )
        for record in records
    ]


@router.get("/clients", response_model=list[ClientResponse])
async def clients(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[ClientResponse]:
    records = await execute_workspace(repository.list_clients(tenant_context(session), page))
    return [client_response(record) for record in records]


@router.post("/clients", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
async def create_client(
    payload: CreateClientRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ClientResponse:
    record = await execute_workspace(
        repository.create_client(
            tenant_context(session),
            ClientDraft(
                name=payload.name,
                client_code=payload.client_code,
                description=payload.description,
            ),
            get_request_id(),
        )
    )
    return client_response(record)


@router.get("/clients/{client_id}", response_model=ClientResponse)
async def get_client(
    client_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ClientResponse:
    record = await execute_workspace(repository.get_client(tenant_context(session), client_id))
    return client_response(record)


@router.patch("/clients/{client_id}", response_model=ClientResponse)
async def update_client(
    client_id: UUID,
    payload: UpdateClientRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ClientResponse:
    record = await execute_workspace(
        repository.update_client(
            tenant_context(session),
            client_id,
            payload.model_dump(exclude_unset=True),
            get_request_id(),
        )
    )
    return client_response(record)


@router.get("/projects", response_model=list[ProjectResponse])
async def projects(
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
    client_id: Annotated[UUID | None, Query()] = None,
    q: str = Query(default="", max_length=200),
    status: Literal["active", "archived", "all"] = "all",
) -> list[ProjectResponse]:
    query = q.strip()
    if query or status != "all":
        operation = repository.list_projects(
            tenant_context(session), client_id, page, query, None if status == "all" else status
        )
    else:
        operation = repository.list_projects(tenant_context(session), client_id, page)
    records = await execute_workspace(operation)
    response.headers["Cache-Control"] = "no-store"
    return [project_response(record) for record in records]


@router.post("/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: CreateProjectRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ProjectResponse:
    record = await execute_workspace(
        repository.create_project(
            tenant_context(session),
            ProjectDraft(
                client_id=payload.client_id,
                name=payload.name,
                project_code=payload.project_code,
                description=payload.description,
            ),
            get_request_id(),
        )
    )
    return project_response(record)


@router.get("/projects/recent", response_model=list[RecentProjectResponse])
async def recent_projects(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[RecentProjectResponse]:
    records = await execute_workspace(
        repository.list_recent_projects(tenant_context(session), page)
    )
    return [recent_project_response(record) for record in records]


@router.get("/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ProjectResponse:
    record = await execute_workspace(repository.get_project(tenant_context(session), project_id))
    return project_response(record)


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: UUID,
    payload: UpdateProjectRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> ProjectResponse:
    record = await execute_workspace(
        repository.update_project(
            tenant_context(session),
            project_id,
            payload.model_dump(exclude_unset=True),
            get_request_id(),
        )
    )
    return project_response(record)


@router.get(
    "/projects/{project_id}/memberships",
    response_model=list[ProjectMemberResponse],
)
async def project_memberships(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[ProjectMemberResponse]:
    records = await execute_workspace(
        repository.list_project_members(tenant_context(session), project_id, page)
    )
    return [
        ProjectMemberResponse(
            user_id=record.user_id,
            email=record.email,
            display_name=record.display_name,
            role=record.role,
        )
        for record in records
    ]


@router.get("/projects/{project_id}/maps", response_model=list[MapResponse])
async def maps(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
) -> list[MapResponse]:
    records = await execute_workspace(
        repository.list_maps(tenant_context(session), project_id, page)
    )
    return [map_response(record) for record in records]


@router.post(
    "/projects/{project_id}/maps",
    response_model=MapResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_map(
    project_id: UUID,
    payload: CreateMapRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> MapResponse:
    record = await execute_workspace(
        repository.create_map(
            tenant_context(session),
            project_id,
            MapDraft(
                name=payload.name,
                description=payload.description,
                definition=payload.definition,
                creation_key=payload.creation_key,
            ),
            get_request_id(),
        )
    )
    return map_response(record)


@router.get("/compositions", response_model=list[CompositionSummaryResponse])
async def list_compositions(
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    page: PageDependency,
    q: str = Query(default="", max_length=200),
    status: Literal["active", "archived", "all"] = "active",
) -> list[CompositionSummaryResponse]:
    records = await execute_workspace(
        repository.list_compositions(
            tenant_context(session), page, q.strip(), None if status == "all" else status
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return [
        CompositionSummaryResponse(
            id=record.composition_id,
            access_container_id=record.access_container_id,
            access_container_name=record.access_container_name,
            name=record.name,
            description=record.description,
            status=record.status,
            version=record.version,
            updated_at=record.updated_at,
            owner_user_id=record.owner_user_id,
        )
        for record in records
    ]


@router.get("/compositions/{composition_id}", response_model=CompositionResponse)
async def get_composition(
    composition_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> CompositionResponse:
    record = await execute_workspace(
        repository.get_composition(tenant_context(session), composition_id)
    )
    response.headers["Cache-Control"] = "no-store"
    fields = map_response(record).model_dump(exclude={"project_id"})
    return CompositionResponse(
        **fields, access_container_id=record.project_id, owner_user_id=record.owner_user_id
    )


@router.get(
    "/compositions/{composition_id}/versions",
    response_model=list[CompositionVersionSummaryResponse],
)
async def list_composition_versions(
    composition_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    before_version: Annotated[int | None, Query(ge=1)] = None,
) -> list[CompositionVersionSummaryResponse]:
    records = await execute_workspace(
        repository.list_composition_versions(
            tenant_context(session), composition_id, limit, before_version
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return [composition_version_summary_response(record) for record in records]


@router.get(
    "/compositions/{composition_id}/versions/{version}",
    response_model=CompositionVersionResponse,
)
async def get_composition_version(
    composition_id: UUID,
    version: Annotated[int, Path(ge=1)],
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> CompositionVersionResponse:
    record = await execute_workspace(
        repository.get_composition_version(tenant_context(session), composition_id, version)
    )
    response.headers["Cache-Control"] = "no-store"
    return composition_version_response(record)


@router.get("/projects/{project_id}/maps/{map_id}", response_model=MapResponse)
async def get_map(
    project_id: UUID,
    map_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> MapResponse:
    record = await execute_workspace(
        repository.get_map(tenant_context(session), project_id, map_id)
    )
    return map_response(record)


@router.patch("/projects/{project_id}/maps/{map_id}", response_model=MapResponse)
async def update_map(
    project_id: UUID,
    map_id: UUID,
    payload: UpdateMapRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> MapResponse:
    changes = payload.model_dump(
        exclude_unset=True,
        exclude={"expected_version", "change_message"},
    )
    record = await execute_workspace(
        repository.update_map(
            tenant_context(session),
            project_id,
            map_id,
            payload.expected_version,
            changes,
            payload.change_message,
            get_request_id(),
        )
    )
    return map_response(record)


@router.post(
    "/projects/{project_id}/maps/{map_id}/duplicate",
    response_model=MapResponse,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_map(
    project_id: UUID,
    map_id: UUID,
    payload: DuplicateMapRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
) -> MapResponse:
    record = await execute_workspace(
        repository.duplicate_map(
            tenant_context(session),
            project_id,
            map_id,
            payload.name,
            get_request_id(),
        )
    )
    return map_response(record)
