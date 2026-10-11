// Establish exact source equality before reusing any annual display geometry.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
const base=resolve('../.local-archives/bhutan-local-20260920/glacier-displays');
const out=resolve(base,'82febbdb6b58a668/annual-source-match.json');
assert.ok(!existsSync(out),'Inspect existing match evidence');
const combined=JSON.parse(await readFile(resolve(base,'82febbdb6b58a668/receipt.json')));
assert.equal(await capturedSha256(combined.original.path),combined.original.sha256);
const key=f=>`${f.properties.Year}:${f.properties.ID}:${f.properties.GLIMS_ID}`;
const hash=f=>{assert.equal(f.id,f.properties.OBJECTID,'GeoJSON feature ID must be the mapped source identity');return createHash('sha256').update(JSON.stringify({...f,id:0,properties:{...f.properties,OBJECTID:0}})).digest('hex');};
const expected=new Map();
for await(const f of streamCapturedFeatures(combined.original.path)){
 assert.ok(!expected.has(key(f)),'Ambiguous glacier/year identity');
 expected.set(key(f),{id:f.properties.OBJECTID,hash:hash(f)});
}
assert.equal(expected.size,259228);
const groups=[];
for(const group of ['612946ca2ab0561b','f9522f48b0255553','1994846fbc845ada','51114efbe4962e7f']){
 const dir=resolve(base,group),receipt=JSON.parse(await readFile(resolve(dir,'receipt.json')));
 const native=JSON.parse(await readFile(resolve(dir,'mvt-content-verification.json')));
 assert.equal(native.status,'passed');assert.equal(native.outputSha256,receipt.outputSha256);
 assert.equal(await capturedSha256(receipt.original.path),receipt.original.sha256);
 const mapping=[],offsets=new Set();
 for await(const f of streamCapturedFeatures(receipt.original.path)){
  const match=expected.get(key(f));assert.ok(match);assert.equal(hash(f),match.hash,'Source geometry or non-identity attributes differ');
  mapping.push([f.properties.OBJECTID,match.id]);offsets.add(match.id-f.properties.OBJECTID);expected.delete(key(f));
 }
 assert.equal(mapping.length,receipt.sourceFeatures);
 groups.push({group,sourceFeatures:mapping.length,sourceSha256:receipt.original.sha256,displaySha256:receipt.outputSha256,
  constantObjectIdOffset:offsets.size===1?[...offsets][0]:null,mapping});
 console.log(JSON.stringify({group,matched:mapping.length,offsets:[...offsets]}));
}
assert.equal(expected.size,0);
await writeFile(out,JSON.stringify({status:'all-combined-features-exactly-match-annual-sources',combinedSourceSha256:combined.original.sha256,
 featureCount:259228,groups,networkRequests:0,s3Requests:0,
 limits:'Geometry, feature structure and every attribute except explicitly mapped GeoJSON id and OBJECTID match exactly. This proves source correspondence; merged native tiles and viewer checks remain required.'},null,2)+'\n');
