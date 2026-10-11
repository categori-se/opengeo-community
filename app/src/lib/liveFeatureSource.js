export const LIVE_FEATURE_SOURCE_LIMITS = Object.freeze({
  maximumBytes: 8_388_608,
  maximumFeatures: 2_000,
  maximumFields: 64,
  maximumPositions: 200_000,
  maximumPropertyNodes: 100_000,
  timeoutMilliseconds: 20_000
});

const GEOMETRY_TYPES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]);
const ROOT_MEMBERS = new Set([
  "type", "name", "bbox", "crs", "features", "totalFeatures", "numberMatched",
  "numberReturned", "timeStamp", "exceededTransferLimit", "properties"
]);

export class LiveFeatureSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveFeatureSourceError";
    this.code = code;
  }
}

/**
 * Read one anonymous visible-extent page directly in the browser. The result
 * is a bounded display page, never a protected copy or completeness claim.
 */
export async function loadLiveFeaturePage({
  sourceType,
  url,
  configuration,
  bounds,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal,
  arcgisMetadata = null,
  timeoutMilliseconds = LIVE_FEATURE_SOURCE_LIMITS.timeoutMilliseconds
}) {
  const request = buildLiveFeatureRequest({sourceType, url, configuration, bounds});
  if (typeof fetchImpl !== "function") fail("fetch_unavailable", "Live feature fetch support is unavailable");
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 60_000) {
    fail("invalid_contract", "Live feature timeout is outside the supported range");
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener?.("abort", abortFromCaller, {once: true});
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);

  let requestCount = 0, remainingBytes = LIVE_FEATURE_SOURCE_LIMITS.maximumBytes;
  async function read(url, limit = remainingBytes, allowQueryError = false, form = null) {
    controller.signal.throwIfAborted();
    if (++requestCount > 4 || remainingBytes <= 0) fail("response_too_large", "Live feature request budget exhausted");
    const response = await fetchImpl(url, {
      method: form === null ? "GET" : "POST",
      headers: {accept: "application/geo+json, application/json;q=0.9",
        ...(form === null ? {} : {"content-type": "application/x-www-form-urlencoded"})},
      ...(form === null ? {} : {body: form}),
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal
    });
    if (!response || !Number.isInteger(response.status) || (response.status !== 200 && !(allowQueryError && response.status === 400))) {
      fail("source_unavailable", `Live feature request failed with HTTP ${response?.status ?? "unknown"}`);
    }
    if (response.redirected === true || (response.url && response.url !== url)) {
      fail("redirect_rejected", "Live feature response URL did not match the governed request");
    }
    validateContentType(response);
    const body = await readBoundedBody(response, Math.min(limit, remainingBytes));
    remainingBytes -= body.byteLength;
    return body;
  }
  const json = body => {
    try {return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(body));}
    catch {fail("response_invalid", "Live source returned invalid JSON");}
  };
  try {
    let parsed;
    if (sourceType === "arcgis" && arcgisMetadata?.advancedQueryCapabilities?.supportsPagination === false) {
      parsed = await arcgisIdPage(request, arcgisMetadata, async (url, limit, form) => json(await read(url, limit, false, form)));
    } else {
      const body = await read(request.url, remainingBytes, sourceType === "arcgis");
      const value = sourceType === "arcgis" ? json(body) : null;
      if (value?.error?.code === 400) {
        const metadata = json(await read(`${publicFeatureEndpoint(url, sourceType)}?f=json`, 524288));
        parsed = await arcgisIdPage(request, metadata, async (url, limit, form) => json(await read(url, limit, false, form)));
      } else {
        parsed = parseLiveFeatureCollection(body, request.contract);
      }
    }
    const numberReturned = parsed.collection.features.length;
    const numberMatched = parsed.provider.numberMatched ?? parsed.provider.totalFeatures;
    const mayBeTruncated = parsed.provider.exceededTransferLimit === true
      || (numberMatched !== null && numberMatched > numberReturned)
      || numberReturned >= request.contract.pageSize;
    Object.defineProperty(parsed.collection, "opengeo", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        schemaVersion: "opengeo.live-feature-page.1.0.0",
        sourceType: request.contract.sourceType,
        sourceMode: "anonymous-direct-browser",
        bounds: Object.freeze([...request.contract.bounds]),
        numberReturned,
        numberMatched,
        mayBeTruncated,
        requestCount,
        maximumBytes: LIVE_FEATURE_SOURCE_LIMITS.maximumBytes,
        maximumFeatures: request.contract.pageSize
      })
    });
    return parsed.collection;
  } catch (error) {
    if (error instanceof LiveFeatureSourceError) throw error;
    if (controller.signal.aborted) {
      fail(signal?.aborted ? "request_cancelled" : "request_timeout", signal?.aborted
        ? "Live feature request was cancelled"
        : "Live feature request timed out");
    }
    fail("source_unavailable", "Live feature data could not be loaded", error);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abortFromCaller);
  }
}

