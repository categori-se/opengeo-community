import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {verifyReviewedArchiveBytes} from '../src/lib/archivedGeojson.js';
import {writeFileSync} from 'node:fs';
import {createManagedAnalysisRegistration} from '../src/lib/managedAnalysisRegistration.js';
const source = '10000000-0000-4000-8000-000000000008';
const output = '80000000-0000-4000-8000-000000000001';
const version = '83000000-0000-4000-8000-000000000001';
const collection = {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[1,2]}}],
 'opengeo:analysis':{operation:'centroid',version:'1.0.0',sourceDatasetId:source,source_generation:3,targetDatasetId:null,persisted:false,crs:'CRS:84'}};
const review = {title:'Derived centers',description:'Planar centroids',license:null,attribution:null};
function fixture() {
 const calls={request:0,upload:0,complete:0,save:0};let current={version:0,document:{}};
 const adapter={
  async requestUpload(_project,metadata){calls.request++;assert.equal(metadata.classification,'restricted');return {dataset:{id:output},uploadId:version,expiresAt:'2099-01-01T00:00:00Z',upload:{}};},
  async uploadFile(_upload,file){
    calls.upload++;
    const bytes=new Uint8Array(await file.arrayBuffer());
    const checksum=createHash('sha256').update(bytes).digest('hex');
    const reopened=await verifyReviewedArchiveBytes(bytes,{sizeBytes:bytes.length,decodedSizeBytes:bytes.length,
      objectSha256:checksum,decodedSha256:checksum,contentEncoding:'identity',featureCount:1,geometryType:'Point'},
      {allowNestedProperties:true,allowCaptureMetadata:true});
    assert.deepEqual(reopened,{type:'FeatureCollection',features:collection.features});
  },
  async completeUpload(){calls.complete++;return {dataset:{id:output},datasetVersionId:version,versionNumber:1};},
  async getDatasetKnowledge(){return current;},
  async saveDatasetKnowledge(id,draft){calls.save++;assert.equal(id,output);current={version:1,document:draft.document};throw Error('response lost');}
 };
 return {calls,adapter,get current(){return current;}};
}
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
