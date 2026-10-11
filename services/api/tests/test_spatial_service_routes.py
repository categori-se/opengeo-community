import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import UUID
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.coverages import CoverageNotFound
from opengeo_api.features import (
    FeatureCollection,
    FeatureConflict,
    FeatureField,
    FeatureNotFound,
    FeaturePage,
    FeatureRecord,
)
from opengeo_api.rendering import (
    RenderedMapOutput,
    RenderJob,
    RenderProfile,
    RenderSubmission,
)
from opengeo_api.sos import (
    NS as SOS_NAMESPACES,
)
from opengeo_api.sos import (
    SOS_PHENOMENON_TIME_FIELD,
    SOS_PROCEDURE_DESCRIPTION_FORMAT,
    SOS_RESPONSE_FORMAT,
    SOS_RESULT_FIELD,
    SOS_RESULT_UNIT_FIELD,
)
from opengeo_api.spatial_service_routes import (
    EPSG3857,
    OGC_CRS84,
    WEB_MERCATOR_LIMIT,
    WEB_MERCATOR_QUAD_URI,
    service_api_document,
    web_mercator_tile_bbox,
)
from opengeo_api.spatial_services import (
    RetiredSpatialTileCacheVersion,
    SpatialService,
    SpatialServiceCollection,
    SpatialServiceConflict,
    SpatialServiceNotFound,
    SpatialTileCacheEntry,
    SpatialTileCachePolicy,
    SpatialTileCacheReclamation,
    SpatialTileCacheReclamationPreview,
    SpatialTileCacheReclamationSubmission,
    SpatialTileCoordinate,
    SpatialTileSeedPlan,
    SpatialTileSeedPlanItem,
    SpatialTileSeedPlanPreview,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000151")
ORG_ID = UUID("10000000-0000-4000-8000-000000000151")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000151")
SERVICE_ID = UUID("60000000-0000-4000-8000-000000000151")
BINDING_ID = UUID("70000000-0000-4000-8000-000000000151")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000151")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-000000000151")
PROFILE_ID = UUID("a4000000-0000-4000-8000-000000000151")
PROFILE_VERSION_ID = UUID("a5000000-0000-4000-8000-000000000151")
RESOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000151")
DATASET_VERSION_ID = UUID("82000000-0000-4000-8000-000000000151")
STYLE_ID = UUID("a2000000-0000-4000-8000-000000000151")
STYLE_VERSION_ID = UUID("a3000000-0000-4000-8000-000000000151")
RENDER_JOB_ID = UUID("b0000000-0000-4000-8000-000000000151")
CACHE_ID = UUID("b1000000-0000-4000-8000-000000000151")
CACHE_VERSION_ID = UUID("b2000000-0000-4000-8000-000000000151")
RECLAMATION_ID = UUID("b4000000-0000-4000-8000-000000000151")
SEED_PLAN_ID = UUID("b5000000-0000-4000-8000-000000000151")
FEATURE_ID = UUID("90000000-0000-4000-8000-000000000151")
NOW = datetime(2026, 8, 20, 18, tzinfo=UTC)

# This finite inventory is intentionally limited to authenticated, project-private
# administered service and cache routes. Anonymous/publication aliases under
# /public are a separate policy surface and are tested with the publication routes.
PRIVATE_ADMINISTERED_SERVICE_ROUTES = (
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{collection_name}/queryables",
    ),
    ("GET", "/projects/{project_id}/services/{service_slug}/coverages/{coverage_name}/subset-plan"),
    ("GET", "/projects/{project_id}/spatial-services"),
    ("POST", "/projects/{project_id}/spatial-services"),
    ("POST", "/projects/{project_id}/spatial-services/{service_id}/disable"),
    ("GET", "/projects/{project_id}/spatial-services/{service_id}/collections"),
    ("POST", "/projects/{project_id}/spatial-services/{service_id}/collections"),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/withdraw",
    ),
    ("GET", "/projects/{project_id}/spatial-services/{service_id}/catalog"),
    ("PUT", "/projects/{project_id}/spatial-services/{service_id}/catalog/metadata"),
    ("POST", "/projects/{project_id}/spatial-services/{service_id}/catalog/stores"),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/catalog/stores/{store_id}/disable",
    ),
    (
        "PUT",
        "/projects/{project_id}/spatial-services/{service_id}/catalog/layer-groups/{slug}",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/catalog/layer-groups/{group_id}/disable",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/catalog/collections/{collection_id}/styles",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/catalog/styles/{binding_id}/withdraw",
    ),
    ("POST", "/projects/{project_id}/spatial-services/{service_id}/catalog/bulk"),
    ("GET", "/projects/{project_id}/services/{service_slug}/ogc"),
    ("GET", "/projects/{project_id}/services/{service_slug}/ogc/api"),
    ("GET", "/projects/{project_id}/services/{service_slug}/ogc/conformance"),
    ("GET", "/projects/{project_id}/services/{service_slug}/ogc/collections"),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/items",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{collection_name}/items/{feature_id}",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/arcgis/rest/services/"
        "{collection_name}/FeatureServer/0/query/",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/arcgis/rest/services/"
        "{collection_name}/MapServer/export",
    ),
    ("GET", "/projects/{project_id}/services/{service_slug}/sos/{collection_name}"),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/xyz/{collection_name}/{z}/{x}/{y}.png",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/map",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{collection_name}/tiles",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{collection_name}/tiles/{tile_matrix_set_id}",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{collection_name}/tiles/{tile_matrix_set_id}/{tile_matrix}/{tile_row}/{tile_col}",
    ),
    ("GET", "/projects/{project_id}/spatial-services/{service_id}/coverages"),
    ("POST", "/projects/{project_id}/spatial-services/{service_id}/coverages"),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/withdraw",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/coverage-processing-policy",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/derivatives",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/derivatives",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/"
        "{coverage_id}/derivatives/{job_id}",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/"
        "{coverage_id}/derivatives/{job_id}/cancel",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/"
        "{coverage_id}/derivatives/{job_id}/download",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/"
        "{coverage_id}/derivatives/{job_id}/reclamation-preview",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/coverages/"
        "{coverage_id}/derivatives/{job_id}/reclaim",
    ),
    ("GET", "/projects/{project_id}/services/{service_slug}/wcs"),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{coverage_name}/coverage",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{coverage_name}/coverage/domainset",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/"
        "{coverage_name}/coverage/rangetype",
    ),
    (
        "GET",
        "/projects/{project_id}/services/{service_slug}/ogc/collections/{coverage_name}/schema",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache",
    ),
    (
        "PUT",
        "/projects/{project_id}/spatial-services/{service_id}/collections/{binding_id}/tile-cache",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/invalidate",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/retired-versions",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/versions/{cache_version_id}/reclamation-preview",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/versions/{cache_version_id}/reclaim",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/seed-plans/preview",
    ),
    (
        "GET",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/seed-plans",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/seed-plans",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/seed-plans/{plan_id}/cancel",
    ),
    (
        "POST",
        "/projects/{project_id}/spatial-services/{service_id}/collections/"
        "{binding_id}/tile-cache/seeds",
    ),
    ("GET", "/projects/{project_id}/services/{service_slug}/wmts"),
)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    def __init__(self) -> None:
        self.memberships: tuple[OrganizationMembership, ...] = (
            OrganizationMembership(ORG_ID, "admin"),
        )

    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="publisher@example.test",
            display_name="Publisher",
            memberships=self.memberships,
        )


