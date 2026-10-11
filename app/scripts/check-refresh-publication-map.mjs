import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
let text='';for await(const chunk of process.stdin)text+=chunk;
const config=JSON.parse(text); config.paintId=config.styled?'old-point-style-0':'old-point'; config.sourceId=config.exportControls?'old-point-source':'old-point'; config.secondaryIds=config.exportControls?.find(c=>c.title==='Referenced source outline')?.ids??['source-outline']; const root=resolve(config.root), origin='https://publication.invalid';
const errors=[],external=[];
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const context=await browser.newContext();
 // Observe the real runtime instance without replacing map methods or rendering.
 await context.addInitScript(()=>{
  Object.defineProperty(window,'maplibregl',{configurable:true,get(){return this.__runtime;},set(value){
   const Map=value.Map;value.Map=new Proxy(Map,{construct(target,args){const map=Reflect.construct(target,args);window.__observedMap=map;return map;}});
   this.__runtime=value;
  }});
 });
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){external.push(url.origin);return route.abort();}
  const path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  const file=resolve(join(root,path));assert.ok(file.startsWith(root+'/'));
  return route.fulfill({contentType:'text/html',body:readFileSync(file)});
 });
 const page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));
 const checks=[];
 for(const width of [1100,390]) {
  await page.setViewportSize({width,height:800});await page.goto(origin);
  const frame=page.frameLocator('iframe');
  await frame.getByRole('status').filter({hasText:'Offline edition'}).waitFor();
  const mapFrame=page.frames().find(f=>f.url().endsWith('/maps/survey.html'));
  await mapFrame.waitForFunction(()=>window.__observedMap?.loaded() && window.__observedMap.queryRenderedFeatures().length>0);
  const polygon=config.geometry?.type==='Polygon';
  if(polygon) {
   const check=await mapFrame.evaluate(({coordinates,paintId,sourceId})=>{
    const map=window.__observedMap;
    return {filled:map.queryRenderedFeatures(map.project([coordinates[0]+.004,coordinates[1]]),{layers:[paintId]}).length,
     hole:map.queryRenderedFeatures(map.project(coordinates),{layers:[paintId]}).length,
     source:map.getStyle().sources[sourceId].data.features[0].geometry};
   },config);
   assert.ok(check.filled>0);assert.equal(check.hole,0);assert.deepEqual(check.source,config.geometry);
  } else {
   const coords=await mapFrame.evaluate(()=>window.__observedMap.queryRenderedFeatures().map(f=>f.geometry.coordinates));
   assert.ok(coords.some(c=>Math.abs(c[0]-config.coordinates[0])<.0001&&Math.abs(c[1]-config.coordinates[1])<.0001),JSON.stringify(coords));
   assert.ok(!coords.some(c=>Math.abs(c[0]-config.changedCoordinates[0])<.0001));
  }
  await mapFrame.evaluate(id=>window.__paintId=id,config.paintId);
  if(config.styled){
   assert.equal(await mapFrame.evaluate(()=>window.__observedMap.getPaintProperty('old-point-style-0','fill-color')),'#ff0000');
   await frame.getByRole('checkbox',{name:'Referenced source outline'}).uncheck();
   assert.equal(await mapFrame.evaluate(ids=>ids.every(id=>window.__observedMap.getLayoutProperty(id,'visibility')==='none'),config.secondaryIds),true);
   await frame.getByRole('checkbox',{name:'Referenced source outline'}).check();
  }
  const checkbox=frame.getByRole('checkbox',{name:polygon?'Pinned earlier polygon':'Pinned old point'});await checkbox.uncheck();
  await mapFrame.waitForFunction(()=>window.__observedMap.getLayoutProperty(window.__paintId,'visibility')==='none');
  await checkbox.check();await frame.getByRole('button',{name:'Reset view',exact:true}).click();
  const bounds=await frame.getByRole('button',{name:'Reset view',exact:true}).boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  checks.push({width,pinnedStyleRendered:!!config.styled,secondLayerToggle:!!config.styled,geometryType:config.geometry?.type??'Point',polygonHoleVerified:polygon,earlierGeometryRendered:true,layerToggle:true,resetControlInViewport:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log(JSON.stringify({status:'passed',checks,externalRequests:0,errors,runtime:'Real bundled MapLibre with software WebGL',scope:'Retained local Publication output; runtime instance observed, no substituted rendering.'}));
}finally{await browser.close();}
