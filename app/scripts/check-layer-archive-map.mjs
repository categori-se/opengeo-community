// Built Workbench interaction with intercepted live/S3 peers; no external traffic.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {unzipSync,strFromU8,gunzipSync} from 'fflate';
let config=null;
if(process.argv.includes('--connected')){let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);}
const apiCalls=[];
const deployed=process.argv.includes('--deployed');let deployedRequests=0;
const dist=resolve('dist'), origin='https://archive-map.invalid', out=resolve('../.local-archives/layer-archive-map',process.argv.includes('--null-geometry')?'null-geometry':'.',deployed?'deployed':'.');
await mkdir(out,{recursive:true});
const file=(await readdir(resolve(dist,'_import/components'))).find(x=>x.startsWith('WorkbenchView.')&&x.endsWith('.js'));
const clientFile=(await readdir(resolve(dist,'_import/lib'))).find(x=>x.startsWith('apiClient.')&&x.endsWith('.js'));
const data={type:'FeatureCollection',features:[{type:'Feature',properties:{OBJECTID:7},geometry:{type:'Point',coordinates:[90,27]}}]};
let body=Buffer.from(JSON.stringify(data));const sha=createHash('sha256').update(body).digest('hex');
const object={bucket:'fixture',prefix:'private/',key:'private/a.geojson',version_id:'v1',expected_owner:'123456789012',size_bytes:body.length,decoded_size_bytes:body.length,sha256:sha,decoded_sha256:sha,encoding:'identity',feature_count:1,ticket:{method:'GET',url:'https://s3.us-east-1.amazonaws.com/fixture/private/a.geojson?versionId=v1&X-Amz-Signature=offline',headers:{'x-amz-expected-bucket-owner':'123456789012'}}};
const record={id:'archive-1',title:'Reviewed capture',captured_at:'2026-09-20T00:00:00Z',dataset_id:'80000000-0000-4000-8000-000000000088',source_version:1,source_url:'https://provider.invalid/FeatureServer/0',format:'geojson',download_bytes:body.length,decoded_bytes:body.length,feature_count:1,attribution:'Fixture source',rights:{license:null},objects:[object]};
if(config){Object.assign(record,{id:config.archiveId,dataset_id:config.datasetId,source_url:config.sourceUrl});}
const historicalIndex=process.argv.indexOf('--historical-layer');
let historicalId=historicalIndex<0?null:process.argv[historicalIndex+1];
let geometryType='Point',historicalFeatures=null;
if(historicalId){
 assert.ok(['3','4'].includes(historicalId));assert.equal(config,null);
 const work=resolve('../.local-archives/bhutan-local-20260920');
 const historical=JSON.parse(await readFile(resolve(work,'icimod-historical-reconciliation.json'))).results.find(x=>x.sourceUrl.endsWith(`/Basemap/MapServer/${historicalId}`));
 const review=JSON.parse(await readFile(resolve(work,'archive-copy-local-review.json'))).results.find(x=>x.sourceUrl===historical.sourceUrl);
 assert.equal(review.status,'local-content-verified');
 body=await readFile(resolve('..',historical.path));
 const obj=review.descriptor.objects[0];
 historicalFeatures=JSON.parse(strFromU8(obj.encoding==='gzip'?gunzipSync(body):body)).features;
 const draft=JSON.parse(await readFile(resolve(work,'catalog-drafts.json'))).drafts.find(x=>x.sourceUrl===historical.sourceUrl);
 geometryType=draft.request.source.geometry_type;
 Object.assign(record,{dataset_id:review.datasetId,source_url:historical.sourceUrl,feature_count:review.featureCount,
  captured_at:review.capturedAt,download_bytes:obj.size_bytes,decoded_bytes:obj.decoded_size_bytes,objects:[{...obj,
   ticket:{method:'GET',url:`https://s3.us-east-1.amazonaws.com/${obj.bucket}/${obj.key}?versionId=${encodeURIComponent(obj.version_id)}&X-Amz-Signature=offline`,headers:{'x-amz-expected-bucket-owner':obj.expected_owner}}}]});
}
if(process.argv.includes('--null-geometry')) {
 assert.equal(config,null);assert.equal(historicalId,null);historicalId='nsdi-bridges';
 const work=resolve('../.local-archives/bhutan-local-20260920');
 const plan=JSON.parse(await readFile(resolve(work,'nsdi-original-choices-remaining/archive-admission.json')));
 const reviewed=plan.records.find(x=>x.descriptor.provenance.sourceUrl.endsWith('/Hosted/Bridges_view/FeatureServer/0'));
 assert.ok(reviewed);const obj=reviewed.descriptor.objects[0];
 body=await readFile(resolve('/home/aaron/framework/bhutan_ai/src',reviewed.descriptor.provenance.originalPath));
 historicalFeatures=JSON.parse(body).features;assert.equal(historicalFeatures.filter(f=>f.geometry===null).length,7);
 Object.assign(record,{dataset_id:reviewed.dataset_id,source_url:reviewed.descriptor.provenance.sourceUrl,feature_count:obj.feature_count,captured_at:null,
  download_bytes:obj.size_bytes,decoded_bytes:obj.decoded_size_bytes,objects:[{...obj,ticket:{method:'GET',url:`https://s3.us-east-1.amazonaws.com/${obj.bucket}/${obj.key}?versionId=${encodeURIComponent(obj.version_id)}&X-Amz-Signature=offline`,headers:{'x-amz-expected-bucket-owner':obj.expected_owner}}}]});
}

