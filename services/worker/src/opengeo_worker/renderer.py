import html
import json
import math
import re
import struct
import zlib
from array import array
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from itertools import pairwise
from pathlib import Path
from typing import cast
from uuid import UUID

from opengeo_worker.bitmap_font import glyph
from opengeo_worker.models import RenderClaim, RenderLayerClaim, ValidationFailure

_COLOR = re.compile(r"#[0-9a-f]{6}(?:[0-9a-f]{2})?")
_MAX_SOURCE_BYTES = 16_777_216
_MAX_OUTPUT_BYTES = 20_971_520
_MAX_FEATURES = 5_000
_MAX_COORDINATES = 200_000
_MAX_JSON_NODES = 500_000
_MAX_RASTER_OPERATIONS = 50_000_000
_MAX_HEATMAP_KERNEL_OPERATIONS = 10_000_000
_MAX_HEATMAP_CELLS = 262_144
_MAX_ABSOLUTE_REQUEST_COORDINATE = 1_000_000_000.0
_WEB_MERCATOR_LIMIT = 20_037_508.342789244
_WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
_SAVED_MAP_PASS_SCHEMA = "opengeo.saved-map-pass.1.0.0"
_SAVED_MAP_MARKER_KEYS = {
    "schema",
    "recipe_checksum_sha256",
    "definition_checksum_sha256",
    "style_checksum_sha256",
    "layer_id",
    "geometry_layer_id",
    "source_geometry_type",
    "input_geometry",
    "position",
    "pass_count",
    "dataset_id",
    "dataset_version_id",
}


class _DeflateBits:
    """Write the least-significant-bit-first fields used by DEFLATE."""

    def __init__(self) -> None:
        self.encoded = bytearray()
        self.pending = 0
        self.pending_bits = 0

    def write(self, value: int, width: int) -> None:
        self.pending |= value << self.pending_bits
        self.pending_bits += width
        while self.pending_bits >= 8:
            self.encoded.append(self.pending & 0xFF)
            self.pending >>= 8
            self.pending_bits -= 8

    def finish(self) -> bytes:
        if self.pending_bits:
            self.encoded.append(self.pending & 0xFF)
        return bytes(self.encoded)


_DEFLATE_LENGTH_BASE = (
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    13,
    15,
    17,
    19,
    23,
    27,
    31,
    35,
    43,
    51,
    59,
    67,
    83,
    99,
    115,
    131,
    163,
    195,
    227,
    258,
)
_DEFLATE_LENGTH_EXTRA = (
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
)
_DEFLATE_DISTANCE_BASE = (
    1,
    2,
    3,
    4,
    5,
    7,
    9,
    13,
    17,
    25,
    33,
    49,
    65,
    97,
    129,
    193,
    257,
    385,
    513,
    769,
    1025,
    1537,
    2049,
    3073,
    4097,
    6145,
    8193,
    12289,
    16385,
    24577,
)
_DEFLATE_DISTANCE_EXTRA = (
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
)


def _reverse_bits(value: int, width: int) -> int:
    reversed_value = 0
    for _ in range(width):
        reversed_value = (reversed_value << 1) | (value & 1)
        value >>= 1
    return reversed_value


def _write_fixed_symbol(bits: _DeflateBits, symbol: int) -> None:
    if 0 <= symbol <= 143:
        code, width = 0x30 + symbol, 8
    elif symbol <= 255:
        code, width = 0x190 + symbol - 144, 9
    elif symbol <= 279:
        code, width = symbol - 256, 7
    elif symbol <= 287:
        code, width = 0xC0 + symbol - 280, 8
    else:
        raise ValueError("fixed_deflate_symbol_out_of_range")
    bits.write(_reverse_bits(code, width), width)


def _write_length_distance(bits: _DeflateBits, length: int, distance: int) -> None:
    length_index = next(
        index for index, base in reversed(tuple(enumerate(_DEFLATE_LENGTH_BASE))) if length >= base
    )
    length_base = _DEFLATE_LENGTH_BASE[length_index]
    length_extra = _DEFLATE_LENGTH_EXTRA[length_index]
    _write_fixed_symbol(bits, 257 + length_index)
    if length_extra:
        bits.write(length - length_base, length_extra)

    distance_index = next(
        index
        for index, base in reversed(tuple(enumerate(_DEFLATE_DISTANCE_BASE)))
        if distance >= base
    )
    distance_base = _DEFLATE_DISTANCE_BASE[distance_index]
    distance_extra = _DEFLATE_DISTANCE_EXTRA[distance_index]
    bits.write(_reverse_bits(distance_index, 5), 5)
    if distance_extra:
        bits.write(distance - distance_base, distance_extra)


def _canonical_zlib_compress(content: bytes) -> bytes:
    """Return one canonical fixed-Huffman zlib stream without library encoder drift."""

    bits = _DeflateBits()
    bits.write(1, 1)  # BFINAL
    bits.write(1, 2)  # BTYPE=01, fixed Huffman codes
    slot_count = 65_536
    slot_keys = array("i", [-1]) * slot_count
    slot_positions = array("i", [-1]) * slot_count

    def remember(position: int) -> None:
        if position + 2 >= len(content):
            return
        key = (content[position] << 16) | (content[position + 1] << 8) | content[position + 2]
        slot = ((key * 2_654_435_761) & 0xFFFFFFFF) >> 16
        slot_keys[slot] = key
        slot_positions[slot] = position

    position = 0
    while position < len(content):
        length = 0
        distance = 0
        if position + 2 < len(content):
            key = (content[position] << 16) | (content[position + 1] << 8) | content[position + 2]
            slot = ((key * 2_654_435_761) & 0xFFFFFFFF) >> 16
            candidate = slot_positions[slot]
            if slot_keys[slot] == key and 0 < position - candidate <= 32_768:
                maximum = min(258, len(content) - position)
                length = 3
                while (
                    length < maximum and content[candidate + length] == content[position + length]
                ):
                    length += 1
                distance = position - candidate
        if length >= 3:
            _write_length_distance(bits, length, distance)
            for remembered in range(position, position + length):
                remember(remembered)
            position += length
        else:
            _write_fixed_symbol(bits, content[position])
            remember(position)
            position += 1

    _write_fixed_symbol(bits, 256)
    checksum = zlib.adler32(content) & 0xFFFFFFFF
    return b"\x78\x01" + bits.finish() + struct.pack(">I", checksum)


@dataclass(frozen=True, slots=True)
class _RenderStyle:
    renderer_version: int
    geometry_type: str
    color: str
    opacity: float
    width: float
    radius: float
    outline_color: str
    outline_width: float
    classification_field: str | None
    classification_rules: tuple[tuple[object, str, str], ...]
    label_field: str | None
    label_size: float
    label_color: str
    label_halo_color: str
    label_halo_width: float
    minimum_scale: float | None
    maximum_scale: float | None
    legend_enabled: bool
    legend_title: str
    background: str
    heatmap_colors: tuple[str, str, str]
    heatmap_intensity: float
    saved_map_source_geometry: str | None = None
    polygon_boundary: bool = False


@dataclass(frozen=True, slots=True)
class _LabelCandidate:
    x: float
    y: float
    value: str
    style: _RenderStyle
    layer_position: int | None = None


