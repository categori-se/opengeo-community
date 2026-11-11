import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {createMapController, mapControllerCamera, mapControllerInput} from "../src/lib/mapController.js";
import {MapControllerControls} from "../src/components/MapControllerControls.js";

function pad(overrides = {}) {
  return {index: 0, id: "local-device", mapping: "standard", connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({length: 8}, () => ({value: 0})), ...overrides};
}

function harness() {
  const dom = new JSDOM("<!doctype html><body><canvas tabindex='0'></canvas><input></body>", {pretendToBeVisual: true});
  const doc = dom.window.document, canvas = doc.querySelector("canvas");
  const camera = {center: [179, 42], zoom: 8, pitch: 30, bearing: 179, roll: 0};
  const moves = [];
  const map = {
    getCanvas: () => canvas,
    getCenter: () => ({lng: camera.center[0], lat: camera.center[1]}),
    getZoom: () => camera.zoom, getPitch: () => camera.pitch, getBearing: () => camera.bearing,
    getRoll: () => camera.roll,
    project: ({lng, lat}) => ({x: lng * 10, y: -lat * 10}),
    unproject: ([x, y]) => ({lng: x / 10, lat: -y / 10}),
    getMinZoom: () => 1, getMaxZoom: () => 18, getMinPitch: () => 0, getMaxPitch: () => 60,
    jumpTo(value) { moves.push(structuredClone(value)); Object.assign(camera, value); },
    stop() {}
  };
  let pads = [pad()], reads = 0, next = 1, available = true, selectedMap = map;
  const frames = new Map(), statuses = [];
  const options = {
    getMap: () => selectedMap, available: () => available, document: doc,
    getPads: () => { reads += 1; return pads; },
    requestFrame: callback => { const id = next++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id), onStatus: value => statuses.push(value)
  };
  const tick = timestamp => {
    const entry = frames.entries().next().value;
    assert.ok(entry, "expected one active frame");
    frames.delete(entry[0]); entry[1](timestamp);
  };
  return {dom, doc, canvas, map, camera, moves, options, frames, statuses, tick,
    set pads(value) { pads = value; }, get pads() { return pads; }, get reads() { return reads; },
    set available(value) { available = value; }, set selectedMap(value) { selectedMap = value; },
    close() { dom.window.close(); }};
}

test("declared controller layouts reject unknown or malformed devices and suppress stick drift", () => {
  assert.deepEqual(mapControllerInput(pad({axes: [0.1, -0.15, 1, -1]})), {panX: 0, panY: 0, zoom: 0, pitch: 1, bearing: 1});
  const triggers = pad(); triggers.buttons[7].value = 1;
  assert.equal(mapControllerInput(triggers).zoom, 1);
  const six = pad({mapping: "", axes: [1, -1, -1, -1, 1, 1]});
  assert.deepEqual(mapControllerInput(six, "six-axis"), {panX: 1, panY: -1, zoom: 1, pitch: 1, roll: 1, bearing: 1});
  assert.equal(mapControllerInput(six), null);
  assert.equal(mapControllerInput(pad(), "six-axis"), null);
  for (const axes of [[1, 0, NaN, 0], [Infinity, 0, 0, 0], [0, 0, 1.1, 0], [0, 0]]) {
    assert.equal(mapControllerInput(pad({axes})), null);
  }
  triggers.buttons[7].value = NaN;
  assert.equal(mapControllerInput(triggers), null);
  assert.equal(mapControllerInput(pad({connected: false})), null);
  assert.equal(mapControllerInput(pad(), "unknown"), null);
});

test("camera movement uses a capped deterministic timestep, wraps longitude and respects native bounds", () => {
  const h = harness();
  try {
    h.camera.zoom = 18; h.camera.pitch = 59;
    const input = {panX: 1, panY: -1, zoom: 1, pitch: 1, bearing: 1};
    const expected = {center: [-178.60000000000002, 44.4], zoom: 18, pitch: 60, bearing: -175};
    assert.deepEqual(mapControllerCamera(h.map, input, 100), expected);
    assert.deepEqual(mapControllerCamera(h.map, input, 10_000), expected);
    assert.equal(h.moves.length, 0, "calculation does not move the map");
    h.map.unproject = () => ({lng: 0, lat: NaN});
    assert.throws(() => mapControllerCamera(h.map, input, 50), /unavailable/);
  } finally { h.close(); }
});

