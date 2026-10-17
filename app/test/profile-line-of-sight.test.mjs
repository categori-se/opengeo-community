import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {analyzeProfileLineOfSight, createPathMeasurement, LINE_OF_SIGHT_LIMITS, profileLineOfSightJSON} from "../src/lib/pathMeasurement.js";
import {meanRadiusMeters, spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {ProfileLineOfSight} from "../src/components/ProfileLineOfSight.js";

const source = {sourceId:"synthetic-terrain",provider:"Synthetic numerical fixture",queryMode:"renderer-unexaggerated-point-sample",
  termsUrl:"https://example.org/terms",observedAt:"2026-10-16"};
function profile({coordinates=[[0,0],[0.01,0]],elevationAt=()=>0}={}) {
  return createPathMeasurement({id:"sight-line",title:"Saved sight line",coordinates,elevationAt,terrainSource:source});
}

if (process.env.OPEN_GEO_LINE_OF_SIGHT_BROWSER === "1") {
  await checkBrowser();
  process.exit(0);
}
if (process.env.OPEN_GEO_LINE_OF_SIGHT_DIST) {
  await checkCompiledWorkbench();
  process.exit(0);
}

it("matches a flat section and an analytical ridge, preserving exact saved input", () => {
  const input=profile(),before=JSON.stringify(input);
  const flat=analyzeProfileLineOfSight(input,{curvature:false,observerHeightMeters:10,targetHeightMeters:10,uncertaintyMeters:0});
  assert.equal(flat.status,"sampled-clear");assert.equal(flat.minimumClearanceMeters,10);assert.equal(flat.uncertaintyResult,"clear-within-bound");
  assert(flat.samples.every(s=>s.rayElevationMeters===10));assert.equal(JSON.stringify(input),before);assert.notEqual(flat.input,input);
  const ridge=analyzeProfileLineOfSight(profile({elevationAt:([lon])=>lon>0.002&&lon<0.008?20:0}),
    {curvature:false,observerHeightMeters:10,targetHeightMeters:10,uncertaintyMeters:2});
  assert.equal(ridge.status,"sampled-obstruction");assert.equal(ridge.minimumClearanceMeters,-10);assert.equal(ridge.uncertaintyResult,"obstructed-within-bound");
  assert.deepEqual(flat.input.terrainProfile.source,source);
});

it("matches the independent cosine expression for a chord over a mean sphere", () => {
  const input=profile(),radius=meanRadiusMeters(spatialBodyDefinition()),height=10;
  const result=analyzeProfileLineOfSight(input,{observerHeightMeters:height,targetHeightMeters:height});
  const theta=input.horizontalDistanceMeters/radius;
  for (const s of result.samples) {
    const phi=s.distanceMeters/radius,expected=(radius+height)*Math.cos(theta/2)/Math.cos(phi-theta/2)-radius;
    assert(Math.abs(s.rayElevationMeters-expected)<1e-6);
  }
  const long=profile({coordinates:[[0,0],[0.5,0]]});
  assert.equal(analyzeProfileLineOfSight(long,{observerHeightMeters:2,targetHeightMeters:2}).status,"sampled-obstruction");
  assert.equal(analyzeProfileLineOfSight(long,{observerHeightMeters:2,targetHeightMeters:2,curvature:false}).status,"sampled-clear");
});

it("reports uncertainty bounds, grazing and unknown accuracy without inventing confidence", () => {
  const input=profile();
  const unknown=analyzeProfileLineOfSight(input,{curvature:false,observerHeightMeters:2,targetHeightMeters:2});
  assert.equal(unknown.uncertaintyResult,"not-evaluated");assert.equal(unknown.model.verticalAccuracy,"provider-not-declared");
  const uncertain=analyzeProfileLineOfSight(input,{curvature:false,observerHeightMeters:2,targetHeightMeters:2,uncertaintyMeters:2});
  assert.equal(uncertain.uncertaintyResult,"uncertain");
  assert(uncertain.samples.filter(s=>s.interior).every(s=>s.minimumClearanceMeters===-2&&s.maximumClearanceMeters===6));
  assert.equal(analyzeProfileLineOfSight(input,{curvature:false,observerHeightMeters:0,targetHeightMeters:0}).status,"grazing");
});

it("refuses to infer visibility through missing, endpoint-only or off-axis samples", () => {
  assert.equal(analyzeProfileLineOfSight(profile({elevationAt:()=>null})).reason,"missing-elevation-samples");
  assert.equal(analyzeProfileLineOfSight(profile({coordinates:[[0,0],[0.001,0]]})).reason,"no-interior-samples");
  const diagonal=analyzeProfileLineOfSight(profile({coordinates:[[0,45],[0.5,45.5]]}));
  assert.equal(diagonal.reason,"samples-outside-sight-axis");assert.equal(diagonal.status,"incomplete");assert.equal(diagonal.minimumClearanceMeters,null);
  const dateLine=analyzeProfileLineOfSight(profile({coordinates:[[179.99,0],[-179.99,0]]}));assert.notEqual(dateLine.status,"incomplete");
});

it("bounds inputs and rejects forged profiles or unsupported routes", () => {
  for(const options of [{observerHeightMeters:Infinity},{targetHeightMeters:-1},{uncertaintyMeters:NaN},{uncertaintyMeters:1001},{curvature:"yes"}]) {
    assert.throws(()=>analyzeProfileLineOfSight(profile(),options));
  }
  const forged=structuredClone(profile());forged.terrainProfile.samples[1].distanceMeters+=10;
  assert.throws(()=>analyzeProfileLineOfSight(forged));
  assert.throws(()=>analyzeProfileLineOfSight(profile({coordinates:[[0,0],[0.01,0],[0.02,0]]})));
  assert.throws(()=>analyzeProfileLineOfSight(profile({coordinates:[[0,0],[1,0]]})),/line_of_sight_distance_limit/);
  const result=analyzeProfileLineOfSight(profile());assert(new TextEncoder().encode(JSON.stringify(result)).length<LINE_OF_SIGHT_LIMITS.maximumExportBytes);
});

it("actual component calculates, exports, invalidates edited options and preserves the saved profile", () => {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    const input=profile(),before=JSON.stringify(input),downloads=[];
    const view=ProfileLineOfSight(input,{onDownload:body=>downloads.push(JSON.parse(body))});dom.window.document.body.append(view);
    const form=view.querySelector("form"),fields=view.querySelectorAll('input[type="number"]'),download=[...view.querySelectorAll("button")].at(-1);
    assert.equal(download.disabled,true);assert.equal(downloads.length,0);
    fields[0].value="10";fields[1].value="10";fields[2].value="2";
    form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    assert.match(view.textContent,/Clear at sampled terrain/);download.click();assert.equal(downloads.length,1);
    assert.equal(downloads[0].options.observerHeightMeters,10);assert.deepEqual(downloads[0].input.terrainProfile.source,source);
    fields[0].value="20";fields[0].dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    assert.equal(download.disabled,true);assert.equal(view.querySelector('section').textContent,"");download.click();assert.equal(downloads.length,1);
    assert.equal(JSON.stringify(input),before);
  } finally {globalThis.document=previous;dom.window.close();}
});

