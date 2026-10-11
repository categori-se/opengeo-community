// This optional derivative metadata is covered by the same verified PMTiles bytes.
// Legacy archives keep their single, descriptor-reviewed zoom range.
export function reviewedArchiveLayerRanges(record, metadata) {
  const names = record.tile_layers.map(layer => layer.source_layer);
  const declared = metadata.opengeo_layer_zoom_ranges;
  if (declared === undefined) {
    return names.map(sourceLayer => ({sourceLayer, minZoom: record.min_zoom, maxZoom: record.max_zoom}));
  }
  if (!declared || declared.version !== 1 || !Array.isArray(declared.layers)
    || declared.layers.length !== names.length
    || new Set(declared.layers.map(layer => layer?.source_layer)).size !== names.length) {
    throw Error("Invalid archive layer detail ranges.");
  }
  return names.map(sourceLayer => {
    const range = declared.layers.find(layer => layer?.source_layer === sourceLayer);
    if (!range || !Number.isInteger(range.min_zoom) || !Number.isInteger(range.max_zoom)
      || range.min_zoom < record.min_zoom || range.max_zoom > record.max_zoom
      || range.min_zoom > range.max_zoom) throw Error("Invalid archive layer detail range.");
    return {sourceLayer, minZoom: range.min_zoom, maxZoom: range.max_zoom};
  });
}
