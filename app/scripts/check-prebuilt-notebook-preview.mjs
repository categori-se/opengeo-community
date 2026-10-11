import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {unzipSync} from 'fflate';
const cellsRequested=process.argv.includes('--cells'),args=process.argv.slice(2).filter(value=>value!=='--cells');
assert.equal(args.length,2,'Usage: check-prebuilt-notebook-preview.mjs DIST RECEIPT [--cells]');
const dist=await realpath(resolve(args[0])),output=resolve(args[1]);assert.ok(!existsSync(output));
const startedAt=new Date().toISOString(),batch={closes:cellsRequested?['AUTHOR-001: built Files ZIP destination data/archive and map alias choices through local Save/reopen','AUTHOR-001C: one retained upstream compiled export with child/CSV/notice through built Files review/local Save/reopen']:['AUTHOR-001: exact prebuilt notebook review and preview'],reuses:['Existing maintained prebuilt checker, local adapter and actual Files controls','Supplied frozen Studio build/editor assets; no bundling','Retained exact upstream Bar Chart527 source hashes; no fetch'],limits:{browserRuns:1,localSourceSaves:cellsRequested?2:0,localReferenceSaves:cellsRequested?1:0,upstreamExamples:cellsRequested?1:0,externalRequests:0,newBuilds:0,cloudCalls:0},stop_condition:'Stop at first concrete regression; preserve the failed receipt. At most one diagnosed retry with a separate receipt; no hosted writes, rebuild, runtime packaging or automatic replay.'};
const manifest=JSON.parse(await readFile(resolve(dist,'editor-assets/manifest.json'))),path=resolve(dist,'editor-assets',manifest.notebookPreview),bytes=await readFile(path);
const components=await readdir(resolve(dist,'_import/components'));
const reviewModule=components.find(name=>/^NotebookImportReview\.[\w]+\.js$/.test(name));
assert.ok(reviewModule,'The built notebook import review must be present');
const editorModule=components.find(name=>/^PublicationCodeEditor\.[\w]+\.js$/.test(name));
const cellModule=components.find(name=>/^NotebookCellEditor\.[\w]+\.js$/.test(name));
const workspaceModule=components.find(name=>/^ProjectSites\.[\w]+\.js$/.test(name));
let styles=[];
if(cellsRequested){
 assert.ok(editorModule&&cellModule&&workspaceModule,'--cells requires the built cell, Publication and Files editors');
 const html=await readFile(resolve(dist,'workspaces.html'),'utf8');
 styles=[...new Set([...html.matchAll(/href="([^"]+\.css)"/g)].map(match=>new URL(match[1],'https://notebook-candidate.invalid/workspaces.html').pathname))];
 assert.ok(styles.some(path=>path.startsWith('/_file/style.')),'Use the exact built Studio styles');
}
const assets=new Map([
 ['/compiler.js',{contentType:'text/javascript',body:bytes}],
 ['/editor-assets/'+manifest.notebookPreview,{contentType:'text/javascript',body:bytes}],
 ['/editor-assets/manifest.json',{contentType:'application/json',body:JSON.stringify(manifest)}]
]);
for(const name of components.filter(name=>/^(NotebookImportReview|ObservableNotebookPreview)\.[\w]+\.js$/.test(name))) {
 assets.set('/_import/components/'+name,{contentType:'text/javascript',body:await readFile(resolve(dist,'_import/components',name))});
}
const origin='https://notebook-candidate.invalid',blocked=[],errors=[],unexpected=[];let browser,page,cellReceipt,authoringReceipt,journeyStage='native compiler and import review';
const legacySource='\uFEFF'+[
   'function _amount(Inputs) { return Inputs.range([0,10], {label:"Legacy count",value:2,step:1}); }',
   'function _count(amount) { return amount; }',
   'function _data(FileAttachment) { return FileAttachment("data.json").json(); }',
   'function _increment(alias) { const button=document.createElement("button"); button.textContent="Increment mutable"; button.onclick=()=>++alias["value"]; return button; }',
   'function _result(amount,count,data,globalThis) { globalThis.legacySandboxExecuted=true; const heading=document.createElement("h1"); heading.textContent="Legacy result "+(amount+count+data[0]); return heading; }',
   'export default function define(runtime, observer) {',
   'const main = runtime.module();',
   'const fileAttachments = new Map([["data.json", new URL("./files/data-hash", import.meta.url)]]);',
   'main.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));',
   'main.variable(observer("viewof amount")).define("viewof amount", ["Inputs"], _amount);',
   'main.variable(observer("amount")).define("amount", ["Generators", "viewof amount"], (G, control) => G.input(control));',
   'main.define("initial count", ["amount"], _count);',
   'main.variable(observer("mutable count")).define("mutable count", ["Mutable", "initial count"], (M, value) => new M(value));',
   'main.variable(observer("count")).define("count", ["mutable count"], value => value.generator);',
   'main.variable(observer("data")).define("data", ["FileAttachment"], _data);',
   'main.variable(observer("increment")).define("increment", ["mutable count"], _increment);',
   'main.variable(observer("result")).define("result", ["amount", "count", "data", "globalThis"], _result);',
   'return main;',
   '}',
   ''
  ].join('\r\n');
// One exact retained upstream example; no provider fetch or runtime packaging.
let upstream;
if(cellsRequested){
 const root=new URL('../../.local-archives/renderer-switch-20260930/upstream-notebook/',import.meta.url);
 const pin=JSON.parse(await readFile(new URL('source-receipt.json',root)));
 assert.equal(pin.archiveSha256,'ac96d07191fa03d0a90509d4110d22076a704dd5f5eba145d36ab24cfe237d4a');
 const selected=pin.files.filter(record=>['./09403b146bada149@527.js','./7a9e12f9fb3d8e06@517.js','./LICENSE.txt'].includes(record.path)||record.path.startsWith('./files/')&&record.path.endsWith('.csv'));
 assert.equal(selected.length,4);
 const originals=await Promise.all(selected.map(async record=>{const bytes=await readFile(new URL('export/'+record.path.slice(2),root));assert.equal(bytes.length,record.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256);return {path:record.path.slice(2),bytes:[...bytes],sha256:record.sha256};}));
 upstream={version:'527.0.0',main:'09403b146bada149@527.js',originals};
}
await writeFile(output,JSON.stringify({status:'started',startedAt,...batch},null,2)+'\n');
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/lib64/chromium-browser/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 const context=await browser.newContext();await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin!==origin){blocked.push(u.href);return route.abort();}
  if(route.request().method()!=='GET'){unexpected.push(route.request().method()+' '+u.pathname);return route.abort();}
  if(assets.has(u.pathname))return route.fulfill(assets.get(u.pathname));
  if(cellsRequested&&/^\/(?:_import|_npm|_node|_file|_observablehq|editor-assets)\//.test(u.pathname)){
   try{
    const file=await realpath(resolve(dist,'.'+decodeURIComponent(u.pathname)));
    assert.ok(file.startsWith(dist+sep),'Asset must remain inside the supplied build');
    const contentType=({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]??'application/octet-stream';
    const asset={contentType,body:await readFile(file)};assets.set(u.pathname,asset);return route.fulfill(asset);
   }catch{unexpected.push(u.pathname);return route.abort();}
  }
  if(u.pathname!=='/'){unexpected.push(u.pathname);return route.abort();}
  return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><iframe title="Notebook" sandbox="allow-scripts"></iframe>'});
 });
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('console',message=>{if(message.type()==='error')console.error('Browser console:',message.text());});await page.goto(origin);
 if(cellsRequested){
  journeyStage='legacy fixture preflight with exact built converter';
  const preflight=await page.evaluate(async source=>{const {convertLegacyNotebook}=await import('/compiler.js');
   const result=convertLegacyNotebook({source,path:'invented-export.js',title:'Invented reactive import',availablePaths:['files/data-hash']});
   return {cells:result.report.convertedCells,groups:result.report.reactiveGroups.length};
  },legacySource);
  assert.deepEqual(preflight,{cells:5,groups:2});
 }
 await page.evaluate(async()=>{
  const {renderNotebookDocument}=await import('/compiler.js');
  const source='<notebook><title>Candidate notebook</title><script id="1" type="module">const n = view(Inputs.range([0,10], {label:"Count",value:2,step:1}));</script><script id="2" type="module">const rows = await FileAttachment("rows.json").json();</script><script id="3" type="text/html"><h1>Result ${n + rows[0]}</h1></script></notebook>';
  document.querySelector('iframe').srcdoc=await renderNotebookDocument({source,path:'index.html',readFile:async path=>{if(path!=='rows.json')throw Error('Unexpected attachment');return new Blob(['[3]'],{type:'application/json'});}});
 });
 const frame=page.frameLocator('iframe');await frame.getByRole('heading',{name:'Result 5',exact:true}).waitFor({timeout:15000});
 await frame.locator('input[type=range]').fill('4');await frame.getByRole('heading',{name:'Result 7',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>{try{document.querySelector('iframe').contentWindow.document;return false;}catch{return true;}}),true);
 const sources={
  observable:'<img src="https://external.invalid/should-not-load.png"><script>globalThis.inspectionExecuted=true</script><notebook><title>Import review</title><script id="1" type="module">globalThis.inspectionExecuted=true; const rows=FileAttachment("rows.json");</script><script id="2" type="module">import x from "unbundled-library"; const missing=FileAttachment("missing.csv");</script></notebook>',
  jupyter:JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{kernelspec:{language:'python'}},cells:[
   {cell_type:'markdown',metadata:{},source:'![missing](missing.png)'},
   {cell_type:'code',metadata:{},source:'globalThis.inspectionExecuted=true',execution_count:null,outputs:[
    {output_type:'stream',name:'stdout',text:'Saved output'},
    {output_type:'display_data',data:{'application/vnd.jupyter.widget-view+json':{model_id:'example'}},metadata:{}}
   ]}
  ]})
 };
 await page.evaluate(async({reviewModule,sources})=>{
  const {NotebookImportReview}=await import('/_import/components/'+reviewModule);
  globalThis.inspectionSource={path:'index.html',source:sources.observable,availablePaths:['index.html','rows.json']};
  globalThis.importReview=NotebookImportReview({getSource:()=>globalThis.inspectionSource});
  document.body.append(importReview.element);importReview.update();
 },{reviewModule,sources});
 await page.getByText('Notebook import review',{exact:true}).click();
 await page.getByRole('button',{name:'Review notebook import',exact:true}).click();
 await page.getByRole('status').filter({hasText:'index.html · 2 cells. Source files remain unchanged.'}).waitFor();
 assert.match(await page.locator('.notebook-import-review').innerText(),/rows.json · path present/);
 assert.match(await page.locator('.notebook-import-review').innerText(),/missing.csv · path missing/);
 assert.match(await page.locator('.notebook-import-review').innerText(),/unbundled-library · not bundled/);
 assert.equal(await page.evaluate(()=>globalThis.inspectionSource.source),sources.observable);
 assert.equal(await page.evaluate(()=>globalThis.inspectionExecuted),undefined);
 await page.evaluate(source=>{
  globalThis.inspectionSource={path:'index.ipynb',source,availablePaths:['index.ipynb']};
  importReview.update();
 },sources.jupyter);
 assert.equal(await page.getByRole('heading',{name:'Cells',exact:true}).count(),0,'Changing the selected source clears the previous report');
 await page.getByRole('button',{name:'Review notebook import',exact:true}).click();
 await page.getByRole('status').filter({hasText:'index.ipynb · 2 cells. Source files remain unchanged.'}).waitFor();
 const jupyterReview=await page.locator('.notebook-import-review').innerText();
 assert.match(jupyterReview,/2 outputs: 1 have a supported representation; 1 need review/);
 assert.match(jupyterReview,/Code dependency discovery is not performed/);
 assert.match(jupyterReview,/missing.png · path missing/);
 assert.equal(await page.evaluate(()=>globalThis.inspectionSource.source),sources.jupyter);
 assert.equal(await page.evaluate(()=>globalThis.inspectionExecuted),undefined);
 if(cellsRequested){
  journeyStage='native cell authoring';
  await page.evaluate(async({editorModule,styles})=>{
   document.body.replaceChildren(); // Complete review first; show the authoring journey in its actual viewport.
   for(const href of styles){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
   const {PublicationCodeEditor}=await import('/_import/components/'+editorModule);
   const host=document.createElement('section');host.id='cell-journey';host.className='project-publishing-workspace';
   const fieldset=document.createElement('fieldset');fieldset.className='observable-source-revision-editor';
   const layout=document.createElement('div');layout.className='source-editor-layout';
   const aside=document.createElement('aside');aside.textContent='index.html';
   const main=document.createElement('div');main.className='source-editor-main';
   const textarea=document.createElement('textarea');textarea.setAttribute('aria-label','Canonical notebook source');
   textarea.value='<notebook data-preserve="original"><title>Cell authoring</title><script id="11" type="module" pinned data-cell="keep">globalThis.cellSandboxExecuted=true; const n=view(Inputs.range([0,10], {label:"Count",value:2,step:1}));</script><script id="12" type="module">const rows=await FileAttachment("rows.json").json();</script><script id="19" type="text/html"><h1>Cell result ${n+rows[0]}</h1></script><script id="25" type="text/markdown"></script></notebook>';
   globalThis.cellSaveRequests=0;
   const editor=PublicationCodeEditor({textarea,onSave:()=>{globalThis.cellSaveRequests++;},getSourceContext:()=>({readFile:async path=>{
    if(path!=='rows.json')throw Error('Unexpected attachment');return new Blob(['[3]'],{type:'application/json'});
   }})});
   main.append(editor.tabs,textarea,editor.cells,editor.element,editor.status);layout.append(aside,main,editor.preview);fieldset.append(layout);host.append(fieldset);document.body.append(host);
   globalThis.cellEditor=editor;globalThis.cellSource=textarea;
   await editor.open('index.html',textarea.value);
  },{editorModule,styles});
  const editor=page.locator('#cell-journey'),cells=editor.locator('.notebook-cell-editor');
  const live=page.frameLocator('#cell-journey iframe[title="Observable Notebook live preview"]');
  await cells.getByLabel('Cell source',{exact:true}).waitFor({state:'visible'});
  await editor.locator('iframe').scrollIntoViewIfNeeded(); // Notebook Runtime waits for visible cell observers.
  try{await live.getByRole('heading',{name:'Cell result 5',exact:true}).waitFor({timeout:15000});}
  catch(error){
   console.error(JSON.stringify({errors,unexpected,blocked,editor:await editor.innerText(),frames:await Promise.all(page.frames().map(async frame=>({url:frame.url(),text:await frame.locator('body').innerText().catch(()=>'' )})))}));
   throw error;
  }
  await cells.getByLabel('Cell source',{exact:true}).fill('globalThis.cellSandboxExecuted=true; const n=view(Inputs.range([0,10], {label:"Count",value:4,step:1}));');
  await editor.locator('iframe').scrollIntoViewIfNeeded();
  await live.getByRole('heading',{name:'Cell result 7',exact:true}).waitFor({timeout:15000});
  await live.locator('input[type=range]').fill('6');await live.getByRole('heading',{name:'Cell result 9',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.cellSandboxExecuted),undefined,'Authored scripts must not execute on the editor origin');
  assert.equal(await page.evaluate(()=>{try{document.querySelector('#cell-journey iframe').contentWindow.document;return false;}catch{return true;}}),true);
  assert.equal(await editor.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  await cells.getByRole('button',{name:'Source',exact:true}).click();
  const monaco=editor.locator('.publication-code-editor .monaco-editor');await monaco.waitFor({state:'visible'});
  await monaco.click({position:{x:140,y:60}});await page.keyboard.press('Control+End');await page.keyboard.insertText('\n<!-- source note retained -->');
  assert.equal(await page.evaluate(async editorAsset=>{
   const {monaco}=await import('/editor-assets/'+editorAsset);return monaco.editor.getModels().some(model=>model.getValue()===cellSource.value);
  },manifest.editor),true,'Cells edits and real Monaco must share the canonical source');
  await cells.getByRole('button',{name:'Cells',exact:true}).click();
  await cells.getByLabel('Cell source',{exact:true}).waitFor({state:'visible'});
  const retained=await page.evaluate(()=>cellSource.value);
  assert.match(retained,/value:4/);assert.match(retained,/source note retained/);
  assert.match(retained,/data-preserve="original"/);assert.match(retained,/pinned data-cell="keep"/);
  const ids=()=>cells.getByLabel('Notebook cell',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>Number(option.value)));
  assert.deepEqual(await ids(),[11,12,19,25]);
  await cells.getByRole('button',{name:'Add cell',exact:true}).click();
  assert.equal(await cells.getByLabel('Cell source',{exact:true}).inputValue(),'');
  assert.deepEqual(await ids(),[11,26,12,19,25]);
  await cells.getByRole('button',{name:'Undo cell change',exact:true}).click();
  assert.equal(await page.evaluate(()=>cellSource.value),retained,'Undo retains the exact edited source, original IDs and unknown attributes');
  assert.deepEqual(await ids(),[11,12,19,25]);
  await page.setViewportSize({width:390,height:844});
  await cells.getByLabel('Cell source',{exact:true}).waitFor({state:'visible'});
  const bounds=await cells.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=391,'Cell controls fit a narrow viewport');
  assert.equal(await page.evaluate(()=>globalThis.cellSaveRequests),0,'Cell authoring must not save implicitly');
  assert.equal(await page.evaluate(()=>globalThis.cellSandboxExecuted),undefined);
  cellReceipt={editorModule,cellModule,editorAsset:manifest.editor,productStyles:styles,reactiveCellEditing:true,realMonacoSourceSwitch:true,sourcePreserved:true,emptyCells:true,addCellAndUndo:true,opaqueSandbox:true,parentExecution:false,implicitSaves:0,narrowViewport:390};
  await page.evaluate(()=>cellEditor.dispose());

  // One Files journey reuses the actual built editor, import UI and download path.
  // These owned fixtures and explicit adapter saves are local; no HTTP mutation
  // or build API exists here.
  journeyStage='Jupyter Files authoring';
  await page.setViewportSize({width:1280,height:900});
  const jupyterNotebook={nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:'python3',language:'python',display_name:'Python 3'},custom:{preserved:true}},cells:[
   {id:'calculation',cell_type:'code',metadata:{custom:'keep'},source:['globalThis.jupyterKernelExecuted=true\n','41'],execution_count:7,
    outputs:[{output_type:'stream',name:'stdout',text:['Saved result 41\n']}]},
   {id:'notes',cell_type:'markdown',metadata:{custom:'attachment retained'},source:['# Invented notebook\n'],attachments:{'pixel.png':{'image/png':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII='}}},
   {id:'locked',cell_type:'raw',metadata:{deletable:false},source:'Retained raw note'}
  ]};
  const originalJupyter='\uFEFF'+JSON.stringify(jupyterNotebook,null,2).replace(/\n/g,'\r\n')+'\r\n';
  const binary=[137,80,78,71,0,255,23],metadataSource='{"invented":true,"preserved":true}\n';
  const dependency={attachmentId:'00000000-0000-4000-8000-000000000087',relativePath:'external/retained.csv'};
  const artifactReferences={revision:7,references:[{path:'maps/retained.html',artifact_id:'00000000-0000-4000-8000-000000000086',mode:'pinned',version:3}]};
  await page.evaluate(async({workspaceModule,originalJupyter,binary,metadataSource,dependency,artifactReferences})=>{
   document.body.replaceChildren();
   const {FrameworkSourceWorkspace}=await import('/_import/components/'+workspaceModule);
   const blobs=new Map([
    ['analysis.ipynb',new Blob([originalJupyter],{type:'application/x-ipynb+json'})],
    ['image.png',new Blob([new Uint8Array(binary)],{type:'image/png'})],
    ['notes.json',new Blob([metadataSource],{type:'application/json'})],
    ['article.md',new Blob(['# Imported article\n\n[Retained map](maps/retained.html)\n'],{type:'text/markdown'})]
   ]);
   globalThis.authoringCalls={revisionReads:0,fileReads:[],referenceReads:0,archiveReads:0,mapReads:0,editionReads:0,writes:[],refreshes:0};
   const forbidden=method=>async()=>{authoringCalls.writes.push(method);throw Error('Unexpected local adapter mutation: '+method);};
   let revision={id:'local-revision',revisionNumber:3,title:'Invented source workspace',rightsStatus:'approved',entryPath:'analysis.ipynb',lockfilePath:null,dataAttachments:[dependency],
    files:[...blobs].map(([relativePath,blob])=>({relativePath,contentType:blob.type,sizeBytes:blob.size})),
    manifest:{dataAttachments:[{attachmentId:dependency.attachmentId,path:dependency.relativePath,checksumSha256:'a'.repeat(64)}]}};
   let references=structuredClone(artifactReferences);
   globalThis.authoringSaved=[];globalThis.authoringReferences=references;
   const archive={id:'00000000-0000-4000-8000-000000000088',datasetId:'00000000-0000-4000-8000-000000000080',datasetVersionId:'00000000-0000-4000-8000-000000000081',dataObjectId:'00000000-0000-4000-8000-000000000082',available:true,contentType:'text/csv',sizeBytes:12,checksumSha256:'b'.repeat(64)};
   globalThis.authoringState={organization:{callerRole:'admin'},project:{id:'local-project'},
    sites:[{id:'local-site',title:'Invented publication',slug:'invented'}],
    observableSourceProjects:[{id:'local-source',siteId:'local-site',title:revision.title,routeNamespace:'invented',rightsStatus:'approved',currentRevisionNumber:3,currentRevisionId:revision.id,
     buildPolicy:{frameworkVersion:'1.13.4',compilerImageDigest:'local-only-no-build',networkPolicy:'deny'}}],
    adapter:{listObservableSourceProjects:async()=>[],listObservableSourceRevisions:async()=>{authoringCalls.revisionReads++;return [revision];},
     readObservableSourceRevisionFile:async(project,source,id,path)=>{authoringCalls.fileReads.push(path);if(project!=='local-project'||source!=='local-source'||id!==revision.id||!blobs.has(path))throw Error('Unexpected fixture read');return {blob:blobs.get(path)};},
     readPublicationArtifactReferences:async(project,source)=>{if(project!=='local-project'||source!=='local-source')throw Error('Unexpected local reference read');authoringCalls.referenceReads++;return structuredClone(references);},
     listObservableDataAttachments:async(project,source)=>{if(project!=='local-project'||source!=='local-source')throw Error('Unexpected local archive lookup');authoringCalls.archiveReads++;return [{...archive,id:dependency.attachmentId,checksumSha256:'a'.repeat(64)},archive];},
     listResources:async(project,options)=>{if(project!=='local-project'||options.kind!=='map'||options.limit!==100||options.offset!==0)throw Error('Unexpected local map lookup');authoringCalls.mapReads++;return [{id:'local-map',title:'Invented destination map'}];},
     readArtifactEdition:async(project,map,version,history,type)=>{if(project!=='local-project'||map!=='local-map'||version!==null||history!==true||type!=='portable-map-html')throw Error('Unexpected local edition lookup');authoringCalls.editionReads++;return {id:'00000000-0000-4000-8000-000000000089',current_version_number:8,editions:[{version_number:8},{version_number:4}]};},
     savePublicationArtifactReferences:async(project,source,expectedRevision,next)=>{if(project!=='local-project'||source!=='local-source'||expectedRevision!==references.revision)throw Error('Unexpected local reference save');authoringCalls.writes.push('savePublicationArtifactReferences');references={revision:expectedRevision+1,references:structuredClone(next)};globalThis.authoringReferences=references;return structuredClone(references);},
     saveObservableSourceRevision:async(project,source,draft)=>{if(project!=='local-project'||source!=='local-source'||draft.expectedRevision!==revision.revisionNumber||authoringSaved.length>=2)throw Error('Unexpected local source save');authoringCalls.writes.push('saveObservableSourceRevision');authoringSaved.push({...draft,files:draft.files.map(file=>({...file}))});blobs.clear();for(const file of draft.files)blobs.set(file.relativePath,file.blob);revision={...revision,...draft,id:'local-revision-'+(revision.revisionNumber+1),revisionNumber:revision.revisionNumber+1,files:draft.files.map(({relativePath,contentType,blob})=>({relativePath,contentType,sizeBytes:blob.size})),manifest:{dataAttachments:draft.dataAttachments.map(binding=>({attachmentId:binding.attachmentId,path:binding.relativePath,checksumSha256:archive.checksumSha256}))}};authoringState.observableSourceProjects[0]={...authoringState.observableSourceProjects[0],currentRevisionId:revision.id,currentRevisionNumber:revision.revisionNumber,title:draft.title,rightsStatus:draft.rightsStatus};return revision;},
     createObservableBuildJob:forbidden('createObservableBuildJob'),
     createObservablePreviewCapability:forbidden('createObservablePreviewCapability'),preparePublicationArtifactInputs:forbidden('preparePublicationArtifactInputs')}};
   const host=document.createElement('section');host.className='project-publishing-workspace';host.id='source-journey';
   const render=()=>host.replaceChildren(FrameworkSourceWorkspace({state:authoringState,refresh:async()=>{authoringCalls.refreshes++;render();}}));render();document.body.append(host);
  },{workspaceModule,originalJupyter,binary,metadataSource,dependency,artifactReferences});
  const workspace=page.locator('#source-journey'),jupyterCells=workspace.locator('.notebook-cell-editor');
  const source=workspace.getByLabel('Framework source editor',{exact:true});
  const sourceValue=()=>source.inputValue();
  const waitSource=(path,text=null)=>page.waitForFunction(({path,text})=>{const root=document.querySelector('#source-journey'),source=root?.querySelector('[aria-label="Framework source editor"]');return root?.querySelector('.source-editor-path')?.textContent===path&&source&&!source.hidden&&!source.disabled&&source.value.length>0&&(text===null||source.value===text);},{path,text});
  const notebookValue=async()=>JSON.parse(await sourceValue());
  const chooseCell=jupyterCells.getByLabel('Notebook cell',{exact:true});
  const cellSource=jupyterCells.getByLabel('Cell source',{exact:true});
  const action=name=>jupyterCells.getByRole('button',{name,exact:true}).click();
  await cellSource.waitFor({state:'visible'});
  const savedOutput=page.frameLocator('#source-journey iframe[title="Jupyter saved-output preview"]');
  await savedOutput.getByText('Saved result 41',{exact:true}).waitFor();
  assert.equal(await workspace.locator('iframe[title="Jupyter saved-output preview"]').getAttribute('sandbox'),'');
  assert.match(await workspace.locator('.publication-document-preview').last().innerText(),/editing does not run a kernel/);
  await cellSource.fill('globalThis.jupyterKernelExecuted=true\n42');
  const editedJupyter=await sourceValue(),editedNotebook=await notebookValue();
  assert.deepEqual(editedNotebook.cells[0].source,['globalThis.jupyterKernelExecuted=true\n','42']);
  assert.deepEqual(editedNotebook.cells[0].outputs,jupyterNotebook.cells[0].outputs);
  assert.deepEqual(editedNotebook.cells[1],jupyterNotebook.cells[1]);
  for(const type of ['code','markdown','raw']){
   await jupyterCells.getByLabel('New cell type',{exact:true}).selectOption(type);
   await action('Add cell');
   const inserted=(await notebookValue()).cells[1];
   assert.equal(inserted.cell_type,type);assert.equal(inserted.source,'');assert.ok(inserted.id);
   assert.ok(!jupyterNotebook.cells.some(cell=>cell.id===inserted.id));
   if(type==='code'){assert.deepEqual(inserted.outputs,[]);assert.equal(inserted.execution_count,null);}
   await action('Undo cell change');assert.equal(await sourceValue(),editedJupyter);
  }
  await jupyterCells.getByText('Cell actions',{exact:true}).click();
  await action('Duplicate cell');
  const duplicate=(await notebookValue()).cells[1];
  assert.notEqual(duplicate.id,'calculation');assert.deepEqual({...duplicate,id:'calculation'},editedNotebook.cells[0]);
  await action('Move cell down');
  assert.equal((await notebookValue()).cells[2].id,duplicate.id);assert.equal(await chooseCell.inputValue(),'2');
  await action('Move cell up');
  assert.equal((await notebookValue()).cells[1].id,duplicate.id);assert.equal(await chooseCell.inputValue(),'1');
  await action('Remove cell');assert.deepEqual((await notebookValue()).cells,editedNotebook.cells);
  for(let count=0;count<4;count++)await action('Undo cell change');
  assert.equal(await sourceValue(),editedJupyter,'Structural Undo restores exact source with retained outputs, metadata and attachments');
  await chooseCell.selectOption('2');
  assert.equal(await jupyterCells.getByRole('button',{name:'Remove cell',exact:true}).isDisabled(),true);
  assert.equal(await jupyterCells.getByRole('button',{name:'Move cell up',exact:true}).isDisabled(),true);
  await chooseCell.selectOption('0');
  await savedOutput.getByText('Saved result 41',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.jupyterKernelExecuted),undefined);
  await action('Source');await workspace.locator('.publication-code-editor .monaco-editor').waitFor({state:'visible'});
  assert.equal(await page.evaluate(async editorAsset=>{
   const {monaco}=await import('/editor-assets/'+editorAsset);
   return monaco.editor.getModels().some(model=>model.getValue()===document.querySelector('#source-journey [aria-label="Framework source editor"]').value);
  },manifest.editor),true,'Jupyter Cells and Monaco retain the same edited JSON');
  await action('Cells');await cellSource.waitFor({state:'visible'});
  await page.setViewportSize({width:390,height:844});
  const jupyterBounds=await jupyterCells.boundingBox();assert.ok(jupyterBounds&&jupyterBounds.x>=0&&jupyterBounds.x+jupyterBounds.width<=391,'Jupyter controls fit a narrow viewport');
  await page.setViewportSize({width:1280,height:900});

  const fileTray=workspace.locator('.source-editor-file-tray');
  const openFileTray=async()=>{if(!await fileTray.evaluate(node=>node.open))await fileTray.locator('summary').first().click();};
  const downloadProject=async()=>{
   await openFileTray();
   const pending=page.waitForEvent('download',{timeout:15000});
   await workspace.getByRole('button',{name:'Download source project',exact:true}).click();
   const downloaded=await pending,stream=await downloaded.createReadStream(),chunks=[];
   assert.equal(downloaded.suggestedFilename(),'invented-source.zip');assert.ok(stream);
   for await(const chunk of stream)chunks.push(chunk);
   const buffer=Buffer.concat(chunks);await downloaded.delete();
   const entries=unzipSync(buffer),manifest=JSON.parse(Buffer.from(entries['opengeo-source-project.json']).toString('utf8'));
   for(const record of manifest.files){
    assert.equal(entries[record.archivePath].byteLength,record.sizeBytes);
    assert.equal(createHash('sha256').update(entries[record.archivePath]).digest('hex'),record.checksumSha256);
   }
   return {buffer,entries,manifest};
  };
  journeyStage='source ZIP export and review/import';
  const exported=await downloadProject();
  assert.equal(Buffer.from(exported.entries['source/analysis.ipynb']).toString('utf8'),'\uFEFF'+editedJupyter.replace(/\n/g,'\r\n'));
  assert.deepEqual([...exported.entries['source/image.png']],binary);
  assert.equal(Buffer.from(exported.entries['source/notes.json']).toString('utf8'),metadataSource);
  assert.equal(exported.manifest.metadata.entryPath,'analysis.ipynb');assert.equal(exported.manifest.metadata.lockfilePath,null);
  assert.equal(exported.manifest.metadata.rightsStatus,'approved');
  assert.equal(exported.manifest.baseRevision.purpose,'original-context-only');assert.equal(exported.manifest.baseRevision.revision.id,'local-revision');
  assert.equal(exported.manifest.dataAttachments[0].bundled,false);assert.equal(exported.manifest.dataAttachments[0].attachmentId,dependency.attachmentId);
  assert.deepEqual(exported.manifest.artifactReferences,{bundled:false,references:artifactReferences});
  assert.equal(Object.hasOwn(exported.entries,'source/'+dependency.relativePath),false,'Referenced data stays unbundled');
  assert.deepEqual(await page.evaluate(()=>authoringCalls.fileReads),['analysis.ipynb','image.png','notes.json','article.md']);
  await openFileTray();
  await workspace.getByText('Import files or a project folder',{exact:true}).click();
  await workspace.getByLabel('OpenGeo source project ZIP',{exact:true}).setInputFiles({name:'invented-source.zip',mimeType:'application/zip',buffer:exported.buffer});
  await workspace.getByRole('heading',{name:'Review source project import',exact:true}).waitFor();
  assert.equal(await sourceValue(),editedJupyter,'ZIP review preserves the current draft');
  assert.equal(await workspace.getByLabel('Source publication rights',{exact:true}).inputValue(),'approved');
  await workspace.getByLabel('Imported revision title',{exact:true}).fill('Reviewed invented source');
  await workspace.getByText('Imported entry path',{exact:true}).locator('..').locator('select').selectOption('article.md');
  await workspace.getByRole('button',{name:'Use imported source',exact:true}).click();
  const articleSource=Buffer.from(exported.entries['source/article.md']).toString('utf8');await waitSource('article.md',articleSource);
  assert.equal(await workspace.getByLabel('Source publication rights',{exact:true}).inputValue(),'unreviewed');
  const reimported=await downloadProject();
  for(const record of exported.manifest.files)assert.deepEqual(reimported.entries[record.archivePath],exported.entries[record.archivePath]);
  assert.equal(reimported.manifest.metadata.title,'Reviewed invented source');assert.equal(reimported.manifest.metadata.entryPath,'article.md');
  assert.equal(reimported.manifest.metadata.lockfilePath,null);assert.equal(reimported.manifest.metadata.sourceProjectId,'local-source');
  assert.equal(reimported.manifest.baseRevision.revision.id,'local-revision','Import leaves the destination saved revision unchanged');
  assert.deepEqual(reimported.manifest.dataAttachments.map(({attachmentId,relativePath})=>({attachmentId,relativePath})),[dependency]);
  assert.deepEqual(reimported.manifest.artifactReferences,exported.manifest.artifactReferences);

  journeyStage='explicit ZIP destination archive and map reconnection';
  await workspace.getByText('Revision settings and data references',{exact:true}).click();
  const archives=workspace.locator('.framework-revision-data');await archives.locator('summary').click();
  await archives.getByLabel('Choose destination file for '+dependency.relativePath,{exact:true}).click();
  const archiveChoice=archives.getByLabel('Registered archive file',{exact:true});await archiveChoice.waitFor({state:'visible'});
  await page.waitForFunction(()=>{const select=document.querySelector('#source-journey [aria-label="Registered archive file"]');return select&&!select.disabled&&[...select.options].some(option=>option.value==='00000000-0000-4000-8000-000000000088');});
  assert.equal(await archiveChoice.inputValue(),'','An imported identity must never select its destination automatically');
  const destinationDependency={attachmentId:'00000000-0000-4000-8000-000000000088',relativePath:dependency.relativePath};
  await archiveChoice.selectOption(destinationDependency.attachmentId);assert.match(await archives.innerText(),/Different bytes from the original/);
  await archives.getByRole('button',{name:'Reconnect imported path',exact:true}).click();
  assert.equal(await archives.getByLabel('Archive file path 1',{exact:true}).inputValue(),dependency.relativePath);
  assert.equal(await archives.locator('[aria-label^="Archive file path "]').count(),1,'Reconnection replaces that draft path');
  assert.equal(await page.evaluate(()=>authoringSaved.length),0);
  await workspace.getByText('Reconnect imported map paths',{exact:true}).click();
  const maps=workspace.locator('.publication-artifact-references');await maps.getByRole('button',{name:'Load saved references',exact:true}).click();
  await maps.getByLabel('Imported map path to reconnect',{exact:true}).selectOption('maps/retained.html');
  await maps.getByRole('button',{name:'Load map resources',exact:true}).click();
  await maps.getByLabel('Map resource in this workspace',{exact:true}).selectOption('local-map');
  await maps.getByRole('button',{name:'Load retained editions',exact:true}).click();
  await maps.getByLabel('Retained Artifact edition to add',{exact:true}).selectOption('4');
  await maps.getByRole('button',{name:'Reconnect imported map',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>authoringCalls.writes),[],'Destination selection changes drafts only');
  await maps.getByRole('button',{name:'Save Artifact references',exact:true}).click();
  await maps.getByRole('status').filter({hasText:'Saved reference revision 8.'}).waitFor();
  const reboundArtifactReferences={revision:8,references:[{path:'maps/retained.html',artifact_id:'00000000-0000-4000-8000-000000000089',mode:'pinned',version:4}]};
  assert.deepEqual(await page.evaluate(()=>authoringReferences),reboundArtifactReferences);
  await workspace.getByRole('button',{name:'Commit exact source revision',exact:true}).click();
  await page.waitForFunction(()=>authoringSaved.length===1&&authoringCalls.refreshes===1);await waitSource('article.md',articleSource);
  assert.equal(await workspace.getByLabel('Source revision note',{exact:true}).inputValue(),'Edit source revision 4');
  assert.equal(await workspace.locator('[aria-label^="Choose destination file for "]').count(),0,'Saved reopening clears pending import choices');
  assert.deepEqual(await page.evaluate(()=>authoringSaved[0].dataAttachments),[destinationDependency]);
  assert.equal(await page.evaluate(()=>authoringSaved[0].rightsStatus),'unreviewed');
  const rebound=await downloadProject();for(const record of exported.manifest.files)assert.deepEqual(rebound.entries[record.archivePath],exported.entries[record.archivePath]);
  assert.deepEqual(rebound.manifest.dataAttachments.map(({attachmentId,relativePath})=>({attachmentId,relativePath})),[destinationDependency]);
  assert.deepEqual(rebound.manifest.artifactReferences,{bundled:false,references:reboundArtifactReferences});

  journeyStage='legacy compiled export review and conversion';

  await openFileTray();
  await workspace.getByText('Import files or a project folder',{exact:true}).click();await workspace.getByText('Convert an Observable export',{exact:true}).click();
  await workspace.getByLabel('Observable JavaScript or JSON export',{exact:true}).setInputFiles({name:'invented-export.js',mimeType:'text/javascript',buffer:Buffer.from(legacySource)});
  // Browser File objects retain the same relative paths as a selected export folder.
  await workspace.getByLabel('Original Observable export folder',{exact:true}).evaluate(input=>{
   const selected=new DataTransfer();
   for(const [path,content] of [['export/files/data-hash','[3]\n'],['export/unused.txt','Kept on local disk']]){
    const file=new File([content],path.split('/').at(-1));Object.defineProperty(file,'webkitRelativePath',{value:path});selected.items.add(file);
   }
   input.files=selected.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await workspace.getByRole('button',{name:'Review Observable conversion',exact:true}).click();
  await workspace.getByRole('heading',{name:'Conversion review',exact:true}).waitFor();
  assert.match(await workspace.innerText(),/5 cells converted; 1 local attachments retained/);
  assert.match(await workspace.innerText(),/Selected files not copied: unused.txt/);
  assert.equal(await sourceValue(),articleSource,'Conversion review preserves the current draft');
  assert.equal(await page.evaluate(()=>globalThis.legacySandboxExecuted),undefined,'Import inspection must not execute the exported functions');
  await workspace.getByRole('button',{name:'Use imported source',exact:true}).click();
  journeyStage='legacy native reactive preview';
  await workspace.locator('iframe[title="Observable Notebook live preview"]').waitFor({state:'visible'});
  await workspace.locator('iframe[title="Observable Notebook live preview"]').scrollIntoViewIfNeeded();
  const legacyPreview=page.frameLocator('#source-journey iframe[title="Observable Notebook live preview"]');
  await legacyPreview.getByRole('heading',{name:'Legacy result 7',exact:true}).waitFor({timeout:15000});
  await legacyPreview.locator('input[type=range]').fill('4');
  await legacyPreview.getByRole('heading',{name:'Legacy result 11',exact:true}).waitFor();
  await legacyPreview.getByRole('button',{name:'Increment mutable',exact:true}).click();
  await legacyPreview.getByRole('heading',{name:'Legacy result 12',exact:true}).waitFor();
  await legacyPreview.locator('input[type=range]').fill('1');
  await legacyPreview.getByRole('heading',{name:'Legacy result 5',exact:true}).waitFor();
  assert.equal(await workspace.locator('iframe[title="Observable Notebook live preview"]').getAttribute('sandbox'),'allow-scripts');
  assert.equal(await page.evaluate(()=>{try{document.querySelector('#source-journey iframe[title="Observable Notebook live preview"]').contentWindow.document;return false;}catch{return true;}}),true);
  assert.equal(await page.evaluate(()=>globalThis.legacySandboxExecuted),undefined);
  journeyStage='converted originals, report and attachment export';
  const converted=await downloadProject();
  assert.equal(Buffer.from(converted.entries['source/original/observable-export.js.txt']).toString('utf8'),legacySource);
  assert.equal(Buffer.from(converted.entries['source/data.json']).toString('utf8'),'[3]\n');
  assert.equal(Object.hasOwn(converted.entries,'source/unused.txt'),false);
  const conversionReport=JSON.parse(Buffer.from(converted.entries['source/original/observable-conversion.json']).toString('utf8'));
  assert.equal(conversionReport.original.checksumSha256,createHash('sha256').update(legacySource).digest('hex'));
  assert.equal(conversionReport.attachments[0].path,'files/data-hash');assert.equal(conversionReport.attachments[0].checksumSha256,createHash('sha256').update('[3]\n').digest('hex'));
  assert.deepEqual(conversionReport.unusedSelectedFiles,['unused.txt']);assert.equal(conversionReport.provenance.grantsPermission,false);
  assert.deepEqual(conversionReport.reactiveGroups,[{name:'amount',kind:'viewof',foldedDefinitions:2},{name:'count',kind:'mutable',foldedDefinitions:3}]);
  assert.deepEqual(JSON.parse(Buffer.from(converted.entries['source/opengeo.publication.json']).toString('utf8')),{schema:'opengeo.publication.1',format:'notebook',entry:'index.html'});
  assert.equal(converted.manifest.metadata.rightsStatus,'unreviewed');
  assert.deepEqual(converted.manifest.dataAttachments.map(({attachmentId,relativePath})=>({attachmentId,relativePath})),[destinationDependency]);
  assert.deepEqual(converted.manifest.artifactReferences,{bundled:false,references:reboundArtifactReferences});

  journeyStage='pinned upstream export Files review and explicit local save';
  const mainOriginal=upstream.originals.find(file=>file.path===upstream.main),childOriginal=upstream.originals.find(file=>file.path==='7a9e12f9fb3d8e06@517.js'),csvOriginal=upstream.originals.find(file=>file.path.endsWith('.csv')),noticeOriginal=upstream.originals.find(file=>file.path==='LICENSE.txt');
  const previousDraft=await sourceValue();
  await workspace.getByLabel('Observable JavaScript or JSON export',{exact:true}).setInputFiles({name:upstream.main,mimeType:'text/javascript',buffer:Buffer.from(mainOriginal.bytes)});
  await workspace.getByLabel('Original Observable export folder',{exact:true}).evaluate((input,files)=>{
   const selected=new DataTransfer();for(const record of files){const file=new File([new Uint8Array(record.bytes)],record.path.split('/').at(-1));Object.defineProperty(file,'webkitRelativePath',{value:'bar-chart/'+record.path});selected.items.add(file);}input.files=selected.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  },upstream.originals.filter(file=>file.path!==upstream.main));
  await workspace.getByRole('button',{name:'Review Observable conversion',exact:true}).click();
  await workspace.getByRole('heading',{name:'Conversion review',exact:true}).waitFor();
  assert.match(await workspace.innerText(),/7 cells converted; 1 local attachments retained/);assert.match(await workspace.innerText(),/1 imported notebooks included/);assert.match(await workspace.innerText(),/Retained license and attribution notices: LICENSE.txt/);
  assert.equal(await sourceValue(),previousDraft,'Actual upstream review preserves the existing draft');
  assert.equal(await page.evaluate(()=>authoringSaved.length),1,'Review does not save or run the supplied module');
  await workspace.getByRole('button',{name:'Use imported source',exact:true}).click();await waitSource('index.html');
  await workspace.locator('iframe[title="Observable Notebook live preview"]').scrollIntoViewIfNeeded();
  const upstreamPreview=page.frameLocator('#source-journey iframe[title="Observable Notebook live preview"]');
  await upstreamPreview.locator('svg rect').nth(25).waitFor({timeout:15000});assert.equal(await upstreamPreview.locator('svg rect').count(),26);
  assert.equal(await workspace.getByLabel('Source publication rights',{exact:true}).inputValue(),'unreviewed');
  await workspace.getByRole('button',{name:'Commit exact source revision',exact:true}).click();
  await page.waitForFunction(()=>authoringSaved.length===2&&authoringCalls.refreshes===2);await waitSource('index.html');
  assert.equal(await workspace.getByLabel('Source revision note',{exact:true}).inputValue(),'Edit source revision 5');
  const upstreamExported=await downloadProject(),upstreamReport=JSON.parse(Buffer.from(upstreamExported.entries['source/original/observable-conversion.json']).toString('utf8'));
  assert.deepEqual(upstreamExported.entries['source/original/observable-export.js.txt'],new Uint8Array(mainOriginal.bytes));
  assert.equal(upstreamReport.original.checksumSha256,mainOriginal.sha256);assert.equal(upstreamReport.convertedCells,7);assert.equal(upstreamReport.retainedModules.length,1);assert.equal(upstreamReport.attachments.length,1);assert.equal(upstreamReport.retainedNotices.length,1);
  assert.deepEqual(upstreamExported.entries['source/'+upstreamReport.retainedModules[0].retainedPath],new Uint8Array(childOriginal.bytes));
  assert.deepEqual(upstreamExported.entries['source/'+upstreamReport.attachments[0].name],new Uint8Array(csvOriginal.bytes));
  assert.deepEqual(upstreamExported.entries['source/'+upstreamReport.retainedNotices[0].retainedPath],new Uint8Array(noticeOriginal.bytes));
  assert.equal(upstreamReport.provenance.grantsPermission,false);assert.equal(upstreamExported.manifest.metadata.rightsStatus,'unreviewed');
  assert.deepEqual(upstreamExported.manifest.dataAttachments.map(({attachmentId,relativePath})=>({attachmentId,relativePath})),[destinationDependency]);
  assert.deepEqual(upstreamExported.manifest.artifactReferences,{bundled:false,references:reboundArtifactReferences});
  const adapterCalls=await page.evaluate(()=>authoringCalls);
  assert.deepEqual(adapterCalls.writes,['savePublicationArtifactReferences','saveObservableSourceRevision','saveObservableSourceRevision']);assert.equal(adapterCalls.refreshes,2);assert.equal(adapterCalls.archiveReads,3);assert.equal(adapterCalls.mapReads,1);assert.equal(adapterCalls.editionReads,1);
  authoringReceipt={workspaceModule,fixture:'invented local destination adapter plus exact retained @d3/bar-chart527 upstream export',
   jupyter:{edit:true,addTypes:['code','markdown','raw'],duplicateMoveRemoveUndo:true,lockedCellControls:true,outputsMetadataAttachmentsPreserved:true,realMonacoSourceSwitch:true,savedOutputPreview:true,kernelRuns:0,narrowViewport:390},
   sourceProject:{downloadedAndReimported:true,reviewBeforeReplacement:true,exactBomCrLfAndBinaryBytes:true,reviewedSettings:true,rightsReset:true,destinationReferencesRetained:true,externalContentsUnbundled:true,explicitDestinationArchiveRebinding:destinationDependency,explicitMapAliasChoice:reboundArtifactReferences,reopened:true},
   legacy:{compiledModuleConversion:true,reviewBeforeReplacement:true,originalBytesReportAttachmentRetained:true,nativeFormatMarker:true,viewofInput:true,mutableUpdatesAndInitializerReset:true,opaqueSandbox:true,parentExecution:false},
   upstream:{package:'@d3/bar-chart',version:upstream.version,sourceSha256:mainOriginal.sha256,localModules:1,csvAttachments:1,noticeFiles:1,reviewBeforeReplacement:true,originalChildCsvNoticeBytesPreserved:true,explicitSaveReopen:true,unreviewedRights:true,renderedBars:26},
   adapterCalls,apiRequests:0,saves:2,referenceSaves:1,builds:0,hostedPersistence:false};
  await page.evaluate(()=>document.body.replaceChildren());
 }
 assert.deepEqual(blocked,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 const receipt={status:'passed',startedAt,finishedAt:new Date().toISOString(),...batch,result:{closed:cellsRequested?2:1,requiredExceptions:[],hostedPersistence:false},compiler:manifest.notebookPreview,sha256:createHash('sha256').update(bytes).digest('hex'),reactiveInput:true,localAttachment:true,opaqueSandbox:true,importReview:{module:reviewModule,observable:true,jupyter:true,sourcePreserved:true,noCellExecution:true,selectionClearsReport:true},...(cellReceipt?{cells:cellReceipt}:{}),...(authoringReceipt?{authoring:authoringReceipt}:{}),externalRequests:0,newBuilds:0,scope:'Exact prebuilt notebook review UI, compiler and runtime in Chromium'+(cellsRequested?', including native/Jupyter cells, real Monaco, source ZIP destination data/map reconnection and one pinned upstream compiled export through local save/reopen':'')+'; not worker, hosted persistence/publishing or full notebook parity.'};await writeFile(output,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}catch(error){
 await writeFile(output,JSON.stringify({status:'failed',startedAt,finishedAt:new Date().toISOString(),...batch,result:{closed:0,requiredExceptions:[journeyStage+': '+error.message],hostedPersistence:false},stage:journeyStage,message:error.message,errors,unexpected,blocked,localAdapterCalls:await page?.evaluate(()=>globalThis.authoringCalls??null).catch(()=>null),externalRequests:0,newBuilds:0},null,2)+'\n');
 console.error(JSON.stringify({stage:journeyStage,message:error.message,errors,unexpected,blocked,
  body:await page?.locator('body').innerText().then(text=>text.slice(-14000)).catch(()=>''),
  frames:page?await Promise.all(page.frames().slice(1).map(async frame=>({url:frame.url(),text:await frame.locator('body').innerText().then(text=>text.slice(-5000)).catch(()=>'' )}))):[]}));
 throw error;
}finally{await browser?.close();}
