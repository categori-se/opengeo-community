import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {whenConnected} from '../src/lib/whenConnected.js';
it('starts a deferred view exactly once after attachment, and supports cancellation',async()=>{
 const dom=new JSDOM('<main></main>'),document=dom.window.document;
 const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
 try{
  const element=document.createElement('section');let starts=0;
  whenConnected(element,()=>{assert.equal(element.isConnected,true);starts++;});
  await flush();assert.equal(starts,0);document.querySelector('main').append(element);await flush();assert.equal(starts,1);
  element.remove();document.body.append(element);await flush();assert.equal(starts,1);
  const abandoned=document.createElement('section');const cancel=whenConnected(abandoned,()=>starts++);await flush();cancel();document.body.append(abandoned);await flush();assert.equal(starts,1);
  whenConnected(element,()=>starts++);await flush();assert.equal(starts,2);
 }finally{dom.window.close();}
});
