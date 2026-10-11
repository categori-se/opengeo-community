import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  createTerrainOutageGuard,
  evaluateTerrainGovernance,
  TERRAIN_GOVERNANCE_LIMITS,
  TERRAIN_SOURCE_RECEIPT,
  terrainActivationDecision,
  terrainDeploymentClass,
  terrainGovernanceMessage
} from "../src/lib/terrainGovernance.js";
import {OPEN_TERRAIN_SOURCE} from "../src/lib/terrainView.js";

const OBSERVED_AT_MS = Date.parse(TERRAIN_SOURCE_RECEIPT.observedAt);

describe("GEP-002D governed terrain activation", () => {
  it("keeps observation age advisory for interactive public-source viewing", () => {
    const fresh = evaluateTerrainGovernance({
      now: OBSERVED_AT_MS + TERRAIN_GOVERNANCE_LIMITS.maximumReceiptAgeMs,
      deploymentClass: "local"
    });
    assert.equal(fresh.allowed, true);
    assert.equal(fresh.status, "fresh-upstream");
    assert.equal(fresh.observedAt, TERRAIN_SOURCE_RECEIPT.observedAt);

    const stale = evaluateTerrainGovernance({
      now: OBSERVED_AT_MS + TERRAIN_GOVERNANCE_LIMITS.maximumReceiptAgeMs + 1,
      deploymentClass: "local"
    });
    assert.equal(stale.allowed, true);
    assert.equal(stale.status, "source-review-due");
    assert.match(terrainGovernanceMessage(stale), /does not prevent viewing/);
  });

  it("rejects tampered receipts and invalid clocks but permits hosted upstream use", () => {
    assert.equal(evaluateTerrainGovernance({
      now: OBSERVED_AT_MS,
      deploymentClass: "local",
      receipt: {...TERRAIN_SOURCE_RECEIPT, tileJsonSha256: "0".repeat(64)}
    }).status, "receipt-invalid");
    assert.equal(evaluateTerrainGovernance({
      now: OBSERVED_AT_MS - TERRAIN_GOVERNANCE_LIMITS.maximumFutureClockSkewMs - 1,
      deploymentClass: "local"
    }).status, "clock-invalid");
    const production = evaluateTerrainGovernance({now: OBSERVED_AT_MS, deploymentClass: "production"});
    assert.equal(production.allowed, true);
    assert.equal(production.status, "fresh-upstream");
    assert.match(terrainGovernanceMessage(production), /No API key or OpenGeo-hosted copy is needed/);
    const older = evaluateTerrainGovernance({now: OBSERVED_AT_MS + 30 * 86400000, deploymentClass: "production"});
    assert.equal(older.status, "source-review-due");
    assert.equal(older.allowed, true);
  });

  it("isolates building failures from terrain and waits for successful recovery", () => {
    let now = OBSERVED_AT_MS;
    const guard = createTerrainOutageGuard({sourceId: "opengeo-openfreemap-3d", now: () => now});
    guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId);
    assert.equal(guard.snapshot().failureCount, 0);
    for (let i = 0; i < 3; i++) guard.recordFailure("opengeo-openfreemap-3d");
    assert.equal(guard.snapshot().allowed, false);
    guard.recordSuccess(OPEN_TERRAIN_SOURCE.sourceId);
    assert.equal(guard.snapshot().allowed, false);
    now += 61_000;
    assert.equal(guard.snapshot().state, "half-open");
    guard.recordSuccess("opengeo-openfreemap-3d");
    assert.equal(guard.snapshot().state, "closed");
  });

  it("classifies only explicit loopback and file locations as local", () => {
    assert.equal(terrainDeploymentClass({protocol: "http:", hostname: "127.0.0.1"}), "local");
    assert.equal(terrainDeploymentClass({protocol: "https:", hostname: "localhost"}), "local");
    assert.equal(terrainDeploymentClass({protocol: "file:", hostname: ""}), "local");
    assert.equal(terrainDeploymentClass({protocol: "https:", hostname: "studio.opengeo.tools"}), "production");
    assert.equal(terrainDeploymentClass({protocol: "https:", hostname: "localhost.attacker.test"}), "production");
  });

  it("opens after three bounded consecutive source failures and recovers only after cooldown success", () => {
    let now = OBSERVED_AT_MS;
    const guard = createTerrainOutageGuard({now: () => now});
    const governance = evaluateTerrainGovernance({now, deploymentClass: "local"});
    assert.equal(terrainActivationDecision(governance, guard.snapshot()).allowed, true);
    guard.recordFailure("unrelated-source");
    assert.equal(guard.snapshot().failureCount, 0);
    guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId);
    now += 1_000;
    guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId);
    now += 1_000;
    const opened = guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId);
    assert.equal(opened.state, "open");
    assert.equal(terrainActivationDecision(governance, opened).status, "source-outage");
    now = opened.retryAt;
    assert.equal(guard.snapshot().state, "half-open");
    assert.equal(guard.snapshot().allowed, true);
    assert.equal(guard.recordSuccess(OPEN_TERRAIN_SOURCE.sourceId).state, "closed");
    assert.equal(guard.snapshot().failureCount, 0);
  });

  it("expires separated failures outside the consecutive-failure window", () => {
    let now = OBSERVED_AT_MS;
    const guard = createTerrainOutageGuard({now: () => now});
    guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId);
    now += TERRAIN_GOVERNANCE_LIMITS.sourceFailureWindowMs + 1;
    assert.equal(guard.recordFailure(OPEN_TERRAIN_SOURCE.sourceId).failureCount, 1);
    assert.equal(guard.snapshot().state, "closed");
  });
});
