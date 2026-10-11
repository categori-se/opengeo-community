import json
from copy import deepcopy
from dataclasses import FrozenInstanceError
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.map_definitions import MAP_DEFINITION_SCHEMA_VERSION
from opengeo_api.saved_map_rendering import (
    BLANK_MAP_BACKGROUND,
    SavedMapRenderUnsupported,
    compile_saved_map,
)

DATASET_ID = UUID("80000000-0000-4000-8000-000000000084")
VERSION_ID = UUID("81000000-0000-4000-8000-000000000084")


def saved_layer(layer_id: str = "areas", order: int = 0, **overrides: Any) -> dict[str, Any]:
    return {
        "layerId": layer_id,
        "title": f"Survey {layer_id}",
        "order": order,
        "datasetId": str(DATASET_ID),
        "datasetVersionId": str(VERSION_ID),
        "sourceVersion": 3,
        "sourceType": "governed-dataset",
        "geometryType": "Polygon",
        "visible": True,
        "opacity": 0.8,
        "style": {
            "fill": "#00ff00",
            "stroke": "#ff0000",
            "strokeWidth": 5,
            "fillOpacityFactor": 0.25,
        },
        "labels": {"enabled": False, "field": None},
        **overrides,
    }


def saved_map(*layers: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [
            {"id": "primary", "center": [-71.1, 42.3], "zoom": 10, "pitch": 0, "bearing": 0}
        ],
        "basemaps": [
            {
                "basemapId": "blank",
                "title": "Blank canvas",
                "kind": "blank",
                "visible": True,
                "opacity": 1,
                "url": None,
            }
        ],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": list(layers) or [saved_layer()],
    }


def test_overlapping_layers_follow_studio_bottom_to_top_order_and_exact_style() -> None:
    definition = saved_map(saved_layer("top", 0), saved_layer("bottom", 7))
    definition["layers"][1]["style"]["fill"] = "#0000ff"
    recipe = compile_saved_map(definition)

    assert [layer.layer_id for layer in recipe.layers] == ["bottom", "top"]
    assert [layer.order for layer in recipe.layers] == [7, 0]
    assert [layer.title for layer in recipe.layers] == ["Survey bottom", "Survey top"]
    assert recipe.background_color == BLANK_MAP_BACKGROUND == "#061526"
    assert json.loads(recipe.map_view_json or "null") == definition["mapViews"][0]
    assert recipe.layers[1].dataset_id == DATASET_ID
    assert recipe.layers[1].dataset_version_id == VERSION_ID
    assert recipe.layers[1].dataset_version_number == 3
    style = json.loads(recipe.layers[1].maplibre_style_json)
    assert style["layers"] == [
        {
            "id": "occurrence-2-fill",
            "type": "fill",
            "paint": {"fill-color": "#00ff00", "fill-opacity": 0.2},
        },
        {
            "id": "occurrence-2-outline",
            "type": "line",
            "paint": {"line-color": "#ff0000", "line-width": 5, "line-opacity": 0.8},
        },
    ]
    assert recipe.layers[1].geometry_layer_ids == ("occurrence-2-fill", "occurrence-2-outline")
    assert recipe.checksum_sha256 == sha256(recipe.canonical_json.encode()).hexdigest()
    assert recipe.definition_checksum_sha256 == sha256(canonical_json_bytes(definition)).hexdigest()


def test_repeated_datasets_and_equal_order_keep_each_occurrence() -> None:
    definition = saved_map(saved_layer("first", 2), saved_layer("second", 2))
    definition["layers"][1]["style"]["fill"] = "#112233"
    recipe = compile_saved_map(definition)

    assert [layer.layer_id for layer in recipe.layers] == ["second", "first"]
    assert recipe.layers[0].dataset_version_id == recipe.layers[1].dataset_version_id
    assert recipe.layers[0].style_checksum_sha256 != recipe.layers[1].style_checksum_sha256


