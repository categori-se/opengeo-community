from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.connection_routes import (
    execute_connection,
    tenant_context,
    verification_dispatcher_from_request,
)
from opengeo_api.postgis_catalog_store import CatalogDiscoveryRepository
from opengeo_api.processing_dispatch import (
    ConnectionVerificationDispatcher,
    ProcessingDispatchUnavailable,
)

router = APIRouter(tags=["external database catalog"])
_BASE = "/projects/{project_id}/connections/{connection_id}/catalog-discoveries"


class RequestCatalogDiscovery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1, strict=True)
    request_key: UUID


class CatalogDiscoveryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    discovery_id: UUID
    connection_id: UUID
    connection_revision_number: int
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    attempt_count: int
    relation_count: int
    truncated: bool
    sanitized_error_code: str | None
    requested_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class CatalogDiscoveryListResponse(BaseModel):
    available: bool
    items: list[CatalogDiscoveryResponse]


class CatalogRelationResponse(BaseModel):
    ordinal: int
    descriptor: dict[str, Any]


class CatalogRelationPageResponse(BaseModel):
    items: list[CatalogRelationResponse]
    next_ordinal: int | None


def repository_from_request(request: Request) -> CatalogDiscoveryRepository:
    return cast(CatalogDiscoveryRepository, request.app.state.connection_catalog_repository)


Repository = Annotated[CatalogDiscoveryRepository, Depends(repository_from_request)]
Session = Annotated[AuthSession, Depends(current_session)]
Dispatcher = Annotated[
    ConnectionVerificationDispatcher, Depends(verification_dispatcher_from_request)
]


@router.get(_BASE, response_model=CatalogDiscoveryListResponse)
async def list_catalog_discoveries(
    project_id: UUID,
    connection_id: UUID,
    session: Session,
    repository: Repository,
    dispatcher: Dispatcher,
) -> CatalogDiscoveryListResponse:
    jobs = await execute_connection(
        repository.list_jobs(tenant_context(session), project_id, connection_id)
    )
    return CatalogDiscoveryListResponse(
        available=bool(getattr(dispatcher, "catalog_available", False)),
        items=[CatalogDiscoveryResponse.model_validate(job) for job in jobs],
    )


@router.post(_BASE, response_model=CatalogDiscoveryResponse, status_code=status.HTTP_202_ACCEPTED)
async def request_catalog_discovery(
    project_id: UUID,
    connection_id: UUID,
    payload: RequestCatalogDiscovery,
    session: Session,
    repository: Repository,
    dispatcher: Dispatcher,
) -> CatalogDiscoveryResponse:
    if not getattr(dispatcher, "catalog_available", False):
        raise HTTPException(status_code=503, detail="connection_catalog_discovery_unavailable")
    job = await execute_connection(
        repository.request(
            tenant_context(session),
            project_id,
            connection_id,
            payload.expected_revision,
            payload.request_key,
        )
    )
    try:
        await dispatcher.dispatch_connection_catalog_discovery(job.discovery_id)
    except ProcessingDispatchUnavailable as error:
        # The durable job remains discoverable. Retrying the same request key
        # redispatches its identity rather than creating another discovery.
        raise HTTPException(
            status_code=503, detail="connection_catalog_discovery_dispatch_unavailable"
        ) from error
    return CatalogDiscoveryResponse.model_validate(job)


@router.get(_BASE + "/{discovery_id}", response_model=CatalogDiscoveryResponse)
async def get_catalog_discovery(
    project_id: UUID,
    connection_id: UUID,
    discovery_id: UUID,
    session: Session,
    repository: Repository,
) -> CatalogDiscoveryResponse:
    job = await execute_connection(
        repository.get(tenant_context(session), project_id, connection_id, discovery_id)
    )
    return CatalogDiscoveryResponse.model_validate(job)


@router.delete(_BASE + "/{discovery_id}", response_model=CatalogDiscoveryResponse)
async def cancel_catalog_discovery(
    project_id: UUID,
    connection_id: UUID,
    discovery_id: UUID,
    session: Session,
    repository: Repository,
) -> CatalogDiscoveryResponse:
    job = await execute_connection(
        repository.cancel(tenant_context(session), project_id, connection_id, discovery_id)
    )
    return CatalogDiscoveryResponse.model_validate(job)


@router.get(_BASE + "/{discovery_id}/relations", response_model=CatalogRelationPageResponse)
async def list_catalog_relations(
    project_id: UUID,
    connection_id: UUID,
    discovery_id: UUID,
    session: Session,
    repository: Repository,
    after: Annotated[int, Query(ge=0, le=100)] = 0,
) -> CatalogRelationPageResponse:
    items, next_ordinal = await execute_connection(
        repository.relations(
            tenant_context(session), project_id, connection_id, discovery_id, after
        )
    )
    return CatalogRelationPageResponse(
        items=[
            CatalogRelationResponse(ordinal=ordinal, descriptor=value) for ordinal, value in items
        ],
        next_ordinal=next_ordinal,
    )
