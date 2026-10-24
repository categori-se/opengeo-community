import {spatialPreviewGeojson, validateBuildingReconciliationPreview} from "./apiPreviewContracts.js";
import {exactKeys, uuid} from "./apiResponseContracts.js";

/** Summaries count source and comparison inventories separately. Candidate pairs
 * appear in both inventories; they are counted once from the source side. */
export function buildingReconciliationSummary(collection) {
  if (collection?.["opengeo:analysis"]?.operation !== "building-reconcile") return null;
  const counts = () => ({total: 0, unmatched: 0, ambiguous: 0, candidates: 0, disagreements: 0});
  const source = counts(), target = counts();
  const keys = {unmatched: "unmatched", ambiguous: "ambiguous", "one-to-one-candidate": "candidates", "boundary-disagreement": "disagreements"};
  for (const feature of collection.features) {
    const side = feature.properties?.input?.side;
    const key = keys[feature.properties?.reconciliation?.status];
    if (!["source", "target"].includes(side) || !key) throw Error("Invalid building reconciliation result.");
    const row = side === "source" ? source : target;
    row.total++;
    row[key]++;
  }
  return {source, target, candidatePairs: source.candidates, validatedCount: null};
}

/** Group the native overlap graph without accepting any matching candidates. */
export function buildingReconciliationGroups(collection) {
  const receipt = collection?.["opengeo:analysis"];
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)
    || collection.features.length > 1_000 || receipt?.operation !== "building-reconcile"
    || receipt.version !== "1.0.0" || receipt.persisted !== false || receipt.crs !== "CRS:84"
    || receipt.buildingReview !== undefined) throw Error("A bounded native building comparison is required.");
  const sourceId = uuid(receipt.sourceDatasetId, "Building source dataset ID");
  const targetId = uuid(receipt.targetDatasetId, "Building comparison dataset ID");
  if (sourceId === targetId || ![receipt.source_generation, receipt.target_generation]
    .every(value => Number.isSafeInteger(value) && value >= 1)) {
    throw Error("Two distinct building inventories with input generations are required.");
  }
  const parsed = spatialPreviewGeojson({type: collection.type, features: collection.features});
  validateBuildingReconciliationPreview(parsed, receipt);
  const rows = new Map(parsed.features.map(feature => [feature.id, feature]));
  const visited = new Set(), groups = [];
  for (const id of [...rows.keys()].sort()) {
    if (visited.has(id)) continue;
    const pending = [id], features = [];
    visited.add(id);
    while (pending.length) {
      const feature = rows.get(pending.pop());
      if (feature.properties.reconciliation.review !== undefined) {
        throw Error("The native building comparison already contains review decisions.");
      }
      features.push(feature);
      const opposite = feature.properties.input.side === "source" ? "target" : "source";
      for (const neighbor of feature.properties.reconciliation.neighbors) {
        const neighborId = `${opposite}:${neighbor.featureId}`;
        if (!visited.has(neighborId)) {visited.add(neighborId); pending.push(neighborId);}
      }
    }
    features.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const sourceCount = features.filter(feature => feature.properties.input.side === "source").length;
    groups.push({id: features[0].id,
      status: features.some(feature => feature.properties.reconciliation.status === "ambiguous")
        ? "ambiguous" : features[0].properties.reconciliation.status,
      sourceCount, targetCount: features.length - sourceCount, features});
  }
  return groups;
}

/** Select original footprints only after every overlap component has a decision.
 * Retained overlaps remain explicit; these choices do not establish ground truth.
 */
