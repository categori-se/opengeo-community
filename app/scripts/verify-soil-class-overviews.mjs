// Bind all pixel-class coverage receipts to the final packed PMTiles bytes.
import assert from 'node:assert/strict';
import {open, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {PMTiles} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {capturedSha256} from './stream-captured-features.mjs';

const out = resolve('../.local-archives/bhutan-local-20260920',process.argv.includes('--grouped-overviews')?'soil-display-maplibre-grouped-overviews':'soil-display-maplibre-class-overviews');
const target = resolve(out, 'aggregate-overview-verification.json');
assert.ok(!existsSync(target));
const build = JSON.parse(await readFile(resolve(out, 'overview-build.json')));
const review = JSON.parse(await readFile(resolve(out, 'receipt.json')));
assert.equal(build.status, 'built-awaiting-packed-and-selector-review');
assert.equal(build.aggregatedTiles, 241);
if (build.outputSha256) assert.equal(build.outputSha256, review.outputSha256);
assert.equal(await capturedSha256(resolve(out, 'display.pmtiles')), review.outputSha256);
const file = await open(resolve(out, 'display.pmtiles'), 'r');
const size = (await file.stat()).size;
const result = {status: 'checking', outputSha256: review.outputSha256, tiles: 0,
  aggregateRegions: 0, pixelClassificationMismatches: 0, networkRequests: 0,
  scope: 'All 241 packed overview tiles equal their independently raster-roundtripped class tiles. Aggregate regions retain class and explicit representation only, never captured IDs or original area attributes. Screen-resolution classification is not analytical source geometry.'};
try {
  const archive = new PMTiles({getKey: () => 'soil-class-overviews', getBytes: async (offset, length) => {
    assert.ok(offset >= 0 && offset < size && length > 0 && length <= 16 * 1024 ** 2);
    const buffer = new Uint8Array(Math.min(length, size - offset));
    const {bytesRead} = await file.read(buffer, 0, buffer.length, offset);
    assert.equal(bytesRead, buffer.length); return {data: buffer.buffer};
  }});
  const metadata = await archive.getMetadata();
  assert.deepEqual(metadata.opengeo_overview_aggregation, review.overviewDisplayRecipe);
  assert.deepEqual(metadata.vector_layers.map(l => l.id), ['data']);
  const seen = new Set();
  for (const tile of build.tiles) {
    assert.ok(tile.z >= 7 && tile.z <= 11);
    const key = `${tile.z}-${tile.x}-${tile.y}`; assert.ok(!seen.has(key)); seen.add(key);
    const original = await readFile(resolve(out, 'overview-tiles', key + '.mvt.gz'));
    assert.equal(createHash('sha256').update(original).digest('hex'), tile.sha256);
    assert.equal(tile.roundtripMismatchPixels, 0);
    const packed = await archive.getZxy(tile.z, tile.x, tile.y); assert.ok(packed);
    assert.ok(Buffer.from(packed.data).equals(gunzipSync(original)));
    const layer = new VectorTile(new Pbf(new Uint8Array(packed.data))).layers.data;
    assert.equal(layer.length, tile.features);
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      assert.equal(feature.type, 3); assert.equal(feature.id, undefined);
      assert.deepEqual(Object.keys(feature.properties).sort(), ['gridcode', 'representation']);
      assert.equal(feature.properties.representation, 'Aggregated soil-class overview');
      assert.ok(Number.isSafeInteger(feature.properties.gridcode));
      if(review.overviewDisplayRecipe.featureGrouping){
        const geometry=feature.loadGeometry();
        assert.ok(geometry.length<=400 && geometry.reduce((n,r)=>n+r.length,0)<=16384);
      }
    }
    result.tiles++; result.aggregateRegions += layer.length;
  }
  assert.equal(result.tiles, 241); result.status = 'passed';
} catch (error) {result.status = 'failed'; result.error = String(error); throw error;}
finally {await file.close(); await writeFile(target, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));}