def test_line_and_point_paints_and_status_renderer_use_saved_values() -> None:
    definition = saved_map(
        saved_layer(
            "line",
            0,
            geometryType="MultiLineString",
            style={"stroke": "#123456", "strokeWidth": 14},
        ),
        saved_layer(
            "point",
            1,
            geometryType="MultiPoint",
            style={"renderer": "status", "circleColor": "#654321", "circleRadius": 24},
        ),
    )
    recipe = compile_saved_map(definition)
    point = json.loads(recipe.layers[0].maplibre_style_json)["layers"][0]
    assert point["paint"] == {
        "circle-color": [
            "match",
            ["get", "status"],
            "verified",
            "#16a34a",
            "needs review",
            "#f59e0b",
            "draft",
            "#64748b",
            "#654321",
        ],
        "circle-radius": 24,
        "circle-opacity": 0.8,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.25,
    }
    assert json.loads(recipe.layers[1].maplibre_style_json)["layers"][0]["paint"] == {
        "line-color": "#123456",
        "line-width": 14,
        "line-opacity": 0.8,
    }


def test_polygon_outline_mode_preserves_fill_color_as_line_color() -> None:
    recipe = compile_saved_map(
        saved_map(
            saved_layer(
                style={
                    "polygonMode": "line",
                    "fill": "#123456",
                    "stroke": "#abcdef",
                    "strokeWidth": 14,
                }
            )
        )
    )
    assert json.loads(recipe.layers[0].maplibre_style_json)["layers"] == [
        {
            "id": "occurrence-1-outline",
            "type": "line",
            "paint": {"line-color": "#123456", "line-width": 14, "line-opacity": 0.8},
        }
    ]


def test_labels_preserve_field_conversion_size_color_halo_and_placement() -> None:
    recipe = compile_saved_map(
        saved_map(
            saved_layer(
                labels={
                    "enabled": True,
                    "field": "name",
                    "size": 17,
                    "color": "#123456",
                    "haloColor": "#abcdef",
                    "haloWidth": 2.5,
                }
            )
        )
    )
    layer = recipe.layers[0]
    assert layer.label_layer_id == "occurrence-1-labels"
    assert json.loads(layer.maplibre_style_json)["layers"][-1] == {
        "id": layer.label_layer_id,
        "type": "symbol",
        "layout": {
            "text-field": ["to-string", ["get", "name"]],
            "text-size": 17,
            "text-offset": [0, 1.1],
            "text-anchor": "top",
            "text-allow-overlap": False,
        },
        "paint": {"text-color": "#123456", "text-halo-color": "#abcdef", "text-halo-width": 2.5},
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ("fill", "#012345"),
        ("stroke", "#112233"),
        ("strokeWidth", 9),
        ("fillOpacityFactor", 0.75),
    ],
)
def test_a_saved_style_change_changes_the_seal(field: str, value: object) -> None:
    definition = saved_map()
    first = compile_saved_map(definition)
    definition["layers"][0]["style"][field] = value
    second = compile_saved_map(definition)
    assert first.checksum_sha256 != second.checksum_sha256
    assert first.layers[0].style_checksum_sha256 != second.layers[0].style_checksum_sha256


def test_recipe_is_deterministic_immutable_and_detached_from_input() -> None:
    definition = saved_map()
    original = deepcopy(definition)
    first = compile_saved_map(definition)
    assert definition == original
    assert compile_saved_map(dict(reversed(list(definition.items())))) == first
    definition["layers"][0]["style"]["fill"] = "#112233"
    assert '"fill-color":"#00ff00"' in first.layers[0].maplibre_style_json
    with pytest.raises(FrozenInstanceError):
        first.layers[0].title = "Mutated"  # type: ignore[misc]


def test_hidden_external_layers_and_backgrounds_are_reported_without_compiling() -> None:
    hidden = saved_layer("external", 1, visible=False, sourceType="external-feature-reference")
    del hidden["datasetVersionId"]
    hidden["style"] = {"unsupported": ["expression"]}
    hidden["filters"] = ["unsupported filter"]
    definition = saved_map(saved_layer(), hidden)
    definition["basemaps"].append(
        {
            "basemapId": "external",
            "kind": "maplibre-style",
            "visible": False,
            "url": "https://example.test/style.json",
        }
    )
    recipe = compile_saved_map(definition)
    assert len(recipe.layers) == 1
    assert recipe.omitted_layer_ids == ("external",)
    assert recipe.omitted_basemap_ids == ("external",)
    assert "https://" not in recipe.canonical_json


