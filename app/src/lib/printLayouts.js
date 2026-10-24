import {validateMapFilter} from "./mapFilter.js";
import {validateLayerStyleReference} from "./layerStyleReference.js";
import {validateManagedDisplayReference} from "./mapDefinition.js";
import {validatePointClustering} from "./pointClustering.js";
import {validateOpacityMode} from "./layerOpacity.js";
import {validatePrintTemplate} from "./printTemplates.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {cogDisplayOptions} from "./cogDisplay.js";
import {validatePrintTextFrames} from "./printTextFrames.js";

export const standardPageSizes = [
  {size: "Letter", orientation: "portrait", widthMm: 216, heightMm: 279},
  {size: "Letter", orientation: "landscape", widthMm: 279, heightMm: 216},
  {size: "Legal", orientation: "portrait", widthMm: 216, heightMm: 356},
  {size: "Legal", orientation: "landscape", widthMm: 356, heightMm: 216},
  {size: "Tabloid", orientation: "portrait", widthMm: 279, heightMm: 432},
  {size: "Tabloid", orientation: "landscape", widthMm: 432, heightMm: 279},
  {size: "A4", orientation: "portrait", widthMm: 210, heightMm: 297},
  {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210},
  {size: "A3", orientation: "portrait", widthMm: 297, heightMm: 420},
  {size: "A3", orientation: "landscape", widthMm: 420, heightMm: 297},
  {size: "A2", orientation: "landscape", widthMm: 594, heightMm: 420},
  {size: "A1", orientation: "landscape", widthMm: 841, heightMm: 594},
  {size: "A0", orientation: "landscape", widthMm: 1189, heightMm: 841},
  {size: "Custom", orientation: "landscape", widthMm: 297, heightMm: 210}
];

export function layoutById(layouts, layoutId) {
  return layouts.find((layout) => layout.layoutId === layoutId) ?? null;
}

export function elementsByType(layout, type) {
  return (layout?.elements ?? []).filter((element) => element.type === type);
}

export function layoutLayers(layout, layers) {
  const layerIds = new Set(elementsByType(layout, "map_frame").flatMap((element) => element.layers ?? []));
  return layers.filter((layer) => layerIds.has(layer.layerId));
}

export function exportsForLayout(exports, layoutId) {
  return exports.filter((record) => record.layoutId === layoutId);
}

export function pageLabel({pageSize, orientation}) {
  return `${pageSize} ${orientation}`;
}

export function elementStyle(element) {
  return [
    `left:${element.xMm}mm`,
    `top:${element.yMm}mm`,
    `width:${element.widthMm}mm`,
    `height:${element.heightMm}mm`
  ].join(";");
}

export function mmToPx(mm, dpi = 96) {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}

export function printCaptureTarget(frame, dpi) {
  if (![frame?.widthMm, frame?.heightMm].every(value => typeof value === "number" && Number.isFinite(value) && value > 0)
    || ![96, 150, 300].includes(dpi)) throw Error("Choose positive map-frame dimensions and a supported output DPI before capture.");
  const maxWidth = mmToPx(frame.widthMm, dpi), maxHeight = mmToPx(frame.heightMm, dpi);
  if (![maxWidth, maxHeight].every(Number.isSafeInteger) || maxWidth * maxHeight > 20_000_000) throw Error("Map capture exceeds its 20 megapixel limit.");
  return {maxWidth, maxHeight};
}

// Output sizing is ephemeral: saved cameras and Layer presentation stay separate.
export function printCaptureOutputSignature(frame, dpi) {
  printCaptureTarget(frame, dpi);
  return canonicalJson({widthMm: frame.widthMm, heightMm: frame.heightMm, dpi});
}

export const PROJECT_PRINT_SCHEMA = "opengeo.project-print-layouts.1";
export const PROJECT_PRINT_EXTENSION = "opengeoPrintLayouts";
const frameKeys = ["id", "parentId", "title", "xMm", "yMm", "widthMm", "heightMm", "view", "presentation"];
const dataFrameKeys = ["id", "type", "title", "xMm", "yMm", "widthMm", "heightMm", "mapFrameId", "source", "rowLimit"];
const dataSourceKeys = ["layerId", "datasetId", "datasetVersionId", "sourceVersion"];
const presentationKeys = ["layerId", "datasetId", "datasetVersionId", "sourceVersion", "managedDisplayId", "visible", "opacity", "opacityMode", "style", "labels", "filter", "styleReference", "pointClustering"];

