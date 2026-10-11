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
  assert.equal(calls.length,0);metadata.open=true;metadata.dispatchEvent(new dom.window.Event('toggle'));assert.equal(calls.length,0);
  metadata.querySelector('button').click();await flush();
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
