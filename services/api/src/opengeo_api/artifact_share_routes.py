"""Owner-controlled password links to one retained, static HTML map edition."""

from html import escape
from typing import Annotated, cast
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints

from opengeo_api.artifact_shares import (
    create_share,
    list_shares,
    recheck_share,
    revoke_share,
    unlock_share,
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
from opengeo_api.s3_downloads import DownloadStorageUnavailable
from opengeo_api.workspace_routes import tenant_context

router = APIRouter(tags=["artifact-shares"])
HEADERS = {
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
        "base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
    ),
}
STYLE = (
    "body{font:16px system-ui;margin:0;color:#202020;background:#fafafa}"
    "main{max-width:52rem;margin:3rem auto;padding:1rem}"
    "label,input,button{display:block;margin:.75rem 0}"
    "input,button{font:inherit;padding:.6rem}iframe{width:100%;height:75vh;border:0}"
)


class ShareDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    creation_key: UUID | None = None
    version_number: Annotated[int, Field(ge=1, strict=True)]
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    # Backend validation rejects invalid lengths without echoing input. SecretStr
    # also prevents accidental plaintext in model representations and tracebacks.
    password: SecretStr


def _view_url(request: Request, organization_id: UUID, share_id: str) -> str:
    configured = getattr(request.app.state.settings, "artifact_view_origin", None)
    if configured is not None:
        # Operator-controlled origin, never a caller-supplied forwarded Host.
        return (
            f"{configured}/api/shared/organizations/{organization_id}"
            f"/artifact-shares/{share_id}/view"
        )
    return str(
        request.url_for("shared_artifact_view", organization_id=organization_id, share_id=share_id)
    )


@router.post("/artifacts/{artifact_id}/shares", status_code=201)
async def share_artifact(
    artifact_id: UUID,
    body: ShareDraft,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
) -> JSONResponse:
    context = tenant_context(session)
    record = await execute_render(
        create_share(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            context,
            artifact_id,
            body.version_number,
            body.title,
            body.password.get_secret_value(),
            body.creation_key,
        )
    )
    record["view_url"] = _view_url(request, context.organization_id, record["id"])
    return JSONResponse(record, status_code=201, headers=HEADERS)


@router.get("/artifacts/{artifact_id}/shares")
async def artifact_share_history(
    artifact_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
) -> JSONResponse:
    context = tenant_context(session)
    record = await execute_render(
        list_shares(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            context,
            artifact_id,
            limit,
            offset,
        )
    )
    for share in record["records"]:
        share["view_url"] = _view_url(request, context.organization_id, share["id"])
    return JSONResponse(record, headers=HEADERS)


@router.post("/artifact-shares/{share_id}/revoke")
async def revoke_artifact_share(
    share_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
) -> JSONResponse:
    record = await execute_render(
        revoke_share(
            cast(PostgresRenderRepository, request.app.state.render_repository),
            tenant_context(session),
            share_id,
        )
    )
    return JSONResponse(record, headers=HEADERS)


def _document(title: str, content: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escape(title)}</title><style>{STYLE}</style></head>"
        f"<body><main>{content}</main></body></html>"
    )


def _password_form(message: str = "", *, status_code: int = 200) -> HTMLResponse:
    return HTMLResponse(
        _document(
            "Shared OpenGeo map",
            "<h1>Shared map</h1><p>Enter the password provided by the map owner.</p>"
            f'<p role="status">{escape(message)}</p>'
            '<form method="post"><label for="password">Map password</label>'
            '<input id="password" name="password" type="password" required '
            'minlength="12" maxlength="128" autocomplete="current-password">'
            '<button type="submit">Open map</button></form>'
            "<p>No Studio account is needed. This link allows five unlock attempts "
            "per 15 minutes. The owner can stop future unlocks.</p>",
        ),
        status_code=status_code,
        headers=HEADERS,
    )


@router.get("/shared/organizations/{organization_id}/artifact-shares/{share_id}/view")
async def shared_artifact_view(organization_id: UUID, share_id: UUID) -> HTMLResponse:
    # This generic shell discloses no existence, title, bytes or credentials and
    # performs no database/provider lookup, S3 read or build merely on navigation.
    del organization_id, share_id
    return _password_form()


