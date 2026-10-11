import logging
from collections.abc import Awaitable
from datetime import datetime
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.logging import get_request_id
from opengeo_api.resource_ratings import (
    ResourceRatingAccessDenied,
    ResourceRatingConflict,
    ResourceRatingMutationReceipt,
    ResourceRatingNotFound,
    ResourceRatingRepository,
    ResourceRatingStoreUnavailable,
    ResourceRatingSummary,
)
from opengeo_api.tenant_database import TenantContext

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Resource ratings"])


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetResourceRatingRequest(RequestModel):
    score: int | None = Field(default=None, ge=1, le=5)
    expected_version: int | None = Field(default=None, ge=1, le=2_147_483_647)


class ResourceRatingSummaryResponse(BaseModel):
    project_id: UUID
    resource_id: UUID
    rating_count: int
    rating_average: float | None
    caller_score: int | None
    caller_version: int | None
    caller_withdrawn: bool
    updated_at: datetime | None


class ResourceRatingMutationResponse(BaseModel):
    changed: bool
    summary: ResourceRatingSummaryResponse


def repository_from_request(request: Request) -> ResourceRatingRepository:
    return cast(ResourceRatingRepository, request.app.state.resource_rating_repository)


def tenant_context(session: AuthSession) -> TenantContext:
    membership = require_organization(session)
    return TenantContext(session.principal.user_id, membership.organization_id)


async def execute_rating[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except ResourceRatingAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except ResourceRatingNotFound as error:
        raise HTTPException(status_code=404, detail="resource_not_found") from error
    except ResourceRatingConflict as error:
        detail: dict[str, object] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except ResourceRatingStoreUnavailable as error:
        logger.error(
            "resource_rating.store_unavailable",
            extra={"error_type": type(error).__name__},
        )
        raise HTTPException(status_code=503, detail="resource_rating_store_unavailable") from error


@router.get(
    "/projects/{project_id}/resources/{resource_id}/rating",
    response_model=ResourceRatingSummaryResponse,
)
async def get_resource_rating(
    project_id: UUID,
    resource_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRatingRepository, Depends(repository_from_request)],
) -> ResourceRatingSummaryResponse:
    summary = await execute_rating(
        repository.get_summary(tenant_context(session), project_id, resource_id)
    )
    return rating_summary_response(summary)


@router.post(
    "/projects/{project_id}/resources/{resource_id}/rating",
    response_model=ResourceRatingMutationResponse,
)
async def set_resource_rating(
    project_id: UUID,
    resource_id: UUID,
    payload: SetResourceRatingRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[ResourceRatingRepository, Depends(repository_from_request)],
) -> ResourceRatingMutationResponse:
    receipt = await execute_rating(
        repository.set_rating(
            tenant_context(session),
            project_id,
            resource_id,
            payload.score,
            payload.expected_version,
            get_request_id(),
        )
    )
    return rating_mutation_response(receipt)


def rating_summary_response(summary: ResourceRatingSummary) -> ResourceRatingSummaryResponse:
    return ResourceRatingSummaryResponse(
        project_id=summary.project_id,
        resource_id=summary.resource_id,
        rating_count=summary.rating_count,
        rating_average=summary.rating_average,
        caller_score=summary.caller_score,
        caller_version=summary.caller_version,
        caller_withdrawn=summary.caller_withdrawn,
        updated_at=summary.updated_at,
    )


def rating_mutation_response(
    receipt: ResourceRatingMutationReceipt,
) -> ResourceRatingMutationResponse:
    return ResourceRatingMutationResponse(
        changed=receipt.changed,
        summary=rating_summary_response(receipt.summary),
    )
