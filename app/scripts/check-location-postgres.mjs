// Reuse built modules; synthetic token verification, real local API/database, no providers.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {feature as topologyFeature} from 'topojson-client';
if(process.env.OPENGEO_LOCATION_FIXTURE_CHECK==='1'||process.env.OPENGEO_LOCATION_OWNER_GEOMETRY==='1'){
 await checkLocationFixture();
 process.exit(0);
}
let input='';for await(const part of process.stdin)input+=part;
const config=JSON.parse(input),dist=resolve('dist'),calls=[],blocked=[],errors=[];
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const component=await modulePath('components','PlatformDirectory'),client=await modulePath('lib','apiClient');
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:req.headers},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode});res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(req.url.startsWith('/?')||req.url.startsWith('/workspaces?')||req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><main></main><script type="module">
  import {PlatformDirectory} from '${component}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  window.directory=PlatformDirectory({adapter:window.adapter,view:'locations'});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
 const context=await browser.newContext();
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const click=label=>page.getByRole('button',{name:label,exact:true}).click();
 await page.goto(origin);
 await page.getByLabel('New Geographic tag name',{exact:true}).fill('Browser field station');await click('Create Geographic tag');
 await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Geometry GeoJSON',{exact:true}).inputValue(),'null');
 await page.getByLabel('Other names, one per line',{exact:true}).fill('Station Alpha');
 await page.getByLabel('Geometry GeoJSON',{exact:true}).fill(JSON.stringify({type:'Point',coordinates:[-71.2,42.1]}));
 await page.getByLabel('Historical revision',{exact:true}).fill('1');await click('Inspect revision');
 await page.getByRole('heading',{name:'Historical revision 1',exact:true}).waitFor();
 assert.match(await page.getByLabel('Geometry GeoJSON',{exact:true}).inputValue(),/-71.2/);
 for (const [provider,identifier] of [['kartaview','12345'],['mapillary','67890']]) {
  await page.getByLabel('Context provider',{exact:true}).selectOption(provider);
  await page.getByLabel('Provider observation identifier',{exact:true}).fill(identifier);
  await page.getByLabel('Observation attribution, if known',{exact:true}).fill('Fixture contributor');
  await click('Add provider reference to draft');
 }
 await click('Save Geographic tag');await page.locator('.location-directory [role=status]').filter({hasText:'Geographic tag saved.'}).waitFor();
 const savedUrl=page.url();assert.match(savedUrl,/view=locations&location=/);
 await page.reload();await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Other names, one per line',{exact:true}).inputValue(),'Station Alpha');
 assert.equal(await page.locator('.provider-context li').count(),2);
 assert.equal(await page.locator('.provider-context img, .provider-context iframe').count(),0);
 assert.equal(await page.getByRole('link',{name:'Mapillary observation 67890',exact:true}).getAttribute('href'),'https://www.mapillary.com/app/?pKey=67890');
 const providerKnowledge=await page.evaluate(()=>JSON.parse(document.querySelector('[aria-label="Recorded knowledge JSON"]').value));
 assert.equal(providerKnowledge.context.length,2);
 assert.equal(providerKnowledge.metadata.curated[0].value.license,null);
 assert.equal(providerKnowledge.metadata.curated[0].value.verification,'user_supplied_unverified');

 assert.match(await page.getByLabel('Geometry GeoJSON',{exact:true}).inputValue(),/-71.2/);
 await page.getByLabel('Historical revision',{exact:true}).fill('1');await click('Inspect revision');
 await page.getByRole('heading',{name:'Historical revision 1',exact:true}).waitFor();
 assert.match(await page.locator('.location-directory pre').textContent(),/"geometry": null/);
 await page.getByLabel('Geographic tag name',{exact:true}).fill('Unfinished place');
 await page.getByLabel('Studio account',{exact:true}).selectOption(config.otherOrganizationId);
 assert.equal(await page.getByLabel('Studio account',{exact:true}).inputValue(),config.organizationId);
 await click('Discard draft and reload');await page.waitForFunction(()=>!window.directory.resourceDirectory.shouldBlockNavigation());
 await page.getByLabel('Studio account',{exact:true}).selectOption(config.otherOrganizationId);
 await page.getByText('No Geographic tags yet.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Browser field station',exact:true}).count(),0);
 const identity=new URL(savedUrl).searchParams.get('location');
 assert.equal(await page.evaluate(async id=>{try{await window.adapter.getLocation(id);return 200;}catch(error){return error.status;}},identity),404);
 await page.getByLabel('Studio account',{exact:true}).selectOption(config.organizationId);
 await click('Browser field station');await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();
 await click('Load resource links');
 for(const kind of ['layer','project','publication','collection']) {
  await page.getByLabel('Related resource type',{exact:true}).selectOption(kind);await click('Browse related resources');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Related resource"]')?.options.length>0);
  await click('Add resource link');
 }
 assert.equal(await page.getByRole('button',{name:'Save Geographic tag',exact:true}).isDisabled(),true);
 await click('Save resource links');await page.locator('.location-directory [role=status]').filter({hasText:'Resource links saved.'}).waitFor();
 assert.equal(await page.locator('.location-resource-links ol li').count(),4);
 await page.locator('.location-resource-links ol li').first().getByRole('button',{name:'Move link down',exact:true}).click();
 await click('Save resource links');await page.locator('.location-directory [role=status]').filter({hasText:'Resource links saved.'}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();await click('Load resource links');
 await page.waitForFunction(()=>document.querySelectorAll('.location-resource-links ol li').length===4);
 assert.match(await page.locator('.location-resource-links ol li').first().textContent(),/^project:/);
 await page.getByLabel('New Geographic tag name',{exact:true}).fill('Browser parent district');await click('Create Geographic tag');
 await page.getByRole('heading',{name:'Browser parent district',exact:true}).waitFor();
 const parentId=new URL(page.url()).searchParams.get('location');
 await page.goto(savedUrl);await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();
 await click('Load parent relationship');await click('Browse parent Geographic tags');
 await page.getByLabel('Parent Geographic tag',{exact:true}).selectOption(parentId);
 await page.getByLabel('Parent evidence URIs, one per line',{exact:true}).fill('urn:survey:district');
 await page.getByLabel('Parent relationship confidence',{exact:true}).fill('0.8');
 assert.equal(await page.getByRole('button',{name:'Save Geographic tag',exact:true}).isDisabled(),true);
 await click('Save parent relationship');await page.locator('.location-directory [role=status]').filter({hasText:'Parent relationship saved.'}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();await click('Load parent relationship');
 await page.locator('.location-hierarchy').getByRole('link',{name:'Browser parent district',exact:true}).waitFor();
 await click('Load account members');await page.getByLabel('Account member',{exact:true}).selectOption(config.editorId);
 await click('Apply Geographic tag access');await click('Inspect sharing');await page.getByRole('button',{name:'Revoke Geographic tag access',exact:true}).waitFor();
 const reader=await context.newPage();reader.setDefaultTimeout(10000);reader.on('pageerror',e=>errors.push(e.message));
 await reader.goto(origin+'/?actor=editor');await reader.getByRole('button',{name:'Browser field station',exact:true}).click();
 await reader.getByRole('heading',{name:'Browser field station',exact:true}).waitFor();
 assert.equal(await reader.getByRole('button',{name:'Save Geographic tag',exact:true}).isDisabled(),true);
 assert.equal(await reader.getByRole('button',{name:'Inspect sharing',exact:true}).count(),0);
 await reader.getByLabel('Historical revision',{exact:true}).fill('1');await reader.getByRole('button',{name:'Inspect revision',exact:true}).click();
 await reader.getByRole('heading',{name:'Historical revision 1',exact:true}).waitFor();
 await reader.getByRole('button',{name:'Load parent relationship',exact:true}).click();
 await reader.getByText('Parent unavailable. Its details require separate access.',{exact:true}).waitFor();
 assert.equal(await reader.locator('.location-hierarchy a').count(),0);
 await click('Remove parent relationship');await page.getByText('No parent recorded.',{exact:true}).waitFor();
 await page.getByLabel('Parent relationship revision',{exact:true}).fill('1');await click('Inspect parent history');
 await page.getByRole('heading',{name:'Historical parent relationship',exact:true}).waitFor();
 await page.locator('.location-hierarchy').getByRole('link',{name:'Browser parent district',exact:true}).waitFor();
 await reader.getByRole('button',{name:'Load resource links',exact:true}).click();
 await reader.getByText('Resource unavailable. Separate access is required.',{exact:true}).first().waitFor();
 assert.equal(await reader.getByRole('button',{name:'Save resource links',exact:true}).count(),0);
 await click('Load resource links');await page.waitForFunction(()=>document.querySelectorAll('.location-resource-links ol li').length===4);
 await page.locator('.location-resource-links ol li').first().getByRole('button',{name:'Remove resource link',exact:true}).click();
 await click('Save resource links');await page.locator('.location-directory [role=status]').filter({hasText:'Resource links saved.'}).waitFor();
 assert.equal(await page.locator('.location-resource-links ol li').count(),3);
 await page.getByLabel('Resource link history revision',{exact:true}).fill('1');await click('Inspect resource link history');
 await page.getByRole('heading',{name:'Resource links at revision 1',exact:true}).waitFor();
 assert.equal(await page.locator('.location-resource-links ol').last().locator('li').count(),4);
 await click('Revoke Geographic tag access');await click('Inspect sharing');await page.getByText('No explicit sharing grants.',{exact:true}).waitFor();
 await reader.reload();await reader.waitForFunction(()=>document.querySelector('.location-directory [role=status]')?.textContent.includes('could not finish'));
 assert.equal(await reader.getByRole('heading',{name:'Browser field station',exact:true}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 assert.equal(calls.some(x=>/build|render|processing/.test(x.path)),false);
 console.log(JSON.stringify({authoring:true,providerReferencesReopened:true,geometryReopened:true,historyReadOnly:true,durableLink:true,draftAccountGuard:true,accountIsolation:true,readerHistory:true,sharingRevocation:true,parentReopened:true,parentHistory:true,hiddenParent:true,resourceLinksReopened:true,resourceLinksHistory:true,resourceLinksRedacted:true,localApiRequests:calls.length,externalRequests:blocked.length}));
}finally{await browser?.close();await new Promise(done=>server.close(done));}

// Opt-in local UI check; the existing Postgres acceptance above is unchanged.
async function checkLocationFixture(){
 const ownerMode=process.env.OPENGEO_LOCATION_OWNER_GEOMETRY==='1';
 const started=Date.now(),output=resolve(process.env.OPEN_GEO_LOCATION_UI_OUTPUT||'.local-archives/studio-sharing/noaa-owner-workflow/pattern-geography-candidate/geography-ui');
 const receipt={status:'started',scope:'Current LocationDirectory with memory adapter; no live account persistence claim',assertions:[],screenshots:[],externalRequests:0,pageErrors:[],limits:{runSeconds:30,AWSRequests:0,providerRequests:0,canonicalBuilds:0}};
 let browser,server,timer,owner;
 try{
  if(ownerMode) owner=await prepareCountryOwner(receipt,started);
  if(owner?.sdkOnly){await owner.authenticate();await owner.journey();receipt.status='passed';return;}
  const bundle=await build({stdin:{resolveDir:resolve('app'),sourcefile:'location-offline-fixture.js',contents:ownerMode?`
import {LocationDirectory} from './src/components/LocationDirectory.js';
let view;const adapter={kind:'api',...Object.fromEntries(${JSON.stringify(owner?.bridgeMethods??['listLocations','getLocation','getLocationLinks','saveLocation'])}.map(method=>[method,(...args)=>window.ownerLocationCall(method,args)]))};
window.mountLocationDirectory=()=>{view?.dispose();view?.remove();view=LocationDirectory({adapter});document.querySelector('main').replaceChildren(view)};
document.documentElement.style.setProperty('--theme-background','#202020');document.documentElement.style.setProperty('--theme-background-alt','#262626');document.documentElement.style.setProperty('--theme-foreground','#eeeeee');document.documentElement.style.setProperty('--theme-foreground-muted','#aaaaaa');document.documentElement.style.setProperty('--theme-foreground-faintest','#555555');document.documentElement.style.setProperty('--theme-foreground-focus','#669df5');document.body.style.background='var(--theme-background)';document.body.style.color='var(--theme-foreground)';window.mountLocationDirectory();
`:`
import {LocationDirectory} from './src/components/LocationDirectory.js';
const id='10000000-0000-4000-8000-000000000001',projectId='20000000-0000-4000-8000-000000000001',datasetId='30000000-0000-4000-8000-000000000001',versionId='40000000-0000-4000-8000-000000000001';
const polygon={type:'Polygon',coordinates:[[[68,8],[76,8],[88,21],[97,28],[78,36],[68,23],[68,8]]]};
const clone=value=>structuredClone(value),calls=[],callbacks=[];let view;
let record={id,revision:1,currentRevision:1,role:'owner',document:{title:'India',canonical_uri:'http://www.wikidata.org/entity/Q668',aliases:[],identifiers:[],geometry:null,knowledge:{schemaVersion:'1.0.0',distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]}}};
const adapter={kind:'fixture',
 listLocations:async()=>{calls.push({method:'listLocations'});return [{id,title:record.document.title,revision:record.revision}]},
 getLocation:async value=>{if(value!==id)throw Error('Wrong Geographic tag');calls.push({method:'getLocation',id:value});return clone(record)},
 getLocationLinks:async value=>{if(value!==id)throw Error('Wrong links scope');calls.push({method:'getLocationLinks'});return {revision:1,currentRevision:1,entries:[{available:true,kind:'layer',target_id:datasetId,title:'Country boundaries',relationship:'http://purl.org/dc/terms/spatial',evidence:['urn:fixture:source'],confidence:null}]}},
 searchDatasets:async options=>{calls.push({method:'searchDatasets',options});return [{id:datasetId,projectId,name:'Country boundaries',currentVersionId:versionId,currentVersionNumber:3}]},
 getDatasetSpatialPreview:async(project,dataset,version)=>{if(project!==projectId||dataset!==datasetId||version!==versionId)throw Error('Wrong boundary version');calls.push({method:'getDatasetSpatialPreview',project,dataset,version});return {datasetVersionId:versionId,geojson:{type:'FeatureCollection',features:[{type:'Feature',id:'IN',properties:{NAME:'India'},geometry:clone(polygon)}]},numberReturned:1,numberMatched:1,mayBeTruncated:false}},
 saveLocation:async(document,expected)=>{if(expected.id!==id||expected.revision!==record.revision)throw Error('Wrong saved revision');calls.push({method:'saveLocation',expected:clone(expected)});record={...record,document:clone(document),revision:record.revision+1,currentRevision:record.revision+1};return clone(record)}
};
window.locationFixture={id,projectId,datasetId,versionId,polygon,calls:()=>clone(calls),callbacks:()=>clone(callbacks),record:()=>clone(record)};
window.mountLocationDirectory=()=>{view?.dispose();view?.remove();view=LocationDirectory({adapter,onSearchTaggedLayers:record=>callbacks.push({mode:'tags',record:clone(record)}),onUseSavedSearchArea:record=>callbacks.push({mode:'area',record:clone(record)})});document.querySelector('main').replaceChildren(view)};
document.documentElement.style.setProperty('--theme-background','#202020');document.documentElement.style.setProperty('--theme-background-alt','#262626');document.documentElement.style.setProperty('--theme-foreground','#eeeeee');document.documentElement.style.setProperty('--theme-foreground-muted','#aaaaaa');document.documentElement.style.setProperty('--theme-foreground-faintest','#555555');document.documentElement.style.setProperty('--theme-foreground-focus','#669df5');document.body.style.background='var(--theme-background)';document.body.style.color='var(--theme-foreground)';
window.mountLocationDirectory();
`},bundle:true,format:'esm',write:false});
  const css=await readFile(resolve('app/src/style.css'));
  server=createServer((req,res)=>{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
   else if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
   else if(url.pathname==='/'||url.pathname==='/workspaces'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body style="margin:0;padding:12px"><main></main><script type="module" src="/fixture.js"></script>');}
   else res.writeHead(404).end();
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark',serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();receipt.externalRequests++;return route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(2500);page.on('pageerror',error=>receipt.pageErrors.push(error.message));
  if(ownerMode){await page.exposeBinding('ownerLocationCall',(_source,method,args)=>owner.invoke(method,args));await owner.authenticate();}
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  const passed=name=>receipt.assertions.push(name);
  const details=name=>page.locator('summary').filter({hasText:new RegExp('^'+name+'$')}).locator('..');
  const snapshot=async width=>{
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Horizontal overflow at '+width);
   const shape=await page.locator('.location-overview svg path').getAttribute('d');assert.ok(shape&&shape.length>15,'Boundary SVG has no path');
   const controls=await page.locator('.location-search-actions button:visible').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));
   assert.ok(controls.every(control=>control.left>=0&&control.right<=width+1),'Search actions clipped');
   const file=resolve(output,'geographic-tag-'+width+'.png');await page.screenshot({path:file,fullPage:true});receipt.screenshots.push(file);
   passed(width+'px boundary SVG paints a nonempty path; search actions and page stay within viewport');
  };
  await mkdir(output,{recursive:true});
  const journey=async()=>{
   await page.goto(origin+'/workspaces?view=locations&location=10000000-0000-4000-8000-000000000001');
   await page.getByRole('heading',{name:'India',exact:true}).waitFor();
   await page.getByText('No boundary selected. Add a saved search area to reuse geographic bounds.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Use saved search area',exact:true}).isDisabled(),true);
   assert.equal(await details('Edit Geographic tag').evaluate(node=>node.open),false);
   assert.equal(await details('Street imagery and provider context').evaluate(node=>node.open),false);
   assert.equal(await details('Advanced: manual GeoJSON and source').evaluate(node=>node.open),false);
   let calls=await page.evaluate(()=>window.locationFixture.calls());
   assert.equal(calls.filter(call=>call.method==='getLocationLinks').length,1);assert.equal(calls.some(call=>call.method==='saveLocation'||call.method==='getDatasetSpatialPreview'),false);
   await page.getByRole('link',{name:'layer: Country boundaries',exact:true}).waitFor();
   passed('India opens with no boundary, collapsed editor/provider controls and one automatic related-resource read; no preview or writes');
   await click('Search tagged layers');
   await click('Choose boundary');await click('Search boundary Layers');
   await page.getByLabel('Boundary Layer',{exact:true}).selectOption('30000000-0000-4000-8000-000000000001');
   await click('Load boundary features');await page.getByLabel('Boundary feature',{exact:true}).selectOption('0');
   await page.locator('.location-boundary-candidate svg path').waitFor();await click('Use boundary in draft');
   assert.equal(await page.getByRole('button',{name:'Search tagged layers',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'Use saved search area',exact:true}).isDisabled(),true);
   calls=await page.evaluate(()=>window.locationFixture.calls());assert.equal(calls.filter(call=>call.method==='getDatasetSpatialPreview').length,1);assert.equal(calls.filter(call=>call.method==='saveLocation').length,0);
   passed('Deliberate Layer/version preview selects India polygon into an unsaved draft; search actions wait for save');
   await click('Save Geographic tag');await page.locator('.location-directory > [role=status]').filter({hasText:'Geographic tag saved.'}).waitFor();
   let record=await page.evaluate(()=>window.locationFixture.record());
   const claim=record.document.knowledge.metadata.curated.find(item=>item.method==='Boundary source selected in Geographic tags');
   assert.equal(record.revision,2);assert.equal(claim.value.datasetVersionNumber,3);assert.equal(claim.value.datasetVersionId,'40000000-0000-4000-8000-000000000001');assert.equal(claim.value.datasetId,'30000000-0000-4000-8000-000000000001');assert.equal(claim.value.featureId,'IN');assert.equal(claim.property,'http://www.w3.org/ns/prov#wasDerivedFrom');assert.deepEqual(record.document.geometry,await page.evaluate(()=>window.locationFixture.polygon));
   passed('Save retains exact Layer identity, version3, feature IN, polygon and curated boundary provenance');
   await page.evaluate(()=>window.mountLocationDirectory());await page.getByRole('img',{name:'India: saved Polygon search area',exact:true}).waitFor();
   assert.match(await page.locator('.location-boundary-source').textContent(),/Country boundaries.*v3.*India/);
   assert.equal(await details('Edit Geographic tag').evaluate(node=>node.open),false);
   await click('Search tagged layers');await click('Use saved search area');
   const callbacks=await page.evaluate(()=>window.locationFixture.callbacks());assert.deepEqual(callbacks.map(item=>item.mode),['tags','tags','area']);assert.equal(callbacks[0].record.document.geometry,null);assert.equal(callbacks[2].record.revision,2);assert.deepEqual(callbacks[2].record.document.geometry,record.document.geometry);assert.equal(callbacks[1].record.document.canonical_uri,'http://www.wikidata.org/entity/Q668');
   passed('Reopen restores saved boundary and separates recognized-place tagged search from saved-area callbacks');
   await snapshot(1280);
   await page.setViewportSize({width:390,height:900});await page.evaluate(()=>window.mountLocationDirectory());await page.getByRole('img',{name:'India: saved Polygon search area',exact:true}).waitFor();
   await snapshot(390);
   calls=await page.evaluate(()=>window.locationFixture.calls());assert.equal(calls.filter(call=>call.method==='saveLocation').length,1);assert.equal(calls.filter(call=>call.method==='getDatasetSpatialPreview').length,1);
   assert.deepEqual(receipt.pageErrors,[]);assert.equal(receipt.externalRequests,0);receipt.fixtureCalls=calls;receipt.callbacks=callbacks.map(({mode,record})=>({mode,id:record.id,revision:record.revision,hasGeometry:Boolean(record.document.geometry)}));
   passed('One fixture save and one explicit boundary preview across both widths; zero external requests or runtime errors');
  };
  const remaining=ownerMode?owner.deadline-Date.now():30_000-(Date.now()-started);assert.ok(remaining>0,'Fixture setup exhausted the run allowance');
  await Promise.race([ownerMode?owner.journey(page,origin):journey(),...(ownerMode?[owner.bridgeFailure]:[]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Geographic tag UI run reached its time ceiling')),remaining);})]);
  receipt.status='passed';
 }catch(error){receipt.status='failed';receipt.error={name:error.name,message:ownerMode?String(error.message).slice(0,2000):error.message,...(Number.isInteger(error.status)?{status:error.status}:{}),...(typeof error.code==='string'?{code:error.code}:{})};if(ownerMode)throw Object.assign(new Error(receipt.error.message),{name:error.name,...(Number.isInteger(error.status)?{status:error.status}:{}),...(typeof error.code==='string'?{code:error.code}:{})});throw error;}
 finally{clearTimeout(timer);owner?.clear();await browser?.close();if(server)await new Promise(done=>server.close(done));receipt.elapsedSeconds=(Date.now()-started)/1000;await mkdir(output,{recursive:true});if(ownerMode){if(owner)await owner.finalize();}else await writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
}

async function prepareCountryOwner(receipt,runStarted){
 if(process.env.OPENGEO_COUNTRY_OFFLINE_READBACK==='1')return prepareOfflineCountryReadback(receipt,runStarted);
 const numericCompletion=process.env.OPENGEO_COUNTRY_NUMERIC_COMPLETION==='1';
 const base=resolve('.local-archives/studio-sharing/noaa-owner-workflow'),destination=resolve(base,numericCompletion?'country-tag-geometries-numeric-completion.json':'country-tag-geometries-readback-recovery.json'),privateDir=resolve(base,numericCompletion?'country-tag-geometries-numeric-completion-bodies':'country-tag-geometries-readback-recovery-bodies');
 assert.ok(numericCompletion||process.env.OPENGEO_COUNTRY_READBACK_CORRECTION==='1','Only the explicitly authorized correction may run');
 assert.equal(existsSync(destination),false,'A final country readback recovery exists; do not replay');
 const priorReceipts=[];
 for(const name of ['country-tag-geometries.json','country-tag-geometries-continuation.json',...(numericCompletion?['country-tag-geometries-readback-recovery.json','country-tag-geometries-offline-readback-ui.json']:[])]){const path=resolve(base,name),bytes=await readFile(path);priorReceipts.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),record:JSON.parse(bytes)});}
 const previous=priorReceipts[numericCompletion?2:1].record,offline=numericCompletion?priorReceipts[3].record:null;
 assert.equal(previous.status,'failed');
 if(numericCompletion){assert.equal(previous.result.newGeometryAssociationsSaved,0);assert.equal(previous.pendingOperation,null);assert.equal(offline.status,'passed');assert.equal(offline.result.IndiaSemanticReadbackAccepted,true);assert.equal(offline.nativeOwnerUIExecuted,true);assert.equal(previous.cumulativeUsage.APIRequests,11);assert.equal(previous.cumulativeUsage.SRPRequests,6);}
 else {assert.equal(previous.result.geometryAssociationsSaved,1);assert.equal(previous.pendingOperation.method,'readback');assert.equal(previous.pendingOperation.acceptedRevision,2);assert.deepEqual(previous.cumulativeUsage,{APIRequests:9,SRPRequests:4,seconds:73.207});}
 const priorUsage={...previous.cumulativeUsage,seconds:numericCompletion?Number((previous.cumulativeUsage.seconds+offline.elapsedSeconds).toFixed(3)):previous.cumulativeUsage.seconds};
 const limits={APIRequestsAdditional:numericCompletion?16:17,APIRequestsCumulative:numericCompletion?27:26,SRPRequestsAdditional:2,SRPRequestsCumulative:numericCompletion?8:6,activeSecondsAdditional:numericCompletion?Number((120-priorUsage.seconds).toFixed(3)):46.793,activeSecondsCumulative:120,responseBytes:2097152,providerRequests:0,S3Requests:0,directAWSRequests:0,GISCaptureBytes:0,IndiaWrites:0};
 const plans=JSON.parse(await readFile(resolve(base,'manifest.json'),'utf8')).initialCountryTagsBatch.geometryContinuation,operationalPlan=numericCompletion?plans.numericRoundtripCorrection:plans.readbackMethodCorrection;
 assert.ok(operationalPlan);assert.equal(operationalPlan.limits.additionalAPIRequests,limits.APIRequestsAdditional);assert.equal(operationalPlan.limits.APIRequestsCumulative,limits.APIRequestsCumulative);assert.equal(operationalPlan.limits.additionalSRPRequests,limits.SRPRequestsAdditional);assert.equal(operationalPlan.limits.SRPRequestsCumulative,limits.SRPRequestsCumulative);assert.equal(operationalPlan.limits.activeSecondsCumulative,limits.activeSecondsCumulative);
 if(numericCompletion){assert.ok(Math.abs(operationalPlan.limits.remainingActiveSeconds-(120-previous.cumulativeUsage.seconds))<1e-9);assert.equal(priorUsage.seconds,86.224);assert.equal(limits.activeSecondsAdditional,33.776);}else assert.equal(operationalPlan.limits.additionalActiveSeconds,limits.activeSecondsAdditional);
 const sourcePath='/home/aaron/framework/fork/fork/fork/src/countries-50m.json',sourceBytes=await readFile(sourcePath),hash=createHash('sha256').update(sourceBytes).digest('hex');
 assert.equal(hash,'04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394');
 const source=JSON.parse(sourceBytes),features=source.type==='Topology'?topologyFeature(source,source.objects.countries).features:source.features,prior=JSON.parse(await readFile(resolve(base,'initial-country-tags.json'),'utf8')),numeric={Q917:64,Q837:524,Q148:156,Q668:356,Q854:144,Q826:462};
 const rows=prior.countryTags.map(row=>{const feature=features.find(item=>Number(item.id)===numeric[row.qid]);assert.ok(feature);assert.ok(['Polygon','MultiPolygon'].includes(feature.geometry.type));assert.ok(Buffer.byteLength(JSON.stringify(feature.geometry))<=262144);return {...row,featureId:feature.id,geometry:feature.geometry}});
 assert.equal(rows.length,6);const india=rows.find(row=>row.qid==='Q668');assert.equal(numericCompletion?previous.retainedLocationBodies[0].id:previous.pendingOperation.id,india.id);
 const geometryBytes=rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.geometry)),0);assert.equal(geometryBytes,178031);
 const authBytes=await readFile(resolve(base,'framework-live-preview/pattern-geography-candidate/app/dist/auth-config.json'));assert.equal(createHash('sha256').update(authBytes).digest('hex'),'dc46dfc65d9677d75b24325293323bc42a8b867d8fa156eead163bb7884577aa');
 Object.assign(receipt,{status:'prepared',scope:numericCompletion?'Five untouched country geometries through normal owner SDK; reuse passed India readback/UI':'Final owner readback: India revision2 read-only; five untouched country tags through the same SDK',limits,priorUsage,priorReceipts:priorReceipts.map(({record,...item})=>item),source:{path:sourcePath,sha256:hash,bytes:sourceBytes.length,geometryBytes,license:null,sourceVersion:null,S3Equivalence:null},closes:['India committed revision2 readback and actual current UI reopen','Five remaining null country geometries'],reuses:['Existing checker, normal owner authentication and exact local six-feature source','India accepted PUT; never replayed'],stop_condition:'Stop India mismatch before all writes; stop first denied/conflict/unknownwrite/cap; no further continuation',APIRequests:[],SRPRequests:0,countries:numericCompletion?[{id:india.id,title:india.title,featureId:india.featureId,revision:2,readbackAccepted:true,reused:true,method:'Retained actual owner readback and passed native UI',receipt:priorReceipts[3].path,semanticGeometryAcceptance:offline.semanticGeometryAcceptance}]:[],bridgeErrors:[],retainedLocationBodies:[],pendingOperation:null,accountId:prior.accountId,credentialValuesRetained:false,nativeOwnerUIExecuted:false,IndiaPreservation:'Prior checker deepEqual compared submitted document to its fresh complete preimage before accepted PUT. Full historical preimage and submitted body were not retained, so this run cannot establish their whole-document readback diff.',linksAcceptance:'Earlier India link GET200 is retained only as byte count. This run does not fetch or fabricate links; the UI bridge omits related-resource loading.'});
 const deadline=runStarted+limits.activeSecondsAdditional*1000,known=new Map(),saved=new Map(),writes=new Set();let session,adapter,liveStarted,bodyNumber=0,rejectBridge;
 const bridgeFailure=new Promise((_,reject)=>{rejectBridge=reject});
 const persist=()=>writeFile(destination,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 const within=()=>assert.ok(Date.now()<deadline,'Final country recovery reached the cumulative120s active ceiling');
 const safeError=error=>({name:error.name,message:String(error.message).slice(0,2000),...(Number.isInteger(error.status)?{status:error.status}:{}),...(typeof error.code==='string'?{code:error.code}:{})});
 const rowFor=id=>{const row=rows.find(item=>item.id===id);assert.ok(row,'Country outside frozen inventory');return row};
 const guardedRecord=(record,row)=>{assert.equal(record.id,row.id);assert.equal(record.role,'owner');assert.equal(record.document.canonical_uri,row.canonicalUri);assert.equal(record.document.title,row.title);assert.equal(record.revision,record.currentRevision);};
 const claim=row=>({subject:'resource',property:'http://www.w3.org/ns/prov#wasDerivedFrom',value:{'@id':'urn:sha256:'+hash,localFileName:'countries-50m.json',featureId:row.featureId,label:row.title+' · numeric ISO country feature '+row.featureId,sourceVersion:null,license:null,S3Equivalence:null},provenance:'curator_asserted',method:'Boundary source selected in Geographic tags',timestamp:new Date().toISOString(),evidence:['urn:sha256:'+hash]});
 const assertGeometrySource=(record,row)=>{const numericAcceptance=numericCompletion?assertLocationGeometryNumericRoundtrip(record.document.geometry,row.geometry):null;if(!numericCompletion)assert.deepEqual(record.document.geometry,row.geometry,'Exact source geometry changed');const entry=record.document.knowledge.metadata.curated.find(item=>item.method==='Boundary source selected in Geographic tags'&&item.value?.['@id']==='urn:sha256:'+hash&&item.value.featureId===row.featureId);assert.ok(entry,'Exact saved boundary provenance missing');assert.equal(entry.property,'http://www.w3.org/ns/prov#wasDerivedFrom');assert.equal(entry.provenance,'curator_asserted');assert.deepEqual(entry.value,claim(row).value);assert.deepEqual(entry.evidence,['urn:sha256:'+hash]);return numericAcceptance;};
 const recordAccepted=async(record,row,extra={})=>{if(!receipt.countries.some(item=>item.id===row.id))receipt.countries.push({id:row.id,title:row.title,featureId:row.featureId,revision:record.revision,geometryBytes:Buffer.byteLength(JSON.stringify(record.document.geometry)),readbackAccepted:true,...extra});receipt.pendingOperation=null;await persist();};
 const get=async id=>{within();const row=rowFor(id);try{const record=await adapter.getLocation(id);guardedRecord(record,row);if(id===india.id){assert.equal(record.revision,2,'India accepted revision2 changed');assertGeometrySource(record,row);await recordAccepted(record,row,{method:'read-only-committed-owner-SDK',historicalWholeDocumentDiffAvailable:false});}
  else if(saved.has(id)){const expected=saved.get(id);assert.equal(record.revision,expected.revision);if(numericCompletion)assert.deepEqual({...record.document,geometry:expected.document.geometry},expected.document,'Non-geometry fields differ from full submitted document');else assert.deepEqual(record.document,expected.document,'Whole saved document differs from fresh complete preimage plus geometry/provenance');const numericAcceptance=assertGeometrySource(record,row);await recordAccepted(record,row,{method:'normal-owner-SDK',wholeDocumentPreservationAccepted:true,...(numericAcceptance?{numericAcceptance}:{})});}
  else assert.equal(record.document.geometry,null,'Unexpected non-null boundary; do not overwrite');known.set(id,structuredClone(record));return record;
 }catch(error){receipt.validationFailure={operation:'getLocation',id,error:safeError(error),capturedAt:new Date().toISOString()};await persist();throw error;}};
 const save=async(document,expected)=>{within();const row=rowFor(expected.id);assert.notEqual(row.id,india.id,'India PUT must never be replayed');const before=known.get(row.id);guardedRecord(before,row);assert.equal(before.document.geometry,null);assert.equal(expected.revision,before.revision);assert.equal(writes.has(row.id),false,'Write replay forbidden');const exact=structuredClone(before.document);exact.geometry=structuredClone(row.geometry);exact.knowledge.metadata.curated.push(document.knowledge.metadata.curated.at(-1));assert.deepEqual(document,exact,'Unrelated fields changed');assertGeometrySource({document},row);assert.ok(Buffer.byteLength(JSON.stringify(document))<=350000);assert.ok(Buffer.byteLength(JSON.stringify(document.knowledge))<=49152);
  receipt.pendingOperation={method:'PUT',id:row.id,expectedRevision:before.revision};writes.add(row.id);await persist();const result=await adapter.saveLocation(document,expected);assert.equal(result.id,row.id);assert.equal(result.revision,before.revision+1);saved.set(row.id,{document:structuredClone(document),revision:result.revision});receipt.pendingOperation={method:'readback',id:row.id,acceptedRevision:result.revision};await persist();return result;};
 await mkdir(privateDir,{recursive:true,mode:0o700});await persist();
 return {deadline,sdkOnly:numericCompletion,bridgeMethods:['listLocations','getLocation'],bridgeFailure,async authenticate(){within();liveStarted=Date.now();receipt.status='started';receipt.startedAt=new Date(liveStarted).toISOString();await persist();const {loadSharingCredentials}=await import('../../.local-archives/studio-sharing/load-credentials.mjs'),{authenticateNormalStudioAccount}=await import('../../.local-archives/studio-sharing/normal-srp.mjs'),{OpenGeoApiClient}=await import('../src/lib/apiClient.js');
  const credentials=await loadSharingCredentials(undefined,{requireFilled:true});try{session=await authenticateNormalStudioAccount({credentials:credentials.owner,config:JSON.parse(authBytes),within,onAuthRequest:async()=>{assert.ok(priorUsage.SRPRequests+receipt.SRPRequests<limits.SRPRequestsCumulative);receipt.SRPRequests++;await persist();}});}finally{for(const item of [credentials.owner,credentials.reader]){item.username='';item.password='';}receipt.credentialsCleared=true;}
  adapter=new OpenGeoApiClient({baseUrl:'https://studio.opengeo.tools/api',tokenProvider:()=>session.accessToken,organizationProvider:()=>prior.accountId,fetchImplementation:async(url,options={})=>{within();assert.ok(priorUsage.APIRequests+receipt.APIRequests.length<limits.APIRequestsCumulative,'Cumulative26 country API ceiling');const target=new URL(url),path=target.pathname.slice(4),method=options.method??'GET',headers=new Headers(options.headers);assert.equal(target.origin,'https://studio.opengeo.tools');assert.equal(headers.get('authorization'),'Bearer '+session.accessToken);assert.ok(path==='/auth/session'||rows.some(row=>path==='/locations/'+row.id));if(path!=='/auth/session')assert.equal(headers.get('x-opengeo-organization'),prior.accountId);assert.ok(method==='GET'||(method==='PUT'&&rows.some(row=>row.id!==india.id&&path==='/locations/'+row.id)));
   const call={method,path:target.pathname,status:'attempted',startedAt:new Date().toISOString()};receipt.APIRequests.push(call);if(method==='PUT'){const file=resolve(privateDir,String(++bodyNumber).padStart(2,'0')+'-'+rowFor(path.split('/').at(-1)).title+'-submitted.json');await writeFile(file,options.body,{mode:0o600,flag:'wx'});call.submittedBodyPath=file;}await persist();const timeout=AbortSignal.timeout(Math.max(1,Math.min(25000,deadline-Date.now()))),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;const response=await fetch(url,{...options,redirect:'error',signal}),bytes=await response.arrayBuffer();assert.ok(bytes.byteLength<=limits.responseBytes);call.status=response.status;call.bytes=bytes.byteLength;if(method==='GET'&&path.startsWith('/locations/')){const row=rowFor(path.split('/').at(-1)),file=resolve(privateDir,String(++bodyNumber).padStart(2,'0')+'-'+row.title+'-response.json');await writeFile(file,Buffer.from(bytes),{mode:0o600,flag:'wx'});call.retainedBodyPath=file;receipt.retainedLocationBodies.push({id:row.id,path:file,sha256:createHash('sha256').update(Buffer.from(bytes)).digest('hex'),status:response.status,bytes:bytes.byteLength});}await persist();return new Response(bytes,{status:response.status,headers:response.headers});}});
  const actor=await adapter.getSession();assert.equal(actor.userId,prior.actorUserId);assert.ok(actor.memberships.some(item=>item.organizationId===prior.accountId&&['admin','member'].includes(item.role)));receipt.actorUserId=actor.userId;receipt.accountVerified=true;receipt.organizationVerification='Fresh session membership and explicit unchanged account header; prior continuation verified current organization';await persist();if(numericCompletion){assert.ok(limits.APIRequestsCumulative-priorUsage.APIRequests-receipt.APIRequests.length>=15,'Authentication left fewer than15 calls for five full read/save/readbacks; stop before writes');receipt.reusedIndiaReceipt=priorReceipts[3].path;receipt.assertions.push('Reuse passed actual India readback and native desktop/mobile UI; zero India/list/link requests or writes');receipt.localPreparationAgentTime='Unmeasured preparation and offline diagnosis; not zero-cost. Measured offline UI6.550s carried in cumulative120s budget.';}else {await get(india.id);receipt.assertions.push('India committed revision2 exact geometry/provenance read back through normal owner SDK without any PUT');}await persist();
 },async invoke(method,args){try{assert.ok(receipt.accountVerified);const record=known.get(india.id);assert.ok(record);if(method==='listLocations')return [{id:record.id,title:record.document.title,revision:record.revision}];if(method==='getLocation'){assert.equal(args[0],india.id);return structuredClone(record);}throw Error('Unsupported cached owner UI bridge method');}catch(error){receipt.bridgeErrors.push({method,id:args[0]??null,error:safeError(error),capturedAt:new Date().toISOString()});await persist();rejectBridge(error);throw error;}},async journey(page,origin){if(!numericCompletion){page.setDefaultTimeout(5000);await page.goto(origin+'/workspaces?view=locations&location='+india.id);await page.getByRole('img',{name:'India: saved MultiPolygon search area',exact:true}).waitFor();assert.match(await page.locator('.location-boundary-source').textContent(),/India.*numeric ISO country feature 356/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);receipt.nativeOwnerUIExecuted=true;await page.evaluate(()=>window.mountLocationDirectory());await page.getByRole('img',{name:'India: saved MultiPolygon search area',exact:true}).waitFor();const shot=resolve(base,'pattern-geography-candidate/geography-ui/india-owner-reopened.png');await page.screenshot({path:shot,fullPage:true});receipt.screenshots.push(shot);receipt.assertions.push('Actual current India UI reopened authoritative cached owner revision2 geometry/source; no live list/link calls and no fabricated links');await persist();}
  for(const row of rows.filter(item=>item.id!==india.id)){within();assert.ok(limits.APIRequestsCumulative-priorUsage.APIRequests-receipt.APIRequests.length>=3,'Remaining budget cannot cover one complete read/save/readback');const before=await get(row.id),document=structuredClone(before.document);document.geometry=structuredClone(row.geometry);document.knowledge.metadata.curated.push(claim(row));await save(document,{id:row.id,revision:before.revision});await get(row.id);}
  assert.equal(receipt.countries.length,6);assert.equal(receipt.externalRequests,0);assert.deepEqual(receipt.pageErrors,[]);receipt.assertions.push(numericCompletion?'Five fresh owner readbacks preserve every non-geometry document field exactly, exact geometry structure/provenance and bounded numeric coordinate roundtrip':'Five previously untouched tags preserve exact complete documents plus selected geometry/provenance after fresh owner readback');receipt.liveElapsedMilliseconds=Date.now()-liveStarted;await persist();
 },clear(){if(session)session.accessToken='';receipt.sessionCleared=true;receipt.KMS='No direct AWS/S3/Secrets/KMS requests; service-mediated usage and dollars unknown; all prior costs carried.';},async finalize(){for(const item of priorReceipts){assert.equal(createHash('sha256').update(await readFile(item.path)).digest('hex'),item.sha256,'Prior failed receipt changed');}receipt.priorReceiptsPreservedByteExact=true;receipt.cumulativeUsage={APIRequests:priorUsage.APIRequests+receipt.APIRequests.length,SRPRequests:priorUsage.SRPRequests+receipt.SRPRequests,seconds:priorUsage.seconds+receipt.elapsedSeconds};receipt.result={newGeometryAssociationsSaved:saved.size,previouslyCommittedIndiaWritesReplayed:0,writeAttempts:writes.size,readbackAccepted:receipt.countries.length,nativeOwnerUIExecuted:receipt.nativeOwnerUIExecuted,nativeOwnerUIEvidenceReused:numericCompletion,remaining:rows.filter(row=>!receipt.countries.some(item=>item.id===row.id)).map(({id,title})=>({id,title})),pendingOperation:receipt.pendingOperation};receipt.finishedAt=new Date().toISOString();await persist();}};
}

async function prepareOfflineCountryReadback(receipt,runStarted){
 const base=resolve('.local-archives/studio-sharing/noaa-owner-workflow'),destination=resolve(base,'country-tag-geometries-offline-readback-ui.json');assert.equal(existsSync(destination),false,'An offline country readback UI receipt exists; do not replay');
 const recovery=JSON.parse(await readFile(resolve(base,'country-tag-geometries-readback-recovery.json'),'utf8')),retained=recovery.retainedLocationBodies.find(item=>item.id==='496a9d2f-8ae1-42c6-9dc2-9dcfc94aa7fe'),body=await readFile(retained.path);assert.equal(createHash('sha256').update(body).digest('hex'),retained.sha256);
 const raw=JSON.parse(body),sourceBytes=await readFile(recovery.source.path);assert.equal(createHash('sha256').update(sourceBytes).digest('hex'),recovery.source.sha256);const source=JSON.parse(sourceBytes),feature=topologyFeature(source,source.objects.countries).features.find(item=>Number(item.id)===356),record={...raw,currentRevision:raw.current_revision,accessRevision:raw.access_revision,document:structuredClone(raw.document)};
 assert.equal(record.id,retained.id);assert.equal(record.revision,2);assert.equal(record.currentRevision,2);assert.equal(record.role,'owner');assert.equal(record.document.canonical_uri,'https://www.wikidata.org/entity/Q668');assert.equal(record.document.title,'India');
 const changes=[];let coordinateScalars=0;
 const compare=(actual,expected,path='$')=>{if(typeof actual==='number'&&typeof expected==='number'){assert.ok(Number.isFinite(actual)&&Number.isFinite(expected),'Nonfinite coordinate');coordinateScalars++;const absolute=Math.abs(actual-expected),ceiling=2*Number.EPSILON*Math.max(1,Math.abs(actual),Math.abs(expected));assert.ok(absolute<=ceiling,'Coordinate differs beyond numeric roundtrip at '+path);if(!Object.is(actual,expected))changes.push({path,absoluteDegrees:absolute,ceilingDegrees:ceiling});return;}if(Array.isArray(actual)||Array.isArray(expected)){assert.ok(Array.isArray(actual)&&Array.isArray(expected));assert.equal(actual.length,expected.length,'Coordinate/ring/component count changed');actual.forEach((value,index)=>compare(value,expected[index],path+'['+index+']'));return;}if(actual&&expected&&typeof actual==='object'&&typeof expected==='object'){assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort());for(const key of Object.keys(actual))compare(actual[key],expected[key],path+'.'+key);return;}assert.deepEqual(actual,expected,'Non-numeric geometry value changed');};compare(record.document.geometry,feature.geometry);
 const claim=record.document.knowledge.metadata.curated.find(item=>item.method==='Boundary source selected in Geographic tags'&&item.value?.['@id']==='urn:sha256:'+recovery.source.sha256);assert.ok(claim);assert.equal(claim.property,'http://www.w3.org/ns/prov#wasDerivedFrom');assert.equal(claim.provenance,'curator_asserted');assert.deepEqual(claim.value,{'@id':'urn:sha256:'+recovery.source.sha256,localFileName:'countries-50m.json',featureId:feature.id,label:'India · numeric ISO country feature '+feature.id,sourceVersion:null,license:null,S3Equivalence:null});assert.deepEqual(claim.evidence,['urn:sha256:'+recovery.source.sha256]);
 const maxAbsoluteDegrees=Math.max(0,...changes.map(item=>item.absoluteDegrees));Object.assign(receipt,{status:'prepared',scope:'Offline actual retained India owner revision2 readback and current native UI; no fresh authentication or persistence claim',limits:{runSeconds:30,APIRequests:0,SRPRequests:0,providerRequests:0,S3Requests:0,canonicalBuilds:0},retainedBody:{path:retained.path,sha256:retained.sha256,bytes:body.length},source:recovery.source,priorCumulativeLiveUsage:recovery.cumulativeUsage,semanticGeometryAcceptance:{coordinateScalars,numericDifferences:changes.length,maxAbsoluteDegrees,tolerance:'2 * Number.EPSILON * max(1, abs(actual), abs(expected)) per finite coordinate; exact structure and all non-numeric values',conservativeRoundoffDisplacementMetres:Math.SQRT2*111320*maxAbsoluteDegrees,distanceEstimateLimit:'Planar upper estimate using 111,320 metres/degree for both axes; floating-point roundoff only, not source boundary accuracy',byteExactGeometry:false,provenanceAccepted:true},historicalFullPreimageAvailable:false,relatedLinks:'Not fetched or fabricated; live earlier receipt contains only response byte count'});
 const persist=()=>writeFile(destination,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});await persist();const deadline=runStarted+30000;
 return {deadline,bridgeMethods:['listLocations','getLocation'],bridgeFailure:new Promise(()=>{}),async authenticate(){receipt.assertions.push('Actual retained owner revision2 body passes semantic coordinate roundtrip, exact geometry structure, canonical identity and exact hash/feature provenance; no authentication or API calls');},async invoke(method,args){if(method==='listLocations')return [{id:record.id,title:record.document.title,revision:record.revision}];assert.equal(method,'getLocation');assert.equal(args[0],record.id);return structuredClone(record);},async journey(page,origin){for(const width of [1280,390]){await page.setViewportSize({width,height:900});await page.goto(origin+'/workspaces?view=locations&location='+record.id);await page.getByRole('img',{name:'India: saved MultiPolygon search area',exact:true}).waitFor();assert.match(await page.locator('.location-boundary-source').textContent(),/India.*numeric ISO country feature 356/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.evaluate(()=>window.mountLocationDirectory());await page.getByRole('img',{name:'India: saved MultiPolygon search area',exact:true}).waitFor();const shot=resolve(base,'pattern-geography-candidate/geography-ui/india-owner-retained-'+width+'.png');await page.screenshot({path:shot,fullPage:true});receipt.screenshots.push(shot);receipt.assertions.push(width+'px native UI reopened actual retained India revision2 boundary and provenance without external calls or fabricated links');}assert.equal(receipt.externalRequests,0);assert.deepEqual(receipt.pageErrors,[]);receipt.nativeOwnerUIExecuted=true;},clear(){},async finalize(){assert.equal(createHash('sha256').update(await readFile(retained.path)).digest('hex'),retained.sha256);receipt.retainedBodyPreservedByteExact=true;receipt.result={IndiaSemanticReadbackAccepted:true,nativeOwnerUIExecuted:receipt.nativeOwnerUIExecuted??false,newAPIRequests:0,newSRPRequests:0,remaining:'Five country associations still need normal owner read/save/readback; no live continuation issued'};await persist();}};
}

