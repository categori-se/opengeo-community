export const FLIGHT_MODEL_SCHEMA_VERSION = "opengeo.flight-model.1.0.0";

export const FLIGHT_LIMITS = Object.freeze({
  fixedStepMilliseconds: 50,
  maximumStepMilliseconds: 100,
  maximumCatchUpMilliseconds: 250,
  maximumSessionMilliseconds: 60 * 60 * 1_000,
  maximumAltitudeMeters: 20_000,
  maximumTerrainElevationMeters: 10_000,
  minimumTerrainElevationMeters: -12_000,
  minimumClearanceMeters: 3,
  minimumStartingAglMeters: 30,
  maximumStartingAglMeters: 5_000,
  controllerDeadzone: 0.08,
  earthRadiusMeters: 6_371_008.8
});

export const AIRCRAFT_PROFILES = Object.freeze({
  "survey-trainer": Object.freeze({
    id: "survey-trainer",
    title: "Survey trainer",
    description: "Stable light aircraft for close terrain and mapping review.",
    stallSpeedMetersPerSecond: 24,
    initialSpeedMetersPerSecond: 48,
    maximumSpeedMetersPerSecond: 95,
    maximumThrustAcceleration: 5,
    dragFactor: 0.0014,
    rollingDragAcceleration: 0.15,
    pitchRateDegreesPerSecond: 24,
    rollRateDegreesPerSecond: 48,
    yawRateDegreesPerSecond: 12,
    maximumPitchDegrees: 45,
    maximumBankDegrees: 70,
    defaultThrottle: 0.7
  }),
  "response-jet": Object.freeze({
    id: "response-jet",
    title: "Response jet",
    description: "Faster aircraft with wider turns and higher stall speed.",
    stallSpeedMetersPerSecond: 68,
    initialSpeedMetersPerSecond: 125,
    maximumSpeedMetersPerSecond: 320,
    maximumThrustAcceleration: 20,
    dragFactor: 0.0008,
    rollingDragAcceleration: 0.25,
    pitchRateDegreesPerSecond: 36,
    rollRateDegreesPerSecond: 72,
    yawRateDegreesPerSecond: 8,
    maximumPitchDegrees: 55,
    maximumBankDegrees: 80,
    defaultThrottle: 0.66
  })
});

const PHASES = new Set([
  "paused",
  "flying",
  "collision",
  "terrain_unavailable",
  "session_limit"
]);

export function createFlightSession({
  profileId = "survey-trainer",
  position,
  terrainElevationMeters,
  startingAglMeters = 300,
  headingDegrees = 0
} = {}) {
  const profile = aircraftProfile(profileId);
  const terrain = terrainElevation(terrainElevationMeters);
  const agl = boundedNumber(
    startingAglMeters,
    FLIGHT_LIMITS.minimumStartingAglMeters,
    FLIGHT_LIMITS.maximumStartingAglMeters,
    "flight_starting_agl_invalid"
  );
  const initial = {
    position: coordinate(position),
    altitudeMeters: terrain + agl,
    terrainElevationMeters: terrain,
    headingDegrees: normalizeAngle(headingDegrees),
    pitchDegrees: 0,
    bankDegrees: 0,
    airspeedMetersPerSecond: profile.initialSpeedMetersPerSecond,
    verticalSpeedMetersPerSecond: 0,
    throttle: profile.defaultThrottle
  };
  return normalizeFlightSession({
    schemaVersion: FLIGHT_MODEL_SCHEMA_VERSION,
    profileId: profile.id,
    phase: "paused",
    elapsedMilliseconds: 0,
    ...initial,
    aglMeters: agl,
    initial
  });
}

