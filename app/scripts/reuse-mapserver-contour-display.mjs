// Reuse reviewed cartographic geometry while restoring this capture's own attributes.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, statfs} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles, FileSource, tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';

const run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const work = resolve('../.local-archives/bhutan-local-20260920');
const correspondenceDir = resolve(work, 'mapserver-contour-correspondence-complete');
const read = async (dir, name) => JSON.parse(await readFile(resolve(dir, name)));
const correspondenceBytes = await readFile(resolve(correspondenceDir, 'receipt.json'));
const correspondence = JSON.parse(correspondenceBytes);
const curveBytes = await readFile(resolve(correspondenceDir, 'ordered-curve-review.json'));
const curves = JSON.parse(curveBytes);
assert.equal(curves.status, 'ordered-captured-curves-within-recorded-bound');
assert.equal(curves.sourceComparisonSha256, sha(correspondenceBytes));
assert.ok(curves.maximumWebMercatorDisplacementBoundMetres < .001);
assert.equal(curves.records, 212944);
const target = correspondence.sources[1];
assert.equal(target.sourceUrl, 'https://nsdi.systems.gov.bt/server/rest/services/Map/MapServer/5');
const sourceDir = resolve(work, 'additional-nsdi-tiles/298ebd0348ec881b-components');
const parent = await read(sourceDir, 'receipt.json'), parentNative = await read(sourceDir, 'mvt-content-verification.json');
assert.equal(parent.original.sha256, correspondence.sources[0].items[0].sha256);
assert.equal(parentNative.status, 'passed');
const sourceBytes = await readFile(resolve(sourceDir, 'display.pmtiles'));
assert.equal(sha(sourceBytes), parent.outputSha256);
assert.equal(parentNative.outputSha256, parent.outputSha256);
const suffix = process.argv[2] ?? '';
assert.ok(suffix === '' || suffix === '-extent-review');
const out = resolve(work, 'additional-nsdi-tiles', sha(target.sourceUrl).slice(0, 16) + '-reused-contours' + suffix);
assert.ok(!existsSync(out), 'Inspect retained result before restarting');
const attributesBytes = await readFile(resolve(correspondenceDir, 'target-attributes.ndjson'));
assert.equal(sha(attributesBytes), correspondence.targetAttributesSha256);
const properties = new Map(), fields = {}, nonspatial = new Set(curves.nonspatialTargetIds);
let omittedNulls = 0;
for (const line of attributesBytes.toString().trimEnd().split('\n')) {
  const row = JSON.parse(line);
  assert.equal(row.sourceId, row.targetId + 1);
  assert.equal(row.properties.FID, row.targetId);
  assert.ok(!properties.has(row.targetId));
  const entries = Object.entries(row.properties).filter(([, value]) => value !== null);
  if (entries.length !== Object.keys(row.properties).length) omittedNulls++;
  for (const [key, value] of entries) {
    const type = {string: 'String', number: 'Number', boolean: 'Boolean'}[typeof value];
    assert.ok(type && (!fields[key] || fields[key] === type)); fields[key] = type;
  }
  properties.set(row.targetId, Object.fromEntries(entries));
}
assert.equal(properties.size, 212944);
assert.equal(nonspatial.size, 9);
await mkdir(out);
const archive = new PMTiles(new FileSource(new File([sourceBytes], 'parent.pmtiles')));
const header = await archive.getHeader(), metadata = await archive.getMetadata();
assert.equal(header.minZoom, 7); assert.equal(header.maxZoom, 17);
assert.deepEqual(metadata.opengeo_layer_zoom_ranges, parent.layerZoomRanges);
metadata.vector_layers = metadata.vector_layers.map(layer => ({...layer, fields}));
const review = {
  status: 'rewriting-target-attributes', sourceUrl: target.sourceUrl, original: target.items[0],
  objectIdField: 'FID', geometryType: 'MultiLineString', sourceFeatures: 212935,
  originalSourceFeatures: 212944, nonSpatialRecords: 9, recipe: parent.recipe,
  layerZoomRanges: parent.layerZoomRanges, tileLayers: parent.tileLayers,
  precisionGroups: parent.precisionGroups.map(group => ({...group, ids: group.ids.map(id => id - 1)})),
  cartographicGeometryReuse: {parentDisplaySha256: parent.outputSha256,
    parentOriginal: parent.original, comparisonSha256: sha(correspondenceBytes),
    orderedCurveReviewSha256: sha(curveBytes),
    additionalDisplacementBoundMetres: curves.maximumWebMercatorDisplacementBoundMetres,
    method: 'Reuse the reviewed parent tile geometry with a measured sub-millimetre capture correspondence bound. Replace every ID and property from this distinct MapServer capture. Parent quantization and overview generalization still apply; original coordinates remain separately preserved.'},
  networkRequests: 0, s3Requests: 0, uploads: 0,
  limits: 'Local display candidate. Actual current viewer and preservation/admission remain required.'
};
const state = {status: 'rewriting', tiles: 0, fragments: 0, maximumDecodedTileBytes: 0,
  maximumCompressedTileBytes: 0, networkRequests: 0};
