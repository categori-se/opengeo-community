from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
MODULE_PATH = SCRIPT_DIR / "bootstrap_private_projects.py"
SPEC = importlib.util.spec_from_file_location("opengeo_bootstrap_private_projects", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

class PrivateProjectBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.catalog = Path(directory.name) / "catalog.json"
        self.catalog.write_text(json.dumps({
            "schemaVersion": "opengeo.observable-import-catalog.1.0.0",
            "owner": {"email": "owner@example.test"},
            "projectVisibility": "private",
            "sources": [{"id": f"source-{index}", "title": f"Source {index}",
                         "classification": "research", "conversionPlan": "normalize_source_project",
                         "sourceDirectory": "/home/example/private-input",
                         "routeNamespace": f"projects/source-{index}"} for index in range(17)],
        }), encoding="utf-8")

    def test_catalog_prepares_private_records_without_local_paths(self) -> None:
        sources = MODULE.load_catalog(self.catalog, "owner@example.test")

        self.assertEqual(len(sources), 17)
        self.assertTrue(all(set(source) == {
            "id", "title", "classification", "conversionPlan", "routeNamespace"
        } for source in sources))
        self.assertNotIn("/home/", json.dumps(sources))
        self.assertEqual(
            MODULE.empty_map_definition()["schemaVersion"],
            "opengeo.map-definition.1.3.0",
        )

    def test_apply_prepares_access_without_creating_empty_compositions(self) -> None:
        sources = MODULE.load_catalog(self.catalog, "owner@example.test")[:1]
        migrator = Mock()
        migrator._base.return_value = {}
        migrator._transaction_base.return_value = {}
        migrator._rds_call.side_effect = [{"transactionId": "transaction"}, {}]
        bootstrap = MODULE.PrivateProjectBootstrap(migrator, "runtime")
        bootstrap._one = Mock(return_value={
            "user_id": "10000000-0000-4000-8000-000000000001",
            "organization_id": "20000000-0000-4000-8000-000000000001",
        })
        bootstrap._rows = Mock(return_value=[{
            "id": "30000000-0000-4000-8000-000000000001", "created": True,
        }])
        bootstrap._execute = Mock()
        bootstrap.verify = Mock()
        result = bootstrap.apply(subject="10000000-0000-4000-8000-000000000001",
                                 organization_slug="opengeo-tools", sources=sources)
        self.assertEqual(result["createdMaps"], 0)
        self.assertEqual(result["accessContainers"], 1)
        statements = "\n".join(call.args[1] for call in bootstrap._execute.call_args_list
                               + bootstrap._rows.call_args_list)
        self.assertIn("INSERT INTO app.project_memberships", statements)
        self.assertNotIn("app.maps", statements)
        self.assertNotIn("app.map_versions", statements)
        bootstrap.verify.assert_called_once()

    def test_catalog_rejects_public_visibility_and_owner_mismatch(self) -> None:
        payload = json.loads(self.catalog.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            payload["projectVisibility"] = "public"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.MigrationError, "remain private"):
                MODULE.load_catalog(path, "owner@example.test")

            payload["projectVisibility"] = "private"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.MigrationError, "owner"):
                MODULE.load_catalog(path, "someone@example.com")


if __name__ == "__main__":
    unittest.main()
