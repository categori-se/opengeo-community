import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  EARTH_SPATIAL_BODY,
  SPATIAL_BODIES,
  meanRadiusMeters,
  spatialBodyDefinition,
  spatialBodyDistanceMeters,
  spatialBodyForProject
} from "../src/lib/spatialBody.js";

describe("UX-007D spatial-body contract", () => {
  it("publishes a closed, immutable Earth, Moon, and Mars registry", () => {
    assert.deepEqual(SPATIAL_BODIES.map(({id}) => id), ["earth", "moon", "mars"]);
    assert.ok(Object.isFrozen(SPATIAL_BODIES));
    assert.ok(Object.isFrozen(EARTH_SPATIAL_BODY.ellipsoid));
    assert.equal(spatialBodyDefinition("unknown").id, "earth");
  });

  it("accepts an exact record regardless of object-key order and rejects forged values", () => {
    const moon = spatialBodyDefinition("moon");
    const reordered = Object.fromEntries(Object.entries(moon).reverse());
    assert.equal(spatialBodyForProject({spatialBody: reordered}).id, "moon");

    const forged = structuredClone(moon);
    forged.ellipsoid.semiMajorAxisMeters = EARTH_SPATIAL_BODY.ellipsoid.semiMajorAxisMeters;
    assert.equal(spatialBodyForProject({spatialBody: forged}).id, "earth");
    assert.equal(spatialBodyForProject({}).id, "earth");
  });

  it("scales the same angular distance to each body's mean radius", () => {
    const start = [0, 0];
    const end = [1, 0];
    const earth = spatialBodyDistanceMeters(start, end, spatialBodyDefinition("earth"));
    const moon = spatialBodyDistanceMeters(start, end, spatialBodyDefinition("moon"));
    const mars = spatialBodyDistanceMeters(start, end, spatialBodyDefinition("mars"));

    assert.ok(earth > mars && mars > moon);
    assert.ok(Math.abs(moon / earth - meanRadiusMeters(spatialBodyDefinition("moon")) / meanRadiusMeters(EARTH_SPATIAL_BODY)) < 1e-12);
    assert.ok(Math.abs(mars / earth - meanRadiusMeters(spatialBodyDefinition("mars")) / meanRadiusMeters(EARTH_SPATIAL_BODY)) < 1e-12);
  });
});
