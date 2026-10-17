#!/usr/bin/env node

import {App, Tags, aws_lambda as lambda, aws_sqs as sqs} from "aws-cdk-lib";
import {readFileSync} from "node:fs";
import {analysisProfilesSha256, type AnalysisProfiles} from "../lib/analysis-runtime-stack.js";
import {WorkerControllerStack, type WorkerControllerStackProps} from "../lib/worker-controller-stack.js";
import {ApiServiceStack} from "../lib/api-service-stack.js";
import {ConnectionVerifierStack} from "../lib/connection-verifier-stack.js";
import {ObservableCoordinatorStack} from "../lib/observable-coordinator-stack.js";
import {GitHubBuildControllerStack} from "../lib/github-build-controller-stack.js";
import {FrameworkPublisherStack} from "../lib/framework-publisher-stack.js";
import {PrivateRuntimeEndpointsStack} from "../lib/private-runtime-endpoints-stack.js";
import {RepositoryObjectCopierStack} from "../lib/repository-object-copier-stack.js";
import {
  environmentConfig,
  parseBudgetAlertEmail,
  parseAdditionalUserPoolClientIds,
  parseFederationConfig,
  parseImageTagOrDigest,
  parseObservableBuilderImageDigest,
  parseStage,
  parseStorageBucketConfig,
  parseUserPoolClientId,
  parseWebOrigin,
  parseWorkerMaxTasks
} from "../lib/config.js";
import {
  PlatformFoundationStack,
  type ObservablePreviewEdgeConfiguration
} from "../lib/platform-foundation-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";
import {SourceArchiverStack} from "../lib/source-archiver-stack.js";
import {UserDatasetVerifierStack} from "../lib/user-dataset-verifier-stack.js";
import {WorkerServiceStack} from "../lib/worker-service-stack.js";
import {PmtilesQueueStack} from "../lib/pmtiles-queue-stack.js";

interface ObservablePreviewDeployment {
  readonly edge: ObservablePreviewEdgeConfiguration;
  readonly privateKeySecretArn: string;
}

const app = new App();
const stage = parseStage(
  process.env.OPEN_GEO_STAGE ?? app.node.tryGetContext("stage") ?? "dev"
);
const webOrigin = parseWebOrigin(
  process.env.OPEN_GEO_WEB_ORIGIN ?? app.node.tryGetContext("webOrigin"),
  stage
);
const storageBuckets = parseStorageBucketConfig(
  process.env.OPEN_GEO_APPLICATION_BUCKET
    ?? app.node.tryGetContext("applicationBucket"),
  process.env.OPEN_GEO_DATA_BUCKET
    ?? app.node.tryGetContext("dataBucket"),
  stage
);
const config = environmentConfig(
  stage,
  webOrigin,
  parseFederationConfig(process.env),
  storageBuckets
);
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const env = account && region ? {account, region} : undefined;
const budgetAlertEmail = parseBudgetAlertEmail(
  process.env.OPEN_GEO_BUDGET_ALERT_EMAIL ??
    app.node.tryGetContext("budgetAlertEmail")
);
const existingUserPoolClientValue =
  process.env.OPEN_GEO_EXISTING_USER_POOL_CLIENT_ID ??
  app.node.tryGetContext("existingUserPoolClientId");
const existingUserPoolClientId = existingUserPoolClientValue === undefined
  ? undefined
  : parseUserPoolClientId(existingUserPoolClientValue);
const additionalCognitoClientIds = parseAdditionalUserPoolClientIds(
  process.env.OPEN_GEO_COGNITO_ADDITIONAL_CLIENT_IDS
    ?? app.node.tryGetContext("additionalCognitoClientIds")
);
const existingBudgetName = boundedOptional(
  process.env.OPEN_GEO_EXISTING_BUDGET_NAME
    ?? app.node.tryGetContext("existingBudgetName"),
  "existing budget name",
  128
);
const observablePreview = observablePreviewConfiguration(app, account);
const kmlNetworkLinkFetchEnabled = optionalTrue(
  process.env.OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED
    ?? app.node.tryGetContext("kmlNetworkLinkFetchEnabled"),
  "KML NetworkLink fetch"
);
const portableArtifactsEnabled = optionalTrue(
  process.env.OPEN_GEO_PORTABLE_ARTIFACTS_ENABLED
    ?? app.node.tryGetContext("portableArtifactsEnabled"),
  "Portable Artifact storage"
);
const publicationArtifactBuildsEnabled = optionalTrue(
  process.env.OPEN_GEO_PUBLICATION_ARTIFACT_BUILDS_ENABLED
    ?? app.node.tryGetContext("publicationArtifactBuildsEnabled"),
  "Publication Artifact builds"
);

