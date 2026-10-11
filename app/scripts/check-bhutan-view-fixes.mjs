import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
const root=resolve('..'),dist=resolve('dist'),out=resolve(root,'.local-archives/bhutan-view-fixes-20260920');
await mkdir(out,{recursive:true});
const body=await readFile('/tmp/bhutan-basin-response.json');await writeFile(resolve(out,'basin-response.json'),body);
const source=JSON.parse(await readFile(resolve(root,'.local-archives/bhutan-local-20260920/catalog-drafts.json'))).drafts.find(x=>x.sourceUrl.includes('/Basin_boundary_view/')).request.source;
const module=(await readdir(resolve(dist,'_import/components'))).find(x=>/^WorkbenchView\..*\.js$/.test(x));
const origin='https://view-fixes.invalid';
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const receipt={status:'running',externalRequests:0,results:[],scope:'Built UI with actual NSDI bytes, intercepted transport; not hosted sign-in.'};
try{for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:width===1440?'dark':'light',hasTouch:width===390});
 if(width===390)await context.addInitScript(()=>localStorage.setItem('opengeo.workbench.color-mode','dark'));
 const requested=[];
 await context.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.href.startsWith(source.url+'/query'))return route.fulfill({contentType:'application/geo+json',body});
 if(u.origin==='https://tiles.openfreemap.org'){requested.push(u.pathname);return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#202020'}}]})});}
 if(u.origin!==origin)return route.abort();
 if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
 import {WorkbenchView} from '/_import/components/${module}';const c=${JSON.stringify(source)};
 const layer={layerId:'basin',datasetId:'499a9aae-6a21-4ed2-a8b9-f29b435ea6fa',title:'Basin boundaries',sourceType:'external-feature-reference',sourceVersion:1,sourceUrl:c.url,geometryType:c.geometry_type,sourceConfiguration:{objectIdField:c.object_id_field,fields:c.fields,geometryType:c.geometry_type,pageSize:c.page_size,attribution:c.attribution},visible:true,opacity:1,order:0,style:{},labels:{enabled:false}};
 window.shell=WorkbenchView({workspace:{workspaceId:'f340b616-691b-4770-b22e-03a6913f96f1',title:'Bhutan'},project:{schemaVersion:'opengeo.map-definition.1.3.0',colorMode:'light',layers:[layer],mapViews:[{id:'default',title:'Default',center:[90.45,27.5],zoom:7}],basemaps:[],bookmarks:[],activeLayerId:'basin'},layers:[layer],role:'owner',persistenceMode:'browser'});document.body.append(shell);</script>`});
 try{const path=u.pathname==='/style.css'?resolve('src/style.css'):u.pathname==='/maplibre.css'?resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'):resolve(dist,'.'+u.pathname);return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream',body:await readFile(path)});}catch{return route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 await page.waitForFunction(()=>window.shell?.__opengeoMap?.isStyleLoaded());
 assert.equal(await page.locator('.opengeo-workbench').getAttribute('data-color-mode'),'dark');assert.ok(requested.includes('/styles/positron'));
 const action=async name=>{if(await page.locator('.gis-menubar [data-menu="controls"] > button').isVisible()) await page.locator('.gis-menubar [data-menu="controls"] > button').click();
   else { await page.getByRole('button',{name:'Actions',exact:true}).click(); await page.locator('[data-mobile-command-category="controls"] > summary').click(); }await page.getByRole('menuitem',{name,exact:true}).click();};
 if(width===390)await action('Show map controls');
 await action('Hide map controls');assert.equal(await page.locator('.gis-camera-controls').isVisible(),false);
 await action('Show map controls');assert.equal(await page.locator('.gis-camera-controls').isVisible(),true);
 await page.waitForFunction(()=>Object.values(shell.__opengeoMap.getStyle().sources).some(source=>source.data?.features?.length===10)).catch(async error=>{console.log(JSON.stringify(await page.evaluate(()=>({status:document.querySelector('.gis-statusbar')?.textContent,sources:Object.entries(shell.__opengeoMap.getStyle().sources).map(([id,s])=>({id,type:s.type,dataType:typeof s.data,count:s.data?.features?.length})),text:document.querySelector('.gis-panel-left')?.textContent}))));throw error;});
 await page.waitForFunction(()=>shell.__opengeoMap.queryRenderedFeatures({layers:shell.__opengeoMap.getStyle().layers.filter(x=>x.source==='basin-source').map(x=>x.id)}).length>0);
 await page.screenshot({path:resolve(out,`view-${width}.png`)});assert.deepEqual(errors,[]);
 receipt.results.push({width,darkPreferenceRespected:true,lightBasemapIndependentOfDarkUi:true,controllerHideRestore:true,realBasinFeatures:10,renderedFeaturesVerified:true});await context.close();
}receipt.status='passed';}catch(e){receipt.status='failed';receipt.error=String(e);throw e;}
finally{await browser.close();receipt.tree=JSON.parse(await readFile(resolve(root,'dist/opengeo-studio-build.json'))).artifactTree.digest;await writeFile(resolve(out,'browser-check.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
