// Native fine tiles and exact decoded fill evidence from robust grid polygons.
import assert from 'node:assert/strict';
import {readFile,writeFile,statfs} from 'node:fs/promises';
import {existsSync,openSync,writeSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import earcut,{flatten} from 'earcut';
import {capturedSha256} from './stream-captured-features.mjs';
import {compareTileProperties} from './compare-tile-properties.mjs';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/component-preparation');
const out=resolve(base,'robust-fine'),receiptPath=resolve(out,'native-receipt.json');assert.ok(!existsSync(receiptPath));
const sha=b=>createHash('sha256').update(b).digest('hex');
const buildBytes=await readFile(resolve(out,'receipt.json')),build=JSON.parse(buildBytes);assert.equal(build.status,'complete-needs-native-coverage');
const sourceBytes=await readFile(resolve(base,'precision-reviewed-features.json'));assert.equal(sha(sourceBytes),build.binding.inputSha256);
const source=JSON.parse(sourceBytes),properties=new Map(source.features.map(f=>[f.properties.fid,f.properties]));
assert.equal(source.topologyReviewSha256,build.binding.reviewSha256);
assert.equal(JSON.parse(await readFile(new URL('../node_modules/earcut/package.json',import.meta.url))).version,'3.0.2');
const inputPath=resolve(out,'fragments.sqlite'),inputHash=await capturedSha256(inputPath);
const db=new DatabaseSync(inputPath,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fragments').get().count,build.fragments);
const coveragePath=resolve(out,'native-triangulated-coverage.jsonl'),nativePath=resolve(out,'native-tiles.sqlite');assert.ok(!existsSync(coveragePath)&&!existsSync(nativePath));
const packed=new DatabaseSync(nativePath);packed.exec('CREATE TABLE tiles(z INTEGER,x INTEGER,y INTEGER,payload BLOB,PRIMARY KEY(z,x,y));');
const put=packed.prepare('INSERT INTO tiles VALUES(?,?,?,?)'),rows=db.prepare('SELECT fid,component,polygons FROM fragments WHERE z=? AND x=? AND y=? ORDER BY fid,component');
const handle=openSync(coveragePath,'wx'),coverageHash=createHash('sha256'),positive=new Set();
const started=Date.now(),state={status:'encoding',sourceSha256:source.originalSha256,probeInputSha256:sha(sourceBytes),topologyReviewSha256:source.topologyReviewSha256,buildSha256:sha(buildBytes),inputDatabaseSha256:inputHash,components:build.completed.length,tiles:0,fragments:0,coverageFragments:0,coverageBytes:0,maximumDecodedBytes:0,maximumCompressedBytes:0,rendererDroppedRings:0,omittedNullFields:{},networkRequests:0,scope:'Native exact-grid encoding, attribute check and triangulated fill export. Independent all-component coverage and final packed viewer acceptance still required.'};
const save=async()=>{state.seconds=(Date.now()-started)/1000;await writeFile(receiptPath,JSON.stringify(state,null,2)+'\n');};
try{
 await save();packed.exec('BEGIN');
 for(const tile of db.prepare('SELECT DISTINCT z,x,y FROM fragments ORDER BY z,x,y').iterate()){
  assert.ok(Date.now()-started<600000,'Native encoding wall bound');
  if(state.tiles%1000===0){const disk=await statfs(out);assert.ok(disk.bavail*disk.bsize>8*1024**3);await save();}
  const parts=[...rows.iterate(tile.z,tile.x,tile.y)];
  const features=parts.map(row=>({id:row.fid,type:3,geometry:JSON.parse(row.polygons).flat().map(r=>r.map(p=>p.map(v=>v===0?0:v))),tags:properties.get(row.fid)}));assert.ok(features.every(f=>f.tags));
  const encoded=fromGeojsonVt({fine:{features}},{extent:8192,version:2}),compressed=gzipSync(encoded);
  state.maximumDecodedBytes=Math.max(state.maximumDecodedBytes,encoded.length);state.maximumCompressedBytes=Math.max(state.maximumCompressedBytes,compressed.length);
  assert.ok(encoded.length<=16*1024**2&&compressed.length<=8*1024**2,'Actual tile reader limits');
  const layer=new VectorTile(new Pbf(encoded)).layers.fine;assert.equal(layer.length,features.length);assert.equal(layer.extent,8192);
  for(let i=0;i<features.length;i++){
   const f=layer.feature(i),expected=features[i];assert.equal(f.id,expected.id);assert.equal(f.type,3);
   assert.deepEqual(f.loadGeometry().map(r=>r.map(p=>[p.x,p.y])),expected.geometry);
   const comparison=compareTileProperties(expected.tags,f.properties,{allowOmittedNulls:true});assert.deepEqual(comparison.mismatches,[]);
   for(const field of comparison.omittedNulls)state.omittedNullFields[field]=(state.omittedNullFields[field]??0)+1;
   const all=classifyRings(f.loadGeometry(),0),rendered=classifyRings(f.loadGeometry(),500);
   const ringCount=ps=>ps.reduce((n,p)=>n+p.length,0);assert.equal(ringCount(all),ringCount(rendered),'Renderer ring limit');
   if(tile.z===19){
    const coordinates=[],unit=40075016.68557849/(2**tile.z*8192),half=20037508.342789244;
    for(const polygon of rendered){
     const {vertices,holes,dimensions}=flatten(polygon.map(r=>r.map(p=>[p.x,p.y]))),indices=earcut(vertices,holes,dimensions);
     for(let j=0;j<indices.length;j+=3){
      const points=indices.slice(j,j+3).map(k=>[vertices[k*2],vertices[k*2+1]]);
      if((points[1][0]-points[0][0])*(points[2][1]-points[0][1])===(points[2][0]-points[0][0])*(points[1][1]-points[0][1]))continue;
      const ring=points.map(([x,y])=>[(tile.x*8192+x)*unit-half,half-(tile.y*8192+y)*unit]);ring.push(ring[0]);coordinates.push([ring]);
     }
    }
    if(coordinates.length)positive.add(parts[i].component);
    const body=Buffer.from(JSON.stringify({component:parts[i].component,geometry:{type:'MultiPolygon',coordinates}})+'\n');
    state.coverageBytes+=body.length;assert.ok(state.coverageBytes<=512*1024**2,'Coverage export cap');writeSync(handle,body);coverageHash.update(body);state.coverageFragments++;
   }
   state.fragments++;
  }
  put.run(tile.z,tile.x,tile.y,compressed);state.tiles++;
 }
 assert.equal(state.fragments,build.fragments);assert.deepEqual([...positive].sort(),build.completed.map(r=>r.component).sort());
 packed.exec('COMMIT');assert.equal(packed.prepare('PRAGMA quick_check').get().quick_check,'ok');
 state.coverage={path:coveragePath,sha256:coverageHash.digest('hex'),bytes:state.coverageBytes,fragments:state.coverageFragments,crs:'EPSG:3857',triangulated:true};
 state.status='encoded-needs-coverage';
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{closeSync(handle);db.close();packed.close();if(state.status==='encoded-needs-coverage')state.outputDatabaseSha256=await capturedSha256(nativePath);await save();console.log(JSON.stringify(state));}
