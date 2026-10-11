import json
import math
import struct
import zlib
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from uuid import UUID
from xml.etree import ElementTree

import pytest

from opengeo_worker.models import (
    ObjectReference,
    RenderClaim,
    RenderLayerClaim,
    ValidationFailure,
)
from opengeo_worker.renderer import DeterministicSvgRenderer, _canonical_zlib_compress

FIXTURE = (
    Path(__file__).parents[3] / "parity" / "fixtures" / "mapserver" / "deterministic-roads.geojson"
)
GOLDEN = FIXTURE.with_suffix(".svg")


def test_canonical_zlib_stream_is_exact_and_round_trips() -> None:
    encoded = _canonical_zlib_compress(b"OpenGeo " * 100)

    assert encoded.hex() == "7801f32f48cd734fcd5718a547e9511a93060090ee1824"
    assert zlib.decompress(encoded) == b"OpenGeo " * 100


def configuration() -> dict[str, object]:
    return {
        "schema": "opengeo.render.v1",
        "renderer": "opengeo.deterministic-svg.v1",
        "output_crs": "EPSG:4326",
        "background": "#ffffff",
        "geometry": {
            "type": "line",
            "color": "#667085",
            "opacity": 0.85,
            "width": 3.0,
            "classification": {
                "field": "status",
                "rules": [
                    {"value": "open", "color": "#16815f", "label": "Open"},
                    {"value": "closed", "color": "#b42318", "label": "Closed"},
                ],
                "fallback_color": "#667085",
            },
        },
        "label": {
            "field": "name",
            "size": 11.0,
            "color": "#172824",
            "halo_color": "#ffffff",
            "halo_width": 1.0,
            "collision": "avoid",
            "maximum_length": 80,
        },
        "scale": {"minimum_denominator": None, "maximum_denominator": 2_000_000.0},
        "legend": {"enabled": True, "title": "Road status"},
        "source_style": {
            "format": "maplibre",
            "style_id": "a2000000-0000-4000-8000-000000000001",
            "style_version_id": "a3000000-0000-4000-8000-000000000001",
            "style_version_number": 1,
            "checksum_sha256": "a" * 64,
            "geometry_layer_id": "roads",
            "label_layer_id": "road-labels",
        },
        "conversion": {
            "status": "bounded_subset",
            "ignored_layer_ids": [],
            "unsupported_semantics_are_rejected": True,
        },
    }


def claim(config: dict[str, object] | None = None) -> RenderClaim:
    value = config or configuration()
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    source = FIXTURE.read_bytes()
    return RenderClaim(
        status="claimed",
        job_id=UUID("a6000000-0000-4000-8000-000000000001"),
        organization_id=UUID("10000000-0000-4000-8000-000000000001"),
        project_id=UUID("50000000-0000-4000-8000-000000000001"),
        resource_id=UUID("a0000000-0000-4000-8000-000000000001"),
        dataset_id=UUID("80000000-0000-4000-8000-000000000001"),
        dataset_version_id=UUID("82000000-0000-4000-8000-000000000001"),
        source=ObjectReference(
            UUID("81000000-0000-4000-8000-000000000001"),
            "opengeo-test-geodata",
            "organizations/source/derivatives/preview/preview.geojson",
            "preview-v1",
            "fedcba9876543210",
            "application/geo+json",
            len(source),
            sha256(source).hexdigest(),
        ),
        profile_id=UUID("a4000000-0000-4000-8000-000000000001"),
        profile_version_id=UUID("a5000000-0000-4000-8000-000000000001"),
        style_id=UUID("a2000000-0000-4000-8000-000000000001"),
        style_version_id=UUID("a3000000-0000-4000-8000-000000000001"),
        configuration=value,
        configuration_checksum_sha256=sha256(encoded).hexdigest(),
        bbox=(-71.15, 42.3, -71.0, 42.45),
        crs="CRS:84",
        width=640,
        height=480,
        format="svg",
        request_checksum_sha256="b" * 64,
        attempt_count=1,
        output_prefix="organizations/output/derivatives/",
    )


