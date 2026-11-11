import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {fromCustomClient, writeArrayBuffer} from "geotiff";
import {strFromU8, unzipSync, unzlibSync} from "fflate";
import {JSDOM} from "jsdom";
import proj4 from "proj4";
import {exportRasterSuperOverlay} from "../src/lib/kmlRasterSuperOverlay.js";
import {RasterSuperOverlayExport} from "../src/components/RasterSuperOverlayExport.js";

const libraryLoader = async () => ({fromCustomClient});
const digest = b => createHash("sha256").update(b).digest("hex");
function source({width = 512, height = 256, samples = 4, metadata = {}, valueAt = x => x % 256} = {}) {
  const values = new Uint8Array(width * height * samples);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * samples;
    values[i] = valueAt(x, y);
    if (samples > 1) {values[i + 1] = y % 256; values[i + 2] = 80;}
    if (samples === 4) values[i + 3] = x < width / 2 ? 100 : 255;
  }
  const bytes = new Uint8Array(writeArrayBuffer(values, {width, height, SamplesPerPixel: samples,
    BitsPerSample: Array(samples).fill(8), PhotometricInterpretation: samples === 1 ? 1 : 2,
    ...(samples === 4 ? {ExtraSamples: [2]} : {}), GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, ModelPixelScale: [4 / width, 2 / height, 0],
    ModelTiepoint: [0, 0, 0, 10, 52, 0], ...metadata}));
  return {bytes, values, file: {name: 'survey<&".tif', size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)}};
}
function pngPixels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pieces = [];
  assert.equal(view.getUint32(16), 256); assert.equal(view.getUint32(20), 256);
  for (let i = 8; i < bytes.length;) {
    const length = view.getUint32(i), type = strFromU8(bytes.subarray(i + 4, i + 8));
    if (type === "IDAT") pieces.push(bytes.subarray(i + 8, i + 8 + length));
    i += length + 12;
  }
  assert.equal(pieces.length, 1); const scanlines = unzlibSync(pieces[0]);
  return (x, y) => [...scanlines.subarray(y * 1025 + 1 + x * 4, y * 1025 + 5 + x * 4)];
}

it("converts the entire georeferenced source into a deterministic local pyramid with alpha and lineage", async () => {
  const {file, bytes, values} = source({metadata: {Copyright: "Original team; CC0"}}), before = digest(bytes), previous = globalThis.fetch;
  globalThis.fetch = () => {throw Error("No network is allowed for local raster export");};
  let first, second;
  try {
    first = await exportRasterSuperOverlay(file, {libraryLoader, attribution: "Survey team © 2026; CC BY 4.0 <terms>"});
    second = await exportRasterSuperOverlay(file, {libraryLoader, attribution: "Survey team © 2026; CC BY 4.0 <terms>"});
  } finally {globalThis.fetch = previous;}
  assert.deepEqual(first.bytes, second.bytes); assert.equal(digest(bytes), before);
  assert.equal(first.report.source.sha256, before); assert.deepEqual(first.report.bounds, [10, 50, 14, 52]);
  assert.equal(first.report.tiles.length, 5); assert.equal(first.report.levels, 2);
  const files = unzipSync(first.bytes), doc = new JSDOM(strFromU8(files["doc.kml"]), {contentType: "text/xml"}).window.document;
  assert.equal(doc.querySelector("name").textContent, file.name);
  assert.equal(first.report.source.copyright, "Original team; CC0");
  const balloon = new JSDOM(doc.querySelector("description").textContent).window.document;
  assert.equal(balloon.querySelector("terms"), null);
  assert.equal(balloon.body.textContent, "Original team; CC0\n\nSurvey team © 2026; CC BY 4.0 <terms>");
  assert.equal(Object.keys(files)[0], "doc.kml");
  assert.equal(doc.querySelectorAll("NetworkLink").length, 1);
  const tileDoc = new JSDOM(strFromU8(files["r0-0-0.kml"]), {contentType: "text/xml"}).window.document;
  assert.equal(tileDoc.querySelectorAll("NetworkLink").length, 4);
  assert.equal(tileDoc.querySelector("GroundOverlay maxLodPixels").textContent, "256");
  for (const href of doc.querySelectorAll("href")) assert.ok(files[href.textContent]);
  const root = pngPixels(files["r0-0-0.png"]), leaf = pngPixels(files["r1-1-1.png"]);
  assert.deepEqual(root(0, 0), [...values.subarray(4, 8)]);
  assert.deepEqual(leaf(255, 255), [255, 255, 80, 255]);
  for (const tile of first.report.tiles) assert.equal(digest(files[tile.image]), tile.sha256);
  assert.equal(JSON.parse(strFromU8(files["opengeo-raster-lineage.json"])).source.attribution, "Survey team © 2026; CC BY 4.0 <terms>");
});

