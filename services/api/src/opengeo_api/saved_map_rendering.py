"""Compile persisted map presentation without reading data or creating render jobs.

The recipe contains detached MapLibre styles, not worker-ready configurations.
In particular, consumers must preserve polygon fill/outline passes and label
placement; flattening them into the current single-symbol profile loses semantics.
Dataset and object UUIDs are provenance, not authorization or storage locators.
"""

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, NoReturn, cast
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.map_definitions import validate_map_definition
from opengeo_api.maplibre_render import (
    MapLibreRenderUnsupported,
    compile_maplibre_render_configuration,
)
from opengeo_api.render_fonts import resolve_render_font
from opengeo_api.resources import ResourceStyle

SAVED_MAP_RENDER_SCHEMA_VERSION = "opengeo.saved-map-render.1.0.0"
MAX_SAVED_MAP_RENDER_LAYERS = 16
MAX_SAVED_MAP_RENDER_PASSES = 16
MAX_SAVED_MAP_RECIPE_BYTES = 65_536
BLANK_MAP_BACKGROUND = "#061526"

_STYLE_FIELDS = frozenset(
    {
        "renderer",
        "fill",
        "stroke",
        "strokeWidth",
        "fillOpacityFactor",
        "circleColor",
        "circleRadius",
        "polygonMode",
        "categoryField",
        "graduated",
        "palette",
        "paletteName",
        "legendTitle",
    }
)
_LABEL_FIELDS = frozenset(
    {
        "enabled",
        "field",
        "size",
        "color",
        "haloColor",
        "haloWidth",
        "prefix",
        "suffix",
        "allowOverlap",
        "drawOrder",
        "fontRef",
    }
)
_GEOMETRIES = {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}


class SavedMapRenderUnsupported(ValueError):
    """A stable reason and an actionable explanation for the presentation owner."""

    def __init__(self, code: str, message: str, *, layer_id: str | None = None) -> None:
        self.code = code
        self.layer_id = layer_id
        self.message = message
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True, slots=True)
class SavedMapRenderLayer:
    layer_id: str
    title: str
    order: int
    dataset_id: UUID
    dataset_version_id: UUID
    dataset_version_number: int
    object_id: UUID | None
    geometry_type: str
    maplibre_style_json: str
    style_checksum_sha256: str
    geometry_layer_ids: tuple[str, ...]
    label_layer_id: str | None


@dataclass(frozen=True, slots=True)
class SavedMapRenderRecipe:
    schema_version: str
    definition_checksum_sha256: str
    checksum_sha256: str
    background_color: str
    map_view_json: str | None
    layers: tuple[SavedMapRenderLayer, ...]
    omitted_layer_ids: tuple[str, ...]
    omitted_basemap_ids: tuple[str, ...]
    canonical_json: str


