import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {unzipSync, strFromU8} from "fflate";
import {JSDOM} from "jsdom";
import {nativeProjectViewRuntime} from "../scripts/build-maplibre-render-bundle.mjs";
import {compilePortableMapArtifact} from "../src/lib/portableMapArtifact.js";
import {inspectStaticMapLayers} from "../src/lib/staticMapExport.js";
import {compileDeveloperMapBundle} from "../src/lib/developerMapBundle.js";
import {openStaticMapExport} from "../src/components/StaticMapExport.js";

const runtime = {runtimeJs: "window.maplibregl={};", runtimeCss: "body{margin:0}", runtimeLicense: "BSD-3-Clause"};
const fixture = () => ({style: {version: 8, sources: {
  sites: {type: "geojson", token: "private-source-credential", attribution: "Recorded source", data: {type: "FeatureCollection", features: [
    {type: "Feature", properties: {name: "測定点", status: "reviewed"}, geometry: {type: "Point", coordinates: [0, 0]}}
  ]}}, tiles: {type: "raster", tiles: ["https://tiles.example.org/{z}/{x}/{y}.png"]}
}, layers: [{id: "sites", type: "circle", source: "sites"}, {id: "tiles", type: "raster", source: "tiles"}]},
layers: [{layerId: "sites", title: "Sites", sourceType: "upload", license: "CC0-1.0", curatedAttribution: "Curated source",
  sourceConfiguration: {authorization: "private-config-credential"}}, {layerId: "tiles", title: "Imagery"}],
handles: new Map(["sites", "tiles"].map(id => [id, {sourceId: id, layerIds: [id]}]))});
async function pack(mode = "offline", selectedIds = ["sites"]) {
  const candidates = inspectStaticMapLayers({...fixture(), mode});
  const compiled = await compilePortableMapArtifact({...runtime, title: "Field survey · 地図", candidates, selectedIds, mode});
  const options = {compiled, candidates, selectedIds, ...runtime, nativeRuntime: await nativeProjectViewRuntime()};
  const result = await compileDeveloperMapBundle(options);
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  return {options, result, files};
}

test("developer ZIP binds all assets and reuses the exact API native module", async () => {
  const {options, result, files} = await pack();
  for (const entry of result.manifest.files) {
    assert.equal(files[entry.path].byteLength, entry.bytes);
    assert.equal(createHash("sha256").update(files[entry.path]).digest("hex"), entry.checksumSha256);
  }
  assert.deepEqual(JSON.parse(strFromU8(files["manifest.json"])), result.manifest);
  const module = strFromU8(files["map.mjs"]);
  const metadata = JSON.parse(module.match(/export const artifact=Object.freeze\((.*)\);/)[1]);
  assert.ok(module.endsWith(options.nativeRuntime));
  assert.equal(metadata.sources[0].license, "CC0-1.0");
  assert.doesNotMatch(module, /iframe\.src|createElement\(["']iframe/);
  assert.match(module, /setFilter|selectionchange|dispose/);
  assert.match(strFromU8(files["observable.md"]), /invalidation|artifact.sources/);
});

test("bundle distinguishes included, live and excluded data and preserves rights separately", async () => {
  const offline = await pack();
  assert.equal(offline.result.manifest.fullyOffline, true);
  assert.equal(offline.result.manifest.dependencies.included[0].coverage, "loaded-feature-snapshot");
  assert.equal(offline.result.manifest.dependencies.live.length, 0);
  assert.ok(offline.result.manifest.dependencies.excluded.some(item => item.layerId === "tiles"));
  const source = JSON.parse(strFromU8(offline.files["source-metadata.json"])).sources[0];
  assert.equal(source.license, "CC0-1.0");assert.equal(source.attribution, "Curated source");
  assert.equal(source.sourceAttribution, "Recorded source");assert.equal(source.curatedAttribution, "Curated source");
  const all = Object.values(offline.files).map(strFromU8).join("\n");
  assert.doesNotMatch(all, /private-source-credential|private-config-credential/);
  assert.equal(JSON.parse(strFromU8(offline.files["artifact.json"])).rights.license, null);
  const live = await pack("live", ["sites", "tiles"]);
  assert.equal(live.result.manifest.fullyOffline, false);
  assert.deepEqual(live.result.manifest.dependencies.live[0].accessUrls, ["https://tiles.example.org/{z}/{x}/{y}.png"]);
});

test("developer packaging rejects altered reviewed bytes, payload, runtime and missing viewer", async () => {
  const {options} = await pack();
  await assert.rejects(compileDeveloperMapBundle({...options, nativeRuntime: "unreviewed"}), /native map viewer/);
  await assert.rejects(compileDeveloperMapBundle({...options, runtimeJs: "different runtime"}), /differs from/);
  const altered = {...options.compiled, payload: structuredClone(options.compiled.payload)};altered.payload.view.zoom = 14;
  await assert.rejects(compileDeveloperMapBundle({...options, compiled: altered}), /differs from/);
  await assert.rejects(compileDeveloperMapBundle({...options, compiled: {...options.compiled, html: options.compiled.html + "!"}}), /identity|checksum/);
  const extra = Array.from({length: 100}, (_, i) => ({id: `excluded-${i}`, title: "Long source metadata ".repeat(60)}));
  await assert.rejects(compileDeveloperMapBundle({...options, candidates: [...options.candidates, ...extra]}), /manifest exceeds/);
});

test("developer download uses the same deliberate layer review and performs no eager request", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.dispatchEvent(new dom.window.Event("close"));};
  const requests = [], downloads = [], body = {"maplibre-gl.js": runtime.runtimeJs, "maplibre-gl.css": runtime.runtimeCss, "LICENSE.txt": runtime.runtimeLicense, "native-map-view.txt": await nativeProjectViewRuntime()};
  globalThis.fetch = async (url, options) => {requests.push({url, options});return {ok: true, text: async () => body[url.split("/").at(-1)]};};
  try {
    const value = fixture();
    const dialog = openStaticMapExport({...value, map: {getStyle: () => value.style, getCenter: () => ({lng: 0, lat: 0}), getZoom: () => 3, getPitch: () => 0, getBearing: () => 0},
      title: "Field survey", download: () => assert.fail("HTML download"), downloadBundle: blob => downloads.push(blob)});
    const format = dialog.querySelector("select");format.value = "developer";format.dispatchEvent(new dom.window.Event("change"));
    const button = [...dialog.querySelectorAll("button")].find(item => item.textContent === "Download developer ZIP");
    assert.equal(requests.length, 0);await button.onclick();assert.equal(downloads.length, 0);
    [...dialog.querySelectorAll('input[type="checkbox"]')].at(-1).click();await button.onclick();
    assert.equal(downloads.length, 1);assert.equal(requests.length, 4);
    assert.ok(requests.every(item => item.options.credentials === "omit"));
    assert.equal(downloads[0].type, "application/zip");
    assert.match(dialog.textContent, /Downloaded developer bundle/);
  } finally {Object.assign(globalThis, previous);dom.window.close();}
});
