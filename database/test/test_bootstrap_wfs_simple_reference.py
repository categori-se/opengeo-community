from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "bootstrap_wfs_simple_reference.py"
)
SPEC = importlib.util.spec_from_file_location("opengeo_wfs_reference_bootstrap", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class WfsSimpleReferenceBootstrapTests(unittest.TestCase):
    def test_loads_the_exact_one_feature_plan(self) -> None:
        plan = MODULE.load_plan(MODULE.DEFAULT_PROFILE, MODULE.EXPECTED_PROFILE_SHA256)

        self.assertEqual(plan.profile_sha256, MODULE.EXPECTED_PROFILE_SHA256)
        self.assertEqual(str(plan.project_id), "50000000-0000-4000-8000-000000000121")
        self.assertEqual(str(plan.dataset_id), "80000000-0000-4000-8000-000000000121")
        self.assertEqual(str(plan.feature_id), "90000000-0000-4000-8000-000000000121")
        self.assertEqual(
            plan.geometry, {"type": "Point", "coordinates": [-77.03, 38.9]}
        )
        self.assertEqual(plan.properties, {"name": "Station", "count": 2})
        self.assertEqual(plan.schema_definition["schemaVersion"], "1.0.0")

    def test_rejects_profile_drift_before_database_access(self) -> None:
        profile = json.loads(MODULE.DEFAULT_PROFILE.read_text(encoding="utf-8"))
        profile["bootstrap"]["request"]["features"][0]["properties"]["count"] = 3
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text(json.dumps(profile), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.BootstrapError, "checksum"):
                MODULE.load_plan(path, None)

    def test_requires_a_private_absolute_loopback_dsn_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "database-url"
            path.write_text(
                "postgresql://postgres:fixture@127.0.0.1:55432/opengeo_wfs_ets_service019",
                encoding="utf-8",
            )
            path.chmod(0o600)
            dsn, database = MODULE.load_dsn(path)
            self.assertIn("127.0.0.1", dsn)
            self.assertEqual(database, "opengeo_wfs_ets_service019")

            path.chmod(0o644)
            with self.assertRaisesRegex(MODULE.BootstrapError, "group or world"):
                MODULE.load_dsn(path)

    def test_rejects_remote_or_general_database_targets(self) -> None:
        cases = (
            "postgresql://postgres:fixture@db.example.test/opengeo_wfs_ets_service019",
            "postgresql://postgres:fixture@127.0.0.1/opengeo",
        )
        for value in cases:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                path = Path(directory).resolve() / "database-url"
                path.write_text(value, encoding="utf-8")
                path.chmod(0o600)
                with self.assertRaisesRegex(MODULE.BootstrapError, "loopback WFS ETS"):
                    MODULE.load_dsn(path)

    def test_allows_only_the_bounded_ephemeral_socket_directory(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="opengeo-wfs-ets-aB19_-", dir="/tmp"
        ) as directory:
            path = Path(directory).resolve() / "database-url"
            path.write_text(
                f"host={directory} dbname=opengeo_wfs_ets_service019 user=postgres",
                encoding="utf-8",
            )
            path.chmod(0o600)
            _, database = MODULE.load_dsn(path)
            self.assertEqual(database, "opengeo_wfs_ets_service019")

    def test_database_modes_require_two_explicit_confirmations(self) -> None:
        arguments = MODULE.parse_args(["--mode", "verify-cycle"])
        self.assertIsNone(arguments.database_url_file)
        self.assertIsNone(arguments.confirm_profile_sha256)
        self.assertEqual(MODULE.parse_args([]).mode, "plan")

    def test_pins_the_exact_current_database_baseline(self) -> None:
        ledger = MODULE._expected_ledger()

        self.assertEqual(MODULE.DATABASE_RELEASE, 69)
        self.assertEqual(len(ledger), 69)
        self.assertEqual(ledger[-1][0], "0069_spatial_catalog_render_profiles.sql")
        self.assertEqual(
            MODULE.EXPECTED_BASELINE_SHA256,
            "b61619c09fa0e9d5bb5b7d7e37098efa83faf680523119ae11c87d1d4108a984",
        )
        self.assertEqual(
            MODULE.EXPECTED_BASELINE_MANIFEST_SHA256,
            "76c6296550e18dcbeb6e57b00153f351ef737dd47b826c535f73efddaaa8b26a",
        )

    def test_rejects_baseline_sql_or_manifest_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / MODULE.BASELINE_SQL.name
            manifest = root / MODULE.BASELINE_MANIFEST.name
            baseline_bytes = MODULE.BASELINE_SQL.read_bytes()
            manifest_bytes = MODULE.BASELINE_MANIFEST.read_bytes()
            baseline.write_bytes(baseline_bytes)
            manifest.write_bytes(manifest_bytes)
            with (
                patch.object(MODULE, "BASELINE_SQL", baseline),
                patch.object(MODULE, "BASELINE_MANIFEST", manifest),
            ):
                self.assertEqual(len(MODULE._expected_ledger()), 69)
                baseline.write_bytes(baseline.read_bytes() + b"\n-- drift\n")
                with self.assertRaisesRegex(MODULE.BootstrapError, "checksum"):
                    MODULE._expected_ledger()

                baseline.write_bytes(baseline_bytes)
                manifest.write_bytes(manifest.read_bytes() + b"\n")
                with self.assertRaisesRegex(MODULE.BootstrapError, "checksum"):
                    MODULE._expected_ledger()

    def test_cleanup_preserves_append_only_history_by_using_rollback(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('"cleanupMethod": "transaction_rollback"', source)
        self.assertIn('"destroy_entire_isolated_database"', source)
        self.assertNotIn("DELETE FROM app.dataset_feature_revisions", source)
        self.assertNotIn("TRUNCATE", source)
        self.assertNotIn("DROP DATABASE", source)
        self.assertNotIn("boto3", source)
        self.assertNotIn("os.environ", source)
        self.assertIn("for table in PROFILE_TABLES", source)

    def test_dsn_file_must_not_be_a_symlink(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / "target"
            target.write_text(
                "postgresql://postgres:fixture@127.0.0.1/opengeo_wfs_ets_service019",
                encoding="utf-8",
            )
            target.chmod(0o600)
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaisesRegex(MODULE.BootstrapError, "non-symlink"):
                MODULE.load_dsn(link)


if __name__ == "__main__":
    unittest.main()
