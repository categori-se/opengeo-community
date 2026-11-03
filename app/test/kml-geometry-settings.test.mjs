import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {exportKml, KML_PLACES_LIMITS, parseAuthoringGeometry, parseKml, placesForProject, placesForSave, updateKmlPlace} from "../src/lib/kmlPlaces.js";
import {EARTH_SPATIAL_BODY, meanRadiusMeters} from "../src/lib/spatialBody.js";
import {applyKmlGeometrySettings, measureKmlAbsolutePath, summarizeKmlGeometrySettings} from "../src/lib/kmlGeometrySettings.js";

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


describe("KML absolute XYZ coordinate path length", () => {
  it("measures every vertical source segment without a terrain provider or source mutation", () => {
    const source = place({type: "LineString", coordinates: [[12, 42, 0], [12, 42, 120], [12, 42, 20]]}, controls("absolute"));
    const before = structuredClone(source);
    const result = measureKmlAbsolutePath(source);
    assert.equal(result.status, "available");
    assert.equal(result.distanceMeters, 220);
    assert.equal(result.segmentCount, 2);
    assert.equal(result.distanceUnit, "meter");
    assert.equal(result.model, "earth-mean-sphere-coordinate-chords");
    assert.equal(result.uncertaintyMeters, null);
    assert.equal(result.providerAccuracy, "unknown");
    assert.match(result.verticalDatum, /unconverted/);
    assert.deepEqual(source, before);
  });

  it("uses chords rather than surface arcs and preserves the short antimeridian path", () => {
    const radius = meanRadiusMeters(EARTH_SPATIAL_BODY);
    const across = measureKmlAbsolutePath(place({type: "LineString", coordinates: [[0, 0, 0], [90, 0, 0]]}, controls("absolute")));
    assert.ok(Math.abs(across.distanceMeters - Math.SQRT2 * radius) < 1e-8);
    assert.notEqual(across.distanceMeters, Math.PI * radius / 2);
    const dateline = measureKmlAbsolutePath(place({type: "LineString", coordinates: [[179, 0, 100], [-179, 0, 100]]}, controls("absolute")));
    assert.ok(Math.abs(dateline.distanceMeters - 2 * (radius + 100) * Math.sin(Math.PI / 180)) < 1e-7);
  });

  it("never fabricates Z or resolves relative, clamped or invalid source positions", () => {
    for (const mode of [null, "clampToGround", "relativeToGround", "gx:clampToSeaFloor", "gx:relativeToSeaFloor"]) {
      assert.equal(measureKmlAbsolutePath(place(line(), controls(mode))).reason, "absolute_altitude_required");
    }
    for (const coordinates of [[[0, 0], [0, 0, 10]], [[0, 0, NaN], [0, 0, 0]], [[181, 0, 0], [0, 0, 0]],
      [[0, 91, 0], [0, 0, 0]], [[0, 0, -10_000_000], [0, 0, 0]]]) {
      assert.equal(measureKmlAbsolutePath(place({type: "LineString", coordinates}, controls("absolute"))).reason, "explicit_valid_xyz_required");
    }
    const overridden = place(line(controls("relativeToGround")), controls("absolute"));
    assert.equal(measureKmlAbsolutePath(overridden).status, "unavailable");
    assert.equal(measureKmlAbsolutePath(place(point([0, 0, 0]), controls("absolute"))), null);
    assert.equal(measureKmlAbsolutePath(place({type: "LineString", coordinates: Array.from({length: KML_PLACES_LIMITS.maximumPositions + 1}, () => [0, 0, 0])}, controls("absolute"))).reason, "path_position_limit");
  });

  it("recomputes the same XYZ length after actual KML editing, native save/reopen and export/reimport", () => {
    const dom = new JSDOM("<!doctype html>");
    try {
      const options = {DOMParser: dom.window.DOMParser};
      const parsed = parseKml('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="roof"><name>Roof path</name><LineString><altitudeMode>absolute</altitudeMode><coordinates>0,0,0 0,0,20</coordinates></LineString></Placemark></Document></kml>', options);
      const original = parsed.document.children[0];
      const geometry = parseAuthoringGeometry("LineString", "0,0,0 0.0008993189561055266,0,10.00078480411321 0.0008993189561055266,0,30.00078480411321");
      const edited = updateKmlPlace(parsed.document, original.id, {geometry});
      const expected = measureKmlAbsolutePath(edited.children[0]);
      assert.equal(expected.status, "available");
      assert.ok(Math.abs(expected.distanceMeters - (Math.hypot(100, 10) + 20)) < 1e-6);
      const saved = placesForSave(edited);
      const reopened = placesForProject({kmlPlaces: JSON.parse(JSON.stringify(saved))});
      assert.deepEqual(reopened.children[0].geometry.coordinates, geometry.coordinates);
      assert.equal(reopened.children[0].altitudeMode, "absolute");
      assert.equal(measureKmlAbsolutePath(reopened.children[0]).distanceMeters, expected.distanceMeters);
      const exported = exportKml(reopened);
      assert.match(exported, /0\.0008993189561055266,0,10\.00078480411321/);
      const imported = parseKml(exported, options).document.children[0];
      assert.deepEqual(imported.geometry.coordinates, geometry.coordinates);
      assert.equal(imported.altitudeMode, "absolute");
      assert.equal(measureKmlAbsolutePath(imported).distanceMeters, expected.distanceMeters);
    } finally {dom.window.close();}
  });
});
