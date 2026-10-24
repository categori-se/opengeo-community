// Portable templates contain paper configuration and explicit, unbound data slots.
// Project cameras, Layer/source identities and presentation enter only on apply.
import {PRINT_TEXT_FRAME_KEYS, validatePrintTextFrames} from "./printTextFrames.js";

export const PRINT_TEMPLATE_SCHEMA = "opengeo.print-template.1";
const templateKeys = ["schemaVersion", "id", "name", "page", "dpi", "legend", "legendFormat", "northArrow", "scaleBar", "graticule", "sourceNotes", "caption", "frames", "dataFrames", "textFrames"];
const furnitureKeys = ["legend", "northArrow", "scaleBar", "graticule", "sourceNotes"];
const frameKeys = ["id", "parentId", "title", "xMm", "yMm", "widthMm", "heightMm"];
const dataKeys = ["id", "type", "title", "xMm", "yMm", "widthMm", "heightMm", "mapFrameId", "sourceSlot", "rowLimit"];
const tableKeys = ["columns"], chartKeys = ["chartType", "labelField", "valueField", "altText"];
const paperSizes = new Set(["Letter", "Legal", "Tabloid", "A4", "A3", "A2", "A1", "A0", "Custom"]);
const sourceKeys = ["layerId", "datasetId", "datasetVersionId", "sourceVersion"];

/** Admit only the closed source-free portable format and return detached values. */
export function validatePrintTemplate(value) {
  object(value, templateKeys, templateKeys.filter(key => !["legendFormat", "dataFrames", "textFrames"].includes(key)));
  if (value.schemaVersion !== PRINT_TEMPLATE_SCHEMA) throw Error("Unsupported Print template format.");
  text(value.id, 100);text(value.name, 200);text(value.caption, 2000, true);
  object(value.page, ["size", "orientation", "widthMm", "heightMm", "marginMm"]);
  const page = value.page;
  if (!paperSizes.has(page.size) || !["portrait", "landscape"].includes(page.orientation)) throw Error("Choose a supported template paper size and orientation.");
  number(page.widthMm, 50, 1189);number(page.heightMm, 50, 1189);
  number(page.marginMm, 0, Math.min(page.widthMm, page.heightMm) / 4);
  const pixels = mm => Math.max(1, Math.round(mm / 25.4 * value.dpi));
  if (![96, 150, 300].includes(value.dpi) || pixels(page.widthMm) * pixels(page.heightMm) > 20_000_000) throw Error("Choose a template resolution below the 20 megapixel limit.");
  for (const key of furnitureKeys) if (typeof value[key] !== "boolean") throw Error("Invalid template furniture selection.");
  if (Object.hasOwn(value, "legendFormat") && !["swatches", "classed-bars", "color-bars"].includes(value.legendFormat)) throw Error("Invalid template legend format.");
  array(value.frames, 1, 2);
  const ids = new Set();
  value.frames.forEach((frame, index) => {
    object(frame, frameKeys);
    if (frame.id !== (index ? "inset" : "main") || frame.parentId !== (index ? "main" : null)) throw Error("Template maps must use local main/inset frame identities.");
    ids.add(frame.id);geometry(frame, page, 10);text(frame.title, 200);
  });
  if (Object.hasOwn(value, "dataFrames")) {
    array(value.dataFrames, 0, 4);
    value.dataFrames.forEach((frame, index) => {
      object(frame, [...dataKeys, ...tableKeys, ...chartKeys], dataKeys);
      if (!["table", "chart"].includes(frame.type)) throw Error("Choose a table or chart template slot.");
      object(frame, [...dataKeys, ...(frame.type === "table" ? tableKeys : chartKeys)]);
      if (frame.id !== `data-${index + 1}` || frame.sourceSlot !== `source-${index + 1}` || !value.frames.some(mapFrame => mapFrame.id === frame.mapFrameId)) throw Error("Invalid local template data slot or linked map frame.");
      ids.add(frame.id);
      text(frame.title, 200);geometry(frame, page, 20);
      if (!Number.isInteger(frame.rowLimit) || frame.rowLimit < 1 || frame.rowLimit > 12) throw Error("Choose a template data row limit from 1 to 12.");
      if (frame.type === "table") {
        array(frame.columns, 1, 4);frame.columns.forEach(field);
        if (new Set(frame.columns).size !== frame.columns.length) throw Error("Choose distinct template table fields.");
      } else {
        if (!["bar", "line"].includes(frame.chartType)) throw Error("Choose a supported template chart type.");
        field(frame.labelField);field(frame.valueField);text(frame.altText, 300);
        if (frame.labelField === frame.valueField) throw Error("Choose distinct template chart label and value fields.");
      }
    });
  }
  if (Object.hasOwn(value, "textFrames")) {
    validatePrintTextFrames(value.textFrames, page, ids);
    value.textFrames.forEach((frame, index) => {
      if (frame.id !== `text-${index + 1}`) throw Error("Template text must use local frame identities.");
    });
  }
  const result = structuredClone(value);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32768) throw Error("Print template exceeds the 32 KiB limit.");
  return result;
}

