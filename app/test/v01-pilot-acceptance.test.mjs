import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {sealManifest} from "../scripts/release-utils.mjs";
import {
  createV01PilotAcceptance,
  reviewedPilotOrigin,
  verifyV01PilotAcceptance
} from "../scripts/v01-pilot-acceptance.mjs";

const OBSERVED_AT = new Date("2026-09-02T16:00:00.000Z");
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const OPERATOR = "00000000-0000-4000-8000-000000000002";
const REVIEWER = "00000000-0000-4000-8000-000000000003";

describe("v0.1 deployed pilot acceptance receipt", () => {
  it("seals only bounded release, digest, outcome, cost, and cleanup evidence", () => {
    const receipt = acceptance();

    assert.equal(receipt.schemaVersion, "opengeo.v01-deployed-pilot-acceptance.1.1.0");
    assert.equal(receipt.metrics.featureCount, 2);
    assert.equal(receipt.metrics.governedResourceCount, 3);
    assert.equal(receipt.cost.budgetLimitUsd, 100);
    assert.equal(receipt.cleanup.activePublicAcceptanceEdition, false);
    assert.equal(receipt.checks.credentialMaterialRecorded, false);
    assert.equal(verifyV01PilotAcceptance(receipt, {now: OBSERVED_AT}), receipt);
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /00000000-0000-4000|@|access_token|s3:\/\//i);
  });

  it("requires separate production authorization and exact environment selection", () => {
    assert.deepEqual(reviewedPilotOrigin("https://dev.studio.opengeo.tools"), {
      origin: "https://dev.studio.opengeo.tools",
      environment: "development"
    });
    assert.throws(
      () => reviewedPilotOrigin("https://studio.opengeo.tools"),
      /separate authorization/
    );
    assert.equal(
      reviewedPilotOrigin("https://studio.opengeo.tools", {allowProduction: true}).environment,
      "production"
    );
    assert.throws(() => acceptance({environment: "staging"}), /do not match/);
    assert.throws(() => acceptance({origin: "http://localhost:3000"}), /invalid|outside/);
  });

  it("rejects one-person, partial, dirty, costly, or sensitive receipts", () => {
    assert.throws(() => acceptance({reviewerUserId: OPERATOR}), /distinct/);
    assert.throws(() => acceptance({observed: {...checks(), portableZipDownloaded: false}}),
      /portableZipDownloaded/);
    assert.throws(() => acceptance({cleanup: {...cleanup(), project: "active"}}),
      /cleanup.project/);
    assert.throws(() => acceptance({cost: {...cost(), budgetLimitUsd: 1_000}}),
      /\$100/);
    assert.throws(() => acceptance({artifacts: {
      ...artifacts(), originalObjectSha256: "9".repeat(64)
    }}), /does not match/);
    assert.throws(() => acceptance({artifacts: {
      ...artifacts(), invalidOriginalObjectSha256: "9".repeat(64)
    }}), /invalid original does not match/);
    assert.throws(() => acceptance({observed: {...checks(), failedJobDiagnosedInStudio: "pending"}}),
      /failedJobDiagnosedInStudio/);
    assert.throws(() => acceptance({operator: OPERATOR}), /raw identity material/);

    const receipt = acceptance();
    const expanded = sealManifest({...withoutSeal(receipt), reviewerEmail: "reviewer@example.test"});
    assert.throws(() => verifyV01PilotAcceptance(expanded, {now: OBSERVED_AT}),
      /unexpected or missing fields/);
  });
});

function acceptance(overrides = {}) {
  return createV01PilotAcceptance({
    origin: "https://dev.studio.opengeo.tools",
    environment: "development",
    release: {
      studioArtifactTreeDigest: "1".repeat(64),
      apiImageDigest: "2".repeat(64),
      databaseMigration: "0082_unique_governed_map_resources"
    },
    operator: "acceptance-operator",
    organizationId: ORGANIZATION,
    operatorUserId: OPERATOR,
    reviewerUserId: REVIEWER,
    observed: checks(),
    artifacts: artifacts(),
    metrics: {
      featureCount: 2,
      datasetVersionNumber: 1,
      datasetObjectCount: 2,
      governedResourceCount: 3,
      sitePageCount: 2,
      reviewerEditCount: 1,
      elapsedMilliseconds: 43_210
    },
    cost: cost(),
    cleanup: cleanup(),
    observedAt: OBSERVED_AT,
    ...overrides
  });
}

function checks() {
  return {
    operatorManagedLogin: "passed",
    reviewerManagedLogin: "passed",
    identitiesDistinct: "passed",
    exactOrganizationMembership: "passed",
    projectCreated: "passed",
    managedUploadVerified: "passed",
    uploadReplayIdempotent: "passed",
    invalidUploadRejected: "passed",
    invalidUploadOriginalRetained: "passed",
    invalidUploadDerivationDenied: "passed",
    failedJobDiagnosedInStudio: "passed",
    pmtilesDerivativeCompleted: "passed",
    derivativeReplayIdempotent: "passed",
    lineageInspected: "passed",
    metadataValidated: "passed",
    ogcRecordsExported: "passed",
    exactVersionMapReloaded: "passed",
    staleMapWriteDenied: "passed",
    governedResourcesPublished: "passed",
    renderCompleted: "passed",
    invitationAccepted: "passed",
    reviewerEditPersisted: "passed",
    staleSiteWriteDenied: "passed",
    siteReviewedAndPublished: "passed",
    anonymousHtmlRead: "passed",
    portableZipDownloaded: "passed",
    editionRevoked: "passed",
    anonymousReadDeniedAfterRevocation: "passed",
    reviewerAccessRevoked: "passed",
    reviewerOrganizationAccessRevoked: "passed",
    projectArchived: "passed",
    credentialMaterialRecorded: false,
    storageCoordinatesRecorded: false,
    rawIdentityMaterialRecorded: false,
    persistentBrowserContextCreated: false
  };
}

function artifacts() {
  return {
    inputGeojsonSha256: "3".repeat(64),
    originalObjectSha256: "3".repeat(64),
    invalidInputSha256: "7".repeat(64),
    invalidOriginalObjectSha256: "7".repeat(64),
    pmtilesObjectSha256: "4".repeat(64),
    renderObjectSha256: "5".repeat(64),
    portableZipSha256: "6".repeat(64),
    portableZipBytes: 65_536
  };
}

function cost() {
  return {
    budgetLimitUsd: 100,
    observedIncrementalUsd: 0.07,
    fixedInactiveMonthlyUsdAdded: 0,
    monitoring: "passed"
  };
}

function cleanup() {
  return {
    edition: "revoked",
    invitation: "accepted_then_access_revoked",
    reviewerProjectMembership: "revoked",
    reviewerOrganizationMembership: "revoked",
    project: "archived",
    activePublicAcceptanceEdition: false,
    cleanupErrors: 0
  };
}

function withoutSeal(value) {
  const {manifestSha256: _ignored, ...payload} = value;
  return payload;
}
