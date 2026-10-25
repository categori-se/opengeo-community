import {canonicalJson} from "./artifactCanonicalJson.js";
import {exactKeys, uuid} from "./apiResponseContracts.js";

export const SOCIAL_BASELINE_TOPICS = Object.freeze([
  Object.freeze({id: "demographic-vulnerability", label: "Demographic and vulnerability evidence"}),
  Object.freeze({id: "settlement", label: "Settlement evidence"}),
  Object.freeze({id: "community-infrastructure", label: "Community infrastructure evidence"}),
  Object.freeze({id: "land-use", label: "Land-use evidence"})
]);
const SCHEMA = "opengeo.social-baseline-evidence.1.0.0";
const MAX_BYTES = 2_097_152;
const KEYS = ["schemaVersion", "topic", "sourceDescription", "spatialUnit", "periodStart", "periodEnd", "coverage",
  "coverageBasis", "suitability", "suitabilityBasis", "limitations", "reviewer", "reviewedAt", "fields"];
const ROW_KEYS = ["id", "scope", "sourceFeatureId", "geometryType", "positionCount", "areaSquareMeters", "lengthMeters", "pointCount"];
const ATTRIBUTE_CONTEXT = "Unchanged source attributes; clipped source-zone totals and rates are not summed, weighted or prorated. The same source feature may occur in both scopes; rows are not additive across scopes.";

/** Curator assertions about one receptor inventory, never inferred population,
 * completeness, tenure, impact or professional validation of the source.
 */
export function validateSocialBaselineEvidence(value) {
  closed(value, KEYS, "Social baseline evidence review");
  if (value.schemaVersion !== SCHEMA || !SOCIAL_BASELINE_TOPICS.some(topic => topic.id === value.topic)) fail("Invalid social baseline evidence schema or topic.");
  text(value.sourceDescription, 500, "Source description"); text(value.spatialUnit, 160, "Source spatial unit");
  text(value.limitations, 500, "Evidence limitations"); text(value.reviewer, 160, "Evidence reviewer");
  if (value.periodStart !== null || value.periodEnd !== null) {
    if (!date(value.periodStart) || !date(value.periodEnd) || value.periodStart > value.periodEnd) fail("Evidence period requires both valid ordered dates or two unknown dates.");
  }
  if (!["unknown", "partial", "declared-complete"].includes(value.coverage)
    || !["unreviewed", "suitable", "limited", "unsuitable"].includes(value.suitability)) fail("Invalid evidence coverage or suitability assertion.");
  text(value.coverageBasis, 500, "Coverage basis", value.coverage === "unknown");
  text(value.suitabilityBasis, 500, "Suitability basis", value.suitability === "unreviewed");
  if (typeof value.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.reviewedAt)
    || !date(value.reviewedAt.slice(0, 10)) || !Number.isFinite(Date.parse(value.reviewedAt))) fail("Evidence review time must be a valid ISO timestamp.");
  if (!Array.isArray(value.fields) || value.fields.length > 6) fail("Select at most six source evidence fields.");
  const names = new Set();
  for (const field of value.fields) {
    closed(field, ["name", "meaning", "unit", "denominator"], "Social evidence field");
    text(field.name, 160, "Source field name"); text(field.meaning, 500, "Source field meaning");
    if (field.unit !== null) text(field.unit, 80, "Source field unit");
    if (field.denominator !== null) text(field.denominator, 160, "Source field denominator");
    if (names.has(field.name)) fail("Social evidence field names must be unique.");
    names.add(field.name);
  }
  return structuredClone(value);
}

/** Export raw source attributes alongside the already validated screening report.
 * One row per scope/source feature/selected field; no sums or allocation of source
 * values to clipped geometries. The caller validates the full screening report.
 */
