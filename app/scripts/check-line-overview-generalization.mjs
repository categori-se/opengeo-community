// Confirm moving records between display layers preserves every overview fragment.
import {verifyLineGeneralization} from './verify-line-generalization.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
const parent=resolve(process.argv[2]),out=resolve(process.argv[3]),target=resolve(out,'overview-generalization-verification.json');
assert.ok(!existsSync(target));
async function open(folder){
 const review=JSON.parse(await readFile(resolve(folder,'receipt.json'))),bytes=await readFile(resolve(folder,'display.pmtiles'));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
 return {review,archive:new PMTiles(new FileSource(new File([bytes],'display.pmtiles')))};
}
const a=await open(parent),b=await open(out);assert.equal(a.review.original.sha256,b.review.original.sha256);
assert.equal(b.review.parentDisplay.sha256,a.review.outputSha256);assert.ok(b.review.componentRepair);
const declared=b.review.overviewLineGeneralization;
assert.ok(declared);assert.equal(declared.maximumDeviationPixels,0.5);assert.equal(declared.referencePixelSize,512);
const selected=new Set(declared.tileIds),checked=new Set();assert.ok(selected.size>0&&selected.size<=10);
const header=await a.archive.getHeader();let tiles=0,fragments=0,verticesVerified=0,maximumDeviationPixels=0;
function records(tile){
 const rows=[];
 for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
  const f=layer.feature(i);rows.push({id:f.properties.fid,nativeId:f.id,type:f.type,extent:layer.extent,properties:f.properties,geometry:f.loadGeometry().map(r=>r.map(p=>[p.x,p.y]))});
 }
 return rows.sort((x,y)=>x.id-y.id||JSON.stringify(x.geometry).localeCompare(JSON.stringify(y.geometry)));
}
async function walk(offset,length,depth=0){
 assert.ok(depth<=3);
 for(const e of await a.archive.cache.getDirectory(a.archive.source,offset,length,header)){
  if(!e.runLength){await walk(header.leafDirectoryOffset+e.offset,e.length,depth+1);continue;}
  for(let id=e.tileId;id<e.tileId+e.runLength;id++){
   const [z,x,y]=tileIdToZxy(id);assert.ok(z<=14);
   const original=await a.archive.getZxy(z,x,y),replacement=await b.archive.getZxy(z,x,y);assert.ok(replacement);
   const expected=records(new VectorTile(new Pbf(new Uint8Array(original.data))));
   const actual=records(new VectorTile(new Pbf(new Uint8Array(replacement.data))));
   if(!selected.has(id))assert.deepEqual(actual,expected,`Undeclared change at ${z}/${x}/${y}`);
   else {
    assert.ok(z<14);assert.equal(actual.length,expected.length);
    assert.equal(new Set(expected.map(row=>row.id)).size,expected.length,'Ambiguous fragment correspondence');
    for(let i=0;i<expected.length;i++){
     const {geometry:before,...identity}=expected[i],{geometry:after,...replacementIdentity}=actual[i];
     assert.deepEqual(replacementIdentity,identity);assert.equal(identity.type,2);
     const points=parts=>parts.map(part=>part.map(([x,y])=>({x,y})));
     const result=verifyLineGeneralization(points(before),points(after),identity.extent/1024);
     verticesVerified+=result.vertices;maximumDeviationPixels=Math.max(maximumDeviationPixels,result.maximumDeviation/identity.extent*512);
    }
    checked.add(id);
   }
   tiles++;fragments+=expected.length;
  }
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
assert.deepEqual([...checked].sort(),[...selected].sort());
const result={generalizedTileIds:[...checked],verticesVerified,maximumDeviationPixels,status:'passed',parentSha256:a.review.outputSha256,outputSha256:b.review.outputSha256,tiles,fragments,networkRequests:0,scope:'All parent tiles retain identities, attributes, types and extents. Only the declared overview tiles change geometry, with every parent vertex checked against its corresponding output chord within half a pixel at 512-pixel resolution. Other zooms 7–14 retain exact integer geometry across both layers.'};
await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
