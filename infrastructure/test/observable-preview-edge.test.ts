import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {describe, it} from "node:test";
import {runInNewContext} from "node:vm";
import {
  App,
  Stack,
  aws_kms as kms,
  aws_s3 as s3
} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {
  OBSERVABLE_PREVIEW_BUILD_CSP,
  OBSERVABLE_PREVIEW_DRAFT_CSP,
  OBSERVABLE_PREVIEW_DOMAIN_NAME,
  OBSERVABLE_PREVIEW_SHELL_CSP,
  OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME,
  OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN,
  observablePreviewBuildCsp,
  observablePublicMapsPreviewBuildCsp,
  ObservablePreviewEdge
} from "../lib/observable-preview-edge.js";

const ACCOUNT = "111111111111";
const CERTIFICATE_ARN =
  `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`;
const API_ORIGIN = "abcdefghij.execute-api.us-east-1.amazonaws.com";
const PUBLIC_KEY = generateKeyPairSync("rsa", {modulusLength: 2048})
  .publicKey.export({type: "spki", format: "pem"})
  .toString();

function templateFor(overrides: Partial<ConstructorParameters<typeof ObservablePreviewEdge>[2]> = {}) {
  const app = new App();
  const stack = new Stack(app, "Test-ObservablePreview", {
    env: {account: ACCOUNT, region: "us-east-1"}
  });
  const dataKey = new kms.Key(stack, "DataKey");
  const applicationBucket = new s3.Bucket(stack, "ApplicationBucket", {
    bucketName: "source.opengeo.tools",
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: dataKey,
    enforceSSL: true
  });
  new ObservablePreviewEdge(stack, "Preview", {
    applicationBucket,
    applicationBucketName: "source.opengeo.tools",
    dataKey,
    apiOriginDomain: API_ORIGIN,
    certificateArn: CERTIFICATE_ARN,
    publicKeyPem: PUBLIC_KEY,
    ...overrides
  });
  return Template.fromStack(stack);
}

