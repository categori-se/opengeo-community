import GeoJSON from "ol/format/GeoJSON.js";
import WFS from "ol/format/WFS.js";
import WKB from "ol/format/WKB.js";
import WKT from "ol/format/WKT.js";
import {
  and as andFilter,
  bbox as bboxFilter,
  during as duringFilter,
  equalTo as equalToFilter,
  or as orFilter,
  resourceId as resourceIdFilter
} from "ol/format/filter.js";
import {get as getProjection, transform as olTransform} from "ol/proj.js";

export const SPATIAL_INTERCHANGE_LIMITS = Object.freeze({
  maximumInputBytes: 4 * 1024 * 1024,
  maximumOutputBytes: 16 * 1024 * 1024,
  maximumFeatures: 10_000,
  maximumPositions: 250_000,
  maximumGeometryDepth: 12,
  maximumFilterPredicates: 16,
  maximumFilterDepth: 4,
  maximumWfsXmlBytes: 64 * 1024
});

export const SPATIAL_INTERCHANGE_FORMATS = Object.freeze({
  geojson: Object.freeze({
    label: "GeoJSON",
    parse: true,
    write: true,
    extensions: Object.freeze([".geojson", ".json"]),
    mediaType: "application/geo+json",
    payload: "features-properties-geometry"
  }),
  wkt: Object.freeze({
    label: "WKT",
    parse: true,
    write: true,
    extensions: Object.freeze([".wkt"]),
    mediaType: "text/plain;charset=utf-8",
    payload: "geometry-only"
  }),
  wkb: Object.freeze({
    label: "EWKB/WKB",
    parse: true,
    write: true,
    extensions: Object.freeze([".wkb", ".ewkb"]),
    mediaType: "application/octet-stream",
    payload: "geometry-and-optional-srid"
  })
});

export const SPATIAL_INTERCHANGE_PROJECTIONS = Object.freeze([
  Object.freeze({
    code: "CRS:84",
    authorityAxis: "enu",
    browserAxis: "xy-longitude-latitude",
    geographic: true,
    transformTolerance: 1e-10
  }),
  Object.freeze({
    code: "EPSG:4326",
    authorityAxis: "neu",
    browserAxis: "xy-longitude-latitude",
    geographic: true,
    transformTolerance: 1e-10
  }),
  Object.freeze({
    code: "EPSG:3857",
    authorityAxis: "enu",
    browserAxis: "xy-easting-northing",
    geographic: false,
    transformTolerance: 1e-6
  })
]);

export const OPENLAYERS_WFS_FILTERS = Object.freeze({
  bbox: Object.freeze({serialize: true, openGeoService: true}),
  resourceId: Object.freeze({serialize: true, openGeoService: true}),
  equalTo: Object.freeze({serialize: true, openGeoService: true}),
  during: Object.freeze({serialize: true, openGeoService: true}),
  and: Object.freeze({serialize: true, openGeoService: true}),
  or: Object.freeze({serialize: true, openGeoService: false})
});

const CRS_ALIASES = new Map([
  ["CRS:84", "CRS:84"],
  ["OGC:CRS84", "CRS:84"],
  ["URN:OGC:DEF:CRS:OGC::CRS84", "CRS:84"],
  ["HTTP://WWW.OPENGIS.NET/DEF/CRS/OGC/1.3/CRS84", "CRS:84"],
  ["EPSG:4326", "EPSG:4326"],
  ["URN:OGC:DEF:CRS:EPSG::4326", "EPSG:4326"],
  ["EPSG:3857", "EPSG:3857"],
  ["URN:OGC:DEF:CRS:EPSG::3857", "EPSG:3857"]
]);

const WFS_CRS84 = "urn:ogc:def:crs:OGC::CRS84";
const WFS_NAMESPACE = "https://opengeo.tools/ns/wfs";

export function canonicalSpatialProjection(value) {
  const key = String(value ?? "").trim().toUpperCase();
  const code = CRS_ALIASES.get(key);
  if (!code || !getProjection(code)) throw interchangeError("projection_not_supported");
  return code;
}

export function spatialProjectionContract() {
  return SPATIAL_INTERCHANGE_PROJECTIONS.map((definition) => {
    const projection = getProjection(definition.code);
    return {
      ...definition,
      runtimeAxis: projection?.getAxisOrientation() ?? null,
      units: projection?.getUnits() ?? null
    };
  });
}

