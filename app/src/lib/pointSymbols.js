import {IMPORTED_POINT_SYMBOL_ROWS} from "./pointSymbolRegistry.js";

// Source pins remain part of the identity; a later collection cannot replace a
// saved symbol's pixels. Assets and terms are local, with no font/sprite service.
export const POINT_SYMBOL_COLLECTIONS = Object.freeze([
  {id: "builtin", label: "OpenGeo originals", version: "1", license: "Original OpenGeo glyphs",
    sourceUrl: "", attribution: "OpenGeo.Tools"},
  {id: "maki-8.2.0", label: "Maki", version: "8.2.0", license: "CC0-1.0",
    commit: "6ab50f392294aeb20b3af83e8a10067151876eb9",
    archiveSha256: "f6e59156521117c311c0e73a6aeef8d5039daea9c7fbe1ff9264e18a3ebec87f",
    sourceUrl: "https://github.com/mapbox/maki/tree/6ab50f392294aeb20b3af83e8a10067151876eb9",
    attribution: "Maki contributors"},
  {id: "osm-carto-1cc4b89c", label: "OpenStreetMap Carto", version: "1cc4b89c48e4385b607d63156d6f8f1eea8b35a2",
    commit: "1cc4b89c48e4385b607d63156d6f8f1eea8b35a2", license: "CC0-1.0",
    archiveSha256: "851f1322e613c8fc11145c74cbc00e3f2c15fc39b7ee492d2ad1f945a2b4dc5e",
    sourceUrl: "https://github.com/openstreetmap-carto/openstreetmap-carto/tree/1cc4b89c48e4385b607d63156d6f8f1eea8b35a2",
    attribution: "Andy Allan and contributors; original cartography by Steve Chilton and others"}
].map(Object.freeze));
const title = value => value.replace(/[-_]/g, " ").replace(/\b[a-z]/g, letter => letter.toUpperCase());
function category(path, collection) {
  if (collection === 1) return ({amenity: "Amenities", barrier: "Barriers", highway: "Roads", historic: "Historic places",
    leisure: "Leisure", man_made: "Structures", natural: "Nature", office: "Offices", place: "Places",
    religion: "Religion", shop: "Shops", tourism: "Tourism", shields: "Route shields",
    generating_patterns: "Pattern motifs", unpaved: "Unpaved patterns"})[path.split("/")[0]] ?? "Line and pattern primitives";
  if (/hospital|doctor|dentist|pharmacy|blood|defibrillator|emergency|fire|police|rescue/.test(path)) return "Health and emergency";
  if (/school|college|library|town-hall|post|prison|embassy|courthouse/.test(path)) return "Education and civic";
  if (/airport|airfield|aerialway|heliport|bus|rail|ferry|car|bicycle|scooter|road|parking|entrance|fuel|charging|bridge/.test(path)) return "Transport";
  if (/religious|cemetery|museum|theatre|art|monument|historic|castle|marae/.test(path)) return "Culture and religion";
  if (/shop|store|restaurant|cafe|bar|beer|bakery|grocery|convenience|bank|money|hairdresser|laundry|lodging|hotel|watch/.test(path)) return "Food, shops and services";
  if (/sport|ball|ski|swim|golf|camp|picnic|playground|amusement|fitness|stadium|bowling|ranger/.test(path)) return "Leisure and sport";
  if (/water|tree|forest|mountain|beach|park|garden|wetland|volcano|zoo|animal|aquarium|dog|horse/.test(path)) return "Nature";
  if (/circle|triangle|square|diamond|marker|arrow|cross|heart|star|caution|danger/.test(path)) return "Shapes and signs";
  return "Places and services";
}
function importedSymbol([index, path, pixelIndex, kind, extension = "svg"]) {
  const collection = POINT_SYMBOL_COLLECTIONS[index + 1], group = category(path, index);
  const label = title(path.split("/").at(-1));
  const originalPath = `${index === 0 ? "icons" : "symbols"}/${path}.${extension}`;
  return Object.freeze({id: `${index === 0 ? "maki-8-2-0" : "osm-carto-1cc4b89c"}-${path.replaceAll("/", "--").toLowerCase()}${extension === "png" ? "-png" : ""}`,
    label, collection: collection.id, category: group,
    tags: Object.freeze([...new Set([...path.toLowerCase().split(/[\/_-]/), group.toLowerCase()])]),
    source: Object.freeze({path: originalPath, url: `${collection.sourceUrl.replace("/tree/", "/blob/")}/${originalPath}`,
      version: collection.version, commit: collection.commit, archiveSha256: collection.archiveSha256, license: collection.license,
      ...(kind && /^generating_patterns\/(?:broadleaved|leafless1|leafless2|needleleaved)$/.test(path)
        ? {previewTransform: "Derived SVG geometry bounds with one source-unit padding; original has no viewport"} : {})}),
    ...(kind ? {kind, format: extension} : {}), pixelIndex});
}
const IMPORTED_SYMBOLS = IMPORTED_POINT_SYMBOL_ROWS.filter(row => row[3] !== "reference").map(importedSymbol);
export const REFERENCE_SYMBOLS = Object.freeze(IMPORTED_POINT_SYMBOL_ROWS.filter(row => row[3] === "reference").map(importedSymbol));
export const POINT_SYMBOLS = Object.freeze([
  ["circle", "Circle"], ["hospital", "Hospital"], ["clinic", "Clinic"],
  ["school", "School"], ["star", "Star"], ["flag", "Flag"]
].map(([id, label]) => Object.freeze({id, label, collection: "builtin", category: "Original glyphs", tags: Object.freeze([id]),
  source: Object.freeze({version: "1", license: "Original OpenGeo glyphs", attribution: "OpenGeo.Tools"})})).concat(IMPORTED_SYMBOLS));
