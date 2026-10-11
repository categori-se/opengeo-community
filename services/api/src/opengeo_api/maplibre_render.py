import json
import math
import re
from hashlib import sha256
from typing import Any, cast


class MapLibreRenderUnsupported(ValueError):
    pass


_COLOR = re.compile(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?")
_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_.:-]{0,99}")


def compile_maplibre_render_configuration(
    definition: str,
    *,
    style_id: str,
    style_version_id: str,
    style_version_number: int,
    style_checksum_sha256: str,
    geometry_layer_id: str,
    label_layer_id: str | None,
    minimum_scale_denominator: float | None,
    maximum_scale_denominator: float | None,
    include_legend: bool,
) -> tuple[dict[str, Any], str]:
    try:
        document = json.loads(definition)
    except ValueError as error:
        raise MapLibreRenderUnsupported("maplibre_style_invalid_json") from error
    if not isinstance(document, dict) or document.get("version") != 8:
        raise MapLibreRenderUnsupported("maplibre_style_version_unsupported")
    raw_layers = document.get("layers")
    if not isinstance(raw_layers, list) or not 1 <= len(raw_layers) <= 32:
        raise MapLibreRenderUnsupported("maplibre_style_layers_unsupported")
    layers: dict[str, dict[str, Any]] = {}
    for value in raw_layers:
        if not isinstance(value, dict):
            raise MapLibreRenderUnsupported("maplibre_style_layer_invalid")
        identifier = value.get("id")
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 100:
            raise MapLibreRenderUnsupported("maplibre_style_layer_invalid")
        if identifier in layers:
            raise MapLibreRenderUnsupported("maplibre_style_layer_duplicate")
        layers[identifier] = cast(dict[str, Any], value)

    geometry_layer = layers.get(geometry_layer_id)
    if geometry_layer is None:
        raise MapLibreRenderUnsupported("maplibre_geometry_layer_not_found")
    geometry = _geometry_symbolizer(geometry_layer)
    label = None
    if label_layer_id is not None:
        label_layer = layers.get(label_layer_id)
        if label_layer is None:
            raise MapLibreRenderUnsupported("maplibre_label_layer_not_found")
        label = _label_symbolizer(label_layer)
    if (
        minimum_scale_denominator is not None
        and maximum_scale_denominator is not None
        and minimum_scale_denominator > maximum_scale_denominator
    ):
        raise MapLibreRenderUnsupported("render_scale_range_invalid")
    scale = {
        "minimum_denominator": minimum_scale_denominator,
        "maximum_denominator": maximum_scale_denominator,
    }
    configuration: dict[str, Any] = {
        "schema": "opengeo.render.v1",
        "renderer": "opengeo.deterministic-svg.v2",
        "output_crs": "EPSG:4326",
        "background": "#ffffff",
        "geometry": geometry,
        "label": label,
        "scale": scale,
        "legend": {"enabled": include_legend, "title": geometry_layer_id},
        "source_style": {
            "format": "maplibre",
            "style_id": style_id,
            "style_version_id": style_version_id,
            "style_version_number": style_version_number,
            "checksum_sha256": style_checksum_sha256,
            "geometry_layer_id": geometry_layer_id,
            "label_layer_id": label_layer_id,
        },
        "conversion": {
            "status": "bounded_subset",
            "ignored_layer_ids": sorted(
                identifier
                for identifier in layers
                if identifier not in {geometry_layer_id, label_layer_id}
            ),
            "unsupported_semantics_are_rejected": True,
        },
    }
    encoded = json.dumps(configuration, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode()) > 32_768:
        raise MapLibreRenderUnsupported("render_configuration_too_large")
    return configuration, sha256(encoded.encode()).hexdigest()


