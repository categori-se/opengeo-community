import {
  EARTH_SPATIAL_BODY,
  meanRadiusMeters,
  spatialBodyDistanceMeters,
  spatialBodyDefinition
} from "./spatialBody.js";
import {sightLineModel} from "./sightLineModel.js";

export const PATH_MEASUREMENT_SCHEMA_VERSION = "opengeo.path-measurement.1.0.0";

export const PATH_MEASUREMENT_LIMITS = Object.freeze({
  maximumMeasurements: 50,
  maximumVertices: 128,
  maximumSamples: 128,
  targetSampleSpacingMeters: 250,
  maximumAbsoluteElevationMeters: 100_000
});

export const LINE_OF_SIGHT_LIMITS = Object.freeze({
  maximumDistanceMeters: 100_000,
  maximumHeightMeters: 1_000,
  maximumUncertaintyMeters: 1_000,
  maximumAxisDeviationMeters: 1,
  toleranceMeters: 0.01,
  maximumExportBytes: 128 * 1024
});

/** Inspect saved samples only. A clear result applies to these samples, never
 * to unsampled terrain or a whole viewshed. Elevations use their recorded datum.
 * The curved model intersects a chord with radial directions on the mean sphere;
 * it does not apply refraction, vegetation, buildings or an ellipsoid correction.
 */
export function analyzeProfileLineOfSight(measurement, {
  observerHeightMeters = 1.75,
  targetHeightMeters = 0,
  uncertaintyMeters = null,
  curvature = true
} = {}) {
  for (const height of [observerHeightMeters, targetHeightMeters]) {
    if (!Number.isFinite(height) || height < 0 || height > LINE_OF_SIGHT_LIMITS.maximumHeightMeters) {
      throw measurementError("line_of_sight_height_invalid");
    }
  }
  if (typeof curvature !== "boolean" || uncertaintyMeters !== null
    && (!Number.isFinite(uncertaintyMeters) || uncertaintyMeters < 0
      || uncertaintyMeters > LINE_OF_SIGHT_LIMITS.maximumUncertaintyMeters)) {
    throw measurementError("line_of_sight_options_invalid");
  }
  const body = spatialBodyDefinition(measurement?.spatialBodyId);
  const [input] = normalizePathMeasurements([measurement], {spatialBody: body});
  if (!input || input.coordinates.length !== 2) throw measurementError("line_of_sight_straight_profile_required");
  const length = input.horizontalDistanceMeters, radius = meanRadiusMeters(body);
  if (length < 1 || length > LINE_OF_SIGHT_LIMITS.maximumDistanceMeters) throw measurementError("line_of_sight_distance_limit");
  const sourceSamples = input.terrainProfile.samples;
  const result = {
    schemaVersion: "opengeo.profile-line-of-sight.1.0.0",
    status: "incomplete",
    reason: null,
    input,
    options: {observerHeightMeters, targetHeightMeters, uncertaintyMeters, curvature},
    model: {geometry: curvature ? "spherical-chord" : "planar-profile", radiusMeters: radius,
      refraction: false, elevationDatum: "retained-provider-datum", verticalAccuracy: "provider-not-declared",
      toleranceMeters: LINE_OF_SIGHT_LIMITS.toleranceMeters, betweenSamples: "not-evaluated"},
    maximumSampleSpacingMeters: Math.max(...sourceSamples.slice(1).map((s,i) => s.distanceMeters-sourceSamples[i].distanceMeters)),
    maximumAxisDeviationMeters: axisDeviation(input.coordinates, sourceSamples, radius),
    minimumClearanceMeters: null,
    uncertaintyResult: "not-evaluated",
    samples: []
  };
  if (input.terrainProfile.status !== "complete") {result.reason = "missing-elevation-samples";return result;}
  if (sourceSamples.length < 3) {result.reason = "no-interior-samples";return result;}
  if (result.maximumAxisDeviationMeters > LINE_OF_SIGHT_LIMITS.maximumAxisDeviationMeters) {
    result.reason = "samples-outside-sight-axis";return result;
  }
  const first = sourceSamples[0].elevationMeters + observerHeightMeters;
  const last = sourceSamples.at(-1).elevationMeters + targetHeightMeters;
  const {heightAt: rayAt} = sightLineModel({distanceMeters:length,radiusMeters:radius,
    observerElevationMeters:first,targetElevationMeters:last,curvature});
  result.samples = sourceSamples.map((sample,index) => {
    const rayElevationMeters = rayAt(sample.distanceMeters);
    const clearanceMeters = rayElevationMeters - sample.elevationMeters;
    const interior = index > 0 && index < sourceSamples.length-1;
    return {...sample, rayElevationMeters, clearanceMeters, interior,
      minimumClearanceMeters: uncertaintyMeters === null || !interior ? null
        : rayAt(sample.distanceMeters,-uncertaintyMeters) - sample.elevationMeters - uncertaintyMeters,
      maximumClearanceMeters: uncertaintyMeters === null || !interior ? null
        : rayAt(sample.distanceMeters,uncertaintyMeters) - sample.elevationMeters + uncertaintyMeters};
  });
  const interior = result.samples.filter(s => s.interior), tolerance = LINE_OF_SIGHT_LIMITS.toleranceMeters;
  result.minimumClearanceMeters = Math.min(...interior.map(s => s.clearanceMeters));
  result.status = result.minimumClearanceMeters < -tolerance ? "sampled-obstruction"
    : result.minimumClearanceMeters > tolerance ? "sampled-clear" : "grazing";
  if (uncertaintyMeters !== null) {
    result.uncertaintyResult = interior.some(s => s.maximumClearanceMeters < -tolerance) ? "obstructed-within-bound"
      : interior.every(s => s.minimumClearanceMeters > tolerance) ? "clear-within-bound" : "uncertain";
  }
  return result;
}

