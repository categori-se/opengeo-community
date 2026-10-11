import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {parse} from 'acorn';
import {referencedStylePaint} from '../src/lib/layerStyleReference.js';
import {compileStaticMapDocument} from '../src/lib/staticMapExport.js';
const root=new URL('../../',import.meta.url);
if(process.argv.includes('--full-application')) {
 const {chromium}=await import('playwright');
 const base=process.env.OPENGEO_PEER_NATIVE_BASE;
 const datasetId=process.env.OPENGEO_PEER_NATIVE_DATASET;
 const receiptPath=process.env.OPENGEO_PEER_NATIVE_RECEIPT;
 let password=process.env.GEOLENS_ADMIN_PASSWORD;
 assert.match(base??'',/^http:\/\/127\.0\.0\.1:\d+$/);
 assert.match(datasetId??'',/^[0-9a-f-]{36}$/);assert.ok(password&&receiptPath);
 const started=performance.now();const requests=[],blocked=[],errors=[];
 const report={status:'started',sourceRevision:'f5fee67d8cf053d741590a00a55fe1870eed2b92',
  actualFullApplication:true,APIResponsesSubstituted:false,authOverrides:false,rowsClosed:0};
 const browserServer=await chromium.launchServer({host:'127.0.0.1',headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium-browser',
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const browserPid=browserServer.process().pid;
 const processStat=await readFile('/proc/'+browserPid+'/stat','utf8');
 await writeFile(process.env.OPENGEO_PEER_NATIVE_BROWSER_PROCESS,JSON.stringify({pid:browserPid,startTicks:processStat.slice(processStat.lastIndexOf(')')+2).split(' ')[19]})+'\n');
 const browser=await chromium.connect(browserServer.wsEndpoint());
 const context=await browser.newContext({viewport:{width:1440,height:950},serviceWorkers:'block'});
 try {
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin===base&&!url.pathname.startsWith('/api/basemaps/'))return route.continue();
   blocked.push({origin:url.origin,path:url.pathname});return route.abort();
  });
  const page=await context.newPage();page.setDefaultTimeout(6000);
  page.on('response',response=>requests.push({method:response.request().method(),path:new URL(response.url()).pathname,status:response.status()}));
  page.on('pageerror',error=>errors.push(error.name));
  await page.goto(base+'/login');
  await page.locator('input[type="text"],input[name="username"]').first().fill('admin');
  await page.locator('input[type="password"]').fill(password);
  const login=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login'&&response.request().method()==='POST');
  await page.getByRole('button',{name:/sign in|log in|login/i}).first().click();
  assert.equal((await login).status(),200);password='';delete process.env.GEOLENS_ADMIN_PASSWORD;
  await page.waitForFunction(()=>{try{return !!JSON.parse(localStorage.getItem('geolens-auth'))?.state?.token;}catch{return false;}});
  const call=async(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{
   const token=JSON.parse(localStorage.getItem('geolens-auth')).state.token;
   const response=await fetch('/api'+path,{method,credentials:'same-origin',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
   return {status:response.status,body:await response.json()};
  },{path,method,body});
  const create=await call('/maps/','POST',{name:'OpenGeo native composition peer',center_lng:0,center_lat:0,zoom:5});
  assert.equal(create.status,201);const mapId=create.body.id;
  const initial={center_lng:0,center_lat:0,zoom:5,bearing:0,pitch:0,basemap_style:'blank',show_basemap_labels:false,
   layers:[{dataset_id:datasetId,sort_order:0,visible:true,opacity:1,
    paint:{'line-color':'#123456','line-width':6},filter:['>=',['get','value'],10]},
    {dataset_id:datasetId,sort_order:1,visible:false,opacity:.5,
     paint:{'line-color':'#e05050','line-width':8},filter:['>=',['get','value'],20]}]};
  const prepare=await call('/maps/'+mapId,'PUT',initial);assert.equal(prepare.status,200);
  const tileResponse=page.waitForResponse(response=>new URL(response.url()).pathname.startsWith('/api/tiles/')&&new URL(response.url()).pathname.endsWith('.pbf')&&response.status()===200);
  await page.goto(base+'/maps/'+mapId);
  await page.locator('canvas.maplibregl-canvas').waitFor({state:'visible'});
  await tileResponse;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  let screenshot,rendered;
  for(let paintWait=0;paintWait<10;paintWait++){
   screenshot=await page.locator('canvas.maplibregl-canvas').screenshot();
   rendered=await page.evaluate(async base64=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const rgba=context.getImageData(0,0,image.width,image.height).data;let count=0;for(let i=0;i<rgba.length;i+=4)if(Math.abs(rgba[i]-0x12)<=6&&Math.abs(rgba[i+1]-0x34)<=6&&Math.abs(rgba[i+2]-0x56)<=6&&rgba[i+3]>240)count++;image.close();return {width:canvas.width,height:canvas.height,pinnedLineColorPixels:count};},screenshot.toString('base64'));
   if(rendered.pinnedLineColorPixels>=20)break;
   await page.waitForTimeout(200);
  }
  assert.ok(rendered.pinnedLineColorPixels>=20,'genuine peer MVT must paint the declared line color');
  await writeFile(receiptPath.replace(/\.json$/,'.png'),screenshot);
  report.initialRenderedScene={...rendered,pngSha256:createHash('sha256').update(screenshot).digest('hex'),MVTResponseStatus:200};
  const rows=page.locator('[id^="stack-row-"]:not(#stack-row-basemap-group)');
  await rows.first().waitFor({state:'visible'});
  assert.equal(await rows.count(),2);
  const rowIds=await rows.evaluateAll(elements=>elements.map(element=>element.id.slice('stack-row-'.length)));
  await rows.first().getByRole('button',{name:/Toggle visibility for/}).click();
  await rows.first().click();
  const editor=page.getByTestId('builder-layer-editor');await editor.waitFor({state:'visible'});
  await editor.getByRole('tab',{name:/Filter/}).click();
  assert.ok(await editor.getByText(/value/).count()>0,'actual filter inspector exposes the persisted field');
  const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/maps/'+mapId&&response.request().method()==='PUT');
  await page.getByRole('button',{name:/^save/i}).first().click();assert.equal((await savedResponse).status(),200);
  const saved=await call('/maps/'+mapId);assert.equal(saved.status,200);
  const normalized=layers=>layers.map(layer=>({dataset_id:layer.dataset_id,sort_order:layer.sort_order,
   visible:layer.visible,opacity:layer.opacity,paint:layer.paint,filter:layer.filter,style_config:layer.style_config}));
  assert.equal(saved.body.layers.length,2);assert.ok(saved.body.layers.every(layer=>layer.dataset_id===datasetId));
  assert.equal(saved.body.layers.find(layer=>layer.id===rowIds[0]).visible,!prepare.body.layers.find(layer=>layer.id===rowIds[0]).visible);
  for(const layer of saved.body.layers){const original=prepare.body.layers.find(value=>value.id===layer.id);
   assert.deepEqual(layer.filter,original.filter);assert.equal(layer.paint['line-color'],original.paint['line-color']);
   assert.equal(layer.paint['line-width'],original.paint['line-width']);assert.equal(layer.sort_order,original.sort_order);}
  await page.reload();await page.locator('canvas.maplibregl-canvas').waitFor({state:'visible'});
  const reopened=await call('/maps/'+mapId);assert.deepEqual(normalized(reopened.body.layers),normalized(saved.body.layers));
  const before=await call('/datasets/?limit=20');assert.equal(before.status,200);
  await page.getByRole('button',{name:/more actions/i}).first().click();
  await page.getByRole('menuitem',{name:/duplicate/i}).click();
  await page.waitForURL(url=>url.pathname.startsWith('/maps/')&&!url.pathname.includes(mapId));
  await page.locator('canvas.maplibregl-canvas').waitFor({state:'visible'});
  const duplicateId=new URL(page.url()).pathname.split('/').at(-1);
  const duplicate=await call('/maps/'+duplicateId);assert.equal(duplicate.status,200);
  assert.deepEqual(normalized(duplicate.body.layers),normalized(saved.body.layers));
  await page.reload();await page.locator('canvas.maplibregl-canvas').waitFor({state:'visible'});
  const duplicateReopened=await call('/maps/'+duplicateId);assert.deepEqual(normalized(duplicateReopened.body.layers),normalized(saved.body.layers));
  const after=await call('/datasets/?limit=20');assert.deepEqual(after.body,before.body);
  report.status='passed';report.mapIds=[mapId,duplicateId];report.sharedDatasetId=datasetId;
  report.savedLayers=normalized(saved.body.layers);report.nativeActions=['Normal login','Actual builder canvas',
   'Layer visibility toggle','Filter inspector','Save','Reload saved map','Duplicate map','Reload duplicate'];
  report.claimLimit='Native peer preserves declared order/filter/paint through actual UI Save/reopen; initial order/filter/paint prepared through the genuine API. Broader native controls, visual equivalence, independent pinned Style identity and deployed OpenGeo acceptance remain unproved.';
 } catch(error) {report.status='failed';report.error={name:error.name,message:error.message.replace(/Bearer\s+\S+/gi,'Bearer [redacted]')};throw error;}
 finally {
  password='';delete process.env.GEOLENS_ADMIN_PASSWORD;
  await context.close();await browser.close();await browserServer.close();report.browserClosed=true;
  report.elapsedSeconds=(performance.now()-started)/1000;report.requests=requests;report.blockedExternalRequests=blocked;
  report.pageErrorKinds=errors;await writeFile(receiptPath,JSON.stringify(report,null,2)+'\n');
 }
 console.log(JSON.stringify({status:report.status,mapIds:report.mapIds,localRequests:requests.length,
  blockedExternalRequests:blocked.length,elapsedSeconds:report.elapsedSeconds,browserClosed:report.browserClosed,rowsClosed:0}));
 process.exit(0);
}
const lock=JSON.parse(await readFile(new URL('parity/fixtures/geolens-004/presentation-lock.json',root),'utf8'));
const sources=new Map();
for(const item of lock.files){const bytes=await readFile(new URL(item.path,root));assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256);assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),item.gitBlob);sources.set(item.path.split('/').at(-1),stripTypeScriptTypes(bytes.toString()));}
// Execute complete selected declarations, never rewritten function bodies. All
// transitive dependencies for these declarations are selected explicitly below.
async function select(source,names){
 const chunks=[];
 for(const unit of Array.isArray(source)?source:[source]){
  const ast=parse(unit,{ecmaVersion:'latest',sourceType:'module'});
  for(const entry of ast.body){const node=entry.type==='ExportNamedDeclaration'?entry.declaration:entry;if(!node)continue;
   const ids=node.type==='FunctionDeclaration'?[node.id.name]:node.type==='VariableDeclaration'?node.declarations.map(d=>d.id.name):[];
   if(ids.some(id=>names.includes(id)))chunks.push(unit.slice(node.start,node.end));
  }
 }
 assert.equal(chunks.length,names.length);
 return import(`data:text/javascript;base64,${Buffer.from(chunks.join('\n')+'\nexport {'+names.join(',')+'};').toString('base64')}`);
}

