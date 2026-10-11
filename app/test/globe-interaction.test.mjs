import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  GLOBE_INTERACTION_CONTRACT,
  globeInteractionSupport,
  globeInteractionSupportAccepted,
  restoredMapViewMatches
} from "../src/lib/globeInteraction.js";

describe("globe interaction contract", () => {
  it("requires pan, orbit, wheel, keyboard, pinch/rotate, and touch pitch handlers", () => {
    const map = Object.fromEntries(GLOBE_INTERACTION_CONTRACT.requiredHandlers.map((name) => [
      name,
      {isEnabled: () => true}
    ]));
    const support = globeInteractionSupport(map);
    assert.deepEqual(support, {
      dragPan: true,
      dragRotate: true,
      scrollZoom: true,
      keyboard: true,
      touchZoomRotate: true,
      touchPitch: true
    });
    assert.equal(globeInteractionSupportAccepted(support), true);
  });

  it("fails closed when a handler is absent, disabled, or throws", () => {
    const support = globeInteractionSupport({
      dragPan: {isEnabled: () => true},
      dragRotate: {isEnabled: () => true},
      scrollZoom: {isEnabled: () => true},
      keyboard: {isEnabled: () => true},
      touchZoomRotate: {isEnabled: () => false},
      touchPitch: {isEnabled: () => { throw new Error("renderer rejected"); }}
    });
    assert.equal(support.touchZoomRotate, false);
    assert.equal(support.touchPitch, false);
    assert.equal(globeInteractionSupportAccepted(support), false);
  });

  it("accepts exact bounded restoration across center, zoom, pitch, and circular bearing", () => {
    const saved = {center: [13.405, 52.52], zoom: 13.25, pitch: 55, bearing: 179.9998};
    const restored = {center: [13.4055, 52.5195], zoom: 13.2505, pitch: 54.9995, bearing: -179.9998};
    assert.equal(restoredMapViewMatches(saved, restored), true);
  });

  it("rejects drift in every camera dimension and malformed views", () => {
    const saved = {center: [13.405, 52.52], zoom: 13.25, pitch: 55, bearing: 10};
    for (const restored of [
      {...saved, center: [13.407, 52.52]},
      {...saved, zoom: 13.252},
      {...saved, pitch: 55.002},
      {...saved, bearing: 10.002},
      {...saved, center: [NaN, 52.52]},
      null
    ]) assert.equal(restoredMapViewMatches(saved, restored), false);
  });
});