function axisDeviation(coordinates, samples, radius) {
  const unit = ([lon,lat]) => {
    const a=lon*Math.PI/180,b=lat*Math.PI/180;
    return [Math.cos(b)*Math.cos(a),Math.cos(b)*Math.sin(a),Math.sin(b)];
  };
  const [a,b]=coordinates.map(unit), normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=Math.hypot(...normal);
  return Math.max(...samples.map(sample => {
    const p=unit(sample.coordinate);
    return radius*Math.asin(Math.min(1,Math.abs(p.reduce((sum,v,i)=>sum+v*normal[i],0))/norm));
  }));
}

export function profileLineOfSightJSON(result) {
  // Recompute from closed, validated inputs rather than exporting caller-added
  // properties or trusting a modified numerical result.
  const record = analyzeProfileLineOfSight(result?.input, result?.options);
  const terms = record.input.terrainProfile.source?.termsUrl;
  const credentials = /(?:token|key|secret|signature|credential|authorization|session)/i;
  if (terms && (credentials.test(new URL(terms).search)
    || [...new URL(terms).searchParams.keys()].some(name => credentials.test(name)))) {
    throw measurementError("line_of_sight_private_source_url");
  }
  const body = JSON.stringify(record, null, 2) + "\n";
  if (new TextEncoder().encode(body).length > LINE_OF_SIGHT_LIMITS.maximumExportBytes) {
    throw measurementError("line_of_sight_export_limit");
  }
  return body;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * Build a deterministic saved path measurement. Horizontal distance follows
 * the selected spatial body's spherical mean-radius model. Terrain elevations
 * are optional renderer samples and remain explicitly distinct from survey or
 * authoritative elevation observations.
 */
export function createPathMeasurement({
  id,
  title = "Measured path",
  coordinates,
  spatialBody = EARTH_SPATIAL_BODY,
  elevationAt = null,
  terrainSource = null
}) {
  const body = normalizedBody(spatialBody);
  const vertices = normalizeCoordinates(coordinates);
  if (!IDENTIFIER.test(id ?? "")) throw measurementError("measurement_id_invalid");
  if (typeof title !== "string" || title.trim() !== title || !title || title.length > 200) {
    throw measurementError("measurement_title_invalid");
  }
  const horizontalDistanceMeters = pathDistance(vertices, body);
  const sampleCoordinates = samplePath(vertices, body, horizontalDistanceMeters);
  const samples = [];
  let previous = null;
  let distanceMeters = 0;
  for (const coordinate of sampleCoordinates) {
    if (previous) distanceMeters += spatialBodyDistanceMeters(previous, coordinate, body);
    const elevationMeters = terrainElevation(elevationAt, coordinate);
    samples.push({
      distanceMeters: rounded(distanceMeters),
      coordinate,
      elevationMeters
    });
    previous = coordinate;
  }
  // The final sample names the exact authored horizontal path length. Sampling
  // uses bounded linear angular interpolation; the authored vertices remain the
  // authoritative distance geometry.
  samples.at(-1).distanceMeters = rounded(horizontalDistanceMeters);
  const profile = terrainProfile(samples, terrainSource);
  return Object.freeze({
    schemaVersion: PATH_MEASUREMENT_SCHEMA_VERSION,
    id,
    title,
    kind: "path-profile",
    spatialBodyId: body.id,
    measurementModel: body.measurement.model,
    distanceUnit: "meter",
    coordinates: vertices,
    horizontalDistanceMeters: rounded(horizontalDistanceMeters),
    terrainProfile: profile
  });
}

export function normalizePathMeasurements(value, {spatialBody = EARTH_SPATIAL_BODY} = {}) {
  if (!Array.isArray(value)) return [];
  if (value.length > PATH_MEASUREMENT_LIMITS.maximumMeasurements) return [];
  const body = normalizedBody(spatialBody);
  try {
    return value.map((measurement) => validateSavedMeasurement(measurement, body));
  } catch {
    return [];
  }
}

export function measurementGeojson(measurements, draftCoordinates = []) {
  const features = [];
  for (const measurement of measurements ?? []) {
    if (!Array.isArray(measurement?.coordinates) || measurement.coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      id: measurement.id,
      properties: {kind: "saved", measurementId: measurement.id, title: measurement.title},
      geometry: {type: "LineString", coordinates: measurement.coordinates}
    });
  }
  for (const [index, coordinates] of (draftCoordinates ?? []).entries()) {
    features.push({
      type: "Feature",
      properties: {kind: "draft-point", vertex: index + 1},
      geometry: {type: "Point", coordinates}
    });
  }
  if ((draftCoordinates ?? []).length >= 2) {
    features.push({
      type: "Feature",
      properties: {kind: "draft"},
      geometry: {type: "LineString", coordinates: draftCoordinates}
    });
  }
  return {type: "FeatureCollection", features};
}