def composition_layers(
    first_config: dict[str, object], second_config: dict[str, object]
) -> tuple[RenderLayerClaim, RenderLayerClaim]:
    base = claim(first_config)
    assert base.source is not None
    assert base.resource_id is not None
    assert base.dataset_id is not None
    assert base.dataset_version_id is not None
    assert base.profile_id is not None
    assert base.profile_version_id is not None
    assert base.style_id is not None
    assert base.style_version_id is not None
    assert base.configuration_checksum_sha256 is not None
    second_checksum = sha256(
        json.dumps(second_config, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    return (
        RenderLayerClaim(
            position=1,
            resource_id=base.resource_id,
            dataset_id=base.dataset_id,
            dataset_version_id=base.dataset_version_id,
            source=base.source,
            profile_id=base.profile_id,
            profile_version_id=base.profile_version_id,
            style_id=base.style_id,
            style_version_id=base.style_version_id,
            configuration=first_config,
            configuration_checksum_sha256=base.configuration_checksum_sha256,
        ),
        RenderLayerClaim(
            position=2,
            resource_id=UUID("a0000000-0000-4000-8000-000000000002"),
            dataset_id=UUID("80000000-0000-4000-8000-000000000002"),
            dataset_version_id=UUID("82000000-0000-4000-8000-000000000002"),
            source=replace(
                base.source,
                object_id=UUID("81000000-0000-4000-8000-000000000002"),
                object_key="organizations/source-2/derivatives/preview/preview.geojson",
            ),
            profile_id=UUID("a4000000-0000-4000-8000-000000000002"),
            profile_version_id=UUID("a5000000-0000-4000-8000-000000000002"),
            style_id=UUID("a2000000-0000-4000-8000-000000000002"),
            style_version_id=UUID("a3000000-0000-4000-8000-000000000002"),
            configuration=second_config,
            configuration_checksum_sha256=second_checksum,
        ),
    )


def test_renders_deterministic_well_formed_svg_with_exact_lineage(tmp_path: Path) -> None:
    renderer = DeterministicSvgRenderer()
    first = tmp_path / "first.svg"
    second = tmp_path / "second.svg"

    renderer.render(FIXTURE, claim(), first)
    renderer.render(FIXTURE, claim(), second)

    assert first.read_bytes() == second.read_bytes()
    assert first.read_bytes() == GOLDEN.read_bytes()
    assert sha256(first.read_bytes()).hexdigest() == (
        "50d56cb3db2da34e14fcb0db1921e54b7fff086e4aba0716ea3fb00d58e80b9a"
    )
    root = ElementTree.fromstring(first.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["renderer"] == "opengeo.deterministic-svg.v1"
    assert metadata["dataset_version_id"] == "82000000-0000-4000-8000-000000000001"
    assert metadata["source_feature_count"] == 2
    assert metadata["rendered_feature_count"] == 2
    assert metadata["coordinate_count"] == 5
    assert metadata["placed_label_count"] == 2
    document = first.read_text()
    assert 'stroke="#16815f"' in document
    assert 'stroke="#b42318"' in document
    assert "Bridge &lt;repair&gt;" in document
    assert "<script" not in document


def test_configuration_checksum_and_source_complexity_fail_closed(tmp_path: Path) -> None:
    invalid = claim()
    object.__setattr__(invalid, "configuration_checksum_sha256", "0" * 64)
    with pytest.raises(ValidationFailure, match="render_configuration_invalid"):
        DeterministicSvgRenderer().render(FIXTURE, invalid, tmp_path / "invalid.svg")

    oversized = tmp_path / "oversized.geojson"
    oversized.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {}, "geometry": None} for _ in range(5_001)
                ],
            }
        )
    )
    with pytest.raises(ValidationFailure, match="render_feature_count_invalid"):
        DeterministicSvgRenderer().render(oversized, claim(), tmp_path / "oversized.svg")


