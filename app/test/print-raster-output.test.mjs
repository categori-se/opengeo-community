import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {JSDOM} from "jsdom";
import {unzipSync, strFromU8} from "fflate";
import {capturePrintRasterLegend} from "../src/lib/printRasterLegend.js";
import {capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout, definitionWithPrintLayouts, projectPrintLayouts, definitionForPrintFrame} from "../src/lib/printLayouts.js";
import {templateFromLayout, layoutFromTemplate} from "../src/lib/printTemplates.js";
import {compileFigurePrintPack} from "../src/lib/figurePrintPack.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";

function fixture() {
  const layer = {layerId: "scalar", datasetId: "raster-source", datasetVersionId: "v1", sourceVersion: 7,
    title: "Elevation", sourceType: "cog-raster", sourceUrl: "https://imagery.example/private-source.tif",
    sourceConfiguration: {bands: [1]}, geometryType: "Raster", visible: true, opacity: 0.8,
    style: {cogDisplay: {displayRange: {minimum: -100, maximum: 100}, noDataValue: -50}}, labels: {}};
  const record = {id: "map", version: 2, name: "Raster sheet", definition: {layers: [layer], mapViews: [{center: [4, 4], zoom: 5, pitch: 0, bearing: 0}]}};
  const layout = newProjectPrintLayout(record, "layout");layout.northArrow = false;layout.scaleBar = false;layout.legendFormat = "color-bars";
  const handle = {cog: {loading: false, result: {displayRange: {minimum: -100, maximum: 100}, noDataValue: -50},
    grid: {active: () => true, metadata: {bands: [1], noData: -9999, source: {url: layer.sourceUrl}}}}};
  const captured = capturePrintRasterLegend(layer, handle, [{id: "scalar-cog", type: "raster", paint: {"raster-opacity": 0.8}}]);
  const png = Uint8Array.of(137,80,78,71,13,10,26,10), jpeg = Uint8Array.of(255,216,255,217);
  const capture = {dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, imageSha256: createHash("sha256").update(png).digest("hex"),
    width: 800, height: 400, cssWidth: 400, cssHeight: 200, view: layout.frames[0].view, presentation: layout.frames[0].presentation,
    legend: captured.rows, rasterLegends: [{start: 0, count: captured.rows.length, ...captured.descriptor}],
    sourceMetadata: [{...captured.descriptor.sourcePin, title: layer.title, license: "CC0-1.0"}], attribution: ["Local scalar source"],
    flat: true, lines: [], projectId: record.id, projectVersion: record.version};
  capture.signature = canonicalJson({view: capture.view, presentation: capture.presentation});
  return {layer, record, layout, capture, handle, captures: new Map([["layout:main", capture]]), png, jpeg};
}

test("mixed capture refuses a required visible vector source that has no installed paint without returning partial raster pixels", async () => {
  const {layer, record, capture, handle} = fixture();
  const vector = {layerId:"missing-vector",datasetId:"vector-source",datasetVersionId:"vector-v1",sourceVersion:1,
    title:"Required vector overlay",visible:true,geometryType:"Polygon",sourceType:"geojson-object",style:{fill:"#3b82f6"},labels:{}};
  record.definition.layers.push(vector);const before=JSON.stringify(record);
  const map = new EventEmitter();let pixelReads=0;
  const canvas = {width:800,height:400,clientWidth:400,clientHeight:200,toDataURL:()=>{pixelReads++;return capture.dataUrl;}};
  Object.assign(map,{isStyleLoaded:()=>true,areTilesLoaded:()=>true,isMoving:()=>false,getCanvas:()=>canvas,
    getCenter:()=>({lng:4,lat:4}),getZoom:()=>5,getPitch:()=>0,getBearing:()=>0,
    getStyle:()=>({layers:[{id:"scalar-cog",type:"raster",paint:{"raster-opacity":0.8}}]}),
    triggerRepaint:()=>queueMicrotask(()=>map.emit("render"))});
  handle.layerIds=["scalar-cog"];
  const context={map,renderer:"maplibre",ready:true,project:record.definition,layers:[layer,vector],handles:new Map([[layer.layerId,handle]])};
  await assert.rejects(capturePrintMap(context,record),/Required vector overlay is not installed.*Resolve its loading or Style error/);
  assert.equal(pixelReads,1,"The already rendered canvas is inspected but no partial capture is returned");
  assert.equal(map.listenerCount("render"),0);assert.equal(JSON.stringify(record),before);
});

