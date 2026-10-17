import {FEATURE_QUERY_LIMITS} from "./featureQuery.js";
import {persistedLayerSourceIdentity} from "./loadedLayerInstallation.js";

export const GOVERNED_IDENTIFY_LIMITS = Object.freeze({
  maximumLayers: 16,
  maximumResultsPerLayer: 10,
  defaultBufferMeters: 25,
  renderedPixelTolerance: 6
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
  renderedFeaturesForLayer = null,
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
      signal?.throwIfAborted();
      // This exact response follows current dataset read authorization. Other
      // missing resources, denied reads and transport errors never expose a cache.
      if (error?.status === 404 && error?.code === "feature_collection_not_found"
        && layer.datasetVersionId && typeof renderedFeaturesForLayer === "function") {
        try {
          const features = await renderedFeaturesForLayer(layer);
          signal?.throwIfAborted();
          if (!Array.isArray(features)) throw Object.assign(Error("Displayed data unavailable"), {code: "display_preview_unavailable"});
          return {status: "ready", layerId: layer.layerId, datasetId: layer.datasetId,
            title: layer.title, result: {source: "displayed-preview", datasetVersionId: layer.datasetVersionId,
              features: features.slice(0, GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer),
              numberReturned: Math.min(features.length, GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer),
              numberMatched: null, generation: null}};
        } catch (displayError) {signal?.throwIfAborted(); error = displayError;}
      }
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
  const seenVersions = new Set();
  const result = [];
  for (const layer of layers) {
    if (!isGovernedDatasetLayer(layer)
      || layer.visible === false
      || typeof layer.datasetId !== "string"
      || !layer.datasetId) continue;
    const identity = JSON.stringify([layer.datasetId, layer.datasetVersionId ?? null]);
    if (seenVersions.has(identity)) continue;
    seenVersions.add(identity);
    result.push(layer);
  }
  return result;
}

/** Read only the exact visible managed preview's rendered hits, never basemap data. */
export function renderedManagedPreviewFeatures({map, point, layer, handle, geojson}) {
  if (!isGovernedDatasetLayer(layer) || !layer.datasetVersionId || layer.visible === false
    || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !map?.isStyleLoaded?.() || typeof map.queryRenderedFeatures !== "function"
    || !handle?.sourceId || !Array.isArray(geojson?.features)) return null;
  const layers = (handle.paintLayerIds ?? []).filter(id => {
    const painted = map.getLayer(id);
    return painted?.source === handle.sourceId && painted.layout?.visibility !== "none";
  });
  if (!layers.length) return null;
  const tolerance = GOVERNED_IDENTIFY_LIMITS.renderedPixelTolerance;
  const hits = map.queryRenderedFeatures([[point.x - tolerance, point.y - tolerance],
    [point.x + tolerance, point.y + tolerance]], {layers});
  const seen = new Set(), features = [];
  for (const hit of hits) {
    if (!layers.includes(hit.layer?.id) || hit.source !== handle.sourceId
      || hit.layer.source !== handle.sourceId || !hit.properties || !hit.geometry) continue;
    const key = hit.id == null ? JSON.stringify([hit.properties, hit.geometry]) : `${typeof hit.id}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const originals = hit.id == null ? [] : geojson.features.filter(feature => feature.id === hit.id);
    // A renderer hit is display data, not a newly invented editable collection row.
    const feature = originals.length === 1 ? originals[0] : {type: "Feature", geometry: hit.geometry,
      properties: hit.properties, ...(hit.id == null ? {} : {id: hit.id})};
    features.push(structuredClone(feature));
    if (features.length === GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer) break;
  }
  return features;
}

// Snapshot the actual click before awaiting authority. Panning cannot substitute
// another location, and changed account/source/renderer state cannot reveal it.
export function captureManagedPreviewIdentify(context, point) {
  const {state} = context, map = state.map;
  const previews = new Map(visibleQueryableLayers(context.layers).slice(0, GOVERNED_IDENTIFY_LIMITS.maximumLayers).map(layer => {
    const handle = state.layerHandles.get(layer.layerId), geojson = context.dataByLayerId.get(layer.layerId);
    const identity = persistedLayerSourceIdentity(layer);
    let features = null;
    if (!context.layerArchiveModes.has(layer.layerId)) {
      try {features = renderedManagedPreviewFeatures({map, point, layer, handle, geojson});} catch { /* Query authority still applies. */ }
    }
    return [layer, {handle, geojson, identity, features}];
  }));
  return layer => {
    const preview = previews.get(layer);
    if (context.disposed || context.queryLocationScopeInvalid || state.map !== map
      || !context.layers.includes(layer) || layer.visible === false
      || context.layerArchiveModes.has(layer.layerId)
      || preview?.identity !== persistedLayerSourceIdentity(layer)
      || preview.handle !== state.layerHandles.get(layer.layerId)
      || preview.geojson !== context.dataByLayerId.get(layer.layerId)) {
      throw Object.assign(Error("The displayed Layer changed"), {code: "display_changed"});
    }
    return preview.features;
  };
}

export function identifyUnavailableMessage(errorCode) {
  if (["action_forbidden", "dataset_read_forbidden", "authentication_required"].includes(errorCode)) {
    return "Identify access is unavailable. Check your sign-in and Layer access.";
  }
  return `Identify is unavailable for this Layer (${boundedErrorCode(errorCode)}).`;
}

export function identifyReportSummary(report) {
  const ready = report.layers.filter(({status}) => status === "ready");
  const unavailable = report.layers.length - ready.length;
  const count = ready.reduce((total, outcome) => total + (outcome.result.source === "displayed-preview"
    ? outcome.result.numberReturned : outcome.result.numberMatched), 0);
  const suffix = [report.omittedLayerCount ? `${report.omittedLayerCount} layers omitted by the fan-out limit` : null,
    unavailable ? `${unavailable} unavailable` : null].filter(Boolean).join(" · ");
  if (!ready.length && unavailable) return `Identify unavailable for ${unavailable} visible layers${report.omittedLayerCount ? ` · ${report.omittedLayerCount} omitted` : ""}.`;
  const noun = ready.some(outcome => outcome.result.source === "displayed-preview") ? "identified features" : "matches";
  return `${count} ${noun} across ${ready.length} checked visible layers${suffix ? ` · ${suffix}` : ""}.`;
}

export function isGovernedDatasetLayer(layer) {
  return Boolean(layer && layer.sourceType === "governed-dataset" && layer.datasetId);
}

export function loadedFeatureIndex(features, featureId) {
  if (!Array.isArray(features)
    || (typeof featureId !== "string" && !Number.isSafeInteger(featureId))) return null;
  let match = null;
  for (let index = 0; index < features.length; index++) {
    const feature = features[index];
    if (!feature || !Object.hasOwn(feature, "id") || feature.id !== featureId) continue;
    // A display hit may remain inspectable even when it has no unique loaded row.
    if (match !== null) return null;
    match = index;
  }
  return match;
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
