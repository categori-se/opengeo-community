export const SPATIAL_BODY_SCHEMA_VERSION = "opengeo.spatial-body.1.0.0";

const RENDERER_BOUNDS = Object.freeze([-180, -85.05112878, 180, 85.05112878]);

const BODY_RECORDS = Object.freeze([
  bodyRecord({
    id: "earth",
    title: "Earth",
    coordinateSystem: "wgs84-longitude-latitude-degrees",
    semiMajorAxisMeters: 6_378_137,
    inverseFlattening: 298.257223563
  }),
  bodyRecord({
    id: "moon",
    title: "Moon",
    coordinateSystem: "east-positive-longitude-planetocentric-latitude-degrees",
    semiMajorAxisMeters: 1_737_400,
    inverseFlattening: 0
  }),
  bodyRecord({
    id: "mars",
    title: "Mars",
    coordinateSystem: "east-positive-longitude-planetocentric-latitude-degrees",
    semiMajorAxisMeters: 3_396_190,
    inverseFlattening: 169.894447
  })
]);

const BODY_BY_ID = new Map(BODY_RECORDS.map((record) => [record.id, record]));

export const SPATIAL_BODIES = BODY_RECORDS;
export const EARTH_SPATIAL_BODY = BODY_BY_ID.get("earth");

export function spatialBodyDefinition(id = "earth") {
  return structuredClone(BODY_BY_ID.get(id) ?? EARTH_SPATIAL_BODY);
}

export function spatialBodyForProject(project) {
  const candidate = project?.spatialBody;
  const expected = BODY_BY_ID.get(candidate?.id);
  return expected && exactJson(candidate, expected)
    ? structuredClone(expected)
    : spatialBodyDefinition();
}

export function spatialBodyForBasemap(basemap) {
  const id = basemap?.spatialBodyId;
  return spatialBodyDefinition(BODY_BY_ID.has(id) ? id : "earth");
}

export function meanRadiusMeters(body) {
  const semiMajor = Number(body?.ellipsoid?.semiMajorAxisMeters);
  const inverseFlattening = Number(body?.ellipsoid?.inverseFlattening);
  if (!Number.isFinite(semiMajor) || semiMajor <= 0) return meanRadiusMeters(EARTH_SPATIAL_BODY);
  if (!Number.isFinite(inverseFlattening) || inverseFlattening <= 0) return semiMajor;
  const polar = semiMajor * (1 - (1 / inverseFlattening));
  return ((2 * semiMajor) + polar) / 3;
}

export function spatialBodyDistanceMeters(a, b, body = EARTH_SPATIAL_BODY) {
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * meanRadiusMeters(body) * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bodyRecord({id, title, coordinateSystem, semiMajorAxisMeters, inverseFlattening}) {
  return deepFreeze({
    schemaVersion: SPATIAL_BODY_SCHEMA_VERSION,
    id,
    title,
    coordinateSystem,
    rendererProjection: "web-mercator-angular",
    rendererBounds: [...RENDERER_BOUNDS],
    ellipsoid: {
      semiMajorAxisMeters,
      inverseFlattening
    },
    measurement: {
      model: "spherical-mean-radius",
      distanceUnit: "meter",
      areaUnit: "square-meter"
    },
    camera: {
      model: "maplibre-angular-zoom",
      physicalAltitude: false
    }
  });
}

function exactJson(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function radians(value) {
  return value * Math.PI / 180;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
