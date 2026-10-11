// Two-record preparation trial. This directory is deliberately outside admission paths.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';

const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local-archives/bhutan-local-20260920');
const out=resolve(work,'soil-partitioned-maplibre-probe');assert.ok(!existsSync(out));
const hash=b=>createHash('sha256').update(b).digest('hex');
const partitionBytes=await readFile(resolve(work,'soil-complex-partition-reviewed/partition.json')),partition=JSON.parse(partitionBytes);
assert.equal(partition.status,'partitioned-awaiting-tiler-trial');
const input=await readFile(resolve(work,'soil-complex-partition-reviewed/partitioned.geojson'));assert.equal(hash(input),partition.outputSha256);
const collection=JSON.parse(input);assert.equal(collection.features.length,partition.fragmentFeatures);
const originalReview=JSON.parse(await readFile(resolve(work,'soil-complex-tiler-probe/receipt.json')));
const originalBytes=await readFile(originalReview.original.path);assert.equal(hash(originalBytes),originalReview.original.sha256);
const originals=JSON.parse(originalBytes).features,properties=new Map(originals.map(f=>[f.properties.fid,f.properties]));assert.equal(properties.size,2);
for(const f of collection.features){assert.deepEqual(f.properties,properties.get(f.properties.fid));assert.equal(f.geometry.type,'Polygon');}
await mkdir(out);
await writeFile(resolve(out,'tiny-polygon-probes.json'),await readFile(resolve(work,'soil-complex-tiler-probe/tiny-polygon-probes.json')));
const review={...originalReview,status:'building',recipe:{minZoom:7,maxZoom:14,extent:8192,buffer:160,simplification:0,engine:'@maplibre/geojson-vt 6.1.0',seconds:600},partitionReviewSha256:hash(partitionBytes),partitionInputSha256:partition.outputSha256,
 limits:'Two original logical records only, split into reviewed geometric fragments. Must never be admitted as the complete soil capture. Native property and local viewer checks do not establish complete geometric coverage; separate geometry review still required.'};
delete review.command;
const state={status:'tiling-reviewed-parts',tiles:0,fragments:0,networkRequests:0,s3Requests:0,uploads:0};
const started=Date.now();let db;
const save=async()=>{state.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'probe-service.json'),JSON.stringify(state,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
await save();
try{
  db=new DatabaseSync(resolve(out,'display.mbtiles'));db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
  const fields={};for(const f of originals)for(const [k,v] of Object.entries(f.properties))if(v!==null){fields[k]={string:'String',number:'Number',boolean:'Boolean'}[typeof v];assert.ok(fields[k]);}
  const putMeta=db.prepare('INSERT INTO metadata VALUES (?,?)');
  for(const [key,value] of Object.entries({name:'Two complex soil polygons: preparation trial',format:'pbf',type:'overlay',version:'1.3',minzoom:'7',maxzoom:'14',bounds:'88,26,93,29',center:'90.45,27.5,7',json:JSON.stringify({vector_layers:[{id:'data',fields,minzoom:7,maxzoom:14}]})}))putMeta.run(key,value);
  const put=db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');db.exec('BEGIN');
  state.traversal=await visitGeojsonTiles(collection,{minZoom:7,maxZoom:14},async(tile,{z,x,y})=>{
    assert.ok(Date.now()-started<600000);
    const features=tile.features.filter(f=>f.type===3&&f.geometry.some(ring=>{let a=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)a+=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];return a!==0;}));
    if(!features.length)return;assert.ok(features.length<=100000);
    const body=gzipSync(fromGeojsonVt({data:{...tile,features}},{extent:8192,version:2}));assert.ok(body.length<=8388608);
    put.run(z,x,2**z-1-y,body);state.tiles++;state.fragments+=features.length;
    if(state.tiles%1000===0){db.exec('COMMIT; BEGIN');await save();}
    assert.ok(state.tiles<=100000);
  });
  db.exec('COMMIT');db.close();db=null;state.status='packing';await save();
  const run=promisify(execFile);
  await run('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:120000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
  const bytes=await readFile(resolve(out,'display.pmtiles'));assert.ok(bytes.length<512*1024**2);
  review.status='built-needs-content-verification';review.outputBytes=bytes.length;review.outputSha256=hash(bytes);state.status='verifying-native-records';await save();
  for(const [script,log,timeout] of [['verify-bhutan-tile-properties.mjs','native-verification.log',300000],['check-bhutan-additional-tiles.mjs','browser-review.log',300000]]){
    const args=['--max-old-space-size=4096',resolve(root,'app/scripts',script),out];if(script.startsWith('verify'))args.push('--allow-omitted-null-properties');
    const result=await run(process.execPath,args,{cwd:resolve(root,'app'),timeout,maxBuffer:4*1024**2});await writeFile(resolve(out,log),result.stdout+result.stderr);
  }
  assert.equal(JSON.parse(await readFile(resolve(out,'browser-check.json'))).status,'passed');
  state.status='trial-native-and-viewer-passed-awaiting-geometry-review';
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();await save();}
