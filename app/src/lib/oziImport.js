export const OZI_IMPORT_LIMITS = Object.freeze({
  inputBytes: 262_144, outputBytes: 1_048_576, records: 2_000,
  positions: 2_000, features: 1_000, lineCharacters: 2_048, fields: 24
});

const headers = Object.freeze({
  wpt: "OziExplorer Waypoint File Version 1.1",
  plt: "OziExplorer Track Point File Version 2.1"
});
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const failure = (code, message, report = {}) => Object.assign(new Error(message), {
  code, report: {schemaVersion: "opengeo.ozi-import.1", operation: "reject", format: "ozi", code, ...report}
});
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

/** A bounded local-file subset; retained Ozi fields never execute or fetch attachments. */
export async function readOziFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw failure("ozi_file_required", "Choose an Ozi waypoint or track file.");
  const extension = String(file.name ?? "").split(".").at(-1).toLowerCase();
  if (["rte", "pnt", "evt"].includes(extension)) throw failure("ozi_variant_unsupported", "Ozi routes, point sets and events are unsupported; choose a WPT waypoint or ordinary PLT track file.");
  if (!["wpt", "plt"].includes(extension)) throw failure("ozi_extension", "Choose an Ozi .wpt or .plt file.");
  if (file.size > OZI_IMPORT_LIMITS.inputBytes) throw failure("ozi_input_limit", "Ozi files can be at most 256 KiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > OZI_IMPORT_LIMITS.inputBytes) throw failure("ozi_input_limit", "Ozi files must contain 1–262144 bytes.");
  const offset = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
  if (bytes.subarray(offset).some(value => value > 126 || value < 32 && ![9, 10, 13].includes(value))) {
    throw failure("ozi_encoding", "Use ASCII Ozi text, optionally preceded by a UTF-8 BOM. Other encodings are unsupported.");
  }
  const lines = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(offset)).split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].length > OZI_IMPORT_LIMITS.lineCharacters) throw failure("ozi_line_limit", "Ozi lines can contain at most 2048 characters.", {record: index + 1});
    if (lines[index].split(",").length > OZI_IMPORT_LIMITS.fields) throw failure("ozi_field_limit", "Ozi lines can contain at most 24 fields.", {record: index + 1});
  }
  const variant = Object.keys(headers).find(key => lines[0] === headers[key]);
  if (!variant) throw failure("ozi_version_unsupported", "Only Ozi Waypoint Version 1.1 and Track Point Version 2.1 are supported.");
  if (variant !== extension) throw failure("ozi_variant_mismatch", "The Ozi header does not match the file extension.");
  const headerCount = variant === "wpt" ? 4 : 6;
  if (lines.length < headerCount) throw failure("ozi_header", "The Ozi file is missing required header lines.");
  if (!["WGS 84", "WGS84"].includes(lines[1])) throw failure("ozi_datum_unsupported", "Only an explicit WGS 84 or WGS84 datum header is supported.", {datum: lines[1]});
  const headerRecords = lines.slice(0, headerCount).map((line, index) => ({record: index + 1, line, fields: line.split(","), originalPreserved: true}));
  let trackStyle;
  if (variant === "plt") {
    trackStyle = lines[4].split(",");
    if (trackStyle.length !== 8) throw failure("ozi_track_style", "PLT track headers must contain exactly eight style fields.", {headerRecords});
    for (const index of [0, 1, 2, 4, 6, 7]) optionalNumber(trackStyle[index], "track style");
    if (trackStyle[0].trim() !== "0") throw failure("ozi_track_style", "The PLT style record must begin with zero.", {headerRecords});
    if (trackStyle[5].trim() !== "0") throw failure("ozi_track_type_unsupported", "Only ordinary PLT tracks (type 0) are supported; polygon and alarm-zone tracks are unsupported.", {headerRecords});
    // The primary format explicitly ignores line 6 when determining point count.
  }
  const rows = lines.slice(headerCount);
  if (!rows.length || rows.length > OZI_IMPORT_LIMITS.records) throw failure("ozi_record_limit", "Ozi imports support 1–2000 data records.");
  const sha256 = await digest(bytes), features = [], rejectedRecords = [];
  const counts = {records: rows.length, positions: 0, features: 0, waypoints: 0, segments: 0, elevations: 0, timestamps: 0};
  let run = [];
  const addFeature = feature => {
    features.push(feature);
    counts.features = features.length;
    if (features.length > OZI_IMPORT_LIMITS.features) throw failure("ozi_feature_limit", "Ozi imports support at most 1000 working features.", {counts});
  };
  const flush = () => {
    if (!run.length) return;
    counts.segments++;
    const singleton = run.length === 1;
    addFeature({type: "Feature", id: "ozi-" + sha256.slice(0, 12) + "-segment-" + counts.segments,
      properties: {name: trackStyle[3] || "Track segment " + counts.segments,
        ozi: {variant, segment: counts.segments, points: run.map(point => point.source)}},
      geometry: {type: singleton ? "Point" : "LineString", coordinates: singleton ? run[0].coordinates : run.map(point => point.coordinates)}});
    run = [];
  };
  for (let index = 0; index < rows.length; index++) {
    const line = rows[index], record = headerCount + index + 1, fields = line.split(","), rowId = "ozi-" + sha256.slice(0, 12) + "-" + record;
    try {
      if (variant === "wpt" ? fields.length < 4 : fields.length !== 7) throw failure("malformed-record", variant === "wpt" ? "A waypoint needs 4–24 fields." : "A trackpoint needs exactly seven fields, retaining empty optional fields.");
      const latitude = coordinate(fields[variant === "wpt" ? 2 : 0], 90), longitude = coordinate(fields[variant === "wpt" ? 3 : 1], 180);
      if (variant === "wpt") {
        for (const field of [0, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) optionalNumber(fields[field], "waypoint field " + (field + 1));
      } else {
        if (!["0", "1"].includes(fields[2].trim())) throw failure("unsupported-segment-code", "Only PLT segment codes 0 and 1 are supported.");
        optionalNumber(fields[3], "altitude");optionalNumber(fields[4], "Delphi date");
      }
      const altitudeFeet = fields[variant === "wpt" ? 14 : 3] ?? null, dateSerial = fields[4] ?? null;
      const source = {rowId, record, line, fields: [...fields], altitudeFeet, dateSerial,
        dateText: variant === "plt" ? fields[5] : null, timeText: variant === "plt" ? fields[6] : null};
      if (variant === "wpt") {
        addFeature({type: "Feature", id: rowId, properties: {name: fields[1] || "Waypoint " + record, ozi: {variant, ...source}}, geometry: {type: "Point", coordinates: [longitude, latitude]}});
        counts.waypoints++;
      } else {
        if (fields[2].trim() === "1") flush();
        run.push({source, coordinates: [longitude, latitude]});
      }
      counts.positions++;
      if (counts.positions > OZI_IMPORT_LIMITS.positions) throw failure("ozi_position_limit", "Ozi imports support at most 2000 positions.", {counts});
      if (altitudeFeet !== null && altitudeFeet.trim() !== "" && Number(altitudeFeet) !== -777) counts.elevations++;
      if (dateSerial !== null && dateSerial.trim() !== "") counts.timestamps++;
    } catch (cause) {
      // Global bounds abort the import; row errors remain reviewable omissions.
      if (String(cause.code).startsWith("ozi_")) throw cause;
      if (variant === "plt") flush();
      rejectedRecords.push({record, rowId, line, fields: [...fields], code: cause.code ?? "malformed-record", reason: cause.message, originalPreserved: true});
    }
  }
  if (variant === "plt") flush();
  if (!features.length) throw failure("ozi_no_positions", "This Ozi file contains no supported valid positions.", {counts, rejectedRecords, headerRecords});
  const report = {schemaVersion: "opengeo.ozi-import.1", operation: "parse", format: "ozi", variant,
    parser: "Bounded Ozi WPT 1.1 / ordinary PLT 2.1 reader", counts, featureCount: features.length, rejectedRecords, headerRecords,
    sourceProjection: "WGS84", sourceDatum: lines[1], outputProjection: "OGC:CRS84", coordinateReferencePolicy: "explicit-source-header",
    sourceEncoding: offset ? "ASCII-with-UTF8-BOM" : "ASCII", originalPreserved: true, pointCountHeaderIgnored: variant === "plt",
    elevationPolicy: "raw-feet-property-only-XY-geometry-no-vertical-datum-inference", timePolicy: "raw-Delphi-and-text-no-timezone-inference",
    trackPolicy: "code-1-and-rejected-records-break-continuity-singletons-remain-Points",
    limitations: ["Only ASCII WPT 1.1 waypoints and ordinary PLT 2.1 tracks declaring WGS 84 are mapped; routes, events, point sets, other versions, datums and encodings are unsupported.",
      "Ozi styling and attachments are retained without applying styles, opening links or executing files.",
      "Altitude feet and Delphi/text dates stay as source properties; -777 is invalid altitude. No height conversion, vertical datum, foot definition or timezone is assumed.",
      "PLT text date/time fields are retained but do not supply timestamps when the numeric date is empty."]};
  let binary = "";for (const byte of bytes) binary += String.fromCharCode(byte);
  const source = {format: "ozi", variant, filename: String(file.name ?? ("source." + variant)).slice(0, 240), bytes: bytes.length, sha256,
    originalFile: {encoding: "base64", mediaType: "text/plain", bytes: bytes.length, sha256, content: btoa(binary)}, report};
  const result = {geojson: {type: "FeatureCollection", features}, source, report};
  if (new TextEncoder().encode(JSON.stringify(result)).length > OZI_IMPORT_LIMITS.outputBytes) throw failure("ozi_output_limit", "The Ozi working data and original exceed the 1 MiB import limit.", {counts});
  return result;
}

