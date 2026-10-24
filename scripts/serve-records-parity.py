"""Serve real Records, Features, render, and spatial-service routes for local peers."""

import argparse
import json
from dataclasses import replace
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import cast
from uuid import UUID

import uvicorn
from fastapi import Request
from opengeo_api.app import create_app
from opengeo_api.auth_models import (
    OrganizationMembership,
    Principal,
    VerifiedAccessToken,
)
from opengeo_api.auth_tokens import TokenVerificationError
from opengeo_api.config import Settings
from opengeo_api.coverages import CoverageNotFound, CoverageRepository
from opengeo_api.features import (
    AttributeQueryStep,
    FeatureAccessDenied,
    FeatureCollection,
    FeatureConflict,
    FeatureDeletion,
    FeatureField,
    FeatureInvalid,
    FeatureMutation,
    FeatureNotFound,
    FeaturePage,
    FeatureRecord,
    SpatialQueryStep,
    TemporalQueryStep,
    normalize_properties,
)
from opengeo_api.rendering import (
    RenderAccessDenied,
    RenderedMapOutput,
    RenderJob,
    RenderNotFound,
    RenderProfile,
    RenderRepository,
    RenderRequest,
    RenderSubmission,
)
from opengeo_api.resources import (
    RecordFilters,
    RecordResource,
    RecordResourcePage,
    ResourceAccessDenied,
    ResourceExternalIdentifier,
    ResourceNotFound,
    ResourceRepository,
    ResourceSummary,
)
from opengeo_api.spatial_services import (
    SpatialService,
    SpatialServiceAccessDenied,
    SpatialServiceCollection,
    SpatialServiceNotFound,
    SpatialTileCacheEntry,
    SpatialTileCachePolicy,
)

USER_ID = UUID("20000000-0000-4000-8000-0000000000e2")
ORGANIZATION_ID = UUID("10000000-0000-4000-8000-0000000000e2")
OTHER_ORGANIZATION_ID = UUID("10000000-0000-4000-8000-0000000000e3")
FORGED_ORGANIZATION_ID = UUID("10000000-0000-4000-8000-0000000000ef")
PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000e2")
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000e2")
DATASET_ID = UUID("80000000-0000-4000-8000-0000000000e2")
FEATURE_ID = UUID("90000000-0000-4000-8000-0000000000e2")
SERVICE_ID = UUID("60000000-0000-4000-8000-0000000000e2")
BINDING_ID = UUID("70000000-0000-4000-8000-0000000000e2")
PROFILE_ID = UUID("a1000000-0000-4000-8000-0000000000e2")
PROFILE_VERSION_ID = UUID("a2000000-0000-4000-8000-0000000000e2")
RESOURCE_VERSION_ID = UUID("a3000000-0000-4000-8000-0000000000e2")
DATASET_VERSION_ID = UUID("81000000-0000-4000-8000-0000000000e2")
STYLE_ID = UUID("a4000000-0000-4000-8000-0000000000e2")
STYLE_VERSION_ID = UUID("a5000000-0000-4000-8000-0000000000e2")
OUTPUT_ID = UUID("a7000000-0000-4000-8000-0000000000e2")
CACHE_ID = UUID("a8000000-0000-4000-8000-0000000000e2")
CACHE_VERSION_ID = UUID("a9000000-0000-4000-8000-0000000000e2")
NOW = datetime(2026, 8, 20, 18, tzinfo=UTC)
TOKEN = "records-peer-token"
MAP_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'
MAP_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082"
)


class PassingProbe:
    async def check(self) -> None:
        pass


class ParityVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        if token != TOKEN:
            raise TokenVerificationError("invalid parity token")
        return VerifiedAccessToken(
            "records-peer-subject", "records-peer", "user", (), ()
        )


