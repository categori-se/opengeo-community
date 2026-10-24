import assert from "node:assert/strict";
import {test} from "node:test";
import {RECEPTOR_SCREENING_LIMITS, buildReceptorScreening, validateReceptorScreeningReport,
  receptorScreeningCsv} from "../src/lib/receptorScreening.js";
import {receptorClip, receptorFeatureId, receptorScreeningFixture, receptorScreeningIds} from "./fixtures/receptor-screening.js";

const reportOf = collection => collection["opengeo:analysis"].screening;
const rectangleArea = (west, south, east, north) => 6371008.8 ** 2 * Math.abs((east - west) * Math.PI / 180
  * (Math.sin(north * Math.PI / 180) - Math.sin(south * Math.PI / 180)));
function distance(first, second) {
  const radians = value => value * Math.PI / 180, dlat = radians(second[1] - first[1]), dlon = radians(second[0] - first[0]);
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.sin(dlat / 2) ** 2
    + Math.cos(radians(first[1])) * Math.cos(radians(second[1])) * Math.sin(dlon / 2) ** 2));
}
const approximately = (actual, expected) => assert(Math.abs(actual - expected) <= 1e-7 * Math.max(1, expected), `${actual} differs from ${expected}`);
function frozen(value) {if (value && typeof value === "object") {Object.values(value).forEach(frozen); Object.freeze(value);} return value;}
function emptyFixture() {
  return {...receptorScreeningFixture(), footprint: receptorClip({features: []}), influence: receptorClip({scope: "influence", features: []})};
}

test("screening preserves clipped geometry and source properties across separate footprint and influence scopes", () => {
  const fixture = frozen(receptorScreeningFixture()), original = JSON.stringify(fixture);
  const collection = buildReceptorScreening(fixture), receipt = collection["opengeo:analysis"], report = reportOf(collection);
  assert.equal(JSON.stringify(fixture), original);
  assert.equal(receipt.operation, "receptor-screen"); assert.equal(receipt.persisted, false); assert.equal(receipt.crs, "CRS:84");
  assert.equal(receipt.sourceDatasetId, receptorScreeningIds.receptors); assert.equal(receipt.source_generation, 3);
  assert.equal(receipt.targetDatasetId, receptorScreeningIds.footprint); assert.equal(receipt.target_generation, 7);
  assert.deepEqual(report.inputs, {receptors: {datasetId: receptorScreeningIds.receptors, generation: 3, featureCount: 5},
    footprint: {datasetId: receptorScreeningIds.footprint, generation: 7, featureCount: 1},
    influence: {datasetId: receptorScreeningIds.influence, generation: 8, featureCount: 1}});
  assert.equal(collection.features.length, 6);
  for (const feature of collection.features) {
    const row = report.rows.find(row => row.id === feature.id), {id, ...screening} = row;
    const native = fixture[row.scope].features.find(feature => feature.id === row.sourceFeatureId);
    assert.equal(JSON.stringify(feature.geometry), JSON.stringify(native.geometry));
    assert.deepEqual(feature.properties, {source: native.properties, screening});
  }
  assert.deepEqual(validateReceptorScreeningReport(JSON.parse(JSON.stringify(report))), report);
  assert.equal(report.scope.coverageCompleteness, "unknown"); assert.equal(report.scope.sourceQuality, "unknown");
  assert.equal(report.scope.observationPeriods, "unknown"); assert.equal(report.scope.footprintInfluenceRelationship, "user-declared-not-validated");
  assert.equal(report.scope.impactAssessment, "not-assessed"); assert.equal(report.scope.households, "not-inferred");
  assert.equal(report.scope.rights, "not-inferred"); assert.equal(report.scope.compensation, "not-inferred");
  assert.equal(report.validatedCount, null); assert.equal(report.method.radiusMeters, 6371008.8);
  assert(!Object.hasOwn(report, "totalAreaSquareMeters"));
});

