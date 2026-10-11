import json
import struct
import zlib
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from xml.etree import ElementTree

import pytest

from opengeo_worker.models import RenderLayerClaim, ValidationFailure
from opengeo_worker.renderer import DeterministicSvgRenderer
from test_renderer import claim, configuration


def saved_config(
    *,
    symbol: str = "line",
    position: int = 1,
    count: int = 1,
    color: str = "#ff0000",
    opacity: float = 0.8,
    source_geometry: str = "Polygon",
) -> dict:
    config = configuration()
    config.update(renderer="opengeo.deterministic-svg.v2", background="#061526", label=None)
    config["geometry"] = {
        "type": symbol,
        "color": color,
        "opacity": opacity,
        "classification": None,
    }
    if symbol == "fill":
        config["geometry"].update(outline_color="#00000000", outline_width=0)
    else:
        config["geometry"]["width"] = 4
    config["scale"] = {"minimum_denominator": None, "maximum_denominator": None}
    selector = f"pass-{position}"
    config["legend"] = {"enabled": False, "title": selector}
    config["source_style"].update(geometry_layer_id=selector, label_layer_id=None)
    config["saved_map"] = {
        "schema": "opengeo.saved-map-pass.1.0.0",
        "recipe_checksum_sha256": "c" * 64,
        "definition_checksum_sha256": "d" * 64,
        "style_checksum_sha256": "a" * 64,
        "layer_id": "saved-areas",
        "geometry_layer_id": selector,
        "source_geometry_type": source_geometry,
        "input_geometry": "polygon-boundary"
        if source_geometry in {"Polygon", "MultiPolygon"} and symbol == "line"
        else "native",
        "position": position,
        "pass_count": count,
        "dataset_id": "80000000-0000-4000-8000-000000000001",
        "dataset_version_id": "82000000-0000-4000-8000-000000000001",
    }
    return config


def polygon_source(tmp_path: Path, *, holes: bool = False) -> Path:
    rings = [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]]
    if holes:
        rings.append([[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]])
    path = tmp_path / "areas.geojson"
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "Polygon", "coordinates": rings},
                    }
                ],
            }
        )
    )
    return path


def render_passes(
    tmp_path: Path, configs: list[dict], *, source: Path | None = None, format: str = "svg"
) -> Path:
    source = source or polygon_source(tmp_path)
    base = claim(configs[0])
    source_body = source.read_bytes()
    exact = replace(
        base.source, size_bytes=len(source_body), checksum_sha256=sha256(source_body).hexdigest()
    )
    layers = tuple(
        RenderLayerClaim(
            position=position,
            resource_id=base.resource_id,
            dataset_id=base.dataset_id,
            dataset_version_id=base.dataset_version_id,
            source=exact,
            profile_id=base.profile_id,
            profile_version_id=base.profile_version_id,
            style_id=base.style_id,
            style_version_id=base.style_version_id,
            configuration=config,
            configuration_checksum_sha256=sha256(
                json.dumps(config, separators=(",", ":"), sort_keys=True).encode()
            ).hexdigest(),
        )
        for position, config in enumerate(configs, 1)
    )
    requested = replace(
        base,
        source=exact,
        bbox=(0, 0, 10, 10),
        width=64,
        height=64,
        format=format,
        transparent=True,
        layers=layers,
    )
    target = tmp_path / f"saved.{format}"
    renderer = DeterministicSvgRenderer()
    if len(configs) == 1:
        renderer.render(source, requested, target)
    else:
        renderer.render_composition([source] * len(configs), layers, requested, target)
    return target


def pixels(path: Path) -> list[bytes]:
    body = path.read_bytes()
    position = 8
    compressed = bytearray()
    while position < len(body):
        size = struct.unpack(">I", body[position : position + 4])[0]
        if body[position + 4 : position + 8] == b"IDAT":
            compressed.extend(body[position + 8 : position + 8 + size])
        position += size + 12
    raw = zlib.decompress(compressed)
    return [raw[offset + 1 : offset + 1 + 64 * 4] for offset in range(0, len(raw), 1 + 64 * 4)]


def test_saved_polygon_has_distinct_fill_and_closed_outline_with_separate_alpha(
    tmp_path: Path,
) -> None:
    configs = [
        saved_config(symbol="fill", position=1, count=2, color="#00ff00", opacity=0.25),
        saved_config(position=2, count=2),
    ]
    path = render_passes(tmp_path, configs)
    root = ElementTree.fromstring(path.read_bytes())
    fill = root.find(".//{http://www.w3.org/2000/svg}path")
    outline = root.find(".//{http://www.w3.org/2000/svg}polygon")
    assert fill.attrib["fill-opacity"] == "0.25"
    assert fill.attrib["stroke-width"] == "0"
    assert outline.attrib["stroke-opacity"] == "0.8"
    assert outline.attrib["stroke-width"] == "4"
    assert outline.attrib["stroke-linejoin"] == "miter"
    metadata = json.loads(root.find("{http://www.w3.org/2000/svg}metadata").text)
    assert [layer["saved_map"]["position"] for layer in metadata["layers"]] == [1, 2]
    image = pixels(render_passes(tmp_path, configs, format="png"))
    assert image[32][32 * 4 : 33 * 4] == bytes((0, 255, 0, 64))
    assert image[32][11 * 4 : 12 * 4] == bytes((255, 0, 0, 204))
    assert image[32][10 * 4 : 11 * 4][3] == 0
    # The miter corner has the same opacity as a straight section, not two blends.
    assert image[11][11 * 4 : 12 * 4] == bytes((255, 0, 0, 204))