function assertLocationGeometryNumericRoundtrip(actual,expected){
 let coordinateScalars=0,numericDifferences=0,maxAbsoluteDegrees=0;
 const compare=(a,b,path='$')=>{if(typeof a==='number'&&typeof b==='number'){assert.ok(Number.isFinite(a)&&Number.isFinite(b),'Nonfinite coordinate');coordinateScalars++;const absolute=Math.abs(a-b),ceiling=2*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));assert.ok(absolute<=ceiling,'Coordinate differs beyond bounded JSON roundtrip at '+path);if(!Object.is(a,b)){numericDifferences++;maxAbsoluteDegrees=Math.max(maxAbsoluteDegrees,absolute);}return;}if(Array.isArray(a)||Array.isArray(b)){assert.ok(Array.isArray(a)&&Array.isArray(b));assert.equal(a.length,b.length,'Geometry component/ring/position count changed');a.forEach((value,index)=>compare(value,b[index],path+'['+index+']'));return;}if(a&&b&&typeof a==='object'&&typeof b==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const key of Object.keys(a))compare(a[key],b[key],path+'.'+key);return;}assert.deepEqual(a,b,'Non-numeric geometry value changed');};compare(actual,expected);
 return {coordinateScalars,numericDifferences,maxAbsoluteDegrees,tolerance:'2 * Number.EPSILON * max(1, abs(actual), abs(expected)) per finite coordinate; exact structure and all non-numeric values',byteExactGeometry:false};
}
