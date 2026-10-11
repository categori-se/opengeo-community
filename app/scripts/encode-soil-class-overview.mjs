// Encode a declared aggregate overview, never individual captured feature records.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import Pbf from 'pbf';

const [input, output] = process.argv.slice(2);
assert.ok(input && output);
const value = JSON.parse(await readFile(input, 'utf8'));
assert.equal(value.kind, 'soil-class-pixel-overview');
assert.ok(value.z >= 7 && value.z <= 11);
const sourceLayer = value.sourceLayer ?? 'overview';
assert.ok(['overview', 'data'].includes(sourceLayer));
const features = value.features.map(feature => {
  assert.equal(feature.type, 3);
  assert.deepEqual(Object.keys(feature.tags).sort(), ['gridcode', 'representation']);
  assert.equal(feature.tags.representation, 'Aggregated soil-class overview');
  assert.ok(Number.isSafeInteger(feature.tags.gridcode));
  return feature;
});
const decoded = fromGeojsonVt({[sourceLayer]: {features}}, {extent: 8192, version: 2});
const checked = new VectorTile(new Pbf(new Uint8Array(decoded))).layers[sourceLayer];
assert.equal(checked.length, features.length);
let vertices = 0, rings = 0;
for (let i = 0; i < checked.length; i++) {
  const f = checked.feature(i), geometry = f.loadGeometry();
  assert.deepEqual({...f.properties}, features[i].tags);
  assert.equal(f.id, undefined, 'Aggregate must not impersonate a captured feature ID');
  const count = limit => classifyRings(geometry, limit).reduce((n, p) => n + p.length, 0);
  assert.equal(count(0), count(500));
  vertices += geometry.reduce((n, r) => n + r.length, 0);
  rings += geometry.length;
}
const bytes = gzipSync(decoded);
assert.ok(decoded.length <= 16 * 1024 ** 2 && bytes.length <= 8 * 1024 ** 2);
await writeFile(output, bytes, {flag: 'wx'});
console.log(JSON.stringify({features: features.length, vertices, rings,
  decodedBytes: decoded.length, compressedBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex')}));
