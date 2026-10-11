import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {sealManifest} from "../scripts/release-utils.mjs";
import {
  AUTOMATED_READINESS_TTL_MS,
  createAutomatedStudioReadiness,
  createOperatorStudioAcceptance,
  verifyAutomatedStudioReadiness,
  verifyOperatorStudioAcceptance
} from "../scripts/studio-readiness.mjs";

const CHECKED_AT = new Date("2026-08-21T14:00:00.000Z");
const RELEASE = Object.freeze({
  releaseManifestSha256: "1".repeat(64),
  artifactTreeDigest: "2".repeat(64),
  indexSha256: "3".repeat(64),
  authConfigSha256: "4".repeat(64)
});

describe("Studio cutover readiness receipts", () => {
  it("seals a bounded credential-free automated live receipt", () => {
    const receipt = createAutomatedStudioReadiness({release: RELEASE, checkedAt: CHECKED_AT});
    assert.equal(receipt.credentialSubmission, "not-attempted");
    assert.equal(receipt.operatorCredentialedAcceptanceRequired, true);
    assert.equal(receipt.checks.pkceAuthorizationRequest, "passed");
    assert.equal(receipt.checks.sameOriginApiLive, "passed");
    assert.equal(receipt.checks.sameOriginApiReady, "passed");
    assert.equal(receipt.checks.anonymousApiSessionDenied, "passed");
    assert.equal(receipt.release.indexSha256, RELEASE.indexSha256);
    assert.equal(
      verifyAutomatedStudioReadiness(receipt, {now: new Date(CHECKED_AT.getTime() + 1_000)}),
      receipt
    );
    assert.doesNotMatch(JSON.stringify(receipt), /token|authorizationCode|password/i);
  });

  it("rejects expired or expanded automated receipts", () => {
    const receipt = createAutomatedStudioReadiness({release: RELEASE, checkedAt: CHECKED_AT});
    assert.throws(
      () => verifyAutomatedStudioReadiness(receipt, {
        now: new Date(CHECKED_AT.getTime() + AUTOMATED_READINESS_TTL_MS + 1)
      }),
      /expired or has an invalid time window/
    );
    const expanded = sealManifest({...withoutSeal(receipt), accessToken: "must-not-be-recorded"});
    assert.throws(
      () => verifyAutomatedStudioReadiness(expanded, {now: CHECKED_AT}),
      /unexpected or missing fields/
    );
  });

  it("binds later operator acceptance to the same fresh automated release", () => {
    const automated = createAutomatedStudioReadiness({release: RELEASE, checkedAt: CHECKED_AT});
    const acceptedAt = new Date(CHECKED_AT.getTime() + 5 * 60 * 1000);
    const acceptance = createOperatorStudioAcceptance({
      automatedReceipt: automated,
      operator: "aaron-dennis",
      acceptedAt
    });
    assert.equal(acceptance.checks.aaronMembershipAndPrivateRead, "passed");
    assert.equal(acceptance.checks.credentialMaterialRecorded, false);
    assert.equal(
      verifyOperatorStudioAcceptance(acceptance, automated, {now: acceptedAt}),
      acceptance
    );
  });

  it("rejects acceptance recorded before its automated check", () => {
    const automated = createAutomatedStudioReadiness({release: RELEASE, checkedAt: CHECKED_AT});
    assert.throws(
      () => createOperatorStudioAcceptance({
        automatedReceipt: automated,
        operator: "aaron-dennis",
        acceptedAt: new Date(CHECKED_AT.getTime() - 60_000)
      }),
      /not bound to the automated live check/
    );
  });
});

function withoutSeal(value) {
  const {manifestSha256: _ignored, ...payload} = value;
  return payload;
}
