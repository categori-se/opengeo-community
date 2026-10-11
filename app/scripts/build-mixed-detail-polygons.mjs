// Combine reviewed ordinary-detail vectors with independently identified finer records.
// The legacy default is the 2016 polygon recipe; --lines selects the reviewed road recipe.
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
import {simplifyOverviewLine} from './overview-line-simplification.mjs';
import {fitOverviewPolygonHoles} from './overview-polygon-holes.mjs';
import {createTilePolygonPartitioner} from './partition-overlimit-tile-polygons.mjs';
import {loadReviewedPolygonSource} from './reviewed-polygon-source.mjs';

const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local-archives/bhutan-local-20260920');
const lines=process.argv.includes('--lines');
const polygonComponents=process.argv.includes('--polygon-components');
const topologyDirectory=process.argv.find(x=>x.startsWith('--reviewed-topology-directory='))?.slice('--reviewed-topology-directory='.length);
assert.ok(!topologyDirectory||polygonComponents);
const robustFineDirectory=process.argv.find(x=>x.startsWith('--robust-fine-directory='))?.slice('--robust-fine-directory='.length);
assert.ok(!robustFineDirectory||(polygonComponents&&topologyDirectory));
assert.ok(!polygonComponents||!lines);
const fineZoom=Number(process.argv.find(x=>x.startsWith('--fine-zoom='))?.slice('--fine-zoom='.length)??(lines?22:20));
assert.ok(Number.isInteger(fineZoom)&&fineZoom>=15&&fineZoom<=22);
assert.ok(lines||polygonComponents||fineZoom===20,'Other polygon evidence uses detail zoom 20');
const displayTitle=process.argv.find(x=>x.startsWith('--title='))?.slice('--title='.length)??(lines?'Reviewed source lines':'Bhutan land cover 2016');
assert.ok(displayTitle.trim()&&displayTitle.length<=200);
const componentReviewPath=process.argv.find(x=>x.startsWith('--component-review='))?.slice('--component-review='.length);
assert.ok(!componentReviewPath||lines||polygonComponents);
assert.ok(!polygonComponents||componentReviewPath,'Polygon component repair requires its complete inventory');
const componentReview=componentReviewPath?JSON.parse(await readFile(resolve(componentReviewPath))):null;
const precisionProbePath=process.argv.find(x=>x.startsWith('--precision-probe='))?.slice('--precision-probe='.length);
const overviewProbePath=process.argv.find(x=>x.startsWith('--overview-line-probe='))?.slice('--overview-line-probe='.length);
assert.ok(!overviewProbePath||lines);
const overviewProbeBytes=overviewProbePath?await readFile(resolve(overviewProbePath)):null;
const overviewProbe=overviewProbeBytes?JSON.parse(overviewProbeBytes):null;
const parent=resolve(process.argv[2]);
assert.ok(parent.startsWith(resolve(work,'additional-nsdi-tiles')+'/'));
const out=resolve(process.argv[3]);
assert.ok(out.startsWith(resolve(work,'additional-nsdi-tiles')+'/'));
assert.ok(!existsSync(out),'Inspect existing candidate instead of repeating');
const partitionCacheArg=process.argv.find(x=>x.startsWith('--partition-cache-directory='))?.slice('--partition-cache-directory='.length);
const partitionCacheDirectory=partitionCacheArg?resolve(partitionCacheArg):out;
assert.ok(!partitionCacheArg||(polygonComponents&&partitionCacheDirectory.startsWith(resolve(work,'additional-nsdi-tiles')+'/')));

