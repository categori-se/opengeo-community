// Real hosted Studio + OAuth + direct S3 transfer. Operator signs in; no tokens,
// passwords, signed URLs or browser profile are retained. Only one 3.4 KiB
// original archival README is uploaded, plus reconstruction metadata.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const origin='https://studio.opengeo.tools',project='f340b616-691b-4770-b22e-03a6913f96f1';
const out=resolve('.local-archives/bhutan-local-20260920/hosted-upload');await mkdir(out,{recursive:true});
const receipt={status:'starting',stage:'login',sameOriginRequests:0,s3Requests:0,uploadedBytes:0,authenticated:false,pickerAutomation:'Browser file input; restore uses real OPFS handles in place of the OS directory picker'};
const temp=await mkdtemp(join(tmpdir(),'opengeo-hosted-upload-'));const folder=join(temp,'arcgis_data_archive');await mkdir(folder);
const name='README_arcgis_archiver.md',source='/home/aaron/framework/bhutan_ai/src/arcgis_data_archive/'+name;
await copyFile(source,join(folder,name));const original=await readFile(source);assert.ok(original.length<65536);
const digest=createHash('sha256').update(original).digest('hex');
let browser;
const save=async()=>writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
try {
 browser=await chromium.launch({headless:false,executablePath:'/usr/bin/chromium-browser'});
 const context=await browser.newContext({viewport:{width:1440,height:950},colorScheme:'dark',acceptDownloads:true,serviceWorkers:'block'});
 await context.route('**/*',route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===origin){receipt.sameOriginRequests++;assert.ok(receipt.sameOriginRequests<=700);}
  if(u.hostname==='s3.us-east-1.amazonaws.com'){
   assert.ok(u.pathname.startsWith('/example-geodata/bhutan/archive-tools/captures/local-20260920/'));
   receipt.s3Requests++;assert.ok(receipt.s3Requests<=20);
   if(req.method()==='PUT'){receipt.uploadedBytes+=req.postDataBuffer()?.length??0;assert.ok(receipt.uploadedBytes<=1048576);}
  }
  if(/tiles\.|geoapps\.icimod|nsdi\.systems/.test(u.hostname))return route.abort();
  return route.continue();
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);
 let session=null;
 page.on('response',async response=>{
  if(response.url()===origin+'/api/auth/session'&&response.status()===200)session=await response.json();
 });
 await save();console.log(JSON.stringify({status:'operator-sign-in-required',origin,minutes:15}));
 await page.goto(origin+'/workspaces?project='+project+'&manage=data',{waitUntil:'domcontentloaded'});
 await page.locator('.archive-folder-upload').waitFor({state:'visible',timeout:900000});
 assert.ok(session);assert.ok(['4dbfd8ca-89e9-4fdb-a638-176f7b5368d7','14a6ac14-3974-41c6-9f26-655e2ffd0993'].includes(session.user_id));
 receipt.authenticated=true;receipt.stage='upload';await save();
 const panel=page.locator('.archive-folder-upload'),click=name=>panel.getByRole('button',{name,exact:true}).click();
 await panel.getByLabel('Archive folder',{exact:true}).setInputFiles(folder);
 await click('Load private destinations');
 const select=panel.getByLabel('Private archive destination',{exact:true});
 const options=await select.locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,label:n.textContent})));
 const destination=options.filter(x=>x.label.includes('s3://example-geodata/bhutan/archive-tools/captures/local-20260920/'));
 assert.equal(destination.length,1);await select.selectOption(destination[0].value);
 await click('Review files and duplicates');await panel.getByRole('status').filter({hasText:'1 files · 1 unique objects'}).waitFor();
 await click('Upload reviewed originals');await panel.getByRole('status').filter({hasText:'Verified 1 original paths in 1 stored objects.'}).waitFor();
 await click('Preserve reconstruction records in S3');await panel.getByRole('status').filter({hasText:'Preserved 1 reconstruction records'}).waitFor();
 const download=page.waitForEvent('download');await click('Download reconstruction manifest');
 const manifest=JSON.parse(await readFile(await (await download).path(),'utf8'));assert.equal(manifest.files.length,1);
 assert.equal(manifest.files[0].sha256,digest);assert.equal(manifest.files[0].size_bytes,original.length);assert.ok(manifest.files[0].object.version_id);
 assert.equal(manifest.archivedRecords.length,1);assert.equal(manifest.archivedIndexes.length,1);
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 await page.reload();await click('Resume saved upload');await panel.getByRole('status').filter({hasText:'Saved upload is complete.'}).waitFor();
 receipt.stage='restore';await save();
 await page.evaluate(()=>{window.showDirectoryPicker=()=>navigator.storage.getDirectory();});
 await click('Choose empty restore folder');await click('Restore archived originals');
 await panel.getByRole('status').filter({hasText:'Restored and verified 1 original paths.'}).waitFor();
 const restored=await page.evaluate(async path=>{
  const parts=path.split('/');let handle=await navigator.storage.getDirectory();
  for(const part of parts.slice(0,-1))handle=await handle.getDirectoryHandle(part);
  const file=await (await handle.getFileHandle(parts.at(-1))).getFile();const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  return {bytes:file.size,sha256:Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('')};
 },manifest.files[0].path);
 assert.deepEqual(restored,{bytes:original.length,sha256:digest});
 Object.assign(receipt,{status:'passed',stage:'complete',originalPathPreserved:true,exactVersionPreserved:true,reconstructionRecordsInS3:true,reloadResume:true,restoreHashVerified:true,sourceBytes:original.length});
} catch(error){receipt.status='failed';receipt.errorType=error.name;throw new Error('Hosted upload acceptance failed at '+receipt.stage+' ('+error.name+')');}
finally{await browser?.close();await rm(temp,{recursive:true,force:true});receipt.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(receipt));}
