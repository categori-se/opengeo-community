import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
const dir=await mkdtemp(join(tmpdir(),'capture-stream-'));
try {
  const features=[null,[],[[90.82859740402523,27.671991505920726]]].map((coordinates,i)=>({
    type:'Feature',properties:{id:i,text:'quote " slash \\ newline\n features [ ] Ω',
      empty:[],nested:{null:null,list:[false,1.2345678901234567]}},
    geometry:coordinates===null?null:{type:'LineString',coordinates}}));
  const body=JSON.stringify({type:'FeatureCollection',metadata:{features:[{type:'ignore'}]},features});
  const path=join(dir,'capture.json');await writeFile(path,body);
  const actual=[];for await(const feature of streamCapturedFeatures(path))actual.push(feature);
  assert.deepEqual(actual,features);
  assert.equal(await capturedSha256(path),createHash('sha256').update(body).digest('hex'));
  const largeFeatures=[...features,{type:'Feature',properties:{id:4,large:'Ω\\"'.repeat(100000)},geometry:null}];
  await writeFile(path,JSON.stringify({type:'FeatureCollection',features:largeFeatures}));
  const large=[];for await(const feature of streamCapturedFeatures(path))large.push(feature);
  assert.deepEqual(large,largeFeatures);
  for(const invalid of [body.slice(0,-5),body+'{}',body.replace('FeatureCollection','invalid'),
    '{"type":"FeatureCollection","features":[],}',
    '{"type":"FeatureCollection","features":[],"features":[]}',
    '{"type":"FeatureCollection","features":[null]}']){
    await writeFile(path,invalid);
    await assert.rejects(async()=>{for await(const feature of streamCapturedFeatures(path))void feature;});
  }
  console.log('Captured feature streaming: nested metadata excluded, identities/nulls/numbers preserved, malformed input rejected.');
} finally {await rm(dir,{recursive:true,force:true});}
