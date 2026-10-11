import asyncio
import json
from copy import deepcopy
from hashlib import sha256

import pytest

from opengeo_api.config import Settings
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.render_runtime import PINNED_GL_RENDERER, RenderRuntimeReference
from opengeo_api.rendering import PostgresRenderRepository, RenderConflict
from opengeo_api.saved_map_jobs import request_saved_map_render, saved_view_bbox
from opengeo_api.saved_map_render_passes import compile_saved_map_passes
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported, compile_saved_map
from test_rendering import JOB_ID, PROJECT_ID, RESOURCE_ID, Downloads, Executor, Transaction
from test_saved_map_gl_passes import labeled_map
from test_saved_map_jobs import CONTEXT, REQUEST, ROLES, binding
from test_saved_map_publication import read_seal, sealed_rows
from test_saved_map_render_passes import IDENTITY

RUNTIME = RenderRuntimeReference("a" * 64, "x86_64")


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {**RUNTIME.as_dict(), "url": "https://example.test/runtime"},
        {**RUNTIME.as_dict(), "manifestSha256": "A" * 64},
        {**RUNTIME.as_dict(), "manifestSha256": "a" * 64 + "\n"},
        {**RUNTIME.as_dict(), "manifestSha256": True},
        {**RUNTIME.as_dict(), "architecture": "amd64"},
        {**RUNTIME.as_dict(), "schemaVersion": "unknown"},
    ],
)
def test_runtime_identity_is_closed_and_never_selects_a_path_or_url(value):
    with pytest.raises(ValueError):
        RenderRuntimeReference.parse(value)


def test_settings_require_explicit_operator_pin_before_activation():
    assert Settings().saved_map_gl_runtime_reference is None
    with pytest.raises(ValueError):
        Settings(saved_map_gl_enabled=True)
    with pytest.raises(ValueError):
        Settings(saved_map_gl_runtime_sha256=RUNTIME.manifest_sha256)
    configured = Settings(
        saved_map_gl_enabled=True,
        saved_map_gl_runtime_sha256=RUNTIME.manifest_sha256,
        saved_map_gl_runtime_architecture=RUNTIME.architecture,
    )
    assert configured.saved_map_gl_runtime_reference == RUNTIME


def test_runtime_changes_job_configuration_not_authored_map_recipe_or_style():
    definition = labeled_map()
    original = deepcopy(definition)
    recipe = compile_saved_map(definition)
    bindings = {"top": IDENTITY, "bottom": IDENTITY}
    old = compile_saved_map_passes(recipe, style_bindings=bindings)
    pinned = compile_saved_map_passes(recipe, style_bindings=bindings, runtime_reference=RUNTIME)
    changed = compile_saved_map_passes(
        recipe,
        style_bindings=bindings,
        runtime_reference=RenderRuntimeReference("b" * 64, "aarch64"),
    )
    assert definition == original
    for legacy, first, second in zip(old, pinned, changed, strict=True):
        assert legacy.renderer == "opengeo.maplibre-gl-js.v1"
        assert "runtime_ref" not in json.loads(legacy.configuration_json)
        assert first.renderer == second.renderer == PINNED_GL_RENDERER
        assert json.loads(first.configuration_json)["runtime_ref"] == RUNTIME.as_dict()
        assert first.configuration_checksum_sha256 != second.configuration_checksum_sha256
        assert first.recipe_checksum_sha256 == second.recipe_checksum_sha256
        assert first.maplibre_style_json == second.maplibre_style_json == legacy.maplibre_style_json


def test_direct_repository_cannot_enable_unpinned_new_font_jobs():
    transaction = Transaction([ROLES, binding(labeled_map())])
    repo = PostgresRenderRepository(Executor(transaction), Downloads(), saved_map_gl_enabled=True)
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_font_renderer_unavailable"):
        asyncio.run(
            request_saved_map_render(
                repo, CONTEXT, PROJECT_ID, RESOURCE_ID, REQUEST, "no-runtime-pin"
            )
        )
    assert not transaction.executions


def test_same_request_key_cannot_change_runtime_after_operator_upgrade():
    definition = labeled_map()
    bound = binding(definition)
    checksum = sha256(
        canonical_json_bytes(
            {
                "schema": "opengeo.saved-map-request.1.0.0",
                "resourceId": str(RESOURCE_ID),
                "resourceVersionId": str(bound[0]),
                "recipeChecksumSha256": compile_saved_map(definition).checksum_sha256,
                "bbox": saved_view_bbox(definition["mapViews"][0], REQUEST.width, REQUEST.height),
                "width": REQUEST.width,
                "height": REQUEST.height,
                "format": "png",
                "runtimeReference": RUNTIME.as_dict(),
            }
        )
    ).hexdigest()
    transaction = Transaction([ROLES, bound, (JOB_ID, RESOURCE_ID, checksum)])
    repo = PostgresRenderRepository(
        Executor(transaction),
        Downloads(),
        saved_map_gl_enabled=True,
        saved_map_gl_runtime_reference=RenderRuntimeReference("b" * 64, "aarch64"),
    )
    with pytest.raises(RenderConflict, match="render_idempotency_conflict"):
        asyncio.run(
            request_saved_map_render(
                repo, CONTEXT, PROJECT_ID, RESOURCE_ID, REQUEST, "changed-runtime"
            )
        )
    assert not transaction.executions


def test_publication_reuses_job_pin_not_current_deployment_settings():
    bound, rows = sealed_rows(labeled_map(), runtime_reference=RUNTIME)
    transaction = Transaction([bound], [rows])
    repo = PostgresRenderRepository(
        Executor(transaction),
        Downloads(),
        saved_map_gl_enabled=False,
        saved_map_gl_runtime_reference=RenderRuntimeReference("b" * 64, "aarch64"),
    )
    assert read_seal(transaction, repo=repo)["runtimeReference"] == RUNTIME.as_dict()
    assert not transaction.executions


@pytest.mark.parametrize("mutation", ["missing", "mixed", "downgrade", "unknown"])
def test_publication_denies_missing_or_inconsistent_runtime_identity(mutation):
    bound, rows = sealed_rows(labeled_map(), runtime_reference=RUNTIME)
    rows = [list(row) for row in rows]
    config = rows[-1][13]
    if mutation == "missing":
        del config["runtime_ref"]
    elif mutation == "mixed":
        config["runtime_ref"]["manifestSha256"] = "b" * 64
    elif mutation == "downgrade":
        config["renderer"] = "opengeo.maplibre-gl-js.v1"
        del config["runtime_ref"]
    else:
        config["runtime_ref"]["url"] = "https://example.test/runtime"
    rows[-1][14] = sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with pytest.raises(RenderConflict, match="saved_map_presentation_changed"):
        read_seal(Transaction([bound], [rows]))
