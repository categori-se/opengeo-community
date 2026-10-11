/** Install already-loaded governed data without starting any reads or jobs. */
export function installLoadedMapLayers({getMap, layers, dataByLayerId, layerHandles, install, syncOrder}) {
  const map = getMap();
  if (!map?.isStyleLoaded?.()) return 0;
  let installed = 0;
  // Project order is top-first; draw bottom-first and synchronize again after
  // each readiness pass because an earlier source may still be parsing.
  for (const layer of [...layers].reverse()) {
    if (getMap() !== map || !map.isStyleLoaded()) break;
    if (!layers.includes(layer) || !["governed-dataset", "geojson-archive"].includes(layer.sourceType)
      || !dataByLayerId.has(layer.layerId) || layerHandles.has(layer.layerId)) continue;
    install(layer, dataByLayerId.get(layer.layerId));
    installed++;
  }
  if (installed && getMap() === map) syncOrder();
  return installed;
}

export function persistedLayerSourceIdentity(layer) {
  return JSON.stringify([layer.sourceType, layer.datasetId, layer.datasetVersionId ?? null,
    layer.sourceVersion ?? null, layer.sourceUrl ?? null, layer.sourceConfiguration ?? null]);
}

export function isCurrentPersistedLayer(context, layer, identity) {
  return !context.disposed && !context.layerArchiveModes?.has(layer.layerId) && context.layers.includes(layer)
    && persistedLayerSourceIdentity(layer) === identity;
}
