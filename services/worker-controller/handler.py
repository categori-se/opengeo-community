"""Scheduled, bounded controller entry point. The incoming event has no authority."""

import hashlib
import json
import time
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from aws_runtime import AwsRuntime, RuntimeScope, template_hash
from controller import LANES, READY, Observation, Window, WindowUnsafe, advance
from ledger import RdsLedger

ATTRIBUTE_NAMES = [
    "QueueArn",
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
    "ApproximateNumberOfMessagesDelayed",
]


def queue_counts(sqs, url, arn):
    attributes = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=ATTRIBUTE_NAMES)[
        "Attributes"
    ]
    if attributes.get("QueueArn") != arn:
        raise WindowUnsafe("processing_queue_identity_changed")
    counts = []
    for name in ATTRIBUTE_NAMES[1:]:
        value = attributes.get(name, "")
        if not value.isascii() or not value.isdigit() or len(value) > 12:
            raise WindowUnsafe("incomplete_queue_counts")
        counts.append(int(value))
    return tuple(counts)


def unfinished_worker_tasks(ecs, cluster, family, service):
    # RUNNING first, then STOPPED: include a task whose desired status changes
    # during readback. The deleted service cannot launch replacements. Filtering
    # by its fixed family also works after ECS removes the service itself.
    identifiers = set()
    for desired in ("RUNNING", "STOPPED"):
        response = ecs.list_tasks(
            cluster=cluster, family=family, desiredStatus=desired, maxResults=100
        )
        if response.get("nextToken") or not isinstance(response.get("taskArns"), list):
            raise WindowUnsafe("incomplete_task_observation")
        identifiers.update(response["taskArns"])
    if len(identifiers) > 100:
        raise WindowUnsafe("task_observation_limit")
    if not identifiers:
        return 0
    response = ecs.describe_tasks(cluster=cluster, tasks=sorted(identifiers))
    tasks = response.get("tasks", [])
    if (
        response.get("failures")
        or {task.get("taskArn") for task in tasks} != identifiers
    ):
        raise WindowUnsafe("incomplete_task_observation")
    if len(tasks) != len(identifiers) or any(
        task.get("clusterArn") != cluster
        or task.get("group") != f"service:{service}"
        or not task.get("lastStatus")
        for task in tasks
    ):
        raise WindowUnsafe("worker_task_identity_changed")
    return sum(task["lastStatus"] != "STOPPED" for task in tasks)


def unfinished_analysis_hosts(autoscaling, ec2, group_name, stack_id):
    groups = autoscaling.describe_auto_scaling_groups(AutoScalingGroupNames=[group_name])
    if groups.get("NextToken") or not isinstance(groups.get("AutoScalingGroups"), list) or len(groups["AutoScalingGroups"]) > 1:
        raise WindowUnsafe("incomplete_analysis_group_observation")
    active_groups = groups.get("AutoScalingGroups", [])
    for group in active_groups:
        tags = {tag["Key"]: tag["Value"] for tag in group.get("Tags", [])}
        if group.get("AutoScalingGroupName") != group_name or tags.get("opengeo:analysis-stack") != stack_id:
            raise WindowUnsafe("analysis_group_identity_changed")
    response = ec2.describe_instances(Filters=[
        {"Name": "tag:opengeo:analysis-stack", "Values": [stack_id]},
        {"Name": "tag:aws:autoscaling:groupName", "Values": [group_name]}])
    if not isinstance(response.get("Reservations"), list) or any(not isinstance(r.get("Instances"), list) for r in response["Reservations"]):
        raise WindowUnsafe("incomplete_analysis_instance_observation")
    instances = [instance for reservation in response["Reservations"] for instance in reservation["Instances"]]
    if response.get("NextToken") or len(instances) > 100:
        raise WindowUnsafe("incomplete_analysis_instance_observation")
    for instance in instances:
        tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
        if (tags.get("opengeo:analysis-stack") != stack_id or tags.get("aws:autoscaling:groupName") != group_name
                or instance.get("State", {}).get("Name") not in {"pending", "running", "stopping", "stopped", "shutting-down", "terminated"}):
            raise WindowUnsafe("analysis_instance_identity_changed")
    identities = [instance.get("InstanceId") for instance in instances]
    if any(not isinstance(value, str) or not value for value in identities) or len(set(identities)) != len(identities):
        raise WindowUnsafe("incomplete_analysis_instance_observation")
    return len(active_groups) + sum(instance["State"]["Name"] != "terminated" for instance in instances)


def tick(
    config,
    clients,
    context,
    *,
    clock=time.time,
    new_token=lambda: str(uuid4()),
    force_reconcile=False,
):
    if context.get_remaining_time_in_millis() > 60_000:
        raise WindowUnsafe("controller_timeout_must_not_exceed_sixty_seconds")
    scope = RuntimeScope(**config["runtime"])
    analysis = scope.workload == "analysis"
    if analysis and config.get("activationRuleName") != f"opengeo-{scope.stage}-analysis-controller-tick":
        raise WindowUnsafe("analysis_activation_rule_changed")
    runtime = AwsRuntime(scope, clients["cloudformation"])
    observed_at = int(clock())
    queue = queue_counts(clients["sqs"], config["queueUrl"], config["queueArn"])
    endpoint = runtime.observe_stack("endpoints")
    worker = runtime.observe_stack("worker")
    # Keep an empty, inactive database asleep. Shared coordinator-only endpoints
    # do not imply an active GIS processing window.
    if (
        not force_reconcile
        and not analysis
        and queue == (0, 0, 0)
        and worker is None
        and (endpoint is None or endpoint.owner is None)
    ):
        return {"status": "idle"}
    digest = hashlib.sha256(
        json.dumps(
            config, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    ledger = RdsLedger(
        clients["rds-data"],
        cluster_arn=config["databaseClusterArn"],
        secret_arn=config["workerSecretArn"],
        **({"workload": "analysis"} if analysis else {}),
    )
    token = new_token()
    claim = ledger.claim(token, digest, queue[0] > 0)
    if claim["status"] != "claimed":
        if force_reconcile and claim["status"] == "busy":
            raise WindowUnsafe("terminal_event_waiting_for_lease")
        return {"status": claim["status"]}

    def finish(result, *, disable_schedule=False):
        # Cloud requests have completed and no further mutation follows. Release
        # normally; crashes/timeouts retain the lease for safe recovery.
        if disable_schedule:
            if int(clock()) >= claim["lease_expires_at"] - 30:
                raise WindowUnsafe("window_lease_unavailable")
            clients["events"].disable_rule(Name=config["activationRuleName"])
        ledger.release(token, claim["revision"])
        return result

    if analysis and claim["window"] is None:
        return finish({"status": "idle"}, disable_schedule=True)
    window = Window(**claim["window"])
    if window.started_at > observed_at:
        # A new reservation can begin after the initial reads. Collect actual
        # post-claim facts instead of relabeling observations from before it.
        observed_at = int(clock())
        queue = queue_counts(clients["sqs"], config["queueUrl"], config["queueArn"])
        endpoint = runtime.observe_stack("endpoints")
        worker = runtime.observe_stack("worker")
    if analysis:
        expected_rule = f"opengeo-{scope.stage}-analysis-controller-tick"
        if config.get("activationRuleName") != expected_rule:
            raise WindowUnsafe("analysis_activation_rule_changed")
        if (not window.shared_endpoint_id or window.shared_endpoint_hash != window.endpoint_hash
                or window.endpoint_hash != template_hash(scope.endpoint_template)):
            raise WindowUnsafe("analysis_endpoint_baseline_not_admitted")
        if window.phase in {"endpoints", "worker"} and int(clock()) < window.deadline:
            if endpoint is None or endpoint.id != window.shared_endpoint_id or endpoint.status not in READY or endpoint.template_hash != window.endpoint_hash:
                raise WindowUnsafe("analysis_endpoint_baseline_unavailable")
        if int(clock()) >= min(claim["lease_expires_at"] - 30, window.cleanup_deadline):
            raise WindowUnsafe("window_lease_unavailable")
        clients["events"].enable_rule(Name=expected_rule)
        if int(clock()) >= window.deadline and window.phase in {"endpoints", "worker", "processing", "remove-worker"}:
            ledger.cancel_analysis_window(window)
    # A rollback may remove the stack before it ever exposes Outputs. Retain
    # the reviewed service name before creation so task cleanup is still scoped.
    services = [
        resource.get("Properties", {}).get("ServiceName")
        for resource in scope.worker_template["Resources"].values()
        if resource.get("Type") == "AWS::ECS::Service"
    ]
    if len(services) == 1 and isinstance(services[0], str) and services[0]:
        if window.worker_service_name not in (None, services[0]):
            raise WindowUnsafe("worker_service_identity_changed")
        window = replace(window, worker_service_name=services[0])
    # Exact IDs keep an absent/deleted old stack distinct from a new namesake.
    if window.endpoint_id:
        endpoint = runtime.observe_stack("endpoints", window.endpoint_id)
    if window.worker_id:
        worker = runtime.observe_stack("worker", window.worker_id)
    if not analysis and worker is not None and worker.status != "DELETE_COMPLETE":
        records = clients["cloudformation"].describe_stacks(StackName=worker.id)[
            "Stacks"
        ]
        outputs = {
            item["OutputKey"]: item["OutputValue"]
            for item in records[0].get("Outputs", [])
        }
        if outputs.get("WorkerServiceName"):
            if window.worker_service_name not in (None, outputs["WorkerServiceName"]):
                raise WindowUnsafe("worker_service_identity_changed")
            window = replace(window, worker_service_name=outputs["WorkerServiceName"])
    dead = queue_counts(
        clients["sqs"], config["deadLetterUrl"], config["deadLetterArn"]
    )
    unfinished = None
    if (
        window.phase in {"processing", "remove-worker"}
        and int(clock()) < window.deadline
    ):
        unfinished = ledger.unfinished(scope.workload)
    tasks = None
    if worker is None or worker.status == "DELETE_COMPLETE":
        if analysis and window.worker_requested and window.worker_id:
            tasks = unfinished_analysis_hosts(clients["autoscaling"], clients["ec2"], f"opengeo-{scope.stage}-analysis", window.worker_id)
        elif window.worker_service_name and window.worker_requested:
            families = [
                resource.get("Properties", {}).get("Family")
                for resource in scope.worker_template["Resources"].values()
                if resource.get("Type") == "AWS::ECS::TaskDefinition"
            ]
            if (
                len(families) != 1
                or not isinstance(families[0], str)
                or not families[0]
            ):
                raise WindowUnsafe("worker_task_family_unavailable")
            tasks = unfinished_worker_tasks(
                clients["ecs"],
                config["ecsClusterArn"],
                families[0],
                window.worker_service_name,
            )
        elif not window.worker_requested:
            tasks = 0
    observation = Observation(
        observed_at,
        endpoint,
        worker,
        queue,
        dead,
        unfinished,
        unfinished is not None,
        tasks,
        lanes=frozenset({"analysis"}) if analysis else frozenset({"pmtiles"}) if scope.workload == "pmtiles-v2" else LANES,
    )
    # Pure phase changes can share this observation. Never issue more than one
    # CloudFormation mutation per tick or wait inside the billed invocation.
    analysis_finalized = False
    for _ in range(3):
        if (analysis and not analysis_finalized and window.phase in {"remove-worker", "remove-endpoints"}
                and tasks == 0 and (worker is None or worker.status == "DELETE_COMPLETE")):
            ledger.finalize_analysis_window(window)
            unfinished = ledger.unfinished("analysis")
            if unfinished != {"analysis": 0}:
                raise WindowUnsafe("analysis_jobs_not_terminal_after_host_cleanup")
            observation = replace(observation, unfinished=unfinished, unfiltered=True)
            analysis_finalized = True
        step = advance(window, observation, now=int(clock()))
        ledger.retain(token, claim["revision"], step.window)
        window = step.window
        if step.command:
            if context.get_remaining_time_in_millis() < 25_000:
                return finish({"status": "intent-retained", "phase": window.phase})
            runtime.execute(
                window,
                step.command,
                now=int(clock()),
                lease_expires_at=claim["lease_expires_at"],
            )
            return finish({"status": "command-submitted", "phase": window.phase})
        if step.waiting or window.phase == "complete":
            return finish(
                {"status": step.waiting or "complete", "outcome": window.outcome},
                disable_schedule=analysis and window.phase == "complete",
            )
    return finish({"status": "phase-retained", "phase": window.phase})


_clients = None


def handler(event, context):
    global _clients
    import boto3
    from botocore.config import Config

    config = json.loads(Path(__file__).with_name("runtime.json").read_text())
    if _clients is None:
        settings = Config(
            connect_timeout=3,
            read_timeout=5,
            retries={"total_max_attempts": 2, "mode": "standard"},
        )
        _clients = {
            name: boto3.client(
                name, region_name=config["runtime"]["region"], config=settings
            )
            for name in (("cloudformation", "sqs", "rds-data", "ec2", "autoscaling", "events")
                         if config["runtime"].get("workload") == "analysis" else ("cloudformation", "sqs", "rds-data", "ecs"))
        }
    # The deployment must also route terminal events for these exact two stacks.
    # A deletion event finishes the durable receipt after both stacks disappear,
    # without querying/waking PostgreSQL during ordinary empty-queue ticks.
    # Event contents can request reconciliation, never supply a target or config.
    return tick(
        config,
        _clients,
        context,
        force_reconcile=event.get("source") == "aws.cloudformation",
    )
