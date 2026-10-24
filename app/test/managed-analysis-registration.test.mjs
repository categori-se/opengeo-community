import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {verifyReviewedArchiveBytes} from '../src/lib/archivedGeojson.js';
import {writeFileSync} from 'node:fs';
import {analysisKnowledge,createManagedAnalysisRegistration} from '../src/lib/managedAnalysisRegistration.js';
import {inventoryMappedFields,mappedFieldSourceEvidence} from '../src/lib/fieldInventory.js';
import {FTW_GLOBAL} from '../src/lib/publishedBaselineSources.js';
import {buildingReconciliationGroups,buildReviewedBuildingInventory} from '../src/lib/buildingReconciliation.js';
import {buildingReviewComparison,buildingReviewerId} from './fixtures/building-review.js';
import {canonicalJson} from '../src/lib/artifactCanonicalJson.js';
import {verifyBuildingReviewArchive} from '../src/lib/buildingReviewArchive.js';
import {buildReceptorScreening} from '../src/lib/receptorScreening.js';
import {verifyReceptorScreeningArchive} from '../src/lib/receptorScreeningArchive.js';
import {receptorScreeningFixture,receptorClip,receptorFeatureId} from './fixtures/receptor-screening.js';
import {computeRasterComparison,rasterComparisonGeoJson} from '../src/lib/rasterComparison.js';
import {computeRasterPatches,rasterPatchesGeoJson} from '../src/lib/rasterPatches.js';
import {computeRasterHeightDifference,rasterHeightDifferenceGeoJson} from '../src/lib/rasterHeightDifference.js';
import {verifyRasterAnalysisArchive} from '../src/lib/rasterAnalysisArchive.js';
import {createRasterValidationPlan,createRasterValidationAssessment,reviewRasterValidationCell,
 evaluateRasterValidationAssessment,rasterValidationGeoJson,rasterValidationReviewState} from '../src/lib/rasterValidation.js';
const source = '10000000-0000-4000-8000-000000000008';
const output = '80000000-0000-4000-8000-000000000001';
const version = '83000000-0000-4000-8000-000000000001';
const collection = {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[1,2]}}],
 'opengeo:analysis':{operation:'centroid',version:'1.0.0',sourceDatasetId:source,source_generation:3,targetDatasetId:null,persisted:false,crs:'CRS:84'}};
const review = {title:'Derived centers',description:'Planar centroids',license:null,attribution:null};
function fixture(expectedCollection=collection) {
 const calls={request:0,upload:0,complete:0,save:0};let current={version:0,document:{}},originalBytes;
 const adapter={
  async requestUpload(_project,metadata){calls.request++;assert.equal(metadata.classification,'restricted');return {dataset:{id:output},uploadId:version,expiresAt:'2099-01-01T00:00:00Z',upload:{}};},
  async uploadFile(_upload,file){
    calls.upload++;
    const bytes=new Uint8Array(await file.arrayBuffer());
    originalBytes=bytes;
    const checksum=createHash('sha256').update(bytes).digest('hex');
    const reopened=await verifyReviewedArchiveBytes(bytes,{sizeBytes:bytes.length,decodedSizeBytes:bytes.length,
      objectSha256:checksum,decodedSha256:checksum,contentEncoding:'identity',featureCount:expectedCollection.features.length,geometryType:expectedCollection.features[0].geometry.type},
      {allowNestedProperties:true,allowCaptureMetadata:true});
    assert.deepEqual(reopened,{type:'FeatureCollection',features:expectedCollection.features});
  },
  async completeUpload(){calls.complete++;return {dataset:{id:output},datasetVersionId:version,versionNumber:1};},
  async getDatasetKnowledge(){return current;},
  async saveDatasetKnowledge(id,draft){calls.save++;assert.equal(id,output);current={version:1,document:draft.document};throw Error('response lost');}
 };
 return {calls,adapter,get current(){return current;},get originalBytes(){return originalBytes;}};
}

