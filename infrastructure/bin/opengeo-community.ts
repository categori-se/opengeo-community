#!/usr/bin/env node

import {App, CfnOutput, Fn, Tags} from "aws-cdk-lib";
import {environmentConfig, parseBudgetAlertEmail, parseImageTagOrDigest} from "../lib/config.js";
import {PlatformFoundationStack} from "../lib/platform-foundation-stack.js";
import {PrivateRuntimeEndpointsStack} from "../lib/private-runtime-endpoints-stack.js";
import {ServerlessApiStack} from "../lib/serverless-api-stack.js";
import {StudioWebStack} from "../lib/studio-web-stack.js";
import {WorkerServiceStack} from "../lib/worker-service-stack.js";
import {FrameworkPublisherStack, type PublicationDestination} from "../lib/framework-publisher-stack.js";

// This profile reuses the maintained platform stacks with account-local identity
// and storage. Deploy Web first, then use its concrete CloudFront URL as the
// Foundation callback origin. API forwarding is attached after the API exists;
// keeping those values concrete avoids a Foundation -> Web -> API cycle.
const app = new App();
const account = process.env.OPEN_GEO_COMMUNITY_ACCOUNT;
const region = process.env.OPEN_GEO_COMMUNITY_REGION ?? "us-east-1";
const name = process.env.OPEN_GEO_COMMUNITY_NAME;
if (!account || !/^[0-9]{12}$/.test(account)) {
  throw new Error("OPEN_GEO_COMMUNITY_ACCOUNT must explicitly identify your 12-digit AWS account");
}
if (region !== "us-east-1") {
  throw new Error("The initial community deployment profile supports us-east-1");
}
if (!name || !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
  throw new Error("OPEN_GEO_COMMUNITY_NAME must be a 3-32 character lowercase DNS label");
}
if (process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_ACCOUNT !== account) {
  throw new Error("CDK credentials do not match OPEN_GEO_COMMUNITY_ACCOUNT");
}
if (process.env.CDK_DEFAULT_REGION && process.env.CDK_DEFAULT_REGION !== region) {
  throw new Error("CDK region does not match OPEN_GEO_COMMUNITY_REGION");
}
const env = {account, region};
const availabilityZones = [Fn.select(0, Fn.getAzs(region)), Fn.select(1, Fn.getAzs(region))];
// Some downstream constructs consult Stack.availabilityZones even with explicit
// VPC subnets. Keep that context intrinsic too, so synthesis never needs account
// lookups and the generated template resolves the AZ names at deployment.
app.node.setContext(`availability-zones:account=${account}:region=${region}`, availabilityZones);
const stem = `OpenGeoCommunity-${name}`;
const webOrigin = process.env.OPEN_GEO_COMMUNITY_WEB_ORIGIN;
const certificateArn = process.env.OPEN_GEO_COMMUNITY_CERTIFICATE_ARN;
const releaseOriginPath = process.env.OPEN_GEO_COMMUNITY_RELEASE_ORIGIN_PATH;
const apiOriginDomain = process.env.OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN;
const apiImage = process.env.OPEN_GEO_API_IMAGE;
const compilerImage = process.env.OPEN_GEO_OBSERVABLE_BUILDER_IMAGE_DIGEST;
const nativePreview = previewConfiguration(process.env.OPEN_GEO_COMMUNITY_PREVIEW_CONFIG, account);
const publicationRaw = process.env.OPEN_GEO_COMMUNITY_PUBLICATION_CONFIG;
if (nativePreview !== undefined || publicationRaw !== undefined) {
  if (webOrigin === undefined || !apiOriginDomain ||
      !/^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/.test(apiOriginDomain) ||
      apiImage === undefined || compilerImage === undefined) {
    throw new Error(`Community ${nativePreview !== undefined ? "preview" : "publication"} requires existing concrete Studio/API origins and both immutable runtime images`);
  }
  parseImageTagOrDigest(apiImage);
  parseImageTagOrDigest(compilerImage);
}
let hostname = `${name}.community.invalid`;
if (webOrigin !== undefined) {
  let url: URL;
  try { url = new URL(webOrigin); } catch { throw new Error("Community web origin must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.origin !== webOrigin || url.port || url.username || url.password) {
    throw new Error("Community web origin must be an exact HTTPS origin without credentials, port or path");
  }
  hostname = url.hostname;
  if (!/^d[a-z0-9]{5,30}\.cloudfront\.net$/.test(hostname) && !certificateArn) {
    throw new Error("A custom community hostname requires your us-east-1 ACM certificate; bootstrap with the CloudFront URL first");
  }
}
const [dnsRecordHost, ...zoneParts] = hostname.split(".");
const protectedPublicationHosts = [...new Set([hostname, apiOriginDomain,
  nativePreview?.domainName, nativePreview?.publicMapsDomainName]
  .filter((value): value is string => value !== undefined))];
const nativePublication = publicationConfiguration(publicationRaw, account, {
  distributionId: process.env.OPEN_GEO_COMMUNITY_WEB_DISTRIBUTION_ID,
  protectedHosts: protectedPublicationHosts,
  protectedBuckets: [
    `${name}-${account}-${region}-app`, `${name}-${account}-${region}-data`,
    `${name}-${account}-${region}-studio`, `${name}-${account}-preview-shell`
  ]
});
new StudioWebStack(app, `${stem}-Web`, {
  env,
  communityDeployment: true,
  domainName: hostname,
  bucketName: `${name}-${account}-${region}-studio`,
  resourceNamePrefix: `og-${name}`,
  dnsRecordHost,
  dnsZone: zoneParts.join("."),
  ...(certificateArn ? {certificateArn} : {}),
  ...(releaseOriginPath ? {releaseOriginPath} : {}),
  ...(apiOriginDomain ? {apiOriginDomain} : {}),
  ...(nativePreview ? {independentPreviewOrigins: [`https://${nativePreview.domainName}`,
    ...(nativePreview.publicMapsDomainName ? [`https://${nativePreview.publicMapsDomainName}`] : [])]} : {})
});

if (webOrigin !== undefined) {
  const config = {
    ...environmentConfig("dev", webOrigin, {}, {
      application: `${name}-${account}-${region}-app`,
      data: `${name}-${account}-${region}-data`
    }),
    allowedWebOrigins: [webOrigin],
    // Preserve data while retaining development capacity and auto-pause limits.
    deletionProtection: true
  };
  const foundation = new PlatformFoundationStack(app, `${stem}-Foundation`, {
    env, config,
    budgetAlertEmail: parseBudgetAlertEmail(process.env.OPEN_GEO_BUDGET_ALERT_EMAIL),
    standaloneAuthDomainPrefix: `${name}-${account}`,
    availabilityZones,
    retainData: true,
    ...(nativePreview ? {observablePreview: {
      apiOriginDomain: apiOriginDomain!, certificateArn: nativePreview.certificateArn,
      publicKeyPem: nativePreview.publicKeyPem, deployShell: false,
      enablePublicMapsPreview: nativePreview.publicMapsDomainName !== undefined,
      independentDeployment: {
        previewDomainName: nativePreview.domainName, studioOrigin: webOrigin,
        shellBucketName: `${name}-${account}-preview-shell`, resourceNamePrefix: `og-${name}-preview`,
        ...(nativePreview.publicMapsDomainName ? {publicMapsPreviewDomainName: nativePreview.publicMapsDomainName} : {})
      }
    }} : {})
  });
  if (foundation.observablePreviewEdge !== undefined) {
    new CfnOutput(foundation, "CommunityPreviewShellBucketName", {
      value: foundation.observablePreviewEdge.shellBucket.bucketName
    });
    new CfnOutput(foundation, "CommunityPreviewOrigin", {
      value: foundation.observablePreviewEdge.previewOrigin
    });
  }
  if ((apiImage === undefined) !== (compilerImage === undefined)) {
    throw new Error("Community API and Observable builder immutable digests must be supplied together");
  }
  const publisher = nativePublication === undefined ? undefined : new FrameworkPublisherStack(app, `${stem}-FrameworkPublisher`, {
    env, config, foundation, imageDigest: parseImageTagOrDigest(apiImage),
    publisherDatabaseSecretArn: nativePublication.publisherDatabaseSecretArn,
    publicBucket: nativePublication.destinations[0]!.bucket,
    distributionId: nativePublication.destinations[0]!.distribution_id,
    destinations: nativePublication.destinations, protectedHosts: protectedPublicationHosts,
    resourceNamePrefix: `og-${name}`, enabled: nativePublication.enabled === true
  });
  if (publisher !== undefined) {
    // Keep exports while disabling the publisher before the API drops its imports.
    publisher.exportValue(publisher.queue.queueArn);
    publisher.exportValue(publisher.queue.queueUrl);
  }
  if (apiImage !== undefined) {
    new ServerlessApiStack(app, `${stem}-Api`, {
      env, config, foundation,
      imageDigest: parseImageTagOrDigest(apiImage),
      observableBuilderImageDigest: parseImageTagOrDigest(compilerImage),
      ...(nativePublication?.enabled === true && publisher ? {frameworkPublicationQueue: publisher.queue} : {}),
      ...(nativePreview ? {observablePreviewPrivateKeySecretArn: nativePreview.privateKeySecretArn} : {})
    });
  }
  const workerImage = process.env.OPEN_GEO_WORKER_IMAGE;
  if (workerImage !== undefined) {
    const endpoints = new PrivateRuntimeEndpointsStack(app, `${stem}-PrivateRuntimeEndpoints`, {
      env, config, foundation, enableWorker: true, enableObservableCoordinator: false
    });
    new WorkerServiceStack(app, `${stem}-Worker`, {
      env, config: {...config, workerMaxTasks: 1}, foundation,
      runtimeEndpoints: endpoints, imageDigest: parseImageTagOrDigest(workerImage)
    });
  }
} else if ([process.env.OPEN_GEO_API_IMAGE, process.env.OPEN_GEO_WORKER_IMAGE,
  process.env.OPEN_GEO_COMMUNITY_API_ORIGIN_DOMAIN, certificateArn].some(value => value !== undefined)) {
  throw new Error("Runtime and custom-domain configuration requires OPEN_GEO_COMMUNITY_WEB_ORIGIN");
}

Tags.of(app).add("Application", "OpenGeoCommunity");
Tags.of(app).add("CommunityDeployment", name);
Tags.of(app).add("ManagedBy", "aws-cdk");
app.synth();

interface CommunityPreviewConfiguration {
  readonly domainName: string;
  readonly certificateArn: string;
  readonly publicKeyPem: string;
  readonly privateKeySecretArn: string;
  readonly publicMapsDomainName?: string;
}

function previewConfiguration(raw: string | undefined, deploymentAccount: string): CommunityPreviewConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw) > 16_384) throw new Error("Community preview configuration exceeds its bound");
  let value: CommunityPreviewConfiguration;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Community preview configuration must be a closed JSON object"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !["certificateArn,domainName,privateKeySecretArn,publicKeyPem",
        "certificateArn,domainName,privateKeySecretArn,publicKeyPem,publicMapsDomainName"]
        .includes(Object.keys(value).sort().join(",")) ||
      Object.values(value).some(item => typeof item !== "string" || item.length < 1)) {
    throw new Error("Community preview configuration must be a closed JSON object");
  }
  const certificateAccount = /^arn:aws:acm:us-east-1:([0-9]{12}):certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value.certificateArn)?.[1];
  const secretAccount = /^arn:aws:secretsmanager:us-east-1:([0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/.exec(value.privateKeySecretArn)?.[1];
  if (certificateAccount !== deploymentAccount || secretAccount !== deploymentAccount) {
    throw new Error("Community preview certificate and private-key secret must be exact same-account us-east-1 ARNs with a complete secret suffix");
  }
  if (value.publicKeyPem.length > 8192 ||
      !/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END (?:RSA )?PUBLIC KEY-----\r?\n$/.test(value.publicKeyPem)) {
    throw new Error("Community preview configuration accepts only a public-key PEM, never private key material");
  }
  return value;
}

interface CommunityPublicationConfiguration {
  readonly publisherDatabaseSecretArn: string;
  readonly destinations: readonly PublicationDestination[];
  readonly enabled?: boolean;
}

function publicationConfiguration(raw: string | undefined, deploymentAccount: string, boundary: {
  distributionId: string | undefined;
  protectedHosts: readonly string[];
  protectedBuckets: readonly string[];
}): CommunityPublicationConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw) > 16_384) throw new Error("Community publication configuration exceeds its bound");
  let value: CommunityPublicationConfiguration;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Community publication configuration must be a closed JSON object"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !["destinations,publisherDatabaseSecretArn", "destinations,enabled,publisherDatabaseSecretArn"]
        .includes(Object.keys(value).sort().join(",")) ||
      typeof value.publisherDatabaseSecretArn !== "string" ||
      ("enabled" in value && typeof value.enabled !== "boolean")) {
    throw new Error("Community publication configuration must be a closed JSON object");
  }
  if (!new RegExp(`^arn:aws:secretsmanager:us-east-1:${deploymentAccount}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`)
      .test(value.publisherDatabaseSecretArn)) {
    throw new Error("Community publisher credential must be a complete same-account us-east-1 secret ARN with a complete secret suffix");
  }
  if (!/^[A-Z0-9]{1,32}$/.test(boundary.distributionId ?? "")) {
    throw new Error("Community publication requires the retained concrete Studio distribution ID");
  }
  const targets = value.destinations;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 12 ||
      targets.some(target => target === null || typeof target !== "object" || Array.isArray(target) ||
        !["bucket,distribution_id,hostname,origin_id", "bucket,distribution_id,hostname,origin_access_control_id,origin_id"]
          .includes(Object.keys(target).sort().join(",")) ||
        Object.values(target).some(item => typeof item !== "string" || !item) ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.hostname) ||
        target.hostname === "opengeo.tools" || target.hostname.endsWith(".opengeo.tools") ||
        boundary.protectedHosts.includes(target.hostname) ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.bucket) ||
        boundary.protectedBuckets.includes(target.bucket) ||
        !/^[A-Z0-9]{1,32}$/.test(target.distribution_id) || target.distribution_id === boundary.distributionId ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(target.origin_id) ||
        (target.origin_access_control_id !== undefined && !/^[A-Z0-9]{1,32}$/.test(target.origin_access_control_id))) ||
      new Set(targets.map(target => target.hostname)).size !== targets.length ||
      new Set(targets.map(target => target.distribution_id)).size !== targets.length) {
    throw new Error("Community publication destinations must be complete, distinct independent hosting targets outside Studio, API, previews and private storage");
  }
  const protectedHosts = ["studio.opengeo.tools", "preview.studio.opengeo.tools", "demo.studio.opengeo.tools",
    ...boundary.protectedHosts];
  if (Buffer.byteLength(JSON.stringify(targets)) + Buffer.byteLength(JSON.stringify(protectedHosts)) > 1800) {
    throw new Error("Publication destination configuration exceeds environment budget");
  }
  return value;
}
