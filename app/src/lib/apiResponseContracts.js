/** Shared API response contracts. This module has no request, session or runtime dependencies. */

export class ApiClientError extends Error {
  constructor(message, {status = 0, code = "request_failed", requestId = null, currentVersion = null, currentDraftRevision = null, cause} = {}) {
    super(message, {cause});
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.currentVersion = currentVersion;
    this.currentDraftRevision = currentDraftRevision;
    this.retryable = status === 0 || status === 429 || [502, 503, 504].includes(status);
  }
}

export class ApiContractError extends ApiClientError {
  constructor(message, options = {}) {
    super(message, {...options, code: "invalid_api_response"});
    this.name = "ApiContractError";
  }
}

export function boundedStringArray(value, maximumItems, maximumLength, label) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    contract(`${label} is invalid`);
  }
  return value.map((entry) => boundedString(entry, maximumLength, label));
}

export function uniqueBoundedStringArray(value, maximumItems, maximumLength, label) {
  const result = boundedStringArray(value, maximumItems, maximumLength, label);
  if (new Set(result).size !== result.length) contract(`${label} contains duplicates`);
  return result;
}

export function exactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    contract(`${label} has unexpected fields`);
  }
}

export function decimalBetween(value, minimum, maximum, label) {
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)
    ? Number(value)
    : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)
    || parsed < minimum || parsed > maximum) contract(`${label} is invalid`);
  return parsed;
}

export function integerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) contract(`${label} is invalid`);
  return value;
}

export function sha256(value, label) {
  const digest = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) contract(`${label} is invalid`);
  return digest;
}

export function sha256Checksum(value, label) {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

export async function responsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ApiContractError("The API returned invalid JSON", {
      status: response.status,
      requestId: response.headers.get("X-Request-ID"),
      cause
    });
  }
}

export function apiResponseError(response, payload) {
  const detail = isObject(payload) ? payload.detail : null;
  const code = typeof detail === "string"
    ? detail
    : isObject(detail) && typeof detail.code === "string"
      ? detail.code
      : `http_${response.status}`;
  const currentVersion = isObject(detail) && Number.isSafeInteger(detail.current_version)
    ? detail.current_version
    : null;
  const currentDraftRevision = isObject(detail)
    && Number.isSafeInteger(detail.current_draft_revision)
    ? detail.current_draft_revision
    : null;
  return new ApiClientError(`API request failed with status ${response.status}`, {
    status: response.status,
    code,
    requestId: response.headers.get("X-Request-ID"),
    currentVersion,
    currentDraftRevision
  });
}

export function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(value, label) {
  try {
    return assertUuid(value, label);
  } catch (cause) {
    contract(`${label} is invalid`, cause);
  }
}

export function nullableUuid(value, label) {
  return value === null ? null : uuid(value, label);
}

export function string(value, label) {
  if (typeof value !== "string" || !value.trim()) contract(`${label} is invalid`);
  return value;
}

export function boundedString(value, maximum, label) {
  const result = string(value, label);
  if (result.length > maximum) contract(`${label} is too large`);
  return result;
}

export function boundedUtf8String(value, maximumBytes, label) {
  const result = string(value, label);
  if (new TextEncoder().encode(result).byteLength > maximumBytes) {
    contract(`${label} is too large`);
  }
  return result;
}

export function boolean(value, label) {
  if (typeof value !== "boolean") contract(`${label} is invalid`);
  return value;
}

export function nullableString(value, label) {
  return value === null ? null : string(value, label);
}

export function nullableBoundedString(value, maximum, label) {
  return value === null ? null : boundedString(value, maximum, label);
}

export function timestamp(value, label) {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) contract(`${label} is invalid`);
  return result;
}

export function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) contract(`${label} is invalid`);
  return value;
}

export function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) contract(`${label} is invalid`);
  return value;
}

export function nullablePositiveInteger(value, label) {
  return value === null ? null : positiveInteger(value, label);
}

export function nullableNonNegativeInteger(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) contract(`${label} is invalid`);
  return value;
}

export function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) contract(`${label} is invalid`);
  return value;
}

export function oneOf(value, choices, label) {
  if (!choices.includes(value)) contract(`${label} is invalid`);
  return value;
}

export function machineCode(value, label) {
  const result = string(value, label);
  if (result.length > 100 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(result)) {
    contract(`${label} is invalid`);
  }
  return result;
}

export function languageTag(value, label) {
  const result = string(value, label).trim().toLowerCase();
  if (result.length > 40 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(result)) {
    contract(`${label} is invalid`);
  }
  return result;
}

export function object(value, label) {
  if (!isObject(value)) contract(`${label} must be an object`);
  return value;
}

export function boundedObject(value, maximumBytes, label) {
  const record = object(value, label);
  let encoded;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(record));
  } catch (cause) {
    contract(`${label} is not JSON serializable`, cause);
  }
  if (encoded.byteLength > maximumBytes) contract(`${label} is too large`);
  return structuredClone(record);
}

export function parseArray(value, parser, label) {
  if (!Array.isArray(value)) contract(`${label} must be an array`);
  return value.map(parser);
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function contract(message, cause) {
  throw new ApiContractError(message, {cause});
}

export function publicSourceUrl(value, sourceType) {
  const raw = string(value, "external source.source_url");
  if (raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) contract("external source.source_url is invalid");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    contract("external source.source_url is invalid", cause);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || parsed.hash
    || !hostname
    || hostname === "localhost"
    || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
    || hostname.includes(":")
    || /^\d+(?:\.\d+){3}$/.test(hostname)
  ) {
    contract("external source.source_url is not an allowed public HTTPS URL");
  }
  if (["wms", "arcgis", "wfs", "imageserver", "mapserver", "cog"].includes(sourceType) && parsed.search) {
    contract(`${sourceType.toUpperCase()} source URL must not contain a query`);
  }
  if (sourceType === "cog" && !/\.tiff?$/i.test(parsed.pathname)) contract("COG source URL must name a TIFF object");
  if (sourceType === "arcgis" && !/\/(?:FeatureServer|MapServer)\/[0-9]{1,5}\/?$/.test(parsed.pathname)) {
    contract("ArcGIS source URL must identify one FeatureServer or MapServer layer");
  }
  if (sourceType === "mapserver" && !/\/MapServer\/?$/.test(parsed.pathname)) {
    contract("Use a MapServer service endpoint");
  }
  if (sourceType === "imageserver" && !/\/ImageServer\/?$/.test(parsed.pathname)) {
    contract("ImageServer source URL must identify an image service, not an operation");
  }
  if (sourceType === "pmtiles" && (parsed.search || !parsed.pathname.toLowerCase().endsWith(".pmtiles"))) {
    contract("PMTiles source URL must name a query-free .pmtiles object");
  }
  if (sourceType === "geojson" && (
    parsed.search
    || !parsed.pathname.toLowerCase().endsWith(".geojson")
      && !parsed.pathname.toLowerCase().endsWith(".geojson.gz")
  )) {
    contract("GeoJSON source URL must name a query-free .geojson or .geojson.gz object");
  }
  if (sourceType === "xyz") {
    const placeholders = [...raw.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (placeholders.length !== 3 || new Set(placeholders).size !== 3 || !["z", "x", "y"].every((name) => placeholders.includes(name))) {
      contract("XYZ source URL placeholders are invalid");
    }
  }
  return raw;
}
