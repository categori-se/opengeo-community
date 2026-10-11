// Reuse the reviewed ordinary-detail capture and add only its three missing tiny polygons.
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
import {fromVectorTileJs,fromGeojsonVt} from '@maplibre/vt-pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {capturedSha256,streamCapturedFeatures} from './stream-captured-features.mjs';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';
import {fitOverviewPolygonHoles} from './overview-polygon-holes.mjs';

const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local-archives/bhutan-local-20260920');
const parent=resolve(work,'additional-nsdi-tiles/5a32194df52def5f');
const out=resolve(work,'additional-nsdi-tiles/5a32194df52def5f-mixed-detail');
assert.ok(!existsSync(out),'Inspect existing candidate instead of repeating');
const prior=JSON.parse(await readFile(resolve(parent,'receipt.json')));
const native=JSON.parse(await readFile(resolve(parent,'mvt-content-verification.json')));
const ids=[42060,52767,58190],fineIds=new Set(ids),fineFeatures=[];
assert.deepEqual(native.missingIdentitySample,ids);assert.equal(native.uniqueDecodedIds,60967);
assert.equal(native.propertyMismatches,0);assert.equal(native.unexpectedIds,0);
const source=resolve(JSON.parse(await readFile(resolve(work,'transfer-originals/restoration-manifest.json'))).sourceRoot,prior.original.path);
assert.equal(await capturedSha256(source),prior.original.sha256);
for await(const feature of streamCapturedFeatures(source))if(fineIds.has(feature.properties.fid))fineFeatures.push({...feature,id:feature.properties.fid});
assert.equal(fineFeatures.length,3);
const bytes=await readFile(resolve(parent,'display.pmtiles')),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(bytes),prior.outputSha256);assert.equal(native.outputSha256,prior.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'parent.pmtiles'))),header=await archive.getHeader(),metadata=await archive.getMetadata();
assert.equal(header.minZoom,7);assert.equal(header.maxZoom,14);assert.equal(header.tileCompression,2);
const layerZoomRanges={version:1,layers:[{source_layer:'data',min_zoom:7,max_zoom:14},{source_layer:'fine',min_zoom:14,max_zoom:20}]};
const review={...prior,status:'building',recipe:{...prior.recipe,maxZoom:20,maximumDecodedBytes:16*1024**2,buffer:160,engine:'mixed-detail preserved GDAL tiles and MapLibre 6.1.0'},
 layerZoomRanges,precisionGroups:[{source_layer:'fine',ids}],
 tileLayers:[{source_layer:'data',title:'Land cover',geometry_type:'MultiPolygon',feature_count:60967,geometry_method:'Quantized source polygons at detail zoom 14; display overzooms above 14. Original geometry remains preserved.'},
  {source_layer:'fine',title:'Small land-cover polygons',geometry_type:'Polygon',feature_count:3,geometry_method:'Three source polygons requiring finer quantization; full geometry retained at detail zoom 20 with no invented locations.'}],
 parentDisplay:{sha256:prior.outputSha256,verifiedSpatialIds:60967,missingIds:ids},networkRequests:0,s3Requests:0,uploads:0,
 limits:'One version-linked display with independent per-layer detail zooms. Requires the updated Studio reader and complete native, geometry and actual renderer review before admission.'};
