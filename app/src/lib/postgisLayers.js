import {captureExternalDatabaseScope} from "./externalDatabaseCatalog.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
function fail() {throw Object.assign(new Error("Invalid private Layer response"), {code: "invalid_api_response"});}
function object(value) {return value && typeof value === "object" && !Array.isArray(value) ? value : fail();}
function exact(value, keys) {const row = object(value); if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail(); return row;}
function id(value) {return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : fail();}
function positive(value) {return Number.isSafeInteger(value) && value > 0 ? value : fail();}
function identifier(value) {return typeof value === "string" && value.length && encoder.encode(value).length <= 63 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail();}
function sha(value) {return typeof value === "string" && SHA.test(value) ? value : fail();}
export function postgisBounds(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n))
    || value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90
    || value[0] >= value[2] || value[1] >= value[3]) fail();
  return [...value];
}

export function parsePostgisConfiguration(value) {
  const row = exact(value, ["service_kind", "connection_id", "connection_revision_number", "catalog_discovery_id",
    "catalog_relation_ordinal", "schema_name", "relation_name", "schema_fingerprint_sha256", "geometry_column", "stable_key"]);
  if (row.service_kind !== "postgis" || !Number.isInteger(row.catalog_relation_ordinal) || row.catalog_relation_ordinal < 1 || row.catalog_relation_ordinal > 100) fail();
  return {serviceKind: "postgis", connectionId: id(row.connection_id), connectionRevision: positive(row.connection_revision_number),
    discoveryId: id(row.catalog_discovery_id), relationOrdinal: row.catalog_relation_ordinal,
    schema: identifier(row.schema_name), relation: identifier(row.relation_name), fingerprint: sha(row.schema_fingerprint_sha256),
    geometryColumn: identifier(row.geometry_column), stableKey: identifier(row.stable_key)};
}

export function postgisSourceIdentity(value, configuration) {
  const config = configuration.serviceKind === "postgis" ? configuration : parsePostgisConfiguration(configuration);
  const expected = `urn:opengeo:postgis:${config.connectionId}:${config.discoveryId}:${config.relationOrdinal}`;
  return value === expected ? value : fail();
}

export function parsePostgisRegistration(value) {
  const row = exact(value, ["dataset_id", "source_version", "created"]);
  if (typeof row.created !== "boolean") fail();
  return {datasetId: id(row.dataset_id), sourceVersion: positive(row.source_version), created: row.created};
}

export function parsePostgisPreview(value, expected = {}) {
  const row = exact(value, ["schemaVersion", "previewId", "datasetId", "sourceVersion", "connectionRevision", "schemaFingerprint",
    "observedAt", "bbox", "limit", "returned", "truncated", "geojson", "propertyEncodings"]);
  if (row.schemaVersion !== "opengeo.postgis-preview.1.0.0" || row.limit !== 100 || typeof row.truncated !== "boolean"
    || !Number.isInteger(row.returned) || row.returned < 0 || row.returned > 100
    || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))
    || encoder.encode(JSON.stringify(row)).length > 256 * 1024) fail();
  id(row.previewId); id(row.datasetId); positive(row.sourceVersion); positive(row.connectionRevision); sha(row.schemaFingerprint);
  const bbox = postgisBounds(row.bbox);
  for (const key of ["datasetId", "sourceVersion", "connectionRevision", "schemaFingerprint"]) {
    if (expected[key] != null && row[key] !== expected[key]) fail();
  }
  if (expected.bbox && bbox.some((n, i) => n !== expected.bbox[i])) fail();
  for (const [column, encoding] of Object.entries(object(row.propertyEncodings))) {
    identifier(column); if (!["int64:string", "numeric:string"].includes(encoding)) fail();
  }
  const collection = exact(row.geojson, ["type", "features"]);
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features) || collection.features.length !== row.returned) fail();
  const ids = new Set(); let positions = 0;
  const depths = {Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3};
  function coordinates(value, depth) {
    if (!Array.isArray(value) || !value.length) fail();
    if (depth) {for (const child of value) coordinates(child, depth - 1); return;}
    if (value.length !== 2 || !value.every(Number.isFinite) || value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90 || ++positions > 10000) fail();
  }
  for (const feature of collection.features) {
    exact(feature, ["type", "id", "geometry", "properties"]);
    if (feature.type !== "Feature" || typeof feature.id !== "string" || ids.has(feature.id)) fail();
    ids.add(feature.id);
    for (const [column, item] of Object.entries(object(feature.properties))) {
      identifier(column);
      if (item !== null && !["string", "boolean", "number"].includes(typeof item)) fail();
      if (typeof item === "number" && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) fail();
      const encoding = row.propertyEncodings[column];
      if (encoding && item !== null && (typeof item !== "string" || !(encoding === "int64:string" ? /^-?\d+$/ : /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).test(item))) fail();
    }
    const geometry = exact(feature.geometry, ["type", "coordinates"]);
    if (!Object.hasOwn(depths, geometry.type)) fail();
    coordinates(geometry.coordinates, depths[geometry.type]);
  }
  return row;
}

// The broker is an authenticated application endpoint. Source URNs are never fetched.
export function postgisLayerApi(client) {
  return {async register(projectId, connectionId, discoveryId, ordinal, draft, {context = null, signal, requestKey = globalThis.crypto.randomUUID()} = {}) {
    const scope = context ?? await captureExternalDatabaseScope(client);
    const project = id(projectId), connection = id(connectionId), discovery = id(discoveryId), key = id(requestKey);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 100 || typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 200) fail();
    await client.assertCollectionContext(scope);
    const value = await client.request(`/projects/${project}/connections/${connection}/catalog-discoveries/${discovery}/relations/${ordinal}/layers`, {
      method: "POST", body: {expected_connection_revision: positive(draft.connectionRevision), schema_fingerprint_sha256: sha(draft.fingerprint),
        geometry_column: identifier(draft.geometryColumn), name: draft.name.trim(), description: draft.description ?? null,
        ...(draft.expectedSourceVersion != null ? {expected_source_version: positive(draft.expectedSourceVersion)} : {}), request_key: key}, signal,
      ...client.collectionRequestOptions(scope.organization, scope)
    });
    await client.assertCollectionContext(scope);
    signal?.throwIfAborted();
    return parsePostgisRegistration(value);
  }, async preview(datasetId, sourceVersion, bbox, {context = null, signal, requestKey = globalThis.crypto.randomUUID(), connectionRevision, schemaFingerprint} = {}) {
    const scope = context ?? await captureExternalDatabaseScope(client);
    const dataset = id(datasetId), version = positive(sourceVersion), bounds = postgisBounds(bbox), key = id(requestKey);
    await client.assertCollectionContext(scope);
    const value = await client.request(`/datasets/${dataset}/postgis-preview`, {
      method: "POST", body: {expected_source_version: version, request_key: key, bbox: bounds}, signal,
      ...client.collectionRequestOptions(scope.organization, scope)
    });
    await client.assertCollectionContext(scope);
    signal?.throwIfAborted();
    return parsePostgisPreview(value, {datasetId: dataset, sourceVersion: version, bbox: bounds, connectionRevision, schemaFingerprint});
  }};
}
