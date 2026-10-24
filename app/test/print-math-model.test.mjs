import assert from "node:assert/strict";
import {test} from "node:test";
import {layoutPrintTextFrame, PRINT_TEXT_FRAME_KEYS, validatePrintTextFrames} from "../src/lib/printTextFrames.js";
import {alignPrintFrame, definitionWithPrintLayouts, movePrintFrame, newProjectPrintLayout, projectPrintLayouts, PROJECT_PRINT_SCHEMA, resizePrintFrame, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";
import {layoutFromTemplate, templateFromLayout, validatePrintTemplate} from "../src/lib/printTemplates.js";
import {exportQgisPrintTemplate} from "../src/lib/qgisPrintTemplates.js";

const page = {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210, marginMm: 10};
const math = overrides => ({id: "equation-original", type: "math", title: "Equation", text: String.raw`\frac{a^2+b^2}{c_1} = \sqrt{d}`,
  xMm: 20, yMm: 30, widthMm: 80, heightMm: 40, fontSizePt: 10, color: "#123AbC", background: "none", alignment: "left", ...overrides});
const project = () => ({id: "project-one", name: "Map", definition: {layers: [{layerId: "layer-one", datasetId: "dataset-one", datasetVersionId: null, sourceVersion: 1}],
  mapViews: [{center: [0, 0], zoom: 2, pitch: 0, bearing: 0}]}});
function fixture() {
  const map = project(), layout = newProjectPrintLayout(map, "layout-one");
  layout.textFrames = [math(), math({id: "literal-note", type: "text", text: "Keep literal \\frac{a}{b}"})];
  layout.dataFrames = [{id: "table-original", type: "table", title: "Records", xMm: 230, yMm: 30, widthMm: 40, heightMm: 40,
    mapFrameId: "main", source: {layerId: "layer-one", datasetId: "dataset-one", datasetVersionId: null, sourceVersion: 1}, rowLimit: 2, columns: ["name"]}];
  return {map, layout, collection: {schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: [layout]}};
}

test("math uses the same closed fields and preserves literal LaTeX, LF, spaces and Unicode without mutation", () => {
  const source = "  " + String.raw`\frac{α+β}{2} < x & y` + "\n\n" + String.raw`\text{Café Ω 😀}` + "  \n";
  const value = [math({text: source})], before = structuredClone(value), ids = new Set(["main", "table-original"]);
  assert.deepEqual(Object.keys(value[0]), PRINT_TEXT_FRAME_KEYS);
  Object.freeze(value[0]);Object.freeze(value);
  const checked = validatePrintTextFrames(value, page, ids);
  assert.deepEqual(checked, before);assert.notEqual(checked, value);assert.notEqual(checked[0], value[0]);
  checked[0].text = "changed";assert.deepEqual(value, before);assert.deepEqual([...ids], ["main", "table-original"]);
  assert.equal(validatePrintTextFrames([math({text: ""})], page)[0].text, "");
});

test("math rejects extra sources, missing fields, getters, malformed arrays and unsupported controls", () => {
  const changes = [value => {value[0].sourceSlot = "source-1";}, value => {value[0].source = {url: "https://example.test"};},
    value => {value[0].latex = value[0].text;}, value => {delete value[0].alignment;}, value => {value[0].type = "latex";},
    value => {value[0] = Object.assign(Object.create({source: true}), value[0]);},
    value => {Object.defineProperty(value[0], "text", {get() {throw Error("getter executed");}, enumerable: true});},
    value => {Object.defineProperty(value[0], "hidden", {value: true});}, value => {value[0][Symbol("hidden")] = true;},
    value => {delete value[0];}, value => {value.extra = true;}, value => {value[0].title = "Two\nlines";}, value => {value[0].text = 12;}];
  for (const control of ["\u0000", "\t", "\r", "\r\n", "\u001f", "\u007f", "\u0085", "\u009f", "\u2028", "\u2029"])
    changes.push(value => {value[0].text = `a${control}b`;});
  for (const change of changes) {
    const value = [math()];change(value);
    assert.throws(() => validatePrintTextFrames(value, page), error => !/getter executed/.test(error.message));
  }
});

test("math retains the literal text bounds, combined eight-frame limit and shared identities", () => {
  const boundary = math({xMm: 287, yMm: 205, widthMm: 10, heightMm: 5, text: "x".repeat(4000), fontSizePt: 6, background: "#ABCdef"});
  assert.deepEqual(validatePrintTextFrames([boundary], page), [boundary]);
  assert.equal(validatePrintTextFrames([math({fontSizePt: 48})], page)[0].fontSizePt, 48);
  const changes = [value => {value.id = " ";}, value => {value.id = "x".repeat(101);}, value => {value.title = "x".repeat(201);},
    value => {value.text += "x";}, value => {value.fontSizePt = 5.99;}, value => {value.fontSizePt = 48.01;},
    value => {value.xMm += 0.01;}, value => {value.yMm += 0.01;}, value => {value.widthMm = 9.99;}, value => {value.heightMm = 4.99;},
    value => {value.xMm = NaN;}, value => {value.widthMm = Infinity;}, value => {value.color = "red";},
    value => {value.background = "url(#x)";}, value => {value.alignment = "justify";}];
  for (const change of changes) {const value = structuredClone(boundary);change(value);assert.throws(() => validatePrintTextFrames([value], page));}
  const eight = Array.from({length: 8}, (_, index) => math({id: `block-${index}`, type: index % 2 ? "text" : "math"}));
  assert.equal(validatePrintTextFrames(eight, page).length, 8);
  assert.throws(() => validatePrintTextFrames([...eight, math()], page), /eight.*combined/);
  assert.throws(() => validatePrintTextFrames([math(), math({type: "text"})], page), /unique/);
  for (const id of ["main", "table-original"]) assert.throws(() => validatePrintTextFrames([math({id})], page, ["main", "table-original"]), /unique/);
});

test("existing Project persistence reopens math unchanged and keeps its shared 32 KiB limit", () => {
  const {map, layout, collection} = fixture(), before = structuredClone({map, collection});
  const saved = definitionWithPrintLayouts(map, collection);
  assert.deepEqual(projectPrintLayouts({...map, definition: JSON.parse(JSON.stringify(saved))}), collection);
  assert.deepEqual({map, collection}, before);
  for (const id of [layout.frames[0].id, layout.dataFrames[0].id, layout.textFrames[1].id]) {
    const bad = structuredClone(collection);bad.layouts[0].textFrames[0].id = id;
    assert.throws(() => validateProjectPrintLayouts(bad, map), /unique/);
  }
  const tooLarge = structuredClone(collection);
  tooLarge.layouts[0].textFrames = Array.from({length: 6}, (_, index) => math({id: `math-${index}`, text: "水".repeat(2000)}));
  assert.throws(() => validateProjectPrintLayouts(tooLarge, map), /32 KiB/);
});

test("source-free JSON templates preserve mixed type, source, style and geometry with no math source slots", () => {
  const {map, layout} = fixture();
  layout.textFrames[0] = math({alignment: "right", background: "#ffffff", fontSizePt: 18});
  const before = structuredClone({map, layout}), template = templateFromLayout(layout, "Equation sheet", "template-one");
  assert.deepEqual(template.textFrames, layout.textFrames.map((frame, index) => ({...frame, id: `text-${index + 1}`})));
  assert.deepEqual(template.dataFrames.map(frame => frame.sourceSlot), ["source-1"]);
  const imported = validatePrintTemplate(JSON.parse(JSON.stringify(template)));
  const applied = layoutFromTemplate(imported, map, "applied", {"source-1": "layer-one"});
  assert.deepEqual(applied.textFrames, template.textFrames);
  assert.deepEqual(validateProjectPrintLayouts({schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: [applied]}, map).layouts[0], applied);
  applied.textFrames[0].text = "changed";assert.notEqual(template.textFrames[0].text, "changed");
  assert.deepEqual({map, layout}, before);
  const bad = structuredClone(template);bad.textFrames[0].sourceSlot = "source-2";assert.throws(() => validatePrintTemplate(bad));
  const large = structuredClone(template);
  large.textFrames = Array.from({length: 6}, (_, index) => math({id: `text-${index + 1}`, text: "水".repeat(2000)}));
  assert.throws(() => validatePrintTemplate(large), /32 KiB/);
  delete layout.dataFrames;
  const withoutSources = templateFromLayout(layout, "Equation sheet", "no-sources");
  assert.equal(Object.hasOwn(withoutSources, "dataFrames"), false);
  assert.deepEqual(layoutFromTemplate(withoutSources, map, "no-bindings").textFrames, withoutSources.textFrames);
});

test("math uses the existing move, resize, alignment and snapping geometry without changing its source", () => {
  const {layout} = fixture();layout.textFrames[0] = math({xMm: 30, yMm: 20, widthMm: 40, heightMm: 15});
  const before = structuredClone(layout);
  assert.deepEqual(resizePrintFrame(layout, "equation-original", {widthMm: 1, heightMm: 1}), {widthMm: 10, heightMm: 5, snapLines: []});
  assert.deepEqual(movePrintFrame(layout, "equation-original", {xMm: 999, yMm: -5}), {xMm: 257, yMm: 0, snapLines: []});
  assert.deepEqual(alignPrintFrame(layout, "equation-original", "right"), {xMm: 247, yMm: 20});
  assert.equal(movePrintFrame(layout, "equation-original", {xMm: 230.4, yMm: 20, snap: true}).xMm, 230);
  assert.equal(movePrintFrame(layout, "main", {xMm: 30.4, yMm: 27, snap: true}).xMm, 30);
  assert.deepEqual(layout, before);
});

test("literal line layout and QPT export explicitly refuse math while existing literal output stays usable", () => {
  let measurements = 0;
  assert.throws(() => layoutPrintTextFrame(math(), () => {measurements++;return 1;}), /real LaTeX typesetter/);
  assert.equal(measurements, 0);
  const literal = math({type: "text", text: String.raw`\frac{a}{b}`});
  assert.deepEqual(layoutPrintTextFrame(literal, text => text.length).lines.map(line => line.text), [literal.text]);
  const {layout} = fixture(), template = templateFromLayout(layout, "Equation sheet", "template-one"), before = structuredClone(template);
  assert.throws(() => exportQgisPrintTemplate(template), /math frames.*Use the JSON template.*LaTeX source/);
  assert.deepEqual(template, before);
  template.textFrames = [{...literal, id: "text-1"}];
  template.legend = false;
  assert.match(exportQgisPrintTemplate(template), /labelText="\\frac\{a\}\{b\}"/);
});