def compile_saved_map(
    definition: dict[str, Any], *, resolved_styles: Mapping[str, ResourceStyle] | None = None
) -> SavedMapRenderRecipe:
    """Freeze an exact, bounded presentation in bottom-to-top drawing order.

    A saved map's lower ``order`` values appear on top in Studio. Equal-order
    occurrences use the reverse of stable input order, matching Studio's draw.
    Hidden layers remain in the definition seal but require no render input.
    """
    try:
        if not isinstance(definition, dict):
            raise ValueError("map definition must be an object")
        validate_map_definition(definition)
        if definition.get("schemaVersion") is None:
            raise ValueError("save an explicit supported map-definition version")
        definition_bytes = canonical_json_bytes(definition)
    except (TypeError, ValueError) as error:
        raise SavedMapRenderUnsupported(
            "saved_map_definition_invalid", f"Save a valid versioned map definition: {error}"
        ) from error

    if any(
        "styleReference" in layer and layer["layerId"] not in (resolved_styles or {})
        for layer in definition["layers"]
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_style_resolution_required",
            "Resolve and authorize the selected Style versions before compiling this map; "
            "inline styling is not a fallback.",
        )

    omitted_basemaps = _validate_presentation(definition)
    ordered = sorted(enumerate(definition["layers"]), key=lambda item: (item[1]["order"], item[0]))
    _require_saved_layer_order(
        [layer["layerId"] for _index, layer in ordered], definition.get("layerTree")
    )
    visible = [layer for _index, layer in reversed(ordered) if layer["visible"]]
    omitted = tuple(layer["layerId"] for layer in definition["layers"] if not layer["visible"])
    if not 1 <= len(visible) <= MAX_SAVED_MAP_RENDER_LAYERS:
        raise SavedMapRenderUnsupported(
            "saved_map_layer_limit", "Show between 1 and 16 governed vector layers for this render."
        )
    layers = tuple(
        _compile_layer(layer, position, (resolved_styles or {}).get(layer["layerId"]))
        for position, layer in enumerate(visible, 1)
    )
    uses_gl = any(
        json.loads(layer.maplibre_style_json).get("metadata", {}).get("opengeo:font")
        for layer in layers
    )
    if (
        not uses_gl
        and sum(len(layer.geometry_layer_ids) for layer in layers) > MAX_SAVED_MAP_RENDER_PASSES
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_pass_limit",
            "Use at most 16 geometry passes; filled polygons use separate fill and outline passes.",
        )
    definition_checksum = sha256(definition_bytes).hexdigest()
    view = definition["mapViews"][0] if definition["mapViews"] else None
    document = {
        "schemaVersion": SAVED_MAP_RENDER_SCHEMA_VERSION,
        "definitionChecksumSha256": definition_checksum,
        "backgroundColor": BLANK_MAP_BACKGROUND,
        "mapView": view,
        "omittedLayerIds": list(omitted),
        "omittedBasemapIds": list(omitted_basemaps),
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
            for layer in layers
        ],
    }
    encoded = canonical_json_bytes(document)
    if len(encoded) > MAX_SAVED_MAP_RECIPE_BYTES:
        raise SavedMapRenderUnsupported(
            "saved_map_recipe_too_large", "Reduce the saved map presentation to at most 64 KiB."
        )
    return SavedMapRenderRecipe(
        schema_version=SAVED_MAP_RENDER_SCHEMA_VERSION,
        definition_checksum_sha256=definition_checksum,
        checksum_sha256=sha256(encoded).hexdigest(),
        background_color=BLANK_MAP_BACKGROUND,
        map_view_json=canonical_json_bytes(view).decode() if view is not None else None,
        layers=layers,
        omitted_layer_ids=omitted,
        omitted_basemap_ids=omitted_basemaps,
        canonical_json=encoded.decode(),
    )


def _validate_presentation(definition: dict[str, Any]) -> tuple[str, ...]:
    if definition.get("projection") != "mercator" or (
        definition.get("spatialBody") is not None and definition["spatialBody"]["id"] != "earth"
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_projection_unsupported", "Save this render as a flat Earth Mercator map."
        )
    for key in ("terrain", "openScene3d"):
        value = definition.get(key)
        if value is not None and (
            not isinstance(value, dict) or value.get("enabled", False) is not False
        ):
            raise SavedMapRenderUnsupported(
                "saved_map_terrain_unsupported",
                f"Turn off {key} and save the flat map before rendering.",
            )
    if definition.get("measurements"):
        raise SavedMapRenderUnsupported(
            "saved_map_measurements_unsupported",
            "Remove saved measurement annotations from this render map.",
        )
    _reject_filters(definition)
    extensions = definition.get("extensions", {})
    if isinstance(extensions, dict):
        imagery = extensions.get("historicalImagery", {})
        if isinstance(imagery, dict) and (
            imagery.get("enabled")
            or (isinstance(imagery.get("sunlight"), dict) and imagery["sunlight"].get("enabled"))
        ):
            raise SavedMapRenderUnsupported(
                "saved_map_imagery_unsupported",
                "Turn off historical imagery and sunlight for this render.",
            )
    if definition["mapViews"]:
        view = definition["mapViews"][0]
        if (
            view.get("pitch", 0) != 0
            or view.get("bearing", 0) % 360 != 0
            or view.get("projection", "mercator") != "mercator"
            or not 0 <= view["zoom"] <= 22
            or abs(view["center"][1]) > 85.051129
        ):
            raise SavedMapRenderUnsupported(
                "saved_map_camera_unsupported",
                "Save a north-up, untilted Mercator view within zoom 0-22.",
            )
    visible = []
    omitted = []
    for basemap in definition["basemaps"]:
        if basemap.get("visible") is False:
            omitted.append(str(basemap.get("basemapId", "")))
        elif basemap.get("visible") is True:
            visible.append(basemap)
        else:
            raise SavedMapRenderUnsupported(
                "saved_map_basemap_visibility_invalid",
                "Save an explicit visible or hidden state for every background.",
            )
    if not visible:
        raise SavedMapRenderUnsupported(
            "saved_map_basemap_unpinned",
            "Select Blank canvas and save it; no selected background defaults to a live basemap.",
        )
    if any(
        basemap.get("kind") != "blank"
        or basemap.get("basemapId") != "blank"
        or any(basemap.get(key) for key in ("url", "sourceUrl", "styleUrl"))
        for basemap in visible
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_basemap_unsupported",
            "Select Blank canvas; this renderer cannot reproduce the visible external background.",
        )
    return tuple(omitted)


