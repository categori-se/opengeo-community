import assert from "node:assert/strict";
import {afterEach, beforeEach, test} from "node:test";
import {JSDOM} from "jsdom";
import {readFile} from "node:fs/promises";
import {ProjectPrintEditor} from "../src/components/ProjectPrintEditor.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {definitionWithPrintLayouts, newProjectPrintLayout, printLayerPresentation, projectPrintLayouts, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";
import {templateFromLayout} from "../src/lib/printTemplates.js";

let dom, previousDocument, root;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.example.test"});
  previousDocument = globalThis.document;globalThis.document = dom.window.document;
});
afterEach(() => {root?.dispose();root = null;dom.window.close();globalThis.document = previousDocument;});
function fixture() {
  const map = {id: "map", projectId: "account", version: 3, name: "Watershed review", definition: {
    projection: "mercator", extensions: {retained: {value: 7}}, mapViews: [{center: [12, 45], zoom: 5, pitch: 0, bearing: 0}],
    layers: [{layerId: "water", datasetId: "dataset", sourceVersion: 4, datasetVersionId: "version", title: "Watersheds", visible: true,
      style: {fill: "#123456"}, labels: {}, opacity: 0.8}]
  }};
  const layout = newProjectPrintLayout(map, "existing");layout.northArrow = false;layout.scaleBar = false;
  map.definition = definitionWithPrintLayouts(map, {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]});
  return {map, layout};
}
function editor(map, options = {}) {
  const workbench = document.createElement("div");
  workbench.getPrintContext = () => ({layers: map.definition.layers, getPrintDataSource: layerId => ({id: layerId,
    geojson: {type: "FeatureCollection", features: [{type: "Feature", properties: {name: "Lake", value: 12}}]}})});
  const captureMap = async () => {
    const view = structuredClone(map.definition.mapViews[0]), presentation = map.definition.layers.map(printLayerPresentation);
    return {view, presentation, signature: canonicalJson({view, presentation}), width: 800, height: 600,
      cssWidth: 400, cssHeight: 300, dataUrl: "data:image/png;base64,aW1hZ2U=", imageSha256: "a".repeat(64),
      legend: [{label: "Watersheds", color: "#123456"}], attribution: ["Watershed provider"], licenses: ["CC0-1.0"], lines: [], flat: true};
  };
  root = ProjectPrintEditor({state: {selectedMap: map, project: {id: "account"}, organization: {id: "org"}, adapter: options.adapter ?? {}},
    workbench, editFrame: () => workbench, captureMap, canSave: true, ...options});
  document.body.append(root);return root;
}
function field(label, value) {const node = root.querySelector(`[aria-label="${label}"]`);assert.ok(node, label);node.value = value;node.dispatchEvent(new dom.window.Event("change"));}
async function click(label) {const node = [...root.querySelectorAll("button")].find(node => node.textContent === label);assert.ok(node, label);assert.equal(node.disabled, false, label);await node.onclick();}
const status = () => root.querySelector('[role="status"]').textContent;
async function uploadTemplate(text) {
  const input = root.querySelector('[aria-label="Import Print template"]');
  Object.defineProperty(input, "files", {value: [{size: new TextEncoder().encode(text).length, text: async () => text}]});await input.onchange();
}

test("native QGIS import reviews rebinding before adding a source-free Project template", async () => {
  const {map} = fixture();editor(map);
  const xml = await readFile(new URL("fixtures/qgis-3.44.14-source-free.qpt", import.meta.url), "utf8");
  await uploadTemplate(xml);
  assert.ok(root.querySelector(".print-qgis-import-review"));assert.match(status(), /Review.*before importing/);
  assert.equal(root.hasUnsavedChanges(), false);assert.equal(root.querySelector('[aria-label="Print template"]').options.length, 1);
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1);
  await click("Import reviewed QGIS template");assert.equal(root.querySelector(".print-qgis-import-review"), null);
  assert.equal(root.hasUnsavedChanges(), true);assert.equal(root.querySelector('[aria-label="Print template"]').options.length, 2);
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1, "reviewed import does not apply a map or inherit source access");
  await click("Create layout from template");assert.match(status(), /Choose a loaded Layer/);
  assert.equal(root.querySelector(".print-templates").open, true, "the required source controls remain visible after validation");
  field("Template source 1", "water");await click("Create layout from template");
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 2);
  assert.equal(root.querySelectorAll(".print-stage image").length, 0);
  assert.deepEqual(map.definition.layers, fixture().map.definition.layers);
});

