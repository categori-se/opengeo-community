import {
  SHA256_PATTERN,
  sealManifest,
  verifyManifestSeal
} from "./release-utils.mjs";

export const AUTOMATED_STUDIO_READINESS_SCHEMA =
  "opengeo.studio-automated-readiness.1.0.0";
export const OPERATOR_STUDIO_ACCEPTANCE_SCHEMA =
  "opengeo.studio-operator-acceptance.1.0.0";
export const AUTOMATED_READINESS_TTL_MS = 60 * 60 * 1000;
export const OPERATOR_ACCEPTANCE_TTL_MS = 30 * 60 * 1000;

const STUDIO_ORIGIN = "https://studio.opengeo.tools";
const AUTOMATED_CHECKS = Object.freeze({
  applicationRoot: "passed",
  demoProject: "passed",
  publicDemo: "passed",
  publicLinksOrigin: "https://opengeo.tools",
  authConfig: "passed",
  sameOriginApiLive: "passed",
  sameOriginApiReady: "passed",
  anonymousApiSessionDenied: "passed",
  pkceAuthorizationRequest: "passed"
});
const OPERATOR_CHECKS = Object.freeze({
  managedLogin: "passed",
  callbackCodeExchange: "passed",
  apiSession: "passed",
  aaronMembershipAndPrivateRead: "passed",
  hostedLogout: "passed",
  credentialMaterialRecorded: false
});

export function studioReleaseIdentityFromManifest(
  manifest,
  {expectedStudioOrigin = STUDIO_ORIGIN} = {}
) {
  verifyManifestSeal(manifest, "Studio release manifest");
  const indexArtifact = manifest.artifactTree?.files
    ?.find(({path}) => path === "index.html");
  if (manifest.schemaVersion !== "opengeo.studio-release.1.0.0"
    || manifest.studioOrigin !== expectedStudioOrigin
    || manifest.authConfig?.path !== "auth-config.json"
    || !indexArtifact
    || !SHA256_PATTERN.test(manifest.artifactTree?.digest ?? "")
    || !SHA256_PATTERN.test(manifest.authConfig?.sha256 ?? "")) {
    throw new Error("Studio release manifest cannot identify a readiness edition");
  }
  return validatedReleaseIdentity({
    releaseManifestSha256: manifest.manifestSha256,
    artifactTreeDigest: manifest.artifactTree.digest,
    indexSha256: indexArtifact.sha256,
    authConfigSha256: manifest.authConfig.sha256
  });
}

export function createAutomatedStudioReadiness({release, checkedAt = new Date()}) {
  const timestamp = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Studio readiness time is invalid");
  const receipt = sealManifest({
    schemaVersion: AUTOMATED_STUDIO_READINESS_SCHEMA,
    checkedAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + AUTOMATED_READINESS_TTL_MS).toISOString(),
    studioOrigin: STUDIO_ORIGIN,
    release: validatedReleaseIdentity(release),
    checks: {...AUTOMATED_CHECKS},
    credentialSubmission: "not-attempted",
    operatorCredentialedAcceptanceRequired: true
  });
  return verifyAutomatedStudioReadiness(receipt, {now: timestamp});
}

export function verifyAutomatedStudioReadiness(receipt, {now = new Date()} = {}) {
  verifyManifestSeal(receipt, "Studio automated readiness receipt");
  assertExactKeys(receipt, [
    "schemaVersion",
    "checkedAt",
    "expiresAt",
    "studioOrigin",
    "release",
    "checks",
    "credentialSubmission",
    "operatorCredentialedAcceptanceRequired",
    "manifestSha256"
  ], "Studio automated readiness receipt");
  if (receipt.schemaVersion !== AUTOMATED_STUDIO_READINESS_SCHEMA
    || receipt.studioOrigin !== STUDIO_ORIGIN
    || receipt.credentialSubmission !== "not-attempted"
    || receipt.operatorCredentialedAcceptanceRequired !== true) {
    throw new Error("Studio automated readiness receipt contract is invalid");
  }
  validatedReleaseIdentity(receipt.release);
  assertExactObject(receipt.checks, AUTOMATED_CHECKS, "Studio automated readiness checks");
  assertFreshWindow({
    checkedAt: receipt.checkedAt,
    expiresAt: receipt.expiresAt,
    ttlMs: AUTOMATED_READINESS_TTL_MS,
    now,
    label: "Studio automated readiness receipt"
  });
  return receipt;
}