export function projectPrintLayouts(map) {
  const value = map.definition?.extensions?.[PROJECT_PRINT_EXTENSION];
  return value === undefined ? {schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: []}
    : validateProjectPrintLayouts(value, map);
}

export function newProjectPrintLayout(map, id = crypto.randomUUID()) {
  const camera = map.definition?.mapViews?.[0] ?? {};
  return {id, title: map.name || "Map layout", page: {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210, marginMm: 10},
    dpi: 96, legend: true, northArrow: true, scaleBar: true, graticule: false, sourceNotes: true, caption: "",
    frames: [{id: "main", parentId: null, title: "Main map", xMm: 10, yMm: 27, widthMm: 215, heightMm: 153,
      view: {center: [...(camera.center ?? [0, 0])], zoom: camera.zoom ?? 2, pitch: camera.pitch ?? 0, bearing: camera.bearing ?? 0},
      presentation: (map.definition?.layers ?? []).map(printLayerPresentation)}]};
}

export function printLayerPresentation(layer) {
  return {layerId: layer.layerId, datasetId: layer.datasetId, datasetVersionId: layer.datasetVersionId ?? null,
    sourceVersion: layer.sourceVersion ?? null, visible: layer.visible !== false, opacity: layer.opacity ?? 1,
    ...(layer.opacityMode !== undefined ? {opacityMode: layer.opacityMode} : {}),
    ...(layer.managedDisplayId ? {managedDisplayId: layer.managedDisplayId} : {}),
    style: structuredClone(layer.style ?? {}), labels: structuredClone(layer.labels ?? {}),
    ...(layer.filter ? {filter: structuredClone(layer.filter)} : {}),
    ...(Object.hasOwn(layer, "pointClustering") ? {pointClustering: structuredClone(layer.pointClustering)} : {}),
    ...(layer.styleReference ? {styleReference: structuredClone(layer.styleReference)} : {})};
}

