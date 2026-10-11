import asyncio
import json
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest

from opengeo_api.config import Settings
from opengeo_api.map_definitions import validate_map_definition
from opengeo_api.render_fonts import RENDER_FONT_REGISTRY, resolve_render_font
from opengeo_api.render_runtime import PINNED_GL_RENDERER, RenderRuntimeReference
from opengeo_api.rendering import PostgresRenderRepository
from opengeo_api.saved_map_jobs import request_saved_map_render
from opengeo_api.saved_map_render_passes import bind_saved_map_pass, compile_saved_map_passes
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported, compile_saved_map
from test_rendering import PROJECT_ID, RESOURCE_ID, Downloads, Executor, Transaction, job_row
from test_saved_map_jobs import CONTEXT, REQUEST, ROLES, SOURCE, binding, submit
from test_saved_map_publication import read_seal, sealed_rows
from test_saved_map_render_passes import IDENTITY
from test_saved_map_rendering import saved_layer, saved_map

FONT_REF = {
    "id": "opengeo-open-sans-v1",
    "version": 1,
    "manifestChecksumSha256": "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a",
}


def labeled_map():
    return saved_map(
        saved_layer("top", 0, labels={"enabled": True, "field": "name", "fontRef": FONT_REF}),
        saved_layer("bottom", 1),
    )


def test_registered_font_matches_real_packaged_asset_and_range_bytes():
    root = Path(__file__).resolve().parents[3]
    assets = root / "app/src/assets/render-fonts" / FONT_REF["id"] / "1"
    encoded = (assets / "manifest.json").read_bytes()
    manifest = json.loads(encoded)
    assert sha256(encoded).hexdigest() == FONT_REF["manifestChecksumSha256"]
    assert manifest["id"] == FONT_REF["id"] and manifest["version"] == 1
    assert resolve_render_font(FONT_REF) == manifest["fontStack"] == "OpenGeo Open Sans v1"
    assert RENDER_FONT_REGISTRY[(FONT_REF["id"], 1)][0] == sha256(encoded).hexdigest()
    for entry in manifest["ranges"]:
        data = (assets / f"{entry['range']}.pbf").read_bytes()
        assert sha256(data).hexdigest() == entry["checksumSha256"]
        assert len(data) == entry["sizeBytes"]


def test_pinned_labels_preserve_case_expression_prefix_suffix_overlap_and_full_halo():
    definition = labeled_map()
    definition["layers"][0]["labels"].update(
        prefix="Survey Ω · ", suffix="\nCafé", allowOverlap=True, size=8, haloWidth=6
    )
    original = deepcopy(definition)
    recipe = compile_saved_map(definition)
    style = json.loads(recipe.layers[-1].maplibre_style_json)
    assert definition == original
    assert style["metadata"] == {"opengeo:font": FONT_REF}
    label = style["layers"][-1]
    assert label["layout"]["text-field"] == [
        "concat",
        "Survey Ω · ",
        ["to-string", ["get", "name"]],
        "\nCafé",
    ]
    assert label["layout"]["text-font"] == ["OpenGeo Open Sans v1"]
    assert label["layout"]["text-allow-overlap"] is True
    assert label["layout"]["text-size"] == 8
    # Preserve the authored value: MapLibre defines the same effective halo
    # behavior in browser and worker, not the legacy worker's four-pixel limit.
    assert label["paint"]["text-halo-width"] == 6


def test_one_occurrence_keeps_all_geometry_and_labels_in_shared_order():
    recipe = compile_saved_map(labeled_map())
    passes = compile_saved_map_passes(recipe, style_bindings={"top": IDENTITY, "bottom": IDENTITY})
    assert [(item.layer_id, item.position, item.pass_count) for item in passes] == [
        ("bottom", 1, 2),
        ("top", 2, 2),
    ]
    for item in passes:
        config = json.loads(item.configuration_json)
        assert config["renderer"] == "opengeo.maplibre-gl-js.v1"
        assert config["saved_map"]["schema"] == "opengeo.saved-map-gl-occurrence.1.0.0"
        assert config["saved_map"]["recipe_checksum_sha256"] == recipe.checksum_sha256
        assert config["maplibre_style"] == json.loads(item.maplibre_style_json)
        assert config["map_view"] == {"center": [-71.1, 42.3], "zoom": 10, "pitch": 0, "bearing": 0}
        assert config["source_style"]["style_id"] == str(IDENTITY.style_id)
        assert (
            item.configuration_checksum_sha256
            == sha256(item.configuration_json.encode()).hexdigest()
        )
        assert config["font_ref"] == (FONT_REF if item.layer_id == "top" else None)
    assert [
        part["type"]
        for part in json.loads(passes[-1].configuration_json)["maplibre_style"]["layers"]
    ] == ["fill", "line", "symbol"]
    unbound = compile_saved_map_passes(recipe)
    assert bind_saved_map_pass(unbound[-1], IDENTITY) == passes[-1]


def test_sixteen_polygon_occurrences_are_not_reduced_to_eight_for_geometry_pass_limit():
    definition = saved_map(
        *[
            saved_layer(
                f"layer-{index}",
                index,
                labels={"enabled": True, "field": "name", "fontRef": FONT_REF},
            )
            for index in range(16)
        ]
    )
    passes = compile_saved_map_passes(compile_saved_map(definition))
    assert len(passes) == 16 and all(item.pass_count == 16 for item in passes)


def test_mixed_pinned_and_legacy_enabled_labels_never_silently_adopt_a_font():
    definition = labeled_map()
    definition["layers"][1]["labels"] = {"enabled": True, "field": "name"}
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_font_unpinned"):
        compile_saved_map_passes(compile_saved_map(definition))


