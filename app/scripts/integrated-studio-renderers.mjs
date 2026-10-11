// Scoped real API/PostGIS persistence journey. SDK authorization/cloud transport
// remain local substitutes supplied by the existing integration orchestrator.
import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

export async function exerciseGeoLibreImport({page, project, composition, origin, organization, worker, readApi, apiRequest, work}) {
  const base = `/projects/${project.id}`, mapPath = `${base}/maps/${composition.id}`;
  const fixture = JSON.parse(await readFile(new URL('../../parity/fixtures/data/geolibre-2.6-project.geolibre.json', import.meta.url), 'utf8'));
  fixture.primaryRenderer = "cesium";
  fixture.layers = [fixture.layers[0]];
  const beforeDatasets = await readApi(`${base}/datasets`);
  const openMap = async () => {
    await page.goto(`${origin}/workspaces?composition=${composition.id}`);
    await page.locator('.opengeo-workbench').waitFor();
  };
  await openMap();
  const menu = page.locator('.gis-menu-wrap[data-menu="project"]');
  await menu.locator('.gis-menu-button').click();
  const choosingProject = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', {name:/^Open Project file…/}).click();
  await (await choosingProject).setFiles({name:'renderer.geolibre.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  const review = page.getByRole('dialog', {name:'Review Project file',exact:true});
  await review.getByText('GeoLibre Project', {exact:false}).waitFor();
  await review.getByRole('button', {name:'Download conversion report',exact:true}).waitFor();
  assert.deepEqual(await readApi(mapPath), composition, 'Inspection leaves the saved map unchanged');
  assert.deepEqual(await readApi(`${base}/datasets`), beforeDatasets, 'Inspection creates no dataset');
  const [finalized] = await Promise.all([
    page.waitForResponse(r => r.url().includes(`${base}/imports`) &&
      (r.status() >= 400 || (r.url().endsWith('/finalize') && r.request().method()==='POST'))),
    review.getByRole('button', {name:'Open in this Project',exact:true}).click()
  ]).catch(async error => {throw new Error(`${error.message}; import status: ${await page.locator('.gis-statusbar').innerText()}`);});
  assert.equal(finalized.status(), 200, await finalized.text());
  const operation = await finalized.json();
  assert.equal(operation.state, 'completed');
  assert.equal(operation.source_version, '3.0.0');
  assert.equal(operation.items.length, 1);
  assert.equal(operation.items[0].state, 'bound');
  const saved = await readApi(mapPath);
  assert.equal(saved.version, composition.version + 1);
  assert.deepEqual(saved.definition.extensions.opengeoRenderer, {id:'cesium'});
  const layer = saved.definition.layers[0];
  assert.equal(layer.layerId, fixture.layers[0].id);
  assert.equal(layer.datasetId, operation.items[0].dataset_id);
  assert.equal(layer.sourceType, 'governed-dataset');
  assert.match(layer.datasetVersionId, /^[0-9a-f-]{36}$/);
  assert.ok(layer.objectId && !layer.objectId.startsWith('pending-import:'));
  assert.equal(JSON.stringify(saved.definition.layers).includes('"import:'), false);
  await worker();
  const dataset = await readApi(`${base}/datasets/${layer.datasetId}`);
  assert.equal(dataset.feature_count, fixture.layers[0].geojson.features.length);
  await page.evaluate(() => localStorage.clear());
  await openMap();
  await page.locator('.gis-layer-row', {hasText:fixture.layers[0].name}).waitFor();
  // Wait for actual inspected data before export, not merely the layer-list row.
  await page.waitForFunction(id => {
    const shell=document.querySelector('.opengeo-workbench');
    const map=shell?.__opengeoMap;
    return shell?.__opengeoData?.get(id)?.features?.length > 0 && map?.isStyleLoaded?.()
      && map.queryRenderedFeatures().some(feature => feature.layer?.id?.startsWith(`${id}-`));
  }, layer.layerId);
  await menu.locator('.gis-menu-button').click();
  await menu.getByRole('menuitem', {name:/^Save as \/ export…/}).click();
  const exportDialog = page.getByRole('dialog', {name:'Save as or export Project',exact:true});
  await exportDialog.getByRole('combobox', {name:'Project export format'}).selectOption('geolibre');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', {name:'Export file',exact:true}).click()
  ]).catch(async error => {throw new Error(`${error.message}; export status: ${await page.locator('.gis-statusbar').innerText()}`);});
  const bytes = await readFile(await download.path()), exported = JSON.parse(bytes);
  await exportDialog.getByRole('button', {name:'Close',exact:true}).click();
  assert.equal(exported.primaryRenderer, 'cesium');
  assert.equal(exported.layers[0].id, layer.layerId);
  assert.deepEqual(exported.layers[0].geojson.features, fixture.layers[0].geojson.features);
  assert.deepEqual(await readApi(mapPath), saved, 'Reopen and export leave the saved version unchanged');
  const denied = await apiRequest(`${base}/imports/${operation.import_id}`, {headers:{authorization:'Bearer synthetic-local-reviewer','x-opengeo-organization':organization}});
  assert.ok([403,404].includes(denied.status), 'Uninvited reviewer cannot read imported project records');
  await writeFile(join(work, 'geolibre-renderer-export.json'), bytes);
  return {projectId:project.id,mapId:composition.id,datasetId:dataset.id,importId:operation.import_id,
    sourceVersion:operation.source_version,mapVersion:saved.version,inspectWithoutWrites:true,
    actualDatasetAndObjectBound:true,reopenedFromApiWithoutBrowserDraft:true,rendererRetained:true,featureRendered:true,
    exportedFeatureCount:exported.layers[0].geojson.features.length,uninvitedReadStatus:denied.status,
    workerConversions:1,renderJobs:0,limits:'Real local API/PostgreSQL and worker; synthetic login and object/queue transport. No managed identity, AWS or upstream desktop acceptance.'};
}

