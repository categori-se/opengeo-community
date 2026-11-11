import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {planPrintAtlas, capturePrintAtlas} from "../src/lib/printAtlas.js";
import {rasterPagePdf, rasterPagesPdf} from "../src/lib/figurePrintPack.js";

test("feature atlas preserves source identity, emits ordered PDF pages, and restores camera on completion, failure and cancellation", async () => {
  const layer = {layerId: "coverage", datasetId: "dataset", sourceVersion: 3};
  const data = {type: "FeatureCollection", features: [
    {type: "Feature", id: "west", properties: {name: "West"}, geometry: {type: "Point", coordinates: [-10, 20]}},
    {type: "Feature", id: "east", properties: {name: "East"}, geometry: {type: "Polygon", coordinates: [[[10, 20], [12, 20], [12, 22], [10, 20]]]}}
  ]};
  const source = {id: layer.layerId, geojson: data, inputPin: {layerId: layer.layerId, datasetId: layer.datasetId, sourceVersion: 3}};
  const listeners = new Map();
  const original = {center: [1, 2], zoom: 4, pitch: 12, bearing: 15};
  let camera = structuredClone(original), padding = {top: 3, bottom: 4, left: 5, right: 6};
  const map = {
    getCenter: () => ({lng: camera.center[0], lat: camera.center[1]}), getZoom: () => camera.zoom,
    getPitch: () => camera.pitch, getBearing: () => camera.bearing, getPadding: () => ({...padding}),
    setPadding: value => {padding = {...value};}, getProjection: () => ({type: "mercator"}),
    isMoving: () => false, isStyleLoaded: () => true, areTilesLoaded: () => true, loaded: () => true,
    cameraForBounds: bounds => ({center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2], zoom: 8}),
    jumpTo: value => {camera = {center: [...value.center], zoom: value.zoom, pitch: value.pitch, bearing: value.bearing};},
    on: (name, callback) => {if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback);},
    off: (name, callback) => listeners.get(name)?.delete(callback),
    triggerRepaint: () => queueMicrotask(() => {for (const callback of [...listeners.get("render") ?? []]) callback();})
  };
  const context = {map, renderer: "maplibre", ready: true, layers: [layer], project: {projection: "mercator"}, getPrintDataSource: () => source};
  const plan = planPrintAtlas(context, {layerId: layer.layerId, featureNumbers: "2, 1", labelField: "name"});
  assert.deepEqual(plan.pages.map(page => page.label), ["East", "West"]);
  assert.deepEqual(plan.sourcePin, {layerId: "coverage", datasetId: "dataset", datasetVersionId: null, sourceVersion: 3, featureGeneration: null, checksumSha256: null});
  assert.throws(() => planPrintAtlas(context, {layerId: layer.layerId, featureNumbers: "1,1"}), /distinct/);
  const seen = [];
  const pages = await capturePrintAtlas(context, plan, {capturePage: async page => {seen.push([...camera.center]);return page.label;}});
  assert.deepEqual(pages, ["East", "West"]); assert.deepEqual(seen, [[11, 21], [-10, 20]]); assert.deepEqual(camera, original);
  const initialPadding = {...padding};
  await assert.rejects(capturePrintAtlas(context, plan, {capturePage: async () => {throw Error("capture failed");}}), /capture failed/);
  assert.deepEqual(camera, original); assert.deepEqual(padding, initialPadding);
  const controller = new AbortController();
  await assert.rejects(capturePrintAtlas(context, plan, {signal: controller.signal, capturePage: async () => {controller.abort(Error("user canceled"));}}), /user canceled/);
  assert.deepEqual(camera, original); assert.equal([...listeners.values()].reduce((sum, group) => sum + group.size, 0), 0);
  data.features[0].geometry.coordinates = [-11, 20];
  await assert.rejects(capturePrintAtlas(context, plan, {capturePage: async () => assert.fail("Changed source must not capture")}), /features changed/);
  assert.deepEqual(camera, original);
  const jpeg = Uint8Array.of(255, 216, 255, 217), paper = {widthMm: 297, heightMm: 210};
  const pdf = rasterPagesPdf([{jpeg, width: 10, height: 8}, {jpeg, width: 10, height: 8}], paper);
  const text = new TextDecoder().decode(pdf);
  assert.match(text, /\/Count 2 \/Kids \[3 0 R 6 0 R\]/); assert.match(text, /\/PageImage 8 0 R/);
  assert.throws(() => rasterPagesPdf(Array.from({length: 33}, () => ({jpeg, width: 10, height: 8})), paper), /invalid/);
  // Exact one-page bytes retained from private23c720 before the multipage change.
  assert.equal(createHash("sha256").update(rasterPagePdf(jpeg, {width: 10, height: 8, ...paper})).digest("hex"),
    "c6f7d0dbddcf20047e9cd61cdff336c23d74896320a247a137c16d502b00198b");
});
