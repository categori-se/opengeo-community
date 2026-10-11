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

export interface UserDatasetVerifierStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
  readonly executionRoleArn: string;
}

export class UserDatasetVerifierStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly verifierFunction: lambda.DockerImageFunction;
  readonly repositoryBrowserFunction: lambda.DockerImageFunction;
  readonly verifierDatabaseSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: UserDatasetVerifierStackProps) {
    super(scope, id, props);

    const {config, foundation, imageDigest, executionRoleArn} = props;
    const expectedRoleSuffix = `role/opengeo/${config.stage}/`
      + `OpenGeo${title(config.stage)}DatasetConnectionVerifierRole`;
    const roleMatch = /^arn:(aws(?:-us-gov|-cn)?):iam::([0-9]{12}):(role\/.+)$/.exec(
      executionRoleArn
    );
    if (roleMatch?.[2] !== this.account || roleMatch[3] !== expectedRoleSuffix) {
      throw new Error(
        "user dataset verifier must use the exact scoped pre-authorized execution role"
      );
    }
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;
    const userConnectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/user-connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${config.stage}-user-dataset-verification-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${config.stage}-user-dataset-verification`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(2),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3},
      removalPolicy
    });

    this.verifierDatabaseSecret = new secretsmanager.Secret(
      this,
      "VerifierDatabaseSecret",
      {
        secretName: `opengeo/${config.stage}/dataset-verifier/database`,
        description: `OpenGeo ${config.stage} user dataset verifier database credential`,
        encryptionKey: foundation.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            dbname: "opengeo",
            username: "opengeo_dataset_verifier"
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
      logGroupName: `/opengeo/${config.stage}/user-dataset-verifier`,
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
    this.verifierFunction = new lambda.DockerImageFunction(this, "Function", {
      functionName: `opengeo-${config.stage}-user-dataset-verifier`,
      description: "Isolated assume-role S3 verifier with positive and denial canaries",
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: imageDigest,
        cmd: ["opengeo_api.user_dataset_verification_runtime.handler"]
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      ephemeralStorageSize: Size.mebibytes(512),
      timeout: Duration.seconds(25),
      reservedConcurrentExecutions: config.production ? 8 : 2,
      role: executionRole,
      logGroup,
      environment: {
        OPEN_GEO_DATASET_VERIFIER_STAGE: config.stage,
        OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX: "opengeo-deny-canary/",
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: this.verifierDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo"
      }
    });
    this.repositoryBrowserFunction = new lambda.DockerImageFunction(
      this,
      "RepositoryBrowserFunction",
      {
        functionName: `opengeo-${config.stage}-user-dataset-repository-browser`,
        description: "Isolated bounded S3 repository metadata browser",
        code: lambda.DockerImageCode.fromEcr(repository, {
          tagOrDigest: imageDigest,
          cmd: ["opengeo_api.dataset_repository_browser_runtime.handler"]
        }),
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        ephemeralStorageSize: Size.mebibytes(512),
        timeout: Duration.seconds(15),
        reservedConcurrentExecutions: config.production ? 8 : 2,
        role: executionRole,
        logGroup,
        environment: {
          OPEN_GEO_DATASET_VERIFIER_STAGE: config.stage,
          OPEN_GEO_DATASET_VERIFIER_DENY_PREFIX: "opengeo-deny-canary/",
          OPEN_GEO_DATA_API_REGION: this.region,
          OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
          OPEN_GEO_DATA_API_SECRET_ARN: this.verifierDatabaseSecret.secretArn,
          OPEN_GEO_DB_NAME: "opengeo"
        }
      }
    );

    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement"],
      resources: [foundation.database.clusterArn]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        this.verifierDatabaseSecret.secretArn,
        userConnectionSecretArn
      ]
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
          "kms:EncryptionContext:SecretARN": this.verifierDatabaseSecret.secretArn
        }
      }
    }));
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`
        },
        StringLike: {
          "kms:EncryptionContext:SecretARN": userConnectionSecretArn
        }
      }
    }));
    this.queue.grantConsumeMessages(executionRole);

    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.verifierFunction,
      eventSourceArn: this.queue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
      maxConcurrency: config.production ? 8 : 2,
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
    new CfnOutput(this, "VerifierDatabaseSecretArn", {
      value: this.verifierDatabaseSecret.secretArn
    });
    new CfnOutput(this, "FunctionName", {
      value: this.verifierFunction.functionName
    });
    new CfnOutput(this, "RepositoryBrowserFunctionName", {
      value: this.repositoryBrowserFunction.functionName
    });
  }
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
