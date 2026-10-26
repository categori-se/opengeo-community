import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {SOCIAL_BASELINE_TOPICS, validateSocialBaselineEvidence, socialBaselineEvidenceCsv} from "../src/lib/socialBaselineEvidence.js";
import {buildReceptorScreening, validateReceptorScreeningReport, receptorScreeningCsv} from "../src/lib/receptorScreening.js";
import {receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const field = (name, extra = {}) => ({name, meaning: `Original source ${name} attribute`, unit: null, denominator: null, ...extra});
const review = (extra = {}) => ({schemaVersion: "opengeo.social-baseline-evidence.1.0.0", topic: "demographic-vulnerability",
  sourceDescription: "Curated census-zone inventory; no household observations", spatialUnit: "Original census enumeration zone",
  periodStart: "2020-01-01", periodEnd: "2020-12-31", coverage: "partial", coverageBasis: "Only selected source zones are available",
  suitability: "limited", suitabilityBasis: "Historical zone totals describe source zones, not the clipped area",
  limitations: "No disaggregation or confirmation of residence, tenure, vulnerability or impact", reviewer: "Project data curator",
  reviewedAt: "2026-10-25T12:00:00.000Z", fields: [field("name")], ...extra});
function screened(evidenceReview = review()) {
  const collection = buildReceptorScreening(receptorScreeningFixture({profile: "polygons"}));
  collection["opengeo:analysis"].screening.evidenceReview = evidenceReview;
  return collection;
}
function table(csv) {
  // Values may contain quoted commas/newlines. Parse the exported RFC-style cells.
  const rows = [], row = []; let value = "", quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {value += '"'; index++;} else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\r")) {
      row.push(value); value = "";
      if (char === "\r") {assert.equal(csv[++index], "\n"); rows.push([...row]); row.length = 0;}
    } else value += char;
  }
  const [headers, ...body] = rows;
  return body.map(values => Object.fromEntries(headers.map((key, index) => [key, values[index]])));
}
const reportOf = collection => collection["opengeo:analysis"].screening;

test("four explicit evidence topics validate detached assertions without changing inference limits", () => {
  assert.deepEqual(SOCIAL_BASELINE_TOPICS.map(topic => topic.id), ["demographic-vulnerability", "settlement", "community-infrastructure", "land-use"]);
  for (const topic of SOCIAL_BASELINE_TOPICS) {
    const input = review({topic: topic.id}), validated = validateSocialBaselineEvidence(input);
    assert.deepEqual(validated, input); validated.fields[0].meaning = "Changed detached copy";
    assert.notEqual(validated.fields[0].meaning, input.fields[0].meaning);
    const collection = screened(input), report = validateReceptorScreeningReport(reportOf(collection));
    assert.equal(report.scope.impactAssessment, "not-assessed"); assert.equal(report.scope.households, "not-inferred");
    assert.equal(report.scope.rights, "not-inferred"); assert.equal(report.validatedCount, null);
    assert.equal(report.scope.coverageCompleteness, "unknown"); // Curator assertion does not rewrite the analytical scope.
  }
  assert.doesNotThrow(() => validateSocialBaselineEvidence(review({periodStart: null, periodEnd: null,
    coverage: "unknown", coverageBasis: "", suitability: "unreviewed", suitabilityBasis: "", fields: []})));
});

test("closed review schema rejects missing context, unsupported claims and unbounded or invented field definitions", () => {
  const mutations = [value => {delete value.reviewer;}, value => {value.populationAffected = 200;},
    value => {value.schemaVersion = "opengeo.social-baseline-evidence.2.0.0";}, value => {value.topic = "impact";},
    value => {value.sourceDescription = " ";}, value => {value.spatialUnit = "a".repeat(161);},
    value => {value.limitations = "";}, value => {value.coverage = "verified-complete";},
    value => {value.coverageBasis = "";}, value => {value.suitabilityBasis = "";},
    value => {value.suitability = "approved";}, value => {value.reviewer = "a".repeat(161);},
    value => {value.fields = Array.from({length: 7}, (_, index) => field(`f${index}`));},
    value => {value.fields.push(field("name"));}, value => {value.fields[0].unit = "a".repeat(81);},
    value => {value.fields[0].denominator = "";}, value => {value.fields[0].meaning = "a".repeat(501);},
    value => {value.fields[0].aggregation = "sum";}, value => {value.fields[0].name = "x\0y";}];
  for (const mutate of mutations) {const value = review(); mutate(value); assert.throws(() => validateSocialBaselineEvidence(value));}
});