export async function exerciseRendererPersistence({page, project, composition, origin, organization, worker, readApi, apiRequest}) {
  const base = `/projects/${project.id}`;
  const mapPath = `${base}/maps/${composition.id}`;
  const write = async (path, body, method = "POST", status = 201) => {
    const result = await apiRequest(path, {method, headers:{authorization:"Bearer synthetic-local-owner",
      "x-opengeo-organization":organization,"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal(result.status,status,result.body.toString());
    return JSON.parse(result.body);
  };
  await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);
  await page.getByRole("heading",{name:"Project datasets",exact:true}).waitFor();
  const data = {type:"FeatureCollection",features:[{type:"Feature",properties:{name:"Survey boundary"},geometry:{
    type:"Polygon",coordinates:[[[-72.5,42],[-72.4,42],[-72.4,42.1],[-72.5,42.1],[-72.5,42]]]
  }}]};
  await page.getByLabel("Dataset, image, or document file",{exact:true}).setInputFiles({
    name:"renderer-survey.geojson",mimeType:"application/geo+json",buffer:Buffer.from(JSON.stringify(data))});
  await page.getByLabel("Dataset, image, or document name",{exact:true}).fill("Renderer survey");
  await page.getByLabel("Dataset classification",{exact:true}).selectOption("internal");
  const completionResponse = page.waitForResponse(r=>r.url().endsWith("/complete")&&r.request().method()==="POST");
  await page.getByRole("button",{name:"Hash and upload",exact:true}).click();
  const response = await completionResponse;
  assert.equal(response.status(),200);
  const completion = await response.json();
  await worker(); // Exactly one managed conversion; no render/publication job.
  const dataset = await readApi(`${base}/datasets/${completion.dataset.id}`);
  assert.equal(dataset.status,"active"); assert.equal(dataset.feature_count,1);
  const resource = await write(`${base}/resources`,{kind:"dataset",slug:"renderer-survey",
    dataset_id:dataset.id,metadata:{title:"Renderer survey resource"}});
  const style = await write(`${base}/resources/${resource.id}/styles`,{
    slug:"survey-fill",title:"Survey red",format:"maplibre",definition:JSON.stringify({version:8,sources:{},layers:[
      {id:"survey",type:"fill",paint:{"fill-color":"#ff0000","fill-outline-color":"#ff0000","fill-opacity":1}}
    ]})});
  const reference = {projectId:project.id,resourceId:resource.id,styleId:style.id,
    versionNumber:style.version_number,format:style.format,checksumSha256:style.checksum_sha256};
  const layer = {layerId:"survey",datasetId:dataset.id,datasetVersionId:completion.dataset_version_id,
    sourceType:"governed-dataset",sourceVersion:1,title:"Renderer survey",geometryType:"Polygon",
    visible:true,opacity:0.6,order:0,style:{fill:"#0000ff"},labels:{enabled:false}};
  await write(mapPath,{expected_version:composition.version,definition:{...composition.definition,
    mapViews:[{id:"primary",title:"Survey",center:[-72.45,42.05],zoom:10,pitch:0,bearing:12}],
    activeLayerId:layer.layerId,layers:[layer],
    layerTree:[{kind:"group",id:"field-survey",title:"Field survey",children:[{kind:"layer",layerId:layer.layerId}]}]
  }},"PATCH",200);
  const openMap = async () => {
    await page.goto(`${origin}/workspaces?composition=${composition.id}`);
    await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.loaded());
  };
  await openMap();
  const row = page.locator('.gis-layer-row[data-layer-id="survey"]');
  await row.getByLabel("Layer actions for Renderer survey",{exact:true}).click();
  await row.getByRole("button",{name:"Style layer",exact:true}).click();
  await page.getByRole("button",{name:"Find Styles for this Layer",exact:true}).click();
  await page.getByRole("button",{name:"Styles in Renderer survey resource",exact:true}).click();
  await page.getByRole("button",{name:"Apply Survey red",exact:true}).click();
  const waitForStyle = () => page.waitForFunction(()=>{
    const map=document.querySelector('.opengeo-workbench')?.__opengeoMap;
    return map?.loaded() && map.getLayer('survey-style-0') && map.queryRenderedFeatures({layers:['survey-style-0']}).length>0;
  });
  await waitForStyle();
  const openRenderer = async () => {
    await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
    await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
  };
  await openRenderer();
  const panel = page.locator('.gis-renderer-panel');
  await panel.getByLabel('Mapbox public token').fill('pk.local-fixture.not-a-real-token');
  await panel.getByRole('button',{name:'Use Mapbox',exact:true}).click();
  await panel.getByText('Current: Mapbox',{exact:true}).waitFor();
  const save = async () => {
    const saved = page.waitForResponse(r=>r.url().endsWith(mapPath)&&r.request().method()==="PATCH");
    await page.getByRole('button',{name:'Save',exact:true}).click();
    const result = await saved; assert.equal(result.status(),200,await result.text());
    return result.json();
  };
  const saved = await save();
  assert.equal(saved.definition.extensions.opengeoRenderer.id,"mapbox");
  assert.deepEqual(saved.definition.layers[0].styleReference,reference);
  assert.equal(JSON.stringify(saved).includes('pk.local-fixture'),false);
  const readback = await readApi(mapPath);
  assert.deepEqual(readback.definition,saved.definition);
  // Reopening must read the API record rather than recover a local draft.
  await page.evaluate(()=>localStorage.clear());
  await openMap();
  await waitForStyle();
  const reopened = await page.evaluate(()=>{
    const view=document.querySelector('.opengeo-workbench'), map=view.__opengeoMap;
    return {reference:view.__opengeoLayers[0].styleReference,paint:map.getPaintProperty('survey-style-0','fill-color'),
      opacity:map.getPaintProperty('survey-style-0','fill-opacity'),features:map.queryRenderedFeatures({layers:['survey-style-0']}).length,
      camera:[map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing()]};
  });
  assert.deepEqual(reopened.reference,reference); assert.equal(reopened.paint,"#ff0000");
  assert.equal(reopened.opacity,0.6); assert.ok(reopened.features>0);
  assert.deepEqual(reopened.camera.map(value=>Number(value.toFixed(6))),[-72.45,42.05,10,12]);
  await openRenderer();
  await panel.getByText('Current: MapLibre',{exact:true}).waitFor();
  assert.equal(await panel.getByLabel('Mapbox public token').inputValue(),"");
  await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
  const reset = await save();
  assert.equal(reset.definition.extensions.opengeoRenderer.id,"maplibre");
  assert.deepEqual(reset.definition.layers,saved.definition.layers);
  assert.deepEqual(reset.definition.layerTree,saved.definition.layerTree);
  const forbidden = await apiRequest(mapPath,{headers:{authorization:"Bearer synthetic-local-reviewer","x-opengeo-organization":organization}});
  assert.ok([403,404].includes(forbidden.status),'Uninvited reviewer cannot read the Project');
  return {projectId:project.id,mapId:composition.id,datasetId:dataset.id,styleReference:reference,
    mapboxSavedVersion:saved.version,maplibreSavedVersion:reset.version,apiReadback:true,
    reopenedFromApiWithoutBrowserDraft:true,pinnedStyleRendered:true,opacity:reopened.opacity,
    folderRetained:true,camera:reopened.camera,tokenOmitted:true,uninvitedReadStatus:forbidden.status,
    workerConversions:1,renderJobs:0,limits:"Real local API/PostGIS and worker; synthetic identity/cloud transport and intercepted Mapbox authorization. No production account or provider acceptance."};
}
