import assert from "node:assert/strict";
import {test} from "node:test";
import {inspectStaticMapLayers, staticMapDocument} from "../src/lib/staticMapExport.js";
import {openStaticMapExport} from "../src/components/StaticMapExport.js";
import {JSDOM} from "jsdom";

const input = {
  style: {sources: {points: {type: "geojson", data: {type: "FeatureCollection", features: []}}, tiles: {type: "raster", tiles: ["https://tiles.example.org/{z}/{x}/{y}.png"]}},
    layers: [{id: "points", type: "circle", source: "points"}, {id: "tiles", type: "raster", source: "tiles"}]},
  layers: [{layerId: "points", title: "Sites"}, {layerId: "tiles", title: "Imagery"}],
  handles: new Map(["points", "tiles"].map(id => [id, {sourceId: id, layerIds: [id]}]))
};
const runtime = {runtimeJs: "window.viewerLoaded=true;", runtimeCss: "body{margin:0}", runtimeLicense: "BSD"};
test("portable runtime is inline without executable data URLs or raw script terminators", () => {
  const html = staticMapDocument({...runtime, runtimeJs: 'window.label="</SCRIPT><script>alert(1)</script>";',
    title: "Map", candidates: inspectStaticMapLayers(input), selectedIds: ["points"]});
  assert.doesNotMatch(html, /data:text\/javascript|<\/SCRIPT><script>/);
  assert.match(html, /<\\\/script>/i);
  assert.match(html, /script-src &#39;unsafe-inline&#39;;/);
});
test("offline editions reject network layers instead of substituting archives", () => {
  const candidates = inspectStaticMapLayers(input);
  assert.equal(candidates[0].reason, null);
  assert.match(candidates[1].reason, /Requires network/);
  assert.throws(() => staticMapDocument({...runtime, candidates, selectedIds: ["tiles"]}), /Select supported/);
  const html = staticMapDocument({...runtime, title: "Map </script><script>alert(1)</script>", view: {center: [0, 0], zoom: 1}, candidates, selectedIds: ["points"]});
  assert.match(html, /connect-src blob: ;/);
  assert.doesNotMatch(html, /https:\/\/tiles|<script>alert/);
  assert.match(html, /\\u003c\/script>/);
});
test("live editions include only explicitly selected public source origins", () => {
  const candidates = inspectStaticMapLayers({...input, mode: "live"});
  assert.equal(candidates[1].reason, null);
  const html = staticMapDocument({...runtime, title: "Map", view: {}, candidates, selectedIds: ["tiles"], mode: "live"});
  assert.match(html, /connect-src blob: https:\/\/tiles.example.org/);
  assert.match(html, /credentials:'omit'/);
  for (const url of ["https://tiles.example.org/{z}?token=secret", "https://user:pass@tiles.example.org/tile", "https://studio.opengeo.tools/data", "https://127.0.0.1/tiles", "https://tiles.example.org/api/map", "blob:private"]) {
    const unsafe = structuredClone(input); unsafe.style.sources.tiles.tiles = [url];
    assert.ok(inspectStaticMapLayers({...unsafe, mode: "live"})[1].reason, url);
  }
});
test("unsupported symbols, image patterns and missing sources are reported before export", () => {
  const unsupported = structuredClone(input);
  unsupported.style.layers[0].type = "symbol";
  assert.match(inspectStaticMapLayers(unsupported)[0].reason, /label assets/);
  unsupported.style.layers[0] = {id: "points", type: "fill", source: "points", paint: {"fill-pattern": "photo"}};
  assert.match(inspectStaticMapLayers(unsupported)[0].reason, /Pattern/);
  delete unsupported.style.sources.tiles;
  assert.match(inspectStaticMapLayers(unsupported)[1].reason, /not loaded/);
});
test("text labels do not block supported geometry export or change the working map", () => {
  const labelled = structuredClone(input);
  labelled.style.layers.push({id: "point-labels", type: "symbol", source: "points", layout: {"text-field": ["get", "name"]}});
  labelled.handles.get("points").layerIds.push("point-labels");
  const before = structuredClone(labelled);
  const candidates = inspectStaticMapLayers({...labelled, includeLabels: false});
  assert.equal(candidates[0].reason, null);
  assert.equal(candidates[0].omittedLabelCount, 1);
  assert.deepEqual(candidates[0].paints.map(item => item.type), ["circle"]);
  const html = staticMapDocument({...runtime, title: "Labelled map", candidates, selectedIds: ["points"]});
  assert.doesNotMatch(html, /point-labels/);
  assert.deepEqual(labelled, before);
  labelled.style.layers.at(-1).layout["icon-image"] = "roof";
  assert.match(inspectStaticMapLayers(labelled)[0].reason, /viewer features/);
});
test("portable text labels retain expressions and paint without glyph or sprite servers", () => {
  const labelled = structuredClone(input);
  labelled.style.layers.push({id: "point-labels", type: "symbol", source: "points", layout: {"text-field": ["get", "name"], "text-font": ["sans-serif"]}, paint: {"text-color": "#123456"}});
  labelled.handles.get("points").layerIds.push("point-labels");
  const before = structuredClone(labelled);
  const candidates = inspectStaticMapLayers(labelled);
  assert.equal(candidates[0].reason, null);
  assert.equal(candidates[0].omittedLabelCount, 0);
  const html = staticMapDocument({...runtime, title: "Labels", candidates, selectedIds: ["points"]});
  assert.match(html, /point-labels/);
  assert.match(html, /labels use local fonts/);
  assert.doesNotMatch(html, /"glyphs"|"sprite"/);
  assert.deepEqual(labelled, before);
  labelled.style.layers.at(-1).layout["text-field"] = ["format", ["image", "roof"], {}];
  assert.match(inspectStaticMapLayers(labelled)[0].reason, /viewer features/);
});
test("workbench export requires layer review and loads only the credential-free runtime", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), oldDocument = globalThis.document, oldFetch = globalThis.fetch;
  const requests = [], downloads = [];
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  globalThis.fetch = async (url, options) => {requests.push({url, options}); return {ok: true, text: async () => "/* bundled runtime */"};};
  try {
    const dialog = openStaticMapExport({map: {getStyle: () => input.style, getCenter: () => ({lng: 0, lat: 0}), getZoom: () => 2, getPitch: () => 0, getBearing: () => 0}, layers: input.layers, handles: input.handles, title: "Survey map", download: html => downloads.push(html)});
    const button = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Download HTML");
    assert.equal(button.disabled, true); assert.equal(requests.length, 0);
    assert.equal(dialog.querySelectorAll("fieldset input:disabled").length, 1);
    const consent = [...dialog.querySelectorAll('input[type="checkbox"]')].at(-1);
    consent.click(); assert.equal(button.disabled, false);
    await button.onclick();
    assert.equal(downloads.length, 1); assert.equal(requests.length, 3);
    assert.ok(requests.every(({url, options}) => url.startsWith("/export-runtime/") && options.credentials === "omit"));
    assert.match(dialog.textContent, /Downloaded/);
  } finally {globalThis.document = oldDocument; globalThis.fetch = oldFetch; dom.window.close();}
});