test("holes, multipart polygons, great-circle lines and point counts retain dimension-specific measures", () => {
  const report = reportOf(buildReceptorScreening(receptorScreeningFixture()));
  const footprint = report.scopes.footprint, influence = report.scopes.influence;
  approximately(footprint.areaSquareMeters, rectangleArea(85, 27, 85.003, 27.003) - rectangleArea(85.001, 27.001, 85.002, 27.002));
  approximately(influence.areaSquareMeters, rectangleArea(85, 27, 85.001, 27.001) + rectangleArea(85.002, 27.002, 85.003, 27.003));
  approximately(footprint.lengthMeters, distance([85, 27], [85.001, 27]) + distance([85.001, 27], [85.001, 27.002]));
  approximately(influence.lengthMeters, distance([85, 27], [85.001, 27]) + distance([85.002, 27.002], [85.003, 27.003]));
  for (const summary of [footprint, influence]) {
    assert.equal(summary.featureCount, 3); assert.equal(summary.pointFeatureCount, 1);
    assert.equal(summary.lineFeatureCount, 1); assert.equal(summary.polygonFeatureCount, 1);
  }
  assert.equal(footprint.pointCount, 1); assert.equal(influence.pointCount, 2);
  for (const row of report.rows) {
    if (row.geometryType.includes("Polygon")) {assert(row.areaSquareMeters > 0); assert.equal(row.lengthMeters, 0); assert.equal(row.pointCount, 0);}
    else if (row.geometryType.includes("LineString")) {assert(row.lengthMeters > 0); assert.equal(row.areaSquareMeters, 0); assert.equal(row.pointCount, 0);}
    else {assert(row.pointCount > 0); assert.equal(row.areaSquareMeters, 0); assert.equal(row.lengthMeters, 0);}
  }
});

test("polygon pilot distinguishes partial footprint exposure from whole influence exposure without combining zones", () => {
  const fixture = receptorScreeningFixture({profile: "polygons"}), report = reportOf(buildReceptorScreening(fixture));
  assert.equal(report.inputs.receptors.featureCount, 2);
  assert.equal(report.scopes.footprint.featureCount, 1); assert.equal(report.scopes.influence.featureCount, 2);
  approximately(report.scopes.footprint.areaSquareMeters, rectangleArea(85, 27, 85.001, 27.001));
  approximately(report.scopes.influence.areaSquareMeters, rectangleArea(85, 27, 85.002, 27.002) + rectangleArea(85.003, 27.003, 85.004, 27.004));
  assert.equal(report.rows.filter(row => row.sourceFeatureId === receptorFeatureId(1)).length, 2);
  const duplicate = structuredClone(fixture.footprint.features[0]); duplicate.id = receptorFeatureId(2);
  fixture.footprint.features.push(duplicate);
  // Separate receptor records with coincident geometry contribute separately.
  // Their original attributes remain consistent with the shared source identity.
  duplicate.properties = structuredClone(fixture.influence.features[1].properties);
  const repeated = reportOf(buildReceptorScreening(fixture));
  approximately(repeated.scopes.footprint.areaSquareMeters, 2 * report.scopes.footprint.areaSquareMeters);
  assert.match(repeated.method.aggregation, /including-overlaps-and-duplicates/);
});

test("same mask and generation reuse one native receipt while retaining both named scopes", () => {
  const fixture = receptorScreeningFixture({profile: "polygons"}); fixture.influence = fixture.footprint;
  const collection = buildReceptorScreening(fixture), report = reportOf(collection);
  assert.equal(report.nativeReceipts.length, 1);
  assert.equal(report.scopes.footprint.clipReceiptIndex, 0); assert.equal(report.scopes.influence.clipReceiptIndex, 0);
  assert.equal(report.scopes.footprint.featureCount, 1); assert.equal(report.scopes.influence.featureCount, 1);
  assert.equal(collection.features.length, 2); assert.notEqual(collection.features[0].id, collection.features[1].id);
  assert.deepEqual(report.inputs.footprint, report.inputs.influence);
  const changed = {...fixture, influence: structuredClone(fixture.influence)}; changed.influence.features[0].geometry.coordinates[0][1][0] += .0001;
  assert.throws(() => buildReceptorScreening(changed), /identical clip results/);
});

