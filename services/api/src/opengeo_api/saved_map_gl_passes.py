"""Bind whole saved-layer occurrences for shared MapLibre collision/layout."""

import json
from collections.abc import Mapping
from dataclasses import replace
from hashlib import sha256

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.render_fonts import resolve_render_font
from opengeo_api.render_runtime import PINNED_GL_RENDERER, RenderRuntimeReference
from opengeo_api.saved_map_render_passes import (
    SavedMapRenderPass,
    SavedMapStyleIdentity,
    bind_saved_map_pass,
)
from opengeo_api.saved_map_rendering import SavedMapRenderRecipe, SavedMapRenderUnsupported

SAVED_MAP_GL_RENDERER = "opengeo.maplibre-gl-js.v1"
SAVED_MAP_GL_OCCURRENCE_SCHEMA = "opengeo.saved-map-gl-occurrence.1.0.0"


def compile_gl_occurrences(
    recipe: SavedMapRenderRecipe,
    *,
    style_bindings: Mapping[str, SavedMapStyleIdentity] | None = None,
    runtime_reference: RenderRuntimeReference | None = None,
) -> tuple[SavedMapRenderPass, ...]:
    if recipe.map_view_json is None:
        raise SavedMapRenderUnsupported(
            "saved_map_view_required", "Save the map's viewing position before creating its image."
        )
    saved_view = json.loads(recipe.map_view_json)
    view = {
        "center": saved_view["center"],
        "zoom": saved_view["zoom"],
        "bearing": 0,
        "pitch": 0,
    }
    occurrences = []
    for position, layer in enumerate(recipe.layers, 1):
        style = json.loads(layer.maplibre_style_json)
        font_ref = style.get("metadata", {}).get("opengeo:font")
        if layer.label_layer_id is not None:
            if font_ref is None:
                raise SavedMapRenderUnsupported(
                    "saved_map_font_unpinned",
                    "Choose a publication font for every enabled label "
                    "and save a new map revision.",
                    layer_id=layer.layer_id,
                )
            try:
                stack = resolve_render_font(font_ref)
            except ValueError as error:
                raise SavedMapRenderUnsupported(
                    "saved_map_font_unavailable", str(error), layer_id=layer.layer_id
                ) from error
            label = style["layers"][-1]
            if (
                label["id"] != layer.label_layer_id
                or label["type"] != "symbol"
                or label["layout"]["text-font"] != [stack]
            ):
                raise SavedMapRenderUnsupported(
                    "saved_map_font_mismatch", "Use the exact saved label font and style."
                )
        if tuple(part["id"] for part in style["layers"]) != layer.geometry_layer_ids + (
            (layer.label_layer_id,) if layer.label_layer_id is not None else ()
        ):
            raise SavedMapRenderUnsupported(
                "saved_map_pass_mismatch", "Preserve every geometry and label in saved order."
            )
        occurrence = SavedMapRenderPass(
            position=position,
            pass_count=len(recipe.layers),
            layer_id=layer.layer_id,
            layer_title=layer.title,
            layer_order=layer.order,
            dataset_id=layer.dataset_id,
            dataset_version_id=layer.dataset_version_id,
            dataset_version_number=layer.dataset_version_number,
            object_id=layer.object_id,
            geometry_layer_id=layer.geometry_layer_ids[0],
            source_geometry_type=layer.geometry_type,
            input_geometry="native",
            maplibre_style_json=layer.maplibre_style_json,
            style_checksum_sha256=layer.style_checksum_sha256,
            recipe_checksum_sha256=recipe.checksum_sha256,
            definition_checksum_sha256=recipe.definition_checksum_sha256,
            background_color=recipe.background_color,
            renderer=PINNED_GL_RENDERER if runtime_reference is not None else SAVED_MAP_GL_RENDERER,
            map_view_json=canonical_json_bytes(view).decode(),
            runtime_reference=runtime_reference,
        )
        if style_bindings is not None:
            occurrence = bind_saved_map_pass(occurrence, style_bindings[layer.layer_id])
        occurrences.append(occurrence)
    return tuple(occurrences)


def bind_gl_occurrence(
    occurrence: SavedMapRenderPass, identity: SavedMapStyleIdentity
) -> SavedMapRenderPass:
    style = json.loads(occurrence.maplibre_style_json)
    if sha256(canonical_json_bytes(style)).hexdigest() != occurrence.style_checksum_sha256:
        raise SavedMapRenderUnsupported(
            "saved_map_style_checksum_mismatch", "Use the exact sealed saved-layer style."
        )
    if occurrence.map_view_json is None:
        raise SavedMapRenderUnsupported(
            "saved_map_view_required", "Save the map's viewing position."
        )
    configuration = {
        "renderer": occurrence.renderer,
        "schema_version": "1.0.0",
        "output_crs": "EPSG:4326",
        "background": occurrence.background_color,
        "source_style": {
            "style_id": str(identity.style_id),
            "style_version_id": str(identity.style_version_id),
            "style_version_number": identity.version_number,
            "style_checksum_sha256": occurrence.style_checksum_sha256,
        },
        "saved_map": {
            "schema": SAVED_MAP_GL_OCCURRENCE_SCHEMA,
            "recipe_checksum_sha256": occurrence.recipe_checksum_sha256,
            "definition_checksum_sha256": occurrence.definition_checksum_sha256,
            "style_checksum_sha256": occurrence.style_checksum_sha256,
            "layer_id": occurrence.layer_id,
            "source_geometry_type": occurrence.source_geometry_type,
            "position": occurrence.position,
            "pass_count": occurrence.pass_count,
            "dataset_id": str(occurrence.dataset_id),
            "dataset_version_id": str(occurrence.dataset_version_id),
        },
        "map_view": json.loads(occurrence.map_view_json),
        "maplibre_style": style,
        "font_ref": style.get("metadata", {}).get("opengeo:font"),
    }
    if occurrence.renderer == PINNED_GL_RENDERER:
        if not isinstance(occurrence.runtime_reference, RenderRuntimeReference):
            raise SavedMapRenderUnsupported(
                "saved_map_runtime_unpinned", "Use the deployment's exact rendering runtime."
            )
        configuration["runtime_ref"] = occurrence.runtime_reference.as_dict()
    elif occurrence.runtime_reference is not None:
        raise SavedMapRenderUnsupported(
            "saved_map_runtime_mismatch", "Do not add a runtime identity to a legacy render."
        )
    encoded = json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) > 32_768:
        raise SavedMapRenderUnsupported(
            "saved_map_pass_too_large", "Reduce the saved-layer rendering configuration to 32 KiB."
        )
    return replace(
        occurrence,
        configuration_json=encoded.decode(),
        configuration_checksum_sha256=sha256(encoded).hexdigest(),
    )
