import {STYLE_PALETTES} from "./workbenchConfig.js";

export const DELIMITED_TEMPLATE_SCHEMA = "opengeo.delimited-import-template.1";
export const DELIMITED_TEMPLATE_MAX_BYTES = 16_384;
const fields = ["schemaVersion", "delimiter", "sourceProjection", "xColumn", "yColumn", "elevationColumn", "elevationUnit", "verticalDatum", "labelColumn", "color", "categoryColumn", "paletteName"];
const columnFields = ["xColumn", "yColumn", "elevationColumn", "labelColumn", "categoryColumn"];
const fail = message => {throw new Error(message);};

/** Source-free mapping and presentation. Omission permission is deliberately per file. */
export function normalizeDelimitedImportTemplate(value, columns = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail("Choose a supported coordinate import template.");
  if (value.schemaVersion !== DELIMITED_TEMPLATE_SCHEMA) fail("This coordinate import template version is not supported.");
  if (![",", "\t", ";", "|"].includes(value.delimiter) || !["EPSG:4326", "EPSG:3857"].includes(value.sourceProjection)) fail("The template needs a supported separator and source coordinate system.");
  if (!["meter", "foot", "us-survey-foot"].includes(value.elevationUnit) || typeof value.verticalDatum !== "string" || value.verticalDatum.length > 240 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.verticalDatum)) fail("The template elevation settings are invalid.");
  for (const field of columnFields) {
    const name = value[field];
    if (name === null && !["xColumn", "yColumn"].includes(field)) continue;
    if (typeof name !== "string" || !name.trim() || name.length > 160 || ["__proto__", "prototype", "constructor"].includes(name.trim())) fail("The template column names are invalid.");
    if (columns && !columns.includes(name)) fail(`The source has no column named ${name}. Choose a matching file or map its columns manually.`);
  }
  if (value.xColumn === value.yColumn || value.elevationColumn !== null && [value.xColumn, value.yColumn].includes(value.elevationColumn)) fail("Choose distinct coordinate and elevation columns.");
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color) || !STYLE_PALETTES.some(([id, , colors]) => id === value.paletteName && colors.length)) fail("The template point color or category palette is invalid.");
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

export function readDelimitedImportTemplate(text, columns = null) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > DELIMITED_TEMPLATE_MAX_BYTES) fail("Coordinate import templates must be at most 16 KiB.");
  let value;
  try {value = JSON.parse(text);} catch {fail("Choose a valid JSON coordinate import template.");}
  return normalizeDelimitedImportTemplate(value, columns);
}

export function writeDelimitedImportTemplate(value, columns = null) {
  return JSON.stringify(normalizeDelimitedImportTemplate(value, columns), null, 2) + "\n";
}
