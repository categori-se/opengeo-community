import {
  EARTH_SPATIAL_BODY,
  meanRadiusMeters,
  spatialBodyDefinition,
  spatialBodyDistanceMeters
} from "./spatialBody.js";

export const AREA_MEASUREMENT_SCHEMA_VERSION = "opengeo.area-measurement.1.0.0";

export const AREA_MEASUREMENT_LIMITS = Object.freeze({
  maximumVertices: 128,
  maximumAreaSquareMeters: 1_000_000_000_000_000,
  maximumDistanceMeters: 2_000_000_000,
  circleRenderSegments: 64
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function createPolygonMeasurement({
  id,
  title = "Measured polygon",
  coordinates,
  spatialBody = EARTH_SPATIAL_BODY
}) {
  const body = normalizedBody(spatialBody);
  const vertices = normalizePolygonCoordinates(coordinates);
  validateIdentity(id, title);
  const perimeterMeters = polygonPerimeterMeters(vertices, body);
  const areaSquareMeters = sphericalPolygonAreaSquareMeters(vertices, body);
  validateMagnitude(perimeterMeters, areaSquareMeters);
  return Object.freeze({
    schemaVersion: AREA_MEASUREMENT_SCHEMA_VERSION,
    id,
    title,
    kind: "polygon-area",
    spatialBodyId: body.id,
    measurementModel: body.measurement.model,
    distanceUnit: "meter",
    areaUnit: "square-meter",
    coordinates: vertices,
    perimeterMeters: rounded(perimeterMeters),
    areaSquareMeters: rounded(areaSquareMeters)
  });
}

export function createCircleMeasurement({
  id,
  title = "Measured circle",
  center,
  radiusPoint,
  spatialBody = EARTH_SPATIAL_BODY
}) {
  const body = normalizedBody(spatialBody);
  const normalizedCenter = normalizeCoordinate(center);
  const normalizedRadiusPoint = normalizeCoordinate(radiusPoint);
  validateIdentity(id, title);
  const radius = meanRadiusMeters(body);
  const radiusMeters = spatialBodyDistanceMeters(normalizedCenter, normalizedRadiusPoint, body);
  const angularRadius = radiusMeters / radius;
  const circumferenceMeters = 2 * Math.PI * radius * Math.sin(angularRadius);
  const areaSquareMeters = 2 * Math.PI * radius ** 2 * (1 - Math.cos(angularRadius));
  validateMagnitude(radiusMeters, areaSquareMeters);
  if (!Number.isFinite(circumferenceMeters)
    || circumferenceMeters <= 0
    || circumferenceMeters > AREA_MEASUREMENT_LIMITS.maximumDistanceMeters) {
    throw measurementError("circle_circumference_invalid");
  }
  return Object.freeze({
    schemaVersion: AREA_MEASUREMENT_SCHEMA_VERSION,
    id,
    title,
    kind: "circle-area",
    spatialBodyId: body.id,
    measurementModel: body.measurement.model,
    distanceUnit: "meter",
    areaUnit: "square-meter",
    center: normalizedCenter,
    radiusPoint: normalizedRadiusPoint,
    radiusMeters: rounded(radiusMeters),
    circumferenceMeters: rounded(circumferenceMeters),
    areaSquareMeters: rounded(areaSquareMeters)
  });
}

export function normalizeAreaMeasurement(value, {spatialBody = EARTH_SPATIAL_BODY} = {}) {
  const body = normalizedBody(spatialBody);
  if (!plainObject(value)
    || value.schemaVersion !== AREA_MEASUREMENT_SCHEMA_VERSION
    || !["polygon-area", "circle-area"].includes(value.kind)
    || value.spatialBodyId !== body.id
    || value.measurementModel !== body.measurement.model
    || value.distanceUnit !== "meter"
    || value.areaUnit !== "square-meter") {
    throw measurementError("area_measurement_invalid");
  }
  validateIdentity(value.id, value.title);
  const expected = value.kind === "polygon-area"
    ? createPolygonMeasurement({
        id: value.id,
        title: value.title,
        coordinates: value.coordinates,
        spatialBody: body
      })
    : createCircleMeasurement({
        id: value.id,
        title: value.title,
        center: value.center,
        radiusPoint: value.radiusPoint,
        spatialBody: body
      });
  const numericFields = value.kind === "polygon-area"
    ? ["perimeterMeters", "areaSquareMeters"]
    : ["radiusMeters", "circumferenceMeters", "areaSquareMeters"];
  if (Object.keys(value).length !== Object.keys(expected).length
    || Object.keys(value).some((key) => !(key in expected))
    || numericFields.some((field) => !closeNumber(value[field], expected[field], field === "areaSquareMeters" ? 0.1 : 0.01))) {
    throw measurementError("area_measurement_summary_invalid");
  }
  return structuredClone(expected);
}

export function polygonMeasurementMetrics(coordinates, spatialBody = EARTH_SPATIAL_BODY) {
  const body = normalizedBody(spatialBody);
  const vertices = normalizePolygonCoordinates(coordinates);
  return {
    perimeterMeters: polygonPerimeterMeters(vertices, body),
    areaSquareMeters: sphericalPolygonAreaSquareMeters(vertices, body)
  };
}

export function circleMeasurementMetrics(center, radiusPoint, spatialBody = EARTH_SPATIAL_BODY) {
  const measurement = createCircleMeasurement({
    id: "draft-circle",
    title: "Draft circle",
    center,
    radiusPoint,
    spatialBody
  });
  return {
    radiusMeters: measurement.radiusMeters,
    circumferenceMeters: measurement.circumferenceMeters,
    areaSquareMeters: measurement.areaSquareMeters
  };
}

export function circlePolygonCoordinates(measurement, segments = AREA_MEASUREMENT_LIMITS.circleRenderSegments) {
  if (measurement?.kind !== "circle-area") return [];
  const body = spatialBodyDefinition(measurement.spatialBodyId);
  const angularDistance = measurement.radiusMeters / meanRadiusMeters(body);
  const [longitude, latitude] = measurement.center.map(radians);
  const ring = [];
  for (let index = 0; index <= segments; index += 1) {
    const bearing = 2 * Math.PI * index / segments;
    const destinationLatitude = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance)
      + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const destinationLongitude = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    ring.push([
      rounded(normalizeLongitude(degrees(destinationLongitude)), 9),
      rounded(degrees(destinationLatitude), 9)
    ]);
  }
  return ring;
}

export function formatMeasurementArea(squareMeters) {
  if (!Number.isFinite(squareMeters) || squareMeters < 0) return "Unavailable";
  if (squareMeters >= 1_000_000) {
    const squareKilometers = squareMeters / 1_000_000;
    return `${squareKilometers.toFixed(squareKilometers >= 100 ? 0 : squareKilometers >= 10 ? 1 : 2)} km²`;
  }
  return `${squareMeters.toFixed(squareMeters >= 100 ? 0 : 1)} m²`;
}

function polygonPerimeterMeters(coordinates, body) {
  let perimeter = 0;
  for (let index = 0; index < coordinates.length; index += 1) {
    perimeter += spatialBodyDistanceMeters(coordinates[index], coordinates[(index + 1) % coordinates.length], body);
  }
  return perimeter;
}

function sphericalPolygonAreaSquareMeters(coordinates, body) {
  const origin = unitVector(coordinates[0]);
  let signedExcess = 0;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const second = unitVector(coordinates[index]);
    const third = unitVector(coordinates[index + 1]);
    const determinant = dot(origin, cross(second, third));
    const denominator = 1 + dot(origin, second) + dot(second, third) + dot(third, origin);
    signedExcess += 2 * Math.atan2(determinant, denominator);
  }
  const fullSphere = 4 * Math.PI * meanRadiusMeters(body) ** 2;
  const rawArea = Math.abs(signedExcess) * meanRadiusMeters(body) ** 2;
  return rawArea > fullSphere / 2 ? fullSphere - rawArea : rawArea;
}

