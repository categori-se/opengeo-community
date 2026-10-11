import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";

export interface RepositoryObjectCopierStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
  readonly executionRoleArn: string;
}

/**
 * Credential-isolated exact-version repository custody runtime.
 *
 * The pre-authorized execution role controls which external dataset-reader
 * roles may be assumed. SQS carries only one copy-job UUID; PostgreSQL releases
 * current connection authority after checking the immutable source version.
 */
export class RepositoryObjectCopierStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly copierFunction: lambda.DockerImageFunction;
  readonly copierDatabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: RepositoryObjectCopierStackProps) {
    super(scope, id, props);
    const {config, foundation, imageDigest, executionRoleArn} = props;
    const expectedRoleSuffix = `role/opengeo/${config.stage}/`
      + `OpenGeo${title(config.stage)}RepositoryObjectCopierRole`;
    const roleMatch = /^arn:(aws(?:-us-gov|-cn)?):iam::([0-9]{12}):(role\/.+)$/.exec(
      executionRoleArn
    );
    if (roleMatch?.[2] !== this.account || roleMatch[3] !== expectedRoleSuffix) {
      throw new Error(
        "repository object copier must use the exact scoped pre-authorized execution role"
      );
    }
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;
    const concurrency = config.production ? 8 : 2;
    const userConnectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/user-connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${config.stage}-repository-copy-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${config.stage}-repository-copy`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(16),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3},
      removalPolicy
    });

    this.copierDatabaseSecret = new secretsmanager.Secret(this, "CopierDatabaseSecret", {
      secretName: `opengeo/${config.stage}/repository-copier/database`,
      description: `OpenGeo ${config.stage} repository copier database credential`,
      encryptionKey: foundation.dataKey,
      generateSecretString: {
        generateStringKey: "password",
        passwordLength: 32,
        secretStringTemplate: this.toJsonString({
          engine: "postgres",
          dbname: "opengeo",
          username: "opengeo_repository_copier"
        })
      },
      removalPolicy
    });

    const repository = ecr.Repository.fromRepositoryAttributes(
      this,
      "ImportedApiRepository",
      {
        repositoryArn: foundation.apiRepository.repositoryArn,
        repositoryName: foundation.apiRepository.repositoryName
      }
    );
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/opengeo/${config.stage}/repository-copier`,
      encryptionKey: foundation.dataKey,
      retention: config.production
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });
    const executionRole = iam.Role.fromRoleArn(
      this,
      "ImportedExecutionRole",
      executionRoleArn,
      {mutable: true}
    );
    this.copierFunction = new lambda.DockerImageFunction(this, "Function", {
      functionName: `opengeo-${config.stage}-repository-copier`,
      description: "Exact-version connected S3 object copier with immutable custody",
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: imageDigest,
        cmd: ["opengeo_api.repository_object_copier_runtime.handler"]
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(3072),
      timeout: Duration.minutes(15),
      reservedConcurrentExecutions: concurrency,
      role: executionRole,
      logGroup,
      environment: {
        OPEN_GEO_DATASET_VERIFIER_STAGE: config.stage,
        OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX: "opengeo-deny-canary/",
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: this.copierDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo",
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn,
        OPEN_GEO_PROCESSING_QUEUE_URL: foundation.processingQueue.queueUrl
      }
    });

    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [this.formatArn({
        service: "logs",
        resource: "log-group",
        resourceName: `/opengeo/${config.stage}/repository-copier:log-stream:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME
      })]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement"],
      resources: [foundation.database.clusterArn]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.copierDatabaseSecret.secretArn, userConnectionSecretArn]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`
        },
        StringLike: {
          "kms:EncryptionContext:SecretARN": [
            this.copierDatabaseSecret.secretArn,
            userConnectionSecretArn
          ]
        }
      }
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
      resources: [foundation.geodataBucket.arnForObjects(
        "organizations/*/projects/*/datasets/*/uploads/*/original/*"
      )]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:GenerateDataKey"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `s3.${this.region}.amazonaws.com`,
          "kms:EncryptionContext:aws:s3:arn": foundation.geodataBucket.bucketArn
        }
      }
    }));
    foundation.processingQueue.grantSendMessages(executionRole);
    this.queue.grantConsumeMessages(executionRole);

    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.copierFunction,
      eventSourceArn: this.queue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: concurrency,
      enabled: true
    });
    new cloudwatch.Alarm(this, "OldestMessageAlarm", {
      metric: this.queue.metricApproximateAgeOfOldestMessage(),
      threshold: 900,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });
    new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new CfnOutput(this, "QueueUrl", {value: this.queue.queueUrl});
    new CfnOutput(this, "CopierDatabaseSecretArn", {
      value: this.copierDatabaseSecret.secretArn
    });
    new CfnOutput(this, "FunctionName", {value: this.copierFunction.functionName});
  }
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
