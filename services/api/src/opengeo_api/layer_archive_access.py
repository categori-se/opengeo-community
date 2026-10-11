"""Explicit, layer-authorized read tickets; metadata inspection never reads S3."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from opengeo_api.archive_upload_storage import ArchiveS3Storage
from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.external_source_routes import execute_source, tenant_context
from opengeo_api.external_sources import (
    ExternalSource,
    ExternalSourceNotFound,
    PostgresExternalSourceRepository,
)
from opengeo_api.tenant_database import TenantContext, TenantTransaction

router = APIRouter(tags=["layer archive access"])
Sha = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]


class ArchiveBlockIndex(BaseModel):
    """Raw SHA-256 digests in block order, stored beside the reviewed artifact."""

    model_config = ConfigDict(extra="forbid", strict=True)
    key: str = Field(min_length=1, max_length=1024)
    version_id: str = Field(min_length=1, max_length=1024)
    size_bytes: int = Field(ge=32, le=1024**2)
    sha256: Sha


class ArchiveObject(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bucket: str = Field(pattern=r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
    prefix: str = Field(min_length=1, max_length=1024)
    expected_owner: str = Field(pattern=r"^[0-9]{12}$")
    key: str = Field(min_length=1, max_length=1024)
    version_id: str = Field(min_length=1, max_length=1024)
    size_bytes: int = Field(ge=1, le=2 * 1024**3)
    sha256: Sha
    encoding: Literal["identity", "gzip"]
    decoded_size_bytes: int = Field(ge=1, le=2 * 1024**3)
    decoded_sha256: Sha
    feature_count: int = Field(ge=0, le=10_000_000)
    block_sha256: list[Sha] | None = Field(default=None, max_length=1024)
    block_index: ArchiveBlockIndex | None = None

    @model_validator(mode="after")
    def check_identity(self) -> Self:
        if self.encoding == "identity" and (
            self.size_bytes != self.decoded_size_bytes or self.sha256 != self.decoded_sha256
        ):
            raise ValueError("Identity encoding must preserve content facts")
        # Validate the scoped path without requesting credentials or storage.
        if self.version_id == "null" or re.search(r"[\x00-\x1f\x7f]", self.version_id):
            raise ValueError("An exact object version is required")
        if not self.prefix.endswith("/") or not self.key.startswith(self.prefix):
            raise ValueError("Archive key is outside its reviewed prefix")
        if any(part in ("", ".", "..") for part in self.key.split("/")):
            raise ValueError("Unsafe archive path")
        if any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in self.key):
            raise ValueError("Unsafe archive path")
        if self.block_index is not None:
            index = self.block_index
            if (
                index.key == self.key
                or not index.key.startswith(self.prefix)
                or any(part in ("", ".", "..") for part in index.key.split("/"))
                or any(ord(c) < 32 or ord(c) == 127 or c == "\\" for c in index.key)
                or index.version_id == "null"
                or re.search(r"[\x00-\x1f\x7f]", index.version_id)
            ):
                raise ValueError("Invalid scoped archive block index")
        return self


class ArchiveTileLayer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_layer: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,62}$")
    title: str = Field(min_length=1, max_length=200)
    geometry_type: Literal[
        "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
    ]
    feature_count: int = Field(ge=0, le=10_000_000)
    geometry_method: str = Field(min_length=1, max_length=2000)


class ArchiveRasterOverview(BaseModel):
    """A display overview of the same capture, without duplicate feature identities."""

    model_config = ConfigDict(extra="forbid", strict=True)
    object_index: Literal[1]
    min_zoom: int = Field(ge=0, le=21)
    max_zoom: int = Field(ge=0, le=21)
    vector_min_zoom: int = Field(ge=1, le=22)
    tile_size: Literal[512]
    description: str = Field(min_length=1, max_length=2000)
    recipe: dict[str, object]


class ArchiveDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    format: Literal["geojson", "pmtiles"]
    objects: list[ArchiveObject] = Field(min_length=1, max_length=200)
    attribution: str = Field(min_length=1, max_length=2000)
    rights: dict[str, Any]
    provenance: dict[str, Any]
    tile_layers: list[ArchiveTileLayer] = Field(default_factory=list, max_length=4)
    min_zoom: int | None = Field(default=None, ge=0, le=22)
    max_zoom: int | None = Field(default=None, ge=0, le=22)
    raster_overview: ArchiveRasterOverview | None = None

    @model_validator(mode="after")
    def bounded_render(self) -> Self:
        identities = {(o.bucket, o.key, o.version_id) for o in self.objects}
        if len(identities) != len(self.objects):
            raise ValueError("Duplicate archive object")
        if self.format == "geojson" and (
            sum(o.size_bytes for o in self.objects) > 64 * 1024**2
            or sum(o.decoded_size_bytes for o in self.objects) > 64 * 1024**2
            or sum(o.feature_count for o in self.objects) > 100_000
        ):
            raise ValueError("Archive requires a bounded rendering derivative")
        if self.format == "geojson":
            if (
                self.tile_layers
                or self.min_zoom is not None
                or self.max_zoom is not None
                or any(o.block_sha256 is not None for o in self.objects)
                or any(o.block_index is not None for o in self.objects)
                or self.raster_overview is not None
            ):
                raise ValueError("GeoJSON cannot declare tile metadata")
        else:
            if (
                len(self.objects) != (2 if self.raster_overview is not None else 1)
                or not self.tile_layers
                or self.min_zoom is None
                or self.max_zoom is None
                or self.min_zoom > self.max_zoom
            ):
                raise ValueError("PMTiles requires reviewed objects, tile layers and zooms")
            if self.raster_overview is not None:
                overview = self.raster_overview
                first, second = self.objects
                if (
                    overview.min_zoom != self.min_zoom
                    or overview.min_zoom > overview.max_zoom
                    or overview.vector_min_zoom != overview.max_zoom + 1
                    or overview.vector_min_zoom > self.max_zoom
                    or second.feature_count != 0
                    or (first.bucket, first.prefix, first.expected_owner)
                    != (second.bucket, second.prefix, second.expected_owner)
                    or any(
                        x.geometry_type not in ("Polygon", "MultiPolygon") for x in self.tile_layers
                    )
                    or overview.recipe.get("version") != 1
                    or overview.recipe.get("tile_size") != overview.tile_size
                    or overview.recipe.get("zooms")
                    != list(range(overview.min_zoom, overview.max_zoom + 1))
                    or overview.recipe.get("sourceVectorSha256") != first.sha256
                ):
                    raise ValueError(
                        "Raster overview must describe the same capture and disjoint display zooms"
                    )
            for obj in self.objects:
                self.validate_tiled_object(obj)
            obj = self.objects[0]
            if (
                len({x.source_layer for x in self.tile_layers}) != len(self.tile_layers)
                or sum(x.feature_count for x in self.tile_layers) != obj.feature_count
            ):
                raise ValueError("Tile layer identities/counts must match the reviewed capture")
        return self

    @staticmethod
    def validate_tiled_object(obj: ArchiveObject) -> None:
        if (
            obj.size_bytes < 127
            or obj.encoding != "identity"
            or (obj.block_sha256 is None) == (obj.block_index is None)
        ):
            raise ValueError("PMTiles requires checksums for every 64 KiB block")
        blocks = (obj.size_bytes + 65535) // 65536
        if obj.block_index is not None:
            if obj.block_index.size_bytes != blocks * 32:
                raise ValueError("Archive block index size must match the complete artifact")
        elif (
            obj.size_bytes > 64 * 1024**2
            or obj.feature_count > 100_000
            or obj.block_sha256 is None
            or len(obj.block_sha256) != blocks
        ):
            raise ValueError("Large PMTiles requires a versioned block index")


class LayerArchiveRepository:
    def __init__(
        self,
        sources: PostgresExternalSourceRepository,
        storage_factory: Callable[[str, str, str], ArchiveS3Storage] = ArchiveS3Storage,
    ) -> None:
        self.sources = sources
        self.storage_factory = storage_factory

    async def _read(
        self, context: TenantContext, project: UUID, dataset: UUID, archive: UUID | None = None
    ) -> tuple[ExternalSource, list[tuple[Any, ...]]]:
        async def operation(tx: TenantTransaction) -> tuple[ExternalSource, list[tuple[Any, ...]]]:
            roles = await self.sources._project_roles(tx, context, project)
            source = await self.sources._load_source(tx, context, project, dataset, roles=roles)
            rows = await tx.fetch_all(
                """SELECT id,title,captured_at,descriptor FROM app.layer_archive_distributions
                WHERE organization_id=%s AND project_id=%s AND dataset_id=%s
                 AND source_version=%s AND enabled AND (%s::uuid IS NULL OR id=%s)
                ORDER BY captured_at DESC NULLS LAST,id LIMIT 21""",
                (
                    context.organization_id,
                    project,
                    dataset,
                    source.version_number,
                    archive,
                    archive,
                ),
            )
            if len(rows) > 20:
                raise ExternalSourceNotFound("archive_selection_requires_review")
            return source, rows

        return await self.sources._run(context, operation)

    @staticmethod
    def metadata(row: tuple[Any, ...], descriptor: ArchiveDescriptor) -> dict[str, Any]:
        return {
            "id": row[0],
            "title": row[1],
            "captured_at": row[2],
            "format": descriptor.format,
            "attribution": descriptor.attribution,
            "rights": descriptor.rights,
            "provenance": descriptor.provenance,
            "download_bytes": sum(o.size_bytes for o in descriptor.objects),
            "decoded_bytes": sum(o.decoded_size_bytes for o in descriptor.objects),
            "feature_count": sum(o.feature_count for o in descriptor.objects),
            "object_count": len(descriptor.objects),
            **(
                {
                    "tile_layers": [x.model_dump() for x in descriptor.tile_layers],
                    "min_zoom": descriptor.min_zoom,
                    "max_zoom": descriptor.max_zoom,
                    **(
                        {"raster_overview": descriptor.raster_overview.model_dump()}
                        if descriptor.raster_overview is not None
                        else {}
                    ),
                    "range_block_bytes": 65536,
                    "verification_index_bytes": sum(
                        o.block_index.size_bytes for o in descriptor.objects if o.block_index
                    ),
                    "range_limits": {
                        "requests": 256,
                        "bytes": 64 * 1024**2,
                        "seconds": 300,
                        "response_bytes": 8 * 1024**2,
                    },
                }
                if descriptor.format == "pmtiles"
                else {}
            ),
        }

    async def list(self, context: TenantContext, project: UUID, dataset: UUID) -> dict[str, Any]:
        source, rows = await self._read(context, project, dataset)
        return {
            "dataset_id": dataset,
            "source_version": source.version_number,
            "archives": [self.metadata(r, ArchiveDescriptor.model_validate(r[3])) for r in rows],
        }

    async def read_tickets(
        self, context: TenantContext, project: UUID, dataset: UUID, archive: UUID
    ) -> dict[str, Any]:
        source, rows = await self._read(context, project, dataset, archive)
        if len(rows) != 1:
            raise ExternalSourceNotFound("layer_archive")
        row = rows[0]
        descriptor = ArchiveDescriptor.model_validate(row[3])
        objects = []
        for obj in descriptor.objects:
            storage = self.storage_factory(obj.bucket, obj.prefix, obj.expected_owner)
            value = obj.model_dump(exclude_none=True)
            if obj.block_index is not None:
                value["block_index"]["ticket"] = storage.sign_download(
                    obj.block_index.key, obj.block_index.version_id
                )
            objects.append(
                {
                    **value,
                    "ticket": storage.sign_download(obj.key, obj.version_id),
                }
            )
        return {
            **self.metadata(row, descriptor),
            "dataset_id": dataset,
            "source_version": source.version_number,
            "source_url": source.source_url,
            "objects": objects,
        }


def repository(request: Request) -> LayerArchiveRepository:
    sources = request.app.state.external_source_repository
    if not isinstance(sources, PostgresExternalSourceRepository):
        raise HTTPException(503, detail="layer_archive_unavailable")
    return LayerArchiveRepository(sources)


@router.get("/projects/{project_id}/sources/{dataset_id}/archives")
async def list_archives(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[LayerArchiveRepository, Depends(repository)],
) -> dict[str, Any]:
    return await execute_source(store.list(tenant_context(session), project_id, dataset_id))


class ReadArchiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    acknowledge_storage_cost: Literal[True]

    @field_validator("acknowledge_storage_cost", mode="before")
    @classmethod
    def explicit_boolean(cls, value: object) -> Literal[True]:
        if value is not True:
            raise ValueError("Explicit storage cost acknowledgement required")
        return value


@router.post("/projects/{project_id}/sources/{dataset_id}/archives/{archive_id}/read")
async def read_archive(
    project_id: UUID,
    dataset_id: UUID,
    archive_id: UUID,
    payload: ReadArchiveRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    store: Annotated[LayerArchiveRepository, Depends(repository)],
) -> dict[str, Any]:
    return await execute_source(
        store.read_tickets(tenant_context(session), project_id, dataset_id, archive_id)
    )