def test_scale_rule_produces_a_valid_empty_map_without_silent_override(tmp_path: Path) -> None:
    config = configuration()
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": 10.0}
    target = tmp_path / "outside-scale.svg"

    DeterministicSvgRenderer().render(FIXTURE, claim(config), target)

    root = ElementTree.fromstring(target.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["scale_visible"] is False
    assert metadata["rendered_feature_count"] == 0


def test_renders_deterministic_epsg3857_png_with_embedded_lineage(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    web_mercator_claim = replace(
        claim(config),
        bbox=(-7_928_000.0, 5_206_000.0, -7_896_000.0, 5_230_000.0),
        crs="EPSG:3857",
        width=320,
        height=240,
        format="png",
    )
    first = tmp_path / "first.png"
    second = tmp_path / "second.png"

    renderer = DeterministicSvgRenderer()
    renderer.render(FIXTURE, web_mercator_claim, first)
    renderer.render(FIXTURE, web_mercator_claim, second)

    encoded = first.read_bytes()
    assert encoded == second.read_bytes()
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")
    assert struct.unpack(">II", encoded[16:24]) == (320, 240)
    assert b'"output_crs":"EPSG:3857"' in encoded
    assert b'"renderer":"opengeo.deterministic-png.v1"' in encoded
    assert len(encoded) < 100_000


def test_transparent_png_preserves_requested_background_rgb_and_alpha(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    raster_claim = replace(
        claim(config),
        width=64,
        height=64,
        format="png",
        background_color="#102030",
        transparent=True,
    )
    target = tmp_path / "transparent.png"

    DeterministicSvgRenderer().render(FIXTURE, raster_claim, target)

    encoded = target.read_bytes()
    assert struct.unpack(">II", encoded[16:24]) == (64, 64)
    assert encoded[24:26] == bytes((8, 6))
    cursor = 8
    compressed = bytearray()
    while cursor < len(encoded):
        length = struct.unpack(">I", encoded[cursor : cursor + 4])[0]
        kind = encoded[cursor + 4 : cursor + 8]
        data = encoded[cursor + 8 : cursor + 8 + length]
        if kind == b"IDAT":
            compressed.extend(data)
        cursor += 12 + length
    rows = zlib.decompress(bytes(compressed))
    pixels = [rows[offset + 1 : offset + 1 + 64 * 4] for offset in range(0, len(rows), 1 + 64 * 4)]
    rgba = [row[index : index + 4] for row in pixels for index in range(0, len(row), 4)]
    assert b"\x10\x20\x30\x00" in rgba
    assert any(pixel[3] > 0 for pixel in rgba)
    assert b'"background_color":"#102030"' in encoded
    assert b'"transparent":true' in encoded


def test_outside_crs_bbox_returns_the_requested_background_png(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    raster_claim = replace(
        claim(config),
        bbox=(-10.0, 90.0, 10.0, 110.0),
        width=8,
        height=5,
        format="png",
    )
    target = tmp_path / "outside-crs.png"

    DeterministicSvgRenderer().render(FIXTURE, raster_claim, target)

    encoded = target.read_bytes()
    assert struct.unpack(">II", encoded[16:24]) == (8, 5)
    assert encoded[24:26] == bytes((8, 2))
    cursor = 8
    compressed = bytearray()
    while cursor < len(encoded):
        length = struct.unpack(">I", encoded[cursor : cursor + 4])[0]
        kind = encoded[cursor + 4 : cursor + 8]
        data = encoded[cursor + 8 : cursor + 8 + length]
        if kind == b"IDAT":
            compressed.extend(data)
        cursor += 12 + length
    rows = zlib.decompress(bytes(compressed))
    assert rows == b"".join(b"\x00" + b"\xff\xff\xff" * 8 for _ in range(5))
    assert b'"bbox":[-10.0,90.0,10.0,110.0]' in encoded


def test_renderer_rejects_unbounded_wms_coordinates(tmp_path: Path) -> None:
    unbounded = replace(claim(), bbox=(-10_000_000_000.0, 90.0, 10.0, 110.0))

    with pytest.raises(ValidationFailure, match="render_request_invalid"):
        DeterministicSvgRenderer().render(FIXTURE, unbounded, tmp_path / "unbounded.svg")


def test_ordered_composition_renders_two_exact_layers_with_lineage(tmp_path: Path) -> None:
    first_config = configuration()
    first_config["label"] = None
    first_config["legend"] = {"enabled": False, "title": "Road status"}
    second_config = json.loads(json.dumps(first_config))
    second_geometry = second_config["geometry"]
    assert isinstance(second_geometry, dict)
    second_geometry["width"] = 1.0
    second_geometry["classification"] = None
    second_geometry["color"] = "#0044ff"
    layers = composition_layers(first_config, second_config)
    composed_claim = replace(claim(first_config), layers=layers)
    target = tmp_path / "composition.svg"

    DeterministicSvgRenderer().render_composition(
        [FIXTURE, FIXTURE], layers, composed_claim, target
    )

    root = ElementTree.fromstring(target.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["schema"] == "opengeo.render.composition.result.v1"
    assert metadata["layer_count"] == 2
    assert [layer["position"] for layer in metadata["layers"]] == [1, 2]
    document = target.read_text()
    assert document.index('id="layer-1-feature-1-part-1"') < document.index(
        'id="layer-2-feature-1-part-1"'
    )
    assert 'stroke="#0044ff"' in document


def test_repeated_composition_preserves_each_occurrence_and_alpha(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    geometry = config["geometry"]
    assert isinstance(geometry, dict)
    geometry["opacity"] = 0.5
    first_layer = composition_layers(config, config)[0]
    repeated_layers = (first_layer, replace(first_layer, position=2))
    render_claim = replace(
        claim(config),
        width=64,
        height=64,
        format="png",
        transparent=True,
        layers=repeated_layers,
    )
    single = tmp_path / "single-occurrence.png"
    repeated = tmp_path / "repeated-occurrences.png"

    renderer = DeterministicSvgRenderer()
    renderer.render(FIXTURE, replace(render_claim, layers=()), single)
    renderer.render_composition([FIXTURE, FIXTURE], repeated_layers, render_claim, repeated)

    def alpha_sum(path: Path) -> int:
        encoded = path.read_bytes()
        cursor = 8
        compressed = bytearray()
        while cursor < len(encoded):
            length = struct.unpack(">I", encoded[cursor : cursor + 4])[0]
            kind = encoded[cursor + 4 : cursor + 8]
            if kind == b"IDAT":
                compressed.extend(encoded[cursor + 8 : cursor + 8 + length])
            cursor += 12 + length
        rows = zlib.decompress(bytes(compressed))
        return sum(
            row[index + 3]
            for offset in range(0, len(rows), 1 + 64 * 4)
            for row in [rows[offset + 1 : offset + 1 + 64 * 4]]
            for index in range(0, len(row), 4)
        )

    assert alpha_sum(repeated) > alpha_sum(single)
    encoded = repeated.read_bytes()
    assert b'"layer_count":2' in encoded
    repeated_resource = str(first_layer.resource_id).encode()
    assert encoded.count(repeated_resource) == 2


def test_composition_places_top_layer_labels_with_one_shared_collision_and_legend(
    tmp_path: Path,
) -> None:
    first_config = configuration()
    second_config = configuration()
    layers = composition_layers(first_config, second_config)
    composed_claim = replace(claim(first_config), layers=layers)
    first = tmp_path / "composition-first.svg"
    second = tmp_path / "composition-second.svg"
    png = tmp_path / "composition.png"

    renderer = DeterministicSvgRenderer()
    renderer.render_composition([FIXTURE, FIXTURE], layers, composed_claim, first)
    renderer.render_composition([FIXTURE, FIXTURE], layers, composed_claim, second)
    renderer.render_composition(
        [FIXTURE, FIXTURE],
        layers,
        replace(composed_claim, format="png"),
        png,
    )

    assert first.read_bytes() == second.read_bytes()
    root = ElementTree.fromstring(first.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["label_candidate_count"] == 4
    assert metadata["placed_label_count"] == 2
    assert metadata["legend_layer_count"] == 2
    assert [layer["label_candidate_count"] for layer in metadata["layers"]] == [2, 2]
    assert [layer["placed_label_count"] for layer in metadata["layers"]] == [0, 2]
    document = first.read_text()
    assert document.count('data-opengeo-layer-position="2"') == 2
    assert 'data-opengeo-layer-position="1"' not in document
    assert "2. Road status" in document
    assert "1. Road status" in document
    assert png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert b'"label_candidate_count":4' in png.read_bytes()
    assert b'"placed_label_count":2' in png.read_bytes()


def test_transparent_one_pixel_svg_omits_the_background_rect(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    target = tmp_path / "one-pixel.svg"

    DeterministicSvgRenderer().render(
        FIXTURE,
        replace(
            claim(config),
            width=1,
            height=1,
            background_color="#102030",
            transparent=True,
        ),
        target,
    )

    root = ElementTree.fromstring(target.read_bytes())
    assert root.attrib["width"] == "1"
    assert root.attrib["height"] == "1"
    assert root.find("{http://www.w3.org/2000/svg}rect") is None


def test_png_renders_labels_collision_result_and_legend_deterministically(tmp_path: Path) -> None:
    raster_claim = replace(claim(), format="png")
    first = tmp_path / "labels-first.png"
    second = tmp_path / "labels-second.png"

    DeterministicSvgRenderer().render(FIXTURE, raster_claim, first)
    DeterministicSvgRenderer().render(FIXTURE, raster_claim, second)

    encoded = first.read_bytes()
    assert encoded == second.read_bytes()
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")
    assert encoded[24:26] == bytes((8, 2))
    assert b'"placed_label_count":2' in encoded
    assert sha256(encoded).hexdigest() == (
        "f3f2f4729eaa42cbf52fd595c29d0a0b97b1553a1a6803434037e890510322af"
    )


def test_v2_svg_uses_the_closed_vector_glyph_path_instead_of_a_host_font(
    tmp_path: Path,
) -> None:
    config = configuration()
    config["renderer"] = "opengeo.deterministic-svg.v2"
    label = config["label"]
    assert isinstance(label, dict)
    label["font"] = "opengeo-uppercase-5x7-v1"
    first = tmp_path / "closed-font-first.svg"
    second = tmp_path / "closed-font-second.svg"

    renderer = DeterministicSvgRenderer()
    renderer.render(FIXTURE, claim(config), first)
    renderer.render(FIXTURE, claim(config), second)

    assert first.read_bytes() == second.read_bytes()
    document = first.read_text()
    assert "<text " not in document
    assert "font-family=" not in document
    assert document.count('data-opengeo-font="uppercase-5x7-v1"') == 5
    assert "Harbor &amp; Main" in document
    assert "Bridge &lt;repair&gt;" in document
    root = ElementTree.fromstring(first.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["renderer"] == "opengeo.deterministic-svg.v2"
    assert metadata["text_font"] == "opengeo-uppercase-5x7-v1"


def test_v2_label_profile_rejects_an_unversioned_or_host_font(tmp_path: Path) -> None:
    config = configuration()
    config["renderer"] = "opengeo.deterministic-svg.v2"

    with pytest.raises(ValidationFailure, match="render_configuration_invalid"):
        DeterministicSvgRenderer().render(FIXTURE, claim(config), tmp_path / "font.svg")


def test_svg_and_png_render_a_bounded_accumulating_kernel_heatmap(tmp_path: Path) -> None:
    source = tmp_path / "points.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": f"Site {index}"},
                        "geometry": {"type": "Point", "coordinates": point},
                    }
                    for index, point in enumerate(
                        ([10.0, 10.0], [10.02, 10.015], [10.04, 10.03]), 1
                    )
                ],
            },
            separators=(",", ":"),
        )
    )
    config = configuration()
    config["renderer"] = "opengeo.deterministic-svg.v2"
    config["geometry"] = {
        "type": "heatmap",
        "color": "#d7191c",
        "colors": ["#2c7bb6", "#ffffbf", "#d7191c"],
        "kernel": "mapserver-gaussian",
        "normalization": "positive-minimum-over-visible-peak",
        "quantization_levels": 31,
        "opacity": 0.8,
        "radius": 24.0,
        "intensity": 1.25,
    }
    config["label"] = None
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    config["legend"] = {"enabled": True, "title": "Site density"}
    base_claim = replace(claim(config), bbox=(9.8, 9.8, 10.4, 10.3), width=256, height=192)
    svg = tmp_path / "heatmap.svg"
    png = tmp_path / "heatmap.png"

    renderer = DeterministicSvgRenderer()
    renderer.render(source, base_claim, svg)
    renderer.render(source, replace(base_claim, format="png"), png)

    document = svg.read_text()
    root = ElementTree.fromstring(svg.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    heatmap = metadata["heatmap"]
    assert heatmap["algorithm"] == "mapserver-gaussian-grid-v1"
    assert heatmap["normalization"] == "positive-minimum-over-visible-peak"
    assert heatmap["quantization_levels"] == 31
    assert heatmap["kernel_operations"] <= 10_000_000
    assert heatmap["occupied_cell_count"] > 100
    assert heatmap["input_point_count"] == 3
    assert heatmap["peak_weight"] > 1 / (2 * math.pi * heatmap["sigma_cells"] ** 2)
    assert document.count('id="density-') == heatmap["occupied_cell_count"]
    assert "-band-" not in document
    assert "Site density" in document
    assert 'fill="#2c7bb6"' in document
    assert 'fill="#ffffbf"' in document
    assert 'fill="#d7191c"' in document
    assert png.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert b'"rendered_feature_count":3' in png.read_bytes()


def test_legacy_v1_heatmap_profile_retains_byte_stable_three_band_semantics(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legacy-points.geojson"
    source.write_text(
        '{"type":"FeatureCollection","features":['
        '{"type":"Feature","properties":{},'
        '"geometry":{"type":"Point","coordinates":[10,10]}}]}'
    )
    config = configuration()
    config["geometry"] = {
        "type": "heatmap",
        "color": "#d7191c",
        "colors": ["#2c7bb6", "#ffffbf", "#d7191c"],
        "opacity": 0.8,
        "radius": 24.0,
        "intensity": 1.25,
    }
    config["label"] = None
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    config["legend"] = {"enabled": False, "title": "Legacy density"}
    target = tmp_path / "legacy.svg"

    DeterministicSvgRenderer().render(
        source,
        replace(claim(config), bbox=(9.8, 9.8, 10.2, 10.2), width=128, height=128),
        target,
    )

    document = target.read_text()
    assert document.count("-band-") == 3
    assert 'id="density-' not in document
    root = ElementTree.fromstring(target.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    assert metadata["renderer"] == "opengeo.deterministic-svg.v1"
    assert "heatmap" not in metadata


def test_kernel_heatmap_adapts_its_grid_before_the_operation_ceiling(
    tmp_path: Path,
) -> None:
    source = tmp_path / "dense-points.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "Point", "coordinates": [0, 0]},
                    }
                    for _ in range(5_000)
                ],
            },
            separators=(",", ":"),
        )
    )
    config = configuration()
    config["renderer"] = "opengeo.deterministic-svg.v2"
    config["geometry"] = {
        "type": "heatmap",
        "color": "#d7191c",
        "colors": ["#2c7bb6", "#ffffbf", "#d7191c"],
        "kernel": "mapserver-gaussian",
        "normalization": "positive-minimum-over-visible-peak",
        "quantization_levels": 31,
        "opacity": 0.8,
        "radius": 64.0,
        "intensity": 1.0,
    }
    config["label"] = None
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    config["legend"] = {"enabled": False, "title": "Dense sites"}
    target = tmp_path / "dense.svg"

    DeterministicSvgRenderer().render(
        source,
        replace(claim(config), bbox=(-1, -1, 1, 1), width=256, height=192),
        target,
    )

    root = ElementTree.fromstring(target.read_bytes())
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text or "")
    heatmap = metadata["heatmap"]
    assert heatmap["cell_size_pixels"] > 1
    assert heatmap["kernel_operations"] <= 10_000_000
    assert heatmap["grid"][0] * heatmap["grid"][1] <= 262_144
    assert metadata["rendered_feature_count"] == 5_000