function normalizePolygonCoordinates(value) {
  if (!Array.isArray(value)) throw measurementError("polygon_coordinates_invalid");
  const coordinates = value.map(normalizeCoordinate);
  if (coordinates.length > 3 && sameCoordinate(coordinates[0], coordinates.at(-1))) coordinates.pop();
  if (coordinates.length < 3 || coordinates.length > AREA_MEASUREMENT_LIMITS.maximumVertices) {
    throw measurementError("polygon_coordinates_invalid");
  }
  const keys = new Set(coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`));
  if (keys.size !== coordinates.length || longitudeSpan(coordinates) > 180 || polygonSelfIntersects(coordinates)) {
    throw measurementError("polygon_geometry_invalid");
  }
  return coordinates;
}

function polygonSelfIntersects(coordinates) {
  const edges = coordinates.map((start, index) => [start, coordinates[(index + 1) % coordinates.length]]);
  for (let first = 0; first < edges.length; first += 1) {
    for (let second = first + 1; second < edges.length; second += 1) {
      if (second === first + 1 || first === 0 && second === edges.length - 1) continue;
      if (segmentsIntersect(...edges[first], ...edges[second])) return true;
    }
  }
  return false;
}

function segmentsIntersect(a, b, c, d) {
  const orientation = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second <= 0 && third * fourth <= 0;
}

function validateIdentity(id, title) {
  if (!IDENTIFIER.test(id ?? "")) throw measurementError("measurement_id_invalid");
  if (typeof title !== "string" || title.trim() !== title || !title || title.length > 200) {
    throw measurementError("measurement_title_invalid");
  }
}

function validateMagnitude(distanceMeters, areaSquareMeters) {
  if (!Number.isFinite(distanceMeters)
    || distanceMeters <= 0
    || distanceMeters > AREA_MEASUREMENT_LIMITS.maximumDistanceMeters) {
    throw measurementError("measurement_distance_invalid");
  }
  if (!Number.isFinite(areaSquareMeters)
    || areaSquareMeters <= 0
    || areaSquareMeters > AREA_MEASUREMENT_LIMITS.maximumAreaSquareMeters) {
    throw measurementError("measurement_area_invalid");
  }
}

function normalizeCoordinate(value) {
  if (!Array.isArray(value)
    || value.length !== 2
    || !value.every(Number.isFinite)
    || value[0] < -180
    || value[0] > 180
    || value[1] < -85.05112878
    || value[1] > 85.05112878) {
    throw measurementError("measurement_coordinate_invalid");
  }
  return [...value];
}

function normalizedBody(value) {
  const body = spatialBodyDefinition(value?.id);
  return JSON.stringify(body) === JSON.stringify(value) ? value : body;
}

function unitVector([longitude, latitude]) {
  const lambda = radians(longitude);
  const phi = radians(latitude);
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function longitudeSpan(coordinates) {
  const longitudes = coordinates.map(([longitude]) => longitude);
  return Math.max(...longitudes) - Math.min(...longitudes);
}

function normalizeLongitude(value) {
  return ((value + 540) % 360) - 180;
}

function sameCoordinate(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function closeNumber(left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function rounded(value, decimals = 6) {
  return Number(value.toFixed(decimals));
}

function radians(value) {
  return value * Math.PI / 180;
}

function degrees(value) {
  return value * 180 / Math.PI;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function measurementError(code) {
  return Object.assign(new Error(code), {code});
}
