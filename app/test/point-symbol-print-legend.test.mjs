import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout} from "../src/lib/printLayouts.js";
import {pointSymbolPreviewSvg} from "../src/lib/pointSymbols.js";

const png = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10]).toString("base64")}`;
function fixture({pointSymbol = "hospital", renderer = "single", categorySymbols, circleRadius = 8} = {}) {
  const layer = {layerId: "health", datasetId: "health", geometryType: "Point", visible: true, opacity: .7,
    title: "Care facilities", attribution: "Clinic survey", labels: {},
    style: {pointSymbol, circleColor: "#dc2626", circleRadius, renderer,
      ...(categorySymbols ? {categoryField: "kind", categorySymbols} : {})}};
  const circle = {id: "health-points", type: "circle", paint: {"circle-color": "#dc2626"}};
  let render;
  const map = {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    getCanvas: () => ({width: 80, height: 60, toDataURL: () => png}),
    once: (_, callback) => {render = callback;}, triggerRepaint: () => queueMicrotask(render),
    getCenter: () => ({lng: 85, lat: 27}), getZoom: () => 4, getPitch: () => 0, getBearing: () => 0,
    getProjection: () => ({type: "globe"}), getStyle: () => ({layers: [circle]})};
  const handle = {layerIds: [circle.id]}, handles = new Map([[layer.layerId, handle]]);
  const record = {id: "map", version: 2, name: "Care facilities", definition: {layers: [layer]}};
  return {layer, circle, handle, record, context: {map, layers: [layer], handles, renderer: "maplibre", ready: true}};
}
async function withPage(action) {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {await action();} finally {globalThis.document = previous;dom.window.close();}
}
function pageFor(value, capture) {
  const layout = newProjectPrintLayout(value.record, "layout");
  Object.assign(layout, {northArrow: false, scaleBar: false, graticule: false});
  return printPageSvg(layout, new Map([["layout:main", capture]]), "layout");
}

test("captured legends retain the actual known Point glyph, color, radius and attribution", async () => withPage(async () => {
  const value = fixture(), capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend, [{label: "Care facilities", color: "#dc2626", opacity: .7,
    pointStyle: {pointSymbol: "hospital", circleColor: "#dc2626", circleRadius: 8}}]);
  assert.deepEqual(capture.attribution, ["Clinic survey"]);
  const page = pageFor(value, capture), icon = page.querySelector('[data-point-symbol="hospital"]');
  assert.ok(icon);assert.equal(Number(icon.getAttribute("width")), 16 * 25.4 / 96);
  assert.equal(icon.getAttribute("opacity"), "0.7");
  const svg = decodeURIComponent(icon.getAttribute("href").split(",").slice(1).join(","));
  assert.match(svg, /fill="#dc2626"/);assert.match(svg, /<rect/);
  assert.doesNotMatch(svg, /<script|(?:href|src)="https?:|onload|<image/);
  assert.equal(page.querySelector('image:not([data-point-symbol])').getAttribute("href"), png);
}));

test("direct Print Studio capture loads imported Maki and OSM legends before generating the page", async () => withPage(async () => {
  const maki = "maki-8-2-0-hospital", osm = "osm-carto-1cc4b89c-amenity--hospital";
  assert.throws(() => pointSymbolPreviewSvg({pointSymbol: maki}), /assets have not been loaded/);
  const value = fixture({renderer: "category", pointSymbol: "circle", categorySymbols: {Hospital: maki, Clinic: osm}});
  value.circle.paint["circle-color"] = ["match", ["to-string", ["get", "kind"]], "Hospital", "#dc2626", "Clinic", "#2563eb", "#64748b"];
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend.map(row => row.pointStyle.pointSymbol), [maki, osm, "circle"]);
  const icons = [...pageFor(value, capture).querySelectorAll("[data-point-symbol]")];
  assert.deepEqual(icons.map(icon => icon.dataset.pointSymbol), [maki, osm, "circle"]);
  for (let index = 0; index < 2; index++) {
    const svg = decodeURIComponent(icons[index].getAttribute("href").split(",").slice(1).join(","));
    assert.equal(svg, pointSymbolPreviewSvg(capture.legend[index].pointStyle));
    assert.match(svg, /<rect/);assert.doesNotMatch(svg, /<script|<image|(?:href|src)="https?:/);
  }
  assert.equal(capture.dataUrl, png);
}));

test("hospital and clinic categories have distinct matching glyph and color rows with a fallback", async () => withPage(async () => {
  const value = fixture({renderer: "category", pointSymbol: "circle", categorySymbols: {Hospital: "hospital", Clinic: "clinic"}});
  value.circle.paint["circle-color"] = ["match", ["to-string", ["get", "kind"]], "Hospital", "#dc2626", "Clinic", "#2563eb", "#64748b"];
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend.map(row => [row.label, row.pointStyle.pointSymbol, row.color]), [
    ["Care facilities · Hospital", "hospital", "#dc2626"],
    ["Care facilities · Clinic", "clinic", "#2563eb"],
    ["Care facilities · Other values", "circle", "#64748b"]
  ]);
  assert.deepEqual([...pageFor(value, capture).querySelectorAll("[data-point-symbol]")].map(node => node.dataset.pointSymbol), ["hospital", "clinic", "circle"]);
}));

test("pinned Point glyphs drive the legend while non-Point layers retain rectangle swatches", async () => withPage(async () => {
  const value = fixture();
  value.layer.styleReference = {styleId: "pinned"};
  value.handle.boundStyle = {pointSymbolStyle: {...value.layer.style, pointSymbol: "clinic"}};
  value.layer.style.pointSymbol = "flag";
  assert.equal((await capturePrintMap(value.context, value.record)).legend[0].pointStyle.pointSymbol, "clinic");
  value.layer.geometryType = "Polygon";value.circle.type = "fill";value.circle.paint = {"fill-color": "#16a34a"};
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend, [{label: "Care facilities", color: "#16a34a"}]);
  const page = pageFor(value, capture);
  assert.equal(page.querySelectorAll("[data-point-symbol]").length, 0);
  assert.ok(page.querySelector('rect[fill="#16a34a"]'));
}));

test("Point legend caps and generated SVG input validation remain enforced", async () => withPage(async () => {
  const value = fixture({renderer: "category", categorySymbols: Object.fromEntries(Array.from({length: 40}, (_, index) => [`Type ${index}`, "clinic"]))});
  await assert.rejects(capturePrintMap(value.context, value.record), /legend exceeds 40 rows/);
  const safe = fixture(), capture = await capturePrintMap(safe.context, safe.record);
  capture.legend[0].pointStyle.pointSymbol = "https://unbound.example/icon.svg";
  assert.throws(() => pageFor(safe, capture), /Unknown point symbol/);
  capture.legend[0].pointStyle.pointSymbol = "hospital";
  capture.legend[0].pointStyle.circleColor = "url(https://unbound.example/icon.svg)";
  assert.throws(() => pageFor(safe, capture), /Invalid point legend color/);
}));