class ParityPrincipalRepository:
    async def resolve(self, subject: str) -> Principal | None:
        if subject != "records-peer-subject":
            return None
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="records-peer@example.test",
            display_name="Records HTTP peer",
            memberships=(
                OrganizationMembership(ORGANIZATION_ID, "member"),
                OrganizationMembership(OTHER_ORGANIZATION_ID, "guest"),
            ),
        )


def record_resource() -> RecordResource:
    return RecordResource(
        summary=ResourceSummary(
            resource_id=RESOURCE_ID,
            project_id=PROJECT_ID,
            kind="dataset",
            slug="roads",
            dataset_id=None,
            map_id=None,
            visibility="organization",
            state="published",
            version_number=3,
            title="Road network",
            abstract="Curated road network for research.",
            language="en",
            license="CC-BY-4.0",
            attribution="OpenGeo parity research team",
            keywords=("roads", "transport"),
            spatial_extent=(-77.2, 38.7, -76.8, 39.1),
            temporal_start=datetime(2026, 1, 1, tzinfo=UTC),
            temporal_end=None,
            owner_user_id=USER_ID,
            origin_namespace=None,
            origin_identifier=None,
            relationship_count=0,
            created_at=NOW,
            updated_at=NOW,
        ),
        translations={
            "fr": {
                "title": "Réseau routier",
                "abstract": "Réseau routier organisé pour la recherche.",
                "keywords": ["routes", "transport"],
            }
        },
        external_identifiers=(
            ResourceExternalIdentifier(
                namespace="doi",
                identifier="10.1234/roads",
                source_url="https://example.test/roads",
                source_version="1",
                source_payload_sha256="a" * 64,
                imported_at=NOW,
            ),
        ),
    )


class ParityResourceRepository:
    def _authorize(self, context, project_id: UUID) -> None:
        if (
            context.user_id != USER_ID
            or context.organization_id != ORGANIZATION_ID
            or project_id != PROJECT_ID
        ):
            raise ResourceAccessDenied("records parity scope denied")

    async def list_record_resources(
        self, context, project_id: UUID, filters: RecordFilters
    ) -> RecordResourcePage:
        self._authorize(context, project_id)
        record = record_resource()
        summary = record.summary
        matches = True
        if filters.kinds and summary.kind not in filters.kinds:
            matches = False
        if filters.ids and summary.resource_id not in filters.ids:
            matches = False
        identifiers = {item.identifier for item in record.external_identifiers} | {
            f"{item.namespace}:{item.identifier}"
            for item in record.external_identifiers
        }
        if filters.external_ids and not any(
            item in identifiers for item in filters.external_ids
        ):
            matches = False
        if filters.query and not any(
            term in filters.query.lower() for term in ("road", "transport", "research")
        ):
            matches = False
        if filters.bbox is not None and summary.spatial_extent is not None:
            min_x, min_y, max_x, max_y = filters.bbox
            item_min_x, item_min_y, item_max_x, item_max_y = summary.spatial_extent
            if (
                max_x < item_min_x
                or item_max_x < min_x
                or max_y < item_min_y
                or item_max_y < min_y
            ):
                matches = False
        if filters.temporal_start is not None and summary.temporal_end is not None:
            matches = matches and summary.temporal_end >= filters.temporal_start
        if filters.temporal_end is not None and summary.temporal_start is not None:
            matches = matches and summary.temporal_start <= filters.temporal_end
        resources = (record,) if matches and filters.offset == 0 else ()
        return RecordResourcePage(resources[: filters.limit], 1 if matches else 0)

    async def get_resource(
        self, context, project_id: UUID, resource_id: UUID
    ) -> RecordResource:
        self._authorize(context, project_id)
        if resource_id != RESOURCE_ID:
            raise ResourceNotFound("resource")
        return record_resource()


def feature_collection() -> FeatureCollection:
    return FeatureCollection(
        dataset_id=DATASET_ID,
        geometry_type="LineString",
        fields=(
            FeatureField("name", "string", True),
            FeatureField("surveyed", "boolean", False),
        ),
        generation=3,
        feature_count=1,
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
    )


