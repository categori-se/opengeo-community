import {FEATURE_QUERY_LIMITS} from "./featureQuery.js";

export const GOVERNED_IDENTIFY_LIMITS = Object.freeze({
  maximumLayers: 16,
  maximumResultsPerLayer: 10,
  defaultBufferMeters: 25
});

/**
 * Run one reproducible point query against each visible governed dataset.
 * Presentation layers that reference the same dataset are queried once so a
 * map cannot multiply server work by duplicating a layer.
 */
export async function identifyVisibleGovernedLayers({
  layers,
  longitude,
  latitude,
  queryDatasetFeatures,
  bufferMeters = GOVERNED_IDENTIFY_LIMITS.defaultBufferMeters,
  signal
}) {
  if (!Array.isArray(layers)) throw new TypeError("identify layers must be an array");
  if (typeof queryDatasetFeatures !== "function") {
    throw new TypeError("identify requires a governed query function");
  }
  const location = normalizeLocation(longitude, latitude);
  if (!Number.isFinite(bufferMeters)
    || bufferMeters < 0
    || bufferMeters > FEATURE_QUERY_LIMITS.maximumBufferMeters) {
    throw new TypeError("identify buffer is invalid");
  }

  const candidates = visibleQueryableLayers(layers);
  const selected = candidates.slice(0, GOVERNED_IDENTIFY_LIMITS.maximumLayers);
  const outcomes = await Promise.all(selected.map(async (layer) => {
    const expectedGeneration = Number.isSafeInteger(layer.featureGeneration)
      && layer.featureGeneration > 0
      ? layer.featureGeneration
      : null;
    const query = {
      steps: [{
        kind: "spatial",
        relation: "intersects",
        geometry: {type: "Point", coordinates: location},
        bufferMeters
      }],
      expectedGeneration,
      limit: GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer,
      offset: 0
    };
    try {
      const result = await queryDatasetFeatures(layer.datasetId, query, {signal});
      return {
        status: "ready",
        layerId: layer.layerId,
        datasetId: layer.datasetId,
        title: layer.title,
        result
      };
    } catch (error) {
      return {
        status: "unavailable",
        layerId: layer.layerId,
        datasetId: layer.datasetId,
        title: layer.title,
        errorCode: boundedErrorCode(error?.code)
      };
    }
  }));

  return {
    location,
    bufferMeters,
    queriedLayerCount: selected.length,
    omittedLayerCount: Math.max(0, candidates.length - selected.length),
    layers: outcomes
  };
}

export function visibleQueryableLayers(layers) {
  const seenDatasets = new Set();
  const result = [];
  for (const layer of layers) {
    if (!isGovernedDatasetLayer(layer)
      || layer.visible === false
      || typeof layer.datasetId !== "string"
      || !layer.datasetId
      || seenDatasets.has(layer.datasetId)) continue;
    seenDatasets.add(layer.datasetId);
    result.push(layer);
  }
  return result;
}

export function isGovernedDatasetLayer(layer) {
  return Boolean(layer && layer.sourceType === "governed-dataset" && layer.datasetId);
}

export function loadedFeatureIndex(features, featureId) {
  if (!Array.isArray(features) || featureId === null || featureId === undefined) return null;
  const index = features.findIndex((feature) => String(feature?.id) === String(featureId));
  return index >= 0 ? index : null;
}

function normalizeLocation(longitude, latitude) {
  if (!Number.isFinite(longitude)
    || !Number.isFinite(latitude)
    || longitude < -180
    || longitude > 180
    || latitude < -90
    || latitude > 90) {
    throw new TypeError("identify location must use WGS84 coordinates");
  }
  return [longitude, latitude];
}

function boundedErrorCode(value) {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value)
    ? value
    : "query_unavailable";
}
