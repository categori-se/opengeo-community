import {createHash} from "node:crypto";
import {copyFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {
  AssetHashType, CfnOutput, CfnResource, Duration, RemovalPolicy, Stack, type StackProps,
  aws_cloudwatch as cloudwatch, aws_cloudwatch_actions as actions,
  aws_events as events, aws_events_targets as targets, aws_iam as iam,
  aws_lambda as lambda, aws_logs as logs, aws_sns as sns,
  aws_sns_subscriptions as subscriptions
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import {retainWorkerRoles} from "./worker-controller-roles.js";
import {workerLifecyclePolicy, type WorkerLifecycleScope} from "./worker-lifecycle-policy.js";
// Match Python sort_keys (ASCII configuration/template keys), not locale sorting.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function sha256(value: string): string {return createHash("sha256").update(value).digest("hex");}

/** Concrete, reviewed existing-resource inputs; contains no secret values. */
export interface WorkerControllerConfiguration {
  runtime: {
    account: string; region: string; stage: string; execution_role_arn: string;
    worker_template: Record<string, unknown>; endpoint_template: Record<string, unknown>;
    shared_endpoint_template?: Record<string, unknown>;
    workload?: "shared" | "pmtiles-v2";
  };
  queueUrl: string; queueArn: string; deadLetterUrl: string; deadLetterArn: string;
  databaseClusterArn: string; workerSecretArn: string; ecsClusterArn: string;
}
export interface WorkerControllerStackProps extends StackProps {
  readonly configuration: WorkerControllerConfiguration;
  readonly workerSecretKeyArn: string;
  readonly alarmTopicArn?: string;
  /** Existing OpenGeo operations contact; creates a dedicated topic and email subscription. */
  readonly alertEmail?: string;
  readonly enabled?: boolean;
  /** Operator-managed IAM roles; activation itself has no IAM mutation authority. */
  readonly retainWorkerRoles?: boolean;
  /** Create a dedicated execution role instead of using the bootstrap administrator. */
  readonly lifecycleScope?: WorkerLifecycleScope;
}

/** Optional orchestrator only. Reuses queues, database, ECS and reviewed templates. */
export class WorkerControllerStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkerControllerStackProps) {
    super(scope, id, props);
    const config = structuredClone(props.configuration);
    const runtime = config.runtime;
    const pmtilesOnly = runtime.workload === "pmtiles-v2";
    if (runtime.account !== this.account || runtime.region !== this.region
      || !/^[0-9]{12}$/.test(runtime.account)
      || !/^(dev|staging|demo|production)$/.test(runtime.stage)) {
      throw new Error("Controller requires one concrete account, region and stage");
    }
    const prefix = (service: string) => `arn:aws:${service}:${this.region}:${this.account}:`;
    if (Boolean(props.alarmTopicArn) === Boolean(props.alertEmail)
      || (props.alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.alertEmail))) {
      throw new Error("Choose one existing alert topic or one OpenGeo operations email");
    }
    for (const [value, service, resource] of [
      [config.queueArn, "sqs", ""], [config.deadLetterArn, "sqs", ""],
      [config.databaseClusterArn, "rds", "cluster:"],
      [config.workerSecretArn, "secretsmanager", "secret:"],
      [config.ecsClusterArn, "ecs", "cluster/"],
      [props.workerSecretKeyArn, "kms", "key/"],
      ...(props.alarmTopicArn ? [[props.alarmTopicArn, "sns", ""]] : [])
    ]) {
      if (!value?.startsWith(prefix(service!) + resource) || /[*?$\s]/.test(value)) {
        throw new Error("Controller resource inputs must be exact same-account regional ARNs");
      }
    }
    for (const [url, arn] of [[config.queueUrl, config.queueArn], [config.deadLetterUrl, config.deadLetterArn]]) {
      if (url !== `https://sqs.${this.region}.amazonaws.com/${this.account}/${arn!.split(":").at(-1)}`) {
        throw new Error("Queue URL must match its exact ARN");
      }
    }
    if (!new RegExp(`^arn:aws:iam::${this.account}:role/[A-Za-z0-9/+=,.@_-]+$`).test(runtime.execution_role_arn)) {
      throw new Error("Controller requires an exact reviewed CloudFormation execution role");
    }
    for (const template of [runtime.worker_template, runtime.endpoint_template, runtime.shared_endpoint_template]) {
      if (template && (!template.Resources || Buffer.byteLength(JSON.stringify(template)) > 51_200)) {
        throw new Error("Reviewed direct CloudFormation templates must fit 51,200 bytes");
      }
    }
    let lifecycleRole: iam.Role | undefined;
    if (props.lifecycleScope) {
      const roleName = `opengeo-${runtime.stage}-worker-lifecycle`;
      if (!props.retainWorkerRoles || runtime.execution_role_arn !== `arn:aws:iam::${this.account}:role/${roleName}`) {
        throw new Error("Dedicated lifecycle role requires retained worker roles and its exact configured ARN");
      }
      const resources = Object.values(runtime.worker_template.Resources as Record<string, any>);
      const task = resources.filter(r => r.Type === "AWS::ECS::TaskDefinition");
      const service = resources.filter(r => r.Type === "AWS::ECS::Service");
      if (task.length !== 1 || task[0].Properties.Family !== props.lifecycleScope.taskFamily
        || service.length !== 1 || service[0].Properties.ServiceName !==
          `opengeo-${runtime.stage}-${pmtilesOnly ? "pmtiles-v2" : "gis"}-worker`) {
        throw new Error("Lifecycle scope must match the reviewed worker family and service");
      }
      lifecycleRole = new iam.Role(this, "LifecycleExecutionRole", {
        roleName, assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
        inlinePolicies: {WorkerLifecycle: workerLifecyclePolicy(this.account, this.region,
          runtime.stage, config.ecsClusterArn, props.lifecycleScope, runtime.workload)}
      });
      new CfnOutput(this, "LifecycleExecutionRoleArn", {value: lifecycleRole.roleArn});
    }
    if (props.retainWorkerRoles === true) {
      const extracted = retainWorkerRoles(runtime.worker_template, {
        task: {arn: `arn:aws:iam::${this.account}:role/opengeo-${runtime.stage}-worker-task`,
          exportName: `${this.stackName}:WorkerTaskRoleArn`},
        execution: {arn: `arn:aws:iam::${this.account}:role/opengeo-${runtime.stage}-worker-task-execution`,
          exportName: `${this.stackName}:WorkerExecutionRoleArn`}
      });
      runtime.worker_template = extracted.template;
      for (const [index, role] of extracted.roles.entries()) {
        const resource = new CfnResource(this, `RetainedWorkerRole${index}`, {
          type: "AWS::IAM::Role", properties: role.definition.Properties
        });
        new CfnOutput(this, `WorkerRoleArn${index}`, {
          value: resource.getAtt("Arn").toString(), exportName: role.binding.exportName
        });
      }
    }
    const source = fileURLToPath(new URL("../../services/worker-controller/", import.meta.url));
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN
    });
    const controller = new lambda.Function(this, "Controller", {
      functionName: `opengeo-${runtime.stage}-worker-controller`,
      runtime: lambda.Runtime.PYTHON_3_13, architecture: lambda.Architecture.ARM_64,
      handler: "handler.handler", memorySize: 256, timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 1, logGroup, retryAttempts: 2, maxEventAge: Duration.minutes(5),
      code: lambda.Code.fromAsset(source, {
        assetHashType: AssetHashType.OUTPUT,
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          local: {tryBundle(output: string) {
            for (const file of ["handler.py", "controller.py", "aws_runtime.py", "ledger.py"]) {
              copyFileSync(`${source}/${file}`, `${output}/${file}`);
            }
            writeFileSync(`${output}/runtime.json`, JSON.stringify(config));
            return true;
          }}
        }
      })
    });
    if (lifecycleRole) controller.node.addDependency(lifecycleRole);
    const stackPrefixes = ["Worker", "PrivateRuntimeEndpoints"].map(kind =>
      `${prefix("cloudformation")}stack/OpenGeo-${runtime.stage}-${kind}/`);
    const permit = (actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      controller.addToRolePolicy(new iam.PolicyStatement({actions, resources, conditions}));
    permit(["cloudformation:DescribeStacks", "cloudformation:GetTemplate"], stackPrefixes.map(p => `${p}*`));
    permit(["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack"],
      stackPrefixes.map(p => `${p}*`), {StringEquals: {"cloudformation:RoleArn": runtime.execution_role_arn}});
    permit(["cloudformation:TagResource", "cloudformation:UntagResource"], stackPrefixes.map(p => `${p}*`));
    permit(["cloudformation:ListImports"], ["*"]);
    permit(["iam:PassRole"], [runtime.execution_role_arn], {StringEquals: {"iam:PassedToService": "cloudformation.amazonaws.com"}});
    permit(["sqs:GetQueueAttributes"], [config.queueArn, config.deadLetterArn]);
    permit(["rds-data:ExecuteStatement"], [config.databaseClusterArn]);
    permit(["secretsmanager:GetSecretValue"], [config.workerSecretArn]);
    permit(["kms:Decrypt"], [props.workerSecretKeyArn], {
      StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
        "kms:EncryptionContext:SecretARN": config.workerSecretArn}
    });
    permit(["ecs:ListTasks"], ["*"], {ArnEquals: {"ecs:cluster": config.ecsClusterArn}});
    permit(["ecs:DescribeTasks"], [
      `${prefix("ecs")}task/${config.ecsClusterArn.split("/").at(-1)}/*`
    ], {ArnEquals: {"ecs:cluster": config.ecsClusterArn}});
    const enabled = props.enabled === true;
    new events.Rule(this, "Schedule", {
      enabled, schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(controller, {retryAttempts: 0})]
    });
    new events.Rule(this, "StackCompletion", {
      enabled,
      eventPattern: {source: ["aws.cloudformation"], detailType: ["CloudFormation Stack Status Change"],
        account: [this.account], region: [this.region],
        detail: {"stack-id": stackPrefixes.map(prefix => ({prefix})),
          "status-details": {status: ["CREATE_COMPLETE", "UPDATE_COMPLETE", "DELETE_COMPLETE", "ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"]}}},
      targets: [new targets.LambdaFunction(controller, {retryAttempts: 0})]
    });
    const alarm = new cloudwatch.Alarm(this, "Errors", {
      alarmName: `opengeo-${runtime.stage}-worker-controller-errors`,
      metric: controller.metricErrors({period: Duration.minutes(5)}), threshold: 1,
      evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Worker controller needs recovery; inspect its retained lease/window before touching runtime stacks."
    });
    if (props.alarmTopicArn) {
      alarm.addAlarmAction(new actions.SnsAction(sns.Topic.fromTopicArn(this, "ExistingAlerts", props.alarmTopicArn)));
    } else {
      const topic = new sns.Topic(this, "ProcessingAlerts", {
        topicName: `opengeo-${runtime.stage}-processing-alerts`, enforceSSL: true
      });
      topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail!));
      // Avoid SnsAction's broader service-principal grant for the managed topic.
      topic.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["sns:Publish"], resources: [topic.topicArn],
        conditions: {StringEquals: {"aws:SourceAccount": this.account},
          ArnEquals: {"aws:SourceArn": `${prefix("cloudwatch")}alarm:opengeo-${runtime.stage}-worker-controller-errors`}}
      }));
      alarm.addAlarmAction({bind: () => ({alarmActionArn: topic.topicArn})});
      new CfnOutput(this, "ProcessingAlertTopicArn", {value: topic.topicArn});
    }
    new CfnOutput(this, "ControllerScopeHash", {value: sha256(canonicalJson(config))});
    new CfnOutput(this, "WorkerTemplateHash", {value: sha256(canonicalJson(runtime.worker_template))});
    new CfnOutput(this, "EndpointTemplateHash", {value: sha256(canonicalJson(runtime.endpoint_template))});
  }
}
