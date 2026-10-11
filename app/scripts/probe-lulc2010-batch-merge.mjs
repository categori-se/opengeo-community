// Exact native round-trip of overlapping batch tiles; no archive admission.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/conversion-batches');
const output=resolve(base,'merge-probe-0000-0001.json');assert.ok(!existsSync(output));
const sha=b=>createHash('sha256').update(b).digest('hex'),archives=[],inputs=[],tileIds=new Map();
const started=Date.now();
for(const index of [0,1]){
 const out=resolve(base,`converted-${String(index).padStart(4,'0')}`),build=JSON.parse(await readFile(resolve(out,'receipt.json'))),native=JSON.parse(await readFile(resolve(out,'native-review.json')));
 assert.equal(build.status,'converted');assert.equal(native.status,'passed');assert.equal(native.outputSha256,build.outputSha256);
 const bytes=await readFile(resolve(out,'display.pmtiles'));assert.equal(sha(bytes),build.outputSha256);
 const archive=new PMTiles(new FileSource(new File([bytes],'batch.pmtiles'))),header=await archive.getHeader();archives.push(archive);inputs.push(build.outputSha256);
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3&&Date.now()-started<120000);
  for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
   if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
   for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){if(!tileIds.has(id))tileIds.set(id,[]);tileIds.get(id).push(index);}
  }
 }
 await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
}
let overlappingTiles=0,fragments=0,maximumDecodedBytes=0,maximumCompressedBytes=0,nativeIdCollisions=0;
const overBudget=[];
for(const [id,indices] of tileIds){
 assert.ok(Date.now()-started<120000);
 if(indices.length<2)continue;overlappingTiles++;
 const features=[],identities=new Set(),nativeIds=new Set();let extent;
 for(const index of indices){
  const result=await archives[index].getZxy(...tileIdToZxy(id)),tile=new VectorTile(new Pbf(new Uint8Array(result.data)));
  assert.deepEqual(Object.keys(tile.layers),['data']);const layer=tile.layers.data;
  if(extent!==undefined)assert.equal(layer.extent,extent,'Merge requires equal native grid');extent=layer.extent;
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);assert.ok(!identities.has(f.properties.fid),'Source identity overlap');identities.add(f.properties.fid);
   if(f.id!==undefined){if(nativeIds.has(f.id))nativeIdCollisions++;nativeIds.add(f.id);}features.push(f);
  }
 }
 const packed=fromVectorTileJs({layers:{data:{name:'data',version:2,extent,length:features.length,feature:i=>features[i]}}});
 const compressed=gzipSync(packed);maximumDecodedBytes=Math.max(maximumDecodedBytes,packed.length);maximumCompressedBytes=Math.max(maximumCompressedBytes,compressed.length);
 if(packed.length>16*1024**2||compressed.length>8*1024**2)overBudget.push({tile:tileIdToZxy(id),decodedBytes:packed.length,compressedBytes:compressed.length});
 const decoded=new VectorTile(new Pbf(packed)).layers.data;assert.equal(decoded.length,features.length);assert.equal(decoded.extent,extent);
 for(let i=0;i<features.length;i++){
  const before=features[i],after=decoded.feature(i);assert.equal(after.id,before.id);assert.equal(after.type,before.type);assert.deepEqual(after.properties,before.properties);assert.deepEqual(after.loadGeometry(),before.loadGeometry());fragments++;
 }
}
assert.ok(overlappingTiles>0);
const receipt={status:overBudget.length||nativeIdCollisions?'needs-review':'passed',inputSha256:inputs,overlappingTiles,fragments,maximumDecodedBytes,maximumCompressedBytes,nativeIdCollisions,overBudget,seconds:(Date.now()-started)/1000,networkRequests:0,scope:'Two batches only. Exact native geometry, attributes and IDs survive overlap re-encoding on equal grids. Does not prove full-source merged budgets, topology or browser behavior.'};
await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