async function rasterCollection(kind='rasterComparison',{evaluated=false,cells=4,unknownReference=false,estimated=false,
 validationReference=false,sourceTerms=null}={}) {
 const makeInput=(role,managed)=>{
  const width=cells,step=.000001;
  const grid={width,height:1,metadata:{bands:[1],imageIndex:0,projection:'EPSG:4326',interpretation:'area',
   window:[0,0,width,1],origin:[85,28,0],resolution:[step,-step,0],scaleX:1,scaleY:1,noData:null,
   source:{url:managed?null:`https://example.org/${role}.tif`,etag:unknownReference?null:`"${role}"`,size:unknownReference?null:4096,
    verified:!unknownReference,license:sourceTerms,attribution:sourceTerms??`Observed ${role} provider`}},active:()=>true,
   coordinate:(column,row)=>[85+column*step,28-row*step],value:()=>role==='after'?20:10};
  return {grid,band:1,categoricalConfirmed:true,crosswalk:{10:'Forest',20:'Other'},
   pins:managed?{layerId:`layer-${role}`,sourceType:'governed-dataset',datasetId:source,datasetVersionId:version,sourceVersion:7,objectId:output}
    :{layerId:`reference-${role}`,sourceType:'cog-raster'}};
 };
 const before=makeInput('before',!validationReference),after=makeInput('after',false);
 if(kind==='rasterHeightDifference'){
  const result=await computeRasterHeightDifference({surface:{...before,units:'metres',elevationConfirmed:true},
   terrain:{...after,units:'metres',elevationConfirmed:true},review:{confirmed:true,basis:'Illustrative compatible elevation sources; independent accuracy unknown.'},yieldControl:async()=>{}});
  const output=rasterHeightDifferenceGeoJson(result);before.grid.value=after.grid.value=()=>assert.fail('No elevation reads during registration.');return output;
 }
 if(kind==='rasterValidation'){
  const plan=await createRasterValidationPlan({input:before,seed:'fixed-reviewed-seed',samplesPerStratum:2,
   referenceClasses:['Forest','Other'],question:'Estimate class areas in this frozen cached window.',
   labelingProtocol:'Assign the whole cell from dated independent reference imagery; retain unresolved cells.',yieldControl:async()=>{}});
  let report=createRasterValidationAssessment(plan);
  const samples=rasterValidationReviewState(report).uniqueCells;
  const event=sample=>({cellId:sample.cellId,referenceClass:sample.stratum,reviewer:'Illustrative reviewer',
   evidence:'Independent dated imagery, revision 1; source quality is unverified.',basis:'Whole-cell dominant reference class.',reviewedAt:'2026-10-23T21:00:00Z'});
  report=reviewRasterValidationCell(report,{...event(samples[0]),referenceClass:null});
  if(estimated){
   for(const sample of samples)report=reviewRasterValidationCell(report,event(sample));
   report=await evaluateRasterValidationAssessment(report,{yieldControl:async()=>{}});
  }
  before.grid.value=after.grid.value=()=>assert.fail('Registration must not reread a validation raster.');
  return rasterValidationGeoJson(report);
 }
 const result=kind==='rasterComparison'?await computeRasterComparison({before,after,yieldControl:async()=>{},
  ...(evaluated?{referenceEvaluation:{reference:'before',basis:'Illustrative source comparison; independent accuracy remains unknown.'}}:{})})
  :await computeRasterPatches({input:before,group:'Forest',basis:'Observed cached window only.',connectivity:4,yieldControl:async()=>{}});
 before.grid.value=after.grid.value=()=>assert.fail('Registration must reuse exported data without source reads.');
 return kind==='rasterComparison'?rasterComparisonGeoJson(result):rasterPatchesGeoJson(result);
}

test('height cells use the restricted original archive and resume metadata readback without repeating committed writes',async()=>{
 const input=await rasterCollection('rasterHeightDifference'),expected=structuredClone(input),f=fixture(expected);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,
  review:{...review,title:'Illustrative height differences'},assertCurrentScope:async()=>{},now:()=> '2026-10-23T21:00:00Z'});
 input.features[0].properties.differenceMeters=999;
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=saved.knowledge.document,reference=doc.metadata.normalized[0].value.rasterHeightDifference;
 assert.equal(doc.metadata.normalized[0].method,'cached_raster_height_difference');
 assert.equal(reference.statistics.negativeCells,4);assert.equal(reference.method.accuracy,'not established');
 assert.equal(doc.context.length,2);assert(reference.audit.sha256);
 const verified=await verifyRasterAnalysisArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference});
 assert.deepEqual(verified.collection.features,expected.features);assert.deepEqual(verified.receipt,expected['opengeo:analysis']);
 assert(new TextEncoder().encode(JSON.stringify(doc)).byteLength<49152);
});

test('draft and estimated validation register immutable complete originals and bounded reviews, resuming committed writes once',async()=>{
 for(const estimated of [false,true]){
  const input=structuredClone(await rasterCollection('rasterValidation',{estimated})),expected=structuredClone(input),f=fixture(expected);
  const selectedReview={...review,title:'Reviewed validation sample'};
  const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review:selectedReview,
   assertCurrentScope:async()=>{},now:()=> '2026-10-23T21:00:00Z'});
  input.features[0].properties.reviewStatus='edited';input['opengeo:analysis'].rasterValidation.status='edited';selectedReview.title='Edited title';
  await assert.rejects(session.run(),/response lost/);const saved=await session.run();
  assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
  const doc=saved.knowledge.document,summary=doc.metadata.normalized[0].value.rasterValidation;
  assert.equal(doc.metadata.normalized[0].method,'cached_raster_validation');
  assert.equal(summary.status,estimated?'estimated':'awaiting-reference-review');
  assert.equal(summary.plan.samples,undefined);assert.equal(summary.reviews,undefined);assert.equal(summary.plan.input,undefined);
  assert.equal(summary.inputs.input.pins.datasetId,source);assert.equal(summary.inputs.input.pins.datasetVersionId,version);
  assert.equal(summary.inputs.input.pins.objectId,output);assert.equal(summary.inputs.input.pins.sourceVersion,7);
  assert.equal(doc.context[0].resourceId,`urn:opengeo:dataset:${source}:version:${version}`);
  assert(!doc.context.some(value=>value.resourceId.includes(':generation:')));
  assert.equal(summary.reviewCounts.events,expected['opengeo:analysis'].rasterValidation.reviews.length);
  assert.equal(summary.estimates===null,!estimated);assert.equal(summary.quality.classificationAccuracy,null);
  if(estimated)assert.deepEqual(summary.estimates.classAreas,expected['opengeo:analysis'].rasterValidation.estimates.classAreas);
  else assert.equal(summary.reviewCounts.unresolvedCells,1);
  assert.equal(summary.audit.distributionId,doc.distributions[0].id);
  assert.equal(summary.audit.jsonPointer,'/properties/opengeo:analysis/rasterValidation');
  assert.equal(summary.audit.sha256,createHash('sha256').update(canonicalJson(expected['opengeo:analysis'].rasterValidation)).digest('hex'));
  assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/title')).value,'Reviewed validation sample');
  assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/license')).provenance,'unknown');
  const archived=JSON.parse(new TextDecoder().decode(f.originalBytes));
  assert.deepEqual(archived.properties['opengeo:analysis'],expected['opengeo:analysis']);assert.equal(archived['opengeo:analysis'],undefined);
  const verified=await verifyRasterAnalysisArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference:summary});
  assert.deepEqual(verified.collection.features,expected.features);assert.deepEqual(verified.receipt,expected['opengeo:analysis']);
  assert(f.originalBytes.length<=2_200_000);assert(new TextEncoder().encode(JSON.stringify(doc)).byteLength<49_152);
 }
});