let browser,live=0,gets=0;const errors=[],blocked=[];
try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===new URL(record.source_url).origin){live++;return route.fulfill({status:503,contentType:'application/json',body:'{}',headers:{'access-control-allow-origin':'*'}});}
  if(u.origin==='https://s3.us-east-1.amazonaws.com'){
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET','access-control-allow-headers':'x-amz-expected-bucket-owner'}});
   gets++;return route.fulfill({status:200,body,headers:{'content-type':'application/geo+json','access-control-allow-origin':'*'}});
  }
  if(config && u.origin===origin && u.pathname.startsWith('/api/')){
   const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}${u.pathname.slice(4)}${u.search}`});
   apiCalls.push({method:route.request().method(),path:u.pathname,status:response.status()});
   return route.fulfill({response});
  }
  if(u.origin!==origin){blocked.push(u.origin);return route.abort();}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0;height:100%;background:#061526;color:white}.opengeo-workbench{height:100vh}</style><script type="module">
   import {WorkbenchView} from '/_import/components/${file}';
   ${config ? `import {OpenGeoApiClient} from '/_import/lib/${clientFile}';` : ''}
   const record=${JSON.stringify(record)};
   const client=${config ? `new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'editor',organizationProvider:()=> '${config.organizationId}'})` : 'null'};
   const projectId=${JSON.stringify(config?.workspaceId ?? '50000000-0000-4000-8000-000000000088')};
   const layer={layerId:'fixture',datasetId:record.dataset_id,title:'Fixture live layer',sourceType:'external-feature-reference',sourceVersion:1,sourceUrl:record.source_url,sourceConfiguration:{objectIdField:'OBJECTID',fields:['OBJECTID'],geometryType:${JSON.stringify(geometryType)},pageSize:100,attribution:'Fixture'},geometryType:${JSON.stringify(geometryType)},visible:false,opacity:1,order:0,style:{},labels:{enabled:false}};
   const initial={schemaVersion:'opengeo.map-definition.1.3.0',layers:[layer],mapViews:[{id:'default',title:'Default',center:[90,27],zoom:6,pitch:0,bearing:0}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:'fixture'};
   const definition=JSON.parse(sessionStorage.getItem('archive-map-saved')||'null')||initial;
   window.probe={lists:0,reads:0,saves:[]};
   window.shell=WorkbenchView({workspace:{workspaceId:'50000000-0000-4000-8000-000000000088',title:'Archive map'},project:definition,layers:definition.layers,role:'owner',mapVersion:1,persistenceMode:'api',
    layerArchiveAccess:{assertScope:async()=>{},authorize:async()=>{},list:async()=>{probe.lists++;return client ? client.listLayerArchives(projectId,record.dataset_id) : {dataset_id:record.dataset_id,source_version:1,archives:[record]};},read:async()=>{probe.reads++;return client ? client.readLayerArchive(projectId,record.dataset_id,record.id) : record;}},
    saveProject:async value=>{probe.saves.push(value);sessionStorage.setItem('archive-map-saved',JSON.stringify(value));return{id:'60000000-0000-4000-8000-000000000088',version:2,definition:value};}});
   document.body.append(shell);
  </script>`});
  try{
   const path=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);
   let asset=await readFile(path);
   if(deployed && u.pathname.startsWith('/_')) {
    assert.ok(++deployedRequests<=300);
    const response=await route.fetch({url:'https://studio.opengeo.tools'+u.pathname,timeout:30000,maxRedirects:0});
    assert.equal(response.status(),200);const actual=await response.body();
    assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(asset).digest('hex'));asset=actual;
   }
   return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream',body:asset});
  }catch{blocked.push(u.pathname);return route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());
 assert.equal(live,0);assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.lists),0);
 const checkMapOnly=async(label)=>{
  const before=await page.locator('.opengeo-workbench').getAttribute('class');
  if(await page.locator('.gis-menubar [data-menu="controls"] > button').isVisible()) await page.locator('.gis-menubar [data-menu="controls"] > button').click();
   else { await page.getByRole('button',{name:'Actions',exact:true}).click(); await page.locator('[data-mobile-command-category="controls"] > summary').click(); }
  await page.getByRole('menuitem',{name:'Map only',exact:true}).click();
  assert.equal(await page.locator('.gis-map-control-stack').count(),0);
  for(const selector of ['.gis-panel-left','.gis-panel-right','.gis-mobile-toolbar','.gis-statusbar','.gis-panel-resizers'])assert.equal(await page.locator(selector).isVisible(),false);
  const fit=await page.evaluate(()=>{const shellBox=shell.getBoundingClientRect(),map=shell.querySelector('.gis-map').getBoundingClientRect();return Math.abs(shellBox.width-map.width)<3&&map.top>=shell.querySelector('.gis-topbar').getBoundingClientRect().bottom-1;});
  assert.equal(fit,true);
  await page.screenshot({path:resolve(out,`map-only-${label}.png`)});
  if(label==='desktop')await page.keyboard.press('Escape');
  else {if(await page.locator('.gis-menubar [data-menu="controls"] > button').isVisible()) await page.locator('.gis-menubar [data-menu="controls"] > button').click();
   else { await page.getByRole('button',{name:'Actions',exact:true}).click(); await page.locator('[data-mobile-command-category="controls"] > summary').click(); }await page.getByRole('menuitem',{name:'Show panels and tools',exact:true}).click();}
  assert.equal(await page.locator('.opengeo-workbench').getAttribute('class'),before);
 };
 await page.getByRole('button',{name:'Show inspector',exact:true}).click();
 await checkMapOnly('desktop');
 assert.equal(await page.locator('.gis-panel-right').isVisible(),true);
 await page.getByRole('button',{name:'Collapse inspector',exact:true}).click();
 if(process.argv.includes('--mobile-controls')) {
  const checkHelpFit=async(label)=>{
   await page.locator('.gis-camera-help > summary').click();
   await page.locator('.gis-map-view-help > summary').click();
   const fit=await page.locator('.gis-map-control-stack').evaluate(el=>{
    const box=el.getBoundingClientRect(),map=el.parentElement.getBoundingClientRect();
    return {horizontal:el.scrollWidth<=el.clientWidth+1,inside:box.left>=map.left&&box.right<=map.right+1&&box.top>=map.top&&box.bottom<=map.bottom+1,
     text:[...el.querySelectorAll('p')].every(p=>{const b=p.getBoundingClientRect();return b.left>=box.left&&b.right<=box.right;})};
   });
   assert.deepEqual(fit,{horizontal:true,inside:true,text:true});
   await page.screenshot({path:resolve(out,`controller-help-${label}.png`)});
   await page.locator('.gis-map-view-help > summary').click();
   await page.locator('.gis-camera-help > summary').click();
  };
  await checkHelpFit('desktop');
  const controlsAction=async name=>{if(await page.locator('.gis-menubar [data-menu="controls"] > button').isVisible()) await page.locator('.gis-menubar [data-menu="controls"] > button').click();
   else { await page.getByRole('button',{name:'Actions',exact:true}).click(); await page.locator('[data-mobile-command-category="controls"] > summary').click(); }await page.getByRole('menuitem',{name,exact:true}).click();};
  await page.setViewportSize({width:390,height:844});
  await controlsAction('Hide map controls');
  assert.equal(await page.locator('.gis-map-chrome').isVisible(),false);
  await controlsAction('Show map controls');
  await checkHelpFit('phone');
  await checkMapOnly('phone');
  await controlsAction('Hide map controls');
  const cdp=await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  assert.deepEqual(await page.evaluate(()=>({pan:shell.__opengeoMap.dragPan.isEnabled(),zoom:shell.__opengeoMap.touchZoomRotate.isEnabled(),pitch:shell.__opengeoMap.touchPitch.isEnabled()})),{pan:true,zoom:true,pitch:true});
  const canvas=await page.locator('.maplibregl-canvas').boundingBox();
  const x=Math.round(canvas.x+canvas.width/2),y=Math.round(canvas.y+canvas.height/2);
  const center=await page.evaluate(()=>shell.__opengeoMap.getCenter().toArray());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i*10,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(before=>JSON.stringify(shell.__opengeoMap.getCenter().toArray())!==JSON.stringify(before),center);
  await page.evaluate(()=>shell.__opengeoMap.stop());
  const zoom=await page.evaluate(()=>shell.__opengeoMap.getZoom());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-20,y,id:0},{x:x+20,y,id:1}]});
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-20-i*7,y,id:0},{x:x+20+i*7,y,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(before=>shell.__opengeoMap.getZoom()>before,zoom);
  await page.evaluate(()=>shell.__opengeoMap.stop());
  await page.setViewportSize({width:844,height:390});
  await controlsAction('Show map controls');await checkHelpFit('landscape');
  await checkMapOnly('landscape');
  await controlsAction('Hide map controls');
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await cdp.detach();
  await page.setViewportSize({width:1440,height:1000});
  await controlsAction('Show map controls');
  assert.equal(await page.locator('.gis-map-controls-toggle').count(),0);
  await page.evaluate(center=>shell.__opengeoMap.jumpTo({center,zoom:7}),center);
  assert.equal(live,0);assert.equal(gets,0);
 }

 await page.getByLabel('Show Fixture live layer',{exact:true}).check();
 await page.waitForFunction(()=>document.body.textContent.includes('live view unavailable'));assert.ok(live>0);assert.equal(gets,0);
 await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
 await page.getByText('Live / archived copy',{exact:true}).click();
 await page.getByRole('button',{name:'Review available archives',exact:true}).click();
 await page.getByText(/download bytes/).waitFor();
 if(historicalId==='3')await page.getByText(/Capture date not recorded/).waitFor();assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.reads),0);
 assert.equal(await page.getByRole('button',{name:'Use selected archived copy',exact:true}).isEnabled(),false);
 await page.getByLabel(/Download the selected copy from S3/).check();
 await page.getByRole('button',{name:'Use selected archived copy',exact:true}).click();
 await page.getByRole('dialog').getByText(new RegExp(`${record.feature_count.toLocaleString()} verified features`)).waitFor();assert.equal(gets,1);
 await page.waitForFunction(()=>{const map=shell.__opengeoMap;const ids=map.getStyle().layers.filter(l=>l.source==='fixture-source').map(l=>l.id);return ids.length && map.queryRenderedFeatures({layers:ids}).length>0;});
 if(historicalFeatures){
  const actual=await page.evaluate(()=>shell.__opengeoData.get('fixture').features);
  assert.deepEqual(actual,historicalFeatures);
  const empty=historicalFeatures.filter(f=>f.geometry===null||f.geometry.coordinates.length===0).length;
  assert.equal(await page.evaluate(()=>shell.__opengeoData.get('fixture').opengeo.unlocatedFeatureCount),empty);
  if(empty)await page.getByText(`${empty} records have no map location; their attributes are retained.`,{exact:false}).waitFor();
  await page.screenshot({path:resolve(out,`historical-${historicalId}-render.png`)});
 }
 await page.screenshot({path:resolve(out,'archive-dialog.png')});
 const beforeResize=live;
 await page.setViewportSize({width:390,height:844});
 const bounds=await page.getByRole('dialog').boundingBox();assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=391 && bounds.y+bounds.height<=845);
 await page.screenshot({path:resolve(out,'archive-dialog-phone.png')});
 await page.setViewportSize({width:1440,height:1000});assert.equal(live,beforeResize);
 await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
 await page.getByRole('button',{name:'Show inspector',exact:true}).click();
 await page.getByText('Archived copy: download includes data and capture provenance in a ZIP file.',{exact:true}).waitFor();
 for(const format of historicalFeatures ? [] : ['geojson','wkt','wkb']){
  await page.getByLabel('Layer interchange export format',{exact:true}).selectOption(format);
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download layer',exact:true}).click();
  const download=await downloadPromise;assert.ok(download.suggestedFilename().endsWith('.zip'));
  const files=unzipSync(await readFile(await download.path()));
  const meta=JSON.parse(strFromU8(files['provenance.json']));
  assert.equal(meta.capture.archiveId,record.id);assert.equal(meta.capture.authoritativeUrl,record.source_url);
  assert.equal(meta.export.sha256,createHash('sha256').update(files[meta.export.filename]).digest('hex'));
  assert.ok(!strFromU8(files['provenance.json']).includes('X-Amz'));
  if(format==='geojson')assert.equal(JSON.parse(strFromU8(files[meta.export.filename])).features[0].properties.OBJECTID,7);
 }
 assert.equal(gets,1);
 await checkMapOnly('archive');assert.equal(gets,1);
 await page.getByRole('button',{name:'Collapse inspector',exact:true}).click();
 const before=live;await page.evaluate(()=>shell.__opengeoMap.panBy([40,0],{duration:0}));
 await page.waitForFunction(()=>!shell.__opengeoMap.isMoving());assert.equal(live,before);
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>probe.saves.length===1);
 const saved=await page.evaluate(()=>probe.saves[0]);assert.equal(saved.layers[0].sourceType,'external-feature-reference');assert.equal(saved.layers[0].sourceUrl,record.source_url);
 assert.ok(!JSON.stringify(saved).includes('X-Amz')&&!JSON.stringify(saved).includes('private/a.geojson'));
 await page.screenshot({path:resolve(out,'archive-map.png')});
 await page.getByText('Live / archived copy',{exact:true}).click();
 await page.getByRole('button',{name:'Return to live',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent.includes('live view unavailable'));assert.ok(live>before);assert.equal(gets,1);
 await page.reload();await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(gets,1);assert.equal(await page.evaluate(()=>probe.reads),0);
 assert.equal(await page.getByLabel('Show Fixture live layer',{exact:true}).isChecked(),true);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 if(config){assert.ok(apiCalls.some(x=>x.method==='GET'&&x.path.endsWith('/archives')&&x.status===200));assert.ok(apiCalls.some(x=>x.method==='POST'&&x.path.endsWith('/read')&&x.status===200));}
 const result={status:'passed',connectedArchiveHttp:Boolean(config),apiCalls:apiCalls.length,builtWorkbench:true,mapOnlyRestoresPanels:true,archiveExportProvenance:!historicalFeatures,historicalCapture:historicalId,historicalFeaturesPreserved:historicalFeatures?.length??null,mobileControls:process.argv.includes('--mobile-controls'),initialLayersOff:true,liveFailureDoesNotReadArchive:true,metadataOnlyReview:true,explicitCostAction:true,desktopAndPhoneDialog:true,verifiedArchiveRendered:true,noLiveRefreshInArchiveMode:true,returnToLive:true,saveKeepsLiveIdentity:true,reopenDoesNotReadArchive:true,externalRequests:0,scope:config?'Built Workbench and real archive HTTP/runtime database; intercepted live/storage, synthetic sign-in, not production or full workspace hosting':'Intercepted live/storage and archive API callbacks; separate database evidence, not production or connected HTTP acceptance'};
 Object.assign(result,{deployedAssets:deployed,deployedAssetRequests:deployedRequests,authenticatedBrowser:false});
 await writeFile(resolve(out,historicalId?`historical-${historicalId}-result.json`:'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();}
