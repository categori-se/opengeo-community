import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {AuthoredResourceMetadata, guardAuthoredMetadata} from '../src/components/AuthoredResourceMetadata.js';
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
