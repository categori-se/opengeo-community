import {featureFilter} from "@maplibre/maplibre-gl-style-spec";
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {validateMapFilter} from "./mapFilter.js";

// Reuse the authored table's scalar bounds without parsing source attributes as
// authored CSV. A Print snapshot retains a small view of already loaded records.
const MAXIMUM_ROWS = 12, MAXIMUM_COLUMNS = 4, MAXIMUM_SCAN = 5000;
const CELL_KINDS = new Set(["value", "missing", "null", "blank", "structured", "too-long", "out-of-range", "nonfinite", "unsupported", "nonnumeric"]);
const PIN_KEYS = ["layerId", "datasetId", "datasetVersionId", "sourceVersion"];
const SNAPSHOT_KEYS = ["frameId", "signature", "type", "columns", "rows", "cellKinds", "rawValues", "sourcePin", "scopeText", "notices", "loadedCount", "scannedCount", "matchedCount", "rowLimited", "scanLimited", "checksumSha256"];
const hex = value => [...sha256(new TextEncoder().encode(canonicalJson(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const text = (value, maximum = 100) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const field = value => text(value, 100) && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value.toLowerCase());
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const scalar = value => value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 300
  || typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
function fail(message = "This Print data frame needs a new capture from its complete loaded Layer.") {throw Error(message);}
function plain(value) {return value !== null && typeof value === "object" && !Array.isArray(value);}
function validSource(value) {
  return plain(value) && PIN_KEYS.every(key => own(value, key)) && text(value.layerId) && (value.datasetId === null || text(value.datasetId))
    && (value.datasetVersionId === null || text(value.datasetVersionId))
    && (value.sourceVersion === null || text(value.sourceVersion) || integer(value.sourceVersion));
}
function sameSource(left, right) {return PIN_KEYS.every(key => left[key] === right[key]);}
function configuration(frame, presentation) {
  if (!plain(frame) || !text(frame.id) || !text(frame.mapFrameId) || !validSource(frame.source)
    || !["table", "chart"].includes(frame.type) || !integer(frame.rowLimit, MAXIMUM_ROWS) || frame.rowLimit < 1) fail("Invalid Print data frame configuration.");
  if (!Array.isArray(presentation) || presentation.length > 250) fail();
  const matches = presentation.filter(layer => layer.layerId === frame.source.layerId);
  if (matches.length !== 1) fail("The Print data frame's Layer is missing from its map frame.");
  const selected = matches[0], pin = {layerId: selected.layerId, datasetId: selected.datasetId ?? null,
    datasetVersionId: selected.datasetVersionId ?? null, sourceVersion: selected.sourceVersion ?? null};
  if (!validSource(pin) || !sameSource(pin, frame.source)) fail("The Print data frame's saved Layer source changed. Review its source and capture again.");
  const filter = selected.filter ?? null;
  validateMapFilter(filter);
  const result = {type: frame.type, mapFrameId: frame.mapFrameId, source: {...frame.source}, rowLimit: frame.rowLimit,
    presentation: {...pin, managedDisplayId: selected.managedDisplayId ?? null, filter}};
  if (frame.type === "table") {
    if (!Array.isArray(frame.columns) || !frame.columns.length || frame.columns.length > MAXIMUM_COLUMNS
      || frame.columns.some(column => !field(column)) || new Set(frame.columns).size !== frame.columns.length) fail("Choose one to four distinct Print table fields.");
    result.columns = [...frame.columns];
  } else {
    if (!["bar", "line"].includes(frame.chartType) || !field(frame.labelField) || !field(frame.valueField)
      || frame.labelField === frame.valueField) fail("Choose distinct chart label and numeric value fields.");
    result.chartType = frame.chartType;result.labelField = frame.labelField;result.valueField = frame.valueField;
  }
  return result;
}

export function printDataFrameSignature(frame, presentation) {return hex(configuration(frame, presentation));}

/** Discover only a bounded set of names. This never loads or requests a source. */
export function printDataSourceFields(context, layerId) {
  const source = context?.getPrintDataSource?.(layerId), data = source?.geojson;
  if (source?.id !== layerId || data?.type !== "FeatureCollection" || !Array.isArray(data.features) || data.opengeo?.mayBeTruncated) return [];
  const fields = new Set();
  for (let index = 0; index < Math.min(100, data.features.length); index++) {
    const properties = data.features[index]?.properties;
    if (!plain(properties)) continue;
    let examined = 0;
    for (const key in properties) {
      if (++examined > 256) break;
      if (own(properties, key) && field(key)) fields.add(key);
      if (fields.size === 64) return [...fields];
    }
  }
  return [...fields];
}

function sourceForFrame(context, frame, config) {
  if (config.presentation.managedDisplayId) fail("A tiled display has no complete loaded attribute table for this Print data frame.");
  const input = context?.getPrintDataSource?.(frame.source.layerId), data = input?.geojson, pin = input?.inputPin;
  if (input?.id !== frame.source.layerId || data?.type !== "FeatureCollection" || !Array.isArray(data.features)
    || data.opengeo?.mayBeTruncated || data.opengeo?.schemaVersion === "opengeo.live-feature-page.1.0.0"
    || !validSource(pin) || !sameSource(pin, frame.source)) fail("Load this complete Layer with its saved source/version before capturing Print data.");
  const featureGeneration = pin.featureGeneration ?? null, checksumSha256 = pin.checksumSha256 ?? null;
  if (featureGeneration !== null && !integer(featureGeneration)
    || checksumSha256 !== null && (typeof checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksumSha256))) fail("The loaded Layer's source receipt is invalid.");
  return {data, sourcePin: {...frame.source, featureGeneration, checksumSha256}};
}

function tableCell(properties, key) {
  if (!own(properties, key) || properties[key] === undefined) return {value: "[missing]", kind: "missing"};
  const value = properties[key];
  if (value === null) return {value: null, kind: "null"};
  if (value === "") return {value, kind: "blank"};
  if (typeof value === "string") return value.length <= 300 ? {value, kind: "value"} : {value: "[text exceeds 300 characters]", kind: "too-long"};
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return {value: "[nonfinite number]", kind: "nonfinite"};
    return Math.abs(value) <= 1e15 ? {value, kind: "value"} : {value: "[number outside supported range]", kind: "out-of-range"};
  }
  if (typeof value === "boolean") return {value, kind: "value"};
  return typeof value === "object" ? {value: "[structured value]", kind: "structured"} : {value: "[unsupported value]", kind: "unsupported"};
}

/** Capture first matching rows from complete data already admitted by Workbench. */
export function capturePrintDataFrames(context, mapRecord, frames, presentation) {
  if (!Array.isArray(frames) || frames.length > 4 || new Set(frames.map(frame => frame?.id)).size !== frames.length) fail("A Print layout supports at most four distinct data frames.");
  return frames.map(frame => {
    const config = configuration(frame, presentation);
    const canonicalLayer = mapRecord?.definition?.layers?.find(layer => layer.layerId === frame.source.layerId);
    if (!canonicalLayer || !sameSource({layerId: canonicalLayer.layerId, datasetId: canonicalLayer.datasetId ?? null,
      datasetVersionId: canonicalLayer.datasetVersionId ?? null, sourceVersion: canonicalLayer.sourceVersion ?? null}, frame.source)) fail("The Print data frame no longer matches this Project's Layer source.");
    const {data, sourcePin} = sourceForFrame(context, frame, config);
    const filter = featureFilter(config.presentation.filter ?? undefined, "printDataFrame.filter");
    if (filter.needGeometry || filter.getGlobalStateRefs().size) fail("This map filter cannot be used for a Print data frame.");
    const currentZoom = context?.map?.getZoom?.() ?? 0;
    if (!Number.isFinite(currentZoom)) fail("The Print map zoom is unavailable.");
    const columns = frame.type === "table" ? [...frame.columns] : [frame.labelField, frame.valueField];
    const rows = [], cellKinds = [], rawValues = frame.type === "chart" ? [] : null, counts = new Map();
    const loadedCount = data.features.length, scannedCount = Math.min(loadedCount, MAXIMUM_SCAN);
    let matchedCount = 0;
    for (let index = 0; index < scannedCount; index++) {
      const feature = data.features[index];
      if (!plain(feature) || feature.type !== "Feature" || feature.properties !== null && feature.properties !== undefined && !plain(feature.properties)) fail("The loaded Layer has an invalid feature record.");
      if (feature.geometry !== null && (!plain(feature.geometry) || !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"].includes(feature.geometry.type))) fail("The loaded Layer has an invalid feature geometry.");
      const type = {Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3, GeometryCollection: 0}[feature.geometry?.type] ?? 0;
      if (!filter.filter({zoom: currentZoom}, {id: feature.id, type, properties: feature.properties ?? {}})) continue;
      matchedCount++;
      if (rows.length >= frame.rowLimit) continue;
      const cells = columns.map(column => tableCell(feature.properties, column));
      if (frame.type === "chart") {
        const cell = cells[1];rawValues.push(cell.value);
        if (cell.kind === "value" && typeof cell.value !== "number") cells[1] = {value: null, kind: "nonnumeric"};
        else if (cell.kind !== "value") cells[1] = {value: null, kind: cell.kind};
      }
      rows.push(cells.map(cell => cell.value));cellKinds.push(cells.map(cell => cell.kind));
      for (const cell of cells) if (cell.kind !== "value") counts.set(cell.kind, (counts.get(cell.kind) ?? 0) + 1);
    }
    const rowLimited = matchedCount > rows.length, scanLimited = loadedCount > scannedCount;
    const scopeText = `${rows.length} rows shown from ${matchedCount} matching records among ${scannedCount} of ${loadedCount} loaded records scanned.`
      + (rowLimited ? ` First ${frame.rowLimit} matching rows retained; row limit reached.` : "")
      + (scanLimited ? ` The ${MAXIMUM_SCAN}-record scan limit leaves ${loadedCount - scannedCount} loaded records unexamined.` : "")
      + " Counts describe loaded records.";
    const notices = [...counts].map(([kind, count]) => notice(kind, count, frame.type));
    if (frame.type === "chart" && !rows.some(row => typeof row[1] === "number")) notices.push("No finite numeric values are available in the shown rows.");
    const snapshot = {frameId: frame.id, signature: printDataFrameSignature(frame, presentation), type: frame.type,
      columns, rows, cellKinds, rawValues, sourcePin, scopeText, notices, loadedCount, scannedCount, matchedCount, rowLimited, scanLimited};
    snapshot.checksumSha256 = hex(snapshot);
    return assertPrintDataFrameSnapshot(frame, snapshot, presentation);
  });
}

function notice(kind, count, type) {
  const descriptions = {missing: "missing fields", null: "null values", blank: "blank strings", structured: "structured values",
    "too-long": "text values exceeding 300 characters", "out-of-range": "numbers outside the supported ±1e15 range",
    nonfinite: "nonfinite numbers", unsupported: "unsupported values", nonnumeric: "nonnumeric chart values (including numeric strings and booleans)"};
  return `${count} ${descriptions[kind]} in the shown cells${type === "chart" ? "; unavailable numeric values are gaps" : "; source values remain unchanged"}.`;
}

/** Validate bounded snapshot bytes and configuration before composing output. */
export function assertPrintDataFrameSnapshot(frame, snapshot, presentation) {
  const config = configuration(frame, presentation), columns = frame.type === "table" ? frame.columns : [frame.labelField, frame.valueField];
  if (!plain(snapshot) || Object.keys(snapshot).length !== SNAPSHOT_KEYS.length || Object.keys(snapshot).some(key => !SNAPSHOT_KEYS.includes(key))
    || snapshot.frameId !== frame.id || snapshot.type !== frame.type || snapshot.signature !== hex(config)
    || !Array.isArray(snapshot.columns) || snapshot.columns.length !== columns.length || snapshot.columns.some(column => !field(column))
    || canonicalJson(snapshot.columns) !== canonicalJson(columns)
    || !Array.isArray(snapshot.rows) || snapshot.rows.length > frame.rowLimit
    || snapshot.rows.some(row => !Array.isArray(row) || row.length !== columns.length || row.some(value => !scalar(value)))
    || !Array.isArray(snapshot.cellKinds) || snapshot.cellKinds.length !== snapshot.rows.length
    || snapshot.cellKinds.some(row => !Array.isArray(row) || row.length !== columns.length || row.some(kind => !CELL_KINDS.has(kind)))
    || !validSource(snapshot.sourcePin) || Object.keys(snapshot.sourcePin).length !== 6
    || !sameSource(snapshot.sourcePin, frame.source) || !own(snapshot.sourcePin, "featureGeneration") || !own(snapshot.sourcePin, "checksumSha256")
    || snapshot.sourcePin.featureGeneration !== null && !integer(snapshot.sourcePin.featureGeneration)
    || snapshot.sourcePin.checksumSha256 !== null && (typeof snapshot.sourcePin.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.sourcePin.checksumSha256))
    || typeof snapshot.scopeText !== "string" || snapshot.scopeText.length > 600
    || !Array.isArray(snapshot.notices) || snapshot.notices.length > 16 || snapshot.notices.some(value => !text(value, 300))
    || !integer(snapshot.loadedCount) || !integer(snapshot.scannedCount, MAXIMUM_SCAN) || snapshot.scannedCount !== Math.min(MAXIMUM_SCAN, snapshot.loadedCount)
    || !integer(snapshot.matchedCount, snapshot.scannedCount) || snapshot.rows.length !== Math.min(frame.rowLimit, snapshot.matchedCount)
    || snapshot.rowLimited !== (snapshot.matchedCount > snapshot.rows.length) || snapshot.scanLimited !== (snapshot.loadedCount > snapshot.scannedCount)
    || typeof snapshot.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.checksumSha256)) fail("The Print data snapshot is stale or invalid. Capture its Layer again.");
  if (frame.type === "chart") {
    if (!Array.isArray(snapshot.rawValues) || snapshot.rawValues.length !== snapshot.rows.length || snapshot.rawValues.some(value => !scalar(value))
      || snapshot.rows.some(row => row[1] !== null && typeof row[1] !== "number")) fail("The Print chart snapshot is invalid. Capture its Layer again.");
  } else if (snapshot.rawValues !== null) fail();
  const {checksumSha256, ...content} = snapshot;
  if (hex(content) !== checksumSha256) fail("The Print data snapshot checksum changed. Capture its Layer again.");
  return snapshot;
}
