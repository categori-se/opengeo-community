import assert from "node:assert/strict";
import {test} from "node:test";
import {PRINT_TEMPLATE_SCHEMA, layoutFromTemplate, templateFromLayout, validatePrintTemplate} from "../src/lib/printTemplates.js";
import {PROJECT_PRINT_SCHEMA, newProjectPrintLayout, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";

const styleReference = {projectId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  styleId: "33333333-3333-4333-8333-333333333333", versionNumber: 7, checksumSha256: "a".repeat(64), format: "maplibre"};
function project(suffix = "old") {
  return {id: `project-${suffix}`, name: `Project ${suffix}`, definition: {mapViews: [{center: suffix === "old" ? [-70, 42] : [12, 34], zoom: suffix === "old" ? 7 : 4, pitch: 0, bearing: 12}],
    layers: [{layerId: `layer-${suffix}`, datasetId: `dataset-${suffix}`, datasetVersionId: `dataset-version-${suffix}`, sourceVersion: suffix === "old" ? 2 : 9,
      visible: true, opacity: 0.7, style: {type: "single", color: suffix === "old" ? "#ff0000" : "#0000ff"}, labels: {field: "name"},
      filter: ["==", ["get", "kind"], suffix], styleReference: structuredClone(styleReference), pointClustering: {enabled: false, radius: 50, maxZoom: 14}}]}};
}
function sourceLayout() {
  const map = project(), layout = newProjectPrintLayout(map, "original-layout");
  layout.title = "Original composition";layout.legendFormat = "color-bars";layout.caption = "Reusable user caption";
  layout.frames[0].id = "original-main";
  layout.frames.push({...structuredClone(layout.frames[0]), id: "original-inset", parentId: "original-main", title: "Inset", xMm: 230, yMm: 27, widthMm: 50, heightMm: 50,
    view: {center: [1, 2], zoom: 12, pitch: 0, bearing: 0}});
  const source = {layerId: "layer-old", datasetId: "dataset-old", datasetVersionId: "dataset-version-old", sourceVersion: 2};
  layout.dataFrames = [{id: "original-table", type: "table", title: "Records", xMm: 10, yMm: 110, widthMm: 80, heightMm: 40,
    mapFrameId: "original-main", source: {...source}, rowLimit: 4, columns: ["name", "value"]},
  {id: "original-chart", type: "chart", title: "Values", xMm: 100, yMm: 110, widthMm: 80, heightMm: 40,
    mapFrameId: "original-inset", source: {...source}, rowLimit: 12, chartType: "line", labelField: "name", valueField: "value", altText: "Individual recorded values"}];
  return {map, layout};
}
function fixture() {const {map, layout} = sourceLayout();return {map, layout, template: templateFromLayout(layout, "Regional sheet", "template-one")};}
function validateBound(layout, map) {
  return validateProjectPrintLayouts({schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: [layout]}, map).layouts[0];
}
function deepFreeze(value) {if (value && typeof value === "object") {Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;}

test("portable JSON transfers geometry/furniture/data slots to another Project without retaining original sources, views or presentation", () => {
  const {map, layout, template} = fixture(), original = structuredClone({map, layout});
  assert.equal(template.schemaVersion, PRINT_TEMPLATE_SCHEMA);
  assert.deepEqual(template.frames.map(frame => [frame.id, frame.parentId]), [["main", null], ["inset", "main"]]);
  assert.deepEqual(template.dataFrames.map(frame => [frame.id, frame.mapFrameId, frame.sourceSlot]), [["data-1", "main", "source-1"], ["data-2", "inset", "source-2"]]);
  const portable = JSON.stringify(template);
  for (const forbidden of ["project-old", "layer-old", "dataset-old", "dataset-version-old", "original-layout", "original-main", "original-inset", "original-table", "original-chart", "styleReference", "sourceVersion", "presentation", "view", "checksumSha256"])
    assert.ok(!portable.includes(forbidden), forbidden);
  const second = project("new"), before = structuredClone(second);
  deepFreeze(second);deepFreeze(template);
  const applied = layoutFromTemplate(JSON.parse(portable), second, "new-layout", {"source-1": "layer-new", "source-2": "layer-new"});
  assert.equal(applied.id, "new-layout");assert.equal(applied.title, "Regional sheet");
  assert.equal(applied.legendFormat, "color-bars");assert.equal(applied.caption, layout.caption);
  assert.deepEqual(applied.page, layout.page);
  for (const frame of applied.frames) {
    assert.deepEqual(frame.view, second.definition.mapViews[0]);
    assert.deepEqual(frame.presentation[0].styleReference, second.definition.layers[0].styleReference);
    assert.deepEqual(frame.presentation[0].style, second.definition.layers[0].style);
    assert.deepEqual(frame.presentation[0].filter, second.definition.layers[0].filter);
    assert.equal(frame.presentation[0].sourceVersion, 9);
  }
  for (const frame of applied.dataFrames) assert.deepEqual(frame.source, {layerId: "layer-new", datasetId: "dataset-new", datasetVersionId: "dataset-version-new", sourceVersion: 9});
  assert.deepEqual(applied.dataFrames[0].columns, ["name", "value"]);
  assert.equal(applied.dataFrames[1].chartType, "line");assert.equal(applied.dataFrames[1].altText, "Individual recorded values");
  assert.deepEqual(validateBound(applied, second), applied);
  applied.frames[0].presentation[0].style.color = "#ffffff";applied.frames[0].view.center[0] = 0;applied.dataFrames[0].columns[0] = "changed";
  assert.equal(applied.frames[1].presentation[0].style.color, "#0000ff");
  assert.deepEqual(second, before);assert.deepEqual({map, layout}, original);
  assert.deepEqual(validatePrintTemplate(JSON.parse(portable)), template);
});

test("data slots require complete explicit visible-current-Layer bindings, and reject extra or stale choices", () => {
  const {template} = fixture(), second = project("new");
  second.definition.layers.push({...structuredClone(second.definition.layers[0]), layerId: "hidden-layer", visible: false});
  for (const bindings of [undefined, {}, {"source-1": "layer-new"}, {"source-1": "layer-old", "source-2": "layer-new"},
    {"source-1": "layer-new", "source-2": "hidden-layer"}, {"source-1": "layer-new", "source-2": "layer-new", unexpected: "layer-new"}])
    assert.throws(() => layoutFromTemplate(template, second, "new-layout", bindings));
  const bound = layoutFromTemplate(template, second, "new-layout", {"source-1": "layer-new", "source-2": "layer-new"});
  assert.equal(bound.frames[0].presentation[1].visible, false);
  assert.deepEqual(validateBound(bound, second), bound);
  second.definition.layers[0].sourceVersion = 10;
  assert.throws(() => validateBound(bound, second), /source changed/);
});

test("source-free templates exclude incidental captures, rows, rights and credentials while retaining every data frame", () => {
  const {layout} = sourceLayout();
  layout.captures = {main: "data:image/png;base64,private"};layout.rows = [["secret value"]];layout.credentials = {token: "private"};
  layout.frames[0].attribution = "Actual source credits";layout.dataFrames[0].rows = [["private attribute"]];
  const template = templateFromLayout(layout, "Safe template", "safe");
  assert.equal(template.dataFrames.length, 2);
  assert.equal(template.dataFrames[0].type, "table");assert.equal(template.dataFrames[1].type, "chart");
  assert.doesNotMatch(JSON.stringify(template), /private|Actual source credits|credentials|attribution|rows|captures/);
  layout.dataFrames.push(...Array.from({length: 3}, () => structuredClone(layout.dataFrames[0])));
  assert.throws(() => templateFromLayout(layout, "Too many", "bad"));
});

test("strict template admission rejects unknown source-bearing keys, nested malicious objects and non-data properties", () => {
  const {template} = fixture();
  const changes = [value => {value.projectId = "leak";}, value => {value.schemaVersion = "unknown";}, value => {delete value.name;},
    value => {value.page.token = "private";}, value => {value.frames[0].view = {center: [0, 0]};},
    value => {value.frames[0].presentation = [];}, value => {value.dataFrames[0].source = {layerId: "leak"};},
    value => {value.dataFrames[1].rows = [["private"]];}, value => {value.dataFrames[0].columns = ["constructor"];},
    value => {value.dataFrames[0].columns = ["Name", "Name"];}, value => {value.dataFrames[1].labelField = value.dataFrames[1].valueField;},
    value => {value.dataFrames[1].chartType = "pie";}, value => {value.dataFrames[0].sourceSlot = "layer-old";},
    value => {value.frames[0].id = "layer-old";}, value => {value.frames[1].parentId = null;},
    value => {value.dataFrames[0].mapFrameId = "missing";}, value => {value.page = Object.create({widthMm: 297});},
    value => {Object.defineProperty(value.page, "size", {get() {throw Error("getter must not run");}, enumerable: true});},
    value => {Object.defineProperty(value.dataFrames[0], "type", {get() {throw Error("getter must not run");}, enumerable: true});},
    value => {value.frames[Symbol("hidden")] = true;}, value => {Object.defineProperty(value, "token", {value: "hidden"});},
    value => {value.dataFrames[0].columns = ["ok", , "value"];}, value => {value.caption = "control\u0085";}];
  for (const change of changes) {
    const value = structuredClone(template);change(value);
    assert.throws(() => validatePrintTemplate(value), error => !/getter must not run/.test(error.message));
  }
  assert.throws(() => validatePrintTemplate(JSON.parse(JSON.stringify(template).replace('"size":"A4"', '"size":"A4","__proto__":{"token":"private"}'))));
});

test("template geometry, bounded fields, paper resolution and maximum counts follow existing Print limits", () => {
  const {template} = fixture();
  const changes = [value => {value.id = " ";}, value => {value.name = "x".repeat(201);}, value => {value.caption = "x".repeat(2001);},
    value => {value.page.size = "Unsupported";}, value => {value.page.widthMm = 49;}, value => {value.page.marginMm = 60;},
    value => {value.dpi = 600;}, value => {value.page.widthMm = 1189;value.page.heightMm = 841;value.dpi = 300;},
    value => {value.frames = [];}, value => {value.frames.push(structuredClone(value.frames[1]));},
    value => {value.frames[0].widthMm = 9;}, value => {value.frames[0].xMm = NaN;}, value => {value.frames[1].xMm = 290;},
    value => {value.dataFrames[0].widthMm = 19;}, value => {value.dataFrames[0].rowLimit = 13;}, value => {value.dataFrames[0].rowLimit = 1.5;},
    value => {value.dataFrames[0].columns = Array.from({length: 5}, (_, index) => `field${index}`);},
    value => {value.dataFrames[0].columns = ["x".repeat(101)];}, value => {value.legend = "true";}, value => {value.legendFormat = "unknown";}];
  for (const change of changes) {const value = structuredClone(template);change(value);assert.throws(() => validatePrintTemplate(value));}
  const minimal = templateFromLayout(newProjectPrintLayout(project(), "simple"), "Simple", "simple-template");
  const bound = layoutFromTemplate(minimal, project("new"), "simple-layout");
  assert.ok(!Object.hasOwn(bound, "dataFrames"));assert.ok(!Object.hasOwn(bound, "legendFormat"));
  assert.deepEqual(validateBound(bound, project("new")), bound);
  const detached = validatePrintTemplate(template);detached.page.widthMm = 250;
  assert.equal(template.page.widthMm, 297);
});
