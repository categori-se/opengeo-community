import {canonicalJson} from "./artifactCanonicalJson.js";
import {exactKeys, uuid} from "./apiResponseContracts.js";
import {validateReceptorScreeningReport, validateReceptorScreeningReportHeader, validateReceptorScreeningSummary} from "./receptorScreening.js";
import {assertReceptorScreeningFeatures} from "./receptorScreeningArchive.js";
import {SOCIAL_BASELINE_TOPICS, validateSocialBaselineEvidence} from "./socialBaselineEvidence.js";

const SELECTION_SCHEMA = "opengeo.project-social-baseline-selection.1.0.0";
const REPORT_SCHEMA = "opengeo.project-social-baseline.1.0.0";
const PROV_GENERATED = "http://www.w3.org/ns/prov#wasGeneratedBy";
const MAX_BYTES = 196_608;
const REVIEW_KEYS = ["layerId", "title", "representation", "metadataRevision", "readAt", "report", "auditVerification"];

/** Project configuration stores references only, never data permissions or reports. */
export function validateProjectSocialBaselineSelection(value) {
  closed(value, ["schemaVersion", "question", "layerIds"], "Project social baseline selection");
  if (value.schemaVersion !== SELECTION_SCHEMA) fail("Unsupported Project social baseline selection.");
  const question = text(value.question, 500, "Project screening question").trim();
  if (!Array.isArray(value.layerIds) || value.layerIds.length > 4) fail("Select at most four Project Layers.");
  value.layerIds.forEach(layerId);
  if (new Set(value.layerIds).size !== value.layerIds.length) fail("Select each Project Layer once.");
  return {schemaVersion: SELECTION_SCHEMA, question, layerIds: [...value.layerIds]};
}

/** Read already resident data, or an explicitly loaded authorized metadata record.
 * This function performs no I/O and never treats a recorded checksum as verified.
 */
export function readProjectSocialReview({layer, collection, knowledge, observedAt}) {
  if (!plain(layer)) fail("A selected Project Layer is required.");
  layerId(layer.layerId);
  const title = text(layer.title, 500, "Project Layer title"), readAt = timestamp(observedAt);
  let report, representation, metadataRevision = null, auditVerification;
  if (collection !== undefined && collection !== null) {
    if (knowledge !== undefined && knowledge !== null) fail("Choose resident data or recorded metadata for this review.");
    if (!plain(collection) || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) fail("A resident screening FeatureCollection is required.");
    const root = collection["opengeo:analysis"], original = collection.properties?.["opengeo:analysis"];
    if (root && original && canonicalJson(root) !== canonicalJson(original)) fail("Resident screening receipts disagree.");
    const receipt = root ?? original;
    const full = validateReceptorScreeningReport(receipt?.screening);
    assertReceiptInputs(receipt, full);
    assertReceptorScreeningFeatures(collection.features, full);
    assertSourceAttributes(collection.features, full);
    const {rows, ...header} = full;
    report = validateReceptorScreeningReportHeader(header);
    representation = "resident-full-report"; auditVerification = "resident-report-validated";
  } else {
    if (layer.sourceType !== "governed-dataset" || !plain(knowledge)
      || uuid(layer.datasetId, "Selected Layer dataset") !== layer.datasetId
      || uuid(layer.datasetVersionId, "Selected Layer version") !== layer.datasetVersionId
      || knowledge.datasetId !== layer.datasetId || !positiveInteger(knowledge.version)) fail("Load the exact selected catalog Layer's metadata record.");
    const normalized = knowledge.document?.metadata?.normalized;
    if (knowledge.document?.schemaVersion !== "1.0.0" || !Array.isArray(normalized)) fail("A supported catalog metadata document is required.");
    const matches = normalized.filter(claim => claim?.subject === "resource" && claim.property === PROV_GENERATED
      && claim.value?.operation === "receptor-screen");
    if (matches.length !== 1) fail("Catalog metadata must contain exactly one receptor screening receipt.");
    const receipt = matches[0].value;
    report = validateReceptorScreeningSummary(receipt.screening);
    assertReceiptInputs(receipt, report);
    if (report.audit.distributionId !== `urn:opengeo:dataset:${layer.datasetId}:version:${layer.datasetVersionId}:original`) fail("The screening audit belongs to another catalog Layer or version.");
    representation = "catalog-metadata-summary"; metadataRevision = knowledge.version; auditVerification = "not-downloaded";
  }
  if (!Object.hasOwn(report, "evidenceReview")) {
    const error = Error("This source has no social evidence review. Attach one to its receptor screening first.");
    error.code = "social_baseline_unreviewed"; throw error;
  }
  validateSocialBaselineEvidence(report.evidenceReview);
  const result = {layerId: layer.layerId, title, representation, metadataRevision, readAt, report, auditVerification};
  bounded(result); return structuredClone(result);
}

