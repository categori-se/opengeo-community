// Bounded live-origin acceptance for the released controller and map-only mode.
// Real deployed application; external basemap responses are blocked, no sign-in.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
const demo=process.argv.includes('--demo'),local=process.argv.includes('--local');

let server;
if(local){
 const root=resolve(demo?'app/dist/demo-build':'app/dist');
 server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  const file=resolve(root,'.'+(path==='/'?'/index.html':decodeURIComponent(path)));
  assert.ok(file.startsWith(root+'/'));
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'})[extname(file)]??'application/octet-stream');
  res.end(await readFile(file));
 }catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
}
const origin=local?`http://127.0.0.1:${server.address().port}`:demo?'https://demo.studio.opengeo.tools':'https://studio.opengeo.tools';
const out=resolve(process.env.OPEN_GEO_CONTROLLER_EVIDENCE_DIR??(demo?'.local-archives/demo-controller-20260920':'.local-archives/progress-release-20260920/live-controls'));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
const receipt={status:'running',origin,applicationMocked:false,authenticated:false,externalProviderReads:0,providerMetadataReads:0,results:[],requests:0,privateRequests:[]};
if(demo)receipt.tree=JSON.parse(await readFile('dist/opengeo-demo-build.json','utf8')).artifactTree.digest;
try {
 for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block',hasTouch:width===390});
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(demo&&/\/api\/|auth-config|workspaces|login/.test(url.pathname)){receipt.privateRequests.push(url.pathname);return route.abort();}
   if(!local && url.href==='https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'){receipt.providerMetadataReads++;assert.ok(receipt.providerMetadataReads<=2);return route.continue();}
   if(url.origin!==origin)return route.abort();
   receipt.requests++;assert.ok(receipt.requests<=350,'Request ceiling');
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  if(!demo)await page.getByRole('button',{name:'Close start panel and use an empty map',exact:true}).click();
  await page.waitForFunction(()=>!!document.querySelector('.opengeo-workbench')?.__opengeoMap);
  const shell=page.locator('.opengeo-workbench');
  const action=async name=>{
   if(await page.locator('.gis-menubar [data-menu="controls"] > button').isVisible()) await page.locator('.gis-menubar [data-menu="controls"] > button').click();
   else { await page.getByRole('button',{name:'Actions',exact:true}).click(); await page.locator('[data-mobile-command-category="controls"] > summary').click(); }
   await page.getByRole('menuitem',{name,exact:true}).click();
  };
  const clearSurface=async()=>{
   for(const selector of ['.gis-map-chrome','.gis-panel-reopen','.gis-map .maplibregl-control-container','.gis-map .maplibregl-popup']) {
    for(const node of await page.locator(selector).all()) assert.equal(await node.isVisible(),false,selector);
   }
   assert.equal(await page.locator('.gis-map-tools-restore,.gis-map-controls-toggle').count(),0);
   assert.equal(await page.locator('.gis-map-only-command').isVisible(),true);
   const attribution=page.locator('.gis-map-attribution');
   assert.equal(await attribution.isVisible(),true);
   assert.equal(await attribution.evaluate(el=>el.getBoundingClientRect().top>=el.previousElementSibling.getBoundingClientRect().bottom-1),true);
  };
  if(!demo){
   const nav=page.locator('.gis-app-nav');
   assert.doesNotMatch(await nav.innerText(), /Demo|Sample datasets|Open Studio/);
   assert.equal(await page.getByRole('combobox',{name:'Switch project',exact:true}).isEnabled(),true);
  }
  const toggle=page.locator('.gis-controls-command');
  if(width===390){await clearSurface();await toggle.click();}
  for(const key of ['globe','terrainEnabled','openScene3dEnabled','graticule','rightOpen']) assert.equal(await page.locator(`[data-map-mode="${key}"]`).isVisible(),true);
  await page.locator('[data-map-mode="graticule"]').click();
  assert.equal(await page.locator('[data-map-mode="graticule"]').getAttribute('aria-pressed'),'true');
  await toggle.click();
  await clearSurface();
  await toggle.click();
  assert.equal(await page.locator('.gis-camera-controls').isVisible(),true);
  await page.locator('.gis-camera-help > summary').click();
  await page.locator('.gis-map-view-help > summary').click();
  assert.equal(await page.locator('.gis-map-control-stack').evaluate(el=>{
   const box=el.getBoundingClientRect(),map=el.parentElement.getBoundingClientRect();
   return el.scrollWidth<=el.clientWidth+1&&box.left>=map.left&&box.right<=map.right+1&&box.top>=map.top&&box.bottom<=map.bottom+1;
  }),true);
  await page.screenshot({path:resolve(out,`controller-${width}.png`)});
  await page.locator('.gis-map-view-help > summary').click();await page.locator('.gis-camera-help > summary').click();
  const before=await shell.getAttribute('class');
  await page.locator('.gis-map-only-command').click();
  await clearSurface();
  for(const selector of ['.gis-panel-left','.gis-panel-right','.gis-mobile-toolbar','.gis-statusbar','.gis-panel-resizers'])assert.equal(await page.locator(selector).isVisible(),false);
  assert.equal(await page.locator('.gis-topbar').isVisible(),true);
  assert.equal(await shell.evaluate(el=>{const b=el.getBoundingClientRect(),m=el.querySelector('.gis-map').getBoundingClientRect(),t=el.querySelector('.gis-topbar').getBoundingClientRect();return Math.abs(b.width-m.width)<3&&m.top>=t.bottom-1;}),true);
  await page.screenshot({path:resolve(out,`map-only-${width}.png`)});
  await page.locator('.gis-map-only-command').click();
  await page.locator('.gis-map-only-command').click();
  await page.locator('.gis-map').focus();
  await page.keyboard.press('Escape');
  assert.equal(await shell.getAttribute('class'),before);
  assert.deepEqual(await shell.evaluate(el=>{const m=el.__opengeoMap;return [m.dragPan.isEnabled(),m.touchZoomRotate.isEnabled(),m.touchPitch.isEnabled()];}),[true,true,true]);
  if(!local){
   await action('Imagery history');
   await page.getByLabel('Imagery source to explore',{exact:true}).selectOption('esri-world-imagery-wayback');
   const releases=page.getByLabel('Wayback release date',{exact:true});await releases.waitFor();
   assert.ok(await releases.locator('option').count()>0);
   const viewer=page.getByRole('link',{name:'Open selected release in Wayback ↗',exact:true});
   assert.match(await viewer.getAttribute('href'),/^https:\/\/livingatlas\.arcgis\.com\/wayback\/#mapCenter=.*&active=[0-9]+$/);
   assert.equal(await viewer.getAttribute('target'),'_blank');
  }
  assert.deepEqual(errors,[]);
  receipt.results.push({width,headerToggle:true,allControllerModesVisible:true,studioNavigation:!demo,controllerFits:true,mapOnlyRestores:true,touchHandlersEnabled:true});
  await context.close();
 }
 for(const [path,status] of (demo||local?[]:[['/api/health/live',200],['/api/auth/session',401]])){
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,status);receipt.results.push({path,status});
 }
 assert.deepEqual(receipt.privateRequests,[]);receipt.status='passed';
} catch(error){receipt.status='failed';receipt.error=String(error);throw error;}
finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));receipt.finishedAt=new Date().toISOString();await writeFile(resolve(out,demo?(local?'controller-check.json':'live-controller-check.json'):'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));}
