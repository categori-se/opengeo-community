import {validateMapFilter} from "./mapFilter.js";
import {validateLayerStyleReference} from "./layerStyleReference.js";
import {validateManagedDisplayReference} from "./mapDefinition.js";
import {validatePointClustering} from "./pointClustering.js";

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

export const PROJECT_PRINT_SCHEMA = "opengeo.project-print-layouts.1";
export const PROJECT_PRINT_EXTENSION = "opengeoPrintLayouts";
const frameKeys = ["id", "parentId", "title", "xMm", "yMm", "widthMm", "heightMm", "view", "presentation"];
const presentationKeys = ["layerId", "datasetId", "datasetVersionId", "sourceVersion", "managedDisplayId", "visible", "opacity", "style", "labels", "filter", "styleReference", "pointClustering"];

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
    ...(layer.managedDisplayId ? {managedDisplayId: layer.managedDisplayId} : {}),
    style: structuredClone(layer.style ?? {}), labels: structuredClone(layer.labels ?? {}),
    ...(layer.filter ? {filter: structuredClone(layer.filter)} : {}),
    ...(Object.hasOwn(layer, "pointClustering") ? {pointClustering: structuredClone(layer.pointClustering)} : {}),
    ...(layer.styleReference ? {styleReference: structuredClone(layer.styleReference)} : {})};
}

export function validateProjectPrintLayouts(value, map) {
  closedPrintObject(value, ["schemaVersion", "projectId", "layouts"]);
  if (value.schemaVersion !== PROJECT_PRINT_SCHEMA || value.projectId !== map.id || !Array.isArray(value.layouts) || value.layouts.length > 8) throw Error("The print layout belongs to another Project or uses an unsupported format.");
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).byteLength > 32768) throw Error("Print layouts exceed the 32 KiB Project limit.");
  const layers = new Map((map.definition?.layers ?? []).map(layer => [layer.layerId, layer]));
  const ids = new Set();
  for (const layout of value.layouts) {
    closedPrintObject(layout, ["id", "title", "page", "frames", "dpi", "legend", "northArrow", "scaleBar", "graticule", "sourceNotes", "caption"]);
    printText(layout.id, 100);printText(layout.title, 200);printText(layout.caption, 2000, true);
    if (ids.has(layout.id)) throw Error("Print layout identities must be unique.");ids.add(layout.id);
    closedPrintObject(layout.page, ["size", "orientation", "widthMm", "heightMm", "marginMm"]);
    const page = layout.page;
    if (!standardPageSizes.some(item => item.size === page.size) || !["portrait", "landscape"].includes(page.orientation)) throw Error("Choose a supported paper size and orientation.");
    for (const dimension of [page.widthMm, page.heightMm]) printNumber(dimension, 50, 1189);
    printNumber(page.marginMm, 0, Math.min(page.widthMm, page.heightMm) / 4);
    if (![96, 150, 300].includes(layout.dpi) || mmToPx(page.widthMm, layout.dpi) * mmToPx(page.heightMm, layout.dpi) > 20_000_000) throw Error("Choose an output resolution below the 20 megapixel limit.");
    for (const key of ["legend", "northArrow", "scaleBar", "graticule", "sourceNotes"]) if (typeof layout[key] !== "boolean") throw Error("Invalid print furniture selection.");
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
        for (const key of ["style", "labels"]) if (!item[key] || typeof item[key] !== "object" || Array.isArray(item[key])) throw Error("Invalid print Layer presentation.");
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
