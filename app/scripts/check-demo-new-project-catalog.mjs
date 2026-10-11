import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";

const root = resolve("app/dist/demo-build");
const types = {".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json", ".html": "text/html", ".pbf": "application/octet-stream"};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + "/")) throw Error("path");
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [], privateRequests = [], serviceRequests = [];
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
  page = await browser.newPage({viewport: {width: 1280, height: 820}, serviceWorkers: "block"});
  // Keep this persistence journey within one Demo day even across midnight.
  await page.clock.setFixedTime(new Date());
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (/\/api\/|auth-config|workspaces|login/.test(url.pathname)) privateRequests.push(url.href);
    if (url.origin === origin) return route.continue();
    if (url.hostname === "reviewed-service.example.org") {
      serviceRequests.push(url.href);
      return route.fulfill({contentType:"image/png",body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64")});
    }
    // Only the selected static origin may receive requests; substitute an empty basemap.
    if (url.href.includes("/styles/")) return route.fulfill({json: {version: 8, sources: {}, layers: []}});
    return route.abort();
  });
  await page.goto(origin + "/");
  const shell = page.locator(".opengeo-workbench"); await shell.waitFor();
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  await page.getByRole('heading',{name:'Layer catalog',exact:true}).waitFor();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),0);
  const url=page.url();
  await page.getByLabel('Search Layers',{exact:true}).fill('Public community facilities');
  await page.locator('.browser-layer-catalog article').getByRole('button',{name:'Review and add',exact:true}).click();
  const dialog=page.locator('.browser-layer-registration');await dialog.waitFor();
  assert.notEqual(await dialog.getByLabel('License',{exact:true}).inputValue(),'');
  await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
  assert.equal(page.url(),url);
  const rendered=()=>page.waitForFunction(()=>{const s=document.querySelector('.opengeo-workbench'),l=s?.__opengeoLayers?.[0];return l&&s.__opengeoMap.queryRenderedFeatures().some(f=>f.layer.id.startsWith(l.layerId));});
  await rendered();
  await page.getByRole('button',{name:'Save locally',exact:true}).click();
  await page.reload();await shell.waitFor();await rendered();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),1);
  await page.getByRole('button',{name:'Add data',exact:true}).first().click();
  await page.getByRole('button',{name:'Browse Layer catalog',exact:true}).click();
  await page.getByRole('heading',{name:'Layer catalog',exact:true}).waitFor();
  assert.equal(await shell.evaluate(s=>s.__opengeoLayers.length),1);
  assert.deepEqual(errors,[]);assert.deepEqual(privateRequests,[]);
  const manifest=JSON.parse(await readFile(resolve('dist/opengeo-demo-build.json'),'utf8'));
  const result={status:'passed',tree:manifest.artifactTree.digest,newProjectOpensCatalog:true,searchAndMetadataReview:true,selectedLayerRendered:true,sameProject:true,saveAndReopenRendered:true,returnToCatalogPreservesLayers:true,externalProvidersContacted:0};
  await writeFile(process.env.OPEN_GEO_DEMO_RECEIPT ?? 'docs/demo-new-project-catalog-evidence.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} catch(error) {console.error(JSON.stringify({error:error.message,errors,privateRequests,diagnostic:await page?.evaluate(()=>{const s=document.querySelector(".opengeo-workbench");return {layers:s?.__opengeoLayers,status:document.querySelector(".gis-statusbar")?.textContent,sources:s?.__opengeoMap?.getStyle()?.sources,center:s?.__opengeoMap?.getCenter()};}).catch(()=>null)}));throw error;}
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
