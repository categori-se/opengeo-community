from __future__ import annotations

import base64
import copy
import logging
from collections.abc import Awaitable
from datetime import datetime
from hashlib import sha256
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.ingestion import IngestionRepository, Page, ProcessingJobState
from opengeo_api.ingestion_routes import execute_ingestion
from opengeo_api.ingestion_routes import (
    repository_from_request as ingestion_repository_from_request,
)
from opengeo_api.logging import get_request_id
from opengeo_api.metadata_refresh import MetadataRefresh
from opengeo_api.processing_dispatch import (
    ExternalSourceDiscoveryDispatcher,
    ProcessingDispatchUnavailable,
)
from opengeo_api.resource_knowledge import empty_knowledge
from opengeo_api.s3_downloads import DownloadStorage, DownloadStorageUnavailable, ExactObjectSpec
from opengeo_api.source_archiver import DISCOVERY_METADATA_KEY
from opengeo_api.source_discoveries import (
    SourceDiscoveryAccessDenied,
    SourceDiscoveryConflict,
    SourceDiscoveryJob,
    SourceDiscoveryNotFound,
    SourceDiscoveryRepository,
    SourceDiscoveryRequest,
    SourceDiscoveryStoreUnavailable,
)
from opengeo_api.source_discovery import SourceDiscoverySpec
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["external source discovery"])