test('validation registration retains unknown observed reference facts and rejects incomplete or altered evidence before writes',async()=>{
 const input=await rasterCollection('rasterValidation',{validationReference:true,unknownReference:true}),f=fixture(input);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 const summary=saved.knowledge.document.metadata.normalized[0].value.rasterValidation;
 assert.equal(summary.inputs.input.pins.datasetId,null);assert.equal(summary.inputs.input.source.reference.etag,null);
 assert.equal(summary.inputs.input.source.reference.size,null);assert(summary.inputs.input.missingFacts.includes('datasetVersionId'));
 assert.equal(saved.knowledge.document.context[0].resourceId,'https://example.org/before.tif');
 const original=await rasterCollection('rasterValidation',{estimated:true});
 for(const mutate of [value=>{value.features.pop();},value=>{value.features[0].properties.sampleId='altered';},
  value=>{value.features[0].geometry.coordinates[0][1][0]+=.001;},
  value=>{value['opengeo:analysis'].rasterValidation.plan.input.pins.sourceVersion=0;},
  value=>{value['opengeo:analysis'].rasterValidation.estimates.classAreas[0].lower95SquareMeters++;},
  value=>{value['opengeo:analysis'].rasterValidation.reviews[0].sequence=2;}]){
  const changed=structuredClone(original);mutate(changed);const invalid=fixture(changed);
  assert.throws(()=>createManagedAnalysisRegistration({adapter:invalid.adapter,projectId:source,collection:changed,review,assertCurrentScope:async()=>{}}));
  assert.deepEqual(invalid.calls,{request:0,upload:0,complete:0,save:0});
 }
 const wrongIdentity=structuredClone(original);wrongIdentity['opengeo:analysis'].rasterValidation.plan.id='a'.repeat(64);
 const identityFixture=fixture(wrongIdentity);
 const identitySession=createManagedAnalysisRegistration({adapter:identityFixture.adapter,projectId:source,collection:wrongIdentity,review,assertCurrentScope:async()=>{}});
 await assert.rejects(identitySession.run(),/plan_checksum_invalid/);
 assert.deepEqual(identityFixture.calls,{request:0,upload:0,complete:0,save:0});
});

test('validation metadata preflight preserves the existing byte cap and upload checkpoints survive metadata retry or conflict',async()=>{
 const large=await rasterCollection('rasterValidation',{sourceTerms:'界'.repeat(4096)}),bounded=fixture(large);
 assert.throws(()=>createManagedAnalysisRegistration({adapter:bounded.adapter,projectId:source,collection:large,review,assertCurrentScope:async()=>{}}),/^Error: The metadata record exceeds 48 KiB\./);
 assert.deepEqual(bounded.calls,{request:0,upload:0,complete:0,save:0});
 const input=await rasterCollection('rasterValidation'),f=fixture(input);let draft;
 f.adapter.saveDatasetKnowledge=async(_id,value)=>{f.calls.save++;draft=value.document;if(f.calls.save===1)throw Error('metadata unavailable');return {version:1,document:draft};};
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(session.run(),/metadata unavailable/);assert.deepEqual((await session.run()).knowledge.document,draft);
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:2});
 const conflict=fixture(input);conflict.adapter.getDatasetKnowledge=async()=>({version:1,document:{existing:'retained'}});
 const pending=createManagedAnalysisRegistration({adapter:conflict.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(pending.run(),/Metadata changed/);await assert.rejects(pending.run(),/Metadata changed/);
 assert.deepEqual(conflict.calls,{request:1,upload:1,complete:1,save:0});
});

