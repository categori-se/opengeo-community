import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {CameraControls} from "../src/components/CameraControls.js";

describe("visible camera controls", () => {
  it("uses one reset button, compass dragging and keyboard heading without changing zoom or center", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {pretendToBeVisual: true});
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      let bearing = 0;
      const calls = [];
      const map = {getPitch: () => 0, getBearing: () => bearing, stop() {},
        easeTo: change => { calls.push(change); bearing = change.bearing ?? bearing; },
        jumpTo: change => { calls.push(change); bearing = change.bearing ?? bearing; }};
      const camera = CameraControls(() => map);
      document.body.append(camera.element);
      assert.equal(camera.element.querySelectorAll("button").length, 1);
      assert.equal(camera.element.querySelector('[aria-label="Rotate right"]'), null);
      assert.equal(camera.isInteracting(), false);
      const ring = camera.element.querySelector('[aria-label="Map heading"]');
      ring.setPointerCapture = () => {};
      ring.getBoundingClientRect = () => ({left: 0, top: 0, width: 100, height: 100});
      ring.dispatchEvent(new dom.window.MouseEvent("pointerdown", {button: 0, clientX: 50, clientY: 0}));
      assert.equal(camera.isInteracting(), true);
      ring.dispatchEvent(new dom.window.MouseEvent("pointermove", {clientX: 100, clientY: 50}));
      assert.equal(bearing, -90);
      ring.dispatchEvent(new dom.window.MouseEvent("pointercancel"));
      assert.equal(camera.isInteracting(), false);
      ring.dispatchEvent(new dom.window.MouseEvent("pointermove", {clientX: 50, clientY: 100}));
      assert.equal(bearing, -90, "cancellation stops rotation");
      ring.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "Home"}));
      assert.equal(bearing, 0);
      ring.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "ArrowRight"}));
      assert.equal(bearing, 5);
      assert.equal(ring.getAttribute("aria-valuenow"), "5");
      assert.ok(calls.every(call => !("zoom" in call) && !("center" in call)));
    } finally { globalThis.document = previous; dom.window.close(); }
  });

  it("rotates and tilts without changing center or zoom, clamps pitch, and resets north", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      let pitch = 55, bearing = 20;
      const calls = [];
      const map = {
        getPitch: () => pitch, getBearing: () => bearing, getMaxPitch: () => 60,
        easeTo: (options) => { calls.push(options); pitch = options.pitch ?? pitch; bearing = options.bearing ?? bearing; }
      };
      const {element, update} = CameraControls(() => map);
      const click = label => element.querySelector(`[aria-label="${label}"]`).click();
      const slider = element.querySelector("input");
      slider.value = "90";
      slider.dispatchEvent(new dom.window.Event("input"));
      assert.equal(pitch, 60);
      slider.value = "27";
      slider.dispatchEvent(new dom.window.Event("input"));
      assert.equal(pitch, 27);
      pitch = 15; bearing = -45; update();
      assert.equal(slider.value, "15");
      assert.match(element.textContent, /Tilt 15°/);
      assert.match(element.querySelector(".gis-camera-center").title, /heading 315°/);
      assert.equal(element.querySelector(".gis-camera-center").dataset.displaced, "true");
      click("Reset north and tilt");
      assert.equal(pitch, 0); assert.equal(bearing, 0);
      assert.equal(element.querySelector(".gis-camera-center").dataset.displaced, "false");
      assert.ok(calls.every(call => !("zoom" in call) && !("center" in call)));
    } finally { globalThis.document = previous; dom.window.close(); }
  });

  it("disables controls until the renderer exists", () => {
    const dom = new JSDOM();
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const {element} = CameraControls(() => null);
      assert.equal(element.querySelectorAll("button:disabled").length, 1);
      assert.equal(element.querySelector("input").disabled, true);
    } finally { globalThis.document = previous; dom.window.close(); }
  });
});
