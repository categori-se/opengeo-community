import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {decompressReviewedTile, reviewedArchiveTileResponse} from '../src/lib/reviewedArchiveTiles.js';

test('only supported compression and bounded decoded tiles reach the renderer', async () => {
  const bytes = Buffer.from('reviewed tile');
  assert.deepEqual(Buffer.from(await decompressReviewedTile(gzipSync(bytes), 2)), bytes);
  assert.equal(await decompressReviewedTile(bytes.buffer, 1), bytes.buffer);
  await assert.rejects(decompressReviewedTile(bytes, 0), /Unsupported/);
  await assert.rejects(decompressReviewedTile(new Uint8Array(16*1024**2+1), 1), /too large/);
  await assert.rejects(decompressReviewedTile(gzipSync(Buffer.alloc(16*1024**2+1)), 2), /too large/);
});

test('unknown or closed opaque archive sessions have no network fallback', async () => {
  await assert.rejects(reviewedArchiveTileResponse({url:'reviewed-archive://absent/7/95/53'}, new AbortController()), /closed/);
});