const stack = new PlatformFoundationStack(
  app,
  `OpenGeo-${stage}-Foundation`,
  {
    config,
    budgetAlertEmail,
    ...(existingBudgetName ? {existingBudgetName} : {}),
    ...(existingUserPoolClientId ? {existingUserPoolClientId} : {}),
    ...(observablePreview ? {observablePreview: observablePreview.edge} : {}),
    ...(env ? {env} : {})
  }
);

Tags.of(stack).add("Application", "OpenGeo");
Tags.of(stack).add("Environment", stage);
Tags.of(stack).add("ManagedBy", "aws-cdk");
Tags.of(stack).add("CostCenter", "opengeo-platform");

const pmtilesOnly = optionalTrue(
  process.env.OPEN_GEO_PMTILES_ONLY ?? app.node.tryGetContext("pmtilesOnly"), "PMTiles v2 worker"
);
const pmtilesQueues = pmtilesOnly
  ? new PmtilesQueueStack(app, `OpenGeo-${stage}-PmtilesQueue`, {config, ...(env ? {env} : {})})
  : undefined;

// Optional, concrete existing-resource manifest. Absent means no controller stack.
const workerControllerManifest = process.env.OPEN_GEO_WORKER_CONTROLLER_MANIFEST
  ?? app.node.tryGetContext("workerControllerManifest");
if (workerControllerManifest !== undefined) {
  const controllerProps = JSON.parse(readFileSync(workerControllerManifest, "utf8")) as WorkerControllerStackProps;
  if (controllerProps.configuration.runtime.stage !== stage) {
    throw new Error("Worker controller manifest stage differs from deployment stage");
  }
  new WorkerControllerStack(app, `OpenGeo-${stage}-WorkerController`, {
    ...controllerProps, enabled: optionalTrue(process.env.OPEN_GEO_WORKER_CONTROLLER_ENABLED
      ?? app.node.tryGetContext("workerControllerEnabled"), "worker controller"), ...(env ? {env} : {})
  });
}

const connectionVerifierImage =
  process.env.OPEN_GEO_CONNECTION_VERIFIER_IMAGE
  ?? app.node.tryGetContext("connectionVerifierImage");
const connectionVerifierStack = connectionVerifierImage === undefined
  ? undefined
  : new ConnectionVerifierStack(app, `OpenGeo-${stage}-ConnectionVerifier`, {
      config,
      foundation: stack,
      imageDigest: parseImageTagOrDigest(connectionVerifierImage),
      ...(env ? {env} : {})
    });
if (connectionVerifierStack !== undefined) {
  Tags.of(connectionVerifierStack).add("Application", "OpenGeo");
  Tags.of(connectionVerifierStack).add("Environment", stage);
  Tags.of(connectionVerifierStack).add("ManagedBy", "aws-cdk");
  Tags.of(connectionVerifierStack).add("CostCenter", "opengeo-connectors-active");
}
const connectionVerificationAdvertised = optionalTrue(
  process.env.OPEN_GEO_CONNECTION_VERIFICATION_ADVERTISED
    ?? app.node.tryGetContext("connectionVerificationAdvertised"),
  "connection verification advertisement"
);
if (connectionVerificationAdvertised && connectionVerifierStack === undefined) {
  throw new Error(
    "connection verification cannot be advertised without its dedicated runtime"
  );
}

const userDatasetVerifierImage =
  process.env.OPEN_GEO_USER_DATASET_VERIFIER_IMAGE
  ?? app.node.tryGetContext("userDatasetVerifierImage");
