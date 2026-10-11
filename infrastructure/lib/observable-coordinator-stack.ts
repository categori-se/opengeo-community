import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_autoscaling as autoscaling,
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";
import type {PrivateRuntimeEndpointsStack} from "./private-runtime-endpoints-stack.js";

export interface ObservableCoordinatorStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly runtimeEndpoints: PrivateRuntimeEndpointsStack;
  readonly runnerAmiId: string;
  readonly runnerAmiEvidenceSha256: string;
  readonly compilerImageDigest: string;
}

export class ObservableCoordinatorStack extends Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly coordinatorDatabaseSecret: secretsmanager.Secret;
  readonly autoScalingGroup: autoscaling.AutoScalingGroup;

  constructor(scope: Construct, id: string, props: ObservableCoordinatorStackProps) {
    super(scope, id, props);

    const {
      config,
      foundation,
      runtimeEndpoints,
      runnerAmiId,
      runnerAmiEvidenceSha256,
      compilerImageDigest
    } = props;
    if (!/^ami-[0-9a-f]{17}$/.test(runnerAmiId)) {
      throw new Error("Observable coordinator runner AMI must be an exact AMI id");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(compilerImageDigest)) {
      throw new Error("Observable compiler image must be an exact sha256 digest");
    }
    if (!/^[0-9a-f]{64}$/.test(runnerAmiEvidenceSha256)) {
      throw new Error("Observable coordinator runner AMI evidence must be an exact SHA-256");
    }
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;
    const isolatedSubnets = config.production
      ? foundation.vpc.isolatedSubnets
      : [foundation.vpc.isolatedSubnets[0]!];
    if (isolatedSubnets.length < 1) {
      throw new Error("Observable coordinator requires an isolated subnet");
    }
    const subnetSelection: ec2.SubnetSelection = {subnets: isolatedSubnets};

    this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
      queueName: `opengeo-${config.stage}-observable-builds-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14)
    });
    this.queue = new sqs.Queue(this, "Queue", {
      queueName: `opengeo-${config.stage}-observable-builds`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.minutes(20),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(1),
      deadLetterQueue: {queue: this.deadLetterQueue, maxReceiveCount: 3}
    });

    this.coordinatorDatabaseSecret = new secretsmanager.Secret(
      this,
      "CoordinatorDatabaseSecret",
      {
        description: `OpenGeo ${config.stage} trusted Observable coordinator database credential`,
        encryptionKey: foundation.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            host: foundation.database.clusterEndpoint.hostname,
            port: foundation.database.clusterEndpoint.port,
            dbname: "opengeo",
            username: "opengeo_observable_coordinator"
          })
        },
        removalPolicy
      }
    );

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/opengeo/${config.stage}/observable-coordinator`,
      encryptionKey: foundation.dataKey,
      retention: config.production
        ? logs.RetentionDays.ONE_YEAR
        : logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });
    const hostSecurityGroup = new ec2.SecurityGroup(this, "HostSecurityGroup", {
      vpc: foundation.vpc,
      allowAllOutbound: false,
      description: "Trusted Observable coordinator host; managed APIs only"
    });
    const endpointSecurityGroup =
      runtimeEndpoints.observableCoordinatorEndpointSecurityGroup;
    if (!endpointSecurityGroup) {
      throw new Error("Observable coordinator requires its shared private endpoint boundary");
    }
    new ec2.CfnSecurityGroupIngress(this, "ObservableCoordinatorEndpointIngress", {
      groupId: endpointSecurityGroup.securityGroupId,
      sourceSecurityGroupId: hostSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "Observable coordinator to shared private AWS APIs"
    });
    hostSecurityGroup.addEgressRule(
      endpointSecurityGroup,
      ec2.Port.tcp(443),
      "Observable coordinator to shared private AWS APIs"
    );
    hostSecurityGroup.addEgressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.tcp(443),
      "HTTPS follows isolated-subnet routes; only the S3 gateway endpoint is routable"
    );

    const role = new iam.Role(this, "HostRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Function-only database and exact source/build object coordinator"
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement"],
      resources: [foundation.database.clusterArn]
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.coordinatorDatabaseSecret.secretArn]
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObjectVersion"],
      resources: [foundation.applicationBucket.arnForObjects(
        "organizations/*/projects/*/source-projects/*/uploads/*/files/*"
      )]
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [foundation.applicationBucket.arnForObjects(
        "organizations/*/projects/*/source-projects/*/builds/*/output/*"
      )]
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObjectVersion"],
      resources: [
        foundation.geodataBucket.arnForObjects("organizations/*/projects/*/datasets/*/uploads/*/original/*"),
        foundation.geodataBucket.arnForObjects("organizations/*/projects/*/datasets/*/versions/*/derivatives/*")
      ]
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {StringEquals: {
        "kms:ViaService": `s3.${this.region}.amazonaws.com`,
        "kms:EncryptionContext:aws:s3:arn": foundation.geodataBucket.bucketArn
      }}
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:GenerateDataKey"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `s3.${this.region}.amazonaws.com`,
          "kms:EncryptionContext:aws:s3:arn":
            foundation.applicationBucket.bucketArn
        }
      }
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {"kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`},
        StringLike: {
          "kms:EncryptionContext:SecretARN": this.coordinatorDatabaseSecret.secretArn
        }
      }
    }));
    this.queue.grantConsumeMessages(role);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`]
    }));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "install -d -m 0750 -o root -g opengeo-coordinator /etc/opengeo",
      "umask 0027",
      "printf '%s\\n' " +
        `OPEN_GEO_OBSERVABLE_COORDINATOR_STAGE=${config.stage} ` +
        `OPEN_GEO_AWS_REGION=${this.region} ` +
        `OPEN_GEO_DATA_API_CLUSTER_ARN=${foundation.database.clusterArn} ` +
        `OPEN_GEO_DATA_API_SECRET_ARN=${this.coordinatorDatabaseSecret.secretArn} ` +
        "OPEN_GEO_DB_NAME=opengeo " +
        `OPEN_GEO_APPLICATION_BUCKET=${foundation.applicationBucket.bucketName} ` +
        `OPEN_GEO_ARCHIVE_BUCKET=${foundation.geodataBucket.bucketName} ` +
        `OPEN_GEO_APPLICATION_KMS_KEY_ARN=${foundation.dataKey.keyArn} ` +
        `OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL=${this.queue.queueUrl} ` +
        `OPEN_GEO_OBSERVABLE_COMPILER_IMAGE_DIGEST=${compilerImageDigest} ` +
        `OPEN_GEO_OBSERVABLE_RUNNER_AMI_EVIDENCE_SHA256=${runnerAmiEvidenceSha256} ` +
        `OPEN_GEO_OBSERVABLE_LOG_GROUP_NAME=${logGroup.logGroupName} ` +
        "OPEN_GEO_OBSERVABLE_WORKSPACE_ROOT=/var/lib/opengeo-observable " +
        "> /etc/opengeo/observable-coordinator.env",
      "chown root:opengeo-coordinator /etc/opengeo/observable-coordinator.env",
      "chmod 0640 /etc/opengeo/observable-coordinator.env",
      "/usr/local/bin/node /opt/opengeo/observable-coordinator/scripts/configure-host-logs.mjs",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/etc/opengeo/observable-cloudwatch-agent.json",
      "systemctl enable --now opengeo-observable-coordinator.service"
    );
    const machineImage: ec2.IMachineImage = {
      getImage: () => ({
        imageId: runnerAmiId,
        osType: ec2.OperatingSystemType.LINUX,
        userData
      })
    };
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      machineImage,
      instanceType: new ec2.InstanceType("t4g.large"),
      role,
      securityGroup: hostSecurityGroup,
      userData,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: "/dev/xvda",
        volume: ec2.BlockDeviceVolume.ebs(40, {
          encrypted: true,
          kmsKey: foundation.dataKey,
          deleteOnTermination: true,
          volumeType: ec2.EbsDeviceVolumeType.GP3
        })
      }]
    });
    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, "AutoScalingGroup", {
      vpc: foundation.vpc,
      vpcSubnets: subnetSelection,
      launchTemplate,
      minCapacity: 0,
      desiredCapacity: 0,
      maxCapacity: 1,
      healthChecks: autoscaling.HealthChecks.ec2({gracePeriod: Duration.minutes(5)}),
      cooldown: Duration.minutes(1)
    });
    const backlog = new cloudwatch.MathExpression({
      expression: "visible + inflight",
      usingMetrics: {
        visible: this.queue.metricApproximateNumberOfMessagesVisible({period: Duration.minutes(1)}),
        inflight: this.queue.metricApproximateNumberOfMessagesNotVisible({period: Duration.minutes(1)})
      },
      period: Duration.minutes(1),
      label: "Observable build commands visible or in flight"
    });
    this.autoScalingGroup.scaleOnMetric("QueueBacklogScaling", {
      metric: backlog,
      adjustmentType: autoscaling.AdjustmentType.EXACT_CAPACITY,
      scalingSteps: [
        {upper: 0, change: 0},
        {lower: 1, change: 1}
      ],
      evaluationPeriods: 2
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
    new CfnOutput(this, "CoordinatorDatabaseSecretArn", {
      value: this.coordinatorDatabaseSecret.secretArn
    });
    new CfnOutput(this, "AutoScalingGroupName", {
      value: this.autoScalingGroup.autoScalingGroupName
    });
    new CfnOutput(this, "RunnerAmiId", {value: runnerAmiId});
    new CfnOutput(this, "RunnerAmiEvidenceSha256", {value: runnerAmiEvidenceSha256});
    new CfnOutput(this, "CompilerImageDigest", {value: compilerImageDigest});
  }
}
