import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectPrintStudio} from "../src/components/ProjectPrintStudio.js";
import {ProjectSites} from "../src/components/ProjectSites.js";
import {ProjectWorkspacePage} from "../src/components/ProjectWorkspacePage.js";
import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";
import {ProjectPrintEditor, capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {alignPrintFrame, definitionWithPrintLayouts, definitionForPrintFrame, movePrintFrame, newProjectPrintLayout, printLayerPresentation, projectPrintLayouts, resizePrintFrame, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  project: "50000000-0000-4000-8000-000000000001"
});
const catalog = JSON.parse(
  await readFile(new URL("../src/data/catalog.json", import.meta.url), "utf8")
);

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

describe("publication project surfaces", () => {
  it("Print retains explicit composite opacity separately from feature alpha and legacy frame behavior", () => {
    const map = printProjectFixture(), layer = map.definition.layers[0];
    layer.sourceType = "geojson-object";layer.geometryType = "Polygon";delete layer.sourceUrl;
    const legacy = newProjectPrintLayout(map, "legacy");
    assert.equal(Object.hasOwn(legacy.frames[0].presentation[0], "opacityMode"), false);
    layer.opacityMode = "composite";
    const layout = newProjectPrintLayout(map, "composite"), value = {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};
    assert.equal(layout.frames[0].presentation[0].opacityMode, "composite");
    const stored = JSON.parse(JSON.stringify(definitionWithPrintLayouts(map, value)));
    const fresh = projectPrintLayouts({...map, definition: stored});
    const edited = {...map, definition: {...stored, layers: stored.layers.map(item => ({...item, opacityMode: "feature"}))}};
    assert.equal(definitionForPrintFrame(edited, fresh.layouts[0].frames[0]).layers[0].opacityMode, "composite");
    assert.equal(definitionForPrintFrame(map, legacy.frames[0]).layers[0].opacityMode, "composite", "old frames keep existing inheritance behavior");
    assert.notEqual(canonicalJson(layout.frames[0].presentation), canonicalJson(legacy.frames[0].presentation));
    const invalid = structuredClone(value);invalid.layouts[0].frames[0].presentation[0].opacityMode = "flatten";
    assert.throws(() => validateProjectPrintLayouts(invalid, map), /opacity blending/);
    const unsupported = {...map, definition: {...map.definition, layers: [{...layer, geometryType: "Point"}]}};
    assert.throws(() => validateProjectPrintLayouts(value, unsupported), /Composite opacity requires/);
    assert.equal(edited.definition.layers[0].opacityMode, "feature");
  });

  it("retains exact Project print bindings and preserves canonical data and other extensions", () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "layout-one");
    const value = {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};
    layout.frames[0].presentation[0].style.fill = "#00aa00";
    const definition = definitionWithPrintLayouts(map, value);
    assert.deepEqual(definition.layers, map.definition.layers);assert.deepEqual(definition.extensions.kept, {answer: 42});
    const reopened = projectPrintLayouts({...map, definition});assert.equal(reopened.layouts[0].frames[0].presentation[0].style.fill, "#00aa00");
    assert.equal(Object.hasOwn(layout, "legendFormat"), false);assert.deepEqual(reopened, value);
    assert.equal(JSON.stringify(projectPrintLayouts({...map, definition: JSON.parse(JSON.stringify(definition))})), JSON.stringify(value));
    for (const legendFormat of ["swatches", "classed-bars"]) {
      const chosen = structuredClone(value);chosen.layouts[0].legendFormat = legendFormat;
      const savedDefinition = definitionWithPrintLayouts(map, chosen);
      const fresh = projectPrintLayouts({...map, definition: JSON.parse(JSON.stringify(savedDefinition))});
      assert.deepEqual(fresh, chosen);assert.deepEqual(savedDefinition.layers, map.definition.layers);
      assert.deepEqual(savedDefinition.extensions.kept, {answer: 42});assert.equal(Object.hasOwn(layout, "legendFormat"), false);
    }
    for (const legendFormat of [null, undefined, "continuous", "", 1, {}, ["classed-bars"], "https://example.org/legend", "data:image/svg+xml,private", "javascript:alert(1)"]) {
      const rejected = structuredClone(value);rejected.layouts[0].legendFormat = legendFormat;
      assert.throws(() => validateProjectPrintLayouts(rejected, map), /Invalid print legend format/);
    }
    const view = definitionForPrintFrame(map, reopened.layouts[0].frames[0]);
    assert.equal(view.layers[0].style.fill, "#00aa00");assert.equal(view.layers[0].sourceUrl, map.definition.layers[0].sourceUrl);
    assert.equal(Object.hasOwn(view.layers[0], "filter"), false);assert.equal(Object.hasOwn(view.layers[0], "styleReference"), false);
    for (const mutate of [draft => {draft.projectId = IDS.project;}, draft => {draft.layouts[0].frames[0].presentation[0].sourceVersion = 99;},
      draft => {draft.layouts[0].frames[0].presentation[0].style.url = "https://example.org/other";},
      draft => {draft.layouts[0].frames[0].presentation[0].filter = ["execute", "bad"];},
      draft => {draft.layouts[0].frames[0].presentation[0].styleReference = {styleId: "unknown"};},
      draft => {Object.assign(draft.layouts[0].page, {widthMm: 1189, heightMm: 841});draft.layouts[0].dpi = 300;},
      draft => {draft.layouts[0].frames[0].image = "data:image/png;base64,private";}]) {
      const rejected = structuredClone(value);mutate(rejected);assert.throws(() => validateProjectPrintLayouts(rejected, map));
    }
  });

  it("retains source-bound print table and chart frames through exact layout save/reopen without copied data", () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "data-layout");
    const legacy = {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};
    const legacyBytes = JSON.stringify(legacy), canonical = structuredClone(map.definition);
    assert.equal(Object.hasOwn(layout, "dataFrames"), false);
    assert.equal(JSON.stringify(validateProjectPrintLayouts(legacy, map)), legacyBytes);
    const source = {layerId: "wetlands", datasetId: map.definition.layers[0].datasetId, datasetVersionId: null, sourceVersion: 2};
    layout.dataFrames = [
      {id: "table", type: "table", title: "Wetland areas", xMm: 20, yMm: 30, widthMm: 100, heightMm: 50,
        mapFrameId: "main", source, rowLimit: 12, columns: ["Site name", "area.total", "reading[0]", "面積"]},
      {id: "chart", type: "chart", title: "Observed area", xMm: 140, yMm: 30, widthMm: 100, heightMm: 60,
        mapFrameId: "main", source: {...source}, rowLimit: 1, chartType: "bar", labelField: "Site name", valueField: "area.total", altText: "Observed area for the selected sites."}
    ];
    const before = structuredClone(legacy), definition = definitionWithPrintLayouts(map, legacy);
    assert.deepEqual(projectPrintLayouts({...map, definition: JSON.parse(JSON.stringify(definition))}), legacy);
    assert.deepEqual(definition.layers, canonical.layers);assert.deepEqual(definition.extensions.kept, canonical.extensions.kept);
    assert.deepEqual(map.definition, canonical);assert.deepEqual(legacy, before);
    const serialized = JSON.stringify(definition.extensions.opengeoPrintLayouts);
    assert.doesNotMatch(serialized, /sourceUrl|sourceConfiguration|data:image|ImageServer|"rows"|"values"/);
    layout.dataFrames[1].chartType = "line";
    assert.deepEqual(validateProjectPrintLayouts(legacy, map), legacy);
    delete map.definition.layers[0].datasetId;delete map.definition.layers[0].sourceVersion;
    layout.frames[0].presentation = map.definition.layers.map(printLayerPresentation);
    layout.dataFrames.forEach(frame => {frame.source.datasetId = null;frame.source.sourceVersion = null;});
    assert.deepEqual(validateProjectPrintLayouts(legacy, map), legacy, "local Layers retain explicit null source pins");
  });

  it("rejects unsafe print data-frame fields, stale or invisible bindings and unchanged collection bounds", () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "data-bounds");
    layout.dataFrames = [{id: "table", type: "table", title: "Wetland areas", xMm: 20, yMm: 30, widthMm: 100, heightMm: 50,
      mapFrameId: "main", source: {layerId: "wetlands", datasetId: map.definition.layers[0].datasetId, datasetVersionId: null, sourceVersion: 2}, rowLimit: 12, columns: ["name", "area"]}];
    const value = {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};
    const reject = (change, expected) => {
      const draft = structuredClone(value);change(draft.layouts[0], draft);assert.throws(() => validateProjectPrintLayouts(draft, map), expected);
    };
    for (const change of [
      item => {item.dataFrames = null;}, item => {item.dataFrames = undefined;}, item => {item.dataFrames = {};},
      item => {item.dataFrames[0].id = "main";}, item => {item.dataFrames.push({...item.dataFrames[0]});},
      item => {item.dataFrames[0].mapFrameId = "unknown";}, item => {item.frames[0].presentation[0].visible = false;},
      item => {item.frames[0].presentation = [];}, item => {item.dataFrames[0].source.layerId = "unknown";},
      item => {item.dataFrames[0].source.datasetId = "other";}, item => {item.dataFrames[0].source.datasetVersionId = "other";},
      item => {item.dataFrames[0].source.sourceVersion = 3;}, item => {delete item.dataFrames[0].source.datasetVersionId;},
      item => {item.dataFrames[0].source.sourceUrl = "https://example.org/data";}, item => {item.dataFrames[0].source.loader = "fetch";},
      item => {item.dataFrames[0].rows = [["copied"]];}, item => {item.dataFrames[0].values = [1];},
      item => {item.dataFrames[0].type = "image";}, item => {item.dataFrames[0].xMm = -1;},
      item => {item.dataFrames[0].yMm = Infinity;}, item => {item.dataFrames[0].widthMm = 19.999;},
      item => {item.dataFrames[0].heightMm = 19.999;}, item => {item.dataFrames[0].xMm = 250;},
      item => {item.dataFrames[0].heightMm = 200;}, item => {item.dataFrames[0].title = "";},
      item => {item.dataFrames[0].id = "x".repeat(101);}, item => {item.dataFrames[0].columns = [];},
      item => {item.dataFrames[0].columns = ["name", "name"];}, item => {item.dataFrames[0].columns = ["1", "2", "3", "4", "5"];},
      item => {item.dataFrames[0].columns = ["__proto__"];}, item => {item.dataFrames[0].columns = ["Constructor"];},
      item => {item.dataFrames[0].columns = ["prototype"];}, item => {item.dataFrames[0].columns = ["line\nbreak"];},
      item => {item.dataFrames[0].columns = ["tab\tfield"];}, item => {item.dataFrames[0].columns = ["c1\u0085field"];},
      item => {item.dataFrames[0].columns = [" "];}, item => {item.dataFrames[0].columns = ["x".repeat(101)];},
      ...[0, 13, 1.5, "2", NaN].map(rowLimit => item => {item.dataFrames[0].rowLimit = rowLimit;})
    ]) reject(change);
    for (const change of [
      frame => {frame.chartType = "pie";}, frame => {frame.labelField = "__proto__";}, frame => {frame.valueField = "area\r";},
      frame => {frame.valueField = frame.labelField;},
      frame => {frame.altText = "";}, frame => {frame.altText = "x".repeat(301);}, frame => {frame.columns = ["name"];}
    ]) reject(item => {
      const frame = item.dataFrames[0];delete frame.columns;
      Object.assign(frame, {type: "chart", chartType: "line", labelField: "name", valueField: "area", altText: "Area by site."});change(frame);
    });
    const four = structuredClone(value);
    four.layouts[0].dataFrames = Array.from({length: 4}, (_, index) => ({...structuredClone(layout.dataFrames[0]), id: `table-${index}`}));
    assert.deepEqual(validateProjectPrintLayouts(four, map), four);
    const five = structuredClone(four);five.layouts[0].dataFrames.push({...structuredClone(layout.dataFrames[0]), id: "table-5"});
    assert.throws(() => validateProjectPrintLayouts(five, map), /up to four data frames/);
    reject(item => {item.frames.push({...structuredClone(item.frames[0]), id: "inset", parentId: "main"}, {...structuredClone(item.frames[0]), id: "third", parentId: "main"});}, /one main map and one inset/);
    reject((_item, collection) => {collection.layouts = Array.from({length: 9}, (_, index) => ({...structuredClone(layout), id: `layout-${index}`}));}, /unsupported format/);
    reject((_item, collection) => {collection.layouts = Array.from({length: 6}, (_, index) => ({...structuredClone(layout), id: `layout-${index}`, caption: "水".repeat(2000)}));}, /32 KiB/);
  });

  it("moves resizes aligns and snaps print data frames with map peers while preserving source and capture inputs", () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "data-geometry");
    layout.dataFrames = [{id: "table", type: "table", title: "Areas", xMm: 240, yMm: 30, widthMm: 40, heightMm: 30,
      mapFrameId: "main", source: {layerId: "wetlands", datasetId: map.definition.layers[0].datasetId, datasetVersionId: null, sourceVersion: 2}, rowLimit: 12, columns: ["name", "area"]},
    {id: "chart", type: "chart", title: "Area chart", xMm: 80, yMm: 70, widthMm: 60, heightMm: 40,
      mapFrameId: "main", source: {layerId: "wetlands", datasetId: map.definition.layers[0].datasetId, datasetVersionId: null, sourceVersion: 2}, rowLimit: 12,
      chartType: "bar", labelField: "name", valueField: "area", altText: "Area by site."}];
    const original = structuredClone(layout), signature = canonicalJson({view: layout.frames[0].view, presentation: layout.frames[0].presentation});
    assert.deepEqual(movePrintFrame(layout, "table", {xMm: 999, yMm: -5}), {xMm: 257, yMm: 0, snapLines: []});
    assert.deepEqual(resizePrintFrame(layout, "table", {widthMm: 1, heightMm: 1}), {widthMm: 20, heightMm: 20, snapLines: []});
    assert.deepEqual(resizePrintFrame(layout, "table", {widthMm: 999, heightMm: 999}), {widthMm: 57, heightMm: 180, snapLines: []});
    assert.deepEqual(alignPrintFrame(layout, "table", "right"), {xMm: 247, yMm: 30});
    assert.deepEqual(alignPrintFrame(layout, "chart", "middle"), {xMm: 80, yMm: 85});
    assert.equal(movePrintFrame(layout, "chart", {xMm: 180.4, yMm: 70, snap: true}).xMm, 180, "data peers supply snap targets");
    assert.equal(movePrintFrame(layout, "main", {xMm: 25.4, yMm: 27, snap: true}).xMm, 25, "map frames snap to data frames");
    assert.equal(movePrintFrame(layout, "table", {xMm: 225.4, yMm: 30, snap: true}).xMm, 225, "data frames snap to map frames");
    assert.equal(resizePrintFrame(layout, "chart", {widthMm: 159.6, heightMm: 40, snap: true}).widthMm, 160, "data resizing snaps to a peer edge");
    assert.equal(movePrintFrame(layout, "chart", {xMm: 180.4, yMm: 70, snap: false}).xMm, 180.4);
    assert.equal(resizePrintFrame(layout, "main", {widthMm: 1, heightMm: 1}).widthMm, 10, "legacy map minimum remains 10 mm");
    assert.throws(() => resizePrintFrame(layout, "table", {widthMm: NaN, heightMm: 50}), /finite numbers/);
    assert.throws(() => movePrintFrame(layout, "missing", {xMm: 1, yMm: 1}), /existing print frame/);
    assert.deepEqual(layout, original);
    assert.equal(canonicalJson({view: layout.frames[0].view, presentation: layout.frames[0].presentation}), signature);
  });

  it("captures and explicitly saves/reopens main and inset layouts without changing canonical Layer styling", async () => {
    let map = printProjectFixture(), writes = 0;
    const adapter = {organizationProvider: async () => IDS.organization, updateMap: async (project, id, payload) => {
      writes++;assert.equal(project, IDS.project);assert.equal(id, map.id);assert.equal(payload.expectedVersion, map.version);
      assert.deepEqual(payload.changes.definition.layers, map.definition.layers);
      map = {...map, version: map.version + 1, definition: payload.changes.definition};return structuredClone(map);
    }};
    const makeWorkbench = frame => {
      const workbench = document.createElement("section");
      const definition = frame ? definitionForPrintFrame(map, frame) : map.definition;
      workbench.getPrintContext = () => ({layers: definition.layers, view: frame?.view ?? map.definition.mapViews[0]});return workbench;
    };
    let testCamera = null;
    const capture = async context => {
      const selected = testCamera ?? context.view;
      const view = {center: [...selected.center], zoom: selected.zoom, pitch: selected.pitch, bearing: selected.bearing};
      const presentation = context.layers.map(printLayerPresentation);
      return {...printCaptureFixture(map), view, presentation, signature: canonicalJson({view, presentation})};
    };
    const root = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: makeWorkbench(), editFrame: makeWorkbench, canSave: true, captureMap: capture});document.body.append(root);
    const click = async title => {const button = [...root.querySelectorAll("button")].find(node => node.textContent === title);assert.ok(button, title);await button.onclick();};
    assert.equal(writes, 0);assert.equal(root.hasUnsavedChanges(), false);assert.doesNotMatch(root.textContent, /Open Publishing/);
    await click("Capture map frame");await click("Add inset map");await click("Edit selected map frame");await click("Capture map frame");
    testCamera = {center: [85, 28], zoom: 8, pitch: 0, bearing: 0};await click("Capture map frame");
    await click("Undo layout change");await click("Download paper SVG");assert.match(root.textContent, /Capture every map frame/);
    const frameChoice = root.querySelector('[aria-label="Map frame"]');frameChoice.value = "inset";frameChoice.dispatchEvent(new harness.dom.window.Event("change"));
    testCamera = null;await click("Edit selected map frame");await click("Capture map frame");
    await click("Save layout");assert.equal(writes, 1);assert.equal(root.hasUnsavedChanges(), false);
    const saved = projectPrintLayouts(map);assert.equal(saved.layouts[0].frames.length, 2);
    assert.equal(saved.layouts[0].frames[1].parentId, "main");assert.notEqual(saved.layouts[0].frames[0].view.zoom, saved.layouts[0].frames[1].view.zoom);
    assert.doesNotMatch(JSON.stringify(saved), /data:image|base64|https:/);
    for (const [label, value] of [["Page width (mm)", "320"], ["Page height (mm)", "240"], ["Orientation", "portrait"]]) {
      const input = root.querySelector(`[aria-label="${label}"]`);input.value = value;input.dispatchEvent(new harness.dom.window.Event("change"));
    }
    assert.equal(root.querySelector('[aria-label="Paper size"]').value, "Custom");
    assert.equal(root.querySelector('[aria-label="Page width (mm)"]').value, "240");
    assert.equal(root.querySelector('[aria-label="Page height (mm)"]').value, "320");
    const title = root.querySelector('[aria-label="Layout title"]');title.value = "Retained layout draft";title.dispatchEvent(new harness.dom.window.Event("change"));
    adapter.updateMap = async () => {throw Object.assign(Error("conflict"), {status: 409});};await click("Save layout");
    assert.equal(root.hasUnsavedChanges(), true);assert.match(root.textContent, /Project changed/);assert.equal(root.querySelector('[aria-label="Layout title"]').value, "Retained layout draft");
    let opened;
    const reopened = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: makeWorkbench(saved.layouts[0].frames[0]), editFrame: frame => {opened = frame;return makeWorkbench(frame);}, canSave: true});document.body.append(reopened);
    assert.equal(reopened.querySelector('[aria-label="Layout title"]').value, saved.layouts[0].title);
    await [...reopened.querySelectorAll("button")].find(node => node.textContent === "Edit selected map frame").onclick();
    assert.deepEqual(opened, saved.layouts[0].frames[0]);root.dispose();reopened.dispose();
  });

  it("uses one rendered state for pixels/camera and a local scale sample at world zoom", async () => {
    const mapRecord = printProjectFixture();let render, camera = [0, 0], calls = 0;
    mapRecord.definition.layers[0].style = {circleColor: "#06b6d4"};
    mapRecord.definition.layers[0].attribution = "Original survey credit";
    mapRecord.definition.layers[0].metadata = {curated: {attribution: "Reviewed survey credit"}};
    const map = {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
      getCanvas: () => ({width: 512, height: 256, clientWidth: 128, clientHeight: 64, toDataURL: () => "data:image/png;base64,aW1hZ2U="}),
      getCenter: () => ({lng: camera[0], lat: camera[1]}), getZoom: () => -2, getPitch: () => 0, getBearing: () => 0,
      getProjection: () => ({type: "mercator"}), getBounds: () => ({toArray: () => [[-180, -80], [180, 80]]}),
      getStyle: () => ({layers: [{id: "wetland-paint", type: "circle", paint: {"circle-color": ["case", ["has", "hover"], "#fff", "#06b6d4"]}}]}),
      project: ([lng, lat]) => ({x: (lng + 180) / 360 * 128, y: (80 - lat) / 160 * 64}),
      unproject: ([x]) => ({lng: ((x / 128 * 360 + 180) % 360) - 180, lat: 0}),
      once: (_event, callback) => {render = callback;}, triggerRepaint: () => {camera = [5, 0];calls++;render();}};
    const captured = await capturePrintMap({map, renderer: "maplibre", ready: true, project: mapRecord.definition,
      layers: mapRecord.definition.layers, handles: new Map([["wetlands", {layerIds: ["wetland-paint"]}]]), basemap: {attribution: "Basemap credit"}}, mapRecord);
    assert.deepEqual(captured.view.center, [5, 0]);assert.equal(calls, 1);
    assert.ok(Math.abs(captured.metresPerPixel - 2 * Math.PI * 6371008.8 / 128) < 0.1);
    assert.match(captured.imageSha256, /^[a-f0-9]{64}$/);
    assert.equal(captured.legend[0].color, "#06b6d4");
    assert(captured.attribution.includes("Original survey credit"));assert(captured.attribution.includes("Reviewed survey credit"));
    const layout = newProjectPrintLayout(mapRecord, "layout-one");layout.graticule = true;layout.sourceNotes = false;
    layout.frames[0].view = captured.view;layout.frames[0].presentation = captured.presentation;
    const svg = printPageSvg(layout, new Map([["layout-one:main", captured]]), "layout-one");
    assert.match(svg.textContent, /Basemap credit/);assert.equal(svg.getAttribute("width"), "297mm");
    assert.ok(svg.getElementsByTagNameNS("http://www.w3.org/2000/svg", "clipPath").length);assert.ok(svg.querySelector('g[clip-path] polyline'));
    assert.equal(svg.querySelector("image").getAttribute("width"), "215");
  });

  it("keeps print editor units and aids local while inch edits save millimeter geometry and retain captures", async () => {
    let map = printProjectFixture(), writes = 0;
    const original = newProjectPrintLayout(map, "physical-layout");
    Object.assign(original.frames[0], {xMm: 10.12345, widthMm: 200.12345});
    map.definition = definitionWithPrintLayouts(map, {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [original]});
    const canonical = structuredClone(map.definition), captured = printCaptureFixture(map);
    const adapter = {organizationProvider: async () => IDS.organization, updateMap: async (_project, _id, {changes}) => {
      writes++;map = {...map, version: map.version + 1, definition: changes.definition};return structuredClone(map);
    }};
    const workbench = document.createElement("section");workbench.getPrintContext = () => ({layers: map.definition.layers});
    const root = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench, canSave: true, captureMap: async () => captured});document.body.append(root);
    for (const units of ["in", "mm", "in", "mm"]) changePrintField(root, "Layout units", units);
    assert.equal(root.hasUnsavedChanges(), false);assert.equal(writes, 0);
    assert.equal(root.querySelector('[aria-label="Frame left (mm)"]').value, "10.12345");
    await findButton(root, "Save layout").onclick();
    assert.deepEqual(projectPrintLayouts(map).layouts[0], original);

    await findButton(root, "Capture map frame").onclick();
    changePrintField(root, "Layout units", "in");changePrintField(root, "Frame width (in)", "8.125");
    assert.equal(root.querySelector('.print-stage image'), null, "physical resizing requires a new output-sized capture");
    await findButton(root, "Capture map frame").onclick();
    changePrintField(root, "Frame left (in)", "0.5");
    assert.ok(root.querySelector('.print-stage image'), "moving a frame retains its unchanged sizing/view/presentation capture");
    assert.equal(root.querySelectorAll(".print-ruler").length, 2);
    assert.ok(root.querySelector("[data-print-editing-aids]"));
    await findButton(root, "Save layout").onclick();
    const saved = projectPrintLayouts(map), frame = saved.layouts[0].frames[0];
    assert.equal(writes, 2);assert.equal(frame.xMm, 12.7);assert.equal(frame.widthMm, 206.375);
    assert.deepEqual(frame.view, original.frames[0].view);assert.deepEqual(frame.presentation, original.frames[0].presentation);
    assert.deepEqual(map.definition.layers, canonical.layers);assert.deepEqual(map.definition.mapViews, canonical.mapViews);
    assert.deepEqual(map.definition.extensions.kept, canonical.extensions.kept);
    assert.doesNotMatch(JSON.stringify(saved), /units|ruler|snap|editing|guides|data:image/);
    const exported = printPageSvg(saved.layouts[0], new Map([["physical-layout:main", captured]]), "physical-layout");
    assert.ok(exported.querySelector("image"));
    assert.equal(exported.querySelector("[data-print-editing-aids], [data-print-frame], [tabindex], .print-ruler, .print-snap-line"), null);
    assert.deepEqual(JSON.parse(exported.querySelector("metadata").textContent).layout, saved.layouts[0]);
    assert.equal(exported.querySelector('[stroke-dasharray="2 2"]'), null, "page margin guides are excluded from export");
    root.dispose();
  });

  it("commits one print pointer gesture with snapped bounded geometry and restores canceled drafts and selected-frame history", async () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "pointer-layout");
    layout.frames[0].xMm = 9.5;
    layout.frames.push({...structuredClone(layout.frames[0]), id: "inset", parentId: "main", title: "Inset map", xMm: 165, yMm: 35, widthMm: 40, heightMm: 40});
    map.definition = definitionWithPrintLayouts(map, {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]});
    let writes = 0;
    const root = ProjectPrintEditor({state: {adapter: {updateMap: async () => {writes++;}}, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: document.createElement("section"), canSave: true});document.body.append(root);
    const stage = root.querySelector(".print-stage"), outline = () => stage.querySelector('[data-print-frame="inset"]:not([data-print-resize])');
    const position = () => ["x", "y"].map(name => Number(outline().getAttribute(name)));
    stage.querySelector("svg").getBoundingClientRect = () => ({left: 0, top: 0, width: 594, height: 420});
    printPointer(stage, "pointerdown", stage.querySelector('[data-print-frame="main"]'));
    printPointer(stage, "pointerup", stage);
    assert.equal(Number(stage.querySelector('[data-print-frame="main"]').getAttribute("x")), 9.5);
    assert.equal(root.hasUnsavedChanges(), false, "click-only selection does not snap a nearby edge or dirty the layout");
    const begin = () => {
      stage.querySelector("svg").getBoundingClientRect = () => ({left: 0, top: 0, width: 594, height: 420});
      printPointer(stage, "pointerdown", outline(), {clientX: 330, clientY: 70});
    };
    begin();
    printPointer(stage, "pointermove", stage, {clientX: 1130, clientY: -330});
    assert.deepEqual(position(), [257, 0]);assert.ok(stage.querySelector(".print-snap-line"));
    printPointer(stage, "pointermove", stage, {clientX: 21.6, clientY: 21});
    assert.deepEqual(position(), [10, 10]);
    printPointer(stage, "pointerup", stage, {clientX: 21.6, clientY: 21});
    assert.equal(root.querySelector('[aria-label="Map frame"]').value, "inset");
    await findButton(root, "Undo layout change").onclick();
    assert.deepEqual(position(), [165, 35]);assert.equal(findButton(root, "Undo layout change").disabled, true, "all pointer moves form one undo entry");
    assert.equal(outline().getAttribute("aria-pressed"), "true");
    await findButton(root, "Redo layout change").onclick();assert.deepEqual(position(), [10, 10]);
    assert.equal(root.querySelector('[aria-label="Map frame"]').value, "inset");
    begin();printPointer(stage, "pointermove", stage, {clientX: 410, clientY: 150, altKey: true});
    assert.deepEqual(position(), [50, 50]);
    stage.dispatchEvent(new harness.dom.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    assert.deepEqual(position(), [10, 10]);assert.match(root.textContent, /Frame adjustment canceled/);
    begin();printPointer(stage, "pointermove", stage, {clientX: 410, clientY: 150, altKey: true});
    printPointer(stage, "pointercancel", stage);assert.deepEqual(position(), [10, 10]);
    await findButton(root, "Undo layout change").onclick();
    assert.deepEqual(position(), [165, 35]);assert.equal(findButton(root, "Undo layout change").disabled, true);
    assert.equal(root.querySelector('[aria-label="Map frame"]').value, "inset");assert.equal(writes, 0);
    stage.querySelector("svg").getBoundingClientRect = () => ({left: 0, top: 0, width: 594, height: 420});
    printPointer(stage, "pointerdown", stage.querySelector("[data-print-resize]"));
    printPointer(stage, "pointermove", stage, {clientX: 1000, clientY: 1000});
    assert.ok(outline(), stage.textContent);
    assert.equal(Number(outline().getAttribute("width")), 132);assert.equal(Number(outline().getAttribute("height")), 175);
    const fullPageLayout = JSON.parse(stage.querySelector("svg > metadata").textContent).layout;
    assert.throws(() => printPageSvg(fullPageLayout, new Map([[`${fullPageLayout.id}:inset`, printCaptureFixture(map)]]), fullPageLayout.id), /Source notes need more page space/);
    printPointer(stage, "pointermove", stage, {clientX: -1000, clientY: -1000});
    printPointer(stage, "pointerup", stage, {clientX: -1000, clientY: -1000});
    assert.deepEqual(position(), [165, 35]);assert.equal(Number(outline().getAttribute("width")), 10);assert.equal(Number(outline().getAttribute("height")), 10);
    await findButton(root, "Undo layout change").onclick();
    assert.equal(Number(outline().getAttribute("width")), 40);assert.equal(Number(outline().getAttribute("height")), 40);
    assert.equal(findButton(root, "Undo layout change").disabled, true, "a resize gesture has one history entry");
    root.dispose();
  });

  it("scopes print keyboard edits and blocks writes and gestures during busy or unconfirmed saves", async () => {
    let map = printProjectFixture(), writes = 0, releaseSave;
    const gate = new Promise(resolve => {releaseSave = resolve;});
    const adapter = {organizationProvider: async () => IDS.organization, updateMap: async (_project, _id, {changes}) => {
      writes++;await gate;map = {...map, version: map.version + 1, definition: changes.definition};return structuredClone(map);
    }};
    const root = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: document.createElement("section"), canSave: true});document.body.append(root);
    const stage = root.querySelector(".print-stage"), outline = () => stage.querySelector(".print-frame-outline"), handle = () => stage.querySelector("[data-print-resize]");
    const field = label => Number(root.querySelector(`[aria-label="${label} (mm)"]`).value);
    changePrintField(root, "Frame width (mm)", "-5");
    assert.equal(root.hasUnsavedChanges(), false);assert.equal(Number(outline().getAttribute("width")), 215);assert.equal(writes, 0);
    const key = (target, value, modifiers = {}) => {
      const event = new harness.dom.window.KeyboardEvent("keydown", {key: value, bubbles: true, cancelable: true, ...modifiers});
      target.dispatchEvent(event);return event;
    };
    key(outline(), "ArrowRight");key(outline(), "ArrowDown", {shiftKey: true});key(outline(), "ArrowRight", {altKey: true});
    assert.equal(field("Frame left"), 11.1);assert.equal(field("Frame top"), 37);
    handle().focus();key(handle(), "ArrowLeft", {altKey: true});
    assert.equal(field("Frame width"), 214.9);assert.equal(document.activeElement, handle(), "keyboard resize retains handle focus after rendering");
    const outsideUndo = key(root.querySelector('[aria-label="Layout title"]'), "z", {ctrlKey: true});
    assert.equal(outsideUndo.defaultPrevented, false);assert.equal(field("Frame width"), 214.9);
    key(stage, "z", {ctrlKey: true});assert.equal(field("Frame width"), 215);
    key(stage, "z", {ctrlKey: true, shiftKey: true});assert.equal(field("Frame width"), 214.9);
    const saving = findButton(root, "Save layout").onclick();await waitFor(() => findButton(root, "Save layout").disabled);
    key(outline(), "ArrowRight");
    stage.querySelector("svg").getBoundingClientRect = () => ({left: 0, top: 0, width: 594, height: 420});
    printPointer(stage, "pointerdown", outline());printPointer(stage, "pointermove", stage, {clientX: 100, clientY: 100});printPointer(stage, "pointerup", stage, {clientX: 100, clientY: 100});
    await findButton(root, "Save layout").onclick();assert.equal(writes, 1);assert.equal(field("Frame left"), 11.1);
    releaseSave();await saving;assert.equal(root.hasUnsavedChanges(), false);
    key(outline(), "ArrowRight");adapter.updateMap = async () => {writes++;throw Error("save response interrupted");};
    await findButton(root, "Save layout").onclick();assert.match(root.textContent, /save could not be confirmed/);
    assert.equal(findButton(root, "Save layout").disabled, true);
    key(outline(), "ArrowRight");key(stage, "z", {ctrlKey: true});
    stage.querySelector("svg").getBoundingClientRect = () => ({left: 0, top: 0, width: 594, height: 420});
    printPointer(stage, "pointerdown", outline());printPointer(stage, "pointermove", stage, {clientX: 100, clientY: 100});printPointer(stage, "pointerup", stage, {clientX: 100, clientY: 100});
    await findButton(root, "Save layout").onclick();assert.equal(field("Frame left"), 12.1);assert.equal(writes, 2);
    const readonly = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: document.createElement("section"), canSave: false});document.body.append(readonly);
    key(readonly.querySelector(".print-frame-outline"), "ArrowRight");
    assert.equal(readonly.hasUnsavedChanges(), true);await findButton(readonly, "Save layout").onclick();assert.equal(writes, 2);
    root.dispose();readonly.dispose();
  });

  it("keeps the legacy Print URL useful through deliberate exact-map choices", async () => {
    const map = printProjectFixture();let requests = 0;
    const studio = ProjectPrintStudio({state: {project: {id: IDS.project}, organization: {id: IDS.organization}, maps: [], sites: [],
      adapter: {organizationProvider: async () => IDS.organization, listMaps: async (id, page) => {requests++;assert.equal(id, IDS.project);assert.equal(page.limit, 50);return [map];}}}});
    document.body.append(studio);assert.equal(requests, 0);assert.doesNotMatch(studio.textContent, /Open Publishing/);
    await [...studio.querySelectorAll("button")].find(button => button.textContent === "Load map Projects").onclick();
    const link = [...studio.querySelectorAll("a")].find(node => node.textContent === map.name);
    assert.equal(new URL(link.href).searchParams.get("composition"), map.id);assert.equal(new URL(link.href).searchParams.get("manage"), "print");
    assert.equal(requests, 1);studio.dispose();
  });
  it("links a zero-map publication project to its publication workspace", async () => {
    const calls = [];
    const adapter = publicationAdapter(calls);
    const page = ProjectWorkspacePage({adapter, projectId: IDS.project});
    document.body.append(page);

    const panel = await waitFor(() => page.querySelector('[data-project-use="publication"]'));
    assert.equal(panel.querySelector("h2")?.textContent, "Publication project");
    assert.match(panel.textContent, /Open Publishing to manage its source and sites/);
    assert.doesNotMatch(panel.textContent, /workspace is below/);
    const publishing = [...panel.querySelectorAll("a")]
      .find(({textContent}) => textContent === "Open publication workspace");
    assert.ok(publishing);
    assert.equal(
      publishing.getAttribute("href"),
      `/workspaces?project=${IDS.project}&manage=publishing#project-publishing`
    );
    assert.equal(calls.includes("sites"), true);
    assert.equal(calls.includes("source-projects"), true);
  });

  it("carries an exact resource target through the project publishing route", async () => {
    const calls = [];
    const target = {
      id: "90000000-0000-4000-8000-000000000090",
      slug: "research-map",
      title: "Research map",
      kind: "map",
      versionNumber: 3
    };
    const adapter = publicationAdapter(calls);
    adapter.listResources = async () => [target];
    adapter.listSites = async () => [];
    adapter.listObservableSourceProjects = async () => [];
    adapter.createSite = async () => {};
    const page = ProjectWorkspacePage({
      adapter,
      projectId: IDS.project,
      managementTarget: "publishing",
      siteResourceTarget: {resourceId: target.id, resourceVersion: 3}
    });
    document.body.append(page);

    const notice = await waitFor(() => page.querySelector(".project-resource-handoff"));
    assert.equal(notice.dataset.state, "ready");
    assert.equal(page.querySelector("#project-sites")?.classList.contains("project-route-target"), true);
    assert.equal(page.querySelector('[aria-label="Include Research map"]').checked, true);
  });

  it("renders flat and nested print settings used by persisted site revisions", () => {
    const state = {
      organization: {id: IDS.organization},
      project: {id: IDS.project},
      adapter: {},
      sites: [
        printSite("flat", "Flat settings", {
          printPageSize: "a3",
          printOrientation: "landscape"
        }),
        printSite("nested", "Nested settings", {
          print: {pageSize: "Letter", orientation: "portrait"}
        }),
        printSite("legacy", "Legacy nested settings", {
          printSettings: {printPageSize: "legal", printOrientation: "landscape"}
        })
      ]
    };

    const studio = ProjectPrintStudio({state});
    const cards = [...studio.querySelectorAll(".project-print-card")];

    assert.equal(cards.length, 3);
    assert.match(cards[0].textContent, /a3 · landscape · 1 page/);
    assert.match(cards[1].textContent, /Letter · portrait · 1 page/);
    assert.match(cards[2].textContent, /legal · landscape · 1 page/);
  });

  it("keeps primary print links direct and page downloads within each published site", () => {
    const published = {...printSite("atlas", "Atlas", {}), activeEdition: {id: "edition-1"}};
    const draft = printSite("draft", "Draft", {});
    const paths = (...parts) => `/${parts.join("/")}`;
    const studio = ProjectPrintStudio({state: {
      organization: {id: IDS.organization},
      project: {id: IDS.project},
      sites: [published, draft],
      adapter: {
        publicSitePrintUrl: (...parts) => `${paths(...parts)}/print.pdf`,
        publicSiteUrl: paths,
        publicSitePagePngUrl: (...parts) => `${paths(...parts)}.png`
      }
    }});
    const cards = [...studio.querySelectorAll(".project-print-card")];
    const direct = [...cards[0].querySelectorAll(".project-site-actions > a")]
      .filter((link) => !link.closest(".project-site-downloads"));
    assert.deepEqual(direct.map(({textContent}) => textContent), ["Open print PDF", "Open published site"]);
    const downloads = cards[0].querySelector("details");
    assert.equal(downloads.open, false);
    assert.equal(downloads.querySelector("summary").textContent, "Downloads");
    const png = downloads.querySelector("a");
    assert.equal(png.textContent, "PNG · Home");
    assert.equal(png.getAttribute("href"), `/${IDS.organization}/${IDS.project}/atlas/home.png`);
    assert.equal(png.getAttribute("rel"), "noopener noreferrer");
    assert.equal(cards[1].querySelector("details, .project-site-actions a"), null);
  });

  it("configures the next sealed edition without conflating authoring access", async () => {
    const calls = [];
    let refreshCount = 0;
    const site = printSite("research-atlas", "Research atlas", {});
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "Research atlas",
          description: "A governed publication",
          callerRole: "owner"
        },
        adapter: {
          listSites() {},
          createSite() {},
          async configureSitePublicationDestination(projectId, siteId, update) {
            calls.push({projectId, siteId, update});
          }
        },
        sites: [site],
        resources: []
      },
      refresh: async () => { refreshCount += 1; }
    });
    document.body.append(surface);

    const details = surface.querySelector(".project-site-destination");
    details.open = true;
    const reach = details.querySelector("select");
    const path = details.querySelector('input:not([type="checkbox"])');
    const primary = details.querySelector('input[type="checkbox"]');
    reach.value = "listed";
    reach.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    path.value = "Research Atlas 2026";
    primary.checked = true;
    [...details.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Save destination")
      .click();

    await waitFor(() => calls.length === 1);
    assert.deepEqual(calls[0], {
      projectId: IDS.project,
      siteId: "site-research-atlas",
      update: {
        expectedRevision: 1,
        reach: "listed",
        listedSlug: "research-atlas-2026",
        isPrimary: true
      }
    });
    assert.equal(refreshCount, 1);
    assert.match(
      details.textContent,
      /Authoring access remains private.*next sealed edition/
    );
  });

  it("imports one bounded GeoMoose layout into the governed site print editor", async () => {
    const map = {
      id: "60000000-0000-4000-8000-000000000001",
      slug: "massgis-map",
      title: "MassGIS review",
      kind: "map",
      versionNumber: 3
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "MassGIS",
          description: "Reviewed map site",
          callerRole: "owner"
        },
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: [map]
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    assert.match(surface.textContent, /Import GeoMoose print layout/);
    const layout = {
      label: "letter-landscape",
      orientation: "landscape",
      page: "letter",
      units: "in",
      elements: [
        {type: "text", size: 18, fontStyle: "bold", x: 0.5, y: 0.7, text: "{{title}}"},
        {type: "map", x: 0.5, y: 0.75, width: 10, height: 7},
        {type: "rect", x: 0.5, y: 0.75, width: 10, height: 7, strokeWidth: 0.01}
      ]
    };
    const serialized = JSON.stringify(layout);
    const file = surface.querySelector('.project-positioned-layout input[type="file"]');
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [{
        name: "letter-landscape.json",
        size: new TextEncoder().encode(serialized).byteLength,
        text: async () => serialized
      }]
    });
    file.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => /2\/3 elements retained/.test(surface.textContent));

    const advanced = [...surface.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Advanced layout JSON")
      ?.querySelector("textarea");
    const converted = JSON.parse(advanced.value);
    assert.equal(converted.schemaVersion, "opengeo.print-layout.1.1.0");
    assert.deepEqual(converted.pages[0].elements.map(({type}) => type), ["text", "map_frame"]);
    assert.equal(converted.pages[0].elements[1].resourceId, map.id);
    assert.match(surface.textContent, /1 omitted; 6 declared differences/);
    const pageSize = [...surface.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Print page size")
      ?.querySelector("select");
    assert.equal(pageSize.value, "letter");
  });

  it("edits a draft without silently advancing pinned pages and saves navigation order", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const {projectId} = FIXTURE_PROJECTS[0];
    const source = (await adapter.listResources(projectId))[0];
    const supporting = await adapter.createResource(projectId, {
      kind: "document",
      slug: "supporting-evidence",
      visibility: "organization",
      metadata: {
        title: "Supporting evidence",
        abstract: "Methods and supporting material",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "OpenGeo fixture research team",
        keywords: ["evidence"],
        spatialExtent: null,
        profile: "opengeo.core.v1",
        extensions: {},
        translations: {}
      },
      content: {
        blocks: [{id: "methods", type: "markdown", markdown: "# Methods"}]
      },
      provenance: {source: "studio_native_resource"}
    });
    const created = await adapter.createSite(projectId, {
      slug: "editable-research-site",
      title: "Editable research site",
      description: "Draft before review",
      language: "en",
      theme: "paper",
      themeOptions: {
        accentColor: "#176b87",
        printPageSize: "a4",
        printOrientation: "landscape",
        printLayout: "flow",
        printLegend: "true",
        printNorthArrow: "true",
        printScaleBar: "true"
      },
      printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      pages: [
        {
          slug: source.slug,
          navigationLabel: "Overview",
          resourceId: source.id,
          resourceVersion: source.versionNumber,
          isHome: true
        },
        {
          slug: supporting.slug,
          navigationLabel: "Evidence",
          resourceId: supporting.id,
          resourceVersion: supporting.versionNumber,
          isHome: false
        }
      ]
    });
    const advancedContent = structuredClone(source.content);
    advancedContent.blocks[0].markdown = `${advancedContent.blocks[0].markdown}\n\nNewer resource content.`;
    const advanced = await adapter.updateResource(projectId, source.id, {
      expectedVersion: source.versionNumber,
      visibility: source.visibility,
      metadata: {
        title: source.title,
        abstract: `${source.abstract} Updated independently.`,
        language: source.language,
        license: source.license,
        attribution: source.attribution,
        keywords: source.keywords,
        spatialExtent: source.spatialExtent,
        temporalStart: source.temporalStart,
        temporalEnd: source.temporalEnd,
        profile: source.metadataProfile,
        extensions: source.metadataExtensions,
        translations: source.translations
      },
      content: advancedContent,
      provenance: source.provenance,
      changeMessage: "Advance the resource independently of the draft site"
    });
    assert.equal(advanced.versionNumber, source.versionNumber + 1);

    let surface;
    const state = async () => ({
      organization: await adapter.getCurrentOrganization(),
      project: await adapter.getProject(projectId),
      adapter,
      sites: await adapter.listSites(projectId),
      resources: await adapter.listResources(projectId)
    });
    const refresh = async () => {
      const replacement = ProjectSites({state: await state(), refresh});
      surface.replaceWith(replacement);
      surface = replacement;
    };
    surface = ProjectSites({state: await state(), refresh});
    document.body.append(surface);

    const editor = surface.querySelector(".project-site-revision-editor");
    editor.open = true;
    const pinned = editor.querySelector(`[aria-label="${source.title} resource version"]`);
    assert.equal(pinned.value, String(source.versionNumber));
    assert.deepEqual(
      [...pinned.options].map(({textContent}) => textContent),
      [`Pinned v${source.versionNumber}`, `Current v${advanced.versionNumber}`]
    );
    const title = [...editor.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Site title")
      .querySelector("input");
    title.value = "Reviewed research atlas";
    editor.querySelector('[aria-label="Supporting evidence navigation label"]').value = "Methods";
    editor.querySelector('[aria-label="Move Supporting evidence earlier"]').click();
    findButton(editor, "Save draft revision").click();

    await waitFor(() => surface.textContent.includes("Reviewed research atlas · editable-research-site")
      || surface.querySelector("[data-revision-error]"));
    assert.equal(surface.querySelector("[data-revision-error]")?.dataset.revisionError, undefined,
      surface.textContent);
    const updated = await adapter.getSite(projectId, created.id);
    assert.equal(updated.versionNumber, 2);
    assert.equal(updated.title, "Reviewed research atlas");
    assert.deepEqual(updated.pages.map(({navigationLabel}) => navigationLabel), ["Methods", "Overview"]);
    assert.equal(updated.pages[1].resourceVersionNumber, source.versionNumber);
    assert.equal(updated.pages[1].isHome, true);
    assert.deepEqual(updated.pages[1].content, source.content);
    assert.notDeepEqual(updated.pages[1].content, advanced.content);
  });

  it("executes the fixture site journey through create, review, publish, and revoke controls", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const {projectId} = FIXTURE_PROJECTS[0];
    const resource = (await adapter.listResources(projectId))[0];
    await adapter.transitionResource(projectId, resource.id, {
      expectedVersion: resource.versionNumber,
      targetState: "published",
      visibility: "public",
      reason: "Approve the fixture publication page"
    });

    let surface;
    const state = async () => ({
      organization: await adapter.getCurrentOrganization(),
      project: await adapter.getProject(projectId),
      adapter,
      sites: await adapter.listSites(projectId),
      resources: await adapter.listResources(projectId)
    });
    const refresh = async () => {
      const replacement = ProjectSites({state: await state(), refresh});
      surface.replaceWith(replacement);
      surface = replacement;
    };
    surface = ProjectSites({state: await state(), refresh});
    document.body.append(surface);

    findButton(surface, "Create draft site").click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="draft"]')
      ?? [...surface.querySelectorAll(".project-resource-feedback")].find(
        ({textContent}) => textContent.includes("failed safely")
      ));
    assert.ok(
      surface.querySelector('.project-site-card[data-state="draft"]'),
      surface.textContent
    );
    assert.doesNotMatch(surface.textContent, /unavailable in this fixture adapter/);

    const collaborators = surface.querySelector(".project-site-collaborators");
    collaborators.open = true;
    collaborators.querySelector('[aria-label="Collaborator email"]').value = "reviewer@example.test";
    collaborators.querySelector('[aria-label="Collaborator display name"]').value = "Publication Reviewer";
    collaborators.querySelector('[aria-label="Collaborator account access"]').value = "member";
    collaborators.querySelector('[aria-label="Collaborator project role"]').value = "reviewer";
    collaborators.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );
    await waitFor(() => collaborators.dataset.state === "pending");
    const invitation = (await adapter.listInvitations()).find(
      ({email}) => email === "reviewer@example.test"
    );
    assert.equal(invitation.projectId, projectId);
    assert.equal(invitation.projectRole, "reviewer");

    let destination = surface.querySelector(".project-site-destination");
    destination.open = true;
    const reach = destination.querySelector("select");
    const path = destination.querySelector('input:not([type="checkbox"])');
    const primary = destination.querySelector('input[type="checkbox"]');
    reach.value = "listed";
    reach.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    path.value = "nepal-energy-fixture";
    primary.checked = true;
    findButton(destination, "Save destination").click();
    await waitFor(() => /Listed · account primary root/.test(surface.textContent));

    findButton(surface, "Submit revision for review").click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="review"]'));
    const publish = findButton(surface, "Publish reviewed edition");
    assert.equal(publish.disabled, false);
    publish.click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="published"]'));
    assert.match(surface.textContent, /memory-only fixture records this sealed edition/);
    assert.equal(findButton(surface, "Download portable ZIP"), null);

    findButton(surface, "Revoke public edition").click();
    await waitFor(() => !surface.textContent.includes("Revoke public edition"));
    const sites = await adapter.listSites(projectId);
    const editions = await adapter.listSiteEditions(projectId, sites[0].id);
    assert.equal(sites[0].activeEdition, null);
    assert.ok(editions[0].revokedAt);
  });

  it("shows editors a reviewer handoff instead of an unauthorized publish action", () => {
    const site = printSite("reviewed-site", "Reviewed site", {});
    site.state = "review";
    site.pages[0].resourceKind = "document";
    site.pages[0].resourceVersionNumber = 1;
    site.pages[0].resourceState = "published";
    site.pages[0].resourceVisibility = "public";
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Review", callerRole: "editor"},
        adapter: {listSites() {}, createSite() {}},
        sites: [site],
        resources: []
      },
      refresh: async () => {}
    });

    assert.match(surface.textContent, /awaiting a project owner or reviewer/);
    assert.equal(findButton(surface, "Publish reviewed edition"), null);
  });

  it("pins a targeted resource into a new site draft only after explicit creation", async () => {
    const target = {
      id: "90000000-0000-4000-8000-000000000091",
      slug: "field-observations-map",
      title: "Field observations map",
      kind: "map",
      versionNumber: 4
    };
    const other = {
      id: "90000000-0000-4000-8000-000000000092",
      slug: "project-overview",
      title: "Project overview",
      kind: "document",
      versionNumber: 2
    };
    const creations = [];
    let refreshCount = 0;
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "Field atlas",
          description: "A governed spatial publication",
          callerRole: "owner"
        },
        adapter: {
          listSites() {},
          async createSite(projectId, draft) { creations.push({projectId, draft}); }
        },
        sites: [],
        resources: [other, target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 4},
      refresh: async () => { refreshCount += 1; }
    });
    document.body.append(surface);

    assert.equal(creations.length, 0);
    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "ready");
    assert.match(surface.textContent, /Field observations map v4 is selected/);
    assert.equal(surface.querySelector('[aria-label="Include Field observations map"]').checked, true);
    assert.equal(surface.querySelector('[aria-label="Include Project overview"]').checked, false);
    assert.equal(findButton(surface, "Create draft site").disabled, false);

    findButton(surface, "Create draft site").click();
    await waitFor(() => creations.length === 1);
    assert.equal(refreshCount, 1);
    assert.deepEqual(creations[0].draft.pages, [{
      slug: target.slug,
      navigationLabel: target.title,
      resourceId: target.id,
      resourceVersion: 4,
      isHome: true
    }]);
  });

  it("prepares one explicitly selected existing draft without mutating another draft", async () => {
    const updates = [];
    const home = {
      id: "90000000-0000-4000-8000-000000000096",
      slug: "home",
      title: "Project home",
      abstract: "Home page",
      kind: "document",
      versionNumber: 1
    };
    const target = {
      id: "90000000-0000-4000-8000-000000000097",
      slug: "field-map",
      title: "Field map",
      abstract: "Exact reviewed map",
      kind: "map",
      versionNumber: 3
    };
    const alpha = draftSite(
      "70000000-0000-4000-8000-000000000096",
      "Alpha report",
      home
    );
    const beta = draftSite(
      "70000000-0000-4000-8000-000000000097",
      "Beta report",
      home
    );
    const published = draftSite(
      "70000000-0000-4000-8000-000000000099",
      "Published report",
      home
    );
    published.state = "published";
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          async updateSite(projectId, siteId, update) {
            updates.push({projectId, siteId, update});
          }
        },
        sites: [alpha, beta, published],
        resources: [home, target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 3},
      refresh: async () => {}
    });
    document.body.append(surface);
    const notice = surface.querySelector(".project-resource-handoff");
    const destination = notice.querySelector('[aria-label="Resource site destination"]');
    assert.deepEqual([...destination.options].map(({value}) => value), [
      "new",
      alpha.id,
      beta.id
    ]);
    destination.value = alpha.id;
    findButton(notice, "Prepare destination").click();

    const newEditor = surface.querySelector('[data-site-destination="new"]');
    const alphaEditor = surface.querySelector(`[data-site-destination="${alpha.id}"]`);
    const betaEditor = surface.querySelector(`[data-site-destination="${beta.id}"]`);
    assert.equal(resourceInclude(newEditor, target.id).checked, false);
    assert.equal(resourceInclude(alphaEditor, target.id).checked, true);
    assert.equal(resourceInclude(betaEditor, target.id).checked, false);
    assert.equal(alphaEditor.open, true);
    assert.equal(betaEditor.open, false);
    assert.equal(updates.length, 0, "preparing a form must not create a revision");
    assert.match(notice.textContent, /selected only in Alpha report/);

    findButton(alphaEditor, "Save draft revision").click();
    await waitFor(() => updates.length === 1);
    assert.equal(updates[0].projectId, IDS.project);
    assert.equal(updates[0].siteId, alpha.id);
    assert.equal(updates[0].update.expectedVersion, 1);
    assert.deepEqual(
      updates[0].update.pages.map(({resourceId, resourceVersion}) => ({
        resourceId,
        resourceVersion
      })),
      [
        {resourceId: home.id, resourceVersion: 1},
        {resourceId: target.id, resourceVersion: 3}
      ]
    );
  });

  it("preserves an existing page pin when the targeted resource is already in the draft", () => {
    const target = {
      id: "90000000-0000-4000-8000-000000000098",
      slug: "current-map",
      title: "Current map",
      abstract: "Current map revision",
      kind: "map",
      versionNumber: 3
    };
    const site = draftSite(
      "70000000-0000-4000-8000-000000000098",
      "Pinned report",
      target,
      {pinnedVersion: 2}
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}, updateSite() {}},
        sites: [site],
        resources: [target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 3},
      refresh: async () => {}
    });
    document.body.append(surface);
    const notice = surface.querySelector(".project-resource-handoff");
    const destination = notice.querySelector('[aria-label="Resource site destination"]');
    destination.value = site.id;
    findButton(notice, "Prepare destination").click();

    const editor = surface.querySelector(`[data-site-destination="${site.id}"]`);
    assert.equal(editor.querySelector('[aria-label="Current map resource version"]').value, "2");
    assert.match(notice.textContent, /already in this draft.*pinned version was preserved/);
  });

  it("does not substitute another page for a stale resource-to-site handoff", () => {
    const resource = {
      id: "90000000-0000-4000-8000-000000000093",
      slug: "current-map",
      title: "Current map",
      kind: "map",
      versionNumber: 5
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: [resource]
      },
      initialResourceTarget: {resourceId: resource.id, resourceVersion: 4},
      refresh: async () => {}
    });

    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "stale");
    assert.match(surface.textContent, /requested v4 was not selected/);
    assert.equal(surface.querySelector('[aria-label="Include Current map"]').checked, false);
    assert.equal(findButton(surface, "Create draft site").disabled, true);
    assert.equal(surface.querySelector('[aria-label="Resource site destination"]'), null);
  });

  it("keeps a resource-to-site handoff read-only for a project viewer", () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "viewer"},
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: []
      },
      initialResourceTarget: {
        resourceId: "90000000-0000-4000-8000-000000000094",
        resourceVersion: 1
      },
      refresh: async () => {}
    });

    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "view_only");
    assert.match(surface.textContent, /current project role cannot create or revise a site/);
    assert.equal(surface.querySelector(".project-site-editor"), null);
    assert.equal(surface.querySelector('[aria-label="Resource site destination"]'), null);
  });

  it("creates one exact project-scoped collaborator invitation for an administrator", async () => {
    const invitations = [];
    const adapter = {
      listSites() {},
      createSite() {},
      async createInvitation(draft) {
        invitations.push(draft);
        return {
          id: "70000000-0000-4000-8000-000000000095",
          email: draft.email,
          displayName: draft.displayName,
          organizationRole: draft.organizationRole,
          projectId: draft.projectId,
          projectRole: draft.projectRole,
          status: "pending"
        };
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    panel.open = true;
    assert.deepEqual(
      [...panel.querySelector('[aria-label="Collaborator account access"]').options]
        .map(({value}) => value),
      ["member", "guest"]
    );
    assert.deepEqual(
      [...panel.querySelector('[aria-label="Collaborator project role"]').options]
        .map(({value}) => value),
      ["viewer", "reviewer", "editor"]
    );
    panel.querySelector('[aria-label="Collaborator email"]').value = " New.Editor@Example.test ";
    panel.querySelector('[aria-label="Collaborator display name"]').value = "New Editor";
    panel.querySelector('[aria-label="Collaborator account access"]').value = "member";
    panel.querySelector('[aria-label="Collaborator project role"]').value = "editor";
    panel.querySelector('[aria-label="Collaborator invitation expiry"]').value = "14";
    panel.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => invitations.length === 1);
    assert.deepEqual(invitations[0], {
      email: "new.editor@example.test",
      displayName: "New Editor",
      organizationRole: "member",
      projectId: IDS.project,
      projectRole: "editor",
      expiresInDays: 14
    });
    assert.equal(panel.dataset.state, "pending");
    assert.match(panel.textContent, /Access begins only after acceptance/);
  });

  it("reports an existing pending project invitation without claiming a duplicate", async () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          async createInvitation() {
            throw Object.assign(new Error("pending"), {code: "invitation_pending"});
          }
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    panel.querySelector('[aria-label="Collaborator email"]').value = "pending@example.test";
    panel.querySelector('[aria-label="Collaborator display name"]').value = "Pending Person";
    panel.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => panel.dataset.state === "error");
    assert.match(panel.textContent, /pending invitation already exists; no duplicate was created/);
    assert.equal(findButton(panel, "Create project invitation").disabled, false);
  });

  it("gives a project owner an administrator handoff instead of a doomed invitation form", () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}, createInvitation() {}},
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });

    const panel = surface.querySelector(".project-site-collaborators");
    assert.match(panel.textContent, /organization administrator must invite a new person/);
    assert.equal(panel.querySelector("form"), null);
  });

  it("lazily manages exact project roles for existing organization members", async () => {
    const owner = fixtureMember(
      "20000000-0000-4000-8000-000000000010",
      "Project Owner",
      "owner@example.test",
      "owner"
    );
    const reviewer = fixtureMember(
      "20000000-0000-4000-8000-000000000011",
      "Project Reviewer",
      "reviewer@example.test",
      "reviewer"
    );
    const candidate = fixtureMember(
      "20000000-0000-4000-8000-000000000012",
      "Existing Member",
      "member@example.test",
      "member"
    );
    const organizationMembers = [
      {...owner, role: "member"},
      {...reviewer, role: "member"},
      candidate
    ];
    const projectMembers = [owner, reviewer];
    const calls = [];
    const adapter = {
      listSites() {},
      createSite() {},
      async listOrganizationMembers(page) {
        calls.push(["list-organization", page]);
        return structuredClone(organizationMembers);
      },
      async listProjectMembers(projectId, page) {
        calls.push(["list-project", projectId, page]);
        return structuredClone(projectMembers);
      },
      async createProjectMember(projectId, userId, role) {
        calls.push(["create", projectId, userId, role]);
        const member = organizationMembers.find((entry) => entry.userId === userId);
        projectMembers.push({...member, role});
        return {userId, role};
      },
      async updateProjectMember(projectId, userId, role) {
        calls.push(["update", projectId, userId, role]);
        projectMembers.find((entry) => entry.userId === userId).role = role;
        return {userId, role};
      },
      async revokeProjectMember(projectId, userId) {
        calls.push(["revoke", projectId, userId]);
        projectMembers.splice(projectMembers.findIndex((entry) => entry.userId === userId), 1);
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    assert.equal(calls.length, 0, "Publishing must not eagerly load membership lists");
    findButton(panel, "Load current access").click();
    const addForm = await waitFor(() => panel.querySelector('[data-purpose="existing-project-member"]'));
    assert.deepEqual(
      [...addForm.querySelector('[aria-label="Existing member project role"]').options]
        .map(({value}) => value),
      ["viewer", "reviewer", "editor"]
    );
    assert.match(panel.querySelector(`[data-member-id="${owner.userId}"]`).textContent, /Ownership is managed/);
    assert.equal(findButton(panel.querySelector(`[data-member-id="${owner.userId}"]`), "Update"), null);

    addForm.querySelector('[aria-label="Existing organization member"]').value = candidate.userId;
    addForm.querySelector('[aria-label="Existing member project role"]').value = "editor";
    addForm.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));
    await waitFor(() => calls.some(([kind]) => kind === "create"));
    assert.deepEqual(calls.find(([kind]) => kind === "create"), [
      "create",
      IDS.project,
      candidate.userId,
      "editor"
    ]);

    const reviewerRow = await waitFor(() => panel.querySelector(`[data-member-id="${reviewer.userId}"]`));
    reviewerRow.querySelector('[aria-label="Project Reviewer project role"]').value = "editor";
    findButton(reviewerRow, "Update").click();
    await waitFor(() => calls.some(([kind]) => kind === "update"));
    assert.deepEqual(calls.find(([kind]) => kind === "update"), [
      "update",
      IDS.project,
      reviewer.userId,
      "editor"
    ]);

    const candidateRow = await waitFor(() => panel.querySelector(`[data-member-id="${candidate.userId}"]`));
    findButton(candidateRow, "Remove").click();
    await waitFor(() => calls.some(([kind]) => kind === "revoke"));
    assert.deepEqual(calls.find(([kind]) => kind === "revoke"), [
      "revoke",
      IDS.project,
      candidate.userId
    ]);
  });

  it("keeps exact project invitation history and revocation in the administrator workflow", async () => {
    const exact = {
      id: "70000000-0000-4000-8000-000000000110",
      email: "pending@example.test",
      displayName: "Pending Reviewer",
      organizationRole: "member",
      projectId: IDS.project,
      projectRole: "reviewer",
      status: "pending"
    };
    const other = {...exact,
      id: "70000000-0000-4000-8000-000000000111",
      email: "other@example.test",
      projectId: "50000000-0000-4000-8000-000000000099"
    };
    const invitations = [exact, other];
    const revocations = [];
    const adapter = {
      listSites() {},
      createSite() {},
      createInvitation() {},
      listProjectMembers: async () => [],
      listOrganizationMembers: async () => [],
      listInvitations: async () => structuredClone(invitations),
      async revokeInvitation(invitationId) {
        revocations.push(invitationId);
        invitations.find(({id}) => id === invitationId).status = "revoked";
        return structuredClone(invitations.find(({id}) => id === invitationId));
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-invitation-id="${exact.id}"]`));
    assert.match(row.textContent, /Pending Reviewer.*reviewer · pending/);
    assert.doesNotMatch(panel.querySelector(".project-site-invitation-history").textContent, /other@example/);
    findButton(row, "Revoke invitation").click();
    await waitFor(() => revocations.length === 1);
    assert.deepEqual(revocations, [exact.id]);
    const final = await waitFor(() => {
      const candidate = panel.querySelector(`[data-invitation-id="${exact.id}"]`);
      return candidate?.textContent.includes("revoked") ? candidate : null;
    });
    assert.match(final.textContent, /Final/);
  });

  it("shows an editor a read-only lazy project roster without organization enumeration", async () => {
    let projectReads = 0;
    let organizationReads = 0;
    const member = fixtureMember(
      "20000000-0000-4000-8000-000000000013",
      "Read Only Reviewer",
      "readonly@example.test",
      "reviewer"
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "editor"},
        adapter: {
          listSites() {},
          createSite() {},
          async listProjectMembers() {
            projectReads += 1;
            return [member];
          },
          async listOrganizationMembers() {
            organizationReads += 1;
            return [];
          }
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-member-id="${member.userId}"]`));
    assert.equal(projectReads, 1);
    assert.equal(organizationReads, 0);
    assert.match(row.textContent, /Read only/);
    assert.equal(row.querySelector("button"), null);
    assert.equal(panel.querySelector('[data-purpose="existing-project-member"]'), null);
  });

  it("reports a rejected project role change without claiming access changed", async () => {
    const reviewer = fixtureMember(
      "20000000-0000-4000-8000-000000000014",
      "Concurrent Reviewer",
      "concurrent@example.test",
      "reviewer"
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          listProjectMembers: async () => [reviewer],
          listOrganizationMembers: async () => [{...reviewer, role: "member"}],
          async updateProjectMember() {
            throw Object.assign(new Error("conflict"), {code: "project_membership_conflict"});
          },
          revokeProjectMember() {}
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-member-id="${reviewer.userId}"]`));
    const update = findButton(row, "Update");
    update.click();
    await waitFor(() => panel.textContent.includes("project_membership_conflict"));
    assert.match(panel.textContent, /Project access was not changed/);
    assert.equal(update.disabled, false);
  });

  it("exposes API-backed public, portable, print, and revocation actions for a sealed edition", async () => {
    const calls = [];
    const site = printSite("field-atlas", "Field atlas", {});
    site.state = "published";
    site.publicationDestination = {
      ...site.publicationDestination,
      revision: 2,
      reach: "listed",
      listedSlug: "field-atlas",
      isPrimary: true
    };
    Object.assign(site.pages[0], {
      resourceId: "60000000-0000-4000-8000-000000000001",
      resourceKind: "map",
      resourceVersionNumber: 3,
      resourceState: "published",
      resourceVisibility: "public"
    });
    site.activeEdition = {
      id: "70000000-0000-4000-8000-000000000001",
      publicationReach: "listed",
      listedSlug: "field-atlas",
      unlistedToken: null,
      manifest: {
        references: [{
          resourceId: site.pages[0].resourceId,
          kind: "map",
          snapshot: {checksumSha256: "a".repeat(64)}
        }]
      }
    };
    const route = (name) => (...parts) => {
      calls.push({name, parts});
      return `/publication/${name}`;
    };
    const adapter = {
      kind: "api",
      listSites() {},
      createSite() {},
      publicSiteUrl: route("site"),
      publicSiteExportUrl: route("export"),
      publicSitePrintUrl: route("pdf"),
      publicSitePagePngUrl: route("png"),
      publicSiteMapSheetUrl: route("svg"),
      async revokeSiteEdition(projectId, siteId, editionId) {
        calls.push({name: "revoke", parts: [projectId, siteId, editionId]});
      }
    };
    let refreshCount = 0;
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter,
        sites: [site],
        resources: []
      },
      refresh: async () => { refreshCount += 1; }
    });
    const links = new Map(
      [...surface.querySelectorAll("a")].map((anchor) => [anchor.textContent, anchor])
    );

    assert.equal(links.get("Open listed site")?.getAttribute("href"), "/publication/site");
    assert.equal(links.get("Download portable ZIP")?.getAttribute("href"), "/publication/export");
    assert.equal(links.get("Download print PDF")?.getAttribute("href"), "/publication/pdf");
    assert.equal(links.get("Open whole-page PNG · Home")?.getAttribute("href"), "/publication/png");
    assert.equal(
      links.get("Open printable SVG map sheet · 60000000")?.getAttribute("href"),
      "/publication/svg"
    );
    findButton(surface, "Revoke public edition").click();
    await waitFor(() => calls.some(({name}) => name === "revoke"));
    assert.equal(refreshCount, 1);
  });
});

function findButton(root, label) {
  return [...root.querySelectorAll("button")]
    .find(({textContent}) => textContent === label) ?? null;
}

function publicationAdapter(calls) {
  const record = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  const project = {
    id: IDS.project,
    name: "Published research atlas",
    description: "Observable Framework publication without a Studio map",
    status: "active",
    visibility: "published",
    callerRole: "owner"
  };
  return {
    kind: "api",
    selectOrganization() {},
    getSession: record("session", {
      userId: IDS.user,
      displayName: "Publication owner",
      memberships: [{organizationId: IDS.organization, role: "member"}],
      selectedOrganizationId: IDS.organization
    }),
    getCurrentOrganization: record("organization", {
      id: IDS.organization,
      name: "OpenGeo.tools",
      callerRole: "member"
    }),
    listProjects: record("projects", [project]),
    getProject: record("project", project),
    listMaps: record("maps", []),
    listDatasets: record("datasets", []),
    listSources: record("sources", []),
    listSites: record("sites", [{id: "site-publication", title: "Research atlas"}]),
    listObservableSourceProjects: record("source-projects", [{
      id: "source-publication",
      name: "Research atlas source"
    }]),
    listProjectDatasetConnectionBindings: record("dataset-connections", []),
    listProjectBasemapConnectionBindings: record("basemap-connections", [])
  };
}

function printProjectFixture() {
  return {id: "70000000-0000-4000-8000-000000000001", projectId: IDS.project, name: "Regional wetland comparison", version: 3,
    definition: {schemaVersion: "opengeo.map-definition.1.3.0", projection: "mercator", spatialBody: {id: "earth"},
      extensions: {kept: {answer: 42}}, mapViews: [{center: [84, 27], zoom: 5, pitch: 0, bearing: 0}],
      layers: [{layerId: "wetlands", datasetId: "80000000-0000-4000-8000-000000000001", title: "Wetlands", sourceType: "imageserver-raster", sourceVersion: 2,
        sourceUrl: "https://example.org/ImageServer", sourceConfiguration: {}, visible: true, opacity: 1, style: {fill: "#123456"}, labels: {enabled: false}}]}};
}

function printCaptureFixture(map) {
  const view = {center: [84, 27], zoom: 5, pitch: 0, bearing: 0}, presentation = map.definition.layers.map(printLayerPresentation);
  return {dataUrl: "data:image/png;base64,aW1hZ2U=", width: 1024, height: 640, cssWidth: 512, cssHeight: 320, view, presentation,
    signature: canonicalJson({view, presentation}), legend: [{label: "Wetlands", color: "#123456"}], attribution: ["Provider credit"],
    lines: [], metresPerPixel: 100, flat: true, projectId: map.id, projectVersion: map.version, imageSha256: "a".repeat(64)};
}

function changePrintField(root, label, value) {
  const input = root.querySelector(`[aria-label="${label}"]`);assert.ok(input, label);
  input.value = value;input.dispatchEvent(new harness.dom.window.Event("change"));
}

function printPointer(stage, type, target, options = {}) {
  const event = new harness.dom.window.MouseEvent(type, {button: 0, cancelable: true, ...options});
  Object.defineProperties(event, {target: {value: target}, pointerId: {value: 7}, isPrimary: {value: true}});
  // jsdom lacks PointerEvent dispatch; exercise the installed delegated handler with a synthetic pointer identity.
  stage[`on${type}`](event);
}

function printSite(slug, title, themeOptions) {
  return {
    id: `site-${slug}`,
    slug,
    title,
    state: "draft",
    versionNumber: 1,
    themeOptions,
    pages: [{slug: "home", navigationLabel: "Home"}],
    activeEdition: null,
    publicationDestination: {
      revision: 1,
      reach: "unpublished",
      listedSlug: slug,
      isPrimary: false,
      configuredBy: IDS.user,
      configuredAt: "2026-08-30T12:00:00Z"
    }
  };
}

function draftSite(id, title, resource, {pinnedVersion = resource.versionNumber} = {}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id,
    slug,
    title,
    description: `${title} description`,
    language: "en",
    theme: "paper",
    state: "draft",
    versionNumber: 1,
    themeOptions: {
      accentColor: "#176b87",
      printPageSize: "a4",
      printOrientation: "landscape",
      printLayout: "flow"
    },
    printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
    pages: [{
      slug: resource.slug,
      navigationLabel: resource.title,
      position: 0,
      isHome: true,
      resourceId: resource.id,
      resourceTitle: resource.title,
      resourceKind: resource.kind,
      resourceVersionNumber: pinnedVersion,
      resourceState: "published",
      resourceVisibility: "public"
    }],
    activeEdition: null,
    publicationDestination: {
      revision: 1,
      reach: "unpublished",
      listedSlug: slug,
      isPrimary: false,
      configuredBy: IDS.user,
      configuredAt: "2026-09-02T12:00:00Z"
    }
  };
}

function fixtureMember(userId, displayName, email, role) {
  return {userId, displayName, email, role};
}

function resourceInclude(editor, resourceId) {
  return [...editor.querySelectorAll(".project-site-page-selector")]
    .find((row) => row.dataset.resourceId === resourceId)
    .querySelector(':scope > input[type="checkbox"]');
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for publication workspace state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}`
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}