class MemorySpatialServiceRepository:
    def __init__(self) -> None:
        self.service: SpatialService | None = None
        self.binding: SpatialServiceCollection | None = None
        self.cache: SpatialTileCachePolicy | None = None
        self.tile_entries: dict[tuple[int, int, int], SpatialTileCacheEntry] = {}
        self.retired_versions: list[RetiredSpatialTileCacheVersion] = []
        self.reclamation: SpatialTileCacheReclamation | None = None
        self.seed_plan: SpatialTileSeedPlan | None = None
        self.calls: list[tuple] = []
        self.cache_object_reads: list[tuple] = []

    async def create_service(
        self, context, project_id, slug, title, description, request_id
    ) -> SpatialService:
        self.calls.append(("create_service", context, project_id, request_id))
        if self.service is not None:
            raise SpatialServiceConflict("spatial_service_store_conflict")
        self.service = SpatialService(
            SERVICE_ID,
            project_id,
            slug,
            title,
            description,
            USER_ID,
            NOW,
            None,
            None,
        )
        return self.service

    async def list_services(self, context, project_id):
        self.calls.append(("list_services", context, project_id))
        return () if self.service is None else (self.service,)

    async def get_active_service(self, context, project_id, slug):
        self.calls.append(("get_active_service", context, project_id, slug))
        if (
            self.service is None
            or self.service.slug != slug
            or self.service.disabled_at is not None
        ):
            raise SpatialServiceNotFound("spatial_service")
        return self.service

    async def disable_service(self, context, project_id, service_id, request_id):
        self.calls.append(("disable_service", context, project_id, service_id, request_id))
        if self.service is None or self.service.service_id != service_id:
            raise SpatialServiceNotFound("spatial_service")
        self.service = replace(
            self.service,
            disabled_by=USER_ID,
            disabled_at=NOW,
        )
        return self.service

    async def create_collection(
        self,
        context,
        project_id,
        service_id,
        collection_name,
        dataset_id,
        resource_id,
        default_profile_id,
        expected_feature_generation,
        expected_profile_version,
        title,
        description,
        request_id,
    ):
        self.calls.append(("create_collection", context, project_id, service_id, request_id))
        if expected_feature_generation != 3 or expected_profile_version != 2:
            raise SpatialServiceConflict("spatial_service_collection_target_changed")
        self.binding = SpatialServiceCollection(
            BINDING_ID,
            project_id,
            service_id,
            collection_name,
            dataset_id,
            resource_id,
            default_profile_id,
            3,
            PROFILE_VERSION_ID,
            2,
            3,
            PROFILE_VERSION_ID,
            2,
            title,
            description,
            USER_ID,
            NOW,
            None,
            None,
            True,
        )
        return self.binding

    async def list_collections(self, context, project_id, service_id, *, include_withdrawn):
        self.calls.append(("list_collections", context, project_id, service_id))
        if self.binding is None:
            return ()
        if self.binding.withdrawn_at is not None and not include_withdrawn:
            return ()
        return (self.binding,)

    async def resolve_collection(self, context, project_id, service_slug, collection_name):
        self.calls.append(("resolve_collection", context, project_id, service_slug))
        if (
            self.service is None
            or self.service.slug != service_slug
            or self.service.disabled_at is not None
            or self.binding is None
            or self.binding.collection_name != collection_name
            or self.binding.withdrawn_at is not None
        ):
            raise SpatialServiceNotFound("spatial_service_collection")
        return self.binding

    async def withdraw_collection(self, context, project_id, service_id, binding_id, request_id):
        self.calls.append(("withdraw_collection", context, project_id, request_id))
        if self.binding is None or self.binding.binding_id != binding_id:
            raise SpatialServiceNotFound("spatial_service_collection")
        self.binding = replace(self.binding, withdrawn_by=USER_ID, withdrawn_at=NOW)
        return self.binding

    async def configure_tile_cache(
        self,
        context,
        project_id,
        service_id,
        binding_id,
        expected_version,
        minimum_tile_matrix,
        maximum_tile_matrix,
        maximum_entries,
        change_message,
        request_id,
    ):
        del context, request_id
        current_version = 0 if self.cache is None else self.cache.version_number
        if expected_version != current_version:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
        version = current_version + 1
        self.cache = SpatialTileCachePolicy(
            CACHE_ID,
            project_id,
            service_id,
            binding_id,
            UUID(int=CACHE_VERSION_ID.int + version - 1),
            version,
            minimum_tile_matrix,
            maximum_tile_matrix,
            maximum_entries,
            0,
            change_message,
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )
        self.tile_entries = {}
        return self.cache

    async def get_tile_cache(self, context, project_id, binding_id):
        del context
        self.cache_object_reads.append(("get_tile_cache", project_id, binding_id))
        if (
            self.cache is None
            or self.cache.project_id != project_id
            or self.cache.binding_id != binding_id
        ):
            raise SpatialServiceNotFound("spatial_tile_cache")
        return replace(self.cache, current_entries=len(self.tile_entries))

    async def list_tile_caches(self, context, project_id, service_id):
        del context
        self.cache_object_reads.append(("list_tile_caches", project_id, service_id))
        if (
            self.cache is None
            or self.cache.project_id != project_id
            or self.cache.service_id != service_id
        ):
            return ()
        return (replace(self.cache, current_entries=len(self.tile_entries)),)

    async def invalidate_tile_cache(
        self,
        context,
        project_id,
        service_id,
        binding_id,
        expected_version,
        change_message,
        request_id,
    ):
        current = await self.get_tile_cache(context, project_id, binding_id)
        if current.service_id != service_id or current.version_number != expected_version:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
        self.retired_versions.insert(
            0,
            RetiredSpatialTileCacheVersion(
                cache_id=current.cache_id,
                cache_version_id=current.version_id,
                cache_version_number=current.version_number,
                minimum_tile_matrix=current.minimum_tile_matrix,
                maximum_tile_matrix=current.maximum_tile_matrix,
                maximum_entries=current.maximum_entries,
                change_message=current.change_message,
                created_at=NOW - timedelta(hours=30),
                retired_at=NOW - timedelta(hours=25),
                entry_count=len(self.tile_entries),
                render_output_count=len(self.tile_entries),
                reclamation_id=None,
                reclamation_state=None,
                reclamation_target_count=None,
                reclamation_completed_count=0,
                reclamation_failed_count=0,
            ),
        )
        self.cache = replace(
            current,
            version_id=UUID(int=current.version_id.int + 1),
            version_number=current.version_number + 1,
            current_entries=0,
            change_message=change_message,
        )
        self.tile_entries = {}
        del request_id
        return self.cache

    async def record_tile_cache_entry(
        self,
        context,
        project_id,
        binding_id,
        expected_cache_version,
        tile_matrix,
        tile_row,
        tile_col,
        render_job_id,
        request_id,
    ):
        cache = await self.get_tile_cache(context, project_id, binding_id)
        if cache.version_number != expected_cache_version:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
        key = (tile_matrix, tile_row, tile_col)
        entry = self.tile_entries.get(key)
        if entry is not None:
            if entry.render_job_id != render_job_id:
                raise SpatialServiceConflict("spatial_tile_cache_entry_conflict")
            return entry
        entry = SpatialTileCacheEntry(
            UUID(int=CACHE_ID.int + len(self.tile_entries) + 1),
            cache.cache_id,
            cache.version_id,
            cache.version_number,
            tile_matrix,
            tile_row,
            tile_col,
            render_job_id,
            USER_ID,
            NOW,
        )
        self.tile_entries[key] = entry
        del request_id
        return entry

    async def resolve_tile_cache_entry(
        self, context, project_id, binding_id, tile_matrix, tile_row, tile_col
    ):
        self.cache_object_reads.append(
            (
                "resolve_tile_cache_entry",
                project_id,
                binding_id,
                tile_matrix,
                tile_row,
                tile_col,
            )
        )
        await self.get_tile_cache(context, project_id, binding_id)
        entry = self.tile_entries.get((tile_matrix, tile_row, tile_col))
        if entry is None:
            raise SpatialServiceNotFound("spatial_tile_cache_entry")
        return entry

    async def preview_tile_seed_plan(
        self,
        context,
        project_id,
        service_id,
        binding_id,
        expected_cache_version,
        mode,
        request_bbox,
        minimum_tile_matrix,
        maximum_tile_matrix,
        coordinates,
    ):
        cache = await self.get_tile_cache(context, project_id, binding_id)
        assert service_id == cache.service_id
        if expected_cache_version != cache.version_number:
            raise SpatialServiceConflict("spatial_tile_cache_version_conflict")
        existing = {
            SpatialTileCoordinate(*coordinate)
            for coordinate in self.tile_entries
            if SpatialTileCoordinate(*coordinate) in coordinates
        }
        targets = tuple(item for item in coordinates if item not in existing)
        return SpatialTileSeedPlanPreview(
            cache_id=cache.cache_id,
            cache_version_id=cache.version_id,
            cache_version_number=cache.version_number,
            mode=mode,
            request_bbox=request_bbox,
            minimum_tile_matrix=minimum_tile_matrix,
            maximum_tile_matrix=maximum_tile_matrix,
            requested_count=len(coordinates),
            existing_count=len(existing),
            targets=targets,
            expires_at=NOW + timedelta(minutes=15),
            preview_checksum_sha256="9" * 64,
        )

    async def confirm_tile_seed_plan(
        self,
        context,
        project_id,
        service_id,
        binding_id,
        expected_cache_version,
        mode,
        request_bbox,
        minimum_tile_matrix,
        maximum_tile_matrix,
        coordinates,
        preview_checksum_sha256,
        preview_expires_at,
        request_id,
    ):
        del request_id
        preview = await self.preview_tile_seed_plan(
            context,
            project_id,
            service_id,
            binding_id,
            expected_cache_version,
            mode,
            request_bbox,
            minimum_tile_matrix,
            maximum_tile_matrix,
            coordinates,
        )
        if (
            preview_checksum_sha256 != preview.preview_checksum_sha256
            or preview_expires_at != preview.expires_at
        ):
            raise SpatialServiceConflict("spatial_tile_seed_plan_changed")
        if self.seed_plan is None:
            self.seed_plan = SpatialTileSeedPlan(
                plan_id=SEED_PLAN_ID,
                project_id=project_id,
                service_id=service_id,
                binding_id=binding_id,
                cache_id=preview.cache_id,
                cache_version_id=preview.cache_version_id,
                cache_version_number=preview.cache_version_number,
                mode=mode,
                request_bbox=request_bbox,
                minimum_tile_matrix=minimum_tile_matrix,
                maximum_tile_matrix=maximum_tile_matrix,
                requested_count=preview.requested_count,
                existing_count=preview.existing_count,
                target_count=len(preview.targets),
                preview_checksum_sha256=preview_checksum_sha256,
                preview_expires_at=preview_expires_at,
                state="preparing",
                error_code=None,
                created_by=USER_ID,
                created_at=NOW,
                dispatch_started_at=None,
                started_at=None,
                finished_at=None,
                items=tuple(
                    SpatialTileSeedPlanItem(
                        position=index,
                        coordinate=coordinate,
                        render_job_id=None,
                        state="pending",
                        error_code=None,
                        started_at=None,
                        finished_at=None,
                    )
                    for index, coordinate in enumerate(preview.targets, 1)
                ),
            )
        return self.seed_plan

    async def attach_tile_seed_plan_render(
        self, context, project_id, service_id, binding_id, plan_id, position, render_job_id
    ):
        del context
        assert self.seed_plan is not None
        assert (project_id, service_id, binding_id, plan_id) == (
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
            SEED_PLAN_ID,
        )
        self.seed_plan = replace(
            self.seed_plan,
            items=tuple(
                replace(
                    item,
                    render_job_id=render_job_id,
                    state="completed",
                    started_at=NOW,
                    finished_at=NOW,
                )
                if item.position == position
                else item
                for item in self.seed_plan.items
            ),
        )
        return self.seed_plan

    async def begin_tile_seed_plan_dispatch(
        self, context, project_id, service_id, binding_id, plan_id, request_id
    ):
        del context, request_id
        assert self.seed_plan is not None
        assert (project_id, service_id, binding_id, plan_id) == (
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
            SEED_PLAN_ID,
        )
        for item in self.seed_plan.items:
            assert item.render_job_id is not None
            self.tile_entries[
                (
                    item.coordinate.tile_matrix,
                    item.coordinate.tile_row,
                    item.coordinate.tile_col,
                )
            ] = SpatialTileCacheEntry(
                UUID(int=CACHE_ID.int + len(self.tile_entries) + 1),
                self.seed_plan.cache_id,
                self.seed_plan.cache_version_id,
                self.seed_plan.cache_version_number,
                item.coordinate.tile_matrix,
                item.coordinate.tile_row,
                item.coordinate.tile_col,
                item.render_job_id,
                USER_ID,
                NOW,
            )
        self.seed_plan = replace(
            self.seed_plan,
            state="completed",
            dispatch_started_at=NOW,
            started_at=NOW,
            finished_at=NOW,
        )
        return self.seed_plan

    async def list_tile_seed_plans(self, context, project_id, service_id, binding_id):
        del context
        assert (project_id, service_id, binding_id) == (PROJECT_ID, SERVICE_ID, BINDING_ID)
        return () if self.seed_plan is None else (self.seed_plan,)

    async def cancel_tile_seed_plan(
        self, context, project_id, service_id, binding_id, plan_id, request_id
    ):
        del context, request_id
        assert self.seed_plan is not None
        assert (project_id, service_id, binding_id, plan_id) == (
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
            SEED_PLAN_ID,
        )
        if self.seed_plan.state != "preparing":
            raise SpatialServiceConflict("spatial_tile_seed_plan_dispatch_started")
        self.seed_plan = replace(self.seed_plan, state="cancelled", finished_at=NOW)
        return self.seed_plan

    async def list_retired_tile_cache_versions(self, context, project_id, service_id, binding_id):
        del context
        assert (project_id, service_id, binding_id) == (PROJECT_ID, SERVICE_ID, BINDING_ID)
        return tuple(self.retired_versions)

    async def preview_tile_cache_reclamation(
        self, context, project_id, service_id, binding_id, cache_version_id
    ):
        del context
        assert (project_id, service_id, binding_id) == (PROJECT_ID, SERVICE_ID, BINDING_ID)
        version = next(
            (item for item in self.retired_versions if item.cache_version_id == cache_version_id),
            None,
        )
        if version is None or version.render_output_count == 0:
            raise SpatialServiceConflict("spatial_tile_cache_outputs_not_reclaimable")
        return SpatialTileCacheReclamationPreview(
            cache_id=version.cache_id,
            cache_version_id=version.cache_version_id,
            cache_version_number=version.cache_version_number,
            target_count=version.render_output_count,
            remaining_eligible_target_count=0,
            target_size_bytes=67,
            oldest_render_finished_at=NOW - timedelta(hours=26),
            newest_render_finished_at=NOW - timedelta(hours=26),
            expires_at=NOW + timedelta(minutes=15),
            preview_checksum_sha256="8" * 64,
        )

    async def confirm_tile_cache_reclamation(
        self,
        context,
        project_id,
        service_id,
        binding_id,
        cache_version_id,
        preview_checksum_sha256,
        preview_expires_at,
        request_id,
    ):
        del context, request_id
        if preview_checksum_sha256 != "8" * 64 or preview_expires_at != NOW + timedelta(minutes=15):
            raise SpatialServiceConflict("spatial_tile_cache_reclamation_changed")
        version = next(
            (item for item in self.retired_versions if item.cache_version_id == cache_version_id),
            None,
        )
        assert version is not None
        self.reclamation = SpatialTileCacheReclamation(
            reclamation_id=RECLAMATION_ID,
            cache_id=version.cache_id,
            cache_version_id=version.cache_version_id,
            cache_version_number=version.cache_version_number,
            target_count=version.render_output_count,
            target_size_bytes=67,
            state="queued",
            error_code=None,
            attempt_count=0,
            completed_target_count=0,
            failed_target_count=0,
            preview_checksum_sha256=preview_checksum_sha256,
            preview_expires_at=preview_expires_at,
            created_by=USER_ID,
            created_at=NOW,
            started_at=None,
            finished_at=None,
        )
        self.retired_versions[0] = replace(
            version,
            reclamation_id=RECLAMATION_ID,
            reclamation_state="queued",
            reclamation_target_count=version.render_output_count,
        )
        return SpatialTileCacheReclamationSubmission(self.reclamation, True)


class MemoryFeatureRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.collection = FeatureCollection(
            DATASET_ID,
            "LineString",
            (FeatureField("name", "string", True), FeatureField("surveyed", "boolean", False)),
            3,
            1,
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )
        self.feature = FeatureRecord(
            FEATURE_ID,
            2,
            "LineString",
            {
                "type": "LineString",
                "coordinates": [[-77.1, 38.8], [-77.0, 38.9], [-76.9, 39.0]],
            },
            (-77.1, 38.8, -76.9, 39.0),
            {"name": "Governed access route", "surveyed": True},
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )

    def _check(self, dataset_id, expected_generation) -> None:
        if dataset_id != DATASET_ID:
            raise FeatureNotFound("feature_collection")
        if expected_generation is not None and expected_generation != self.collection.generation:
            raise FeatureConflict(
                "feature_collection_generation_conflict", self.collection.generation
            )

    async def list_features(
        self,
        context,
        project_id,
        dataset_id,
        *,
        bbox,
        limit,
        offset,
        expected_generation=None,
        cql2_filter=None,
    ):
        del context, project_id
        self.calls.append(("list_features", dataset_id))
        self._check(dataset_id, expected_generation)
        if cql2_filter is not None:
            from opengeo_api.cql2_features import compile_feature_filter

            compile_feature_filter(
                *cql2_filter, {field.name: field.type for field in self.collection.fields}
            )
            self.last_cql2_filter = cql2_filter
        matches = bbox is None or not (
            self.feature.bbox[2] < bbox[0]
            or self.feature.bbox[0] > bbox[2]
            or self.feature.bbox[3] < bbox[1]
            or self.feature.bbox[1] > bbox[3]
        )
        records = (self.feature,) if matches and offset == 0 else ()
        return FeaturePage(self.collection, records[:limit], 1 if matches else 0, limit, offset)

    async def get_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        *,
        expected_generation=None,
    ):
        del context, project_id
        self.calls.append(("get_feature", dataset_id, feature_id))
        self._check(dataset_id, expected_generation)
        if feature_id != FEATURE_ID:
            raise FeatureNotFound("feature")
        return self.feature


