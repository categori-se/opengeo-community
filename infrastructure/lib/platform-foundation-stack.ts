import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Token,
  type StackProps,
  aws_cognito as cognito,
  aws_budgets as budgets,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import {SqsDestination} from "aws-cdk-lib/aws-s3-notifications";
import type {Construct} from "constructs";
import type {EnvironmentConfig} from "./config.js";
import {
  ObservablePreviewEdge,
  type ObservablePreviewEdgeProps
} from "./observable-preview-edge.js";

export const FOUNDATION_DEFINITION_VERSION = "opengeo.foundation.1.0.0";

export type ObservablePreviewEdgeConfiguration = Omit<
  ObservablePreviewEdgeProps,
  "applicationBucket" | "applicationBucketName" | "dataKey"
>;

export interface PlatformFoundationStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly budgetAlertEmail: string;
  readonly existingBudgetName?: string;
  readonly existingUserPoolClientId?: string;
  readonly observablePreview?: ObservablePreviewEdgeConfiguration;
}

export class PlatformFoundationStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly dataKey: kms.Key;
  readonly applicationBucket: s3.Bucket;
  readonly geodataBucket: s3.Bucket;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly database: rds.DatabaseCluster;
  readonly cluster: ecs.Cluster;
  readonly processingQueue: sqs.Queue;
  readonly processingDeadLetterQueue: sqs.Queue;
  readonly apiRepository: ecr.Repository;
  readonly workerRepository: ecr.Repository;
  readonly apiLogGroup: logs.LogGroup;
  readonly workerLogGroup: logs.LogGroup;
  readonly runtimeDatabaseSecret: secretsmanager.Secret;
  readonly workerDatabaseSecret: secretsmanager.Secret;
  readonly observablePreviewEdge?: ObservablePreviewEdge;
  readonly identityProvisioningEnabled: boolean;

  constructor(
    scope: Construct,
    id: string,
    props: PlatformFoundationStackProps
  ) {
    super(scope, id, props);

    const {config, budgetAlertEmail} = props;
    const removalPolicy = config.production
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;
    const logRetention = this.logRetention(config.logRetentionDays);

    this.dataKey = new kms.Key(this, "DataKey", {
      alias: `alias/opengeo/${config.stage}/data`,
      description: `OpenGeo ${config.stage} data encryption key`,
      enableKeyRotation: true,
      removalPolicy,
      pendingWindow: Duration.days(30)
    });
    this.dataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowBoundedCloudWatchLogsEncryption",
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*"
      ],
      resources: ["*"],
      conditions: {
        ArnLike: {
          "kms:EncryptionContext:aws:logs:arn": this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `/opengeo/${config.stage}/*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME
          })
        }
      }
    }));

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: "data",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED
        }
      ]
    });

    this.applicationBucket = this.createBucket("ApplicationBucket", {
      config,
      compilerCacheLifecycle: true,
      bucketName: config.storageBuckets.application,
      removalPolicy,
      versioned: true,
      ...(config.allowedWebOrigins.length > 0
        ? {
            cors: [
              {
                allowedHeaders: ["*"],
                allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST],
                allowedOrigins: [...config.allowedWebOrigins],
                exposedHeaders: ["ETag", "x-amz-version-id"],
                maxAge: 300
              }
            ]
          }
        : {})
    });
    Tags.of(this.applicationBucket).add(
      "OpenGeoFoundationDefinition",
      FOUNDATION_DEFINITION_VERSION
    );
    this.geodataBucket = this.createBucket("GeodataBucket", {
      config,
      bucketName: config.storageBuckets.data,
      removalPolicy,
      versioned: true,
      ...(config.allowedWebOrigins.length > 0
        ? {
            cors: [
              {
                allowedHeaders: ["*"],
                allowedMethods: [
                  s3.HttpMethods.GET,
                  s3.HttpMethods.HEAD,
                  s3.HttpMethods.POST,
                  s3.HttpMethods.PUT
                ],
                allowedOrigins: [...config.allowedWebOrigins],
                exposedHeaders: ["ETag", "x-amz-version-id", "Content-Range"],
                maxAge: 300
              }
            ]
          }
        : {})
    });
    if (props.observablePreview !== undefined) {
      if (!config.production) {
        throw new Error("The exact Observable preview domain is production-only");
      }
      this.observablePreviewEdge = new ObservablePreviewEdge(this, "ObservablePreview", {
        ...props.observablePreview,
        applicationBucket: this.applicationBucket,
        applicationBucketName: config.storageBuckets.application,
        dataKey: this.dataKey
      });
    }

    if (config.federation.google || config.federation.entra) {
      throw new Error(
        "Federation providers are managed by the shared auth.categori.se pool, not OpenGeo"
      );
    }
    const sharedUserPoolArn = this.formatArn({
      service: "cognito-idp",
      region: config.sharedAuth.region,
      account: config.sharedAuth.accountId,
      resource: "userpool",
      resourceName: config.sharedAuth.userPoolId
    });
    this.userPool = cognito.UserPool.fromUserPoolArn(this, "SharedUserPool", sharedUserPoolArn);
    this.identityProvisioningEnabled =
      Token.isUnresolved(this.account) || this.account === config.sharedAuth.accountId;
    if (!this.identityProvisioningEnabled && props.existingUserPoolClientId === undefined) {
      throw new Error(
        "the shared auth.categori.se pool belongs to a different AWS account; "
        + "supply an existing public user-pool client id and keep identity provisioning disabled"
      );
    }
    this.userPoolClient = props.existingUserPoolClientId
      ? cognito.UserPoolClient.fromUserPoolClientId(
          this,
          "ExistingWebClient",
          props.existingUserPoolClientId
        )
      : new cognito.UserPoolClient(this, "WebClient", {
          userPool: this.userPool,
          userPoolClientName: `opengeo-${config.stage}-web`,
          oAuth: {
            flows: {authorizationCodeGrant: true},
            scopes: [
              cognito.OAuthScope.OPENID,
              cognito.OAuthScope.EMAIL,
              cognito.OAuthScope.PROFILE
            ],
            callbackUrls: [`${config.webOrigin}/login`],
            logoutUrls: [`${config.webOrigin}/login`],
            defaultRedirectUri: `${config.webOrigin}/login`
          },
          supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
          accessTokenValidity: Duration.minutes(60),
          idTokenValidity: Duration.minutes(60),
          refreshTokenValidity: Duration.days(30),
          enableTokenRevocation: true,
          preventUserExistenceErrors: true
        });

    this.processingDeadLetterQueue = new sqs.Queue(this, "ProcessingDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14)
    });
    this.processingQueue = new sqs.Queue(this, "ProcessingQueue", {
      visibilityTimeout: Duration.minutes(15),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.processingDeadLetterQueue,
        maxReceiveCount: 3
      }
    });
    this.geodataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new SqsDestination(this.processingQueue),
      {prefix: "organizations/"}
    );

    this.apiRepository = this.createRepository(
      "ApiRepository",
      `opengeo/${config.stage}/api`,
      config,
      removalPolicy
    );
    this.workerRepository = this.createRepository(
      "WorkerRepository",
      `opengeo/${config.stage}/gis-worker`,
      config,
      removalPolicy
    );

    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `opengeo-${config.stage}`,
      vpc: this.vpc,
      containerInsightsV2: config.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
      enableFargateCapacityProviders: true
    });

    this.database = new rds.DatabaseCluster(this, "Database", {
      defaultDatabaseName: "opengeo",
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of(
          config.auroraPostgresVersion,
          "16"
        )
      }),
      credentials: rds.Credentials.fromGeneratedSecret("opengeo_admin", {
        encryptionKey: this.dataKey
      }),
      writer: rds.ClusterInstance.serverlessV2("Writer", {
        autoMinorVersionUpgrade: true,
        publiclyAccessible: false
      }),
      readers:
        config.databaseReaderCount === 1
          ? [
              rds.ClusterInstance.serverlessV2("Reader", {
                autoMinorVersionUpgrade: true,
                publiclyAccessible: false,
                // An unused replica must not wake and mirror writer capacity.
                // Tier 2 retains failover eligibility with independent auto-pause.
                scaleWithWriter: false
              })
            ]
          : [],
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: config.databaseMaxAcu,
      serverlessV2AutoPauseDuration: Duration.minutes(
        config.databaseAutoPauseMinutes
      ),
      enableDataApi: true,
      vpc: this.vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_ISOLATED},
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      backup: {retention: Duration.days(config.databaseBackupDays)},
      copyTagsToSnapshot: true,
      deleteAutomatedBackups: !config.production,
      deletionProtection: config.deletionProtection,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logRetention,
      removalPolicy
    });

    this.runtimeDatabaseSecret = new secretsmanager.Secret(
      this,
      "RuntimeDatabaseSecret",
      {
        description: `OpenGeo ${config.stage} API runtime database credential`,
        encryptionKey: this.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            host: this.database.clusterEndpoint.hostname,
            port: this.database.clusterEndpoint.port,
            dbname: "opengeo",
            username: "opengeo_runtime"
          })
        },
        removalPolicy
      }
    );
    this.workerDatabaseSecret = new secretsmanager.Secret(
      this,
      "WorkerDatabaseSecret",
      {
        description: `OpenGeo ${config.stage} GIS worker database credential`,
        encryptionKey: this.dataKey,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          secretStringTemplate: this.toJsonString({
            engine: "postgres",
            host: this.database.clusterEndpoint.hostname,
            port: this.database.clusterEndpoint.port,
            dbname: "opengeo",
            username: "opengeo_worker"
          })
        },
        removalPolicy
      }
    );

    this.apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      logGroupName: `/opengeo/${config.stage}/api`,
      encryptionKey: this.dataKey,
      retention: logRetention,
      removalPolicy
    });
    this.workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: `/opengeo/${config.stage}/gis-worker`,
      encryptionKey: this.dataKey,
      retention: logRetention,
      removalPolicy
    });

    const budgetName = `opengeo-${config.stage}-monthly-account`;
    if (props.existingBudgetName !== undefined && props.existingBudgetName !== budgetName) {
      throw new Error(`existing budget must be named ${budgetName}`);
    }
    if (props.existingBudgetName === undefined) {
      const budgetSubscriber = {
        address: budgetAlertEmail,
        subscriptionType: "EMAIL"
      };
      new budgets.CfnBudget(this, "MonthlyCostBudget", {
        budget: {
          budgetLimit: {amount: config.monthlyBudgetUsd, unit: "USD"},
          budgetName,
          budgetType: "COST",
          timeUnit: "MONTHLY"
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "FORECASTED",
              threshold: 80,
              thresholdType: "PERCENTAGE"
            },
            subscribers: [budgetSubscriber]
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 100,
              thresholdType: "PERCENTAGE"
            },
            subscribers: [budgetSubscriber]
          }
        ]
      });
    }

    new CfnOutput(this, "ApplicationBucketName", {
      value: this.applicationBucket.bucketName
    });
    new CfnOutput(this, "GeodataBucketName", {
      value: this.geodataBucket.bucketName
    });
    new CfnOutput(this, "UserPoolId", {value: this.userPool.userPoolId});
    new CfnOutput(this, "BudgetName", {value: budgetName});
    new CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId
    });
    new CfnOutput(this, "CognitoHostedUiBaseUrl", {
      value: config.sharedAuth.hostedUiBaseUrl
    });
    new CfnOutput(this, "ApplicationWebOrigin", {value: config.webOrigin});
    new CfnOutput(this, "BrowserAuthConfigJson", {
      value: this.toJsonString({
        version: 1,
        region: config.sharedAuth.region,
        userPoolId: this.userPool.userPoolId,
        clientId: this.userPoolClient.userPoolClientId,
        hostedUiBaseUrl: config.sharedAuth.hostedUiBaseUrl,
        redirectUri: `${config.webOrigin}/login`,
        logoutUri: `${config.webOrigin}/login`,
        scopes: ["openid", "email", "profile"]
      })
    });
    new CfnOutput(this, "DatabaseSecretArn", {
      value: this.database.secret?.secretArn ?? "not-created"
    });
    new CfnOutput(this, "DatabaseClusterArn", {
      value: this.database.clusterArn
    });
    new CfnOutput(this, "RuntimeDatabaseSecretArn", {
      value: this.runtimeDatabaseSecret.secretArn
    });
    new CfnOutput(this, "WorkerDatabaseSecretArn", {
      value: this.workerDatabaseSecret.secretArn
    });
    new CfnOutput(this, "ProcessingQueueUrl", {
      value: this.processingQueue.queueUrl
    });
  }

  private createBucket(
    id: string,
    options: {
      readonly config: EnvironmentConfig;
      readonly bucketName: string;
      readonly removalPolicy: RemovalPolicy;
      readonly versioned: boolean;
      readonly cors?: s3.CorsRule[];
      readonly compilerCacheLifecycle?: boolean;
    }
  ): s3.Bucket {
    return new s3.Bucket(this, id, {
      bucketName: options.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: options.versioned,
      cors: options.cors,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: options.config.production
            ? Duration.days(365)
            : Duration.days(30)
        },
        ...(options.compilerCacheLifecycle ? [
          {
            id: "CompilerPageCacheExpiration",
            prefix: "compiler-cache/pages/v1/",
            expiration: Duration.days(7),
            noncurrentVersionExpiration: Duration.days(1)
          },
          {
            id: "CompilerPageCacheDeleteMarkers",
            prefix: "compiler-cache/pages/v1/",
            expiredObjectDeleteMarker: true
          }
        ] : [])
      ],
      autoDeleteObjects: !options.config.production,
      removalPolicy: options.removalPolicy
    });
  }

  private createRepository(
    id: string,
    repositoryName: string,
    config: EnvironmentConfig,
    removalPolicy: RemovalPolicy
  ): ecr.Repository {
    return new ecr.Repository(this, id, {
      repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.dataKey,
      emptyOnDelete: !config.production,
      lifecycleRules: [{maxImageCount: config.production ? 100 : 20}],
      removalPolicy
    });
  }

  private logRetention(days: EnvironmentConfig["logRetentionDays"]): logs.RetentionDays {
    const values = {
      30: logs.RetentionDays.ONE_MONTH,
      90: logs.RetentionDays.THREE_MONTHS,
      365: logs.RetentionDays.ONE_YEAR
    } as const;

    return values[days];
  }
}
