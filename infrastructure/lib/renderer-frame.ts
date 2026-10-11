import {Duration, aws_cloudfront as cloudfront} from "aws-cdk-lib";
import type {Construct} from "constructs";

// Only this application-owned document can be embedded. Other application pages
// keep DENY / frame-ancestors 'none'; this is an SDK lifecycle boundary.
export const RENDERER_FRAME_PATH = "renderer-runtime/cesium-1.145.0/opengeo-host.html";
export const RENDERER_FRAME_CSP = [
  "default-src 'none'", "base-uri 'none'", "object-src 'none'",
  "frame-ancestors 'self'", "frame-src 'none'", "form-action 'none'",
  "script-src 'self' 'unsafe-eval'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://gibs.earthdata.nasa.gov https://basemap.nationalmap.gov https://services.arcgisonline.com",
  "connect-src 'self' https://gibs.earthdata.nasa.gov https://basemap.nationalmap.gov https://services.arcgisonline.com", "worker-src 'self' blob:"
].join("; ");

export function rendererFrameBehavior(scope: Construct, origin: cloudfront.IOrigin,
  namePrefix: string): cloudfront.BehaviorOptions {
  const headers = new cloudfront.ResponseHeadersPolicy(scope, "RendererFrameHeaders", {
    responseHeadersPolicyName: `${namePrefix}-renderer-frame`,
    securityHeadersBehavior: {
      contentSecurityPolicy: {contentSecurityPolicy: RENDERER_FRAME_CSP, override: true},
      contentTypeOptions: {override: true},
      frameOptions: {frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true},
      referrerPolicy: {referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true},
      strictTransportSecurity: {accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true}
    },
    customHeadersBehavior: {customHeaders: [
      {header: "Cache-Control", value: "no-store, max-age=0", override: true},
      {header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()", override: true}
    ]}
  });
  return {
    origin,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    compress: true,
    responseHeadersPolicy: headers,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
  };
}
