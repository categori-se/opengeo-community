import {inspectWfsSchemaReview} from "./inspect-wfs-schema-review.mjs";
import assert from 'node:assert/strict';
import {inspectWfsExistingProject} from './inspect-wfs-existing-project.mjs';
import {inspectWfsCatalogMap} from './inspect-wfs-catalog-map.mjs';
import {inspectDiscoveryKnowledge} from './inspect-discovery-knowledge.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {loadIntegratedStudioBuild,integratedStudioAuthConfig} from './integrated-studio-built-shell.mjs';
let input='';for await(const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input),wfs=config.sourceType==='wfs',errors=[],requests=[],builtRequests=[],blockedFonts=[];
const shell=await loadIntegratedStudioBuild(resolve(config.studioBuild));
let origin;
const server=createServer((request,response)=>{
 const path=new URL(request.url,origin).pathname;
 if(path==='/auth-config.json')return response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(integratedStudioAuthConfig(origin)));
 if(path==='/service-worker.js')return response.writeHead(404).end();
 const file=request.method==='GET'&&shell.files.get(path);
 if(!file)return response.writeHead(404).end();
 builtRequests.push({path,sha256:file.sha256});
 response.writeHead(200,{'content-type':file.contentType}).end(file.body);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:config.wfsPreview?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:['--no-sandbox']});
