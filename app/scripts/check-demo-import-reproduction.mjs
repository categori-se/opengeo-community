import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";

const root = resolve(".local-archives/progress-release-20260919/demo/artifacts");
const types = {".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json", ".html": "text/html", ".pbf": "application/octet-stream"};
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
const live = process.env.OPEN_GEO_BROWSER_DEMO_LIVE === "1";
const origin = live ? "https://demo.studio.opengeo.tools" : `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [], privateRequests = [];
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox"]});
  page = await browser.newPage({viewport: {width: 1280, height: 820}, serviceWorkers: "block"});
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (/\/api\/|auth-config|workspaces|login/.test(url.pathname)) privateRequests.push(url.href);
    if (url.origin === origin) return route.continue();
    // Only the selected static origin may receive requests; substitute an empty basemap.
    if (url.href.includes("/styles/")) return route.fulfill({json: {version: 8, sources: {}, layers: []}});
    return route.abort();
  });
  await page.goto(origin + "/");
  await page.locator(".opengeo-workbench").waitFor();
  await page.getByRole("button", {name: "Add data", exact: true}).first().click();
  await page.locator('.gis-file-drop input[type=file]').first().setInputFiles({name:'Berkshire Botanical Garden.kml',mimeType:'application/vnd.google-earth.kml+xml',buffer:Buffer.from('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My Places</name><Placemark><name>Berkshire Botanical Garden</name><Point><coordinates>-73.336,42.300,0</coordinates></Point></Placemark></Document></kml>')});
  await page.waitForTimeout(1500);
  console.log(JSON.stringify(await page.locator('.opengeo-workbench').evaluate(s=>({status:s.querySelector('.gis-statusbar')?.textContent,layers:s.__opengeoLayers,mapLayers:s.__opengeoMap.getStyle().layers.map(l=>l.id),features:s.__opengeoMap.queryRenderedFeatures().length,center:s.__opengeoMap.getCenter()}))));
  console.log(JSON.stringify({errors,privateRequests}));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