export function createOperatorStudioAcceptance({
  automatedReceipt,
  operator,
  acceptedAt = new Date()
}) {
  const timestamp = acceptedAt instanceof Date ? acceptedAt : new Date(acceptedAt);
  const automated = verifyAutomatedStudioReadiness(automatedReceipt, {now: timestamp});
  const acceptedBy = validatedOperator(operator);
  const receipt = sealManifest({
    schemaVersion: OPERATOR_STUDIO_ACCEPTANCE_SCHEMA,
    acceptedAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + OPERATOR_ACCEPTANCE_TTL_MS).toISOString(),
    studioOrigin: STUDIO_ORIGIN,
    automatedReceiptSha256: automated.manifestSha256,
    release: {...automated.release},
    acceptedBy,
    checks: {...OPERATOR_CHECKS}
  });
  return verifyOperatorStudioAcceptance(receipt, automated, {now: timestamp});
}

export function verifyOperatorStudioAcceptance(
  receipt,
  automatedReceipt,
  {now = new Date()} = {}
) {
  const automated = verifyAutomatedStudioReadiness(automatedReceipt, {now});
  verifyManifestSeal(receipt, "Studio operator acceptance receipt");
  assertExactKeys(receipt, [
    "schemaVersion",
    "acceptedAt",
    "expiresAt",
    "studioOrigin",
    "automatedReceiptSha256",
    "release",
    "acceptedBy",
    "checks",
    "manifestSha256"
  ], "Studio operator acceptance receipt");
  if (receipt.schemaVersion !== OPERATOR_STUDIO_ACCEPTANCE_SCHEMA
    || receipt.studioOrigin !== STUDIO_ORIGIN
    || receipt.automatedReceiptSha256 !== automated.manifestSha256
    || JSON.stringify(receipt.release) !== JSON.stringify(automated.release)
    || Date.parse(receipt.acceptedAt) < Date.parse(automated.checkedAt)) {
    throw new Error("Studio operator acceptance is not bound to the automated live check");
  }
  validatedReleaseIdentity(receipt.release);
  validatedOperator(receipt.acceptedBy);
  assertExactObject(receipt.checks, OPERATOR_CHECKS, "Studio operator acceptance checks");
  assertFreshWindow({
    checkedAt: receipt.acceptedAt,
    expiresAt: receipt.expiresAt,
    ttlMs: OPERATOR_ACCEPTANCE_TTL_MS,
    now,
    label: "Studio operator acceptance receipt"
  });
  return receipt;
}

function validatedReleaseIdentity(value) {
  assertExactKeys(value, [
    "releaseManifestSha256",
    "artifactTreeDigest",
    "indexSha256",
    "authConfigSha256"
  ], "Studio readiness release identity");
  for (const digest of Object.values(value)) {
    if (!SHA256_PATTERN.test(digest ?? "")) {
      throw new Error("Studio readiness release identity contains an invalid digest");
    }
  }
  return {...value};
}

function validatedOperator(value) {
  if (typeof value !== "string"
    || value.length < 2
    || value.length > 80
    || !/^[A-Za-z0-9][A-Za-z0-9._@ -]*$/.test(value)) {
    throw new Error("Studio acceptance operator must be a bounded audit label");
  }
  return value;
}

function assertFreshWindow({checkedAt, expiresAt, ttlMs, now, label}) {
  const checked = Date.parse(checkedAt);
  const expires = Date.parse(expiresAt);
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(checked)
    || !Number.isFinite(expires)
    || !Number.isFinite(current)
    || expires !== checked + ttlMs
    || checked > current + 5 * 60 * 1000
    || current > expires) {
    throw new Error(`${label} is expired or has an invalid time window`);
  }
}

function assertExactObject(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} are incomplete`);
  }
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}
