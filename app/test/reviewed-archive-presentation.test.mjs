import assert from 'node:assert/strict';
import {featureFilter, validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {archivePaintLayers, reviewedArchiveOverview} from '../src/lib/reviewedArchivePresentation.js';

const recipe = {pixelSize: 512, blockSize: 32, zooms: [7,8,9,10,11], sourceLayer: 'data'};
const record = {min_zoom: 7, max_zoom: 14,
  tile_layers: [{source_layer: 'data', geometry_type: 'MultiPolygon'}],
  provenance: {overviewDisplayRecipe: {...recipe}}};
const metadata = {opengeo_overview_aggregation: Object.fromEntries(Object.entries(recipe).reverse())};
const overview = reviewedArchiveOverview(record, metadata);
assert.equal(overview.sourceLayer, 'data');
assert.equal(reviewedArchiveOverview(record, {}), null);
assert.throws(() => reviewedArchiveOverview({...record, provenance: {}}, metadata));
assert.throws(() => reviewedArchiveOverview(record, {opengeo_overview_aggregation: {...recipe, pixelSize: 256}}));

const paints = [{id: 'fill', type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'],
  paint: {'fill-color': '#22c55e', 'fill-opacity': 0.45}},
  {id: 'outline', type: 'line', paint: {'line-color': '#15803d', 'line-width': 2}}];
const before = structuredClone(paints);
const result = archivePaintLayers(paints, overview, 'data');
assert.deepEqual(paints, before, 'Source presentation must not be mutated or persisted');
assert.equal(result.length, 3);
assert.deepEqual(validateStyleMin({version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://fixture.invalid/{z}/{x}/{y}.mvt']}},
  layers: result.map(layer => ({...layer, source: 'tiles', 'source-layer': 'data'}))}), []);
const original = {type: 3, properties: {fid: 7, gridcode: 2}};
const aggregate = {type: 3, properties: {gridcode: 2, representation: 'Aggregated soil-class overview'}};
const visible = (layer, feature, zoom) => (layer.minzoom ?? 0) <= zoom && zoom < (layer.maxzoom ?? 24)
  && featureFilter(layer.filter).filter({zoom}, feature);
assert.deepEqual(result.filter(l => visible(l, aggregate, 7)).map(l => l.id), ['fill-aggregate']);
assert.deepEqual(result.filter(l => visible(l, original, 14)).map(l => l.id), ['fill', 'outline']);
assert.equal(result.find(l => l.id === 'fill-aggregate').paint['fill-antialias'], false);
assert.equal(result.filter(l => visible(l, aggregate, 12)).length, 0);
assert.equal(archivePaintLayers(paints, null, 'data'), paints);
assert.equal(archivePaintLayers(paints, overview, 'other'), paints);
assert.equal(archivePaintLayers([paints[1]], overview, 'data')[0], paints[1], 'Explicit outline-only styles remain deliberate user choices');
console.log('Reviewed archive aggregate presentation passed');