test("direct publication insertion requires the same layer consent and never downloads", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.dispatchEvent(new dom.window.Event("close"));};
  globalThis.fetch = async () => ({ok: true, text: async () => "/* local runtime */"});
  const inserted = [];
  try {
    const dialog = openStaticMapExport({map: {getStyle: () => input.style, getCenter: () => ({lng: 0, lat: 0}), getZoom: () => 2, getPitch: () => 0, getBearing: () => 0},
      layers: input.layers, handles: input.handles, title: "Water", download: () => {throw Error("unexpected download");},
      onInsert: (...args) => inserted.push(args)});
    const insert = [...dialog.querySelectorAll("button")].find(item => item.textContent === "Insert in publication");
    await insert.onclick(); assert.equal(inserted.length, 0);
    [...dialog.querySelectorAll('input[type="checkbox"]')].at(-1).click();
    await insert.onclick();
    assert.equal(inserted.length, 1); assert.equal(inserted[0][1], "Water");
    assert.match(inserted[0][0], /Offline edition/);
    assert.equal(dialog.isConnected, false);
  } finally {globalThis.document = previousDocument; globalThis.fetch = previousFetch; dom.window.close();}
});

test("export refuses stale Project filters and retains matching rendered predicates", () => {
  const value = structuredClone(input);
  value.layers[0].filter = ["==", ["get", "status"], "reviewed"];
  assert.match(inspectStaticMapLayers(value)[0].reason, /Displayed filtering differs/);
  value.style.layers[0].filter = value.layers[0].filter;
  assert.equal(inspectStaticMapLayers(value)[0].reason, null);
  const base = ["==", ["geometry-type"], "Point"];
  value.handles.get("points").baseFilters = {points: base};
  assert.match(inspectStaticMapLayers(value)[0].reason, /Displayed filtering differs/);
  value.style.layers[0].filter = ["all", base, value.layers[0].filter];
  const candidates = inspectStaticMapLayers(value);
  assert.equal(candidates[0].reason, null);
  const html = staticMapDocument({...runtime, title:"Filtered", candidates, selectedIds:["points"]});
  assert.ok(html.includes(JSON.stringify(value.style.layers[0].filter)));
});