export function formatMeasurementDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return "Unavailable";
  if (meters >= 1_000) return `${(meters / 1_000).toFixed(meters >= 100_000 ? 0 : meters >= 10_000 ? 1 : 2)} km`;
  return `${meters.toFixed(meters >= 100 ? 0 : 1)} m`;
}

export function measurementSlopeSummary(measurement) {
  const samples = measurement?.terrainProfile?.samples;
  if (measurement?.terrainProfile?.status !== "complete"
    || !Array.isArray(samples)
    || samples.length < 2) {
    return {status: "unavailable"};
  }
  let steepestUphillGradePercent = 0;
  let steepestDownhillGradePercent = 0;
  let maximumAbsoluteGradePercent = 0;
  let maximumSampleSpacingMeters = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!Number.isFinite(previous?.distanceMeters)
      || !Number.isFinite(current?.distanceMeters)
      || !Number.isFinite(previous?.elevationMeters)
      || !Number.isFinite(current?.elevationMeters)) {
      return {status: "unavailable"};
    }
    const horizontal = current.distanceMeters - previous.distanceMeters;
    const vertical = current.elevationMeters - previous.elevationMeters;
    if (!Number.isFinite(horizontal) || horizontal <= 0) return {status: "unavailable"};
    const grade = vertical / horizontal * 100;
    steepestUphillGradePercent = Math.max(steepestUphillGradePercent, grade);
    steepestDownhillGradePercent = Math.min(steepestDownhillGradePercent, grade);
    maximumAbsoluteGradePercent = Math.max(maximumAbsoluteGradePercent, Math.abs(grade));
    maximumSampleSpacingMeters = Math.max(maximumSampleSpacingMeters, horizontal);
  }
  return {
    status: "complete",
    steepestUphillGradePercent: rounded(steepestUphillGradePercent),
    steepestDownhillGradePercent: rounded(steepestDownhillGradePercent),
    maximumAbsoluteGradePercent: rounded(maximumAbsoluteGradePercent),
    maximumSlopeDegrees: rounded(Math.atan(maximumAbsoluteGradePercent / 100) * 180 / Math.PI),
    maximumSampleSpacingMeters: rounded(maximumSampleSpacingMeters),
    accuracy: "terrain-provider-not-declared"
  };
}

