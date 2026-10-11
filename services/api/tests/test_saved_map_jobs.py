import asyncio
import json
import math
import subprocess
import sys
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from opengeo_api.authorization import Action
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderNotFound
from opengeo_api.saved_map_jobs import (
    SavedMapRenderRequest,
    request_saved_map_render,
    saved_view_bbox,
)
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported, compile_saved_map
from opengeo_api.tenant_database import TenantContext
from test_rendering import (
    JOB_ID,
    ORG_ID,
    PROJECT_ID,
    RESOURCE_ID,
    RESOURCE_ID_2,
    RESOURCE_VERSION_ID,
    USER_ID,
    Transaction,
    job_row,
    repository,
)
from test_saved_map_rendering import DATASET_ID, VERSION_ID, saved_layer, saved_map

MAP_ID = UUID("88000000-0000-4000-8000-000000000084")
OBJECT_ID = UUID("82000000-0000-4000-8000-000000000084")
SOURCE_VERSION_ID = UUID("a1000000-0000-4000-8000-000000000084")
ROLES = ("member", "editor", None, False)
REQUEST = SavedMapRenderRequest(UUID(int=8401), 7, 3, 320, 240)
CONTEXT = TenantContext(USER_ID, ORG_ID)
SOURCE = (RESOURCE_ID_2, SOURCE_VERSION_ID, OBJECT_ID, "preview-storage-v3", "b" * 64)


def binding(definition: dict[str, Any] | None = None) -> tuple[Any, ...]:
    return RESOURCE_VERSION_ID, 7, MAP_ID, 3, definition or saved_map()


def submit(transaction: Transaction, request: SavedMapRenderRequest = REQUEST):
    return asyncio.run(
        request_saved_map_render(
            repository(transaction), CONTEXT, PROJECT_ID, RESOURCE_ID, request, "saved-map-test"
        )
    )


def request_checksum(definition: dict[str, Any], request=REQUEST) -> str:
    recipe = compile_saved_map(definition)
    return sha256(
        canonical_json_bytes(
            {
                "schema": "opengeo.saved-map-request.1.0.0",
                "resourceId": str(RESOURCE_ID),
                "resourceVersionId": str(RESOURCE_VERSION_ID),
                "recipeChecksumSha256": recipe.checksum_sha256,
                "bbox": saved_view_bbox(
                    json.loads(recipe.map_view_json or "null"), request.width, request.height
                ),
                "width": request.width,
                "height": request.height,
                "format": request.format,
            }
        )
    ).hexdigest()