export function normalizeFlightSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw flightError("flight_state_invalid");
  if (value.schemaVersion !== FLIGHT_MODEL_SCHEMA_VERSION) throw flightError("flight_version_unsupported");
  const profile = aircraftProfile(value.profileId);
  if (!PHASES.has(value.phase)) throw flightError("flight_phase_invalid");
  const position = coordinate(value.position);
  const terrain = terrainElevation(value.terrainElevationMeters);
  const altitude = boundedNumber(
    value.altitudeMeters,
    FLIGHT_LIMITS.minimumTerrainElevationMeters,
    FLIGHT_LIMITS.maximumAltitudeMeters,
    "flight_altitude_invalid"
  );
  const airspeed = boundedNumber(
    value.airspeedMetersPerSecond,
    0,
    profile.maximumSpeedMetersPerSecond,
    "flight_airspeed_invalid"
  );
  const initial = normalizeInitial(value.initial, profile);
  return {
    schemaVersion: FLIGHT_MODEL_SCHEMA_VERSION,
    profileId: profile.id,
    phase: value.phase,
    elapsedMilliseconds: boundedInteger(
      value.elapsedMilliseconds,
      0,
      FLIGHT_LIMITS.maximumSessionMilliseconds,
      "flight_elapsed_invalid"
    ),
    position,
    altitudeMeters: round(altitude),
    terrainElevationMeters: round(terrain),
    aglMeters: round(Math.max(0, altitude - terrain)),
    headingDegrees: normalizeAngle(value.headingDegrees),
    pitchDegrees: round(boundedNumber(
      value.pitchDegrees,
      -profile.maximumPitchDegrees,
      profile.maximumPitchDegrees,
      "flight_pitch_invalid"
    )),
    bankDegrees: round(boundedNumber(
      value.bankDegrees,
      -profile.maximumBankDegrees,
      profile.maximumBankDegrees,
      "flight_bank_invalid"
    )),
    airspeedMetersPerSecond: round(airspeed),
    verticalSpeedMetersPerSecond: round(boundedNumber(
      value.verticalSpeedMetersPerSecond,
      -profile.maximumSpeedMetersPerSecond,
      profile.maximumSpeedMetersPerSecond,
      "flight_vertical_speed_invalid"
    )),
    throttle: round(boundedNumber(value.throttle, 0, 1, "flight_throttle_invalid")),
    initial
  };
}

export function resumeFlight(value) {
  const state = normalizeFlightSession(value);
  if (["collision", "terrain_unavailable", "session_limit"].includes(state.phase)) return state;
  return {...state, phase: "flying"};
}

export function pauseFlight(value) {
  const state = normalizeFlightSession(value);
  return state.phase === "flying" ? {...state, phase: "paused"} : state;
}

export function resetFlight(value) {
  const state = normalizeFlightSession(value);
  return normalizeFlightSession({
    schemaVersion: FLIGHT_MODEL_SCHEMA_VERSION,
    profileId: state.profileId,
    phase: "paused",
    elapsedMilliseconds: 0,
    ...state.initial,
    aglMeters: state.initial.altitudeMeters - state.initial.terrainElevationMeters,
    initial: state.initial
  });
}

export function stepFlight(value, controlsValue, elapsedMilliseconds, {
  terrainElevationAt
} = {}) {
  const state = normalizeFlightSession(value);
  if (state.phase !== "flying") return state;
  const profile = aircraftProfile(state.profileId);
  const controls = normalizeFlightControls(controlsValue);
  const stepMilliseconds = boundedNumber(
    elapsedMilliseconds,
    0,
    FLIGHT_LIMITS.maximumStepMilliseconds,
    "flight_step_invalid"
  );
  if (stepMilliseconds === 0) return state;
  const nextElapsed = Math.min(
    FLIGHT_LIMITS.maximumSessionMilliseconds,
    state.elapsedMilliseconds + Math.round(stepMilliseconds)
  );
  if (nextElapsed >= FLIGHT_LIMITS.maximumSessionMilliseconds) {
    return {...state, elapsedMilliseconds: nextElapsed, phase: "session_limit"};
  }

  const seconds = stepMilliseconds / 1_000;
  const throttle = clamp(
    controls.throttle === null
      ? state.throttle + controls.throttleDeltaPerSecond * seconds
      : controls.throttle,
    0,
    1
  );
  const pitchDegrees = clamp(
    state.pitchDegrees + controls.pitch * profile.pitchRateDegreesPerSecond * seconds,
    -profile.maximumPitchDegrees,
    profile.maximumPitchDegrees
  );
  const bankDegrees = clamp(
    state.bankDegrees + controls.roll * profile.rollRateDegreesPerSecond * seconds,
    -profile.maximumBankDegrees,
    profile.maximumBankDegrees
  );
  const pitchRadians = radians(pitchDegrees);
  const drag = profile.dragFactor * state.airspeedMetersPerSecond ** 2
    + profile.rollingDragAcceleration;
  const acceleration = throttle * profile.maximumThrustAcceleration
    - drag
    - 9.80665 * Math.sin(pitchRadians);
  const airspeedMetersPerSecond = clamp(
    state.airspeedMetersPerSecond + acceleration * seconds,
    0,
    profile.maximumSpeedMetersPerSecond
  );
  const stallFraction = clamp(
    (profile.stallSpeedMetersPerSecond - airspeedMetersPerSecond) / profile.stallSpeedMetersPerSecond,
    0,
    1
  );
  const stallDescentMetersPerSecond = 9.80665 * stallFraction ** 2;
  const verticalSpeedMetersPerSecond = airspeedMetersPerSecond * Math.sin(pitchRadians)
    - stallDescentMetersPerSecond;
  const bankTurnRateDegreesPerSecond = airspeedMetersPerSecond > 1
    ? degrees(9.80665 * Math.tan(radians(bankDegrees)) / airspeedMetersPerSecond)
    : 0;
  const headingDegrees = normalizeAngle(
    state.headingDegrees
      + (bankTurnRateDegreesPerSecond + controls.yaw * profile.yawRateDegreesPerSecond) * seconds
  );
  const horizontalSpeedMetersPerSecond = Math.max(0, airspeedMetersPerSecond * Math.cos(pitchRadians));
  const position = destination(
    state.position,
    headingDegrees,
    horizontalSpeedMetersPerSecond * seconds
  );
  const sampledTerrain = sampleTerrain(terrainElevationAt, position);
  if (sampledTerrain === null) {
    return normalizeFlightSession({
      ...state,
      phase: "terrain_unavailable",
      elapsedMilliseconds: nextElapsed,
      throttle,
      pitchDegrees,
      bankDegrees,
      airspeedMetersPerSecond,
      verticalSpeedMetersPerSecond: 0
    });
  }
  const altitudeMeters = state.altitudeMeters + verticalSpeedMetersPerSecond * seconds;
  const collisionAltitude = sampledTerrain + FLIGHT_LIMITS.minimumClearanceMeters;
  if (altitudeMeters <= collisionAltitude) {
    return normalizeFlightSession({
      ...state,
      phase: "collision",
      elapsedMilliseconds: nextElapsed,
      position,
      terrainElevationMeters: sampledTerrain,
      altitudeMeters: collisionAltitude,
      headingDegrees,
      pitchDegrees,
      bankDegrees,
      airspeedMetersPerSecond: 0,
      verticalSpeedMetersPerSecond: 0,
      throttle: 0
    });
  }
  return normalizeFlightSession({
    ...state,
    phase: "flying",
    elapsedMilliseconds: nextElapsed,
    position,
    terrainElevationMeters: sampledTerrain,
    altitudeMeters,
    headingDegrees,
    pitchDegrees,
    bankDegrees,
    airspeedMetersPerSecond,
    verticalSpeedMetersPerSecond,
    throttle
  });
}

