import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";

const root = resolve("app/dist/demo-build");
const policySource = await readFile(resolve('infrastructure/lib/studio-web-stack.ts'), 'utf8');
const parentPolicy = [...policySource.slice(policySource.indexOf('export const STUDIO_CONTENT_SECURITY_POLICY = [')).split('].join')[0].matchAll(/"([^"]+)"/g)].map(match => match[1]).join('; ');
assert.ok(parentPolicy.includes("frame-src 'self' https://preview.studio.opengeo.tools"), 'Use the actual Demo parent CSP');
const types = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json", ".html": "text/html", ".pbf": "application/octet-stream"};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + "/")) throw Error("path");
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    if (file === resolve(root, 'index.html')) res.setHeader('Content-Security-Policy', parentPolicy);
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const live = process.env.OPEN_GEO_BROWSER_DEMO_LIVE === "1";
const origin = "https://demo.studio.opengeo.tools";
const peer = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const errors = [], errorStacks = [], consoleErrors = [], privateRequests = [], rendererRequests = [], offlineRequests = [];
const publicationsOnly = process.env.OPEN_GEO_DEMO_PUBLICATIONS_ONLY === '1';
const htmlDiagnostic = process.env.OPEN_GEO_DEMO_HTML_DIAGNOSTIC === '1';
const pointerDiagnostic = process.env.OPEN_GEO_DEMO_POINTER_DIAGNOSTIC === '1';
const previewToolsProbe = process.env.OPEN_GEO_DEMO_PREVIEW_TOOLS_PROBE === '1';
const frameReloadProbe = process.env.OPEN_GEO_DEMO_FRAME_RELOAD_PROBE === '1';
const evidence = resolve(process.env.OPEN_GEO_DEMO_EVIDENCE_DIR ?? '.local-archives/browser-demo-20260915');
const staticFixtures = process.env.OPEN_GEO_DEMO_STATIC_FIXTURES;
const selectedScene = staticFixtures ? JSON.parse(await readFile(resolve(staticFixtures, "pilot-selected.json"), "utf8")) : null;
const metadataReplays = [];
const publicationJourneys = [], publicationRequests = [], publicationHostRequests = [], draftShellRequests = [];
const draftShellResponses = [];
let publicationPhase = false;
let satelliteReferencesDownloaded = false;
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox"]});
  page = await browser.newPage({viewport: {width: 1280, height: 820}});
  // Playwright's context-wide serviceWorkers:'block' shim reads the getter in
  // opaque sandbox children and throws. Disable registration only in the top
  // application, before its PWA head runs; leave iframe globals untouched.
  await page.addInitScript(() => {
    if (window === window.top && 'serviceWorker' in navigator) {
      Object.defineProperty(navigator.serviceWorker, 'register', {configurable: true,
        value: () => Promise.reject(Error('Service worker registration is disabled in the local acceptance peer.'))});
    }
  });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => {errors.push(error.message); errorStacks.push(error.stack);});
  page.on('response', response => {
    if (response.url() === 'https://preview.studio.opengeo.tools/authorize/draft.html') {
      draftShellResponses.push({status: response.status(), csp: response.headers()['content-security-policy'] ?? null});
    }
  });
  page.on('console', message => {if (message.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(message.text());});
  await page.context().route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/renderer-runtime/')) rendererRequests.push(url.pathname);
    if (/\/api\/|auth-config|workspaces|login/.test(url.pathname)) privateRequests.push(url.href);
    if (publicationPhase && url.origin !== origin) {
      (route.request().frame() === page.mainFrame() ? publicationHostRequests : publicationRequests).push(url.href);
    }
    if (url.href === 'https://preview.studio.opengeo.tools/authorize/draft.html') {
      draftShellRequests.push(url.href);
      assert.equal(route.request().method(), 'GET');
      assert.equal(route.request().headers().authorization, undefined);
      assert.equal(route.request().headers().cookie, undefined);
      if (live) return route.continue();
      const edge = await readFile(resolve('infrastructure/lib/observable-preview-edge.ts'), 'utf8');
      const draftPolicy = [...edge.slice(edge.indexOf('export const OBSERVABLE_PREVIEW_DRAFT_CSP = [')).split('].join')[0].matchAll(/"([^"]+)"/g)].map(match => match[1]).join('; ');
      return route.fulfill({contentType: 'text/html', headers: {'Content-Security-Policy': draftPolicy, 'Cache-Control': 'no-store'}, body: await readFile(resolve('services/observable-preview/authorize/draft.html'))});
    }
    if (staticFixtures && url.href.startsWith("https://data.source.coop/tge-labs/s2-stac-geoparquet/")) {
      assert.equal(route.request().method(), "GET");
      assert.equal(route.request().headers().authorization, undefined);
      assert.ok(metadataReplays.length < 32, "Metadata replay ceiling");
      metadataReplays.push(url.pathname);
      let filename, status = 200;
      let headers = {"access-control-allow-origin": "*", "access-control-expose-headers": "Content-Range,ETag"};
      if (url.pathname.endsWith("/catalog.json")) filename = "catalog.json";
      else if (url.pathname.endsWith("/collection.json")) filename = "collection.json";
      else if (url.pathname.endsWith("/2015.json")) filename = "year-item-2015.json";
      else {
        assert.ok(url.pathname.endsWith("/items.parquet"));
        const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? "");
        assert.ok(range);
        filename = `pilot-range-${range[1]}-${range[2]}.bin`;
        status = 206;
        headers = {...headers, "content-range": `bytes ${range[1]}-${range[2]}/295728`, etag: selectedScene.snapshot.etag};
      }
      return readFile(resolve(staticFixtures, filename)).then(body => route.fulfill({status, headers, body}));
    }
    if (url.origin === origin) {
      if (live) return route.continue();
      return route.fetch({url: peer + url.pathname + url.search}).then(response => route.fulfill({response}));
    }
    // Only the selected static origin may receive requests; substitute an empty basemap.
    if (url.href.includes("/styles/")) return route.fulfill({json: {version: 8, sources: {}, layers: []}});
    return route.abort();
  });
  await page.goto(origin + "/?view=examples");
  await page.getByRole("heading", {name: "Explore OpenGeo", exact: true}).waitFor();
  assert.equal(await page.locator('#example-catalog [data-catalog-layer]').count(), 31);
  assert.equal(await page.locator('#example-publications a').count(), 4);
  assert.equal(await page.locator('[src*="editor-assets"],[href*="editor-assets"]').count(), 0, 'Editor assets must remain optional on overview');
  assert.equal(await page.locator('a[href="/workspaces"]').count(), 0);
  assert.equal(metadataReplays.length, 0, "Demo opened the satellite index before an explicit search");
  assert.equal(await page.locator('a[href="https://studio.opengeo.tools/workspaces?view=publishing"]').count(), 1);
  const search = page.locator("#satellite-scenes .platform-static-item-search");
  assert.equal(await search.count(), 1);
  if (!publicationsOnly) {
  if (selectedScene) {
    await search.locator("summary").click();
    await search.getByRole("button", {name: "Search scenes", exact: true}).click();
    const scene = search.locator(".platform-static-item-result").filter({hasText: selectedScene.id});
    await scene.getByRole("button", {name: "View asset references", exact: true}).click();
    const download = page.waitForEvent("download");
    await scene.getByRole("button", {name: "Download scene references", exact: true}).click();
    const file = await (await download).path();
    const reference = JSON.parse(await readFile(file, "utf8"));
    assert.equal(reference.id, selectedScene.id);
    assert.deepEqual(reference.assets, selectedScene.assets);
    assert.deepEqual(reference.original, selectedScene.original);
    assert.equal(reference.license, selectedScene.license);
    assert.equal(await search.getByRole("button", {name: "Review Catalog registration", exact: true}).count(), 0);
    satelliteReferencesDownloaded = true;
    for (const width of [1280, 390]) {
      await page.setViewportSize({width, height: 844});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "Demo examples overflow the viewport");
    }
  }
  await page.setViewportSize({width: 1280, height: 820});
  await page.goto(origin + "/?map=community-facilities");
  await page.locator(".opengeo-workbench").waitFor();
  assert.equal(await page.getByRole("link", {name: "Explore MassGIS", exact: true}).count(), 1);
  assert.equal(await page.getByRole("link", {name: "Satellite scenes", exact: true}).count(), 1);
  await page.waitForFunction(() => {
    const map = document.querySelector('.opengeo-workbench')?.__opengeoMap;
    return map?.loaded() && map.getCanvas().width > 0;
  });
  assert.deepEqual(rendererRequests, [], 'Optional renderer SDKs loaded before engine selection');
  await page.locator('[data-menu="edit"] > button').click();
  await page.getByRole("menuitem", {name: "Temporary annotations and uploads…", exact: true}).click();
  await page.getByRole("button", {name: /^Edit a copy ·/}).first().click();
  await page.getByRole("button", {name: "Edit geometry", exact: true}).click();
  await page.locator('[data-temporary-coordinate="longitude"]').fill("-71");
  await page.getByRole("button", {name: "Apply coordinate", exact: true}).click();
  await page.getByRole("button", {name: "Save geometry changes", exact: true}).first().click();
  assert.equal(await page.locator('[data-persistence="temporary"]').count(), 1);
  await mkdir(evidence, {recursive: true});
  await page.locator('[data-menu="project"] > button').click();
  await page.getByRole("menuitem", {name: "Save as / export…", exact: true}).click();
  const formats = page.getByRole("dialog", {name: "Save as or export Project", exact: true});
  await formats.getByRole("combobox", {name: "Project export format", exact: true}).selectOption("html");
  await formats.getByRole("button", {name: "Export file", exact: true}).click();
  const dialog = page.locator(".static-map-export-dialog");
  await dialog.locator('input[type="checkbox"]').last().check();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", {name: "Download HTML", exact: true}).click();
  const exportPath = resolve(evidence, "editable-sample-offline.html");
  await (await downloaded).saveAs(exportPath);
  const html = await readFile(exportPath, "utf8");
  // MapLibre 6 uses a bundled Blob worker. Offline output may connect to that
  // local Blob, but must never authorize HTTP(S), relative or wildcard sources.
  const connectSources = /(?:^|;)\s*connect-src\s+([^;]+)/.exec(
    /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? ''
  )?.[1].trim().split(/\s+/);
  assert.ok(connectSources?.length && connectSources.every(value =>
    value === 'blob:' || value === '&#39;none&#39;'), 'Offline export permits network connections');
  const offline = await browser.newPage();
  const offlineErrors = [];
  offline.on("pageerror", error => offlineErrors.push(error.message));
  await offline.route(/^https?:/, route => { offlineRequests.push(route.request().url()); return route.abort(); });
  await offline.goto(new URL("file://" + exportPath).href);
  await offline.locator(".maplibregl-canvas").waitFor();
  assert.deepEqual(offlineRequests, []);
  assert.deepEqual(offlineErrors, []);
  await offline.close();
  await dialog.getByRole("button", {name: "Close", exact: true}).click();
  await formats.getByRole("button", {name: "Close", exact: true}).click();
  await page.screenshot({path: resolve(evidence, "desktop.png")});
  for (const width of [760, 390]) {
    await page.setViewportSize({width, height: 844});
    assert.ok(await page.locator(".maplibregl-canvas").count());
    const box = await page.locator(".gis-map").boundingBox();
    assert.ok(box && box.width > 0 && box.x + box.width <= width + 2);
    await page.screenshot({path: resolve(evidence, `width-${width}.png`)});
  }
  }
  publicationPhase = true;
  await mkdir(evidence, {recursive: true});
  await page.setViewportSize({width: 1280, height: 820});
  for (const format of htmlDiagnostic || frameReloadProbe ? ['framework'] : ['framework', 'notebook', 'jupyter', 'html']) {
    await page.goto(origin + '/?publication=' + format);
    const workspace = page.locator('.public-demo-publication-workspace');
    await workspace.getByRole('combobox', {name: 'Demo publication', exact: true}).waitFor();
    await page.waitForFunction(() => document.querySelector('.public-demo-publication-workspace textarea[aria-label="Publication source"]')?.value.length > 0);
    await workspace.getByRole('tab', {name: 'Preview', exact: true}).click();
    const frame = workspace.frameLocator('iframe[title="Demo publication preview"]');
    if (format === 'framework') await frame.frameLocator('iframe').getByText('A browser publication', {exact: true}).waitFor();
    else if (format === 'notebook') await frame.getByText('Value: 50', {exact: true}).waitFor();
    else if (format === 'jupyter') {await frame.getByText('290', {exact: true}).waitFor(); assert.match(await workspace.textContent(), /no Python kernel/);}
    else {
      await frame.getByRole('heading', {name: 'A standalone HTML publication'}).waitFor();
      await frame.locator('#minimum').evaluate(element => {element.value = '100'; element.dispatchEvent(new Event('input', {bubbles: true}));});
      assert.equal(await frame.locator('tbody tr:visible').count(), 1);
    }
    const sourceDownload = page.waitForEvent('download');
    await workspace.getByRole('button', {name: 'Download source', exact: true}).click();
    const sourceBundle = JSON.parse(await readFile(await (await sourceDownload).path(), 'utf8'));
    assert.equal(sourceBundle.format, format); assert.ok(sourceBundle.files.some(file => file.relativePath === sourceBundle.entryPath));
    const htmlButton = workspace.getByRole('button', {name: 'Download preview HTML', exact: true});
    if (htmlDiagnostic) {
      if (previewToolsProbe) await htmlButton.evaluate(element => {
        const preview = element.parentElement;
        const tools = document.createElement('div');
        tools.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
        tools.append(preview.querySelector('button'), element); preview.prepend(tools);
        const host = element.closest('.public-workbench-demo');
        host.style.overflowY = 'auto'; host.style.display = 'block';
      });
      const geometry = () => htmlButton.evaluate(element => {
        const rect = value => {const box = value.getBoundingClientRect(); return {x: box.x, y: box.y, width: box.width, height: box.height};};
        const box = element.getBoundingClientRect(), top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        const style = value => {const css = getComputedStyle(value); return {display: css.display, visibility: css.visibility, pointerEvents: css.pointerEvents, overflow: css.overflow, overflowX: css.overflowX, overflowY: css.overflowY, position: css.position, zIndex: css.zIndex};};
        const ancestors = []; let parent = element.parentElement;
        while (parent && ancestors.length < 10) {ancestors.push({tag: parent.tagName, className: parent.className, hidden: parent.hidden, rect: rect(parent), style: style(parent), scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight}); parent = parent.parentElement;}
        return {button: {disabled: element.disabled, onclick: typeof element.onclick, rect: rect(element), style: style(element)},
          topElement: top ? {tag: top.tagName, className: top.className, label: top.getAttribute('aria-label'), title: top.getAttribute('title')} : null,
          viewport: {width: innerWidth, height: innerHeight, scrollY}, ancestors,
          status: [...element.closest('.public-demo-publication-workspace').children].filter(child => child.getAttribute('role') === 'status').map(child => child.textContent)};
      });
      const before = await geometry();
      if (pointerDiagnostic) await htmlButton.evaluate(element => {
        const trace = globalThis.openGeoDownloadTrace = [];
        const describe = target => target?.tagName ? {tag: target.tagName,
          button: target === element, text: target.tagName === 'BUTTON' ? target.textContent : null} : null;
        for (const type of ['pointerdown', 'mousedown', 'focusin', 'pointerup', 'mouseup', 'click', 'keydown']) {
          document.addEventListener(type, event => {
            if (trace.length >= 40) return;
            const box = element.getBoundingClientRect();
            trace.push({type, target: describe(event.target), active: describe(document.activeElement),
              x: event.clientX ?? null, y: event.clientY ?? null, top: box.top,
              trusted: event.isTrusted, defaultPrevented: event.defaultPrevented});
          }, true);
        }
        const action = element.onclick;
        element.onclick = function(event) {trace.push({type: 'callback', trusted: event.isTrusted}); return action.call(this, event);};
      });
      const eventPromise = page.waitForEvent('download', {timeout: pointerDiagnostic ? 5_000 : 15_000});
      const [click, event] = await Promise.allSettled([htmlButton.click({timeout: 5_000}), eventPromise]);
      let keyboard;
      if (pointerDiagnostic && event.status === 'rejected') {
        const [press, download] = await Promise.allSettled([
          htmlButton.press('Enter', {timeout: 5_000}), page.waitForEvent('download', {timeout: 5_000})
        ]);
        keyboard = {press: press.status, download: download.status};
      }
      const result = {status: 'diagnostic-complete', previewToolsProbe, tree: JSON.parse(await readFile(resolve('dist/opengeo-demo-build.json'), 'utf8')).artifactTree.digest,
        click: click.status === 'fulfilled' ? {status: click.status} : {status: click.status, error: click.reason.message},
        download: event.status === 'fulfilled' ? {status: event.status, suggestedFilename: event.value.suggestedFilename()} : {status: event.status, error: event.reason.message},
        before, after: await geometry(), keyboard, trace: pointerDiagnostic ? await page.evaluate(() => globalThis.openGeoDownloadTrace) : undefined,
        errors, privateRequests, publicationRequests, draftShellResponses, externalProvidersContacted: 0, publicShellReplayed: !live};
      await page.screenshot({path: resolve(evidence, 'html-download-diagnostic.png')});
      await writeFile(resolve(evidence, 'html-download-diagnostic.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      break;
    }
    const htmlDownload = page.waitForEvent('download');
    await htmlButton.click();
    const publicationPath = resolve(evidence, `publication-${format}-preview.html`);
    await (await htmlDownload).saveAs(publicationPath);
    const disconnected = await browser.newPage(); const disconnectedRequests = [], disconnectedErrors = [];
    disconnected.on('pageerror', error => disconnectedErrors.push(error.message));
    await disconnected.route(/^https?:/, route => {disconnectedRequests.push(route.request().url()); return route.abort();});
    await disconnected.goto(new URL('file://' + publicationPath).href);
    if (format === 'framework') await disconnected.getByRole('heading', {name: 'A browser publication', exact: true}).waitFor();
    else if (format === 'notebook') await disconnected.getByText('Value: 50', {exact: true}).waitFor();
    else if (format === 'jupyter') await disconnected.getByText('290', {exact: true}).waitFor();
    else await disconnected.getByRole('heading', {name: 'A standalone HTML publication'}).waitFor();
    assert.deepEqual(disconnectedRequests, []); assert.deepEqual(disconnectedErrors, []);
    await disconnected.close();
    if (frameReloadProbe) await workspace.locator('iframe[title="Demo publication preview"]').evaluate(frame => {
      const remove = frame.removeAttribute.bind(frame);
      frame.removeAttribute = function(name) {
        remove(name);
        if (name === 'src' && frame.isConnected) {
          const parent = frame.parentNode, sibling = frame.nextSibling;
          frame.remove(); parent.insertBefore(frame, sibling);
        }
      };
    });
    await workspace.getByRole('tab', {name: 'Publish', exact: true}).click();
    await workspace.getByRole('button', {name: 'Prepare simulated release review', exact: true}).click();
    await workspace.getByText('Source snapshot ready for review. This release stays in this tab.', {exact: true}).waitFor();
    await workspace.getByRole('checkbox', {name: 'Approve this simulated release', exact: true}).check();
    await workspace.getByRole('button', {name: 'Complete simulated release', exact: true}).click();
    await workspace.getByText(/Simulated release complete/).waitFor();
    publicationJourneys.push({format, sourceFiles: sourceBundle.files.length, preview: true, sourceDownloaded: true, approvedSimulatedRelease: true, disconnectedEntryHtml: true});
    if (frameReloadProbe) break;
    await workspace.getByRole('tab', {name: 'Files', exact: true}).click();
    await page.evaluate(() => {
      const source = document.querySelector('.public-demo-publication-workspace textarea[aria-label="Publication source"]');
      source.value += '\n<!-- A temporary visitor edit -->'; source.dispatchEvent(new Event('input', {bubbles: true}));
    });
    assert.equal(await workspace.getByRole('button', {name: 'Complete simulated release', exact: true, includeHidden: true}).isEnabled(), false);
    if (format === 'notebook' || format === 'jupyter') {
      assert.equal(await workspace.locator('.notebook-cell-workspace').isVisible(), false, 'Source mode exposes inactive cell controls');
    }
    await page.screenshot({path: resolve(evidence, `publication-${format}.png`)});
  }
  if (!htmlDiagnostic && !frameReloadProbe) {
  // The final HTML draft also exercises a created Publication and idle reset;
  // fake time advances only this local in-memory lifetime, without real waiting.
  const workspace = page.locator('.public-demo-publication-workspace');
  await workspace.locator('.publication-commands summary').filter({hasText: /^File$/}).click();
  await workspace.getByRole('button', {name: 'New publication…', exact: true}).click();
  const newPublication = workspace.getByRole('dialog', {name: 'New publication', exact: true});
  await newPublication.getByRole('textbox', {name: 'Publication title', exact: true}).fill('Visitor publication');
  await newPublication.getByRole('combobox', {name: 'Publication format', exact: true}).selectOption('html');
  await newPublication.getByRole('button', {name: 'Create browser publication', exact: true}).click();
  await workspace.getByRole('heading', {name: 'Visitor publication', exact: true}).waitFor();
  assert.equal(await workspace.locator('select[aria-label="Demo publication"] option').count(), 5);
  // Advance only the application deadline and invoke its existing resume check.
  // A global Playwright clock shim also instruments opaque child frames.
  await page.evaluate(() => {
    const original = Date.now;
    Date.now = () => original() + 300_100;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await workspace.getByText('Drafts reset after inactivity. Download your source before leaving.', {exact: true}).waitFor();
  assert.equal(await workspace.locator('select[aria-label="Demo publication"] option').count(), 4);
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Publication editor overflows viewport');
    await page.screenshot({path: resolve(evidence, `publication-reset-${width}.png`)});
  }
  assert.ok(publicationRequests.every(url => url === 'https://preview.studio.opengeo.tools/authorize/draft.html'), 'Publication source attempted external network access');
  publicationPhase = false;
  assert.deepEqual(privateRequests, []);
  assert.deepEqual(errors, []);
  const manifest = JSON.parse(await readFile(resolve("dist/opengeo-demo-build.json"), "utf8"));
  const result = {status: "passed", origin, mode: live ? 'hosted' : 'local-peer', scope: frameReloadProbe ? 'frame-reload-probe' : publicationsOnly ? 'publications-only' : 'complete-demo', tree: manifest.artifactTree.digest, externalProvidersContacted: 0, privateRequests, errors, eagerRendererRequests: rendererRequests, satelliteReferencesDownloaded, metadataReplays: metadataReplays.length, noEagerSatelliteReads: true, studioPublishingDestination: true, editableSampleCopy: !publicationsOnly, offlineHtmlExport: !publicationsOnly, offlineRequests, publicationJourneys, publicationRequests, publicationHostRequests, draftShellRequests: draftShellRequests.length, draftShellResponses, publicShellReplayed: !live, simulatedReleasesOnly: true, publicationIdleReset: !frameReloadProbe, widths: frameReloadProbe ? [1280] : publicationsOnly ? [1280,390] : [1280, 760, 390]};
  await writeFile(resolve(evidence, live ? "live-browser-check.json" : "browser-check.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(JSON.stringify({errors, errorStacks, consoleErrors, privateRequests, draftShellRequests, draftShellResponses, publicationRequests, failure: error.message, frameUrls: page?.frames().map(frame => frame.url()),
    publicationState: await page?.locator('.public-demo-publication-workspace').evaluate(element => ({
      status: [...element.children].filter(child => child.getAttribute('role') === 'status').map(child => child.textContent),
      htmlDownloadDisabled: [...element.querySelectorAll('button')].find(button => button.textContent === 'Download preview HTML')?.disabled
    })).catch(() => null)}));
  await mkdir(resolve(process.env.OPEN_GEO_DEMO_EVIDENCE_DIR ?? ".local-archives/browser-demo-20260915"), {recursive: true});
  await page?.screenshot({path: resolve(process.env.OPEN_GEO_DEMO_EVIDENCE_DIR ?? ".local-archives/browser-demo-20260915", "failure.png")});
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