/** Keep per-source units, questions and influence areas separate. No grand total. */
export function composeProjectSocialBaseline({question, reviews, unresolvedSelections = []}) {
  question = text(question, 500, "Project screening question").trim();
  if (!Array.isArray(reviews) || !Array.isArray(unresolvedSelections)
    || reviews.length + unresolvedSelections.length > 4) fail("A Project social baseline supports at most four selected sources.");
  const selected = reviews.map(validateReview), layerIds = new Set(), topics = new Map();
  let footprint = null;
  for (const review of selected) {
    if (layerIds.has(review.layerId)) fail("A Project Layer cannot be supplied more than once.");
    layerIds.add(review.layerId);
    const topic = review.report.evidenceReview.topic;
    if (topics.has(topic)) fail("Choose at most one reviewed source per social baseline topic.");
    topics.set(topic, review);
    if (footprint && canonicalJson(footprint) !== canonicalJson(review.report.inputs.footprint)) fail("Selected reviews must use the same footprint dataset, generation and feature count.");
    footprint ??= structuredClone(review.report.inputs.footprint);
  }
  const unresolved = unresolvedSelections.map(value => {
    closed(value, ["layerId", "title", "status", "reason"], "Unresolved social baseline source");
    layerId(value.layerId); text(value.title, 500, "Project Layer title"); text(value.reason, 500, "Unresolved source reason");
    if (!["unloaded", "unavailable", "unreviewed", "invalid"].includes(value.status)) fail("Invalid unresolved social baseline source status.");
    if (layerIds.has(value.layerId)) fail("A Project Layer cannot be supplied more than once.");
    layerIds.add(value.layerId); return structuredClone(value);
  });
  const result = {schemaVersion: REPORT_SCHEMA, question, footprint,
    topics: SOCIAL_BASELINE_TOPICS.map(topic => ({...topic, status: topics.has(topic.id) ? "reviewed-source" : "not-supplied", review: topics.get(topic.id) ?? null})),
    unresolvedSelections: unresolved,
    scope: {sourceReview: "curator-assertions-not-independent-source-validation", originalAudit: "not-independently-verified",
      missingTopics: "not-supplied-is-not-zero-or-evidence-of-absence", aggregation: "no-cross-source-or-cross-scope-totals",
      sourceAttributes: "not-summed-weighted-or-prorated", coverageCompleteness: "not-inferred", impactAssessment: "not-assessed",
      households: "not-inferred", livelihoods: "not-inferred", rights: "unknown", compensation: "not-inferred"}};
  bounded(result); return structuredClone(result);
}

function validateReview(value) {
  closed(value, REVIEW_KEYS, "Project social baseline source review");
  layerId(value.layerId); text(value.title, 500, "Project Layer title"); timestamp(value.readAt);
  let report;
  if (value.representation === "resident-full-report") {
    if (value.metadataRevision !== null || value.auditVerification !== "resident-report-validated") fail("Resident source review provenance is inconsistent.");
    report = validateReceptorScreeningReportHeader(value.report);
  } else if (value.representation === "catalog-metadata-summary") {
    if (!positiveInteger(value.metadataRevision) || value.auditVerification !== "not-downloaded") fail("Catalog source review provenance is inconsistent.");
    report = validateReceptorScreeningSummary(value.report);
  } else fail("Unknown social baseline source representation.");
  validateSocialBaselineEvidence(report.evidenceReview);
  bounded(value); return structuredClone({...value, report});
}
function assertReceiptInputs(receipt, report) {
  if (!plain(receipt) || receipt.operation !== "receptor-screen" || receipt.version !== "1.0.0"
    || receipt.persisted !== false || receipt.crs !== "CRS:84") fail("A bounded receptor screening receipt is required.");
  for (const [role, datasetId, generation, count] of [
    ["receptors", receipt.sourceDatasetId, receipt.source_generation, receipt.source_count],
    ["footprint", receipt.targetDatasetId, receipt.target_generation, receipt.target_count]]) {
    const pin = report.inputs[role];
    if (datasetId !== pin.datasetId || generation !== pin.generation || count !== pin.featureCount) fail("The screening receipt's source or footprint input pins disagree.");
  }
}
function assertSourceAttributes(features, report) {
  const sources = new Map();
  for (const feature of features) {
    if (!plain(feature.properties.source)) fail("Screened source attributes must remain available with the resident report.");
    const id = feature.properties.screening.sourceFeatureId, properties = canonicalJson(feature.properties.source);
    if (sources.has(id) && sources.get(id) !== properties) fail("One source feature has inconsistent attributes across screening scopes.");
    sources.set(id, properties);
  }
  for (const field of report.evidenceReview?.fields ?? []) {
    if (!features.some(feature => Object.hasOwn(feature.properties.source, field.name))) fail(`Reviewed source field is absent: ${field.name}`);
  }
}
function layerId(value) {if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) fail("A bounded Project Layer identity is required.");}
function text(value, maximum, label) {if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) fail(`${label} requires nonempty text of at most ${maximum} characters.`); return value;}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) fail("Review read time must be a valid timestamp with timezone.");
  return value;
}
function positiveInteger(value) {return Number.isSafeInteger(value) && value >= 1;}
function plain(value) {return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));}
function closed(value, keys, label) {if (!plain(value)) fail(`${label} must be an object.`); exactKeys(value, keys, label);}
function bounded(value) {if (new TextEncoder().encode(canonicalJson(value)).byteLength > MAX_BYTES) fail("Project social baseline exceeds its 196,608-byte limit.");}
function fail(message) {throw Error(message);}