class MemoryObservationRepository(MemoryFeatureRepository):
    def __init__(self) -> None:
        super().__init__()
        self.collection = replace(
            self.collection,
            geometry_type="Point",
            fields=(
                FeatureField(SOS_PHENOMENON_TIME_FIELD, "string", True),
                FeatureField(SOS_RESULT_FIELD, "number", True),
                FeatureField(SOS_RESULT_UNIT_FIELD, "string", False),
            ),
        )
        self.feature = replace(
            self.feature,
            geometry_type="Point",
            geometry={"type": "Point", "coordinates": [-71.1, 42.4]},
            bbox=(-71.1, 42.4, -71.1, 42.4),
            properties={
                SOS_PHENOMENON_TIME_FIELD: "2026-09-07T11:30:00-04:00",
                SOS_RESULT_FIELD: 21.25,
                SOS_RESULT_UNIT_FIELD: "urn:ogc:def:uom:UCUM:Cel",
            },
        )


class MemoryTileRenderRepository:
    def __init__(self) -> None:
        self.profile = RenderProfile(
            profile_id=PROFILE_ID,
            project_id=PROJECT_ID,
            resource_id=RESOURCE_ID,
            slug="roads-map",
            version_number=2,
            title="Roads map",
            resource_version_id=RESOURCE_VERSION_ID,
            dataset_id=DATASET_ID,
            dataset_version_id=DATASET_VERSION_ID,
            style_id=STYLE_ID,
            style_version_id=STYLE_VERSION_ID,
            configuration={"schema": "opengeo.render.v1"},
            checksum_sha256="5" * 64,
            change_message=None,
            created_by=USER_ID,
            created_at=NOW,
            updated_at=NOW,
        )
        self.body = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDAT\x08\xd7c\xf8"
            b"\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        self.job: RenderJob | None = None
        self.requests = []
        self.profile_reads: list[tuple] = []
        self.job_reads: list[tuple] = []
        self.output_reads: list[tuple] = []

    async def get_profile(self, context, project_id, resource_id, profile_id):
        del context
        self.profile_reads.append((project_id, resource_id, profile_id))
        assert (project_id, resource_id, profile_id) == (PROJECT_ID, RESOURCE_ID, PROFILE_ID)
        return self.profile

    async def request_render(
        self, context, project_id, resource_id, profile_id, request, request_id
    ):
        del context, request_id
        assert (project_id, resource_id, profile_id) == (PROJECT_ID, RESOURCE_ID, PROFILE_ID)
        self.requests.append(request)
        digest = sha256(self.body).hexdigest()
        self.job = RenderJob(
            job_id=RENDER_JOB_ID,
            project_id=PROJECT_ID,
            resource_id=RESOURCE_ID,
            profile_id=PROFILE_ID,
            profile_version_id=PROFILE_VERSION_ID,
            profile_version_number=2,
            dataset_id=DATASET_ID,
            dataset_version_id=DATASET_VERSION_ID,
            style_id=STYLE_ID,
            style_version_id=STYLE_VERSION_ID,
            bbox=request.bbox,
            crs=request.crs,
            width=request.width,
            height=request.height,
            format=request.format,
            background_color=request.background_color,
            transparent=request.transparent,
            request_checksum_sha256="6" * 64,
            state="completed",
            attempt_count=1,
            output_object_id=UUID("b3000000-0000-4000-8000-000000000151"),
            output_content_type="image/png",
            output_size_bytes=len(self.body),
            output_checksum_sha256=digest,
            error_code=None,
            created_by=USER_ID,
            created_at=NOW,
            started_at=NOW,
            finished_at=NOW,
        )
        return RenderSubmission(self.job, False)

    async def get_job(self, context, project_id, resource_id, job_id):
        del context
        self.job_reads.append((project_id, resource_id, job_id))
        if self.job is None or (project_id, resource_id, job_id) != (
            PROJECT_ID,
            RESOURCE_ID,
            RENDER_JOB_ID,
        ):
            raise AssertionError("unexpected render job")
        return self.job

    async def read_map_output(
        self, context, project_id, resource_id, job_id, maximum_bytes, request_id
    ):
        del context, request_id
        self.output_reads.append((project_id, resource_id, job_id, maximum_bytes))
        assert (project_id, resource_id, job_id) == (PROJECT_ID, RESOURCE_ID, RENDER_JOB_ID)
        assert len(self.body) <= maximum_bytes
        return RenderedMapOutput(
            self.body,
            "tile.png",
            "image/png",
            len(self.body),
            sha256(self.body).hexdigest(),
            "tile-v1",
        )


class MemoryRenderDispatcher:
    def __init__(self) -> None:
        self.calls: list[UUID] = []

    async def dispatch_render(self, job_id: UUID) -> None:
        self.calls.append(job_id)

    async def dispatch_coverage_derivative(self, job_id: UUID) -> None:
        self.calls.append(job_id)

    async def dispatch_coverage_derivative_reclamation(self, reclamation_id: UUID) -> None:
        self.calls.append(reclamation_id)

    async def dispatch_tile_cache_reclamation(self, reclamation_id: UUID) -> None:
        self.calls.append(reclamation_id)


class EmptyCoverageRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_coverages(self, context, project_id, service_id, *, include_withdrawn):
        del context, include_withdrawn
        self.calls.append(("list_coverages", project_id, service_id))
        assert (project_id, service_id) == (PROJECT_ID, SERVICE_ID)
        return ()

    async def resolve_coverage(self, context, project_id, service_slug, coverage_name):
        del context, project_id, service_slug, coverage_name
        self.calls.append(("resolve_coverage",))
        raise CoverageNotFound("spatial_service_coverage")


def api_client(
    repository: MemorySpatialServiceRepository,
    *,
    render_repository: MemoryTileRenderRepository | None = None,
    render_dispatcher: MemoryRenderDispatcher | None = None,
    principal_repository: FakePrincipalRepository | None = None,
    coverage_repository: EmptyCoverageRepository | None = None,
    feature_repository: MemoryFeatureRepository | None = None,
) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=principal_repository or FakePrincipalRepository(),
            spatial_service_repository=repository,
            coverage_repository=coverage_repository or EmptyCoverageRepository(),
            feature_repository=feature_repository or MemoryFeatureRepository(),
            render_repository=render_repository,
            render_dispatcher=render_dispatcher,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "spatial-service-request-123",
    }


def private_administered_service_path(template: str) -> str:
    path = template.format(
        project_id=PROJECT_ID,
        service_id=SERVICE_ID,
        service_slug="research-atlas",
        binding_id=BINDING_ID,
        collection_name="roads",
        feature_id=FEATURE_ID,
        tile_matrix_set_id="WebMercatorQuad",
        tile_matrix=0,
        tile_row=0,
        tile_col=0,
        z=0,
        x=0,
        y=0,
        coverage_id=DATASET_ID,
        coverage_name="elevation",
        job_id=RENDER_JOB_ID,
        cache_version_id=CACHE_VERSION_ID,
        plan_id=SEED_PLAN_ID,
        store_id=CACHE_ID,
        slug="transport",
        group_id=RECLAMATION_ID,
        collection_id=BINDING_ID,
    )
    if template.endswith("/{collection_name}/map"):
        return f"{path}?bbox=-77.1,38.8,-76.9,39.0"
    if template.endswith("/{service_slug}/wcs"):
        return f"{path}?SERVICE=WCS&REQUEST=GetCapabilities&VERSION=2.0.1"
    if template.endswith("/{service_slug}/wmts"):
        return f"{path}?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0"
    return path