test("raster range survives saved layout reopening and templates bind the destination raster style", () => {
  const {record, layout, layer} = fixture();
  const definition = definitionWithPrintLayouts(record, {schemaVersion: "opengeo.project-print-layouts.1", projectId: record.id, layouts: [layout]});
  const reopened = projectPrintLayouts({...record, definition: JSON.parse(JSON.stringify(definition))}).layouts[0];
  assert.deepEqual(reopened.frames[0].presentation[0].style, layer.style);
  assert.deepEqual(definitionForPrintFrame({...record, definition}, reopened.frames[0]).layers[0].style, layer.style);
  const template = templateFromLayout(layout, "Raster design", "design");assert.equal(JSON.stringify(template).includes("cogDisplay"), false);
  const destination = structuredClone(record);destination.definition.layers[0].style.cogDisplay.displayRange = {minimum: -20, maximum: 80};
  const applied = layoutFromTemplate(template, destination, "new");
  assert.deepEqual(applied.frames[0].presentation[0].style.cogDisplay.displayRange, {minimum: -20, maximum: 80});
  for (const value of [{displayRange: {minimum: 1, maximum: 1}}, {displayRange: {minimum: -100, maximum: 100}, noDataValue: Infinity}]) {
    const changed = structuredClone(layout);changed.frames[0].presentation[0].style.cogDisplay = value;
    assert.throws(() => definitionWithPrintLayouts(record, {schemaVersion: "opengeo.project-print-layouts.1", projectId: record.id, layouts: [changed]}), /finite minimum/);
  }
});

test("raster paper and figure pack retain exact grayscale scale, transparency, source pins and rights", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;globalThis.document = dom.window.document;
  try {
    const value = fixture(), svg = printPageSvg(value.layout, value.captures, "layout");
    const bar = svg.querySelector('[data-raster-color-bar="scalar"]');assert.ok(bar);
    assert.deepEqual([...bar.querySelectorAll("stop")].map(node => [node.getAttribute("offset"), node.getAttribute("stop-color")]), [["0", "#000000"], ["1", "#ffffff"]]);
    assert.equal(bar.querySelector('[data-color-bar-no-data]').getAttribute("fill"), "none");
    assert.match(bar.textContent, /-100/);assert.match(bar.textContent, /100/);assert.match(bar.textContent, /Band 1/);
    const metadata = JSON.parse(svg.querySelector("metadata").textContent);
    assert.deepEqual(metadata.captures[0].rasterLegends[0].sourcePin, value.capture.rasterLegends[0].sourcePin);
    assert.match(svg.textContent, /CC0-1.0/);assert.doesNotMatch(JSON.stringify(metadata), /private-source\.tif/);
    const serialized = new dom.window.XMLSerializer().serializeToString(svg);
    const parsed = new dom.window.DOMParser().parseFromString(serialized, "image/svg+xml");
    assert.equal(parsed.querySelector("parsererror"), null, "Serialized paper must be valid standalone XML");
    assert.equal(parsed.documentElement.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(parsed.documentElement.getAttribute("xmlns"), "http://www.w3.org/2000/svg");
    assert.equal(parsed.querySelector("image").getAttribute("href"), value.capture.dataUrl);
    assert.equal(parsed.querySelector('[data-raster-color-bar="scalar"]').textContent, bar.textContent);
    assert.match(parsed.documentElement.textContent, /CC0-1.0/);
    const pack = await compileFigurePrintPack({...value, layoutId: "layout", svg: serialized, html: "<!doctype html>",
      png: new Blob([value.png], {type: "image/png"}), jpeg: new Blob([value.jpeg], {type: "image/jpeg"}), width: 1123, height: 794});
    const files = unzipSync(new Uint8Array(await pack.blob.arrayBuffer())), context = JSON.parse(strFromU8(files["map-context.json"]));
    assert.equal(context.frames[0].rasterLegends[0].sourceNoDataValue, -9999);
    assert.equal(context.frames[0].rasterLegends[0].noDataValue, -50);assert.equal(context.frames[0].rasterLegends[0].opacity, 0.8);
    assert.doesNotMatch(strFromU8(files["map-context.json"]), /private-source\.tif/);
    assert.equal(pack.manifest.pdf.representation, "raster-page");assert.equal(pack.manifest.pdf.georeferenced, false);
  } finally {globalThis.document = previous;dom.window.close();}
});