const SYMBOL_IDS = new Set(POINT_SYMBOLS.map(symbol => symbol.id));
if (SYMBOL_IDS.size !== POINT_SYMBOLS.length) throw new Error("Point symbol identities must be unique");
const IMPORTED_BY_ID = new Map(IMPORTED_SYMBOLS.map(symbol => [symbol.id, symbol]));
const REFERENCE_BY_ID = new Map(REFERENCE_SYMBOLS.map(symbol => [symbol.id, symbol]));
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const CACHE = new Map();
let pointAssets, referenceAssets, pointAssetsPromise, referenceAssetsPromise;

export async function ensurePointSymbolAssets(value = {}) {
  const style = normalizePointSymbolStyle(value);
  const selected = [style.pointSymbol, ...(style.renderer === "category" ? Object.values(style.categorySymbols ?? {}) : [])];
  if (pointAssets || !selected.some(id => IMPORTED_BY_ID.has(id))) return;
  pointAssetsPromise ??= import("./pointSymbolPixels.js").catch(error => {pointAssetsPromise = null;throw error;});
  pointAssets = await pointAssetsPromise;
}

export async function ensureReferenceSymbolAssets() {
  if (referenceAssets) return;
  referenceAssetsPromise ??= import("./referenceSymbolPixels.js").catch(error => {referenceAssetsPromise = null;throw error;});
  referenceAssets = await referenceAssetsPromise;
}

export function hasPointSymbolStyle(style) {
  return Boolean(style && (Object.hasOwn(style, "pointSymbol") || Object.hasOwn(style, "categorySymbols")));
}

export function pointSymbolImageId(symbol) {
  if (!SYMBOL_IDS.has(symbol)) throw new Error("Unknown point symbol");
  return `opengeo-point-${symbol}-v1`;
}

