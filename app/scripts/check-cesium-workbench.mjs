// Offline real Workbench + SDK journey. Saved API responses are local fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {prepareCesiumRuntime} from './prepare-cesium-runtime.mjs';
import {CESIUM_RUNTIME} from '../src/lib/cesiumRuntime.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=await mkdtemp(`${tmpdir()}/opengeo-cesium-workbench-`);
const built=process.env.OPENGEO_CESIUM_BUILT_CHECK==='1';
const imageryOnly=process.env.OPENGEO_CESIUM_IMAGERY_CHECK==='1';
const areaLabels=process.env.OPENGEO_CESIUM_AREA_LABEL_CHECK==='1';
const labelsOnly=areaLabels || process.env.OPENGEO_CESIUM_LABEL_CHECK==='1';
const thematicOnly=process.env.OPENGEO_CESIUM_THEMATIC_CHECK==='1';
let browser;
try {
 await prepareCesiumRuntime(out);
 const manifest=JSON.parse(await readFile(resolve(root,built?'../dist/opengeo-studio-build.json':'../dist/opengeo-studio-release.json'),'utf8'));
 const workbench=manifest.artifactTree.files.find(file=>/^_import\/components\/WorkbenchView\.[a-f0-9]+\.js$/.test(file.path));
 const worker=manifest.artifactTree.files.find(file=>file.path.includes('/maplibre-worker.'));
 const host=await build({entryPoints:[resolve(root,'src/lib/cesiumFrameHost.js')],bundle:true,format:'esm',write:false});
 const bundle=await build({stdin:{resolveDir:root,contents:`
 import {WorkbenchView} from './src/components/WorkbenchView.js';
 import {PINNED_MAP_FONT} from './src/lib/mapFonts.js';
 import {emptyMapDefinition,upgradeMapDefinition} from './src/lib/mapDefinition.js';
 const id='d0000000-0000-4000-8000-000000000002';
 const thematic=${thematicOnly},labelsOnly=${labelsOnly},areaLabels=${areaLabels};
 const fill=thematic?['match',['get','kind'],'one','#ff0000','two','#00ff00','#0000ff']:'#ff0000';
 const definition=JSON.stringify({version:8,sources:{},layers:[{id:'fill',type:'fill',paint:{'fill-color':fill,'fill-outline-color':'#ff0000','fill-opacity':1}}]});
 const checksumSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const styleReference={projectId:id,resourceId:id,styleId:id,versionNumber:3,format:'maplibre',checksumSha256};
 const styleAdapter={getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async()=>{if(window.holdStyle)await new Promise(resolve=>{window.releaseStyle=()=>{window.holdStyle=false;resolve();};});return {id,resourceId:id,title:'Survey Style',versionNumber:3,format:'maplibre',checksumSha256,definition};}};
 const layer={layerId:'survey',datasetId:id,datasetVersionId:id,sourceVersion:1,title:'Survey boundary',sourceType:'governed-dataset',geometryType:'Polygon',visible:true,opacity:0.6,order:0,style:{fill:'#0000ff'},styleReference,labels:{enabled:false}};
 const marker={...layer,layerId:'point',title:'Observation',geometryType:'Point',styleReference:undefined,order:1,visible:false,style:{circleColor:'#0000ff',circleRadius:8}};
 const data={type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Retained survey',license:'retained'},geometry:{type:'Polygon',coordinates:[[[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]]]}}]};
 if(thematic){
   layer.filter=['!=',['get','status'],'excluded'];
   const polygon=(id,kind,status,west,south,east,north)=>({type:'Feature',id,properties:{kind,status,name:id},geometry:{type:'Polygon',coordinates:[[[west,south],[east,south],[east,north],[west,north],[west,south]]]}});
   data.features=[polygon('a','one','keep',-4,-1,-1,1),polygon('b','two','keep',1,-1,4,1),polygon('c','other','excluded',-1,-4,1,-2)];
   window.thematicData=data;
 }
 const point={type:'FeatureCollection',features:[{type:'Feature',id:'p',properties:{name:'Observation'},geometry:{type:'Point',coordinates:[2,2]}}]};
 if(labelsOnly){
   marker.visible=true;marker.labels={enabled:true,field:'name',fontRef:PINNED_MAP_FONT,size:18,color:'#ff00ff',haloColor:'#ffffff',haloWidth:1,allowOverlap:false};
   marker.filter=['==',['get','status'],'keep'];point.features[0].properties={name:'Site A monitoring location',status:'keep'};
   point.features.push({type:'Feature',id:'nearby',properties:{name:'Nearby',status:'keep'},geometry:{type:'Point',coordinates:[2.01,2]}});
   point.features.push({type:'Feature',id:'excluded',properties:{name:'Hidden',status:'excluded'},geometry:{type:'Point',coordinates:[-2,2]}});
 }
 const mapFontAttachments=labelsOnly?{manifest:async()=>await (await fetch('/font/manifest.json')).arrayBuffer(),range:async range=>await (await fetch('/font/'+range+'.pbf')).arrayBuffer()}:null;
 const layers=[layer,marker],layerData=new Map([['survey',data],['point',point]]);
 if(areaLabels){
   layer.geometryType='MultiPolygon';layer.labels={...marker.labels,color:'#00aaff',size:18};
   data.features=[{type:'Feature',id:'region-original',properties:{name:'Region'},geometry:{type:'MultiPolygon',coordinates:[
     [[[-4,-4],[0,-4],[0,0],[-4,0],[-4,-4]],[[-3,-3],[-3,-1],[-1,-1],[-1,-3],[-3,-3]]],
     [[[1,-3],[3,-3],[3,-1],[1,-1],[1,-3]]]
   ]}}];
   const line={...marker,layerId:'route',title:'Route',geometryType:'LineString',style:{stroke:'#333333',strokeWidth:3},labels:{...marker.labels,color:'#ffff00',size:18}};
   layers.push(line);layerData.set('route',{type:'FeatureCollection',features:[{type:'Feature',id:'line-original',properties:{name:'Route',status:'keep'},geometry:{type:'LineString',coordinates:[[-3,3],[0,3],[1,3.5]]}},{type:'Feature',id:'line-excluded',properties:{name:'Excluded',status:'excluded'},geometry:{type:'LineString',coordinates:[[-3,-4],[0,-4]]}}]});
 }
 const project=emptyMapDefinition({schemaVersion:'opengeo.map-definition.1.4.0',title:'Renderer survey',layers,mapViews:[{center:[0,0],zoom:5,bearing:12,pitch:15}],extensions:{fixture:{note:'retained'}}});
 project.layerTree=[{id:'survey-folder',kind:'group',title:'Field survey',children:layers.map(layer=>({kind:'layer',layerId:layer.layerId}))}];
 window.fixtureProject=structuredClone(project);
 window.reopen=()=>{
 window.view?.dispose();window.view?.remove();
 const saved=localStorage.getItem('cesium-project');const reopened=saved?upgradeMapDefinition(JSON.parse(saved)):project;
 window.view=WorkbenchView({workspace:{workspaceId:id,title:'Survey'},role:'owner',project:reopened,layers:reopened.layers,geojsonByLayerId:layerData,styleAdapter,mapFontAttachments,restoreBrowserDraft:window.restoreDrafts===true,persistenceMode:'fixture',saveProject:async definition=>{localStorage.setItem('cesium-project',JSON.stringify(definition));return {id,version:2,definition};}});
 document.body.append(view);
 };window.reopen();
 `},bundle:true,format:'esm',write:false,plugins:[{name:'fixtures',setup(builder){
 if(built)builder.onResolve({filter:/components\/WorkbenchView\.js$/},()=>({path:'/'+workbench.path,external:true}));
 builder.onResolve({filter:/cesiumFrameHost\.js$/},()=>({path:'/host.js',external:true}));
 builder.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'stdlib',namespace:'local'}));
 builder.onLoad({filter:/.*/,namespace:'local'},()=>({contents:`export const FileAttachment=()=>({url:async()=>'/worker.js'});`}));
 }}]});
 const policySource=await readFile(resolve(root,'../infrastructure/lib/renderer-frame.ts'),'utf8');
 const hostPolicy=[...policySource.split('export const RENDERER_FRAME_CSP = [')[1].split('].join')[0].matchAll(/"([^"\n]+)"/g)].map(match=>match[1]).join('; ');
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium-browser'});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],denied=[],requests=[];
 let failHost=false,providerFixtures=0,failImagery=false;
 const imageryRequests=[];
 const tile=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const context=canvas.getContext('2d');context.fillStyle='#1234ab';context.fillRect(0,0,256,256);return canvas.toDataURL().split(',')[1];}),'base64');
 page.on('console',message=>{if(message.type()==='error')console.error('browser:',message.text());});
 page.on('pageerror',error=>{errors.push(error.message);console.error('pageerror:',error.message);});
 await page.route('**/*',async route=>{
 const url=new URL(route.request().url());requests.push(url.pathname);
 if(url.origin!=='https://studio.test') {
  providerFixtures++;
  if(url.hostname==='gibs.earthdata.nasa.gov') {
    const native=Boolean(route.request().frame().parentFrame());
    imageryRequests.push({path:url.pathname,native});assert.ok(imageryRequests.length<=240,'Bounded imagery fixture budget including one saved-Project reopen');
    return route.fulfill({status:failImagery&&native?503:200,contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:tile});
  }
  return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]})});
 }
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https:; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'"},body:'<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/libre.css"><style>body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module" src="/test.js"></script>'});
 if(built && /^\/_(import|npm|node|file|observablehq)\//.test(url.pathname)) {
  if(failHost && url.pathname.includes('/cesiumFrameHost.') && route.request().frame().parentFrame())return route.abort();
  const path=resolve(root,'dist',`.${url.pathname}`);assert.ok(path.startsWith(resolve(root,'dist')+'/'));
  return route.fulfill({contentType:({js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',png:'image/png',svg:'image/svg+xml'})[path.split('.').at(-1)]??'application/octet-stream',body:await readFile(path)});
 }
 if(url.pathname.startsWith('/font/') && /^[A-Za-z0-9.-]+$/.test(url.pathname.slice(6)))return route.fulfill({body:await readFile(resolve(root,'src/assets/render-fonts/opengeo-open-sans-v1/1',url.pathname.slice(6)))});
 if(url.pathname==='/test.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
 if(url.pathname==='/host.js') {if(failHost && route.request().frame().parentFrame())return route.abort();return route.fulfill({contentType:'text/javascript',body:host.outputFiles[0].text});}
 if(url.pathname==='/worker.js')return route.fulfill({contentType:'text/javascript',body:await readFile(resolve(root,'dist',worker.path))});
 if(['/style.css','/libre.css'].includes(url.pathname))return route.fulfill({contentType:'text/css',body:await readFile(resolve(root,url.pathname==='/style.css'?'src/style.css':'node_modules/maplibre-gl/dist/maplibre-gl.css'))});
 if(url.pathname.startsWith(CESIUM_RUNTIME.basePath))return route.fulfill({headers:url.pathname.endsWith('.html')?{'Content-Security-Policy':hostPolicy,'X-Frame-Options':'SAMEORIGIN'}:{},contentType:({html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',png:'image/png'})[url.pathname.split('.').at(-1)]??'application/octet-stream',body:await readFile(resolve(built?resolve(root,'dist'):out,`.${url.pathname}`))});
 denied.push(url.pathname);return route.abort();
 });
 await page.goto('https://studio.test/');page.setDefaultTimeout(25000);
 try {await page.waitForFunction(area=>window.view?.__opengeoMap?.isStyleLoaded() && view.__opengeoMap.getLayer('survey-style-0'),areaLabels);}
 catch(error){console.error(JSON.stringify({stage:'initial-map',errors,denied,body:await page.locator('body').innerText(),layers:await page.evaluate(()=>window.view?.__opengeoMap?.getStyle?.()?.layers?.map(layer=>layer.id))}));throw error;}
 assert.equal(requests.some(path=>path.startsWith(CESIUM_RUNTIME.basePath)),false);
 if(built)assert.equal(requests.some(path=>path.includes('maplibre-gl-style-spec') || /\/cesiumStyle\.[^/]+\.js$/.test(path)),false,'Native expression evaluator must not load during startup');
 const panel=page.locator('.gis-renderer-panel');
 if(labelsOnly){
   await page.waitForFunction(area=>view.__opengeoMap.getLayer('point-labels') && (!area || view.__opengeoMap.getLayer('survey-labels')),areaLabels);
   const before=await page.evaluate(()=>JSON.stringify(view.__opengeoLayers));
   await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
   await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
   await panel.getByLabel('Use a plain globe in Cesium.',{exact:false}).check();
   await panel.getByRole('button',{name:'Use Cesium',exact:true}).click();
   try{await page.waitForFunction(()=>view.dataset.renderer==='cesium');}
   catch(error){console.error(JSON.stringify({stage:'label-activation',panel:await panel.innerText(),errors,denied}));throw error;}
   const labelPixels=()=>page.evaluate(()=>{
     const canvas=view.querySelector('iframe').contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2');
     const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
     const scene=view.__opengeoMap.scene,excluded=scene.project([-2,2]);let count=0,excludedPixels=0,picked=null;const pickedIds=new Set(),rows=new Set(),samples=[];
     for(let i=0;i<pixels.length;i+=4)if(pixels[i]>160 && pixels[i+2]>160 && pixels[i+1]<100){
       count++;const x=(i/4%canvas.width+.5)*canvas.clientWidth/canvas.width,y=(canvas.height-.5-Math.floor(i/4/canvas.width))*canvas.clientHeight/canvas.height;
       if(Math.abs(x-excluded.x)<70 && y>excluded.y && y<excluded.y+70)excludedPixels++;
       // Click pixel centres inside the glyph, not antialiased fringe pixels
       // that can legitimately fall through to the geometry beneath the text.
       if(pixels[i+2]>230 && pixels[i+1]<40)samples.push({x,y});
       rows.add(Math.round(y));
     }
     for(let i=0;i<samples.length;i+=Math.max(1,Math.ceil(samples.length/32))){const hit=scene.pick(samples[i]);picked??=hit;if(hit?.layerId==='point')pickedIds.add(hit.feature.id);}
     return {count,excludedPixels,picked,pickedIds:[...pickedIds],rows:[...rows].sort((a,b)=>a-b)};
   });
   const visible=await labelPixels(),visiblePixels=visible.count;assert.ok(visiblePixels>40,'Native glyphs must produce visible magenta pixels');
   assert.equal(visible.excludedPixels,0,'Excluded features must not leave label glyphs');
   if(visible.picked?.feature.id!=='p')console.error(JSON.stringify({stage:'label-picking',visible}));
   assert.equal(visible.picked?.feature.id,'p','Picking a glyph must return its original feature');
   assert.deepEqual(visible.pickedIds,['p'],'Nearby colliding label must be suppressed');
   assert.ok(visible.rows.at(-1)-visible.rows[0]>25,'Long label must wrap into visible rows');
   assert.equal(await page.evaluate(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([-2,2]))?.layerId==='point'),false);
   let geometryLabels=null;
   if(areaLabels){
     geometryLabels=await page.evaluate(()=>{
       const scene=view.__opengeoMap.scene,canvas=view.querySelector('iframe').contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2');
       const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
       const area=[],line=[];let areaPixels=0,linePixels=0;
       for(let i=0;i<pixels.length;i+=4){
         const point={x:(i/4%canvas.width+.5)*canvas.clientWidth/canvas.width,y:(canvas.height-.5-Math.floor(i/4/canvas.width))*canvas.clientHeight/canvas.height};
         if(pixels[i]<100 && pixels[i+1]>80 && pixels[i+1]<220 && pixels[i+2]>180)areaPixels++;
         if(pixels[i]>160 && pixels[i+1]>160 && pixels[i+2]<100)linePixels++;
         if(pixels[i]<20 && pixels[i+1]>150 && pixels[i+1]<190 && pixels[i+2]>230)area.push(point);
         if(pixels[i]>230 && pixels[i+1]>230 && pixels[i+2]<40)line.push(point);
       }
       const hits=points=>{const ids=new Set(),types=new Set();for(let i=0;i<points.length;i+=Math.max(1,Math.ceil(points.length/32))){const hit=scene.pick(points[i]);if(hit){ids.add(hit.feature.id);types.add(hit.feature.geometry.type);}}return {ids:[...ids],types:[...types]};};
       return {areaPixels,linePixels,areaInteriorPixels:area.length,lineInteriorPixels:line.length,area:hits(area),line:hits(line)};
     });
     assert.ok(geometryLabels.areaPixels>40 && geometryLabels.linePixels>40,JSON.stringify(geometryLabels));
     assert.deepEqual(geometryLabels.area,{ids:['region-original'],types:['MultiPolygon']});
     assert.deepEqual(geometryLabels.line,{ids:['line-original'],types:['LineString']});
   }
   assert.equal(await page.evaluate(()=>JSON.stringify(view.__opengeoLayers)),before);
   await page.getByRole('checkbox',{name:'Show Observation',exact:true}).uncheck();
   await page.waitForFunction(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([2,2]))?.layerId!=='point');
   assert.equal((await labelPixels()).count,0,'Hidden Layers must hide labels too');
   await page.getByRole('checkbox',{name:'Show Observation',exact:true}).check();
   await page.waitForFunction(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([2,2]))?.layerId==='point');
   await page.evaluate(()=>view.__opengeoMap.scene.setCamera({center:[2.005,2],zoom:15,bearing:0,pitch:0}));
   await page.waitForFunction(()=>Math.abs(view.__opengeoMap.scene.getCamera().zoom-15)<.01);
   await page.waitForFunction(()=>{
     const scene=view.__opengeoMap.scene,canvas=view.querySelector('iframe').contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2'),point=scene.project([2,2]);
     const left=Math.max(0,Math.floor((point.x-90)*canvas.width/canvas.clientWidth)),top=Math.max(0,Math.floor((point.y+15)*canvas.height/canvas.clientHeight));
     const width=Math.min(180,canvas.width-left),height=Math.min(80,canvas.height-top);
     if(width<=0 || height<=0)return false;
     const pixels=new Uint8Array(width*height*4);gl.readPixels(left,canvas.height-top-height,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
     let count=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>160 && pixels[i+2]>160 && pixels[i+1]<100)count++;
     return count>40;
   },null,{timeout:10000,polling:250});
   const separated=await labelPixels();assert.deepEqual(separated.pickedIds.sort(),['nearby','p'],'Camera changes must restore labels when there is room');
   await page.locator('.gis-save-command').click();await page.waitForFunction(()=>localStorage.getItem('cesium-project'));
   const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('cesium-project')));
   assert.deepEqual(saved.layers.find(layer=>layer.layerId==='point').labels,JSON.parse(before).find(layer=>layer.layerId==='point').labels);
   if(areaLabels){
     const original=JSON.parse(before).find(layer=>layer.layerId==='survey'),stored=saved.layers.find(layer=>layer.layerId==='survey');
     assert.deepEqual(stored.styleReference,original.styleReference);assert.deepEqual(stored.labels,original.labels);
   }
   await page.locator('.gis-toolstrip').getByRole('button',{name:'Rendering engine',exact:true}).click();
   await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
   await page.waitForFunction(()=>view.dataset.renderer==='maplibre' && view.__opengeoMap.getLayer('point-labels'));
   if(areaLabels)await page.waitForFunction(()=>view.__opengeoMap.getLayer('survey-style-0') && view.__opengeoMap.getLayer('survey-labels'));
   assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
   console.log(JSON.stringify({status:'pass',combinedPinnedStyleAndLabels:areaLabels,labelsOnly:true,areaLabels,geometryLabels,builtModules:built,visiblePixels,collisionSuppression:true,wrapping:true,cameraRelayout:true,filteredLabels:true,visibility:true,pinnedFontSave:true,returnToMapLibre:true,externalRequests:0,providerFixtures,localRequests:requests.length,limits:'Point labels with native wrapping and collision placement; Curved/repeated line and polar area labels remain unsupported. Local save fixtures, not production acceptance.'}));
 }else if(thematicOnly){
   const before=await page.evaluate(()=>({layers:JSON.stringify(view.__opengeoLayers),data:JSON.stringify(thematicData)}));
   await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
   await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
   await panel.getByLabel('Use a plain globe in Cesium.',{exact:false}).check();
   await panel.getByRole('button',{name:'Use Cesium',exact:true}).click();
   try{await page.waitForFunction(()=>view.dataset.renderer==='cesium');}
   catch(error){console.error(JSON.stringify({stage:'thematic-activation',panel:await panel.innerText(),errors}));throw error;}
   const result=await page.evaluate(()=>{
     const scene=view.__opengeoMap.scene,canvas=view.querySelector('iframe').contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2');
     const pixel=position=>{const point=scene.project(position),value=new Uint8Array(4);gl.readPixels(Math.floor(point.x*canvas.width/canvas.clientWidth),canvas.height-1-Math.floor(point.y*canvas.height/canvas.clientHeight),1,1,gl.RGBA,gl.UNSIGNED_BYTE,value);return [...value];};
     return {red:pixel([-2,0]),green:pixel([2,0]),first:scene.pick(scene.project([-2,0])),second:scene.pick(scene.project([2,0])),excluded:scene.pick(scene.project([0,-3])),layers:JSON.stringify(view.__opengeoLayers),data:JSON.stringify(thematicData)};
   });
   assert.ok(result.red[0]>result.red[1]+50);assert.ok(result.green[1]>result.green[0]+50);
   assert.equal(result.first.feature.id,'a');assert.equal(result.second.feature.id,'b');assert.equal(result.second.featureIndex,1);assert.equal(result.excluded,null);
   assert.equal(result.layers,before.layers);assert.equal(result.data,before.data);
   await page.locator('.gis-save-command').click();
   await page.waitForFunction(()=>localStorage.getItem('cesium-project'));
   const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('cesium-project')));
   assert.deepEqual(saved.layers[0].filter,['!=',['get','status'],'excluded']);assert.equal(saved.layers[0].styleReference.versionNumber,3);
   await page.locator('.gis-toolstrip').getByRole('button',{name:'Rendering engine',exact:true}).click();
   await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
   await page.waitForFunction(()=>view.dataset.renderer==='maplibre' && view.__opengeoMap.isStyleLoaded());
   const restored=await page.evaluate(()=>view.__opengeoMap.getStyle().layers.find(part=>part.id==='survey-style-0'));
   assert.deepEqual(restored.filter,saved.layers[0].filter);assert.equal(restored.paint['fill-color'][0],'match');
   assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
   console.log(JSON.stringify({status:'pass',thematicOnly:true,builtModules:built,treeDigest:built?manifest.artifactTree.digest:null,red:result.red,green:result.green,filteredPicking:true,originalIndices:true,canonicalDataAndLayersUnchanged:true,pinnedStyleAndFilterSave:true,returnToMapLibre:true,externalRequests:0,providerFixtures,localRequests:requests.length,limits:'Synthetic features and local Style/save fixtures; no live account or full renderer parity claim.'}));
 }else{
 if(!imageryOnly){
 await page.evaluate(()=>{window.original=view.__opengeoMap;window.before=JSON.stringify(view.__opengeoLayers);window.beforeCamera={center:original.getCenter(),zoom:original.getZoom(),bearing:original.getBearing(),pitch:original.getPitch()};});
 await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
 await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
 await panel.getByLabel('Use a plain globe in Cesium.',{exact:false}).check();
 await panel.getByRole('button',{name:'Use Cesium',exact:true}).click();
 try{await panel.getByText('Current: Cesium',{exact:true}).waitFor();}
 catch(error){console.error(JSON.stringify({panel:await panel.innerText(),errors,denied}));throw error;}
 const switched=await page.evaluate(()=>({removed:original._removed,unchanged:JSON.stringify(view.__opengeoLayers)===before,camera:view.__opengeoMap.scene.getCamera(),beforeCamera}));
 assert.equal(switched.removed,true);assert.equal(switched.unchanged,true);
 for(const [actual,expected] of [[switched.camera.zoom,switched.beforeCamera.zoom],[switched.camera.pitch,switched.beforeCamera.pitch],[switched.camera.bearing,switched.beforeCamera.bearing]])assert.ok(Math.abs(actual-expected)<0.01);
 await page.getByRole('checkbox',{name:'Show Observation',exact:true}).check();
 await page.waitForFunction(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([2,2]))?.layerId==='point');
 await page.getByRole('checkbox',{name:'Show Survey boundary',exact:true}).uncheck();
 await page.waitForFunction(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([2,0]))===null);
 await page.getByRole('checkbox',{name:'Show Survey boundary',exact:true}).check();
 const screen=await page.evaluate(()=>view.__opengeoMap.scene.project([2,0]));
 const frame=await page.locator('iframe[title="Cesium map"]').boundingBox();
 await page.mouse.click(frame.x+screen.x,frame.y+screen.y);
 await page.locator('.gis-panel-right').getByText('Retained survey',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Move Observation up',exact:true}).click();
 await page.locator('.gis-save-command').click();
 await page.waitForFunction(()=>localStorage.getItem('cesium-project'));
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('cesium-project')));
 assert.equal(saved.extensions.opengeoRenderer.id,'cesium');assert.equal(saved.extensions.fixture.note,'retained');
 assert.equal(saved.layers.find(layer=>layer.layerId==='survey').styleReference.versionNumber,3);
 assert.equal(saved.layers.find(layer=>layer.layerId==='point').visible,true);
 assert.equal(saved.layerTree[0].children[0].layerId,'point');assert.ok(saved.basemaps.length);
 assert.ok(!JSON.stringify(saved).includes('accessToken'));
 await page.locator('.gis-toolstrip').getByRole('button',{name:'Rendering engine',exact:true}).click();
 const nativeWorkers=page.workers().filter(worker=>worker.url().includes(CESIUM_RUNTIME.basePath));
 assert.ok(nativeWorkers.length>0,'The native worker teardown assertion must not be vacuous');
 const closed=Promise.all(nativeWorkers.map(worker=>worker.waitForEvent('close',{timeout:10000})));
 await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
 await panel.getByText('Current: MapLibre',{exact:true}).waitFor();await closed;
 assert.equal(await page.locator('iframe[title="Cesium map"]').count(),0);
 await page.waitForFunction(()=>view.__opengeoMap.queryRenderedFeatures({layers:['survey-style-0']}).length>0);
 const nativeRequests=()=>requests.filter(path=>path.startsWith(CESIUM_RUNTIME.basePath)).length;
 const beforeRestore=nativeRequests();
 await page.evaluate(()=>{window.holdStyle=true;window.releaseStyle=null;window.reopen();});
 await page.waitForFunction(()=>typeof window.releaseStyle==='function' && window.view?.__opengeoMap?.loaded());
 assert.equal(await page.locator('iframe[title="Cesium map"]').count(),0);
 assert.equal(nativeRequests(),beforeRestore,'Restoration waits for its pinned Style without SDK requests');
 await page.evaluate(()=>window.releaseStyle());
 await page.waitForFunction(()=>view.dataset.renderer==='cesium');
 assert.equal(await page.locator('iframe[title="Cesium map"]').count(),1);
 assert.equal(await page.evaluate(()=>view.__opengeoLayers[0].layerId),'point');
 await page.waitForFunction(()=>view.__opengeoMap.scene.pick(view.__opengeoMap.scene.project([2,2]))?.layerId==='point');
 // Failure is one bounded automatic attempt, with a usable GL fallback.
 failHost=true;
 await page.evaluate(()=>window.reopen());
 await page.locator('.gis-statusbar').getByText(/The renderer could not open/).first().waitFor();
 assert.equal(await page.evaluate(()=>view.dataset.renderer),'maplibre');
 assert.equal(await page.locator('iframe[title="Cesium map"]').count(),0);
 const afterFailure=nativeRequests();
 await page.evaluate(async()=>{for(let i=0;i<3;i++)view.dispatchEvent(new Event('workbench:render'));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 assert.equal(nativeRequests(),afterFailure,'Rendering again must not retry restoration');
 failHost=false;
 // User selection while the Style loads wins over the saved preference.
 await page.evaluate(()=>{window.holdStyle=true;window.releaseStyle=null;window.reopen();});
 await page.waitForFunction(()=>typeof window.releaseStyle==='function' && window.view?.__opengeoMap?.loaded());
 await page.locator('.gis-menu-wrap[data-menu=view] > button').click();await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
 await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
 await page.evaluate(()=>window.releaseStyle());
 await page.waitForFunction(()=>window.view?.__opengeoMap?.getLayer?.('survey-style-0') && view.__opengeoMap.loaded());
 assert.equal(nativeRequests(),afterFailure,'An explicit engine choice prevents a late restore');
 // Incompatible hidden content stays intact and prevents optional SDK loading.
 await page.evaluate(()=>{const saved=JSON.parse(localStorage.getItem('cesium-project'));saved.layers.find(layer=>layer.layerId==='point').labels={enabled:true,field:'name'};localStorage.setItem('cesium-project',JSON.stringify(saved));window.reopen();});
 await page.locator('.gis-statusbar').getByText(/saved Cesium view cannot display/).first().waitFor();
 assert.equal(nativeRequests(),afterFailure);
 assert.equal(await page.evaluate(()=>view.__opengeoLayers.find(layer=>layer.layerId==='point').labels.enabled),true);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cesium-project')).extensions.opengeoRenderer.id),'cesium');
 // A browser draft can carry a newer engine choice than the account record.
 await page.evaluate(()=>{const saved=JSON.parse(localStorage.getItem('cesium-project'));saved.layers.find(layer=>layer.layerId==='point').labels={enabled:false};localStorage.setItem('cesium-project',JSON.stringify(saved));window.reopen();});
 await page.waitForFunction(()=>view.dataset.renderer==='cesium');
 assert.equal(await page.evaluate(()=>view.saveDraftForNavigation()),true);
 await page.evaluate(()=>{const saved=JSON.parse(localStorage.getItem('cesium-project'));saved.extensions.opengeoRenderer={id:'maplibre'};localStorage.setItem('cesium-project',JSON.stringify(saved));window.restoreDrafts=true;window.reopen();});
 await page.waitForFunction(()=>view.dataset.renderer==='cesium');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cesium-project')).extensions.opengeoRenderer.id),'maplibre','Browser restoration does not write the account record');
 // Account navigation while dependencies are pending prevents a late activation.
 const beforeAccountChange=nativeRequests();
 await page.evaluate(()=>{window.holdStyle=true;window.releaseStyle=null;window.reopen();});
 // Navigation cancels restoration during loading; full map idleness is not a
 // prerequisite for leaving the account while the Style request is held.
 await page.waitForFunction(()=>typeof window.releaseStyle==='function' && window.view?.__opengeoMap?.isStyleLoaded());
 await page.evaluate(()=>{window.dispatchEvent(new Event('opengeo:account-navigation'));window.releaseStyle();});
 await page.waitForFunction(()=>view.__opengeoMap?.getLayer?.('survey-style-0') && view.__opengeoMap.loaded());
 assert.equal(nativeRequests(),beforeAccountChange);
 assert.equal(await page.evaluate(()=>view.dataset.renderer),'maplibre');
 }
 // Existing raster source survives native activation, controls and Project save.
 await page.evaluate(()=>{
   const saved=JSON.parse(localStorage.getItem('cesium-project')??'null')??window.fixtureProject;saved.extensions.opengeoRenderer={id:'maplibre'};
   saved.basemaps=[{basemapId:'nasa-blue-marble-relief',kind:'raster',title:'Blue Marble relief',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',attribution:'NASA GIBS',visible:true,opacity:1}];
   localStorage.setItem('cesium-project',JSON.stringify(saved));window.restoreDrafts=false;window.holdStyle=false;window.reopen();
 });
 await page.waitForFunction(()=>view.__opengeoMap?.loaded() && view.__opengeoMap.getLayer('basemap') && view.__opengeoMap.getLayer('survey-style-0'));
 await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
 await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
 if(await panel.getByLabel('Use a plain globe in Cesium.',{exact:false}).isVisible())console.error(JSON.stringify({stage:'raster-mapping',panel:await panel.innerText(),style:await page.evaluate(()=>{const s=view.__opengeoMap.getStyle();return {source:s.sources.basemap,part:s.layers.find(p=>p.id==='basemap')};})}));
 assert.equal(await panel.getByLabel('Use a plain globe in Cesium.',{exact:false}).isVisible(),false);
 await panel.getByRole('button',{name:'Use Cesium',exact:true}).click();
 await page.waitForFunction(()=>view.dataset.renderer==='cesium');
 const raster=await page.evaluate(()=>{
   const frame=view.querySelector('iframe'),canvas=frame.contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4);
   gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let blue=0;
   for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>pixels[i]+60 && pixels[i+2]>pixels[i+1]+60)blue++;
   return {blue,credits:frame.contentDocument.body.textContent,basemap:view.__opengeoMap.basemap};
 });
 assert.ok(raster.blue>1000,'Native background must render visible fixture pixels');assert.match(raster.credits,/NASA GIBS/);
 assert.equal(raster.basemap.basemapId,'nasa-blue-marble-relief');
 await page.getByLabel('Background opacity',{exact:true}).fill('0');
 await page.getByLabel('Background opacity',{exact:true}).dispatchEvent('input');
 assert.equal(await page.getByRole('checkbox',{name:'Background · Blue Marble relief',exact:true}).isChecked(),false);
 await page.waitForFunction(limit=>{
   const canvas=view.querySelector('iframe').contentDocument.querySelector('canvas'),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4);
   gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let blue=0;
   for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>pixels[i]+60 && pixels[i+2]>pixels[i+1]+60)blue++;
   return blue<limit;
 },raster.blue/2);
 await page.getByLabel('Background opacity',{exact:true}).fill('0.4');
 await page.getByLabel('Background opacity',{exact:true}).dispatchEvent('input');
 await page.locator('.gis-save-command').click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('cesium-project')).basemaps[0].opacity===.4);
 await page.locator('.gis-toolstrip').getByRole('button',{name:'Rendering engine',exact:true}).click();
 await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
 try{await page.waitForFunction(()=>view.dataset.renderer==='maplibre' && view.__opengeoMap.loaded());}
 catch(error){console.error(JSON.stringify({stage:'raster-return',panel:await panel.innerText(),state:await page.evaluate(()=>({renderer:view.dataset.renderer,loaded:view.__opengeoMap.loaded?.(),opacity:view.__opengeoMap.getStyle().layers.find(p=>p.id==='basemap')?.paint})),imageryFixtures:imageryRequests.length}));throw error;}
 assert.equal(await page.evaluate(()=>view.__opengeoMap.getPaintProperty('basemap','raster-opacity')),.4);
 await page.locator('.gis-save-command').click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('cesium-project')).extensions.opengeoRenderer.id==='maplibre');
 await page.evaluate(()=>window.reopen());
 await page.waitForFunction(()=>view.__opengeoMap?.loaded() && view.__opengeoMap.getLayer('survey-style-0') && view.__opengeoMap.getLayer('basemap'));
 assert.equal(await page.evaluate(()=>view.__opengeoMap.getPaintProperty('basemap','raster-opacity')),.4,'Saved basemap opacity survives reopening');
 await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
 await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
 // Native imagery failure must retain the current usable GL renderer.
 failImagery=true;await panel.getByRole('button',{name:'Use Cesium',exact:true}).click();
 await panel.getByText('The renderer could not open.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>view.dataset.renderer),'maplibre');
 assert.equal(await page.locator('iframe[data-opengeo-cesium-frame]').count(),0);
 assert.ok(imageryRequests.some(request=>request.native));
 for(const {path} of imageryRequests)assert.match(path,/GoogleMapsCompatible_Level8\/[1-8]\/\d+\/\d+\.jpeg$/);
 assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
 console.log(JSON.stringify({status:'pass',builtModules:built,treeDigest:built?manifest.artifactTree.digest:null,...(imageryOnly?{}:{nativeWorkbenchSwitch:true,originalDisposed:true,layerAndStyleIdentity:true,hiddenLayerShow:true,picking:true,visibility:true,folderOrder:true,saveAndReopenPreference:true,automaticRestore:true,waitsForPinnedStyle:true,boundedFailureFallback:true,explicitChoiceWins:true,incompatibleContentPreserved:true,browserDraftPreference:true,accountChangeCancelsRestore:true,returnToMapLibre:true,workerTermination:true,failedSwitchPreservesMap:true}),imageryOnly,rasterBackground:true,rasterBluePixels:raster.blue,rasterAttribution:true,rasterOpacitySave:true,rasterFailureFallback:true,imageryFixtures:imageryRequests.length,externalRequests:0,providerFixtures,localRequests:requests.length,limits:'Local API save and imagery fixtures; no live identity, production hosting, complex Styles or full renderer parity claim.'}));
}
} finally {if(browser)await browser.close();await rm(out,{recursive:true,force:true});}
