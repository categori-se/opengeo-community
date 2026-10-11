"""Explicit authenticated CKAN reads; existing metadata persistence owns imports."""

import asyncio
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session, require_organization
from opengeo_api.authorization import Action, Roles, is_allowed
from opengeo_api.ckan import CkanClient, CkanFailure, build_ckan_import_plan
from opengeo_api.logging import get_request_id
from opengeo_api.metadata_adapters import metadata_source_checksum
from opengeo_api.resource_routes import (
    execute_resource,
    resource_response,
    tenant_context,
)
from opengeo_api.resource_routes import (
    repository_from_request as resource_repository,
)
from opengeo_api.resources import ResourceRepository
from opengeo_api.workspace_routes import (
    execute_workspace,
)
from opengeo_api.workspace_routes import (
    repository_from_request as workspace_repository,
)
from opengeo_api.workspaces import WorkspaceRepository

router = APIRouter(tags=["CKAN catalog connector"])


class SourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_url: str = Field(min_length=9, max_length=2_048)


class SearchRequest(SourceRequest):
    query: str = Field(default="", max_length=400)
    organization: str | None = Field(default=None, min_length=1, max_length=100)
    start: int = Field(default=0, ge=0, le=10_000)
    rows: int = Field(default=20, ge=1, le=20)


class DatasetRequest(SourceRequest):
    dataset_id: str = Field(min_length=1, max_length=100)


class PreviewRequest(DatasetRequest):
    resource_id: str = Field(min_length=1, max_length=100)


class ImportRequest(DatasetRequest):
    package_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class BulkImportRequest(SourceRequest):
    packages: list[dict[str, Any]] = Field(min_length=1, max_length=20)


def client_from_request(request: Request) -> CkanClient:
    return cast(CkanClient, getattr(request.app.state, "ckan_client", None) or CkanClient())


Session = Annotated[AuthSession, Depends(current_session)]
Workspace = Annotated[WorkspaceRepository, Depends(workspace_repository)]
Resources = Annotated[ResourceRepository, Depends(resource_repository)]
Client = Annotated[CkanClient, Depends(client_from_request)]


async def _authority(
    session: AuthSession,
    workspace: WorkspaceRepository,
    project_id: UUID,
    *,
    write: bool = False,
) -> None:
    # Check local access before any outbound request; recheck again at import commit.
    membership = require_organization(session)
    project = await execute_workspace(workspace.get_project(tenant_context(session), project_id))
    roles = Roles(organization=membership.role, project=project.caller_role)
    if not is_allowed(Action.RESOURCE_CREATE if write else Action.PROJECT_READ, roles):
        raise HTTPException(status_code=403, detail="action_forbidden")


def _failure(error: CkanFailure) -> HTTPException:
    code = str(error)
    if code == "ckan_upstream_unavailable":
        return HTTPException(status_code=503, detail={"code": code})
    if code in {"ckan_action_failed", "ckan_response_invalid", "ckan_identity_mismatch"}:
        return HTTPException(status_code=502, detail={"code": code})
    return HTTPException(status_code=422, detail={"code": code})


@router.post("/projects/{project_id}/ckan/search")
async def search_ckan(
    project_id: UUID,
    body: SearchRequest,
    session: Session,
    workspace: Workspace,
    client: Client,
) -> dict[str, Any]:
    await _authority(session, workspace, project_id)
    try:
        return await client.search(**body.model_dump())
    except CkanFailure as error:
        raise _failure(error) from error


@router.post("/projects/{project_id}/ckan/inspect")
async def inspect_ckan(
    project_id: UUID,
    body: DatasetRequest,
    session: Session,
    workspace: Workspace,
    client: Client,
) -> dict[str, Any]:
    await _authority(session, workspace, project_id)
    try:
        package = await client.package(body.source_url, body.dataset_id)
        plan = build_ckan_import_plan(body.source_url, package, observation="anonymous_action_api")
        return {
            "package": package,
            "package_sha256": metadata_source_checksum(package),
            "dcat": plan.source_document,
            "report": plan.conversion_report,
        }
    except CkanFailure as error:
        raise _failure(error) from error