def _compile_layer(
    layer: dict[str, Any], position: int, resolved_style: ResourceStyle | None = None
) -> SavedMapRenderLayer:
    identifier = layer["layerId"]
    if layer["sourceType"] != "governed-dataset":
        _unsupported(
            identifier,
            "saved_map_source_unsupported",
            "Use an exact governed dataset version or hide this external layer.",
        )
    if not layer.get("datasetVersionId"):
        _unsupported(
            identifier,
            "saved_map_dataset_unpinned",
            "Select an exact dataset version and save this layer before rendering.",
        )
    geometry = layer.get("geometryType")
    if not isinstance(geometry, str) or geometry not in _GEOMETRIES:
        _unsupported(
            identifier,
            "saved_map_geometry_unsupported",
            "Save a point, line, or polygon geometry type for this layer.",
        )
    _reject_filters({key: value for key, value in layer.items() if key != "filter"}, identifier)
    if "styleReference" in layer:
        return _compile_referenced_layer(layer, resolved_style)
    style = layer["style"]
    unknown = set(style) - _STYLE_FIELDS
    if unknown:
        _unsupported(
            identifier,
            "saved_map_style_unsupported",
            f"Remove or convert unsupported style fields: {', '.join(sorted(unknown))}.",
        )
    renderer = style.get("renderer")
    if renderer is None and geometry in {"Point", "MultiPoint"}:
        _unsupported(
            identifier,
            "saved_map_renderer_unpinned",
            "Choose Single symbol or Status categories explicitly; "
            "automatic point styling depends on source fields.",
        )
    if renderer == "category":
        _unsupported(
            identifier,
            "saved_map_categories_unpinned",
            "Category colors depend on source-value frequencies; "
            "use Single symbol or a sealed category presentation.",
        )
    if renderer == "graduated":
        _unsupported(
            identifier,
            "saved_map_graduated_unsupported",
            "The bounded renderer cannot reproduce numeric step and no-data colors; "
            "use a supported symbol renderer.",
        )
    if renderer is not None and (
        not isinstance(renderer, str) or renderer not in {"single", "status"}
    ):
        _unsupported(
            identifier,
            "saved_map_renderer_unsupported",
            "Choose a supported Single symbol or Status categories renderer.",
        )

    opacity = 1 if layer.get("opacityMode") == "composite" else layer["opacity"]
    prefix = f"occurrence-{position}"
    parts: list[dict[str, Any]]
    if geometry in {"Point", "MultiPoint"}:
        color = style.get("circleColor", "#f97316")
        if renderer == "status":
            color = [
                "match",
                ["get", "status"],
                "verified",
                "#16a34a",
                "needs review",
                "#f59e0b",
                "draft",
                "#64748b",
                color,
            ]
        parts = [
            {
                "id": f"{prefix}-points",
                "type": "circle",
                "paint": {
                    "circle-color": color,
                    "circle-radius": style.get("circleRadius", 6),
                    "circle-opacity": opacity,
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 1.25,
                },
            }
        ]
    elif geometry in {"Polygon", "MultiPolygon"}:
        mode = style.get("polygonMode", "fill")
        if not isinstance(mode, str) or mode not in {"fill", "line"}:
            _unsupported(
                identifier,
                "saved_map_polygon_mode_unsupported",
                "Choose filled polygons or polygon outlines.",
            )
        fill = style.get("fill", "#22c55e")
        parts = []
        if mode == "fill":
            factor = _number(style.get("fillOpacityFactor", 0.45), 0, 1, identifier, "fill opacity")
            parts.append(
                {
                    "id": f"{prefix}-fill",
                    "type": "fill",
                    "paint": {
                        "fill-color": fill,
                        "fill-opacity": opacity * factor,
                    },
                }
            )
        parts.append(
            {
                "id": f"{prefix}-outline",
                "type": "line",
                "paint": {
                    "line-color": fill if mode == "line" else style.get("stroke", "#15803d"),
                    "line-width": style.get("strokeWidth", 2),
                    "line-opacity": opacity,
                },
            }
        )
    else:
        parts = [
            {
                "id": f"{prefix}-lines",
                "type": "line",
                "paint": {
                    "line-color": style.get("stroke", "#2563eb"),
                    "line-width": style.get("strokeWidth", 3),
                    "line-opacity": opacity,
                },
            }
        ]
    geometry_ids = tuple(part["id"] for part in parts)
    label = _compile_label(layer["labels"], prefix, identifier)
    if label is not None:
        parts.append(label)
    document: dict[str, Any] = {"version": 8, "sources": {}, "layers": parts}
    pinned_label = label is not None and "fontRef" in layer["labels"]
    if pinned_label:
        document["metadata"] = {"opengeo:font": layer["labels"]["fontRef"]}
    encoded = canonical_json_bytes(document)
    checksum = sha256(encoded).hexdigest()
    # Validate the existing scalar/categorical symbol and label subset. The
    # detached recipe retains the actual Studio label conversion and placement.
    validation_document = json.loads(encoded)
    if pinned_label:
        # The legacy renderer validates geometry only. Its bitmap font, halo
        # limits and text expression parser do not describe MapLibre labels.
        validation_document["layers"] = validation_document["layers"][:-1]
    elif label is not None:
        validation_document["layers"][-1]["layout"]["text-field"] = [
            "get",
            layer["labels"]["field"],
        ]
    for geometry_id in geometry_ids:
        try:
            compile_maplibre_render_configuration(
                json.dumps(validation_document),
                style_id=f"saved-map:{identifier}",
                style_version_id=f"sha256:{checksum}",
                style_version_number=1,
                style_checksum_sha256=checksum,
                geometry_layer_id=geometry_id,
                label_layer_id=label["id"] if label and not pinned_label else None,
                minimum_scale_denominator=None,
                maximum_scale_denominator=None,
                include_legend=False,
            )
        except MapLibreRenderUnsupported as error:
            _unsupported(
                identifier,
                "saved_map_symbol_unsupported",
                f"Adjust this layer's symbol or label: {error}.",
            )
    if layer.get("opacityMode") == "composite":
        for part in parts:
            if part["type"] in ("fill", "line"):
                part["paint"][f"{part['type']}-layer-opacity"] = layer["opacity"]
        encoded = canonical_json_bytes(document)
        checksum = sha256(encoded).hexdigest()
    if label is not None and layer["labels"].get("drawOrder") == "above-data":
        label["metadata"] = {"opengeo:drawOrder": "above-data"}
        encoded = canonical_json_bytes(document)
        checksum = sha256(encoded).hexdigest()
    if layer.get("filter") is not None:
        for part in document["layers"]:
            part["filter"] = layer["filter"]
        encoded = canonical_json_bytes(document)
        checksum = sha256(encoded).hexdigest()
    return SavedMapRenderLayer(
        layer_id=identifier,
        title=layer["title"],
        order=layer["order"],
        dataset_id=UUID(layer["datasetId"]),
        dataset_version_id=UUID(layer["datasetVersionId"]),
        dataset_version_number=layer["sourceVersion"],
        object_id=UUID(layer["objectId"]) if layer.get("objectId") else None,
        geometry_type=geometry,
        maplibre_style_json=encoded.decode(),
        style_checksum_sha256=checksum,
        geometry_layer_ids=geometry_ids,
        label_layer_id=label["id"] if label else None,
    )