test('raster comparison 1.0/1.1 and patches register complete immutable originals and bounded exact-version/reference lineage, resuming committed writes once',async()=>{
 for(const [kind,evaluated] of [['rasterComparison',false],['rasterComparison',true],['rasterPatches',false]]){
  const input=await rasterCollection(kind,{evaluated}),expected=structuredClone(input),selectedReview={...review,title:'Reviewed raster cells'},f=fixture(expected);
  const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review:selectedReview,
   assertCurrentScope:async()=>{},now:()=> '2026-10-23T21:00:00Z'});
  input.features[0].properties.areaSquareMeters=1;input['opengeo:analysis'][kind].status='edited';selectedReview.title='Edited title';
  await assert.rejects(session.run(),/response lost/);const saved=await session.run();
  assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
  const doc=saved.knowledge.document,summary=doc.metadata.normalized[0].value[kind];
  assert.equal(doc.metadata.normalized[0].method,kind==='rasterComparison'?'cached_raster_comparison':'cached_raster_patches');
  assert.equal(doc.context[0].resourceId,`urn:opengeo:dataset:${source}:version:${version}`);
  assert.equal(summary.inputs[kind==='rasterComparison'?'before':'input'].pins.objectId,output);
  assert.equal(summary.inputs[kind==='rasterComparison'?'before':'input'].pins.sourceVersion,7);
  assert.equal(summary.inputs[kind==='rasterComparison'?'before':'input'].source.reference.url,null);
  if(kind==='rasterComparison')assert.equal(doc.context[1].resourceId,'https://example.org/after.tif');
  assert(!doc.context.some(value=>value.resourceId.includes(':generation:')));
  assert.equal(summary.transitions,undefined);assert.equal(summary.patches,undefined);
  if(evaluated){assert.equal(summary.referenceEvaluation.classes,undefined);assert.equal(summary.referenceEvaluation.confusion,undefined);}
  assert.equal(summary.audit.distributionId,doc.distributions[0].id);
  assert.equal(summary.audit.jsonPointer,`/properties/opengeo:analysis/${kind}`);
  assert.equal(summary.audit.sha256,createHash('sha256').update(canonicalJson(expected['opengeo:analysis'][kind])).digest('hex'));
  assert.equal(JSON.parse(doc.metadata.source[0].content)[kind].audit.sha256,summary.audit.sha256);
  assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/title')).value,'Reviewed raster cells');
  assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/license')).provenance,'unknown');
  const archived=JSON.parse(new TextDecoder().decode(f.originalBytes));assert.deepEqual(archived.properties['opengeo:analysis'],expected['opengeo:analysis']);
  assert.equal(archived['opengeo:analysis'],undefined);
  const verified=await verifyRasterAnalysisArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference:summary});
  assert.deepEqual(verified.collection.features,expected.features);assert.deepEqual(verified.receipt,expected['opengeo:analysis']);
 }
});

test('raster registration preserves explicitly missing reference facts without generating managed identities',async()=>{
 const input=await rasterCollection('rasterComparison',{unknownReference:true}),f=fixture(input);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run(),doc=saved.knowledge.document;
 const after=doc.metadata.normalized[0].value.rasterComparison.inputs.after;
 assert.equal(after.pins.datasetId,null);assert.equal(after.source.reference.etag,null);assert.equal(after.source.reference.size,null);
 assert(after.missingFacts.includes('reference.etag'));assert(after.missingFacts.includes('datasetVersionId'));
 assert.equal(doc.context[1].resourceId,'https://example.org/after.tif');
});

test('complete 1024-cell raster maps fit the existing original/knowledge bounds while native previews keep their 1000-feature bound',async()=>{
 const input=await rasterCollection('rasterPatches',{cells:1024}),f=fixture(input);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.equal(JSON.parse(new TextDecoder().decode(f.originalBytes)).features.length,1024);
 assert(f.originalBytes.length<=2_200_000);assert(new TextEncoder().encode(JSON.stringify(saved.knowledge.document)).byteLength<49_152);
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const native={...collection,features:Array.from({length:1001},()=>structuredClone(collection.features[0]))},nativeFixture=fixture(native);
 assert.throws(()=>createManagedAnalysisRegistration({adapter:nativeFixture.adapter,projectId:source,collection:native,review,assertCurrentScope:async()=>{}}),/bounded/);
 assert.deepEqual(nativeFixture.calls,{request:0,upload:0,complete:0,save:0});
});

test('invalid raster geometry, criteria, completeness, source pins, verified claims or oversized knowledge fail before writes',async()=>{
 const original=await rasterCollection('rasterComparison',{evaluated:true});
 for(const mutate of [value=>{value.features[0].geometry.coordinates[0][1][0]+=.001;},value=>{value.features.pop();},
  value=>{value['opengeo:analysis'].rasterComparison.method.criteria.methodReview.confirmed=true;},
  value=>{value['opengeo:analysis'].rasterComparison.inputs.before.pins.sourceVersion=0;},
  value=>{value['opengeo:analysis'].rasterComparison.accuracy.status='verified';},
  value=>{value['opengeo:analysis'].rasterComparison.limitations=Array(8).fill('x'.repeat(3500));}]){
  const input=structuredClone(original);mutate(input);const f=fixture(input);
  assert.throws(()=>createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}}));
  assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});
 }
});

