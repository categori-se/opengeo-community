import assert from "node:assert/strict";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {chromium} from "playwright";

const output = resolve(process.env.OPEN_GEO_LOCAL_PROJECT_RECEIPT ?? ".local-archives/renderer-switch-20260930/local-project-library-20261016/indexeddb-browser.json");
await mkdir(resolve(output, ".."), {recursive: true});
const result = {status: "started", startedAt: new Date().toISOString(), softwareRequests: 0, softwareBytes: 0, externalRequests: 0, browserClosed: false, checks: []};
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox"]});
  const context = await browser.newContext({acceptDownloads: true, serviceWorkers: "block"});
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (!/^(?:one|two)\.local-project\.test$/.test(url.hostname) || route.request().method() !== "GET") {
      result.externalRequests++;return route.abort();
    }
    let body, contentType = "text/javascript";
    if (url.pathname === "/") {body = Buffer.from('<!doctype html><script type="importmap">{"imports":{"fflate":"/fflate.js"}}</script>');contentType = "text/html";}
    else if (url.pathname === "/fflate.js") body = await readFile("app/node_modules/fflate/esm/browser.js");
    else if (/^\/lib\/[A-Za-z][A-Za-z0-9]*\.js$/.test(url.pathname)) body = await readFile(`app/src${url.pathname}`);
    else if (url.pathname === "/components/LocalProjectLibrary.js") body = await readFile("app/src/components/LocalProjectLibrary.js");
    else {result.externalRequests++;return route.abort();}
    assert(++result.softwareRequests <= 80);assert((result.softwareBytes += body.byteLength) <= 4 * 1024 * 1024);
    return route.fulfill({status: 200, contentType, body});
  });
  const page = await context.newPage();page.setDefaultTimeout(10000);
  await page.goto("https://one.local-project.test/");
  const checked = await page.evaluate(async () => {
    const {LocalProjectStore, LOCAL_PROJECT_LIMITS} = await import("/lib/localProjectStore.js");
    const store = new LocalProjectStore({now: () => new Date("2000-01-01T00:00:00Z")});
    const geojson = {type: "FeatureCollection", features: [{type: "Feature", geometry: {type: "Point", coordinates: [85, 27]}, properties: {name: "Local clinic"}}]};
    const definition = {schemaVersion: "opengeo.map-definition.1.3.0", mapViews: [{id: "view", center: [85, 27], zoom: 7, pitch: 0, bearing: 0}], basemaps: [], layers: ["a", "b"].map(layerId => ({layerId, datasetId: `local-${layerId}`, title: layerId, sourceType: "geojson-object", visible: true, opacity: 1, style: {circleColor: "#cc5500"}, labels: {enabled: true, field: "name"}}))};
    const data = new Map([["a", geojson], ["b", geojson]]);
    const first = await store.save({title: "Project one", definition, geojsonByLayerId: data});
    definition.layers[0].style.circleColor = "#0000aa";
    const second = await store.save({title: "Project two", definition, geojsonByLayerId: data});
    const initial = await store.list();
    if (initial.projects.length !== 2 || initial.assets !== 1) throw Error("Data was not deduplicated across two independent Projects");
    localStorage.setItem("opengeo.public-demo.fixture", "old sample");localStorage.clear();
    const today = new LocalProjectStore(), loaded = await today.load(first.id);
    if (loaded.updatedAt !== "2000-01-01T00:00:00.000Z" || loaded.definition.layers[0].style.circleColor !== "#cc5500" || loaded.geojsonByLayerId.get("a").features[0].properties.name !== "Local clinic") throw Error("Later-day reopen or reset isolation failed");
    const updates = await Promise.allSettled([1, 2].map(() => today.save({id: first.id, expectedRevision: 1, title: "Project one", definition: loaded.definition, geojsonByLayerId: loaded.geojsonByLayerId})));
    if (updates.filter(item => item.status === "fulfilled").length !== 1 || updates.find(item => item.status === "rejected")?.reason.code !== "local_project_conflict") throw Error("Concurrent stale saves did not conflict");
    const beforeFailure = await today.load(first.id);
    let quotaDenied = false;
    try {await new LocalProjectStore({limits: {...LOCAL_PROJECT_LIMITS, bytes: 1}}).save({id: first.id, expectedRevision: 2, title: "Must not commit", definition: loaded.definition, geojsonByLayerId: loaded.geojsonByLayerId});} catch {quotaDenied = true;}
    const afterFailure = await today.load(first.id);
    if (!quotaDenied || afterFailure.revision !== beforeFailure.revision || afterFailure.title !== beforeFailure.title) throw Error("Storage cap changed the previous committed Project");
    const backup = await today.backup(first.id), bytes = new Uint8Array(await backup.arrayBuffer());
    const restored = await today.inspectBackup(bytes);
    if (restored.definition.layers[0].style.circleColor !== loaded.definition.layers[0].style.circleColor || JSON.stringify(restored.geojsonByLayerId.get("a")) !== JSON.stringify(geojson)) throw Error("Backup changed data or style");
    const imported = await today.save(restored);
    if (imported.id === first.id || (await today.list()).projects.length !== 3 || (await today.list()).assets !== 1) throw Error("Import overwrote an existing Project or copied an identical asset");
    const {zipSync, unzipSync} = await import("fflate");const corrupted = unzipSync(bytes);
    const assetPath = Object.keys(corrupted).find(key => key.startsWith("assets/"));corrupted[assetPath][0] ^= 1;
    let damagedDenied = false;try {await today.inspectBackup(zipSync(corrupted));} catch {damagedDenied = true;}
    if (!damagedDenied) throw Error("A damaged included asset was accepted");
    await today.remove(first.id, 2);
    if ((await today.list()).assets !== 1 || (await today.load(second.id)).title !== "Project two") throw Error("Removing one Project removed shared data");
    const {LocalProjectLibrary} = await import("/components/LocalProjectLibrary.js");
    const dialog = LocalProjectLibrary({store: today});document.body.append(dialog);dialog.showModal();
    window.__projectStore = today;window.__backup = bytes;
    return {checks: ["two independent Projects share one checked asset", "later-day reopen and sample-reset isolation", "concurrent stale-save denial", "atomic storage-cap rejection preserves prior revision", "editable ZIP backup/import preserves data and style", "damaged backup denied", "shared asset survives removal"], bytes: initial.bytes, projects: initial.projects.length, assets: initial.assets};
  });
  result.checks.push(...checked.checks);result.storage = checked;
  await page.getByRole("heading", {name: "Project two", exact: true}).waitFor();
  assert.match(await page.getByRole("status").textContent(), /2 of 10 Projects/);
  const second = await context.newPage();await second.goto("https://two.local-project.test/");
  assert.equal(await second.evaluate(async () => (await new (await import("/lib/localProjectStore.js")).LocalProjectStore().list()).projects.length), 0);
  result.checks.push("native library lists saved Projects and storage", "different origins cannot read this device library");
  assert.equal(result.externalRequests, 0);result.status = "passed-native-indexeddb-and-library";
} catch (error) {result.status = "failed";result.error = {name: error.name, message: error.message};process.exitCode = 1;}
finally {await browser?.close();result.browserClosed = true;result.finishedAt = new Date().toISOString();await writeFile(output, JSON.stringify(result, null, 2) + "\n");console.log(JSON.stringify(result));}
