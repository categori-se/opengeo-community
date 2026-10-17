import GPX from "ol/format/GPX.js";

export const GPX_IMPORT_LIMITS = Object.freeze({
  inputBytes: 262_144, outputBytes: 1_048_576, positions: 5_000,
  features: 1_000, elements: 30_000, xmlDepth: 16, textCharacters: 8_192
});
const NAMESPACES = {"1.0": "http://www.topografix.com/GPX/1/0", "1.1": "http://www.topografix.com/GPX/1/1"};
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const bytesOf = value => new TextEncoder().encode(value);
const error = (code, message, report = {}) => Object.assign(new Error(message), {
  code, report: {schemaVersion: "opengeo.gpx-import.1", operation: "reject", code, ...report}
});

/** Local bytes only. GPX hyperlinks, schemas and extensions are never fetched. */
export async function readGpxFile(file, {Parser = globalThis.DOMParser} = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw error("gpx_file_required", "Choose a GPX file.");
  if (file.size > GPX_IMPORT_LIMITS.inputBytes) throw error("gpx_input_limit", "GPX files can be at most 256 KiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > GPX_IMPORT_LIMITS.inputBytes) throw error("gpx_input_limit", "GPX files must contain 1–262144 bytes.");
  let xml;
  try {xml = new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {
    throw error("gpx_encoding", "Save the GPX file as UTF-8 before opening it.");
  }
  const encoding = xml.match(/^\s*<\?xml[^?]*\bencoding\s*=\s*["']([^"']+)["']/i)?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) throw error("gpx_encoding", "Save the GPX file as UTF-8 before opening it.");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw error("gpx_active_xml", "GPX document types and entity declarations are unsupported.");
  if (typeof Parser !== "function") throw error("gpx_xml_unavailable", "This browser cannot read GPX XML.");
  const doc = new Parser().parseFromString(xml, "application/xml"), root = doc.documentElement;
  if (!root || doc.getElementsByTagName("parsererror").length) throw error("gpx_invalid_xml", "The GPX XML is malformed.");
  const version = root.getAttribute("version"), ns = NAMESPACES[version];
  if (root.localName !== "gpx" || !ns || root.namespaceURI !== ns) {
    throw error("gpx_version", "Choose GPX 1.0 or 1.1 with its declared GPX namespace.");
  }
  inspectTree(root);
  const child = (node, name) => [...node.children].filter(n => n.namespaceURI === ns && n.localName === name);
  const text = (node, name) => child(node, name)[0]?.textContent ?? null;
  const records = [...root.children].filter(n => n.namespaceURI === ns && ["wpt", "rte", "trk"].includes(n.localName));
  if (records.length > GPX_IMPORT_LIMITS.features) throw error("gpx_feature_limit", "The GPX file contains too many source records.");
  const sha256 = await digest(bytes), features = [], rejectedRecords = [];
  const counts = {waypoints: 0, routes: 0, tracks: 0, segments: 0, positions: 0, elevations: 0, timestamps: 0};
  const reader = new GPX();
  const parsePoint = (node, sourceIndex) => {
    if (++counts.positions > GPX_IMPORT_LIMITS.positions) throw error("gpx_position_limit", "GPX imports support at most 5000 positions.");
    const number = (value, minimum, maximum, field) => {
      if (value === null || !decimal.test(value.trim()) || !Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
        throw error("gpx_position_invalid", `GPX record ${sourceIndex + 1} contains an invalid ${field}.`, {sourceIndex, field});
      }
      return Number(value);
    };
    const lon = number(node.getAttribute("lon"), -180, 180, "longitude"), lat = number(node.getAttribute("lat"), -90, 90, "latitude");
    const rawElevation = text(node, "ele"), elevation = rawElevation === null ? null : number(rawElevation, -100_000, 100_000, "elevation");
    const time = text(node, "time"); // Preserve its exact lexical value; never invent a timezone or epoch.
    if (elevation !== null) counts.elevations++;
    if (time !== null) counts.timestamps++;
    const sourceFields = fields(node);
    sourceFields[0].attributes = sourceFields[0].attributes.filter(a => a.namespace !== null || !["lat", "lon"].includes(a.name));
    if (!sourceFields[0].attributes.length && !sourceFields[0].text.trim()) sourceFields.shift();
    return {lon, lat, elevation, time, fields: sourceFields};
  };
  const append = (record, points, sourceIndex, segmentIndex = null, mapped = {}) => {
    if (!points.length) {rejectedRecords.push({sourceIndex, segmentIndex, kind: record.localName, reason: "no-positions", originalPreserved: true}); return;}
    if (features.length >= GPX_IMPORT_LIMITS.features) throw error("gpx_feature_limit", "GPX imports support at most 1000 waypoint, route or segment features.");
    const allElevations = points.every(p => p.elevation !== null);
    const coordinates = points.map(p => allElevations ? [p.lon, p.lat, p.elevation] : [p.lon, p.lat]);
    const properties = {...mapped};delete properties.geometry;delete properties.extensionsNode_;delete properties.time;
    const name = text(record, "name");if (name !== null) properties.name = name;
    properties.gpx = {kind: record.localName, sourceIndex, segmentIndex,
      fields: fields(record, new Set(["rtept", "trkseg"])),
      points: points.map(({elevation, time, fields}) => ({elevation, time, fields})),
      coordinateDimensions: allElevations ? "XYZ" : "XY", elevationUnit: "meter", verticalDatum: "not-specified"};
    const feature = {type: "Feature", id: `gpx-${sha256.slice(0, 12)}-${sourceIndex}${segmentIndex === null ? "" : `-${segmentIndex}`}`,
      properties, geometry: coordinates.length === 1 ? {type: "Point", coordinates: coordinates[0]} : {type: "LineString", coordinates}};
    features.push(feature);
  };
  for (const [sourceIndex, record] of records.entries()) {
    // Reuse the pinned GPX reader's standard field mapping. Our source fields and
    // per-point records retain data that its geometry-only track conversion omits.
    let mapped;
    try {mapped = reader.readFeature(record)?.getProperties() ?? {};} catch (cause) {
      throw error("gpx_parse_failed", `GPX record ${sourceIndex + 1} could not be read.`, {sourceIndex, cause: cause?.name});
    }
    if (record.localName === "wpt") {counts.waypoints++;append(record, [parsePoint(record, sourceIndex)], sourceIndex, null, mapped);}
    else if (record.localName === "rte") {counts.routes++;append(record, child(record, "rtept").map(n => parsePoint(n, sourceIndex)), sourceIndex, null, mapped);}
    else {
      counts.tracks++;const segments = child(record, "trkseg");counts.segments += segments.length;
      if (!segments.length) rejectedRecords.push({sourceIndex, kind: "trk", reason: "no-segments", originalPreserved: true});
      for (const [index, segment] of segments.entries()) append(record, child(segment, "trkpt").map(n => parsePoint(n, sourceIndex)), sourceIndex, index, mapped);
    }
  }
  if (!features.length) throw error("gpx_no_positions", "This GPX file has no positions to display.", {rejectedRecords});
  const report = {schemaVersion: "opengeo.gpx-import.1", operation: "parse", format: "gpx", version,
    parser: "OpenLayers 10.10.0 GPX + source-preserving normalization", counts, featureCount: features.length,
    sourceProjection: "WGS84", outputProjection: "OGC:CRS84", rejectedRecords,
    originalPreserved: true, segmentPolicy: "separate-features-no-gap-joining", missingElevationPolicy: "XY-with-null-source-elevations",
    timePolicy: "original-text-no-timezone-guessing", extensionPolicy: "retained-in-fields-and-original-never-executed",
    limitations: ["The original GPX remains unchanged when working geometry is edited.", "Device transfer, edited GPX writing and managed conversion are separate operations."]};
  const source = {format: "gpx", filename: String(file.name ?? "track.gpx").slice(0, 240), bytes: bytes.length, sha256,
    gpxVersion: version, creator: root.getAttribute("creator"), metadata: fields(root, new Set(["wpt", "rte", "trk"])),
    originalFile: {encoding: "base64", mediaType: "application/gpx+xml", bytes: bytes.length, sha256, content: base64(bytes)}, report};
  const result = {geojson: {type: "FeatureCollection", features}, source, report};
  if (bytesOf(JSON.stringify(result)).length > GPX_IMPORT_LIMITS.outputBytes) throw error("gpx_output_limit", "The GPX working data and original exceed the 1 MiB import limit.");
  return result;
}

/** Verify the retained source before returning an original-file download. */
export async function originalGpxFile(source) {
  const original = source?.originalFile;
  if (source?.format !== "gpx" || original?.encoding !== "base64" || typeof original.content !== "string"
    || original.content.length > 4 * Math.ceil(GPX_IMPORT_LIMITS.inputBytes / 3)) throw error("gpx_original_invalid", "The original GPX record is invalid.");
  let bytes;
  try {bytes = Uint8Array.from(atob(original.content), c => c.charCodeAt(0));} catch {throw error("gpx_original_invalid", "The original GPX encoding is invalid.");}
  if (bytes.length !== original.bytes || source.bytes !== original.bytes || source.sha256 !== original.sha256
    || bytes.length > GPX_IMPORT_LIMITS.inputBytes || await digest(bytes) !== original.sha256) {
    throw error("gpx_original_checksum", "The original GPX checksum does not match.");
  }
  return {bytes, filename: String(source.filename ?? "original.gpx").replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 240), mediaType: "application/gpx+xml"};
}

