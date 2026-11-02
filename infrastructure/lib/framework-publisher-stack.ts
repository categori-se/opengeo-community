import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {FrameworkRuntimeFoundation} from "./framework-runtime-foundation.js";

export interface PublicationDestination {
  readonly hostname: string;
  readonly bucket: string;
  readonly distribution_id: string;
  readonly origin_id: string;
  readonly origin_access_control_id?: string;
}

/** Merge these statements into the bucket's existing policy through its owning stack. */
export function publicationWithdrawalPolicyStatements(props: {
  bucketArn: string;
  distributionArn: string;
  publisherRoleArn: string;
}): Record<string, unknown>[] {
  const resource = `${props.bucketArn}/releases/framework-*/*`;
  const tagWrites = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"];
  return [
    {
      Sid: "DenyWithdrawnFrameworkPublicationDelivery", Effect: "Deny",
      Principal: {Service: "cloudfront.amazonaws.com"},
      Action: ["s3:GetObject", "s3:GetObjectVersion"], Resource: resource,
      Condition: {StringEquals: {
        "AWS:SourceArn": props.distributionArn,
        "s3:ExistingObjectTag/opengeo-withdrawn": "true"
      }}
    },
    {
      Sid: "DenyFrameworkPublicationTaggingOutsidePublisher", Effect: "Deny",
      Principal: "*", Action: tagWrites, Resource: resource,
      Condition: {ArnNotEquals: {"aws:PrincipalArn": props.publisherRoleArn}}
    },
    {
      Sid: "DenyFrameworkPublicationTaggingWithoutWithdrawal", Effect: "Deny",
      Principal: "*", Action: tagWrites, Resource: resource,
      Condition: {StringNotEquals: {"s3:RequestObjectTag/opengeo-withdrawn": "true"}}
    },
    {
      Sid: "DenyFrameworkPublicationTagDeletion", Effect: "Deny",
      Principal: "*", Action: ["s3:DeleteObjectTagging", "s3:DeleteObjectVersionTagging"],
      Resource: resource
    }
  ];
}

export interface FrameworkPublisherStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: FrameworkRuntimeFoundation;
  readonly imageDigest: string;
  /** Provisioned separately for opengeo_framework_publisher, never the API/admin login. */
  readonly publisherDatabaseSecretArn: string;
  readonly publicBucket: string;
  readonly distributionId: string;
  readonly enabled?: boolean;
  /** Installation-specific physical names; omission preserves existing deployments. */
  readonly resourceNamePrefix?: string;
  /** Explicit reviewed targets; omitted retains the legacy single-host worker. */
  readonly destinations?: readonly PublicationDestination[];
  readonly protectedHosts?: readonly string[];
  /** Grant withdrawal tag access and emit policy fragments; install them separately before enabling delivery. */
  readonly withdrawalTaggingEnabled?: boolean;
}

