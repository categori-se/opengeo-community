import {OPEN_TERRAIN_SOURCE} from "./terrainView.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const TERRAIN_SOURCE_RECEIPT = deepFreeze({
  schemaVersion: "1.0.0",
  sourceId: OPEN_TERRAIN_SOURCE.sourceId,
  observedAt: "2026-09-09T11:09:36.015Z",
  tileJsonSha256: "d28ade7b57a0c28f8f5d3f3f1b3f07e0c20306ea9e223c4f3dcffc5854f11543",
  attributionCatalogSha256: "b08e92dd30d84f62e177ad953a1973dbdadc8726de14d3b637341cce50daa601",
  representativeTileSha256: "454bc44daadc2419e78530d619d7c23a8ea49b5fa12d4d8e2a821d3b646ecd6d"
});

export const TERRAIN_GOVERNANCE_LIMITS = Object.freeze({
  maximumReceiptAgeMs: 7 * DAY_MS,
  maximumFutureClockSkewMs: DAY_MS,
  maximumConsecutiveSourceFailures: 3,
  sourceFailureWindowMs: 30_000,
  sourceRetryCooldownMs: 60_000
});

export function terrainDeploymentClass(location = globalThis.location) {
  const hostname = String(location?.hostname ?? "").toLowerCase();
  const protocol = String(location?.protocol ?? "").toLowerCase();
  if (protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return "local";
  }
  return "production";
}

export function evaluateTerrainGovernance({
  now = Date.now(),
  deploymentClass = terrainDeploymentClass(),
  receipt = TERRAIN_SOURCE_RECEIPT
} = {}) {
  if (!validReceipt(receipt)) {
    return governanceResult(false, "receipt-invalid", deploymentClass, null, null);
  }
  const observedAtMs = Date.parse(receipt.observedAt);
  const ageMs = now - observedAtMs;
  if (!Number.isFinite(now) || ageMs < -TERRAIN_GOVERNANCE_LIMITS.maximumFutureClockSkewMs) {
    return governanceResult(false, "clock-invalid", deploymentClass, receipt.observedAt, ageMs);
  }
  // Interactive viewing uses the public provider on hosted and local sites.
  // Observation age is maintenance information, not a provider access expiry.
  if (ageMs > TERRAIN_GOVERNANCE_LIMITS.maximumReceiptAgeMs) {
    return governanceResult(true, "source-review-due", deploymentClass, receipt.observedAt, ageMs);
  }
  return governanceResult(true, "fresh-upstream", deploymentClass, receipt.observedAt, ageMs);
}

export function createTerrainOutageGuard({now = () => Date.now(), sourceId = OPEN_TERRAIN_SOURCE.sourceId} = {}) {
  let failures = [];
  let openUntilMs = null;

  function snapshot() {
    const current = now();
    if (Number.isFinite(openUntilMs) && current >= openUntilMs) {
      return outageResult(true, "half-open", failures.length, openUntilMs);
    }
    if (Number.isFinite(openUntilMs)) {
      return outageResult(false, "open", failures.length, openUntilMs);
    }
    return outageResult(true, "closed", failures.length, null);
  }

  return Object.freeze({
    snapshot,
    recordFailure(failedSourceId) {
      if (failedSourceId !== sourceId) return snapshot();
      const current = now();
      if (!Number.isFinite(current)) return snapshot();
      failures = failures.filter((at) => current - at <= TERRAIN_GOVERNANCE_LIMITS.sourceFailureWindowMs);
      failures.push(current);
      if (failures.length >= TERRAIN_GOVERNANCE_LIMITS.maximumConsecutiveSourceFailures) {
        openUntilMs = current + TERRAIN_GOVERNANCE_LIMITS.sourceRetryCooldownMs;
      }
      return snapshot();
    },
    recordSuccess(loadedSourceId) {
      if (loadedSourceId !== sourceId) return snapshot();
      failures = [];
      openUntilMs = null;
      return snapshot();
    }
  });
}

export function terrainActivationDecision(governance, outage) {
  if (!governance?.allowed) return {...governance, outageState: outage?.state ?? "closed"};
  if (!outage?.allowed) {
    return {
      ...governance,
      allowed: false,
      status: "source-outage",
      outageState: outage.state,
      retryAt: outage.retryAt
    };
  }
  return {...governance, outageState: outage?.state ?? "closed"};
}

export function terrainGovernanceMessage(decision) {
  switch (decision?.status) {
    case "fresh-upstream":
      return "Terrain loads directly from Mapterhorn. No API key or OpenGeo-hosted copy is needed; availability depends on the provider.";
    case "source-review-due":
      return "Terrain loads directly from Mapterhorn. Its recorded source check is due for review; this does not prevent viewing.";
    case "receipt-invalid":
      return "Open terrain is disabled because its source audit receipt is invalid.";
    case "clock-invalid":
      return "Open terrain is disabled because receipt freshness cannot be established from this clock.";
    case "source-outage":
      return "Terrain is temporarily unavailable. Your basemap and layers remain in place. Wait one minute, then retry Terrain.";
    default:
      return "Open terrain governance state is unavailable.";
  }
}

function validReceipt(receipt) {
  return receipt?.schemaVersion === TERRAIN_SOURCE_RECEIPT.schemaVersion
    && receipt?.sourceId === TERRAIN_SOURCE_RECEIPT.sourceId
    && receipt?.observedAt === TERRAIN_SOURCE_RECEIPT.observedAt
    && receipt?.tileJsonSha256 === TERRAIN_SOURCE_RECEIPT.tileJsonSha256
    && receipt?.attributionCatalogSha256 === TERRAIN_SOURCE_RECEIPT.attributionCatalogSha256
    && receipt?.representativeTileSha256 === TERRAIN_SOURCE_RECEIPT.representativeTileSha256;
}

function governanceResult(allowed, status, deploymentClass, observedAt, ageMs) {
  return {
    allowed,
    status,
    deploymentClass,
    observedAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : null
  };
}

function outageResult(allowed, state, failureCount, retryAt) {
  return {allowed, state, failureCount, retryAt};
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}