const userDatasetVerifierRoleArn = boundedOptional(
  process.env.OPEN_GEO_USER_DATASET_VERIFIER_ROLE_ARN
    ?? app.node.tryGetContext("userDatasetVerifierRoleArn"),
  "user dataset verifier role ARN",
  2048
);
if ((userDatasetVerifierImage === undefined) !== (userDatasetVerifierRoleArn === undefined)) {
  throw new Error(
    "user dataset verifier image and exact execution-role ARN must be supplied together"
  );
}
const userDatasetVerifierStack = userDatasetVerifierImage === undefined
  ? undefined
  : new UserDatasetVerifierStack(app, `OpenGeo-${stage}-UserDatasetVerifier`, {
      config,
      foundation: stack,
      imageDigest: parseImageTagOrDigest(userDatasetVerifierImage),
      executionRoleArn: userDatasetVerifierRoleArn!,
      ...(env ? {env} : {})
    });
if (userDatasetVerifierStack !== undefined) {
  Tags.of(userDatasetVerifierStack).add("Application", "OpenGeo");
  Tags.of(userDatasetVerifierStack).add("Environment", stage);
  Tags.of(userDatasetVerifierStack).add("ManagedBy", "aws-cdk");
  Tags.of(userDatasetVerifierStack).add("CostCenter", "opengeo-connectors-active");
}
const userDatasetVerificationAdvertised = optionalTrue(
  process.env.OPEN_GEO_USER_DATASET_VERIFICATION_ADVERTISED
    ?? app.node.tryGetContext("userDatasetVerificationAdvertised"),
  "user dataset verification advertisement"
);
if (userDatasetVerificationAdvertised && userDatasetVerifierStack === undefined) {
  throw new Error(
    "user dataset verification cannot be advertised without its dedicated runtime"
  );
}
const userDatasetRepositoryBrowserAdvertised = optionalTrue(
  process.env.OPEN_GEO_USER_DATASET_REPOSITORY_BROWSER_ADVERTISED
    ?? app.node.tryGetContext("userDatasetRepositoryBrowserAdvertised"),
  "user dataset repository browser advertisement"
);
if (userDatasetRepositoryBrowserAdvertised && userDatasetVerifierStack === undefined) {
  throw new Error(
    "user dataset repository browsing cannot be advertised without its dedicated runtime"
  );
}

const observableCoordinatorRunnerAmiId = boundedOptional(
  process.env.OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_ID
    ?? app.node.tryGetContext("observableCoordinatorRunnerAmiId"),
  "Observable coordinator runner AMI id",
  21
);
const workerImage = process.env.OPEN_GEO_WORKER_IMAGE ?? app.node.tryGetContext("workerImage");
const pmtilesWorkerImageDigest = process.env.OPEN_GEO_PMTILES_WORKER_IMAGE_DIGEST
  ?? app.node.tryGetContext("pmtilesWorkerImageDigest") ?? workerImage;