test("QGIS review cancellation and invalid replacement preserve existing layouts without stale import", async () => {
  const {map} = fixture();editor(map);
  const xml = await readFile(new URL("fixtures/qgis-3.44.14-source-free.qpt", import.meta.url), "utf8");
  await uploadTemplate(xml);await click("Cancel QGIS import");
  assert.equal(root.querySelector(".print-qgis-import-review"), null);assert.equal(root.hasUnsavedChanges(), false);
  await uploadTemplate(xml);assert.ok(root.querySelector(".print-qgis-import-review"));
  await uploadTemplate('<!DOCTYPE Layout [<!ENTITY unsafe SYSTEM "https://example.invalid/private">]><Layout>&unsafe;</Layout>');
  assert.equal(root.querySelector(".print-qgis-import-review"), null);assert.equal(root.hasUnsavedChanges(), false);
  assert.equal(root.querySelector('[aria-label="Print template"]').options.length, 1);
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1);
  assert.doesNotMatch(status(), /QGIS template read/);
});

test("named Print templates persist with layouts, reopen source-free and create separately bound identities", async () => {
  const {map, layout} = fixture(), before = structuredClone(map.definition);let saved, writes = 0;
  editor(map, {adapter: {updateMap: async (projectId, mapId, request) => {
    assert.equal(projectId, "account");assert.equal(mapId, "map");assert.equal(request.expectedVersion, 3);writes++;
    saved = {...map, version: 4, definition: request.changes.definition};return saved;
  }}});
  field("Template name", "Regional map sheet");await click("Save layout as template");
  const templateId = root.querySelector('[aria-label="Print template"]').value;assert.ok(templateId);
  await click("Create layout from template");const createdId = root.querySelector('[aria-label="Layout"]').value;
  assert.notEqual(createdId, layout.id);assert.equal(root.querySelectorAll(".print-stage image").length, 0);
  await click("Save layout");assert.equal(writes, 1);
  const stored = projectPrintLayouts(saved);assert.equal(stored.templates.length, 1);assert.equal(stored.layouts.length, 2);
  assert.equal(stored.templates[0].name, "Regional map sheet");
  assert.equal(Object.hasOwn(stored.templates[0].frames[0], "view"), false);
  assert.equal(Object.hasOwn(stored.templates[0].frames[0], "presentation"), false);
  assert.deepEqual(stored.layouts[1].frames[0].presentation, map.definition.layers.map(printLayerPresentation));
  assert.deepEqual(saved.definition.layers, before.layers);assert.deepEqual(saved.definition.mapViews, before.mapViews);
  assert.deepEqual(saved.definition.extensions.retained, before.extensions.retained);assert.deepEqual(stored.layouts[0], layout);
  root.dispose();root.remove();editor(JSON.parse(JSON.stringify(saved)));field("Print template", templateId);
  assert.equal(root.querySelector('[aria-label="Template name"]').value, "Regional map sheet");
  assert.equal(root.querySelectorAll(".print-stage image").length, 0);assert.equal(root.hasUnsavedChanges(), false);
});

test("template data slots require explicit loaded Layer fields and keep failed application out of history", async () => {
  const {map, layout} = fixture();layout.dataFrames = [{id: "table", type: "table", title: "Recorded values", xMm: 10, yMm: 35,
    widthMm: 100, heightMm: 60, mapFrameId: "main", source: {layerId: "water", datasetId: "dataset", datasetVersionId: "version", sourceVersion: 4},
    columns: ["name", "value"], rowLimit: 5}];
  const template = templateFromLayout(layout, "Data sheet", "template");
  map.definition = definitionWithPrintLayouts(map, {...projectPrintLayouts(map), templates: [template]});editor(map);
  field("Print template", "template");await click("Create layout from template");
  assert.match(status(), /Choose a loaded Layer/);assert.equal(root.hasUnsavedChanges(), false);
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1);
  field("Template source 1", "water");await click("Create layout from template");
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 2);
  assert.equal(root.querySelector('[aria-label="Data Layer"]'), null, "new layout opens on its map frame");
  assert.equal(root.querySelectorAll(".print-stage [data-print-data-frame]").length, 0, "rows need a fresh linked capture");
  await click("Undo layout change");assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1);
});

