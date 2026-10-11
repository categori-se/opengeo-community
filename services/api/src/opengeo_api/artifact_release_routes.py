from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from opengeo_api.artifact_releases import (
    create_release,
    list_releases,
    read_release,
    revoke_release,
)
from opengeo_api.artifact_static_delivery import static_artifact_ticket
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.render_routes import execute_render
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderConflict,
    RenderNotFound,
    RenderStoreUnavailable,
)
from opengeo_api.s3_downloads import DownloadStorageUnavailable, ExactObject, ExactObjectSpec
from opengeo_api.workspace_routes import tenant_context

router = APIRouter(tags=["artifact-releases"])
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
PORTABLE_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob:; "
    "style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; "
    "worker-src blob:; connect-src blob:; "
    "frame-src 'none'; base-uri 'none'; form-action 'none'"
)


def _portable_origins(target: tuple[Any, ...]) -> list[str]:
    from opengeo_api.portable_artifact_publication import public_portable_origins

    return public_portable_origins(target[13], target[15]) if len(target) > 15 else []


def _portable_csp(target: tuple[Any, ...]) -> str:
    origins = " ".join(_portable_origins(target))
    return (
        PORTABLE_CSP.replace("connect-src blob:;", f"connect-src blob: {origins};").replace(
            "img-src data: blob:;", f"img-src data: blob: {origins};"
        )
        if origins
        else PORTABLE_CSP
    )


class ReleaseDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    creation_key: UUID | None = None
    version_number: Annotated[int, Field(ge=1, strict=True)]
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    license: Literal["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"]
    attribution: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
    ]


@router.post("/artifacts/{artifact_id}/releases", status_code=201)
async def release_artifact(
    artifact_id: UUID,
    body: ReleaseDraft,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
) -> JSONResponse:
    record = await execute_render(
        create_release(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            tenant_context(session),
            artifact_id,
            body.version_number,
            body.title,
            body.license,
            body.attribution,
            body.creation_key,
        )
    )
    record["public_view_url"] = str(
        request.url_for(
            "public_release_view",
            organization_id=tenant_context(session).organization_id,
            release_id=record["id"],
        )
    )
    return JSONResponse(record, status_code=201, headers=HEADERS)


@router.post("/artifact-releases/{release_id}/revoke")
async def revoke_artifact(
    release_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
) -> JSONResponse:
    record = await execute_render(
        revoke_release(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            tenant_context(session),
            release_id,
        )
    )
    return JSONResponse(record, headers=HEADERS)


async def _public(
    request: Request, organization_id: UUID, release_id: UUID
) -> tuple[dict[str, Any], tuple[Any, ...]]:
    try:
        return await read_release(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            organization_id,
            release_id,
        )
    except (RenderNotFound, RenderConflict) as error:
        raise HTTPException(404, "artifact_release_unavailable", headers=HEADERS) from error
    except RenderStoreUnavailable as error:
        raise HTTPException(503, "artifact_release_store_unavailable", headers=HEADERS) from error


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}")
async def public_release(organization_id: UUID, release_id: UUID, request: Request) -> JSONResponse:
    record, _ = await _public(request, organization_id, release_id)
    return JSONResponse(record, headers=HEADERS)


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/image")
async def public_release_image(
    organization_id: UUID, release_id: UUID, request: Request
) -> Response:
    return await _release_image(request, organization_id, release_id, 16 * 1024 * 1024)


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/preview")
async def public_release_preview(
    organization_id: UUID, release_id: UUID, request: Request
) -> Response:
    return await _release_image(request, organization_id, release_id, 1024 * 1024)


async def _release_image(
    request: Request, organization_id: UUID, release_id: UUID, maximum_bytes: int
) -> Response:
    return await _release_output(
        request, organization_id, release_id, maximum_bytes, {"image/png", "image/jpeg"}
    )


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/map")
async def public_release_map(
    organization_id: UUID, release_id: UUID, request: Request, download: bool = False
) -> Response:
    response = await _release_output(
        request, organization_id, release_id, 4 * 1024 * 1024, {"text/html"}
    )
    if download:
        response.headers["Content-Disposition"] = 'attachment; filename="opengeo-project.html"'
    return response


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/module.mjs")
async def public_release_module(
    organization_id: UUID, release_id: UUID, request: Request, download: bool = False
) -> Response:
    from opengeo_api.project_module import project_module

    headers = {**HEADERS, "Access-Control-Allow-Origin": "*", "Referrer-Policy": "no-referrer"}
    try:
        record, target, exact = await _read_release_output(
            request, organization_id, release_id, 4 * 1024 * 1024, {"text/html"}
        )
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **headers}
        raise
    metadata = {
        key: record[key]
        for key in (
            "id",
            "artifact_id",
            "version_number",
            "project_id",
            "title",
            "license",
            "attribution",
        )
    }
    metadata["html_sha256"] = target[12]
    metadata["scope"] = "reviewed-browser-snapshot"
    origins = _portable_origins(target)
    if origins:
        metadata["network_required"] = True
    if download:
        headers["Content-Disposition"] = 'attachment; filename="opengeo-project.mjs"'
    module = project_module(exact.body, metadata, public_origins=origins)
    if len(module) > 4 * 1024 * 1024:
        raise HTTPException(413, "artifact_module_size_limit", headers=headers)
    return Response(module, media_type="text/javascript", headers=headers)


