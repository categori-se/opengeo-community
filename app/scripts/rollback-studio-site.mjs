import {rollbackStaticRelease} from "./static-release-aws.mjs";
import {assertStudioEdgeBoundary, PUBLIC_PROJECT_MODULE_PATH, STUDIO_API_BEHAVIOR_PATH} from "./studio-edge-boundary.mjs";
import {
  DEVELOPMENT_ACCOUNT,
  communityDeploymentEnabled,
  reviewedCloudFrontDomain,
  studioDeploymentSettings
} from "./studio-release-config.mjs";

const settings = studioDeploymentSettings();
const deployMode = process.env.OPEN_GEO_STUDIO_DEPLOY_MODE ?? "final";
if (!["bootstrap", "final"].includes(deployMode)) {
  throw new Error("OPEN_GEO_STUDIO_DEPLOY_MODE must be either bootstrap or final");
}
const bootstrapDomain = deployMode === "bootstrap"
  ? reviewedCloudFrontDomain(
      process.env.OPEN_GEO_STUDIO_BOOTSTRAP_DOMAIN,
      "Studio bootstrap rollback domain"
    )
  : undefined;
if ((communityDeploymentEnabled() || settings.expectedAccount === DEVELOPMENT_ACCOUNT)
  && bootstrapDomain
  && settings.origin !== `https://${bootstrapDomain}`) {
  throw new Error("Development bootstrap rollback origin must equal its exact CloudFront origin");
}
const viewerHost = bootstrapDomain ?? new URL(settings.origin).hostname;

await rollbackStaticRelease({
  surface: "studio",
  expectedAlias: viewerHost,
  expectedBucket: settings.bucket,
  aliasMode: deployMode === "bootstrap" ? "absent" : "required",
  expectedDistributionDomain: bootstrapDomain,
  expectedOriginDomain: settings.expectedOriginDomain,
  distributionId: process.env.OPEN_GEO_STUDIO_DISTRIBUTION_ID,
  target: process.env.OPEN_GEO_STUDIO_ROLLBACK_ORIGIN,
  confirmationName: deployMode === "bootstrap"
    ? "OPEN_GEO_STUDIO_BOOTSTRAP_ROLLBACK_CONFIRM"
    : "OPEN_GEO_STUDIO_ROLLBACK_CONFIRM",
  confirmationValue: deployMode === "bootstrap"
    ? `rollback-${bootstrapDomain}`
    : `rollback-${viewerHost}`,
  allowedTarget: /^\/releases\/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$/,
  validateOrigin: assertPrivateOacOrigin,
  validateDistribution: assertStudioEdgeBoundary,
  originPathOwner: {
    stackName: settings.stackName,
    parameterName: "StudioReleaseOriginPath",
    allowedNonStaticBehaviorPaths: [STUDIO_API_BEHAVIOR_PATH, PUBLIC_PROJECT_MODULE_PATH]
  },
  expectedManifestOrigin: settings.origin,
  expectedAccount: settings.expectedAccount,
  profile: settings.profile
});

function assertPrivateOacOrigin(origin) {
  if (!origin?.OriginAccessControlId
    || origin.CustomOriginConfig
    || origin.S3OriginConfig?.OriginAccessIdentity !== "") {
    throw new Error("Studio rollback requires the reviewed private S3 origin with OAC signing");
  }
}
