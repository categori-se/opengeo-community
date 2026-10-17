"""Explicit managed analysis: small manifests, private direct uploads and leased jobs."""

from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from opengeo_api.analysis_jobs import (
    MAX_RESULT_BYTES,
    MAX_SNAPSHOT_BYTES,
    AnalysisAccessDenied,
    AnalysisConfiguration,
    AnalysisConflict,
    AnalysisJobRepository,
    AnalysisNotFound,
    AnalysisUnavailable,
)
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.connection_routes import tenant_context
from opengeo_api.processing_dispatch import AnalysisDispatcher, ProcessingDispatchUnavailable
from opengeo_api.s3_downloads import DownloadSpec, DownloadStorage, DownloadStorageUnavailable
from opengeo_api.s3_uploads import (
    UploadObjectNotFound,
    UploadSpec,
    UploadStorage,
    UploadStorageUnavailable,
)

router = APIRouter(tags=["managed analysis"])
MAX_DESCRIPTOR_BYTES = 16 * 1024
Sha256 = Annotated[str, StringConstraints(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")]
LayerId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
Session = Annotated[AuthSession, Depends(current_session)]


class SnapshotDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    size_bytes: int = Field(strict=True, ge=1, le=MAX_SNAPSHOT_BYTES)
    checksum_sha256: Sha256


class SourceBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layer_id: LayerId
    dataset_id: UUID
    dataset_version_id: UUID | None = None
    source_version: int | None = Field(default=None, strict=True, ge=1, le=2**53 - 1)
    feature_generation: int | None = Field(default=None, strict=True, ge=1, le=2**53 - 1)


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_key: UUID
    language: Literal["javascript", "python", "bash"]
    snapshot: SnapshotDescriptor
    layer_ids: list[LayerId] = Field(max_length=16)
    source_bindings: list[SourceBinding] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def closed_scope(self) -> "AnalysisRequest":
        if len(set(self.layer_ids)) != len(self.layer_ids) or any(
            not value.strip() or any(ord(c) < 32 for c in value) for value in self.layer_ids
        ):
            raise ValueError("select distinct layer identities")
        bound = [value.layer_id for value in self.source_bindings]
        if len(set(bound)) != len(bound) or not set(bound) <= set(self.layer_ids):
            raise ValueError("source bindings must be unique selected layer identities")
        return self


def request_body_schema() -> dict[str, Any]:
    # Streaming enforces the byte limit before parsing, so FastAPI cannot infer
    # this body. Inline model definitions to keep references valid in OpenAPI.
    schema = AnalysisRequest.model_json_schema()
    definitions = schema.pop("$defs", {})

    def inline(value: Any) -> Any:
        if isinstance(value, dict):
            if "$ref" in value:
                return inline(definitions[value["$ref"].removeprefix("#/$defs/")])
            return {key: inline(child) for key, child in value.items()}
        if isinstance(value, list):
            return [inline(child) for child in value]
        return value

    return cast(dict[str, Any], inline(schema))


async def execute[T](operation: Awaitable[T]) -> T:
    try:
        return await operation
    except AnalysisAccessDenied as error:
        raise HTTPException(403, detail="analysis_forbidden") from error
    except AnalysisNotFound as error:
        raise HTTPException(404, detail="analysis_not_found") from error
    except AnalysisConflict as error:
        raise HTTPException(409, detail=error.code) from error
    except (AnalysisUnavailable, UploadStorageUnavailable, DownloadStorageUnavailable) as error:
        raise HTTPException(503, detail="analysis_unavailable") from error


async def descriptor(request: Request) -> AnalysisRequest:
    length = request.headers.get("content-length")
    if length is not None and (not length.isdecimal() or int(length) > MAX_DESCRIPTOR_BYTES):
        raise HTTPException(413, detail="analysis_descriptor_too_large")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_DESCRIPTOR_BYTES:
            raise HTTPException(413, detail="analysis_descriptor_too_large")
        body.extend(chunk)
    try:
        return AnalysisRequest.model_validate_json(bytes(body))
    except (ValidationError, ValueError) as error:
        raise HTTPException(422, detail="analysis_request_invalid") from error


def repository(request: Request) -> AnalysisJobRepository:
    return cast(AnalysisJobRepository, request.app.state.analysis_job_repository)


def configuration(request: Request) -> AnalysisConfiguration:
    return cast(AnalysisConfiguration, request.app.state.analysis_configuration)


def dispatcher(request: Request) -> AnalysisDispatcher:
    return cast(AnalysisDispatcher, request.app.state.analysis_dispatcher)


def require_configured(request: Request) -> AnalysisConfiguration:
    selected = configuration(request)
    if not selected.configured or not dispatcher(request).available:
        raise HTTPException(503, detail="analysis_runtime_unavailable")
    return selected


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    """No signed URL, raw script, snapshot bytes or private object key in polling."""
    fields = (
        "job_id",
        "request_key",
        "state",
        "language",
        "created_at",
        "updated_at",
        "expires_at",
        "error_code",
        "execution",
        "provenance",
    )
    value = {key: row[key] for key in fields if key in row}
    cleanup = row.get("cleanup")
    cleanup = cleanup if isinstance(cleanup, dict) else {}
    value["cleanup_required"] = (
        row.get("cleanup_required", cleanup.get("cleanup_required", False)) is True
    )
    value["cleanup"] = {
        key: cleanup[key]
        for key in ("cleanup_required", "container_removed", "staging_removed", "host_absent")
        if key in cleanup
    }
    result = row.get("result")
    value["result_available"] = (
        row.get("state") in {"succeeded", "failed"}
        and isinstance(result, dict)
        and cleanup.get("cleanup_required") is False
        and cleanup.get("container_removed") is True
        and cleanup.get("staging_removed") is True
    )
    if value["result_available"] and isinstance(result, dict):
        value["result"] = {
            key: result[key] for key in ("size_bytes", "checksum_sha256") if key in result
        }
    return value


async def with_upload_ticket(request: Request, row: dict[str, Any]) -> dict[str, Any]:
    result = public_job(row)
    if (
        row["state"] != "awaiting_upload"
        or not configuration(request).configured
        or not dispatcher(request).available
    ):
        return result
    storage = cast(UploadStorage, request.app.state.analysis_upload_storage)
    target = row["snapshot"]
    form = await execute(
        storage.create_upload_form(
            UploadSpec(
                key=target["key"],
                content_type="application/json",
                size_bytes=target["size_bytes"],
                checksum_sha256=target["checksum_sha256"],
            )
        )
    )
    result["upload"] = {
        "url": form.url,
        "method": form.method,
        "fields": dict(form.fields),
        "expires_at": form.expires_at,
    }
    return result


@router.get("/projects/{project_id}/analysis/capabilities")
async def capabilities(
    project_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return await execute(
        repository(request).capabilities(
            tenant_context(session), project_id, configuration(request)
        )
    )


@router.post(
    "/projects/{project_id}/analysis/jobs",
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": f"JSON metadata descriptor, at most {MAX_DESCRIPTOR_BYTES} bytes.",
            "content": {"application/json": {"schema": request_body_schema()}},
        }
    },
)
async def create_job(
    project_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    selected = require_configured(request)
    payload = await descriptor(request)
    storage = cast(UploadStorage, request.app.state.analysis_upload_storage)
    snapshot = {**payload.snapshot.model_dump(), "layer_ids": payload.layer_ids}
    row = await execute(
        repository(request).create(
            tenant_context(session),
            project_id,
            payload.request_key,
            payload.language,
            snapshot,
            [value.model_dump(mode="json", exclude_none=True) for value in payload.source_bindings],
            selected,
            storage.bucket,
        )
    )
    response.headers["Cache-Control"] = "private, no-store"
    return await with_upload_ticket(request, row)


@router.get("/projects/{project_id}/analysis/jobs")
async def find_job(
    project_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    request_key: Annotated[UUID, Query()],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    row = await execute(repository(request).find(tenant_context(session), project_id, request_key))
    return await with_upload_ticket(request, row)


@router.get("/projects/{project_id}/analysis/jobs/{job_id}")
async def get_job(
    project_id: UUID, job_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return public_job(
        await execute(repository(request).get(tenant_context(session), project_id, job_id))
    )


@router.post("/projects/{project_id}/analysis/jobs/{job_id}/submit")
async def submit_job(
    project_id: UUID, job_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    require_configured(request)
    response.headers["Cache-Control"] = "private, no-store"
    repo = repository(request)
    context = tenant_context(session)
    row = await execute(repo.get(context, project_id, job_id))
    if row["state"] == "awaiting_upload":
        storage = cast(UploadStorage, request.app.state.analysis_upload_storage)
        target = row["snapshot"]
        try:
            stored = await execute(storage.inspect_object(target["key"]))
        except UploadObjectNotFound as error:
            raise HTTPException(409, detail="analysis_snapshot_not_uploaded") from error
        if (
            stored.bucket != target["bucket"]
            or stored.key != target["key"]
            or stored.size_bytes != target["size_bytes"]
            or stored.checksum_sha256 != target["checksum_sha256"]
            or stored.content_type != "application/json"
            or not stored.version_id
            or stored.version_id == "null"
        ):
            raise HTTPException(409, detail="analysis_snapshot_mismatch")
        row = await execute(
            repo.submit(
                context,
                project_id,
                job_id,
                {
                    "bucket": stored.bucket,
                    "key": stored.key,
                    "version_id": stored.version_id,
                    "size_bytes": stored.size_bytes,
                    "checksum_sha256": stored.checksum_sha256,
                    "content_type": stored.content_type,
                },
            )
        )
    if row["state"] == "dispatch_pending":
        try:
            await dispatcher(request).dispatch_analysis(job_id)
        except ProcessingDispatchUnavailable:
            # Durable identity remains readable; submit may retry this dispatch,
            # never the upload, snapshot freeze or window reservation.
            response.status_code = 202
            return {**public_job(row), "dispatch_pending": True}
        row = await execute(repo.dispatched(context, project_id, job_id))
    return public_job(row)


@router.post("/projects/{project_id}/analysis/jobs/{job_id}/cancel")
async def cancel_job(
    project_id: UUID, job_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return public_job(
        await execute(repository(request).cancel(tenant_context(session), project_id, job_id))
    )


@router.get("/projects/{project_id}/analysis/jobs/{job_id}/result")
async def result_ticket(
    project_id: UUID, job_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    row = await execute(repository(request).get(tenant_context(session), project_id, job_id))
    result = row.get("result")
    if not public_job(row)["result_available"] or not isinstance(result, dict):
        raise HTTPException(409, detail="analysis_result_unavailable")
    if not 1 <= result["size_bytes"] <= MAX_RESULT_BYTES:
        raise HTTPException(409, detail="analysis_result_invalid")
    storage = cast(DownloadStorage, request.app.state.analysis_download_storage)
    ticket = await execute(
        storage.create_download_url(
            DownloadSpec(
                bucket=result["bucket"],
                key=result["key"],
                version_id=result["version_id"],
                filename="analysis-result.json",
                ttl_seconds=60,
            )
        )
    )
    return {
        "url": ticket.url,
        "method": ticket.method,
        "expires_at": ticket.expires_at,
        "size_bytes": result["size_bytes"],
        "checksum_sha256": result["checksum_sha256"],
    }
