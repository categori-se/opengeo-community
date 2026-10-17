import assert from "node:assert/strict";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {build} from "esbuild";
import * as kit from "@observablehq/notebook-kit";
import {parseJavaScript} from "@observablehq/framework/dist/javascript/parse.js";
import {transpileJavaScript} from "@observablehq/framework/dist/javascript/transpile.js";
import {chromium} from "playwright";
import {inspectStaticMapLayers, staticMapDocument} from "../src/lib/staticMapExport.js";
import {unzipSync} from "fflate";
import {createHash} from "node:crypto";
import {nativeProjectViewRuntime} from "./build-maplibre-render-bundle.mjs";

if (process.env.OPEN_GEO_DEVELOPER_EXPORT === "1" || process.env.OPEN_GEO_FIGURE_EXPORT === "1") {
  await checkDeveloperBundle();
  process.exit(0);
}

async function checkDeveloperBundle() {
  const figureMode = process.env.OPEN_GEO_FIGURE_EXPORT === "1";
  const nativeControls = process.env.OPEN_GEO_NATIVE_CONTROL_CHECK === "1";
  const limits = nativeControls ? {GETs:40,bytes:12*1024*1024,seconds:30} : {GETs:figureMode?120:180,bytes:24*1024*1024,seconds:90};
  const {resolve, dirname} = await import("node:path");
  const output = resolve(process.env.OPEN_GEO_EXPORT_OUTPUT ?? "/tmp/opengeo-native-developer-export");
  const runtimeRoot = resolve(process.env.OPEN_GEO_EXPORT_RUNTIME ?? "app/dist/export-runtime");
  await mkdir(output, {recursive: true});
  const runtime = {};
  for (const name of ["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt"]) runtime[name] = await readFile(resolve(runtimeRoot, name));
  runtime["native-map-view.txt"] = Buffer.from(await nativeProjectViewRuntime());
  if (figureMode) {
    runtime["studio.css"] = await readFile(new URL("../src/style.css", import.meta.url));
    const {readdir} = await import("node:fs/promises"), themeRoot=resolve(runtimeRoot,"../_observablehq");
    const themes=(await readdir(themeRoot)).filter(name=>/^theme-.*\.css$/.test(name));assert.equal(themes.length,1);
    runtime["theme.css"]=await readFile(resolve(themeRoot,themes[0]));
  }
  const author = "https://author.example.test", host = "https://maps.example.test", reader = "https://article.example.test";
  const style = {version: 8, sources: {
    boundary: {type: "geojson", attribution: "Synthetic survey · CC0", data: {type: "Feature", properties: {name: "Study area"}, geometry: {type: "Polygon", coordinates: [[[-.04,-.03],[.04,-.03],[.04,.03],[-.04,.03],[-.04,-.03]]]}}},
    sites: {type: "geojson", attribution: "Synthetic survey · CC0", data: {type: "FeatureCollection", features: [
      {type: "Feature", id: 1, properties: {name: "Site A", status: "reviewed"}, geometry: {type: "Point", coordinates: [0, 0]}},
      {type: "Feature", id: 2, properties: {name: "Site B", status: "draft"}, geometry: {type: "Point", coordinates: [.02, .01]}}
    ]}}
  }, layers: [{id: "boundary", type: "fill", source: "boundary", paint: {"fill-color": "#418fbb", "fill-opacity": .6}},
    ...(nativeControls ? [{id:"boundary-outline",type:"line",source:"boundary",paint:{"line-color":"#245c7c","line-width":2}}] : []),
    {id: "sites", type: "circle", source: "sites", paint: {"circle-color": "#c8353d", "circle-radius": 12}}]};
  const layers = ["boundary", "sites"].map(id => ({layerId: id, datasetId: `dataset-${id}`, sourceVersion: 1,
    title: id === "sites" ? "Survey points" : "Study area", visible: true, opacity: 1, license: "CC0-1.0",
    style: {fill: "#418fbb", circleColor: "#c8353d"}, labels: {}, attribution: "Original synthetic survey", metadata: {curated: {attribution: "Curated synthetic survey"}}, curatedAttribution: "Curated synthetic survey"}));
  const authorBundle = await build({stdin: {resolveDir: new URL("../", import.meta.url).pathname, contents: `
    import {openStaticMapExport} from './src/components/StaticMapExport.js';
    ${figureMode ? "import {ProjectPrintEditor} from './src/components/ProjectPrintEditor.js';" : ""}
    const style=${JSON.stringify(style)}, layers=${JSON.stringify(layers)};
    const handles=new Map(layers.map(layer=>[layer.layerId,{sourceId:layer.layerId,layerIds:${nativeControls ? "layer.layerId==='boundary'?['boundary','boundary-outline']:[layer.layerId]" : "[layer.layerId]"}}]));
    const map=new maplibregl.Map({container:'map',style,center:[0,0],zoom:12,preserveDrawingBuffer:true});
    map.on('load',()=>{document.querySelector('button').disabled=false;});
    document.querySelector('button').onclick=()=>openStaticMapExport({map,layers,handles,title:'Field survey',initialMode:'offline',
      download:()=>{throw Error('Unexpected HTML action');},downloadBundle:blob=>{
        const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='field-survey.developer.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      },downloadPublication:blob=>{
        const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='field-survey.publication-source.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      },publicationHref:'https://studio.opengeo.tools/workspaces?view=publishing'});
    ${figureMode ? `
      const workbench=document.createElement('section');workbench.append(document.getElementById('map'));
      const record={id:'local-figure-map',projectId:'local-figure-map',version:1,name:'Field survey',definition:{layers,mapViews:[{center:[0,0],zoom:12,pitch:0,bearing:0}],extensions:{}}};
      workbench.getPrintContext=()=>({renderer:'maplibre',ready:map.isStyleLoaded(),map,layers,handles,project:record.definition});
      const editor=ProjectPrintEditor({state:{selectedMap:record,project:{id:record.projectId},adapter:{}},workbench,editFrame:()=>workbench,persistence:'browser'});
      document.body.append(editor);map.resize();
    ` : ""}
  `}, bundle: true, format: "esm", platform: "browser", write: false});
  const bundled = new Map();let consumerCode;
  const prior = await readFile(resolve(output, "browser-failure.json"), "utf8").catch(()=>readFile(resolve(output,"browser-receipt.json"),"utf8")).then(JSON.parse).catch(() => ({softwareGETs: 0, softwareBytes: 0, elapsedSeconds: 0}));
  const elapsed = () => prior.elapsedSeconds + (performance.now() - started) / 1000;
  const started = performance.now(), requests = [], errors = [];let softwareBytes = prior.softwareBytes, browser, cleanClose = false, failure;
  try {
    browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
    const context = await browser.newContext({viewport: {width: 1000, height: 760}, acceptDownloads: true});
    context.setDefaultTimeout(10000);
    const fulfill = async (route, body, contentType, cors = false) => {
      body = Buffer.from(body);softwareBytes += body.byteLength;
      assert.ok(softwareBytes <= limits.bytes, "Cumulative software byte boundary");
      await route.fulfill({body, contentType, headers: cors ? {"Access-Control-Allow-Origin": "*"} : {}});
    };
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (!/^https?:$/.test(url.protocol)) return route.continue();
      requests.push(url.href);assert.ok(prior.softwareGETs + requests.length <= limits.GETs, "Cumulative software GET boundary");
      assert.ok(elapsed() <= limits.seconds, "Cumulative browser time boundary");
      assert.equal(request.method(), "GET");assert.equal(request.headers().authorization, undefined);assert.equal(request.headers().cookie, undefined);
      if (url.origin === author) {
        if (url.pathname === "/") return fulfill(route, '<!doctype html><link rel="stylesheet" href="/export-runtime/maplibre-gl.css">'+(figureMode ? '<link rel="stylesheet" href="/export-runtime/theme.css"><link rel="stylesheet" href="/export-runtime/studio.css">' : '')+'<button disabled>Export map</button><div id="map" style="height:550px"></div><script src="/export-runtime/maplibre-gl.js"></script><script type="module" src="/author.mjs"></script>', "text/html");
        if (url.pathname === "/author.mjs") return fulfill(route, authorBundle.outputFiles[0].contents, "text/javascript");
        const name = url.pathname.replace("/export-runtime/", "");
        if (runtime[name]) return fulfill(route, runtime[name], name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "text/plain");
      }
      if (url.origin === host) {
        const name = url.pathname.replace("/edition/", "");
        if (bundled.has(name)) return fulfill(route, bundled.get(name), name.endsWith(".html") ? "text/html" : name.endsWith(".mjs") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/plain", true);
      }
      if (url.origin === reader && url.pathname === "/") return fulfill(route, '<!doctype html><style>body{font:18px Georgia,serif;color:rgb(32,55,75);background:white;margin:2rem}.opengeo-native-map-controls label{margin-right:1rem}</style><main></main>', "text/html");
      if (url.origin === reader && url.pathname === "/consumer.mjs") return fulfill(route, consumerCode, "text/javascript");
      errors.push(`Blocked unexpected request: ${url.href}`);return route.abort();
    });
    const page = await context.newPage();await page.goto(`${author}/`);
    if (figureMode) {
      const outcome = await checkFigureAndHandoff({page, context, output});
      assert.deepEqual(errors, []);await browser.close();browser=null;cleanClose=true;
      const receipt={status:'passed-local-figure-handoff-browser',...outcome,softwareGETs:prior.softwareGETs+requests.length,softwareBytes,elapsedSeconds:elapsed(),externalRequests:0,errors,browserClosed:cleanClose,deployed:false};
      await writeFile(resolve(output,'browser-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));return;
    }
    await page.getByRole("button", {name: "Export map"}).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Format", {exact: true}).selectOption("developer");
    const downloadButton = dialog.getByRole("button", {name: "Download developer ZIP"});assert.equal(await downloadButton.isDisabled(), true);
    await dialog.getByRole("checkbox", {name: /I have reviewed/}).check();
    const downloadPromise = page.waitForEvent("download");await downloadButton.click();
    const download = await downloadPromise, zipPath = resolve(output, "field-survey.developer.zip");await download.saveAs(zipPath);
    const archive = await readFile(zipPath), files = unzipSync(archive);
    for (const [name, bytes] of Object.entries(files)) {
      assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
      bundled.set(name, Buffer.from(bytes));await mkdir(dirname(resolve(output, name)), {recursive: true});await writeFile(resolve(output, name), bytes);
    }
    const manifest = JSON.parse(bundled.get("manifest.json"));assert.equal(manifest.fullyOffline, true);
    for (const file of manifest.files) {assert.equal(bundled.get(file.path).length, file.bytes);assert.equal(createHash("sha256").update(bundled.get(file.path)).digest("hex"), file.checksumSha256);}
    const preview = await context.newPage();await preview.goto(`${host}/edition/preview.html`);await preview.getByRole("status").filter({hasText: "Map ready"}).waitFor();
    assert.equal(await preview.locator("iframe").count(), 0);await preview.screenshot({path: resolve(output, "native-preview.png")});
    const observable = bundled.get("observable.md").toString().match(/```js\n([\s\S]*?)```/)[1].replace("https://YOUR-HOST.example/maps/your-edition/", `${host}/edition/`);
    const compiled = transpileJavaScript(parseJavaScript(observable, {path: "/index.md"}), {id: "native-map", path: "/index.md", resolveImport: name => name});
    const consumer = await build({stdin: {resolveDir: new URL("../", import.meta.url).pathname, contents: `
      import {Runtime} from '@observablehq/framework/dist/client/runtime.js';
      export function mount(root){const runtime=new Runtime({display:()=>value=>root.append(value)}), main=runtime.module();
        const define=spec=>main.variable(true).define(null,spec.inputs,spec.body);
        ${compiled}
        return ()=>runtime.dispose();
      }
    `}, bundle: true, format: "esm", platform: "browser", write: false});
    consumerCode = consumer.outputFiles[0].contents;
    const article = await context.newPage();await article.goto(`${reader}/`);
    await article.evaluate(async () => {const {mount}=await import('/consumer.mjs');window.stopArticle=mount(document.querySelector('main'));});
    await article.waitForFunction(() => document.querySelector(".opengeo-native-map")?.map?.getLayer("sites"));
    const interaction = await article.evaluate(async () => {
      const view = document.querySelector(".opengeo-native-map");window.events=[];
      for (const type of ["camerachange", "selectionchange", "filterchange", "layerchange", "dispose"]) view.addEventListener(type, event => events.push({type, detail: event.detail}));
      const fonts = getComputedStyle(view).fontFamily, color = getComputedStyle(view).color;
      const point = view.map.project([0,0]), box = view.querySelector("canvas").getBoundingClientRect();
      return {fonts, color, point: {x:box.left+point.x,y:box.top+point.y}};
    });
    assert.match(interaction.fonts, /Georgia/);assert.equal(interaction.color, "rgb(32, 55, 75)");assert.equal(await article.locator("iframe").count(), 0);
    await article.mouse.click(interaction.point.x, interaction.point.y);
    await article.waitForFunction(() => document.querySelector(".opengeo-native-map").getSelection().some(feature => feature.properties.name === "Site A"));
    if(nativeControls) {
      await article.evaluate(()=>document.querySelector('.opengeo-native-map').setLayerVisibility('boundary',false));
      const checkbox=article.getByRole('checkbox',{name:'Study area',exact:true});
      assert.equal(await checkbox.evaluate(input=>input.indeterminate),true);
      await checkbox.check();await checkbox.uncheck();await checkbox.check();
      assert.equal(await checkbox.evaluate(input=>input.indeterminate),false);
      assert.deepEqual(await article.evaluate(()=>{const view=document.querySelector('.opengeo-native-map');return ['boundary','boundary-outline'].map(id=>view.map.getLayoutProperty(id,'visibility'));}),['visible','visible']);
    }
    await article.evaluate(() => {const view=document.querySelector('.opengeo-native-map');view.setFilter('sites',['==',['get','status'],'missing']);view.setLayerVisibility('boundary',false);view.setCamera({zoom:11});});
    await article.waitForFunction(() => {const view=document.querySelector('.opengeo-native-map');return view.map.queryRenderedFeatures({layers:['sites']}).length===0;});
    assert.equal(await article.evaluate(() => document.querySelector('.opengeo-native-map').getCamera().zoom), 11);
    await article.screenshot({path: resolve(output, "native-article.png")});
    await article.evaluate(() => {stopArticle();});await article.locator(".opengeo-native-map").waitFor({state: "detached"});
    const eventTypes = await article.evaluate(() => events.map(event=>event.type));
    for (const type of ["selectionchange", "filterchange", "layerchange", "camerachange", "dispose"]) assert.ok(eventTypes.includes(type), type);
    await context.setOffline(true);
    await article.evaluate(async origin => {
      const [{createView},{maplibre}]=await Promise.all([import(origin+'/edition/map.mjs'),import(origin+'/edition/runtime/maplibre.mjs')]);
      window.offlineView=createView({maplibre,height:500});document.querySelector('main').append(offlineView);
    }, host);
    await article.waitForFunction(() => window.offlineView.map.getLayer("sites"));
    await article.evaluate(() => offlineView.dispose());
    const offline = await context.newPage();await offline.goto(`file://${resolve(output, "interactive.html")}`);
    await offline.getByRole("status").filter({hasText: "Offline edition"}).waitFor();
    assert.equal(await offline.getByRole("checkbox").count(), 2);
    await offline.getByRole("checkbox", {name: "Study area"}).uncheck();
    assert.deepEqual(errors, []);
    await browser.close();browser=null;cleanClose=true;
    const receipt = {status: nativeControls ? "passed-native-grouped-visibility-controls" : "passed-native-developer-bundle-local", limits, actualDialogDownload: true, ZIPBytes: archive.length, fileHashes: manifest.files.length,
      groupedVisibilityControls: nativeControls,
      nativePreview: true, crossOriginObservableFramework: true, hostFontAndColor: true, actualPointerSelection: true,
      filterVisibilityCameraEvents: eventTypes, nativeCachedOffline: true, standaloneHTMLNetworkDisabled: true,
      softwareGETs: prior.softwareGETs + requests.length, softwareBytes, elapsedSeconds: elapsed(), externalRequests: 0, errors,
      browserClosed: cleanClose, deployed: false};
    await writeFile(resolve(output, "browser-receipt.json"), JSON.stringify(receipt, null, 2)+"\n");console.log(JSON.stringify(receipt));
  } catch (error) {failure=error;throw error;}
  finally {
    if(browser){await browser.close();cleanClose=true;}
    if(failure) await writeFile(resolve(output,"browser-failure.json"),JSON.stringify({status:"stopped",error:failure.message,softwareGETs:prior.softwareGETs+requests.length,softwareBytes,elapsedSeconds:elapsed(),errors,browserClosed:cleanClose},null,2)+"\n");
  }
}

async function checkFigureAndHandoff({page, context, output}) {
  const {resolve, dirname} = await import('node:path');
  const {readPublicationSourceArchive} = await import('../src/lib/publicationSourceArchive.js');
  const {verifyPortableMapArtifact} = await import('../src/lib/portableMapArtifact.js');
  const editor=page.locator('#project-print-studio');
  await page.waitForFunction(()=>!document.querySelector('body > button').disabled);
  await editor.getByRole('button',{name:'Download figure and print ZIP',exact:true}).click();
  await editor.getByRole('status').filter({hasText:'Capture every map frame'}).waitFor();
  await editor.getByRole('checkbox',{name:'Latitude / longitude grid'}).check();
  await editor.getByRole('button',{name:'Capture map frame',exact:true}).click();
  await editor.getByRole('status').filter({hasText:'Captured Main map'}).waitFor();
  const downloadPromise=page.waitForEvent('download');
  await editor.getByRole('button',{name:'Download figure and print ZIP',exact:true}).click();
  const download=await downloadPromise;await download.saveAs(resolve(output,'field-survey.figure-print.zip'));
  const files=unzipSync(await readFile(resolve(output,'field-survey.figure-print.zip')));
  for(const [name,bytes] of Object.entries(files)) {
    assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
    await mkdir(dirname(resolve(output,name)),{recursive:true});await writeFile(resolve(output,name),bytes);
  }
  const manifest=JSON.parse(Buffer.from(files['manifest.json']));
  for(const file of manifest.files){assert.equal(files[file.path].length,file.sizeBytes);assert.equal(createHash('sha256').update(files[file.path]).digest('hex'),file.checksumSha256);}
  assert.equal(manifest.pdf.representation,'raster-page');assert.equal(manifest.page.size,'A4');assert.equal(manifest.fullyOffline,true);
  const source=JSON.parse(Buffer.from(files['map-context.json']));
  assert.ok(source.frames[0].attribution.includes('Original synthetic survey'));assert.ok(source.frames[0].attribution.includes('Curated synthetic survey'));
  assert.equal(source.frames[0].sourceMetadata[0].license,'CC0-1.0');
  assert.ok(Buffer.from(files['page.svg']).includes(Buffer.from('°')));
  assert.ok(Buffer.from(files['page.pdf']).indexOf(Buffer.from(files['page.jpg']))>0,'PDF contains exact composed JPEG');
  await page.screenshot({path:resolve(output,'print-editor.png')});
  await page.getByRole('button',{name:'Export map',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Format',{exact:true}).selectOption('publication');
  const publish=dialog.getByRole('button',{name:'Download publishing ZIP',exact:true});assert.equal(await publish.isDisabled(),true);
  assert.equal(await dialog.getByRole('link',{name:'Continue in Studio Publications ↗'}).count(),0);
  await dialog.getByRole('checkbox',{name:/I have reviewed/}).check();
  const publicationDownload=page.waitForEvent('download');await publish.click();
  await (await publicationDownload).saveAs(resolve(output,'field-survey.publication-source.zip'));
  const imported=await readPublicationSourceArchive(new Blob([await readFile(resolve(output,'field-survey.publication-source.zip'))]));
  assert.equal(imported.manifest.metadata.entryPath,'index.html');assert.equal(imported.manifest.metadata.rightsStatus,'unreviewed');
  const html=imported.files.find(file=>file.relativePath==='index.html'), sidecar=imported.files.find(file=>file.relativePath==='index.html.artifact.json');
  await verifyPortableMapArtifact(html.blob,JSON.parse(await sidecar.blob.text()));
  const continuation=dialog.getByRole('link',{name:'Continue in Studio Publications ↗'});
  await continuation.waitFor();assert.equal(await continuation.getAttribute('href'),'https://studio.opengeo.tools/workspaces?view=publishing');
  assert.equal(await continuation.getAttribute('target'),'_blank');assert.match(await dialog.getByRole('status').textContent(),/Nothing has been uploaded or published/);
  await page.screenshot({path:resolve(output,'publishing-handoff.png')});
  await context.setOffline(true);const offline=await context.newPage();await offline.goto(`file://${resolve(output,'print.html')}`);
  assert.equal(await offline.locator('svg image').count(),1);assert.match(await offline.locator('svg').textContent(),/Original synthetic survey/);
  await offline.screenshot({path:resolve(output,'offline-figure.png'),fullPage:true});
  return {actualPrintCapture:true,actualFigureZIPDownload:true,figurePayloadHashes:manifest.files.length,figurePNGBytes:files['page.png'].length,
    figureJPEGBytes:files['page.jpg'].length,figurePDFBytes:files['page.pdf'].length,pdfExactJPEG:true,PDFParserAcceptance:'pending separate Poppler check',
    paper:manifest.page,offlinePrintHTML:true,actualPublishingZIPDownload:true,existingSourceImporter:true,privateUnreviewedDraft:true,
    exactPortableHTMLManifest:true,deliberateAccountLink:true,accountNetworkCalls:0};
}

const output = "/tmp/opengeo-static-map-example";
await mkdir(output, {recursive: true});
const style = {version: 8, sources: {sites: {type: "geojson", attribution: "OpenGeo · synthetic demonstration data", data: {type: "FeatureCollection", features: [
  {type: "Feature", properties: {name: "Monitoring site A"}, geometry: {type: "Point", coordinates: [0, 0]}},
  {type: "Feature", properties: {name: "Monitoring site B"}, geometry: {type: "Point", coordinates: [0.02, 0.01]}}
]}}, boundary: {type: "geojson", data: {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [[[-.04,-.03],[.04,-.03],[.04,.03],[-.04,.03],[-.04,-.03]]]}}}}, layers: [
  {id: "boundary", type: "fill", source: "boundary", paint: {"fill-color": "#418fbb", "fill-opacity": .45}},
  {id: "sites", type: "circle", source: "sites", paint: {"circle-color": "#c8353d", "circle-radius": 10, "circle-stroke-color": "#fff", "circle-stroke-width": 2}},
  {id: "site-labels", type: "symbol", source: "sites", layout: {"text-field": ["get", "name"], "text-font": ["sans-serif"], "text-offset": [0, 1.5], "text-size": 16, "text-allow-overlap": true}, paint: {"text-color": "#222222"}}
]};
const candidates = inspectStaticMapLayers({style, layers: [{layerId: "boundary", title: "Study area"}, {layerId: "sites", title: "Monitoring sites"}], handles: new Map(["boundary", "sites"].map(id => [id, {sourceId: id, layerIds: id === "sites" ? [id, "site-labels"] : [id]}]))});
// Reuse the maintained portable bundle (MapLibre 6 is ESM + a worker); do not
// assume the pre-6 package's UMD filename or rebuild the pinned viewer here.
const runtimeRoot = process.env.OPEN_GEO_EXPORT_RUNTIME ?? new URL("../dist/export-runtime/", import.meta.url).pathname;
const [runtimeJs, runtimeCss, runtimeLicense] = await Promise.all(["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt"].map(file => readFile(`${runtimeRoot}/${file}`, "utf8")));
const html = staticMapDocument({title: "Field survey · offline map", view: {center: [0,0], zoom: 12}, candidates, selectedIds: ["boundary", "sites"], runtimeJs, runtimeCss, runtimeLicense});
await writeFile(`${output}/field-survey.html`, html);
// Exercise the actual API delivery handler with exact local storage and a public
// eligibility peer. Database/provider authorization remains separately accepted.
const routeResult = JSON.parse(execFileSync(new URL("../../services/api/.venv/bin/python", import.meta.url).pathname, ["-c", `
import asyncio,json,sys
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from uuid import UUID
from fastapi import Request
from opengeo_api.artifact_release_routes import public_release_module
html=sys.stdin.buffer.read()
record={"id":str(UUID(int=2)),"artifact_id":str(UUID(int=3)),"version_number":1,"project_id":str(UUID(int=4)),"title":"Field survey","license":"CC0-1.0","attribution":"Synthetic demonstration data"}
target=[None]*13
target[7:13]=["private-bucket","exact-key","version-1","text/html",len(html),sha256(html).hexdigest()]
storage=SimpleNamespace(read_exact_object=AsyncMock(return_value=SimpleNamespace(body=html,content_type="text/html")))
request=Request({"type":"http","app":SimpleNamespace(state=SimpleNamespace(render_repository=SimpleNamespace(_artifact_downloads=storage)))})
authority=AsyncMock(return_value=(record,target))
with patch("opengeo_api.artifact_release_routes._public",authority):
 response=asyncio.run(public_release_module(UUID(int=1),UUID(int=2),request,True))
print(json.dumps({"module":response.body.decode(),"headers":dict(response.headers),"authorityChecks":authority.await_count,"objectReads":storage.read_exact_object.await_count}))
`], {input: html, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  env: {...process.env, PYTHONPATH: new URL("../../services/api/src", import.meta.url).pathname}, timeout: 20000}));
await writeFile(`${output}/field-survey.mjs`, routeResult.module);
assert.equal(routeResult.authorityChecks, 2); assert.equal(routeResult.objectReads, 1);
const endpoint = "https://artifact.example.test/module.mjs";
const source = `import {createView} from ${JSON.stringify(endpoint)}; display(createView({height: 500, invalidation}));`;
const compiledKit = kit.transpile(kit.toCell({id: 1, mode: "js", value: source}), {resolveImport: name => name});
const compiledFramework = transpileJavaScript(parseJavaScript(source, {path: "/index.md"}), {id: "project", path: "/index.md", resolveImport: name => name});
const consumers = await build({stdin: {contents: `
import {Runtime} from "@observablehq/framework/dist/client/runtime.js";
import {define as kitDefine} from "./node_modules/@observablehq/notebook-kit/dist/src/runtime/define.js";
export function framework(root) {
 const runtime=new Runtime({display:()=>value=>root.append(value)}), main=runtime.module();
 const define=spec=>main.variable(true).define(null,spec.inputs,spec.body);
 ${compiledFramework}
 return ()=>runtime.dispose();
}
export function notebookKit(root) {
 const runtime=new Runtime(), main=runtime.module(), state={root,variables:[],expanded:[]};
 kitDefine(main,state,{id:1,...${JSON.stringify({...compiledKit, body: undefined, files: undefined, databases: undefined, secrets: undefined})},body:${compiledKit.body}});
 return ()=>runtime.dispose();
}
export async function classic(root) {
 const module=await import(${JSON.stringify(endpoint)}), runtime=new Runtime();
 runtime.module(module.default,name=>name==='project'?{fulfilled:value=>root.append(value),rejected:error=>{throw error;}}:undefined);
 return ()=>runtime.dispose();
}
`, resolveDir: new URL("../", import.meta.url).pathname}, bundle: true, format: "esm", platform: "browser", write: false});
const browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync), args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
try {
  const context = await browser.newContext({offline: true, viewport: {width: 1000, height: 700}});
  context.setDefaultTimeout(10000);
  await context.route("**/*", route => /^https?:/.test(route.request().url()) ? route.abort() : route.continue());
  const page = await context.newPage(), requests = [], errors = [];
  context.on("request", request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`file://${output}/field-survey.html`);
  await page.getByRole("status").filter({hasText: "Offline edition"}).waitFor();
  assert.equal(await page.getByRole("checkbox").count(), 2);
  const before = await page.locator("canvas").screenshot();
  await page.getByRole("checkbox", {name: "Study area"}).uncheck();
  await page.waitForTimeout(200);
  assert.notDeepEqual(await page.locator("canvas").screenshot(), before);
  await page.getByRole("checkbox", {name: "Study area"}).check();
  await page.getByRole("button", {name: "Zoom in", exact: true}).click();
  await page.mouse.move(550,400); await page.mouse.down(); await page.mouse.move(620,440,{steps:5}); await page.mouse.up();
  await page.screenshot({path: `${output}/standalone.png`});
  await page.setViewportSize({width: 390, height: 700});
  await page.getByRole("button", {name: "Reset view"}).click();
  await page.screenshot({path: `${output}/mobile.png`});
  await page.setContent('<iframe title="Map" sandbox="allow-scripts" style="width:100%;height:620px;border:0"></iframe>');
  await page.locator("iframe").evaluate((frame, html) => {frame.srcdoc = html;}, html);
  await page.frameLocator("iframe").getByRole("status").filter({hasText: "Offline edition"}).waitFor();
  await page.frameLocator("iframe").getByRole("checkbox", {name: "Monitoring sites"}).uncheck();
  // Import the same exact response cross-origin, then its downloaded bytes with
  // networking disabled. No notebook rebuild creates a second map Artifact.
  await context.setOffline(false);
  const imports = [];
  await context.route("https://artifact.example.test/**", route => {
    assert.equal(route.request().headers().authorization, undefined);
    imports.push(route.request().url());
    return route.fulfill({body: routeResult.module, headers: routeResult.headers});
  });
  await context.route("https://consumer.example.test/", route => route.fulfill({contentType: "text/html", body: "<!doctype html><main></main>"}));
  const consumer = await context.newPage(); consumer.on("pageerror", error => errors.push(error.message));
  await consumer.goto("https://consumer.example.test/");
  await consumer.evaluate(async bundle => {
    window.consumers=await import(URL.createObjectURL(new Blob([bundle],{type:"text/javascript"})));
  }, consumers.outputFiles[0].text);
  for (const mode of ["framework", "notebookKit", "classic"]) {
    await consumer.evaluate(async mode => {window.stopConsumer=await consumers[mode](document.querySelector("main"));}, mode);
    await consumer.frameLocator("iframe").getByRole("status").filter({hasText: "Offline edition"}).waitFor();
    await consumer.frameLocator("iframe").getByRole("checkbox", {name: "Monitoring sites"}).uncheck();
    await consumer.evaluate(() => stopConsumer());
    await consumer.locator("iframe").waitFor({state: "detached"});
  }
  await context.setOffline(true);
  await consumer.evaluate(async moduleText => {
    const url=URL.createObjectURL(new Blob([moduleText],{type:"text/javascript"}));
    const module=await import(url); URL.revokeObjectURL(url);
    window.offlineView=module.createView({height:500});document.querySelector("main").append(offlineView);
  }, routeResult.module);
  await consumer.frameLocator("iframe").getByRole("status").filter({hasText: "Offline edition"}).waitFor();
  await consumer.evaluate(() => offlineView.dispose());
  await consumer.locator("iframe").waitFor({state: "detached"});
  assert.equal(imports.length, 1);
  const external = requests.filter(url => !url.startsWith("https://artifact.example.test/") && url !== "https://consumer.example.test/");
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({output, offline: true, standalone: true, sandboxedEmbed: true,
    locallyRenderedLabels: true, framework: true, notebookKit: true, classicObservable: true,
    downloadedModuleOffline: true, invalidationCleanup: true, crossOriginModuleReads: imports.length,
    authorityChecks: routeResult.authorityChecks, exactObjectReads: routeResult.objectReads,
    networkRequests: external.length, authorizationPeer: "local-public-fixture", deployed: false}));
} finally {await browser.close();}