export function buildReviewedBuildingInventory({collection, decisions, reviewerId, timestamp, evaluationReferenceSide}) {
  const groups = buildingReconciliationGroups(collection);
  const reviewer = uuid(reviewerId, "Building reviewer ID");
  if (!reviewTimestamp(timestamp)) throw Error("The building review timestamp must be an ISO date with a timezone.");
  if (!Array.isArray(decisions) || decisions.length !== groups.length) {
    throw Error("Record an explicit decision for every building comparison group.");
  }
  const byGroup = new Map(groups.map(group => [group.id, group])), reviewed = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw Error("Invalid building review decision.");
    exactKeys(decision, ["componentId", "selectedFeatureIds", "reason"], "Building review decision");
    const group = byGroup.get(decision.componentId);
    if (!group || reviewed.has(group.id)) throw Error("Each building comparison group needs exactly one decision.");
    if (typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.trim().length > 500) {
      throw Error("Explain each building review decision in at most 500 characters.");
    }
    if (!Array.isArray(decision.selectedFeatureIds) || decision.selectedFeatureIds.length > group.features.length) {
      throw Error("Choose footprints from their building comparison group.");
    }
    const members = new Set(group.features.map(feature => feature.id)), selected = new Set();
    for (const featureId of decision.selectedFeatureIds) {
      if (!members.has(featureId) || selected.has(featureId)) {
        throw Error("A selected building footprint must belong to its group and occur once.");
      }
      selected.add(featureId);
    }
    reviewed.set(group.id, {componentId: group.id, selectedFeatureIds: [...selected].sort(),
      excludedFeatureIds: group.features.filter(feature => !selected.has(feature.id)).map(feature => feature.id),
      reason: decision.reason.trim()});
  }
  const evaluation = evaluationReferenceSide === undefined ? null
    : evaluateBuildingComparison({collection, referenceSide: evaluationReferenceSide});
  const retainedIds = new Set([...reviewed.values()].flatMap(decision => decision.selectedFeatureIds));
  const features = [];
  let selectedOverlapPairs = 0;
  for (const group of groups) {
    const decision = reviewed.get(group.id);
    for (const feature of group.features) {
      if (!retainedIds.has(feature.id)) continue;
      if (feature.properties.input.side === "source") {
        selectedOverlapPairs += feature.properties.reconciliation.neighbors
          .filter(neighbor => retainedIds.has(`target:${neighbor.featureId}`)).length;
      }
      feature.properties.reconciliation.review = {componentId: group.id, decision: "retain",
        reason: decision.reason, reviewerId: reviewer, reviewedAt: timestamp};
      features.push(feature);
    }
  }
  features.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {type: "FeatureCollection", features, "opengeo:analysis": {
    ...structuredClone(collection["opengeo:analysis"]), operation: "building-reconcile-reviewed",
    buildingReview: {schemaVersion: evaluation ? "opengeo.building-inventory-review.1.1.0" : "opengeo.building-inventory-review.1.0.0", method: "explicit-footprint-selection",
      reviewerId: reviewer, reviewedAt: timestamp, inputFeatureCount: collection.features.length,
      retainedFeatureCount: features.length, excludedFeatureCount: collection.features.length - features.length,
      componentCount: groups.length, selectedOverlapPairs, validatedCount: null,
      decisions: groups.map(group => reviewed.get(group.id)), ...(evaluation ? {evaluation} : {})}
  }};
}

export const BUILDING_EVALUATION_LIMITS = Object.freeze({features: 1_000, edges: 20_000, work: 100_000, milliseconds: 1_000});
const EVALUATION_METHOD = Object.freeze({id: "iou-qualified-maximum-cardinality-bipartite-matching", version: "1.0.0",
  minimumIntersectionOverUnion: 0.5, tieBreak: "ascending reference IDs and prediction IDs; deterministic augmenting paths",
  matchingObjective: "maximum pair count; not maximum total intersection-over-union",
  intersectionMethod: "PostGIS local projected geography overlay", areaMethod: "PostGIS spheroidal geography"});
const EVALUATION_SCOPE = Object.freeze({interpretation: "inventory-agreement-only", referenceCompleteness: "unknown",
  referenceAccuracy: "unknown", groundTruth: "unestablished"});

/** Measure agreement with an explicitly chosen reference inventory. Matching
 * maximizes pair count; deterministic traversal does not optimize summed IoU.
 */
