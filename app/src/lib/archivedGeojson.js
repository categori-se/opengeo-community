import {gunzipSync} from "fflate";

const MAXIMUM_COORDINATE_POSITIONS = 4_000_000;
const MAXIMUM_PROPERTY_FIELDS = 256;
const MAXIMUM_PROPERTY_STRING_LENGTH = 4_096;
const GEOMETRY_TYPES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]);

export class ArchivedGeojsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchivedGeojsonError";
    this.code = code;
  }
}

/**
 * Load one immutable, anonymous GeoJSON archive after verifying the exact
 * object and decoded content described by its governed source revision.
 */
export async function loadArchivedGeojson({
  url,
  configuration,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal,
  timeoutMilliseconds = 30_000
}) {
  const sourceUrl = validateSourceUrl(url);
  const contract = validateConfiguration(configuration);
  if (typeof fetchImpl !== "function") fail("fetch_unavailable", "Archive fetch support is unavailable");
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 60_000) {
    fail("invalid_contract", "Archive timeout is outside the supported range");
  }

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.("abort", abort, {once: true});
  const timeout = setTimeout(() => controller.abort(new DOMException("Archive request timed out", "TimeoutError")), timeoutMilliseconds);
  try {
    const response = await fetchImpl(sourceUrl, {
      method: "GET",
      headers: {accept: contract.contentEncoding === "gzip"
        ? "application/gzip, application/octet-stream;q=0.9"
        : "application/geo+json, application/json;q=0.9"},
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "force-cache",
      signal: controller.signal
    });
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      fail("archive_unavailable", `Archive request failed with HTTP ${response?.status ?? "unknown"}`);
    }
    if (response.url && response.url !== sourceUrl) {
      fail("redirect_rejected", "Archive response URL did not match the governed source URL");
    }
    validateContentType(response, contract.contentEncoding);
    const object = await readExactBody(response, contract.sizeBytes);
    if (await sha256Hex(object) !== contract.objectSha256) {
      fail("object_checksum_mismatch", "Archive object checksum did not match its governed revision");
    }
    const decoded = decodeArchive(object, contract);
    if (decoded.byteLength !== contract.decodedSizeBytes
      || await sha256Hex(decoded) !== contract.decodedSha256) {
      fail("decoded_checksum_mismatch", "Decoded GeoJSON checksum did not match its governed revision");
    }
    const collection = parseCollection(decoded, contract);
    Object.defineProperty(collection, "opengeo", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        schemaVersion: "opengeo.archived-geojson-receipt.1.0.0",
        sourceMode: "governed-immutable-archive",
        sourceUrl,
        authoritativeUrl: contract.authoritativeUrl,
        objectSha256: contract.objectSha256,
        decodedSha256: contract.decodedSha256,
        featureCount: collection.features.length,
        attribution: contract.attribution,
        license: contract.license,
        rightsUrl: contract.rightsUrl
      })
    });
    return collection;
  } catch (error) {
    if (error instanceof ArchivedGeojsonError) throw error;
    if (controller.signal.aborted) {
      fail(signal?.aborted ? "request_cancelled" : "request_timeout", "Archive request was cancelled before completion");
    }
    fail("archive_unavailable", "Archive could not be loaded");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abort);
  }
}

// Reused for reviewed private copies; signed transport is validated separately.
export async function verifyReviewedArchiveBytes(object, contract, {allowNestedProperties = false, allowCaptureMetadata = false} = {}) {
  if (!(object instanceof Uint8Array) || object.byteLength !== contract.sizeBytes
    || !Number.isSafeInteger(contract.decodedSizeBytes) || contract.decodedSizeBytes < 1
    || contract.decodedSizeBytes > 64 * 1024**2
    || !Number.isSafeInteger(contract.featureCount) || contract.featureCount < 0
    || contract.featureCount > 100000 || !GEOMETRY_TYPES.has(contract.geometryType)
    || !["identity", "gzip"].includes(contract.contentEncoding)) {
    fail("invalid_contract", "Archive rendering facts are invalid");
  }
  if (await sha256Hex(object) !== contract.objectSha256) fail("object_checksum_mismatch", "Archive checksum failed");
  const decoded = decodeArchive(object, contract);
  if (decoded.byteLength !== contract.decodedSizeBytes
    || await sha256Hex(decoded) !== contract.decodedSha256) fail("decoded_checksum_mismatch", "Decoded archive checksum failed");
  return parseCollection(decoded, contract, allowNestedProperties, allowCaptureMetadata);
}

