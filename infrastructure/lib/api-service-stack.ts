import {
  ArnFormat,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import {parseAdditionalUserPoolClientIds, type EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";

export interface ApiServiceStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
  readonly observableBuilderImageDigest: string;
  readonly additionalCognitoClientIds?: string;
  readonly observablePreviewPrivateKeySecretArn?: string;
  readonly connectionVerificationQueue?: sqs.IQueue;
  readonly userDatasetVerificationQueue?: sqs.IQueue;
  readonly sourceArchiverQueue?: sqs.IQueue;
  readonly repositoryObjectCopyQueue?: sqs.IQueue;
  readonly observableBuildQueue?: sqs.IQueue;
  readonly frameworkPublicationQueue?: sqs.IQueue;
  readonly observableBuildProvider?: "private_worker" | "github";
}

export class ApiServiceStack extends Stack {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: ApiServiceStackProps) {
    super(scope, id, props);

    const {config, foundation, imageDigest} = props;
    const additionalCognitoClientIds = parseAdditionalUserPoolClientIds(
      props.additionalCognitoClientIds
    );
    const observablePreview = foundation.observablePreviewEdge;
    if ((observablePreview === undefined)
      !== (props.observablePreviewPrivateKeySecretArn === undefined)) {
      throw new Error(
        "Observable preview edge and API private-key secret must be configured together"
      );
    }
    const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedDatabaseSecret",
      foundation.runtimeDatabaseSecret.secretArn
    );
    const connectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });
    const userConnectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/user-connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });
    const browserConnectionSecretArn = this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `opengeo/${config.stage}/browser-connections/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME
    });
    const apiRepository = ecr.Repository.fromRepositoryAttributes(
      this,
      "ImportedApiRepository",
      {
        repositoryArn: foundation.apiRepository.repositoryArn,
        repositoryName: foundation.apiRepository.repositoryName
      }
    );
    const apiLogGroup = logs.LogGroup.fromLogGroupArn(
      this,
      "ImportedApiLogGroup",
      foundation.apiLogGroup.logGroupArn
    );

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      }
    });

    const linuxParameters = new ecs.LinuxParameters(this, "LinuxParameters", {
      initProcessEnabled: true
    });
    linuxParameters.dropCapabilities(ecs.Capability.ALL);

    const container = this.taskDefinition.addContainer("ApiContainer", {
      containerName: "opengeo-api",
      image: ecs.ContainerImage.fromEcrRepository(
        apiRepository,
        imageDigest
      ),
      essential: true,
      user: "10001:10001",
      readonlyRootFilesystem: true,
      linuxParameters,
      environment: {
        OPEN_GEO_COGNITO_CLIENT_ID: foundation.userPoolClient.userPoolClientId,
        ...(additionalCognitoClientIds
          ? {OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS: additionalCognitoClientIds}
          : {}),
        OPEN_GEO_COGNITO_REGION: foundation.cognitoRegion,
        OPEN_GEO_COGNITO_USER_POOL_ID: foundation.userPool.userPoolId,
        OPEN_GEO_COGNITO_PROVISIONING_ENABLED:
          foundation.identityProvisioningEnabled ? "true" : "false",
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_APPLICATION_BUCKET: foundation.applicationBucket.bucketName,
        OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: props.observableBuilderImageDigest,
        ...(observablePreview && props.observablePreviewPrivateKeySecretArn
          ? {
              OPEN_GEO_OBSERVABLE_PREVIEW_ORIGIN:
                "https://preview.studio.opengeo.tools",
              ...(observablePreview.publicMapsPreviewOrigin
                ? {OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN: observablePreview.publicMapsPreviewOrigin}
                : {}),
              OPEN_GEO_OBSERVABLE_PREVIEW_KEY_PAIR_ID:
                observablePreview.publicKey.publicKeyId,
              OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN:
                props.observablePreviewPrivateKeySecretArn
            }
          : {}),
        OPEN_GEO_GEODATA_BUCKET: foundation.geodataBucket.bucketName,
        OPEN_GEO_GEODATA_KMS_KEY_ARN: foundation.dataKey.keyArn,
        OPEN_GEO_PROCESSING_QUEUE_URL: foundation.processingQueue.queueUrl,
        ...(props.connectionVerificationQueue
          ? {
              OPEN_GEO_CONNECTION_VERIFICATION_QUEUE_URL:
                props.connectionVerificationQueue.queueUrl
            }
          : {}),
        ...(props.userDatasetVerificationQueue
          ? {
              OPEN_GEO_USER_DATASET_VERIFICATION_QUEUE_URL:
                props.userDatasetVerificationQueue.queueUrl
            }
          : {}),
        ...(props.sourceArchiverQueue
          ? {
              OPEN_GEO_EXTERNAL_SOURCE_SNAPSHOT_QUEUE_URL:
                props.sourceArchiverQueue.queueUrl
            }
          : {}),
        ...(props.repositoryObjectCopyQueue
          ? {
              OPEN_GEO_REPOSITORY_OBJECT_COPY_QUEUE_URL:
                props.repositoryObjectCopyQueue.queueUrl
            }
          : {}),
        OPEN_GEO_OBSERVABLE_BUILD_PROVIDER: props.observableBuildProvider ?? "private_worker",
        ...(props.observableBuildQueue
          ? {OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL: props.observableBuildQueue.queueUrl}
          : {}),
        ...(props.frameworkPublicationQueue
          ? {OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL: props.frameworkPublicationQueue.queueUrl}
          : {}),
        OPEN_GEO_ENV: config.stage,
        OPEN_GEO_EXPOSE_DOCS: "false",
        OPEN_GEO_DB_SSLMODE: "verify-full",
        OPEN_GEO_DB_SSLROOTCERT:
          "/etc/ssl/certs/aws-rds-global-bundle.pem",
        OPEN_GEO_LOG_LEVEL: "INFO",
        OPEN_GEO_PORT: "8080"
      },
      secrets: {
        OPEN_GEO_DB_HOST: ecs.Secret.fromSecretsManager(databaseSecret, "host"),
        OPEN_GEO_DB_PORT: ecs.Secret.fromSecretsManager(databaseSecret, "port"),
        OPEN_GEO_DB_NAME: ecs.Secret.fromSecretsManager(databaseSecret, "dbname"),
        OPEN_GEO_DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, "username"),
        OPEN_GEO_DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, "password")
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiLogGroup,
        streamPrefix: "api"
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health/live', timeout=2)\" || exit 1"
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(15)
      }
    });
    container.addPortMappings({
      containerPort: 8080,
      hostPort: 8080,
      protocol: ecs.Protocol.TCP,
      name: "http"
    });
    this.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [foundation.dataKey.keyArn]
      })
    );
    this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:DeleteSecret"],
      resources: [connectionSecretArn, userConnectionSecretArn, browserConnectionSecretArn]
    }));
    this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [browserConnectionSecretArn]
    }));
    this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:GenerateDataKey"],
      resources: [foundation.dataKey.keyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`
        },
        StringLike: {
          "kms:EncryptionContext:SecretARN": [
            connectionSecretArn,
            userConnectionSecretArn,
            browserConnectionSecretArn
          ]
        }
      }
    }));
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [foundation.processingQueue.queueArn]
      })
    );
    if (props.connectionVerificationQueue !== undefined) {
      props.connectionVerificationQueue.grantSendMessages(
        this.taskDefinition.taskRole
      );
    }
    if (props.userDatasetVerificationQueue !== undefined) {
      props.userDatasetVerificationQueue.grantSendMessages(
        this.taskDefinition.taskRole
      );
    }
    if (props.sourceArchiverQueue !== undefined) {
      props.sourceArchiverQueue.grantSendMessages(
        this.taskDefinition.taskRole
      );
    }
    if (props.repositoryObjectCopyQueue !== undefined) {
      props.repositoryObjectCopyQueue.grantSendMessages(
        this.taskDefinition.taskRole
      );
    }
    if (props.observableBuildQueue !== undefined) {
      props.observableBuildQueue.grantSendMessages(
        this.taskDefinition.taskRole
      );
    }
    props.frameworkPublicationQueue?.grantSendMessages(this.taskDefinition.taskRole);
    if (props.observablePreviewPrivateKeySecretArn !== undefined) {
      this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.observablePreviewPrivateKeySecretArn]
      }));
      this.taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
            "kms:EncryptionContext:SecretARN":
              props.observablePreviewPrivateKeySecretArn
          }
        }
      }));
    }
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: [
          foundation.applicationBucket.arnForObjects(
            "organizations/*/projects/*/pages/*/versions/*/uploads/*/source.md"
          ),
          foundation.applicationBucket.arnForObjects(
            "organizations/*/projects/*/source-projects/*/uploads/*/files/*"
          )
        ]
      })
    );
    if (foundation.identityProvisioningEnabled) {
      this.taskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
          resources: [foundation.userPool.userPoolArn]
        })
      );
    }
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `s3.${this.region}.amazonaws.com`,
            "kms:EncryptionContext:aws:s3:arn":
              foundation.applicationBucket.bucketArn
          }
        }
      })
    );
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/uploads/*"
          )
        ]
      })
    );
    this.taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObjectVersion"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/uploads/*"
          ),
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/versions/*/derivatives/*"
          ),
          foundation.geodataBucket.arnForObjects(
            "discovery-metadata/organizations/*/projects/*/jobs/*/response.bin"
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
            "kms:EncryptionContext:aws:s3:arn":
              foundation.geodataBucket.bucketArn
          }
        }
      })
    );

    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc: foundation.vpc,
      allowAllOutbound: false,
      description: "OpenGeo API tasks; ingress is limited to the internal ALB"
    });
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "TLS-only egress for AWS APIs and Cognito JWKS"
    );

    this.service = new ecs.FargateService(this, "Service", {
      serviceName: `opengeo-${config.stage}-api`,
      cluster: foundation.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: config.production ? 2 : 1,
      assignPublicIp: true,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      securityGroups: [taskSecurityGroup],
      circuitBreaker: {enable: true, rollback: true},
      deploymentController: {type: ecs.DeploymentControllerType.ECS},
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      enableExecuteCommand: false,
      propagateTags: ecs.PropagatedTagSource.SERVICE
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      loadBalancerName: `opengeo-${config.stage}-api`,
      vpc: foundation.vpc,
      internetFacing: false,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      deletionProtection: config.production,
      dropInvalidHeaderFields: true
    });
    this.loadBalancer.connections.allowFrom(
      ec2.Peer.ipv4(foundation.vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      "Internal API ingress; CloudFront VPC origin replaces this broad rule"
    );

    const listener = this.loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false
    });
    listener.addTargets("ApiTargets", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: "/health/ready",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3
      }
    });
    this.service.connections.allowFrom(
      this.loadBalancer,
      ec2.Port.tcp(8080),
      "Only the internal load balancer can call API tasks"
    );

    const databaseSecurityGroup = foundation.database.connections.securityGroups[0];
    if (!databaseSecurityGroup) {
      throw new Error("The database must expose a security group");
    }
    taskSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(databaseSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      "API tasks to PostgreSQL"
    );
    new ec2.CfnSecurityGroupIngress(this, "ApiDatabaseIngress", {
      groupId: databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: taskSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "OpenGeo API tasks to PostgreSQL"
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.production ? 2 : 1,
      maxCapacity: config.production ? 8 : 2
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(60)
    });

    new CfnOutput(this, "InternalApiLoadBalancerDnsName", {
      value: this.loadBalancer.loadBalancerDnsName,
      description: "Internal origin only; do not expose this as a public API URL."
    });
    new CfnOutput(this, "ApiServiceName", {
      value: this.service.serviceName
    });
  }
}
