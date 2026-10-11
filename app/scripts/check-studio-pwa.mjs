import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {readFile, stat} from "node:fs/promises";
import {createServer} from "node:http";
import {extname, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {chromium} from "playwright";

import {canonicalStudioRoutes} from "./application-route-inventory.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const previewOnly = process.env.OPENGEO_ATTACHMENT_PREVIEW_ONLY === "1" || process.env.OPENGEO_ATTACHMENT_DEVICE_UI_ONLY === "1" || process.env.OPENGEO_ATTACHMENT_RECOVERY_UI_ONLY === "1" || process.env.OPENGEO_ATTACHMENT_RECONCILE_UI_ONLY === "1";
const attachmentOnly = process.env.OPENGEO_ATTACHMENT_INDEXEDDB_ONLY === "1";
const distRoot = resolve(appRoot, "dist");
const aliases = new Map(canonicalStudioRoutes.map(([path, htmlPath]) => [path, htmlPath]));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/pwa-probe") {
      response.writeHead(200, {
        "cache-control": "private,no-store",
        "content-type": "application/json; charset=utf-8"
      });
      response.end(JSON.stringify({authority: "network-only-probe"}));
      return;
    }
    if (attachmentOnly && ["/__capture-test", "/__capture-module.js"].includes(url.pathname)) {
      response.writeHead(200, {"cache-control":"no-store", "content-type":url.pathname.endsWith('.js')?'text/javascript':'text/html'});
      response.end(url.pathname.endsWith('.js')?await readFile(resolve(appRoot,'src/lib/offlineCapture.js')):'<!doctype html><title>Local capture persistence</title>');
      return;
    }
    const relative = aliases.get(url.pathname)
      ?? (url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
    const path = resolve(distRoot, relative);
    if (path !== distRoot && !path.startsWith(`${distRoot}${sep}`)) throw new Error("unsafe path");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "cache-control": relative === "service-worker.js"
        ? "public,max-age=0,must-revalidate"
        : "public,max-age=60,must-revalidate",
      "content-type": contentType(path),
      ...(relative === "service-worker.js" ? {"service-worker-allowed": "/"} : {})
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    response.end("not found");
  }
});

await listen(server);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({headless: true, ...chromiumExecutable(),
  ...(process.env.OPENGEO_PUBLIC_DEMO_CAPTURE_COMPILED_ROOT ? {args:["--enable-unsafe-swiftshader"]} : {})});