it("bounds a cyclic TIFF directory chain rather than entering an unbounded metadata walk", async () => {
  // The installed writer has no tag254 encoder. Replace its disposable Software
  // directory entry with a valid LONG NewSubfileType before making the cycle.
  const {bytes, file} = source({width: 2, height: 2, metadata: {Software: "OpenGeo"}});
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), little = bytes[0] === 0x49;
  const offset = view.getUint32(4, little), count = view.getUint16(offset, little);
  let replaced = false;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + 12 * i;
    if (view.getUint16(entry, little) !== 305) continue;
    view.setUint16(entry, 254, little); view.setUint16(entry + 2, 4, little);
    view.setUint32(entry + 4, 1, little); view.setUint32(entry + 8, 1, little); replaced = true;
  }
  assert.equal(replaced, true);
  view.setUint32(offset + 2 + 12 * count, offset, little);
  await assert.rejects(exportRasterSuperOverlay(file, {libraryLoader}), {code: "super_overlay_directories"});
});

it("reprojects Web Mercator pixel rows to geographic overlay rows and preserves declared NoData", async () => {
  const top = 15538711.09630922;
  const {file} = source({width: 256, height: 256, samples: 1, valueAt: (x, y) => y, metadata: {
    GTModelTypeGeoKey: 1, GeographicTypeGeoKey: undefined, ProjectedCSTypeGeoKey: 3857,
    ModelPixelScale: [111319.49079327357 / 256, top / 256, 0],
    ModelTiepoint: [0, 0, 0, 0, top, 0], GDAL_NODATA: "176"
  }});
  const result = await exportRasterSuperOverlay(file, {libraryLoader}), files = unzipSync(result.bytes);
  assert.equal(result.report.source.projection, "EPSG:3857");
  assert.ok(Math.abs(result.report.bounds[3] - 80) < 1e-12);
  const pixels = pngPixels(files["r0-0-0.png"]);
  const [, projected] = proj4("EPSG:4326", "EPSG:3857", [0.5, 80 - 80 * 128.5 / 256]);
  const sourceRow = Math.floor((top - projected) / (top / 256));
  assert.equal(sourceRow, 176); assert.notEqual(sourceRow, 128);
  assert.deepEqual(pixels(128, 128), [sourceRow, sourceRow, sourceRow, 0]);
  assert.deepEqual(pixels(255, 255), [255, 255, 255, 255]);
});

it("rejects unknown projections, rotated grids and unsupported samples before silently changing their meaning", async () => {
  const {file} = source({width: 2, height: 2});
  await assert.rejects(exportRasterSuperOverlay({...file, name: "bad\u0001.tif"}, {libraryLoader}), {code: "super_overlay_filename"});
  await assert.rejects(exportRasterSuperOverlay(file, {libraryLoader, attribution: "bad\ud800"}), {code: "super_overlay_attribution"});
  for (const [metadata, code] of [
    [{GeographicTypeGeoKey: 4269}, "super_overlay_projection"],
    [{ModelTransformation: [1, 0.1, 0, 10, 0, -1, 0, 52, 0, 0, 1, 0, 0, 0, 0, 1]}, "super_overlay_projection"],
    [{BitsPerSample: [16, 16, 16, 16]}, "super_overlay_sample_type"]
  ]) {
    const {file} = source({width: 2, height: 2, metadata});
    await assert.rejects(exportRasterSuperOverlay(file, {libraryLoader}), {code});
  }
});

it("cancels between tiles and closes the actual reader without returning a partial archive", async () => {
  const {file} = source(), controller = new AbortController(); let closed = 0;
  await assert.rejects(exportRasterSuperOverlay(file, {signal: controller.signal,
    libraryLoader: async () => ({fromCustomClient: async (...args) => {
      const tiff = await fromCustomClient(...args), close = tiff.close.bind(tiff);
      tiff.close = async () => {closed++; await close();}; return tiff;
    }}), onProgress: s => {if (s.startsWith("Preparing")) controller.abort();}}), {name: "AbortError"});
  assert.equal(closed, 1);
});

it("connects a deliberate file export and cancellation to the visible controls", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document; const downloads = [];
  try {
    const selected = {name: "survey.tif"}; let calls = 0;
    const view = RasterSuperOverlayExport({download: (...args) => downloads.push(args), exporter: async (file, options) => {
      assert.equal(file, selected); assert.equal(options.attribution, "Credits"); options.assertCurrent(); calls++;
      return {bytes: new Uint8Array([1, 2]), report: {tiles: [{}]}};
    }});
    document.body.append(view); const input = view.querySelector("input"), run = view.querySelector("button");
    assert.equal(run.disabled, true); Object.defineProperty(input, "files", {value: [selected]});
    input.dispatchEvent(new dom.window.Event("change")); view.querySelector("textarea").value = "Credits";
    run.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1); assert.equal(downloads.length, 1); assert.equal(downloads[0][0], "survey-overlay.kmz");
    assert.match(view.querySelector('[role="status"]').textContent, /Downloaded 1 raster tiles/);
    const pending = RasterSuperOverlayExport({download: () => assert.fail("Cancelled exports cannot download"), exporter: async (file, options) => {
      await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {once: true}));
    }});
    document.body.append(pending); const f = pending.querySelector("input");
    Object.defineProperty(f, "files", {value: [selected]}); f.dispatchEvent(new dom.window.Event("change"));
    const [start, cancel] = pending.querySelectorAll("button"); start.click(); cancel.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(pending.querySelector('[role="status"]').textContent, /cancelled/); assert.equal(f.disabled, false);
  } finally {globalThis.document = previous; dom.window.close();}
});