function validateSavedMeasurement(value, body) {
  if (!plainObject(value)
    || value.schemaVersion !== PATH_MEASUREMENT_SCHEMA_VERSION
    || value.kind !== "path-profile"
    || !IDENTIFIER.test(value.id ?? "")
    || typeof value.title !== "string"
    || value.title.trim() !== value.title
    || !value.title
    || value.title.length > 200
    || value.spatialBodyId !== body.id
    || value.measurementModel !== body.measurement.model
    || value.distanceUnit !== "meter") {
    throw measurementError("measurement_invalid");
  }
  const coordinates = normalizeCoordinates(value.coordinates);
  const horizontalDistanceMeters = pathDistance(coordinates, body);
  if (!closeNumber(value.horizontalDistanceMeters, horizontalDistanceMeters, 0.01)) {
    throw measurementError("measurement_distance_invalid");
  }
  const terrainProfileValue = normalizeSavedTerrainProfile(
    value.terrainProfile,
    coordinates,
    horizontalDistanceMeters,
    body
  );
  return {
    schemaVersion: PATH_MEASUREMENT_SCHEMA_VERSION,
    id: value.id,
    title: value.title,
    kind: "path-profile",
    spatialBodyId: body.id,
    measurementModel: body.measurement.model,
    distanceUnit: "meter",
    coordinates,
    horizontalDistanceMeters: rounded(horizontalDistanceMeters),
    terrainProfile: terrainProfileValue
  };
}

