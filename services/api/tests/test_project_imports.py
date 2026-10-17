import asyncio
import json
from copy import deepcopy
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.project_imports import (
    PostgresProjectImportRepository,
    ProjectImportConflict,
    _legacy_geolibre_json,
    geolibre_return_metadata,
    rewrite_import_definition,
    upgrade_import_map_definition,
    validate_geolibre_return,
)
from test_map_definitions import definition as valid_definition
from test_workspaces import (
    DATASET_ID,
    DATASET_VERSION_ID,
    MAP_ID,
    NOW,
    ORG_ID,
    PROJECT_ID,
    USER_ID,
    FakeExecutor,
    FakeTransaction,
    context,
)

IMPORT_ID = UUID("81000000-0000-4000-8000-000000000001")
OUTPUT_ID = UUID("82000000-0000-4000-8000-000000000001")
OBJECT_ID = UUID("83000000-0000-4000-8000-000000000001")


def return_base() -> dict:
    base = valid_definition()
    base["layers"] = [base["layers"][0]]
    layer = base["layers"][0]
    for key in ("sourceUrl", "sourceConfiguration"):
        layer.pop(key)
    layer.update(
        {
            "sourceType": "governed-dataset",
            "datasetVersionId": str(DATASET_VERSION_ID),
            "objectId": str(OBJECT_ID),
            "sourceVersion": 1,
            "geometryType": "LineString",
        }
    )
    return base


def reviewed_return(base: dict, *, output: bool = True) -> dict:
    definition = deepcopy(base)
    definition["layers"][0]["opacity"] = 0.6
    outputs = []
    if output:
        definition["layers"].append(
            {
                **deepcopy(base["layers"][0]),
                "layerId": "returned-roads",
                "datasetId": "import:returned-roads",
                "objectId": "pending-import:returned-roads",
                "sourceType": "geojson-object",
                "importRef": "geolibre:returned-roads",
            }
        )
        definition["layers"][-1].pop("datasetVersionId")
        outputs = [
            {
                "layerId": "returned-roads",
                "importRef": "geolibre:returned-roads",
                "inputLayerIds": ["source_roads"],
                "retention": "retained-output",
                "reproducible": False,
            }
        ]
    definition["extensions"] = {
        **base.get("extensions", {}),
        "opengeoGeoLibreReturn": {
            "schemaVersion": "opengeo.geolibre-return.1.0.0",
            "base": {
                "mapId": str(MAP_ID),
                "mapVersion": 3,
                "definitionSha256": sha256(_legacy_geolibre_json(base).encode()).hexdigest(),
            },
            "inputs": [
                {
                    "layerId": "source_roads",
                    "datasetId": str(DATASET_ID),
                    "datasetVersionId": str(DATASET_VERSION_ID),
                }
            ],
            "outputs": outputs,
        },
    }
    return definition


