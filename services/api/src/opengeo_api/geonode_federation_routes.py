from __future__ import annotations

import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.geonode_federation import (
    GeoNodeFederationFailure,
    geonode_federation_conversion_report,
    parse_geonode_federation_configuration,
)
from opengeo_api.geonode_federations import (
    GeoNodeFederatedIdentity,
    GeoNodeFederatedIdentityVersion,
    GeoNodeFederationAccessDenied,
    GeoNodeFederationConflict,
    GeoNodeFederationNotFound,
    GeoNodeFederationRepository,
    GeoNodeFederationSource,
    GeoNodeFederationStoreUnavailable,
    GeoNodeHarvestJob,
)
from opengeo_api.ingestion import Page, ProcessingJobState
from opengeo_api.logging import get_request_id
from opengeo_api.processing_dispatch import (
    GeoNodeHarvestDispatcher,
    ProcessingDispatchUnavailable,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["GeoNode federation"])


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateGeoNodeFederationRequest(RequestModel):
    configuration: dict[str, Any]


class CreateGeoNodeHarvestRequest(RequestModel):
    idempotency_key: UUID


class GeoNodeFederationSourceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["opengeo.geonode-federation-source.1.0.0"] = (
        "opengeo.geonode-federation-source.1.0.0"
    )
    source_id: UUID
    project_id: UUID
    configuration: dict[str, Any]
    conversion_report: dict[str, Any]
    configuration_checksum_sha256: str
    status: Literal["active", "disabled"]
    created_by: UUID
    created_at: datetime
    disabled_at: datetime | None


class GeoNodeHarvestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["opengeo.geonode-harvest-job.1.0.0"] = (
        "opengeo.geonode-harvest-job.1.0.0"
    )
    job_id: UUID
    source_id: UUID
    project_id: UUID
    source_configuration_checksum_sha256: str
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    result: dict[str, Any] | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancellable: bool


class GeoNodeFederatedResourceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["opengeo.geonode-federated-resource.1.0.0"] = (
        "opengeo.geonode-federated-resource.1.0.0"
    )
    source_id: UUID
    remote_identifier: str
    resource_type: Literal["dataset", "document", "map", "geoapp", "service"]
    title: str
    status: Literal["current", "withdrawn"]
    current_version_number: int
    current_payload_sha256: str
    remote_modified_at: datetime | None
    first_seen_at: datetime
    last_refreshed_at: datetime
    fresh_until: datetime
    withdrawn_at: datetime | None


class GeoNodeFederatedResourceVersionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["opengeo.geonode-federated-resource-version.1.0.0"] = (
        "opengeo.geonode-federated-resource-version.1.0.0"
    )
    source_id: UUID
    remote_identifier: str
    version_number: int
    harvest_job_id: UUID
    action: Literal["added", "updated", "withdrawn"]
    resource_type: Literal["dataset", "document", "map", "geoapp", "service"]
    title: str
    payload_sha256: str
    payload: dict[str, Any] | None
    remote_modified_at: datetime | None
    observed_at: datetime


def repository_from_request(request: Request) -> GeoNodeFederationRepository:
    return cast(
        GeoNodeFederationRepository,
        request.app.state.geonode_federation_repository,
    )


def dispatcher_from_request(request: Request) -> GeoNodeHarvestDispatcher:
    return cast(GeoNodeHarvestDispatcher, request.app.state.geonode_harvest_dispatcher)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit, offset)


