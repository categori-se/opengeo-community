export const FEATURE_QUERY_LIMITS = Object.freeze({
  maximumSteps: 4,
  maximumResults: 100,
  maximumOffset: 10_000,
  maximumBufferMeters: 100_000,
  maximumGeometryCoordinates: 2_048,
  maximumGeometryBytes: 65_536,
  maximumCsvBytes: 262_144,
  maximumCsvFields: 64,
  timeoutSeconds: 10
});

export const FEATURE_QUERY_SCHEMA_VERSION = "opengeo.feature-query.1.1.0";
export const SAVED_FEATURE_QUERY_SCHEMA_VERSION = "opengeo.saved-feature-query.1.0.0";

const FEATURE_QUERY_SCHEMA_VERSIONS = new Set([
  "opengeo.feature-query.1.0.0",
  FEATURE_QUERY_SCHEMA_VERSION
]);

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTRIBUTE_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_null"
]);

export function normalizeFeatureQuery(value, {expectedGeneration = undefined} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("feature query must be an object");
  }
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > FEATURE_QUERY_LIMITS.maximumSteps) {
    throw new TypeError("feature query requires between one and four steps");
  }
  const generation = value.expectedGeneration ?? value.expected_generation ?? expectedGeneration ?? null;
  if (generation !== null && (!Number.isSafeInteger(generation) || generation < 1)) {
    throw new TypeError("feature query expected generation must be a positive integer");
  }
  const limit = value.limit ?? FEATURE_QUERY_LIMITS.maximumResults;
  const offset = value.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FEATURE_QUERY_LIMITS.maximumResults) {
    throw new TypeError("feature query limit is invalid");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > FEATURE_QUERY_LIMITS.maximumOffset) {
    throw new TypeError("feature query offset is invalid");
  }
  const schemaVersion = value.schema_version ?? value.schemaVersion ?? FEATURE_QUERY_SCHEMA_VERSION;
  if (!FEATURE_QUERY_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new TypeError("feature query schema is unsupported");
  }
  return {
    schema_version: schemaVersion,
    combine: "all",
    steps: steps.map(normalizeStep),
    limit,
    offset,
    expected_generation: generation
  };
}

export function parseFeatureQueryReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("feature query receipt is invalid");
  }
  assertExactKeys(value, [
    "schema_version",
    "combine",
    "steps",
    "limit",
    "offset",
    "expected_generation",
    "sort"
  ], "feature query receipt");
  for (const step of value.steps ?? []) {
    assertExactKeys(
      step,
      step?.kind === "attribute"
        ? ["kind", "field", "operator", "value", "case_sensitive"]
        : ["kind", "relation", "geometry", "buffer_meters"],
      "feature query step"
    );
    if (step?.kind === "spatial") {
      assertExactKeys(
        step.geometry,
        step.geometry?.type === "GeometryCollection"
          ? ["type", "geometries"]
          : ["type", "coordinates"],
        "feature query geometry"
      );
    }
  }
  const query = normalizeFeatureQuery({
    schema_version: value.schema_version,
    steps: value.steps,
    limit: value.limit,
    offset: value.offset,
    expectedGeneration: value.expected_generation
  });
  if (value.schema_version !== query.schema_version || value.combine !== "all" || value.sort !== "feature_id") {
    throw new TypeError("feature query receipt contract is invalid");
  }
  return query;
}

export function applyFeatureQuery(features, query) {
  const normalized = normalizeFeatureQuery(query);
  const matches = features
    .filter((feature) => normalized.steps.every((step) => {
      if (step.kind === "attribute") return attributeMatches(feature.properties ?? {}, step);
      return spatialMatches(feature.bbox, step);
    }))
    .sort((left, right) => compareCodePoints(String(left.id), String(right.id)));
  return {
    matches,
    page: matches.slice(normalized.offset, normalized.offset + normalized.limit),
    query: normalized
  };
}

