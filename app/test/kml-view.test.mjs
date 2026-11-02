import assert from "node:assert/strict";
import {test} from "node:test";
import {applyKmlView} from "../src/lib/kmlView.js";

const camera = {type: "Camera", longitude: -71, latitude: 42, altitude: 1500, heading: 30, tilt: 45, roll: 45, altitudeMode: "absolute"};
const open = (map, view = camera) => applyKmlView({map, view, engineId: "maplibre", spatialBody: {id: "earth"}});

test("opens authored Camera through native calculation and elevation-safe jump without mutating its record", () => {
  const map = nativeMap(), before = structuredClone(camera);
  const result = open(map);
  assert.equal(result.applied, true);
  assert.deepEqual(map.calculations, [["Camera", [-71, 42], 1500, 30, 45, 45]]);
  assert.deepEqual(map.jumps[0], {center: [-71, 42], zoom: 12, elevation: 175, bearing: 30, pitch: 45, roll: 45});
  assert.equal(map.getCenterClampedToGround(), false);
  assert.deepEqual(camera, before);
});

test("LookAt retains explicit target elevation, native metre range and orientation; ground modes use the existing zero plane", () => {
  const view = {type: "LookAt", longitude: -71, latitude: 42, altitude: 300, range: 1200, heading: 90, tilt: 55, altitudeMode: "absolute"};
  const map = nativeMap();
  assert.equal(open(map, view).applied, true);
  assert.deepEqual(map.calculations[0], ["LookAt", [-71, 42], 1500, [-71, 42], 300]);
  assert.deepEqual(map.jumps[0], {center: [-71, 42], zoom: 12, elevation: 300, bearing: 90, pitch: 55, roll: 0});
  const ground = nativeMap();
  assert.match(open(ground, {...view, altitudeMode: "clampToGround"}).message, /zero-height ground plane/);
  assert.deepEqual(ground.calculations[0], ["LookAt", [-71, 42], 1200, [-71, 42], 0]);
  const relative = nativeMap();
  assert.equal(open(relative, {...camera, altitudeMode: "relativeToGround"}).applied, true);
  assert.equal(relative.calculations[0][2], 1500);
  const clampedCamera = nativeMap();
  assert.equal(open(clampedCamera, {...camera, altitudeMode: "clampToGround"}).applied, true);
  assert.equal(clampedCamera.calculations[0][2], 1500, "KML Camera clampToGround uses authored height above ground");
});

test("unsupported terrain, projection, limits and unusable viewpoints leave the camera and saved view untouched", () => {
  const cases = [
    {map: nativeMap({getTerrain: () => ({source: "loaded-but-unverified-dem"})}), code: "terrain-unavailable"},
    {map: nativeMap({getProjection: () => ({type: "globe"})}), code: "projection-unsupported"},
    {map: nativeMap({getMaxBounds: () => ({})}), code: "bounds-unsupported"},
    {map: nativeMap({getMaxPitch: () => 30}), code: "pitch-unsupported"},
    {view: {...camera, altitudeMode: "gx:relativeToSeaFloor"}, code: "altitude-mode-unsupported"},
    {view: {...camera, latitude: 90}, code: "view-coordinate-unsupported"},
    {view: {...camera, altitude: -1}, code: "camera-ground-unsupported"},
    {view: {...camera, altitude: 0, altitudeMode: "clampToGround"}, code: "camera-ground-unsupported"},
    {view: {type: "LookAt", range: 0}, code: "range-unsupported"}
  ];
  for (const item of cases) {
    const map = item.map ?? nativeMap(), view = item.view ?? camera, before = structuredClone(view);
    assert.equal(open(map, view).code, item.code);
    assert.deepEqual(map.jumps, []);
    assert.equal(map.getCenterClampedToGround(), true);
    assert.deepEqual(view, before);
  }
  assert.equal(applyKmlView({map: nativeMap(), view: camera, engineId: "cesium"}).code, "renderer-unsupported");
});

test("a native camera coercion is disclosed and restores the previous camera instead of retaining a clamped view", () => {
  let first = true;
  const map = nativeMap({coerce: options => {if (first) {first = false; return {...options, zoom: options.zoom + 1};} return options;}});
  const result = open(map);
  assert.equal(result.applied, false);
  assert.equal(map.jumps.length, 2);
  assert.deepEqual(map.getCenter(), {lng: 0, lat: 0});
  assert.equal(map.getZoom(), 4);
  assert.equal(map.getRoll(), 0);
  assert.equal(map.getCenterElevation(), 0);
  assert.equal(map.getCenterClampedToGround(), true);
});

function nativeMap(overrides = {}) {
  let state = {center: [0, 0], zoom: 4, pitch: 0, bearing: 0, roll: 0, elevation: 0}, clamped = true;
  const map = {
    calculations: [], jumps: [],
    getCenter: () => ({lng: state.center[0], lat: state.center[1]}), getZoom: () => state.zoom,
    getPitch: () => state.pitch, getBearing: () => state.bearing, getRoll: () => state.roll, getCenterElevation: () => state.elevation,
    getCenterClampedToGround: () => clamped, setCenterClampedToGround: value => clamped = value,
    getMinZoom: () => 0, getMaxZoom: () => 22, getMinPitch: () => 0, getMaxPitch: () => 85,
    getProjection: () => ({type: "mercator"}), getTerrain: () => null, getMaxBounds: () => null,
    getCanvas: () => ({isConnected: true, clientHeight: 600}),
    calculateCameraOptionsFromCameraLngLatAltRotation(...args) {
      map.calculations.push(["Camera", ...args]);
      return {center: args[0], zoom: 12, elevation: 175, bearing: args[2], pitch: args[3], roll: args[4]};
    },
    calculateCameraOptionsFromTo(...args) {
      map.calculations.push(["LookAt", ...args]);
      return {center: args[2], zoom: 12, elevation: args[3], bearing: 0, pitch: 0};
    },
    jumpTo(options) {map.jumps.push(structuredClone(options));state = {...state, ...(overrides.coerce?.(options) ?? options)};},
    easeTo() {assert.fail("Authored KML elevation must not use easeTo");}
  };
  return Object.assign(map, overrides);
}
