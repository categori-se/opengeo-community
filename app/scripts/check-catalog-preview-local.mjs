// Focused built-browser check; optional exact public State Boundaries provider. No AWS calls.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {readFile, readdir, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";

const live = process.argv.includes('--live-state-boundaries');
const imagery = process.argv.includes('--image-server');
const previewPng = imagery ? await readFile('/tmp/opengeo-preview-fixture.png') : null;
let tileRequests = 0;
let basemapRequests = 0;
const endpoint = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Census_States/FeatureServer/0';
const dist = resolve("dist"), output = imagery ? resolve("/tmp/opengeo-layer-imagery-preview") : live ? resolve('/tmp/opengeo-state-boundaries-preview') : resolve("../.local-archives/studio-discovery-20260912/browser");
await mkdir(output, {recursive: true});
const component = (await readdir(resolve(dist, "_import/components"))).find(name => /^LayerCatalogResults\.[a-f0-9]+\.js$/.test(name));
const css = (await readdir(resolve(dist, "_file"))).find(name => /^style\.[a-f0-9]+\.css$/.test(name));
const theme = (await readdir(resolve(dist, "_observablehq"))).find(name => /^theme-.*\.css$/.test(name));
const loader = (await readdir(resolve(dist, '_import/lib'))).find(name=>/^catalogLayerPreview\.[a-f0-9]+\.js$/.test(name));
assert.ok(component && css && theme);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/check") {res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); return;}
  const file = resolve(dist, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(`${dist}/`)) {res.writeHead(403).end(); return;}
  try {
    res.setHeader("Content-Type", ({".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html"})[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({headless: true, executablePath: ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
  page = await browser.newPage({viewport: {width: 1100, height: 1100}});
  page.on("pageerror", error => errors.push(error.message));
  let providerRequests = 0;
  await page.route("**/*", route => {
    if (route.request().url().startsWith(origin)) return route.continue();
    const requestUrl = new URL(route.request().url());
    if (imagery && requestUrl.origin === "https://imagery.example.org" && requestUrl.pathname === "/ImageServer/exportImage") {
      assert.equal(route.request().method(), "GET");
      assert.equal(requestUrl.searchParams.get("bboxSR"), "3857");
      tileRequests++;
      assert.ok(tileRequests <= 40, "bounded local image requests");
      return route.fulfill({contentType: "image/png", body: previewPng});
    }
    if (live && ['GET','OPTIONS'].includes(route.request().method()) && [endpoint,endpoint+'/query'].includes(requestUrl.origin+requestUrl.pathname)) {
      providerRequests++; return route.continue();
    }
    if (route.request().url().includes("tiles.openfreemap.org/styles/positron")) {
      basemapRequests++;
      return route.fulfill({json: {version: 8, sources: {}, layers: [{id: "background", type: "background", paint: {"background-color": "#d9e3e7"}}]}});
    }
    return route.abort();
  });
  await page.goto(`${origin}/check`);
  await page.addStyleTag({url: `${origin}/_observablehq/${theme}`});
  await page.addStyleTag({url: `${origin}/_file/${css}`});
  await page.evaluate(async ({component,loader,live,endpoint,imagery}) => {
    const {LayerCatalogResults} = await import(`/_import/components/${component}`);
    let records = ["Extreme heat days", "Adult cancer"].map((title, index) => ({
      datasetId: "9e41f091-4105-48c3-9051-bd0f9f947342", datasetName: "MassEnviroScreen",
      projectId: "279f0d90-d8b0-4d73-907f-15eab283bbdb", projectName: "MassGIS · MassEnviroScreen",
      mapId: "279f0d90-d8b0-4d73-907f-15eab283bbdb", mapVersion: 1, layerId: `indicator-${index}`,
      title, styleField: "value", geometryType: "Polygon", format: "geojson",
      legend: {field: "value", breaks: [20, 40, 60, 80], colors: ["#ffffcc", "#fed976", "#fd8d3c", "#e31a1c", "#800026"]}
    }));
    if(live) records=[{datasetId:'1d4b5b28-32ef-4217-a058-f7dbd904eeea',projectId:'279f0d90-d8b0-4d73-907f-15eab283bbdb',
      datasetName:'State Boundaries',title:'State Boundaries',projectName:'MassGIS · MassEnviroScreen',geometryType:'MultiPolygon',format:'arcgis',
      service:{url:endpoint.replace(/\/0$/,''),layerUrl:endpoint,layerId:'0',kind:'FeatureServer',sourceVersion:1,renderingSource:'provider'}}];
    window.previewLoads = 0;
    const root = LayerCatalogResults({records, loadPreview: async () => {
      window.previewLoads++;
      if (imagery) return {kind: "image", endpoint: "https://imagery.example.org/ImageServer",
        metadata: {initialExtent: {xmin: -73, ymin: 41, xmax: -72, ymax: 42, spatialReference: {wkid: 4326}}},
        attribution: "Local imagery fixture"};
      if(live) {
        const {loadProviderPreview} = await import(`/_import/lib/${loader}`);
        const result = await loadProviderPreview(endpoint,{signal:AbortSignal.timeout(30000)});
        window.livePreviewEvidence={features:result.geojson.features.length,complete:result.complete,geometryNote:result.geometryNote};
        return {...result,endpoint,attribution:result.metadata.copyrightText};
      }
      return {kind: "features", endpoint: "https://example.org/FeatureServer/0", metadata: {supportedQueryFormats: "JSON, geoJSON"},
        attribution: "Local browser fixture — not source data", complete: false, geometryNote: "Simplified preview",
        geojson: {type: "FeatureCollection", features: [10, 30, 50, 70, 90].map((value, index) => {
          const x = -73 + index * 0.25;
          return {type: "Feature", properties: {value}, geometry: {type: "Polygon", coordinates: [[[x, 42], [x + 0.24, 42], [x + 0.24, 42.2], [x, 42.2], [x, 42]]]}};
        })}};
    }});
    const main = document.createElement("main"); main.style.cssText = "max-width:980px;margin:24px auto;padding:12px";
    main.append(root); document.body.append(main);
  }, {component,loader,live,endpoint,imagery});
  assert.equal(await page.evaluate(() => window.previewLoads), 0);
  const button = page.locator(".layer-catalog-entry").first().locator("button").first();
  await button.click();
  assert.equal(await page.evaluate(() => window.previewLoads), 0);
  await page.locator(".layer-catalog-entry").first().getByRole("button", {name:"Open map", exact: true}).click();
  await page.locator(".maplibregl-canvas").waitFor();
  await page.waitForFunction(() => document.querySelector(".map-frame")?.__resize);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.previewLoads), 1);
  if(live) assert.ok((await page.evaluate(()=>window.livePreviewEvidence.features))>0);
  else if (!imagery) assert.match(await page.locator(".catalog-layer-preview").innerText(), /bounded sample/);
  if (imagery) {
    assert.equal(basemapRequests, 1, "Raster preview loads the same geographic basemap as vector previews");
    await page.waitForFunction(() => document.querySelector(".map-preview-status")?.textContent.includes("ready"));
    assert.ok(tileRequests > 0);
    assert.equal(page.url(), `${origin}/check`, "Open map never navigates into a Project");
    await page.getByRole("button", {name: "Zoom in", exact: true}).click();
    await page.waitForFunction(() => document.querySelector(".map-preview-status")?.textContent.includes("ready"));
  }
  await button.click(); await button.click();
  assert.equal(await page.evaluate(() => window.previewLoads), 1);
  await page.screenshot({path: resolve(output, "layer-preview-desktop.png"), fullPage: true});
  await page.setViewportSize({width: 390, height: 1000});
  await page.waitForFunction(() => {
    const frame = document.querySelector(".map-frame"), canvas = frame?.querySelector("canvas");
    return canvas && Math.abs(canvas.clientWidth - frame.clientWidth) < 3 && Math.abs(canvas.clientHeight - frame.clientHeight) < 3;
  }, null, {timeout: 5000});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: resolve(output, "layer-preview-mobile.png"), fullPage: true});
  const bootstrap = await browser.newPage({javaScriptEnabled: false});
  await bootstrap.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await bootstrap.goto(`${origin}/workspaces.html`);
  assert.equal(await bootstrap.locator("#studio-bootstrap-status progress").isVisible(), true,
    "status is visible before JavaScript and account calls");
  await bootstrap.close();
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "result.json"), JSON.stringify({passed: true, tileRequests, basemapRequests, providerRequests,
    livePreview:live ? await page.evaluate(()=>window.livePreviewEvidence) : null,
    desktopWidth: 1100, mobileWidth: 390, errors, fixtureOnly: !live, authenticatedAccount:false}, null, 2));
  console.log(JSON.stringify({passed: true, output, providerRequests, fixtureOnly: !live}));
} catch (error) {
  await writeFile(resolve(output, "failure.json"), JSON.stringify({error: error.message, errors,
    basemapRequests, tileRequests, text: await page?.locator("body").innerText().catch(() => "unavailable")}, null, 2));
  await page?.screenshot({path: resolve(output, "failure.png"), fullPage: true}).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
