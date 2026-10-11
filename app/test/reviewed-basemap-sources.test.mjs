import assert from "node:assert/strict";
import test from "node:test";

import {
  BASEMAP_SOURCE_REVIEW_DECISIONS,
  REVIEWED_KEY_FREE_BASEMAPS
} from "../src/lib/reviewedBasemapSources.js";

test("reviewed public raster records use fixed credential-free HTTPS contracts", () => {
  assert.equal(REVIEWED_KEY_FREE_BASEMAPS.length, 4);
  for (const basemap of REVIEWED_KEY_FREE_BASEMAPS) {
    assert.equal(basemap.kind, "raster");
    assert.equal(basemap.sourceReview.access, "No API key");
    assert.equal(basemap.sourceReview.decision, "accepted");
    assert.equal(basemap.sourceReview.reviewedAt, "2026-08-28");
    assert.match(basemap.url, /^https:/);
    assert.match(basemap.url, /\{z\}.*\{y\}.*\{x\}/);
    assert.match(basemap.sourceReview.probeUrl, /^https:/);
    assert.doesNotMatch(`${basemap.url}${basemap.sourceReview.probeUrl}`, /[?#]|@/);
    assert.equal(basemap.sourceReview.expectedContentType, "image/jpeg");
    assert.ok(basemap.minZoom >= 0 && basemap.maxZoom <= 16 && basemap.minZoom < basemap.maxZoom);
    assert.deepEqual(basemap.sourceConfiguration.coverageBounds, [-180, -85.051129, 180, 85.051129]);
  }
});

test("stale lists and incompatible current terms remain review evidence, not defaults", () => {
  const runtimeIds = new Set(REVIEWED_KEY_FREE_BASEMAPS.map(({basemapId}) => basemapId));
  const eox = BASEMAP_SOURCE_REVIEW_DECISIONS.find(({candidateId}) => candidateId === "eox-cloudless-current");
  const historic = BASEMAP_SOURCE_REVIEW_DECISIONS.find(({candidateId}) => candidateId === "historic-free-tiles-list");
  const osm = BASEMAP_SOURCE_REVIEW_DECISIONS.find(({candidateId}) => candidateId === "osm-standard-public-tiles");
  assert.equal(eox.decision, "not-default");
  assert.match(eox.reason, /non-commercial/);
  assert.equal(historic.decision, "discovery-only");
  assert.match(historic.reason, /stale/);
  assert.equal(osm.decision, "not-default");
  assert.ok([eox, historic, osm].every(({candidateId}) => !runtimeIds.has(candidateId)));
});
