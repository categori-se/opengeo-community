import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {exportQgisPrintTemplate, importQgisPrintTemplate} from "../src/lib/qgisPrintTemplates.js";
import {PRINT_TEMPLATE_SCHEMA, layoutFromTemplate, validatePrintTemplate} from "../src/lib/printTemplates.js";

const DOMParser = new JSDOM("").window.DOMParser;
const parse = xml => importQgisPrintTemplate(xml, {DOMParser});
const nativeFixture = readFileSync(new URL("./fixtures/qgis-3.44.14-source-free.qpt", import.meta.url), "utf8");
function template() {
  return {schemaVersion: PRINT_TEMPLATE_SCHEMA, id: "portable-template", name: 'Regional sheet — café & <paper>',
    page: {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210, marginMm: 10}, dpi: 150,
    legend: true, legendFormat: "color-bars", northArrow: true, scaleBar: true, graticule: true, sourceNotes: true, caption: 'Literal caption — café & <paper> "quoted"\nSecond line',
    frames: [{id: "main", parentId: null, title: "Main map", xMm: 10, yMm: 25, widthMm: 205, heightMm: 120},
      {id: "inset", parentId: "main", title: "Inset map", xMm: 230, yMm: 25, widthMm: 50, heightMm: 50}],
    dataFrames: [{id: "data-1", type: "table", title: "Records", xMm: 10, yMm: 150, widthMm: 100, heightMm: 35,
      mapFrameId: "main", sourceSlot: "source-1", rowLimit: 6, columns: ["name", 'cost + "tax"']},
    {id: "data-2", type: "table", title: "Inset records", xMm: 120, yMm: 150, widthMm: 100, heightMm: 35,
      mapFrameId: "inset", sourceSlot: "source-2", rowLimit: 12, columns: ["value"]}]};
}
function editXml(xml, edit) {
  const document = new DOMParser().parseFromString(xml, "application/xml");edit(document);
  return new (new JSDOM("").window.XMLSerializer)().serializeToString(document);
}
function findRole(document, role) {
  return [...document.querySelectorAll("Layout > LayoutItem")].find(item => [...item.getElementsByTagName("Option")].some(option => option.getAttribute("name") === "opengeo/role" && option.getAttribute("value") === role));
}

test("QPT writes native editable maps, linked furniture and unbound attribute tables; every supported setting roundtrips", () => {
  const input = template(), before = structuredClone(input), xml = exportQgisPrintTemplate(input), document = new DOMParser().parseFromString(xml, "application/xml");
  assert.equal(document.querySelectorAll('PageCollection > LayoutItem[type="65638"]').length, 1);
  assert.equal(document.querySelectorAll('Layout > LayoutItem[type="65639"]').length, 2);
  assert.equal(document.querySelectorAll('Layout > LayoutItem[type="65647"]').length, 2);
  assert.equal(document.querySelectorAll('Layout > LayoutMultiFrame[type="65649"]').length, 2);
  assert.ok(document.querySelector('LayoutItem[type="65642"]').getAttribute("map_uuid"));
  assert.ok(document.querySelector('LayoutItem[type="65646"]').getAttribute("mapUuid"));
  for (const map of document.querySelectorAll('LayoutItem[type="65639"]')) {
    assert.equal(map.querySelector("LayerSet").children.length, 0);
    assert.equal(map.getAttribute("keepLayerSet"), "true");
    assert.equal(map.querySelector("Extent").getAttribute("xmin"), "0");
  }
  const meta = [...document.querySelectorAll("Layout > customproperties Option")].find(option => option.getAttribute("name") === "opengeo/print-template");
  const supplemental = JSON.parse(meta.getAttribute("value"));
  assert.deepEqual(Object.keys(supplemental).sort(), ["dataFramesPresent", "id", "legendFormat", "page", "schemaVersion"]);
  assert.doesNotMatch(JSON.stringify(supplemental), /frames|xMm|widthMm|caption|columns|extent|layerId/);
  const {template: actual, notices} = parse(xml);
  assert.deepEqual(actual, input);assert.deepEqual(input, before);
  assert.ok(notices.some(notice => /static literal north/.test(notice)));
  assert.ok(notices.some(notice => /cell styling/.test(notice)));
  assert.ok(notices.some(notice => /fixed positions/.test(notice)));
});

