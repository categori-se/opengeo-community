import {sha256, sealManifest, verifyManifestSeal} from "./release-utils.mjs";

export const V01_PILOT_ACCEPTANCE_SCHEMA =
  "opengeo.v01-deployed-pilot-acceptance.1.1.0";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const MIGRATION = /^\d{4}_[a-z0-9_]+$/;
const CHECKS = Object.freeze({
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
});

const CLEANUP = Object.freeze({
  edition: "revoked",
  invitation: "accepted_then_access_revoked",
  reviewerProjectMembership: "revoked",
  reviewerOrganizationMembership: "revoked",
  project: "archived",
  activePublicAcceptanceEdition: false,
  cleanupErrors: 0
});

export function createV01PilotAcceptance({
  origin,
  environment,
  release,
  operator,
  organizationId,
  operatorUserId,
  reviewerUserId,
  observed,
  artifacts,
  metrics,
  cost,
  cleanup,
  allowProduction = false,
  observedAt = new Date()
}) {
  const timestamp = validDate(observedAt, "pilot observation time");
  const reviewed = reviewedPilotOrigin(origin, {allowProduction});
  if (reviewed.environment !== environment) {
    throw new Error("Pilot origin and environment do not match");
  }
  const organization = uuid(organizationId, "pilot organization id");
  const operatorId = uuid(operatorUserId, "pilot operator user id");
  const reviewerId = uuid(reviewerUserId, "pilot reviewer user id");
  if (operatorId === reviewerId) throw new Error("Pilot identities must be distinct");
  exactObject(observed, CHECKS, "pilot checks");
  exactObject(cleanup, CLEANUP, "pilot cleanup");

  const receipt = sealManifest({
    schemaVersion: V01_PILOT_ACCEPTANCE_SCHEMA,
    observedAt: timestamp.toISOString(),
    origin: reviewed.origin,
    environment,
    release: validatedRelease(release),
    acceptedBy: operatorName(operator),
    identity: {
      organizationIdSha256: sha256(Buffer.from(organization, "utf8")),
      operatorUserIdSha256: sha256(Buffer.from(operatorId, "utf8")),
      reviewerUserIdSha256: sha256(Buffer.from(reviewerId, "utf8")),
      identitiesDistinct: true
    },
    checks: {...CHECKS},
    artifacts: validatedArtifacts(artifacts),
    metrics: validatedMetrics(metrics),
    cost: validatedCost(cost),
    cleanup: {...CLEANUP}
  });
  return verifyV01PilotAcceptance(receipt, {now: timestamp});
}

export function verifyV01PilotAcceptance(receipt, {now = new Date()} = {}) {
  verifyManifestSeal(receipt, "v0.1 deployed pilot acceptance receipt");
  exactKeys(receipt, [
    "schemaVersion", "observedAt", "origin", "environment", "release",
    "acceptedBy", "identity", "checks", "artifacts", "metrics", "cost",
    "cleanup", "manifestSha256"
  ], "v0.1 deployed pilot acceptance receipt");
  if (receipt.schemaVersion !== V01_PILOT_ACCEPTANCE_SCHEMA) {
    throw new Error("Pilot acceptance schema is invalid");
  }
  const reviewed = reviewedPilotOrigin(receipt.origin, {allowProduction: true});
  if (reviewed.environment !== receipt.environment) {
    throw new Error("Pilot origin and environment do not match");
  }
  validatedRelease(receipt.release);
  operatorName(receipt.acceptedBy);
  exactKeys(receipt.identity, [
    "organizationIdSha256", "operatorUserIdSha256", "reviewerUserIdSha256",
    "identitiesDistinct"
  ], "pilot identity");
  for (const key of [
    "organizationIdSha256", "operatorUserIdSha256", "reviewerUserIdSha256"
  ]) digest(receipt.identity[key], `pilot identity.${key}`);
  if (receipt.identity.operatorUserIdSha256 === receipt.identity.reviewerUserIdSha256
    || receipt.identity.identitiesDistinct !== true) {
    throw new Error("Pilot identity evidence is invalid");
  }
  exactObject(receipt.checks, CHECKS, "pilot checks");
  validatedArtifacts(receipt.artifacts);
  validatedMetrics(receipt.metrics);
  validatedCost(receipt.cost);
  exactObject(receipt.cleanup, CLEANUP, "pilot cleanup");
  const observedAt = Date.parse(receipt.observedAt);
  const current = validDate(now, "pilot verification time").getTime();
  if (!Number.isFinite(observedAt) || observedAt > current + 5 * 60_000) {
    throw new Error("Pilot observation time is invalid");
  }
  rejectSensitiveMaterial(receipt);
  return receipt;
}

export function reviewedPilotOrigin(value, {allowProduction = false} = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pilot origin is invalid");
  }
  if (url.origin !== value || url.protocol !== "https:" || url.username
    || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Pilot origin is invalid");
  }
  let environment;
  if (url.hostname === "studio.opengeo.tools") environment = "production";
  else if (url.hostname === "demo.studio.opengeo.tools") environment = "demo";
  else if (url.hostname === "dev.studio.opengeo.tools"
    || /^d[a-z0-9]{5,30}\.cloudfront\.net$/.test(url.hostname)) environment = "development";
  else if (url.hostname === "staging.studio.opengeo.tools") environment = "staging";
  else throw new Error("Pilot origin is outside reviewed OpenGeo origins");
  if (environment === "production" && !allowProduction) {
    throw new Error("Production pilot acceptance requires separate authorization");
  }
  return Object.freeze({origin: url.origin, environment});
}

