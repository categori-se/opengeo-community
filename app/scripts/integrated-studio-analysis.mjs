import assert from 'node:assert/strict';

// Shared runner supplies real API/database/worker; only identity and cloud transport are synthetic.
export async function exerciseStudioAnalysis({page, project, composition, origin, organization, worker, readApi, apiRequest}) {
  const write = async (path, method, body, expected) => {
    const response = await apiRequest(path, {method, headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization, 'content-type':'application/json'}, body:JSON.stringify(body)});
    assert.equal(response.status, expected, response.body.toString());
    return JSON.parse(response.body);
  };
  const features = [{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-72,42],[-71.9,42],[-71.9,42.1],[-72,42.1],[-72,42]]]}}];
  await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);
  await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles({name:'analysis-input.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features}))});
  await page.getByLabel('Dataset, image, or document name',{exact:true}).fill('Analysis input');
  const uploaded = page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Hash and upload',exact:true}).click();
  const uploadResponse=await uploaded;assert.equal(uploadResponse.status(),200);
  const source=await uploadResponse.json();
  await worker();
  const collection=await write(`/projects/${project.id}/datasets/${source.dataset.id}/feature-collection`,'POST',{geometry_type:'Polygon',fields:[],features},201);
  const definition=structuredClone(composition.definition);
  definition.layers=[{layerId:'analysis-source',datasetId:source.dataset.id,title:'Analysis input',sourceType:'governed-dataset',geometryType:'Polygon',visible:true,opacity:1,order:0,style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}}];
  definition.activeLayerId='analysis-source';
  await write(`/projects/${project.id}/maps/${composition.id}`,'PATCH',{expected_version:composition.version,definition,change_message:'Local analysis fixture'},200);
  const mapUrl=`${origin}/workspaces?project=${project.id}&composition=${composition.id}`;
  await page.goto(`${mapUrl}&panel=processing`);
  await page.getByRole('button',{name:'Preview analysis',exact:true}).waitFor();
  if (process.env.OPENGEO_ANALYSIS_CANCEL_ONLY === '1') {
    let release;
    let observed;
    let finished;
    const held = new Promise(resolve=>{release=resolve;});
    const received = new Promise(resolve=>{observed=resolve;});
    const drained = new Promise(resolve=>{finished=resolve;});
    const routePattern = '**/analysis-preview';
    const handler = async route => {
      try {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        observed();
        await held;
        await route.fulfill({response});
      } finally {finished();}
    };
    await page.route(routePattern, handler);
    try {
      const failed = page.waitForEvent('requestfailed', {predicate:r=>r.url().endsWith('/analysis-preview')});
      await page.getByRole('button', {name:'Preview analysis', exact:true}).click();
      await received;
      await page.getByRole('button', {name:'Cancel preview', exact:true}).click();
      const aborted = await failed;
      assert.match(aborted.failure().errorText, /ABORTED|CANCELLED/i);
      release();
      await drained;
      await page.getByText('Preview cancelled. Server computation may continue until its five-second statement limit.', {exact:true}).waitFor();
      assert.equal(await page.getByRole('button', {name:'Add preview to map', exact:true}).count(), 0);
      assert.equal(await page.getByRole('button', {name:'Save as catalog Layer', exact:true}).count(), 0);
      await page.unroute(routePattern, handler);
      const retried = page.waitForResponse(r=>r.url().endsWith('/analysis-preview'));
      await page.getByRole('button', {name:'Preview analysis', exact:true}).click();
      assert.equal((await retried).status(), 200);
      await page.getByRole('button', {name:'Add preview to map', exact:true}).waitFor();
      return {mode:'browser-cancellation-only', browserRequestAborted:true, delayedResponseDiscarded:true,
        retryProducesUsablePreview:true, transport:'Actual API response held by Playwright; direct database cancellation separately accepted',
        notProven:['Browser disconnect propagation through production proxy or RDS Data API']};
    } finally {release(); await page.unroute(routePattern, handler);}
  }
  if (process.env.OPENGEO_ANALYSIS_CONTROLS_ONLY === '1') {
    const outcomes = [];
    for (const operation of ['measure', 'join-summary', 'select-by-location', 'clip', 'intersection']) {
      await page.getByLabel('Operation', {exact:true}).selectOption(operation);
      const paired = operation !== 'measure';
      assert.equal(await page.getByLabel('Target layer', {exact:true}).count(), paired ? 1 : 0);
      const pending = page.waitForResponse(r=>r.url().endsWith('/analysis-preview'));
      await page.getByRole('button', {name:'Preview analysis', exact:true}).click();
      const response = await pending;
      assert.equal(response.status(), 200);
      const body = await response.json();
      const request = response.request().postDataJSON();
      assert.equal(request.operation, operation);
      assert.equal(request.source_generation, collection['opengeo:collection'].generation);
      if (paired) assert.equal(request.target_dataset_id, source.dataset.id);
      assert.equal(body.features.length, 1);
      // Waiting for these controls also proves the built API client accepted the receipt.
      await page.getByText('1 result features ready. Nothing has been saved.', {exact:true}).waitFor();
      await page.getByRole('button', {name:'Save as catalog Layer', exact:true}).waitFor();
      outcomes.push({operation, receipt:body['opengeo:analysis'], features:body.features.length});
    }
    await page.getByRole('button', {name:'Add preview to map', exact:true}).click();
    await page.getByText('Added a temporary result. It has not been registered as a catalog Layer.', {exact:true}).waitFor();
    const scratch = await page.evaluate(() => {
      const shell = document.querySelector('.opengeo-workbench');
      const layer = shell.__opengeoLayers.find(layer=>layer.title.includes('intersection preview'));
      return layer && {datasetId:layer.datasetId, count:shell.__opengeoData.get(layer.layerId)?.features.length};
    });
    assert.equal(scratch?.datasetId, null);
    assert.equal(scratch.count, 1);
    return {mode:'changed-controls-only', outcomes, temporaryOutputHasNoDatasetIdentity:true,
      reusedPersistenceEvidence:'geolens-006.studio-derived-layer'};
  }
  const previewResponse=page.waitForResponse(r=>r.url().endsWith('/analysis-preview'));
  await page.getByRole('button',{name:'Preview analysis',exact:true}).click();
  const response=await previewResponse;assert.equal(response.status(),200);
  const preview=await response.json();assert.equal(preview.features.length,1);
  assert.equal(preview['opengeo:analysis'].source_generation,collection['opengeo:collection'].generation);
  await page.getByLabel('Derived Layer title',{exact:true}).fill('Saved analysis centroid');
  await page.getByLabel('Attribution',{exact:true}).fill('Local analysis fixture');
  const registered=page.waitForResponse(r=>/\/datasets\/[^/]+\/metadata$/.test(new URL(r.url()).pathname)&&r.request().method()==='PUT');
  await page.getByRole('button',{name:'Save as catalog Layer',exact:true}).click();
  const metadataResponse=await registered;assert.equal(metadataResponse.status(),200);
  const metadata=await metadataResponse.json();
  const outputId=new URL(metadataResponse.url()).pathname.split('/').at(-2);
  assert.notEqual(outputId,source.dataset.id);
  assert.equal(metadata.document.distributions[0].custody,'derived');
  assert.equal(metadata.document.context[0].resourceId,`urn:opengeo:dataset:${source.dataset.id}:generation:${collection['opengeo:collection'].generation}`);
  const license=metadata.document.metadata.curated.find(item=>item.property.endsWith('/license'));
  assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
  await page.getByText('Derived Layer and lineage registered. Processing is queued; catalog assignment to a map remains separate.',{exact:true}).waitFor();
  await worker();
  const saved=await readApi(`/projects/${project.id}/datasets/${outputId}`);
  assert.equal(saved.status,'active');assert.equal(saved.feature_count,1);
  await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);
  const card=page.locator(`[data-dataset-id="${outputId}"]`);
  await card.getByText('Add to map…',{exact:true}).click();
  await card.getByRole('link',{name:'Add to Watershed review map',exact:true}).click();
  await page.getByRole('button',{name:'Add Saved analysis centroid to map',exact:true}).click();
  // A deliberate blank basemap makes local rendering independent of provider traffic.
  await page.locator('button[aria-label="Change basemap"]').click();
  const basemapDialog=page.getByRole('dialog',{name:'Change basemap',exact:true});
  const blank=basemapDialog.locator('.gis-basemap-card[data-catalog-id="blank"]');
  const group=blank.locator('xpath=ancestor::details[1]');
  if(await group.getAttribute('open')===null) await group.locator('summary').click();
  await blank.click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.basemapActivationState==='active');
  await basemapDialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForFunction(id=>{
    const shell=document.querySelector('.opengeo-workbench');
    const layer=shell?.__opengeoLayers?.find(layer=>layer.datasetId===id);
    return shell?.__opengeoData?.get(layer?.layerId)?.features.length===1;
  },outputId);
  await page.getByRole('button',{name:'Fit',exact:true}).click();
  const rendered = id => {
    const shell=document.querySelector('.opengeo-workbench');
    const map=shell?.__opengeoMap;
    const layer=shell?.__opengeoLayers?.find(layer=>layer.datasetId===id);
    if(!map?.isStyleLoaded() || map.isMoving() || !layer) return false;
    return map.queryRenderedFeatures().some(feature=>feature.geometry.type==='Point' && feature.layer.id.startsWith(layer.layerId));
  };
  await page.waitForFunction(rendered,outputId);
  const savedMap=page.waitForResponse(r=>r.url().endsWith(`/maps/${composition.id}`)&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await savedMap).status(),200);
  await page.reload();
  await page.waitForFunction(id=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.some(layer=>layer.datasetId===id),outputId);
  await page.waitForFunction(rendered,outputId);
  const reopened=await readApi(`/datasets/${outputId}/metadata`);
  assert.deepEqual(reopened.document,metadata.document);
  return {sourceDatasetId:source.dataset.id,derivedDatasetId:outputId,preview:true,reviewedCatalogRegistration:true,
    workerProcessed:true,catalogAssigned:true,derivedPointRendered:true,savedProjectReopened:true,reopenedPointRendered:true,lineageReopened:true,unknownDistributionLicensePreserved:true};
}