it("exports reproducible validated records and rejects credential-bearing source terms links", () => {
  const result=analyzeProfileLineOfSight(profile());
  result.extraSecret="must not export";result.minimumClearanceMeters=123456;
  const json=profileLineOfSightJSON(result),record=JSON.parse(json);
  assert.equal(record.extraSecret,undefined);assert.notEqual(record.minimumClearanceMeters,123456);
  assert.equal(profileLineOfSightJSON(record),json);
  for (const query of ["?api_key=not-for-export", "?%61%70%69%5F%6B%65%79=not-for-export", "?X-Amz-Credential=not-for-export"]) {
    const privateSource=structuredClone(profile());privateSource.terrainProfile.source.termsUrl+=query;
    const analysis=analyzeProfileLineOfSight(privateSource);
    assert.throws(()=>profileLineOfSightJSON(analysis),/line_of_sight_private_source_url/);
  }
});

async function checkBrowser() {
  const {build}=await import("esbuild"),{chromium}=await import("playwright");
  const {readFile,writeFile,mkdir}=await import("node:fs/promises"),{resolve}=await import("node:path");
  const {createHash}=await import("node:crypto");
  const area=resolve(process.env.OPEN_GEO_LINE_OF_SIGHT_OUTPUT ?? ".local-archives/renderer-switch-20260930/profile-line-of-sight-20261016/browser");
  await mkdir(area,{recursive:true});
  const workbench=await readFile(new URL("../src/components/WorkbenchView.js",import.meta.url),"utf8");
  const start=workbench.indexOf("function downloadBlob(filename, content, type) {"),end=workbench.indexOf("\nfunction slug(",start);
  assert(start>=0&&end>start);const downloadHelper=workbench.slice(start,end);
  const bundled=await build({stdin:{resolveDir:new URL("../",import.meta.url).pathname,contents:`
    import {ProfileLineOfSight} from './src/components/ProfileLineOfSight.js';
    ${downloadHelper}
    document.querySelector('section').append(ProfileLineOfSight(${JSON.stringify(profile())},
      {onDownload:body=>downloadBlob('profile-line-of-sight.json',body,'application/json')}));
  `},bundle:true,format:"esm",write:false,platform:"browser"});
  const js=bundled.outputFiles[0].contents,css=await readFile(new URL("../src/style.css",import.meta.url));
  const html=Buffer.from(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css">
    <style>body{margin:0}.opengeo-workbench{display:block;height:auto;min-height:0;max-width:370px;margin:0 auto;padding:12px;box-sizing:border-box}.gis-panel{height:auto;overflow:visible}</style>
    <main class="opengeo-workbench" data-color-mode="light"><section class="gis-panel"></section></main><script type="module" src="/bundle.mjs"></script>`);
  const resources=new Map([["/",{body:html,type:"text/html"}],["/style.css",{body:css,type:"text/css"}],["/bundle.mjs",{body:js,type:"text/javascript"}]]);
  const prior=await readFile(resolve(area,"attempt-1/receipt.json"),"utf8").then(JSON.parse).catch(()=>({GETs:0,bytes:0,elapsedMilliseconds:0}));
  const receipt={status:"started",limits:{GETs:6,bytes:2*1024*1024,seconds:20},GETs:prior.GETs,bytes:prior.bytes,AWS:0,API:0,providerRequests:0,errors:[],
    actualComponent:true,WorkbenchHost:false,fullBuild:false,downloadHelperSHA256:createHash("sha256").update(downloadHelper).digest("hex"),
    componentBundleSHA256:createHash("sha256").update(js).digest("hex"),CSSSHA256:createHash("sha256").update(css).digest("hex")};
  const begun=Date.now(),browser=await chromium.launch({headless:true,executablePath:"/usr/bin/chromium-browser",args:["--no-sandbox"]});
  try {
    const context=await browser.newContext({viewport:{width:390,height:1100},serviceWorkers:"block",acceptDownloads:true});
    await context.route("**/*",async route=>{
      const url=new URL(route.request().url());if(url.protocol==="blob:")return route.continue();
      assert.equal(url.origin,"https://profile.test");assert.equal(route.request().method(),"GET");
      const r=resources.get(url.pathname);assert(r);assert(++receipt.GETs<=receipt.limits.GETs);receipt.bytes+=r.body.length;
      assert(receipt.bytes<=receipt.limits.bytes&&prior.elapsedMilliseconds+Date.now()-begun<receipt.limits.seconds*1000);
      return route.fulfill({body:Buffer.from(r.body),contentType:r.type});
    });
    const page=await context.newPage();page.setDefaultTimeout(8000);page.on("pageerror",error=>receipt.errors.push(error.message));
    await page.goto("https://profile.test/");await page.locator("summary").click();
    await page.getByLabel("Observer height above ground (m)",{exact:true}).fill("10");
    await page.getByLabel("Target height above ground (m)",{exact:true}).fill("10");
    await page.getByLabel("Elevation uncertainty ± (m, optional)",{exact:true}).fill("2");
    await page.getByRole("button",{name:"Calculate line of sight",exact:true}).click();
    await page.getByText("Clear at sampled terrain",{exact:true}).waitFor();
    const pending=page.waitForEvent("download");await page.getByRole("button",{name:"Download analysis JSON",exact:true}).click();
    const download=await pending;await download.saveAs(resolve(area,"analysis.json"));
    const exported=await readFile(resolve(area,"analysis.json"),"utf8"),record=JSON.parse(exported);
    assert.equal(record.options.observerHeightMeters,10);assert.equal(record.uncertaintyResult,"clear-within-bound");assert.equal(profileLineOfSightJSON(record),exported);
    receipt.actualDownloadBytes=Buffer.byteLength(exported);receipt.downloadReproduces=true;
    for(const mode of ["light","dark"]) {
      await page.locator("main").evaluate((node,mode)=>node.dataset.colorMode=mode,mode);
      assert(await page.locator('input[type="number"]').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().right<=innerWidth)));
      await page.screenshot({path:resolve(area,`${mode}.png`)});
    }
    await page.getByLabel("Observer height above ground (m)",{exact:true}).fill("20");
    assert(await page.getByRole("button",{name:"Download analysis JSON",exact:true}).isDisabled());
    assert.deepEqual(receipt.errors,[]);receipt.status="passed-actual-profile-component-and-JSON-download";
  } catch(error) {receipt.status="stopped";receipt.failure=error.message;throw error;}
  finally {await browser.close();receipt.browserClosed=true;receipt.elapsedMilliseconds=prior.elapsedMilliseconds+Date.now()-begun;await writeFile(resolve(area,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");}
}

async function checkCompiledWorkbench() {
  const {chromium}=await import("playwright"),{readFile,writeFile,mkdir}=await import("node:fs/promises");
  const {resolve,dirname}=await import("node:path"),{createHash}=await import("node:crypto");
  const dist=resolve(process.env.OPEN_GEO_LINE_OF_SIGHT_DIST),area=dirname(dirname(dist)),output=resolve(process.env.OPEN_GEO_LINE_OF_SIGHT_COMPILED_OUTPUT??resolve(area,"../compiled-browser"));
  await mkdir(output,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(area,"dist/opengeo-studio-build.json"),"utf8"));
  const files=new Map(manifest.artifactTree.files.map(f=>["/"+f.path,f]));
  const modulePath=name=>"/"+manifest.artifactTree.files.find(f=>f.path.startsWith("_import/"+name+".")&&f.path.endsWith(".js")).path;
  const shell=await readFile(resolve(dist,"workspaces.html"),"utf8");
  const styles=[...shell.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join("");
  const original=profile();
  const faceMode=process.env.OPEN_GEO_MEASUREMENT_3D === "1";
  const styleSource=process.env.OPEN_GEO_MEASUREMENT_3D_STYLE_FIXTURE;
  const initial=styleSource?JSON.parse(await readFile(styleSource,'utf8')):{schemaVersion:'opengeo.map-definition.1.3.0',layers:[],mapViews:[{center:[.005,0],zoom:13}],basemaps:[],colorMode:'light',measurements:[original]};
  const html=`<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">
    import {WorkbenchView} from '${modulePath("components/WorkbenchView")}';
    import {upgradeMapDefinition} from '${modulePath("lib/mapDefinition")}';
    window.mount=definition=>{
      document.querySelector('#root').replaceChildren(WorkbenchView({workspace:{workspaceId:'70000000-0000-4000-8000-000000000012',name:'Terrain analysis'},role:'owner',
        project:upgradeMapDefinition(definition),layers:definition.layers,restoreBrowserDraft:false,persistenceMode:'fixture',
        saveProject:async definition=>{window.saved=JSON.parse(JSON.stringify(definition));return{id:'70000000-0000-4000-8000-000000000013',version:1,definition:window.saved};}}));
    };
    mount(${JSON.stringify(initial)});
  </script>`;
  const receipt={status:"started",limits:{GETs:240,bytes:16*1024*1024,seconds:60,saves:1},softwareGETs:0,softwareBytes:0,
    AWS:0,API:0,providerRequests:0,blankBasemapSubstitutes:0,errors:[],saves:0,buildTree:manifest.artifactTree.digest};
  const begun=Date.now(),browser=await chromium.launch({headless:true,executablePath:"/usr/bin/chromium-browser",args:["--no-sandbox","--enable-unsafe-swiftshader"]});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block",acceptDownloads:true});
    await context.route("**/*",async route=>{
      const url=new URL(route.request().url());if(["blob:","data:"].includes(url.protocol))return route.continue();
      assert(Date.now()-begun<receipt.limits.seconds*1000);assert.equal(route.request().method(),"GET");
      if(url.origin==="https://tiles.openfreemap.org"&&url.pathname.startsWith("/styles/")) {
        receipt.blankBasemapSubstitutes++;return route.fulfill({contentType:"application/json",body:JSON.stringify({version:8,sources:{},layers:[{id:"background",type:"background",paint:{"background-color":"#eef2f4"}}]})});
      }
      assert.equal(url.origin,"https://compiled-profile.test");
      if(url.pathname==="/")return route.fulfill({contentType:"text/html",body:html});
      const file=files.get(decodeURIComponent(url.pathname));assert(file,"Unexpected software request: "+url.pathname);
      assert(++receipt.softwareGETs<=receipt.limits.GETs);receipt.softwareBytes+=file.bytes;assert(receipt.softwareBytes<=receipt.limits.bytes);
      const bytes=await readFile(resolve(dist,file.path));assert.equal(createHash("sha256").update(bytes).digest("hex"),file.sha256);
      return route.fulfill({body:bytes,contentType:file.path.endsWith(".css")?"text/css":file.path.endsWith(".json")?"application/json":"text/javascript"});
    });
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on("pageerror",error=>receipt.errors.push(error.message));
    await page.goto("https://compiled-profile.test/");
    const openMeasure=async()=>{
      await page.getByRole("button",{name:"Controls",exact:true}).click();
      await page.getByRole("menuitem",{name:"Measure line",exact:true}).click();
      await page.locator(".gis-panel-right").getByRole("button",{name:"Cancel",exact:true}).click();
      if(!faceMode)await page.locator(".gis-profile-line-of-sight summary").click();
    };
    receipt.stage="Open saved measurement through Controls";await openMeasure();
    if(faceMode) {
      const fixture=JSON.parse(await readFile(new URL('../../fixtures/map-measurements/polygon-3d.json',import.meta.url))),coordinates=fixture.cases[0].coordinates;
      let face,dialog;
      if(!styleSource) {
      receipt.stage='Create actual3Dface from Controls and explicitXYZ';
      await page.getByRole('button',{name:'3D polygon',exact:true}).click();
      dialog=page.getByRole('dialog',{name:'New 3D polygon',exact:true});await dialog.waitFor();
      await dialog.getByLabel('Measurement title',{exact:true}).fill('Vertical face');
      await dialog.getByLabel('Elevation source',{exact:true}).fill('Analytic wall reference');
      await dialog.getByLabel('Vertical datum',{exact:true}).fill('Mean sphere radial elevation');
      await dialog.getByLabel('Elevation uncertainty ± (m, optional)',{exact:true}).fill('2');
      await dialog.getByRole('button',{name:'Add vertex',exact:true}).click();
      for(let i=0;i<coordinates.length;i++)for(let k=0;k<3;k++)await dialog.getByLabel(`Vertex ${i+1} ${['longitude','latitude','elevation'][k]}`,{exact:true}).fill(String(coordinates[i][k]));
      await dialog.getByRole('button',{name:'Preview measurement',exact:true}).click();
      await dialog.getByText('3D polygon ready. Elevations and datum are recorded as supplied.',{exact:true}).waitFor();
      assert.equal(await dialog.locator('svg polygon').count(),2);
      await dialog.getByRole('button',{name:'Save measurement',exact:true}).click();await dialog.waitFor({state:'hidden'});
      const card=page.locator('.gis-measurement-card').filter({has:page.getByText('Vertical face',{exact:true})});
      await card.getByRole('button',{name:'Edit',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit 3D polygon',exact:true});
      await dialog.getByLabel('Vertex 4 elevation',{exact:true}).fill('110');
      await dialog.getByRole('button',{name:'Preview measurement',exact:true}).click();
      await dialog.getByText('3D polygon ready. Elevations and datum are recorded as supplied.',{exact:true}).waitFor();
      receipt.stage='Actual3DGeoJSONdownload then retained edited face';
      const pending=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download 3D GeoJSON',exact:true}).click();
      const download=await pending;await download.saveAs(resolve(output,'face.geojson'));
      const bytes=await readFile(resolve(output,'face.geojson')),exported=JSON.parse(bytes);face=exported.opengeo.measurement;
      assert.equal(face.coordinates[3][2],110);assert(Math.abs(face.summary.areaSquareMeters-5250)<.01);assert(face.bounds);
      receipt.actualDownloadBytes=bytes.length;receipt.actualFaceArea=face.summary.areaSquareMeters;
      await dialog.getByRole('button',{name:'Save measurement',exact:true}).click();await dialog.waitFor({state:'hidden'});
      await page.getByRole('button',{name:'Save',exact:true}).first().click();await page.waitForFunction(()=>window.saved);receipt.saves++;
      const saved=await page.evaluate(()=>window.saved);assert.equal(saved.schemaVersion,'opengeo.map-definition.1.6.0');assert.deepEqual(saved.measurements,[original,face]);
      await writeFile(resolve(output,'saved-definition.json'),JSON.stringify(saved,null,2)+'\n');
      receipt.stage='Fresh1.6Workbench reopen, exact vertices/source, light/dark narrow editor';
      await page.evaluate(()=>mount(saved));await openMeasure();
      }else face=initial.measurements.find(m=>m.kind==='polygon-3d');
      const reopened=page.locator(`[data-measurement-id="${face.id}"]`);
      for(const theme of ['light','dark']) {
        if(theme==='dark')await page.getByRole('button',{name:'Dark',exact:true}).first().click();
        await reopened.getByRole('button',{name:'Edit',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit 3D polygon',exact:true});
        assert.equal(await dialog.getByLabel('Vertex 4 elevation',{exact:true}).inputValue(),'110');assert.equal(await dialog.getByLabel('Elevation source',{exact:true}).inputValue(),'Analytic wall reference');
        await page.setViewportSize({width:390,height:844});
        await dialog.getByRole('button',{name:'Preview measurement',exact:true}).click();
        await dialog.getByText('3D polygon ready. Elevations and datum are recorded as supplied.',{exact:true}).waitFor();
        assert(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
        const ratios=await dialog.evaluate(node=>{
          const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ink=canvas.getContext('2d');
          const rgb=color=>{ink.clearRect(0,0,1,1);ink.fillStyle=color;ink.fillRect(0,0,1,1);return [...ink.getImageData(0,0,1,1).data];};
          const luminance=values=>values.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
          return [node,...['input','label','h2','td[data-field]'].map(selector=>node.querySelector(selector))].map(element=>{const foreground=rgb(getComputedStyle(element).color);let parent=element,background=rgb(getComputedStyle(parent).backgroundColor);while(background[3]<255&&parent.parentElement){parent=parent.parentElement;background=rgb(getComputedStyle(parent).backgroundColor);}const a=luminance(foreground),b=luminance(background);return{element:element.tagName,foreground,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
        });
        assert(ratios.every(r=>r.background[3]===255&&r.ratio>=4.5));(receipt.themeContrast??=[]).push({theme,samples:ratios});
        await page.screenshot({path:resolve(output,`face-editor-${theme}.png`)});
        await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1440,height:1000});
      }
      assert.deepEqual(receipt.errors,[]);receipt.status=styleSource?'passed-compiled-3Dface-editor-light-dark-contrast-layout':'passed-compiled-3Dface-edit-export-ProjectfixtureSave-freshreopen';
      receipt.persistence=styleSource?'Style-only reuse of accepted1.6fixture;0saves and no repeated numerical/download journey.':'Actual compiled UI and native1.6 fixtureSave/freshreopen; APIvalidation and hostedauthorization/persistence remain separate.';return;
    }
    await page.getByLabel("Observer height above ground (m)",{exact:true}).fill("10");
    await page.getByLabel("Target height above ground (m)",{exact:true}).fill("10");
    await page.getByLabel("Elevation uncertainty ± (m, optional)",{exact:true}).fill("2");
    const beforeAnalysis={GETs:receipt.softwareGETs,bytes:receipt.softwareBytes};
    await page.getByRole("button",{name:"Calculate line of sight",exact:true}).click();
    await page.getByText("Clear at sampled terrain",{exact:true}).waitFor();
    const pending=page.waitForEvent("download");await page.getByRole("button",{name:"Download analysis JSON",exact:true}).click();
    const download=await pending;await download.saveAs(resolve(output,"analysis.json"));
    const exported=await readFile(resolve(output,"analysis.json"),"utf8"),record=JSON.parse(exported);
    assert.equal(profileLineOfSightJSON(record),exported);assert.deepEqual(record.input,original);
    receipt.actualDownloadBytes=Buffer.byteLength(exported);receipt.analysisNetworkReads=receipt.softwareGETs-beforeAnalysis.GETs;
    assert.equal(receipt.analysisNetworkReads,0);await page.screenshot({path:resolve(output,"measurement-analysis.png")});
    receipt.stage="Save fixture and fresh Workbench reopen with exact saved profile";
    await page.getByRole("button",{name:"Save",exact:true}).first().click();await page.waitForFunction(()=>window.saved);receipt.saves++;
    const saved=await page.evaluate(()=>window.saved);assert.deepEqual(saved.measurements,[original]);
    assert.equal(JSON.stringify(saved).includes("profile-line-of-sight"),false);
    await page.evaluate(()=>mount(saved));await openMeasure();
    await page.getByRole("button",{name:"Calculate line of sight",exact:true}).click();
    await page.locator(".gis-profile-line-of-sight section dl").waitFor();
    assert.deepEqual(receipt.errors,[]);receipt.status="passed-compiled-Workbench-measurement-LOS-download-save-fresh-reopen";
    receipt.persistence="Fixture Save callback; unchanged saved profile and actual fresh Workbench. No hosted account/provider/persistence claim.";
  } catch(error) {
    receipt.status="stopped";receipt.failure=error.message;
    const page=browser.contexts().flatMap(c=>c.pages())[0];
    if(page){receipt.visibleText=(await page.locator("body").innerText()).slice(-3500);await page.screenshot({path:resolve(output,"stopped.png")});}
    throw error;
  } finally {await browser.close();receipt.browserClosed=true;receipt.elapsedMilliseconds=Date.now()-begun;await writeFile(resolve(output,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");}
}
