// Retained Studio renderer + actual provider tiles for a committed, read-back map.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const batch=resolve(process.argv[2]),dist=resolve('../.local-archives/collection-preview-viewer-20260923/app/dist');
assert.ok(batch.startsWith(resolve('../.local-archives/bhutan-local-20260920/regional-imagery-reconciliation')+'/'));
const input=await readFile(resolve(batch,'registration.json')),saved=JSON.parse(input);
assert.equal(saved.status,'registered-mapped-both-accounts-verified');
const definition=saved.definition;assert.ok(definition.layers.length>0&&definition.layers.length<=256&&definition.layers.every(l=>l.visible===false));
const resume=process.argv.includes('--resume-hide-check');
const retryProviderTimeout=process.argv.includes('--retry-provider-timeout');
const offlineVisibility=process.argv.includes('--offline-visibility-diagnostic');
const diagnoseVisibility=process.argv.includes('--diagnose-visibility');
assert.ok(!(resume&&retryProviderTimeout));
assert.ok(!(offlineVisibility&&(resume||retryProviderTimeout)));
assert.ok(!(diagnoseVisibility&&(offlineVisibility||resume||retryProviderTimeout)));
const samplePerService=process.argv.includes('--sample-per-service');
const selectedArgument=process.argv.find(a=>a.startsWith('--provider-layer-ids='));
assert.ok(!(resume&&(samplePerService||selectedArgument)));
assert.ok(!(samplePerService&&selectedArgument));
let selected=definition.layers;
if(samplePerService){
 const groups=new Map();
 for(const layer of definition.layers){const group=groups.get(layer.sourceUrl)||[];group.push(layer);groups.set(layer.sourceUrl,group);}
 selected=[...groups.values()].flatMap(group=>{
  group.sort((a,b)=>a.sourceConfiguration.layerIds[0]-b.sourceConfiguration.layerIds[0]);
  return group.length===1?group:[group[0],group.at(-1)];
 });
}
if(selectedArgument){
 assert.equal(new Set(definition.layers.map(l=>l.sourceUrl)).size,1);
 const ids=selectedArgument.split('=')[1].split(',').map(Number);
 assert.ok(ids.length>0&&ids.every(Number.isInteger)&&new Set(ids).size===ids.length);
 selected=definition.layers.filter(l=>ids.includes(l.sourceConfiguration.layerIds[0]));
 assert.equal(selected.length,ids.length);
}
let prior=null;
if(diagnoseVisibility){
 prior=JSON.parse(await readFile(resolve(batch,'browser/receipt.json')));
 assert.equal(prior.status,'failed');assert.equal(prior.registrationSha256,createHash('sha256').update(input).digest('hex'));
 assert.deepEqual(prior.errors,[]);assert.equal(prior.layers.length,1);assert.match(prior.error,/page.waitForFunction: Timeout/);
}
if(retryProviderTimeout){
 prior=JSON.parse(await readFile(resolve(batch,'browser/receipt.json')));
 assert.equal(prior.status,'failed');assert.equal(prior.registrationSha256,createHash('sha256').update(input).digest('hex'));
 assert.deepEqual(prior.unexpected,[]);
 assert.ok(prior.errors.length>0&&prior.errors.every(e=>e.startsWith('TimeoutError: route.fetch: Timeout')));
}
if(resume){
 prior=JSON.parse(await readFile(resolve(batch,'browser/receipt.json')));
 assert.equal(prior.status,'failed');assert.equal(prior.registrationSha256,createHash('sha256').update(input).digest('hex'));
 assert.deepEqual(prior.errors,[]);assert.deepEqual(prior.unexpected,[]);
 assert.ok(prior.layers.length>0&&prior.layers.length<definition.layers.length);
}
const pending=resume?definition.layers.slice(prior.layers.length-1):selected;
const requestLimit=pending.length*16,timeLimit=900000;
const out=resolve(batch,diagnoseVisibility?'browser-visibility-diagnostic':offlineVisibility?'browser-offline-visibility':resume?'browser-continuation':retryProviderTimeout?'browser-provider-retry':'browser');assert.ok(!existsSync(out));await mkdir(out);
const sha=b=>createHash('sha256').update(b).digest('hex');
let fixtureImage=null;
if(offlineVisibility){
 assert.equal(selected.length,1);
 const plan=JSON.parse(await readFile(resolve(batch,'plan.json')));
 const proof=plan.providerEvidence[0],raw=await readFile(resolve('..',proof.path));assert.equal(sha(raw),proof.sha256);
 const observations=JSON.parse(raw);assert.equal(observations.status,'passed');
 const sample=observations.samples.find(x=>x.layerId===selected[0].sourceConfiguration.layerIds[0]);assert.equal(sample.status,'passed');
 fixtureImage=await readFile(resolve('..',sample.image.path));assert.equal(sha(fixtureImage),sample.image.sha256);
}
const workbench='_import/components/'+(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const rendererDir=(await readdir(resolve(dist,'_node'))).find(x=>x.startsWith('maplibre-gl@'));
const renderer=`_node/${rendererDir}/`+(await readdir(resolve(dist,'_node',rendererDir))).find(x=>/^index\..*\.js$/.test(x));
const allowed=new Set(definition.layers.map(l=>l.sourceUrl+'/export'));
const origin='https://regional-imagery.invalid',started=Date.now(),requests=[],errors=[],unexpected=[];
let browser,page,bytes=0;
const result={status:'checking',registrationSha256:sha(input),mapId:saved.mapId,providerRequests:0,s3Requests:0,
 frontendFiles:await Promise.all([workbench,renderer].map(async path=>({path,sha256:sha(await readFile(resolve(dist,path)))}))),
 layers:[],scope:'Actual retained Studio layer installer and MapLibre with live provider PNGs from committed source configuration. Not hosted sign-in or full Workbench interactions.'};
result.registeredLayerCount=definition.layers.length;
result.selectedLayerCount=pending.length;
result.sampled=samplePerService||Boolean(selectedArgument);
if(offlineVisibility)result.scope='Offline visibility diagnostic using a retained provider PNG repeated as test tiles. Actual retained Studio installer and MapLibre; no geographic-placement, current-provider or hosted sign-in claim.';
if(prior)result.priorReceiptSha256=sha(await readFile(resolve(batch,'browser/receipt.json')));
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 page=await browser.newPage({viewport:{width:512,height:400},serviceWorkers:'block'});
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/*',async route=>{
  try{
   const u=new URL(route.request().url());
   if(allowed.has(u.origin+u.pathname)){
    assert.ok(requests.length<requestLimit&&Date.now()-started<timeLimit);
    assert.equal(route.request().method(),'GET');assert.equal(u.searchParams.get('size'),'256,256');
    assert.equal(u.searchParams.get('bboxSR'),'3857');assert.equal(u.searchParams.get('imageSR'),'3857');
    assert.ok(u.searchParams.get('bbox').split(',').every(v=>Number.isFinite(Number(v))));
    const item={url:u.href};requests.push(item);
    if(offlineVisibility){item.offlineFixture=true;item.sha256=sha(fixtureImage);return route.fulfill({contentType:'image/png',body:fixtureImage,headers:{'access-control-allow-origin':origin}});}
    const response=await route.fetch({timeout:45000,maxRedirects:0,maxRetries:0});
    const body=await response.body();bytes+=body.length;assert.ok(body.length<=2*1024**2&&bytes<=16*1024**2);
    assert.equal(response.status(),200);assert.equal(body.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    item.bytes=body.length;item.sha256=sha(body);item.cors=response.headers()['access-control-allow-origin'];
    // CORS from the real provider must authorize the actual production application.
    assert.ok(['*','https://studio.opengeo.tools',origin].includes(item.cors));
    return route.fulfill({response,body,headers:{...response.headers(),'access-control-allow-origin':origin}});
   }
   if(u.origin!==origin){unexpected.push(u.href);return route.abort();}
   if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><style>html,body{margin:0;background:#fff}#map{width:512px;height:400px}</style><div id="map"></div>'});
   const path=resolve(dist,'.'+u.pathname);assert.ok(path.startsWith(dist+'/'));
   return route.fulfill({contentType:extname(path)==='.js'?'text/javascript':'application/octet-stream',body:await readFile(path)});
  }catch(e){errors.push(String(e));await route.abort().catch(()=>{});}
 });
 await page.goto(origin);
 await page.evaluate(async({workbench,renderer,definition})=>{
  const {addMapLayer}=await import('/'+workbench);const {default:maplibre}=await import('/'+renderer);
  const map=new maplibre.Map({container:'map',style:{version:8,sources:{},layers:[{id:'blank',type:'background',paint:{'background-color':'#ffffff'}}]},
   center:[90.45,27.5],zoom:6.5,preserveDrawingBuffer:true,attributionControl:false,fadeDuration:0});
  window.map=map;window.renderErrors=[];map.on('error',e=>renderErrors.push(String(e.error)));
  await new Promise(resolve=>map.once('load',resolve));
  // Compare visible pixels against this fixture's explicit white page background.
  // A cleared transparent buffer and an opaque white buffer look identical here.
  window.visibleCanvasSnapshot=()=>{
   const source=map.getCanvas(),copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;
   const context=copy.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,copy.width,copy.height);context.drawImage(source,0,0);
   return copy.toDataURL();
  };
  window.baseline=visibleCanvasSnapshot();
  const state={map,layerHandles:new Map()};for(const layer of definition.layers)addMapLayer(state,layer,null,[]);
 },{workbench,renderer,definition});
 await page.waitForFunction(()=>map.loaded());assert.equal(requests.length,0);result.hiddenZeroProviderRequests=true;
 // Capture the baseline after a completed paint. The load event can precede the
 // first painted background, making later hidden pixels compare to transparency.
 await page.evaluate(()=>new Promise(resolve=>{
  map.once('render',()=>{window.baseline=visibleCanvasSnapshot();resolve();});
  map.triggerRepaint();
 }));
 result.baselineAfterRender=true;
 result.baselineComparison='Visible canvas pixels composited over the explicit white fixture background; saved layer visibility is checked separately.';
 if(offlineVisibility||diagnoseVisibility){const data=await page.evaluate(()=>baseline);await writeFile(resolve(out,'baseline.png'),Buffer.from(data.split(',')[1],'base64'));}
 for(const layer of pending){
  const start=requests.length;
  await page.evaluate(id=>map.setLayoutProperty(id+'-raster','visibility','visible'),layer.layerId);
  await page.waitForFunction(()=>map.loaded()&&visibleCanvasSnapshot()!==baseline,{},{timeout:90000});
  await page.screenshot({path:resolve(out,layer.datasetId+'.png')});
  assert.ok(requests.length>start);assert.equal(errors.length,0);
  result.layers.push({datasetId:layer.datasetId,title:layer.title,rendered:true,tileRequests:requests.length-start});
  await page.evaluate(id=>map.setLayoutProperty(id+'-raster','visibility','none'),layer.layerId);
  // Hidden-source bookkeeping can remain busy after the actual canvas is blank.
  // Require the visible result and saved visibility, rather than global tile idleness.
  await page.waitForFunction(id=>map.getLayoutProperty(id+'-raster','visibility')==='none'&&visibleCanvasSnapshot()===baseline,layer.layerId,{timeout:offlineVisibility?2000:30000});
 }
 assert.deepEqual(await page.evaluate(()=>renderErrors),[]);assert.deepEqual(unexpected,[]);
 result.status='passed';result.allOffReturnsToBaseline=true;
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{
 if((offlineVisibility||diagnoseVisibility)&&page){
  const state=await page.evaluate(()=>({canvas:map.getCanvas().toDataURL(),layers:map.getStyle().layers.map(l=>({id:l.id,type:l.type,visibility:l.layout?.visibility??'visible'})),loaded:map.loaded(),
   contextLost:map.painter.context.gl.isContextLost(),glError:map.painter.context.gl.getError(),
   canvasBackground:getComputedStyle(map.getCanvas()).backgroundColor,containerBackground:getComputedStyle(map.getContainer()).backgroundColor,
   backgroundPaint:map.getPaintProperty('blank','background-color'),renderErrors})).catch(()=>null);
  await page.screenshot({path:resolve(out,'final-page.png')}).catch(()=>{});
  if(state){await writeFile(resolve(out,'final-canvas.png'),Buffer.from(state.canvas.split(',')[1],'base64'));delete state.canvas;result.finalState=state;}
 }
 Object.assign(result,{providerRequests:offlineVisibility?0:requests.length,offlineFixtureRequests:offlineVisibility?requests.length:0,providerBytes:bytes,requestLimit,timeLimitMilliseconds:timeLimit,requests,errors,unexpected,seconds:(Date.now()-started)/1000});
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');await browser?.close();
 console.log(JSON.stringify({status:result.status,layers:result.layers.length,providerRequests:result.providerRequests,offlineFixtureRequests:result.offlineFixtureRequests,bytes}));
}
