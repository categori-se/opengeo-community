// Real PMTiles range reads and built Workbench rendering, entirely local transport.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const root=resolve('..'),out=resolve(root,'.local-archives/bhutan-local-20260920/transmission-tiles-v2');
const receiptPath=resolve(out,'browser-check.json');assert.ok(!existsSync(receiptPath),'Inspect prior receipt before repeating');
const bytes=await readFile(resolve(out,'transmission.pmtiles')),review=JSON.parse(await readFile(resolve(out,'content-verification.json')));
assert.equal(review.status,'passed');assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const marker=JSON.parse((await readFile(resolve(out,'zero-length-markers.geojsonl'),'utf8')).split('\n')[0]);
const dist=resolve('dist'),module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://transmission-review.invalid',archive=origin+'/transmission.pmtiles';
const receipt={status:'running',requests:0,rangeBytes:0,maximumResponseBytes:0,externalRequests:0,errors:[],outputSha256:review.outputSha256};
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin){receipt.externalRequests++;return route.abort();}
  if(u.pathname==='/transmission.pmtiles'){
   const range=route.request().headers().range;assert.match(range,/^bytes=\d+-\d+$/);
   const [low,high]=range.slice(6).split('-').map(Number);assert.ok(low>=0&&high>=low&&high<bytes.length);
   const body=bytes.subarray(low,high+1);receipt.requests++;receipt.rangeBytes+=body.length;
   receipt.maximumResponseBytes=Math.max(receipt.maximumResponseBytes,body.length);
   assert.ok(receipt.requests<=100&&receipt.rangeBytes<=32*1024**2&&body.length<=8*1024**2);
   return route.fulfill({status:206,body,headers:{'content-type':'application/octet-stream','content-range':`bytes ${low}-${high}/${bytes.length}`,'accept-ranges':'bytes','etag':`"${review.outputSha256}"`}});
  }
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><button id="open">Open reviewed archive</button><script type="module">
  import {WorkbenchView} from '/_import/components/${module}';
  document.querySelector('#open').onclick=()=>{const layers=[['lines','transmission','MultiLineString'],['markers','transmission_zero_length','Point']].map(([id,sourceLayer,geometryType],order)=>({layerId:id,title:sourceLayer,datasetId:'499a9aae-6a21-4ed2-a8b9-f29b435ea6fa',sourceType:'pmtiles-vector',sourceUrl:${JSON.stringify(archive)},sourceLayer,geometryType,visible:true,opacity:1,order,style:{stroke:'#39a6ff',strokeWidth:2,circleColor:'#ffb300',circleRadius:6},labels:{enabled:false}}));
  window.shell=WorkbenchView({workspace:{workspaceId:'f340b616-691b-4770-b22e-03a6913f96f1',title:'Transmission archive review'},project:{schemaVersion:'opengeo.map-definition.1.3.0',layers,mapViews:[{id:'default',title:'Default',center:[90.45,27.5],zoom:7}],basemaps:[{basemapId:'blank',kind:'blank',title:'Blank',visible:true}],bookmarks:[],activeLayerId:'lines'},layers,role:'owner',persistenceMode:'browser'});document.body.replaceChildren(shell);};</script>`});
  try{const p=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);return route.fulfill({contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(p)});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>receipt.errors.push(e.message));await page.goto(origin);
 assert.equal(receipt.requests,0);await page.getByRole('button',{name:'Open reviewed archive'}).click();
 await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());
 await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='lines-source').map(l=>l.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;});
 receipt.overviewLinesRendered=true;await page.screenshot({path:resolve(out,'overview.png')});
 await page.evaluate(center=>shell.__opengeoMap.jumpTo({center,zoom:14}),marker.geometry.coordinates.slice(0,2));
 await page.waitForFunction(id=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(l=>l.source==='markers-source').map(l=>l.id);return m.queryRenderedFeatures({layers:ids}).some(f=>f.properties.OBJECTID_1===id);},marker.properties.OBJECTID_1);
 receipt.zeroLengthMarkerRendered=true;receipt.renderer=await page.evaluate(()=>({webgl:!!shell.__opengeoMap.painter?.context?.gl,canvasCount:shell.querySelectorAll('canvas').length}));
 await page.screenshot({path:resolve(out,'zero-length-marker.png')});assert.deepEqual(receipt.errors,[]);assert.equal(receipt.externalRequests,0);
 receipt.status='passed';receipt.scope='Actual tiled artifact in built Workbench through local byte-range transport; not signed-in S3 or manual archive selector acceptance.';
}catch(error){receipt.status='failed';receipt.error=String(error);throw error;}
finally{await browser.close();await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
