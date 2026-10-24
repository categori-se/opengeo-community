import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {unzipSync, strFromU8} from "fflate";
import {nativeProjectViewRuntime} from "../scripts/build-maplibre-render-bundle.mjs";
import {pointSymbolImageId, pointSymbolImages, pointSymbolStyleParts, ensurePointSymbolAssets} from "../src/lib/pointSymbols.js";
import {referencedStylePaint} from "../src/lib/layerStyleReference.js";
import {compileStaticMapDocument, inspectStaticMapLayers} from "../src/lib/staticMapExport.js";
import {compilePortableMapArtifact} from "../src/lib/portableMapArtifact.js";
import {compileDeveloperMapBundle} from "../src/lib/developerMapBundle.js";
import {capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout} from "../src/lib/printLayouts.js";

const runtime = {runtimeJs: "window.maplibregl={};", runtimeCss: "body{}", runtimeLicense: "BSD-3-Clause"};
const uuid = "10000000-0000-4000-8000-000000000176";
function fixture(style = {}, id = "health") {
  const layer = {layerId: id, datasetId: uuid, datasetVersionId: uuid, sourceVersion: 1,
    title: "Hospitals and clinics", sourceType: "governed-dataset", geometryType: "Point", visible: true,
    opacity: .4, labels: {}, style: {renderer: "single", pointSymbol: "hospital", circleColor: "#db2777", circleRadius: 8, ...style}};
  const source = `source-${id}`;
  const circle = {id: `${id}-points`, source, type: "circle", layout: {visibility: "visible"},
    paint: {"circle-color": layer.style.circleColor, "circle-radius": layer.style.circleRadius,
      "circle-opacity": layer.opacity, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.25}};
  const parts = pointSymbolStyleParts(layer).map(part => ({...part, id: `${id}-${part.id}`, source,
    layout: {...part.layout, visibility: "visible"}, paint: {...part.paint, "icon-opacity": layer.opacity}}));
  return {layers: [layer], style: {version: 8, sources: {[source]: {type: "geojson", token: "private-token",
    data: {type: "FeatureCollection", features: [{type: "Feature", id: "hospital", properties: {kind: "Hospital"},
      geometry: {type: "Point", coordinates: [85, 27]}}]}}}, layers: [circle, ...parts]},
  handles: new Map([[id, {sourceId: source, layerIds: [circle.id, ...parts.map(part => part.id)]}]])};
}
function compile(value) {
  const candidates = inspectStaticMapLayers(value);
  return {candidates, ...compileStaticMapDocument({...runtime, title: "Care facilities", candidates,
    selectedIds: value.layers.map(layer => layer.layerId)})};
}

