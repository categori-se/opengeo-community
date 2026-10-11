// Bounded offline acceptance; all provider/auth responses are local fixtures.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
import {chromium} from "playwright";
import {MAPBOX_RUNTIME} from "../src/lib/mapboxRuntime.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const switching = process.env.OPENGEO_RENDERER_SWITCH_CHECK === "1";
const workerEntry = switching ? JSON.parse(await readFile(resolve(root,"../dist/opengeo-studio-release.json"),"utf8"))
  .artifactTree.files.find(file=>file.path.includes("/maplibre-worker.")) : null;
const worker = workerEntry ? await readFile(resolve(root,"dist",workerEntry.path)) : null;
if (worker) assert.equal(createHash("sha256").update(worker).digest("hex"),workerEntry.sha256);
const bundle = await build({stdin:{resolveDir:root, contents:`
${switching ? `import {WorkbenchView} from './src/components/WorkbenchView.js';
import {emptyMapDefinition,upgradeMapDefinition} from './src/lib/mapDefinition.js';
import {createCognitoBrowserAuth} from './src/lib/cognitoAuth.js';
import {mapFontAttachments} from './src/lib/mapFontAttachments.js';
import {PINNED_MAP_FONT} from './src/lib/mapFonts.js';
window.auth=createCognitoBrowserAuth({
 locationImplementation:{origin:location.origin,href:location.href,assign:url=>{window.logoutDestination=url;}},
 configLoader:()=>new Promise(resolve=>{window.finishLogoutConfig=()=>resolve({hostedUiBaseUrl:'https://identity.test',clientId:'fixture',logoutUri:'https://studio.test/'});})
});
const id='d0000000-0000-4000-8000-000000000002';
const definition=JSON.stringify({version:8,sources:{},layers:[{id:'survey-fill',type:'fill',paint:{'fill-color':'#ff0000','fill-outline-color':'#ff0000','fill-opacity':1}}]});
const checksumSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(definition)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const styleReference={projectId:id,resourceId:id,styleId:id,versionNumber:3,format:'maplibre',checksumSha256};
window.pinnedStyle=styleReference;
window.styleReads=[];
const styleAdapter={getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async(projectId,resourceId,styleId,versionNumber)=>{
 window.styleReads.push({projectId,resourceId,styleId,versionNumber});
 return {id,resourceId:id,title:'Survey Style',versionNumber:3,format:'maplibre',checksumSha256,definition};
}};
const layer={layerId:'survey',datasetId:id,datasetVersionId:id,sourceVersion:1,title:'Survey boundary',sourceType:'governed-dataset',geometryType:'Polygon',visible:true,opacity:0.6,order:0,style:{fill:'#0000ff'},styleReference,labels:{enabled:false}};
const data={type:'FeatureCollection',features:[{type:'Feature',id:'a',properties:{name:'Café Ω Москва'},geometry:{type:'Polygon',coordinates:[[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]]]}}]};
const nameData={type:'FeatureCollection',features:[{type:'Feature',id:'name',properties:{name:'Café Ω Москва'},geometry:{type:'Point',coordinates:[-5,5]}}]};
const names={...layer,layerId:'survey-names',title:'Survey names',order:1,geometryType:'Point',style:{circleColor:'#0000ff',circleRadius:4},styleReference:undefined,labels:{enabled:true,field:'name',prefix:'',fontRef:{...PINNED_MAP_FONT}}};
const project=emptyMapDefinition({schemaVersion:'opengeo.map-definition.1.4.0',title:'Renderer survey',layers:[layer,names],extensions:{fixture:{note:'retain foreign extension'}}});
project.layerTree=[{id:'survey-folder',kind:'group',title:'Field survey',children:[{kind:'layer',layerId:'survey'},{kind:'layer',layerId:'survey-names'}]}];
window.reopenProject=()=>{
 window.view?.dispose?.();window.view?.remove();
 const stored=localStorage.getItem('renderer-project-fixture');
 const reopened=stored?upgradeMapDefinition(JSON.parse(stored)):project;
 window.view=WorkbenchView({workspace:{workspaceId:id,title:'Survey'},role:'owner',mapFontAttachments,project:reopened,layers:reopened.layers,geojsonByLayerId:new Map([['survey',data],['survey-names',nameData]]),styleAdapter,canResumeRenderer:async()=>window.rendererAccess!==false,restoreBrowserDraft:false,persistenceMode:'fixture',saveProject:async definition=>{
  localStorage.setItem('renderer-project-fixture',JSON.stringify(definition));return {id,version:2,definition,updatedAt:new Date().toISOString()};
 }});
 document.body.append(window.view);
};window.reopenProject();` : ""}
import {createMapboxLoader} from './src/lib/mapboxLoader.js';
import {createMapboxSession} from './src/lib/mapboxSession.js';
const loader=createMapboxLoader();
window.loadOptionalRenderer=async()=>{
  const session=createMapboxSession();session.configure('pk.local-fixture.not-a-real-token');
  const adapter=await loader.load(session);
  session.clear();
  return {id:adapter.id,version:adapter.version,cleared:!session.configured};
};`},bundle:true,format:"esm",write:false,plugins:[{name:"worker",setup(builder){
  builder.onResolve({filter:/^observablehq:stdlib$/},()=>({path:"stdlib",namespace:"local"}));
  builder.onLoad({filter:/.*/,namespace:"local"},()=>({contents:`export const FileAttachment=path=>{
    const url=path.includes('render-fonts/')?'/fonts/'+path.split('/').pop():'/worker.js';
    return {url:async()=>url,arrayBuffer:async()=>{const r=await fetch(url);if(!r.ok)throw Error('font_fixture_missing');return r.arrayBuffer();}};
  };`}));
}}]});
const browser = await chromium.launch({headless:true,
  executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser"});
try {
  const page = await browser.newPage();
  const errors = [], unexpected = [], assets = [], providerFixtures = [], fontRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(()=>{
    window.localFontDraws=[];
    const native=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.localFontDraws.push(String(text));return native.call(this,text,...args);};
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (switching && url.origin !== "https://studio.test") {
      providerFixtures.push(url.hostname);
      return route.fulfill({contentType:"application/json",body:JSON.stringify(url.hostname.includes("mapbox") ? {} :
        {version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"#ffffff"}}]})});
    }
    if (url.origin !== "https://studio.test") { unexpected.push(url.origin); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({contentType:"text/html", body:
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src data: blob:; connect-src https: blob:; worker-src 'self' blob:">
      ${switching ? '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/libre.css"><style>body{margin:0}.opengeo-workbench{height:100vh}</style>' : ''}<script type="module" src="/test.js"></script>`});
    if (switching && /^\/fonts\/(?:[0-9]+-[0-9]+\.pbf|manifest\.json)$/.test(url.pathname)) {
      assert.equal(url.search, "", "Font assets must not receive provider tokens");
      assert.equal(route.request().headers().authorization, undefined);
      fontRequests.push(url.pathname);
      return route.fulfill({contentType:url.pathname.endsWith('.pbf')?'application/octet-stream':'application/json',
        body:await readFile(resolve(root,'src/assets/render-fonts/opengeo-open-sans-v1/1',url.pathname.split('/').pop()))});
    }
    if (url.pathname === "/test.js") return route.fulfill({contentType:"text/javascript",body:bundle.outputFiles[0].text});
    if (switching && url.pathname === "/worker.js") return route.fulfill({contentType:"text/javascript",body:worker});
    if (switching && ["/style.css","/libre.css"].includes(url.pathname)) return route.fulfill({contentType:"text/css",
      body:await readFile(resolve(root,url.pathname === "/style.css" ? "src/style.css" : "node_modules/maplibre-gl/dist/maplibre-gl.css"))});
    const asset = MAPBOX_RUNTIME.assets.find(item => url.pathname === `${MAPBOX_RUNTIME.basePath}${item.name}`);
    if (asset) {
      assets.push(asset.name);
      return route.fulfill({contentType:asset.name.endsWith(".css")?"text/css":"text/javascript",
        body:await readFile(resolve(root,"node_modules/mapbox-gl",asset.source))});
    }
    unexpected.push(url.pathname); return route.abort();
  });
  await page.goto("https://studio.test/");
  await page.waitForFunction(() => typeof window.loadOptionalRenderer === "function");
  assert.deepEqual(assets, [], "Optional SDK must not load on startup");
  if (switching) {
    page.setDefaultTimeout(20000);
    await page.waitForFunction(()=>window.view?.__opengeoMap?.loaded());
    await page.waitForFunction(()=>window.view.__opengeoMap.getLayer('survey-style-0')&&window.view.__opengeoMap.getLayer('survey-names-labels'));
    await page.waitForFunction(()=>window.view.__opengeoMap.queryRenderedFeatures({layers:['survey-names-labels']}).length>0);
    await page.evaluate(()=>{
      window.original=window.view.__opengeoMap;
      original.jumpTo({center:[0,0],zoom:3,bearing:12});
      window.layerSnapshot=JSON.stringify(window.view.__opengeoLayers);
      window.styleSnapshot=JSON.stringify(original.getStyle().layers.filter(layer=>layer.id.startsWith('survey')));
    });
    const panel=page.locator('.gis-renderer-panel');
    await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
    await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
    await panel.getByLabel('Mapbox public token').fill('pk.local-fixture.not-a-real-token');
    await panel.getByRole('button',{name:'Use Mapbox',exact:true}).click();
    try { await panel.getByText('Current: Mapbox',{exact:true}).waitFor(); }
    catch(error) {console.error(JSON.stringify({panel:await panel.innerText(),errors,providerFixtures}));throw error;}
    await page.waitForFunction(()=>window.view.__opengeoMap.queryRenderedFeatures({layers:['survey-names-labels']}).length>0);
    const box=await page.evaluate(()=>{
      const map=window.view.__opengeoMap;
      return {same:map===window.original,removed:window.original._removed,camera:[map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing()],
        layers:JSON.stringify(window.view.__opengeoLayers)===window.layerSnapshot,
        paint:JSON.stringify(map.getStyle().layers.filter(layer=>layer.id.startsWith('survey')))===window.styleSnapshot};
    });
    assert.equal(box.same,false); assert.equal(box.removed,true); assert.equal(box.layers,true); assert.equal(box.paint,true);
    assert.deepEqual(box.camera,[0,0,3,12]);
    await page.getByRole('button',{name:'Open layer properties for Survey names',exact:true}).click();
    await page.locator('.gis-menu-wrap[data-menu=layer] > button').click();
    await page.getByRole('menuitem',{name:'Layer properties',exact:true}).click();
    const showLabels=page.getByLabel('Show labels on map',{exact:true});
    await showLabels.uncheck();
    await page.waitForFunction(()=>!window.view.__opengeoMap.getLayer('survey-names-labels'));
    await showLabels.check();
    await page.waitForFunction(()=>window.view.__opengeoMap.getLayer('survey-names-labels'));
    await page.getByLabel('Prefix',{exact:true}).fill('東京');
    await page.getByLabel('Prefix',{exact:true}).dispatchEvent('change');
    await page.waitForFunction(()=>!window.view.__opengeoMap.getLayer('survey-names-labels'));
    await page.getByLabel('Prefix',{exact:true}).fill('');
    await page.getByLabel('Prefix',{exact:true}).dispatchEvent('change');
    await page.waitForFunction(()=>window.view.__opengeoMap.getLayer('survey-names-labels')&&window.view.__opengeoMap.queryRenderedFeatures({layers:['survey-names-labels']}).length>0);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.view.__opengeoLayers)===window.layerSnapshot),true);
    await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
    await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
    assert.ok(await page.evaluate(()=>window.view.__opengeoMap.queryRenderedFeatures({layers:window.view.__opengeoMap.getStyle().layers.filter(layer=>layer.id.startsWith('survey')).map(layer=>layer.id)}).length)>0,
      'Mapbox must render the retained polygon');
    const pixel=await page.evaluate(()=>{
      const canvas=window.view.__opengeoMap.getCanvas(),gl=canvas.getContext('webgl2'),rgba=new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
      return [...rgba];
    });
    assert.ok(pixel[0]>pixel[1]+20&&pixel[0]>pixel[2]+20&&pixel[3]===255,JSON.stringify({polygonPixel:pixel}));
    assert.equal(await page.locator('canvas').count(),1);
    assert.equal(await page.evaluate(()=>window.view.saveDraftForNavigation()),true);
    const saved=await page.evaluate(()=>Object.values(localStorage).join('\n'));
    assert.ok(saved.includes('opengeoRenderer'),'Browser draft retains renderer preference');
    assert.equal(saved.includes('pk.local-fixture'),false,'Token must never enter the browser draft');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.view.dataset.saveState==='saved');
    const projectSave=await page.evaluate(()=>JSON.parse(localStorage.getItem('renderer-project-fixture')));
    assert.equal(projectSave.extensions.opengeoRenderer.id,'mapbox');
    assert.deepEqual(projectSave.layers[0].styleReference,await page.evaluate(()=>window.pinnedStyle));
    assert.equal(projectSave.layers[0].opacity,0.6);
    assert.equal(projectSave.layerTree[0].title,'Field survey');
    assert.deepEqual(projectSave.layerTree[0].children,[{kind:'layer',layerId:'survey'},{kind:'layer',layerId:'survey-names'}]);
    assert.equal(JSON.stringify(projectSave).includes('pk.local-fixture'),false);
    await page.evaluate(()=>window.mapboxMap=window.view.__opengeoMap);
    await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
    await panel.getByText('Current: MapLibre',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.mapboxMap._removed),true);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.view.__opengeoLayers)===window.layerSnapshot),true);
    await page.waitForFunction(()=>window.view.__opengeoMap.queryRenderedFeatures({layers:['survey-names-labels']}).length>0);
    assert.equal(await page.locator('canvas').count(),1);
    assert.ok(fontRequests.filter(path=>path.endsWith('/0-255.pbf')).length>=2, 'Mapbox fetches the pinned Latin glyphs after verification');
    assert.ok(fontRequests.filter(path=>path.endsWith('/1024-1279.pbf')).length>=2, 'Mapbox fetches pinned Cyrillic glyphs');
    assert.deepEqual(await page.evaluate(()=>window.localFontDraws),[], 'Pinned labels must never fall back to Canvas fonts');
    // Account navigation must release an optional map before awaiting auth config.
    await panel.getByLabel('Mapbox public token').fill('pk.local-fixture.not-a-real-token');
    await panel.getByRole('button',{name:'Use Mapbox',exact:true}).click();
    await panel.getByText('Current: Mapbox',{exact:true}).waitFor();
    await panel.getByLabel('Mapbox public token').fill('pk.unsaved-field.also-clear');
    await page.evaluate(()=>{
      window.accountMap=window.view.__opengeoMap;
      window.logoutPromise=window.auth.signOut();
    });
    assert.equal(await page.evaluate(()=>window.accountMap._removed),true);
    assert.equal(await page.evaluate(()=>window.view.__opengeoMap),null);
    assert.equal(await page.locator('canvas').count(),0);
    assert.equal(await page.evaluate(()=>window.logoutDestination),undefined,'Cleanup precedes the pending auth configuration');
    assert.equal(await panel.getByLabel('Mapbox public token').inputValue(),'');
    assert.equal(await page.evaluate(()=>window.view.saveDraftForNavigation()),true,'A paused map still supports draft recovery');
    const providerCount=providerFixtures.length;
    await page.evaluate(()=>window.rendererAccess=false);
    await page.getByRole('button',{name:'Resume with MapLibre',exact:true}).click();
    await page.getByText('Project access could not be confirmed.',{exact:false}).waitFor();
    assert.equal(await page.locator('canvas').count(),0);
    assert.equal(providerFixtures.length,providerCount,'Denied resume must not restart provider requests');
    await page.evaluate(()=>window.rendererAccess=true);
    await page.getByRole('button',{name:'Resume with MapLibre',exact:true}).click();
    await page.waitForFunction(()=>window.view.__opengeoMap?.loaded());
    await panel.getByText('Current: MapLibre',{exact:true}).waitFor();
    assert.equal(await page.locator('.gis-renderer-paused').count(),0);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.view.__opengeoLayers)===window.layerSnapshot),true);
    assert.deepEqual(await page.evaluate(()=>{const m=window.view.__opengeoMap;return [m.getCenter().lng,m.getCenter().lat,m.getZoom(),m.getBearing()]}),[0,0,3,12]);
    assert.equal(await panel.getByRole('button',{name:'Forget Mapbox token',exact:true}).isDisabled(),true);
    assert.equal((await page.evaluate(()=>Object.values(localStorage).join(''))).includes('pk.'),false);
    await page.evaluate(async()=>{window.finishLogoutConfig();await window.logoutPromise;});
    assert.equal(new URL(await page.evaluate(()=>window.logoutDestination)).hostname,'identity.test');
    await panel.getByLabel('Mapbox public token').fill('pk.local-fixture.not-a-real-token');
    await page.evaluate(()=>{
      window.retained=window.view.__opengeoMap;
      const Native=window.mapboxgl.Map;
      window.mapboxgl.Map=new Proxy(Native,{construct(target,args){
        const map=new target(...args);
        setTimeout(()=>map.fire('error',{error:new Error('fixture failure with pk.local-fixture.not-a-real-token')}),0);
        return map;
      }});
    });
    await panel.getByRole('button',{name:'Use Mapbox',exact:true}).click();
    await panel.getByText('The renderer could not open.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.retained===window.view.__opengeoMap),true);
    assert.equal(await page.locator('canvas').count(),1);
    assert.equal((await panel.innerText()).includes('pk.local-fixture'),false);
    // Reopen through the same definition upgrade and Workbench Save controls.
    // Storage/Style reads are fixtures; this is not API/database persistence proof.
    const sdkRequests=assets.length;
    await page.evaluate(()=>window.reopenProject());
    await page.waitForFunction(()=>window.view?.__opengeoMap?.loaded()&&window.view.__opengeoMap.getLayer('survey-style-0'));
    assert.deepEqual(await page.evaluate(()=>window.view.__opengeoLayers[0].styleReference),projectSave.layers[0].styleReference);
    assert.equal(await page.evaluate(()=>window.view.__opengeoMap.getPaintProperty('survey-style-0','fill-color')),'#ff0000');
    assert.equal(await page.evaluate(()=>window.styleReads.length),2,'Reopening resolves the pinned Style again');
    assert.ok((await page.evaluate(()=>window.styleReads)).every(read=>read.versionNumber===3));
    await page.locator('.gis-menu-wrap[data-menu=view] > button').click();
    await page.getByRole('menuitem',{name:'Rendering engine…',exact:true}).click();
    assert.equal(await panel.getByLabel('Mapbox public token').inputValue(),'');
    await panel.getByText('Current: MapLibre',{exact:true}).waitFor();
    await page.evaluate(()=>window.reopenedMap=window.view.__opengeoMap);
    await panel.getByRole('button',{name:'Use MapLibre',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.view.__opengeoMap===window.reopenedMap),true,'Preference-only changes do not recreate the map');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.view.dataset.saveState==='saved');
    const updatedSave=await page.evaluate(()=>JSON.parse(localStorage.getItem('renderer-project-fixture')));
    assert.equal(updatedSave.extensions.opengeoRenderer.id,'maplibre');
    assert.deepEqual(updatedSave.extensions.fixture,projectSave.extensions.fixture);
    assert.deepEqual(updatedSave.layers,projectSave.layers);
    assert.deepEqual(updatedSave.layerTree,projectSave.layerTree);
    assert.equal(assets.length,sdkRequests,'Reopening/fallback must not load the optional runtime');
    assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[]);
    console.log(JSON.stringify({status:'pass',switchAwayBack:true,canonicalLayers:true,paint:true,camera:true,disposedOldMaps:true,
      renderedFeatures:true,pinnedLabelsAcrossBothEngines:true,mapboxLabelEditingAndUnsupportedGlyphSuppression:true,fontRequests:fontRequests.length,localFontFallback:false,polygonPixel:pixel,tokenFreeDraft:true,failedSwitchRetainsMap:true,
      fixtureSaveReopen:true,pinnedStyleVersion:3,folderRetained:true,preferenceResetWithoutMapReload:true,
      signoutDisposesBeforeAuthWait:true,credentialInputCleared:true,pausedDraftRecovery:true,deniedResumeNoRequests:true,authorizedResumeRetainsCamera:true,
      externalRequests:0,providerFixtures:providerFixtures.length,limits:'Offline SDK render/switch; provider authorization and live Project persistence not claimed.'}));
  } else {
  assert.deepEqual(await page.evaluate(() => window.loadOptionalRenderer()),
    {id:"mapbox",version:MAPBOX_RUNTIME.version,cleared:true});
  await page.evaluate(() => window.loadOptionalRenderer());
  assert.deepEqual(assets.sort(), ["mapbox-gl.css","mapbox-gl.js"]);
  assert.equal(await page.locator("canvas").count(),0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({status:"pass",version:MAPBOX_RUNTIME.version,lazy:true,
    integrityChecked:true,sdkFetches:2,externalRequests:0,mapInstances:0,
    limits:"SDK loading only; engine switching and provider authorization remain unverified."}));
  }
} finally { await browser.close(); }
