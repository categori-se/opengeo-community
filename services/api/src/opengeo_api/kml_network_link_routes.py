import asyncio
import hashlib
import logging
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Annotated, Literal, Protocol, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.kml_network_links import (
    ALLOWED_MEDIA_TYPES,
    NetworkLinkConditional,
    NetworkLinkFailure,
    NetworkLinkFetcher,
    NetworkLinkFetchReceipt,
    NetworkLinkFetchRequest,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseUnavailable,
    TenantQueryExecutor,
)
from opengeo_api.workspace_routes import execute_workspace, repository_from_request, tenant_context
from opengeo_api.workspaces import WorkspaceRepository

logger = logging.getLogger(__name__)
router = APIRouter(tags=["KML NetworkLink"])

LinkId = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_.-]{0,159}$"),
]
Url = Annotated[str, StringConstraints(min_length=1, max_length=2_048)]
Header = Annotated[str, StringConstraints(min_length=1, max_length=512)]
Reason = Literal["initial", "manual", "interval", "expire", "view-stop", "view-request", "region"]
MediaType = Literal[
    "application/vnd.google-earth.kml+xml",
    "application/vnd.google-earth.kmz",
    "application/xml",
    "text/xml",
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConditionalRequest(RequestModel):
    etag: Header | None = None
    last_modified: Header | None = None


class TransportRequest(RequestModel):
    credentials: Literal["omit"]
    redirect: Literal["error"]
    referrer_policy: Literal["no-referrer"] = Field(alias="referrerPolicy")
    cache: Literal["no-store"]


class NetworkLinkRefreshRequest(RequestModel):
    schema_version: Literal["1.0.0"]
    link_id: LinkId
    reason: Reason
    source_href: Url
    request_url: Url
    requested_at: AwareDatetime
    maximum_bytes: Literal[262_144]
    timeout_milliseconds: Literal[10_000]
    accept: list[MediaType] = Field(min_length=1, max_length=4)
    conditional: ConditionalRequest
    transport: TransportRequest
    security_contract: Literal["public-https-dns-pinned-no-redirect-no-credentials-v1"]

    @field_validator("accept")
    @classmethod
    def unique_media_types(cls, value: list[MediaType]) -> list[MediaType]:
        if len(value) != len(set(value)) or any(item not in ALLOWED_MEDIA_TYPES for item in value):
            raise ValueError("accept media types must be unique and supported")
        return value


class NetworkLinkRefreshResponse(BaseModel):
    request_url: str
    final_url: str
    status: Literal[200, 304]
    redirects: Literal[0]
    dns_pinned: Literal[True]
    all_addresses_public: Literal[True]
    tls_verified: Literal[True]
    credentials_sent: Literal[False]
    media_type: MediaType
    byte_length: int = Field(ge=0, le=262_144)
    fetched_at: datetime
    expires_at: datetime | None
    etag: str | None
    last_modified: str | None
    body_text: str | None = None
    body_base64: str | None = None


class NetworkLinkGateFailure(RuntimeError):
    def __init__(
        self,
        code: Literal[
            "network_link_rate_limited",
            "network_link_busy",
            "network_link_gate_unavailable",
        ],
    ) -> None:
        self.code = code
        super().__init__(code)


class NetworkLinkGate(Protocol):
    def slot(self, key: tuple[UUID, UUID, UUID]) -> AbstractAsyncContextManager[None]: ...


class NetworkLinkRequestGate:
    """A bounded warm-runtime gate; API Gateway and Lambda add account-wide ceilings."""

    def __init__(
        self,
        *,
        maximum_per_minute: int = 60,
        maximum_per_key_concurrent: int = 4,
        maximum_runtime_concurrent: int = 8,
    ) -> None:
        if not (
            1 <= maximum_per_minute <= 60
            and 1 <= maximum_per_key_concurrent <= 4
            and maximum_per_key_concurrent <= maximum_runtime_concurrent <= 8
        ):
            raise ValueError("NetworkLink request gate limits cannot be widened")
        self._maximum_per_minute = maximum_per_minute
        self._maximum_per_key_concurrent = maximum_per_key_concurrent
        self._maximum_runtime_concurrent = maximum_runtime_concurrent
        self._lock = asyncio.Lock()
        self._windows: dict[tuple[UUID, UUID, UUID], deque[float]] = defaultdict(deque)
        self._active: dict[tuple[UUID, UUID, UUID], int] = defaultdict(int)
        self._runtime_active = 0

    @asynccontextmanager
    async def slot(self, key: tuple[UUID, UUID, UUID]) -> AsyncIterator[None]:
        now = monotonic()
        async with self._lock:
            window = self._windows[key]
            while window and window[0] <= now - 60:
                window.popleft()
            if len(window) >= self._maximum_per_minute:
                raise NetworkLinkGateFailure("network_link_rate_limited")
            if (
                self._active[key] >= self._maximum_per_key_concurrent
                or self._runtime_active >= self._maximum_runtime_concurrent
            ):
                raise NetworkLinkGateFailure("network_link_busy")
            window.append(now)
            self._active[key] += 1
            self._runtime_active += 1
        try:
            yield
        finally:
            async with self._lock:
                self._active[key] -= 1
                self._runtime_active -= 1
                if self._active[key] == 0:
                    self._active.pop(key, None)


class PostgresNetworkLinkRequestGate:
    """Database-leased quota shared by every request-driven API runtime."""

    def __init__(self, executor: TenantQueryExecutor) -> None:
        self._executor = executor

    @asynccontextmanager
    async def slot(self, key: tuple[UUID, UUID, UUID]) -> AsyncIterator[None]:
        organization_id, project_id, user_id = key
        request_id = uuid4()
        context = TenantContext(user_id=user_id, organization_id=organization_id)
        try:
            row = await self._executor.fetch_one(
                context,
                "SELECT app.acquire_kml_network_link_request_slot(%s, %s, %s)",
                (request_id, project_id, user_id),
            )
        except TenantDatabaseUnavailable as error:
            raise NetworkLinkGateFailure("network_link_gate_unavailable") from error
        result = row[0] if row is not None and len(row) == 1 else None
        if result == "rate_limited":
            raise NetworkLinkGateFailure("network_link_rate_limited")
        if result == "busy":
            raise NetworkLinkGateFailure("network_link_busy")
        if result != "acquired":
            raise NetworkLinkGateFailure("network_link_gate_unavailable")

        try:
            yield
        finally:
            try:
                released = await self._executor.fetch_one(
                    context,
                    "SELECT app.release_kml_network_link_request_slot(%s, %s, %s)",
                    (request_id, project_id, user_id),
                )
            except TenantDatabaseUnavailable:
                logger.error(
                    "kml_network_link_quota_release_failed",
                    extra={
                        "organization_id": str(organization_id),
                        "project_id": str(project_id),
                        "user_id": str(user_id),
                        "request_id": str(request_id),
                    },
                )
            else:
                if released != (True,):
                    logger.error(
                        "kml_network_link_quota_release_missing",
                        extra={
                            "organization_id": str(organization_id),
                            "project_id": str(project_id),
                            "user_id": str(user_id),
                            "request_id": str(request_id),
                        },
                    )


def fetcher_from_request(request: Request) -> NetworkLinkFetcher:
    return cast(NetworkLinkFetcher, request.app.state.kml_network_link_fetcher)


def gate_from_request(request: Request) -> NetworkLinkGate:
    return cast(NetworkLinkGate, request.app.state.kml_network_link_request_gate)


@router.post(
    "/projects/{project_id}/kml-network-links/refresh",
    response_model=NetworkLinkRefreshResponse,
)
async def refresh_network_link(
    project_id: UUID,
    payload: NetworkLinkRefreshRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[WorkspaceRepository, Depends(repository_from_request)],
    fetcher: Annotated[NetworkLinkFetcher, Depends(fetcher_from_request)],
    gate: Annotated[NetworkLinkGate, Depends(gate_from_request)],
) -> NetworkLinkRefreshResponse:
    project = await execute_workspace(repository.get_project(tenant_context(session), project_id))
    if project.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="project_archived")
    now = datetime.now(UTC)
    requested_at = payload.requested_at.astimezone(UTC)
    if requested_at < now - timedelta(seconds=30) or requested_at > now + timedelta(seconds=5):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="kml_network_link_request_time_invalid",
        )
    request = NetworkLinkFetchRequest(
        link_id=payload.link_id,
        reason=payload.reason,
        source_href=payload.source_href,
        request_url=payload.request_url,
        requested_at=requested_at,
        maximum_bytes=payload.maximum_bytes,
        timeout_milliseconds=payload.timeout_milliseconds,
        accept=tuple(payload.accept),
        conditional=NetworkLinkConditional(
            etag=payload.conditional.etag,
            last_modified=payload.conditional.last_modified,
        ),
    )
    membership = tenant_context(session)
    key = (membership.organization_id, project_id, membership.user_id)
    started = monotonic()
    try:
        async with gate.slot(key):
            receipt = await fetcher.fetch(request)
    except NetworkLinkGateFailure as error:
        if error.code == "network_link_gate_unavailable":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=error.code,
                headers={"Retry-After": "1"},
            ) from error
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=error.code,
            headers={"Retry-After": "60" if error.code.endswith("rate_limited") else "1"},
        ) from error
    except NetworkLinkFailure as error:
        raise _fetch_error(error) from error
    logger.info(
        "kml_network_link_fetch_completed",
        extra={
            "organization_id": str(membership.organization_id),
            "project_id": str(project_id),
            "user_id": str(membership.user_id),
            "link_id": payload.link_id,
            "target_sha256": hashlib.sha256(payload.request_url.encode("ascii")).hexdigest(),
            "status": receipt.status,
            "byte_length": receipt.byte_length,
            "duration_ms": min(10_000, max(0, round((monotonic() - started) * 1_000))),
        },
    )
    return _response(receipt)


def _fetch_error(error: NetworkLinkFailure) -> HTTPException:
    if error.code in {"unsafe_network_target", "response_invalid"}:
        code = status.HTTP_422_UNPROCESSABLE_CONTENT
    elif error.code == "request_timeout":
        code = status.HTTP_504_GATEWAY_TIMEOUT
    else:
        code = status.HTTP_502_BAD_GATEWAY
    return HTTPException(status_code=code, detail=f"kml_network_link_{error.code}")


def _response(receipt: NetworkLinkFetchReceipt) -> NetworkLinkRefreshResponse:
    return NetworkLinkRefreshResponse(
        request_url=receipt.request_url,
        final_url=receipt.final_url,
        status=cast(Literal[200, 304], receipt.status),
        redirects=0,
        dns_pinned=True,
        all_addresses_public=True,
        tls_verified=True,
        credentials_sent=False,
        media_type=cast(MediaType, receipt.media_type),
        byte_length=receipt.byte_length,
        fetched_at=receipt.fetched_at,
        expires_at=receipt.expires_at,
        etag=receipt.etag,
        last_modified=receipt.last_modified,
        body_text=receipt.body_text,
        body_base64=receipt.body_base64,
    )