def create_service(client: TestClient) -> None:
    response = client.post(
        f"/projects/{PROJECT_ID}/spatial-services",
        headers=headers(),
        json={
            "slug": "research-atlas",
            "title": "Research atlas",
            "description": "Governed project service",
        },
    )
    assert response.status_code == 201


def create_binding(client: TestClient) -> None:
    response = client.post(
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/collections",
        headers=headers(),
        json={
            "collection_name": "roads",
            "dataset_id": str(DATASET_ID),
            "resource_id": str(RESOURCE_ID),
            "default_profile_id": str(PROFILE_ID),
            "expected_feature_generation": 3,
            "expected_profile_version": 2,
            "title": "Road network",
        },
    )
    assert response.status_code == 201
    assert response.json()["stale"] is False


def test_shared_auth_administration_and_immutable_seal_response() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    endpoint = f"/projects/{PROJECT_ID}/spatial-services"

    assert client.get(endpoint).status_code == 401
    create_service(client)
    create_binding(client)

    services = client.get(endpoint, headers=headers())
    bindings = client.get(f"{endpoint}/{SERVICE_ID}/collections", headers=headers())
    assert services.status_code == 200
    assert services.json()[0]["slug"] == "research-atlas"
    assert bindings.json()[0]["sealed_feature_generation"] == 3
    assert bindings.json()[0]["sealed_profile_version_number"] == 2
    assert bindings.json()[0]["current_profile_version_id"] == str(PROFILE_VERSION_ID)


def test_unified_discovery_is_absolute_bounded_and_non_claiming() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    base = f"/projects/{PROJECT_ID}/services/research-atlas/ogc"

    landing = client.get(base, headers=headers())
    api = client.get(f"{base}/api", headers=headers())
    conformance = client.get(f"{base}/conformance", headers=headers())
    collections = client.get(f"{base}/collections", headers=headers())

    assert landing.status_code == 200
    assert {link["rel"] for link in landing.json()["links"]} == {
        "self",
        "service-desc",
        "conformance",
        "data",
        "service",
    }
    wmts_link = next(link for link in landing.json()["links"] if link["rel"] == "service")
    assert "SERVICE=WMTS&REQUEST=GetCapabilities" in wmts_link["href"]
    assert all(link["href"].startswith("http://testserver/") for link in landing.json()["links"])
    assert api.headers["content-type"].startswith("application/vnd.oai.openapi+json")
    assert api.json()["x-opengeo-immutable-seals"] is True
    assert api.json()["x-opengeo-conformance-claimed"] is False
    item_operation = api.json()["paths"]["/collections/{collectionId}/items"]["get"]
    assert set(item_operation["responses"]) == {"200"}
    assert {parameter["name"] for parameter in item_operation["parameters"]} == {
        "collectionId",
        "bbox",
        "limit",
        "offset",
        "filter",
        "filter-lang",
    }
    map_operation = api.json()["paths"]["/collections/{collectionId}/map"]["get"]
    assert set(map_operation["responses"]) == {"307"}
    assert {parameter["name"] for parameter in map_operation["parameters"]} == {
        "collectionId",
        "bbox",
        "width",
        "height",
        "crs",
        "f",
        "background_color",
        "transparent",
    }
    assert conformance.json()["conformsTo"] == []
    assert "No OGC API Features" in conformance.json()["opengeoStatus"]["claim"]
    collection = collections.json()["collections"][0]
    metadata_link = next(link for link in collection["links"] if link["rel"] == "describedby")
    assert (
        metadata_link["href"]
        == f"http://testserver/projects/{PROJECT_ID}/records/collections/resources/items/{collection['opengeo:resourceId']}"
    )
    assert metadata_link["type"] == "application/geo+json"
    detail = client.get(f"{base}/collections/{collection['id']}", headers=headers())
    assert metadata_link in detail.json()["links"]

    assert collection["id"] == "roads"
    assert collection["opengeo:stale"] is False
    assert {link["rel"] for link in collection["links"]} == {
        "describedby",
        "http://www.opengis.net/def/rel/ogc/1.0/queryables",
        "self",
        "items",
        "item",
        "alternate",
        "https://www.opengis.net/def/rel/ogc/1.0/map",
        "http://www.opengis.net/def/rel/ogc/1.0/tilesets-map",
    }
    compatibility_links = [
        link for link in collection["links"] if link["rel"] in {"item", "alternate"}
    ]
    assert len(compatibility_links) == 4
    assert any(link.get("templated") is True for link in compatibility_links)
    assert landing.headers["cache-control"] == "private, no-store"


def test_sos_core_reads_use_one_sealed_collection_and_exact_identifiers() -> None:
    repository = MemorySpatialServiceRepository()
    feature_repository = MemoryObservationRepository()
    client = api_client(repository, feature_repository=feature_repository)
    create_service(client)
    create_binding(client)
    endpoint = f"/projects/{PROJECT_ID}/services/research-atlas/sos/roads"

    capabilities_response = client.get(
        endpoint,
        headers=headers(),
        params={"SERVICE": "SOS", "REQUEST": "GetCapabilities", "ACCEPTVERSIONS": "2.0.0"},
    )
    assert capabilities_response.status_code == 200
    assert capabilities_response.headers["cache-control"] == "private, no-store"
    capabilities = ET.fromstring(capabilities_response.content)
    procedure = capabilities.findtext(".//swes:procedure", namespaces=SOS_NAMESPACES)
    offering = capabilities.findtext(".//swes:identifier", namespaces=SOS_NAMESPACES)
    observed_property = capabilities.findtext(
        ".//swes:observableProperty", namespaces=SOS_NAMESPACES
    )
    assert procedure == f"http://testserver{endpoint}#procedure"
    assert offering == f"http://testserver{endpoint}#offering"
    assert observed_property == f"http://testserver{endpoint}#observed-property"

    sensor_response = client.get(
        endpoint,
        headers=headers(),
        params={
            "SERVICE": "SOS",
            "REQUEST": "DescribeSensor",
            "VERSION": "2.0.0",
            "PROCEDURE": procedure,
            "PROCEDUREDESCRIPTIONFORMAT": SOS_PROCEDURE_DESCRIPTION_FORMAT,
        },
    )
    assert sensor_response.status_code == 200
    sensor = ET.fromstring(sensor_response.content)
    assert sensor.findtext(".//gml:identifier", namespaces=SOS_NAMESPACES) == procedure

    observation_response = client.get(
        endpoint,
        headers=headers(),
        params={
            "SERVICE": "SOS",
            "REQUEST": "GetObservation",
            "VERSION": "2.0.0",
            "PROCEDURE": procedure,
            "OFFERING": offering,
            "OBSERVEDPROPERTY": observed_property,
            "RESPONSEFORMAT": SOS_RESPONSE_FORMAT,
        },
    )
    assert observation_response.status_code == 200
    observation = ET.fromstring(observation_response.content)
    assert observation.findtext(".//gml:timePosition", namespaces=SOS_NAMESPACES) == (
        "2026-09-07T15:30:00Z"
    )
    assert observation.findtext(".//om:result", namespaces=SOS_NAMESPACES) == "21.25"
    assert feature_repository.calls == [
        ("list_features", DATASET_ID),
        ("list_features", DATASET_ID),
        ("list_features", DATASET_ID),
    ]


def test_sos_rejects_ordinary_layers_stale_bindings_and_unsupported_filters() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    endpoint = f"/projects/{PROJECT_ID}/services/research-atlas/sos/roads"

    ordinary = client.get(
        endpoint,
        headers=headers(),
        params={"SERVICE": "SOS", "REQUEST": "GetCapabilities"},
    )
    assert ordinary.status_code == 400
    assert "requires a required string" in ordinary.text

    repository.binding = replace(repository.binding, current_feature_generation=4)
    stale = client.get(
        endpoint,
        headers=headers(),
        params={"SERVICE": "SOS", "REQUEST": "GetCapabilities"},
    )
    assert stale.status_code == 409

    repository.binding = replace(repository.binding, current_feature_generation=3)
    observations = MemoryObservationRepository()
    filtered_client = api_client(repository, feature_repository=observations)
    unsupported = filtered_client.get(
        endpoint,
        headers=headers(),
        params={
            "SERVICE": "SOS",
            "REQUEST": "GetObservation",
            "VERSION": "2.0.0",
            "TEMPORALFILTER": "om:phenomenonTime,2026-09-01T00:00:00Z",
        },
    )
    assert unsupported.status_code == 400
    assert "unsupported SOS parameter" in unsupported.text