function validateConfiguration(value) {
  if (!plainObject(value)) fail("invalid_contract", "Archive configuration must be an object");
  const expected = [
    "attribution", "authoritativeUrl", "bounds", "contentEncoding", "decodedSha256",
    "decodedSizeBytes", "featureCount", "geometryType", "license", "objectSha256",
    "rightsUrl", "sizeBytes"
  ].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("invalid_contract", "Archive configuration contains unexpected fields");
  }
  if (!['identity', 'gzip'].includes(value.contentEncoding)
    || !/^[0-9a-f]{64}$/.test(value.objectSha256)
    || !/^[0-9a-f]{64}$/.test(value.decodedSha256)
    || !boundedInteger(value.sizeBytes, 1, 33_554_432)
    || !boundedInteger(value.decodedSizeBytes, 1, 134_217_728)
    || !boundedInteger(value.featureCount, 1, 250_000)
    || !GEOMETRY_TYPES.has(value.geometryType)
    || !boundedText(value.attribution, 1_000)
    || !boundedText(value.license, 500)) {
    fail("invalid_contract", "Archive integrity or presentation metadata is invalid");
  }
  if (!validBounds(value.bounds)) fail("invalid_contract", "Archive coverage bounds are invalid");
  const authoritativeUrl = validateReferenceUrl(value.authoritativeUrl);
  const rightsUrl = validateReferenceUrl(value.rightsUrl);
  if (value.contentEncoding === "identity"
    && (value.objectSha256 !== value.decodedSha256 || value.sizeBytes !== value.decodedSizeBytes)) {
    fail("invalid_contract", "Uncompressed archive facts must match");
  }
  if (value.contentEncoding === "gzip" && value.decodedSizeBytes < value.sizeBytes) {
    fail("invalid_contract", "Compressed archive size facts are invalid");
  }
  return {...value, authoritativeUrl, rightsUrl};
}

function validateSourceUrl(value) {
  const url = publicHttpsUrl(value, false);
  const path = url.pathname.toLowerCase();
  if (!path.endsWith(".geojson") && !path.endsWith(".geojson.gz")) {
    fail("invalid_contract", "Archive URL must name a GeoJSON object");
  }
  return url.href;
}

function validateReferenceUrl(value) {
  return publicHttpsUrl(value, true).href;
}

function publicHttpsUrl(value, allowQuery) {
  if (typeof value !== "string" || !value || value.length > 2_048 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    fail("invalid_contract", "Archive URL is invalid");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_contract", "Archive URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || (url.port && url.port !== "443") || (!allowQuery && url.search)
    || !hostname || hostname === "localhost" || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
    || hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    fail("invalid_contract", "Archive URL is not an allowed public HTTPS URL");
  }
  return url;
}

function validateContentType(response, encoding) {
  const contentType = String(response.headers?.get?.("content-type") ?? "")
    .split(";", 1)[0].trim().toLowerCase();
  const allowed = encoding === "gzip"
    ? new Set(["application/gzip", "application/x-gzip", "application/octet-stream"])
    // Historical S3 uploads can carry generic or uploader-default metadata.
    // These headers never establish the format: exact size, both SHA-256 values,
    // UTF-8 JSON, feature count and every geometry are still checked below.
    : new Set(["application/geo+json", "application/json", "application/vnd.geo+json", "text/json",
      "application/octet-stream", "binary/octet-stream", "application/x-www-form-urlencoded"]);
  if (!allowed.has(contentType)) fail("invalid_content_type", "Archive response content type is invalid");
}