export function transformSpatialCoordinate(
  coordinate,
  {
    sourceProjection = "CRS:84",
    targetProjection = "CRS:84",
    sourceAxis = "xy",
    targetAxis = "xy"
  } = {}
) {
  const source = canonicalSpatialProjection(sourceProjection);
  const target = canonicalSpatialProjection(targetProjection);
  const input = coordinatePair(coordinate);
  const xy = axisToXy(input, source, sourceAxis);
  const transformed = olTransform(xy, source, target).slice(0, 2);
  if (transformed.some((value) => !Number.isFinite(value))) {
    throw interchangeError("projection_result_invalid");
  }
  return xyToAxis(transformed, target, targetAxis);
}

export function transformSpatialExtent(
  extent,
  options = {}
) {
  if (
    !Array.isArray(extent)
    || extent.length !== 4
    || extent.some((value) => !Number.isFinite(value))
    || extent[0] >= extent[2]
    || extent[1] >= extent[3]
  ) {
    throw interchangeError("projection_extent_invalid");
  }
  const corners = [
    [extent[0], extent[1]],
    [extent[0], extent[3]],
    [extent[2], extent[1]],
    [extent[2], extent[3]]
  ].map((coordinate) => transformSpatialCoordinate(coordinate, options));
  return [
    Math.min(...corners.map(([x]) => x)),
    Math.min(...corners.map(([, y]) => y)),
    Math.max(...corners.map(([x]) => x)),
    Math.max(...corners.map(([, y]) => y))
  ];
}

export function parseSpatialInterchange(
  source,
  {
    format,
    dataProjection = null,
    featureProjection = "CRS:84"
  } = {}
) {
  const formatId = spatialFormatId(format);
  const inputBytes = sourceByteLength(source);
  if (inputBytes < 1 || inputBytes > SPATIAL_INTERCHANGE_LIMITS.maximumInputBytes) {
    throw interchangeError("interchange_input_size_exceeded");
  }
  const parser = formatReader(formatId, source);
  const detected = dataProjection
    ? canonicalSpatialProjection(dataProjection)
    : detectedProjection(parser, source) ?? "CRS:84";
  const target = canonicalSpatialProjection(featureProjection);
  let features;
  try {
    features = parser.readFeatures(source, {
      dataProjection: detected,
      featureProjection: target
    });
  } catch (cause) {
    throw interchangeError("interchange_parse_failed", cause);
  }
  const geojson = new GeoJSON().writeFeaturesObject(features, {
    dataProjection: "CRS:84",
    featureProjection: target
  });
  const normalized = validateFeatureCollection(geojson);
  const metadata = formatId === "geojson"
    ? preserveGeoJsonMembers(typeof source === "string" ? JSON.parse(source) : source, normalized)
    : {spatialMembers: []};
  assertInterchangeOutputSize(normalized);
  return {
    geojson: normalized,
    report: {
      schemaVersion: "1.0.0",
      format: formatId,
      operation: "parse",
      inputBytes,
      featureCount: normalized.features.length,
      positionCount: countFeaturePositions(normalized),
      sourceProjection: detected,
      outputProjection: "CRS:84",
      propertiesPreserved: formatId === "geojson",
      preservedSpatialMetadata: metadata.spatialMembers,
      losses: formatId === "geojson" ? spatialMemberLosses(metadata)
        : ["source format contains geometry but no feature properties"]
    }
  };
}

