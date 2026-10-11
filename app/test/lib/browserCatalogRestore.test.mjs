import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreBrowserCatalogLayers} from '../../src/lib/browserCatalogRestore.js';
const data = {type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[1,2]},properties:{}}]};
const layer = id => ({layerId:id,browserCatalogId:'reviewed',datasetId:'dataset',sourceType:'snapshot',title:'Curated title',style:{opacity:0.4},metadata:{curated:{license:null}}});
test('reuses one reviewed load for multiple occurrences without overwriting curation', async()=>{
  const layers=[layer('a'),layer('b')], dataByLayerId=new Map(); let calls=0; const before=structuredClone(layers);
  const result=await restoreBrowserCatalogLayers({layers,dataByLayerId,catalog:[{id:'reviewed',load:async()=>{calls++;return {layer:layer('source'),geojson:data};}}],isCurrent:l=>layers.includes(l),onData:()=>{},onStatus:()=>{}});
  assert.equal(calls,1);assert.equal(dataByLayerId.size,2);assert.deepEqual(layers,before);assert.ok(result.every(r=>r.status==='restored'));
});
test('does not resurrect a removed Layer after an asynchronous source load',async()=>{
 let finish;const layers=[layer('a')],dataByLayerId=new Map();
 const task=restoreBrowserCatalogLayers({layers,dataByLayerId,catalog:[{id:'reviewed',load:()=>new Promise(resolve=>finish=resolve)}],isCurrent:l=>layers.includes(l),onData:()=>assert.fail('removed layer rendered'),onStatus:()=>{}});
 await Promise.resolve();layers.length=0;finish({layer:layer('source'),geojson:data});await task;assert.equal(dataByLayerId.size,0);
});
test('unreviewed identities and mismatched sources retain the saved record without data',async()=>{
 const layers=[{...layer('a'),browserCatalogId:'untrusted',sourceUrl:'https://untrusted.invalid'},layer('b')],dataByLayerId=new Map();let calls=0;
 const result=await restoreBrowserCatalogLayers({layers,dataByLayerId,catalog:[{id:'reviewed',load:async()=>{calls++;return {layer:{...layer('source'),datasetId:'changed'},geojson:data};}}],isCurrent:()=>true,onData:()=>assert.fail('invalid source rendered'),onStatus:()=>{}});
 assert.deepEqual(result.map(r=>r.status),['unavailable','failed']);assert.equal(calls,1);assert.equal(dataByLayerId.size,0);assert.equal(layers.length,2);
});
