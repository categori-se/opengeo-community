import {GPX_IMPORT_LIMITS, originalGpxFile, readGpxFile} from "./gpxImport.js";

const MEDIA_TYPE = "application/gpx+xml";
const encode = value => new TextEncoder().encode(value);
const fail = (code, message, detail = {}) => Object.assign(new Error(message), {
  code, report: {schemaVersion: "opengeo.gpx-export.1", operation: "reject", code, ...detail}
});

/**
 * Update geometry in a verified original GPX, retaining its XML fields and gaps.
 * Exact feature identities and point counts are required: source point metadata
 * stays attached by vertex index. Other working properties are not interpreted.
 */
export async function workingGpxFile({source, geojson} = {}, {
  Parser = globalThis.DOMParser, Serializer = globalThis.XMLSerializer
} = {}) {
  const current = snapshotGeometry(geojson);
  // Snapshot only source fields used for verification before crossing an await.
  const retained = {format: source?.format, filename: source?.filename, bytes: source?.bytes,
    sha256: source?.sha256, gpxVersion: source?.gpxVersion, originalFile: {
      encoding: source?.originalFile?.encoding, mediaType: source?.originalFile?.mediaType,
      bytes: source?.originalFile?.bytes, sha256: source?.originalFile?.sha256,
      content: source?.originalFile?.content
    }};
  if (typeof Parser !== "function" || typeof Serializer !== "function") {
    throw fail("gpx_export_xml_unavailable", "This browser cannot write GPX XML.");
  }
  let original, imported;
  try {
    original = await originalGpxFile(retained);
    imported = await readGpxFile(localFile(original.bytes, original.filename), {Parser});
  } catch (error) {
    throw fail("gpx_export_source_invalid", "The retained original GPX could not be verified.", {sourceCode: error.code ?? "gpx_source_invalid"});
  }
  if (retained.gpxVersion !== imported.source.gpxVersion || retained.sha256 !== imported.source.sha256) {
    throw fail("gpx_export_source_identity", "The retained GPX source identity does not match its original file.");
  }
  const expected = imported.geojson.features;
  if (current.size !== expected.length) {
    throw fail("gpx_export_feature_set", "Working GPX export requires the original feature set; adding or removing features is unsupported.");
  }
  const xml = new TextDecoder("utf-8", {fatal: true}).decode(original.bytes);
  const document = new Parser().parseFromString(xml, "application/xml");
  const root = document.documentElement, namespace = root.namespaceURI;
  const children = (node, name) => [...node.children].filter(child => child.namespaceURI === namespace && child.localName === name);
  const records = [...root.children].filter(node => node.namespaceURI === namespace && ["wpt", "rte", "trk"].includes(node.localName));
  let editedPoints = 0, editedHeights = 0;
  for (const feature of expected) {
    const working = current.get(feature.id), identity = feature.properties.gpx;
    if (!working || ["kind", "sourceIndex", "segmentIndex"].some(key => working.identity[key] !== identity[key])) {
      throw fail("gpx_export_feature_identity", "A working feature no longer matches its original GPX identity.", {featureId: feature.id});
    }
    const sourceCoordinates = feature.geometry.type === "Point" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (working.type !== feature.geometry.type || working.coordinates.length !== sourceCoordinates.length) {
      throw fail("gpx_export_point_mapping", "Working GPX export requires the original geometry type and point count; adding or removing vertices is unsupported.", {featureId: feature.id});
    }
    const record = records[identity.sourceIndex];
    const points = identity.kind === "wpt" ? [record] : identity.kind === "rte" ? children(record, "rtept")
      : children(children(record, "trkseg")[identity.segmentIndex], "trkpt");
    if (points.length !== working.coordinates.length) throw fail("gpx_export_source_mapping", "The original GPX point mapping is ambiguous.", {featureId: feature.id});
    for (const [index, coordinate] of working.coordinates.entries()) {
      const point = points[index], before = sourceCoordinates[index];
      const moved = coordinate[0] !== before[0] || coordinate[1] !== before[1];
      if (coordinate[0] !== before[0]) point.setAttribute("lon", decimal(coordinate[0]));
      if (coordinate[1] !== before[1]) point.setAttribute("lat", decimal(coordinate[1]));
      const heightChanged = coordinate.length === 3 && coordinate[2] !== identity.points[index].elevation;
      if (heightChanged) {
        const elevations = children(point, "ele");
        if (elevations.length > 1 || elevations[0]?.children.length) {
          throw fail("gpx_export_height_mapping", "The original GPX elevation field is ambiguous.", {featureId: feature.id, pointIndex: index});
        }
        const elevation = elevations[0] ?? document.createElementNS(namespace, point.prefix ? `${point.prefix}:ele` : "ele");
        if (!elevations.length) point.insertBefore(elevation, point.firstChild);
        elevation.textContent = decimal(coordinate[2]);
        editedHeights++;
      }
      if (moved || heightChanged) editedPoints++;
    }
  }
  const declaration = xml.match(/^\s*(<\?xml\s[\s\S]*?\?>)/)?.[1] ?? '<?xml version="1.0" encoding="UTF-8"?>';
  // Browsers may serialize a Document declaration; JSDOM omits it. Retain the
  // source declaration exactly once, without matching xml-stylesheet instructions.
  const body = new Serializer().serializeToString(document).replace(/^\s*<\?xml\s[\s\S]*?\?>\s*/, "");
  const bytes = encode(`${declaration}\n${body}`);
  if (!bytes.length || bytes.length > GPX_IMPORT_LIMITS.inputBytes) {
    throw fail("gpx_export_output_limit", "The working GPX exceeds the 256 KiB file limit.", {outputBytes: bytes.length});
  }
  const stem = original.filename.replace(/\.gpx$/i, "").slice(0, 228) || "track";
  const filename = `${stem}-working.gpx`;
  // The downloaded bytes must satisfy the same bounded reader used to reopen them.
  let checked;
  try {checked = await readGpxFile(localFile(bytes, filename), {Parser});} catch (error) {
    throw fail("gpx_export_output_invalid", "The working GPX cannot be reopened within the supported limits.", {sourceCode: error.code ?? "gpx_output_invalid"});
  }
  return {bytes, filename, mediaType: MEDIA_TYPE, report: {
    schemaVersion: "opengeo.gpx-export.1", operation: "export", format: "gpx", version: imported.source.gpxVersion,
    sourceSha256: retained.sha256, outputSha256: checked.source.sha256, outputBytes: bytes.length,
    featureCount: expected.length, positionCount: imported.report.counts.positions, editedPoints, editedHeights,
    originalPreserved: true, geometryPolicy: "original-feature-identities-and-vertex-indices",
    heightPolicy: "XYZ-updates-elevation;XY-retains-original-elevations",
    fieldPolicy: "original-XML-fields-extensions-and-time-text-retained;other-working-properties-ignored",
    segmentPolicy: "original-track-segments-and-gaps-retained",
    limits: ["Feature sets, geometry types and per-feature vertex counts must remain unchanged.",
      "Point metadata remains attached by vertex index; vertex reassignment is not inferred.",
      "Working names and other properties do not rewrite original GPX fields.",
      "XML serialization may change formatting; the retained original bytes remain unchanged.",
      "Device transfer, general GPX authoring and managed conversion remain unsupported."]
  }};
}