export async function downloadOriginalGpx(source) {
  const original = await originalGpxFile(source);
  const url = URL.createObjectURL(new Blob([original.bytes], {type: original.mediaType}));
  const link = document.createElement("a");link.href = url;link.download = original.filename;
  document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 0);
}

function inspectTree(root) {
  const pending = [[root, 0]];let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (++count > GPX_IMPORT_LIMITS.elements || depth > GPX_IMPORT_LIMITS.xmlDepth) throw error("gpx_xml_limit", "The GPX XML is too complex.");
    if ((node.localName?.length ?? 0) > 128 || (node.namespaceURI?.length ?? 0) > 1024) throw error("gpx_xml_limit", "A GPX XML name is too long.");
    for (const attr of node.attributes) if (attr.value.length > GPX_IMPORT_LIMITS.textCharacters) throw error("gpx_text_limit", "A GPX attribute is too long.");
    for (const child of node.childNodes) if ([3, 4].includes(child.nodeType) && child.nodeValue.length > GPX_IMPORT_LIMITS.textCharacters) throw error("gpx_text_limit", "A GPX text field is too long.");
    for (const child of node.children) pending.push([child, depth + 1]);
  }
}

// Flat records keep XML depth independent of project-JSON nesting limits.
function fields(root, skip = new Set()) {
  const result = [], pending = [[root, "0"]];
  while (pending.length) {
    const [node, path] = pending.pop();
    result.push({path, namespace: node.namespaceURI, name: node.localName,
      attributes: [...node.attributes].map(a => ({namespace: a.namespaceURI, name: a.name, value: a.value})),
      text: [...node.childNodes].filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.nodeValue).join("")});
    const children = [...node.children];
    for (let i = children.length - 1; i >= 0; i--) if (!skip.has(children[i].localName) || children[i].namespaceURI !== root.namespaceURI) pending.push([children[i], `${path}/${i}`]);
  }
  return result;
}
async function digest(bytes) {return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");}
function base64(bytes) {let text = "";for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));return btoa(text);}
