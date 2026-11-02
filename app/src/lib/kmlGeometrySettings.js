const ALTITUDE_MODES = new Set([
  null,
  "clampToGround",
  "relativeToGround",
  "absolute",
  "gx:clampToSeaFloor",
  "gx:relativeToSeaFloor"
]);
const CONTROL_FIELDS = ["altitudeMode", "extrude", "tessellate"];
const CHANGE_FIELDS = new Set([...CONTROL_FIELDS, "pointAltitude"]);
const MAXIMUM_POINT_ALTITUDE = 10_000_000;

/** Summarize source geometry settings without treating a missing Z as zero. */
export function summarizeKmlGeometrySettings(place) {
  const leaves = geometryLeaves(place?.geometry);
  const edges = leaves.filter(isEdge);
  const settings = leaves.map((geometry) => effectiveControls(geometry, place));
  const result = {
    leafCount: leaves.length,
    edgeCount: edges.length,
    altitudeMode: summarize(settings.map((controls) => controls.altitudeMode), null),
    extrude: summarize(settings.map((controls) => controls.extrude), false),
    tessellate: summarize(edges.map((geometry) => effectiveControls(geometry, place).tessellate), false)
  };
  if (place?.geometry?.type === "Point") {
    result.pointAltitude = place.geometry.coordinates.length > 2 ? place.geometry.coordinates[2] : null;
  }
  return result;
}

/**
 * Return a Placemark patch. Only own properties in changes are applied; omitted
 * mixed fields and Point tessellation retain their original effective values.
 */
export function applyKmlGeometrySettings(place, changes) {
  validateChanges(changes);
  if (!place || typeof place !== "object" || Array.isArray(place)) throw settingsError();

  const leaves = geometryLeaves(place.geometry);
  const changedControls = CONTROL_FIELDS.filter((field) => Object.hasOwn(changes, field));
  if (changedControls.length && !leaves.length) throw settingsError();
  if (Object.hasOwn(changes, "tessellate") && !leaves.some(isEdge)) throw settingsError();
  if (Object.hasOwn(changes, "pointAltitude") && place.geometry?.type !== "Point") {
    throw settingsError("kml_point_altitude_invalid");
  }

  const patch = {
    geometry: structuredClone(place.geometry),
    altitudeMode: place.altitudeMode,
    extrude: place.extrude,
    tessellate: place.tessellate
  };
  const clonedLeaves = geometryLeaves(patch.geometry);
  const planned = leaves.map((geometry) => {
    const original = effectiveControls(geometry, place);
    const controls = {...original};
    for (const field of changedControls) {
      if (field !== "tessellate" || isEdge(geometry)) controls[field] = changes[field];
    }
    return {original, controls};
  });

  // Keep unchanged defaults verbatim. A changed default follows the first leaf,
  // matching the Placemark compatibility representation used by KML import.
  for (const field of changedControls) {
    if (planned.some(({original, controls}) => original[field] !== controls[field])) {
      patch[field] = planned[0].controls[field];
    }
  }
  const defaults = effectiveControls({}, patch);
  for (let index = 0; index < clonedLeaves.length; index += 1) {
    const geometry = clonedLeaves[index];
    const {original, controls} = planned[index];
    if (Object.hasOwn(geometry, "kmlControls")) {
      if (!sameControls(original, controls)) geometry.kmlControls = {...geometry.kmlControls, ...controls};
    } else if (!sameControls(controls, defaults)) {
      geometry.kmlControls = controls;
    }
  }

  if (Object.hasOwn(changes, "pointAltitude")) {
    const [longitude, latitude] = patch.geometry.coordinates;
    patch.geometry.coordinates = changes.pointAltitude === null
      ? [longitude, latitude]
      : [longitude, latitude, changes.pointAltitude];
  }
  return patch;
}

function geometryLeaves(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  if (["Point", "LineString", "Polygon"].includes(geometry.type)) return [geometry];
  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return geometry.geometries.flatMap(geometryLeaves);
  }
  return [];
}

function isEdge(geometry) {
  return geometry.type === "LineString" || geometry.type === "Polygon";
}

function effectiveControls(geometry, place) {
  const controls = geometry.kmlControls ?? place;
  return {
    altitudeMode: controls?.altitudeMode ?? null,
    extrude: controls?.extrude === true,
    tessellate: controls?.tessellate === true
  };
}

function sameControls(left, right) {
  return CONTROL_FIELDS.every((field) => left[field] === right[field]);
}

function summarize(values, emptyValue) {
  return values.length ? (values.every((value) => value === values[0]) ? values[0] : "mixed") : emptyValue;
}

function validateChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)
    || Reflect.ownKeys(changes).some((field) => !CHANGE_FIELDS.has(field))) throw settingsError();
  if (Object.hasOwn(changes, "altitudeMode") && !ALTITUDE_MODES.has(changes.altitudeMode)) throw settingsError();
  for (const field of ["extrude", "tessellate"]) {
    if (Object.hasOwn(changes, field) && typeof changes[field] !== "boolean") throw settingsError();
  }
  if (Object.hasOwn(changes, "pointAltitude") && changes.pointAltitude !== null
    && (typeof changes.pointAltitude !== "number" || !Number.isFinite(changes.pointAltitude)
      || Math.abs(changes.pointAltitude) > MAXIMUM_POINT_ALTITUDE)) {
    throw settingsError("kml_point_altitude_invalid");
  }
}

function settingsError(code = "kml_geometry_settings_invalid") {
  return Object.assign(new Error(code), {code});
}
