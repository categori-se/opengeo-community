import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  applyOpenTerrain,
  normalizeTerrain,
  OPEN_TERRAIN_SOURCE,
  TERRAIN_LIMITS,
  terrainForProject,
  terrainForSave,
  terrainSourceSpecification
} from "../src/lib/terrainView.js";

describe("GEP-002B open terrain contract", () => {
  const activation = {allowed: true, status: "fresh-upstream"};
  it("pins one credential-free attributed global Terrarium source", () => {
    const specification = terrainSourceSpecification();
    assert.equal(new URL(OPEN_TERRAIN_SOURCE.tileUrl).protocol, "https:");
    assert.equal(new URL(OPEN_TERRAIN_SOURCE.tileUrl).hostname, "tiles.mapterhorn.com");
    assert.equal(specification.encoding, "terrarium");
    assert.equal(specification.tileSize, 512);
    assert.equal(specification.maxzoom, 12);
    assert.deepEqual(specification.bounds, [-180, -85.0511287, 180, 85.0511287]);
    assert.match(specification.attribution, /Mapterhorn/);
    assert.ok(!OPEN_TERRAIN_SOURCE.tileUrl.includes("?"));
  });

  it("normalizes project state without accepting a substituted source", () => {
    assert.deepEqual(terrainForProject({terrain: {
      enabled: true,
      sourceId: "attacker-source",
      exaggeration: 99
    }}), {
      enabled: true,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: TERRAIN_LIMITS.maximumExaggeration
    });
    assert.deepEqual(terrainForSave(false, {enabled: true, exaggeration: 0}), {
      enabled: false,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: TERRAIN_LIMITS.minimumExaggeration
    });
    assert.deepEqual(normalizeTerrain(null), {
      enabled: false,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: 1
    });
  });

  it("activates and disables effective terrain through the real map contract", () => {
    const map = fakeMap();
    assert.deepEqual(applyOpenTerrain(map, true, {activation}), {
      requested: true,
      effective: true,
      fallback: false,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: 1,
      reason: null
    });
    assert.equal(map.getSource(OPEN_TERRAIN_SOURCE.sourceId).encoding, "terrarium");
    assert.equal(map.getTerrain().source, OPEN_TERRAIN_SOURCE.sourceId);
    assert.deepEqual(applyOpenTerrain(map, false), {
      requested: false,
      effective: false,
      fallback: false,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: 1,
      reason: null
    });
  });

  it("fails closed when the renderer rejects terrain", () => {
    const map = fakeMap({rejectTerrain: true});
    assert.deepEqual(applyOpenTerrain(map, true, {activation}), {
      requested: true,
      effective: false,
      fallback: true,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: 1,
      reason: "renderer-error"
    });
    assert.equal(map.getTerrain(), null);
  });

  it("fails closed when no fresh governance decision accompanies activation", () => {
    const map = fakeMap();
    assert.deepEqual(applyOpenTerrain(map, true), {
      requested: true,
      effective: false,
      fallback: true,
      sourceId: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: 1,
      reason: "governance-unavailable"
    });
    assert.equal(map.getSource(OPEN_TERRAIN_SOURCE.sourceId), undefined);
    assert.equal(map.getTerrain(), null);
  });
});

function fakeMap({rejectTerrain = false} = {}) {
  const sources = new Map();
  let terrain = null;
  return {
    addSource(id, specification) {
      sources.set(id, structuredClone(specification));
    },
    getSource: (id) => sources.get(id),
    getTerrain: () => terrain,
    setTerrain(value) {
      if (rejectTerrain && value !== null) throw new Error("unsupported");
      terrain = value && structuredClone(value);
    }
  };
}
