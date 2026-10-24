import {cogDisplayOptions, isCogLayer} from "./cogDisplay.js";

const DESCRIPTOR_KEYS = ["layerId", "title", "band", "displayRange", "noDataValue", "sourceNoDataValue", "opacity", "sourcePin", "note"];
const PIN_KEYS = ["layerId", "datasetId", "datasetVersionId", "sourceVersion"];
const failure = () => Error("The raster display changed or is unavailable. Wait for its current view to finish loading before capturing its legend.");
const closed = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
const nullableId = value => value === null || text(value, 100);
const validRange = value => closed(value, ["minimum", "maximum"]) && Number.isFinite(value.minimum)
  && Number.isFinite(value.maximum) && value.minimum < value.maximum && Number.isFinite(value.maximum - value.minimum);
const sameRange = (left, right) => left === null && right === null
  || validRange(left) && validRange(right) && left.minimum === right.minimum && left.maximum === right.maximum;
const validPin = value => closed(value, PIN_KEYS) && text(value.layerId, 100)
  && nullableId(value.datasetId) && nullableId(value.datasetVersionId)
  && (value.sourceVersion === null || Number.isSafeInteger(value.sourceVersion) && value.sourceVersion > 0);
const pinFor = layer => ({layerId: layer.layerId, datasetId: layer.datasetId ?? null,
  datasetVersionId: layer.datasetVersionId ?? null, sourceVersion: layer.sourceVersion ?? null});
const samePin = (left, right) => PIN_KEYS.every(key => left[key] === right[key]);

function transparencyLabel(group) {
  return `Transparent: nonfinite values${group.sourceNoDataValue === null ? "" : `; source NoData ${group.sourceNoDataValue}`}${group.noDataValue === null ? "" : `; explicit value ${group.noDataValue}`}`;
}

function legendDescription(group) {
  const note = `Linear grayscale display; values outside ${group.displayRange.minimum} to ${group.displayRange.maximum} are clamped to endpoint colors. ${transparencyLabel(group)}. Explicit transparency uses source sample precision. Colors are shown before map opacity (${group.opacity}) and background blending. The loaded raster preview remains cached imagery; Print DPI adds no source detail.`;
  const noData = {color: "none", label: transparencyLabel(group)};
  return {note, noData, rows: [
    {label: `${group.title} · Band ${group.band} ${group.displayRange.minimum}`, color: "#000000"},
    {label: `${group.title} · Band ${group.band} ${group.displayRange.maximum}`, color: "#ffffff"},
    {label: `${group.title} · ${noData.label}`, color: "none"}, {label: note}
  ]};
}

function unavailable(layer, reason) {
  return {rows: [{label: `${layer.title} · Raster color bar unavailable: ${reason}. The captured map retains its raster display.`}]};
}

// Inspect only the settled, already decoded view. Never read values or request a
// new window just to construct a legend; provider identities stay in the handle.
export function capturePrintRasterLegend(layer, handle, paints) {
  if (!isCogLayer(layer)) return null;
  if (!text(layer.title, 500) || !validPin(pinFor(layer)) || layer.visible === false) throw failure();
  const managed = layer.sourceType === "governed-dataset";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (managed && (!uuid.test(layer.datasetId ?? "") || !uuid.test(layer.datasetVersionId ?? "")
    || layer.sourceUrl != null)) throw failure();
  const sourceIdentity = managed
    ? `urn:opengeo:dataset:${layer.datasetId}:version:${layer.datasetVersionId}:original` : layer.sourceUrl;
  const cog = handle?.cog, grid = cog?.grid, result = cog?.result;
  const bands = layer.sourceConfiguration?.bands;
  if (!cog || cog.loading !== false || !result || !grid || typeof grid.active !== "function" || !grid.active()
    || !Array.isArray(bands) || ![1, 3].includes(bands.length)
    || bands.some(band => !Number.isSafeInteger(band) || band < 1 || band > 64)
    || !Array.isArray(grid.metadata?.bands) || grid.metadata.bands.length !== bands.length
    || bands.some((band, index) => band !== grid.metadata.bands[index])
    || typeof sourceIdentity !== "string" || !sourceIdentity.length || grid.metadata?.source?.url !== sourceIdentity
    || !Array.isArray(paints) || paints.length !== 1 || paints[0]?.type !== "raster" || paints[0].layout?.visibility === "none"
    || handle.sourceId && paints[0].source !== handle.sourceId) throw failure();
  const options = cogDisplayOptions(layer), range = options.displayRange ?? null;
  if (!sameRange(result.displayRange, range) || result.noDataValue !== (options.noDataValue ?? null)) throw failure();
  const opacity = layer.opacity ?? 1, paint = paints[0].paint ?? {};
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || (paint["raster-opacity"] ?? 1) !== opacity) throw failure();
  if (bands.length !== 1) return unavailable(layer, "RGB imagery has no single numeric grayscale range");
  if (!range) return unavailable(layer, "choose an explicit grayscale display range");
  const supportedPaint = {"raster-opacity": opacity, "raster-hue-rotate": 0, "raster-brightness-min": 0,
    "raster-brightness-max": 1, "raster-saturation": 0, "raster-contrast": 0, "raster-fade-duration": 0};
  if (Object.entries(paint).some(([key, value]) => key === "raster-resampling"
    ? !["linear", "nearest"].includes(value) : !Object.hasOwn(supportedPaint, key) || value !== supportedPaint[key])) {
    return unavailable(layer, "the installed raster paint changes or animates its colors");
  }
  const sourceNoDataValue = grid.metadata.noData;
  if (sourceNoDataValue !== null && sourceNoDataValue !== "NaN" && !Number.isFinite(sourceNoDataValue)) throw failure();
  const descriptor = {layerId: layer.layerId, title: layer.title, band: bands[0], displayRange: {...range},
    noDataValue: options.noDataValue, sourceNoDataValue, opacity, sourcePin: pinFor(layer)};
  const description = legendDescription(descriptor);
  return {rows: description.rows, descriptor: {...descriptor, note: description.note}};
}