export function normalizePointSymbolStyle(style = {}) {
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new Error("Invalid point style");
  const result = {...style, pointSymbol: style.pointSymbol ?? "circle"};
  pointSymbolImageId(result.pointSymbol);
  if (style.circleRadius !== undefined && (typeof style.circleRadius !== "number"
    || !Number.isFinite(style.circleRadius) || style.circleRadius < 2 || style.circleRadius > 24)) {
    throw new Error("Point radius must be between 2 and 24");
  }
  if (style.categorySymbols !== undefined) {
    const values = style.categorySymbols;
    if (!values || typeof values !== "object" || Array.isArray(values)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(values))
      || Object.keys(values).length > 48) throw new Error("Invalid category symbols");
    const entries = Object.entries(values);
    for (const [category, symbol] of entries) {
      if (!category || category.length > 128 || FORBIDDEN.has(category)
        || /[\u0000-\u001f\u007f]/.test(category)) throw new Error("Invalid symbol category");
      pointSymbolImageId(symbol);
    }
    result.categorySymbols = Object.fromEntries(entries);
  }
  if (style.categoryField !== undefined && (typeof style.categoryField !== "string"
    || !style.categoryField || style.categoryField.length > 128 || FORBIDDEN.has(style.categoryField)
    || /[\u0000-\u001f\u007f]/.test(style.categoryField))) throw new Error("Invalid symbol category field");
  return result;
}

export function pointSymbolStyleParts(layer) {
  if (!["Point", "MultiPoint"].includes(layer?.geometryType)) return [];
  // Existing circle styles keep their original radius/fields. The stricter
  // built-in glyph contract applies only after an explicit symbol selection.
  if (!hasPointSymbolStyle(layer.style)) return [];
  const style = normalizePointSymbolStyle(layer.style);
  const categories = style.renderer === "category" && style.categoryField
    ? Object.entries(style.categorySymbols ?? {}) : [];
  if (style.pointSymbol === "circle" && categories.every(([, value]) => value === "circle")) return [];
  const image = categories.length
    ? ["match", ["to-string", ["get", style.categoryField]],
      ...categories.flatMap(([value, symbol]) => [value, pointSymbolImageId(symbol)]), pointSymbolImageId(style.pointSymbol)]
    : pointSymbolImageId(style.pointSymbol);
  return [{id: "point-symbol", type: "symbol", layout: {
    "icon-image": image, "icon-size": (style.circleRadius ?? 6) / 16,
    "icon-allow-overlap": true, "icon-ignore-placement": true
  }, paint: {"icon-opacity": 1}}];
}

export function pointSymbolImages(value = {}) {
  const style = normalizePointSymbolStyle(value);
  const symbols = new Set([style.pointSymbol]);
  if (style.renderer === "category") for (const symbol of Object.values(style.categorySymbols ?? {})) symbols.add(symbol);
  return [...symbols].map(symbol => ({id: pointSymbolImageId(symbol), pixels: pixels(symbol), pixelRatio: 2}));
}

function pixels(symbol) {
  if (!CACHE.has(symbol)) {
    const imported = IMPORTED_BY_ID.get(symbol);
    if (imported) {
      if (!pointAssets) throw new Error("Point symbol assets have not been loaded");
      CACHE.set(symbol, importedPixels(imported.pixelIndex, pointAssets));
    }
    else {
    const mask = new Uint8Array(64 * 64), data = new Uint8Array(64 * 64 * 4);
    const rect = (x, y, a, b, c, d) => x >= a && x <= c && y >= b && y <= d;
    const polygon = (x, y, points) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [a, b] = points[i], [c, d] = points[j];
        if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
      }
      return inside;
    };
    const star = Array.from({length: 10}, (_, i) => {
      const angle = i * Math.PI / 5 - Math.PI / 2, radius = i % 2 ? 11 : 27;
      return [32 + Math.cos(angle) * radius, 32 + Math.sin(angle) * radius];
    });
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const a = x + .5, b = y + .5;
      const filled = symbol === "hospital"
        ? rect(a,b,14,11,25,53) || rect(a,b,39,11,50,53) || rect(a,b,25,26,39,38)
        : symbol === "clinic" ? rect(a,b,25,9,39,55) || rect(a,b,9,25,55,39)
        : symbol === "school" ? polygon(a,b,[[7,26],[32,9],[57,26]])
          || (rect(a,b,13,28,51,53) && !(rect(a,b,27,37,37,53) || rect(a,b,18,34,23,42) || rect(a,b,41,34,46,42)))
        : symbol === "star" ? polygon(a,b,star)
        : symbol === "flag" ? rect(a,b,16,9,21,55) || polygon(a,b,[[21,11],[52,15],[44,28],[21,25]])
        : false;
      mask[y * 64 + x] = filled ? 1 : 0;
    }
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const i = y * 64 + x, fill = mask[i];
      const edge = !fill && [-1,0,1].some(dy => [-1,0,1].some(dx => {
        const a = x + dx, b = y + dy;
        return a >= 0 && a < 64 && b >= 0 && b < 64 && mask[b * 64 + a];
      }));
      if (fill || edge) data.set(fill ? [255,255,255,255] : [30,41,59,255], i * 4);
    }
    CACHE.set(symbol, {width: 64, height: 64, data});
    }
  }
  const image = CACHE.get(symbol);
  // Callers may upload or package these bytes without sharing mutable cache data.
  return {...image, data: image.data.slice()};
}

