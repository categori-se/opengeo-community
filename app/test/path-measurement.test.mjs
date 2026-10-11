import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  createPathMeasurement,
  formatMeasurementDistance,
  measurementGeojson,
  measurementSlopeSummary,
  normalizePathMeasurements,
  PATH_MEASUREMENT_LIMITS
} from "../src/lib/pathMeasurement.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";

const TERRAIN_SOURCE = {
  sourceId: "opengeo-mapterhorn-terrain",
  provider: "Mapterhorn",
  queryMode: "renderer-unexaggerated-point-sample",
  termsUrl: "https://mapterhorn.com/attribution/",
  observedAt: "2026-08-28"
};

describe("saved path measurements", () => {
  it("builds a bounded 2D and terrain-derived 3D profile with exact provenance", () => {
    const measurement = createPathMeasurement({
      id: "measurement_001",
      title: "Ridge route",
      coordinates: [[-73.25, 42.2], [-73.2, 42.22], [-73.15, 42.25]],
      spatialBody: spatialBodyDefinition("earth"),
      elevationAt: ([longitude, latitude]) => 200 + (longitude + 73.25) * 1_000 + (latitude - 42.2) * 2_000,
      terrainSource: TERRAIN_SOURCE
    });

    assert.equal(measurement.schemaVersion, "opengeo.path-measurement.1.0.0");
    assert.equal(measurement.terrainProfile.status, "complete");
    assert.ok(measurement.horizontalDistanceMeters > 9_000);
    assert.ok(measurement.terrainProfile.summary.threeDimensionalDistanceMeters > measurement.horizontalDistanceMeters);
    assert.ok(measurement.terrainProfile.summary.ascentMeters > 0);
    assert.equal(measurement.terrainProfile.source.sourceId, "opengeo-mapterhorn-terrain");
    assert.ok(measurement.terrainProfile.samples.length <= PATH_MEASUREMENT_LIMITS.maximumSamples);
    assert.deepEqual(measurement.terrainProfile.samples[0].coordinate, [-73.25, 42.2]);
    assert.deepEqual(measurement.terrainProfile.samples.at(-1).coordinate, [-73.15, 42.25]);
    const slope = measurementSlopeSummary(measurement);
    assert.equal(slope.status, "complete");
    assert.ok(slope.maximumAbsoluteGradePercent > 0);
    assert.ok(slope.maximumSlopeDegrees > 0);
    assert.ok(slope.maximumSampleSpacingMeters <= PATH_MEASUREMENT_LIMITS.targetSampleSpacingMeters * 1.1);
    assert.equal(slope.accuracy, "terrain-provider-not-declared");
    const incomplete = structuredClone(measurement);
    incomplete.terrainProfile.samples[1].elevationMeters = null;
    assert.deepEqual(measurementSlopeSummary(incomplete), {status: "unavailable"});

    const restored = normalizePathMeasurements([structuredClone(measurement)], {
      spatialBody: spatialBodyDefinition("earth")
    });
    assert.deepEqual(restored, [measurement]);
  });

  it("retains an honest 2D path when no elevation surface is available", () => {
    const measurement = createPathMeasurement({
      id: "moon_path",
      coordinates: [[1, 1], [1.5, 1.25]],
      spatialBody: spatialBodyDefinition("moon")
    });

    assert.equal(measurement.spatialBodyId, "moon");
    assert.equal(measurement.terrainProfile.status, "unavailable");
    assert.equal(measurement.terrainProfile.source, null);
    assert.equal(measurement.terrainProfile.summary.threeDimensionalDistanceMeters, null);
    assert.deepEqual(measurementSlopeSummary(measurement), {status: "unavailable"});
    assert.ok(measurement.horizontalDistanceMeters > 0);
  });

  it("fails closed on forged distance, source, coordinate, and inventory data", () => {
    const measurement = structuredClone(createPathMeasurement({
      id: "measurement_002",
      coordinates: [[-71.1, 42.3], [-71.0, 42.4]],
      spatialBody: spatialBodyDefinition("earth"),
      elevationAt: () => 10,
      terrainSource: TERRAIN_SOURCE
    }));

    for (const mutate of [
      (value) => { value.horizontalDistanceMeters += 100; },
      (value) => { value.coordinates[0][0] = 181; },
      (value) => { value.terrainProfile.source.termsUrl = "http://localhost/"; },
      (value) => { value.terrainProfile.samples[1].coordinate[0] += 0.001; },
      (value) => { value.terrainProfile.samples.at(-1).distanceMeters -= 2; },
      (value) => { value.terrainProfile.summary.ascentMeters += 20; }
    ]) {
      const candidate = structuredClone(measurement);
      mutate(candidate);
      assert.deepEqual(normalizePathMeasurements([candidate], {
        spatialBody: spatialBodyDefinition("earth")
      }), []);
    }
  });

  it("emits saved and draft map geometry without adding data-layer semantics", () => {
    const measurement = createPathMeasurement({
      id: "measurement_003",
      title: "Short line",
      coordinates: [[-72, 42], [-71.9, 42.05]],
      spatialBody: spatialBodyDefinition("earth")
    });
    const geojson = measurementGeojson([measurement], [[-71, 41], [-70.9, 41.1]]);

    assert.equal(geojson.features.length, 4);
    assert.equal(geojson.features[0].properties.kind, "saved");
    assert.equal(geojson.features.at(-1).properties.kind, "draft");
    assert.match(formatMeasurementDistance(measurement.horizontalDistanceMeters), /km$/);
  });
});
