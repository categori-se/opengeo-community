import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {AuthoredResourceMetadata, guardAuthoredMetadata} from '../src/components/AuthoredResourceMetadata.js';
import {ProjectPublishingWorkspace} from '../src/components/ProjectSites.js';
const empty=()=>({schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
for (const kind of ['project','publication']) it(`${kind} metadata keeps identity, draft guards and save/reopen`,async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces?project=one'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 const id=kind==='project'?'map-identity':'site-identity',calls=[];
 let record={version:0,canEdit:true,document:empty()};
 const adapter={getAuthoredKnowledge:async(k,i)=>{calls.push(['read',k,i]);return structuredClone(record);},saveAuthoredKnowledge:async(k,i,p)=>{calls.push(['save',k,i]);assert.equal(p.expectedVersion,record.version);record={...record,version:1,document:p.document};return structuredClone(record);}};
 let guard;
 try {
  const host=document.createElement('section');document.body.append(host);guard=guardAuthoredMetadata(host);
  const metadata=AuthoredResourceMetadata({adapter,kind,id});host.append(metadata);
  const link=document.createElement('a');link.href='/workspaces';document.body.append(link);
  const account=document.createElement('button');account.className='gis-account-command';document.body.append(account);
  const selector=document.createElement('select');selector.setAttribute('aria-label','Studio account');selector.innerHTML='<option value="one">One</option><option value="two">Two</option>';document.body.append(selector);
  let accountChanges=0;selector.addEventListener('change',()=>accountChanges++);
  assert.equal(calls.length,0);metadata.open=true;metadata.dispatchEvent(new dom.window.Event('toggle'));
  if (kind === 'publication') {assert.equal(calls.length,0);metadata.querySelector('button').click();}
  await flush();
  assert.deepEqual(calls,[['read',kind,id]]);
  const input=metadata.querySelector('[aria-label="Metadata JSON"]');const draft=empty();draft.metadata.curated.push({subject:'resource',property:'http://purl.org/dc/terms/license',value:null,provenance:'unknown'});
  input.value=JSON.stringify(draft);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal(guard.check(),true);
  for(const target of [link,account])assert.equal(target.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})),false);
  selector.value='two';selector.dispatchEvent(new dom.window.Event('change',{bubbles:true,cancelable:true}));
  assert.equal(selector.value,'one');assert.equal(accountChanges,0);
  const leaving=new dom.window.Event('beforeunload',{cancelable:true});dom.window.dispatchEvent(leaving);assert.equal(leaving.defaultPrevented,true);
  dom.window.history.pushState(null,'','/elsewhere');dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  assert.equal(dom.window.location.pathname,'/workspaces');
  [...metadata.querySelectorAll('button')].find(b=>b.textContent==='Save metadata revision').click();await flush();assert.equal(guard.check(),false,JSON.stringify(calls)+metadata.querySelector('[role="status"]').textContent);
  selector.value='two';selector.dispatchEvent(new dom.window.Event('change',{bubbles:true,cancelable:true}));assert.equal(accountChanges,1);assert.equal(selector.value,'two');
  const reopened=AuthoredResourceMetadata({adapter,kind,id});host.append(reopened);reopened.open=true;reopened.dispatchEvent(new dom.window.Event('toggle'));reopened.querySelector('button').click();await flush();
  assert.match(reopened.textContent,/Provenance: unknown/);assert.equal(record.document.metadata.curated[0].value,null);
  assert.deepEqual(calls.map(c=>c.slice(1)),[[kind,id],[kind,id],[kind,id]]);
 }finally{guard?.dispose();globalThis.document=old;dom.window.close();}
});