test('portable patterns embed bounded pixels only after pinned paint and image checks', async () => {
  const value=structuredClone(input), id='d0000000-0000-4000-8000-000000000002';
  const reference={projectId:id,resourceId:id,styleId:id,versionNumber:1,format:'sld_1_1',checksumSha256:'a'.repeat(64)};
  value.layers[0].styleReference=reference;
  value.layers[0].opacity=1;
  const part={id:'pattern',type:'fill',paint:{'fill-pattern':'tile','fill-opacity':1}};
  const pixels={width:64,height:64,data:new Uint8Array(16384).fill(128)};
  value.handles.get('points').boundStyle={reference,pattern:{id:'waves'},parts:[part],images:[{id:'tile',pixels,pixelRatio:2}]};
  value.handles.get('points').layerIds=['points-style-0'];
  value.style.layers[0]={...part,id:'points-style-0',source:'points'};
  const candidates=inspectStaticMapLayers(value);
  assert.equal(candidates[0].reason,null);
  const html=staticMapDocument({...runtime,title:'Water',candidates,selectedIds:['points']});
  assert.match(html,/new Uint8Array\(image.data\)/);
  assert.match(html,/"pixelRatio":2/);
  assert.doesNotMatch(html,/data:image|<svg/);
  const {compilePortableMapArtifact,verifyPortableMapArtifact}=await import('../src/lib/portableMapArtifact.js');
  const artifact=await compilePortableMapArtifact({...runtime,title:'Water',candidates,selectedIds:['points']});
  await verifyPortableMapArtifact(new Blob([artifact.html]),artifact.manifest);
  assert.deepEqual(artifact.manifest.styleDependencies[0].reference,reference);
  await assert.rejects(verifyPortableMapArtifact(new Blob([artifact.html.replace('pixelRatio','pixelRatiX')]),artifact.manifest),/checksum/);
  value.handles.get('points').boundStyle.images[0].pixels.width=4096;
  assert.match(inspectStaticMapLayers(value)[0].reason,/image.*invalid/);
  value.handles.get('points').boundStyle.images[0].pixels.width=64;
  value.style.layers[0].paint={...part.paint,'fill-opacity':0.1};
  assert.match(inspectStaticMapLayers(value)[0].reason,/Displayed styling differs/);
});
