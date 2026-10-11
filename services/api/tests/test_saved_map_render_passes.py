import json
from dataclasses import replace
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.saved_map_render_passes import (
    SAVED_MAP_PASS_SCHEMA,
    SavedMapStyleIdentity,
    bind_saved_map_pass,
    compile_saved_map_passes,
)
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported, compile_saved_map
from test_saved_map_rendering import saved_layer, saved_map

IDENTITY = SavedMapStyleIdentity(
    UUID("a2000000-0000-4000-8000-000000000084"),
    UUID("a3000000-0000-4000-8000-000000000084"),
    1,
)


def test_preflight_exposes_ordered_passes_without_fabricating_stored_style_identity() -> None:
    recipe = compile_saved_map(saved_map(saved_layer("top", 0), saved_layer("bottom", 1)))
    passes = compile_saved_map_passes(recipe)
    assert [(item.position, item.layer_id, item.input_geometry) for item in passes] == [
        (1, "bottom", "native"),
        (2, "bottom", "polygon-boundary"),
        (3, "top", "native"),
        (4, "top", "polygon-boundary"),
    ]
    assert all(
        item.configuration_json is None and item.configuration_checksum_sha256 is None
        for item in passes
    )
    assert passes[0].dataset_version_id == recipe.layers[0].dataset_version_id
    assert passes[0].maplibre_style_json == recipe.layers[0].maplibre_style_json


def test_binding_preserves_separate_polygon_opacity_width_and_real_style_identity() -> None:
    recipe = compile_saved_map(saved_map())
    passes = compile_saved_map_passes(recipe, style_bindings={"areas": IDENTITY})
    first, second = [json.loads(item.configuration_json or "null") for item in passes]
    assert first["geometry"]["type"] == "fill"
    assert first["geometry"]["opacity"] == 0.2
    assert first["geometry"]["outline_width"] == 0
    assert first["geometry"]["outline_color"] == "#00000000"
    assert second["geometry"]["type"] == "line"
    assert second["geometry"]["opacity"] == 0.8
    assert second["geometry"]["width"] == 5
    assert second["saved_map"]["input_geometry"] == "polygon-boundary"
    for item, configuration in zip(passes, (first, second), strict=True):
        assert configuration["source_style"]["style_id"] == str(IDENTITY.style_id)
        assert configuration["source_style"]["style_version_id"] == str(IDENTITY.style_version_id)
        assert configuration["source_style"]["style_version_number"] == 1
        assert configuration["saved_map"]["schema"] == SAVED_MAP_PASS_SCHEMA
        assert configuration["saved_map"]["recipe_checksum_sha256"] == recipe.checksum_sha256
        assert configuration["saved_map"]["position"] == item.position
        assert configuration["saved_map"]["pass_count"] == 2
        assert configuration["background"] == "#061526"
        assert (
            item.configuration_checksum_sha256
            == sha256(
                json.dumps(configuration, separators=(",", ":"), sort_keys=True).encode()
            ).hexdigest()
        )
        assert configuration["label"] is None


def test_separately_bound_pass_is_identical_and_supports_a_single_outline_pass() -> None:
    recipe = compile_saved_map(
        saved_map(saved_layer(style={"polygonMode": "line", "strokeWidth": 14}))
    )
    unbound = compile_saved_map_passes(recipe)
    bound = compile_saved_map_passes(recipe, style_bindings={"areas": IDENTITY})
    assert len(bound) == 1
    assert bind_saved_map_pass(unbound[0], IDENTITY) == bound[0]
    assert json.loads(bound[0].configuration_json or "null")["geometry"]["width"] == 14


def test_labels_fail_before_any_pass_can_be_submitted() -> None:
    recipe = compile_saved_map(saved_map(saved_layer(labels={"enabled": True, "field": "name"})))
    with pytest.raises(SavedMapRenderUnsupported) as failure:
        compile_saved_map_passes(recipe)
    assert failure.value.code == "saved_map_labels_worker_unsupported"
    assert failure.value.layer_id == "areas"
    assert "new map revision" in failure.value.message


@pytest.mark.parametrize("bindings", [{}, {"another-layer": IDENTITY}])
def test_missing_or_wrong_style_bindings_fail_closed(bindings) -> None:
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_style_binding_mismatch"):
        compile_saved_map_passes(compile_saved_map(saved_map()), style_bindings=bindings)


@pytest.mark.parametrize(
    "field,value", [("checksum_sha256", "f" * 64), ("background_color", "#ffffff")]
)
def test_modified_recipe_cannot_be_compiled(field: str, value: str) -> None:
    recipe = replace(compile_saved_map(saved_map()), **{field: value})
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_recipe_checksum_mismatch"):
        compile_saved_map_passes(recipe)


def test_style_binding_requires_actual_uuid_and_positive_version() -> None:
    render_pass = compile_saved_map_passes(compile_saved_map(saved_map()))[0]
    for identity in (
        replace(IDENTITY, version_number=0),
        replace(IDENTITY, version_number=True),
        replace(IDENTITY, style_id="synthetic"),
    ):
        with pytest.raises(SavedMapRenderUnsupported, match="saved_map_style_binding_invalid"):
            bind_saved_map_pass(render_pass, identity)