if (pmtilesOnly && workerImage !== undefined && pmtilesWorkerImageDigest !== undefined
  && parseImageTagOrDigest(workerImage) !== parseImageTagOrDigest(pmtilesWorkerImageDigest)) {
  throw new Error("PMTiles API and worker must use the same immutable image digest");
}
const githubControllerImage = process.env.OPEN_GEO_GITHUB_CONTROLLER_IMAGE ?? app.node.tryGetContext("githubControllerImage");
const githubAppSecretArn = process.env.OPEN_GEO_GITHUB_APP_SECRET_ARN ?? app.node.tryGetContext("githubAppSecretArn");
const githubAppSecretKeyArn = process.env.OPEN_GEO_GITHUB_APP_SECRET_KEY_ARN ?? app.node.tryGetContext("githubAppSecretKeyArn");
const githubBuildsEnabled = optionalTrue(process.env.OPEN_GEO_GITHUB_BUILDS_ENABLED ?? app.node.tryGetContext("githubBuildsEnabled"), "GitHub builds enablement");
if ((githubControllerImage === undefined) !== (githubAppSecretArn === undefined) ||
    (githubBuildsEnabled && githubControllerImage === undefined)) {
  throw new Error("GitHub builds require an exact controller image and approved App secret");
}
if (githubControllerImage !== undefined && observableCoordinatorRunnerAmiId !== undefined) {
  throw new Error("Choose GitHub execution or the private Observable coordinator, not both");
}
const githubBuildController = githubControllerImage === undefined ? undefined : new GitHubBuildControllerStack(app, `OpenGeo-${stage}-GitHubBuildController`, {
  config, foundation: stack, imageDigest: githubControllerImage, githubAppSecretArn,
  ...(githubAppSecretKeyArn ? {githubAppSecretKeyArn} : {}), enabled: githubBuildsEnabled,
  ...(env ? {env} : {})
});
const frameworkPublisherImage = process.env.OPEN_GEO_FRAMEWORK_PUBLISHER_IMAGE ?? app.node.tryGetContext("frameworkPublisherImage");
const frameworkPublisherSecret = process.env.OPEN_GEO_FRAMEWORK_PUBLISHER_DATABASE_SECRET_ARN ?? app.node.tryGetContext("frameworkPublisherDatabaseSecretArn");
const frameworkPublicBucket = process.env.OPEN_GEO_FRAMEWORK_PUBLICATION_PUBLIC_BUCKET ?? app.node.tryGetContext("frameworkPublicationPublicBucket");
const frameworkDistributionId = process.env.OPEN_GEO_FRAMEWORK_PUBLICATION_DISTRIBUTION_ID ?? app.node.tryGetContext("frameworkPublicationDistributionId");
const frameworkPublishingEnabled = optionalTrue(process.env.OPEN_GEO_FRAMEWORK_PUBLISHING_ENABLED ?? app.node.tryGetContext("frameworkPublishingEnabled"), "Framework publishing enablement");
const publicationInputs = [frameworkPublisherImage, frameworkPublisherSecret, frameworkPublicBucket, frameworkDistributionId];
if ((publicationInputs.some(value => value !== undefined) && publicationInputs.some(value => value === undefined)) ||
    (frameworkPublishingEnabled && frameworkPublisherImage === undefined)) {
  throw new Error("Framework publication needs an exact image, dedicated database credential, bucket and distribution");
}
const frameworkPublisher = frameworkPublisherImage === undefined ? undefined : new FrameworkPublisherStack(app, `OpenGeo-${stage}-FrameworkPublisher`, {
  config, foundation: stack, imageDigest: frameworkPublisherImage,
  publisherDatabaseSecretArn: frameworkPublisherSecret, publicBucket: frameworkPublicBucket,
  distributionId: frameworkDistributionId, enabled: frameworkPublishingEnabled,
  ...(env ? {env} : {})
});
const privateRuntimeEndpoints =
  observableCoordinatorRunnerAmiId === undefined && workerImage === undefined
    ? undefined
    : new PrivateRuntimeEndpointsStack(app, `OpenGeo-${stage}-PrivateRuntimeEndpoints`, {
        config,
        foundation: stack,
        enableWorker: workerImage !== undefined,
        enableObservableCoordinator: observableCoordinatorRunnerAmiId !== undefined,
        ...(env ? {env} : {})
      });
if (privateRuntimeEndpoints !== undefined) {
  Tags.of(privateRuntimeEndpoints).add("Application", "OpenGeo");
  Tags.of(privateRuntimeEndpoints).add("Environment", stage);
  Tags.of(privateRuntimeEndpoints).add("ManagedBy", "aws-cdk");
  Tags.of(privateRuntimeEndpoints).add("CostCenter", "opengeo-private-runtime-active");
}
const observableCoordinatorStack = observableCoordinatorRunnerAmiId === undefined
  ? undefined
  : new ObservableCoordinatorStack(app, `OpenGeo-${stage}-ObservableCoordinator`, {
      config,
      foundation: stack,
      runtimeEndpoints: privateRuntimeEndpoints!,
      runnerAmiId: observableCoordinatorRunnerAmiId,
      runnerAmiEvidenceSha256: requiredSha256(
        process.env.OPEN_GEO_OBSERVABLE_COORDINATOR_RUNNER_AMI_EVIDENCE_SHA256
          ?? app.node.tryGetContext("observableCoordinatorRunnerAmiEvidenceSha256"),
        "Observable coordinator runner AMI evidence"
      ),
      compilerImageDigest: parseObservableBuilderImageDigest(
        process.env.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST
          ?? app.node.tryGetContext("observableBuilderImageDigest")
      ),
      ...(env ? {env} : {})
    });
