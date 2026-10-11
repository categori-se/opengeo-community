// Resolve only reviewed catalog identities. Saved source URLs never become fetch targets.
export async function restoreBrowserCatalogLayers({layers, catalog, dataByLayerId, isCurrent, onData, onStatus}) {
  const entries = new Map(catalog.map(entry => [entry.id, entry]));
  const pending = new Map();
  const results = [];
  for (const layer of [...layers]) {
    if (!layer.browserCatalogId || dataByLayerId.has(layer.layerId)) continue;
    const entry = entries.get(layer.browserCatalogId);
    if (!entry) {
      onStatus(`The catalog source for ${layer.title} is unavailable. Your saved Layer is retained.`);
      results.push({layerId: layer.layerId, status: "unavailable"});
      continue;
    }
    if (!isCurrent(layer)) continue;
    onStatus(`Loading saved Layer: ${layer.title}…`);
    try {
      if (!pending.has(entry.id)) pending.set(entry.id, Promise.resolve().then(() => entry.load()));
      const candidate = await pending.get(entry.id);
      if (!isCurrent(layer)) continue;
      if (candidate.layer.datasetId !== layer.datasetId || candidate.layer.sourceType !== layer.sourceType
        || candidate.geojson?.type !== "FeatureCollection" || !Array.isArray(candidate.geojson.features)) {
        throw new Error("Catalog identity or data no longer matches");
      }
      dataByLayerId.set(layer.layerId, candidate.geojson);
      onData(layer, candidate.geojson);
      onStatus(`Restored ${layer.title} from its catalog source.`);
      results.push({layerId: layer.layerId, status: "restored"});
    } catch {
      if (!isCurrent(layer)) continue;
      onStatus(`Could not restore ${layer.title}. Reload to retry; your saved Layer and metadata are retained.`);
      results.push({layerId: layer.layerId, status: "failed"});
    }
  }
  return results;
}
