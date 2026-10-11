"""Turn a sealed saved-map recipe into ordered, explicitly bound worker passes."""

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from hashlib import sha256
from typing import Any, Literal
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.maplibre_render import compile_maplibre_render_configuration
from opengeo_api.render_runtime import PINNED_GL_RENDERER, RenderRuntimeReference
from opengeo_api.saved_map_rendering import (
    MAX_SAVED_MAP_RENDER_PASSES,
    SAVED_MAP_RENDER_SCHEMA_VERSION,
    SavedMapRenderRecipe,
    SavedMapRenderUnsupported,
)

SAVED_MAP_PASS_SCHEMA = "opengeo.saved-map-pass.1.0.0"


@dataclass(frozen=True, slots=True)
class SavedMapStyleIdentity:
    style_id: UUID
    style_version_id: UUID
    version_number: int


@dataclass(frozen=True, slots=True)
class SavedMapRenderPass:
    position: int
    pass_count: int
    layer_id: str
    layer_title: str
    layer_order: int
    dataset_id: UUID
    dataset_version_id: UUID
    dataset_version_number: int
    object_id: UUID | None
    geometry_layer_id: str
    source_geometry_type: str
    input_geometry: Literal["native", "polygon-boundary"]
    maplibre_style_json: str
    style_checksum_sha256: str
    recipe_checksum_sha256: str
    definition_checksum_sha256: str
    background_color: str
    configuration_json: str | None = None
    configuration_checksum_sha256: str | None = None
    renderer: str = "opengeo.deterministic-svg.v2"
    map_view_json: str | None = None
    runtime_reference: RenderRuntimeReference | None = None


def compile_saved_map_passes(
    recipe: SavedMapRenderRecipe,
    *,
    style_bindings: Mapping[str, SavedMapStyleIdentity] | None = None,
    runtime_reference: RenderRuntimeReference | None = None,
) -> tuple[SavedMapRenderPass, ...]:
    """Preflight all passes, then optionally bind each to a real stored style.

    Unbound passes have no configuration or configuration checksum and cannot
    become worker claims. Call ``bind_saved_map_pass`` after storing the exact
    detached layer style, or supply a complete layer-ID mapping here.
    """
    _verify_recipe(recipe)
    if style_bindings is not None and set(style_bindings) != {
        layer.layer_id for layer in recipe.layers
    }:
        raise SavedMapRenderUnsupported(
            "saved_map_style_binding_mismatch", "Bind the exact style for every saved layer."
        )
    if any(
        json.loads(layer.maplibre_style_json).get("metadata", {}).get("opengeo:font")
        or json.loads(layer.maplibre_style_json).get("metadata", {}).get("opengeo:patterns")
        or any(
            any(key.endswith("-layer-opacity") for key in part.get("paint", {}))
            or part.get("filter") is not None
            or part.get("metadata", {}).get("opengeo:drawOrder") == "above-data"
            for part in json.loads(layer.maplibre_style_json)["layers"]
        )
        for layer in recipe.layers
    ):
        from opengeo_api.saved_map_gl_passes import compile_gl_occurrences

        return compile_gl_occurrences(
            recipe, style_bindings=style_bindings, runtime_reference=runtime_reference
        )
    count = sum(len(layer.geometry_layer_ids) for layer in recipe.layers)
    if not 1 <= count <= MAX_SAVED_MAP_RENDER_PASSES:
        raise SavedMapRenderUnsupported(
            "saved_map_pass_limit", "Render between 1 and 16 saved geometry passes."
        )
    passes: list[SavedMapRenderPass] = []
    for layer in recipe.layers:
        if layer.label_layer_id is not None:
            raise SavedMapRenderUnsupported(
                "saved_map_labels_worker_unsupported",
                "Choose a publication font for these labels and save a new map revision, "
                "or disable labels for the existing renderer.",
                layer_id=layer.layer_id,
            )
        style = json.loads(layer.maplibre_style_json)
        parts = {part["id"]: part for part in style["layers"]}
        if tuple(parts) != layer.geometry_layer_ids:
            raise SavedMapRenderUnsupported(
                "saved_map_pass_mismatch", "Recompile every saved geometry pass before rendering."
            )
        for geometry_id in layer.geometry_layer_ids:
            boundary = (
                layer.geometry_type in {"Polygon", "MultiPolygon"}
                and parts[geometry_id]["type"] == "line"
            )
            render_pass = SavedMapRenderPass(
                position=len(passes) + 1,
                pass_count=count,
                layer_id=layer.layer_id,
                layer_title=layer.title,
                layer_order=layer.order,
                dataset_id=layer.dataset_id,
                dataset_version_id=layer.dataset_version_id,
                dataset_version_number=layer.dataset_version_number,
                object_id=layer.object_id,
                geometry_layer_id=geometry_id,
                source_geometry_type=layer.geometry_type,
                input_geometry="polygon-boundary" if boundary else "native",
                maplibre_style_json=layer.maplibre_style_json,
                style_checksum_sha256=layer.style_checksum_sha256,
                recipe_checksum_sha256=recipe.checksum_sha256,
                definition_checksum_sha256=recipe.definition_checksum_sha256,
                background_color=recipe.background_color,
            )
            if style_bindings is not None:
                render_pass = bind_saved_map_pass(render_pass, style_bindings[layer.layer_id])
            passes.append(render_pass)
    return tuple(passes)