const prior=JSON.parse(await readFile(resolve(parent,'receipt.json')));
const overviewTileIds=new Set();
if(overviewProbe){
 assert.equal(overviewProbe.status,'passed');assert.equal(overviewProbe.parentSha256,prior.outputSha256);
 assert.equal(overviewProbe.maximumDeviationPixels,0.5);assert.equal(overviewProbe.referencePixelSize,512);
 assert.ok(overviewProbe.results.length>0&&overviewProbe.results.length<=10);
 for(const item of overviewProbe.results){
  assert.ok(item.withinReaderLimits&&item.independentMaximumDeviationPixels<=0.5+1e-9);
  assert.equal(item.verifiedVertices,item.beforeVertices);assert.ok(item.z<14);
  assert.equal(tileIdToZxy(item.tileId).join(','),[item.z,item.x,item.y].join(','));
  overviewTileIds.add(item.tileId);
 }
 assert.equal(overviewTileIds.size,overviewProbe.results.length);
}
const native=JSON.parse(await readFile(resolve(parent,'mvt-content-verification.json')));
const profile=JSON.parse(await readFile(resolve(parent,'complete-precision-profile.json')));
assert.equal(profile.status,'complete-quantization-profile');
assert.equal(profile.sourceSha256,prior.original.sha256);
assert.equal(native.missingIds,native.missingIdentitySample.length,'Need the complete missing-ID inventory');
assert.equal(native.uniqueDecodedIds+native.missingIds,prior.sourceFeatures);
const missingByZoom=lines?profile.missingPositiveLengthIdsByZoom:profile.missingExteriorAreaIdsByZoom;
if(componentReview){
 assert.equal(componentReview.status,'source-component-loss-inventoried');
 assert.equal(componentReview.sourceSha256,prior.original.sha256);
 assert.equal(componentReview.sourceFeatures,prior.sourceFeatures);
 if(polygonComponents){
  assert.equal(componentReview.geometryType,'MultiPolygon');
  assert.deepEqual([...componentReview.remainingAffectedIds].sort((a,b)=>a-b),[...profile.recordsWithAnyCollapsedExteriorIdsByZoom['14']].sort((a,b)=>a-b));
 }
 assert.ok(componentReview.maximumRequiredZoom<=fineZoom);
}
const ids=[...new Set([...missingByZoom['14'],...native.missingIdentitySample,...(componentReview?.remainingAffectedIds??[])])].sort((a,b)=>a-b),fineIds=new Set(ids),fineFeatures=[];
assert.ok(ids.length>0&&ids.length<=1000);
const coarseCount=prior.sourceFeatures-ids.length;
assert.equal(native.propertyMismatches,0);assert.equal(native.unexpectedIds,0);
const source=resolve(JSON.parse(await readFile(resolve(work,'transfer-originals/restoration-manifest.json'))).sourceRoot,prior.original.path);
assert.equal(await capturedSha256(source),prior.original.sha256);
let retainedSourcePath=resolve(parent,'precision-source-features.json'),reviewedSource=null;
if(prior.topologyReviewSha256){
 assert.ok(polygonComponents&&topologyDirectory,'Reviewed ordinary geometry requires the matching fine-detail derivatives');
 reviewedSource=await loadReviewedPolygonSource(resolve(topologyDirectory),{sourceSha256:prior.original.sha256,topologyReviewSha256:prior.topologyReviewSha256,ids});
 retainedSourcePath=reviewedSource.path;
 fineFeatures.push(...reviewedSource.features.map(f=>({...f,id:f.properties.fid})));
}else assert.ok(!topologyDirectory,'Cannot mix reviewed fine input with an unbound ordinary parent');
if(!reviewedSource&&existsSync(retainedSourcePath)){
 const retained=JSON.parse(await readFile(retainedSourcePath));
 assert.equal(retained.originalSha256,prior.original.sha256);
 if(retained.features.length===ids.length&&retained.features.every(f=>fineIds.has(f.properties.fid)))fineFeatures.push(...retained.features.map(f=>({...f,id:f.properties.fid})));
}
if(!fineFeatures.length&&!reviewedSource)for await(const feature of streamCapturedFeatures(source))if(fineIds.has(feature.properties.fid))fineFeatures.push({...feature,id:feature.properties.fid});
assert.equal(fineFeatures.length,ids.length);
assert.equal(new Set(fineFeatures.map(f=>f.properties.fid)).size,ids.length);
let precisionProbeBytes=null;
if((lines&&fineZoom<22)||polygonComponents){
 assert.ok(componentReview&&precisionProbePath,'Component detail zoom requires complete native probe evidence');
 precisionProbeBytes=await readFile(resolve(precisionProbePath));
 const probe=JSON.parse(precisionProbeBytes);
 assert.equal(probe.status,'passed');assert.equal(probe.zoom,fineZoom);
 assert.equal(probe.sourceSha256,prior.original.sha256);assert.equal(probe.records,fineFeatures.length);
 assert.equal(probe.probeInputSha256,await capturedSha256(retainedSourcePath));
 if(reviewedSource)assert.equal(probe.topologyReviewSha256,reviewedSource.topologyReviewSha256);
 else assert.ok(!probe.topologyReviewSha256,'Reviewed probe cannot stand in for original geometry');
 if(polygonComponents){assert.equal(probe.geometryType,'Polygon');assert.equal(probe.rendererDroppedRings,0);}
 const parts=fineFeatures.reduce((n,f)=>n+(['LineString','Polygon'].includes(f.geometry.type)?1:f.geometry.coordinates.length),0);
 assert.equal(probe.components,parts);assert.equal(probe.positiveComponents,parts);assert.deepEqual(probe.missing,[]);
}
if(reviewedSource&&polygonComponents)assert.ok(robustFineDirectory,'Corrected polygon components require the reviewed robust clipping path');
let robustFine=null;
if(robustFineDirectory){
 assert.ok(reviewedSource&&fineZoom===19);
 const directory=resolve(robustFineDirectory),nativeBytes=await readFile(resolve(directory,'native-receipt.json')),nativeReview=JSON.parse(nativeBytes);
 assert.equal(nativeReview.status,'encoded-needs-coverage');
 assert.equal(nativeReview.probeInputSha256,reviewedSource.sha256);assert.equal(nativeReview.topologyReviewSha256,reviewedSource.topologyReviewSha256);
 const coverageBytes=await readFile(resolve(directory,'coverage/receipt.json')),coverage=JSON.parse(coverageBytes);
 assert.equal(coverage.status,'passed');assert.equal(coverage.triangulated,true);assert.equal(coverage.inputSha256,reviewedSource.sha256);
 assert.equal(coverage.decodedFragmentsSha256,nativeReview.coverage.sha256);assert.equal(coverage.results.length,nativeReview.components);
 assert.ok(coverage.results.every(r=>!r.missingBeyondTolerance&&!r.unexpectedBeyondTolerance));
 const path=resolve(directory,'native-tiles.sqlite');assert.equal(await capturedSha256(path),nativeReview.outputDatabaseSha256);
 robustFine={path,nativeReviewSha256:createHash('sha256').update(nativeBytes).digest('hex'),coverageSha256:createHash('sha256').update(coverageBytes).digest('hex'),outputDatabaseSha256:nativeReview.outputDatabaseSha256};
}
const bytes=await readFile(resolve(parent,'display.pmtiles')),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(bytes),prior.outputSha256);assert.equal(native.outputSha256,prior.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'parent.pmtiles'))),header=await archive.getHeader(),metadata=await archive.getMetadata();
const minZoom=prior.recipe.minZoom;
assert.ok([7,12].includes(minZoom),'Supported ordinary or paired-overview detail range');
assert.equal(header.minZoom,minZoom);assert.equal(header.maxZoom,14);assert.equal(header.tileCompression,2);
const layerZoomRanges={version:1,layers:[{source_layer:'data',min_zoom:minZoom,max_zoom:14},{source_layer:'fine',min_zoom:componentReview?minZoom:15,max_zoom:fineZoom}]};
const review={...prior,status:'building',recipe:{...prior.recipe,maxZoom:fineZoom,maximumDecodedBytes:16*1024**2,buffer:160,engine:'mixed-detail preserved GDAL tiles and MapLibre 6.1.0'},
 layerZoomRanges,precisionGroups:[{source_layer:'fine',ids}],
 tileLayers:[{source_layer:'data',title:'Land cover',geometry_type:'MultiPolygon',feature_count:coarseCount,geometry_method:'Quantized source polygons at detail zoom 14; display overzooms above 14. Original geometry remains preserved.'},
  {source_layer:'fine',title:'Small land-cover polygons',geometry_type:fineFeatures.every(f=>f.geometry.type==='Polygon')?'Polygon':'MultiPolygon',feature_count:ids.length,geometry_method:'Source records requiring finer quantization; individual polygons have positive area at detail zoom 20 with no invented locations. Original geometry and tiny components remain preserved separately.'}],
 parentDisplay:{sha256:prior.outputSha256,verifiedSpatialIds:native.uniqueDecodedIds,missingIds:ids},networkRequests:0,s3Requests:0,uploads:0,
 limits:'One version-linked display with independent per-layer detail zooms. Requires the updated Studio reader and complete native, geometry and actual renderer review before admission.'};
