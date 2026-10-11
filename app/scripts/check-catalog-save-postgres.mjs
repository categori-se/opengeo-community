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
const component=await modulePath('components','CatalogProjectSave'),client=await modulePath('lib','apiClient');
const theme='/_observablehq/'+(await readdir(resolve(dist,'_observablehq'))).find(name=>/^theme-.*\.css$/.test(name));
const stylesheet='/_file/'+(await readdir(resolve(dist,'_file'))).find(name=>/^style\..*\.css$/.test(name));
let interruptCreate = true, firstCreateBody = null;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const creating=req.method==='POST'&&req.url.endsWith('/maps');
  if(creating && !firstCreateBody){let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{firstCreateBody=JSON.parse(body);});}
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:req.headers},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode});
   if(creating && interruptCreate && response.statusCode===201){
    interruptCreate=false;response.resume();response.on('end',()=>{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'fixture_response_lost',message:'Interrupted response'}}));});return;
   }
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(req.url.startsWith('/?')||req.url.startsWith('/workspaces?')||req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><link rel="stylesheet" href="${theme}"><link rel="stylesheet" href="${stylesheet}"><main></main><script type="module">
  import {CatalogProjectSave} from '${component}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  const records=await adapter.listCompositions({query:'first'});
  window.original=await adapter.getComposition(records.find(record=>record.name==='first').id);
  window.record={projectId:original.accessContainerId,projectName:'First workspace',datasetId:original.definition.layers[0].datasetId,title:'Catalog saved study'};
  window.directory=CatalogProjectSave({adapter,record,layer:original.definition.layers[0],getView:()=>({center:[85,27],zoom:8,pitch:0,bearing:0})});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;

try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
 const context=await browser.newContext();
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin); await page.getByRole('button',{name:'Save to Project…',exact:true}).click();
 await page.getByLabel('New Project title').fill('Catalog saved study');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Retry Save',exact:true}).waitFor();
 assert.equal(await page.getByLabel('New Project title').isDisabled(),true);
 await page.getByRole('button',{name:'Retry Save',exact:true}).click();
 const link=page.getByRole('link',{name:'Open saved Project'}); await link.waitFor();
 const href=await link.getAttribute('href'); const newId=new URL(href,origin).searchParams.get('composition'); assert.ok(newId);
 const saved=await page.evaluate(id=>adapter.getComposition(id),newId);
 assert.equal(saved.name,'Catalog saved study');assert.equal(saved.definition.layers.length,1);assert.deepEqual(saved.definition.mapViews[0].center,[85,27]);
 const original=await page.evaluate(()=>window.original); assert.deepEqual(saved.definition.layers[0].styleReference,original.definition.layers[0].styleReference);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'Save to Project…',exact:true}).click();
 await page.getByLabel('Search Projects').fill('second');await page.getByRole('button',{name:'Find Projects',exact:true}).click();
 await page.getByText('Choose a Project. Save checks your current edit access.',{exact:true}).waitFor();
 const targetId=await page.getByLabel('Destination').locator('option').nth(1).getAttribute('value');
 const before=await page.evaluate(id=>adapter.getComposition(id),targetId);
 await page.getByLabel('Destination').selectOption(targetId);await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('link',{name:'Open saved Project'}).waitFor();
 const after=await page.evaluate(id=>adapter.getComposition(id),targetId);
 assert.equal(after.version,before.version+1);assert.equal(after.definition.layers.length,before.definition.layers.length+1);
 assert.deepEqual(after.definition.layers[0],before.definition.layers[0]);assert.deepEqual(after.definition.mapViews,before.definition.mapViews);
 assert.equal(after.definition.layers.at(-1).datasetId,saved.definition.layers[0].datasetId);
 await page.screenshot({path:'/tmp/catalog-project-save.png'});
 const matches=await page.evaluate(()=>adapter.listCompositions({query:'Catalog saved study'}));
 assert.equal(matches.filter(record=>record.name==='Catalog saved study').length,1,'lost response creates no duplicate Project');
 const conflict=await page.evaluate(async ({body,workspace})=>{try{await adapter.request(`/projects/${workspace}/maps`,{method:'POST',body:{...body,name:'Changed intent'}});return null;}catch(error){return {status:error.status,code:error.code};}}, {body:firstCreateBody,workspace:config.workspaceId});
 assert.equal(conflict.status,409);assert.equal(conflict.code,'map_creation_key_conflict');
 const denied=await page.evaluate(async ({body,workspace,org})=>{
  const response=await fetch(`/api/projects/${workspace}/maps`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer editor','X-OpenGeo-Organization':org},body:JSON.stringify(body)});return response.status;
 },{body:firstCreateBody,workspace:config.workspaceId,org:config.organizationId});
 assert.ok([403,404,409].includes(denied),'revoked source Style authority prevents save');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/maps')&&c.status===201).length,2);
 console.log(JSON.stringify({passed:true,lostCreateRecoveredWithoutDuplicate:true,changedKeyIntentRejected:true,revokedSourceSaveDenied:true,newProjectReopened:true,existingProjectPreserved:true,sourceAndStyleRetained:true,apiCalls:calls.length,externalRequests:blocked.length}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
