// Preserve integer polygon geometry while reducing per-feature display overhead.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {VectorTile} from '@mapbox/vector-tile';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import Pbf from 'pbf';

const sha = value => createHash('sha256').update(value).digest('hex');
function decode(bytes) {return new VectorTile(new Pbf(new Uint8Array(bytes))).layers.data;}
function inventory(layer) {
  const polygons=[];
  for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);assert.equal(f.type,3);assert.equal(f.id,undefined);
    assert.deepEqual(Object.keys(f.properties).sort(),['gridcode','representation']);
    assert.equal(f.properties.representation,'Aggregated soil-class overview');
    assert.ok(Number.isSafeInteger(f.properties.gridcode));
    const geometry=f.loadGeometry(),unlimited=classifyRings(geometry,0),bounded=classifyRings(geometry,500);
    assert.equal(unlimited.reduce((n,p)=>n+p.length,0),bounded.reduce((n,p)=>n+p.length,0));
    for(const polygon of unlimited)polygons.push(sha(JSON.stringify([f.properties.gridcode,polygon.map(r=>r.map(p=>[p.x,p.y]))])));
  }
  return polygons.sort();
}
export function groupOverview(bytes) {
  const source=decode(bytes),groups=new Map(),features=[];
  for(let i=0;i<source.length;i++){
    const f=source.feature(i),geometry=f.loadGeometry().map(r=>r.map(p=>[p.x,p.y]));
    const vertices=geometry.reduce((n,r)=>n+r.length,0),key=f.properties.gridcode;
    assert.ok(vertices<=16384 && geometry.length<=400,'An individual polygon exceeds the declared grouping budget');
    let group=groups.get(key);
    if(!group || group.vertices+vertices>16384 || group.geometry.length+geometry.length>400){
      group={type:3,tags:{...f.properties},geometry:[],vertices:0};groups.set(key,group);features.push(group);
    }
    group.geometry.push(...geometry);group.vertices+=vertices;
  }
  const output=fromGeojsonVt({data:{features:features.map(({vertices,...feature})=>feature)}},{extent:8192,version:2});
  const before=inventory(source),after=inventory(decode(output));
  assert.deepEqual(after,before,'Every classified polygon and hole must retain its exact integer coordinates');
  return {bytes:output,sourceFeatures:source.length,features:features.length,polygons:before.length,geometryInventorySha256:sha(before.join('\n'))};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const [input,output]=process.argv.slice(2);assert.ok(input&&output);
 const root=JSON.parse(await readFile(resolve(input,'overview-build.json')));
 assert.equal(root.status,'built-awaiting-packed-and-selector-review');
 const rows=[];await mkdir(resolve(output,'overview-tiles'),{recursive:true});
 for(const t of root.tiles){
  const key=`${t.z}-${t.x}-${t.y}.mvt.gz`,old=await readFile(resolve(input,'overview-tiles',key));
  assert.equal(sha(old),t.sha256);
  const {bytes,...proof}=groupOverview(gunzipSync(old));const packed=gzipSync(bytes);
  assert.ok(bytes.length<=16*1024**2&&packed.length<=8*1024**2);
  await writeFile(resolve(output,'overview-tiles',key),packed,{flag:'wx'});
  rows.push({...t,...proof,sourceTileSha256:t.sha256,sha256:sha(packed),decodedBytes:bytes.length,compressedBytes:packed.length});
 }
 await writeFile(resolve(output,'grouping-verification.json'),JSON.stringify({status:'passed',method:'Same-class multipart grouping; exact per-class integer polygon and hole inventory equality; no resampling',tiles:rows},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({tiles:rows.length,before:rows.reduce((n,t)=>n+t.sourceFeatures,0),after:rows.reduce((n,t)=>n+t.features,0)}));
}