test("no contacts is a valid zero result; point contacts remain points and zero measures are rejected for lines and polygons", () => {
  const collection = buildReceptorScreening(emptyFixture()), report = reportOf(collection);
  assert.deepEqual(collection.features, []); assert.deepEqual(report.rows, []);
  for (const summary of Object.values(report.scopes)) {
    assert.equal(summary.featureCount, 0); assert.equal(summary.areaSquareMeters, 0); assert.equal(summary.lengthMeters, 0); assert.equal(summary.pointCount, 0);
  }
  assert.equal(receptorScreeningCsv(report).split("\r\n").length, 2);
  const point = receptorClip().features[0]; point.geometry.coordinates = [85, 27];
  const fixture = emptyFixture(); fixture.footprint.features = [point];
  const contact = buildReceptorScreening(fixture);
  assert.equal(reportOf(contact).scopes.footprint.pointCount, 1); assert.deepEqual(contact.features[0].geometry, point.geometry);
  for (const geometry of [{type: "LineString", coordinates: [[85, 27], [85, 27]]},
    {type: "Polygon", coordinates: [[[85, 27], [85.001, 27], [85.002, 27], [85, 27]]]}]) {
    const failed = emptyFixture(); failed.footprint.features = [{...point, geometry}];
    assert.throws(() => buildReceptorScreening(failed), /positive/);
  }
});

test("source pin asymmetry, invalid native acceptance, repeated feature IDs and contradictory source attributes fail", () => {
  const mutations = [
    value => {value.influence["opengeo:analysis"].sourceDatasetId = receptorScreeningIds.footprint;},
    value => {value.influence["opengeo:analysis"].source_generation++;},
    value => {value.influence["opengeo:analysis"].source_count++;},
    value => {value.influence["opengeo:analysis"].source_points++;},
    value => {value.footprint["opengeo:analysis"].operation = "intersection";},
    value => {value.footprint["opengeo:analysis"].version = "2.0.0";},
    value => {value.footprint["opengeo:analysis"].allowed = false;},
    value => {value.footprint["opengeo:analysis"].persisted = true;},
    value => {value.footprint["opengeo:analysis"].crs = "EPSG:3857";},
    value => {value.footprint["opengeo:analysis"].source_generation = 0;},
    value => {value.footprint["opengeo:analysis"].targetDatasetId = receptorScreeningIds.receptors;},
    value => {value.footprint["opengeo:analysis"].source_count = 1;},
    value => {value.footprint["opengeo:analysis"].target_count = 0; value.footprint["opengeo:analysis"].target_points = 0;},
    value => {value.footprint["opengeo:analysis"].limits.coordinates++;},
    value => {value.footprint.features[1].id = value.footprint.features[0].id;},
    value => {value.footprint.features[0].id = "not-a-uuid";},
    value => {value.influence.features[0].properties.name = "changed source generation";},
    value => {value.question = " ";}, value => {value.influenceBasis = "x".repeat(501);}
  ];
  for (const mutate of mutations) {const fixture = receptorScreeningFixture(); mutate(fixture); assert.throws(() => buildReceptorScreening(fixture));}
  const legacy = receptorScreeningFixture(); legacy.footprint["opengeo:analysis"].version = "1.0.0";
  assert.equal(reportOf(buildReceptorScreening(legacy)).nativeReceipts[0].version, "1.0.0");
});

test("known native clip facts survive while unknown future receipt and collection siblings are excluded", () => {
  const fixture = receptorScreeningFixture();
  fixture.footprint["opengeo:analysis"].futurePrivateContext = {credentials: "private-secret"};
  fixture.footprint.privateSource = "private-secret";
  fixture.footprint["opengeo:analysis"].previewId = "b4000000-0000-4000-8000-000000000004";
  const report = reportOf(buildReceptorScreening(fixture));
  assert(!JSON.stringify(report).includes("private-secret"));
  assert.equal(report.nativeReceipts[0].previewId, fixture.footprint["opengeo:analysis"].previewId);
  assert.equal(report.nativeReceipts[0].source_points, 50); assert.equal(report.nativeReceipts[0].target_points, 5);
  assert.equal(report.nativeReceipts[0].longitude_span, .01);
});

