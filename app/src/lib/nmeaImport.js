export const NMEA_IMPORT_LIMITS = Object.freeze({
  inputBytes: 262_144, outputBytes: 1_048_576, records: 2_000,
  features: 1_000, lineCharacters: 256, fields: 32
});
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const failure = (code, message, report = {}) => Object.assign(new Error(message), {
  code, report: {schemaVersion: "opengeo.nmea-import.1", operation: "reject", code, ...report}
});
const checksum = body => [...body].reduce((value, character) => value ^ character.charCodeAt(0), 0).toString(16).padStart(2, "0").toUpperCase();
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

/** Local observation files only; sentences never open a device or fetch a source. */
export async function readNmeaFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw failure("nmea_file_required", "Choose an NMEA observation file.");
  if (file.size > NMEA_IMPORT_LIMITS.inputBytes) throw failure("nmea_input_limit", "NMEA files can be at most 256 KiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > NMEA_IMPORT_LIMITS.inputBytes) throw failure("nmea_input_limit", "NMEA files must contain 1–262144 bytes.");
  const offset = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
  if (bytes.subarray(offset).some(value => value > 126 || value < 32 && ![9, 10, 13].includes(value))) {
    throw failure("nmea_encoding", "Use ASCII NMEA sentences, optionally preceded by a UTF-8 BOM.");
  }
  const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(offset));
  const records = text.split(/\r\n|\r|\n/).map((sentence, index) => ({record: index + 1, sentence})).filter(value => value.sentence.trim());
  if (!records.length || records.length > NMEA_IMPORT_LIMITS.records) throw failure("nmea_record_limit", "NMEA imports support 1–2000 nonblank records.");
  for (const {record, sentence} of records) {
    if (sentence.length > NMEA_IMPORT_LIMITS.lineCharacters) throw failure("nmea_line_limit", "NMEA sentences can contain at most 256 characters.", {record});
    if (sentence.split("*")[0].split(",").length > NMEA_IMPORT_LIMITS.fields) throw failure("nmea_field_limit", "NMEA sentences can contain at most 32 fields.", {record});
  }
  // Inspect the complete file before accepting positions: a later receiver datum
  // declaration also governs whether this file can safely be treated as WGS84.
  const datumDeclarations = [];
  for (const {record, sentence} of records) {
    const fields = sentence.trim().split("*")[0].split(","), identifier = fields[0];
    if (identifier === "$PGRMM") {
      const datum = fields[1] ?? "";
      datumDeclarations.push({record, formatter: "PGRMM", datum, sentence, originalPreserved: true});
      if (!["WGS 84", "WGS84"].includes(datum)) throw failure("nmea_datum_conflict", "This NMEA file declares a datum other than WGS84.", {datumDeclarations});
    } else if (/^\$[A-Z0-9]{2}DTM$/.test(identifier) || identifier === "$PGRMC") {
      datumDeclarations.push({record, formatter: identifier.slice(1), sentence, originalPreserved: true});
      throw failure("nmea_datum_unsupported", "NMEA DTM transformations and PGRMC receiver datum configuration are unsupported.", {datumDeclarations});
    }
  }
  const sha256 = await digest(bytes), features = [], rejectedRecords = [], preservedRecords = [];
  const counts = {records: records.length, rmc: 0, gga: 0, positions: 0, elevations: 0, timestamps: 0};
  const reject = (record, code, reason) => rejectedRecords.push({record, code, reason, originalPreserved: true});
  for (const {record, sentence} of records) {
    const star = sentence.indexOf("*"), body = sentence.slice(1, star < 0 ? sentence.length : star);
    const fields = body.split(","), identifier = fields[0], formatter = identifier.slice(2), talker = identifier.slice(0, 2);
    const supported = /^\$[A-Z0-9]{2}(?:RMC|GGA)(?:,|\*|$)/.test(sentence);
    if (!supported) {
      preservedRecords.push({record, formatter: identifier, sentence, fields: [...fields], reason: "Unsupported or non-position sentence retained without mapping.", originalPreserved: true});
      continue;
    }
    counts[formatter.toLowerCase()]++;
    if (star < 0) {reject(record, "checksum-missing", "Checksum is missing."); continue;}
    if (!/^[0-9A-Fa-f]{2}$/.test(sentence.slice(star + 1)) || checksum(body) !== sentence.slice(star + 1).toUpperCase()) {
      reject(record, "checksum-invalid", "Checksum does not match the sentence."); continue;
    }
    try {
      if (fields.length < (formatter === "RMC" ? 10 : 11)) throw failure("malformed-record", "The observation does not contain its required fields.");
      if (formatter === "RMC") {
        if (fields[2] !== "A") throw failure("invalid-fix", "RMC observation has no active fix.");
        if (fields[12] && !["A", "D"].includes(fields[12])) throw failure("unsupported-mode", "RMC mode is unsupported; only absent, A or D modes are mapped.");
        if (fields[13]) throw failure("unsupported-navigation-status", "RMC navigation-status extensions are unsupported.");
      } else if (!["1", "2", "4", "5"].includes(fields[6])) throw failure("invalid-fix", "GGA observation has no supported position fix (quality 1, 2, 4 or 5).");
      const latitude = coordinate(fields[formatter === "RMC" ? 3 : 2], fields[formatter === "RMC" ? 4 : 3], true);
      const longitude = coordinate(fields[formatter === "RMC" ? 5 : 4], fields[formatter === "RMC" ? 6 : 5], false);
      const time = fields[1] || null, date = formatter === "RMC" ? fields[9] || null : null;
      if (time !== null && (!/^\d{6}(?:\.\d+)?$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(2, 4)) > 59 || Number(time.slice(4)) >= 60)) throw failure("invalid-time", "The supplied UTC time is malformed.");
      if (date !== null && (!/^\d{6}$/.test(date) || Number(date.slice(0, 2)) < 1 || Number(date.slice(0, 2)) > 31 || Number(date.slice(2, 4)) < 1 || Number(date.slice(2, 4)) > 12)) throw failure("invalid-date", "The supplied date is malformed.");
      const nmea = {record, sentence, fields: [...fields], talker, formatter, time, date};
      if (formatter === "RMC") {
        optionalNumber(fields[7], 0, 100_000, "speed");optionalNumber(fields[8], 0, 360, "course");
        Object.assign(nmea, {status: fields[2], mode: fields[12] || null, speedKnots: fields[7] || null, courseDegrees: fields[8] || null});
      } else {
        optionalNumber(fields[9], -100_000, 100_000, "MSL altitude");optionalNumber(fields[11], -100_000, 100_000, "geoid separation");
        if (fields[9] && fields[10] !== "M" || fields[11] && fields[12] !== "M") throw failure("unsupported-height-unit", "Supplied GGA altitude and geoid separation must declare metres.");
        Object.assign(nmea, {fixQuality: fields[6], satellites: fields[7] || null, hdop: fields[8] || null,
          altitudeMsl: fields[9] || null, altitudeUnit: fields[10] || null, geoidSeparation: fields[11] || null, geoidUnit: fields[12] || null});
      }
      features.push({type: "Feature", id: "nmea-" + sha256.slice(0, 12) + "-" + record,
        properties: {name: talker + " " + formatter + " observation " + record, nmea},
        geometry: {type: "Point", coordinates: [longitude, latitude]}});
      counts.positions++;if (time !== null) counts.timestamps++;
      if (formatter === "GGA" && fields[9]) counts.elevations++;
    } catch (cause) {
      reject(record, cause.code ?? "malformed-record", cause.message);
    }
    if (features.length > NMEA_IMPORT_LIMITS.features) throw failure("nmea_feature_limit", "NMEA imports support at most 1000 observation Points.");
  }
  if (!features.length) throw failure("nmea_no_positions", "This NMEA file contains no supported valid observation positions.", {counts, rejectedRecords, preservedRecords, datumDeclarations});
  const report = {schemaVersion: "opengeo.nmea-import.1", operation: "parse", format: "nmea",
    parser: "Bounded RMC/GGA reader; Garmin GPS15 Technical Specification Rev B sections 4.1/4.2.3/4.2.6/4.2.8",
    counts, featureCount: features.length, rejectedRecords, preservedRecords, datumDeclarations,
    sourceProjection: "WGS84-requires-user-confirmation", outputProjection: "OGC:CRS84",
    coordinateReferencePolicy: "user-confirmation-required", originalPreserved: true,
    observationPolicy: "separate-points-no-time-or-talker-merging", timePolicy: "source-text-no-century-inference",
    elevationPolicy: "source-MSL-property-only-XY-geometry", datumConfirmationRequired: true,
    limitations: ["Only active RMC with absent/A/D mode and GGA quality 1/2/4/5 are mapped.", "Unsupported sentences remain in the original; device transfer, streams and track reconstruction are separate operations."]};
  let binary = "";for (const byte of bytes) binary += String.fromCharCode(byte);
  const source = {format: "nmea", filename: String(file.name ?? "observations.nmea").slice(0, 240), bytes: bytes.length, sha256,
    originalFile: {encoding: "base64", mediaType: "text/plain", bytes: bytes.length, sha256, content: btoa(binary)}, report};
  const result = {geojson: {type: "FeatureCollection", features}, source, report};
  if (new TextEncoder().encode(JSON.stringify(result)).length > NMEA_IMPORT_LIMITS.outputBytes) throw failure("nmea_output_limit", "The NMEA working data and original exceed the 1 MiB import limit.");
  return result;
}