def _compile_label(labels: dict[str, Any], prefix: str, layer_id: str) -> dict[str, Any] | None:
    if not isinstance(labels.get("enabled", False), bool):
        _unsupported(
            layer_id,
            "saved_map_label_unsupported",
            "Save an explicit enabled or disabled label state.",
        )
    if not labels.get("enabled"):
        return None
    unknown = set(labels) - _LABEL_FIELDS
    if unknown:
        _unsupported(
            layer_id,
            "saved_map_label_unsupported",
            f"Remove unsupported label fields: {', '.join(sorted(unknown))}.",
        )
    font_ref = labels.get("fontRef")
    if font_ref is None and (
        labels.get("prefix") or labels.get("suffix") or labels.get("allowOverlap")
    ):
        _unsupported(
            layer_id,
            "saved_map_label_unsupported",
            "Choose a publication font and save a new map revision to preserve "
            "label prefixes, suffixes and overlap settings in an image.",
        )
    if not labels.get("field"):
        _unsupported(
            layer_id, "saved_map_label_field_missing", "Choose the field for this enabled label."
        )
    layout: dict[str, Any] = {
        "text-field": ["to-string", ["get", labels["field"]]],
        "text-size": labels.get("size", 12),
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-allow-overlap": False,
    }
    if font_ref is not None:
        try:
            stack = resolve_render_font(font_ref)
        except ValueError as error:
            _unsupported(layer_id, "saved_map_font_unavailable", str(error))
        for name, minimum, maximum, default in (("size", 8, 28, 12), ("haloWidth", 0, 6, 1.2)):
            _number(labels.get(name, default), minimum, maximum, layer_id, name)
        if (
            not isinstance(labels["field"], str)
            or len(labels["field"]) > 255
            or type(labels.get("allowOverlap", False)) is not bool
        ):
            _unsupported(
                layer_id, "saved_map_label_unsupported", "Use a bounded field and label settings."
            )
        for name in ("prefix", "suffix"):
            text = labels.get(name, "")
            if not isinstance(text, str) or len(text) > 512:
                _unsupported(
                    layer_id,
                    "saved_map_label_unsupported",
                    "Use at most 512 characters of label prefix or suffix.",
                )
        for name, default_color in (("color", "#111827"), ("haloColor", "#ffffff")):
            color = labels.get(name, default_color)
            if (
                not isinstance(color, str)
                or len(color) not in (7, 9)
                or color[0] != "#"
                or any(character not in "0123456789abcdefABCDEF" for character in color[1:])
            ):
                _unsupported(
                    layer_id,
                    "saved_map_label_unsupported",
                    "Choose a hexadecimal label and halo color.",
                )
        prefix_text, suffix_text = labels.get("prefix", ""), labels.get("suffix", "")
        if prefix_text or suffix_text:
            layout["text-field"] = ["concat", prefix_text, layout["text-field"], suffix_text]
        layout["text-font"] = [stack]
        layout["text-allow-overlap"] = labels.get("allowOverlap", False)
    return {
        "id": f"{prefix}-labels",
        "type": "symbol",
        "layout": layout,
        "paint": {
            "text-color": labels.get("color", "#111827"),
            "text-halo-color": labels.get("haloColor", "#ffffff"),
            "text-halo-width": labels.get("haloWidth", 1.2),
        },
    }


