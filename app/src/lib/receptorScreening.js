import GeoJSON from "ol/format/GeoJSON.js";
import {DEFAULT_RADIUS, getArea, getLength} from "ol/sphere.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {spatialPreviewGeojson} from "./apiPreviewContracts.js";
import {exactKeys, uuid} from "./apiResponseContracts.js";

export const RECEPTOR_SCREENING_LIMITS = Object.freeze({features: 1_000, positions: 50_000,
  outputBytes: 2_097_152, milliseconds: 5_000, longitudeSpanDegrees: 6, maximumAbsoluteLatitude: 80});
const NATIVE_LIMITS = Object.freeze({features: 1_000, coordinates: 50_000, bytes: 2_097_152,
  statementSeconds: 5, bufferLongitudeSpanDegrees: 6});
const METHOD = Object.freeze({id: "native-clip-and-spherical-receptor-measurement", version: "1.0.0",
  clip: "PostGIS native planar CRS84 clip against unioned polygon mask",
  measurement: "OpenLayers 10.10.0 sphere getArea/getLength", radiusMeters: DEFAULT_RADIUS,
  areaUnit: "square-meter", lengthUnit: "meter", pointUnit: "coordinate-point",
  aggregation: "sum-clipped-receptor-features-including-overlaps-and-duplicates",
  zoneOverlap: "scope totals remain separate; a receptor may occur in both scopes",
  topology: "not-repaired; native clipping is retained exactly"});
const SCOPE = Object.freeze({coverageCompleteness: "unknown", sourceQuality: "unknown", observationPeriods: "unknown",
  footprintInfluenceRelationship: "user-declared-not-validated", impactAssessment: "not-assessed",
  households: "not-inferred", livelihoods: "not-inferred", rights: "not-inferred", compensation: "not-inferred"});
const GEOMETRIES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];
const ROW_KEYS = ["id", "scope", "sourceFeatureId", "geometryType", "positionCount", "areaSquareMeters", "lengthMeters", "pointCount"];
const SUMMARY_KEYS = ["clipReceiptIndex", "featureCount", "polygonFeatureCount", "lineFeatureCount", "pointFeatureCount",
  "positionCount", "areaSquareMeters", "lengthMeters", "pointCount"];
const RECEIPT_KEYS = ["operation", "version", "sourceDatasetId", "targetDatasetId", "source_generation", "target_generation",
  "source_count", "target_count", "source_points", "target_points", "longitude_span", "allowed", "distanceMeters", "crs", "persisted", "limits"];

/** Measure existing governed clip outputs. This function makes no source read,
 * buffer, geometric union, browser clip, topology repair or impact inference.
 */
