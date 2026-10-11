"""Exact saved-map compositions using an explicitly provisioned MapLibre runtime.

Legacy profiles never enter this path. The runtime is not downloaded or inferred
from the host, and unavailable runtime/font assets are explicit failures.
"""

from opengeo_worker.map_filters import validate_map_filter

import json
import math
import re
import struct
from collections.abc import Sequence
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol, cast

from opengeo_worker.models import RenderClaim, RenderLayerClaim, ValidationFailure
from opengeo_worker.render_runtime import PINNED_GL_RENDERER, runtime_reference
from opengeo_worker.renderer import DeterministicSvgRenderer

GL_RENDERER = "opengeo.maplibre-gl-js.v1"
GL_OCCURRENCE_SCHEMA = "opengeo.saved-map-gl-occurrence.1.0.0"
_HASH = re.compile(r"[0-9a-f]{64}")
_COLOR = re.compile(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?")
_MAX_SOURCE_BYTES = 16_777_216
_MERCATOR_LIMIT = 20_037_508.342789244
_CONFIG_KEYS = {
    "schema_version",
    "renderer",
    "output_crs",
    "background",
    "source_style",
    "saved_map",
    "map_view",
    "maplibre_style",
    "font_ref",
}
_MARKER_KEYS = {
    "schema",
    "recipe_checksum_sha256",
    "definition_checksum_sha256",
    "style_checksum_sha256",
    "layer_id",
    "source_geometry_type",
    "position",
    "pass_count",
    "dataset_id",
    "dataset_version_id",
}
_STYLE_IDENTITY_KEYS = {
    "style_id",
    "style_version_id",
    "style_version_number",
    "style_checksum_sha256",
}
_PAINT = {
    "fill": {"fill-color", "fill-opacity", "fill-layer-opacity", "fill-pattern"},
    "line": {"line-color", "line-opacity", "line-width", "line-layer-opacity"},
    "circle": {
        "circle-color",
        "circle-radius",
        "circle-opacity",
        "circle-stroke-color",
        "circle-stroke-width",
        "circle-stroke-opacity",
    },
    "symbol": {"text-color", "text-halo-color", "text-halo-width"},
}
_LABEL_LAYOUT = {
    "text-field",
    "text-font",
    "text-size",
    "text-offset",
    "text-anchor",
    "text-allow-overlap",
}


class CompositionRuntime(Protocol):
    def render(self, request: dict[str, Any], target: Path) -> None: ...


def _fail(code: str = "saved_map_gl_configuration_invalid") -> None:
    raise ValidationFailure(code)


def _number(value: Any, minimum: float, maximum: float) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and minimum <= value <= maximum
    )