/** Strip source bindings and map state; do not copy attributes or captured pixels. */
export function templateFromLayout(layout, name, id = crypto.randomUUID()) {
  if (!layout || !Array.isArray(layout.frames) || layout.frames.length < 1 || layout.frames.length > 2) throw Error("Choose a supported Print layout to save as a template.");
  const frameIds = new Map(layout.frames.map((frame, index) => [frame.id, index ? "inset" : "main"]));
  if (frameIds.size !== layout.frames.length || layout.frames[0].parentId !== null
    || layout.frames.some((frame, index) => index && frame.parentId !== layout.frames[0].id)) throw Error("Invalid Print layout map frame relationships.");
  const result = {schemaVersion: PRINT_TEMPLATE_SCHEMA, id, name, ...pick(layout, ["page", "dpi", ...furnitureKeys, "caption"]),
    ...(Object.hasOwn(layout, "legendFormat") ? {legendFormat: layout.legendFormat} : {}),
    frames: layout.frames.map((frame, index) => ({...pick(frame, frameKeys), id: index ? "inset" : "main", parentId: index ? "main" : null}))};
  if (Object.hasOwn(layout, "dataFrames")) {
    array(layout.dataFrames, 0, 4);
    result.dataFrames = layout.dataFrames.map((frame, index) => ({...pick(frame, [...dataKeys.filter(key => key !== "sourceSlot"), ...(frame.type === "table" ? tableKeys : chartKeys)]),
      id: `data-${index + 1}`, mapFrameId: frameIds.get(frame.mapFrameId), sourceSlot: `source-${index + 1}`}));
  }
  if (Object.hasOwn(layout, "textFrames")) {
    validatePrintTextFrames(layout.textFrames, layout.page, [...layout.frames, ...(layout.dataFrames ?? [])].map(frame => frame.id));
    result.textFrames = layout.textFrames.map((frame, index) => ({...pick(frame, PRINT_TEXT_FRAME_KEYS), id: `text-${index + 1}`}));
  }
  return validatePrintTemplate(result);
}

/** Bind each slot explicitly to a current visible Layer; never reuse template sources. */
export function layoutFromTemplate(template, map, id = crypto.randomUUID(), bindings = {}) {
  const value = validatePrintTemplate(template);text(id, 100);
  const slots = (value.dataFrames ?? []).map(frame => frame.sourceSlot);
  object(bindings, slots);
  const layers = map?.definition?.layers ?? [];
  if (!Array.isArray(layers) || layers.length > 250) throw Error("Too many Project Layers for a Print template.");
  const byId = new Map(layers.map(layer => [layer.layerId, layer]));
  if (byId.size !== layers.length) throw Error("Project Layer identities must be unique.");
  for (const slot of slots) {
    text(bindings[slot], 100);
    if (!byId.has(bindings[slot]) || byId.get(bindings[slot]).visible === false) throw Error("Bind every template data slot to a visible current Project Layer.");
  }
  const camera = map?.definition?.mapViews?.[0] ?? {};
  const view = {center: structuredClone(camera.center ?? [0, 0]), zoom: camera.zoom ?? 2, pitch: camera.pitch ?? 0, bearing: camera.bearing ?? 0};
  const result = {id, title: value.name, ...pick(value, ["page", "dpi", ...furnitureKeys, "caption"]),
    ...(Object.hasOwn(value, "legendFormat") ? {legendFormat: value.legendFormat} : {}),
    frames: value.frames.map(frame => ({...structuredClone(frame), view: structuredClone(view), presentation: layers.map(presentation)}))};
  if (Object.hasOwn(value, "dataFrames")) result.dataFrames = value.dataFrames.map(frame => {
    const {sourceSlot, ...configuration} = frame, layer = byId.get(bindings[sourceSlot]);
    return {...structuredClone(configuration), source: Object.fromEntries(sourceKeys.map(key => [key, layer[key] ?? null]))};
  });
  if (Object.hasOwn(value, "textFrames")) {
    const ids = new Set([...result.frames, ...(result.dataFrames ?? [])].map(frame => frame.id));
    let nextId = 1;
    result.textFrames = value.textFrames.map(frame => {
      while (ids.has(`text-${nextId}`)) nextId++;
      const id = `text-${nextId++}`;ids.add(id);
      return {...structuredClone(frame), id};
    });
  }
  return result;
}

function presentation(layer) {
  return {layerId: layer.layerId, datasetId: layer.datasetId, datasetVersionId: layer.datasetVersionId ?? null,
    sourceVersion: layer.sourceVersion ?? null, visible: layer.visible !== false, opacity: layer.opacity ?? 1,
    ...(layer.managedDisplayId ? {managedDisplayId: layer.managedDisplayId} : {}),
    style: structuredClone(layer.style ?? {}), labels: structuredClone(layer.labels ?? {}),
    ...(layer.filter ? {filter: structuredClone(layer.filter)} : {}),
    ...(Object.hasOwn(layer, "pointClustering") ? {pointClustering: structuredClone(layer.pointClustering)} : {}),
    ...(layer.styleReference ? {styleReference: structuredClone(layer.styleReference)} : {})};
}
function pick(value, keys) {return Object.fromEntries(keys.map(key => [key, structuredClone(value[key])]));}
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
    || required.some(key => !Object.hasOwn(value, key))) throw Error("Invalid or unsupported Print template fields.");
}
function array(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({length: value.length}, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(descriptor => !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))) throw Error("Invalid Print template item count or array.");
}
function text(value, maximum, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) throw Error("Invalid Print template text.");
}
function field(value) {
  text(value, 100);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || /^(?:__proto__|prototype|constructor)$/i.test(value)) throw Error("Choose a safe literal template data field name.");
}
function number(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw Error("Invalid Print template dimensions.");
}
function geometry(frame, page, minimum) {
  number(frame.xMm, 0, page.widthMm);number(frame.yMm, 0, page.heightMm);
  number(frame.widthMm, minimum, page.widthMm);number(frame.heightMm, minimum, page.heightMm);
  if (frame.xMm + frame.widthMm > page.widthMm + 0.001 || frame.yMm + frame.heightMm > page.heightMm + 0.001) throw Error("Keep each template frame inside its page.");
}