test('raster metadata failure before commit resumes the existing uploaded dataset and leaves conflicting metadata intact',async()=>{
 const input=await rasterCollection('rasterPatches'),f=fixture(input);let draft;
 f.adapter.saveDatasetKnowledge=async(_id,value)=>{f.calls.save++;draft=value.document;if(f.calls.save===1)throw Error('metadata unavailable');return {version:1,document:draft};};
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(session.run(),/metadata unavailable/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:2});assert.deepEqual(saved.knowledge.document,draft);
 const conflict=fixture(input);conflict.adapter.getDatasetKnowledge=async()=>({version:1,document:{existing:'retained'}});
 const pending=createManagedAnalysisRegistration({adapter:conflict.adapter,projectId:source,collection:input,review,assertCurrentScope:async()=>{}});
 await assert.rejects(pending.run(),/Metadata changed/);await assert.rejects(pending.run(),/Metadata changed/);
 assert.deepEqual(conflict.calls,{request:1,upload:1,complete:1,save:0});
});
test('derived registration resumes lost metadata response without duplicate upload; preserves unknown distribution rights and generation lineage',async()=>{
 const f=fixture();const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection,review,assertCurrentScope:async()=>{},now:()=> '2026-09-25T12:00:00Z'});
 await assert.rejects(session.run(),/response lost/);
 const result=await session.run();assert.equal(result.dataset.id,output);assert.notEqual(output,source);
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=result.knowledge.document;
 assert.equal(doc.distributions[0].custody,'derived');
 assert.equal(doc.context[0].resourceId,`urn:opengeo:dataset:${source}:generation:3`);
 assert.deepEqual(JSON.parse(doc.metadata.source[0].content),collection['opengeo:analysis']);
 const license=doc.metadata.curated.find(x=>x.property.endsWith('/license'));
 assert.equal(license.subject,doc.distributions[0].id);assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
 writeFileSync('/tmp/opengeo-analysis-knowledge.json',JSON.stringify(doc));
});
test('scope change prevents registration and malformed lineage fails before writes',async()=>{
 const f=fixture();const options={adapter:f.adapter,projectId:source,collection,review,assertCurrentScope:async()=>{throw Error('scope changed');}};
 await assert.rejects(createManagedAnalysisRegistration(options).run(),/scope changed/);
 const bad=structuredClone(collection);bad['opengeo:analysis'].source_generation=null;
 assert.throws(()=>createManagedAnalysisRegistration({...options,collection:bad}),/generation/);
 assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});
});

test('screening registration archives complete methods, preserves three input pins and resumes committed metadata once',async()=>{
 const input=buildReceptorScreening(receptorScreeningFixture({profile:'polygons'})),expected=structuredClone(input),f=fixture(expected);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=> '2026-10-23T21:00:00Z'});
 input['opengeo:analysis'].screening.influenceBasis='Changed after registration snapshot';
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=saved.knowledge.document,summary=doc.metadata.normalized[0].value.screening;
 assert.equal(doc.metadata.normalized[0].method,'receptor_overlap_screening');assert.equal(summary.rows,undefined);
 assert.equal(doc.context.length,3);
 assert.deepEqual(doc.context.map(item=>item.resourceId),['receptors','footprint','influence'].map(role=>{
  const pin=expected['opengeo:analysis'].screening.inputs[role];return `urn:opengeo:dataset:${pin.datasetId}:generation:${pin.generation}`;
 }));
 const verified=await verifyReceptorScreeningArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference:summary});
 assert.deepEqual(verified.receipt,expected['opengeo:analysis']);assert.deepEqual(verified.collection.features,expected.features);
 assert.equal(doc.metadata.curated.find(item=>item.property.endsWith('/license')).value,null);
});

test('1000 scoped screening rows archive once without growing per-row Catalog knowledge',async()=>{
 const features=Array.from({length:500},(_,index)=>({type:'Feature',id:receptorFeatureId(index+1),properties:{name:`Point ${index+1}`,confidence:null},
  geometry:{type:'Point',coordinates:[85+index/1000000,27]}}));
 const input=buildReceptorScreening({footprint:receptorClip({features,sourceCount:500,sourcePoints:500}),
  influence:receptorClip({scope:'influence',features,sourceCount:500,sourcePoints:500}),question:'Which supplied points intersect each area?',influenceBasis:'Explicit user supplied polygon, not an assessed impact boundary.'});
 const f=fixture(input),session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=> '2026-10-23T21:00:00Z'});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=saved.knowledge.document,reference=doc.metadata.normalized[0].value.screening,knowledgeBytes=new TextEncoder().encode(JSON.stringify(doc)).byteLength;
 assert.equal(input.features.length,1000);assert(f.originalBytes.length<2200000);assert(knowledgeBytes<49152);assert.equal(reference.rows,undefined);
 const verified=await verifyReceptorScreeningArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference});
 assert.deepEqual(verified.collection.features,input.features);assert.equal(verified.receipt.screening.rows.length,1000);
 writeFileSync('/tmp/opengeo-receptor-screening-capacity.json',JSON.stringify({receptorInputRecords:500,scopes:2,outputFeatures:1000,originalBytes:f.originalBytes.length,knowledgeBytes}));
});

const timestamp='2026-10-23T19:00:00Z';
const partitionUrl='https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=NP/Nepal.parquet';
function publicReceipt() {
 return {schemaVersion:'opengeo.ftw-query.1.0.0',status:'complete',query:{countryCode:'NP',year:2024,bounds:[85.533,27.612,85.534,27.613]},
  source:{catalogUrl:FTW_GLOBAL.catalogUrl,collectionUrl:FTW_GLOBAL.vectorCollectionUrl,itemUrl:partitionUrl.replace('.parquet','.json'),itemId:'Nepal',
   partitionUrl,etag:'"baf3b56e56cefc0d97b11e911070c478-56"',sizeBytes:469081185,year:2024,license:'CC-BY-4.0',licenseBasis:'published-product-terms',
   distributionVersion:'mutable-alpha',evidenceUrls:[...FTW_GLOBAL.evidenceUrls],attribution:'Fields of the World — Taylor Geospatial and Microsoft AI for Good',
   citation:'Robinson et al. (2026). arXiv:2605.11055.',confidence:structuredClone(FTW_GLOBAL.confidence)},
  scope:{kind:'selected-country-partition-query',aoiClipped:false,wholeFootprints:true,providerCoverageVerified:false,countrywideInventory:false},
  method:{id:'ftw-bbox-then-footprint',version:'1.0.0',selectedColumns:['id','geometry','confidence'],omittedColumns:['metrics:area','metrics:perimeter'],topologyValidation:'structural-only; source topology assumed'},
  counts:{candidateGroups:7,scannedRows:458752,bboxMatches:1,yearMatches:1,geometryMatches:1,geometryRowsDecoded:1},
  ranges:[{url:partitionUrl,start:227027985,endExclusive:230511547,bytes:3483562,etag:'"baf3b56e56cefc0d97b11e911070c478-56"'}],
  usage:{requests:14,bytes:7776722,rows:458752},limits:{requests:32,bytes:8388608},limitations:['Whole source footprints; source observations and field accuracy remain unverified.']};
}
function publicCollection() {
 return {type:'FeatureCollection',features:[{type:'Feature',id:'2998576',geometry:{type:'Polygon',coordinates:[[
  [85.5334,27.6123],[85.5339,27.6123],[85.5339,27.6126],[85.5334,27.6126],[85.5334,27.6123]]]},
  properties:{id:'2998576',confidence:null,'determination:datetime':'2024-01-01T00:00:00.000Z'}}],
  'opengeo:analysis':{operation:'ftw-fields',persisted:false,crs:'CRS:84',receipt:publicReceipt()}};
}
const options=(f,input)=>({adapter:f.adapter,projectId:source,collection:input,review:{...review,title:'Reviewed public fields'},assertCurrentScope:async()=>{},now:()=>timestamp});