@pytest.mark.parametrize(
    "change", [{"id": "unknown-font"}, {"version": 2}, {"manifestChecksumSha256": "0" * 64}]
)
def test_unknown_edition_or_changed_font_fails_before_job_writes(change):
    definition = labeled_map()
    definition["layers"][0]["labels"]["fontRef"] = {**FONT_REF, **change}
    # Unknown, structurally valid identities survive exchange but are not rendered.
    validate_map_definition(definition)
    transaction = Transaction([ROLES, binding(definition)])
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_font_unavailable"):
        submit(transaction)
    assert not transaction.executions


@pytest.mark.parametrize(
    "reference",
    [
        None,
        {},
        {**FONT_REF, "version": True},
        {**FONT_REF, "id": "../font"},
        {**FONT_REF, "url": "https://example.test/font"},
    ],
)
def test_font_reference_is_closed_and_never_an_authored_url_or_path(reference):
    definition = labeled_map()
    definition["layers"][0]["labels"]["fontRef"] = reference
    with pytest.raises(ValueError, match="fontRef"):
        validate_map_definition(definition)


@pytest.mark.parametrize(
    "changes",
    [
        {"size": 29},
        {"haloWidth": 7},
        {"color": "url(https://example.test)"},
        {"prefix": "x" * 513},
        {"allowOverlap": "yes"},
        {"field": ["name"]},
    ],
)
def test_pinned_label_settings_are_bounded_without_silent_normalization(changes):
    definition = labeled_map()
    definition["layers"][0]["labels"].update(changes)
    with pytest.raises(SavedMapRenderUnsupported):
        compile_saved_map(definition)


def test_tampered_detached_style_is_rejected_before_binding():
    item = compile_saved_map_passes(compile_saved_map(labeled_map()))[-1]
    tampered = replace(
        item, maplibre_style_json=item.maplibre_style_json.replace("#111827", "#ffffff")
    )
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_style_checksum_mismatch"):
        bind_saved_map_pass(tampered, IDENTITY)


def test_existing_job_submission_and_publication_revalidate_whole_gl_occurrences():
    definition = labeled_map()
    transaction = Transaction(
        [
            ROLES,
            binding(definition),
            None,
            SOURCE,
            ROLES,
            ROLES,
            SOURCE,
            ROLES,
            ROLES,
            None,  # no completed output for this exact source/Style/runtime pin vector
            (True,),
            job_row(),
        ]
    )
    runtime = RenderRuntimeReference("a" * 64, "x86_64")
    repo = PostgresRenderRepository(
        Executor(transaction),
        Downloads(),
        saved_map_gl_enabled=True,
        saved_map_gl_runtime_reference=runtime,
    )
    assert asyncio.run(
        request_saved_map_render(repo, CONTEXT, PROJECT_ID, RESOURCE_ID, REQUEST, "gl-enabled-test")
    ).dispatch_required
    profiles = [
        p
        for sql, p in transaction.executions
        if "INSERT INTO app.map_render_profile_versions\n" in sql
    ]
    pins = [
        p
        for sql, p in transaction.executions
        if "INSERT INTO app.map_render_job_source_pins\n" in sql
    ]
    assert len(profiles) == len(pins) == 2
    assert all(p[10].obj["renderer"] == PINNED_GL_RENDERER for p in profiles)
    assert all(p[10].obj["runtime_ref"] == runtime.as_dict() for p in profiles)
    sealed_binding, rows = sealed_rows(definition, runtime_reference=runtime)
    seal = read_seal(Transaction([sealed_binding], [rows]))
    assert [source["layerId"] for source in seal["sources"]] == ["bottom", "top"]
    assert seal["recipeChecksumSha256"] == compile_saved_map(definition).checksum_sha256
    assert seal["runtimeReference"] == runtime.as_dict()


def test_missing_deployed_runtime_fails_preflight_without_creating_a_doomed_job():
    assert Settings().saved_map_gl_enabled is False
    transaction = Transaction([ROLES, binding(labeled_map())])
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_font_renderer_unavailable"):
        submit(transaction)
    assert len(transaction.queries) == 2 and not transaction.executions


@pytest.mark.parametrize("labels", [False, True])
def test_saved_filter_routes_geometry_to_gl_and_changes_recipe_identity(labels):
    definition = saved_map(
        saved_layer(
            labels={"enabled": labels, "field": "name", **({"fontRef": FONT_REF} if labels else {})}
        )
    )
    original = compile_saved_map(definition)
    predicate = ["==", ["get", "status"], "reviewed"]
    definition["layers"][0]["filter"] = predicate
    recipe = compile_saved_map(definition)
    assert recipe.checksum_sha256 != original.checksum_sha256
    parts = json.loads(recipe.layers[0].maplibre_style_json)["layers"]
    assert all(part["filter"] == predicate for part in parts)
    passes = compile_saved_map_passes(recipe)
    assert all(part.renderer == "opengeo.maplibre-gl-js.v1" for part in passes)
    bound = bind_saved_map_pass(passes[0], IDENTITY)
    assert all(
        part["filter"] == predicate
        for part in json.loads(bound.configuration_json)["maplibre_style"]["layers"]
    )


def test_label_draw_order_is_sealed_and_routed_with_pinned_font():
    definition = labeled_map()
    baseline = compile_saved_map(definition)
    definition["layers"][0]["labels"]["drawOrder"] = "above-data"
    recipe = compile_saved_map(definition)
    assert baseline.checksum_sha256 != recipe.checksum_sha256
    selected = next(layer for layer in recipe.layers if layer.layer_id == "top")
    assert json.loads(selected.maplibre_style_json)["layers"][-1]["metadata"] == {
        "opengeo:drawOrder": "above-data"
    }
    assert all(
        part.renderer == "opengeo.maplibre-gl-js.v1" for part in compile_saved_map_passes(recipe)
    )
