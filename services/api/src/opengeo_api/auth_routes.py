import logging
from collections.abc import Awaitable, Callable
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from opengeo_api.auth_models import (
    AuthSession,
    OrganizationMembership,
    Principal,
    VerifiedAccessToken,
)
from opengeo_api.auth_tokens import (
    AuthenticationBackendUnavailable,
    TokenVerificationError,
    TokenVerifier,
)
from opengeo_api.principals import PrincipalBackendUnavailable, PrincipalRepository

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["authentication"])
bearer = HTTPBearer(auto_error=False)


class MembershipResponse(BaseModel):
    organization_id: UUID
    role: str


class SessionResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str
    memberships: list[MembershipResponse]
    selected_organization_id: UUID | None
    selected_organization_role: str | None


async def verifier_from_request(request: Request) -> TokenVerifier:
    return cast(TokenVerifier, request.app.state.token_verifier)


async def repository_from_request(request: Request) -> PrincipalRepository:
    return cast(PrincipalRepository, request.app.state.principal_repository)


def unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid_token",
        headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
    )


async def verified_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Security(bearer)],
    verifier: Annotated[TokenVerifier, Depends(verifier_from_request)],
) -> VerifiedAccessToken:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    try:
        return await verifier.verify(credentials.credentials)
    except TokenVerificationError as error:
        logger.warning(
            "authentication.rejected",
            extra={"error_type": type(error).__name__},
        )
        raise unauthorized() from error
    except AuthenticationBackendUnavailable as error:
        logger.error(
            "authentication.unavailable",
            extra={"error_type": type(error).__name__},
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="authentication_unavailable",
        ) from error


async def principal_for_token(
    token: Annotated[VerifiedAccessToken, Depends(verified_token)],
    repository: Annotated[PrincipalRepository, Depends(repository_from_request)],
) -> Principal:
    return await _resolve_principal(token, repository)


async def startup_principal_for_token(
    token: Annotated[VerifiedAccessToken, Depends(verified_token)],
    repository: Annotated[PrincipalRepository, Depends(repository_from_request)],
) -> Principal:
    return await _resolve_principal(token, repository, startup=True)


async def _resolve_principal(
    token: VerifiedAccessToken, repository: PrincipalRepository, *, startup: bool = False
) -> Principal:
    resolver: Callable[[str], Awaitable[Principal | None]] = repository.resolve
    startup_resolver = getattr(repository, "resolve_for_startup", None) if startup else None
    if callable(startup_resolver):
        resolver = cast(Callable[[str], Awaitable[Principal | None]], startup_resolver)
    try:
        principal = await resolver(token.subject)
    except PrincipalBackendUnavailable as error:
        cause = error.__cause__
        if cause is not None and cause.__cause__ is not None:
            cause = cause.__cause__
        logger.error(
            "principal.unavailable",
            extra={
                "error_type": type(error).__name__,
                "cause_type": type(cause).__name__ if cause is not None else "unknown",
            },
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="identity_store_unavailable",
        ) from error
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="principal_not_provisioned",
        )
    return principal


def select_membership(
    principal: Principal,
    requested_organization: str | None,
) -> OrganizationMembership | None:
    if requested_organization is None:
        return principal.memberships[0] if len(principal.memberships) == 1 else None
    try:
        organization_id = UUID(requested_organization)
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid_organization_scope",
        ) from error

    membership = next(
        (
            candidate
            for candidate in principal.memberships
            if candidate.organization_id == organization_id
        ),
        None,
    )
    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="organization_access_denied",
        )
    return membership


async def current_session(
    principal: Annotated[Principal, Depends(principal_for_token)],
    requested_organization: Annotated[
        str | None,
        Header(alias="X-OpenGeo-Organization"),
    ] = None,
) -> AuthSession:
    return AuthSession(
        principal=principal,
        selected_membership=select_membership(principal, requested_organization),
    )


async def startup_session(
    principal: Annotated[Principal, Depends(startup_principal_for_token)],
    requested_organization: Annotated[
        str | None,
        Header(alias="X-OpenGeo-Organization"),
    ] = None,
) -> AuthSession:
    return await current_session(principal, requested_organization)


def require_organization(session: AuthSession) -> OrganizationMembership:
    if session.selected_membership is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="organization_scope_required",
        )
    return session.selected_membership


@router.get("/session", response_model=SessionResponse)
async def session_details(
    session: Annotated[AuthSession, Depends(startup_session)],
) -> SessionResponse:
    selected = session.selected_membership
    return SessionResponse(
        user_id=session.principal.user_id,
        email=session.principal.email,
        display_name=session.principal.display_name,
        memberships=[
            MembershipResponse(
                organization_id=membership.organization_id,
                role=membership.role,
            )
            for membership in session.principal.memberships
        ],
        selected_organization_id=selected.organization_id if selected else None,
        selected_organization_role=selected.role if selected else None,
    )
