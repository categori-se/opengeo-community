// Focused production-component/browser acceptance. No API or deployment claim.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(app, "dist");
const output = await mkdtemp(`${tmpdir()}/opengeo-map-font-browser-`);
const origin = "https://opengeo-font-browser.invalid";
const artifact = async (directory, name) => `/${directory}/${(await readdir(resolve(dist, directory))).find(file => file.startsWith(`${name}.`) && file.endsWith(".js"))}`;
const workbenchModule = await artifact("_import/components", "WorkbenchView");
const attachmentModule = await artifact("_import/lib", "mapFontAttachments");
const contentTypes = {js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", pbf: "application/x-protobuf", txt: "text/plain"};
const seen = [], denied = [], errors = [];
let corruptGlyphs = false;
let browser, page;
try {
  browser = await chromium.launch({executablePath: "/usr/bin/chromium-browser", headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-networking", "--disable-dev-shm-usage"]});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1, serviceWorkers: "block"});
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    seen.push(url.pathname);
    if (url.origin !== origin) { denied.push(url.href); return route.abort("blockedbyclient"); }
    if (url.pathname === "/") return route.fulfill({contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css"><style>html,body{margin:0;height:100%;background:#061526;color:white}.opengeo-workbench{height:100vh}</style><script type="module">
      import {WorkbenchView} from '${workbenchModule}';
      import {mapFontAttachments} from '${attachmentModule}';
      const datasetId='80000000-0000-4000-8000-000000000088';
      const projectId='50000000-0000-4000-8000-000000000088';
      const mapId='60000000-0000-4000-8000-000000000088';
      const versionId='81000000-0000-4000-8000-000000000088';
      const data={type:'FeatureCollection',features:[
        {type:'Feature',properties:{name:'MiXeD Café Ω'},geometry:{type:'Point',coordinates:[-25,10]}},
        {type:'Feature',properties:{name:'Москва\\nΔέλτα'},geometry:{type:'Point',coordinates:[25,-10]}}
      ]};
      const initial={schemaVersion:'opengeo.map-definition.1.3.0',mapViews:[{id:'default',title:'Default',center:[0,0],zoom:2,pitch:0,bearing:0}],
        basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:'names',
        layers:[{layerId:'names',datasetId,datasetVersionId:versionId,sourceVersion:1,title:'Named locations',sourceType:'governed-dataset',
          geometryType:'Point',visible:true,opacity:1,order:0,style:{circleColor:'#e76f51',circleRadius:7},labels:{enabled:true,field:'name',size:18,color:'#ffffff',haloColor:'#061526',haloWidth:1.2,prefix:'[',suffix:']'}}]};
      window.fontProbe={saves:[],sourceReads:0,localGlyphs:0};
      const fill=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(...args){fontProbe.localGlyphs++;return fill.apply(this,args);};
      window.openMap=()=>{
        const definition=JSON.parse(sessionStorage.getItem('saved-map')||'null')||initial;
        if (new URL(location.href).searchParams.has('hiddenLegacy')) definition.layers.push({
          ...initial.layers[0],layerId:'legacy-hidden',title:'Hidden legacy names',visible:false,labels:{enabled:true,field:'name'}});
        const shell=WorkbenchView({workspace:{workspaceId:projectId,title:'Font acceptance'},project:definition,layers:definition.layers,
          role:'owner',mapVersion:1,persistenceMode:'api',mapFontAttachments,
          datasets:[{datasetId,title:'Names',sourceType:'upload',currentVersionId:versionId,currentVersionNumber:1,geometryType:'Point',status:'active'}],
          loadDatasetVersionPreview:async(_dataset,version)=>{fontProbe.sourceReads++;return{datasetVersionId:version,numberReturned:2,numberMatched:2,mayBeTruncated:false,geojson:data};},
          saveProject:async(definition)=>{fontProbe.saves.push(definition);sessionStorage.setItem('saved-map',JSON.stringify(definition));return{id:mapId,version:2,definition};}});
        document.body.append(shell);window.shell=shell;
      };
      openMap();
    </script>`});
    try {
      const path = url.pathname === "/style.css" ? resolve(app, "src/style.css")
        : url.pathname === "/maplibre.css" ? resolve(app, "node_modules/maplibre-gl/dist/maplibre-gl.css")
          : resolve(dist, `.${url.pathname}`);
      if (!path.startsWith(`${dist}/`) && ![resolve(app, "src/style.css"), resolve(app, "node_modules/maplibre-gl/dist/maplibre-gl.css")].includes(path)) throw new Error("outside_bundle");
      await route.fulfill({contentType: contentTypes[path.split(".").at(-1)] ?? "application/octet-stream",
        body: corruptGlyphs && path.endsWith(".pbf") ? Buffer.from([0]) : await readFile(path)});
    } catch { denied.push(url.href); await route.abort("blockedbyclient"); }
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.stack ?? String(error)));
  await page.goto(origin);
  await page.waitForFunction(() => window.shell?.__opengeoMap?.isStyleLoaded() && shell.__opengeoMap.getLayer('names-labels'));
  assert.equal(await page.evaluate(() => shell.__opengeoMap.getGlyphs() ?? null), null);
  assert.equal(seen.filter(path => path.includes("render-fonts")).length, 0, "Legacy inspection fetches no pinned font files");
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  await page.locator(".gis-menu-wrap[data-menu=layer] > button").click();
  await page.getByRole("menuitem", {name:"Layer properties", exact:true}).click();
  const adopt = page.getByRole("button", {name:"Use Open Sans v1 for this map’s enabled labels",exact:true});
  await adopt.click();
  await page.waitForFunction(() => shell.__opengeoMap.getLayer('names-labels') && shell.__opengeoMap.getLayoutProperty('names-labels','text-font')?.[0] === 'OpenGeo Open Sans v1');
  await page.waitForFunction(() => shell.__opengeoMap.isStyleLoaded() && !shell.__opengeoMap.isMoving());
  await page.evaluate(() => { fontProbe.localGlyphs = 0; shell.__opengeoMap.triggerRepaint(); });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0);
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  const names = await page.evaluate(() => shell.__opengeoMap.queryRenderedFeatures({layers:['names-labels']}).map(feature => feature.properties.name));
  assert.ok(names.includes("MiXeD Café Ω"));
  assert.ok(names.includes("Москва\nΔέλτα"));
  await page.getByRole("button",{name:"Save",exact:true}).click();
  await page.waitForFunction(() => fontProbe.saves.length === 1);
  const saved = await page.evaluate(() => fontProbe.saves[0]);
  assert.equal(saved.layers[0].labels.fontRef.id, "opengeo-open-sans-v1");
  assert.equal(saved.layers[0].labels.prefix, "[");
  await page.screenshot({path:resolve(output,"adopted.png")});
  await page.reload();
  await page.waitForFunction(() => window.shell?.__opengeoMap?.isStyleLoaded() && shell.__opengeoMap.getLayer('names-labels'));
  assert.deepEqual(await page.evaluate(() => shell.__opengeoLayers[0].labels.fontRef), saved.layers[0].labels.fontRef);
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0, "Reopened pinned labels never fall back to local font rendering");
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  await page.screenshot({path:resolve(output,"reopened.png")});
  // A failed read on reopen is visible even when no layer inspector is open.
  const collapse = page.getByRole("button", {name: "Collapse inspector", exact: true});
  if (await collapse.count()) await collapse.click();
  corruptGlyphs = true;
  await page.reload();
  await page.locator(".gis-statusbar [data-status-field=message]").filter({hasText:"Labels unavailable — open Layer Properties."}).waitFor();
  assert.equal(await page.getByRole("button", {name: "Retry pinned font read", exact: true}).count(), 0);
  assert.equal(await page.evaluate(() => Boolean(shell.__opengeoMap.getLayer('names-labels'))), false);
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0);
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  await page.screenshot({path:resolve(output,"unavailable.png")});
  corruptGlyphs = false;
  await page.locator(".gis-menu-wrap[data-menu=layer] > button").click();
  await page.getByRole("menuitem", {name:"Layer properties", exact:true}).click();
  await page.getByRole("button", {name: "Retry pinned font read", exact: true}).click();
  await page.waitForFunction(() => shell.__opengeoMap.isStyleLoaded() && shell.__opengeoMap.getLayer('names-labels'));
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0);
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  await page.getByLabel("Suffix", {exact:true}).fill("😀");
  await page.getByLabel("Suffix", {exact:true}).press("Tab");
  await page.locator(".gis-map-font-status").getByText(/does not contain character U\+1F600/).waitFor();
  await page.waitForFunction(() => !shell.__opengeoMap.getLayer('names-labels'));
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0);
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  // Hidden legacy occurrences do not suppress visible pinned labels. Revealing
  // one restores its unspecified font before any legacy symbols become visible.
  await page.goto(`${origin}/?hiddenLegacy=1`);
  await page.waitForFunction(() => window.shell?.__opengeoMap?.isStyleLoaded() && shell.__opengeoMap.getLayer('names-labels'));
  assert.equal(await page.evaluate(() => Boolean(shell.__opengeoMap.getLayer('legacy-hidden-labels'))), false);
  assert.equal(await page.evaluate(() => fontProbe.localGlyphs), 0);
  await page.getByLabel("Show Hidden legacy names", {exact:true}).check();
  await page.waitForFunction(() => shell.__opengeoMap.isStyleLoaded() && shell.__opengeoMap.getLayer('legacy-hidden-labels') && !shell.__opengeoMap.getLayer('names-labels'));
  assert.equal(await page.evaluate(() => shell.__opengeoMap.getGlyphs() ?? null), null);
  assert.equal(await page.evaluate(() => Object.hasOwn(shell.__opengeoLayers.find(layer=>layer.layerId==='legacy-hidden').labels,'fontRef')), false);
  await page.getByLabel("Show Hidden legacy names", {exact:true}).uncheck();
  await page.waitForFunction(() => shell.__opengeoMap.isStyleLoaded() && shell.__opengeoMap.getLayer('names-labels') && !shell.__opengeoMap.getLayer('legacy-hidden-labels'));
  assert.equal(await page.evaluate(() => fontProbe.saves.length), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(denied, []);
  const receipt={status:"pass",scope:"Focused production Workbench and bundled assets; local save adapter, no API or deployed renderer claim",
    fontRef:saved.layers[0].labels.fontRef,labels:names,legacyInspectionFontRequests:0,reopenedLocalGlyphCalls:0,
    corruptReadVisibleWithoutInspector:true,explicitRetryRecovers:true,unsupportedCharacterRejected:true,hiddenLegacyVisibilityPreserved:true,
    glyphFilesRequested:new Set(seen.filter(path=>path.endsWith('.pbf'))).size,
    screenshots:await Promise.all(["adopted.png","reopened.png","unavailable.png"].map(async name=>({name,sha256:createHash('sha256').update(await readFile(resolve(output,name))).digest('hex')}))),errors,denied};
  await writeFile(resolve(output,"receipt.json"),`${JSON.stringify(receipt,null,2)}\n`);
  console.log(JSON.stringify({output,...receipt},null,2));
} catch (error) {
  console.error(JSON.stringify({errors,denied,seen:seen.slice(-12),state:await page?.evaluate(()=>({
    text:document.body.innerText.slice(-2000), map:!!window.shell?.__opengeoMap,
    loaded:window.shell?.__opengeoMap?.isStyleLoaded(), sourceReads:window.fontProbe?.sourceReads,
    layers:window.shell?.__opengeoMap?.getStyle()?.layers.map(layer=>layer.id)
  })).catch(()=>null)}));
  throw error;
} finally { if(browser) await browser.close(); }
