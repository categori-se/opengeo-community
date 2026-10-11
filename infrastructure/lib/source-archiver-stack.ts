import {
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

export interface SourceArchiverStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
}

/**
 * Outbound-only, anonymous-source custody runtime.
 *
 * This deliberately does not share the connection verifier (which can read
 * connection secrets) or the private GIS worker (which has no internet route).
 * SQS carries one job UUID; PostgreSQL supplies the sealed source and limits.
 */
export class SourceArchiverStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly archiverFunction: lambda.DockerImageFunction;
  readonly archiverDatabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SourceArchiverStackProps) {
    super(scope, id, props);
    const {config, foundation, imageDigest} = props;
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${config.stage}-source-archive-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14)
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${config.stage}-source-archive`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(16),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3}
    });

    this.archiverDatabaseSecret = new secretsmanager.Secret(
      this,
      "ArchiverDatabaseSecret",
      {
        description: `OpenGeo ${config.stage} source archiver database credential`,
        encryptionKey: foundation.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            host: foundation.database.clusterEndpoint.hostname,
            port: foundation.database.clusterEndpoint.port,
            dbname: "opengeo",
            username: "opengeo_source_archiver"
          })
        },
        removalPolicy
      }
    );

    const repository = ecr.Repository.fromRepositoryAttributes(
      this,
      "ImportedApiRepository",
      {
        repositoryArn: foundation.apiRepository.repositoryArn,
        repositoryName: foundation.apiRepository.repositoryName
      }
    );
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/opengeo/${config.stage}/source-archiver`,
      encryptionKey: foundation.dataKey,
      retention: config.production
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });
    const concurrency = config.production ? 8 : 2;
    this.archiverFunction = new lambda.DockerImageFunction(this, "Function", {
      functionName: `opengeo-${config.stage}-source-archiver`,
      description: "Bounded DNS-pinned anonymous HTTPS source-to-S3 archiver",
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: imageDigest,
        cmd: ["opengeo_api.source_archiver_runtime.handler"]
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(3072),
      timeout: Duration.minutes(15),
      reservedConcurrentExecutions: concurrency,
      logGroup,
      environment: {
        OPEN_GEO_SOURCE_ARCHIVER_STAGE: config.stage,
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: this.archiverDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo",
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn,
        OPEN_GEO_PROCESSING_QUEUE_URL: foundation.processingQueue.queueUrl
      }
    });

    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement"],
      resources: [foundation.database.clusterArn]
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.archiverDatabaseSecret.secretArn]
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
          "kms:EncryptionContext:SecretARN": this.archiverDatabaseSecret.secretArn
        }
      }
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:AbortMultipartUpload"
      ],
      resources: [foundation.geodataBucket.arnForObjects(
        "organizations/*/projects/*/datasets/*/uploads/*/original/*"
      )]
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
      resources: [foundation.geodataBucket.arnForObjects(
        "discovery-metadata/organizations/*/projects/*/jobs/*/response.bin"
      )]
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [foundation.geodataBucket.bucketArn],
      conditions: {
        StringLike: {
          "s3:prefix": "discovery-metadata/organizations/*/projects/*/jobs/*/response.bin"
        },
        NumericLessThanEquals: {"s3:max-keys": 1}
      }
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:GenerateDataKey"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `s3.${this.region}.amazonaws.com`,
          // The foundation enables S3 Bucket Keys. S3 therefore supplies the
          // bucket ARN—not an individual object ARN—as the KMS encryption
          // context. Object-prefix authority remains restricted by the
          // separate S3 statement above.
          "kms:EncryptionContext:aws:s3:arn": foundation.geodataBucket.bucketArn
        }
      }
    }));
    this.archiverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["sqs:SendMessage"],
      resources: [foundation.processingQueue.queueArn]
    }));
    this.queue.grantConsumeMessages(this.archiverFunction);
    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.archiverFunction,
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
    new CfnOutput(this, "ArchiverDatabaseSecretArn", {
      value: this.archiverDatabaseSecret.secretArn
    });
    new CfnOutput(this, "FunctionName", {value: this.archiverFunction.functionName});
  }
}
