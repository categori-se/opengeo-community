import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve, extname} from "node:path";
import {chromium} from "playwright";
import {createHash} from "node:crypto";
import {safeJoin, verifyManifestSeal} from "./release-utils.mjs";

if (process.env.OPEN_GEO_ENTRY_ROUTES === "1") {
  await checkEntryRoutes();
  process.exit(process.exitCode ?? 0);
}

async function checkLocalWorkspace() {
  const exportsOnly = process.env.OPEN_GEO_LOCAL_EXPORTS === "1";
  const batch = resolve(process.env.OPEN_GEO_LOCAL_WORKSPACE_ROOT ?? ".local-archives/renderer-switch-20260930/local-project-library-20261016");
  const output = resolve(process.env.OPEN_GEO_LOCAL_WORKSPACE_OUTPUT ?? `${batch}/compiled-workspace.json`);
  const limits = exportsOnly ? {seconds: 90, softwareRequests: 240, softwareBytes: 24 * 1024 * 1024, basemapSubstitutions: 2}
    : {seconds: 180, softwareRequests: 2400, softwareBytes: 100663296, basemapSubstitutions: 16};
  const priorPath = process.env.OPEN_GEO_LOCAL_WORKSPACE_PRIOR;
  const outputReview = process.env.OPEN_GEO_LOCAL_WORKSPACE_OUTPUT_REVIEW === "1";
  const prior = priorPath ? JSON.parse(await readFile(resolve(priorPath), "utf8")) : null;
  if (prior) {assert.notEqual(resolve(priorPath), output);assert.equal(prior.status, outputReview ? "passed-compiled-local-workspace-print-backup" : "stopped-no-retry");if (!outputReview) assert.equal(prior.stage, "native-local-import");assert(prior.browserClosed);}
  const carried = prior?.cumulative ?? {softwareRequests: prior?.softwareRequests ?? 0, softwareBytes: prior?.softwareBytes ?? 0, elapsedMilliseconds: prior?.elapsedMilliseconds ?? 0, basemapSubstitutions: prior?.basemapSubstitutions ?? 0};
  carried.basemapSubstitutions ??= prior?.basemapSubstitutions ?? 0;
  const begun = Date.now(), result = {status: "started", startedAt: new Date().toISOString(), stage: "load-seals", limits,
    softwareRequests: 0, softwareBytes: 0, basemapSubstitutions: 0, optionalFontsAborted: 0, externalRequests: 0, errors: [], checks: [], browserClosed: false, carried};
  const sites = new Map(), cache = new Map();let browser, page, stopped;
  const persist = () => writeFile(output, JSON.stringify(result, null, 2) + "\n");
  await persist();
  const within = () => {if (stopped) throw stopped;assert(Date.now() - begun + carried.elapsedMilliseconds < limits.seconds * 1000, "Finite local-workspace window");};
  const check = name => {result.checks.push(name);};
  let timer;
  try {
    for (const [origin, workspace, directory, manifestName] of [
      ["https://demo.studio.opengeo.tools", "demo-source", "app/dist/demo-build", "opengeo-demo-build.json"],
      ["https://studio.opengeo.tools", "source", "app/dist", "opengeo-studio-build.json"]
    ]) {
      const manifest = JSON.parse(await readFile(resolve(batch, workspace, "dist", manifestName), "utf8"));
      verifyManifestSeal(manifest, "Local-workspace compiled source");
      sites.set(origin, {root: resolve(batch, workspace, directory), manifest, files: new Map(manifest.artifactTree.files.map(file => [file.path, file]))});
    }
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
    const context = await browser.newContext({viewport: {width: 1369, height: 982}, serviceWorkers: "block", acceptDownloads: true, colorScheme: "light"});
    result.artifactTrees = [...sites].map(([origin, site]) => ({origin, tree: site.manifest.artifactTree.digest}));
    if (prior?.artifactTrees && !outputReview) assert.deepEqual(result.artifactTrees, prior.artifactTrees, "Reuse unchanged compiled source after a harness-only correction");
    if (outputReview) result.previousArtifactTrees = prior.artifactTrees;
    timer = setTimeout(() => {stopped = Error("Local-workspace deadline");void context.close().catch(() => {});}, limits.seconds * 1000 - carried.elapsedMilliseconds);
    await context.route("**/*", async route => {
      try {
        within();const request = route.request(), url = new URL(request.url());
        if (["blob:", "data:"].includes(url.protocol)) return route.continue();
        assert.equal(request.method(), "GET", "No upload or API mutation");
        if (["https://fonts.googleapis.com", "https://fonts.gstatic.com"].includes(url.origin)) {result.optionalFontsAborted++;return route.abort();}
        if (url.origin === "https://tiles.openfreemap.org" && /^\/styles\/(?:positron|liberty|bright|dark|fiord)\/?$/.test(url.pathname)) {
          assert(++result.basemapSubstitutions + carried.basemapSubstitutions <= limits.basemapSubstitutions);
          return route.fulfill({json: {version: 8, sources: {}, layers: [{id: "blank", type: "background", paint: {"background-color": "#e9eff4"}}]}});
        }
        const site = sites.get(url.origin);assert(site, `Unapproved transport origin ${url.origin}`);
        const relative = site.manifest.routes.find(item => item.path === url.pathname)?.htmlPath
          ?? (url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
        let seal = site.files.get(relative);
        if (!seal && url.origin === "https://studio.opengeo.tools" && relative === "auth-config.json") {
          const bytes = await readFile(safeJoin(site.root, relative));seal = {bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
        }
        assert(seal, `Only sealed software may load: ${relative}`);
        const key = `${url.origin}/${relative}`;
        let body = cache.get(key);
        if (!body) {
          body = await readFile(safeJoin(site.root, relative));assert.equal(body.length, seal.bytes);
          assert.equal(createHash("sha256").update(body).digest("hex"), seal.sha256);cache.set(key, body);
        }
        assert(++result.softwareRequests + carried.softwareRequests <= limits.softwareRequests);
        assert((result.softwareBytes += body.length) + carried.softwareBytes <= limits.softwareBytes);
        const type = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml"}[extname(relative)] ?? "application/octet-stream";
        return route.fulfill({status: 200, contentType: type, body});
      } catch (error) {result.externalRequests++;result.firstRouteError ??= {url: route.request().url(), name: error.name, message: error.message};stopped ??= error;await route.abort().catch(() => {});}
    });
    page = await context.newPage();page.setDefaultTimeout(10000);
    page.on("pageerror", error => {result.errors.push(error.message);stopped ??= error;});
    const mainSelector = ".public-workbench-demo .opengeo-workbench";
    const main = () => page.locator(mainSelector).first();
    const ready = selector => page.waitForFunction(selector => {
      const shell = document.querySelector(selector), state = shell?.getPrintContext?.(), map = state?.map;
      return state?.ready && map?.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving()
        && shell.__opengeoLayers?.length === 1 && map.queryRenderedFeatures().some(feature => feature.layer.id.startsWith(shell.__opengeoLayers[0].layerId));
    }, selector, {timeout: 20000});
    const menu = async (scope, name) => {
      await scope.locator('.gis-menu-wrap[data-menu="project"] > button').click();
      await scope.getByRole("menuitem", {name, exact: true}).click();
    };
    const saveAs = async title => {
      const dialog = page.getByRole("dialog", {name: "Save personal Project", exact: true});
      await dialog.getByLabel("Personal Project title", {exact: true}).fill(title);
      await dialog.getByRole("button", {name: "Save Project", exact: true}).click();
      await page.waitForFunction(() => new URL(location.href).searchParams.has("localProject") && document.querySelector(".gis-role-badge")?.textContent === "Saved on this device");
    };
    const snapshot = () => main().evaluate(shell => ({layers: shell.getPrintContext().project.layers, data: [...shell.__opengeoData], layouts: shell.getPrintContext().project.extensions?.opengeoPrintLayouts}));
    result.stage = "native-local-import";await persist();
    await page.goto("https://demo.studio.opengeo.tools/?map=community-facilities");await main().waitFor();
    await menu(main(), "New empty demo map");
    await main().getByRole("button", {name: "Add data", exact: true}).first().click();
    const data = {type: "FeatureCollection", features: [
      {type: "Feature", properties: {name: "Clinic A", status: "Open"}, geometry: {type: "Point", coordinates: [-77.04, 38.91]}},
      {type: "Feature", properties: {name: "Clinic B", status: "Open"}, geometry: {type: "Point", coordinates: [-77.03, 38.915]}}
    ]};
    await main().locator('.gis-file-drop input[type="file"]').setInputFiles({name: "local-clinics.geojson", mimeType: "application/geo+json", buffer: Buffer.from(JSON.stringify(data))});
    const review = page.locator(".browser-layer-registration");await review.getByLabel("Layer title", {exact: true}).fill("Local clinics");
    await review.getByLabel("License", {exact: true}).fill("CC0-1.0");await review.getByLabel("Attribution", {exact: true}).fill("Synthetic clinic fixture");
    await review.getByRole("button", {name: "Add Layer to Project", exact: true}).click();await ready(mainSelector);
    await main().getByLabel("Layer actions for Local clinics", {exact: true}).click();
    const opacity = main().locator(".gis-layer-more[open] .gis-layer-opacity input[type=range]");await opacity.press("End");await opacity.press("ArrowLeft");await opacity.press("ArrowLeft");
    const styled = await snapshot();assert(styled.layers[0].opacity > 0 && styled.layers[0].opacity < 1);
    await main().getByLabel("Layer actions for Local clinics", {exact: true}).click();
    if (exportsOnly) {
      const {unzipSync, strFromU8} = await import("fflate");
      const {readPublicationSourceArchive} = await import("../src/lib/publicationSourceArchive.js");
      const {verifyPortableMapArtifact} = await import("../src/lib/portableMapArtifact.js");
      const receive = async (scope, button, name) => {
        const pending=page.waitForEvent("download");await scope.getByRole("button",{name:button,exact:true}).click();
        const download=await pending, path=resolve(batch,name);await download.saveAs(path);return readFile(path);
      };
      result.stage="compiled-native-developer-export";await persist();
      await menu(main(),"Publish with OpenGeo…");const exportDialog=page.locator(".static-map-export-dialog");await exportDialog.waitFor();
      await exportDialog.getByLabel("Format",{exact:true}).selectOption("developer");
      await exportDialog.getByRole("checkbox",{name:/I have reviewed/}).check();
      const developer=unzipSync(await receive(exportDialog,"Download developer ZIP","compiled-map.developer.zip"));
      const developerManifest=JSON.parse(strFromU8(developer["manifest.json"]));
      assert.equal(developerManifest.viewer.mode,"native");assert.equal(developerManifest.fullyOffline,true);
      for(const file of developerManifest.files){assert.equal(developer[file.path].length,file.bytes);assert.equal(createHash("sha256").update(developer[file.path]).digest("hex"),file.checksumSha256);}
      assert.doesNotMatch(strFromU8(developer["map.mjs"]),/createElement\(["']iframe/);
      check("Compiled Workbench downloads the native developer ZIP with exact file hashes and embedded selected data");
      result.stage="compiled-publishing-handoff";await persist();
      await exportDialog.getByLabel("Format",{exact:true}).selectOption("publication");
      const publicationBytes=await receive(exportDialog,"Download publishing ZIP","compiled-map.publication-source.zip");
      const imported=await readPublicationSourceArchive(new Blob([publicationBytes]));
      const mapFile=imported.files.find(file=>file.relativePath==="index.html"),sidecar=imported.files.find(file=>file.relativePath==="index.html.artifact.json");
      await verifyPortableMapArtifact(mapFile.blob,JSON.parse(await sidecar.blob.text()));
      assert.equal(imported.manifest.metadata.rightsStatus,"unreviewed");
      assert.equal(await exportDialog.getByRole("link",{name:"Continue in Studio Publications ↗"}).getAttribute("href"),"https://studio.opengeo.tools/workspaces?view=publishing");
      check("Compiled Demo prepares the existing source-import ZIP and deliberate account route without upload/authentication");
      await exportDialog.getByRole("button",{name:"Close",exact:true}).click();
      result.stage="compiled-figure-print-pack";await persist();
      await menu(main(),"Open Print Studio");const print=page.getByRole("dialog",{name:"Local Print Studio",exact:true});await print.waitFor();
      await ready(".browser-print-studio .opengeo-workbench");
      await print.getByRole("button",{name:"Capture map frame",exact:true}).click();
      await print.getByRole("status").first().filter({hasText:"Captured Main map"}).waitFor();
      const figure=unzipSync(await receive(print,"Download figure and print ZIP","compiled-map.figure-print.zip"));
      const manifest=JSON.parse(strFromU8(figure["manifest.json"]));assert.equal(manifest.pdf.representation,"raster-page");
      for(const file of manifest.files){assert.equal(figure[file.path].length,file.sizeBytes);assert.equal(createHash("sha256").update(figure[file.path]).digest("hex"),file.checksumSha256);}
      assert.equal(Buffer.from(figure["page.pdf"]).subarray(0,5).toString(),"%PDF-");
      assert.ok(Buffer.from(figure["page.pdf"]).indexOf(Buffer.from(figure["page.jpg"]))>0);
      await writeFile(resolve(batch,"compiled-page.pdf"),figure["page.pdf"]);await writeFile(resolve(batch,"compiled-page.png"),figure["page.png"]);
      assert.deepEqual((await snapshot()).layers,styled.layers);assert.deepEqual((await snapshot()).data,styled.data);
      check("Compiled local Print captures the current Project and downloads PNG/JPEG/paper PDF/layout/context with matching hashes; canonical data/style unchanged");
      within();assert.equal(result.externalRequests,0);assert.deepEqual(result.errors,[]);result.status="passed-compiled-local-exports";return;
    }
    await main().getByRole("button", {name: "Save locally", exact: true}).click();await saveAs("Local clinics one");
    const firstUrl = page.url(), firstId = new URL(firstUrl).searchParams.get("localProject");assert(firstId);
    await page.reload();await ready(mainSelector);const reopened = await snapshot();
    assert.deepEqual(reopened.layers, styled.layers);assert.deepEqual(reopened.data[0][1], data);
    check("Actual GeoJSON import/review/style/personal Save/reload preserves geometry and Layer presentation without an account");
    result.stage = "native-local-print";await persist();
    await menu(main(), "Open Print Studio");const print = page.getByRole("dialog", {name: "Local Print Studio", exact: true});await print.waitFor();
    await ready(".browser-print-studio .opengeo-workbench");
    await print.getByLabel("Layout title", {exact: true}).fill("Local clinic A4");await print.getByLabel("Layout title", {exact: true}).press("Tab");
    await print.getByRole("button", {name: "Capture map frame", exact: true}).click();
    await print.getByRole("status").first().filter({hasText: "Captured Main map"}).waitFor();
    await print.getByRole("button", {name: "Save layout", exact: true}).click();await print.getByRole("status").first().filter({hasText: "Layout saved with this browser draft"}).waitFor();
    const pngPromise = page.waitForEvent("download");await print.getByRole("button", {name: "Download page PNG", exact: true}).click();
    const pngDownload = await pngPromise;await pngDownload.saveAs(resolve(batch, "local-clinic-page.png"));
    const pngBytes = await readFile(resolve(batch, "local-clinic-page.png"));assert.equal(pngBytes.subarray(1, 4).toString(), "PNG");
    await print.getByRole("button", {name: "Print / Save PDF", exact: true}).click();const paper = await print.locator('iframe[title="Print layout"]').getAttribute("srcdoc");assert(paper.includes("Local clinic A4"));
    if (outputReview) {assert(paper.includes("Synthetic clinic fixture"), "Reviewed source credit must print");assert(paper.includes('fill="#06b6d4"'), "Known single-symbol legend swatch must print");}
    const pdfPage = await context.newPage();await pdfPage.setContent(paper);await pdfPage.pdf({path: resolve(batch, "local-clinic-page.pdf"), preferCSSPageSize: true, printBackground: true});await pdfPage.close();
    assert((await readFile(resolve(batch, "local-clinic-page.pdf"))).subarray(0, 5).toString() === "%PDF-");
    await print.evaluate(node => {node.scrollTop = 0;});await print.screenshot({path: resolve(batch, "local-print-light.png")});
    await print.getByRole("button", {name: "Back to map", exact: true}).click();await page.reload();await ready(mainSelector);
    const withLayout = await snapshot();assert.deepEqual(withLayout.layers, reopened.layers);assert.deepEqual(withLayout.data, reopened.data);
    assert.equal(withLayout.layouts.layouts[0].title, "Local clinic A4");assert(!JSON.stringify(withLayout.layouts).includes("data:image"));
    await menu(main(), "Open Print Studio");await print.getByLabel("Layout title", {exact: true}).waitFor();assert.equal(await print.getByLabel("Layout title", {exact: true}).inputValue(), "Local clinic A4");
    await print.getByRole("button", {name: "Back to map", exact: true}).click();
    check("Personal Print captures actual MapLibre pixels, saves/reopens its layout, produces PNG and A4 PDF, and preserves original geometry/style");
    result.stage = "two-project-library-backup-restore";await persist();
    await menu(main(), "Save a personal copy…");await saveAs("Local clinics two");
    await page.waitForFunction(first => new URL(location.href).searchParams.get("localProject") !== first, firstId);
    await main().getByRole("button", {name: "Dark", exact: true}).click();
    await main().getByRole("button", {name: "Save locally", exact: true}).click();
    await main().locator(".gis-statusbar").filter({hasText: "Saved on this device · revision 2"}).waitFor();
    await main().getByRole("button", {name: "On this device", exact: true}).click();
    const library = page.getByRole("dialog", {name: "Projects on this device", exact: true});await library.getByRole("heading", {name: "Local clinics two", exact: true}).waitFor();
    const firstCard = library.locator("article").filter({hasText: "Local clinics one"});
    const backupPromise = page.waitForEvent("download");await firstCard.getByRole("button", {name: "Download backup", exact: true}).click();
    const backup = await backupPromise;const backupPath = resolve(batch, "local-clinics.opengeo-project.zip");await backup.saveAs(backupPath);
    if (outputReview) {
      const {unzipSync, strFromU8} = await import("fflate");
      const files = unzipSync(await readFile(backupPath)), manifest = JSON.parse(strFromU8(files["manifest.json"]));
      assert.equal(manifest.dependencies[0].curatedAttribution, "Synthetic clinic fixture");assert.equal(manifest.dependencies[0].license, "CC0-1.0");
    }
    await library.getByLabel("Import Project backup", {exact: true}).setInputFiles(backupPath);
    await library.getByRole("button", {name: "Save imported Project", exact: true}).click();await library.getByRole("status").filter({hasText: "3 of 10 Projects"}).waitFor();
    await library.screenshot({path: resolve(batch, "local-library-dark.png")});
    const restoredCard = library.locator("article").filter({hasText: "Local clinics one"});
    const links = await restoredCard.locator("a").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
    const restoredHref = links.find(href => new URL(href, page.url()).searchParams.get("localProject") !== firstId);assert(restoredHref);
    await library.locator(`a[href=${JSON.stringify(restoredHref)}]`).click();await ready(mainSelector);
    const restored = await snapshot();assert.deepEqual(restored, withLayout);
    check("Two named personal Projects and a real ZIP download/reviewed restore preserve data, styles and layouts; both light/dark controls remain usable");
    result.stage = "studio-free-entry";await persist();
    const studioPage = await context.newPage();studioPage.setDefaultTimeout(10000);await studioPage.goto("https://studio.opengeo.tools/");
    await studioPage.locator(".start-map-dialog").waitFor();
    assert.equal(await studioPage.locator(".browser-project-restoring").count(), 0);
    await studioPage.getByRole("button", {name: "Continue with an empty map", exact: true}).click();
    await studioPage.getByRole("button", {name: "On this device", exact: true}).click();
    await studioPage.getByRole("dialog", {name: "Projects on this device", exact: true}).getByRole("status").filter({hasText: "0 of 10 Projects"}).waitFor();
    await studioPage.close();check("Studio anonymous editing and its separate empty device library work without account/API/data requests");
    within();assert.equal(result.externalRequests, 0);assert.deepEqual(result.errors, []);
    result.status = "passed-compiled-local-workspace-print-backup";result.firstProjectId = firstId;
    result.artifactTrees = [...sites].map(([origin, site]) => ({origin, tree: site.manifest.artifactTree.digest}));
  } catch (error) {result.status = "stopped-no-retry";result.error = {name: error.name, message: error.message};
    result.diagnostic = await page?.evaluate(() => ({url: location.href, status: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent).slice(0, 8),
      dialogs: [...document.querySelectorAll("dialog")].map(node => ({label: node.getAttribute("aria-label"), text: node.textContent.slice(0, 1200)}))})).catch(() => null);
    process.exitCode = 1;
  } finally {clearTimeout(timer);await browser?.close();result.browserClosed = true;result.elapsedMilliseconds = Date.now() - begun;
    result.cumulative = {softwareRequests: carried.softwareRequests + result.softwareRequests, softwareBytes: carried.softwareBytes + result.softwareBytes, elapsedMilliseconds: carried.elapsedMilliseconds + result.elapsedMilliseconds, basemapSubstitutions: carried.basemapSubstitutions + result.basemapSubstitutions};
    await persist();console.log(JSON.stringify(result));}
}

if (process.env.OPEN_GEO_LOCAL_WORKSPACE === "1") {
  await checkLocalWorkspace();
  process.exit(process.exitCode ?? 0);
}

if (process.env.OPEN_GEO_DEMO_INTERFACE_FEEDBACK === "1") {
  await checkDemoInterfaceFeedback();
  process.exit(process.exitCode ?? 0);
}

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
  const personalSave=page.getByRole('dialog',{name:'Save personal Project',exact:true});
  await personalSave.getByLabel('Personal Project title',{exact:true}).fill('Local Catalog Project');
  await personalSave.getByRole('button',{name:'Save Project',exact:true}).click();
  await page.waitForFunction(()=>new URL(location.href).searchParams.has('localProject')&&document.querySelector('.gis-role-badge')?.textContent==='Saved on this device');
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

// Reuse this compiled Demo browser lane for one finite, fully intercepted journey.
// Preparation is available before the separate Demo build exists.
async function checkDemoInterfaceFeedback() {
  const workspace = resolve(process.env.OPEN_GEO_DEMO_INTERFACE_ROOT ?? ".");
  const output = resolve(process.env.OPEN_GEO_DEMO_INTERFACE_OUTPUT ?? "/tmp/opengeo-demo-interface-feedback.json");
  const limits = {seconds: 120, browsers: 1, journeys: 1, overviewCards: 31, toolbarRows: 31,
    sourceReviews: 1, polygonVertices: 3, polygonClosures: 1, themeSwitches: 2,
    viewport: [1369, 982], layersPanelPixels: 260, inspectorPixels: 320, popupMaximumPixels: 340,
    softwareRequests: 1400, softwareBytes: 67108864, externalStyleSubstitutions: 8,
    providerContacts: 0, APIRequests: 0, AWSRequests: 0, screenshots: 2, captures: 0, exports: 0, PDF: 0, builds: 0};
  const plan = {status: "prepared-not-run", mode: "compiled-demo-interface-feedback",
    workspace, assets: resolve(workspace, "app/dist/demo-build"), manifest: resolve(workspace, "dist/opengeo-demo-build.json"), output, limits,
    closes: ["Overview Catalog31cards and one community Layer preview", "Toolbar Catalog31rows/search reset/source metadata review", "Three vertices then an actual origin click closes one polygon", "Actual light/dark Layers260px, properties320px and popup up to340px without clipped values"],
    reuses: ["Existing check-demo-new-project-catalog.mjs browser/Playwright lane", "Exact sealed Demo software and bundled community data", "Normal native map controls and existing polygon finish path"],
    stop_condition: "First wrong asset/hash, private/API/provider transport, UI/geometry/layout failure or ceiling stops. No build, live visit, provider fallthrough, map capture, export or automatic retry; at most two ordinary UI screenshots.",
    scope: "All HTTP resources are intercepted from sealed local files; reviewed OpenFreeMap style requests receive an empty local style. Actual MapLibre renders bundled community data. No provider/basemap acceptance claim.",
    command: "OPEN_GEO_DEMO_INTERFACE_FEEDBACK=1 OPEN_GEO_DEMO_INTERFACE_ROOT=<separate-demo-workspace> OPEN_GEO_DEMO_INTERFACE_OUTPUT=<unused-receipt.json> node app/scripts/check-demo-new-project-catalog.mjs"};
  if (process.env.OPEN_GEO_DEMO_INTERFACE_PREPARE === "1") {console.log(JSON.stringify(plan));return;}
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = await readFile(plan.manifest), manifest = JSON.parse(manifestBytes);
  verifyManifestSeal(manifest, "Demo interface feedback");
  assert.equal(manifest.schemaVersion, "opengeo.demo-build.1.0.0");
  assert.equal(manifest.demoOrigin, "https://demo.studio.opengeo.tools");
  assert.equal(manifest.routes.length, 1);assert.equal(manifest.routes[0].path, "/");
  assert.equal(manifest.aliases.length, 0);assert(!manifest.authConfig);
  const files = new Map(manifest.artifactTree.files.map(file => [file.path, file]));
  assert(files.has("index.html"));
  assert(![...files.keys()].some(path => /PublicDemoPublication\.|PublicationCodeEditor\.|^editor-assets\//.test(path)), "This Catalog-only slice excludes the held Publication/compiler expansion");
  const result = {...plan, status: "started", startedAt: new Date().toISOString(), treeDigest: manifest.artifactTree.digest,
    processId: process.pid, stage: "initialize-local-browser",
    manifestFileSHA256: hash(manifestBytes), modeSHA256: hash(checkDemoInterfaceFeedback.toString()),
    softwareRequests: 0, softwareBytes: 0, styleSubstitutions: 0, optionalFontsAborted: 0,
    networkContacts: 0, providerContacts: 0, APIRequests: 0, AWSRequests: 0,
    sourceReviews: 0, themeSwitches: 0, pageErrors: [], checks: [], spacing: [], screenshots: []};
  await mkdir(resolve(output, ".."), {recursive: true});
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", {flag: "wx"});
  const begun = Date.now(), origin = "https://demo.studio.opengeo.tools";
  let browser, context, page, stopped;
  const within = () => assert(!stopped && Date.now() - begun < limits.seconds * 1000, "Finite Demo interface window");
  const remaining = milliseconds => {within();return Math.max(1, Math.min(milliseconds, limits.seconds * 1000 - (Date.now() - begun)));};
  const persist = () => writeFile(output, JSON.stringify(result, null, 2) + "\n");
  const timer = setTimeout(() => {stopped ??= Error("Demo interface deadline");void context?.close().catch(() => {});}, limits.seconds * 1000);
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser",
      args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"], timeout: remaining(15000)});
    context = await browser.newContext({viewport: {width: 1369, height: 982}, serviceWorkers: "block", colorScheme: "dark"});
    page = await context.newPage();page.setDefaultTimeout(10000);
    page.on("pageerror", error => {result.pageErrors.push(error.name);stopped ??= error;});
    await context.route("**/*", async route => {
      try {
        within();const request = route.request(), url = new URL(request.url());
        if (["data:", "blob:"].includes(url.protocol)) return route.continue();
        assert.equal(request.method(), "GET", "No API, source write or processing request");
        if (url.origin === "https://tiles.openfreemap.org" && /^\/styles\/(?:positron|liberty|bright|dark|fiord)\/?$/.test(url.pathname)) {
          assert(result.styleSubstitutions < limits.externalStyleSubstitutions);result.styleSubstitutions++;
          return route.fulfill({json: {version: 8, sources: {}, layers: [{id: "offline-background", type: "background", paint: {"background-color": "#102333"}}]}});
        }
        if (url.origin === "https://fonts.googleapis.com") {result.optionalFontsAborted++;return route.abort();}
        assert.equal(url.origin, origin, "No provider or external network fallthrough");
        assert(!/\/api\/|auth-config|\/workspaces|\/login/.test(url.pathname), "No private surface request");
        const path = decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html", file = files.get(path);
        assert(file, "Only exact sealed software paths");
        assert(result.softwareRequests < limits.softwareRequests && result.softwareBytes + file.bytes <= limits.softwareBytes);
        const bytes = await readFile(safeJoin(plan.assets, path));assert.equal(bytes.length, file.bytes);assert.equal(hash(bytes), file.sha256);
        result.softwareRequests++;result.softwareBytes += bytes.length;
        return route.fulfill({contentType: ({".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".html": "text/html", ".woff2": "font/woff2", ".pbf": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm"})[extname(path)] ?? "application/octet-stream", body: bytes});
      } catch (error) {stopped ??= error;result.routeFailure = {name: error.name, path: new URL(route.request().url()).pathname};await route.abort().catch(() => {});}
    });
    result.stage = "overview-catalog-and-community-preview";
    await page.goto(origin + "/?view=catalog", {waitUntil: "domcontentloaded", timeout: remaining(20000)});
    const overview = page.locator("#example-catalog");await overview.waitFor({timeout: remaining(20000)});
    const requiredStyles = [...files.keys()].filter(path => /^_observablehq\/theme-near-midnight,wide\.[^/]+\.css$|^_file\/style\.[^/]+\.css$/.test(path));
    assert.equal(requiredStyles.length, 2, "Real Demo loads the sealed Framework theme and application stylesheet");
    await page.waitForFunction(paths => paths.every(path => [...document.styleSheets].some(sheet => sheet.href && new URL(sheet.href).pathname === "/" + path)), requiredStyles, {timeout: remaining(10000)});
    result.stylesheets = requiredStyles;
    assert.equal(await overview.locator("[data-catalog-layer]").count(), 31);
    await overview.locator('[data-catalog-layer="community-facilities"]').getByRole("link", {name: "View layer", exact: true}).click();
    const shell = page.locator(".public-workbench-demo .opengeo-workbench");await shell.waitFor({timeout: remaining(20000)});
    const ready = () => page.waitForFunction(() => {const s = document.querySelector(".opengeo-workbench"), c = s?.getPrintContext?.();return c?.ready && c.map?.isStyleLoaded() && c.map.areTilesLoaded() && !c.map.isMoving() && s.__opengeoLayers.length === 1 && c.map.queryRenderedFeatures().length > 0;}, {}, {timeout: remaining(20000)});
    await ready();assert.equal(await shell.evaluate(s => s.__opengeoLayers.length), 1);
    result.checks.push({name: "overview31-and-single-community-Layer-rendered", pass: true});
    result.stage = "toolbar-catalog-search-review";
    await shell.getByRole("button", {name: "Catalog", exact: true}).first().click();
    const rows = shell.locator("[data-browser-catalog-layer]");assert.equal(await rows.count(), 31);
    await shell.getByLabel("Search Layers", {exact: true}).fill("unmatched-example");assert.equal(await rows.count(), 0);
    await shell.getByRole("button", {name: "Clear search", exact: true}).click();assert.equal(await rows.count(), 31);
    const catalogAppearance = async mode => {
      const measured = await shell.locator(".browser-layer-catalog article").first().evaluate(element => {
        const rect = element.getBoundingClientRect(), controls = [...element.querySelectorAll("button,strong,p,small")].map(node => {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          return {tag: node.tagName, width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, foreground: style.color, background: style.backgroundColor};
        });return {width: rect.width, controls};
      });
      assert(measured.width > 0 && measured.controls.every(control => control.width > 0 && control.scrollWidth <= control.clientWidth + 2));
      result.checks.push({name: "catalog-visible-controls", mode, pass: true, measured});
    };
    assert.equal(await shell.getAttribute("data-color-mode"), "dark");await catalogAppearance("dark");
    await shell.getByRole("button", {name: "Light", exact: true}).click();result.themeSwitches++;
    assert.equal(await shell.getAttribute("data-color-mode"), "light");await catalogAppearance("light");
    await rows.filter({has: page.locator('[aria-label^="Review and add Public community facilities"]')}).getByRole("button").click();
    const dialog = page.locator(".browser-layer-registration");await dialog.waitFor();assert.match(await dialog.getByLabel("License", {exact: true}).inputValue(), /CC0/);
    result.sourceReviews++;await dialog.getByRole("button", {name: "Cancel", exact: true}).click();
    assert.equal(await shell.evaluate(s => s.__opengeoLayers.length), 1, "Source inspection must not add or replace a Layer");
    result.checks.push({name: "toolbar31-search-reset-and-read-only-source-review", pass: true});
    result.stage = "native-properties-popup-light-dark-spacing";
    await shell.locator(".gis-layer-row").first().hover();await shell.getByRole("button", {name: "Style layer", exact: true}).first().click();
    const kmlSummary = shell.locator(".gis-panel-right details:not([open]) > summary").filter({hasText: /^KML content/});
    if (await kmlSummary.count()) await kmlSummary.first().click();
    const click = await shell.evaluate(s => {const map = s.__opengeoMap, layer = s.__opengeoLayers[0], feature = s.__opengeoData.get(layer.layerId).features[0], p = map.project(feature.geometry.coordinates);return {x: p.x, y: p.y};});
    const canvas = shell.locator(".maplibregl-canvas");await canvas.click({position: click});
    const popup = page.locator(".maplibregl-popup:has(.gis-popup)");await popup.waitFor();
    const spacing = async mode => {
      const measured = await page.evaluate(() => {
        const box = node => {const r = node.getBoundingClientRect();return {width: r.width, height: r.height, left: r.left, right: r.right};};
        const shell = document.querySelector(".opengeo-workbench"), left = shell.querySelector(".gis-panel-left"), right = shell.querySelector(".gis-panel-right"), popup = shell.querySelector(".maplibregl-popup");
        const cells = [...shell.querySelectorAll(".gis-panel-left .gis-key-values dt,.gis-panel-left .gis-key-values dd,.gis-panel-right .gis-key-values dt,.gis-panel-right .gis-key-values dd,.maplibregl-popup .gis-popup dt,.maplibregl-popup .gis-popup dd")].filter(node => {const rect = node.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";}).map(node => {
          const style = getComputedStyle(node);return {...box(node), text: node.textContent, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, lineHeight: parseFloat(style.lineHeight), paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom), marginTop: parseFloat(style.marginTop), marginBottom: parseFloat(style.marginBottom), foreground: style.color};
        });return {left: box(left), right: box(right), popup: box(popup), popupMaxWidth: getComputedStyle(popup).maxWidth, cells, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth};
      });
      assert(Math.abs(measured.left.width - 260) < 2 && Math.abs(measured.right.width - 320) < 2);
      assert.equal(measured.popupMaxWidth, "340px");assert(measured.popup.width <= 342 && measured.popup.width > 0);
      assert(measured.documentWidth <= measured.viewportWidth + 1);
      assert(measured.cells.length && measured.cells.every(cell => cell.width > 0 && cell.scrollWidth <= cell.clientWidth + 2 && cell.paddingTop + cell.paddingBottom + cell.marginTop + cell.marginBottom <= cell.lineHeight + 1));
      result.spacing.push({mode, pass: true, ...measured});
      assert(result.screenshots.length < limits.screenshots);
      const screenshotPath = output + "." + mode + ".png";
      await page.screenshot({path: screenshotPath, fullPage: false, timeout: remaining(10000)});
      result.screenshots.push({mode, path: screenshotPath});
    };
    await spacing("light");await shell.getByRole("button", {name: "Dark", exact: true}).click();result.themeSwitches++;
    assert.equal(await shell.getAttribute("data-color-mode"), "dark");await spacing("dark");
    await popup.locator(".maplibregl-popup-close-button").click();
    result.stage = "native-three-vertex-origin-completion";
    await shell.getByRole("button", {name: "Polygon", exact: true}).first().click();
    const guide = shell.locator('.gis-map-authoring-guide[data-authoring-kind="Polygon"]');await guide.waitFor();
    await page.waitForFunction(() => {const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;return map?.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving();}, {}, {timeout: remaining(10000)});
    const dimensions = await canvas.boundingBox();assert(dimensions && dimensions.width > 300 && dimensions.height > 300);
    const first = {x: Math.round(dimensions.width * .3), y: Math.round(dimensions.height * .34)};
    await canvas.click({position: first});await canvas.click({position: {x: Math.round(dimensions.width * .62), y: first.y}});
    await canvas.click({position: {x: Math.round(dimensions.width * .5), y: Math.round(dimensions.height * .65)}});
    assert(await guide.getByRole("button", {name: "Finish polygon", exact: true}).isEnabled());
    await canvas.click({position: {x: first.x + 3, y: first.y + 3}});await guide.waitFor({state: "hidden"});
    const polygons = await shell.evaluate(s => [...s.__opengeoData.values()].flatMap(data => data.features ?? []).filter(feature => feature.geometry?.type === "Polygon").map(feature => feature.geometry.coordinates[0]));
    assert.equal(polygons.length, 1);assert.equal(polygons[0].length, 4);assert.deepEqual(polygons[0][0], polygons[0][3]);assert.equal(new Set(polygons[0].slice(0, -1).map(p => JSON.stringify(p.slice(0, 2)))).size, 3);
    result.checks.push({name: "three-vertices-origin-click-finishes-once", pass: true});
    within();assert.equal(result.themeSwitches, 2);assert.equal(result.sourceReviews, 1);assert.deepEqual(result.pageErrors, []);
    result.status = "passed-compiled-demo-catalog-drawing-theme-spacing";result.result = {rowsClosed: 3, overviewCards: 31, toolbarRows: 31, sourceReviews: 1, originalLayerPreserved: true, polygonsClosed: 1, themeModes: ["light", "dark"], providerContacts: 0, requiredRemaining: ["Authorized deployment and live software readback remain separate"]};
  } catch (error) {
    result.status = "stopped-no-retry";result.failure = {name: error.name, message: error.message};process.exitCode = 1;
    if (page && !page.isClosed()) try {
      const html = await page.content();result.failureDOMPath = output + ".failure.html";
      await writeFile(result.failureDOMPath, html.slice(0, 2097152), {flag: "wx"});result.failureDOMTruncated = html.length > 2097152;
    } catch {result.failureDOMUnavailable = true;}
  }
  finally {clearTimeout(timer);await context?.close().catch(() => {});await browser?.close().catch(() => {});result.browserClosed = true;result.finishedAt = new Date().toISOString();result.elapsedMilliseconds = Date.now() - begun;await persist();}
  console.log(JSON.stringify({status: result.status, output, checks: result.checks.length, sourceReviews: result.sourceReviews, softwareRequests: result.softwareRequests, softwareBytes: result.softwareBytes, providerContacts: 0, failure: result.failure}));
}

async function checkEntryRoutes() {
  const {createHash} = await import("node:crypto");
  const types = {".mjs":"text/javascript", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".geojson":"application/json", ".html":"text/html", ".pbf":"application/octet-stream"};
  const started = Date.now(), limits = {seconds: 60, softwareRequests: 1200, softwareBytes: 40 * 1024 ** 2, styleSubstitutions: 4};
  const result = {status: "running", limits, softwareRequests: 0, softwareBytes: 0, styleSubstitutions: 0, externalRequests: 0, errors: [], browserClosed: false};
  const receipt = resolve(process.env.OPEN_GEO_ENTRY_RECEIPT ?? "entry-routes-evidence.json");
  const sites = new Map();
  for (const [host, root, manifestPath] of [
    ["https://demo.studio.opengeo.tools", process.env.OPEN_GEO_ENTRY_DEMO_ROOT, process.env.OPEN_GEO_ENTRY_DEMO_MANIFEST],
    ["https://studio.opengeo.tools", process.env.OPEN_GEO_ENTRY_STUDIO_ROOT, process.env.OPEN_GEO_ENTRY_STUDIO_MANIFEST]
  ]) {
    assert.ok(root && manifestPath, "Exact compiled roots/manifests required");
    const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
    sites.set(host, {root: resolve(root), files: new Map(manifest.artifactTree.files.map(f => [f.path, f])), routes: new Map(manifest.routes.map(r => [r.path, r.htmlPath])), tree: manifest.artifactTree.digest});
  }
  result.trees = [...sites].map(([origin, s]) => ({origin, tree: s.tree}));
  const previousPath = process.env.OPEN_GEO_ENTRY_PRIOR_RECEIPT;
  let carriedMilliseconds = 0, resumeLoginOnly = false;
  if (previousPath) {
    const prior = JSON.parse(await readFile(resolve(previousPath), "utf8"));
    assert.equal(prior.status, "failed");
    const correctedBuild = process.env.OPEN_GEO_STABLE_TOOLS_NEW_BUILD === "1";
    if(correctedBuild) {assert.equal(process.env.OPEN_GEO_STABLE_TOOLS,"1");result.previousTrees=prior.trees;}
    else assert.deepEqual(prior.trees,result.trees);
    resumeLoginOnly = prior.error.includes("locator.click: Timeout") && prior.errors.every(e => e.includes("Target page, context or browser has been closed"));
    const stablePrior = process.env.OPEN_GEO_STABLE_TOOLS === "1" && (prior.error.includes("gis-theme-command") || prior.error.includes("gis-menubar")) && prior.errors.length === 0;
    assert.ok(stablePrior || resumeLoginOnly || (prior.error.includes("opengeo-start") && prior.errors.every(e => e.includes("result.softwareRequests <= limits.softwareRequests"))));
    if (stablePrior && !correctedBuild) result.toolbar = structuredClone(prior.toolbar ?? []);
    assert.equal(prior.externalRequests, 0);
    for (const key of ["softwareRequests", "softwareBytes", "styleSubstitutions"]) result[key] = prior[key];
    carriedMilliseconds = prior.elapsedMilliseconds;
    result.carried = {receipt: previousPath, softwareRequests: prior.softwareRequests, softwareBytes: prior.softwareBytes, elapsedMilliseconds: carriedMilliseconds};
    result.retainedDemoChecks = stablePrior ? ["Bare Demo URL renders the starter map", "Completed toolbar cases retained"] : ["Bare Demo URL renders the starter map", "Catalog button opens 31 examples deliberately", "Open Studio link enters root URL"];
  }
  async function checkStableToolbar(demo) {
    const shell=page.locator(".opengeo-workbench").first();
    const verifyItems=async menu=>{
      const text=await menu.textContent();
      for(const name of ["Demo home","Sample datasets","New empty demo map","Reset public demo","About demo privacy"]) assert.equal(text.includes(name),demo,name);
      for(const name of ["Save on this device","Projects on this device","Open Print Studio"]) assert.ok(text.includes(name),name);
      if(!demo) {assert.ok(text.includes("Open application home"));assert.ok(text.includes("Browse projects"));}
    };
    for (const width of [1369,390]) for (const theme of ["dark","light"]) {
      if ((result.toolbar??[]).some(item=>item.surface===(demo?"demo":"studio") && item.width===width && item.theme===theme)) continue;
      await page.setViewportSize({width,height:982});
      const phone=width<821;
      const actions=shell.locator('.gis-mobile-toolbar [data-primary-command="more"]');
      if (await shell.getAttribute("data-color-mode")!==theme) {
        if(!phone) await shell.locator(".gis-theme-command").click();
        else {
          await actions.click();const sheet=shell.locator(".gis-mobile-command-sheet");
          await sheet.locator('[data-mobile-command-category="settings"] > summary').click();
          await sheet.getByRole("menuitem",{name:`Theme: ${theme}`,exact:true}).click();
        }
      }
      const screenshot=resolve(receipt,"..",`toolbar-${demo?'demo':'studio'}-${width}-${theme}.png`);
      if(phone) {
        await actions.waitFor();const first=await actions.boundingBox();await actions.click();
        const sheet=shell.locator(".gis-mobile-command-sheet"),category=sheet.locator('[data-mobile-command-category="project"]');
        assert.equal(await sheet.locator(".gis-mobile-command-category").first().getAttribute("data-mobile-command-category"),"project");
        assert.equal(await sheet.locator('.gis-mobile-command-navigation a[href="https://demo.studio.opengeo.tools/?view=catalog"]').count(),demo?1:0);
        await category.locator("summary").click();await verifyItems(category);await sheet.screenshot({path:screenshot});
        await sheet.getByRole("button",{name:"Close actions",exact:true}).click();
        const restored=await actions.boundingBox();assert.ok(Math.abs(restored.x-first.x)<2 && Math.abs(restored.y-first.y)<2,"Actions anchor moved on closing sheet");
        (result.toolbar??=[]).push({surface:demo?"demo":"studio",width,theme,mobileActions:first,afterClose:restored,projectCategoryFirst:true,screenshot});
      } else {
        const bar=shell.locator(".gis-menubar"),project=bar.locator('[data-menu="project"] > button'),quick=shell.locator(".gis-primary-toolbar");
        await project.waitFor();const first=await project.boundingBox(),row=await bar.boundingBox(),tools=await quick.boundingBox();
        assert.ok(Math.abs(first.x-row.x)<2,"Project must begin at menu-row left");assert.ok(tools.y>=row.y+row.height-1,"Quick tools need their own row");
        await project.click();const menu=bar.locator('[data-menu="project"] [role="menu"]');await verifyItems(menu);await menu.screenshot({path:screenshot});await project.click();
        await bar.locator(".gis-quick-tools-toggle").click();assert.equal(await quick.isVisible(),false);const hidden=await project.boundingBox();
        assert.ok(Math.abs(hidden.x-first.x)<2 && Math.abs(hidden.y-first.y)<2,"Project anchor moved on quick-tool hide");
        await bar.locator(".gis-quick-tools-toggle").click();await quick.waitFor();const restored=await project.boundingBox();
        assert.ok(Math.abs(restored.x-first.x)<2 && Math.abs(restored.y-first.y)<2,"Project anchor moved on quick-tool show");
        (result.toolbar??=[]).push({surface:demo?"demo":"studio",width,theme,project:first,afterHide:hidden,afterShow:restored,screenshot});
      }
    }
    await page.setViewportSize({width:1280,height:820});
  }
  let browser, page;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]});
    const context = await browser.newContext({viewport: {width: 1280, height: 820}, serviceWorkers: "block"});
    await context.exposeBinding("__recordEntryReturn", (_source, value) => {result.defaultReturnTo = value;});
    await context.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        const saved = original.call(this, key, value);
        if (key === "opengeo.oauthTransaction") void window.__recordEntryReturn(JSON.parse(value).returnTo);
        return saved;
      };
    });
    await context.route("**/*", async route => {
      try {
        const url = new URL(route.request().url());
        assert.equal(route.request().method(), "GET");
        assert.ok(Date.now() - started + carriedMilliseconds < limits.seconds * 1000, "Whole browser deadline");
        if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) return route.abort();
        if (url.origin === "https://tiles.openfreemap.org" && url.pathname === "/styles/positron") {
          assert.ok(++result.styleSubstitutions <= limits.styleSubstitutions);
          return route.fulfill({json: {version: 8, sources: {}, layers: []}});
        }
        if (url.origin === "https://auth.categori.se" && url.pathname === "/oauth2/authorize") {
          assert.equal(url.searchParams.get("response_type"), "code");
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          assert.equal(url.searchParams.has("client_secret"), false);
          result.authorizeIntent = true;
          return route.fulfill({contentType: "text/html", body: "<p>Offline sign-in boundary</p>"});
        }
        const site = sites.get(url.origin);assert.ok(site, "Unapproved origin");
        const path = site.routes.get(url.pathname) ?? decodeURIComponent(url.pathname).slice(1);
        const pin = site.files.get(path);assert.ok(pin, "Unapproved software path: " + url.pathname);
        assert.ok(++result.softwareRequests <= limits.softwareRequests);
        const bytes = await readFile(resolve(site.root, path));
        assert.equal(bytes.length, pin.bytes);assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
        result.softwareBytes += bytes.length;assert.ok(result.softwareBytes <= limits.softwareBytes);
        await route.fulfill({contentType: types[extname(path)] ?? "application/octet-stream", body: bytes});
      } catch (error) {result.errors.push(error.message);await route.abort();}
    });
    page = await context.newPage();page.setDefaultTimeout(10_000);
    page.on("pageerror", error => result.errors.push(error.message));
    if (!previousPath || process.env.OPEN_GEO_STABLE_TOOLS === "1") {
    await page.goto("https://demo.studio.opengeo.tools/");
    await page.locator(".opengeo-workbench").waitFor();
    assert.equal(await page.locator("#example-catalog").count(), 0);
    await page.waitForFunction(() => {const s = document.querySelector(".opengeo-workbench");return s?.__opengeoMap && s.__opengeoLayers?.length === 1 && s.__opengeoMap.queryRenderedFeatures().length > 0;});
    assert.equal(await page.getByRole("link", {name: "Open Studio ↗", exact: true}).first().getAttribute("href"), "https://studio.opengeo.tools/");
    if (process.env.OPEN_GEO_STABLE_TOOLS === "1") await checkStableToolbar(true);
    await page.getByRole("link", {name: "Catalog", exact: true}).first().click();
    await page.locator("#example-catalog").waitFor();
    assert.equal(await page.locator("[data-catalog-layer]").count(), 31);
    await page.getByRole("link", {name: "Open Studio ↗", exact: true}).first().click();
    } else if (!resumeLoginOnly) {await page.goto("https://studio.opengeo.tools/");}
    if (!resumeLoginOnly) {
    await page.waitForURL("https://studio.opengeo.tools/");await page.locator(".opengeo-start").waitFor();
    assert.equal(await page.getByRole("heading", {name: "Your projects", exact: true}).count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("opengeo.accessToken")), null);
    } else {result.retainedHomeCheck = "Studio Home visible, not Projects, with no token";}
    if (process.env.OPEN_GEO_STABLE_TOOLS === "1") {
      await page.getByRole("button", {name: "Continue with an empty map", exact: true}).click();
      await checkStableToolbar(false);assert.deepEqual(result.errors, []);
      result.checks = ["Project menu stays left in a separate row when quick tools toggle", "Desktop menu anchors and existing phone Actions/Project entry remain stable in light/dark themes", "Studio Home excludes Demo-only actions; Demo retains its own entries", "Home/map/Catalog routes stay intact"];
      result.status = "passed-compiled-stable-toolbar-demo-scope";return;
    }
    // Inspect the real compiled sign-in transaction without sending credentials or contacting Cognito.
    await page.goto("https://studio.opengeo.tools/login");
    await page.getByRole("button", {name: "Sign in to OpenGeo", exact: true}).waitFor();
    await page.getByRole("button", {name: "Sign in to OpenGeo", exact: true}).click();
    await page.waitForURL(url => url.origin === "https://auth.categori.se" && url.pathname === "/oauth2/authorize");
    assert.equal(result.authorizeIntent, true);assert.equal(result.defaultReturnTo, "/");
    const manifestPath = resolve(process.env.OPEN_GEO_ENTRY_STUDIO_ROOT, "manifest.webmanifest");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).start_url, "/");
    assert.deepEqual(result.errors, []);
    result.checks = ["Bare Demo URL renders the starter map", "Catalog button opens 31 examples deliberately", "Open Studio enters Home", "Compiled generic PKCE sign-in stores Home as return destination", "Installed Studio start_url is Home"];
    result.status = "passed-compiled-home-entry-catalog-sign-in";
  } catch (error) {result.status = "failed";result.error = error.message;throw error;}
  finally {await browser?.close();result.browserClosed = true;result.elapsedMilliseconds = Date.now() - started + carriedMilliseconds;await mkdir(resolve(receipt, ".."), {recursive: true});await writeFile(receipt, JSON.stringify(result, null, 2) + "\n");console.log(JSON.stringify(result));}
}
