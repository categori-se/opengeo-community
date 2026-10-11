// Exact geometry correspondence only. No catalog, storage or provider requests.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {capturedSha256, streamCapturedFeatures} from './stream-captured-features.mjs';

const root=resolve(import.meta.dirname,'../..');
const work=resolve(root,'.local-archives/bhutan-local-20260920');
const output=resolve(work,'road-network-geometry-correspondence.json');
assert.ok(!existsSync(output),'Inspect retained correspondence instead of repeating it');
const manifest=JSON.parse(await readFile(resolve(work,'transfer-originals/restoration-manifest.json')));
const reference=JSON.parse(await readFile(resolve(work,'additional-nsdi-tiles/4370f2f207b9eeef-z20/receipt.json')));
const target=JSON.parse(await readFile(resolve(work,'additional-nsdi-tiles/3369a07b19f5ca01-z21/receipt.json')));
const hashGeometry=g=>createHash('sha256').update(JSON.stringify(g)).digest('hex');
const byGeometry=new Map();
const results={status:'comparing',networkRequests:0,s3Requests:0,referenceOriginal:reference.original,targetOriginal:target.original,referenceRecords:0,targetRecords:0,matchedSpatialRecords:0,unmatchedSpatialRecords:0,nullTargetRecords:0,ambiguousGeometryMatches:0,matches:[],unmatchedIds:[]};
for(const [review,isTarget] of [[reference,false],[target,true]]){
 const source=resolve(manifest.sourceRoot,review.original.path);
 assert.equal(await capturedSha256(source),review.original.sha256);
 for await(const f of streamCapturedFeatures(source)){
  const id=f.properties[review.objectIdField];assert.ok(Number.isSafeInteger(id));
  if(!isTarget){
   results.referenceRecords++;
   if(f.geometry!==null){const key=hashGeometry(f.geometry);byGeometry.set(key,[...(byGeometry.get(key)??[]),id]);}
  }else{
   results.targetRecords++;
   if(f.geometry===null){results.nullTargetRecords++;continue;}
   const key=hashGeometry(f.geometry),ids=byGeometry.get(key);
   if(ids){results.matchedSpatialRecords++;results.ambiguousGeometryMatches+=Number(ids.length>1);results.matches.push({targetId:id,referenceIds:ids,geometrySha256:key});}
   else{results.unmatchedSpatialRecords++;results.unmatchedIds.push(id);}
  }
 }
}
assert.equal(results.referenceRecords,reference.originalSourceFeatures);
assert.equal(results.targetRecords,target.originalSourceFeatures);
results.status='exact-geometry-correspondence-measured';
results.scope='SHA-256 of parsed original geometry JSON; identities and properties are not assumed equivalent. Ambiguous duplicate geometries retain all candidate IDs. No reuse or complete display is established by this comparison.';
await writeFile(output,JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({...results,matches:undefined,unmatchedIds:undefined}));