async function arcgisIdPage(request, metadata, read) {
  const {contract} = request;
  if (metadata?.advancedQueryCapabilities?.supportsPagination !== false
    || !metadata.fields?.some(field => field.name === contract.identityField && field.type === "esriFieldTypeOID")
    || !contract.fields.every(name => metadata.fields.some(field => field.name === name))) {
    fail("response_invalid", "Provider does not establish a compatible non-paginated query");
  }
  const query = new URL(request.url);
  for (const key of ["orderByFields", "resultOffset", "resultRecordCount", "returnExceededLimitFeatures"]) query.searchParams.delete(key);
  const idsUrl = new URL(query);
  idsUrl.searchParams.set("f", "json");
  idsUrl.searchParams.set("returnIdsOnly", "true");
  idsUrl.searchParams.delete("outFields");
  idsUrl.searchParams.delete("returnGeometry");
  const inventory = await read(idsUrl.href, 2097152);
  const ids = inventory?.objectIds;
  if (inventory.error || inventory.exceededTransferLimit === true || !Array.isArray(ids)
    || inventory.objectIdFieldName !== contract.identityField || ids.length > 50000
    || ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length) {
    fail("response_invalid", "Provider ID inventory is invalid or too large; narrow the map view");
  }
  const selected = ids.sort((a, b) => a - b).slice(0, contract.pageSize);
  const value = selected.length ? await (() => {
    query.searchParams.set("objectIds", selected.join(","));
    const [west, south, east, north] = contract.bounds;
    query.searchParams.set("maxAllowableOffset", String(Math.max(1e-7, Math.min(0.05, Math.max(east - west, north - south) / 1600))));
    query.searchParams.set("geometryPrecision", "6");
    return query.href.length <= 1800
      ? read(query.href, LIVE_FEATURE_SOURCE_LIMITS.maximumBytes)
      : read(`${query.origin}${query.pathname}`, LIVE_FEATURE_SOURCE_LIMITS.maximumBytes, query.searchParams.toString());
  })() : {type: "FeatureCollection", features: []};
  const parsed = parseLiveFeatureCollection(JSON.stringify(value), contract);
  const actual = parsed.collection.features.map(feature => feature.properties[contract.identityField]).sort((a, b) => a - b);
  if (actual.length !== selected.length || actual.some((id, index) => id !== selected[index])) {
    fail("response_invalid", "Provider returned different features from the selected IDs");
  }
  parsed.provider.numberMatched = ids.length;
  parsed.provider.exceededTransferLimit = ids.length > selected.length;
  return parsed;
}