export function evaluateBuildingComparison({collection, referenceSide}) {
  if (!["source", "target"].includes(referenceSide)) throw Error("Choose source or target as the reference inventory.");
  const started = performance.now(); let work = 0, edges = 0;
  const guard = (amount = 1) => {
    work += amount;
    if (work > BUILDING_EVALUATION_LIMITS.work) throw Error("Building evaluation exceeds its work limit.");
    if (performance.now() - started >= BUILDING_EVALUATION_LIMITS.milliseconds) throw Error("Building evaluation exceeds its time limit.");
  };
  // Bound adjacency before the native graph validator traverses it. Both sides
  // contain each edge, and validation below requires their exact symmetry.
  let adjacencyCount = 0;
  if (Array.isArray(collection?.features)) for (const feature of collection.features) {
    guard();
    const neighbors = feature?.properties?.reconciliation?.neighbors;
    if (Array.isArray(neighbors)) adjacencyCount += neighbors.length;
    if (adjacencyCount > BUILDING_EVALUATION_LIMITS.edges * 2) throw Error("Building evaluation exceeds its edge limit.");
  }
  const groups = buildingReconciliationGroups(collection); guard();
  const predictionSide = referenceSide === "source" ? "target" : "source";
  const features = groups.flatMap(group => group.features);
  const references = features.filter(feature => feature.properties.input.side === referenceSide).sort(byFeatureId);
  const predictions = features.filter(feature => feature.properties.input.side === predictionSide).sort(byFeatureId);
  const adjacency = new Map();
  for (const feature of references) {
    const qualified = [];
    for (const neighbor of feature.properties.reconciliation.neighbors) {
      guard(); edges++;
      if (edges > BUILDING_EVALUATION_LIMITS.edges) throw Error("Building evaluation exceeds its edge limit.");
      if (neighbor.intersectionOverUnion >= EVALUATION_METHOD.minimumIntersectionOverUnion) {
        qualified.push({id: `${predictionSide}:${neighbor.featureId}`, iou: neighbor.intersectionOverUnion});
      }
    }
    qualified.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    adjacency.set(feature.id, qualified);
  }
  const matchedPredictions = new Map(), matchedReferences = new Map();
  const augment = (referenceId, visited) => {
    guard();
    for (const neighbor of adjacency.get(referenceId)) {
      guard();
      if (visited.has(neighbor.id)) continue;
      visited.add(neighbor.id);
      const previous = matchedPredictions.get(neighbor.id);
      if (previous === undefined || augment(previous, visited)) {
        matchedPredictions.set(neighbor.id, referenceId);
        matchedReferences.set(referenceId, neighbor);
        return true;
      }
    }
    return false;
  };
  for (const feature of references) augment(feature.id, new Set());
  guard();
  const pairs = references.filter(feature => matchedReferences.has(feature.id)).map(feature => ({
    referenceFeatureId: feature.id, predictionFeatureId: matchedReferences.get(feature.id).id,
    intersectionOverUnion: matchedReferences.get(feature.id).iou}));
  const native = collection["opengeo:analysis"];
  const counts = {reference: references.length, prediction: predictions.length, truePositives: pairs.length,
    falsePositives: predictions.length - pairs.length, falseNegatives: references.length - pairs.length};
  const report = {schemaVersion: "opengeo.building-inventory-evaluation.1.0.0", method: {...EVALUATION_METHOD},
    inputs: {source: {datasetId: native.sourceDatasetId, generation: native.source_generation, featureCount: native.source_count},
      target: {datasetId: native.targetDatasetId, generation: native.target_generation, featureCount: native.target_count}},
    referenceSide, predictionSide, counts, metrics: evaluationMetrics(counts, pairs), pairs,
    unmatchedReferenceFeatureIds: references.filter(feature => !matchedReferences.has(feature.id)).map(feature => feature.id),
    unmatchedPredictionFeatureIds: predictions.filter(feature => !matchedPredictions.has(feature.id)).map(feature => feature.id),
    scope: {...EVALUATION_SCOPE}, limits: {...BUILDING_EVALUATION_LIMITS}, validatedCount: null};
  validateBuildingEvaluation(report);
  guard();
  return report;
}

/** Validate the complete portable report without accepting accuracy or ground
 * truth claims. Maximum matching can only be recomputed from the native graph.
 */