def history_rows(base: dict) -> list[tuple]:
    encoded = json.dumps(base, ensure_ascii=False).encode()
    return [
        (index // 24_576, encoded[index : index + 24_576], len(encoded))
        for index in range(0, len(encoded), 24_576)
    ]


def import_row(*, completed: bool = False) -> tuple:
    return (
        IMPORT_ID,
        PROJECT_ID,
        MAP_ID,
        IMPORT_ID,
        "geolibre",
        "3.0.0",
        "a" * 64,
        "b" * 64,
        3,
        "completed" if completed else "open",
        USER_ID,
        NOW,
        NOW,
        NOW if completed else None,
    )


def test_upgrade_import_definition_adds_processing_state_without_mutating_legacy() -> None:
    legacy = {"schemaVersion": "opengeo.map-definition.1.0.0", "layers": []}

    upgraded = upgrade_import_map_definition(legacy)

    assert legacy == {"schemaVersion": "opengeo.map-definition.1.0.0", "layers": []}
    assert upgraded == {
        "schemaVersion": "opengeo.map-definition.1.3.0",
        "layers": [],
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
    }

    unknown = {"schemaVersion": "opengeo.map-definition.9.0.0", "layers": []}
    assert upgrade_import_map_definition(unknown) == unknown


def test_rewrite_replaces_real_dataset_object_and_source_identities() -> None:
    definition = {
        "layers": [
            {
                "layerId": "embedded",
                "datasetId": "import:embedded",
                "objectId": "pending-import:embedded",
                "importRef": "geolibre:embedded",
                "sourceType": "geojson-object",
            },
            {
                "layerId": "archive",
                "datasetId": "import:archive",
                "importRef": "geolibre:archive",
                "sourceType": "pmtiles-vector",
            },
        ]
    }
    rewritten = rewrite_import_definition(
        definition,
        {
            "geolibre:embedded": {
                "datasetId": "80000000-0000-4000-8000-000000000001",
                "objectId": "82000000-0000-4000-8000-000000000001",
                "sourceType": "governed-dataset",
                "datasetVersionId": "83000000-0000-4000-8000-000000000001",
                "sourceVersion": 1,
            },
            "geolibre:archive": {
                "datasetId": "80000000-0000-4000-8000-000000000002",
                "sourceType": "pmtiles",
                "sourceVersion": 1,
                "sourceUrl": "https://data.example.test/public.pmtiles",
                "sourceConfiguration": {
                    "tileType": "vector",
                    "sourceLayer": "public",
                    "geometryType": "Polygon",
                },
            },
        },
    )

    assert rewritten["layers"][0]["datasetId"].endswith("0001")
    assert rewritten["layers"][0]["objectId"].startswith("82000000")
    assert rewritten["layers"][0]["sourceType"] == "governed-dataset"
    assert rewritten["layers"][0]["datasetVersionId"].startswith("83000000")
    assert rewritten["layers"][0]["sourceVersion"] == 1
    assert rewritten["layers"][1]["sourceType"] == "pmtiles-vector"
    assert rewritten["layers"][1]["sourceVersion"] == 1
    assert all("importRef" not in layer for layer in rewritten["layers"])
    assert definition["layers"][0]["datasetId"] == "import:embedded"


@pytest.mark.parametrize(
    ("definition", "replacements", "code"),
    [
        (
            {"layers": [{"importRef": "geolibre:one"}]},
            {},
            "project_import_reference_invalid",
        ),
        (
            {"layers": []},
            {"geolibre:unused": {"datasetId": "80000000-0000-4000-8000-000000000001"}},
            "project_import_reference_invalid",
        ),
        (
            {"layers": [{"datasetId": "import:unmanaged"}]},
            {},
            "project_import_placeholder_remaining",
        ),
    ],
)
def test_rewrite_fails_closed_on_unmatched_or_placeholder_references(
    definition, replacements, code
) -> None:
    with pytest.raises(ProjectImportConflict, match=code):
        rewrite_import_definition(definition, replacements)


@pytest.mark.parametrize("kind", ["provider-style", "provider-raster"])
def test_rewrite_does_not_import_a_local_provider_binding(kind: str) -> None:
    with pytest.raises(ProjectImportConflict, match="project_import_basemap_connection_required"):
        rewrite_import_definition(
            {
                "layers": [],
                "basemaps": [
                    {
                        "kind": kind,
                        "connectionBindingId": "c1000000-0000-4000-8000-000000000056",
                    }
                ],
            },
            {},
        )


def test_return_accepts_presentation_and_retained_output_with_exact_input_version() -> None:
    base = return_base()
    returned = reviewed_return(base)
    validate_geolibre_return(returned, base, MAP_ID, 3, {"geolibre:returned-roads"})
    # A deliberate separate target can use the retained historic base.
    validate_geolibre_return(returned, base, OUTPUT_ID, 1, {"geolibre:returned-roads"})


def test_return_local_style_can_detach_original_managed_style() -> None:
    base = return_base()
    base["layers"][0]["styleReference"] = {"styleId": "retained-base-style"}
    returned = reviewed_return(base)
    returned["layers"][0].pop("styleReference")
    returned["layers"][0]["style"] = {"lineColor": "#ff0000"}
    validate_geolibre_return(returned, base, MAP_ID, 3, {"geolibre:returned-roads"})


def test_rewrite_records_authoritative_output_dataset_and_version() -> None:
    returned = reviewed_return(return_base())
    metadata = returned["extensions"]["opengeoGeoLibreReturn"]
    metadata["outputs"][0]["inputLinkMethod"] = "user-declared"
    rewritten = rewrite_import_definition(
        returned,
        {
            "geolibre:returned-roads": {
                "datasetId": str(OUTPUT_ID),
                "datasetVersionId": str(DATASET_VERSION_ID),
                "objectId": str(OBJECT_ID),
                "sourceType": "governed-dataset",
                "sourceVersion": 1,
            }
        },
    )
    output = rewritten["extensions"]["opengeoGeoLibreReturn"]["outputs"][0]
    assert output["datasetId"] == str(OUTPUT_ID)
    assert output["datasetVersionId"] == str(DATASET_VERSION_ID)
    assert output["inputLinkMethod"] == "user-declared"
    assert "datasetId" not in metadata["outputs"][0]
    metadata["outputs"][0]["datasetId"] = str(OUTPUT_ID)
    with pytest.raises(ProjectImportConflict, match="geolibre_return_metadata_invalid"):
        geolibre_return_metadata(returned)


@pytest.mark.parametrize(
    "field",
    [
        "datasetId",
        "datasetVersionId",
        "objectId",
        "sourceVersion",
        "sourceType",
        "sourceUrl",
        "sourceConfiguration",
        "sharedSourceId",
        "styleReference",
        "generation",
    ],
)
def test_return_rejects_changed_or_added_source_identity(field: str) -> None:
    base = return_base()
    returned = reviewed_return(base)
    returned["layers"][0][field] = "untrusted"
    with pytest.raises(ProjectImportConflict, match="geolibre_return_layer_identity_invalid"):
        validate_geolibre_return(returned, base, MAP_ID, 3, {"geolibre:returned-roads"})


def test_return_rejects_unrelated_reused_layer_and_changed_base_or_stale_target() -> None:
    base = return_base()
    returned = reviewed_return(base)
    returned["layers"][0]["layerId"] = "borrowed-layer"
    with pytest.raises(ProjectImportConflict, match="geolibre_return_layer_identity_invalid"):
        validate_geolibre_return(returned, base, MAP_ID, 3, {"geolibre:returned-roads"})
    with pytest.raises(ProjectImportConflict, match="geolibre_return_base_version_conflict"):
        validate_geolibre_return(
            reviewed_return(base), base, MAP_ID, 4, {"geolibre:returned-roads"}
        )
    changed_base = deepcopy(base)
    changed_base["layers"][0]["title"] = "Changed"
    with pytest.raises(ProjectImportConflict, match="geolibre_return_base_mismatch"):
        validate_geolibre_return(
            reviewed_return(base), changed_base, MAP_ID, 3, {"geolibre:returned-roads"}
        )


@pytest.mark.parametrize(
    "mutation,code",
    [
        (lambda meta: meta["inputs"][0].update(datasetId=str(OUTPUT_ID)), "inputs"),
        (lambda meta: meta["inputs"].append(deepcopy(meta["inputs"][0])), "inputs"),
        (lambda meta: meta["outputs"][0].update(inputLayerIds=["unrelated"]), "outputs"),
        (lambda meta: meta["outputs"][0].update(importRef="geolibre:unregistered"), "outputs"),
        (lambda meta: meta["outputs"][0].update(layerId="source_roads"), "outputs"),
        (lambda meta: meta["outputs"].clear(), "outputs"),
    ],
)
def test_return_rejects_false_input_and_output_declarations(mutation, code: str) -> None:
    base = return_base()
    returned = reviewed_return(base)
    mutation(returned["extensions"]["opengeoGeoLibreReturn"])
    with pytest.raises(ProjectImportConflict, match=f"geolibre_return_{code}_invalid"):
        validate_geolibre_return(returned, base, MAP_ID, 3, {"geolibre:returned-roads"})


@pytest.mark.parametrize(
    "mutation",
    [
        lambda meta: meta.update(schemaVersion="unrecognized"),
        lambda meta: meta["base"].update(mapVersion=True),
        lambda meta: meta["base"].update(mapId="other-tenant"),
        lambda meta: meta["outputs"][0].update(reproducible=True),
        lambda meta: meta["outputs"][0].update(retention="reproducible"),
        lambda meta: meta["outputs"][0].update(inputLayerIds=["source_roads", "source_roads"]),
        lambda meta: meta.update(trusted=True),
    ],
)
def test_return_metadata_fails_closed(mutation) -> None:
    returned = reviewed_return(return_base())
    mutation(returned["extensions"]["opengeoGeoLibreReturn"])
    with pytest.raises(ProjectImportConflict, match="geolibre_return_metadata_invalid"):
        geolibre_return_metadata(returned)


def test_return_base_hash_matches_legacy_javascript_numeric_and_property_order() -> None:
    # Retained JSON.stringify output includes numeric-key enumeration and its
    # exponent thresholds; Python's ordinary json.dumps differs on both.
    assert _legacy_geolibre_json(
        {"z": [-0.0, 1.0, 1e-7, 1e-6, 1e20, 1e21], "10": "ten", "2": "two", "a": "é"}
    ) == ('{"2":"two","10":"ten","a":"é","z":[0,1,1e-7,0.000001,100000000000000000000,1e+21]}')


def test_return_history_is_scoped_to_project_and_current_input_access_is_required() -> None:
    base = return_base()
    returned = reviewed_return(base)
    transaction = FakeTransaction(all_rows=[history_rows(base), []])
    repository = PostgresProjectImportRepository(FakeExecutor(transaction))
    with pytest.raises(ProjectImportConflict, match="map_dataset_not_linked"):
        asyncio.run(
            repository._require_geolibre_return(
                transaction, context(), PROJECT_ID, MAP_ID, 3, returned, {"geolibre:returned-roads"}
            )
        )
    history_query = transaction.calls[0]
    assert "map.project_id = %s" in history_query[1]
    assert PROJECT_ID in history_query[2]
    assert ORG_ID in history_query[2]


@pytest.mark.parametrize("padding_bytes", [0, 70_000])
def test_return_finalize_rechecks_current_references_and_writes_reviewed_history(
    padding_bytes: int,
) -> None:
    base = return_base()
    base["extensions"] = {"retainedContext": "x" * padding_bytes}
    returned = reviewed_return(base, output=False)
    version_rows = [(str(DATASET_ID), str(DATASET_VERSION_ID), 1)]
    transaction = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "owner"),
            import_row(),
            (3,),
            import_row(completed=True),
        ],
        all_rows=[
            [],
            history_rows(returned),
            history_rows(base),
            [(DATASET_ID,)],
            version_rows,
            [(DATASET_ID,)],
            version_rows,
            [],
        ],
    )
    completed = asyncio.run(
        PostgresProjectImportRepository(FakeExecutor(transaction)).finalize_import(
            context(), PROJECT_ID, IMPORT_ID, "review-return"
        )
    )
    assert completed.final_map_version == 4
    version_insert = next(
        call for call in transaction.calls if "INSERT INTO app.map_versions" in call[1]
    )
    assert "GeoLibre reviewed return" in version_insert[2]
    assert sum("FOR KEY SHARE OF project_dataset" in call[1] for call in transaction.calls) == 2


