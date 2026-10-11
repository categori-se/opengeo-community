import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';

export async function exerciseAttachmentPreviews({page,context,baseUrl,appRoot}) {
  const recoveryOnly=process.env.OPENGEO_ATTACHMENT_RECOVERY_UI_ONLY==='1';
  const unknownOnly=process.env.OPENGEO_ATTACHMENT_RECONCILE_UI_ONLY==='1';
  const deviceOnly=unknownOnly || recoveryOnly || process.env.OPENGEO_ATTACHMENT_DEVICE_UI_ONLY==='1';
  const retained=process.env.OPENGEO_STUDIO_REUSE_ROOT;
  assert.ok(retained,'Provide an existing built Studio tree to reuse its worker');
  const manifest=JSON.parse(await readFile(resolve(retained,'../studio-build-manifest.json'),'utf8'));
  const workerFile=manifest.artifactTree.files.find(file=>file.path.includes('/maplibre-worker.'));
  assert.ok(workerFile);
  const worker=await readFile(resolve(retained,'app/dist',workerFile.path));
  assert.equal(createHash('sha256').update(worker).digest('hex'),workerFile.sha256,'Retained worker must match build receipt');
  const bundle=await build({stdin:{resolveDir:appRoot,contents:`
    import {FeatureAttachmentPicker} from './src/components/FeatureAttachmentPicker.js';
    import {OfflineCaptureQueue,OfflineAttachmentFiles,pendingDeviceAttachments,syncCaptureQueue} from './src/lib/offlineCapture.js';
    window.format='png';window.denied=false;window.calls=[];
    const control=document.createElement('input');window.control=control;
    const version='81000000-0000-4000-8000-000000000001';
    control.value=${deviceOnly?"''":'version'};
    const adapter={
      async requestUpload(project,metadata){sessionStorage.setItem('uploadRequests',String(Number(sessionStorage.getItem('uploadRequests')??0)+1));window.calls.push({stage:'request',project,metadata});sessionStorage.setItem('fileChecksum',metadata.checksumSha256);sessionStorage.setItem('fileSize',String(metadata.sizeBytes));if(${unknownOnly})throw Error('Unknown request outcome');return {uploadId:'91000000-0000-4000-8000-000000000001',expiresAt:'2099-01-01T00:00:00Z',upload:{}};},
      async uploadFile(ticket,file){sessionStorage.setItem('byteTransfers',String(Number(sessionStorage.getItem('byteTransfers')??0)+1));window.calls.push({stage:'bytes',name:file.name,body:await file.text()});},
      async completeUpload(){window.calls.push({stage:'complete'});if(${recoveryOnly}&&!sessionStorage.getItem('interrupted')){sessionStorage.setItem('interrupted','yes');throw Error('Lost completion response');}return {dataset:{name:'Attachment'},datasetVersionId:version,versionNumber:1};},
      async resolveFeatureAttachment(id){if(window.denied)throw Error('revoked');if(id!==version)throw Error('identity');return {versionId:version,projectId:'project',datasetId:'file',objectId:'original',name:'Attachment',versionNumber:1,format:window.format};},
      async searchDatasets(){return [{id:'file',projectId:'project',name:'Existing catalog file',status:'active',currentVersionState:'active'}];},
      async listDatasetVersions(){return [{id:version,versionNumber:1,state:'active',objects:[{id:'original',role:'original',contentType:'image/png',sizeBytes:Number(sessionStorage.getItem('fileSize')??100),checksumSha256:window.badChecksum?'0'.repeat(64):sessionStorage.getItem('fileChecksum')}]}];},
      async requestDatasetDownload(){window.calls.push('download');return {url:'https://attachment-image.invalid/image.png',expiresAt:'2099-01-01T00:00:00Z'};},
      async getDatasetDocumentPreview(project,dataset,id){if(id!==version)throw Error('identity');return {sourceFormat:'pdf',title:'Retained document',pdfVersion:'1.7',extraction:{ocrPerformed:false},pages:[{number:1,blocks:[{type:'paragraph',text:'Exact document text'}]}]};},
      async getDatasetSpatialPreview(project,dataset,id){if(id!==version)throw Error('identity');return {datasetVersionId:version,numberReturned:3,numberMatched:3,mayBeTruncated:false,geojson:{type:'FeatureCollection',features:[
        {type:'Feature',properties:{},geometry:{type:'Point',coordinates:[0.5,0.5]}},
        {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[[-1,-1],[1,1]]}},
        {type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-1,0],[0,0],[0,1],[-1,1],[-1,0]]]}}
      ]}};}
    };
    const scope={organizationId:'10000000-0000-4000-8000-000000000141',userId:'20000000-0000-4000-8000-000000000141'};
    window.queueObservation=async()=>{
      const properties={attachment:control.value};
      return new OfflineCaptureQueue().enqueue(scope,{projectId:'50000000-0000-4000-8000-000000000141',datasetId:'80000000-0000-4000-8000-000000000141',formId:'a0000000-0000-4000-8000-000000000141',formVersion:1,submissionId:'b0000000-0000-4000-8000-000000000141',
        feature:{type:'Feature',geometry:{type:'Point',coordinates:[85,27]},properties},
        deviceAttachments:pendingDeviceAttachments([{name:'attachment',type:'string',attachment:true}],properties)});
    };
    window.syncObservation=async()=>syncCaptureQueue(new OfflineCaptureQueue(),scope,async request=>{window.submitted=request;},
      {resolveDeviceAttachment:async(id,project)=>{
        const file=(await new OfflineAttachmentFiles().list(scope,project)).find(file=>file.id===id);
        if(!file?.registeredVersionId)throw Object.assign(Error('pending'),{code:'offline_attachment_pending'});
        return (await adapter.resolveFeatureAttachment(file.registeredVersionId)).versionId;
      }});
    document.querySelector('main').append(FeatureAttachmentPicker({control,adapter,projectId:'50000000-0000-4000-8000-000000000141',classification:'internal',deviceScope:{organizationId:'10000000-0000-4000-8000-000000000141',userId:'20000000-0000-4000-8000-000000000141'}}));
  `},bundle:true,format:'esm',write:false,plugins:[{name:'local-worker-url',setup(build){
    build.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'local-stdlib',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const FileAttachment=()=>({url:async()=>'/worker.js'});"}));
  }}]});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.href==='https://tiles.openfreemap.org/styles/positron')return route.fulfill({json:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]}});
    assert.ok(url.origin===baseUrl || url.href==='https://attachment-image.invalid/image.png','Unexpected external request');
    if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    if(url.pathname==='/worker.js')return route.fulfill({contentType:'text/javascript',body:worker});
    if(url.pathname==='/image.png')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNecAAAAASUVORK5CYII=','base64')});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><style>main{width:750px}.map-frame{position:relative;width:100%}.maplibregl-canvas{position:absolute;left:0;top:0}</style><main></main><script type="module" src="/bundle.js"></script>'});
  });
  page.setDefaultTimeout(15000);await page.goto(baseUrl);
  if(deviceOnly) {
    await page.getByLabel('Choose a new attachment file',{exact:true}).setInputFiles({name:'device-note.pdf',mimeType:'application/pdf',buffer:Buffer.from('retained device file bytes')});
    await page.getByRole('button',{name:'Keep file on this device',exact:true}).click();
    await page.getByText('File kept on this device.',{exact:false}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Show device files',exact:true}).click();
    await page.getByRole('button',{name:'Use device file in offline observation: device-note.pdf',exact:true}).click();
    assert.match(await page.evaluate(()=>window.control.value),/^device-file:/);
    await page.evaluate(()=>window.queueObservation());
    assert.equal((await page.evaluate(()=>window.syncObservation())).stoppedReason,'attachment_pending');
    await page.getByRole('button',{name:'Remove device file: device-note.pdf',exact:true}).click();
    await page.getByText('A queued observation still needs this device file.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Choose device file: device-note.pdf',exact:true}).click();
    await page.getByText('device-note.pdf ready for deliberate registration.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Register attachment file',exact:true}).click();
    let calls;
    if(recoveryOnly || unknownOnly) {
      await page.getByText('Registration did not complete.',{exact:false}).waitFor();
      calls=await page.evaluate(()=>window.calls);
      await page.reload();
      await page.getByRole('button',{name:'Show device files',exact:true}).click();
      await page.getByRole('button',{name:'Choose device file: device-note.pdf',exact:true}).click();
      if(unknownOnly) {
        await page.getByRole('button',{name:'Search catalog',exact:true}).click();
        await page.getByRole('button',{name:'Existing catalog file',exact:true}).click();
        await page.getByRole('button',{name:'Existing catalog file · v1',exact:true}).click();
        await page.evaluate(()=>window.badChecksum=true);
        await page.getByRole('button',{name:'Link selected catalog version to device file',exact:true}).click();
        await page.getByText('The selected original does not have the same recorded checksum',{exact:false}).waitFor();
        assert.equal((await page.evaluate(()=>window.syncObservation())).stoppedReason,'attachment_pending');
        await page.evaluate(()=>window.badChecksum=false);
        await page.getByRole('button',{name:'Link selected catalog version to device file',exact:true}).click();
        await page.getByText('Matching catalog version linked to the device file.',{exact:false}).waitFor();
      } else {
        await page.getByRole('button',{name:'Check interrupted registration',exact:true}).click();
        await page.getByText('Existing registration recovered.',{exact:false}).waitFor();
      }
    } else {
      await page.getByText('Attachment registered.',{exact:false}).waitFor();
      calls=await page.evaluate(()=>window.calls);
    }
    assert.equal(calls[0].metadata.classification,'internal');assert.equal(calls[0].metadata.filename,'device-note.pdf');
    if(!unknownOnly)assert.equal(calls[1].body,'retained device file bytes');
    await page.getByRole('button',{name:'Choose device file: device-note.pdf',exact:true}).click();
    await page.getByText('This file was already registered.',{exact:false}).waitFor();
    await page.getByRole('button',{name:'Register attachment file',exact:true}).click();
    assert.equal(await page.evaluate(()=>Number(sessionStorage.getItem('uploadRequests'))),1);
    assert.equal(await page.evaluate(()=>Number(sessionStorage.getItem('byteTransfers'))),unknownOnly?0:1);
    assert.equal((await page.evaluate(()=>window.syncObservation())).synced,1);
    assert.equal(await page.evaluate(()=>window.submitted.feature.properties.attachment),'81000000-0000-4000-8000-000000000001');
    await page.getByRole('button',{name:'Check registered file',exact:true}).click();
    await page.getByRole('button',{name:'Use Attachment · v1',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.control.value),'81000000-0000-4000-8000-000000000001');
    await page.getByRole('button',{name:'Remove device file: device-note.pdf',exact:true}).click();
    await page.getByText('Device copy removed.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.control.value),'81000000-0000-4000-8000-000000000001');
    assert.deepEqual(errors,[]);
    const result={status:'pass',interruptedRegistrationRecoveredAfterReload:recoveryOnly,checksumReconciliation:unknownOnly,mismatchRejected:unknownOnly,requestCount:1,byteTransfers:unknownOnly?0:1,fileRetainedAcrossReload:true,restoredBytesRegistered:!unknownOnly,classificationPreserved:true,
      exactRegisteredVersionSelected:true,removingLocalCopyPreservesReference:true,pendingObservationReplayed:true,duplicateUploadAvoided:true,neededFileRemovalRefused:true,
      limits:'Real component and IndexedDB; synthetic upload and activation responses, no live worker/API, full capture-page or automatic reconnect upload claim.',componentBundles:1,applicationBuilds:0,cloudCalls:0};
    const dir=resolve(appRoot,'../.local-archives/feature-attachments-20260925');await mkdir(dir,{recursive:true});
    await writeFile(resolve(dir,unknownOnly?'device-reconciliation.json':recoveryOnly?'device-recovery.json':'pending-device-picker.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return;
  }
  const preview=page.getByRole('button',{name:'Preview selected file',exact:true});
  await preview.click();await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth===1);
  await page.evaluate(()=>window.format='pdf');await preview.click();await page.getByText('Exact document text',{exact:true}).waitFor();
  await page.evaluate(()=>window.format='geojson');await preview.click();
  await page.getByText('Layer view ready. Pan and zoom to explore.',{exact:true}).waitFor();
  const dir=resolve(appRoot,'../.local-archives/feature-attachments-20260925/preview-browser');await mkdir(dir,{recursive:true});
  const screenshot=resolve(dir,'mixed-vector.png');await page.locator('canvas.maplibregl-canvas').screenshot({path:screenshot});
  const pixels=JSON.parse(execFileSync('python',['-c',`from PIL import Image
import json,sys
p=list(Image.open(sys.argv[1]).convert('RGB').getdata())
print(json.dumps({'blue':sum(b>r+30 and b>g+10 for r,g,b in p),'green':sum(g>r+10 and g>b+5 for r,g,b in p)}))`,screenshot],{encoding:'utf8'}));
  assert.ok(pixels.blue>30 && pixels.green>30,JSON.stringify(pixels));
  await page.evaluate(()=>window.denied=true);await preview.click();await page.getByText('Preview unavailable or file access has changed. The saved reference is preserved.',{exact:true}).waitFor();
  assert.equal(await page.locator('canvas').count(),0);assert.deepEqual(errors,[]);
  const result={status:'pass',imageDecoded:true,documentTextRendered:true,mixedVectorPixels:pixels,revocationClearsPreview:true,
    limits:'Real Chromium component/WebGL rendering with synthetic adapters, local image and intercepted basemap. No actual preview API, deployed or device claim.',applicationBuilds:0,componentBundles:1,cloudCalls:0};
  await writeFile(resolve(dir,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}

export async function exercisePublicDemoCapture({page,context,baseUrl,appRoot}) {
  const compiledRoot=process.env.OPENGEO_PUBLIC_DEMO_CAPTURE_COMPILED_ROOT;
  let bundle,worker,css,compiledManifest,compiledFiles;
  if(compiledRoot) {
    compiledManifest=JSON.parse(await readFile(resolve(compiledRoot,'../../../dist/opengeo-demo-build.json'),'utf8'));
    assert.equal(compiledManifest.schemaVersion,'opengeo.demo-build.1.0.0');
    compiledFiles=new Map(compiledManifest.artifactTree.files.map(file=>[file.path,file]));
    assert.ok(compiledFiles.has('index.html'),'Compiled Demo must have a sealed index');
  } else {
    const retained=process.env.OPENGEO_STUDIO_REUSE_ROOT;
    assert.ok(retained,'Reuse an existing renderer worker');
    const manifest=JSON.parse(await readFile(resolve(retained,'../studio-build-manifest.json'),'utf8'));
    const workerFile=manifest.artifactTree.files.find(file=>file.path.includes('/maplibre-worker.'));
    worker=await readFile(resolve(retained,'app/dist',workerFile.path));
    assert.equal(createHash('sha256').update(worker).digest('hex'),workerFile.sha256);
    const data=await Promise.all(['public-demo-catalog.json','sample-public-facilities.geojson','massgis-enviroscreen.json']
      .map(name=>readFile(resolve(appRoot,'src/data',name),'utf8').then(JSON.parse)));
    bundle=await build({stdin:{resolveDir:appRoot,contents:`
      import {PublicDemoWorkbench} from './src/components/PublicDemoWorkbench.js';
      const [catalog,geojson,massgis]=${JSON.stringify(data)};
      document.querySelector('main').append(PublicDemoWorkbench({catalog,geojson,massgis}));
    `},bundle:true,format:'esm',write:false,plugins:[{name:'local-worker',setup(build){
      build.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'stdlib',namespace:'local'}));
      build.onLoad({filter:/.*/,namespace:'local'},()=>({contents:"export const FileAttachment=()=>({url:async()=>'/worker.js'});"}));
    }}]});
    css=await readFile(resolve(appRoot,'src/style.css'),'utf8');
  }
  const errors=[],privateRequests=[],servedAssets=new Set();
  const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json',
    '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
    '.wasm':'application/wasm','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'};
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(/\/api\/|auth-config|login/.test(url.pathname))privateRequests.push(url.href);
    if(url.origin!==baseUrl) {
      if(url.pathname.includes('/styles/'))return route.fulfill({json:{version:8,sources:{},layers:[]}});
      return route.abort();
    }
    if(compiledRoot) {
      // No PWA claim: keep this bounded journey on intercepted, sealed assets.
      if(url.pathname==='/service-worker.js')return route.abort();
      let path;try {path=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';}catch{return route.abort();}
      const file=compiledFiles.get(path);
      if(!file)return route.fulfill({status:404,body:'Unsealed asset'});
      const body=await readFile(resolve(compiledRoot,path));
      assert.equal(createHash('sha256').update(body).digest('hex'),file.sha256,`Compiled Demo asset changed: ${path}`);
      servedAssets.add(path);
      return route.fulfill({contentType:types[extname(path)]??'application/octet-stream',body});
    }
    if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    if(url.pathname==='/worker.js')return route.fulfill({contentType:'text/javascript',body:worker});
    if(url.pathname==='/style.css')return route.fulfill({contentType:'text/css',body:css});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>:root{font-family:system-ui;--theme-background:#fff;--theme-background-alt:#f5f5f5;--theme-foreground:#111;--theme-foreground-muted:#555;--theme-foreground-faintest:#ccc;--theme-foreground-focus:#165cbd}</style><main></main><script type="module" src="/bundle.js"></script>'});
  });
  page.setDefaultTimeout(15000);await page.setViewportSize({width:1440,height:900});await page.goto(baseUrl);
  const open=async()=>{
    if(page.viewportSize().width<=820) {
      await page.getByRole('button',{name:'Actions',exact:true}).click();
      await page.locator('.gis-mobile-command-sheet').getByRole('button',{name:'Try field capture',exact:true}).click();
    } else await page.getByRole('button',{name:'Try field capture',exact:true}).click();
  };
  try {await open();} catch(error) {
    console.error(JSON.stringify({stage:'compiled-demo-open',pageErrors:errors,servedSealedAssets:servedAssets.size,
      visibleErrors:await page.locator('.observablehq--error').allTextContents()}));
    throw error;
  }
  const dialog=page.getByRole('dialog',{name:'Try field capture',exact:true});
  await dialog.getByText(/nothing reaches an account/i).first().waitFor();
  await dialog.getByRole('button',{name:'Place point on map',exact:true}).click();
  const canvas=dialog.locator('.project-feature-canvas');
  await canvas.getByRole('button',{name:'Draw new',exact:true}).click();
  const drawingCanvas=canvas.locator('.maplibregl-canvas');await drawingCanvas.waitFor();
  const drawingBox=await drawingCanvas.boundingBox();assert.ok(drawingBox);
  await drawingCanvas.click({position:{x:drawingBox.width*.65,y:drawingBox.height*.4}});
  const drawnGeometry=JSON.parse(await dialog.getByLabel('Field observation GeoJSON geometry',{exact:true}).inputValue());
  assert.equal(drawnGeometry.type,'Point');assert.equal(drawnGeometry.coordinates.length,2);
  assert.ok(drawnGeometry.coordinates.some(value=>value!==0),'Drawing must update the form location');
  await dialog.getByRole('button',{name:'Hide drawing map',exact:true}).click();
  const picker=dialog.locator('.project-feature-attachment');
  const showFileOptions=async()=>{
    const options=picker.locator('.project-feature-attachment-file-options');
    if(!await options.evaluate(element=>element.open))await options.locator('summary').click();
  };
  await showFileOptions();
  const filename='demo-capture.geojson';
  await picker.getByLabel('Choose a new attachment file',{exact:true}).setInputFiles({name:filename,mimeType:'application/geo+json',
    buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[85,27]}}]}))});
  await picker.getByRole('button',{name:'Keep file on this device',exact:true}).click();
  await picker.getByText(/File kept on this device/).waitFor();
  await picker.getByRole('button',{name:'Show device files',exact:true}).click();
  await picker.getByRole('button',{name:`Use device file in offline observation: ${filename}`,exact:true}).click();
  await dialog.getByLabel('Feature property observation',{exact:true}).fill('Browser survey');
  await dialog.getByRole('button',{name:'Save to device queue',exact:true}).click();
  await dialog.getByText(/Draft saved in this tab/).waitFor();
  await picker.getByRole('button',{name:`Choose device file: ${filename}`,exact:true}).click();
  await picker.getByRole('button',{name:'Register attachment file',exact:true}).click();
  await picker.getByText(/demo-capture registered/).waitFor();
  await dialog.getByRole('button',{name:'Sync device queue',exact:true}).click();
  await dialog.getByRole('button',{name:'Start review',exact:true}).click();
  await dialog.getByRole('button',{name:'Accept and promote',exact:true}).click();
  await dialog.getByText(/ · accepted · /).waitFor();
  await dialog.getByRole('button',{name:'Close field capture',exact:true}).click();await open();
  await dialog.getByText(/ · accepted · /).waitFor();
  const out=resolve(appRoot,'../.local-archives/feature-attachments-20260925/public-demo-capture');await mkdir(out,{recursive:true});
  const layouts=[];
  for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await dialog.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Dialog must fit viewport');
    const close=dialog.getByRole('button',{name:'Close field capture',exact:true});
    const box=await close.boundingBox();const frame=await dialog.boundingBox();
    assert.ok(box&&frame&&box.y>=Math.max(0,frame.y)-1&&box.y+box.height<=Math.min(viewport.height,frame.y+frame.height)+1,'Close must remain visible after scrolling');
    assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1,'Close must fit viewport');
    layouts.push({...viewport,closeVisibleAfterScroll:true,noHorizontalOverflow:true});
    await page.screenshot({path:resolve(out,`capture-${viewport.width}x${viewport.height}.png`)});
  }
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.setViewportSize({width:390,height:844});await page.reload();await open();
  await dialog.getByText('Review queue · 0 submissions',{exact:true}).waitFor();
  await showFileOptions();
  await picker.getByRole('button',{name:'Show device files',exact:true}).click();
  await picker.getByText('No device files are retained for this project.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(async()=> (await indexedDB.databases()).some(db=>db.name==='opengeo-field-capture-v1')),false);
  assert.deepEqual(errors,[]);assert.deepEqual(privateRequests,[]);
  const result={status:'pass',publicWorkbenchEntry:true,sharedCaptureRegistrationAndPromotion:true,
    pointDrawingUpdatesLocation:true,closeAndReopenRetainsRecords:true,reloadClearsRecordsAndFiles:true,noDurableCaptureDatabase:true,
    layouts,escapeCloses:true,privateApiRequests:0,externalProvidersContacted:0,
    componentBundles:compiledRoot?0:1,applicationBuilds:0,compiledDemo:!!compiledRoot,
    ...(compiledRoot?{servedSealedAssets:servedAssets.size,artifactDigest:compiledManifest.artifactTree.digest}:{}),
    limits:compiledRoot?'Actual compiled Demo assets in Chromium; simulated capture backend, interrupted service-worker registration and intercepted basemap; no deployed/PWA/device GPS acceptance.':'Source-bundled public component and real Chromium; simulated capture backend and local intercepted basemap, no deployed acceptance.'};
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
