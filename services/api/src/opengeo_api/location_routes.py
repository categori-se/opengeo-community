from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.features import FeatureInvalid
from opengeo_api.location_links import PostgresLocationLinksRepository
from opengeo_api.tenant_database import TenantDatabaseConflict, TenantDatabaseUnavailable
from opengeo_api.workspace_locations import (
    LocationAccessDenied,
    LocationConflict,
    LocationNotFound,
    PostgresLocationRepository,
)
from opengeo_api.workspace_routes import tenant_context

router = APIRouter(tags=["locations"])
Session = Annotated[AuthSession, Depends(current_session)]


class LocationDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: dict[str, Any]


class LocationUpdate(LocationDraft):
    expected_revision: Annotated[int, Field(ge=1)]


async def execute[ResultT](operation: Awaitable[ResultT], response: Response) -> ResultT:
    response.headers["Cache-Control"] = "no-store"
    try:
        return await operation
    except LocationAccessDenied as error:
        raise HTTPException(403, "location_access_denied") from error
    except LocationNotFound as error:
        raise HTTPException(404, "location_not_found") from error
    except (LocationConflict, TenantDatabaseConflict) as error:
        raise HTTPException(409, "location_conflict") from error
    except (ValueError, FeatureInvalid) as error:
        raise HTTPException(422, "location_document_invalid") from error
    except TenantDatabaseUnavailable as error:
        raise HTTPException(503, "location_store_unavailable") from error


@router.get("/locations")
async def list_locations(
    request: Request,
    response: Response,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> list[dict[str, Any]]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).list(
            tenant_context(session), limit, offset
        ),
        response,
    )


@router.post("/locations", status_code=201)
async def create_location(
    body: LocationDraft, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).save(
            tenant_context(session), body.document
        ),
        response,
    )


@router.get("/locations/{location_id}")
async def read_location(
    location_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).read(
            tenant_context(session), location_id, version
        ),
        response,
    )


@router.put("/locations/{location_id}")
async def update_location(
    location_id: UUID,
    body: LocationUpdate,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).save(
            tenant_context(session), body.document, location_id, body.expected_revision
        ),
        response,
    )


class LocationGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_access_revision: Annotated[int, Field(ge=1)]
    role: Literal["reader", "editor"] | None


@router.get("/locations/{location_id}/grants")
async def location_grants(
    location_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).grants(
            tenant_context(session), location_id, limit, offset
        ),
        response,
    )


@router.put("/locations/{location_id}/grants/{user_id}")
async def grant_location(
    location_id: UUID,
    user_id: UUID,
    body: LocationGrant,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).grant(
            tenant_context(session), location_id, user_id, body.expected_access_revision, body.role
        ),
        response,
    )


class LocationParent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_hierarchy_revision: Annotated[int, Field(ge=0)]
    parent_id: UUID | None
    evidence: Annotated[list[str], Field(max_length=16)] = []
    confidence: Annotated[float | None, Field(ge=0, le=1)] = None


@router.get("/locations/{location_id}/parent")
async def location_parent(
    location_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    version: Annotated[int | None, Query(ge=0)] = None,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).parent(
            tenant_context(session), location_id, version
        ),
        response,
    )


@router.put("/locations/{location_id}/parent")
async def set_location_parent(
    location_id: UUID,
    body: LocationParent,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationRepository, request.app.state.location_repository).set_parent(
            tenant_context(session),
            location_id,
            body.expected_hierarchy_revision,
            body.parent_id,
            body.evidence,
            body.confidence,
        ),
        response,
    )


class ExistingLocationLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry_id: UUID


class NewLocationLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["layer", "project", "publication", "collection"]
    target_id: UUID
    relationship: Annotated[str, Field(min_length=1, max_length=2048)]
    evidence: Annotated[
        list[Annotated[str, Field(min_length=1, max_length=2048)]], Field(max_length=16)
    ] = []
    confidence: Annotated[float | None, Field(ge=0, le=1)] = None

    @field_validator("relationship", "evidence")
    @classmethod
    def validate_uris(cls, value: str | list[str]) -> str | list[str]:
        for uri in value if isinstance(value, list) else [value]:
            parsed = urlsplit(uri)
            if parsed.scheme not in {"https", "http", "urn"} or parsed.username or parsed.password:
                raise ValueError("Invalid relationship/evidence URI")
            if (parsed.scheme in {"http", "https"} and not parsed.hostname) or not (
                parsed.netloc or parsed.path
            ):
                raise ValueError("Empty relationship/evidence URI")
        return value


class LocationLinksUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_links_revision: Annotated[int, Field(ge=0)]
    entries: Annotated[list[ExistingLocationLink | NewLocationLink], Field(max_length=200)]


@router.get("/locations/{location_id}/links")
async def location_links(
    location_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    version: Annotated[int | None, Query(ge=0)] = None,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationLinksRepository, request.app.state.location_links_repository).read(
            tenant_context(session), location_id, version
        ),
        response,
    )


@router.put("/locations/{location_id}/links")
async def update_location_links(
    location_id: UUID,
    body: LocationLinksUpdate,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresLocationLinksRepository, request.app.state.location_links_repository).replace(
            tenant_context(session),
            location_id,
            body.expected_links_revision,
            [entry.model_dump() for entry in body.entries],
        ),
        response,
    )