def test_return_finalize_does_not_overwrite_a_later_edit() -> None:
    base = return_base()
    returned = reviewed_return(base, output=False)
    version_rows = [(str(DATASET_ID), str(DATASET_VERSION_ID), 1)]
    transaction = FakeTransaction(
        one=[("member",), (PROJECT_ID, "owner"), import_row(), (4,)],
        all_rows=[
            [],
            history_rows(returned),
            history_rows(base),
            [(DATASET_ID,)],
            version_rows,
            [(DATASET_ID,)],
            version_rows,
        ],
    )
    with pytest.raises(ProjectImportConflict, match="map_version_conflict") as failure:
        asyncio.run(
            PostgresProjectImportRepository(FakeExecutor(transaction)).finalize_import(
                context(), PROJECT_ID, IMPORT_ID, "review-return"
            )
        )
    assert failure.value.current_version == 4
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_import_finalize_accepts_completed_upload_queued_for_conversion() -> None:
    pending = reviewed_return(return_base())
    pending.pop("extensions")
    pending["layers"] = [pending["layers"][-1]]
    pending["activeLayerId"] = "returned-roads"
    item_rows = [
        (
            "geolibre:returned-roads",
            "embedded_dataset",
            "upload",
            "geojson",
            {},
            "bound",
            OUTPUT_ID,
            NOW,
        )
    ]
    transaction = FakeTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "owner"),
            import_row(),
            (OBJECT_ID, DATASET_VERSION_ID, 1),
            (3,),
            import_row(completed=True),
        ],
        all_rows=[item_rows, history_rows(pending), item_rows],
    )
    completed = asyncio.run(
        PostgresProjectImportRepository(FakeExecutor(transaction)).finalize_import(
            context(), PROJECT_ID, IMPORT_ID, "queued-output"
        )
    )
    assert completed.state == "completed"
    binding = next(call for call in transaction.calls if "version.original_object_id" in call[1])
    assert "version.state IN ('queued', 'processing', 'active')" in binding[1]
    assert "FOR KEY SHARE OF project_dataset" in binding[1]
    assert binding[2] == (ORG_ID, OUTPUT_ID, PROJECT_ID, "upload", "geojson")
    assert not any(
        "AS requested(dataset_id uuid, dataset_version_id uuid" in call[1]
        for call in transaction.calls
    )
    update = next(call for call in transaction.calls if "UPDATE app.maps" in call[1])
    assert update[2][0].obj["activeLayerId"] == "returned-roads"


