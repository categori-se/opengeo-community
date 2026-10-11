import assert from "node:assert/strict";
import test from "node:test";
import {
  BASEMAP_RUNTIME_LIMITS,
  basemapCoverageIssues,
  basemapRuntimeErrorApplies,
  basemapRuntimeIssueBlocksActivation,
  basemapRuntimeIssueDetails,
  basemapRuntimeIssueFromError,
  basemapRuntimeMessage,
  createBasemapRuntimeHealth
} from "../src/lib/basemapRuntimeHealth.js";

const style = {basemapId: "style", kind: "maplibre-style"};
const raster = {basemapId: "raster", kind: "raster"};

test("runtime error attribution separates the active background from project sources", () => {
  const managed = new Set(["project-layer-source", "opengeo-terrain"]);
  assert.equal(basemapRuntimeErrorApplies({basemap: style, event: {sourceId: "style-source"}, managedSourceIds: managed}), true);
  assert.equal(basemapRuntimeErrorApplies({basemap: style, event: {sourceId: "project-layer-source"}, managedSourceIds: managed}), false);
  assert.equal(basemapRuntimeErrorApplies({basemap: style, event: {}, managedSourceIds: managed}), true);
  assert.equal(basemapRuntimeErrorApplies({basemap: raster, event: {sourceId: "basemap"}, managedSourceIds: managed}), true);
  assert.equal(basemapRuntimeErrorApplies({basemap: raster, event: {sourceId: "other"}, managedSourceIds: managed}), false);
  assert.equal(basemapRuntimeErrorApplies({basemap: style, event: {sourceId: "style-source"}, networkAllowed: false}), false);
  assert.equal(basemapRuntimeErrorApplies({basemap: {kind: "blank"}, event: {}}), false);
});

test("three recent active-background failures open a non-mutating outage state", () => {
  let at = 1_000;
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => at});
  health.recordReady("style");
  assert.equal(health.snapshot().state, "healthy");
  for (let index = 1; index < BASEMAP_RUNTIME_LIMITS.failureThreshold; index += 1) {
    assert.notEqual(health.recordFailure("style").state, "outage");
    at += 100;
  }
  const outage = health.recordFailure("style");
  assert.equal(outage.state, "outage");
  assert.equal(outage.basemapId, "style");
  assert.equal(outage.failureCount, 3);
  assert.equal(outage.detectedAt, new Date(at).toISOString());
  assert.equal(health.recordFailure("different").failureCount, 3);
});

test("failures outside the bounded window do not accumulate", () => {
  let at = 10_000;
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => at});
  health.recordReady("style");
  health.recordFailure("style");
  at += BASEMAP_RUNTIME_LIMITS.failureWindowMilliseconds + 1;
  const current = health.recordFailure("style");
  assert.equal(current.state, "incomplete");
  assert.equal(current.failureCount, 1);
});

test("retain, failed retry, and successful retry preserve explicit recovery states", () => {
  let at = 50_000;
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => at});
  health.recordReady("style");
  for (let index = 0; index < 3; index += 1) {
    at += 10;
    health.recordFailure("style");
  }
  assert.equal(health.retain("style").state, "retained");
  at += 10;
  const retained = health.recordFailure("style", {kind: "tile"});
  assert.equal(retained.state, "retained");
  assert.equal(retained.failureCount, 4);
  assert.equal(health.retry("style").state, "retrying");
  assert.equal(health.retryFailed("style").reason, "retry-check-failed");
  assert.equal(health.retry("style").state, "retrying");
  assert.equal(health.recordReady("style").state, "healthy");
});

test("a single main-renderer resource error during retry prevents a false healthy result", () => {
  let at = 90_000;
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => at});
  health.recordReady("style");
  for (let index = 0; index < 3; index += 1) health.recordFailure("style");
  health.retry("style");
  at += 1;
  health.recordFailure("style");
  assert.equal(health.recordReady("style").state, "incomplete");
});

test("an active renderer that cannot settle enters the same explicit outage state", () => {
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => 120_000});
  const unavailable = health.recordUnavailable("style");
  assert.equal(unavailable.state, "outage");
  assert.equal(unavailable.failureCount, BASEMAP_RUNTIME_LIMITS.failureThreshold);
  assert.equal(unavailable.reason, "activation-timeout");
  assert.equal(health.recordUnavailable("different").basemapId, "style");
});