for(const key of ['missingIds','propertyMismatches','unknownIds','uniqueDecodedIds','decodedFragments','elapsedSeconds','outputBytes','outputSha256'])delete review[key];
await mkdir(out);const started=Date.now();
const stats={status:'building',copiedTiles:0,fineTiles:0,removedCoarseDuplicates:0,overviewHolesRemoved:0,maximumDecodedTileBytes:0,maximumCompressedTileBytes:0,maximumRings:0};
const save=async()=>{stats.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'mixed-detail-build.json'),JSON.stringify(stats,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
let db;
try{
 await save();db=new DatabaseSync(resolve(out,'display.mbtiles'));
 db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
 const fields=metadata.vector_layers.find(x=>x.id==='data').fields;
 const meta={...metadata,name:'Bhutan land cover 2020',minzoom:'7',maxzoom:'20',
  vector_layers:[{id:'data',fields,minzoom:7,maxzoom:14},{id:'fine',fields,minzoom:14,maxzoom:20}],opengeo_layer_zoom_ranges:layerZoomRanges};
 delete meta.tilestats; // The parent's one-layer statistics do not describe the new archive.
 const putMeta=db.prepare('INSERT INTO metadata VALUES(?,?)');
 for(const [k,v]of Object.entries({name:'Bhutan land cover 2020',format:'pbf',type:'overlay',version:'1.3',minzoom:'7',maxzoom:'20',bounds:[header.minLon,header.minLat,header.maxLon,header.maxLat].join(','),json:JSON.stringify(meta)}))putMeta.run(k,v);
 const put=db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');db.exec('BEGIN');
 function checkTile(tileBytes){
  const decoded=gunzipSync(tileBytes);stats.maximumDecodedTileBytes=Math.max(stats.maximumDecodedTileBytes,decoded.length);stats.maximumCompressedTileBytes=Math.max(stats.maximumCompressedTileBytes,tileBytes.length);
  assert.ok(decoded.length<=16*1024**2&&tileBytes.length<=8*1024**2,'Actual reader tile budget');
  const tile=new VectorTile(new Pbf(new Uint8Array(decoded)));
  for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);assert.equal(f.type,3);const g=f.loadGeometry(),all=classifyRings(g,0),limited=classifyRings(g,500);
   assert.equal(all.reduce((n,p)=>n+p.length,0),limited.reduce((n,p)=>n+p.length,0),'Renderer ring limit');
   for(const p of all)stats.maximumRings=Math.max(stats.maximumRings,p.length);
  }
 }
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
   if(entry.runLength===0){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
   for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
    assert.ok(Date.now()-started<600000,'Local conversion deadline');
    const [z,x,y]=tileIdToZxy(id);let tileBytes=bytes.subarray(header.tileDataOffset+entry.offset,header.tileDataOffset+entry.offset+entry.length);
    const tile=new VectorTile(new Pbf(new Uint8Array(gunzipSync(tileBytes))));assert.deepEqual(Object.keys(tile.layers),['data']);
    const layer=tile.layers.data,features=[];let changed=false;
    for(let i=0;i<layer.length;i++){
     const f=layer.feature(i);if(fineIds.has(f.properties.fid)){stats.removedCoarseDuplicates++;changed=true;continue;}
     if(z<14){const fitted=fitOverviewPolygonHoles(f,{zoom:z,fullDetailZoom:14});stats.overviewHolesRemoved+=fitted.omittedNonzeroRings;changed ||= fitted.omittedNonzeroRings>0||fitted.zeroAreaRings>0;features.push(fitted.feature);}
     else features.push(f);
    }
    if(changed)tileBytes=gzipSync(fromVectorTileJs({layers:{data:{name:'data',version:2,extent:layer.extent,length:features.length,feature:i=>features[i]}}}));
    checkTile(tileBytes);put.run(z,x,2**z-1-y,tileBytes);stats.copiedTiles++;
   }
  }
 }
 await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 const positive=new Set();
 await visitGeojsonTiles({type:'FeatureCollection',features:fineFeatures},{minZoom:14,maxZoom:20},async(tile,{z,x,y})=>{
  const features=tile.features.filter(f=>f.geometry.some(r=>r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0)!==0));
  if(!features.length)return;
  // These three polygons have no positive area at zoom 14, so no base tile collision.
  assert.ok(z>14);const tileBytes=gzipSync(fromGeojsonVt({fine:{...tile,features}},{extent:8192,version:2}));
  checkTile(tileBytes);put.run(z,x,2**z-1-y,tileBytes);stats.fineTiles++;
  if(z===20)for(const f of features)positive.add(f.tags.fid);
 });
 assert.deepEqual([...positive].sort((a,b)=>a-b),ids);stats.finePositiveAreaIds=ids;
 db.exec('COMMIT');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
 await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:120000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
 review.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;review.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));review.status='built-needs-content-verification';stats.status='built-needs-review';
 await writeFile(resolve(out,'fine-source-features.json'),JSON.stringify({sourceSha256:prior.original.sha256,features:fineFeatures})+'\n');
}catch(error){stats.status='stopped-needs-review';stats.error=String(error);review.status='stopped-needs-review';throw error;}
finally{db?.close();await save();console.log(JSON.stringify(stats));}