async def _form_password(request: Request) -> str:
    origin = f"{request.url.scheme}://{request.url.netloc}"
    configured = getattr(request.app.state.settings, "artifact_view_origin", None)
    allowed_origins = {origin}
    if configured is not None:
        # CloudFront deliberately forwards the API Gateway Host. The browser's
        # same-origin form POST still names the configured Studio origin.
        allowed_origins.add(configured)
    if (
        request.headers.get("origin") not in allowed_origins
        or request.headers.get("sec-fetch-site", "same-origin") != "same-origin"
    ):
        raise HTTPException(403, "artifact_share_origin_invalid", headers=HEADERS)
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != (
        "application/x-www-form-urlencoded"
    ):
        raise HTTPException(415, "artifact_share_form_required", headers=HEADERS)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2048:
            raise HTTPException(413, "artifact_share_form_too_large", headers=HEADERS)
    try:
        fields = parse_qs(
            body.decode("utf-8"),
            keep_blank_values=True,
            strict_parsing=True,
            max_num_fields=1,
            errors="strict",
        )
        if set(fields) != {"password"} or len(fields["password"]) != 1:
            raise ValueError("invalid fields")
        password = fields["password"][0]
        if not 12 <= len(password) <= 128:
            raise ValueError("invalid length")
        return password
    except (ValueError, UnicodeError) as error:
        raise HTTPException(400, "artifact_share_form_invalid", headers=HEADERS) from error


@router.post("/shared/organizations/{organization_id}/artifact-shares/{share_id}/view")
async def unlock_artifact_view(
    organization_id: UUID, share_id: UUID, request: Request
) -> HTMLResponse:
    password = await _form_password(request)
    repository = cast(PostgresRenderRepository, request.app.state.render_repository)
    try:
        record, target = await unlock_share(repository, organization_id, share_id, password)
    except RenderConflict as error:
        if error.code == "artifact_share_rate_limited":
            response = _password_form(
                "This link has reached its unlock limit. Please try again in 15 minutes.",
                status_code=429,
            )
            response.headers["Retry-After"] = "900"
            return response
        return _password_form("The password or shared map is unavailable.", status_code=404)
    except RenderNotFound:
        return _password_form("The password or shared map is unavailable.", status_code=404)
    except RenderStoreUnavailable:
        return _password_form("The map could not open. Please try again later.", status_code=503)
    finally:
        password = ""
    try:
        ticket_url = await static_artifact_ticket(
            repository._artifact_downloads, request.app.state.settings.aws_region, target
        )
        # Revocation/withdrawal during credential resolution must withhold the
        # freshly signed ticket. This does not spend another password attempt.
        await recheck_share(repository, organization_id, share_id)
    except (RenderNotFound, RenderConflict):
        return _password_form("The password or shared map is unavailable.", status_code=404)
    except RenderStoreUnavailable:
        return _password_form("The map could not open. Please try again later.", status_code=503)
    except DownloadStorageUnavailable:
        return _password_form("Map delivery is unavailable.", status_code=503)
    # Do not let a misconfigured delivery adapter send the recipient or its
    # signed URL to an unrelated origin. The retained exact key/version is the
    # only allowed S3 object, and no query string is logged or persisted here.
    url = urlsplit(ticket_url)
    title = record["title"]
    content = (
        f"<h1>{escape(title)}</h1>"
        f'<iframe title="{escape(title, quote=True)}" src="{escape(ticket_url, quote=True)}" '
        'sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>'
        "<p>This is a compiled map viewer. It does not open Studio. "
        "An unlocked link lasts up to 15 minutes; downloaded copies can be kept.</p>"
    )
    return HTMLResponse(
        _document(title, content),
        headers={
            **HEADERS,
            "Content-Security-Policy": (
                "default-src 'none'; style-src 'unsafe-inline'; "
                f"frame-src https://{url.netloc}{url.path}; "
                "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"
            ),
        },
    )
