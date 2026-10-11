// Bind a completed native MBTiles review to every exact packed MVT tile.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {PMTiles,FileSource,zxyToTileId} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';

const dir=resolve(process.argv[2]);
assert.ok(dir.startsWith(resolve('../.local-archives/bhutan-local-20260920/additional-nsdi-tiles')+'/'));
const target=resolve(dir,'packed-content-verification.json');assert.ok(!existsSync(target));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const buildBytes=await readFile(resolve(dir,'receipt.json')),build=JSON.parse(buildBytes);
const nativeBytes=await readFile(resolve(dir,'native-content-verification.json')),native=JSON.parse(nativeBytes);
assert.equal(build.status,'staged-detail-needs-content-verification');
assert.equal(native.status,'staged-native-content-passed');assert.equal(native.stagedSha256,build.stagedSha256);
assert.equal(native.sourceSha256,build.original.sha256);
assert.equal(native.seenDetailIds,build.sourceFeatures);assert.equal(native.positiveDetailIds,build.sourceFeatures);
const staged=await readFile(resolve(dir,'display.mbtiles'));assert.equal(sha(staged),build.stagedSha256);
const packed=await readFile(resolve(dir,'display.pmtiles'));
const archive=new PMTiles(new FileSource(new File([packed],'display.pmtiles')));
const header=await archive.getHeader(),metadata=await archive.getMetadata();
assert.equal(header.minZoom,build.recipe.minZoom);assert.equal(header.maxZoom,build.recipe.maxZoom);
assert.equal(header.tileType,1);assert.equal(header.tileCompression,2);
assert.deepEqual(metadata.vector_layers.map(l=>l.id),['data']);
const expected=new Set(),db=new DatabaseSync(resolve(dir,'display.mbtiles'),{readOnly:true});
let tiles=0;const ringMaxima={};const started=Date.now();
try{
 for(const row of db.prepare('SELECT zoom_level z,tile_column x,tile_row y,tile_data payload FROM tiles').iterate()){
  assert.ok(Date.now()-started<300000,'Packed verification wall bound');
  const y=2**row.z-1-row.y,id=zxyToTileId(row.z,row.x,y);
  assert.ok(!expected.has(id));expected.add(id);
  const result=await archive.getZxy(row.z,row.x,y);assert.ok(result);
  assert.equal(sha(new Uint8Array(result.data)),sha(gunzipSync(row.payload,{maxOutputLength:16*1024**2})));
  if(native.parentStagedSha256){
   const tile=new VectorTile(new Pbf(new Uint8Array(result.data)));
   for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
    const feature=layer.feature(i);if(feature.type!==3)continue;
    for(const rings of classifyRings(feature.loadGeometry(),0)){
     assert.ok(rings.length<=500,'Polygon exceeds renderer ring budget');
     ringMaxima[row.z]=Math.max(ringMaxima[row.z]??0,rings.length);
    }
   }
  }
  tiles++;
 }
}finally{db.close();}
let packedTiles=0;
async function walk(offset,length,depth=0){
 assert.ok(depth<=3);
 for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
  if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
  for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){assert.ok(expected.delete(id),'Extra or duplicate packed tile');packedTiles++;}
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
assert.equal(expected.size,0);assert.equal(packedTiles,tiles);assert.equal(tiles,native.tiles);
await writeFile(target,JSON.stringify({status:'passed',outputSha256:sha(packed),outputBytes:packed.length,
 stagedSha256:build.stagedSha256,...(native.parentStagedSha256?{parentStagedSha256:native.parentStagedSha256,rendererMaximumRingsByZoom:ringMaxima}:{}),sourceSha256:build.original.sha256,sourceFeatures:build.sourceFeatures,
 nativeVerificationSha256:sha(nativeBytes),buildReceiptSha256:sha(buildBytes),tiles,allPackedTilesEqualStaged:true,
 header,metadata,seconds:(Date.now()-started)/1000,networkRequests:0,
 scope:'All packed tile bytes equal the complete staged native review. Geometry coverage, overviews and actual viewer acceptance remain separate.'},null,2)+'\n');
console.log(JSON.stringify({status:'passed',tiles,features:build.sourceFeatures,bytes:packed.length}));