/** Separate on-demand deployment job. No build execution, VPC, or provisioned concurrency. */
export class FrameworkPublisherStack extends Stack {
  readonly queue: sqs.Queue;
  readonly publisher: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: FrameworkPublisherStackProps) {
    super(scope, id, props);
    const {config, foundation} = props;
    if (props.resourceNamePrefix !== undefined &&
        (props.resourceNamePrefix.length > 48 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(props.resourceNamePrefix))) {
      throw new Error("Publisher resource-name prefix must be a lowercase hyphenated name of at most 48 characters");
    }
    const resourceNamePrefix = props.resourceNamePrefix ?? `opengeo-${config.stage}`;
    if (props.protectedHosts !== undefined && (!Array.isArray(props.protectedHosts) ||
        props.protectedHosts.some(host => typeof host !== "string" || !host))) {
      throw new Error("Invalid protected publication hosts");
    }
    const protectedHosts = ["studio.opengeo.tools", "preview.studio.opengeo.tools",
      "demo.studio.opengeo.tools", ...(props.protectedHosts ?? [])];
    const targets = props.destinations;
    if (targets !== undefined) {
      if (!Array.isArray(targets) || !targets.length || targets.length > 12 || protectedHosts.length > 35 ||
          protectedHosts.some(host => typeof host !== "string" || !host) ||
          targets.some(target => !target || typeof target !== "object" ||
            Object.values(target).some(value => typeof value !== "string")) ||
          !targets.some(target => target.bucket === props.publicBucket && target.distribution_id === props.distributionId) ||
          new Set(targets.map(target => target.hostname)).size !== targets.length ||
          new Set(targets.map(target => target.distribution_id)).size !== targets.length ||
          targets.some(target =>
            !["bucket,distribution_id,hostname,origin_id", "bucket,distribution_id,hostname,origin_access_control_id,origin_id"].includes(Object.keys(target).sort().join(",")) ||
            (target.origin_access_control_id && !/^[A-Z0-9]{1,32}$/.test(target.origin_access_control_id)) ||
            !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(target.hostname) || !target.hostname.includes(".") ||
            protectedHosts.includes(target.hostname) ||
            !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket) ||
            target.bucket === config.storageBuckets.application ||
            !/^[A-Z0-9]{1,32}$/.test(target.distribution_id) ||
            !/^[A-Za-z0-9_.-]{1,128}$/.test(target.origin_id))) {
        throw new Error("Invalid publication destinations");
      }
      // Leave room for the worker's existing environment and resolved resource ARNs.
      if (Buffer.byteLength(JSON.stringify(targets)) + Buffer.byteLength(JSON.stringify(protectedHosts)) > 1800) {
        throw new Error("Publication destination configuration exceeds environment budget");
      }
    }
    const buckets = [...new Set(targets?.map(target => target.bucket) ?? [props.publicBucket])];
    const distributions = targets?.map(target => target.distribution_id) ?? [props.distributionId];
    if (props.withdrawalTaggingEnabled === true &&
        (targets === undefined || targets.some(target => !target.origin_access_control_id) ||
          buckets.length !== targets.length)) {
      throw new Error("Withdrawal tagging requires explicit private OAC publication destinations with unique buckets");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(props.imageDigest)) throw new Error("Pin the publisher image digest");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(props.publicBucket) ||
        props.publicBucket === config.storageBuckets.application ||
        !/^[A-Z0-9]{1,32}$/.test(props.distributionId)) throw new Error("Invalid public destination");
    const secret = /^arn:aws:secretsmanager:([^:]+):([0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(props.publisherDatabaseSecretArn);
    if (secret?.[1] !== this.region || secret?.[2] !== this.account) throw new Error("Publisher credential must be local to this account and region");
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: `${resourceNamePrefix}-framework-publications-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `${resourceNamePrefix}-framework-publications`,
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      visibilityTimeout: Duration.minutes(90), receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(4), deadLetterQueue: {queue: deadLetters, maxReceiveCount: 100},
      removalPolicy: RemovalPolicy.RETAIN
    });
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/opengeo/${props.resourceNamePrefix ?? config.stage}/framework-publisher`,
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN
    });
    this.publisher = new lambda.DockerImageFunction(this, "Publisher", {
      functionName: props.resourceNamePrefix === undefined
        ? `${resourceNamePrefix}-framework-publisher` : `${resourceNamePrefix}-publisher`,
      description: "Publishes exact approved Framework artifacts; does not compile or access GitHub",
      code: lambda.DockerImageCode.fromEcr(foundation.apiRepository, {
        tagOrDigest: props.imageDigest, cmd: ["opengeo_api.framework_publication_controller.handler"]
      }),
      architecture: lambda.Architecture.ARM_64, memorySize: 512,
      timeout: Duration.minutes(15), reservedConcurrentExecutions: 2, logGroup,
      environment: {
        OPEN_GEO_ENV: config.stage === "demo" ? "production" : config.stage,
        OPEN_GEO_COGNITO_REGION: config.sharedAuth.region,
        OPEN_GEO_COGNITO_USER_POOL_ID: foundation.userPool.userPoolId,
        OPEN_GEO_COGNITO_CLIENT_ID: foundation.userPoolClient.userPoolClientId,
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: props.publisherDatabaseSecretArn,
        OPEN_GEO_DB_NAME: "opengeo",
        OPEN_GEO_APPLICATION_BUCKET: config.storageBuckets.application,
        // Required by shared Settings; these identifiers grant no geodata access.
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn,
        OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL: this.queue.queueUrl,
        OPEN_GEO_FRAMEWORK_PUBLICATION_PUBLIC_BUCKET: props.publicBucket,
        OPEN_GEO_FRAMEWORK_PUBLICATION_DISTRIBUTION_ID: props.distributionId,
        ...(targets === undefined ? {} : {
          OPEN_GEO_FRAMEWORK_PUBLICATION_DESTINATIONS: JSON.stringify(targets),
          OPEN_GEO_FRAMEWORK_PUBLICATION_PROTECTED_HOSTS: JSON.stringify(props.protectedHosts ?? [])
        })
      }
    });
    this.queue.grantConsumeMessages(this.publisher);
    new lambda.EventSourceMapping(this, "QueueMapping", {
      target: this.publisher, eventSourceArn: this.queue.queueArn, batchSize: 1,
      reportBatchItemFailures: true, maxConcurrency: 2, enabled: props.enabled === true
    });
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement"], resources: [foundation.database.clusterArn]
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"], resources: [props.publisherDatabaseSecretArn]
    }));
    const source = `arn:${this.partition}:s3:::${config.storageBuckets.application}`;
    const destinations = buckets.map(bucket => `arn:${this.partition}:s3:::${bucket}`);
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObjectVersion"],
      resources: [`${source}/organizations/*/projects/*/source-projects/*/builds/*/output/*`]
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"], resources: destinations,
      conditions: {StringLike: {"s3:prefix": ["releases/*"]}}
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:GetObjectVersion"], resources: destinations.map(arn => `${arn}/releases/*`)
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject"], resources: destinations.map(arn => `${arn}/releases/framework-*/*`),
      conditions: {StringEquals: {"s3:if-none-match": "*"}}
    }));
    if (props.withdrawalTaggingEnabled === true) {
      const withdrawalObjects = destinations.map(arn => `${arn}/releases/framework-*/*`);
      this.publisher.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:GetBucketPolicy", "s3:GetBucketPublicAccessBlock"], resources: destinations
      }));
      // Managed policies may be AWS-owned. The guard reads only policy IDs from an exact allowed distribution.
      this.publisher.addToRolePolicy(new iam.PolicyStatement({
        actions: ["cloudfront:GetCachePolicy", "cloudfront:GetOriginRequestPolicy"], resources: ["*"]
      }));
      this.publisher.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:GetObjectTagging", "s3:GetObjectVersionTagging"], resources: withdrawalObjects
      }));
      this.publisher.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"], resources: withdrawalObjects,
        conditions: {
          StringEquals: {"s3:RequestObjectTag/opengeo-withdrawn": "true"},
          "ForAllValues:StringEquals": {"s3:RequestObjectTagKeys": ["opengeo-withdrawn"]}
        }
      }));
      const publisherRoleArn = this.publisher.role!.roleArn;
      targets!.forEach((target, index) => {
        const statements = publicationWithdrawalPolicyStatements({
          bucketArn: `arn:${this.partition}:s3:::${target.bucket}`,
          distributionArn: `arn:${this.partition}:cloudfront::${this.account}:distribution/${target.distribution_id}`,
          publisherRoleArn
        });
        new CfnOutput(this, `WithdrawalPolicyFragment${index + 1}`, {
          description: `Merge into the existing policy owner for ${target.bucket}; retain on rollback`,
          value: this.toJsonString({Version: "2012-10-17", Statement: statements})
        });
        new CfnOutput(this, `WithdrawalPublisherRoleArn${index + 1}`, {
          description: `Sole withdrawal tag writer for ${target.bucket}`,
          value: publisherRoleArn
        });
      });
    }
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution", "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      resources: distributions.map(id => `arn:${this.partition}:cloudfront::${this.account}:distribution/${id}`)
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"], resources: [foundation.dataKey.keyArn],
      conditions: {StringEquals: {"kms:ViaService": `s3.${this.region}.amazonaws.com`, "kms:EncryptionContext:aws:s3:arn": source}}
    }));
    this.publisher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"], resources: [foundation.dataKey.keyArn],
      conditions: {StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`, "kms:EncryptionContext:SecretARN": props.publisherDatabaseSecretArn}}
    }));
    new CfnOutput(this, "QueueUrl", {value: this.queue.queueUrl});
    new CfnOutput(this, "FunctionName", {value: this.publisher.functionName});
    new CfnOutput(this, "DeadLetterQueueUrl", {value: deadLetters.queueUrl});
  }
}
