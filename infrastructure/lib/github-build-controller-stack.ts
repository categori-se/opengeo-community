import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {FrameworkRuntimeFoundation} from "./framework-runtime-foundation.js";

export interface GitHubBuildControllerStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: FrameworkRuntimeFoundation;
  readonly imageDigest: string;
  /** An explicitly approved GitHub App credential, never an operator OAuth token. */
  readonly githubAppSecretArn: string;
  /** Existing KMS key encrypting that exact secret, if customer-managed. */
  readonly githubAppSecretKeyArn?: string;
  /** Installation-specific physical names; omission preserves existing deployments. */
  readonly resourceNamePrefix?: string;
  readonly enabled?: boolean;
}

/** Resumable dispatch/observation only: no compiler, public writes, VPC or idle worker. */
export class GitHubBuildControllerStack extends Stack {
  readonly queue: sqs.Queue;
  readonly controller: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: GitHubBuildControllerStackProps) {
    super(scope, id, props);
    const {config, foundation} = props;
    if (props.resourceNamePrefix !== undefined &&
        (props.resourceNamePrefix.length > 40 || /[\u0000-\u0020\u007f]/.test(props.resourceNamePrefix) ||
          !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(props.resourceNamePrefix))) {
      throw new Error("GitHub controller resource-name prefix must be a lowercase hyphenated name of at most 40 characters");
    }
    const resourceNamePrefix = props.resourceNamePrefix ?? `opengeo-${config.stage}`;
    if (!/^sha256:[0-9a-f]{64}$/.test(props.imageDigest)) throw new Error("Pin the controller image digest");
    const secret = /^arn:aws(?:-us-gov|-cn)?:secretsmanager:([^:]+):([0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(props.githubAppSecretArn);
    if (secret?.[1] !== this.region || secret?.[2] !== this.account) {
      throw new Error("GitHub App secret must belong to this account and region");
    }
    if (props.resourceNamePrefix !== undefined &&
        (!new RegExp(`^arn:aws:secretsmanager:${this.region}:${this.account}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`).test(props.githubAppSecretArn) ||
          /[\u0000-\u0020\u007f]/.test(props.githubAppSecretArn))) {
      throw new Error("Independent GitHub App credential must be a complete same-account secret ARN");
    }
    if (props.githubAppSecretKeyArn !== undefined &&
        (!new RegExp(`^arn:aws:kms:${this.region}:${this.account}:key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(props.githubAppSecretKeyArn) ||
          /[\u0000-\u0020\u007f]/.test(props.githubAppSecretKeyArn))) {
      throw new Error("GitHub App encryption key must be an exact same-account regional key ARN");
    }
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: `${resourceNamePrefix}-github-builds-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `${resourceNamePrefix}-github-builds`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      visibilityTimeout: Duration.minutes(90), receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {queue: deadLetters, maxReceiveCount: 100},
      removalPolicy: RemovalPolicy.RETAIN
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/opengeo/${props.resourceNamePrefix ?? config.stage}/github-build-controller`,
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN
    });
    this.controller = new lambda.DockerImageFunction(this, "Controller", {
      functionName: `${resourceNamePrefix}-github-build-controller`,
      description: "On-demand GitHub source sync and run observation; no build or publisher authority",
      code: lambda.DockerImageCode.fromEcr(foundation.apiRepository, {
        tagOrDigest: props.imageDigest, cmd: ["opengeo_api.github_build_controller.handler"]
      }),
      architecture: lambda.Architecture.ARM_64, memorySize: 512,
      timeout: Duration.minutes(15), reservedConcurrentExecutions: 2, logGroup,
      environment: {
        OPEN_GEO_ENV: config.stage === "demo" ? "production" : config.stage,
        OPEN_GEO_COGNITO_REGION: config.sharedAuth.region,
        OPEN_GEO_COGNITO_USER_POOL_ID: foundation.userPool.userPoolId,
        OPEN_GEO_COGNITO_CLIENT_ID: foundation.userPoolClient.userPoolClientId,
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_OBSERVABLE_BUILD_PROVIDER: "github",
        OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL: this.queue.queueUrl,
        OPEN_GEO_GITHUB_APP_SECRET_ARN: props.githubAppSecretArn,
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: foundation.runtimeDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo",
        OPEN_GEO_APPLICATION_BUCKET: config.storageBuckets.application,
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn
      }
    });
    this.queue.grantConsumeMessages(this.controller);
    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.controller, eventSourceArn: this.queue.queueArn,
      batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 2,
      enabled: props.enabled === true
    });
    this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"],
      resources: [foundation.database.clusterArn]
    }));
    this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [foundation.runtimeDatabaseSecret.secretArn, props.githubAppSecretArn]
    }));
    const sourceBucketArn = `arn:${this.partition}:s3:::${config.storageBuckets.application}`;
    this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObjectVersion"],
      resources: [`${sourceBucketArn}/organizations/*/projects/*/source-projects/*/uploads/*/files/*`]
    }));
    this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"], resources: [foundation.dataKey.keyArn],
      conditions: {StringEquals: {"kms:ViaService": `s3.${this.region}.amazonaws.com`, "kms:EncryptionContext:aws:s3:arn": sourceBucketArn}}
    }));
    this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"], resources: [foundation.dataKey.keyArn],
      conditions: {StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`, "kms:EncryptionContext:SecretARN": foundation.runtimeDatabaseSecret.secretArn}}
    }));
    if (props.githubAppSecretKeyArn) this.controller.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"], resources: [props.githubAppSecretKeyArn],
      conditions: {StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`, "kms:EncryptionContext:SecretARN": props.githubAppSecretArn}}
    }));
    new CfnOutput(this, "QueueUrl", {value: this.queue.queueUrl});
    new CfnOutput(this, "FunctionName", {value: this.controller.functionName});
    new CfnOutput(this, "DeadLetterQueueUrl", {value: deadLetters.queueUrl});
  }
}
