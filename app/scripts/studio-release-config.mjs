export const PRODUCTION_STUDIO_ORIGIN = "https://studio.opengeo.tools";
export const PRODUCTION_STUDIO_BUCKET = "studio.opengeo.tools";
export const PRODUCTION_FUTURE_STUDIO_BUCKET =
  "opengeo-studio-111111111111-us-east-1";
export const PRODUCTION_STUDIO_STACK = "OpenGeo-production-StudioWeb";
export const PRODUCTION_ACCOUNT = "111111111111";
export const DEVELOPMENT_STUDIO_ORIGIN = "https://dev.studio.opengeo.tools";
export const DEVELOPMENT_STUDIO_BUCKET = "opengeo-dev-studio-222222222222-us-east-1";
export const DEVELOPMENT_STUDIO_STACK = "OpenGeo-dev-StudioWeb";
export const DEVELOPMENT_ACCOUNT = "222222222222";

export function communityDeploymentEnabled() {
  const value = process.env.OPEN_GEO_COMMUNITY_DEPLOYMENT;
  if (value !== undefined && value !== "false" && value !== "true") {
    throw new Error("OPEN_GEO_COMMUNITY_DEPLOYMENT must be true or false");
  }
  return value === "true";
}

function communityInput(name, alternative) {
  const value = process.env[name] ?? (alternative ? process.env[alternative] : undefined);
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${name} is required for a Community deployment`);
  }
  return value;
}

export function reviewedStudioOrigin(value) {
  const community = communityDeploymentEnabled();
  value ??= community
    ? communityInput("OPEN_GEO_STUDIO_ORIGIN")
    : process.env.OPEN_GEO_STUDIO_ORIGIN ?? PRODUCTION_STUDIO_ORIGIN;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Studio origin must be an exact reviewed HTTPS origin");
  }
  const allowedHost = [
    "studio.opengeo.tools",
    "dev.studio.opengeo.tools",
    "demo.studio.opengeo.tools"
  ].includes(url.hostname) || /^d[a-z0-9]{5,30}\.cloudfront\.net$/.test(url.hostname);
  const communityHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname)
    && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:"
    || (community && !communityHost)
    || (!community && !allowedHost)
    || url.origin !== value
    || url.port
    || url.username
    || url.password) {
    throw new Error("Studio origin must be an exact reviewed HTTPS origin");
  }
  return url.origin;
}

export function reviewedCloudFrontDomain(value, label = "Studio bootstrap domain") {
  if (!/^d[a-z0-9]{5,30}\.cloudfront\.net$/.test(value ?? "")) {
    throw new Error(`${label} must be the exact CloudFront distribution domain`);
  }
  return value;
}

export function assertStudioAuthConfig(authConfig, origin) {
  const community = communityDeploymentEnabled();
  const hostedUiBaseUrl = community
    ? communityInput("OPEN_GEO_COGNITO_HOSTED_UI_BASE_URL")
    : "https://auth.categori.se";
  if (community && (!hostedUiBaseUrl.startsWith("https://")
    || !new URL(hostedUiBaseUrl).hostname.endsWith(`.auth.${authConfig.region}.amazoncognito.com`))) {
    throw new Error("Community Studio requires its own HTTPS Cognito hosted UI domain");
  }
  if (authConfig.redirectUri !== `${origin}/login`
    || authConfig.logoutUri !== `${origin}/login`
    || authConfig.hostedUiBaseUrl !== hostedUiBaseUrl) {
    throw new Error("Studio authentication configuration is not bound to the configured origin and identity provider");
  }
}

export function studioDeploymentSettings() {
  const origin = reviewedStudioOrigin();
  if (communityDeploymentEnabled()) {
    const bucket = communityInput("OPEN_GEO_STUDIO_BUCKET");
    const stackName = communityInput("OPEN_GEO_STUDIO_STACK_NAME");
    const expectedAccount = communityInput("OPEN_GEO_STUDIO_EXPECTED_ACCOUNT");
    const profile = communityInput("OPEN_GEO_AWS_PROFILE", "AWS_PROFILE");
    const region = communityInput("OPEN_GEO_AWS_REGION", "AWS_REGION");
    if (!/^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
      || /\.\.|\.-|-\./.test(bucket)
      || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
      throw new Error("Community Studio bucket must be an explicit DNS-compatible S3 bucket name");
    }
    if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)
      || !/^[0-9]{12}$/.test(expectedAccount)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
      throw new Error("Community Studio stack, expected account or AWS profile is invalid");
    }
    if (region !== "us-east-1") {
      throw new Error("The current Community Studio deployment supports us-east-1 only");
    }
    return Object.freeze({
      origin, bucket, stackName, expectedAccount, profile, region,
      expectedOriginDomain: `${bucket}.s3.${region}.amazonaws.com`,
      deploymentRecordPath: process.env.OPEN_GEO_STUDIO_DEPLOYMENT_RECORD_PATH
    });
  }
  const bucket = process.env.OPEN_GEO_STUDIO_BUCKET ?? PRODUCTION_STUDIO_BUCKET;
  const stackName = process.env.OPEN_GEO_STUDIO_STACK_NAME ?? PRODUCTION_STUDIO_STACK;
  const expectedAccount = process.env.OPEN_GEO_STUDIO_EXPECTED_ACCOUNT ?? PRODUCTION_ACCOUNT;
  const profile = process.env.OPEN_GEO_AWS_PROFILE ?? "categorise";
  const deploymentRecordPath = process.env.OPEN_GEO_STUDIO_DEPLOYMENT_RECORD_PATH;
  const productionTuple = origin === PRODUCTION_STUDIO_ORIGIN
    && [PRODUCTION_STUDIO_BUCKET, PRODUCTION_FUTURE_STUDIO_BUCKET].includes(bucket)
    && stackName === PRODUCTION_STUDIO_STACK
    && expectedAccount === PRODUCTION_ACCOUNT;
  const developmentTuple = expectedAccount === DEVELOPMENT_ACCOUNT
    && bucket === DEVELOPMENT_STUDIO_BUCKET
    && stackName === DEVELOPMENT_STUDIO_STACK
    && (
      origin === DEVELOPMENT_STUDIO_ORIGIN
      || /^https:\/\/d[a-z0-9]{5,30}\.cloudfront\.net$/.test(origin)
    );
  if (!productionTuple && !developmentTuple) {
    throw new Error(
      "Studio release settings must match the complete reviewed production or development tuple"
    );
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("Studio AWS profile name is invalid");
  }
  return Object.freeze({
    origin,
    bucket,
    stackName,
    expectedAccount,
    profile,
    expectedOriginDomain: `${bucket}.s3.us-east-1.amazonaws.com`,
    deploymentRecordPath
  });
}
