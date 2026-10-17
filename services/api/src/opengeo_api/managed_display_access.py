"""Explicit reviewed PMTiles reads bound to managed dataset versions and grants."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    Sha,
)
from opengeo_api.tenant_database import TenantContext, TenantTransaction

router = APIRouter(tags=["managed layer displays"])


class ReviewPmtilesDisplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_review_sha256: Sha
    title: str = Field(min_length=1, max_length=200)
    rights_basis: str = Field(min_length=1, max_length=2000)
    attribution: str = Field(min_length=1, max_length=2000)
    acknowledge_conversion_limits: Literal[True]

    @field_validator("title", "rights_basis", "attribution")
    @classmethod
    def reviewed_text(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("Reviewed text must be nonempty without surrounding whitespace")
        return value

    @field_validator("title")
    @classmethod
    def plain_title(cls, value: str) -> str:
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("A plain display title is required")
        return value

    @field_validator("acknowledge_conversion_limits", mode="before")
    @classmethod
    def explicit_boolean(cls, value: object) -> Literal[True]:
        if value is not True:
            raise ValueError("Explicit conversion limit acknowledgement required")
        return value


class ManagedDisplayRepository:
    def __init__(
        self,
        catalog: PostgresCatalogRepository,
        storage_factory: Callable[[str, str, str], ArchiveS3Storage] = ArchiveS3Storage,
    ) -> None:
        self.catalog = catalog
        self.storage_factory = storage_factory

    async def _pmtiles_review(
        self,
        tx: TenantTransaction,
        context: TenantContext,
        project: UUID,
        dataset: UUID,
        version: UUID,
        job: UUID,
    ) -> dict[str, Any]:
        roles = await self.catalog._access(tx, context, project, dataset)
        self.catalog._require(Action.PROJECT_DATASETS_MANAGE, roles)
        row = await tx.fetch_one(
            """SELECT validation.review_sha256, validation.validation,
                job.source_object_id, job.output_object_id, job.finished_at,
                job.request_checksum_sha256, job.output_size_bytes,
                job.output_checksum_sha256, display.id
            FROM app.pmtiles_derivative_jobs job
            JOIN app.projects project ON project.organization_id=job.organization_id
                AND project.id=job.project_id AND project.status='active'
            JOIN app.datasets dataset ON dataset.organization_id=job.organization_id
                AND dataset.id=job.dataset_id
                AND dataset.source_type='upload'
            JOIN app.dataset_versions version ON version.organization_id=job.organization_id
                AND version.dataset_id=job.dataset_id AND version.id=job.dataset_version_id
                AND version.original_object_id=job.source_object_id
            JOIN app.dataset_version_objects source ON source.organization_id=job.organization_id
                AND source.dataset_id=job.dataset_id AND source.dataset_version_id=version.id
                AND source.data_object_id=job.source_object_id
            JOIN app.data_objects original ON original.organization_id=job.organization_id
                AND original.dataset_id=job.dataset_id AND original.id=job.source_object_id
                AND original.size_bytes BETWEEN 1 AND 536870912
            JOIN app.dataset_version_derivative_lineage lineage
                ON lineage.organization_id=job.organization_id AND lineage.dataset_id=job.dataset_id
                AND lineage.dataset_version_id=version.id AND lineage.pmtiles_job_id=job.id
                AND lineage.source_object_id=job.source_object_id
                AND lineage.output_object_id=job.output_object_id
                AND lineage.recipe=CASE WHEN job.conversion_options IS NULL
                    THEN 'gdal-pmtiles-v1' ELSE 'gdal-pmtiles-v2' END
            JOIN app.pmtiles_display_validations validation
                ON validation.organization_id=job.organization_id
                AND validation.pmtiles_job_id=job.id
                AND validation.project_id=job.project_id AND validation.dataset_id=job.dataset_id
                AND validation.dataset_version_id=version.id
                AND validation.output_object_id=job.output_object_id
            JOIN app.data_objects output ON output.organization_id=job.organization_id
                AND output.dataset_id=job.dataset_id AND output.id=job.output_object_id
                AND output.checksum_sha256=job.output_checksum_sha256
                AND output.size_bytes=job.output_size_bytes
            LEFT JOIN app.layer_archive_distributions display
                ON display.organization_id=job.organization_id AND display.project_id=job.project_id
                AND display.dataset_id=job.dataset_id AND display.dataset_version_id=version.id
                AND display.pmtiles_job_id=job.id
                AND display.source_version IS NULL AND display.enabled
            WHERE job.organization_id=%s AND job.project_id=%s AND job.dataset_id=%s
                AND job.dataset_version_id=%s AND job.id=%s AND job.state='completed'
                AND ((dataset.status='active' AND version.state='active'
                    AND original.content_type IN ('application/geo+json',
                        'application/geopackage+sqlite3','application/vnd.apache.parquet',
                        'application/zip','text/csv'))
                  OR (job.conversion_options IS NOT NULL
                    AND app.pmtiles_preserved_original_eligible(job.organization_id,
                        job.project_id,job.dataset_id,job.dataset_version_id,job.source_object_id)))
                AND original.checksum_sha256=validation.validation->>'source_checksum_sha256'
                AND original.s3_version_id=validation.validation->>'source_s3_version_id'
            """,
            (context.organization_id, project, dataset, version, job),
        )
        if row is None:
            raise CatalogNotFound("pmtiles_display_review")
        validation = row[1]
        # Return an allowlist of review facts, never raw worker storage/index coordinates.
        return {
            "job_id": job,
            "dataset_id": dataset,
            "dataset_version_id": version,
            "review_sha256": row[0],
            "source_object_id": row[2],
            "output_object_id": row[3],
            "output_finished_at": row[4],
            "request_checksum_sha256": row[5],
            "download_bytes": row[6],
            "output_sha256": row[7],
            "count_semantics": validation["count_semantics"],
            "conversion_limits": {
                key: validation["losses"][key]
                for key in (
                    "geometry",
                    "attributes",
                    "feature_ids",
                    "source_record_count",
                    "preservation_verified",
                )
            },
            "reported_fragment_count": validation["output_layer"]["reported_fragment_count"],
            "bounds": validation["bounds"],
            "tile_layers": validation["tile_layers"],
            "min_zoom": validation["min_zoom"],
            "max_zoom": validation["max_zoom"],
            "eligible": len(validation["tile_layers"]) == 1,
            "display_id": row[8],
        }

    async def review_pmtiles(
        self, context: TenantContext, project: UUID, dataset: UUID, version: UUID, job: UUID
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            return await self._pmtiles_review(tx, context, project, dataset, version, job)

        return await self.catalog._run(context, operation)

    async def admit_pmtiles(
        self,
        context: TenantContext,
        project: UUID,
        dataset: UUID,
        version: UUID,
        job: UUID,
        request: ReviewPmtilesDisplayRequest,
    ) -> dict[str, Any]:
        async def operation(tx: TenantTransaction) -> dict[str, Any]:
            review = await self._pmtiles_review(tx, context, project, dataset, version, job)
            if review["review_sha256"] != request.expected_review_sha256 or not review["eligible"]:
                raise CatalogConflict("pmtiles_display_review_changed_or_incompatible")
            admitted = await tx.fetch_one(
                "SELECT app.admit_pmtiles_derivative_display(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    context.organization_id,
                    project,
                    dataset,
                    version,
                    job,
                    request.expected_review_sha256,
                    request.title,
                    request.rights_basis,
                    request.attribution,
                    request.acknowledge_conversion_limits,
                ),
            )
            if admitted is None or admitted[0] != job:
                raise CatalogConflict("pmtiles_display_admission_changed")
            row = await tx.fetch_one(
                """SELECT id,title,captured_at,descriptor FROM app.layer_archive_distributions
                WHERE organization_id=%s AND project_id=%s AND dataset_id=%s
                    AND dataset_version_id=%s AND pmtiles_job_id=%s AND id=%s
                    AND source_version IS NULL AND enabled""",
                (context.organization_id, project, dataset, version, job, job),
            )
            if row is None:
                raise CatalogConflict("pmtiles_display_admission_changed")
            descriptor = ArchiveDescriptor.model_validate(row[3])
            if descriptor.format != "pmtiles":
                raise CatalogConflict("managed_display_requires_tiles")
            return {
                "job_id": job,
                "dataset_id": dataset,
                "dataset_version_id": version,
                "review_sha256": review["review_sha256"],
                "display_id": admitted[0],
                "display": LayerArchiveRepository.metadata(row, descriptor),
            }

        return await self.catalog._run(context, operation)

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
                WHERE organization_id=%s AND dataset_id=%s AND id=%s
                  AND (state='active' OR app.pmtiles_preserved_original_eligible(
                    organization_id,%s,dataset_id,id,original_object_id))""",
                (context.organization_id, dataset, version, project),
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


@router.get(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}"
    "/pmtiles-derivatives/{job_id}/display-review"
)
async def review_pmtiles_display(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    job_id: UUID,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[ManagedDisplayRepository, Depends(repository)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return await execute_catalog(
        store.review_pmtiles(tenant_context(session), project_id, dataset_id, version_id, job_id)
    )


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}"
    "/pmtiles-derivatives/{job_id}/display-review"
)
async def admit_pmtiles_display(
    project_id: UUID,
    dataset_id: UUID,
    version_id: UUID,
    job_id: UUID,
    payload: ReviewPmtilesDisplayRequest,
    response: Response,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[ManagedDisplayRepository, Depends(repository)],
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    return await execute_catalog(
        store.admit_pmtiles(
            tenant_context(session), project_id, dataset_id, version_id, job_id, payload
        )
    )


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
