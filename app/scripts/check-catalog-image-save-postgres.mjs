// Reuse built modules; synthetic token verification, real local API/database, no providers.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';
let input='';for await(const part of process.stdin)input+=part;
const config=JSON.parse(input),dist=resolve('dist'),calls=[],blocked=[],errors=[];
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const component=await modulePath('components','PlatformDirectory'),client=await modulePath('lib','apiClient');
const theme='/_observablehq/'+(await readdir(resolve(dist,'_observablehq'))).find(name=>/^theme-.*\.css$/.test(name));
const stylesheet='/_file/'+(await readdir(resolve(dist,'_file'))).find(name=>/^style\..*\.css$/.test(name));
let tiles=0, providerMetadata=0;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:req.headers},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode});
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(req.url.startsWith('/?')||req.url.startsWith('/workspaces')||req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><link rel="stylesheet" href="${theme}"><link rel="stylesheet" href="${stylesheet}"><main></main><script type="module">
  import {PlatformDirectory} from '${component}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  window.signedOut=false;
  window.directory=PlatformDirectory({adapter,view:new URL(location.href).searchParams.get('view'),auth:{signOut:async()=>{window.signedOut=true;}}});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;


try {
const apiOrigin=`http://127.0.0.1:${config.apiPort}`;
const mapServer=config.sourceKind==='mapserver';
const endpoint='https://imagery.example.org/arcgis/rest/services/Coast/'+(mapServer?'MapServer':'ImageServer');
const selectedDisplay=mapServer?{type:'mapserver',layer_ids:[2]}:{type:'imageserver',band_ids:[2,1,0]};
const response=await fetch(`${apiOrigin}/projects/${config.workspaceId}/sources`,{method:'POST',headers:{authorization:'Bearer admin','X-OpenGeo-Organization':config.organizationId,'content-type':'application/json'},body:JSON.stringify({name:'Local coastal imagery',source:{...selectedDisplay,url:endpoint,attribution:'Local coastal imagery fixture'}})});
assert.equal(response.status,201,await response.text().then(text=>{config.sourceResponse=JSON.parse(text);return text;}));
const source=config.sourceResponse;
const png=Buffer.from(config.previewPng,'base64');
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1100,height:900}});
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin)return route.continue();
  if(url.origin==='https://imagery.example.org'&&url.pathname===new URL(endpoint).pathname){
   providerMetadata++;assert.equal(route.request().method(),'GET');
   return route.fulfill({json:{initialExtent:{xmin:-73,ymin:41,xmax:-72,ymax:42,spatialReference:{wkid:4326}},copyrightText:'Local coastal imagery fixture'}});
  }
  if(url.origin==='https://imagery.example.org'&&url.pathname===new URL(endpoint).pathname+(mapServer?'/export':'/exportImage')){
   tiles++;assert.ok(tiles<=40);assert.equal(url.searchParams.get(mapServer?'layers':'bandIds'),mapServer?'show:2':'2,1,0');
   return route.fulfill({contentType:'image/png',body:png});
  }
  blocked.push(url.href);return route.abort();
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 await page.goto(origin+'/workspaces?view=data');
 await page.getByLabel('Catalog entries',{exact:true}).selectOption('layers');
 await page.getByLabel('Search organization datasets',{exact:true}).fill('Local coastal imagery');
 await click('Search catalog');
 await page.locator('.catalog-layer-toggle').filter({hasText:'Local coastal imagery'}).click();
 const beforeSaves=calls.filter(c=>c.method!=='GET').length;
 await click('Open map');
 await page.waitForFunction(()=>document.querySelector('.map-preview-status')?.textContent.includes('ready'));
 assert.equal(calls.filter(c=>c.method!=='GET').length,beforeSaves,'inspection does not save');
 assert.equal(providerMetadata,1);assert.ok(tiles>0);
 assert.equal(page.url(),origin+'/workspaces?view=data');
 await click('Save to Project…');
 await page.getByLabel('New Project title').fill('Coastal inspection');
 await click('Browse access workspaces');
 await page.getByText('Choose an access workspace. Save checks your current edit and Layer access permissions.',{exact:true}).waitFor();
 await page.getByLabel('Access workspace for new Project',{exact:true}).selectOption(config.alternateWorkspaceId);
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(d=>d.open),true);
 // Programmatic shell events also must not dispose the native modal or change account.
 await page.evaluate(other=>{const select=document.querySelector('select[aria-label="Studio account"]');window.accountSelectorFound=!!select;if(select){select.value=other;select.dispatchEvent(new Event('change',{bubbles:true}));}},config.otherOrganizationId);
 assert.equal(await page.evaluate(()=>window.accountSelectorFound),true);
 assert.equal(await page.getByLabel('Studio account',{exact:true}).inputValue(),config.organizationId);
 await page.evaluate(()=>document.querySelector('[data-action="sign-out"]').click());
 assert.equal(await page.evaluate(()=>window.signedOut),false);
 await page.evaluate(()=>{history.pushState(null,'','/workspaces');dispatchEvent(new PopStateEvent('popstate'));});
 assert.equal(page.url(),origin+'/workspaces?view=data');
 await page.evaluate(()=>[...document.querySelectorAll('.studio-navigation a')].find(a=>a.textContent==='Projects').click());
 assert.equal(page.url(),origin+'/workspaces?view=data');
 await click('Save');
 const link=page.getByRole('link',{name:'Open saved Project',exact:true});await link.waitFor();
 const id=new URL(await link.getAttribute('href'),origin).searchParams.get('composition');
 const saved=await page.evaluate(id=>adapter.getComposition(id),id);
 assert.equal(saved.accessContainerId,config.alternateWorkspaceId);
 assert.equal(saved.definition.layers.length,1);const layer=saved.definition.layers[0];
 assert.equal(layer.datasetId,source.dataset_id);assert.equal(layer.sourceVersion,1);
 assert.equal(layer.sourceUrl,endpoint);assert.deepEqual(mapServer?layer.sourceConfiguration.layerIds:layer.sourceConfiguration.bandIds,mapServer?[2]:[2,1,0]);
 assert.equal(layer.sourceType,mapServer?'mapserver-raster':'imageserver-raster');assert.ok(saved.definition.mapViews[0].zoom>1);
 await click('Close');
 await page.getByRole('link',{name:'Projects',exact:true}).click();
 await page.getByRole('link',{name:'Coastal inspection',exact:true}).waitFor();
 await page.reload();await page.getByRole('link',{name:'Coastal inspection',exact:true}).waitFor();
 // Exercise current permissions through the real membership API after positive save.
 const adminHeaders={authorization:'Bearer admin','X-OpenGeo-Organization':config.organizationId,'content-type':'application/json'};
 const candidates=await page.evaluate(()=>adapter.listCompositions({limit:100}));
 const appendTarget=candidates.find(item=>item.accessContainerId===config.workspaceId);
 assert.ok(appendTarget,'fixture has an existing composition in the source workspace');
 const targetPath=`/projects/${config.workspaceId}/maps/${appendTarget.id}`;
 const readTarget=async()=>{const response=await fetch(`${apiOrigin}/compositions/${appendTarget.id}`,{headers:adminHeaders});assert.equal(response.status,200);return response.json();};
 const beforeDeniedAppend=await readTarget();
 const selectExisting=async()=>{
  await click('Save to Project…');
  await page.getByLabel('Search Projects').fill(appendTarget.name);await click('Find Projects');
  await page.getByText('Choose a Project. Save checks your current edit access.',{exact:true}).waitFor();
  await page.getByLabel('Destination',{exact:true}).selectOption(appendTarget.id);
 };
 const membership=await fetch(`${apiOrigin}/projects/${config.workspaceId}/memberships/${config.editorId}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'viewer'})});
 assert.equal(membership.status,200,await membership.text());
 await page.goto(origin+'/workspaces?view=data&actor=editor');
 await page.getByLabel('Catalog entries',{exact:true}).selectOption('layers');
 await page.getByLabel('Search organization datasets',{exact:true}).fill('Local coastal imagery');await click('Search catalog');
 await page.locator('.catalog-layer-toggle').filter({hasText:'Local coastal imagery'}).first().click();
 await click('Open map');await page.waitForFunction(()=>document.querySelector('.map-preview-status')?.textContent.includes('ready'));
 await click('Save to Project…');await page.getByLabel('New Project title').fill('Denied coastal Project');await click('Save');
 await page.getByText('The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New Project title').inputValue(),'Denied coastal Project');
 assert.ok(calls.some(c=>c.method==='POST'&&c.status===403));
 await click('Cancel');
 await selectExisting();const readerAppendMarker=calls.length;await click('Save');
 await page.getByText('The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Destination',{exact:true}).inputValue(),appendTarget.id);
 assert.ok(calls.slice(readerAppendMarker).some(call=>call.path==='/api'+targetPath&&call.method==='PATCH'&&call.status===403));
 assert.deepEqual(await readTarget(),beforeDeniedAppend,'reader append leaves the entire Project unchanged');
 await click('Cancel');
 const restored=await fetch(`${apiOrigin}/projects/${config.workspaceId}/memberships/${config.editorId}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'editor'})});
 assert.equal(restored.status,200);assert.equal((await restored.json()).role,'editor');
 const readable=await fetch(`${apiOrigin}/projects/${config.workspaceId}/datasets/${source.dataset_id}/source`,{headers:{...adminHeaders,authorization:'Bearer editor'}});
 assert.equal(readable.status,200,'source is readable before revocation');
 // Force one competing edit after Save reads its version and before its PATCH.
 await selectExisting();
 let raced=false;
 await page.route('**/api'+targetPath,async route=>{
  if(route.request().method()!=='PATCH'||raced)return route.continue();
  raced=true;
  const body=route.request().postDataJSON();
  const competing=await fetch(`${apiOrigin}${targetPath}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({expected_version:body.expected_version,name:'Concurrent editor title',change_message:'Concurrent local fixture'})});
  assert.equal(competing.status,200,await competing.text());
  await route.continue();
 });
 const conflictMarker=calls.length;await click('Save');
 await page.getByText('The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available.',{exact:true}).waitFor();
 assert.ok(raced);assert.ok(calls.slice(conflictMarker).some(call=>call.method==='PATCH'&&call.status===409));
 assert.equal(await page.getByLabel('Destination',{exact:true}).inputValue(),appendTarget.id);
 const retryResponse=page.waitForResponse(response=>response.url()===origin+'/api'+targetPath&&response.request().method()==='PATCH');
 await click('Save');const retried=await retryResponse;assert.equal(retried.status(),200,await retried.text());
 await page.getByRole('link',{name:'Open saved Project',exact:true}).waitFor();
 await page.unroute('**/api'+targetPath);
 const recovered=await readTarget();
 assert.equal(recovered.name,'Concurrent editor title');
 assert.deepEqual(recovered.definition.layers.slice(0,-1),beforeDeniedAppend.definition.layers);
 assert.deepEqual(recovered.definition.mapViews,beforeDeniedAppend.definition.mapViews);
 assert.equal(recovered.definition.layers.at(-1).datasetId,source.dataset_id);
 await click('Close');
 appendTarget.name='Concurrent editor title';
 await selectExisting();
 const demoted=await fetch(`${apiOrigin}/projects/${config.workspaceId}/memberships/${config.editorId}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'viewer'})});
 assert.equal(demoted.status,200);
 const demotionMarker=calls.length;await click('Save');
 await page.getByText('The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available.',{exact:true}).waitFor();
 assert.ok(calls.slice(demotionMarker).some(call=>call.method==='PATCH'&&call.status===403));
 assert.deepEqual(await readTarget(),recovered,'lost edit authority cannot append after the dialog opens');
 await click('Cancel');
 const restoreAgain=await fetch(`${apiOrigin}/projects/${config.workspaceId}/memberships/${config.editorId}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify({role:'editor'})});
 assert.equal(restoreAgain.status,200);
 await click('Save to Project…');await page.getByLabel('New Project title').fill('Revoked coastal Project');
 const revokedMarker=calls.length;
 for(const workspace of [config.workspaceId,config.alternateWorkspaceId]) {
  const revoked=await fetch(`${apiOrigin}/projects/${workspace}/memberships/${config.editorId}`,{method:'DELETE',headers:adminHeaders});
  assert.ok([204,404].includes(revoked.status),await revoked.text());
 }
 await click('Save');await page.getByText('The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('New Project title').inputValue(),'Revoked coastal Project');
 assert.ok(calls.slice(revokedMarker).some(c=>c.method==='POST'&&[403,404].includes(c.status)));
 const inventory=await fetch(`${apiOrigin}/compositions?limit=100`,{headers:adminHeaders});assert.equal(inventory.status,200);
 const records=await inventory.json();assert.ok(records.every(record=>!['Denied coastal Project','Revoked coastal Project'].includes(record.name)));
 await click('Cancel');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 console.log(JSON.stringify({passed:true,newProjectWorkspaceChosen:true,catalogImagePreview:true,registeredBandsPreserved:true,inspectionReadOnly:true,sourceIdentityRetained:true,projectReopened:true,shellAccountSignOutAndNavigationGuards:true,readerAppendDeniedWithoutMutation:true,editAuthorityLostDuringAppendDenied:true,concurrentAppendRetryPreservesOtherEdits:true,readerSaveDenied:true,revokedSaveDenied:true,denialsCreateNoProject:true,providerMetadataFixtures:providerMetadata,tileFixtures:tiles,apiCalls:calls.length,externalRequests:0}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