export function validateBuildingEvaluation(report) {
  closed(report, ["schemaVersion", "method", "inputs", "referenceSide", "predictionSide", "counts", "metrics", "pairs",
    "unmatchedReferenceFeatureIds", "unmatchedPredictionFeatureIds", "scope", "limits", "validatedCount"], "Building evaluation");
  if (report.schemaVersion !== "opengeo.building-inventory-evaluation.1.0.0" || report.validatedCount !== null) {
    throw Error("Unsupported building evaluation schema or validation claim.");
  }
  for (const [key, expected] of [["method", EVALUATION_METHOD], ["scope", EVALUATION_SCOPE], ["limits", BUILDING_EVALUATION_LIMITS]]) {
    closed(report[key], Object.keys(expected), `Building evaluation ${key}`);
    if (Object.entries(expected).some(([name, value]) => report[key][name] !== value)) throw Error(`Invalid building evaluation ${key}.`);
  }
  if (!["source", "target"].includes(report.referenceSide)
    || report.predictionSide !== (report.referenceSide === "source" ? "target" : "source")) throw Error("Invalid building evaluation roles.");
  closed(report.inputs, ["source", "target"], "Building evaluation inputs");
  for (const side of ["source", "target"]) {
    const input = report.inputs[side];
    closed(input, ["datasetId", "generation", "featureCount"], "Building evaluation input");
    uuid(input.datasetId, "Building evaluation dataset ID");
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !boundedCount(input.featureCount)) throw Error("Invalid building evaluation input generation or count.");
  }
  if (report.inputs.source.datasetId.toLowerCase() === report.inputs.target.datasetId.toLowerCase()
    || report.inputs.source.featureCount + report.inputs.target.featureCount > BUILDING_EVALUATION_LIMITS.features) throw Error("Invalid building evaluation inventory identities or limits.");
  closed(report.counts, ["reference", "prediction", "truePositives", "falsePositives", "falseNegatives"], "Building evaluation counts");
  if (Object.values(report.counts).some(value => !boundedCount(value))
    || report.counts.reference !== report.inputs[report.referenceSide].featureCount
    || report.counts.prediction !== report.inputs[report.predictionSide].featureCount
    || !Array.isArray(report.pairs) || report.pairs.length > 500) throw Error("Invalid building evaluation counts or matched pairs.");
  const referenceIds = [], predictionIds = [];
  for (const pair of report.pairs) {
    closed(pair, ["referenceFeatureId", "predictionFeatureId", "intersectionOverUnion"], "Building evaluation matched pair");
    qualifiedFeatureId(pair.referenceFeatureId, report.referenceSide);
    qualifiedFeatureId(pair.predictionFeatureId, report.predictionSide);
    if (!Number.isFinite(pair.intersectionOverUnion) || pair.intersectionOverUnion < 0.5 || pair.intersectionOverUnion > 1) throw Error("Invalid building evaluation matched intersection-over-union.");
    referenceIds.push(pair.referenceFeatureId); predictionIds.push(pair.predictionFeatureId);
  }
  if (!sortedUnique(referenceIds) || new Set(predictionIds).size !== predictionIds.length) throw Error("Building evaluation matched identities repeat or are unordered.");
  for (const [key, side, matched, count] of [
    ["unmatchedReferenceFeatureIds", report.referenceSide, referenceIds, report.counts.reference],
    ["unmatchedPredictionFeatureIds", report.predictionSide, predictionIds, report.counts.prediction]
  ]) {
    const values = report[key];
    if (!Array.isArray(values) || values.length > 1_000 || !sortedUnique(values)) throw Error("Invalid building evaluation unmatched identities.");
    values.forEach(value => qualifiedFeatureId(value, side));
    if (matched.length + values.length !== count || new Set([...matched, ...values]).size !== count) throw Error("Building evaluation identities do not cover the inventory counts.");
  }
  if (report.counts.truePositives !== report.pairs.length
    || report.counts.falsePositives !== report.unmatchedPredictionFeatureIds.length
    || report.counts.falseNegatives !== report.unmatchedReferenceFeatureIds.length) throw Error("Building evaluation matching counts are inconsistent.");
  const expectedMetrics = evaluationMetrics(report.counts, report.pairs);
  closed(report.metrics, Object.keys(expectedMetrics), "Building evaluation metrics");
  if (Object.entries(expectedMetrics).some(([key, value]) => value === null ? report.metrics[key] !== null
    : !Number.isFinite(report.metrics[key]) || Math.abs(report.metrics[key] - value) > 1e-12)) throw Error("Building evaluation metrics are inconsistent.");
  return structuredClone(report);
}

function evaluationMetrics(counts, pairs) {
  const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
  const difference = counts.prediction - counts.reference;
  return {precision: ratio(counts.truePositives, counts.prediction), recall: ratio(counts.truePositives, counts.reference),
    f1: ratio(2 * counts.truePositives, counts.prediction + counts.reference), signedCountDifference: difference,
    absoluteCountDifference: Math.abs(difference), relativeCountDifference: ratio(difference, counts.reference),
    meanIntersectionOverUnion: pairs.length ? pairs.reduce((sum, pair) => sum + pair.intersectionOverUnion, 0) / pairs.length : null,
    meanOneMinusIntersectionOverUnion: pairs.length ? pairs.reduce((sum, pair) => sum + (1 - pair.intersectionOverUnion), 0) / pairs.length : null};
}

function closed(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} is invalid.`);
  exactKeys(value, keys, label);
}
function boundedCount(value) {return Number.isSafeInteger(value) && value >= 0 && value <= BUILDING_EVALUATION_LIMITS.features;}
function sortedUnique(values) {return values.every((value, index) => typeof value === "string" && (index === 0 || values[index - 1] < value));}
function qualifiedFeatureId(value, side) {
  if (typeof value !== "string" || !value.startsWith(`${side}:`) || uuid(value.slice(side.length + 1), "Building evaluation feature ID") !== value.slice(side.length + 1)) {
    throw Error("Invalid building evaluation qualified feature identity.");
  }
}
function byFeatureId(left, right) {return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;}

function reviewTimestamp(value) {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}