if(robustFine)review.robustFine={...robustFine,path:undefined};
if(reviewedSource)review.topologyDerivatives={reviewSha256:reviewedSource.topologyReviewSha256,inputSha256:reviewedSource.sha256,transformedIds:reviewedSource.transformedIds};
if(lines){
 assert.ok(fineFeatures.every(f=>['LineString','MultiLineString'].includes(f.geometry.type)));
 review.tileLayers=[{source_layer:'data',title:'Lines',geometry_type:'MultiLineString',feature_count:coarseCount,geometry_method:'Quantized source lines at detail zoom 14, overzoomed above 14. Original geometry remains preserved.'},
 {source_layer:'fine',title:'Short line segments',geometry_type:'MultiLineString',feature_count:ids.length,geometry_method:`Short source lines requiring finer quantization. Nonzero line length required at detail zoom ${fineZoom}. Original endpoints and attributes remain preserved.`}];
}
if(componentReview){
 review.componentRepair={reviewSha256:createHash('sha256').update(await readFile(resolve(componentReviewPath))).digest('hex'),ids:componentReview.remainingAffectedIds,method:`Move complete affected records to fine layer, retaining their existing overview fragments and generating source geometry through detail zoom ${fineZoom}.`};
 review.tileLayers[1].title=polygonComponents?'Polygons requiring fine detail':'Lines requiring fine detail';
 review.tileLayers[1].geometry_method=`Complete source records with small components; original overview fragments retained at zooms ${minZoom}–14 and source ${polygonComponents?'polygons':'lines'} quantized at zooms 15–${fineZoom}. Original geometry remains preserved.`;
 if(polygonComponents)review.componentRepair.geometryType='MultiPolygon';
}
if(overviewProbe){
 review.overviewLineGeneralization={probeSha256:createHash('sha256').update(overviewProbeBytes).digest('hex'),tileIds:[...overviewTileIds],maximumDeviationPixels:0.5,referencePixelSize:512,method:'RDP simplification of only the reviewed oversized overview tiles, retaining identities, properties, part membership and endpoints. Full-detail geometry unchanged.'};
 if(review.componentRepair)review.componentRepair.method+= ' The declared overview tiles use bounded line generalization.';
 review.tileLayers[1].geometry_method+= ' Declared overview tiles are generalized within half a pixel at 512-pixel resolution.';
}
if(precisionProbeBytes)review.precisionProbeSha256=createHash('sha256').update(precisionProbeBytes).digest('hex');
for(const key of ['missingIds','propertyMismatches','unknownIds','uniqueDecodedIds','decodedFragments','elapsedSeconds','outputBytes','outputSha256'])delete review[key];
await mkdir(out);const started=Date.now();
const stats={status:'building',copiedTiles:0,fineTiles:0,removedCoarseDuplicates:0,overviewHolesRemoved:0,generalizedOverviewTiles:0,maximumDecodedTileBytes:0,maximumCompressedTileBytes:0,maximumRings:0};
const save=async()=>{stats.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'mixed-detail-build.json'),JSON.stringify(stats,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
let db,partitioner;
try{
 if(polygonComponents){partitioner=await createTilePolygonPartitioner(partitionCacheDirectory);review.tilePolygonPartition=partitioner.stats;}
 await save();db=new DatabaseSync(resolve(out,'display.mbtiles'));
 db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
 const fields=metadata.vector_layers.find(x=>x.id==='data').fields;
 const title=displayTitle;
 const meta={...metadata,name:title,minzoom:String(minZoom),maxzoom:String(fineZoom),
  vector_layers:[{id:'data',fields,minzoom:minZoom,maxzoom:14},{id:'fine',fields,minzoom:componentReview?minZoom:15,maxzoom:fineZoom}],opengeo_layer_zoom_ranges:layerZoomRanges};
 delete meta.tilestats; // The parent's one-layer statistics do not describe the new archive.
 const putMeta=db.prepare('INSERT INTO metadata VALUES(?,?)');
 for(const [k,v]of Object.entries({name:title,format:'pbf',type:'overlay',version:'1.3',minzoom:String(minZoom),maxzoom:String(fineZoom),bounds:[header.minLon,header.minLat,header.maxLon,header.maxLat].join(','),center:[(header.minLon+header.maxLon)/2,(header.minLat+header.maxLat)/2,minZoom].join(','),json:JSON.stringify(meta)}))putMeta.run(k,v);
 const put=db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');db.exec('BEGIN');
 function checkTile(tileBytes){
  const decoded=gunzipSync(tileBytes);stats.maximumDecodedTileBytes=Math.max(stats.maximumDecodedTileBytes,decoded.length);stats.maximumCompressedTileBytes=Math.max(stats.maximumCompressedTileBytes,tileBytes.length);
  assert.ok(decoded.length<=16*1024**2&&tileBytes.length<=8*1024**2,'Actual reader tile budget');
  const tile=new VectorTile(new Pbf(new Uint8Array(decoded)));
  for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);assert.equal(f.type,lines?2:3);if(lines)continue;const g=f.loadGeometry(),all=classifyRings(g,0),limited=classifyRings(g,500);
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
    const layer=tile.layers.data,features=[],moved=[];let changed=false;
    for(let i=0;i<layer.length;i++){
     let f=layer.feature(i);
     if(overviewTileIds.has(id)){f=simplifyOverviewLine(f,{zoom:z,fullDetailZoom:14,tolerance:layer.extent/1024}).feature;changed=true;}
     const parts=partitioner?await partitioner.partition(f,{z,x,y}):[f];
     if(parts.length!==1||parts[0]!==f)changed=true;
     if(fineIds.has(f.properties.fid)){stats.removedCoarseDuplicates++;changed=true;if(componentReview)moved.push(...parts);continue;}
     if(partitioner){features.push(...parts);continue;}
     if(z<14&&!lines&&!componentReview){const fitted=fitOverviewPolygonHoles(f,{zoom:z,fullDetailZoom:14});stats.overviewHolesRemoved+=fitted.omittedNonzeroRings;changed ||= fitted.omittedNonzeroRings>0||fitted.zeroAreaRings>0;features.push(fitted.feature);}
     else features.push(f);
    }
    if(changed){
     const layers={data:{name:'data',version:2,extent:layer.extent,length:features.length,feature:i=>features[i]}};
     if(moved.length)layers.fine={name:'fine',version:2,extent:layer.extent,length:moved.length,feature:i=>moved[i]};
     tileBytes=gzipSync(fromVectorTileJs({layers}));
    }
    checkTile(tileBytes);put.run(z,x,2**z-1-y,tileBytes);stats.copiedTiles++;
    if(stats.copiedTiles%100===0)await save();
    if(overviewTileIds.has(id))stats.generalizedOverviewTiles++;
   }
  }
 }
 await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 assert.equal(stats.generalizedOverviewTiles,overviewTileIds.size);
 const positive=new Set();
 if(robustFine){
  const nativeDb=new DatabaseSync(robustFine.path,{readOnly:true});
  try{for(const tile of nativeDb.prepare('SELECT z,x,y,payload FROM tiles ORDER BY z,x,y').iterate()){
   assert.ok(tile.z>=15&&tile.z<=fineZoom&&Date.now()-started<600000);
   const payload=Buffer.from(tile.payload);checkTile(payload);
   const decoded=new VectorTile(new Pbf(new Uint8Array(gunzipSync(payload))));assert.deepEqual(Object.keys(decoded.layers),['fine']);
   const layer=decoded.layers.fine;
   for(let i=0;i<layer.length;i++){const f=layer.feature(i);assert.ok(fineIds.has(f.properties.fid));if(tile.z===fineZoom)positive.add(f.properties.fid);}
   put.run(tile.z,tile.x,2**tile.z-1-tile.y,payload);stats.fineTiles++;assert.ok(stats.fineTiles<=250000);
   if(stats.fineTiles%2000===0)await save();
  }}finally{nativeDb.close();}
 }else await visitGeojsonTiles({type:'FeatureCollection',features:fineFeatures},{minZoom:15,maxZoom:fineZoom},async(tile,{z,x,y})=>{
  assert.ok(Date.now()-started<600000,'Local conversion deadline');
  const features=tile.features.filter(f=>lines?f.geometry.some(r=>r.some((p,i)=>i>0&&(p[0]!==r[i-1][0]||p[1]!==r[i-1][1]))):f.geometry.some(r=>r.reduce((a,p,i)=>{const q=r[(i+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0)!==0));
  if(!features.length)return;
  // Fine tiles begin above the retained ordinary-detail range, avoiding collisions.
  assert.ok(z>14);const tileBytes=gzipSync(fromGeojsonVt({fine:{...tile,features}},{extent:8192,version:2}));
  checkTile(tileBytes);put.run(z,x,2**z-1-y,tileBytes);stats.fineTiles++;
  assert.ok(stats.fineTiles<=250000,'Fine tile count budget');
  if(z===fineZoom)for(const f of features)positive.add(f.tags.fid);
 });
 assert.deepEqual([...positive].sort((a,b)=>a-b),ids);stats[lines?'finePositiveLengthIds':'finePositiveAreaIds']=ids;
 db.exec('COMMIT');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
 await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:120000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
 review.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;review.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));
 const packed=new PMTiles(new FileSource(new File([await readFile(resolve(out,'display.pmtiles'))],'display.pmtiles')));
 const packedHeader=await packed.getHeader(),packedMetadata=await packed.getMetadata();
 assert.equal(packedHeader.minZoom,minZoom);assert.equal(packedHeader.maxZoom,fineZoom);
 assert.deepEqual(packedMetadata.opengeo_layer_zoom_ranges,layerZoomRanges);
 await writeFile(resolve(out,'header-range-review.json'),JSON.stringify({status:'passed',outputSha256:review.outputSha256,minZoom:packedHeader.minZoom,maxZoom:packedHeader.maxZoom,layerZoomRanges,repairRequired:false,scope:'Packed header and declared layer ranges match the conversion recipe; complete tile content is checked independently.'},null,2)+'\n');
 review.status='built-needs-content-verification';stats.status='built-needs-review';
 await writeFile(resolve(out,'fine-source-features.json'),JSON.stringify({sourceSha256:prior.original.sha256,features:fineFeatures})+'\n');
 if(componentReview){
  await writeFile(resolve(out,'fine-render-probes.json'),JSON.stringify(componentReview.components.map(c=>({id:c.id,componentIndex:c.componentIndex,coordinates:c.coordinates[0]})))+'\n');
  await writeFile(resolve(out,'collapsed-component-review.json'),await readFile(resolve(componentReviewPath)));
  await writeFile(resolve(out,'complete-precision-profile.json'),await readFile(resolve(parent,'complete-precision-profile.json')));
 }
 if(overviewProbeBytes)await writeFile(resolve(out,'overview-line-probe.json'),overviewProbeBytes);
 if(precisionProbeBytes)await writeFile(resolve(out,'precision-probe.json'),precisionProbeBytes);
}catch(error){stats.status='stopped-needs-review';stats.error=String(error);review.status='stopped-needs-review';throw error;}
finally{if(partitioner){if(stats.status==='built-needs-review')await partitioner.close();else await partitioner.abort();}db?.close();await save();console.log(JSON.stringify(stats));}
