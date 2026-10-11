// Built metadata cards and live-preview path with retained provider fixtures.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const dist=resolve('app/dist'),out=resolve('.local-archives/bhutan-metadata-20260920/browser');await mkdir(out,{recursive:true});
const plan=JSON.parse(await readFile('.local-archives/bhutan-metadata-20260920/metadata-plan.json'));
const row=plan.records.find(x=>x.sourceUrl.includes('/cadastral_data_Core_Town/'));
const inventory=JSON.parse(await readFile('.local-archives/bhutan-metadata-20260920/source-inventory.json'));
const registered=inventory.sources.find(x=>x.datasetId===row.datasetId);
const metadata=row.document.metadata.normalized[0].value;
const sample=await readFile('.local-archives/bhutan-metadata-20260920/cadastral_data_Core_Town-sample.geojson');
const component=(await readdir(resolve(dist,'_import/components'))).find(x=>/^LayerResourcePage\..*\.js$/.test(x));
const styles=(await readFile(resolve(dist,'layers.html'),'utf8')).match(/href="([^"]+\.css)"/g).map(x=>x.slice(6,-1));
const origin='https://metadata.invalid';const receipt={status:'running',widths:[],externalRequests:0,providerFixtureReads:0,scope:'Built cards and actual WebGL preview with retained live five-parcel fixture; local adapter, not hosted authentication.'};
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {for(const colorScheme of ['dark','light']) for(const width of [1155,390]) {
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme});const errors=[];
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.href.startsWith(row.sourceUrl)){
   receipt.providerFixtureReads++;
   if(u.pathname.endsWith('/query')){assert.equal(u.searchParams.has('maxAllowableOffset'),false);assert.equal(u.searchParams.has('geometryPrecision'),false);return route.fulfill({contentType:'application/geo+json',body:sample});}
   return route.fulfill({json:metadata});
  }
  if(u.hostname==='tiles.openfreemap.org')return route.fulfill({json:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef0f1'}}]}});
  if(u.origin!==origin){receipt.externalRequests++;return route.abort();}
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8">${styles.map(h=>`<link rel="stylesheet" href="${h}">`).join('')}<style>body{margin:0;padding:16px;max-width:100%;box-sizing:border-box}article{width:100%}</style><script type="module">import {renderLayerResource} from '/_import/components/${component}';const source=${JSON.stringify({...registered,status:'active',versionNumber:row.sourceVersion,credentialMode:'none',accessMode:'direct_browser',capabilities:{read:true}})};const dataset=${JSON.stringify({id:row.datasetId,projectId:row.projectId,name:'NSDI Bhutan · Hosted/cadastral_data_Core_Town/FeatureServer:0 · Cadastral Data',sourceType:'arcgis',format:'arcgis',status:'active',classification:'internal',capabilities:{managePermissions:true}})};document.body.append(renderLayerResource({dataset,source,knowledge:${JSON.stringify({version:1,document:row.document})},projects:[{id:dataset.projectId,name:'Bhutan Geospatial Data',status:'active',callerRole:'owner'}],adapter:{kind:'api',getSource:async()=>source,attachDataset:async()=>dataset}}));</script>`});
  try{return route.fulfill({body:await readFile(resolve(dist,'.'+u.pathname)),contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.getByRole('heading',{name:'Geometry and coverage',exact:true}).waitFor();
 assert.match(await page.locator('.layer-metadata-grid').innerText(),/Polygon/);assert.equal(await page.locator('tbody tr').count(),metadata.fields.length);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const colors=await page.evaluate(()=>[...document.querySelectorAll('.platform-button.secondary')].map(el=>getComputedStyle(el).color));assert.equal(new Set(colors).size,1);
 const spacing=await page.locator('.layer-resource-reuse .platform-controls').evaluate(el=>{const a=el.querySelector('select').getBoundingClientRect(),b=el.querySelector('button').getBoundingClientRect();return Math.max(b.left-a.right,b.top-a.bottom)});assert.ok(spacing>=7);
 await page.screenshot({path:resolve(out,`cards-${colorScheme}-${width}.png`),fullPage:false});
 await page.getByRole('button',{name:'Inspect registered connection',exact:true}).click();await page.getByRole('button',{name:'Preview layer',exact:true}).click();
 await page.locator('.map-frame').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.map-preview-status')?.textContent.includes('Layer view ready'));
 assert.equal(await page.locator('canvas').count(),1);assert.ok(await page.evaluate(()=>document.querySelector('.map-frame').__view().zoom>15));assert.match(await page.locator('.catalog-layer-preview').innerText(),/without requested simplification/);
 await page.screenshot({path:resolve(out,`polygons-${colorScheme}-${width}.png`)});assert.deepEqual(errors,[]);receipt.widths.push({width,colorScheme,cardsFit:true,attributeFields:metadata.fields.length,webglPreviewReady:true});await context.close();
 }assert.equal(receipt.externalRequests,0);receipt.status='passed';
} catch(e){receipt.status='failed';receipt.error=String(e);throw e;}finally{await browser.close();await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
