import json
import sys
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import boto3
from botocore.stub import Stubber

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aws_runtime import AwsRuntime, RuntimeScope, template_hash
from controller import Command, Window, WindowUnsafe
from ledger import RdsLedger


class AwsRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.template = {
            "Resources": {"Service": {"Type": "AWS::ECS::Service", "Properties": {}}}
        }
        self.scope = RuntimeScope(
            "111111111111",
            "us-east-1",
            "dev",
            "arn:aws:iam::111111111111:role/reviewed-execution",
            self.template,
            self.template,
        )
        self.client = boto3.client(
            "cloudformation",
            region_name="us-east-1",
            aws_access_key_id="synthetic",
            aws_secret_access_key="synthetic",
        )
        self.runtime = AwsRuntime(self.scope, self.client)
        digest = template_hash(self.template)
        self.window = Window("local-window", 100, 1900, 2800, digest, digest)
        self.arn = "arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-dev-Worker/retained-id"

    def test_isolated_scope_requires_only_the_pmtiles_entrypoint(self):
        with self.assertRaisesRegex(WindowUnsafe, "pmtiles_task_definition_invalid"):
            replace(self.scope, workload="pmtiles-v2")
        worker = {"Resources": {"Task": {
            "Type": "AWS::ECS::TaskDefinition", "Properties": {
                "ContainerDefinitions": [{"Command": ["python3", "-m", "opengeo_worker.pmtiles_main"]}]
            }
        }}}
        self.assertEqual(replace(self.scope, workload="pmtiles-v2", worker_template=worker).workload,
                         "pmtiles-v2")
        worker["Resources"]["Task"]["Properties"]["ContainerDefinitions"][0]["Command"] = [
            "python3", "-m", "opengeo_worker.main"
        ]
        with self.assertRaisesRegex(WindowUnsafe, "pmtiles_entrypoint_invalid"):
            replace(self.scope, workload="pmtiles-v2", worker_template=worker)

    def stack(self, owner="local-window"):
        return {
            "StackName": "OpenGeo-dev-Worker",
            "StackId": self.arn,
            "StackStatus": "CREATE_COMPLETE",
            "CreationTime": datetime(2026, 10, 2, tzinfo=UTC),
            "RoleARN": self.scope.execution_role_arn,
            "Tags": [{"Key": "opengeo:worker-window", "Value": owner}],
        }

    def test_create_uses_fixed_template_role_and_stable_token(self):
        window = replace(self.window, phase="worker", worker_requested=True)
        command = Command("worker", "activate", "local-window-worker-activate", None)
        with Stubber(self.client) as stub:
            stub.add_client_error(
                "describe_stacks",
                "ValidationError",
                "Stack with id OpenGeo-dev-Worker does not exist",
                expected_params={"StackName": "OpenGeo-dev-Worker"},
            )
            stub.add_response(
                "create_stack",
                {"StackId": self.arn},
                {
                    "StackName": "OpenGeo-dev-Worker",
                    "TemplateBody": json.dumps(self.template, separators=(",", ":")),
                    "RoleARN": self.scope.execution_role_arn,
                    "ClientRequestToken": command.token,
                    "Capabilities": ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
                    "Tags": [{"Key": "opengeo:worker-window", "Value": "local-window"}],
                    "OnFailure": "ROLLBACK",
                    "TimeoutInMinutes": 15,
                },
            )
            self.runtime.execute(window, command, now=110, lease_expires_at=290)
            stub.assert_no_pending_responses()

    def test_deleted_stack_does_not_query_removed_exports(self):
        stack = self.stack()
        stack["StackStatus"] = "DELETE_COMPLETE"
        stack["Outputs"] = [
            {"OutputKey": "Old", "OutputValue": "old", "ExportName": "removed-export"}
        ]
        with Stubber(self.client) as stub:
            stub.add_response(
                "describe_stacks", {"Stacks": [stack]}, {"StackName": self.arn}
            )
            stub.add_response(
                "get_template",
                {"TemplateBody": json.dumps(self.template)},
                {"StackName": self.arn, "TemplateStage": "Original"},
            )
            self.assertEqual(
                self.runtime.observe_stack("worker", self.arn).status, "DELETE_COMPLETE"
            )
            stub.assert_no_pending_responses()

    def test_slow_observation_cannot_outlive_mutation_lease(self):
        window = replace(self.window, phase="worker", worker_requested=True)
        times = iter([0, 200])
        with Stubber(self.client) as stub:
            stub.add_client_error(
                "describe_stacks",
                "ValidationError",
                "Stack with id OpenGeo-dev-Worker does not exist",
                expected_params={"StackName": "OpenGeo-dev-Worker"},
            )
            with self.assertRaisesRegex(WindowUnsafe, "window_lease_unavailable"):
                self.runtime.execute(
                    window,
                    Command("worker", "activate", "local-window-worker-activate", None),
                    now=110,
                    lease_expires_at=290,
                    monotonic=lambda: next(times),
                )
            stub.assert_no_pending_responses()

    def test_unused_export_response_is_empty_but_other_errors_propagate(self):
        stack = self.stack()
        stack["Outputs"] = [
            {"OutputKey": "Ready", "OutputValue": "value", "ExportName": "ready-export"}
        ]
        for code, message, empty in [
            (
                "ValidationError",
                "Export 'ready-export' is not imported by any stack.",
                True,
            ),
            ("AccessDenied", "denied", False),
            ("ValidationError", "Export does not exist", False),
            (
                "ValidationError",
                "Export 'other-export' is not imported by any stack.",
                False,
            ),
        ]:
            with self.subTest(code=code, message=message), Stubber(self.client) as stub:
                stub.add_response(
                    "describe_stacks", {"Stacks": [stack]}, {"StackName": self.arn}
                )
                stub.add_response(
                    "get_template",
                    {"TemplateBody": json.dumps(self.template)},
                    {"StackName": self.arn, "TemplateStage": "Original"},
                )
                stub.add_client_error(
                    "list_imports",
                    code,
                    message,
                    expected_params={"ExportName": "ready-export"},
                )
                if empty:
                    self.assertEqual(
                        self.runtime.observe_stack("worker", self.arn).importers, ()
                    )
                else:
                    with self.assertRaises(self.client.exceptions.ClientError):
                        self.runtime.observe_stack("worker", self.arn)
                stub.assert_no_pending_responses()

    def test_retry_observes_completed_creation_without_repeating_mutation(self):
        window = replace(self.window, phase="worker", worker_requested=True)
        with Stubber(self.client) as stub:
            stub.add_response(
                "describe_stacks",
                {"Stacks": [self.stack()]},
                {"StackName": "OpenGeo-dev-Worker"},
            )
            stub.add_response(
                "get_template",
                {"TemplateBody": json.dumps(self.template)},
                {"StackName": self.arn, "TemplateStage": "Original"},
            )
            self.runtime.execute(
                window,
                Command("worker", "activate", "local-window-worker-activate", None),
                now=110,
                lease_expires_at=290,
            )
            stub.assert_no_pending_responses()

    def test_delete_uses_arn_and_rechecks_current_owner(self):
        window = replace(self.window, phase="remove-worker", worker_id=self.arn)
        command = Command("worker", "remove", "local-window-worker-remove", self.arn)
        for owner in ["local-window", "another-window"]:
            with Stubber(self.client) as stub:
                stub.add_response(
                    "describe_stacks",
                    {"Stacks": [self.stack(owner)]},
                    {"StackName": self.arn},
                )
                stub.add_response(
                    "get_template",
                    {"TemplateBody": json.dumps(self.template)},
                    {"StackName": self.arn, "TemplateStage": "Original"},
                )
                if owner == "local-window":
                    stub.add_response(
                        "delete_stack",
                        {},
                        {
                            "StackName": self.arn,
                            "RoleARN": self.scope.execution_role_arn,
                            "ClientRequestToken": command.token,
                        },
                    )
                    self.runtime.execute(window, command, now=110, lease_expires_at=290)
                else:
                    with self.assertRaisesRegex(WindowUnsafe, "changed_before_command"):
                        self.runtime.execute(
                            window, command, now=110, lease_expires_at=290
                        )
                stub.assert_no_pending_responses()

    def test_denied_or_unscoped_calls_cannot_be_treated_as_missing(self):
        with Stubber(self.client) as stub:
            stub.add_client_error(
                "describe_stacks",
                "AccessDenied",
                "denied",
                expected_params={"StackName": "OpenGeo-dev-Worker"},
            )
            with self.assertRaises(self.client.exceptions.ClientError):
                self.runtime.observe_stack("worker")
        with self.assertRaises(WindowUnsafe):
            self.scope.check_id("worker", self.arn.replace("-Worker/", "-Foundation/"))
        with self.assertRaisesRegex(WindowUnsafe, "lease_unavailable"):
            self.runtime.execute(
                replace(self.window, phase="worker"),
                Command("worker", "activate", "local-window-worker-activate", None),
                now=110,
                lease_expires_at=120,
            )

    def test_ledger_retains_uuid_and_json_types(self):
        client = boto3.client(
            "rds-data",
            region_name="us-east-1",
            aws_access_key_id="synthetic",
            aws_secret_access_key="synthetic",
        )
        ledger = RdsLedger(
            client,
            cluster_arn="arn:aws:rds:us-east-1:111111111111:cluster:local",
            secret_arn="arn:aws:secretsmanager:us-east-1:111111111111:secret:local",
        )
        token = "00000000-0000-4000-8000-000000000001"
        with Stubber(client) as stub:
            stub.add_response(
                "execute_statement",
                {"records": [[{"stringValue": '{"status":"busy"}'}]]},
                {
                    **ledger.arguments,
                    "sql": "SELECT app.claim_worker_runtime(:token, :scope, :work)",
                    "parameters": [
                        {
                            "name": "token",
                            "typeHint": "UUID",
                            "value": {"stringValue": token},
                        },
                        {"name": "scope", "value": {"stringValue": "a" * 64}},
                        {"name": "work", "value": {"booleanValue": True}},
                    ],
                },
            )
            self.assertEqual(ledger.claim(token, "a" * 64, True), {"status": "busy"})
            stub.assert_no_pending_responses()


if __name__ == "__main__":
    unittest.main()