function validatedRelease(value) {
  const release = record(value, "pilot release");
  exactKeys(release, [
    "studioArtifactTreeDigest", "apiImageDigest", "databaseMigration"
  ], "pilot release");
  return {
    studioArtifactTreeDigest: digest(
      release.studioArtifactTreeDigest,
      "pilot Studio artifact tree digest"
    ),
    apiImageDigest: digest(release.apiImageDigest, "pilot API image digest"),
    databaseMigration: migration(release.databaseMigration)
  };
}

function validatedArtifacts(value) {
  const artifacts = record(value, "pilot artifacts");
  exactKeys(artifacts, [
    "inputGeojsonSha256", "originalObjectSha256", "pmtilesObjectSha256",
    "renderObjectSha256", "portableZipSha256", "portableZipBytes",
    "invalidInputSha256", "invalidOriginalObjectSha256"
  ], "pilot artifacts");
  const input = digest(artifacts.inputGeojsonSha256, "pilot input checksum");
  const original = digest(artifacts.originalObjectSha256, "pilot original checksum");
  if (input !== original) throw new Error("Pilot original object does not match its input");
  const invalidInput = digest(artifacts.invalidInputSha256, "pilot invalid input checksum");
  const invalidOriginal = digest(artifacts.invalidOriginalObjectSha256, "pilot invalid original checksum");
  if (invalidInput !== invalidOriginal) throw new Error("Pilot invalid original does not match its input");
  return {
    inputGeojsonSha256: input,
    originalObjectSha256: original,
    invalidInputSha256: invalidInput,
    invalidOriginalObjectSha256: invalidOriginal,
    pmtilesObjectSha256: digest(
      artifacts.pmtilesObjectSha256,
      "pilot PMTiles checksum"
    ),
    renderObjectSha256: digest(
      artifacts.renderObjectSha256,
      "pilot render checksum"
    ),
    portableZipSha256: digest(
      artifacts.portableZipSha256,
      "pilot portable ZIP checksum"
    ),
    portableZipBytes: integer(
      artifacts.portableZipBytes,
      22,
      33_554_432,
      "pilot portable ZIP size"
    )
  };
}

function validatedMetrics(value) {
  const metrics = record(value, "pilot metrics");
  exactKeys(metrics, [
    "featureCount", "datasetVersionNumber", "datasetObjectCount",
    "governedResourceCount", "sitePageCount", "reviewerEditCount",
    "elapsedMilliseconds"
  ], "pilot metrics");
  return {
    featureCount: exactInteger(metrics.featureCount, 2, "pilot feature count"),
    datasetVersionNumber: exactInteger(
      metrics.datasetVersionNumber,
      1,
      "pilot dataset version number"
    ),
    datasetObjectCount: exactInteger(
      metrics.datasetObjectCount,
      2,
      "pilot dataset object count"
    ),
    governedResourceCount: exactInteger(
      metrics.governedResourceCount,
      3,
      "pilot governed resource count"
    ),
    sitePageCount: exactInteger(metrics.sitePageCount, 2, "pilot site page count"),
    reviewerEditCount: exactInteger(
      metrics.reviewerEditCount,
      1,
      "pilot reviewer edit count"
    ),
    elapsedMilliseconds: integer(
      metrics.elapsedMilliseconds,
      1,
      1_800_000,
      "pilot elapsed time"
    )
  };
}

function validatedCost(value) {
  const cost = record(value, "pilot cost");
  exactKeys(cost, [
    "budgetLimitUsd", "observedIncrementalUsd", "fixedInactiveMonthlyUsdAdded",
    "monitoring"
  ], "pilot cost");
  if (cost.budgetLimitUsd !== 100) throw new Error("Pilot budget limit must be $100");
  if (typeof cost.observedIncrementalUsd !== "number"
    || !Number.isFinite(cost.observedIncrementalUsd)
    || cost.observedIncrementalUsd < 0 || cost.observedIncrementalUsd > 100) {
    throw new Error("Pilot observed incremental cost is invalid");
  }
  if (cost.fixedInactiveMonthlyUsdAdded !== 0 || cost.monitoring !== "passed") {
    throw new Error("Pilot cost controls are incomplete");
  }
  return {
    budgetLimitUsd: 100,
    observedIncrementalUsd: cost.observedIncrementalUsd,
    fixedInactiveMonthlyUsdAdded: 0,
    monitoring: "passed"
  };
}

function rejectSensitiveMaterial(receipt) {
  const serialized = JSON.stringify(receipt);
  if (/bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|password|authorization[_-]?code|x-amz-credential|x-amz-signature|secret[_-]?access[_-]?key/i.test(serialized)) {
    throw new Error("Pilot receipt contains credential material");
  }
  if (/\b[A-Z0-9]{20}\b/.test(serialized)
    || /[?&](?:X-Amz-|Signature=|token=)/i.test(serialized)
    || /s3:\/\/|\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com/i.test(serialized)) {
    throw new Error("Pilot receipt contains storage or signing material");
  }
  if (UUID_IN_TEXT.test(serialized) || /@[a-z0-9.-]+\.[a-z]{2,}/i.test(serialized)) {
    throw new Error("Pilot receipt contains raw identity material");
  }
}

function operatorName(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 80
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value)) {
    throw new Error("Pilot acceptance operator is invalid");
  }
  return value;
}

function migration(value) {
  if (typeof value !== "string" || !MIGRATION.test(value)) {
    throw new Error("Pilot database migration is invalid");
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactInteger(value, expected, label) {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(record(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function exactObject(value, expected, label) {
  exactKeys(value, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`${label}.${key} is invalid`);
  }
}