ServiceUrl = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2_048),
]
CollectionRef = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]
GeometryType = Literal[
    "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateSourceDiscoveryRequest(RequestModel):
    source_type: Literal["arcgis", "wfs"]
    kind: Literal["catalog", "collection"]
    service_url: ServiceUrl
    collection_ref: CollectionRef | None = None
    idempotency_key: UUID

    @model_validator(mode="after")
    def validate_spec(self) -> CreateSourceDiscoveryRequest:
        SourceDiscoverySpec(
            self.source_type,
            self.kind,
            self.service_url,
            self.collection_ref,
        )
        return self


class DiscoveryCollectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str
    name: str
    title: str
    geometry_type: GeometryType | None
    bounds: tuple[float, float, float, float] | None


class SourceDiscoveryResultResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["opengeo.external-source-discovery-result.1.0.0"]
    source_type: Literal["arcgis", "wfs"]
    kind: Literal["catalog", "collection"]
    service_url: str
    collections: list[DiscoveryCollectionResponse] = Field(min_length=1, max_length=100)
    source_definition: dict[str, Any] | None
    limitations: list[str] = Field(min_length=1, max_length=10)


class SourceDiscoveryResponse(BaseModel):
    schema_version: Literal["opengeo.external-source-discovery-job.1.0.0"] = (
        "opengeo.external-source-discovery-job.1.0.0"
    )
    job_id: UUID
    project_id: UUID
    source_type: Literal["arcgis", "wfs"]
    kind: Literal["catalog", "collection"]
    service_url: str
    collection_ref: str | None
    request_checksum_sha256: str
    idempotency_key: UUID
    state: ProcessingJobState
    result: SourceDiscoveryResultResponse | None
    error_code: str | None
    attempt_count: int
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cancellable: bool


def repository_from_request(request: Request) -> SourceDiscoveryRepository:
    return cast(SourceDiscoveryRepository, request.app.state.source_discovery_repository)


def dispatcher_from_request(request: Request) -> ExternalSourceDiscoveryDispatcher:
    return cast(
        ExternalSourceDiscoveryDispatcher,
        request.app.state.external_source_discovery_dispatcher,
    )


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


def page_parameters(
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    return Page(limit, offset)


async def execute_discovery[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except SourceDiscoveryAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except SourceDiscoveryNotFound as error:
        raise HTTPException(status_code=404, detail="source_discovery_not_found") from error
    except SourceDiscoveryConflict as error:
        raise HTTPException(status_code=409, detail={"code": error.code}) from error
    except SourceDiscoveryStoreUnavailable as error:
        logger.error("external_source_discovery.store_unavailable")
        raise HTTPException(
            status_code=503,
            detail="external_source_discovery_store_unavailable",
        ) from error


@router.post(
    "/projects/{project_id}/source-discoveries",
    response_model=SourceDiscoveryResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_source_discovery(
    project_id: UUID,
    payload: CreateSourceDiscoveryRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    dispatcher: Annotated[ExternalSourceDiscoveryDispatcher, Depends(dispatcher_from_request)],
) -> SourceDiscoveryResponse:
    submission = await execute_discovery(
        repository.create(
            tenant_context(session),
            project_id,
            SourceDiscoveryRequest(
                payload.source_type,
                payload.kind,
                payload.service_url,
                payload.collection_ref,
                payload.idempotency_key,
            ),
            get_request_id(),
        )
    )
    if submission.dispatch_required:
        try:
            await dispatcher.dispatch_external_source_discovery(submission.job.job_id)
        except ProcessingDispatchUnavailable as error:
            logger.error("external_source_discovery.dispatch_unavailable")
            raise HTTPException(
                status_code=503,
                detail="external_source_discovery_dispatch_unavailable",
            ) from error
    return source_discovery_response(submission.job)


@router.get(
    "/projects/{project_id}/source-discoveries",
    response_model=list[SourceDiscoveryResponse],
)
async def list_source_discoveries(
    project_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    page: Annotated[Page, Depends(page_parameters)],
) -> list[SourceDiscoveryResponse]:
    jobs = await execute_discovery(repository.list(tenant_context(session), project_id, page))
    return [source_discovery_response(job) for job in jobs]


class AcceptMetadataRefresh(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=0, le=2_147_483_646, strict=True)
    source_revision: int = Field(ge=1, le=2_147_483_647, strict=True)


@router.post("/datasets/{dataset_id}/metadata-refresh/{project_id}/{job_id}/accept")
async def accept_dataset_metadata_refresh(
    dataset_id: UUID,
    project_id: UUID,
    job_id: UUID,
    draft: AcceptMetadataRefresh,
    response: Response,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    context = tenant_context(session)
    await _require_metadata_edit(datasets, context, dataset_id)
    candidate = copy.deepcopy(
        await execute_discovery(
            repository.get_refresh_document(context, dataset_id, project_id, job_id)
        )
    )
    _require_response_binding(candidate, dataset_id, job_id, project_id)
    if candidate["source_revision"] != draft.source_revision:
        raise HTTPException(status_code=409, detail="metadata_refresh_source_conflict")
    body = await _retained_response_body(request, context, candidate)
    try:
        body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise HTTPException(status_code=409, detail="metadata_refresh_response_invalid") from error
    record = await execute_ingestion(
        datasets.save_dataset_knowledge(
            context,
            dataset_id,
            empty_knowledge(),
            draft.expected_version,
            refresh=MetadataRefresh(
                project_id, job_id, draft.source_revision, candidate["document"]
            ),
        )
    )
    response.headers["Cache-Control"] = "no-store"
    return record


@router.get("/datasets/{dataset_id}/metadata-refresh/{project_id}/{job_id}")
async def dataset_metadata_refresh_candidate(
    dataset_id: UUID,
    project_id: UUID,
    job_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
) -> dict[str, Any]:
    context = tenant_context(session)
    await _require_metadata_edit(datasets, context, dataset_id)
    record = await execute_discovery(
        repository.get_refresh_document(context, dataset_id, project_id, job_id)
    )
    response.headers["Cache-Control"] = "no-store"
    return _public_metadata_record(record)


@router.get("/datasets/{dataset_id}/discovery-metadata")
async def dataset_discovery_metadata(
    dataset_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
) -> dict[str, Any]:
    context = tenant_context(session)
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    record = await execute_discovery(repository.get_dataset_document(context, dataset_id))
    response.headers["Cache-Control"] = "no-store"
    return _public_metadata_record(record)


def _public_metadata_record(record: dict[str, Any]) -> dict[str, Any]:
    if (record.get("document") or {}).get("status") == "retained_object":
        return {
            **record,
            "document": {
                key: value for key, value in record["document"].items() if key != "object"
            },
        }
    return record


async def _require_metadata_edit(
    datasets: IngestionRepository, context: TenantContext, dataset_id: UUID
) -> None:
    dataset = await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    if not dataset.capabilities.edit:
        raise HTTPException(status_code=403, detail="metadata_edit_required")


def _require_response_binding(
    record: dict[str, Any], dataset_id: UUID, job_id: UUID, project_id: UUID | None = None
) -> None:
    if (
        record.get("dataset_id") != str(dataset_id)
        or record.get("discovery_job_id") != str(job_id)
        or (project_id is not None and record.get("project_id") != str(project_id))
    ):
        raise HTTPException(status_code=503, detail="discovery_response_unavailable")


async def _retained_response_body(
    request: Request, context: TenantContext, record: dict[str, Any]
) -> bytes:
    document = record.get("document")
    if document is None or document.get("status") == "not_retained_size":
        raise HTTPException(status_code=404, detail="discovery_response_not_retained")
    try:
        if document["status"] == "retained_object":
            if type(document["byte_length"]) is not int or not (
                32_769 <= document["byte_length"] <= 2_097_152
            ):
                raise ValueError("invalid stored response size")
            receipt = document["object"]
            match = DISCOVERY_METADATA_KEY.fullmatch(receipt["key"])
            if (
                match is None
                or match["organization"] != str(context.organization_id)
                or match["job"] != record["discovery_job_id"]
                or ("project_id" in record and match["project"] != record["project_id"])
            ):
                raise ValueError("invalid source object binding")
            storage = cast(DownloadStorage, getattr(request.app.state, "download_storage", None))
            if storage is None:
                raise DownloadStorageUnavailable("download storage unavailable")
            exact = await storage.read_exact_object(
                ExactObjectSpec(
                    bucket=receipt["bucket"],
                    key=receipt["key"],
                    version_id=receipt["version_id"],
                    content_type=receipt["content_type"],
                    size_bytes=document["byte_length"],
                    checksum_sha256=document["sha256"],
                    maximum_bytes=2_097_152,
                )
            )
            body = exact.body
        elif document["status"] == "retained":
            encoded = document["body_base64"]
            if not isinstance(encoded, str) or len(encoded) > 43_692:
                raise ValueError("invalid inline response size")
            body = base64.b64decode(encoded, validate=True)
            if len(body) > 32_768:
                raise ValueError("invalid inline response size")
        else:
            raise ValueError("invalid source document")
        if (
            not 1 <= len(body) <= 2_097_152
            or len(body) != document["byte_length"]
            or sha256(body).hexdigest() != document["sha256"]
        ):
            raise ValueError("invalid source document")
        return body
    except (DownloadStorageUnavailable, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="discovery_response_unavailable") from error


def _retained_response_attachment(body: bytes, record: dict[str, Any]) -> Response:
    return Response(
        body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-OpenGeo-Source-Sha256": record["document"]["sha256"],
            "X-OpenGeo-Discovery-Job-Id": record["discovery_job_id"],
            "Content-Disposition": (
                f'attachment; filename="discovery-{record["discovery_job_id"]}.bin"'
            ),
        },
    )


@router.get("/datasets/{dataset_id}/metadata-refresh/{project_id}/{job_id}/response")
async def metadata_refresh_response(
    dataset_id: UUID,
    project_id: UUID,
    job_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
) -> Response:
    context = tenant_context(session)
    await _require_metadata_edit(datasets, context, dataset_id)
    record = copy.deepcopy(
        await execute_discovery(
            repository.get_refresh_document(context, dataset_id, project_id, job_id)
        )
    )
    _require_response_binding(record, dataset_id, job_id, project_id)
    body = await _retained_response_body(request, context, record)
    await _require_metadata_edit(datasets, context, dataset_id)
    current = await execute_discovery(
        repository.get_refresh_document(context, dataset_id, project_id, job_id)
    )
    if current != record:
        raise HTTPException(status_code=409, detail="metadata_refresh_source_conflict")
    return _retained_response_attachment(body, record)


@router.get("/datasets/{dataset_id}/metadata-sources/{job_id}/response")
async def knowledge_source_response(
    dataset_id: UUID,
    job_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
) -> Response:
    context = tenant_context(session)
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    record = await execute_discovery(
        repository.get_knowledge_source_document(context, dataset_id, job_id)
    )
    _require_response_binding(record, dataset_id, job_id)
    body = await _retained_response_body(request, context, record)
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    return _retained_response_attachment(body, record)


@router.get("/datasets/{dataset_id}/discovery-metadata/response")
async def dataset_discovery_response(
    dataset_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
    datasets: Annotated[IngestionRepository, Depends(ingestion_repository_from_request)],
) -> Response:
    context = tenant_context(session)
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    record = await execute_discovery(repository.get_dataset_document(context, dataset_id))
    body = await _retained_response_body(request, context, record)
    # A revoked Layer grant cannot release bytes after a storage read started.
    await execute_ingestion(datasets.get_catalog_dataset(context, dataset_id))
    return _retained_response_attachment(body, record)


@router.get(
    "/projects/{project_id}/source-discoveries/{job_id}",
    response_model=SourceDiscoveryResponse,
)
async def get_source_discovery(
    project_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
) -> SourceDiscoveryResponse:
    job = await execute_discovery(repository.get(tenant_context(session), project_id, job_id))
    return source_discovery_response(job)


@router.post(
    "/projects/{project_id}/source-discoveries/{job_id}/cancel",
    response_model=SourceDiscoveryResponse,
)
async def cancel_source_discovery(
    project_id: UUID,
    job_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[SourceDiscoveryRepository, Depends(repository_from_request)],
) -> SourceDiscoveryResponse:
    job = await execute_discovery(
        repository.cancel(tenant_context(session), project_id, job_id, get_request_id())
    )
    return source_discovery_response(job)


def source_discovery_response(job: SourceDiscoveryJob) -> SourceDiscoveryResponse:
    result = (
        SourceDiscoveryResultResponse.model_validate(job.result) if job.result is not None else None
    )
    return SourceDiscoveryResponse(
        job_id=job.job_id,
        project_id=job.project_id,
        source_type=job.source_type,
        kind=job.kind,
        service_url=job.service_url,
        collection_ref=job.collection_ref,
        request_checksum_sha256=job.request_checksum_sha256,
        idempotency_key=job.idempotency_key,
        state=job.state,
        result=result,
        error_code=job.error_code,
        attempt_count=job.attempt_count,
        created_by=job.created_by,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        cancellable=job.state == "queued",
    )