if (observableCoordinatorStack !== undefined) {
  Tags.of(observableCoordinatorStack).add("Application", "OpenGeo");
  Tags.of(observableCoordinatorStack).add("Environment", stage);
  Tags.of(observableCoordinatorStack).add("ManagedBy", "aws-cdk");
  Tags.of(observableCoordinatorStack).add("CostCenter", "opengeo-authoring-active");
}
const observableCoordinatorAdvertised = optionalTrue(
  process.env.OPEN_GEO_OBSERVABLE_COORDINATOR_ADVERTISED
    ?? app.node.tryGetContext("observableCoordinatorAdvertised"),
  "Observable coordinator advertisement"
);
if (observableCoordinatorAdvertised && observableCoordinatorStack === undefined) {
  throw new Error(
    "Observable build execution cannot be advertised without its dedicated coordinator"
  );
}

const apiImage = process.env.OPEN_GEO_API_IMAGE ?? app.node.tryGetContext("apiImage");
const repositoryObjectCopierImage =
  process.env.OPEN_GEO_REPOSITORY_OBJECT_COPIER_IMAGE
  ?? app.node.tryGetContext("repositoryObjectCopierImage");
const repositoryObjectCopierRoleArn = boundedOptional(
  process.env.OPEN_GEO_REPOSITORY_OBJECT_COPIER_ROLE_ARN
    ?? app.node.tryGetContext("repositoryObjectCopierRoleArn"),
  "repository object copier role ARN",
  2048
);
if ((repositoryObjectCopierImage === undefined)
  !== (repositoryObjectCopierRoleArn === undefined)) {
  throw new Error(
    "repository object copier image and exact execution-role ARN must be supplied together"
  );
}
const repositoryObjectCopierStack = repositoryObjectCopierImage === undefined
  ? undefined
  : new RepositoryObjectCopierStack(
      app,
      `OpenGeo-${stage}-RepositoryObjectCopier`,
      {
        config,
        foundation: stack,
        imageDigest: parseImageTagOrDigest(repositoryObjectCopierImage),
        executionRoleArn: repositoryObjectCopierRoleArn!,
        ...(env ? {env} : {})
      }
    );
if (repositoryObjectCopierStack !== undefined) {
  Tags.of(repositoryObjectCopierStack).add("Application", "OpenGeo");
  Tags.of(repositoryObjectCopierStack).add("Environment", stage);
  Tags.of(repositoryObjectCopierStack).add("ManagedBy", "aws-cdk");
  Tags.of(repositoryObjectCopierStack).add(
    "CostCenter",
    "opengeo-repository-copy-active"
  );
}
const repositoryObjectCopyAdvertised = optionalTrue(
  process.env.OPEN_GEO_REPOSITORY_OBJECT_COPY_ADVERTISED
    ?? app.node.tryGetContext("repositoryObjectCopyAdvertised"),
  "repository object copy advertisement"
);
if (repositoryObjectCopyAdvertised && repositoryObjectCopierStack === undefined) {
  throw new Error(
    "repository object copying cannot be advertised without its dedicated runtime"
  );
}
const sourceArchiverImage =
  process.env.OPEN_GEO_SOURCE_ARCHIVER_IMAGE
  ?? app.node.tryGetContext("sourceArchiverImage");
if (sourceArchiverImage !== undefined && apiImage === undefined) {
  throw new Error(
    "source archiving cannot be advertised without the request-driven API image"
  );
}
const sourceArchiverStack = sourceArchiverImage === undefined
  ? undefined
  : new SourceArchiverStack(app, `OpenGeo-${stage}-SourceArchiver`, {
      config,
      foundation: stack,
      imageDigest: parseImageTagOrDigest(sourceArchiverImage),
      ...(env ? {env} : {})
    });