def test_request_pins_each_ordered_geometry_pass_and_exact_source_bytes() -> None:
    definition = saved_map(saved_layer("top", 0), saved_layer("bottom", 1))
    definition["layers"][1]["style"]["fill"] = "#0000ff"
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
            None,  # no completed output with the same complete pin vector
            (True,),
            job_row(),
        ]
    )
    submission = submit(transaction)
    assert submission.dispatch_required is True
    assert not transaction.one

    def inserts(table):
        return [p for sql, p in transaction.executions if f"INSERT INTO app.{table}\n" in sql]

    styles = inserts("governed_resource_style_versions")
    profiles = inserts("map_render_profile_versions")
    pins = inserts("map_render_job_source_pins")
    jobs = inserts("map_render_jobs")
    recipe = compile_saved_map(definition)
    assert [p[3] for p in styles] == ["Survey bottom", "Survey top"]
    assert [p[4] for p in styles] == [layer.maplibre_style_json for layer in recipe.layers]
    assert [p[5] for p in styles] == [layer.style_checksum_sha256 for layer in recipe.layers]
    assert len(profiles) == len(pins) == 4
    configurations = [p[10].obj for p in profiles]
    assert [c["saved_map"]["layer_id"] for c in configurations] == [
        "bottom",
        "bottom",
        "top",
        "top",
    ]
    assert [c["saved_map"]["input_geometry"] for c in configurations] == [
        "native",
        "polygon-boundary",
        "native",
        "polygon-boundary",
    ]
    assert [c["geometry"]["opacity"] for c in configurations] == [0.2, 0.8, 0.2, 0.8]
    for position, (profile, config, pin) in enumerate(
        zip(profiles, configurations, pins, strict=True), 1
    ):
        assert profile[3:7] == (RESOURCE_ID, RESOURCE_VERSION_ID, DATASET_ID, VERSION_ID)
        style = styles[(position - 1) // 2]
        assert profile[7:9] == (style[2], style[0])
        assert config["source_style"]["style_id"] == str(style[2])
        assert config["source_style"]["style_version_id"] == str(style[0])
        assert (
            profile[11]
            == sha256(
                json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        )
        assert config["saved_map"]["position"] == position
        assert config["saved_map"]["recipe_checksum_sha256"] == recipe.checksum_sha256
        assert pin[2:] == (
            position,
            RESOURCE_ID_2,
            SOURCE_VERSION_ID,
            DATASET_ID,
            VERSION_ID,
            OBJECT_ID,
            "preview-storage-v3",
            "b" * 64,
        )
    assert [p[2] for p in inserts("map_render_job_layers")] == [2, 3, 4]
    assert jobs[0][3] == RESOURCE_ID
    assert jobs[0][7].obj == saved_view_bbox(definition["mapViews"][0], 320, 240)
    assert jobs[0][8:12] == (320, 240, "#061526", request_checksum(definition))
    bound = inserts("map_render_job_bindings")[0]
    assert bound[2:4] == (RESOURCE_ID, RESOURCE_VERSION_ID)
    assert canonical_json_bytes(bound[4].obj).decode() == recipe.canonical_json
    assert bound[5:] == (recipe.checksum_sha256, recipe.definition_checksum_sha256)
    source_queries = [
        (sql, p) for sql, p in transaction.queries if "FROM app.project_datasets" in sql
    ]
    assert len(source_queries) == 2
    for sql, parameters in source_queries:
        assert parameters[2:5] == (DATASET_ID, VERSION_ID, 3)
        # The production SELECT returns precisely the five values used by _Source.
        assert "SELECT resource.id, resource.current_version_id, object.id," in sql
        assert "object.s3_version_id, object.checksum_sha256" in sql
        assert "FOR SHARE OF resource, dataset" in sql
        assert "FOR SHARE OF resource, dataset, version" not in sql


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("expected_resource_version", 0, "saved_map_version_invalid"),
        ("expected_map_version", True, "saved_map_version_invalid"),
        ("expected_map_version", 9_007_199_254_740_992, "saved_map_version_invalid"),
        ("width", 63, "saved_map_dimensions_invalid"),
        ("height", 2049, "saved_map_dimensions_invalid"),
        ("width", True, "saved_map_dimensions_invalid"),
        ("format", "svg", "saved_map_dimensions_invalid"),
    ],
)
def test_invalid_request_has_no_reads_or_writes(field, value, code) -> None:
    transaction = Transaction([])
    with pytest.raises(RenderConflict, match=code):
        submit(transaction, replace(REQUEST, **{field: value}))
    assert not transaction.queries and not transaction.executions


@pytest.mark.parametrize(
    "row,code",
    [
        (None, "map_resource_snapshot_required"),
        ((RESOURCE_VERSION_ID, 8, MAP_ID, 3, saved_map()), "map_version_conflict"),
        ((RESOURCE_VERSION_ID, 7, MAP_ID, 4, saved_map()), "map_version_conflict"),
    ],
)
def test_missing_or_changed_bound_revision_fails_before_source_resolution(row, code) -> None:
    transaction = Transaction([ROLES, row])
    with pytest.raises(RenderConflict, match=code):
        submit(transaction)
    assert len(transaction.queries) == 2 and not transaction.executions


def test_unsupported_labels_fail_preflight_before_styles_profiles_or_job_exist() -> None:
    definition = saved_map(saved_layer(labels={"enabled": True, "field": "name"}))
    transaction = Transaction([ROLES, binding(definition)])
    with pytest.raises(SavedMapRenderUnsupported, match="saved_map_labels_worker_unsupported"):
        submit(transaction)
    assert len(transaction.queries) == 2 and not transaction.executions


def test_map_render_requires_configure_permission_before_reading_definition() -> None:
    transaction = Transaction([("member", "viewer", None, False)])
    with pytest.raises(RenderAccessDenied):
        submit(transaction)
    assert len(transaction.queries) == 1 and not transaction.executions


@pytest.mark.parametrize(
    "source_tail,error",
    [
        ([None], SavedMapRenderUnsupported),
        ([SOURCE, None], RenderNotFound),
        ([SOURCE, ("member", None, None, False)], RenderAccessDenied),
        ([SOURCE, ROLES, None], RenderNotFound),
        ([SOURCE, ROLES, ("member", None, None, False)], RenderAccessDenied),
    ],
)
def test_denied_later_layer_creates_nothing_even_after_first_source_succeeds(source_tail, error):
    definition = saved_map(saved_layer("top", 0), saved_layer("bottom", 1))
    transaction = Transaction(
        [ROLES, binding(definition), None, SOURCE, ROLES, ROLES, *source_tail]
    )
    with pytest.raises(error):
        submit(transaction)
    assert not transaction.executions
    assert not transaction.one