test("known Point glyphs retain exact packaged pixels, size, opacity and credential-free data", async () => {
  await ensurePointSymbolAssets({pointSymbol: "maki-8-2-0-hospital"});
  for (const symbol of ["hospital", "clinic", "school", "star", "flag", "maki-8-2-0-hospital",
    "osm-carto-1cc4b89c-amenity--hospital", "osm-carto-1cc4b89c-shields--motorway_10x1"]) {
    const value = fixture({pointSymbol: symbol}), before = structuredClone(value);
    const {candidates, payload, html} = compile(value);
    assert.equal(candidates[0].reason, null);
    assert.deepEqual(payload.images, pointSymbolImages(value.layers[0].style).map(image => ({id: image.id,
      width: 64, height: 64, data: [...image.pixels.data], pixelRatio: 2})));
    const part = payload.style.layers.find(part => part.type === "symbol");
    assert.equal(part.layout["icon-image"], pointSymbolImageId(symbol));
    assert.equal(part.layout["icon-size"], .5);assert.equal(part.paint["icon-opacity"], .4);
    assert.match(html, /map.addImage\(image.id/);
    assert.ok(html.indexOf("map.addImage(image.id") < html.indexOf("map.addLayer(layer)"));
    assert.doesNotMatch(html, /private-token|"sprite"|"glyphs"|https:\/\//);
    assert.deepEqual(value, before);
  }
});

test("category glyphs package precisely their known images and transparent fallback", () => {
  const value = fixture({renderer: "category", categoryField: "kind", pointSymbol: "circle",
    categorySymbols: {Hospital: "hospital", Clinic: "clinic"}});
  const {payload} = compile(value);
  assert.deepEqual(payload.images.map(image => image.id).sort(), ["circle", "clinic", "hospital"].map(pointSymbolImageId).sort());
  assert.deepEqual(payload.style.layers.find(part => part.type === "symbol").layout["icon-image"],
    ["match", ["to-string", ["get", "kind"]], "Hospital", pointSymbolImageId("hospital"), "Clinic", pointSymbolImageId("clinic"), pointSymbolImageId("circle")]);
  assert.ok(payload.images.find(image => image.id === pointSymbolImageId("circle")).data.every(value => value === 0));
});

test("shared built-in images deduplicate across Layers but conflicting bytes fail", () => {
  const value = fixture(), other = fixture({}, "other");
  value.layers.push(...other.layers);Object.assign(value.style.sources, other.style.sources);
  value.style.layers.push(...other.style.layers);value.handles.set("other", other.handles.get("other"));
  const {candidates, payload} = compile(value);
  assert.equal(payload.images.length, 1);
  assert.equal(payload.style.layers.filter(part => part.type === "symbol").length, 2);
  candidates[1].images[0].data[0] ^= 1;
  assert.throws(() => compileStaticMapDocument({...runtime, candidates, selectedIds: ["health", "other"]}), /image identities conflict/);
});

test("unknown assets, mixed text icons and stale icon layout or opacity remain unexportable", () => {
  for (const mutate of [
    part => {part.layout["icon-image"] = "https://unbound.example/private.png?token=secret";},
    part => {part.layout["icon-image"] = ["get", "image_url"];},
    part => {part.layout["text-field"] = "unbound text";},
    part => {part.layout["icon-size"] = 2;},
    part => {part.paint["icon-opacity"] = .8;}
  ]) {
    const value = fixture();mutate(value.style.layers.at(-1));
    const candidates = inspectStaticMapLayers(value);
    assert.match(candidates[0].reason, /Displayed point symbols differ/);
    assert.throws(() => compileStaticMapDocument({...runtime, candidates, selectedIds: ["health"]}), /Select supported/);
  }
});

test("pinned Point Styles retain symbol layout and multiply icon opacity correctly", () => {
  const value = fixture(), layer = value.layers[0], source = value.handles.get("health").sourceId;
  const rawStyle = structuredClone(layer.style);
  const reference = {projectId: uuid, resourceId: uuid, styleId: uuid, versionNumber: 1,
    checksumSha256: "a".repeat(64), format: "maplibre"};
  const circle = {...value.style.layers[0], id: "points", paint: {...value.style.layers[0].paint, "circle-opacity": 1}};
  delete circle.source;delete circle.layout;
  const boundStyle = {reference, pointSymbolStyle: rawStyle, parts: [circle, ...pointSymbolStyleParts(layer)], images: pointSymbolImages(rawStyle)};
  layer.styleReference = reference;layer.style.pointSymbol = "clinic";
  const parts = referencedStylePaint(boundStyle, layer);
  value.style.layers = parts.map(part => ({...part, source, layout: {...part.layout, visibility: "visible"}}));
  Object.assign(value.handles.get("health"), {boundStyle, layerIds: parts.map(part => part.id)});
  const {payload} = compile(value);
  assert.deepEqual(payload.images.map(image => image.id), [pointSymbolImageId("hospital")]);
  assert.equal(payload.style.layers.find(part => part.type === "symbol").paint["icon-opacity"], .4);
  assert.ok(parts.every(part => !Object.hasOwn(part.paint, "symbol-opacity")));
  value.style.layers.at(-1).layout["icon-ignore-placement"] = false;
  assert.match(inspectStaticMapLayers(value)[0].reason, /Displayed styling differs|Displayed point symbols differ/);
});

test("developer ZIP and local print retain the same Point representation and captured bytes", async () => {
  const value = fixture(), candidates = inspectStaticMapLayers(value), selectedIds = ["health"];
  const compiled = await compilePortableMapArtifact({...runtime, title: "Care facilities", candidates, selectedIds});
  const bundle = await compileDeveloperMapBundle({compiled, candidates, selectedIds, ...runtime,
    nativeRuntime: await nativeProjectViewRuntime()});
  const files = unzipSync(new Uint8Array(await bundle.blob.arrayBuffer()));
  const module = strFromU8(files["map.mjs"]), payload = JSON.parse(module.match(/const publication=(.*);\n/)[1]);
  assert.deepEqual(payload.images, compiled.payload.images);
  assert.deepEqual(payload.style.layers, compiled.payload.style.layers);
  assert.match(module, /new Uint8Array\(image.data\)/);assert.doesNotMatch(module, /private-token/);
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const png = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10]).toString("base64")}`;
    let render;
    const canvas = {width: 64, height: 64, clientWidth: 64, clientHeight: 64, toDataURL: type => {assert.equal(type, "image/png");return png;}};
    const map = {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
      getCanvas: () => canvas, once: (type, callback) => {assert.equal(type, "render");render = callback;},
      triggerRepaint: () => queueMicrotask(render), getStyle: () => value.style, getCenter: () => ({lng: 85, lat: 27}),
      getZoom: () => 4, getPitch: () => 0, getBearing: () => 0, getProjection: () => ({type: "globe"})};
    const record = {id: uuid, version: 3, name: "Care facilities", definition: {layers: value.layers}};
    const capture = await capturePrintMap({map, renderer: "maplibre", ready: true, layers: value.layers, handles: value.handles}, record);
    assert.equal(capture.dataUrl, png);assert.deepEqual(capture.presentation[0].style, value.layers[0].style);
    const layout = newProjectPrintLayout(record, "care");
    Object.assign(layout, {northArrow: false, scaleBar: false, graticule: false, legend: false});
    const page = printPageSvg(layout, new Map([["care:main", capture]]), "care");
    assert.equal(page.querySelector("image").getAttribute("href"), png);
    assert.deepEqual(layout.frames[0].presentation[0].style, value.layers[0].style);
  } finally {globalThis.document = previous;dom.window.close();}
});

test("enabled point clustering is rejected visibly for live and offline HTML export", () => {
  const value = fixture();
  value.layers[0].pointClustering = {enabled: true, radius: 44, maxZoom: 12};
  for (const mode of ["live", "offline"]) {
    const candidates = inspectStaticMapLayers({...value, mode});
    assert.match(candidates[0].reason, /Point clustering.*not supported.*Print Studio/);
    assert.throws(() => compileStaticMapDocument({...runtime, candidates, mode, selectedIds: ["health"]}), /Select supported/);
  }
  value.layers[0].pointClustering.enabled = false;
  assert.equal(inspectStaticMapLayers(value)[0].reason, null);
});