async def execute_federation[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except GeoNodeFederationAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except GeoNodeFederationNotFound as error:
        raise HTTPException(status_code=404, detail="geonode_federation_not_found") from error
    except GeoNodeFederationConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except GeoNodeFederationStoreUnavailable as error:
        logger.error("geonode_federation.store_unavailable")
        raise HTTPException(
            status_code=503,
            detail="geonode_federation_store_unavailable",
        ) from error


@router.post(
    "/projects/{project_id}/geonode-federations",
    response_model=GeoNodeFederationSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_geonode_federation(
    project_id: UUID,
    body: CreateGeoNodeFederationRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
) -> GeoNodeFederationSourceResponse:
    try:
        configuration = parse_geonode_federation_configuration(body.configuration)
    except GeoNodeFederationFailure as error:
        raise HTTPException(status_code=422, detail={"code": error.code}) from error
    submission = await execute_federation(
        repository.create_source(tenant_context(session), project_id, configuration)
    )
    return source_response(submission.source)


@router.get(
    "/projects/{project_id}/geonode-federations",
    response_model=list[GeoNodeFederationSourceResponse],
)
async def list_geonode_federations(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
    page: Annotated[Page, Depends(page_parameters)],
) -> list[GeoNodeFederationSourceResponse]:
    sources = await execute_federation(
        repository.list_sources(tenant_context(session), project_id, page)
    )
    return [source_response(source) for source in sources]


@router.get(
    "/projects/{project_id}/geonode-federations/{source_id}",
    response_model=GeoNodeFederationSourceResponse,
)
async def get_geonode_federation(
    project_id: UUID,
    source_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
) -> GeoNodeFederationSourceResponse:
    source = await execute_federation(
        repository.get_source(tenant_context(session), project_id, source_id)
    )
    return source_response(source)


@router.post(
    "/projects/{project_id}/geonode-federations/{source_id}/disable",
    response_model=GeoNodeFederationSourceResponse,
)
async def disable_geonode_federation(
    project_id: UUID,
    source_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
) -> GeoNodeFederationSourceResponse:
    source = await execute_federation(
        repository.disable_source(tenant_context(session), project_id, source_id, get_request_id())
    )
    return source_response(source)


@router.post(
    "/projects/{project_id}/geonode-federations/{source_id}/harvests",
    response_model=GeoNodeHarvestResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_geonode_harvest(
    project_id: UUID,
    source_id: UUID,
    body: CreateGeoNodeHarvestRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
    dispatcher: Annotated[GeoNodeHarvestDispatcher, Depends(dispatcher_from_request)],
) -> GeoNodeHarvestResponse:
    submission = await execute_federation(
        repository.create_harvest(
            tenant_context(session),
            project_id,
            source_id,
            body.idempotency_key,
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        if not dispatcher.available:
            raise HTTPException(status_code=503, detail="geonode_harvest_dispatch_unavailable")
        try:
            await dispatcher.dispatch_geonode_harvest(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("geonode_federation.dispatch_unavailable")
            raise HTTPException(
                status_code=503,
                detail="geonode_harvest_dispatch_unavailable",
            ) from error
    return harvest_response(submission.job)


@router.get(
    "/projects/{project_id}/geonode-federations/{source_id}/harvests",
    response_model=list[GeoNodeHarvestResponse],
)
async def list_geonode_harvests(
    project_id: UUID,
    source_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
    page: Annotated[Page, Depends(page_parameters)],
) -> list[GeoNodeHarvestResponse]:
    jobs = await execute_federation(
        repository.list_harvests(tenant_context(session), project_id, source_id, page)
    )
    return [harvest_response(job) for job in jobs]


@router.get(
    "/projects/{project_id}/geonode-federations/{source_id}/harvests/{job_id}",
    response_model=GeoNodeHarvestResponse,
)
async def get_geonode_harvest(
    project_id: UUID,
    source_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
) -> GeoNodeHarvestResponse:
    job = await execute_federation(
        repository.get_harvest(tenant_context(session), project_id, source_id, job_id)
    )
    return harvest_response(job)


@router.post(
    "/projects/{project_id}/geonode-federations/{source_id}/harvests/{job_id}/cancel",
    response_model=GeoNodeHarvestResponse,
)
async def cancel_geonode_harvest(
    project_id: UUID,
    source_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
) -> GeoNodeHarvestResponse:
    job = await execute_federation(
        repository.cancel_harvest(
            tenant_context(session),
            project_id,
            source_id,
            job_id,
            get_request_id(),
        )
    )
    return harvest_response(job)


@router.get(
    "/projects/{project_id}/geonode-federations/{source_id}/resources",
    response_model=list[GeoNodeFederatedResourceResponse],
)
async def list_geonode_federated_resources(
    project_id: UUID,
    source_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
    page: Annotated[Page, Depends(page_parameters)],
) -> list[GeoNodeFederatedResourceResponse]:
    resources = await execute_federation(
        repository.list_resources(tenant_context(session), project_id, source_id, page)
    )
    return [resource_response(resource) for resource in resources]


@router.get(
    "/projects/{project_id}/geonode-federations/{source_id}/resources/{remote_identifier}/versions",
    response_model=list[GeoNodeFederatedResourceVersionResponse],
)
async def list_geonode_federated_resource_versions(
    project_id: UUID,
    source_id: UUID,
    remote_identifier: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[GeoNodeFederationRepository, Depends(repository_from_request)],
    page: Annotated[Page, Depends(page_parameters)],
) -> list[GeoNodeFederatedResourceVersionResponse]:
    versions = await execute_federation(
        repository.list_resource_versions(
            tenant_context(session),
            project_id,
            source_id,
            str(remote_identifier),
            page,
        )
    )
    return [version_response(version) for version in versions]


def source_response(source: GeoNodeFederationSource) -> GeoNodeFederationSourceResponse:
    return GeoNodeFederationSourceResponse(
        source_id=source.source_id,
        project_id=source.project_id,
        configuration=source.configuration.json_value(),
        conversion_report=geonode_federation_conversion_report(source.configuration),
        configuration_checksum_sha256=source.configuration_checksum_sha256,
        status=cast(Any, source.status),
        created_by=source.created_by,
        created_at=source.created_at,
        disabled_at=source.disabled_at,
    )


def harvest_response(job: GeoNodeHarvestJob) -> GeoNodeHarvestResponse:
    return GeoNodeHarvestResponse(
        job_id=job.job_id,
        source_id=job.source_id,
        project_id=job.project_id,
        source_configuration_checksum_sha256=job.source_configuration_checksum_sha256,
        request_checksum_sha256=job.request_checksum_sha256,
        idempotency_key=job.idempotency_key,
        state=job.state,
        result=job.result,
        error_code=job.error_code,
        attempt_count=job.attempt_count,
        created_by=job.created_by,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        cancellable=job.state in {"queued", "running"},
    )


def resource_response(
    resource: GeoNodeFederatedIdentity,
) -> GeoNodeFederatedResourceResponse:
    return GeoNodeFederatedResourceResponse(
        source_id=resource.source_id,
        remote_identifier=resource.remote_identifier,
        resource_type=cast(Any, resource.resource_type),
        title=resource.title,
        status=cast(Any, resource.status),
        current_version_number=resource.current_version_number,
        current_payload_sha256=resource.current_payload_sha256,
        remote_modified_at=resource.remote_modified_at,
        first_seen_at=resource.first_seen_at,
        last_refreshed_at=resource.last_refreshed_at,
        fresh_until=resource.fresh_until,
        withdrawn_at=resource.withdrawn_at,
    )


def version_response(
    version: GeoNodeFederatedIdentityVersion,
) -> GeoNodeFederatedResourceVersionResponse:
    return GeoNodeFederatedResourceVersionResponse(
        source_id=version.source_id,
        remote_identifier=version.remote_identifier,
        version_number=version.version_number,
        harvest_job_id=version.harvest_job_id,
        action=cast(Any, version.action),
        resource_type=cast(Any, version.resource_type),
        title=version.title,
        payload_sha256=version.payload_sha256,
        payload=version.payload,
        remote_modified_at=version.remote_modified_at,
        observed_at=version.observed_at,
    )
