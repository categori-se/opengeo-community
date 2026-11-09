import assert from "node:assert/strict";
import {test} from "node:test";
import {layoutPrintTextFrame, selectedFeaturePrintText, validatePrintTextFrames} from "../src/lib/printTextFrames.js";
import {alignPrintFrame, movePrintFrame, newProjectPrintLayout, PROJECT_PRINT_SCHEMA, resizePrintFrame, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";
import {layoutFromTemplate, templateFromLayout, validatePrintTemplate} from "../src/lib/printTemplates.js";

const page = {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210, marginMm: 10};
const frame = overrides => ({id: "note-original", type: "text", title: "Map note", text: "A literal note", xMm: 20, yMm: 30,
  widthMm: 80, heightMm: 40, fontSizePt: 10, color: "#123AbC", background: "none", alignment: "left", ...overrides});
const project = () => ({id: "project-one", name: "Map", definition: {layers: [{layerId: "layer-one", datasetId: "dataset-one", datasetVersionId: null, sourceVersion: 1}], mapViews: [{center: [0, 0], zoom: 2, pitch: 0, bearing: 0}]}});
function fixture() {
  const map = project(), layout = newProjectPrintLayout(map, "layout-one");
  layout.textFrames = [frame()];
  const collection = {schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: [layout]};
  return {map, layout, collection};
}
const table = () => ({id: "data-original", type: "table", title: "Records", xMm: 240, yMm: 30, widthMm: 40, heightMm: 40,
  mapFrameId: "main", source: {layerId: "layer-one", datasetId: "dataset-one", datasetVersionId: null, sourceVersion: 1}, rowLimit: 2, columns: ["name"]});

const selected = () => ({feature: {type: "Feature", id: 0, properties: {name: "Survey point", description: "An exact description."}},
  layer: {layerId: "layer-one", title: "Local survey", datasetId: "dataset-one", datasetVersionId: "version-one", sourceVersion: 0}});

test("selected descriptions snapshot only literal description, title and exact source identities without mutation", () => {
  const value = selected();
  value.feature.properties.description = '<img src="https://example.test/track" onerror="alert(1)"> &amp; <script>run()</script> javascript:run()';
  value.feature.properties.password = "never print this";value.feature.properties.token = "never print this either";
  value.layer.url = "https://example.test/?secret=never-print";
  const before = structuredClone(value);
  Object.freeze(value.feature.properties);Object.freeze(value.feature);Object.freeze(value.layer);Object.freeze(value);
  const result = selectedFeaturePrintText(value);
  assert.deepEqual(result, {title: "Survey point", text: `Survey point\n\n${value.feature.properties.description}\n\nLayer: Local survey\nLayer ID: layer-one\nDataset ID: dataset-one\nDataset version ID: version-one\nSource revision: 0\nFeature ID: 0`});
  assert.doesNotMatch(result.text, /never print|never-print|password|token/);
  const checked = validatePrintTextFrames([frame({...result, widthMm: 270, heightMm: 180, fontSizePt: 6})], page);
  assert.equal(checked[0].text, result.text);
  assert.equal(layoutPrintTextFrame(checked[0], () => 1).lines[2].text, value.feature.properties.description);
  result.text = "independent draft";assert.deepEqual(value, before);
});

test("selected descriptions preserve Unicode and blank lines with explicit LF and four-space tab normalization", () => {
  const value = selected();value.feature.properties.name = "Café 水 😀";
  value.feature.properties.description = "  First\r\n\r\nΩ\t水\rЖ 😀  \n";
  const before = structuredClone(value), result = selectedFeaturePrintText(value);
  assert.equal(result.title, "Café 水 😀");
  assert.ok(result.text.startsWith("Café 水 😀\n\n  First\n\nΩ    水\nЖ 😀  \n\n\nLayer:"));
  assert.doesNotMatch(result.text, /[\r\t]/);assert.deepEqual(value, before);
  assert.equal(validatePrintTextFrames([frame(result)], page)[0].text, result.text);
});

test("description fallback is exact, absent identities remain absent, and numeric zero is retained", () => {
  const value = selected();delete value.feature.properties.description;
  value.feature.properties.Description = "Uppercase source field";delete value.feature.properties.name;
  value.feature.properties.title = "Title fallback";
  assert.equal(selectedFeaturePrintText(value).title, "Title fallback");
  delete value.feature.properties.title;
  assert.equal(selectedFeaturePrintText(value).title, "Feature 0");
  delete value.feature.id;value.layer = {layerId: "layer-one", title: "Local survey"};
  assert.deepEqual(selectedFeaturePrintText(value), {title: "Selected feature", text: "Selected feature\n\nUppercase source field\n\nLayer: Local survey\nLayer ID: layer-one"});
  for (const bad of [undefined, null, "", " \n ", 12, false, {toString() {throw Error("coercion executed");}}]) {
    value.feature.properties.description = bad;
    assert.throws(() => selectedFeaturePrintText(value), error => /nonempty text description/.test(error.message) && !/coercion executed/.test(error.message));
  }
});

test("selected description limits include source lines and reject oversized text or titles without truncation", () => {
  const value = selected(), overhead = selectedFeaturePrintText(value).text.length - value.feature.properties.description.length;
  value.feature.properties.description = "x".repeat(4000 - overhead);
  assert.equal(selectedFeaturePrintText(value).text.length, 4000);
  const before = structuredClone(value);value.feature.properties.description += "x";
  assert.throws(() => selectedFeaturePrintText(value), /4,000-character.*shorter authored text/);
  assert.equal(value.feature.properties.description, `${before.feature.properties.description}x`);
  value.feature.properties.description = "short";value.feature.properties.name = "x".repeat(200);
  assert.equal(selectedFeaturePrintText(value).title.length, 200);
  value.feature.properties.name += "x";
  assert.throws(() => selectedFeaturePrintText(value), /200-character.*shorter authored text/);
  value.feature.properties.name = "name";value.layer.datasetId = "x".repeat(4000);
  assert.throws(() => selectedFeaturePrintText(value), /4,000-character/);
});

test("missing selection, invalid controls and nonliteral fields refuse with actionable errors without executing accessors", () => {
  for (const value of [undefined, null, {}, {feature: {type: "Point"}, layer: {}}, {feature: {type: "Feature", properties: {}}, layer: {}}]) {
    assert.throws(() => selectedFeaturePrintText(value), /Select a loaded feature|nonempty text description/);
  }
  for (const control of ["\u0000", "\u001f", "\u007f", "\u0085", "\u2028", "\u2029"]) {
    const value = selected();value.feature.properties.description += control;
    assert.throws(() => selectedFeaturePrintText(value), /no other controls/);
  }
  for (const change of [value => {value.layer.layerId = "";}, value => {value.layer.title = null;},
    value => {value.layer.datasetId = "two\nlines";}, value => {value.feature.id = Infinity;},
    value => {value.feature.properties.name = "two\nlines";},
    value => {Object.defineProperty(value.feature.properties, "description", {get() {throw Error("getter executed");}});},
    value => {Object.defineProperty(value.layer, "title", {get() {throw Error("getter executed");}});}]) {
    const value = selected();change(value);
    assert.throws(() => selectedFeaturePrintText(value), error => !/getter executed/.test(error.message));
  }
  const value = selected();
  Object.defineProperty(value.feature.properties, "unrelated", {get() {throw Error("unrelated getter executed");}});
  assert.equal(selectedFeaturePrintText(value).title, "Survey point");
});

test("closed literal text admits exact whitespace, blank lines, markup characters and Unicode without mutation", () => {
  const value = [frame({text: '  <paper> & "quote"\n\nCafé Ω Ж 😀  \n'})], before = structuredClone(value), ids = new Set(["main", "data-1"]);
  Object.freeze(value[0]);Object.freeze(value);
  const checked = validatePrintTextFrames(value, page, ids);
  assert.deepEqual(checked, before);assert.notEqual(checked, value);assert.notEqual(checked[0], value[0]);
  checked[0].text = "changed";
  assert.deepEqual(value, before);assert.deepEqual([...ids], ["main", "data-1"]);
  assert.deepEqual(validatePrintTextFrames([frame({text: ""})], page)[0].text, "");
  assert.deepEqual(validatePrintTextFrames([], page), []);
});

test("text schema rejects unknown fields, getters, hidden properties, sparse arrays and nonliteral controls", () => {
  const changes = [value => {value[0].source = {url: "https://example.test"};}, value => {delete value[0].alignment;},
    value => {value[0] = Object.assign(Object.create({source: true}), value[0]);},
    value => {Object.defineProperty(value[0], "text", {get() {throw Error("getter executed");}, enumerable: true});},
    value => {Object.defineProperty(value[0], "hidden", {value: true});}, value => {value[Symbol("hidden")] = true;},
    value => {delete value[0];}, value => {value[0].title = "Two\nlines";}, value => {value[0].text = 12;}];
  for (const control of ["\u0000", "\t", "\r", "\r\n", "\u001f", "\u007f", "\u0085", "\u009f", "\u2028", "\u2029"])
    changes.push(value => {value[0].text = `a${control}b`;});
  for (const change of changes) {
    const value = [frame()];change(value);
    assert.throws(() => validatePrintTextFrames(value, page), error => !/getter executed/.test(error.message));
  }
});

test("text frames enforce finite paper geometry, styles, counts and unique identities against all frame kinds", () => {
  const changes = [value => {value.id = " ";}, value => {value.id = "x".repeat(101);}, value => {value.title = "x".repeat(201);},
    value => {value.text = "x".repeat(4001);}, value => {value.type = "html";}, value => {value.xMm = -1;}, value => {value.yMm = Infinity;},
    value => {value.widthMm = 9.99;}, value => {value.heightMm = 4.99;}, value => {value.xMm = 290;}, value => {value.yMm = 200;},
    value => {value.fontSizePt = 5.99;}, value => {value.fontSizePt = 48.01;}, value => {value.color = "red";},
    value => {value.color = {toString() {throw Error("coercion executed");}};}, value => {value.background = "url(#x)";}, value => {value.alignment = "justify";}];
  for (const change of changes) {const value = frame();change(value);assert.throws(() => validatePrintTextFrames([value], page), error => !/coercion executed/.test(error.message));}
  assert.throws(() => validatePrintTextFrames([frame(), frame()], page), /unique/);
  for (const id of ["main", "data-1"]) assert.throws(() => validatePrintTextFrames([frame({id})], page, ["main", "data-1"]), /unique/);
  const eight = Array.from({length: 8}, (_, index) => frame({id: `text-${index}`}));
  assert.equal(validatePrintTextFrames(eight, page).length, 8);
  assert.throws(() => validatePrintTextFrames([...eight, frame({id: "text-9"})], page), /eight/);
  assert.deepEqual(validatePrintTextFrames([frame({xMm: 287, yMm: 205, widthMm: 10, heightMm: 5, fontSizePt: 6, background: "#ABCdef"})], page)[0].heightMm, 5);
});

test("Project validation admits optional text beside maps/data and keeps the shared 32 KiB budget", () => {
  const {map, layout, collection} = fixture();layout.dataFrames = [table()];
  assert.deepEqual(validateProjectPrintLayouts(collection, map), collection);
  for (const id of [layout.frames[0].id, layout.dataFrames[0].id]) {
    const bad = structuredClone(collection);bad.layouts[0].textFrames[0].id = id;
    assert.throws(() => validateProjectPrintLayouts(bad, map), /unique/);
  }
  const tooLarge = structuredClone(collection);
  tooLarge.layouts[0].textFrames = Array.from({length: 6}, (_, index) => frame({id: `text-${index}`, text: "水".repeat(2000)}));
  assert.throws(() => validateProjectPrintLayouts(tooLarge, map), /32 KiB/);
  delete layout.textFrames;assert.deepEqual(validateProjectPrintLayouts(collection, map), collection);
});

test("literal lines use measured alignment and absolute millimeter baselines with explicit empty lines", () => {
  const measurements = [], measure = (text, size) => {measurements.push({text, size});return Array.from(text).length;};
  const value = frame({text: "ab\n\nx", fontSizePt: 10, widthMm: 20});
  const {lines, fontSizeMm, lineHeightMm} = layoutPrintTextFrame(value, measure);
  assert.ok(Math.abs(fontSizeMm - 10 * 25.4 / 72) < 1e-12);
  assert.equal(lineHeightMm, fontSizeMm * 1.3);
  assert.deepEqual(lines.map(line => line.text), ["ab", "", "x"]);
  assert.deepEqual(lines.map(line => line.x), [21, 21, 21]);
  assert.equal(lines[0].y, 31 + fontSizeMm);assert.equal(lines[1].y, lines[0].y + lineHeightMm);
  assert.ok(measurements.length > 0 && measurements.every(item => item.size === fontSizeMm));
  assert.deepEqual(layoutPrintTextFrame({...value, alignment: "center"}, measure).lines.map(line => line.x), [29, 30, 29.5]);
  assert.deepEqual(layoutPrintTextFrame({...value, alignment: "right"}, measure).lines.map(line => line.x), [37, 39, 38]);
});

test("word and codepoint wrapping preserves all literal spaces and never splits surrogate pairs", () => {
  const value = frame({text: "Alpha  beta\n\n😀😀😀😀😀😀😀😀😀😀😀\n tail ", widthMm: 12, heightMm: 100, fontSizePt: 6});
  const result = layoutPrintTextFrame(value, text => Array.from(text).length);
  assert.deepEqual(result.lines.map(line => line.text), ["Alpha  ", "beta", "", "😀😀😀😀😀😀😀😀😀😀", "😀", " tail "]);
  assert.ok(result.lines.every(line => Array.from(line.text).length <= 10 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(line.text)));
  const spaces = layoutPrintTextFrame(frame({text: " ".repeat(25), widthMm: 12, heightMm: 100, fontSizePt: 6}), text => text.length);
  assert.equal(spaces.lines.map(line => line.text).join(""), " ".repeat(25));
});

test("actual measured glyph widths control wrapping while DOMless fallback remains conservative", () => {
  const value = frame({text: "iiii WWWW", widthMm: 12, heightMm: 100, fontSizePt: 6});
  const measured = layoutPrintTextFrame(value, text => Array.from(text).reduce((width, point) => width + (point === "W" ? 3 : 0.5), 0));
  assert.deepEqual(measured.lines.map(line => line.text), ["iiii ", "WWW", "W"]);
  const fallback = layoutPrintTextFrame(value);
  assert.equal(fallback.lines.map(line => line.text).join(""), value.text);
  assert.ok(fallback.lines.every(line => Array.from(line.text).length * fallback.fontSizeMm <= value.widthMm - 2));
});

test("height, individual glyph and invalid measurement overflow refuse without truncating text", () => {
  const single = frame({text: "a", heightMm: 5, fontSizePt: 6});
  assert.equal(layoutPrintTextFrame(single, () => 1).lines.length, 1);
  assert.throws(() => layoutPrintTextFrame({...single, text: "a\n"}, () => 1), /height/);
  assert.throws(() => layoutPrintTextFrame({...single, text: "a", widthMm: 10}, () => 9), /character.*wider/);
  for (const width of [NaN, Infinity, -1, "1"]) assert.throws(() => layoutPrintTextFrame(single, () => width), /finite nonnegative/);
  assert.throws(() => layoutPrintTextFrame(single, null), /output font/);
});

test("source-free templates preserve literal text/style/geometry under local identities and bind no extra sources", () => {
  const {map, layout} = fixture();layout.dataFrames = [table()];
  layout.textFrames[0].text = "Keep literal main and layer-one\n<svg> stays text\n\n";
  layout.textFrames.push(frame({id: "second-original", alignment: "right", background: "#ffffff"}));
  const before = structuredClone({map, layout}), template = templateFromLayout(layout, "Sheet", "template-one");
  assert.deepEqual(template.textFrames.map(item => item.id), ["text-1", "text-2"]);
  assert.deepEqual(template.textFrames[0], {...layout.textFrames[0], id: "text-1"});
  assert.deepEqual(template.dataFrames.map(item => item.sourceSlot), ["source-1"]);
  const applied = layoutFromTemplate(template, map, "applied", {"source-1": "layer-one"});
  assert.deepEqual(applied.textFrames, template.textFrames);
  assert.equal(new Set([...applied.frames, ...applied.dataFrames, ...applied.textFrames].map(item => item.id)).size, 4);
  assert.deepEqual(validateProjectPrintLayouts({schemaVersion: PROJECT_PRINT_SCHEMA, projectId: map.id, layouts: [applied]}, map).layouts[0], applied);
  applied.textFrames[0].text = "changed";assert.notEqual(template.textFrames[0].text, "changed");
  assert.deepEqual({map, layout}, before);assert.deepEqual(validatePrintTemplate(template), template);
  const bad = structuredClone(template);bad.textFrames[0].sourceSlot = "source-2";assert.throws(() => validatePrintTemplate(bad));
  bad.textFrames = [frame({id: "not-local"})];assert.throws(() => validatePrintTemplate(bad), /local/);
});

test("text geometry moves, resizes, aligns and snaps against map, data and other text without mutating content", () => {
  const {layout} = fixture();layout.dataFrames = [table()];
  layout.textFrames = [frame({xMm: 30, yMm: 20, widthMm: 40, heightMm: 15}), frame({id: "peer", xMm: 80, yMm: 70, widthMm: 60, heightMm: 40})];
  const before = structuredClone(layout);
  assert.deepEqual(resizePrintFrame(layout, "note-original", {widthMm: 1, heightMm: 1}), {widthMm: 10, heightMm: 5, snapLines: []});
  assert.deepEqual(movePrintFrame(layout, "note-original", {xMm: 999, yMm: -5}), {xMm: 257, yMm: 0, snapLines: []});
  assert.deepEqual(alignPrintFrame(layout, "note-original", "right"), {xMm: 247, yMm: 20});
  assert.equal(movePrintFrame(layout, "note-original", {xMm: 140.4, yMm: 20, snap: true}).xMm, 140);
  assert.equal(movePrintFrame(layout, "main", {xMm: 30.4, yMm: 27, snap: true}).xMm, 30);
  assert.equal(movePrintFrame(layout, "note-original", {xMm: 240.4, yMm: 20, snap: true}).xMm, 240);
  assert.equal(resizePrintFrame(layout, "note-original", {widthMm: 49.6, heightMm: 15, snap: true}).widthMm, 50);
  assert.equal(resizePrintFrame(layout, "main", {widthMm: 1, heightMm: 1}).heightMm, 10);
  assert.equal(resizePrintFrame(layout, "data-original", {widthMm: 1, heightMm: 1}).heightMm, 20);
  assert.deepEqual(layout, before);
});

test("optional literal text faces preserve old JSON and survive template/save/reopen without style aliases", () => {
  const original = frame(), before = structuredClone(original);
  assert.deepEqual(validatePrintTextFrames([original], page), [before]);
  assert.equal(Object.hasOwn(validatePrintTextFrames([original], page)[0], "fontFace"), false);
  for (const fontFace of ["regular", "bold", "italic", "bolditalic"]) {
    const value = frame({fontFace}), checked = validatePrintTextFrames([value], page);
    assert.equal(checked[0].fontFace, fontFace); assert.deepEqual(value, frame({fontFace}));
    const {map, layout, collection} = fixture(); layout.textFrames = [value];
    const saved = JSON.parse(JSON.stringify(collection));
    assert.equal(validateProjectPrintLayouts(saved, map).layouts[0].textFrames[0].fontFace, fontFace);
    const template = templateFromLayout(layout, "Real text faces", "styled-template");
    assert.equal(validatePrintTemplate(JSON.parse(JSON.stringify(template))).textFrames[0].fontFace, fontFace);
    const reopened = layoutFromTemplate(template, map, "reopened");
    assert.equal(reopened.textFrames[0].fontFace, fontFace);
  }
  const {layout} = fixture(), oldTemplate = templateFromLayout(layout, "Old text", "old-template");
  assert.equal(Object.hasOwn(oldTemplate.textFrames[0], "fontFace"), false);
  for (const fontFace of [null, undefined, false, 700, "Bold", "oblique", "url(https://bad.example/font)"]) {
    assert.throws(() => validatePrintTextFrames([frame({fontFace})], page), /face/);
  }
  assert.throws(() => validatePrintTextFrames([frame({type: "math", fontFace: "regular"})], page), /face|typesetter/);
  const hidden = frame();Object.defineProperty(hidden, "fontFace", {value: "bold"});
  assert.throws(() => validatePrintTextFrames([hidden], page), /fields/);
  const accessor = frame();Object.defineProperty(accessor, "fontFace", {enumerable: true, get() {throw Error("getter executed");}});
  assert.throws(() => validatePrintTextFrames([accessor], page), error => !/getter executed/.test(error.message));
});

test("layout measurement receives the selected real face for every line-wrap decision", () => {
  const measured = [];
  const value = frame({fontFace: "bolditalic", text: "Measured words", alignment: "right"});
  const result = layoutPrintTextFrame(value, (text, size, face) => {measured.push({text, size, face});return text.length * size * 0.7;});
  assert(measured.length > 1);assert(measured.every(value => value.face === "bolditalic"));
  assert.equal(result.lines[0].text, value.text);
  const defaults = [];
  layoutPrintTextFrame(frame(), (_text, _size, face) => {defaults.push(face);return 1;});
  assert(defaults.every(face => face === "regular"));
});