function normalizeSavedTerrainProfile(value, coordinates, horizontalDistanceMeters, body) {
  if (!plainObject(value)
    || !["complete", "partial", "unavailable"].includes(value.status)
    || !Array.isArray(value.samples)
    || value.samples.length < 2
    || value.samples.length > PATH_MEASUREMENT_LIMITS.maximumSamples) {
    throw measurementError("measurement_profile_invalid");
  }
  const source = normalizeTerrainSource(value.source, value.status);
  const expectedCoordinates = samplePath(coordinates, body, horizontalDistanceMeters);
  if (value.samples.length !== expectedCoordinates.length) {
    throw measurementError("measurement_profile_invalid");
  }
  const expectedDistances = [];
  let expectedDistance = 0;
  for (let index = 0; index < expectedCoordinates.length; index += 1) {
    if (index > 0) {
      expectedDistance += spatialBodyDistanceMeters(
        expectedCoordinates[index - 1],
        expectedCoordinates[index],
        body
      );
    }
    expectedDistances.push(rounded(expectedDistance));
  }
  expectedDistances[expectedDistances.length - 1] = rounded(horizontalDistanceMeters);
  let previousDistance = -1;
  const samples = value.samples.map((sample, index) => {
    if (!plainObject(sample)
      || !Number.isFinite(sample.distanceMeters)
      || sample.distanceMeters < 0
      || sample.distanceMeters < previousDistance
      || !validCoordinate(sample.coordinate)
      || !sameCoordinate(sample.coordinate, expectedCoordinates[index])
      || !closeNumber(sample.distanceMeters, expectedDistances[index], 0.01)
      || sample.elevationMeters !== null && !validElevation(sample.elevationMeters)) {
      throw measurementError("measurement_profile_invalid");
    }
    previousDistance = sample.distanceMeters;
    return {
      distanceMeters: rounded(sample.distanceMeters),
      coordinate: [...sample.coordinate],
      elevationMeters: sample.elevationMeters === null ? null : rounded(sample.elevationMeters)
    };
  });
  if (!sameCoordinate(samples[0].coordinate, coordinates[0])
    || !sameCoordinate(samples.at(-1).coordinate, coordinates.at(-1))
    || !closeNumber(samples.at(-1).distanceMeters, horizontalDistanceMeters, 0.01)) {
    throw measurementError("measurement_profile_invalid");
  }
  const expected = terrainProfile(samples, source);
  if (expected.status !== value.status || !summaryMatches(value.summary, expected.summary)) {
    throw measurementError("measurement_profile_invalid");
  }
  return expected;
}

function terrainProfile(samples, sourceValue) {
  const elevations = samples.map(({elevationMeters}) => elevationMeters);
  const available = elevations.filter(Number.isFinite);
  const status = available.length === samples.length
    ? "complete"
    : available.length > 0 ? "partial" : "unavailable";
  const source = normalizeTerrainSource(sourceValue, status);
  let threeDimensionalDistanceMeters = null;
  let ascentMeters = null;
  let descentMeters = null;
  if (status === "complete") {
    threeDimensionalDistanceMeters = 0;
    ascentMeters = 0;
    descentMeters = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const horizontal = current.distanceMeters - previous.distanceMeters;
      const vertical = current.elevationMeters - previous.elevationMeters;
      threeDimensionalDistanceMeters += Math.hypot(horizontal, vertical);
      if (vertical > 0) ascentMeters += vertical;
      else descentMeters += Math.abs(vertical);
    }
  }
  return {
    status,
    source,
    samples: samples.map((sample) => ({
      distanceMeters: rounded(sample.distanceMeters),
      coordinate: [...sample.coordinate],
      elevationMeters: sample.elevationMeters === null ? null : rounded(sample.elevationMeters)
    })),
    summary: {
      threeDimensionalDistanceMeters: nullableRounded(threeDimensionalDistanceMeters),
      minimumElevationMeters: available.length ? rounded(Math.min(...available)) : null,
      maximumElevationMeters: available.length ? rounded(Math.max(...available)) : null,
      ascentMeters: nullableRounded(ascentMeters),
      descentMeters: nullableRounded(descentMeters)
    }
  };
}

function normalizeTerrainSource(value, status) {
  if (status === "unavailable") return null;
  if (!plainObject(value)
    || !IDENTIFIER.test(value.sourceId ?? "")
    || typeof value.provider !== "string"
    || value.provider.trim() !== value.provider
    || !value.provider
    || value.provider.length > 120
    || value.queryMode !== "renderer-unexaggerated-point-sample"
    || typeof value.termsUrl !== "string"
    || value.termsUrl.length > 2_048
    || typeof value.observedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.observedAt)) {
    throw measurementError("measurement_terrain_source_invalid");
  }
  let terms;
  try {
    terms = new URL(value.termsUrl);
  } catch {
    throw measurementError("measurement_terrain_source_invalid");
  }
  if (terms.protocol !== "https:" || terms.username || terms.password || terms.hash) {
    throw measurementError("measurement_terrain_source_invalid");
  }
  return {
    sourceId: value.sourceId,
    provider: value.provider,
    queryMode: value.queryMode,
    termsUrl: terms.href,
    observedAt: value.observedAt
  };
}

