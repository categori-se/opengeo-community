// Reuse built modules; synthetic token verification, real local API/database, no providers.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';
let input='';for await(const part of process.stdin)input+=part;
const config=JSON.parse(input),dist=resolve('dist'),calls=[],blocked=[],errors=[];
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const component=await modulePath('components','ProjectWorkspacePage'),client=await modulePath('lib','apiClient');
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
  import {ProjectWorkspacePage} from '${component}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  window.signedOut=false;
  const kind=new URL(location.href).searchParams.get('kind')||'project';
  window.directory=ProjectWorkspacePage({adapter,projectId:kind==='project'?${JSON.stringify(config.workspaceId)}:${JSON.stringify(config.publicationWorkspaceId)},compositionId:kind==='project'?${JSON.stringify(config.mapId)}:null,publicationId:kind==='publication'?${JSON.stringify(config.siteId)}:null});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;

try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();blocked.push(url.origin);if(url.pathname.includes('/styles/'))return route.fulfill({json:{version:8,sources:{},layers:[]}});return route.abort();});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 for(const kind of ['project','publication']) {
  await page.goto(origin+'/?kind='+kind+'&actor=admin');
  const host=page.locator('.authored-resource-metadata');await host.locator('summary').click();
  await host.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await host.getByText('Edit metadata record',{exact:true}).click();
  const input=host.getByLabel('Metadata JSON',{exact:true});await input.waitFor();
  const draft=JSON.parse(await input.inputValue());draft.metadata.curated.push({subject:'resource',property:'http://purl.org/dc/terms/license',value:null,provenance:'unknown'});
  await input.fill(JSON.stringify(draft));
  const draftText=await input.inputValue(),currentUrl=page.url();
  await page.locator('.platform-workspace a[href]').first().click();
  await host.getByText('Save or discard the metadata draft before leaving or refreshing.',{exact:true}).waitFor();
  assert.equal(page.url(),currentUrl);assert.equal(await input.inputValue(),draftText);
  await page.evaluate(()=>{document.querySelector('.resource-knowledge [role="status"]').textContent='';history.pushState(null,'',location.href+'&historyProbe=1');});
  await page.goBack();
  await host.getByText('Save or discard the metadata draft before leaving or refreshing.',{exact:true}).waitFor();
  assert.equal(page.url(),currentUrl);assert.equal(await input.inputValue(),draftText);
  let unloadPrompt=false;page.once('dialog',async dialog=>{unloadPrompt=dialog.type()==='beforeunload';await dialog.dismiss();});
  await page.reload({timeout:5000}).catch(error=>{if(!/ERR_ABORTED|Timeout/.test(error.message))throw error;});
  assert.equal(unloadPrompt,true);assert.equal(await input.inputValue(),draftText);
  await page.setViewportSize({width:390,height:844});await input.scrollIntoViewIfNeeded();
  const bounds=await input.boundingBox();assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=391 && bounds.y>=0 && bounds.y+bounds.height<=844,JSON.stringify(bounds));
  const output=resolve('../.local-archives/authored-metadata-hosts-20260919');await mkdir(output,{recursive:true});
  await page.screenshot({path:resolve(output,kind+'-metadata-mobile.png')});
  assert.equal(await input.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===node;}),true,'Editor is visible and not clipped or covered');
  await page.setViewportSize({width:1280,height:900});

  await host.getByRole('button',{name:'Save metadata revision',exact:true}).click();
  await host.getByText(/Saved metadata revision/).waitFor();
  await page.reload();await host.locator('summary').click();await host.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await host.getByText('Provenance: unknown',{exact:false}).waitFor();
  await page.goto(origin+'/?kind='+kind+'&actor=editor');await host.locator('summary').click();await host.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await host.getByText('Provenance: unknown',{exact:false}).waitFor();
  assert.equal(await host.getByLabel('Metadata JSON',{exact:true}).count(),0);
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({projectAndPublicationHosts:true,actualApiAndDatabase:true,unknownLicenseReopened:true,readerWriteUiAbsent:true,draftLinkAndBackGuards:true,browserExitPrompt:true,mobileEditorFits:true,calls,externalProvidersContacted:0,blockedOrigins:[...new Set(blocked)],errors}));
} finally {await browser?.close();await new Promise(done=>server.close(done));}
