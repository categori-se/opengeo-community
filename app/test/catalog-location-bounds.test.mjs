import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {CatalogLocationBounds} from '../src/components/CatalogLocationBounds.js';
it('keeps manual edits when an authorized Geographic tag read finishes late',async()=>{
 const dom=new JSDOM('<body></body>'),previous=globalThis.document;globalThis.document=dom.window.document;
 let finish,applied=false,draft='';
 try {
  const root=CatalogLocationBounds({adapter:{listLocations:async()=>[{id:'place',title:'Place'}],getLocation:()=>new Promise(resolve=>{finish=resolve;})},getDraft:()=>draft,applyBounds:()=>{applied=true;return true;}});document.body.append(root);
  const click=label=>[...root.querySelectorAll('button')].find(button=>button.textContent===label).click();
  click('Load Geographic tags');await new Promise(resolve=>setTimeout(resolve,0));
  const select=root.querySelector('select');select.value='place';select.dispatchEvent(new dom.window.Event('change'));
  click('Use Geographic tag bounds');draft='10,20,30,40';finish({document:{title:'Place',geometry:{type:'Point',coordinates:[-71,42]}},revision:1});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(applied,false);assert.match(root.textContent,/bounds changed while loading/);
 }finally{globalThis.document=previous;dom.window.close();}
});