test("portable reports enforce closed fields, role pins, per-scope partitions and dimension-specific totals", () => {
  const report = reportOf(buildReceptorScreening(receptorScreeningFixture()));
  const mutations = [
    value => {value.private = true;}, value => {value.schemaVersion = "other";}, value => {value.validatedCount = 5;},
    value => {value.scope.households = "validated";}, value => {value.scope.observationPeriods = "2024";},
    value => {value.method.radiusMeters = 6378137;}, value => {value.limits.positions++;},
    value => {value.inputs.receptors.generation++;}, value => {value.inputs.influence.datasetId = receptorScreeningIds.footprint;},
    value => {value.inputs.receptors.featureCount = 1;}, value => {value.nativeReceipts[0].private = true;},
    value => {value.nativeReceipts[0].allowed = false;}, value => {value.nativeReceipts[0].source_points++;},
    value => {value.scopes.footprint.clipReceiptIndex = 1;}, value => {value.scopes.influence.featureCount++;},
    value => {value.scopes.footprint.areaSquareMeters++;}, value => {value.rows.reverse();},
    value => {value.rows[0].scope = "combined";}, value => {value.rows[0].sourceFeatureId = "invalid";},
    value => {value.rows[0].id = value.rows[1].id;}, value => {value.rows[0].pointCount = 2;},
    value => {value.rows[1].lengthMeters = 0;}, value => {value.rows[2].areaSquareMeters = -1;},
    value => {value.rows[0].positionCount = Infinity;}, value => {value.rows[0].private = true;},
    value => {value.rows.pop();}
  ];
  for (const mutate of mutations) {const changed = structuredClone(report); mutate(changed); assert.throws(() => validateReceptorScreeningReport(changed));}
  const clone = validateReceptorScreeningReport(report); clone.rows[0].pointCount = 10;
  assert.equal(report.rows[0].pointCount, 1);
});

test("CSV quotes text and neutralizes spreadsheet formulas without altering the saved question or basis", () => {
  const fixture = receptorScreeningFixture(); fixture.question = '=HYPERLINK("https://example.invalid","text")'; fixture.influenceBasis = " +SUM(1,2) ";
  const collection = buildReceptorScreening(fixture), report = reportOf(collection), csv = receptorScreeningCsv(collection);
  assert.equal(report.question, fixture.question); assert.equal(report.influenceBasis, "+SUM(1,2)");
  assert(csv.includes('"\'=HYPERLINK(""https://example.invalid"",""text"")"'));
  assert(csv.includes('"\'+SUM(1,2)"'));
  assert.equal(csv, receptorScreeningCsv(report)); assert.equal(csv.split("\r\n").length, report.rows.length + 2);
});

test("feature, position, output-byte and geographic profile ceilings reject without modifying inputs", () => {
  const featureLimit = emptyFixture(), point = receptorClip().features[0];
  featureLimit.footprint.features = Array(501).fill(point); featureLimit.influence.features = Array(500).fill(point);
  assert.throws(() => buildReceptorScreening(featureLimit), /combined feature limit/);
  const positionLimit = emptyFixture(), coordinates = Array.from({length: 25_001}, (_, index) => [85 + (index % 2) * .001, 27]);
  positionLimit.footprint.features = [{...point, geometry: {type: "LineString", coordinates}}];
  positionLimit.influence.features = structuredClone(positionLimit.footprint.features);
  assert.throws(() => buildReceptorScreening(positionLimit), /combined position limit/);
  const bytes = emptyFixture(), properties = {values: Array(30).fill("x".repeat(8_000))};
  bytes.footprint.features = Array.from({length: 5}, (_, index) => ({...structuredClone(point), id: receptorFeatureId(index + 1), properties}));
  bytes.influence.features = structuredClone(bytes.footprint.features);
  assert.throws(() => buildReceptorScreening(bytes), /byte limit/);
  for (const mutate of [geometry => {geometry.coordinates = [85, 81];}, geometry => {geometry.coordinates = [92, 27];},
    geometry => {geometry.coordinates = [85, 34];}, geometry => {geometry.coordinates = [85, 27, 0];},
    geometry => {geometry.coordinates = [NaN, 27];}, geometry => {geometry.type = "GeometryCollection"; delete geometry.coordinates; geometry.geometries = [];}]) {
    const fixture = receptorScreeningFixture(); mutate(fixture.footprint.features[0].geometry);
    const before = structuredClone(fixture); assert.throws(() => buildReceptorScreening(fixture)); assert.deepEqual(fixture, before);
  }
});

test("the one screening time budget stops processing without a partial result", context => {
  let calls = 0;
  context.mock.method(performance, "now", () => calls++ === 0 ? 0 : RECEPTOR_SCREENING_LIMITS.milliseconds);
  assert.throws(() => buildReceptorScreening(receptorScreeningFixture()), /time limit/);
});