def feature_record() -> FeatureRecord:
    return FeatureRecord(
        feature_id=FEATURE_ID,
        version_number=2,
        geometry_type="LineString",
        geometry={
            "type": "LineString",
            "coordinates": [[-77.1, 38.8], [-77.0, 38.9], [-76.9, 39.0]],
        },
        bbox=(-77.1, 38.8, -76.9, 39.0),
        properties={"name": "Governed access route", "surveyed": True},
        created_by=USER_ID,
        created_at=NOW,
        updated_by=USER_ID,
        updated_at=NOW,
    )


def _parity_attribute_matches(candidate, step: AttributeQueryStep) -> bool:
    if step.operator == "is_null":
        return candidate is None
    if candidate is None:
        return False
    if step.operator in {"contains", "starts_with"}:
        left = str(candidate) if step.case_sensitive else str(candidate).casefold()
        right = str(step.value) if step.case_sensitive else str(step.value).casefold()
        return right in left if step.operator == "contains" else left.startswith(right)
    if step.operator in {"equals", "not_equals"} and not step.case_sensitive:
        left = str(candidate).casefold()
        right = str(step.value).casefold()
        return left == right if step.operator == "equals" else left != right
    if step.operator == "equals":
        return candidate == step.value
    if step.operator == "not_equals":
        return candidate != step.value
    if step.operator == "greater_than":
        return candidate > step.value
    if step.operator == "greater_than_or_equal":
        return candidate >= step.value
    if step.operator == "less_than":
        return candidate < step.value
    if step.operator == "less_than_or_equal":
        return candidate <= step.value
    return False


def _parity_geometry_bbox(geometry) -> tuple[float, float, float, float]:
    def positions(value):
        if (
            isinstance(value, list)
            and len(value) >= 2
            and all(isinstance(item, int | float) for item in value[:2])
        ):
            return [value]
        return [position for item in value for position in positions(item)]

    coordinates = positions(geometry["coordinates"])
    return (
        min(item[0] for item in coordinates),
        min(item[1] for item in coordinates),
        max(item[0] for item in coordinates),
        max(item[1] for item in coordinates),
    )


