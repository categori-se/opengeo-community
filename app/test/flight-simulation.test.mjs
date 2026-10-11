import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  FLIGHT_LIMITS,
  FLIGHT_MODEL_SCHEMA_VERSION,
  createFlightSession,
  flightHud,
  keyboardFlightControls,
  mergeFlightControls,
  pauseFlight,
  resetFlight,
  resumeFlight,
  standardControllerFlightControls,
  stepFlight
} from "../src/lib/flightSimulation.js";

// Independently calculated one-step training-model oracles; no production
// profile, destination, normalization or conversion helper supplies expectations.
// Derivation and numerical limits: docs/logbook/a-flight-model-is-an-authority-contract.md.
const ANALYTIC_TOLERANCES = {positionDegrees: 1e-8, stateUnits: 1e-6, throttle: 1e-9};
const ANALYTIC_CASES = [
  {name: 'trainer thrust, drag and equatorial eastward distance', profileId: 'survey-trainer', headingDegrees: 90,
    controls: {throttle: 1}, expected: {airspeedMetersPerSecond: 48.08122, verticalSpeedMetersPerSecond: 0,
      altitudeMeters: 400, aglMeters: 300, headingDegrees: 90, pitchDegrees: 0, bankDegrees: 0, throttle: 1,
      position: [0.00002162021012935977, 0]}},
  {name: 'jet pitch, gravity, bank and yaw through north', profileId: 'response-jet', headingDegrees: 359.95,
    controls: {pitch: 0.5, roll: -0.5, yaw: 0.25, throttle: 1}, expected: {
      airspeedMetersPerSecond: 125.3547981918342, verticalSpeedMetersPerSecond: 1.9689875917583846,
      altitudeMeters: 400.0984493795879, aglMeters: 300.0984493795879, headingDegrees: 0.042956879268444936,
      pitchDegrees: 0.9, bankDegrees: -1.8, throttle: 1, position: [4.225536552026405e-8, 0.00005636009164752503]}},
  {name: 'jet stall descent and equatorial southward distance', profileId: 'response-jet', headingDegrees: 180,
    airspeedMetersPerSecond: 34, controls: {throttle: 0}, expected: {
      airspeedMetersPerSecond: 33.94126, verticalSpeedMetersPerSecond: -2.460141032649558,
      altitudeMeters: 399.8769929483675, aglMeters: 299.8769929483675, headingDegrees: 180,
      pitchDegrees: 0, bankDegrees: 0, throttle: 0, position: [0, -0.000015262033144234557]}}
];