const seen = new Map(parent.layerZoomRanges.layers.map(layer => [layer.source_layer, new Set()]));
const detailZoom = new Map(parent.layerZoomRanges.layers.map(layer => [layer.source_layer, layer.max_zoom]));
const started = Date.now(); let db;
async function save() {
  state.seconds = (Date.now() - started) / 1000;
  await writeFile(resolve(out, 'geometry-reuse.json'), JSON.stringify(state, null, 2) + '\n');
  await writeFile(resolve(out, 'receipt.json'), JSON.stringify(review, null, 2) + '\n');
}
await writeFile(resolve(out, 'ordered-curve-review.json'), curveBytes);
await writeFile(resolve(out, 'source-correspondence.json'), correspondenceBytes);
await save();
try {
  db = new DatabaseSync(resolve(out, 'display.mbtiles'));
  db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
  const insertMeta = db.prepare('INSERT INTO metadata VALUES (?,?)');
  for (const [key, value] of Object.entries({name: 'MapServer contours', format: 'pbf', type: 'overlay',
    version: '1.3', minzoom: '7', maxzoom: '17',
    center: [header.centerLon, header.centerLat, header.centerZoom].join(','),
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat].join(','), json: JSON.stringify(metadata)})) insertMeta.run(key, value);
  const insert = db.prepare('INSERT INTO tiles VALUES (?,?,?,?)'); db.exec('BEGIN');
  async function walk(offset, length, depth = 0) {
    assert.ok(depth <= 3);
    for (const entry of await archive.cache.getDirectory(archive.source, offset, length, header)) {
      if (!entry.runLength) { await walk(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1); continue; }
      for (let tileId = entry.tileId; tileId < entry.tileId + entry.runLength; tileId++) {
        assert.ok(Date.now() - started < 900000, 'Rewrite time budget');
        const [z, x, y] = tileIdToZxy(tileId), response = await archive.getZxy(z, x, y);
        const tile = new VectorTile(new Pbf(new Uint8Array(response.data))), layers = {};
        for (const [name, layer] of Object.entries(tile.layers)) {
          assert.ok(seen.has(name));
          // The accepted mixed archive contains both GDAL and MapLibre grids.
          // Preserve each grid along with its integer geometry commands.
          assert.ok([4096, 8192].includes(layer.extent));
          const features = [];
          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i), id = feature.properties.fid - 1, props = properties.get(id);
            assert.ok(Number.isSafeInteger(id) && props && !nonspatial.has(id));
            const geometry = feature.loadGeometry();
            assert.equal(feature.type, 2);
            features.push({id, type: feature.type, properties: props, loadGeometry: () => geometry});
            if (z === detailZoom.get(name)) seen.get(name).add(id);
          }
          layers[name] = {name, version: 2, extent: layer.extent, length: features.length, feature: i => features[i]};
          state.fragments += features.length;
        }
        const encoded = fromVectorTileJs({layers}), decoded = new VectorTile(new Pbf(new Uint8Array(encoded)));
        assert.deepEqual(Object.keys(decoded.layers), Object.keys(layers));
        for (const [name, expected] of Object.entries(layers)) {
          const actual = decoded.layers[name]; assert.equal(actual.length, expected.length);
          assert.equal(actual.extent, expected.extent);
          for (let i = 0; i < expected.length; i++) {
            const a = actual.feature(i), b = expected.feature(i);
            assert.equal(a.id, b.id); assert.equal(a.type, b.type);
            assert.deepEqual({...a.properties}, b.properties);
            assert.deepEqual(a.loadGeometry(), b.loadGeometry());
          }
        }
        const compressed = gzipSync(encoded);
        assert.ok(encoded.length <= 16 * 1024**2 && compressed.length <= 8 * 1024**2);
        state.maximumDecodedTileBytes = Math.max(state.maximumDecodedTileBytes, encoded.length);
        state.maximumCompressedTileBytes = Math.max(state.maximumCompressedTileBytes, compressed.length);
        insert.run(z, x, 2**z - 1 - y, compressed); state.tiles++;
        if (state.tiles % 1000 === 0) {
          db.exec('COMMIT; BEGIN'); const free = await statfs(out);
          assert.ok(free.bavail * free.bsize > 4 * 1024**3); await save();
        }
      }
    }
  }
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength);
  db.exec('COMMIT'); assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok'); db.close(); db = null;
  const all = new Set([...seen.values()].flatMap(ids => [...ids]));
  assert.equal(all.size, 212935);
  for (const id of properties.keys()) assert.equal(all.has(id), !nonspatial.has(id));
  for (const layer of parent.tileLayers) assert.equal(seen.get(layer.source_layer).size, layer.feature_count);
  for (const group of review.precisionGroups) assert.deepEqual([...seen.get(group.source_layer)].sort((a,b) => a-b), [...group.ids].sort((a,b) => a-b));
  state.status = 'packing'; await save();
  await run('/usr/bin/ogr2ogr', [resolve(out, 'display.pmtiles'), resolve(out, 'display.mbtiles')],
    {timeout: 300000, maxBuffer: 1024**2, env: {...process.env, PROJ_NETWORK: 'OFF', GDAL_NUM_THREADS: '2'}});
  const bytes = await readFile(resolve(out, 'display.pmtiles'));
  assert.ok(bytes.length <= 2 * 1024**3);
  review.outputBytes = bytes.length; review.outputSha256 = sha(bytes); review.status = 'built-needs-packed-review';
  state.status = 'all-staged-fragment-geometry-and-target-properties-verified';
  state.uniqueDetailIds = all.size; state.featuresWithOmittedNulls = omittedNulls;
  // Packing is checked separately; do not label staged checks final PMTiles proof.
  console.log(JSON.stringify({directory: out, status: state.status, tiles: state.tiles}));
} catch (error) { state.status = 'stopped-needs-review'; state.error = String(error); throw error; }
finally { db?.close(); await save(); }
