"""Bounded, session-authorized read tools for the MCP transport.

Repositories retain their normal permission and transaction-local RLS checks.
Catalog presentation IDs, custody metadata and canonical composition identity
are returned without creating resources or resolving external references.
"""

import json
from copy import deepcopy
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import require_organization
from opengeo_api.ingestion import IngestionRepository
from opengeo_api.ingestion_routes import (
    DatasetKnowledgeResponse,
    LayerCatalogResponse,
    execute_ingestion,
)
from opengeo_api.resource_knowledge import MAX_KNOWLEDGE_BYTES
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspace_routes import (
    CompositionResponse,
    CompositionSummaryResponse,
    execute_workspace,
    map_response,
)
from opengeo_api.workspaces import Page, WorkspaceRepository

_RESULT_BYTES = {
    "search_catalog_layers": 262_144,
    "get_layer_metadata": 65_536,
    "list_projects": 262_144,
    "get_project": 655_360,
}


def _uuid_argument(value: Any) -> UUID:
    if not isinstance(value, str):
        raise ValueError("UUID must be a string")
    parsed = UUID(value)
    if str(parsed) != value.lower():
        raise ValueError("UUID must use its hyphenated representation")
    return parsed


UuidArgument = Annotated[UUID, BeforeValidator(_uuid_argument)]
QueryArgument = Annotated[str, Field(strict=True, max_length=200)]
LimitArgument = Annotated[int, Field(strict=True, ge=1, le=100)]


class _Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _CatalogArguments(_Arguments):
    query: QueryArgument = ""
    limit: LimitArgument = 25
    offset: Annotated[int, Field(strict=True, ge=0, le=100_000)] = 0


class _MetadataArguments(_Arguments):
    dataset_id: UuidArgument
    version: Annotated[int, Field(strict=True, ge=1, le=2_147_483_647)] | None = None


class _ProjectsArguments(_Arguments):
    query: QueryArgument = ""
    status: Literal["active", "archived", "all"] = "active"
    limit: LimitArgument = 25
    offset: Annotated[int, Field(strict=True, ge=0, le=10_000)] = 0


class _ProjectArguments(_Arguments):
    composition_id: UuidArgument


_ARGUMENT_MODELS = {
    "search_catalog_layers": _CatalogArguments,
    "get_layer_metadata": _MetadataArguments,
    "list_projects": _ProjectsArguments,
    "get_project": _ProjectArguments,
}
_DESCRIPTIONS = {
    "search_catalog_layers": (
        "Search a bounded page of authorized Catalog Layer summaries. dataset_id is the "
        "persistent resource identity; layer_id and map_id describe saved presentations. "
        "Recorded source facts do not assert custody, license or access rights: read Layer "
        "metadata for those claims. This tool never follows provider URLs or loads metadata "
        "for every result."
    ),
    "get_layer_metadata": (
        "Read one authorized Layer's metadata knowledge, optionally at an exact revision. "
        "Preserve distribution custody, provenance and source/normalized/curated/inferred "
        "claims, including unknown rights. Metadata is descriptive and never grants access. "
        "Version zero and an empty knowledge document mean no saved assertions."
    ),
    "list_projects": (
        "List authorized canonical Project compositions, with their persistent IDs and "
        "versions. access_container_id identifies compatibility access storage, not the "
        "canonical Project. This bounded summary read does not build or publish anything."
    ),
    "get_project": (
        "Read one authorized canonical Project composition and its saved Layer references, "
        "Styles and configuration. composition_id is the Project identity; "
        "access_container_id remains separate. No referenced data is fetched or copied."
    ),
}


def tool_definitions() -> list[dict[str, Any]]:
    """Return detached MCP tool schemas with no authority or mutation parameters."""
    definitions = []
    for name, model in _ARGUMENT_MODELS.items():
        schema = model.model_json_schema()
        schema.pop("title", None)
        # Omission selects the current metadata revision; explicit null is not
        # part of the public input contract.
        if name == "get_layer_metadata":
            schema["properties"]["version"] = {
                "type": "integer",
                "minimum": 1,
                "maximum": 2_147_483_647,
            }
        definitions.append(
            {
                "name": name,
                "description": _DESCRIPTIONS[name],
                "inputSchema": schema,
                "annotations": {
                    "readOnlyHint": True,
                    "destructiveHint": False,
                    "idempotentHint": True,
                    "openWorldHint": False,
                },
            }
        )
    return deepcopy(definitions)


