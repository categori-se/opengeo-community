import asyncio
import json
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderNotFound
from opengeo_api.saved_map_publication import load_saved_map_seal
from opengeo_api.saved_map_render_passes import compile_saved_map_passes
from opengeo_api.saved_map_rendering import compile_saved_map
from test_rendering import (
    JOB_ID,
    PROJECT_ID,
    RESOURCE_ID,
    RESOURCE_ID_2,
    RESOURCE_VERSION_ID,
    Transaction,
    repository,
)
from test_saved_map_jobs import CONTEXT, MAP_ID, OBJECT_ID, ROLES, SOURCE_VERSION_ID
from test_saved_map_render_passes import IDENTITY
from test_saved_map_rendering import saved_layer, saved_map


def sealed_rows(definition=None, *, runtime_reference=None, resolved_styles=None):
    definition = definition or saved_map(saved_layer("top", 0), saved_layer("bottom", 1))
    recipe = compile_saved_map(definition, resolved_styles=resolved_styles)
    bindings = {
        layer.layer_id: replace(
            IDENTITY, style_id=UUID(int=8400 + index), style_version_id=UUID(int=8500 + index)
        )
        for index, layer in enumerate(recipe.layers)
    }
    passes = compile_saved_map_passes(
        recipe, style_bindings=bindings, runtime_reference=runtime_reference
    )
    binding = (
        MAP_ID,
        3,
        json.loads(recipe.canonical_json),
        recipe.checksum_sha256,
        recipe.definition_checksum_sha256,
        definition,
    )
    rows = []
    for item in passes:
        identity = bindings[item.layer_id]
        rows.append(
            (
                item.position,
                RESOURCE_ID_2,
                SOURCE_VERSION_ID,
                item.dataset_id,
                item.dataset_version_id,
                OBJECT_ID,
                "preview-storage-v3",
                "b" * 64,
                "published",
                "public",
                "CC-BY-4.0",
                "Survey team",
                "public",
                json.loads(item.configuration_json or "null"),
                item.configuration_checksum_sha256,
                identity.style_id,
                identity.style_version_id,
                identity.version_number,
                item.maplibre_style_json,
                item.style_checksum_sha256,
                item.dataset_version_number,
                4096,
                "application/geo+json",
            )
        )
    return binding, rows


def read_seal(transaction, *, public=True, repo=None):
    return asyncio.run(
        load_saved_map_seal(
            transaction,
            CONTEXT,
            PROJECT_ID,
            RESOURCE_ID,
            RESOURCE_VERSION_ID,
            JOB_ID,
            public=public,
            repository=repo,
        )
    )


def test_public_seal_preserves_order_repeated_dataset_occurrences_and_exact_byte_pins() -> None:
    binding, rows = sealed_rows()
    transaction = Transaction([binding], [rows])
    seal = read_seal(transaction)
    assert seal["resourceVersionId"] == str(RESOURCE_VERSION_ID)
    assert seal["mapId"] == str(MAP_ID) and seal["mapVersion"] == 3
    assert seal["recipeChecksumSha256"] == binding[3]
    assert seal["definitionChecksumSha256"] == binding[4]
    assert [source["layerId"] for source in seal["sources"]] == ["bottom", "bottom", "top", "top"]
    assert [source["position"] for source in seal["sources"]] == [1, 2, 3, 4]
    for source, row in zip(seal["sources"], rows, strict=True):
        assert source == {
            "position": row[0],
            "layerId": "bottom" if row[0] < 3 else "top",
            "resourceId": str(RESOURCE_ID_2),
            "resourceVersionId": str(SOURCE_VERSION_ID),
            "datasetId": str(row[3]),
            "datasetVersionId": str(row[4]),
            "objectId": str(OBJECT_ID),
            "checksumSha256": "b" * 64,
            "sizeBytes": 4096,
            "contentType": "application/geo+json",
            "configurationChecksumSha256": row[14],
            "attribution": "Survey team",
            "license": "CC-BY-4.0",
        }
    # Public revalidation uses pinned authorization, not requesting-user membership.
    assert len(transaction.queries) == 2 and not transaction.executions
    sql, parameters = transaction.queries[1]
    assert parameters == (
        RESOURCE_ID,
        RESOURCE_VERSION_ID,
        PROJECT_ID,
        CONTEXT.organization_id,
        JOB_ID,
    )
    for required in (
        "object.id = pin.source_object_id",
        "object.s3_version_id = pin.source_s3_version_id",
        "object.checksum_sha256 = pin.source_checksum_sha256",
        "metadata.id = pin.source_resource_version_id",
        "link.dataset_version_id = pin.dataset_version_id",
        "layer.position = pin.position",
        "profile.resource_version_id = %s",
        "ORDER BY pin.position",
    ):
        assert required in sql


