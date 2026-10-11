from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.logging import get_request_id
from opengeo_api.tenant_database import TenantDatabaseConflict, TenantDatabaseUnavailable
from opengeo_api.workspace_collections import (
    CollectionAccessDenied,
    CollectionConflict,
    CollectionNotFound,
    PostgresCollectionRepository,
)
from opengeo_api.workspace_routes import tenant_context

router = APIRouter(tags=["collections"])


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CollectionOwner(Model):
    principal_type: Literal["user", "team", "organization"]
    principal_id: UUID


class CollectionDraft(Model):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=10000)] = ""


class CollectionCreate(CollectionDraft):
    owner: CollectionOwner | None = None


class CollectionOwnerUpdate(Model):
    expected_revision: Annotated[int, Field(ge=1, strict=True)]
    owner: CollectionOwner


class ExistingMember(Model):
    entry_id: UUID


class NewMember(Model):
    kind: Literal["project", "publication"]
    target_id: UUID


class CollectionUpdate(CollectionDraft):
    expected_revision: Annotated[int, Field(ge=1)]
    members: Annotated[list[ExistingMember | NewMember], Field(max_length=200)]


class CollectionGrant(Model):
    expected_revision: Annotated[int, Field(ge=1)]
    role: Literal["reader", "editor"] | None


async def execute[ResultT](operation: Awaitable[ResultT], response: Response) -> ResultT:
    response.headers["Cache-Control"] = "no-store"
    try:
        return await operation
    except CollectionNotFound as error:
        raise HTTPException(404, "collection_not_found") from error
    except CollectionAccessDenied as error:
        raise HTTPException(403, "collection_access_denied") from error
    except (CollectionConflict, TenantDatabaseConflict) as error:
        raise HTTPException(409, "collection_conflict") from error
    except TenantDatabaseUnavailable as error:
        raise HTTPException(503, "collection_store_unavailable") from error


Session = Annotated[AuthSession, Depends(current_session)]


@router.get("/collections")
async def list_collections(
    request: Request,
    response: Response,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
    q: Annotated[str, Query(max_length=200)] = "",
    visibility: Literal["private", "account", "public"] | None = None,
    sort: Literal["updated", "title", "created"] = "updated",
) -> list[dict[str, Any]]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).list(
            tenant_context(session),
            limit,
            offset,
            query=q.strip(),
            visibility=visibility,
            sort=sort,
        ),
        response,
    )


@router.post("/collections", status_code=201)
async def create_collection(
    body: CollectionCreate, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).create(
            tenant_context(session), body.title, body.description,
            owner=body.owner.model_dump() if body.owner is not None else None,
            request_id=get_request_id(),
        ),
        response,
    )


@router.get("/collections/owner-candidates")
async def collection_owner_candidates(
    kind: Literal["user", "team", "organization"],
    request: Request,
    response: Response,
    session: Session,
    collection_id: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> list[dict[str, str]]:
    repository = cast(PostgresCollectionRepository, request.app.state.collection_repository)
    return await execute(
        repository.owner_candidates(
            tenant_context(session), kind, limit, offset, collection_id=collection_id
        ),
        response,
    )


@router.get("/collections/member-candidates")
async def collection_candidates(
    kind: Literal["project", "publication"],
    request: Request,
    response: Response,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> list[dict[str, Any]]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).candidates(
            tenant_context(session), kind, limit, offset
        ),
        response,
    )


@router.put("/collections/{collection_id}/owner")
async def set_collection_owner(
    collection_id: UUID,
    body: CollectionOwnerUpdate,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).set_owner(
            tenant_context(session), collection_id, body.expected_revision,
            body.owner.model_dump(), get_request_id(),
        ),
        response,
    )


@router.get("/collections/{collection_id}")
async def read_collection(
    collection_id: UUID, request: Request, response: Response, session: Session
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).read(
            tenant_context(session), collection_id
        ),
        response,
    )


