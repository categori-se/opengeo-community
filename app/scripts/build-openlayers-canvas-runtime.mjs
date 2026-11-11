import {build, version as esbuildVersion} from "esbuild";
import {createHash} from "node:crypto";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const installedAppRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = `
export {default as Map} from 'ol/Map.js';
export {default as View} from 'ol/View.js';
export {default as VectorLayer} from 'ol/layer/Vector.js';
export {default as TileLayer} from 'ol/layer/Tile.js';
export {default as VectorSource} from 'ol/source/Vector.js';
export {default as XYZ} from 'ol/source/XYZ.js';
export {default as GeoJSON} from 'ol/format/GeoJSON.js';
export {default as Style} from 'ol/style/Style.js';
export {default as Fill} from 'ol/style/Fill.js';
export {default as Stroke} from 'ol/style/Stroke.js';
export {default as Circle} from 'ol/style/Circle.js';
export {default as Text} from 'ol/style/Text.js';
export {default as Draw} from 'ol/interaction/Draw.js';
export {defaults} from 'ol/interaction/defaults.js';
export {fromLonLat, toLonLat, getPointResolution} from 'ol/proj.js';
export {asArray} from 'ol/color.js';
export {unByKey} from 'ol/Observable.js';
export {default as Zoom} from 'ol/control/Zoom.js';
export {default as ScaleLine} from 'ol/control/ScaleLine.js';
export {default as OverviewMap} from 'ol/control/OverviewMap.js';
`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Framework bundles individual package entry points independently. Keep native
// instanceof checks (Map/View, Layer and Style) in one deduplicated SDK graph.
export async function buildOpenLayersCanvasRuntime({appRoot = installedAppRoot} = {}) {
  const metadata = JSON.parse(await readFile(resolve(appRoot, "node_modules/ol/package.json"), "utf8"));
  if (metadata.version !== "10.10.0" || esbuildVersion !== "0.28.2") throw Error("Canvas runtime requires reviewed OpenLayers 10.10.0 and esbuild 0.28.2");
  const result = await build({absWorkingDir: appRoot, stdin: {contents: entry, resolveDir: appRoot, sourcefile: "openlayers-canvas-sdk.js"},
    bundle: true, splitting: false, format: "esm", platform: "browser", write: false, logLevel: "silent", minify: true, legalComments: "inline",
    banner: {js: "// OpenLayers 10.10.0, BSD-2-Clause. See the distribution's third-party notices."}});
  return result.outputFiles[0].contents;
}

export async function prepareOpenLayersCanvasRuntimeAsset(sourceRoot, {appRoot = installedAppRoot} = {}) {
  const fingerprint = createHash("sha256").update(esbuildVersion).update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(resolve(appRoot, "package-lock.json")))
    .update(await readFile(resolve(appRoot, "node_modules/ol/package.json"))).digest("hex");
  const asset = resolve(sourceRoot, "assets/openlayers-canvas-runtime.js");
  const cache = resolve(sourceRoot, ".observablehq/cache/assets"), marker = resolve(cache, "openlayers-canvas-runtime.inputs");
  const [previousInput, previousOutput] = (await readFile(marker, "utf8").catch(() => "")).split(":");
  const previous = await readFile(asset).catch(() => null);
  if (previousInput === fingerprint && previous && digest(previous) === previousOutput) return false;
  const bytes = await buildOpenLayersCanvasRuntime({appRoot});
  await mkdir(resolve(sourceRoot, "assets"), {recursive: true});await mkdir(cache, {recursive: true});
  await writeFile(asset, bytes);await writeFile(marker, `${fingerprint}:${digest(bytes)}`);return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareOpenLayersCanvasRuntimeAsset(resolve(installedAppRoot, "src"));
}
