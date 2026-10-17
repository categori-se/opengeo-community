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
from handler import tick, unfinished_worker_tasks, unfinished_analysis_hosts
from aws_runtime import template_hash


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


class AnalysisHandlerTests(unittest.TestCase):
    def setUp(self):
        endpoint = {"Resources": {"Existing": {"Type": "AWS::EC2::VPCEndpoint"}}}
        host = {"Parameters": {"ActivationWindowId": {"Type": "String"}}, "Resources": {"Group": {
            "Type": "AWS::AutoScaling::AutoScalingGroup", "Properties": {"AutoScalingGroupName": "opengeo-dev-analysis",
                "MinSize": "0", "MaxSize": "1", "DesiredCapacity": "1", "Tags": [
                    {"Key": "opengeo:analysis-stack", "Value": {"Ref": "AWS::StackId"}, "PropagateAtLaunch": True}]}}}}
        self.config = {"runtime": {"account": "111111111111", "region": "us-east-1", "stage": "dev",
            "execution_role_arn": "arn:aws:iam::111111111111:role/reviewed", "workload": "analysis",
            "worker_template": host, "endpoint_template": endpoint, "shared_endpoint_template": endpoint},
            "queueUrl": "queue", "queueArn": "queue-arn", "deadLetterUrl": "dead", "deadLetterArn": "dead-arn",
            "databaseClusterArn": "database", "workerSecretArn": "analysis-controller-secret",
            "activationRuleName": "opengeo-dev-analysis-controller-tick"}
        self.clients = {name: Mock() for name in ("cloudformation", "sqs", "rds-data", "autoscaling", "ec2", "events")}
        self.context = SimpleNamespace(get_remaining_time_in_millis=lambda: 60_000)
        self.endpoint = __import__('controller').Stack("baseline-id", "CREATE_COMPLETE", template_hash(endpoint), None)
        self.window = Window("10000000-0000-4000-8000-000000000001", 100, 190, 400,
            template_hash(endpoint), template_hash(host), shared_endpoint_id="baseline-id", shared_endpoint_hash=template_hash(endpoint))

    def test_inactive_analysis_lease_disables_schedule_without_reserving_or_waking(self):
        with patch("handler.AwsRuntime") as runtime, patch("handler.RdsLedger") as ledger, patch("handler.queue_counts", return_value=(0, 0, 0)):
            runtime.return_value.observe_stack.return_value = None
            ledger.return_value.claim.return_value = {"status": "claimed", "window": None, "revision": 2, "lease_expires_at": 290}
            result = tick(self.config, self.clients, self.context, clock=lambda: 110)
            self.assertEqual(result, {"status": "idle"})
            self.clients["events"].disable_rule.assert_called_once_with(Name="opengeo-dev-analysis-controller-tick")
            self.clients["events"].enable_rule.assert_not_called()
            runtime.return_value.execute.assert_not_called()
            ledger.return_value.release.assert_called_once()

    def test_reserved_analysis_window_activates_only_host_after_baseline_and_retention(self):
        with patch("handler.AwsRuntime") as runtime, patch("handler.RdsLedger") as ledger, patch("handler.queue_counts", side_effect=[(1, 0, 0), (0, 0, 0)]):
            runtime.return_value.observe_stack.side_effect = lambda kind, *_: self.endpoint if kind == "endpoints" else None
            ledger.return_value.claim.return_value = {"status": "claimed", "window": asdict(self.window), "revision": 2, "lease_expires_at": 290}
            order = []
            ledger.return_value.retain.side_effect = lambda *_: order.append("retain")
            runtime.return_value.execute.side_effect = lambda *_, **__: order.append("execute")
            result = tick(self.config, self.clients, self.context, clock=lambda: 110)
            self.assertEqual(result["status"], "command-submitted")
            self.assertEqual(runtime.return_value.execute.call_args.args[1].kind, "worker")
            self.assertEqual(order[-2:], ["retain", "execute"])
            self.clients["events"].enable_rule.assert_called_once()
            self.assertFalse(ledger.return_value.retain.call_args.args[2].endpoint_requested)

    def test_deadline_host_absence_finalizes_jobs_before_completing_and_disabling(self):
        with patch("handler.AwsRuntime") as runtime, patch("handler.RdsLedger") as ledger, patch("handler.queue_counts", return_value=(0, 0, 0)):
            window = replace(self.window, phase="processing", worker_requested=True, worker_id="worker-id")
            deleted = __import__('controller').Stack("worker-id", "DELETE_COMPLETE", window.worker_hash, window.id)
            runtime.return_value.observe_stack.side_effect = lambda kind, *_: self.endpoint if kind == "endpoints" else deleted
            ledger.return_value.claim.return_value = {"status": "claimed", "window": asdict(window), "revision": 2, "lease_expires_at": 380}
            ledger.return_value.unfinished.return_value = {"analysis": 0}
            self.clients["autoscaling"].describe_auto_scaling_groups.return_value = {"AutoScalingGroups": []}
            self.clients["ec2"].describe_instances.return_value = {"Reservations": []}
            result = tick(self.config, self.clients, self.context, clock=lambda: 200)
            self.assertEqual(result, {"status": "complete", "outcome": "deadline-abort"})
            ledger.return_value.cancel_analysis_window.assert_called_once()
            ledger.return_value.finalize_analysis_window.assert_called_once()
            self.clients["events"].disable_rule.assert_called_once()
            runtime.return_value.execute.assert_not_called()

    def test_exact_host_observation_counts_stopped_instances_and_rejects_missing_or_paginated_data(self):
        asg, ec2 = self.clients["autoscaling"], self.clients["ec2"]
        asg.describe_auto_scaling_groups.return_value = {"AutoScalingGroups": []}
        instance = {"InstanceId": "i-abc123", "State": {"Name": "stopped"}, "Tags": [
            {"Key": "opengeo:analysis-stack", "Value": "stack-id"}, {"Key": "aws:autoscaling:groupName", "Value": "opengeo-dev-analysis"}]}
        ec2.describe_instances.return_value = {"Reservations": [{"Instances": [instance]}]}
        self.assertEqual(unfinished_analysis_hosts(asg, ec2, "opengeo-dev-analysis", "stack-id"), 1)
        instance["State"]["Name"] = "terminated"
        self.assertEqual(unfinished_analysis_hosts(asg, ec2, "opengeo-dev-analysis", "stack-id"), 0)
        for response in ({}, {"Reservations": [], "NextToken": "more"}):
            ec2.describe_instances.return_value = response
            with self.assertRaises(WindowUnsafe):
                unfinished_analysis_hosts(asg, ec2, "opengeo-dev-analysis", "stack-id")


if __name__ == "__main__":
    unittest.main()