def _reject_filters(value: dict[str, Any], layer_id: str | None = None) -> None:
    if any(
        value.get(field) not in (None, [], {})
        for field in ("filter", "filters", "query", "filterExpression")
    ):
        raise SavedMapRenderUnsupported(
            "saved_map_filter_unsupported",
            "Clear the filter or publish its filtered result as an exact dataset version.",
            layer_id=layer_id,
        )


def _number(value: object, minimum: float, maximum: float, layer_id: str, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        _unsupported(
            layer_id,
            "saved_map_symbol_unsupported",
            f"Set {label} between {minimum} and {maximum}.",
        )
    return float(value)


def _require_saved_layer_order(layer_ids: list[str], tree: object) -> None:
    """Accept grouped maps when their saved order matches Studio's normalization."""
    if tree is None:
        return
    ranks = {identifier: index for index, identifier in enumerate(layer_ids)}
    visited = 0

    def flatten(nodes: object, depth: int) -> list[str]:
        nonlocal visited
        if not isinstance(nodes, list) or depth > 8:
            raise SavedMapRenderUnsupported(
                "saved_map_layer_tree_invalid", "Save a bounded valid layer tree before rendering."
            )
        output: list[str | list[str]] = []
        for node in nodes:
            visited += 1
            if visited > 256 or not isinstance(node, dict):
                raise SavedMapRenderUnsupported(
                    "saved_map_layer_tree_invalid", "Use at most 256 layer-tree entries."
                )
            if node.get("kind") == "layer" and isinstance(node.get("layerId"), str):
                output.append(node["layerId"])
            elif node.get("kind") == "group":
                output.append(flatten(node.get("children"), depth + 1))
            else:
                raise SavedMapRenderUnsupported(
                    "saved_map_layer_tree_invalid",
                    "Save only layer and group entries in the layer tree.",
                )
        siblings = iter(
            sorted(
                (item for item in output if isinstance(item, str) and item in ranks),
                key=ranks.__getitem__,
            )
        )
        flattened: list[str] = []
        for item in output:
            if isinstance(item, list):
                flattened.extend(item)
            elif item in ranks:
                flattened.append(next(siblings))
        return flattened

    configured = list(dict.fromkeys(flatten(tree, 0)))
    normalized = [
        identifier for identifier in layer_ids if identifier not in configured
    ] + configured
    if normalized != layer_ids:
        raise SavedMapRenderUnsupported(
            "saved_map_layer_order_conflict",
            "Reopen and save the map to reconcile its layer groups with its drawing order.",
        )


def _unsupported(layer_id: str, code: str, message: str) -> NoReturn:
    raise SavedMapRenderUnsupported(code, message, layer_id=layer_id)


def _compile_referenced_layer(
    layer: dict[str, Any], style: ResourceStyle | None
) -> SavedMapRenderLayer:
    identifier = layer["layerId"]
    reference = layer["styleReference"]
    if (
        style is None
        or str(style.style_id) != reference["styleId"]
        or str(style.resource_id) != reference["resourceId"]
        or style.version_number != reference["versionNumber"]
        or style.format != reference["format"]
        or style.checksum_sha256 != reference["checksumSha256"]
        or sha256(style.definition.encode()).hexdigest() != reference["checksumSha256"]
    ):
        _unsupported(
            identifier, "saved_map_style_unavailable", "Resolve the exact selected Style revision."
        )
    assert style is not None
    if style.format == "sld_1_1":
        from opengeo_api.cartographic_patterns import generated_pattern

        try:
            pattern = generated_pattern(style.definition)
            if layer["geometryType"] not in {"Polygon", "MultiPolygon"}:
                raise ValueError("Pattern requires polygon geometry")
        except (ValueError, TypeError, KeyError) as error:
            _unsupported(identifier, "saved_map_pattern_unsupported", str(error))
        image_id = f"pattern-{style.checksum_sha256}"
        part_id = f"{identifier}-pattern"
        paint = {"fill-pattern": image_id, "fill-opacity": layer["opacity"]}
        if layer.get("opacityMode") == "composite":
            paint.update({"fill-opacity": 1, "fill-layer-opacity": layer["opacity"]})
        part: dict[str, Any] = {"id": part_id, "type": "fill", "paint": paint}
        if layer.get("filter") is not None:
            part["filter"] = layer["filter"]
        document: dict[str, Any] = {
            "version": 8,
            "sources": {},
            "layers": [part],
            "metadata": {"opengeo:patterns": {image_id: pattern}},
        }
        encoded = canonical_json_bytes(document)
        return SavedMapRenderLayer(
            layer_id=identifier,
            title=layer["title"],
            order=layer["order"],
            dataset_id=UUID(layer["datasetId"]),
            dataset_version_id=UUID(layer["datasetVersionId"]),
            dataset_version_number=layer["sourceVersion"],
            object_id=UUID(layer["objectId"]) if layer.get("objectId") else None,
            geometry_type=layer["geometryType"],
            maplibre_style_json=encoded.decode(),
            style_checksum_sha256=sha256(encoded).hexdigest(),
            geometry_layer_ids=(part_id,),
            label_layer_id=None,
        )
    if style.format != "maplibre":
        _unsupported(
            identifier,
            "saved_map_style_format_unsupported",
            "This renderer requires a MapLibre Style.",
        )
    document = json.loads(style.definition)
    if (
        not isinstance(document, dict)
        or document.get("version") != 8
        or set(document) - {"version", "name", "metadata", "sources", "layers"}
        or document.get("sources") != {}
    ):
        _unsupported(
            identifier,
            "saved_map_style_dependencies_unsupported",
            "Use a detached Style without external sources, sprites or glyphs.",
        )
    parts = document.get("layers")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 16:
        _unsupported(
            identifier,
            "saved_map_style_layers_unsupported",
            "Use between 1 and 16 geometry passes.",
        )
    geometry = layer["geometryType"]
    allowed_types = (
        {"circle"}
        if "Point" in geometry
        else {"fill", "line"}
        if "Polygon" in geometry
        else {"line"}
    )
    paint_fields = {
        "circle": {
            "circle-color",
            "circle-radius",
            "circle-opacity",
            "circle-stroke-color",
            "circle-stroke-width",
        },
        "line": {"line-color", "line-width", "line-opacity"},
        "fill": {"fill-color", "fill-opacity", "fill-outline-color"},
    }
    identifiers = []
    for part in parts:
        if (
            not isinstance(part, dict)
            or not isinstance(part.get("type"), str)
            or part["type"] not in allowed_types
        ):
            _unsupported(
                identifier,
                "saved_map_style_geometry_unsupported",
                "Style geometry must match the Layer; symbol passes require "
                "publication-font integration.",
            )
        kind = part["type"]
        if set(part) - {"id", "type", "paint", "layout"} or part.get("layout", {}) != {}:
            _unsupported(
                identifier,
                "saved_map_style_semantics_unsupported",
                "Filters, source bindings, zoom rules and layout options require renderer support.",
            )
        paint = part.get("paint", {})
        if not isinstance(paint, dict) or set(paint) - paint_fields[kind]:
            _unsupported(
                identifier,
                "saved_map_style_paint_unsupported",
                "This Style uses paint properties outside this static renderer's profile.",
            )
        required_paint = paint_fields[kind] - {f"{kind}-opacity"}
        if not required_paint.issubset(paint):
            _unsupported(
                identifier,
                "saved_map_style_defaults_unresolved",
                "Save explicit symbol colors and dimensions; renderer defaults may differ.",
            )
        # Validate before multiplying the composition opacity; do not coerce expressions.
        try:
            compile_maplibre_render_configuration(
                json.dumps(document),
                style_id=str(style.style_id),
                style_version_id="selected",
                style_version_number=style.version_number,
                style_checksum_sha256=style.checksum_sha256,
                geometry_layer_id=cast(str, part.get("id")),
                label_layer_id=None,
                minimum_scale_denominator=None,
                maximum_scale_denominator=None,
                include_legend=False,
            )
        except MapLibreRenderUnsupported as error:
            _unsupported(identifier, "saved_map_symbol_unsupported", str(error))
        if layer.get("opacityMode") == "composite":
            if kind not in ("fill", "line"):
                _unsupported(
                    identifier,
                    "saved_map_opacity_unsupported",
                    "Composite opacity requires fill or line Style parts.",
                )
            part["paint"] = {
                **paint,
                f"{kind}-opacity": paint.get(f"{kind}-opacity", 1),
                f"{kind}-layer-opacity": layer["opacity"],
            }
        else:
            part["paint"] = {
                **paint,
                f"{kind}-opacity": paint.get(f"{kind}-opacity", 1) * layer["opacity"],
            }
        identifiers.append(part["id"])
    # Metadata stays in the source revision, not in renderer instructions.
    if layer.get("filter") is not None:
        for part in parts:
            part["filter"] = layer["filter"]
    compiled = {"version": 8, "sources": {}, "layers": parts}
    encoded = canonical_json_bytes(compiled)
    return SavedMapRenderLayer(
        layer_id=identifier,
        title=layer["title"],
        order=layer["order"],
        dataset_id=UUID(layer["datasetId"]),
        dataset_version_id=UUID(layer["datasetVersionId"]),
        dataset_version_number=layer["sourceVersion"],
        object_id=UUID(layer["objectId"]) if layer.get("objectId") else None,
        geometry_type=geometry,
        maplibre_style_json=encoded.decode(),
        style_checksum_sha256=sha256(encoded).hexdigest(),
        geometry_layer_ids=tuple(identifiers),
        label_layer_id=None,
    )