test("template import rejects source state and preserves the draft, while valid imports get new identities", async () => {
  const {map, layout} = fixture();editor(map);const template = templateFromLayout(layout, "Portable sheet", "other-project-template");
  async function upload(value) {
    const input = root.querySelector('[aria-label="Import Print template"]'), text = JSON.stringify(value);
    Object.defineProperty(input, "files", {value: [{size: new TextEncoder().encode(text).length, text: async () => text}]});await input.onchange();
  }
  await upload({...template, frames: [{...template.frames[0], presentation: map.definition.layers}]});
  assert.match(status(), /unsupported Print template fields/);assert.equal(root.hasUnsavedChanges(), false);
  await upload(template);const id = root.querySelector('[aria-label="Print template"]').value;
  assert.ok(id);assert.notEqual(id, template.id);assert.equal(root.hasUnsavedChanges(), true);
  assert.equal(root.querySelector('[aria-label="Layout"]').options.length, 1, "import does not automatically apply the template");
});

test("template collection preserves legacy shape and enforces aggregate bounds and unique identities", () => {
  const {map, layout} = fixture(), legacy = projectPrintLayouts(map), encoded = JSON.stringify(legacy);
  assert.equal(JSON.stringify(validateProjectPrintLayouts(legacy, map)), encoded);
  const template = templateFromLayout(layout, "Sheet", "template");
  assert.throws(() => validateProjectPrintLayouts({...legacy, templates: [template, template]}, map), /identities must be unique/);
  assert.throws(() => validateProjectPrintLayouts({...legacy, templates: Array(9).fill(template)}, map), /eight Print templates/);
  const templates = Array.from({length: 8}, (_, index) => ({...template, id: `template-${index}`, caption: "文".repeat(2000)}));
  assert.throws(() => validateProjectPrintLayouts({...legacy, templates}, map), /32 KiB/);
});

test("output controls report page pixels and captured detail, expose progress and recover from raster failure", async () => {
  const {map} = fixture();editor(map);assert.match(root.querySelector('[aria-label="Output dimensions"]').textContent, /297 × 210 mm; 1123 × 794 page pixels at 96 DPI/);
  field("Output format", "png");assert.equal(root.hasUnsavedChanges(), false);
  assert.equal([...root.querySelectorAll("button")].find(node => node.textContent === "Prepare selected output").disabled, true);
  assert.match(root.querySelector('[aria-label="Output readiness"]').textContent, /Capture every map frame/);
  await click("Capture map frame");assert.match(root.querySelector('[aria-label="Captured map detail"]').textContent, /800 × 600 captured map pixels/);
  field("Output DPI", "150");assert.match(root.querySelector('[aria-label="Output dimensions"]').textContent, /1754 × 1240 page pixels at 150 DPI/);
  assert.match(root.querySelector('[aria-label="Captured map detail"]').textContent, /capture required/);
  assert.equal([...root.querySelectorAll("button")].find(node => node.textContent === "Prepare selected output").disabled, true);
  assert.match(root.querySelector('[aria-label="Output readiness"]').textContent, /Capture every map frame/);
  await click("Capture map frame");
  let rejectImage, revoked = 0;const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:print-test";URL.revokeObjectURL = () => {revoked++;};
  dom.window.Image = class {set src(_) {rejectImage = () => this.onerror();}};
  try {
    const action = click("Prepare selected output");await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(root.querySelector('progress[aria-label="Preparing Print output"]'));
    assert.equal(root.querySelector(".print-studio-controls").getAttribute("aria-busy"), "true");
    assert.equal(root.querySelector('[role="status"]').closest('[aria-busy="true"]'), null);
    assert.match(status(), /Rasterizing.*1754 × 1240/);rejectImage();await action;
    assert.match(status(), /could not be rasterized/);assert.equal(root.querySelector("progress"), null);
    assert.equal(root.querySelector(".print-studio-controls").getAttribute("aria-busy"), "false");assert.equal(revoked, 1);
  } finally {URL.createObjectURL = create;URL.revokeObjectURL = revoke;}
});

