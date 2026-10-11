import assert from 'node:assert/strict';
import test from 'node:test';
import {fitOverviewTile} from './overview-tile-budget.mjs';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {gzipSync,gunzipSync} from 'node:zlib';

const square = size => [[{x: 0, y: 0}, {x: size, y: 0}, {x: size, y: size}, {x: 0, y: size}, {x: 0, y: 0}]];
const features = [2, 8, 1, 4].map((size, id) => ({id, properties: {year: 1990 + id * 10}, loadGeometry: () => square(size)}));
const options = {zoom: 4, fullDetailZoom: 14, maximumFeatures: 3, maximumBytes: 20, encode: rows => Buffer.alloc(rows.length * 10)};

test('overviews fit both budgets, retain larger polygons and preserve original objects/draw order', () => {
  const result = fitOverviewTile(features, options);
  assert.deepEqual(result.features.map(f => f.id), [1, 3]);
  assert.equal(result.features[0], features[1]);
  assert.equal(result.features[1], features[3]);
  assert.equal(result.omitted, 2);
  assert.equal(result.bytes.length, 20);
  assert.equal(features.length, 4);
});

test('full detail refuses either budget breach instead of dropping data', () => {
  assert.throws(() => fitOverviewTile(features, {...options, zoom: 14}), /Full-detail feature/);
  assert.throws(() => fitOverviewTile(features, {...options, zoom: 14, maximumFeatures: 4}), /Full-detail byte/);
});

test('within-budget tiles retain every feature unchanged, including full detail', () => {
  const result = fitOverviewTile(features, {...options, zoom: 14, maximumFeatures: 4, maximumBytes: 40});
  assert.equal(result.features, features);
  assert.equal(result.omitted, 0);
});

test('highly compressible tiles must also fit the reader decoded limit; full detail is never thinned', () => {
  const budget={...options,maximumFeatures:4,maximumBytes:1000,maximumDecodedBytes:200,
    encode:rows=>gzipSync(Buffer.alloc(rows.length*100)),decodedSize:bytes=>gunzipSync(bytes).length};
  assert.ok(budget.encode(features).length<budget.maximumBytes);
  const result=fitOverviewTile(features,budget);
  assert.deepEqual(result.features.map(f=>f.id),[1,3]);
  assert.equal(gunzipSync(result.bytes).length,200);
  assert.throws(()=>fitOverviewTile(features,{...budget,zoom:14}),/Full-detail byte/);
});

test('polygon holes count against visible area', () => {
  const holed = {id: 9, loadGeometry: () => [...square(10), ...square(9).map(r => r.toReversed())]};
  const solid = {id: 10, loadGeometry: () => square(5)};
  const result = fitOverviewTile([holed, solid], {...options, maximumFeatures: 1});
  assert.equal(result.features[0], solid);
});

test('decoding a nonzero-offset tile buffer preserves floating-point attributes', () => {
  const feature={id:5,type:3,properties:{Area_SqKm:0.301,Latitude:34.614},loadGeometry:()=>square(5)};
  const encoded=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:1,feature:()=>feature}}});
  const pooled=Buffer.alloc(encoded.length+16,123);pooled.set(encoded,16);
  const view=pooled.subarray(16);
  assert.ok(view.byteOffset>0);
  const actual=new VectorTile(new Pbf(new Uint8Array(view))).layers.data.feature(0);
  assert.deepEqual({...actual.properties},feature.properties);
});