async function readExactBody(response, exactBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength !== exactBytes) {
    fail("object_size_mismatch", "Archive response size did not match its governed revision");
  }
  if (!response.body?.getReader) {
    if (typeof response.arrayBuffer !== "function") fail("archive_unavailable", "Archive response body is unavailable");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength !== exactBytes) fail("object_size_mismatch", "Archive object size did not match its governed revision");
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail("archive_unavailable", "Archive response stream is invalid");
    length += value.byteLength;
    if (length > exactBytes) {
      await reader.cancel();
      fail("object_size_mismatch", "Archive object exceeded its governed size");
    }
    chunks.push(value);
  }
  if (length !== exactBytes) fail("object_size_mismatch", "Archive object size did not match its governed revision");
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeArchive(object, contract) {
  if (contract.contentEncoding === "identity") return object;
  if (object.byteLength < 18
    || new DataView(object.buffer, object.byteOffset + object.byteLength - 4, 4)
      .getUint32(0, true) !== contract.decodedSizeBytes) {
    fail("decoded_size_mismatch", "Gzip archive size metadata did not match its governed revision");
  }
  let decoded;
  try {
    decoded = gunzipSync(object, {out: new Uint8Array(contract.decodedSizeBytes)});
  } catch {
    fail("invalid_compression", "Archive object could not be decompressed");
  }
  if (decoded.byteLength > contract.decodedSizeBytes) {
    fail("decoded_size_mismatch", "Decoded archive exceeded its governed size");
  }
  return decoded;
}

function parseCollection(decoded, contract, allowNestedProperties = false, allowCaptureMetadata = false) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(decoded));
  } catch {
    fail("invalid_geojson", "Archive content is not valid UTF-8 GeoJSON");
  }
  if (!plainObject(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)
    || value.features.length !== contract.featureCount) {
    fail("invalid_geojson", "Archive feature inventory did not match its governed revision");
  }
  const sourceText = ["name", "generator", "copyright", "timestamp"];
  const allowedRoot = new Set(["type", "features", "bbox", "crs", "exceededTransferLimit", "properties", ...sourceText]);
  if (allowCaptureMetadata) allowedRoot.add("opengeo:capture");
  if (Object.keys(value).some((key) => !allowedRoot.has(key))) fail("invalid_geojson", "Archive collection has unsupported fields");
  if (value.exceededTransferLimit === true || value.properties?.exceededTransferLimit === true) {
    fail("invalid_geojson", "Archive collection is an incomplete service response");
  }
  if (value.bbox !== undefined && !validBounds(value.bbox)) fail("invalid_geojson", "Archive collection bbox is invalid");
  for (const key of sourceText) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 4096)) fail("invalid_geojson", "Archive collection source text is invalid");
  }
  const budget = {positions: 0, propertyNodes: 0, allowNestedProperties};
  const capture = value["opengeo:capture"];
  if (capture !== undefined) {
    if (!plainObject(capture) || capture.schemaVersion !== "opengeo.feature-capture-counts.1.0.0"
      || capture.fetchedCount !== contract.featureCount) {
      fail("invalid_geojson", "Archive capture provenance does not match its feature inventory");
    }
    validatePropertyValue(capture, budget, 0);
  }
  value.features.forEach((feature, index) => validateFeature(feature, contract.geometryType, budget, index));
  return {type: "FeatureCollection", ...(capture === undefined ? {} : {"opengeo:capture": capture}), ...Object.fromEntries(sourceText.filter(key => value[key] !== undefined).map(key => [key, value[key]])), features: value.features};
}