describe("private Observable preview edge", () => {
  it("keeps build output private while exposing only the shell and exact exchange", () => {
    const template = templateFor();
    const distributions = resourcesOfType(template, "AWS::CloudFront::Distribution");
    assert.equal(distributions.length, 1);
    const config = distributions[0]!.Properties.DistributionConfig;
    assert.equal(config.Aliases[0], OBSERVABLE_PREVIEW_DOMAIN_NAME);
    assert.deepEqual(config.DefaultCacheBehavior.AllowedMethods, ["GET", "HEAD"]);
    assert.equal(config.DefaultCacheBehavior.TrustedKeyGroups.length, 1);

    const authorize = config.CacheBehaviors.find(
      (behavior: Record<string, unknown>) => behavior.PathPattern === "authorize/*"
    );
    const exchange = config.CacheBehaviors.find(
      (behavior: Record<string, unknown>) =>
        behavior.PathPattern === "observable-preview/exchange"
    );
    assert.ok(authorize);
    assert.ok(exchange);
    const draft = config.CacheBehaviors.find((behavior: Record<string, unknown>) => behavior.PathPattern === "authorize/draft.html");
    assert.ok(draft);
    assert.equal("TrustedKeyGroups" in draft, false);
    assert.deepEqual(draft.AllowedMethods, ["GET", "HEAD"]);
    assert.deepEqual(draft.TargetOriginId, authorize.TargetOriginId);
    assert.notDeepEqual(draft.ResponseHeadersPolicyId, authorize.ResponseHeadersPolicyId);
    assert.ok(config.CacheBehaviors.indexOf(draft) < config.CacheBehaviors.indexOf(authorize));
    assert.equal("TrustedKeyGroups" in authorize, false);
    assert.equal("TrustedKeyGroups" in exchange, false);
    assert.deepEqual(
      exchange.AllowedMethods,
      ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    );
    assert.equal(exchange.OriginRequestPolicyId, "b689b0a8-53d0-40ab-baf2-68738e2966ac");
  });

  it("grants CloudFront only exact output and shell prefixes", () => {
    const template = templateFor();
    const policies = resourcesOfType(template, "AWS::S3::BucketPolicy");
    const serialized = JSON.stringify(policies);
    assert.match(
      serialized,
      /organizations\/\*\/projects\/\*\/source-projects\/\*\/builds\/\*\/output\/\*/
    );
    assert.match(serialized, /authorize\/\*/);
    assert.match(serialized, /AllowExactObservablePreviewOutputRead/);
    assert.match(serialized, /AllowObservablePreviewShellRead/);
    assert.doesNotMatch(serialized, /organizations\/\*[^\"]*pages/);

    template.hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AllowObservablePreviewOutputDecrypt",
            Action: "kms:Decrypt",
            Principal: {Service: "cloudfront.amazonaws.com"},
            Condition: Match.objectLike({
              "ForAnyValue:StringLike": Match.absent(),
              StringEquals: Match.objectLike({
                "kms:EncryptionContext:aws:s3:arn": Match.anyValue()
              })
            })
          })
        ])
      }
    });
  });

  it("enforces separate CSPs and deploys a no-store static shell", () => {
    const template = templateFor();
    const document = JSON.stringify(template.toJSON());
    const buildCsp = observablePreviewBuildCsp(API_ORIGIN);
    assert.match(document, new RegExp(escapeRegExp(buildCsp)));
    assert.ok(buildCsp.includes(`frame-src 'self' https://${API_ORIGIN}/public/organizations/;`));
    assert.throws(() => observablePreviewBuildCsp('example.test'), /Invalid preview public API origin/);
    assert.match(document, new RegExp(escapeRegExp(OBSERVABLE_PREVIEW_SHELL_CSP)));
    assert.match(document, new RegExp(escapeRegExp(OBSERVABLE_PREVIEW_DRAFT_CSP)));
    assert.doesNotMatch(OBSERVABLE_PREVIEW_SHELL_CSP, /data:|unsafe-inline/);
    assert.match(OBSERVABLE_PREVIEW_DRAFT_CSP, /frame-src 'none'/);
    assert.match(OBSERVABLE_PREVIEW_DRAFT_CSP, /frame-ancestors https:\/\/studio\.opengeo\.tools https:\/\/demo\.studio\.opengeo\.tools(?:;|$)/);
    assert.doesNotMatch(OBSERVABLE_PREVIEW_SHELL_CSP + OBSERVABLE_PREVIEW_BUILD_CSP, /demo\.studio\.opengeo\.tools/);
    assert.match(OBSERVABLE_PREVIEW_BUILD_CSP, /frame-src 'self'(?:;|$)/);
    assert.match(OBSERVABLE_PREVIEW_BUILD_CSP, /frame-ancestors 'self' https:\/\/studio\.opengeo\.tools(?:;|$)/);
    assert.match(OBSERVABLE_PREVIEW_SHELL_CSP, /frame-src 'none'/);
    assert.match(OBSERVABLE_PREVIEW_DRAFT_CSP, /worker-src blob:/);
    assert.doesNotMatch(OBSERVABLE_PREVIEW_DRAFT_CSP, /unsafe-eval|connect-src[^;]*https:/);
    assert.match(document, /no-store, max-age=0/);
    template.resourceCountIs("AWS::CloudFront::PublicKey", 1);
    template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
  });

  it("leaves the default distribution and policies unchanged without explicit opt-in", () => {
    const template = templateFor();
    assert.deepEqual(template.toJSON(), templateFor({enablePublicMapsPreview: false}).toJSON());
    const config = resourcesOfType(template, "AWS::CloudFront::Distribution")[0]!.Properties.DistributionConfig;
    assert.deepEqual(config.Aliases, [OBSERVABLE_PREVIEW_DOMAIN_NAME]);
    assert.equal("FunctionAssociations" in config.DefaultCacheBehavior, false);
    assert.equal("ObservablePublicMapsPreviewOrigin" in template.toJSON().Outputs, false);
    template.resourceCountIs("AWS::CloudFront::Function", 1);
  });

  it("opts in only the output behavior on the same distribution, origins and signing key group", () => {
    const baseline = templateFor();
    const optedIn = templateFor({enablePublicMapsPreview: true});
    const baselineConfig = resourcesOfType(baseline, "AWS::CloudFront::Distribution")[0]!.Properties.DistributionConfig;
    const config = resourcesOfType(optedIn, "AWS::CloudFront::Distribution")[0]!.Properties.DistributionConfig;
    assert.deepEqual(config.Aliases, [OBSERVABLE_PREVIEW_DOMAIN_NAME, OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME]);
    assert.deepEqual(config.Origins, baselineConfig.Origins);
    assert.deepEqual(config.ViewerCertificate, baselineConfig.ViewerCertificate);
    assert.deepEqual(config.CacheBehaviors, baselineConfig.CacheBehaviors);
    assert.deepEqual(config.DefaultCacheBehavior.TrustedKeyGroups, baselineConfig.DefaultCacheBehavior.TrustedKeyGroups);
    assert.deepEqual(config.DefaultCacheBehavior.ResponseHeadersPolicyId, baselineConfig.DefaultCacheBehavior.ResponseHeadersPolicyId);
    assert.deepEqual(config.DefaultCacheBehavior.FunctionAssociations.map((association: Record<string, unknown>) => association.EventType), ["viewer-response"]);
    for (const type of ["AWS::CloudFront::PublicKey", "AWS::CloudFront::KeyGroup", "AWS::CloudFront::ResponseHeadersPolicy", "AWS::S3::BucketPolicy", "AWS::KMS::Key"]) {
      assert.deepEqual(resourcesOfType(optedIn, type), resourcesOfType(baseline, type));
    }
    optedIn.resourceCountIs("AWS::CloudFront::Distribution", 1);
    optedIn.resourceCountIs("AWS::CloudFront::Function", 2);
    assert.equal(optedIn.toJSON().Outputs.ObservablePublicMapsPreviewOrigin.Value, OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN);
  });

  it("selects the constrained policy for the exact alias and keeps all other hosts closed", () => {
    const template = templateFor({enablePublicMapsPreview: true});
    const functions = resourcesOfType(template, "AWS::CloudFront::Function");
    const code = functions.find(resource => resource.Properties.Name === "opengeo-observable-preview-public-maps-v1")!.Properties.FunctionCode;
    assert.ok(Buffer.byteLength(code) < 10_240, "CloudFront Function code fits the 10 KiB limit");
    const handler = runInNewContext(`${code}\nhandler;`);
    const strictCsp = observablePreviewBuildCsp(API_ORIGIN);
    for (const host of [OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME, OBSERVABLE_PREVIEW_DOMAIN_NAME,
      "unknown.example", "example.cloudfront.net", `${OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME}.example`,
      `${OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME}:443`, OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME.toUpperCase(), undefined]) {
      const headers = {
        "content-security-policy": {value: strictCsp},
        "referrer-policy": {value: "no-referrer"},
        "x-content-type-options": {value: "nosniff"}
      };
      const response = {statusCode: 200, headers};
      const returned = handler({request: {headers: host ? {host: {value: host}} : {}}, response});
      assert.equal(returned, response);
      assert.equal(returned.headers["content-security-policy"].value,
        host === OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME ? observablePublicMapsPreviewBuildCsp(API_ORIGIN) : strictCsp);
      assert.deepEqual(returned.headers["referrer-policy"], {value: "no-referrer"});
      assert.deepEqual(returned.headers["x-content-type-options"], {value: "nosniff"});
    }
  });

  it("supports local native modules and verified attachment/font bytes without adding network origins", () => {
    const directives = new Map(observablePreviewBuildCsp(API_ORIGIN).split("; ").map(directive => {
      const [name, ...values] = directive.split(" ");
      return [name!, values];
    }));
    assert.deepEqual(directives.get("script-src"), ["'self'", "'unsafe-inline'", "'unsafe-eval'", "data:"]);
    assert.deepEqual(directives.get("connect-src"), ["'self'", "data:", "blob:"]);
    assert.deepEqual(directives.get("font-src"), ["'self'", "data:", "blob:"]);
    assert.deepEqual(directives.get("style-src"), ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(directives.get("img-src"), ["'self'", "data:", "blob:"]);
    assert.deepEqual(directives.get("worker-src"), ["'self'", "blob:"]);
    assert.equal(directives.has("media-src"), false);
    assert.deepEqual(directives.get("frame-src"), ["'self'", `https://${API_ORIGIN}/public/organizations/`]);
    assert.deepEqual(directives.get("frame-ancestors"), ["'self'", "https://studio.opengeo.tools"]);
    assert.doesNotMatch(OBSERVABLE_PREVIEW_SHELL_CSP, /data:|blob:|unsafe-inline|unsafe-eval/);
    assert.match(OBSERVABLE_PREVIEW_DRAFT_CSP, /font-src data:(?:;|$)/);
    assert.doesNotMatch(OBSERVABLE_PREVIEW_DRAFT_CSP, /unsafe-eval|connect-src[^;]*https:/);
  });

  it("allows only the pinned package scripts, resolver metadata, stylesheet and public tile images", () => {
    const directives = (csp: string) => new Map(csp.split("; ").map(directive => {
      const [name, ...values] = directive.split(" ");
      return [name!, values];
    }));
    const baseline = directives(observablePreviewBuildCsp(API_ORIGIN));
    const maps = directives(observablePublicMapsPreviewBuildCsp(API_ORIGIN));
    for (const [name, values] of baseline) {
      if (!["script-src", "style-src", "img-src", "connect-src"].includes(name)) {
        assert.deepEqual(maps.get(name), values, `${name} retains its private-preview boundary`);
      }
    }
    assert.deepEqual(maps.get("script-src"), ["'self'", "'unsafe-inline'", "'unsafe-eval'", "data:",
      "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet-src.js",
      "https://cdn.jsdelivr.net/npm/esri-leaflet@3.0.12/dist/esri-leaflet-debug.js"]);
    assert.deepEqual(maps.get("connect-src"), ["'self'", "data:", "blob:",
      "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/package.json",
      "https://cdn.jsdelivr.net/npm/esri-leaflet@3.0.12/package.json",
      "https://cdn.jsdelivr.net/npm/leaflet@%5E1.0.0/package.json"]);
    assert.deepEqual(maps.get("style-src"), ["'self'", "'unsafe-inline'", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"]);
    const images = maps.get("img-src")!;
    const noaa = images.filter(value => value.startsWith("https://coast.noaa.gov/"));
    assert.equal(noaa.length, 22);
    for (const url of noaa) assert.match(url, /^https:\/\/coast\.noaa\.gov\/arcgis\/rest\/services\/dc_slr\/(slr|conf)_(?:[0-9]|10)ft\/MapServer\/tile\/$/);
    assert.ok(images.includes("https://unpkg.com/leaflet@1.9.4/dist/images/"));
    assert.ok(images.includes("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/"));
    assert.ok(images.includes("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/"));
    assert.deepEqual(images.filter(value => value.includes("tile.openstreetmap.org")), [
      "https://a.tile.openstreetmap.org/", "https://b.tile.openstreetmap.org/", "https://c.tile.openstreetmap.org/"
    ]);
    const egress = ["script-src", "style-src", "img-src", "connect-src"].flatMap(name => maps.get(name)!);
    assert.doesNotMatch(egress.join(" "), /\*|studio\.opengeo\.tools|categori|amazonaws|leaflet@latest|leaflet@%5E1\.0\.0\/(?!package\.json)/);
    assert.throws(() => observablePublicMapsPreviewBuildCsp("example.test"), /Invalid preview public API origin/);
  });

  it("rejects wrong-region, malformed origin, and weak key configuration", () => {
    assert.throws(
      () => templateFor({apiOriginDomain: "example.com"}),
      /exact us-east-1 API Gateway domain/
    );
    assert.throws(
      () => templateFor({publicKeyPem: "not a key\n"}),
      /RSA with at least 2048 bits/
    );
    assert.throws(
      () => templateFor({enablePublicMapsPreview: "true" as unknown as boolean}),
      /explicit boolean opt-in/
    );
  });
});

function resourcesOfType(template: Template, type: string): Array<Record<string, any>> {
  return Object.values(template.findResources(type));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