export function serializeSpatialInterchange(
  geojson,
  {
    format,
    dataProjection = "CRS:84",
    featureProjection = "CRS:84",
    wkbEncoding = "binary"
  } = {}
) {
  const formatId = spatialFormatId(format);
  assertInterchangeOutputSize(geojson);
  const normalized = validateFeatureCollection(geojson);
  const sourceProjection = canonicalSpatialProjection(featureProjection);
  const outputProjection = canonicalSpatialProjection(dataProjection);
  const features = geoJsonReader(normalized).readFeatures(normalized, {
    dataProjection: "CRS:84",
    featureProjection: sourceProjection
  });
  const writer = formatWriter(formatId, wkbEncoding);
  let content;
  try {
    content = writer.writeFeatures(features, {
      dataProjection: outputProjection,
      featureProjection: sourceProjection,
      decimals: 12
    });
  } catch (cause) {
    throw interchangeError("interchange_write_failed", cause);
  }
  const metadata = {spatialMembers: []};
  if (formatId === "geojson") {
    const output = JSON.parse(content);
    metadata.spatialMembers = preserveGeoJsonMembers(geojson, output).spatialMembers;
    content = JSON.stringify(output);
  }
  const outputBytes = sourceByteLength(content);
  if (outputBytes < 1 || outputBytes > SPATIAL_INTERCHANGE_LIMITS.maximumOutputBytes) {
    throw interchangeError("interchange_output_size_exceeded");
  }
  const definition = SPATIAL_INTERCHANGE_FORMATS[formatId];
  return {
    content,
    mediaType: definition.mediaType,
    extension: definition.extensions[0],
    report: {
      schemaVersion: "1.0.0",
      format: formatId,
      operation: "write",
      outputBytes,
      featureCount: normalized.features.length,
      positionCount: countFeaturePositions(normalized),
      sourceProjection: "CRS:84",
      outputProjection,
      propertiesPreserved: formatId === "geojson",
      preservedSpatialMetadata: metadata.spatialMembers,
      losses: formatId === "geojson"
        ? spatialMemberLosses(metadata)
        : ["feature identifiers, properties and GeoJSON metadata are not represented by this geometry format"]
    }
  };
}

export async function readSpatialInterchangeFile(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw interchangeError("interchange_file_required");
  }
  const fileName = String(file.name ?? "");
  const format = formatFromFileName(fileName);
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize) && declaredSize > SPATIAL_INTERCHANGE_LIMITS.maximumInputBytes) {
    throw interchangeError("interchange_input_size_exceeded");
  }
  let source;
  if (format === "wkb") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    source = looksLikeHex(bytes) ? new TextDecoder().decode(bytes).trim() : bytes.buffer;
  } else if (typeof file.text === "function") {
    source = await file.text();
  } else {
    source = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
  }
  return {
    ...parseSpatialInterchange(source, {format, ...options}),
    source: {fileName, format, byteLength: sourceByteLength(source)}
  };
}

// Keep conversion knowledge inside the exact normalized object uploaded to storage.
// This records the original identity; it does not claim to archive original bytes.
export async function prepareManagedSpatialFile(file) {
  const parsed = await readSpatialInterchangeFile(file);
  if (!["wkt", "wkb"].includes(parsed.source.format)) {
    throw interchangeError("interchange_geometry_source_required");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const sourceChecksumSha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  const collection = structuredClone(parsed.geojson);
  collection["opengeo:conversion"] = {
    schemaVersion: 1,
    source: {...parsed.source, byteLength: file.size, parsedByteLength: parsed.source.byteLength, checksumSha256: sourceChecksumSha256, originalBytesArchived: false},
    report: structuredClone(parsed.report)
  };
  const converted = serializeSpatialInterchange(collection, {format: "geojson"});
  const name = `${file.name.replace(/\.(?:wkt|e?wkb)$/i, "") || "spatial-data"}.geojson`;
  return {
    file: new File([converted.content], name, {type: converted.mediaType}),
    source: parsed.source,
    report: collection["opengeo:conversion"]
  };
}

export function buildOpenLayersWfsGetFeature({
  filter,
  count = 20,
  startIndex = 0,
  outputFormat = "application/geo+json",
  serviceProfile = true
} = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw interchangeError("wfs_count_invalid");
  }
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > 10_000) {
    throw interchangeError("wfs_start_index_invalid");
  }
  const filterResult = openLayersFilter(filter, {serviceProfile});
  const format = new WFS({version: "2.0.0"});
  let node;
  try {
    node = format.writeGetFeature({
      featureNS: WFS_NAMESPACE,
      featurePrefix: "opengeo",
      featureTypes: ["features"],
      srsName: WFS_CRS84,
      outputFormat,
      count,
      startIndex,
      filter: filterResult.filter
    });
  } catch (cause) {
    throw interchangeError("wfs_filter_write_failed", cause);
  }
  const Serializer = globalThis.XMLSerializer;
  if (typeof Serializer !== "function") throw interchangeError("xml_serializer_unavailable");
  const xml = new Serializer().serializeToString(node);
  const byteLength = sourceByteLength(xml);
  if (byteLength > SPATIAL_INTERCHANGE_LIMITS.maximumWfsXmlBytes) {
    throw interchangeError("wfs_filter_output_too_large");
  }
  return {
    xml,
    byteLength,
    contentType: "application/xml",
    filter: filterResult.report,
    serviceCompatible: filterResult.report.serviceCompatible
  };
}