export function validateProjectPrintLayouts(value, map) {
  closedPrintObject(value, ["schemaVersion", "projectId", "layouts", "templates"]);
  if (value.schemaVersion !== PROJECT_PRINT_SCHEMA || value.projectId !== map.id || !Array.isArray(value.layouts) || value.layouts.length > 8) throw Error("The print layout belongs to another Project or uses an unsupported format.");
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).byteLength > 32768) throw Error("Print layouts exceed the 32 KiB Project limit.");
  if (Object.hasOwn(value, "templates")) {
    if (!Array.isArray(value.templates) || value.templates.length > 8) throw Error("A Project supports up to eight Print templates.");
    const templateIds = new Set();
    for (const template of value.templates) {
      const checked = validatePrintTemplate(template);
      if (templateIds.has(checked.id)) throw Error("Print template identities must be unique.");
      templateIds.add(checked.id);
    }
  }
  const layers = new Map((map.definition?.layers ?? []).map(layer => [layer.layerId, layer]));
  const ids = new Set();
  for (const layout of value.layouts) {
    closedPrintObject(layout, ["id", "title", "page", "frames", "dataFrames", "textFrames", "dpi", "legend", "legendFormat", "northArrow", "scaleBar", "graticule", "sourceNotes", "caption"]);
    printText(layout.id, 100);printText(layout.title, 200);printText(layout.caption, 2000, true);
    if (ids.has(layout.id)) throw Error("Print layout identities must be unique.");ids.add(layout.id);
    closedPrintObject(layout.page, ["size", "orientation", "widthMm", "heightMm", "marginMm"]);
    const page = layout.page;
    if (!standardPageSizes.some(item => item.size === page.size) || !["portrait", "landscape"].includes(page.orientation)) throw Error("Choose a supported paper size and orientation.");
    for (const dimension of [page.widthMm, page.heightMm]) printNumber(dimension, 50, 1189);
    printNumber(page.marginMm, 0, Math.min(page.widthMm, page.heightMm) / 4);
    if (![96, 150, 300].includes(layout.dpi) || mmToPx(page.widthMm, layout.dpi) * mmToPx(page.heightMm, layout.dpi) > 20_000_000) throw Error("Choose an output resolution below the 20 megapixel limit.");
    for (const key of ["legend", "northArrow", "scaleBar", "graticule", "sourceNotes"]) if (typeof layout[key] !== "boolean") throw Error("Invalid print furniture selection.");
    if (Object.hasOwn(layout, "legendFormat") && !["swatches", "classed-bars", "color-bars"].includes(layout.legendFormat)) throw Error("Invalid print legend format.");
    if (!Array.isArray(layout.frames) || layout.frames.length < 1 || layout.frames.length > 2) throw Error("A layout supports one main map and one inset.");
    const frameIds = new Set(layout.frames.map(frame => frame.id));
    if (frameIds.size !== layout.frames.length || layout.frames[0].parentId !== null) throw Error("Invalid map frame identities.");
    for (const frame of layout.frames) {
      closedPrintObject(frame, frameKeys);printText(frame.id, 100);printText(frame.title, 200);
      if (frame.parentId !== null && frame.parentId !== layout.frames[0].id) throw Error("An inset must name its main map frame.");
      printNumber(frame.xMm, 0, page.widthMm);printNumber(frame.yMm, 0, page.heightMm);
      printNumber(frame.widthMm, 10, page.widthMm);printNumber(frame.heightMm, 10, page.heightMm);
      if (frame.xMm + frame.widthMm > page.widthMm + 0.001 || frame.yMm + frame.heightMm > page.heightMm + 0.001) throw Error("Keep each map frame inside its page.");
      closedPrintObject(frame.view, ["center", "zoom", "pitch", "bearing"]);
      if (!Array.isArray(frame.view.center) || frame.view.center.length !== 2) throw Error("Invalid print map center.");
      printNumber(frame.view.center[0], -180, 180);printNumber(frame.view.center[1], -85, 85);
      printNumber(frame.view.zoom, -2, 24);printNumber(frame.view.pitch, 0, 85);printNumber(frame.view.bearing, -360, 360);
      if (!Array.isArray(frame.presentation) || frame.presentation.length > 250) throw Error("Too many print Layer references.");
      const selected = new Set();
      for (const item of frame.presentation) {
        closedPrintObject(item, presentationKeys);
        const source = layers.get(item.layerId);
        if (!source || selected.has(item.layerId) || item.datasetId !== source.datasetId
          || item.datasetVersionId !== (source.datasetVersionId ?? null) || item.sourceVersion !== (source.sourceVersion ?? null)
          || (item.managedDisplayId ?? null) !== (source.managedDisplayId ?? null)
          || (Object.hasOwn(item, "managedDisplayId") && typeof item.managedDisplayId !== "string")) throw Error("A saved print Layer source changed. Review the layout against this Project revision.");
        selected.add(item.layerId);
        if (Object.hasOwn(item, "managedDisplayId")) validateManagedDisplayReference({...source, managedDisplayId: item.managedDisplayId});
        if (typeof item.visible !== "boolean") throw Error("Invalid print Layer visibility.");
        printNumber(item.opacity, 0, 1);
        if (item.opacityMode !== undefined) validateOpacityMode({...source, opacityMode: item.opacityMode});
        for (const key of ["style", "labels"]) if (!item[key] || typeof item[key] !== "object" || Array.isArray(item[key])) throw Error("Invalid print Layer presentation.");
        if (Object.hasOwn(item.style, "cogDisplay")) cogDisplayOptions({...source, style: item.style});
        if (item.filter !== undefined) validateMapFilter(item.filter);
        if (item.styleReference !== undefined) validateLayerStyleReference(item.styleReference);
        if (Object.hasOwn(item, "pointClustering")) validatePointClustering(item.pointClustering);
        const pending = [item];let entries = 0;
        while (pending.length) {
          const next = pending.pop();
          if (++entries > 4096) throw Error("Print Layer presentation exceeds its bound.");
          if (typeof next === "string" && /(?:https?:|data:|javascript:|url\s*\()/i.test(next)) throw Error("Print presentation cannot contain external URLs or executable content.");
          if (next && typeof next === "object") {
            if (Object.keys(next).some(key => /^(?:__proto__|prototype|constructor|password|token|credentials|secret|sourceUrl|sourceConfiguration)$/i.test(key))) throw Error("Invalid print presentation field.");
            pending.push(...Object.values(next));
          }
          if (typeof next === "number" && !Number.isFinite(next)) throw Error("Invalid numeric print presentation.");
        }
      }
    }
    if (Object.hasOwn(layout, "dataFrames")) {
      if (!Array.isArray(layout.dataFrames) || layout.dataFrames.length > 4) throw Error("A layout supports up to four data frames.");
      for (const frame of layout.dataFrames) {
        if (!["table", "chart"].includes(frame?.type)) throw Error("Choose a table or chart data frame.");
        closedPrintObject(frame, [...dataFrameKeys, ...(frame.type === "table" ? ["columns"] : ["chartType", "labelField", "valueField", "altText"])]);
        printText(frame.id, 100);printText(frame.title, 200);printText(frame.mapFrameId, 100);
        if (frameIds.has(frame.id)) throw Error("Print frame identities must be unique.");frameIds.add(frame.id);
        printNumber(frame.xMm, 0, page.widthMm);printNumber(frame.yMm, 0, page.heightMm);
        printNumber(frame.widthMm, 20, page.widthMm);printNumber(frame.heightMm, 20, page.heightMm);
        if (frame.xMm + frame.widthMm > page.widthMm + 0.001 || frame.yMm + frame.heightMm > page.heightMm + 0.001) throw Error("Keep each data frame inside its page.");
        if (!Number.isInteger(frame.rowLimit) || frame.rowLimit < 1 || frame.rowLimit > 12) throw Error("Choose a data frame row limit from 1 to 12.");
        closedPrintObject(frame.source, dataSourceKeys);
        if (dataSourceKeys.some(key => !Object.hasOwn(frame.source, key))) throw Error("A data frame must retain every source binding.");
        const source = layers.get(frame.source.layerId), mapFrame = layout.frames.find(item => item.id === frame.mapFrameId);
        const presented = mapFrame?.presentation.find(item => item.layerId === frame.source.layerId);
        if (!source || !presented?.visible || dataSourceKeys.some(key => frame.source[key] !== (source[key] ?? null)
          || frame.source[key] !== (presented[key] ?? null))) throw Error("A data frame must name a visible Layer with the same source bindings in its map frame.");
        if (frame.type === "table") {
          if (!Array.isArray(frame.columns) || frame.columns.length < 1 || frame.columns.length > 4 || new Set(frame.columns).size !== frame.columns.length) throw Error("Choose one to four unique table fields.");
          frame.columns.forEach(printFieldName);
        } else {
          if (!["bar", "line"].includes(frame.chartType)) throw Error("Choose a supported chart type.");
          printFieldName(frame.labelField);printFieldName(frame.valueField);printText(frame.altText, 300);
          if (frame.labelField === frame.valueField) throw Error("Choose distinct chart label and numeric value fields.");
        }
      }
    }
    if (Object.hasOwn(layout, "textFrames")) validatePrintTextFrames(layout.textFrames, page, frameIds);
  }
  return structuredClone(value);
}

