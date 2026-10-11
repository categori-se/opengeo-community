import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.auth_models import OrganizationRole
from opengeo_api.authorization import (
    Action,
    AuthorizationDenied,
    ProjectRole,
    ResourcePermissionRole,
    Roles,
    authorize,
)
from opengeo_api.maplibre_render import (
    MapLibreRenderUnsupported,
    compile_maplibre_render_configuration,
)
from opengeo_api.s3_downloads import (
    DownloadSpec,
    DownloadStorage,
    DownloadTicket,
    ExactObjectSpec,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

if TYPE_CHECKING:
    from opengeo_api.portable_artifact_cleanup import PortableCleanupStorage
    from opengeo_api.render_runtime import RenderRuntimeReference
    from opengeo_api.s3_uploads import UploadStorage
    from opengeo_api.saved_map_jobs import SavedMapRenderRequest

RenderFormat = Literal["svg", "png"]
RenderCrs = Literal["CRS:84", "EPSG:3857"]
RenderJobState = Literal["queued", "running", "completed", "failed", "cancelled"]


class RenderStoreUnavailable(RuntimeError):
    pass


class RenderAccessDenied(RuntimeError):
    pass


class RenderNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class RenderConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class RenderProfileDraft:
    slug: str
    title: str
    style_id: UUID
    geometry_layer_id: str
    label_layer_id: str | None
    minimum_scale_denominator: float | None
    maximum_scale_denominator: float | None
    include_legend: bool
    change_message: str | None = None


@dataclass(frozen=True, slots=True)
class RenderProfile:
    profile_id: UUID
    project_id: UUID
    resource_id: UUID
    slug: str
    version_number: int
    title: str
    resource_version_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    configuration: dict[str, Any]
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class RenderRequest:
    idempotency_key: UUID
    bbox: tuple[float, float, float, float]
    crs: RenderCrs
    width: int
    height: int
    format: RenderFormat
    background_color: str | None = None
    transparent: bool = False
    expected_profile_version: int | None = None


@dataclass(frozen=True, slots=True)
class RenderJob:
    job_id: UUID
    project_id: UUID
    resource_id: UUID
    profile_id: UUID
    profile_version_id: UUID
    profile_version_number: int
    dataset_id: UUID
    dataset_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    bbox: tuple[float, float, float, float]
    crs: RenderCrs
    width: int
    height: int
    format: RenderFormat
    background_color: str | None
    transparent: bool
    request_checksum_sha256: str
    state: RenderJobState
    attempt_count: int
    output_object_id: UUID | None
    output_content_type: str | None
    output_size_bytes: int | None
    output_checksum_sha256: str | None
    error_code: str | None
    created_by: UUID
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    saved_map_snapshot: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class RenderSubmission:
    job: RenderJob
    dispatch_required: bool


@dataclass(frozen=True, slots=True)
class RenderedMapOutput:
    body: bytes
    filename: str
    content_type: str
    size_bytes: int
    checksum_sha256: str
    version_id: str


@dataclass(frozen=True, slots=True)
class SealedRenderOutput:
    output_object_id: UUID
    storage_version_id: str
    content_type: str
    size_bytes: int
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class MapCollection:
    resource_id: UUID
    slug: str
    title: str
    description: str | None
    attribution: str | None
    spatial_extent: tuple[float, float, float, float] | None
    temporal_start: datetime | None
    temporal_end: datetime | None


@dataclass(frozen=True, slots=True)
class WmsLayerPublication:
    publication_id: UUID
    project_id: UUID
    resource_id: UUID
    name: str
    default_profile_id: UUID
    created_by: UUID
    created_at: datetime
    withdrawn_by: UUID | None
    withdrawn_at: datetime | None


@dataclass(frozen=True, slots=True)
class PublicWmsService:
    service_id: UUID
    project_id: UUID
    title: str
    created_by: UUID
    created_at: datetime
    disabled_by: UUID | None
    disabled_at: datetime | None


@dataclass(frozen=True, slots=True)
class ProjectMapLayer:
    publication: WmsLayerPublication
    collection: MapCollection
    profiles: tuple[RenderProfile, ...]


@dataclass(frozen=True, slots=True)
class ProjectMapCatalog:
    title: str
    layers: tuple[ProjectMapLayer, ...]


@dataclass(frozen=True, slots=True)
class RenderLayerSelection:
    resource_id: UUID
    profile_id: UUID
    expected_profile_version: int


def render_request_checksum(profiles: Sequence[RenderProfile], request: RenderRequest) -> str:
    if not profiles:
        raise ValueError("at least one render profile is required")
    request_fields = {
        "bbox": list(request.bbox),
        "crs": request.crs,
        "width": request.width,
        "height": request.height,
        "format": request.format,
        "background_color": request.background_color,
        "transparent": request.transparent,
    }
    if len(profiles) == 1:
        profile = profiles[0]
        payload: dict[str, object] = {
            "profile_id": str(profile.profile_id),
            "profile_version": profile.version_number,
            "profile_checksum_sha256": profile.checksum_sha256,
            "dataset_version_id": str(profile.dataset_version_id),
            "style_version_id": str(profile.style_version_id),
            **request_fields,
        }
    else:
        payload = {
            "schema": "opengeo.render.composition.request.v1",
            "layers": [
                {
                    "position": position,
                    "resource_id": str(profile.resource_id),
                    "profile_id": str(profile.profile_id),
                    "profile_version": profile.version_number,
                    "profile_checksum_sha256": profile.checksum_sha256,
                    "dataset_version_id": str(profile.dataset_version_id),
                    "style_version_id": str(profile.style_version_id),
                }
                for position, profile in enumerate(profiles, 1)
            ],
            **request_fields,
        }
    return sha256(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


class RenderRepository(Protocol):
    async def request_saved_map_render(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        request: "SavedMapRenderRequest",
        request_id: str,
    ) -> RenderSubmission: ...

    async def list_resource_renders(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> list[RenderJob]: ...

    async def get_map_collection(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> MapCollection: ...

    async def get_project_map_catalog(
        self, context: TenantContext, project_id: UUID
    ) -> ProjectMapCatalog: ...

    async def list_wms_publications(
        self, context: TenantContext, project_id: UUID
    ) -> list[WmsLayerPublication]: ...

    async def create_wms_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        name: str,
        default_profile_id: UUID,
        request_id: str,
    ) -> WmsLayerPublication: ...

    async def withdraw_wms_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        publication_id: UUID,
        request_id: str,
    ) -> WmsLayerPublication: ...

    async def list_public_wms_services(
        self, context: TenantContext, project_id: UUID
    ) -> list[PublicWmsService]: ...

    async def create_public_wms_service(
        self,
        context: TenantContext,
        project_id: UUID,
        title: str,
        request_id: str,
    ) -> PublicWmsService: ...

    async def disable_public_wms_service(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        request_id: str,
    ) -> PublicWmsService: ...

    async def get_public_project_map_catalog(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> ProjectMapCatalog: ...

    async def find_public_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None: ...

    async def find_public_composite_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        idempotency_key: UUID,
    ) -> RenderJob | None: ...

    async def request_public_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        job_id: UUID,
    ) -> DownloadTicket: ...

    async def request_public_composite_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        job_id: UUID,
    ) -> DownloadTicket: ...

    async def read_public_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
    ) -> RenderedMapOutput: ...

    async def read_public_composite_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        job_id: UUID,
        maximum_bytes: int,
    ) -> RenderedMapOutput: ...

    async def read_sealed_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        seal: SealedRenderOutput,
        maximum_bytes: int,
    ) -> RenderedMapOutput: ...

    async def list_profiles(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[RenderProfile]: ...

    async def get_profile(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, profile_id: UUID
    ) -> RenderProfile: ...

    async def create_profile(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: RenderProfileDraft,
        request_id: str,
    ) -> RenderProfile: ...

    async def update_profile(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
        expected_version: int,
        draft: RenderProfileDraft,
        request_id: str,
    ) -> RenderProfile: ...

    async def request_render(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
        request: RenderRequest,
        request_id: str,
    ) -> RenderSubmission: ...

    async def request_composite_render(
        self,
        context: TenantContext,
        project_id: UUID,
        layers: tuple[RenderLayerSelection, ...],
        request: RenderRequest,
        request_id: str,
    ) -> RenderSubmission: ...

    async def find_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None: ...

    async def find_composite_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None: ...

    async def get_job(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, job_id: UUID
    ) -> RenderJob: ...

    async def list_portable_cleanup_attempts(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> list[dict[str, Any]]: ...

    async def request_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        manifest_bytes: bytes,
        expected_revision: int,
    ) -> dict[str, Any]: ...

    async def complete_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> dict[str, Any]: ...

    async def cleanup_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> dict[str, Any]: ...

    async def register_retained_portable_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        output_object_id: UUID,
        manifest_bytes: bytes,
        expected_revision: int,
    ) -> dict[str, Any]: ...

    async def register_artifact_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        expected_revision: int,
    ) -> dict[str, Any]: ...

    async def read_artifact_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None,
        metadata_only: bool = False,
        representation: str = "saved-map-image",
    ) -> dict[str, Any]: ...

    async def request_portable_download(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None,
    ) -> DownloadTicket: ...

    async def select_artifact_current(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int,
        expected_revision: int,
        representation: str = "saved-map-image",
    ) -> dict[str, Any]: ...

    async def get_project_artifact(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, job_id: UUID
    ) -> dict[str, Any]: ...

    async def get_composite_job(
        self, context: TenantContext, project_id: UUID, job_id: UUID
    ) -> RenderJob: ...

    async def request_download(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket: ...

    async def request_composite_download(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket: ...

    async def read_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
        request_id: str,
    ) -> RenderedMapOutput: ...

    async def read_composite_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
        request_id: str,
    ) -> RenderedMapOutput: ...


