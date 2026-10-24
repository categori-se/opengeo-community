import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyBuildingReviewArchive} from '../src/lib/buildingReviewArchive.js';
import {verifyReceptorScreeningArchive} from '../src/lib/receptorScreeningArchive.js';
import {rasterAnalysisEvidence,verifyRasterAnalysisArchive} from '../src/lib/rasterAnalysisArchive.js';
import {parseExternalSource,parseExternalSourceRevision} from '../src/lib/apiClient.js';

export function assertBuildingInputPreviewRequest({path, method, progress}) {
  if (['GET', 'HEAD'].includes(method)) return;
  assert.ok(method === 'POST' && progress.allowedDownloadPaths?.includes(path),
    'Retained input preview permits only reads and exact admitted original download tickets');
}

// Inspect existing Layers without replaying successful registration or Project writes.
export async function exerciseBuildingInputPreview({page, origin, work, readApi, progress, profile, checkpoint}) {
  assert.notEqual(progress.status, 'pass', 'Do not replay accepted input previews');
  const originalReceipt = readFileSync(join(work, 'building-review-progress.json'));
  assert.equal(createHash('sha256').update(originalReceipt).digest('hex'), profile.acceptedBuildingReceiptSha256);
  const mapPath = `/projects/${progress.projectId}/maps/${progress.mapId}`;
  const before = await readApi(mapPath);
  assert.deepEqual(before, profile.map, 'Inspect the retained map head without changing it');
  const admitted = [];
  for (const key of ['source', 'comparison']) {
    const record = progress.records[key];
    const versions = await readApi(`/projects/${progress.projectId}/datasets/${record.datasetId}/versions?limit=100&offset=0`);
    const version = versions.find(value => value.id === record.datasetVersionId);
    assert.equal(version?.state, 'active');
    const originals = version.objects.filter(value => value.role === 'original');
    assert.equal(originals.length, 1);
    const object = originals[0];
    assert.equal(object.checksum_sha256, record.checksumSha256);
    assert.equal(object.size_bytes, record.sizeBytes);
    admitted.push(`/projects/${progress.projectId}/datasets/${record.datasetId}/versions/${record.datasetVersionId}/objects/${object.id}/download`);
  }
  checkpoint({phase: 'inspect-retained-catalog-inputs', allowedDownloadPaths: admitted});
  const previews = [];
  for (const key of ['source', 'comparison']) {
    const record = progress.records[key];
    await page.goto(`${origin}/workspaces?view=data`);
    await page.getByLabel('Search organization datasets', {exact: true}).fill(record.title);
    await page.getByRole('button', {name: 'Search catalog', exact: true}).click();
    const row = page.locator(`.platform-catalog-resource-row[data-dataset-id="${record.datasetId}"]`);
    await row.getByRole('button', {name: 'Open map', exact: true}).click();
    const panel = page.locator('.catalog-layer-preview');
    await panel.waitFor();
    await page.waitForFunction(async count => {
      const frame = document.querySelector('.catalog-layer-preview .map-frame'), map = frame?.__opengeoMap;
      const data = await map?.getSource('preview')?.getData();
      return map?.isStyleLoaded() && !map.isMoving() && data?.features?.length === count
        && map.queryRenderedFeatures().some(feature => feature.geometry.type === 'Polygon' && feature.layer.id.startsWith('preview'));
    }, key === 'source' ? 2 : 1);
    const data = await panel.locator('.map-frame').evaluate(frame => frame.__opengeoMap.getSource('preview').getData());
    const bytes = Buffer.from(JSON.stringify(data));
    // The managed reader verifies exact original bytes; this checks every original feature after rendering.
    const issued = JSON.parse(readFileSync(join(work, 'issued-downloads.json')));
    const ticket = Object.values(issued).find(value => value.checksum_sha256 === record.checksumSha256);
    assert.ok(ticket, 'The selected original must have passed its exact authorized download');
    const reads = (progress.exactOriginalReadbacks ?? 0) + 1;
    const readBytes = (progress.exactOriginalReadbackBytes ?? 0) + record.sizeBytes;
    assert.ok(reads <= profile.maximumOriginalReadbacks && readBytes <= profile.maximumOriginalReadbackBytes);
    checkpoint({exactOriginalReadbacks: reads, exactOriginalReadbackBytes: readBytes,
      directVerificationReadbacks: (progress.directVerificationReadbacks ?? 0) + 1});
    const originalBytes = readFileSync(join(work, 'objects', ticket.version_id));
    assert.equal(originalBytes.length, record.sizeBytes);
    assert.equal(createHash('sha256').update(originalBytes).digest('hex'), record.checksumSha256);
    const original = JSON.parse(originalBytes);
    assert.deepEqual(data.features, original.features);
    assert.equal(await page.locator('.opengeo-workbench').count(), 0, 'Catalog inspection stays in its temporary map');
    assert.equal(await panel.getByRole('button', {name: /Save/}).count(), 0);
    await panel.screenshot({path: join(work, `building-input-preview-${key}.png`)});
    previews.push({key, datasetId: record.datasetId, datasetVersionId: record.datasetVersionId,
      features: data.features.length, completeOriginalFeaturesMatched: true, renderedPolygonPixels: true,
      temporarySelectedLayerOnly: true, renderedCollectionBytes: bytes.length});
  }
  assert.deepEqual(await readApi(mapPath), before, 'Catalog inspection must preserve the saved composition and version');
  assert.deepEqual(readFileSync(join(work, 'building-review-progress.json')), originalReceipt);
  checkpoint({phase: 'accepted-retained-building-input-preview', previews, savedMapUnchanged: true});
  return {previews, savedMapUnchanged: true, acceptedReceiptUnchanged: true, providerRequests: 0,
    writes: 0, workerBatches: 0, notProven: ['Provider retrieval, rights or accuracy', 'Production/public delivery', 'Full BI-02 completion']};
}

// A finite account-backed acceptance phase in the maintained local runner.
// Synthetic inventories establish persistence and review behavior, not accuracy.
export async function exerciseBuildingReview({page, origin, organization, work, readApi, apiRequest, worker, progress, checkpoint}) {
  const mark = update => checkpoint(update), keys = ['source', 'comparison'];
  const id = value => `98000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const polygon = (value, west, name) => ({type:'Feature', id:id(value),
    properties:{name, confidence:null}, geometry:{type:'Polygon', coordinates:[[
      [west,42], [Number((west+.001).toFixed(6)),42], [Number((west+.001).toFixed(6)),42.001], [west,42.001], [west,42]
    ]]}});
  const inputs = {source:[polygon(1,-72,'Synthetic source A'),polygon(2,-71.997,'Synthetic source B')],
    comparison:[polygon(3,-72,'Synthetic comparison A')]};
  const names = {source:'Synthetic building source inventory',comparison:'Synthetic building comparison inventory'};
  const records = progress.records ??= {};
  const write = async (path, method, body, expected=200) => {
    const response=await apiRequest(path,{method,headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,expected,`${path}: ${response.body}`);return JSON.parse(response.body);
  };
  if(!progress.projectId){
    assert.ok(!progress.creationAttempted,'Reconcile the retained Project creation before another write');
    mark({phase:'create-synthetic-project',creationAttempted:true});
    await page.goto(`${origin}/workspaces`);await page.getByRole('link',{name:/New Project/}).click();
    await page.getByLabel('New project name',{exact:true}).fill('Synthetic building review acceptance');
    await page.getByLabel('First map name',{exact:true}).fill('Reviewed building inventory');
    const created=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.request().method()==='POST'),
      mapped=page.waitForResponse(response=>/\/api\/projects\/[^/]+\/maps$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Create project and map',exact:true}).click();
    assert.equal((await created).status(),201);assert.equal((await mapped).status(),201);
  }
  assert.ok(progress.projectId,'Use the committed Project identity retained by the API proxy');
  if(!progress.mapId){
    const maps=await readApi(`/projects/${progress.projectId}/maps`);assert.equal(maps.length,1);
    mark({mapId:maps[0].id,map:maps[0]});
  }
  const projectId=progress.projectId,mapId=progress.mapId,mapPath=`/projects/${projectId}/maps/${mapId}`,
    mapUrl=`${origin}/workspaces?project=${projectId}&composition=${mapId}`,
    datasetPath=key=>`/projects/${projectId}/datasets/${records[key].datasetId}`;
  for(const key of keys){
    const record=records[key]??={}, bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:inputs[key]}));
    Object.assign(record,{filename:`building-${key}.geojson`,title:names[key],sizeBytes:bytes.length,
      checksumSha256:createHash('sha256').update(bytes).digest('hex')});mark({records,currentRecord:key});
    if(record.uploadCompleted)continue;
    assert.ok(!record.uploadAttempted&&!record.ticketAttempted,'Reconcile the retained upload before any new transfer');
    await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);
    await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles({name:record.filename,mimeType:'application/geo+json',buffer:bytes});
    await page.getByLabel('Dataset, image, or document name',{exact:true}).fill(record.title);
    await page.getByLabel('Dataset classification',{exact:true}).selectOption('restricted');
    const completed=page.waitForResponse(response=>response.url().endsWith('/complete')&&response.request().method()==='POST');
    record.uploadAttempted=true;mark({phase:`upload-${key}`,records});
    await page.getByRole('button',{name:'Hash and upload',exact:true}).click();assert.equal((await completed).status(),200);
    assert.ok(record.uploadCompleted&&record.datasetId&&record.datasetVersionId,'Checkpoint the upload response before navigation');
  }
  async function processBatch(batch, batchKeys) {
    const active = dataset => dataset.status==='active'&&dataset.current_version_state==='active'&&dataset.processing_job_state==='completed';
    let datasets=await Promise.all(batchKeys.map(key=>readApi(datasetPath(key))));
    if(!datasets.every(active)){
      assert.ok(!progress[`${batch}WorkerAttempted`],'Reconcile the previously attempted worker; do not replay jobs');
      const queue=JSON.parse(readFileSync(join(work,'queue.json'),'utf8'));
      assert.equal(queue.length,batchKeys.length,'Only admitted building ingestion messages may run');
      const seen=new Set();
      for(const message of queue){const entries=JSON.parse(message.body).Records;assert.equal(entries.length,1);
        const key=batchKeys.find(key=>entries[0].s3?.object?.key.includes(`/datasets/${records[key].datasetId}/`));
        assert.ok(key&&!seen.has(key),'Reject unrelated or duplicate ingestion messages');seen.add(key);}
      mark({phase:`ingest-${batch}`,[`${batch}WorkerAttempted`]:true,workerBatch:batch});await worker(45_000);
      datasets=await Promise.all(batchKeys.map(key=>readApi(datasetPath(key))));
    }
    assert.ok(datasets.every(active),'Every admitted exact version must finish ingestion');
    for(const [index,key] of batchKeys.entries()){
      assert.equal(datasets[index].current_version_id,records[key].datasetVersionId);
      assert.equal(datasets[index].classification,'restricted');assert.equal(datasets[index].feature_count,key==='output'?2:inputs[key].length);
    }
    mark({[`${batch}WorkerCompleted`]:true});
  }
  if(!progress.inputsWorkerCompleted)await processBatch('inputs',keys);
  for(const key of keys){
    const record=records[key];mark({currentRecord:key});
    if(record.collection)continue;
    if(record.collectionAttempted){
      record.collection=await readApi(`${datasetPath(key)}/feature-collection`);mark({records});continue;
    }
    record.collectionAttempted=true;mark({phase:`create-native-${key}`,records});
    const collection=await write(`${datasetPath(key)}/feature-collection`,'POST',{
      geometry_type:'Polygon',fields:[{name:'name',type:'string'},{name:'confidence',type:'number'}],features:inputs[key]
    },201);
    record.collection=collection['opengeo:collection'];assert.ok(record.collection?.generation);mark({records});
  }
  if(!progress.inputsMapSaved){
    let map=await readApi(mapPath);
    const expected=keys.map(key=>records[key].datasetId),actual=map.definition.layers.map(layer=>layer.datasetId);
    if(progress.inputsMapSaveAttempted&&JSON.stringify(actual)===JSON.stringify(expected)){
      assert.ok(map.definition.layers.every((layer,index)=>layer.datasetVersionId===records[keys[index]].datasetVersionId));
    }else{
      if(progress.inputsMapSaveAttempted){
        assert.equal(map.version,1,'Only the rejected seed PATCH may be corrected');
        assert.deepEqual(actual,[],'Preserve any committed composition or user edit');
        mark({rejectedSeedMapReadback:{version:map.version,layers:0,
          diagnosis:'HTTP 422 before persistence: exact dataset version pins also require sourceVersion'}});
      }
      const definition=structuredClone(map.definition);
      definition.layers=keys.map((key,index)=>({layerId:`building-${key}`,datasetId:records[key].datasetId,
        datasetVersionId:records[key].datasetVersionId,sourceVersion:records[key].versionNumber,
        title:names[key],sourceType:'governed-dataset',geometryType:'Polygon',
        visible:true,opacity:1,order:index,style:{fill:index?'#3b82f6':'#22c55e',stroke:'#334155',strokeWidth:2},labels:{enabled:false,field:null}}));
      definition.activeLayerId='building-source';
      definition.basemaps=[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true,opacity:1,attribution:'No basemap'}];
      definition.mapViews=[{id:'default',title:'Default',center:[-71.998,42.0005],zoom:17,pitch:0,bearing:0}];
      mark({phase:'seed-new-map',inputsMapSaveAttempted:true});
      map=await write(mapPath,'PATCH',{expected_version:map.version,definition,change_message:'Two explicitly synthetic building inventories'});
    }
    mark({map,inputsMapSaved:true});
  }
  if(!progress.metadata&&progress.metadataAttempted&&records.output?.uploadCompleted){
    const saved=await readApi(`/datasets/${records.output.datasetId}/metadata`);
    assert.ok(saved.version>0,'The prior metadata write remains unresolved; diagnose before another mutation');
    assert.deepEqual(saved.document,progress.preparedMetadata);mark({metadata:saved});
  }
  if(!progress.metadata){
    assert.ok(!records.output?.ticketAttempted,'Reconcile the retained output upload and metadata before another registration');
    await page.goto(`${mapUrl}&panel=processing`);
    await page.getByLabel('Operation',{exact:true}).selectOption('building-reconcile');
    await page.getByLabel('Source layer',{exact:true}).selectOption('building-source');
    await page.getByLabel('Target layer',{exact:true}).selectOption('building-comparison');
    const replay='**/analysis-preview';
    if(progress.nativePreview){
      await page.route(replay,async route=>{
        const request=route.request().postDataJSON(),retained=progress.nativePreview['opengeo:analysis'];
        assert.equal(request.operation,retained.operation);assert.equal(request.source_generation,retained.source_generation);
        assert.equal(request.target_dataset_id,retained.targetDatasetId);assert.equal(request.target_generation,retained.target_generation);
        const collection=structuredClone(progress.nativePreview);
        collection['opengeo:analysis'].previewId=request.preview_id;
        mark({retainedComparisonReplay:{nativePreviewId:retained.previewId,transportPreviewId:request.preview_id,
          method:'retained native comparison; only the new UI transport request identity is rebound',additionalNativeCalculations:0}});
        await route.fulfill({status:200,contentType:'application/geo+json',body:JSON.stringify(collection)});
      });
    }else assert.ok(!progress.nativePreviewAttempted,'Reconcile the native comparison response instead of recomputing accepted overlaps');
    try{
      mark({phase:'native-building-comparison'});
      const response=page.waitForResponse(value=>value.url().endsWith('/analysis-preview')&&value.request().method()==='POST');
      await page.getByRole('button',{name:'Preview analysis',exact:true}).click();assert.equal((await response).status(),200);
    }finally{if(progress.nativePreview)await page.unroute(replay);}
    const preview=progress.nativePreview;assert.equal(preview.features.length,3);
    const panel=page.locator('.building-reconciliation-review');await panel.waitFor();
    const groups=await panel.getByLabel('Review group',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value));
    assert.equal(groups.length,2);
    for(const group of groups){
      await panel.getByLabel('Review group',{exact:true}).selectOption(group);
      const choices=panel.locator('input[type="checkbox"]');
      for(const choice of await choices.all())if((await choice.getAttribute('aria-label')).startsWith('Retain source footprint '))await choice.check();
      await panel.getByLabel('Reason for this group decision',{exact:true}).fill('Synthetic acceptance: retain the exact source footprint; no validated building count is asserted.');
      await panel.getByRole('button',{name:'Record group decision',exact:true}).click();
    }
    await panel.getByRole('button',{name:'Create reviewed inventory',exact:true}).click();
    await page.getByText('2 original footprints retained; 1 excluded. 0 cross-source overlap pairs remain selected. This is a reviewed footprint count, not a validated building total.',{exact:true}).waitFor();
    records.output??={};mark({records,currentRecord:'output',phase:'register-reviewed-output'});
    const registration=page.locator('section.gis-editor-section').filter({has:page.getByRole('heading',{name:'Spatial analysis',exact:true})});
    await registration.getByLabel('Derived Layer title',{exact:true}).fill('Synthetic reviewed building inventory');
    await registration.getByLabel('Description',{exact:true}).fill('Local synthetic review acceptance; no provider, reference accuracy or validated count claim.');
    await registration.getByLabel('Distribution license (leave blank if unknown)',{exact:true}).fill('');
    await registration.getByLabel('Attribution',{exact:true}).fill('Synthetic local acceptance inventories');
    const registered=page.waitForResponse(response=>/\/datasets\/[^/]+\/metadata$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
    await registration.getByRole('button',{name:'Save as catalog Layer',exact:true}).click();assert.equal((await registered).status(),200);
    assert.ok(progress.metadata&&records.output.uploadCompleted,'Retain the committed output and metadata');
  }
  const output=records.output,metadata=await readApi(`/datasets/${output.datasetId}/metadata`);
  assert.deepEqual(metadata.document,progress.metadata.document);
  const generated=metadata.document.metadata.normalized.find(claim=>claim.method==='building_inventory_review');
  assert.ok(generated);const review=generated.value.buildingReview;
  assert.equal(review.schemaVersion,'opengeo.building-inventory-review-summary.1.0.0');
  assert.equal(review.retainedFeatureCount,2);assert.equal(review.excludedFeatureCount,1);assert.equal(review.componentCount,2);
  assert.equal(review.validatedCount,null);assert.equal(review.selectedOverlapPairs,0);assert.equal(review.decisions,undefined);
  assert.equal(review.reviewerId,records.source.collection.created_by,'Attribute the review to the actual local owner account');
  assert.ok(Number.isFinite(Date.parse(review.reviewedAt)));
  for(const key of keys)assert.ok(metadata.document.context.some(link=>link.resourceId===`urn:opengeo:dataset:${records[key].datasetId}:generation:${records[key].collection.generation}`));
  const license=metadata.document.metadata.curated.find(claim=>claim.property.endsWith('/license'));
  assert.equal(license.value,null);assert.equal(license.provenance,'unknown');mark({knowledgeReadback:true});
  if(!progress.outputWorkerCompleted)await processBatch('output',['output']);
  if(!progress.archiveVerified){
    const versions=await readApi(`${datasetPath('output')}/versions?limit=100&offset=0`),version=versions.find(value=>value.id===output.datasetVersionId);
    assert.equal(version.state,'active');const originals=version.objects.filter(value=>value.role==='original');assert.equal(originals.length,1);
    const original=originals[0];mark({archiveObjectId:original.id});
    const ticket=await write(`${datasetPath('output')}/versions/${version.id}/objects/${original.id}/download`,'POST');
    const bytes=Uint8Array.from(await page.evaluate(async url=>{const response=await fetch(url);if(!response.ok)throw Error('Original audit download failed');return Array.from(new Uint8Array(await response.arrayBuffer()));},ticket.url));
    const verified=await verifyBuildingReviewArchive(bytes,{objectSha256:original.checksum_sha256,reference:review});
    assert.equal(verified.receipt.buildingReview.decisions.length,2);assert.equal(verified.collection.features.length,2);
    for(const feature of verified.collection.features){const input=inputs.source.find(value=>value.id===feature.properties.input.featureId);
      assert.ok(input);assert.deepEqual(feature.geometry,input.geometry);assert.deepEqual(feature.properties.input.properties,input.properties);}
    assert.equal(verified.receipt.buildingReview.decisions.flatMap(decision=>decision.excludedFeatureIds).length,1);
    mark({archiveVerified:true,archiveObjectId:original.id,archiveChecksumSha256:original.checksum_sha256,reviewedCollection:verified.collection});
  }
  const rendered=id=>{const shell=document.querySelector('.opengeo-workbench'),map=shell?.__opengeoMap,
    layer=shell?.__opengeoLayers?.find(value=>value.datasetId===id);
    return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&layer&&shell.__opengeoData?.get(layer.layerId)?.features?.length===2
      &&map.queryRenderedFeatures().some(feature=>feature.geometry.type==='Polygon'&&feature.layer.id.startsWith(layer.layerId)));};
  const assertMap=map=>{assert.equal(map.id,mapId);assert.equal(map.project_id,projectId);
    assert.deepEqual(map.definition.layers.map(layer=>layer.datasetId).sort(),[...keys.map(key=>records[key].datasetId),output.datasetId].sort());
    assert.equal(map.definition.layers.find(layer=>layer.datasetId===output.datasetId).datasetVersionId,output.datasetVersionId);};
  if(!progress.mapSaved){
    if(progress.mapSaveAttempted){const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});}
    else{
      await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);
      const card=page.locator(`[data-dataset-id="${output.datasetId}"]`);
      await card.getByText('Add to map…',{exact:true}).click();await card.locator(`a[data-map-id="${mapId}"][data-handoff="add"]`).click();
      await page.getByRole('button',{name:'Add Synthetic reviewed building inventory to map',exact:true}).click();
      await page.getByRole('button',{name:'Fit',exact:true}).click();await page.waitForFunction(rendered,output.datasetId);
      mark({phase:'save-reviewed-map',mapSaveAttempted:true});
      const saved=page.waitForResponse(response=>response.url().endsWith(`/maps/${mapId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);
      const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});
    }
  }
  mark({phase:'fresh-reopen-reviewed-map'});await page.goto(mapUrl);await page.waitForFunction(rendered,output.datasetId);
  const reopened=await page.evaluate(id=>{const root=document.querySelector('.opengeo-workbench'),layer=root.__opengeoLayers.find(value=>value.datasetId===id);
    return root.__opengeoData.get(layer.layerId).features;},output.datasetId);
  assert.deepEqual(reopened,progress.reviewedCollection.features);
  const reopenedMap=await readApi(mapPath);assertMap(reopenedMap);
  assert.deepEqual((await readApi(`/datasets/${output.datasetId}/metadata`)).document,metadata.document);
  await page.screenshot({path:join(work,'building-review-saved-project-reopened.png')});
  mark({phase:'accepted-local-account-building-review',mapReopened:true,exactFeaturesReopened:true,status:'pass'});
  return {projectId,mapId,datasetId:output.datasetId,datasetVersionId:output.datasetVersionId,sourceFeatureCount:2,comparisonFeatureCount:1,
    retainedFeatureCount:2,excludedFeatureCount:1,validatedCount:null,knowledgeReadback:true,originalAuditVerified:true,
    reviewedCatalogRegistration:true,workerProcessed:true,catalogAssigned:true,actualMapSaved:true,freshAccountMapReopened:true,
    exactGeometryAndPropertiesReopened:true,unknownOutputLicensePreserved:true,providerRequests:0,
    notProven:['Provider retrieval or accuracy','Production identity/AWS transport','Public delivery','Full BI-02 completion']};
}

