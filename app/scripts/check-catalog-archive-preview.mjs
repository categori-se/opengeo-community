// Local built catalog UI + retained real wind preview; no AWS or provider reads.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const out=resolve('../.local-archives/nepal-srilanka-catalog-20260921/bhutan-wind'),dist=resolve('dist');
const registration=JSON.parse(await readFile(resolve(out,'registration.json'))).records[0];
const data=JSON.parse(await readFile(resolve(out,'inspection/wind-density/preview.geojson')));
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^LayerResourcePage\..*\.js$/.test(x));
assert.ok(module);assert.equal(data.features.length,899);
const html=await readFile(resolve(dist,'layers.html'),'utf8');
const theme=html.match(/href="\.([^"]*theme-[^"]*\.css)"/)[1];
const origin='https://catalog-preview.invalid';let unexpected=0;const errors=[];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const context=await browser.newContext({viewport:{width:1200,height:900},serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.href==='https://tiles.openfreemap.org/styles/positron')return route.fulfill({json:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#ddd'}}]}});
  if(url.origin!==origin){unexpected++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${theme}"><link rel="stylesheet" href="/style.css"><style>body{margin:16px;background:#202020;color:#eee}button{cursor:pointer}</style><script type="module">
   import {renderLayerResource} from '/_import/components/${module}';
   const dataset=${JSON.stringify({id:registration.datasetId,projectId:'f340b616-691b-4770-b22e-03a6913f96f1',currentVersionId:registration.datasetVersionId,currentVersionNumber:1,status:'active',currentVersionState:'active',capabilities:{read:true},sourceType:'upload',format:'geojson',geometryType:'Polygon',name:'Bhutan · NREL · Wind power density at 50 m'})};
   window.reads=0;
   const adapter={getDatasetSpatialPreview:async(project,id,version)=>{window.reads++;if(id!==dataset.id||version!==dataset.currentVersionId)throw Error('Identity mismatch');return {datasetVersionId:version,numberReturned:899,numberMatched:899,mayBeTruncated:false,geojson:${JSON.stringify(data).replaceAll('<','\\u003c')}};}};
   document.body.append(renderLayerResource({dataset,adapter}));
  </script>`});
  const path=url.pathname==='/style.css'?resolve('src/style.css'):url.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+url.pathname);
  try{return route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'application/octet-stream'});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('button',{name:'Preview archived data',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>reads),0);
 await page.getByRole('button',{name:'Preview archived data',exact:true}).click();
 await page.getByText('Layer view ready. Pan and zoom to explore.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>reads),1);
 assert.equal(await page.locator('.maplibregl-canvas').count(),1);
 assert.match(await page.locator('.layer-resource-archive-preview').innerText(),/899 of 899 features · complete preview/);
 await page.screenshot({path:resolve(out,'catalog-preview-desktop.png')});
 await page.getByRole('button',{name:'Hide preview',exact:true}).click();
 assert.equal(await page.locator('.maplibregl-canvas').isVisible(),false);
 await page.getByRole('button',{name:'Preview archived data',exact:true}).click();
 assert.equal(await page.evaluate(()=>reads),1);
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>document.querySelector('.map-frame').getBoundingClientRect().width<390);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:resolve(out,'catalog-preview-mobile.png')});
 await page.reload();await page.getByRole('button',{name:'Preview archived data',exact:true}).click();
 await page.getByText('Layer view ready. Pan and zoom to explore.',{exact:true}).waitFor();
 await page.screenshot({path:resolve(out,'catalog-preview-mobile.png')});
 assert.deepEqual(errors,[]);assert.equal(unexpected,0);
 const receipt={status:'passed',scope:'Built catalog layer page; real 899-feature archived data with local intercepted transport; not hosted authentication acceptance',readsBeforeClick:0,readsAfterClick:1,additionalReadsOnReopen:0,desktop:true,mobileWidth:390,mobileOverflow:false,externalReads:0};
 await writeFile(resolve(out,'catalog-preview-browser.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
} finally {await browser.close();}