@router.post("/projects/{project_id}/ckan/preview")
async def preview_ckan(
    project_id: UUID,
    body: PreviewRequest,
    session: Session,
    workspace: Workspace,
    client: Client,
) -> dict[str, Any]:
    await _authority(session, workspace, project_id)
    try:
        # The two upstream reads share a deadline below the request API's timeout.
        async with asyncio.timeout(20):
            package = await client.package(body.source_url, body.dataset_id)
            resources = package.get("resources", [])
            if not isinstance(resources, list) or not any(
                isinstance(item, dict)
                and item.get("id") == body.resource_id
                and item.get("state", "active") == "active"
                and item.get("datastore_active") is True
                for item in resources
            ):
                raise CkanFailure("ckan_datastore_resource_unavailable")
            return await client.preview(body.source_url, body.resource_id)
    except TimeoutError as error:
        raise HTTPException(
            status_code=503, detail={"code": "ckan_upstream_unavailable"}
        ) from error
    except CkanFailure as error:
        raise _failure(error) from error


@router.post("/projects/{project_id}/ckan/import", status_code=201)
async def import_ckan(
    project_id: UUID,
    body: ImportRequest,
    session: Session,
    workspace: Workspace,
    repository: Resources,
    client: Client,
) -> dict[str, Any]:
    await _authority(session, workspace, project_id, write=True)
    try:
        package = await client.package(body.source_url, body.dataset_id)
        if metadata_source_checksum(package) != body.package_sha256:
            raise HTTPException(status_code=409, detail={"code": "ckan_snapshot_changed"})
        plan = build_ckan_import_plan(body.source_url, package, observation="anonymous_action_api")
    except CkanFailure as error:
        raise _failure(error) from error
    result = await execute_resource(
        repository.import_metadata_resource(
            tenant_context(session),
            project_id,
            plan,
            get_request_id(),
        )
    )
    return {
        "resource": resource_response(result.resource),
        "idempotent": result.idempotent,
        "report": result.source.conversion_report,
    }


@router.post("/projects/{project_id}/ckan/imports")
async def bulk_import_ckan(
    project_id: UUID,
    body: BulkImportRequest,
    session: Session,
    workspace: Workspace,
    repository: Resources,
) -> dict[str, Any]:
    """Register an explicit finite metadata batch; report independent committed outcomes."""
    await _authority(session, workspace, project_id, write=True)
    try:
        plans = [build_ckan_import_plan(body.source_url, package) for package in body.packages]
        if len({plan.source_identifier for plan in plans}) != len(plans):
            raise CkanFailure("ckan_duplicate_dataset")
    except CkanFailure as error:
        raise _failure(error) from error
    outcomes = []
    for index, plan in enumerate(plans):
        try:
            result = await execute_resource(
                repository.import_metadata_resource(
                    tenant_context(session),
                    project_id,
                    plan,
                    get_request_id(),
                )
            )
            outcomes.append(
                {
                    "package_id": plan.conversion_report["ckan"]["packageId"],
                    "status": "reused" if result.idempotent else "created",
                    "resource": resource_response(result.resource),
                }
            )
        except HTTPException as error:
            # A later failure must not conceal earlier committed rows or cause their replay.
            outcomes.append(
                {
                    "package_id": plan.conversion_report["ckan"]["packageId"],
                    "status": "unresolved",
                    "error": error.detail,
                }
            )
            if error.status_code in {403, 404, 503}:
                outcomes.extend(
                    {
                        "package_id": pending.conversion_report["ckan"]["packageId"],
                        "status": "unresolved",
                        "error": "batch_stopped",
                    }
                    for pending in plans[index + 1 :]
                )
                break
    return {
        "outcomes": outcomes,
        "counts": {
            state: sum(item["status"] == state for item in outcomes)
            for state in ("created", "reused", "unresolved")
        },
    }