it('shows saved Project and referenced Layer records, reading metadata once on opening while preserving drafts',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/projects'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 try {
  const id='80000000-0000-4000-8000-000000000001',datasetId='80000000-0000-4000-8000-000000000002';
  let reads=0;
  const adapter={kind:'managed',getAuthoredKnowledge:async()=>{reads++;return {version:0,canEdit:true,document:empty()};}};
  const layer={layerId:'wetlands',datasetId,title:'Wetland display',sourceType:'imageserver-raster',sourceVersion:2,
   sourceUrl:'https://example.org/saved/ImageServer',attribution:'Saved provider attribution'};
  const map={id,name:'Regional ecosystem comparison',description:'Regional imagery compared with wetlands.',version:4,
   updatedAt:'2026-10-16T10:00:00Z',definition:{layers:[layer]}};
  const knowledge=empty();knowledge.metadata.normalized.push({subject:'resource',property:'http://purl.org/dc/terms/subject',
   value:{'@id':'http://www.wikidata.org/entity/Q837','http://www.w3.org/2000/01/rdf-schema#label':'Nepal'},provenance:'source_asserted'});
  const context={map,datasets:[{id:datasetId,name:'Wetlands Catalog Layer',description:'Recorded regional wetland service.',
   format:'imageserver',tags:['regional'],currentVersionNumber:null},{id:'unrelated',name:'Unrelated container data'}],
   sources:[{datasetId,versionNumber:3,sourceUrl:'https://example.org/current/ImageServer',configuration:{attribution:'Current provider attribution'}},
    {datasetId:'unrelated',sourceUrl:'https://example.org/unrelated'}],knowledgeByDataset:new Map([[datasetId,{datasetId,document:knowledge}]])};
  const root=AuthoredResourceMetadata({adapter,kind:'project',id,projectContext:context});document.body.append(root);
  assert.equal(reads,0);
  root.open=true;root.dispatchEvent(new dom.window.Event('toggle'));
  assert.equal(reads,1);
  const overview=root.querySelector('.project-metadata-context');
  assert.match(overview.textContent,/Regional ecosystem comparison/);assert.match(overview.textContent,/Regional imagery compared with wetlands/);
  assert.match(overview.textContent,/saved source revision 2/);assert.match(overview.textContent,/Saved endpoint: https:\/\/example.org\/saved\/ImageServer/);
  assert.match(overview.textContent,/Current connection revision3/);assert.match(overview.textContent,/Nepal · Discusses this place · normalized · source asserted/);
  assert.doesNotMatch(overview.textContent,/Unrelated container|example.org\/unrelated|Bhutan|Unknown rights/);
  const list=overview.querySelector('[aria-label="Layers in this Project"]');assert.equal(list.children.length,1);
  assert.equal(list.querySelector('a').getAttribute('href'),`/layers?id=${datasetId}`);
  assert.equal(root.children[1],overview);assert.equal(root.children[2].className,'resource-knowledge');
  await flush();assert.equal(reads,1);
  const input=root.querySelector('[aria-label="Metadata JSON"]');input.value+=' ';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  root.updateProjectContext({...context,map:{...map,version:5,description:'Saved description updated.'}});
  assert.equal(root.querySelector('[aria-label="Metadata JSON"]'),input);assert.equal(input.value,JSON.stringify(empty(),null,2)+' ');
  assert.match(overview.textContent,/Saved description updated/);assert.equal(reads,1);
  root.updateProjectContext({...context,knowledgeByDataset:new Map([[datasetId,{datasetId:'unrelated',document:knowledge}]])});
  assert.doesNotMatch(overview.textContent,/Nepal/);
  root.updateProjectContext({...context,map:{...map,id:'another-map',name:'Another Project'}});
  assert.equal(overview.childElementCount,0);assert.equal(root.querySelector('[aria-label="Metadata JSON"]'),input);
 }finally{globalThis.document=old;dom.window.close();}
});


function publicationMetadataHost(adapter) {
 const ids=['80000000-0000-4000-8000-000000000011','80000000-0000-4000-8000-000000000012'];
 const sites=ids.map((id,index)=>({id,title:`Publication ${index+1}`}));
 const state={adapter,organization:{callerRole:'reader'},project:{id:'publication-access',callerRole:'reader'},sites,
  observableSourceProjects:sites.map(site=>({id:`source-${site.id}`,siteId:site.id,title:site.title,currentRevisionNumber:1}))};
 const host=document.createElement('section');document.body.append(host);
 const guard=guardAuthoredMetadata(host),workspace=ProjectPublishingWorkspace({state,refresh:async()=>{throw Error('Unexpected content refresh');}});
 host.append(workspace);return {host,workspace,guard,ids};
}

function editablePublicationHost(adapter, refresh, {source = false} = {}) {
 const id='80000000-0000-4000-8000-000000000021',resourceId='80000000-0000-4000-8000-000000000022';
 const site={id,title:'Editable Publication',slug:'editable',state:'draft',versionNumber:1,theme:'paper',language:'en',activeEdition:null,
  publicationDestination:{reach:'private'},pages:[{resourceId,resourceTitle:'Page',resourceKind:'document',resourceVersionNumber:1,
   resourceState:'published',resourceVisibility:'public',slug:'page',navigationLabel:'Page',isHome:true,position:0}]};
 const state={adapter,organization:{callerRole:'admin'},project:{id:'publication-access',callerRole:'owner'},sites:[site],resources:[],
  observableSourceProjects:source?[{id:'source',siteId:id,title:site.title,currentRevisionNumber:1,currentRevisionId:'revision',
   rightsStatus:'unreviewed',buildPolicy:{compilerImageDigest:'digest',networkPolicy:'deny'}}]:[]};
 const workspace=ProjectPublishingWorkspace({state,refresh});document.body.append(workspace);
 return workspace;
}

