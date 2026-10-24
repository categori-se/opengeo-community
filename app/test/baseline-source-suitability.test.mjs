import assert from "node:assert/strict";
import {test} from "node:test";
import {BASELINE_SOURCE_SUITABILITY_LIMITS, reviewBaselineSources, validateBaselineSourceSuitability} from "../src/lib/baselineSourceSuitability.js";
import {WORLDCOVER_2021, FTW_GLOBAL} from "../src/lib/publishedBaselineSources.js";

const timestamp = "2026-10-23T20:15:30-04:00";
const options = extra => ({purpose: "land-cover-and-fields", bounds: [85, 27, 85.01, 27.01], timestamp, ...extra});
const review = extra => reviewBaselineSources(options(extra));
const worldCover = report => report.candidates.find(candidate => candidate.id === WORLDCOVER_2021.id);
const fields = report => report.candidates.find(candidate => candidate.id === FTW_GLOBAL.id);

test("purpose compatibility always precedes a preferred date or resolution match", () => {
  const fieldPurpose = review({purpose: "field-boundaries", periodStart: "2021-01-01", periodEnd: "2021-12-31", priority: "dates"});
  assert.equal(fieldPurpose.candidates[0].id, FTW_GLOBAL.id);
  assert.equal(fields(fieldPurpose).assessments.purpose.status, "matches");
  assert.equal(fields(fieldPurpose).assessments.dates.status, "mismatch");
  assert.equal(worldCover(fieldPurpose).assessments.purpose.status, "mismatch");
  assert.equal(worldCover(fieldPurpose).assessments.dates.status, "matches");
  const landCoverPurpose = review({purpose: "land-cover", periodStart: "2024-01-01", periodEnd: "2024-12-31"});
  assert.equal(landCoverPurpose.candidates[0].id, WORLDCOVER_2021.id);
  assert.equal(fields(landCoverPurpose).assessments.purpose.status, "mismatch");
  assert.deepEqual(fieldPurpose.method.lexicographicOrder, ["purpose", "dates", "id"]);
  assert.equal(fieldPurpose.candidates.length, 2);
});

test("an explicit priority changes ordinal ranking only after equal purpose compatibility", () => {
  const dates = review({periodStart: "2024-01-01", periodEnd: "2024-12-31", maximumResolutionMeters: 10});
  assert.equal(dates.candidates[0].id, FTW_GLOBAL.id);
  const resolution = review({periodStart: "2024-01-01", periodEnd: "2024-12-31", maximumResolutionMeters: 10, priority: "resolution"});
  assert.equal(resolution.candidates[0].id, WORLDCOVER_2021.id);
  assert.deepEqual(resolution.method.lexicographicOrder, ["purpose", "resolution", "id"]);
  assert.deepEqual(resolution.candidates.map(candidate => candidate.rank), [1, 2]);
  for (const candidate of resolution.candidates) {
    assert.equal(candidate.assessments.purpose.status, "partial");
    assert.equal(candidate.recommendation.status, "requires-evidence");
    assert(!Object.hasOwn(candidate, "score")); assert(!Object.hasOwn(candidate, "approved"));
  }
});

test("unknown or equal priority evidence uses stable source identity without weighted confidence", () => {
  for (const priority of ["coverage", "quality", "rights", "cost"]) {
    const report = review({priority});
    assert.deepEqual(report.candidates.map(candidate => candidate.id), [WORLDCOVER_2021.id, FTW_GLOBAL.id]);
    assert.equal(report.candidates[0].assessments[priority].status, priority === "rights" ? "partial" : "unknown");
  }
  assert.deepEqual(review().method.statusOrder, ["matches", "partial", "unknown", "mismatch"]);
});