export function buildReceptorScreening({footprint, influence, question, influenceBasis}) {
  const started = performance.now();
  const guard = () => {if (performance.now() - started >= RECEPTOR_SCREENING_LIMITS.milliseconds) throw Error("Receptor screening exceeds its time limit.");};
  question = reviewText(question, "Screening question"); influenceBasis = reviewText(influenceBasis, "Influence basis");
  if (!Array.isArray(footprint?.features) || !Array.isArray(influence?.features)
    || footprint.features.length + influence.features.length > RECEPTOR_SCREENING_LIMITS.features) throw Error("Receptor screening exceeds its combined feature limit.");
  const clips = {footprint: clipCollection(footprint), influence: clipCollection(influence)};
  guard();
  const first = clips.footprint.receipt, second = clips.influence.receipt;
  for (const key of ["sourceDatasetId", "source_generation", "source_count", "source_points", "longitude_span"]) {
    if (first[key] !== second[key]) throw Error("Both screening scopes must use the same receptor inventory generation and counts.");
  }
  const reused = first.targetDatasetId === second.targetDatasetId && first.target_generation === second.target_generation;
  if (reused && (first.target_count !== second.target_count || first.target_points !== second.target_points
    || canonicalJson(clips.footprint.features) !== canonicalJson(clips.influence.features))) {
    throw Error("The same screening mask generation must retain identical clip results and counts.");
  }
  const budget = {positions: 0, west: Infinity, east: -Infinity, south: Infinity, north: -Infinity};
  const reader = new GeoJSON(), rows = [], features = [], originals = new Map();
  const scopes = {footprint: emptySummary(0), influence: emptySummary(reused ? 0 : 1)};
  for (const scope of ["footprint", "influence"]) for (const feature of clips[scope].features) {
    guard();
    const sourceFeatureId = uuid(feature.id, "Receptor source feature ID"), original = canonicalJson(feature.properties);
    if (originals.has(sourceFeatureId) && originals.get(sourceFeatureId) !== original) throw Error("The same receptor generation has inconsistent source properties across screening scopes.");
    originals.set(sourceFeatureId, original);
    const geometryType = feature.geometry?.type;
    const positionCount = geometryPositions(feature.geometry, budget, guard);
    const geometry = reader.readGeometry(feature.geometry, {dataProjection: "EPSG:4326", featureProjection: "EPSG:4326"});
    let areaSquareMeters = 0, lengthMeters = 0, pointCount = 0;
    if (geometryType.includes("Polygon")) {
      areaSquareMeters = getArea(geometry, {projection: "EPSG:4326", radius: DEFAULT_RADIUS});
      if (!Number.isFinite(areaSquareMeters) || areaSquareMeters <= 0) throw Error("A clipped receptor polygon must have positive area.");
    } else if (geometryType.includes("LineString")) {
      lengthMeters = getLength(geometry, {projection: "EPSG:4326", radius: DEFAULT_RADIUS});
      if (!Number.isFinite(lengthMeters) || lengthMeters <= 0) throw Error("A clipped receptor line must have positive length.");
    } else pointCount = geometryType === "Point" ? 1 : feature.geometry.coordinates.length;
    const row = {id: `${scope}:${sourceFeatureId}`, scope, sourceFeatureId, geometryType, positionCount,
      areaSquareMeters, lengthMeters, pointCount};
    rows.push(row); addSummary(scopes[scope], row);
    const {id, ...screening} = row;
    features.push({type: "Feature", id, geometry: structuredClone(feature.geometry),
      properties: {source: structuredClone(feature.properties), screening: {...screening}}});
    guard();
  }
  const report = {schemaVersion: "opengeo.receptor-screening.1.0.0", question, influenceBasis,
    inputs: {receptors: sourcePin(first), footprint: targetPin(first), influence: targetPin(second)},
    method: {...METHOD}, nativeReceipts: reused ? [first] : [first, second], scopes, rows,
    scope: {...SCOPE}, limits: {...RECEPTOR_SCREENING_LIMITS}, validatedCount: null};
  validateReceptorScreeningReport(report); guard();
  const collection = {type: "FeatureCollection", features, "opengeo:analysis": {
    operation: "receptor-screen", version: "1.0.0", persisted: false, crs: "CRS:84",
    sourceDatasetId: first.sourceDatasetId, source_generation: first.source_generation, source_count: first.source_count,
    targetDatasetId: first.targetDatasetId, target_generation: first.target_generation, target_count: first.target_count,
    screening: report}};
  boundedJson(collection); guard(); return collection;
}

/** Validate portable counts and role partitions; this does not independently
 * recompute clipped geometry or establish receptor coverage or impacts.
 */