function samplePath(coordinates, body, totalDistance) {
  const sampleCount = Math.min(
    PATH_MEASUREMENT_LIMITS.maximumSamples,
    Math.max(2, Math.ceil(totalDistance / PATH_MEASUREMENT_LIMITS.targetSampleSpacingMeters) + 1)
  );
  const segments = [];
  let cursor = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const length = spatialBodyDistanceMeters(coordinates[index - 1], coordinates[index], body);
    segments.push({start: coordinates[index - 1], end: coordinates[index], from: cursor, to: cursor + length});
    cursor += length;
  }
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const target = totalDistance * index / (sampleCount - 1);
    const segment = segments.find(({to}) => target <= to) ?? segments.at(-1);
    const ratio = segment.to === segment.from ? 0 : (target - segment.from) / (segment.to - segment.from);
    samples.push(interpolateCoordinate(segment.start, segment.end, Math.max(0, Math.min(1, ratio))));
  }
  samples[0] = [...coordinates[0]];
  samples[samples.length - 1] = [...coordinates.at(-1)];
  return samples;
}

function interpolateCoordinate(start, end, ratio) {
  const longitudeDelta = (((end[0] - start[0] + 540) % 360) + 360) % 360 - 180;
  let longitude = start[0] + longitudeDelta * ratio;
  if (longitude > 180) longitude -= 360;
  if (longitude < -180) longitude += 360;
  return [rounded(longitude, 9), rounded(start[1] + (end[1] - start[1]) * ratio, 9)];
}

function terrainElevation(elevationAt, coordinate) {
  if (typeof elevationAt !== "function") return null;
  let value;
  try {
    value = elevationAt([...coordinate]);
  } catch {
    return null;
  }
  return validElevation(value) ? rounded(value) : null;
}

function pathDistance(coordinates, body) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += spatialBodyDistanceMeters(coordinates[index - 1], coordinates[index], body);
  }
  if (!Number.isFinite(total) || total <= 0 || total > 2_000_000_000) {
    throw measurementError("measurement_distance_invalid");
  }
  return total;
}

function normalizeCoordinates(value) {
  if (!Array.isArray(value)
    || value.length < 2
    || value.length > PATH_MEASUREMENT_LIMITS.maximumVertices
    || !value.every(validCoordinate)) {
    throw measurementError("measurement_coordinates_invalid");
  }
  return value.map((coordinate) => [...coordinate]);
}

function normalizedBody(value) {
  const body = spatialBodyDefinition(value?.id);
  if (JSON.stringify(body) !== JSON.stringify(value)) return body;
  return value;
}

function validCoordinate(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every(Number.isFinite)
    && value[0] >= -180
    && value[0] <= 180
    && value[1] >= -85.05112878
    && value[1] <= 85.05112878;
}

function validElevation(value) {
  return Number.isFinite(value)
    && value !== -32_768
    && Math.abs(value) <= PATH_MEASUREMENT_LIMITS.maximumAbsoluteElevationMeters;
}

function summaryMatches(value, expected) {
  if (!plainObject(value)
    || Object.keys(value).length !== Object.keys(expected).length
    || Object.keys(value).some((key) => !(key in expected))) return false;
  return Object.keys(expected).every((key) => {
    const left = value[key];
    const right = expected[key];
    return left === null && right === null || closeNumber(left, right, 0.01);
  });
}

function closeNumber(left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function sameCoordinate(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && closeNumber(left[0], right[0], 1e-9)
    && closeNumber(left[1], right[1], 1e-9);
}

function rounded(value, decimals = 6) {
  return Number(value.toFixed(decimals));
}

function nullableRounded(value) {
  return Number.isFinite(value) ? rounded(value) : null;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function measurementError(code) {
  return Object.assign(new Error(code), {code});
}