function importedPixels(index, {POINT_SYMBOL_PALETTE, POINT_SYMBOL_SCANLINES, POINT_SYMBOL_PIXEL_DATA}) {
  const rows = bytes(POINT_SYMBOL_PIXEL_DATA[index]), data = new Uint8Array(64 * 64 * 4);
  const position = {value: 0};
  for (let y = 0; y < 64; y++) {
    const line = bytes(POINT_SYMBOL_SCANLINES[variable(rows, position)]), cursor = {value: 0};
    let x = 0;
    while (cursor.value < line.length) {
      const count = line[cursor.value++], color = variable(line, cursor) * 8;
      const rgba = [0, 2, 4, 6].map(offset => parseInt(POINT_SYMBOL_PALETTE.slice(color + offset, color + offset + 2), 16));
      for (let end = x + count; x < end; x++) data.set(rgba, (y * 64 + x) * 4);
    }
    if (x !== 64) throw new Error("Invalid packaged point symbol scanline");
  }
  if (position.value !== rows.length) throw new Error("Invalid packaged point symbol rows");
  return {width: 64, height: 64, data};
}
function bytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function variable(data, position) {
  let value = 0, shift = 0, byte;
  do {byte = data[position.value++];value |= (byte & 127) << shift;shift += 7;} while (byte & 128);
  return value;
}

export function pointSymbolPreviewSvg(value = {}) {
  const style = normalizePointSymbolStyle(value), image = pixels(style.pointSymbol);
  const color = /^#[0-9a-f]{6}$/i.test(style.circleColor ?? "") ? style.circleColor : "#2563eb";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="${color}"/>${pixelSvgRuns(image)}</svg>`;
}

export function referenceSymbolPreviewSvg(id) {
  const symbol = REFERENCE_BY_ID.get(id);
  if (!symbol) throw new Error("Unknown reference symbol");
  if (!referenceAssets) throw new Error("Reference symbol assets have not been loaded");
  if (!CACHE.has(id)) CACHE.set(id, importedPixels(symbol.pixelIndex, referenceAssets));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${pixelSvgRuns(CACHE.get(id))}</svg>`;
}

function pixelSvgRuns(image) {
  let runs = "";
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64;) {
    const i = (y * 64 + x) * 4;
    if (!image.data[i + 3]) {x++; continue;}
    const start = x, rgba = image.data.slice(i, i + 4);
    const fill = `#${[...rgba.slice(0, 3)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
    while (x < 64 && rgba.every((value, index) => image.data[(y * 64 + x) * 4 + index] === value)) x++;
    runs += `<rect x="${start}" y="${y}" width="${x-start}" height="1" fill="${fill}"${rgba[3] === 255 ? "" : ` fill-opacity="${rgba[3] / 255}"`}/>`;
  }
  return runs;
}