export function validateReceptorScreeningReport(report) {
  closed(report, ["schemaVersion", "question", "influenceBasis", "inputs", "method", "nativeReceipts", "scopes", "rows", "scope", "limits", "validatedCount"], "Receptor screening report");
  if (report.schemaVersion !== "opengeo.receptor-screening.1.0.0" || report.validatedCount !== null
    || report.question !== reviewText(report.question, "Screening question")
    || report.influenceBasis !== reviewText(report.influenceBasis, "Influence basis")) throw Error("Invalid receptor screening schema, question or inference claim.");
  for (const [key, expected] of [["method", METHOD], ["scope", SCOPE], ["limits", RECEPTOR_SCREENING_LIMITS]]) {
    closed(report[key], Object.keys(expected), `Receptor screening ${key}`);
    if (Object.entries(expected).some(([name, value]) => report[key][name] !== value)) throw Error(`Invalid receptor screening ${key}.`);
  }
  closed(report.inputs, ["receptors", "footprint", "influence"], "Receptor screening inputs");
  for (const input of Object.values(report.inputs)) {
    closed(input, ["datasetId", "generation", "featureCount"], "Receptor screening input");
    if (uuid(input.datasetId, "Receptor screening dataset ID") !== input.datasetId || !positiveInteger(input.generation)
      || !count(input.featureCount, 1_000)) throw Error("Invalid receptor screening input pin.");
  }
  if (report.inputs.receptors.datasetId === report.inputs.footprint.datasetId || report.inputs.receptors.datasetId === report.inputs.influence.datasetId) throw Error("Receptors and screening masks must be distinct inventories.");
  if (!Array.isArray(report.nativeReceipts) || ![1, 2].includes(report.nativeReceipts.length)) throw Error("Screening requires one reused or two native clip receipts.");
  const receipts = report.nativeReceipts.map(receipt => {
    closed(receipt, [...RECEIPT_KEYS, ...(Object.hasOwn(receipt, "previewId") ? ["previewId"] : [])], "Native screening clip receipt");
    return clipReceipt(receipt);
  });
  closed(report.scopes, ["footprint", "influence"], "Receptor screening scopes");
  const indexes = {footprint: 0, influence: receipts.length - 1};
  for (const scope of ["footprint", "influence"]) {
    const summary = report.scopes[scope], receipt = receipts[indexes[scope]];
    closed(summary, SUMMARY_KEYS, "Receptor screening scope summary");
    if (summary.clipReceiptIndex !== indexes[scope]
      || canonicalJson(sourcePin(receipt)) !== canonicalJson(report.inputs.receptors)
      || canonicalJson(targetPin(receipt)) !== canonicalJson(report.inputs[scope])) throw Error("Screening scope and native clip input pins disagree.");
  }
  if (receipts.length === 2 && ["source_points", "longitude_span"].some(key => receipts[0][key] !== receipts[1][key])) throw Error("Native clips disagree about their shared receptor source.");
  if (!Array.isArray(report.rows) || report.rows.length > RECEPTOR_SCREENING_LIMITS.features) throw Error("Invalid receptor screening rows.");
  const totals = {footprint: emptySummary(0), influence: emptySummary(indexes.influence)}, ids = new Set();
  let positions = 0, previousId = "";
  for (const row of report.rows) {
    closed(row, ROW_KEYS, "Receptor screening row");
    if (!["footprint", "influence"].includes(row.scope) || !GEOMETRIES.includes(row.geometryType)
      || uuid(row.sourceFeatureId, "Screened receptor feature ID") !== row.sourceFeatureId
      || row.id !== `${row.scope}:${row.sourceFeatureId}` || ids.has(row.id) || row.id <= previousId
      || !count(row.positionCount, RECEPTOR_SCREENING_LIMITS.positions) || row.positionCount < 1
      || !nonnegative(row.areaSquareMeters) || !nonnegative(row.lengthMeters) || !count(row.pointCount, 50_000)) throw Error("Invalid receptor screening row identity or measures.");
    const polygon = row.geometryType.includes("Polygon"), line = row.geometryType.includes("LineString");
    if (polygon ? row.areaSquareMeters <= 0 || row.lengthMeters !== 0 || row.pointCount !== 0 || row.positionCount < 4
      : line ? row.lengthMeters <= 0 || row.areaSquareMeters !== 0 || row.pointCount !== 0 || row.positionCount < 2
        : row.areaSquareMeters !== 0 || row.lengthMeters !== 0 || row.pointCount !== row.positionCount
          || row.geometryType === "Point" && row.pointCount !== 1) throw Error("Receptor screening measures do not match geometry dimensions.");
    positions += row.positionCount; ids.add(row.id); previousId = row.id; addSummary(totals[row.scope], row);
  }
  if (positions > RECEPTOR_SCREENING_LIMITS.positions) throw Error("Receptor screening exceeds its combined position limit.");
  for (const scope of ["footprint", "influence"]) {
    const summary = report.scopes[scope];
    if (Object.entries(totals[scope]).some(([key, value]) => summary[key] !== value)
      || summary.featureCount > report.inputs.receptors.featureCount
      || report.inputs[scope].featureCount === 0 && summary.featureCount !== 0) throw Error("Receptor screening scope totals are inconsistent.");
  }
  if (receipts.length === 1) {
    const footprintRows = report.rows.filter(row => row.scope === "footprint").map(({id, scope, ...row}) => row);
    const influenceRows = report.rows.filter(row => row.scope === "influence").map(({id, scope, ...row}) => row);
    if (canonicalJson(footprintRows) !== canonicalJson(influenceRows)) throw Error("A reused screening mask must retain identical receptor rows in both scopes.");
  }
  boundedJson(report); return structuredClone(report);
}

