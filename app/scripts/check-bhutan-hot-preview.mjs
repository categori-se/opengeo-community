// Built Workbench + retained real HOT previews. No AWS/provider requests.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const out=resolve('../.local-archives/bhutan-existing-s3-20260920/hotosm'),dist=resolve('dist');
const registration=JSON.parse(await readFile(resolve(out,'registration.json'))),inspection=JSON.parse(await readFile(resolve(out,'inspection/inspection.json')));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://hot-preview.invalid';
const fixtures=await Promise.all(registration.records.map(async(r,i)=>({r,inspection:inspection.records[i].inspection,data:JSON.parse(await readFile(resolve(out,'inspection',r.layer,'preview.geojson')))})));
const layers=fixtures.map(({r,inspection},i)=>({layerId:`hot-${i}`,datasetId:r.datasetId,datasetVersionId:r.datasetVersionId,sourceType:'governed-dataset',sourceVersion:1,title:`HOT ${i?'polygons':'points'}`,geometryType:i?'MultiPolygon':'Point',bbox:inspection.extent,visible:false,opacity:1,order:i,style:i?{fill:'#22c55e',stroke:'#15803d',strokeWidth:2}:{circleColor:'#f97316',circleRadius:5},labels:{enabled:false,field:null}}));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let requests=0;const errors=[];
try{
 const context=await browser.newContext({viewport:{width:1200,height:850},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){requests++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
  import {WorkbenchView} from '/_import/components/${module}';
  const layers=${JSON.stringify(layers)},fixtures=${JSON.stringify(fixtures).replaceAll('<','\\u003c')};window.reads=0;
  window.shell=WorkbenchView({workspace:{workspaceId:'f340b616-691b-4770-b22e-03a6913f96f1',title:'HOT preview'},project:{layers,mapViews:[{id:'default',title:'Default',center:[90.4,27.4],zoom:7}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:layers[0].layerId},layers,role:'owner',persistenceMode:'api',loadDatasetVersionPreview:async(id,version)=>{reads++;const item=fixtures.find(x=>x.r.datasetId===id);if(item.r.datasetVersionId!==version)throw Error('Version mismatch');return {datasetVersionId:version,mayBeTruncated:false,geojson:item.data};}});document.body.append(shell);
  </script>`});
  const path=url.pathname==='/style.css'?resolve('src/style.css'):url.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+url.pathname);
  try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(await page.evaluate(()=>reads),0);
 const results=[];
 for(let i=0;i<2;i++){
  const box=page.getByLabel(`Show HOT ${i?'polygons':'points'}`,{exact:true});await box.check();
  await page.waitForFunction(i=>window.shell.__opengeoData.has(`hot-${i}`),i);
  assert.equal(await page.evaluate(i=>shell.__opengeoData.get(`hot-${i}`).features.length,i),fixtures[i].inspection.feature_count);
  await page.waitForFunction(i=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source===`hot-${i}-source`).map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},i);
  await box.uncheck();await box.check();assert.equal(await page.evaluate(()=>reads),i+1);
  results.push({datasetId:fixtures[i].r.datasetId,features:fixtures[i].inspection.feature_count,rendered:true});
 }
 assert.deepEqual(errors,[]);assert.equal(requests,0);
 await page.screenshot({path:resolve(out,'preview-browser.png')});
 await writeFile(resolve(out,'preview-browser.json'),JSON.stringify({status:'passed',scope:'Built Workbench with actual HOT GeoJSON; intercepted preview transport, not signed-in hosted acceptance',hiddenMapReads:0,readsAfterToggle:2,repeatVisibilityReads:0,externalRequests:requests,results},null,2));
 console.log(JSON.stringify({status:'passed',results}));
}finally{await browser.close();}