def test_png_complexity_budget_rejects_pathological_scan_conversion(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    geometry = config["geometry"]
    assert isinstance(geometry, dict)
    geometry["width"] = 20.0
    source = tmp_path / "pathological.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"status": "open" if index % 2 == 0 else "closed"},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [
                                [-180, index * 0.001],
                                [180, index * 0.001],
                            ],
                        },
                    }
                    for index in range(8)
                ],
            }
        )
    )
    raster_claim = replace(
        claim(config),
        bbox=(-0.01, -0.01, 0.01, 0.01),
        width=64,
        height=64,
        format="png",
    )

    with pytest.raises(ValidationFailure, match="render_raster_complexity_exceeded"):
        DeterministicSvgRenderer().render(source, raster_claim, tmp_path / "pathological.png")


def test_png_complexity_budget_counts_polygon_edge_scans(tmp_path: Path) -> None:
    config = configuration()
    config["label"] = None
    config["legend"] = {"enabled": False, "title": "Road status"}
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    geometry = config["geometry"]
    assert isinstance(geometry, dict)
    geometry["type"] = "fill"
    geometry["outline_width"] = 0.0
    ring = [[float(-180 + index % 360), float(-80 + index % 160)] for index in range(30_000)]
    ring.append(ring[0])
    source = tmp_path / "pathological-polygon.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"status": "open"},
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                    }
                ],
            }
        )
    )
    raster_claim = replace(
        claim(config),
        bbox=(-180.0, -90.0, 180.0, 90.0),
        width=64,
        height=2048,
        format="png",
    )

    with pytest.raises(ValidationFailure, match="render_raster_complexity_exceeded"):
        DeterministicSvgRenderer().render(
            source, raster_claim, tmp_path / "pathological-polygon.png"
        )
