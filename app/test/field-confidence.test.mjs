import assert from "node:assert/strict";
import {it} from "node:test";
import {csvParse} from "d3";
import {reviewFieldConfidence, fieldConfidenceCsv, FIELD_CONFIDENCE_LIMITS} from "../src/lib/fieldConfidence.js";

function record(scores = [0, 50, 100, null]) {
  return {geojson: {type: "FeatureCollection", features: scores.map((confidence, index) => ({type: "Feature", id: `field-${index}`,
    properties: {id: `field-${index}`, confidence, original: {nested: ["preserve", null]}},
    geometry: {type: "Polygon", coordinates: [[[85, 27], [85.001, 27], [85.001, 27.001], [85, 27.001], [85, 27]]]}}))},
  receipt: {schemaVersion: "opengeo.ftw-query.1.0.0", status: "complete", query: {countryCode: "NP", year: 2024, bounds: [85, 27, 85.001, 27.001]},
    source: {catalogUrl: "https://data.source.coop/ftw/global-data/catalog.json",
      collectionUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/collection.json",
      itemUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/Nepal.json",
      partitionUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/Nepal.parquet",
      license: "CC-BY-4.0", attribution: "Fields of the World source attribution", etag: '"retained-edition"', distributionVersion: "mutable-alpha"},
    scope: {kind: "selected-country-partition-query", aoiClipped: false, wholeFootprints: true, providerCoverageVerified: false},
    counts: {geometryMatches: scores.length}, method: {id: "ftw-bbox-then-footprint", version: "1.0.0"}, ranges: [],
    localImport: {kind: "user-supplied-local-query", filename: "retained-query.json", sha256: "a".repeat(64), sizeBytes: 1234,
      importedAt: "2026-10-23T12:00:00Z", providerReverified: false}}};
}

it("preserves zero, equality, upper-bound and missing scores under explicit thresholds without acceptance decisions", () => {
  for (const [threshold, expected] of [[0, [0, 3]], [50, [1, 2]], [100, [2, 1]]]) {
    const input = record(), before = structuredClone(input), report = reviewFieldConfidence({record: input, threshold});
    assert.deepEqual(input, before); assert.deepEqual(report.rows.map(row => row.sourceConfidence), [0, 50, 100, null]);
    assert.deepEqual(report.summary, {fieldCount: 4, scoredCount: 3, missingCount: 1, minScore: 0, maxScore: 100,
      belowThresholdCount: expected[0], atOrAboveThresholdCount: expected[1]});
    assert.equal(report.rows[report.rows.findIndex(row => row.sourceConfidence === threshold)].status, "at-or-above-threshold");
    assert.equal(report.rows[3].status, "missing"); assert.equal(report.method.threshold, threshold);
    assert.equal(report.method.comparison, "strictly-below"); assert.equal(report.method.acceptanceDecisions, "none");
    assert.equal(report.rows.length, input.geojson.features.length); assert.equal(report.usage.additionalProviderRequests, 0);
  }
});

it("a null threshold is a complete score review and empty or all-missing queries keep unknown extrema", () => {
  const report = reviewFieldConfidence({record: record()});
  assert.deepEqual(report.rows.map(row => row.status), ["scored", "scored", "scored", "missing"]);
  assert.equal(report.summary.belowThresholdCount, null); assert.equal(report.summary.atOrAboveThresholdCount, null);
  assert.equal(report.method.threshold, null); assert.equal(report.method.thresholdAuthority, "not-requested");
  for (const scores of [[], [null, null]]) {
    const result = reviewFieldConfidence({record: record(scores), threshold: 0});
    assert.equal(result.summary.minScore, null); assert.equal(result.summary.maxScore, null); assert.equal(result.summary.scoredCount, 0);
    assert.equal(result.summary.missingCount, scores.length); assert.equal(result.summary.belowThresholdCount, 0);
    assert.equal(result.summary.atOrAboveThresholdCount, 0); assert.equal(result.rows.length, scores.length);
  }
});

it("rejects invalid score/threshold types, absent confidence, duplicate or inconsistent field IDs and excess fields", () => {
  for (const score of [-1, 101, NaN, Infinity, -Infinity, "50", false, undefined, {}]) {
    assert.throws(() => reviewFieldConfidence({record: record([score])}), {code: "field_confidence_score_invalid"});
  }
  const missing = record([null]); delete missing.geojson.features[0].properties.confidence;
  assert.throws(() => reviewFieldConfidence({record: missing}), {code: "field_confidence_score_invalid"});
  for (const threshold of [-1, 101, NaN, Infinity, "0", false, {}]) {
    assert.throws(() => reviewFieldConfidence({record: record(), threshold}), {code: "field_confidence_threshold_invalid"});
  }
  const duplicate = record([30, 30]); duplicate.geojson.features[1].id = duplicate.geojson.features[1].properties.id = "field-0";
  assert.throws(() => reviewFieldConfidence({record: duplicate}), {code: "field_confidence_duplicate_field_id"});
  for (const id of ["", "  ", 1, "x".repeat(1025)]) {
    const input = record([50]); input.geojson.features[0].id = input.geojson.features[0].properties.id = id;
    assert.throws(() => reviewFieldConfidence({record: input}), {code: "field_confidence_field_id_invalid"});
  }
  const inconsistent = record([50]); inconsistent.geojson.features[0].properties.id = "another-field";
  assert.throws(() => reviewFieldConfidence({record: inconsistent}), {code: "field_confidence_field_id_invalid"});
  assert.throws(() => reviewFieldConfidence({record: record(Array(1001).fill(50))}), {code: "field_confidence_feature_limit"});
});