function coordinate(value, hemisphere, latitude) {
  const match = (latitude ? /^(\d{2})(\d{2}(?:\.\d+)?)$/ : /^(\d{3})(\d{2}(?:\.\d+)?)$/).exec(value ?? "");
  if (!match || !(latitude ? ["N", "S"] : ["E", "W"]).includes(hemisphere)) throw failure("invalid-coordinate", "The coordinate or hemisphere is missing or malformed.");
  const degrees = Number(match[1]), minutes = Number(match[2]), maximum = latitude ? 90 : 180;
  if (!Number.isFinite(minutes) || minutes >= 60 || degrees > maximum || degrees === maximum && minutes !== 0) throw failure("invalid-coordinate", "The coordinate degrees or minutes are outside their valid range.");
  const result = degrees + minutes / 60;
  return ["S", "W"].includes(hemisphere) ? -result : result;
}

function optionalNumber(value, minimum, maximum, field) {
  if (value === undefined || value === "") return;
  if (!decimal.test(value) || !Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw failure("invalid-value", "The supplied " + field + " is invalid.");
}

/** The source is independent of edits to the working observation Points. */
export async function originalNmeaFile(source) {
  const original = source?.originalFile;
  if (source?.format !== "nmea" || original?.encoding !== "base64" || typeof original.content !== "string"
    || original.content.length > 4 * Math.ceil(NMEA_IMPORT_LIMITS.inputBytes / 3)) throw failure("nmea_original_invalid", "The original NMEA record is invalid.");
  let bytes;
  try {bytes = Uint8Array.from(atob(original.content), character => character.charCodeAt(0));} catch {throw failure("nmea_original_invalid", "The original NMEA encoding is invalid.");}
  if (!bytes.length || bytes.length !== original.bytes || source.bytes !== original.bytes || source.sha256 !== original.sha256
    || bytes.length > NMEA_IMPORT_LIMITS.inputBytes || await digest(bytes) !== original.sha256) throw failure("nmea_original_checksum", "The original NMEA checksum does not match.");
  return {bytes, filename: String(source.filename ?? "observations.nmea").replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 240), mediaType: "text/plain"};
}

export async function downloadOriginalNmea(source) {
  const original = await originalNmeaFile(source), url = URL.createObjectURL(new Blob([original.bytes], {type: original.mediaType}));
  const link = document.createElement("a");link.href = url;link.download = original.filename;
  document.body.append(link);link.click();link.remove();setTimeout(() => URL.revokeObjectURL(url), 0);
}
