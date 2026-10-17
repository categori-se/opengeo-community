// Compile only reviewed, pinned local originals. No provider or runtime SVG reads.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {gzipSync} from "node:zlib";
import {chromium} from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const archive = resolve(root, ".local-archives/renderer-switch-20260930/symbology-library-20261016");
const pilot = process.argv.includes("--pilot");
const check = process.argv.includes("--check");
const rasterRecipeVersion = 1;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const json = name => readFile(resolve(archive, name), "utf8").then(JSON.parse);
const [maki, osm] = await Promise.all([json("maki-8.2.0-source-audit.json"), json("osm-carto-source-audit.json")]);
assert.equal(maki.archiveSha256, "f6e59156521117c311c0e73a6aeef8d5039daea9c7fbe1ff9264e18a3ebec87f");
assert.equal(osm.archiveSha256, "851f1322e613c8fc11145c74cbc00e3f2c15fc39b7ee492d2ad1f945a2b4dc5e");
const directories = ["amenity", "barrier", "highway", "historic", "leisure", "man_made", "natural", "office", "place", "religion", "shop", "tourism", "shields"];
let sources = [
  ...maki.svgFiles.map(row => ({...row, collection: 0, stage: "maki-8.2.0"})),
  ...osm.inventory.filter(row => directories.includes(row.path.split("/")[1]))
    .map(row => ({...row, collection: 1, stage: `osm-carto-${osm.sourceCommit}`}))
];
assert.equal(sources.filter(row => row.collection === 0).length, 215);
assert.equal(sources.filter(row => row.collection === 1).length, 921);
sources.push(...osm.inventory.filter(row => !directories.includes(row.path.split("/")[1]))
  .map(row => ({...row, collection: 1, stage: `osm-carto-${osm.sourceCommit}`, kind: "reference"})),
...osm.pngInventory.map(row => ({...row, collection: 1, stage: `osm-carto-${osm.sourceCommit}`, kind: "reference"})));
assert.equal(sources.length, 1213);
if (pilot) {
  const paths = ["hospital", "bicycle", "religious-jewish", "zoo", "airport", "fence", "amenity/hospital", "amenity/bicycle_parking",
    "religion/christian", "tourism/museum", "natural/tree", "shop/supermarket", "shields/motorway_1x1", "shields/trunk_4x2",
    "shields/primary_11x4_z18", "shields/secondary_2x1_z16", "shields/tertiary_6x3", "historic/castle"];
  sources = sources.filter(row => paths.includes(row.path.replace(/^(?:icons|symbols)\//, "").replace(/\.svg$/, "")));
  assert.ok(sources.length >= 14);
}
const started = performance.now();
for (const row of sources) {
  const original = await readFile(resolve(archive, "vendor-originals", row.stage, row.path));
  assert.equal(sha256(original), row.sha256, row.path);
  row.extension = row.path.endsWith(".png") ? "png" : "svg";
  if (row.extension === "png") {row.png = original.toString("base64");continue;}
  row.svg = original.toString("utf8");
  // Local #use/clipPath references are retained. Active or remote assets fail.
  assert.doesNotMatch(row.svg, /<(?:script|foreignObject|image|iframe|style)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)[^\s)/]/i, row.path);
}
// Reuse the committed point rasters when adding reference assets or checking the
// generator. Their source pins and exact original hashes above remain mandatory.
let retained = new Map();
try {
  const [{IMPORTED_POINT_SYMBOL_ROWS: previous}, point] = await Promise.all(["pointSymbolRegistry.js", "pointSymbolPixels.js"]
    .map(name => import(pathToFileURL(resolve(root, "app/src/lib", name)))));
  const reference = await import(pathToFileURL(resolve(root, "app/src/lib/referenceSymbolPixels.js"))).catch(error => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return point;throw error;
  });
  assert.equal(point.POINT_SYMBOL_RASTER_RECIPE ?? 1, rasterRecipeVersion, "Raster recipe changed: rebuild with --fresh");
  const readVariable = (data, position) => {let value = 0, shift = 0, byte;do {byte = data[position.value++];value |= (byte & 127) << shift;shift += 7;} while (byte & 128);return value;};
  for (const [collection, path, index, kind, extension] of previous) {
    const {POINT_SYMBOL_PALETTE: colors, POINT_SYMBOL_SCANLINES: lines, POINT_SYMBOL_PIXEL_DATA: images} = kind ? reference : point;
    const packed = Buffer.from(images[index], "base64"), data = Buffer.alloc(16384), cursor = {value: 0};
    for (let y = 0; y < 64; y++) {
      const line = Buffer.from(lines[readVariable(packed, cursor)], "base64"), p = {value: 0};let x = 0;
      while (p.value < line.length) {const count = line[p.value++], color = readVariable(line, p) * 8;
        const rgba = Buffer.from(colors.slice(color, color + 8), "hex");for (let end = x + count; x < end; x++) rgba.copy(data, (y * 64 + x) * 4);}
    }
    retained.set(`${collection}:${path}.${extension || "svg"}`, data);
  }
} catch (error) {if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;}
const retainedHashes = new Map([...retained].map(([path, data]) => [path, sha256(data)]));
if (check || process.argv.includes("--fresh")) retained.clear();
let newRasters = 0, browser, page;
const rendered = [];
try {
  for (let start = 0; start < sources.length; start += 48) {
    const batch = sources.slice(start, start + 48);
    const missing = batch.filter(row => !retained.has(`${row.collection}:${row.path.replace(/^(?:icons|symbols)\//, "")}`));
    newRasters += missing.length;
    if (missing.length && !page) {
      browser = await chromium.launch({headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/opt/brave.com/brave/brave",
        args: ["--disable-gpu", "--no-sandbox"]});
      const context = await browser.newContext();
      await context.route("**/*", route => route.abort());
      page = await context.newPage();
    }
    const output = !missing.length ? [] : await page.evaluate(async rows => {
      const results = [];
      for (const row of rows) {
        let svg = row.svg;
        if (svg && !/<svg[^>]+\b(?:viewBox|width)\s*=/i.test(svg)) {
          const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
          const node = document.importNode(parsed.documentElement, true);document.body.append(node);
          const bounds = node.getBBox();node.remove();
          if (!bounds.width || !bounds.height) throw new Error("Missing SVG bounds");
          node.setAttribute("viewBox", `${bounds.x - 1} ${bounds.y - 1} ${bounds.width + 2} ${bounds.height + 2}`);
          node.setAttribute("width", String(bounds.width + 2));node.setAttribute("height", String(bounds.height + 2));
          svg = new XMLSerializer().serializeToString(node);
        }
        const image = new Image();
        image.src = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : `data:image/png;base64,${row.png}`;
        await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error("SVG decode timeout")), 5000))]);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext("2d", {willReadFrequently: true});
        const scale = 54 / Math.max(image.naturalWidth, image.naturalHeight);
        const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        ctx.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        if (row.collection === 0) {
          // Match the original built-ins: a white glyph with a one-pixel dark halo.
          const mask = Array.from({length: 4096}, (_, index) => data[index * 4 + 3] >= 128);
          data.fill(0);
          for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            const fill = mask[y * 64 + x];
            const edge = !fill && [-1, 0, 1].some(dy => [-1, 0, 1].some(dx =>
              x + dx >= 0 && x + dx < 64 && y + dy >= 0 && y + dy < 64 && mask[(y + dy) * 64 + x + dx]));
            if (fill || edge) data.set(fill ? [255, 255, 255, 255] : [30, 41, 59, 255], (y * 64 + x) * 4);
          }
        }
        results.push(btoa(String.fromCharCode(...data)));
      }
      return results;
    }, missing.map(({svg, png, collection}) => ({svg, png, collection})));
    missing.forEach((row, index) => retained.set(`${row.collection}:${row.path.replace(/^(?:icons|symbols)\//, "")}`, Buffer.from(output[index], "base64")));
    rendered.push(...batch.map(row => retained.get(`${row.collection}:${row.path.replace(/^(?:icons|symbols)\//, "")}`)));
    if (!pilot && missing.length) console.log(`Raster checkpoint: ${Math.min(start + 48, sources.length)}/${sources.length}; new rasters ${missing.length}`);
  }
} finally {await browser?.close();}

