from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
API_SRC = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(API_SRC))
MODULE_PATH = SCRIPT_DIR / "bootstrap_massgis_project.py"
SPEC = importlib.util.spec_from_file_location(
    "opengeo_bootstrap_massgis_project", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

from opengeo_api.map_definitions import map_dataset_references, validate_map_definition


class MassgisProjectBootstrapTests(unittest.TestCase):
    def test_reviewed_archive_builds_31_complete_presets_over_one_governed_dataset(
        self,
    ) -> None:
        plan = MODULE.load_plan()
        dataset_id = "80000000-0000-4000-8000-000000000060"
        definitions = [
            MODULE.map_definition(plan, item, dataset_id=dataset_id, source_version=1)
            for item in plan["presentations"]
        ]

        self.assertEqual(len(plan["savedPresentations"]), 1)
        self.assertTrue(plan["savedPresentations"][0]["combined"])
        self.assertEqual(len(definitions), 31)
        self.assertTrue(all(len(item["layers"]) == 33 for item in definitions))
        self.assertEqual(sum(len(item["layers"]) for item in definitions), 1_023)
        self.assertEqual(
            [sum(layer["visible"] for layer in item["layers"]) for item in definitions],
            [3, *([1] * 30)],
        )
        self.assertTrue(all(len(item["layerTree"]) == 6 for item in definitions))
        self.assertTrue(
            all(
                any(
                    layer["layerId"] == item["activeLayerId"] and layer["visible"]
                    for layer in item["layers"]
                )
                for item in definitions
            )
        )
        self.assertEqual(definitions[0]["layers"][0]["sourceType"], "geojson-archive")
        self.assertEqual(
            {layer["sharedSourceId"] for layer in definitions[0]["layers"]},
            {dataset_id},
        )
        self.assertEqual(definitions[0]["mapViews"][0]["center"], [-71.85, 42.2])
        self.assertNotIn("features", json.dumps(definitions))
        self.assertNotIn("file://", json.dumps(plan))
        for definition in definitions:
            validate_map_definition(definition, require_current=True)
            references = map_dataset_references(definition)
            self.assertTrue(references)
            self.assertTrue(
                all(str(item.dataset_id) == dataset_id for item in references)
            )
            self.assertTrue(all(item.source_type == "geojson" for item in references))
            self.assertTrue(all(item.source_version == 1 for item in references))

    def test_source_revision_pins_archive_integrity_rights_and_origin(self) -> None:
        plan = MODULE.load_plan()
        source = plan["sourceConfiguration"]
        self.assertEqual(source["feature_count"], 5_109)
        self.assertEqual(source["content_encoding"], "gzip")
        self.assertEqual(len(source["object_sha256"]), 64)
        self.assertEqual(len(source["decoded_sha256"]), 64)
        self.assertTrue(
            plan["sourceUrl"].startswith(
                "https://s3.us-east-1.amazonaws.com/example-geodata/usa/ma/"
            )
        )
        self.assertTrue(
            source["authoritative_url"].startswith("https://services1.arcgis.com/")
        )
        self.assertEqual(source["license"], "LicenseRef-Public-Domain")

    def test_map_repair_is_limited_to_untouched_bootstrap_history(self) -> None:
        bootstrap = MODULE.MassgisProjectBootstrap.__new__(
            MODULE.MassgisProjectBootstrap
        )
        captured: dict[str, object] = {}

        def rows(transaction_id, sql, parameters):
            captured.update(
                transaction_id=transaction_id,
                sql=sql,
                parameters=parameters,
            )
            return [{"repaired": True}]

        bootstrap._rows = rows
        repaired = bootstrap._repair_untouched_bootstrap_map(
            "transaction-1",
            organization_id="10000000-0000-4000-8000-000000000001",
            project_id="50000000-0000-4000-8000-000000000001",
            map_id="60000000-0000-4000-8000-000000000001",
            definition=json.dumps({"layers": [{"layerId": "massgis_test"}]}),
            legacy_definition=json.dumps({"layers": [{"layerId": "massgis_old"}]}),
            user_id="20000000-0000-4000-8000-000000000001",
        )

        self.assertTrue(repaired)
        sql = str(captured["sql"])
        self.assertIn("map.version = 1", sql)
        self.assertIn("jsonb_array_length(map.definition -> 'layers') = 0", sql)
        self.assertIn("map.definition = CAST(:legacy_definition AS jsonb)", sql)
        self.assertIn("SELECT count(*)", sql)
        self.assertIn("history.version = 1", sql)
        self.assertIn("version = 2", sql)
        self.assertIn("Restore complete reviewed MassGIS layer catalog", sql)

    def test_implicit_private_schema_skips_release_63_visibility_columns(self) -> None:
        bootstrap = MODULE.MassgisProjectBootstrap.__new__(
            MODULE.MassgisProjectBootstrap
        )
        statements: list[str] = []
        bootstrap._rows = lambda *_args: [{"supported": False}]
        bootstrap._execute = lambda _transaction, sql, _parameters: statements.append(
            sql
        )

        supported = bootstrap._set_project_visibility(
            "transaction-1",
            organization_id="10000000-0000-4000-8000-000000000001",
            project_id="50000000-0000-4000-8000-000000000001",
            user_id="20000000-0000-4000-8000-000000000001",
            visibility="internal",
        )

        self.assertFalse(supported)
        self.assertEqual(statements, [])
        with self.assertRaisesRegex(
            MODULE.MigrationError,
            "published MassGIS visibility requires schema release 0063",
        ):
            bootstrap._set_project_visibility(
                "transaction-1",
                organization_id="10000000-0000-4000-8000-000000000001",
                project_id="50000000-0000-4000-8000-000000000001",
                user_id="20000000-0000-4000-8000-000000000001",
                visibility="published",
            )

    def test_release_63_schema_updates_visibility_explicitly(self) -> None:
        bootstrap = MODULE.MassgisProjectBootstrap.__new__(
            MODULE.MassgisProjectBootstrap
        )
        statements: list[str] = []
        bootstrap._rows = lambda *_args: [{"supported": True}]
        bootstrap._execute = lambda _transaction, sql, _parameters: statements.append(
            sql
        )

        supported = bootstrap._set_project_visibility(
            "transaction-1",
            organization_id="10000000-0000-4000-8000-000000000001",
            project_id="50000000-0000-4000-8000-000000000001",
            user_id="20000000-0000-4000-8000-000000000001",
            visibility="published",
        )

        self.assertTrue(supported)
        self.assertEqual(len(statements), 1)
        self.assertIn("SET visibility", statements[0])

    def test_existing_maps_keep_their_single_governed_source_revision(self) -> None:
        bootstrap = MODULE.MassgisProjectBootstrap.__new__(
            MODULE.MassgisProjectBootstrap
        )
        dataset_id = "80000000-0000-4000-8000-000000000060"
        bootstrap._rows = lambda *_args: [
            {
                "maps": 31,
                "datasets": 1,
                "dataset_id": dataset_id,
                "source_versions": 1,
                "source_version": 1,
            }
        ]

        source_version = bootstrap._existing_map_source_version(
            "transaction-1",
            organization_id="10000000-0000-4000-8000-000000000001",
            project_id="50000000-0000-4000-8000-000000000001",
            dataset_id=dataset_id,
        )

        self.assertEqual(source_version, 1)

    def test_existing_maps_reject_mixed_source_revisions(self) -> None:
        bootstrap = MODULE.MassgisProjectBootstrap.__new__(
            MODULE.MassgisProjectBootstrap
        )
        dataset_id = "80000000-0000-4000-8000-000000000060"
        bootstrap._rows = lambda *_args: [
            {
                "maps": 31,
                "datasets": 1,
                "dataset_id": dataset_id,
                "source_versions": 2,
                "source_version": 1,
            }
        ]

        with self.assertRaisesRegex(
            MODULE.MigrationError,
            "do not share one governed source revision",
        ):
            bootstrap._existing_map_source_version(
                "transaction-1",
                organization_id="10000000-0000-4000-8000-000000000001",
                project_id="50000000-0000-4000-8000-000000000001",
                dataset_id=dataset_id,
            )


if __name__ == "__main__":
    unittest.main()