def test_exact_feature_reads_and_map_aliases_forward_no_authority_in_urls() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    root = f"/projects/{PROJECT_ID}/services/research-atlas/ogc/collections/roads"

    items = client.get(
        f"{root}/items",
        headers=headers(),
        params={"bbox": "-78,38,-76,40", "limit": 20, "offset": 0},
        follow_redirects=False,
    )
    item = client.get(f"{root}/items/{FEATURE_ID}", headers=headers(), follow_redirects=False)
    rendered_map = client.get(
        f"{root}/map",
        headers=headers(),
        params={
            "bbox": "-78,38,-76,40",
            "width": 512,
            "height": 256,
            "crs": OGC_CRS84,
            "f": "png",
            "transparent": "true",
        },
        follow_redirects=False,
    )

    assert items.status_code == 200
    assert items.headers["content-type"].startswith("application/geo+json")
    assert items.json()["opengeo:collectionGeneration"] == 3
    assert items.json()["features"][0]["id"] == str(FEATURE_ID)
    assert item.status_code == 200
    assert item.json()["id"] == str(FEATURE_ID)
    assert rendered_map.status_code == 307
    assert (
        f"resources/{RESOURCE_ID}/render-profiles/{PROFILE_ID}/map"
        in rendered_map.headers["location"]
    )
    assert (
        "crs=http%3A%2F%2Fwww.opengis.net%2Fdef%2Fcrs%2FOGC%2F1.3%2FCRS84"
        in (rendered_map.headers["location"])
    )
    assert "expected_profile_version=2" in rendered_map.headers["location"]
    for response in (rendered_map,):
        assert "valid-token" not in response.headers["location"]
        assert response.headers["cache-control"] == "private, no-store"


def test_web_mercator_tileset_and_exact_tile_alias() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    root = f"/projects/{PROJECT_ID}/services/research-atlas/ogc/collections/roads/tiles"

    tilesets = client.get(root, headers=headers())
    tileset = client.get(f"{root}/WebMercatorQuad", headers=headers())
    tile = client.get(
        f"{root}/WebMercatorQuad/1/0/1?f=png",
        headers=headers(),
        follow_redirects=False,
    )

    assert tilesets.json()["tilesets"][0]["tileMatrixSetURI"] == WEB_MERCATOR_QUAD_URI
    assert tileset.json()["links"][0]["templated"] is True
    assert tile.status_code == 307
    assert "width=256&height=256" in tile.headers["location"]
    assert (
        "crs=http%3A%2F%2Fwww.opengis.net%2Fdef%2Fcrs%2FEPSG%2F0%2F3857"
        in (tile.headers["location"])
    )
    assert web_mercator_tile_bbox(0, 0, 0) == (
        -WEB_MERCATOR_LIMIT,
        -WEB_MERCATOR_LIMIT,
        WEB_MERCATOR_LIMIT,
        WEB_MERCATOR_LIMIT,
    )
    assert client.get(f"{root}/Other/0/0/0", headers=headers()).status_code == 404
    assert client.get(f"{root}/WebMercatorQuad/2/4/0", headers=headers()).status_code == 404


def test_geomoose_geojson_and_xyz_aliases_reuse_governed_service_records() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    service_root = f"/projects/{PROJECT_ID}/services/research-atlas"

    geojson = client.get(
        f"{service_root}/ogc/collections/roads/items",
        headers=headers(),
        params={"bbox": "-78,38,-76,40", "limit": 100},
    )
    xyz = client.get(
        f"{service_root}/xyz/roads/2/1/2.png",
        headers=headers(),
        follow_redirects=False,
    )

    assert geojson.status_code == 200
    assert geojson.headers["content-type"].startswith("application/geo+json")
    assert geojson.json()["features"][0]["id"] == str(FEATURE_ID)
    assert xyz.status_code == 307
    assert "width=256&height=256" in xyz.headers["location"]
    expected_bbox = web_mercator_tile_bbox(2, 2, 1)
    encoded_bbox = "%2C".join(format(value, ".15g") for value in expected_bbox)
    assert f"bbox={encoded_bbox}" in xyz.headers["location"]
    assert "valid-token" not in xyz.headers["location"]
    assert xyz.headers["cache-control"] == "private, no-store"


def test_geomoose_arcgis_vector_query_is_bounded_two_stage_and_jsonp_compatible() -> None:
    repository = MemorySpatialServiceRepository()
    features = MemoryFeatureRepository()
    client = api_client(repository, feature_repository=features)
    create_service(client)
    create_binding(client)
    endpoint = (
        f"/projects/{PROJECT_ID}/services/research-atlas/arcgis/rest/services/"
        "roads/FeatureServer/0/query/"
    )
    common = {
        "f": "json",
        "returnGeometry": "true",
        "spatialRel": "esriSpatialRelIntersects",
        "geometry": json.dumps(
            {
                "xmin": -8682920.28187534,
                "ymin": 4579425.8128701,
                "xmax": -8460281.30028879,
                "ymax": 4865942.27950318,
            },
            separators=(",", ":"),
        ),
        "spatialReference": '{"wkid":102100}',
        "geometryType": "esriGeometryEnvelope",
        "inSR": "102100",
        "outSR": "102100",
        "outFields": "*",
    }

    identifiers = client.get(
        endpoint,
        headers=headers(),
        params={**common, "returnIdsOnly": "true"},
    )
    object_id = identifiers.json()["objectIds"][0]
    callback = "reqwest_1788278400000_1"
    batch = client.get(
        endpoint,
        headers=headers(),
        params={
            **common,
            "returnIdsOnly": "false",
            "objectIds": str(object_id),
            "callback": callback,
            "_": "1788278400000",
        },
    )
    document = json.loads(batch.text[len(callback) + 1 : -2])

    assert identifiers.status_code == 200
    assert identifiers.json()["objectIdFieldName"] == "OBJECTID"
    assert identifiers.json()["exceededTransferLimit"] is False
    assert 0 < object_id <= 1 << 48
    assert batch.status_code == 200
    assert batch.headers["content-type"].startswith("application/javascript")
    assert document["geometryType"] == "esriGeometryPolyline"
    assert document["spatialReference"] == {"wkid": 102100, "latestWkid": 3857}
    assert document["features"][0]["attributes"]["OBJECTID"] == object_id
    assert document["features"][0]["attributes"]["opengeo_feature_id"] == str(FEATURE_ID)
    assert document["features"][0]["attributes"]["surveyed"] == 1
    assert len(document["features"][0]["geometry"]["paths"][0]) == 3
    assert features.calls == [
        ("list_features", DATASET_ID),
        ("list_features", DATASET_ID),
    ]


def test_geomoose_arcgis_raster_export_maps_exact_openlayers_parameters() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    endpoint = (
        f"/projects/{PROJECT_ID}/services/research-atlas/arcgis/rest/services/"
        "roads/MapServer/export"
    )
    response = client.get(
        endpoint,
        headers=headers(),
        params={
            "F": "image",
            "FORMAT": "PNG32",
            "TRANSPARENT": "true",
            "SIZE": "256,256",
            "BBOX": "-10018754.1713946,0,0,10018754.1713946",
            "BBOXSR": "3857",
            "IMAGESR": "3857",
            "DPI": "90",
            "LAYERS": "show:0",
        },
        follow_redirects=False,
    )

    assert response.status_code == 307
    assert "bbox=-10018754.1713946%2C0%2C0%2C10018754.1713946" in response.headers["location"]
    assert "width=256&height=256" in response.headers["location"]
    assert "expected_profile_version=2" in response.headers["location"]
    assert "valid-token" not in response.headers["location"]


