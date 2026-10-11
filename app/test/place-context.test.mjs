import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {PlaceContext, SavedPlaceContexts} from '../src/components/PlaceContext.js';
import {appendPlaceReference, recordedPlaceContexts} from '../src/lib/geographicReferences.js';
const snapshot={provider:'Wikidata',item:'Q3037',sourceUrl:'https://www.wikidata.org/w/api.php',retrievedAt:'2026-09-19T22:00:00Z',entities:{Q3037:{labels:{en:{value:'Kathmandu'}}},Q837:{labels:{en:{value:'Nepal'}}}},relationships:[{subject:'http://www.wikidata.org/entity/Q3037',property:'http://www.wikidata.org/prop/direct/P17',object:'http://www.wikidata.org/entity/Q837'}],unresolved:[]};
it('retains provider context separately and rejects late responses for a changed draft',async()=>{
 const dom=new JSDOM('<body/>');const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  let draft=appendPlaceReference({metadata:{curated:[],normalized:[],inferred:[],source:[{content:' original '}]},distributions:[],context:[]},{name:'Kathmandu',identity:'https://www.wikidata.org/wiki/Q3037',relationship:'http://purl.org/dc/terms/spatial'});
  let finish,busy=false,error='',changed=0,calls=0;
  const root=PlaceContext({readDraft:()=>structuredClone(draft),writeDraft:value=>{draft=value;},setBusy:value=>{busy=value;},onError:value=>{error=value;},onChange:()=>{changed++;},resolve:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});document.body.append(root);
  const click=label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label).click();
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls,0);click('Resolve Wikidata context');assert.equal(busy,true);
  draft.metadata.source.push({content:'new'});finish(snapshot);await tick();assert.match(error,/draft changed/);assert.equal(changed,0);
  click('Resolve Wikidata context');finish(snapshot);await tick();assert.match(root.textContent,/Kathmandu → country → Nepal/);
  assert.equal(changed,0);click('Retain place context in draft');assert.equal(changed,1);
  assert.equal(draft.metadata.curated.length,1);assert.equal(recordedPlaceContexts(draft).length,1);assert.equal(draft.metadata.source[0].content,' original ');
  assert.match(SavedPlaceContexts(draft).textContent,/Kathmandu → country → Nepal/);assert.equal(calls,2);
 } finally {globalThis.document=old;dom.window.close();}
});