test("periods and review timestamps retain unknowns and reject calendar rollover, partial dates and invalid order", () => {
  for (const extra of [{periodStart: null}, {periodEnd: null}, {periodStart: "2020-02-30"}, {periodEnd: "2020-13-01"},
    {periodStart: "2021-01-01"}, {periodStart: "2020"}, {reviewedAt: "2026-10-25"},
    {reviewedAt: "2026-02-30T12:00:00Z"}, {reviewedAt: "2026-10-25T24:00:00Z"}]) {
    assert.throws(() => validateSocialBaselineEvidence(review(extra)));
  }
  assert.doesNotThrow(() => validateSocialBaselineEvidence(review({periodStart: "2020-02-29", reviewedAt: "2026-10-25T08:00:00-04:00"})));
});

test("legacy report and collection bytes remain unchanged when no evidence review is attached", () => {
  const collection = buildReceptorScreening(receptorScreeningFixture()), before = JSON.stringify(collection);
  assert.equal(createHash("sha256").update(before).digest("hex"), "0dc005af0651a4abe616e8d5b1c2f79aa3726b09042043a4e444d549303c0f07");
  const report = reportOf(collection), csv = receptorScreeningCsv(report);
  assert.deepEqual(validateReceptorScreeningReport(report), report);
  assert.equal(JSON.stringify(collection), before); assert(!Object.hasOwn(report, "evidenceReview"));
  report.evidenceReview = review(); assert.equal(receptorScreeningCsv(report), csv);
  report.evidenceReview = undefined; assert.throws(() => validateReceptorScreeningReport(report));
  report.evidenceReview = null; assert.throws(() => validateReceptorScreeningReport(report));
});

test("CSV preserves literal zone totals and rates per scope and distinguishes missing, null, empty, zero and false", () => {
  const input = receptorScreeningFixture({profile: "polygons"});
  for (const scope of [input.footprint, input.influence]) for (const feature of scope.features) {
    feature.properties = feature.id.endsWith("1") ? {population: 1250, rate: .25, flag: false, blank: "", measure: null,
      detail: {observations: [null, false, 0], note: "quoted, nested\nvalue"}} : {rate: null, blank: "", measure: 0};
  }
  const collection = buildReceptorScreening(input), report = reportOf(collection);
  report.evidenceReview = review({fields: [field("population", {unit: "people", denominator: "Whole original census zone"}),
    field("rate", {unit: "proportion", denominator: "Original census-zone population"}), field("flag"), field("blank"), field("measure"), field("detail")]});
  const before = JSON.stringify(collection), rows = table(socialBaselineEvidenceCsv(collection, validateReceptorScreeningReport(report)));
  assert.equal(rows.length, report.rows.length * 6); assert.equal(JSON.stringify(collection), before);
  const population = rows.filter(row => row.field_name === "population");
  assert.deepEqual(population.map(row => row.source_value), ["1250", "1250", ""]);
  assert.deepEqual(population.map(row => row.value_status), ["present", "present", "missing"]);
  assert.equal(population[0].field_denominator, "Whole original census zone");
  assert.notEqual(population[0].area_square_meters, population[1].area_square_meters);
  assert.equal(rows.find(row => row.field_name === "rate").source_value, "0.25");
  assert.equal(rows.find(row => row.field_name === "flag").source_value, "false");
  const blank = rows.find(row => row.field_name === "blank"); assert.equal(blank.value_status, "present"); assert.equal(blank.value_type, "string"); assert.equal(blank.source_value, "");
  const nullRow = rows.find(row => row.field_name === "measure" && row.value_status === "null"); assert.equal(nullRow.source_value, "");
  const zero = rows.find(row => row.field_name === "measure" && row.source_value === "0"); assert.equal(zero.value_status, "present"); assert.equal(zero.value_type, "number");
  const detail = rows.find(row => row.field_name === "detail" && row.value_status === "present");
  assert.deepEqual(JSON.parse(detail.source_value), input.footprint.features[0].properties.detail);
  assert(rows.every(row => /not summed, weighted or prorated/.test(row.source_attribute_interpretation)));
  assert(rows.every(row => /both scopes/.test(row.source_attribute_interpretation)));
});