// Retain foreign members (including rights/provenance) as opaque source knowledge.
// CRS declarations and bounds describe the original coordinates, not the transformed
// output: retain them in the report instead of silently attaching stale values.
function preserveGeoJsonMembers(source, target) {
  const spatialMembers = [];
  const copy = (from, to, path) => {
    if (!from || !to || typeof from !== "object") return;
    const structural = new Set(from.type === "FeatureCollection" ? ["type", "features"]
      : from.type === "Feature" ? ["type", "geometry", "properties", "id"]
      : from.type === "GeometryCollection" ? ["type", "geometries"] : ["type", "coordinates"]);
    for (const [key, value] of Object.entries(from)) {
      if (key === "crs" || key === "bbox") {
        spatialMembers.push({path, member: key, value: structuredClone(value)});
      } else if (!structural.has(key)) {
        Object.defineProperty(to, key, {value: structuredClone(value), enumerable: true, configurable: true, writable: true});
      }
    }
    if (from.type === "FeatureCollection") from.features.forEach((item, i) => copy(item, to.features[i], `${path}/features/${i}`));
    else if (from.type === "Feature") copy(from.geometry, to.geometry, `${path}/geometry`);
    else if (from.type === "GeometryCollection") from.geometries.forEach((item, i) => copy(item, to.geometries[i], `${path}/geometries/${i}`));
  };
  if (source?.type === "FeatureCollection") copy(source, target, "");
  else if (source?.type === "Feature") copy(source, target.features[0], "");
  else copy(source, target.features[0]?.geometry, "");
  return {spatialMembers};
}

function spatialMemberLosses(metadata) {
  return metadata.spatialMembers.length
    ? ["Original CRS declarations and bounding boxes are retained in the conversion report, not copied to transformed GeoJSON."] : [];
}

function assertInterchangeOutputSize(value) {
  if (sourceByteLength(JSON.stringify(value)) > SPATIAL_INTERCHANGE_LIMITS.maximumOutputBytes) {
    throw interchangeError("interchange_output_size_exceeded");
  }
}

// OpenLayers stores geometry among feature properties. Choose an internal key
// absent from every input feature so legitimate attributes cannot replace it.
function geoJsonReader(source) {
  let value;
  try {value = typeof source === "string" ? JSON.parse(source) : source;}
  catch (cause) {throw interchangeError("interchange_parse_failed", cause);}
  const features = value?.type === "FeatureCollection" ? value.features : [value];
  const names = new Set();
  for (const feature of Array.isArray(features) ? features : []) {
    for (const key of Object.keys(feature?.properties ?? {})) names.add(key);
  }
  let geometryName = "__opengeo_geometry__";
  while (names.has(geometryName)) geometryName += "_";
  return new GeoJSON({geometryName});
}

function formatReader(format, source) {
  if (format === "geojson") return geoJsonReader(source);
  if (format === "wkt") return new WKT({splitCollection: true});
  return new WKB({
    splitCollection: true,
    hex: typeof source === "string",
    ewkb: true
  });
}

function formatWriter(format, wkbEncoding) {
  if (format === "geojson") return new GeoJSON();
  if (format === "wkt") return new WKT({splitCollection: true});
  if (!["binary", "hex"].includes(wkbEncoding)) {
    throw interchangeError("wkb_encoding_invalid");
  }
  return new WKB({
    splitCollection: true,
    hex: wkbEncoding === "hex",
    ewkb: true,
    srid: true
  });
}

function detectedProjection(parser, source) {
  try {
    const projection = parser.readProjection(source);
    return projection ? canonicalSpatialProjection(projection.getCode()) : null;
  } catch {
    return null;
  }
}

function spatialFormatId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!Object.hasOwn(SPATIAL_INTERCHANGE_FORMATS, id)) {
    throw interchangeError("interchange_format_not_supported");
  }
  return id;
}

function formatFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  for (const [format, definition] of Object.entries(SPATIAL_INTERCHANGE_FORMATS)) {
    if (definition.extensions.some((extension) => lower.endsWith(extension))) return format;
  }
  throw interchangeError("interchange_file_extension_not_supported");
}

function sourceByteLength(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw interchangeError("interchange_payload_invalid");
}

function looksLikeHex(bytes) {
  // File padding is not part of the hexadecimal payload or its even-length check.
  const text = new TextDecoder().decode(bytes).trim();
  return text.length > 0 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text);
}

function validateFeatureCollection(value) {
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw interchangeError("interchange_feature_collection_required");
  }
  if (value.features.length > SPATIAL_INTERCHANGE_LIMITS.maximumFeatures) {
    throw interchangeError("interchange_feature_limit_exceeded");
  }
  let positions = 0;
  const features = value.features.map((feature) => {
    if (!feature || feature.type !== "Feature" || !feature.geometry) {
      throw interchangeError("interchange_feature_invalid");
    }
    positions += validateGeometry(feature.geometry, 1);
    if (positions > SPATIAL_INTERCHANGE_LIMITS.maximumPositions) {
      throw interchangeError("interchange_position_limit_exceeded");
    }
    const properties = feature.properties ?? {};
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw interchangeError("interchange_properties_invalid");
    }
    return {
      type: "Feature",
      ...(typeof feature.id === "string" || Number.isFinite(feature.id) ? {id: feature.id} : {}),
      properties: structuredClone(properties),
      geometry: structuredClone(feature.geometry)
    };
  });
  const result = {type: "FeatureCollection", features};
  if (sourceByteLength(JSON.stringify(result)) > SPATIAL_INTERCHANGE_LIMITS.maximumOutputBytes) {
    throw interchangeError("interchange_output_size_exceeded");
  }
  return result;
}

function validateGeometry(geometry, depth) {
  if (depth > SPATIAL_INTERCHANGE_LIMITS.maximumGeometryDepth) {
    throw interchangeError("interchange_geometry_depth_exceeded");
  }
  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) throw interchangeError("interchange_geometry_invalid");
    return geometry.geometries.reduce((count, member) => count + validateGeometry(member, depth + 1), 0);
  }
  const dimensions = {
    Point: 1,
    MultiPoint: 2,
    LineString: 2,
    MultiLineString: 3,
    Polygon: 3,
    MultiPolygon: 4
  };
  if (!Object.hasOwn(dimensions, geometry.type)) {
    throw interchangeError("interchange_geometry_not_supported");
  }
  return validateCoordinateTree(geometry.coordinates, dimensions[geometry.type], depth);
}

function validateCoordinateTree(value, dimensions, depth) {
  if (depth > SPATIAL_INTERCHANGE_LIMITS.maximumGeometryDepth || !Array.isArray(value)) {
    throw interchangeError("interchange_coordinates_invalid");
  }
  if (dimensions === 1) {
    if (
      value.length < 2
      || value.length > 4
      || value.some((coordinate) => !Number.isFinite(coordinate))
    ) throw interchangeError("interchange_position_invalid");
    return 1;
  }
  return value.reduce(
    (count, member) => count + validateCoordinateTree(member, dimensions - 1, depth + 1),
    0
  );
}

function countFeaturePositions(value) {
  return value.features.reduce((count, feature) => count + validateGeometry(feature.geometry, 1), 0);
}

function coordinatePair(value) {
  if (!Array.isArray(value) || value.length < 2 || value.slice(0, 2).some((item) => !Number.isFinite(item))) {
    throw interchangeError("projection_coordinate_invalid");
  }
  return value.slice(0, 2);
}

function axisToXy(coordinate, projection, axis) {
  if (!['xy', 'authority'].includes(axis)) throw interchangeError("projection_axis_invalid");
  return axis === "authority" && authorityAxisSwaps(projection)
    ? [coordinate[1], coordinate[0]]
    : [...coordinate];
}

function xyToAxis(coordinate, projection, axis) {
  if (!['xy', 'authority'].includes(axis)) throw interchangeError("projection_axis_invalid");
  return axis === "authority" && authorityAxisSwaps(projection)
    ? [coordinate[1], coordinate[0]]
    : [...coordinate];
}

