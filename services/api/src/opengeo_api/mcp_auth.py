"""Resource-bound Cognito authentication for the request-scoped MCP endpoint."""

from typing import Annotated, Any, cast
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import (
    _resolve_principal,
    bearer,
    repository_from_request,
    require_organization,
    select_membership,
    verifier_from_request,
)
from opengeo_api.auth_tokens import (
    AuthenticationBackendUnavailable,
    TokenVerificationError,
    TokenVerifier,
)
from opengeo_api.config import Settings
from opengeo_api.principals import PrincipalRepository

router = APIRouter(tags=["MCP authentication"])


def require_mcp_settings(request: Request) -> Settings:
    settings = cast(Settings, request.app.state.settings)
    if settings.mcp_resource_url is None:
        raise HTTPException(status_code=404, detail="mcp_not_configured")
    return settings


def validate_mcp_origin(request: Request, settings: Settings) -> None:
    """Nonbrowser clients may omit Origin; supplied origins require explicit trust."""
    origins = request.headers.getlist("origin")
    allowed = settings.mcp_allowed_origins.split(",") if settings.mcp_allowed_origins else []
    if origins and (len(origins) != 1 or origins[0] not in allowed):
        raise HTTPException(status_code=403, detail="mcp_origin_denied")


def mcp_metadata_url(settings: Settings) -> str:
    assert settings.mcp_resource_url is not None
    resource = urlsplit(settings.mcp_resource_url)
    return f"{resource.scheme}://{resource.netloc}/.well-known/oauth-protected-resource/mcp"


def protected_resource_metadata(settings: Settings) -> dict[str, Any]:
    return {
        "resource": settings.mcp_resource_url,
        "authorization_servers": [settings.cognito_issuer],
        "bearer_methods_supported": ["header"],
        "scopes_supported": settings.mcp_required_scopes.split(" "),
        "resource_name": "OpenGeo read-only MCP",
    }


def mcp_unauthorized(settings: Settings, *, insufficient_scope: bool = False) -> HTTPException:
    error = "insufficient_scope" if insufficient_scope else "invalid_token"
    challenge = f'Bearer resource_metadata="{mcp_metadata_url(settings)}", error="{error}"'
    if insufficient_scope:
        challenge += f', scope="{settings.mcp_required_scopes}"'
    return HTTPException(
        status_code=403 if insufficient_scope else 401,
        detail=error,
        headers={"WWW-Authenticate": challenge},
    )


async def require_mcp_session(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Security(bearer)],
    verifier: Annotated[TokenVerifier, Depends(verifier_from_request)],
    repository: Annotated[PrincipalRepository, Depends(repository_from_request)],
    requested_organization: Annotated[str | None, Header(alias="X-OpenGeo-Organization")] = None,
) -> AuthSession:
    settings = require_mcp_settings(request)
    validate_mcp_origin(request, settings)
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise mcp_unauthorized(settings)
    try:
        token = await verifier.verify(credentials.credentials)
    except TokenVerificationError as error:
        raise mcp_unauthorized(settings) from error
    except AuthenticationBackendUnavailable as error:
        raise HTTPException(status_code=503, detail="authentication_unavailable") from error
    if settings.mcp_resource_url not in token.audiences:
        raise mcp_unauthorized(settings)
    if not set(settings.mcp_required_scopes.split(" ")).issubset(token.scopes):
        raise mcp_unauthorized(settings, insufficient_scope=True)
    principal = await _resolve_principal(token, repository)
    session = AuthSession(principal, select_membership(principal, requested_organization))
    require_organization(session)
    return session


@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
@router.get("/.well-known/oauth-protected-resource/mcp", include_in_schema=False)
async def resource_metadata(request: Request) -> dict[str, Any]:
    settings = require_mcp_settings(request)
    validate_mcp_origin(request, settings)
    return protected_resource_metadata(settings)
