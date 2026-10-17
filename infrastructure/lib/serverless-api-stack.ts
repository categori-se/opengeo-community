import {
  ArnFormat,
  CfnOutput,
  Duration,
  Size,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_integrations as integrations,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import {RegionInfo} from "aws-cdk-lib/region-info";
import {analysisProfilesSha256, type AnalysisProfiles} from "./analysis-runtime-stack.js";
import {parseAdditionalUserPoolClientIds, type EnvironmentConfig} from "./config.js";
import type {PlatformFoundationStack} from "./platform-foundation-stack.js";

export interface ServerlessApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly foundation: PlatformFoundationStack;
  readonly imageDigest: string;
  readonly observableBuilderImageDigest: string;
  readonly additionalCognitoClientIds?: string;
  readonly observablePreviewPrivateKeySecretArn?: string;
  readonly connectionVerificationQueue?: sqs.IQueue;
  readonly connectionVerificationFunction?: lambda.IFunction;
  readonly enableConnectionCatalogDiscovery?: boolean;
  readonly enablePostgisPreview?: boolean;
  readonly userDatasetVerificationQueue?: sqs.IQueue;
  readonly userDatasetRepositoryBrowserFunction?: lambda.IFunction;
  readonly sourceArchiverQueue?: sqs.IQueue;
  readonly repositoryObjectCopyQueue?: sqs.IQueue;
  readonly observableBuildQueue?: sqs.IQueue;
  readonly frameworkPublicationQueue?: sqs.IQueue;
  readonly pmtilesDerivativeQueue?: sqs.IQueue;
  readonly pmtilesOnly?: boolean;
  readonly pmtilesWorkerImageDigest?: string;
  readonly pmtilesInputFormats?: string;
  readonly enableManagedAnalysis?: boolean;
  readonly analysisQueue?: sqs.IQueue;
  readonly analysisControllerFunction?: lambda.IFunction;
  readonly analysisRuntimeProfiles?: AnalysisProfiles;
  readonly observableBuildProvider?: "private_worker" | "github";
  readonly enableKmlNetworkLinkFetch?: boolean;
  readonly enablePortableArtifacts?: boolean;
  readonly enablePublicationArtifactBuilds?: boolean;
}

export class ServerlessApiStack extends Stack {
  readonly apiFunction: lambda.DockerImageFunction;
  readonly httpApi: apigateway.HttpApi;

