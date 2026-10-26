import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {createStacItemClient} from "../src/lib/stacItemSearch.js";
import {reviewStacSources, validateStacSourceSuitability, bindStacSourceSuitability,
  STAC_SOURCE_SUITABILITY_LIMITS} from "../src/lib/stacSourceSuitability.js";

const timestamp = "2026-10-26T12:00:00Z";
const bounds = [0, 0, 1, 1];
const rect = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
function item(id = "scene") {
  return {type: "Feature", stac_version: "1.0.0", id, collection: "classification", bbox: [-1, -1, 2, 2],
    geometry: {type: "Polygon", coordinates: [rect(-1, -1, 2, 2)]},
    properties: {datetime: null, start_datetime: "2021-01-01T00:00:00Z", end_datetime: "2021-12-31T23:59:59.999Z",
      gsd: 30, "eo:cloud_cover": 10, license: "item-terms"}, links: [],
    assets: {data: {href: `https://rasters.example/${id}.tif`, type: "image/tiff", license: "CC-BY-4.0",
      gsd: 10, "file:size": 1024, "raster:bands": [{spatial_resolution: 20}, {}, {}],
      "eo:bands": [{name: "B04", common_name: "red"}, {name: "B03", common_name: "green"}, {name: "B02", common_name: "blue"}],
      "classification:classes": [{value: 40, name: "Cropland"}]}}};
}
async function retained(items = [item()], endpoint = "https://catalog.example/v1/search") {
  const calls = [];
  const client = createStacItemClient({fetchImplementation: async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify({type: "FeatureCollection", features: items, links: []}),
      {headers: {"content-type": "application/geo+json", etag: '"snapshot"'}});
  }, now: () => new Date(timestamp)});
  const result = await client.search({endpoint, collections: ["classification"], bbox: bounds,
    start: "2021-01-01T00:00:00Z", end: "2021-12-31T23:59:59.999Z", limit: items.length});
  assert.equal(result.items.length, items.length);
  return {references: result.items, calls};
}
const selection = reference => ({reference, assetKey: "data", bands: [1]});
const criteria = extra => ({bounds, periodStart: "2021-01-01", periodEnd: "2021-12-31", maximumResolutionMeters: 15,
  requiredBandNames: ["red"], requiredClassNames: ["Cropland"], maximumCloudCover: 20,
  acceptedLicenses: ["CC-BY-4.0"], maximumTransferBytes: 2048, priority: "coverage", ...extra});
const review = (selections, changes = {}, options = {}) => reviewStacSources({selections, criteria: criteria(changes), timestamp, ...options});
const candidate = (report, id) => report.candidates.find(value => value.identity.itemId === id);

test("retained cross-provider assets rank deterministically from explicit evidence without additional requests", async () => {
  const first = item("full-coarse"), second = item("partial-fine"); first.assets.data.gsd = 30;
  second.geometry.coordinates = [rect(0, 0, 0.5, 1)];
  const a = await retained([first]), b = await retained([second], "https://another.example/search"),
    selections = [selection(a.references[0]), selection(b.references[0])], before = structuredClone(selections);
  const report = await review(selections);
  assert.equal(report.candidates[0].identity.itemId, "full-coarse");
  assert.equal(candidate(report, "full-coarse").assessments.coverage.status, "matches");
  assert.equal(candidate(report, "partial-fine").assessments.coverage.status, "partial");
  assert.deepEqual(await review([...selections].reverse()), report);
  const resolution = await review(selections, {priority: "resolution"});
  assert.equal(resolution.candidates[0].identity.itemId, "partial-fine");
  assert.deepEqual(resolution.method.lexicographicOrder, ["resolution", "coverage", "dates", "taxonomy", "quality", "rights", "cost"]);
  assert.equal(a.calls.length + b.calls.length, 2); assert.equal(report.scope.providerRequests, 0);
  assert.deepEqual(selections, before); assert.equal(report.candidates.length, 2);
  assert.equal(report.scope.countryAttribution, "not-inferred");
  for (const value of report.candidates) {
    assert.match(value.id, /^stac-[a-f0-9]{64}$/); assert(!Object.hasOwn(value, "score"));
    assert.equal(value.identity.snapshotSha256, selections.find(entry => entry.reference.id === value.identity.itemId).reference.snapshot.sha256);
    assert(Object.values(value.assessments).every(value => value.basis && value.evidence.length));
  }
});