// The same account/worker/save path, scoped to three synthetic screening roles.
// Native clips and committed writes are checkpointed by the owning API proxy.
export async function exerciseReceptorScreening({page,context,origin,organization,work,readApi,apiRequest,worker,progress,checkpoint}) {
  assert.notEqual(progress.status,'pass','Do not replay a successfully accepted screening journey');
  const mark=update=>checkpoint(update),keys=['receptors','footprint','influence'],records=progress.records??={};
  const id=value=>`98000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
  const box=(value,bounds,name)=>({type:'Feature',id:id(value),properties:{name,confidence:null},geometry:{type:'Polygon',coordinates:[[
    [bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]],[bounds[0],bounds[1]]
  ]]}});
  const inputs={receptors:[box(1,[-72,42,-71.998,42.002],'Synthetic receptor A'),box(2,[-71.997,42,-71.996,42.001],'Synthetic receptor B')],
    footprint:[box(3,[-71.9995,42.0005,-71.9985,42.0015],'Synthetic Project footprint')],
    influence:[box(4,[-72.0005,41.9995,-71.9955,42.0025],'Synthetic influence area')]};
  const names={receptors:'Synthetic receptor inventory',footprint:'Synthetic Project footprint',influence:'Synthetic influence area'},
    outputTitle='Synthetic receptor screening output',credit='Synthetic local receptor screening inputs',
    question='Which supplied synthetic receptor polygons intersect the explicit Project footprint and influence area?',
    influenceBasis='The influence polygon is an explicit synthetic screening extent. No influence distance, impact significance or complete receptor coverage is inferred.';
  const write=async(path,method,body,expected=200)=>{
    const response=await apiRequest(path,{method,headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,expected,`${path}: ${response.body}`);return JSON.parse(response.body);
  };
  const retain=(filename,bytes)=>{
    const path=join(work,filename);
    if(existsSync(path))assert.deepEqual(readFileSync(path),Buffer.from(bytes),'Preserve the retained exact input or native response');
    else writeFileSync(path,bytes,{mode:0o600});
  };
  const bounds=feature=>{
    const points=[];const visit=value=>{if(typeof value[0]==='number')points.push(value);else value.forEach(visit);};visit(feature.geometry.coordinates);
    return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  };
  const assertNative=(scope,collection)=>{
    const receipt=collection['opengeo:analysis'];assert.equal(receipt.operation,'clip');assert.equal(receipt.persisted,false);
    assert.equal(receipt.sourceDatasetId,records.receptors.datasetId);assert.equal(receipt.source_generation,records.receptors.collection.generation);
    assert.equal(receipt.targetDatasetId,records[scope].datasetId);assert.equal(receipt.target_generation,records[scope].collection.generation);
    assert.equal(receipt.source_count,2);assert.equal(receipt.target_count,1);assert.equal(collection.features.length,scope==='footprint'?1:2);
    assert.deepEqual(collection.features.map(feature=>feature.id).sort(),scope==='footprint'?[id(1)]:[id(1),id(2)]);
    for(const feature of collection.features){const input=inputs.receptors.find(value=>value.id===feature.id);assert.ok(input);
      assert.deepEqual(feature.properties,input.properties);assert.ok(feature.geometry.type.includes('Polygon'));
      assert.deepEqual(bounds(feature),scope==='footprint'?bounds(inputs.footprint[0]):bounds(input));}
  };
  if(!progress.projectId){
    assert.ok(!progress.creationAttempted,'Reconcile the retained Project creation before another write');
    mark({phase:'create-synthetic-project',creationAttempted:true});
    await page.goto(`${origin}/workspaces`);await page.getByRole('link',{name:/New Project/}).click();
    await page.getByLabel('New project name',{exact:true}).fill('Synthetic receptor screening acceptance');
    await page.getByLabel('First map name',{exact:true}).fill('Footprint and influence screening');
    const created=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.request().method()==='POST'),
      mapped=page.waitForResponse(response=>/\/api\/projects\/[^/]+\/maps$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Create project and map',exact:true}).click();
    assert.equal((await created).status(),201);assert.equal((await mapped).status(),201);
  }
  assert.ok(progress.projectId,'Use the committed Project identity retained by the API proxy');
  if(!progress.mapId){const maps=await readApi(`/projects/${progress.projectId}/maps`);assert.equal(maps.length,1);mark({mapId:maps[0].id,map:maps[0]});}
  const projectId=progress.projectId,mapId=progress.mapId,mapPath=`/projects/${projectId}/maps/${mapId}`,
    mapUrl=`${origin}/workspaces?project=${projectId}&composition=${mapId}`,datasetPath=key=>`/projects/${projectId}/datasets/${records[key].datasetId}`;
  for(const key of keys){
    const record=records[key]??={},bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',features:inputs[key]}));
    Object.assign(record,{filename:`receptor-screening-${key}.geojson`,title:names[key],sizeBytes:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')});
    retain(record.filename,bytes);mark({records,currentRecord:key});
    if(record.uploadCompleted)continue;
    assert.ok(!record.uploadAttempted&&!record.ticketAttempted,'Reconcile the retained upload before any new transfer');
    await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);
    await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles({name:record.filename,mimeType:'application/geo+json',buffer:bytes});
    await page.getByLabel('Dataset, image, or document name',{exact:true}).fill(record.title);
    await page.getByLabel('Dataset classification',{exact:true}).selectOption('restricted');
    const completed=page.waitForResponse(response=>response.url().endsWith('/complete')&&response.request().method()==='POST');
    record.uploadAttempted=true;mark({phase:`upload-${key}`,records});
    await page.getByRole('button',{name:'Hash and upload',exact:true}).click();assert.equal((await completed).status(),200);
    assert.ok(record.uploadCompleted&&record.datasetId&&record.datasetVersionId,'Checkpoint the upload response before navigation');
  }
  async function processBatch(batch,batchKeys){
    const active=dataset=>dataset.status==='active'&&dataset.current_version_state==='active'&&dataset.processing_job_state==='completed';
    let datasets=await Promise.all(batchKeys.map(key=>readApi(datasetPath(key))));
    if(!datasets.every(active)){
      assert.ok(!progress[`${batch}WorkerAttempted`],'Reconcile the previously attempted worker; do not replay jobs');
      const queue=JSON.parse(readFileSync(join(work,'queue.json'),'utf8'));assert.equal(queue.length,batchKeys.length,'Only admitted screening ingestion messages may run');
      const seen=new Set();
      for(const message of queue){const entries=JSON.parse(message.body).Records;assert.equal(entries.length,1);
        const key=batchKeys.find(key=>entries[0].s3?.object?.key.includes(`/datasets/${records[key].datasetId}/`));
        assert.ok(key&&!seen.has(key),'Reject unrelated or duplicate ingestion messages');seen.add(key);}
      mark({phase:`ingest-${batch}`,[`${batch}WorkerAttempted`]:true,workerBatch:batch});await worker(45_000);
      datasets=await Promise.all(batchKeys.map(key=>readApi(datasetPath(key))));
    }
    assert.ok(datasets.every(active),'Every admitted exact version must finish ingestion');
    for(const [index,key] of batchKeys.entries()){
      assert.equal(datasets[index].current_version_id,records[key].datasetVersionId);assert.equal(datasets[index].classification,'restricted');
      assert.equal(datasets[index].feature_count,key==='output'?3:inputs[key].length);
    }
    mark({[`${batch}WorkerCompleted`]:true});
  }
  if(!progress.inputsWorkerCompleted)await processBatch('inputs',keys);
  for(const key of keys){
    const record=records[key];mark({currentRecord:key});if(record.collection)continue;
    if(record.collectionAttempted){record.collection=await readApi(`${datasetPath(key)}/feature-collection`);mark({records});continue;}
    record.collectionAttempted=true;mark({phase:`create-native-${key}`,records});
    const collection=await write(`${datasetPath(key)}/feature-collection`,'POST',{
      geometry_type:'Polygon',fields:[{name:'name',type:'string'},{name:'confidence',type:'number'}],features:inputs[key]
    },201);
    record.collection=collection['opengeo:collection'];assert.ok(record.collection?.generation);mark({records});
  }
  if(!progress.inputsMapSaved){
    let map=await readApi(mapPath);const expected=keys.map(key=>records[key].datasetId),actual=map.definition.layers.map(layer=>layer.datasetId);
    if(progress.inputsMapSaveAttempted){assert.deepEqual(actual,expected,'Reconcile the attempted seed PATCH without replaying it');
      assert.ok(map.definition.layers.every((layer,index)=>layer.datasetVersionId===records[keys[index]].datasetVersionId&&layer.sourceVersion===records[keys[index]].versionNumber));}
    else{
      assert.equal(map.version,1);assert.deepEqual(actual,[],'Preserve any existing composition or user edit');
      const definition=structuredClone(map.definition),colors=['#22c55e','#ef4444','#3b82f6'];
      definition.layers=keys.map((key,index)=>({layerId:`screening-${key}`,datasetId:records[key].datasetId,datasetVersionId:records[key].datasetVersionId,
        sourceVersion:records[key].versionNumber,title:names[key],sourceType:'governed-dataset',geometryType:'Polygon',visible:true,opacity:.6,order:index,
        style:{fill:colors[index],stroke:'#334155',strokeWidth:2},labels:{enabled:false,field:null}}));
      definition.activeLayerId='screening-receptors';definition.basemaps=[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true,opacity:1,attribution:'No basemap'}];
      definition.mapViews=[{id:'default',title:'Default',center:[-71.998,42.001],zoom:17,pitch:0,bearing:0}];
      mark({phase:'seed-new-map',inputsMapSaveAttempted:true});
      map=await write(mapPath,'PATCH',{expected_version:map.version,definition,change_message:'Three explicit synthetic receptor screening roles'});
    }
    mark({map,inputsMapSaved:true});
  }
  if(!progress.metadata&&progress.metadataAttempted&&records.output?.uploadCompleted){
    const saved=await readApi(`/datasets/${records.output.datasetId}/metadata`);
    assert.ok(saved.version>0,'The prior metadata write remains unresolved; diagnose before another mutation');
    assert.deepEqual(saved.document,progress.preparedMetadata);mark({metadata:saved});
  }
  if(!progress.metadata){
    assert.ok(!records.output?.ticketAttempted,'Reconcile the retained output upload and metadata before another registration');
    await page.goto(`${mapUrl}&panel=processing`);
    await page.getByLabel('Operation',{exact:true}).selectOption('receptor-screen');
    await page.getByLabel('Receptor layer',{exact:true}).selectOption('screening-receptors');
    await page.getByLabel('Project footprint',{exact:true}).selectOption('screening-footprint');
    await page.getByLabel('Influence area',{exact:true}).selectOption('screening-influence');
    await page.getByLabel('Screening question',{exact:true}).fill(question);await page.getByLabel('Influence area basis',{exact:true}).fill(influenceBasis);
    const pattern='**/analysis-preview',retained=progress.nativePreviews??{};
    for(const scope of ['footprint','influence'])assert.ok(retained[scope]||!progress.nativePreviewAttempted?.[scope],`Reconcile the attempted ${scope} clip instead of recomputing it`);
    const replay=async route=>{
      const request=route.request().postDataJSON(),scope=['footprint','influence'].find(key=>request.target_dataset_id===records[key].datasetId);
      assert.equal(route.request().method(),'POST');
      assert.ok(new URL(route.request().url()).pathname.endsWith(`/datasets/${records.receptors.datasetId}/analysis-preview`));
      assert.ok(scope);if(!retained[scope]){await route.continue();return;}
      const collection=structuredClone(retained[scope]),receipt=collection['opengeo:analysis'];assertNative(scope,collection);
      assert.equal(request.operation,'clip');assert.equal(request.source_generation,receipt.source_generation);assert.equal(request.target_generation,receipt.target_generation);
      const replays=progress.retainedClipReplays??{};replays[scope]={nativePreviewId:receipt.previewId,transportPreviewId:request.preview_id,
        method:'Retained native clip; only the UI transport preview identity is rebound',additionalNativeCalculations:0};
      receipt.previewId=request.preview_id;mark({retainedClipReplays:replays});
      await route.fulfill({status:200,contentType:'application/geo+json',body:JSON.stringify(collection)});
    };
    const replaying=Object.keys(retained).length>0;if(replaying)await page.route(pattern,replay);
    try{
      mark({phase:'native-receptor-screening'});await page.getByRole('button',{name:'Preview analysis',exact:true}).click();
      await page.getByText('3 scoped result records ready. Footprint and influence results remain separate; nothing has been saved.',{exact:true}).waitFor();
    }finally{if(replaying)await page.unroute(pattern,replay);}
    for(const scope of ['footprint','influence']){
      assertNative(scope,progress.nativePreviews[scope]);retain(`receptor-screening-native-${scope}.geojson`,JSON.stringify(progress.nativePreviews[scope],null,2)+'\n');
    }
    const sequence=(progress.exportCount??0)+1,suffix=sequence===1?'':`-${sequence}`,
      methodsFile=`receptor-screening-methods${suffix}.json`,previewFile=`receptor-screening-preview${suffix}.geojson`;
    mark({phase:'export-screening-before-registration',exportCount:sequence,exportAttempt:{methodsFile,previewFile}});
    let download=page.waitForEvent('download');await page.getByRole('button',{name:'Download screening methods JSON',exact:true}).click();await(await download).saveAs(join(work,methodsFile));
    download=page.waitForEvent('download');await page.getByRole('button',{name:'Download analysis GeoJSON',exact:true}).click();await(await download).saveAs(join(work,previewFile));
    const report=JSON.parse(readFileSync(join(work,methodsFile),'utf8')),collection=JSON.parse(readFileSync(join(work,previewFile),'utf8'));
    assert.deepEqual(collection['opengeo:analysis'].screening,report);assert.equal(collection.features.length,3);assert.equal(report.rows.length,3);
    assert.equal(report.question,question);assert.equal(report.influenceBasis,influenceBasis);assert.equal(report.validatedCount,null);
    assert.equal(report.nativeReceipts.length,2);assert.equal(report.scope.impactAssessment,'not-assessed');assert.equal(report.scope.households,'not-inferred');
    for(const key of keys)assert.deepEqual(report.inputs[key],{datasetId:records[key].datasetId,generation:records[key].collection.generation,featureCount:inputs[key].length});
    for(const [scope,count] of [['footprint',1],['influence',2]]){
      const summary=report.scopes[scope];assert.equal(summary.featureCount,count);assert.equal(summary.polygonFeatureCount,count);
      assert.equal(summary.lineFeatureCount,0);assert.equal(summary.pointFeatureCount,0);assert.equal(summary.lengthMeters,0);assert.equal(summary.pointCount,0);assert.ok(summary.areaSquareMeters>0);
      for(const feature of collection.features.filter(value=>value.properties.screening.scope===scope)){
        const input=inputs.receptors.find(value=>value.id===feature.properties.screening.sourceFeatureId);assert.ok(input);
        assert.deepEqual(feature.properties.source,input.properties);assert.deepEqual(bounds(feature),scope==='footprint'?bounds(inputs.footprint[0]):bounds(input));
      }
    }
    if(progress.screeningReport){
      const withoutTransport=value=>{const copy=structuredClone(value);for(const receipt of copy.nativeReceipts)delete receipt.previewId;return copy;};
      assert.deepEqual(withoutTransport(report),withoutTransport(progress.screeningReport),'Continuation preserves the accepted clipping and measures');
      assert.deepEqual(collection.features,progress.screeningCollection.features);
    }
    const exports=progress.exports??[];exports.push({methodsFile,previewFile,
      methodsSha256:createHash('sha256').update(readFileSync(join(work,methodsFile))).digest('hex'),
      previewSha256:createHash('sha256').update(readFileSync(join(work,previewFile))).digest('hex')});
    mark({screeningReport:report,screeningCollection:collection,exports,exportsBeforeRegistration:true});
    records.output??={};mark({records,currentRecord:'output',phase:'register-screening-output'});
    const registration=page.locator('section.gis-editor-section').filter({has:page.getByRole('heading',{name:'Spatial analysis',exact:true})});
    await registration.getByLabel('Derived Layer title',{exact:true}).fill(outputTitle);
    await registration.getByLabel('Description',{exact:true}).fill('Synthetic local screening persistence acceptance. Footprint and influence scopes remain separate; no provider accuracy or impact finding is asserted.');
    await registration.getByLabel('Distribution license (leave blank if unknown)',{exact:true}).fill('');
    await registration.getByLabel('Attribution',{exact:true}).fill(credit);
    const registered=page.waitForResponse(response=>/\/datasets\/[^/]+\/metadata$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
    await registration.getByRole('button',{name:'Save as catalog Layer',exact:true}).click();assert.equal((await registered).status(),200);
    assert.ok(progress.metadata&&records.output.uploadCompleted,'Retain the committed screening output and metadata');
  }
  const output=records.output,metadata=await readApi(`/datasets/${output.datasetId}/metadata`);assert.deepEqual(metadata.document,progress.metadata.document);
  const generated=metadata.document.metadata.normalized.find(claim=>claim.method==='receptor_overlap_screening');assert.ok(generated);
  const summary=generated.value.screening;assert.equal(summary.schemaVersion,'opengeo.receptor-screening-summary.1.0.0');assert.equal(summary.rows,undefined);
  const {rows,schemaVersion:originalSchema,...retainedReport}=progress.screeningReport,{audit,schemaVersion,...retainedSummary}=summary;
  assert.equal(originalSchema,'opengeo.receptor-screening.1.0.0');assert.equal(rows.length,3);
  assert.equal(audit.jsonPointer,'/properties/opengeo:analysis/screening');assert.deepEqual(retainedSummary,retainedReport);
  assert.equal(summary.scopes.footprint.featureCount,1);assert.equal(summary.scopes.influence.featureCount,2);assert.equal(summary.validatedCount,null);
  for(const key of keys)assert.ok(metadata.document.context.some(link=>link.resourceId===`urn:opengeo:dataset:${records[key].datasetId}:generation:${records[key].collection.generation}`));
  assert.equal(metadata.document.context.length,3);
  const license=metadata.document.metadata.curated.find(claim=>claim.property.endsWith('/license'));assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
  const sourceReceipt=JSON.parse(metadata.document.metadata.source[0].content);assert.deepEqual(sourceReceipt.screening,summary);mark({knowledgeReadback:true});
  if(!progress.outputWorkerCompleted)await processBatch('output',['output']);
  if(!progress.archiveVerified){
    let original=progress.archiveObjectId&&progress.archiveChecksumSha256?{id:progress.archiveObjectId,checksum_sha256:progress.archiveChecksumSha256}:null;
    if(!original){
      const versions=await readApi(`${datasetPath('output')}/versions?limit=100&offset=0`),version=versions.find(value=>value.id===output.datasetVersionId);
      assert.equal(version.state,'active');const originals=version.objects.filter(value=>value.role==='original');assert.equal(originals.length,1);original=originals[0];
      mark({archiveObjectId:original.id,archiveChecksumSha256:original.checksum_sha256});
    }
    const archivePath=join(work,'receptor-screening-original.geojson');let bytes;
    if(existsSync(archivePath))bytes=new Uint8Array(readFileSync(archivePath));
    else{
      assert.ok(!progress.archiveReadAttempted,'Reconcile the attempted original audit download; do not repeat its readback');
      mark({phase:'read-screening-original-audit',archiveReadAttempted:true});
      const ticket=await write(`${datasetPath('output')}/versions/${output.datasetVersionId}/objects/${original.id}/download`,'POST');
      bytes=Uint8Array.from(await page.evaluate(async url=>{const response=await fetch(url);if(!response.ok)throw Error('Original screening archive download failed');return Array.from(new Uint8Array(await response.arrayBuffer()));},ticket.url));
      retain('receptor-screening-original.geojson',bytes);
    }
    const verified=await verifyReceptorScreeningArchive(bytes,{objectSha256:original.checksum_sha256,reference:summary});
    assert.deepEqual(verified.receipt.screening,progress.screeningReport);assert.deepEqual(verified.collection.features,progress.screeningCollection.features);
    mark({archiveVerified:true,archiveObjectId:original.id,archiveChecksumSha256:original.checksum_sha256,screenedCollection:verified.collection});
  }
  const rendered=id=>{const shell=document.querySelector('.opengeo-workbench'),map=shell?.__opengeoMap,layer=shell?.__opengeoLayers?.find(value=>value.datasetId===id);
    return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&layer&&shell.__opengeoData?.get(layer.layerId)?.features?.length===3
      &&map.queryRenderedFeatures().some(feature=>feature.geometry.type==='Polygon'&&feature.layer.id.startsWith(layer.layerId)));};
  const assertMap=map=>{assert.equal(map.id,mapId);assert.equal(map.project_id,projectId);
    assert.deepEqual(map.definition.layers.map(layer=>layer.datasetId).sort(),[...keys.map(key=>records[key].datasetId),output.datasetId].sort());
    for(const key of [...keys,'output']){const layer=map.definition.layers.find(layer=>layer.datasetId===records[key].datasetId);
      assert.equal(layer.datasetVersionId,records[key].datasetVersionId);assert.equal(layer.sourceVersion,records[key].versionNumber);}
    assert.equal(map.definition.layers.find(layer=>layer.datasetId===output.datasetId).attribution,credit);};
  if(!progress.mapSaved){
    if(progress.mapSaveAttempted){const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});}
    else{
      await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);const card=page.locator(`[data-dataset-id="${output.datasetId}"]`);
      await card.getByText('Add to map…',{exact:true}).click();await card.locator(`a[data-map-id="${mapId}"][data-handoff="add"]`).click();
      await page.getByRole('button',{name:`Add ${outputTitle} to map`,exact:true}).click();await page.getByRole('button',{name:'Fit',exact:true}).click();
      await page.waitForFunction(rendered,output.datasetId);mark({phase:'save-screening-map',mapSaveAttempted:true});
      const saved=page.waitForResponse(response=>response.url().endsWith(`/maps/${mapId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);
      const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});
    }
  }
  mark({phase:'fresh-reopen-screening-map'});await page.goto(mapUrl);await page.waitForFunction(rendered,output.datasetId);
  const reopened=await page.evaluate(id=>{const root=document.querySelector('.opengeo-workbench'),layer=root.__opengeoLayers.find(value=>value.datasetId===id);
    return {features:root.__opengeoData.get(layer.layerId).features,layer,credit:document.querySelector('.maplibregl-ctrl-attrib')?.textContent??''};},output.datasetId);
  assert.deepEqual(reopened.features,progress.screenedCollection.features);assert.equal(reopened.layer.attribution,credit);assert.ok(reopened.credit.includes(credit));
  const reopenedMap=await readApi(mapPath);assertMap(reopenedMap);assert.deepEqual((await readApi(`/datasets/${output.datasetId}/metadata`)).document,metadata.document);
  await page.screenshot({path:join(work,'receptor-screening-saved-project-reopened.png')});
  mark({phase:'accepted-local-account-receptor-screening',mapReopened:true,exactFeaturesReopened:true,creditReopened:true,status:'pass'});
  return {projectId,mapId,datasetId:output.datasetId,datasetVersionId:output.datasetVersionId,receptorFeatureCount:2,footprintFeatureCount:1,influenceFeatureCount:1,
    scopedOutputFeatureCount:3,footprintClippedFeatures:1,influenceClippedFeatures:2,nativeClipCalculations:2,validatedCount:null,
    exportsBeforeRegistration:true,knowledgeReadback:true,threeInputLineagePins:true,originalAuditVerified:true,screeningCatalogRegistration:true,
    workerProcessed:true,catalogAssigned:true,actualMapSaved:true,freshAccountMapReopened:true,exactGeometryAndPropertiesReopened:true,
    creditReopened:true,unknownOutputLicensePreserved:true,providerRequests:0,
    notProven:['Provider retrieval or receptor accuracy','Expert impact findings or completeness','Production identity/AWS transport','Public delivery','Full BI-05 completion']};
}

