import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {TourMediaControls} from "../src/components/TourMediaControls.js";
import {createCameraTour} from "../src/lib/cameraTour.js";

const wait = async predicate => {for (let i = 0; i < 100; i++) {if (predicate()) return;await new Promise(resolve => setTimeout(resolve, 0));}assert.fail("Media control callback did not settle");};
function setup(overrides = {}) {
  const dom = new JSDOM("<!doctype html><body></body>"), calls = {mutations: [], downloads: [], stopped: 0, restored: 0, disposedPlayer: 0};
  let editable = true, tour = createCameraTour({camera: {center: [0, 20], zoom: 4, pitch: 0, bearing: 0}});
  const props = {document: dom.window.document, getTour: () => tour, getKeyframeId: () => "view-1",
    getMap: () => ({getCenter: () => ({lng: -71, lat: 42}), getZoom: () => 8, getPitch: () => 25, getBearing: () => 12, getRoll: () => 17}),
    canEdit: () => editable, assertScope: () => {}, captureScene: () => ({sunlight: {dateTime: "2026-11-11T12:00:00Z"}}),
    replaceTour: next => {calls.mutations.push(next);tour = next;}, getAttribution: () => "Required map credit",
    renderFrame: () => {}, stopPlayback: () => calls.stopped++, restoreAfterMovie: () => calls.restored++, disposePlayer: () => calls.disposedPlayer++,
    download: (filename, data, mime) => calls.downloads.push({filename, data, mime}), ...overrides};
  const controls = TourMediaControls(props);dom.window.document.body.append(controls.element);
  const button = name => {const node = [...controls.element.querySelectorAll("button")].find(node => node.textContent === name);assert(node, name);return node;};
  const field = name => {const node = controls.element.querySelector(`[aria-label="${name}"]`);assert(node, name);return node;};
  return {dom, calls, controls, props, button, field, editable(value) {editable = value;controls.update();},
    status: () => controls.element.querySelector('[role="status"]').textContent,
    close() {controls.dispose();dom.window.close();}};
}
it("recording a scene uses selected-view edit authority and captures the current native roll", async () => {
  const h = setup();
  try {
    h.editable(false);assert.equal(h.button("Record current scene").disabled, true);
    h.button("Record current scene").dispatchEvent(new h.dom.window.Event("click"));await wait(() => /Editing/.test(h.status()));
    assert.equal(h.calls.mutations.length, 0);
    h.editable(true);h.button("Record current scene").click();await wait(() => h.calls.mutations.length === 1);
    const tour = h.calls.mutations[0];assert.equal(tour.schemaVersion, "opengeo.camera-tour.1.2.0");
    assert.equal(tour.keyframes[0].camera.roll, 17);assert.equal(tour.keyframes[0].scene.sunlight.dateTime, "2026-11-11T12:00:00Z");
  } finally {h.close();}
});
it("scene recording and audio events retain independent fields and validate the combined scene", async () => {
  const validated = [], h = setup({validateScene: scene => validated.push(structuredClone(scene))});
  try {
    h.button("Record current scene").click();await wait(() => h.calls.mutations.length === 1);
    h.button("Stop audio at this view").click();await wait(() => h.calls.mutations.length === 2);
    assert.equal(h.calls.mutations[1].keyframes[0].scene.sunlight?.dateTime, "2026-11-11T12:00:00Z");
    assert.equal(h.calls.mutations[1].keyframes[0].scene.audio.action, "stop");
    assert.equal(validated.at(-1).sunlight.dateTime, "2026-11-11T12:00:00Z");
    h.button("Record current scene").click();await wait(() => h.calls.mutations.length === 3);
    assert.equal(h.calls.mutations[2].keyframes[0].scene.audio.action, "stop");
    assert.equal(validated.at(-1).audio.action, "stop");
  } finally {h.close();}
});
it("an awaited scene cannot mutate after Project authority changes", async () => {
  let resolve, requested = false;
  const h = setup({captureScene: () => {requested = true;return new Promise(done => {resolve = done;});}});
  try {
    h.button("Record current scene").click();await wait(() => requested);h.editable(false);
    resolve({place: {layerId: "places", placeId: "survey"}});await wait(() => /changed/.test(h.status()));
    assert.equal(h.calls.mutations.length, 0);
  } finally {h.close();}
});
it("narration needs explicit rights, and cancellation/disposal prevents a late clip mutation", async () => {
  let requests = 0, recorderStops = 0, signal;
  const h = setup({recordNarration: async options => {
    requests++;signal = options.signal;
    const result = new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
    void result.catch(() => {});
    return {result, stop: () => recorderStops++};
  }});
  try {
    h.button("Record narration").click();await wait(() => /Enter audio attribution/.test(h.status()));assert.equal(requests, 0);
    h.field("Audio attribution").value = "Project narrator";h.field("Audio license or permitted use").value = "Private permitted use";
    h.button("Record narration").click();await wait(() => !h.button("Stop narration").disabled);
    h.button("Cancel narration").click();await wait(() => /cancelled/.test(h.status()));assert.equal(signal.aborted, true);
    assert.equal(h.calls.mutations.length, 0);await wait(() => !h.button("Record narration").disabled);
    h.button("Record narration").click();await wait(() => !h.button("Stop narration").disabled);
    h.controls.dispose();assert.equal(signal.aborted, true);assert.equal(recorderStops, 1);assert.equal(h.calls.disposedPlayer, 1);
    assert.equal(requests, 2, "Each microphone request follows one explicit Record action");
  } finally {h.close();}
});
it("movie export uses declared size/rate/credits and returns exactly the movie and report through the normal download callback", async () => {
  let options;
  const h = setup({encodeMovie: async (tour, value) => {options = value;await value.renderFrame({camera: tour.keyframes[0].camera});
    value.onProgress({completedFrames: 1, totalFrames: 1});return {blob: new Blob(["synthetic peer"]), report: {capturedFrames: 1}};}});
  try {
    h.field("Movie frame size").value = "1280x720";h.field("Movie frame rate").value = "24";h.field("Additional movie credits").value = "Narrative credit";
    h.button("Export tour movie").click();await wait(() => h.calls.downloads.length === 2);
    assert.deepEqual([options.width, options.height, options.frameRate], [1280, 720, 24]);
    assert.equal(options.attribution, "Required map credit · Narrative credit");
    assert.deepEqual(h.calls.downloads.map(value => value.filename), ["tour.webm", "tour-movie-report.json"]);
    assert.equal(JSON.parse(h.calls.downloads[1].data).capturedFrames, 1);await wait(() => h.calls.restored === 1);
    assert.equal(h.calls.stopped, 1);assert.equal(h.calls.mutations.length, 0);
  } finally {h.close();}
});
it("cancelled movie capture restores the prior scene and downloads no partial artifact", async () => {
  let started = false;
  const h = setup({encodeMovie: async (tour, options) => {started = true;return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), {once: true}));}});
  try {
    h.button("Export tour movie").click();await wait(() => started);h.button("Cancel movie export").click();await wait(() => h.calls.restored === 1);
    assert.equal(h.calls.downloads.length, 0);assert.match(h.status(), /cancelled/);
  } finally {h.close();}
});