const publicationButton=(root,label)=>[...root.querySelectorAll('button')].find(button=>button.textContent===label);
async function loadPublicationMetadata(workspace,dom) {
 const metadata=workspace.querySelector('.authored-resource-metadata');metadata.open=true;
 metadata.dispatchEvent(new dom.window.Event('toggle'));publicationButton(metadata,'Load metadata record').click();await flush();
 return metadata;
}

it('Publication content save cannot replace a dirty or pending metadata editor',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 let contentSaves=0,refreshes=0,metadataSaves=0,resolveMetadata;
 try {
  const workspace=editablePublicationHost({kind:'managed',getAuthoredKnowledge:async()=>({version:0,canEdit:true,document:empty()}),
   saveAuthoredKnowledge:()=>{metadataSaves++;return new Promise(resolve=>{resolveMetadata=resolve;});},
   updateSite:async()=>{contentSaves++;}},async()=>{refreshes++;workspace.replaceChildren();});
  const metadata=await loadPublicationMetadata(workspace,dom),input=metadata.querySelector('[aria-label="Metadata JSON"]');
  input.value+=' ';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  publicationButton(workspace,'Save draft revision').click();await flush();
  assert.equal(contentSaves,0);assert.equal(refreshes,0);assert.equal(metadata.querySelector('[aria-label="Metadata JSON"]'),input);
  assert.equal(input.value,JSON.stringify(empty(),null,2)+' ');
  publicationButton(metadata,'Save metadata revision').click();
  assert.equal(metadataSaves,1);
  publicationButton(workspace,'Save draft revision').click();await flush();
  assert.equal(contentSaves,0);assert.equal(refreshes,0);assert.equal(metadata.querySelector('[aria-label="Metadata JSON"]'),input);
  resolveMetadata({version:1,canEdit:true,document:empty()});await flush();
  publicationButton(workspace,'Save draft revision').click();await flush();
  assert.equal(contentSaves,1);assert.equal(refreshes,1);
 }finally{globalThis.document=old;dom.window.close();}
});

it('Publication content drafts and an in-flight save block metadata writes until content settles',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 let metadataSaves=0,resolveContent;
 try {
  const adapter={kind:'managed',getAuthoredKnowledge:async()=>({version:0,canEdit:true,document:empty()}),
   saveAuthoredKnowledge:async()=>{metadataSaves++;return {version:1,canEdit:true,document:empty()};},
   updateSite:()=>new Promise(resolve=>{resolveContent=resolve;})};
  const workspace=editablePublicationHost(adapter,async()=>{});
  const metadata=await loadPublicationMetadata(workspace,dom),input=metadata.querySelector('[aria-label="Metadata JSON"]');
  const title=workspace.querySelector('.project-site-revision-editor input');title.value+=' revised';
  title.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal(metadata.querySelector('fieldset').disabled,true,'content draft disables metadata controls');
  publicationButton(metadata,'Save metadata revision').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.equal(metadataSaves,0);
  workspace.remove();
  const cleanWorkspace=editablePublicationHost(adapter,async()=>{}),cleanMetadata=await loadPublicationMetadata(cleanWorkspace,dom);
  const cleanInput=cleanMetadata.querySelector('[aria-label="Metadata JSON"]');
  publicationButton(cleanWorkspace,'Save draft revision').click();assert.equal(typeof resolveContent,'function');
  publicationButton(cleanMetadata,'Save metadata revision').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.equal(metadataSaves,0);assert.equal(cleanMetadata.querySelector('[aria-label="Metadata JSON"]'),cleanInput);
  resolveContent();await flush();
  assert.equal(cleanMetadata.querySelector('[aria-label="Metadata JSON"]'),cleanInput);
  assert.equal(cleanMetadata.querySelector('fieldset').disabled,false);
  publicationButton(cleanMetadata,'Save metadata revision').click();await flush();assert.equal(metadataSaves,1);
 }finally{globalThis.document=old;dom.window.close();}
});