def _canonical(value: Any) -> str:
    """Match the API's canonical detached-style seals, not config serialization."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        rendered = format(Decimal(repr(value)), "f") if value else "0"
        return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return (
            "{"
            + ",".join(f"{_canonical(key)}:{_canonical(value[key])}" for key in sorted(value))
            + "}"
        )
    _fail()
    raise AssertionError("unreachable")


def _bounded_json(value: Any) -> None:
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 500_000 or depth > 24:
            _fail("saved_map_gl_input_limit")
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                _fail()
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            if len(item) > 65_536 or any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                _fail("saved_map_gl_input_limit")
        elif item is not None and not isinstance(item, bool) and not _number(item, -1e100, 1e100):
            _fail()


def _text_parts(expression: Any) -> list[str | tuple[str]]:
    if (
        isinstance(expression, list)
        and len(expression) == 2
        and expression[0] == "to-string"
        and isinstance(expression[1], list)
        and len(expression[1]) == 2
        and expression[1][0] == "get"
        and isinstance(expression[1][1], str)
        and 1 <= len(expression[1][1]) <= 255
    ):
        return [(expression[1][1],)]
    if isinstance(expression, list) and 2 <= len(expression) <= 8 and expression[0] == "concat":
        parts: list[str | tuple[str]] = []
        for item in expression[1:]:
            if isinstance(item, str) and len(item) <= 512:
                parts.append(item)
            else:
                parts.extend(_text_parts(item))
        return parts
    _fail("saved_map_gl_label_expression_unsupported")
    raise AssertionError("unreachable")


def _color(value: Any) -> bool:
    if isinstance(value, str):
        return bool(_COLOR.fullmatch(value))
    return (
        isinstance(value, list)
        and 5 <= len(value) <= 131
        and len(value) % 2 == 1
        and value[0] == "match"
        and isinstance(value[1], list)
        and len(value[1]) == 2
        and value[1][0] == "get"
        and isinstance(value[1][1], str)
        and all(
            isinstance(item, (str, int, float)) and not isinstance(item, bool)
            for item in value[2:-1:2]
        )
        and all(
            isinstance(item, str) and bool(_COLOR.fullmatch(item))
            for item in [*value[3:-1:2], value[-1]]
        )
    )


def _validate_style(style: Any, font_ref: Any) -> list[dict[str, Any]]:
    if (
        not isinstance(style, dict)
        or set(style) - {"version", "sources", "layers", "metadata"}
        or style.get("version") != 8
        or style.get("sources") != {}
        or not isinstance(style.get("layers"), list)
        or not 1 <= len(style["layers"]) <= 3
    ):
        _fail("saved_map_gl_style_unsupported")
    metadata = style.get("metadata", {})
    if not isinstance(metadata, dict):
        _fail("saved_map_gl_style_unsupported")
    patterns = metadata.get("opengeo:patterns", {})
    if not isinstance(patterns, dict) or len(patterns) > 1:
        _fail("saved_map_gl_pattern_invalid")
    for identifier, image in patterns.items():
        if (not isinstance(identifier, str) or not re.fullmatch(r"pattern-[0-9a-f]{64}", identifier)
            or not isinstance(image, dict) or set(image) != {"svg", "size"}
            or not _number(image["size"], 16, 64) or not isinstance(image["svg"], str)
            or len(image["svg"]) > 2048):
            _fail("saved_map_gl_pattern_invalid")
        match = re.fullmatch(
            r'<svg xmlns="http://www.w3.org/2000/svg" width="([0-9.]+)" height="\1" viewBox="0 0 32 32">'
            r'<rect width="32" height="32" fill="#[0-9a-fA-F]{6}" fill-opacity="[01]"/>'
            r'<path d="[MmLlHhVvQqTtZz0-9 .,-]{1,500}" stroke="#[0-9a-fA-F]{6}" stroke-width="([0-9.]+)" stroke-linecap="round" fill="none"/></svg>',
            image["svg"],
        )
        try:
            valid = match is not None and float(match[1]) == image["size"] and .5 <= float(match[2]) <= 4
        except ValueError:
            valid = False
        if not valid:
            _fail("saved_map_gl_pattern_invalid")
    expected_metadata = {"opengeo:font": font_ref} if font_ref is not None else {}
    if patterns:
        expected_metadata["opengeo:patterns"] = patterns
    if metadata != expected_metadata:
        _fail("saved_map_gl_font_identity_mismatch")
    labels = []
    geometry = 0
    ids: set[str] = set()
    for layer in style["layers"]:
        if (
            not isinstance(layer, dict)
            or set(layer) - {"id", "type", "paint", "layout", "filter", "metadata"}
            or not isinstance(layer.get("id"), str)
            or not 1 <= len(layer["id"]) <= 256
            or layer["id"] in ids
            or not isinstance(layer.get("type"), str)
            or layer.get("type") not in _PAINT
            or not isinstance(layer.get("paint"), dict)
            or set(layer["paint"]) - _PAINT[layer["type"]]
        ):
            _fail("saved_map_gl_style_unsupported")
        if "filter" in layer:
            try:
                validate_map_filter(layer["filter"])
            except ValueError:
                _fail("saved_map_gl_filter_unsupported")
        if "metadata" in layer and (layer["type"]!="symbol" or layer["metadata"]!={"opengeo:drawOrder":"above-data"}):
            _fail("saved_map_gl_style_unsupported")
        ids.add(layer["id"])
        for name, value in layer["paint"].items():
            if name == "fill-pattern":
                if not isinstance(value, str) or value not in patterns:
                    _fail("saved_map_gl_pattern_invalid")
                continue
            maximum = 1 if name.endswith("opacity") else 6 if name == "text-halo-width" else 128
            if not (_color(value) if name.endswith("color") else _number(value, 0, maximum)):
                _fail("saved_map_gl_style_unsupported")
        if layer["type"] != "symbol":
            geometry += 1
            if layer.get("layout") not in (None, {}):
                _fail("saved_map_gl_style_unsupported")
            continue
        labels.append(layer)
        layout = layer.get("layout")
        if (
            font_ref is None
            or not isinstance(layout, dict)
            or set(layout) != _LABEL_LAYOUT
            or not isinstance(layout["text-font"], list)
            or len(layout["text-font"]) != 1
            or not isinstance(layout["text-font"][0], str)
            or not _number(layout["text-size"], 8, 28)
            or layout["text-offset"] != [0, 1.1]
            or layout["text-anchor"] != "top"
            or not isinstance(layout["text-allow-overlap"], bool)
        ):
            _fail("saved_map_gl_label_style_unsupported")
        _text_parts(layout["text-field"])
    if geometry == 0 or len(labels) > 1 or bool(labels) != (font_ref is not None):
        _fail("saved_map_gl_font_identity_mismatch")
    return labels


def _source(path: Path, layer: RenderLayerClaim) -> dict[str, Any]:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_SOURCE_BYTES:
            _fail("saved_map_gl_source_invalid")
        content = path.read_bytes()
        if (
            len(content) != layer.source.size_bytes
            or sha256(content).hexdigest() != layer.source.checksum_sha256
        ):
            _fail("saved_map_gl_source_checksum_mismatch")
        document = json.loads(content)
    except (OSError, ValueError, RecursionError) as error:
        raise ValidationFailure("saved_map_gl_source_invalid") from error
    if layer.source.content_type not in {"application/geo+json", "application/json"}:
        _fail("saved_map_gl_source_invalid")
    _bounded_json(document)
    if (
        not isinstance(document, dict)
        or document.get("type") != "FeatureCollection"
        or "crs" in document
        or not isinstance(document.get("features"), list)
    ):
        _fail("saved_map_gl_source_invalid")
    return cast(dict[str, Any], document)


def _source_features(document: dict[str, Any], declared: str) -> int:
    coordinates = 0
    family = declared.removeprefix("Multi")
    depths = {
        "Point": 0,
        "MultiPoint": 1,
        "LineString": 1,
        "MultiLineString": 2,
        "Polygon": 2,
        "MultiPolygon": 3,
    }
    for feature in document["features"]:
        if (
            not isinstance(feature, dict)
            or feature.get("type") != "Feature"
            or not isinstance(feature.get("properties", {}), (dict, type(None)))
        ):
            _fail("saved_map_gl_source_invalid")
        geometry = feature.get("geometry")
        if geometry is None:
            continue
        if (
            not isinstance(geometry, dict)
            or not isinstance(geometry.get("type"), str)
            or geometry.get("type") not in depths
            or geometry["type"].removeprefix("Multi") != family
        ):
            _fail("saved_map_gl_source_geometry_mismatch")
        pending = [(geometry.get("coordinates"), depths[geometry["type"]])]
        while pending:
            value, depth = pending.pop()
            if not isinstance(value, list):
                _fail("saved_map_gl_source_invalid")
            if depth:
                pending.extend((item, depth - 1) for item in value)
            else:
                if (
                    not 2 <= len(value) <= 3
                    or not _number(value[0], -180, 180)
                    or not _number(value[1], -90, 90)
                    or (len(value) == 3 and not _number(value[2], -1e9, 1e9))
                ):
                    _fail("saved_map_gl_source_invalid")
                coordinates += 1
    return coordinates


def _required_codepoints(labels: list[dict[str, Any]], source: dict[str, Any]) -> list[int]:
    points: set[int] = set()
    for label in labels:
        parts = _text_parts(label["layout"]["text-field"])
        for feature in source["features"]:
            properties = feature.get("properties") or {}
            for part in parts:
                value = part if isinstance(part, str) else properties.get(part[0])
                # Non-string MapLibre values stringify to JSON. Number lexical
                # differences contain only ASCII; include all numeric characters.
                text = (
                    value
                    if isinstance(value, str)
                    else ""
                    if value is None
                    else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                )
                points.update(ord(char) for char in text if char != "\n")
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    points.update(map(ord, "0123456789.eE+-"))
    return sorted(points)


def _layer_claim(claim: RenderClaim) -> RenderLayerClaim:
    return RenderLayerClaim(
        **{
            name: getattr(claim, name)
            for name in RenderLayerClaim.__dataclass_fields__
            if name != "position"
        },
        position=1,
    )


class MapLibreCompositionRenderer:
    def __init__(self, runtime: CompositionRuntime | None = None) -> None:
        if runtime is None:
            from opengeo_worker.maplibre_runtime import MapLibreRuntime

            runtime = MapLibreRuntime()
        self._runtime = runtime

    def render(self, source: Path, claim: RenderClaim, target: Path) -> None:
        claim.require_claimed()
        self._render([source], [_layer_claim(claim)], claim, target)

    def render_composition(
        self,
        sources: Sequence[Path],
        layers: Sequence[RenderLayerClaim],
        claim: RenderClaim,
        target: Path,
    ) -> None:
        claim.require_claimed()
        if len(layers) < 2:
            _fail("saved_map_gl_sequence_invalid")
        self._render(sources, layers, claim, target)

    def _render(
        self,
        sources: Sequence[Path],
        layers: Sequence[RenderLayerClaim],
        claim: RenderClaim,
        target: Path,
    ) -> None:
        if (
            not 1 <= len(layers) <= 16
            or len(sources) != len(layers)
            or tuple(layer.position for layer in layers) != tuple(range(1, len(layers) + 1))
            or layers[0] != _layer_claim(claim)
            or (claim.layers and tuple(layers) != claim.layers)
            or claim.format != "png"
            or claim.crs != "EPSG:3857"
            or claim.transparent
            or not isinstance(claim.width, int)
            or not isinstance(claim.height, int)
            or not 64 <= claim.width <= 2048
            or not 64 <= claim.height <= 2048
            or claim.width * claim.height > 4_194_304
        ):
            _fail("saved_map_gl_request_invalid")
        configurations = [self._configuration(layer) for layer in layers]
        first = configurations[0]
        view = first["map_view"]
        if (
            not isinstance(view, dict)
            or set(view) != {"center", "zoom", "bearing", "pitch"}
            or not isinstance(view["center"], list)
            or len(view["center"]) != 2
            or not _number(view["center"][0], -180, 180)
            or not _number(view["center"][1], -85.0511287798066, 85.0511287798066)
            or not _number(view["zoom"], 0, 22)
            or view["bearing"] != 0
            or view["pitch"] != 0
        ):
            _fail("saved_map_gl_view_invalid")
        longitude, latitude = view["center"]
        center_x = longitude * _MERCATOR_LIMIT / 180
        center_y = math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)) * (
            _MERCATOR_LIMIT / math.pi
        )
        resolution = 2 * _MERCATOR_LIMIT / (512 * 2 ** view["zoom"])
        expected_bbox = (
            center_x - claim.width * resolution / 2,
            center_y - claim.height * resolution / 2,
            center_x + claim.width * resolution / 2,
            center_y + claim.height * resolution / 2,
        )
        if (
            claim.bbox is None
            or len(claim.bbox) != 4
            or any(
                not _number(actual, -1e9, 1e9) or abs(actual - expected) > 1e-6
                for actual, expected in zip(claim.bbox, expected_bbox, strict=True)
            )
            or any(abs(value) > _MERCATOR_LIMIT for value in expected_bbox)
            or claim.background_color not in (None, first["background"])
        ):
            _fail("saved_map_gl_view_mismatch")
        occurrences = []
        total_bytes = total_features = total_coordinates = 0
        ids: set[str] = set()
        pattern_images: dict[str, Any] = {}
        for path, layer, config in zip(sources, layers, configurations, strict=True):
            marker = config["saved_map"]
            if (
                marker["pass_count"] != len(layers)
                or layer.resource_id != claim.resource_id
                or config["map_view"] != view
                or config["background"] != first["background"]
                or config["renderer"] != first["renderer"]
                or config.get("runtime_ref") != first.get("runtime_ref")
                or any(
                    marker[key] != first["saved_map"][key]
                    for key in ("recipe_checksum_sha256", "definition_checksum_sha256")
                )
            ):
                _fail("saved_map_gl_sequence_invalid")
            source = _source(path, layer)
            total_bytes += layer.source.size_bytes
            total_features += len(source["features"])
            total_coordinates += _source_features(source, marker["source_geometry_type"])
            if (
                total_bytes > _MAX_SOURCE_BYTES
                or total_features > 5_000
                or total_coordinates > 200_000
            ):
                _fail("saved_map_gl_input_limit")
            style = config["maplibre_style"]
            labels = _validate_style(style, config["font_ref"])
            for identifier, image in style.get("metadata", {}).get("opengeo:patterns", {}).items():
                if identifier in pattern_images and pattern_images[identifier] != image:
                    _fail("saved_map_gl_pattern_identity_mismatch")
                pattern_images[identifier] = image
            for part in style["layers"]:
                if part["id"] in ids:
                    _fail("saved_map_gl_layer_identity_mismatch")
                ids.add(part["id"])
            occurrences.append(
                {
                    "position": layer.position,
                    "style": style,
                    "source": source,
                    "fontRef": config["font_ref"],
                    "requiredCodepoints": _required_codepoints(labels, source),
                }
            )
        request = {
            "schema": "opengeo.maplibre-render-request.1.0.0",
            "maplibreVersion": "5.24.0",
            "width": claim.width,
            "height": claim.height,
            "view": view,
            "background": first["background"],
            "occurrences": occurrences,
        }
        if first["renderer"] == PINNED_GL_RENDERER:
            request["runtimeReference"] = runtime_reference(first["runtime_ref"])
            # The verified immutable package determines the engine for pinned jobs.
            del request["maplibreVersion"]
        self._runtime.render(request, target)
        try:
            with target.open("rb") as output:
                content = output.read(20_971_521)
        except OSError as error:
            raise ValidationFailure("saved_map_gl_output_invalid") from error
        if (
            not 32 <= len(content) <= 20_971_520
            or content[:8] != b"\x89PNG\r\n\x1a\n"
            or content[12:16] != b"IHDR"
            or struct.unpack(">II", content[16:24]) != (claim.width, claim.height)
            or content[-12:] != b"\x00\x00\x00\x00IEND\xaeB`\x82"
        ):
            _fail("saved_map_gl_output_invalid")

    @staticmethod
    def _configuration(layer: RenderLayerClaim) -> dict[str, Any]:
        try:
            return MapLibreCompositionRenderer._read_configuration(layer)
        except (KeyError, TypeError, ValueError, OverflowError, RecursionError) as error:
            raise ValidationFailure("saved_map_gl_configuration_invalid") from error

    @staticmethod
    def _read_configuration(layer: RenderLayerClaim) -> dict[str, Any]:
        config = layer.configuration
        _bounded_json(config)
        encoded = json.dumps(config, separators=(",", ":"), sort_keys=True).encode()
        if (
            set(config)
            != (
                _CONFIG_KEYS | {"runtime_ref"}
                if config.get("renderer") == PINNED_GL_RENDERER
                else _CONFIG_KEYS
            )
            or len(encoded) > 32_768
            or sha256(encoded).hexdigest() != layer.configuration_checksum_sha256
            or config["schema_version"] != "1.0.0"
            or config["renderer"] not in (GL_RENDERER, PINNED_GL_RENDERER)
            or config["output_crs"] != "EPSG:4326"
            or not isinstance(config["background"], str)
            or not re.fullmatch(r"#[0-9a-f]{6}", config["background"])
        ):
            _fail()
        if config["renderer"] == PINNED_GL_RENDERER:
            runtime_reference(config["runtime_ref"])
        marker, identity = config["saved_map"], config["source_style"]
        if (
            not isinstance(marker, dict)
            or set(marker) != _MARKER_KEYS
            or marker["schema"] != GL_OCCURRENCE_SCHEMA
            or marker["position"] != layer.position
            or type(marker["position"]) is not int
            or not _number(marker["pass_count"], 1, 16)
            or type(marker["pass_count"]) is not int
            or marker["dataset_id"] != str(layer.dataset_id)
            or marker["dataset_version_id"] != str(layer.dataset_version_id)
            or not isinstance(marker["layer_id"], str)
            or not 1 <= len(marker["layer_id"]) <= 256
            or marker["source_geometry_type"]
            not in {
                "Point",
                "MultiPoint",
                "LineString",
                "MultiLineString",
                "Polygon",
                "MultiPolygon",
            }
            or any(
                not isinstance(marker[key], str) or not _HASH.fullmatch(marker[key])
                for key in (
                    "recipe_checksum_sha256",
                    "definition_checksum_sha256",
                    "style_checksum_sha256",
                )
            )
            or not isinstance(identity, dict)
            or set(identity) != _STYLE_IDENTITY_KEYS
            or identity["style_id"] != str(layer.style_id)
            or identity["style_version_id"] != str(layer.style_version_id)
            or type(identity["style_version_number"]) is not int
            or identity["style_version_number"] < 1
            or identity["style_checksum_sha256"] != marker["style_checksum_sha256"]
            or sha256(_canonical(config["maplibre_style"]).encode()).hexdigest()
            != marker["style_checksum_sha256"]
        ):
            _fail("saved_map_gl_identity_mismatch")
        font = config["font_ref"]
        if font is not None and (
            not isinstance(font, dict)
            or set(font) != {"id", "version", "manifestChecksumSha256"}
            or not isinstance(font["id"], str)
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", font["id"])
            or type(font["version"]) is not int
            or not 1 <= font["version"] <= 2_147_483_647
            or not isinstance(font["manifestChecksumSha256"], str)
            or not _HASH.fullmatch(font["manifestChecksumSha256"])
        ):
            _fail("saved_map_gl_font_identity_mismatch")
        return config


class DispatchingMapRenderer:
    """Opt in only explicitly marked GL occurrences; preserve all legacy bytes."""

    def __init__(
        self,
        *,
        gl: MapLibreCompositionRenderer | None = None,
        legacy: Any = None,
    ) -> None:
        self._gl = gl or MapLibreCompositionRenderer()
        self._legacy = legacy or DeterministicSvgRenderer()

    def render(self, source: Path, claim: RenderClaim, target: Path) -> None:
        renderer = (
            self._gl
            if (claim.configuration or {}).get("renderer") in (GL_RENDERER, PINNED_GL_RENDERER)
            else self._legacy
        )
        renderer.render(source, claim, target)

    def render_composition(
        self,
        sources: Sequence[Path],
        layers: Sequence[RenderLayerClaim],
        claim: RenderClaim,
        target: Path,
    ) -> None:
        flags = [
            layer.configuration.get("renderer") in (GL_RENDERER, PINNED_GL_RENDERER)
            for layer in layers
        ]
        if any(flags) and not all(flags):
            _fail("saved_map_gl_mixed_composition")
        renderer = self._gl if flags and all(flags) else self._legacy
        renderer.render_composition(sources, layers, claim, target)
