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

export function reviewedStudioOrigin(
  value = process.env.OPEN_GEO_STUDIO_ORIGIN ?? PRODUCTION_STUDIO_ORIGIN
) {
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
  if (url.protocol !== "https:"
    || !allowedHost
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

export function studioDeploymentSettings() {
  const origin = reviewedStudioOrigin();
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
