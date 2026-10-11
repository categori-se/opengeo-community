from __future__ import annotations

import argparse
import importlib.util
import sys
import unittest
from pathlib import Path
from uuid import UUID

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "bootstrap_managed_login_browser.py"
)
SPEC = importlib.util.spec_from_file_location(
    "opengeo_bootstrap_managed_login_browser", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[1] / "fixtures" / "auth-browser-dev.json"
)
ORGANIZATION_ID = UUID("61249dd8-69fa-4c9c-a171-bf3e5243f835")


class ManagedLoginFixtureTests(unittest.TestCase):
    def test_fixture_has_stable_ids_and_two_independent_maps(self) -> None:
        fixture = MODULE.load_fixture(FIXTURE_PATH)
        first = MODULE.fixture_ids(ORGANIZATION_ID, fixture)
        second = MODULE.fixture_ids(ORGANIZATION_ID, fixture)

        self.assertEqual(first, second)
        self.assertEqual(len(set(first.projects)), 2)
        self.assertEqual(len(set(first.maps)), 2)
        self.assertEqual(len(set(first.features)), 6)
        definitions = [
            MODULE.initial_map_definition(project, fixture.dataset_name, first.dataset)
            for project in fixture.projects
        ]
        self.assertEqual(
            {definition["layers"][0]["datasetId"] for definition in definitions},
            {str(first.dataset)},
        )
        self.assertEqual(
            len(
                {
                    definition["layers"][0]["style"]["stroke"]
                    for definition in definitions
                }
            ),
            2,
        )

    def test_scope_accepts_only_exact_development_resources(self) -> None:
        valid = argparse.Namespace(
            confirm=MODULE.CONFIRMATION,
            expected_account=MODULE.DEVELOPMENT_ACCOUNT,
            cluster_arn=(
                "arn:aws:rds:us-east-1:222222222222:cluster:opengeo-dev-foundation"
            ),
            runtime_secret_arn=(
                "arn:aws:secretsmanager:us-east-1:222222222222:"
                "secret:opengeo/dev/runtime-AbCd12"
            ),
            region="us-east-1",
            organization_id=str(ORGANIZATION_ID),
            user_id="7f6cdbbc-f4b9-427d-af1d-d892dfed79ec",
            profile="opengeo-dev-operator",
        )
        MODULE.validate_scope(valid)

        valid.expected_account = "111111111111"
        with self.assertRaisesRegex(MODULE.FixtureError, "development account"):
            MODULE.validate_scope(valid)

        valid.expected_account = MODULE.DEVELOPMENT_ACCOUNT
        valid.cluster_arn = (
            "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production"
        )
        with self.assertRaisesRegex(
            MODULE.FixtureError, "outside the development account"
        ):
            MODULE.validate_scope(valid)


if __name__ == "__main__":
    unittest.main()
