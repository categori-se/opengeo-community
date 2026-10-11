import assert from "node:assert/strict";
import test from "node:test";

import {
  BASEMAP_GOVERNANCE_REGISTRY,
  applyBasemapGovernance,
  basemapCatalogAvailability,
  basemapGovernanceMessage,
  basemapNetworkAllowed,
  basemapReplacement,
  observeBasemapRegistry,
  validateBasemapGovernanceRegistry
} from "../src/lib/basemapGovernance.js";
import {BASEMAPS} from "../src/lib/workbenchConfig.js";

test("the operator registry is closed, reviewed, and replacement-complete", () => {
  const registry = validateBasemapGovernanceRegistry(BASEMAP_GOVERNANCE_REGISTRY);
  assert.equal(registry.revision, 2);
  assert.equal(registry.sources.filter(({lifecycle}) => lifecycle === "active").length, 11);
  assert.deepEqual(
    registry.sources.filter(({lifecycle}) => lifecycle === "retired").map(({basemapId}) => basemapId),
    ["carto-voyager", "carto-positron", "carto-dark"]
  );
  const invalid = structuredClone(registry);
  invalid.sources.find(({basemapId}) => basemapId === "carto-positron").replacementBasemapId = "missing";
  assert.throws(() => validateBasemapGovernanceRegistry(invalid), /replacement is unknown/);
  const chained = structuredClone(registry);
  chained.sources.find(({basemapId}) => basemapId === "carto-positron").replacementBasemapId = "carto-dark";
  assert.throws(() => validateBasemapGovernanceRegistry(chained), /replacement must be active/);
});

test("historic CARTO selections stay identifiable but require an explicit replacement", () => {
  const [legacy] = applyBasemapGovernance([{
    basemapId: "carto-positron",
    title: "CARTO Positron",
    kind: "raster",
    url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
  }]);
  assert.equal(basemapCatalogAvailability(legacy), "retired");
  assert.equal(basemapNetworkAllowed(legacy), true);
  assert.equal(basemapReplacement(legacy, BASEMAPS)?.basemapId, "openfreemap-positron");
  assert.match(basemapGovernanceMessage(legacy, {savedProject: true}), /exact saved source/);
});

test("operator-disabled sources preserve identity while blocking network requests", () => {
  const registry = structuredClone(BASEMAP_GOVERNANCE_REGISTRY);
  registry.revision += 1;
  registry.sources.push({
    basemapId: "disabled-fixture",
    lifecycle: "disabled",
    probeKind: "policy-only",
    probeUrl: null,
    replacementBasemapId: "blank",
    lifecycleReason: "Fixture source was disabled after a policy review.",
    observation: {status: "not-probed", observedAt: "2026-08-27", summary: "Operator disabled"}
  });
  validateBasemapGovernanceRegistry(registry);
  const [disabled] = applyBasemapGovernance([{
    basemapId: "disabled-fixture",
    title: "Disabled fixture",
    kind: "raster",
    url: "https://tiles.example.test/{z}/{x}/{y}.png"
  }], registry);
  assert.equal(basemapCatalogAvailability(disabled), "operator-disabled");
  assert.equal(basemapNetworkAllowed(disabled), false);
  assert.match(basemapGovernanceMessage(disabled, {savedProject: true}), /did not request/);
});

test("scheduled observations deduplicate endpoints and validate MapLibre style bodies", async () => {
  const requests = [];
  const report = await observeBasemapRegistry({
    observedAt: "2026-08-27T23:00:00Z",
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      return options.headers.accept === "application/json"
        ? new Response(JSON.stringify({version: 8, sources: {}, layers: []}), {
            status: 200,
            headers: {"content-type": "application/json"}
          })
        : new Response(new Uint8Array(512), {
            status: 200,
            headers: {"content-type": "image/jpeg"}
          });
    }
  });
  assert.equal(requests.length, 9);
  assert.ok(requests.every(({options}) => (
    options.redirect === "manual"
    && options.credentials === "omit"
    && ["application/json", "image/jpeg"].includes(options.headers.accept)
    && !Object.hasOwn(options.headers, "authorization")
  )));
  assert.deepEqual(report.counts, {healthy: 10, "not-probed": 4});
  assert.equal(report.observations.find(({basemapId}) => basemapId === "openfreemap-liberty").status, "healthy");
  assert.equal(report.observations.find(({basemapId}) => basemapId === "nasa-blue-marble-relief").reason, "valid_raster_tile");
  assert.equal(report.observations.find(({basemapId}) => basemapId === "carto-positron").reason, "policy_retired");
});

test("scheduled observations report failures without changing lifecycle policy", async () => {
  const report = await observeBasemapRegistry({
    observedAt: "2026-08-27T23:10:00Z",
    fetchImpl: async () => new Response("upstream unavailable", {
      status: 503,
      headers: {"content-type": "text/plain"}
    })
  });
  assert.equal(report.counts.degraded, 10);
  assert.equal(report.counts["not-probed"], 4);
  assert.ok(report.observations
    .filter(({status}) => status === "degraded")
    .every(({reason, lifecycle}) => reason === "http_503" && lifecycle === "active"));
  assert.ok(BASEMAP_GOVERNANCE_REGISTRY.sources
    .filter(({basemapId}) => basemapId.startsWith("openfreemap-"))
    .every(({lifecycle}) => lifecycle === "active"));
});

test("raster observations reject unrelated or empty response bodies", async () => {
  const report = await observeBasemapRegistry({
    observedAt: "2026-08-28T12:00:00Z",
    fetchImpl: async (_url, options) => options.headers.accept === "application/json"
      ? new Response(JSON.stringify({version: 8, sources: {}, layers: []}), {
          status: 200,
          headers: {"content-type": "application/json"}
        })
      : new Response("login", {status: 200, headers: {"content-type": "text/html"}})
  });
  const raster = report.observations.filter(({basemapId}) => (
    ["nasa-blue-marble-relief", "nasa-viirs-city-lights-2012", "usgs-national-imagery", "usgs-national-shaded-relief"]
      .includes(basemapId)
  ));
  assert.ok(raster.every(({status, reason}) => status === "degraded" && reason === "unexpected_content_type"));
});
