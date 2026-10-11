import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {LocationHierarchy} from '../src/components/LocationHierarchy.js';
it('retains a failed parent draft and inspects redacted history without revealing a target',async()=>{
 const dom=new JSDOM('<body></body>');const old=globalThis.document;globalThis.document=dom.window.document;
 let dirty=false,error,submitted;
 const id='10000000-0000-4000-8000-000000000001',parent='10000000-0000-4000-8000-000000000002';
 const root=LocationHierarchy({id,role:'owner',onDirty:v=>{dirty=v;},feedback:()=>{},run:async f=>{try{await f();}catch(e){error=e;}},adapter:{kind:'api',
  getLocationParent:async()=>({revision:1,currentRevision:1,parentAvailable:false}),
  listLocations:async()=>[{id:parent,title:'District'}],setLocationParent:async(_,body)=>{submitted=body;throw Object.assign(Error(),{status:409});}}});document.body.append(root);
 const click=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label).click();
 const wait=async f=>{for(let i=0;i<40;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail('not settled');};
 try{
  click('Load parent relationship');await wait(()=>root.textContent.includes('Parent unavailable'));
  assert.equal(root.querySelectorAll('a').length,0);
  click('Browse parent Geographic tags');await wait(()=>root.querySelector('select').options.length===2);
  const select=root.querySelector('select');select.value=parent;select.dispatchEvent(new dom.window.Event('change'));
  click('Save parent relationship');await wait(()=>error);assert.equal(dirty,true);assert.equal(select.value,parent);assert.equal(submitted.revision,1);
  click('Inspect parent history');await wait(()=>root.textContent.includes('Historical parent relationship'));assert.equal(dirty,true);assert.equal(select.value,parent);
  assert.equal(root.querySelectorAll('a').length,0);
 }finally{globalThis.document=old;dom.window.close();}
});