test("declared polygons respect holes and multipart gaps instead of upgrading bounding-box candidates", async () => {
  const hole = item("hole"), multipart = item("multipart");
  hole.geometry.coordinates.push(rect(-0.1, -0.1, 1.1, 1.1));
  multipart.geometry = {type: "MultiPolygon", coordinates: [[rect(-0.1, -0.1, 0.25, 1.1)], [rect(0.75, -0.1, 1.1, 1.1)]]};
  const {references} = await retained([hole, multipart]);
  const report = await review(references.map(selection));
  const excluded = candidate(report, "hole"), divided = candidate(report, "multipart");
  assert.equal(excluded.facts.coverage.fraction, 0); assert.equal(excluded.assessments.coverage.status, "mismatch");
  assert(divided.facts.coverage.fraction > 0.49 && divided.facts.coverage.fraction < 0.51);
  assert.equal(divided.assessments.coverage.status, "partial");
  assert.equal(divided.facts.coverage.basis, "declared-item-footprint");
  assert.equal(divided.facts.coverage.validPixelCoverage, "unknown");
  assert.equal(divided.facts.coverage.method.edges, "shortest-great-circle-between-supplied-vertices");
  assert.match(divided.assessments.coverage.basis, /inventory completeness remain unknown/);
});

test("missing, invalid and oversized footprints retain explicit unknown reasons without bbox fallback", async () => {
  const missing = item("missing"), invalid = item("invalid"), oversized = item("oversized");
  missing.geometry = null;
  invalid.geometry.coordinates = [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]];
  const ring = Array.from({length: 257}, (_, index) => [0.5 + Math.cos(index * Math.PI * 2 / 257), 0.5 + Math.sin(index * Math.PI * 2 / 257)]);
  oversized.geometry.coordinates = [[...ring, ring[0]]];
  const {references} = await retained([missing, invalid, oversized]);
  const report = await review(references.map(selection));
  for (const value of report.candidates) {
    assert.equal(value.assessments.coverage.status, "unknown");
    assert.equal(value.facts.coverage.fraction, null); assert.equal(value.facts.coverage.intersectionAreaSquareMeters, null);
    assert.equal(value.facts.coverage.method, null); assert.equal(typeof value.facts.coverage.unknownReason, "string");
    assert.match(value.assessments.coverage.basis, /bounding boxes are not substituted/);
  }
  assert.equal(candidate(report, "missing").facts.coverage.unknownReason, "missing-item-geometry");
  assert.equal(candidate(report, "oversized").facts.coverage.unknownReason, "baseline_aoi_position_limit");
});

test("dates, nominal resolution and taxonomy retain their precise source meaning", async () => {
  const source = item(); delete source.assets.data.gsd;
  const {references} = await retained([source]), selections = references.map(selection);
  let report = await review(selections);
  assert.equal(report.candidates[0].facts.resolution.authority, "selected raster:bands.spatial_resolution");
  assert.equal(report.candidates[0].facts.resolution.meters, 20);
  assert.equal(report.candidates[0].assessments.resolution.status, "mismatch");
  assert.equal(report.candidates[0].assessments.taxonomy.status, "matches");
  assert.equal(report.candidates[0].assessments.dates.status, "matches");
  assert.equal(report.candidates[0].facts.observationPeriod.requestedCoverageFraction, 1);
  report = await review(selections, {requiredBandNames: ["Red"], requiredClassNames: ["cropland"]});
  assert.equal(report.candidates[0].assessments.taxonomy.status, "mismatch");
  report = await review(selections, {periodStart: "2020-12-01", periodEnd: "2021-01-31"});
  assert.equal(report.candidates[0].assessments.dates.status, "partial");
  assert(report.candidates[0].facts.observationPeriod.requestedCoverageFraction > 0);
  const instant = item("instant"); instant.properties.datetime = "2021-06-01T10:00:00Z";
  delete instant.assets.data.gsd; delete instant.assets.data["raster:bands"]; delete instant.properties.gsd;
  instant.assets.data.inputImageryResolutionMeters = 1;
  const instantReference = (await retained([instant])).references[0];
  report = await review([selection(instantReference)], {periodStart: "2021-06-01", periodEnd: "2021-06-01"});
  assert.equal(report.candidates[0].facts.observationPeriod.start, "2021-06-01T10:00:00.000Z");
  assert.equal(report.candidates[0].assessments.dates.status, "partial");
  assert.equal(report.candidates[0].facts.resolution.meters, null);
  assert.equal(report.candidates[0].assessments.resolution.status, "unknown");
});

