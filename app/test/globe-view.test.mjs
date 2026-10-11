import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  applyMapProjection,
  captureMapView,
  GLOBE_VIEW_LIMITS,
  mapViewsForSave,
  normalizeMapView,
  normalizeProjection,
  projectionForProject
} from "../src/lib/globeView.js";

describe("GEP-002 globe view contract", () => {
  it("normalizes a bounded deterministic saved camera and projection", () => {
    assert.equal(normalizeProjection("globe"), "globe");
    assert.equal(normalizeProjection("arbitrary"), "mercator");
    assert.equal(projectionForProject({projection: "globe"}), "globe");
    assert.deepEqual(normalizeMapView({
      id: "overview",
      title: "Global overview",
      center: [220, -90],
      zoom: 100,
      pitch: -4,
      bearing: 725
    }), {
      id: "overview",
      title: "Global overview",
      center: [180, GLOBE_VIEW_LIMITS.minimumLatitude],
      zoom: GLOBE_VIEW_LIMITS.maximumZoom,
      pitch: 0,
      bearing: 5
    });
  });

  it("captures the live camera instead of resaving the original view", () => {
    const map = fakeMap({
      center: {lng: -77.0365, lat: 38.8977},
      zoom: 10.25,
      pitch: 48,
      bearing: -32
    });
    const captured = captureMapView(map, {id: "saved", title: "White House"});
    const views = mapViewsForSave(map, [
      {id: "saved", title: "White House", center: [0, 0], zoom: 1},
      {id: "secondary", title: "Secondary", center: [10, 20], zoom: 3}
    ]);

    assert.deepEqual(captured, {
      id: "saved",
      title: "White House",
      center: [-77.0365, 38.8977],
      zoom: 10.25,
      pitch: 48,
      bearing: -32
    });
    assert.deepEqual(views[0], captured);
    assert.equal(views[1].id, "secondary");
    assert.equal(mapViewsForSave(map, Array.from({length: 12}, (_, index) => ({
      id: `view-${index}`,
      title: `View ${index}`,
      center: [index, index],
      zoom: index
    }))).length, 8);
  });

  it("applies a real globe projection and fails closed to the 2D fallback", () => {
    const supported = fakeMap({projection: "mercator"});
    assert.deepEqual(applyMapProjection(supported, "globe"), {
      requested: "globe",
      effective: "globe",
      fallback: false
    });
    assert.equal(supported.getProjection().type, "globe");

    const unsupported = fakeMap({projection: "mercator", rejectGlobe: true});
    assert.deepEqual(applyMapProjection(unsupported, "globe"), {
      requested: "globe",
      effective: "mercator",
      fallback: true
    });
    assert.equal(unsupported.getProjection().type, "mercator");
  });

  it("does not retain malformed camera values or attacker-controlled object keys", () => {
    assert.deepEqual(
      normalizeMapView({
        id: "../escape",
        title: " ",
        center: [Number.NaN, 0],
        zoom: Number.POSITIVE_INFINITY,
        pitch: "85",
        bearing: null
      }),
      {
        id: "primary",
        title: "Primary view",
        center: [0, 20],
        zoom: 2,
        pitch: 0,
        bearing: 0
      }
    );
  });
});

function fakeMap({
  center = {lng: 0, lat: 20},
  zoom = 2,
  pitch = 0,
  bearing = 0,
  projection = "mercator",
  rejectGlobe = false
} = {}) {
  let currentProjection = projection;
  return {
    getCenter: () => center,
    getZoom: () => zoom,
    getPitch: () => pitch,
    getBearing: () => bearing,
    getProjection: () => ({type: currentProjection}),
    setProjection(value) {
      if (rejectGlobe && value.type === "globe") throw new Error("unsupported");
      currentProjection = value.type;
    }
  };
}
