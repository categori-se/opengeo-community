import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {assertStudioEdgeBoundary, PUBLIC_PROJECT_MODULE_PATH, RENDERER_FRAME_PATH, withoutRendererFrameBehavior} from "../scripts/studio-edge-boundary.mjs";

const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
const staticOrigin = {
  Id: "studio-static",
  DomainName: "studio.opengeo.tools.s3.us-east-1.amazonaws.com",
  OriginPath: "/releases/opengeo-studio-20260821222342-9a7795db1ac1",
  OriginAccessControlId: "oac",
  S3OriginConfig: {OriginAccessIdentity: ""}
};
const authBehavior = {
  PathPattern: "auth-config.json",
  TargetOriginId: staticOrigin.Id,
  CachePolicyId: CACHING_DISABLED,
  AllowedMethods: {Items: ["HEAD", "GET"]}
};

describe("Studio edge release boundary", () => {
  it("accepts the private static edge before an API is deployed", () => {
    assert.doesNotThrow(() => assertStudioEdgeBoundary({
      staticOrigin,
      config: configuration()
    }));
  });

  it("accepts one uncached /api/* behavior to an exact regional API Gateway", () => {
    assert.doesNotThrow(() => assertStudioEdgeBoundary({
      staticOrigin,
      config: configuration({withApi: true})
    }));
  });

  it("rejects additional paths, unreviewed origins, and weakened forwarding", () => {
    for (const mutate of [
      (config) => config.CacheBehaviors.Items.push({...authBehavior, PathPattern: "admin/*"}),
      (config) => { config.Origins.Items[1].DomainName = "example.org"; },
      (config) => { config.CacheBehaviors.Items[1].CachePolicyId = "caching-enabled"; },
      (config) => { config.CacheBehaviors.Items[1].OriginRequestPolicyId = undefined; },
      (config) => { config.Origins.Items[1].CustomHeaders = {Quantity: 1, Items: []}; },
      (config) => { config.CacheBehaviors.Items[0].TargetOriginId = "studio-api"; }
    ]) {
      const config = configuration({withApi: true});
      mutate(config);
      assert.throws(() => assertStudioEdgeBoundary({staticOrigin, config}));
    }
  });

  it("accepts only an uncached read-only public module route before the private API behavior", () => {
    const config = configuration({withApi: true});
    const module = {
      PathPattern: PUBLIC_PROJECT_MODULE_PATH, TargetOriginId: "studio-api",
      CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
      ViewerProtocolPolicy: "redirect-to-https", ResponseHeadersPolicyId: "public-module",
      AllowedMethods: {Items: ["GET", "HEAD"], CachedMethods: {Items: ["GET", "HEAD"]}},
      FunctionAssociations: {Quantity: 1, Items: [{EventType: "viewer-request", FunctionARN: "public-module"}]}
    };
    config.CacheBehaviors.Items.splice(1, 0, module);
    assert.doesNotThrow(() => assertStudioEdgeBoundary({staticOrigin, config}));
    for (const patch of [
      {PathPattern: "api/public/*"}, {TargetOriginId: staticOrigin.Id},
      {CachePolicyId: "cached"}, {ResponseHeadersPolicyId: undefined},
      {OriginRequestPolicyId: undefined}, {FunctionAssociations: {Quantity: 0}},
      {AllowedMethods: {Items: ["GET", "HEAD", "POST"]}}
    ]) {
      const invalid = structuredClone(config);
      Object.assign(invalid.CacheBehaviors.Items[1], patch);
      assert.throws(() => assertStudioEdgeBoundary({staticOrigin, config: invalid}));
    }
    const shadowed = structuredClone(config);
    shadowed.CacheBehaviors.Items.reverse();
    assert.throws(() => assertStudioEdgeBoundary({staticOrigin, config: shadowed}));
  });

  it("accepts only the isolated read-only renderer route on Studio and browser Demo", () => {
    const frame = {
      PathPattern: RENDERER_FRAME_PATH, TargetOriginId: staticOrigin.Id,
      CachePolicyId: CACHING_DISABLED, ViewerProtocolPolicy: "redirect-to-https",
      ResponseHeadersPolicyId: "isolated-frame-policy",
      AllowedMethods: {Items: ["GET", "HEAD"], CachedMethods: {Items: ["GET", "HEAD"]}}
    };
    const config = configuration({withApi: true});
    config.CacheBehaviors.Items.push(frame);
    assert.doesNotThrow(() => assertStudioEdgeBoundary({staticOrigin, config}));
    assert.deepEqual(withoutRendererFrameBehavior({staticOrigin,
      config: {CacheBehaviors: {Items: [frame]}}}), []);
    for (const patch of [
      {PathPattern: "renderer-runtime/*"}, {TargetOriginId: "studio-api"},
      {CachePolicyId: "cached"}, {ResponseHeadersPolicyId: undefined},
      {AllowedMethods: {Items: ["GET", "HEAD", "POST"]}}
    ]) {
      const invalid = structuredClone(config);
      Object.assign(invalid.CacheBehaviors.Items.at(-1), patch);
      assert.throws(() => assertStudioEdgeBoundary({staticOrigin, config: invalid}));
    }
  });
});

function configuration({withApi = false} = {}) {
  const config = {
    Origins: {Items: [structuredClone(staticOrigin)]},
    DefaultCacheBehavior: {TargetOriginId: staticOrigin.Id},
    CacheBehaviors: {Items: [structuredClone(authBehavior)]}
  };
  if (!withApi) return config;
  config.Origins.Items.push({
    Id: "studio-api",
    DomainName: "abcdefghij.execute-api.us-east-1.amazonaws.com",
    OriginPath: "",
    CustomHeaders: {Quantity: 0},
    CustomOriginConfig: {
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: {Items: ["TLSv1.2"]}
    }
  });
  config.CacheBehaviors.Items.push({
    PathPattern: "api/*",
    TargetOriginId: "studio-api",
    CachePolicyId: CACHING_DISABLED,
    OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: {
      Items: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
      CachedMethods: {Items: ["GET", "HEAD", "OPTIONS"]}
    }
  });
  return config;
}