if (sourceArchiverStack !== undefined) {
  Tags.of(sourceArchiverStack).add("Application", "OpenGeo");
  Tags.of(sourceArchiverStack).add("Environment", stage);
  Tags.of(sourceArchiverStack).add("ManagedBy", "aws-cdk");
  Tags.of(sourceArchiverStack).add("CostCenter", "opengeo-source-archiving-active");
}
if (kmlNetworkLinkFetchEnabled && apiImage === undefined) {
  throw new Error("KML NetworkLink fetch cannot be enabled without the request-driven API image");
}
if ((portableArtifactsEnabled || publicationArtifactBuildsEnabled) && apiImage === undefined) {
  throw new Error("Artifact activation requires the request-driven API image");
}
const managedAnalysisEnabled = optionalTrue(
  process.env.OPEN_GEO_ANALYSIS_ENABLED ?? app.node.tryGetContext("managedAnalysisEnabled"), "managed analysis"
);
if (managedAnalysisEnabled && apiImage === undefined) {
  throw new Error("Managed analysis requires the request-driven API image");
}
if (apiImage !== undefined) {
  const observableBuilderImageDigest = parseObservableBuilderImageDigest(
    process.env.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST
      ?? app.node.tryGetContext("observableBuilderImageDigest")
  );
  // Import admitted persistent identities only. This flag creates neither a
  // host nor its controller, and ordinary synthesis leaves analysis disabled.
  const analysisOptions = (() => {
    if (!managedAnalysisEnabled) return {};
    if (!env) throw new Error("Managed analysis requires a concrete deployment account and region");
    const queueArn = process.env.OPEN_GEO_ANALYSIS_QUEUE_ARN ?? app.node.tryGetContext("analysisQueueArn");
    const controllerArn = process.env.OPEN_GEO_ANALYSIS_CONTROLLER_FUNCTION_ARN
      ?? app.node.tryGetContext("analysisControllerFunctionArn");
    const rawProfiles = process.env.OPEN_GEO_ANALYSIS_RUNTIME_PROFILES
      ?? app.node.tryGetContext("analysisRuntimeProfiles");
    if (typeof queueArn !== "string" || !queueArn.startsWith(`arn:aws:sqs:${env.region}:${env.account}:`)
      || queueArn.split(":").length !== 6
      || !/^[A-Za-z0-9_-]{1,80}$/.test(queueArn.split(":").at(-1) ?? "")
      || controllerArn !== `arn:aws:lambda:${env.region}:${env.account}:function:opengeo-${stage}-analysis-controller`
      || typeof rawProfiles !== "string" || Buffer.byteLength(rawProfiles) > 8192) {
      throw new Error("Managed analysis requires its exact existing queue/controller and bounded operator profiles");
    }
    const profiles = JSON.parse(rawProfiles) as AnalysisProfiles;
    analysisProfilesSha256(profiles);
    return {enableManagedAnalysis: true,
      analysisQueue: sqs.Queue.fromQueueArn(stack, "ImportedAnalysisQueue", queueArn),
      analysisControllerFunction: lambda.Function.fromFunctionArn(stack, "ImportedAnalysisController", controllerArn),
      analysisRuntimeProfiles: profiles};
  })();
  const apiStack = new ServerlessApiStack(app, `OpenGeo-${stage}-Api`, {
    config,
    foundation: stack,
    imageDigest: parseImageTagOrDigest(apiImage),
    observableBuilderImageDigest,
    ...analysisOptions,
    ...(pmtilesQueues ? {pmtilesOnly: true, pmtilesDerivativeQueue: pmtilesQueues.queue,
      pmtilesWorkerImageDigest: pmtilesWorkerImageDigest === undefined
        ? undefined : parseImageTagOrDigest(pmtilesWorkerImageDigest),
      pmtilesInputFormats: process.env.OPEN_GEO_PMTILES_INPUT_FORMATS
        ?? app.node.tryGetContext("pmtilesInputFormats") ?? "geojson"} : {}),
    ...(additionalCognitoClientIds ? {additionalCognitoClientIds} : {}),
    enableKmlNetworkLinkFetch: kmlNetworkLinkFetchEnabled,
    enablePortableArtifacts: portableArtifactsEnabled,
    enablePublicationArtifactBuilds: publicationArtifactBuildsEnabled,
    ...(connectionVerificationAdvertised && connectionVerifierStack
      ? {connectionVerificationQueue: connectionVerifierStack.queue}
      : {}),
    ...(userDatasetVerificationAdvertised && userDatasetVerifierStack
      ? {userDatasetVerificationQueue: userDatasetVerifierStack.queue}
      : {}),
    ...(userDatasetRepositoryBrowserAdvertised && userDatasetVerifierStack
      ? {
          userDatasetRepositoryBrowserFunction:
            userDatasetVerifierStack.repositoryBrowserFunction
        }
      : {}),
    ...(sourceArchiverStack
      ? {sourceArchiverQueue: sourceArchiverStack.queue}
      : {}),
    ...(repositoryObjectCopyAdvertised && repositoryObjectCopierStack
      ? {repositoryObjectCopyQueue: repositoryObjectCopierStack.queue}
      : {}),
    ...(observableCoordinatorAdvertised && observableCoordinatorStack
      ? {observableBuildQueue: observableCoordinatorStack.queue}
      : {}),
    ...(githubBuildsEnabled && githubBuildController
      ? {observableBuildQueue: githubBuildController.queue, observableBuildProvider: "github" as const}
      : {}),
    ...(frameworkPublishingEnabled && frameworkPublisher
      ? {frameworkPublicationQueue: frameworkPublisher.queue} : {}),
    ...(observablePreview
      ? {observablePreviewPrivateKeySecretArn: observablePreview.privateKeySecretArn}
      : {}),
    ...(env ? {env} : {})
  });
  Tags.of(apiStack).add("Application", "OpenGeo");
  Tags.of(apiStack).add("Environment", stage);
  Tags.of(apiStack).add("ManagedBy", "aws-cdk");
  Tags.of(apiStack).add("CostCenter", "opengeo-platform");
}

