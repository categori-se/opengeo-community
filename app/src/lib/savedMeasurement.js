import {
  circlePolygonCoordinates,
  createCircleMeasurement,
  normalizeAreaMeasurement
} from "./areaMeasurement.js";
import {
  measurementGeojson as pathMeasurementGeojson,
  normalizePathMeasurements,
  PATH_MEASUREMENT_LIMITS
} from "./pathMeasurement.js";

export function normalizeSavedMeasurements(value, options = {}) {
  if (!Array.isArray(value) || value.length > PATH_MEASUREMENT_LIMITS.maximumMeasurements) return [];
  try {
    return value.map((measurement) => {
      if (measurement?.kind === "path-profile") {
        const normalized = normalizePathMeasurements([measurement], options);
        if (normalized.length !== 1) throw new Error("path_measurement_invalid");
        return normalized[0];
      }
      return normalizeAreaMeasurement(measurement, options);
    });
  } catch {
    return [];
  }
}

export function savedMeasurementGeojson(measurements, draftCoordinates = [], draftKind = "path", spatialBody) {
  const pathMeasurements = (measurements ?? []).filter(({kind}) => kind === "path-profile");
  const draftPath = ["path", "line"].includes(draftKind) ? draftCoordinates : [];
  const features = pathMeasurementGeojson(pathMeasurements, draftPath).features;
  for (const measurement of measurements ?? []) {
    if (measurement.kind === "polygon-area") {
      features.push(areaFeature(measurement, [...measurement.coordinates, measurement.coordinates[0]], "saved"));
    } else if (measurement.kind === "circle-area") {
      features.push(areaFeature(measurement, circlePolygonCoordinates(measurement), "saved"));
    }
  }
  for (const [index, coordinate] of (draftCoordinates ?? []).entries()) {
    if (!["polygon", "circle"].includes(draftKind)) continue;
    features.push({
      type: "Feature",
      properties: {kind: "draft-point", vertex: index + 1},
      geometry: {type: "Point", coordinates: coordinate}
    });
  }
  if (draftKind === "polygon" && draftCoordinates.length >= 3) {
    features.push(areaFeature(null, [...draftCoordinates, draftCoordinates[0]], "draft"));
  } else if (draftKind === "polygon" && draftCoordinates.length >= 2) {
    features.push({
      type: "Feature",
      properties: {kind: "draft"},
      geometry: {type: "LineString", coordinates: draftCoordinates}
    });
  }
  if (draftKind === "circle" && draftCoordinates.length === 2) {
    try {
      const draft = createCircleMeasurement({
        id: "draft-circle",
        title: "Draft circle",
        center: draftCoordinates[0],
        radiusPoint: draftCoordinates[1],
        spatialBody
      });
      features.push(areaFeature(null, circlePolygonCoordinates(draft), "draft"));
    } catch {
      // A coincident or otherwise invalid edge remains represented by its
      // vertex handles until the user moves or undoes it.
    }
  }
  return {type: "FeatureCollection", features};
}

function areaFeature(measurement, ring, kind) {
  return {
    type: "Feature",
    id: measurement?.id,
    properties: {
      kind,
      measurementId: measurement?.id ?? null,
      title: measurement?.title ?? "Draft area"
    },
    geometry: {type: "Polygon", coordinates: [ring]}
  };
}
