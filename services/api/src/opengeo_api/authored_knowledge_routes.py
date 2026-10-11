from collections.abc import Awaitable
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response

from opengeo_api.authored_knowledge import PostgresAuthoredKnowledgeRepository
from opengeo_api.collection_routes import Session
from opengeo_api.collection_routes import execute as execute_collection
from opengeo_api.ingestion_routes import DatasetKnowledgeRequest
from opengeo_api.workspace_routes import tenant_context

router = APIRouter(tags=["authored resource knowledge"])
Kind = Literal["project", "publication", "collection"]


async def execute(operation: Awaitable[dict[str, Any]], response: Response) -> dict[str, Any]:
    try:
        return await execute_collection(operation, response)
    except HTTPException as error:
        if isinstance(error.detail, str) and error.detail.startswith("collection_"):
            error.detail = "resource_knowledge_" + error.detail.removeprefix("collection_")
        raise


@router.get("/resource-knowledge/{kind}/{identity}")
async def read_knowledge(
    kind: Kind,
    identity: UUID,
    request: Request,
    response: Response,
    session: Session,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> dict[str, Any]:
    return await execute(
        cast(
            PostgresAuthoredKnowledgeRepository, request.app.state.authored_knowledge_repository
        ).read(tenant_context(session), kind, identity, version),
        response,
    )


@router.put("/resource-knowledge/{kind}/{identity}")
async def save_knowledge(
    kind: Kind,
    identity: UUID,
    draft: DatasetKnowledgeRequest,
    request: Request,
    response: Response,
    session: Session,
) -> dict[str, Any]:
    return await execute(
        cast(
            PostgresAuthoredKnowledgeRepository, request.app.state.authored_knowledge_repository
        ).save(tenant_context(session), kind, identity, draft.document, draft.expected_version),
        response,
    )
