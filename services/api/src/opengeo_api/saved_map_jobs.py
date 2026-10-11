"""Create render jobs from immutable map revisions, never from mutable map heads."""

import json
import math
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action
from opengeo_api.catalog import CatalogNotFound, PostgresCatalogRepository
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.render_runtime import RenderRuntimeReference
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderConflict,
    RenderNotFound,
    RenderSubmission,
)
from opengeo_api.saved_map_render_passes import (
    SavedMapStyleIdentity,
    bind_saved_map_pass,
    compile_saved_map_passes,
)
from opengeo_api.saved_map_rendering import (
    SavedMapRenderLayer,
    SavedMapRenderUnsupported,
    compile_saved_map,
)
from opengeo_api.saved_map_style_resolution import resolve_saved_map_styles
from opengeo_api.tenant_database import TenantContext, TenantTransaction


@dataclass(frozen=True, slots=True)
class SavedMapRenderRequest:
    idempotency_key: UUID
    expected_resource_version: int
    expected_map_version: int
    width: int
    height: int
    format: str = "png"


def saved_view_bbox(view: dict[str, Any] | None, width: int, height: int) -> list[float]:
    """Keep the saved center/zoom at MapLibre's 512-pixel world scale."""
    if view is None:
        raise SavedMapRenderUnsupported(
            "saved_map_view_required", "Save the map's viewing position before creating its image."
        )
    longitude, latitude = view["center"]
    if abs(latitude) > 85.0511287798066:
        raise SavedMapRenderUnsupported(
            "saved_map_view_unsupported", "Choose a map view within the Mercator latitude range."
        )
    radius = 6_378_137.0
    limit = math.pi * radius
    scale = 2 * limit / (512 * 2 ** view["zoom"])
    x = radius * math.radians(longitude)
    y = radius * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2))
    bbox = [
        x - width * scale / 2,
        y - height * scale / 2,
        x + width * scale / 2,
        y + height * scale / 2,
    ]
    if any(not math.isfinite(value) or abs(value) > limit for value in bbox):
        raise SavedMapRenderUnsupported(
            "saved_map_view_wrap_unsupported",
            "Zoom in or use smaller dimensions to keep the image within the world boundary.",
        )
    return bbox