def test_visible_external_layer_is_rejected_before_render_input_resolution() -> None:
    layer = saved_layer(sourceType="external-feature-reference")
    del layer["datasetVersionId"]
    with pytest.raises(SavedMapRenderUnsupported) as failure:
        compile_saved_map(saved_map(layer))
    assert failure.value.code == "saved_map_source_unsupported"
    assert failure.value.layer_id == "areas"


def test_exact_dataset_and_object_identity_changes_are_sealed() -> None:
    definition = saved_map()
    first = compile_saved_map(definition)
    layer = definition["layers"][0]
    layer["datasetVersionId"] = "81000000-0000-4000-8000-000000000085"
    layer["sourceVersion"] = 4
    layer["objectId"] = "82000000-0000-4000-8000-000000000085"
    second = compile_saved_map(definition)
    assert second.layers[0].dataset_version_id == UUID(layer["datasetVersionId"])
    assert second.layers[0].dataset_version_number == 4
    assert second.layers[0].object_id == UUID(layer["objectId"])
    assert second.checksum_sha256 != first.checksum_sha256


@pytest.mark.parametrize("version", ["1.0.0", "1.1.0", "1.2.0", "1.3.0"])
def test_readable_versioned_maps_compile_without_rewriting_their_history(version: str) -> None:
    definition = saved_map()
    definition["schemaVersion"] = f"opengeo.map-definition.{version}"
    original = deepcopy(definition)
    assert compile_saved_map(definition).layers[0].layer_id == "areas"
    assert definition == original


@pytest.mark.parametrize(
    "change,code",
    [
        (lambda value: value["layers"][0].pop("datasetVersionId"), "saved_map_dataset_unpinned"),
        (
            lambda value: value["layers"][0].update(filters=["==", "name", "one"]),
            "saved_map_filter_unsupported",
        ),
        (
            lambda value: value["layers"][0]["style"].update(renderer="category"),
            "saved_map_categories_unpinned",
        ),
        (
            lambda value: value["layers"][0]["style"].update(renderer="graduated"),
            "saved_map_graduated_unsupported",
        ),
        (
            lambda value: value["layers"][0]["style"].update(renderer={}),
            "saved_map_renderer_unsupported",
        ),
        (
            lambda value: value["layers"][0]["style"].update(icon="image.png"),
            "saved_map_style_unsupported",
        ),
        (
            lambda value: value["layers"][0]["style"].update(strokeWidth=21),
            "saved_map_symbol_unsupported",
        ),
        (
            lambda value: value["layers"][0]["style"].update(fillOpacityFactor=True),
            "saved_map_symbol_unsupported",
        ),
        (
            lambda value: value["layers"][0].update(geometryType="Point"),
            "saved_map_renderer_unpinned",
        ),
        (
            lambda value: value["layers"][0].update(geometryType={}),
            "saved_map_geometry_unsupported",
        ),
        (
            lambda value: value["layers"][0]["labels"].update(
                enabled=True, field="name", prefix="Site "
            ),
            "saved_map_label_unsupported",
        ),
        (
            lambda value: value["layers"][0]["labels"].update(
                enabled=True, field="name", allowOverlap=True
            ),
            "saved_map_label_unsupported",
        ),
        (
            lambda value: value["layers"][0]["labels"].update(enabled=True, field=None),
            "saved_map_label_field_missing",
        ),
        (
            lambda value: value["layers"][0]["labels"].update(enabled=True, field="name", size=33),
            "saved_map_symbol_unsupported",
        ),
    ],
)
def test_visible_unsupported_layer_fails_with_actionable_identity(change, code: str) -> None:
    definition = saved_map()
    change(definition)
    with pytest.raises(SavedMapRenderUnsupported) as failure:
        compile_saved_map(definition)
    assert failure.value.code == code
    assert failure.value.layer_id == "areas"
    assert failure.value.message