ResultT = TypeVar("ResultT")


@dataclass(frozen=True, slots=True)
class _RenderSnapshot:
    resource_version_id: UUID
    dataset_id: UUID
    dataset_version_id: UUID
    style_id: UUID
    style_version_id: UUID
    style_version_number: int
    style_definition: str
    style_checksum_sha256: str


@dataclass(frozen=True, slots=True)
class _DownloadTarget:
    bucket: str
    key: str
    version_id: str
    filename: str
    object_id: UUID
    content_type: str
    size_bytes: int
    checksum_sha256: str


class PostgresRenderRepository:
    def __init__(
        self,
        executor: TenantTransactionExecutor,
        downloads: DownloadStorage,
        *,
        artifact_uploads: "UploadStorage | None" = None,
        artifact_downloads: DownloadStorage | None = None,
        artifact_cleanup: "PortableCleanupStorage | None" = None,
        saved_map_gl_enabled: bool = False,
        saved_map_gl_runtime_reference: "RenderRuntimeReference | None" = None,
    ) -> None:
        self._executor = executor
        self._downloads = downloads
        self._artifact_downloads = artifact_downloads or downloads
        self._artifact_uploads = artifact_uploads
        self._artifact_cleanup = artifact_cleanup
        self.saved_map_gl_enabled = saved_map_gl_enabled
        self.saved_map_gl_runtime_reference = saved_map_gl_runtime_reference

    async def request_saved_map_render(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        request: "SavedMapRenderRequest",
        request_id: str,
    ) -> RenderSubmission:
        from opengeo_api.saved_map_jobs import request_saved_map_render

        return await request_saved_map_render(
            self, context, project_id, resource_id, request, request_id
        )

    async def list_resource_renders(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> list[RenderJob]:
        async def operation(transaction: TenantTransaction) -> list[RenderJob]:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            rows = await transaction.fetch_all(
                f"""{self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.resource_id = %s AND job.composition_sealed
                ORDER BY job.created_at DESC, job.id DESC LIMIT 100""",
                (context.organization_id, project_id, resource_id),
            )
            jobs = [self._job(row) for row in rows]
            for job in jobs:
                if job.saved_map_snapshot is not None:
                    await self._require_composition_access(
                        transaction, context, project_id, job.job_id, Action.RENDER_READ
                    )
            return jobs

        return await self._run(context, operation)

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise RenderConflict("render_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise RenderStoreUnavailable("render operation failed") from error

    async def get_map_collection(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> MapCollection:
        async def operation(transaction: TenantTransaction) -> MapCollection:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            row = await transaction.fetch_one(
                """
                SELECT resource.id, resource.slug, version.title, version.abstract,
                       version.attribution, version.spatial_extent,
                       version.temporal_start, version.temporal_end
                FROM app.governed_resources resource
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE resource.organization_id = %s AND resource.project_id = %s
                  AND resource.id = %s AND resource.kind IN ('dataset', 'service')
                  AND resource.state <> 'archived'
                """,
                (context.organization_id, project_id, resource_id),
            )
            if row is None:
                raise RenderNotFound("map_collection")
            raw_extent = cast(list[Any] | None, row[5])
            extent = (
                None
                if raw_extent is None
                else cast(
                    tuple[float, float, float, float],
                    tuple(float(value) for value in raw_extent),
                )
            )
            return MapCollection(
                resource_id=cast(UUID, row[0]),
                slug=cast(str, row[1]),
                title=cast(str, row[2]),
                description=cast(str | None, row[3]),
                attribution=cast(str | None, row[4]),
                spatial_extent=extent,
                temporal_start=cast(datetime | None, row[6]),
                temporal_end=cast(datetime | None, row[7]),
            )

        return await self._run(context, operation)

    async def get_public_project_map_catalog(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
    ) -> ProjectMapCatalog:
        async def operation(transaction: TenantTransaction) -> ProjectMapCatalog:
            service_row = await transaction.fetch_one(
                f"""{self._public_service_select()}
                WHERE service.organization_id = %s
                  AND service.project_id = %s
                  AND service.id = %s
                  AND service.disabled_at IS NULL
                """,
                (context.organization_id, project_id, service_id),
            )
            if service_row is None:
                raise RenderNotFound("public_wms_service")
            service = self._public_service(service_row)
            collection_rows = await transaction.fetch_all(
                """
                SELECT publication.id, publication.project_id,
                       publication.resource_id, publication.wms_name,
                       publication.default_profile_id, publication.created_by,
                       publication.created_at, publication.withdrawn_by,
                       publication.withdrawn_at, resource.slug, version.title,
                       version.abstract, version.attribution,
                       version.spatial_extent, version.temporal_start,
                       version.temporal_end
                FROM app.wms_layer_publications publication
                JOIN app.governed_resources resource
                  ON resource.organization_id = publication.organization_id
                 AND resource.project_id = publication.project_id
                 AND resource.id = publication.resource_id
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE publication.organization_id = %s
                  AND publication.project_id = %s
                  AND publication.withdrawn_at IS NULL
                  AND resource.kind IN ('dataset', 'service')
                  AND resource.state = 'published'
                  AND resource.visibility = 'public'
                  AND EXISTS (
                    SELECT 1 FROM app.map_render_profiles profile
                    WHERE profile.organization_id = resource.organization_id
                      AND profile.project_id = resource.project_id
                      AND profile.resource_id = resource.id
                      AND profile.id = publication.default_profile_id
                  )
                ORDER BY lower(publication.wms_name), publication.id
                """,
                (context.organization_id, project_id),
            )
            profile_rows = await transaction.fetch_all(
                f"""{self._profile_select()}
                WHERE profile.organization_id = %s
                  AND profile.project_id = %s
                  AND EXISTS (
                    SELECT 1
                    FROM app.public_wms_services public_service
                    JOIN app.wms_layer_publications publication
                      ON publication.organization_id = public_service.organization_id
                     AND publication.project_id = public_service.project_id
                     AND publication.withdrawn_at IS NULL
                    JOIN app.governed_resources resource
                      ON resource.organization_id = publication.organization_id
                     AND resource.project_id = publication.project_id
                     AND resource.id = publication.resource_id
                    WHERE public_service.organization_id = profile.organization_id
                      AND public_service.project_id = profile.project_id
                      AND public_service.id = %s
                      AND public_service.disabled_at IS NULL
                      AND publication.resource_id = profile.resource_id
                      AND resource.kind IN ('dataset', 'service')
                      AND resource.state = 'published'
                      AND resource.visibility = 'public'
                  )
                ORDER BY profile.resource_id, lower(version.title), profile.id
                """,
                (context.organization_id, project_id, service_id),
            )
            profiles_by_resource: dict[UUID, list[RenderProfile]] = {}
            for row in profile_rows:
                profile = self._profile(row)
                profiles_by_resource.setdefault(profile.resource_id, []).append(profile)
            layers: list[ProjectMapLayer] = []
            for row in collection_rows:
                publication = self._publication(row[:9])
                raw_extent = cast(list[Any] | None, row[13])
                extent = (
                    None
                    if raw_extent is None
                    else cast(
                        tuple[float, float, float, float],
                        tuple(float(value) for value in raw_extent),
                    )
                )
                resource_id = publication.resource_id
                available_profiles = profiles_by_resource.get(resource_id, ())
                default_profile = next(
                    (
                        profile
                        for profile in available_profiles
                        if profile.profile_id == publication.default_profile_id
                    ),
                    None,
                )
                if default_profile is None:
                    continue
                profiles = (
                    default_profile,
                    *(profile for profile in available_profiles if profile is not default_profile),
                )
                layers.append(
                    ProjectMapLayer(
                        publication=publication,
                        collection=MapCollection(
                            resource_id=resource_id,
                            slug=cast(str, row[9]),
                            title=cast(str, row[10]),
                            description=cast(str | None, row[11]),
                            attribution=cast(str | None, row[12]),
                            spatial_extent=extent,
                            temporal_start=cast(datetime | None, row[14]),
                            temporal_end=cast(datetime | None, row[15]),
                        ),
                        profiles=profiles,
                    )
                )
            return ProjectMapCatalog(service.title, tuple(layers))

        return await self._run(context, operation)

    async def find_public_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None:
        async def operation(transaction: TenantTransaction) -> RenderJob | None:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
            row = await transaction.fetch_one(
                f"""{self._job_select()}
                WHERE job.organization_id = %s
                  AND job.project_id = %s
                  AND job.resource_id = %s
                  AND job.idempotency_key = %s
                  AND NOT job.composition_sealed
                """,
                (context.organization_id, project_id, resource_id, idempotency_key),
            )
            return None if row is None else self._job(row)

        return await self._run(context, operation)

    async def find_public_composite_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        idempotency_key: UUID,
    ) -> RenderJob | None:
        async def operation(transaction: TenantTransaction) -> RenderJob | None:
            row = await transaction.fetch_one(
                f"""{self._job_select()}
                WHERE job.organization_id = %s
                  AND job.project_id = %s
                  AND job.idempotency_key = %s
                  AND job.composition_sealed
                """,
                (context.organization_id, project_id, idempotency_key),
            )
            if row is None:
                return None
            job = self._job(row)
            await self._require_public_composition(
                transaction, context, project_id, service_id, job.job_id, resource_ids
            )
            return job

        return await self._run(context, operation)

    async def request_public_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        job_id: UUID,
    ) -> DownloadTicket:
        async def prepare(transaction: TenantTransaction) -> _DownloadTarget:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
            return await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )

        target = await self._run(context, prepare)
        ticket = await self._downloads.create_download_url(
            DownloadSpec(target.bucket, target.key, target.version_id, target.filename)
        )

        async def verify(transaction: TenantTransaction) -> None:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
            checked = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if checked != target:
                raise RenderConflict("render_output_changed")

        await self._run(context, verify)
        return ticket

    async def request_public_composite_download(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        job_id: UUID,
    ) -> DownloadTicket:
        async def prepare(transaction: TenantTransaction) -> tuple[UUID, _DownloadTarget]:
            anchor = await self._require_public_composition(
                transaction, context, project_id, service_id, job_id, resource_ids
            )
            return anchor, await self._download_target(
                transaction, context, project_id, anchor, job_id
            )

        anchor, target = await self._run(context, prepare)
        ticket = await self._downloads.create_download_url(
            DownloadSpec(target.bucket, target.key, target.version_id, target.filename)
        )

        async def verify(transaction: TenantTransaction) -> None:
            checked_anchor = await self._require_public_composition(
                transaction, context, project_id, service_id, job_id, resource_ids
            )
            checked = await self._download_target(
                transaction, context, project_id, checked_anchor, job_id
            )
            if checked_anchor != anchor or checked != target:
                raise RenderConflict("render_output_changed")

        await self._run(context, verify)
        return ticket

    async def read_public_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
    ) -> RenderedMapOutput:
        async def prepare(transaction: TenantTransaction) -> _DownloadTarget:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
            target = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if target.size_bytes > maximum_bytes:
                raise RenderConflict("render_output_too_large")
            return target

        target = await self._run(context, prepare)
        exact = await self._downloads.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=maximum_bytes,
            )
        )

        async def verify(transaction: TenantTransaction) -> None:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
            checked = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if checked != target:
                raise RenderConflict("render_output_changed")

        await self._run(context, verify)
        return RenderedMapOutput(
            body=exact.body,
            filename=target.filename,
            content_type=exact.content_type,
            size_bytes=exact.size_bytes,
            checksum_sha256=exact.checksum_sha256,
            version_id=exact.version_id,
        )

    async def read_public_composite_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_ids: tuple[UUID, ...],
        job_id: UUID,
        maximum_bytes: int,
    ) -> RenderedMapOutput:
        async def prepare(transaction: TenantTransaction) -> tuple[UUID, _DownloadTarget]:
            anchor = await self._require_public_composition(
                transaction, context, project_id, service_id, job_id, resource_ids
            )
            target = await self._download_target(transaction, context, project_id, anchor, job_id)
            if target.size_bytes > maximum_bytes:
                raise RenderConflict("render_output_too_large")
            return anchor, target

        anchor, target = await self._run(context, prepare)
        exact = await self._downloads.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=maximum_bytes,
            )
        )

        async def verify(transaction: TenantTransaction) -> None:
            checked_anchor = await self._require_public_composition(
                transaction, context, project_id, service_id, job_id, resource_ids
            )
            checked = await self._download_target(
                transaction, context, project_id, checked_anchor, job_id
            )
            if checked_anchor != anchor or checked != target:
                raise RenderConflict("render_output_changed")

        await self._run(context, verify)
        return RenderedMapOutput(
            body=exact.body,
            filename=target.filename,
            content_type=exact.content_type,
            size_bytes=exact.size_bytes,
            checksum_sha256=exact.checksum_sha256,
            version_id=exact.version_id,
        )

    async def read_sealed_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        seal: SealedRenderOutput,
        maximum_bytes: int,
    ) -> RenderedMapOutput:
        """Read an exact render object already authorized by an active site edition.

        This deliberately performs no membership check: the calling public-site route
        must first resolve the active edition and obtains ``seal`` only from its
        validated manifest. Object identity is checked before and after the read.
        """

        async def prepare(transaction: TenantTransaction) -> _DownloadTarget:
            target = await self._download_target(
                transaction, context, project_id, resource_id, job_id, public_saved_map=True
            )
            self._require_exact_seal(target, seal, maximum_bytes)
            return target

        target = await self._run(context, prepare)
        exact = await self._downloads.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=maximum_bytes,
            )
        )

        async def verify(transaction: TenantTransaction) -> None:
            checked = await self._download_target(
                transaction, context, project_id, resource_id, job_id, public_saved_map=True
            )
            self._require_exact_seal(checked, seal, maximum_bytes)
            if checked != target:
                raise RenderConflict("render_output_changed")

        await self._run(context, verify)
        return RenderedMapOutput(
            body=exact.body,
            filename=target.filename,
            content_type=exact.content_type,
            size_bytes=exact.size_bytes,
            checksum_sha256=exact.checksum_sha256,
            version_id=exact.version_id,
        )

    @staticmethod
    def _require_exact_seal(
        target: _DownloadTarget,
        seal: SealedRenderOutput,
        maximum_bytes: int,
    ) -> None:
        if target.size_bytes > maximum_bytes:
            raise RenderConflict("render_output_too_large")
        if (
            target.object_id != seal.output_object_id
            or target.version_id != seal.storage_version_id
            or target.content_type != seal.content_type
            or target.size_bytes != seal.size_bytes
            or target.checksum_sha256 != seal.checksum_sha256
        ):
            raise RenderConflict("render_output_changed")

    async def list_wms_publications(
        self, context: TenantContext, project_id: UUID
    ) -> list[WmsLayerPublication]:
        async def operation(transaction: TenantTransaction) -> list[WmsLayerPublication]:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._publication_select()}
                WHERE publication.organization_id = %s
                  AND publication.project_id = %s
                ORDER BY publication.created_at, publication.id
                """,
                (context.organization_id, project_id),
            )
            return [self._publication(row) for row in rows]

        return await self._run(context, operation)

    async def create_wms_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        name: str,
        default_profile_id: UUID,
        request_id: str,
    ) -> WmsLayerPublication:
        publication_id = uuid4()

        async def operation(transaction: TenantTransaction) -> WmsLayerPublication:
            self._require(
                Action.RESOURCE_PUBLISH,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            existing = await transaction.fetch_one(
                f"""{self._publication_select()}
                WHERE publication.organization_id = %s
                  AND publication.project_id = %s
                  AND lower(publication.wms_name) = lower(%s)
                """,
                (context.organization_id, project_id, name),
            )
            if existing is not None:
                publication = self._publication(existing)
                if (
                    publication.name == name
                    and publication.resource_id == resource_id
                    and publication.default_profile_id == default_profile_id
                    and publication.withdrawn_at is None
                ):
                    return publication
                raise RenderConflict("wms_publication_name_conflict")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.wms_layer_publications
                  (id, organization_id, project_id, resource_id, wms_name,
                   default_profile_id, created_by)
                SELECT %s, resource.organization_id, resource.project_id,
                       resource.id, %s, profile.id, %s
                FROM app.governed_resources resource
                JOIN app.map_render_profiles profile
                  ON profile.organization_id = resource.organization_id
                 AND profile.project_id = resource.project_id
                 AND profile.resource_id = resource.id
                 AND profile.id = %s
                JOIN app.map_render_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                WHERE resource.organization_id = %s
                  AND resource.project_id = %s
                  AND resource.id = %s
                  AND resource.kind IN ('dataset', 'service')
                  AND resource.state = 'published'
                RETURNING id, project_id, resource_id, wms_name,
                          default_profile_id, created_by, created_at,
                          withdrawn_by, withdrawn_at
                """,
                (
                    publication_id,
                    name,
                    context.user_id,
                    default_profile_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                ),
            )
            if row is None:
                raise RenderConflict("wms_publication_target_changed")
            publication = self._publication(row)
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.wms.publication.created",
                request_id,
                {
                    "publication_id": str(publication.publication_id),
                    "wms_name": publication.name,
                    "default_profile_id": str(publication.default_profile_id),
                },
            )
            return publication

        return await self._run(context, operation)

    async def withdraw_wms_publication(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        publication_id: UUID,
        request_id: str,
    ) -> WmsLayerPublication:
        async def operation(transaction: TenantTransaction) -> WmsLayerPublication:
            self._require(
                Action.RESOURCE_PUBLISH,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            existing = await transaction.fetch_one(
                f"""{self._publication_select()}
                WHERE publication.organization_id = %s
                  AND publication.project_id = %s
                  AND publication.resource_id = %s
                  AND publication.id = %s
                FOR UPDATE OF publication
                """,
                (context.organization_id, project_id, resource_id, publication_id),
            )
            if existing is None:
                raise RenderNotFound("wms_publication")
            publication = self._publication(existing)
            if publication.withdrawn_at is not None:
                return publication
            row = await transaction.fetch_one(
                """
                UPDATE app.wms_layer_publications
                SET withdrawn_by = %s, withdrawn_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s
                  AND resource_id = %s AND id = %s AND withdrawn_at IS NULL
                RETURNING id, project_id, resource_id, wms_name,
                          default_profile_id, created_by, created_at,
                          withdrawn_by, withdrawn_at
                """,
                (
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    publication_id,
                ),
            )
            if row is None:
                raise RenderConflict("wms_publication_changed")
            publication = self._publication(row)
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.wms.publication.withdrawn",
                request_id,
                {
                    "publication_id": str(publication.publication_id),
                    "wms_name": publication.name,
                },
            )
            return publication

        return await self._run(context, operation)

    async def list_public_wms_services(
        self, context: TenantContext, project_id: UUID
    ) -> list[PublicWmsService]:
        async def operation(transaction: TenantTransaction) -> list[PublicWmsService]:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_READ, roles)
            rows = await transaction.fetch_all(
                f"""{self._public_service_select()}
                WHERE service.organization_id = %s
                  AND service.project_id = %s
                ORDER BY service.created_at, service.id
                """,
                (context.organization_id, project_id),
            )
            return [self._public_service(row) for row in rows]

        return await self._run(context, operation)

    async def create_public_wms_service(
        self,
        context: TenantContext,
        project_id: UUID,
        title: str,
        request_id: str,
    ) -> PublicWmsService:
        service_id = uuid4()

        async def operation(transaction: TenantTransaction) -> PublicWmsService:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_UPDATE, roles)
            existing = await transaction.fetch_one(
                f"""{self._public_service_select()}
                WHERE service.organization_id = %s
                  AND service.project_id = %s
                  AND service.disabled_at IS NULL
                """,
                (context.organization_id, project_id),
            )
            if existing is not None:
                service = self._public_service(existing)
                if service.title == title:
                    return service
                raise RenderConflict("public_wms_service_exists")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.public_wms_services
                  (id, organization_id, project_id, title, created_by)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id, project_id, title, created_by, created_at,
                          disabled_by, disabled_at
                """,
                (service_id, context.organization_id, project_id, title, context.user_id),
            )
            if row is None:
                raise RenderConflict("public_wms_service_changed")
            service = self._public_service(row)
            await self._public_service_event(
                transaction,
                context,
                project_id,
                service.service_id,
                "map.wms.public_service.created",
                request_id,
                {"title": service.title},
            )
            return service

        return await self._run(context, operation)

    async def disable_public_wms_service(
        self,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        request_id: str,
    ) -> PublicWmsService:
        async def operation(transaction: TenantTransaction) -> PublicWmsService:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_UPDATE, roles)
            existing = await transaction.fetch_one(
                f"""{self._public_service_select()}
                WHERE service.organization_id = %s
                  AND service.project_id = %s
                  AND service.id = %s
                FOR UPDATE OF service
                """,
                (context.organization_id, project_id, service_id),
            )
            if existing is None:
                raise RenderNotFound("public_wms_service")
            service = self._public_service(existing)
            if service.disabled_at is not None:
                return service
            row = await transaction.fetch_one(
                """
                UPDATE app.public_wms_services
                SET disabled_by = %s, disabled_at = clock_timestamp()
                WHERE organization_id = %s AND project_id = %s
                  AND id = %s AND disabled_at IS NULL
                RETURNING id, project_id, title, created_by, created_at,
                          disabled_by, disabled_at
                """,
                (context.user_id, context.organization_id, project_id, service_id),
            )
            if row is None:
                raise RenderConflict("public_wms_service_changed")
            service = self._public_service(row)
            await self._public_service_event(
                transaction,
                context,
                project_id,
                service.service_id,
                "map.wms.public_service.disabled",
                request_id,
                {},
            )
            return service

        return await self._run(context, operation)

    async def find_composite_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None:
        async def operation(transaction: TenantTransaction) -> RenderJob | None:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_READ, roles)
            row = await transaction.fetch_one(
                f"""{self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.idempotency_key = %s AND job.composition_sealed
                """,
                (context.organization_id, project_id, idempotency_key),
            )
            if row is None:
                return None
            job = self._job(row)
            await self._require_composition_access(
                transaction, context, project_id, job.job_id, Action.RENDER_READ
            )
            return job

        return await self._run(context, operation)

    async def request_composite_render(
        self,
        context: TenantContext,
        project_id: UUID,
        layers: tuple[RenderLayerSelection, ...],
        request: RenderRequest,
        request_id: str,
    ) -> RenderSubmission:
        if not 2 <= len(layers) <= 16:
            raise RenderConflict("render_composition_invalid")
        job_id = uuid4()

        async def operation(transaction: TenantTransaction) -> RenderSubmission:
            profiles: list[RenderProfile] = []
            for layer in layers:
                self._require(
                    Action.RENDER_REQUEST,
                    await self._resource_roles(transaction, context, project_id, layer.resource_id),
                )
                profile = await self._load_profile(
                    transaction,
                    context,
                    project_id,
                    layer.resource_id,
                    layer.profile_id,
                )
                if profile.version_number != layer.expected_profile_version:
                    raise RenderConflict(
                        "render_profile_version_changed",
                        current_version=profile.version_number,
                    )
                profiles.append(profile)
            request_checksum = render_request_checksum(profiles, request)
            existing = await transaction.fetch_one(
                """
                SELECT id, request_checksum_sha256, resource_id
                FROM app.map_render_jobs
                WHERE organization_id = %s AND idempotency_key = %s
                """,
                (context.organization_id, request.idempotency_key),
            )
            if existing is not None:
                if cast(str, existing[1]) != request_checksum:
                    raise RenderConflict("render_idempotency_conflict")
                job = await self._load_job(
                    transaction,
                    context,
                    project_id,
                    cast(UUID, existing[2]),
                    cast(UUID, existing[0]),
                )
                await self._require_composition_access(
                    transaction, context, project_id, job.job_id, Action.RENDER_READ
                )
                return RenderSubmission(job, job.state == "queued")
            for profile in profiles:
                preview = await transaction.fetch_one(
                    """
                    SELECT object.id
                    FROM app.dataset_versions version
                    JOIN app.dataset_version_objects link
                      ON link.organization_id = version.organization_id
                     AND link.dataset_id = version.dataset_id
                     AND link.dataset_version_id = version.id
                    JOIN app.data_objects object
                      ON object.organization_id = link.organization_id
                     AND object.id = link.data_object_id
                    WHERE version.organization_id = %s AND version.dataset_id = %s
                      AND version.id = %s AND version.state = 'active'
                      AND object.role = 'derived'
                      AND object.content_type = 'application/geo+json'
                      AND object.size_bytes BETWEEN 1 AND 16777216
                      AND object.object_key LIKE '%%/derivatives/preview/preview.geojson'
                    ORDER BY object.id LIMIT 1
                    """,
                    (
                        context.organization_id,
                        profile.dataset_id,
                        profile.dataset_version_id,
                    ),
                )
                if preview is None:
                    raise RenderConflict("render_preview_unavailable")
            anchor = profiles[0]
            await transaction.execute(
                """
                INSERT INTO app.map_render_jobs
                  (id, organization_id, project_id, resource_id, profile_id,
                   profile_version_id, idempotency_key, bbox, crs, width, height,
                   format, background_color, transparent, request_checksum_sha256,
                   composition_sealed, created_by, request_id)
                SELECT %s, %s, %s, %s, profile.id, version.id,
                       %s, %s, %s, %s, %s, %s, %s, %s, %s, false, %s, %s
                FROM app.map_render_profiles profile
                JOIN app.map_render_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                WHERE profile.organization_id = %s AND profile.project_id = %s
                  AND profile.resource_id = %s AND profile.id = %s
                  AND version.version_number = %s
                  AND version.checksum_sha256 = %s
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    anchor.resource_id,
                    request.idempotency_key,
                    Jsonb(list(request.bbox)),
                    request.crs,
                    request.width,
                    request.height,
                    request.format,
                    request.background_color,
                    request.transparent,
                    request_checksum,
                    context.user_id,
                    request_id,
                    context.organization_id,
                    project_id,
                    anchor.resource_id,
                    anchor.profile_id,
                    anchor.version_number,
                    anchor.checksum_sha256,
                ),
            )
            for position, profile in enumerate(profiles[1:], 2):
                await transaction.execute(
                    """
                    INSERT INTO app.map_render_job_layers
                      (organization_id, render_job_id, position, resource_id,
                       profile_id, profile_version_id)
                    SELECT %s, %s, %s, profile.resource_id, profile.id,
                           version.id
                    FROM app.map_render_profiles profile
                    JOIN app.map_render_profile_versions version
                      ON version.organization_id = profile.organization_id
                     AND version.profile_id = profile.id
                     AND version.id = profile.current_version_id
                    WHERE profile.organization_id = %s
                      AND profile.project_id = %s
                      AND profile.resource_id = %s
                      AND profile.id = %s
                      AND version.version_number = %s
                      AND version.checksum_sha256 = %s
                    """,
                    (
                        context.organization_id,
                        job_id,
                        position,
                        context.organization_id,
                        project_id,
                        profile.resource_id,
                        profile.profile_id,
                        profile.version_number,
                        profile.checksum_sha256,
                    ),
                )
            sealed = await transaction.fetch_one(
                "SELECT app.seal_map_render_composition(%s)", (job_id,)
            )
            if sealed is None or sealed[0] is not True:
                raise RenderConflict("render_composition_invalid")
            await self._event(
                transaction,
                context,
                project_id,
                anchor.resource_id,
                "map.render.composition.queued",
                request_id,
                {
                    "render_job_id": str(job_id),
                    "layer_count": len(profiles),
                    "profile_versions": [
                        {
                            "profile_id": str(profile.profile_id),
                            "version": profile.version_number,
                            "checksum_sha256": profile.checksum_sha256,
                        }
                        for profile in profiles
                    ],
                    "request_checksum_sha256": request_checksum,
                },
            )
            return RenderSubmission(
                await self._load_job(transaction, context, project_id, anchor.resource_id, job_id),
                True,
            )

        return await self._run(context, operation)

    async def get_project_map_catalog(
        self, context: TenantContext, project_id: UUID
    ) -> ProjectMapCatalog:
        async def operation(transaction: TenantTransaction) -> ProjectMapCatalog:
            roles, project_title = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_READ, roles)
            collection_rows = await transaction.fetch_all(
                """
                SELECT publication.id, publication.project_id,
                       publication.resource_id, publication.wms_name,
                       publication.default_profile_id, publication.created_by,
                       publication.created_at, publication.withdrawn_by,
                       publication.withdrawn_at, resource.slug, version.title,
                       version.abstract, version.attribution,
                       version.spatial_extent, version.temporal_start,
                       version.temporal_end
                FROM app.wms_layer_publications publication
                JOIN app.governed_resources resource
                  ON resource.organization_id = publication.organization_id
                 AND resource.project_id = publication.project_id
                 AND resource.id = publication.resource_id
                JOIN app.governed_resource_versions version
                  ON version.organization_id = resource.organization_id
                 AND version.resource_id = resource.id
                 AND version.id = resource.current_version_id
                WHERE publication.organization_id = %s
                  AND publication.project_id = %s
                  AND publication.withdrawn_at IS NULL
                  AND resource.kind IN ('dataset', 'service')
                  AND resource.state = 'published'
                  AND EXISTS (
                    SELECT 1 FROM app.map_render_profiles profile
                    WHERE profile.organization_id = resource.organization_id
                      AND profile.project_id = resource.project_id
                      AND profile.resource_id = resource.id
                      AND profile.id = publication.default_profile_id
                  )
                ORDER BY lower(publication.wms_name), publication.id
                """,
                (context.organization_id, project_id),
            )
            profile_rows = await transaction.fetch_all(
                f"""{self._profile_select()}
                WHERE profile.organization_id = %s AND profile.project_id = %s
                ORDER BY profile.resource_id, lower(version.title), profile.id
                """,
                (context.organization_id, project_id),
            )
            profiles_by_resource: dict[UUID, list[RenderProfile]] = {}
            for row in profile_rows:
                profile = self._profile(row)
                profiles_by_resource.setdefault(profile.resource_id, []).append(profile)
            layers: list[ProjectMapLayer] = []
            for row in collection_rows:
                publication = self._publication(row[:9])
                raw_extent = cast(list[Any] | None, row[13])
                extent = (
                    None
                    if raw_extent is None
                    else cast(
                        tuple[float, float, float, float],
                        tuple(float(value) for value in raw_extent),
                    )
                )
                resource_id = publication.resource_id
                available_profiles = profiles_by_resource.get(resource_id, ())
                default_profile = next(
                    (
                        profile
                        for profile in available_profiles
                        if profile.profile_id == publication.default_profile_id
                    ),
                    None,
                )
                if default_profile is None:
                    continue
                profiles = (
                    default_profile,
                    *(profile for profile in available_profiles if profile is not default_profile),
                )
                layers.append(
                    ProjectMapLayer(
                        publication=publication,
                        collection=MapCollection(
                            resource_id=resource_id,
                            slug=cast(str, row[9]),
                            title=cast(str, row[10]),
                            description=cast(str | None, row[11]),
                            attribution=cast(str | None, row[12]),
                            spatial_extent=extent,
                            temporal_start=cast(datetime | None, row[14]),
                            temporal_end=cast(datetime | None, row[15]),
                        ),
                        profiles=profiles,
                    )
                )
            return ProjectMapCatalog(project_title, tuple(layers))

        return await self._run(context, operation)

    async def list_profiles(
        self, context: TenantContext, project_id: UUID, resource_id: UUID
    ) -> list[RenderProfile]:
        async def operation(transaction: TenantTransaction) -> list[RenderProfile]:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            rows = await transaction.fetch_all(
                f"""{self._profile_select()}
                WHERE profile.organization_id = %s
                  AND profile.project_id = %s
                  AND profile.resource_id = %s
                ORDER BY lower(version.title), profile.id
                """,
                (context.organization_id, project_id, resource_id),
            )
            return [self._profile(row) for row in rows]

        return await self._run(context, operation)

    async def get_profile(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, profile_id: UUID
    ) -> RenderProfile:
        async def operation(transaction: TenantTransaction) -> RenderProfile:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            return await self._load_profile(
                transaction, context, project_id, resource_id, profile_id
            )

        return await self._run(context, operation)

    async def create_profile(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        draft: RenderProfileDraft,
        request_id: str,
    ) -> RenderProfile:
        profile_id, version_id = uuid4(), uuid4()

        async def operation(transaction: TenantTransaction) -> RenderProfile:
            self._require(
                Action.RENDER_CONFIGURE,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            snapshot = await self._snapshot(
                transaction, context, project_id, resource_id, draft.style_id
            )
            configuration, checksum = self._compile(draft, snapshot)
            await transaction.execute(
                """
                INSERT INTO app.map_render_profiles
                  (id, organization_id, project_id, resource_id, slug,
                   current_version_id, created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    profile_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    draft.slug,
                    version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await self._insert_version(
                transaction,
                context,
                profile_id,
                resource_id,
                version_id,
                1,
                draft,
                snapshot,
                configuration,
                checksum,
            )
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.profile.created",
                request_id,
                {"profile_id": str(profile_id), "version": 1},
            )
            return await self._load_profile(
                transaction, context, project_id, resource_id, profile_id
            )

        return await self._run(context, operation)

    async def update_profile(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
        expected_version: int,
        draft: RenderProfileDraft,
        request_id: str,
    ) -> RenderProfile:
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> RenderProfile:
            self._require(
                Action.RENDER_CONFIGURE,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            current = await transaction.fetch_one(
                """
                SELECT version.version_number
                FROM app.map_render_profiles profile
                JOIN app.map_render_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                WHERE profile.organization_id = %s AND profile.project_id = %s
                  AND profile.resource_id = %s AND profile.id = %s
                FOR UPDATE OF profile
                """,
                (context.organization_id, project_id, resource_id, profile_id),
            )
            if current is None:
                raise RenderNotFound("render_profile")
            current_version = cast(int, current[0])
            if current_version != expected_version:
                raise RenderConflict(
                    "render_profile_version_conflict", current_version=current_version
                )
            snapshot = await self._snapshot(
                transaction, context, project_id, resource_id, draft.style_id
            )
            configuration, checksum = self._compile(draft, snapshot)
            next_version = current_version + 1
            await self._insert_version(
                transaction,
                context,
                profile_id,
                resource_id,
                version_id,
                next_version,
                draft,
                snapshot,
                configuration,
                checksum,
            )
            await transaction.execute(
                """
                UPDATE app.map_render_profiles
                SET current_version_id = %s, updated_by = %s
                WHERE organization_id = %s AND project_id = %s
                  AND resource_id = %s AND id = %s
                """,
                (
                    version_id,
                    context.user_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    profile_id,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.profile.version.created",
                request_id,
                {"profile_id": str(profile_id), "version": next_version},
            )
            return await self._load_profile(
                transaction, context, project_id, resource_id, profile_id
            )

        return await self._run(context, operation)

    async def request_render(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
        request: RenderRequest,
        request_id: str,
    ) -> RenderSubmission:
        job_id = uuid4()

        async def operation(transaction: TenantTransaction) -> RenderSubmission:
            self._require(
                Action.RENDER_REQUEST,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            profile = await self._load_profile(
                transaction, context, project_id, resource_id, profile_id
            )
            if (
                request.expected_profile_version is not None
                and request.expected_profile_version != profile.version_number
            ):
                raise RenderConflict(
                    "render_profile_version_changed",
                    current_version=profile.version_number,
                )
            request_checksum = self._request_checksum(profile, request)
            existing = await transaction.fetch_one(
                """
                SELECT id, request_checksum_sha256
                FROM app.map_render_jobs
                WHERE organization_id = %s AND idempotency_key = %s
                """,
                (context.organization_id, request.idempotency_key),
            )
            if existing is not None:
                if cast(str, existing[1]) != request_checksum:
                    raise RenderConflict("render_idempotency_conflict")
                job = await self._load_job(
                    transaction,
                    context,
                    project_id,
                    resource_id,
                    cast(UUID, existing[0]),
                )
                return RenderSubmission(job, job.state == "queued")
            preview = await transaction.fetch_one(
                """
                SELECT object.id
                FROM app.dataset_versions version
                JOIN app.dataset_version_objects link
                  ON link.organization_id = version.organization_id
                 AND link.dataset_id = version.dataset_id
                 AND link.dataset_version_id = version.id
                JOIN app.data_objects object
                  ON object.organization_id = link.organization_id
                 AND object.id = link.data_object_id
                WHERE version.organization_id = %s AND version.dataset_id = %s
                  AND version.id = %s AND version.state = 'active'
                  AND object.role = 'derived'
                  AND object.content_type = 'application/geo+json'
                  AND object.size_bytes BETWEEN 1 AND 16777216
                  AND object.object_key LIKE '%%/derivatives/preview/preview.geojson'
                ORDER BY object.id LIMIT 1
                """,
                (
                    context.organization_id,
                    profile.dataset_id,
                    profile.dataset_version_id,
                ),
            )
            if preview is None:
                raise RenderConflict("render_preview_unavailable")
            await transaction.execute(
                """
                INSERT INTO app.map_render_jobs
                  (id, organization_id, project_id, resource_id, profile_id,
                   profile_version_id, idempotency_key, bbox, crs, width, height,
                   format, background_color, transparent, request_checksum_sha256,
                   created_by, request_id)
                SELECT %s, %s, %s, %s, profile.id, version.id,
                       %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                FROM app.map_render_profiles profile
                JOIN app.map_render_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                WHERE profile.organization_id = %s AND profile.project_id = %s
                  AND profile.resource_id = %s AND profile.id = %s
                  AND version.version_number = %s
                  AND version.checksum_sha256 = %s
                """,
                (
                    job_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    request.idempotency_key,
                    Jsonb(list(request.bbox)),
                    request.crs,
                    request.width,
                    request.height,
                    request.format,
                    request.background_color,
                    request.transparent,
                    request_checksum,
                    context.user_id,
                    request_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    profile_id,
                    profile.version_number,
                    profile.checksum_sha256,
                ),
            )
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.queued",
                request_id,
                {
                    "render_job_id": str(job_id),
                    "profile_id": str(profile_id),
                    "profile_version": profile.version_number,
                    "request_checksum_sha256": request_checksum,
                },
            )
            return RenderSubmission(
                await self._load_job(transaction, context, project_id, resource_id, job_id),
                True,
            )

        return await self._run(context, operation)

    async def find_job_by_idempotency(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        idempotency_key: UUID,
    ) -> RenderJob | None:
        async def operation(transaction: TenantTransaction) -> RenderJob | None:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            row = await transaction.fetch_one(
                f"""{self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.resource_id = %s AND job.idempotency_key = %s
                """,
                (context.organization_id, project_id, resource_id, idempotency_key),
            )
            if row is None:
                return None
            job = self._job(row)
            if job.saved_map_snapshot is not None:
                await self._require_composition_access(
                    transaction, context, project_id, job.job_id, Action.RENDER_READ
                )
            return job

        return await self._run(context, operation)

    async def get_job(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, job_id: UUID
    ) -> RenderJob:
        async def operation(transaction: TenantTransaction) -> RenderJob:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            job = await self._load_job(transaction, context, project_id, resource_id, job_id)
            if job.saved_map_snapshot is not None:
                await self._require_composition_access(
                    transaction, context, project_id, job_id, Action.RENDER_READ
                )
            return job

        return await self._run(context, operation)

    async def list_portable_cleanup_attempts(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> list[dict[str, Any]]:
        from opengeo_api.portable_artifact_cleanup import list_cleanup_attempts

        return await list_cleanup_attempts(self, context, project_id, resource_id, upload_id)

    async def request_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        manifest_bytes: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        from opengeo_api.portable_artifact_uploads import request_portable_upload

        if self._artifact_uploads is None:
            raise RenderConflict("artifact_upload_not_configured")
        return await request_portable_upload(
            self,
            self._artifact_uploads,
            context,
            project_id,
            resource_id,
            manifest_bytes,
            expected_revision,
        )

    async def complete_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> dict[str, Any]:
        from opengeo_api.portable_artifact_uploads import complete_portable_upload

        if self._artifact_uploads is None:
            raise RenderConflict("artifact_upload_not_configured")
        return await complete_portable_upload(
            self, self._artifact_uploads, context, project_id, resource_id, upload_id
        )

    async def cleanup_portable_upload(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        upload_id: UUID,
    ) -> dict[str, Any]:
        from opengeo_api.portable_artifact_cleanup import cleanup_expired_portable_upload

        if self._artifact_cleanup is None:
            raise RenderConflict("artifact_cleanup_not_configured")
        return await cleanup_expired_portable_upload(
            self, self._artifact_cleanup, context, project_id, resource_id, upload_id
        )

    async def register_retained_portable_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        output_object_id: UUID,
        manifest_bytes: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        from opengeo_api.portable_artifact_registration import register_retained_portable_edition

        return await register_retained_portable_edition(
            self,
            context,
            project_id,
            resource_id,
            output_object_id,
            manifest_bytes,
            expected_revision,
        )

    async def register_portable_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        output_object_id: UUID,
        html: bytes,
        manifest_bytes: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        from opengeo_api.portable_artifact_registration import register_portable_edition

        return await register_portable_edition(
            self,
            context,
            project_id,
            resource_id,
            output_object_id,
            html,
            manifest_bytes,
            expected_revision,
        )

    async def register_artifact_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        expected_revision: int,
    ) -> dict[str, Any]:
        from opengeo_api.project_artifacts import register_artifact_edition

        return await register_artifact_edition(
            self, context, project_id, resource_id, job_id, expected_revision
        )

    async def read_artifact_edition(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None,
        metadata_only: bool = False,
        representation: str = "saved-map-image",
    ) -> dict[str, Any]:
        from opengeo_api.project_artifacts import read_artifact_edition

        return await read_artifact_edition(
            self, context, project_id, resource_id, version_number, metadata_only, representation
        )

    async def request_portable_download(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int | None,
    ) -> DownloadTicket:
        from opengeo_api.project_artifacts import request_portable_download

        return await request_portable_download(
            self, context, project_id, resource_id, version_number
        )

    async def select_artifact_current(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        version_number: int,
        expected_revision: int,
        representation: str = "saved-map-image",
    ) -> dict[str, Any]:
        from opengeo_api.project_artifacts import select_artifact_current

        return await select_artifact_current(
            self,
            context,
            project_id,
            resource_id,
            version_number,
            expected_revision,
            representation,
        )

    async def get_project_artifact(
        self, context: TenantContext, project_id: UUID, resource_id: UUID, job_id: UUID
    ) -> dict[str, Any]:
        from opengeo_api.project_artifacts import read_project_artifact

        return await read_project_artifact(self, context, project_id, resource_id, job_id)

    async def get_composite_job(
        self, context: TenantContext, project_id: UUID, job_id: UUID
    ) -> RenderJob:
        async def operation(transaction: TenantTransaction) -> RenderJob:
            roles, _ = await self._project_roles(transaction, context, project_id)
            self._require(Action.PROJECT_READ, roles)
            row = await transaction.fetch_one(
                f"""{self._job_select()}
                WHERE job.organization_id = %s AND job.project_id = %s
                  AND job.id = %s AND job.composition_sealed
                """,
                (context.organization_id, project_id, job_id),
            )
            if row is None:
                raise RenderNotFound("render_job")
            job = self._job(row)
            await self._require_composition_access(
                transaction, context, project_id, job.job_id, Action.RENDER_READ
            )
            return job

        return await self._run(context, operation)

    async def request_download(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket:
        async def prepare(transaction: TenantTransaction) -> _DownloadTarget:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            return await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )

        target = await self._run(context, prepare)
        ticket = await self._downloads.create_download_url(
            DownloadSpec(target.bucket, target.key, target.version_id, target.filename)
        )

        async def attribute(transaction: TenantTransaction) -> None:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            checked = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if checked != target:
                raise RenderConflict("render_output_changed")
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.download.issued",
                request_id,
                {"render_job_id": str(job_id), "output_object_id": str(target.object_id)},
            )

        await self._run(context, attribute)
        return ticket

    async def request_composite_download(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        request_id: str,
    ) -> DownloadTicket:
        async def prepare(transaction: TenantTransaction) -> tuple[UUID, _DownloadTarget]:
            resource_id = await self._composition_anchor(
                transaction, context, project_id, job_id, Action.RENDER_READ
            )
            return resource_id, await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )

        resource_id, target = await self._run(context, prepare)
        ticket = await self._downloads.create_download_url(
            DownloadSpec(target.bucket, target.key, target.version_id, target.filename)
        )

        async def attribute(transaction: TenantTransaction) -> None:
            checked_resource_id = await self._composition_anchor(
                transaction, context, project_id, job_id, Action.RENDER_READ
            )
            checked = await self._download_target(
                transaction, context, project_id, checked_resource_id, job_id
            )
            if checked_resource_id != resource_id or checked != target:
                raise RenderConflict("render_output_changed")
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.composition.download.issued",
                request_id,
                {"render_job_id": str(job_id), "output_object_id": str(target.object_id)},
            )

        await self._run(context, attribute)
        return ticket

    async def read_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
        request_id: str,
    ) -> RenderedMapOutput:
        async def prepare(transaction: TenantTransaction) -> _DownloadTarget:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            target = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if target.size_bytes > maximum_bytes:
                raise RenderConflict("render_output_too_large")
            return target

        target = await self._run(context, prepare)
        exact = await self._downloads.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=maximum_bytes,
            )
        )

        async def attribute(transaction: TenantTransaction) -> None:
            self._require(
                Action.RENDER_READ,
                await self._resource_roles(transaction, context, project_id, resource_id),
            )
            checked = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if checked != target:
                raise RenderConflict("render_output_changed")
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.served",
                request_id,
                {
                    "render_job_id": str(job_id),
                    "output_object_id": str(target.object_id),
                    "output_checksum_sha256": target.checksum_sha256,
                },
            )

        await self._run(context, attribute)
        return RenderedMapOutput(
            body=exact.body,
            filename=target.filename,
            content_type=exact.content_type,
            size_bytes=exact.size_bytes,
            checksum_sha256=exact.checksum_sha256,
            version_id=exact.version_id,
        )

    async def read_composite_map_output(
        self,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
        request_id: str,
    ) -> RenderedMapOutput:
        async def prepare(transaction: TenantTransaction) -> tuple[UUID, _DownloadTarget]:
            resource_id = await self._composition_anchor(
                transaction, context, project_id, job_id, Action.RENDER_READ
            )
            target = await self._download_target(
                transaction, context, project_id, resource_id, job_id
            )
            if target.size_bytes > maximum_bytes:
                raise RenderConflict("render_output_too_large")
            return resource_id, target

        resource_id, target = await self._run(context, prepare)
        exact = await self._downloads.read_exact_object(
            ExactObjectSpec(
                bucket=target.bucket,
                key=target.key,
                version_id=target.version_id,
                content_type=target.content_type,
                size_bytes=target.size_bytes,
                checksum_sha256=target.checksum_sha256,
                maximum_bytes=maximum_bytes,
            )
        )

        async def attribute(transaction: TenantTransaction) -> None:
            checked_resource_id = await self._composition_anchor(
                transaction, context, project_id, job_id, Action.RENDER_READ
            )
            checked = await self._download_target(
                transaction, context, project_id, checked_resource_id, job_id
            )
            if checked_resource_id != resource_id or checked != target:
                raise RenderConflict("render_output_changed")
            await self._event(
                transaction,
                context,
                project_id,
                resource_id,
                "map.render.composition.served",
                request_id,
                {
                    "render_job_id": str(job_id),
                    "output_object_id": str(target.object_id),
                    "output_checksum_sha256": target.checksum_sha256,
                },
            )

        await self._run(context, attribute)
        return RenderedMapOutput(
            body=exact.body,
            filename=target.filename,
            content_type=exact.content_type,
            size_bytes=exact.size_bytes,
            checksum_sha256=exact.checksum_sha256,
            version_id=exact.version_id,
        )

    @staticmethod
    def _compile(
        draft: RenderProfileDraft, snapshot: _RenderSnapshot
    ) -> tuple[dict[str, Any], str]:
        try:
            return compile_maplibre_render_configuration(
                snapshot.style_definition,
                style_id=str(snapshot.style_id),
                style_version_id=str(snapshot.style_version_id),
                style_version_number=snapshot.style_version_number,
                style_checksum_sha256=snapshot.style_checksum_sha256,
                geometry_layer_id=draft.geometry_layer_id,
                label_layer_id=draft.label_layer_id,
                minimum_scale_denominator=draft.minimum_scale_denominator,
                maximum_scale_denominator=draft.maximum_scale_denominator,
                include_legend=draft.include_legend,
            )
        except MapLibreRenderUnsupported as error:
            raise RenderConflict(str(error)) from error

    @staticmethod
    async def _snapshot(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        style_id: UUID,
    ) -> _RenderSnapshot:
        row = await transaction.fetch_one(
            """
            SELECT resource.current_version_id, resource.dataset_id,
                   dataset.current_version_id, style.id, style.current_version_id,
                   style_version.version_number, style_version.definition,
                   style_version.checksum_sha256
            FROM app.governed_resources resource
            JOIN app.project_datasets project_dataset
              ON project_dataset.organization_id = resource.organization_id
             AND project_dataset.project_id = resource.project_id
             AND project_dataset.dataset_id = resource.dataset_id
            JOIN app.datasets dataset
              ON dataset.organization_id = project_dataset.organization_id
             AND dataset.id = project_dataset.dataset_id
            JOIN app.dataset_versions dataset_version
              ON dataset_version.organization_id = dataset.organization_id
             AND dataset_version.dataset_id = dataset.id
             AND dataset_version.id = dataset.current_version_id
            JOIN app.governed_resource_styles style
              ON style.organization_id = resource.organization_id
             AND style.resource_id = resource.id
             AND style.id = %s
            JOIN app.governed_resource_style_versions style_version
              ON style_version.organization_id = style.organization_id
             AND style_version.style_id = style.id
             AND style_version.id = style.current_version_id
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = %s AND resource.kind IN ('dataset', 'service')
              AND resource.dataset_id IS NOT NULL AND resource.state <> 'archived'
              AND dataset.status = 'active' AND dataset_version.state = 'active'
              AND style.format = 'maplibre'
            """,
            (style_id, context.organization_id, project_id, resource_id),
        )
        if row is None:
            raise RenderConflict("render_snapshot_unavailable")
        return _RenderSnapshot(
            resource_version_id=cast(UUID, row[0]),
            dataset_id=cast(UUID, row[1]),
            dataset_version_id=cast(UUID, row[2]),
            style_id=cast(UUID, row[3]),
            style_version_id=cast(UUID, row[4]),
            style_version_number=cast(int, row[5]),
            style_definition=cast(str, row[6]),
            style_checksum_sha256=cast(str, row[7]),
        )

    @staticmethod
    async def _insert_version(
        transaction: TenantTransaction,
        context: TenantContext,
        profile_id: UUID,
        resource_id: UUID,
        version_id: UUID,
        version_number: int,
        draft: RenderProfileDraft,
        snapshot: _RenderSnapshot,
        configuration: dict[str, Any],
        checksum: str,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.map_render_profile_versions
              (id, organization_id, profile_id, resource_id,
               resource_version_id, dataset_id, dataset_version_id,
               style_id, style_version_id, version_number, title,
               configuration, checksum_sha256, change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                profile_id,
                resource_id,
                snapshot.resource_version_id,
                snapshot.dataset_id,
                snapshot.dataset_version_id,
                snapshot.style_id,
                snapshot.style_version_id,
                version_number,
                draft.title,
                Jsonb(configuration),
                checksum,
                draft.change_message,
                context.user_id,
            ),
        )

    async def _load_profile(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
    ) -> RenderProfile:
        row = await transaction.fetch_one(
            f"""{self._profile_select()}
            WHERE profile.organization_id = %s AND profile.project_id = %s
              AND profile.resource_id = %s AND profile.id = %s
            """,
            (context.organization_id, project_id, resource_id, profile_id),
        )
        if row is None:
            raise RenderNotFound("render_profile")
        return self._profile(row)

    async def _load_job(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
    ) -> RenderJob:
        row = await transaction.fetch_one(
            f"""{self._job_select()}
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.resource_id = %s AND job.id = %s
            """,
            (context.organization_id, project_id, resource_id, job_id),
        )
        if row is None:
            raise RenderNotFound("render_job")
        return self._job(row)

    async def _download_target(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        *,
        public_saved_map: bool = False,
    ) -> _DownloadTarget:
        row = await transaction.fetch_one(
            """
            SELECT object.bucket, object.object_key, object.s3_version_id,
                   resource.slug || '-' || job.id::text ||
                     CASE job.format::text WHEN 'svg' THEN '.svg' WHEN 'png' THEN '.png' END,
                   object.id,
                   object.content_type, object.size_bytes, object.checksum_sha256,
                   binding.resource_version_id, resource.kind::text
            FROM app.map_render_jobs job
            JOIN app.governed_resources resource
              ON resource.organization_id = job.organization_id
             AND resource.project_id = job.project_id
             AND resource.id = job.resource_id
            JOIN app.data_objects object
              ON object.organization_id = job.organization_id
             AND object.id = job.output_object_id
            LEFT JOIN app.map_render_job_bindings binding
              ON binding.organization_id = job.organization_id AND binding.render_job_id = job.id
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.resource_id = %s AND job.id = %s
              AND job.state = 'completed'
              AND object.content_type = CASE job.format::text
                WHEN 'svg' THEN 'image/svg+xml'
                WHEN 'png' THEN 'image/png'
              END
            """,
            (context.organization_id, project_id, resource_id, job_id),
        )
        if row is None:
            raise RenderConflict("render_output_unavailable")
        if len(row) > 9 and row[9] == "map":
            from opengeo_api.saved_map_publication import load_saved_map_seal

            if row[8] is None:
                raise RenderConflict("saved_map_binding_unavailable")
            await load_saved_map_seal(
                transaction,
                context,
                project_id,
                resource_id,
                cast(UUID, row[8]),
                job_id,
                public=public_saved_map,
                repository=self,
            )
        return _DownloadTarget(
            bucket=cast(str, row[0]),
            key=cast(str, row[1]),
            version_id=cast(str, row[2]),
            filename=cast(str, row[3]),
            object_id=cast(UUID, row[4]),
            content_type=cast(str, row[5]),
            size_bytes=cast(int, row[6]),
            checksum_sha256=cast(str, row[7]),
        )

    async def _composition_anchor(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        action: Action,
    ) -> UUID:
        await self._require_composition_access(transaction, context, project_id, job_id, action)
        row = await transaction.fetch_one(
            """
            SELECT resource_id
            FROM app.map_render_jobs
            WHERE organization_id = %s AND project_id = %s AND id = %s
              AND composition_sealed
            """,
            (context.organization_id, project_id, job_id),
        )
        if row is None:
            raise RenderNotFound("render_job")
        return cast(UUID, row[0])

    async def _require_composition_access(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        job_id: UUID,
        action: Action,
    ) -> None:
        rows = await transaction.fetch_all(
            """
            SELECT layer.position, layer.resource_id, binding.resource_version_id
            FROM app.map_render_jobs job
            JOIN app.map_render_job_layers layer
              ON layer.organization_id = job.organization_id
             AND layer.render_job_id = job.id
            LEFT JOIN app.map_render_job_bindings binding
              ON binding.organization_id = job.organization_id AND binding.render_job_id = job.id
            WHERE job.organization_id = %s AND job.project_id = %s
              AND job.id = %s AND job.composition_sealed
            ORDER BY layer.position
            """,
            (context.organization_id, project_id, job_id),
        )
        positions = tuple(cast(int, row[0]) for row in rows)
        if not 1 <= len(rows) <= 16 or positions != tuple(range(1, len(rows) + 1)):
            raise RenderNotFound("render_job")
        for row in rows:
            self._require(
                action,
                await self._resource_roles(transaction, context, project_id, cast(UUID, row[1])),
            )
        if len(rows[0]) > 2 and rows[0][2] is not None:
            from opengeo_api.saved_map_publication import load_saved_map_seal

            await load_saved_map_seal(
                transaction,
                context,
                project_id,
                cast(UUID, rows[0][1]),
                cast(UUID, rows[0][2]),
                job_id,
                public=False,
                repository=self,
            )

    async def _require_public_composition(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        job_id: UUID,
        expected_resource_ids: tuple[UUID, ...],
    ) -> UUID:
        rows = await transaction.fetch_all(
            """
            SELECT layer.position, layer.resource_id
            FROM app.map_render_jobs job
            JOIN app.map_render_job_layers layer
              ON layer.organization_id = job.organization_id
             AND layer.render_job_id = job.id
            WHERE job.organization_id = %s
              AND job.project_id = %s
              AND job.id = %s
              AND job.composition_sealed
            ORDER BY layer.position
            """,
            (context.organization_id, project_id, job_id),
        )
        positions = tuple(cast(int, row[0]) for row in rows)
        resource_ids = tuple(cast(UUID, row[1]) for row in rows)
        if (
            not 2 <= len(rows) <= 16
            or positions != tuple(range(1, len(rows) + 1))
            or resource_ids != expected_resource_ids
        ):
            raise RenderNotFound("public_wms_layer")
        for resource_id in resource_ids:
            await self._require_public_resource(
                transaction, context, project_id, service_id, resource_id
            )
        return resource_ids[0]

    @staticmethod
    async def _require_public_resource(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        resource_id: UUID,
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT 1
            FROM app.public_wms_services service
            JOIN app.wms_layer_publications publication
              ON publication.organization_id = service.organization_id
             AND publication.project_id = service.project_id
             AND publication.resource_id = %s
             AND publication.withdrawn_at IS NULL
            JOIN app.governed_resources resource
              ON resource.organization_id = publication.organization_id
             AND resource.project_id = publication.project_id
             AND resource.id = publication.resource_id
            WHERE service.organization_id = %s
              AND service.project_id = %s
              AND service.id = %s
              AND service.disabled_at IS NULL
              AND resource.kind IN ('dataset', 'service')
              AND resource.state = 'published'
              AND resource.visibility = 'public'
            """,
            (resource_id, context.organization_id, project_id, service_id),
        )
        if row is None:
            raise RenderNotFound("public_wms_layer")

    @staticmethod
    async def _project_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
    ) -> tuple[Roles, str]:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text,
                   project.name
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            """,
            (project_id, context.organization_id, context.user_id),
        )
        if row is None:
            raise RenderNotFound("project")
        return (
            Roles(
                organization=cast(OrganizationRole, row[0]),
                project=cast(ProjectRole | None, row[1]),
            ),
            cast(str, row[2]),
        )

    @staticmethod
    async def _resource_roles(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
    ) -> Roles:
        row = await transaction.fetch_one(
            """
            SELECT organization.role::text,
                   app.effective_project_role(project.id, organization.user_id)::text,
                   permission.role::text, resource.owner_user_id = %s
            FROM app.organization_memberships organization
            JOIN app.projects project
              ON project.organization_id = organization.organization_id
             AND project.id = %s
            JOIN app.governed_resources resource
              ON resource.organization_id = project.organization_id
             AND resource.project_id = project.id
             AND resource.id = %s
            LEFT JOIN app.governed_resource_permissions permission
              ON permission.organization_id = resource.organization_id
             AND permission.resource_id = resource.id
             AND permission.user_id = organization.user_id
            WHERE organization.organization_id = %s
              AND organization.user_id = %s
            """,
            (
                context.user_id,
                project_id,
                resource_id,
                context.organization_id,
                context.user_id,
            ),
        )
        if row is None:
            raise RenderNotFound("resource")
        return Roles(
            organization=cast(OrganizationRole, row[0]),
            project=cast(ProjectRole | None, row[1]),
            resource=cast(ResourcePermissionRole | None, row[2]),
            resource_owner=cast(bool, row[3]),
        )

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise RenderAccessDenied("action forbidden") from error

    @staticmethod
    async def _event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        resource_id: UUID,
        event_type: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'governed_resource', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    async def _public_service_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        service_id: UUID,
        event_type: str,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, 'public_wms_service', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                service_id,
                request_id,
                Jsonb(payload),
            ),
        )

    @staticmethod
    def _request_checksum(profile: RenderProfile, request: RenderRequest) -> str:
        return render_request_checksum((profile,), request)

    @staticmethod
    def _profile_select() -> str:
        return """
            SELECT profile.id, profile.project_id, profile.resource_id,
                   profile.slug, version.version_number, version.title,
                   version.resource_version_id, version.dataset_id,
                   version.dataset_version_id, version.style_id,
                   version.style_version_id, version.configuration,
                   version.checksum_sha256, version.change_message,
                   version.created_by, version.created_at, profile.updated_at
            FROM app.map_render_profiles profile
            JOIN app.map_render_profile_versions version
              ON version.organization_id = profile.organization_id
             AND version.profile_id = profile.id
             AND version.id = profile.current_version_id
        """

    @staticmethod
    def _publication_select() -> str:
        return """
            SELECT publication.id, publication.project_id,
                   publication.resource_id, publication.wms_name,
                   publication.default_profile_id, publication.created_by,
                   publication.created_at, publication.withdrawn_by,
                   publication.withdrawn_at
            FROM app.wms_layer_publications publication
        """

    @staticmethod
    def _public_service_select() -> str:
        return """
            SELECT service.id, service.project_id, service.title,
                   service.created_by, service.created_at,
                   service.disabled_by, service.disabled_at
            FROM app.public_wms_services service
        """

    @staticmethod
    def _job_select() -> str:
        return """
            SELECT job.id, job.project_id, job.resource_id, job.profile_id,
                   job.profile_version_id, profile.version_number,
                   profile.dataset_id, profile.dataset_version_id,
                   profile.style_id, profile.style_version_id, job.bbox,
                   job.crs, job.width, job.height, job.format::text,
                   job.background_color, job.transparent,
                   job.request_checksum_sha256, job.state::text,
                   job.attempt_count, job.output_object_id,
                   object.content_type, object.size_bytes, object.checksum_sha256,
                   job.error_code, job.created_by, job.created_at,
                   job.started_at, job.finished_at,
                   CASE WHEN saved_binding.render_job_id IS NOT NULL THEN jsonb_build_object(
                     'resource_version_id', saved_binding.resource_version_id,
                     'resource_version_number', saved_resource_version.version_number,
                     'map_id', saved_revision.map_id, 'map_version', saved_revision.map_version,
                     'definition_checksum_sha256', saved_binding.definition_checksum_sha256,
                     'recipe_checksum_sha256', saved_binding.recipe_checksum_sha256
                   ) END
            FROM app.map_render_jobs job
            JOIN app.map_render_profile_versions profile
              ON profile.organization_id = job.organization_id
             AND profile.profile_id = job.profile_id
             AND profile.id = job.profile_version_id
            LEFT JOIN app.data_objects object
              ON object.organization_id = job.organization_id
             AND object.id = job.output_object_id
            LEFT JOIN app.map_render_job_bindings saved_binding
              ON saved_binding.organization_id = job.organization_id
             AND saved_binding.render_job_id = job.id
            LEFT JOIN app.map_resource_version_bindings saved_revision
              ON saved_revision.organization_id = saved_binding.organization_id
             AND saved_revision.resource_id = saved_binding.resource_id
             AND saved_revision.resource_version_id = saved_binding.resource_version_id
            LEFT JOIN app.governed_resource_versions saved_resource_version
              ON saved_resource_version.organization_id = saved_binding.organization_id
             AND saved_resource_version.resource_id = saved_binding.resource_id
             AND saved_resource_version.id = saved_binding.resource_version_id
        """

    @staticmethod
    def _profile(row: tuple[Any, ...]) -> RenderProfile:
        return RenderProfile(
            profile_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            resource_id=cast(UUID, row[2]),
            slug=cast(str, row[3]),
            version_number=cast(int, row[4]),
            title=cast(str, row[5]),
            resource_version_id=cast(UUID, row[6]),
            dataset_id=cast(UUID, row[7]),
            dataset_version_id=cast(UUID, row[8]),
            style_id=cast(UUID, row[9]),
            style_version_id=cast(UUID, row[10]),
            configuration=cast(dict[str, Any], row[11]),
            checksum_sha256=cast(str, row[12]),
            change_message=cast(str | None, row[13]),
            created_by=cast(UUID, row[14]),
            created_at=cast(datetime, row[15]),
            updated_at=cast(datetime, row[16]),
        )

    @staticmethod
    def _publication(row: tuple[Any, ...]) -> WmsLayerPublication:
        return WmsLayerPublication(
            publication_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            resource_id=cast(UUID, row[2]),
            name=cast(str, row[3]),
            default_profile_id=cast(UUID, row[4]),
            created_by=cast(UUID, row[5]),
            created_at=cast(datetime, row[6]),
            withdrawn_by=cast(UUID | None, row[7]),
            withdrawn_at=cast(datetime | None, row[8]),
        )

    @staticmethod
    def _public_service(row: tuple[Any, ...]) -> PublicWmsService:
        return PublicWmsService(
            service_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            title=cast(str, row[2]),
            created_by=cast(UUID, row[3]),
            created_at=cast(datetime, row[4]),
            disabled_by=cast(UUID | None, row[5]),
            disabled_at=cast(datetime | None, row[6]),
        )

    @staticmethod
    def _job(row: tuple[Any, ...]) -> RenderJob:
        return RenderJob(
            job_id=cast(UUID, row[0]),
            project_id=cast(UUID, row[1]),
            resource_id=cast(UUID, row[2]),
            profile_id=cast(UUID, row[3]),
            profile_version_id=cast(UUID, row[4]),
            profile_version_number=cast(int, row[5]),
            dataset_id=cast(UUID, row[6]),
            dataset_version_id=cast(UUID, row[7]),
            style_id=cast(UUID, row[8]),
            style_version_id=cast(UUID, row[9]),
            bbox=cast(
                tuple[float, float, float, float],
                tuple(float(value) for value in cast(list[Any], row[10])),
            ),
            crs=cast(RenderCrs, row[11]),
            width=cast(int, row[12]),
            height=cast(int, row[13]),
            format=cast(RenderFormat, row[14]),
            background_color=cast(str | None, row[15]),
            transparent=cast(bool, row[16]),
            request_checksum_sha256=cast(str, row[17]),
            state=cast(RenderJobState, row[18]),
            attempt_count=cast(int, row[19]),
            output_object_id=cast(UUID | None, row[20]),
            output_content_type=cast(str | None, row[21]),
            output_size_bytes=cast(int | None, row[22]),
            output_checksum_sha256=cast(str | None, row[23]),
            error_code=cast(str | None, row[24]),
            created_by=cast(UUID, row[25]),
            created_at=cast(datetime, row[26]),
            started_at=cast(datetime | None, row[27]),
            finished_at=cast(datetime | None, row[28]),
            saved_map_snapshot=cast(dict[str, Any] | None, row[29]) if len(row) > 29 else None,
        )
