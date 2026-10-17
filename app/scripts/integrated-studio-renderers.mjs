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
  const handoff = await exerciseReviewedGeoLibreReturn({page, project, composition, saved, layer,
    fixture, origin, worker, readApi, work});
  const denied = await apiRequest(`${base}/imports/${operation.import_id}`, {headers:{authorization:'Bearer synthetic-local-reviewer','x-opengeo-organization':organization}});
  assert.ok([403,404].includes(denied.status), 'Uninvited reviewer cannot read imported project records');
  await writeFile(join(work, 'geolibre-renderer-export.json'), bytes);
  return {projectId:project.id,mapId:composition.id,datasetId:dataset.id,importId:operation.import_id,
    sourceVersion:operation.source_version,mapVersion:saved.version,inspectWithoutWrites:true,
    actualDatasetAndObjectBound:true,reopenedFromApiWithoutBrowserDraft:true,rendererRetained:true,featureRendered:true,
    exportedFeatureCount:exported.layers[0].geojson.features.length,uninvitedReadStatus:denied.status,
    handoff,workerConversions:2,renderJobs:0,limits:'Real local API/PostgreSQL and worker; synthetic login, returned analysis file and object/queue transport. No managed identity, AWS, upstream analysis execution or desktop acceptance.'};
}

async function exerciseReviewedGeoLibreReturn({page, project, composition, saved, layer, fixture, origin, worker, readApi, work}) {
  const base = `/projects/${project.id}`, mapPath = `${base}/maps/${composition.id}`;
  const menu = page.locator('.gis-menu-wrap[data-menu="project"]');
  await menu.locator('.gis-menu-button').click();
  await menu.getByRole('menuitem', {name:/^Save as \/ export…/}).click();
  await page.getByRole('dialog', {name:'Save as or export Project',exact:true})
    .getByRole('button', {name:'Open in GeoLibre…',exact:true}).click();
  const instructions = page.getByRole('dialog', {name:'Open in GeoLibre',exact:true});
  const externalLink = instructions.getByRole('link', {name:'Open GeoLibre workbench',exact:true});
  const workbenchUrl = new URL(await externalLink.getAttribute('href'));
  assert.equal(workbenchUrl.origin, 'https://web.geolibre.app');
  assert.equal(workbenchUrl.search, '', 'The external link carries no Project or token');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    instructions.getByRole('button', {name:'Download saved revision',exact:true}).click()
  ]);
  const handoffBytes = await readFile(await download.path()), returned = JSON.parse(handoffBytes);
  assert.equal(returned.metadata.opengeo.handoff.projectId, project.id);
  assert.equal(returned.metadata.opengeo.handoff.mapId, composition.id);
  assert.equal(returned.metadata.opengeo.handoff.mapVersion, saved.version);
  assert.match(returned.metadata.opengeo.handoff.definitionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(returned.layers[0].geojson.features, fixture.layers[0].geojson.features);
  assert.deepEqual(await readApi(mapPath), saved, 'Handoff download does not save or replace the map');
  await instructions.getByRole('button', {name:'Close',exact:true}).click();

  // Exercise the external file boundary without claiming execution of upstream
  // GeoLibre or one of its analysis tools. The original input remains unchanged;
  // a separate synthetic result carries explicitly reported fixture parameters.
  const output = structuredClone(returned.layers[0]);
  output.id = 'reviewed-analysis-output';
  output.name = 'Reviewed analysis output';
  output.metadata = {license:'CC0-1.0', processingHistory:[{
    tool:'synthetic-point-translation', parameters:{longitudeOffset:0.01},
    execution:'local integration fixture; not upstream GeoLibre analysis'
  }]};
  output.style.fillColor = '#f97316';
  output.geojson.features[0].geometry.coordinates[0] += 0.01;
  output.geojson.features[0].properties.name = 'Reviewed result point';
  output.geojson.features[0].properties.output = true;
  returned.layers.push(output);
  const returnedBytes = Buffer.from(JSON.stringify(returned));
  const beforeDatasets = await readApi(`${base}/datasets`);
  await menu.locator('.gis-menu-button').click();
  const choosingProject = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', {name:/^Open Project file…/}).click();
  await (await choosingProject).setFiles({name:'reviewed-results.geolibre.json',mimeType:'application/json',buffer:returnedBytes});
  const review = page.getByRole('dialog', {name:'Review GeoLibre results',exact:true});
  await review.getByText('1 unchanged Layers reuse their existing identities.', {exact:true}).waitFor();
  await review.getByText(/not declared reproducible analyses/).waitFor();
  assert.deepEqual(await readApi(mapPath), saved, 'Return inspection does not save the map');
  assert.deepEqual(await readApi(`${base}/datasets`), beforeDatasets, 'Return inspection creates no dataset');
  const inputs = review.locator('select[multiple]');
  assert.equal(await inputs.count(), 1);
  assert.deepEqual(await inputs.locator('option:checked').evaluateAll(options => options.map(option => option.value)), []);
  await inputs.selectOption(layer.layerId);
  const [finalized] = await Promise.all([
    page.waitForResponse(response => response.url().includes(`${base}/imports`) &&
      (response.status() >= 400 || response.url().endsWith('/finalize') && response.request().method() === 'POST')),
    review.getByRole('button', {name:'Save results to OpenGeo',exact:true}).click()
  ]).catch(async error => {throw new Error(`${error.message}; return review: ${await review.textContent().catch(() => '')}`);});
  assert.equal(finalized.status(), 200, await finalized.text());
  const operation = await finalized.json();
  assert.equal(operation.state, 'completed');
  assert.equal(operation.items.length, 1, 'Only the new output is registered; unchanged input bytes are reused');
  assert.match(operation.items[0].import_ref, /^geolibre:return:[a-f0-9]{64}$/);
  const result = await readApi(mapPath);
  assert.equal(result.version, saved.version + 1);
  assert.equal(result.definition.layers.length, 2);
  assert.deepEqual(result.definition.layers.find(candidate => candidate.layerId === layer.layerId), layer,
    'The original Layer and exact managed version remain unchanged');
  const savedOutput = result.definition.layers.find(candidate => candidate.layerId !== layer.layerId);
  assert.match(savedOutput.layerId, /^geolibre-result-/);
  assert.equal(savedOutput.datasetId, operation.items[0].dataset_id);
  assert.notEqual(savedOutput.datasetId, layer.datasetId);
  assert.equal(savedOutput.sourceType, 'governed-dataset');
  assert.match(savedOutput.datasetVersionId, /^[0-9a-f-]{36}$/);
  assert.equal(savedOutput.style.circleColor, '#f97316');
  const lineage = result.definition.extensions.opengeoGeoLibreReturn;
  assert.equal(lineage.base.mapVersion, saved.version);
  assert.deepEqual(lineage.inputs, [{layerId:layer.layerId,datasetId:layer.datasetId,datasetVersionId:layer.datasetVersionId}]);
  assert.equal(lineage.outputs.length, 1);
  assert.deepEqual(lineage.outputs[0].inputLayerIds, [layer.layerId]);
  assert.equal(lineage.outputs[0].inputLinkMethod, 'user-declared');
  assert.equal(lineage.outputs[0].datasetId, savedOutput.datasetId);
  assert.equal(lineage.outputs[0].datasetVersionId, savedOutput.datasetVersionId);
  assert.equal(lineage.outputs[0].reproducible, false);
  assert.deepEqual(result.definition.extensions.geolibre.project.layers.find(candidate => candidate.id === output.id).metadata.processingHistory,
    output.metadata.processingHistory);
  await worker();
  const outputDataset = await readApi(`${base}/datasets/${savedOutput.datasetId}`);
  assert.equal(outputDataset.feature_count, 1);
  assert.equal((await readApi(`${base}/datasets`)).length, beforeDatasets.length + 1);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${origin}/workspaces?composition=${composition.id}`);
  await page.waitForFunction(ids => {
    const shell = document.querySelector('.opengeo-workbench'), map = shell?.__opengeoMap;
    return ids.every(id => shell?.__opengeoData?.get(id)?.features?.length === 1 && map?.isStyleLoaded?.()
      && map.queryRenderedFeatures().some(feature => feature.layer?.id?.startsWith(`${id}-`)));
  }, [layer.layerId, savedOutput.layerId]);
  const reopenedData = await page.evaluate(id => document.querySelector('.opengeo-workbench').__opengeoData.get(id), savedOutput.layerId);
  assert.deepEqual(reopenedData.features, output.geojson.features);
  assert.deepEqual(await readApi(mapPath), result, 'Fresh reopen keeps the saved result revision exact');
  await writeFile(join(work, 'geolibre-saved-handoff.json'), handoffBytes);
  await writeFile(join(work, 'geolibre-returned-results.json'), returnedBytes);
  return {baseMapVersion:saved.version,resultMapVersion:result.version,outputLayerId:savedOutput.layerId,
    outputDatasetId:savedOutput.datasetId,importId:operation.import_id,inspectedWithoutWrites:true,
    unchangedInputReused:true,userDeclaredInputLink:true,originalDataPreserved:true,reopenedOutputRendered:true,
    processingHistoryPreserved:true,reproducible:false,externalAnalysisExecution:'synthetic returned file only; no upstream GeoLibre runtime'};
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