test("activation alone admits device reads; stopped sessions do not poll or restart", () => {
  const h = harness(), controller = createMapController(h.options);
  try {
    assert.equal(h.reads, 0); assert.equal(h.frames.size, 0);
    assert.equal(controller.start(), true); assert.equal(h.doc.activeElement, h.canvas);
    assert.equal(h.statuses.at(-1).active, true);
    h.tick(0); h.pads[0].axes[0] = 1; h.tick(50);
    assert.equal(h.moves.length, 1); assert.equal(h.moves[0].center[0], -179.8);
    assert.equal(h.frames.size, 1);
    controller.stop(); const reads = h.reads;
    assert.equal(h.frames.size, 0); assert.equal(controller.active, false);
    h.dom.window.dispatchEvent(new h.dom.window.Event("gamepadconnected"));
    assert.equal(h.reads, reads); assert.equal(h.frames.size, 0);
    controller.dispose(); assert.equal(controller.start(), false);
  } finally { controller.dispose(); h.close(); }
});

test("six-axis rotation Y requires neutral activation and drives bounded native roll without changing standard input", () => {
  const h = harness(), controller = createMapController(h.options);
  try {
    h.pads = [pad({mapping: "", axes: [0, 0, 0, 0, 1, 0]})];
    assert.equal(controller.start("six-axis"), false);
    assert.match(h.statuses.at(-1).message, /Release/);
    h.pads[0].axes[4] = 0;
    h.camera.roll = 179;
    assert.equal(controller.start("six-axis"), true);
    h.tick(0);
    h.pads[0].axes[4] = 1;
    h.tick(10_000);
    assert.equal(h.moves.length, 1);
    assert.deepEqual(h.moves[0], {center: [179, 42], zoom: 8, pitch: 30, bearing: 179, roll: -175});
    const saved = h.camera.roll;
    controller.stop();
    h.pads = [pad()];
    h.map.getRoll = () => { throw Error("standard input must not inspect roll"); };
    assert.equal(controller.start(), true);
    h.tick(0); h.pads[0].axes[2] = 1; h.tick(100);
    assert.equal(Object.hasOwn(h.moves.at(-1), "roll"), false);
    assert.equal(h.camera.roll, saved);
  } finally { controller.dispose(); h.close(); }
});

test("a missing or failed native roll camera stops six-axis control before applying a partial camera", () => {
  for (const getRoll of [undefined, () => null, () => NaN, () => { throw Error("renderer failed"); }]) {
    const h = harness(), controller = createMapController(h.options);
    try {
      h.pads = [pad({mapping: "", axes: [0, 0, 0, 0, 0, 0]})];
      h.map.getRoll = getRoll;
      assert.equal(controller.start("six-axis"), true);
      h.tick(0); h.pads[0].axes[4] = 1; h.tick(50);
      assert.equal(controller.active, false);
      assert.equal(h.moves.length, 0);
      assert.equal(h.frames.size, 0);
      assert.match(h.statuses.at(-1).message, /unavailable/);
    } finally { controller.dispose(); h.close(); }
  }
});

test("a deflected device must return to neutral before activation", () => {
  const h = harness(), controller = createMapController(h.options);
  try {
    h.pads[0].axes[0] = 1;
    assert.equal(controller.start(), false); assert.equal(h.frames.size, 0);
    assert.match(h.statuses.at(-1).message, /Release/);
    h.pads[0].axes[0] = 0;
    assert.equal(controller.start(), true);
  } finally { controller.dispose(); h.close(); }
});