  constructor(scope: Construct, id: string, props: ServerlessApiStackProps) {
    super(scope, id, props);

    const {config, foundation, imageDigest} = props;
    if (props.enableManagedAnalysis === true) {
      if (!props.analysisQueue || !props.analysisControllerFunction || !props.analysisRuntimeProfiles) {
        throw new Error("Managed analysis requires its isolated queue, controller and complete runtime profiles");
      }
      const otherQueues = [foundation.processingQueue, props.connectionVerificationQueue,
        props.userDatasetVerificationQueue, props.sourceArchiverQueue, props.repositoryObjectCopyQueue,
        props.observableBuildQueue, props.frameworkPublicationQueue, props.pmtilesDerivativeQueue];
      if (otherQueues.some(queue => queue?.queueArn === props.analysisQueue!.queueArn)) {
        throw new Error("Managed analysis requires a separate analysis-only queue");
      }
      // formatArn retains AWS::Partition as a token, while the explicitly
      // imported controller ARN is concrete. Resolve its regional partition.
      const controllerArn = `arn:${RegionInfo.get(this.region).partition}:lambda:${this.region}:${this.account}`
        + `:function:opengeo-${config.stage}-analysis-controller`;
      if (props.analysisControllerFunction.functionArn !== controllerArn) {
        throw new Error("Managed analysis requires the exact same-account regional analysis controller");
      }
      analysisProfilesSha256(props.analysisRuntimeProfiles);
    }
    if (props.pmtilesOnly && (!props.pmtilesDerivativeQueue
      || !/^sha256:[0-9a-f]{64}$/.test(props.pmtilesWorkerImageDigest ?? "")
      || props.pmtilesDerivativeQueue.queueArn === foundation.processingQueue.queueArn)) {
      throw new Error("PMTiles v2 requires an isolated queue and immutable worker image digest");
    }
    if (props.enablePostgisPreview && !props.connectionVerificationFunction) {
      throw new Error("PostGIS preview requires the existing connection verifier function");
    }
    if (props.enableConnectionCatalogDiscovery && !props.connectionVerificationQueue) {
      throw new Error("Connection catalog discovery requires the existing verifier queue");
    }
    // The application bucket can be an existing, operator-owned bucket. Keep
    // its API references as concrete configuration values so an API-only
    // release does not require a new cross-stack export from an older
    // Foundation deployment.
    const applicationBucketName = config.storageBuckets.application;
    const applicationBucketArn = `arn:${this.partition}:s3:::${applicationBucketName}`;
    if (props.enablePortableArtifacts && this.region !== "us-east-1") {
      throw new Error("Portable Artifacts require application storage in us-east-1");
    }
    if (props.enablePublicationArtifactBuilds &&
        (!props.enablePortableArtifacts || !props.observableBuildQueue)) {
      throw new Error("Publication Artifact builds require portable storage and a configured build queue");
    }
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
    const runtimeDatabaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedRuntimeDatabaseSecret",
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
    const apiExecutionRole = new iam.Role(this, "ApiExecutionRole", {
      roleName: `opengeo-${config.stage}-api-runtime`,
      description: "Least-privilege runtime identity for the request-driven OpenGeo API",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com")
    });
    apiExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [this.formatArn({
        service: "logs",
        resource: "log-group",
        resourceName: `/opengeo/${config.stage}/api:log-stream:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME
      })]
    }));

    this.apiFunction = new lambda.DockerImageFunction(this, "ApiFunction", {
      functionName: `opengeo-${config.stage}-api`,
      description: "OpenGeo request-driven API; no provisioned compute or VPC attachment",
      code: lambda.DockerImageCode.fromEcr(apiRepository, {
        tagOrDigest: imageDigest
      }),
      architecture: lambda.Architecture.ARM_64,
      // More request-time CPU reduces the measured production cold-start delay;
      // provisioned concurrency remains disabled, so this adds no idle compute.
      memorySize: config.stage === "production" ? 2048 : 1024,
      ephemeralStorageSize: Size.mebibytes(512),
      timeout: Duration.seconds(29),
      role: apiExecutionRole,
      reservedConcurrentExecutions:
        config.stage === "production" ? 64 : config.stage === "staging" ? 16 : 4,
      logGroup: apiLogGroup,
      environment: {
        // The API runtime has deployment modes for security behavior rather
        // than infrastructure labels. The separately addressed demo is a
        // production-grade managed deployment with smaller capacity limits.
        OPEN_GEO_ENV: config.stage === "demo" ? "production" : config.stage,
        OPEN_GEO_EXPOSE_DOCS: "false",
        OPEN_GEO_LOG_LEVEL: "INFO",
        OPEN_GEO_COGNITO_CLIENT_ID: foundation.userPoolClient.userPoolClientId,
        ...(additionalCognitoClientIds
          ? {OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS: additionalCognitoClientIds}
          : {}),
        OPEN_GEO_COGNITO_REGION: foundation.cognitoRegion,
        OPEN_GEO_COGNITO_USER_POOL_ID: foundation.userPool.userPoolId,
        OPEN_GEO_COGNITO_PROVISIONING_ENABLED:
          foundation.identityProvisioningEnabled ? "true" : "false",
        OPEN_GEO_AWS_REGION: this.region,
        OPEN_GEO_APPLICATION_BUCKET: applicationBucketName,
        OPEN_GEO_ARTIFACT_VIEW_ORIGIN: config.webOrigin,
        ...(props.enablePortableArtifacts
          ? {OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED: "true"} : {}),
        ...(props.enablePublicationArtifactBuilds
          ? {OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED: "true"} : {}),
        OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED:
          props.enableKmlNetworkLinkFetch === true ? "true" : "false",
        OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST: props.observableBuilderImageDigest,
        OPEN_GEO_OBSERVABLE_BUILD_PROVIDER: props.observableBuildProvider ?? "private_worker",
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
        ...(props.pmtilesOnly ? {OPEN_GEO_WORKER_PROCESSING_MODE: "pmtiles-v2"} : {}),
        ...(props.pmtilesWorkerImageDigest
          ? {OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST: props.pmtilesWorkerImageDigest} : {}),
        ...(props.pmtilesOnly
          ? {OPEN_GEO_PMTILES_INPUT_FORMATS: props.pmtilesInputFormats ?? "geojson"} : {}),
        ...(props.pmtilesDerivativeQueue
          ? {OPEN_GEO_PMTILES_DERIVATIVE_QUEUE_URL: props.pmtilesDerivativeQueue.queueUrl} : {}),
        ...(props.enableManagedAnalysis === true
          ? {OPEN_GEO_ANALYSIS_ENABLED: "true", OPEN_GEO_ANALYSIS_QUEUE_URL: props.analysisQueue!.queueUrl,
            OPEN_GEO_ANALYSIS_CONTROLLER_FUNCTION_ARN: props.analysisControllerFunction!.functionArn,
            OPEN_GEO_ANALYSIS_RUNTIME_PROFILES: JSON.stringify(props.analysisRuntimeProfiles!)} : {}),
        ...(props.connectionVerificationQueue
          ? {
              OPEN_GEO_CONNECTION_VERIFICATION_QUEUE_URL:
                props.connectionVerificationQueue.queueUrl
            }
          : {}),
        ...(props.enableConnectionCatalogDiscovery
          ? {OPEN_GEO_CONNECTION_CATALOG_DISCOVERY_ENABLED: "true"} : {}),
        ...(props.enablePostgisPreview && props.connectionVerificationFunction
          ? {OPEN_GEO_CONNECTION_POSTGIS_PREVIEW_ENABLED: "true",
             OPEN_GEO_CONNECTION_VERIFICATION_FUNCTION_NAME: props.connectionVerificationFunction.functionName} : {}),
        ...(props.userDatasetVerificationQueue
          ? {
              OPEN_GEO_USER_DATASET_VERIFICATION_QUEUE_URL:
                props.userDatasetVerificationQueue.queueUrl
            }
          : {}),
        ...(props.userDatasetRepositoryBrowserFunction
          ? {
              OPEN_GEO_USER_DATASET_REPOSITORY_BROWSER_FUNCTION_NAME:
                props.userDatasetRepositoryBrowserFunction.functionName
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
        ...(props.observableBuildQueue
          ? {OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL: props.observableBuildQueue.queueUrl}
          : {}),
        ...(props.frameworkPublicationQueue
          ? {OPEN_GEO_FRAMEWORK_PUBLICATION_QUEUE_URL: props.frameworkPublicationQueue.queueUrl}
          : {}),
        OPEN_GEO_WMS_SYNC_WAIT_SECONDS: "8",
        OPEN_GEO_WMS_SYNC_POLL_SECONDS: "0.25",
        OPEN_GEO_DATA_API_REGION: this.region,
        OPEN_GEO_DATA_API_CLUSTER_ARN: foundation.database.clusterArn,
        OPEN_GEO_DATA_API_SECRET_ARN: runtimeDatabaseSecret.secretArn,
        OPEN_GEO_DB_NAME: "opengeo"
      }
    });

    if (!props.pmtilesOnly) this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [foundation.processingQueue.queueArn]
      })
    );
    props.pmtilesDerivativeQueue?.grantSendMessages(this.apiFunction);
    if (props.enableManagedAnalysis === true) {
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({actions: ["sqs:SendMessage"],
        resources: [props.analysisQueue!.queueArn]}));
      // Invoke only this unqualified controller; its own role owns activation.
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({actions: ["lambda:InvokeFunction"],
        resources: [props.analysisControllerFunction!.functionArn]}));
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({actions: ["s3:PutObject", "s3:GetObject"],
        resources: [`${applicationBucketArn}/organizations/*/projects/*/analysis/*/snapshot.json`]}));
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({actions: ["s3:GetObjectVersion"],
        resources: [`${applicationBucketArn}/organizations/*/projects/*/analysis/*/result.json`]}));
    }
    if (props.connectionVerificationQueue !== undefined) {
      props.connectionVerificationQueue.grantSendMessages(this.apiFunction);
    }
    if (props.enablePostgisPreview && props.connectionVerificationFunction) {
      props.connectionVerificationFunction.grantInvoke(this.apiFunction);
    }
    if (props.userDatasetVerificationQueue !== undefined) {
      props.userDatasetVerificationQueue.grantSendMessages(this.apiFunction);
    }
    if (props.userDatasetRepositoryBrowserFunction !== undefined) {
      props.userDatasetRepositoryBrowserFunction.grantInvoke(this.apiFunction);
    }
    if (props.sourceArchiverQueue !== undefined) {
      props.sourceArchiverQueue.grantSendMessages(this.apiFunction);
    }
    if (props.repositoryObjectCopyQueue !== undefined) {
      props.repositoryObjectCopyQueue.grantSendMessages(this.apiFunction);
    }
    if (props.observableBuildQueue !== undefined) {
      props.observableBuildQueue.grantSendMessages(this.apiFunction);
    }
    props.frameworkPublicationQueue?.grantSendMessages(this.apiFunction);
    if (props.enablePortableArtifacts) {
      const artifactKey = "organizations/*/projects/*/artifacts/*/uploads/*/map.html";
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObjectVersion"],
        resources: [`${applicationBucketArn}/${artifactKey}`]
      }));
      // Cleanup enumerates one exact intent key, then deletes only unretained
      // versions. The repository reauthorizes and checks references before I/O.
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["s3:ListBucketVersions"],
        resources: [applicationBucketArn],
        conditions: {StringLike: {"s3:prefix": artifactKey}}
      }));
    }
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: [
          `${applicationBucketArn}/organizations/*/projects/*/pages/*/versions/*/uploads/*/source.md`,
          `${applicationBucketArn}/organizations/*/projects/*/source-projects/*/uploads/*/files/*`
        ]
      })
    );
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:BeginTransaction",
          "rds-data:ExecuteStatement",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction"
        ],
        resources: [foundation.database.clusterArn]
      })
    );
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `s3.${this.region}.amazonaws.com`,
            "kms:EncryptionContext:aws:s3:arn":
              applicationBucketArn
          }
        }
      })
    );
    runtimeDatabaseSecret.grantRead(this.apiFunction);
    this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource", "secretsmanager:DeleteSecret"],
      resources: [connectionSecretArn, userConnectionSecretArn, browserConnectionSecretArn]
    }));
    this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [browserConnectionSecretArn]
    }));
    this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
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
    if (props.observablePreviewPrivateKeySecretArn !== undefined) {
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.observablePreviewPrivateKeySecretArn]
      }));
      this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
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
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [foundation.dataKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
            "kms:EncryptionContext:SecretARN": runtimeDatabaseSecret.secretArn
          }
        }
      })
    );
    if (foundation.identityProvisioningEnabled) {
      this.apiFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
          resources: [foundation.userPool.userPoolArn]
        })
      );
    }
    this.apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          foundation.geodataBucket.arnForObjects(
            "organizations/*/projects/*/datasets/*/uploads/*"
          )
        ]
      })
    );
    this.apiFunction.addToRolePolicy(
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
    this.apiFunction.addToRolePolicy(
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

    const integration = new integrations.HttpLambdaIntegration(
      "DefaultIntegration",
      this.apiFunction,
      {payloadFormatVersion: apigateway.PayloadFormatVersion.VERSION_2_0}
    );
    this.httpApi = new apigateway.HttpApi(this, "HttpApi", {
      apiName: `opengeo-${config.stage}-api`,
      description: "OpenGeo request-driven HTTP API",
      defaultIntegration: integration,
      createDefaultStage: true,
      corsPreflight: {
        // Public map and Collection modules support imports from arbitrary sites.
        // CORS grants no access: private routes retain bearer and tenant checks.
        // Keep credentials disabled; the Studio API client also omits cookies.
        allowOrigins: ["*"],
        allowMethods: [
          apigateway.CorsHttpMethod.GET,
          apigateway.CorsHttpMethod.POST,
          apigateway.CorsHttpMethod.PATCH,
          apigateway.CorsHttpMethod.PUT,
          apigateway.CorsHttpMethod.DELETE,
          apigateway.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "X-OpenGeo-Organization",
          "X-Request-ID"
        ],
        exposeHeaders: [
          "X-Request-ID",
          "X-OpenGeo-Source-Sha256",
          "X-OpenGeo-Discovery-Job-Id"
        ],
        maxAge: Duration.hours(1)
      }
    });
    const kmlNetworkLinkRoutes = props.enableKmlNetworkLinkFetch === true
      ? this.httpApi.addRoutes({
        path: "/projects/{project_id}/kml-network-links/refresh",
        methods: [apigateway.HttpMethod.POST],
        integration
      })
      : [];
    const defaultStage = this.httpApi.defaultStage;
    if (defaultStage === undefined) {
      throw new Error("the request-driven API must have a default stage");
    }
    const defaultStageResource = defaultStage.node.defaultChild;
    if (!(defaultStageResource instanceof apigateway.CfnStage)) {
      throw new Error("the request-driven API default stage must be an API Gateway v2 stage");
    }
    defaultStageResource.defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit: 25
    };
    if (props.enableKmlNetworkLinkFetch === true) {
      const routeResource = kmlNetworkLinkRoutes[0]?.node.defaultChild;
      if (!(routeResource instanceof apigateway.CfnRoute)) {
        throw new Error("the NetworkLink route must synthesize to one API Gateway route");
      }
      // API Gateway rejects route-specific stage settings until the route
      // exists. This dependency also reverses deletion order so disabling the
      // capability removes the settings before deleting the route.
      defaultStageResource.addResourceDependency(routeResource);
      defaultStageResource.addPropertyOverride("RouteSettings", {
        "POST /projects/{project_id}/kml-network-links/refresh": {
          ThrottlingBurstLimit: 4,
          ThrottlingRateLimit: 1
        }
      });
    }

    new CfnOutput(this, "ApiEndpoint", {
      value: this.httpApi.apiEndpoint,
      description: "Request-driven public API endpoint; application authorization still applies."
    });
    new CfnOutput(this, "ApiFunctionName", {
      value: this.apiFunction.functionName
    });
  }
}
