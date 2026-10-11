// Load exact reviewed display derivatives without falling back to original geometry.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function loadReviewedPolygonSource(directory,{sourceSha256,topologyReviewSha256,ids}){
 assert.match(topologyReviewSha256,/^[a-f0-9]{64}$/);
 const reviewBytes=await readFile(resolve(directory,'topology-display-review.json'));
 assert.equal(sha(reviewBytes),topologyReviewSha256);
 const review=JSON.parse(reviewBytes);assert.equal(review.status,'display-topology-boundaries-reviewed');assert.equal(review.sourceSha256,sourceSha256);
 const originalBytes=await readFile(resolve(directory,'precision-source-features.json'));assert.equal(sha(originalBytes),review.retainedSha256);
 const original=JSON.parse(originalBytes);assert.equal(original.originalSha256,sourceSha256);
 const path=resolve(directory,'precision-reviewed-features.json'),bytes=await readFile(path),retained=JSON.parse(bytes);
 assert.equal(retained.originalSha256,sourceSha256);assert.equal(retained.topologyReviewSha256,topologyReviewSha256);
 const wanted=[...ids].sort((a,b)=>a-b),actual=retained.features.map(f=>f.properties.fid).sort((a,b)=>a-b);
 assert.deepEqual(actual,wanted);assert.equal(new Set(actual).size,actual.length);
 const originals=new Map(original.features.map(f=>[f.properties.fid,f]));
 const replacements=new Map();
 for(const row of review.records.filter(r=>r.candidatePath)){
  const candidateBytes=await readFile(resolve(directory,row.candidatePath));assert.equal(sha(candidateBytes),row.candidateSha256);
  const candidate=JSON.parse(candidateBytes).features;assert.equal(candidate.length,1);assert.equal(candidate[0].properties.fid,row.id);
  assert.ok(!replacements.has(row.id));replacements.set(row.id,candidate[0]);
 }
 assert.deepEqual([...replacements.keys()].sort((a,b)=>a-b),retained.transformedIds);
 const withoutGeometry=f=>Object.fromEntries(Object.entries(f).filter(([key])=>key!=='geometry'));
 for(const feature of retained.features){
  const id=feature.properties.fid,source=originals.get(id);assert.ok(source);
  assert.deepEqual(withoutGeometry(feature),withoutGeometry(source));
  assert.deepEqual(feature,replacements.get(id)??source);
 }
 return {path,features:retained.features,sha256:sha(bytes),topologyReviewSha256,transformedIds:retained.transformedIds};
}
