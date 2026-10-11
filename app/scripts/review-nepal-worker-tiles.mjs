// Diagnose retained automatic tiles; do not admit an incomplete map display.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {PMTiles, FileSource, tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const root = resolve('..');
const out = resolve(root, '.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-small-20260922');
const plan = JSON.parse(await readFile(resolve(out, 'display-plan.json')));
const inspections = JSON.parse(await readFile(resolve(out, 'inspection/inspection.json')));
const results = [];
const started = Date.now();
for (const item of plan.records) {
  assert.ok(Date.now()-started < 120000);
  const sourceBytes = await readFile(resolve(root, item.path));
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), item.sha256);
  const features = JSON.parse(sourceBytes).features;
  const sourceIds = new Set(features.map((f) => String(f.properties.osm_id)));
  assert.ok(features.every((f) => f.properties.osm_id !== undefined));
  const artifact = inspections.records.find((r) => r.layer === item.layer).inspection.artifacts.find((a) => a.role === 'tile');
  const bytes = await readFile(resolve(out, 'inspection', item.layer, basename(artifact.path)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  const archive = new PMTiles(new FileSource(new File([bytes], 'tiles.pmtiles')));
  const header = await archive.getHeader();
  const seen = new Set();
  let tileCount = 0, fragments = 0, fragmentsWithNativeId = 0;
  const offsets = new Set();
  async function walk(offset, length, depth = 0) {
    assert.ok(depth <= 3 && Date.now()-started < 120000);
    const entries = await archive.cache.getDirectory(archive.source, offset, length, header);
    for (const entry of entries) {
      if (!entry.runLength) { await walk(header.leafDirectoryOffset+entry.offset, entry.length, depth+1); continue; }
      for (let id = entry.tileId; id < entry.tileId+entry.runLength; id++) {
        const [z, x, y] = tileIdToZxy(id);
        if (z !== header.maxZoom || offsets.has(entry.offset)) continue;
        offsets.add(entry.offset);
        const result = await archive.getZxy(z, x, y);
        const tile = new VectorTile(new Pbf(new Uint8Array(result.data)));
        tileCount++;
        for (const layer of Object.values(tile.layers)) {
          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            fragments++; fragmentsWithNativeId += Number(feature.id !== undefined);
            seen.add(String(feature.properties.osm_id));
          }
        }
      }
    }
  }
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength);
  const missing = [...sourceIds].filter((id) => !seen.has(id));
  const unknown = [...seen].filter((id) => !sourceIds.has(id));
  const row = {layer: item.layer, sourceFeatures: item.features, sourceUniqueOsmIds: sourceIds.size,
    duplicateSourceOsmIds: features.length-sourceIds.size, minZoom: header.minZoom, maxZoom: header.maxZoom,
    tileCount, fragments, fragmentsWithNativeId, seenOsmIds: seen.size,
    missingOsmIds: missing.length, missingOsmIdExamples: missing.slice(0, 12), unknownOsmIds: unknown.length,
    tileSha256: artifact.sha256, sourceSha256: item.sha256,
    completeRecordCoverageEstablished: missing.length === 0 && unknown.length === 0 && sourceIds.size === features.length};
  results.push(row);
  console.log(JSON.stringify({layer: row.layer, maxZoom: row.maxZoom, missingOsmIds: row.missingOsmIds}));
}
await writeFile(resolve(out, 'automatic-tile-review.json'), JSON.stringify({status: 'reviewed', records: results,
  scope: 'Native maximum-zoom OSM identity coverage only. No attribute, geometry-fidelity, multipart-component or browser acceptance claim.',
  networkRequests: 0, rebuiltArtifacts: 0}, null, 2)+'\n');
