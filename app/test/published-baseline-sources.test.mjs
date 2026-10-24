import assert from "node:assert/strict";
import {it} from "node:test";
import {worldCoverReferences, worldCoverProfileForUrl, assessBaselinePeriod, WORLDCOVER_2021, FTW_GLOBAL} from "../src/lib/publishedBaselineSources.js";

it("selects actual WorldCover tiles without adding adjacent tiles at exact grid edges", () => {
  const [draft] = worldCoverReferences({bounds: [3, 51, 6, 54]});
  assert.equal(draft.source.url, "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N51E003_Map.tif");
  assert.deepEqual(draft.source.bounds, [3, 51, 6, 54]);
  assert.deepEqual(draft.source.bands, [1]);
  assert.equal(draft.source.sizeBytes, null);
  assert.equal(draft.source.referenceMetadata.providerAvailability, "unverified");
  assert.equal(draft.source.referenceMetadata.coverage, "tile-candidate-unverified");
});

it("names southern and western tiles by their lower-left corners and preserves AOI separately", () => {
  const bounds = [-0.1, -0.1, 0.1, 0.1], drafts = worldCoverReferences({bounds});
  assert.deepEqual(drafts.map(draft => draft.source.referenceMetadata.tileId), ["S03W003", "S03E000", "N00W003", "N00E000"]);
  assert.deepEqual(drafts[0].source.bounds, [-3, -3, 0, 0]);
  assert.deepEqual(drafts[0].source.referenceMetadata.requestedBounds, bounds);
  assert.equal(worldCoverReferences({bounds: [-0, -0, 0.1, 0.1]})[0].source.referenceMetadata.tileId, "N00E000");
  assert.equal(worldCoverReferences({bounds: [179.9, 0, 180, 0.1]})[0].source.referenceMetadata.tileId, "N00E177");
  assert.equal(worldCoverReferences({bounds: [-180, 0, -179.9, 0.1]})[0].source.referenceMetadata.tileId, "N00W180");
});

it("rejects malformed, crossing, polar, excessive and more-than-four-tile requests before creating drafts", () => {
  for (const bounds of [null, [], [0, 0, 0, 1], [0, 0, 1, 0], [179, 0, -179, 1], [0, 0, Infinity, 1],
    ["0", 0, 1, 1], [-181, 0, -179, 1], [0, -86, 1, -85], [0, 85, 1, 86]]) assert.throws(() => worldCoverReferences({bounds}), /baseline_bounds_invalid/);
  assert.throws(() => worldCoverReferences({bounds: [0, 0, 7, 1]}), /baseline_bounds_limit/);
  assert.throws(() => worldCoverReferences({bounds: [0.1, 0.1, 6.1, 6.1]}), /baseline_tile_limit/);
  assert.equal(worldCoverReferences({bounds: [0, 0, 6, 6]}).length, 4);
});

it("compares complete, partial and disjoint observation periods without relabeling the source", () => {
  const source = {sourceStart: "2021-01-01", sourceEnd: "2021-12-31"};
  assert.equal(assessBaselinePeriod(source), "not-assessed");
  assert.equal(assessBaselinePeriod({requestedStart: "2021-01-01", requestedEnd: "2021-12-31"}), "not-assessed");
  assert.equal(assessBaselinePeriod({...source, requestedStart: "2021-06-01", requestedEnd: "2021-06-30"}), "matches");
  assert.equal(assessBaselinePeriod({...source, requestedStart: "2020-12-01", requestedEnd: "2021-01-01"}), "partial");
  assert.equal(assessBaselinePeriod({...source, requestedStart: "2024-01-01", requestedEnd: "2024-12-31"}), "disjoint");
  const [draft] = worldCoverReferences({bounds: [3.1, 51.1, 3.2, 51.2], periodStart: "2025-01-01", periodEnd: "2025-12-31"});
  assert.deepEqual(draft.source.referenceMetadata.observationPeriod, {start: "2021-01-01", end: "2021-12-31"});
  assert.deepEqual(draft.source.referenceMetadata.requestedPeriod, {start: "2025-01-01", end: "2025-12-31"});
  assert.equal(draft.source.referenceMetadata.periodSuitability, "disjoint");
});

