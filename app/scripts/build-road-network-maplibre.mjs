import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,statfs} from 'node:fs/promises';
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
const out=resolve(work,'additional-nsdi-tiles/3369a07b19f5ca01-maplibre-z21');
assert.ok(!existsSync(out),'Inspect retained work before repeating');
const previous=JSON.parse(await readFile(resolve(work,'additional-nsdi-tiles/3369a07b19f5ca01-z21/receipt.json')));
assert.equal(previous.status,'failed');assert.equal(previous.error,'Conversion wall deadline');
const probe=JSON.parse(await readFile(resolve(work,'road-maplibre-precision-probe.json')));
assert.equal(probe.status,'all-eight-shortest-lines-retained');
const manifest=JSON.parse(await readFile(resolve(work,'transfer-originals/restoration-manifest.json')));
const hash=b=>createHash('sha256').update(b).digest('hex');
const raw=await readFile(resolve(manifest.sourceRoot,previous.original.path));assert.equal(hash(raw),previous.original.sha256);
const collection=JSON.parse(raw);assert.equal(collection.features.length,18101);
const ids=new Set(),fields={},bounds=[Infinity,Infinity,-Infinity,-Infinity];let nulls=0;
for(const f of collection.features){
  const id=f.properties.fid;assert.ok(Number.isSafeInteger(id));
  if(f.geometry===null){nulls++;continue;}
  assert.equal(f.geometry.type,'LineString');assert.ok(!ids.has(id));ids.add(id);
  for(const [x,y] of f.geometry.coordinates){bounds[0]=Math.min(bounds[0],x);bounds[1]=Math.min(bounds[1],y);bounds[2]=Math.max(bounds[2],x);bounds[3]=Math.max(bounds[3],y);}
  for(const [key,value] of Object.entries(f.properties))if(value!==null){const type={string:'String',number:'Number',boolean:'Boolean'}[typeof value];assert.ok(type);assert.ok(fields[key]===undefined||fields[key]===type);fields[key]=type;}
}
assert.equal(ids.size,18092);assert.equal(nulls,9);
await mkdir(out);await writeFile(resolve(out,'short-line-probes.json'),await readFile(resolve(work,'additional-nsdi-tiles/3369a07b19f5ca01-z21/short-line-probes.json')));
const review={...previous,status:'building',recipe:{...previous.recipe,engine:'@maplibre/geojson-vt 6.1.0',buffer:160,seconds:1800,maximumTiles:4000000},
  changedMethod:'Depth-first MapLibre tiling with tolerance zero and a bounded tile cache; every original spatial ID must retain positive-length native geometry at zoom 21.',
  limits:'Original capture unchanged. Quantized, buffered tile display with no simplification. Full original ID/property and viewer checks required before admission. Nine unlocated original records remain preserved.'};
delete review.error;delete review.errorType;delete review.elapsedSeconds;
const state={status:'tiling',tiles:0,fragments:0,compressedTileBytes:0,byZoom:{},networkRequests:0,s3Requests:0,uploads:0};
const started=Date.now();let db;const positiveSeen=new Set();
const save=async()=>{state.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'maplibre-build.json'),JSON.stringify(state,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
const positive=f=>f.type===2&&f.geometry.some(line=>line.some((p,i)=>i>0&&(p[0]!==line[i-1][0]||p[1]!==line[i-1][1])));
await save();
try{
  db=new DatabaseSync(resolve(out,'display.mbtiles'));db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
  const putMeta=db.prepare('INSERT INTO metadata VALUES (?,?)');
  for(const [key,value] of Object.entries({name:'Road Network of Bhutan',format:'pbf',type:'overlay',version:'1.3',minzoom:'7',maxzoom:'21',bounds:bounds.join(','),center:[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2,7].join(','),json:JSON.stringify({vector_layers:[{id:'data',fields,minzoom:7,maxzoom:21}]})}))putMeta.run(key,value);
  const put=db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');db.exec('BEGIN');
  state.traversal=await visitGeojsonTiles(collection,{minZoom:7,maxZoom:21},async(tile,{z,x,y})=>{
    assert.ok((Date.now()-started)/1000<1800,'Conversion deadline');
    const features=tile.features.filter(positive);if(!features.length)return;
    assert.ok(features.length<=100000);
    const encoded=fromGeojsonVt({data:{...tile,features}},{extent:8192,version:2});
    const compressed=gzipSync(encoded);assert.ok(compressed.length<=8388608);
    put.run(z,x,2**z-1-y,compressed);state.tiles++;state.fragments+=features.length;state.compressedTileBytes+=compressed.length;state.byZoom[z]=(state.byZoom[z]??0)+1;
    assert.ok(state.tiles<=4000000&&state.compressedTileBytes<2*1024**3,'Output budget');
    if(z===21)for(const f of features){assert.ok(ids.has(f.tags.fid));positiveSeen.add(f.tags.fid);}
    if(state.tiles%5000===0){db.exec('COMMIT; BEGIN');const disk=await statfs(out);assert.ok(disk.bavail*disk.bsize>4*1024**3,'Disk floor');await save();}
  });
  db.exec('COMMIT');db.close();db=null;
  state.positiveLengthSpatialIdsAtMaxZoom=positiveSeen.size;state.missingPositiveLengthIds=[...ids].filter(id=>!positiveSeen.has(id));await save();
  assert.equal(positiveSeen.size,ids.size,'Some original spatial records collapsed; do not admit');
  state.status='packing';await save();
  await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
  const bytes=await readFile(resolve(out,'display.pmtiles'));assert.ok(bytes.length<2*1024**3);
  review.status='built-needs-content-verification';review.outputBytes=bytes.length;review.outputSha256=hash(bytes);review.positiveLengthSpatialIdsAtMaxZoom=positiveSeen.size;state.status='built-awaiting-native-and-viewer-checks';
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();await save();}