def test_bound_upload_rejects_a_missing_current_project_binding() -> None:
    pending = reviewed_return(return_base())
    pending.pop("extensions")
    pending["layers"] = [pending["layers"][-1]]
    pending["activeLayerId"] = "returned-roads"
    item_rows = [
        (
            "geolibre:returned-roads",
            "embedded_dataset",
            "upload",
            "geojson",
            {},
            "bound",
            OUTPUT_ID,
            NOW,
        )
    ]
    transaction = FakeTransaction(
        one=[("member",), (PROJECT_ID, "owner"), import_row(), None],
        all_rows=[item_rows, history_rows(pending)],
    )
    with pytest.raises(ProjectImportConflict, match="project_import_dataset_not_ready"):
        asyncio.run(
            PostgresProjectImportRepository(FakeExecutor(transaction)).finalize_import(
                context(), PROJECT_ID, IMPORT_ID, "revoked-output"
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)


def test_queued_output_does_not_relax_active_version_check_on_reused_layer() -> None:
    pending = reviewed_return(return_base())
    pending.pop("extensions")
    item_rows = [
        (
            "geolibre:returned-roads",
            "embedded_dataset",
            "upload",
            "geojson",
            {},
            "bound",
            OUTPUT_ID,
            NOW,
        )
    ]
    transaction = FakeTransaction(
        one=[("member",), (PROJECT_ID, "owner"), import_row(), (OBJECT_ID, DATASET_VERSION_ID, 1)],
        all_rows=[item_rows, history_rows(pending), [(DATASET_ID,)], []],
    )
    with pytest.raises(ProjectImportConflict, match="map_dataset_version_invalid"):
        asyncio.run(
            PostgresProjectImportRepository(FakeExecutor(transaction)).finalize_import(
                context(), PROJECT_ID, IMPORT_ID, "invalid-reused-input"
            )
        )
    assert not any(call[0] == "execute" for call in transaction.calls)
