import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {releaseDraftGuard} from '../src/lib/releaseDraftGuard.js';
it('blocks leaving, account changes and Back only while the connected release form is open',async()=>{
 const dom=new JSDOM('<main><section><dialog></dialog></section><a href="/other">Leave</a><button class="gis-account-command">Sign out</button><select aria-label="Studio account"><option>a</option><option>b</option></select></main>',{url:'https://studio.example/workspaces?composition=one'});
 const document=dom.window.document,root=document.querySelector('section'),dialog=document.querySelector('dialog');let notices=0;
 const guard=releaseDraftGuard(root,dialog,()=>notices++);
 try{
  guard.open();dialog.open=true;
  for(const element of [document.querySelector('a'),document.querySelector('button')]){
   assert.equal(element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})),false);
  }
  const account=document.querySelector('select');account.value='b';let changed=false;
  account.addEventListener('change',()=>{changed=true;});account.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(account.value,'a');assert.equal(changed,false);
  dom.window.history.pushState(null,'','/other');dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  assert.equal(dom.window.location.pathname,'/workspaces');assert.equal(dom.window.location.search,'?composition=one');
  assert.equal(dom.window.dispatchEvent(new dom.window.Event('beforeunload',{cancelable:true})),false);
  assert.ok(notices>=4);assert.equal(guard.pending(),true);
  dialog.open=false;assert.equal(guard.check(),false);
  account.value='b';account.dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(changed,true);
  root.remove();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(dom.window.dispatchEvent(new dom.window.Event('beforeunload',{cancelable:true})),true);
 }finally{guard.dispose();dom.window.close();}
});
