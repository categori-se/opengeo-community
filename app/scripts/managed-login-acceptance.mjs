import {sha256, sealManifest, verifyManifestSeal} from "./release-utils.mjs";

export const MANAGED_LOGIN_ACCEPTANCE_SCHEMA =
  "opengeo.managed-login-browser-acceptance.1.1.0";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLES = new Set(["admin", "owner", "editor", "reviewer", "viewer"]);
const CHECKS = Object.freeze({
  managedLogin: "passed",
  callbackCodeExchange: "passed",
  apiSession: "passed",
  exactUserMembership: "passed",
  privateProjectDirectory: "passed",
  twoEditableProjectsOpen: "passed",
  sharedGovernedDataset: "passed",
  independentProjectStyles: "passed",
  persistedStyleReloads: "passed",
  governedFeaturesReloaded: "passed",
  linkedDatasetDetachGuard: "passed",
  narrowViewportLayout: "passed",
  statusContrast: "passed",
  hostedLogout: "passed",
  signedOutState: "passed",
  credentialMaterialRecorded: false,
  providerIdentityMaterialRecorded: false,
  browserContextPersistence: "ephemeral"
});

export function validateManagedLoginSession(
  value,
  {expectedUserId, expectedOrganizationId}
) {
  const session = object(value, "managed-login API session");
  const userId = uuid(session.user_id, "managed-login user id");
  const organizationId = uuid(
    expectedOrganizationId,
    "expected managed-login organization id"
  );
  if (userId !== uuid(expectedUserId, "expected managed-login user id")) {
    throw new Error("Managed login resolved a different internal user");
  }
  if (!Array.isArray(session.memberships) || session.memberships.length < 1) {
    throw new Error("Managed login resolved no organization memberships");
  }
  const memberships = session.memberships.map((membership) => {
    const record = object(membership, "managed-login membership");
    const role = boundedString(record.role, "managed-login membership role", 32);
    if (!ROLES.has(role)) throw new Error("Managed login returned an invalid membership role");
    return {
      organizationId: uuid(
        record.organization_id,
        "managed-login membership organization id"
      ),
      role
    };
  });
  if (!memberships.some((membership) => membership.organizationId === organizationId)) {
    throw new Error("Managed login did not resolve the expected organization membership");
  }
  return Object.freeze({
    userId,
    organizationId,
    membershipCount: memberships.length
  });
}

export function createManagedLoginAcceptance({
  origin,
  release,
  operator,
  expectedUserId,
  expectedOrganizationId,
  observedSession,
  projectCount,
  editableProjectCount,
  sharedDatasetProjectCount,
  governedFeatureCount,
  narrowViewportWidth,
  minimumStatusContrastRatioTimes100,
  authorizeObserved,
  callbackObserved,
  tokenExchangeObserved,
  twoEditableProjectsOpened,
  sharedDatasetMatched,
  independentStylesMatched,
  persistedStyleReloadsObserved,
  governedFeaturesReloaded,
  linkedDatasetDetachGuardObserved,
  narrowViewportLayoutPassed,
  statusContrastPassed,
  hostedLogoutObserved,
  signedOutStateObserved,
  observedAt = new Date()
}) {
  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Managed-login acceptance time is invalid");
  }
  const session = validateManagedLoginSession(observedSession, {
    expectedUserId,
    expectedOrganizationId
  });
  const count = boundedCount(projectCount, "managed-login private project count");
  const editableCount = exactCount(
    editableProjectCount,
    2,
    "managed-login editable project count"
  );
  const sharedProjectCount = exactCount(
    sharedDatasetProjectCount,
    2,
    "managed-login shared dataset project count"
  );
  const featureCount = exactCount(
    governedFeatureCount,
    6,
    "managed-login governed feature count"
  );
  const viewportWidth = exactCount(
    narrowViewportWidth,
    390,
    "managed-login narrow viewport width"
  );
  const contrastRatioTimes100 = boundedContrast(
    minimumStatusContrastRatioTimes100
  );
  const observed = {
    authorizeObserved,
    callbackObserved,
    tokenExchangeObserved,
    twoEditableProjectsOpened,
    sharedDatasetMatched,
    independentStylesMatched,
    persistedStyleReloadsObserved,
    governedFeaturesReloaded,
    linkedDatasetDetachGuardObserved,
    narrowViewportLayoutPassed,
    statusContrastPassed,
    hostedLogoutObserved,
    signedOutStateObserved
  };
  if (Object.values(observed).some((value) => value !== true)) {
    throw new Error("Managed-login browser observations are incomplete");
  }
  const receipt = sealManifest({
    schemaVersion: MANAGED_LOGIN_ACCEPTANCE_SCHEMA,
    observedAt: timestamp.toISOString(),
    origin: reviewedOrigin(origin),
    release: validatedRelease(release),
    acceptedBy: validatedOperator(operator),
    identity: {
      expectedUserIdSha256: sha256(Buffer.from(session.userId, "utf8")),
      expectedOrganizationIdSha256: sha256(
        Buffer.from(session.organizationId, "utf8")
      ),
      stableInternalUserMatched: true,
      organizationMembershipMatched: true
    },
    checks: {...CHECKS},
    metrics: {
      membershipCount: session.membershipCount,
      privateProjectCount: count,
      editableProjectCount: editableCount,
      sharedDatasetProjectCount: sharedProjectCount,
      governedFeatureCount: featureCount,
      narrowViewportWidth: viewportWidth,
      minimumStatusContrastRatioTimes100: contrastRatioTimes100
    }
  });
  return verifyManagedLoginAcceptance(receipt, {now: timestamp});
}

