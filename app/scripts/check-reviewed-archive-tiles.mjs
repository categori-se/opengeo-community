// Actual reviewed derivative through the built Live / archived copy controls.
// All API callbacks, provider errors and signed S3 range responses are local fixtures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {PMTiles} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const runFile=promisify(execFile);
let config=null;
if(process.argv.includes('--connected')){let input='';for await(const part of process.stdin)input+=part;config=JSON.parse(input);}
const polygonDirectory=process.argv.find(x=>x.startsWith('--polygon-directory='))?.slice('--polygon-directory='.length);
const polygon=!!polygonDirectory;
const mixed=process.argv.includes('--mixed-detail');
const renewMixedSession=process.argv.includes('--renew-mixed-session');
assert.ok(!renewMixedSession||mixed);
const mixedDirectory=process.argv.find(x=>x.startsWith('--mixed-detail-directory='))?.split('=')[1];
assert.ok(!mixedDirectory||mixed,'A selected mixed-detail artifact requires mixed-detail review');
const soilRaster=process.argv.includes('--soil-raster-overview');
const soilGrouped=process.argv.includes('--soil-grouped-overviews')||soilRaster;
const rasterDirectory=process.argv.find(x=>x.startsWith('--raster-overview-directory='))?.slice('--raster-overview-directory='.length);
assert.ok(!rasterDirectory||((mixed||polygon)&&!soilRaster),'A selected raster overview pairs with selected polygon detail');
const hasRasterOverview=soilRaster||!!rasterDirectory;
const resumeFinePath=process.argv.find(x=>x.startsWith('--resume-fine-probes='))?.slice('--resume-fine-probes='.length);
assert.ok(!resumeFinePath||(mixed&&hasRasterOverview&&!renewMixedSession&&!config),'Local paired probe reuse requires a fresh bounded session');
const soilClasses=process.argv.includes('--soil-class-overviews')||soilGrouped;
const diagnoseCache=process.argv.includes('--diagnose-soil-cache');
const diagnoseSoil=process.argv.includes('--diagnose-soil')||diagnoseCache;
assert.ok(!diagnoseSoil || soilClasses);
const soil=process.argv.includes('--soil-overviews')||soilClasses;assert.ok(!(mixed&&soil));assert.ok(!polygon||(!mixed&&!soil));
const indexed=process.argv.includes('--indexed')||mixed||soil||polygon;
let featureCount=soil?4414467:mixed?60970:indexed?126253:70420;
let field=indexed?'fid':'OBJECTID_1';let renderType=(mixed||soil||polygon)?'fill':indexed?'circle':'line';
let mixedLines=false,fineZoom=20;
const apiCalls=[];
const selectedDist=process.argv.find(x=>x.startsWith('--dist='))?.slice('--dist='.length);
const dist=resolve(selectedDist??'dist'),origin='https://archive-map.invalid';
assert.ok(dist===resolve('dist')||dist.startsWith(resolve('../.local-archives')+'/'),'Use the current build or a retained local release');
const artifact=polygonDirectory?resolve(polygonDirectory):mixedDirectory?resolve(mixedDirectory):resolve('../.local-archives/bhutan-local-20260920/'+(soilGrouped?'soil-display-maplibre-grouped-overviews':soilClasses?'soil-display-maplibre-class-overviews':soil?'soil-display-maplibre-overviews':mixed?'additional-nsdi-tiles/5a32194df52def5f-mixed-detail':indexed?'additional-nsdi-tiles/59a53a1ae77b94c4':'transmission-tiles-v2'));
if(mixedDirectory||polygon){
 assert.ok(artifact.startsWith(resolve('../.local-archives/bhutan-local-20260920/additional-nsdi-tiles')+'/'));
 const selected=JSON.parse(await readFile(resolve(artifact,'receipt.json')));
 if(polygon){
  assert.ok(['Polygon','MultiPolygon'].includes(selected.geometryType)&&!selected.layerZoomRanges);
  assert.equal(selected.objectIdField,'fid');if(hasRasterOverview)assert.ok(Number.isInteger(selected.recipe.minZoom)&&selected.recipe.minZoom>7&&selected.recipe.minZoom<=selected.recipe.maxZoom);else assert.equal(selected.recipe.minZoom,7);
 }
 featureCount=selected.sourceFeatures;
 assert.ok(typeof selected.objectIdField==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected.objectIdField));
 field=selected.objectIdField;
 mixedLines=['LineString','MultiLineString'].includes(selected.geometryType);
 fineZoom=selected.recipe.maxZoom;
 if(mixedLines)renderType='line';
 assert.ok(Number.isSafeInteger(featureCount)&&featureCount>0);
}
const rasterDir=rasterDirectory?resolve(rasterDirectory):resolve('../.local-archives/bhutan-local-20260920/soil-raster-overview');
if(rasterDirectory)assert.ok(rasterDir.startsWith(resolve('../.local-archives/bhutan-local-20260920/additional-nsdi-tiles')+'/'));
const out=hasRasterOverview?resolve(rasterDir,config?'connected-selector-review':'selector-review'):(mixed||soil||polygon)?resolve(artifact,diagnoseCache?'selector-cache-diagnostic':diagnoseSoil?'selector-series-diagnostic':'selector-review'):resolve('../.local-archives/bhutan-local-20260920/'+(indexed?'large-archive-reader/selector':'tiled-selector'));
if(mixed||soil||polygon)assert.ok(!existsSync(out),'Inspect the previous browser result');
await mkdir(out,{recursive:true});
const clientFile=(await readdir(resolve(dist,'_import/lib'))).find(x=>x.startsWith('apiClient.')&&x.endsWith('.js'));
const file=(await readdir(resolve(dist,'_import/components'))).find(x=>x.startsWith('WorkbenchView.')&&x.endsWith('.js'));
const body=await readFile(resolve(artifact,indexed?'display.pmtiles':'transmission.pmtiles'));
const review=JSON.parse(await readFile(resolve(artifact,indexed?'mvt-content-verification.json':'content-verification.json')));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(body),review.outputSha256);assert.equal(review.status,'passed');
let marker,fineProbes,soilProbes;
if(soil||polygon){soilProbes=JSON.parse(await readFile(resolve(artifact,'tiny-polygon-probes.json')));assert.equal(soilProbes.length,8);}
else if(mixed){fineProbes=JSON.parse(await readFile(resolve(artifact,'fine-source-features.json'))).features;}
else if(indexed){
 const original=JSON.parse(await readFile(resolve(artifact,'receipt.json'))).original;
 const manifest=JSON.parse(await readFile('../.local-archives/bhutan-local-20260920/transfer-originals/restoration-manifest.json'));
 const bytes=await readFile(resolve(manifest.sourceRoot,original.path));assert.equal(sha(bytes),original.sha256);
 marker=JSON.parse(bytes).features[0];
}else marker=JSON.parse((await readFile(resolve(artifact,'zero-length-markers.geojsonl'),'utf8')).split('\n')[0]);
const object={bucket:'fixture',key:'private/transmission.pmtiles',prefix:'private/',version_id:'offline-version',expected_owner:'123456789012',size_bytes:body.length,decoded_size_bytes:body.length,sha256:sha(body),decoded_sha256:sha(body),encoding:'identity',feature_count:featureCount,
 block_sha256:Array.from({length:Math.ceil(body.length/65536)},(_,i)=>sha(body.subarray(i*65536,(i+1)*65536))),
 ticket:{method:'GET',url:'https://s3.us-east-1.amazonaws.com/fixture/private/transmission.pmtiles?versionId=offline-version&X-Amz-Signature=offline',headers:{'x-amz-expected-bucket-owner':'123456789012'}}};
