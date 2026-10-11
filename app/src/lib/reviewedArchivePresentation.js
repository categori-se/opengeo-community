// Aggregate region edges are display partitions, not captured polygon boundaries.
import {canonicalJson} from './artifactCanonicalJson.js';
export function reviewedArchiveOverview(record, metadata) {
  const recipe = metadata.opengeo_overview_aggregation;
  if (recipe === undefined) return null;
  const reviewed = record.provenance?.overviewDisplayRecipe;
  if (!reviewed || canonicalJson(recipe) !== canonicalJson(reviewed)
    || recipe.pixelSize !== 512 || recipe.blockSize !== 32
    || JSON.stringify(recipe.zooms) !== '[7,8,9,10,11]'
    || recipe.sourceLayer !== 'data'
    || !record.tile_layers.some(layer => layer.source_layer === recipe.sourceLayer
      && ['Polygon', 'MultiPolygon'].includes(layer.geometry_type))
    || record.min_zoom > 7 || record.max_zoom < 12) {
    throw Error('Archive overview presentation differs from its review.');
  }
  return {sourceLayer: recipe.sourceLayer, minZoom: 7, maxZoom: 11};
}

export function archivePaintLayers(layers, overview, sourceLayer) {
  if (!overview || overview.sourceLayer !== sourceLayer || !layers.some(layer => layer.type === 'fill')) return layers;
  const aggregate = ['==', ['get', 'representation'], 'Aggregated soil-class overview'];
  const individual = ['!', aggregate];
  const filter = (existing, condition) => existing ? ['all', existing, condition] : condition;
  return layers.flatMap(layer => {
    if (layer.type === 'fill') return [
      {...layer, filter: filter(layer.filter, individual)},
      {...layer, id: layer.id + '-aggregate',
        minzoom: Math.max(layer.minzoom ?? 0, overview.minZoom),
        maxzoom: Math.min(layer.maxzoom ?? 24, overview.maxZoom + 1),
        filter: filter(layer.filter, aggregate),
        paint: {...layer.paint, 'fill-antialias': false}}
    ];
    if (layer.type === 'line') return [{...layer, filter: filter(layer.filter, individual)}];
    return [layer];
  });
}