export function verifyManagedLoginAcceptance(receipt, {now = new Date()} = {}) {
  verifyManifestSeal(receipt, "Managed-login browser acceptance receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "observedAt",
    "origin",
    "release",
    "acceptedBy",
    "identity",
    "checks",
    "metrics",
    "manifestSha256"
  ], "Managed-login browser acceptance receipt");
  if (receipt.schemaVersion !== MANAGED_LOGIN_ACCEPTANCE_SCHEMA) {
    throw new Error("Managed-login browser acceptance schema is invalid");
  }
  reviewedOrigin(receipt.origin);
  validatedRelease(receipt.release);
  validatedOperator(receipt.acceptedBy);
  exactObject(receipt.identity, {
    expectedUserIdSha256: receipt.identity?.expectedUserIdSha256,
    expectedOrganizationIdSha256: receipt.identity?.expectedOrganizationIdSha256,
    stableInternalUserMatched: true,
    organizationMembershipMatched: true
  }, "Managed-login identity checks");
  if (!SHA256_PATTERN.test(receipt.identity.expectedUserIdSha256 ?? "")
    || !SHA256_PATTERN.test(receipt.identity.expectedOrganizationIdSha256 ?? "")) {
    throw new Error("Managed-login identity digests are invalid");
  }
  exactObject(receipt.checks, CHECKS, "Managed-login browser checks");
  exactKeys(receipt.metrics, [
    "membershipCount",
    "privateProjectCount",
    "editableProjectCount",
    "sharedDatasetProjectCount",
    "governedFeatureCount",
    "narrowViewportWidth",
    "minimumStatusContrastRatioTimes100"
  ],
    "Managed-login acceptance metrics");
  boundedCount(receipt.metrics.membershipCount, "managed-login membership count");
  boundedCount(receipt.metrics.privateProjectCount, "managed-login private project count");
  exactCount(receipt.metrics.editableProjectCount, 2,
    "managed-login editable project count");
  exactCount(receipt.metrics.sharedDatasetProjectCount, 2,
    "managed-login shared dataset project count");
  exactCount(receipt.metrics.governedFeatureCount, 6,
    "managed-login governed feature count");
  exactCount(receipt.metrics.narrowViewportWidth, 390,
    "managed-login narrow viewport width");
  boundedContrast(receipt.metrics.minimumStatusContrastRatioTimes100);
  const observed = Date.parse(receipt.observedAt);
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(observed)
    || !Number.isFinite(current)
    || observed > current + 5 * 60 * 1000) {
    throw new Error("Managed-login browser acceptance time is invalid");
  }
  rejectCredentialMaterial(receipt);
  return receipt;
}

function validatedRelease(value) {
  const release = object(value, "managed-login release identity");
  exactKeys(release, [
    "releaseManifestSha256",
    "artifactTreeDigest",
    "indexSha256",
    "authConfigSha256"
  ], "Managed-login release identity");
  for (const digest of Object.values(release)) {
    if (!SHA256_PATTERN.test(digest ?? "")) {
      throw new Error("Managed-login release identity contains an invalid digest");
    }
  }
  return {...release};
}

function reviewedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Managed-login origin is invalid");
  }
  const hostname = url.hostname;
  if (url.origin !== value
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !(
      ["studio.opengeo.tools", "dev.studio.opengeo.tools"].includes(hostname)
      || /^d[a-z0-9]{5,30}\.cloudfront\.net$/.test(hostname)
    )) {
    throw new Error("Managed-login origin is outside the reviewed Studio origins");
  }
  return url.origin;
}

function validatedOperator(value) {
  if (typeof value !== "string"
    || value.length < 2
    || value.length > 80
    || !/^[A-Za-z0-9][A-Za-z0-9._@ -]*$/.test(value)) {
    throw new Error("Managed-login acceptance operator is invalid");
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string"
    || !value
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactCount(value, expected, label) {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return value;
}

function boundedContrast(value) {
  if (!Number.isSafeInteger(value) || value < 700 || value > 2100) {
    throw new Error("managed-login status contrast ratio is invalid");
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactObject(actual, expected, label) {
  exactKeys(actual, Object.keys(expected), label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} are incomplete`);
  }
}

function exactKeys(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function rejectCredentialMaterial(value) {
  const serialized = JSON.stringify(value);
  if (/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(serialized)
    || /(?:^|[?&])(?:code|state|token|password|secret)=/i.test(serialized)) {
    throw new Error("Managed-login receipt contains credential material");
  }
  const forbiddenKeys = new Set([
    "access_token",
    "accessToken",
    "authorization_code",
    "authorizationCode",
    "code",
    "email",
    "id_token",
    "password",
    "refresh_token",
    "secret",
    "state",
    "subject",
    "token"
  ]);
  const visit = (record) => {
    if (!record || typeof record !== "object") return;
    for (const [key, child] of Object.entries(record)) {
      if (forbiddenKeys.has(key)) {
        throw new Error("Managed-login receipt contains a forbidden identity or credential field");
      }
      visit(child);
    }
  };
  visit(value);
}
