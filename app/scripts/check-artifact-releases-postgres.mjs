// Reuse built modules; synthetic token verification, real local API/database, no providers.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';
let input='';for await(const part of process.stdin)input+=part;
const config=JSON.parse(input),dist=resolve('dist'),calls=[],blocked=[],errors=[];
let lostRelease=false;const releaseRequests=[];
const modulePath=async(dir,name)=>`/_import/${dir}/${(await readdir(resolve(dist,'_import',dir))).find(file=>file.startsWith(name+'.')&&file.endsWith('.js'))}`;
const component=await modulePath('components','ProjectArtifactVersions'),client=await modulePath('lib','apiClient');
const galleryComponent=await modulePath('components','CollectionDirectory');
const workspaceComponent=await modulePath('components','ProjectWorkspacePage');
const stylesheet='/_file/'+(await readdir(resolve(dist,'_file'))).find(name=>/^style\..*\.css$/.test(name));
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const upstream=request({hostname:'127.0.0.1',port:config.apiPort,path:req.url.slice(4),method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},response=>{
   calls.push({method:req.method,path:req.url,status:response.statusCode});
   if(req.method==='POST'&&/^\/api\/artifacts\/[^/]+\/releases$/.test(req.url)&&response.statusCode===201){
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
     const body=Buffer.concat(chunks);releaseRequests.push(JSON.parse(body));
     if(!lostRelease){lostRelease=true;res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({detail:'synthetic lost response'}));}
     else {res.writeHead(response.statusCode,response.headers);res.end(body);}
    });return;
   }
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });upstream.on('error',()=>res.writeHead(502).end());req.pipe(upstream);return;
 }
 if(req.url.startsWith('/?')||req.url.startsWith('/workspaces?')||req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><link rel="stylesheet" href="${stylesheet}"><main></main><script type="module">
  import {ProjectWorkspacePage} from '${workspaceComponent}';import {ProjectArtifactVersions} from '${component}';import {CollectionDirectory} from '${galleryComponent}';import {OpenGeoApiClient} from '${client}';
  const actor=new URL(location.href).searchParams.get('actor')||sessionStorage.getItem('localActor')||'admin';
  sessionStorage.setItem('localActor',actor);
  let organization=${JSON.stringify(config.organizationId)};
  window.adapter=new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=>actor,organizationProvider:()=>organization});
  window.adapter.selectOrganization=id=>{organization=id;};
  window.directory=new URL(location.href).searchParams.has('host')?ProjectWorkspacePage({adapter:window.adapter,projectId:${JSON.stringify(config.workspaceId)},managementTarget:'resources'}):new URL(location.href).searchParams.has('gallery')?CollectionDirectory({adapter:window.adapter,updateLocation:false}):ProjectArtifactVersions({adapter:window.adapter,projectId:${JSON.stringify(config.workspaceId)},resourceId:${JSON.stringify(config.resourceId)},canEdit:true});
  document.querySelector('main').append(window.directory);</script>`);return;
 }
 const path=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(dist+'/')){res.writeHead(403).end();return;}
 try{res.setHeader('Content-Type',['.js','.mjs'].includes(extname(path))?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;let browser;
async function checkPublicationAudience(workspace) {
 const sourceId=config.publicationAudience.sourceResourceId;
 await workspace.locator(`[data-resource-id="${sourceId}"]`).getByRole('button',{name:'Open resource',exact:true}).click();
 await workspace.getByLabel('Current publication audience',{exact:true}).waitFor();
 const sourceBefore=await workspace.evaluate(({workspaceId,sourceId})=>adapter.getResource(workspaceId,sourceId),{workspaceId:config.workspaceId,sourceId});
 for(const audience of ['organization','public']) {
  await workspace.getByLabel('Current publication audience',{exact:true}).selectOption(audience);
  await workspace.getByRole('button',{name:'Change publication audience',exact:true}).click();
  await workspace.waitForFunction(value=>document.querySelector('[aria-label="Current publication audience"]')?.value===value
   && document.querySelector('.project-resource-detail')?.dataset.state==='ready'
   && [...document.querySelectorAll('.project-resource-detail button')].some(button=>button.textContent==='Archive' && !button.disabled),audience);
 }
 const sourceAfter=await workspace.evaluate(({workspaceId,sourceId})=>adapter.getResource(workspaceId,sourceId),{workspaceId:config.workspaceId,sourceId});
 assert.equal(sourceAfter.versionNumber,sourceBefore.versionNumber);
 assert.equal(sourceAfter.state,'published'); assert.equal(sourceAfter.visibility,'public');
 assert.deepEqual(sourceAfter.content,sourceBefore.content); assert.deepEqual(sourceAfter.provenance,sourceBefore.provenance);
}
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
 const context=await browser.newContext();
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blocked.push(route.request().url());return route.abort();});
 if(config.publicationAudienceOnly) {
  const workspace=await context.newPage();workspace.setDefaultTimeout(15000);workspace.on('pageerror',error=>errors.push(error.message));
  await workspace.goto(origin+'/?host=1');
  await checkPublicationAudience(workspace);
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  assert.equal(calls.some(call=>/processing|\/image$/.test(call.path)),false);
  console.log(JSON.stringify({publicationAudienceSaveReopenRestore:true,journey:'publication-audience-only',localApiRequests:calls.length,externalRequests:blocked.length}));
 } else {
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const click=name=>page.getByRole('button',{name,exact:true}).click();
 await page.goto(origin);
 await click('Inspect Artifact version');
 await click('Load public releases');
 await page.getByRole('button',{name:'Publish inspected edition',exact:true}).waitFor();
 await click('Publish inspected edition');
 await page.getByLabel('Release title',{exact:true}).fill('Browser public Project');
 await page.getByLabel('Output attribution',{exact:true}).fill('Local team');
 await page.getByLabel('Output license',{exact:true}).selectOption('CC0-1.0');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('dialog').evaluate(element=>element.open),true);
 const draftUrl=page.url();
 assert.equal(await page.evaluate(()=>document.querySelector('.artifact-releases').setTarget(null)),false);
 await page.evaluate(()=>{const field=document.querySelector('[aria-label="Artifact representation"]');field.value='portable-map-html';field.dispatchEvent(new Event('change'));});
 assert.equal(await page.getByLabel('Artifact representation',{exact:true}).inputValue(),'saved-map-image');
 await page.evaluate(()=>{const link=document.createElement('a');link.href='/workspaces';document.body.append(link);link.click();link.remove();});
 assert.equal(page.url(),draftUrl);
 await page.evaluate(()=>{history.pushState(null,'','/workspaces');dispatchEvent(new PopStateEvent('popstate'));});
 assert.equal(page.url(),draftUrl);
 assert.equal(await page.getByLabel('Release title',{exact:true}).inputValue(),'Browser public Project');
 await click('Publish this edition publicly');
 await page.getByRole('button',{name:'Retry release',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Release title',{exact:true}).inputValue(),'Browser public Project');
 assert.equal(await page.getByLabel('Release title',{exact:true}).isDisabled(),true);
 page.once('dialog',dialog=>dialog.accept());
 await page.reload();await click('Inspect Artifact version');await click('Load public releases');await click('Publish inspected edition');
 await page.getByText(/Restored release draft for edition v1/).waitFor();
 assert.equal(await page.getByLabel('Release title',{exact:true}).inputValue(),'Browser public Project');
 assert.equal(releaseRequests.length,1,'reopening does not publish');
 await click('Retry release');
 await page.getByText(/Public release created:/).waitFor();
 assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('opengeo.release-draft.v1:')).length),0);
 assert.equal(releaseRequests.length,2);assert.equal(releaseRequests[0].id,releaseRequests[1].id);
 const history=await page.evaluate(id=>adapter.listArtifactReleases(id),config.artifactId);
 assert.equal(history.records.filter(record=>record.title==='Browser public Project').length,1);
 await page.reload();await click('Inspect Artifact version');await click('Load public releases');
 await page.getByRole('link',{name:'Open public output',exact:true}).waitFor();
 assert.match(await page.locator('ul').innerText(),/Browser public Project/);
 const link=await page.getByRole('link',{name:'Open public output',exact:true}).getAttribute('href');
 assert.match(link,/artifact-releases\/[^/]+\/view$/);
 const previewPage=await context.newPage();
 const collectionUrl=origin+`/api/public/organizations/${config.organizationId}/collections/${config.collectionId}/view`;
 const previewRequestsBefore=calls.filter(call=>call.path.endsWith('/preview')).length;
 await previewPage.goto(collectionUrl);
 await previewPage.waitForFunction(()=>{const image=document.querySelector('img');return image?.complete && image.naturalWidth===16 && image.naturalHeight===16;});
 assert.equal(await previewPage.locator('img').count(),1);
 assert.equal(calls.filter(call=>call.path.endsWith('/preview')).length-previewRequestsBefore,1);
 await previewPage.screenshot({path:'/tmp/collection-valid-image-preview.png'});
 const galleryPage=await context.newPage();await galleryPage.goto(origin+'/?gallery=1');
 const card=galleryPage.locator('.collection-card').filter({hasText:'Public project studies'});
 await card.getByRole('button',{name:'Load image previews',exact:true}).click();
 await card.locator('img').waitFor();
 await card.locator('img').evaluate(image=>image.decode());
 assert.equal(await card.locator('img').evaluate(image=>image.naturalWidth),16);
 assert.match(await card.locator('figcaption').innerText(),/CC0-1.0/);
 await card.screenshot({path:'/tmp/studio-collection-thumbnail.png'});
 await card.getByRole('button',{name:'Public project studies',exact:true}).click();
 await galleryPage.getByRole('button',{name:'Load member previews',exact:true}).click();
 const memberImage=galleryPage.locator('.collection-member-card img');
 await memberImage.waitFor();await memberImage.evaluate(image=>image.decode());
 assert.equal(await memberImage.evaluate(image=>image.naturalWidth),16);
 assert.match(await galleryPage.locator('.collection-member-card figcaption').innerText(),/CC0-1.0/);
 await galleryPage.locator('.collection-member-grid').screenshot({path:'/tmp/studio-collection-member-preview.png'});

 await click('Revoke public release');await page.getByText('Public release revoked.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open public output',exact:true}).count(),0);
 await previewPage.reload();assert.equal(await previewPage.locator('img').count(),0);
 await previewPage.close();
 await galleryPage.reload();
 await galleryPage.locator('.collection-card').filter({hasText:'Public project studies'}).getByRole('button',{name:'Load image previews',exact:true}).click();
 await galleryPage.getByText('No eligible image previews. Text previews remain available.',{exact:true}).waitFor();
 assert.equal(await galleryPage.locator('.collection-card img').count(),0);
 await galleryPage.close();
 const publicationPage=await context.newPage();await publicationPage.goto(origin+'/?gallery=1');
 const publicationCard=publicationPage.locator('.collection-card').filter({hasText:'Publication studies'});
 await publicationCard.getByRole('button',{name:'Load image previews',exact:true}).click();
 await publicationCard.locator('img').waitFor();await publicationCard.locator('img').evaluate(image=>image.decode());
 assert.equal(await publicationCard.locator('img').evaluate(image=>image.naturalWidth),16);
 await publicationCard.getByRole('button',{name:'Publication studies',exact:true}).click();
 await publicationPage.getByRole('button',{name:'Load member previews',exact:true}).click();
 await publicationPage.locator('.collection-member-card img').waitFor();
 await publicationPage.locator('.collection-member-card img').evaluate(image=>image.decode());
 assert.match(await publicationPage.locator('.collection-member-card').innerText(),/Publication: Publication preview study/);
 assert.match(await publicationPage.locator('.collection-member-card figcaption').innerText(),/Local fixture · CC0-1.0/);
 const anonymous=await context.newPage();
 await anonymous.goto(origin+`/api/public/organizations/${config.organizationId}/collections/${config.publicationCollectionId}/view`);
 await anonymous.locator('img').waitFor();await anonymous.locator('img').evaluate(image=>image.decode());
 assert.equal(await anonymous.locator('img').evaluate(image=>image.naturalWidth),16);
 const revoke=await publicationPage.request.post(origin+'/api'+config.publicationSitePath+`/editions/${config.publicationEditionId}/revoke`,{headers:{Authorization:'Bearer admin','X-OpenGeo-Organization':config.organizationId}});
 assert.equal(revoke.status(),200);
 await anonymous.reload();assert.equal(await anonymous.locator('img').count(),0);await anonymous.close();
 await publicationPage.reload();
 await publicationPage.locator('.collection-card').filter({hasText:'Publication studies'}).getByRole('button',{name:'Load image previews',exact:true}).click();
 await publicationPage.getByText('No eligible image previews. Text previews remain available.',{exact:true}).waitFor();
 await publicationPage.close();
 await page.reload();await click('Inspect Artifact version');await click('Load public releases');
 await page.getByText(/Saved public releases loaded/).waitFor();
 assert.match(await page.locator('ul').innerText(),/Revoked/);
 const workspace=await context.newPage();workspace.setDefaultTimeout(15000);workspace.on('pageerror',error=>errors.push(error.message));
 await workspace.goto(origin+'/?host=1');
 await workspace.locator(`[data-resource-id="${config.resourceId}"]`).getByRole('button',{name:'Open resource',exact:true}).click();
 await workspace.getByRole('button',{name:'Inspect Artifact version',exact:true}).click();
 await workspace.getByRole('button',{name:'Load public releases',exact:true}).click();
 await workspace.getByRole('button',{name:'Publish inspected edition',exact:true}).click();
 await workspace.getByLabel('Release title',{exact:true}).fill('Workspace retained draft');
 const workspaceUrl=workspace.url();
 await workspace.evaluate(()=>document.querySelector('.project-resource-detail-heading button').click());
 assert.equal(await workspace.getByLabel('Release title',{exact:true}).inputValue(),'Workspace retained draft');
 const readsBefore=calls.length;
 await workspace.evaluate(()=>document.querySelector('.project-resource-card button').click());
 assert.equal(calls.length,readsBefore,'resource switching guard stops replacement and requests');
 assert.equal(await workspace.getByLabel('Release title',{exact:true}).inputValue(),'Workspace retained draft');
 await workspace.evaluate(()=>document.querySelector('.platform-workspace a[href]').click());
 assert.equal(workspace.url(),workspaceUrl);
 await workspace.getByText('Publish or discard this release draft before leaving or changing the Artifact.',{exact:true}).waitFor();
 await workspace.getByRole('button',{name:'Discard release draft',exact:true}).click();
 await workspace.locator('.project-resource-detail-heading').getByRole('button',{name:'Close',exact:true}).click();
 assert.equal(await workspace.locator('.artifact-releases').count(),0);
 assert.equal(await workspace.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('opengeo.release-draft.v1:')).length),0);
 await checkPublicationAudience(workspace);
 await workspace.close();
 assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
 assert.equal(calls.some(call=>/processing|\/image$/.test(call.path)),false);
 console.log(JSON.stringify({publicationAudienceSaveReopenRestore:true,workspaceResourceReplacementGuards:true,workspaceDiscardReleasesGuard:true,releaseReloadRecoveryAndCleanup:true,releaseDraftLinkBackAndTargetGuards:true,lostReleaseRecoveredWithoutDuplicate:true,publicationGalleryMemberAndPublicDecode:true,publicationRevocationFallback:true,studioMemberImageDecode:true,studioGalleryImageDecode:true,studioRevokedPreviewFallback:true,validPngCollectionPreview:true,onePreviewRead:true,revokedPreviewRemoved:true,releaseCreateReopenRevoke:true,modalDraftEscapeGuard:true,localApiRequests:calls.length,externalRequests:blocked.length}));
 }
}finally{await browser?.close();await new Promise(done=>server.close(done));}
