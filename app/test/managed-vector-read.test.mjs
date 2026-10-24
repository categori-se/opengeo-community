import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {loadManagedVectorData} from '../src/lib/managedVectorRead.js';
import {buildingReconciliationGroups,buildReviewedBuildingInventory} from '../src/lib/buildingReconciliation.js';
import {buildingReviewComparison,buildingReviewerId} from './fixtures/building-review.js';

const datasetId='306184fa-dff5-4ada-8066-4470713caa4a',versionId='f3491ac3-ac25-46b4-8209-0a7787f9fde4';
function fixture() {
  const geojson={type:'FeatureCollection',features:Array.from({length:5001},(_,id)=>({type:'Feature',id,properties:{name:`Feature ${id}`},geometry:{type:'Point',coordinates:[89+id/100000,27,0]}}))};
  const bytes=Buffer.from(JSON.stringify(geojson)),sha=createHash('sha256').update(bytes).digest('hex');
  const version={id:versionId,state:'active',featureCount:5001,crs:'EPSG:4326',geometryType:'Point',objects:[{id:'object-id',role:'original',filename:'source.geojson',contentType:'application/geo+json',sizeBytes:bytes.length,checksumSha256:sha}]};
  const calls={tickets:0,reads:0,previews:0,authorize:0};
  const adapter={async listDatasetVersions(){return [version];},async requestDatasetDownload(_p,d,v,o){assert.equal(d,datasetId);assert.equal(v,versionId);assert.equal(o,'object-id');calls.tickets++;return {method:'GET',url:`https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/datasets/${datasetId}/original/source.geojson?versionId=exact&X-Amz-Signature=test`,expiresAt:new Date(Date.now()+60000).toISOString()};},async getDatasetSpatialPreview(){calls.previews++;return {mayBeTruncated:true};}};
  const options={adapter,projectId:'project',datasetId,versionId,geometryType:'Point',authorize:async()=>{calls.authorize++;},fetchImpl:async(_url,request)=>{calls.reads++;assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');return new Response(bytes);}};
  return {geojson,bytes,version,calls,options};
}
test('explicit map read verifies every feature of the exact private original above the preview limit',async()=>{
 const f=fixture(),result=await loadManagedVectorData(f.options);
 assert.equal(result.numberReturned,5001);assert.equal(result.mayBeTruncated,false);assert.deepEqual(result.geojson,f.geojson);
 assert.deepEqual(f.calls,{tickets:1,reads:1,previews:0,authorize:2});
});

test('managed review originals render selected geometry without adding audit metadata reads or exposing the archive receipt as map data',async()=>{
 const native=buildingReviewComparison(),decisions=buildingReconciliationGroups(native).map(group=>({componentId:group.id,
  selectedFeatureIds:group.features.filter(feature=>feature.properties.input.side==='source').map(feature=>feature.id),reason:'Prefer source geometry for this reviewed selection.'}));
 const reviewed=buildReviewedBuildingInventory({collection:native,decisions,reviewerId:buildingReviewerId,timestamp:'2026-10-23T12:00:00Z'});
 const original={type:'FeatureCollection',features:reviewed.features,properties:{'opengeo:analysis':reviewed['opengeo:analysis']}};
 const bytes=Buffer.from(JSON.stringify(original)),f=fixture();
 Object.assign(f.version,{featureCount:reviewed.features.length,geometryType:'Polygon'});f.options.geometryType='Polygon';
 Object.assign(f.version.objects[0],{sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});
 f.options.fetchImpl=async()=>{f.calls.reads++;return new Response(bytes);};
 const read=await loadManagedVectorData(f.options);
 assert.deepEqual(read.geojson,{type:'FeatureCollection',features:reviewed.features});
 assert.equal(read.geojson.properties,undefined);assert.equal(read.geojson['opengeo:analysis'],undefined);
 assert(read.geojson.features.every(feature=>feature.properties.reconciliation.review.reviewerId===buildingReviewerId));
 assert.deepEqual(f.calls,{tickets:1,reads:1,previews:0,authorize:2});
 assert.equal(JSON.parse(bytes).properties['opengeo:analysis'].buildingReview.decisions.length,2);
});
for(const kind of ['checksum','count','short','oversized','wrong-version','wrong-ticket','scope-change','download-denied'])test(`full private read rejects ${kind}`,async()=>{
 const f=fixture();
 if(kind==='checksum')f.version.objects[0].checksumSha256='0'.repeat(64);
 if(kind==='count')f.version.featureCount++;
 if(kind==='short')f.options.fetchImpl=async()=>new Response(f.bytes.subarray(0,-1));
 if(kind==='oversized')f.options.fetchImpl=async()=>new Response(Buffer.concat([f.bytes,Buffer.from('x')]));
 if(kind==='wrong-version')f.version.id='other-version';
 if(kind==='wrong-ticket')f.options.adapter.requestDatasetDownload=async()=>({method:'GET',url:'https://untrusted.example/source',expiresAt:new Date(Date.now()+60000).toISOString()});
 if(kind==='scope-change')f.options.authorize=async()=>{if(++f.calls.authorize===2)throw Error('Account changed');};
 if(kind==='download-denied')f.options.adapter.requestDatasetDownload=async()=>{throw Error('Download denied');};
 await assert.rejects(loadManagedVectorData(f.options));assert.equal(f.calls.previews,0);
});
test('refuses oversized objects before issuing a download ticket',async()=>{
 const f=fixture();f.version.objects[0].sizeBytes=64*1024**2+1;await assert.rejects(loadManagedVectorData(f.options),/tiled/);assert.equal(f.calls.tickets,0);
});
test('unsupported formats retain their bounded preview without downloading original data',async()=>{
 for(const change of [f=>{f.version.objects[0].filename='source.gpkg';}]){
  const f=fixture();change(f);assert.deepEqual(await loadManagedVectorData(f.options),{mayBeTruncated:true});assert.equal(f.calls.tickets,0);assert.equal(f.calls.reads,0);
 }
});
test('small Overpass GeoJSON reads exact original without the rejecting preview API',async()=>{
 const f=fixture();
 f.geojson.features=f.geojson.features.slice(0,2);
 f.geojson.features[0].properties['@relations']=[{role:'admin_centre',reltags:{name:'Kathmandu',admin_level:'8'}}];
 Object.assign(f.geojson,{generator:'overpass-ide',copyright:'OpenStreetMap contributors',timestamp:'2022-08-12T18:00:02Z'});
 const bytes=Buffer.from(JSON.stringify(f.geojson));
 f.version.featureCount=2;
 Object.assign(f.version.objects[0],{sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});
 f.options.adapter.getDatasetSpatialPreview=async()=>{throw Error('spatial_preview_invalid');};
 f.options.fetchImpl=async()=>{f.calls.reads++;return new Response(bytes);};
 const result=await loadManagedVectorData(f.options);
 assert.deepEqual(result.geojson,f.geojson);
 assert.equal(result.numberReturned,2);assert.equal(result.mayBeTruncated,false);
 assert.deepEqual(f.calls,{tickets:1,reads:1,previews:0,authorize:2});
});
for (const kind of ['nested-unsafe-key','nested-depth','nested-array-limit']) test(`managed nested properties reject ${kind}`,async()=>{
 const f=fixture();f.geojson.features=f.geojson.features.slice(0,1);f.version.featureCount=1;
 const value=kind==='nested-unsafe-key'?JSON.parse('{"safe":{"__proto__":{"bad":1}}}'):
   kind==='nested-array-limit'?Array(4097).fill(null):Array.from({length:10}).reduce(v=>({inner:v}),null);
 f.geojson.features[0].properties.relations=value;
 const bytes=Buffer.from(JSON.stringify(f.geojson));
 Object.assign(f.version.objects[0],{sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});
 f.options.fetchImpl=async()=>new Response(bytes);
 await assert.rejects(loadManagedVectorData(f.options),/property|properties/i);
});
test('a pinned historical version is resolved independently of the current version',async()=>{
 const f=fixture();f.options.adapter.listDatasetVersions=async(_p,_d,page)=>page.offset===0?Array.from({length:100},()=>({id:'other'})):[f.version];
 assert.equal((await loadManagedVectorData(f.options)).numberReturned,5001);
});

test('retains 3D WGS84 coordinates when GDAL reports EPSG:4979 and PointZ',async()=>{
 const f=fixture();f.version.crs='EPSG:4979';f.version.geometryType='PointZ';delete f.options.geometryType;
 const result=await loadManagedVectorData(f.options);assert.deepEqual(result.geojson.features[0].geometry.coordinates,f.geojson.features[0].geometry.coordinates);
});

test('managed captures retain count provenance and unknown metadata alongside exact geometry',async()=>{
 const f=fixture();f.geojson.features=f.geojson.features.slice(0,1);f.version.featureCount=1;
 f.geojson['opengeo:capture']={schemaVersion:'opengeo.feature-capture-counts.1.0.0',fetchedCount:1,numberMatched:2,limitedByMaximumFeatures:true,countStatus:'matched_bounded_scope',scope:{kind:'bounded_features',maximum_features:1},pages:[{reported:{numberMatched:2}}],countQuery:{reported:{count:2,providerExtension:{confidence:null}}}};
 const bytes=Buffer.from(JSON.stringify(f.geojson));Object.assign(f.version.objects[0],{sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});f.options.fetchImpl=async()=>new Response(bytes);
 const result=await loadManagedVectorData(f.options);assert.deepEqual(result.geojson,f.geojson);
 assert.equal(result.numberReturned,1);assert.equal(result.geojson['opengeo:capture'].limitedByMaximumFeatures,true);
});
for(const kind of ['wrong-count','unknown-schema','unsafe-key'])test(`managed capture metadata rejects ${kind}`,async()=>{
 const f=fixture();f.geojson.features=f.geojson.features.slice(0,1);f.version.featureCount=1;
 const capture={schemaVersion:'opengeo.feature-capture-counts.1.0.0',fetchedCount:1};
 if(kind==='wrong-count')capture.fetchedCount=2;
 if(kind==='unknown-schema')capture.schemaVersion='unknown';
 if(kind==='unsafe-key')capture.reported=JSON.parse('{"__proto__":{"bad":1}}');
 f.geojson['opengeo:capture']=capture;
 const bytes=Buffer.from(JSON.stringify(f.geojson));Object.assign(f.version.objects[0],{sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});f.options.fetchImpl=async()=>new Response(bytes);
 await assert.rejects(loadManagedVectorData(f.options),/capture|property/i);
});
