from __future__ import annotations

import argparse
import importlib.util
import sys
import unittest
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "verify_m1_collaboration.py"
)
SPEC = importlib.util.spec_from_file_location(
    "opengeo_verify_m1_collaboration", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def valid_args() -> argparse.Namespace:
    return argparse.Namespace(
        confirm=MODULE.CONFIRMATION,
        profile="opengeo-dev-operator",
        region="us-east-1",
        expected_account=MODULE.DEVELOPMENT_ACCOUNT,
        cluster_arn=(
            "arn:aws:rds:us-east-1:222222222222:cluster:opengeo-dev-foundation"
        ),
        runtime_secret_arn=(
            "arn:aws:secretsmanager:us-east-1:222222222222:"
            "secret:opengeo/dev/runtime-AbCd12"
        ),
        organization_id="61249dd8-69fa-4c9c-a171-bf3e5243f835",
        user_id="7f6cdbbc-f4b9-427d-af1d-d892dfed79ec",
    )


class M1CollaborationVerifierTests(unittest.TestCase):
    def test_accepts_only_the_exact_development_scope(self) -> None:
        arguments = valid_args()
        MODULE.validate_scope(arguments)

        arguments.expected_account = "111111111111"
        with self.assertRaisesRegex(MODULE.M1VerificationError, "development account"):
            MODULE.validate_scope(arguments)

        arguments = valid_args()
        arguments.cluster_arn = (
            "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production"
        )
        with self.assertRaisesRegex(MODULE.M1VerificationError, "development scope"):
            MODULE.validate_scope(arguments)

    def test_requires_explicit_rollback_confirmation_and_valid_ids(self) -> None:
        arguments = valid_args()
        arguments.confirm = "yes"
        with self.assertRaisesRegex(MODULE.M1VerificationError, "confirmation"):
            MODULE.validate_scope(arguments)

        arguments = valid_args()
        arguments.user_id = "not-a-uuid"
        with self.assertRaisesRegex(MODULE.M1VerificationError, "user id"):
            MODULE.validate_scope(arguments)

    def test_uses_the_current_map_definition_without_persisted_extension(self) -> None:
        dark = MODULE.empty_map_definition()
        light = MODULE.empty_map_definition(color_mode="light")
        self.assertEqual(dark["schemaVersion"], "opengeo.map-definition.1.3.0")
        self.assertEqual(dark["measurements"], [])
        self.assertEqual(dark["layers"], [])
        self.assertEqual(dark["basemaps"], [])
        self.assertEqual(dark["colorMode"], "dark")
        self.assertEqual(light["colorMode"], "light")

    def test_data_api_enum_writes_are_explicitly_cast(self) -> None:
        api_root = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
        teams = (api_root / "opengeo_api" / "teams.py").read_text(encoding="utf-8")
        memberships = (api_root / "opengeo_api" / "memberships.py").read_text(
            encoding="utf-8"
        )
        self.assertGreaterEqual(teams.count("%s::app.team_role"), 2)
        self.assertGreaterEqual(teams.count("%s::app.project_role"), 2)
        self.assertGreaterEqual(memberships.count("%s::app.organization_role"), 2)
        self.assertGreaterEqual(memberships.count("%s::app.project_role"), 3)


if __name__ == "__main__":
    unittest.main()
