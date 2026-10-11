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