it('Publication saved-source reload and saved build operations preserve metadata drafts and exclude metadata writes',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 let revisionReads=0,metadataSaves=0,builds=0,resolveRead,resolveBuild;
 try {
  const workspace=editablePublicationHost({kind:'managed',getAuthoredKnowledge:async()=>({version:0,canEdit:true,document:empty()}),
   saveAuthoredKnowledge:async()=>{metadataSaves++;return {version:1,canEdit:true,document:empty()};},
   listObservableSourceRevisions:()=>{revisionReads++;return new Promise(resolve=>{resolveRead=resolve;});},
   readObservableSourceRevisionFile:async()=>{throw Error('No matching revision');},
   listObservableBuildJobs:async()=>[],getObservableBuildJob:async()=>null,createObservablePreviewCapability:async()=>null,
   createObservableBuildJob:()=>{builds++;return new Promise(resolve=>{resolveBuild=resolve;});}},
   async()=>{throw Error('Unexpected workspace replacement');},{source:true});
  const metadata=await loadPublicationMetadata(workspace,dom),input=metadata.querySelector('[aria-label="Metadata JSON"]');
  publicationButton(workspace,'Reload saved draft').click();assert.equal(revisionReads,1);
  publicationButton(metadata,'Save metadata revision').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.equal(metadataSaves,0);assert.equal(metadata.querySelector('fieldset').disabled,true);
  resolveRead([]);await flush();assert.equal(metadata.querySelector('fieldset').disabled,false);
  const mode=workspace.querySelector('select[aria-label="Preview mode"]');mode.value='saved';
  mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await flush();
  const build=publicationButton(workspace,'Build saved revision');assert.equal(build.disabled,false);
  build.click();assert.equal(builds,1);
  publicationButton(metadata,'Save metadata revision').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.equal(metadataSaves,0);assert.equal(metadata.querySelector('[aria-label="Metadata JSON"]'),input);
  resolveBuild({id:'build',sourceProjectId:'source',sourceRevisionId:'revision',sourceRevisionNumber:1,purpose:'preview',state:'failed',
   request:{compilerImageDigest:'digest'}});await flush();assert.equal(build.disabled,false);
  input.value+=' ';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  publicationButton(workspace,'Reload saved draft').click();publicationButton(workspace,'Save draft').click();build.click();await flush();
  assert.equal(revisionReads,1);assert.equal(builds,1);assert.equal(metadata.querySelector('[aria-label="Metadata JSON"]'),input);
  assert.equal(input.value,JSON.stringify(empty(),null,2)+' ');
 }finally{globalThis.document=old;dom.window.close();}
});

it('Publication metadata protects its selected card during loading and an unsaved draft',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces?publication=one'}),old=globalThis.document;
 globalThis.document=dom.window.document;
 let resolveRead,guard,saves=0;
 const adapter={kind:'managed',getAuthoredKnowledge:()=>new Promise(resolve=>{resolveRead=resolve;}),
  saveAuthoredKnowledge:async(kind,id,{document})=>{saves++;return {version:1,canEdit:true,document};}};
 try {
  const setup=publicationMetadataHost(adapter);guard=setup.guard;
  const {workspace,ids}=setup,choice=workspace.querySelector('select[aria-label="Publication"]');
  const metadata=workspace.querySelector('.authored-resource-metadata');metadata.open=true;metadata.dispatchEvent(new dom.window.Event('toggle'));
  metadata.querySelector('button').click();
  choice.value=ids[1];choice.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(choice.value,ids[0],'in-flight metadata cannot be hidden by another Publication');
  resolveRead({version:0,canEdit:true,document:empty()});await flush();
  const input=metadata.querySelector('[aria-label="Metadata JSON"]');input.value+=' ';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  choice.value=ids[1];choice.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(choice.value,ids[0],'the metadata draft must remain selected');
  assert.equal(metadata.closest('.project-site-card').hidden,false);
  [...metadata.querySelectorAll('button')].find(button=>button.textContent==='Save metadata revision').click();await flush();
  assert.equal(saves,1);
  choice.value=ids[1];choice.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(choice.value,ids[1],'saving restores ordinary Publication selection');
 }finally{guard?.dispose();globalThis.document=old;dom.window.close();}
});

it('Publication metadata navigation reveals a hidden dirty card instead of only opening its details',async()=>{
 const dom=new JSDOM('<!doctype html>',{url:'https://studio.example.org/workspaces?publication=one'}),old=globalThis.document;
 globalThis.document=dom.window.document;let guard;
 try {
  const setup=publicationMetadataHost({kind:'managed',getAuthoredKnowledge:async()=>({version:0,canEdit:true,document:empty()})});guard=setup.guard;
  const metadata=setup.workspace.querySelector('.authored-resource-metadata');metadata.open=true;metadata.dispatchEvent(new dom.window.Event('toggle'));metadata.querySelector('button').click();await flush();
  const input=metadata.querySelector('[aria-label="Metadata JSON"]');input.value+=' ';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const card=metadata.closest('.project-site-card');card.hidden=true;metadata.open=false;
  const link=document.createElement('a');link.href='/workspaces';document.body.append(link);
  const event=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);
  assert.equal(event.defaultPrevented,true);
  assert.equal(card.hidden,false,'the actual Publication host must reveal the blocked draft');
  assert.equal(metadata.open,true);assert.equal(metadata.querySelector('[aria-label="Metadata JSON"]'),input);
 }finally{guard?.dispose();globalThis.document=old;dom.window.close();}
});