def test_saved_polygon_holes_have_their_own_closed_boundary(tmp_path: Path) -> None:
    source = polygon_source(tmp_path, holes=True)
    root = ElementTree.fromstring(
        render_passes(tmp_path, [saved_config()], source=source).read_bytes()
    )
    assert len(root.findall(".//{http://www.w3.org/2000/svg}polygon")) == 2
    image = pixels(render_passes(tmp_path, [saved_config()], source=source, format="png"))
    assert image[32][25 * 4 : 26 * 4][3] == 204
    assert image[32][32 * 4 : 33 * 4][3] == 0


def test_saved_points_preserve_fill_radius_alpha_and_the_external_stroke(tmp_path: Path) -> None:
    config = saved_config(symbol="circle", color="#00ff00", opacity=0.25, source_geometry="Point")
    config["geometry"].update(radius=6, stroke_color="#ffffff", stroke_width=1.25)
    source = tmp_path / "points.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "Point", "coordinates": [5, 5]},
                    }
                ],
            }
        )
    )
    root = ElementTree.fromstring(render_passes(tmp_path, [config], source=source).read_bytes())
    circle = root.find(".//{http://www.w3.org/2000/svg}circle")
    assert circle.attrib["r"] == "6.625"
    image = pixels(render_passes(tmp_path, [config], source=source, format="png"))
    assert image[32][32 * 4 : 33 * 4] == bytes((0, 255, 0, 64))
    assert image[32][37 * 4 : 38 * 4] == bytes((0, 255, 0, 64))
    assert image[32][38 * 4 : 39 * 4] == bytes((255, 255, 255, 255))
    assert image[32][39 * 4 : 40 * 4][3] == 0


def test_saved_layer_reordering_changes_composed_pixels_without_changing_each_alpha(
    tmp_path: Path,
) -> None:
    first = saved_config(symbol="fill", position=1, count=2, color="#0000ff", opacity=0.5)
    second = saved_config(symbol="fill", position=2, count=2, color="#ff0000", opacity=0.5)
    forward = pixels(render_passes(tmp_path, [first, second], format="png"))[32][128:132]
    first["geometry"]["color"], second["geometry"]["color"] = (
        second["geometry"]["color"],
        first["geometry"]["color"],
    )
    reverse = pixels(render_passes(tmp_path, [first, second], format="png"))[32][128:132]
    assert forward == bytes((170, 0, 85, 192))
    assert reverse == bytes((85, 0, 170, 192))


@pytest.mark.parametrize(
    "change",
    [
        lambda config: config["saved_map"].update(schema="opengeo.saved-map-pass.2.0.0"),
        lambda config: config["saved_map"].update(unknown=True),
        lambda config: config["saved_map"].update(input_geometry="implicit"),
        lambda config: config["saved_map"].update(position=True),
        lambda config: config["saved_map"].update(recipe_checksum_sha256="bad"),
        lambda config: config["source_style"].update(style_id="not-a-stored-uuid"),
        lambda config: config.update(renderer="opengeo.deterministic-svg.v1"),
        lambda config: config.update(label={"field": "name"}),
    ],
)
def test_saved_marker_is_closed_versioned_and_never_ignores_unsupported_semantics(
    tmp_path: Path, change
) -> None:
    config = saved_config()
    change(config)
    with pytest.raises(ValidationFailure, match="saved_map_pass_invalid"):
        render_passes(tmp_path, [config])


def test_saved_marker_cannot_change_dataset_or_use_an_incomplete_pass_list(tmp_path: Path) -> None:
    config = saved_config()
    config["saved_map"]["dataset_version_id"] = "82000000-0000-4000-8000-000000000002"
    with pytest.raises(ValidationFailure, match="saved_map_pass_identity_mismatch"):
        render_passes(tmp_path, [config])
    with pytest.raises(ValidationFailure, match="saved_map_pass_sequence_invalid"):
        render_passes(tmp_path, [saved_config(count=2)])
    with pytest.raises(ValidationFailure, match="saved_map_pass_sequence_invalid"):
        render_passes(
            tmp_path, [saved_config(position=2, count=2), saved_config(position=1, count=2)]
        )


def test_saved_geometry_mismatch_fails_instead_of_omitting_the_feature(tmp_path: Path) -> None:
    with pytest.raises(ValidationFailure, match="saved_map_source_geometry_mismatch"):
        render_passes(tmp_path, [saved_config(source_geometry="LineString")])
