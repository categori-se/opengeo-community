import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {publicationReferenceLinks,PublicationCodeEditor} from '../src/components/PublicationCodeEditor.js';
const id='10000000-0000-4000-8000-000000000001',url='https://studio.opengeo.tools/workspaces?publication='+id;
it('accepts only exact Studio publication routes and deduplicates their UUIDs',()=>{
 const invalid=[url+'&other=1',url+'#fragment',url+'%0A',url.replace('https:','http:'),url.replace('studio.opengeo.tools','studio.opengeo.tools.evil.test'),url.replace('studio.opengeo.tools','user@studio.opengeo.tools'),url.replace('/workspaces','/other'),url.replace('studio.opengeo.tools','studio.opengeo.tools:443'),'/workspaces?publication='+id];
 assert.deepEqual(publicationReferenceLinks(invalid.map(value=>'[Unsafe]('+value+')')),[]);
 assert.deepEqual(publicationReferenceLinks(['[Amsterdam]('+url+')\n[Duplicate]('+url.replace(id,id.toUpperCase())+')']),[{label:'Amsterdam',href:url}]);
});
it('bounds scanning to64KiB and8links and ignores code examples and images',()=>{
 let scanned=0;function* beyondLimit(){scanned++;yield 'x'.repeat(65536);throw Error('Must not inspect a subsequent model beyond the scan budget');}
 assert.deepEqual(publicationReferenceLinks(beyondLimit()),[]);assert.equal(scanned,1);
 assert.deepEqual(publicationReferenceLinks(['😀'.repeat(16384)+'[Too late]('+url+')']),[]);
 const many=Array.from({length:12},(_,index)=>'[Reference '+index+'](https://studio.opengeo.tools/workspaces?publication=00000000-0000-4000-8000-'+String(index).padStart(12,'0')+')');assert.equal(publicationReferenceLinks(many).length,8);
 assert.deepEqual(publicationReferenceLinks(['```md\n[Example]('+url+')\n```\n`[Inline example]('+url+')`\n![Image]('+url+')\n[Real]('+url+')']),[{label:'Real',href:url}]);
});
it('shows safe host-owned links from already-open Markdown models without reads, compile, navigation or source changes',async t=>{
 const dom=new JSDOM('<!doctype html><style>.publication-code-editor{background:rgb(255,255,255)}</style><body></body>',{url:'https://studio.fixture.invalid/'});
 const globals={document:dom.window.document,MutationObserver:dom.window.MutationObserver,DOMParser:dom.window.DOMParser,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),Worker:class{}};
 const prior=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});let fetches=0;
 t.mock.method(globalThis,'fetch',()=>{fetches++;throw Error('No reference-link network reads are allowed');});
 t.after(()=>{dom.window.close();for(const[key,value]of prior){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 let current,changed=()=>{},reads=0,compiles=0,saves=0;
 const view={addCommand(){},onDidChangeCursorPosition(){},onDidChangeModelContent(fn){changed=fn;},updateOptions(){},saveViewState(){return{};},restoreViewState(){},getModel:()=>current,getValue:()=>current?.getValue()??'',setModel(model){current=model;},executeEdits(_,edits){current.setValue(edits[0].text);changed();},dispose(){}};
 const kit={renderMarkdown:()=>'<p>Local unchanged preview</p>',monaco:{KeyMod:{CtrlCmd:1},KeyCode:{KeyS:2},Uri:{from:value=>value},editor:{create:()=>view,setTheme(){},createModel(value,language,uri){return{uri,getValue:()=>value,setValue(next){value=next;},dispose(){}};}}}};
 const textarea=document.createElement('textarea'),index='[<img src=x onerror=alert(1)>]('+url+')';textarea.value=index;
 const editor=PublicationCodeEditor({textarea,onSave(){saves++;},loadEditor:async()=>kit,loadCellTools:async()=>({}),draftPreviewEnabled:false,getSourceContext:()=>({readFile(){reads++;throw Error('Reference bar must not read files');}}),loadFramework:async()=>{compiles++;throw Error('Reference bar must not compile');}});
 document.body.append(textarea,editor.element,editor.cells,editor.preview);await editor.open('src/index.md',textarea.value);
 const nav=editor.preview.querySelector('nav[aria-label="Reference publications"]'),anchor=nav.querySelector('a'),frame=editor.preview.querySelector('iframe');assert.equal(nav.hidden,false);assert.equal(anchor.ownerDocument,document);assert.equal(anchor.textContent,'<img src=x onerror=alert(1)>');assert.equal(nav.querySelector('img'),null);assert.equal(anchor.href,url);assert.equal(anchor.target,'_blank');assert.equal(anchor.rel,'noopener noreferrer');assert(nav.compareDocumentPosition(frame)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING);assert.equal(textarea.value,index);
 textarea.value='# City page with no reference URL';await editor.open('src/cities/kathmandu.md',textarea.value);assert.equal(nav.querySelector('a').href,url,'The index reference remains in the already-open Markdown model');
 textarea.value='[Updated reference]('+url+')';await editor.open('src/index.md',textarea.value);textarea.dispatchEvent(new dom.window.Event('input'));assert.equal(nav.querySelector('a').textContent,'Updated reference');
 assert.equal(frame,editor.preview.querySelector('iframe'));assert.deepEqual({fetches,reads,compiles,saves},{fetches:0,reads:0,compiles:0,saves:0});
 editor.reset();assert(nav.hidden);assert.equal(nav.querySelectorAll('a').length,0);editor.dispose();
});
