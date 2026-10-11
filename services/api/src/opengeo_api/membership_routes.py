import logging
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.auth_models import AuthSession, OrganizationRole, Principal
from opengeo_api.auth_routes import current_session, principal_for_token, require_organization
from opengeo_api.cognito_provisioning import (
    IdentityProvisioningConflict,
    IdentityProvisioningUnavailable,
)
from opengeo_api.logging import get_request_id
from opengeo_api.memberships import (
    InvitationDraft,
    InvitationStatus,
    MembershipAcceptance,
    MembershipAccessDenied,
    MembershipConflict,
    MembershipInvitation,
    MembershipNotFound,
    MembershipRepository,
    MembershipStoreUnavailable,
    PendingMembershipInvitation,
    PostgresMembershipRepository,
    ProjectRole,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["membership administration"])

DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]
EmailAddress = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=320,
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    ),
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InvitationResponse(BaseModel):
    id: UUID
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


class CreateInvitationRequest(RequestModel):
    email: EmailAddress
    display_name: DisplayName
    organization_role: OrganizationRole = "member"
    project_id: UUID | None = None
    project_role: ProjectRole | None = None
    expires_in_days: int = Field(default=7, ge=1, le=30)

    @field_validator("email", mode="after")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.lower()

    @model_validator(mode="after")
    def require_complete_project_scope(self) -> "CreateInvitationRequest":
        if (self.project_id is None) != (self.project_role is None):
            raise ValueError("project_id and project_role must be provided together")
        return self


class UpdateOrganizationMemberRequest(RequestModel):
    role: OrganizationRole


class ProjectMembershipRequest(RequestModel):
    user_id: UUID
    role: ProjectRole


class UpdateProjectMemberRequest(RequestModel):
    role: ProjectRole


class MembershipMutationResponse(BaseModel):
    user_id: UUID
    role: str


class AcceptanceResponse(BaseModel):
    invitation_id: UUID
    organization_id: UUID
    project_id: UUID | None
    organization_role: OrganizationRole
    project_role: ProjectRole | None
    accepted_at: datetime


class PendingInvitationResponse(BaseModel):
    invitation_id: UUID
    organization_id: UUID
    organization_name: str
    project_id: UUID | None
    project_name: str | None
    organization_role: OrganizationRole
    project_role: ProjectRole | None
    expires_at: datetime
    created_at: datetime