def bind_saved_map_pass(
    render_pass: SavedMapRenderPass, identity: SavedMapStyleIdentity
) -> SavedMapRenderPass:
    """Compile one pass with the identities of its exact persisted MapLibre style.

    The caller must verify that these stored identities hold the style bytes in
    ``maplibre_style_json``; this pure function confers no database authority.
    The worker configuration uses the existing renderer's JSON serialization for
    its checksum, which intentionally differs from the recipe's canonical JSON.
    """
    if (
        not isinstance(identity.style_id, UUID)
        or not isinstance(identity.style_version_id, UUID)
        or isinstance(identity.version_number, bool)
        or not isinstance(identity.version_number, int)
        or identity.version_number < 1
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_style_binding_invalid", "Use the actual stored style UUIDs and version."
        )
    if render_pass.renderer in ("opengeo.maplibre-gl-js.v1", PINNED_GL_RENDERER):
        from opengeo_api.saved_map_gl_passes import bind_gl_occurrence

        return bind_gl_occurrence(render_pass, identity)
    if render_pass.renderer != "opengeo.deterministic-svg.v2":
        raise SavedMapRenderUnsupported(
            "saved_map_renderer_unsupported", "Use a supported saved-map renderer."
        )
    configuration, _checksum = compile_maplibre_render_configuration(
        render_pass.maplibre_style_json,
        style_id=str(identity.style_id),
        style_version_id=str(identity.style_version_id),
        style_version_number=identity.version_number,
        style_checksum_sha256=render_pass.style_checksum_sha256,
        geometry_layer_id=render_pass.geometry_layer_id,
        label_layer_id=None,
        minimum_scale_denominator=None,
        maximum_scale_denominator=None,
        include_legend=False,
    )
    configuration["background"] = render_pass.background_color
    if configuration["geometry"]["type"] == "fill":
        # The saved outline is a separate later pass, never the compiler's
        # implicit fixed-width, fully opaque polygon stroke.
        configuration["geometry"]["outline_color"] = "#00000000"
        configuration["geometry"]["outline_width"] = 0.0
    configuration["saved_map"] = {
        "schema": SAVED_MAP_PASS_SCHEMA,
        "recipe_checksum_sha256": render_pass.recipe_checksum_sha256,
        "definition_checksum_sha256": render_pass.definition_checksum_sha256,
        "style_checksum_sha256": render_pass.style_checksum_sha256,
        "layer_id": render_pass.layer_id,
        "geometry_layer_id": render_pass.geometry_layer_id,
        "source_geometry_type": render_pass.source_geometry_type,
        "input_geometry": render_pass.input_geometry,
        "position": render_pass.position,
        "pass_count": render_pass.pass_count,
        "dataset_id": str(render_pass.dataset_id),
        "dataset_version_id": str(render_pass.dataset_version_id),
    }
    # Every ignored geometry selector is carried by another required pass.
    configuration["conversion"]["status"] = "saved_map_geometry_pass"
    encoded = json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) > 32_768:
        raise SavedMapRenderUnsupported(
            "saved_map_pass_too_large", "Reduce this render pass to at most 32 KiB."
        )
    return replace(
        render_pass,
        configuration_json=encoded.decode(),
        configuration_checksum_sha256=sha256(encoded).hexdigest(),
    )


def _verify_recipe(recipe: SavedMapRenderRecipe) -> None:
    expected: dict[str, Any] = {
        "schemaVersion": recipe.schema_version,
        "definitionChecksumSha256": recipe.definition_checksum_sha256,
        "backgroundColor": recipe.background_color,
        "mapView": json.loads(recipe.map_view_json) if recipe.map_view_json else None,
        "omittedLayerIds": list(recipe.omitted_layer_ids),
        "omittedBasemapIds": list(recipe.omitted_basemap_ids),
        "layers": [
            {
                "layerId": layer.layer_id,
                "title": layer.title,
                "order": layer.order,
                "datasetId": str(layer.dataset_id),
                "datasetVersionId": str(layer.dataset_version_id),
                "datasetVersionNumber": layer.dataset_version_number,
                "objectId": str(layer.object_id) if layer.object_id else None,
                "geometryType": layer.geometry_type,
                "maplibreStyle": json.loads(layer.maplibre_style_json),
                "styleChecksumSha256": layer.style_checksum_sha256,
                "geometryLayerIds": list(layer.geometry_layer_ids),
                "labelLayerId": layer.label_layer_id,
            }
            for layer in recipe.layers
        ],
    }
    encoded = canonical_json_bytes(expected)
    if (
        recipe.schema_version != SAVED_MAP_RENDER_SCHEMA_VERSION
        or encoded.decode() != recipe.canonical_json
        or sha256(encoded).hexdigest() != recipe.checksum_sha256
        or any(
            sha256(layer.maplibre_style_json.encode()).hexdigest() != layer.style_checksum_sha256
            for layer in recipe.layers
        )
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_recipe_checksum_mismatch",
            "Recompile the exact saved map recipe before rendering.",
        )
