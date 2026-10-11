import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  normalizeTileSeedExtent,
  tileSeedExtentSelector,
  validateTileSeedBbox,
  WEB_MERCATOR_LATITUDE_LIMIT
} from "../src/components/TileSeedExtentPicker.js";

describe("SERVICE-012 map-drawn tile seed extent", () => {
  it("normalizes either drag direction into one precise non-wrapping CRS84 bbox", () => {
    assert.deepEqual(
      normalizeTileSeedExtent([-76.123456789, 40.987654321], [-78.25, 38.5]),
      [-78.25, 38.5, -76.1234568, 40.9876543]
    );
    assert.deepEqual(
      normalizeTileSeedExtent([-78.25, 40.987654321], [-76.123456789, 38.5]),
      [-78.25, 38.5, -76.1234568, 40.9876543]
    );
  });

  it("rejects empty, wrapping, degenerate, and non-WebMercator extents", () => {
    assert.throws(() => validateTileSeedBbox([]), /four finite CRS84/);
    assert.throws(() => validateTileSeedBbox([170, -10, -170, 10]), /non-wrapping/);
    assert.throws(() => validateTileSeedBbox([-78, 39, -78, 40]), /non-wrapping/);
    assert.throws(
      () => validateTileSeedBbox([-78, -1, -76, WEB_MERCATOR_LATITUDE_LIMIT + 0.01]),
      /WebMercator latitude/
    );
  });

  it("submits the existing checksum-preview selector shape inside the exact cache policy", () => {
    const bbox = [-78, 38, -76, 40];
    const selector = tileSeedExtentSelector({
      expectedCacheVersion: 7,
      bbox,
      minimumTileMatrix: 4,
      maximumTileMatrix: 6,
      policyMinimumTileMatrix: 2,
      policyMaximumTileMatrix: 8
    });

    assert.deepEqual(selector, {
      expectedCacheVersion: 7,
      mode: "bbox",
      bbox,
      minimumTileMatrix: 4,
      maximumTileMatrix: 6
    });
    assert.notEqual(selector.bbox, bbox);
  });

  it("cannot widen the current policy or invert the zoom interval", () => {
    const values = {
      expectedCacheVersion: 2,
      bbox: [-78, 38, -76, 40],
      minimumTileMatrix: 3,
      maximumTileMatrix: 8,
      policyMinimumTileMatrix: 3,
      policyMaximumTileMatrix: 8
    };
    assert.throws(
      () => tileSeedExtentSelector({...values, minimumTileMatrix: 2}),
      /outside the current cache policy/
    );
    assert.throws(
      () => tileSeedExtentSelector({...values, maximumTileMatrix: 9}),
      /outside the current cache policy/
    );
    assert.throws(
      () => tileSeedExtentSelector({...values, minimumTileMatrix: 7, maximumTileMatrix: 6}),
      /outside the current cache policy/
    );
  });
});
