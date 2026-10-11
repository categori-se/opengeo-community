import {inspectProjectVersion} from "./inspect-project-version.mjs";
// Local API/PostgreSQL; cached Studio modules; all nonlocal browser requests denied.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
import {verify} from 'node:crypto';
import {loadIntegratedStudioBuild,integratedStudioAuthConfig} from './integrated-studio-built-shell.mjs';
let input='';for await(const part of process.stdin) input+=part;
const config=JSON.parse(input), initialRevision=config.initialRevision??3, savedRevision=config.savedRevision??initialRevision+1, dist=resolve(config.dist ?? process.env.OPEN_GEO_ACCEPTANCE_DIST ?? 'dist'), calls=[];
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const builtShell=config.routedStudio?await loadIntegratedStudioBuild(resolve(dist,'../../..')):null;
const panels=await modulePath('components','PublicationPanels');
const refs=await modulePath('components','PublicationArtifactReferences'), preview=await modulePath('components','FrameworkProjectPreview'), client=await modulePath('lib','apiClient');
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')) {
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:req.headers},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode});res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(builtShell) {
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/auth-config.json') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(integratedStudioAuthConfig(origin)));return;}
  if(path==='/service-worker.js'){res.writeHead(404).end();return;}
  const file=builtShell.files.get(path);
  if(!file){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',file.contentType);res.end(file.body);return;
 }
 if(req.url==='/') {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><body><main></main><script type="module">
 import {PublicationPanels} from '${panels}';
 import {PublicationArtifactReferences} from '${refs}';import {FrameworkProjectPreview} from '${preview}';import {OpenGeoApiClient} from '${client}';
 const config=${JSON.stringify(config)};
 const adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'local-artifact-author',organizationProvider:()=>config.organizationId});
 document.querySelector('main').append(PublicationPanels({initial:'settings',panels:[
 {id:'settings',label:'Settings',render:()=>PublicationArtifactReferences({adapter,projectId:config.projectId,sourceProjectId:config.sourceProject.id,sourceRevisionId:config.sourceProject.currentRevisionId,canManage:true})},
 {id:'preview',label:'Preview',render:()=>FrameworkProjectPreview({adapter,projectId:config.projectId,sourceProject:config.sourceProject,canManage:true})}]}));
 </script>`);return;}
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try {res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser, diagnosticPage;
const diagnostics=[], blockedOptionalFonts=[], providerFixtureRequests=[];
try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:config.workbenchExport?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
 const context=await browser.newContext();
 const page=await context.newPage(), blocked=[], errors=[]; diagnosticPage=page;
 page.on('console',msg=>{if(msg.type()==='error')diagnostics.push(msg.text());});
 page.on('requestfailed',req=>diagnostics.push(`${req.url()}: ${req.failure()?.errorText}`));
 let exchanges=0, delivered=0;
 page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const previewOrigin='https://preview.studio.opengeo.tools';
 const decode=value=>Buffer.from(value.replace(/-/g,'+').replace(/_/g,'=').replace(/~/g,'/'),'base64');
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin)return route.continue();
  if(config.registerArtifact && url.origin==='https://s3.us-east-1.amazonaws.com'){
   assert.equal(url.pathname,'/portable-local.invalid');assert.equal(route.request().method(),'POST');
   const response=await route.fetch({url:origin+'/api/_fixture/upload'});
   return route.fulfill({response});
  }
  if(config.workbenchExport && url.origin==='https://s3.us-east-1.amazonaws.com'){
   const response=await route.fetch({url:origin+'/api/_fixture/download?url='+encodeURIComponent(url.href)});
   return route.fulfill({response});
  }
  if(config.workbenchExport && url.origin==='https://services.example.com') {
   assert.ok(url.pathname.startsWith('/ArcGIS/rest/services/facilities/FeatureServer/0'));
   providerFixtureRequests.push(url.pathname);assert.ok(providerFixtureRequests.length<=12);
   return route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname.endsWith('/query')?config.providerData:config.providerMetadata)});
  }
  if(builtShell&&url.origin==='https://fonts.googleapis.com'){blockedOptionalFonts.push(url.href);return route.abort();}
  if(url.origin!==previewOrigin){blocked.push(url.href);return route.abort();}
  if(url.pathname.startsWith('/authorize/')) {
   const name=url.pathname.slice('/authorize/'.length)||'index.html';
   if(!['index.html','preview-shell.js','style.css'].includes(name))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('../services/observable-preview/authorize',name))});
  }
  if(url.pathname==='/observable-preview/exchange') {
   exchanges++;
   const headers=await route.request().allHeaders();
   assert.equal(headers.origin,previewOrigin);
   // The loopback proxy substitutes only transport; retain the shell's same-origin boundary.
   headers['sec-fetch-site']='same-origin';
   const response=await route.fetch({url:origin+'/api/observable-preview/exchange',headers});
   return route.fulfill({response});
  }
  try {
   const cookies=Object.fromEntries(((await route.request().allHeaders()).cookie??'').split(';').map(part=>{const i=part.indexOf('=');return [part.slice(0,i).trim(),part.slice(i+1)];}));
   const policy=decode(cookies['CloudFront-Policy']);
   assert.equal(cookies['CloudFront-Key-Pair-Id'],'LOCALKEY123');
   assert.ok(verify('RSA-SHA1',policy,config.publicKey,decode(cookies['CloudFront-Signature'])));
   const statement=JSON.parse(policy).Statement[0];
   assert.ok(statement.Resource.endsWith('*')&&url.href.startsWith(statement.Resource.slice(0,-1)));
   assert.ok(statement.Condition.DateLessThan['AWS:EpochTime']>Date.now()/1000);
   const match=/\/builds\/([0-9a-f-]{36})\/output\/(.+)$/.exec(url.pathname);assert.ok(match);
   const base=resolve(config.outputDirectory,match[1]), file=resolve(base,match[2]);assert.ok(file.startsWith(base+'/'));
   const body=await readFile(file);delivered++;
   return route.fulfill({contentType:file.endsWith('.html')?'text/html':'application/octet-stream',body});
  }catch{return route.fulfill({status:403,body:'Preview unavailable'});}
 });
 if(builtShell) await context.addInitScript(({organizationId})=>{
  if(window.top!==window)return;
  sessionStorage.setItem('opengeo.accessToken','synthetic.local.author');
  sessionStorage.setItem('opengeo.accessTokenExpiresAt',String(Date.now()+3600000));
  sessionStorage.setItem('opengeo.organizationId',organizationId);
 },config);
 if(config.registerArtifact){
  await page.goto(`${origin}/workspaces?project=${config.projectId}&manage=resources`);
  await page.locator(`#resource-${config.resourceId}`).getByRole('button',{name:'Open resource',exact:true}).click();
  const panel=page.locator('.project-artifact-versions');
  await panel.getByLabel('Artifact representation',{exact:true}).selectOption('portable-map-html');
  await panel.getByRole('button',{name:'Load Artifact state',exact:true}).click();
  await panel.getByText(/No portable Artifact is registered/).waitFor();
  await panel.getByLabel('Portable Artifact HTML',{exact:true}).setInputFiles({name:'map.html',mimeType:'text/html',buffer:Buffer.from(config.html)});
  await panel.getByLabel('Portable Artifact manifest',{exact:true}).setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(config.manifest))});
  await panel.getByRole('button',{name:'Upload and register portable edition',exact:true}).click();
  await panel.getByText(/revision 1 · current not selected · inspected v1/).waitFor();
  await panel.getByRole('button',{name:'Use inspected edition as current',exact:true}).click();
  await panel.getByText(/revision 2 · current v1/).waitFor();
  await page.reload();
  await page.locator(`#resource-${config.resourceId}`).getByRole('button',{name:'Open resource',exact:true}).click();
  await panel.getByLabel('Artifact representation',{exact:true}).selectOption('portable-map-html');
  await panel.getByRole('button',{name:'Load Artifact state',exact:true}).click();
  await panel.getByText(/revision 2 · current v1/).waitFor();
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/api/_fixture/upload'&&c.status===204).length,1);
  assert.equal(calls.filter(c=>c.path.endsWith('/build-jobs')).length,0);
  assert.deepEqual(calls.filter(c=>c.status>=400&&!(c.method==='GET'&&c.status===404&&c.path.includes('/artifact'))),[]);
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({actualMultipartUpload:true,registeredEdition:1,currentEdition:1,reopened:true,buildsCreated:0,requests:calls.length,routedStudio:builtShell.evidence,blockedOptionalFonts}));
 }else if(config.workbenchExport){
  const result=config.versionUpdate?await inspectProjectVersion(page,config,origin,calls):await exerciseWorkbenchExport(page,config,origin,calls);
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({...result,routedStudio:builtShell.evidence,providerFixtureRequests,blockedOptionalFonts}));
 }else{
 await page.goto(builtShell?`${origin}/workspaces?${config.directoryEntry?'view=publishing':`publication=${config.publicationId}`}`:origin);
 if(config.directoryEntry) {
  await page.locator(`a[href*="publication=${config.publicationId}"]`).first().click();
  await page.waitForURL(url=>url.searchParams.get('publication')===config.publicationId);
 }
 if(builtShell) await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByRole('button',{name:'Load saved references',exact:true}).click();
 await page.getByText(new RegExp(`Saved reference revision ${config.reopenOnly?savedRevision:initialRevision}`)).waitFor();
 if(!config.reopenOnly) {
 if(config.clearExisting) for(const button of await page.getByRole('button',{name:'Remove reference',exact:true}).all()) await button.click();
 await page.getByRole('button',{name:'Load accessible workspaces',exact:true}).click();
 await page.getByLabel('Artifact workspace',{exact:true}).selectOption(config.artifactWorkspaceId);
 await page.getByRole('button',{name:'Load map resources',exact:true}).click();
 await page.getByLabel('Map resource in this workspace',{exact:true}).selectOption(config.resourceId);
 await page.getByRole('button',{name:'Load retained editions',exact:true}).click();
 await page.getByLabel('Retained Artifact edition to add',{exact:true}).selectOption('1');
 await page.getByRole('button',{name:'Add retained Artifact',exact:true}).click();
 assert.equal(await page.getByLabel('Artifact asset path',{exact:true}).inputValue(),'src/maps/artifact-1.html');
 await page.getByLabel('Artifact asset path',{exact:true}).fill('src/maps/survey.html');
 assert.match(await page.getByLabel('Artifact embed HTML',{exact:true}).inputValue(),/src="maps\/survey.html"/);
 await page.getByRole('tab',{name:'Preview',exact:true}).click();
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 assert.equal(await page.getByLabel('Artifact asset path',{exact:true}).inputValue(),'src/maps/survey.html');
 assert.equal(await page.getByLabel('Artifact edition selection',{exact:true}).inputValue(),'pinned');
 assert.equal(await page.getByLabel('Pinned Artifact version',{exact:true}).inputValue(),'1');
 await page.getByRole('button',{name:'Save Artifact references',exact:true}).click();
 await page.getByText(new RegExp(`Saved reference revision ${savedRevision}`)).waitFor();
 await page.reload();
 if(builtShell) await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByRole('button',{name:'Load saved references',exact:true}).click();
 await page.getByText(new RegExp(`Saved reference revision ${savedRevision}`)).waitFor();
 assert.equal(await page.getByLabel('Artifact asset path',{exact:true}).inputValue(),'src/maps/survey.html');
 assert.equal(await page.getByLabel('Artifact edition selection',{exact:true}).inputValue(),'pinned');
 await page.getByRole('tab',{name:'Preview',exact:true}).click();
 await page.getByRole('button',{name:'Prepare current Artifact selection',exact:true}).click();
 await page.getByText(new RegExp(`Prepared reference revision ${savedRevision}`)).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Build saved revision'&&!button.disabled));
 assert.equal(await page.getByRole('button',{name:'Show preview',exact:true}).isHidden(),true);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/build-jobs')).length,0);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/artifact-inputs')&&call.status===200).length,1);
 await page.getByRole('button',{name:'Build saved revision',exact:true}).click();
 await page.getByText(/Saved revision 1 · pending/).waitFor();
 await page.getByRole('button',{name:'Check saved preview',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Show preview'&&!button.hidden&&!button.disabled));
 await page.reload();
 await page.getByRole('tab',{name:'Preview',exact:true}).click();
 await page.getByRole('button',{name:'Prepare current Artifact selection',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Show preview'&&!button.hidden&&!button.disabled));
 assert.equal(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/build-jobs')&&call.status===201).length,1);
 assert.equal(await page.getByRole('button',{name:'Build saved revision',exact:true}).isHidden(),true);
 } else {
  assert.equal(await page.getByLabel('Artifact asset path',{exact:true}).inputValue(),'src/maps/survey.html');
  assert.equal(await page.getByLabel('Artifact edition selection',{exact:true}).inputValue(),'pinned');
  await page.getByRole('tab',{name:'Preview',exact:true}).click();
  await page.getByRole('button',{name:'Prepare current Artifact selection',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Show preview'&&!b.hidden&&!b.disabled));
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/build-jobs')).length,0);
 }
 const popupPromise=context.waitForEvent('page');
 await page.getByRole('button',{name:'Open in new window',exact:true}).click();
 const popup=await popupPromise;popup.setDefaultTimeout(10000);
 await popup.waitForURL(/\/builds\/.*\/output\/index.html$/);
 await popup.frameLocator('iframe').getByText(config.artifactTitle??'Connected portable fixture',{exact:true}).waitFor();
 assert.equal(exchanges,1);assert.ok(delivered>=2);
 const authorizedUrl=popup.url();
 // The preview credentials cannot authorize another build output prefix.
 const response=await popup.evaluate(async url=>{const res=await fetch(url.replace(/\/builds\/[^/]+\//,'/builds/11111111-1111-4111-8111-111111111111/'));return res.status;},authorizedUrl);
 assert.equal(response,403);
 await popup.close();
 assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
 assert.deepEqual(calls.filter(call=>call.status>=400),[], 'Application API requests must succeed');
 if(builtShell) assert.ok(calls.some(call=>call.path.endsWith('/files/src/index.html')&&call.status===200),'Files editor reads retained source');
 console.log(JSON.stringify({dist,directoryEntry:!!config.directoryEntry,blockedOptionalFonts,routedStudio:builtShell?.evidence??null,retainedEditionChooser:!config.reopenOnly,crossWorkspaceReference:!config.reopenOnly&&config.artifactWorkspaceId!==config.projectId,sourceLayoutPath:!config.reopenOnly,relativeEmbedMarkup:!config.reopenOnly,draftSurvivesTabs:!config.reopenOnly,pinnedReopened:true,preparedExactSelection:true,oldPreviewExcluded:true,buildsCreated:config.reopenOnly?0:1,compiledPreviewReopened:true,deliveredPreview:true,cookieScopeEnforced:true,unchangedSelectionReused:true,requests:calls.length,externalRequests:0}));
}
}catch(error){console.error(JSON.stringify({url:diagnosticPage?.url(),body:await diagnosticPage?.locator('body').innerText().catch(()=>''),diagnostics,calls}));throw error;}finally{await browser?.close();await new Promise(done=>server.close(done));}

async function exerciseWorkbenchExport(page,config,origin,calls){
 await page.goto(`${origin}/workspaces?composition=${config.compositionId}`);
 await page.waitForFunction(()=>{
  const map=document.querySelector('.opengeo-workbench')?.__opengeoMap;
  return map?.loaded() && map.getLayer('old-point-style-0') && map.getSource('source-outline-source');
 },null,{timeout:25000});
 await page.locator('.gis-menu-wrap[data-menu="project"] > button').click();
 await page.getByRole('menuitem',{name:/^Export offline vector map/}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByText(/Pinned Style · version 1/).waitFor();
 for(const title of ['Pinned earlier polygon','Referenced source outline']){
  const box=dialog.getByRole('checkbox',{name:new RegExp(title)});assert.equal(await box.isEnabled(),true);await box.check();
 }
 await dialog.getByRole('checkbox',{name:/I have reviewed/}).check();
 const htmlDownload=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download HTML',exact:true}).click();
 const html=await readFile(await (await htmlDownload).path(),'utf8');
 const manifestDownload=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download last export manifest'}).click();
 const manifest=JSON.parse(await readFile(await (await manifestDownload).path(),'utf8'));
 assert.equal(manifest.styleDependencies[0].reference.versionNumber,1);assert.equal(manifest.dependencies.length,2);
 assert.ok(calls.some(c=>c.path.endsWith('/download')&&c.method==='POST'&&c.status===200));
 assert.ok(calls.some(c=>/styles\/[^/]+\/versions\/1$/.test(c.path)&&c.status===200));
 assert.deepEqual(calls.filter(c=>c.method!=='GET'&&!(c.method==='POST'&&c.path.endsWith('/download'))),[],'Inspection/export must not write or build');
 assert.deepEqual(calls.filter(c=>c.status>=400),[]);
 const payload=JSON.parse(html.match(/const publication=(.*);\nconst status/)[1]);
 return {html,manifest,exportTitle:payload.title,exportControls:payload.controls,workbenchExport:true,actualDownloads:true,noBuildOrDataMutation:true,downloadAuthorizations:calls.filter(c=>c.method==='POST'&&c.path.endsWith('/download')).length};
}