it("retains only recognized closed FTW evidence and leaves source quality and pinning authority unchanged", () => {
  const input = record([51.25, null]); input.privateContext = "private-sibling";
  input.receipt.privateContext = "private-sibling"; input.receipt.source.credentials = "private-sibling";
  input.receipt.method.runtimeToken = "private-sibling"; input.geojson.features[0].properties.credentials = "private-sibling";
  const report = reviewFieldConfidence({record: input});
  assert.doesNotMatch(JSON.stringify(report), /private-sibling/);
  assert.deepEqual(report.sourceEvidence.query, input.receipt.query); assert.equal(report.sourceEvidence.source.etag, '"retained-edition"');
  assert.equal(report.sourceEvidence.localImport.providerReverified, false); assert.equal(report.sourceEvidence.source.distributionVersion, "mutable-alpha");
  assert.equal(report.sourceEvidence.scope.providerCoverageVerified, false); assert.equal(report.sourceEvidence.source.license, "CC-BY-4.0");
  assert.equal(report.rows[0].sourceConfidence, 51.25); assert.equal(report.method.sourceConfidence.sourceResolutionMeters, 500);
  assert.match(report.method.sourceConfidence.transformation, /none/); assert.equal(report.quality.calibratedProbability, null);
  assert.equal(report.quality.boundaryAccuracy, null); assert.equal(report.quality.independentValidation, null);
  assert.equal(report.summary.meanScore, undefined); assert.match(report.method.independence, /not established/);
  for (const change of [value => {value.receipt.status = "incomplete";}, value => {value.receipt.schemaVersion = "unknown";},
    value => {value.receipt.source.partitionUrl += "?token=private";}, value => {value.receipt.source.partitionUrl = "https://elsewhere.example/fields.parquet";}]) {
    const invalid = record(); change(invalid); assert.throws(() => reviewFieldConfidence({record: invalid}), {code: "field_confidence_source_invalid"});
  }
});

it("freezes detached reports and exports all rows plus source/query/version lineage with RFC CSV escaping and formula protection", () => {
  const input = record([0, null, 25, 75]), ids = ['=SUM(1,2)', 'field,"quoted"\nline', ' +1', '@external'];
  input.geojson.features.forEach((feature, index) => {feature.id = feature.properties.id = ids[index];});
  const report = reviewFieldConfidence({record: input, threshold: 25});
  input.geojson.features[0].properties.confidence = 100; input.receipt.source.etag = '"changed"';
  assert.equal(report.rows[0].sourceConfidence, 0); assert.equal(report.sourceEvidence.source.etag, '"retained-edition"');
  assert.throws(() => {report.rows[0].status = "accepted";}, TypeError);
  assert.throws(() => {report.sourceEvidence.query.year = 2025;}, TypeError);
  const csv = fieldConfidenceCsv(report), rows = csvParse(csv), context = JSON.parse(rows.find(row => row.record_type === "context").context_json), fields = rows.filter(row => row.record_type === "field");
  assert.equal(fields.length, 4); assert.deepEqual(fields.map(row => row.field_id), ["'" + ids[0], ids[1], "'" + ids[2], "'" + ids[3]]);
  assert.deepEqual(fields.map(row => row.source_confidence), ["0", "", "25", "75"]); assert.equal(fields[1].status, "missing");
  assert.equal(fields[2].status, "at-or-above-threshold"); assert.equal(context.method.threshold, 25);
  assert.deepEqual(context.sourceEvidence.query, report.sourceEvidence.query); assert.equal(context.sourceEvidence.localImport.sha256, "a".repeat(64));
  assert.equal(context.sourceEvidence.source.etag, '"retained-edition"'); assert.equal(context.quality.boundaryAccuracy, null);
  assert.match(csv, /"field,""quoted""\nline"/); assert.ok(new TextEncoder().encode(csv).byteLength <= FIELD_CONFIDENCE_LIMITS.outputBytes);
  assert.throws(() => fieldConfidenceCsv({...report, privateContext: "private"}), {code: "field_confidence_report_invalid"});
});

it("bounds report/export bytes and checks both operation deadlines without returning partial results", context => {
  const oversized = record(Array(1000).fill(50));
  oversized.geojson.features.forEach((feature, index) => {feature.id = feature.properties.id = `${index}-` + "😀".repeat(510);});
  assert.throws(() => reviewFieldConfidence({record: oversized}), {code: "field_confidence_output_limit"});
  const report = reviewFieldConfidence({record: record()});
  let calls = 0; context.mock.method(performance, "now", () => calls++ === 0 ? 0 : 5000);
  assert.throws(() => reviewFieldConfidence({record: record()}), {code: "field_confidence_time_limit"});
  calls = 0; assert.throws(() => fieldConfidenceCsv(report), {code: "field_confidence_time_limit"});
});