function validateFeature(feature, configuredType, budget, index) {
  if (!plainObject(feature) || feature.type !== "Feature" || !plainObject(feature.properties)
    || (feature.geometry !== null && !plainObject(feature.geometry))) {
    fail("invalid_geojson", `Archive feature ${index + 1} is invalid`);
  }
  const allowed = new Set(["type", "id", "geometry", "properties", "bbox"]);
  if (Object.keys(feature).some((key) => !allowed.has(key))) fail("invalid_geojson", `Archive feature ${index + 1} has unsupported fields`);
  // RFC 7946 permits null geometry for unlocated records. Keep the original
  // attributes and null intact; a missing geometry member still fails above.
  if (feature.geometry !== null) {
    const actualType = feature.geometry.type;
    if (!GEOMETRY_TYPES.has(actualType) || geometryFamily(actualType) !== geometryFamily(configuredType)) {
      fail("invalid_geojson", `Archive feature ${index + 1} geometry does not match its governed family`);
    }
    if (!(Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length === 0)) {
      validateCoordinates(feature.geometry.coordinates, coordinateDepth(actualType), budget);
    }
  }
  const propertyKeys = Object.keys(feature.properties);
  if (propertyKeys.length > MAXIMUM_PROPERTY_FIELDS) fail("invalid_geojson", `Archive feature ${index + 1} has too many properties`);
  for (const key of propertyKeys) {
    if (!key || key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key.toLowerCase())) {
      fail("invalid_geojson", `Archive feature ${index + 1} contains an invalid property name`);
    }
    const item = feature.properties[key];
    if (budget.allowNestedProperties) {
      validatePropertyValue(item, budget, 0);
      continue;
    }
    if (item !== null && typeof item !== "boolean" && typeof item !== "string" && typeof item !== "number") {
      fail("invalid_geojson", `Archive feature ${index + 1} contains a non-scalar property`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid_geojson", `Archive feature ${index + 1} contains a non-finite number`);
    if (typeof item === "string" && item.length > MAXIMUM_PROPERTY_STRING_LENGTH) fail("invalid_geojson", `Archive feature ${index + 1} contains an oversized string`);
  }
}

// Managed originals can carry provider relations as nested RFC 7946 properties.
// Preserve them as data; bound traversal and reject unsafe names at every depth.
function validatePropertyValue(value, budget, depth) {
  if (++budget.propertyNodes > 400000 || depth > 8) fail("invalid_geojson", "Archive properties exceed their nesting or node limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string" && value.length <= MAXIMUM_PROPERTY_STRING_LENGTH) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 4096) {
    for (const item of value) validatePropertyValue(item, budget, depth + 1);
    return;
  }
  if (plainObject(value) && Object.keys(value).length <= MAXIMUM_PROPERTY_FIELDS) {
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key.toLowerCase())) fail("invalid_geojson", "Archive property name is invalid");
      validatePropertyValue(item, budget, depth + 1);
    }
    return;
  }
  fail("invalid_geojson", "Archive property value exceeds its supported bounds");
}

function validateCoordinates(value, depth, budget) {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_geojson", "Archive geometry coordinates are invalid");
  if (depth === 0) {
    if (value.length < 2 || value.length > 3 || value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
      || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
      fail("invalid_geojson", "Archive coordinate is outside WGS84");
    }
    budget.positions += 1;
    if (budget.positions > MAXIMUM_COORDINATE_POSITIONS) fail("invalid_geojson", "Archive coordinate inventory is too large");
    return;
  }
  value.forEach((child) => validateCoordinates(child, depth - 1, budget));
}

function coordinateDepth(type) {
  return {Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3}[type];
}

function geometryFamily(type) {
  if (type.includes("Point")) return "point";
  if (type.includes("LineString")) return "line";
  return "polygon";
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) fail("checksum_unavailable", "Archive checksum support is unavailable");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validBounds(value) {
  return Array.isArray(value) && value.length === 4
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
    && value[0] >= -180 && value[0] < value[2] && value[2] <= 180
    && value[1] >= -90 && value[1] < value[3] && value[3] <= 90;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code, message) {
  throw new ArchivedGeojsonError(code, message);
}
