import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  circleMeasurementMetrics,
  circlePolygonCoordinates,
  createCircleMeasurement,
  createPolygonMeasurement,
  formatMeasurementArea,
  normalizeAreaMeasurement,
  polygonMeasurementMetrics
} from "../src/lib/areaMeasurement.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {normalizeSavedMeasurements, savedMeasurementGeojson} from "../src/lib/savedMeasurement.js";
import {createPathMeasurement} from "../src/lib/pathMeasurement.js";

describe("saved area measurements", () => {
  const earth = spatialBodyDefinition("earth");

  it("creates and recomputes a bounded spherical polygon", () => {
    const coordinates = [[-71.11, 42.30], [-71.10, 42.30], [-71.10, 42.31], [-71.11, 42.31]];
    const measurement = createPolygonMeasurement({
      id: "polygon-001",
      title: "Survey area",
      coordinates,
      spatialBody: earth
    });

    assert.equal(measurement.kind, "polygon-area");
    assert.ok(measurement.perimeterMeters > 3_000);
    assert.ok(measurement.areaSquareMeters > 800_000);
    assert.deepEqual(normalizeAreaMeasurement(structuredClone(measurement), {spatialBody: earth}), measurement);
    const metrics = polygonMeasurementMetrics(coordinates, earth);
    assert.ok(Math.abs(metrics.perimeterMeters - measurement.perimeterMeters) <= 0.01);
    assert.ok(Math.abs(metrics.areaSquareMeters - measurement.areaSquareMeters) <= 0.1);
  });

  it("creates a circle from center and edge with a renderable closed ring", () => {
    const measurement = createCircleMeasurement({
      id: "circle-001",
      title: "Impact radius",
      center: [-71.10, 42.30],
      radiusPoint: [-71.09, 42.30],
      spatialBody: earth
    });
    const ring = circlePolygonCoordinates(measurement);

    assert.equal(measurement.kind, "circle-area");
    assert.ok(measurement.radiusMeters > 800);
    assert.ok(measurement.areaSquareMeters > 2_000_000);
    assert.equal(ring.length, 65);
    assert.deepEqual(ring[0], ring.at(-1));
    assert.deepEqual(circleMeasurementMetrics(measurement.center, measurement.radiusPoint, earth), {
      radiusMeters: measurement.radiusMeters,
      circumferenceMeters: measurement.circumferenceMeters,
      areaSquareMeters: measurement.areaSquareMeters
    });
    assert.match(formatMeasurementArea(measurement.areaSquareMeters), /km²$/);
  });

  it("rejects forged summaries, duplicate vertices, and self-intersections", () => {
    const measurement = createPolygonMeasurement({
      id: "polygon-002",
      coordinates: [[-71.11, 42.30], [-71.10, 42.30], [-71.10, 42.31]],
      spatialBody: earth
    });
    const forged = structuredClone(measurement);
    forged.areaSquareMeters += 10;

    assert.throws(() => normalizeAreaMeasurement(forged, {spatialBody: earth}), /area_measurement_summary_invalid/);
    assert.throws(() => createPolygonMeasurement({
      id: "polygon-003",
      coordinates: [[0, 0], [1, 0], [1, 0]],
      spatialBody: earth
    }), /polygon_geometry_invalid/);
    assert.throws(() => createPolygonMeasurement({
      id: "polygon-004",
      coordinates: [[0, 0], [1, 1], [0, 1], [1, 0]],
      spatialBody: earth
    }), /polygon_geometry_invalid/);
  });

  it("normalizes a mixed inventory and renders path, polygon, and circle geometry", () => {
    const path = createPathMeasurement({
      id: "path-001",
      coordinates: [[-71.12, 42.30], [-71.11, 42.31]],
      spatialBody: earth
    });
    const polygon = createPolygonMeasurement({
      id: "polygon-005",
      coordinates: [[-71.11, 42.30], [-71.10, 42.30], [-71.10, 42.31]],
      spatialBody: earth
    });
    const circle = createCircleMeasurement({
      id: "circle-005",
      center: [-71.10, 42.30],
      radiusPoint: [-71.09, 42.30],
      spatialBody: earth
    });

    const normalized = normalizeSavedMeasurements(
      [structuredClone(path), structuredClone(polygon), structuredClone(circle)],
      {spatialBody: earth}
    );
    assert.equal(normalized.length, 3);
    const geometry = savedMeasurementGeojson(normalized, [], "path", earth);
    assert.deepEqual(geometry.features.map(({geometry: featureGeometry}) => featureGeometry.type), [
      "LineString", "Polygon", "Polygon"
    ]);
  });
});
