// Read immutable packed artifacts in bounded pieces, including actual block alignment.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {PMTiles,tileIdToZxy} from 'pmtiles';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {capturedSha256} from './stream-captured-features.mjs';

const out=resolve(process.argv[2]),path=resolve(out,'display.pmtiles'),receiptPath=resolve(out,'packed-tile-budget.json');
assert.ok(!existsSync(receiptPath),'Reuse or inspect the prior packed audit');
const review=JSON.parse(await readFile(resolve(out,'receipt.json')));
assert.equal(await capturedSha256(path),review.outputSha256);
const fineDirectory=process.argv.find(x=>x.startsWith('--verified-fine-directory='))?.slice('--verified-fine-directory='.length);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let fineDb,fineQuery,fineProof;
if(fineDirectory){
 const directory=resolve(fineDirectory),nativeBytes=await readFile(resolve(directory,'native-receipt.json')),coverageBytes=await readFile(resolve(directory,'coverage/receipt.json'));
 const native=JSON.parse(nativeBytes),coverage=JSON.parse(coverageBytes);
 assert.ok(review.robustFine&&review.componentRepair&&review.geometryType==='MultiPolygon');
 assert.equal(sha(nativeBytes),review.robustFine.nativeReviewSha256);assert.equal(sha(coverageBytes),review.robustFine.coverageSha256);
 assert.equal(coverage.status,'passed');assert.equal(coverage.triangulated,true);
 assert.equal(coverage.inputSha256,native.probeInputSha256);assert.equal(coverage.decodedFragmentsSha256,native.coverage.sha256);
 assert.equal(coverage.results.length,native.components);assert.ok(coverage.results.every(r=>!r.missingBeyondTolerance&&!r.unexpectedBeyondTolerance));
 const database=resolve(directory,'native-tiles.sqlite');assert.equal(await capturedSha256(database),review.robustFine.outputDatabaseSha256);
 assert.equal(native.outputDatabaseSha256,review.robustFine.outputDatabaseSha256);
 fineDb=new DatabaseSync(database,{readOnly:true});fineQuery=fineDb.prepare('SELECT payload FROM tiles WHERE z=? AND x=? AND y=?');
 fineProof={status:'checking',outputSha256:review.outputSha256,sourceSha256:review.original.sha256,inputSha256:coverage.inputSha256,
  nativeReviewSha256:sha(nativeBytes),coverageSha256:sha(coverageBytes),nativeDatabaseSha256:native.outputDatabaseSha256,
  expectedTiles:fineDb.prepare('SELECT COUNT(*) AS count FROM tiles').get().count,matchedTiles:0,components:coverage.results.length,
  scope:'Every packed tile above zoom 14 matches the independently reviewed native tile byte-for-byte after decompression. Complete component/hole coverage is inherited through immutable review hashes; no new source-area or browser claim.'};
}

const file=await open(path,'r'),size=(await file.stat()).size;
const result={status:'checking',outputSha256:review.outputSha256,uniquePayloads:0,
 maximumCompressedBytes:0,maximumDecodedBytes:0,maximumAlignedReadBytes:0,failures:[],networkRequests:0,
 scope:'Every distinct packed tile payload checked against the actual 8 MiB aligned range response and 16 MiB decoded reader limits; not geometry or signed-in acceptance.'};
async function read(offset,length){
 assert.ok(Number.isSafeInteger(offset)&&offset>=0&&length>0&&length<=16*1024**2);
 const buffer=new Uint8Array(Math.min(length,size-offset));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);assert.equal(bytesRead,buffer.length);return buffer;
}
try{
 const archive=new PMTiles({getKey:()=>path,getBytes:async(offset,length)=>({data:(await read(offset,length)).buffer})});
 const h=await archive.getHeader();assert.equal(h.tileCompression,2);
 const seen=new Map(),fineSeen=new Set();
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const entry of await archive.cache.getDirectory(archive.source,offset,length,h)){
   if(entry.runLength===0){await walk(h.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
   if(!seen.has(entry.offset)){
    const start=h.tileDataOffset+entry.offset;
    const aligned=Math.min(size,Math.ceil((start+entry.length)/65536)*65536)-Math.floor(start/65536)*65536;
    const payload=gunzipSync(await read(start,entry.length)),decoded=payload.length;
    seen.set(entry.offset,fineDb?sha(payload):true);
    result.uniquePayloads++;result.maximumCompressedBytes=Math.max(result.maximumCompressedBytes,entry.length);
    result.maximumDecodedBytes=Math.max(result.maximumDecodedBytes,decoded);result.maximumAlignedReadBytes=Math.max(result.maximumAlignedReadBytes,aligned);
    if(entry.length>8*1024**2||aligned>8*1024**2||decoded>16*1024**2){
     assert.ok(result.failures.length<100);result.failures.push({tileId:entry.tileId,offset:start,compressed:entry.length,aligned,decoded});
    }
   }
   if(fineDb)for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
    const [z,x,y]=tileIdToZxy(id);if(z<=14)continue;
    assert.ok(!fineSeen.has(id),'Duplicate packed fine tile');fineSeen.add(id);
    const expected=fineQuery.get(z,x,y);assert.ok(expected,'Unexpected packed fine tile');
    assert.equal(sha(gunzipSync(expected.payload)),seen.get(entry.offset),'Packed fine geometry differs from reviewed bytes');fineProof.matchedTiles++;
   }
  }
 }
 await walk(h.rootDirectoryOffset,h.rootDirectoryLength);
 if(fineDb){assert.equal(fineProof.matchedTiles,fineProof.expectedTiles);fineProof.status='passed';}
 result.status=result.failures.length?'rejected':'passed';
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{fineDb?.close();if(fineProof){if(result.status!=='passed')fineProof.status='failed';await writeFile(resolve(out,'fine-component-packed-coverage.json'),JSON.stringify(fineProof,null,2)+'\n');}await file.close();await writeFile(receiptPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
if(result.status!=='passed')process.exitCode=1;