@router.put("/collections/{collection_id}")
async def update_collection(
    collection_id: UUID,
    body: CollectionUpdate,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).replace(
            tenant_context(session),
            collection_id,
            body.expected_revision,
            body.title,
            body.description,
            [member.model_dump() for member in body.members],
        ),
        response,
    )


@router.put("/collections/{collection_id}/grants/{user_id}")
async def grant_collection(
    collection_id: UUID,
    user_id: UUID,
    body: CollectionGrant,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).grant(
            tenant_context(session), collection_id, body.expected_revision, user_id, body.role
        ),
        response,
    )


@router.get("/collections/{collection_id}/grants")
async def list_collection_grants(
    collection_id: UUID,
    request: Request,
    response: Response,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).grants(
            tenant_context(session), collection_id, limit, offset
        ),
        response,
    )


class CollectionVisibility(Model):
    expected_revision: Annotated[int, Field(ge=1, strict=True)]
    visibility: Literal["private", "account", "public"]


@router.put("/collections/{collection_id}/visibility")
async def set_collection_visibility(
    collection_id: UUID,
    body: CollectionVisibility,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).set_visibility(
            tenant_context(session), collection_id, body.expected_revision, body.visibility
        ),
        response,
    )


@router.get("/public/organizations/{organization_id}/collections/{collection_id}")
async def public_collection(
    organization_id: UUID, collection_id: UUID, request: Request
) -> JSONResponse:
    from fastapi.responses import JSONResponse

    headers = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex"}
    try:
        record = await cast(
            PostgresCollectionRepository, request.app.state.collection_repository
        ).read_public(
            organization_id,
            collection_id,
            render_repository=request.app.state.render_repository,
            site_repository=request.app.state.site_publication_repository,
        )
    except CollectionNotFound as error:
        raise HTTPException(404, "collection_not_found", headers=headers) from error
    except TenantDatabaseUnavailable as error:
        raise HTTPException(503, "collection_store_unavailable", headers=headers) from error
    return JSONResponse(record, headers=headers)


@router.get("/public/organizations/{organization_id}/collections/{collection_id}/view")
async def public_collection_view(
    organization_id: UUID, collection_id: UUID, request: Request
) -> HTMLResponse:
    import json
    from html import escape

    from fastapi.responses import HTMLResponse

    response = await public_collection(organization_id, collection_id, request)
    record = json.loads(bytes(response.body))
    members = ""
    previews = 0
    for member in record["members"]:
        relative = member["href"].split(f"/organizations/{organization_id}/", 1)[1]
        preview = ""
        if member.get("preview_href") and previews < 4:
            preview_path = member["preview_href"].split(f"/organizations/{organization_id}/", 1)[1]
            preview = (
                '<img loading="lazy" width="280" src="../../'
                + escape(preview_path)
                + '" alt="'
                + escape(member["title"])
                + '">'
            )
            previews += 1
        members += (
            "<li>"
            + preview
            + '<a href="../../'
            + escape(relative)
            + '">'
            + escape(member["title"])
            + "</a><p>"
            + escape(member["description"] or "")
            + (" · " + escape(member["attribution"]) if member.get("attribution") else "")
            + (" · " + escape(member["license"]) if member.get("license") else "")
            + "</p></li>"
        )
    body = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>"
        + escape(record["title"])
        + "</title><main><h1>"
        + escape(record["title"])
        + "</h1><p>"
        + escape(record["description"])
        + "</p><p>Public Collection</p>"
        + ("<ul>" + members + "</ul>" if members else "<p>No public members to display.</p>")
        + "</main></html>"
    )
    return HTMLResponse(
        body,
        headers={
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
            "Content-Security-Policy": (
                "default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'"
            ),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/collections/{collection_id}/image-previews")
async def collection_image_previews(
    collection_id: UUID,
    request: Request,
    response: Response,
    session: Session,
) -> list[dict[str, Any]]:
    return await execute(
        cast(PostgresCollectionRepository, request.app.state.collection_repository).image_previews(
            tenant_context(session),
            collection_id,
            request.app.state.render_repository,
            request.app.state.site_publication_repository,
        ),
        response,
    )
