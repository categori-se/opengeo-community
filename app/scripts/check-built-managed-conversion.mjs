import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2]),out=resolve(process.argv[3]);
assert.ok(!existsSync(out));await mkdir(out,{recursive:true});
const moduleFor=async(directory,name)=>{
 const file=(await readdir(resolve(dist,'_import',directory))).find(f=>f.startsWith(name+'.')&&f.endsWith('.js'));
 assert.ok(file,name);return '/_import/'+directory+'/'+file;
};
const workbench=await moduleFor('components','WorkbenchView'),upload=await moduleFor('lib','managedUpload');
const origin='https://managed-conversion.invalid',errors=[],external=[],served=new Set();let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){external.push(url.href);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><main></main><script type="module">
   import {WorkbenchView} from '${workbench}';import {ingestManagedFile} from '${upload}';
   window.calls=[];window.uploaded=[];
   const adapter={requestUpload:async(projectId,metadata)=>{
    calls.push({kind:'request',projectId,metadata});return {uploadId:'upload',expiresAt:'2099-01-01T00:00:00Z',upload:{}};
   },uploadFile:async(ticket,file)=>{calls.push({kind:'upload'});uploaded.push({name:file.name,type:file.type,size:file.size,text:await file.text()});},
   completeUpload:async(projectId,id)=>{calls.push({kind:'complete',projectId,id});return {dataset:{name:'Survey'},versionNumber:1};}};
   const projectId='50000000-0000-4000-8000-000000000083';
   const shell=WorkbenchView({workspace:{workspaceId:projectId,title:'Conversion acceptance'},role:'owner',
    project:{workspaceId:projectId,layers:[],mapViews:[{id:'default',center:[85,27],zoom:7}],basemaps:[],bookmarks:[]},
    layers:[],datasets:[],persistenceMode:'api',resolveBasemapStyle:async()=>({version:8,sources:{},layers:[]}),
    importLocalFile:(file,onStage,metadata)=>ingestManagedFile({adapter,projectId,file,...metadata,onStage})});
   document.querySelector('main').append(shell);
  </script>`});
  const path=resolve(dist,'.'+decodeURIComponent(url.pathname));assert.ok(path.startsWith(dist+'/'));
  served.add(url.pathname);
  try{return route.fulfill({contentType:({'.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(path)]??'application/octet-stream',body:await readFile(path)});}
  catch{return route.fulfill({status:404,body:''});}
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('.opengeo-workbench').waitFor();
 await page.getByRole('button',{name:'Add data',exact:true}).first().click();
 const input=page.locator('.gis-file-drop input[type=file]').first();
 const original='POINT (85.324 27.7172)';
 await input.setInputFiles({name:'Survey.wkt',mimeType:'text/plain',buffer:Buffer.from(original)});
 await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.importState==='queued');
 const captured=await page.evaluate(()=>({calls,uploaded,layers:document.querySelector('.opengeo-workbench').__opengeoLayers}));
 assert.deepEqual(captured.calls.map(c=>c.kind),['request','upload','complete']);
 assert.equal(captured.layers.length,0,'managed import queues an authoritative dataset rather than silently adding a scratch Layer');
 const [file]=captured.uploaded,request=captured.calls[0].metadata;
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(file.name,'Survey.geojson');assert.equal(request.checksumSha256,digest(file.text));
 assert.equal(request.sizeBytes,Buffer.byteLength(file.text));
 const document=JSON.parse(file.text),knowledge=document['opengeo:conversion'];
 assert.equal(knowledge.source.checksumSha256,digest(original));assert.equal(knowledge.source.fileName,'Survey.wkt');
 assert.equal(knowledge.source.originalBytesArchived,false);assert.ok(knowledge.report);
 assert.deepEqual(document.features[0].geometry.coordinates,[85.324,27.7172]);
 await input.setInputFiles({name:'Invalid.wkt',mimeType:'text/plain',buffer:Buffer.from('not geometry')});
 await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.importState==='error');
 assert.equal(await page.evaluate(()=>calls.length),3,'invalid input must not request an upload');
 assert.deepEqual(errors,[]);
 const reviewedFiles=[];for(const path of [...served].sort())reviewedFiles.push({path,sha256:digest(await readFile(resolve(dist,'.'+decodeURIComponent(path))))});
 await writeFile(resolve(out,'normalized-upload.geojson'),file.text);
 await writeFile(resolve(out,'receipt.json'),JSON.stringify({status:'passed',workbenchFileSelection:true,checksumBoundUpload:true,conversionKnowledgeRetained:true,invalidInputHasNoUpload:true,scratchLayerNotAdded:true,errors,externalRequestsBlocked:external.length,reviewedFiles,scope:'Actual built Workbench and managed upload session; capture adapter substitutes API/object transport. Real backend acceptance is recorded separately.'},null,2)+'\n');
} finally {await browser?.close();}
