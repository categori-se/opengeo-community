// Merge complete staged batches without changing native geometry or attributes.
// This creates an ordinary-detail parent, never an admitted Layer.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,statfs,stat} from 'node:fs/promises';
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
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import {capturedSha256} from './stream-captured-features.mjs';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/conversion-batches');
const detailOnly=process.argv.includes('--reuse-staged-detail');
const minZoom=detailOnly?12:7;
const stagedDirectory=resolve(base,'../../../additional-nsdi-tiles/7d7f0e0fa036251c-batched');
const out=detailOnly?`${stagedDirectory}-detail`:stagedDirectory;
assert.ok(!existsSync(out),'Inspect retained output before any repeat');
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifestBytes=await readFile(resolve(base,'receipt.json')),manifest=JSON.parse(manifestBytes);
assert.equal(manifest.status,'complete-staged-display-input');assert.equal(manifest.features,690239);
assert.equal(manifest.batches.reduce((n,b)=>n+b.features,0),manifest.features);
const sourceInfo=JSON.parse(await readFile(resolve(base,'../input.json')));
assert.equal(sourceInfo.original.sha256,manifest.sourceSha256);assert.equal(sourceInfo.sourceFeatures,manifest.features);
const profileBytes=await readFile(resolve(base,'../complete-precision-profile.json')),profile=JSON.parse(profileBytes);
assert.equal(profile.sourceSha256,manifest.sourceSha256);assert.equal(profile.status,'complete-quantization-profile');
// Validate all receipts before creating output or doing expensive work.
const builds=[];
for(let index=0;index<manifest.batches.length;index++){
 const dir=resolve(base,`converted-${String(index).padStart(4,'0')}`),build=JSON.parse(await readFile(resolve(dir,'receipt.json'))),native=JSON.parse(await readFile(resolve(dir,'native-review.json')));
 assert.equal(build.status,'converted');assert.equal(native.status,'passed');
 assert.equal(build.binding.manifestSha256,sha(manifestBytes));assert.equal(build.binding.inputSha256,manifest.batches[index].sha256);
 assert.equal(native.inputSha256,build.binding.inputSha256);assert.equal(native.outputSha256,build.outputSha256);
 assert.equal(native.sourceFeatures,manifest.batches[index].features);
 builds.push({dir,build});
}
const started=Date.now(),limits={wallSeconds:1200,freeDiskBytes:8*1024**3,maximumStagedBytes:3*1024**3,maximumDecodedTileBytes:16*1024**2,maximumCompressedTileBytes:8*1024**2};
async function guard(){assert.ok(Date.now()-started<limits.wallSeconds*1000,'Merge time bound');const disk=await statfs(base);assert.ok(disk.bavail*disk.bsize>limits.freeDiskBytes,'Merge free disk floor');}
await guard();await mkdir(out);
const state={status:'merging',manifestSha256:sha(manifestBytes),sourceSha256:manifest.sourceSha256,topologyReviewSha256:manifest.topologyReviewSha256,inputs:[],stagedTiles:0,stagedBytes:0,mergedTiles:0,roundTrippedFragments:0,maximumDecodedBytes:0,maximumCompressedBytes:0,limits,networkRequests:0,scope:'Complete ordinary-detail merge. Fine part/hole repair, final native checks and browser acceptance remain required; not catalog admission.'};
const save=async()=>{state.seconds=(Date.now()-started)/1000;await writeFile(resolve(out,'merge-receipt.json'),JSON.stringify(state,null,2)+'\n');};
let db,stagedDb;
try{
 db=new DatabaseSync(resolve(out,'display.mbtiles'));
 db.exec('CREATE TABLE chunks(tile_id INTEGER,batch INTEGER,payload BLOB,PRIMARY KEY(tile_id,batch)); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row)); CREATE TABLE metadata(name TEXT,value TEXT);');
 if(detailOnly){
  const retained=JSON.parse(await readFile(resolve(stagedDirectory,'merge-receipt.json')));
  assert.equal(retained.manifestSha256,sha(manifestBytes));
  assert.deepEqual(retained.inputs,builds.map(({build})=>build.outputSha256));
  stagedDb=new DatabaseSync(resolve(stagedDirectory,'display.mbtiles'),{readOnly:true});
  assert.equal(stagedDb.prepare('SELECT COUNT(*) AS count FROM chunks').get().count,retained.stagedTiles);
  state.reusedStagedSha256=await capturedSha256(resolve(stagedDirectory,'display.mbtiles'));
  state.stagedTiles=retained.stagedTiles;state.stagedBytes=retained.stagedBytes;
 }
 const putChunk=db.prepare('INSERT INTO chunks VALUES(?,?,?)');let fields;const bounds=[180,90,-180,-90];
 for(let index=0;index<builds.length;index++){
  await guard();const {dir,build}=builds[index],bytes=await readFile(resolve(dir,'display.pmtiles'));assert.equal(sha(bytes),build.outputSha256);
  const archive=new PMTiles(new FileSource(new File([bytes],'batch.pmtiles'))),header=await archive.getHeader(),metadata=await archive.getMetadata();
  assert.equal(header.minZoom,7);assert.equal(header.maxZoom,14);assert.equal(header.tileCompression,2);
  assert.equal(metadata.vector_layers.length,1);assert.equal(metadata.vector_layers[0].id,'data');
  if(fields)assert.deepEqual(metadata.vector_layers[0].fields,fields);else fields=metadata.vector_layers[0].fields;
  bounds[0]=Math.min(bounds[0],header.minLon);bounds[1]=Math.min(bounds[1],header.minLat);bounds[2]=Math.max(bounds[2],header.maxLon);bounds[3]=Math.max(bounds[3],header.maxLat);
  async function walk(offset,length,depth=0){
   assert.ok(depth<=3);await guard();
   for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
    if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
    const payload=bytes.subarray(header.tileDataOffset+entry.offset,header.tileDataOffset+entry.offset+entry.length);assert.equal(payload.length,entry.length);
    for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
     state.stagedBytes+=payload.length;assert.ok(state.stagedBytes<=limits.maximumStagedBytes);
     putChunk.run(id,index,payload);state.stagedTiles++;
    }
   }
  }
  if(!detailOnly){db.exec('BEGIN');await walk(header.rootDirectoryOffset,header.rootDirectoryLength);db.exec('COMMIT');}
  state.inputs.push(build.outputSha256);await save();
 }
 const chunkSource=stagedDb??db;
 const putTile=db.prepare('INSERT INTO tiles VALUES(?,?,?,?)'),chunks=chunkSource.prepare('SELECT payload FROM chunks WHERE tile_id=? ORDER BY batch');
 for(const {tile_id:id} of chunkSource.prepare('SELECT DISTINCT tile_id FROM chunks ORDER BY tile_id').iterate()){
  if(tileIdToZxy(id)[0]<minZoom)continue;
  if(state.mergedTiles%100===0)await guard();
  const features=[],identities=new Set(),nativeIds=new Set();let extent;
  for(const row of chunks.iterate(id)){
   const tile=new VectorTile(new Pbf(new Uint8Array(gunzipSync(row.payload))));assert.deepEqual(Object.keys(tile.layers),['data']);const layer=tile.layers.data;
   if(extent!==undefined)assert.equal(extent,layer.extent);extent=layer.extent;
   for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);assert.equal(f.type,3);assert.ok(Number.isSafeInteger(f.properties.fid)&&!identities.has(f.properties.fid));identities.add(f.properties.fid);
    if(f.id!==undefined){assert.ok(!nativeIds.has(f.id),'Native ID collision');nativeIds.add(f.id);}features.push(f);
   }
  }
  const packed=fromVectorTileJs({layers:{data:{name:'data',version:2,extent,length:features.length,feature:i=>features[i]}}}),compressed=gzipSync(packed);
  state.maximumDecodedBytes=Math.max(state.maximumDecodedBytes,packed.length);state.maximumCompressedBytes=Math.max(state.maximumCompressedBytes,compressed.length);
  assert.ok(packed.length<=limits.maximumDecodedTileBytes&&compressed.length<=limits.maximumCompressedTileBytes,`Merged tile exceeds reader budget: ${tileIdToZxy(id)}`);
  const decoded=new VectorTile(new Pbf(packed)).layers.data;assert.equal(decoded.length,features.length);assert.equal(decoded.extent,extent);
  for(let i=0;i<features.length;i++){
   const before=features[i],after=decoded.feature(i);assert.equal(after.id,before.id);assert.equal(after.type,before.type);assert.deepEqual(after.properties,before.properties);assert.deepEqual(after.loadGeometry(),before.loadGeometry());state.roundTrippedFragments++;
  }
  const [z,x,y]=tileIdToZxy(id);putTile.run(z,x,2**z-1-y,compressed);state.mergedTiles++;
 }
 const metadata={name:'Bhutan land cover 2010 — ordinary detail',format:'pbf',type:'overlay',version:'1.3',minzoom:String(minZoom),maxzoom:'14',bounds:bounds.join(','),center:[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2,minZoom].join(','),json:JSON.stringify({vector_layers:[{id:'data',fields,minzoom:minZoom,maxzoom:14}]})};
 const putMeta=db.prepare('INSERT INTO metadata VALUES(?,?)');for(const [key,value] of Object.entries(metadata))putMeta.run(key,value);
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.exec('DROP TABLE chunks');db.close();db=null;
 await guard();await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:120000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF',GDAL_NUM_THREADS:'2'}});
 state.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;state.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));state.status='merged-needs-final-native-and-geometry-review';
 await writeFile(resolve(out,'complete-precision-profile.json'),profileBytes);
 await writeFile(resolve(out,'receipt.json'),JSON.stringify({...sourceInfo,status:'ordinary-detail-built-needs-complete-mixed-display',geometryType:'MultiPolygon',originalSourceFeatures:manifest.features,nonSpatialRecords:0,outputBytes:state.outputBytes,outputSha256:state.outputSha256,topologyReviewSha256:manifest.topologyReviewSha256,stagingManifestSha256:state.manifestSha256,recipe:{minZoom,maxZoom:14,extent:8192,simplification:0,engine:'Exact native GDAL batch merge'},networkRequests:0,scope:state.scope},null,2)+'\n');
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{if(stagedDb)stagedDb.close();if(db)db.close();await save();console.log(JSON.stringify(state));}
