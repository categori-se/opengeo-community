// Reuse built modules; synthetic token verification, real local API/database, no providers.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';
let input='';for await(const part of process.stdin)input+=part;
const config=JSON.parse(input),dist=resolve(process.env.OPEN_GEO_BROWSER_DIST ?? 'dist'),calls=[],blocked=[],errors=[];
if(!existsSync(dist)||!statSync(dist).isDirectory())throw Error('OPEN_GEO_BROWSER_DIST must name an existing built distribution');
const discoveryOnly=process.env.OPEN_GEO_CATALOG_DISCOVERY_ONLY==='1';
const metadataOnly=process.env.OPEN_GEO_METADATA_ADMIN_ONLY==='1';
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const component=await modulePath('components','PlatformDirectory'),client=await modulePath('lib','apiClient'),inspection=await modulePath('components','LayerResourcePage'),resources=await modulePath('components','ProjectResources');
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:req.headers},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode,hasAuthorization:Boolean(req.headers.authorization),hasAccount:Boolean(req.headers['x-opengeo-organization'])});res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(req.url.startsWith('/?')||req.url.startsWith('/workspaces?')||req.url.startsWith('/layers?')||req.url.startsWith('/resource-discovery?')||req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><main></main><script type="module">
  import {LayerResourcePage} from '${inspection}';import {PlatformDirectory} from '${component}';import {ProjectResources} from '${resources}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  if(location.pathname==='/resource-discovery') {
   const projectId=new URL(location.href).searchParams.get('project');
   const project=await window.adapter.getProject(projectId),records=await window.adapter.listResources(projectId);
   const metadataProfiles=${metadataOnly}?await window.adapter.listMetadataProfiles():[];
   window.directory=ProjectResources({state:{adapter:window.adapter,project,organization:{id:organization,callerRole:'admin'},session:{},resources:records,maps:[],datasets:[],metadataProfiles}});
  } else window.directory=location.pathname==='/layers'?LayerResourcePage({adapter:window.adapter,target:{datasetId:new URL(location.href).searchParams.get('id')}}):PlatformDirectory({adapter:window.adapter,view:'data'});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const click=label=>page.getByRole('button',{name:label,exact:true}).click();
 await page.goto(origin);
 if(metadataOnly) {
  const result=await exerciseMetadataAdministration(page);
  assert.ok(calls.length<=60,'Selected native metadata administration request ceiling');
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({metadataAdministration:result,localApiRequests:calls.length,localWrites:calls.filter(call=>call.method!=='GET').length,externalRequests:blocked.length,cleanup:'browser and local HTTP server closed in finally'}));
 } else {
 let legacy=null;
 if(!discoveryOnly) {
 const catalog=page.locator('.platform-catalog-search');
 await catalog.getByText('Filter by area, time, project, client or sensitivity',{exact:true}).click();
 assert.equal(calls.some(call=>call.path.includes('/locations')),false);
 await catalog.getByRole('button',{name:'Load Geographic tags',exact:true}).click();
 await catalog.getByLabel('Geographic tag for catalog bounds',{exact:true}).selectOption({label:'Catalog field station'});
 await catalog.getByRole('button',{name:'Use Geographic tag bounds',exact:true}).click();
 await catalog.getByText(/Using Catalog field station, saved revision 1/).waitFor();
 assert.equal(await catalog.getByLabel('Catalog bounds west,south,east,north',{exact:true}).inputValue(),'-71,42,-71,42');
 await catalog.getByLabel('Geographic tag for catalog bounds',{exact:true}).selectOption({label:'Catalog unknown place'});
 await catalog.getByRole('button',{name:'Use Geographic tag bounds',exact:true}).click();
 await catalog.getByText('This Geographic tag has no recorded geometry. Your search bounds are unchanged.',{exact:true}).waitFor();
 assert.equal(await catalog.getByLabel('Catalog bounds west,south,east,north',{exact:true}).inputValue(),'-71,42,-71,42');
 await catalog.getByLabel('Search organization datasets',{exact:true}).fill('Roads');
 await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
 await catalog.getByText('1 matching records · 1 loaded · all results loaded.',{exact:true}).waitFor();
 assert.equal(await catalog.locator('tbody tr').count(),1);
 await catalog.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('10,10,20,20');
 await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
 await catalog.getByText('0 matching records.',{exact:true}).waitFor();
 await catalog.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('NaN,0,1,1');
 const before=calls.length;
 await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
 await catalog.getByText('Catalog search failed safely (catalog_bbox_invalid).',{exact:true}).waitFor();
 assert.equal(calls.length,before);
 await catalog.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('');
 await catalog.getByRole('button',{name:'Search catalog',exact:true}).click();
 await catalog.getByText('1 matching records · 1 loaded · all results loaded.',{exact:true}).waitFor();
 await catalog.getByText('Available from recorded extent',{exact:true}).waitFor();
 await catalog.getByRole('link',{name:'Roads',exact:true}).click();
 await page.locator('.layer-resource').getByRole('heading',{name:'Roads',exact:true}).waitFor();
 assert.match(page.url(),/\/layers\?id=/);
 await page.getByText('Catalog spatial search: Available from recorded extent',{exact:true}).waitFor();
 const canonicalUrl=page.url();await page.reload();
 await page.locator('.layer-resource').getByRole('heading',{name:'Roads',exact:true}).waitFor();
 assert.equal(page.url(),canonicalUrl);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 assert.equal(calls.some(call=>call.method!=='GET'),false);
 // Extend the same local journey with Layer-authored place metadata.
 await click('Load metadata record');
 await page.locator('.resource-knowledge summary').filter({hasText:/^Geographic tags$/}).click();
 await page.getByLabel('Place name',{exact:true}).fill('Kathmandu');
 assert.equal(calls.some(call=>call.path.endsWith('/place-search')),false);
 await click('Find place by name');
 await page.getByText(/Kathmandu — city in Nepal/).waitFor();
 assert.equal(await page.getByLabel('Place identity URL (optional)',{exact:true}).inputValue(),'');
 await click('Use Kathmandu (Q3037)');
 await click('Add geographic tag to draft');
 await click('Resolve Wikidata context');
 await page.getByText('Kathmandu → country → Nepal',{exact:true}).waitFor();
 await page.getByText('Nepal → continent → Asia',{exact:true}).waitFor();
 await click('Retain place context in draft');await click('Save metadata revision');
 await page.locator('.resource-knowledge [role=status]').filter({hasText:/Saved metadata revision/}).waitFor();
 const placeRevision=await page.evaluate(async()=>{const id=new URL(location.href).searchParams.get('id');return (await window.adapter.getDatasetKnowledge(id)).version;});
 await page.reload();await click('Load metadata record');
 await page.locator('.resource-knowledge').getByRole('link',{name:'http://www.wikidata.org/entity/Q3037',exact:true}).waitFor();
 await page.getByText('Nepal → continent → Asia',{exact:true}).waitFor();
 assert.equal(calls.filter(call=>call.path.endsWith('/place-context')).length,1,'reopen reuses retained context');
 const discovery=await context.newPage();discovery.on('pageerror',e=>errors.push(e.message));await discovery.goto(origin);
 const placeCatalog=discovery.locator('.platform-catalog-search');
 await placeCatalog.getByText('Filter by area, time, project, client or sensitivity',{exact:true}).click();
 await placeCatalog.getByLabel('Search organization datasets',{exact:true}).fill('Roads');
 for(const identity of ['Q3037','Q837','Q48']) {
   await placeCatalog.getByLabel('Catalog place identity URL',{exact:true}).fill(`https://www.wikidata.org/wiki/${identity}`);
   await placeCatalog.getByRole('button',{name:'Search catalog',exact:true}).click();
   await placeCatalog.getByText('1 matching records · 1 loaded · all results loaded.',{exact:true}).waitFor();
   await placeCatalog.getByRole('button',{name:'Why this place matched',exact:true}).waitFor({timeout:3000}).catch(async error=>{throw Error(JSON.stringify({error:error.message,visible:await placeCatalog.innerText(),calls:calls.slice(-8),errors}));});
   const beforeEvidence=calls.length;
   await placeCatalog.getByRole('button',{name:'Why this place matched',exact:true}).click();
   if(identity==='Q3037') await placeCatalog.getByText('Direct curated place association.',{exact:true}).waitFor();
   else if(identity==='Q48') await placeCatalog.getByText('Nepal → continent → Asia',{exact:true}).waitFor();
   else await placeCatalog.getByText('Kathmandu → country → Nepal',{exact:true}).waitFor();
   assert.equal(calls.length,beforeEvidence+1,'explanation makes one authorized metadata read');
   assert.equal(await placeCatalog.getByRole('button',{name:'Why this place matched',exact:true}).isDisabled(),true);
 }
 await placeCatalog.getByLabel('Catalog place identity URL',{exact:true}).fill('https://www.wikidata.org/wiki/Q999');
 await placeCatalog.getByRole('button',{name:'Search catalog',exact:true}).click();
 await placeCatalog.getByText('0 matching records.',{exact:true}).waitFor();
 await discovery.close();
 await page.locator('.resource-knowledge summary').filter({hasText:/^Geographic tags$/}).click();
 await click('Remove geographic tag: Kathmandu');await click('Save metadata revision');
 await page.locator('.resource-knowledge [role=status]').filter({hasText:/Saved metadata revision/}).waitFor();
 const retained=await page.evaluate(async version=>{
   const id=new URL(location.href).searchParams.get('id');
   return {current:await window.adapter.getDatasetKnowledge(id),previous:await window.adapter.getDatasetKnowledge(id,{version})};
 },placeRevision);
 assert.ok(retained.previous.document.metadata.curated.some(c=>c.value?.['@id']==='http://www.wikidata.org/entity/Q3037'));
 assert.equal(retained.current.document.metadata.curated.some(c=>c.value?.['@id']==='http://www.wikidata.org/entity/Q3037'),false);
 assert.deepEqual(retained.current.document.metadata.source,retained.previous.document.metadata.source);
 const orphanMatches=await page.evaluate(()=>window.adapter.searchDatasets({placeUri:'http://www.wikidata.org/entity/Q48'}));
 assert.equal(orphanMatches.length,0,'retained orphan context must not match as an active tag');
 assert.equal(calls.filter(call=>call.method!=='GET').length,4);
 assert.ok(calls.filter(call=>call.method==='PUT').every(call=>/\/datasets\/[^/]+\/metadata$/.test(call.path) && call.status===200));
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 legacy={canonicalInspectionReopened:true,spatialAvailability:true,savedLocationBounds:true,unknownLocationPreservesBounds:true,spatialTextSearch:true,outsideExcluded:true,clearRestores:true,invalidRejectedBeforeApi:true,catalogReadOnly:true,placeReferenceSaveReopenRemoveHistory:true,placeContextResolveRetainReopen:true,placeMatchExplanation:true,placeNameDisambiguation:true,placeCatalogAncestors:true,orphanContextExcluded:true};
 }
 // One persisted inert document closes only the changed Resource-filter UI boundary.
 await page.goto(origin);await page.waitForFunction(()=>Boolean(window.adapter));
 const fixture=await page.evaluate(async projectId=>{
  let record=await window.adapter.createResource(projectId,{kind:'document',slug:'catalog-filter-fixture',visibility:'restricted',
   metadata:{title:'Catalog filter fixture',license:'CC0-1.0',attribution:'Local synthetic fixture',spatialExtent:[-72,41,-70,43],temporalStart:'2026-01-01T00:00:00Z',temporalEnd:'2026-02-01T00:00:00Z'},content:{blocks:[]},provenance:{}});
  record=await window.adapter.transitionResource(projectId,record.id,{expectedVersion:record.versionNumber,targetState:'review'});
  record=await window.adapter.transitionResource(projectId,record.id,{expectedVersion:record.versionNumber,targetState:'published',visibility:'public'});
  return {id:record.id,version:record.versionNumber};
 },config.workspaceId);
 const writesBeforeSearch=calls.filter(call=>call.method!=='GET').length;
 await page.goto(`${origin}/resource-discovery?project=${config.workspaceId}`);
 const form=page.locator('.project-resource-filters');
 await form.getByText('Filter by area or time',{exact:true}).click();
 await form.getByLabel('Search project resources',{exact:true}).fill('Catalog filter fixture');
 await form.getByLabel('Filter resource kind',{exact:true}).selectOption('document');
 await form.getByLabel('Filter resource visibility',{exact:true}).selectOption('public');
 await form.getByLabel('Filter resource state',{exact:true}).selectOption('published');
 await form.getByLabel('Resource bounds west,south,east,north',{exact:true}).fill('-73,40,-69,44');
 await form.getByLabel('Resource time from (UTC)',{exact:true}).fill('2026-01-15T00:00');
 await form.getByLabel('Resource time through (UTC)',{exact:true}).fill('2026-01-31T00:00');
 const searchResources=async()=>{await form.getByRole('button',{name:'Search resources',exact:true}).click();await form.getByText('Permission-scoped resource filters applied.',{exact:true}).waitFor();};
 await searchResources();
 assert.deepEqual(await page.locator('.project-resource-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.resourceId)),[fixture.id]);
 await form.getByLabel('Resource time from (UTC)',{exact:true}).fill('2027-01-01T00:00');
 await form.getByLabel('Resource time through (UTC)',{exact:true}).fill('2027-02-01T00:00');
 await searchResources();assert.equal(await page.locator('.project-resource-card').count(),0);
 await form.getByLabel('Resource time from (UTC)',{exact:true}).fill('');
 await form.getByLabel('Resource time through (UTC)',{exact:true}).fill('');
 await searchResources();assert.equal(await page.locator(`.project-resource-card[data-resource-id="${fixture.id}"]`).count(),1);
 await page.reload();await form.getByText('Filter by area or time',{exact:true}).click();
 await form.getByLabel('Search project resources',{exact:true}).fill('Catalog filter fixture');
 await searchResources();assert.equal(await page.locator(`.project-resource-card[data-resource-id="${fixture.id}"]`).count(),1);
 await page.goto(origin);
 const published=page.locator('.platform-catalog-search');
 await published.getByLabel('Catalog audience',{exact:true}).selectOption('published');
 await published.getByText('Filter by area, time, project, client or sensitivity',{exact:true}).click();
 await published.getByLabel('Search published resources',{exact:true}).fill('Catalog filter fixture');
 await published.getByLabel('Published resource type',{exact:true}).selectOption('document');
 await published.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('-73,40,-69,44');
 await published.getByLabel('Catalog time from (UTC)',{exact:true}).fill('2026-01-15T00:00');
 await published.getByLabel('Catalog time through (UTC)',{exact:true}).fill('2026-01-31T00:00');
 const searchPublished=async count=>{await published.getByRole('button',{name:'Search catalog',exact:true}).click();await published.getByText(new RegExp(`^${count} published resource`)).waitFor();};
 await searchPublished(1);
 const detail=published.getByRole('link',{name:'Catalog filter fixture',exact:true});
 assert.ok((await detail.getAttribute('href')).includes(fixture.id),'public discovery retains original resource identity');
 await published.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('10,10,20,20');
 await searchPublished(0);
 await published.getByLabel('Catalog bounds west,south,east,north',{exact:true}).fill('');
 await searchPublished(1);
 await published.getByLabel('Catalog time from (UTC)',{exact:true}).fill('2027-01-01T00:00');
 await published.getByLabel('Catalog time through (UTC)',{exact:true}).fill('2027-02-01T00:00');
 await searchPublished(0);
 await published.getByLabel('Catalog time from (UTC)',{exact:true}).fill('');
 await published.getByLabel('Catalog time through (UTC)',{exact:true}).fill('');
 await searchPublished(1);
 const publicReads=calls.filter(call=>call.path.includes('/public/')&&call.path.includes('/resources?'));
 assert.ok(publicReads.some(call=>new URL(call.path,origin).searchParams.has('temporal_start')));
 assert.ok(publicReads.every(call=>!call.hasAuthorization&&!call.hasAccount),'public filters forward no private authority');
 assert.equal(calls.filter(call=>call.method!=='GET').length,writesBeforeSearch,'filter changes and reload issue no writes');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 console.log(JSON.stringify({...legacy,resourceDiscoveryFilters:{persistedId:fixture.id,version:fixture.version,localFixtureWrites:3,authorizedTextSpatialTemporalFacets:true,authorizedClearAndReopen:true,publishedSpatialTemporal:true,publishedClear:true,publishedAnonymous:true,searchWrites:0},providerTransport:"local-fixture",localApiRequests:calls.length,externalRequests:blocked.length,cleanup:"browser and local HTTP server closed in finally"}));
 }
}catch(error){
 if(metadataOnly)console.error(JSON.stringify({metadataAdminFailure:{message:error.message,APIRequests:calls.length,localWriteRequests:calls.filter(call=>call.method!=='GET').length,lastRequests:calls.slice(-8),externalRequests:blocked.length}}));
 throw error;
}finally{await browser?.close();await new Promise(done=>server.close(done));}

async function exerciseMetadataAdministration(page) {
 const projectId=config.workspaceId;
 await page.goto(`${origin}/resource-discovery?project=${projectId}`);
 const manager=page.locator('.project-resource-editor-panel').filter({has:page.getByRole('heading',{name:'Metadata profiles',exact:true})});
 const definition={schema_version:'1.0.0',required_core:['title','license','attribution'],required_languages:['fr'],core_vocabularies:{license:['CC-BY-4.0']},extension_fields:[{namespace:'research',name:'status',type:'string',title:'Review status',description:'Field dictionary entry',required:true,vocabulary:['reviewed']}]};
 await manager.getByLabel('Profile slug',{exact:true}).fill('native.metadata.admin');
 await manager.getByLabel('Profile title',{exact:true}).fill('Native metadata administration');
 await manager.getByLabel('Profile definition (JSON)',{exact:true}).fill(JSON.stringify(definition));
 await manager.getByRole('button',{name:'Create profile',exact:true}).click();
 await manager.getByRole('combobox',{name:'Metadata profile to curate',exact:true}).getByRole('option',{name:/Revise Native metadata administration · v1/}).waitFor({state:'attached'});
 const v1=await page.evaluate(async()=> (await window.adapter.listMetadataProfiles()).find(p=>p.slug==='native.metadata.admin'));
 assert.deepEqual(v1.definition,definition);
 const translations={fr:{title:'Métadonnées conservées',abstract:'Sources et droits conservés.',keywords:['terrain']}};
 const extensions={opengeo:{schemaVersion:'1.0.0',lineage:{statement:'Original field survey lineage retained.',sources:[]}},research:{status:'reviewed',unmapped:{nested:['retained',null]}},local:{rights:{license:null,accessRights:null}}};
 // Establish v1 history while this managed profile revision is still current.
 const initial=await page.evaluate(async({projectId,profile,extensions,translations})=>window.adapter.createResource(projectId,{kind:'service',slug:'native-metadata-admin-service',visibility:'restricted',metadata:{title:'Native metadata administration service',abstract:'Retained source description',language:'en',license:'CC-BY-4.0',attribution:'Original source owner',profile:profile.slug,managedProfileId:profile.id,managedProfileVersion:profile.versionNumber,extensions,translations},content:{blocks:[]},provenance:{source:'local retained fixture',method:'field survey'}}),{projectId,profile:v1,extensions,translations});
 await manager.getByLabel('Metadata profile to curate',{exact:true}).selectOption(v1.id);
 definition.extension_fields[0].vocabulary.push('verified');
 definition.extension_fields.push({namespace:'research',name:'confidence',type:'number',title:'Confidence',description:'Typed numeric field',required:false,vocabulary:[]});
 await manager.getByLabel('Profile definition (JSON)',{exact:true}).fill(JSON.stringify(definition));
 await manager.getByRole('button',{name:'Save profile revision',exact:true}).click();
 await manager.getByRole('combobox',{name:'Metadata profile to curate',exact:true}).getByRole('option',{name:/Revise Native metadata administration · v2/}).waitFor({state:'attached'});
 const v2=await page.evaluate(async()=> (await window.adapter.listMetadataProfiles()).find(p=>p.slug==='native.metadata.admin'));
 assert.equal(v2.id,v1.id);assert.equal(v2.versionNumber,2);assert.notEqual(v2.checksumSha256,v1.checksumSha256);
 await page.reload();
 await page.locator(`.project-resource-card[data-resource-id="${initial.id}"]`).getByRole('button',{name:'Open resource',exact:true}).click();
 const editor=page.locator('.project-resource-metadata-editor');
 await editor.getByLabel('Managed metadata profile',{exact:true}).selectOption(v2.id);
 const changed=structuredClone(extensions);changed.research.status='verified';changed.research.confidence=0.75;
 await editor.getByLabel('Title',{exact:true}).fill('Native metadata administration revised');
 await editor.getByLabel('Extended catalog metadata (JSON; use the reserved opengeo schema for interoperable fields)',{exact:true}).fill(JSON.stringify(changed));
 await editor.getByLabel('Change summary',{exact:true}).fill('Native metadata profile revision acceptance');
 await editor.getByRole('button',{name:'Save new version',exact:true}).click();
 await editor.getByLabel('Title',{exact:true}).filter({visible:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.project-resource-metadata-editor [aria-label="Title"]')?.value==='Native metadata administration revised' && !document.querySelector('.project-resource-metadata-editor button[type=submit]')?.disabled);
 const saved=await page.evaluate(async({projectId,id})=>window.adapter.getResource(projectId,id),{projectId,id:initial.id});
 assert.equal(saved.versionNumber,2);assert.equal(saved.managedMetadataProfileVersion,2);assert.deepEqual(saved.metadataExtensions,changed);
 assert.deepEqual(saved.translations,initial.translations);assert.deepEqual(saved.provenance,initial.provenance);
 assert.equal(saved.license,initial.license);assert.equal(saved.attribution,initial.attribution);
 await page.reload();await page.locator(`.project-resource-card[data-resource-id="${initial.id}"]`).getByRole('button',{name:'Open resource',exact:true}).click();
 assert.equal(await editor.getByLabel('License',{exact:true}).inputValue(),'CC-BY-4.0');
 assert.equal(await editor.getByLabel('Attribution',{exact:true}).inputValue(),'Original source owner');
 assert.deepEqual(JSON.parse(await editor.getByLabel('Alternate-language metadata (JSON by BCP 47 tag)',{exact:true}).inputValue()),saved.translations);
 assert.deepEqual(JSON.parse(await editor.getByLabel('Extended catalog metadata (JSON; use the reserved opengeo schema for interoperable fields)',{exact:true}).inputValue()),changed);
 const fixture=JSON.parse(await readFile(new URL('../../parity/fixtures/data/geonode-5.1-resources.json',import.meta.url),'utf8'));
 fixture.resources=fixture.resources.slice(0,1);fixture.relationships=[];
 const geoNode=await page.evaluate(async({projectId,fixture})=>{const imported=await window.adapter.importGeoNodeResources(projectId,fixture);const exported=await window.adapter.exportResourceToGeoNode(projectId,imported.resources[0].id);return {imported,exported};},{projectId,fixture});
 assert.equal(geoNode.imported.sourceVersion,'5.1.0');assert.equal(geoNode.exported.targetVersion,'5.1.0');
 assert.ok(Array.isArray(geoNode.imported.report.fields)&&geoNode.imported.report.fields.length>0);
 assert.ok(Array.isArray(geoNode.exported.report.fields)&&geoNode.exported.report.fields.length>0);
 return {profileV1:v1,profileV2:v2,initial,saved,geoNode,nativeProfileCreateRevise:true,nativeMetadataSaveReopen:true,rightsProvenanceLineageMultilingualUnmappedPreserved:true,historyScope:'Independent runtime-role SQL readback follows; no generic metadata-history UI or endpoint exists',providerTransport:'local fixture; no source URL fetch'};
}