function authorityAxisSwaps(projection) {
  return getProjection(projection)?.getAxisOrientation()?.startsWith("ne") === true;
}

function openLayersFilter(definition, {serviceProfile}, depth = 1, budget = {count: 0}) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw interchangeError("wfs_filter_invalid");
  }
  if (depth > SPATIAL_INTERCHANGE_LIMITS.maximumFilterDepth) {
    throw interchangeError("wfs_filter_depth_exceeded");
  }
  budget.count += 1;
  if (budget.count > SPATIAL_INTERCHANGE_LIMITS.maximumFilterPredicates) {
    throw interchangeError("wfs_filter_count_exceeded");
  }
  const kind = String(definition.kind ?? "");
  const capability = OPENLAYERS_WFS_FILTERS[kind];
  if (!capability) throw interchangeError("wfs_filter_not_supported");
  if (serviceProfile && !capability.openGeoService) {
    throw interchangeError("wfs_filter_not_supported_by_opengeo");
  }
  let serviceCompatible = capability.openGeoService;
  let filter;
  if (kind === "bbox") {
    const extent = definition.extent;
    if (!Array.isArray(extent) || extent.length !== 4) throw interchangeError("wfs_bbox_invalid");
    const normalized = extent.map(Number);
    if (
      normalized.some((value) => !Number.isFinite(value))
      || !(normalized[0] >= -180 && normalized[0] < normalized[2] && normalized[2] <= 180)
      || !(normalized[1] >= -90 && normalized[1] < normalized[3] && normalized[3] <= 90)
    ) throw interchangeError("wfs_bbox_invalid");
    filter = bboxFilter("geometry", normalized, WFS_CRS84);
  } else if (kind === "resourceId") {
    const value = boundedFilterText(definition.value, 128);
    if (!/^features\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw interchangeError("wfs_resource_id_invalid");
    }
    filter = resourceIdFilter(value);
  } else if (kind === "equalTo") {
    filter = equalToFilter(
      boundedFilterName(definition.property),
      boundedFilterText(definition.value, 500),
      definition.matchCase !== false
    );
  } else if (kind === "during") {
    const begin = boundedInstant(definition.begin);
    const end = boundedInstant(definition.end);
    if (Date.parse(begin) >= Date.parse(end)) throw interchangeError("wfs_during_invalid");
    const property = boundedFilterName(definition.property);
    if (!["opengeo_created_at", "opengeo_updated_at"].includes(property)) {
      serviceCompatible = false;
      if (serviceProfile) throw interchangeError("wfs_filter_not_supported_by_opengeo");
    }
    filter = duringFilter(property, begin, end);
  } else {
    if (!Array.isArray(definition.conditions) || definition.conditions.length < 2 || definition.conditions.length > 8) {
      throw interchangeError("wfs_logical_filter_invalid");
    }
    if (serviceProfile && kind === "and" && definition.conditions.length > 4) {
      throw interchangeError("wfs_filter_not_supported_by_opengeo");
    }
    const children = definition.conditions.map((condition) => (
      openLayersFilter(condition, {serviceProfile}, depth + 1, budget)
    ));
    serviceCompatible = serviceCompatible
      && children.every(({report}) => report.serviceCompatible);
    const filters = children.map(({filter: child}) => child);
    filter = kind === "and" ? andFilter(...filters) : orFilter(...filters);
  }
  return {
    filter,
    report: {
      kind,
      serviceCompatible,
      predicateCount: budget.count,
      maximumPredicates: SPATIAL_INTERCHANGE_LIMITS.maximumFilterPredicates
    }
  };
}

function boundedFilterName(value) {
  const name = String(value ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
    throw interchangeError("wfs_filter_property_invalid");
  }
  return name;
}

function boundedFilterText(value, maximum) {
  const text = String(value ?? "");
  if (!text || new TextEncoder().encode(text).byteLength > maximum) {
    throw interchangeError("wfs_filter_value_invalid");
  }
  return text;
}

function boundedInstant(value) {
  const text = boundedFilterText(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)
    || !Number.isFinite(Date.parse(text))) throw interchangeError("wfs_filter_instant_invalid");
  return text;
}

function interchangeError(code, cause = undefined) {
  return Object.assign(new Error(code, cause ? {cause} : undefined), {code});
}
