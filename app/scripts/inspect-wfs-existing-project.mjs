import assert from 'node:assert/strict';

export async function inspectWfsExistingProject(page,origin,datasetId,requests,target,setActor){
  const before=requests.length;
  await page.goto(`${origin}/workspaces?view=data`);
  await page.getByLabel('Catalog entries',{exact:true}).selectOption('layers');
  await page.getByRole('button',{name:'Search catalog',exact:true}).click();
  await page.getByRole('button',{name:'Expand groups',exact:true}).click();
  const row=page.locator(`.layer-catalog-entry[data-dataset-id="${datasetId}"]`).first();
  await row.locator('.catalog-layer-toggle').click();
  const detail=page.locator('#'+await row.locator('.catalog-layer-toggle').getAttribute('aria-controls'));
  await detail.getByRole('button',{name:'Open map',exact:true}).click();
  await detail.getByText('Layer view ready.',{exact:false}).waitFor();
  const openSave=async()=>{
    await detail.getByRole('button',{name:'Save to Project…',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Search Projects',{exact:true}).fill('Existing WFS destination');
    await dialog.getByRole('button',{name:'Find Projects',exact:true}).click();
    await dialog.getByLabel('Destination',{exact:true}).selectOption(target.id);
    return dialog;
  };
  const snapshots=[];
  page.on('response',async response=>{
    if(new URL(response.url()).pathname===`/api/compositions/${target.id}`&&response.status()===200)snapshots.push(await response.json());
  });
  for(const actor of ['editor','no-source']){
    const dialog=await openSave();setActor(actor);
    const denied=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes(`/projects/${target.accessContainerId}/datasets/${datasetId}`));
    await dialog.getByRole('button',{name:'Save',exact:true}).click();
    assert.equal((await denied).status(),403);
    await dialog.getByText('The Project could not be saved.',{exact:false}).waitFor();
    setActor(null);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await detail.getByText('Layer view ready.',{exact:false}).waitFor();
  }
  const dialog=await openSave();
  const result=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname.endsWith(`/maps/${target.id}`));
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  const saved=await (await result).json();
  await dialog.getByRole('link',{name:'Open saved Project',exact:true}).waitFor();
  assert.ok(snapshots.length>=3);
  for(const snapshot of snapshots){assert.equal(snapshot.version,target.version);assert.deepEqual(snapshot.definition,target.definition);}
  const expected=structuredClone(target.definition);
  const added=saved.definition.layers.find(layer=>layer.datasetId===datasetId);
  assert.ok(added);assert.equal(added.order,6);assert.equal(added.sourceVersion,1);
  expected.layers.push(added);expected.activeLayerId=added.layerId;
  assert.deepEqual(saved.definition,expected);assert.equal(saved.version,target.version+1);
  await dialog.getByRole('link',{name:'Open saved Project',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.queryRenderedFeatures().some(f=>f.properties?.facility_id===1),null,{timeout:20000});
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.queryRenderedFeatures().some(f=>f.properties?.facility_id===1),null,{timeout:20000});
  const writes=requests.slice(before).filter(r=>r.method!=='GET');
  assert.equal(writes.length,4);assert.equal(writes.filter(r=>r.status===403).length,2);
  assert.equal(writes.filter(r=>r.method==='POST').length,0);
  return {targetId:target.id,sourceDatasetId:datasetId,existingDefinitionPreserved:true,
    destinationViewerDenied:true,sourceSharingDenied:true,deniedSavesPreservedPreview:true,
    successfulLinks:1,successfulMapUpdates:1,renderedAndReopened:true,creates:0};
}