async def request_saved_map_render(
    repository: PostgresRenderRepository,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    request: SavedMapRenderRequest,
    request_id: str,
) -> RenderSubmission:
    for value in (request.expected_resource_version, request.expected_map_version):
        if type(value) is not int or not 1 <= value <= 9_007_199_254_740_991:
            raise RenderConflict("saved_map_version_invalid")
    if (
        type(request.width) is not int
        or type(request.height) is not int
        or not 64 <= request.width <= 2048
        or not 64 <= request.height <= 2048
        or request.width * request.height > 4_194_304
        or request.format != "png"
    ):
        raise RenderConflict("saved_map_dimensions_invalid")

    async def operation(transaction: TenantTransaction) -> RenderSubmission:
        roles = await repository._resource_roles(transaction, context, project_id, resource_id)
        repository._require(Action.RENDER_REQUEST, roles)
        repository._require(Action.RENDER_CONFIGURE, roles)
        row = await transaction.fetch_one(
            """
            SELECT resource.current_version_id, version.version_number,
                   binding.map_id, binding.map_version, history.definition
            FROM app.governed_resources resource
            JOIN app.governed_resource_versions version
              ON version.organization_id = resource.organization_id
             AND version.resource_id = resource.id AND version.id = resource.current_version_id
            JOIN app.map_resource_version_bindings binding
              ON binding.organization_id = resource.organization_id
             AND binding.project_id = resource.project_id AND binding.resource_id = resource.id
             AND binding.resource_version_id = version.id
            JOIN app.maps map
              ON map.organization_id = binding.organization_id
             AND map.project_id = binding.project_id
             AND map.id = binding.map_id AND map.status = 'active'
            JOIN app.map_versions history
              ON history.organization_id = binding.organization_id
             AND history.map_id = binding.map_id
             AND history.version = binding.map_version
            WHERE resource.organization_id = %s AND resource.project_id = %s
              AND resource.id = %s AND resource.kind = 'map' AND resource.state <> 'archived'
            FOR SHARE OF resource, map
            """,
            (context.organization_id, project_id, resource_id),
        )
        if row is None:
            raise RenderConflict("map_resource_snapshot_required")
        if row[1] != request.expected_resource_version or row[3] != request.expected_map_version:
            raise RenderConflict("map_version_conflict")
        resource_version_id = cast(UUID, row[0])
        definition = cast(dict[str, Any], row[4])
        styles = await resolve_saved_map_styles(transaction, context, definition)
        recipe = compile_saved_map(definition, resolved_styles=styles)
        passes = compile_saved_map_passes(recipe)
        needs_gl = any(item.renderer == "opengeo.maplibre-gl-js.v1" for item in passes)
        if needs_gl and (
            not repository.saved_map_gl_enabled
            or not isinstance(repository.saved_map_gl_runtime_reference, RenderRuntimeReference)
        ):
            raise SavedMapRenderUnsupported(
                "saved_map_font_renderer_unavailable",
                "MapLibre image rendering for filters and pinned fonts "
                "is not enabled on this deployment yet. "
                "Your saved map is unchanged; no image job was created.",
            )
        runtime_reference = repository.saved_map_gl_runtime_reference if needs_gl else None
        if runtime_reference is not None:
            passes = compile_saved_map_passes(recipe, runtime_reference=runtime_reference)
        bbox = saved_view_bbox(
            json.loads(recipe.map_view_json) if recipe.map_view_json else None,
            request.width,
            request.height,
        )
        checksum = sha256(
            canonical_json_bytes(
                {
                    "schema": "opengeo.saved-map-request.1.0.0",
                    "resourceId": str(resource_id),
                    "resourceVersionId": str(resource_version_id),
                    "recipeChecksumSha256": recipe.checksum_sha256,
                    "bbox": bbox,
                    "width": request.width,
                    "height": request.height,
                    "format": request.format,
                    **(
                        {"runtimeReference": runtime_reference.as_dict()}
                        if runtime_reference is not None
                        else {}
                    ),
                }
            )
        ).hexdigest()
        existing = await transaction.fetch_one(
            """SELECT id, resource_id, request_checksum_sha256 FROM app.map_render_jobs
               WHERE organization_id = %s AND idempotency_key = %s
               UNION ALL
               SELECT job.id, job.resource_id, job.request_checksum_sha256
               FROM app.saved_map_render_reuse reuse JOIN app.map_render_jobs job
                 ON job.organization_id = reuse.organization_id AND job.id = reuse.render_job_id
               WHERE reuse.organization_id = %s AND reuse.idempotency_key = %s
               LIMIT 1""",
            (
                context.organization_id,
                request.idempotency_key,
                context.organization_id,
                request.idempotency_key,
            ),
        )
        if existing is not None:
            if existing[1] != resource_id or existing[2] != checksum:
                raise RenderConflict("render_idempotency_conflict")
            job = await repository._load_job(
                transaction, context, project_id, resource_id, cast(UUID, existing[0])
            )
            await repository._require_composition_access(
                transaction, context, project_id, job.job_id, Action.RENDER_READ
            )
            return RenderSubmission(job, job.state == "queued")

        # Resolve every input before the first INSERT. A denied or unsupported layer
        # creates neither styles nor jobs, and no source is rediscovered by the worker.
        sources = {
            layer.layer_id: await _resolve_source(
                repository, transaction, context, project_id, layer
            )
            for layer in recipe.layers
        }
        # A request checksum identifies recipe/output settings, while this ordered
        # pin vector also identifies the exact currently selected source bytes and
        # metadata versions. A new preview or metadata pin cannot reuse old output.
        expected_pins = []
        for render_pass in passes:
            source = sources[render_pass.layer_id]
            expected_pins.append(
                {
                    "position": render_pass.position,
                    "resourceId": str(source.resource_id),
                    "resourceVersionId": str(source.resource_version_id),
                    "datasetId": str(render_pass.dataset_id),
                    "datasetVersionId": str(render_pass.dataset_version_id),
                    "objectId": str(source.object_id),
                    "storageVersion": source.s3_version_id,
                    "checksumSha256": source.checksum_sha256,
                }
            )
        reusable = await transaction.fetch_one(
            """SELECT job.id FROM app.map_render_jobs job
               JOIN app.data_objects output
                 ON output.organization_id = job.organization_id
                AND output.id = job.output_object_id
               WHERE job.organization_id = %s AND job.resource_id = %s
                 AND job.project_id = %s AND job.request_checksum_sha256 = %s
                 AND job.state = 'completed' AND job.composition_sealed
                 AND job.output_object_id IS NOT NULL
                 AND output.content_type = 'image/png' AND output.size_bytes > 0
                 AND (SELECT jsonb_agg(jsonb_build_object(
                   'position', pin.position, 'resourceId', pin.source_resource_id,
                   'resourceVersionId', pin.source_resource_version_id,
                   'datasetId', pin.dataset_id, 'datasetVersionId', pin.dataset_version_id,
                   'objectId', pin.source_object_id, 'storageVersion', pin.source_s3_version_id,
                   'checksumSha256', pin.source_checksum_sha256) ORDER BY pin.position)
                   FROM app.map_render_job_source_pins pin
                   WHERE pin.organization_id = job.organization_id AND pin.render_job_id = job.id)
                   = %s::jsonb
               ORDER BY job.finished_at DESC, job.id DESC LIMIT 1""",
            (context.organization_id, resource_id, project_id, checksum, Jsonb(expected_pins)),
        )
        if reusable is not None:
            job = await repository._load_job(
                transaction, context, project_id, resource_id, cast(UUID, reusable[0])
            )
            await repository._require_composition_access(
                transaction, context, project_id, job.job_id, Action.RENDER_READ
            )
            await transaction.execute(
                """INSERT INTO app.saved_map_render_reuse
                   (organization_id, idempotency_key, render_job_id, created_by)
                   VALUES (%s, %s, %s, %s)""",
                (context.organization_id, request.idempotency_key, job.job_id, context.user_id),
            )
            return RenderSubmission(job, False)
        job_id = uuid4()
        identities: dict[str, SavedMapStyleIdentity] = {}
        for index, layer in enumerate(recipe.layers, 1):
            style_id, style_version_id = uuid4(), uuid4()
            identities[layer.layer_id] = SavedMapStyleIdentity(style_id, style_version_id, 1)
            await transaction.execute(
                """INSERT INTO app.governed_resource_styles
                   (id, organization_id, project_id, resource_id, slug, format,
                    current_version_id, created_by, updated_by)
                   VALUES (%s, %s, %s, %s, %s, 'maplibre', %s, %s, %s)""",
                (
                    style_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    f"saved-map-{job_id}-{index}",
                    style_version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """INSERT INTO app.governed_resource_style_versions
                   (id, organization_id, style_id, version_number, title, media_type,
                    definition, checksum_sha256, change_message, created_by)
                   VALUES (%s, %s, %s, 1, %s, 'application/json', %s, %s, %s, %s)""",
                (
                    style_version_id,
                    context.organization_id,
                    style_id,
                    layer.title[:300],
                    layer.maplibre_style_json,
                    layer.style_checksum_sha256,
                    f"Saved map v{request.expected_map_version} image",
                    context.user_id,
                ),
            )
        profiles: list[tuple[UUID, UUID]] = []
        for render_pass in passes:
            identity = identities[render_pass.layer_id]
            bound = bind_saved_map_pass(render_pass, identity)
            assert bound.configuration_json is not None
            assert bound.configuration_checksum_sha256 is not None
            profile_id, profile_version_id = uuid4(), uuid4()
            profiles.append((profile_id, profile_version_id))
            await transaction.execute(
                """INSERT INTO app.map_render_profiles
                   (id, organization_id, project_id, resource_id, slug,
                    current_version_id, created_by, updated_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    profile_id,
                    context.organization_id,
                    project_id,
                    resource_id,
                    f"saved-map-{job_id}-{render_pass.position}",
                    profile_version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await transaction.execute(
                """INSERT INTO app.map_render_profile_versions
                   (id, organization_id, profile_id, resource_id, resource_version_id,
                    dataset_id, dataset_version_id, style_id, style_version_id,
                    version_number, title, configuration, checksum_sha256, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 1, %s, %s, %s, %s)""",
                (
                    profile_version_id,
                    context.organization_id,
                    profile_id,
                    resource_id,
                    resource_version_id,
                    bound.dataset_id,
                    bound.dataset_version_id,
                    identity.style_id,
                    identity.style_version_id,
                    bound.layer_title[:300],
                    Jsonb(json.loads(bound.configuration_json)),
                    bound.configuration_checksum_sha256,
                    context.user_id,
                ),
            )
        await transaction.execute(
            """INSERT INTO app.map_render_jobs
               (id, organization_id, project_id, resource_id, profile_id, profile_version_id,
                idempotency_key, bbox, crs, width, height, format, background_color,
                transparent, request_checksum_sha256, composition_sealed, created_by, request_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'EPSG:3857', %s, %s, 'png',
                       %s, false, %s, false, %s, %s)""",
            (
                job_id,
                context.organization_id,
                project_id,
                resource_id,
                *profiles[0],
                request.idempotency_key,
                Jsonb(bbox),
                request.width,
                request.height,
                recipe.background_color,
                checksum,
                context.user_id,
                request_id,
            ),
        )
        await transaction.execute(
            """INSERT INTO app.map_render_job_bindings
               (organization_id, render_job_id, resource_id, resource_version_id,
                recipe, recipe_checksum_sha256, definition_checksum_sha256)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                context.organization_id,
                job_id,
                resource_id,
                resource_version_id,
                Jsonb(json.loads(recipe.canonical_json)),
                recipe.checksum_sha256,
                recipe.definition_checksum_sha256,
            ),
        )
        for position, (profile_id, profile_version_id) in enumerate(profiles[1:], 2):
            await transaction.execute(
                """INSERT INTO app.map_render_job_layers
                   (organization_id, render_job_id, position, resource_id, profile_id,
                    profile_version_id) VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    context.organization_id,
                    job_id,
                    position,
                    resource_id,
                    profile_id,
                    profile_version_id,
                ),
            )
        for render_pass in passes:
            source = sources[render_pass.layer_id]
            await transaction.execute(
                """INSERT INTO app.map_render_job_source_pins
                   (organization_id, render_job_id, position, source_resource_id,
                    source_resource_version_id, dataset_id, dataset_version_id,
                    source_object_id, source_s3_version_id, source_checksum_sha256)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    context.organization_id,
                    job_id,
                    render_pass.position,
                    source.resource_id,
                    source.resource_version_id,
                    render_pass.dataset_id,
                    render_pass.dataset_version_id,
                    source.object_id,
                    source.s3_version_id,
                    source.checksum_sha256,
                ),
            )
        sealed = await transaction.fetch_one(
            "SELECT app.seal_map_render_composition(%s)", (job_id,)
        )
        if sealed is None or sealed[0] is not True:
            raise RenderConflict("render_composition_invalid")
        await repository._event(
            transaction,
            context,
            project_id,
            resource_id,
            "map.saved.render.queued",
            request_id,
            {
                "render_job_id": str(job_id),
                "map_version": request.expected_map_version,
                "resource_version": request.expected_resource_version,
                "recipe_checksum_sha256": recipe.checksum_sha256,
                "pass_count": len(passes),
            },
        )
        return RenderSubmission(
            await repository._load_job(transaction, context, project_id, resource_id, job_id), True
        )

    return await repository._run(context, operation)