export function normalizeFlightControls(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    pitch: signedControl(source.pitch),
    roll: signedControl(source.roll),
    yaw: signedControl(source.yaw),
    throttleDeltaPerSecond: signedControl(source.throttleDeltaPerSecond),
    throttle: source.throttle === null || source.throttle === undefined
      ? null
      : clamp(finiteOr(source.throttle, 0), 0, 1)
  };
}

export function keyboardFlightControls(keysValue) {
  const keys = keysValue instanceof Set ? keysValue : new Set(keysValue ?? []);
  return normalizeFlightControls({
    pitch: Number(keys.has("ArrowDown")) - Number(keys.has("ArrowUp")),
    roll: Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft")),
    yaw: Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    throttleDeltaPerSecond: Number(keys.has("PageUp")) - Number(keys.has("PageDown"))
  });
}

export function standardControllerFlightControls(gamepad) {
  if (!gamepad || gamepad.connected !== true || gamepad.mapping !== "standard") return null;
  const axes = Array.isArray(gamepad.axes) ? gamepad.axes : [];
  if (axes.length < 4) return null;
  return normalizeFlightControls({
    roll: deadzone(axes[0]),
    pitch: deadzone(axes[1]),
    yaw: deadzone(axes[2]),
    throttle: clamp((1 - finiteOr(axes[3], 1)) / 2, 0, 1)
  });
}

export function mergeFlightControls(...values) {
  const controls = values.filter(Boolean).map(normalizeFlightControls);
  const absoluteThrottle = [...controls].reverse().find(({throttle}) => throttle !== null)?.throttle ?? null;
  return normalizeFlightControls({
    pitch: controls.reduce((sum, value) => sum + value.pitch, 0),
    roll: controls.reduce((sum, value) => sum + value.roll, 0),
    yaw: controls.reduce((sum, value) => sum + value.yaw, 0),
    throttleDeltaPerSecond: controls.reduce((sum, value) => sum + value.throttleDeltaPerSecond, 0),
    throttle: absoluteThrottle
  });
}

export function flightHud(value) {
  const state = normalizeFlightSession(value);
  return {
    phase: state.phase,
    headingDegrees: Math.round(state.headingDegrees),
    airspeedKnots: Math.round(state.airspeedMetersPerSecond * 1.94384449),
    altitudeFeet: Math.round(state.altitudeMeters * 3.280839895),
    aglFeet: Math.round(state.aglMeters * 3.280839895),
    verticalSpeedFeetPerMinute: Math.round(state.verticalSpeedMetersPerSecond * 196.8503937),
    pitchDegrees: round(state.pitchDegrees),
    bankDegrees: round(state.bankDegrees),
    throttlePercent: Math.round(state.throttle * 100),
    elapsedMilliseconds: state.elapsedMilliseconds
  };
}