test("CSV neutralizes spreadsheet formulas in raw text and review context without modifying retained originals", () => {
  const collection = screened(review({reviewer: "=IMPORT(\"x\")", fields: [field("name", {meaning: "+source label", unit: "@unit"}), field("negative")]}));
  for (const feature of collection.features) {
    feature.properties.source.name = " \t=SUM(1,2)";
    feature.properties.source.negative = -5;
  }
  const before = JSON.stringify(collection), rows = table(socialBaselineEvidenceCsv(collection, validateReceptorScreeningReport(reportOf(collection))));
  assert.equal(JSON.stringify(collection), before);
  assert.equal(rows[0].source_value, "' \t=SUM(1,2)"); assert.equal(rows[0].reviewer, "'=IMPORT(\"x\")");
  assert.equal(rows[0].field_meaning, "'+source label"); assert.equal(rows[0].field_unit, "'@unit");
  assert.equal(rows[1].source_value, "-5"); assert.equal(rows[1].value_type, "number");
});

test("CSV rejects substituted reports, inconsistent source copies, duplicate feature bindings and fields absent everywhere", () => {
  for (const mutate of [value => {value.features.pop();}, value => {value.features[1] = structuredClone(value.features[0]);},
    value => {value.features[0].properties.screening.pointCount++;}, value => {value.features[0].geometry.type = "Point";},
    value => {value.features[0].properties.source.name = "Different cross-scope source";},
    value => {delete value.features[0].properties.source;}]) {
    const collection = screened(); mutate(collection);
    assert.throws(() => socialBaselineEvidenceCsv(collection, validateReceptorScreeningReport(reportOf(collection))));
  }
  const collection = screened(), other = validateReceptorScreeningReport(reportOf(collection)); other.question = "Substituted screening";
  assert.throws(() => socialBaselineEvidenceCsv(collection, other), /does not match/);
  reportOf(collection).evidenceReview.fields = [field("imaginedPopulation")];
  assert.throws(() => socialBaselineEvidenceCsv(collection, validateReceptorScreeningReport(reportOf(collection))), /absent from every/);
  reportOf(collection).evidenceReview.fields = [];
  assert.equal(table(socialBaselineEvidenceCsv(collection, validateReceptorScreeningReport(reportOf(collection)))).length, 3);
});

test("CSV enforces its output byte ceiling without truncating the original evidence", () => {
  const collection = screened(review({fields: [field("name", {meaning: "m".repeat(500)})], sourceDescription: "s".repeat(500),
    coverageBasis: "c".repeat(500), suitabilityBasis: "u".repeat(500), limitations: "l".repeat(500)})), report = reportOf(collection);
  const original = structuredClone(collection.features[0]), row = structuredClone(report.rows[0]);
  collection.features = []; report.rows = [];
  for (let index = 0; index < 1_000; index++) {
    const id = `98000000-0000-4000-8000-${String(index).padStart(12, "0")}`, copy = structuredClone(original);
    const next = {...row, sourceFeatureId: id, id: `footprint:${id}`}, {id: featureId, ...screening} = next;
    copy.id = featureId; copy.properties.screening = screening; collection.features.push(copy); report.rows.push(next);
  }
  const before = JSON.stringify(collection);
  assert.throws(() => socialBaselineEvidenceCsv(collection, report), /CSV exceeds its byte limit/);
  assert.equal(JSON.stringify(collection), before);
});
