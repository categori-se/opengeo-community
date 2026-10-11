from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI, Request

from opengeo_api.auth_routes import router as auth_router
from opengeo_api.auth_tokens import CognitoTokenVerifier, TokenVerifier, UnavailableTokenVerifier
from opengeo_api.config import Settings, get_settings
from opengeo_api.http_app import configure_http_boundary
from opengeo_api.logging import configure_logging
from opengeo_api.organization_routes import repository_from_request as organization_dependency
from opengeo_api.organization_routes import router as organization_router
from opengeo_api.organizations import (
    OrganizationRepository,
    PostgresOrganizationRepository,
    UnavailableOrganizationRepository,
)
from opengeo_api.principals import (
    PostgresPrincipalRepository,
    PrincipalRepository,
    RdsDataApiPrincipalRepository,
    UnavailablePrincipalRepository,
)
from opengeo_api.rds_data import RdsDataApiClient
from opengeo_api.tenant_database import (
    PostgresTenantQueryExecutor,
    RdsDataApiTenantQueryExecutor,
    TenantQueryExecutor,
)
from opengeo_api.version import __version__


async def organization_from_request(request: Request) -> OrganizationRepository:
    """Read app state without dispatching a worker for a synchronous getter."""
    return cast(OrganizationRepository, request.app.state.organization_repository)


def create_session_app(
    settings: Settings | None = None,
    token_verifier: TokenVerifier | None = None,
    principal_repository: PrincipalRepository | None = None,
    organization_repository: OrganizationRepository | None = None,
) -> FastAPI:
    """Account bootstrap routes without importing GIS services."""
    runtime_settings = settings or get_settings()
    configure_logging(runtime_settings.log_level)
    data_api_client = (
        RdsDataApiClient(runtime_settings) if runtime_settings.data_api_configured else None
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if data_api_client is None:
            yield
        else:
            async with data_api_client.connection_scope():
                yield

    app = FastAPI(
        lifespan=lifespan,
        title="OpenGeo API",
        version=__version__,
        docs_url="/docs" if runtime_settings.expose_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if runtime_settings.expose_docs else None,
    )
    default_principal: PrincipalRepository
    if data_api_client is not None:
        default_principal = RdsDataApiPrincipalRepository(runtime_settings, data_api_client)
    elif runtime_settings.direct_database_configured:
        default_principal = PostgresPrincipalRepository(runtime_settings)
    else:
        default_principal = UnavailablePrincipalRepository()
    app.state.settings = runtime_settings
    app.state.token_verifier = token_verifier or (
        CognitoTokenVerifier(runtime_settings)
        if runtime_settings.auth_configured
        else UnavailableTokenVerifier()
    )
    app.state.principal_repository = principal_repository or default_principal
    if organization_repository is not None:
        app.state.organization_repository = organization_repository
    elif runtime_settings.database_configured:
        tenant_executor: TenantQueryExecutor = (
            RdsDataApiTenantQueryExecutor(runtime_settings, data_api_client)
            if data_api_client is not None
            else PostgresTenantQueryExecutor(runtime_settings)
        )
        app.state.organization_repository = PostgresOrganizationRepository(tenant_executor)
    else:
        app.state.organization_repository = UnavailableOrganizationRepository()
    app.dependency_overrides[organization_dependency] = organization_from_request
    configure_http_boundary(app)
    app.include_router(auth_router)
    app.include_router(organization_router)
    return app