test("source periods cover only their declared union and do not bridge missing years", () => {
  const annualUnion = review({periodStart: "2024-12-15", periodEnd: "2025-01-15"});
  assert.equal(fields(annualUnion).assessments.dates.status, "matches");
  assert.equal(worldCover(annualUnion).assessments.dates.status, "mismatch");
  const acrossMissingYears = review({periodStart: "2021-01-01", periodEnd: "2025-12-31"});
  assert.equal(fields(acrossMissingYears).assessments.dates.status, "partial");
  assert.equal(worldCover(acrossMissingYears).assessments.dates.status, "partial");
  const gap = review({periodStart: "2022-01-01", periodEnd: "2023-12-31"});
  assert(gap.candidates.every(candidate => candidate.assessments.dates.status === "mismatch"));
  const before = review({periodStart: "2023-12-31", periodEnd: "2024-01-01"});
  assert.equal(fields(before).assessments.dates.status, "partial");
  assert(review().candidates.every(candidate => candidate.assessments.dates.status === "unknown"));
  assert.deepEqual(fields(annualUnion).sourceFacts.observationPeriods, FTW_GLOBAL.observationPeriods);
});

test("nominal raster resolution is compared with an explicit maximum while vector boundary accuracy stays unknown", () => {
  const fine = review({priority: "resolution", maximumResolutionMeters: 9});
  assert.equal(worldCover(fine).assessments.resolution.status, "mismatch");
  assert.equal(fields(fine).assessments.resolution.status, "unknown");
  assert.equal(worldCover(review({maximumResolutionMeters: 10})).assessments.resolution.status, "matches");
  assert.equal(worldCover(review()).assessments.resolution.status, "unknown");
  assert.equal(worldCover(fine).sourceFacts.nominalRasterResolutionMeters, 10);
  assert.equal(fields(fine).sourceFacts.nominalRasterResolutionMeters, null);
  assert.equal(fields(fine).sourceFacts.inputImageryResolutionMeters, 10);
  assert.match(fields(fine).sourceFacts.outputResolutionInterpretation, /does not establish effective polygon resolution/);
  assert.equal(fields(fine).sourceFacts.confidence.sourceResolutionMeters, 500);
  assert.match(fields(fine).sourceFacts.confidence.interpretation, /not a calibrated polygon probability/);
});

test("taxonomy, declared licensing and missing quality, coverage and cost remain distinct from authorization", () => {
  const report = review(), landCover = worldCover(report), fieldBoundaries = fields(report);
  assert.equal(Object.keys(landCover.sourceFacts.taxonomy.classes).length, 11);
  assert.equal(landCover.sourceFacts.taxonomy.classes[40], "Cropland");
  assert.match(landCover.sourceFacts.taxonomy.featureMeaning, /not actual cultivation, crop species or tenure/);
  assert.deepEqual(fieldBoundaries.sourceFacts.taxonomy.classes, {});
  assert.match(fieldBoundaries.sourceFacts.taxonomy.featureMeaning, /no crop classes, cadastral identities/);
  for (const candidate of report.candidates) {
    assert.equal(candidate.sourceFacts.license, "CC-BY-4.0");
    assert.equal(candidate.sourceFacts.accessRights, "unknown"); assert.equal(candidate.sourceFacts.broaderRights, "unknown");
    assert.equal(candidate.sourceFacts.derivedOutputRights, "unknown");
    assert.equal(candidate.assessments.coverage.status, "unknown"); assert.equal(candidate.assessments.quality.status, "unknown");
    assert.equal(candidate.assessments.rights.status, "partial"); assert.equal(candidate.assessments.cost.status, "unknown");
    assert(candidate.sourceFacts.evidenceUrls.every(url => url.startsWith("https://")));
    assert(Object.values(candidate.assessments).every(assessment => assessment.basis && assessment.evidence.length));
  }
  assert.equal(report.scope.providerRequests, 0); assert.equal(report.scope.processingCost, "unknown");
  assert.equal(report.scope.countryAttribution, "not-inferred"); assert.equal(report.scope.authorization, "not-established");
  assert.equal(landCover.sourceFacts.availability, "unverified");
  assert.match(landCover.sourceFacts.versionStability, /object bytes not pinned/);
  assert.match(fieldBoundaries.sourceFacts.versionStability, /mutable-alpha/);
});

