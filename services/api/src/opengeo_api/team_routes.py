import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, StringConstraints

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.authorization import ProjectRole, TeamRole
from opengeo_api.logging import get_request_id
from opengeo_api.teams import (
    ProjectTeamGrant,
    Team,
    TeamAccessDenied,
    TeamConflict,
    TeamMember,
    TeamNotFound,
    TeamRepository,
    TeamStoreUnavailable,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Teams"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateTeamRequest(RequestModel):
    name: Name
    description: Description | None = None


class TeamMemberRequest(RequestModel):
    user_id: UUID
    role: TeamRole


class TeamMemberUpdate(RequestModel):
    role: TeamRole


class ProjectTeamGrantRequest(RequestModel):
    team_id: UUID
    role: ProjectRole


class ProjectTeamGrantUpdate(RequestModel):
    role: ProjectRole


class TeamResponse(BaseModel):
    id: UUID
    name: str
    description: str | None
    status: str
    caller_role: TeamRole | None
    created_at: datetime
    updated_at: datetime


class TeamMemberResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    role: TeamRole
    created_at: datetime
    updated_at: datetime


class ProjectTeamGrantResponse(BaseModel):
    id: UUID
    project_id: UUID
    team_id: UUID
    team_name: str
    role: ProjectRole
    created_at: datetime
    updated_at: datetime


def repository_from_request(request: Request) -> TeamRepository:
    return cast(TeamRepository, request.app.state.team_repository)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_team[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except TeamAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except TeamNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except TeamConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except TeamStoreUnavailable as error:
        logger.error("team.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="team_store_unavailable") from error


@router.get("/teams", response_model=list[TeamResponse])
async def teams(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> list[TeamResponse]:
    records = await execute_team(repository.list_teams(tenant_context(session)))
    return [team_response(record) for record in records]


@router.post("/teams", response_model=TeamResponse, status_code=status.HTTP_201_CREATED)
async def create_team(
    payload: CreateTeamRequest,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> TeamResponse:
    record = await execute_team(
        repository.create_team(
            tenant_context(session), payload.name, payload.description, get_request_id()
        )
    )
    return team_response(record)


@router.get("/teams/{team_id}/members", response_model=list[TeamMemberResponse])
async def team_members(
    team_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> list[TeamMemberResponse]:
    records = await execute_team(repository.list_members(tenant_context(session), team_id))
    return [member_response(record) for record in records]


@router.post(
    "/teams/{team_id}/members",
    response_model=TeamMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_team_member(
    team_id: UUID,
    payload: TeamMemberRequest,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> TeamMemberResponse:
    record = await execute_team(
        repository.add_member(
            tenant_context(session),
            team_id,
            payload.user_id,
            payload.role,
            get_request_id(),
        )
    )
    return member_response(record)


@router.patch("/teams/{team_id}/members/{user_id}", response_model=TeamMemberResponse)
async def update_team_member(
    team_id: UUID,
    user_id: UUID,
    payload: TeamMemberUpdate,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> TeamMemberResponse:
    record = await execute_team(
        repository.update_member(
            tenant_context(session), team_id, user_id, payload.role, get_request_id()
        )
    )
    return member_response(record)


@router.delete("/teams/{team_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_team_member(
    team_id: UUID,
    user_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> Response:
    await execute_team(
        repository.remove_member(tenant_context(session), team_id, user_id, get_request_id())
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/projects/{project_id}/team-grants",
    response_model=list[ProjectTeamGrantResponse],
)
async def project_team_grants(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> list[ProjectTeamGrantResponse]:
    records = await execute_team(
        repository.list_project_grants(tenant_context(session), project_id)
    )
    return [grant_response(record) for record in records]


@router.post(
    "/projects/{project_id}/team-grants",
    response_model=ProjectTeamGrantResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_team_grant(
    project_id: UUID,
    payload: ProjectTeamGrantRequest,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> ProjectTeamGrantResponse:
    record = await execute_team(
        repository.create_project_grant(
            tenant_context(session),
            project_id,
            payload.team_id,
            payload.role,
            get_request_id(),
        )
    )
    return grant_response(record)


@router.patch(
    "/projects/{project_id}/team-grants/{team_id}",
    response_model=ProjectTeamGrantResponse,
)
async def update_project_team_grant(
    project_id: UUID,
    team_id: UUID,
    payload: ProjectTeamGrantUpdate,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> ProjectTeamGrantResponse:
    record = await execute_team(
        repository.update_project_grant(
            tenant_context(session), project_id, team_id, payload.role, get_request_id()
        )
    )
    return grant_response(record)


@router.delete(
    "/projects/{project_id}/team-grants/{team_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_project_team_grant(
    project_id: UUID,
    team_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[TeamRepository, Depends(repository_from_request)],
) -> Response:
    await execute_team(
        repository.remove_project_grant(
            tenant_context(session), project_id, team_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def team_response(record: Team) -> TeamResponse:
    return TeamResponse(
        id=record.team_id,
        name=record.name,
        description=record.description,
        status=record.status,
        caller_role=record.caller_role,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def member_response(record: TeamMember) -> TeamMemberResponse:
    return TeamMemberResponse(
        user_id=record.user_id,
        email=record.email,
        display_name=record.display_name,
        role=record.role,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def grant_response(record: ProjectTeamGrant) -> ProjectTeamGrantResponse:
    return ProjectTeamGrantResponse(
        id=record.grant_id,
        project_id=record.project_id,
        team_id=record.team_id,
        team_name=record.team_name,
        role=record.role,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )
