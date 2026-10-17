"""Scheduled, bounded controller entry point. The incoming event has no authority."""

import hashlib
import json
import time
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from aws_runtime import AwsRuntime, RuntimeScope
from controller import LANES, Observation, Window, WindowUnsafe, advance
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
    runtime = AwsRuntime(scope, clients["cloudformation"])
    observed_at = int(clock())
    queue = queue_counts(clients["sqs"], config["queueUrl"], config["queueArn"])
    endpoint = runtime.observe_stack("endpoints")
    worker = runtime.observe_stack("worker")
    # Keep an empty, inactive database asleep. Shared coordinator-only endpoints
    # do not imply an active GIS processing window.
    if (
        not force_reconcile
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
    )
    token = new_token()
    claim = ledger.claim(token, digest, queue[0] > 0)
    if claim["status"] != "claimed":
        if force_reconcile and claim["status"] == "busy":
            raise WindowUnsafe("terminal_event_waiting_for_lease")
        return {"status": claim["status"]}

    def finish(result):
        # Cloud requests have completed and no further mutation follows. Release
        # normally; crashes/timeouts retain the lease for safe recovery.
        ledger.release(token, claim["revision"])
        return result

    window = Window(**claim["window"])
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
    if worker is not None and worker.status != "DELETE_COMPLETE":
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
        if window.worker_service_name and window.worker_requested:
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
        lanes=frozenset({"pmtiles"}) if scope.workload == "pmtiles-v2" else LANES,
    )
    # Pure phase changes can share this observation. Never issue more than one
    # CloudFormation mutation per tick or wait inside the billed invocation.
    for _ in range(3):
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
                {"status": step.waiting or "complete", "outcome": window.outcome}
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
            for name in ("cloudformation", "sqs", "rds-data", "ecs")
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
