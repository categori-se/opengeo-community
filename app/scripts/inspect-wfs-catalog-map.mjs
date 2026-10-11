import assert from 'node:assert/strict';

export async function inspectWfsCatalogMap(page, origin, datasetId, requests) {
  const before=requests.length;
  await page.goto(`${origin}/workspaces?view=data`);
  await page.getByLabel('Catalog entries',{exact:true}).selectOption('layers');
  await page.getByRole('button',{name:'Search catalog',exact:true}).click();
  const row=page.locator(`.layer-catalog-entry[data-dataset-id="${datasetId}"]`).first();
  await page.getByRole('button',{name:'Expand groups',exact:true}).click();
  await row.locator('.catalog-layer-toggle').click();
  const detail=page.locator('#'+await row.locator('.catalog-layer-toggle').getAttribute('aria-controls'));
  await detail.getByRole('button',{name:'Open map',exact:true}).click();
  await detail.getByText('Temporary Layer view.',{exact:false}).waitFor();
  await detail.getByText('Layer view ready.',{exact:false}).waitFor();
  await detail.getByText('One bounded WFS display page in CRS84.',{exact:false}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('project'),null);
  const center=await detail.locator('.map-frame').evaluate(node=>node.__view().center);
  assert.ok(Math.abs(center[0]+71.2)<0.001&&Math.abs(center[1]-42.3)<0.001);
  await detail.locator('.map-frame').screenshot({path:'/tmp/opengeo-wfs-catalog-preview.png'});
  assert.equal(requests.slice(before).filter(r=>r.method!=='GET').length,0,'Inspecting must not write');
  await detail.getByRole('button',{name:'Save to Project…',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(requests.slice(before).filter(r=>r.method!=='GET').length,0,'Cancelling must not write');
  await detail.getByRole('button',{name:'Save to Project…',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('New Project title',{exact:true}).fill('WFS catalog reuse');
  const response=page.waitForResponse(r=>/\/projects\/[^/]+\/maps$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  const saved=await (await response).json();
  await dialog.getByRole('link',{name:'Open saved Project',exact:true}).waitFor();
  assert.equal(saved.definition.layers.length,1);
  const layer=saved.definition.layers[0];
  assert.equal(layer.datasetId,datasetId);assert.equal(layer.sourceVersion,1);
  assert.equal(layer.sourceType,'external-feature-reference');
  assert.equal(layer.sourceConfiguration.typeName,'public:facilities');
  await dialog.getByRole('link',{name:'Open saved Project',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.queryRenderedFeatures().some(f=>f.properties?.facility_id===1),null,{timeout:20000});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.queryRenderedFeatures().some(f=>f.properties?.facility_id===1),null,{timeout:20000});
  const writes=requests.slice(before).filter(r=>r.method!=='GET');
  assert.equal(writes.length,1);assert.equal(writes[0].status,201);
  return {temporaryPreview:true,previewCenter:center,cancelDoesNotWrite:true,explicitProjectCreated:true,
    projectId:saved.id,layerDatasetId:layer.datasetId,sourceRevision:layer.sourceVersion,
    sourceConfiguration:layer.sourceConfiguration,renderedAndReopened:true,writes:writes.length,
    screenshot:'/tmp/opengeo-wfs-catalog-preview.png'};
}