it("rejects incomplete, impossible or inverted dates and accepts real leap days", () => {
  for (const [start, end] of [["2024-01-01", null], [null, "2024-01-01"], ["2024-02-30", "2024-03-01"],
    ["2025-02-29", "2025-03-01"], ["2024-02-02", "2024-02-01"], ["", ""]]) {
    assert.throws(() => worldCoverReferences({bounds: [0, 0, 1, 1], periodStart: start, periodEnd: end}), /baseline_period_invalid/);
  }
  assert.equal(assessBaselinePeriod({sourceStart: "2024-02-29", sourceEnd: "2024-02-29", requestedStart: "2024-02-29", requestedEnd: "2024-02-29"}), "matches");
});

it("keeps source native taxonomy, terms and immutable descriptors separate from editable drafts", () => {
  const [first, second] = worldCoverReferences({bounds: [2.9, 51.1, 3.1, 51.2]});
  assert.equal(first.source.license, "CC-BY-4.0");
  assert.equal(first.classification, "internal");
  assert.deepEqual(first.tags, []);
  assert.equal(Object.keys(first.source.referenceMetadata.classMeanings).length, 11);
  assert.equal(first.source.referenceMetadata.classMeanings[40], "Cropland");
  first.source.referenceMetadata.classMeanings[40] = "Changed";
  first.source.referenceMetadata.observationPeriod.start = "2025-01-01";
  first.source.referenceMetadata.evidenceUrls.length = 0;
  assert.equal(second.source.referenceMetadata.classMeanings[40], "Cropland");
  assert.equal(WORLDCOVER_2021.observationPeriod.start, "2021-01-01");
  assert.equal(WORLDCOVER_2021.evidenceUrls.length, 3);
  assert(Object.isFrozen(WORLDCOVER_2021.classMeanings));
  assert(Object.isFrozen(FTW_GLOBAL.confidence));
  assert.equal(FTW_GLOBAL.distributionVersion, "mutable-alpha");
  assert.equal(FTW_GLOBAL.catalogUrl, "https://data.source.coop/ftw/global-data/catalog.json");
  assert.equal(FTW_GLOBAL.vectorCollectionUrl, "https://data.source.coop/ftw/global-data/predictions/vectors/collection.json");
  assert.match(FTW_GLOBAL.confidence.interpretation, /not a calibrated/);
  assert(FTW_GLOBAL.limitations.some(line => line.includes("land-tenure")));
});

it("creates candidate references and suitability entirely offline", () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Provider reads are not part of local source selection");
  try {
    assert.equal(worldCoverReferences({bounds: [0, 0, 1, 1]}).length, 1);
    assert.equal(assessBaselinePeriod(), "not-assessed");
  } finally {globalThis.fetch = original;}
});

it("recognizes only canonical valid WorldCover 2021 v200 tile distribution URLs", () => {
  const url = worldCoverReferences({bounds: [3, 51, 6, 54]})[0].source.url;
  assert.equal(worldCoverProfileForUrl(url), WORLDCOVER_2021);
  for (const candidate of [null, "", url + "?token=private", url + "#fragment", url.replace("https:", "http:"),
    url.replace("esa-worldcover.s3", "elsewhere.s3"), url.replace("v200_N51", "v200_N52"),
    url.replace("N51E003", "N90E003"), url.replace("N51E003", "S00E003"), url.replace("N51E003", "N51W000"),
    url.replace("N51E003", "N51E180"), url.replace("/v200/", "/v100/"), url.replace(".tif", ".tiff"),
    url.replace("https://", "https://user:secret@")]) assert.equal(worldCoverProfileForUrl(candidate), null);
  assert.equal(worldCoverProfileForUrl(url.replace("N51E003", "S90W180")), WORLDCOVER_2021);
});
