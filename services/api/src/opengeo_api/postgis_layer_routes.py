"""Deliberate selected relation registration and bounded private Layer preview."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.connection_routes import execute_connection, tenant_context
from opengeo_api.external_source_routes import execute_source
from opengeo_api.postgis_layers import (
    PostgisLayerRepository,
    PostgisLayerSelection,
    PostgisPreviewClient,
    PostgisPreviewFailure,
    PostgisPreviewUnavailable,
    _finite_number,
    validate_postgis_preview,
)

router = APIRouter(tags=["external database layers"])


class RegistrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_connection_revision: int = Field(strict=True, ge=1)
    schema_fingerprint_sha256: Annotated[
        str, StringConstraints(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    ]
    geometry_column: Annotated[str, StringConstraints(min_length=1, max_length=63)]
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    description: Annotated[str, StringConstraints(max_length=2000)] | None = None
    expected_source_version: int | None = Field(default=None, strict=True, ge=1)
    request_key: UUID

    @field_validator("geometry_column", mode="after")
    @classmethod
    def identifier(cls, value: str) -> str:
        if len(value.encode()) > 63 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("geometry column must be a PostgreSQL identifier")
        return value


class RegistrationResponse(BaseModel):
    dataset_id: UUID
    source_version: int
    created: bool


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_source_version: int = Field(strict=True, ge=1)
    request_key: UUID
    bbox: tuple[float, float, float, float]

    @field_validator("bbox", mode="before")
    @classmethod
    def bounds(cls, value: Any) -> Any:
        if (
            not isinstance(value, (list, tuple))
            or len(value) != 4
            or any(not _finite_number(c) for c in value)
            or not -180 <= value[0] < value[2] <= 180
            or not -90 <= value[1] < value[3] <= 90
        ):
            raise ValueError("bbox must be ordered WGS84 bounds")
        return value


def repository_from_request(request: Request) -> PostgisLayerRepository:
    return cast(PostgisLayerRepository, request.app.state.postgis_layer_repository)


def client_from_request(request: Request) -> PostgisPreviewClient:
    return cast(PostgisPreviewClient, request.app.state.postgis_preview_client)


Repository = Annotated[PostgisLayerRepository, Depends(repository_from_request)]
Client = Annotated[PostgisPreviewClient, Depends(client_from_request)]
Session = Annotated[AuthSession, Depends(current_session)]


@router.post(
    "/projects/{project_id}/connections/{connection_id}/catalog-discoveries/"
    "{discovery_id}/relations/{ordinal}/layers",
    response_model=RegistrationResponse,
)
async def register_postgis_layer(
    project_id: UUID,
    connection_id: UUID,
    discovery_id: UUID,
    ordinal: Annotated[int, Path(ge=1, le=100)],
    payload: RegistrationRequest,
    session: Session,
    repository: Repository,
) -> RegistrationResponse:
    result = await execute_connection(
        execute_source(
            repository.register(
                tenant_context(session),
                project_id,
                connection_id,
                discovery_id,
                ordinal,
                PostgisLayerSelection(**payload.model_dump()),
            )
        )
    )
    return RegistrationResponse(
        dataset_id=result.dataset_id, source_version=result.source_version, created=result.created
    )


@router.post("/datasets/{dataset_id}/postgis-preview")
async def preview_postgis_layer(
    dataset_id: UUID,
    payload: PreviewRequest,
    session: Session,
    repository: Repository,
    client: Client,
    response: Response,
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    if not client.available:
        raise HTTPException(status_code=503, detail="postgis_preview_unavailable")
    lease = await execute_source(
        repository.prepare_preview(
            tenant_context(session),
            dataset_id,
            payload.expected_source_version,
            payload.request_key,
            payload.bbox,
        )
    )
    if lease.state != "queued":
        # Completed bytes are deliberately not stored. Reusing a request key
        # never silently reruns the provider after a lost response.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "postgis_preview_new_request_required",
                "state": lease.state,
            },
        )
    try:
        result = await client.preview(
            lease.preview_id, dataset_id, payload.expected_source_version, payload.bbox
        )
        return validate_postgis_preview(
            result, lease.preview_id, dataset_id, payload.expected_source_version, payload.bbox
        )
    except PostgisPreviewFailure as error:
        code = 409 if error.code in {"preview_stale", "preview_schema_changed"} else 503
        raise HTTPException(status_code=code, detail=error.code) from error
    except PostgisPreviewUnavailable as error:
        raise HTTPException(status_code=503, detail="postgis_preview_unavailable") from error
