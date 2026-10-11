import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {readJson, sha256, verifyManifestSeal} from "./release-utils.mjs";
import {deployStaticRelease} from "./static-release-aws.mjs";
import {assertStudioEdgeBoundary, PUBLIC_PROJECT_MODULE_PATH, STUDIO_API_BEHAVIOR_PATH} from "./studio-edge-boundary.mjs";
import {
  DEVELOPMENT_ACCOUNT,
  assertStudioAuthConfig,
  communityDeploymentEnabled,
  reviewedCloudFrontDomain,
  studioDeploymentSettings
} from "./studio-release-config.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const settings = studioDeploymentSettings();
const deployMode = process.env.OPEN_GEO_STUDIO_DEPLOY_MODE ?? "final";
if (!["bootstrap", "final"].includes(deployMode)) {
  throw new Error("OPEN_GEO_STUDIO_DEPLOY_MODE must be either bootstrap or final");
}
const bootstrapDomain = deployMode === "bootstrap"
  ? reviewedCloudFrontDomain(
      process.env.OPEN_GEO_STUDIO_BOOTSTRAP_DOMAIN,
      "Studio bootstrap deployment domain"
    )
  : undefined;
if ((communityDeploymentEnabled() || settings.expectedAccount === DEVELOPMENT_ACCOUNT)
  && bootstrapDomain
  && settings.origin !== `https://${bootstrapDomain}`) {
  throw new Error("Development bootstrap release origin must equal its exact CloudFront origin");
}
const studioDistributionId = process.env.OPEN_GEO_STUDIO_DISTRIBUTION_ID;
const viewerHost = bootstrapDomain ?? new URL(settings.origin).hostname;
const manifestPath = resolve(workspaceRoot, "dist/opengeo-studio-release.json");
execFileSync(process.execPath, [resolve(appRoot, "scripts/check-studio-release.mjs")], {
  stdio: "inherit"
});
const manifest = verifyManifestSeal(await readJson(manifestPath), "Studio release manifest");
if (manifest.schemaVersion !== "opengeo.studio-release.1.0.0"
  || manifest.studioOrigin !== settings.origin
  || manifest.authConfig?.path !== "auth-config.json"
  || manifest.authConfig?.cacheControl !== "no-store") {
  throw new Error("Studio deployment requires a sealed same-origin authentication configuration");
}
const authBytes = await readFile(resolve(appRoot, "dist/auth-config.json"));
const authConfig = parseAuthConfig(JSON.parse(authBytes.toString("utf8")), {
  currentOrigin: settings.origin
});
assertStudioAuthConfig(authConfig, settings.origin);
if (authBytes.length !== manifest.authConfig.bytes
  || sha256(authBytes) !== manifest.authConfig.sha256
  || authConfig.redirectUri !== manifest.authConfig.redirectUri
  || authConfig.logoutUri !== manifest.authConfig.logoutUri) {
  throw new Error("Studio deployment auth-config.json does not match its sealed release contract");
}

await deployStaticRelease({
  surface: "studio",
  root: resolve(appRoot, "dist"),
  manifestPath,
  expectedBucket: settings.bucket,
  expectedAlias: viewerHost,
  aliasMode: deployMode === "bootstrap" ? "absent" : "required",
  expectedDistributionDomain: bootstrapDomain,
  expectedOriginDomain: settings.expectedOriginDomain,
  distributionId: studioDistributionId,
  releaseStem: "opengeo-studio",
  confirmationName: deployMode === "bootstrap"
    ? "OPEN_GEO_STUDIO_BOOTSTRAP_DEPLOY_CONFIRM"
    : "OPEN_GEO_STUDIO_DEPLOY_CONFIRM",
  confirmationValue: deployMode === "bootstrap"
    ? `deploy-${bootstrapDomain}`
    : `deploy-${viewerHost}`,
  aliases: manifest.aliases,
  noStorePaths: [manifest.authConfig.path],
  allowedPreviousOrigin: /^(?:|\/releases\/opengeo-studio-[0-9]{14}-[0-9a-f]{12})$/,
  validateOrigin: assertPrivateOacOrigin,
  validateDistribution: assertStudioEdgeBoundary,
  originPathOwner: {
    stackName: settings.stackName,
    parameterName: "StudioReleaseOriginPath",
    allowedNonStaticBehaviorPaths: [STUDIO_API_BEHAVIOR_PATH, PUBLIC_PROJECT_MODULE_PATH]
  },
  deploymentRecordPath: settings.deploymentRecordPath
    ? resolve(workspaceRoot, settings.deploymentRecordPath)
    : resolve(workspaceRoot, "dist/opengeo-studio-deployment-record.json"),
  expectedAccount: settings.expectedAccount,
  profile: settings.profile,
  rollbackCommand: (previous) => previous ? (
    (communityDeploymentEnabled()
      ? `OPEN_GEO_COMMUNITY_DEPLOYMENT=true OPEN_GEO_AWS_REGION=${settings.region} `
      : "")
    + `OPEN_GEO_STUDIO_ORIGIN=${settings.origin} `
    + `OPEN_GEO_STUDIO_BUCKET=${settings.bucket} `
    + `OPEN_GEO_STUDIO_STACK_NAME=${settings.stackName} `
    + `OPEN_GEO_STUDIO_EXPECTED_ACCOUNT=${settings.expectedAccount} `
    + `OPEN_GEO_AWS_PROFILE=${settings.profile} `
    + `OPEN_GEO_STUDIO_DEPLOY_MODE=${deployMode} `
    + (bootstrapDomain ? `OPEN_GEO_STUDIO_BOOTSTRAP_DOMAIN=${bootstrapDomain} ` : "")
    + `OPEN_GEO_STUDIO_DISTRIBUTION_ID=${studioDistributionId} `
    + `OPEN_GEO_STUDIO_ROLLBACK_ORIGIN=${previous} `
    + (deployMode === "bootstrap"
      ? `OPEN_GEO_STUDIO_BOOTSTRAP_ROLLBACK_CONFIRM=rollback-${bootstrapDomain} `
      : `OPEN_GEO_STUDIO_ROLLBACK_CONFIRM=rollback-${viewerHost} `)
    + (communityDeploymentEnabled()
      ? `node ${shellQuote(resolve(appRoot, "scripts/rollback-studio-site.mjs"))}`
      : "npm run rollback:studio")
  ) : null
});

function assertPrivateOacOrigin(origin) {
  if (!origin?.OriginAccessControlId
    || origin.CustomOriginConfig
    || origin.S3OriginConfig?.OriginAccessIdentity !== "") {
    throw new Error("Studio deployment requires the reviewed private S3 origin with OAC signing");
  }
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", `'"'"'`) + "'";
}