const shared=await select(sources.get('shared.ts'),['OPACITY_DEFAULTS','getFeatureOpacity','getExpressionSafeOpacity','applyMasterOpacity','syncSingleLayerVisibility']);
const order=await select(['map-sync.ts','cluster-adapter.ts','mixed-adapter.ts','companion-ids.ts'].map(name=>sources.get(name)),['prefixed','reorderDataLabels','reorderDataGeometry','reorderDataLayers','clusterCircleLayerId','clusterCountLayerId','mixedLinesLayerId','mixedPointsLayerId','COLOR_RELIEF_SUFFIX']);
const own=await select([await readFile(new URL('app/src/components/WorkbenchView.js',root),'utf8'),await readFile(new URL('app/src/lib/layerOrder.js',root),'utf8')],['syncLayerOrder','orderedRenderLayerIds']);
const paint=[];shared.applyMasterOpacity({setPaintProperty:(...v)=>paint.push(v)},'line',{'line-opacity':.6},'line',.5);
assert.deepEqual(paint,[['line','line-opacity',.6],['line','line-layer-opacity',.5]]);
const ownPaint=referencedStylePaint({parts:[{id:'line',type:'line',paint:{'line-opacity':.6}}]},{layerId:'line',opacity:.5})[0].paint;
assert.equal(ownPaint['line-opacity'],.3);assert.equal(ownPaint['line-layer-opacity'],undefined);
// Compare the new saved mode with unchanged upstream declarations over scalar
// feature/master values. Omitted fill opacity intentionally retains product defaults.
const compositeCases=[];
for(const type of ['fill','line'])for(const feature of [0,.3,.6,1])for(const master of [0,.5,1]){
 const input={[`${type}-opacity`]:feature},calls=[];
 shared.applyMasterOpacity({setPaintProperty:(_id,key,value)=>calls.push([key,value])},type,input,type,master);
 const own=referencedStylePaint({parts:[{id:type,type,paint:input}]},{layerId:type,opacity:master,opacityMode:'composite'})[0].paint;
 assert.deepEqual(own,Object.fromEntries(calls));
 compositeCases.push({type,feature,master});
}
const peerDefault=[];shared.applyMasterOpacity({setPaintProperty:(_id,key,value)=>peerDefault.push([key,value])},'fill',{},'fill',.5);
const ownDefault=referencedStylePaint({parts:[{id:'fill',type:'fill',paint:{}}]},{layerId:'fill',opacity:.5,opacityMode:'composite'})[0].paint;
assert.equal(Object.fromEntries(peerDefault)['fill-opacity'],.3);assert.equal(ownDefault['fill-opacity'],1);
const visibility=[];const map={getLayer:id=>id==='present',setLayoutProperty:(...v)=>visibility.push(v)};
shared.syncSingleLayerVisibility(map,'present',false);shared.syncSingleLayerVisibility(map,'present',true);shared.syncSingleLayerVisibility(map,'missing',true);
assert.deepEqual(visibility,[['present','visibility','none'],['present','visibility','visible']]);
const initial=['layer-bottom','layer-bottom-label','layer-top','layer-top-label'];
function stack(){return {ids:[...initial],getLayer(id){return this.ids.includes(id)},moveLayer(id){this.ids=this.ids.filter(v=>v!==id);this.ids.push(id)}};}
const peer=stack();order.reorderDataLabels(peer,[{id:'top'},{id:'bottom'}]);
assert.deepEqual(peer.ids,['layer-bottom','layer-top','layer-bottom-label','layer-top-label']);
const ours=stack();own.syncLayerOrder({state:{map:ours,layerHandles:new Map(['top','bottom'].map(id=>[id,{layerIds:[`layer-${id}`,`layer-${id}-label`]}]))},layers:[{layerId:'top'},{layerId:'bottom'}]});
assert.deepEqual(ours.ids,initial);
const raised=stack();own.syncLayerOrder({state:{map:raised,layerHandles:new Map(['top','bottom'].map(id=>[id,{layerIds:[`layer-${id}`,`layer-${id}-label`],labelLayerId:`layer-${id}-label`}]))},layers:['top','bottom'].map(layerId=>({layerId,labels:{drawOrder:'above-data'}}))});assert.deepEqual(raised.ids,peer.ids);
const orderingCases=[];
for(const ids of [['a','b','c'],['a','c','b'],['b','a','c'],['b','c','a'],['c','a','b'],['c','b','a']])for(const labels of [true,false]) {
 const handles=new Map(['a','b','c'].map(id=>[id,{layerIds:[`layer-${id}`,`layer-${id}-outline`,...(labels?[`layer-${id}-label`]:[])],...(labels?{labelLayerId:`layer-${id}-label`}:{})}]));
 const start=[...handles.values()].flatMap(handle=>handle.layerIds).reverse();
 const make=()=>({ids:[...start],getLayer(id){return this.ids.includes(id)},moveLayer(id){this.ids=this.ids.filter(value=>value!==id);this.ids.push(id)}});
 const peerMap=make(),ownMap=make();
 order.reorderDataLayers(peerMap,ids.map(id=>({id})));
 own.syncLayerOrder({state:{map:ownMap,layerHandles:handles},layers:ids.map(layerId=>({layerId,labels:{drawOrder:'above-data'}}))});
 assert.deepEqual(ownMap.ids,peerMap.ids);
 orderingCases.push({topToBottom:ids,labels,renderOrder:ownMap.ids});
}
const previous=JSON.parse(await readFile(new URL('parity/reports/geolens-004-presentation-peer.json',root),'utf8'));
if(process.argv.includes('--rendered-peer')) {
 const cases=[];
 for(const type of ['fill','line','circle']) {
  const input={ [`${type}-color`]:'#d03050', [`${type}-opacity`]:.6,
   ...(type==='line'?{'line-width':18}:type==='circle'?{'circle-radius':32}:{'fill-antialias':false}) };
  const peerPaint={...input};
  shared.applyMasterOpacity({setPaintProperty:(_id,key,value)=>peerPaint[key]=value},type,input,type,.5);
  const ownPaint=referencedStylePaint({parts:[{id:type,type,paint:input}]},{layerId:type,opacity:.5,opacityMode:type==='circle'?'feature':'composite'})[0].paint;
  // OpenGeo also specifies circle outline opacity; there is no outline in this fixture.
  const layouts=[];shared.syncSingleLayerVisibility({getLayer:()=>true,setLayoutProperty:(_id,_key,value)=>layouts.push(value)},type,false);
  cases.push({type,peerPaint,ownPaint,peerHidden:layouts[0]});
 }
 const {chromium}=await import('playwright');
 const bundle=await readFile(new URL('.local-archives/maplibre-6-migration-20260924/canonical-v6.js',root));
 assert.equal(createHash('sha256').update(bundle).digest('hex'),'c42816c048a41d23bd87cc3f73b7eafb894f0c1e953cec59891d6c09154c27c7');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium-browser',args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 let externalRequests=0;
 try {
  const page=await browser.newPage({viewport:{width:256,height:256},deviceScaleFactor:1});
  await page.route('**/*',route=>{if(route.request().url()==='http://localhost/')return route.fulfill({contentType:'text/html',body:'<div id="map" style="width:256px;height:256px"></div>'});externalRequests++;return route.abort();});
  page.on('pageerror',error=>console.error(error.message));
  page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
  await page.goto('http://localhost/');
  await page.addScriptTag({content:bundle.toString()});
  const result=await page.evaluate(async cases=>{
   const errors=[],results=[];
   const map=new window.opengeoMapLibre.Map({container:'map',center:[0,0],zoom:4,interactive:false,canvasContextAttributes:{preserveDrawingBuffer:true},style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]}});
   map.on('error',e=>errors.push(e.error.message));
   const idle=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('peer render timeout')),10000);map.once('idle',()=>{clearTimeout(timer);resolve();});map.triggerRepaint();});
   const pixels=()=>{const gl=map.getCanvas().getContext('webgl2'),data=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
   const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
   await idle();
   for(const item of cases) {
    const geometry=item.type==='fill'?{type:'Polygon',coordinates:[[[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]]]}:item.type==='line'?{type:'LineString',coordinates:[[-4,0],[4,0]]}:{type:'Point',coordinates:[0,0]};
    map.addSource(item.type,{type:'geojson',data:{type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry},{type:'Feature',properties:{},geometry}]}});
    const states={};
    for(const side of ['peer','own']) {
     map.addLayer({id:'probe',type:item.type,source:item.type,paint:item[side+'Paint']});await idle();
     const visible=pixels();
     map.setLayoutProperty('probe','visibility',side==='peer'?item.peerHidden:'none');await idle();
     const hidden=pixels();
     states[side]={visible:await hash(visible),hidden:await hash(hidden),center:[...visible.slice((128*256+128)*4,(128*256+128)*4+4)],hiddenCenter:[...hidden.slice((128*256+128)*4,(128*256+128)*4+4)]};
     map.removeLayer('probe');
    }
    results.push({type:item.type,...states});map.removeSource(item.type);
   }
   const version=window.opengeoMapLibre.getVersion();map.remove();return {version,results,errors};
  },cases);
  assert.equal(result.version,'6.4.1');assert.deepEqual(result.errors,[]);assert.equal(externalRequests,0);
  for(const item of result.results){assert.deepEqual(item.peer,item.own);assert.notEqual(item.peer.visible,item.peer.hidden);assert.deepEqual(item.peer.hiddenCenter,[255,255,255,255]);}
  previous.renderedPeerBatch.result={status:'passed',aggregateRowsClosed:0,...result,externalRequests,browserRuns:1,scope:'Unmodified pinned peer helpers versus production referencedStylePaint; same local v6 engine and synthetic overlapping geometry. Hidden state compares peer helper with MapLibre none. No full GeoLens UI or independent renderer/order claim.'};
 } catch(error) {previous.renderedPeerBatch.result={status:'failed',error:error.message,externalRequests,aggregateRowsClosed:0};throw error;}
 finally {await browser.close();await writeFile(new URL('parity/reports/geolens-004-presentation-peer.json',root),JSON.stringify(previous,null,2)+'\n');}
}
if(process.argv.includes('--portable-v6')) {
 const {chromium}=await import('playwright');
 const archive=new URL('.local-archives/maplibre-6-migration-20260924/',root);
 const runtimeJs=await readFile(new URL('export-runtime/maplibre-gl.js',archive),'utf8');
 const runtimeCss=await readFile(new URL('export-runtime/maplibre-gl.css',archive),'utf8');
 const runtimeLicense=await readFile(new URL('export-runtime/LICENSE.txt',archive),'utf8');
 const feature={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-3,-2],[3,-2],[3,2],[-3,2],[-3,-2]]]}};
 const {html}=compileStaticMapDocument({title:'Offline renderer migration',view:{center:[0,0],zoom:5},runtimeJs,runtimeCss,runtimeLicense,
  candidates:[{id:'area',title:'Test area',visible:true,sourceId:'area',source:{type:'geojson',data:{type:'FeatureCollection',features:[feature]}},paints:[{id:'area',source:'area',type:'fill',paint:{'fill-color':'#ff0000','fill-opacity':1,'fill-layer-opacity':.5}}],paintOrder:{area:0}}],selectedIds:['area']});
 const htmlUrl=new URL('portable-v6.html',archive);
 await writeFile(htmlUrl,html);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium-browser',args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const requests=[],errors=[],consoleErrors=[];
 let page;
 try {
  page=await browser.newPage({viewport:{width:800,height:600}});
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.addInitScript(()=>{window.__workerErrors=[];const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);this.addEventListener('error',event=>window.__workerErrors.push(event.message));}};});
  page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(route.request().url()===htmlUrl.href)return route.continue();requests.push(route.request().url());return route.abort();});
  await page.goto(htmlUrl.href);
  await page.getByText('Offline edition · selected vector data included',{exact:true}).waitFor();
  const canvas=page.locator('canvas');
  const visible=await canvas.screenshot();
  await page.getByRole('checkbox',{name:'Test area',exact:true}).uncheck();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const hidden=await canvas.screenshot();
  const pixel=async bytes=>page.evaluate(async base64=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const rgba=[...context.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data];image.close();return rgba;},bytes.toString('base64'));
  const visiblePixel=await pixel(visible),hiddenPixel=await pixel(hidden);
  assert.ok(visiblePixel[0]>visiblePixel[1]+80,'export must render the red test polygon');
  assert.deepEqual(hiddenPixel,[231,236,239,255],'hidden Layer must reveal only export background');
  assert.notDeepEqual(visible,hidden,'visibility must change the exported canvas');
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  previous.browserExportMigrationBatch.result={status:'portable-v6-passed',aggregateRowsClosed:0,openedFromDisk:true,layerVisibilityChangesCanvas:true,visiblePixel,hiddenPixel,errors,externalRequests:requests.length,htmlSha256:createHash('sha256').update(html).digest('hex'),limits:'Actual portable HTML; Studio Framework v6 worker staging and native packaging remain pending.'};
 } catch(error) {
  previous.browserExportMigrationBatch.result={status:'failed',error:error.message,errors,requests,consoleErrors,diagnostic:await page?.evaluate(()=>({status:document.getElementById('status')?.textContent,workers:window.__workerErrors})).catch(()=>null),aggregateRowsClosed:0};
  await writeFile(new URL('parity/reports/geolens-004-presentation-peer.json',root),JSON.stringify(previous,null,2)+'\n');
  throw error;
 } finally {await browser.close();}
}
if (process.argv.includes('--runtime-opacity') || process.argv.includes('--runtime-opacity-v6') || process.argv.includes('--framework-v6')) {
 const framework=process.argv.includes('--framework-v6');
 const v6=framework || process.argv.includes('--runtime-opacity-v6');
 const {chromium}=await import('playwright');
 const bundle=await readFile(new URL(v6 ? '.local-archives/maplibre-6-migration-20260924/native-bundle.js' : '.local-archives/native-filter-images-20260924/maplibre.js',root));
 const manifest=JSON.parse(await readFile(new URL('.local-archives/native-filter-images-20260924/label-order-runtime.json',root),'utf8'));
 // Reuse the canonical bundle; never download a renderer for this probe.
 const bundleHash=createHash('sha256').update(bundle).digest('hex');
 if (!v6) assert.ok(JSON.stringify(manifest).includes(bundleHash),'cached bundle must match retained runtime manifest');
 const staged=new Map();
 if(framework){
  const {transpileModule}=await import('../node_modules/@observablehq/framework/dist/javascript/transpile.js');
  const {buildMapWorker}=await import('../src/assets/maplibre-worker.js.js');
  const {fileURLToPath}=await import('node:url');
  const worker=await buildMapWorker(fileURLToPath(new URL('.local-archives/maplibre-6-migration-20260924/',root)));
  const workerPath='/assets/maplibre-worker.'+createHash('sha256').update(worker).digest('hex').slice(0,8)+'.js';
  staged.set(workerPath,worker);
  for(const name of ['mapRenderer','mapRendererWorker'])staged.set('/'+name+'.js',await transpileModule(await readFile(new URL('app/src/lib/'+name+'.js',root),'utf8'),{
   root:fileURLToPath(new URL('app/src/',root)),path:'/lib/'+name+'.js',servePath:'/'+name+'.js',
   resolveImport:name=>name.startsWith('maplibre-gl')?'/runtime/maplibre-gl.mjs':name==='observablehq:stdlib'?'/stdlib.js':'/mapRendererWorker.js',
   resolveFile:()=>workerPath,resolveFileInfo:()=>({size:worker.length,mtimeMs:0})}));
  staged.set('/stdlib.js',await readFile(new URL('app/node_modules/@observablehq/framework/dist/client/stdlib/fileAttachment.js',root)));
  for(const name of ['maplibre-gl.mjs','maplibre-gl-shared.mjs'])staged.set('/runtime/'+name,await readFile(new URL('.local-archives/maplibre-6-migration-20260924/dist/'+name,root)));
 }
 let fixtureServer=null;
 let fixtureOrigin='http://opengeo.test';
 if(framework){
  const {createServer}=await import('node:http');
  fixtureServer=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const body=path==='/'?'<div id="map" style="width:512px;height:512px"></div>':staged.get(path);res.statusCode=body===undefined?404:200;res.setHeader('Content-Type',path==='/'?'text/html':'text/javascript');res.end(body??'missing fixture');});
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  fixtureOrigin='http://127.0.0.1:'+fixtureServer.address().port;
 }
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium-browser',args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage({viewport:{width:512,height:512},deviceScaleFactor:1});
  let externalRequests=0;
  await page.context().route('**/*',route=>{if(framework&&new URL(route.request().url()).origin===fixtureOrigin)return route.continue();if(route.request().url()==='http://opengeo.test/')return route.fulfill({contentType:'text/html',body:'<div id="map" style="width:512px;height:512px"></div>'});const url=new URL(route.request().url());if(url.origin==='http://opengeo.test'&&staged.has(url.pathname))return route.fulfill({contentType:'text/javascript',body:staged.get(url.pathname)});externalRequests++;return route.abort();});
  page.on('pageerror',error=>console.error('Browser:',error.message));
  page.on('console',message=>{if(message.type()==='error')console.error('Console:',message.text());});
  await page.goto(fixtureOrigin+'/');
  if(framework)await page.evaluate(async()=>{window.opengeoMapLibre=(await import('/mapRenderer.js')).default;});
  else await page.addScriptTag({content:bundle.toString()});
  const pixels=await page.evaluate(async(v6)=>{
   const errors=[];
   const map=new window.opengeoMapLibre.Map({container:'map',center:[0,0],zoom:5,interactive:false,canvasContextAttributes:{preserveDrawingBuffer:true},style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]}});
   const idle=()=>Promise.race([new Promise(resolve=>map.once('idle',resolve)),new Promise((_,reject)=>setTimeout(()=>reject(Error('opacity probe timed out')),10000))]);
   map.on('error',e=>errors.push(e.error.message));
   await idle();
   const polygon=(left,right)=>({type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[left,-2],[right,-2],[right,2],[left,2],[left,-2]]]}});
   map.addSource('overlap',{type:'geojson',data:{type:'FeatureCollection',features:[polygon(-3,1),polygon(-1,3)]}});
   map.addLayer({id:'fill',type:'fill',source:'overlap',paint:{'fill-color':'#ff0000','fill-opacity':.3,'fill-antialias':false}});
   map.addLayer({id:'line',type:'line',source:'overlap',paint:{'line-color':'#ff0000','line-opacity':.3,'line-width':2}});
   await idle();
   const gl=map.getCanvas().getContext('webgl2');
   const sample=lng=>{const p=map.project([lng,0]),rgba=new Uint8Array(4);gl.readPixels(Math.round(p.x),512-Math.round(p.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return [...rgba];};
   const single=sample(-2),overlap=sample(0);
   for(const type of ['fill','line'])try{map.setPaintProperty(type,`${type}-layer-opacity`,.5);}catch(e){errors.push(`${type}-layer-opacity: ${e.message}`);}
   let composite=null;
   if(v6){map.setPaintProperty('fill','fill-opacity',1);map.setPaintProperty('fill','fill-opacity-transition',{duration:0});await idle();composite={single:sample(-2),overlap:sample(0)};}
   const version=window.opengeoMapLibre.getVersion();
   map.remove();return {version,single,overlap,errors,composite};
  },v6);
  const batch=framework?previous.frameworkWorkerBatch:v6?previous.rendererMigrationBatch:previous.opacityRuntimeBatch;
  batch.observation={...pixels,bundleSha256:bundleHash,externalRequests};
  await writeFile(new URL('parity/reports/geolens-004-presentation-peer.json',root),JSON.stringify(previous,null,2)+'\n');
  assert.equal(pixels.version,v6?'6.4.1':'5.24.0');
  assert.ok(pixels.single[1]>pixels.overlap[1]+30,'overlap must visibly darken with per-feature opacity');
  if(v6){assert.deepEqual(pixels.errors,[]);assert.deepEqual(pixels.composite.single,pixels.composite.overlap);assert.ok(pixels.composite.single[1]>120&&pixels.composite.single[1]<135);} else for(const type of ['fill','line'])assert.ok(pixels.errors.some(message=>message.includes(`${type}-layer-opacity`)),`${type} whole-layer opacity must be rejected by the pinned runtime`);
  assert.equal(externalRequests,0);
  batch.result={status:framework?'framework-worker-render-passed':v6?'v6-bundle-compositing-passed':'unsupported-runtime-confirmed',aggregateRowsClosed:0,bundleSha256:bundleHash,...pixels,externalRequests,successfulBrowserRuns:1,requiredExceptions:v6?['Studio loading, saved opacity choice, native package activation and portable HTML acceptance remain open.']:['Whole-layer fill/line opacity requires a coordinated renderer upgrade; current multiplication remains distinct.'],nextAction:'Migrate browser, native bundle and portable exports together using explicit worker assets; preserve legacy opacity defaults.'};
  if(framework){delete batch.result.bundleSha256;delete batch.observation.bundleSha256;batch.result.stagedAssets=[...staged].map(([path,bytes])=>({path,sha256:createHash('sha256').update(bytes).digest('hex')}));batch.result.requiredExceptions=['Full Studio build and actual isolated v6 package execution','Saved whole-layer opacity choice and deployed acceptance'];}
 } finally {await browser.close();if(fixtureServer)await new Promise(resolve=>fixtureServer.close(resolve));}
}
previous.orderingPeerBatch.result={status:'passed',aggregateRowsClosed:0,cases:orderingCases,sourceRequests:3,sourceBytes:27207,peerRuns:1,scope:'Complete unmodified reorderDataLayers and imported identifier helpers; explicit call-recording maps for geometry, outline and optional raised labels. No claim of clustered/mixed/raster rendering support or full GeoLens UI.'};
const report={...previous,status:'passed-with-explicit-differences',commit:lock.commit,scope:'Selected unmodified upstream declarations, explicit MapLibre call-recording fixture; no independent GPU or full GeoLens UI.',compositeCasesVerified:compositeCases.length,visibility:'present layer maps false/true to none/visible; absent layer is ignored',differences:{labels:'Default OpenGeo retains labels with each Layer; explicit above-data choices match the GeoLens label stack.',opacity:'Explicit saved composite fill/line opacity matches GeoLens for scalar feature values. Legacy feature mode still multiplies. Omitted fill opacity differs: GeoLens helper defaults to 0.3, referenced MapLibre Style defaults to 1.'},sourceRequestsThisBatch:0,sourceBytesThisBatch:0,cloudCalls:0,applicationBuilds:0,browserRuns:0,aggregateRowsClosed:0};
await writeFile(new URL('parity/reports/geolens-004-presentation-peer.json',root),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,orderingCasesVerified:orderingCases.length,compositeCasesVerified:report.compositeCasesVerified,differences:report.differences}));
