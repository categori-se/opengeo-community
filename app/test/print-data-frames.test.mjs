import assert from "node:assert/strict";
import {test} from "node:test";
import {assertPrintDataFrameSnapshot, capturePrintDataFrames, printDataFrameSignature, printDataSourceFields} from "../src/lib/printDataFrames.js";

const source = {layerId: "layer", datasetId: "dataset", datasetVersionId: "version-2", sourceVersion: 2};
const presentation = [{...source, visible: true, opacity: 1, style: {}, labels: {}}];
const frame = {id: "attributes", type: "table", title: "Attributes", mapFrameId: "main", source,
  xMm: 10, yMm: 10, widthMm: 80, heightMm: 50, rowLimit: 12, columns: ["name", "value"]};
const chart = {...frame, id: "values", type: "chart", chartType: "bar", labelField: "name", valueField: "value", altText: "Recorded row values"};
delete chart.columns;
const feature = (properties, id = 0, geometry = {type: "Point", coordinates: [0, 0]}) => ({type: "Feature", id, properties, geometry});
function fixture(features) {
  const geojson = {type: "FeatureCollection", features};
  const inputPin = {...source, featureGeneration: 7, checksumSha256: "a".repeat(64)};
  const input = {id: source.layerId, title: "Loaded Layer", geojson, inputPin};
  const calls = [];
  const context = {map: {getZoom: () => 6}, getPrintDataSource: layerId => {calls.push(layerId);return layerId === source.layerId ? input : null;}};
  const map = {id: "project", definition: {layers: [{...source}]}};
  return {geojson, input, context, map, calls};
}
const capture = (fixture, selected = frame, layers = presentation) => capturePrintDataFrames(fixture.context, fixture.map, [selected], layers)[0];

test("captures source-bound loaded attributes without requests or source mutation", () => {
  const data = fixture([feature({name: "same", value: "900719925474099312345"}, 9), feature({name: "same", value: "0.1000000000000000000001"}, 8)]);
  const before = structuredClone(data.geojson);
  Object.freeze(data.geojson);Object.freeze(data.geojson.features);data.geojson.features.forEach(item => {Object.freeze(item);Object.freeze(item.properties);});
  const snapshot = capture(data);
  assert.deepEqual(snapshot.columns, ["name", "value"]);
  assert.deepEqual(snapshot.rows, [["same", "900719925474099312345"], ["same", "0.1000000000000000000001"]]);
  assert.deepEqual(snapshot.sourcePin, data.input.inputPin);
  assert.equal(snapshot.rawValues, null);assert.equal(snapshot.scanLimited, false);assert.equal(snapshot.rowLimited, false);
  assert.match(snapshot.scopeText, /2 rows shown from 2 matching records among 2 of 2 loaded records scanned/);
  assert.match(snapshot.checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(assertPrintDataFrameSnapshot(frame, snapshot, presentation), snapshot);
  assert.deepEqual(data.geojson, before);assert.deepEqual(data.calls, ["layer"]);
});

test("uses installed MapLibre property predicates and original feature order across geometry types", () => {
  const data = fixture([feature({name: "first", value: 3, kind: "keep"}, 30),
    feature({name: "drop", value: 4, kind: "other"}, 20, {type: "LineString", coordinates: [[0, 0], [1, 1]]}),
    feature({name: "last", value: 5, kind: "keep"}, 10, {type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]]}),
    feature({name: "missing-kind", value: 6}, 5, null)]);
  for (const filter of [["==", ["get", "kind"], "keep"], ["==", "kind", "keep"],
    ["all", ["in", ["get", "kind"], ["literal", ["keep"]]], [">=", ["get", "value"], 3]]]) {
    const snapshot = capture(data, frame, [{...presentation[0], filter}]);
    assert.deepEqual(snapshot.rows, [["first", 3], ["last", 5]]);
    assert.equal(snapshot.matchedCount, 2);
  }
  assert.throws(() => capture(data, frame, [{...presentation[0], filter: ["==", ["zoom"], 6]}]), /Unsupported map filter/);
});

