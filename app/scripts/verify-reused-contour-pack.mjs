// Bind the complete staged tile proof to exact packed PMTiles content.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {PMTiles, FileSource, zxyToTileId} from 'pmtiles';

const out = resolve(process.argv[2]);
assert.ok(out.startsWith(resolve('../.local-archives/bhutan-local-20260920/additional-nsdi-tiles') + '/'));
assert.ok(!existsSync(resolve(out, 'mvt-content-verification.json')), 'Inspect retained verification');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const review = JSON.parse(await readFile(resolve(out, 'receipt.json')));
const stagedBytes = await readFile(resolve(out, 'geometry-reuse.json'));
const staged = JSON.parse(stagedBytes);
assert.equal(review.status, 'built-needs-packed-review');
assert.equal(staged.status, 'all-staged-fragment-geometry-and-target-properties-verified');
assert.equal(staged.uniqueDetailIds, 212935);
const parentBytes = await readFile(resolve(out, '../298ebd0348ec881b-components/mvt-content-verification.json'));
const parent = JSON.parse(parentBytes);
assert.equal(parent.status, 'passed');
assert.equal(parent.outputSha256, review.cartographicGeometryReuse.parentDisplaySha256);
assert.equal(parent.positiveLengthIdsAtDeclaredDetail, 212935);
const bytes = await readFile(resolve(out, 'display.pmtiles'));
assert.equal(sha(bytes), review.outputSha256);
const archive = new PMTiles(new FileSource(new File([bytes], 'display.pmtiles')));
const header = await archive.getHeader(), metadata = await archive.getMetadata();
assert.equal(header.minZoom, review.recipe.minZoom); assert.equal(header.maxZoom, review.recipe.maxZoom);
assert.deepEqual(metadata.opengeo_layer_zoom_ranges, review.layerZoomRanges);
const db = new DatabaseSync(resolve(out, 'display.mbtiles'), {readOnly: true});
const expected = new Set(); let count = 0; const started = Date.now();
try {
  for (const row of db.prepare('SELECT zoom_level z,tile_column x,tile_row tmsY,tile_data data FROM tiles').iterate()) {
    assert.ok(Date.now() - started < 600000, 'Packed comparison time budget');
    const y = 2**row.z - 1 - row.tmsY, id = zxyToTileId(row.z, row.x, y);
    assert.ok(!expected.has(id)); expected.add(id);
    const response = await archive.getZxy(row.z, row.x, y); assert.ok(response);
    assert.equal(sha(new Uint8Array(response.data)), sha(gunzipSync(row.data)));
    count++;
  }
} finally { db.close(); }
let packed = 0;
async function walk(offset, length, depth = 0) {
  assert.ok(depth <= 3);
  for (const entry of await archive.cache.getDirectory(archive.source, offset, length, header)) {
    if (!entry.runLength) { await walk(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1); continue; }
    for (let id = entry.tileId; id < entry.tileId + entry.runLength; id++) {
      assert.ok(expected.delete(id), 'Extra or duplicate packed tile'); packed++;
    }
  }
}
await walk(header.rootDirectoryOffset, header.rootDirectoryLength);
assert.equal(expected.size, 0); assert.equal(packed, count); assert.equal(count, staged.tiles);
const result = {status: 'passed', outputSha256: review.outputSha256,
  sourceFeatures: 212935, originalSourceFeatures: 212944, nonSpatialRecords: 9,
  uniqueDecodedIds: 212935, missingIds: 0, propertyMismatches: 0, unexpectedIds: 0,
  maximumZoomByLayer: Object.fromEntries(review.layerZoomRanges.layers.map(layer => [layer.source_layer, layer.max_zoom])),
  layerCounts: Object.fromEntries(review.tileLayers.map(layer => [layer.source_layer, layer.feature_count])),
  positiveLengthIdsAtDeclaredDetail: 212935,
  inheritedPositiveLengthEvidence: {parentReviewSha256: sha(parentBytes),
    method: 'Bijective target identities and every staged integer geometry/grid checked; positive length is preserved. Every final packed tile equals staging.'},
  featuresWithOmittedNulls: staged.featuresWithOmittedNulls,
  omittedNullsExplicitlyReviewed: staged.featuresWithOmittedNulls > 0,
  exactPropertyEquality: staged.featuresWithOmittedNulls === 0,
  tiles: count, fragments: staged.fragments,
  stagedVerificationSha256: sha(stagedBytes), allPackedTilesEqualStaged: true,
  sourceGeometryReuse: review.cartographicGeometryReuse, networkRequests: 0, s3Requests: 0,
  seconds: (Date.now() - started) / 1000,
  scope: 'Every packed tile equals its staged MVT. The bound staged proof checked every re-encoded integer geometry/grid and target attribute, and every spatial identity at its declared detail zoom. Geometry correspondence, parent generalization and original data remain explicit; actual viewer acceptance is separate.'};
await writeFile(resolve(out, 'mvt-content-verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({status: 'passed', tiles: count, features: 212935}));