const context = await browser.newContext({serviceWorkers: "allow"});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
try {
  if (process.env.OPENGEO_PUBLIC_DEMO_CAPTURE_ONLY === "1") {
    const {exercisePublicDemoCapture} = await import("./studio-attachment-previews.mjs");
    const deadlineMs=Number(process.env.OPENGEO_PUBLIC_DEMO_CAPTURE_DEADLINE_MS);
    let deadline;
    try {
      const journey=exercisePublicDemoCapture({page, context, baseUrl, appRoot});
      if(process.env.OPENGEO_PUBLIC_DEMO_CAPTURE_COMPILED_ROOT && Number.isFinite(deadlineMs) && deadlineMs>0) {
        await Promise.race([journey,new Promise((_,reject)=>{
          deadline=setTimeout(()=>reject(new Error('Compiled Demo capture deadline reached')),deadlineMs);
        })]);
      } else await journey;
    } finally {clearTimeout(deadline);}
  } else if (previewOnly) {
    const {exerciseAttachmentPreviews} = await import("./studio-attachment-previews.mjs");
    await exerciseAttachmentPreviews({page, context, baseUrl, appRoot});
  } else if (attachmentOnly) {
    await context.route('**/*', route => new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
    const ids={organizationId:'10000000-0000-4000-8000-000000000141',userId:'20000000-0000-4000-8000-000000000141'};
    const properties={photo:'81000000-0000-4000-8000-000000000001',observations:[{attachment:'81000000-0000-4000-8000-000000000002'}]};
    await page.goto(`${baseUrl}/__capture-test`);
    await page.evaluate(async({ids,properties})=>{
      await new Promise((resolve,reject)=>{const request=indexedDB.open('opengeo-field-capture-v1',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('submissions',{keyPath:'queueId'});
        request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
      const {OfflineCaptureQueue,OfflineAttachmentFiles}=await import('/__capture-module.js');
      await new OfflineAttachmentFiles().save(ids,{projectId:'50000000-0000-4000-8000-000000000141',classification:'internal',file:new File(['retained bytes'],'photo.png',{type:'image/png'})});
      await new OfflineCaptureQueue().enqueue(ids,{
        projectId:'50000000-0000-4000-8000-000000000141',datasetId:'80000000-0000-4000-8000-000000000141',
        formId:'a0000000-0000-4000-8000-000000000141',formVersion:1,submissionId:'b0000000-0000-4000-8000-000000000141',
        feature:{type:'Feature',geometry:{type:'Point',coordinates:[85,27]},properties}
      });
    },{ids,properties});
    await page.reload();
    const result=await page.evaluate(async(ids)=>{
      const {OfflineCaptureQueue,syncCaptureQueue,OfflineAttachmentFiles}=await import('/__capture-module.js');
      const files=new OfflineAttachmentFiles();const storedFiles=await files.list(ids);
      const fileBytes=await storedFiles[0].file.text();
      const foreignFiles=await files.list({...ids,userId:'20000000-0000-4000-8000-000000000142'});
      await files.remove(ids,storedFiles[0].id);
      const queue=new OfflineCaptureQueue();
      const before=await queue.list(ids);
      const foreign=await queue.list({...ids,userId:'20000000-0000-4000-8000-000000000142'});
      const denied=await syncCaptureQueue(queue,ids,async()=>{throw Object.assign(Error('revoked'),{status:403});});
      const retained=await queue.list(ids);
      let request;
      const accepted=await syncCaptureQueue(queue,ids,async value=>{request=value;});
      return {before,foreign,denied,retained,accepted,request,remaining:await queue.list(ids),fileBytes,foreignFiles,filesRemaining:await files.list(ids)};
    },ids);
    assert.equal(result.before.length,1);assert.deepEqual(result.before[0].request.feature.properties,properties);
    assert.deepEqual(result.foreign,[]);assert.equal(result.denied.stoppedReason,'access_denied');
    assert.deepEqual(result.retained,result.before);assert.deepEqual(result.request,result.before[0].request);
    assert.equal(result.accepted.synced,1);assert.deepEqual(result.remaining,[]);assert.deepEqual(pageErrors,[]);
    assert.equal(result.fileBytes,'retained bytes');assert.deepEqual(result.foreignFiles,[]);assert.deepEqual(result.filesRemaining,[]);
    console.log(JSON.stringify({status:'pass',scope:'attachment IndexedDB reference persistence',reload:true,
      partitionIsolation:true,deniedReplayRetained:true,unchangedRetryAcknowledged:true,
      databaseV1Upgrade:true,fileBytesSurviveReload:true,deviceFileIsolationAndRemoval:true,
      limits:'Actual headless Chromium IndexedDB; simulated submit refusal/acknowledgement. No installed PWA, device, offline binary upload or live API claim.'}));
  } else {
  await page.goto(`${baseUrl}/workspaces`, {waitUntil: "domcontentloaded"});
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({waitUntil: "domcontentloaded"});
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send("Page.getAppManifest");
  if (appManifest.errors?.length) {
    throw new Error(`Chromium rejected the web application manifest: ${JSON.stringify(appManifest.errors)}`);
  }
  const manifest = JSON.parse(appManifest.data);
  if (manifest.start_url !== "/workspaces"
    || manifest.scope !== "/"
    || manifest.display !== "standalone") {
    throw new Error(`Chromium resolved unexpected install metadata: ${JSON.stringify({
      start_url: manifest.start_url,
      scope: manifest.scope,
      display: manifest.display
    })}`);
  }

  const cacheState = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith("opengeo-studio-shell-"));
    const urls = [];
    for (const name of names) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return {names, urls: [...new Set(urls)].sort()};
  });
  if (cacheState.names.length !== 1
    || !cacheState.urls.includes("/workspaces")
    || !cacheState.urls.includes("/offline.html")
    || cacheState.urls.some((path) => path.startsWith("/api/") || path.includes("auth-config"))) {
    throw new Error("Installed shell cache crossed its reviewed boundary");
  }
  const probe = await page.evaluate(async () => (await fetch("/api/pwa-probe")).json());
  if (probe.authority !== "network-only-probe") throw new Error("API probe did not reach the network");

  await context.setOffline(true);
  const offlineApi = await page.evaluate(async () => {
    try {
      await fetch("/api/pwa-probe");
      return "unexpected-response";
    } catch (error) {
      return error.name;
    }
  });
  if (offlineApi === "unexpected-response") throw new Error("API response was cached by the service worker");
  const offlineResponse = await page.goto(
    `${baseUrl}/workspaces?project=00000000-0000-4000-8000-000000000001`,
    {waitUntil: "domcontentloaded"}
  );
  if (!offlineResponse || offlineResponse.status() !== 200 || !offlineResponse.fromServiceWorker()) {
    throw new Error("Installed Studio shell did not recover an offline project navigation");
  }
  await context.setOffline(false);
  if (pageErrors.some((message) => /SyntaxError|service-worker/i.test(message))) {
    throw new Error(`PWA page error: ${pageErrors.join("; ")}`);
  }

  console.log(JSON.stringify({
    status: "passed",
    browser: await browser.version(),
    manifestUrl: appManifest.url,
    manifestStartUrl: manifest.start_url,
    serviceWorkerControlled: true,
    cacheNames: cacheState.names,
    cachedShellRequests: cacheState.urls.length,
    credentialedApiCached: false,
    offlineProjectNavigation: true,
    backgroundSyncContract: "authenticated-open-client",
    installedOsWindowTested: false
  }, null, 2));
}
} finally {
  await context.setOffline(false).catch(() => {});
  await context.close();
  await browser.close();
  await close(server);
}

function contentType(path) {
  const extension = extname(path);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".webmanifest") return "application/manifest+json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function listen(httpServer) {
  return new Promise((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolvePromise);
  });
}

function close(httpServer) {
  return new Promise((resolvePromise, reject) => {
    httpServer.close((error) => error ? reject(error) : resolvePromise());
  });
}

function chromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? {executablePath} : {};
}
