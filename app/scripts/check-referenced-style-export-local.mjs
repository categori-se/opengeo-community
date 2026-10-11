import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {resolveLayerStyle,referencedStylePaint} from '../src/lib/layerStyleReference.js';
import {inspectStaticMapLayers,staticMapDocument} from '../src/lib/staticMapExport.js';
import {verifyPortableMapArtifact} from '../src/lib/portableMapArtifact.js';
const id='d0000000-0000-4000-8000-000000000002';
const definition=JSON.stringify({version:8,sources:{},layers:[{id:'fill',type:'fill',paint:{'fill-color':'#123456','fill-outline-color':'#654321','fill-opacity':.5}}]});
const checksumSha256=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition))).toString('hex');
const reference={projectId:id,resourceId:id,styleId:id,versionNumber:1,checksumSha256,format:'maplibre'};
const layer={layerId:'area',datasetId:id,title:'Study area',geometryType:'Polygon',opacity:1,visible:true,styleReference:reference};
const resolved=await resolveLayerStyle({getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async()=>({id,resourceId:id,versionNumber:1,checksumSha256,format:'maplibre',definition})},layer);
const layers=[layer,{layerId:'sites',title:'Sites',visible:true,filter:['==',['get','status'],'reviewed']}];
const style={sources:{area:{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[-.03,-.03],[.03,-.03],[.03,.03],[-.03,.03],[-.03,-.03]]]}}},sites:{type:'geojson',data:{type:'FeatureCollection',features:[{type:'Feature',properties:{status:'reviewed'},geometry:{type:'Point',coordinates:[0,0]}},{type:'Feature',properties:{status:'hidden'},geometry:{type:'Point',coordinates:[.01,.01]}}]}}},layers:[...referencedStylePaint(resolved,layer).map(p=>({...p,source:'area'})),{id:'sites',source:'sites',type:'circle',filter:['==',['get','status'],'reviewed'],paint:{'circle-color':'#ff0000','circle-radius':8}}]};
const handles=new Map([['area',{sourceId:'area',layerIds:['area-style-0'],boundStyle:resolved}],['sites',{sourceId:'sites',layerIds:['sites']}]]);
const runtime={};for(const [key,path] of [['runtimeJs','dist/maplibre-gl.js'],['runtimeCss','dist/maplibre-gl.css'],['runtimeLicense','LICENSE.txt']])runtime[key]=await readFile(new URL('../node_modules/maplibre-gl/'+path,import.meta.url),'utf8');
const html=staticMapDocument({...runtime,title:'Style export',view:{center:[0,0],zoom:12},selectedIds:['area','sites'],candidates:inspectStaticMapLayers({style,layers,handles})});
const bundled=await build({entryPoints:['src/components/StaticMapExport.js'],bundle:true,format:'esm',write:false});
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const external=[],errors=[];const origin='https://style-export.invalid';
try{
 const context=await browser.newContext({viewport:{width:1100,height:800}});
 await context.addInitScript(()=>Object.defineProperty(window,'maplibregl',{configurable:true,get(){return this.__runtime;},set(value){const M=value.Map;value.Map=new Proxy(M,{construct(target,args){const map=Reflect.construct(target,args);window.observedMap=map;return map;}});this.__runtime=value;}}));
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}
  const assets={'/':html,'/export.js':bundled.outputFiles[0].text,'/export-runtime/maplibre-gl.js':runtime.runtimeJs,'/export-runtime/maplibre-gl.css':runtime.runtimeCss,'/export-runtime/LICENSE.txt':runtime.runtimeLicense};
  if(!(url.pathname in assets))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html',body:assets[url.pathname]});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.getByRole('status').filter({hasText:'Offline edition'}).waitFor();
 // The standalone artifact's CSP deliberately disallows imports. Use the same
 // locally served HTML without that policy only for this authoring-dialog harness.
 await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'')}));
 await page.goto(origin);await page.getByRole('status').filter({hasText:'Offline edition'}).waitFor();
 await page.evaluate(async({layers,handles})=>{
  const {openStaticMapExport}=await import('/export.js');
  window.exportHandles=new Map(handles);window.openDialog=()=>openStaticMapExport({map:window.observedMap,layers,handles:window.exportHandles,title:'Styled survey',download:html=>window.exportedHtml=html,downloadManifest:manifest=>window.exportedManifest=manifest});window.openDialog();
 },{layers,handles:[...handles]});
 const dialog=page.getByRole('dialog');await dialog.getByText(/Pinned Style · version 1/).waitFor();
 await dialog.getByRole('checkbox',{name:/I have reviewed/}).check();await dialog.getByRole('button',{name:'Download HTML',exact:true}).click();
 await dialog.getByRole('button',{name:'Download last export manifest'}).click();
 const output=await page.evaluate(()=>({html:window.exportedHtml,manifest:window.exportedManifest}));
 await verifyPortableMapArtifact(new Blob([output.html]),output.manifest);
 assert.deepEqual(output.manifest.styleDependencies[0].reference,reference);assert.equal(output.manifest.dependencies.length,2);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{window.observedMap.setPaintProperty('area-style-0','fill-color','#ffffff');window.openDialog();});
 await dialog.getByText(/Displayed styling differs/).waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:/Study area/}).isDisabled(),true);
 assert.equal(await dialog.getByRole('checkbox',{name:/Sites/}).isEnabled(),true);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.setContent('<iframe sandbox="allow-scripts" title="Retained map" style="width:100%;height:700px;border:0"></iframe>');
 await page.locator('iframe').evaluate((frame,html)=>frame.srcdoc=html,output.html);
 await page.frameLocator('iframe').getByRole('status').filter({hasText:'Offline edition'}).waitFor();
 const frame=page.frames().find(f=>f.parentFrame());
 assert.equal(await frame.evaluate(()=>window.observedMap.getPaintProperty('area-style-0','fill-color')),'#123456');
 await frame.waitForFunction(()=>window.observedMap.queryRenderedFeatures({layers:['sites']}).some(f=>f.properties.status==='reviewed'));
 assert.equal(await frame.evaluate(()=>window.observedMap.queryRenderedFeatures({layers:['sites']}).some(f=>f.properties.status==='hidden')),false);
 assert.equal(await frame.evaluate(()=>window.observedMap.getStyle().sources.sites.data.features.length),2);
 assert.deepEqual(await frame.evaluate(()=>window.observedMap.getFilter('sites')),['==',['get','status'],'reviewed']);
 await page.frameLocator('iframe').getByRole('checkbox',{name:'Study area'}).uncheck();
 assert.equal(await frame.evaluate(()=>window.observedMap.getLayoutProperty('area-style-0','visibility')),'none');
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 await mkdir('../.local-archives/referenced-style-filter-export-20260924',{recursive:true});
 const receipt={status:'passed',actualDialog:true,realMapLibre:true,twoLayers:true,pinnedStyleReference:reference,mismatchRefused:true,otherLayerStillExportable:true,retainedStyleRendered:true,filterRenderedInArtifact:true,hiddenFeatureRetainedInData:true,externalRequests:0,scope:'Local component bundle, synthetic Style storage; authoring harness omits standalone CSP, exported iframe retains it; no database/deployment/full routed Studio'};
 await writeFile('../.local-archives/referenced-style-filter-export-20260924/receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await browser.close();}