export function receptorScreeningCsv(collectionOrReport) {
  const report = validateReceptorScreeningReport(collectionOrReport?.["opengeo:analysis"]?.screening ?? collectionOrReport);
  const rows = [["scope", "source_feature_id", "geometry_type", "area_square_meters", "length_meters", "point_count", "question", "influence_basis"]];
  for (const row of report.rows) rows.push([row.scope, row.sourceFeatureId, row.geometryType, row.areaSquareMeters,
    row.lengthMeters, row.pointCount, report.question, report.influenceBasis]);
  const cell = value => {let text = String(value); if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;};
  const csv = rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
  if (new TextEncoder().encode(csv).byteLength > RECEPTOR_SCREENING_LIMITS.outputBytes) throw Error("Receptor screening CSV exceeds its byte limit.");
  return csv;
}

function clipCollection(collection) {
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features) || collection.crs !== undefined) throw Error("A native CRS84 clip collection is required.");
  const receipt = clipReceipt(collection["opengeo:analysis"]);
  const parsed = spatialPreviewGeojson({type: collection.type, features: collection.features}), seen = new Set();
  for (const feature of parsed.features) {
    const id = uuid(feature.id, "Native clipped receptor feature ID");
    if (seen.has(id)) throw Error("A receptor feature may occur only once within each native clip.");
    seen.add(id); feature.id = id;
  }
  if (parsed.features.length > receipt.source_count || receipt.target_count === 0 && parsed.features.length) throw Error("Native clip output and input counts disagree.");
  parsed.features.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {receipt, features: parsed.features};
}
function clipReceipt(value) {
  if (!value || typeof value !== "object" || value.operation !== "clip" || !["1.0.0", "1.1.0"].includes(value.version)
    || value.allowed !== true || value.persisted !== false || value.crs !== "CRS:84" || value.distanceMeters !== null) throw Error("A successful bounded native clip receipt is required.");
  const receipt = Object.fromEntries(RECEIPT_KEYS.filter(key => key !== "limits").map(key => [key, value[key]]));
  receipt.sourceDatasetId = uuid(value.sourceDatasetId, "Native clip receptor dataset ID");
  receipt.targetDatasetId = uuid(value.targetDatasetId, "Native clip mask dataset ID");
  if (receipt.sourceDatasetId === receipt.targetDatasetId || !positiveInteger(value.source_generation) || !positiveInteger(value.target_generation)
    || !count(value.source_count, 1_000) || !count(value.target_count, 1_000)
    || !count(value.source_points, 50_000) || !count(value.target_points, 50_000)
    || value.source_points < value.source_count || value.target_points < value.target_count
    || value.source_count === 0 && value.source_points !== 0 || value.target_count === 0 && value.target_points !== 0
    || !Number.isFinite(value.longitude_span) || value.longitude_span < 0 || value.longitude_span > 360) throw Error("Native clip input identity or counts are invalid.");
  closed(value.limits, Object.keys(NATIVE_LIMITS), "Native clip limits");
  if (Object.entries(NATIVE_LIMITS).some(([key, expected]) => value.limits[key] !== expected)) throw Error("Native clip limits are inconsistent.");
  receipt.limits = {...NATIVE_LIMITS};
  if (value.previewId !== undefined) receipt.previewId = uuid(value.previewId, "Native clip preview ID");
  return receipt;
}
function geometryPositions(geometry, budget, guard) {
  if (!geometry || !GEOMETRIES.includes(geometry.type)) throw Error("A supported nonempty clipped receptor geometry is required.");
  let positions = 0;
  const point = value => {
    if (++budget.positions > RECEPTOR_SCREENING_LIMITS.positions) throw Error("Receptor screening exceeds its combined position limit.");
    if (positions++ % 256 === 0) guard();
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || Math.abs(value[0]) > 180
      || Math.abs(value[1]) > RECEPTOR_SCREENING_LIMITS.maximumAbsoluteLatitude) throw Error("Receptor screening coordinates are outside its bounded 2D geographic profile.");
    budget.west = Math.min(budget.west, value[0]); budget.east = Math.max(budget.east, value[0]);
    budget.south = Math.min(budget.south, value[1]); budget.north = Math.max(budget.north, value[1]);
    if (budget.east - budget.west > RECEPTOR_SCREENING_LIMITS.longitudeSpanDegrees
      || budget.north - budget.south > RECEPTOR_SCREENING_LIMITS.longitudeSpanDegrees) throw Error("Receptor screening exceeds its geographic span limit.");
  };
  const nonempty = values => {if (!Array.isArray(values) || !values.length) throw Error("Clipped receptor geometry must be nonempty.");};
  const line = (values, ring = false) => {
    nonempty(values);
    if (values.length < (ring ? 4 : 2)) throw Error("A clipped receptor line or ring has too few positions.");
    values.forEach((value, index) => {point(value); if (index && Math.abs(value[0] - values[index - 1][0]) > 180) throw Error("Antimeridian-crossing receptor geometry is unsupported.");});
    if (ring && (values[0][0] !== values.at(-1)[0] || values[0][1] !== values.at(-1)[1])) throw Error("Clipped receptor rings must be closed.");
  };
  const polygon = values => {nonempty(values); values.forEach(ring => line(ring, true));};
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case "Point": point(coordinates); break;
    case "MultiPoint": nonempty(coordinates); coordinates.forEach(point); break;
    case "LineString": line(coordinates); break;
    case "MultiLineString": nonempty(coordinates); coordinates.forEach(values => line(values)); break;
    case "Polygon": polygon(coordinates); break;
    case "MultiPolygon": nonempty(coordinates); coordinates.forEach(polygon); break;
  }
  return positions;
}
function emptySummary(clipReceiptIndex) {return {clipReceiptIndex, featureCount: 0, polygonFeatureCount: 0, lineFeatureCount: 0,
  pointFeatureCount: 0, positionCount: 0, areaSquareMeters: 0, lengthMeters: 0, pointCount: 0};}