class DeterministicSvgRenderer:
    """Render a deliberately bounded GeoJSON/MapLibre subset without network or scripts."""

    def render(self, source: Path, claim: RenderClaim, target: Path) -> None:
        claim.require_claimed()
        assert claim.configuration is not None
        assert claim.configuration_checksum_sha256 is not None
        assert claim.bbox is not None
        assert claim.crs is not None
        assert claim.width is not None
        assert claim.height is not None
        assert claim.format in {"svg", "png"}
        self._verify_configuration(claim.configuration, claim.configuration_checksum_sha256)
        saved_map = self._verify_saved_map_claim(claim.configuration, claim)
        if saved_map is not None and (saved_map["position"] != 1 or saved_map["pass_count"] != 1):
            raise ValidationFailure("saved_map_pass_sequence_invalid")
        style = self._style(claim.configuration)
        if (
            claim.background_color is not None
            and re.fullmatch(r"#[0-9a-f]{6}", claim.background_color) is None
        ):
            raise ValidationFailure("render_request_invalid")
        render_background = claim.background_color or style.background
        document = self._document(source)
        features = document.get("features")
        if not isinstance(features, list) or len(features) > _MAX_FEATURES:
            raise ValidationFailure("render_feature_count_invalid")
        west, south, east, north = claim.bbox
        bbox_supported = (
            west < east
            and south < north
            and all(math.isfinite(value) for value in claim.bbox)
            and all(abs(value) <= _MAX_ABSOLUTE_REQUEST_COORDINATE for value in claim.bbox)
        )
        if not (
            bbox_supported
            and 1 <= claim.width <= 2048
            and 1 <= claim.height <= 2048
            and claim.width * claim.height <= 4_194_304
        ):
            raise ValidationFailure("render_request_invalid")
        scale = (
            ((east - west) * 111_319.49079327358 / claim.width) / 0.00028
            if claim.crs == "CRS:84"
            else ((east - west) / claim.width) / 0.00028
        )
        visible = not (
            (style.minimum_scale is not None and scale < style.minimum_scale)
            or (style.maximum_scale is not None and scale > style.maximum_scale)
        )
        body: list[str] = []
        labels: list[tuple[float, float, str]] = []
        heatmap_points: list[tuple[float, float]] = []
        heatmap_metrics: dict[str, object] | None = None
        coordinate_count = 0
        rendered_features = 0
        if visible:
            for index, raw_feature in enumerate(features):
                if not isinstance(raw_feature, dict) or raw_feature.get("type") != "Feature":
                    raise ValidationFailure("render_feature_invalid")
                properties_value = raw_feature.get("properties", {})
                if not isinstance(properties_value, dict) or len(properties_value) > 256:
                    raise ValidationFailure("render_properties_invalid")
                properties = cast(dict[str, object], properties_value)
                geometry = raw_feature.get("geometry")
                if geometry is None:
                    continue
                rendered, anchor, used, matched = self._feature(
                    geometry,
                    style,
                    properties,
                    index,
                    claim.bbox,
                    claim.width,
                    claim.height,
                    claim.crs,
                    heatmap_points=heatmap_points,
                )
                coordinate_count += used
                if coordinate_count > _MAX_COORDINATES:
                    raise ValidationFailure("render_coordinate_count_exceeded")
                if rendered:
                    body.extend(rendered)
                if matched:
                    rendered_features += 1
                if anchor is not None and style.label_field is not None:
                    value = properties.get(style.label_field)
                    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                        label = str(value).strip()
                        if label and len(label) <= 80:
                            labels.append((anchor[0], anchor[1], label))
        if heatmap_points:
            heatmap, heatmap_metrics = self._heatmap(
                heatmap_points,
                style,
                claim.width,
                claim.height,
            )
            body.extend(heatmap)
        legend_elements: list[str] = []
        occupied: list[tuple[float, float, float, float]] = []
        if style.legend_enabled:
            legend_elements = self._legend(style, claim.width, claim.height)
            occupied.append(self._legend_box(style, claim.width, claim.height))
        placed_labels = self._labels(
            labels,
            style,
            claim.width,
            claim.height,
            occupied=occupied,
        )
        body.extend(placed_labels)
        body.extend(legend_elements)
        metadata: dict[str, object] = {
            "schema": "opengeo.render.result.v1",
            "renderer": f"opengeo.deterministic-{claim.format}.v{style.renderer_version}",
            "render_job_id": str(claim.job_id),
            "profile_id": str(claim.profile_id),
            "profile_version_id": str(claim.profile_version_id),
            "dataset_id": str(claim.dataset_id),
            "dataset_version_id": str(claim.dataset_version_id),
            "style_id": str(claim.style_id),
            "style_version_id": str(claim.style_version_id),
            "configuration_checksum_sha256": claim.configuration_checksum_sha256,
            "request_checksum_sha256": claim.request_checksum_sha256,
            "bbox": list(claim.bbox),
            "output_crs": "EPSG:4326" if claim.crs == "CRS:84" else claim.crs,
            "width": claim.width,
            "height": claim.height,
            "scale_denominator": round(scale, 6),
            "scale_visible": visible,
            "source_checksum_sha256": claim.source.checksum_sha256 if claim.source else None,
            "source_feature_count": len(features),
            "rendered_feature_count": rendered_features,
            "coordinate_count": coordinate_count,
            "placed_label_count": len(placed_labels),
        }
        if heatmap_metrics is not None:
            metadata["heatmap"] = heatmap_metrics
        if saved_map is not None:
            metadata["saved_map"] = saved_map
        if style.renderer_version == 2 and (labels or legend_elements):
            metadata["text_font"] = "opengeo-uppercase-5x7-v1"
        if claim.background_color is not None:
            metadata["background_color"] = claim.background_color
        if claim.transparent:
            metadata["transparent"] = True
        metadata_json = json.dumps(metadata, separators=(",", ":"), sort_keys=True)
        metadata_text = html.escape(metadata_json, quote=False)
        svg_body = body if style.renderer_version == 1 else self._svg_elements(body)
        svg = "".join(
            [
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{claim.width}" '
                f'height="{claim.height}" viewBox="0 0 {claim.width} {claim.height}" '
                'role="img" aria-label="Governed OpenGeo map render">',
                f"<metadata>{metadata_text}</metadata>",
                (
                    ""
                    if claim.transparent
                    else f'<rect width="{claim.width}" height="{claim.height}" '
                    f'fill="{render_background}"/>'
                ),
                '<defs><clipPath id="map-clip"><rect width="100%" height="100%"/>'
                "</clipPath></defs>",
                '<g clip-path="url(#map-clip)">',
                *svg_body,
                "</g></svg>\n",
            ]
        )
        encoded = (
            svg.encode("utf-8")
            if claim.format == "svg"
            else self._png(
                body,
                render_background,
                claim.width,
                claim.height,
                metadata_json,
                claim.transparent,
            )
        )
        if not 1 <= len(encoded) <= _MAX_OUTPUT_BYTES:
            raise ValidationFailure("render_output_size_exceeded")
        try:
            target.write_bytes(encoded)
        except OSError as error:
            raise ValidationFailure("render_output_unavailable") from error

    def render_composition(
        self,
        sources: Sequence[Path],
        layers: Sequence[RenderLayerClaim],
        claim: RenderClaim,
        target: Path,
    ) -> None:
        claim.require_claimed()
        assert claim.bbox is not None
        assert claim.crs is not None
        assert claim.width is not None
        assert claim.height is not None
        assert claim.format in {"svg", "png"}
        if (
            not 2 <= len(layers) <= 16
            or len(sources) != len(layers)
            or tuple(layer.position for layer in layers) != tuple(range(1, len(layers) + 1))
            or layers[0].resource_id != claim.resource_id
            or layers[0].profile_id != claim.profile_id
            or layers[0].profile_version_id != claim.profile_version_id
        ):
            raise ValidationFailure("render_composition_invalid")
        saved_maps = [self._verify_saved_map_claim(layer.configuration, layer) for layer in layers]
        if any(marker is not None for marker in saved_maps):
            first_marker = saved_maps[0]
            if first_marker is None or any(
                marker is None
                or marker["position"] != position
                or marker["pass_count"] != len(layers)
                or marker["recipe_checksum_sha256"] != first_marker["recipe_checksum_sha256"]
                or marker["definition_checksum_sha256"]
                != first_marker["definition_checksum_sha256"]
                for position, marker in enumerate(saved_maps, 1)
            ):
                raise ValidationFailure("saved_map_pass_sequence_invalid")
        if (
            claim.background_color is not None
            and re.fullmatch(r"#[0-9a-f]{6}", claim.background_color) is None
        ):
            raise ValidationFailure("render_request_invalid")
        west, south, east, north = claim.bbox
        if not (
            west < east
            and south < north
            and all(math.isfinite(value) for value in claim.bbox)
            and all(abs(value) <= _MAX_ABSOLUTE_REQUEST_COORDINATE for value in claim.bbox)
            and 1 <= claim.width <= 2048
            and 1 <= claim.height <= 2048
            and claim.width * claim.height <= 4_194_304
        ):
            raise ValidationFailure("render_request_invalid")
        if sum(source.stat().st_size for source in sources if source.is_file()) > _MAX_SOURCE_BYTES:
            raise ValidationFailure("render_source_invalid")
        scale = (
            ((east - west) * 111_319.49079327358 / claim.width) / 0.00028
            if claim.crs == "CRS:84"
            else ((east - west) / claim.width) / 0.00028
        )
        body: list[str] = []
        layer_metadata: list[dict[str, object]] = []
        label_candidates: list[_LabelCandidate] = []
        legend_styles: list[tuple[int, _RenderStyle]] = []
        total_features = 0
        total_coordinates = 0
        first_background: str | None = None
        for source, layer in zip(sources, layers, strict=True):
            self._verify_configuration(layer.configuration, layer.configuration_checksum_sha256)
            style = self._style(layer.configuration)
            if first_background is None:
                first_background = style.background
            document = self._document(source)
            features = document.get("features")
            if not isinstance(features, list):
                raise ValidationFailure("render_feature_count_invalid")
            total_features += len(features)
            if total_features > _MAX_FEATURES:
                raise ValidationFailure("render_feature_count_invalid")
            visible = not (
                (style.minimum_scale is not None and scale < style.minimum_scale)
                or (style.maximum_scale is not None and scale > style.maximum_scale)
            )
            rendered_features = 0
            layer_coordinates = 0
            layer_label_candidates = 0
            layer_heatmap_points: list[tuple[float, float]] = []
            layer_heatmap_metrics: dict[str, object] | None = None
            if visible:
                if style.legend_enabled:
                    legend_styles.append((layer.position, style))
                for index, raw_feature in enumerate(features):
                    if not isinstance(raw_feature, dict) or raw_feature.get("type") != "Feature":
                        raise ValidationFailure("render_feature_invalid")
                    properties_value = raw_feature.get("properties", {})
                    if not isinstance(properties_value, dict) or len(properties_value) > 256:
                        raise ValidationFailure("render_properties_invalid")
                    geometry = raw_feature.get("geometry")
                    if geometry is None:
                        continue
                    properties = cast(dict[str, object], properties_value)
                    rendered, anchor, used, matched = self._feature(
                        geometry,
                        style,
                        properties,
                        index,
                        claim.bbox,
                        claim.width,
                        claim.height,
                        claim.crs,
                        identifier_prefix=f"layer-{layer.position}-",
                        heatmap_points=layer_heatmap_points,
                    )
                    layer_coordinates += used
                    total_coordinates += used
                    if total_coordinates > _MAX_COORDINATES:
                        raise ValidationFailure("render_coordinate_count_exceeded")
                    if rendered:
                        body.extend(rendered)
                    if matched:
                        rendered_features += 1
                    if anchor is not None and style.label_field is not None:
                        value = properties.get(style.label_field)
                        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                            label_value = str(value).strip()
                            if label_value and len(label_value) <= 80:
                                label_candidates.append(
                                    _LabelCandidate(
                                        anchor[0],
                                        anchor[1],
                                        label_value,
                                        style,
                                        layer.position,
                                    )
                                )
                                layer_label_candidates += 1
                if layer_heatmap_points:
                    heatmap, layer_heatmap_metrics = self._heatmap(
                        layer_heatmap_points,
                        style,
                        claim.width,
                        claim.height,
                        identifier_prefix=f"layer-{layer.position}-",
                    )
                    body.extend(heatmap)
            layer_metadata.append(
                {
                    "position": layer.position,
                    "resource_id": str(layer.resource_id),
                    "profile_id": str(layer.profile_id),
                    "profile_version_id": str(layer.profile_version_id),
                    "dataset_id": str(layer.dataset_id),
                    "dataset_version_id": str(layer.dataset_version_id),
                    "style_id": str(layer.style_id),
                    "style_version_id": str(layer.style_version_id),
                    "configuration_checksum_sha256": layer.configuration_checksum_sha256,
                    "source_checksum_sha256": layer.source.checksum_sha256,
                    "source_feature_count": len(features),
                    "rendered_feature_count": rendered_features,
                    "coordinate_count": layer_coordinates,
                    "scale_visible": visible,
                    "label_candidate_count": layer_label_candidates,
                    "placed_label_count": 0,
                    **(
                        {"saved_map": saved_maps[layer.position - 1]}
                        if saved_maps[layer.position - 1] is not None
                        else {}
                    ),
                    **(
                        {"heatmap": layer_heatmap_metrics}
                        if layer_heatmap_metrics is not None
                        else {}
                    ),
                }
            )
        assert first_background is not None
        legend_elements: list[str] = []
        occupied: list[tuple[float, float, float, float]] = []
        if legend_styles:
            legend_elements, legend_box = self._composition_legend(
                legend_styles,
                claim.width,
                claim.height,
            )
            occupied.append(legend_box)
        ordered_candidates = sorted(
            label_candidates,
            key=lambda candidate: -(candidate.layer_position or 0),
        )
        placements = self._place_labels(
            ordered_candidates,
            claim.width,
            claim.height,
            occupied=occupied,
        )
        body.extend(element for _, element in placements)
        body.extend(legend_elements)
        placed_by_layer: dict[int, int] = {}
        for candidate, _ in placements:
            assert candidate.layer_position is not None
            placed_by_layer[candidate.layer_position] = (
                placed_by_layer.get(candidate.layer_position, 0) + 1
            )
        for layer_result in layer_metadata:
            position = cast(int, layer_result["position"])
            layer_result["placed_label_count"] = placed_by_layer.get(position, 0)
        render_background = claim.background_color or first_background
        metadata: dict[str, object] = {
            "schema": "opengeo.render.composition.result.v1",
            "renderer": f"opengeo.deterministic-{claim.format}.v2",
            "render_job_id": str(claim.job_id),
            "request_checksum_sha256": claim.request_checksum_sha256,
            "bbox": list(claim.bbox),
            "output_crs": "EPSG:4326" if claim.crs == "CRS:84" else claim.crs,
            "width": claim.width,
            "height": claim.height,
            "scale_denominator": round(scale, 6),
            "layer_count": len(layers),
            "layers": layer_metadata,
            "source_feature_count": total_features,
            "coordinate_count": total_coordinates,
            "label_candidate_count": len(label_candidates),
            "placed_label_count": len(placements),
            "legend_layer_count": len(legend_styles),
        }
        if label_candidates or legend_styles:
            metadata["text_font"] = "opengeo-uppercase-5x7-v1"
        if claim.background_color is not None:
            metadata["background_color"] = claim.background_color
        if claim.transparent:
            metadata["transparent"] = True
        metadata_json = json.dumps(metadata, separators=(",", ":"), sort_keys=True)
        metadata_text = html.escape(metadata_json, quote=False)
        svg_body = self._svg_elements(body)
        svg = "".join(
            [
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{claim.width}" '
                f'height="{claim.height}" viewBox="0 0 {claim.width} {claim.height}" '
                'role="img" aria-label="Governed OpenGeo composed map render">',
                f"<metadata>{metadata_text}</metadata>",
                (
                    ""
                    if claim.transparent
                    else f'<rect width="{claim.width}" height="{claim.height}" '
                    f'fill="{render_background}"/>'
                ),
                '<defs><clipPath id="map-clip"><rect width="100%" height="100%"/>'
                "</clipPath></defs>",
                '<g clip-path="url(#map-clip)">',
                *svg_body,
                "</g></svg>\n",
            ]
        )
        encoded = (
            svg.encode("utf-8")
            if claim.format == "svg"
            else self._png(
                body,
                render_background,
                claim.width,
                claim.height,
                metadata_json,
                claim.transparent,
            )
        )
        if not 1 <= len(encoded) <= _MAX_OUTPUT_BYTES:
            raise ValidationFailure("render_output_size_exceeded")
        try:
            target.write_bytes(encoded)
        except OSError as error:
            raise ValidationFailure("render_output_unavailable") from error

    @classmethod
    def _svg_elements(cls, elements: Sequence[str]) -> list[str]:
        return [
            cls._svg_text_path(element) if element.startswith("<text ") else element
            for element in elements
        ]

    @classmethod
    def _svg_text_path(cls, element: str) -> str:
        content = re.search(r">(.*?)</text>$", element)
        if content is None:
            raise ValidationFailure("render_svg_text_invalid")
        value = html.unescape(content.group(1))
        x = float(cls._attribute(element, "x"))
        baseline_y = float(cls._attribute(element, "y"))
        size = float(cls._attribute(element, "font-size"))
        anchor = cls._optional_attribute(element, "text-anchor") or "start"
        if not value or len(value) > 100 or anchor not in {"start", "middle"}:
            raise ValidationFailure("render_svg_text_invalid")
        scale_x = max(1, round(size / 11))
        scale_y = max(1, round(size / 7))
        advance = 6 * scale_x
        origin_x = (
            round(x - (len(value) * advance - scale_x) / 2) if anchor == "middle" else round(x)
        )
        origin_y = round(baseline_y - 7 * scale_y)
        commands: list[str] = []
        for character_index, character in enumerate(value):
            for row, bits in enumerate(glyph(character)):
                for column, bit in enumerate(bits):
                    if bit == "1":
                        left = origin_x + character_index * advance + column * scale_x
                        top = origin_y + row * scale_y
                        commands.append(f"M{left} {top}h{scale_x}v{scale_y}h-{scale_x}Z")
        path = "".join(commands)
        fill = cls._attribute(element, "fill")
        halo = cls._optional_attribute(element, "stroke") or fill
        halo_width = float(cls._optional_attribute(element, "stroke-width") or "0")
        if not 0 <= halo_width <= 4:
            raise ValidationFailure("render_svg_text_invalid")
        layer_position = cls._optional_attribute(element, "data-opengeo-layer-position")
        layer_attribute = (
            "" if layer_position is None else f' data-opengeo-layer-position="{layer_position}"'
        )
        accessible = html.escape(value, quote=True)
        return (
            f'<g role="img" aria-label="{accessible}" '
            f'data-opengeo-font="uppercase-5x7-v1"{layer_attribute}>'
            f"<title>{html.escape(value, quote=False)}</title>"
            f'<path d="{path}" fill="{fill}" stroke="{halo}" '
            f'stroke-width="{halo_width * 2:g}" stroke-linejoin="round" '
            'paint-order="stroke"/></g>'
        )

    @classmethod
    def _png(
        cls,
        elements: Sequence[str],
        background: str,
        width: int,
        height: int,
        metadata_json: str,
        transparent: bool = False,
    ) -> bytes:
        canvas = _RasterCanvas(width, height, background, transparent=transparent)
        for element in elements:
            if element.startswith(("<polyline ", "<polygon ")):
                points = [
                    tuple(float(number) for number in pair.split(","))
                    for pair in cls._attribute(element, "points").split()
                ]
                canvas.polyline(
                    cast(list[tuple[float, float]], points),
                    cls._attribute(element, "stroke"),
                    float(cls._attribute(element, "stroke-opacity")),
                    float(cls._attribute(element, "stroke-width")),
                    butt_miter='stroke-linejoin="miter"' in element,
                )
            elif element.startswith("<circle "):
                canvas.circle(
                    float(cls._attribute(element, "cx")),
                    float(cls._attribute(element, "cy")),
                    float(cls._attribute(element, "r")),
                    cls._attribute(element, "fill"),
                    float(cls._attribute(element, "fill-opacity")),
                    cls._attribute(element, "stroke"),
                    float(cls._attribute(element, "stroke-width")),
                    separate_stroke='data-saved-map-pass="true"' in element,
                )
            elif element.startswith("<path "):
                rings: list[list[tuple[float, float]]] = []
                for ring_text in re.findall(r"M (.*?) Z", cls._attribute(element, "d")):
                    numbers = [
                        float(number) for number in re.findall(r"-?[0-9]+(?:\.[0-9]+)?", ring_text)
                    ]
                    if len(numbers) < 8 or len(numbers) % 2:
                        raise ValidationFailure("render_raster_geometry_invalid")
                    rings.append(list(zip(numbers[0::2], numbers[1::2], strict=True)))
                if not rings:
                    raise ValidationFailure("render_raster_geometry_invalid")
                canvas.polygon(
                    rings,
                    cls._attribute(element, "fill"),
                    float(cls._attribute(element, "fill-opacity")),
                    cls._attribute(element, "stroke"),
                    float(cls._attribute(element, "stroke-width")),
                )
            elif element.startswith("<rect "):
                canvas.rectangle(
                    float(cls._attribute(element, "x")),
                    float(cls._attribute(element, "y")),
                    float(cls._attribute(element, "width")),
                    float(cls._attribute(element, "height")),
                    cls._attribute(element, "fill"),
                    float(cls._optional_attribute(element, "fill-opacity") or "1"),
                    cls._optional_attribute(element, "stroke"),
                    float(cls._optional_attribute(element, "stroke-width") or "1"),
                )
            elif element.startswith("<text "):
                content = re.search(r">(.*?)</text>$", element)
                if content is None:
                    raise ValidationFailure("render_raster_element_invalid")
                canvas.text(
                    float(cls._attribute(element, "x")),
                    float(cls._attribute(element, "y")),
                    html.unescape(content.group(1)),
                    float(cls._attribute(element, "font-size")),
                    cls._attribute(element, "fill"),
                    cls._optional_attribute(element, "stroke") or cls._attribute(element, "fill"),
                    float(cls._optional_attribute(element, "stroke-width") or "0"),
                    cls._optional_attribute(element, "text-anchor") or "start",
                )
            else:
                raise ValidationFailure("render_raster_element_unsupported")
        return canvas.png(metadata_json)

    @staticmethod
    def _attribute(element: str, name: str) -> str:
        match = re.search(rf'(?:^| )({re.escape(name)})="([^"]*)"', element)
        if match is None:
            raise ValidationFailure("render_raster_element_invalid")
        return match.group(2)

    @staticmethod
    def _optional_attribute(element: str, name: str) -> str | None:
        match = re.search(rf'(?:^| )({re.escape(name)})="([^"]*)"', element)
        return None if match is None else match.group(2)

    @staticmethod
    def _verify_configuration(configuration: dict[str, object], checksum: str) -> None:
        encoded = json.dumps(configuration, separators=(",", ":"), sort_keys=True).encode()
        renderer = configuration.get("renderer")
        if (
            len(encoded) > 32_768
            or not re.fullmatch(r"[0-9a-f]{64}", checksum)
            or sha256(encoded).hexdigest() != checksum
            or configuration.get("schema") != "opengeo.render.v1"
            or renderer
            not in {
                "opengeo.deterministic-svg.v1",
                "opengeo.deterministic-svg.v2",
            }
            or configuration.get("output_crs") != "EPSG:4326"
        ):
            raise ValidationFailure("render_configuration_invalid")
        DeterministicSvgRenderer._saved_map_marker(configuration)

    @staticmethod
    def _saved_map_marker(configuration: Mapping[str, object]) -> dict[str, object] | None:
        if "saved_map" not in configuration:
            return None
        marker = configuration["saved_map"]
        geometry = configuration.get("geometry")
        source_style = configuration.get("source_style")
        if (
            not isinstance(marker, dict)
            or set(marker) != _SAVED_MAP_MARKER_KEYS
            or marker.get("schema") != _SAVED_MAP_PASS_SCHEMA
            or configuration.get("renderer") != "opengeo.deterministic-svg.v2"
            or not isinstance(geometry, dict)
            or not isinstance(source_style, dict)
        ):
            raise ValidationFailure("saved_map_pass_invalid")
        for field in (
            "recipe_checksum_sha256",
            "definition_checksum_sha256",
            "style_checksum_sha256",
        ):
            if (
                not isinstance(marker[field], str)
                or re.fullmatch(r"[0-9a-f]{64}", marker[field]) is None
            ):
                raise ValidationFailure("saved_map_pass_invalid")
        try:
            for value in (
                marker["dataset_id"],
                marker["dataset_version_id"],
                source_style.get("style_id"),
                source_style.get("style_version_id"),
            ):
                if not isinstance(value, str) or str(UUID(value)) != value:
                    raise ValueError
        except ValueError as error:
            raise ValidationFailure("saved_map_pass_invalid") from error
        for field in ("position", "pass_count"):
            if (
                isinstance(marker[field], bool)
                or not isinstance(marker[field], int)
                or not 1 <= marker[field] <= 16
            ):
                raise ValidationFailure("saved_map_pass_invalid")
        if marker["position"] > marker["pass_count"]:
            raise ValidationFailure("saved_map_pass_invalid")
        for field, limit in (("layer_id", 160), ("geometry_layer_id", 100)):
            if (
                not isinstance(marker[field], str)
                or re.fullmatch(rf"[A-Za-z0-9][A-Za-z0-9._:-]{{0,{limit - 1}}}", marker[field])
                is None
            ):
                raise ValidationFailure("saved_map_pass_invalid")
        source_geometry = marker["source_geometry_type"]
        symbol = geometry.get("type")
        expected_symbol = (
            {
                "Point": "circle",
                "MultiPoint": "circle",
                "LineString": "line",
                "MultiLineString": "line",
                "Polygon": "fill",
                "MultiPolygon": "fill",
            }.get(source_geometry)
            if isinstance(source_geometry, str)
            else None
        )
        boundary = marker["input_geometry"] == "polygon-boundary"
        if (
            expected_symbol is None
            or (boundary and (expected_symbol != "fill" or symbol != "line"))
            or (
                not boundary and (marker["input_geometry"] != "native" or symbol != expected_symbol)
            )
            or configuration.get("label") is not None
            or configuration.get("legend")
            != {"enabled": False, "title": marker["geometry_layer_id"]}
            or configuration.get("scale")
            != {"minimum_denominator": None, "maximum_denominator": None}
            or configuration.get("background") != "#061526"
            or source_style.get("checksum_sha256") != marker["style_checksum_sha256"]
            or source_style.get("geometry_layer_id") != marker["geometry_layer_id"]
            or source_style.get("label_layer_id") is not None
            or isinstance(source_style.get("style_version_number"), bool)
            or not isinstance(source_style.get("style_version_number"), int)
            or source_style["style_version_number"] < 1
            or (
                symbol == "fill"
                and (
                    geometry.get("outline_width") != 0
                    or geometry.get("outline_color") != "#00000000"
                )
            )
        ):
            raise ValidationFailure("saved_map_pass_invalid")
        return cast(dict[str, object], marker)

    @classmethod
    def _verify_saved_map_claim(
        cls, configuration: Mapping[str, object], claim: RenderClaim | RenderLayerClaim
    ) -> dict[str, object] | None:
        marker = cls._saved_map_marker(configuration)
        if marker is None:
            return None
        source_style = cast(dict[str, object], configuration["source_style"])
        if (
            marker["dataset_id"] != str(claim.dataset_id)
            or marker["dataset_version_id"] != str(claim.dataset_version_id)
            or source_style["style_id"] != str(claim.style_id)
            or source_style["style_version_id"] != str(claim.style_version_id)
        ):
            raise ValidationFailure("saved_map_pass_identity_mismatch")
        return marker

    @staticmethod
    def _document(source: Path) -> dict[str, object]:
        try:
            if not source.is_file() or not 1 <= source.stat().st_size <= _MAX_SOURCE_BYTES:
                raise ValidationFailure("render_source_invalid")
            document = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise ValidationFailure("render_source_invalid") from error
        if not isinstance(document, dict) or document.get("type") != "FeatureCollection":
            raise ValidationFailure("render_source_invalid")
        nodes = 0
        stack: list[object] = [document]
        while stack:
            value = stack.pop()
            nodes += 1
            if nodes > _MAX_JSON_NODES:
                raise ValidationFailure("render_source_complexity_exceeded")
            if isinstance(value, dict):
                stack.extend(value.keys())
                stack.extend(value.values())
            elif isinstance(value, list):
                stack.extend(value)
        return cast(dict[str, object], document)

    @classmethod
    def _style(cls, configuration: Mapping[str, object]) -> _RenderStyle:
        saved_map = cls._saved_map_marker(configuration)
        geometry = configuration.get("geometry")
        label = configuration.get("label")
        scale = configuration.get("scale")
        legend = configuration.get("legend")
        if (
            not isinstance(geometry, dict)
            or geometry.get("type") not in {"fill", "line", "circle", "heatmap"}
            or not isinstance(scale, dict)
            or not isinstance(legend, dict)
        ):
            raise ValidationFailure("render_configuration_invalid")
        geometry_type = cast(str, geometry["type"])
        renderer_version = (
            2 if configuration.get("renderer") == "opengeo.deterministic-svg.v2" else 1
        )
        classification_value = geometry.get("classification")
        classification_field = None
        classification_rules: list[tuple[object, str, str]] = []
        if classification_value is not None:
            if not isinstance(classification_value, dict):
                raise ValidationFailure("render_configuration_invalid")
            field = classification_value.get("field")
            rules = classification_value.get("rules")
            if not isinstance(field, str) or not isinstance(rules, list) or len(rules) > 16:
                raise ValidationFailure("render_configuration_invalid")
            classification_field = field
            for rule in rules:
                if not isinstance(rule, dict):
                    raise ValidationFailure("render_configuration_invalid")
                classification_rules.append(
                    (rule.get("value"), cls._color(rule.get("color")), str(rule.get("label")))
                )
        if geometry_type == "heatmap" and classification_value is not None:
            raise ValidationFailure("render_configuration_invalid")
        if (
            geometry_type == "heatmap"
            and renderer_version == 2
            and (
                geometry.get("kernel") != "mapserver-gaussian"
                or geometry.get("normalization") != "positive-minimum-over-visible-peak"
                or geometry.get("quantization_levels") != 31
            )
        ):
            raise ValidationFailure("render_configuration_invalid")
        heatmap_colors_value = geometry.get("colors", ["#2c7bb6", "#ffffbf", "#d7191c"])
        if not isinstance(heatmap_colors_value, list) or len(heatmap_colors_value) != 3:
            raise ValidationFailure("render_configuration_invalid")
        heatmap_colors = cast(
            tuple[str, str, str], tuple(cls._color(value) for value in heatmap_colors_value)
        )
        label_field = None
        label_size = 12.0
        label_color = "#172824"
        label_halo_color = "#ffffff"
        label_halo_width = 1.0
        if label is not None:
            if not isinstance(label, dict) or not isinstance(label.get("field"), str):
                raise ValidationFailure("render_configuration_invalid")
            if renderer_version == 2 and label.get("font") != "opengeo-uppercase-5x7-v1":
                raise ValidationFailure("render_configuration_invalid")
            label_field = cast(str, label["field"])
            label_size = cls._number(label.get("size"), 6, 32)
            label_color = cls._color(label.get("color"))
            label_halo_color = cls._color(label.get("halo_color"))
            label_halo_width = cls._number(label.get("halo_width"), 0, 4)
        minimum = cls._optional_number(scale.get("minimum_denominator"), 1, 1_000_000_000)
        maximum = cls._optional_number(scale.get("maximum_denominator"), 1, 1_000_000_000)
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ValidationFailure("render_configuration_invalid")
        title = legend.get("title")
        background = configuration.get("background")
        if not isinstance(title, str) or len(title) > 100 or not isinstance(background, str):
            raise ValidationFailure("render_configuration_invalid")
        return _RenderStyle(
            renderer_version=renderer_version,
            geometry_type=geometry_type,
            color=cls._color(geometry.get("color")),
            opacity=cls._number(geometry.get("opacity"), 0, 1),
            width=cls._number(geometry.get("width", 1), 0.25, 20),
            radius=cls._number(
                geometry.get("radius", 4), 1, 64 if geometry_type == "heatmap" else 32
            ),
            outline_color=cls._color(
                geometry.get("outline_color", geometry.get("stroke_color", "#173f35"))
            ),
            outline_width=cls._number(
                geometry.get("outline_width", geometry.get("stroke_width", 1)), 0, 8
            ),
            classification_field=classification_field,
            classification_rules=tuple(classification_rules),
            label_field=label_field,
            label_size=label_size,
            label_color=label_color,
            label_halo_color=label_halo_color,
            label_halo_width=label_halo_width,
            minimum_scale=minimum,
            maximum_scale=maximum,
            legend_enabled=legend.get("enabled") is True,
            legend_title=title,
            background=cls._color(background),
            heatmap_colors=heatmap_colors,
            heatmap_intensity=cls._number(geometry.get("intensity", 1), 0.1, 4),
            saved_map_source_geometry=cast(str, saved_map["source_geometry_type"])
            if saved_map
            else None,
            polygon_boundary=saved_map is not None
            and saved_map["input_geometry"] == "polygon-boundary",
        )

    @classmethod
    def _feature(
        cls,
        geometry: object,
        style: _RenderStyle,
        properties: Mapping[str, object],
        index: int,
        bbox: tuple[float, float, float, float],
        width: int,
        height: int,
        crs: str,
        identifier_prefix: str = "",
        heatmap_points: list[tuple[float, float]] | None = None,
    ) -> tuple[list[str], tuple[float, float] | None, int, bool]:
        if not isinstance(geometry, dict):
            raise ValidationFailure("render_geometry_invalid")
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates")
        expected = {
            "circle": {"Point", "MultiPoint"},
            "heatmap": {"Point", "MultiPoint"},
            "line": {"LineString", "MultiLineString"},
            "fill": {"Polygon", "MultiPolygon"},
        }[style.geometry_type]
        if style.polygon_boundary:
            expected = {"Polygon", "MultiPolygon"}
        if geometry_type not in expected:
            if style.saved_map_source_geometry is not None:
                raise ValidationFailure("saved_map_source_geometry_mismatch")
            return [], None, cls._count_coordinates(coordinates), False
        color = style.color
        if style.classification_field is not None:
            value = properties.get(style.classification_field)
            for expected_value, rule_color, _ in style.classification_rules:
                if type(value) is type(expected_value) and value == expected_value:
                    color = rule_color
                    break
        parts = cls._coordinate_parts(cast(str, geometry_type), coordinates)
        used = sum(len(part) for part in parts)
        projected = [
            [cls._project(point, bbox, width, height, crs) for point in part] for part in parts
        ]
        identifier = f"{identifier_prefix}feature-{index + 1}"
        elements: list[str] = []
        if style.geometry_type in {"circle", "heatmap"}:
            part_number = 0
            for part in projected:
                for x, y in part:
                    part_number += 1
                    if style.geometry_type == "circle":
                        saved_circle = style.saved_map_source_geometry is not None
                        radius = (
                            style.radius + style.outline_width / 2 if saved_circle else style.radius
                        )
                        elements.append(
                            f'<circle id="{identifier}-part-{part_number}" '
                            f'cx="{x:.3f}" cy="{y:.3f}" '
                            f'r="{radius:g}" fill="{color}" fill-opacity="{style.opacity:g}" '
                            f'stroke="{style.outline_color}" '
                            f'stroke-width="{style.outline_width:g}"'
                            + (' data-saved-map-pass="true"/>' if saved_circle else "/>")
                        )
                    else:
                        if style.renderer_version == 1:
                            for band, (factor, band_color, alpha) in enumerate(
                                zip(
                                    (1.0, 0.64, 0.3),
                                    style.heatmap_colors,
                                    (0.12, 0.2, 0.32),
                                    strict=True,
                                ),
                                1,
                            ):
                                opacity = min(
                                    1.0,
                                    style.opacity * style.heatmap_intensity * alpha,
                                )
                                elements.append(
                                    f'<circle id="{identifier}-part-{part_number}-band-{band}" '
                                    f'cx="{x:.3f}" cy="{y:.3f}" '
                                    f'r="{style.radius * factor:.3f}" '
                                    f'fill="{band_color}" fill-opacity="{opacity:.4f}" '
                                    f'stroke="{band_color}" stroke-width="0"/>'
                                )
                        else:
                            if heatmap_points is None:
                                raise ValidationFailure("render_heatmap_accumulator_missing")
                            heatmap_points.append((x, y))
        elif style.geometry_type == "line":
            for part_number, part in enumerate(projected, 1):
                point_text = " ".join(f"{x:.3f},{y:.3f}" for x, y in part)
                tag = "polygon" if style.polygon_boundary else "polyline"
                elements.append(
                    f'<{tag} id="{identifier}-part-{part_number}" '
                    f'points="{point_text}" fill="none" '
                    f'stroke="{color}" stroke-opacity="{style.opacity:g}" '
                    f'stroke-width="{style.width:g}" '
                    + (
                        'stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="2"/>'
                        if style.saved_map_source_geometry is not None
                        else 'stroke-linecap="round" stroke-linejoin="round"/>'
                    )
                )
        else:
            path = " ".join(
                "M " + " L ".join(f"{x:.3f} {y:.3f}" for x, y in part) + " Z" for part in projected
            )
            elements.append(
                f'<path id="{identifier}" d="{path}" fill="{color}" '
                f'fill-opacity="{style.opacity:g}" fill-rule="evenodd" '
                f'stroke="{style.outline_color}" stroke-width="{style.outline_width:g}"/>'
            )
        point_values = [point for part in projected for point in part]
        anchor = (
            (
                sum(point[0] for point in point_values) / len(point_values),
                sum(point[1] for point in point_values) / len(point_values),
            )
            if point_values
            else None
        )
        return elements, anchor, used, bool(point_values)

    @classmethod
    def _coordinate_parts(
        cls, geometry_type: str, coordinates: object
    ) -> list[list[tuple[float, float]]]:
        if geometry_type == "Point":
            return [[cls._point(coordinates)]]
        if geometry_type == "MultiPoint":
            return [cls._points(coordinates)]
        if geometry_type == "LineString":
            parts = [cls._points(coordinates)]
            cls._validate_linear_parts(parts, minimum=2, closed=False)
            return parts
        if geometry_type == "MultiLineString":
            parts = cls._lines(coordinates)
            cls._validate_linear_parts(parts, minimum=2, closed=False)
            return parts
        if geometry_type == "Polygon":
            parts = cls._lines(coordinates)
            cls._validate_linear_parts(parts, minimum=4, closed=True)
            return parts
        if geometry_type == "MultiPolygon":
            if not isinstance(coordinates, list) or len(coordinates) > 1_000:
                raise ValidationFailure("render_geometry_invalid")
            parts = [part for polygon in coordinates for part in cls._lines(polygon)]
            cls._validate_linear_parts(parts, minimum=4, closed=True)
            return parts
        raise ValidationFailure("render_geometry_invalid")

    @staticmethod
    def _validate_linear_parts(
        parts: list[list[tuple[float, float]]], *, minimum: int, closed: bool
    ) -> None:
        if any(len(part) < minimum or (closed and part[0] != part[-1]) for part in parts):
            raise ValidationFailure("render_geometry_invalid")

    @classmethod
    def _lines(cls, value: object) -> list[list[tuple[float, float]]]:
        if not isinstance(value, list) or not value or len(value) > _MAX_COORDINATES:
            raise ValidationFailure("render_geometry_invalid")
        return [cls._points(part) for part in value]

    @classmethod
    def _points(cls, value: object) -> list[tuple[float, float]]:
        if not isinstance(value, list) or not value or len(value) > _MAX_COORDINATES:
            raise ValidationFailure("render_geometry_invalid")
        return [cls._point(point) for point in value]

    @staticmethod
    def _point(value: object) -> tuple[float, float]:
        if not isinstance(value, list) or len(value) < 2:
            raise ValidationFailure("render_coordinate_invalid")
        x, y = value[0], value[1]
        if (
            isinstance(x, bool)
            or isinstance(y, bool)
            or not isinstance(x, (int, float))
            or not isinstance(y, (int, float))
            or not math.isfinite(float(x))
            or not math.isfinite(float(y))
            or not -180 <= float(x) <= 180
            or not -90 <= float(y) <= 90
        ):
            raise ValidationFailure("render_coordinate_invalid")
        return float(x), float(y)

    @classmethod
    def _count_coordinates(cls, value: object) -> int:
        count = 0
        stack = [value]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                if len(item) >= 2 and all(
                    isinstance(number, (int, float)) and not isinstance(number, bool)
                    for number in item[:2]
                ):
                    count += 1
                else:
                    stack.extend(item)
            if count > _MAX_COORDINATES:
                raise ValidationFailure("render_coordinate_count_exceeded")
        return count

    @staticmethod
    def _project(
        point: tuple[float, float],
        bbox: tuple[float, float, float, float],
        width: int,
        height: int,
        crs: str,
    ) -> tuple[float, float]:
        west, south, east, north = bbox
        point_x, point_y = point
        if crs == "EPSG:3857":
            point_x = point_x * _WEB_MERCATOR_LIMIT / 180
            latitude = max(
                -_WEB_MERCATOR_LATITUDE_LIMIT,
                min(_WEB_MERCATOR_LATITUDE_LIMIT, point_y),
            )
            point_y = (
                _WEB_MERCATOR_LIMIT * math.log(math.tan((90 + latitude) * math.pi / 360)) / math.pi
            )
        x = (point_x - west) / (east - west) * width
        y = (north - point_y) / (north - south) * height
        return max(-8192.0, min(width + 8192.0, x)), max(-8192.0, min(height + 8192.0, y))

    @classmethod
    def _heatmap(
        cls,
        points: Sequence[tuple[float, float]],
        style: _RenderStyle,
        width: int,
        height: int,
        *,
        identifier_prefix: str = "",
    ) -> tuple[list[str], dict[str, object]]:
        if style.geometry_type != "heatmap" or style.renderer_version != 2 or not points:
            raise ValidationFailure("render_heatmap_invalid")
        cell_size = max(1, math.ceil(max(width, height) / 256))
        while True:
            radius_cells = max(1, round(style.radius / cell_size))
            columns = math.ceil(width / cell_size)
            rows = math.ceil(height / cell_size)
            estimated_operations = len(points) + 2 * columns * rows * (radius_cells * 2 + 1)
            if (
                estimated_operations <= _MAX_HEATMAP_KERNEL_OPERATIONS
                and columns * rows <= _MAX_HEATMAP_CELLS
            ):
                break
            cell_size += 1
            if cell_size > max(width, height):
                raise ValidationFailure("render_heatmap_complexity_exceeded")
        values = [0.0] * (columns * rows)
        operations = len(points)
        for point_x, point_y in points:
            if 0 <= point_x < width and 0 <= point_y < height:
                column = min(columns - 1, math.floor(point_x / cell_size))
                row = min(rows - 1, math.floor(point_y / cell_size))
                values[row * columns + column] += 1
        sigma = radius_cells / 3
        amplitude = 1 / math.sqrt(2 * math.pi * sigma * sigma)
        denominator = 2 * sigma * sigma
        kernel = [
            amplitude * math.exp(-(offset * offset) / denominator)
            for offset in range(-radius_cells, radius_cells + 1)
        ]
        horizontal = [0.0] * (columns * rows)
        for row in range(rows):
            offset = row * columns
            for column in range(radius_cells, columns - radius_cells):
                horizontal[offset + column] = sum(
                    values[offset + column + kernel_offset] * weight
                    for kernel_offset, weight in zip(
                        range(-radius_cells, radius_cells + 1),
                        kernel,
                        strict=True,
                    )
                )
                operations += len(kernel)
        density = [0.0] * (columns * rows)
        for column in range(columns):
            for row in range(radius_cells, rows - radius_cells):
                density[row * columns + column] = sum(
                    horizontal[(row + kernel_offset) * columns + column] * weight
                    for kernel_offset, weight in zip(
                        range(-radius_cells, radius_cells + 1),
                        kernel,
                        strict=True,
                    )
                )
                operations += len(kernel)
        if operations > _MAX_HEATMAP_KERNEL_OPERATIONS:
            raise ValidationFailure("render_heatmap_complexity_exceeded")
        positive = [value for value in density if value > 0]
        peak = max(positive, default=0.0)
        minimum = min(positive, default=0.0)
        elements: list[str] = []
        if peak > 0:
            for row in range(rows):
                for column in range(columns):
                    raw_density = density[row * columns + column]
                    if raw_density <= minimum:
                        continue
                    normalized = min(
                        1.0,
                        max(0.0, (raw_density - minimum) / peak) * style.heatmap_intensity,
                    )
                    level = max(1, min(31, math.ceil(normalized * 31)))
                    quantized = level / 31
                    color = cls._heatmap_color(style.heatmap_colors, quantized)
                    x = column * cell_size
                    y = row * cell_size
                    cell_width = min(cell_size, width - x)
                    cell_height = min(cell_size, height - y)
                    elements.append(
                        f'<rect id="{identifier_prefix}density-{column}-{row}" '
                        f'x="{x}" y="{y}" width="{cell_width}" height="{cell_height}" '
                        f'fill="{color}" fill-opacity="{style.opacity:g}"/>'
                    )
        return elements, {
            "algorithm": "mapserver-gaussian-grid-v1",
            "normalization": "positive-minimum-over-visible-peak",
            "quantization_levels": 31,
            "input_point_count": len(points),
            "radius_pixels": style.radius,
            "effective_radius_cells": radius_cells,
            "sigma_cells": round(sigma, 6),
            "intensity": style.heatmap_intensity,
            "cell_size_pixels": cell_size,
            "grid": [columns, rows],
            "kernel_operations": operations,
            "occupied_cell_count": len(elements),
            "positive_minimum_weight": round(minimum, 9),
            "peak_weight": round(peak, 6),
        }

    @staticmethod
    def _heatmap_color(colors: tuple[str, str, str], value: float) -> str:
        if not 0 <= value <= 1:
            raise ValidationFailure("render_heatmap_invalid")
        if value <= 0.5:
            first, second, fraction = colors[0], colors[1], value * 2
        else:
            first, second, fraction = colors[1], colors[2], (value - 0.5) * 2

        def rgba(color: str) -> tuple[int, int, int, int]:
            return (
                int(color[1:3], 16),
                int(color[3:5], 16),
                int(color[5:7], 16),
                int(color[7:9], 16) if len(color) == 9 else 255,
            )

        mixed = tuple(
            round(start + (end - start) * fraction)
            for start, end in zip(rgba(first), rgba(second), strict=True)
        )
        encoded = "#" + "".join(f"{component:02x}" for component in mixed)
        return encoded[:7] if mixed[3] == 255 else encoded

    @classmethod
    def _labels(
        cls,
        labels: Sequence[tuple[float, float, str]],
        style: _RenderStyle,
        width: int,
        height: int,
        *,
        occupied: Sequence[tuple[float, float, float, float]] = (),
    ) -> list[str]:
        placements = cls._place_labels(
            [_LabelCandidate(x, y, label, style) for x, y, label in labels],
            width,
            height,
            occupied=occupied,
        )
        return [element for _, element in placements]

    @staticmethod
    def _place_labels(
        labels: Sequence[_LabelCandidate],
        width: int,
        height: int,
        *,
        occupied: Sequence[tuple[float, float, float, float]] = (),
    ) -> list[tuple[_LabelCandidate, str]]:
        used_boxes = list(occupied)
        result: list[tuple[_LabelCandidate, str]] = []
        for candidate in labels:
            label_width = min(
                width,
                max(
                    candidate.style.label_size,
                    len(candidate.value) * candidate.style.label_size * 0.62,
                ),
            )
            box = (
                candidate.x - label_width / 2 - 2,
                candidate.y - candidate.style.label_size - 2,
                candidate.x + label_width / 2 + 2,
                candidate.y + 4,
            )
            if box[2] < 0 or box[0] > width or box[3] < 0 or box[1] > height:
                continue
            if any(
                box[0] < other[2] and box[2] > other[0] and box[1] < other[3] and box[3] > other[1]
                for other in used_boxes
            ):
                continue
            used_boxes.append(box)
            escaped = html.escape(candidate.value, quote=False)
            layer_attribute = (
                ""
                if candidate.layer_position is None
                else f' data-opengeo-layer-position="{candidate.layer_position}"'
            )
            result.append(
                (
                    candidate,
                    f'<text x="{candidate.x:.3f}" y="{candidate.y:.3f}" text-anchor="middle"'
                    f"{layer_attribute} "
                    'font-family="sans-serif" '
                    f'font-size="{candidate.style.label_size:g}" '
                    f'fill="{candidate.style.label_color}" '
                    f'stroke="{candidate.style.label_halo_color}" '
                    f'stroke-width="{candidate.style.label_halo_width:g}" '
                    f'paint-order="stroke">{escaped}</text>',
                )
            )
        return result

    @staticmethod
    def _legend_entries(style: _RenderStyle) -> list[tuple[str, str]]:
        if style.geometry_type == "heatmap" and style.renderer_version == 2:
            return list(zip(("Low", "Medium", "High"), style.heatmap_colors, strict=True))
        return [(label, color) for _, color, label in style.classification_rules] or [
            (style.legend_title, style.color)
        ]

    @classmethod
    def _legend_box(
        cls, style: _RenderStyle, width: int, height: int
    ) -> tuple[float, float, float, float]:
        entries = cls._legend_entries(style)
        box_width = min(220, max(120, max(len(label) for label, _ in entries) * 7 + 44))
        box_height = 30 + len(entries) * 22
        if box_width + 24 > width or box_height + 24 > height:
            raise ValidationFailure("render_legend_exceeds_canvas")
        x = max(8, width - box_width - 12)
        y = max(8, height - box_height - 12)
        return float(x), float(y), float(x + box_width), float(y + box_height)

    @classmethod
    def _legend(cls, style: _RenderStyle, width: int, height: int) -> list[str]:
        entries = cls._legend_entries(style)
        x, y, right, bottom = cls._legend_box(style, width, height)
        box_width = right - x
        box_height = bottom - y
        result = [
            f'<rect x="{x:g}" y="{y:g}" width="{box_width:g}" height="{box_height:g}" '
            'rx="4" fill="#ffffff" fill-opacity="0.94" stroke="#667085"/>',
            f'<text x="{x + 10:g}" y="{y + 18:g}" font-family="sans-serif" '
            f'font-size="12" font-weight="bold" fill="#172824">'
            f"{html.escape(style.legend_title, quote=False)}</text>",
        ]
        for index, (label, color) in enumerate(entries):
            row_y = y + 30 + index * 22
            result.extend(
                [
                    f'<rect x="{x + 10:g}" y="{row_y:g}" width="14" height="14" fill="{color}"/>',
                    f'<text x="{x + 31:g}" y="{row_y + 12:g}" font-family="sans-serif" '
                    f'font-size="11" fill="#172824">{html.escape(label, quote=False)}</text>',
                ]
            )
        return result

    @classmethod
    def _composition_legend(
        cls,
        styles: Sequence[tuple[int, _RenderStyle]],
        width: int,
        height: int,
    ) -> tuple[list[str], tuple[float, float, float, float]]:
        rows: list[tuple[str, str, str | None]] = []
        for position, style in reversed(styles):
            rows.append(("heading", f"{position}. {style.legend_title}", None))
            rows.extend(("entry", label, color) for label, color in cls._legend_entries(style))
        row_height = 18
        maximum_rows = max(1, (height - 32) // row_height)
        columns = math.ceil(len(rows) / maximum_rows)
        column_width = min(220, max(140, max(len(label) for _, label, _ in rows) * 7 + 38))
        box_width = columns * column_width + 16
        rows_in_tallest_column = min(maximum_rows, len(rows))
        box_height = rows_in_tallest_column * row_height + 16
        if box_width + 24 > width or box_height + 24 > height:
            raise ValidationFailure("render_legend_exceeds_canvas")
        x = width - box_width - 12
        y = height - box_height - 12
        result = [
            f'<rect x="{x}" y="{y}" width="{box_width}" height="{box_height}" '
            'rx="4" fill="#ffffff" fill-opacity="0.94" stroke="#667085"/>'
        ]
        for index, (kind, label, color) in enumerate(rows):
            column = index // maximum_rows
            row = index % maximum_rows
            row_x = x + 8 + column * column_width
            baseline = y + 14 + row * row_height
            escaped = html.escape(label, quote=False)
            if kind == "heading":
                result.append(
                    f'<text x="{row_x}" y="{baseline}" font-family="sans-serif" '
                    f'font-size="11" font-weight="bold" fill="#172824">{escaped}</text>'
                )
            else:
                assert color is not None
                result.extend(
                    [
                        f'<rect x="{row_x}" y="{baseline - 11}" width="11" height="11" '
                        f'fill="{color}"/>',
                        f'<text x="{row_x + 17}" y="{baseline}" font-family="sans-serif" '
                        f'font-size="10" fill="#172824">{escaped}</text>',
                    ]
                )
        return result, (float(x), float(y), float(x + box_width), float(y + box_height))

    @staticmethod
    def _color(value: object) -> str:
        if not isinstance(value, str) or _COLOR.fullmatch(value) is None:
            raise ValidationFailure("render_configuration_invalid")
        return value

    @staticmethod
    def _number(value: object, minimum: float, maximum: float) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValidationFailure("render_configuration_invalid")
        number = float(value)
        if not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValidationFailure("render_configuration_invalid")
        return number

    @classmethod
    def _optional_number(cls, value: object, minimum: float, maximum: float) -> float | None:
        return None if value is None else cls._number(value, minimum, maximum)


class _RasterCanvas:
    """Small deterministic RGB/RGBA rasterizer for the renderer's bounded primitives."""

    def __init__(
        self, width: int, height: int, background: str, *, transparent: bool = False
    ) -> None:
        self.width = width
        self.height = height
        background_rgb, background_opacity = self._color(background)
        self.channels = 4 if transparent else 3
        base = (
            (*background_rgb, 0)
            if transparent
            else tuple(
                round(component * background_opacity + 255 * (1 - background_opacity))
                for component in background_rgb
            )
        )
        self.pixels = bytearray(bytes(base) * (width * height))
        self.operations = 0

    def polyline(
        self,
        points: Sequence[tuple[float, float]],
        color: str,
        opacity: float,
        width: float,
        *,
        butt_miter: bool = False,
    ) -> None:
        if len(points) < 2 or not 0 <= opacity <= 1 or not 0 < width <= 20:
            raise ValidationFailure("render_raster_geometry_invalid")
        rgb, alpha = self._color(color)
        effective_opacity = opacity * alpha
        radius = width / 2
        mask = bytearray(self.width * self.height)
        if butt_miter:
            self._butt_miter_polyline(mask, points, radius)
            self._budget(len(mask))
            for index, covered in enumerate(mask):
                if covered:
                    self._plot(index % self.width, index // self.width, rgb, effective_opacity)
            return
        for start, end in pairwise(points):
            dx, dy = end[0] - start[0], end[1] - start[1]
            steps = max(1, math.ceil(max(abs(dx), abs(dy))))
            self._budget(steps * max(1, math.ceil((2 * radius + 1) ** 2)))
            for step in range(steps + 1):
                fraction = step / steps
                self._mark_disc(
                    mask,
                    start[0] + dx * fraction,
                    start[1] + dy * fraction,
                    radius,
                )
        self._budget(len(mask))
        for index, covered in enumerate(mask):
            if covered:
                self._plot(index % self.width, index // self.width, rgb, effective_opacity)

    def _butt_miter_polyline(
        self, mask: bytearray, points: Sequence[tuple[float, float]], radius: float
    ) -> None:
        """Rasterize saved MapLibre butt/miter strokes, with its default limit 2.

        Union segment/join coverage before blending so an outline's opacity is
        applied once at shared vertices. Legacy round strokes keep their path.
        """
        distinct = [points[0]]
        distinct.extend(point for previous, point in pairwise(points) if point != previous)
        directions: list[tuple[float, float]] = []
        normals: list[tuple[float, float]] = []
        for start, end in pairwise(distinct):
            dx, dy = end[0] - start[0], end[1] - start[1]
            length = math.hypot(dx, dy)
            direction = (dx / length, dy / length)
            normal = (-direction[1] * radius, direction[0] * radius)
            directions.append(direction)
            normals.append(normal)
            self._mark_polygon(
                mask,
                [
                    (start[0] + normal[0], start[1] + normal[1]),
                    (end[0] + normal[0], end[1] + normal[1]),
                    (end[0] - normal[0], end[1] - normal[1]),
                    (start[0] - normal[0], start[1] - normal[1]),
                ],
            )
        closed = len(distinct) > 2 and distinct[0] == distinct[-1]
        for index in range(0 if closed else 1, len(distinct) - 1):
            before, after = directions[index - 1], directions[index]
            cross = before[0] * after[1] - before[1] * after[0]
            if abs(cross) < 1e-12:
                continue
            sign = -1 if cross > 0 else 1
            vertex = distinct[index]
            first = (
                vertex[0] + sign * normals[index - 1][0],
                vertex[1] + sign * normals[index - 1][1],
            )
            last = (vertex[0] + sign * normals[index][0], vertex[1] + sign * normals[index][1])
            distance = ((last[0] - first[0]) * after[1] - (last[1] - first[1]) * after[0]) / cross
            tip = (first[0] + distance * before[0], first[1] + distance * before[1])
            join = [vertex, first]
            if math.hypot(tip[0] - vertex[0], tip[1] - vertex[1]) <= 2 * radius:
                join.append(tip)
            join.append(last)
            self._mark_polygon(mask, join)

    def _mark_polygon(self, mask: bytearray, points: list[tuple[float, float]]) -> None:
        minimum_y = max(0, math.floor(min(point[1] for point in points)))
        maximum_y = min(self.height - 1, math.ceil(max(point[1] for point in points)))
        if minimum_y > maximum_y:
            return
        self._budget((maximum_y - minimum_y + 1) * (self.width + len(points)))
        ring = [*points, points[0]]
        for pixel_y in range(minimum_y, maximum_y + 1):
            scan_y = pixel_y + 0.5
            intersections = sorted(
                first[0] + (scan_y - first[1]) * (second[0] - first[0]) / (second[1] - first[1])
                for first, second in pairwise(ring)
                if (first[1] <= scan_y < second[1]) or (second[1] <= scan_y < first[1])
            )
            for left, right in zip(intersections[0::2], intersections[1::2], strict=False):
                for pixel_x in range(
                    max(0, math.ceil(left - 0.5)), min(self.width - 1, math.floor(right - 0.5)) + 1
                ):
                    mask[pixel_y * self.width + pixel_x] = 1

    def circle(
        self,
        center_x: float,
        center_y: float,
        radius: float,
        fill: str,
        fill_opacity: float,
        stroke: str,
        stroke_width: float,
        *,
        separate_stroke: bool = False,
    ) -> None:
        if (
            not 0 <= fill_opacity <= 1
            or not 0 < radius <= (36 if separate_stroke else 32)
            or not 0 <= stroke_width <= 8
        ):
            raise ValidationFailure("render_raster_geometry_invalid")
        fill_rgb, fill_alpha = self._color(fill)
        stroke_rgb, stroke_alpha = self._color(stroke)
        if separate_stroke:
            outer = radius + stroke_width / 2
            inner = max(0, radius - stroke_width / 2)
            minimum_x, maximum_x = (
                max(0, math.floor(center_x - outer)),
                min(self.width - 1, math.ceil(center_x + outer)),
            )
            minimum_y, maximum_y = (
                max(0, math.floor(center_y - outer)),
                min(self.height - 1, math.ceil(center_y + outer)),
            )
            if minimum_x > maximum_x or minimum_y > maximum_y:
                return
            self._budget((maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1))
            for pixel_y in range(minimum_y, maximum_y + 1):
                for pixel_x in range(minimum_x, maximum_x + 1):
                    distance = (pixel_x + 0.5 - center_x) ** 2 + (pixel_y + 0.5 - center_y) ** 2
                    if distance <= inner * inner:
                        self._plot(pixel_x, pixel_y, fill_rgb, fill_opacity * fill_alpha)
                    elif stroke_width > 0 and distance <= outer * outer:
                        self._plot(pixel_x, pixel_y, stroke_rgb, stroke_alpha)
            return
        if stroke_width == 0:
            self._disc(center_x, center_y, radius, fill_rgb, fill_opacity * fill_alpha)
            return
        outer_radius = radius + stroke_width / 2
        self._disc(center_x, center_y, outer_radius, stroke_rgb, stroke_alpha)
        self._disc(
            center_x,
            center_y,
            max(0.0, radius - stroke_width / 2),
            fill_rgb,
            fill_opacity * fill_alpha,
        )

    def polygon(
        self,
        rings: Sequence[Sequence[tuple[float, float]]],
        fill: str,
        fill_opacity: float,
        stroke: str,
        stroke_width: float,
    ) -> None:
        if (
            not rings
            or any(len(ring) < 4 or ring[0] != ring[-1] for ring in rings)
            or not 0 <= fill_opacity <= 1
            or not 0 <= stroke_width <= 8
        ):
            raise ValidationFailure("render_raster_geometry_invalid")
        fill_rgb, fill_alpha = self._color(fill)
        minimum_y = max(0, math.floor(min(point[1] for ring in rings for point in ring)))
        maximum_y = min(
            self.height - 1,
            math.ceil(max(point[1] for ring in rings for point in ring)),
        )
        if minimum_y <= maximum_y:
            scanlines = maximum_y - minimum_y + 1
            edge_count = sum(len(ring) - 1 for ring in rings)
            self._budget(scanlines * (self.width + edge_count))
            for pixel_y in range(minimum_y, maximum_y + 1):
                scan_y = pixel_y + 0.5
                intersections: list[float] = []
                for ring in rings:
                    for first, second in pairwise(ring):
                        if (first[1] <= scan_y < second[1]) or (second[1] <= scan_y < first[1]):
                            intersections.append(
                                first[0]
                                + (scan_y - first[1])
                                * (second[0] - first[0])
                                / (second[1] - first[1])
                            )
                intersections.sort()
                for left, right in zip(intersections[0::2], intersections[1::2], strict=False):
                    start_x = max(0, math.ceil(left - 0.5))
                    end_x = min(self.width - 1, math.floor(right - 0.5))
                    for pixel_x in range(start_x, end_x + 1):
                        self._plot(pixel_x, pixel_y, fill_rgb, fill_opacity * fill_alpha)
        if stroke_width:
            for ring in rings:
                self.polyline(ring, stroke, 1, stroke_width)

    def rectangle(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        fill: str,
        fill_opacity: float,
        stroke: str | None,
        stroke_width: float,
    ) -> None:
        finite_values = (x, y, width, height, fill_opacity, stroke_width)
        if (
            not all(math.isfinite(value) for value in finite_values)
            or width <= 0
            or height <= 0
            or not 0 <= fill_opacity <= 1
            or not 0 <= stroke_width <= 8
        ):
            raise ValidationFailure("render_raster_geometry_invalid")
        fill_rgb, fill_alpha = self._color(fill)
        minimum_x = max(0, math.floor(x))
        maximum_x = min(self.width - 1, math.ceil(x + width) - 1)
        minimum_y = max(0, math.floor(y))
        maximum_y = min(self.height - 1, math.ceil(y + height) - 1)
        if minimum_x > maximum_x or minimum_y > maximum_y:
            return
        self._budget((maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1))
        for pixel_y in range(minimum_y, maximum_y + 1):
            for pixel_x in range(minimum_x, maximum_x + 1):
                self._plot(pixel_x, pixel_y, fill_rgb, fill_opacity * fill_alpha)
        if stroke is not None and stroke_width > 0:
            ring = [
                (x, y),
                (x + width, y),
                (x + width, y + height),
                (x, y + height),
                (x, y),
            ]
            self.polyline(ring, stroke, 1, stroke_width)

    def text(
        self,
        x: float,
        baseline_y: float,
        value: str,
        size: float,
        color: str,
        halo_color: str,
        halo_width: float,
        anchor: str,
    ) -> None:
        if (
            not value
            or len(value) > 100
            or not 6 <= size <= 32
            or not 0 <= halo_width <= 4
            or anchor not in {"start", "middle"}
        ):
            raise ValidationFailure("render_raster_text_invalid")
        scale_x = max(1, round(size / 11))
        scale_y = max(1, round(size / 7))
        advance = 6 * scale_x
        origin_x = (
            round(x - (len(value) * advance - scale_x) / 2) if anchor == "middle" else round(x)
        )
        origin_y = round(baseline_y - 7 * scale_y)
        foreground, foreground_alpha = self._color(color)
        halo, halo_alpha = self._color(halo_color)
        ink: list[tuple[int, int]] = []
        for character_index, character in enumerate(value):
            for row, bits in enumerate(glyph(character)):
                for column, bit in enumerate(bits):
                    if bit == "1":
                        left = origin_x + character_index * advance + column * scale_x
                        top = origin_y + row * scale_y
                        ink.extend(
                            (left + offset_x, top + offset_y)
                            for offset_y in range(scale_y)
                            for offset_x in range(scale_x)
                        )
        halo_pixels = math.ceil(halo_width)
        halo_area = (halo_pixels * 2 + 1) ** 2 if halo_pixels else 0
        self._budget(len(ink) * (1 + halo_area))
        if halo_pixels:
            for pixel_x, pixel_y in ink:
                for offset_y in range(-halo_pixels, halo_pixels + 1):
                    for offset_x in range(-halo_pixels, halo_pixels + 1):
                        self._plot(pixel_x + offset_x, pixel_y + offset_y, halo, halo_alpha)
        for pixel_x, pixel_y in ink:
            self._plot(pixel_x, pixel_y, foreground, foreground_alpha)

    def png(self, metadata_json: str) -> bytes:
        rows = bytearray()
        stride = self.width * self.channels
        for row in range(self.height):
            rows.append(0)
            start = row * stride
            rows.extend(self.pixels[start : start + stride])
        color_type = 6 if self.channels == 4 else 2
        header = struct.pack(">IIBBBBB", self.width, self.height, 8, color_type, 0, 0, 0)
        metadata = b"OpenGeo\0" + metadata_json.encode("latin-1")
        return b"".join(
            (
                b"\x89PNG\r\n\x1a\n",
                self._chunk(b"IHDR", header),
                self._chunk(b"tEXt", metadata),
                self._chunk(b"IDAT", _canonical_zlib_compress(bytes(rows))),
                self._chunk(b"IEND", b""),
            )
        )

    def _disc(
        self,
        center_x: float,
        center_y: float,
        radius: float,
        color: tuple[int, int, int],
        opacity: float,
        *,
        budget: bool = True,
    ) -> None:
        minimum_x = max(0, math.floor(center_x - radius))
        maximum_x = min(self.width - 1, math.ceil(center_x + radius))
        minimum_y = max(0, math.floor(center_y - radius))
        maximum_y = min(self.height - 1, math.ceil(center_y + radius))
        if minimum_x > maximum_x or minimum_y > maximum_y:
            return
        if budget:
            self._budget((maximum_x - minimum_x + 1) * (maximum_y - minimum_y + 1))
        radius_squared = radius * radius
        for pixel_y in range(minimum_y, maximum_y + 1):
            for pixel_x in range(minimum_x, maximum_x + 1):
                if (pixel_x + 0.5 - center_x) ** 2 + (
                    pixel_y + 0.5 - center_y
                ) ** 2 <= radius_squared:
                    self._plot(pixel_x, pixel_y, color, opacity)

    def _mark_disc(
        self,
        mask: bytearray,
        center_x: float,
        center_y: float,
        radius: float,
    ) -> None:
        minimum_x = max(0, math.floor(center_x - radius))
        maximum_x = min(self.width - 1, math.ceil(center_x + radius))
        minimum_y = max(0, math.floor(center_y - radius))
        maximum_y = min(self.height - 1, math.ceil(center_y + radius))
        if minimum_x > maximum_x or minimum_y > maximum_y:
            return
        radius_squared = radius * radius
        for pixel_y in range(minimum_y, maximum_y + 1):
            for pixel_x in range(minimum_x, maximum_x + 1):
                if (pixel_x + 0.5 - center_x) ** 2 + (
                    pixel_y + 0.5 - center_y
                ) ** 2 <= radius_squared:
                    mask[pixel_y * self.width + pixel_x] = 1

    def _plot(
        self,
        x: int,
        y: int,
        color: tuple[int, int, int],
        opacity: float,
    ) -> None:
        if opacity <= 0 or not (0 <= x < self.width and 0 <= y < self.height):
            return
        offset = (y * self.width + x) * self.channels
        if self.channels == 4:
            if opacity >= 1:
                self.pixels[offset : offset + 4] = bytes((*color, 255))
                return
            destination_alpha = self.pixels[offset + 3] / 255
            output_alpha = opacity + destination_alpha * (1 - opacity)
            if output_alpha <= 0:
                return
            for channel, value in enumerate(color):
                existing = self.pixels[offset + channel]
                self.pixels[offset + channel] = round(
                    (value * opacity + existing * destination_alpha * (1 - opacity)) / output_alpha
                )
            self.pixels[offset + 3] = round(output_alpha * 255)
            return
        if opacity >= 1:
            self.pixels[offset : offset + 3] = bytes(color)
            return
        for channel, value in enumerate(color):
            existing = self.pixels[offset + channel]
            self.pixels[offset + channel] = round(value * opacity + existing * (1 - opacity))

    def _budget(self, operations: int) -> None:
        self.operations += operations
        if self.operations > _MAX_RASTER_OPERATIONS:
            raise ValidationFailure("render_raster_complexity_exceeded")

    @staticmethod
    def _color(value: str) -> tuple[tuple[int, int, int], float]:
        if _COLOR.fullmatch(value) is None:
            raise ValidationFailure("render_raster_color_invalid")
        rgb = tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))
        alpha = int(value[7:9], 16) / 255 if len(value) == 9 else 1.0
        return cast(tuple[int, int, int], rgb), alpha

    @staticmethod
    def _chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )
