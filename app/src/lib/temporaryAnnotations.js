export const TEMPORARY_WORK_SCHEMA_VERSION = "1.0.0";

export const TEMPORARY_WORK_LIMITS = Object.freeze({
  maximumLayers: 12,
  maximumFeaturesPerLayer: 1_000,
  maximumPositionsPerLayer: 10_000,
  maximumUploadBytes: 1024 * 1024,
  maximumStoredBytes: 2 * 1024 * 1024,
  retentionMilliseconds: 24 * 60 * 60 * 1000
});

const GEOMETRY_TYPES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
]);

export function temporaryWorkStorageKey(workspaceId, scopeId = null) {
  const workspace = storageSegment(workspaceId, "default");
  const scope = storageSegment(scopeId, workspace);
  return `opengeo.temporary-work.${workspace}.${scope}`;
}

export function isTemporaryLayer(layer) {
  return layer?.temporaryWork?.schemaVersion === TEMPORARY_WORK_SCHEMA_VERSION
    && ["annotation", "upload"].includes(layer.temporaryWork.kind)
    && layer.temporaryWork.authority === "none";
}

export function temporaryWorkExpiryLabel(layer, now = Date.now()) {
  if (!isTemporaryLayer(layer)) return null;
  const expiresAt = Date.parse(layer.temporaryWork.expiresAt);
  if (!Number.isFinite(expiresAt)) return "Temporary · invalid expiry";
  const remaining = expiresAt - timeValue(now);
  if (remaining <= 0) return "Temporary · expired";
  const hours = Math.max(1, Math.ceil(remaining / (60 * 60 * 1000)));
  return `Temporary · browser only · expires in ${hours}h`;
}

export function createTemporaryAnnotation({
  kind,
  coordinates,
  now = Date.now(),
  id = temporaryId("annotation")
}) {
  if (!["Point", "LineString", "Polygon"].includes(kind)) throw temporaryError("annotation_kind_not_supported");
  const geometry = annotationGeometry(kind, coordinates);
  const title = ({Point: "Temporary point", LineString: "Temporary path", Polygon: "Temporary polygon"})[kind];
  return createTemporaryEntry({
    id,
    title,
    geojson: {type: "FeatureCollection", features: [{
      type: "Feature",
      properties: {temporary: true},
      geometry
    }]},
    kind: "annotation",
    format: "map-drawing",
    now
  });
}

export function createTemporaryUpload({
  fileName,
  format,
  geojson,
  byteLength,
  metadata = null,
  now = Date.now(),
  id = temporaryId("upload")
}) {
  const normalizedFormat = String(format ?? "").toLowerCase();
  if (!["geojson", "json", "kml", "gpx", "nmea", "ozi", "delimited-text"].includes(normalizedFormat)) throw temporaryError("temporary_upload_format_not_supported");
  if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > TEMPORARY_WORK_LIMITS.maximumUploadBytes) {
    throw temporaryError("temporary_upload_too_large");
  }
  const safeName = boundedText(fileName, 240, "temporary_upload_name_required");
  const entry = createTemporaryEntry({
    id,
    title: safeName.replace(/\.[^.]+$/, "") || "Temporary upload",
    geojson,
    kind: "upload",
    format: normalizedFormat === "json" ? "geojson" : normalizedFormat,
    fileName: safeName,
    byteLength,
    now
  });
  if (["gpx", "nmea", "ozi", "delimited-text"].includes(normalizedFormat) && metadata?.source?.format === normalizedFormat) entry.layer.metadata = structuredClone(metadata);
  return entry;
}

export function serializeTemporaryWork({workspaceId, scopeId = null, layers, dataByLayerId, now = Date.now()}) {
  const createdAt = new Date(timeValue(now)).toISOString();
  const entries = [];
  for (const layer of layers ?? []) {
    if (!isTemporaryLayer(layer)) continue;
    if (entries.length >= TEMPORARY_WORK_LIMITS.maximumLayers) throw temporaryError("temporary_layer_limit_reached");
    const geojson = normalizeTemporaryGeojson(dataByLayerId?.get?.(layer.layerId));
    entries.push({layer: normalizeTemporaryLayer(layer), geojson});
  }
  const document = {
    schemaVersion: TEMPORARY_WORK_SCHEMA_VERSION,
    workspaceId: storageSegment(workspaceId, "default"),
    scopeId: storageSegment(scopeId, storageSegment(workspaceId, "default")),
    savedAt: createdAt,
    entries
  };
  const serialized = JSON.stringify(document);
  if (utf8Length(serialized) > TEMPORARY_WORK_LIMITS.maximumStoredBytes) throw temporaryError("temporary_storage_too_large");
  return serialized;
}

export function restoreTemporaryWork(raw, {workspaceId, scopeId = null, now = Date.now()} = {}) {
  const result = {entries: [], expired: 0, rejected: 0};
  if (raw === null || raw === undefined || raw === "") return result;
  if (typeof raw !== "string" || utf8Length(raw) > TEMPORARY_WORK_LIMITS.maximumStoredBytes) {
    result.rejected += 1;
    return result;
  }
  try {
    const value = JSON.parse(raw);
    const expectedWorkspace = storageSegment(workspaceId, "default");
    const expectedScope = storageSegment(scopeId, expectedWorkspace);
    if (value?.schemaVersion !== TEMPORARY_WORK_SCHEMA_VERSION
      || value.workspaceId !== expectedWorkspace
      || value.scopeId !== expectedScope
      || !Array.isArray(value.entries)
      || value.entries.length > TEMPORARY_WORK_LIMITS.maximumLayers) {
      result.rejected += 1;
      return result;
    }
    for (const entry of value.entries) {
      try {
        const layer = normalizeTemporaryLayer(entry?.layer);
        const expiresAt = Date.parse(layer.temporaryWork.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= timeValue(now)) {
          result.expired += 1;
          continue;
        }
        result.entries.push({layer, geojson: normalizeTemporaryGeojson(entry?.geojson)});
      } catch {
        result.rejected += 1;
      }
    }
    return result;
  } catch {
    result.rejected += 1;
    return result;
  }
}

export function normalizeTemporaryGeojson(value) {
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw temporaryError("temporary_feature_collection_required");
  }
  if (value.features.length > TEMPORARY_WORK_LIMITS.maximumFeaturesPerLayer) {
    throw temporaryError("temporary_feature_limit_reached");
  }
  let positions = 0;
  const features = value.features.map((feature) => {
    if (!feature || feature.type !== "Feature" || !feature.geometry || !GEOMETRY_TYPES.has(feature.geometry.type)) {
      throw temporaryError("temporary_geometry_not_supported");
    }
    positions += validateCoordinates(feature.geometry.coordinates);
    if (positions > TEMPORARY_WORK_LIMITS.maximumPositionsPerLayer) throw temporaryError("temporary_position_limit_reached");
    const properties = feature.properties === null || feature.properties === undefined
      ? {}
      : feature.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw temporaryError("temporary_properties_invalid");
    }
    return {
      type: "Feature",
      ...(typeof feature.id === "string" || Number.isFinite(feature.id) ? {id: feature.id} : {}),
      properties: structuredClone(properties),
      geometry: {type: feature.geometry.type, coordinates: structuredClone(feature.geometry.coordinates)}
    };
  });
  const normalized = {type: "FeatureCollection", features};
  if (utf8Length(JSON.stringify(normalized)) > TEMPORARY_WORK_LIMITS.maximumStoredBytes) {
    throw temporaryError("temporary_storage_too_large");
  }
  return normalized;
}

export function editableTemporaryFeatureIndexes(value) {
  const normalized = normalizeTemporaryGeojson(value);
  return normalized.features.flatMap((feature, index) => (
    temporaryGeometryVertices(feature.geometry) ? [index] : []
  ));
}

export function temporaryFeatureVertices(value, featureIndex) {
  const normalized = normalizeTemporaryGeojson(value);
  if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= normalized.features.length) {
    throw temporaryError("temporary_feature_index_invalid");
  }
  const vertices = temporaryGeometryVertices(normalized.features[featureIndex].geometry);
  if (!vertices) throw temporaryError("temporary_geometry_not_editable");
  return vertices;
}

export function replaceTemporaryFeatureVertex(value, {featureIndex, vertexIndex, position}) {
  const normalized = normalizeTemporaryGeojson(value);
  if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= normalized.features.length) {
    throw temporaryError("temporary_feature_index_invalid");
  }
  const feature = normalized.features[featureIndex];
  const vertices = temporaryGeometryVertices(feature.geometry);
  if (!vertices) throw temporaryError("temporary_geometry_not_editable");
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertices.length) {
    throw temporaryError("temporary_vertex_index_invalid");
  }
  if (!Array.isArray(position) || position.length !== 2) {
    throw temporaryError("temporary_position_invalid");
  }
  validateCoordinates(position);
  const target = [...structuredClone(position), ...structuredClone(vertices[vertexIndex].slice(2))];
  if (feature.geometry.type === "Point") {
    feature.geometry.coordinates = target;
  } else if (feature.geometry.type === "LineString") {
    feature.geometry.coordinates[vertexIndex] = target;
  } else {
    const ring = feature.geometry.coordinates[0];
    ring[vertexIndex] = target;
    if (vertexIndex === 0) ring[ring.length - 1] = structuredClone(target);
  }
  return normalizeTemporaryGeojson(normalized);
}

function createTemporaryEntry({id, title, geojson, kind, format, fileName = null, byteLength = null, now}) {
  const timestamp = timeValue(now);
  const createdAt = new Date(timestamp).toISOString();
  const normalized = normalizeTemporaryGeojson(geojson);
  const geometryType = normalized.features[0]?.geometry?.type ?? "Geometry";
  return {
    geojson: normalized,
    layer: {
      layerId: storageSegment(id, temporaryId(kind)),
      datasetId: storageSegment(id, temporaryId(kind)),
      title: boundedText(title, 240, "temporary_title_required"),
      sourceType: "geojson-object",
      geometryType,
      visible: true,
      opacity: 0.9,
      order: 0,
      style: temporaryStyle(geometryType),
      labels: {enabled: false, field: null},
      browserDraftData: false,
      temporaryWork: {
        schemaVersion: TEMPORARY_WORK_SCHEMA_VERSION,
        kind,
        format,
        createdAt,
        expiresAt: new Date(timestamp + TEMPORARY_WORK_LIMITS.retentionMilliseconds).toISOString(),
        authority: "none",
        persistence: "browser-only",
        promotion: "governed-ingest-required",
        ...(fileName ? {fileName} : {}),
        ...(Number.isInteger(byteLength) ? {byteLength} : {})
      }
    }
  };
}

function normalizeTemporaryLayer(value) {
  if (!isTemporaryLayer(value)) throw temporaryError("temporary_layer_marker_required");
  const createdAt = validIso(value.temporaryWork.createdAt, "temporary_created_at_invalid");
  const expiresAt = validIso(value.temporaryWork.expiresAt, "temporary_expires_at_invalid");
  if (Date.parse(expiresAt) - Date.parse(createdAt) > TEMPORARY_WORK_LIMITS.retentionMilliseconds) {
    throw temporaryError("temporary_retention_exceeded");
  }
  const layerId = storageSegment(value.layerId, null);
  if (!layerId) throw temporaryError("temporary_layer_id_required");
  const format = String(value.temporaryWork.format ?? "");
  if (!["map-drawing", "geojson", "kml", "gpx", "nmea", "ozi", "delimited-text"].includes(format)) throw temporaryError("temporary_upload_format_not_supported");
  return {
    layerId,
    datasetId: layerId,
    title: boundedText(value.title, 240, "temporary_title_required"),
    sourceType: "geojson-object",
    geometryType: GEOMETRY_TYPES.has(value.geometryType) || ["gpx", "ozi"].includes(format) && value.geometryType === "GeometryCollection" ? value.geometryType : "Geometry",
    visible: value.visible !== false,
    opacity: Number.isFinite(value.opacity) ? Math.max(0, Math.min(1, value.opacity)) : 0.9,
    order: Number.isFinite(value.order) ? value.order : 0,
    style: value.style && typeof value.style === "object" ? structuredClone(value.style) : temporaryStyle(value.geometryType),
    labels: format === "delimited-text" && value.labels?.enabled === true && value.metadata?.source?.columns?.includes(value.labels.field) ? {enabled: true, field: value.labels.field} : {enabled: false, field: null},
    browserDraftData: false,
    ...(["gpx", "nmea", "ozi", "delimited-text"].includes(format) && value.metadata?.source?.format === format ? {metadata: structuredClone(value.metadata)} : {}),
    temporaryWork: {
      schemaVersion: TEMPORARY_WORK_SCHEMA_VERSION,
      kind: value.temporaryWork.kind,
      format,
      createdAt,
      expiresAt,
      authority: "none",
      persistence: "browser-only",
      promotion: "governed-ingest-required",
      ...(typeof value.temporaryWork.fileName === "string"
        ? {fileName: boundedText(value.temporaryWork.fileName, 240, "temporary_upload_name_required")}
        : {}),
      ...(Number.isInteger(value.temporaryWork.byteLength) ? {byteLength: value.temporaryWork.byteLength} : {})
    }
  };
}

function annotationGeometry(kind, coordinates) {
  if (!Array.isArray(coordinates)) throw temporaryError("temporary_coordinates_required");
  if (kind === "Point") return {type: kind, coordinates: structuredClone(coordinates[0])};
  if (kind === "LineString") return {type: kind, coordinates: structuredClone(coordinates)};
  const ring = coordinates.map((coordinate) => structuredClone(coordinate));
  if (ring.length && !samePosition(ring[0], ring.at(-1))) ring.push(structuredClone(ring[0]));
  return {type: kind, coordinates: [ring]};
}

function temporaryGeometryVertices(geometry) {
  if (geometry?.type === "Point"
    && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length >= 2) {
    return [structuredClone(geometry.coordinates)];
  }
  if (geometry?.type === "LineString"
    && Array.isArray(geometry.coordinates)
    && geometry.coordinates.length >= 2) {
    return structuredClone(geometry.coordinates);
  }
  const ring = geometry?.type === "Polygon" && geometry.coordinates?.length === 1
    ? geometry.coordinates[0]
    : null;
  if (!Array.isArray(ring) || ring.length < 4 || !samePosition(ring[0], ring.at(-1))) return null;
  return structuredClone(ring.slice(0, -1));
}

function validateCoordinates(value, depth = 0) {
  if (!Array.isArray(value) || depth > 8) throw temporaryError("temporary_coordinates_invalid");
  if (value.length >= 2 && value.every(Number.isFinite)) {
    const [longitude, latitude] = value;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw temporaryError("temporary_coordinates_out_of_range");
    }
    return 1;
  }
  if (!value.length) throw temporaryError("temporary_coordinates_invalid");
  return value.reduce((sum, child) => sum + validateCoordinates(child, depth + 1), 0);
}

function temporaryStyle(geometryType) {
  if (geometryType.includes("Point")) return {circleColor: "#f59e0b", circleRadius: 7};
  if (geometryType.includes("Polygon")) return {fill: "#f59e0b", stroke: "#b45309", strokeWidth: 3};
  return {stroke: "#f59e0b", strokeWidth: 4};
}

function boundedText(value, maximum, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) throw temporaryError(code);
  return text;
}

function validIso(value, code) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw temporaryError(code);
  return new Date(timestamp).toISOString();
}

function storageSegment(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : fallback;
}

function temporaryId(kind) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `temporary_${kind}_${uuid}`;
}

function timeValue(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) throw temporaryError("temporary_time_invalid");
  return timestamp;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function samePosition(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length >= 2 && left[0] === right[0] && left[1] === right[1];
}

function temporaryError(code) {
  return Object.assign(new Error(code), {code});
}
