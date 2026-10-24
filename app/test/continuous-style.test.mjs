import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {it} from "node:test";
import {continuousColorExpression, continuousStyleDefinition, normalizeContinuousScale,
  parseContinuousColorExpression} from "../src/lib/continuousStyle.js";
import {resolveLayerStyle} from "../src/lib/layerStyleReference.js";

const require = createRequire(import.meta.url), {createExpression} = require("@maplibre/maplibre-gl-style-spec");
const scale = {field: "amount", stops: [{value: -20, color: "#000000"}, {value: 0, color: "#ff0000"},
  {value: 80, color: "#ffffff"}], noDataColor: "#11223380"};
const preset = {geometry: "fill", stops: scale.stops, opacity: .75, outlineColor: "#abcdef", outlineWidth: .5, nullColor: scale.noDataColor};
const uuid = "d0000000-0000-4000-8000-000000000002";

async function resolve(definition, geometryType = "MultiPolygon") {
  const checksumSha256 = createHash("sha256").update(definition).digest("hex");
  const style = {id: uuid, resourceId: uuid, title: "Continuous", versionNumber: 2, format: "maplibre", definition, checksumSha256};
  const styleReference = {projectId: uuid, resourceId: uuid, styleId: uuid, versionNumber: 2, format: "maplibre", checksumSha256};
  return resolveLayerStyle({getResource: async () => ({id: uuid, projectId: uuid, datasetId: uuid}),
    getResourceStyleVersion: async () => style}, {datasetId: uuid, geometryType, styleReference});
}

it("round-trips the closed guarded scale without sharing editable stop records", () => {
  const normalized = normalizeContinuousScale(scale), expression = continuousColorExpression(scale);
  assert.deepEqual(parseContinuousColorExpression(expression), scale);
  normalized.stops[0].value = -30;
  assert.equal(scale.stops[0].value, -20);
  const parsed = parseContinuousColorExpression(expression);parsed.stops[0].color = "#123456";
  assert.equal(expression[2][4], "#000000");
  assert.equal(normalizeContinuousScale({...scale, stops: Array.from({length: 22}, (_, value) => ({value, color: "#123456"}))}).stops.length, 22);
});

it("interpolates actual MapLibre interior values across unequal numeric intervals and preserves unknowns", () => {
  const compiled = createExpression(continuousColorExpression(scale), "fill-color", {type: "color"});
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  const evaluate = properties => compiled.value.evaluate({}, {type: 3, properties});
  for (const [amount, expected] of [[-100, [0, 0, 0]], [-10, [.5, 0, 0]], [0, [1, 0, 0]], [40, [1, .5, .5]], [100, [1, 1, 1]]]) {
    const result = evaluate({amount});
    for (const [index, component] of ["r", "g", "b"].entries()) assert.ok(Math.abs(result[component] - expected[index]) < 1e-9, `${amount} ${component}`);
  }
  const fallback = createExpression(scale.noDataColor, "fill-color", {type: "color"}).value.evaluate({});
  for (const properties of [{}, {amount: null}, {amount: "40"}, {amount: false}, {amount: "unknown"}]) {
    assert.equal(evaluate(properties).toString(), fallback.toString());
  }
});

it("rejects unsafe fields, open records, unordered domains, alpha ramp colors and excessive bounds", () => {
  for (const invalid of [null, {...scale, extra: true}, {...scale, field: "Constructor"}, {...scale, field: "safe.__proto__"},
    {...scale, field: "https://example.test"}, {...scale, stops: []}, {...scale, stops: [scale.stops[0]]},
    {...scale, stops: Array.from({length: 23}, (_, value) => ({value, color: "#123456"}))},
    {...scale, stops: [{value: 0, color: "#000000"}, {value: 0, color: "#ffffff"}]},
    ...[NaN, Infinity, 1e15 + 1, "10"].map(value => ({...scale, stops: [{value: 0, color: "#000000"}, {value, color: "#ffffff"}]})),
    {...scale, stops: [{value: 0, color: "#00000000"}, {value: 1, color: "#ffffff"}]},
    {...scale, stops: [{value: 0, color: "#000000", extra: true}, {value: 1, color: "#ffffff"}]},
    {...scale, noDataColor: "url(https://example.test)"}]) assert.throws(() => normalizeContinuousScale(invalid));
});

it("parses only the exact numeric guard and linear interpolation over the same safe field", () => {
  const valid = continuousColorExpression(scale), changed = mutate => {const copy = structuredClone(valid);mutate(copy);return copy;};
  for (const value of [null, [], ["interpolate", ["linear"], ["get", "amount"], 0, "#000000", 1, "#ffffff"],
    changed(copy => copy.push("extra")), changed(copy => copy[1][0] = "!="), changed(copy => copy[1][1][1].push("fallback")),
    changed(copy => copy[2][0] = "interpolate-hcl"), changed(copy => copy[2][1] = ["exponential", 2]),
    changed(copy => copy[2][2][1] = "other"), changed(copy => copy[2][2] = ["to-number", ["get", "amount"], -1]),
    changed(copy => copy[2][4] = ["get", "color"]), changed(copy => copy[2][3] = -1e16)]) {
    assert.equal(parseContinuousColorExpression(value), null);
  }
});

it("resolves exact pinned fill and line definitions with bounded original furniture and no external dependencies", async () => {
  for (const [geometry, geometryType] of [["fill", "MultiPolygon"], ["line", "LineString"]]) {
    const definition = continuousStyleDefinition({...preset, geometry}, scale.field, "Unequal scale");
    const document = JSON.parse(definition), resolved = await resolve(definition, geometryType);
    assert.deepEqual(document.sources, {});
    assert.equal(document.name, "Unequal scale");
    assert.deepEqual(parseContinuousColorExpression(resolved.parts[0].paint[`${geometry}-color`]), scale);
    assert.equal(resolved.parts[0].paint[`${geometry}-opacity`], .75);
    if (geometry === "fill") {
      assert.equal(resolved.parts[0].paint["fill-outline-color"], "#abcdef");
      assert.equal(resolved.parts[1].paint["line-width"], .5);
    }
  }
  for (const invalid of [{...preset, opacity: 1.1}, {...preset, outlineWidth: 9}, {...preset, geometry: "circle"},
    {...preset, outlineColor: "url(https://example.test)"}, {...preset, source: "https://example.test"}]) {
    assert.throws(() => continuousStyleDefinition(invalid, scale.field, "Invalid"));
  }
});

it("refuses unsafe expression variants through the actual reusable Style resolver", async () => {
  const document = JSON.parse(continuousStyleDefinition(preset, scale.field, "Scale"));
  for (const alter of [expression => expression[2][1].push(2), expression => expression[1][1][1][1] = "Constructor",
    expression => expression[2][4] = "#00000080", expression => expression[2][5] = -20]) {
    const changed = structuredClone(document);alter(changed.layers[0].paint["fill-color"]);
    await assert.rejects(resolve(JSON.stringify(changed)), /Unsupported Style color/);
  }
  const outline = structuredClone(document);outline.layers[0].paint["fill-outline-color"] = continuousColorExpression(scale);
  await assert.rejects(resolve(JSON.stringify(outline)), /Unsupported Style color/);
  for (const field of ["circle-color", "circle-stroke-color"]) {
    const paint = {"circle-color": "#123456", "circle-radius": 6, "circle-opacity": 1,
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 1, "circle-stroke-opacity": 1};
    paint[field] = continuousColorExpression(scale);
    await assert.rejects(resolve(JSON.stringify({version: 8, sources: {}, layers: [{id: "points", type: "circle", paint}]}), "Point"), /Unsupported Style color/);
  }
});
