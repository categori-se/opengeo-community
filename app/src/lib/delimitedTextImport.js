import {dsvFormat} from "d3";
import {transformSpatialCoordinate} from "./spatialInterchange.js";

export const DELIMITED_IMPORT_LIMITS = Object.freeze({inputBytes: 262_144, outputBytes: 1_048_576, rows: 5_000, columns: 128, cells: 30_000, cellCharacters: 8_192});
const delimiters = new Set([",", "\t", ";", "|"]);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const fail = (code, message, report) => Object.assign(new Error(message), {code, report});
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");

/** Read once; parsing and mapping never request a network resource. */
export async function readDelimitedFile(file) {
  if (!file || typeof file.arrayBuffer !== "function" || file.size > DELIMITED_IMPORT_LIMITS.inputBytes) throw fail("delimited_input_limit", "Choose a delimited file of at most 256 KiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > DELIMITED_IMPORT_LIMITS.inputBytes) throw fail("delimited_input_limit", "Choose a nonempty delimited file of at most 256 KiB.");
  let text;
  try {text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {throw fail("delimited_encoding", "Save the file as UTF-8 before opening it.");}
  const sha256 = await hash(bytes);let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {text, filename: String(file.name ?? "points.csv").slice(0, 240), bytes: bytes.length, sha256,
    originalFile: {encoding: "base64", mediaType: /\.tsv$/i.test(file.name) ? "text/tab-separated-values" : "text/plain", bytes: bytes.length, sha256, content: btoa(binary)}};
}

export function inspectDelimitedText(document, delimiter = ",") {
  if (!delimiters.has(delimiter)) throw fail("delimited_separator", "Choose comma, tab, semicolon or pipe as the separator.");
  // d3 parseRows preserves quoted newlines/escaped quotes without unsafe-eval.
  // Its permissive quote handling needs a strict structural check first.
  const text = document.text.replace(/^\uFEFF/, "");validateQuotes(text, delimiter);
  const [columns = [], ...rows] = dsvFormat(delimiter).parseRows(text);
  if (!columns.length || columns.length > DELIMITED_IMPORT_LIMITS.columns || columns.some(c => !c.trim() || c.length > 160 || ["__proto__", "prototype", "constructor"].includes(c.trim())) || new Set(columns).size !== columns.length) throw fail("delimited_headers", "Use 1–128 unique, nonempty column names of at most 160 characters without reserved object keys.");
  if (!rows.length || rows.length > DELIMITED_IMPORT_LIMITS.rows) throw fail("delimited_rows", "Delimited imports support 1–5000 data records.");
  if (rows.reduce((n, row) => n + row.length, 0) > DELIMITED_IMPORT_LIMITS.cells || [columns, ...rows].some(row => row.length > DELIMITED_IMPORT_LIMITS.columns || row.some(cell => cell.length > DELIMITED_IMPORT_LIMITS.cellCharacters))) throw fail("delimited_cell_limit", "Use at most 30000 values, 128 columns and 8192 characters per value.");
  return {document, delimiter, columns, rows};
}

export function mapDelimitedText(table, {xColumn, yColumn, sourceProjection, elevationColumn = null, elevationUnit = "meter", verticalDatum = "", skipInvalid = false, maximumFeatures = 5_000} = {}) {
  const {columns, rows, document, delimiter} = table;
  if (typeof skipInvalid !== "boolean") throw fail("delimited_omission", "Choose explicitly whether invalid records may be omitted.");
  if (!["EPSG:4326", "EPSG:3857"].includes(sourceProjection)) throw fail("delimited_projection", "Choose the coordinate system used by the source values.");
  if (!columns.includes(xColumn) || !columns.includes(yColumn) || xColumn === yColumn || elevationColumn !== null && (!columns.includes(elevationColumn) || [xColumn, yColumn].includes(elevationColumn))) throw fail("delimited_columns", "Choose distinct coordinate and optional elevation columns.");
  if (![1_000, 5_000].includes(maximumFeatures)) throw fail("delimited_feature_limit", "The feature limit is unsupported.");
  const unit = ({meter: 1, foot: 0.3048, "us-survey-foot": 1200 / 3937})[elevationUnit];
  if (!unit || typeof verticalDatum !== "string" || verticalDatum.length > 240) throw fail("delimited_height", "Choose an elevation unit and a datum description of at most 240 characters.");
  const features = [], rejectedRecords = [];let elevations = 0, missingElevations = 0;
  const number = (value, limit, field) => {
    if (typeof value !== "string" || !decimal.test(value.trim()) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > limit) throw fail("invalid-value", `Invalid or missing ${field}`);
    return Number(value);
  };
  const index = columns.indexOf.bind(columns), geographic = sourceProjection === "EPSG:4326";
  for (const [i, row] of rows.entries()) {
    try {
      if (row.length !== columns.length) throw fail("column-count", "Value count differs from the header");
      const x = number(row[index(xColumn)], geographic ? 180 : 20_037_508.342789244, xColumn);
      const y = number(row[index(yColumn)], geographic ? 90 : 20_037_508.342789244, yColumn);
      const coordinates = transformSpatialCoordinate([x, y], {sourceProjection, targetProjection: "CRS:84"});
      if (elevationColumn !== null) {
        const raw = row[index(elevationColumn)];
        if (raw.trim()) {coordinates.push(number(raw, 100_000 / unit, elevationColumn) * unit);elevations++;} else missingElevations++;
      }
      features.push({type: "Feature", id: `dsv-${document.sha256.slice(0, 12)}-${i + 2}`, properties: Object.fromEntries(columns.map((name, n) => [name, row[n]])), geometry: {type: "Point", coordinates}});
    } catch (error) {rejectedRecords.push({record: i + 2, code: error.code ?? "coordinate-transform", reason: error.message});}
  }
  const mapping = {xColumn, yColumn, sourceProjection, elevationColumn, elevationUnit: elevationColumn === null ? null : elevationUnit, verticalDatum: verticalDatum.trim() || null, skipInvalid: skipInvalid === true};
  const report = {schemaVersion: "opengeo.delimited-import.1", records: rows.length, featureCount: features.length, rejectedRecords, elevations, missingElevations, mapping, fields: "source-strings-unchanged", originalPreserved: true};
  if (rejectedRecords.length && !skipInvalid) throw fail("delimited_invalid_rows", `${rejectedRecords.length} of ${rows.length} records cannot be mapped. Review the records or explicitly omit them.`, report);
  if (!features.length) throw fail("delimited_no_positions", "There are no valid coordinate records to add.", report);
  if (features.length > maximumFeatures) throw fail("delimited_feature_limit", `This map supports at most ${maximumFeatures} imported points. Open a local map for up to 5000 points.`, report);
  const source = {format: "delimited-text", filename: document.filename, bytes: document.bytes, sha256: document.sha256, delimiter, columns: [...columns], originalFile: structuredClone(document.originalFile), report};
  const result = {geojson: {type: "FeatureCollection", features}, source, report};
  if (new TextEncoder().encode(JSON.stringify(result)).length > DELIMITED_IMPORT_LIMITS.outputBytes) throw fail("delimited_output_limit", "The working points and original exceed the 1 MiB import limit.");
  return result;
}

/** Provider reads happen only in the explicit wizard action. This mapper accepts
 * individually selected results bound to the exact original row/query. */
export function mapDelimitedAddresses(table, {addressColumn, resolutions = [], ...options} = {}) {
  if (!table?.columns?.includes(addressColumn) || table.rows.length > 20 || !Array.isArray(resolutions) || resolutions.length > 20)
    throw fail("delimited_address_limit", "Address import supports at most twenty source records and one explicit address column.");
  const chosen = new Map();
  for (const resolution of resolutions) {
    const {record, query, latitude, longitude, id, label, provider, rank} = resolution ?? {};
    if (!Number.isSafeInteger(record) || record < 2 || record > table.rows.length + 1 || chosen.has(record)
      || typeof query !== "string" || query !== table.rows[record - 2][table.columns.indexOf(addressColumn)]?.trim()
      || !query || query.length > 256 || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || typeof id !== "string" || !/^[NWR][0-9]{1,20}$/.test(id)
      || typeof label !== "string" || !label || label.length > 512 || provider !== "Photon/OpenStreetMap"
      || !Number.isSafeInteger(rank) || rank < 1 || rank > 20)
      throw fail("delimited_address_selection", "An address choice is stale, duplicated or outside the governed Photon result contract.");
    if (resolution.sourceSha256 != null && !/^[a-f0-9]{64}$/.test(resolution.sourceSha256))
      throw fail("delimited_address_source", "An address response checksum is invalid.");
    if (resolution.retrievedAt != null && (typeof resolution.retrievedAt !== "string" || resolution.retrievedAt.length > 40
      || !Number.isFinite(Date.parse(resolution.retrievedAt))))
      throw fail("delimited_address_source", "An address retrieval time is invalid.");
    chosen.set(record, {record, query, latitude, longitude, id, label, provider, rank,
      sourceSha256: resolution.sourceSha256 ?? null, retrievedAt: resolution.retrievedAt ?? null,
      attribution: "© OpenStreetMap contributors", license: "ODbL", selected: true});
  }
  const internal = stem => {let name = stem;while (table.columns.includes(name)) name += "_";return name;};
  const xColumn = internal("_opengeo_resolved_longitude"), yColumn = internal("_opengeo_resolved_latitude");
  const columns = [...table.columns, xColumn, yColumn], rows = table.rows.map((row, index) => {
    const selected = chosen.get(index + 2);return [...row, selected ? String(selected.longitude) : "", selected ? String(selected.latitude) : ""];
  });
  let result;
  try {result = mapDelimitedText({...table, columns, rows}, {...options, xColumn, yColumn, sourceProjection: "EPSG:4326"});}
  catch (error) {
    if (error.report?.rejectedRecords) for (const row of error.report.rejectedRecords)
      if (!chosen.has(row.record)) {row.code = "address-unselected";row.reason = "Choose an exact address result, or explicitly omit this source record.";}
    throw error;
  }
  for (const feature of result.geojson.features) {
    delete feature.properties[xColumn];delete feature.properties[yColumn];
    const record = Number(String(feature.id).split("-").at(-1));
    feature["opengeo:geocoding"] = structuredClone(chosen.get(record));
  }
  result.report.mapping = {...result.report.mapping, mode: "selected-address-results", addressColumn,
    xColumn: null, yColumn: null, sourceProjection: null, resultProjection: "EPSG:4326"};
  result.report.geocoding = {provider: "Photon/OpenStreetMap", policy: "one explicitly selected result per original row; provider rank is not confidence",
    selected: result.geojson.features.map(feature => feature["opengeo:geocoding"]), maximumRecords: 20};
  result.source.columns = [...table.columns];result.source.report = result.report;
  for (const row of result.report.rejectedRecords) if (!chosen.has(row.record)) {
    row.code = "address-unselected";row.reason = "No exact address result was selected for this source record.";
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > DELIMITED_IMPORT_LIMITS.outputBytes)
    throw fail("delimited_output_limit", "The original file, selected address provenance and working points exceed the 1 MiB limit.");
  return result;
}

export async function originalDelimitedFile(source) {
  const file = source?.originalFile;
  if (source?.format !== "delimited-text" || file?.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 4 * Math.ceil(DELIMITED_IMPORT_LIMITS.inputBytes / 3)) throw fail("delimited_original", "The original delimited file is invalid.");
  let bytes;
  try {bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));} catch {throw fail("delimited_original", "The original file encoding is invalid.");}
  if (bytes.length !== file.bytes || source.bytes !== file.bytes || bytes.length > DELIMITED_IMPORT_LIMITS.inputBytes || source.sha256 !== file.sha256 || await hash(bytes) !== file.sha256) throw fail("delimited_original_checksum", "The original file checksum does not match.");
  return {bytes, mediaType: file.mediaType === "text/tab-separated-values" ? file.mediaType : "text/plain", filename: source.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "points.csv"};
}

export async function downloadOriginalDelimitedFile(source) {
  const file = await originalDelimitedFile(source), url = URL.createObjectURL(new Blob([file.bytes], {type: file.mediaType}));
  const link = document.createElement("a");link.href = url;link.download = file.filename;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function validateQuotes(text, delimiter) {
  let state = "start";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === "quoted") {
      if (c === '"') {if (text[i + 1] === '"') i++;else state = "closed";}
    } else if (c === delimiter || c === "\n" || c === "\r") state = "start";
    else if (c === '"' && state === "start") state = "quoted";
    else if (c === '"' || state === "closed") throw fail("delimited_quotes", "Quoted values must start and end at a field boundary.");
    else state = "plain";
  }
  if (state === "quoted") throw fail("delimited_quotes", "A quoted value is missing its closing quote.");
}