test("output-sized capture reports progress, preserves a failed draft and passes physical sizing for recovery", async () => {
  const {map, layout} = fixture(), original = structuredClone(map.definition);let rejectCapture, calls = 0, options;
  editor(map, {captureMap: async (_context, _record, requested) => {
    calls++;options = requested;requested.onPhase("Rendering loaded map pixels…");
    if (calls === 1) await new Promise((_resolve, reject) => {rejectCapture = reject;});
    const view = structuredClone(map.definition.mapViews[0]), presentation = map.definition.layers.map(printLayerPresentation);
    return {view, presentation, signature: canonicalJson({view, presentation}), width: 813, height: 610, cssWidth: 400, cssHeight: 300,
      dataUrl: "data:image/png;base64,aW1hZ2U=", imageSha256: "a".repeat(64), legend: [], attribution: [], lines: [], flat: true};
  }});
  const action = click("Capture map frame");await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(root.querySelector('progress[aria-label="Capturing Print map"]'));assert.match(status(), /Rendering loaded map pixels/);
  assert.equal(root.querySelector(".print-studio-controls").getAttribute("aria-busy"), "true");
  assert.deepEqual(options.outputFrame, {widthMm: layout.frames[0].widthMm, heightMm: layout.frames[0].heightMm, dpi: 96});
  assert.equal(options.signal.aborted, false);rejectCapture(Error("Fixture render failed; retry capture."));await action;
  assert.equal(root.hasUnsavedChanges(), false);assert.equal(root.querySelector("progress"), null);assert.match(status(), /Fixture render failed/);
  assert.deepEqual(map.definition, original);assert.equal(root.querySelector(".print-stage image"), null);
  await click("Capture map frame");assert.equal(calls, 2);assert.ok(root.querySelector(".print-stage image"));
  const captured = JSON.parse(root.querySelector(".print-stage svg > metadata").textContent).captures[0];
  assert.equal(captured.outputSignature, canonicalJson({widthMm: layout.frames[0].widthMm, heightMm: layout.frames[0].heightMm, dpi: 96}));
  assert.deepEqual(map.definition, original);
});

test("Print output reports an actual dialog request without claiming a saved PDF", async () => {
  const {map} = fixture();editor(map);await click("Capture map frame");field("Output format", "print");
  await click("Prepare selected output");assert.match(status(), /Preparing the browser print dialog/);
  const iframe = root.querySelector('iframe[title="Print layout"]');let calls = 0;
  iframe.contentWindow.focus = () => {};iframe.contentWindow.print = () => {calls++;};iframe.onload();
  assert.equal(calls, 1);assert.match(status(), /Print dialog requested for 297 × 210 mm/);assert.doesNotMatch(status(), /PDF saved|output prepared/i);
  iframe.contentWindow.dispatchEvent(new dom.window.Event("afterprint"));assert.equal(iframe.isConnected, false);
});


test("vector output explains an unsupported capture and retains the existing raster page and draft", async () => {
  const {map} = fixture();editor(map);await click("Capture map frame");
  const image = root.querySelector(".print-stage image").getAttribute("href"), before = JSON.stringify(map.definition);
  for (const format of ["vector-svg", "vector-print", "vector-pdf", "geospatial-pdf"]) {
    field("Output format", format);
    const prepare = [...root.querySelectorAll("button")].find(node => node.textContent === "Prepare selected output");
    assert.equal(prepare.disabled, true);
    const readiness = root.querySelector('[aria-label="Output readiness"]');
    assert.equal(prepare.getAttribute("aria-describedby"), readiness.id);
    assert.match(readiness.textContent, /capture again to check vector support.*Choose a raster output/);
    assert.equal(root.querySelector("iframe"), null);assert.equal(root.querySelector(".print-stage image").getAttribute("href"), image);
    assert.equal(root.querySelector(".print-studio-controls").getAttribute("aria-busy"), "false");
  }
  field("Output format", "svg");
  assert.equal([...root.querySelectorAll("button")].find(node => node.textContent === "Prepare selected output").disabled, false);
  assert.equal(JSON.stringify(map.definition), before);assert.equal(root.hasUnsavedChanges(), true, "capturing retains its ordinary unsaved layout state");
});