test("focus, page, competing-tool, map, device and renderer failures stop without applying another frame", () => {
  const cases = [
    h => h.doc.querySelector("input").focus(),
    h => { Object.defineProperty(h.doc, "visibilityState", {value: "hidden", configurable: true}); },
    h => { h.available = false; },
    h => { h.selectedMap = {...h.map}; },
    h => { h.pads = [pad({id: "replacement"})]; },
    h => { h.pads = [pad({index: 1})]; },
    h => { h.pads[0].axes[0] = NaN; },
    h => { h.map.jumpTo = () => { throw Error("renderer stopped"); }; h.pads[0].axes[0] = 1; }
  ];
  for (const change of cases) {
    const h = harness(), controller = createMapController(h.options);
    try {
      assert.equal(controller.start(), true); h.tick(0); change(h); h.tick(50);
      assert.equal(controller.active, false); assert.equal(h.frames.size, 0); assert.equal(h.moves.length, 0);
      assert.equal(h.statuses.at(-1).active, false);
    } finally { controller.dispose(); h.close(); }
  }
});

test("keyboard, pointer, window blur, hiding and disconnect cancel the actual pending frame", () => {
  for (const event of ["escape", "keyboard", "pointerdown", "wheel", "blur", "hidden", "disconnect"]) {
    const h = harness(), controller = createMapController(h.options);
    try {
      controller.start();
      if (event === "escape") h.canvas.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
      if (event === "keyboard") h.canvas.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true}));
      if (["pointerdown", "wheel"].includes(event)) h.canvas.dispatchEvent(new h.dom.window.Event(event, {bubbles: true}));
      if (event === "blur") h.dom.window.dispatchEvent(new h.dom.window.Event("blur"));
      if (event === "hidden") {
        Object.defineProperty(h.doc, "visibilityState", {value: "hidden"});
        h.doc.dispatchEvent(new h.dom.window.Event("visibilitychange"));
      }
      if (event === "disconnect") {
        const disconnected = new h.dom.window.Event("gamepaddisconnected");
        Object.defineProperty(disconnected, "gamepad", {value: h.pads[0]});
        h.dom.window.dispatchEvent(disconnected);
      }
      assert.equal(controller.active, false); assert.equal(h.frames.size, 0); assert.equal(h.moves.length, 0);
    } finally { controller.dispose(); h.close(); }
  }
});

test("the visible controls expose layouts, activation, map focus and a live stop status without initial device access", () => {
  const h = harness(); let reads = 0;
  Object.defineProperty(h.dom.window.navigator, "getGamepads", {value: () => { reads += 1; return h.pads; }});
  const frames = new Map(); let next = 0;
  h.dom.window.requestAnimationFrame = callback => { const id = ++next; frames.set(id, callback); return id; };
  h.dom.window.cancelAnimationFrame = id => frames.delete(id);
  const controls = MapControllerControls(() => h.map, {document: h.doc});
  h.doc.body.append(controls.element);
  try {
    assert.equal(reads, 0);
    const select = controls.element.querySelector("select"), toggle = controls.element.querySelector("button");
    assert.equal(select.getAttribute("aria-label"), "Controller layout");
    assert.equal(toggle.textContent, "Enable map controller");
    select.value = "six-axis"; select.dispatchEvent(new h.dom.window.Event("change"));
    assert.match(controls.element.textContent, /rotation Y rolls/);
    h.pads = [pad({mapping: "", axes: [0, 0, 0, 0, 0, 0]})];
    toggle.click();
    assert.equal(reads, 1); assert.equal(h.doc.activeElement, h.canvas); assert.equal(select.disabled, true);
    assert.equal(toggle.getAttribute("aria-pressed"), "true"); assert.equal(frames.size, 1);
    toggle.dispatchEvent(new h.dom.window.Event("pointerdown", {bubbles: true}));
    toggle.focus();
    const frame = frames.entries().next().value;
    frames.delete(frame[0]); frame[1](50);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-pressed"), "false"); assert.equal(select.disabled, false);
    assert.match(controls.element.querySelector('[role="status"]').textContent, /stopped/);
    assert.equal(frames.size, 0);
    assert.equal(reads, 1, "clicking Stop after focus loss must not re-enable the device");
    controls.dispose(); toggle.click(); assert.equal(reads, 1);
  } finally { controls.dispose(); h.close(); }
});
