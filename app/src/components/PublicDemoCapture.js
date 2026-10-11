import {FixturePlatformAdapter, FIXTURE_PROJECTS} from '../lib/fixturePlatform.js';
import {OfflineCaptureQueue, OfflineAttachmentFiles} from '../lib/offlineCapture.js';
import {loadFieldCapture} from './ProjectDatasets.js';

// The public demo reuses the forms and local adapter, never an authenticated API.
export async function createPublicDemoCaptureSession() {
  const now=new Date().toISOString();
  const catalog={session:{email:'demo@example.invalid',displayName:'Demo visitor'},tenants:[],workspaceProjects:[],
    workspaces:FIXTURE_PROJECTS.map(({workspaceId})=>({workspaceId,title:'Capture demonstration',
      description:'Temporary browser records',classification:'internal',status:'active',createdAt:now,updatedAt:now})),
    datasets:[{datasetId:'demo-observations',workspaceId:FIXTURE_PROJECTS[0].workspaceId,title:'Field observations',
      classification:'internal',status:'active',datasetType:'vector',currentVersion:'v1',featureCount:0,
      geometryType:'Point',crs:'EPSG:4326',createdAt:now,updatedAt:now}]};
  const adapter=new FixturePlatformAdapter(catalog);
  const dataset=adapter.datasets[0];
  const project=await adapter.getProject(dataset.projectId);
  const state={adapter,project,demoCapture:true,session:await adapter.getSession(),organization:await adapter.getCurrentOrganization(),
    captureStorage:{temporary:true,queue:new OfflineCaptureQueue({store:memoryStore(100,5*1024*1024)}),
      files:new OfflineAttachmentFiles({store:memoryStore(20,20*1024*1024)}),uploadAccept:'.geojson,.json'}};
  await adapter.createFeatureCollection(project.id,dataset.id,{geometryType:'Point',fields:[
    {name:'observation',label:'Observation',type:'string',required:true,maxLength:500},
    {name:'file',label:'Supporting GeoJSON',type:'string',attachment:true,required:false}
  ]});
  await adapter.createFieldForm(project.id,dataset.id,{title:'Try a field observation',
    instructions:'Capture a point, describe what you observed, and try the review workflow. You can also attach a GeoJSON file.'});
  const search=adapter.searchDatasets.bind(adapter);
  adapter.searchDatasets=async filters=>(await search({...filters,projectId:project.id})).filter(item=>item.id!==dataset.id);
  const request=adapter.requestUpload.bind(adapter);
  let fileCount=0,totalBytes=0;
  adapter.requestUpload=async(id,metadata)=>{
    if(id!==project.id || metadata.format!=='geojson' || metadata.sizeBytes>5*1024*1024
      || fileCount>=20 || totalBytes+metadata.sizeBytes>20*1024*1024)throw Error('Demo file limit reached');
    const result=await request(id,metadata);fileCount++;totalBytes+=metadata.sizeBytes;return result;
  };
  const submit=adapter.createFieldSubmission.bind(adapter);
  const submissions=new Set();
  adapter.createFieldSubmission=async(...args)=>{
    const draft=args[4];
    if(JSON.stringify(draft).length>350_000 || (!submissions.has(draft.submissionId)&&submissions.size>=100))throw Error('Demo observation limit reached');
    const result=await submit(...args);submissions.add(draft.submissionId);return result;
  };
  return {state,dataset,async render(details){await loadFieldCapture(state,dataset,details);}};
}

function memoryStore(maxRecords,maxBytes) {
  const records=new Map();
  const put=record=>{
    const values=[...records.values()].filter(item=>item.queueId!==record.queueId).concat(record);
    const bytes=values.reduce((sum,item)=>sum+(item.file?.size??new TextEncoder().encode(JSON.stringify(item)).length),0);
    if(values.length>maxRecords||bytes>maxBytes)throw Error('Demo storage limit reached');
    records.set(record.queueId,structuredClone(record));
  };
  return {async list(){return structuredClone([...records.values()]);},async put(record){put(record);},
    async remove(id){records.delete(id);},async update(id,mutate){const next=mutate(structuredClone(records.get(id)));put(next);return structuredClone(next);}};
}

export async function openPublicDemoCapture(session) {
  const dialog=document.createElement('dialog');dialog.className='public-demo-capture';dialog.setAttribute('aria-label','Try field capture');
  dialog.style.cssText='width:min(900px,90vw);max-height:90vh;overflow:auto';
  const heading=document.createElement('h2');heading.textContent='Try field capture';
  const notice=document.createElement('p');
  notice.textContent='Practice capturing a GPS point, adding survey fields and an optional GeoJSON attachment, then submitting it for review. This demo uses one point per observation; it does not record a walking route.';
  const boundary=document.createElement('p');boundary.className='project-catalog-feedback';
  boundary.textContent='Demo only: files and observations stay in this tab. Submit, sync and review are simulated; nothing reaches an account. Reloading or a new demo day clears your work. Limits: GeoJSON files only, 5 MB per file, 20 files / 20 MB total, 100 observations.';
  const close=document.createElement('button');close.type='button';close.textContent='Close field capture';
  close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  const header=document.createElement('div');header.className='public-demo-capture-header';header.append(heading,close);
  const details=document.createElement('div');dialog.append(header,notice,boundary,details);document.body.append(dialog);dialog.showModal();
  try {await session.render(details);}catch {details.textContent='Capture demonstration could not load. Close it and try again.';}
  return dialog;
}