def test_geomoose_arcgis_facade_rejects_ambiguous_or_expanded_requests() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    endpoint = (
        f"/projects/{PROJECT_ID}/services/research-atlas/arcgis/rest/services/"
        "roads/FeatureServer/0/query/"
    )
    common = {
        "f": "json",
        "returnGeometry": "true",
        "spatialRel": "esriSpatialRelIntersects",
        "geometry": '{"xmin":-78,"ymin":38,"xmax":-76,"ymax":40}',
        "spatialReference": '{"wkid":4326}',
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "outFields": "*",
        "returnIdsOnly": "false",
        "objectIds": "1",
    }

    duplicate = client.get(f"{endpoint}?f=json&f=pjson", headers=headers())
    unknown = client.get(f"{endpoint}?where=1%3D1", headers=headers())
    unsafe_callback = client.get(
        endpoint,
        headers=headers(),
        params={**common, "callback": "alert(1)"},
    )
    too_many_ids = client.get(
        endpoint,
        headers=headers(),
        params={
            **common,
            "objectIds": ",".join(str(index) for index in range(1, 102)),
        },
    )
    unsupported_map = client.get(
        (
            f"/projects/{PROJECT_ID}/services/research-atlas/arcgis/rest/services/"
            "roads/MapServer/export"
        ),
        headers=headers(),
        params={"F": "json"},
    )

    assert duplicate.status_code == 400
    assert duplicate.json()["detail"]["code"] == "compatibility_query_parameter_duplicate"
    assert unknown.status_code == 400
    assert unknown.json()["detail"]["code"] == "compatibility_query_parameter_unsupported"
    assert unsafe_callback.status_code == 400
    assert unsafe_callback.json()["detail"]["code"] == "arcgis_callback_invalid"
    assert too_many_ids.status_code == 400
    assert too_many_ids.json()["detail"]["code"] == "arcgis_object_ids_limit_exceeded"
    assert unsupported_map.status_code == 400


def test_current_membership_revocation_denies_every_service_alias_before_work() -> None:
    repository = MemorySpatialServiceRepository()
    coverage_repository = EmptyCoverageRepository()
    feature_repository = MemoryFeatureRepository()
    renders = MemoryTileRenderRepository()
    dispatcher = MemoryRenderDispatcher()
    principals = FakePrincipalRepository()
    client = api_client(
        repository,
        render_repository=renders,
        render_dispatcher=dispatcher,
        principal_repository=principals,
        coverage_repository=coverage_repository,
        feature_repository=feature_repository,
    )
    create_service(client)
    create_binding(client)
    repository.calls.clear()
    principals.memberships = ()

    openapi = client.app.openapi()
    actual_routes = {
        (method.upper(), path)
        for path, operations in openapi["paths"].items()
        if path.startswith("/projects/{project_id}/spatial-services")
        or path.startswith("/projects/{project_id}/services/{service_slug}")
        for method in operations
        if method.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}
    }
    assert actual_routes == set(PRIVATE_ADMINISTERED_SERVICE_ROUTES)

    for method, template in PRIVATE_ADMINISTERED_SERVICE_ROUTES:
        path = private_administered_service_path(template)
        request_options = {"json": {}} if method in {"POST", "PUT", "PATCH"} else {}
        response = client.request(
            method,
            path,
            headers=headers(),
            follow_redirects=False,
            **request_options,
        )
        assert response.status_code == 403, (method, path, response.text)

    assert repository.calls == []
    assert repository.cache_object_reads == []
    assert coverage_repository.calls == []
    assert feature_repository.calls == []
    assert renders.requests == []
    assert renders.profile_reads == []
    assert renders.job_reads == []
    assert renders.output_reads == []
    assert dispatcher.calls == []


def test_durable_seeded_wmts_cache_is_versioned_exact_and_read_only() -> None:
    repository = MemorySpatialServiceRepository()
    renders = MemoryTileRenderRepository()
    dispatcher = MemoryRenderDispatcher()
    principals = FakePrincipalRepository()
    client = api_client(
        repository,
        render_repository=renders,
        render_dispatcher=dispatcher,
        principal_repository=principals,
    )
    create_service(client)
    create_binding(client)
    admin = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/collections/{BINDING_ID}/tile-cache"
    )
    wmts = f"/projects/{PROJECT_ID}/services/research-atlas/wmts"

    assert (
        client.get(wmts, params={"SERVICE": "WMTS", "REQUEST": "GetCapabilities"}).status_code
        == 401
    )
    configured = client.put(
        admin,
        headers=headers(),
        json={
            "expected_version": 0,
            "minimum_tile_matrix": 0,
            "maximum_tile_matrix": 2,
            "maximum_entries": 10,
            "change_message": "Initial research atlas cache",
        },
    )
    assert configured.status_code == 200
    assert configured.json()["version_number"] == 1
    assert configured.json()["cache_mode"] == "seeded-cache-only"
    assert configured.json()["fixed_inactive_compute_cost"] == "$0"

    missing_params = {
        "SERVICE": "WMTS",
        "REQUEST": "GetTile",
        "VERSION": "1.0.0",
        "LAYER": "roads",
        "STYLE": "default",
        "FORMAT": "image/png",
        "TILEMATRIXSET": "WebMercatorQuad",
        "TILEMATRIX": "0",
        "TILEROW": "0",
        "TILECOL": "0",
    }
    missing = client.get(wmts, headers=headers(), params=missing_params)
    assert missing.status_code == 404
    assert b"TileNotAvailable" in missing.content
    assert renders.requests == []

    seeded = client.post(
        f"{admin}/seeds",
        headers=headers(),
        json={
            "expected_cache_version": 1,
            "tile_matrix": 0,
            "tile_row": 0,
            "tile_col": 0,
        },
    )
    assert seeded.status_code == 202
    assert seeded.json()["tile_available"] is True
    assert len(renders.requests) == 1
    assert renders.requests[0].bbox == web_mercator_tile_bbox(0, 0, 0)
    assert renders.requests[0].crs == "EPSG:3857"
    assert renders.requests[0].transparent is True
    assert dispatcher.calls == []

    capabilities = client.get(
        wmts,
        headers=headers(),
        params={"SERVICE": "WMTS", "REQUEST": "GetCapabilities", "VERSION": "1.0.0"},
    )
    tile = client.get(wmts, headers=headers(), params=missing_params)
    assert capabilities.status_code == 200
    assert b"WebMercatorQuad" in capabilities.content
    assert b"roads" in capabilities.content
    assert b"seeded-cache-only" in capabilities.content
    assert tile.status_code == 200
    assert tile.headers["content-type"] == "image/png"
    assert tile.headers["x-opengeo-cache-version"] == "1"
    assert tile.content == renders.body

    repository.calls.clear()
    repository.cache_object_reads.clear()
    renders.profile_reads.clear()
    renders.job_reads.clear()
    renders.output_reads.clear()
    render_request_count = len(renders.requests)
    dispatcher.calls.clear()
    principals.memberships = ()
    revoked_tile = client.get(wmts, headers=headers(), params=missing_params)
    assert revoked_tile.status_code == 403
    assert repository.calls == []
    assert repository.cache_object_reads == []
    assert renders.profile_reads == []
    assert renders.job_reads == []
    assert renders.output_reads == []
    assert len(renders.requests) == render_request_count
    assert dispatcher.calls == []
    principals.memberships = (OrganizationMembership(ORG_ID, "admin"),)

    invalidated = client.post(
        f"{admin}/invalidate",
        headers=headers(),
        json={"expected_version": 1, "change_message": "Source corrected"},
    )
    assert invalidated.status_code == 200
    assert invalidated.json()["version_number"] == 2
    old_tile = client.get(wmts, headers=headers(), params=missing_params)
    assert old_tile.status_code == 404
    assert len(renders.requests) == 1

    retired = client.get(f"{admin}/retired-versions", headers=headers())
    assert retired.status_code == 200
    assert retired.json()[0]["cache_version_number"] == 1
    assert retired.json()[0]["entry_count"] == 1
    preview = client.post(
        f"{admin}/versions/{CACHE_VERSION_ID}/reclamation-preview",
        headers=headers(),
    )
    assert preview.status_code == 200
    assert preview.json()["target_count"] == 1
    assert preview.json()["physical_action"] == "delete_exact_storage_versions"
    assert preview.json()["ordinary_reads_create_work"] is False
    assert preview.json()["fixed_inactive_compute_cost"] == "$0"
    confirmed = client.post(
        f"{admin}/versions/{CACHE_VERSION_ID}/reclaim",
        headers=headers(),
        json={
            "preview_checksum_sha256": preview.json()["preview_checksum_sha256"],
            "preview_expires_at": preview.json()["expires_at"],
        },
    )
    assert confirmed.status_code == 202
    assert confirmed.json()["state"] == "queued"
    assert dispatcher.calls == [RECLAMATION_ID]


