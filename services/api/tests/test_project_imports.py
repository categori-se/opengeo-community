import pytest

from opengeo_api.project_imports import (
    ProjectImportConflict,
    rewrite_import_definition,
    upgrade_import_map_definition,
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
