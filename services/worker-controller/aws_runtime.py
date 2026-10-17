"""Bounded CloudFormation transport for reviewed worker-window commands.

Templates are deployment inputs, never event fields. This transport has no
Foundation mutation, queue receive/delete, object transfer or parser execution.
"""

import hashlib
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any

from controller import Command, Stack, Window, WindowUnsafe


def template_hash(template: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(
            template, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


@dataclass(frozen=True)
class RuntimeScope:
    account: str
    region: str
    stage: str
    execution_role_arn: str
    worker_template: dict[str, Any]
    endpoint_template: dict[str, Any]
    shared_endpoint_template: dict[str, Any] | None = None
    workload: str = "shared"

    def __post_init__(self):
        if self.workload not in {"shared", "pmtiles-v2", "analysis"}:
            raise WindowUnsafe("unsupported_worker_workload")
        if self.workload == "analysis":
            resources = list(self.worker_template.get("Resources", {}).values())
            groups = [r.get("Properties", {}) for r in resources if r.get("Type") == "AWS::AutoScaling::AutoScalingGroup"]
            if (len(groups) != 1 or groups[0].get("AutoScalingGroupName") != f"opengeo-{self.stage}-analysis"
                    or str(groups[0].get("MinSize")) != "0" or str(groups[0].get("MaxSize")) != "1"
                    or str(groups[0].get("DesiredCapacity")) != "1"
                    or not any(t.get("Key") == "opengeo:analysis-stack" and t.get("Value") == {"Ref": "AWS::StackId"}
                               and t.get("PropagateAtLaunch") is True for t in groups[0].get("Tags", []))
                    or any(r.get("Type") not in {"AWS::AutoScaling::AutoScalingGroup", "AWS::EC2::LaunchTemplate",
                        "AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupIngress", "AWS::EC2::SecurityGroupEgress", "AWS::CDK::Metadata"} for r in resources)
                    or self.worker_template.get("Parameters", {}).get("ActivationWindowId", {}).get("Type") != "String"):
                raise WindowUnsafe("analysis_host_template_invalid")
            if (self.shared_endpoint_template is None
                    or template_hash(self.endpoint_template) != template_hash(self.shared_endpoint_template)):
                raise WindowUnsafe("analysis_requires_unchanged_endpoint_baseline")
        if self.workload == "pmtiles-v2":
            resources = self.worker_template.get("Resources", {}).values()
            tasks = [item for item in resources if item.get("Type") == "AWS::ECS::TaskDefinition"]
            if len(tasks) != 1:
                raise WindowUnsafe("pmtiles_task_definition_invalid")
            containers = tasks[0].get("Properties", {}).get("ContainerDefinitions", [])
            if len(containers) != 1 or containers[0].get("Command") != [
                "python3", "-m", "opengeo_worker.pmtiles_main"
            ]:
                raise WindowUnsafe("pmtiles_entrypoint_invalid")
        if not re.fullmatch(r"[0-9]{12}", self.account) or not re.fullmatch(
            r"[a-z]{2}-[a-z]+-[0-9]+", self.region
        ):
            raise WindowUnsafe("invalid_account_region")
        if self.stage not in {"dev", "staging", "demo", "production"}:
            raise WindowUnsafe("invalid_stage")
        if not self.execution_role_arn.startswith(f"arn:aws:iam::{self.account}:role/"):
            raise WindowUnsafe("execution_role_outside_account")
        for template in (
            self.worker_template,
            self.endpoint_template,
            self.shared_endpoint_template,
        ):
            if template is not None and (
                not template.get("Resources")
                or len(json.dumps(template).encode()) > 51_200
            ):
                raise WindowUnsafe("invalid_direct_template")

    def name(self, kind: str) -> str:
        if kind not in {"worker", "endpoints"}:
            raise WindowUnsafe("unsupported_stack_target")
        worker = "AnalysisRuntime" if self.workload == "analysis" else "Worker"
        return f"OpenGeo-{self.stage}-{worker if kind == 'worker' else 'PrivateRuntimeEndpoints'}"

    def check_id(self, kind: str, stack_id: str) -> None:
        prefix = f"arn:aws:cloudformation:{self.region}:{self.account}:stack/{self.name(kind)}/"
        if not stack_id.startswith(prefix) or not re.fullmatch(
            r"[A-Za-z0-9-]+", stack_id[len(prefix) :]
        ):
            raise WindowUnsafe("stack_outside_runtime_scope")


class AwsRuntime:
    def __init__(self, scope: RuntimeScope, cloudformation: Any):
        self.scope = scope
        self.cloudformation = cloudformation

    def observe_stack(self, kind: str, stack_id: str | None = None) -> Stack | None:
        target = stack_id or self.scope.name(kind)
        if stack_id:
            self.scope.check_id(kind, stack_id)
        try:
            response = self.cloudformation.describe_stacks(StackName=target)
        except self.cloudformation.exceptions.ClientError as error:
            # DescribeStacks has no typed not-found exception. Never reinterpret
            # authorization failures, throttles or malformed requests as absence.
            detail = error.response.get("Error", {})
            if (
                detail.get("Code") == "ValidationError"
                and detail.get("Message") == f"Stack with id {target} does not exist"
            ):
                return None
            raise
        stacks = response.get("Stacks", [])
        if response.get("NextToken") or len(stacks) != 1:
            raise WindowUnsafe("incomplete_stack_observation")
        stack = stacks[0]
        self.scope.check_id(kind, stack["StackId"])
        if (
            stack["StackName"] != self.scope.name(kind)
            or stack.get("RoleARN") != self.scope.execution_role_arn
        ):
            raise WindowUnsafe("runtime_stack_role_or_name_changed")
        body = self.cloudformation.get_template(
            StackName=stack["StackId"], TemplateStage="Original"
        )["TemplateBody"]
        template = json.loads(body) if isinstance(body, str) else body
        tags = {tag["Key"]: tag["Value"] for tag in stack.get("Tags", [])}
        importers: set[str] = set()
        # CloudFormation resolves the export names in its stack Outputs.
        # Deleted stacks retain their old Outputs, but the exports no longer
        # exist. ListImports on those historical names fails instead of returning
        # an empty list, so only inspect consumers while the stack still exists.
        for output in (
            []
            if stack["StackStatus"] == "DELETE_COMPLETE"
            else stack.get("Outputs", [])
        ):
            if not output.get("ExportName"):
                continue
            paginator = self.cloudformation.get_paginator("list_imports")
            observed_page = False
            try:
                for index, page in enumerate(
                    paginator.paginate(ExportName=output["ExportName"])
                ):
                    observed_page = True
                    if index >= 4:
                        raise WindowUnsafe("runtime_importer_limit")
                    importers.update(page.get("Imports", []))
                    if len(importers) > 20:
                        raise WindowUnsafe("runtime_importer_limit")
            except self.cloudformation.exceptions.ClientError as error:
                # AWS reports an existing, unused export as ValidationError.
                # Only that exact first-page response means no consumers.
                detail = error.response.get("Error", {})
                if (
                    observed_page
                    or detail.get("Code") != "ValidationError"
                    or detail.get("Message")
                    != f"Export '{output['ExportName']}' is not imported by any stack."
                ):
                    raise
        return Stack(
            stack["StackId"],
            stack["StackStatus"],
            template_hash(template),
            tags.get("opengeo:worker-window"),
            tuple(sorted(importers)),
        )

    def execute(
        self,
        window: Window,
        command: Command,
        *,
        now: int,
        lease_expires_at: int,
        monotonic=time.monotonic,
    ) -> None:
        # A controller invocation must end before its database lease can expire.
        # The caller persists command intent before entering this method.
        if not now < min(lease_expires_at - 30, window.cleanup_deadline):
            raise WindowUnsafe("window_lease_unavailable")
        started = monotonic()

        def before_mutation():
            current_time = now + math.ceil(monotonic() - started)
            if current_time >= min(lease_expires_at - 30, window.cleanup_deadline):
                raise WindowUnsafe("window_lease_unavailable")
            if command.operation == "activate" and current_time >= window.deadline:
                raise WindowUnsafe("activation_deadline_exceeded")

        if (
            command.token != f"{window.id}-{command.kind}-{command.operation}"
            or not re.fullmatch(r"[A-Za-z0-9][-A-Za-z0-9]{0,127}", command.token)
        ):
            raise WindowUnsafe("invalid_operation_token")
        expected_kind = (
            "worker" if window.phase in {"worker", "remove-worker"} else "endpoints"
        )
        expected_op = {
            "endpoints": "activate",
            "worker": "activate",
            "remove-worker": "remove",
            "remove-endpoints": "restore" if window.shared_endpoint_id else "remove",
        }.get(window.phase)
        if command.kind != expected_kind or command.operation != expected_op:
            raise WindowUnsafe("command_does_not_match_phase")
        if self.scope.workload == "analysis" and command.kind != "worker":
            raise WindowUnsafe("analysis_endpoint_mutation_forbidden")
        if command.operation == "activate" and now >= window.deadline:
            raise WindowUnsafe("activation_deadline_exceeded")
        if command.stack_id:
            self.scope.check_id(command.kind, command.stack_id)
        expected_id = (
            window.worker_id if command.kind == "worker" else window.endpoint_id
        )
        if command.stack_id != expected_id:
            raise WindowUnsafe("command_stack_identity_changed")
        template = (
            self.scope.worker_template
            if command.kind == "worker"
            else self.scope.endpoint_template
        )
        expected_hash = (
            window.worker_hash if command.kind == "worker" else window.endpoint_hash
        )
        if command.operation == "restore":
            template = self.scope.shared_endpoint_template
            expected_hash = window.shared_endpoint_hash
        if template is None or template_hash(template) != expected_hash:
            raise WindowUnsafe("command_template_changed")
        current = self.observe_stack(command.kind, command.stack_id)
        if current is not None:
            if command.stack_id and current.id != command.stack_id:
                raise WindowUnsafe("stack_changed_before_command")
            baseline = (
                command.kind == "endpoints"
                and current.id == window.shared_endpoint_id
                and current.template_hash == window.shared_endpoint_hash
            )
            active_restore = (
                command.operation == "restore"
                and current.owner == window.id
                and current.template_hash == window.endpoint_hash
            )
            if (
                not baseline
                and not active_restore
                and (
                    current.owner != window.id or current.template_hash != expected_hash
                )
            ):
                raise WindowUnsafe("stack_changed_before_command")
            if (
                command.operation == "activate"
                and not baseline
                and current.status
                in {
                    "CREATE_IN_PROGRESS",
                    "UPDATE_IN_PROGRESS",
                    "CREATE_COMPLETE",
                    "UPDATE_COMPLETE",
                }
            ):
                return  # The same stable request already took effect.
            if (
                command.operation == "restore"
                and baseline
                and current.status == "UPDATE_COMPLETE"
            ):
                return
        if command.operation == "remove":
            if not command.stack_id or command.stack_id == window.shared_endpoint_id:
                raise WindowUnsafe("removal_requires_exclusive_stack_identity")
            if current is None or current.status in {
                "DELETE_IN_PROGRESS",
                "DELETE_COMPLETE",
            }:
                return
            if current.importers or current.status not in {
                "CREATE_COMPLETE",
                "UPDATE_COMPLETE",
                "ROLLBACK_COMPLETE",
            }:
                raise WindowUnsafe("stack_not_ready_for_removal")
            before_mutation()
            self.cloudformation.delete_stack(
                StackName=command.stack_id,
                RoleARN=self.scope.execution_role_arn,
                ClientRequestToken=command.token,
            )
            return
        tags = [{"Key": "opengeo:worker-window", "Value": window.id}]
        arguments = {
            "TemplateBody": json.dumps(template, separators=(",", ":")),
            "RoleARN": self.scope.execution_role_arn,
            "ClientRequestToken": command.token,
            "Capabilities": ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        }
        if self.scope.workload == "analysis":
            arguments["Capabilities"] = []
            arguments["Parameters"] = [{"ParameterKey": "ActivationWindowId", "ParameterValue": window.id}]
        if command.stack_id:
            # Preserve existing tags, notifications and parameter bindings.
            # A shared template is restored exactly; its current coordinator
            # configuration is compared before any mutation by the controller.
            if current is None or current.status not in {
                "CREATE_COMPLETE",
                "UPDATE_COMPLETE",
            }:
                raise WindowUnsafe("stack_not_ready_for_update")
            records = self.cloudformation.describe_stacks(StackName=command.stack_id)[
                "Stacks"
            ]
            if len(records) != 1 or records[0]["StackId"] != command.stack_id:
                raise WindowUnsafe("stack_changed_before_update")
            old_tags = [
                tag
                for tag in records[0].get("Tags", [])
                if tag["Key"] != "opengeo:worker-window"
            ]
            parameters = [
                {"ParameterKey": entry["ParameterKey"], "UsePreviousValue": True}
                for entry in records[0].get("Parameters", [])
            ]
            before_mutation()
            self.cloudformation.update_stack(
                StackName=command.stack_id,
                **arguments,
                **({} if self.scope.workload == "analysis" else {"Parameters": parameters}),
                Tags=old_tags + ([] if command.operation == "restore" else tags),
            )
        else:
            before_mutation()
            self.cloudformation.create_stack(
                StackName=self.scope.name(command.kind),
                **arguments,
                Tags=tags,
                OnFailure="ROLLBACK",
                TimeoutInMinutes=15,
            )


def configured_runtime(scope: RuntimeScope) -> AwsRuntime:
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "cloudformation",
        region_name=scope.region,
        config=Config(
            connect_timeout=3,
            read_timeout=5,
            retries={"total_max_attempts": 2, "mode": "standard"},
        ),
    )
    return AwsRuntime(scope, client)