class ParityFeatureRepository:
    def __init__(self) -> None:
        self.collection = feature_collection()
        initial = feature_record()
        self.features = {initial.feature_id: initial}

    @staticmethod
    def _authorize(context, project_id: UUID, dataset_id: UUID) -> None:
        if (
            context.user_id != USER_ID
            or context.organization_id != ORGANIZATION_ID
            or project_id != PROJECT_ID
            or dataset_id != DATASET_ID
        ):
            raise FeatureAccessDenied("features parity scope denied")

    async def list_features(
        self,
        context,
        project_id: UUID,
        dataset_id: UUID,
        *,
        bbox,
        limit,
        offset,
        expected_generation=None,
    ) -> FeaturePage:
        self._authorize(context, project_id, dataset_id)
        if (
            expected_generation is not None
            and expected_generation != self.collection.generation
        ):
            raise FeatureConflict(
                "feature_collection_generation_conflict", self.collection.generation
            )
        records = tuple(
            record
            for record in self.features.values()
            if bbox is None
            or not (
                record.bbox[2] < bbox[0]
                or record.bbox[0] > bbox[2]
                or record.bbox[3] < bbox[1]
                or record.bbox[1] > bbox[3]
            )
        )
        return FeaturePage(
            self.collection,
            records[offset : offset + limit],
            len(records),
            limit,
            offset,
        )

    async def get_feature(
        self,
        context,
        project_id: UUID,
        dataset_id: UUID,
        feature_id: UUID,
        *,
        expected_generation=None,
    ) -> FeatureRecord:
        self._authorize(context, project_id, dataset_id)
        if (
            expected_generation is not None
            and expected_generation != self.collection.generation
        ):
            raise FeatureConflict(
                "feature_collection_generation_conflict", self.collection.generation
            )
        try:
            return self.features[feature_id]
        except KeyError as error:
            raise FeatureNotFound("feature") from error

    async def query_features(
        self,
        context,
        project_id: UUID,
        dataset_id: UUID,
        *,
        steps,
        limit,
        offset,
        expected_generation=None,
    ) -> FeaturePage:
        self._authorize(context, project_id, dataset_id)
        if (
            expected_generation is not None
            and expected_generation != self.collection.generation
        ):
            raise FeatureConflict(
                "feature_collection_generation_conflict", self.collection.generation
            )
        fields = {field.name for field in self.collection.fields}
        records = list(self.features.values())
        for step in steps:
            if isinstance(step, AttributeQueryStep):
                if step.field not in fields:
                    raise FeatureInvalid("feature query field is not in the collection schema")
                records = [
                    record
                    for record in records
                    if _parity_attribute_matches(record.properties.get(step.field), step)
                ]
            elif isinstance(step, SpatialQueryStep):
                query_bbox = _parity_geometry_bbox(step.geometry)
                records = [
                    record
                    for record in records
                    if not (
                        record.bbox[2] < query_bbox[0]
                        or record.bbox[0] > query_bbox[2]
                        or record.bbox[3] < query_bbox[1]
                        or record.bbox[1] > query_bbox[3]
                    )
                ]
            elif isinstance(step, TemporalQueryStep):
                records = [
                    record
                    for record in records
                    if step.begin
                    <= (
                        record.created_at
                        if step.field == "opengeo_created_at"
                        else record.updated_at
                    )
                    < step.end
                ]
        return FeaturePage(
            self.collection,
            tuple(records[offset : offset + limit]),
            len(records),
            limit,
            offset,
        )

    async def create_collection(self, *args, **kwargs):
        raise FeatureAccessDenied("parity service is read only")

    async def create_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature,
        change_message,
        request_id,
    ) -> FeatureMutation:
        del change_message, request_id
        self._authorize(context, project_id, dataset_id)
        if feature.feature_id in self.features:
            raise FeatureConflict("feature_id_exists")
        if feature.geometry_type != self.collection.geometry_type:
            raise FeatureInvalid("feature geometry type does not match collection")
        record = FeatureRecord(
            feature.feature_id,
            1,
            feature.geometry_type,
            feature.geometry,
            feature.bbox,
            normalize_properties(feature.properties, self.collection.fields),
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )
        self.features[record.feature_id] = record
        self.collection = replace(
            self.collection,
            generation=self.collection.generation + 1,
            feature_count=len(self.features),
        )
        return FeatureMutation(self.collection, record)

    async def update_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        feature,
        change_message,
        request_id,
    ) -> FeatureMutation:
        del change_message, request_id
        current = await self.get_feature(context, project_id, dataset_id, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        if feature.feature_id != feature_id:
            raise FeatureInvalid("feature id cannot change")
        if feature.geometry_type != self.collection.geometry_type:
            raise FeatureInvalid("feature geometry type does not match collection")
        record = replace(
            current,
            version_number=current.version_number + 1,
            geometry_type=feature.geometry_type,
            geometry=feature.geometry,
            bbox=feature.bbox,
            properties=normalize_properties(feature.properties, self.collection.fields),
            updated_by=USER_ID,
            updated_at=NOW,
        )
        self.features[feature_id] = record
        self.collection = replace(
            self.collection, generation=self.collection.generation + 1
        )
        return FeatureMutation(self.collection, record)

    async def delete_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        change_message,
        request_id,
    ) -> FeatureDeletion:
        del change_message, request_id
        current = await self.get_feature(context, project_id, dataset_id, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        del self.features[feature_id]
        self.collection = replace(
            self.collection,
            generation=self.collection.generation + 1,
            feature_count=len(self.features),
        )
        return FeatureDeletion(
            feature_id, current.version_number + 1, self.collection.generation
        )

    async def list_feature_history(self, *args, **kwargs):
        raise FeatureAccessDenied("parity service is read only")


class ParitySpatialServiceRepository:
    def __init__(self) -> None:
        self.cache: SpatialTileCachePolicy | None = None
        self.entries: dict[tuple[int, int, int], SpatialTileCacheEntry] = {}

    @staticmethod
    def _authorize(context, project_id: UUID) -> None:
        if (
            context.user_id != USER_ID
            or context.organization_id != ORGANIZATION_ID
            or project_id != PROJECT_ID
        ):
            raise SpatialServiceAccessDenied("spatial service parity scope denied")

    @staticmethod
    def _service() -> SpatialService:
        return SpatialService(
            SERVICE_ID,
            PROJECT_ID,
            "research-atlas",
            "Research atlas",
            "Governed feature, map, and tile access for research.",
            USER_ID,
            NOW,
            None,
            None,
        )

    @staticmethod
    def _binding() -> SpatialServiceCollection:
        return SpatialServiceCollection(
            BINDING_ID,
            PROJECT_ID,
            SERVICE_ID,
            "roads",
            DATASET_ID,
            RESOURCE_ID,
            PROFILE_ID,
            3,
            PROFILE_VERSION_ID,
            2,
            3,
            PROFILE_VERSION_ID,
            2,
            "Road network",
            "Curated road centerlines.",
            USER_ID,
            NOW,
            None,
            None,
            True,
        )

    async def get_active_service(self, context, project_id: UUID, slug: str):
        self._authorize(context, project_id)
        if slug != "research-atlas":
            raise SpatialServiceNotFound("spatial_service")
        return self._service()

    async def list_collections(
        self, context, project_id: UUID, service_id: UUID, *, include_withdrawn: bool
    ):
        del include_withdrawn
        self._authorize(context, project_id)
        if service_id != SERVICE_ID:
            raise SpatialServiceNotFound("spatial_service")
        return (self._binding(),)

    async def resolve_collection(
        self, context, project_id: UUID, service_slug: str, collection_name: str
    ):
        self._authorize(context, project_id)
        if service_slug != "research-atlas" or collection_name != "roads":
            raise SpatialServiceNotFound("spatial_service_collection")
        return self._binding()

    async def list_services(self, context, project_id: UUID):
        self._authorize(context, project_id)
        return (self._service(),)

    async def create_service(self, *args, **kwargs):
        raise SpatialServiceAccessDenied("parity service is read only")

    async def disable_service(self, *args, **kwargs):
        raise SpatialServiceAccessDenied("parity service is read only")

    async def create_collection(self, *args, **kwargs):
        raise SpatialServiceAccessDenied("parity service is read only")

    async def withdraw_collection(self, *args, **kwargs):
        raise SpatialServiceAccessDenied("parity service is read only")

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
        del request_id
        self._authorize(context, project_id)
        if service_id != SERVICE_ID or binding_id != BINDING_ID:
            raise SpatialServiceNotFound("spatial_service_collection")
        current = 0 if self.cache is None else self.cache.version_number
        if expected_version != current:
            raise SpatialServiceAccessDenied("tile cache version conflict")
        version = current + 1
        self.cache = SpatialTileCachePolicy(
            CACHE_ID,
            PROJECT_ID,
            SERVICE_ID,
            BINDING_ID,
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
        self.entries = {}
        return self.cache

    async def get_tile_cache(self, context, project_id, binding_id):
        self._authorize(context, project_id)
        if self.cache is None or binding_id != BINDING_ID:
            raise SpatialServiceNotFound("spatial_tile_cache")
        return replace(self.cache, current_entries=len(self.entries))

    async def list_tile_caches(self, context, project_id, service_id):
        self._authorize(context, project_id)
        if service_id != SERVICE_ID:
            raise SpatialServiceNotFound("spatial_service")
        if self.cache is None:
            return ()
        return (replace(self.cache, current_entries=len(self.entries)),)

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
        del request_id
        current = await self.get_tile_cache(context, project_id, binding_id)
        if service_id != SERVICE_ID or expected_version != current.version_number:
            raise SpatialServiceAccessDenied("tile cache version conflict")
        self.cache = replace(
            current,
            version_id=UUID(int=current.version_id.int + 1),
            version_number=current.version_number + 1,
            current_entries=0,
            change_message=change_message,
        )
        self.entries = {}
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
        del request_id
        cache = await self.get_tile_cache(context, project_id, binding_id)
        if cache.version_number != expected_cache_version:
            raise SpatialServiceAccessDenied("tile cache version conflict")
        key = (tile_matrix, tile_row, tile_col)
        existing = self.entries.get(key)
        if existing is not None:
            return existing
        entry = SpatialTileCacheEntry(
            UUID(int=CACHE_ID.int + len(self.entries) + 1),
            CACHE_ID,
            cache.version_id,
            cache.version_number,
            tile_matrix,
            tile_row,
            tile_col,
            render_job_id,
            USER_ID,
            NOW,
        )
        self.entries[key] = entry
        return entry

    async def resolve_tile_cache_entry(
        self, context, project_id, binding_id, tile_matrix, tile_row, tile_col
    ):
        await self.get_tile_cache(context, project_id, binding_id)
        entry = self.entries.get((tile_matrix, tile_row, tile_col))
        if entry is None:
            raise SpatialServiceNotFound("spatial_tile_cache_entry")
        return entry


class EmptyCoverageRepository:
    async def list_coverages(
        self, context, project_id: UUID, service_id: UUID, *, include_withdrawn: bool
    ):
        del context, include_withdrawn
        if (project_id, service_id) != (PROJECT_ID, SERVICE_ID):
            raise CoverageNotFound("spatial_service")
        return ()

    async def resolve_coverage(
        self, context, project_id: UUID, service_slug: str, coverage_name: str
    ):
        del context, project_id, service_slug, coverage_name
        raise CoverageNotFound("spatial_service_coverage")


def render_profile() -> RenderProfile:
    return RenderProfile(
        PROFILE_ID,
        PROJECT_ID,
        RESOURCE_ID,
        "roads-map",
        2,
        "Road network map",
        RESOURCE_VERSION_ID,
        DATASET_ID,
        DATASET_VERSION_ID,
        STYLE_ID,
        STYLE_VERSION_ID,
        {
            "schema": "opengeo.render.v1",
            "renderer": "opengeo.deterministic-svg.v1",
            "geometry": {"type": "line", "color": "#275d52"},
        },
        "a" * 64,
        "Parity profile",
        USER_ID,
        NOW,
        NOW,
    )


class ParityRenderRepository:
    def __init__(self) -> None:
        self.jobs: dict[UUID, RenderJob] = {}

    @staticmethod
    def _authorize(context, project_id: UUID, resource_id: UUID) -> None:
        if (
            context.user_id != USER_ID
            or context.organization_id != ORGANIZATION_ID
            or project_id != PROJECT_ID
            or resource_id != RESOURCE_ID
        ):
            raise RenderAccessDenied("render parity scope denied")

    async def get_profile(
        self, context, project_id: UUID, resource_id: UUID, profile_id: UUID
    ) -> RenderProfile:
        self._authorize(context, project_id, resource_id)
        if profile_id != PROFILE_ID:
            raise RenderNotFound("render_profile")
        return render_profile()

    async def find_job_by_idempotency(
        self, context, project_id: UUID, resource_id: UUID, idempotency_key: UUID
    ) -> RenderJob | None:
        self._authorize(context, project_id, resource_id)
        return self.jobs.get(idempotency_key)

    async def request_render(
        self,
        context,
        project_id: UUID,
        resource_id: UUID,
        profile_id: UUID,
        request: RenderRequest,
        request_id: str,
    ) -> RenderSubmission:
        del request_id
        self._authorize(context, project_id, resource_id)
        if profile_id != PROFILE_ID:
            raise RenderNotFound("render_profile")
        body = MAP_PNG if request.format == "png" else MAP_SVG
        content_type = "image/png" if request.format == "png" else "image/svg+xml"
        checksum = sha256(body).hexdigest()
        job = RenderJob(
            request.idempotency_key,
            PROJECT_ID,
            RESOURCE_ID,
            PROFILE_ID,
            PROFILE_VERSION_ID,
            2,
            DATASET_ID,
            DATASET_VERSION_ID,
            STYLE_ID,
            STYLE_VERSION_ID,
            request.bbox,
            request.crs,
            request.width,
            request.height,
            request.format,
            request.background_color,
            request.transparent,
            checksum,
            "completed",
            1,
            OUTPUT_ID,
            content_type,
            len(body),
            checksum,
            None,
            USER_ID,
            NOW,
            NOW,
            NOW,
        )
        self.jobs[request.idempotency_key] = job
        return RenderSubmission(job, False)

    async def get_job(
        self, context, project_id: UUID, resource_id: UUID, job_id: UUID
    ) -> RenderJob:
        self._authorize(context, project_id, resource_id)
        job = self.jobs.get(job_id)
        if job is None:
            raise RenderNotFound("render_job")
        return job

    async def read_map_output(
        self,
        context,
        project_id: UUID,
        resource_id: UUID,
        job_id: UUID,
        maximum_bytes: int,
        request_id: str,
    ) -> RenderedMapOutput:
        del request_id
        self._authorize(context, project_id, resource_id)
        job = self.jobs.get(job_id)
        if job is None:
            raise RenderNotFound("render_job")
        body = MAP_PNG if job.format == "png" else MAP_SVG
        if len(body) > maximum_bytes:
            raise RenderNotFound("render_output")
        return RenderedMapOutput(
            body,
            f"roads.{job.format}",
            "image/png" if job.format == "png" else "image/svg+xml",
            len(body),
            sha256(body).hexdigest(),
            "parity-output-version",
        )


class ParityRenderDispatcher:
    async def dispatch_render(self, job_id: UUID) -> None:
        del job_id


def application(log_path: Path):
    app = create_app(
        settings=Settings(env="test", expose_docs=False),
        readiness_probe=PassingProbe(),
        token_verifier=ParityVerifier(),
        principal_repository=ParityPrincipalRepository(),
        resource_repository=cast(ResourceRepository, ParityResourceRepository()),
        feature_repository=ParityFeatureRepository(),
        spatial_service_repository=ParitySpatialServiceRepository(),
        coverage_repository=cast(CoverageRepository, EmptyCoverageRepository()),
        render_repository=cast(RenderRepository, ParityRenderRepository()),
        render_dispatcher=ParityRenderDispatcher(),
    )

    @app.middleware("http")
    async def record_request(request: Request, call_next):
        response = await call_next(request)
        record = {
            "method": request.method,
            "path": request.url.path,
            "query": request.url.query,
            "authorization": request.headers.get("authorization") == f"Bearer {TOKEN}",
            "organization": request.headers.get("x-opengeo-organization")
            == str(ORGANIZATION_ID),
            "userAgent": request.headers.get("user-agent", ""),
            "status": response.status_code,
            "contentType": response.headers.get("content-type"),
            "profileLink": 'rel="profile"' in response.headers.get("link", ""),
        }
        with log_path.open("a", encoding="utf8") as log:
            log.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
        return response

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, required=True)
    arguments = parser.parse_args()
    if not 1024 <= arguments.port <= 65535:
        raise SystemExit("port is outside the allowed parity range")
    log_path = arguments.log.resolve()
    if not log_path.parent.is_dir() or log_path.exists():
        raise SystemExit("log must be a new file in an existing directory")
    uvicorn.run(
        application(log_path),
        host="127.0.0.1",
        port=arguments.port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
