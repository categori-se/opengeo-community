import assert from "node:assert/strict";
import {it} from "node:test";
import {readFile} from "node:fs/promises";
import {captureWorkbenchTourScene, validateWorkbenchTourScene, createWorkbenchTourSceneRuntime, waitForTourPaint} from "../src/lib/workbenchTourSceneRuntime.js";
import {createPlacesDocument, addKmlPlace, placesToGeojson, updateKmlPlace} from "../src/lib/kmlPlaces.js";
import {historicalImageryForSave} from "../src/lib/historicalImagery.js";
import {panoramaFromImageFile} from "../src/lib/panorama.js";

const image = await readFile(new URL("./fixtures/panorama-equirect.png", import.meta.url));
const panorama = await panoramaFromImageFile(new File([image], "panorama.png", {type: "image/png"}), {id: "courtyard", title: "Private courtyard", position: [-71, 42],
  rights: {attribution: "Synthetic acceptance panorama", license: "Private acceptance", privacyReviewed: true, exportAllowed: true}});
function fixture() {
  let document = createPlacesDocument();document = addKmlPlace(document, document.id, {kind: "placemark", id: "site", name: "Original site", geometry: {type: "Point", coordinates: [-71, 42]}});
  document = addKmlPlace(document, document.id, {kind: "placemark", id: "second", name: "Second site", geometry: {type: "Point", coordinates: [-70, 43]}});
  const layer = {layerId: "places", sourceType: "kml-places", kmlDocument: document, visible: true,
    datasetId: "60000000-0000-4000-8000-000000000001", datasetVersionId: "61000000-0000-4000-8000-000000000001", sourceVersion: 1};
  const listeners = new Map(), calls = {jumps: 0, data: [], draws: 0, history: 0, panorama: 0, sunlight: 0}, layout = new Map([["points", "visible"]]);
  let camera = {center: [0, 20], zoom: 4, pitch: 0, bearing: 0, roll: 0};
  const source = {setData: data => calls.data.push(data)};
  const map = {getCenter: () => ({lng: camera.center[0], lat: camera.center[1]}), getZoom: () => camera.zoom, getPitch: () => camera.pitch,
    getBearing: () => camera.bearing, getRoll: () => camera.roll, getSource: id => id === "places-source" ? source : null,
    getLayer: id => id === "points" ? {id} : null, getLayoutProperty: id => layout.get(id), setLayoutProperty: (id, property, value) => layout.set(id, value),
    jumpTo: value => {calls.jumps++;for (const key of ["center", "zoom", "pitch", "bearing", "roll"]) if (Object.hasOwn(value, key)) camera[key] = value[key];},
    isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    getCanvas: () => ({width: 640, height: 360}), on: (type, handler) => listeners.set(type, handler),
    off: (type, handler) => {if (listeners.get(type) === handler) listeners.delete(type);},
    triggerRepaint: () => queueMicrotask(() => listeners.get("render")?.())};
  const context = {state: {map, activeLayerId: "places", selectedKmlPlaceId: "site", layerHandles: new Map([["places", {sourceId: "places-source", layerIds: ["points"], layerVisible: true}]]),
    historicalImagery: historicalImageryForSave(), panoramaCatalog: {schemaVersion: "opengeo.panorama.1.0.0", scenes: [structuredClone(panorama)]}, panoramaView: null},
    layers: [layer], dataByLayerId: new Map([["places", placesToGeojson(document)]]), render() {}};
  const callbacks = {applyHistory: value => {calls.history++;context.state.historicalImagery = structuredClone(value);},
    applySunlight: value => {calls.sunlight++;context.state.historicalImagery.sunlight = structuredClone(value);},
    applyPanorama: value => {calls.panorama++;context.state.panoramaView = value;}};
  const canvas = {width: 640, height: 360, getContext: () => ({fillRect() {}, drawImage() {calls.draws++;}})};
  return {context, callbacks, calls, layer, map, listeners, canvas, camera: () => camera};
}
it("scene capture pins exact KML document and normalized history; mutable document changes invalidate the hash cache", () => {
  const f = fixture(), captured = captureWorkbenchTourScene(f.context);
  assert.equal(captured.place.layerId, "places");assert.match(captured.place.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateWorkbenchTourScene(f.context, captured), captured);
  assert.throws(() => validateWorkbenchTourScene(f.context, {...captured, updates: [{targetId: "site", property: "name", value: ""}]}), /unrepresentable/);
  assert.throws(() => validateWorkbenchTourScene(f.context, {...captured, historicalImagery: {...captured.historicalImagery, sourceRevision: "unknown"}}), /historical_source/);
  f.layer.kmlDocument.children[0].name = "Changed in place";
  assert.throws(() => validateWorkbenchTourScene(f.context, captured), /place_binding_changed/);
});
it("panorama checksum/privacy/binding validation precedes every scene callback and camera mutation", async () => {
  const f = fixture();f.context.state.panoramaView = {sceneId: "courtyard", heading: 20, pitch: 0, fov: 75};
  const captured = captureWorkbenchTourScene(f.context), runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);
  const invalid = {...captured, panorama: {...captured.panorama, assetSha256: "0".repeat(64)}};
  await assert.rejects(runtime.apply({scene: invalid, elapsedMilliseconds: 0}), /panorama_asset_changed/);
  assert.equal(f.calls.history, 0);assert.equal(f.calls.panorama, 0);assert.equal(f.calls.jumps, 0);
  f.context.state.panoramaCatalog.scenes[0].rights.privacyReviewed = false;
  assert.throws(() => validateWorkbenchTourScene(f.context, captured), /privacy/);runtime.dispose();
});
it("Place replay selects its exact loaded identity without moving the native camera", async () => {
  const f = fixture(), scene = captureWorkbenchTourScene(f.context);scene.place.placeId = "second";
  const runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);await runtime.apply({scene, elapsedMilliseconds: 0});
  assert.equal(f.context.state.selectedKmlPlaceId, "second");assert.equal(f.calls.jumps, 0);runtime.dispose();
});
it("runtime updates modify derived render data and restore it without modifying canonical KML or data", async () => {
  const f = fixture(), canonical = structuredClone(f.layer.kmlDocument), originalData = f.context.dataByLayerId.get("places");
  const runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);
  await runtime.apply({scene: {updates: [{targetId: "site", targetType: "Placemark", property: "name", value: "Tour label"},
    {targetId: "site", property: "visibility", value: false}]}, elapsedMilliseconds: 0});
  const rendered = f.calls.data.at(-1).features.find(feature => feature.id === "site");assert.equal(rendered.properties.name, "Tour label");assert.equal(rendered.properties.visibility, false);
  assert.deepEqual(f.layer.kmlDocument, canonical);assert.strictEqual(f.context.dataByLayerId.get("places"), originalData);
  assert.strictEqual(f.context.state.layerHandles.get("places").kmlGeojson, f.calls.data.at(-1));
  runtime.stop();assert.strictEqual(f.calls.data.at(-1), originalData);assert.equal(Object.hasOwn(f.context.state.layerHandles.get("places"), "kmlGeojson"), false);
  const originalRuntimeData = structuredClone(originalData);originalRuntimeData.features[0].properties.retainedRuntimePresentation = true;
  f.context.state.layerHandles.get("places").kmlGeojson = originalRuntimeData;
  await runtime.apply({scene: {updates: [{targetId: "site", property: "name", value: "Another tour label"}]}, elapsedMilliseconds: 0});
  runtime.stop();assert.strictEqual(f.calls.data.at(-1), originalRuntimeData, "Preserve a pre-existing derived source presentation exactly");runtime.dispose();
});
it("stopping updates preserves a concurrent canonical edit instead of restoring stale source data", async () => {
  const f = fixture(), runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);
  await runtime.apply({scene: {updates: [{targetId: "site", property: "name", value: "Tour label"}]}, elapsedMilliseconds: 0});
  f.layer.kmlDocument = updateKmlPlace(f.layer.kmlDocument, "site", {name: "New canonical title"});
  f.context.dataByLayerId.set("places", placesToGeojson(f.layer.kmlDocument));runtime.stop();
  assert.equal(f.calls.data.at(-1).features.find(feature => feature.id === "site").properties.name, "New canonical title");
  assert.equal(f.layer.kmlDocument.children[0].name, "New canonical title");runtime.dispose();
});
it("movie bridge waits for painted resident data, captures a frame and restores camera, imagery, selection and visibility", async () => {
  const f = fixture(), original = structuredClone(f.camera()), scene = captureWorkbenchTourScene(f.context);
  const originalHistory = f.callbacks.applyHistory;
  f.callbacks.applyHistory = value => {
    originalHistory(value);
    f.context.state.layerHandles.set("places", {sourceId: "places-source", layerIds: ["points"], layerVisible: true});
  };
  const runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks), camera = {center: [-71, 42], zoom: 12, pitch: 25, bearing: 12, roll: 17};
  await runtime.renderMovieFrame({scene, camera, elapsedMilliseconds: 0, layerVisibility: [{layerId: "places", datasetId: f.layer.datasetId,
    datasetVersionId: f.layer.datasetVersionId, sourceVersion: 1, visible: false}]}, {canvas: f.canvas});
  assert.deepEqual(f.camera(), camera);assert.equal(f.calls.draws, 1);assert.equal(f.layer.visible, false);
  assert.equal(f.context.state.layerHandles.get("places").layerVisible, false, "Use the handles installed by the scene's new history style");
  await runtime.restoreMovie();assert.deepEqual(f.camera(), original);assert.equal(f.layer.visible, true);assert.equal(f.context.state.selectedKmlPlaceId, "site");
  assert.equal(f.context.state.layerHandles.get("places").layerVisible, true);runtime.dispose();
});
it("private panoramas without export review cannot mutate or enter a movie frame", async () => {
  const f = fixture();f.context.state.panoramaCatalog.scenes[0].rights.exportAllowed = false;
  f.context.state.panoramaView = {sceneId: "courtyard", heading: 0, pitch: 0, fov: 75};
  const scene = captureWorkbenchTourScene(f.context), runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);
  await assert.rejects(runtime.renderMovieFrame({scene, camera: f.camera(), elapsedMilliseconds: 0}, {canvas: f.canvas}), /export_review/);
  assert.equal(f.calls.jumps, 0);assert.equal(f.calls.history, 0);assert.equal(f.calls.draws, 0);runtime.dispose();
});
it("cancelled native-paint readiness removes owned listeners and disposed scope cannot resume", async () => {
  const f = fixture();f.map.triggerRepaint = () => {};
  const controller = new AbortController(), pending = waitForTourPaint(f.map, controller.signal);
  const rejected = assert.rejects(pending, /cancel/);controller.abort(Error("cancel"));await rejected;assert.equal(f.listeners.has("render"), false);
  const runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);runtime.dispose();
  await assert.rejects(runtime.apply({scene: null, elapsedMilliseconds: 0}), /disposed/);
});
it("the native history callback receives the caller abort signal and stops later scene work", async () => {
  const f = fixture(), controller = new AbortController();let received, entered;
  const started = new Promise(resolve => {entered = resolve;});
  f.callbacks.applyHistory = (value, options) => {
    received = options?.signal;entered();
    if (!received) throw Error("Missing scene abort signal");
    return new Promise((resolve, reject) => received.addEventListener("abort", () => reject(received.reason), {once: true}));
  };
  const runtime = createWorkbenchTourSceneRuntime(f.context, f.callbacks);
  const pending = runtime.apply({scene: captureWorkbenchTourScene(f.context), elapsedMilliseconds: 0}, {signal: controller.signal});
  const handled = pending.then(() => null, error => error);
  try {
    await started;assert.equal(received, controller.signal);controller.abort(Error("cancel delayed history"));
    assert.match((await handled).message, /cancel delayed history/);assert.equal(f.calls.sunlight, 0);assert.equal(f.calls.panorama, 0);
  } finally {controller.abort(Error("test cleanup"));await handled;runtime.dispose();}
});