@dataclass(frozen=True, slots=True)
class _Source:
    resource_id: UUID
    resource_version_id: UUID
    object_id: UUID
    s3_version_id: str
    checksum_sha256: str


async def _resolve_source(
    repository: PostgresRenderRepository,
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    layer: SavedMapRenderLayer,
) -> _Source:
    row = await transaction.fetch_one(
        """
        SELECT resource.id, resource.current_version_id, object.id,
               object.s3_version_id, object.checksum_sha256
        FROM app.project_datasets attached
        JOIN app.datasets dataset
          ON dataset.organization_id = attached.organization_id AND dataset.id = attached.dataset_id
        JOIN app.dataset_versions version
          ON version.organization_id = dataset.organization_id AND version.dataset_id = dataset.id
        JOIN app.governed_resources resource
          ON resource.organization_id = attached.organization_id
         AND resource.project_id = attached.project_id AND resource.dataset_id = dataset.id
         AND resource.kind = 'dataset' AND resource.state <> 'archived'
        JOIN app.dataset_version_objects link
          ON link.organization_id = version.organization_id AND link.dataset_id = version.dataset_id
         AND link.dataset_version_id = version.id
        JOIN app.data_objects object
          ON object.organization_id = link.organization_id AND object.dataset_id = link.dataset_id
         AND object.id = link.data_object_id
        WHERE attached.organization_id = %s AND attached.project_id = %s
          AND dataset.id = %s AND version.id = %s AND version.version_number = %s
          AND dataset.status = 'active' AND version.state = 'active'
          AND object.role = 'derived' AND object.content_type = 'application/geo+json'
          AND object.size_bytes BETWEEN 1 AND 16777216
          AND object.object_key LIKE '%%/derivatives/preview/preview.geojson'
          AND (%s::uuid IS NULL OR object.id = %s::uuid)
        ORDER BY resource.created_at, resource.id, object.id LIMIT 1
        FOR SHARE OF resource, dataset
        """,
        (
            context.organization_id,
            project_id,
            layer.dataset_id,
            layer.dataset_version_id,
            layer.dataset_version_number,
            layer.object_id,
            layer.object_id,
        ),
    )
    if row is None:
        raise SavedMapRenderUnsupported(
            "saved_map_source_unavailable",
            f"Add metadata and a ready preview for the saved dataset revision: {layer.title}.",
            layer_id=layer.layer_id,
        )
    repository._require(
        Action.RESOURCE_READ,
        await repository._resource_roles(transaction, context, project_id, cast(UUID, row[0])),
    )
    try:
        dataset_roles = await PostgresCatalogRepository._access(
            transaction, context, project_id, layer.dataset_id
        )
    except CatalogNotFound as error:
        raise RenderNotFound("dataset") from error
    repository._require(Action.DATASET_READ, dataset_roles)
    return _Source(
        cast(UUID, row[0]),
        cast(UUID, row[1]),
        cast(UUID, row[2]),
        cast(str, row[3]),
        cast(str, row[4]),
    )