export async function downloadWorkingGpx(input, options) {
  const result = await workingGpxFile(input, options);
  const url = URL.createObjectURL(new Blob([result.bytes], {type: result.mediaType}));
  let link;
  try {
    link = document.createElement("a");link.href = url;link.download = result.filename;
    document.body.append(link);link.click();
  } finally {
    link?.remove();setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return result;
}

function snapshotGeometry(geojson) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) {
    throw fail("gpx_export_feature_collection", "Choose a nonempty GPX working FeatureCollection.");
  }
  if (geojson.features.length > GPX_IMPORT_LIMITS.features) throw fail("gpx_export_feature_limit", "Working GPX supports at most 1000 features.");
  const current = new Map();let positions = 0;
  for (const feature of geojson.features) {
    if (feature?.type !== "Feature" || typeof feature.id !== "string" || !feature.id || current.has(feature.id)) {
      throw fail("gpx_export_feature_identity", "Working GPX features require unique original feature IDs.");
    }
    const type = feature.geometry?.type;
    if (!["Point", "LineString"].includes(type)) throw fail("gpx_export_geometry", "Working GPX supports the original Point and LineString geometries only.", {featureId: feature.id});
    const coordinates = type === "Point" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length) throw fail("gpx_export_coordinates", "Working GPX requires nonempty coordinate arrays.", {featureId: feature.id});
    if ((positions += coordinates.length) > GPX_IMPORT_LIMITS.positions) throw fail("gpx_export_position_limit", "Working GPX supports at most 5000 positions.");
    let dimensions;
    const copy = Array.from(coordinates, (coordinate, pointIndex) => {
      if (!Array.isArray(coordinate) || ![2, 3].includes(coordinate.length) || [...coordinate].some(value => typeof value !== "number" || !Number.isFinite(value))
        || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90 || (coordinate.length === 3 && Math.abs(coordinate[2]) > 100_000)
        || (dimensions !== undefined && coordinate.length !== dimensions)) {
        throw fail("gpx_export_coordinates", "GPX coordinates require finite longitude/latitude, consistent XY or XYZ dimensions, and supported ranges.", {featureId: feature.id, pointIndex});
      }
      dimensions = coordinate.length;
      return [...coordinate];
    });
    const identity = feature.properties?.gpx;
    if (!identity || !["wpt", "rte", "trk"].includes(identity.kind) || !Number.isInteger(identity.sourceIndex) || identity.sourceIndex < 0
      || !(identity.segmentIndex === null || Number.isInteger(identity.segmentIndex) && identity.segmentIndex >= 0)) {
      throw fail("gpx_export_feature_identity", "A working feature is missing its original GPX identity.", {featureId: feature.id});
    }
    current.set(feature.id, {type, coordinates: copy, identity: {kind: identity.kind, sourceIndex: identity.sourceIndex, segmentIndex: identity.segmentIndex}});
  }
  return current;
}

function localFile(bytes, name) {
  return {name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
}

// GPX's decimal fields do not accept JavaScript's exponent notation.
function decimal(value) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const negative = coefficient.startsWith("-"), unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ""] = unsigned.split("."), digits = integer + fraction;
  const position = integer.length + Number(exponentText);
  const expanded = position <= 0 ? `0.${"0".repeat(-position)}${digits}`
    : position >= digits.length ? `${digits}${"0".repeat(position - digits.length)}`
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
  return `${negative ? "-" : ""}${expanded}`;
}