// Exact indexed RGBA row runs. Shared rows preserve small shield variants without
// repeating whole images; the runtime decodes only the requested 64 rows.
const families = Object.fromEntries(["point", "reference"].map(kind => [kind,
  {palette: new Map(), scanlines: new Map(), unique: [], indexes: new Map()}]));
function variable(value, output) {
  do {output.push((value & 127) | (value > 127 ? 128 : 0));value >>>= 7;} while (value);
}
function pack(data, {palette, scanlines}) {
  const image = [];
  for (let y = 0; y < 64; y++) {
    const row = [];
    for (let x = 0; x < 64;) {
      const pixel = data.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4);
      const color = pixel.toString("hex");
      if (!palette.has(color)) palette.set(color, palette.size);
      let end = x + 1;
      while (end < 64 && pixel.equals(data.subarray(y * 256 + end * 4, y * 256 + end * 4 + 4))) end++;
      row.push(end - x);variable(palette.get(color), row);x = end;
    }
    const line = Buffer.from(row).toString("base64");
    if (!scanlines.has(line)) scanlines.set(line, scanlines.size);
    variable(scanlines.get(line), image);
  }
  return Buffer.from(image).toString("base64");
}
const rows = [];
for (let i = 0; i < sources.length; i++) {
  const {collection, path, kind, extension} = sources[i], data = rendered[i];
  if (pilot && process.argv.includes("--fresh")) assert.equal(sha256(data), retainedHashes.get(`${collection}:${path.replace(/^(?:icons|symbols)\//, "")}`), `Pilot raster changed: ${path}`);
  const family = families[kind || "point"], {unique, indexes} = family;
  assert.ok(data.some((value, index) => index % 4 === 3 && value), `Empty glyph: ${path}`);
  const hash = sha256(data);
  if (!indexes.has(hash)) {indexes.set(hash, unique.length);unique.push(pack(data, family));}
  rows.push([collection, path.replace(/^(?:icons|symbols)\//, "").replace(/\.(?:svg|png)$/, ""), indexes.get(hash), ...(kind ? [kind, extension] : [])]);
}
const provenance = `// CC0-1.0: Maki 8.2.0, source archive SHA-256 ${maki.archiveSha256}.\n// CC0-1.0: OpenStreetMap Carto ${osm.sourceCommit}, source archive SHA-256 ${osm.archiveSha256}.\n// Source and license metadata: app/src/data/symbology-sources.json; per-file checksums in retained source audits.\n`;
const pixelModule = ({palette, scanlines, unique}) => `// Generated by app/scripts/build-point-symbols.mjs; do not edit.\n${provenance}// Shared RGBA palette, RLE scanlines, and per-image unsigned base-128 row indexes.\nexport const POINT_SYMBOL_RASTER_RECIPE = ${rasterRecipeVersion};\nexport const POINT_SYMBOL_PALETTE = ${JSON.stringify([...palette.keys()].join(""))};\nexport const POINT_SYMBOL_SCANLINES = Object.freeze(${JSON.stringify([...scanlines.keys()])});\nexport const POINT_SYMBOL_PIXEL_DATA = Object.freeze(${JSON.stringify(unique)});\n`;
const pixelsModule = pixelModule(families.point), referencePixelsModule = pixelModule(families.reference);
const registryModule = `// Generated by app/scripts/build-point-symbols.mjs; do not edit.\n${provenance}// [collection, original path without extension, pixel payload].\nexport const IMPORTED_POINT_SYMBOL_ROWS = Object.freeze(${JSON.stringify(rows)}.map(Object.freeze));\n`;
const combined = pixelsModule + referencePixelsModule + registryModule;
const report = {mode: pilot ? "pilot" : check ? "check" : "compile", count: sources.length,
  uniquePixelPayloads: Object.values(families).reduce((sum, family) => sum + family.unique.length, 0),
  families: Object.fromEntries(Object.entries(families).map(([kind, family]) => {const module = pixelModule(family);return [kind,
    {uniquePixelPayloads: family.unique.length, paletteColors: family.palette.size, uniqueScanlines: family.scanlines.size,
      runtimeRawBytes: Buffer.byteLength(module), runtimeGzipBytes: gzipSync(module, {level: 9}).length}];})),
  runtimeRawBytes: Buffer.byteLength(combined), runtimeGzipBytes: gzipSync(combined, {level: 9}).length,
  elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)), externalRequests: 0,
  reusedRasters: sources.length - newRasters, newRasters,
  rasterRecipeVersion,
  raster: "64x64 RGBA; Maki binary white/halo; OSM exact source colors and alpha; aspect ratio preserved within 54x54",
  sourcePins: [maki.archiveSha256, osm.archiveSha256]};
if (pilot) {
  report.projectedRawBytes = Math.ceil(report.runtimeRawBytes / sources.length * 1136);
  report.projectedGzipBytes = Math.ceil(report.runtimeGzipBytes / sources.length * 1136);
  await writeFile(resolve(archive, "point-symbol-pilot.rgba"), Buffer.concat(rendered));
} else {
  for (const [name, contents] of [["pointSymbolPixels.js", pixelsModule], ["referenceSymbolPixels.js", referencePixelsModule], ["pointSymbolRegistry.js", registryModule]]) {
    const path = resolve(root, "app/src/lib", name);
    if (check) assert.equal(await readFile(path, "utf8"), contents, `${name} differs from pinned originals`);
    else await writeFile(path, contents);
  }
}
const receipt = resolve(archive, pilot ? "point-symbol-pilot.json" : "point-symbol-compile.json");
const prior = await readFile(receipt, "utf8").then(JSON.parse).catch(error => {if (error.code === "ENOENT") return null;throw error;});
report.attempts = [...(prior?.attempts ?? (prior ? [{mode: prior.mode, count: prior.count, elapsedSeconds: prior.elapsedSeconds,
  newRasters: prior.newRasters ?? "not measured separately", reusedRasters: prior.reusedRasters ?? "not measured separately"}] : [])),
{mode: report.mode, count: report.count, elapsedSeconds: report.elapsedSeconds, newRasters, reusedRasters: report.reusedRasters}];
const updated = {...prior, ...report};
if (prior?.usage) updated.usage = {...prior.usage,
  scriptMeasuredSecondsIncludingBothPilotsAndFreshCheck: Number((prior.usage.scriptMeasuredSecondsIncludingBothPilotsAndFreshCheck + report.elapsedSeconds).toFixed(3)),
  browserRasterInvocations: prior.usage.browserRasterInvocations + (newRasters ? 1 : 0),
  rasterFramesIncludingPilotsAndFreshVerification: prior.usage.rasterFramesIncludingPilotsAndFreshVerification + newRasters,
  cachedRepackInvocations: prior.usage.cachedRepackInvocations + (newRasters ? 0 : 1)};
await writeFile(receipt, JSON.stringify(updated, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