@pytest.mark.parametrize("state,dispatch", [("queued", True), ("completed", False)])
def test_exact_idempotent_request_reuses_job_and_rechecks_composition_access(
    monkeypatch, state, dispatch
):
    transaction = Transaction(
        [ROLES, binding(), (JOB_ID, RESOURCE_ID, request_checksum(saved_map())), job_row(state)]
    )
    repo = repository(transaction)
    access_checks = []

    async def require_access(*args):
        access_checks.append(args)

    monkeypatch.setattr(repo, "_require_composition_access", require_access)
    result = asyncio.run(
        request_saved_map_render(repo, CONTEXT, PROJECT_ID, RESOURCE_ID, REQUEST, "idempotent-test")
    )
    assert result.job.job_id == JOB_ID and result.dispatch_required is dispatch
    assert access_checks == [(transaction, CONTEXT, PROJECT_ID, JOB_ID, Action.RENDER_READ)]
    assert not transaction.executions


@pytest.mark.parametrize(
    "resource_id,checksum",
    [(RESOURCE_ID_2, request_checksum(saved_map())), (RESOURCE_ID, "f" * 64)],
)
def test_idempotency_key_cannot_select_a_different_resource_or_recipe(resource_id, checksum):
    transaction = Transaction([ROLES, binding(), (JOB_ID, resource_id, checksum)])
    with pytest.raises(RenderConflict, match="render_idempotency_conflict"):
        submit(transaction)
    assert not transaction.executions


def test_saved_view_uses_mercator_maplibre_512_pixel_world_scale() -> None:
    bbox = saved_view_bbox({"center": [0, 0], "zoom": 2}, 320, 240)
    resolution = 2 * math.pi * 6_378_137 / (512 * 2**2)
    assert bbox == pytest.approx(
        [-160 * resolution, -120 * resolution, 160 * resolution, 120 * resolution]
    )
    for view, code in [
        (None, "saved_map_view_required"),
        ({"center": [0, 89], "zoom": 2}, "saved_map_view_unsupported"),
        ({"center": [179, 0], "zoom": 2}, "saved_map_view_wrap_unsupported"),
    ]:
        with pytest.raises(SavedMapRenderUnsupported, match=code):
            saved_view_bbox(view, 320, 240)


@pytest.mark.parametrize("first", ["saved_map_jobs", "saved_map_publication", "rendering"])
def test_runtime_import_order_has_no_circular_import(first) -> None:
    modules = [first, "rendering", "saved_map_jobs", "saved_map_publication"]
    result = subprocess.run(
        [sys.executable, "-c", ";".join(f"import opengeo_api.{module}" for module in modules)],
        capture_output=True,
        text=True,
        check=False,
        cwd=Path(__file__).resolve().parents[1] / "src",
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("denied", [False, True])
def test_completed_reuse_pins_current_sources_and_only_retains_a_retry_key(monkeypatch, denied):
    definition = saved_map(saved_layer())
    transaction = Transaction(
        [
            ROLES,
            binding(definition),
            None,
            SOURCE,
            ROLES,
            ROLES,
            (JOB_ID,),
            job_row("completed"),
        ]
    )
    repo = repository(transaction)
    checked = []

    async def access(*args):
        checked.append(args)
        if denied:
            raise RenderAccessDenied("render.read")

    monkeypatch.setattr(repo, "_require_composition_access", access)
    call = request_saved_map_render(repo, CONTEXT, PROJECT_ID, RESOURCE_ID, REQUEST, "reuse-test")
    if denied:
        with pytest.raises(RenderAccessDenied):
            asyncio.run(call)
        assert not transaction.executions
    else:
        result = asyncio.run(call)
        assert result.job.job_id == JOB_ID and result.dispatch_required is False
        assert len(transaction.executions) == 1
        sql, params = transaction.executions[0]
        assert "INSERT INTO app.saved_map_render_reuse" in sql
        assert params == (ORG_ID, REQUEST.idempotency_key, JOB_ID, USER_ID)
    assert checked == [(transaction, CONTEXT, PROJECT_ID, JOB_ID, Action.RENDER_READ)]
    sql, params = next((sql, args) for sql, args in transaction.queries if "jsonb_agg" in sql)
    assert "job.state = 'completed'" in sql and "output.content_type = 'image/png'" in sql
    assert params[:4] == (ORG_ID, RESOURCE_ID, PROJECT_ID, request_checksum(definition))
    pins = params[4].obj
    assert [pin["position"] for pin in pins] == [1, 2]
    for pin in pins:
        assert pin["objectId"] == str(OBJECT_ID)
        assert pin["storageVersion"] == SOURCE[3] and pin["checksumSha256"] == SOURCE[4]
        assert pin["resourceVersionId"] == str(SOURCE_VERSION_ID)