def test_configuration_hash_uses_worker_float_serialization_not_recipe_canonicalization() -> None:
    binding, rows = sealed_rows()
    configuration = rows[0][13]
    worker_bytes = json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()
    assert worker_bytes != canonical_json_bytes(configuration)
    assert sha256(worker_bytes).hexdigest() == rows[0][14]
    assert (
        read_seal(Transaction([binding], [rows]))["sources"][0]["configurationChecksumSha256"]
        == rows[0][14]
    )


@pytest.mark.parametrize(
    "index,value",
    [
        (8, "draft"),
        (8, "archived"),
        (9, "private"),
        (12, "restricted"),
        (10, "proprietary"),
        (10, None),
        (11, " "),
        (11, None),
    ],
)
def test_revoked_or_non_public_source_denies_the_entire_map(index, value) -> None:
    binding, rows = sealed_rows()
    changed = list(rows[-1])
    changed[index] = value
    rows[-1] = tuple(changed)
    transaction = Transaction([binding], [rows])
    with pytest.raises(RenderConflict, match="saved_map_source_not_public"):
        read_seal(transaction)
    assert not transaction.executions


@pytest.mark.parametrize("index", [2, 3, 4, 5])
def test_recipe_or_bound_history_mismatch_denies_before_reading_sources(index) -> None:
    binding, rows = sealed_rows()
    changed = list(deepcopy(binding))
    if index == 2:
        changed[index]["background_color"] = "#ffffff"
    elif index == 5:
        changed[index]["layers"][0]["style"]["fill"] = "#ffffff"
    else:
        changed[index] = "f" * 64
    transaction = Transaction([tuple(changed)], [rows])
    with pytest.raises(RenderConflict, match="saved_map_recipe_changed"):
        read_seal(transaction)
    assert len(transaction.queries) == 1 and not transaction.executions


@pytest.mark.parametrize(
    "index,value",
    [
        (0, 2),
        (3, UUID(int=99)),
        (4, UUID(int=98)),
        (20, 4),
        (18, '{"version":8,"layers":[]}'),
        (19, "f" * 64),
    ],
)
def test_wrong_pass_version_or_style_cannot_replace_a_saved_occurrence(index, value) -> None:
    binding, rows = sealed_rows()
    changed = list(rows[0])
    changed[index] = value
    rows[0] = tuple(changed)
    with pytest.raises(RenderConflict, match="saved_map_sources_changed"):
        read_seal(Transaction([binding], [rows]))


def test_explicit_saved_object_id_cannot_be_substituted() -> None:
    binding, rows = sealed_rows(saved_map(saved_layer(objectId=str(OBJECT_ID))))
    changed = list(rows[0])
    changed[5] = UUID(int=97)
    rows[0] = tuple(changed)
    with pytest.raises(RenderConflict, match="saved_map_sources_changed"):
        read_seal(Transaction([binding], [rows]))