const geometryType=mixedLines?'MultiLineString':(mixed||soil||polygon)?'MultiPolygon':indexed?'Point':'MultiLineString';
let indexBody=null;
if(indexed){
 indexBody=Buffer.from(object.block_sha256.join(''),'hex');delete object.block_sha256;
 object.block_index={key:'private/transmission.blocks',version_id:'index-version',size_bytes:indexBody.length,sha256:sha(indexBody),ticket:{method:'GET',url:'https://s3.us-east-1.amazonaws.com/fixture/private/transmission.blocks?versionId=index-version&X-Amz-Signature=offline',headers:{'x-amz-expected-bucket-owner':'123456789012'}}};
}
const record={id:'archive-1',title:'Reviewed transmission display copy',dataset_id:'80000000-0000-4000-8000-000000000088',source_version:1,source_url:'https://provider.invalid/MapServer/4',format:'pmtiles',download_bytes:body.length,decoded_bytes:body.length,feature_count:featureCount,attribution:'ICIMOD; offline review fixture',rights:{license:null},objects:[object],min_zoom:7,max_zoom:14,
 range_block_bytes:65536,range_limits:{requests:256,bytes:64*1024**2,seconds:300,response_bytes:8*1024**2},tile_layers:[
 {source_layer:'transmission',title:'Transmission lines',geometry_type:'MultiLineString',feature_count:70384,geometry_method:'Tiled display derivative with clipping and quantization; original geometry preserved.'},
 {source_layer:'transmission_zero_length',title:'Zero-length records',geometry_type:'Point',feature_count:36,geometry_method:'Derived markers at the sole source coordinate; original line geometry preserved.'}]};
