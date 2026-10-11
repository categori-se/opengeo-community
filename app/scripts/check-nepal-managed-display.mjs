// Actual preserved land-use bytes through built Studio; transport/auth are local fixtures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const folder=resolve('../.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-large-20260922/gis_osm_landuse_a_free_1-mixed-tiles');
const out=resolve(folder,'managed-selector-review');
assert.ok(!existsSync(out),'Inspect the prior review before starting another');await mkdir(out);
const hash=b=>createHash('sha256').update(b).digest('hex');
const body=await readFile(resolve(folder,'display.pmtiles'));
const review=JSON.parse(await readFile(resolve(folder,'native-review.json')));
const build=JSON.parse(await readFile(resolve(folder,'receipt.json')));
assert.equal(review.status,'passed');assert.equal(hash(body),build.outputSha256);
const fine=JSON.parse(await readFile(resolve(folder,'fine-source-features.json'))).features;
const blocks=Buffer.concat(Array.from({length:Math.ceil(body.length/65536)},(_,i)=>Buffer.from(hash(body.subarray(i*65536,(i+1)*65536)),'hex')));
const ticket=(key,version)=>({method:'GET',url:`https://s3.us-east-1.amazonaws.com/fixture/private/${key}?versionId=${version}&X-Amz-Signature=offline`,headers:{'x-amz-expected-bucket-owner':'123456789012'}});
const record={id:'10000000-0000-4000-8000-000000000001',title:'Nepal land use: complete reviewed tiled display',dataset_id:'b3957e80-b87d-4c77-a669-167495424ea5',dataset_version_id:'7b1ffe09-25a5-4d69-824a-66502d69d25b',captured_at:null,
 format:'pmtiles',download_bytes:body.length,decoded_bytes:body.length,feature_count:179240,attribution:'Geofabrik / OpenStreetMap contributors',rights:{license:'ODbL-1.0'},provenance:{review:'Local verification of exact retained bytes'},min_zoom:7,max_zoom:20,range_block_bytes:65536,range_limits:{requests:256,bytes:64*1024**2,seconds:300,response_bytes:8*1024**2},
 tile_layers:[{source_layer:'data',title:'Land use',geometry_type:'MultiPolygon',feature_count:179232,geometry_method:'Clipped and quantized display; original source geometry retained.'},{source_layer:'fine',title:'Small land-use polygons',geometry_type:'MultiPolygon',feature_count:8,geometry_method:'Fine detail preserves eight polygons smaller than the ordinary tile grid.'}],
 objects:[{bucket:'fixture',prefix:'private/',key:'private/display.pmtiles',version_id:'exact-file',expected_owner:'123456789012',size_bytes:body.length,decoded_size_bytes:body.length,sha256:hash(body),decoded_sha256:hash(body),encoding:'identity',feature_count:179240,ticket:ticket('display.pmtiles','exact-file'),block_index:{key:'private/display.blocks',version_id:'exact-index',size_bytes:blocks.length,sha256:hash(blocks),ticket:ticket('display.blocks','exact-index')}}]};
