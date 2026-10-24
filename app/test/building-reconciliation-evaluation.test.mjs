import assert from "node:assert/strict";
import {test} from "node:test";
import {BUILDING_EVALUATION_LIMITS, buildingReconciliationGroups, buildReviewedBuildingInventory,
  evaluateBuildingComparison, validateBuildingEvaluation} from "../src/lib/buildingReconciliation.js";

const sourceId = "a1000000-0000-4000-8000-000000000001";
const targetId = "a2000000-0000-4000-8000-000000000002";
const reviewerId = "a3000000-0000-4000-8000-000000000003";
const id = number => `97000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const qualified = (side, number) => `${side}:${id(number)}`;
function comparison(sourceCount, targetCount, edges = []) {
  const adjacency = {source: new Map(), target: new Map()};
  for (const edge of edges) for (const [side, index] of [["source", 0], ["target", 1]]) {
    const list = adjacency[side].get(edge[index]) ?? [];
    list.push(edge); adjacency[side].set(edge[index], list);
  }
  const degree = (side, number) => adjacency[side].get(number)?.length ?? 0;
  const row = (side, number) => {
    const neighbors = (adjacency[side].get(number) ?? []).map(edge => ({
      featureId: id(edge[side === "source" ? 1 : 0]), intersectionOverUnion: edge[2],
      overlapCount: degree(side === "source" ? "target" : "source", edge[side === "source" ? 1 : 0])}));
    const status = !neighbors.length ? "unmatched" : neighbors.length > 1 || neighbors.some(row => row.overlapCount > 1)
      ? "ambiguous" : neighbors[0].intersectionOverUnion >= .5 ? "one-to-one-candidate" : "boundary-disagreement";
    return {type: "Feature", id: qualified(side, number),
      geometry: {type: "Polygon", coordinates: [[[85, 27], [85.001, 27], [85.001, 27.001], [85, 27.001], [85, 27]]]},
      properties: {input: {side, featureId: id(number), properties: {confidence: null}},
        reconciliation: {status, reviewStatus: "unreviewed", neighbors}}};
  };
  return {type: "FeatureCollection", features: [
    ...Array.from({length: sourceCount}, (_, index) => row("source", index + 1)),
    ...Array.from({length: targetCount}, (_, index) => row("target", index + 1))
  ], "opengeo:analysis": {operation: "building-reconcile", version: "1.0.0", persisted: false, crs: "CRS:84",
    sourceDatasetId: sourceId, targetDatasetId: targetId, source_generation: 3, target_generation: 7,
    source_count: sourceCount, target_count: targetCount, allowed: true, building_polygon_inputs: true,
    buildingReconciliation: {minimumIntersectionOverUnion: .5, intersectionMethod: "PostGIS local projected geography overlay",
      areaMethod: "PostGIS spheroidal geography", candidateRule: "one positive-area neighbor on each side",
      ambiguityRule: "multiple positive-area neighbors on either side", unmatched: "retained on both sides",
      reviewStatus: "unreviewed", validatedCount: null, maximumSpanDegrees: 6, maximumAbsoluteLatitude: 80}}};
}
const evaluate = (collection, referenceSide = "source") => evaluateBuildingComparison({collection, referenceSide});

test("maximum-cardinality matching uses augmenting paths instead of losing an available one-to-one pair", () => {
  const input = comparison(2, 2, [[1, 1, .9], [1, 2, .6], [2, 1, .7]]), before = structuredClone(input);
  const report = evaluate(input);
  assert.deepEqual(report.pairs, [
    {referenceFeatureId: qualified("source", 1), predictionFeatureId: qualified("target", 2), intersectionOverUnion: .6},
    {referenceFeatureId: qualified("source", 2), predictionFeatureId: qualified("target", 1), intersectionOverUnion: .7}
  ]);
  assert.deepEqual(report.counts, {reference: 2, prediction: 2, truePositives: 2, falsePositives: 0, falseNegatives: 0});
  assert.equal(report.metrics.precision, 1); assert.equal(report.metrics.recall, 1); assert.equal(report.metrics.f1, 1);
  assert.deepEqual(report.inputs, {source: {datasetId: sourceId, generation: 3, featureCount: 2},
    target: {datasetId: targetId, generation: 7, featureCount: 2}});
  assert.deepEqual(input, before);
  assert.deepEqual(validateBuildingEvaluation(JSON.parse(JSON.stringify(report))), report);
});

test("split and merge candidates count once, admit IoU exactly 0.5 and disclose unmatched footprints", () => {
  const report = evaluate(comparison(3, 3, [[1, 1, .8], [1, 2, .7], [2, 3, .5], [3, 3, .499999]]));
  assert.deepEqual(report.counts, {reference: 3, prediction: 3, truePositives: 2, falsePositives: 1, falseNegatives: 1});
  assert.equal(report.metrics.precision, 2 / 3); assert.equal(report.metrics.recall, 2 / 3); assert.equal(report.metrics.f1, 2 / 3);
  assert.equal(report.metrics.meanIntersectionOverUnion, .65);
  assert(Math.abs(report.metrics.meanOneMinusIntersectionOverUnion - .35) < 1e-12);
  assert.deepEqual(report.unmatchedReferenceFeatureIds, [qualified("source", 3)]);
  assert.deepEqual(report.unmatchedPredictionFeatureIds, [qualified("target", 2)]);
  const none = evaluate(comparison(2, 3));
  assert.deepEqual(none.counts, {reference: 2, prediction: 3, truePositives: 0, falsePositives: 3, falseNegatives: 2});
  assert.equal(none.metrics.precision, 0); assert.equal(none.metrics.recall, 0); assert.equal(none.metrics.f1, 0);
  assert.equal(none.metrics.signedCountDifference, 1); assert.equal(none.metrics.absoluteCountDifference, 1);
  assert.equal(none.metrics.relativeCountDifference, .5); assert.equal(none.metrics.meanIntersectionOverUnion, null);
});

test("stable feature ordering resolves matching ties without claiming maximum summed IoU", () => {
  const input = comparison(2, 2, [[1, 1, 1], [1, 2, .5], [2, 1, .5], [2, 2, 1]]);
  const report = evaluate(input), reordered = structuredClone(input);
  reordered.features.reverse(); reordered.features.forEach(feature => feature.properties.reconciliation.neighbors.reverse());
  assert.deepEqual(evaluate(reordered), report);
  assert.deepEqual(report.pairs.map(pair => [pair.referenceFeatureId, pair.predictionFeatureId]), [
    [qualified("source", 1), qualified("target", 2)], [qualified("source", 2), qualified("target", 1)]
  ]);
  assert.equal(report.metrics.meanIntersectionOverUnion, .5);
  assert.match(report.method.matchingObjective, /not maximum total/);
  assert.match(report.method.tieBreak, /ascending reference IDs/);
  assert.equal(report.scope.interpretation, "inventory-agreement-only");
  assert.equal(report.scope.referenceCompleteness, "unknown"); assert.equal(report.scope.referenceAccuracy, "unknown");
  assert.equal(report.scope.groundTruth, "unestablished"); assert.equal(report.validatedCount, null);
});

test("swapping explicit reference and prediction roles swaps false positives, false negatives and count direction", () => {
  const input = comparison(3, 2, [[1, 2, .75]]), forward = evaluate(input), reverse = evaluate(input, "target");
  assert.deepEqual(forward.counts, {reference: 3, prediction: 2, truePositives: 1, falsePositives: 1, falseNegatives: 2});
  assert.deepEqual(reverse.counts, {reference: 2, prediction: 3, truePositives: 1, falsePositives: 2, falseNegatives: 1});
  assert.equal(reverse.referenceSide, "target"); assert.equal(reverse.predictionSide, "source");
  assert.equal(reverse.metrics.precision, forward.metrics.recall); assert.equal(reverse.metrics.recall, forward.metrics.precision);
  assert.equal(reverse.metrics.f1, forward.metrics.f1);
  assert.equal(forward.metrics.signedCountDifference, -1); assert.equal(reverse.metrics.signedCountDifference, 1);
  assert.equal(forward.metrics.relativeCountDifference, -1 / 3); assert.equal(reverse.metrics.relativeCountDifference, .5);
  assert.equal(reverse.pairs[0].referenceFeatureId, qualified("target", 2));
  assert.equal(reverse.pairs[0].predictionFeatureId, qualified("source", 1));
});

test("empty inventories retain null metrics only where their denominators are zero", () => {
  const empty = evaluate(comparison(0, 0));
  assert.deepEqual(empty.counts, {reference: 0, prediction: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0});
  assert.deepEqual(empty.metrics, {precision: null, recall: null, f1: null, signedCountDifference: 0,
    absoluteCountDifference: 0, relativeCountDifference: null, meanIntersectionOverUnion: null, meanOneMinusIntersectionOverUnion: null});
  const noReference = evaluate(comparison(0, 2));
  assert.equal(noReference.metrics.precision, 0); assert.equal(noReference.metrics.recall, null);
  assert.equal(noReference.metrics.f1, 0); assert.equal(noReference.metrics.relativeCountDifference, null);
  const noPrediction = evaluate(comparison(2, 0));
  assert.equal(noPrediction.metrics.precision, null); assert.equal(noPrediction.metrics.recall, 0);
  assert.equal(noPrediction.metrics.f1, 0); assert.equal(noPrediction.metrics.relativeCountDifference, -1);
});

test("portable reports reject changed schema, methods, pins, counts, ID partitions and fabricated metrics", () => {
  const report = evaluate(comparison(3, 3, [[1, 1, .8], [2, 2, .7]]));
  const mutations = [
    value => {value.credentials = "secret";}, value => {value.schemaVersion = "other";},
    value => {value.validatedCount = 3;}, value => {value.scope.referenceAccuracy = "verified";},
    value => {value.scope.extra = true;}, value => {value.method.minimumIntersectionOverUnion = .1;},
    value => {value.method.version = "2.0.0";}, value => {value.limits.work++;},
    value => {value.referenceSide = "prediction";}, value => {value.predictionSide = "source";},
    value => {value.inputs.source.datasetId = "missing";}, value => {value.inputs.source.generation = 0;},
    value => {value.inputs.source.private = true;}, value => {value.inputs.target.datasetId = sourceId.toUpperCase();},
    value => {value.inputs.source.featureCount++;}, value => {value.counts.reference++;},
    value => {value.counts.falsePositives++;}, value => {value.counts.truePositives++;},
    value => {value.pairs[0].intersectionOverUnion = .49;}, value => {value.pairs[0].intersectionOverUnion = Infinity;},
    value => {value.pairs[0].predictionFeatureId = qualified("source", 1);},
    value => {value.pairs[1].predictionFeatureId = value.pairs[0].predictionFeatureId;},
    value => {value.pairs.reverse();}, value => {value.pairs[0].private = true;},
    value => {value.unmatchedReferenceFeatureIds = [qualified("source", 1)];},
    value => {value.unmatchedPredictionFeatureIds = [qualified("source", 3)];},
    value => {value.unmatchedReferenceFeatureIds = [];}, value => {value.unmatchedPredictionFeatureIds.push(qualified("target", 3));},
    value => {value.metrics.precision = 1;}, value => {value.metrics.recall = null;},
    value => {value.metrics.f1 = NaN;}, value => {value.metrics.meanIntersectionOverUnion = .9;},
    value => {value.metrics.relativeCountDifference = .1;}, value => {value.metrics.extra = 1;}
  ];
  for (const mutate of mutations) {const changed = structuredClone(report); mutate(changed); assert.throws(() => validateBuildingEvaluation(changed));}
  const tinyRounding = structuredClone(report); tinyRounding.metrics.precision += 1e-14;
  assert.doesNotThrow(() => validateBuildingEvaluation(tinyRounding));
  const clone = validateBuildingEvaluation(report); clone.pairs[0].intersectionOverUnion = 1;
  assert.equal(report.pairs[0].intersectionOverUnion, .8);
});

test("evaluation requires explicit reference choice and rejects invalid native comparisons", () => {
  const input = comparison(1, 1, [[1, 1, .8]]);
  for (const referenceSide of [undefined, null, "", "reference", "Source"]) {
    assert.throws(() => evaluateBuildingComparison({collection: input, referenceSide}), /reference inventory/);
  }
  for (const mutate of [value => {value.features.pop();}, value => {value["opengeo:analysis"].source_generation = 0;},
    value => {value.features[0].properties.reconciliation.neighbors[0].intersectionOverUnion = .9;},
    value => {value["opengeo:analysis"].operation = "building-reconcile-reviewed";}]) {
    const changed = structuredClone(input); mutate(changed); assert.throws(() => evaluate(changed));
  }
  assert.throws(() => evaluate(comparison(501, 500)), /bounded native/);
});

test("review attaches a freshly recomputed evaluation only after explicit reference selection and versions that addition", () => {
  const input = comparison(2, 2, [[1, 1, .8]]), before = structuredClone(input);
  const decisions = buildingReconciliationGroups(input).map(group => ({componentId: group.id,
    selectedFeatureIds: group.features.filter(feature => feature.properties.input.side === "source").map(feature => feature.id), reason: "Retain source geometry."}));
  const options = {collection: input, decisions, reviewerId, timestamp: "2026-10-23T18:20:00Z"};
  const original = buildReviewedBuildingInventory(options), same = buildReviewedBuildingInventory({...options, evaluationReferenceSide: undefined});
  assert.deepEqual(same, original);
  assert.equal(original["opengeo:analysis"].buildingReview.schemaVersion, "opengeo.building-inventory-review.1.0.0");
  assert(!Object.hasOwn(original["opengeo:analysis"].buildingReview, "evaluation"));
  const reviewed = buildReviewedBuildingInventory({...options, evaluationReferenceSide: "target"});
  assert.equal(reviewed["opengeo:analysis"].buildingReview.schemaVersion, "opengeo.building-inventory-review.1.1.0");
  assert.deepEqual(reviewed["opengeo:analysis"].buildingReview.evaluation, evaluate(input, "target"));
  assert.deepEqual(reviewed.features, original.features);
  assert.deepEqual(reviewed["opengeo:analysis"].buildingReconciliation, input["opengeo:analysis"].buildingReconciliation);
  assert.deepEqual(input, before);
  assert.throws(() => buildReviewedBuildingInventory({...options, evaluationReferenceSide: null}), /reference inventory/);
});

test("dense graphs stop at the fixed work budget and oversized adjacency stops before graph processing", () => {
  const edges = Array.from({length: 110}, (_, source) => Array.from({length: 110}, (_, target) => [source + 1, target + 1, .5])).flat();
  const dense = comparison(110, 110, edges), before = JSON.stringify(dense);
  assert.throws(() => evaluate(dense), /work limit/);
  assert.equal(JSON.stringify(dense), before);
  const oversized = comparison(1, 0);
  oversized.features[0].properties.reconciliation.neighbors = Array(BUILDING_EVALUATION_LIMITS.edges * 2 + 1).fill({});
  assert.throws(() => evaluate(oversized), /edge limit/);
});

test("the shared time budget stops the whole evaluation without returning partial metrics", context => {
  let reads = 0;
  context.mock.method(performance, "now", () => reads++ === 0 ? 0 : BUILDING_EVALUATION_LIMITS.milliseconds);
  assert.throws(() => evaluate(comparison(1, 1, [[1, 1, .8]])), /time limit/);
});
