"""Revalidate a saved-map image and every source before private or public reads."""

import json
from hashlib import sha256
from typing import Any, cast
from uuid import UUID

from opengeo_api.authorization import Action
from opengeo_api.catalog import CatalogNotFound, PostgresCatalogRepository
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.render_runtime import PINNED_GL_RENDERER, RenderRuntimeReference
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict, RenderNotFound
from opengeo_api.saved_map_render_passes import (
    SavedMapStyleIdentity,
    bind_saved_map_pass,
    compile_saved_map_passes,
)
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported, compile_saved_map
from opengeo_api.saved_map_style_resolution import resolve_saved_map_styles
from opengeo_api.tenant_database import TenantContext, TenantTransaction

# The same allowlist governs page/reference publication. A public source is not
# inferred from its URL, a map's visibility, or a dataset's title.
PUBLIC_SAVED_MAP_LICENSES = frozenset({"CC-BY-4.0", "CC0-1.0", "PDDL-1.0"})


async def load_saved_map_seal(
    transaction: TenantTransaction,
    context: TenantContext,
    project_id: UUID,
    resource_id: UUID,
    resource_version_id: UUID,
    job_id: UUID,
    *,
    public: bool,
    repository: PostgresRenderRepository | None = None,
) -> dict[str, Any]:
    binding = await transaction.fetch_one(
        """
        SELECT revision.map_id, revision.map_version, binding.recipe,
               binding.recipe_checksum_sha256, binding.definition_checksum_sha256,
               history.definition
        FROM app.map_render_job_bindings binding
        JOIN app.map_render_jobs job
          ON job.organization_id = binding.organization_id AND job.id = binding.render_job_id
         AND job.resource_id = binding.resource_id AND job.composition_sealed
        JOIN app.map_resource_version_bindings revision
          ON revision.organization_id = binding.organization_id
         AND revision.resource_id = binding.resource_id
         AND revision.resource_version_id = binding.resource_version_id
        JOIN app.maps map
          ON map.organization_id = revision.organization_id AND map.project_id = revision.project_id
         AND map.id = revision.map_id AND map.status = 'active'
        JOIN app.map_versions history
          ON history.organization_id = revision.organization_id AND history.map_id = revision.map_id
         AND history.version = revision.map_version
        WHERE binding.organization_id = %s AND job.project_id = %s
          AND binding.resource_id = %s AND binding.resource_version_id = %s
          AND binding.render_job_id = %s
        """,
        (context.organization_id, project_id, resource_id, resource_version_id, job_id),
    )
    if binding is None:
        raise RenderConflict("saved_map_binding_unavailable")
    definition = cast(dict[str, Any], binding[5])
    style_dependencies = [
        {
            "layerId": layer["layerId"],
            "datasetId": layer["datasetId"],
            "reference": layer["styleReference"],
        }
        for layer in definition.get("layers", [])
        if "styleReference" in layer
    ]
    # Public distribution requires its own Style rights/audience contract. A
    # successful requesting-user lookup cannot authorize an anonymous edition.
    if style_dependencies and public:
        raise RenderConflict("saved_map_style_publication_unsupported")
    if style_dependencies and repository is None:
        raise RenderNotFound("resource")
    try:
        resolved_styles = await resolve_saved_map_styles(transaction, context, definition)
        recipe = compile_saved_map(definition, resolved_styles=resolved_styles)
        passes = compile_saved_map_passes(recipe)
        if (
            recipe.checksum_sha256 != binding[3]
            or recipe.definition_checksum_sha256 != binding[4]
            or recipe.canonical_json != canonical_json_bytes(binding[2]).decode()
        ):
            raise RenderConflict("saved_map_recipe_changed")
    except SavedMapRenderUnsupported as error:
        code = (
            "saved_map_style_unavailable"
            if error.code == "saved_map_style_unavailable"
            else "saved_map_recipe_changed"
        )
        raise RenderConflict(code) from error
    except (TypeError, ValueError) as error:
        raise RenderConflict("saved_map_recipe_changed") from error

    rows = await transaction.fetch_all(
        """
        SELECT pin.position, pin.source_resource_id, pin.source_resource_version_id,
               pin.dataset_id, pin.dataset_version_id, pin.source_object_id,
               pin.source_s3_version_id, pin.source_checksum_sha256,
               resource.state::text, resource.visibility::text,
               metadata.license, metadata.attribution, dataset.classification::text,
               profile.configuration, profile.checksum_sha256,
               profile.style_id, profile.style_version_id, style.version_number,
               style.definition, style.checksum_sha256, version.version_number,
               object.size_bytes, object.content_type
        FROM app.map_render_job_source_pins pin
        JOIN app.map_render_job_layers layer
          ON layer.organization_id = pin.organization_id AND layer.render_job_id = pin.render_job_id
         AND layer.position = pin.position
        JOIN app.map_render_profile_versions profile
          ON profile.organization_id = layer.organization_id
         AND profile.profile_id = layer.profile_id
         AND profile.id = layer.profile_version_id AND profile.resource_id = %s
         AND profile.resource_version_id = %s
         AND profile.dataset_id = pin.dataset_id
         AND profile.dataset_version_id = pin.dataset_version_id
        JOIN app.governed_resource_style_versions style
          ON style.organization_id = profile.organization_id AND style.style_id = profile.style_id
         AND style.id = profile.style_version_id
        JOIN app.governed_resources resource
          ON resource.organization_id = pin.organization_id AND resource.project_id = %s
         AND resource.id = pin.source_resource_id AND resource.dataset_id = pin.dataset_id
         AND resource.kind = 'dataset' AND resource.state <> 'archived'
        JOIN app.governed_resource_versions metadata
          ON metadata.organization_id = resource.organization_id
         AND metadata.resource_id = resource.id
         AND metadata.id = pin.source_resource_version_id
        JOIN app.project_datasets attached
          ON attached.organization_id = pin.organization_id
         AND attached.project_id = resource.project_id
         AND attached.dataset_id = pin.dataset_id
        JOIN app.datasets dataset
          ON dataset.organization_id = pin.organization_id AND dataset.id = pin.dataset_id
         AND dataset.status = 'active'
        JOIN app.dataset_versions version
          ON version.organization_id = pin.organization_id AND version.dataset_id = pin.dataset_id
         AND version.id = pin.dataset_version_id AND version.state = 'active'
        JOIN app.dataset_version_objects link
          ON link.organization_id = pin.organization_id AND link.dataset_id = pin.dataset_id
         AND link.dataset_version_id = pin.dataset_version_id
         AND link.data_object_id = pin.source_object_id
        JOIN app.data_objects object
          ON object.organization_id = pin.organization_id AND object.dataset_id = pin.dataset_id
         AND object.id = pin.source_object_id AND object.s3_version_id = pin.source_s3_version_id
         AND object.checksum_sha256 = pin.source_checksum_sha256
         AND object.role = 'derived' AND object.content_type = 'application/geo+json'
         AND object.size_bytes BETWEEN 1 AND 16777216
         AND object.object_key LIKE '%%/derivatives/preview/preview.geojson'
        WHERE pin.organization_id = %s AND pin.render_job_id = %s
        ORDER BY pin.position
        """,
        (resource_id, resource_version_id, project_id, context.organization_id, job_id),
    )
    if len(rows) != len(passes):
        raise RenderConflict("saved_map_sources_unavailable")
    # Reconstruct from the immutable job configuration, never today's operator
    # default. Older completed editions retain their original runtime identity.
    runtime_reference = None
    if rows and isinstance(rows[0][13], dict) and rows[0][13].get("renderer") == PINNED_GL_RENDERER:
        try:
            runtime_reference = RenderRuntimeReference.parse(rows[0][13].get("runtime_ref"))
            passes = compile_saved_map_passes(recipe, runtime_reference=runtime_reference)
        except (SavedMapRenderUnsupported, ValueError, TypeError) as error:
            raise RenderConflict("saved_map_presentation_changed") from error
    sources: list[dict[str, Any]] = []
    checked_resources: set[UUID] = set()
    checked_datasets: set[UUID] = set()
    for row, render_pass in zip(rows, passes, strict=True):
        if (
            row[0] != render_pass.position
            or row[3] != render_pass.dataset_id
            or row[4] != render_pass.dataset_version_id
            or row[20] != render_pass.dataset_version_number
            or (render_pass.object_id is not None and row[5] != render_pass.object_id)
            or row[18] != render_pass.maplibre_style_json
            or row[19] != render_pass.style_checksum_sha256
        ):
            raise RenderConflict("saved_map_sources_changed")
        bound = bind_saved_map_pass(
            render_pass,
            SavedMapStyleIdentity(
                cast(UUID, row[15]),
                cast(UUID, row[16]),
                cast(int, row[17]),
            ),
        )
        configuration_bytes = json.dumps(row[13], sort_keys=True, separators=(",", ":")).encode()
        if (
            bound.configuration_checksum_sha256 != row[14]
            or bound.configuration_json != configuration_bytes.decode()
            or sha256(configuration_bytes).hexdigest() != row[14]
        ):
            raise RenderConflict("saved_map_presentation_changed")
        source_resource_id = cast(UUID, row[1])
        if public:
            if (
                row[8] != "published"
                or row[9] != "public"
                or row[12] != "public"
                or row[10] not in PUBLIC_SAVED_MAP_LICENSES
                or not isinstance(row[11], str)
                or not row[11].strip()
            ):
                raise RenderConflict("saved_map_source_not_public")
        else:
            if repository is None:
                raise RenderNotFound("resource")
            if source_resource_id not in checked_resources:
                repository._require(
                    Action.RESOURCE_READ,
                    await repository._resource_roles(
                        transaction, context, project_id, source_resource_id
                    ),
                )
                checked_resources.add(source_resource_id)
            if render_pass.dataset_id not in checked_datasets:
                try:
                    dataset_roles = await PostgresCatalogRepository._access(
                        transaction, context, project_id, render_pass.dataset_id
                    )
                except CatalogNotFound as error:
                    raise RenderNotFound("dataset") from error
                repository._require(Action.DATASET_READ, dataset_roles)
                checked_datasets.add(render_pass.dataset_id)
        sources.append(
            {
                "position": row[0],
                "layerId": render_pass.layer_id,
                "resourceId": str(source_resource_id),
                "resourceVersionId": str(row[2]),
                "datasetId": str(row[3]),
                "datasetVersionId": str(row[4]),
                "objectId": str(row[5]),
                "checksumSha256": row[7],
                "sizeBytes": row[21],
                "contentType": row[22],
                "configurationChecksumSha256": row[14],
                "attribution": row[11],
                "license": row[10],
            }
        )
    return {
        "schemaVersion": "opengeo.saved-map-publication.1.0.0",
        "mapId": str(binding[0]),
        "mapVersion": binding[1],
        "resourceVersionId": str(resource_version_id),
        "recipeChecksumSha256": binding[3],
        "definitionChecksumSha256": binding[4],
        **(
            {"runtimeReference": runtime_reference.as_dict()}
            if runtime_reference is not None
            else {}
        ),
        "sources": sources,
        **({"styleDependencies": style_dependencies} if style_dependencies else {}),
    }