function addSummary(summary, row) {
  summary.featureCount++; summary.positionCount += row.positionCount; summary.areaSquareMeters += row.areaSquareMeters;
  summary.lengthMeters += row.lengthMeters; summary.pointCount += row.pointCount;
  summary[row.geometryType.includes("Polygon") ? "polygonFeatureCount" : row.geometryType.includes("LineString") ? "lineFeatureCount" : "pointFeatureCount"]++;
}
function sourcePin(receipt) {return {datasetId: receipt.sourceDatasetId, generation: receipt.source_generation, featureCount: receipt.source_count};}
function targetPin(receipt) {return {datasetId: receipt.targetDatasetId, generation: receipt.target_generation, featureCount: receipt.target_count};}
function reviewText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500 || value.includes("\0")) throw Error(`${label} requires at most 500 characters of explanatory text.`);
  return value.trim();
}
function boundedJson(value) {if (new TextEncoder().encode(JSON.stringify(value)).byteLength > RECEPTOR_SCREENING_LIMITS.outputBytes) throw Error("Receptor screening exceeds its byte limit.");}
function closed(value, keys, label) {if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} is invalid.`); exactKeys(value, keys, label);}
function positiveInteger(value) {return Number.isSafeInteger(value) && value >= 1;}
function count(value, maximum) {return Number.isSafeInteger(value) && value >= 0 && value <= maximum;}
function nonnegative(value) {return Number.isFinite(value) && value >= 0;}