def repository_from_request(request: Request) -> MembershipRepository:
    repository = request.app.state.membership_repository
    if not isinstance(repository, PostgresMembershipRepository):
        return cast(MembershipRepository, repository)
    return repository


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_membership[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except MembershipAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except MembershipNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except MembershipConflict as error:
        response_status = 410 if error.code == "invitation_expired" else 409
        raise HTTPException(status_code=response_status, detail={"code": error.code}) from error
    except IdentityProvisioningConflict as error:
        raise HTTPException(
            status_code=409,
            detail={"code": "identity_provisioning_conflict"},
        ) from error
    except IdentityProvisioningUnavailable as error:
        logger.error("membership.identity_provisioning_unavailable")
        raise HTTPException(status_code=503, detail="identity_provisioning_unavailable") from error
    except MembershipStoreUnavailable as error:
        logger.error("membership.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="membership_store_unavailable") from error


def invitation_response(invitation: MembershipInvitation) -> InvitationResponse:
    return InvitationResponse(
        id=invitation.invitation_id,
        email=invitation.email,
        display_name=invitation.display_name,
        organization_role=invitation.organization_role,
        project_id=invitation.project_id,
        project_role=invitation.project_role,
        status=invitation.status,
        expires_at=invitation.expires_at,
        accepted_at=invitation.accepted_at,
        revoked_at=invitation.revoked_at,
        created_at=invitation.created_at,
    )


def acceptance_response(acceptance: MembershipAcceptance) -> AcceptanceResponse:
    return AcceptanceResponse(
        invitation_id=acceptance.invitation_id,
        organization_id=acceptance.organization_id,
        project_id=acceptance.project_id,
        organization_role=acceptance.organization_role,
        project_role=acceptance.project_role,
        accepted_at=acceptance.accepted_at,
    )


def pending_invitation_response(
    invitation: PendingMembershipInvitation,
) -> PendingInvitationResponse:
    return PendingInvitationResponse(
        invitation_id=invitation.invitation_id,
        organization_id=invitation.organization_id,
        organization_name=invitation.organization_name,
        project_id=invitation.project_id,
        project_name=invitation.project_name,
        organization_role=invitation.organization_role,
        project_role=invitation.project_role,
        expires_at=invitation.expires_at,
        created_at=invitation.created_at,
    )


@router.get(
    "/auth/invitations",
    response_model=list[PendingInvitationResponse],
)
async def pending_invitations(
    principal: Annotated[Principal, Depends(principal_for_token)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> list[PendingInvitationResponse]:
    invitations = await execute_membership(repository.list_pending_invitations(principal.user_id))
    return [pending_invitation_response(invitation) for invitation in invitations]


@router.get(
    "/organizations/current/invitations",
    response_model=list[InvitationResponse],
)
async def invitations(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> list[InvitationResponse]:
    records = await execute_membership(
        repository.list_invitations(tenant_context(session), limit, offset)
    )
    return [invitation_response(record) for record in records]


@router.post(
    "/organizations/current/invitations",
    response_model=InvitationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_invitation(
    payload: CreateInvitationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> InvitationResponse:
    record = await execute_membership(
        repository.create_invitation(
            tenant_context(session),
            InvitationDraft(
                email=payload.email,
                display_name=payload.display_name,
                organization_role=payload.organization_role,
                project_id=payload.project_id,
                project_role=payload.project_role,
                expires_at=datetime.now(UTC) + timedelta(days=payload.expires_in_days),
            ),
            get_request_id(),
        )
    )
    return invitation_response(record)


@router.delete(
    "/organizations/current/invitations/{invitation_id}",
    response_model=InvitationResponse,
)
async def revoke_invitation(
    invitation_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> InvitationResponse:
    record = await execute_membership(
        repository.revoke_invitation(tenant_context(session), invitation_id, get_request_id())
    )
    return invitation_response(record)


@router.post(
    "/auth/invitations/{invitation_id}/accept",
    response_model=AcceptanceResponse,
)
async def accept_invitation(
    invitation_id: UUID,
    principal: Annotated[Principal, Depends(principal_for_token)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> AcceptanceResponse:
    accepted = await execute_membership(
        repository.accept_invitation(principal.user_id, invitation_id, get_request_id())
    )
    return acceptance_response(accepted)


@router.patch(
    "/organizations/current/memberships/{user_id}",
    response_model=MembershipMutationResponse,
)
async def update_organization_membership(
    user_id: UUID,
    payload: UpdateOrganizationMemberRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> MembershipMutationResponse:
    await execute_membership(
        repository.update_organization_member(
            tenant_context(session), user_id, payload.role, get_request_id()
        )
    )
    return MembershipMutationResponse(user_id=user_id, role=payload.role)


@router.delete(
    "/organizations/current/memberships/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_organization_membership(
    user_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> Response:
    await execute_membership(
        repository.revoke_organization_member(tenant_context(session), user_id, get_request_id())
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/projects/{project_id}/memberships",
    response_model=MembershipMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_membership(
    project_id: UUID,
    payload: ProjectMembershipRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> MembershipMutationResponse:
    await execute_membership(
        repository.create_project_member(
            tenant_context(session),
            project_id,
            payload.user_id,
            payload.role,
            get_request_id(),
        )
    )
    return MembershipMutationResponse(user_id=payload.user_id, role=payload.role)


@router.patch(
    "/projects/{project_id}/memberships/{user_id}",
    response_model=MembershipMutationResponse,
)
async def update_project_membership(
    project_id: UUID,
    user_id: UUID,
    payload: UpdateProjectMemberRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> MembershipMutationResponse:
    await execute_membership(
        repository.update_project_member(
            tenant_context(session), project_id, user_id, payload.role, get_request_id()
        )
    )
    return MembershipMutationResponse(user_id=user_id, role=payload.role)


@router.delete(
    "/projects/{project_id}/memberships/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_project_membership(
    project_id: UUID,
    user_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[MembershipRepository, Depends(repository_from_request)],
) -> Response:
    await execute_membership(
        repository.revoke_project_member(
            tenant_context(session), project_id, user_id, get_request_id()
        )
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