const transitionalApiImage =
  process.env.OPEN_GEO_TRANSITIONAL_API_IMAGE ??
  app.node.tryGetContext("transitionalApiImage");
if (transitionalApiImage !== undefined) {
  const observableBuilderImageDigest = parseObservableBuilderImageDigest(
    process.env.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST
      ?? app.node.tryGetContext("observableBuilderImageDigest")
  );
  const transitionalApiStack = new ApiServiceStack(
    app,
    `OpenGeo-${stage}-TransitionalApi`,
    {
      config,
      foundation: stack,
      imageDigest: parseImageTagOrDigest(transitionalApiImage),
      observableBuilderImageDigest,
      ...(additionalCognitoClientIds ? {additionalCognitoClientIds} : {}),
      ...(connectionVerificationAdvertised && connectionVerifierStack
        ? {connectionVerificationQueue: connectionVerifierStack.queue}
        : {}),
      ...(userDatasetVerificationAdvertised && userDatasetVerifierStack
        ? {userDatasetVerificationQueue: userDatasetVerifierStack.queue}
        : {}),
      ...(sourceArchiverStack
        ? {sourceArchiverQueue: sourceArchiverStack.queue}
        : {}),
      ...(repositoryObjectCopyAdvertised && repositoryObjectCopierStack
        ? {repositoryObjectCopyQueue: repositoryObjectCopierStack.queue}
        : {}),
      ...(observableCoordinatorAdvertised && observableCoordinatorStack
        ? {observableBuildQueue: observableCoordinatorStack.queue}
        : {}),
      ...(githubBuildsEnabled && githubBuildController
        ? {observableBuildQueue: githubBuildController.queue, observableBuildProvider: "github" as const}
        : {}),
      ...(frameworkPublishingEnabled && frameworkPublisher
        ? {frameworkPublicationQueue: frameworkPublisher.queue} : {}),
      ...(observablePreview
        ? {observablePreviewPrivateKeySecretArn: observablePreview.privateKeySecretArn}
        : {}),
      ...(env ? {env} : {})
    }
  );
  Tags.of(transitionalApiStack).add("Application", "OpenGeo");
  Tags.of(transitionalApiStack).add("Environment", stage);
  Tags.of(transitionalApiStack).add("ManagedBy", "aws-cdk");
  Tags.of(transitionalApiStack).add("CostCenter", "opengeo-platform-transitional");
}