@pytest.mark.parametrize("tamper", ["checksum", "configuration", "rehashed_configuration"])
def test_replacement_configuration_is_rejected_even_with_its_own_valid_hash(tamper) -> None:
    binding, rows = sealed_rows()
    changed = list(rows[0])
    if tamper == "checksum":
        changed[14] = "f" * 64
    else:
        changed[13]["geometry"]["opacity"] = 0.99
        if tamper == "rehashed_configuration":
            changed[14] = sha256(
                json.dumps(changed[13], sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
    rows[0] = tuple(changed)
    with pytest.raises(RenderConflict, match="saved_map_presentation_changed"):
        read_seal(Transaction([binding], [rows]))


def test_missing_binding_or_exact_pinned_source_is_not_rediscovered() -> None:
    with pytest.raises(RenderConflict, match="saved_map_binding_unavailable"):
        read_seal(Transaction([None]))
    binding, rows = sealed_rows()
    for selected in ([], rows[:-1], [*rows, rows[-1]]):
        with pytest.raises(RenderConflict, match="saved_map_sources_unavailable"):
            read_seal(Transaction([binding], [selected]))


def test_private_seal_checks_source_authorization_once_per_resource_and_dataset() -> None:
    binding, rows = sealed_rows()
    rows = [
        tuple("private" if index == 9 else value for index, value in enumerate(row)) for row in rows
    ]
    transaction = Transaction([binding, ROLES, ROLES], [rows])
    seal = read_seal(transaction, public=False, repo=repository(transaction))
    assert len(seal["sources"]) == 4
    assert len(transaction.queries) == 4 and not transaction.one
    assert not transaction.executions


@pytest.mark.parametrize(
    "access,error",
    [
        ([None], RenderNotFound),
        ([("member", None, None, False)], RenderAccessDenied),
        ([ROLES, None], RenderNotFound),
        ([ROLES, ("member", None, None, False)], RenderAccessDenied),
    ],
)
def test_private_source_revocation_denies_map_read(access, error) -> None:
    binding, rows = sealed_rows()
    transaction = Transaction([binding, *access], [rows])
    with pytest.raises(error):
        read_seal(transaction, public=False, repo=repository(transaction))
    assert not transaction.executions


def test_private_seal_cannot_omit_authorization_repository() -> None:
    binding, rows = sealed_rows()
    with pytest.raises(RenderNotFound, match="resource"):
        read_seal(Transaction([binding], [rows]), public=False)


def style_bound_rows():
    from dataclasses import astuple
    from datetime import UTC, datetime

    from opengeo_api.resources import ResourceStyle

    original = (
        '{"version":8,"sources":{},"layers":[{"id":"roads","type":"line",'
        '"paint":{"line-color":"#123456","line-width":3}}]}\r\n'
    )
    style = ResourceStyle(
        UUID(int=901),
        RESOURCE_ID_2,
        "roads",
        "maplibre",
        2,
        "Roads",
        "application/json",
        original,
        sha256(original.encode()).hexdigest(),
        None,
        CONTEXT.user_id,
        datetime.now(UTC),
        datetime.now(UTC),
    )
    reference = {
        "projectId": str(PROJECT_ID),
        "resourceId": str(style.resource_id),
        "styleId": str(style.style_id),
        "versionNumber": 2,
        "checksumSha256": style.checksum_sha256,
        "format": "maplibre",
    }
    definition = saved_map(saved_layer(geometryType="LineString", styleReference=reference))
    definition["schemaVersion"] = "opengeo.map-definition.1.4.0"
    binding, rows = sealed_rows(definition, resolved_styles={"areas": style})
    return binding, rows, astuple(style), reference


def test_private_seal_resolves_original_style_revision_and_preserves_reference():
    binding, rows, style, reference = style_bound_rows()
    transaction = Transaction([binding, ROLES, style, ROLES, ROLES], [rows])
    seal = read_seal(transaction, public=False, repo=repository(transaction))
    assert seal["styleDependencies"] == [
        {
            "layerId": "areas",
            "datasetId": str(rows[0][3]),
            "reference": reference,
        }
    ]
    assert seal["recipeChecksumSha256"] == binding[3]
    assert transaction.queries[2][1][4] == 2  # exact version, never current head
    assert not transaction.executions and not transaction.one


@pytest.mark.parametrize("fault", ["revoked", "missing", "corrupt", "substituted"])
def test_private_seal_rejects_unavailable_style_without_inline_fallback(fault):
    binding, rows, style, _ = style_bound_rows()
    if fault == "revoked":
        responses = [("member", None, None, False)]
    elif fault == "missing":
        responses = [ROLES, None]
    else:
        changed = list(style)
        changed[7 if fault == "corrupt" else 4] = "corrupt" if fault == "corrupt" else 3
        responses = [ROLES, tuple(changed)]
    transaction = Transaction([binding, *responses], [rows])
    with pytest.raises(RenderConflict, match="saved_map_style_unavailable"):
        read_seal(transaction, public=False, repo=repository(transaction))
    assert not transaction.executions
    assert len(transaction.all_rows) == 1  # refused before accessing data-source pins


def test_public_seal_does_not_use_private_style_access_to_authorize_distribution():
    binding, rows, _, _ = style_bound_rows()
    transaction = Transaction([binding], [rows])
    with pytest.raises(RenderConflict, match="saved_map_style_publication_unsupported"):
        read_seal(transaction)
    assert len(transaction.queries) == 1 and not transaction.executions