// Revalidate the closed raster-specific receipt against exact captured rows and
// saved presentation/source pins before SVG or a figure pack can expose it.
export function rasterLegendGroups(capture) {
  const groups = capture.rasterLegends ?? [], result = new Map();
  if (!Array.isArray(groups) || groups.length > 20) throw Error("Invalid captured raster legends.");
  let end = 0;
  const layerIds = new Set();
  for (const group of groups) {
    if (!closed(group, ["start", "count", ...DESCRIPTOR_KEYS]) || !Number.isSafeInteger(group.start)
      || group.start < end || group.start < 0 || group.count !== 4
      || !Array.isArray(capture.legend) || group.start + group.count > capture.legend.length
      || !text(group.layerId, 100) || layerIds.has(group.layerId) || !text(group.title, 500)
      || !Number.isSafeInteger(group.band) || group.band < 1 || group.band > 64 || !validRange(group.displayRange)
      || group.noDataValue !== null && !Number.isFinite(group.noDataValue)
      || group.sourceNoDataValue !== null && group.sourceNoDataValue !== "NaN" && !Number.isFinite(group.sourceNoDataValue)
      || !Number.isFinite(group.opacity) || group.opacity < 0 || group.opacity > 1
      || !validPin(group.sourcePin) || group.layerId !== group.sourcePin.layerId
      || !Array.isArray(capture.presentation) || capture.presentation.length > 250
      || !Array.isArray(capture.sourceMetadata) || capture.sourceMetadata.length > 250) throw Error("Invalid captured raster legends.");
    const selected = capture.presentation.filter(layer => layer.layerId === group.layerId);
    const sources = capture.sourceMetadata.filter(source => source.layerId === group.layerId);
    if (selected.length !== 1 || sources.length !== 1 || !selected[0].visible || selected[0].opacity !== group.opacity
      || !samePin(group.sourcePin, pinFor(selected[0])) || !samePin(group.sourcePin, pinFor(sources[0]))
      || sources[0].title !== group.title) throw Error("The captured raster source or presentation changed.");
    let options;
    try {options = cogDisplayOptions({sourceType: "cog-raster", sourceConfiguration: {bands: [group.band]}, style: selected[0].style});}
    catch {throw Error("The captured raster display range changed.");}
    if (!sameRange(options.displayRange, group.displayRange) || options.noDataValue !== group.noDataValue) throw Error("The captured raster display range changed.");
    const expected = legendDescription(group);
    if (group.note !== expected.note || expected.rows.some((row, index) => {
      const captured = capture.legend[group.start + index];
      return !closed(captured, Object.keys(row)) || Object.keys(row).some(key => captured[key] !== row[key]);
    })) throw Error("The captured raster scale differs from its legend.");
    const descriptor = Object.fromEntries(DESCRIPTOR_KEYS.map(key => [key, group[key]]));
    result.set(group.start, {...descriptor, displayRange: {...group.displayRange}, sourcePin: {...group.sourcePin},
      start: group.start, count: group.count, field: `Band ${group.band}`, interpolation: "linear",
      stops: [{value: group.displayRange.minimum, color: "#000000"}, {value: group.displayRange.maximum, color: "#ffffff"}],
      noData: expected.noData});
    end = group.start + group.count;layerIds.add(group.layerId);
  }
  return result;
}
