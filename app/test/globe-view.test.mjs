import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  applyMapProjection,
  captureMapView,
  GLOBE_VIEW_LIMITS,
  mapViewsForSave,
  normalizeMapView,
  normalizeProjection,
  projectionForProject,
  restoreMapView
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

  it("retains native roll, target elevation and ground-clamping through camera capture and named-view save", () => {
    const map = {...fakeMap({center: {lng: 13.4, lat: 52.5}, zoom: 12, pitch: 45, bearing: 30}),
      getRoll: () => 25, getCenterElevation: () => 350, getCenterClampedToGround: () => false};
    const camera = captureMapView(map, {id: "primary", title: "KML view"});
    assert.equal(camera.roll, 25);
    assert.equal(camera.elevation, 350);
    assert.equal(camera.centerClampedToGround, false);
    const saved = mapViewsForSave(null, [camera, {...camera, id: "inspection", title: "Inspection"}]);
    assert.deepEqual(saved[0], camera);
    assert.deepEqual(saved[1], {...camera, id: "inspection", title: "Inspection"});
    const reset = captureMapView({...map, getRoll: () => 0, getCenterElevation: () => 0, getCenterClampedToGround: () => true}, camera);
    assert.equal(reset.roll, 0); assert.equal(reset.elevation, 0); assert.equal(reset.centerClampedToGround, true);
    const invalid = normalizeMapView({...camera, roll: NaN, elevation: Infinity, centerClampedToGround: "false"});
    for (const key of ["roll", "elevation", "centerClampedToGround"]) assert.equal(Object.hasOwn(invalid, key), false);
  });

  it("refuses extended saved-view recall on incompatible engines while retaining the record and current camera", () => {
    const view = {center: [13, 52], zoom: 12, pitch: 45, bearing: 30, roll: 25, elevation: 350, centerClampedToGround: false};
    const before = structuredClone(view), moves = [], flags = [];
    const map = {jumpTo: camera => moves.push(camera), setCenterClampedToGround: value => flags.push(value)};
    for (const engineId of ["mapbox", "cesium"]) {
      const result = restoreMapView({map, view, engineId});
      assert.equal(result.applied, false); assert.match(result.message, /requires MapLibre/);
    }
    assert.deepEqual(moves, []); assert.deepEqual(flags, []); assert.deepEqual(view, before);
    assert.equal(restoreMapView({map, view, engineId: "maplibre"}).applied, true);
    assert.equal(moves[0].roll, 25); assert.equal(moves[0].elevation, 350); assert.deepEqual(flags, [false]);
    const ordinary = {center: [0, 0], zoom: 2, pitch: 0, bearing: 0};
    assert.equal(restoreMapView({map, view: ordinary, engineId: "cesium"}).applied, true);
    assert.equal(moves[1].roll, 0); assert.equal(moves[1].elevation, 0); assert.deepEqual(flags, [false, true]);
  });

  it("retains imported view extent and presentation metadata through capture and save", () => {
    const view = {viewId: 'comparison', label: 'Regional context', viewKind: 'maplibre',
      layerVisibility: {'public-wms': true, 'field-sites': false}, bbox: [-77.12, 38.84, -76.96, 38.98],
      center: [-77.04, 38.91], zoom: 9, pitch: 0, bearing: 0};
    const before = structuredClone(view);
    const normalized = normalizeMapView(view);
    assert.equal(normalized.id, 'comparison'); assert.equal(normalized.title, 'Regional context');
    for (const key of ['bbox', 'label', 'viewKind', 'layerVisibility']) assert.deepEqual(normalized[key], view[key]);
    const saved = mapViewsForSave(null, [view, {...view, viewId: 'detail'}]);
    assert.deepEqual(saved[0], normalized); assert.deepEqual(saved[1].layerVisibility, view.layerVisibility);
    const captured = captureMapView(fakeMap({center: {lng: -76, lat: 39}, zoom: 10}), view);
    assert.deepEqual(captured.bbox, view.bbox); assert.deepEqual(captured.center, [-76, 39]);
    normalized.bbox[0] = 0; normalized.layerVisibility['field-sites'] = true;
    assert.deepEqual(view, before);
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
        bearing: null,
        bbox: [0, 0, Number.NaN, 10],
        label: {unsafe: true},
        viewKind: {unsafe: true},
        layerVisibility: JSON.parse('{"__proto__":true,"layer":"true"}')
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
