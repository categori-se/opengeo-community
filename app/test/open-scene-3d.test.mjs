import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  applyOpenScene3d,
  evaluateOpenScene3dGovernance,
  normalizeOpenScene3d,
  OPEN_3D_SCENE_LAYERS,
  OPEN_3D_SCENE_LIMITS,
  OPEN_3D_SCENE_RECEIPT,
  OPEN_3D_SCENE_SOURCE,
  openScene3dForProject,
  openScene3dForSave,
  openScene3dLayerSpecifications,
  openScene3dSourceSpecification
} from "../src/lib/openScene3d.js";

const OBSERVED_AT_MS = Date.parse(OPEN_3D_SCENE_RECEIPT.observedAt);

describe("GEP-002E open 3D scene contract", () => {
  it("pins credential-free OpenMapTiles building and woodland layers with complete attribution", () => {
    const source = openScene3dSourceSpecification();
    const layers = openScene3dLayerSpecifications();
    assert.equal(source.tiles[0], OPEN_3D_SCENE_SOURCE.tileUrl);
    assert.equal(new URL(source.tiles[0]).hostname, "tiles.openfreemap.org");
    assert.ok(!source.tiles[0].includes("?"));
    assert.equal(source.maxzoom, 14);
    assert.deepEqual(source.bounds, [-180, -85.05113, 180, 85.05113]);
    assert.match(source.attribution, /OpenFreeMap/);
    assert.match(source.attribution, /OpenMapTiles/);
    assert.match(source.attribution, /OpenStreetMap/);
    assert.deepEqual(layers.map(({id}) => id), [
      OPEN_3D_SCENE_LAYERS.woodlandCanopy,
      OPEN_3D_SCENE_LAYERS.buildings
    ]);
    assert.equal(layers[0]["source-layer"], "landcover");
    assert.equal(layers[0].paint["fill-extrusion-height"], 8);
    assert.equal(layers[1]["source-layer"], "building");
    assert.equal(layers[1].minzoom, OPEN_3D_SCENE_LIMITS.minimumDetailZoom);
  });

  it("normalizes saved state without accepting source or snapshot substitution", () => {
    assert.deepEqual(openScene3dForProject({openScene3d: {
      enabled: true,
      sourceId: "attacker",
      snapshotVersion: "future"
    }}), {
      enabled: true,
      sourceId: OPEN_3D_SCENE_SOURCE.sourceId,
      snapshotVersion: OPEN_3D_SCENE_SOURCE.snapshotVersion
    });
    assert.deepEqual(openScene3dForSave(false), normalizeOpenScene3d(null));
  });

  it("allows direct hosted viewing and treats old checks as maintenance notices", () => {
    assert.equal(evaluateOpenScene3dGovernance({now: OBSERVED_AT_MS, deploymentClass: "local"}).status, "fresh-upstream");
    assert.equal(evaluateOpenScene3dGovernance({
      now: OBSERVED_AT_MS + OPEN_3D_SCENE_LIMITS.maximumReceiptAgeMs + 1,
      deploymentClass: "local"
    }).status, "source-review-due");
    assert.equal(evaluateOpenScene3dGovernance({now: OBSERVED_AT_MS, deploymentClass: "production"}).allowed, true);
    const older = evaluateOpenScene3dGovernance({now: OBSERVED_AT_MS + 30 * 86400000, deploymentClass: "production"});
    assert.equal(older.status, "source-review-due");
    assert.equal(older.allowed, true);
    assert.equal(evaluateOpenScene3dGovernance({
      now: OBSERVED_AT_MS,
      deploymentClass: "local",
      receipt: {...OPEN_3D_SCENE_RECEIPT, representativeTileSha256: "0".repeat(64)}
    }).status, "receipt-invalid");
  });

  it("adds both bounded extrusion layers only on an allowed globe and removes them cleanly", () => {
    const map = fakeMap();
    const activation = {allowed: true, status: "fresh-upstream"};
    assert.deepEqual(applyOpenScene3d(map, true, {globe: true, activation}), {
      requested: true,
      effective: true,
      fallback: false,
      reason: null,
      sourceId: OPEN_3D_SCENE_SOURCE.sourceId,
      snapshotVersion: OPEN_3D_SCENE_SOURCE.snapshotVersion,
      buildings: true,
      woodlandCanopy: true,
      individualTrees: false
    });
    assert.equal(map.getSource(OPEN_3D_SCENE_SOURCE.sourceId).type, "vector");
    assert.equal(map.getLayer(OPEN_3D_SCENE_LAYERS.buildings).type, "fill-extrusion");
    assert.equal(applyOpenScene3d(map, false).effective, false);
    assert.equal(map.getSource(OPEN_3D_SCENE_SOURCE.sourceId), undefined);
  });

  it("fails closed before issuing a source when projection, governance, or renderer rejects the scene", () => {
    const activation = {allowed: true, status: "fresh-upstream"};
    const mercator = fakeMap();
    assert.equal(applyOpenScene3d(mercator, true, {globe: false, activation}).reason, "globe-required");
    assert.equal(mercator.getSource(OPEN_3D_SCENE_SOURCE.sourceId), undefined);
    const denied = fakeMap();
    assert.equal(applyOpenScene3d(denied, true, {globe: true, activation: {allowed: false, status: "receipt-stale"}}).reason, "receipt-stale");
    assert.equal(denied.getSource(OPEN_3D_SCENE_SOURCE.sourceId), undefined);
    const rejected = fakeMap({rejectLayer: true});
    assert.equal(applyOpenScene3d(rejected, true, {globe: true, activation}).reason, "renderer-error");
    assert.equal(rejected.getSource(OPEN_3D_SCENE_SOURCE.sourceId), undefined);
  });
});

function fakeMap({rejectLayer = false} = {}) {
  const sources = new Map();
  const layers = new Map();
  return {
    addSource(id, value) { sources.set(id, structuredClone(value)); },
    getSource: (id) => sources.get(id),
    removeSource(id) { sources.delete(id); },
    addLayer(value) {
      if (rejectLayer) throw new Error("unsupported");
      layers.set(value.id, structuredClone(value));
    },
    getLayer: (id) => layers.get(id),
    removeLayer(id) { layers.delete(id); }
  };
}