export function serializeFeatureQueryCsv(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.features)) {
    throw new TypeError("feature query result is invalid");
  }
  if (result.features.length > FEATURE_QUERY_LIMITS.maximumResults) {
    throw new TypeError("feature query CSV exceeds the result limit");
  }
  const fields = [...new Set(result.features.flatMap((feature) => Object.keys(feature.properties ?? {})))]
    .sort((left, right) => left.localeCompare(right));
  if (fields.length > FEATURE_QUERY_LIMITS.maximumCsvFields || fields.some((field) => !FIELD_NAME.test(field))) {
    throw new TypeError("feature query CSV fields are invalid");
  }
  const header = ["feature_id", "feature_version", "geometry_type", ...fields];
  const rows = result.features.map((feature) => [
    feature.id,
    feature.version,
    feature.geometry?.type,
    ...fields.map((field) => feature.properties?.[field] ?? null)
  ]);
  const csv = `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  if (new TextEncoder().encode(csv).byteLength > FEATURE_QUERY_LIMITS.maximumCsvBytes) {
    throw new TypeError("feature query CSV exceeds 262144 bytes");
  }
  return csv;
}

export function queryGeometryFromFeatures(features) {
  if (!Array.isArray(features) || features.length < 1 || features.length > FEATURE_QUERY_LIMITS.maximumResults) {
    throw new TypeError("query result selection requires between one and 100 features");
  }
  const geometries = features.map((feature) => normalizeGeometry(feature?.geometry));
  return normalizeGeometry(
    geometries.length === 1
      ? geometries[0]
      : {type: "GeometryCollection", geometries}
  );
}

export function queryGeometryFromBoundaryFeature(feature) {
  if (feature?.type !== "Feature" || !["Polygon", "MultiPolygon"].includes(feature.geometry?.type)) {
    throw new TypeError("query area requires a Polygon or MultiPolygon boundary");
  }
  return queryGeometryFromFeatures([feature]);
}

export async function featureQuerySha256(query) {
  const normalized = normalizeFeatureQuery(query);
  const document = {
    ...normalized,
    sort: "feature_id"
  };
  return canonicalSha256(document);
}

export function assertFeatureQuerySha256(value) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError("feature query digest is invalid");
  }
  return value;
}

export async function createSavedFeatureQueryReceipt({
  datasetId,
  layerTitle,
  result
}) {
  const identity = savedQueryIdentity({datasetId, layerTitle});
  if (!result || typeof result !== "object") throw new TypeError("saved query result is invalid");
  const resultQuery = normalizeFeatureQuery(result.query ?? {});
  const collectionGeneration = positiveGeneration(result.generation);
  if (resultQuery.expected_generation !== null
    && resultQuery.expected_generation !== collectionGeneration) {
    throw new TypeError("saved query generation is inconsistent");
  }
  const resultQuerySha256 = assertFeatureQuerySha256(result.querySha256);
  if (await featureQuerySha256(resultQuery) !== resultQuerySha256) {
    throw new TypeError("saved query digest is inconsistent");
  }
  const query = resultQuery.expected_generation === null
    ? {...resultQuery, expected_generation: collectionGeneration}
    : resultQuery;
  const querySha256 = await featureQuerySha256(query);
  const receipt = {
    schema_version: SAVED_FEATURE_QUERY_SCHEMA_VERSION,
    ...identity,
    collection_generation: collectionGeneration,
    query_sha256: querySha256,
    query: {...query, sort: "feature_id"}
  };
  return {...receipt, receipt_sha256: await canonicalSha256(receipt)};
}

export async function parseSavedFeatureQueryReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("saved query receipt is invalid");
  }
  if (value.schema_version !== SAVED_FEATURE_QUERY_SCHEMA_VERSION) {
    throw new TypeError("saved query receipt schema is unsupported");
  }
  assertExactKeys(value, [
    "schema_version",
    "dataset_id",
    "layer_title",
    "collection_generation",
    "query_sha256",
    "query",
    "receipt_sha256"
  ], "saved query receipt");
  const identity = savedQueryIdentity({
    datasetId: value.dataset_id,
    layerTitle: value.layer_title
  });
  const collectionGeneration = positiveGeneration(value.collection_generation);
  const query = parseFeatureQueryReceipt(value.query);
  if (query.expected_generation !== collectionGeneration) {
    throw new TypeError("saved query generation is inconsistent");
  }
  const querySha256 = assertFeatureQuerySha256(value.query_sha256);
  if (await featureQuerySha256(query) !== querySha256) {
    throw new TypeError("saved query digest is inconsistent");
  }
  const receipt = {
    schema_version: SAVED_FEATURE_QUERY_SCHEMA_VERSION,
    ...identity,
    collection_generation: collectionGeneration,
    query_sha256: querySha256,
    query: {...query, sort: "feature_id"}
  };
  const receiptSha256 = assertFeatureQuerySha256(value.receipt_sha256);
  if (await canonicalSha256(receipt) !== receiptSha256) {
    throw new TypeError("saved query receipt digest is inconsistent");
  }
  return {...receipt, receipt_sha256: receiptSha256};
}

function normalizeStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new TypeError("feature query step must be an object");
  }
  if (step.kind === "attribute") {
    if (typeof step.field !== "string" || !FIELD_NAME.test(step.field)) {
      throw new TypeError("feature query field is invalid");
    }
    if (!ATTRIBUTE_OPERATORS.has(step.operator)) {
      throw new TypeError("feature query operator is invalid");
    }
    if (step.operator === "is_null" && step.value !== null && step.value !== undefined) {
      throw new TypeError("is_null query value must be null");
    }
    const value = step.operator === "is_null" ? null : scalar(step.value);
    const caseSensitive = step.caseSensitive ?? step.case_sensitive ?? false;
    if (typeof caseSensitive !== "boolean") {
      throw new TypeError("feature query case sensitivity must be boolean");
    }
    return {
      kind: "attribute",
      field: step.field,
      operator: step.operator,
      value,
      case_sensitive: caseSensitive
    };
  }
  if (step.kind !== "spatial" || !["intersects", "within"].includes(step.relation ?? "intersects")) {
    throw new TypeError("feature spatial query step is invalid");
  }
  const buffer = step.bufferMeters ?? step.buffer_meters ?? 0;
  if (!Number.isFinite(buffer) || buffer < 0 || buffer > FEATURE_QUERY_LIMITS.maximumBufferMeters) {
    throw new TypeError("feature query buffer is invalid");
  }
  return {
    kind: "spatial",
    relation: step.relation ?? "intersects",
    geometry: normalizeGeometry(step.geometry),
    buffer_meters: buffer
  };
}

function savedQueryIdentity({datasetId, layerTitle}) {
  if (typeof datasetId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(datasetId)) {
    throw new TypeError("saved query dataset id is invalid");
  }
  if (typeof layerTitle !== "string"
    || layerTitle.trim().length < 1
    || layerTitle.trim().length > 200
    || /[\u0000-\u001f\u007f]/.test(layerTitle)) {
    throw new TypeError("saved query layer title is invalid");
  }
  return {
    dataset_id: datasetId,
    layer_title: layerTitle.trim()
  };
}

function positiveGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("saved query collection generation is invalid");
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  const actual = Object.keys(value).sort(compareCodePoints);
  const allowed = [...expected].sort(compareCodePoints);
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`${label} contains unexpected or missing fields`);
  }
}

function scalar(value) {
  if (typeof value === "string" && value.length >= 1 && value.length <= 200) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new TypeError("feature query value must be a bounded scalar");
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    throw new TypeError("feature query geometry is invalid");
  }
  const supported = new Set([
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection"
  ]);
  if (!supported.has(geometry.type)) {
    throw new TypeError("feature query geometry type is invalid");
  }
  const clone = structuredClone(geometry);
  if (clone.type === "GeometryCollection") {
    if (!Array.isArray(clone.geometries)
      || clone.geometries.length < 1
      || clone.geometries.length > FEATURE_QUERY_LIMITS.maximumResults
      || clone.geometries.some((member) => member?.type === "GeometryCollection")) {
      throw new TypeError("feature query GeometryCollection is invalid");
    }
    clone.geometries = clone.geometries.map(normalizeGeometry);
  } else if (!Array.isArray(clone.coordinates)) {
    throw new TypeError("feature query geometry coordinates are invalid");
  }
  if (clone.type === "Point" && !isPosition(clone.coordinates)) {
    throw new TypeError("feature query Point is invalid");
  }
  if (clone.type === "MultiPoint"
    && (!clone.coordinates.length || !clone.coordinates.every(isPosition))) {
    throw new TypeError("feature query MultiPoint is invalid");
  }
  if (clone.type === "LineString"
    && (clone.coordinates.length < 2 || !clone.coordinates.every(isPosition))) {
    throw new TypeError("feature query LineString is invalid");
  }
  if (clone.type === "MultiLineString"
    && (!clone.coordinates.length || !clone.coordinates.every(isLine))) {
    throw new TypeError("feature query MultiLineString is invalid");
  }
  if (clone.type === "Polygon" && (!clone.coordinates.length || clone.coordinates.some((ring) => (
    !isRing(ring)
  )))) {
    throw new TypeError("feature query Polygon is invalid");
  }
  if (clone.type === "MultiPolygon"
    && (!clone.coordinates.length || !clone.coordinates.every(isPolygon))) {
    throw new TypeError("feature query MultiPolygon is invalid");
  }
  const coordinates = geometryPositions(clone);
  if (!coordinates.length || coordinates.length > FEATURE_QUERY_LIMITS.maximumGeometryCoordinates) {
    throw new TypeError("feature query geometry coordinate count is invalid");
  }
  for (const [longitude, latitude] of coordinates) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new TypeError("feature query geometry must use WGS84 coordinates");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(clone)).byteLength > FEATURE_QUERY_LIMITS.maximumGeometryBytes) {
    throw new TypeError("feature query geometry is too large");
  }
  return clone;
}

function isPosition(value) {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number");
}

function isLine(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(isPosition);
}

function isRing(value) {
  return Array.isArray(value)
    && value.length >= 4
    && value.every(isPosition)
    && value[0][0] === value.at(-1)[0]
    && value[0][1] === value.at(-1)[1];
}

function isPolygon(value) {
  return Array.isArray(value) && value.length >= 1 && value.every(isRing);
}

function positions(value) {
  if (!Array.isArray(value)) return [];
  if (value.length === 2 && value.every((item) => typeof item === "number")) return [value];
  return value.flatMap(positions);
}

function geometryPositions(geometry) {
  if (geometry?.type === "GeometryCollection") {
    return geometry.geometries.flatMap(geometryPositions);
  }
  return positions(geometry?.coordinates);
}

function attributeMatches(properties, step) {
  const candidate = properties[step.field];
  if (step.operator === "is_null") return candidate === null || candidate === undefined;
  if (candidate === null || candidate === undefined) return false;
  if (["contains", "starts_with"].includes(step.operator)) {
    const left = step.case_sensitive ? String(candidate) : String(candidate).toLocaleLowerCase();
    const right = step.case_sensitive ? String(step.value) : String(step.value).toLocaleLowerCase();
    return step.operator === "contains" ? left.includes(right) : left.startsWith(right);
  }
  const result = compare(candidate, step.value);
  return ({
    equals: result === 0,
    not_equals: result !== 0,
    greater_than: result > 0,
    greater_than_or_equal: result >= 0,
    less_than: result < 0,
    less_than_or_equal: result <= 0
  })[step.operator] ?? false;
}

function compare(left, right) {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function spatialMatches(featureBbox, step) {
  if (!Array.isArray(featureBbox) || featureBbox.length !== 4) return false;
  const queryBbox = geometryBbox(step.geometry);
  const latitude = (queryBbox[1] + queryBbox[3]) / 2;
  const latitudeDelta = step.buffer_meters / 110_574;
  const longitudeDelta = step.buffer_meters / Math.max(1, 111_320 * Math.cos(latitude * Math.PI / 180));
  const buffered = [
    queryBbox[0] - longitudeDelta,
    queryBbox[1] - latitudeDelta,
    queryBbox[2] + longitudeDelta,
    queryBbox[3] + latitudeDelta
  ];
  if (step.relation === "within") {
    return featureBbox[0] >= buffered[0] && featureBbox[1] >= buffered[1]
      && featureBbox[2] <= buffered[2] && featureBbox[3] <= buffered[3];
  }
  return !(featureBbox[2] < buffered[0] || featureBbox[0] > buffered[2]
    || featureBbox[3] < buffered[1] || featureBbox[1] > buffered[3]);
}

function geometryBbox(geometry) {
  const coordinates = geometryPositions(geometry);
  return [
    Math.min(...coordinates.map(([x]) => x)),
    Math.min(...coordinates.map(([, y]) => y)),
    Math.max(...coordinates.map(([x]) => x)),
    Math.max(...coordinates.map(([, y]) => y))
  ];
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? canonicalJson(value) : String(value);
  if (typeof value === "string" && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number") return canonicalNumber(value);
  return JSON.stringify(value);
}

function compareCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError("canonical JSON numbers must be finite");
  if (value === 0) return "0";
  const rendered = String(value).toLowerCase();
  if (!rendered.includes("e")) return rendered;
  const [coefficient, exponentText] = rendered.split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + Number(exponentText);
  const plain = decimalIndex <= 0
    ? `0.${"0".repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return negative ? `-${plain}` : plain;
}

async function canonicalSha256(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