def test_tile_seed_plan_previews_then_confirms_one_bounded_durable_batch() -> None:
    repository = MemorySpatialServiceRepository()
    renders = MemoryTileRenderRepository()
    dispatcher = MemoryRenderDispatcher()
    client = api_client(
        repository,
        render_repository=renders,
        render_dispatcher=dispatcher,
    )
    create_service(client)
    create_binding(client)
    admin = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/collections/{BINDING_ID}/tile-cache"
    )
    configured = client.put(
        admin,
        headers=headers(),
        json={
            "expected_version": 0,
            "minimum_tile_matrix": 0,
            "maximum_tile_matrix": 2,
            "maximum_entries": 10,
        },
    )
    assert configured.status_code == 200
    selector = {
        "expected_cache_version": 1,
        "mode": "tiles",
        "tiles": [
            {"tile_matrix": 1, "tile_row": 1, "tile_col": 1},
            {"tile_matrix": 1, "tile_row": 0, "tile_col": 0},
        ],
    }

    preview = client.post(f"{admin}/seed-plans/preview", headers=headers(), json=selector)
    assert preview.status_code == 200
    assert preview.json()["target_count"] == 2
    assert preview.json()["targets"] == [
        {"tile_matrix": 1, "tile_row": 0, "tile_col": 0},
        {"tile_matrix": 1, "tile_row": 1, "tile_col": 1},
    ]
    assert preview.json()["confirmation_required"] is True
    assert preview.json()["ordinary_reads_create_work"] is False
    assert preview.json()["fixed_inactive_compute_cost"] == "$0"
    assert renders.requests == []
    assert repository.tile_entries == {}

    confirmed = client.post(
        f"{admin}/seed-plans",
        headers=headers(),
        json={
            **selector,
            "preview_checksum_sha256": preview.json()["preview_checksum_sha256"],
            "preview_expires_at": preview.json()["expires_at"],
        },
    )
    assert confirmed.status_code == 202
    assert confirmed.json()["state"] == "completed"
    assert confirmed.json()["activation"] == "explicit-confirmation-only"
    assert confirmed.json()["cancel_available"] is False
    assert len(renders.requests) == 2
    assert len(repository.tile_entries) == 2
    assert dispatcher.calls == []

    listed = client.get(f"{admin}/seed-plans", headers=headers())
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == str(SEED_PLAN_ID)
    rejected_cancel = client.post(f"{admin}/seed-plans/{SEED_PLAN_ID}/cancel", headers=headers())
    assert rejected_cancel.status_code == 409


def test_tile_seed_bbox_expansion_rejects_more_than_sixty_four_before_writes() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository, render_repository=MemoryTileRenderRepository())
    create_service(client)
    create_binding(client)
    admin = (
        f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}/collections/{BINDING_ID}/tile-cache"
    )
    assert (
        client.put(
            admin,
            headers=headers(),
            json={
                "expected_version": 0,
                "minimum_tile_matrix": 0,
                "maximum_tile_matrix": 8,
                "maximum_entries": 100,
            },
        ).status_code
        == 200
    )
    response = client.post(
        f"{admin}/seed-plans/preview",
        headers=headers(),
        json={
            "expected_cache_version": 1,
            "mode": "bbox",
            "bbox": [-180, -85.05112878, 180, 85.05112878],
            "minimum_tile_matrix": 3,
            "maximum_tile_matrix": 4,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "spatial_tile_seed_plan_batch_limit"
    assert repository.seed_plan is None


def test_wmts_kvp_rejects_ambiguous_or_unbounded_requests() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository, render_repository=MemoryTileRenderRepository())
    create_service(client)
    create_binding(client)
    wmts = f"/projects/{PROJECT_ID}/services/research-atlas/wmts"

    duplicate = client.get(
        wmts,
        headers=headers(),
        params=[("SERVICE", "WMTS"), ("REQUEST", "GetCapabilities"), ("request", "GetTile")],
    )
    unknown = client.get(
        wmts,
        headers=headers(),
        params={"SERVICE": "WMTS", "REQUEST": "GetCapabilities", "EXTRA": "true"},
    )
    out_of_range = client.get(
        wmts,
        headers=headers(),
        params={
            "SERVICE": "WMTS",
            "REQUEST": "GetTile",
            "VERSION": "1.0.0",
            "LAYER": "roads",
            "STYLE": "default",
            "FORMAT": "image/png",
            "TILEMATRIXSET": "WebMercatorQuad",
            "TILEMATRIX": "23",
            "TILEROW": "0",
            "TILECOL": "0",
        },
    )
    assert duplicate.status_code == 400
    assert b"duplicate parameter" in duplicate.content
    assert unknown.status_code == 400
    assert b"unknown parameter" in unknown.content
    assert out_of_range.status_code == 404
    assert b"TileOutOfRange" in out_of_range.content


def test_stale_seals_remain_discoverable_but_data_fail_closed() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    assert repository.binding is not None
    repository.binding = replace(repository.binding, current_feature_generation=4)
    root = f"/projects/{PROJECT_ID}/services/research-atlas/ogc/collections/roads"

    description = client.get(root, headers=headers())
    items = client.get(f"{root}/items", headers=headers())
    tile = client.get(f"{root}/tiles/WebMercatorQuad/0/0/0", headers=headers())

    assert description.status_code == 200
    assert description.json()["opengeo:stale"] is True
    assert items.status_code == 409
    assert items.json()["detail"]["code"] == "spatial_service_collection_stale"
    assert items.json()["detail"]["sealed_feature_generation"] == 3
    assert items.json()["detail"]["current_feature_generation"] == 4
    assert tile.status_code == 409


def test_withdraw_and_disable_are_forward_only_discovery_boundaries() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    admin = f"/projects/{PROJECT_ID}/spatial-services/{SERVICE_ID}"
    discovery = f"/projects/{PROJECT_ID}/services/research-atlas/ogc"

    withdrawn = client.post(f"{admin}/collections/{BINDING_ID}/withdraw", headers=headers())
    assert withdrawn.status_code == 200
    assert withdrawn.json()["withdrawn_at"] is not None
    assert client.get(f"{discovery}/collections/roads", headers=headers()).status_code == 404

    disabled = client.post(f"{admin}/disable", headers=headers())
    assert disabled.status_code == 200
    assert disabled.json()["disabled_at"] is not None
    assert client.get(discovery, headers=headers()).status_code == 404
    history = client.get(f"{admin}/collections?include_withdrawn=true", headers=headers())
    assert history.status_code == 200
    assert history.json()[0]["id"] == str(BINDING_ID)


def test_service_contract_bounds_and_schema_are_explicit() -> None:
    repository = MemorySpatialServiceRepository()
    client = api_client(repository)
    create_service(client)
    create_binding(client)
    root = f"/projects/{PROJECT_ID}/services/research-atlas/ogc/collections/roads"

    assert client.get(f"{root}/items?filter=name%3Droad", headers=headers()).status_code == 400
    assert client.get(f"{root}/items?limit=101", headers=headers()).status_code == 422
    assert (
        client.get(
            f"{root}/map?bbox=-1,-1,1,1&width=2048&height=2048&f=png",
            headers=headers(),
            follow_redirects=False,
        ).status_code
        == 307
    )
    assert (
        client.get(
            f"{root}/map?bbox=-1,-1,1,1&width=2048&height=2048&extra=true",
            headers=headers(),
        ).status_code
        == 400
    )
    invalid = client.post(
        f"/projects/{PROJECT_ID}/spatial-services",
        headers=headers(),
        json={"slug": "Invalid Slug", "title": "Invalid", "unknown": True},
    )
    assert invalid.status_code == 422

    document = service_api_document(PROJECT_ID, "research-atlas")
    assert document["security"] == [{"bearerAuth": []}]
    assert document["x-opengeo-conformance-claimed"] is False
    assert len(document["paths"]) == 16
    assert EPSG3857.endswith("/3857")
