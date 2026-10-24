import {canonicalJson} from "./artifactCanonicalJson.js";
import {exactKeys, uuid} from "./apiResponseContracts.js";
import {sha256Hex} from "./managedUpload.js";
import {validateBuildingEvaluation} from "./buildingReconciliation.js";

const FULL_SCHEMA = "opengeo.building-inventory-review.1.0.0";
const SUMMARY_SCHEMA = "opengeo.building-inventory-review-summary.1.0.0";
const EVALUATED_SCHEMA = "opengeo.building-inventory-review.1.1.0";
const EVALUATED_SUMMARY_SCHEMA = "opengeo.building-inventory-review-summary.1.1.0";
const POINTER = "/properties/opengeo:analysis/buildingReview";
const CHECKSUM_METHOD = "opengeo-canonical-json-sha256";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2_200_000;
const MAX_FEATURES = 1_000;
const REVIEW_FIELDS = ["schemaVersion", "method", "reviewerId", "reviewedAt", "inputFeatureCount",
  "retainedFeatureCount", "excludedFeatureCount", "componentCount", "selectedOverlapPairs", "validatedCount"];
const plain = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** The full decisions stay in the immutable original, separate from bounded knowledge. */
export function archivedBuildingReviewReceipt(receipt, {distributionId, sha256} = {}) {
  if (!plain(receipt) || receipt.operation !== "building-reconcile-reviewed" || receipt.version !== "1.0.0"
    || receipt.persisted !== false || receipt.crs !== "CRS:84" || receipt.allowed !== true
    || receipt.building_polygon_inputs !== true) fail("A reviewed native building receipt is required.");
  const source = uuid(receipt.sourceDatasetId, "Building source dataset ID");
  const target = uuid(receipt.targetDatasetId, "Building comparison dataset ID");
  if (source === target || ![receipt.source_generation, receipt.target_generation]
    .every(value => Number.isSafeInteger(value) && value >= 1)) fail("Building input generations are invalid.");
  const nativeCounts = {source: count(receipt.source_count), target: count(receipt.target_count)};
  const review = receipt.buildingReview;
  if (!plain(review)) fail("The building review is missing.");
  const evaluated = Object.hasOwn(review, "evaluation");
  exactKeys(review, [...REVIEW_FIELDS, "decisions", ...(evaluated ? ["evaluation"] : [])], "Building review");
  if (review.schemaVersion !== (evaluated ? EVALUATED_SCHEMA : FULL_SCHEMA) || review.method !== "explicit-footprint-selection"
    || review.validatedCount !== null || !reviewTimestamp(review.reviewedAt)) fail("The building review method or timestamp is invalid.");
  uuid(review.reviewerId, "Building reviewer ID");
  for (const field of ["inputFeatureCount", "retainedFeatureCount", "excludedFeatureCount", "componentCount"]) count(review[field]);
  if (review.inputFeatureCount !== nativeCounts.source + nativeCounts.target
    || review.retainedFeatureCount + review.excludedFeatureCount !== review.inputFeatureCount
    || !Array.isArray(review.decisions) || review.decisions.length !== review.componentCount
    || review.componentCount > review.inputFeatureCount) fail("The building review counts are inconsistent.");

  const seen = new Set(), counts = {source: 0, target: 0}, selected = {source: 0, target: 0};
  let retained = 0, excluded = 0;
  for (const decision of review.decisions) {
    if (!plain(decision)) fail("A building review decision is invalid.");
    exactKeys(decision, ["componentId", "selectedFeatureIds", "excludedFeatureIds", "reason"], "Building review decision");
    if (typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 500
      || !Array.isArray(decision.selectedFeatureIds) || !Array.isArray(decision.excludedFeatureIds)
      || decision.selectedFeatureIds.length + decision.excludedFeatureIds.length < 1
      || decision.selectedFeatureIds.length + decision.excludedFeatureIds.length > MAX_FEATURES) fail("A building review decision or reason is invalid.");
    const members = [...decision.selectedFeatureIds, ...decision.excludedFeatureIds];
    for (const id of members) {
      const side = featureSide(id);
      if (seen.has(id)) fail("Building review feature identities must occur once.");
      seen.add(id); counts[side]++;
    }
    if (decision.componentId !== [...members].sort()[0]) fail("A building review component identity is inconsistent.");
    for (const id of decision.selectedFeatureIds) selected[featureSide(id)]++;
    retained += decision.selectedFeatureIds.length; excluded += decision.excludedFeatureIds.length;
  }
  if (retained !== review.retainedFeatureCount || excluded !== review.excludedFeatureCount
    || counts.source !== nativeCounts.source || counts.target !== nativeCounts.target
    || !Number.isSafeInteger(review.selectedOverlapPairs) || review.selectedOverlapPairs < 0
    || review.selectedOverlapPairs > selected.source * selected.target) fail("The building review selection counts are inconsistent.");

  if (evaluated) {
    const evaluation = validateBuildingEvaluation(review.evaluation);
    for (const [side, datasetId, generation] of [["source", source, receipt.source_generation],
      ["target", target, receipt.target_generation]]) {
      const input = evaluation.inputs[side];
      if (input.datasetId !== datasetId || input.generation !== generation || input.featureCount !== nativeCounts[side]) {
        fail("The building evaluation does not identify the reviewed input generations.");
      }
    }
    const identities = [...evaluation.unmatchedReferenceFeatureIds, ...evaluation.unmatchedPredictionFeatureIds,
      ...evaluation.pairs.flatMap(pair => [pair.referenceFeatureId, pair.predictionFeatureId])];
    if (identities.length !== seen.size || identities.some(id => !seen.has(id))) {
      fail("The building evaluation does not cover the reviewed input identities.");
    }
  }

  const distribution = typeof distributionId === "string"
    && /^urn:opengeo:dataset:([^:]+):version:([^:]+):original$/.exec(distributionId);
  if (!distribution || typeof sha256 !== "string" || !SHA256.test(sha256)) fail("The building review archive reference is invalid.");
  uuid(distribution[1], "Building output dataset ID"); uuid(distribution[2], "Building output version ID");
  const summary = Object.fromEntries(REVIEW_FIELDS.map(field => [field, review[field]]));
  summary.schemaVersion = evaluated ? EVALUATED_SUMMARY_SCHEMA : SUMMARY_SCHEMA;
  if (evaluated) {
    const {pairs, unmatchedReferenceFeatureIds, unmatchedPredictionFeatureIds, ...evaluation} = review.evaluation;
    summary.evaluation = {...structuredClone(evaluation),
      schemaVersion: "opengeo.building-inventory-evaluation-summary.1.0.0", fullReportJsonPointer: `${POINTER}/evaluation`};
  }
  summary.audit = {distributionId, jsonPointer: POINTER, sha256, checksumMethod: CHECKSUM_METHOD};
  return {...structuredClone(receipt), buildingReview: summary};
}

