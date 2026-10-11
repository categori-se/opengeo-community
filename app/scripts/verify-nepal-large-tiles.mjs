// Native MVT identities and attributes against the exact retained Nepal input.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {compareTileProperties} from './compare-tile-properties.mjs';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
const root=resolve('..'),out=resolve(process.argv[2]);
assert.ok(out.startsWith(resolve(root,'.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-large-20260922')+'/'));
const path=resolve(out,'native-review.json');
assert.ok(!existsSync(path),'Inspect retained evidence before repeating');
const build=JSON.parse(await readFile(resolve(out,'receipt.json')));
assert.equal(build.status,'built-needs-content-verification');
const source=resolve(root,build.source.path);
assert.equal(await capturedSha256(source),build.source.sha256);
const expected=new Map(),all=new Set();let nonSpatial=0;
const started=Date.now();
const guard=()=>assert.ok(Date.now()-started<1200000,'20-minute native verification bound');
for await(const f of streamCapturedFeatures(source)){
 assert.ok(Number.isSafeInteger(f.id)&&!all.has(f.id));all.add(f.id);
 if(f.geometry===null){nonSpatial++;continue;}
 expected.set(f.id,f.properties);
 if(all.size%100000===0)guard();
}
assert.equal(all.size,build.source.features);
const bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),build.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles')));
const header=await archive.getHeader();assert.equal(header.maxZoom,build.recipe.maxZoom);
const zooms=build.layerZoomRanges?Object.fromEntries(build.layerZoomRanges.layers.map(r=>[r.source_layer,r.max_zoom])):{data:14};
if(build.layerZoomRanges)assert.deepEqual((await archive.getMetadata()).opengeo_layer_zoom_ranges,build.layerZoomRanges);
const fineIds=new Set(build.fineIds??[]),positiveFine=new Set();
const seen=new Set(),unknown=new Set(),mismatches=new Set(),omittedNullIds=new Set(),offsets=new Set();
let tiles=0,detailTiles=0,fragments=0,missingNativeIds=0,maximumDecodedBytes=0,oversizedTiles=0;
const omittedNullFields={};
async function walk(offset,length,depth=0){
 guard();assert.ok(depth<=3);
 const entries=await archive.cache.getDirectory(archive.source,offset,length,header);
 for(const entry of entries){
  if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
  for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
   guard();const [z,x,y]=tileIdToZxy(id),key=`${z}:${entry.offset}`;
   if(offsets.has(key))continue;offsets.add(key);
   const result=await archive.getZxy(z,x,y);tiles++;
   maximumDecodedBytes=Math.max(maximumDecodedBytes,result.data.byteLength);
   oversizedTiles+=Number(result.data.byteLength>16*1024**2);
   if(!Object.values(zooms).includes(z))continue;detailTiles++;
   const tile=new VectorTile(new Pbf(new Uint8Array(result.data)));
   for(const [name,layer] of Object.entries(tile.layers)){
   assert.ok(Object.hasOwn(zooms,name));if(z!==zooms[name])continue;
   for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);fragments++;
    if(f.id===undefined){missingNativeIds++;continue;}
    if(name==='fine'){
     assert.ok(fineIds.has(f.id));assert.equal(f.type,3);
     if(f.loadGeometry().some(r=>r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p.x*q.y-q.x*p.y;},0)!==0))positiveFine.add(f.id);
    }
    const original=expected.get(f.id);
    if(!original){unknown.add(f.id);continue;}seen.add(f.id);
    const result=compareTileProperties(original,f.properties,{allowOmittedNulls:true});
    if(result.mismatches.length)mismatches.add(f.id);
    for(const key of result.omittedNulls){omittedNullIds.add(f.id);omittedNullFields[key]=(omittedNullFields[key]??0)+1;}
   }
   }
  }
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
assert.deepEqual([...positiveFine].sort((a,b)=>a-b),[...fineIds].sort((a,b)=>a-b));
const missing=[...expected.keys()].filter(id=>!seen.has(id));
const receipt={status:!missing.length&&!unknown.size&&!mismatches.size&&!missingNativeIds&&!oversizedTiles?'passed':'rejected',
 sourceSha256:build.source.sha256,outputSha256:build.outputSha256,sourceFeatures:all.size,
 spatialFeatures:expected.size,nonSpatial,decodedIdentities:seen.size,missingIds:missing.length,
 missingIdentitySample:missing.slice(0,1000),unexpectedIds:unknown.size,propertyMismatches:mismatches.size,
 missingNativeIds,tiles,detailTiles,fragments,maximumDecodedBytes,oversizedTiles,
 omittedNullFields,featuresWithOmittedNulls:omittedNullIds.size,positiveFineIds:[...positiveFine],maximumZoomByLayer:zooms,seconds:(Date.now()-started)/1000,
 networkRequests:0,s3Requests:0,scope:'All native maximum-zoom FIDs and non-null attributes; MVT null omissions counted. Decoded tile-size ceiling checked at all zooms. Multipart geometry, positional fidelity, renderer and access acceptance remain separate.'};
await writeFile(path,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({...receipt,missingIdentitySample:missing.slice(0,12)}));