test('public FTW registration retains the observed partition snapshot and resumes metadata readback without a managed source identity',async()=>{
 const input=publicCollection(),original=structuredClone(input),f=fixture(input);
 input['opengeo:analysis'].receipt.privateContext='private';input['opengeo:analysis'].receipt.source.credentials='private';
 const expected=mappedFieldSourceEvidence(input),session=createManagedAnalysisRegistration(options(f,input));
 input['opengeo:analysis'].receipt.source.etag='edited after session';
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=saved.knowledge.document,retained=JSON.parse(doc.metadata.source[0].content);
 assert.deepEqual(retained.receipt,expected);assert.equal(retained.operation,'ftw-fields');
 assert.equal(doc.context.length,1);assert.equal(doc.context[0].resourceId,partitionUrl);
 assert.equal(doc.context[0].relationship,'http://www.w3.org/ns/prov#wasDerivedFrom');
 assert.equal(doc.metadata.normalized[0].method,'published_product_field_query');
 assert.deepEqual(doc.metadata.normalized[0].value.receipt,expected);
 assert(doc.metadata.normalized[0].evidence.includes(partitionUrl));
 assert.equal(retained.receipt.source.etag,original['opengeo:analysis'].receipt.source.etag);
 assert.equal(retained.receipt.source.sizeBytes,469081185);assert.equal(retained.receipt.source.distributionVersion,'mutable-alpha');
 assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/license')).value,null);
 assert.equal(retained.receipt.source.license,'CC-BY-4.0');assert(!JSON.stringify(doc).includes('private'));
 assert(!doc.context.some(value=>value.resourceId.startsWith('urn:opengeo:dataset:')));
 writeFileSync('/tmp/opengeo-ftw-analysis-knowledge.json',JSON.stringify(doc));
});

test('measured fields retain their closed summary, original source evidence and method without copying feature geometry into knowledge',async()=>{
 const input=publicCollection(),measured=inventoryMappedFields({geojson:input,layerId:'loaded-ftw'}),original=structuredClone(measured.geojson);
 measured.geojson.fieldInventory.privateContext='private';measured.geojson.fieldInventory.featureGeometry=input.features[0].geometry;
 const f=fixture(measured.geojson),session=createManagedAnalysisRegistration(options(f,measured.geojson));
 await assert.rejects(session.run(),/response lost/);const saved=await session.run(),doc=saved.knowledge.document;
 const retained=JSON.parse(doc.metadata.source[0].content);
 assert.deepEqual(retained,original.fieldInventory);assert.equal(retained.source.datasetId,null);assert.equal(retained.source.sourceGeneration,null);
 assert.equal(retained.sourceEvidence.source.partitionUrl,partitionUrl);assert.equal(retained.sourceEvidence.source.etag,publicReceipt().source.etag);
 assert.equal(retained.totalAreaSquareMeters,measured.summary.totalAreaSquareMeters);assert.equal(retained.totalAreaHectares,retained.totalAreaSquareMeters/10000);
 assert.equal(retained.method.id,'openlayers-spherical-polygon-area');assert.equal(doc.metadata.normalized[0].method,'mapped_field_area_inventory');
 assert.deepEqual(doc.metadata.normalized[0].value.method,measured.summary.method);assert(!JSON.stringify(doc).includes('coordinates'));
 assert(!JSON.stringify(doc).includes('private'));assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 assert.equal(doc.context[0].resourceId,partitionUrl);assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/license')).provenance,'unknown');
 writeFileSync('/tmp/opengeo-measured-ftw-analysis-knowledge.json',JSON.stringify(doc));
});

test('native analysisKnowledge retains both UUID/generation inputs and exact native receipt semantics',()=>{
 const receipt={...collection['opengeo:analysis'],operation:'building-reconcile',targetDatasetId:output,target_generation:7};
 const doc=analysisKnowledge({datasetId:output,datasetVersionId:version,receipt,review,timestamp});
 assert.deepEqual(doc.context.map(value=>value.resourceId),[`urn:opengeo:dataset:${source}:generation:3`,`urn:opengeo:dataset:${output}:generation:7`]);
 assert.deepEqual(JSON.parse(doc.metadata.source[0].content),receipt);assert.equal(doc.metadata.normalized[0].method,'native_vector_analysis');
});