@pytest.mark.parametrize(
    "change,code",
    [
        (lambda value: value.update(basemaps=[]), "saved_map_basemap_unpinned"),
        (
            lambda value: value["basemaps"][0].update(
                kind="maplibre-style", url="https://example.test/style.json"
            ),
            "saved_map_basemap_unsupported",
        ),
        (lambda value: value.update(terrain={"enabled": True}), "saved_map_terrain_unsupported"),
        (
            lambda value: value.update(openScene3d={"enabled": True}),
            "saved_map_terrain_unsupported",
        ),
        (lambda value: value["mapViews"][0].update(pitch=20), "saved_map_camera_unsupported"),
        (lambda value: value["mapViews"][0].update(bearing=45), "saved_map_camera_unsupported"),
        (lambda value: value.update(projection="globe"), "saved_map_projection_unsupported"),
        (
            lambda value: value.update(
                extensions={"historicalImagery": {"sunlight": {"enabled": True}}}
            ),
            "saved_map_imagery_unsupported",
        ),
        (lambda value: value.update(filters=["area"]), "saved_map_filter_unsupported"),
        (lambda value: value.pop("schemaVersion"), "saved_map_definition_invalid"),
    ],
)
def test_unsupported_visible_map_presentation_is_never_omitted(change, code: str) -> None:
    definition = saved_map()
    change(definition)
    with pytest.raises(SavedMapRenderUnsupported) as failure:
        compile_saved_map(definition)
    assert failure.value.code == code


def test_layer_groups_are_accepted_only_when_saved_order_matches_studio() -> None:
    definition = saved_map(saved_layer("ungrouped", 0), saved_layer("grouped", 1))
    definition["layerTree"] = [
        {"kind": "group", "id": "group", "children": [{"kind": "layer", "layerId": "grouped"}]}
    ]
    assert [layer.layer_id for layer in compile_saved_map(definition).layers] == [
        "grouped",
        "ungrouped",
    ]
    definition["layers"][0]["order"] = 2
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_layer_order_conflict"):
        compile_saved_map(definition)


def test_input_and_geometry_pass_limits_are_enforced() -> None:
    assert (
        len(compile_saved_map(saved_map(*(saved_layer(f"area-{i}", i) for i in range(8)))).layers)
        == 8
    )
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_pass_limit"):
        compile_saved_map(saved_map(*(saved_layer(f"area-{i}", i) for i in range(9))))
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_layer_limit"):
        compile_saved_map(saved_map(*(saved_layer(f"area-{i}", i) for i in range(17))))
    definition = saved_map()
    definition["extensions"] = {"oversized": "x" * 262_144}
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_definition_invalid"):
        compile_saved_map(definition)


@pytest.mark.parametrize("invalid", [float("nan"), ("not", "json"), {"not-json"}])
def test_non_json_and_non_finite_input_returns_a_bounded_diagnostic(invalid: object) -> None:
    definition = saved_map()
    definition["extensions"] = {"invalid": invalid}
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_definition_invalid"):
        compile_saved_map(definition)


def test_unresolved_style_reference_never_renders_inline_fallback() -> None:
    document = saved_map(
        saved_layer(
            styleReference={
                "projectId": "50000000-0000-4000-8000-000000000002",
                "resourceId": "a0000000-0000-4000-8000-000000000002",
                "styleId": "d0000000-0000-4000-8000-000000000002",
                "versionNumber": 2,
                "checksumSha256": "a" * 64,
                "format": "maplibre",
            }
        )
    )
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    with pytest.raises(SavedMapRenderUnsupported) as error:
        compile_saved_map(document)
    assert error.value.code == "saved_map_style_resolution_required"


def test_resolved_style_compiles_exact_paint_and_preserves_original_bytes() -> None:
    from dataclasses import replace
    from datetime import UTC, datetime

    from opengeo_api.resources import ResourceStyle
    from opengeo_api.saved_map_render_passes import compile_saved_map_passes

    original = (
        '{"version":8,"sources":{},"layers":[{"id":"roads","type":"line",'
        '"paint":{"line-color":"#123456","line-width":3,"line-opacity":0.5}}]}\r\n'
    )
    style = ResourceStyle(
        UUID("d0000000-0000-4000-8000-000000000002"),
        UUID("a0000000-0000-4000-8000-000000000002"),
        "roads",
        "maplibre",
        2,
        "Roads",
        "application/json",
        original,
        sha256(original.encode()).hexdigest(),
        None,
        DATASET_ID,
        datetime.now(UTC),
        datetime.now(UTC),
    )
    reference = {
        "projectId": "50000000-0000-4000-8000-000000000002",
        "resourceId": str(style.resource_id),
        "styleId": str(style.style_id),
        "versionNumber": 2,
        "checksumSha256": style.checksum_sha256,
        "format": "maplibre",
    }
    document = saved_map(saved_layer(geometryType="LineString", styleReference=reference))
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    recipe = compile_saved_map(document, resolved_styles={"areas": style})
    paint = json.loads(recipe.layers[0].maplibre_style_json)["layers"][0]["paint"]
    assert paint == {"line-color": "#123456", "line-width": 3, "line-opacity": 0.4}
    assert style.definition == original
    assert len(compile_saved_map_passes(recipe)) == 1
    for invalid in [replace(style, version_number=3), replace(style, definition="corrupt")]:
        with pytest.raises(SavedMapRenderUnsupported) as error:
            compile_saved_map(document, resolved_styles={"areas": invalid})
        assert error.value.code == "saved_map_style_unavailable"