async def _release_output(
    request: Request,
    organization_id: UUID,
    release_id: UUID,
    maximum_bytes: int,
    media_types: set[str],
) -> Response:
    _, target, exact = await _read_release_output(
        request, organization_id, release_id, maximum_bytes, media_types
    )
    headers = {
        **HEADERS,
        **(
            {"Content-Security-Policy": _portable_csp(target), "Referrer-Policy": "no-referrer"}
            if target[10] == "text/html"
            else {}
        ),
    }
    return Response(exact.body, media_type=exact.content_type, headers=headers)


async def _read_release_output(
    request: Request,
    organization_id: UUID,
    release_id: UUID,
    maximum_bytes: int,
    media_types: set[str],
) -> tuple[dict[str, Any], tuple[Any, ...], ExactObject]:
    record, target = await _public(request, organization_id, release_id)
    if target[10] not in media_types or target[11] > maximum_bytes:
        raise HTTPException(404, "artifact_preview_unavailable", headers=HEADERS)
    storage = (
        cast(PostgresRenderRepository, request.app.state.render_repository)._artifact_downloads
        if target[10] == "text/html"
        else request.app.state.download_storage
    )
    if storage is None:
        raise HTTPException(503, "artifact_release_object_unavailable", headers=HEADERS)
    try:
        exact = await storage.read_exact_object(
            ExactObjectSpec(
                bucket=target[7],
                key=target[8],
                version_id=target[9],
                content_type=target[10],
                size_bytes=target[11],
                checksum_sha256=target[12],
                maximum_bytes=maximum_bytes,
            )
        )
    except DownloadStorageUnavailable as error:
        raise HTTPException(503, "artifact_release_object_unavailable", headers=HEADERS) from error
    # Recheck revocation/source eligibility after the bounded object read.
    await _public(request, organization_id, release_id)
    return record, target, exact


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/view")
async def public_release_view(
    organization_id: UUID, release_id: UUID, request: Request
) -> HTMLResponse:
    from html import escape

    from fastapi.responses import HTMLResponse

    record, _ = await _public(request, organization_id, release_id)
    portable = record["media_type"] == "text/html"
    body = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>"
        + escape(record["title"])
        + "</title><main><h1>"
        + escape(record["title"])
        + "</h1><p>Published Project output</p>"
        + (
            '<iframe src="map" sandbox="allow-scripts" '
            'style="width:100%;height:75vh;border:0" title="'
            if portable
            else '<img src="image" alt="'
        )
        + escape(record["title"])
        + ('"></iframe>' if portable else '">')
        + "<p>"
        + escape(record["attribution"])
        + " · "
        + escape(record["license"])
        + "</p>"
        + (
            "<p>"
            + ("Live source images · internet required. " if record.get("network_required") else "")
            + '<a href="map?download=true">'
            + ("Download live HTML" if record.get("network_required") else "Download offline HTML")
            + "</a> · "
            '<a href="module.mjs?download=true">Download JavaScript module</a></p>'
            if portable
            else ""
        )
        + "</main></html>"
    )
    return HTMLResponse(
        body,
        headers={
            **HEADERS,
            "Content-Security-Policy": (
                "default-src 'none'; img-src 'self'; frame-src 'self'; "
                "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
            ),
            "Referrer-Policy": "no-referrer",
        },
    )


@router.get("/public/organizations/{organization_id}/artifact-releases/{release_id}/static")
async def public_release_static(
    organization_id: UUID, release_id: UUID, request: Request
) -> HTMLResponse:
    from html import escape
    from urllib.parse import urlsplit

    record, target = await _public(request, organization_id, release_id)
    try:
        ticket_url = await static_artifact_ticket(
            cast(PostgresRenderRepository, request.app.state.render_repository)._artifact_downloads,
            request.app.state.settings.aws_region,
            target,
        )
    except DownloadStorageUnavailable as error:
        raise HTTPException(503, "artifact_static_delivery_unavailable", headers=HEADERS) from error
    # Signing may wait for credentials. Recheck current release/source eligibility
    # before returning the ticket, which remains usable only until its short expiry.
    await _public(request, organization_id, release_id)
    url = urlsplit(ticket_url)
    body = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escape(record['title'])}</title><main>"
        f"<h1>{escape(record['title'])}</h1>"
        f'<iframe src="{escape(ticket_url, quote=True)}" '
        'sandbox="allow-scripts" referrerpolicy="no-referrer" '
        'style="width:100%;height:75vh;border:0" '
        f'title="{escape(record["title"], quote=True)}"></iframe>'
        f"<p>{escape(record['attribution'])} · {escape(record['license'])}</p>"
        "<p>Static HTML is delivered from S3 without Studio. "
        "Issued links expire within 15 minutes. Downloaded copies can be kept.</p></main></html>"
    )
    return HTMLResponse(
        body,
        headers={
            **HEADERS,
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; "
                f"frame-src https://{url.netloc}{url.path}; base-uri 'none'; form-action 'none'"
            ),
        },
    )


@router.get("/artifacts/{artifact_id}/releases")
async def artifact_release_history(
    artifact_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> JSONResponse:
    record = await execute_render(
        list_releases(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            tenant_context(session),
            artifact_id,
            limit,
            offset,
        )
    )
    for release in record["records"]:
        release["public_view_url"] = str(
            request.url_for(
                "public_release_view",
                organization_id=tenant_context(session).organization_id,
                release_id=release["id"],
            )
        )
    return JSONResponse(record, headers=HEADERS)
