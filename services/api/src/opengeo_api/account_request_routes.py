import hashlib
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, StringConstraints

from opengeo_api.account_requests import AccountRequestRepository, RequestState
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.config import Settings
from opengeo_api.logging import get_request_id
from opengeo_api.membership_routes import (
    DisplayName,
    EmailAddress,
    RequestModel,
    execute_membership,
)
from opengeo_api.memberships import InvitationDraft, MembershipRepository
from opengeo_api.tenant_database import TenantContext

router = APIRouter(prefix="/auth/account-requests", tags=["account requests"])


class CreateAccountRequest(RequestModel):
    email: EmailAddress
    display_name: DisplayName
    purpose: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=10, max_length=2000)
    ]
    website: str = Field(default="", max_length=500)


class AccountRequestReceipt(BaseModel):
    status: Literal["pending"] = "pending"


class AccountRequestResponse(BaseModel):
    id: UUID
    email: str
    display_name: str
    purpose: str
    state: RequestState
    invitation_id: UUID | None
    created_at: datetime
    reviewed_at: datetime | None


class ReviewAccountRequest(RequestModel):
    decision: Literal["approve", "reject"]


def repository(request: Request) -> AccountRequestRepository:
    return cast(AccountRequestRepository, request.app.state.account_request_repository)


def configured_settings(request: Request) -> Settings:
    settings = cast(Settings, request.app.state.settings)
    if not (settings.account_request_organization_id and settings.account_request_reviewer_user_id):
        raise HTTPException(503, detail="account_requests_unavailable")
    return settings


def reviewer_context(
    request: Request, session: Annotated[AuthSession, Depends(current_session)]
) -> TenantContext:
    settings = configured_settings(request)
    membership = session.selected_membership
    if (
        session.principal.user_id != settings.account_request_reviewer_user_id
        or membership is None
        or membership.organization_id != settings.account_request_organization_id
        or membership.role != "admin"
    ):
        raise HTTPException(403, detail="action_forbidden")
    return TenantContext(session.principal.user_id, membership.organization_id)


@router.post("", response_model=AccountRequestReceipt, status_code=202)
async def submit_account_request(
    body: CreateAccountRequest,
    request: Request,
    response: Response,
    store: Annotated[AccountRequestRepository, Depends(repository)],
) -> AccountRequestReceipt:
    response.headers["Cache-Control"] = "no-store"
    settings = configured_settings(request)
    if body.website:
        return AccountRequestReceipt()
    assert settings.account_request_organization_id is not None
    assert settings.account_request_reviewer_user_id is not None
    # The gateway/ASGI peer is used; untrusted forwarded headers cannot reset limits.
    peer = request.client.host if request.client else "unknown"
    fingerprint = hashlib.sha256(
        f"{settings.account_request_reviewer_user_id}:{peer}".encode()
    ).hexdigest()
    result = await execute_membership(
        store.submit(
            settings.account_request_organization_id,
            settings.account_request_reviewer_user_id,
            body.email.lower(),
            body.display_name,
            body.purpose.strip(),
            fingerprint,
        )
    )
    if result == "rate_limited":
        raise HTTPException(
            429, detail="account_request_rate_limited", headers={"Retry-After": "3600"}
        )
    if result != "pending":
        raise HTTPException(503, detail="account_requests_unavailable")
    return AccountRequestReceipt()


@router.get("", response_model=list[AccountRequestResponse])
async def list_account_requests(
    response: Response,
    context: Annotated[TenantContext, Depends(reviewer_context)],
    store: Annotated[AccountRequestRepository, Depends(repository)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=10000)] = 0,
) -> list[AccountRequestResponse]:
    response.headers["Cache-Control"] = "no-store"
    records = await execute_membership(store.list_requests(context, limit, offset))
    return [AccountRequestResponse(**asdict(record)) for record in records]


@router.post("/{request_id}/review", response_model=AccountRequestResponse)
async def review_account_request(
    request_id: UUID,
    body: ReviewAccountRequest,
    request: Request,
    response: Response,
    context: Annotated[TenantContext, Depends(reviewer_context)],
    store: Annotated[AccountRequestRepository, Depends(repository)],
) -> AccountRequestResponse:
    response.headers["Cache-Control"] = "no-store"
    if body.decision == "reject":
        record = await execute_membership(store.reject(context, request_id))
    else:
        record = await execute_membership(store.get(context, request_id))
        memberships = cast(MembershipRepository, request.app.state.membership_repository)
        await execute_membership(
            memberships.create_invitation(
                context,
                InvitationDraft(
                    email=record.email,
                    display_name=record.display_name,
                    organization_role="member",
                    project_id=None,
                    project_role=None,
                    expires_at=datetime.now(UTC) + timedelta(days=7),
                    account_request_id=request_id,
                ),
                get_request_id(),
            )
        )
        record = await execute_membership(store.get(context, request_id))
    return AccountRequestResponse(**asdict(record))