function coordinate(value, maximum) {
  const text = value?.trim();
  if (!text || !decimal.test(text) || !Number.isFinite(Number(text)) || Math.abs(Number(text)) > maximum) throw failure("invalid-coordinate", "The latitude or longitude is missing, malformed or outside its valid range.");
  return Number(text);
}

function optionalNumber(value, field) {
  if (value === undefined || value.trim() === "") return;
  if (!decimal.test(value.trim()) || !Number.isFinite(Number(value))) throw failure("invalid-value", "The supplied " + field + " is not a finite decimal number.");
}

/** Original bytes are independent of edits to working geometry and properties. */
export async function originalOziFile(source) {
  const original = source?.originalFile;
  if (source?.format !== "ozi" || !["wpt", "plt"].includes(source.variant) || original?.encoding !== "base64" || typeof original.content !== "string"
    || original.content.length > 4 * Math.ceil(OZI_IMPORT_LIMITS.inputBytes / 3)) throw failure("ozi_original_invalid", "The original Ozi record is invalid.");
  let bytes;
  try {bytes = Uint8Array.from(atob(original.content), character => character.charCodeAt(0));} catch {throw failure("ozi_original_invalid", "The original Ozi encoding is invalid.");}
  if (!bytes.length || bytes.length !== original.bytes || source.bytes !== original.bytes || source.sha256 !== original.sha256
    || bytes.length > OZI_IMPORT_LIMITS.inputBytes || await digest(bytes) !== original.sha256) throw failure("ozi_original_checksum", "The original Ozi checksum does not match.");
  return {bytes, filename: String(source.filename ?? ("source." + source.variant)).replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 240), mediaType: "text/plain"};
}

export async function downloadOriginalOzi(source) {
  const original = await originalOziFile(source), url = URL.createObjectURL(new Blob([original.bytes], {type: original.mediaType}));
  const link = document.createElement("a");link.href = url;link.download = original.filename;
  document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 0);
}
