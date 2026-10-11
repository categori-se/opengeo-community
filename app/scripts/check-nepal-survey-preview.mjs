// Built Workbench + three complete Nepal survey previews. No AWS/provider requests.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const out=resolve('../.local-archives/nepal-srilanka-catalog-20260921/nepal-survey'),dist=resolve('dist');
const selection=['roads','municipalities','municipal-headquarters'];
const registration=JSON.parse(await readFile(resolve(out,'registration.json'))),inspection=JSON.parse(await readFile(resolve(out,'inspection/inspection.json')));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://hot-preview.invalid';
const fixtures=await Promise.all(selection.map(layer=>registration.records.find(r=>r.layer===layer)).map(async(r,i)=>({r,inspection:inspection.records.find(x=>x.layer===r.layer).inspection,data:JSON.parse(await readFile(resolve(out,'inspection',r.layer,'preview.geojson')))})));
const layers=fixtures.map(({r,inspection},i)=>({layerId:`survey-${i}`,datasetId:r.datasetId,datasetVersionId:r.datasetVersionId,sourceType:'governed-dataset',sourceVersion:1,title:`Nepal ${selection[i]}`,geometryType:inspection.geometry_type,bbox:inspection.extent,visible:false,opacity:1,order:i,style:i===2?{circleColor:'#f97316',circleRadius:5}:i===0?{stroke:'#f97316',strokeWidth:2}:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}}));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let requests=0;const errors=[];
try{
 const context=await browser.newContext({viewport:{width:1200,height:850},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){requests++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
  import {WorkbenchView} from '/_import/components/${module}';
  const layers=${JSON.stringify(layers)},fixtures=${JSON.stringify(fixtures).replaceAll('<','\\u003c')};window.reads=0;
  window.shell=WorkbenchView({workspace:{workspaceId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',title:'Nepal survey preview'},project:{layers,mapViews:[{id:'default',title:'Default',center:[84.1,28.2],zoom:6}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:layers[0].layerId},layers,role:'owner',persistenceMode:'api',loadDatasetVersionPreview:async(id,version)=>{reads++;const item=fixtures.find(x=>x.r.datasetId===id);if(item.r.datasetVersionId!==version)throw Error('Version mismatch');return {datasetVersionId:version,mayBeTruncated:false,geojson:item.data};}});document.body.append(shell);
  </script>`});
  const path=url.pathname==='/style.css'?resolve('src/style.css'):url.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+url.pathname);
  try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(await page.evaluate(()=>reads),0);
 const results=[];
 for(let i=0;i<selection.length;i++){
  const box=page.getByLabel(`Show Nepal ${selection[i]}`,{exact:true});await box.check();
  await page.waitForFunction(i=>window.shell.__opengeoData.has(`survey-${i}`),i);
  assert.equal(await page.evaluate(i=>shell.__opengeoData.get(`survey-${i}`).features.length,i),fixtures[i].inspection.feature_count);
  await page.waitForFunction(i=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source===`survey-${i}-source`).map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},i);
  await box.uncheck();await box.check();assert.equal(await page.evaluate(()=>reads),i+1);
  await page.waitForFunction(i=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source===`survey-${i}-source`).map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},i);
  results.push({datasetId:fixtures[i].r.datasetId,features:fixtures[i].inspection.feature_count,rendered:true});
 }
 assert.deepEqual(errors,[]);assert.equal(requests,0);
 await page.screenshot({path:resolve(out,'preview-browser.png')});
 await writeFile(resolve(out,'preview-browser.json'),JSON.stringify({status:'passed',scope:'Built Workbench with actual archived GeoJSON; intercepted preview transport, not signed-in hosted acceptance',hiddenMapReads:0,readsAfterToggle:selection.length,repeatVisibilityReads:0,externalRequests:requests,results},null,2));
 console.log(JSON.stringify({status:'passed',results}));
}finally{await browser.close();}
