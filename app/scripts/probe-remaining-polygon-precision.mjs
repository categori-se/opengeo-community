// Reuse preserved small-feature profiles before choosing another full build.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';

const work=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920');
const output=resolve(work,'remaining-landcover-precision-20260922.json');
assert.ok(!existsSync(output),'Reuse existing precision evidence');
const samples=await readFile(resolve(work,'additional-nsdi-tiles/dfc54899cfb8e993/smallest-source-polygons.json'));
const prior=JSON.parse(await readFile(resolve(work,'additional-nsdi-tiles/dfc54899cfb8e993/receipt.json')));
const old=JSON.parse(await readFile(resolve(work,'lulc2020-small-feature-diagnostic.json')));
const groups=[{name:'LULC 2016',sourceSha256:prior.original.sha256,features:JSON.parse(samples).map(p=>({...p.feature,id:p.id}))},
 {name:'LULC 2020',sourceSha256:old.sourceSha256,features:old.records.map(p=>({type:'Feature',id:p.id,properties:{fid:p.id},geometry:p.geometry}))}];
const review={status:'tested-probes-not-full-capture',networkRequests:0,s3Requests:0,
 extent:8192,buffer:160,simplification:0,sourceProfileSha256:createHash('sha256').update(samples).digest('hex'),records:[],
 scope:'Only previously identified tiny source polygons. Positive tile area establishes quantization survival, not full-capture geometry, native attributes, renderer acceptance or positional accuracy.'};
for(const group of groups){
 const byZoom=Object.fromEntries(Array.from({length:9},(_,i)=>[i+14,new Set()]));
 let tileCount=0;
 await visitGeojsonTiles({type:'FeatureCollection',features:group.features},{minZoom:14,maxZoom:22,extent:8192,buffer:160},async(tile,{z})=>{
  tileCount++;
  for(const f of tile.features){
   assert.equal(f.type,3);
   const area=f.geometry.reduce((sum,r)=>sum+r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0),0);
   if(area!==0)byZoom[z].add(f.id);
  }
 });
 const ids=group.features.map(f=>f.id);
 review.records.push({name:group.name,sourceSha256:group.sourceSha256,probedIds:ids,tileCount,
  zooms:Object.fromEntries(Object.entries(byZoom).map(([z,seen])=>[z,{positiveAreaIds:[...seen].sort((a,b)=>a-b),missingIds:ids.filter(id=>!seen.has(id))}]))});
}
await writeFile(output,JSON.stringify(review,null,2)+'\n');
console.log(JSON.stringify(review));
