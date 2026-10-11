import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {sealManifest} from "../scripts/release-utils.mjs";
import {
  createManagedLoginAcceptance,
  validateManagedLoginSession,
  verifyManagedLoginAcceptance
} from "../scripts/managed-login-acceptance.mjs";

const OBSERVED_AT = new Date("2026-08-26T12:00:00.000Z");
const USER_ID = "7f6cdbbc-f4b9-427d-af1d-d892dfed79ec";
const ORGANIZATION_ID = "61249dd8-69fa-4c9c-a171-bf3e5243f835";
const RELEASE = Object.freeze({
  releaseManifestSha256: "1".repeat(64),
  artifactTreeDigest: "2".repeat(64),
  indexSha256: "3".repeat(64),
  authConfigSha256: "4".repeat(64)
});
const SESSION = Object.freeze({
  user_id: USER_ID,
  email: "operator@example.invalid",
  display_name: "Operator",
  selected_organization_id: ORGANIZATION_ID,
  memberships: [{organization_id: ORGANIZATION_ID, role: "admin"}]
});

describe("Managed-login browser acceptance", () => {
  it("matches the stable internal user and exact organization membership", () => {
    assert.deepEqual(
      validateManagedLoginSession(SESSION, {
        expectedUserId: USER_ID,
        expectedOrganizationId: ORGANIZATION_ID
      }),
      {
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        membershipCount: 1
      }
    );
    assert.throws(() => validateManagedLoginSession(SESSION, {
      expectedUserId: "00000000-0000-4000-8000-000000000001",
      expectedOrganizationId: ORGANIZATION_ID
    }), /different internal user/);
    assert.throws(() => validateManagedLoginSession(SESSION, {
      expectedUserId: USER_ID,
      expectedOrganizationId: "00000000-0000-4000-8000-000000000002"
    }), /expected organization membership/);
  });

  it("seals only release, identity-digest, boolean, and count evidence", () => {
    const receipt = acceptance();
    assert.equal(receipt.checks.managedLogin, "passed");
    assert.equal(receipt.checks.browserContextPersistence, "ephemeral");
    assert.equal(receipt.checks.credentialMaterialRecorded, false);
    assert.equal(receipt.checks.providerIdentityMaterialRecorded, false);
    assert.equal(receipt.metrics.privateProjectCount, 3);
    assert.equal(receipt.metrics.editableProjectCount, 2);
    assert.equal(receipt.metrics.sharedDatasetProjectCount, 2);
    assert.equal(receipt.metrics.governedFeatureCount, 6);
    assert.equal(receipt.metrics.narrowViewportWidth, 390);
    assert.equal(receipt.metrics.minimumStatusContrastRatioTimes100, 735);
    assert.equal(
      verifyManagedLoginAcceptance(receipt, {now: OBSERVED_AT}),
      receipt
    );
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /operator@example\.invalid|7f6cdbbc|61249dd8/);
    assert.doesNotMatch(serialized, /access_token|password|authorization_code/i);
  });

  it("rejects incomplete browser observations and added identity material", () => {
    assert.throws(() => acceptance({hostedLogoutObserved: false}),
      /observations are incomplete/);
    assert.throws(() => acceptance({governedFeatureCount: 5}),
      /governed feature count is invalid/);
    assert.throws(() => acceptance({minimumStatusContrastRatioTimes100: 699}),
      /status contrast ratio is invalid/);
    const valid = acceptance();
    const expanded = sealManifest({
      ...withoutSeal(valid),
      email: "must-not-be-recorded@example.invalid"
    });
    assert.throws(
      () => verifyManagedLoginAcceptance(expanded, {now: OBSERVED_AT}),
      /unexpected or missing fields/
    );
  });
});

function acceptance(overrides = {}) {
  return createManagedLoginAcceptance({
    origin: "https://d27oi53tjzmbe8.cloudfront.net",
    release: RELEASE,
    operator: "aaron-dennis",
    expectedUserId: USER_ID,
    expectedOrganizationId: ORGANIZATION_ID,
    observedSession: SESSION,
    projectCount: 3,
    editableProjectCount: 2,
    sharedDatasetProjectCount: 2,
    governedFeatureCount: 6,
    narrowViewportWidth: 390,
    minimumStatusContrastRatioTimes100: 735,
    authorizeObserved: true,
    callbackObserved: true,
    tokenExchangeObserved: true,
    twoEditableProjectsOpened: true,
    sharedDatasetMatched: true,
    independentStylesMatched: true,
    persistedStyleReloadsObserved: true,
    governedFeaturesReloaded: true,
    linkedDatasetDetachGuardObserved: true,
    narrowViewportLayoutPassed: true,
    statusContrastPassed: true,
    hostedLogoutObserved: true,
    signedOutStateObserved: true,
    observedAt: OBSERVED_AT,
    ...overrides
  });
}

function withoutSeal(value) {
  const {manifestSha256: _ignored, ...payload} = value;
  return payload;
}
