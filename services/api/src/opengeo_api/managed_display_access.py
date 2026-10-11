"""Explicit reviewed PMTiles reads bound to managed dataset versions and grants."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from opengeo_api.archive_upload_storage import ArchiveS3Storage
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.authorization import Action
from opengeo_api.catalog import CatalogConflict, CatalogNotFound, PostgresCatalogRepository
from opengeo_api.catalog_routes import execute_catalog, tenant_context
from opengeo_api.layer_archive_access import (
    ArchiveDescriptor,
    LayerArchiveRepository,
    ReadArchiveRequest,
)
from opengeo_api.tenant_database import TenantContext, TenantTransaction

router = APIRouter(tags=["managed layer displays"])


class ManagedDisplayRepository:
    def __init__(
        self,
        catalog: PostgresCatalogRepository,
        storage_factory: Callable[[str, str, str], ArchiveS3Storage] = ArchiveS3Storage,
    ) -> None:
        self.catalog = catalog
        self.storage_factory = storage_factory

    async def _read(
        self,
        context: TenantContext,
        project: UUID,
        dataset: UUID,
        version: UUID,
        display: UUID | None = None,
    ) -> list[tuple[Any, ...]]:
        async def operation(tx: TenantTransaction) -> list[tuple[Any, ...]]:
            roles = await self.catalog._access(tx, context, project, dataset)
            self.catalog._require(Action.DATASET_VERSION_READ, roles)
            if display is not None:
                self.catalog._require(Action.DATASET_DOWNLOAD, roles)
            active = await tx.fetch_one(
                """SELECT id FROM app.dataset_versions
                WHERE organization_id=%s AND dataset_id=%s AND id=%s AND state='active'""",
                (context.organization_id, dataset, version),
            )
            if active is None:
                raise CatalogNotFound("dataset_version")
            rows = await tx.fetch_all(
                """SELECT id,title,captured_at,descriptor FROM app.layer_archive_distributions
                WHERE organization_id=%s AND project_id=%s AND dataset_id=%s
                 AND dataset_version_id=%s AND source_version IS NULL AND enabled
                 AND (%s::uuid IS NULL OR id=%s)
                ORDER BY reviewed_at DESC,id LIMIT 21""",
                (context.organization_id, project, dataset, version, display, display),
            )
            if len(rows) > 20:
                raise CatalogConflict("display_selection_requires_review")
            for row in rows:
                if ArchiveDescriptor.model_validate(row[3]).format != "pmtiles":
                    raise CatalogConflict("managed_display_requires_tiles")
            return rows

        return await self.catalog._run(context, operation)

    async def list(
        self, context: TenantContext, project: UUID, dataset: UUID, version: UUID
    ) -> dict[str, Any]:
        rows = await self._read(context, project, dataset, version)
        return {
            "dataset_id": dataset,
            "dataset_version_id": version,
            "archives": [
                LayerArchiveRepository.metadata(row, ArchiveDescriptor.model_validate(row[3]))
                for row in rows
            ],
        }

    async def read_tickets(
        self, context: TenantContext, project: UUID, dataset: UUID, version: UUID, display: UUID
    ) -> dict[str, Any]:
        rows = await self._read(context, project, dataset, version, display)
        if len(rows) != 1:
            raise CatalogNotFound("managed_display")
        row = rows[0]
        descriptor = ArchiveDescriptor.model_validate(row[3])
        objects = []
        for obj in descriptor.objects:
            storage = self.storage_factory(obj.bucket, obj.prefix, obj.expected_owner)
            value = obj.model_dump(exclude_none=True)
            value["ticket"] = storage.sign_download(obj.key, obj.version_id)
            if obj.block_index is not None:
                value["block_index"]["ticket"] = storage.sign_download(
                    obj.block_index.key, obj.block_index.version_id
                )
            objects.append(value)
        # Do not release tickets if authority, state or the reviewed descriptor changed.
        if await self._read(context, project, dataset, version, display) != rows:
            raise CatalogConflict("managed_display_changed")
        return {
            **LayerArchiveRepository.metadata(row, descriptor),
            "dataset_id": dataset,
            "dataset_version_id": version,
            "objects": objects,
        }


def repository(request: Request) -> ManagedDisplayRepository:
    catalog = request.app.state.catalog_repository
    if not isinstance(catalog, PostgresCatalogRepository):
        raise HTTPException(503, detail="managed_display_unavailable")
    return ManagedDisplayRepository(catalog)


@router.get("/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/displays")
async def list_displays(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[ManagedDisplayRepository, Depends(repository)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return await execute_catalog(
        store.list(tenant_context(session), project_id, dataset_id, version_id)
    )


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/displays/{display_id}/read"
)
async def read_display(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    display_id: UUID,
    payload: ReadArchiveRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[ManagedDisplayRepository, Depends(repository)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return await execute_catalog(
        store.read_tickets(tenant_context(session), project_id, dataset_id, version_id, display_id)
    )