export function buildLiveFeatureRequest({sourceType, url, configuration, bounds}) {
  const endpoint = publicFeatureEndpoint(url, sourceType);
  const contract = featureContract(sourceType, configuration, bounds);
  const parameters = sourceType === "arcgis"
    ? new URLSearchParams([
        ["f", "geojson"],
        ["where", "1=1"],
        ["geometry", contract.bounds.join(",")],
        ["geometryType", "esriGeometryEnvelope"],
        ["inSR", "4326"],
        ["spatialRel", "esriSpatialRelIntersects"],
        ["outSR", "4326"],
        ["outFields", contract.fields.join(",")],
        ["orderByFields", `${contract.identityField} ASC`],
        ["resultOffset", "0"],
        ["resultRecordCount", String(contract.pageSize)],
        ["returnGeometry", "true"],
        ["returnExceededLimitFeatures", "true"]
      ])
    : new URLSearchParams([
        ["SERVICE", "WFS"],
        ["VERSION", "2.0.0"],
        ["REQUEST", "GetFeature"],
        ["TYPENAMES", contract.typeName],
        ["SRSNAME", "urn:ogc:def:crs:OGC::CRS84"],
        ["BBOX", `${contract.bounds.join(",")},urn:ogc:def:crs:OGC::CRS84`],
        ["COUNT", String(contract.pageSize)],
        ["STARTINDEX", "0"],
        ["SORTBY", `${contract.identityField} A`],
        ["OUTPUTFORMAT", "application/json"],
        ["PROPERTYNAME", [contract.geometryName, ...contract.fields].join(",")]
      ]);
  return {
    url: `${endpoint}${sourceType === "arcgis" ? "/query" : ""}?${parameters}`,
    contract
  };
}

export function parseLiveFeatureCollection(body, contract) {
  let value;
  try {
    const text = typeof body === "string"
      ? body
      : new TextDecoder("utf-8", {fatal: true}).decode(body);
    value = JSON.parse(text);
  } catch (error) {
    fail("response_invalid", "Live feature response is not valid UTF-8 JSON", error);
  }
  if (!plainObject(value)
    || value.type !== "FeatureCollection"
    || Object.keys(value).some((key) => !ROOT_MEMBERS.has(key))
    || !Array.isArray(value.features)
    || value.features.length > contract.pageSize
    || value.features.length > LIVE_FEATURE_SOURCE_LIMITS.maximumFeatures) {
    fail("response_invalid", "Live feature response is not a bounded FeatureCollection");
  }
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 1_000)) {
    fail("response_invalid", "Live feature collection name is invalid");
  }
  if (value.timeStamp !== undefined && (typeof value.timeStamp !== "string" || value.timeStamp.length > 100)) {
    fail("response_invalid", "Live feature timestamp is invalid");
  }
  if (value.exceededTransferLimit !== undefined && typeof value.exceededTransferLimit !== "boolean") {
    fail("response_invalid", "Live feature transfer-limit metadata is invalid");
  }
  // ArcGIS can place collection-level transfer metadata in this foreign member.
  // Keep its shape bounded and reject conflicting truncation claims.
  if (value.properties !== undefined && (!plainObject(value.properties)
    || Object.keys(value.properties).some(key => key !== "exceededTransferLimit")
    || (value.properties.exceededTransferLimit !== undefined
      && typeof value.properties.exceededTransferLimit !== "boolean"))) {
    fail("response_invalid", "Live feature collection properties are invalid");
  }
  const nestedLimit = value.properties?.exceededTransferLimit;
  if (nestedLimit !== undefined && value.exceededTransferLimit !== undefined
    && nestedLimit !== value.exceededTransferLimit) {
    fail("response_invalid", "Live feature transfer-limit metadata conflicts");
  }
  if (value.bbox !== undefined) validateProviderBounds(value.bbox);
  if (value.crs !== undefined) validateCrs(value.crs);

  const budget = {positions: 0, propertyNodes: 0};
  const identities = new Set();
  const features = value.features.map((feature) => normalizeFeature(feature, contract, budget, identities));
  const provider = {
    totalFeatures: providerCount(value.totalFeatures, "totalFeatures"),
    numberMatched: providerCount(value.numberMatched, "numberMatched"),
    numberReturned: providerCount(value.numberReturned, "numberReturned"),
    exceededTransferLimit: (value.exceededTransferLimit ?? nestedLimit) === true
  };
  if (provider.numberReturned !== null && provider.numberReturned !== features.length) {
    fail("response_invalid", "Live feature returned-count metadata does not match the response");
  }
  for (const count of [provider.totalFeatures, provider.numberMatched]) {
    if (count !== null && count < features.length) {
      fail("response_invalid", "Live feature matched-count metadata is inconsistent");
    }
  }
  return {collection: {type: "FeatureCollection", features}, provider};
}

function normalizeFeature(value, contract, budget, identities) {
  // ArcGIS emits single-part Polygon/LineString/Point GeoJSON even when the
  // declared collection allows multipart features. Promote, never flatten.
  const promote = contract.geometryType.startsWith("Multi") && plainObject(value?.geometry)
    && {MultiPolygon: "Polygon", MultiLineString: "LineString", MultiPoint: "Point"}[contract.geometryType] === value.geometry.type;
  if (!plainObject(value)
    || value.type !== "Feature"
    || !plainObject(value.properties)
    || !plainObject(value.geometry)
    || (value.geometry.type !== contract.geometryType && !promote)
    || Object.keys(value.geometry).some((key) => !["type", "coordinates", "bbox", "crs"].includes(key))
    || Object.keys(value).some((key) => !["type", "id", "bbox", "geometry", "properties"].includes(key))
    || Object.keys(value.properties).some((key) => !contract.fields.includes(key))
    || !Object.hasOwn(value.properties, contract.identityField)) {
    fail("response_invalid", "Live feature shape does not match the governed source revision");
  }
  if (value.bbox !== undefined) validateProviderBounds(value.bbox);
  if (value.geometry.bbox !== undefined) validateProviderBounds(value.geometry.bbox);
  // ArcGIS's explicitly requested outSR=4326 responses may carry crs:null.
  // Any concrete CRS still has to establish WGS84 before normalization.
  if (value.geometry.crs !== undefined && value.geometry.crs !== null) validateCrs(value.geometry.crs);
  if (value.geometry.crs === null && contract.sourceType !== "arcgis") {
    fail("response_invalid", "Live feature geometry CRS is unspecified");
  }
  const identityValue = value.properties[contract.identityField];
  if (typeof identityValue === "boolean"
    || !["string", "number"].includes(typeof identityValue)
    || (typeof identityValue === "number" && !Number.isFinite(identityValue))
    || (typeof identityValue === "string" && (!identityValue.length || identityValue.length > 512 || identityValue.includes("\0")))) {
    fail("response_invalid", "Live feature identity is invalid");
  }
  const identity = `${typeof identityValue}:${String(identityValue)}`;
  if (identities.has(identity)) fail("response_invalid", "Live feature identities are not unique");
  identities.add(identity);
  if (Object.hasOwn(value, "id") && !validFeatureId(value.id)) {
    fail("response_invalid", "Live feature id is invalid");
  }

  const properties = {};
  for (const field of contract.fields) {
    if (!Object.hasOwn(value.properties, field)) continue;
    validatePropertyValue(value.properties[field], budget, 0);
    properties[field] = structuredClone(value.properties[field]);
  }
  const coordinates = promote ? [value.geometry.coordinates] : value.geometry.coordinates;
  validateCoordinates(coordinates, contract.geometryType, budget);
  return {
    type: "Feature",
    ...(Object.hasOwn(value, "id") ? {id: value.id} : {}),
    properties,
    geometry: {
      type: contract.geometryType,
      coordinates: structuredClone(coordinates)
    }
  };
}

function featureContract(sourceType, value, bounds) {
  if (!plainObject(value) || !["arcgis", "wfs"].includes(sourceType)) {
    fail("invalid_contract", "Live feature source contract is invalid");
  }
  const expected = sourceType === "arcgis"
    ? ["attribution", "fields", "geometryType", "objectIdField", "pageSize"]
    : ["attribution", "fields", "geometryName", "geometryType", "pageSize", "sortBy", "typeName", "version"];
  if (!exactKeys(value, expected)) fail("invalid_contract", "Live feature source has unexpected fields");
  const fields = sourceFields(value.fields);
  const geometryType = GEOMETRY_TYPES.has(value.geometryType) ? value.geometryType : null;
  const pageMaximum = sourceType === "arcgis" ? 2_000 : 1_000;
  if (!geometryType || !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > pageMaximum) {
    fail("invalid_contract", "Live feature geometry or page size is invalid");
  }
  if (value.attribution !== null
    && (typeof value.attribution !== "string" || !value.attribution.length || value.attribution.length > 1_000)) {
    fail("invalid_contract", "Live feature attribution is invalid");
  }
  const normalizedBounds = validateRequestBounds(bounds);
  if (sourceType === "arcgis") {
    const identityField = ogcName(value.objectIdField);
    if (!identityField || !fields.includes(identityField)) {
      fail("invalid_contract", "ArcGIS identity field is not selected");
    }
    return {sourceType, fields, geometryType, pageSize: value.pageSize, identityField, bounds: normalizedBounds};
  }
  const identityField = ogcName(value.sortBy);
  const geometryName = ogcName(value.geometryName);
  const typeName = ogcName(value.typeName);
  if (value.version !== "2.0.0" || !identityField || !geometryName || !typeName
    || !fields.includes(identityField) || fields.includes(geometryName)) {
    fail("invalid_contract", "WFS collection identity is invalid");
  }
  return {
    sourceType,
    fields,
    geometryType,
    pageSize: value.pageSize,
    identityField,
    geometryName,
    typeName,
    bounds: normalizedBounds
  };
}

function publicFeatureEndpoint(value, sourceType) {
  if (!["arcgis", "wfs"].includes(sourceType)
    || typeof value !== "string" || value.length > 2_048 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    fail("invalid_contract", "Live feature endpoint is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail("invalid_contract", "Live feature endpoint is invalid", error);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || (parsed.port && parsed.port !== "443") || parsed.search || parsed.hash || !hostname
    || hostname === "localhost" || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
    || hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) {
    fail("invalid_contract", "Live feature endpoint must be query-free public HTTPS");
  }
  if (sourceType === "arcgis"
    && !/(?:\/FeatureServer|\/MapServer)\/[0-9]{1,5}\/?$/.test(parsed.pathname)) {
    fail("invalid_contract", "ArcGIS endpoint must identify one layer");
  }
  return parsed.href.replace(/\/$/, "");
}

async function readBoundedBody(response, maximumBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    if (!/^\d+$/.test(contentLength)) fail("response_invalid", "Live feature content length is invalid");
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maximumBytes) {
      fail("response_too_large", "Live feature response exceeds the byte limit");
    }
  }
  if (!response.body?.getReader) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) fail("response_too_large", "Live feature response exceeds the byte limit");
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail("response_invalid", "Live feature response stream is invalid");
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      fail("response_too_large", "Live feature response exceeds the byte limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validateContentType(response) {
  const contentType = response.headers?.get?.("content-type");
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (!["application/geo+json", "application/json"].includes(mediaType)) {
    fail("response_media_rejected", "Live feature response is not JSON or GeoJSON");
  }
}

function validateCoordinates(value, geometryType, budget) {
  const position = (node) => {
    if (!Array.isArray(node) || ![2, 3, 4].includes(node.length)
      || !node.every((item) => typeof item === "number" && Number.isFinite(item))
      || node[0] < -180 || node[0] > 180 || node[1] < -90 || node[1] > 90) {
      fail("response_invalid", "Live feature coordinate is outside WGS84");
    }
    budget.positions += 1;
    if (budget.positions > LIVE_FEATURE_SOURCE_LIMITS.maximumPositions) {
      fail("response_too_large", "Live feature response has too many positions");
    }
  };
  const positions = (node, minimum) => {
    if (!Array.isArray(node) || node.length < minimum) fail("response_invalid", "Live feature coordinates are invalid");
    node.forEach(position);
  };
  const line = (node) => positions(node, 2);
  const ring = (node) => {
    positions(node, 4);
    if (node[0][0] !== node.at(-1)[0] || node[0][1] !== node.at(-1)[1]) {
      fail("response_invalid", "Live feature polygon ring is not closed");
    }
  };
  const nested = (node, validator) => {
    if (!Array.isArray(node) || !node.length) fail("response_invalid", "Live feature coordinates are invalid");
    node.forEach(validator);
  };
  if (geometryType === "Point") position(value);
  else if (geometryType === "MultiPoint") positions(value, 1);
  else if (geometryType === "LineString") line(value);
  else if (geometryType === "MultiLineString") nested(value, line);
  else if (geometryType === "Polygon") nested(value, ring);
  else if (geometryType === "MultiPolygon") nested(value, (polygon) => nested(polygon, ring));
}