test("distinguishes missing, null, blank, structured and unsupported bounded table values", () => {
  const data = fixture([feature({name: "missing"}), feature({name: "null", value: null}), feature({name: "blank", value: ""}),
    feature({name: "structured", value: {deep: [1, 2]}}), feature({name: "long", value: "x".repeat(301)}),
    feature({name: "big", value: 1e16}), feature({name: "infinite", value: Infinity}), feature({name: "native bigint", value: 42n}),
    feature({name: "boolean", value: false})]);
  const snapshot = capture(data);
  assert.deepEqual(snapshot.rows.map(row => row[1]), ["[missing]", null, "", "[structured value]", "[text exceeds 300 characters]",
    "[number outside supported range]", "[nonfinite number]", "[unsupported value]", false]);
  assert.deepEqual(snapshot.cellKinds.map(row => row[1]), ["missing", "null", "blank", "structured", "too-long", "out-of-range", "nonfinite", "unsupported", "value"]);
  for (const fragment of ["missing fields", "null values", "blank strings", "structured values", "300 characters", "supported ±1e15", "nonfinite", "unsupported"])
    assert.ok(snapshot.notices.some(notice => notice.includes(fragment)), fragment);
  assert.equal(data.geojson.features[3].properties.value.deep[1], 2);
});

test("charts retain duplicate labels and raw numeric strings, with explicit gaps and signed numbers", () => {
  const data = fixture([feature({name: "same", value: -2}), feature({name: "same", value: 0}), feature({name: "positive", value: 1e15}),
    feature({name: "exact integer", value: "9007199254740993"}), feature({name: "exact decimal", value: "0.10000000000000001"}),
    feature({name: "null", value: null}), feature({name: "blank", value: ""}), feature({name: "missing"}),
    feature({name: "structured", value: {count: 5}}), feature({name: "boolean", value: true})]);
  const snapshot = capture(data, chart);
  assert.deepEqual(snapshot.rows.map(row => row[1]), [-2, 0, 1e15, null, null, null, null, null, null, null]);
  assert.deepEqual(snapshot.rows.slice(0, 2).map(row => row[0]), ["same", "same"]);
  assert.equal(snapshot.rawValues[3], "9007199254740993");assert.equal(snapshot.rawValues[4], "0.10000000000000001");
  assert.ok(snapshot.notices.some(notice => notice.includes("3 nonnumeric chart values")));
  const noNumbers = capture(fixture([feature({name: "unknown", value: "12"})]), {...chart, chartType: "line"});
  assert.deepEqual(noNumbers.rows, [["unknown", null]]);assert.ok(noNumbers.notices.includes("No finite numeric values are available in the shown rows."));
  assert.deepEqual(capture(fixture([]), chart).rows, []);
});

test("bounds scanning separately from first matching rows without claiming full-source totals", () => {
  const features = Array.from({length: 5002}, (_, id) => feature({name: `record-${id}`, value: id}, id));
  Object.defineProperty(features, 5000, {get() {throw Error("must not inspect beyond scan bound");}});
  const snapshot = capture(fixture(features), {...frame, rowLimit: 2});
  assert.equal(snapshot.loadedCount, 5002);assert.equal(snapshot.scannedCount, 5000);assert.equal(snapshot.matchedCount, 5000);
  assert.equal(snapshot.rowLimited, true);assert.equal(snapshot.scanLimited, true);
  assert.deepEqual(snapshot.rows, [["record-0", 0], ["record-1", 1]]);
  assert.match(snapshot.scopeText, /First 2 matching rows/);assert.match(snapshot.scopeText, /2 loaded records unexamined/);
});

test("refuses partial/live data, missing pins, changed sources and malformed collections", () => {
  const variations = [data => {data.geojson.type = "Feature";}, data => {data.geojson.features = {};},
    data => {Object.defineProperty(data.geojson, "opengeo", {value: {mayBeTruncated: true}});},
    data => {Object.defineProperty(data.geojson, "opengeo", {value: {schemaVersion: "opengeo.live-feature-page.1.0.0", mayBeTruncated: false}});},
    data => {delete data.input.inputPin.datasetVersionId;}, data => {data.input.inputPin.sourceVersion = 3;},
    data => {data.input.inputPin.checksumSha256 = "bad";}, data => {data.map.definition.layers[0].datasetVersionId = "different";},
    data => {data.geojson.features[0].type = "Point";}, data => {data.geojson.features[0].geometry = {type: "unknown"};}];
  for (const change of variations) {const data = fixture([feature({name: "one", value: 1})]);change(data);assert.throws(() => capture(data));}
  assert.throws(() => capture(fixture([]), frame, [{...presentation[0], managedDisplayId: "tiles"}]), /tiled display/);
  assert.throws(() => capturePrintDataFrames(fixture([]).context, fixture([]).map, Array(5).fill(frame), presentation), /at most four/);
});

