import sys
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import boto3
from botocore.stub import Stubber

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from controller import Window, WindowUnsafe
from handler import tick, unfinished_worker_tasks


class HandlerTests(unittest.TestCase):
    def setUp(self):
        template = {
            "Resources": {
                "Example": {
                    "Type": "AWS::ECS::Service",
                    "Properties": {"ServiceName": "retained-worker"},
                },
                "Task": {
                    "Type": "AWS::ECS::TaskDefinition",
                    "Properties": {"Family": "retained-family"},
                },
            }
        }
        self.config = {
            "runtime": {
                "account": "111111111111",
                "region": "us-east-1",
                "stage": "dev",
                "execution_role_arn": "arn:aws:iam::111111111111:role/reviewed",
                "worker_template": template,
                "endpoint_template": template,
            },
            "queueUrl": "queue",
            "queueArn": "queue-arn",
            "deadLetterUrl": "dead",
            "deadLetterArn": "dead-arn",
            "databaseClusterArn": "database",
            "workerSecretArn": "secret",
            "ecsClusterArn": "cluster",
        }
        self.context = SimpleNamespace(get_remaining_time_in_millis=lambda: 60_000)
        self.clients = {
            name: Mock() for name in ("cloudformation", "sqs", "rds-data", "ecs")
        }
        self.window = Window("test-window", 100, 1900, 2800, "endpoints", "worker")

    def test_idle_does_not_wake_database(self):
        with (
            patch("handler.AwsRuntime") as runtime,
            patch("handler.queue_counts", return_value=(0, 0, 0)),
        ):
            runtime.return_value.observe_stack.return_value = None
            self.assertEqual(
                tick(self.config, self.clients, self.context, clock=lambda: 110),
                {"status": "idle"},
            )
            self.clients["rds-data"].execute_statement.assert_not_called()

    def test_intent_is_durable_before_one_cloud_mutation_and_loss_stops_it(self):
        for lose_lease in (False, True):
            with (
                self.subTest(lose_lease=lose_lease),
                patch("handler.AwsRuntime") as runtime,
                patch("handler.RdsLedger") as ledger,
                patch("handler.queue_counts", side_effect=[(1, 0, 0), (0, 0, 0)]),
            ):
                runtime.return_value.observe_stack.return_value = None
                ledger.return_value.claim.return_value = {
                    "status": "claimed",
                    "window": asdict(self.window),
                    "revision": 1,
                    "lease_expires_at": 290,
                }
                calls = []

                def retain(*args, lose_lease=lose_lease, calls=calls):
                    if lose_lease:
                        raise WindowUnsafe("lease_lost")
                    self.assertTrue(args[2].endpoint_requested)
                    self.assertEqual(args[2].worker_service_name, "retained-worker")
                    calls.append("retain")

                ledger.return_value.retain.side_effect = retain
                runtime.return_value.execute.side_effect = (
                    lambda *args, calls=calls, **kwargs: calls.append("execute")
                )
                if lose_lease:
                    with self.assertRaisesRegex(WindowUnsafe, "lease_lost"):
                        tick(self.config, self.clients, self.context, clock=lambda: 110)
                    runtime.return_value.execute.assert_not_called()
                    ledger.return_value.release.assert_not_called()
                else:
                    result = tick(
                        self.config, self.clients, self.context, clock=lambda: 110
                    )
                    self.assertEqual(result["status"], "command-submitted")
                    self.assertEqual(calls, ["retain", "execute"])
                    runtime.return_value.execute.assert_called_once()
                    self.clients["ecs"].list_tasks.assert_not_called()
                    ledger.return_value.release.assert_called_once()

    def test_cleanup_waits_for_actual_stop_after_service_deletion(self):
        client = boto3.client(
            "ecs",
            region_name="us-east-1",
            aws_access_key_id="synthetic",
            aws_secret_access_key="synthetic",
        )
        cluster = "arn:aws:ecs:us-east-1:111111111111:cluster/existing"
        arn = "arn:aws:ecs:us-east-1:111111111111:task/existing/12345678901234567890123456789012"
        for status, expected in [
            ("STOPPING", 1),
            ("DEPROVISIONING", 1),
            ("STOPPED", 0),
        ]:
            with self.subTest(status=status), Stubber(client) as stub:
                for desired in ("RUNNING", "STOPPED"):
                    stub.add_response(
                        "list_tasks",
                        {"taskArns": [arn]},
                        {
                            "cluster": cluster,
                            "family": "retained-family",
                            "desiredStatus": desired,
                            "maxResults": 100,
                        },
                    )
                stub.add_response(
                    "describe_tasks",
                    {
                        "tasks": [
                            {
                                "taskArn": arn,
                                "clusterArn": cluster,
                                "group": "service:retained-worker",
                                "desiredStatus": "STOPPED",
                                "lastStatus": status,
                            }
                        ]
                    },
                    {"cluster": cluster, "tasks": [arn]},
                )
                self.assertEqual(
                    unfinished_worker_tasks(
                        client, cluster, "retained-family", "retained-worker"
                    ),
                    expected,
                )
                stub.assert_no_pending_responses()

    def test_incomplete_task_readback_cannot_establish_cleanup(self):
        ecs = Mock()
        ecs.list_tasks.return_value = {"taskArns": [], "nextToken": "remaining"}
        with self.assertRaisesRegex(WindowUnsafe, "incomplete_task_observation"):
            unfinished_worker_tasks(ecs, "cluster", "family", "service")
        ecs.describe_tasks.assert_not_called()
        ecs.list_tasks.return_value = {"taskArns": ["missing-task"]}
        ecs.describe_tasks.return_value = {
            "tasks": [],
            "failures": [{"arn": "missing-task"}],
        }
        with self.assertRaisesRegex(WindowUnsafe, "incomplete_task_observation"):
            unfinished_worker_tasks(ecs, "cluster", "family", "service")

    def test_terminal_event_finishes_receipt_after_resources_are_absent(self):
        with (
            patch("handler.AwsRuntime") as runtime,
            patch("handler.RdsLedger") as ledger,
            patch("handler.queue_counts", return_value=(0, 0, 0)),
        ):
            runtime.return_value.observe_stack.return_value = None
            window = replace(
                self.window,
                phase="remove-endpoints",
                endpoint_id="endpoint-id",
                worker_id="worker-id",
                endpoint_requested=True,
                worker_requested=True,
                worker_service_name="retained-worker",
                outcome="drained",
            )
            ledger.return_value.claim.return_value = {
                "status": "claimed",
                "window": asdict(window),
                "revision": 1,
                "lease_expires_at": 290,
            }
            self.clients["ecs"].list_tasks.return_value = {"taskArns": []}
            result = tick(
                self.config,
                self.clients,
                self.context,
                clock=lambda: 110,
                force_reconcile=True,
            )
            self.assertEqual(result, {"status": "complete", "outcome": "drained"})
            self.assertEqual(
                ledger.return_value.retain.call_args.args[2].phase, "complete"
            )
            runtime.return_value.execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