test("ordinary QGIS 3.44.14 SDK output imports main/inset, literal labels and actual attribute-table fields without metadata", () => {
  const {template: value, notices} = parse(nativeFixture);
  assert.equal(value.name, "Native source-free QPT fixture");
  assert.deepEqual(value.page, {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210, marginMm: 10});
  assert.equal(value.dpi, 150);assert.equal(value.legend, true);assert.equal(value.scaleBar, true);
  assert.deepEqual(value.frames.map(frame => [frame.id, frame.parentId, frame.xMm, frame.yMm, frame.widthMm, frame.heightMm]),
    [["main", null, 10, 20, 210, 105], ["inset", "main", 230, 20, 57, 28.5]]);
  assert.equal(value.dataFrames.length, 1);assert.equal(value.dataFrames[0].type, "table");
  assert.equal(value.dataFrames[0].widthMm, 23.7976);assert.equal(value.dataFrames[0].heightMm, 40);
  assert.equal(value.dataFrames[0].mapFrameId, "main");assert.equal(value.dataFrames[0].rowLimit, 6);
  assert.deepEqual(value.dataFrames[0].columns, ["name", "value"]);
  assert.equal(value.caption, "Local QGIS template caption — café & <paper>");assert.equal(value.textFrames, undefined);
  assert.equal(notices[0].includes("not imported"), true);assert.deepEqual(validatePrintTemplate(value), value);
});

test("native geometry, text, dimensions, columns, row limits and deletion win over supplemental OpenGeo settings", () => {
  const xml = editXml(exportQgisPrintTemplate(template()), document => {
    const main = findRole(document, "main");main.setAttribute("position", "11,26,mm");main.setAttribute("positionOnPage", "11,26,mm");main.setAttribute("size", "202,119,mm");
    findRole(document, "caption").setAttribute("labelText", "Edited in native QGIS");
    document.documentElement.setAttribute("name", "Native renamed sheet");
    const first = document.querySelector("LayoutMultiFrame");first.setAttribute("maxFeatures", "3");first.querySelector("column").setAttribute("attribute", '"new field"');
    findRole(document, "inset").remove();
    findRole(document, "data-2").remove();document.querySelectorAll("LayoutMultiFrame")[1].remove();
  });
  const {template: actual} = parse(xml);
  assert.equal(actual.name, "Native renamed sheet");assert.equal(actual.frames.length, 1);
  assert.deepEqual(actual.frames[0], {id: "main", parentId: null, title: "Main map", xMm: 11, yMm: 26, widthMm: 202, heightMm: 119});
  assert.equal(actual.caption, "Edited in native QGIS");assert.equal(actual.dataFrames.length, 1);
  assert.deepEqual(actual.dataFrames[0].columns, ["new field", 'cost + "tax"']);assert.equal(actual.dataFrames[0].rowLimit, 3);
  assert.ok(parse(xml).notices.some(notice => /Native title label.*distinct text, position and style are not retained/.test(notice)));
});

function withTextFrames() {
  return {...template(), legend: false, textFrames: [
    {id: "text-1", type: "text", title: "Summary", text: "Literal café & <paper>\nSecond line", xMm: 225, yMm: 85, widthMm: 60, heightMm: 28,
      fontSizePt: 12, color: "#123456", background: "#fff1de", alignment: "center"},
    {id: "text-2", type: "text", title: "Notes", text: "", xMm: 225, yMm: 116, widthMm: 60, heightMm: 20,
      fontSizePt: 8, color: "#17212b", background: "none", alignment: "right"}]};
}

