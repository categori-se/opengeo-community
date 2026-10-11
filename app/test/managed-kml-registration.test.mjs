import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createManagedKmlRegistration, managedKmlKnowledge} from '../src/lib/managedKmlRegistration.js';
import {createManagedUploadSession} from '../src/lib/managedUpload.js';
const datasetId='80000000-0000-4000-8000-000000000001';
const datasetVersionId='83000000-0000-4000-8000-000000000001';
const projectId='50000000-0000-4000-8000-000000000001';
const timestamp='2026-09-22T12:00:00Z';
const review={title:'Reviewed survey',description:'Survey source',license:null,attribution:'Field team'};
const empty=()=>({schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]});
function fixture() {
  const calls={request:0,upload:0,complete:0,read:0,save:0};
  const file=new Blob(['<kml xmlns="http://www.opengis.net/kml/2.2"/>']); Object.defineProperty(file,'name',{value:'survey.kml'});
  let stored={version:0,document:empty()};
  const adapter={
    async requestUpload(){calls.request++;return {uploadId:'81000000-0000-4000-8000-000000000001',dataset:{id:datasetId},expiresAt:'2099-01-01T00:00:00Z',upload:{}};},
    async uploadFile(){calls.upload++;},
    async completeUpload(){calls.complete++;return {dataset:{id:datasetId,name:review.title},datasetVersionId,versionNumber:1};},
    async getDatasetKnowledge(){calls.read++;return structuredClone(stored);},
    async saveDatasetKnowledge(id,draft){calls.save++;assert.equal(id,datasetId);assert.equal(draft.expectedVersion,stored.version);stored={version:stored.version+1,document:structuredClone(draft.document)};return stored;}
  };
  const options={adapter,projectId,file,review,sourceTitle:'Original title',assertCurrentScope:async()=>{},now:()=>timestamp};
  return {calls,adapter,options,get stored(){return stored;},set stored(value){stored=value;}};
}

test('lost metadata response resumes the same source and recognizes the saved revision',async()=>{
  const f=fixture(),save=f.adapter.saveDatasetKnowledge;
  f.adapter.saveDatasetKnowledge=async(...args)=>{await save(...args);throw Error('response lost');};
  const session=createManagedKmlRegistration(f.options);
  await assert.rejects(session.run(),/response lost/);
  const result=await session.run();
  assert.equal(result.dataset.id,datasetId);assert.equal(result.knowledge.version,1);
  assert.deepEqual(f.calls,{request:1,upload:1,complete:1,read:2,save:1});
  const doc=result.knowledge.document;
  assert.equal(doc.distributions[0].custody,'hosted');
  const license=doc.metadata.curated.find(item=>item.property.endsWith('/license'));
  assert.equal(license.subject,doc.distributions[0].id);assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
  assert.equal(doc.metadata.normalized[0].value,'Original title');
  assert.equal(doc.metadata.curated[0].value,review.title);
});

test('failed metadata write retries without uploading again, using a frozen review',async()=>{
  const f=fixture(),save=f.adapter.saveDatasetKnowledge;
  let fail=true;
  f.adapter.saveDatasetKnowledge=async(...args)=>{if(fail){fail=false;throw Error('offline');}return save(...args);};
  const ownReview={...review}; const session=createManagedKmlRegistration({...f.options,review:ownReview});
  ownReview.title='Changed after starting';
  const pending=session.run();assert.equal(session.run(),pending);
  await assert.rejects(pending,/offline/);await session.run();
  assert.equal(f.calls.upload,1);assert.equal(f.calls.request,1);assert.equal(f.calls.complete,1);
  assert.equal(f.stored.document.metadata.curated[0].value,review.title);
});

test('lost upload response verifies the existing object before considering another POST',async()=>{
  const f=fixture();f.adapter.uploadFile=async()=>{f.calls.upload++;throw Error('response lost');};
  const session=createManagedUploadSession(f.options);
  await assert.rejects(session.run(),/response lost/);await session.run();
  assert.deepEqual(f.calls,{request:1,upload:1,complete:1,read:0,save:0});
});

test('unresolved initial ticket never silently creates another registration',async()=>{
  const f=fixture();f.adapter.requestUpload=async()=>{f.calls.request++;throw Error('response lost');};
  const session=createManagedUploadSession(f.options);
  await assert.rejects(session.run(),/response lost/);
  await assert.rejects(session.run(),error=>error.code==='upload_ticket_unresolved');
  assert.equal(f.calls.request,1);assert.equal(f.calls.upload,0);
});

test('scope change stops subsequent stages and conflicting metadata is not overwritten',async()=>{
  const f=fixture();let current=true;
  f.adapter.uploadFile=async()=>{f.calls.upload++;current=false;};
  const session=createManagedKmlRegistration({...f.options,assertCurrentScope:async()=>{if(!current)throw Error('account changed');}});
  await assert.rejects(session.run(),/account changed/);await assert.rejects(session.run(),/account changed/);
  assert.equal(f.calls.complete,0);
  current=true;f.stored={version:1,document:empty()};
  await assert.rejects(session.run(),error=>error.code==='metadata_version_conflict');
  assert.equal(f.calls.upload,1);assert.equal(f.calls.save,0);
});

test('knowledge builder refuses invented source identities',()=>{
  assert.throws(()=>managedKmlKnowledge({datasetId:undefined,datasetVersionId,review,timestamp}),/identity/);
});