test('reviewed building registration preserves decisions and selected geometry across upload and lost metadata readback',async()=>{
 const native=buildingReviewComparison(),original=structuredClone(native);
 const decisions=buildingReconciliationGroups(native).map(group=>({componentId:group.id,
  selectedFeatureIds:group.features.filter(feature=>feature.properties.input.side==='source').map(feature=>feature.id),
  reason:'Prefer the source inventory for this explicitly reviewed selection.'}));
 const input=buildReviewedBuildingInventory({collection:native,decisions,reviewerId:buildingReviewerId,timestamp});
 const expected=structuredClone(input),f=fixture(expected);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=>timestamp});
 input['opengeo:analysis'].buildingReview.decisions[0].reason='edited after registration began';
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 assert.deepEqual(native,original);const doc=saved.knowledge.document,receipt=JSON.parse(doc.metadata.source[0].content);
 const summary=receipt.buildingReview,full=expected['opengeo:analysis'];
 assert.equal(doc.metadata.normalized[0].method,'building_inventory_review');
 assert.deepEqual(doc.metadata.normalized[0].value.buildingReview,summary);assert.equal(summary.decisions,undefined);
 assert.equal(summary.audit.distributionId,`urn:opengeo:dataset:${output}:version:${version}:original`);
 assert.equal(summary.audit.jsonPointer,'/properties/opengeo:analysis/buildingReview');
 assert.equal(summary.audit.sha256,createHash('sha256').update(canonicalJson(full.buildingReview)).digest('hex'));
 const archived=JSON.parse(new TextDecoder().decode(f.originalBytes));
 assert.deepEqual(archived.properties['opengeo:analysis'],full);assert.deepEqual(archived.features,expected.features);
 assert.equal(receipt.buildingReview.retainedFeatureCount,2);assert.equal(receipt.buildingReview.excludedFeatureCount,1);
 assert.equal(receipt.buildingReview.validatedCount,null);assert.equal(receipt.buildingReconciliation.reviewStatus,'unreviewed');
 assert.equal(doc.context.length,2);assert.equal(doc.metadata.curated.find(value=>value.property.endsWith('/license')).value,null);
});

