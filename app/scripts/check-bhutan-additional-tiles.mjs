// Real PMTiles range reads and built Workbench rendering, entirely local transport.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const root=resolve('..'),out=resolve(process.argv[2]);
const isolate=process.argv.includes('--isolate-polygons');
const renderTimeout=Number(process.argv.find(x=>x.startsWith('--render-timeout-ms='))?.split('=')[1]??45000);
assert.ok(Number.isInteger(renderTimeout)&&renderTimeout>=45000&&renderTimeout<=120000);
const receiptPath=resolve(out,isolate?'isolated-polygons-browser.json':'browser-check.json');assert.ok(!existsSync(receiptPath),'Inspect prior receipt before repeating');
const bytes=await readFile(resolve(out,'display.pmtiles')),review=JSON.parse(await readFile(resolve(out,'mvt-content-verification.json')));
assert.equal(review.status,'passed');assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const build=JSON.parse(await readFile(resolve(out,'receipt.json')));
const selectedView=process.argv.find(x=>x.startsWith('--view='))?.slice('--view='.length).split(',').map(Number);
if(selectedView)assert.ok(selectedView.length===3&&selectedView.every(Number.isFinite)&&Math.abs(selectedView[0])<=180&&Math.abs(selectedView[1])<85);
const view=selectedView?{center:selectedView.slice(0,2),zoom:selectedView[2]}:build.browserView??{center:[90.45,27.5],zoom:7};
assert.ok(Array.isArray(view.center)&&view.center.length===2&&view.center.every(Number.isFinite));
assert.ok(Number.isFinite(view.zoom)&&view.zoom>=0&&view.zoom<=22);
const reviewTitle=build.sourceUrl?.includes('Building_footprint')?'Archived building footprints':'Reviewed archived layer';
const selectedDist=process.argv.find(x=>x.startsWith('--dist='))?.slice('--dist='.length);
const dist=resolve(selectedDist??'dist');
assert.ok(dist===resolve('dist')||dist.startsWith(resolve('../.local-archives')+'/'));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://transmission-review.invalid',archive=origin+'/cadastral.pmtiles';
const receipt={status:'running',requests:0,rangeBytes:0,maximumResponseBytes:0,externalRequests:0,errors:[],outputSha256:review.outputSha256,limits:{perViewRequests:100,perViewBytes:32*1024**2,responseBytes:8*1024**2,totalRequests:1600,totalBytes:32*1024**2},views:[]};
receipt.renderTimeoutMilliseconds=renderTimeout;
receipt.initialView=view;
receipt.workbenchModule={path:module,sha256:createHash('sha256').update(await readFile(resolve(dist,'_import/components',module))).digest('hex')};
let page;
const beginView=name=>receipt.views.push({name,requests:0,rangeBytes:0});
beginView('overview');
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin){receipt.externalRequests++;return route.abort();}
  if(u.pathname==='/cadastral.pmtiles'){
   const range=route.request().headers().range;assert.match(range,/^bytes=\d+-\d+$/);
   const [low,high]=range.slice(6).split('-').map(Number);assert.ok(low>=0&&high>=low&&high<bytes.length);
   const body=bytes.subarray(low,high+1);receipt.requests++;receipt.rangeBytes+=body.length;
   receipt.maximumResponseBytes=Math.max(receipt.maximumResponseBytes,body.length);
   const current=receipt.views.at(-1);current.requests++;current.rangeBytes+=body.length;
   if(current.requests>100||current.rangeBytes>32*1024**2||body.length>8*1024**2||receipt.requests>1600||receipt.rangeBytes>32*1024**2){
    receipt.errors.push(`Local range budget exceeded: ${JSON.stringify(current)}, response=${body.length}`);
    await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');
    return route.abort();
   }
   return route.fulfill({status:206,body,headers:{'content-type':'application/octet-stream','content-range':`bytes ${low}-${high}/${bytes.length}`,'accept-ranges':'bytes','etag':`"${review.outputSha256}"`}});
  }
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><button id="open">Open reviewed archive</button><script type="module">
  import {WorkbenchView} from '/_import/components/${module}';
  document.querySelector('#open').onclick=()=>{const layers=${JSON.stringify((build.tileLayers??[{source_layer:'data',geometry_type:build.geometryType}]).map(x=>[x.source_layer,x.source_layer,x.geometry_type]))}.map(([id,sourceLayer,geometryType],order)=>({layerId:id,title:sourceLayer,datasetId:'499a9aae-6a21-4ed2-a8b9-f29b435ea6fa',sourceType:'pmtiles-vector',sourceUrl:${JSON.stringify(archive)},sourceLayer,geometryType,visible:true,opacity:1,order,style:{stroke:'#39a6ff',strokeWidth:2,circleColor:'#ffb300',circleRadius:6},labels:{enabled:false}}));
  window.shell=WorkbenchView({workspace:{workspaceId:'f340b616-691b-4770-b22e-03a6913f96f1',title:${JSON.stringify(reviewTitle)}},project:{schemaVersion:'opengeo.map-definition.1.3.0',layers,mapViews:[{id:'default',title:'Default',...${JSON.stringify(view)}}],basemaps:[{basemapId:'blank',kind:'blank',title:'Blank',visible:true}],bookmarks:[],activeLayerId:'data'},layers,role:'owner',persistenceMode:'browser'});document.body.replaceChildren(shell);};</script>`});
  try{const p=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);return route.fulfill({contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(p)});}catch{return route.abort();}
 });
 page=await context.newPage();page.setDefaultTimeout(renderTimeout);page.on('pageerror',e=>receipt.errors.push(e.message));await page.goto(origin);
 assert.equal(receipt.requests,0);await page.getByRole('button',{name:'Open reviewed archive'}).click();
 receipt.stage='initial-style';
 await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());
 receipt.stage='overview-render';const overviewStart=Date.now();
 await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='data-source').map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;});
 receipt.overviewRenderWaitMilliseconds=Date.now()-overviewStart;
 for(const name of build.tileLayers?.map(x=>x.source_layer)??['data']){
  await page.waitForFunction(name=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source===name+'-source').map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},name);
 }
 receipt.renderedSourceLayers=build.tileLayers?.map(x=>x.source_layer)??['data'];receipt.geometryType=build.geometryType;receipt.parcelPolygonsRendered=build.geometryType==='MultiPolygon';await page.screenshot({path:resolve(out,isolate?'isolated-overview.png':'overview.png')});
 const probePath=resolve(out,'short-line-probes.json');
 if(existsSync(probePath)){
  const probeBytes=await readFile(probePath),probes=JSON.parse(probeBytes);assert.ok(probes.length<=16);receipt.shortLineProbes=[];
  for(const probe of probes){
   beginView(`probe-${probe.id}`);
   await page.evaluate(probe=>shell.__opengeoMap.jumpTo({center:probe.coordinates,zoom:21}),probe);
   await page.waitForFunction(({id,field})=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='data-source').map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).some(f=>f.properties[field]===id);},{id:probe.id,field:build.objectIdField});
   receipt.shortLineProbes.push({id:probe.id,zoom:21,rendered:true});
  }
  receipt.shortLineProbeSha256=createHash('sha256').update(probeBytes).digest('hex');
 }
 const polygonProbePath=resolve(out,'tiny-polygon-probes.json');
 if(existsSync(polygonProbePath)){
  const probeBytes=await readFile(polygonProbePath),probes=JSON.parse(probeBytes);assert.ok(probes.length>0&&probes.length<=8);receipt.tinyPolygonProbes=[];
  const originalFilters=await page.evaluate(()=>shell.__opengeoMap.getStyle().layers.filter(l=>l.source==='data-source').map(l=>({id:l.id,filter:l.filter})));
  for(const probe of probes){
   beginView(`probe-${probe.id}`);
   if(isolate)await page.evaluate(({filters,field,id})=>{for(const layer of filters)shell.__opengeoMap.setFilter(layer.id,['all',...(layer.filter?[layer.filter]:[]),['==',['get',field],id]]);},{filters:originalFilters,field:build.objectIdField,id:probe.id});
   assert.equal(probe.zoom,build.recipe.maxZoom);
   await page.evaluate(probe=>shell.__opengeoMap.jumpTo({center:probe.coordinates,zoom:probe.zoom}),probe);
   await page.waitForFunction(({id,field})=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='data-source').map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).some(f=>f.properties[field]===id&&['Polygon','MultiPolygon'].includes(f.geometry.type));},{id:probe.id,field:build.objectIdField});
   receipt.tinyPolygonProbes.push({id:probe.id,zoom:probe.zoom,rendered:true});
  }
  receipt.tinyPolygonProbeSha256=createHash('sha256').update(probeBytes).digest('hex');
 }
 const pointProbePath=resolve(out,'point-probes.json');
 if(existsSync(pointProbePath)){
  const probeBytes=await readFile(pointProbePath),probes=JSON.parse(probeBytes);assert.ok(probes.length>0&&probes.length<=16);receipt.pointProbes=[];
  for(const probe of probes){
   beginView(`probe-${probe.id}`);
   assert.equal(probe.zoom,build.recipe.maxZoom);
   await page.evaluate(probe=>shell.__opengeoMap.jumpTo({center:probe.coordinates,zoom:probe.zoom}),probe);
   await page.waitForFunction(({id,field})=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='data-source').map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).some(f=>f.properties[field]===id&&f.geometry.type==='Point');},{id:probe.id,field:build.objectIdField});
   receipt.pointProbes.push({id:probe.id,zoom:probe.zoom,rendered:true});
  }
  receipt.pointProbeSha256=createHash('sha256').update(probeBytes).digest('hex');
 }
 receipt.renderer=await page.evaluate(()=>({webgl:!!shell.__opengeoMap.painter?.context?.gl,canvasCount:shell.querySelectorAll('canvas').length}));
 await page.screenshot({path:resolve(out,isolate?'isolated-polygons.png':'parcels.png')});assert.deepEqual(receipt.errors,[]);assert.equal(receipt.externalRequests,0);
 receipt.status='passed';receipt.scope='Actual tiled artifact in built Workbench through local byte-range transport; not signed-in S3 or manual archive selector acceptance.';
}catch(error){receipt.status='failed';receipt.error=String(error);
 receipt.mapDiagnostics=await page?.evaluate(()=>{const m=window.shell?.__opengeoMap;return m?{loaded:m.loaded(),styleLoaded:m.isStyleLoaded(),sources:m.getStyle()?.sources,layers:m.getStyle()?.layers,rendered:m.queryRenderedFeatures().length,status:document.querySelector('.gis-statusbar')?.textContent}:null;}).catch(()=>null);
 await page?.screenshot({path:resolve(out,'browser-failure.png'),timeout:10000}).catch(()=>{});
 throw error;}
finally{await browser.close();await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