if(indexed)record.tile_layers=[{source_layer:'data',title:'Settlement points',geometry_type:'Point',feature_count:featureCount,geometry_method:'Quantized display; original geometry and attributes preserved.'}];
if(polygon){record.max_zoom=fineZoom;record.tile_layers=[{source_layer:'data',title:'Reviewed polygons',geometry_type:'MultiPolygon',feature_count:featureCount,geometry_method:'Clipped and quantized source polygons; originals preserved.'}];}
if(soil)record.tile_layers=[{source_layer:'data',title:'Soil polygons',geometry_type:'MultiPolygon',feature_count:featureCount,geometry_method:'Generalized overview; exact reviewed zoom 12–14 display tiles retained. Original source geometry and attributes preserved.'}];
if(soilClasses)record.tile_layers[0].geometry_method='Zooms 7–11 show aggregated soil classes at screen resolution, without original feature IDs or area attributes. Exact reviewed zoom 12–14 display tiles and original records remain preserved.';
if(soilClasses)record.provenance={overviewDisplayRecipe:JSON.parse(await readFile(resolve(artifact,'receipt.json'))).overviewDisplayRecipe};
if(mixed){const build=JSON.parse(await readFile(resolve(artifact,'receipt.json')));record.tile_layers=build.tileLayers;record.max_zoom=build.recipe.maxZoom;}
let rasterBody=null,rasterReview=null;
if(hasRasterOverview){
 rasterBody=await readFile(resolve(rasterDir,'overview.pmtiles'));
 rasterReview=JSON.parse(await readFile(resolve(rasterDir,'receipt.json')));
 assert.equal(sha(rasterBody),rasterReview.outputSha256);assert.equal(sha(body),rasterReview.vectorSha256);
 const rasterObject={...object,key:'private/transmission-overview.pmtiles',version_id:'overview-version',size_bytes:rasterBody.length,decoded_size_bytes:rasterBody.length,sha256:sha(rasterBody),decoded_sha256:sha(rasterBody),feature_count:0,
  block_sha256:Array.from({length:Math.ceil(rasterBody.length/65536)},(_,i)=>sha(rasterBody.subarray(i*65536,(i+1)*65536))),
  ticket:{...object.ticket,url:object.ticket.url.replace('transmission.pmtiles','transmission-overview.pmtiles').replace('offline-version','overview-version')}};
 delete rasterObject.block_index;record.objects.push(rasterObject);record.download_bytes+=rasterBody.length;record.decoded_bytes+=rasterBody.length;
 const zooms=rasterReview.recipe.zooms;assert.ok(Array.isArray(zooms)&&zooms[0]===7);
 const maxZoom=zooms.at(-1);assert.deepEqual(zooms,Array.from({length:maxZoom-6},(_,i)=>i+7));
 if(polygon)assert.equal(JSON.parse(await readFile(resolve(artifact,'receipt.json'))).recipe.minZoom,maxZoom+1);
 record.raster_overview={object_index:1,min_zoom:7,max_zoom:maxZoom,vector_min_zoom:maxZoom+1,tile_size:512,description:`Classified raster overview at zooms 7–${maxZoom}; original identities in vector detail at zoom ${maxZoom+1} and above.`,recipe:rasterReview.recipe};
}
if(config)Object.assign(record,{id:config.archiveId,dataset_id:config.datasetId,source_url:config.sourceUrl});
const transportBudget={requests:renewMixedSession?128:soil?256:100,bytes:(renewMixedSession?48:soil?64:32)*1024**2};
let rangeBytes=0;
const receipt={status:'running',outputSha256:review.outputSha256,scope:'Built archive selector with real reviewed PMTiles and intercepted transport; not hosted sign-in or S3 acceptance.'};
if(hasRasterOverview)receipt.rasterOutputSha256=rasterReview.outputSha256;
receipt.reviewedFrontendFiles=[];
if(mixed)receipt.mixedRangeHelperVerified=true;
for(const [directory,prefix] of [['_import/components','WorkbenchView.'],['_import/components','LayerArchiveControl.'],
 ['_import/lib','reviewedArchivePresentation.'],['_import/lib','reviewedArchiveTiles.'],['_import/lib','reviewedArchiveRange.'],['_import/lib','reviewedRasterOverview.'],['_import/lib','reviewedArchiveLayerRanges.']]){
 if(prefix==='reviewedArchiveLayerRanges.'&&!mixed)continue;
 if(prefix==='reviewedRasterOverview.'&&!hasRasterOverview)continue;
 const name=(await readdir(resolve(dist,directory))).find(n=>n.startsWith(prefix)&&n.endsWith('.js'));
 if(name)receipt.reviewedFrontendFiles.push({path:directory+'/'+name,sha256:sha(await readFile(resolve(dist,directory,name)))});
}
let reusedFine=null;
if(resumeFinePath){
 const bytes=await readFile(resolve(resumeFinePath)),prior=JSON.parse(bytes);
 assert.equal(prior.status,'failed');assert.equal(prior.outputSha256,receipt.outputSha256);assert.equal(prior.rasterOutputSha256,receipt.rasterOutputSha256);
 assert.deepEqual(prior.reviewedFrontendFiles,receipt.reviewedFrontendFiles);
 assert.deepEqual(prior.pageErrors,[]);assert.deepEqual(prior.blockedRequests,[]);
 assert.ok(prior.fineProbes?.length>0&&prior.fineProbes.every(p=>p.rendered&&p.coarseOverzoomAlsoRendered));
 reusedFine=prior.fineProbes;
 receipt.fineProbeReuse={receiptSha256:sha(bytes),count:reusedFine.length,sourceStatus:prior.status,scope:'Only completed fine probes reused under identical vector, raster and tested frontend hashes; current overview and lifecycle controls are exercised again.'};
 await writeFile(resolve(out,'reused-fine-probes.json'),bytes);
}
// Native archive envelopes establish when a conservative viewport contains no
// ordinary geometry. Renderer output is never used to infer that expectation.
const nativeArchive=mixed&&hasRasterOverview?new PMTiles({getKey:()=>review.outputSha256,getBytes:async(offset,length)=>({data:body.buffer.slice(body.byteOffset+offset,body.byteOffset+offset+length)})}):null;
async function coarseViewportEvidence(center){
 const z=14,extent=8192,width=1440,height=1000;
 const camera=await page.evaluate(()=>({pitch:shell.__opengeoMap.getPitch(),bearing:shell.__opengeoMap.getBearing()}));
 assert.equal(camera.pitch,0);assert.equal(camera.bearing,0);
 const cx=(center[0]+180)/360*2**z,cy=(1-Math.log(Math.tan(Math.PI/4+center[1]*Math.PI/360))/Math.PI)/2*2**z;
 const dx=width/(512*2**(fineZoom-z))/2,dy=height/(512*2**(fineZoom-z))/2;
 const bounds=[(cx-dx)*extent,(cy-dy)*extent,(cx+dx)*extent,(cy+dy)*extent];let checked=0,candidates=0,tiles=0;
 for(let x=Math.floor(cx-dx);x<=Math.floor(cx+dx);x++)for(let y=Math.floor(cy-dy);y<=Math.floor(cy+dy);y++){
  const tile=await nativeArchive.getZxy(z,x,y);if(!tile)continue;tiles++;
  const layer=new VectorTile(new Pbf(new Uint8Array(tile.data))).layers.data;if(!layer)continue;assert.equal(layer.extent,extent);
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i),box=[Infinity,Infinity,-Infinity,-Infinity];checked++;
   for(const ring of f.loadGeometry())for(const p of ring){const px=x*extent+p.x,py=y*extent+p.y;box[0]=Math.min(box[0],px);box[1]=Math.min(box[1],py);box[2]=Math.max(box[2],px);box[3]=Math.max(box[3],py);}
   if(box[0]<=bounds[2]&&box[2]>=bounds[0]&&box[1]<=bounds[3]&&box[3]>=bounds[1])candidates++;
  }
 }
 return {center,sourceZoom:z,viewZoom:fineZoom,width,height,tiles,checkedFeatures:checked,candidateEnvelopes:candidates,outputSha256:review.outputSha256};
}
const checkpoint=async stage=>{receipt.stage=stage;if(soil||mixed||polygon)await writeFile(resolve(out,'running.json'),JSON.stringify({...receipt,rangeRequests:gets,rangeBytes},null,2)+'\n');};
let browser,page,live=0,gets=0;const errors=[],blocked=[];
async function assertRasterPixels(stage){
 await page.waitForFunction(()=>{const m=shell.__opengeoMap;return m.loaded()&&m.getStyle().layers.find(l=>l.id==='fixture-source-overview')?.layout?.visibility==='visible';});
 const path=resolve(out,stage+'.png');await page.locator('.maplibregl-canvas').screenshot({path});
 const {stdout}=await runFile('/usr/bin/python3',['-c',
  'import json,sys;from PIL import Image;from collections import Counter;colors={tuple(bytes.fromhex(x[1:])) for x in json.loads(sys.argv[2])};counts=Counter(Image.open(sys.argv[1]).convert("RGB").getdata());print(json.dumps({"matchingPixels":sum(counts[c] for c in colors)}))',
  path,JSON.stringify(rasterReview.recipe.legend.map(x=>x.color))]);
 const proof=JSON.parse(stdout);assert.ok(proof.matchingPixels>500,'Reviewed class colors must render on the actual map canvas');
 (receipt.rasterPixelProbes??=[]).push({stage,...proof});
}

