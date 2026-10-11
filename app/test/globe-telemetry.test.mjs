import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  beginTerrainTiming,
  cancelTerrainTiming,
  completeTerrainTiming,
  createGlobeTelemetry,
  GLOBE_TELEMETRY_LIMITS,
  globeTelemetrySnapshot,
  recordGlobeCamera,
  recordGlobeFrame,
  recordGlobeLoad
} from "../src/lib/globeTelemetry.js";

describe("GEP-002C bounded globe telemetry", () => {
  it("records bounded frame percentiles, load, terrain readiness, heap, and camera", () => {
    let current = 0;
    const telemetry = createGlobeTelemetry({now: () => current});
    for (const interval of [16, 17, 15, 18, 20, 16, 17, 15, 19, 16, 22]) {
      current += interval;
      recordGlobeFrame(telemetry);
    }
    recordGlobeLoad(telemetry);
    beginTerrainTiming(telemetry);
    current += 240;
    completeTerrainTiming(telemetry);
    recordGlobeCamera(telemetry, fakeMap());
    const result = globeTelemetrySnapshot(telemetry, {usedHeapBytes: 64 * 1_048_576});

    assert.equal(result.frameSamples, 10);
    assert.equal(result.frameP50Ms, 17);
    assert.equal(result.frameP95Ms, 22);
    assert.equal(result.mapLoadMs, 191);
    assert.equal(result.terrainReadyMs, 240);
    assert.equal(result.heapMiB, 64);
    assert.deepEqual(result.camera, {
      longitude: -77,
      latitude: 39,
      zoom: 8,
      pitch: 45,
      bearing: -20
    });
    assert.deepEqual(result.acceptance, {
      enoughFrames: true,
      frameP95: true,
      mapLoad: true,
      terrainReady: true,
      heap: true
    });
  });

  it("caps samples and reports failed or unavailable checks without inventing values", () => {
    let current = 0;
    const telemetry = createGlobeTelemetry({now: () => current});
    for (let index = 0; index <= GLOBE_TELEMETRY_LIMITS.maximumFrameSamples + 20; index += 1) {
      current += 260;
      recordGlobeFrame(telemetry);
    }
    current = 20_000;
    recordGlobeLoad(telemetry);
    beginTerrainTiming(telemetry);
    cancelTerrainTiming(telemetry);
    recordGlobeCamera(telemetry, {getCenter: () => ({lng: Number.NaN, lat: 0})});
    const result = globeTelemetrySnapshot(telemetry);

    assert.equal(result.frameSamples, GLOBE_TELEMETRY_LIMITS.maximumFrameSamples);
    assert.equal(result.acceptance.frameP95, false);
    assert.equal(result.acceptance.mapLoad, false);
    assert.equal(result.acceptance.terrainReady, null);
    assert.equal(result.acceptance.heap, null);
    assert.equal(result.camera, null);
  });
});

function fakeMap() {
  return {
    getCenter: () => ({lng: -77, lat: 39}),
    getZoom: () => 8,
    getPitch: () => 45,
    getBearing: () => -20
  };
}
