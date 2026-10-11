import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {CompositionDirectory} from '../src/components/CompositionDirectory.js';
it('lists authored identities, retries pagination without skipping, and searches through the adapter', async () => {
  const dom = new JSDOM('<body></body>'); const previous = globalThis.document; globalThis.document = dom.window.document;
  const calls = []; let fail = true;
  const record = index => ({id:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
    accessContainerId:'20000000-0000-4000-8000-000000000001',accessContainerName:'Shared workspace',
    name:`Project ${index}`,description:null,status:'active',version:1,updatedAt:'2026-09-19T12:00:00Z'});
  const root = CompositionDirectory({adapter:{kind:'api',listCompositions:async options => {
    calls.push(options);
    if(options.query) return [record(99)];
    if(options.offset && fail) throw Error('temporary');
    return options.offset ? [record(51)] : Array.from({length:50},(_,i)=>record(i+1));
  }}});
  document.body.append(root);
  const wait = async predicate => {for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('directory did not settle');};
  try {
    await wait(()=>root.dataset.state==='ready');
    assert.equal(root.querySelectorAll('tbody tr').length,50);
    assert.match(root.querySelector('tbody a').href,/composition=/);
    const more=[...root.querySelectorAll('button')].find(b=>b.textContent==='Load more Projects');more.click();
    await wait(()=>root.dataset.state==='error'); fail=false;
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Retry Projects').click();
    await wait(()=>root.dataset.state==='ready');
    assert.deepEqual(calls.map(c=>c.offset),[0,50,50]);
    assert.equal(root.querySelectorAll('tbody tr').length,51);
    const search=root.querySelector('input');search.value='new search';search.dispatchEvent(new dom.window.Event('input'));
    await wait(()=>calls.at(-1).query==='new search'&&root.dataset.state==='ready');
    assert.equal(calls.at(-1).offset,0);assert.equal(root.querySelectorAll('tbody tr').length,1);
  } finally {root.dispose();globalThis.document=previous;dom.window.close();}
});

it('excludes retained map tests, keeps raw pagination offsets and permits deliberate review', async () => {
  const dom=new JSDOM('<body></body>',{url:'https://studio.opengeo.tools/workspaces'});
  const previous=globalThis.document;globalThis.document=dom.window.document;
  const calls=[];
  const record={id:'10000000-0000-4000-8000-000000000001',accessContainerId:'20000000-0000-4000-8000-000000000001',accessContainerName:'Real project',name:'Real test-named research',status:'active',version:1,updatedAt:'2026-10-09T00:00:00Z'};
  const dummy={...record,id:'696ac547-47c9-4998-8610-a363bdc47d62',name:'Retained map acceptance'};
  const root=CompositionDirectory({adapter:{listCompositions:async options=>{calls.push(options.offset);return options.offset?[record]:Array.from({length:50},()=>dummy);}}});
  try {
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(root.querySelectorAll('tbody tr').length,0);
    root.querySelector('[aria-label="Show testing Projects"]').checked=true;
    root.querySelector('[aria-label="Show testing Projects"]').dispatchEvent(new dom.window.Event('change'));
    assert.equal(root.querySelectorAll('tbody tr').length,1);
    [...root.querySelectorAll('button')].find(n=>n.textContent==='Load more Projects').click();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(calls,[0,50]);
    const related=[...root.querySelectorAll('a')].find(a=>a.textContent==='Related publications');
    assert.equal(new URL(related.href).searchParams.get('projectContext'),record.accessContainerId);
  } finally {root.dispose();globalThis.document=previous;dom.window.close();}
});