test("invalid purpose, priority, coordinates, periods, requested resolution and timestamps are rejected", () => {
  const invalid = [
    {purpose: "buildings"}, {priority: "confidence"}, {maximumResolutionMeters: 0}, {maximumResolutionMeters: -10},
    {maximumResolutionMeters: "10"}, {maximumResolutionMeters: Infinity}, {maximumResolutionMeters: NaN},
    {bounds: [85, 27, 85, 28]}, {bounds: [86, 27, 85, 28]}, {bounds: [179, 27, -179, 28]},
    {bounds: [85, 86, 86, 87]}, {bounds: [85, 27, 92, 28]}, {bounds: [85, 27, 91, 33]},
    {bounds: [85, 27, NaN, 28]}, {periodStart: "2024-01-01"}, {periodStart: null, periodEnd: "2024-01-01"},
    {periodStart: "2024-02-30", periodEnd: "2024-03-01"}, {periodStart: "2025-01-01", periodEnd: "2024-01-01"},
    {timestamp: "2026-10-23"}, {timestamp: "2026-10-23T20:15:30"}, {timestamp: "2026-02-30T20:15:30Z"},
    {timestamp: "2026-10-23T24:00:00Z"}, {timestamp: "2026-10-23T20:15:30+25:00"}
  ];
  for (const extra of invalid) assert.throws(() => review(extra));
  assert.doesNotThrow(() => review({periodStart: "2024-02-29", periodEnd: "2024-02-29", timestamp: "2024-02-29T12:00:00+05:45"}));
});

test("inputs and pinned source profiles remain immutable and every report is independently portable", () => {
  const input = options({periodStart: "2024-01-01", periodEnd: "2024-12-31"}), before = structuredClone(input);
  const constants = JSON.stringify([WORLDCOVER_2021, FTW_GLOBAL]);
  const report = reviewBaselineSources(input); assert.deepEqual(input, before);
  assert(new TextEncoder().encode(JSON.stringify(report)).byteLength <= BASELINE_SOURCE_SUITABILITY_LIMITS.outputBytes);
  const reopened = validateBaselineSourceSuitability(JSON.parse(JSON.stringify(report)));
  assert.deepEqual(reopened, report);
  reopened.criteria.bounds[0] = 0; fields(reopened).sourceFacts.confidence.method = "changed clone";
  assert.deepEqual(input, before); assert.notEqual(report.criteria.bounds[0], 0);
  assert.equal(JSON.stringify([WORLDCOVER_2021, FTW_GLOBAL]), constants);
  assert.deepEqual(reviewBaselineSources(input), report);
});

test("closed report validation rejects added discovery, altered facts, fabricated approvals and inconsistent ranking", () => {
  const report = review({periodStart: "2024-01-01", periodEnd: "2024-12-31"});
  const mutations = [
    value => {value.private = true;}, value => {value.schemaVersion = "other";}, value => {value.reviewedAt = "2026-02-30T12:00:00Z";},
    value => {value.criteria.country = "NP";}, value => {value.criteria.periodStart = undefined;},
    value => {value.candidates.pop();}, value => {value.candidates.push(structuredClone(value.candidates[0]));},
    value => {value.candidates[0].id = "new-provider";}, value => {value.candidates[0].rank = 2;}, value => {value.candidates.reverse();},
    value => {value.candidates[0].sourceFacts.accessRights = "authorized";}, value => {value.candidates[0].sourceFacts.aoiCoverage = "complete";},
    value => {value.candidates[0].sourceFacts.confidence.minimum = 99;}, value => {value.candidates[0].sourceFacts.evidenceUrls = [];},
    value => {value.candidates[0].assessments.quality.status = "matches";}, value => {value.candidates[0].assessments.cost.basis = "free";},
    value => {value.candidates[0].recommendation.status = "approved";}, value => {value.scope.processingCost = 0;},
    value => {value.method.lexicographicOrder = ["dates", "purpose", "id"];}, value => {value.method.weights = [1, 2];},
    value => {value.limits.sources = 3;}, value => {value.candidates[0].sourceFacts.private = "x".repeat(20_000);}
  ];
  for (const mutate of mutations) {const changed = structuredClone(report); mutate(changed); assert.throws(() => validateBaselineSourceSuitability(changed));}
});
