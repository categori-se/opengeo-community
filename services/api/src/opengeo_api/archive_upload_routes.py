"""Authenticated local-archive planning endpoints; review performs no storage writes."""

from collections.abc import Awaitable
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.archive_manifest_records import ArchiveManifestRepository
from opengeo_api.archive_upload_storage import ArchiveStorageError
from opengeo_api.archive_upload_transfers import ArchiveTransferRepository
from opengeo_api.archive_uploads import ArchiveFile, ArchiveUploadRepository
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.framework_publication_aws import PublicationDependencyUnavailable
from opengeo_api.ingestion import PostgresIngestionRepository
from opengeo_api.ingestion_routes import execute_ingestion, tenant_context

router = APIRouter(tags=["local archive uploads"])


def archive_repository(request: Request) -> ArchiveUploadRepository:
    repository = request.app.state.ingestion_repository
    if not isinstance(repository, PostgresIngestionRepository):
        raise HTTPException(503, detail={"code": "archive_uploads_unavailable"})
    return ArchiveUploadRepository(repository)


class SessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    creation_key: UUID


class FileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ordinal: int = Field(strict=True, ge=0, lt=100_000)
    destination_id: UUID
    path: str = Field(min_length=1, max_length=1024)
    size_bytes: int = Field(strict=True, ge=0, le=5 * 1024**4)
    modified_milliseconds: int = Field(strict=True, ge=0, le=2**53 - 1)
    sha256: str = Field(pattern="^[a-f0-9]{64}$")


class FilesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    files: list[FileRequest] = Field(min_length=1, max_length=25)


Session = Annotated[AuthSession, Depends(current_session)]
Repository = Annotated[ArchiveUploadRepository, Depends(archive_repository)]


@router.get("/projects/{project_id}/archive-upload-destinations")
async def destinations(
    project_id: UUID, session: Session, repository: Repository
) -> list[dict[str, Any]]:
    rows = await execute_ingestion(repository.destinations(tenant_context(session), project_id))
    return [
        dict(zip(("id", "title", "bucket", "region", "prefix"), row, strict=True)) for row in rows
    ]


@router.post("/projects/{project_id}/archive-uploads", status_code=201)
async def create(
    project_id: UUID, payload: SessionRequest, session: Session, repository: Repository
) -> dict[str, Any]:
    upload_id = await execute_ingestion(
        repository.create(tenant_context(session), project_id, payload.creation_key)
    )
    return {"id": upload_id}


@router.put("/projects/{project_id}/archive-uploads/{upload_id}/files", status_code=204)
async def append(
    project_id: UUID,
    upload_id: UUID,
    payload: FilesRequest,
    session: Session,
    repository: Repository,
) -> Response:
    await execute_ingestion(
        repository.append_files(
            tenant_context(session),
            project_id,
            upload_id,
            [ArchiveFile(**file.model_dump()) for file in payload.files],
        )
    )
    return Response(status_code=204)


@router.get("/projects/{project_id}/archive-uploads/{upload_id}/files")
async def read(
    project_id: UUID,
    upload_id: UUID,
    session: Session,
    repository: Repository,
    after: Annotated[int, Query(ge=-1, lt=100_000)] = -1,
) -> dict[str, Any]:
    rows = await execute_ingestion(
        repository.read_files(tenant_context(session), project_id, upload_id, after)
    )
    fields = ("ordinal", "destination_id", "path", "size_bytes", "modified_milliseconds", "sha256")
    return {
        "files": [dict(zip(fields, row, strict=True)) for row in rows],
        "next_after": rows[-1][0] if len(rows) == 25 else None,
    }


class SealRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_files: int = Field(strict=True, ge=1, le=100_000)
    expected_bytes: int = Field(strict=True, ge=0, le=1024**4)


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/seal")
async def seal(
    project_id: UUID,
    upload_id: UUID,
    payload: SealRequest,
    session: Session,
    repository: Repository,
) -> dict[str, Any]:
    return await execute_ingestion(
        repository.seal(
            tenant_context(session),
            project_id,
            upload_id,
            payload.expected_files,
            payload.expected_bytes,
        )
    )


@router.get("/projects/{project_id}/archive-uploads/{upload_id}")
async def upload_status(
    project_id: UUID, upload_id: UUID, session: Session, repository: Repository
) -> dict[str, Any]:
    return await execute_ingestion(
        repository.status(tenant_context(session), project_id, upload_id)
    )


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/finish", status_code=204)
async def finish(
    project_id: UUID, upload_id: UUID, session: Session, repository: Repository
) -> Response:
    await execute_ingestion(repository.finish(tenant_context(session), project_id, upload_id))
    return Response(status_code=204)