describe("bounded deterministic flight simulation", () => {
  for (const fixture of ANALYTIC_CASES) it(`matches the analytic oracle for ${fixture.name}`, () => {
    assert.equal(FLIGHT_MODEL_SCHEMA_VERSION, 'opengeo.flight-model.1.0.0');
    const initial = resumeFlight(createFlightSession({profileId: fixture.profileId, position: [0, 0],
      terrainElevationMeters: 100, startingAglMeters: 300, headingDegrees: fixture.headingDegrees}));
    if (fixture.airspeedMetersPerSecond !== undefined) initial.airspeedMetersPerSecond = fixture.airspeedMetersPerSecond;
    const samples = [];
    const actual = stepFlight(initial, fixture.controls, 50, {terrainElevationAt: position => {samples.push(position); return 100;}});
    assert.equal(actual.phase, 'flying'); assert.equal(actual.elapsedMilliseconds, 50); assert.equal(samples.length, 1);
    assert.deepEqual(actual.initial, initial.initial, 'one step preserves the exact reset baseline');
    for (const [field, expected] of Object.entries(fixture.expected)) {
      if (field === 'position') for (let axis = 0; axis < 2; axis++) {
        assert.ok(Math.abs(actual.position[axis] - expected[axis]) <= ANALYTIC_TOLERANCES.positionDegrees,
          `${field}[${axis}]: ${actual.position[axis]} differs from independent ${expected[axis]}`);
        assert.ok(Math.abs(samples[0][axis] - expected[axis]) <= ANALYTIC_TOLERANCES.positionDegrees, 'terrain samples the calculated destination');
      } else assert.ok(Math.abs(actual[field] - expected) <= (field === 'throttle' ? ANALYTIC_TOLERANCES.throttle : ANALYTIC_TOLERANCES.stateUnits),
        `${field}: ${actual[field]} differs from independent ${expected}`);
    }
  });

  it('keeps paused and zero-step state inert and fails closed on invalid terrain or duration', () => {
    const paused = createFlightSession({position: [0, 0], terrainElevationMeters: 100, startingAglMeters: 300});
    let samples = 0;
    const neverRead = {terrainElevationAt() {samples++; throw Error('Paused flight must not read terrain');}};
    assert.deepEqual(stepFlight(paused, {pitch: 1}, 50, neverRead), paused);
    const flying = resumeFlight(paused);
    assert.deepEqual(stepFlight(flying, {pitch: 1}, 0, neverRead), flying);
    assert.equal(samples, 0);
    for (const terrainElevationAt of [() => NaN, () => Infinity, () => 10_001, () => {throw Error('Unavailable terrain');}]) {
      const stopped = stepFlight(flying, {pitch: 1}, 50, {terrainElevationAt});
      assert.equal(stopped.phase, 'terrain_unavailable'); assert.equal(stopped.elapsedMilliseconds, 50);
      assert.deepEqual(stopped.position, flying.position); assert.equal(stopped.altitudeMeters, flying.altitudeMeters);
      assert.deepEqual(resetFlight(stopped), paused);
    }
    assert.throws(() => stepFlight(flying, {}, 101, neverRead), ({code}) => code === 'flight_step_invalid');
    assert.equal(samples, 0);
  });

  it("advances the same fixed-step controls to the same terrain-aware state", () => {
    const initial = resumeFlight(createFlightSession({
      profileId: "survey-trainer",
      position: [-71, 42],
      terrainElevationMeters: 100,
      startingAglMeters: 300,
      headingDegrees: 0
    }));
    const controls = {pitch: 0.4, roll: 0.25, throttleDeltaPerSecond: 0.1};
    const run = () => Array.from({length: 20}).reduce((state) => stepFlight(
      state,
      controls,
      FLIGHT_LIMITS.fixedStepMilliseconds,
      {terrainElevationAt: () => 100}
    ), initial);

    const first = run();
    const second = run();
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, FLIGHT_MODEL_SCHEMA_VERSION);
    assert.equal(first.elapsedMilliseconds, 1_000);
    assert.equal(first.phase, "flying");
    assert.ok(first.position[1] > initial.position[1]);
    assert.ok(first.position[0] > initial.position[0]);
    assert.ok(first.altitudeMeters > initial.altitudeMeters);
    assert.ok(first.bankDegrees > 0);
    assert.ok(first.headingDegrees > 0);
    assert.ok(first.aglMeters > 300);
  });

  it("fails closed when terrain disappears and stops exactly at terrain clearance on collision", () => {
    const initial = resumeFlight(createFlightSession({
      position: [-71, 42],
      terrainElevationMeters: 20,
      startingAglMeters: 30,
      headingDegrees: 90
    }));
    const unavailable = stepFlight(initial, {}, 50, {terrainElevationAt: () => null});
    assert.equal(unavailable.phase, "terrain_unavailable");
    assert.deepEqual(unavailable.position, initial.position);

    let collision = initial;
    for (let step = 0; step < 400 && collision.phase === "flying"; step += 1) {
      collision = stepFlight(collision, {pitch: -1, throttle: 0}, 50, {
        terrainElevationAt: () => 20
      });
    }
    assert.equal(collision.phase, "collision");
    assert.equal(collision.altitudeMeters, 20 + FLIGHT_LIMITS.minimumClearanceMeters);
    assert.equal(collision.aglMeters, FLIGHT_LIMITS.minimumClearanceMeters);
    assert.equal(collision.airspeedMetersPerSecond, 0);
    assert.equal(collision.throttle, 0);
  });

  it("pauses, resumes, resets, and enforces the session ceiling", () => {
    const initial = createFlightSession({
      profileId: "response-jet",
      position: [10, 20],
      terrainElevationMeters: 0,
      startingAglMeters: 500,
      headingDegrees: 270
    });
    assert.equal(initial.phase, "paused");
    assert.equal(stepFlight(initial, {roll: 1}, 50, {terrainElevationAt: () => 0}).elapsedMilliseconds, 0);
    const moved = stepFlight(resumeFlight(initial), {roll: 1}, 50, {terrainElevationAt: () => 0});
    assert.equal(moved.phase, "flying");
    assert.equal(pauseFlight(moved).phase, "paused");
    assert.deepEqual(resetFlight(moved), initial);

    const expired = stepFlight({
      ...resumeFlight(initial),
      elapsedMilliseconds: FLIGHT_LIMITS.maximumSessionMilliseconds - 25
    }, {}, 50, {terrainElevationAt: () => 0});
    assert.equal(expired.phase, "session_limit");
    assert.equal(expired.elapsedMilliseconds, FLIGHT_LIMITS.maximumSessionMilliseconds);
  });

  it("normalizes scoped keyboard and opt-in standard-controller input", () => {
    assert.deepEqual(keyboardFlightControls(new Set(["ArrowDown", "ArrowRight", "KeyA", "PageUp"])), {
      pitch: 1,
      roll: 1,
      yaw: -1,
      throttleDeltaPerSecond: 1,
      throttle: null
    });
    assert.equal(standardControllerFlightControls({connected: true, mapping: "xinput", axes: [0, 0, 0, 0]}), null);
    const controller = standardControllerFlightControls({
      connected: true,
      mapping: "standard",
      axes: [0.54, -0.54, 0.04, -1]
    });
    assert.ok(controller.roll > 0.49 && controller.roll < 0.51);
    assert.ok(controller.pitch < -0.49 && controller.pitch > -0.51);
    assert.equal(controller.yaw, 0);
    assert.equal(controller.throttle, 1);
    const merged = mergeFlightControls(keyboardFlightControls(["ArrowDown"]), controller);
    assert.equal(merged.pitch, 0.5);
    assert.equal(merged.throttle, 1);
  });

  it("produces bounded HUD units and rejects invalid starts", () => {
    const state = createFlightSession({
      position: [-71, 42],
      terrainElevationMeters: 100,
      startingAglMeters: 300,
      headingDegrees: 359.6
    });
    assert.deepEqual(flightHud(state), {
      phase: "paused",
      headingDegrees: 360,
      airspeedKnots: 93,
      altitudeFeet: 1_312,
      aglFeet: 984,
      verticalSpeedFeetPerMinute: 0,
      pitchDegrees: 0,
      bankDegrees: 0,
      throttlePercent: 70,
      elapsedMilliseconds: 0
    });
    assert.throws(
      () => createFlightSession({position: [0, 90], terrainElevationMeters: 0}),
      ({code}) => code === "flight_position_invalid"
    );
    assert.throws(
      () => createFlightSession({position: [0, 0], terrainElevationMeters: 0, startingAglMeters: 10}),
      ({code}) => code === "flight_starting_agl_invalid"
    );
    assert.throws(
      () => createFlightSession({profileId: "unknown", position: [0, 0], terrainElevationMeters: 0}),
      ({code}) => code === "flight_aircraft_unsupported"
    );
  });
});
