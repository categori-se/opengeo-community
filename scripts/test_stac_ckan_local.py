"""Offline guards for the existing disposable CKAN permission journey."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "ckan_local", ROOT / "services/api/scripts/check_stac_ckan_local.py"
)
assert SPEC and SPEC.loader
CKAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CKAN)


class CkanLocalGuards(unittest.TestCase):
    def test_only_real_authorization_denial_passes_negative_check(self):
        denied = json.dumps({"success": False, "error": {"__type": "Authorization Error"}}).encode()
        self.assertTrue(CKAN.validate_action_response(
            "package_show", 403, denied, authorization_denied=True
        ))
        for status, body in (
            (200, {"success": True, "result": {}}),
            (401, {"success": False, "error": {"__type": "Authorization Error"}}),
            (404, {"success": False, "error": {"__type": "Not Found Error"}}),
            (500, {"success": False, "error": {"__type": "Authorization Error"}}),
            (403, {"success": False, "error": {"__type": "Validation Error"}}),
        ):
            with self.subTest(status=status, body=body), self.assertRaises(CKAN.CkanActionFailure):
                CKAN.validate_action_response(
                    "package_show", status, json.dumps(body).encode(), authorization_denied=True
                )

    def test_purge_readback_requires_missing_record(self):
        raw = json.dumps({"success": False, "error": {"__type": "Not Found Error"}}).encode()
        self.assertTrue(CKAN.validate_action_response("package_show", 404, raw, not_found=True))
        self.assertFalse(CKAN.validate_action_response("package_show", 403, raw, not_found=True))

    def test_response_bound_applies_even_to_expected_denial(self):
        with self.assertRaisesRegex(RuntimeError, "exceeds bound"):
            CKAN.validate_action_response(
                "package_show", 403, b" " * 1_048_577, authorization_denied=True
            )

    def test_startup_actions_and_failure_cleanup_share_one_request_budget(self):
        budget = CKAN.HttpRequestBudget(4)
        budget.consume("startup")
        budget.consume("action")
        budget.consume("action")
        with self.assertRaises(TimeoutError):
            budget.consume("startup")
        budget.consume("cleanup")
        with self.assertRaises(TimeoutError):
            budget.consume("cleanup")
        self.assertEqual(
            budget.snapshot(), {"attempts": 4, "startup": 1, "action": 2, "cleanup": 1}
        )

    def test_exact_retained_envelope_needs_no_exporter_or_external_calls(self):
        with patch("subprocess.run", side_effect=AssertionError("external call")):
            exported = CKAN.load_retained_export(ROOT / "docs/api/evidence/stac-ckan-export.json")
        self.assertEqual(exported["action"], "package_create")
        self.assertFalse({"owner_org", "private", "permissions"} & exported["payload"].keys())

    def test_changed_supplied_envelope_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "envelope.json"
            path.write_bytes(
                (ROOT / "docs/api/evidence/stac-ckan-export.json").read_bytes() + b"\n"
            )
            with self.assertRaisesRegex(ValueError, "accepted retained bytes"):
                CKAN.load_retained_export(path)

    def test_changed_accepted_inputs_are_rejected_before_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            clone = Path(directory)
            for relative in CKAN.RETAINED_INPUT_HASHES:
                destination = clone / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, destination)
            for relative in (
                "services/api/src/opengeo_api/ckan_export.py",
                "docs/api/fixtures/stac-ckan-collection.json",
                "docs/api/evidence/stac-ckan-export.json",
            ):
                destination = clone / relative
                original = destination.read_bytes()
                destination.write_bytes(original + b"\n")
                with self.subTest(relative=relative), patch.object(CKAN, "ROOT", clone):
                    with self.assertRaisesRegex(ValueError, "accepted checksum"):
                        CKAN.load_retained_export(clone / "docs/api/evidence/stac-ckan-export.json")
                destination.write_bytes(original)


if __name__ == "__main__":
    unittest.main()