try{
 const context=await browser.newContext();
 await context.addInitScript(({organizationId})=>{
  sessionStorage.setItem('opengeo.accessToken','synthetic.local.owner');
  sessionStorage.setItem('opengeo.accessTokenExpiresAt',String(Date.now()+3600000));
  sessionStorage.setItem('opengeo.organizationId',organizationId);
 },config);
 const wfsFeatureRequests=[];
 let saveActor=null;
 let denyNextAcceptance=false;
 let currentVersion=null,downloadSha256=null,storageReads=0,registeredSource=null,initialCopy=null;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname)){blockedFonts.push(url.href);return route.abort();}
  if(config.phase==='files'&&url.origin==='https://s3.us-east-1.amazonaws.com'){
   assert.equal(request.method(),'GET');assert.equal(request.headers().authorization,undefined);
   assert.ok(url.pathname.startsWith('/local.invalid/organizations/'));storageReads++;
   const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}/_fixture/download?url=${encodeURIComponent(url.href)}`,headers:{}});
   return route.fulfill({response});
  }
  if(config.wfsPreview && url.origin==='https://maps.example.com'){
   assert.equal(url.pathname,'/geoserver/wfs');assert.equal(url.searchParams.get('REQUEST'),'GetFeature');
   assert.equal(url.searchParams.get('SORTBY'),'facility_id A');assert.equal(url.searchParams.get('TYPENAMES'),'public:facilities');
   assert.equal(request.headers().authorization,undefined);
   wfsFeatureRequests.push(url.href);assert.ok(wfsFeatureRequests.length<=(config.reuseTarget?12:8));
   return route.fulfill({json:{type:'FeatureCollection',numberMatched:1,numberReturned:1,features:[
    {type:'Feature',properties:{facility_id:1,name:'WFS clinic'},geometry:{type:'Point',coordinates:[-71.2,42.3]}}]}});
  }
  if(config.phase==='register' && url.origin!==origin){
   if(url.href.includes('/styles/'))return route.fulfill({json:{version:8,sources:{},layers:[]}});
   return route.abort();
  }
  assert.equal(url.origin,origin,'Unexpected external request');
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const readerAcceptance=denyNextAcceptance && request.method()==='POST' && url.pathname.endsWith('/accept');
  if(readerAcceptance) denyNextAcceptance=false;
  const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}${url.pathname.slice(4)}${url.search}`,
   ...((readerAcceptance||saveActor&&request.method()==='PUT'&&url.pathname.includes(`/projects/${config.reuseTarget.accessContainerId}/datasets/`))?{headers:{...await request.allHeaders(),authorization:'Bearer '+(readerAcceptance?'editor':saveActor)}}:{})});
  if(readerAcceptance)assert.equal(response.status(),403,'Actual database viewer cannot accept');
  requests.push({method:request.method(),path:url.pathname,status:response.status()});
  if(request.method()==='GET'&&url.pathname===`/api/datasets/${config.datasetId}`&&response.status()===200) currentVersion=(await response.json()).current_version_id;
  if(config.phase==='register' && request.method()==='POST' && url.pathname===`/api/projects/${config.projectId}/sources` && response.status()===201)registeredSource=await response.json();
  if(config.initialCopy && request.method()==='POST' && url.pathname.endsWith('/protected-copies') && response.status()===202)initialCopy=await response.json();
  await route.fulfill({response});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 if(config.phase==='wfs-revise'){
  await page.goto(`${origin}/layers?id=${config.datasetId}`);
  await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await page.getByText('Edit metadata record',{exact:true}).click();
  const schemaReview=await inspectWfsSchemaReview(page,origin,config.datasetId,requests,true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',schemaReview,requests,build:shell.evidence,errors}));
 }else if(config.phase==='register'){
  await page.goto(`${origin}/workspaces?project=${config.projectId}`);
  await page.getByRole('button',{name:'Create first map',exact:true}).click();
  await page.getByRole('button',{name:'Add data',exact:true}).first().click();
  await page.getByLabel('Source type',{exact:true}).selectOption(wfs?'wfs':'arcgis');
  if(config.discover){
   await page.getByLabel(wfs?'WFS 2.0 service URL':'ArcGIS service URL',{exact:true}).fill(wfs?'https://maps.example.com/geoserver/wfs':'https://services.example.com/ArcGIS/rest/services/facilities/FeatureServer');
   await page.getByRole('button',{name:'Find available layers',exact:true}).click();
   await page.getByRole('button',{name:'Inspect layer',exact:true}).click();
   const review=page.getByRole('heading',{name:wfs?'Review public:facilities':'Review Facilities',exact:true}).locator('..');
   await review.waitFor();
   assert.equal(await review.getByLabel('Layer title',{exact:true}).inputValue(),wfs?'public:facilities':'Facilities');
   assert.equal(await review.getByLabel('Fields · comma separated',{exact:true}).inputValue(),wfs?'facility_id,name':'OBJECTID,name');
   assert.equal(await review.getByLabel('Rights or terms reviewed',{exact:true}).inputValue(),'');
   await review.getByRole('button',{name:wfs?'Register WFS layer':'Register ArcGIS layer',exact:true}).click();
   assert.equal(registeredSource,null,'Missing terms never register a source');
   await review.getByLabel('Layer title',{exact:true}).fill('Offline upstream');
   await review.getByLabel('Required attribution',{exact:true}).fill('Fixture provider');
   await review.getByLabel('Rights or terms reviewed',{exact:true}).fill('Local fixture only');
   if(wfs){
    const sort=review.getByLabel('Confirmed stable sort field',{exact:true});
    assert.equal(await sort.inputValue(),'facility_id');
    await sort.fill('facility_id');
   }
   await review.getByRole('checkbox').check();
   await Promise.all([page.waitForResponse(r=>r.url().endsWith(`/projects/${config.projectId}/sources`)&&r.request().method()==='POST'),review.getByRole('button',{name:wfs?'Register WFS layer':'Register ArcGIS layer',exact:true}).click()]);
  }else{
  await page.getByText('Enter an already reviewed layer manually',{exact:true}).click();
  const form=page.locator('.gis-source-manual-registration');
  await form.getByLabel('Layer title',{exact:true}).fill('Offline upstream');
  await form.getByLabel('ArcGIS layer URL',{exact:true}).fill('https://services.example.com/ArcGIS/rest/services/facilities/FeatureServer/0');
  await form.getByLabel('Object ID field',{exact:true}).fill('OBJECTID');
  await form.getByLabel('Fields · comma separated',{exact:true}).fill('OBJECTID,name');
  await form.getByLabel('Geometry',{exact:true}).selectOption('Point');
  await form.getByLabel('Page size · 1–2000',{exact:true}).fill('2');
  await form.getByLabel('Attribution',{exact:true}).fill('Fixture provider');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith(`/projects/${config.projectId}/sources`)&&r.request().method()==='POST'),form.getByRole('button',{name:'Register ArcGIS feature source',exact:true}).click()]);
  }
  assert.ok(registeredSource,'Source registration reached the real API');
  if(wfs){
   assert.equal(registeredSource.configuration.type_name,'public:facilities');
   assert.equal(registeredSource.configuration.geometry_name,'geom');
   assert.equal(registeredSource.configuration.sort_by,'facility_id');
   assert.deepEqual(registeredSource.configuration.fields,['facility_id','name']);
   assert.equal(registeredSource.source_url,'https://maps.example.com/geoserver/wfs');
  }else{
   assert.equal(registeredSource.configuration.object_id_field,'OBJECTID');
   assert.equal(registeredSource.source_url,'https://services.example.com/ArcGIS/rest/services/facilities/FeatureServer/0');
  }
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/sources')).length,1);
  assert.equal(requests.filter(r=>r.path.endsWith('/protected-copies')).length,0,'Registering a reference does not capture a copy');
  if(config.initialCopy){
   const dialog=page.getByRole('dialog',{name:'Keep a protected copy?',exact:true});
   await dialog.getByLabel('WGS84 bounds · west, south, east, north',{exact:true}).fill('-72,42,-70,43');
   await dialog.getByLabel('Maximum features · up to 50000',{exact:true}).fill('3');
   await dialog.getByLabel(wfs?'Page size · up to 1000':'Page size · up to 2000',{exact:true}).fill('2');
   await dialog.getByRole('button',{name:'Review protected copy',exact:true}).click();
   await dialog.getByRole('heading',{name:'Review archive limits and rights',exact:true}).waitFor();
   assert.equal(requests.filter(r=>r.path.endsWith('/protected-copies')).length,0);
   await dialog.getByRole('button',{name:'Create protected copy',exact:true}).click();
   await dialog.getByText('Complete the dataset name, rights basis, attribution, and both confirmations.',{exact:true}).waitFor();
   assert.equal(requests.filter(r=>r.path.endsWith('/protected-copies')).length,0);
   await dialog.getByLabel('Protected dataset name',{exact:true}).fill('Reusable capture');
   await dialog.getByLabel('Rights basis',{exact:true}).fill('Local fixture only');
   await dialog.getByLabel('I confirm that this project may retain these source bytes.',{exact:true}).check();
   await dialog.getByLabel('I accept the bounded request, byte, and cost limits shown above.',{exact:true}).check();
   await dialog.getByRole('button',{name:'Create protected copy',exact:true}).click();
   await dialog.getByRole('heading',{name:'Protected copy queued',exact:true}).waitFor();
   assert.ok(initialCopy);assert.equal(initialCopy.state,'queued');
   assert.deepEqual(initialCopy.capture_scope,{kind:'bounded_features',bounds:[-72,42,-70,43],maximum_features:3,page_size:2});
   assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/protected-copies')).length,1);
   assert.deepEqual(errors,[]);
  }
  const knowledge=config.knowledge ? await inspectDiscoveryKnowledge(page,origin,registeredSource.dataset_id) : null;
  const schemaReview=config.wfsSchemaReview?await inspectWfsSchemaReview(page,origin,registeredSource.dataset_id,requests,config.wfsRevision):null;
  const catalogMap=config.wfsPreview?await inspectWfsCatalogMap(page,origin,registeredSource.dataset_id,requests):null;
  const existingProject=config.reuseTarget?await inspectWfsExistingProject(page,origin,registeredSource.dataset_id,requests,config.reuseTarget,actor=>saveActor=actor):null;
  console.log(JSON.stringify({status:'passed',schemaReview,existingProject,catalogMap,wfsFeatureRequests,phase:config.phase,sourceType:wfs?'wfs':'arcgis',source:registeredSource,knowledge,initialCopy,fullBuiltProjectRoute:true,requests,build:shell.evidence,errors,scope:'Reviewed source registration and optional retained metadata; provider transport is local, browser provider requests blocked'}));
 }else{
 await page.goto(`${origin}/layers?id=${config.datasetId}`);
 const inspectSource=page.getByRole('button',{name:'Inspect connected refresh source',exact:true});
 try{await inspectSource.waitFor();}catch(error){console.error(JSON.stringify({pageText:await page.locator('body').innerText(),errors,requests}));throw error;}
 assert.equal(requests.filter(r=>r.method!=='GET').length,0,'Opening Layer must not write');
 assert.ok(await page.getByRole('link',{name:'Catalog',exact:true}).count(),'Studio navigation present');
 if(config.phase==='start'){
  await inspectSource.click();await page.getByText('The prior capture area',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Review refresh estimate',exact:true}).click();
  await page.getByText('Review the capture scope, rights and limits.',{exact:false}).waitFor();
  for(const checkbox of await page.getByRole('checkbox').all())await checkbox.check();
  await page.getByRole('button',{name:'Start source refresh',exact:true}).click();
  await page.getByText('Source refresh queued',{exact:false}).waitFor();
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/protected-copies')).length,1);
 }else if(config.phase==='capture-failures'){
  const inspectFailures=async()=>{
   await inspectSource.click();
   await page.getByRole('button',{name:'Inspect earlier source refreshes',exact:true}).click();
   await page.getByText('The source reported a different feature count than it returned.',{exact:false}).waitFor();
   await page.getByText(/Source revision 1 · failed · .* · response_invalid/).waitFor();
   assert.equal(await page.getByRole('button',{name:/Check captured version/}).count(),0);
   assert.equal(currentVersion,config.baseVersionId);
  };
  await inspectFailures();
  await page.reload();await inspectSource.waitFor();await inspectFailures();
  assert.equal(requests.filter(r=>r.method!=='GET').length,0,'Retained capture failures are read-only, including after reload');
 }else if(config.phase==='failed'){
  assert.equal(currentVersion,config.baseVersionId);
  const inspectFailure=async()=>{
   await inspectSource.click();
   await page.getByRole('button',{name:'Inspect earlier source refreshes',exact:true}).click();
   await page.getByRole('button',{name:`Check captured version ${config.candidateVersionId}`,exact:true}).click();
   await page.getByText('Capture complete, but processing failed.',{exact:false}).waitFor();
   await page.getByRole('button',{name:'Check processing and candidates',exact:true}).click();
   const candidate=page.getByLabel('Staged data version',{exact:true}).locator(`option[value="${config.candidateVersionId}"]`);
   await candidate.waitFor({state:'attached'});
   assert.equal(await candidate.isDisabled(),true);
   assert.match(await candidate.textContent(),/failed/);
   assert.equal(await page.getByRole('button',{name:'Make this version current',exact:true}).count(),0);
  };
  await inspectFailure();
  await page.reload();await inspectSource.waitFor();
  assert.equal(currentVersion,config.baseVersionId);await inspectFailure();
  assert.equal(requests.filter(r=>r.method!=='GET').length,0,'Failure inspection never writes or starts another job');
 }else if(config.phase==='files'){
  const inspectVersions=()=>page.getByRole('button',{name:'Inspect versions, schema and provenance',exact:true});
  await inspectVersions().click();
  const files=page.getByRole('region',{name:'Files for version 1',exact:true});
  await files.waitFor();await files.getByText('Standard GeoParquet reader compatibility is not established',{exact:false}).waitFor();
  await files.getByText('GeoJSON previews and map tiles do not preserve M values.',{exact:false}).waitFor();
  assert.equal(storageReads,0);assert.equal(requests.filter(r=>r.method!=='GET').length,0);
  await page.reload();await inspectSource.waitFor();await inspectVersions().click();await files.waitFor();
  assert.equal(storageReads,0);
  await files.getByRole('button',{name:`Prepare download: ${config.workingFilename}`,exact:true}).click();
  const link=files.getByRole('link',{name:`Download ${config.workingFilename}`,exact:true});await link.waitFor();
  assert.equal(storageReads,0,'Preparing does not read object bytes');
  const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await download.failure(),null);
  downloadSha256=createHash('sha256').update(readFileSync(await download.path())).digest('hex');
  assert.equal(downloadSha256,config.workingChecksum);assert.equal(storageReads,1);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/download')).length,1);
 }else{
  assert.equal(config.phase,'accept');assert.equal(currentVersion,config.baseVersionId);
  const check=()=>page.getByRole('button',{name:'Check processing and candidates',exact:true});
  const review=async()=>{
   await check().click();await page.getByText('Candidate status updated.',{exact:false}).waitFor();
   await page.getByLabel('Staged data version',{exact:true}).selectOption(config.candidateVersionId);
   await page.getByRole('button',{name:'Review selected candidate',exact:true}).click();
   await page.getByText('Review ready.',{exact:false}).waitFor();
   if(config.expectSchemaChange){
    await page.getByText('The recorded attribute schema changed.',{exact:true}).waitFor();
    await page.getByText('The upstream source configuration changed from the earlier capture.',{exact:true}).waitFor();
    await page.getByText('Connected source revision 2.',{exact:false}).waitFor();
    await page.getByLabel('Earlier data version',{exact:true}).selectOption(config.baseVersionId);
    await page.getByLabel('Comparison data version',{exact:true}).selectOption(config.candidateVersionId);
    const comparison=page.getByRole('region',{name:'Compare data versions',exact:true});
    await comparison.getByText('recorded schema differences.',{exact:false}).waitFor();
    for(const disclosure of await comparison.locator('details > summary').all())await disclosure.click();
    assert.match(await comparison.innerText(),/"before": "name"/);
    assert.match(await comparison.innerText(),/"after": "status"/);

   }
   await page.getByText('Provider-reported query matches:',{exact:false}).waitFor();
   if(config.expectWorkingCounts){
    for(const title of ['Current version','Candidate version']){
     const heading=page.getByRole('heading',{name:`${title}: working-file counts`,exact:true});
     await heading.waitFor();
     const section=heading.locator('..');
     const count=title==='Candidate version'?(config.candidateCount??1):(config.currentCount??1);
     assert.match(await section.innerText(),new RegExp(`input ${count}; working file ${count}`));
     assert.match(await section.innerText(),/Recorded count check matched/);
     assert.match(await section.innerText(),/do not establish feature identity/);
    }
    await page.getByText(`Inspected input features: ${config.candidateCount??1}.`,{exact:false}).waitFor();
   }
  };
  await review();assert.equal(await page.getByRole('button',{name:'Make this version current',exact:true}).isDisabled(),true);
  await page.reload();await inspectSource.waitFor();assert.equal(currentVersion,config.baseVersionId);
  if(config.denyReaderAcceptance){
   await review();await page.getByLabel('I reviewed the changes and the information that remains unknown.',{exact:false}).check();
   // Synthetic identity substitution models a reader request after a review was opened.
   denyNextAcceptance=true;
   await page.getByRole('button',{name:'Make this version current',exact:true}).click();
   await page.getByText('You no longer have access to update this Layer.',{exact:true}).waitFor();
   await page.reload();await inspectSource.waitFor();assert.equal(currentVersion,config.baseVersionId);
  }
  await review();await page.getByLabel('I reviewed the changes and the information that remains unknown.',{exact:false}).check();
  await page.getByRole('button',{name:'Make this version current',exact:true}).click();
  await page.getByText('Layer data updated.',{exact:true}).waitFor();
  await page.reload();await inspectSource.waitFor();assert.equal(currentVersion,config.candidateVersionId);
  await check().click();await page.getByText('Candidate status updated.',{exact:false}).waitFor();
  assert.equal(await page.getByLabel('Staged data version').locator('option').count(),1);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/accept')&&r.status===200).length,1);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/accept')&&r.status===403).length,config.denyReaderAcceptance?1:0);
  assert.equal(requests.filter(r=>r.path.endsWith('/protected-copies')||r.path.endsWith('/build-jobs')).length,0,'Review and acceptance do not capture or build');
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',phase:config.phase,fullBuiltLayerRoute:true,actualApiAndDatabase:true,syntheticIdentity:true,initialWrites:0,acceptedAndReopened:config.phase==='accept',readerAcceptanceDenied:config.phase==='accept'&&!!config.denyReaderAcceptance,downloadSha256,storageReads,requests,builtRequests,blockedFonts,build:shell.evidence,errors}));
 }
}finally{await browser.close();await new Promise(done=>server.close(done));}
