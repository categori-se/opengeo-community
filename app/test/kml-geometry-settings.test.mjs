import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {applyKmlGeometrySettings, summarizeKmlGeometrySettings} from "../src/lib/kmlGeometrySettings.js";

const controls = (altitudeMode = null, extrude = false, tessellate = false) => ({altitudeMode, extrude, tessellate});
const point = (coordinates = [1, 2], kmlControls) => ({type: "Point", coordinates, ...(kmlControls ? {kmlControls} : {})});
const line = (kmlControls) => ({type: "LineString", coordinates: [[1, 2, -5], [3, 4, 0]], ...(kmlControls ? {kmlControls} : {})});
const polygon = (kmlControls) => ({type: "Polygon", coordinates: [[[0, 0, 1], [1, 0, 2], [1, 1, 3], [0, 0, 1]]], ...(kmlControls ? {kmlControls} : {})});
const collection = (...geometries) => ({type: "GeometryCollection", geometries});
const place = (geometry, settings = controls()) => ({kind: "placemark", id: "place", geometry, ...settings});
const invalid = (code = "kml_geometry_settings_invalid") => (error) => error.code === code;

describe("KML source geometry settings", () => {
  it("summarizes inherited and nested controls, excluding Point tessellation", () => {
    const source = place(collection(
      point([1, 2, 0], controls("absolute", true, true)),
      collection(line(), polygon(controls("gx:clampToSeaFloor", true, false)))
    ));
    assert.deepEqual(summarizeKmlGeometrySettings(source), {
      leafCount: 3, edgeCount: 2, altitudeMode: "mixed", extrude: "mixed", tessellate: false
    });
    source.geometry.geometries[1].geometries[0].kmlControls = controls(null, false, true);
    assert.equal(summarizeKmlGeometrySettings(source).tessellate, "mixed");
    assert.equal(Object.hasOwn(summarizeKmlGeometrySettings(source), "pointAltitude"), false);
  });

  it("distinguishes missing, zero and negative Point altitude", () => {
    for (const [coordinates, altitude] of [[[1, 2], null], [[1, 2, 0], 0], [[1, 2, -12.5], -12.5]]) {
      assert.deepEqual(summarizeKmlGeometrySettings(place(point(coordinates), controls("absolute", true, true))), {
        leafCount: 1, edgeCount: 0, altitudeMode: "absolute", extrude: true, tessellate: false, pointAltitude: altitude
      });
    }
  });

  it("applies one field without overwriting mixed controls or coordinates", () => {
    const source = place(collection(
      point([1, 2, -50], controls("absolute", true, true)),
      collection(line(controls("relativeToGround", false, false)), polygon())
    ), controls("absolute", true, false));
    const original = structuredClone(source);
    const patch = applyKmlGeometrySettings(source, {extrude: false});
    assert.deepEqual(source, original);
    assert.equal(patch.altitudeMode, source.altitudeMode);
    assert.equal(patch.tessellate, source.tessellate);
    assert.equal(patch.extrude, false);
    assert.deepEqual(patch.geometry.geometries[0].kmlControls, controls("absolute", false, true));
    assert.deepEqual(patch.geometry.geometries[1].geometries[0].kmlControls, controls("relativeToGround", false, false));
    assert.equal(Object.hasOwn(patch.geometry.geometries[1].geometries[1], "kmlControls"), false);
    assert.deepEqual(patch.geometry.geometries[1].geometries[1].coordinates, source.geometry.geometries[1].geometries[1].coordinates);
    assert.notEqual(patch.geometry.geometries[0].coordinates, source.geometry.geometries[0].coordinates);
    assert.equal(summarizeKmlGeometrySettings({...source, ...patch}).altitudeMode, "mixed");
  });

  it("preserves Point tessellation when edges follow a Point", () => {
    const source = place(collection(point([1, 2, 9]), collection(line(), polygon())));
    const patch = applyKmlGeometrySettings(source, {tessellate: true});
    assert.equal(patch.tessellate, false);
    assert.equal(Object.hasOwn(patch.geometry.geometries[0], "kmlControls"), false);
    for (const geometry of patch.geometry.geometries[1].geometries) {
      assert.deepEqual(geometry.kmlControls, controls(null, false, true));
    }
    assert.equal(summarizeKmlGeometrySettings({...source, ...patch}).tessellate, true);
  });

  it("preserves Point tessellation when a changed edge sets the global default", () => {
    const source = place(collection(line(), point([1, 2, -3])));
    const patch = applyKmlGeometrySettings(source, {altitudeMode: "absolute", tessellate: true});
    assert.equal(patch.altitudeMode, "absolute");
    assert.equal(patch.tessellate, true);
    assert.equal(Object.hasOwn(patch.geometry.geometries[0], "kmlControls"), false);
    assert.deepEqual(patch.geometry.geometries[1].kmlControls, controls("absolute", false, false));
    assert.deepEqual(patch.geometry.geometries[1].coordinates, [1, 2, -3]);
  });

  it("keeps legacy uniform geometry free of unnecessary overrides", () => {
    for (const geometry of [point(), line(), collection(point(), line(), polygon()), collection(line(), polygon())]) {
      const source = place(geometry);
      const changes = {altitudeMode: "gx:relativeToSeaFloor", extrude: true};
      const summary = summarizeKmlGeometrySettings(source);
      if (summary.edgeCount === summary.leafCount) changes.tessellate = true;
      const patch = applyKmlGeometrySettings(source, changes);
      assert.deepEqual(patch.geometry, geometry);
      assert.equal(patch.altitudeMode, "gx:relativeToSeaFloor");
      assert.equal(patch.extrude, true);
      assert.equal(patch.tessellate, changes.tessellate === true);
    }
  });

  it("does not invent controls for no-op changes and retains explicit overrides", () => {
    for (const source of [place(collection(point(), line())), place(collection(point(), line(controls("absolute", false, true))))]) {
      const patch = applyKmlGeometrySettings(source, {});
      assert.deepEqual(patch, {geometry: source.geometry, altitudeMode: source.altitudeMode, extrude: source.extrude, tessellate: source.tessellate});
      assert.notEqual(patch.geometry, source.geometry);
      assert.notEqual(patch.geometry.geometries[0].coordinates, source.geometry.geometries[0].coordinates);
    }
    const source = place(point([1, 2, 0], controls("absolute", false, true)));
    const patch = applyKmlGeometrySettings(source, {extrude: false});
    assert.deepEqual(patch.geometry, source.geometry);
    assert.equal(patch.altitudeMode, null);
  });

  it("preserves source Point controls through unrelated altitude and extrusion edits", () => {
    const source = place(collection(
      point([1, 2, 7], controls("absolute", true, true)),
      line(controls(null, false, false))
    ), controls("absolute", true, true));
    const patch = applyKmlGeometrySettings(source, {altitudeMode: null, extrude: false, tessellate: true});
    assert.deepEqual(patch.geometry.geometries[0].kmlControls, controls(null, false, true));
    assert.deepEqual(patch.geometry.geometries[1].kmlControls, controls(null, false, true));
    assert.equal(patch.tessellate, true);
  });

  it("sets, replaces and removes only a direct Point's Z", () => {
    const source = place(point([1, 2], controls("absolute", true, true)));
    const original = structuredClone(source);
    for (const value of [0, -12.25, 10_000_000, -10_000_000, null]) {
      const patch = applyKmlGeometrySettings(source, {pointAltitude: value});
      assert.deepEqual(patch.geometry.coordinates, value === null ? [1, 2] : [1, 2, value]);
      assert.deepEqual(patch.geometry.kmlControls, source.geometry.kmlControls);
      assert.deepEqual(source, original);
    }
    const zero = {...source, ...applyKmlGeometrySettings(source, {pointAltitude: 0})};
    assert.deepEqual(applyKmlGeometrySettings(zero, {pointAltitude: -8}).geometry.coordinates, [1, 2, -8]);
    assert.deepEqual(applyKmlGeometrySettings(zero, {pointAltitude: null}).geometry.coordinates, [1, 2]);
  });

  it("accepts each existing mode and rejects invalid values without mutation", () => {
    const source = place(point([1, 2, 4]));
    const original = structuredClone(source);
    for (const altitudeMode of [null, "clampToGround", "relativeToGround", "absolute", "gx:clampToSeaFloor", "gx:relativeToSeaFloor"]) {
      assert.equal(applyKmlGeometrySettings(source, {altitudeMode}).altitudeMode, altitudeMode);
    }
    for (const changes of [null, [], {unknown: true}, {altitudeMode: undefined}, {altitudeMode: "mixed"}, {altitudeMode: "relativeToSeaFloor"}, {altitudeMode: "gx:absolute"}, {extrude: 1}, {tessellate: "false"}, {[Symbol("unknown")]: true}]) {
      assert.throws(() => applyKmlGeometrySettings(source, changes), invalid());
      assert.deepEqual(source, original);
    }
    for (const pointAltitude of [undefined, "0", NaN, Infinity, -Infinity, 10_000_001, -10_000_001]) {
      assert.throws(() => applyKmlGeometrySettings(source, {extrude: true, pointAltitude}), invalid("kml_point_altitude_invalid"));
      assert.deepEqual(source, original);
    }
  });

  it("rejects settings outside the eligible geometry scope", () => {
    for (const geometry of [line(), polygon(), collection(point())]) {
      const source = place(geometry);
      const original = structuredClone(source);
      assert.throws(() => applyKmlGeometrySettings(source, {pointAltitude: 0}), invalid("kml_point_altitude_invalid"));
      assert.deepEqual(source, original);
    }
    assert.throws(() => applyKmlGeometrySettings(place(point()), {tessellate: true}), invalid());
    assert.throws(() => applyKmlGeometrySettings(place(null), {extrude: true}), invalid());
    assert.throws(() => applyKmlGeometrySettings(place(null), {altitudeMode: null}), invalid());
  });
});
