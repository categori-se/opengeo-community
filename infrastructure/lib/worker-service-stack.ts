import {
  Aws,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";
import type {PrivateRuntimeEndpointsStack} from "./private-runtime-endpoints-stack.js";

export interface WorkerServiceStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly runtimeEndpoints: PrivateRuntimeEndpointsStack;
  readonly imageDigest: string;
  readonly workload?: "shared" | "pmtiles-v2";
  readonly processingQueue?: sqs.IQueue;
  readonly processingDeadLetterQueue?: sqs.IQueue;
}

export class WorkerServiceStack extends Stack {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: WorkerServiceStackProps) {
    super(scope, id, props);

    const {config, foundation, runtimeEndpoints, imageDigest} = props;
    const pmtilesOnly = props.workload === "pmtiles-v2";
    if (pmtilesOnly && !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
      throw new Error("PMTiles v2 requires an immutable worker image digest");
    }
    if (pmtilesOnly && (!props.processingQueue || !props.processingDeadLetterQueue
      || props.processingQueue.queueArn === foundation.processingQueue.queueArn
      || props.processingDeadLetterQueue.queueArn === foundation.processingDeadLetterQueue.queueArn)) {
      throw new Error("PMTiles v2 requires an isolated durable queue and dead-letter queue");
    }
    const processingQueue = props.processingQueue ?? foundation.processingQueue;
    const processingDeadLetterQueue = props.processingDeadLetterQueue ?? foundation.processingDeadLetterQueue;
    const workerSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedWorkerDatabaseSecret",
      foundation.workerDatabaseSecret.secretArn
    );
    const workerRepository = ecr.Repository.fromRepositoryAttributes(
      this,
      "ImportedWorkerRepository",
      {
        repositoryArn: foundation.workerRepository.repositoryArn,
        repositoryName: foundation.workerRepository.repositoryName
      }
    );
    const workerLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "ImportedWorkerLogGroup",
      foundation.workerLogGroup.logGroupArn
    );

    const isolatedSubnets = foundation.vpc.isolatedSubnets;
    if (isolatedSubnets.length < 1) {
      throw new Error("The worker requires at least one isolated subnet");
    }
    const workerSubnets = config.production
      ? isolatedSubnets
      : [isolatedSubnets[0]!];
    const subnetSelection: ec2.SubnetSelection = {subnets: workerSubnets};

    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc: foundation.vpc,
      allowAllOutbound: false,
      description: "OpenGeo GIS workers; no public or general internet egress"
    });
    const endpointSecurityGroup = runtimeEndpoints.workerEndpointSecurityGroup;
    if (!endpointSecurityGroup) {
      throw new Error("The worker requires its shared private endpoint boundary");
    }
    new ec2.CfnSecurityGroupIngress(this, "WorkerEndpointIngress", {
      groupId: endpointSecurityGroup.securityGroupId,
      sourceSecurityGroupId: taskSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      description: "GIS workers to shared private AWS APIs"
    });
    taskSecurityGroup.addEgressRule(
      endpointSecurityGroup,
      ec2.Port.tcp(443),
      "GIS workers to shared private AWS APIs"
    );
    taskSecurityGroup.addEgressRule(
      ec2.Peer.ipv4("0.0.0.0/0"),
      ec2.Port.tcp(443),
      "HTTPS follows isolated-subnet routes; only the S3 gateway endpoint is routable"
    );

    const databaseSecurityGroup = foundation.database.connections.securityGroups[0];
    if (!databaseSecurityGroup) {
      throw new Error("The database must expose a security group");
    }
    taskSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(databaseSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      "GIS workers to PostgreSQL"
    );
    new ec2.CfnSecurityGroupIngress(this, "WorkerDatabaseIngress", {
      groupId: databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: taskSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "OpenGeo GIS workers to PostgreSQL"
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      ...(pmtilesOnly ? {family: `opengeo-${config.stage}-pmtiles-v2`} : {}),
      cpu: 2048,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 50,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });
    this.taskDefinition.addVolume({name: "Workspace"});
    const linuxParameters = new ecs.LinuxParameters(this, "LinuxParameters", {
      initProcessEnabled: true
    });
    linuxParameters.dropCapabilities(ecs.Capability.ALL);
    const container = this.taskDefinition.addContainer("WorkerContainer", {
      containerName: "opengeo-gis-worker",
      image: ecs.ContainerImage.fromEcrRepository(workerRepository, imageDigest),
      command: pmtilesOnly ? ["python3", "-m", "opengeo_worker.pmtiles_main"] : [
        "python3", "-c",
        "import runpy; runpy.run_path('/srv/opengeo/scripts/verify-toolchain.py', run_name='__main__'); "
          + "print('opengeo-worker-native-toolchain-ok', flush=True); "
          + "runpy.run_module('opengeo_worker', run_name='__main__')"
      ],
      essential: true,
      user: "10001:10001",
      readonlyRootFilesystem: true,
      linuxParameters,
      stopTimeout: Duration.seconds(120),
      environment: {
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_EXPECTED_OWNER: Aws.ACCOUNT_ID,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn,
        OPEN_GEO_PROCESSING_QUEUE_URL: processingQueue.queueUrl,
        ...(pmtilesOnly ? {OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST: imageDigest} : {}),
        OPEN_GEO_DB_SSLROOTCERT: "/etc/ssl/certs/aws-rds-global-bundle.pem",
        OPEN_GEO_MAX_ATTEMPTS: "3",
        OPEN_GEO_WORKSPACE_ROOT: "/tmp/opengeo-worker"
      },
      secrets: {
        OPEN_GEO_DB_HOST: ecs.Secret.fromSecretsManager(workerSecret, "host"),
        OPEN_GEO_DB_PORT: ecs.Secret.fromSecretsManager(workerSecret, "port"),
        OPEN_GEO_DB_NAME: ecs.Secret.fromSecretsManager(workerSecret, "dbname"),
        OPEN_GEO_DB_USER: ecs.Secret.fromSecretsManager(workerSecret, "username"),
        OPEN_GEO_DB_PASSWORD: ecs.Secret.fromSecretsManager(workerSecret, "password")
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workerLogGroup,
        streamPrefix: "worker"
      })
    });
    container.addMountPoints({
      sourceVolume: "Workspace",
      containerPath: "/tmp/opengeo-worker",
      readOnly: false
    });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    workerRepository.grantPull(executionRole);
    workerSecret.grantRead(executionRole);
    foundation.dataKey.grantDecrypt(executionRole);
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes"
        ],
        resources: [processingQueue.queueArn]
      })
    );
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObjectVersion"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/uploads/*/original/*"
          ),
          foundation.geodataBucket.arnForObjects(
            pmtilesOnly
              ? "organizations/*/projects/*/datasets/*/versions/*/derivatives/working/*"
              : "organizations/*/projects/*/datasets/*/versions/*/derivatives/*"
          )
        ]
      })
    );
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            pmtilesOnly
              ? "organizations/*/projects/*/datasets/*/versions/*/derivatives/tiles/custom/*"
              : "organizations/*/projects/*/datasets/*/versions/*/derivatives/*"
          )
        ]
      })
    );
    if (!pmtilesOnly) this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObjectVersion"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/versions/*/derivatives/coverages/*.tif"
          ),
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/versions/*/derivatives/renders/*"
          )
        ]
      })
    );
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `s3.${this.region}.amazonaws.com`,
            // Both storage buckets use S3 Bucket Keys. KMS therefore receives
            // the bucket ARN as its encryption context; the S3 statements
            // above remain responsible for restricting object prefixes.
            "kms:EncryptionContext:aws:s3:arn":
              foundation.geodataBucket.bucketArn
          }
        }
      })
    );

    this.service = new ecs.FargateService(this, "Service", {
      serviceName: `opengeo-${config.stage}-${pmtilesOnly ? "pmtiles-v2" : "gis"}-worker`,
      cluster: foundation.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 0,
      assignPublicIp: false,
      vpcSubnets: subnetSelection,
      securityGroups: [taskSecurityGroup],
      circuitBreaker: {enable: true, rollback: true},
      deploymentController: {type: ecs.DeploymentControllerType.ECS},
      minHealthyPercent: 0,
      maxHealthyPercent: pmtilesOnly ? 100 : 200,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      enableExecuteCommand: false,
      propagateTags: ecs.PropagatedTagSource.SERVICE
    });
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: pmtilesOnly ? 1 : config.workerMaxTasks
    });
    scaling.scaleToTrackCustomMetric("QueueBacklogTarget", {
      metric: processingQueue.metricApproximateNumberOfMessagesVisible(),
      // Target tracking uses a strict greater-than scale-out alarm. A target
      // of one strands a single queued job when desired capacity is zero.
      targetValue: 0.5,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.seconds(30)
    });

    new cloudwatch.Alarm(this, "OldestMessageAlarm", {
      metric: processingQueue.metricApproximateAgeOfOldestMessage(),
      threshold: 900,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });
    new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      metric: processingDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new CfnOutput(this, "WorkerServiceName", {value: this.service.serviceName});
  }
}
