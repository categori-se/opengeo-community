import assert from "node:assert/strict";
import {test} from "node:test";
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {capturePrintVectorScene, assertPrintVectorScene, PRINT_VECTOR_LIMITS} from "../src/lib/printVectorScene.js";

const source = {layerId: "loaded", datasetId: "dataset", datasetVersionId: "synthetic-v1", sourceVersion: 1};
const feature = (geometry, properties = {}, id = 5) => ({type: "Feature", id, properties, geometry});
const polygon = {type: "Polygon", coordinates: [
  [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]]};
const line = {type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[1, 0], [2, 1]]]};
function fixture(features = [feature(polygon)], parts = [
  {id: "background", type: "background", paint: {"background-color": "#fff"}},
  {id: "fill", type: "fill", source: "loaded-source", paint: {"fill-color": "#22c55e", "fill-opacity": 0.45}},
  {id: "outline", type: "line", source: "loaded-source", paint: {"line-color": "#15803d", "line-width": 2}}
]) {
  const geojson = {type: "FeatureCollection", features};
  const layer = {...source, title: "Real loaded Layer", visible: true, opacity: 1, style: {}, labels: {}};
  const input = {id: source.layerId, geojson, inputPin: {...source, featureGeneration: 3, checksumSha256: "a".repeat(64)}};
  const style = {version: 8, sources: {"loaded-source": {type: "geojson", data: structuredClone(geojson)}}, layers: parts};
  const queries = [];
  const map = {getStyle: () => style, getCanvas: () => ({clientWidth: 800, clientHeight: 500}),
    loaded: () => true, style: {hasTransitions: () => false}, getLayersOrder: () => style.layers.map(part => part.id),
    getCenter: () => ({lng: 1, lat: 1}), getZoom: () => 6, getPitch: () => 0, getBearing: () => 0,
    getProjection: () => ({type: "mercator"}), getTerrain: () => null, isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    project: ([lng, lat]) => ({x: 100 + lng * 30, y: 200 - lat * 30}),
    unproject: ([x, y]) => ({lng: x / 100 - 4, lat: 3 - y / 100}),
    getFeatureState: identifier => {queries.push(identifier);return {hover: identifier.id === 5};},
    queryRenderedFeatures: () => {throw Error("must not sample tile fragments");}};
  const context = {map, renderer: "maplibre", ready: true, layers: [layer], project: {projection: "mercator"},
    handles: new Map([[source.layerId, {sourceId: "loaded-source", layerIds: parts.filter(part => part.source).map(part => part.id)}]]),
    getPrintDataSource: id => id === source.layerId ? input : null};
  return {context, mapRecord: {id: "project", definition: {layers: [structuredClone(layer)]}}, input, layer, style, map, queries};
}
const capture = data => capturePrintVectorScene(data.context, data.mapRecord);
function reseal(scene) {
  const {checksumSha256, ...payload} = scene;
  scene.checksumSha256 = [...sha256(new TextEncoder().encode(canonicalJson(payload)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return scene;
}

test("captures genuine complete-source polygon holes and ordered passes without sampling or mutations", () => {
  const data = fixture(), before = structuredClone({style: data.style, input: data.input, layer: data.layer});
  const scene = capture(data);
  assert.deepEqual(scene.passes.map(pass => pass.id), ["background", "fill", "outline"]);
  assert.equal(scene.passes[0].commands[0].kind, "rect");
  const fill = scene.passes[1].commands[0];
  assert.equal(fill.kind, "path");assert.equal(fill.closed, true);assert.equal(fill.points.length, 2);
  assert.deepEqual(fill.points[0][0], [100, 200]);assert.deepEqual(fill.points[1][0], [130, 170]);
  assert.equal(fill.fillOpacity, 0.45);assert.equal(fill.stroke, null);assert.equal(fill.strokeWidth, 0);assert.equal(scene.passes[2].commands.length, 2);
  assert.equal(scene.sourcePins[0].featureCount, 1);assert.equal(scene.sourcePins[0].datasetVersionId, "synthetic-v1");
  assert.match(scene.sourcePins[0].geometryChecksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(assertPrintVectorScene(scene, {cssWidth: 800, cssHeight: 500, view: scene.view, signature: scene.signature}), scene);
  assert.deepEqual({style: data.style, input: data.input, layer: data.layer}, before);
});

test("evaluates installed filters, continuous feature colors, actual zoom and current feature state", () => {
  const parts = [{id: "circles", type: "circle", source: "loaded-source", filter: ["==", ["get", "keep"], true], paint: {
    "circle-color": ["interpolate", ["linear"], ["get", "value"], 0, "#000000", 10, "#ffffff"],
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 11],
    "circle-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.25, 0.5],
    "circle-stroke-color": "rgba(0,0,255,0.5)", "circle-stroke-width": 2, "circle-stroke-opacity": 0.2}}];
  const data = fixture([feature({type: "Point", coordinates: [1, 1]}, {keep: true, value: 5}),
    feature({type: "Point", coordinates: [2, 2]}, {keep: false, value: 10}, 9)], parts);
  const scene = capture(data), circle = scene.passes[0].commands[0];
  assert.equal(scene.passes[0].commands.length, 2);assert.equal(circle.r, 7);assert.equal(circle.fillOpacity, 0.25);
  assert.equal(circle.fill, "rgb(127.5 127.5 127.5)");assert.equal(circle.strokeOpacity, 0);
  const stroke = scene.passes[0].commands[1];
  assert.equal(stroke.fill, null);assert.equal(stroke.r, 8);assert.equal(stroke.strokeWidth, 2);assert.equal(stroke.strokeOpacity, 0.1);
  assert.equal(stroke.r + stroke.strokeWidth / 2, 9);
  assert.deepEqual(data.queries, [{source: "loaded-source", id: 5}]);
});

test("preserves per-feature alpha separately from composite pass opacity and multipart order", () => {
  const data = fixture([feature(line), feature({type: "MultiPoint", coordinates: [[0, 0], [1, 1]]})], [
    {id: "lines", type: "line", source: "loaded-source", paint: {"line-color": "rgba(255,0,0,0.5)", "line-opacity": 0.4, "line-layer-opacity": 0.3}},
    {id: "points", type: "circle", source: "loaded-source", paint: {"circle-color": "blue", "circle-radius": 2}}
  ]);
  const scene = capture(data);
  assert.equal(scene.passes[0].layerOpacity, 0.3);assert.equal(scene.passes[0].commands.length, 2);
  assert.equal(scene.passes[0].commands[0].strokeOpacity, 0.2);assert.equal(scene.passes[1].commands.length, 2);
  assert.deepEqual(scene.passes[0].commands[1].points, [[[130, 200], [160, 170]]]);
});

test("upstream geometry-type and legacy $type filters recognize full-source multipart feature types", () => {
  // Pinned EvaluationContext.geometryType accepts both the tile numeric type
  // and a GeoJSON base-type string; preserve that official evaluator behavior.
  for (const filter of [["==", ["geometry-type"], "LineString"], ["==", "$type", "LineString"]]) {
    const data = fixture([feature(polygon), feature(line, {}, 6)], [
      {id: "geometry-filter", type: "line", source: "loaded-source", filter, paint: {"line-color": "#000", "line-width": 2}}
    ]);
    const commands = capture(data).passes[0].commands;
    assert.equal(commands.length, 2);assert.ok(commands.every(command => command.closed === false));
    assert.deepEqual(commands[1].points, [[[130, 200], [160, 170]]]);
  }
});

test("ignores hidden/inactive passes and refuses every unsupported visible pass", () => {
  for (const type of ["symbol", "raster", "fill-extrusion", "heatmap", "custom"]) {
    const data = fixture();data.style.layers.push({id: "unsupported", type, source: "remote"});
    assert.throws(() => capture(data), /unsupported|not supported/i);
    data.style.layers.at(-1).layout = {visibility: "none"};assert.doesNotThrow(() => capture(data));
    data.style.layers.at(-1).layout = {};data.style.layers.at(-1).minzoom = 7;assert.doesNotThrow(() => capture(data));
    delete data.style.layers.at(-1).minzoom;data.style.layers.at(-1).maxzoom = 6;assert.doesNotThrow(() => capture(data));
  }
  const data = fixture();data.style.layers[1].paint["fill-pattern"] = "sprite";assert.throws(() => capture(data), /unsupported paint/);
  delete data.style.layers[1].paint["fill-pattern"];data.style.layers[1].paint["fill-outline-color"] = "#123456";
  assert.throws(() => capture(data), /explicit antialiased fill outline/);
});

test("refuses transitioning target paint and custom WebGL content omitted by getStyle", () => {
  const data = fixture();data.map.style.hasTransitions = () => true;
  assert.throws(() => capture(data), /paint transitions/);
  data.map.style.hasTransitions = () => false;data.map.loaded = () => false;
  assert.throws(() => capture(data), /map loading/);
  data.map.loaded = () => true;data.map.getLayersOrder = () => [...data.style.layers.map(part => part.id), "custom-gl"];
  assert.throws(() => capture(data), /custom or unenumerated/);
});

test("refuses worker source filters, tile-zoom filters and SVG-incompatible miter limits", () => {
  const data = fixture();data.style.sources["loaded-source"].filter = ["==", ["get", "hidden"], false];
  assert.throws(() => capture(data), /source-level worker filter/);
  delete data.style.sources["loaded-source"].filter;
  data.style.layers[1].filter = [">=", ["zoom"], 6];data.map.getZoom = () => 6.5;
  assert.throws(() => capture(data), /zoom-dependent filter/);
  delete data.style.layers[1].filter;data.style.layers[2].layout = {"line-miter-limit": 0};
  assert.throws(() => capture(data), /unsupported line joins/);
  data.style.layers[2].layout["line-miter-limit"] = 1;
  assert.equal(capture(data).passes[2].commands[0].miterLimit, 1);
});

test("omits arbitrary pass metadata and verifies resolved reusable Style appearance and source receipts", () => {
  const data = fixture();data.style.layers[1].metadata = {sourceUrl: "https://provider.invalid/private", nested: {token: "private"}};
  const scene = capture(data);
  assert.equal(scene.passes[1].installed.metadata, undefined);assert.ok(!JSON.stringify(scene).includes("provider.invalid"));
  const reference = {projectId: "11111111-1111-1111-1111-111111111111", resourceId: "22222222-2222-2222-2222-222222222222",
    styleId: "33333333-3333-3333-3333-333333333333", versionNumber: 2, checksumSha256: "b".repeat(64), format: "maplibre"};
  data.layer.styleReference = reference;
  const parts = data.style.layers.slice(1).map((part, index) => ({...part, id: `loaded-style-${index}`,
    paint: {...part.paint, [`${part.type}-opacity`]: part.paint?.[`${part.type}-opacity`] ?? 1}}));
  data.style.layers.splice(1, 2, ...parts);
  const handle = data.context.handles.get("loaded");handle.layerIds = parts.map(part => part.id);
  handle.boundStyle = {reference, parts: parts.map(part => ({...structuredClone(part), id: part.type}))};
  const pinned = capture(data);assert.deepEqual(pinned.sourcePins[0].styleReference, reference);
  parts[0].paint["fill-opacity"] = 0.6;
  // Bound Style bytes are independent of the installed pass, as in Workbench.
  handle.boundStyle.parts[0].paint = {"fill-color": "#22c55e", "fill-opacity": 0.45};
  assert.throws(() => capture(data), /differs from the pinned Style/);
  const missingPin = structuredClone(scene);delete missingPin.sourcePins[0].sourceVersion;reseal(missingPin);
  assert.throws(() => assertPrintVectorScene(missingPin), /source receipt/);
});

test("refuses partial/mismatched sources, missing receipt pins, clustering and unresolved Style bindings", () => {
  const changes = [data => {data.input.geojson.opengeo = {mayBeTruncated: true};},
    data => {data.input.geojson.opengeo = {schemaVersion: "opengeo.live-feature-page.1.0.0"};},
    data => {data.style.sources["loaded-source"].data.features[0].geometry.coordinates[0][0][0] = 0.5;},
    data => {data.style.sources["loaded-source"].data = "https://provider.invalid/data.geojson";},
    data => {delete data.input.inputPin.datasetVersionId;}, data => {data.mapRecord.definition.layers[0].sourceVersion = 2;},
    data => {data.layer.managedDisplayId = "tiles";}, data => {data.layer.pointClustering = {enabled: true};},
    data => {data.style.sources["loaded-source"].cluster = true;}, data => {data.layer.styleReference = {styleId: "unresolved"};}];
  for (const change of changes) {const data = fixture();change(data);assert.throws(() => capture(data), /Vector output:/);}
});

test("admits Studio's invisible flat-view sky settings while refusing nonflat frames and terrain", () => {
  const flat = fixture();flat.style.sky = {"sky-color": "#061526", "horizon-color": "#dbeafe",
    "fog-color": "#93c5fd", "sky-horizon-blend": 0.45, "horizon-fog-blend": 0.35,
    "fog-ground-blend": 0.25, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 0]};
  assert.doesNotThrow(() => capture(flat));
  flat.map.getPitch = () => 1;assert.throws(() => capture(flat), /unpitched Earth Mercator/);
  for (const change of [data => {data.map.getPitch = () => 20;}, data => {data.map.getProjection = () => ({type: "globe"});},
    data => {data.map.getTerrain = () => ({source: "dem"});}, data => {data.context.ready = false;},
    data => {data.map.unproject = () => ({lng: 181, lat: 0});}]) {
    const data = fixture();change(data);assert.throws(() => capture(data), /Vector output:/);
  }
  const data = fixture([feature({type: "LineString", coordinates: [[179, 0], [-179, 1]]})]);
  assert.throws(() => capture(data), /antimeridian/);
});

test("bounded scenes fail before partial exports and validators reject tampering and unsafe SVG values", () => {
  const tooMany = fixture(Array.from({length: PRINT_VECTOR_LIMITS.features + 1}, () => feature(null)));
  assert.throws(() => capture(tooMany), /full-source feature limit/);
  const data = fixture(), scene = capture(data);
  const changed = structuredClone(scene);changed.passes[1].commands[0].points[0][0][0]++;
  assert.throws(() => assertPrintVectorScene(changed), /changed/);
  changed.passes[1].commands[0].fill = "url(https://provider.invalid/image.svg)";reseal(changed);
  assert.throws(() => assertPrintVectorScene(changed), /invalid paint/);
  const extra = structuredClone(scene);extra.passes[0].commands[0].onclick = "alert(1)";reseal(extra);
  assert.throws(() => assertPrintVectorScene(extra), /invalid/);
  assert.throws(() => assertPrintVectorScene(scene, {cssWidth: 801, cssHeight: 500, view: scene.view, signature: scene.signature}), /no longer matches/);
});
