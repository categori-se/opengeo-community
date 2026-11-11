/** Preserve pending/native handles; inspect installed GL content only when ready. */
export function isMapLayerHandleInstalled(map, handle, {styleWritable = false} = {}) {
  if (!handle) return false;
  if (handle.cog || (!styleWritable && map?.isStyleLoaded?.() === false)
    || typeof map?.getSource !== "function" || typeof map?.getLayer !== "function") return true;
  const sourceIds = handle.sourceIds ?? (handle.sourceId ? [handle.sourceId] : []);
  const paintLayerIds = handle.paintLayerIds ?? handle.layerIds ?? [];
  // A handle without GL identities belongs to its existing adapter/lifecycle.
  if (!sourceIds.length || !paintLayerIds.length) return true;
  return sourceIds.every(id => Boolean(map.getSource(id)))
    && paintLayerIds.every(id => Boolean(map.getLayer(id)));
}

/** Install already-loaded governed data without starting any reads or jobs. */
export function installLoadedMapLayers({getMap, layers, dataByLayerId, layerHandles, install, syncOrder,
  allowPendingSources = false}) {
  const map = getMap();
  const styleLoaded = map?.isStyleLoaded?.();
  // MapLibre can edit a serialized style while unrelated sources are loading.
  // Check its document once before reconciling the already-loaded data.
  const styleWritable = allowPendingSources && (styleLoaded || Boolean(map?.getStyle?.()));
  if (!styleLoaded && !styleWritable) return 0;
  let installed = 0;
  // Project order is top-first; draw bottom-first and synchronize again after
  // each readiness pass because an earlier source may still be parsing.
  for (const layer of [...layers].reverse()) {
    if (getMap() !== map || (!styleWritable && !map.isStyleLoaded())) break;
    if (!layers.includes(layer) || !["governed-dataset", "geojson-archive"].includes(layer.sourceType)
      || !dataByLayerId.has(layer.layerId)
      || isMapLayerHandleInstalled(map, layerHandles.get(layer.layerId), {styleWritable})) continue;
    install(layer, dataByLayerId.get(layer.layerId), {styleWritable});
    installed++;
  }
  if (installed && getMap() === map) syncOrder();
  return installed;
}

export function persistedLayerSourceIdentity(layer) {
  return JSON.stringify([layer.sourceType, layer.datasetId, layer.datasetVersionId ?? null,
    layer.sourceVersion ?? null, layer.sourceUrl ?? null, layer.sourceConfiguration ?? null, layer.managedDisplayId ?? null]);
}

export function isCurrentPersistedLayer(context, layer, identity) {
  return !context.disposed && !context.layerArchiveModes?.has(layer.layerId) && context.layers.includes(layer)
    && persistedLayerSourceIdentity(layer) === identity;
}
