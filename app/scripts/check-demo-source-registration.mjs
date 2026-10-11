import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";
import {upgradeMapDefinition} from "../src/lib/mapDefinition.js";

const root = resolve("app/dist/demo-build");
const types = {".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json", ".html": "text/html", ".pbf": "application/octet-stream"};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + "/")) throw Error("path");
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const live = process.env.OPEN_GEO_BROWSER_DEMO_LIVE === "1";
const origin = live ? "https://demo.studio.opengeo.tools" : `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [], privateRequests = [], serviceRequests = [];
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
  page = await browser.newPage({viewport: {width: 1280, height: 820}, serviceWorkers: "block"});
  // Keep this persistence journey within one Demo day even across midnight.
  await page.clock.setFixedTime(new Date());
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (/\/api\/|auth-config|workspaces|login/.test(url.pathname)) privateRequests.push(url.href);
    if (url.origin === origin) return route.continue();
    if (url.hostname === "reviewed-service.example.org") {
      serviceRequests.push(url.href);
      return route.fulfill({contentType:"image/png",body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64")});
    }
    // Only the selected static origin may receive requests; substitute an empty basemap.
    if (url.href.includes("/styles/")) return route.fulfill({json: {version: 8, sources: {}, layers: []}});
    return route.abort();
  });
  await page.goto(origin + "/");
  const shell = page.locator(".opengeo-workbench"); await shell.waitFor();
  const input = {name:'Berkshire Botanical Garden.kml',mimeType:'application/vnd.google-earth.kml+xml',buffer:Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My Places</name><description>Survey source notes</description><Placemark><name>Berkshire Botanical Garden</name><Point><coordinates>-73.336,42.300,0</coordinates></Point></Placemark></Document></kml>')};
  await page.getByRole("button", {name: "Add data", exact: true}).first().click();
  await page.locator('.gis-file-drop input[type=file]').first().setInputFiles(input);
  const dialog = page.locator('.browser-layer-registration'); await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Layer title',{exact:true}).inputValue(),'My Places');
  assert.equal(await dialog.getByLabel('Description',{exact:true}).inputValue(),'Survey source notes');
  assert.equal(await dialog.getByLabel('License',{exact:true}).inputValue(),'');
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.some(l=>l.layerId==='kml-places')),false);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.some(l=>l.layerId==='kml-places')),false);
  await page.locator('.gis-file-drop input[type=file]').first().setInputFiles([]);
  await page.locator('.gis-file-drop input[type=file]').first().setInputFiles(input);
  await dialog.getByLabel('Layer title',{exact:true}).fill('Garden observations');
  await dialog.getByLabel('Attribution',{exact:true}).fill('Synthetic browser test');
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  await page.waitForFunction(()=>{
    const s=document.querySelector('.opengeo-workbench'),m=s.__opengeoMap;
    return Math.abs(m.getCenter().lng+73.336)<0.001 && m.queryRenderedFeatures({layers:['kml-places-points']}).length>0;
  });
  let metadata=await shell.evaluate(s=>s.__opengeoLayers.find(l=>l.layerId==='kml-places').metadata);
  assert.equal(metadata.source.filename,input.name); assert.equal(metadata.curated.license,null); assert.equal(metadata.curated.title,'Garden observations');
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  await page.getByRole('heading',{name:'Layer catalog',exact:true}).waitFor();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),0);
  await page.getByRole('button',{name:'Browse Layer catalog',exact:true}).click();
  await page.getByRole('heading',{name:'Layer catalog',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Search Layers',{exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  await page.reload();await shell.waitFor();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.some(layer=>layer.metadata?.curated?.title==='Garden observations')),false);
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  assert.equal(await page.getByLabel('Search Layers',{exact:true}).inputValue(), '', 'a new Project shows the whole catalog instead of retaining the previous search');
  await page.getByLabel('Search Layers',{exact:true}).fill('Garden observations');
  assert.equal(await page.locator('.browser-layer-catalog article').count(),1,'registration survives without membership in the saved Project');
  const url=page.url();
  await page.getByLabel('Search Layers',{exact:true}).fill('Public community facilities');
  await page.locator('.browser-layer-catalog article').getByRole('button',{name:'Review and add',exact:true}).click();
  await dialog.waitFor(); assert.notEqual(await dialog.getByLabel('License',{exact:true}).inputValue(),'');
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  assert.equal(page.url(),url); assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),1);
  await page.getByRole('button',{name:'Add data',exact:true}).first().click();
  await page.getByRole('button',{name:'Catalog',exact:true}).first().click();
  await page.getByRole('heading',{name:'Layer catalog',exact:true}).waitFor();
  assert.equal(page.url(),url,'returning to the catalog keeps the current Project');
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),1,'opening the catalog preserves selected Layers');
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  assert.equal(await page.getByLabel('Search Layers',{exact:true}).inputValue(), '', 'a new Project shows the whole catalog instead of retaining the previous search');
  await page.getByLabel('Search Layers',{exact:true}).fill('Garden observations');
  await page.locator('.browser-layer-catalog article').getByRole('button',{name:'Review and add',exact:true}).click();
  await dialog.waitFor(); assert.equal(await dialog.getByLabel('Attribution',{exact:true}).inputValue(),'Synthetic browser test');
  await page.setViewportSize({width:390,height:844});
  const box=await dialog.boundingBox();assert.ok(box && box.width<=390 && box.x>=0);
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  await page.reload();await shell.waitFor();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.some(l=>l.metadata?.curated?.title==='Garden observations'));
  metadata=await shell.evaluate(s=>s.__opengeoLayers.find(l=>l.metadata?.curated?.title==='Garden observations').metadata);
  assert.equal(metadata.source.filename,input.name);assert.equal(metadata.curated.attribution,'Synthetic browser test');
  // Exercise the reference-only draft path with the deterministic community source.
  await page.setViewportSize({width:1280,height:820});
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  await page.getByLabel('Search Layers',{exact:true}).fill('Public community facilities');
  await page.locator('.browser-layer-catalog article').getByRole('button',{name:'Review and add',exact:true}).click();
  await dialog.getByLabel('Layer title',{exact:true}).fill('Retained catalog reference');
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  await shell.evaluate(s=>{s.__opengeoLayers[0].browserDraftData=false;});
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  const savedReference=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('opengeo.public-demo.')).map(([,v])=>JSON.parse(v)).flatMap(v=>v.layers??[]).find(l=>l.title==='Retained catalog reference'));
  assert.ok(savedReference.browserCatalogId);assert.equal(savedReference.geojson,undefined);
  await page.reload();await shell.waitFor();
  await page.waitForFunction(()=>{
    const s=document.querySelector('.opengeo-workbench'),l=s?.__opengeoLayers?.find(l=>l.title==='Retained catalog reference');
    return l && s.__opengeoMap.queryRenderedFeatures().some(f=>f.layer.id.startsWith(l.layerId));
  });
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers[0].metadata.curated.title),'Retained catalog reference');
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  assert.equal(await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('opengeo.public-demo.')).map(([,v])=>JSON.parse(v)).flatMap(v=>v.layers??[]).find(l=>l.title==='Retained catalog reference').geojson),undefined);
  await page.getByRole('button',{name:'Add data',exact:true}).first().click();
  await page.getByLabel('Source type',{exact:true}).selectOption('wms');
  await page.getByLabel('WMS endpoint',{exact:true}).fill('https://reviewed-service.example.org/wms');
  await page.getByRole('button',{name:'Register WMS source',exact:true}).click();
  await dialog.waitFor();
  assert.match(await dialog.textContent(),/Not inspected/);
  assert.equal(serviceRequests.length,0);
  const previousLayerCount=await shell.evaluate(s=>s.__opengeoLayers.length);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),previousLayerCount);
  await page.getByRole('button',{name:'Register WMS source',exact:true}).click();
  await dialog.getByLabel('Layer title',{exact:true}).fill('Reviewed WMS reference');
  await dialog.getByLabel('Attribution',{exact:true}).fill('Synthetic WMS provider');
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.some(l=>l.title==='Reviewed WMS reference'));
  const service=await shell.evaluate(s=>s.__opengeoLayers.find(l=>l.title==='Reviewed WMS reference'));
  assert.equal(service.governedSource,false);assert.equal(service.metadata.curated.license,null);
  assert.deepEqual(service.metadata.normalized,{});assert.equal(service.metadata.source.custody,'referenced');
  assert.match(service.tileUrl,/request=GetMap/i);
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  await page.reload();await shell.waitFor();
  await page.waitForFunction(()=>{const s=document.querySelector('.opengeo-workbench'),l=s?.__opengeoLayers?.find(l=>l.title==='Reviewed WMS reference');return l && s.__opengeoMap?.getLayer(l.layerId+'-raster');});
  const reopenedService=await shell.evaluate(s=>s.__opengeoLayers.find(l=>l.title==='Reviewed WMS reference'));
  assert.equal(reopenedService.tileUrl,service.tileUrl);assert.equal(reopenedService.sourceUrl,'https://reviewed-service.example.org/wms');
  assert.equal(reopenedService.metadata.curated.attribution,'Synthetic WMS provider');
  // Distinct imports retain independent source/catalog identities.
  await page.getByRole('button',{name:'Add data',exact:true}).first().click();
  await page.locator('.gis-file-drop input[type=file]').first().setInputFiles({name:'second.kml',mimeType:input.mimeType,buffer:Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Second survey</name><Placemark><name>Second point</name><Point><coordinates>-73.2,42.2,0</coordinates></Point></Placemark></Document></kml>')});
  await dialog.waitFor();await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  await page.reload();await shell.waitFor();
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  assert.equal(await page.getByLabel('Search Layers',{exact:true}).inputValue(), '', 'a new Project shows the whole catalog instead of retaining the previous search');
  await page.getByLabel('Search Layers',{exact:true}).fill('Garden observations');
  assert.equal(await page.locator('.browser-layer-catalog article').count(),1);
  await page.getByLabel('Search Layers',{exact:true}).fill('Second survey');
  assert.equal(await page.locator('.browser-layer-catalog article').count(),1);
  const kmlEntries=await page.evaluate(()=>JSON.parse(localStorage.getItem('opengeo.public-demo.layer-catalog.v1')).entries.filter(([,entry])=>entry.kml));
  assert.equal(kmlEntries.length,2);assert.notEqual(kmlEntries[0][0],kmlEntries[1][0]);
  assert.deepEqual(kmlEntries.map(([,entry])=>entry.kml.document.name).sort(),['My Places','Second survey']);
  // Two catalog documents coexist, select independent editing contexts, and reopen.
  await page.setViewportSize({width:1280,height:820});
  for (const title of ['Garden observations','Second survey']) {
    await page.getByLabel('Search Layers',{exact:true}).fill(title);
    await page.locator('.browser-layer-catalog article').filter({has:page.getByText(title,{exact:true})}).getByRole('button',{name:'Review and add',exact:true}).click();
    await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
    if (title==='Garden observations') {
      await page.getByRole('button',{name:'Add data',exact:true}).first().click();
      await page.getByRole('button',{name:'Browse Layer catalog',exact:true}).click();
    }
  }
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.filter(l=>l.sourceType==='kml-places').length),2);
  await page.getByRole('button',{name:'Open layer properties for Second survey',exact:true}).click();
  await page.getByRole('button',{name:'Edit Second point',exact:true}).click();
  await page.locator('[data-kml-editing-field="name"]').fill('Revised second point');
  await page.locator('[data-kml-authoring-action="update"]').click();
  await page.getByRole('button',{name:'Open layer properties for Garden observations',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Edit Revised second point',exact:true}).count(),0);
  await page.locator('[data-place-kind="placemark"] button').filter({hasText:/^Edit /}).first().click();
  await page.locator('[data-kml-editing-field="name"]').fill('Revised garden point');
  await page.locator('[data-kml-authoring-action="update"]').click();

  await page.getByRole('checkbox',{name:'Show Second survey',exact:true}).uncheck();
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  await page.reload(); await shell.waitFor();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.filter(l=>l.sourceType==='kml-places').length===2);
  const reopened=await shell.evaluate(s=>s.__opengeoLayers.filter(l=>l.sourceType==='kml-places').map(l=>({id:l.layerId,title:l.title,visible:l.visible,doc:l.kmlDocument})));
  assert.equal(new Set(reopened.map(l=>l.id)).size,2);
  assert.equal(reopened.find(l=>l.title==='Second survey').visible,false);
  assert.ok(JSON.stringify(reopened.find(l=>l.title==='Second survey').doc).includes('Revised second point'));
  assert.ok(!JSON.stringify(reopened.find(l=>l.title==='Garden observations').doc).includes('Revised second point'));
  assert.ok(JSON.stringify(reopened.find(l=>l.title==='Garden observations').doc).includes('Revised garden point'));
  await page.getByRole('checkbox',{name:'Show Second survey',exact:true}).check();
  await shell.evaluate(s=>s.__opengeoMap.fitBounds([[-73.35,42.19],[-73.19,42.4]],{duration:0,padding:60}));
  await page.waitForFunction(()=>{
    const s=document.querySelector('.opengeo-workbench');
    return s.__opengeoLayers.filter(l=>l.sourceType==='kml-places').every(l=>s.__opengeoMap.queryRenderedFeatures({layers:[`${l.layerId}-points`]}).length>0);
  });
  await page.locator('.gis-menu-wrap[data-menu="project"] > button').click();
  await page.getByRole('menuitem',{name:/^Save as \/ export…/}).click();
  const exportDialog=page.getByRole('dialog',{name:'Save as or export Project',exact:true});
  await exportDialog.getByRole('combobox',{name:'Project export format'}).selectOption('opengeo');
  const projectDownload = page.waitForEvent('download');
  await exportDialog.getByRole('button',{name:'Export file',exact:true}).click();
  const downloadedProject = await projectDownload;
  await exportDialog.getByRole('button',{name:'Close',exact:true}).click();
  const exportedProject = JSON.parse(await readFile(await downloadedProject.path(),'utf8'));
  const upgradedProject = upgradeMapDefinition(exportedProject);
  assert.equal(upgradedProject.kmlLayerDocuments,true);
  const exportedKml = upgradedProject.layers.filter(layer=>layer.sourceType==='kml-places');
  assert.equal(exportedKml.length,2);
  for (const saved of reopened) {
    const exported = exportedKml.find(layer=>layer.layerId===saved.id);
    assert.deepEqual(exported.kmlDocument,saved.doc);
    assert.equal(exported.metadata.curated.title,saved.title);
    assert.ok(exported.kmlNetworkLinkState);
    assert.equal(Object.hasOwn(exported,'kmlNetworkLinkApprovals'),false);
  }
  assert.equal(exportedProject.persistence.uploaded,false);
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  const projectFile = {name:'two-documents.opengeo-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exportedProject))};
  const openProjectFile = async file => {
    await page.locator('.gis-menu-wrap[data-menu="project"] > button').click();
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('menuitem',{name:/^Open Project file…/}).click();
    await (await choosing).setFiles(file);
  };
  const emptyStorage = await page.evaluate(()=>JSON.stringify({...localStorage}));
  await openProjectFile({...projectFile,buffer:Buffer.from(JSON.stringify({...exportedProject,layers:[exportedProject.layers[0],exportedProject.layers[0]]}))});
  await page.getByText(/Project file could not open: Project Layer identities/).first().waitFor();
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),emptyStorage);
  await openProjectFile(projectFile);
  const openDialog = page.getByRole('dialog',{name:'Review Project file',exact:true});
  await openDialog.getByText('OpenGeo browser Project',{exact:false}).waitFor();
  await openDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),0);
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),emptyStorage);
  await openProjectFile(projectFile);
  await page.setViewportSize({width:390,height:844});
  const openBox=await openDialog.boundingBox(); assert.ok(openBox && openBox.x>=0 && openBox.width<=390);
  await Promise.all([page.waitForNavigation(),openDialog.getByRole('button',{name:'Open in this Project',exact:true}).click()]);
  await shell.waitFor();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.filter(l=>l.sourceType==='kml-places').length===2);
  assert.equal(await page.locator('.public-demo-notice strong').textContent(),exportedProject.title);
  const importedKml = await shell.evaluate(s=>s.__opengeoLayers.filter(l=>l.sourceType==='kml-places'));
  for (const exported of exportedKml) {
    const imported=importedKml.find(l=>l.layerId===exported.layerId);
    assert.deepEqual(imported.kmlDocument,exported.kmlDocument);
    assert.deepEqual(imported.metadata,exported.metadata);
  }
  await page.setViewportSize({width:1280,height:820});
  await page.waitForFunction(()=>{
    const s=document.querySelector('.opengeo-workbench');
    return s.__opengeoLayers.filter(l=>l.sourceType==='kml-places').every(l=>s.__opengeoMap.queryRenderedFeatures({layers:[`${l.layerId}-points`]}).length>0);
  });

  assert.ok(serviceRequests.length>0);assert.ok(serviceRequests.every(url=>/request=GetMap/i.test(url)));
  assert.deepEqual(errors,[]);assert.deepEqual(privateRequests,[]);
  const evidence=resolve(process.env.OPEN_GEO_DEMO_EVIDENCE_DIR ?? '.local-archives/demo-registration-20260919');await mkdir(evidence,{recursive:true});
  await page.screenshot({path:resolve(evidence,'registration-reopened.png')});
  const manifest=JSON.parse(await readFile(resolve('dist/opengeo-demo-build.json'),'utf8'));
  const result={status:'passed',origin,tree:manifest.artifactTree.digest,metadataPrepopulated:true,unknownLicensePreserved:true,cancelDoesNotAdd:true,kmlPointRenderedAndFitted:true,independentKmlCatalogIdentity:true,simultaneousKmlRenderEditReopen:true,allKmlDocumentsExported:true,nativeProjectReopened:true,nativeProjectCancelAndRejectPreserveDraft:true,catalogIndependentOfProjectAfterReload:true,newProjectCatalog:true,newProjectClearsCatalogSearch:true,catalogSelectionKeepsProject:true,localSourceReused:true,metadataReopened:true,catalogReferenceReopened:true,referenceDataNotCopied:true,remoteReviewCancelAndReopen:true,serviceFixtureRequests:serviceRequests.length,mobileDialog:true,externalProvidersContacted:0,privateRequests,errors};
  await writeFile(resolve(evidence,live?'live-registration-check.json':'registration-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error) {console.error(JSON.stringify({error:error.message,errors,privateRequests,diagnostic:await page?.evaluate(()=>{const s=document.querySelector(".opengeo-workbench");return {layers:s?.__opengeoLayers,status:document.querySelector(".gis-statusbar")?.textContent,sources:s?.__opengeoMap?.getStyle()?.sources,center:s?.__opengeoMap?.getCenter()};}).catch(()=>null)}));throw error;}
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
