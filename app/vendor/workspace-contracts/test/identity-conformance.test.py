"""Run fixed shared conformance cases natively; no Node, SDK or new dependency."""
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
import categori_workspace_contracts as contracts

CORPUS = json.loads((ROOT / "conformance/identity.json").read_text())


def evaluate(fixture):
    operation, value = fixture["operation"], fixture["input"]
    if operation == "validate_resource_grant":
        return contracts.validate_resource_grant(value["record"], resource=value.get("resource"))
    if operation == "authorize_scoped_resource":
        return contracts.authorize_scoped_resource(value["options"], value["action"])
    return getattr(contracts, operation)(value)


class IdentityConformance(unittest.TestCase):
    def test_manifest_and_corpus_pin(self):
        manifest = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(CORPUS["version"], contracts.__version__)
        self.assertEqual(CORPUS["version"], manifest["version"])
        self.assertEqual(CORPUS["contract"], manifest["name"])
        self.assertEqual(len(CORPUS["cases"]), len({row["name"] for row in CORPUS["cases"]}))

    def test_constructors_preserve_supplied_ids_and_reject_booleans(self):
        user = contracts.create_identity_user(user_id="original_subject")
        self.assertEqual(user, {"schema_version":1,"user_id":"original_subject","status":"active","revision":1})
        for revision in (True, False, "1", 1.5, 9007199254740992):
            with self.assertRaises(TypeError):
                contracts.create_identity_user(user_id="original_subject", revision=revision)
        with self.assertRaises(TypeError):
            contracts.create_identity_workspace(workspace_id="workspace_original\n")

    def test_scope_constructor_is_an_independent_copy(self):
        scopes = [{"resource_type":"document","resource_id":"document_original"}]
        record = contracts.create_workspace_participation(participation_id="guest_original", workspace_id="workspace_original", user_id="user_original", mode="guest", resource_scopes=scopes)
        scopes[0]["resource_id"] = "later_document"
        self.assertEqual(record["resource_scopes"][0]["resource_id"], "document_original")
        self.assertIsNone(record["expires_at"])

    def test_output_changes_cannot_modify_input_or_next_result(self):
        fixture = next(row for row in CORPUS["cases"] if row["name"] == "guest exact scope plus current user grant")
        before = deepcopy(fixture["input"])
        result = evaluate(fixture)
        result["identity"]["principal"]["principal_id"] = "modified"
        result["access"]["provenance"]["view"]["allowed_by"][0]["source_id"] = "modified"
        self.assertEqual(fixture["input"], before)
        self.assertEqual(evaluate(fixture), fixture["expected"])

    def test_aware_datetime_evaluation_matches_fixed_utc_time(self):
        fixture = deepcopy(next(row for row in CORPUS["cases"] if row["name"] == "guest exact scope plus current user grant"))
        fixture["input"]["now"] = datetime(2026,10,5,12,tzinfo=timezone.utc)
        self.assertEqual(evaluate(fixture), fixture["expected"])

    def test_non_json_and_cycles_are_rejected_without_recursion_failure(self):
        user = {"schema_version":1,"user_id":"original_subject","status":"active","revision":1}
        self.assertTrue(contracts.validate_identity_user({**user,"unexpected":float("nan")}))
        user["cycle"] = user
        self.assertTrue(contracts.validate_identity_user(user))

    def test_role_definition_cannot_be_changed_between_evaluations(self):
        with self.assertRaises(TypeError):
            contracts.collaboration_role_actions["viewer"] = ("view", "manage_access")
        self.assertEqual(contracts.actions_for_collaboration_role("viewer"), ["view"])


for index, fixture in enumerate(CORPUS["cases"]):
    def check(self, fixture=fixture):
        before = deepcopy(fixture["input"])
        self.assertEqual(evaluate(fixture), fixture["expected"], fixture["name"])
        self.assertEqual(fixture["input"], before, "original records must remain unchanged")
    check.__doc__ = fixture["name"]
    setattr(IdentityConformance, f"test_portable_{index:03d}", check)


if __name__ == "__main__":
    unittest.main(verbosity=2)
