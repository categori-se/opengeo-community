import assert from "node:assert/strict";
import {afterEach, beforeEach, test} from "node:test";
import {JSDOM} from "jsdom";
import {printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {capturePrintVectorScene} from "../src/lib/printVectorScene.js";
import {newProjectPrintLayout, printLayerPresentation} from "../src/lib/printLayouts.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";

let dom, previous;
beforeEach(() => {dom = new JSDOM("<!doctype html><body></body>");previous = globalThis.document;globalThis.document = dom.window.document;});
afterEach(() => {globalThis.document = previous;dom.window.close();});
function fixture() {
  const layer = {layerId: "areas", datasetId: "data", datasetVersionId: "version", sourceVersion: 3,
    title: "Survey areas", visible: true, opacity: 0.5, opacityMode: "composite", style: {}, labels: {}};
  const geojson = {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [
    [[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [1, 1]]]}}]};
  const style = {version: 8, sources: {data: {type: "geojson", data: geojson}}, layers: [
    {id: "background", type: "background", paint: {"background-color": "white"}},
    {id: "fill", source: "data", type: "fill", paint: {"fill-color": "#2563eb", "fill-opacity": 0.7, "fill-layer-opacity": 0.5}},
    {id: "line", source: "data", type: "line", paint: {"line-color": "#17212b", "line-width": 2}}
  ]};
  const map = {getStyle: () => style, loaded: () => true, style: {hasTransitions: () => false}, getLayersOrder: () => style.layers.map(item => item.id),
    getCanvas: () => ({clientWidth: 400, clientHeight: 200}), getCenter: () => ({lng: 0, lat: 0}),
    getZoom: () => 6, getPitch: () => 0, getBearing: () => 0, getProjection: () => ({type: "mercator"}),
    isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    project: ([x, y]) => ({x: 200 + x * 20, y: 100 - y * 20}), unproject: ([x, y]) => ({lng: x / 20 - 10, lat: 5 - y / 20})};
  const record = {id: "map", name: "Survey map", version: 4, definition: {layers: [layer], mapViews: [{center: [0, 0], zoom: 6, pitch: 0, bearing: 0}]}};
  const context = {map, project: record.definition, renderer: "maplibre", ready: true, layers: [layer],
    handles: new Map([[layer.layerId, {sourceId: "data", layerIds: ["fill", "line"]}]]),
    getPrintDataSource: () => ({id: layer.layerId, geojson, inputPin: {layerId: layer.layerId, datasetId: "data", datasetVersionId: "version", sourceVersion: 3}})};
  const layout = newProjectPrintLayout(record, "layout");layout.northArrow = false;layout.scaleBar = false;
  const view = structuredClone(layout.frames[0].view), presentation = [printLayerPresentation(layer)];
  const capture = {width: 800, height: 400, cssWidth: 400, cssHeight: 200, view, presentation, signature: canonicalJson({view, presentation}),
    dataUrl: "data:image/png;base64,aW1hZ2U=", imageSha256: "a".repeat(64), legend: [], attribution: ["Survey provider"],
    sourceMetadata: [{title: "Survey areas", license: "CC BY 4.0"}], flat: true, lines: [], projectId: record.id, projectVersion: record.version,
    vectorScene: capturePrintVectorScene(context, record)};
  return {layout, capture, captures: new Map([["layout:main", capture]])};
}

test("vector paper uses clipped real geometry with holes, pass order, independent composite opacity and retained rights", () => {
  const {layout, captures} = fixture(), before = JSON.stringify({layout, captures: [...captures]});
  const raster = printPageSvg(layout, captures, layout.id), page = printPageSvg(layout, captures, layout.id, {mapRepresentation: "vector"});
  assert.equal(raster.querySelectorAll("image").length, 1);assert.equal(page.querySelectorAll("image").length, 0);
  const group = page.querySelector("[data-print-vector-map]");
  assert.equal(group.getAttribute("transform"), "translate(10 49.75) scale(0.5375 0.5375)");
  assert.equal(group.parentElement.getAttribute("clip-path"), "url(#print-map-0)");
  assert.deepEqual([...group.children].map(item => item.getAttribute("data-print-vector-pass")), ["background", "fill", "line"]);
  const fill = group.querySelector('[data-print-vector-pass="fill"]');
  assert.equal(fill.getAttribute("opacity"), "0.5");assert.equal(fill.firstChild.getAttribute("fill-opacity"), "0.7");
  assert.equal(fill.firstChild.getAttribute("fill-rule"), "evenodd");assert.equal((fill.firstChild.getAttribute("d").match(/M/g) ?? []).length, 2);
  assert.equal(fill.firstChild.getAttribute("stroke"), "none");
  const line = group.querySelector('[data-print-vector-pass="line"] path');
  assert.equal(line.getAttribute("fill"), "none");assert.equal(line.getAttribute("stroke-width"), "2");
  assert.ok((line.getAttribute("d").match(/L/g) ?? []).length >= 3, "closed line interiors remain unfilled");
  const metadata = JSON.parse(page.querySelector("metadata").textContent);
  assert.equal(metadata.mapRepresentation, "vector");assert.equal(metadata.geographicRegistration, false);
  assert.equal(metadata.captures[0].vectorMap.sourcePins[0].sourceVersion, 3);
  assert.match(page.textContent, /Survey provider/);assert.match(page.textContent, /CC BY 4.0/);
  assert.equal(JSON.stringify({layout, captures: [...captures]}), before);
});

test("unsupported, tampered and stale vector scenes fail before output rather than falling back to captured pixels", () => {
  for (const change of [capture => {delete capture.vectorScene;capture.vectorUnavailable = "Hide unsupported imagery or choose raster output.";},
    capture => {capture.vectorScene.passes[1].commands[0].fillOpacity = 0.1;},
    capture => {capture.vectorScene.signature = "old";}]) {
    const {layout, captures, capture} = fixture();change(capture);
    assert.throws(() => printPageSvg(layout, captures, layout.id, {mapRepresentation: "vector"}), /Vector|vector/);
    assert.equal(printPageSvg(layout, captures, layout.id).querySelectorAll("image").length, 1);
  }
});

test("point legends remain owned vector shapes with their opacity in vector output", () => {
  const {layout, captures, capture} = fixture();
  capture.legend = [{label: "Survey marker", color: "#2563eb", opacity: 0.7,
    pointStyle: {pointSymbol: "hospital", circleColor: "#2563eb", circleRadius: 8}}];
  const raster = printPageSvg(layout, captures, layout.id), vector = printPageSvg(layout, captures, layout.id, {mapRepresentation: "vector"});
  assert.equal(raster.querySelectorAll('image[data-point-symbol="hospital"]').length, 1);
  assert.equal(vector.querySelectorAll("image").length, 0);
  const glyph = vector.querySelector('[data-print-point-legend="hospital"]');
  assert.equal(glyph.getAttribute("opacity"), "0.7");assert.match(glyph.getAttribute("transform"), /^translate\(.+\) scale\(/);
  assert.equal(glyph.querySelector("circle").getAttribute("fill"), "#2563eb");assert.ok(glyph.querySelectorAll("rect").length > 0);
  assert.match(vector.textContent, /Survey marker/);
});