@router.get("/projects/{project_id}/archive-uploads/{upload_id}/manifest")
async def manifest(
    project_id: UUID,
    upload_id: UUID,
    session: Session,
    repository: Repository,
    after: Annotated[int, Query(ge=-1, lt=100_000)] = -1,
) -> dict[str, Any]:
    rows = await execute_ingestion(
        repository.manifest_page(tenant_context(session), project_id, upload_id, after)
    )
    fields = (
        "ordinal",
        "path",
        "size_bytes",
        "modified_milliseconds",
        "sha256",
        "object_ordinal",
        "object",
    )
    return {
        "files": [dict(zip(fields, row, strict=True)) for row in rows],
        "next_after": rows[-1][0] if len(rows) == 25 else None,
        "filesystem_limits": [
            "Browser selection omits Unix modes, symbolic links and empty directories."
        ],
    }


def transfer_repository(plans: Repository) -> ArchiveTransferRepository:
    return ArchiveTransferRepository(plans)


Transfer = Annotated[ArchiveTransferRepository, Depends(transfer_repository)]
Ordinal = Annotated[int, Path(ge=0, lt=100_000)]


def manifest_repository(plans: Repository) -> ArchiveManifestRepository:
    return ArchiveManifestRepository(plans)


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/preserve-manifest")
async def preserve_manifest(
    project_id: UUID,
    upload_id: UUID,
    session: Session,
    repository: Annotated[ArchiveManifestRepository, Depends(manifest_repository)],
    after: Annotated[int, Query(ge=-1, lt=100_000)] = -1,
) -> dict[str, Any]:
    return await execute_transfer(
        repository.preserve_page(tenant_context(session), project_id, upload_id, after)
    )


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/manifest-index/{destination_id}")
async def preserve_manifest_index(
    project_id: UUID,
    upload_id: UUID,
    destination_id: UUID,
    session: Session,
    repository: Annotated[ArchiveManifestRepository, Depends(manifest_repository)],
) -> dict[str, Any]:
    return await execute_transfer(
        repository.preserve_index(tenant_context(session), project_id, upload_id, destination_id)
    )


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/restore/{ordinal}")
async def restore_original(
    project_id: UUID,
    upload_id: UUID,
    ordinal: Ordinal,
    session: Session,
    repository: Annotated[ArchiveManifestRepository, Depends(manifest_repository)],
) -> dict[str, Any]:
    return await execute_transfer(
        repository.restore_ticket(tenant_context(session), project_id, upload_id, ordinal)
    )


async def execute_transfer[ResultT](operation: Awaitable[ResultT]) -> ResultT:
    try:
        return await execute_ingestion(operation)
    except (ArchiveStorageError, PublicationDependencyUnavailable, TimeoutError) as error:
        raise HTTPException(503, detail={"code": "archive_transfer_unavailable"}) from error


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/start", status_code=204)
async def start(
    project_id: UUID, upload_id: UUID, session: Session, repository: Transfer
) -> Response:
    await execute_transfer(repository.start(tenant_context(session), project_id, upload_id))
    return Response(status_code=204)


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/objects/{ordinal}/prepare")
async def prepare(
    project_id: UUID, upload_id: UUID, ordinal: Ordinal, session: Session, repository: Transfer
) -> dict[str, Any]:
    return await execute_transfer(
        repository.prepare(tenant_context(session), project_id, upload_id, ordinal)
    )


class PartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    number: int = Field(strict=True, ge=1, le=10_000)
    sha256: str = Field(pattern="^[a-f0-9]{64}$")


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/objects/{ordinal}/parts")
async def part(
    project_id: UUID,
    upload_id: UUID,
    ordinal: Ordinal,
    payload: PartRequest,
    session: Session,
    repository: Transfer,
) -> dict[str, Any]:
    return await execute_transfer(
        repository.part_ticket(
            tenant_context(session), project_id, upload_id, ordinal, payload.number, payload.sha256
        )
    )


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/objects/{ordinal}/complete")
async def complete_object(
    project_id: UUID, upload_id: UUID, ordinal: Ordinal, session: Session, repository: Transfer
) -> dict[str, Any]:
    return await execute_transfer(
        repository.complete(tenant_context(session), project_id, upload_id, ordinal)
    )


@router.post("/projects/{project_id}/archive-uploads/{upload_id}/objects/{ordinal}/abort-multipart")
async def abort_object(
    project_id: UUID, upload_id: UUID, ordinal: Ordinal, session: Session, repository: Transfer
) -> dict[str, Any]:
    return await execute_transfer(
        repository.abort_multipart(tenant_context(session), project_id, upload_id, ordinal)
    )


@router.get("/projects/{project_id}/archive-uploads/{upload_id}/objects/{ordinal}/parts")
async def uploaded_parts(
    project_id: UUID,
    upload_id: UUID,
    ordinal: Ordinal,
    session: Session,
    repository: Transfer,
    after: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> dict[str, Any]:
    return await execute_transfer(
        repository.uploaded_parts(tenant_context(session), project_id, upload_id, ordinal, after)
    )