export function socialBaselineEvidenceCsv(collection, validatedReport) {
  const review = validateSocialBaselineEvidence(validatedReport?.evidenceReview);
  const bound = boundFeatures(collection, validatedReport);
  const fields = review.fields.length ? review.fields : [null];
  for (const field of review.fields) if (![...bound.values()].some(feature => Object.hasOwn(feature.properties.source, field.name))) {
    fail(`Selected source field is absent from every screening feature: ${field.name}`);
  }
  let bytes = 0;
  const lines = [], append = values => {
    const line = values.map(csvCell).join(",") + "\r\n";
    bytes += new TextEncoder().encode(line).byteLength;
    if (bytes > MAX_BYTES) fail("Social evidence CSV exceeds its byte limit.");
    lines.push(line);
  };
  append(["scope", "source_feature_id", "geometry_type", "position_count", "area_square_meters", "length_meters", "point_count",
    "field_name", "value_status", "value_type", "source_value", "field_meaning", "field_unit", "field_denominator",
    "evidence_topic", "source_description", "spatial_unit", "period_start", "period_end", "coverage", "coverage_basis", "suitability",
    "suitability_basis", "limitations", "reviewer", "reviewed_at", "question", "influence_basis", "source_dataset_id", "source_generation", "source_attribute_interpretation"]);
  for (const row of validatedReport.rows) for (const field of fields) {
    const source = bound.get(row.id).properties.source;
    const present = field !== null && Object.hasOwn(source, field.name), value = present ? source[field.name] : undefined;
    const status = field === null ? "not-selected" : !present ? "missing" : value === null ? "null" : "present";
    const type = !present || value === null ? "" : Array.isArray(value) ? "array" : typeof value;
    const raw = !present || value === null ? "" : typeof value === "object" ? canonicalJson(value) : value;
    append([row.scope, row.sourceFeatureId, row.geometryType, row.positionCount, row.areaSquareMeters, row.lengthMeters, row.pointCount,
      field?.name ?? "", status, type, raw, field?.meaning ?? "", field?.unit ?? "", field?.denominator ?? "",
      review.topic, review.sourceDescription, review.spatialUnit, review.periodStart ?? "", review.periodEnd ?? "", review.coverage,
      review.coverageBasis, review.suitability, review.suitabilityBasis, review.limitations, review.reviewer, review.reviewedAt,
      validatedReport.question, validatedReport.influenceBasis, validatedReport.inputs.receptors.datasetId,
      validatedReport.inputs.receptors.generation, ATTRIBUTE_CONTEXT]);
  }
  return lines.join("");
}

function boundFeatures(collection, report) {
  if (!plain(report) || report.schemaVersion !== "opengeo.receptor-screening.1.0.0" || !Array.isArray(report.rows)
    || report.rows.length > 1_000 || collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)
    || collection.features.length !== report.rows.length) fail("A matching bounded screening collection and validated report are required.");
  // Portable originals keep the receipt under properties; live previews keep it
  // at the collection root. Neither representation may substitute another report.
  const embedded = collection["opengeo:analysis"]?.screening ?? collection.properties?.["opengeo:analysis"]?.screening;
  if (canonicalJson(embedded) !== canonicalJson(report)) fail("The social evidence report does not match its screening collection.");
  const rows = new Map(), features = new Map(), sources = new Map();
  for (const row of report.rows) {
    closed(row, ROW_KEYS, "Screening evidence row");
    if (!["footprint", "influence"].includes(row.scope) || uuid(row.sourceFeatureId, "Evidence source feature ID") !== row.sourceFeatureId
      || row.id !== `${row.scope}:${row.sourceFeatureId}` || rows.has(row.id)) fail("Invalid screening evidence row identity.");
    rows.set(row.id, row);
  }
  for (const feature of collection.features) {
    const row = rows.get(feature?.id);
    if (!plain(feature) || feature.type !== "Feature" || !row || features.has(feature.id)
      || !plain(feature.geometry) || feature.geometry.type !== row.geometryType || !plain(feature.properties)
      || !plain(feature.properties.source) || !plain(feature.properties.screening)) fail("A social evidence feature does not match its screening row.");
    const {id, ...expected} = row;
    if (canonicalJson(feature.properties.screening) !== canonicalJson(expected)) fail("Social evidence feature measures do not match their screening row.");
    const source = canonicalJson(feature.properties.source);
    if (sources.has(row.sourceFeatureId) && sources.get(row.sourceFeatureId) !== source) fail("The same source feature has inconsistent evidence attributes across scopes.");
    sources.set(row.sourceFeatureId, source); features.set(id, feature);
  }
  if (new TextEncoder().encode(JSON.stringify(collection)).byteLength > MAX_BYTES) fail("Social evidence collection exceeds its byte limit.");
  return features;
}
function csvCell(value) {
  let rendered = String(value);
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(rendered)) rendered = `'${rendered}`;
  return `"${rendered.replaceAll('"', '""')}"`;
}
function date(value) {return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;}
function text(value, maximum, label, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || !allowEmpty && !value.trim()) fail(`${label} requires ${allowEmpty ? "at most" : "nonempty text of at most"} ${maximum} characters.`);
}
function plain(value) {return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));}
function closed(value, keys, label) {if (!plain(value)) fail(`${label} must be an object.`); exactKeys(value, keys, label);}
function fail(message) {throw Error(message);}
