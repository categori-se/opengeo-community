"""Focused guards for account-local deployment and resumable image publishing."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("community_aws", Path(__file__).with_name("community-aws.py"))
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)
CONFIG = {"account": "123456789012", "region": "us-east-1", "name": "my-opengeo", "profile": "my-opengeo", "budgetAlertEmail": "operator@example.org", "withWorker": False}


class DeploymentGuards(unittest.TestCase):
    def config_file(self, root, **changes):
        path = root / "config.json"
        path.write_text(json.dumps({**CONFIG, **changes}))
        return path

    def test_default_plan_cannot_call_cloud_or_build(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)), patch.object(MODULE, "run", side_effect=AssertionError("external command")), contextlib.redirect_stdout(io.StringIO()) as output:
            cfg = self.config_file(Path(directory))
            self.assertEqual(MODULE.main(["studio", "--config", str(cfg)]), 0)
            self.assertEqual(json.loads(output.getvalue())["mode"], "offline-plan")
            self.assertFalse((Path(directory) / ".opengeo").exists())

    def test_account_mismatch_stops_before_writes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            with patch.object(deployment, "aws", return_value={"Account": "999999999999"}), patch.object(deployment, "save") as save:
                with self.assertRaisesRegex(ValueError, "no changes made"):
                    deployment.identity()
                save.assert_not_called()

    def test_configuration_cannot_carry_credentials_or_change_region_silently(self):
        with tempfile.TemporaryDirectory() as directory:
            for changes in ({"accessKey": "private"}, {"region": "eu-west-1"}, {"account": 123456789012}, {"withWorker": "false"}):
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    MODULE.load_config(self.config_file(Path(directory), **changes))

    def test_original_operator_environment_is_excluded(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)), patch.dict(os.environ, {"OPEN_GEO_API_IMAGE": "private-image", "OPEN_GEO_APPLICATION_BUCKET": "private-bucket", "CDK_DEFAULT_ACCOUNT": "999999999999"}):
            deployment = MODULE.Deployment(CONFIG)
            self.assertNotIn("OPEN_GEO_API_IMAGE", deployment.env)
            self.assertNotIn("OPEN_GEO_APPLICATION_BUCKET", deployment.env)
            self.assertEqual(deployment.env["CDK_DEFAULT_ACCOUNT"], CONFIG["account"])

    def test_state_for_another_account_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("deployment.json", {"account": "999999999999", "region": "us-east-1", "name": CONFIG["name"]})
            with self.assertRaisesRegex(ValueError, "another AWS deployment"):
                MODULE.Deployment(CONFIG)

    def test_runtime_creates_required_foundation_exports_before_consumers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            cfg = self.config_file(Path(directory))
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("images.json", {"api": "sha256:" + "a" * 64, "compiler": "sha256:" + "b" * 64})
            with patch.object(MODULE.Deployment, "identity"), patch.object(MODULE.Deployment, "deploy") as deploy:
                MODULE.main(["runtime", "--config", str(cfg), "--apply"])
                deploy.assert_called_once_with("Foundation", "Api")

    def test_ecr_permission_failure_cannot_trigger_rebuild_or_push(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(MODULE, "ROOT", Path(directory)):
            deployment = MODULE.Deployment(CONFIG)
            deployment.save("foundation.outputs.json", {"ApiRepositoryUri": "123456789012.dkr.ecr.us-east-1.amazonaws.com/opengeo/dev/api"})
            response = subprocess.CompletedProcess([], 254, "", "An error occurred (AccessDeniedException)")
            with patch.object(MODULE.subprocess, "run", return_value=response) as execute:
                with self.assertRaisesRegex(ValueError, "ECR image lookup failed"):
                    deployment.image("api")
                self.assertEqual(execute.call_count, 1)
                self.assertEqual(execute.call_args.args[0][:3], ["aws", "ecr", "describe-images"])


if __name__ == "__main__":
    unittest.main()