if (workerImage !== undefined) {
  const workerStack = new WorkerServiceStack(app, `OpenGeo-${stage}-Worker`, {
    ...(pmtilesQueues ? {workload: "pmtiles-v2" as const,
      processingQueue: pmtilesQueues.queue, processingDeadLetterQueue: pmtilesQueues.deadLetterQueue} : {}),
    config: {
      ...config,
      workerMaxTasks: parseWorkerMaxTasks(
        process.env.OPEN_GEO_WORKER_MAX_TASKS ?? app.node.tryGetContext("workerMaxTasks"),
        config.workerMaxTasks
      )
    },
    foundation: stack,
    runtimeEndpoints: privateRuntimeEndpoints!,
    imageDigest: parseImageTagOrDigest(workerImage),
    ...(env ? {env} : {})
  });
  Tags.of(workerStack).add("Application", "OpenGeo");
  Tags.of(workerStack).add("Environment", stage);
  Tags.of(workerStack).add("ManagedBy", "aws-cdk");
  Tags.of(workerStack).add("CostCenter", "opengeo-processing-active");
}

app.synth();

function observablePreviewConfiguration(
  app: App,
  account: string | undefined
): ObservablePreviewDeployment | undefined {
  const enablePublicMapsPreview = optionalTrue(
    process.env.OPEN_GEO_OBSERVABLE_PUBLIC_MAPS_PREVIEW_ENABLED
      ?? app.node.tryGetContext("observablePublicMapsPreviewEnabled"),
    "Observable public map preview"
  );
  const apiOriginDomain = boundedOptional(
    process.env.OPEN_GEO_OBSERVABLE_PREVIEW_API_ORIGIN_DOMAIN
      ?? app.node.tryGetContext("observablePreviewApiOriginDomain"),
    "Observable preview API origin",
    2048
  );
  const certificateArn = boundedOptional(
    process.env.OPEN_GEO_OBSERVABLE_PREVIEW_CERTIFICATE_ARN
      ?? app.node.tryGetContext("observablePreviewCertificateArn"),
    "Observable preview certificate ARN",
    2048
  );
  const publicKeyPem = boundedOptional(
    process.env.OPEN_GEO_OBSERVABLE_PREVIEW_PUBLIC_KEY_PEM
      ?? app.node.tryGetContext("observablePreviewPublicKeyPem"),
    "Observable preview public key PEM",
    8192
  );
  const webAclArn = boundedOptional(
    process.env.OPEN_GEO_OBSERVABLE_PREVIEW_WEB_ACL_ARN
      ?? app.node.tryGetContext("observablePreviewWebAclArn"),
    "Observable preview WAF ARN",
    2048
  );
  const privateKeySecretArn = boundedOptional(
    process.env.OPEN_GEO_OBSERVABLE_PREVIEW_PRIVATE_KEY_SECRET_ARN
      ?? app.node.tryGetContext("observablePreviewPrivateKeySecretArn"),
    "Observable preview private key secret ARN",
    2048
  );
  const required = [apiOriginDomain, certificateArn, publicKeyPem, privateKeySecretArn];
  if ([...required, webAclArn].every((value) => value === undefined) && !enablePublicMapsPreview) return undefined;
  if (required.some((value) => value === undefined)) {
    throw new Error(
      "Observable preview API origin, certificate ARN, public key PEM, and private-key secret ARN are required together"
    );
  }
  const secretMatch =
    /^arn:aws:secretsmanager:us-east-1:([0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+$/
      .exec(privateKeySecretArn!);
  if (secretMatch?.[1] === undefined
    || (account !== undefined && secretMatch[1] !== account)) {
    throw new Error(
      "Observable preview private key secret must be an exact same-account us-east-1 ARN"
    );
  }
  return {
    edge: {
      apiOriginDomain: apiOriginDomain!,
      certificateArn: certificateArn!,
      publicKeyPem: publicKeyPem!,
      ...(enablePublicMapsPreview ? {enablePublicMapsPreview} : {}),
      ...(webAclArn ? {webAclArn} : {})
    },
    privateKeySecretArn: privateKeySecretArn!
  };
}

function boundedOptional(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a bounded non-empty string when supplied`);
  }
  return value;
}

function optionalTrue(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (value !== "true") {
    throw new Error(`${label} must be exactly true when supplied`);
  }
  return true;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be one exact lowercase SHA-256`);
  }
  return value;
}
