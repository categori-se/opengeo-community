// Offline canvas acceptance; reuse a sealed worker, never fetch provider tiles.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const manifest=JSON.parse(await readFile(resolve('dist/opengeo-studio-release.json'),'utf8'));
const entry=manifest.artifactTree.files.find(f=>f.path.includes('/maplibre-worker.'));
assert.ok(entry,'The retained Studio release must include its map worker');
const worker=await readFile(resolve('app/dist',entry.path));
assert.equal(createHash('sha256').update(worker).digest('hex'),entry.sha256);
const bundle=await build({stdin:{resolveDir:resolve('app'),contents:`
import renderer from './src/lib/mapRenderer.js';
import {resolveLayerStyle} from './src/lib/layerStyleReference.js';
import {patternSld,cartographicPatterns,rasterizePattern} from './src/lib/cartographicPatterns.js';
import {WorkbenchView,addMapLayer,removeMapLayer,setLayerOpacity} from './src/components/WorkbenchView.js';
import {FeatureHaloControls,syncFeatureHalo,clearFeatureHalo} from './src/lib/featureHalo.js';
import {LayerInfo} from './src/components/LayerInfo.js';
import {inspectStaticMapLayers,staticMapDocument} from './src/lib/staticMapExport.js';
import {PatternLegend} from './src/components/PatternLegend.js';
import {emptyMapDefinition,upgradeMapDefinition} from './src/lib/mapDefinition.js';
window.setupPatternProject=async()=>{
 const id='d0000000-0000-4000-8000-000000000002';
 const pattern={id:'waves',foreground:'#0000ff',background:'#ffffff',size:24,width:2,transparent:true};
 const definition=patternSld(pattern,'Water waves');
 const checksumSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const record={id,projectId:id,datasetId:id,title:'Water resource'};
 const style={id,resourceId:id,title:'Water waves',versionNumber:1,format:'sld_1_1',checksumSha256,definition};
 const adapter={listDatasetResources:async()=>[record],listResourceStyles:async()=>[style],getResource:async()=>record,getResourceStyleVersion:async()=>style};
 const layer={layerId:'water',datasetId:id,datasetVersionId:id,sourceVersion:1,sourceType:'governed-dataset',title:'Water',geometryType:'Polygon',visible:true,opacity:0.65,order:0,style:{fill:'#ff0000'},labels:{enabled:false}};
 const geojson={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]]}}]};
 let view;window.reopenPatternProject=()=>{
  view?.dispose?.();view?.remove();
  const saved=localStorage.getItem('pattern-project-fixture');
  const project=saved?upgradeMapDefinition(JSON.parse(saved)):emptyMapDefinition({title:'Pattern project',layers:[layer]});
  view=WorkbenchView({workspace:{workspaceId:id,title:'Patterns'},role:'owner',project,layers:project.layers,geojsonByLayerId:new Map([['water',geojson]]),styleAdapter:adapter,initialPanel:'style',restoreBrowserDraft:false,persistenceMode:'fixture',saveProject:async definition=>{localStorage.setItem('pattern-project-fixture',JSON.stringify(definition));return {id,version:2,definition,updatedAt:new Date().toISOString()}}});
  document.body.replaceChildren(view);
 };window.reopenPatternProject();
};
window.check=async(runtime)=>{
 const require=(ok,msg)=>{if(!ok)throw Error(msg)};
 const id='d0000000-0000-4000-8000-000000000002';
 const base={id:'waves',foreground:'#0000ff',background:'#ffffff',size:24,width:2,transparent:true};
 for(const motif of cartographicPatterns){const r=await rasterizePattern({...base,id:motif.id});const alpha=[...r.pixels.data].filter((_,i)=>i%4===3);require(Math.max(...alpha)>0&&Math.min(...alpha)===0,'motif alpha '+motif.id);}
 const definition=patternSld(base,'Water');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const reference={projectId:id,resourceId:id,styleId:id,versionNumber:1,format:'sld_1_1',checksumSha256:hash};
 const layer={layerId:'water',datasetId:id,sourceType:'governed-dataset',geometryType:'Polygon',styleReference:reference,opacity:1,visible:true};
 const adapter={getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async()=>({id,resourceId:id,versionNumber:1,format:'sld_1_1',checksumSha256:hash,definition,title:'Water'})};
 const bound=await resolveLayerStyle(adapter,layer);
 const legend=PatternLegend(bound);document.body.append(legend);
 const legendImage=getComputedStyle(legend.querySelector('i')).backgroundImage;
 require(legend.textContent.includes('Water')&&legend.textContent.includes('Style version 1'),'legend identity missing');
 const preview=new Image();preview.src=legendImage.slice(5,-2);await preview.decode();
 require(preview.naturalWidth===base.size,'legend tile scale differs from map');
 const map=new renderer.Map({container:'map',style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ff0000'}}]},center:[0,0],zoom:3,preserveDrawingBuffer:true,interactive:false,attributionControl:false});
 const failures=[];map.on('error',e=>failures.push(e.error?.message));
 const idle=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('map timeout')),10000);map.once('idle',()=>{clearTimeout(t);resolve()});map.triggerRepaint()});
 const count=()=>{const canvas=map.getCanvas(),gl=canvas.getContext('webgl2');const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);let n=0;for(let i=0;i<data.length;i+=4)if(data[i+2]>20)n++;return n;};
 try{
 await idle();const state={map,layerHandles:new Map(),resolvedLayerStyles:new Map([['water',bound]])};
 const geometry={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]]}}]};
 addMapLayer(state,layer,geometry,[]);await idle();const visible=count();require(visible>500,'pattern not rendered');
 setLayerOpacity(state,'water',0);await idle();require(count()===0,'zero opacity still renders');
 setLayerOpacity(state,'water',1);await idle();require(count()===visible,'opacity restore changed pattern');
 const image=bound.images[0].id;require(map.hasImage(image),'image absent');removeMapLayer(state,'water');await idle();require(!map.hasImage(image)&&count()===0,'image/layer cleanup failed');
 addMapLayer(state,layer,geometry,[]);await idle();require(map.hasImage(image)&&count()===visible,'reinstall failed');
 const info=LayerInfo({layer:{...layer,title:'India · OSM · Protected areas · full descriptive layer name'},metadata:'Polygon · saved data'});
 document.body.append(info.button,info.content);require(info.content.hidden,'details start open');info.button.click();require(!info.content.hidden&&info.content.textContent.includes('full descriptive layer name'),'full layer name missing');info.button.click();require(info.content.hidden,'details cannot close');
 state.activeLayerId=layer.layerId;const controls=FeatureHaloControls({state,layers:[layer]});document.body.append(controls);
 controls.querySelector('input[type=checkbox]').click();await idle();require(map.getLayer('water-visibility-halo'),'halo missing');
 const slider=controls.querySelector('input[type=range]');slider.value='12';slider.dispatchEvent(new Event('input'));await idle();require(map.getPaintProperty('water-visibility-halo','line-width')===24,'halo slider not applied');
 const intensity=controls.querySelector('[aria-label="Feature halo intensity"]');intensity.value='25';intensity.dispatchEvent(new Event('input'));await idle();require(map.getPaintProperty('water-visibility-halo','line-opacity')===.25,'halo intensity not applied');
 intensity.value='0';intensity.dispatchEvent(new Event('input'));await idle();require(map.getPaintProperty('water-visibility-halo','line-opacity')===0,'zero intensity not respected');
 require(controls.textContent.includes('Selected: water'),'selected halo target missing');
 layer.visible=false;syncFeatureHalo({state,layers:[layer]});require(!map.getLayer('water-visibility-halo'),'hidden layer keeps halo');layer.visible=true;
 controls.querySelector('input[type=checkbox]').click();require(!map.getLayer('water-visibility-halo'),'disabled halo remains');
 require(intensity.disabled&&slider.disabled,'disabled halo sliders remain active');
 const exportHtml=staticMapDocument({...runtime,title:'Pattern export',view:{center:[0,0],zoom:3},candidates:inspectStaticMapLayers({style:map.getStyle(),layers:[layer],handles:state.layerHandles}),selectedIds:[layer.layerId]});
 require(!failures.length,failures.join('; '));return {exportHtml,motifs:cartographicPatterns.length,visiblePixels:visible,opacity:true,cleanup:true,reinstall:true,layerInfoToggle:true,haloToggleWidthAndVisibility:true,patternLegend:true,externalRequests:0,limits:'Synthetic geometry and fixture Style reads; not account persistence, physical GPU or server-compiled artifact evidence'};
 }finally{map.remove()}
};`},bundle:true,format:'esm',write:false,plugins:[{name:'worker',setup(b){b.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'stdlib',namespace:'local'}));b.onLoad({filter:/.*/,namespace:'local'},()=>({contents:"export const FileAttachment=()=>({url:async()=>'/worker.js'});"}));}}]});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium-browser'});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{const u=new URL(r.request().url());assert.equal(u.hostname,'studio.test');return r.fulfill(u.pathname==='/bundle.js'?{contentType:'text/javascript',body:bundle.outputFiles[0].text}:u.pathname==='/worker.js'?{contentType:'text/javascript',body:worker}:{contentType:'text/html',body:'<!doctype html><div id="map" style="width:256px;height:256px"></div><script type="module" src="/bundle.js"></script>'})});
 if(process.env.OPENGEO_WORKER_PATTERN_CHECK==='1'){
  const runtime=await readFile(resolve('app/dist/export-runtime/maplibre-gl.js'),'utf8');
  const script=await readFile(resolve('services/worker/scripts/render-maplibre.mjs'),'utf8');
  const marker='const result = await page.evaluate(';
  const callback=script.slice(script.indexOf(marker)+marker.length,script.indexOf(', {style, request: {view: request.view'));
  const fixture=JSON.parse(await readFile(resolve('services/api/tests/fixtures/cartographic-patterns.json'),'utf8'))[2];
  await page.goto('https://studio.test/');await page.evaluate(()=>{document.body.innerHTML='<div id="map" style="width:256px;height:256px"></div>'});
  await page.addScriptTag({content:runtime});await page.evaluate(()=>{window.opengeoMapLibre=window.maplibregl});
  const patternId='pattern-'+'a'.repeat(64);
  const source={type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]]]}}};
  const style={version:8,sources:{water:source},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}},{id:'water',source:'water',type:'fill',paint:{'fill-pattern':patternId,'fill-opacity':1}}]};
  const request={view:{center:[0,0],zoom:3},maplibreVersion:await page.evaluate(()=>window.maplibregl.getVersion()),occurrences:[{style:{metadata:{'opengeo:patterns':{[patternId]:{svg:fixture.svg,size:24}}}}}]};
  const result=await page.evaluate(new Function('return ('+callback+')')(),{style,request});
  const pixels=await page.evaluate(async png=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const d=ctx.getImageData(0,0,256,256).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i+2]>d[i]+20&&d[i+2]>d[i+1]+20)n++;return n},result.png);
  assert.ok(pixels>500);assert.deepEqual(errors,[]);delete result.png;
  console.log(JSON.stringify({status:'pass',workerCallback:true,patternPixels:pixels,...result,scope:'Exact worker page callback with local packaged runtime; not isolated launcher, account or deployment acceptance'}));
 }else if(process.env.OPENGEO_PATTERN_PROJECT_CHECK==='1'){
  const css=await readFile(resolve('app/src/style.css'),'utf8');
  await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.hostname!=='studio.test')return r.fulfill({json:{version:8,sources:{},layers:[]}});return r.fallback()});
  await page.goto('https://studio.test/');await page.waitForFunction(()=>window.setupPatternProject);
  await page.addStyleTag({content:css});await page.evaluate(()=>window.setupPatternProject());
  await page.getByRole('button',{name:'Find Styles for this Layer',exact:true}).click();
  await page.getByRole('button',{name:'Styles in Water resource',exact:true}).click();
  await page.getByRole('button',{name:'Apply Water waves',exact:true}).click();
  await page.locator('.gis-panel-right .gis-pattern-legend').filter({hasText:'Water waves'}).first().waitFor();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('[data-save-state="saved"]').waitFor();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('pattern-project-fixture')));
  assert.equal(saved.layers[0].styleReference.format,'sld_1_1');assert.equal(saved.layers[0].opacity,.65);
  assert.equal(JSON.stringify(saved).includes('StyledLayerDescriptor'),false);
  await page.evaluate(()=>window.reopenPatternProject());
  await page.locator('.gis-panel-right .gis-pattern-legend').filter({hasText:'Water waves'}).first().waitFor();
  await page.waitForFunction(()=>{const map=document.querySelector('.opengeo-workbench').__opengeoMap;return map?.getLayer('water-style-0')&&map.loaded()});
  const paint=await page.evaluate(()=>{const map=document.querySelector('.opengeo-workbench').__opengeoMap;return {image:map.getPaintProperty('water-style-0','fill-pattern'),images:map.listImages(),opacity:map.getPaintProperty('water-style-0','fill-opacity')}});
  assert.ok(paint.images.includes(paint.image));assert.equal(paint.opacity,.65);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'pass',patternPicker:true,stylePanelLegend:true,saveReopen:true,referenceRetained:true,opacityRetained:true,imageReinstalled:true,scope:'Workbench UI with fixture storage; no API/account persistence claim',externalRequests:0}));
 }else{
 await page.goto('https://studio.test/');await page.waitForFunction(()=>window.check);const runtime={};for(const [key,file] of [['runtimeJs','maplibre-gl.js'],['runtimeCss','maplibre-gl.css'],['runtimeLicense','LICENSE.txt']])runtime[key]=await readFile(resolve('app/dist/export-runtime',file),'utf8');
 const result=await page.evaluate(runtime=>window.check(runtime),runtime);assert.deepEqual(errors,[]);
 const exported=await browser.newPage({viewport:{width:256,height:256}});
 await exported.addInitScript(()=>Object.defineProperty(window,'maplibregl',{configurable:true,get(){return this.__engine},set(engine){const Original=engine.Map;this.__engine={...engine,Map:new Proxy(Original,{construct(target,args){args[0].canvasContextAttributes={preserveDrawingBuffer:true};window.observedMap=Reflect.construct(target,args);return window.observedMap}})}}}));
 exported.on('pageerror',e=>errors.push(e.message));
 await exported.route('**/*',route=>{assert.equal(route.request().url(),'https://pattern-export.test/');return route.fulfill({contentType:'text/html',body:result.exportHtml})});
 await exported.goto('https://pattern-export.test/');
 assert.deepEqual(errors,[]);
 await exported.waitForFunction(()=>window.observedMap?.loaded()&&document.getElementById('status').textContent.startsWith('Offline edition'));
 await exported.evaluate(()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('export render timeout')),10000);window.observedMap.once('idle',()=>{clearTimeout(timer);resolve()});window.observedMap.triggerRepaint()}));
 const pixels=await exported.evaluate(()=>{const map=window.observedMap,canvas=map.getCanvas(),gl=canvas.getContext('webgl2'),data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);let count=0;for(let i=0;i<data.length;i+=4)if(data[i+2]>data[i]+20&&data[i+2]>data[i+1]+20)count++;return {count,images:map.listImages(),pattern:map.getPaintProperty('water-style-0','fill-pattern'),paint:map.getStyle().layers.find(layer=>layer.id==='water-style-0').paint,features:map.queryRenderedFeatures({layers:['water-style-0']}).length,status:document.getElementById('status').textContent,sources:map.getStyle().sources,rgba:[...data.slice(0,4)],size:[canvas.width,canvas.height]}});
 assert.ok(pixels.count>500,'exported pattern has no blue pixels: '+JSON.stringify(pixels));assert.ok(pixels.images.includes(pixels.pattern));assert.deepEqual(errors,[]);
 delete result.exportHtml;console.log(JSON.stringify({status:'pass',...result,portablePatternPixels:pixels.count,portableCsp:true}));
}
}finally{await browser.close()}
