import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {LocationResourceLinks} from '../src/components/LocationResourceLinks.js';
it('retains hidden entries and pending assertions through conflict recovery',async()=>{
 const dom=new JSDOM('<body></body>'), previous=globalThis.document;globalThis.document=dom.window.document;
 const id='10000000-0000-4000-8000-000000000001';let dirty=false,feedback='',sent,error;
 const adapter={kind:'api',getLocationLinks:async()=>({revision:2,currentRevision:2,entries:[{entry_id:id,available:false}]}),
  searchDatasets:async()=>[{id:'10000000-0000-4000-8000-000000000002',name:'Survey'}],saveLocationLinks:async(_,body)=>{sent=structuredClone(body);throw Object.assign(Error(),{status:409});}};
 const root=LocationResourceLinks({adapter,id,role:'owner',onDirty:value=>{dirty=value;},feedback:value=>{feedback=value;},run:async f=>{try{await f();}catch(e){error=e;}}});document.body.append(root);
 const click=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label).click();
 const wait=async f=>{for(let i=0;i<50;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 try{
  click('Load resource links');await wait(()=>root.querySelector('ol'));
  assert.equal(root.querySelectorAll('a').length,0);
  click('Browse related resources');await wait(()=>root.querySelector('[aria-label="Related resource"]').options.length===1);
  const evidence=root.querySelector('textarea');evidence.value='urn:survey:evidence';evidence.dispatchEvent(new dom.window.Event('input'));
  click('Save resource links');assert.match(feedback,/pending relationship/);assert.equal(sent,undefined);
  click('Add resource link');assert.equal(root.querySelectorAll('ol li').length,2);
  click('Save resource links');await wait(()=>error);assert.equal(dirty,true);assert.deepEqual(sent.entries[0],{entry_id:id,available:false});
  assert.deepEqual(sent.entries[1].evidence,['urn:survey:evidence']);assert.equal(root.querySelectorAll('ol li').length,2);
  click('Inspect resource link history');await wait(()=>root.querySelector('h5'));assert.equal(dirty,true);
 }finally{globalThis.document=previous;dom.window.close();}
});