const origin='https://managed-display.invalid',dist=resolve('dist');
const file=(await readdir(resolve(dist,'_import/components'))).find(n=>n.startsWith('WorkbenchView.')&&n.endsWith('.js'));
assert.ok(file);
const receipt={status:'running',scope:'Real built Workbench and retained PMTiles bytes; intercepted API/storage and synthetic authorization. No cloud calls or deployed acceptance.',outputSha256:hash(body),frontend:[],checks:[],probes:[]};
for(const [dir,prefix] of [['_import/components','WorkbenchView.'],['_import/components','LayerArchiveControl.'],['_import/lib','reviewedArchiveRange.'],['_import/lib','reviewedDisplayIdentity.'],['_import/lib','reviewedArchiveTiles.'],['_import/lib','loadedLayerInstallation.']]){
 const name=(await readdir(resolve(dist,dir))).find(n=>n.startsWith(prefix)&&n.endsWith('.js'));assert.ok(name);
 receipt.frontend.push({path:dir+'/'+name,sha256:hash(await readFile(resolve(dist,dir,name)))});
}
let gets=0,bytes=0,browser;const errors=[],blocked=[];
const started=Date.now();
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({colorScheme:'dark',viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin==='https://s3.us-east-1.amazonaws.com'){
   const common={'access-control-allow-origin':'*','access-control-expose-headers':'Content-Range,x-amz-version-id','access-control-allow-headers':'x-amz-expected-bucket-owner,Range'};
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{...common,'access-control-allow-methods':'GET'}});
   gets++;
   if(u.pathname.endsWith('.blocks')){bytes+=blocks.length;return route.fulfill({status:200,body:blocks,headers:{...common,'x-amz-version-id':'exact-index'}});}
   const [low,high]=route.request().headers().range.slice(6).split('-').map(Number);
   assert.ok(low>=0&&high<body.length&&high-low+1<=8*1024**2);
   bytes+=high-low+1;assert.ok(gets<=256&&bytes<=64*1024**2);
   return route.fulfill({status:206,body:body.subarray(low,high+1),headers:{...common,'content-range':`bytes ${low}-${high}/${body.length}`,'x-amz-version-id':'exact-file'}});
  }
  if(u.origin!==origin){blocked.push(u.href);return route.abort();}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0;height:100%;background:#151515;color:white}.opengeo-workbench{height:100vh}</style><script type="module">
   import {WorkbenchView} from '/_import/components/${file}';
   const record=${JSON.stringify(record)};
   const layer={layerId:'fixture',datasetId:record.dataset_id,datasetVersionId:record.dataset_version_id,title:'Nepal land use',sourceType:'governed-dataset',sourceVersion:1,geometryType:'MultiPolygon',visible:false,opacity:1,order:0,style:{fill:'#22c55e',stroke:'#15803d',strokeWidth:1},labels:{enabled:false}};
   const initial={schemaVersion:'opengeo.map-definition.1.3.0',layers:[layer],mapViews:[{id:'default',title:'Default',center:[84.5,27.7],zoom:7,pitch:0,bearing:0}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:'fixture'};
   const definition=JSON.parse(sessionStorage.getItem('saved')||'null')||initial;
   window.probe={lists:0,reads:0,previews:0,saves:[]};
   window.shell=WorkbenchView({workspace:{workspaceId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',title:'Nepal'},project:definition,layers:definition.layers,role:'owner',mapVersion:1,persistenceMode:'api',
    loadDatasetVersionPreview:async()=>{probe.previews++;throw Error('This large saved version requires reviewed tiles.');},
    layerArchiveAccess:{assertScope:async()=>{},authorize:async()=>{},list:async()=>{probe.lists++;return {dataset_id:record.dataset_id,dataset_version_id:record.dataset_version_id,archives:[record]};},read:async()=>{probe.reads++;return record;}},
    saveProject:async value=>{probe.saves.push(value);sessionStorage.setItem('saved',JSON.stringify(value));return{id:'60000000-0000-4000-8000-000000000088',version:2,definition:value};}});
   document.body.append(shell);
  </script>`});
  const path=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);
  try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'});}catch{blocked.push(u.pathname);return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.waitForFunction(()=>shell?.__opengeoMap?.isStyleLoaded());
 assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.previews),0);receipt.checks.push('all-off open: zero archive, preview and metadata requests');
 await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
 await page.getByRole('button',{name:'Map display',exact:true}).click();
 await page.getByRole('button',{name:'Review tiled displays',exact:true}).click();
 await page.getByText(/stored bytes; only requested tiles/).waitFor();
 assert.equal(gets,0);assert.equal(await page.evaluate(()=>probe.reads),0);
 assert.equal(await page.getByRole('button',{name:'Use selected tiled display',exact:true}).isEnabled(),false);
 receipt.checks.push('listing has zero storage reads and requires explicit cost acknowledgement');
 await page.getByLabel(/Download the selected copy from S3/).check();
 await page.getByRole('button',{name:'Use selected tiled display',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.gis-layer-archive-dialog [role=status]').textContent.includes('179,240 reviewed records'));
 await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
 await page.getByLabel('Show Nepal land use',{exact:true}).check();
 await page.waitForFunction(()=>shell.__opengeoMap.queryRenderedFeatures().some(f=>f.sourceLayer==='data'));
 assert.equal(await page.evaluate(()=>probe.previews),0);receipt.checks.push('explicit tiles render without reading original/preview');
 await page.screenshot({path:resolve(out,'overview.png')});
 for(const feature of fine){
  const ring=feature.geometry.coordinates[0],xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
  const center=[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2];
  await page.evaluate(center=>shell.__opengeoMap.jumpTo({center,zoom:22}),center);
  await page.waitForFunction(id=>shell.__opengeoMap.queryRenderedFeatures().some(f=>f.sourceLayer==='fine'&&f.id===id),feature.id);
  receipt.probes.push({id:feature.id,center,rendered:true});
 }
 receipt.checks.push('all eight tiny polygon identities rendered at fine detail');
 await page.screenshot({path:resolve(out,'fine-detail.png')});
 await page.getByLabel('Show Nepal land use',{exact:true}).uncheck();
 await page.evaluate(()=>shell.__opengeoMap.jumpTo({center:[85.5,28],zoom:13}));
 await page.waitForTimeout(500);const pausedGets=gets;
 await page.evaluate(()=>shell.__opengeoMap.jumpTo({center:[82,29],zoom:11}));await page.waitForTimeout(500);
 assert.equal(gets,pausedGets);receipt.checks.push('hidden tiled layer makes no reads during map movement');
 await page.getByRole('button',{name:'Map display',exact:true}).click();
 await page.getByRole('button',{name:'Return to saved data',exact:true}).click();
 await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
 assert.equal(await page.evaluate(()=>probe.previews),0);
 const stopped=gets;
 await page.evaluate(()=>shell.__opengeoMap.jumpTo({center:[84,28],zoom:8}));await page.waitForTimeout(300);assert.equal(gets,stopped);
 receipt.checks.push('return while hidden disposes tile session without loading saved data');
 await page.reload();await page.waitForFunction(()=>shell?.__opengeoMap?.isStyleLoaded());
 assert.equal(gets,stopped);assert.equal(await page.evaluate(()=>probe.previews+probe.reads+probe.lists),0);
 receipt.checks.push('reopening makes no reads or implicit tiled selection');
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
 receipt.status='passed';
}catch(error){receipt.status='failed';receipt.error=error.stack;throw error;}
finally{receipt.requests=gets;receipt.bytes=bytes;receipt.seconds=(Date.now()-started)/1000;receipt.errors=errors;receipt.blocked=blocked;await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await browser?.close();}
