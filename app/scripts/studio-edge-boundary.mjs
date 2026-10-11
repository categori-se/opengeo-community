const API_ORIGIN_DOMAIN = /^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/;
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

export const STUDIO_API_BEHAVIOR_PATH = "api/*";
export const PUBLIC_PROJECT_MODULE_PATH = "api/public/organizations/*/artifact-releases/*/module.mjs";
export const RENDERER_FRAME_PATH = "renderer-runtime/cesium-1.145.0/opengeo-host.html";

// The optional renderer document shares the private static origin. Never permit
// a wildcard or write-enabled route when accepting this additional behavior.
export function withoutRendererFrameBehavior({config, staticOrigin}) {
  const behaviors = config?.CacheBehaviors?.Items ?? [];
  const frames = behaviors.filter(({PathPattern}) => PathPattern === RENDERER_FRAME_PATH);
  if (frames.length > 1 || frames.some((frame) => (
    frame.TargetOriginId !== staticOrigin.Id
    || frame.CachePolicyId !== CACHING_DISABLED
    || frame.ViewerProtocolPolicy !== "redirect-to-https"
    || !frame.ResponseHeadersPolicyId
    || !sameItems(frame.AllowedMethods?.Items, ["GET", "HEAD"])
    || !sameItems(frame.AllowedMethods?.CachedMethods?.Items, ["GET", "HEAD"])
  ))) throw new Error("Renderer frame behavior is outside the reviewed static boundary");
  return behaviors.filter(({PathPattern}) => PathPattern !== RENDERER_FRAME_PATH);
}

/**
 * Accepts the private Studio S3 origin plus, optionally, one reviewed API
 * Gateway origin. No other cache behavior or origin may cross the Studio edge.
 */
export function assertStudioEdgeBoundary({config, staticOrigin}) {
  const behaviors = withoutRendererFrameBehavior({config, staticOrigin});
  const authBehaviors = behaviors.filter(({PathPattern}) => PathPattern === "auth-config.json");
  const apiBehaviors = behaviors.filter(({PathPattern}) => PathPattern === STUDIO_API_BEHAVIOR_PATH);
  const modules = behaviors.filter(({PathPattern}) => PathPattern === PUBLIC_PROJECT_MODULE_PATH);
  if (behaviors.length !== authBehaviors.length + apiBehaviors.length + modules.length
    || authBehaviors.length !== 1
    || modules.length > 1 || (modules.length && !apiBehaviors.length)
    || apiBehaviors.length > 1) {
    throw new Error("Studio edge contains an unexpected cache behavior");
  }
  if (authBehaviors[0].TargetOriginId !== staticOrigin.Id
    || authBehaviors[0].CachePolicyId !== CACHING_DISABLED
    || !sameItems(authBehaviors[0].AllowedMethods?.Items, ["GET", "HEAD"])) {
    throw new Error("Studio auth-config behavior is outside the reviewed static boundary");
  }

  const origins = config?.Origins?.Items ?? [];
  if (apiBehaviors.length === 0) {
    if (origins.length !== 1 || origins[0].Id !== staticOrigin.Id) {
      throw new Error("Studio edge contains an origin without a reviewed behavior");
    }
    return;
  }

  const behavior = apiBehaviors[0];
  if (modules.length && behaviors.indexOf(modules[0]) > behaviors.indexOf(behavior)) {
    throw new Error("Public Project module behavior is shadowed by the private API behavior");
  }
  if (modules.some(module => module.TargetOriginId !== behavior.TargetOriginId
    || module.CachePolicyId !== CACHING_DISABLED
    || module.OriginRequestPolicyId !== ALL_VIEWER_EXCEPT_HOST
    || module.ViewerProtocolPolicy !== "redirect-to-https"
    || !module.ResponseHeadersPolicyId
    || !sameItems(module.AllowedMethods?.Items, ["GET", "HEAD"])
    || !sameItems(module.AllowedMethods?.CachedMethods?.Items, ["GET", "HEAD"])
    || module.FunctionAssociations?.Quantity !== 1
    || module.FunctionAssociations.Items?.[0]?.EventType !== "viewer-request"
    || !module.FunctionAssociations.Items?.[0]?.FunctionARN)) {
    throw new Error("Public Project module behavior is outside the reviewed read-only boundary");
  }
  const apiOrigins = origins.filter(({Id}) => Id === behavior.TargetOriginId);
  if (origins.length !== 2 || apiOrigins.length !== 1 || behavior.TargetOriginId === staticOrigin.Id) {
    throw new Error("Studio /api/* does not target one separate reviewed origin");
  }
  const apiOrigin = apiOrigins[0];
  if (!API_ORIGIN_DOMAIN.test(apiOrigin.DomainName ?? "")
    || (apiOrigin.OriginPath ?? "") !== ""
    || apiOrigin.OriginAccessControlId
    || apiOrigin.S3OriginConfig
    || apiOrigin.CustomOriginConfig?.OriginProtocolPolicy !== "https-only"
    || !sameItems(apiOrigin.CustomOriginConfig?.OriginSslProtocols?.Items, ["TLSv1.2"])
    || (apiOrigin.CustomHeaders?.Quantity ?? 0) !== 0) {
    throw new Error("Studio API origin is outside the reviewed regional HTTPS boundary");
  }
  if (behavior.CachePolicyId !== CACHING_DISABLED
    || behavior.OriginRequestPolicyId !== ALL_VIEWER_EXCEPT_HOST
    || behavior.ViewerProtocolPolicy !== "redirect-to-https"
    || !sameItems(behavior.AllowedMethods?.Items, [
      "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"
    ])
    || !sameItems(behavior.AllowedMethods?.CachedMethods?.Items, ["GET", "HEAD", "OPTIONS"])) {
    throw new Error("Studio API behavior does not forward the reviewed uncached request surface");
  }
}

function sameItems(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}