function manyReviewedBuildings(reason='r'.repeat(500),evaluationReferenceSide){
 const native=buildingReviewComparison();native.features=[];
 for(let index=1;index<=1000;index++){
  const side=index<=500?'source':'target',feature=buildingReviewComparison().features[2];
  feature.id=`${side}:97000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  feature.properties.input.side=side;feature.properties.input.featureId=feature.id.slice(side.length+1);native.features.push(feature);
 }
 native['opengeo:analysis'].source_count=500;native['opengeo:analysis'].target_count=500;
 const decisions=buildingReconciliationGroups(native).map(group=>({componentId:group.id,selectedFeatureIds:[group.features[0].id],reason}));
 return buildReviewedBuildingInventory({collection:native,decisions,reviewerId:buildingReviewerId,timestamp,evaluationReferenceSide});
}
test('1000 reason-heavy reviewed footprints archive complete decisions within unchanged upload and metadata bounds',async()=>{
 const input=manyReviewedBuildings(),f=fixture(input),before=JSON.stringify(input);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=>timestamp});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});assert(f.originalBytes.length<=2200000);
 const doc=saved.knowledge.document,reference=doc.metadata.normalized[0].value.buildingReview;
 assert(new TextEncoder().encode(JSON.stringify(doc)).byteLength<49152);assert.equal(reference.decisions,undefined);
 const verified=await verifyBuildingReviewArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference});
 assert.deepEqual(verified.receipt,input['opengeo:analysis']);assert.equal(verified.receipt.buildingReview.decisions.length,1000);
 assert.deepEqual(verified.collection.features,input.features);assert.equal(JSON.stringify(input),before);
 writeFileSync('/tmp/opengeo-building-review-archive-capacity.json',JSON.stringify({footprints:1000,reasonCharacters:500,reasonEncoding:'ASCII',originalBytes:f.originalBytes.length,knowledgeBytes:new TextEncoder().encode(JSON.stringify(doc)).byteLength}));
});
test('review originals exceeding the existing byte cap fail before writes without truncating Unicode reasons',()=>{
 const input=manyReviewedBuildings('漢'.repeat(500)),before=JSON.stringify(input),f=fixture(input);
 assert.throws(()=>createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=>timestamp}),/Analysis exceeds its byte limit/);
 assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});assert.equal(JSON.stringify(input),before);
});

test('1000-footprint evaluated review keeps full reproducible report within existing original and knowledge bounds',async()=>{
 const started=performance.now(),input=manyReviewedBuildings('r'.repeat(500),'target'),f=fixture(input);
 const session=createManagedAnalysisRegistration({adapter:f.adapter,projectId:source,collection:input,review,
  assertCurrentScope:async()=>{},now:()=>timestamp});
 await assert.rejects(session.run(),/response lost/);const saved=await session.run();
 assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:1});
 const doc=saved.knowledge.document,summary=doc.metadata.normalized[0].value.buildingReview;
 const knowledgeBytes=new TextEncoder().encode(JSON.stringify(doc)).byteLength;
 assert(f.originalBytes.length<=2200000);assert(knowledgeBytes<49152);
 assert.equal(summary.evaluation.pairs,undefined);assert.equal(summary.evaluation.unmatchedReferenceFeatureIds,undefined);
 const verified=await verifyBuildingReviewArchive(f.originalBytes,{objectSha256:createHash('sha256').update(f.originalBytes).digest('hex'),reference:summary});
 assert.deepEqual(verified.receipt,input['opengeo:analysis']);
 assert.equal(verified.receipt.buildingReview.evaluation.unmatchedReferenceFeatureIds.length,500);
 assert.equal(verified.receipt.buildingReview.evaluation.unmatchedPredictionFeatureIds.length,500);
 writeFileSync('/tmp/opengeo-building-evaluation-capacity.json',JSON.stringify({footprints:1000,referenceFootprints:500,predictionFootprints:500,
  reasonCharacters:500,reasonEncoding:'ASCII',originalBytes:f.originalBytes.length,knowledgeBytes,registrationAndReadbackMilliseconds:performance.now()-started}));
});

test('missing public snapshots, invalid measured summaries and oversized native/public knowledge fail before writes',()=>{
 const cases=[];
 for(const change of [receipt=>{delete receipt.source.etag;},receipt=>{receipt.source.sizeBytes=0;},
  receipt=>{receipt.source.partitionUrl='https://private.example/fields.parquet';},
  receipt=>{receipt.source.catalogUrl='https://data.source.coop/ftw/global-data/other.json';}]){
  const input=publicCollection();change(input['opengeo:analysis'].receipt);cases.push(input);
 }
 const counted=inventoryMappedFields({geojson:publicCollection(),layerId:'loaded-ftw'}).geojson;counted.fieldInventory.featureCount=2;cases.push(counted);
 const area=inventoryMappedFields({geojson:publicCollection(),layerId:'loaded-ftw'}).geojson;area.fieldInventory.totalAreaHectares=0;cases.push(area);
 const bigNative=structuredClone(collection);bigNative['opengeo:analysis'].notes='x'.repeat(26_000);cases.push(bigNative);
 const bigPublic=publicCollection();bigPublic['opengeo:analysis'].receipt.limitations=Array(8).fill('x'.repeat(3500));cases.push(bigPublic);
 for(const input of cases){const f=fixture(input);assert.throws(()=>createManagedAnalysisRegistration(options(f,input)));assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});}
});

test('metadata readback rechecks current scope before saving or reporting an existing result',async()=>{
 const input=publicCollection(),f=fixture(input);let current=true;
 f.adapter.getDatasetKnowledge=async()=>{current=false;return {version:0,document:{}};};
 const session=createManagedAnalysisRegistration({...options(f,input),assertCurrentScope:async()=>{if(!current)throw Error('scope changed');}});
 await assert.rejects(session.run(),/scope changed/);assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:0});
 await assert.rejects(session.run(),/scope changed/);assert.deepEqual(f.calls,{request:1,upload:1,complete:1,save:0});
});

test('user-supplied query import evidence survives raw and measured registration without provider re-verification',()=>{
 const input=publicCollection(),annotation={kind:'user-supplied-local-query',filename:'ftw-np-2024-fields.json',sha256:'a'.repeat(64),
  sizeBytes:7777,importedAt:timestamp,providerReverified:false};
 input['opengeo:analysis'].receipt.localImport={...annotation,localPath:'/private/ignored'};
 const measured=inventoryMappedFields({geojson:input,layerId:'imported-ftw'}).geojson;
 for(const receipt of [input['opengeo:analysis'],measured.fieldInventory]){
  const doc=analysisKnowledge({datasetId:output,datasetVersionId:version,receipt,review,timestamp});
  const value=doc.metadata.normalized[0].value,evidence=value.receipt??value.sourceEvidence;
  assert.deepEqual(evidence.localImport,annotation);assert.equal(evidence.localImport.providerReverified,false);
  assert(!JSON.stringify(doc).includes('/private/'));assert.equal(doc.metadata.normalized[0].provenance,'derived');
  assert.equal(doc.context[0].resourceId,partitionUrl);
 }
 const bad=structuredClone(input);bad['opengeo:analysis'].receipt.ranges[0].etag='"other snapshot"';
 const f=fixture(bad);assert.throws(()=>createManagedAnalysisRegistration(options(f,bad)),/snapshot/);
 assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});
});

test('prospective size preflight includes server JSON spacing before creating even a native upload',()=>{
 const selectedReview={...review,title:'Reviewed public fields'},base=analysisKnowledge({datasetId:output,datasetVersionId:version,
  receipt:collection['opengeo:analysis'],review:selectedReview,timestamp});
 const candidate=structuredClone(collection);
 let low=0,high=26_000,bytes=0;
 const sizeAt=length=>{
  candidate['opengeo:analysis'].notes='x'.repeat(length);
  base.metadata.source[0].content=JSON.stringify(candidate['opengeo:analysis']);
  base.metadata.normalized[0].value=candidate['opengeo:analysis'];
  return new TextEncoder().encode(JSON.stringify(base)).byteLength;
 };
 while(low<high){const middle=Math.ceil((low+high)/2);if(sizeAt(middle)<=49_120)low=middle;else high=middle-1;}
 bytes=sizeAt(low);assert(bytes<=49_152);assert(bytes>49_100);
 const f=fixture(candidate);assert.throws(()=>createManagedAnalysisRegistration(options(f,candidate)),/49,152|48 KiB/);
 assert.deepEqual(f.calls,{request:0,upload:0,complete:0,save:0});
});
