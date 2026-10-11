import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {DatasetVersionFiles} from '../src/components/DatasetVersionFiles.js';
const dataset={id:'layer',projectId:'project',capabilities:{download:true}};
const version={id:'old-version',versionNumber:1,qualityResults:{warnings:[{code:'working_parquet_measured_extension',message:'Measured Parquet reader compatibility is not established.'}]},objects:[{id:'working',role:'working',filename:'data.parquet',contentType:'application/vnd.apache.parquet',sizeBytes:123,checksumSha256:'a'.repeat(64)}]};
it('shows retained warnings and signs only the deliberately selected exact object',async()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 let root;
 try{
  const calls=[];root=DatasetVersionFiles({dataset,version,adapter:{requestDatasetDownload:async(...args)=>{calls.push(args);return {url:'https://storage.example/exact?versionId=one',expiresAt:new Date(Date.now()+60000).toISOString()};}}});
  assert.equal(calls.length,0);assert.equal(root.querySelector('a'),null);assert.match(root.textContent,/reader compatibility/);
  await root.querySelector('button').onclick();assert.deepEqual(calls,[['project','layer','old-version','working']]);
  assert.match(root.querySelector('a').href,/versionId=one/);assert.equal(root.querySelector('a').referrerPolicy,'no-referrer');
 }finally{root?.dispose();globalThis.document=old;dom.window.close();}
});
it('hides downloads for readers and never exposes denied, expired or late tickets',async()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 try{
  const reader=DatasetVersionFiles({dataset:{...dataset,capabilities:{download:false}},version,adapter:{requestDatasetDownload:()=>{throw Error('should not run');}}});assert.equal(reader.querySelector('button'),null);
  for(const ticket of [{url:'https://storage.example/',expiresAt:'invalid'},{url:'https://storage.example/',expiresAt:'2000-01-01'},null]){
   const root=DatasetVersionFiles({dataset,version,adapter:{requestDatasetDownload:async()=>{if(!ticket)throw {status:403};return ticket;}}});
   await root.querySelector('button').onclick();assert.equal(root.querySelector('a'),null);root.dispose();
  }
  let resolve;const root=DatasetVersionFiles({dataset,version,adapter:{requestDatasetDownload:()=>new Promise(done=>{resolve=done;})}});
  const pending=root.querySelector('button').onclick();root.dispose();resolve({url:'https://storage.example/',expiresAt:new Date(Date.now()+60000).toISOString()});await pending;assert.equal(root.querySelector('a'),null);
 }finally{globalThis.document=old;dom.window.close();}
});


it('previews a checksum-pinned non-spatial CSV on demand, keeping blanks and quoted text',async()=>{
 const {CatalogTablePreview}=await import('../src/components/CatalogTablePreview.js');
 const {createHash}=await import('node:crypto');
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 const bytes=new TextEncoder().encode('area,households,note\nBhaktapur,17639,"quoted, value"\n"<img src=x onerror=alert(1)>",,"two\nlines"\n');
 const object={id:'csv',filename:'households.csv',sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')};
 let root;
 try{
  const calls=[];let reads=0;
  root=CatalogTablePreview({dataset,version,object,adapter:{requestDatasetDownload:async(...args)=>{calls.push(args);return {url:'https://storage.example/exact?versionId=csv',expiresAt:new Date(Date.now()+60000).toISOString()};}},fetchImplementation:async()=>{reads++;return new Response(bytes);}});
  assert.equal(reads,0);assert.equal(calls.length,0);
  await root.querySelector('button').onclick();
  assert.deepEqual(calls,[['project','layer','old-version','csv']]);assert.equal(reads,1);
  assert.equal(root.querySelector('tbody').rows.length,2);assert.equal(root.querySelector('tbody').rows[1].cells[1].textContent,'');assert.equal(root.querySelector('tbody').rows[0].cells[2].textContent,'quoted, value');assert.equal(root.querySelector('img'),null);assert.match(root.textContent,/checksum verified/);assert.match(root.textContent,/No geometry inferred/);
  await root.querySelector('button').onclick();await root.querySelector('button').onclick();assert.equal(reads,1);
 }finally{root?.dispose();globalThis.document=old;dom.window.close();}
});
it('refuses changed CSV bytes and denied access, and discards a disposed preview',async()=>{
 const {CatalogTablePreview}=await import('../src/components/CatalogTablePreview.js');
 const {createHash}=await import('node:crypto');
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 const bytes=new TextEncoder().encode('a,b\n1,2\n');const object={id:'csv',filename:'table.csv',sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')};
 try{
  for(const denied of [false,true]){
   const root=CatalogTablePreview({dataset,version,object,adapter:{requestDatasetDownload:async()=>{if(denied)throw {status:403};return {url:'https://storage.example/exact',expiresAt:new Date(Date.now()+60000).toISOString()};}},fetchImplementation:async()=>new Response('a,b\n3,4\n')});
   await root.querySelector('button').onclick();assert.equal(root.querySelector('table'),null);assert.match(root.textContent,/unavailable/);root.dispose();
  }
  let complete;let reads=0;const root=CatalogTablePreview({dataset,version,object,adapter:{requestDatasetDownload:()=>new Promise(resolve=>{complete=resolve;})},fetchImplementation:async()=>{reads++;return new Response(bytes);}});
  const pending=root.querySelector('button').onclick();root.dispose();complete({url:'https://storage.example/exact',expiresAt:new Date(Date.now()+60000).toISOString()});await pending;assert.equal(reads,0);assert.equal(root.querySelector('table'),null);
 }finally{globalThis.document=old;dom.window.close();}
});

it('reads recorded PDF text deliberately with read authority, without requesting a download',async()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 let root;
 try{
  const calls=[];const adapter={getDatasetDocumentPreview:async(...args)=>{calls.push(args);return {sourceFormat:'pdf',pdfVersion:'1.7',extraction:{ocrPerformed:false},pages:[{number:1,blocks:[{type:'paragraph',text:'Households <script>remain text</script>'}]}]};}};
  const pdf={...dataset,format:'pdf',capabilities:{read:true,download:false}};
  const recorded={...version,objects:[],schemaDefinition:{document:{accessible_preview_schema:'opengeo.document-preview.1.0.0'}}};
  root=DatasetVersionFiles({dataset:pdf,version:recorded,adapter});assert.equal(calls.length,0);
  await root.querySelector('button').onclick();assert.deepEqual(calls,[['project','layer','old-version']]);
  assert.match(root.textContent,/Reading order is heuristic/);assert.match(root.textContent,/Households <script>/);assert.equal(root.querySelector('script'),null);
  await root.querySelector('button').onclick();await root.querySelector('button').onclick();assert.equal(calls.length,1);
  const denied=DatasetVersionFiles({dataset:{...pdf,capabilities:{read:false}},version:recorded,adapter});assert.equal(denied.querySelector('button'),null);denied.dispose();
 }finally{root?.dispose();globalThis.document=old;dom.window.close();}
});