def _geometry_symbolizer(layer: dict[str, Any]) -> dict[str, Any]:
    layer_type = layer.get("type")
    if layer_type not in {"fill", "line", "circle", "heatmap"}:
        raise MapLibreRenderUnsupported("maplibre_geometry_type_unsupported")
    paint = layer.get("paint", {})
    if not isinstance(paint, dict):
        raise MapLibreRenderUnsupported("maplibre_geometry_paint_invalid")
    prefix = cast(str, layer_type)
    if prefix == "heatmap":
        colors = _heatmap_colors(paint.get("heatmap-color"))
        return {
            "type": "heatmap",
            "color": colors[-1],
            "colors": colors,
            "kernel": "mapserver-gaussian",
            "normalization": "positive-minimum-over-visible-peak",
            "quantization_levels": 31,
            "opacity": _number(paint.get("heatmap-opacity", 0.8), 0.0, 1.0, "opacity"),
            "radius": _number(paint.get("heatmap-radius", 24.0), 1.0, 64.0, "radius"),
            "intensity": _number(
                paint.get("heatmap-intensity", 1.0), 0.1, 4.0, "heatmap_intensity"
            ),
        }
    color_key = {"fill": "fill-color", "line": "line-color", "circle": "circle-color"}[prefix]
    default_color = {"fill": "#4d927f", "line": "#275d52", "circle": "#2f7d68"}[prefix]
    color, classification = _color_expression(paint.get(color_key, default_color))
    opacity = _number(paint.get(f"{prefix}-opacity", 1.0), 0.0, 1.0, "opacity")
    symbolizer: dict[str, Any] = {
        "type": prefix,
        "color": color,
        "opacity": opacity,
        "classification": classification,
    }
    if prefix == "fill":
        symbolizer["outline_color"] = _color(paint.get("fill-outline-color", "#173f35"))
        symbolizer["outline_width"] = 1.0
    elif prefix == "line":
        symbolizer["width"] = _number(paint.get("line-width", 2.0), 0.25, 20.0, "width")
    else:
        symbolizer["radius"] = _number(paint.get("circle-radius", 4.0), 1.0, 32.0, "radius")
        symbolizer["stroke_color"] = _color(paint.get("circle-stroke-color", "#173f35"))
        symbolizer["stroke_width"] = _number(
            paint.get("circle-stroke-width", 1.0), 0.0, 8.0, "stroke_width"
        )
    return symbolizer


def _heatmap_colors(value: object) -> list[str]:
    if value is None:
        return ["#2c7bb6", "#ffffbf", "#d7191c"]
    if (
        not isinstance(value, list)
        or len(value) != 9
        or value[:3] != ["interpolate", ["linear"], ["heatmap-density"]]
        or value[3] != 0
        or value[5] != 0.5
        or value[7] != 1
    ):
        raise MapLibreRenderUnsupported("maplibre_heatmap_color_unsupported")
    return [_color(value[index]) for index in (4, 6, 8)]


def _label_symbolizer(layer: dict[str, Any]) -> dict[str, Any]:
    if layer.get("type") != "symbol":
        raise MapLibreRenderUnsupported("maplibre_label_type_unsupported")
    layout = layer.get("layout", {})
    paint = layer.get("paint", {})
    if not isinstance(layout, dict) or not isinstance(paint, dict):
        raise MapLibreRenderUnsupported("maplibre_label_invalid")
    field = _get_field(layout.get("text-field"), "maplibre_label_field_unsupported")
    return {
        "field": field,
        "font": "opengeo-uppercase-5x7-v1",
        "size": _number(layout.get("text-size", 12.0), 6.0, 32.0, "label_size"),
        "color": _color(paint.get("text-color", "#172824")),
        "halo_color": _color(paint.get("text-halo-color", "#ffffff")),
        "halo_width": _number(paint.get("text-halo-width", 1.0), 0.0, 4.0, "label_halo_width"),
        "collision": "avoid",
        "maximum_length": 80,
    }


def _color_expression(value: object) -> tuple[str, dict[str, Any] | None]:
    if isinstance(value, str):
        return _color(value), None
    if not isinstance(value, list) or len(value) < 5 or value[0] != "match":
        raise MapLibreRenderUnsupported("maplibre_color_expression_unsupported")
    field = _get_field(value[1], "maplibre_classification_field_unsupported")
    pairs = value[2:-1]
    if len(pairs) % 2 or len(pairs) // 2 > 16:
        raise MapLibreRenderUnsupported("maplibre_classification_rules_unsupported")
    rules = []
    for index in range(0, len(pairs), 2):
        label = pairs[index]
        if isinstance(label, bool) or not isinstance(label, (str, int, float)):
            raise MapLibreRenderUnsupported("maplibre_classification_value_unsupported")
        if isinstance(label, float) and not math.isfinite(label):
            raise MapLibreRenderUnsupported("maplibre_classification_value_unsupported")
        rules.append({"value": label, "color": _color(pairs[index + 1]), "label": str(label)})
    fallback = _color(value[-1])
    return fallback, {"field": field, "rules": rules, "fallback_color": fallback}


def _get_field(value: object, code: str) -> str:
    if (
        not isinstance(value, list)
        or len(value) != 2
        or value[0] != "get"
        or not isinstance(value[1], str)
        or _FIELD.fullmatch(value[1]) is None
    ):
        raise MapLibreRenderUnsupported(code)
    return value[1]


def _color(value: object) -> str:
    if not isinstance(value, str) or _COLOR.fullmatch(value) is None:
        raise MapLibreRenderUnsupported("maplibre_color_unsupported")
    return value.lower()


def _number(value: object, minimum: float, maximum: float, code: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MapLibreRenderUnsupported(f"maplibre_{code}_unsupported")
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise MapLibreRenderUnsupported(f"maplibre_{code}_unsupported")
    return number