test("signatures preserve captured content through furniture edits and reject data-configuration changes or tampering", () => {
  const data = fixture([feature({name: "one", value: 1})]), snapshot = capture(data);
  const furniture = {...frame, title: "New heading", xMm: 50, yMm: 20, widthMm: 120, heightMm: 80, altText: "Changed explanation"};
  assert.equal(printDataFrameSignature(furniture, presentation), snapshot.signature);
  assert.equal(assertPrintDataFrameSnapshot(furniture, snapshot, presentation), snapshot);
  for (const changed of [{...frame, rowLimit: 1}, {...frame, columns: ["name"]}, {...frame, mapFrameId: "inset"}])
    assert.throws(() => assertPrintDataFrameSnapshot(changed, snapshot, presentation), /stale or invalid/);
  assert.throws(() => assertPrintDataFrameSnapshot(frame, snapshot, [{...presentation[0], filter: ["has", "name"]}]), /stale or invalid/);
  for (const mutate of [value => {value.rows[0][1] = 99;}, value => {value.notices.push("Invented claim");},
    value => {value.sourcePin.featureGeneration = 8;}, value => {value.cellKinds[0][1] = "missing";}]) {
    const changed = structuredClone(snapshot);mutate(changed);assert.throws(() => assertPrintDataFrameSnapshot(frame, changed, presentation), /checksum changed/);
  }
  const malformed = structuredClone(snapshot);malformed.loadedCount = -1;
  assert.throws(() => assertPrintDataFrameSnapshot(frame, malformed, presentation), /stale or invalid/);
});

test("field discovery is bounded to 64 names and the first 100 records without source changes", () => {
  const fields = Object.fromEntries(Array.from({length: 80}, (_, index) => [`field${index}`, index]));
  const data = fixture([feature(fields)]);
  assert.equal(printDataSourceFields(data.context, source.layerId).length, 64);
  assert.deepEqual(printDataSourceFields(data.context, "unavailable"), []);
  const records = fixture(Array.from({length: 101}, (_, index) => feature(index === 100 ? {late: true} : {early: 1})));
  assert.deepEqual(printDataSourceFields(records.context, source.layerId), ["early"]);
  const unsafe = fixture([feature(JSON.parse('{"ok":1,"constructor":2,"__proto__":3}'))]);
  assert.deepEqual(printDataSourceFields(unsafe.context, source.layerId), ["ok"]);
  Object.defineProperty(data.geojson, "opengeo", {value: {mayBeTruncated: true}});
  assert.deepEqual(printDataSourceFields(data.context, source.layerId), []);
});

test("browser Layers can have null dataset identity and attribute names remain case-sensitive", () => {
  const data = fixture([feature({Name: "Capitalized label", name: 3})]);
  data.input.inputPin.datasetId = null;delete data.map.definition.layers[0].datasetId;
  const localFrame = {...frame, source: {...source, datasetId: null}, columns: ["Name", "name"]};
  const localPresentation = [{...presentation[0]}];delete localPresentation[0].datasetId;
  const table = capture(data, localFrame, localPresentation);
  assert.equal(table.sourcePin.datasetId, null);assert.deepEqual(table.rows, [["Capitalized label", 3]]);
  const localChart = {...chart, source: localFrame.source, labelField: "Name", valueField: "name"};
  assert.deepEqual(capture(data, localChart, localPresentation).rows, [["Capitalized label", 3]]);
  assert.throws(() => capture(data, {...localChart, valueField: "Name"}, localPresentation), /distinct chart/);
  assert.throws(() => capture(data, {...localFrame, columns: ["Name", "Name"]}, localPresentation), /distinct Print table/);
});

test("literal field admission skips oversized, controlled and reserved names while preserving later exact keys", () => {
  const invalid = ["x".repeat(101), "control\u0001", "control\u007f", "control\u0085", "control\u009f", "Constructor", "PROTOtype", "__PROTO__"];
  const data = fixture([feature(Object.fromEntries([...invalid.map(key => [key, 1]), ["Name", "Capital"], ["name", 2], ["later", 3]]))]);
  assert.deepEqual(printDataSourceFields(data.context, source.layerId), ["Name", "name", "later"]);
  assert.deepEqual(capture(data, {...frame, columns: ["Name", "name", "later"]}).rows, [["Capital", 2, 3]]);
  for (const key of invalid) {
    assert.throws(() => capture(data, {...frame, columns: [key]}), /distinct Print table fields/);
    assert.throws(() => capture(data, {...chart, labelField: key, valueField: "later"}), /distinct chart label/);
  }
  const maximum = "x".repeat(100), admitted = fixture([feature({[maximum]: "exact maximum", name: 1})]);
  assert.deepEqual(printDataSourceFields(admitted.context, source.layerId), [maximum, "name"]);
  assert.deepEqual(capture(admitted, {...frame, columns: [maximum]}).rows, [["exact maximum"]]);
});