test("runtime messages contain recovery facts without resource URLs or error bodies", () => {
  const message = basemapRuntimeMessage({
    title: "Positron",
    runtime: {state: "outage", failureCount: 3}
  });
  assert.match(message, /Project layers and map position remain available/);
  assert.match(message, /saved basemap has not changed/);
  assert.doesNotMatch(message, /https?:|token|credential/i);

  const retained = basemapRuntimeMessage({
    title: "Positron",
    runtime: {state: "retained", failureCount: 3}
  });
  assert.match(retained, /background may be incomplete/);
  assert.match(retained, /saved basemap remain unchanged/);
  assert.doesNotMatch(retained, /https?:|token|credential/i);
});

test("renderer errors are classified without exposing their URLs", () => {
  const styleDocument = {
    glyphs: "https://fonts.example.test/{fontstack}/{range}.pbf?token=secret",
    sprite: [
      {id: "default", url: "https://styles.example.test/sprite?key=secret"}
    ]
  };
  assert.deepEqual(
    basemapRuntimeIssueFromError({
      event: {tile: {tileID: "fixture"}, sourceId: "background"},
      style: styleDocument
    }),
    {kind: "tile"}
  );
  assert.deepEqual(
    basemapRuntimeIssueFromError({
      event: {error: {url: "https://styles.example.test/sprite.png?key=secret"}},
      style: styleDocument
    }),
    {kind: "sprite"}
  );
  assert.deepEqual(
    basemapRuntimeIssueFromError({
      event: {error: {url: "https://fonts.example.test/Open%20Sans/0-255.pbf?token=secret"}},
      style: styleDocument
    }),
    {kind: "glyph"}
  );
  assert.deepEqual(basemapRuntimeIssueFromError({event: {resourceType: "SpriteJSON"}}), {kind: "sprite"});
  assert.equal(basemapRuntimeIssueBlocksActivation({kind: "sprite"}), false);
  assert.equal(basemapRuntimeIssueBlocksActivation({kind: "glyph"}), false);
  assert.equal(basemapRuntimeIssueBlocksActivation({kind: "tile"}), true);
});

test("optional failures remain partial while repeated tile failures escalate", () => {
  let at = 200_000;
  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => at});
  health.recordReady("style");
  let runtime = health.recordFailure("style", {kind: "sprite"});
  assert.equal(runtime.state, "incomplete");
  assert.equal(runtime.impact, "partial");
  assert.equal(runtime.issueCounts.sprite, 1);
  for (let index = 0; index < 5; index += 1) {
    at += 10;
    runtime = health.recordFailure("style", {kind: "glyph"});
  }
  assert.equal(runtime.state, "incomplete");
  assert.equal(runtime.issueCounts.glyph, 5);
  for (let index = 0; index < BASEMAP_RUNTIME_LIMITS.failureThreshold; index += 1) {
    at += 10;
    runtime = health.recordFailure("style", {kind: "tile"});
  }
  assert.equal(runtime.state, "outage");
  assert.equal(runtime.reason, "repeated-tile-errors");
  assert.equal(runtime.issueCounts.tile, 3);
  assert.match(basemapRuntimeIssueDetails(runtime).join(" "), /Map symbols/);
  assert.match(basemapRuntimeIssueDetails(runtime).join(" "), /Labels/);
  assert.match(basemapRuntimeIssueDetails(runtime).join(" "), /Map tiles/);
});

test("declared geographic and zoom limits produce specific non-outage feedback", () => {
  const sources = [
    {type: "raster", bounds: [10, 10, 20, 20], minzoom: 4, maxzoom: 12},
    {type: "vector", bounds: [170, -20, -170, 20], minzoom: 0, maxzoom: 8}
  ];
  const issues = basemapCoverageIssues({
    zoom: 2,
    viewportBounds: {west: -80, south: 35, east: -70, north: 45},
    sources
  });
  assert.deepEqual(issues.map(({reason}) => reason), ["outside-extent", "below-minimum-zoom"]);
  assert.equal(issues[0].affected, 2);
  assert.equal(issues[1].affected, 1);

  const antimeridianView = basemapCoverageIssues({
    zoom: 9,
    viewportBounds: {west: 175, south: -10, east: -175, north: 10},
    sources: [sources[1]]
  });
  assert.deepEqual(antimeridianView.map(({reason}) => reason), ["above-maximum-detail"]);
  assert.deepEqual(
    basemapCoverageIssues({
      zoom: 6,
      viewportBounds: {west: 370, south: 12, east: 380, north: 18},
      sources: [sources[0]]
    }),
    []
  );

  const health = createBasemapRuntimeHealth({basemapId: "style", now: () => 210_000});
  health.recordReady("style");
  assert.equal(health.recordCoverage("style", antimeridianView).state, "limited");
  assert.match(basemapRuntimeIssueDetails(health.snapshot())[0], /maximum detail/);
  assert.equal(health.recordCoverage("style", []).state, "healthy");
});