def test_composite_opacity_separates_fill_and_line_passes_and_seals_choice():
    from opengeo_api.saved_map_render_passes import compile_saved_map_passes

    baseline = compile_saved_map(saved_map(saved_layer()))
    recipe = compile_saved_map(saved_map(saved_layer(opacityMode="composite")))
    assert recipe.checksum_sha256 != baseline.checksum_sha256
    parts = json.loads(recipe.layers[0].maplibre_style_json)["layers"]
    assert parts[0]["paint"]["fill-opacity"] == 0.25
    assert parts[0]["paint"]["fill-layer-opacity"] == 0.8
    assert parts[1]["paint"]["line-opacity"] == 1
    assert parts[1]["paint"]["line-layer-opacity"] == 0.8
    assert all(
        part.renderer == "opengeo.maplibre-gl-js.v1" for part in compile_saved_map_passes(recipe)
    )


@pytest.mark.parametrize(
    "change",
    [
        {"opacityMode": "unknown"},
        {"opacityMode": "composite", "geometryType": "Point"},
        {"opacityMode": "composite", "sourceType": "kml-places"},
    ],
)
def test_invalid_or_unsupported_opacity_choice_rejected(change):
    with pytest.raises((ValueError, SavedMapRenderUnsupported)):
        compile_saved_map(saved_map(saved_layer(**change)))


def test_generated_patterns_compile_to_sealed_gl_occurrences():
    from datetime import UTC, datetime
    from pathlib import Path

    from opengeo_api.cartographic_patterns import generated_pattern
    from opengeo_api.resources import ResourceStyle
    from opengeo_api.saved_map_render_passes import compile_saved_map_passes

    fixtures = json.loads(
        (Path(__file__).parent / "fixtures/cartographic-patterns.json").read_text()
    )
    for fixture in fixtures:
        original = fixture["definition"]
        assert generated_pattern(original) == {"svg": fixture["svg"], "size": 24}
        style = ResourceStyle(
            UUID("d0000000-0000-4000-8000-000000000002"),
            UUID("a0000000-0000-4000-8000-000000000002"),
            "pattern",
            "sld_1_1",
            1,
            "Water & plants",
            "application/xml",
            original,
            sha256(original.encode()).hexdigest(),
            None,
            DATASET_ID,
            datetime.now(UTC),
            datetime.now(UTC),
        )
        reference = {
            "projectId": "50000000-0000-4000-8000-000000000002",
            "resourceId": str(style.resource_id),
            "styleId": str(style.style_id),
            "versionNumber": 1,
            "format": "sld_1_1",
            "checksumSha256": style.checksum_sha256,
        }
        document = saved_map(saved_layer(styleReference=reference, opacityMode="composite"))
        document["schemaVersion"] = "opengeo.map-definition.1.4.0"
        recipe = compile_saved_map(document, resolved_styles={"areas": style})
        part = json.loads(recipe.layers[0].maplibre_style_json)
        assert part["layers"][0]["paint"]["fill-layer-opacity"] == 0.8
        assert next(iter(part["metadata"]["opengeo:patterns"].values()))["svg"] == fixture["svg"]
        assert compile_saved_map_passes(recipe)[0].renderer == "opengeo.maplibre-gl-js.v1"
        assert style.definition == original
        with pytest.raises(ValueError):
            generated_pattern(original.replace('encoding="base64"', 'href="https://example.org"'))
    with pytest.raises(ValueError):
        generated_pattern("<!DOCTYPE svg><svg/>")
