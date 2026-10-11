import assert from 'node:assert/strict';
import {it} from 'node:test';
import {appendProviderContext, providerObservation, providerExplore, recordedProviderContexts} from '../src/lib/providerContext.js';
it('preserves source knowledge and unknown rights while retaining safe manual references',()=>{
 const original={context:[],metadata:{source:[{nested:{untouched:null}}],curated:[]}};
 const next=appendProviderContext(original,{provider:'mapillary',identifier:'123',confidence:0});
 assert.equal(original.context.length,0);assert.deepEqual(next.metadata.source,original.metadata.source);
 assert.equal(next.metadata.curated[0].value.license,null);
 assert.equal(next.metadata.curated[0].value.verification,'user_supplied_unverified');
 assert.equal(recordedProviderContexts(next)[0].confidence,0);
 assert.throws(()=>appendProviderContext(next,{provider:'mapillary',identifier:'123'}),/already/);
 for(const provider of ['toString','__proto__','unknown']) assert.throws(()=>providerObservation(provider,'123'));
 assert.throws(()=>providerObservation('mapillary','123&token=secret'));
 assert.deepEqual(recordedProviderContexts({context:[{resourceId:'javascript:alert(1)'}]}),[]);
 assert.equal(providerExplore('kartaview',{type:'Point',coordinates:[-71,42]}),'https://kartaview.org/map/@42,-71,15z');
});

it('renders saved references for readers and retains pending edits until added or cleared',async()=>{
 const {JSDOM}=await import('jsdom');const {ProviderContext}=await import('../src/components/ProviderContext.js');
 const dom=new JSDOM('<body></body>'),previous=globalThis.document;globalThis.document=dom.window.document;
 let knowledge={context:[],metadata:{curated:[]}},pending=false;
 try {
  const options={geometry:null,getKnowledge:()=>knowledge,setKnowledge:v=>{knowledge=v;},onPending:v=>{pending=v;},feedback:()=>{},canEdit:true};
  const root=ProviderContext(options);document.body.append(root);
  const id=root.querySelector('[aria-label="Provider observation identifier"]');id.value='123';id.dispatchEvent(new dom.window.Event('input'));assert.equal(pending,true);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Add provider reference to draft').click();
  assert.equal(pending,false);assert.equal(root.querySelectorAll('li').length,1);
  const reader=ProviderContext({...options,canEdit:false});assert.equal(reader.querySelectorAll('input,button').length,0);
  assert.equal(reader.querySelectorAll('li a').length,1);assert.equal(reader.querySelector('li a').rel,'noopener noreferrer');
  assert.equal(reader.querySelectorAll('img,iframe').length,0);
 } finally {globalThis.document=previous;dom.window.close();}
});