export function definitionWithPrintLayouts(map, collection) {
  const validated = validateProjectPrintLayouts(collection, map);
  return {...structuredClone(map.definition), extensions: {...structuredClone(map.definition?.extensions ?? {}), [PROJECT_PRINT_EXTENSION]: validated}};
}

export function definitionForPrintFrame(map, frame) {
  const definition = structuredClone(map.definition);
  const byId = new Map(frame.presentation.map(item => [item.layerId, item]));
  definition.layers = definition.layers.map(layer => {
    const item = byId.get(layer.layerId);
    if (!item) return {...layer, visible: false};
    const result = {...layer, visible: item.visible, opacity: item.opacity, style: structuredClone(item.style), labels: structuredClone(item.labels)};
    if (item.opacityMode !== undefined) result.opacityMode = item.opacityMode;
    if (item.filter) result.filter = structuredClone(item.filter);else delete result.filter;
    if (item.styleReference) result.styleReference = structuredClone(item.styleReference);else delete result.styleReference;
    if (item.managedDisplayId) result.managedDisplayId = item.managedDisplayId;else delete result.managedDisplayId;
    if (Object.hasOwn(item, "pointClustering")) result.pointClustering = structuredClone(item.pointClustering);else delete result.pointClustering;
    return result;
  });
  if (definition.layers.some(layer => layer.managedDisplayId)) definition.schemaVersion = "opengeo.map-definition.1.5.0";
  else if (definition.layers.some(layer => layer.styleReference)) definition.schemaVersion = "opengeo.map-definition.1.4.0";
  definition.mapViews = [{id: "print-view", title: frame.title, ...structuredClone(frame.view)}];
  return definition;
}

function closedPrintObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid or unsupported print layout fields.");
}
function printText(value, maximum, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw Error("Invalid print layout text.");
}
function printNumber(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw Error("Invalid print layout dimensions or coordinates.");
}
function printFieldName(value) {
  printText(value, 100);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || /^(?:__proto__|prototype|constructor)$/i.test(value)) throw Error("Choose a safe literal data field name.");
}

// Editing uses physical millimeters; view cameras and Layer presentation stay untouched.
export function movePrintFrame(layout, frameId, {xMm, yMm, snap = false, toleranceMm = 1}) {
  const {page, frame} = printEditingContext(layout, frameId);
  printEditingNumbers(xMm, yMm, toleranceMm);
  if (toleranceMm < 0) throw Error("Snap tolerance must be nonnegative.");
  const x = printEditingAxis(layout, frame, "x", xMm, frame.widthMm, 0, Math.max(0, page.widthMm - frame.widthMm), snap, toleranceMm);
  const y = printEditingAxis(layout, frame, "y", yMm, frame.heightMm, 0, Math.max(0, page.heightMm - frame.heightMm), snap, toleranceMm);
  return {xMm: x.value, yMm: y.value, snapLines: [...x.lines, ...y.lines]};
}

export function resizePrintFrame(layout, frameId, {widthMm, heightMm, snap = false, toleranceMm = 1}) {
  const {page, frame, minimumWidthMm, minimumHeightMm} = printEditingContext(layout, frameId);
  printEditingNumbers(widthMm, heightMm, toleranceMm);
  if (toleranceMm < 0) throw Error("Snap tolerance must be nonnegative.");
  const maxWidth = page.widthMm - frame.xMm, maxHeight = page.heightMm - frame.yMm;
  if (frame.xMm < 0 || frame.yMm < 0 || maxWidth < minimumWidthMm || maxHeight < minimumHeightMm) throw Error(`Keep enough page space for a frame at least ${minimumWidthMm} × ${minimumHeightMm} mm.`);
  const x = printEditingAxis(layout, frame, "x", widthMm, frame.xMm, minimumWidthMm, maxWidth, snap, toleranceMm, true);
  const y = printEditingAxis(layout, frame, "y", heightMm, frame.yMm, minimumHeightMm, maxHeight, snap, toleranceMm, true);
  return {widthMm: x.value, heightMm: y.value, snapLines: [...x.lines, ...y.lines]};
}

export function alignPrintFrame(layout, frameId, alignment) {
  const {page, frame} = printEditingContext(layout, frameId), margin = page.marginMm;
  let xMm = frame.xMm, yMm = frame.yMm;
  if (alignment === "left") xMm = margin;
  else if (alignment === "center") xMm = (page.widthMm - frame.widthMm) / 2;
  else if (alignment === "right") xMm = page.widthMm - margin - frame.widthMm;
  else if (alignment === "top") yMm = margin;
  else if (alignment === "middle") yMm = (page.heightMm - frame.heightMm) / 2;
  else if (alignment === "bottom") yMm = page.heightMm - margin - frame.heightMm;
  else throw Error("Choose a supported frame alignment.");
  return {xMm: boundedPrintMm(xMm, 0, Math.max(0, page.widthMm - frame.widthMm)),
    yMm: boundedPrintMm(yMm, 0, Math.max(0, page.heightMm - frame.heightMm))};
}