export function aircraftProfile(profileId) {
  const profile = AIRCRAFT_PROFILES[profileId];
  if (!profile) throw flightError("flight_aircraft_unsupported");
  return profile;
}

function normalizeInitial(value, profile) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw flightError("flight_initial_invalid");
  return {
    position: coordinate(value.position),
    altitudeMeters: boundedNumber(
      value.altitudeMeters,
      FLIGHT_LIMITS.minimumTerrainElevationMeters,
      FLIGHT_LIMITS.maximumAltitudeMeters,
      "flight_initial_invalid"
    ),
    terrainElevationMeters: terrainElevation(value.terrainElevationMeters),
    headingDegrees: normalizeAngle(value.headingDegrees),
    pitchDegrees: boundedNumber(value.pitchDegrees, -profile.maximumPitchDegrees, profile.maximumPitchDegrees, "flight_initial_invalid"),
    bankDegrees: boundedNumber(value.bankDegrees, -profile.maximumBankDegrees, profile.maximumBankDegrees, "flight_initial_invalid"),
    airspeedMetersPerSecond: boundedNumber(value.airspeedMetersPerSecond, 0, profile.maximumSpeedMetersPerSecond, "flight_initial_invalid"),
    verticalSpeedMetersPerSecond: boundedNumber(value.verticalSpeedMetersPerSecond, -profile.maximumSpeedMetersPerSecond, profile.maximumSpeedMetersPerSecond, "flight_initial_invalid"),
    throttle: boundedNumber(value.throttle, 0, 1, "flight_initial_invalid")
  };
}

function sampleTerrain(terrainElevationAt, position) {
  if (typeof terrainElevationAt !== "function") return null;
  let elevation;
  try {
    elevation = terrainElevationAt([...position]);
  } catch {
    return null;
  }
  return Number.isFinite(elevation)
    && elevation >= FLIGHT_LIMITS.minimumTerrainElevationMeters
    && elevation <= FLIGHT_LIMITS.maximumTerrainElevationMeters
    ? elevation
    : null;
}

function destination([longitude, latitude], headingDegrees, distanceMeters) {
  if (distanceMeters === 0) return [longitude, latitude];
  const angularDistance = distanceMeters / FLIGHT_LIMITS.earthRadiusMeters;
  const bearing = radians(headingDegrees);
  const latitude1 = radians(latitude);
  const longitude1 = radians(longitude);
  const latitude2 = Math.asin(
    Math.sin(latitude1) * Math.cos(angularDistance)
      + Math.cos(latitude1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const longitude2 = longitude1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude1),
    Math.cos(angularDistance) - Math.sin(latitude1) * Math.sin(latitude2)
  );
  return [normalizeLongitude(degrees(longitude2)), clamp(round(degrees(latitude2)), -85.051129, 85.051129)];
}

function coordinate(value) {
  if (!Array.isArray(value)
    || value.length !== 2
    || !value.every(Number.isFinite)
    || value[0] < -180
    || value[0] > 180
    || value[1] < -85.051129
    || value[1] > 85.051129) {
    throw flightError("flight_position_invalid");
  }
  return value.map(round);
}

function terrainElevation(value) {
  return boundedNumber(
    value,
    FLIGHT_LIMITS.minimumTerrainElevationMeters,
    FLIGHT_LIMITS.maximumTerrainElevationMeters,
    "flight_terrain_invalid"
  );
}

function deadzone(value) {
  const axis = clamp(finiteOr(value, 0), -1, 1);
  if (Math.abs(axis) <= FLIGHT_LIMITS.controllerDeadzone) return 0;
  const magnitude = (Math.abs(axis) - FLIGHT_LIMITS.controllerDeadzone) / (1 - FLIGHT_LIMITS.controllerDeadzone);
  return Math.sign(axis) * magnitude;
}

function signedControl(value) {
  return clamp(finiteOr(value, 0), -1, 1);
}

function boundedNumber(value, minimum, maximum, code) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw flightError(code);
  return value;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw flightError(code);
  return value;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeAngle(value) {
  if (!Number.isFinite(value)) throw flightError("flight_angle_invalid");
  return round(((value % 360) + 360) % 360);
}

function normalizeLongitude(value) {
  const normalized = ((value + 540) % 360) - 180;
  return round(normalized === -180 ? 180 : normalized);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function radians(value) {
  return value * Math.PI / 180;
}

function degrees(value) {
  return value * 180 / Math.PI;
}

function round(value) {
  return Number(value.toFixed(9));
}

function flightError(code) {
  return Object.assign(new Error(code), {code});
}
