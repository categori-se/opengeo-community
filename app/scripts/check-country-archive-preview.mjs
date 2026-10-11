// Built Workbench + retained real HOT previews. No AWS/provider requests.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const out=resolve('../.local-archives/nepal-srilanka-catalog-20260921'),dist=resolve('dist');
const plan=JSON.parse(await readFile(resolve(out,'catalog-plan.json')));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://hot-preview.invalid';
const fixtures=plan.records.filter(x=>['nepal/Nepal - Koshi Country Boundary, ICIMOD 2022.geojson','sri-lanka/lka_adm0.geojson'].includes(x.object.key));
const layers=fixtures.map((x,i)=>({layerId:`archive-${i}`,datasetId:`00000000-0000-4000-8000-00000000000${i}`,sourceType:'geojson-archive',sourceVersion:1,title:i?'Sri Lanka archive':'Koshi archive',geometryType:x.request.source.geometry_type,bbox:x.request.source.bounds,visible:false,opacity:1,order:i,sourceUrl:x.request.source.url,sourceConfiguration:Object.fromEntries(Object.entries(x.request.source).filter(([k])=>!['type','url'].includes(k)).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v])),style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:2},labels:{enabled:false,field:null}}));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let requests=0,archiveReads=0;const errors=[];
try{
 const context=await browser.newContext({viewport:{width:1200,height:850},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());const fixture=fixtures.find(x=>x.request.source.url===url.href);if(fixture){archiveReads++;return route.fulfill({body:await readFile(resolve('..',fixture.object.localPath)),headers:{'content-type':fixture.object.contentType,'access-control-allow-origin':'*'}});}if(url.origin!==origin){requests++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
  import {WorkbenchView} from '/_import/components/${module}';
  const layers=${JSON.stringify(layers)},fixtures=${JSON.stringify(fixtures).replaceAll('<','\\u003c')};window.reads=0;
  window.shell=WorkbenchView({workspace:{workspaceId:'f340b616-691b-4770-b22e-03a6913f96f1',title:'Country archive preview'},project:{layers,mapViews:[{id:'default',title:'Default',center:[83,18],zoom:4}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:layers[0].layerId},layers,role:'owner',persistenceMode:'api'});document.body.append(shell);
  </script>`});
  const path=url.pathname==='/style.css'?resolve('src/style.css'):url.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+url.pathname);
  try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(archiveReads,0);
 const results=[];
 for(let i=0;i<2;i++){
  const box=page.getByLabel(`Show ${i?'Sri Lanka archive':'Koshi archive'}`,{exact:true});await box.check();
  await page.waitForFunction(i=>window.shell.__opengeoData.has(`archive-${i}`),i);
  assert.equal(await page.evaluate(i=>shell.__opengeoData.get(`archive-${i}`).features.length,i),fixtures[i].featureCount);
  await page.waitForFunction(i=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source===`archive-${i}-source`).map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;},i);
  await box.uncheck();await box.check();assert.equal(archiveReads,i+1);
  results.push({key:fixtures[i].object.key,features:fixtures[i].featureCount,rendered:true});
 }
 assert.deepEqual(errors,[]);assert.equal(requests,0);
 await page.screenshot({path:resolve(out,'preview-browser.png')});
 await writeFile(resolve(out,'preview-browser.json'),JSON.stringify({status:'passed',scope:'Built Workbench with exact retained S3 GeoJSON and original content types; intercepted S3 transport, not signed-in hosted acceptance',hiddenMapReads:0,readsAfterToggle:2,repeatVisibilityReads:0,externalRequests:requests,results},null,2));
 console.log(JSON.stringify({status:'passed',results}));
}finally{await browser.close();}
