// Independent packed archive comparison; reuse source proofs only for exact bytes.
import assert from 'node:assert/strict';
import {open,readFile,writeFile,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {PMTiles,tileIdToZxy} from 'pmtiles';
import {capturedSha256} from './stream-captured-features.mjs';
const work=resolve('../.local-archives/bhutan-local-20260920'),parent=resolve(work,'soil-display-maplibre'),out=resolve(work,process.argv.includes('--grouped-overviews')?'soil-display-maplibre-grouped-overviews':process.argv.includes('--class-overviews')?'soil-display-maplibre-class-overviews':'soil-display-maplibre-overviews');
const target=resolve(out,'detail-reuse-verification.json');assert.ok(!existsSync(target));
const review=JSON.parse(await readFile(resolve(out,'receipt.json'))),previous=JSON.parse(await readFile(resolve(parent,'receipt.json')));
assert.equal(review.status,'built-awaiting-independent-review');assert.equal(review.parentDisplay.sha256,previous.outputSha256);
assert.equal(await capturedSha256(resolve(parent,'display.pmtiles')),previous.outputSha256);
assert.equal(await capturedSha256(resolve(out,'display.pmtiles')),review.outputSha256);
const handles=[];
async function reader(dir){
 const path=resolve(dir,'display.pmtiles'),file=await open(path,'r');handles.push(file);const size=(await file.stat()).size;
 return new PMTiles({getKey:()=>path,getBytes:async(offset,length)=>{
  assert.ok(length>0&&length<=16*1024**2&&offset>=0&&offset<size);
  const buffer=new Uint8Array(Math.min(length,size-offset));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);assert.equal(bytesRead,buffer.length);return {data:buffer.buffer};
 }});
}
const result={status:'checking',parentSha256:previous.outputSha256,outputSha256:review.outputSha256,
 retainedTiles:0,fullDetailTiles:0,comparedDecodedBytes:0,networkRequests:0,
 scope:'Every packed zoom 12–14 tile has exactly the same decoded bytes as the independently verified parent; source identity, attributes and sampled full-detail geometry proofs are inherited through this equality. No overview geometry claim.'};
try{
 const a=await reader(parent),b=await reader(out),header=await a.getHeader(),next=await b.getHeader();
 assert.equal(next.minZoom,header.minZoom);assert.equal(next.maxZoom,header.maxZoom);assert.equal(next.maxZoom,14);
 const seen=new Set();
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const entry of await a.cache.getDirectory(a.source,offset,length,header)){
   if(entry.runLength===0){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
   for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
    const [z,x,y]=tileIdToZxy(id);if(z<12)continue;seen.add(id);
    const first=await a.getZxy(z,x,y),second=await b.getZxy(z,x,y);assert.ok(first&&second);
    assert.ok(Buffer.from(first.data).equals(Buffer.from(second.data)),`Changed detail tile ${z}/${x}/${y}`);
    result.retainedTiles++;if(z===14)result.fullDetailTiles++;result.comparedDecodedBytes+=first.data.byteLength;
   }
  }
 }
 await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 assert.equal(result.retainedTiles,11393);assert.equal(result.fullDetailTiles,8574);
 let candidateDetail=0;
 async function checkExtra(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const entry of await b.cache.getDirectory(b.source,offset,length,next)){
   if(entry.runLength===0){await checkExtra(next.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
   for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++)if(tileIdToZxy(id)[0]>=12){assert.ok(seen.has(id),'Unexpected detail tile');candidateDetail++;}
  }
 }
 await checkExtra(next.rootDirectoryOffset,next.rootDirectoryLength);assert.equal(candidateDetail,result.retainedTiles);
 result.status='passed';
 for(const file of ['mvt-content-verification.json','complex-polygon-rendered-coverage.json','tiny-polygon-geometry.json']){
  const proof=JSON.parse(await readFile(resolve(parent,file)));assert.equal(proof.status,'passed');assert.equal(proof.outputSha256,previous.outputSha256);
  proof.outputSha256=review.outputSha256;proof.reusedFrom={path:resolve(parent,file),outputSha256:previous.outputSha256,equalityProof:'detail-reuse-verification.json'};
  proof.scope+=' Reused for this artifact only after independent byte-for-byte equality of all packed zoom 12–14 tiles; not a repeated source scan.';
  assert.ok(!existsSync(resolve(out,file)));await writeFile(resolve(out,file),JSON.stringify(proof,null,2)+'\n');
 }
 await copyFile(resolve(parent,'maplibre-build.json'),resolve(out,'maplibre-build.json'));
 for(const [source,name] of [['mvt-content-verification.json','parent-native-review.json'],['tiny-polygon-geometry.json','parent-geometry-review.json'],['complex-polygon-rendered-coverage.json','parent-complex-coverage-review.json']])await copyFile(resolve(parent,source),resolve(out,name));
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{for(const f of handles)await f.close();await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
