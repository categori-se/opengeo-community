// Reuse every ordinary tile and add the eight complete missing records at fine zooms.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';
const root=resolve('..'),base=resolve(root,'.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-large-20260922');
const parent=resolve(base,'gis_osm_landuse_a_free_1-tiles'),out=resolve(base,'gis_osm_landuse_a_free_1-mixed-tiles');
assert.ok(!existsSync(out),'Inspect retained work first');
const build=JSON.parse(await readFile(resolve(parent,'receipt.json'))),native=JSON.parse(await readFile(resolve(parent,'native-review.json')));
const profile=JSON.parse(await readFile(resolve(base,'gis_osm_landuse_a_free_1-precision.json')));
assert.equal(profile.sourceSha256,build.source.sha256);assert.equal(native.outputSha256,build.outputSha256);
for(const key of ['propertyMismatches','unexpectedIds','missingNativeIds','oversizedTiles'])assert.equal(native[key],0);
assert.equal(native.missingIds,native.missingIdentitySample.length);
const ids=[...new Set([...native.missingIdentitySample,...profile.recordsWithAnyCollapsedExteriorIdsByZoom['14']])].sort((a,b)=>a-b);
assert.equal(ids.length,8);assert.equal(profile.recordsWithAnyCollapsedExteriorIdsByZoom['20'].length,0);
const source=resolve(root,build.source.path);assert.equal(await capturedSha256(source),build.source.sha256);
const wanted=new Set(ids),features=[];
for await(const f of streamCapturedFeatures(source))if(wanted.has(f.id))features.push(f);
assert.deepEqual(features.map(f=>f.id).sort((a,b)=>a-b),ids);
const bytes=await readFile(resolve(parent,'display.pmtiles'));assert.equal(createHash('sha256').update(bytes).digest('hex'),build.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader(),metadata=await archive.getMetadata();
assert.equal(header.tileCompression,2);
const ranges={version:1,layers:[{source_layer:'data',min_zoom:7,max_zoom:14},{source_layer:'fine',min_zoom:15,max_zoom:20}]};
await mkdir(out);await writeFile(resolve(out,'fine-source-features.json'),JSON.stringify({sourceSha256:build.source.sha256,features})+'\n');
const receipt={status:'building',source:build.source,recipe:{...build.recipe,maxZoom:20},parentSha256:build.outputSha256,fineIds:ids,layerZoomRanges:ranges,copiedTiles:0,fineTiles:0,maximumDecodedBytes:0,networkRequests:0,s3Requests:0,scope:'Ordinary payloads preserved; full eight records added at fine detail. Final native, geometry and renderer acceptance remain separate.'};
const started=Date.now();let db;
const save=async()=>{receipt.seconds=(Date.now()-started)/1000;await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');};
try{
 await save();db=new DatabaseSync(resolve(out,'display.mbtiles'));
 db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
 const fields=metadata.vector_layers.find(x=>x.id==='data').fields;
 const meta={...metadata,name:'Nepal land use · Geofabrik / OSM 2020',minzoom:'7',maxzoom:'20',vector_layers:[{id:'data',fields,minzoom:7,maxzoom:14},{id:'fine',fields,minzoom:15,maxzoom:20}],opengeo_layer_zoom_ranges:ranges};delete meta.tilestats;
 const putMeta=db.prepare('INSERT INTO metadata VALUES(?,?)');
 for(const [k,v]of Object.entries({name:meta.name,format:'pbf',type:'overlay',version:'1.3',minzoom:'7',maxzoom:'20',bounds:[header.minLon,header.minLat,header.maxLon,header.maxLat].join(','),json:JSON.stringify(meta)}))putMeta.run(k,v);
 const put=db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');db.exec('BEGIN');
 function check(body){
  const decoded=gunzipSync(body);receipt.maximumDecodedBytes=Math.max(receipt.maximumDecodedBytes,decoded.length);assert.ok(decoded.length<=16*1024**2&&body.length<=8*1024**2);
  const tile=new VectorTile(new Pbf(new Uint8Array(decoded)));
  for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
   const g=layer.feature(i).loadGeometry();assert.equal(classifyRings(g,0).reduce((n,p)=>n+p.length,0),classifyRings(g,500).reduce((n,p)=>n+p.length,0),'Renderer ring limit');
  }
 }
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3&&Date.now()-started<600000);
  for(const e of await archive.cache.getDirectory(archive.source,offset,length,header)){
   if(!e.runLength){await walk(header.leafDirectoryOffset+e.offset,e.length,depth+1);continue;}
   for(let id=e.tileId;id<e.tileId+e.runLength;id++){
    const [z,x,y]=tileIdToZxy(id),body=bytes.subarray(header.tileDataOffset+e.offset,header.tileDataOffset+e.offset+e.length);
    check(body);put.run(z,x,2**z-1-y,body);receipt.copiedTiles++;
   }
  }
 }
 await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 const positive=new Set();
 await visitGeojsonTiles({type:'FeatureCollection',features},{minZoom:15,maxZoom:20},async(tile,{z,x,y})=>{
  assert.ok(Date.now()-started<600000&&receipt.fineTiles<10000);
  const features=tile.features.filter(f=>f.geometry.some(r=>r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0)!==0));
  if(!features.length)return;
  const body=gzipSync(fromGeojsonVt({fine:{...tile,features}},{extent:8192,version:2}));check(body);put.run(z,x,2**z-1-y,body);receipt.fineTiles++;
  if(z===20)for(const f of features)positive.add(f.id);
 });
 assert.deepEqual([...positive].sort((a,b)=>a-b),ids);
 db.exec('COMMIT');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
 await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:120000,maxBuffer:1048576,env:{...process.env,OPENBLAS_NUM_THREADS:'1',PROJ_NETWORK:'OFF'}});
 receipt.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;receipt.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));
 const packed=new PMTiles(new FileSource(new File([await readFile(resolve(out,'display.pmtiles'))],'display.pmtiles')));
 assert.equal((await packed.getHeader()).maxZoom,20);assert.deepEqual((await packed.getMetadata()).opengeo_layer_zoom_ranges,ranges);receipt.status='built-needs-content-verification';
}catch(error){receipt.status='failed';receipt.error=String(error);throw error;}
finally{db?.close();await save();console.log(JSON.stringify({...receipt,source:undefined}));}
