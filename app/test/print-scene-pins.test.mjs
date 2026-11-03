import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {JSDOM} from "jsdom";
import {ProjectPrintEditor, capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {definitionForPrintFrame, definitionWithPrintLayouts, newProjectPrintLayout, printFrameScene,
  printFrameSceneSignature, projectPrintLayouts} from "../src/lib/printLayouts.js";
import {historicalImageryForSave, historicalImageryBasemap, historicalImagerySource} from "../src/lib/historicalImagery.js";
import {layoutFromTemplate, templateFromLayout, validatePrintTemplate} from "../src/lib/printTemplates.js";

function imagery(date, enabled = true) {
  const source = historicalImagerySource("nasa-gibs-modis-terra-true-color");
  return historicalImageryForSave({enabled, sourceId: source.sourceId, sourceRevision: source.sourceRevision,
    selection: {status: "resolved", requestedDate: date, displayedDate: date, policy: "exact", reason: "exact"}});
}
function fixture(date = "2026-08-29") {
  const historicalImagery = imagery(date), runtime = historicalImageryBasemap(historicalImagery);
  const basemap = Object.fromEntries(["basemapId", "title", "kind", "sourceId", "sourceRevision", "selection", "attribution"].map(key => [key, runtime[key]]));
  return {id: "map", projectId: "account", version: 3, name: "Imagery sheet", definition: {
    projection: "globe", mapViews: [{center: [12, 45], zoom: 5, pitch: 25, bearing: 10}],
    basemaps: [{...basemap, visible: true, opacity: 0.7}], extensions: {historicalImagery, retained: {value: 7}},
    layers: [{layerId: "water", datasetId: "dataset", datasetVersionId: "version", sourceVersion: 4,
      title: "Water", visible: false, opacity: 0.8, style: {fill: "#123456"}, labels: {field: "name"}}]
  }};
}
function collection(map, layout) {return {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};}
function savedFixture() {
  const map = fixture(), layout = newProjectPrintLayout(map, "layout");
  Object.assign(layout.frames[0], printFrameScene(map.definition));
  layout.northArrow = false;layout.scaleBar = false;layout.sourceNotes = false;
  map.definition = definitionWithPrintLayouts(map, collection(map, layout));
  return {map, layout};
}
function renderedContext(definition) {
  const map = new EventEmitter(), view = definition.mapViews[0];
  Object.assign(map, {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    getCanvas: () => ({width: 800, height: 400, clientWidth: 400, clientHeight: 200, toDataURL: () => "data:image/png;base64,aW1hZ2U="}),
    getCenter: () => ({lng: view.center[0], lat: view.center[1]}), getZoom: () => view.zoom,
    getPitch: () => view.pitch, getBearing: () => view.bearing, getProjection: () => ({type: definition.projection}),
    getStyle: () => ({layers: []}), triggerRepaint: () => queueMicrotask(() => map.emit("render"))});
  const context = {map, renderer: "maplibre", ready: true, project: definition, layers: definition.layers,
    handles: new Map(), basemap: historicalImageryBasemap(definition.extensions.historicalImagery)};
  context.withPrintResolution = async (_options, capture) => capture(context);
  return context;
}
function withDom(action) {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;globalThis.document = dom.window.document;
  return Promise.resolve().then(() => action(dom)).finally(() => {globalThis.document = previous;dom.window.close();});
}

test("saved frame A restores its exact scene and recaptures A after the main Project changes to B", async () => withDom(async () => {
  const {map, layout} = savedFixture(), original = structuredClone(map);
  const changed = fixture("2026-08-30");
  changed.definition.extensions.opengeoPrintLayouts = structuredClone(map.definition.extensions.opengeoPrintLayouts);
  changed.definition.layers[0].style.fill = "#abcdef";
  changed.definition.layers[0].labels.field = "changed";
  const fresh = JSON.parse(JSON.stringify(changed)), reopened = projectPrintLayouts(fresh).layouts[0].frames[0];
  const restored = definitionForPrintFrame(fresh, reopened);
  assert.deepEqual(restored.basemaps, original.definition.basemaps);
  assert.deepEqual(restored.extensions.historicalImagery, original.definition.extensions.historicalImagery);
  assert.deepEqual(restored.layers, original.definition.layers);
  assert.deepEqual(restored.extensions.retained, {value: 7});
  const capture = await capturePrintMap(renderedContext(restored), fresh);
  assert.deepEqual(capture.basemaps, reopened.basemaps);
  assert.equal(capture.historicalImagery.selection.displayedDate, "2026-08-29");
  assert.equal(capture.sceneSignature, printFrameSceneSignature(reopened));
  const svg = printPageSvg(layout, new Map([["layout:main", capture]]), "layout");
  const metadata = JSON.parse(svg.querySelector("metadata").textContent);
  assert.deepEqual(metadata.captures[0].basemaps, reopened.basemaps);
  assert.deepEqual(metadata.captures[0].historicalImagery, reopened.historicalImagery);
  assert.match(svg.textContent, /2026-08-29/);assert.match(svg.textContent, /NASA/);
  const visibleText = [...svg.children].filter(node => node.tagName !== "metadata").map(node => node.textContent).join(" ");
  assert.doesNotMatch(visibleText, /2026-08-30/);
  assert.deepEqual(map, original);assert.deepEqual(fresh, changed);
  const stale = structuredClone(layout);stale.frames[0].historicalImagery = imagery("2026-08-30");
  assert.throws(() => printPageSvg(stale, new Map([["layout:main", capture]]), "layout"), /Capture every map frame again/);
}));

test("explicit blank, none and disabled imagery survive independently, while legacy frames inherit", () => {
  const map = fixture(), frame = newProjectPrintLayout(map, "layout").frames[0], before = structuredClone(map.definition);
  assert.equal(printFrameSceneSignature(frame), null);
  assert.deepEqual(definitionForPrintFrame(map, frame), {...before, mapViews: [{id: "print-view", title: frame.title, ...frame.view}]});
  const none = {...frame, basemaps: [], historicalImagery: null}, restoredNone = definitionForPrintFrame(map, none);
  assert.equal(restoredNone.basemaps[0].basemapId, "blank");assert.equal(restoredNone.basemaps[0].url, null);
  assert.equal(Object.hasOwn(restoredNone.extensions, "historicalImagery"), false);
  const disabled = imagery("2026-08-29", false), blank = structuredClone(restoredNone.basemaps);
  const restoredDisabled = definitionForPrintFrame(map, {...frame, basemaps: blank, historicalImagery: disabled});
  assert.deepEqual(restoredDisabled.basemaps, blank);assert.deepEqual(restoredDisabled.extensions.historicalImagery, disabled);
  assert.deepEqual(map.definition, before);
});

test("portable templates strip scene pins and retain their destination scene until capture", () => {
  const {layout} = savedFixture(), destination = fixture("2026-08-30"), before = structuredClone(destination);
  const template = templateFromLayout(layout, "Portable", "template"), frame = template.frames[0];
  assert.equal(Object.hasOwn(frame, "basemaps"), false);assert.equal(Object.hasOwn(frame, "historicalImagery"), false);
  assert.throws(() => validatePrintTemplate({...template, frames: [{...frame, basemaps: []}]}), /unsupported Print template fields/);
  const applied = layoutFromTemplate(template, destination, "applied"), definition = definitionForPrintFrame(destination, applied.frames[0]);
  assert.deepEqual(definition.basemaps, destination.definition.basemaps);
  assert.deepEqual(definition.extensions.historicalImagery, destination.definition.extensions.historicalImagery);
  assert.deepEqual(destination, before);
});

test("scene pins reject unavailable revisions, secret metadata and oversized collections", () => {
  const {map, layout} = savedFixture();
  for (const mutate of [
    frame => {frame.historicalImagery.sourceRevision = "unavailable";},
    frame => {frame.basemaps[0].sourceRevision = "unavailable";},
    frame => {frame.basemaps[0].token = "secret";},
    frame => {frame.historicalImagery.token = "secret";},
    frame => {frame.basemaps[0].selection.credentials = "secret";},
    frame => {frame.scene = {};}
  ]) {
    const changed = structuredClone(layout);mutate(changed.frames[0]);
    assert.throws(() => definitionWithPrintLayouts(map, collection(map, changed)));
  }
  const copies = Array.from({length: 8}, (_, index) => ({...structuredClone(layout), id: `layout-${index}`, caption: "文".repeat(2000)}));
  assert.throws(() => definitionWithPrintLayouts(map, {...collection(map, layout), layouts: copies}), /32 KiB/);
});

test("Print editor captures, saves and freshly reopens frame scene A without changing main Project B", async () => withDom(async () => {
  const {map: pinned} = savedFixture(), map = fixture("2026-08-30");
  map.definition.extensions.opengeoPrintLayouts = pinned.definition.extensions.opengeoPrintLayouts;
  const original = structuredClone(map);let saved, root, restored;
  function workbench(definition) {const node = document.createElement("div"), context = renderedContext(definition);node.getPrintContext = () => context;return node;}
  const options = current => ({state: {selectedMap: current, project: {id: "account"}, organization: {id: "org"}, adapter: {
    updateMap: async (_projectId, _mapId, request) => saved = {...current, version: current.version + 1, definition: request.changes.definition}
  }}, workbench: workbench(current.definition), editFrame: frame => {restored = definitionForPrintFrame(current, frame);return workbench(restored);}, canSave: true});
  async function click(text) {const button = [...root.querySelectorAll("button")].find(node => node.textContent === text);assert.ok(button, text);assert.equal(button.disabled, false, text);await button.onclick();}
  try {
    root = ProjectPrintEditor(options(map));document.body.append(root);
    await click("Edit selected map frame");assert.equal(restored.extensions.historicalImagery.selection.displayedDate, "2026-08-29");
    await click("Capture map frame");assert.match(root.querySelector('[role="status"]').textContent, /Captured Main map/);
    await click("Save layout");assert.deepEqual(saved.definition.basemaps, original.definition.basemaps);
    assert.deepEqual(saved.definition.extensions.historicalImagery, original.definition.extensions.historicalImagery);
    assert.deepEqual(projectPrintLayouts(saved).layouts[0].frames[0].basemaps, pinned.definition.basemaps);
    root.dispose();root.remove();root = ProjectPrintEditor(options(JSON.parse(JSON.stringify(saved))));document.body.append(root);
    await click("Edit selected map frame");await click("Capture map frame");
    assert.equal(restored.extensions.historicalImagery.selection.displayedDate, "2026-08-29");
    assert.match(root.querySelector('[role="status"]').textContent, /Captured Main map/);assert.deepEqual(map, original);
  } finally {root?.dispose();}
}));

test("a scene changed during asynchronous capture leaves the frame and save history untouched", async () => withDom(async () => {
  const {map} = savedFixture(), original = structuredClone(map), context = renderedContext(map.definition);
  const workbench = document.createElement("div");workbench.getPrintContext = () => context;
  const root = ProjectPrintEditor({state: {selectedMap: map, organization: {id: "org"}, adapter: {}}, workbench,
    captureMap: async (...args) => {const capture = await capturePrintMap(...args);context.project = fixture("2026-08-30").definition;return capture;}});
  try {
    document.body.append(root);
    await [...root.querySelectorAll("button")].find(node => node.textContent === "Capture map frame").onclick();
    assert.match(root.querySelector('[role="status"]').textContent, /background or imagery changed during capture/);
    assert.equal(root.hasUnsavedChanges(), false);assert.equal(root.querySelectorAll(".print-stage image").length, 0);
    assert.deepEqual(map, original);
  } finally {root.dispose();}
}));
