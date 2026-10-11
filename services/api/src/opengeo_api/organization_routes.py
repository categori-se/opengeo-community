import logging
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from opengeo_api.auth_models import AuthSession, OrganizationRole
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.organizations import (
    OrganizationBackendUnavailable,
    OrganizationRepository,
    OrganizationStatus,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/organizations", tags=["organizations"])


class CurrentOrganizationResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    status: OrganizationStatus
    caller_role: OrganizationRole


def repository_from_request(request: Request) -> OrganizationRepository:
    return cast(OrganizationRepository, request.app.state.organization_repository)


@router.get("/current", response_model=CurrentOrganizationResponse)
async def current_organization(
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[OrganizationRepository, Depends(repository_from_request)],
) -> CurrentOrganizationResponse:
    membership = require_organization(session)
    context = TenantContext(
        user_id=session.principal.user_id,
        organization_id=membership.organization_id,
    )
    try:
        organization = await repository.get_current(context)
    except OrganizationBackendUnavailable as error:
        logger.error(
            "organization.unavailable",
            extra={"error_type": type(error).__name__},
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="organization_store_unavailable",
        ) from error

    if organization is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="organization_not_found",
        )
    if organization.organization_id != membership.organization_id:
        logger.error("organization.scope_mismatch")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="organization_store_unavailable",
        )

    return CurrentOrganizationResponse(
        id=organization.organization_id,
        name=organization.name,
        slug=organization.slug,
        status=organization.status,
        caller_role=membership.role,
    )
