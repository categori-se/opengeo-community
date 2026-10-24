import {mappedFieldSourceEvidence} from "./fieldInventory.js";

export const FIELD_CONFIDENCE_LIMITS = Object.freeze({features: 1000, idCharacters: 1024,
  outputBytes: 2_097_152, milliseconds: 5000});
const reports = new WeakSet(), encoder = new TextEncoder();
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = suffix => Object.assign(Error(`field_confidence_${suffix}`), {code: `field_confidence_${suffix}`});
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function deadline() {
  const started = performance.now();
  return {started, check() {
    if (performance.now() - started >= FIELD_CONFIDENCE_LIMITS.milliseconds) throw fail("time_limit");
  }};
}
function bounded(text) {
  if (encoder.encode(text).byteLength > FIELD_CONFIDENCE_LIMITS.outputBytes) throw fail("output_limit");
  return text;
}

/** Review already-published FTW scores without changing, selecting or fetching fields. */
export function reviewFieldConfidence({record, threshold = null} = {}) {
  const clock = deadline(); clock.check();
  if (threshold !== null && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)) throw fail("threshold_invalid");
  if (!plain(record) || !plain(record.geojson) || record.geojson.type !== "FeatureCollection"
    || !Array.isArray(record.geojson.features)) throw fail("collection_invalid");
  const features = record.geojson.features;
  if (features.length > FIELD_CONFIDENCE_LIMITS.features) throw fail("feature_limit");
  let sourceEvidence;
  try {sourceEvidence = mappedFieldSourceEvidence({"opengeo:analysis": {operation: "ftw-fields", receipt: record.receipt}});}
  catch {throw fail("source_invalid");}
  if (!sourceEvidence || sourceEvidence.status !== "complete") throw fail("source_invalid");
  clock.check();
  const rows = [], ids = new Set(), summary = {fieldCount: features.length, scoredCount: 0, missingCount: 0,
    minScore: null, maxScore: null, belowThresholdCount: threshold === null ? null : 0,
    atOrAboveThresholdCount: threshold === null ? null : 0};
  for (const [rowIndex, feature] of features.entries()) {
    clock.check();
    if (!plain(feature) || feature.type !== "Feature" || !plain(feature.properties)) throw fail("feature_invalid");
    const fieldId = feature.id;
    if (typeof fieldId !== "string" || !fieldId.trim() || fieldId.length > FIELD_CONFIDENCE_LIMITS.idCharacters) throw fail("field_id_invalid");
    if (ids.has(fieldId)) throw fail("duplicate_field_id");
    ids.add(fieldId);
    if (Object.hasOwn(feature.properties, "id") && feature.properties.id !== fieldId) throw fail("field_id_invalid");
    const confidence = feature.properties.confidence;
    if (!Object.hasOwn(feature.properties, "confidence") || confidence !== null
      && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)) throw fail("score_invalid");
    let status;
    if (confidence === null) {summary.missingCount++; status = "missing";}
    else {
      summary.scoredCount++;
      summary.minScore = summary.minScore === null ? confidence : Math.min(summary.minScore, confidence);
      summary.maxScore = summary.maxScore === null ? confidence : Math.max(summary.maxScore, confidence);
      status = threshold === null ? "scored" : confidence < threshold ? "below-threshold" : "at-or-above-threshold";
      if (threshold !== null) summary[confidence < threshold ? "belowThresholdCount" : "atOrAboveThresholdCount"]++;
    }
    rows.push({rowIndex, fieldId, sourceConfidence: confidence, status});
  }
  const report = {schemaVersion: "opengeo.ftw-confidence-review.1.0.0", status: "complete", sourceEvidence,
    method: {id: "ftw-field-confidence-threshold-review", version: "1.0.0", threshold,
      thresholdAuthority: threshold === null ? "not-requested" : "user-supplied", comparison: "strictly-below",
      equality: "at-or-above-threshold", missing: "reported-separately; never zero or below threshold",
      sourceConfidence: {field: "properties.confidence", minimum: 0, maximum: 100, missing: null,
        transformation: "none; retain the already-published 0–100 score", sourceResolutionMeters: 500,
        sourceLocation: "field point-on-surface", interpretation: "Source-provided regional model reliability; not a calibrated polygon probability or boundary accuracy measurement."},
      aggregation: "record counts and observed score extrema only", filtering: "none", acceptanceDecisions: "none",
      independence: "not established; fields may share a source confidence grid cell"},
    summary, rows,
    quality: {status: "unverified", calibratedProbability: null, boundaryAccuracy: null, independentValidation: null},
    limitations: [
      "The published confidence is regional model reliability from a 500 m source raster, sampled at the field's point-on-surface. It is not an independently observed field score, calibrated probability or boundary accuracy.",
      "The threshold is an explicit user review criterion, not a source quality standard or an automated acceptance decision. Equality is not below threshold.",
      "Missing confidence remains null and separate from scored records. Unknown source quality, dates and coverage remain as recorded in the source evidence.",
      "All returned field records are retained in source order. No fields are filtered, deduplicated, accepted, rejected or edited, and no mean confidence is calculated.",
      "A complete query receipt does not establish complete geographic coverage or independently verified provenance. Source snapshot and distribution terms retain their original authority."
    ],
    usage: {processedFields: rows.length, milliseconds: Math.max(0, performance.now() - clock.started), additionalProviderRequests: 0}};
  bounded(JSON.stringify(report)); clock.check(); freeze(report); clock.check(); reports.add(report); return report;
}

/** Export only an immutable report created by this module, never caller-supplied siblings. */
export function fieldConfidenceCsv(report) {
  const clock = deadline(); clock.check();
  if (!plain(report) || !reports.has(report)) throw fail("report_invalid");
  const {rows, ...context} = report;
  const records = [["record_type", "row_index", "field_id", "source_confidence", "status", "context_json"],
    ["context", "", "", "", "", JSON.stringify(context)]];
  for (const row of rows) {
    clock.check(); records.push(["field", row.rowIndex, row.fieldId, row.sourceConfidence ?? "", row.status, ""]);
  }
  const cell = value => {
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv = bounded(records.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n");
  clock.check(); return csv;
}