function validatePropertyValue(value, budget, depth) {
  budget.propertyNodes += 1;
  if (budget.propertyNodes > LIVE_FEATURE_SOURCE_LIMITS.maximumPropertyNodes || depth > 8) {
    fail("response_too_large", "Live feature properties are too complex");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 8_192 && !value.includes("\0")) return;
  if (Array.isArray(value) && value.length <= 1_024) {
    value.forEach((item) => validatePropertyValue(item, budget, depth + 1));
    return;
  }
  if (plainObject(value) && Object.keys(value).length <= 256) {
    for (const [key, item] of Object.entries(value)) {
      if (!key.length || key.length > 256 || key.includes("\0")) {
        fail("response_invalid", "Live feature property name is invalid");
      }
      validatePropertyValue(item, budget, depth + 1);
    }
    return;
  }
  fail("response_invalid", "Live feature property is invalid");
}

function sourceFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > LIVE_FEATURE_SOURCE_LIMITS.maximumFields) {
    fail("invalid_contract", "Live feature field selection is invalid");
  }
  const fields = value.map(ogcName);
  if (fields.some((field) => field === null) || new Set(fields).size !== fields.length) {
    fail("invalid_contract", "Live feature field selection is invalid");
  }
  return fields;
}

function validateRequestBounds(value) {
  if (!Array.isArray(value) || value.length !== 4
    || !value.every((item) => typeof item === "number" && Number.isFinite(item))
    || value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90
    || value[0] >= value[2] || value[1] >= value[3]) {
    fail("invalid_contract", "Live feature extent is invalid");
  }
  return value.map((item) => Number(item.toFixed(6)));
}

function validateProviderBounds(value) {
  if (!Array.isArray(value) || ![4, 6].includes(value.length)
    || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    fail("response_invalid", "Live feature response extent is invalid");
  }
  const [west, south] = value;
  const east = value.length === 4 ? value[2] : value[3];
  const north = value.length === 4 ? value[3] : value[4];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) {
    fail("response_invalid", "Live feature response extent is outside WGS84");
  }
}

function validateCrs(value) {
  if (typeof value === "string") {
    if (!["EPSG:4326", "urn:ogc:def:crs:OGC::CRS84", "CRS84"].includes(value)) {
      fail("response_invalid", "Live feature response CRS is not WGS84");
    }
    return;
  }
  if (!plainObject(value) || value.type !== "name" || !plainObject(value.properties)
    || !exactKeys(value, ["type", "properties"]) || !exactKeys(value.properties, ["name"])
    || !["EPSG:4326", "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC::CRS84", "CRS84"]
      .includes(value.properties.name)) {
    fail("response_invalid", "Live feature response CRS is not WGS84");
  }
}

function providerCount(value, field) {
  if (value === undefined || value === null || value === "unknown") return null;
  const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) {
    fail("response_invalid", `Live feature ${field} metadata is invalid`);
  }
  return count;
}

function validFeatureId(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))
    || (typeof value === "number" && Number.isFinite(value));
}

function ogcName(value) {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code, message, cause) {
  const error = new LiveFeatureSourceError(code, message);
  if (cause !== undefined) error.cause = cause;
  throw error;
}
