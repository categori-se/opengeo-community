from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from uuid import UUID

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
API_SRC = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(API_SRC))
MODULE_PATH = SCRIPT_DIR / "bootstrap_demo_starter.py"
SPEC = importlib.util.spec_from_file_location(
    "opengeo_bootstrap_demo_starter", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

from opengeo_api.map_definitions import map_dataset_references, validate_map_definition


class DemoStarterBootstrapTests(unittest.TestCase):
    def test_sealed_asset_builds_one_valid_governed_layer(self) -> None:
        plan = MODULE.load_plan()
        dataset_id = "80000000-0000-4000-8000-000000000063"
        definition = MODULE.map_definition(dataset_id, 1, plan)

        validate_map_definition(definition, require_current=True)
        self.assertEqual(len(definition["layers"]), 1)
        self.assertEqual(definition["layers"][0]["sourceType"], "geojson-archive")
        self.assertNotIn("features", json.dumps(definition))
        self.assertEqual(
            map_dataset_references(definition)[0].dataset_id,
            UUID(dataset_id),
        )

    def test_asset_identity_is_exact_and_publicly_bounded(self) -> None:
        plan = MODULE.load_plan()
        configuration = plan["configuration"]

        self.assertEqual(configuration["feature_count"], 5)
        self.assertEqual(configuration["object_sha256"], MODULE.ASSET_SHA256)
        self.assertEqual(
            configuration["object_sha256"], configuration["decoded_sha256"]
        )
        self.assertEqual(configuration["size_bytes"], MODULE.ASSET_BYTES)
        self.assertEqual(configuration["license"], "CC0-1.0")
        self.assertTrue(
            plan["sourceUrl"].startswith("https://demo.studio.opengeo.tools/")
        )


if __name__ == "__main__":
    unittest.main()