// Isolated fixture transport only: CDP omits file-backed multipart entries.
// Clone the same native Request that fetch sends; do not reconstruct its form.
export function installIntegratedNativeUploadCapture(settings={}) {
  const originalFetch=globalThis.fetch.bind(globalThis),target='https://s3.us-east-1.amazonaws.com/local-pilot.invalid';
  let captured=false;
  globalThis.fetch=async(input,options)=>{
    const url=input instanceof Request?input.url:String(input),method=options?.method??(input instanceof Request?input.method:'GET');
    if(url!==target||String(method).toUpperCase()!=='POST')return originalFetch(input,options);
    if(settings.datasetOnly){
      const key=options?.body instanceof FormData?options.body.get('key'):null;
      if(typeof key!=='string'||!/(?:^|\/)datasets\/[a-f0-9-]{36}\/uploads\//i.test(key))return originalFetch(input,options);
    }
    if(captured)throw Error('The local COG fixture accepts one multipart upload.');
    captured=true;
    const request=new Request(input,options),contentType=request.headers.get('content-type'),
      bytes=new Uint8Array(await request.clone().arrayBuffer());
    if(!contentType?.startsWith('multipart/form-data; boundary=')||bytes.byteLength<1||bytes.byteLength>1_048_576)
      throw Error('The local multipart upload exceeds its bounded transport.');
    globalThis.__opengeoIntegratedNativeUpload={url:request.url,method:request.method,contentType,bytes:Array.from(bytes)};
    return originalFetch(request);
  };
}

// One restartable phase in the existing persistent development runner. Original
// bytes and measured summaries are reused; only new managed output URIs change.
// Reuse the retained managed COG without mutating its accepted composition.
export async function exerciseRasterCatalog({page,origin,organization,work,readApi,apiRequest,worker,progress,profile,checkpoint}) {
  assert.notEqual(progress.status,'pass','Reuse successful raster Catalog receipts');
  const validation=profile.schemaVersion==='opengeo.integrated-raster-validation.1',prefix=validation?'raster-validation':'raster-catalog',
    source=profile.source,projectId=source.projectId,records=progress.records??={},keys=validation?['validation']:['comparison','patches'],sides=validation?['before']:['before','after'],
    featureCount=key=>validation?records[key].collection.features.length:169,
    titles={validation:'Retained WorldCover whole-cell validation review',comparison:'Retained WorldCover interpretation disagreement',patches:'Retained WorldCover mapped cover patches'},
    descriptions={validation:'Synthetic reference labels demonstrate frozen sampling, review history and conditional sampling uncertainty for retained whole cells. Reference quality and classification accuracy remain unknown.',comparison:'Two explicit interpretations of the same retained WorldCover 2021 observation. Group disagreement is not temporal change or independently validated accuracy.',
      patches:'One mapped group in the retained WorldCover 2021 window. Grid connectivity does not establish ecological isolation or habitat condition.'},
    credit=source.layer.attribution,mark=update=>checkpoint(update),sourcePath=`/projects/${projectId}/datasets/${source.datasetId}`,
    kind=key=>key==='validation'?'rasterValidation':key==='comparison'?'rasterComparison':'rasterPatches',
    datasetPath=key=>`/projects/${projectId}/datasets/${records[key].datasetId}`,
    codes=[10,20,30,40,50,60,70,80,90,95,100],crosswalk=group=>codes.map(code=>`${code} = ${group}`).join('\n');
  const write=async(path,method,body,expected=200,rasterReadPurpose=null)=>{
    const response=await apiRequest(path,{method,headers:{authorization:'Bearer synthetic-local-owner',
      'x-opengeo-organization':organization,'content-type':'application/json'},rasterReadPurpose,...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,expected,`${path}: ${response.body}`);return JSON.parse(response.body);
  };
  const retain=(name,bytes)=>{const path=join(work,name);if(existsSync(path))assert.deepEqual(readFileSync(path),Buffer.from(bytes));
    else writeFileSync(path,bytes,{mode:0o600});};
  const assertBaseline=async()=>assert.deepEqual(await readApi(`/projects/${projectId}/maps/${source.mapId}`),source.map,'Preserve the accepted baseline map exactly');
  await assertBaseline();
  if(!progress.sourceAuthorityVerified){
    const dataset=await readApi(sourcePath),versions=await readApi(`${sourcePath}/versions?limit=100&offset=0`),
      version=versions.find(value=>value.id===source.datasetVersionId);
    assert.equal(dataset.id,source.datasetId);assert.equal(dataset.project_id,projectId,'Verify the actual dataset access container');
    assert.equal(dataset.status,'active');assert.equal(dataset.current_version_id,source.datasetVersionId);assert.equal(dataset.format,'cog');
    assert.equal(version.state,'active');assert.equal(version.version_number,source.versionNumber);
    const originals=version.objects.filter(value=>value.role==='original');assert.equal(originals.length,1);
    assert.equal(originals[0].id,source.dataObjectId);assert.equal(originals[0].size_bytes,810);assert.equal(originals[0].checksum_sha256,source.checksumSha256);
    mark({sourceAuthorityVerified:true,sourceReadback:{dataset,version},projectId});
  }
  if(!progress.mapId){
    assert.ok(!progress.mapRequestAttempted,'Reconcile the attempted composition creation without replaying its write');
    const definition=structuredClone(source.map.definition);definition.layers=[];definition.activeLayerId=null;
    definition.extensions={};definition.processingHistory=[];
    const map=await write(`/projects/${projectId}/maps`,'POST',{name:validation?'Retained raster classification validation':'Retained raster interpretation review',
      description:'Dedicated raster Catalog acceptance; the prior baseline composition remains unchanged.',definition},201);
    mark({mapId:map.id,map});
  }
  const mapId=progress.mapId,mapPath=`/projects/${projectId}/maps/${mapId}`,mapUrl=`${origin}/workspaces?project=${projectId}&composition=${mapId}`;
  if(!progress.inputsMapSaved){
    let map=await readApi(mapPath);
    if(progress.inputsMapSaveAttempted){assert.deepEqual(map.definition.layers.map(value=>value.layerId),sides.map(side=>`raster-${side}`));}
    else{
      assert.equal(map.version,1);assert.deepEqual(map.definition.layers,[]);
      const definition=structuredClone(map.definition);
      definition.layers=sides.map((side,index)=>({...structuredClone(source.layer),layerId:`raster-${side}`,
        title:`WorldCover 2021 interpretation ${index===0?'A':'B'}`,order:index,visible:true,opacity:.65}));
      definition.activeLayerId='raster-before';
      mark({inputsMapSaveAttempted:true});
      map=await write(mapPath,'PATCH',{expected_version:map.version,definition,change_message:'Two explicit interpretations reuse one retained native observation'});
    }
    mark({map,inputsMapSaved:true});
  }
  const loaded=ids=>{const root=document.querySelector('.opengeo-workbench'),context=root?.getPrintContext?.();
    return ids.every(id=>{const grid=context?.handles?.get(id)?.cog?.grid;return grid?.active()&&grid.width===13&&grid.height===13;});};
  for(const key of keys){
    const record=records[key]??={};mark({records,currentRecord:key});
    if(!record.metadata&&record.metadataAttempted&&record.uploadCompleted){
      const metadata=await readApi(`/datasets/${record.datasetId}/metadata`);assert.ok(metadata.version>0);
      assert.deepEqual(metadata.document,record.preparedMetadata);record.metadata=metadata;mark({records});
    }
    if(record.metadata)continue;
    assert.ok(!record.ticketAttempted,'Reconcile the retained output upload before generating another registration');
    // A diagnosed continuation may recompute cached summaries, never native jobs.
    await page.goto(mapUrl);await page.waitForFunction(loaded,sides.map(side=>`raster-${side}`));
    if(validation){
      await page.getByRole('button',{name:'Processing',exact:true}).click();
      await page.getByText('Validate categorical raster classes…',{exact:true}).click();
      const panel=page.locator('.gis-raster-validation');
      await panel.getByLabel('Validation raster',{exact:true}).selectOption('raster-before');
      await panel.getByLabel('This band contains validation class codes',{exact:true}).check();
      await panel.getByLabel('Validation crosswalk (code = group per line)',{exact:true}).fill(crosswalk('Mapped cover'));
      await panel.getByLabel('Validation random seed',{exact:true}).fill('retained-whole-cell-review-20261023');
      await panel.getByLabel('Draws per mapped stratum',{exact:true}).fill('2');
      await panel.getByLabel('Reference classes (one per line)',{exact:true}).fill('Mapped cover\nOther reference condition');
      await panel.getByLabel('Validation question',{exact:true}).fill('Can frozen whole-cell review, conditional area uncertainty and account persistence retain complete evidence?');
      await panel.getByLabel('Whole-cell labeling protocol',{exact:true}).fill('Synthetic acceptance labels apply to the entire cell footprint. No independently interpreted reference imagery or accuracy claim.');
      await panel.getByRole('button',{name:'Generate validation sample Layer',exact:true}).click();
      await page.waitForFunction(()=>[...document.querySelector('.opengeo-workbench').__opengeoData.values()]
        .some(data=>data?.['opengeo:analysis']?.rasterValidation?.plan.samples.length===2));
      const cells=await panel.getByLabel('Validation sample cell',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value));
      assert.ok(cells.length>0&&cells.length<=2,'Wait for the actual frozen sample before recording references');
      for(const cellId of cells){
        await panel.getByLabel('Validation sample cell',{exact:true}).selectOption(cellId);
        await panel.getByLabel('Reference class',{exact:true}).selectOption('Mapped cover');
        await panel.getByLabel('Reviewer',{exact:true}).fill('Synthetic local workflow reviewer');
        await panel.getByLabel('Reference evidence (source, date and version)',{exact:true}).fill('Synthetic local acceptance evidence, 2026-10-23, fixture version1; no independent imagery interpretation.');
        await panel.getByLabel('Cell review note',{exact:true}).fill('Whole footprint assigned synthetic label solely to check review and persistence.');
        await panel.getByRole('button',{name:'Record cell review',exact:true}).click();
        await page.waitForFunction(id=>[...document.querySelector('.opengeo-workbench').__opengeoData.values()].some(data=>data?.['opengeo:analysis']?.rasterValidation?.reviews.some(review=>review.cellId===id)),cellId);
      }
      await panel.getByRole('button',{name:'Calculate area-adjusted estimates',exact:true}).click();
      await panel.getByRole('table',{name:'Area-adjusted reference class areas',exact:true}).waitFor();
    }else await page.getByRole('button',{name:'Style WorldCover 2021 interpretation A',exact:true}).click();
    if(key==='comparison'){
      const panel=page.locator('.gis-raster-comparison');if(await panel.getAttribute('open')===null)await panel.locator(':scope > summary').click();
      await panel.getByLabel('Before raster',{exact:true}).selectOption('raster-before');await panel.getByLabel('After raster',{exact:true}).selectOption('raster-after');
      for(const side of ['Before','After']){
        await panel.getByLabel(`${side} band contains categorical class codes`,{exact:true}).check();
        await panel.getByLabel(`${side} source period start (optional)`,{exact:true}).fill('2021-01-01');
        await panel.getByLabel(`${side} source period end (optional)`,{exact:true}).fill('2021-12-31');
        await panel.getByLabel(`${side} crosswalk (code = group per line)`,{exact:true}).fill(crosswalk(`Interpretation ${side==='Before'?'A':'B'}`));
      }
      await panel.getByLabel('Comparability basis',{exact:true}).fill('The same retained WorldCover 2021 observation is interpreted twice using different explicit group crosswalks. This demonstrates interpretation disagreement, not temporal change.');
      await panel.getByLabel('Reference raster (optional)',{exact:true}).selectOption('before');
      await panel.getByLabel('Reference evaluation basis',{exact:true}).fill('Interpretation A is a declared comparison reference for this same observation; it is not independent validation or verified classification accuracy.');
      await panel.getByRole('button',{name:'Compare loaded cells',exact:true}).click();
      await panel.getByRole('button',{name:'Add transitions to map',exact:true}).click();
    }else if(!validation){
      const panel=page.locator('.gis-raster-patches');if(await panel.getAttribute('open')===null)await panel.locator(':scope > summary').click();
      await panel.getByLabel('This band contains patch class codes',{exact:true}).check();
      await panel.getByLabel('Patch crosswalk (code = group per line)',{exact:true}).fill(crosswalk('Mapped cover'));
      await panel.getByLabel('Patch group',{exact:true}).fill('Mapped cover');await panel.getByLabel('Patch connectivity',{exact:true}).selectOption('4');
      await panel.getByLabel('Patch interpretation basis',{exact:true}).fill('All published WorldCover codes are mapped to one explicit group for this retained observation. Window connectivity is descriptive and does not establish ecological isolation or habitat condition.');
      await panel.getByRole('button',{name:'Summarize patches',exact:true}).click();
      await panel.getByRole('button',{name:'Add patch cells to map',exact:true}).click();
    }
    const collection=await page.evaluate(name=>{const root=document.querySelector('.opengeo-workbench');
      return [...root.__opengeoData.values()].find(value=>value?.['opengeo:analysis']?.[name]);},kind(key));
    const evidence=rasterAnalysisEvidence(collection);assert.equal(evidence.kind,kind(key));assert.equal(collection.features.length,validation?2:169);
    for(const input of Object.values(evidence.inputs)){assert.equal(input.pins.datasetId,source.datasetId);
      assert.equal(input.pins.datasetVersionId,source.datasetVersionId);assert.equal(input.pins.objectId,source.dataObjectId);assert.equal(input.pins.sourceVersion,1);}
    if(record.collection){assert.deepEqual(collection.features,record.collection.features);
      const withoutUsage=report=>{const copy=structuredClone(report);delete copy.usage;return copy;};
      assert.deepEqual(withoutUsage(evidence.report),withoutUsage(record.report));}
    record.collection=collection;record.report=evidence.report;mark({records,phase:`register-raster-${key}`});
    retain(`${prefix}-${key}-preview-attempt-${profile.admittedAttempt}.geojson`,JSON.stringify(collection,null,2)+'\n');
    const panel=page.locator('.gis-baseline-registration');await panel.getByRole('heading',{name:'Save raster Layer to Catalog',exact:true}).waitFor();
    await panel.getByLabel('Catalog Layer title',{exact:true}).fill(titles[key]);await panel.getByLabel('Catalog description',{exact:true}).fill(descriptions[key]);
    await panel.getByLabel('Output distribution license (blank if unknown)',{exact:true}).fill('');
    await panel.getByLabel('Output attribution',{exact:true}).fill(credit);await panel.getByLabel('Output attribution',{exact:true}).blur();
    const saved=page.waitForResponse(response=>/\/datasets\/[^/]+\/metadata$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
    await panel.getByRole('button',{name:'Save raster Layer to Catalog',exact:true}).click();assert.equal((await saved).status(),200);
    assert.ok(record.uploadCompleted&&record.metadata,'Retain the committed derived output before navigation');
  }
  const active=value=>value.status==='active'&&value.current_version_state==='active'&&value.processing_job_state==='completed';
  let datasets=await Promise.all(keys.map(key=>readApi(datasetPath(key))));
  if(!datasets.every(active)){
    assert.ok(!progress.outputWorkerAttempted,'Reconcile the retained worker batch without replaying jobs');
    mark({outputWorkerAttempted:true,workerBatch:'output',phase:'ingest-two-raster-outputs'});await worker(45_000);
    datasets=await Promise.all(keys.map(key=>readApi(datasetPath(key))));
  }
  for(const [index,key] of keys.entries()){
    const record=records[key],dataset=datasets[index];assert.ok(active(dataset));assert.equal(dataset.current_version_id,record.datasetVersionId);
    assert.equal(dataset.classification,'restricted');assert.equal(dataset.feature_count,featureCount(key));
    const metadata=await readApi(`/datasets/${record.datasetId}/metadata`);assert.deepEqual(metadata.document,record.metadata.document);
    const generated=metadata.document.metadata.normalized.find(claim=>claim.method===(validation?'cached_raster_validation':key==='comparison'?'cached_raster_comparison':'cached_raster_patches'));
    assert.ok(generated);const summary=generated.value[kind(key)];assert.ok(summary);
    assert.equal(summary.audit.jsonPointer,`/properties/opengeo:analysis/${kind(key)}`);
    assert.equal(summary.audit.distributionId,`urn:opengeo:dataset:${record.datasetId}:version:${record.datasetVersionId}:original`);
    assert.ok(metadata.document.context.some(link=>link.resourceId===`urn:opengeo:dataset:${source.datasetId}:version:${source.datasetVersionId}`));
    const license=metadata.document.metadata.curated.find(claim=>claim.property.endsWith('/license'));assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
    if(!record.archiveVerified){
      if(!record.archiveObjectId){const versions=await readApi(`${datasetPath(key)}/versions?limit=100&offset=0`),version=versions.find(value=>value.id===record.datasetVersionId);
        assert.equal(version.state,'active');const objects=version.objects.filter(value=>value.role==='original');assert.equal(objects.length,1);
        record.archiveObjectId=objects[0].id;record.archiveChecksumSha256=objects[0].checksum_sha256;mark({records});}
      const filename=`${prefix}-${key}-original.geojson`,path=join(work,filename);let bytes;
      if(existsSync(path))bytes=new Uint8Array(readFileSync(path));
      else{assert.ok(!record.archiveReadAttempted,'Do not repeat an uncertain full original readback');
        const ticket=await write(`${datasetPath(key)}/versions/${record.datasetVersionId}/objects/${record.archiveObjectId}/download`,'POST',undefined,200,'audit');
        bytes=Uint8Array.from(await page.evaluate(async url=>{const response=await fetch(url);if(!response.ok)throw Error('Raster original archive download failed');
          return Array.from(new Uint8Array(await response.arrayBuffer()));},ticket.url));retain(filename,bytes);}
      const verified=await verifyRasterAnalysisArchive(bytes,{objectSha256:record.archiveChecksumSha256,reference:summary});
      assert.deepEqual(verified.receipt[kind(key)],record.report);assert.deepEqual(verified.collection.features,record.collection.features);
      record.archiveVerified=true;record.archivedCollection=verified.collection;mark({records});
    }
    record.knowledgeReadback=true;mark({records});
  }
  const assertMap=map=>{
    assert.equal(map.id,mapId);assert.equal(map.project_id,projectId);assert.equal(map.definition.layers.length,keys.length);
    assert.deepEqual(map.definition.layers.filter(layer=>layer.datasetId===source.datasetId),[]);
    for(const key of keys){const layer=map.definition.layers.find(value=>value.datasetId===records[key].datasetId);assert.ok(layer);
      assert.equal(layer.datasetVersionId,records[key].datasetVersionId);assert.equal(layer.sourceVersion,records[key].versionNumber);assert.equal(layer.attribution,credit);}
  };
  const rendered=outputs=>{const root=document.querySelector('.opengeo-workbench'),map=root?.__opengeoMap;
    return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&outputs.every(({id,count})=>{const layer=root.__opengeoLayers?.find(value=>value.datasetId===id);
      return layer&&root.__opengeoData?.get(layer.layerId)?.features?.length===count&&map.queryRenderedFeatures().some(feature=>feature.layer.id.startsWith(layer.layerId));}));};
  if(!progress.mapSaved){
    if(progress.mapSaveAttempted){const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});}
    else{
      await page.goto(mapUrl);await page.waitForFunction(loaded,sides.map(side=>`raster-${side}`));
      for(const key of keys){await page.getByRole('button',{name:'Add data',exact:true}).click();
        await page.getByRole('button',{name:`Add ${titles[key]} to map`,exact:true}).click();
        await page.waitForFunction(id=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.some(layer=>layer.datasetId===id),records[key].datasetId);}
      for(const side of sides){
        const row=page.locator(`.gis-layer-row[data-layer-id="raster-${side}"]`),actions=row.locator('details.gis-layer-more');
        if(await actions.getAttribute('open')===null)await actions.locator(':scope > summary').click();
        await actions.getByRole('button',{name:'Remove layer from this project',exact:true}).click();
      }
      await page.getByRole('button',{name:'Fit',exact:true}).click();await page.waitForFunction(rendered,keys.map(key=>({id:records[key].datasetId,count:featureCount(key)})));
      mark({mapSaveAttempted:true,phase:'save-raster-output-map'});const saved=page.waitForResponse(response=>response.url().endsWith(`/maps/${mapId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);
      const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});
    }
  }
  await page.goto(mapUrl);await page.waitForFunction(rendered,keys.map(key=>({id:records[key].datasetId,count:featureCount(key)})));
  for(const key of keys){const reopened=await page.evaluate(id=>{const root=document.querySelector('.opengeo-workbench'),layer=root.__opengeoLayers.find(value=>value.datasetId===id);
    return {features:root.__opengeoData.get(layer.layerId).features,layer,credit:document.querySelector('.maplibregl-ctrl-attrib')?.textContent??''};},records[key].datasetId);
    assert.deepEqual(reopened.features,records[key].archivedCollection.features);assert.equal(reopened.layer.attribution,credit);assert.ok(reopened.credit.includes(credit));}
  assertMap(await readApi(mapPath));await assertBaseline();
  await page.screenshot({path:join(work,`${prefix}-saved-project-reopened.png`)});
  mark({phase:'accepted-local-account-raster-catalog',mapReopened:true,exactFeaturesReopened:true,creditReopened:true,baselineUnchanged:true,status:'pass'});
  return {projectId,mapId,sourceDatasetId:source.datasetId,sourceDatasetVersionId:source.datasetVersionId,sourceObjectId:source.dataObjectId,
    outputs:keys.map(key=>({kind:kind(key),datasetId:records[key].datasetId,datasetVersionId:records[key].datasetVersionId,features:featureCount(key),fullArchiveVerified:true})),
    nativeComputations:0,inputTransfers:0,workerBatches:1,actualMapSaved:true,freshAccountMapReopened:true,exactGeometryAndPropertiesReopened:true,
    unknownOutputLicensePreserved:true,baselineUnchanged:true,providerRequests:0,
    notProven:['Temporal land-cover change','Independently validated classification accuracy','Ecological isolation or habitat condition','Production identity/AWS transport','Public delivery','Full BI-04/BI-07 completion']};
}

export async function exerciseStacItems({page,origin,organization,work,readApi,progress,profile,checkpoint}) {
  assert.equal(profile.schemaVersion,'opengeo.integrated-stac-items.1');assert.notEqual(progress.status,'pass','Reuse accepted STAC Item receipts');
  const mark=update=>checkpoint(update),baseline=profile.source,projectId=baseline.projectId,pin=profile.stac,
    title='Retained STAC Sentinel-2 red band',mapName='Retained STAC Sentinel-2 red band Project',
    query={endpoint:'https://earth-search.aws.element84.com/v1/search',collections:['sentinel-2-l2a'],bbox:[85.533,27.6119167,85.5340833,27.613],
      start:'2021-10-01T00:00:00.000Z',end:'2021-10-31T23:59:59.999Z',limit:1};
  assert.ok(pin?.item&&pin.responseSha256&&pin.assetUrl);assert.equal(pin.sizeBytes,178976119);assert.equal(pin.responseBytes,22215);
  const assertBaseline=async()=>assert.deepEqual(await readApi(`/projects/${projectId}/maps/${baseline.mapId}`),baseline.map,'Preserve the accepted baseline composition exactly');
  await assertBaseline();mark({projectId,phase:'read-retained-stac-context',organization});
  if(!progress.record?.datasetId&&progress.sourceRegistrationAttempted){
    const parameters=new URLSearchParams({project_id:projectId,query:title,limit:'2',offset:'0'}),candidates=await readApi(`/datasets?${parameters}`),
      matches=candidates.filter(value=>value.name===title&&value.source_type==='cog');
    assert.equal(matches.length,1,'Reconcile the attempted source registration without replaying an uncertain write');
    mark({record:{...progress.record,datasetId:matches[0].id},sourceRegistrationRecovered:true});
  }
  let registration=null;
  if(!progress.record?.datasetId){
    await page.goto(`${origin}/workspaces?view=data`);const search=page.locator('.platform-stac-item-search');await search.waitFor();
    await search.locator('summary').first().click();
    for(const [label,value] of [['STAC search endpoint',query.endpoint],['Collection IDs (comma separated)',query.collections.join(',')],
      ['STAC bounds west, south, east, north',query.bbox.join(',')],['STAC start (UTC)','2021-10-01T00:00'],
      ['STAC end (UTC)','2021-10-31T23:59:59.999'],['Items per page','1']])await search.getByLabel(label,{exact:true}).fill(value);
    mark({phase:'deliberate-external-stac-search'});await search.getByRole('button',{name:'Search Items',exact:true}).click();
    await search.locator('.platform-stac-item-result').waitFor();await search.getByRole('button',{name:'View asset references',exact:true}).click();
    await search.getByRole('button',{name:'Download Item references',exact:true}).waitFor();
    assert.match(await search.innerText(),/Reference only:/);assert.match(await search.innerText(),/s3:\/\//);assert.match(await search.innerText(),/image\/jp2/);assert.match(await search.innerText(),/asset terms: unknown/);
    const [download]=await Promise.all([page.waitForEvent('download'),search.getByRole('button',{name:'Download Item references',exact:true}).click()]),
      exports=progress.referenceExports??[],name=`stac-items-references${exports.length?'-'+(exports.length+1):''}.json`;
    await download.saveAs(join(work,name));const reference=JSON.parse(readFileSync(join(work,name),'utf8'));
    assert.deepEqual(reference.original,pin.item);assert.deepEqual(reference.query,query);assert.equal(reference.snapshot.sha256,pin.responseSha256);assert.equal(reference.snapshot.bytes,pin.responseBytes);
    assert.equal(reference.assets.find(asset=>asset.key==='red').href,pin.assetUrl);assert.equal(reference.assets.find(asset=>asset.key==='red').license,null);
    assert.ok(reference.assets.some(asset=>asset.href.startsWith('s3:')&&asset.cogCompatible===false));assert.ok(reference.assets.some(asset=>asset.type==='image/jp2'&&asset.cogCompatible===false));
    exports.push({file:name,sha256:createHash('sha256').update(readFileSync(join(work,name))).digest('hex')});mark({reference,referenceExports:exports,phase:'review-stac-analytical-reference'});
    await search.getByRole('button',{name:'Review Catalog registration',exact:true}).click();registration=search.locator('.static-item-registration');
    await registration.locator('label').filter({hasText:/^Access workspace/}).locator('select').selectOption(projectId);
    await registration.locator('label').filter({hasText:/^Raster asset/}).locator('select').selectOption('red');
    assert.equal(await registration.getByLabel('Raster bands (one or three)',{exact:true}).inputValue(),'1');
    await registration.getByLabel('Known asset size in bytes (optional)',{exact:true}).fill(String(pin.sizeBytes));await registration.getByLabel('Layer title',{exact:true}).fill(title);
    const response=page.waitForResponse(value=>value.url().endsWith(`/projects/${projectId}/sources`)&&value.request().method()==='POST');
    mark({sourceRegistrationAttempted:true,phase:'register-stac-layer'});await registration.getByRole('button',{name:'Register Layer',exact:true}).click();
    const committed=await response;assert.equal(committed.status(),201);const source=await committed.json();assert.ok(source.dataset_id);
    mark({record:{...progress.record,datasetId:source.dataset_id,source},sourceRegistered:true});await registration.getByRole('button',{name:'Open map',exact:true}).waitFor();
  }
  const datasetId=progress.record.datasetId,sourcePath=`/projects/${projectId}/datasets/${datasetId}/source`,rawSource=await readApi(sourcePath),source=parseExternalSource(rawSource),
    revisions=await readApi(`${sourcePath}/revisions?limit=100&offset=0`),revision=parseExternalSourceRevision(revisions.find(value=>value.version_number===source.versionNumber));
  assert.equal(source.projectId,projectId);assert.equal(source.datasetId,datasetId);assert.equal(source.name,title);assert.equal(source.sourceType,'cog');assert.equal(source.status,'active');assert.equal(source.classification,'internal');
  assert.equal(source.accessMode,'direct_browser');assert.equal(source.credentialMode,'none');assert.equal(source.versionNumber,1);assert.equal(source.sourceUrl,pin.assetUrl);
  assert.deepEqual(source.configuration.bounds,pin.item.bbox);assert.deepEqual(source.configuration.bands,[1]);assert.equal(source.configuration.sizeBytes,pin.sizeBytes);assert.equal(source.configuration.license,null);
  const metadata=source.configuration.referenceMetadata;assert.deepEqual(metadata.source.item,pin.item);assert.deepEqual(metadata.source.asset,pin.item.assets.red);assert.equal(metadata.source.assetKey,'red');
  assert.deepEqual(metadata.normalized.query,query);assert.equal(metadata.normalized.snapshot.sha256,pin.responseSha256);assert.equal(metadata.normalized.snapshot.bytes,pin.responseBytes);
  assert.equal(metadata.normalized.assetAccess,'unverified');assert.deepEqual(metadata.normalized.assetSize,{bytes:pin.sizeBytes,authority:'user-supplied-unverified'});
  assert.deepEqual(revision.configuration,source.configuration);assert.equal(revision.sourceUrl,source.sourceUrl);assert.equal(revision.versionNumber,1);
  if(progress.record.source)assert.deepEqual(rawSource,progress.record.source,'Read back the committed source without rewriting its metadata');
  mark({record:{...progress.record,source:rawSource,revision:revisions.find(value=>value.version_number===1)},sourceVerified:true});
  writeFileSync(join(work,'stac-items-source-readback.json'),JSON.stringify({source:rawSource,revisions},null,2)+'\n',{mode:0o600});
  if(!progress.mapId&&progress.mapRequestAttempted){
    const maps=await readApi(`/projects/${projectId}/maps`),matches=maps.filter(value=>value.name===mapName&&value.definition.layers.length===1&&value.definition.layers[0].datasetId===datasetId);
    assert.equal(matches.length,1,'Reconcile the attempted Project save without replaying an uncertain write');mark({mapId:matches[0].id,map:matches[0],mapSaveRecovered:true});
  }
  const readNative=mode=>page.evaluate(async({mode,datasetId})=>{
    const frame=mode==='catalog'?document.querySelector('.catalog-layer-preview .map-frame'):null,root=document.querySelector('.opengeo-workbench'),context=root?.getPrintContext?.(),
      layer=context?.layers?.find(value=>value.datasetId===datasetId),handle=context?.handles?.get(layer?.layerId),session=frame?.__cogSession??handle?.cog,grid=session.grid,value=session.result;
    const digest=await crypto.subtle.digest('SHA-256',value.pixels);let visible=0;for(let index=3;index<value.pixels.length;index+=4)if(value.pixels[index])visible++;
    return{layer:layer??null,width:grid.width,height:grid.height,imageIndex:grid.metadata.imageIndex,bands:grid.metadata.bands,centerValue:grid.value(Math.floor(grid.width/2),Math.floor(grid.height/2),1),
      pixelsSha256:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),visiblePixels:visible,snapshot:value.snapshot,bounds:value.bounds,usage:value.usage};
  },{mode,datasetId});
  const assertNative=value=>{assert.equal(value.imageIndex,4);assert.equal(value.width,630);assert.equal(value.height,687);assert.deepEqual(value.bands,[1]);assert.equal(value.centerValue,354);
    assert.ok(value.visiblePixels>100000);assert.equal(value.snapshot.url,pin.assetUrl);assert.equal(value.snapshot.size,pin.sizeBytes);assert.equal(value.snapshot.verified,false);assert.equal(value.snapshot.rangeHeadersExposed,false);assert.deepEqual(value.bounds,pin.item.bbox);};
  if(!progress.mapId){
    if(registration)await registration.getByRole('button',{name:'Open map',exact:true}).click();
    else{
      await page.goto(`${origin}/workspaces?view=data`);await page.getByLabel('Search organization datasets',{exact:true}).fill(title);await page.getByRole('button',{name:'Search catalog',exact:true}).click();
      const row=page.locator(`.platform-catalog-resource-row[data-dataset-id="${datasetId}"]`);await row.waitFor({state:'attached'});
      const group=row.locator('xpath=ancestor::details[1]');if(await group.getAttribute('open')===null)await group.locator('summary').first().click();
      await row.getByRole('button',{name:'Open map',exact:true}).click();
    }
    await page.waitForFunction(()=>document.querySelector('.catalog-layer-preview .map-frame')?.__cogSession?.result);
    const catalogRaster=await readNative('catalog');assertNative(catalogRaster);if(progress.catalogRaster)assert.equal(catalogRaster.pixelsSha256,progress.catalogRaster.pixelsSha256);
    mark({catalogRaster,phase:'save-stac-layer-to-project'});await page.locator('.catalog-layer-preview').screenshot({path:join(work,'stac-items-catalog.png')});
    await page.getByRole('button',{name:'Save to Project…',exact:true}).click();const dialog=page.locator('.catalog-project-save');
    await dialog.getByLabel('New Project title',{exact:true}).fill(mapName);
    assert.equal(await dialog.getByLabel('Access workspace for new Project',{exact:true}).inputValue(),projectId);
    const response=page.waitForResponse(value=>value.url().endsWith(`/projects/${projectId}/maps`)&&value.request().method()==='POST');
    mark({mapRequestAttempted:true,phase:'commit-stac-project'});await dialog.getByRole('button',{name:'Save',exact:true}).click();
    const committed=await response;assert.equal(committed.status(),201);const map=await committed.json();mark({mapId:map.id,map,mapSaved:true});
    await dialog.getByRole('link',{name:'Open saved Project',exact:true}).waitFor();const href=await dialog.getByRole('link',{name:'Open saved Project',exact:true}).getAttribute('href');
    assert.equal(new URL(href,origin).searchParams.get('composition'),map.id);mark({mapHref:href});
    await dialog.getByRole('link',{name:'Open saved Project',exact:true}).click();
  }
  const mapId=progress.mapId,mapPath=`/projects/${projectId}/maps/${mapId}`,mapUrl=new URL(progress.mapHref??`/workspaces?composition=${mapId}`,origin).href;
  const assertMap=map=>{assert.equal(map.id,mapId);assert.equal(map.project_id,projectId);assert.equal(map.name,mapName);assert.equal(map.definition.layers.length,1);
    const layer=map.definition.layers[0];assert.equal(layer.datasetId,datasetId);assert.equal(layer.sourceVersion,1);assert.equal(layer.sourceType,'cog-raster');assert.equal(layer.sourceUrl,pin.assetUrl);assert.deepEqual(layer.sourceConfiguration,source.configuration);};
  const rendered=id=>{const root=document.querySelector('.opengeo-workbench'),context=root?.getPrintContext?.(),layer=context?.layers?.find(value=>value.datasetId===id),handle=context?.handles?.get(layer?.layerId),grid=handle?.cog?.grid;
    return Boolean(context?.ready&&context.map?.isStyleLoaded()&&grid?.active()&&handle.cog.loading===false&&grid.metadata.imageIndex===4&&context.map.getSource(handle.sourceId));};
  const selectBlankBasemap=async()=>{
    await page.locator('.gis-menubar [data-menu="view"] > button').click();await page.getByRole('menuitem',{name:'Change basemap',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Change basemap',exact:true}),blank=dialog.locator('.gis-basemap-card[data-catalog-id="blank"]'),group=blank.locator('xpath=ancestor::details[1]');
    if(await group.getAttribute('open')===null)await group.locator('summary').click();await blank.click();
    await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.basemapActivationState==='active');
    await dialog.getByRole('button',{name:'Done',exact:true}).click();
  };
  assertMap(await readApi(mapPath));assert.ok(progress.catalogRaster,'Retain the accepted Catalog pixels before saving the Project');
  let initial=progress.initialProjectRaster,reopened=progress.nativeReadback,reopenedNow=false;
  if(!initial){
    if(!page.url().includes(`composition=${mapId}`))await page.goto(mapUrl);
    await selectBlankBasemap();
    await page.waitForFunction(rendered,datasetId);initial=await readNative('project');assertNative(initial);assert.equal(initial.pixelsSha256,progress.catalogRaster.pixelsSha256);
    assert.equal(initial.layer.datasetId,datasetId);assert.equal(initial.layer.sourceVersion,1);assert.deepEqual(initial.layer.sourceConfiguration,source.configuration);mark({initialProjectRaster:initial,phase:'fresh-stac-project-reopen'});
  }
  if(!progress.mapReopened){await page.goto(mapUrl);await selectBlankBasemap();await page.waitForFunction(rendered,datasetId);reopened=await readNative('project');reopenedNow=true;}
  assertNative(initial);assertNative(reopened);assert.equal(reopened.pixelsSha256,initial.pixelsSha256);
  assert.equal(reopened.layer.datasetId,datasetId);assert.equal(reopened.layer.sourceVersion,1);assert.deepEqual(reopened.layer.sourceConfiguration,source.configuration);
  const map=await readApi(mapPath);assertMap(map);assert.deepEqual(await readApi(sourcePath),rawSource);await assertBaseline();
  mark({map,mapReopened:true,nativeReadback:reopened,phase:'stac-reference-project-ready'});
  if(reopenedNow)await page.screenshot({path:join(work,'stac-items-project-reopened.png')});writeFileSync(join(work,'stac-items-native-readback.json'),JSON.stringify({catalog:progress.catalogRaster,initial,reopened},null,2)+'\n',{mode:0o600});
  return{mode:'external-stac-item-reference',projectId,mapId,datasetId,sourceVersion:1,assetKey:'red',bands:[1],sourceUrl:pin.assetUrl,responseSha256:pin.responseSha256,
    originalItemPreserved:true,assetLicense:null,knownSizeAuthority:'user-supplied-unverified',snapshotVerified:false,catalogPixelsSha256:progress.catalogRaster.pixelsSha256,reopenedPixelsSha256:reopened.pixelsSha256,
    baselineUnchanged:true,ingestionJobs:0,nativeCalculations:0,workerBatches:0,limits:'Actual local account Catalog source/revision and Project persistence with existing authorization. STAC metadata and native COG ranges replay retained provider bytes; no new provider/AWS/GitHub request, archived imagery copy, physical-unit conversion, coverage/accuracy finding or deployed acceptance.'};
}

export async function exerciseBaselineStudy({page,context,origin,work,readApi,worker,baseline,profile,checkpoint}) {
  const records=baseline.records,keys=['fields','landcover'];
  const mark=(update={})=>checkpoint(update);
  const source=key=>JSON.parse(readFileSync(join(work,profile.inputs[key].knowledge),'utf8'));
  const fieldData=JSON.parse(readFileSync(join(work,profile.inputs.fields.file),'utf8'));
  if(baseline.mapSaved&&baseline.mapReopened&&baseline.figure?.output&&baseline.publication?.revisionId
      &&baseline.figure.presentationReview?.status!=='needs-closer-extent'){
    for(const key of keys){assert.equal(records[key].checksumSha256,profile.inputs[key].sha256);assert.ok(records[key].knowledgeReadback);}
    const figure=readFileSync(join(work,'baseline-map.svg'));
    assert.equal(figure.length,baseline.figure.output.bytes);
    assert.equal(createHash('sha256').update(figure).digest('hex'),baseline.figure.output.sha256);
    mark({phase:'resume-saved-baseline-publication'});return baseline;
  }
  const projectTitle='Nearby agricultural baseline',mapTitle='Retained fields and native land cover';
  if(!baseline.projectId){
    assert.ok(!baseline.creationAttempted,'Project response unresolved: reconcile the retained attempt before creating anything');
    mark({phase:'create-project',creationAttempted:true});
    await page.goto(`${origin}/workspaces`);await page.getByRole('link',{name:/New Project/}).click();
    await page.getByLabel('New project name',{exact:true}).fill(projectTitle);
    await page.getByLabel('First map name',{exact:true}).fill(mapTitle);
    const created=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.request().method()==='POST'),
      mapped=page.waitForResponse(response=>/\/api\/projects\/[^/]+\/maps$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Create project and map',exact:true}).click();
    const a=await created,b=await mapped;assert.equal(a.status(),201);assert.equal(b.status(),201);
    // The normal navigation may release CDP response bodies. The API proxy
    // checkpoints these committed identities before fulfilling either response.
    assert.ok(baseline.projectId&&baseline.mapId&&baseline.map?.id===baseline.mapId,
      'Use the committed Project and map identities retained by the API proxy');
  }
  if(!baseline.mapId){const maps=await readApi(`/projects/${baseline.projectId}/maps`);assert.equal(maps.length,1);mark({mapId:maps[0].id,map:maps[0]});}
  const projectId=baseline.projectId,mapId=baseline.mapId,mapPath=`/projects/${projectId}/maps/${mapId}`,
    mapUrl=`${origin}/workspaces?project=${projectId}&composition=${mapId}`;
  const retainedMap=await readApi(mapPath);assert.equal(retainedMap.id,mapId);mark({map:retainedMap});
  for(const key of keys){
    const input=profile.inputs[key],record=records[key]??={};
    Object.assign(record,{checksumSha256:input.sha256,sizeBytes:input.sizeBytes,filename:input.filename,title:input.title});
    mark({phase:`upload-${key}`,currentRecord:key,records});
    if(record.uploadCompleted)continue;
    assert.ok(!record.uploadAttempted,'A retained upload attempt must be reconciled; never transfer its source again');
    await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);
    await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles(join(work,input.file));
    await page.getByLabel('Dataset, image, or document name',{exact:true}).fill(input.title);
    await page.getByLabel('Dataset classification',{exact:true}).selectOption('restricted');
    const completed=page.waitForResponse(response=>response.url().endsWith('/complete')&&response.request().method()==='POST');
    record.uploadAttempted=true;mark({records});
    await page.getByRole('button',{name:'Hash and upload',exact:true}).click();
    const response=await completed;assert.equal(response.status(),200);
    const saved=await response.json();Object.assign(record,{datasetId:saved.dataset.id,datasetVersionId:saved.dataset_version_id,
      versionNumber:saved.version_number,uploadCompleted:true});mark({records});
  }
  if(baseline.workerCompleted&&keys.every(key=>records[key]?.knowledgeReadback)){
    for(const key of keys)assert.ok(records[key].datasetId&&records[key].datasetVersionId&&records[key].dataObjectId&&records[key].knowledgeDocument);
    mark({phase:'reuse-committed-originals-and-knowledge'});
  }else{
    const datasetPath=key=>`/projects/${projectId}/datasets/${records[key].datasetId}`;
    let datasets=Object.fromEntries(await Promise.all(keys.map(async key=>[key,await readApi(datasetPath(key))])));
    const active=key=>datasets[key].status==='active'&&datasets[key].current_version_state==='active'&&datasets[key].processing_job_state==='completed';
    if(!keys.every(active)){
      assert.ok(!baseline.workerAttempted&&!baseline.workerRuns,'Reconcile the already attempted worker before any further batch');
      const queued=JSON.parse(readFileSync(join(work,'queue.json'),'utf8'));
      assert.equal(queued.length,2,'Only the two admitted ingestion messages may run');
      for(const message of queued){const entries=JSON.parse(message.body).Records;assert.ok(entries?.length);
        for(const entry of entries)assert.ok(keys.some(key=>entry.s3?.object?.key.includes(`/datasets/${records[key].datasetId}/`)),'Unrelated ingestion cannot join this batch');}
      mark({phase:'ingest-two-originals',workerAttempted:true});await worker(45000);
      datasets=Object.fromEntries(await Promise.all(keys.map(async key=>[key,await readApi(datasetPath(key))])));
    }
    assert.ok(keys.every(active),'Both exact admitted versions must finish ingestion');mark({workerCompleted:true});
    for(const key of keys){
      const record=records[key],input=profile.inputs[key],dataset=datasets[key];
      assert.equal(dataset.current_version_id,record.datasetVersionId);assert.equal(dataset.classification,'restricted');
      assert.equal(dataset.format,key==='fields'?'geojson':'cog');
      if(key==='fields')assert.equal(dataset.feature_count,1);
      const versions=await readApi(`${datasetPath(key)}/versions?limit=100&offset=0`),
        version=versions.find(value=>value.id===record.datasetVersionId);
      assert.equal(version.state,'active');const originals=version.objects.filter(value=>value.role==='original');assert.equal(originals.length,1);
      const original=originals[0];assert.equal(original.size_bytes,input.sizeBytes);assert.equal(original.checksum_sha256,input.sha256);
      if(record.dataObjectId)assert.equal(record.dataObjectId,original.id);
      Object.assign(record,{dataObjectId:original.id,versionNumber:version.version_number,datasetName:dataset.name});
      const oldOriginal=`urn:opengeo:dataset:${input.baseDatasetId}:version:${input.baseDatasetVersionId}:original`,
        newOriginal=`urn:opengeo:dataset:${record.datasetId}:version:${record.datasetVersionId}:original`,
        oldAnalysis=`urn:opengeo:dataset:${input.baseDatasetId}:analysis`,newAnalysis=`urn:opengeo:dataset:${record.datasetId}:analysis`;
      const rebind=(value,key='')=>{
        if(key==='content')return value; // Retained source text remains byte-for-byte unchanged.
        if(typeof value==='string')return value===oldOriginal?newOriginal:value===oldAnalysis?newAnalysis:value;
        if(Array.isArray(value))return value.map(item=>rebind(item));
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,rebind(item,name)]));
        return value;
      };
      const expected=rebind(source(key));assert.ok(Buffer.byteLength(JSON.stringify(expected))<=49152);
      let knowledge=await readApi(`/datasets/${record.datasetId}/metadata`);
      if(knowledge.version===0){
        assert.ok(!record.knowledgeAttempted,'Unknown metadata commit must be read back before any repeat write');
        await page.goto(`${origin}/layers?id=${record.datasetId}`);
        const editor=page.locator('.resource-knowledge');await editor.getByRole('button',{name:'Load metadata record',exact:true}).click();
        await editor.getByText('Edit metadata record',{exact:true}).click();await editor.getByLabel('Metadata JSON',{exact:true}).fill(JSON.stringify(expected,null,2));
        const saved=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(`/datasets/${record.datasetId}/metadata`)&&response.request().method()==='PUT');
        record.knowledgeAttempted=true;mark({phase:`knowledge-${key}`,records});
        await editor.getByRole('button',{name:'Save metadata revision',exact:true}).click();
        const confirm=editor.getByRole('button',{name:'Confirm reviewed changes and save',exact:true});if(await confirm.isVisible())await confirm.click();
        assert.equal((await saved).status(),200);knowledge=await readApi(`/datasets/${record.datasetId}/metadata`);
      }
      assert.deepEqual(knowledge.document,expected,'Exact new output URIs and unchanged source/derived facts must read back');
      Object.assign(record,{knowledgeDocument:knowledge.document,knowledgeVersion:knowledge.version,knowledgeReadback:true});mark({records});
    }
  }
  const pins=()=>({fields:records.fields.datasetId,landcover:records.landcover.datasetId});
  const loaded=({fields,landcover,selector='.opengeo-workbench',requireRendered=true})=>{
    const shell=document.querySelector(selector),context=shell?.getPrintContext?.(),map=context?.map,
      field=context?.layers?.find(layer=>layer.datasetId===fields),cog=context?.layers?.find(layer=>layer.datasetId===landcover),
      handle=context?.handles?.get(cog?.layerId),grid=handle?.cog?.grid;
    return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&context.ready&&field&&cog&&handle?.cog?.loading===false&&grid?.active()&&grid.width===13&&grid.height===13
      &&shell.__opengeoData?.get(field.layerId)?.features?.length===1&&map.getSource(handle.sourceId)
      &&(!requireRendered||map.queryRenderedFeatures().some(feature=>feature.geometry.type==='Polygon'&&feature.layer.id.startsWith(field.layerId))));
  };
  const assertMap=map=>{
    assert.equal(map.id,mapId);assert.equal(map.project_id,projectId);assert.equal(map.definition.layers.length,2);
    for(const key of keys){const layer=map.definition.layers.find(layer=>layer.datasetId===records[key].datasetId);
      assert.equal(layer.datasetVersionId,records[key].datasetVersionId);
      const distribution=`urn:opengeo:dataset:${records[key].datasetId}:version:${records[key].datasetVersionId}:original`,
        credit=records[key].knowledgeDocument.metadata.curated.find(claim=>claim.subject===distribution&&claim.property==='https://schema.org/creditText').value;
      assert.equal(layer.attribution,credit);if(key==='landcover')assert.equal(layer.objectId,records[key].dataObjectId);
    }
    assert.ok(!/X-Amz-|local-pilot\.invalid/.test(JSON.stringify(map.definition)));
  };
  const reviseFigure=baseline.figure?.presentationReview?.status==='needs-closer-extent';
  if(!baseline.mapSaved){
    if(baseline.mapSaveAttempted){const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});}
    else{
      mark({phase:'add-exact-catalog-versions'});
      await page.goto(`${origin}/workspaces?project=${projectId}&manage=data`);
      const card=page.locator(`[data-dataset-id="${records.landcover.datasetId}"]`);
      await card.getByText('Add to map…',{exact:true}).click();await card.locator(`a[data-map-id="${mapId}"][data-handoff="add"]`).click();
      await page.getByRole('button',{name:`Add ${records.landcover.datasetName} to map`,exact:true}).click();
      // Adding the managed COG finishes asynchronously and opens its inspector.
      // The blocked online basemap cannot be a prerequisite for choosing blank.
      await page.locator('.gis-panel-right .gis-panel-header h2').filter({hasText:/^Layer Properties$/}).waitFor();
      await page.locator('.gis-panel-right .gis-managed-layer-credit').waitFor();
      await page.locator('.gis-menubar [data-menu="view"] > button').click();await page.getByRole('menuitem',{name:'Change basemap',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Change basemap',exact:true}),blank=dialog.locator('.gis-basemap-card[data-catalog-id="blank"]'),group=blank.locator('xpath=ancestor::details[1]');
      if(await group.getAttribute('open')===null)await group.locator('summary').click();await blank.click();
      await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.basemapActivationState==='active');
      await dialog.getByRole('button',{name:'Done',exact:true}).click();
      await page.waitForFunction(landcover=>{
        const shell=document.querySelector('.opengeo-workbench'),context=shell?.getPrintContext?.(),map=context?.map,
          layer=context?.layers?.find(value=>value.datasetId===landcover),handle=context?.handles?.get(layer?.layerId),grid=handle?.cog?.grid;
        return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&context.ready&&handle?.cog?.loading===false
          &&grid?.active()&&grid.width===13&&grid.height===13&&map.getSource(handle.sourceId)
          &&shell.querySelector('.gis-panel-right .gis-panel-header h2')?.textContent==='Layer Properties'
          &&shell.querySelector('.gis-panel-right .gis-managed-layer-credit'));
      },records.landcover.datasetId);
      await page.getByRole('button',{name:'Add data',exact:true}).click();
      await page.getByRole('button',{name:`Add ${records.fields.datasetName} to map`,exact:true}).click();
      await page.waitForFunction(loaded,{...pins(),requireRendered:false});
      await page.getByRole('button',{name:'Fit',exact:true}).click();await page.waitForFunction(loaded,pins());
      const cogTitle=await page.evaluate(id=>document.querySelector('.opengeo-workbench').__opengeoLayers.find(layer=>layer.datasetId===id).title,records.landcover.datasetId);
      await page.getByRole('button',{name:`Style ${cogTitle}`,exact:true}).click();
      await page.getByLabel('Display minimum',{exact:true}).fill('0');await page.getByLabel('Display maximum',{exact:true}).fill('100');
      await page.getByRole('button',{name:'Apply display range',exact:true}).click();
      await page.waitForFunction(id=>{const layer=document.querySelector('.opengeo-workbench')?.__opengeoLayers?.find(layer=>layer.datasetId===id);
        return layer?.style?.cogDisplay?.displayRange?.minimum===0&&layer.style.cogDisplay.displayRange.maximum===100;},records.landcover.datasetId);
      await page.waitForFunction(loaded,pins());
      mark({phase:'save-combined-map',mapSaveAttempted:true});
      const saved=page.waitForResponse(response=>response.url().endsWith(`/maps/${mapId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);
      const map=await readApi(mapPath);assertMap(map);mark({map,mapSaved:true});
    }
  }
  if(reviseFigure&&!baseline.figure.presentationMapSaved){
    const figure=baseline.figure;
    if(!figure.presentationMapSaveAttempted){
      await page.goto(mapUrl);await page.waitForFunction(loaded,pins());
      assert.equal(await page.evaluate(()=>document.querySelector('.opengeo-workbench').__opengeoMap.getZoom()),13);
      for(let target=14;target<=18;target++){
        await page.locator('.gis-menubar [data-menu="view"] > button').click();
        await page.getByRole('menuitem',{name:/^Zoom in\s*\+$/}).click();
        await page.waitForFunction(zoom=>{const map=document.querySelector('.opengeo-workbench')?.__opengeoMap;
          return map&&!map.isMoving()&&Math.abs(map.getZoom()-zoom)<1e-6;},target);
      }
      figure.presentationMapSaveAttempted=true;mark({figure,phase:'save-closer-baseline-view'});
      const saved=page.waitForResponse(response=>response.url().endsWith(`/maps/${mapId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await saved).status(),200);
    }
    const map=await readApi(mapPath);assertMap(map);assert.equal(map.definition.mapViews[0].zoom,18);
    assert.equal(map.version,3,'The closer presentation supersedes the accepted map version2 once');
    figure.presentationMapSaved=true;mark({figure,map});
  }
  mark({phase:'fresh-reopen-combined-map'});await page.goto(mapUrl);await page.waitForFunction(loaded,pins());
  const reopened=await page.evaluate(({fields,landcover})=>{
    const root=document.querySelector('.opengeo-workbench'),context=root.getPrintContext(),
      field=context.layers.find(layer=>layer.datasetId===fields),cog=context.layers.find(layer=>layer.datasetId===landcover),
      handle=context.handles.get(cog.layerId),grid=handle.cog.grid,values=[];
    for(let row=0;row<grid.height;row++)for(let column=0;column<grid.width;column++)values.push(grid.value(column,row,1));
    return{features:root.__opengeoData.get(field.layerId).features,width:grid.width,height:grid.height,values,metadata:grid.metadata,zoom:context.map.getZoom(),
      snapshot:handle.cog.result.snapshot,cogCredit:root.querySelector('.gis-cog-attribution')?.textContent,layer:cog};
  },pins());
  assert.deepEqual(reopened.features,fieldData.features);assert.equal(reopened.values.length,169);assert.ok(reopened.values.every(value=>value===40));
  assert.equal(reopened.metadata.noData,0);assert.equal(reopened.metadata.imageIndex,0);assert.equal(reopened.metadata.projection,'EPSG:4326');
  const cogDistribution=`urn:opengeo:dataset:${records.landcover.datasetId}:version:${records.landcover.datasetVersionId}:original`;
  assert.equal(reopened.metadata.source.url,cogDistribution);assert.equal(reopened.snapshot.url,cogDistribution);
  assert.equal(reopened.cogCredit,reopened.layer.attribution);assert.equal(reopened.layer.objectId,records.landcover.dataObjectId);
  const map=await readApi(mapPath);assertMap(map);mark({map,mapReopened:true,nativeReadback:reopened,phase:'print-baseline-figure'});
  const figure=baseline.figure??={};
  if(reviseFigure&&!figure.supersedes){
    assert.ok(figure.presentationMapSaved);assert.equal(reopened.zoom,18);assert.equal(figure.captureAttempts,1);
    const previous=readFileSync(join(work,'baseline-map.svg'));
    assert.equal(createHash('sha256').update(previous).digest('hex'),figure.output.sha256);
    const retained=join(work,'baseline-map-v1.svg');
    if(existsSync(retained))assert.deepEqual(readFileSync(retained),previous);else writeFileSync(retained,previous,{flag:'wx',mode:0o600});
    figure.supersedes={...figure.output};figure.previousLayout=figure.preparedLayout;
    figure.totalCaptureAttempts=figure.captureAttempts;figure.captureAttempts=0;
    delete figure.output;delete figure.outputAttempted;
    figure.presentationReview.status='revising-closer-extent';mark({figure});
  }
  if(!figure.output){
    if(!figure.outputAttempted){
      await page.locator('.gis-menubar [data-menu="project"] > button').click();await page.getByRole('menuitem',{name:'Open Print Studio',exact:true}).click();
      const editor=page.locator('.project-print-editor');await editor.waitFor();
      await editor.getByLabel('Layout title',{exact:true}).fill(profile.title);await editor.getByLabel('Layout title',{exact:true}).blur();
      await editor.getByLabel('Paper size',{exact:true}).selectOption('A4');await editor.getByLabel('Orientation',{exact:true}).selectOption('landscape');
      await editor.getByLabel('Caption',{exact:true}).fill(profile.figureCaption);await editor.getByLabel('Caption',{exact:true}).blur();
      await editor.getByLabel('Map frame',{exact:true}).selectOption('main');
      await editor.getByRole('button',{name:'Edit selected map frame',exact:true}).click();
      await page.waitForFunction(loaded,{...pins(),selector:'.project-print-editor .opengeo-workbench'});
      if(figure.supersedes){
        const extent=await page.evaluate(id=>{const context=document.querySelector('.project-print-editor .opengeo-workbench').getPrintContext(),
          layer=context.layers.find(layer=>layer.datasetId===id),bounds=layer.bbox,
          a=context.map.project([bounds[0],bounds[1]]),b=context.map.project([bounds[2],bounds[3]]);
          return{zoom:context.map.getZoom(),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)};},records.landcover.datasetId);
        assert.equal(extent.zoom,18);assert.ok(extent.width>=150&&extent.height>=150,'The study window must be legible in the captured map');
        figure.presentationExtent=extent;mark({figure});
      }
      assert.equal(figure.captureAttempts??0,0);figure.captureAttempts=1;mark({figure});
      figure.totalCaptureAttempts=(figure.totalCaptureAttempts??0)+1;mark({figure});
      await editor.getByRole('button',{name:'Capture map frame',exact:true}).click();await editor.locator(':scope > [role="status"]').filter({hasText:/^Captured /}).waitFor();
      const staged=JSON.parse(await editor.locator('.print-stage svg > metadata').textContent());
      assert.equal(staged.layout.frames.length,1);assert.equal(staged.captures.length,1);
      Object.assign(figure,{preparedLayout:staged.layout,layoutSaved:false});
      figure.outputAttempted=true;mark({figure});
      await editor.getByLabel('Output format',{exact:true}).selectOption('svg');
      const download=page.waitForEvent('download');await editor.getByRole('button',{name:'Prepare selected output',exact:true}).click();await(await download).saveAs(join(work,'baseline-map.svg'));
    }
    assert.ok(existsSync(join(work,'baseline-map.svg')),'Reconcile the attempted figure output without recapture or redownload');
    const bytes=readFileSync(join(work,'baseline-map.svg')),text=bytes.toString('utf8');assert.ok(text.includes('<svg')&&text.includes('<image'));
    figure.output={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    if(figure.supersedes){assert.notEqual(figure.output.sha256,figure.supersedes.sha256);figure.presentationReview.status='revised-pending-visual-review';}
    mark({figure,figurePath:'baseline-map.svg'});
  }else{
    const bytes=readFileSync(join(work,'baseline-map.svg'));assert.equal(createHash('sha256').update(bytes).digest('hex'),figure.output.sha256);
  }
  mark({figurePath:'baseline-map.svg',map:await readApi(mapPath),phase:'baseline-data-ready'});return baseline;
}

// Shared runner supplies real API/database/worker; only identity and cloud transport are synthetic.
export async function exerciseStudioAnalysis({page, project, composition, origin, organization, worker, readApi, apiRequest,ftwQueryPath,managedCogFile,managedCogProfile,work}) {
  if(ftwQueryPath)return exerciseRetainedFtwInventory({page,project,composition,origin,worker,readApi,ftwQueryPath,work});
  if(managedCogFile)return exerciseRetainedManagedCog({page,project,composition,origin,worker,readApi,managedCogFile,managedCogProfile,work});
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
  await page.locator('.gis-menubar [data-menu="view"] > button').click();
  await page.getByRole("menuitem", {name: "Change basemap", exact: true}).click();
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

async function exerciseRetainedManagedCog({page,project,composition,origin,worker,readApi,managedCogFile,managedCogProfile,work}) {
  const bytes=readFileSync(managedCogFile),sourceSha256=createHash('sha256').update(bytes).digest('hex');
  const sidecar=JSON.parse(readFileSync(join(work,'managed-cog-sidecar.json'))),
    inventory=JSON.parse(readFileSync(join(work,'managed-cog-inventory.json'))),
    knowledgeText=readFileSync(join(work,'managed-cog-knowledge.json'),'utf8');
  assert.equal(bytes.length,810);assert.equal(sourceSha256,managedCogProfile.sourceSha256);
  assert.ok(Buffer.byteLength(knowledgeText)<=49_152,'Knowledge is admitted before upload');
  assert.equal(inventory.coverage.totalCells,169);assert.equal(inventory.coverage.touchedCells,147);
  const title='WorldCover native subset — source 2021 / study 2024';
  const mapUrl=`${origin}/workspaces?project=${project.id}&composition=${composition.id}`;
  await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);
  await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles(managedCogFile);
  await page.getByLabel('Dataset, image, or document name',{exact:true}).fill(title);
  await page.getByLabel('Dataset classification',{exact:true}).selectOption('restricted');
  const uploaded=page.waitForResponse(response=>response.url().endsWith('/complete')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Hash and upload',exact:true}).click();
  const uploadResponse=await uploaded;assert.equal(uploadResponse.status(),200);
  const completion=await uploadResponse.json(),datasetId=completion.dataset.id,versionId=completion.dataset_version_id;
  assert.match(datasetId,/^[0-9a-f-]{36}$/);assert.match(versionId,/^[0-9a-f-]{36}$/);
  await worker();
  const saved=await readApi(`/projects/${project.id}/datasets/${datasetId}`);
  assert.equal(saved.status,'active');assert.equal(saved.classification,'restricted');assert.equal(saved.format,'cog');
  assert.equal(saved.current_version_id,versionId);
  const document=JSON.parse(knowledgeText.replaceAll(managedCogProfile.datasetPlaceholder,datasetId)
    .replaceAll(managedCogProfile.versionPlaceholder,versionId));
  assert.ok(Buffer.byteLength(JSON.stringify(document))<=49_152);
  const distribution=`urn:opengeo:dataset:${datasetId}:version:${versionId}:original`;
  assert.equal(document.distributions[0].id,distribution);
  const reviewedCredit=document.metadata.curated.find(claim=>claim.subject===distribution&&claim.property==='https://schema.org/creditText').value;
  // This is the ordinary Catalog metadata editor, including its explicit change review.
  await page.goto(`${origin}/layers?id=${datasetId}`);
  const knowledge=page.locator('.resource-knowledge');
  await knowledge.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await knowledge.getByText('Edit metadata record',{exact:true}).click();
  await knowledge.getByLabel('Metadata JSON',{exact:true}).fill(JSON.stringify(document,null,2));
  const registered=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(`/datasets/${datasetId}/metadata`)&&response.request().method()==='PUT');
  await knowledge.getByRole('button',{name:'Save metadata revision',exact:true}).click();
  const confirm=knowledge.getByRole('button',{name:'Confirm reviewed changes and save',exact:true});
  if(await confirm.isVisible())await confirm.click();
  const metadataResponse=await registered;assert.equal(metadataResponse.status(),200);
  const metadata=await metadataResponse.json();assert.deepEqual(metadata.document,document);
  writeFileSync(join(work,'managed-cog-reviewed-registration.json'),JSON.stringify({datasetId,datasetVersionId:versionId,sourceSha256,metadata},null,2)+'\n');
  await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);
  const card=page.locator(`[data-dataset-id="${datasetId}"]`);
  await card.getByText('Add to map…',{exact:true}).click();
  await card.locator(`a[data-map-id="${composition.id}"][data-handoff="add"]`).click();
  await page.getByRole('button',{name:`Add ${saved.name} to map`,exact:true}).click();
  await page.locator('.gis-menubar [data-menu="view"] > button').click();
  await page.getByRole('menuitem',{name:'Change basemap',exact:true}).click();
  const basemap=page.getByRole('dialog',{name:'Change basemap',exact:true}),blank=basemap.locator('.gis-basemap-card[data-catalog-id="blank"]');
  const group=blank.locator('xpath=ancestor::details[1]');
  if(await group.getAttribute('open')===null)await group.locator('summary').click();
  await blank.click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.basemapActivationState==='active');
  await basemap.getByRole('button',{name:'Done',exact:true}).click();
  const rendered=id=>{
    const shell=document.querySelector('.opengeo-workbench'),context=shell?.getPrintContext?.(),map=context?.map,
      layer=context?.layers?.find(layer=>layer.datasetId===id),handle=context?.handles?.get(layer?.layerId),grid=handle?.cog?.grid;
    return Boolean(grid?.active()&&grid.width===13&&grid.height===13&&map?.isStyleLoaded()&&!map.isMoving()
      &&map.getSource(handle.sourceId)&&handle.layerIds.some(id=>map.getLayer(id)?.type==='raster'));
  };
  await page.waitForFunction(rendered,datasetId);
  await page.getByRole('button',{name:'Fit',exact:true}).click();
  await page.waitForFunction(rendered,datasetId);
  const readNative=()=>page.evaluate(id=>{
    const shell=document.querySelector('.opengeo-workbench'),context=shell.getPrintContext(),
      layer=context.layers.find(layer=>layer.datasetId===id),handle=context.handles.get(layer.layerId),grid=handle.cog.grid,
      values=Array.from({length:grid.height},(_,row)=>Array.from({length:grid.width},(_,column)=>grid.value(column,row,1))).flat();
    let opaqueDisplayPixels=0;
    for(let index=3;index<handle.cog.result.pixels.length;index+=4)if(handle.cog.result.pixels[index]>0)opaqueDisplayPixels++;
    return {layer,width:grid.width,height:grid.height,metadata:grid.metadata,values,
      snapshot:handle.cog.result.snapshot,custody:handle.cog.result.custody,
      opaqueDisplayPixels,
      attribution:document.querySelector('.maplibregl-ctrl-attrib')?.textContent??''};
  },datasetId);
  const assertNative=value=>{
    assert.equal(value.layer.sourceType,'governed-dataset');assert.equal(value.layer.geometryType,'Raster');
    assert.equal(value.layer.datasetId,datasetId);assert.equal(value.layer.datasetVersionId,versionId);
    assert.equal(value.layer.sourceVersion,completion.version_number);assert.match(value.layer.objectId,/^[0-9a-f-]{36}$/);
    assert.equal(value.width,13);assert.equal(value.height,13);assert.equal(value.values.length,169);
    assert.ok(value.values.every(code=>code===40));assert.equal(value.metadata.noData,0);
    assert.equal(value.metadata.imageIndex,0);assert.deepEqual(value.metadata.bands,[1]);
    assert.equal(value.metadata.projection,'EPSG:4326');assert.equal(value.metadata.source.url,distribution);
    assert.equal(value.snapshot.url,distribution);assert.equal(value.custody,'hosted');assert.ok(value.opaqueDisplayPixels>0);
    assert.equal(value.layer.attribution,reviewedCredit);assert.ok(value.attribution.includes(sidecar.source.attribution));
    assert.equal(value.layer.sourceUrl,undefined);
  };
  const initial=await readNative();assertNative(initial);
  await page.getByRole('button',{name:'Identify',exact:true}).click();
  const click=await page.evaluate(()=>{
    const map=document.querySelector('.opengeo-workbench').__opengeoMap,
      point=map.project([85.5335,27.6125]),rect=map.getCanvas().getBoundingClientRect();
    return {x:rect.left+point.x,y:rect.top+point.y};
  });
  await page.mouse.click(click.x,click.y);
  const identified=page.locator('.gis-identify-panel .cog-identify-result[data-sample-status="ready"]');
  await identified.waitFor();assert.equal(await identified.locator('dd').first().textContent(),'40');
  const savedMap=page.waitForResponse(response=>response.url().endsWith(`/maps/${composition.id}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await savedMap).status(),200);
  await page.goto(mapUrl);await page.waitForFunction(rendered,datasetId);
  const reopened=await readNative();assertNative(reopened);
  assert.deepEqual(reopened.layer.sourceConfiguration,initial.layer.sourceConfiguration);
  assert.deepEqual(reopened.layer.bbox,initial.layer.bbox);assert.equal(reopened.layer.title,initial.layer.title);
  assert.deepEqual(reopened.values,initial.values);
  const reopenedKnowledge=await readApi(`/datasets/${datasetId}/metadata`);assert.deepEqual(reopenedKnowledge.document,document);
  const reopenedMap=await readApi(`/projects/${project.id}/maps/${composition.id}`);
  assert.equal(reopenedMap.definition.layers.length,1);const pinned=reopenedMap.definition.layers[0];
  assert.equal(pinned.datasetId,datasetId);assert.equal(pinned.datasetVersionId,versionId);assert.equal(pinned.objectId,initial.layer.objectId);
  assert.equal(pinned.attribution,reviewedCredit);assert.equal(pinned.sourceUrl,undefined);
  assert.ok(!/local-pilot\.invalid|X-Amz-|[?&](?:Signature|Expires)=/i.test(JSON.stringify(reopenedMap.definition)),'Project contains logical identities rather than signed transport URLs');
  const handoff=document.metadata.normalized.find(claim=>claim.method==='retained_native_cog_handoff').value,
    summary=document.metadata.normalized.find(claim=>claim.method==='categorical_cell_corner_area_inventory').value;
  assert.deepEqual(JSON.parse(document.metadata.source[0].content),sidecar);
  assert.deepEqual(JSON.parse(document.metadata.source[1].content),inventory);
  assert.deepEqual(handoff.source,sidecar.source);assert.deepEqual(handoff.grid,sidecar.grid);
  assert.equal(handoff.localImport.providerReverified,false);assert.equal(handoff.localImport.sha256,sourceSha256);
  assert.equal(handoff.source.observationPeriod.start,'2021-01-01');assert.equal(handoff.request.period.start,'2024-01-01');
  assert.equal(summary.coverage.touchedCells,147);assert.equal(summary.coverage.totalAreaSquareMeters,10956.070972506099);
  assert.equal(summary.coverage.outsideWindowAreaSquareMeters,0.006499084123788634);
  const outputLicense=document.metadata.curated.find(claim=>claim.subject===distribution&&claim.property==='http://purl.org/dc/terms/license');
  assert.equal(outputLicense.value,null);assert.equal(outputLicense.provenance,'unknown');
  await page.screenshot({path:join(work,'managed-cog-saved-project-reopened.png')});
  writeFileSync(join(work,'managed-cog-native-readback.json'),JSON.stringify({initial,reopened},null,2)+'\n');
  return {mode:'retained-native-managed-cog',governedDatasetId:datasetId,datasetVersionId:versionId,objectId:initial.layer.objectId,
    sourceSha256,sourceYear:2021,requestedYear:2024,nativeCells:169,identifiedValue:40,retainedAoiTouchedCells:147,
    retainedAoiAreaSquareMeters:summary.coverage.totalAreaSquareMeters,retainedOutsideWindowAreaSquareMeters:summary.coverage.outsideWindowAreaSquareMeters,
    restrictedUpload:true,workerRuns:1,catalogLayers:1,reviewedKnowledge:true,unknownOutputLicensePreserved:true,
    catalogAssignedExactVersion:true,managedCogRendered:true,normalIdentify:true,savedProjectReopened:true,
    exactPinCreditAndKnowledgeReopened:true,signedTransportNotSerialized:true,additionalProviderRequests:0,
    retainedSummaryNotRecalculated:true,fullBaselineRowsClosed:0,hostedAcceptance:false};
}

async function exerciseRetainedFtwInventory({page,project,composition,origin,worker,readApi,ftwQueryPath,work}) {
  const queryBytes=readFileSync(ftwQueryPath),retained=JSON.parse(queryBytes),sourceFeature=retained.geojson.features[0],
    sourceSha256=createHash('sha256').update(queryBytes).digest('hex');
  assert.equal(retained.geojson.features.length,1);assert.equal(sourceFeature.properties.confidence,null);
  const title='Saved FTW mapped field areas',mapUrl=`${origin}/workspaces?project=${project.id}&composition=${composition.id}`;
  await page.goto(mapUrl);
  await page.getByRole('button',{name:'Processing',exact:true}).click();
  await page.getByText('Find mapped agricultural fields…',{exact:true}).click();
  const query=page.locator('.gis-fields-of-the-world');
  await query.getByLabel('Open saved field query',{exact:true}).setInputFiles(ftwQueryPath);
  await query.getByText(/Opened a user-supplied saved query: 1 field footprint for 2024/).waitFor();
  await query.getByRole('button',{name:'Add temporary field Layer',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoLayers?.length===1);
  await page.getByLabel('Tool',{exact:true}).selectOption('field-inventory');
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.waitForFunction(()=>{
    const shell=document.querySelector('.opengeo-workbench');
    return shell?.__opengeoLayers?.some(layer=>shell.__opengeoData.get(layer.layerId)?.fieldInventory);
  });
  const measured=await page.evaluate(()=>{
    const shell=document.querySelector('.opengeo-workbench'),layer=shell.__opengeoLayers.find(layer=>shell.__opengeoData.get(layer.layerId)?.fieldInventory);
    return {layer,data:shell.__opengeoData.get(layer.layerId)};
  });
  const feature=measured.data.features[0],summary=measured.data.fieldInventory;
  assert.equal(feature.id,sourceFeature.id);assert.deepEqual(feature.geometry,sourceFeature.geometry);
  assert.deepEqual(feature.properties.source,sourceFeature.properties);assert.equal(feature.properties.source.confidence,null);
  assert(summary.totalAreaSquareMeters>0);assert.equal(summary.scope.aoiClipped,false);
  assert.equal(summary.sourceEvidence.source.etag,retained.receipt.source.etag);
  assert.equal(summary.sourceEvidence.query.year,2024);assert.equal(summary.sourceEvidence.source.license,'CC-BY-4.0');
  const registration=page.locator('section.gis-baseline-registration');
  await registration.getByLabel('Catalog Layer title',{exact:true}).fill(title);
  await registration.getByLabel('Catalog description',{exact:true}).fill('One nearby FTW 2024 predicted field footprint with its measured area. No crop, tenure or boundary accuracy conclusion.');
  await registration.getByLabel('Output distribution license (blank if unknown)',{exact:true}).fill('');
  await registration.getByLabel('Output attribution',{exact:true}).fill(retained.receipt.source.attribution);
  const registered=page.waitForResponse(response=>/\/datasets\/[^/]+\/metadata$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
  await registration.getByRole('button',{name:'Save field Layer to Catalog',exact:true}).click();
  const metadataResponse=await registered;assert.equal(metadataResponse.status(),200);
  const metadata=await metadataResponse.json(),outputId=new URL(metadataResponse.url()).pathname.split('/').at(-2);
  assert.match(outputId,/^[0-9a-f-]{36}$/);
  await registration.getByRole('status').filter({hasText:`Catalog Layer ${outputId} registered with lineage.`}).waitFor();
  const normalized=metadata.document.metadata.normalized.find(claim=>claim.method==='mapped_field_area_inventory');
  assert(normalized);assert.equal(normalized.value.schemaVersion,'opengeo.mapped-field-inventory.1.0.0');
  assert.equal(normalized.value.totalAreaSquareMeters,summary.totalAreaSquareMeters);
  assert.equal(normalized.value.sourceEvidence.source.partitionUrl,retained.receipt.source.partitionUrl);
  assert.equal(normalized.value.sourceEvidence.source.etag,retained.receipt.source.etag);
  assert.equal(normalized.value.sourceEvidence.query.year,2024);
  assert.equal(normalized.value.sourceEvidence.source.year,2024);
  assert.equal(normalized.value.sourceEvidence.localImport.providerReverified,false);
  assert.equal(normalized.value.sourceEvidence.localImport.sha256,sourceSha256);
  assert.equal(metadata.document.context[0].resourceId,retained.receipt.source.partitionUrl);
  assert.equal(metadata.document.distributions[0].custody,'derived');
  const license=metadata.document.metadata.curated.find(claim=>claim.property.endsWith('/license'));
  assert.equal(license.value,null);assert.equal(license.provenance,'unknown');
  writeFileSync(join(work,'ftw-reviewed-registration.json'),JSON.stringify({datasetId:outputId,metadata,measured},null,2)+'\n');
  await worker();
  const saved=await readApi(`/projects/${project.id}/datasets/${outputId}`);
  assert.equal(saved.status,'active');assert.equal(saved.feature_count,1);
  await registration.getByRole('button',{name:'Open Catalog for saved field Layer',exact:true}).click();
  // Account Catalog navigation deliberately discards only the two unsaved local
  // scratch Layers; the governed output/knowledge has already committed once.
  const discard=async dialog=>{assert.equal(dialog.type(),'beforeunload');await dialog.accept();};
  page.once('dialog',discard);
  try {await page.goto(`${origin}/workspaces?project=${project.id}&manage=data`);}
  finally {page.removeListener('dialog',discard);}
  const card=page.locator(`[data-dataset-id="${outputId}"]`);
  await card.getByText('Add to map…',{exact:true}).click();
  await card.getByRole('link',{name:'Add to Watershed review map',exact:true}).click();
  await page.getByRole('button',{name:`Add ${title} to map`,exact:true}).click();
  await page.locator('.gis-menubar [data-menu="view"] > button').click();
  await page.getByRole('menuitem',{name:'Change basemap',exact:true}).click();
  const basemap=page.getByRole('dialog',{name:'Change basemap',exact:true}),blank=basemap.locator('.gis-basemap-card[data-catalog-id="blank"]');
  const group=blank.locator('xpath=ancestor::details[1]');
  if(await group.getAttribute('open')===null)await group.locator('summary').click();
  await blank.click();
  await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.dataset.basemapActivationState==='active');
  await basemap.getByRole('button',{name:'Done',exact:true}).click();
  const rendered=id=>{
    const shell=document.querySelector('.opengeo-workbench'),map=shell?.__opengeoMap,
      layer=shell?.__opengeoLayers?.find(layer=>layer.datasetId===id);
    return Boolean(map?.isStyleLoaded()&&!map.isMoving()&&layer
      &&shell.__opengeoData?.get(layer.layerId)?.features?.length===1
      &&map.queryRenderedFeatures().some(feature=>feature.geometry.type==='Polygon'&&feature.layer.id.startsWith(layer.layerId)));
  };
  const readLoaded=()=>page.evaluate(id=>{
    const shell=document.querySelector('.opengeo-workbench'),layer=shell.__opengeoLayers.find(layer=>layer.datasetId===id);
    return {layers:shell.__opengeoLayers,data:shell.__opengeoData.get(layer.layerId)};
  },outputId);
  await page.waitForFunction(id=>{
    const shell=document.querySelector('.opengeo-workbench'),layer=shell?.__opengeoLayers?.find(layer=>layer.datasetId===id);
    return shell?.__opengeoData?.get(layer?.layerId)?.features?.length===1;
  },outputId);
  let loaded=await readLoaded();assert.equal(loaded.layers.length,1);assert.deepEqual(loaded.data.features[0],feature);
  await page.getByRole('button',{name:'Fit',exact:true}).click();await page.waitForFunction(rendered,outputId);
  const savedMap=page.waitForResponse(response=>response.url().endsWith(`/maps/${composition.id}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await savedMap).status(),200);
  await page.reload();
  await page.waitForFunction(rendered,outputId);
  loaded=await readLoaded();assert.equal(loaded.layers.length,1);assert.equal(loaded.layers[0].datasetId,outputId);
  assert.deepEqual(loaded.data.features[0],feature);assert.equal(loaded.data.features[0].properties.source.confidence,null);
  const reopened=await readApi(`/datasets/${outputId}/metadata`);assert.deepEqual(reopened.document,metadata.document);
  const reopenedMap=await readApi(`/projects/${project.id}/maps/${composition.id}`);
  assert.equal(reopenedMap.definition.layers.length,1);assert.equal(reopenedMap.definition.layers[0].datasetId,outputId);
  await page.screenshot({path:join(work,'ftw-saved-project-reopened.png')});
  return {mode:'retained-ftw-field-inventory',sourceFeatureId:sourceFeature.id,sourceYear:2024,sourceConfidence:null,
    governedDatasetId:outputId,featureCount:1,totalAreaSquareMeters:summary.totalAreaSquareMeters,reviewedCatalogRegistration:true,
    workerProcessed:true,catalogAssigned:true,polygonRendered:true,savedProjectReopened:true,reopenedPolygonRendered:true,
    exactGeometryAndPropertiesReopened:true,knowledgeReopened:true,unknownOutputLicensePreserved:true,
    retainedQueryOnly:true,additionalProviderRequests:0,hostedAcceptance:false};
}