test("positioned literal text exports as editable native labels with native geometry, colors, alignment and point-size font", () => {
  const value = withTextFrames(), before = structuredClone(value), xml = exportQgisPrintTemplate(value);
  const document = new DOMParser().parseFromString(xml, "application/xml"), label = findRole(document, "text-text-1");
  assert.equal(label.getAttribute("id"), "Summary");assert.equal(label.getAttribute("labelText"), value.textFrames[0].text);
  assert.equal(label.getAttribute("positionOnPage"), "225,85,mm");assert.equal(label.getAttribute("size"), "60,28,mm");
  assert.equal(label.getAttribute("halign"), "4");assert.equal(label.getAttribute("valign"), "32");assert.equal(label.getAttribute("background"), "true");
  assert.equal(label.getAttribute("marginX"), "1");assert.equal(label.getAttribute("marginY"), "1");assert.equal(label.querySelector("text-style").getAttribute("multilineHeight"), "1.3");
  assert.equal(label.querySelector("text-style").getAttribute("fontSize"), "12");assert.equal(label.querySelector("text-style").getAttribute("textColor"), "18,52,86,255");
  assert.equal(label.querySelector("text-style").getAttribute("fontFamily"), "Open Sans");
  // The installed Qt 5 XML reader otherwise defaults an absent weight to Thin=0.
  for (const frame of value.textFrames) {
    const style = findRole(document, `text-${frame.id}`).querySelector("text-style");assert.equal(style.getAttribute("fontWeight"), "50");
    for (const flag of ["fontItalic", "forcedBold", "forcedItalic", "fontUnderline", "fontStrikeout"]) assert.equal(style.getAttribute(flag), "0");
  }
  assert.equal(label.querySelector("BackgroundColor").getAttribute("red"), "255");assert.equal(label.querySelector("BackgroundColor").getAttribute("green"), "241");
  const settings = JSON.parse([...document.querySelectorAll("Layout > customproperties Option")].find(option => option.getAttribute("name") === "opengeo/print-template").getAttribute("value"));
  assert.equal(settings.textFramesPresent, true);assert.doesNotMatch(JSON.stringify(settings), /Summary|Literal|fontSize|"color"|alignment|textFrames"/);
  assert.deepEqual(parse(xml).template, value);assert.deepEqual(value, before);
  const reordered = editXml(xml, document => document.documentElement.append(findRole(document, "text-text-1")));
  assert.deepEqual(parse(reordered).template, value);
  const empty = {...value, textFrames: []};assert.deepEqual(parse(exportQgisPrintTemplate(empty)).template, empty);
});

test("native positioned-label edits and deletion govern reimport without restoring stale supplemental values", () => {
  const xml = editXml(exportQgisPrintTemplate(withTextFrames()), document => {
    const label = findRole(document, "text-text-1");label.setAttribute("id", "Native renamed text");label.setAttribute("labelText", "Edited <literal>\nNative line");
    label.setAttribute("positionOnPage", "222,84,mm");label.setAttribute("size", "62,30,mm");label.setAttribute("halign", "2");label.setAttribute("background", "false");
    const style = label.querySelector("text-style");style.setAttribute("fontSize", "18");style.setAttribute("textColor", "171,205,239,255,rgb:0.67,0.8,0.94,1");
    findRole(document, "text-text-2").remove();
  });
  assert.deepEqual(parse(xml).template.textFrames, [{id: "text-1", type: "text", title: "Native renamed text", text: "Edited <literal>\nNative line",
    xMm: 222, yMm: 84, widthMm: 62, heightMm: 30, fontSizePt: 18, color: "#abcdef", background: "none", alignment: "right"}]);
  const deleted = editXml(xml, document => findRole(document, "text-text-1").remove());assert.deepEqual(parse(deleted).template.textFrames, []);
  const firstDeleted = editXml(exportQgisPrintTemplate(withTextFrames()), document => findRole(document, "text-text-1").remove());
  assert.deepEqual(parse(firstDeleted).template.textFrames, [{...withTextFrames().textFrames[1], id: "text-1"}]);
});

test("ordinary native labels keep separate positions and disclose font-family and line-spacing differences", () => {
  const xml = editXml(nativeFixture, document => {
    const source = [...document.querySelectorAll('Layout > LayoutItem[type="65641"]')].find(label => label.getAttribute("id") === "caption");
    const label = source.cloneNode(true);label.setAttribute("id", "Extra explanation");label.setAttribute("uuid", "{extra-label}");label.setAttribute("templateUuid", "{extra-label}");
    label.setAttribute("labelText", "An independent note");label.setAttribute("positionOnPage", "235,100,mm");label.setAttribute("size", "50,25,mm");document.documentElement.append(label);
  });
  const {template: value, notices} = parse(xml);
  assert.equal(value.caption, "Local QGIS template caption — café & <paper>");
  assert.deepEqual(value.textFrames, [{id: "text-1", type: "text", title: "Extra explanation", text: "An independent note",
    xMm: 235, yMm: 100, widthMm: 50, heightMm: 25, fontSizePt: 10, color: "#000000", background: "none", alignment: "left"}]);
  assert.ok(notices.some(notice => /font family “Noto Sans Arabic” is not retained/.test(notice)));assert.ok(notices.some(notice => /native multiline spacing is not retained/.test(notice)));
});

test("unsupported positioned-label formatting is refused explicitly and literal expressions remain blocked", () => {
  const safe = exportQgisPrintTemplate(withTextFrames());
  const changes = [label => label.setAttribute("halign", "8"), label => label.setAttribute("valign", "128"), label => label.setAttribute("marginX", "2"),
    label => label.setAttribute("frame", "true"), label => label.setAttribute("opacity", "0.5"), label => label.setAttribute("htmlState", "1"),
    label => label.querySelector("text-style").setAttribute("fontWeight", "0"), label => label.querySelector("text-style").setAttribute("fontWeight", "75"), label => label.querySelector("text-style").setAttribute("fontItalic", "1"),
    label => label.querySelector("text-style").setAttribute("fontSizeUnit", "Pixel"), label => label.querySelector("text-style").setAttribute("textColor", "0,0,0,128"),
    label => label.querySelector("text-style").setAttribute("unrecognizedTypography", "1")];
  for (const change of changes) assert.throws(() => parse(editXml(safe, document => change(findRole(document, "text-text-1")))), /Unsupported native QGIS positioned text|HTML labels|requires opaque RGB/);
  const value = withTextFrames();value.textFrames[0].text = "[% dangerous() %]";assert.throws(() => exportQgisPrintTemplate(value), /literal text only/);
});

test("source-free conversion binds only current Project camera/presentation and explicit table choices later", () => {
  const xml = editXml(exportQgisPrintTemplate(template()), document => {
    const map = findRole(document, "main");map.querySelector("Extent").setAttribute("xmin", "123456");
    const layer = document.createElement("Layer");layer.textContent = "previous-project-layer";map.querySelector("LayerSet").append(layer);
  });
  // QGIS native layer identifiers are inert text, and never retained as bindings.
  const {template: value} = parse(xml), project = {definition: {mapViews: [{center: [12, 34], zoom: 4, bearing: 10, pitch: 0}],
    layers: [{layerId: "current", datasetId: "current-data", visible: true, style: {color: "#123456"}, labels: {}}]}};
  assert.doesNotMatch(JSON.stringify(value), /previous-project-layer|123456/);
  const bound = layoutFromTemplate(value, project, "bound", {"source-1": "current", "source-2": "current"});
  assert.deepEqual(bound.frames[0].view, project.definition.mapViews[0]);assert.equal(bound.dataFrames[0].source.layerId, "current");
  assert.throws(() => layoutFromTemplate(value, project, "unbound"));
});

test("genuine chart and other unsupported native content fail explicitly while JSON templates remain usable", () => {
  const value = template();value.dataFrames[0] = {id: "data-1", type: "chart", title: "Chart", xMm: 10, yMm: 150, widthMm: 100, heightMm: 35,
    mapFrameId: "main", sourceSlot: "source-1", rowLimit: 6, chartType: "line", labelField: "name", valueField: "value", altText: "Recorded values"};
  assert.deepEqual(validatePrintTemplate(value), value);assert.throws(() => exportQgisPrintTemplate(value), /JSON.*every chart setting/);
  assert.throws(() => parse(exportQgisPrintTemplate(template()).replace('type="65641"', 'type="65640"')), /Unsupported native QGIS item/);
});

test("dangerous XML is rejected before DOMParser, including entity-obscured properties and disabled HTML expressions", () => {
  const safe = exportQgisPrintTemplate(template());let parserCalls = 0;
  class MustNotParse {constructor() {parserCalls++;throw Error("DOMParser must not run");}}
  const bad = [safe.replace('<Layout ', '<!DOCTYPE Layout SYSTEM "https://example.invalid/dtd"><Layout '),
    safe.replace('<Layout ', '<!DOCTYPE Layout [<!ENTITY injected "payload">]><Layout '),
    safe.replace('<Layout ', '<?danger value?><Layout '), safe.replace('<Layout ', '<!DOCTYPE Layout><!DOCTYPE Layout><Layout '),
    safe.replace('htmlState="0"', 'htmlState="1"'), safe.replace('labelText="N ↑"', 'labelText="[&#37; dangerous() %]"'),
    safe.replace('<Layout ', '<Layout href="https://example.invalid" '), safe.replace('<Layout ', '<Layout source="file:///secret" '),
    safe.replace('<Layout ', '<Layout picturePath="&#104;ttps://example.invalid/image.svg" '),
    safe.replace('<Layout ', '<Layout><Atlas enabled="1" coverageLayer="remote"/></Layout><Layout '),
    safe.replace('<Option name="properties"/>', '<Option name="properties"><Option name="active" value="1"/></Option>'),
    safe.replace('<LayerSet/>', '<LayerSet/><script/>'), safe.replace('featureFilter=""', 'featureFilter="value > 5"'),
    safe.replace('attribute="&quot;name&quot;"', 'attribute="&quot;name&quot; + 1"'),
    '<Layout>' + '<Option>'.repeat(33) + '</Option>'.repeat(33) + '</Layout>', 'x'.repeat(1_048_577)];
  for (const xml of bad) assert.throws(() => importQgisPrintTemplate(xml, {DOMParser: MustNotParse}), error => !/DOMParser must not run/.test(error.message));
  assert.equal(parserCalls, 0);
  const expression = template();expression.caption = "[% dangerous() %]";assert.throws(() => exportQgisPrintTemplate(expression), /literal text only/);
});

test("bounded native pages/maps/slots/geometry and supplemental settings reject malformed or unsupported conversion", () => {
  const safe = exportQgisPrintTemplate(template());
  const changes = [document => {document.querySelector("PageCollection").append(document.querySelector("PageCollection > LayoutItem").cloneNode(true));},
    document => findRole(document, "main").setAttribute("size", "1,1,mm"), document => findRole(document, "main").setAttribute("itemRotation", "20"),
    document => findRole(document, "main").setAttribute("positionOnPage", "NaN,20,mm"), document => findRole(document, "main").setAttribute("size", "205,120,mapunits"),
    document => document.documentElement.setAttribute("printResolution", "600"), document => document.querySelector("LayoutMultiFrame").setAttribute("maxFeatures", "13"),
    document => document.querySelector("LayoutMultiFrame").setAttribute("mapUuid", "foreign-map"),
    document => document.querySelector("LayoutMultiFrame").append(document.querySelector("childFrame").cloneNode(true)),
    document => findRole(document, "inset").setAttribute("uuid", findRole(document, "main").getAttribute("uuid")),
    document => [...document.querySelectorAll("Layout > customproperties Option")].find(option => option.getAttribute("name") === "opengeo/print-template").setAttribute("value", '{"schemaVersion":"opengeo.qpt-settings.1","frames":[]}')];
  for (const change of changes) assert.throws(() => parse(editXml(safe, change)));
  assert.throws(() => parse("<Layout>"));assert.throws(() => parse("<not-layout/>"));
});

test("plain native doctype and physical units are admitted; smaller profile keeps absent optional JSON fields absent", () => {
  const value = template();delete value.dataFrames;delete value.legendFormat;value.northArrow = false;value.caption = "";
  const xml = exportQgisPrintTemplate(value), withDoctype = xml.replace('?>', '?>\n<!DOCTYPE Layout>');
  assert.deepEqual(parse(withDoctype).template, value);
  const inches = editXml(xml, document => {const map = findRole(document, "main");map.setAttribute("positionOnPage", "1,1,in");map.setAttribute("size", "2,2,in");});
  const frame = parse(inches).template.frames[0];assert.equal(frame.xMm, 25.4);assert.equal(frame.widthMm, 50.8);
});

test("geographic graticules use native show, direct spatialrefsys EPSG:4326 and map-unit intervals", () => {
  const value = template(), xml = exportQgisPrintTemplate(value), document = new DOMParser().parseFromString(xml, "application/xml");
  const grids = [...document.querySelectorAll('LayoutItem[type="65639"] > ComposerMapGrid')];
  assert.equal(grids.length, 2);
  for (const grid of grids) {
    assert.equal(grid.getAttribute("show"), "1");assert.equal(grid.hasAttribute("enabled"), false);
    assert.equal(grid.querySelector(":scope > spatialrefsys > authid").textContent, "EPSG:4326");
    assert.equal(grid.querySelector("geographicflag").textContent, "true");assert.equal(grid.getAttribute("unit"), "0");
    assert.equal(grid.getAttribute("intervalX"), "10");assert.equal(grid.getAttribute("intervalY"), "10");
    assert.equal(grid.getAttribute("showAnnotation"), "1");
  }
  assert.equal(parse(xml).template.graticule, true);
  const disabled = editXml(xml, document => document.querySelectorAll("ComposerMapGrid").forEach(grid => grid.setAttribute("show", "0")));
  assert.equal(parse(disabled).template.graticule, false);
});

test("generated native furniture must fit the page; hidden native text and furniture fail before DOM parsing", () => {
  const north = template();north.frames = [{id: "main", parentId: null, title: "Tiny edge map", xMm: 287, yMm: 200, widthMm: 10, heightMm: 10}];delete north.dataFrames;
  assert.deepEqual(validatePrintTemplate(north), north);assert.throws(() => exportQgisPrintTemplate(north), /north-main furniture needs more page space/);
  const scale = template();scale.northArrow = false;scale.frames = [{id: "main", parentId: null, title: "Tiny top map", xMm: 0, yMm: 0, widthMm: 10, heightMm: 10}];delete scale.dataFrames;
  assert.deepEqual(validatePrintTemplate(scale), scale);assert.throws(() => exportQgisPrintTemplate(scale), /scale-main furniture needs more page space/);
  let parserCalls = 0;class MustNotParse {constructor() {parserCalls++;throw Error("DOMParser must not run");}}
  const safe = exportQgisPrintTemplate(template());
  for (const role of ["caption", "legend", "scale-main", "source-notes"]) for (const [key, value] of [["visibility", "0"], ["excludeFromExports", "1"]]) {
    const xml = editXml(safe, document => findRole(document, role).setAttribute(key, value));
    assert.throws(() => importQgisPrintTemplate(xml, {DOMParser: MustNotParse}), /Hidden or excluded native items/);
  }
  assert.equal(parserCalls, 0);
});

test("QGIS native UUID reminting resolves tables by unique reciprocal child frames and rejects conflicting aliases", () => {
  const expected = template(), exported = exportQgisPrintTemplate(expected);
  const reminted = editXml(exported, document => {
    const maps = [...document.querySelectorAll('Layout > LayoutItem[type="65639"]')], multis = [...document.querySelectorAll("LayoutMultiFrame")];
    for (const [index, map] of maps.entries()) {
      const old = map.getAttribute("uuid"), current = `{native-map-${index + 1}}`;
      map.setAttribute("uuid", current);map.setAttribute("templateUuid", current);
      for (const multi of multis) if (multi.getAttribute("mapUuid") === old) multi.setAttribute("mapUuid", current);
    }
    for (const [index, multi] of multis.entries()) {
      const frame = findRole(document, `data-${index + 1}`), frameUuid = `{native-table-frame-${index + 1}}`, multiUuid = `{native-table-${index + 1}}`;
      frame.setAttribute("uuid", frameUuid);frame.setAttribute("templateUuid", frameUuid);
      multi.setAttribute("uuid", multiUuid);multi.setAttribute("templateUuid", multiUuid);
      multi.querySelector("childFrame").setAttribute("uuid", frameUuid);multi.querySelector("childFrame").setAttribute("templateUuid", frameUuid);
      // The actual 3.44.14 SDK retains the old frame.multiFrame references here.
    }
  });
  assert.deepEqual(parse(reminted).template, expected);
  const ambiguous = editXml(reminted, document => document.querySelectorAll("LayoutMultiFrame")[1].querySelector("childFrame").setAttribute("uuid", "{native-table-frame-1}"));
  assert.throws(() => parse(ambiguous), /Ambiguous|Conflicting/);
  const conflicting = editXml(reminted, document => findRole(document, "data-1").setAttribute("multiFrame", "{native-table-2}"));
  assert.throws(() => parse(conflicting), /Conflicting/);
  const aliasConflict = editXml(reminted, document => document.querySelector("childFrame").setAttribute("templateUuid", "{native-table-frame-2}"));
  assert.throws(() => parse(aliasConflict), /Conflicting/);
});

test("native furniture reserves readable fit-width scale strips and a collision-free wide legend in the retained scene", () => {
  const original = parse(nativeFixture).template, before = structuredClone(original), xml = exportQgisPrintTemplate(original);
  const document = new DOMParser().parseFromString(xml, "application/xml"), legend = document.querySelector('LayoutItem[type="65642"]');
  const rect = item => {
    const [x, y] = item.getAttribute("positionOnPage").split(",").map(Number), [width, height] = item.getAttribute("size").split(",").map(Number);
    return {x, y, width, height};
  };
  const reserved = rect(legend);
  assert.deepEqual(reserved, {x: 223, y: 51.5, width: 64, height: 40});
  for (const other of document.querySelectorAll("Layout > LayoutItem")) if (other !== legend) {
    const item = rect(other);
    assert.ok(reserved.x >= item.x + item.width + 3 || reserved.x + reserved.width + 3 <= item.x
      || reserved.y >= item.y + item.height + 3 || reserved.y + reserved.height + 3 <= item.y, `legend clears ${other.getAttribute("id")}`);
  }
  assert.equal(legend.getAttribute("resizeToContents"), "0");assert.equal(legend.getAttribute("autoWrapLinesAfter"), "51");
  for (const style of legend.querySelectorAll("styles > style")) assert.equal(style.querySelector("text-style").getAttribute("fontSize"), style.getAttribute("name") === "title" ? "10" : "8");
  const bars = [...document.querySelectorAll('LayoutItem[type="65646"]')];assert.equal(bars.length, 2);
  for (const [index, bar] of bars.entries()) {
    const geometry = rect(bar), maximum = Number(bar.getAttribute("maxBarWidth")), minimum = Number(bar.getAttribute("minBarWidth"));
    assert.equal(bar.getAttribute("segmentSizeMode"), "1");assert.equal(bar.getAttribute("numSegments"), "2");
    assert.equal(maximum, index ? 39 : 40);assert.ok(minimum >= 25 && minimum < maximum);
    assert.equal(maximum + 10, geometry.width);assert.equal(geometry.height, 10);
    assert.equal(bar.querySelector("text-style").getAttribute("fontSize"), "8");assert.ok(bar.getAttribute("mapUuid"));
  }
  const imported = parse(xml);
  assert.deepEqual(imported.template, original);assert.deepEqual(original, before);
  assert.ok(imported.notices.some(notice => /destination content can need more space/.test(notice)));
});

test("native legend uses available paper below a wide map without moving source geometry", () => {
  const value = template();value.frames = [{...value.frames[0], widthMm: 277, heightMm: 100}];value.northArrow = false;value.scaleBar = false;delete value.dataFrames;
  const before = structuredClone(value), xml = exportQgisPrintTemplate(value), document = new DOMParser().parseFromString(xml, "application/xml");
  const legend = document.querySelector('LayoutItem[type="65642"]');
  assert.equal(legend.getAttribute("positionOnPage"), "10,128,mm");assert.equal(legend.getAttribute("size"), "80,40,mm");
  assert.deepEqual(parse(xml).template, before);assert.deepEqual(value, before);
});

test("unplaceable native legends and narrow map scales refuse explicitly while preserving the portable template", () => {
  const packed = template();packed.page = {size: "Custom", orientation: "portrait", widthMm: 100, heightMm: 100, marginMm: 5};
  packed.frames = [{id: "main", parentId: null, title: "Full page", xMm: 5, yMm: 5, widthMm: 90, heightMm: 90}];
  delete packed.dataFrames;packed.northArrow = false;packed.scaleBar = false;packed.caption = "";packed.sourceNotes = false;
  const before = structuredClone(packed);assert.deepEqual(validatePrintTemplate(packed), packed);
  assert.throws(() => exportQgisPrintTemplate(packed), /legend needs a free paper area.*50 × 40.*Move or resize/);assert.deepEqual(packed, before);
  const narrow = template();narrow.frames = [{...narrow.frames[0], widthMm: 47}];narrow.northArrow = false;narrow.legend = false;delete narrow.dataFrames;
  assert.deepEqual(validatePrintTemplate(narrow), narrow);assert.throws(() => exportQgisPrintTemplate(narrow), /Widen this map to at least 48 mm/);
});
