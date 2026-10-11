// Actual built Publication workspace; local adapter persistence, no cloud transport.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const dist=resolve(process.argv[2]),out=resolve(process.argv[3]);assert.ok(!existsSync(out));await mkdir(out,{recursive:true});
const files=await readdir(resolve(dist,'_import/components'));
const moduleFor=name=>{const file=files.find(f=>f.startsWith(name+'.')&&f.endsWith('.js'));assert.ok(file,name);return '/_import/components/'+file;};
const workspace=moduleFor('ProjectSites'),guard=moduleFor('AuthoredResourceMetadata');
const origin='https://publication-artifacts.invalid',errors=[],external=[],served=new Set();let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
 const context=await browser.newContext();
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><nav><a href="/leave">Leave Studio</a><select aria-label="Studio account"><option value="one">One</option><option value="two">Two</option></select></nav><main></main><script type="module">
   import {ProjectPublishingWorkspace} from '${workspace}';import {guardAuthoredMetadata} from '${guard}';
   window.calls={reads:0,editions:0,saves:0,accountChanges:0};let saved={revision:0,references:[]};
   const adapter={readPublicationArtifactReferences:async()=>{calls.reads++;return structuredClone(saved);},
    listResources:async()=>[{id:'map-a',title:'Survey map'},{id:'map-b',title:'Other map'}],
    readArtifactEdition:async(p,r,v,metadata,representation)=>{if(p!=='workspace'||r!=='map-a'||!metadata||representation!=='portable-map-html')throw Error('Wrong edition request');calls.editions++;return {id:'artifact',current_version_number:9,editions:[{version_number:9},{version_number:4}]};},
    savePublicationArtifactReferences:async(p,s,revision,references)=>{if(p!=='workspace'||s!=='source-atlas'||revision!==saved.revision)throw Error('Wrong reference identity');calls.saves++;await new Promise(resolve=>window.finishSave=resolve);saved={revision:revision+1,references:structuredClone(references)};return structuredClone(saved);}};
   const sites=[{id:'atlas',title:'Atlas',slug:'atlas'},{id:'second',title:'Second',slug:'second'}];
   const state={project:{id:'workspace',callerRole:'owner'},organization:{id:'account',callerRole:'member'},resources:[],sites,
    observableSourceProjects:sites.map(site=>({id:'source-'+site.id,siteId:site.id,title:site.title,currentRevisionId:null,currentRevisionNumber:0,rightsStatus:'approved',buildPolicy:{}})),adapter};
   const host=document.querySelector('main');window.guard=guardAuthoredMetadata(host);
   window.mount=()=>{host.replaceChildren(ProjectPublishingWorkspace({state,refresh:async()=>{throw Error('Unexpected refresh');}}));};mount();
   document.querySelector('nav select').addEventListener('change',()=>calls.accountChanges++);
  </script>`});
  const path=resolve(dist,'.'+url.pathname);assert.ok(path.startsWith(dist+'/'));served.add(url.pathname);
  return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':'application/octet-stream',body:await readFile(path)});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('tab',{name:'Settings',exact:true}).click();
 const references=page.locator('.publication-artifact-references').first();
 await references.getByRole('button',{name:'Load saved references',exact:true}).click();
 await references.getByRole('button',{name:'Load map resources',exact:true}).click();
 assert.equal(await references.getByRole('button',{name:'Add retained Artifact',exact:true}).isDisabled(),true);
 await references.getByRole('button',{name:'Load retained editions',exact:true}).click();
 const editions=references.getByLabel('Retained Artifact edition to add',{exact:true});
 assert.deepEqual(await editions.locator('option').allTextContents(),['Follow current edition (now v9)','Pin v9 · current','Pin v4']);
 await editions.selectOption('4');await references.getByRole('button',{name:'Add retained Artifact',exact:true}).click();
 assert.equal(await references.getByLabel('Pinned Artifact version',{exact:true}).inputValue(),'4');
 await page.getByLabel('Publication',{exact:true}).selectOption('second');
 await page.getByRole('link',{name:'Leave Studio'}).click();
 assert.equal(page.url(),origin+'/');assert.equal(await page.getByLabel('Publication',{exact:true}).inputValue(),'atlas');
 assert.equal(await references.isVisible(),true);
 await page.getByLabel('Studio account',{exact:true}).selectOption('two');assert.equal(await page.getByLabel('Studio account',{exact:true}).inputValue(),'one');
 await references.getByRole('button',{name:'Save Artifact references',exact:true}).click();await page.waitForFunction(()=>typeof finishSave==='function');
 assert.equal(await page.evaluate(()=>guard.check()),true);
 await page.evaluate(()=>finishSave());await references.getByText(/Saved reference revision 1/).waitFor();
 assert.equal(await page.evaluate(()=>guard.check()),false);
 await page.evaluate(()=>mount());await page.getByRole('tab',{name:'Settings',exact:true}).click();await references.getByRole('button',{name:'Load saved references',exact:true}).click();
 assert.equal(await references.getByLabel('Pinned Artifact version',{exact:true}).inputValue(),'4');
 assert.equal(await references.getByLabel('Artifact edition selection',{exact:true}).inputValue(),'pinned');
 const calls=await page.evaluate(()=>window.calls);assert.deepEqual(calls,{reads:2,editions:1,saves:1,accountChanges:0});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const reviewedFiles=[];for(const path of [...served].sort())reviewedFiles.push({path,sha256:createHash('sha256').update(await readFile(resolve(dist,'.'+path))).digest('hex')});
 const receipt={status:'passed',scope:'Built Publication workspace, reference editor and navigation guard with fixture persistence. Not real API/database/auth or deployed acceptance.',calls,pinnedVersion:4,reopened:true,draftRevealed:true,pendingSaveGuard:true,externalRequests:0,errors,reviewedFiles};
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,calls,files:reviewedFiles.length}));
}finally{await browser?.close();}