try {
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({colorScheme:'dark',viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  try{
  const u=new URL(route.request().url());
  if(u.origin===new URL(record.source_url).origin){live++;return route.fulfill({status:503,contentType:'application/json',body:'{}',headers:{'access-control-allow-origin':'*'}});}
  if(u.origin==='https://s3.us-east-1.amazonaws.com'){
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET','access-control-allow-headers':'x-amz-expected-bucket-owner'}});
   gets++;
   if(indexed&&u.pathname.endsWith('/transmission.blocks')){rangeBytes+=indexBody.length;assert.ok(gets<=transportBudget.requests&&rangeBytes<=transportBudget.bytes);return route.fulfill({status:200,body:indexBody,headers:{'content-type':'application/octet-stream','access-control-allow-origin':'*','access-control-expose-headers':'x-amz-version-id','x-amz-version-id':'index-version'}});}
   const isOverview=hasRasterOverview&&u.pathname.endsWith('/transmission-overview.pmtiles');
   const payload=isOverview?rasterBody:body, version=isOverview?'overview-version':'offline-version';
   const [low,high]=route.request().headers().range.slice(6).split('-').map(Number);
   assert.ok(low>=0 && high<payload.length && high-low+1<=8*1024**2);
   rangeBytes+=high-low+1;assert.ok(gets<=transportBudget.requests && rangeBytes<=transportBudget.bytes);
   return route.fulfill({status:206,body:payload.subarray(low,high+1),headers:{'content-type':'application/octet-stream','access-control-allow-origin':'*','access-control-expose-headers':'Content-Range,x-amz-version-id','content-range':`bytes ${low}-${high}/${payload.length}`,'x-amz-version-id':version}});
  }
  if(config && u.origin===origin && u.pathname.startsWith('/api/')){
   const response=await route.fetch({url:`http://127.0.0.1:${config.apiPort}${u.pathname.slice(4)}${u.search}`});
   apiCalls.push({method:route.request().method(),path:u.pathname,status:response.status()});
   return route.fulfill({response});
  }
  if(u.origin!==origin){blocked.push(u.origin);return route.abort();}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0;height:100%;background:#061526;color:white}.opengeo-workbench{height:100vh}</style><script type="module">
   import {WorkbenchView} from '/_import/components/${file}';
   ${config ? `import {OpenGeoApiClient} from '/_import/lib/${clientFile}';` : ''}
   const record=${JSON.stringify(record)};
   const client=${config ? `new OpenGeoApiClient({baseUrl:'/api',tokenProvider:()=> 'editor',organizationProvider:()=> '${config.organizationId}'})` : 'null'};
   const projectId=${JSON.stringify(config?.workspaceId ?? '50000000-0000-4000-8000-000000000088')};
   const layer={layerId:'fixture',datasetId:record.dataset_id,title:'Fixture live layer',sourceType:'external-feature-reference',sourceVersion:1,sourceUrl:record.source_url,sourceConfiguration:{objectIdField:${JSON.stringify(field)},fields:[${JSON.stringify(field)}],geometryType:${JSON.stringify(geometryType)},pageSize:100,attribution:'Fixture'},geometryType:${JSON.stringify(geometryType)},visible:false,opacity:1,order:0,style:{},labels:{enabled:false}};
   const initial={schemaVersion:'opengeo.map-definition.1.3.0',layers:[layer],mapViews:[{id:'default',title:'Default',center:[90.45,27.5],zoom:7,pitch:0,bearing:0}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:'fixture'};
   const definition=JSON.parse(sessionStorage.getItem('archive-map-saved')||'null')||initial;
   window.probe={lists:0,reads:0,saves:[]};
   window.shell=WorkbenchView({workspace:{workspaceId:projectId,title:'Archive map'},project:definition,layers:definition.layers,role:'owner',mapVersion:1,persistenceMode:'api',
    layerArchiveAccess:{assertScope:async()=>{},authorize:async()=>{},list:async()=>{probe.lists++;return client ? client.listLayerArchives(projectId,record.dataset_id) : {dataset_id:record.dataset_id,source_version:1,archives:[record]};},read:async()=>{probe.reads++;return client ? client.readLayerArchive(projectId,record.dataset_id,record.id) : record;}},
    saveProject:async value=>{probe.saves.push(value);sessionStorage.setItem('archive-map-saved',JSON.stringify(value));return{id:'60000000-0000-4000-8000-000000000088',version:2,definition:value};}});
   document.body.append(shell);
  </script>`});
  try{
   const path=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);
   return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(path)});
  }catch{blocked.push(u.pathname);return route.abort();}
  }catch(error){
   errors.push('Fixture transport failed: '+String(error));
   await route.abort().catch(()=>{});
   await page?.close().catch(()=>{});
  }
 });
 page=await context.newPage();if(mixed||soil||polygon)page.setDefaultTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());
 // Diagnostic only: source managers created below inherit a zero offscreen tile cache.
 // This is not production configuration or acceptance of an unmodified reader.
 if(diagnoseCache){await page.evaluate(()=>{shell.__opengeoMap._maxTileCacheSize=0;});receipt.diagnosticOverride='Renderer offscreen tile cache disabled; verified range cache unchanged';}
 assert.equal(live,0);assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.lists),0);

 await page.getByLabel('Show Fixture live layer',{exact:true}).check();
 await page.waitForFunction(()=>document.body.textContent.includes('live view unavailable'));
 assert.ok(live>0);assert.equal(gets,0);
 await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
 await page.getByText('Live / archived copy',{exact:true}).click();
 await page.getByRole('button',{name:'Review available archives',exact:true}).click();
 await page.getByText(/stored bytes; only requested tiles/).waitFor();
 assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.reads),0);
 assert.equal(await page.getByRole('button',{name:'Use selected archived copy',exact:true}).isEnabled(),false);
 await page.getByLabel(/Download the selected copy from S3/).check();
 const archiveStarted=Date.now();
 await page.getByRole('button',{name:'Use selected archived copy',exact:true}).click();
 await page.waitForFunction(count=>document.querySelector('.gis-layer-archive-dialog [role=status]')?.textContent.includes(count.toLocaleString('en-US')+' reviewed records') || document.body.textContent.includes('archive loading stopped'),featureCount);
 assert.ok(!(await page.locator('.gis-statusbar').innerText()).includes('archive loading stopped'), await page.locator('.gis-layer-archive-dialog').innerText());
 await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
 if(hasRasterOverview)await assertRasterPixels('raster-'+(receipt.rasterPixelProbes?.length??0));else await page.waitForFunction(type=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type===type).map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},renderType);
 receipt.featuresRendered=true;
 await checkpoint('overview-rendered');
 if(mixed||soil||polygon){
  const started=Date.now();await page.waitForFunction(()=>shell.__opengeoMap.loaded());
  receipt.overviewSettleWaitMilliseconds=Date.now()-started;
  receipt.initialOverviewMilliseconds=Date.now()-archiveStarted;
  await page.screenshot({path:resolve(out,'overview.png')});
 }
 await page.getByLabel('Show Fixture live layer',{exact:true}).uncheck();
 assert.equal(await page.evaluate(()=>shell.__opengeoMap.getStyle().layers.filter(l=>l.source?.startsWith('fixture-source')).every(l=>l.layout.visibility==='none')),true);
 await page.getByLabel('Show Fixture live layer',{exact:true}).check();
 await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
 await page.locator('.gis-basemap-tree-row button').click();
 const blank=page.locator('.gis-basemap-card').filter({hasText:'Blank canvas'});
 await blank.evaluate(el=>{el.closest('details').open=true;});
 await blank.click();
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
 if(hasRasterOverview)await assertRasterPixels('raster-'+(receipt.rasterPixelProbes?.length??0));else await page.waitForFunction(type=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type===type).map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},renderType);
 receipt.visibilityAndStyleReload=true;
 await checkpoint('visibility-and-style-reload-passed');
 if(diagnoseSoil){
  const profiler=await context.newCDPSession(page);
  await profiler.send('Profiler.enable');await profiler.send('Profiler.start');
  await page.evaluate(()=>{
   window.tileEvents=[];const start=performance.now();
   shell.__opengeoMap.on('sourcedata',e=>{if(e.sourceId==='fixture-source')tileEvents.push({ms:performance.now()-start,type:e.sourceDataType,tile:e.coord?.canonical,loaded:e.isSourceLoaded});});
  });
  receipt.diagnosticViews=[];
  for(const zoom of [8,9,10]){
   const start=Date.now();
   await page.evaluate(zoom=>shell.__opengeoMap.jumpTo({center:[90.45,27.5],zoom}),zoom);
   const view={zoom};
   try{await page.waitForFunction(()=>shell.__opengeoMap.loaded(),null,{timeout:45000,polling:250});view.loaded=true;}
   catch(error){view.error=String(error);}
   view.elapsedMilliseconds=Date.now()-start;
   view.rendered=await page.evaluate(()=>shell.__opengeoMap.queryRenderedFeatures({layers:shell.__opengeoMap.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type==='fill').map(l=>l.id)}).length);
   receipt.diagnosticViews.push(view);
  }
  const profile=await profiler.send('Profiler.stop');
  await writeFile(resolve(out,'main-thread.cpuprofile'),JSON.stringify(profile.profile));
  receipt.diagnostics=await page.evaluate(()=>({tileEvents,loaded:shell.__opengeoMap.loaded()}));
  receipt.status='diagnostic-complete';receipt.rangeRequests=gets;receipt.rangeBytes=rangeBytes;
  await page.screenshot({path:resolve(out,'detail.png'),timeout:10000});
 }else{
 const beforePan=live;
 if(mixed&&hasRasterOverview){
  receipt.zoomViews=[];
  for(const zoom of [8,9,10,11,12,13]){
   await checkpoint('viewing-zoom-'+zoom);
   const started=Date.now();await page.evaluate(zoom=>shell.__opengeoMap.jumpTo({center:[90.45,27.5],zoom}),zoom);
   if(zoom<record.raster_overview.vector_min_zoom)await assertRasterPixels('zoom-'+zoom);
   else await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>String(l.source).startsWith('fixture-source')&&l.type==='fill').map(l=>l.id);return m.loaded()&&m.queryRenderedFeatures({layers:ids}).length>0;});
   receipt.zoomViews.push({zoom,rendered:true,settleMilliseconds:Date.now()-started});
   await checkpoint('zoom-'+zoom+'-rendered');
  }
 }
 if(mixed){
  receipt.fineProbes=reusedFine?[...reusedFine]:[];
  const explicitPath=resolve(artifact,'fine-render-probes.json');
  const renderProbes=existsSync(explicitPath)?JSON.parse(await readFile(explicitPath)):fineProbes.map(feature=>{
   const points=mixedLines?(feature.geometry.type==='LineString'?feature.geometry.coordinates:feature.geometry.coordinates.flat()):feature.geometry.coordinates[0];
   return {id:feature.properties[field],coordinates:[0,1].map(i=>(Math.min(...points.map(p=>p[i]))+Math.max(...points.map(p=>p[i])))/2)};
  });
  assert.deepEqual([...new Set(renderProbes.map(p=>p.id))].sort((a,b)=>a-b),fineProbes.map(f=>f.properties[field]).sort((a,b)=>a-b));
  assert.ok(renderProbes.length<=100);
  if(reusedFine){
   assert.ok(reusedFine.length<renderProbes.length);
   for(const [i,p] of reusedFine.entries()){assert.equal(p.id,renderProbes[i].id);assert.equal(p.componentIndex,renderProbes[i].componentIndex);assert.equal(p.zoom,fineZoom);}
  }
  for(const [probeIndex,probe] of renderProbes.entries()){
   if(probeIndex<(reusedFine?.length??0))continue;
   if(renewMixedSession&&probeIndex===20){
    await page.waitForFunction(()=>shell.__opengeoMap.loaded());
    const beforeReview=gets;
    await page.getByText('Live / archived copy',{exact:true}).click();
    await page.getByRole('button',{name:'Review available archives',exact:true}).click();
    await page.getByText(/stored bytes; only requested tiles/).waitFor();
    assert.equal(gets,beforeReview,'Metadata review must not read archive bytes');
    assert.equal(await page.getByRole('button',{name:'Use selected archived copy',exact:true}).isEnabled(),false);
    await page.getByLabel(/Download the selected copy from S3/).check();
    await page.getByRole('button',{name:'Use selected archived copy',exact:true}).click();
    await page.waitForFunction(count=>document.querySelector('.gis-layer-archive-dialog [role=status]')?.textContent.includes(count.toLocaleString('en-US')+' reviewed records'),featureCount);
    await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
    receipt.deliberateSessionRenewals=1;
    await checkpoint('archive-explicitly-reselected');
   }
   const center=probe.coordinates;
   await page.evaluate(({center,zoom})=>shell.__opengeoMap.jumpTo({center,zoom}),{center,zoom:fineZoom});
   await page.waitForFunction(({id,type,field})=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l['source-layer']==='fine'&&l.type===type).map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).some(f=>f.properties[field]===id);},{id:probe.id,type:renderType,field});
   const coarseEvidence=nativeArchive&&!mixedLines?await coarseViewportEvidence(center):null;
   const coarseExpected=!coarseEvidence||coarseEvidence.candidateEnvelopes>0;
   if(coarseExpected)await page.waitForFunction(type=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l['source-layer']==='data'&&l.type===type).map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).length>0;},renderType);
   else await page.waitForFunction(()=>shell.__opengeoMap.loaded());
   const coarseRendered=await page.evaluate(type=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l['source-layer']==='data'&&l.type===type).map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).length>0;},renderType);
   assert.equal(coarseRendered,coarseExpected,'Native viewport expectation must match ordinary rendering');
   receipt.fineProbes.push({id:probe.id,componentIndex:probe.componentIndex,zoom:fineZoom,rendered:true,coarseOverzoomAlsoRendered:coarseRendered,coarseOverzoomExpected:coarseExpected,...(coarseEvidence?{coarseViewportEvidence:coarseEvidence}:{})});
   await checkpoint('fine-record-'+probe.id+'-rendered');
  }
  assert.ok(receipt.fineProbes.some(p=>p.coarseOverzoomAlsoRendered),'Ordinary detail must be demonstrated where present');
  receipt.sourceZooms=await page.evaluate(()=>{const map=shell.__opengeoMap;return Object.keys(map.getStyle().sources).filter(id=>id.startsWith('fixture-source')&&map.getSource(id)?.type==='vector').map(id=>map.getSource(id).maxzoom).sort((a,b)=>a-b);});
  assert.deepEqual(receipt.sourceZooms,[14,fineZoom]);
 }else if(soil||polygon){
  receipt.zoomViews=[];
  for(const zoom of (polygon&&!hasRasterOverview?[]:[8,9,10,11,12,13])){
   await checkpoint('viewing-zoom-'+zoom);
   const started=Date.now();await page.evaluate(zoom=>shell.__opengeoMap.jumpTo({center:[90.45,27.5],zoom}),zoom);
   if(hasRasterOverview&&zoom<record.raster_overview.vector_min_zoom)await assertRasterPixels('zoom-'+zoom);else await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type==='fill').map(l=>l.id);return m.loaded()&&m.queryRenderedFeatures({layers:ids}).length>0;});
   receipt.zoomViews.push({zoom,rendered:true,settleMilliseconds:Date.now()-started});
   await checkpoint('zoom-'+zoom+'-rendered');
  }
  receipt.tinyPolygonProbes=[];
  for(const probe of soilProbes){
   await page.evaluate(probe=>shell.__opengeoMap.jumpTo({center:probe.coordinates,zoom:probe.zoom}),probe);
   await page.waitForFunction(id=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type==='fill').map(l=>l.id);return m.queryRenderedFeatures({layers:ids,filter:['==',['get','fid'],id]}).some(f=>f.properties.fid===id&&['Polygon','MultiPolygon'].includes(f.geometry.type));},probe.id);
   receipt.tinyPolygonProbes.push({id:probe.id,zoom:probe.zoom,rendered:true});
   await checkpoint('polygon-'+probe.id+'-rendered');
  }
 }else{
 await page.evaluate(center=>shell.__opengeoMap.jumpTo({center,zoom:14}),marker.geometry.coordinates.slice(0,2));
 await page.waitForFunction(({id,field})=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='fixture-source'&&l.type==='circle').map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).some(f=>f.properties[field]===id);},{id:marker.properties[field],field});
 }
 receipt.specificRecordRendered=true;assert.equal(live,beforePan);
 assert.equal(await page.evaluate(()=>!!shell.__opengeoMap.painter?.context?.gl),true);
 assert.ok(!(await page.evaluate(()=>JSON.stringify(shell.__opengeoMap.getStyle()))).includes('X-Amz'));
 await page.screenshot({path:resolve(out,'archive-marker.png')});
 await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>probe.saves.length===1);
 const saved=await page.evaluate(()=>probe.saves[0]);assert.equal(saved.layers[0].sourceType,'external-feature-reference');assert.equal(saved.layers[0].sourceUrl,record.source_url);
 assert.ok(!JSON.stringify(saved).includes('X-Amz')&&!JSON.stringify(saved).includes('reviewed-archive:'));
 await page.getByText('Live / archived copy',{exact:true}).click();
 await page.getByRole('button',{name:'Return to live',exact:true}).click();
 const afterReturn=gets;
 await page.waitForFunction(()=>document.body.textContent.includes('live view unavailable'));assert.ok(live>beforePan);
 assert.equal(await page.evaluate(()=>shell.__opengeoMap.getStyle().sources['fixture-source']?.type==='vector'),false);
 if(mixed||hasRasterOverview)assert.equal(await page.evaluate(()=>Object.entries(shell.__opengeoMap.getStyle().sources).some(([id,source])=>id.startsWith('fixture-source')&&['vector','raster'].includes(source.type))),false);
 await page.reload();await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(gets,afterReturn);assert.equal(await page.evaluate(()=>probe.reads),0);
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 if(config){assert.ok(apiCalls.some(x=>x.method==='GET'&&x.path.endsWith('/archives')&&x.status===200));assert.ok(apiCalls.some(x=>x.method==='POST'&&x.path.endsWith('/read')&&x.status===200));}
 if(renewMixedSession){assert.equal(receipt.deliberateSessionRenewals,1);assert.ok(gets<=128&&rangeBytes<=48*1024**2,'Two-session local journey budget');}
 receipt.indexedChecksumInventory=indexed;receipt.featureCount=featureCount;receipt.connectedArchiveHttp=!!config;receipt.apiCalls=apiCalls;
 if(config)receipt.scope='Built selector and actual archive HTTP/runtime PostgreSQL repository; synthetic local token verification and intercepted S3/provider peers. Not hosted sign-in, actual S3 range access, or API map-save acceptance.';
 Object.assign(receipt,{status:'passed',initialOff:true,metadataAndLiveFailureZeroStorage:true,explicitCostChoice:true,webgl:true,savedLiveIdentity:true,returnAndReopenNoArchive:true,rangeRequests:gets,rangeBytes,externalRequests:0});
 }
} catch(error){receipt.status='failed';receipt.error=String(error);receipt.rangeRequests=gets;receipt.rangeBytes=rangeBytes;receipt.mapState=await page?.evaluate(()=>({loaded:shell.__opengeoMap.loaded(),layers:shell.__opengeoMap.getStyle().layers.map(l=>({id:l.id,type:l.type,source:l.source,layout:l.layout}))})).catch(()=>null);receipt.pageErrors=errors;receipt.blockedRequests=blocked;receipt.dialog=await page?.locator('.gis-layer-archive-dialog').innerText().catch(()=>null);await page?.screenshot({path:resolve(out,'failure.png'),timeout:10000}).catch(()=>{});throw error;}
finally{await writeFile(resolve(out,config?'connected-receipt.json':'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));await browser?.close();}
