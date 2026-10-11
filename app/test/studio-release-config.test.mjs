import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  PRODUCTION_ACCOUNT,
  PRODUCTION_FUTURE_STUDIO_BUCKET,
  PRODUCTION_STUDIO_BUCKET,
  PRODUCTION_STUDIO_ORIGIN,
  PRODUCTION_STUDIO_STACK,
  reviewedCloudFrontDomain,
  reviewedStudioOrigin,
  studioDeploymentSettings
} from "../scripts/studio-release-config.mjs";

describe("Studio release deployment boundary", () => {
  it("accepts only the reviewed production, development, managed-demo, or CloudFront origins", () => {
    assert.equal(reviewedStudioOrigin(PRODUCTION_STUDIO_ORIGIN), PRODUCTION_STUDIO_ORIGIN);
    assert.equal(
      reviewedStudioOrigin("https://dev.studio.opengeo.tools"),
      "https://dev.studio.opengeo.tools"
    );
    assert.equal(
      reviewedStudioOrigin("https://demo.studio.opengeo.tools"),
      "https://demo.studio.opengeo.tools"
    );
    assert.equal(
      reviewedStudioOrigin("https://d1234567890.cloudfront.net"),
      "https://d1234567890.cloudfront.net"
    );
    for (const value of [
      "http://dev.studio.opengeo.tools",
      "https://attacker.example",
      "https://dev.studio.opengeo.tools/path",
      "https://studio.opengeo.tools:444"
    ]) {
      assert.throws(() => reviewedStudioOrigin(value), /exact reviewed HTTPS origin/);
    }
  });

  it("requires an exact CloudFront distribution domain", () => {
    assert.equal(
      reviewedCloudFrontDomain("d1234567890.cloudfront.net"),
      "d1234567890.cloudfront.net"
    );
    assert.throws(
      () => reviewedCloudFrontDomain("studio.opengeo.tools"),
      /exact CloudFront distribution domain/
    );
  });

  it("defaults production releases to the established retained Studio bucket", () => {
    const settings = withEnvironment({
      OPEN_GEO_STUDIO_ORIGIN: PRODUCTION_STUDIO_ORIGIN,
      OPEN_GEO_STUDIO_BUCKET: undefined,
      OPEN_GEO_STUDIO_STACK_NAME: PRODUCTION_STUDIO_STACK,
      OPEN_GEO_STUDIO_EXPECTED_ACCOUNT: PRODUCTION_ACCOUNT,
      OPEN_GEO_AWS_PROFILE: "opengeo-production-operator"
    }, studioDeploymentSettings);
    assert.equal(settings.bucket, "studio.opengeo.tools");
    assert.equal(settings.bucket, PRODUCTION_STUDIO_BUCKET);
    assert.equal(settings.expectedOriginDomain, "studio.opengeo.tools.s3.us-east-1.amazonaws.com");
  });

  it("accepts the future code-defined bucket only when selected explicitly", () => {
    const settings = withEnvironment({
      OPEN_GEO_STUDIO_ORIGIN: PRODUCTION_STUDIO_ORIGIN,
      OPEN_GEO_STUDIO_BUCKET: PRODUCTION_FUTURE_STUDIO_BUCKET,
      OPEN_GEO_STUDIO_STACK_NAME: PRODUCTION_STUDIO_STACK,
      OPEN_GEO_STUDIO_EXPECTED_ACCOUNT: PRODUCTION_ACCOUNT,
      OPEN_GEO_AWS_PROFILE: "opengeo-production-operator"
    }, studioDeploymentSettings);
    assert.equal(settings.bucket, PRODUCTION_FUTURE_STUDIO_BUCKET);
    assert.equal(
      settings.expectedOriginDomain,
      `${PRODUCTION_FUTURE_STUDIO_BUCKET}.s3.us-east-1.amazonaws.com`
    );
  });

  it("rejects every other production Studio bucket", () => {
    assert.throws(
      () => withEnvironment({
        OPEN_GEO_STUDIO_ORIGIN: PRODUCTION_STUDIO_ORIGIN,
        OPEN_GEO_STUDIO_BUCKET: "unreviewed-production-studio",
        OPEN_GEO_STUDIO_STACK_NAME: PRODUCTION_STUDIO_STACK,
        OPEN_GEO_STUDIO_EXPECTED_ACCOUNT: PRODUCTION_ACCOUNT
      }, studioDeploymentSettings),
      /complete reviewed production or development tuple/
    );
  });
});

function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
