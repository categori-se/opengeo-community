// Actual preserved bytes, actual built Workbench, intercepted transport; no AWS.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'fflate';
import {chromium} from 'playwright';
const root=resolve('..'),work=resolve(root,'.local-archives/bhutan-local-20260920');
const read=async name=>JSON.parse(await readFile(resolve(work,name)));
const override=process.argv[2]?JSON.parse(await readFile(resolve(process.argv[2]))):null;
const plan=override?.plan??await read('archive-admission-plan.json');
const revisions=new Map((override?.sources??(await read('archive-source-revision-check.json')).accounts[0].sources).map(x=>[x.datasetId,x]));
const paths=new Map((override?.objects??[]).map(x=>[x.sha256,resolve(work,x.path)]));
if(!override){
for(const row of (await read('transfer-supplements/supplement-restoration-manifest.json')).records)paths.set(row.sha256,resolve(work,row.path));
for(const row of (await read('icimod-historical-reconciliation.json')).results)if(row.status==='historical-capture-locally-reverified')paths.set(row.sha256,resolve(root,row.path));
}
const dist=override?.dist?resolve(root,override.dist):resolve('dist'),origin='https://bhutan-render.invalid';
assert.ok(dist.startsWith(root+'/'));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>x.startsWith('WorkbenchView.')&&x.endsWith('.js'));
const out=resolve(work,override?.outputDirectory??'render-review');assert.ok(out.startsWith(work+'/'));if(override)assert.ok(!existsSync(resolve(out,'receipt.json')),'Inspect retained review');await mkdir(out,{recursive:true});
const receipt={status:'running',scope:'Preserved local bytes in built Workbench; intercepted source/storage/API callbacks, no production fallback or current-provider equality claim.',results:[],externalRequests:0};
receipt.workbenchModule={path:module,sha256:createHash('sha256').update(await readFile(resolve(dist,'_import/components',module))).digest('hex')};
const save=()=>writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 for(const proposal of plan.records){
  const started=Date.now(),source=revisions.get(proposal.dataset_id),features=[],bodies=new Map();
  const bounds=[Infinity,Infinity,-Infinity,-Infinity];let located=0;
  const positions=value=>{if(!Array.isArray(value)||!value.length)return;
   if(typeof value[0]==='number'){bounds[0]=Math.min(bounds[0],value[0]);bounds[1]=Math.min(bounds[1],value[1]);bounds[2]=Math.max(bounds[2],value[0]);bounds[3]=Math.max(bounds[3],value[1]);return;}
   for(const child of value)positions(child);};
  for(const obj of proposal.descriptor.objects){
   const bytes=await readFile(paths.get(obj.sha256));
   assert.equal(createHash('sha256').update(bytes).digest('hex'),obj.sha256);
   bodies.set(`/${obj.bucket}/${obj.key}`,bytes);
   const collection=JSON.parse(new TextDecoder().decode(obj.encoding==='gzip'?gunzipSync(bytes):bytes));
   for(const feature of collection.features){features.push(feature);if(feature.geometry?.coordinates?.length){located++;positions(feature.geometry.coordinates);}}
  }
  const expectedHash=createHash('sha256').update(JSON.stringify(features)).digest('hex');
  const record={...proposal,...proposal.descriptor,source_url:source.sourceUrl,
   download_bytes:proposal.descriptor.objects.reduce((s,o)=>s+o.size_bytes,0),
   decoded_bytes:proposal.descriptor.objects.reduce((s,o)=>s+o.decoded_size_bytes,0),feature_count:features.length,
   objects:proposal.descriptor.objects.map(obj=>({...obj,ticket:{method:'GET',url:`https://s3.us-east-1.amazonaws.com/${obj.bucket}/${obj.key}?versionId=${encodeURIComponent(obj.version_id)}&X-Amz-Signature=offline`,headers:{'x-amz-expected-bucket-owner':obj.expected_owner}}}))};
  const context=await browser.newContext({viewport:{width:1200,height:850},serviceWorkers:'block'});
  let gets=0,live=0;const errors=[],blocked=[];
  try{
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin===new URL(source.sourceUrl).origin&&!bodies.has(decodeURIComponent(u.pathname))){
     live++;
     if(override?.primaryArchive){const bytes=bodies.values().next().value;gets++;return route.fulfill({status:200,body:bytes,headers:{'access-control-allow-origin':'*','content-type':'application/geo+json','content-length':String(bytes.length)}});}
     return route.fulfill({status:503,body:'{}',headers:{'access-control-allow-origin':'*'}});
    }
    if(u.origin==='https://s3.us-east-1.amazonaws.com'){
     if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET','access-control-allow-headers':'x-amz-expected-bucket-owner'}});
     const bytes=bodies.get(decodeURIComponent(u.pathname));assert.ok(bytes);gets++;
     return route.fulfill({status:200,body:bytes,headers:{'access-control-allow-origin':'*'}});
    }
    if(u.origin!==origin){blocked.push(u.origin);return route.abort();}
    if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
     import {WorkbenchView} from '/_import/components/${module}';
     const record=${JSON.stringify(record).replaceAll('<','\\u003c')},source=${JSON.stringify(source)};
     const layer={sourceType:'external-feature-reference',sourceVersion:record.source_version,sourceUrl:source.sourceUrl,geometryType:source.geometryType,sourceConfiguration:{objectIdField:source.objectIdField,fields:[source.objectIdField],geometryType:source.geometryType,pageSize:100,attribution:record.attribution},...source.layer,layerId:'fixture',datasetId:record.dataset_id,title:'Archive under review',visible:false,opacity:1,order:0,style:{},labels:{enabled:false}};
     const project={schemaVersion:'opengeo.map-definition.1.3.0',layers:[layer],mapViews:[{id:'default',title:'Default',center:[90,27],zoom:6}],basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:'fixture'};
     window.shell=WorkbenchView({workspace:{workspaceId:record.project_id,title:'Archive review'},project,layers:[layer],role:'owner',persistenceMode:'api',layerArchiveAccess:{assertScope:async()=>{},authorize:async()=>{},list:async()=>({dataset_id:record.dataset_id,source_version:record.source_version,archives:[record]}),read:async()=>record}});document.body.append(shell);
    </script>`});
    try{const path=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(path)});}catch{blocked.push(u.pathname);return route.abort();}
   });
   const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin);await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());assert.equal(gets,0);assert.equal(live,0);
   const primaryResponse=source.layer?.sourceType==='geojson-archive'?page.waitForResponse(r=>r.url()===source.sourceUrl&&r.status()===(override?.primaryArchive?200:503)):null;
   await page.getByLabel('Show Archive under review',{exact:true}).check();
   if(primaryResponse)await primaryResponse;
   else await page.waitForFunction(()=>document.body.textContent.includes('live view unavailable'));
   if(override?.primaryArchive){
    await page.waitForFunction(()=>window.shell.__opengeoData.get('fixture')?.features?.length>0||document.body.textContent.includes('did not pass verification'));
    assert.ok(await page.evaluate(()=>window.shell.__opengeoData.get('fixture')?.features?.length>0),await page.locator('body').innerText());
   }else{
   assert.equal(gets,0);
   await page.locator('[data-layer-id="fixture"] .gis-layer-more > summary').click();
   await page.getByText('Live / archived copy',{exact:true}).click();
   await page.getByRole('button',{name:'Review available archives',exact:true}).click();
   await page.getByText(/download bytes/).waitFor();assert.equal(gets,0);
   await page.getByLabel(/Download the selected copy from S3/).check();
   await page.getByRole('button',{name:'Use selected archived copy',exact:true}).click();
   await page.getByRole('dialog').getByText(new RegExp(`${features.length.toLocaleString()} verified features`)).waitFor({timeout:180000});
   }
   assert.equal(gets,record.objects.length);
   const facts=await page.evaluate(async()=>{const data=shell.__opengeoData.get('fixture');const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data.features))));return {count:data.features.length,hash:[...digest].map(x=>x.toString(16).padStart(2,'0')).join(''),unlocated:data.opengeo.unlocatedFeatureCount};});
   assert.equal(facts.count,features.length);assert.equal(facts.hash,expectedHash);assert.equal(facts.unlocated??0,features.length-located);
   if(!override?.primaryArchive)await page.getByRole('button',{name:'Close archive selection',exact:true}).click();
   if(located){
    await page.evaluate(b=>shell.__opengeoMap.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:60,maxZoom:12,duration:0}),override?.viewBounds??bounds);
    await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source==='fixture-source').map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;});
   }
   const views=[];
   for(const view of override?.views??[]){
    await page.evaluate(view=>shell.__opengeoMap.jumpTo(view),view);
    await page.waitForFunction(()=>{const m=shell.__opengeoMap,ids=m.getStyle().layers.filter(x=>x.source==='fixture-source').map(x=>x.id);return ids.length&&m.queryRenderedFeatures({layers:ids}).length>0;});
    views.push({...view,rendered:true});
   }
   if(override)await page.screenshot({path:resolve(out,proposal.dataset_id+'.png')});
   assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
   receipt.results.push({datasetId:proposal.dataset_id,archiveId:proposal.id,sourceUrl:source.sourceUrl,activation:override?.primaryArchive?'explicit-enable-archive-layer':'explicit-private-archive-selection',status:'passed',featureCount:features.length,unlocatedFeatureCount:facts.unlocated??0,rendered:located>0,emptyCapture:features.length===0,allFeatureContentHash:expectedHash,views,objectsRead:gets,elapsedMs:Date.now()-started});
   console.log(JSON.stringify({completed:receipt.results.length,featureCount:features.length,status:'passed'}));
  }catch(error){receipt.results.push({datasetId:proposal.dataset_id,archiveId:proposal.id,status:'failed',reason:error.message,elapsedMs:Date.now()-started});await save();throw error;}
  finally{await context.close();}
  await save();
 }
 receipt.status='passed';await save();console.log(JSON.stringify({status:'passed',captures:receipt.results.length,externalRequests:0}));
}finally{await browser?.close();}