def _bounded_result(value: dict[str, Any], maximum: int) -> dict[str, Any]:
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="mcp_repository_result_invalid") from error
    if len(encoded) > maximum:
        raise HTTPException(status_code=413, detail="mcp_result_too_large")
    return json.loads(encoded)


async def execute_read_tool(
    session: AuthSession,
    name: str,
    arguments: dict[str, Any],
    *,
    ingestion_repository: IngestionRepository,
    workspace_repository: WorkspaceRepository,
) -> dict[str, Any]:
    """Execute one explicit read through the same repositories as the REST API."""
    if not isinstance(session, AuthSession):
        raise HTTPException(status_code=401, detail="authentication_required")
    membership = require_organization(session)
    if membership not in session.principal.memberships:
        raise HTTPException(status_code=403, detail="organization_access_denied")
    context = TenantContext(session.principal.user_id, membership.organization_id)
    if not isinstance(name, str) or name not in _ARGUMENT_MODELS:
        raise HTTPException(status_code=422, detail="mcp_tool_not_found")
    if not isinstance(arguments, dict) or (
        name == "get_layer_metadata" and "version" in arguments and arguments["version"] is None
    ):
        raise HTTPException(status_code=422, detail="mcp_tool_arguments_invalid")
    try:
        values = _ARGUMENT_MODELS[name].model_validate(arguments)
    except ValidationError as error:
        raise HTTPException(status_code=422, detail="mcp_tool_arguments_invalid") from error

    try:
        if isinstance(values, _CatalogArguments):
            records = await execute_ingestion(
                ingestion_repository.search_layers(
                    context,
                    query=values.query,
                    limit=values.limit,
                    offset=values.offset,
                )
            )
            if len(records) > values.limit:
                raise HTTPException(status_code=503, detail="mcp_repository_result_invalid")
            result = {
                "layers": [
                    LayerCatalogResponse.model_validate(record).model_dump(mode="json")
                    for record in records
                ],
                "limit": values.limit,
                "offset": values.offset,
                "returned": len(records),
            }
        elif isinstance(values, _MetadataArguments):
            record = await execute_ingestion(
                ingestion_repository.get_dataset_knowledge(
                    context, values.dataset_id, values.version
                )
            )
            result = DatasetKnowledgeResponse.model_validate(record).model_dump(mode="json")
            _bounded_result(result["document"], MAX_KNOWLEDGE_BYTES)
        elif isinstance(values, _ProjectsArguments):
            records = await execute_workspace(
                workspace_repository.list_compositions(
                    context,
                    Page(values.limit, values.offset),
                    values.query.strip(),
                    None if values.status == "all" else values.status,
                )
            )
            if len(records) > values.limit:
                raise HTTPException(status_code=503, detail="mcp_repository_result_invalid")
            result = {
                "projects": [
                    CompositionSummaryResponse(
                        id=record.composition_id,
                        access_container_id=record.access_container_id,
                        access_container_name=record.access_container_name,
                        name=record.name,
                        description=record.description,
                        status=record.status,
                        version=record.version,
                        updated_at=record.updated_at,
                        owner_user_id=record.owner_user_id,
                    ).model_dump(mode="json")
                    for record in records
                ],
                "limit": values.limit,
                "offset": values.offset,
                "returned": len(records),
            }
        else:
            record = await execute_workspace(
                workspace_repository.get_composition(context, values.composition_id)
            )
            result = CompositionResponse(
                **map_response(record).model_dump(exclude={"project_id"}),
                access_container_id=record.project_id,
                owner_user_id=record.owner_user_id,
            ).model_dump(mode="json")
            _bounded_result(result["definition"], 524_288)
    except ValidationError as error:
        raise HTTPException(status_code=503, detail="mcp_repository_result_invalid") from error
    return _bounded_result(result, _RESULT_BYTES[name])
