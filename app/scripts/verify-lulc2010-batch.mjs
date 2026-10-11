// Verify staged identities and native attributes before accepting a batch for merging.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {compareTileProperties} from './compare-tile-properties.mjs';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/conversion-batches');
const index=Number(process.argv[2]);assert.ok(Number.isInteger(index)&&index>=0);
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifestBytes=await readFile(resolve(base,'receipt.json')),manifest=JSON.parse(manifestBytes);
assert.equal(manifest.status,'complete-staged-display-input');
const batch=manifest.batches[index];assert.ok(batch);
const out=resolve(base,`converted-${String(index).padStart(4,'0')}`),receiptPath=resolve(out,'native-review.json');
assert.ok(!existsSync(receiptPath),'Inspect prior receipt before repeating');
const build=JSON.parse(await readFile(resolve(out,'receipt.json')));assert.equal(build.status,'converted');
assert.equal(build.binding.manifestSha256,sha(manifestBytes));assert.equal(build.binding.inputSha256,batch.sha256);
const sourceBytes=await readFile(resolve(base,batch.path));assert.equal(sha(sourceBytes),batch.sha256);
const features=JSON.parse(sourceBytes).features,expected=new Map(features.map(f=>[f.properties.fid,f.properties]));
assert.equal(expected.size,batch.features);assert.ok([...expected.keys()].every(Number.isSafeInteger));
const bytes=await readFile(resolve(out,'display.pmtiles'));assert.equal(sha(bytes),build.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();
assert.equal(header.minZoom,7);assert.equal(header.maxZoom,14);
const seen=new Set(),positive=new Set(),unknown=new Set(),mismatched=new Set(),omittedNullFields={};
let tiles=0,fragments=0,maximumDecodedBytes=0,missingNativeIds=0;
const start=Date.now(),offsets=new Set();
async function walk(offset,length,depth=0){
 assert.ok(depth<=3&&Date.now()-start<180000,'Bounded native review');
 for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
  if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
  for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
   assert.ok(Date.now()-start<180000);
   const [z,x,y]=tileIdToZxy(id),key=`${z}:${entry.offset}`;if(offsets.has(key))continue;offsets.add(key);
   const result=await archive.getZxy(z,x,y);tiles++;maximumDecodedBytes=Math.max(maximumDecodedBytes,result.data.byteLength);
   if(z!==14)continue;
   const tile=new VectorTile(new Pbf(new Uint8Array(result.data)));assert.deepEqual(Object.keys(tile.layers),['data']);
   const layer=tile.layers.data;
   for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);fragments++;assert.equal(f.type,3);
    // GDAL may encode the original identifier as a property rather than MVT id.
    const identity=f.properties.fid;
    if(!Number.isSafeInteger(identity)){missingNativeIds++;continue;}
    if(!expected.has(identity)){unknown.add(identity);continue;}seen.add(identity);
    const comparison=compareTileProperties(expected.get(identity),f.properties,{allowOmittedNulls:true});
    if(comparison.mismatches.length)mismatched.add(identity);
    for(const field of comparison.omittedNulls)omittedNullFields[field]=(omittedNullFields[field]??0)+1;
    if(f.loadGeometry().some(r=>r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p.x*q.y-q.x*p.y;},0)!==0))positive.add(identity);
   }
  }
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
const missing=[...expected.keys()].filter(id=>!seen.has(id)),nonpositive=[...expected.keys()].filter(id=>!positive.has(id));
const receipt={status:!missing.length&&!nonpositive.length&&!unknown.size&&!mismatched.size&&!missingNativeIds&&maximumDecodedBytes<=16*1024**2?'passed':'rejected',
 batch:index,inputSha256:batch.sha256,outputSha256:build.outputSha256,sourceFeatures:expected.size,decodedIdentities:seen.size,positiveAreaIdentities:positive.size,
 missingIds:missing,nonpositiveIds:nonpositive,unexpectedIds:[...unknown],propertyMismatchIds:[...mismatched],missingNativeIds,omittedNullFields,tiles,fragments,maximumDecodedBytes,seconds:(Date.now()-start)/1000,networkRequests:0,
 scope:'Native maximum-zoom fid properties, non-null attributes and positive area per record; not complete part/hole correspondence or merged tile budgets.'};
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
if(receipt.status!=='passed')process.exitCode=1;
