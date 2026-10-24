import assert from "node:assert/strict";
import {test} from "node:test";
import {buildingReconciliationGroups, buildReviewedBuildingInventory} from "../src/lib/buildingReconciliation.js";

const sourceId = "a1000000-0000-4000-8000-000000000001";
const targetId = "a2000000-0000-4000-8000-000000000002";
const reviewerId = "a3000000-0000-4000-8000-000000000003";
const timestamp = "2026-10-23T17:24:36.123-04:00";
const id = number => `97000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const featureId = (side, number) => `${side}:${id(number)}`;
const neighbor = (number, intersectionOverUnion, overlapCount = 1) => ({featureId: id(number), intersectionOverUnion, overlapCount});
const geometry = {type: "Polygon", coordinates: [
  [[85.12345678901235, 27.1], [85.125, 27.1], [85.125, 27.103], [85.12345678901235, 27.103], [85.12345678901235, 27.1]],
  [[85.124, 27.101], [85.1245, 27.101], [85.1245, 27.102], [85.124, 27.102], [85.124, 27.101]]
]};
function row(side, number, status, neighbors = []) {
  return {type: "Feature", id: featureId(side, number), geometry: structuredClone(geometry),
    properties: {input: {side, featureId: id(number), properties: {name: `${side} footprint ${number}`, confidence: null,
      source: {license: "unknown", observations: [2021, null, {reviewed: false}]}}},
    reconciliation: {status, reviewStatus: "unreviewed", neighbors}}};
}
function comparison() {
  const features = [
    row("source", 1, "one-to-one-candidate", [neighbor(1, .8)]),
    row("target", 1, "one-to-one-candidate", [neighbor(1, .8)]),
    row("source", 2, "unmatched"), row("target", 2, "unmatched"),
    row("source", 3, "ambiguous", [neighbor(3, .4), neighbor(4, .3)]),
    row("target", 3, "ambiguous", [neighbor(3, .4, 2)]),
    row("target", 4, "ambiguous", [neighbor(3, .3, 2)]),
    row("source", 5, "ambiguous", [neighbor(5, .45, 2)]),
    row("source", 6, "ambiguous", [neighbor(5, .4, 2)]),
    row("target", 5, "ambiguous", [neighbor(5, .45), neighbor(6, .4)]),
    row("source", 7, "boundary-disagreement", [neighbor(7, .2)]),
    row("target", 7, "boundary-disagreement", [neighbor(7, .2)])
  ];
  features[7].geometry = {type: "MultiPolygon", coordinates: [structuredClone(geometry.coordinates)]};
  return {type: "FeatureCollection", features, "opengeo:analysis": {
    operation: "building-reconcile", version: "1.0.0", sourceDatasetId: sourceId, targetDatasetId: targetId,
    source_generation: 3, target_generation: 7, source_count: 6, target_count: 6,
    persisted: false, crs: "CRS:84", allowed: true, building_polygon_inputs: true,
    buildingReconciliation: {minimumIntersectionOverUnion: .5,
      intersectionMethod: "PostGIS local projected geography overlay", areaMethod: "PostGIS spheroidal geography",
      candidateRule: "one positive-area neighbor on each side", ambiguityRule: "multiple positive-area neighbors on either side",
      unmatched: "retained on both sides", reviewStatus: "unreviewed", validatedCount: null,
      maximumSpanDegrees: 6, maximumAbsoluteLatitude: 80}
  }};
}
function decisionsFor(collection, select = group => group.features.map(feature => feature.id)) {
  return buildingReconciliationGroups(collection).map(group => ({componentId: group.id,
    selectedFeatureIds: select(group), reason: "Reviewed against the selected survey."}));
}
function build(collection, decisions = decisionsFor(collection), extra = {}) {
  return buildReviewedBuildingInventory({collection, decisions, reviewerId, timestamp, ...extra});
}
function freeze(value) {
  if (value && typeof value === "object") {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}

test("building groups expose split, merge, pair and unmatched components deterministically without selecting", () => {
  const input = comparison(), before = structuredClone(input);
  const groups = buildingReconciliationGroups(input);
  assert.deepEqual(groups.map(group => [group.id, group.status, group.sourceCount, group.targetCount]), [
    [featureId("source", 1), "one-to-one-candidate", 1, 1],
    [featureId("source", 2), "unmatched", 1, 0],
    [featureId("source", 3), "ambiguous", 1, 2],
    [featureId("source", 5), "ambiguous", 2, 1],
    [featureId("source", 7), "boundary-disagreement", 1, 1],
    [featureId("target", 2), "unmatched", 0, 1]
  ]);
  assert.deepEqual(groups.flatMap(group => group.features.map(feature => feature.id)).sort(), input.features.map(feature => feature.id).sort());
  for (const group of groups) {
    assert.deepEqual(group.features.map(feature => feature.id), group.features.map(feature => feature.id).sort());
    assert(!Object.hasOwn(group, "selectedFeatureIds"));
    assert(group.features.every(feature => feature.properties.reconciliation.reviewStatus === "unreviewed"));
  }
  const reversed = structuredClone(input); reversed.features.reverse();
  reversed.features.forEach(feature => feature.properties.reconciliation.neighbors.reverse());
  assert.deepEqual(buildingReconciliationGroups(reversed).map(group => [group.id, group.features.map(feature => feature.id)]),
    groups.map(group => [group.id, group.features.map(feature => feature.id)]));
  groups[0].features[0].geometry.coordinates[0][0][0] = 0;
  groups[0].features[0].properties.input.properties.name = "changed clone";
  assert.deepEqual(input, before);
});

test("complete explicit selection preserves exact original geometry and nested properties with audited exclusions", () => {
  const input = freeze(comparison()), original = JSON.stringify(input);
  const selected = new Set([featureId("source", 1), featureId("target", 2), featureId("target", 3),
    featureId("target", 4), featureId("target", 5), featureId("source", 7), featureId("target", 7)]);
  const decisions = freeze(decisionsFor(input, group => group.features.filter(feature => selected.has(feature.id)).map(feature => feature.id)));
  const output = build(input, decisions), receipt = output["opengeo:analysis"], review = receipt.buildingReview;
  assert.equal(JSON.stringify(input), original);
  assert.equal(receipt.operation, "building-reconcile-reviewed");
  assert.deepEqual(receipt.buildingReconciliation, input["opengeo:analysis"].buildingReconciliation);
  assert.equal(receipt.sourceDatasetId, sourceId); assert.equal(receipt.source_generation, 3);
  assert.equal(receipt.targetDatasetId, targetId); assert.equal(receipt.target_generation, 7);
  assert.deepEqual(output.features.map(feature => feature.id), [...selected].sort());
  for (const feature of output.features) {
    const native = input.features.find(row => row.id === feature.id);
    assert.equal(JSON.stringify(feature.geometry), JSON.stringify(native.geometry));
    const expected = structuredClone(native);
    expected.properties.reconciliation.review = {componentId: decisions.find(decision => decision.selectedFeatureIds.includes(feature.id)).componentId,
      decision: "retain", reason: "Reviewed against the selected survey.", reviewerId, reviewedAt: timestamp};
    assert.deepEqual(feature, expected);
  }
  assert.deepEqual({...review, decisions: undefined}, {schemaVersion: "opengeo.building-inventory-review.1.0.0",
    method: "explicit-footprint-selection", reviewerId, reviewedAt: timestamp, inputFeatureCount: 12,
    retainedFeatureCount: 7, excludedFeatureCount: 5, componentCount: 6, selectedOverlapPairs: 1, validatedCount: null, decisions: undefined});
  const excluded = review.decisions.flatMap(decision => decision.excludedFeatureIds).sort();
  assert.deepEqual(excluded, input.features.filter(feature => !selected.has(feature.id)).map(feature => feature.id).sort());
});

test("retaining both sides discloses remaining overlaps once and preserves MultiPolygon coordinates", () => {
  const input = comparison(), decisions = decisionsFor(input);
  decisions.forEach(decision => {decision.selectedFeatureIds.reverse(); decision.reason = "  Preserve both until a field survey.  ";});
  decisions.reverse();
  const output = build(input, decisions), review = output["opengeo:analysis"].buildingReview;
  assert.equal(review.selectedOverlapPairs, 6); assert.equal(review.retainedFeatureCount, 12);
  assert.equal(review.excludedFeatureCount, 0); assert.equal(review.validatedCount, null);
  assert.deepEqual(review.decisions.map(decision => decision.componentId), buildingReconciliationGroups(input).map(group => group.id));
  assert(review.decisions.every(decision => decision.reason === "Preserve both until a field survey."));
  assert.equal(JSON.stringify(output.features.find(feature => feature.id === featureId("source", 5)).geometry),
    JSON.stringify(input.features.find(feature => feature.id === featureId("source", 5)).geometry));
  assert.deepEqual(output, build(input, [...decisions].reverse()));
  output["opengeo:analysis"].buildingReconciliation.minimumIntersectionOverUnion = 1;
  output.features[0].properties.input.properties.source.observations[2].reviewed = true;
  assert.equal(input["opengeo:analysis"].buildingReconciliation.minimumIntersectionOverUnion, .5);
  assert.equal(input.features[0].properties.input.properties.source.observations[2].reviewed, false);
});

test("explicitly excluding every footprint yields an empty reviewed inventory without an inferred count", () => {
  const input = comparison();
  assert.throws(() => buildReviewedBuildingInventory({collection: input, reviewerId, timestamp}), /decision/);
  const output = build(input, decisionsFor(input, () => [])), review = output["opengeo:analysis"].buildingReview;
  assert.deepEqual(output.features, []);
  assert.equal(review.retainedFeatureCount, 0); assert.equal(review.excludedFeatureCount, 12);
  assert.equal(review.selectedOverlapPairs, 0); assert.equal(review.validatedCount, null);
  assert(review.decisions.every(decision => decision.selectedFeatureIds.length === 0 && decision.excludedFeatureIds.length > 0));
});

test("missing, repeated, foreign or unexplained decisions fail instead of accepting candidates", () => {
  const input = comparison();
  const mutations = [
    decisions => {decisions.pop();},
    decisions => {decisions.push(structuredClone(decisions[0]));},
    decisions => {decisions[1] = structuredClone(decisions[0]);},
    decisions => {decisions[0].componentId = "unknown";},
    decisions => {decisions[0].selectedFeatureIds = [featureId("source", 2)];},
    decisions => {decisions[0].selectedFeatureIds = [featureId("source", 1), featureId("source", 1)];},
    decisions => {decisions[0].selectedFeatureIds = null;},
    decisions => {decisions[0].selectedFeatureIds = [null];},
    decisions => {decisions[0].reason = "  ";},
    decisions => {decisions[0].reason = "x".repeat(501);},
    decisions => {delete decisions[0].reason;},
    decisions => {decisions[0].credentials = "must not survive";}
  ];
  for (const mutate of mutations) {const decisions = decisionsFor(input); mutate(decisions); assert.throws(() => build(input, decisions));}
  const limit = decisionsFor(input); limit[0].reason = "x".repeat(500);
  assert.equal(build(input, limit)["opengeo:analysis"].buildingReview.decisions[0].reason.length, 500);
});

test("native method, graph, coordinate, count and input identity tampering is rejected before review", () => {
  const mutations = [
    value => {value["opengeo:analysis"].operation = "building-reconcile-reviewed";},
    value => {value["opengeo:analysis"].buildingReconciliation.validatedCount = 12;},
    value => {value["opengeo:analysis"].buildingReconciliation.minimumIntersectionOverUnion = .2;},
    value => {value["opengeo:analysis"].sourceDatasetId = "missing";},
    value => {value["opengeo:analysis"].targetDatasetId = sourceId.toUpperCase();},
    value => {value["opengeo:analysis"].source_generation = 0;},
    value => {delete value["opengeo:analysis"].target_generation;},
    value => {value["opengeo:analysis"].source_count++;},
    value => {value["opengeo:analysis"].persisted = true;},
    value => {value["opengeo:analysis"].crs = "EPSG:3857";},
    value => {value["opengeo:analysis"].version = "2.0.0";},
    value => {value["opengeo:analysis"].buildingReview = {};},
    value => {value.features[0].properties.reconciliation.neighbors[0].intersectionOverUnion = .7;},
    value => {value.features[0].properties.reconciliation.status = "unmatched";},
    value => {value.features[0].properties.reconciliation.review = {};},
    value => {value.features[0].properties.reconciliation.reviewStatus = "accepted";},
    value => {value.features[0].geometry.coordinates[0][0][0] = Infinity;},
    value => {value.features[0].geometry.coordinates[0].pop();},
    value => {value.features[0].id = value.features[1].id;},
    value => {value.features.pop();},
    value => {value.features = Array(1001).fill(value.features[0]);}
  ];
  for (const mutate of mutations) {
    const input = comparison(); mutate(input);
    assert.throws(() => buildingReconciliationGroups(input));
    assert.throws(() => buildReviewedBuildingInventory({collection: input, decisions: [], reviewerId, timestamp}));
  }
});

test("reviewer identity and actual ISO calendar/timezone are required", () => {
  const input = comparison(), decisions = decisionsFor(input);
  for (const invalid of [null, "", "reviewer", "00000000-0000-0000-0000-000000000000"]) {
    assert.throws(() => build(input, decisions, {reviewerId: invalid}));
  }
  for (const invalid of [null, "2026-10-23", "2026-10-23T17:24:36", "Fri, 23 Oct 2026 17:24:36 GMT",
    "2026-02-30T17:24:36Z", "2025-02-29T17:24:36Z", "2026-10-23T24:00:00Z", "2026-10-23T17:24:36+25:00"]) {
    assert.throws(() => build(input, decisions, {timestamp: invalid}), /timestamp/);
  }
  assert.equal(build(input, decisions, {timestamp: "2024-02-29T12:30:00+05:45"})["opengeo:analysis"].buildingReview.reviewedAt,
    "2024-02-29T12:30:00+05:45");
});
