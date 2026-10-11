// Real native SDK, local fixtures only. Not Workbench switch or account acceptance.
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {chromium} from "playwright";
import {CESIUM_RUNTIME} from "../src/lib/cesiumRuntime.js";
import {prepareCesiumRuntime} from "./prepare-cesium-runtime.mjs";

const root=fileURLToPath(new URL("../",import.meta.url)), out=await mkdtemp(`${tmpdir()}/opengeo-cesium-`);
const framed=process.env.OPENGEO_CESIUM_FRAME_CHECK==="1";
let browser;
try {
  const packaged=await prepareCesiumRuntime(out);
  const policySource=await readFile(resolve(root,'../infrastructure/lib/renderer-frame.ts'),'utf8');
  const hostPolicy=[...policySource.split('export const RENDERER_FRAME_CSP = [')[1].split('].join')[0].matchAll(/"([^"\n]+)"/g)].map(match=>match[1]).join('; ');
  assert.ok(policySource.includes(`"${packaged.hostPage.slice(1)}"`),'Host packaging and edge path agree');
  const hostBundle=framed?await build({entryPoints:[resolve(root,"src/lib/cesiumFrameHost.js")],bundle:true,format:"esm",write:false}):null;
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {createCesiumLoader} from './src/lib/cesiumLoader.js';
    ${framed?"import {createCesiumFrameScene} from './src/lib/cesiumFrame.js';window.createFrameScene=createCesiumFrameScene;":''}
    const loader=createCesiumLoader();
    const polygon={type:'Feature',id:'boundary',properties:{name:'Survey',license:'retained'},geometry:{type:'Polygon',coordinates:[
      [[-4,-4],[4,-4],[4,4],[-4,4],[-4,-4]], [[-1,-1],[-1,1],[1,1],[1,-1],[-1,-1]]
    ]}};
    const point={type:'Feature',id:'observation',properties:{name:'Observation','marker-symbol':'https://never.test/icon'},geometry:{type:'Point',coordinates:[2,2]}};
    window.entries=[{layer:{layerId:'survey',title:'Survey',visible:true,styleReference:{styleId:'retained',versionNumber:3}},
      geojson:{type:'FeatureCollection',features:[polygon]},parts:[{id:'fill',type:'fill',paint:{'fill-color':'#ff0000','fill-opacity':0.6}},
        {id:'outline',type:'line',paint:{'line-color':'#008000','line-width':3}}]},
      {layer:{layerId:'observations',title:'Observations',visible:true},geojson:{type:'FeatureCollection',features:[point]},
        parts:[{id:'points',type:'circle',paint:{'circle-color':'#0000ff','circle-radius':8,'circle-stroke-color':'#ffffff','circle-stroke-width':2}}]}];
    window.original=JSON.stringify(entries);
    window.openScene=async()=>{
      ${framed?`window.frameAbort=new AbortController();
      window.scene=await createCesiumFrameScene({container:document.getElementById('scene'),entries,camera:{center:[0,0],zoom:5,bearing:0,pitch:0},signal:frameAbort.signal});
      return {camera:scene.getCamera(),version:scene.version,unchanged:JSON.stringify(entries)===original};`:`
      const a=loader.load(), b=loader.load(); if(a!==b)throw Error('duplicate_sdk_load');
      window.adapter=await a;
      window.scene=await adapter.createScene({container:document.getElementById('scene'),entries,camera:{center:[0,0],zoom:5,bearing:0,pitch:0}}).catch(error=>{throw Error(JSON.stringify({error:error.message,readiness:error.readiness}));});
      return {camera:scene.getCamera(),version:adapter.version,unchanged:JSON.stringify(entries)===original};`}

    };
    window.screen=(lng,lat)=>scene.project([lng,lat]);

  `},bundle:true,format:"esm",write:false,external:["/renderer-runtime/*"],plugins:framed?[{name:"frame-host",setup(builder){
    builder.onResolve({filter:/cesiumFrameHost\.js$/},()=>({path:"/host.js",external:true}));
  }}]:[]});
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||"/usr/bin/chromium-browser"});
  const page=await browser.newPage({viewport:{width:900,height:700}}), errors=[],requests=[],denied=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=="https://studio.test") {denied.push(url.origin);return route.abort();}
    requests.push(url.pathname);
    if(url.pathname==="/") return route.fulfill({contentType:"text/html",body:`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'"><style>html,body,#scene{width:100%;height:100%;margin:0}</style><div id="scene"></div><script type="module" src="/test.js"></script>`});
    if(url.pathname==="/host.js" && hostBundle)return route.fulfill({contentType:"text/javascript",body:hostBundle.outputFiles[0].text});
    if(url.pathname==="/test.js") return route.fulfill({contentType:"text/javascript",body:bundle.outputFiles[0].text});
    if(url.pathname.startsWith(CESIUM_RUNTIME.basePath)) {
      const path=resolve(out,`.${url.pathname}`);
      if(!path.startsWith(`${out}/`)) throw Error("outside_package");
      return route.fulfill({headers:path.endsWith('opengeo-host.html')?{
        'Content-Security-Policy':hostPolicy,
        'X-Frame-Options':'SAMEORIGIN'
      }:{},contentType:({js:"text/javascript",css:"text/css",json:"application/json",png:"image/png",svg:"image/svg+xml",html:"text/html"})[path.split('.').at(-1)]??"application/octet-stream",body:await readFile(path)});
    }
    denied.push(url.pathname);return route.abort();
  });
  await page.goto("https://studio.test");
  await page.waitForFunction(()=>typeof window.openScene==="function");
  assert.equal(requests.some(path=>path.startsWith(CESIUM_RUNTIME.basePath)),false,"No startup SDK requests");
  let opened;
  try {opened=await page.evaluate(()=>window.openScene());}
  catch(error){console.error(JSON.stringify({errors,denied,requests}));throw error;}
  assert.equal(opened.version,CESIUM_RUNTIME.version); assert.equal(opened.unchanged,true);
  assert.ok(Math.abs(opened.camera.zoom-5)<0.001,JSON.stringify(opened.camera));
  const picks=await page.evaluate(()=>({point:scene.pick(screen(2,2)),polygon:scene.pick(screen(2,0)),hole:scene.pick(screen(0,0))}));
  assert.equal(picks.point.layerId,"observations"); assert.equal(picks.point.feature.id,"observation");
  assert.equal(picks.polygon.layerId,"survey"); assert.equal(picks.polygon.feature.properties.license,"retained");
  assert.equal(picks.hole,null);
  const polygonPixel=await page.evaluate(()=>{
    const point=screen(2,0),canvas=(document.querySelector('iframe')?.contentDocument??document).querySelector('canvas'),gl=canvas.getContext('webgl2'),rgba=new Uint8Array(4);
    gl.readPixels(Math.round(point.x),canvas.height-Math.round(point.y)-1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return [...rgba];
  });
  assert.ok(polygonPixel[0]>polygonPixel[1]+30,JSON.stringify(polygonPixel));
  await page.evaluate(()=>scene.setLayerVisibility('survey',false));
  await page.waitForFunction(()=>scene.pick(screen(2,0))===null);
  const camera=await page.evaluate(async()=>{
    scene.setLayerVisibility('survey',true);scene.setLayerOrder(['observations','survey']);
    scene.setCamera({center:[1,1],zoom:5,bearing:15,pitch:25});return scene.getCamera();
  });
  for(const [actual,expected] of [[camera.center[0],1],[camera.center[1],1],[camera.zoom,5],[camera.bearing,15],[camera.pitch,25]])
    assert.ok(Math.abs(actual-expected)<0.01,JSON.stringify(camera));
  assert.equal(await page.evaluate(()=>JSON.stringify(entries)===original),true);
  const ownedWorkers=page.workers();
  const closed=framed?Promise.all(ownedWorkers.map(worker=>worker.waitForEvent('close',{timeout:5000}))):null;
  await page.evaluate(async framed=>{
    const controller=new AbortController();controller.abort();
    try {
      if(framed)await createFrameScene({container:document.getElementById('scene'),entries,signal:controller.signal});
      else await adapter.createScene({container:document.getElementById('scene'),entries,signal:controller.signal});
      throw Error('unexpected_scene');
    } catch(error){if(error.message!=='cesium_scene_cancelled')throw error;}
    scene.destroy();scene.destroy();
  },framed);
  if(framed){assert.ok(ownedWorkers.length>0);await closed;assert.equal(await page.locator('iframe').count(),0);}
  assert.equal(await page.locator('canvas').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
  const retainedSdkWorkers=page.workers().length;
  if(framed){
    assert.equal(retainedSdkWorkers,0);
    await page.evaluate(()=>window.openScene());
    assert.equal((await page.evaluate(()=>scene.pick(screen(2,0)))).layerId,'survey');
    const reopenedWorkers=page.workers();
    const stopped=Promise.all(reopenedWorkers.map(worker=>worker.waitForEvent('close',{timeout:5000})));
    await page.evaluate(()=>frameAbort.abort());await stopped;
    assert.equal(page.workers().length,0);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.evaluate(()=>{try{scene.getCamera();return false;}catch{return true;}}),true);
    // Abort after attaching a frame, before its asynchronous host can become ready.
    assert.equal(await page.evaluate(async()=>{
      const controller=new AbortController();
      const pending=createFrameScene({container:document.getElementById('scene'),entries,signal:controller.signal});
      controller.abort();
      try {await pending;return false;}catch(error){return error.message==='cesium_scene_cancelled';}
    }),true);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(page.workers().length,0);
  }
  console.log(JSON.stringify({status:"pass",version:opened.version,packaged,lazy:true,originalDefinitionsUnchanged:true,
    polygonPixel,picking:true,polygonHole:true,visibility:true,camera,viewerDisposed:true,isolatedFrame:framed,workerTermination:framed,reopenAndAbort:framed,pendingAbort:framed,retainedSdkWorkers,externalRequests:0,localRequests:requests.length,
    limits:"Native adapter only; Workbench engine switch, raster/services, labels, complex Styles and production acceptance remain open."}));
} finally {if(browser)await browser.close();await rm(out,{recursive:true,force:true});}