export function printRulerTicks(lengthMm, units = "mm") {
  printNumber(lengthMm, 0, 1189);
  if (!["mm", "in"].includes(units)) throw Error("Choose millimeters or inches for the ruler.");
  const step = units === "in" ? 25.4 / 8 : 5, majorEvery = units === "in" ? 8 : 2;
  const count = Math.min(400, Math.floor(lengthMm / step + 1e-9) + 1);
  return Array.from({length: count}, (_, index) => ({mm: roundPrintMm(index * step), major: index % majorEvery === 0,
    label: index % majorEvery === 0 ? String(units === "in" ? index / 8 : index * step) : ""}));
}

function printEditingContext(layout, frameId) {
  const frames = printEditingFrames(layout), page = layout?.page, frame = frames.find(item => item.id === frameId);
  if (!page || !frame) throw Error("Choose an existing print frame.");
  printEditingNumbers(page.widthMm, page.heightMm, page.marginMm);
  if (page.widthMm < 10 || page.heightMm < 10 || page.marginMm < 0 || page.marginMm > Math.min(page.widthMm, page.heightMm) / 2) throw Error("Invalid paper dimensions or margins.");
  for (const item of frames) {
    printEditingNumbers(item.xMm, item.yMm, item.widthMm, item.heightMm, item.xMm + item.widthMm, item.yMm + item.heightMm);
    if (item.widthMm <= 0 || item.heightMm <= 0) throw Error("Print frame dimensions must be positive.");
  }
  const kind = layout.textFrames?.includes(frame) ? "text" : layout.dataFrames?.includes(frame) ? frame.type : "map";
  return {page, frame, kind, minimumWidthMm: ["table", "chart"].includes(kind) ? 20 : 10, minimumHeightMm: kind === "text" ? 5 : ["table", "chart"].includes(kind) ? 20 : 10};
}

function printEditingFrames(layout) {
  return [...(Array.isArray(layout?.frames) ? layout.frames : []), ...(Array.isArray(layout?.dataFrames) ? layout.dataFrames : []),
    ...(Array.isArray(layout?.textFrames) ? layout.textFrames : [])];
}

function printEditingAxis(layout, frame, axis, requested, offset, minimum, maximum, snap, tolerance, resize = false) {
  const positionKey = axis === "x" ? "xMm" : "yMm", sizeKey = axis === "x" ? "widthMm" : "heightMm";
  const length = axis === "x" ? layout.page.widthMm : layout.page.heightMm, margin = layout.page.marginMm;
  const targets = [0, margin, length / 2, length - margin, length];
  for (const other of printEditingFrames(layout)) if (other !== frame) targets.push(other[positionKey], other[positionKey] + other[sizeKey] / 2, other[positionKey] + other[sizeKey]);
  let value = boundedPrintMm(requested, minimum, maximum), match, distance = Infinity;
  if (snap) for (const target of targets) for (const anchor of resize ? [offset] : [0, offset / 2, offset]) {
    const candidate = target - anchor, delta = Math.abs(candidate - value);
    if (delta <= tolerance + 1e-9 && delta < distance - 1e-9) {match = {target, anchor, candidate};distance = delta;}
  }
  if (match) value = boundedPrintMm(match.candidate, minimum, maximum);
  const lines = match && Math.abs(value + match.anchor - match.target) <= 0.001000001
    ? [{axis, positionMm: roundPrintMm(match.target)}] : [];
  return {value, lines};
}

function printEditingNumbers(...values) {
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value))) throw Error("Print geometry must contain finite numbers.");
}
function roundPrintMm(value) {return Math.round(value * 1000) / 1000 || 0;}
function boundedPrintMm(value, minimum, maximum) {
  return Math.max(minimum, Math.min(Math.floor(maximum * 1000 + 1e-9) / 1000, roundPrintMm(Math.max(minimum, Math.min(maximum, value)))));
}