test("whole-item cloud cover, direct asset terms and bytes never establish AOI quality, access or processing cost", async () => {
  const source = item("unknown-terms"); delete source.assets.data.license;
  const {references} = await retained([source]), selections = references.map(selection);
  let value = (await review(selections, {acceptedLicenses: ["item-terms"]})).candidates[0];
  assert.equal(value.facts.rights.assetLicense, null); assert.equal(value.facts.rights.itemLicense, "item-terms");
  assert.equal(value.assessments.rights.status, "unknown"); assert.equal(value.facts.rights.authorization, "not-established");
  assert.equal(value.assessments.quality.status, "partial"); assert.equal(value.facts.quality.aoiAccuracy, "unknown");
  assert.equal(value.facts.quality.scope, "whole-item-declaration"); assert.equal(value.assessments.cost.status, "partial");
  assert.equal(value.facts.cost.assetBytes, 1024); assert.equal(value.facts.cost.processingCost, "unknown");
  assert.equal(value.facts.cost.monetaryCost, "unknown");
  value = (await review(selections, {maximumCloudCover: 5, maximumTransferBytes: 512})).candidates[0];
  assert.equal(value.assessments.quality.status, "mismatch"); assert.equal(value.assessments.cost.status, "mismatch");
  const minimal = await reviewStacSources({selections, criteria: {bounds}, timestamp});
  assert.equal(minimal.criteria.periodStart, null); assert.deepEqual(minimal.criteria.acceptedLicenses, []);
  for (const axis of ["dates", "resolution", "taxonomy", "quality", "rights", "cost"]) assert.equal(minimal.candidates[0].assessments[axis].status, "unknown");
});

test("reports reopen independently and reject forged facts, methods, criteria and ranking", async () => {
  const {references} = await retained([item("one"), item("two")]), selections = references.map(selection), report = await review(selections);
  assert.deepEqual(await validateStacSourceSuitability(JSON.parse(JSON.stringify(report)), {selections}), report);
  for (const mutate of [value => {value.candidates[0].facts.rights.authorization = "authorized";},
    value => {value.candidates[0].facts.coverage.fraction = 0;}, value => {value.candidates[0].assessments.quality.status = "matches";},
    value => {value.criteria.maximumCloudCover = 1;}, value => {value.candidates.reverse();},
    value => {value.method.rankMeaning = "approved";}, value => {value.scope.providerRequests = 2;}]) {
    const copy = structuredClone(report); mutate(copy); await assert.rejects(validateStacSourceSuitability(copy, {selections}));
    await assert.rejects(bindStacSourceSuitability({report: copy, candidateId: copy.candidates[0].id}, selections.find(value => value.reference.id === copy.candidates[0].identity.itemId)));
  }
  assert(Buffer.byteLength(JSON.stringify(report)) < STAC_SOURCE_SUITABILITY_LIMITS.outputBytes);
});

test("selected binding recomputes current pins and bands and retains only compact inferred facts", async () => {
  const {references} = await retained([item("one"), item("two")]), selections = references.map(selection), report = await review(selections);
  const selected = report.candidates[1], current = selections.find(value => value.reference.id === selected.identity.itemId);
  const compact = await bindStacSourceSuitability({report, candidateId: selected.id}, current);
  assert.deepEqual(compact.candidate, selected); assert.deepEqual(compact.criteria, report.criteria);
  assert.equal(compact.reportChecksumSha256, createHash("sha256").update((await import("../src/lib/artifactCanonicalJson.js")).canonicalJson(report)).digest("hex"));
  assert(Buffer.byteLength(JSON.stringify(compact)) < STAC_SOURCE_SUITABILITY_LIMITS.selectedBytes);
  assert.equal(compact.candidates, undefined); assert.equal(compact.candidate.original, undefined);
  await assert.rejects(bindStacSourceSuitability({report, candidateId: selected.id}, {...current, bands: [2]}));
  const changed = item(selected.identity.itemId); changed.properties.note = "new response snapshot";
  const fresh = (await retained([changed])).references[0];
  await assert.rejects(bindStacSourceSuitability({report, candidateId: selected.id}, selection(fresh)));
  const forged = structuredClone(report); forged.candidates[1].facts.cost.assetBytes = 1;
  await assert.rejects(bindStacSourceSuitability({report: forged, candidateId: selected.id}, current));
});

test("invalid criteria, duplicate selections, unsupported bands and stale or cancelled reviews fail before writes", async () => {
  const {references, calls} = await retained(), selections = references.map(selection);
  for (const changed of [{bounds: [0, 0, 7, 1]}, {bounds: [0, 80, 1, 81]}, {periodStart: "2021-02-30"},
    {periodEnd: null}, {maximumResolutionMeters: 0}, {maximumCloudCover: 101}, {maximumTransferBytes: -1},
    {priority: "accuracy"}, {requiredBandNames: ["red", "red"]}, {authorization: "approved"}]) await assert.rejects(review(selections, changed));
  await assert.rejects(review([...selections, ...selections]));
  await assert.rejects(review(Array(21).fill(selections[0])));
  for (const bands of [[], [1, 1, 2], [4], [0], [1, 2]]) await assert.rejects(review([{...selections[0], bands}]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(review(selections, {}, {signal: controller.signal}), {name: "AbortError"});
  const stale = Error("selected account changed"); let checks = 0;
  await assert.rejects(review(selections, {}, {assertCurrent() {if (++checks === 3) throw stale;}}), stale);
  assert.equal(calls.length, 1);
});