/** Deliberate original-file audit readback; ordinary rendered GeoJSON omits these properties. */
export async function verifyBuildingReviewArchive(bytes, {objectSha256, reference} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES
    || typeof objectSha256 !== "string" || !SHA256.test(objectSha256)) fail("The building review archive bytes or checksum are invalid.");
  const original = new Blob([bytes]);
  if (await sha256Hex(original) !== objectSha256) fail("The building review archive object checksum does not match.");
  let collection;
  try {collection = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(await original.arrayBuffer()));}
  catch {fail("The building review archive is not valid UTF-8 JSON.");}
  if (!plain(collection) || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)
    || collection.features.length > MAX_FEATURES || !plain(collection.properties)) fail("A bounded building review archive collection is required.");
  const receipt = collection.properties["opengeo:analysis"];
  if (!plain(reference) || !plain(reference.audit)) fail("The building review archive reference is missing.");
  const summary = archivedBuildingReviewReceipt(receipt, reference.audit).buildingReview;
  if (canonicalJson(summary) !== canonicalJson(reference)) fail("The building review archive summary or pointer does not match.");
  if (await sha256Hex(new Blob([canonicalJson(receipt.buildingReview)])) !== reference.audit.sha256) fail("The building review archive audit checksum does not match.");
  if (collection.features.length !== receipt.buildingReview.retainedFeatureCount) fail("The building review archive retained feature count does not match.");

  const expected = new Map();
  for (const decision of receipt.buildingReview.decisions) {
    for (const id of decision.selectedFeatureIds) expected.set(id, {componentId: decision.componentId, decision: "retain",
      reason: decision.reason, reviewerId: receipt.buildingReview.reviewerId, reviewedAt: receipt.buildingReview.reviewedAt});
  }
  const actual = new Set();
  for (const feature of collection.features) {
    if (!plain(feature) || feature.type !== "Feature" || !expected.has(feature.id) || actual.has(feature.id)
      || !plain(feature.properties?.input) || feature.id !== `${feature.properties.input.side}:${uuid(feature.properties.input.featureId, "Retained building input ID")}`
      || !plain(feature.properties?.reconciliation?.review)
      || canonicalJson(feature.properties.reconciliation.review) !== canonicalJson(expected.get(feature.id))) fail("The building review archive selected feature or decision does not match.");
    actual.add(feature.id);
  }
  return structuredClone({receipt, collection});
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FEATURES) fail("A building review count is invalid.");
  return value;
}

function featureSide(value) {
  const match = typeof value === "string" && /^(source|target):(.+)$/.exec(value);
  if (!match || uuid(match[2], "Reviewed building feature ID") !== match[2]) fail("A building review feature identity is invalid.");
  return match[1];
}

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

function fail(message) {throw Error(message);}
