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

export interface ConnectionVerifierStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
}

export class ConnectionVerifierStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly verifierFunction: lambda.DockerImageFunction;
  readonly connectorDatabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ConnectionVerifierStackProps) {
    super(scope, id, props);

    const {config, foundation, imageDigest} = props;
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;
    const connectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${config.stage}-connection-verification-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14)
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${config.stage}-connection-verification`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(2),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3}
    });

    this.connectorDatabaseSecret = new secretsmanager.Secret(
      this,
      "ConnectorDatabaseSecret",
      {
        description: `OpenGeo ${config.stage} external connection verifier database credential`,
        encryptionKey: foundation.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            host: foundation.database.clusterEndpoint.hostname,
            port: foundation.database.clusterEndpoint.port,
            dbname: "opengeo",
            username: "opengeo_connector"
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
      logGroupName: `/opengeo/${config.stage}/connection-verifier`,
      encryptionKey: foundation.dataKey,
      retention: config.production
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });
    this.verifierFunction = new lambda.DockerImageFunction(this, "Function", {
      functionName: `opengeo-${config.stage}-connection-verifier`,
      description: "Isolated DNS-pinned read-only PostgreSQL/PostGIS verifier",
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: imageDigest,
        cmd: ["opengeo_api.connection_verification_runtime.handler"]
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      ephemeralStorageSize: Size.mebibytes(512),
      timeout: Duration.seconds(20),
      reservedConcurrentExecutions: config.production ? 16 : 2,
      logGroup,
      environment: {
        OPEN_GEO_CONNECTION_VERIFIER_STAGE: config.stage,
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: this.connectorDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo"
      }
    });

    this.verifierFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rds-data:ExecuteStatement"],
        resources: [foundation.database.clusterArn]
      })
    );
    this.verifierFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [this.connectorDatabaseSecret.secretArn, connectionSecretArn]
      })
    );
    this.verifierFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`
          },
          StringLike: {
            "kms:EncryptionContext:SecretARN": [
              this.connectorDatabaseSecret.secretArn,
              connectionSecretArn
            ]
          }
        }
      })
    );
    this.queue.grantConsumeMessages(this.verifierFunction);
    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.verifierFunction,
      eventSourceArn: this.queue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: config.production ? 16 : 2,
      enabled: true
    });

    new cloudwatch.Alarm(this, "OldestMessageAlarm", {
      metric: this.queue.metricApproximateAgeOfOldestMessage(),
      threshold: 120,
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
    new CfnOutput(this, "ConnectorDatabaseSecretArn", {
      value: this.connectorDatabaseSecret.secretArn
    });
    new CfnOutput(this, "FunctionName", {
      value: this.verifierFunction.functionName
    });
  }
}
