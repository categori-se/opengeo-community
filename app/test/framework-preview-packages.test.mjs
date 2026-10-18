import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, writeFile, mkdtemp, rm, stat, open} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildWithSignal} from '../scripts/esbuild-with-signal.mjs';
import {chromium} from 'playwright';
import {writeArrayBuffer} from 'geotiff';
import {buildFrameworkPreview} from '../scripts/build-framework-preview.mjs';

const originalPath = process.env.OPENGEO_ORIGINAL_FRAMEWORK_TIFF;
const original = Boolean(originalPath);
const originalExport = original ? process.env.OPENGEO_ORIGINAL_FRAMEWORK_EXPORT : null;
const existingExport = process.env.OPENGEO_FRAMEWORK_EXISTING_EXPORT;
const nativeOutput = process.env.OPENGEO_FRAMEWORK_NATIVE_OUTPUT;
const localizeRetainedNative = process.env.OPENGEO_FRAMEWORK_NATIVE_LOCALIZE_RETAINED === '1';
const nativeOffline = process.env.OPENGEO_FRAMEWORK_NATIVE_OFFLINE === '1';
async function verifyNativeOutput(directory) {
  assert(isAbsolute(directory), 'Native output must be an explicit absolute retained directory');
  const reportPath = join(directory, 'compiler-report.json');
  assert((await stat(reportPath)).size <= 512 * 1024, 'Native report stays bounded');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.schemaVersion, localizeRetainedNative
    ? 'opengeo.observable-compiler-report.1.0.0' : 'opengeo.observable-compiler-report.2.0.0');
  assert.equal(report.outputManifest.schemaVersion, 'opengeo.observable-local-output.1.0.0');
  const pins = report.outputManifest.files;
  assert.equal(report.outputTreeChecksumSha256,
    createHash('sha256').update(JSON.stringify(pins)).digest('hex'));
  let html, file, manifest;
  if (localizeRetainedNative) {
    // Explicit diagnostic fallback: current pure localizer + the old sealed
    // synthetic native tree. This is not invocation5/report2 acceptance.
    assert(pins.length > 0 && pins.length <= 512);
    let inputBytes = 0;
    for (const pin of pins) {
      assert(/^dist\/[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(pin.path)
        && pin.path.split('/').every(part => part !== '.' && part !== '..'));
      assert(Number.isSafeInteger(pin.sizeBytes) && pin.sizeBytes > 0);
      inputBytes += pin.sizeBytes; assert(inputBytes <= 32 * 1024 * 1024);
    }
    const tiffs = pins.filter(pin => /\.tiff?$/i.test(pin.path));
    assert.equal(tiffs.length, 1); assert.equal(tiffs[0].sizeBytes, 290);
    const files = await Promise.all(pins.map(async pin => {
      const path = join(directory, pin.path);
      assert.equal((await stat(path)).size, pin.sizeBytes);
      return {...pin, bytes:await readFile(path)};
    }));
    const {localizeFrameworkOutput} = await import('../../services/observable-builder/src/framework-standalone.mjs');
    const localized = localizeFrameworkOutput({files});
    html = Buffer.from(localized.html); manifest = localized.manifest;
    file = {path:'dist/index.html', contentType:'text/html', sizeBytes:html.length,
      checksumSha256:createHash('sha256').update(html).digest('hex')};
  } else {
    assert.equal(pins.length, 1); file = pins[0];
    assert.equal(file.path, 'dist/index.html'); assert.equal(file.contentType, 'text/html');
    assert(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= 32 * 1024 * 1024,
      'This synthetic browser check never reads a large original-file export');
    assert.match(file.checksumSha256, /^[a-f0-9]{64}$/);
    const {artifactChecksum} = await import('../../services/observable-builder/src/artifact-inputs.mjs');
    const localized = report.localizedOutput; manifest = localized.manifest;
    assert.equal(localized.manifestChecksumSha256, artifactChecksum(manifest));
    assert.deepEqual(manifest.output, file);
    assert.deepEqual(report.routeManifest, [{path:'/', file:'dist/index.html'}]);
    const htmlPath = join(directory, file.path);
    assert.equal((await stat(htmlPath)).size, file.sizeBytes);
    html = await readFile(htmlPath);
  }
  assert.equal(manifest.schemaVersion, 'opengeo.framework-localized-output.1.0.0');
  assert.equal(manifest.outputBytes, file.sizeBytes);
  assert.equal(manifest.publicationAuthorized, false);
  assert.equal(manifest.assets.length, 1);
  const asset = manifest.assets[0];
  assert.equal(asset.sizeBytes, 290); assert.equal(asset.mimeType, 'image/tiff');
  assert.match(asset.checksumSha256, /^[a-f0-9]{64}$/);
  const checksum = createHash('sha256').update(html).digest('hex');
  assert.equal(checksum, file.checksumSha256, 'Serve the exact sealed native HTML unchanged');
  // Import the owning policy rather than maintaining a browser-only CSP copy.
  const {observablePreviewBuildCsp} = await import('../../infrastructure/lib/observable-preview-edge.ts');
  const csp = observablePreviewBuildCsp('abcdefghij.execute-api.us-east-1.amazonaws.com');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  assert(!nativeOffline || !localizeRetainedNative, 'Offline acceptance uses the already sealed generated file');
  const url = nativeOffline ? pathToFileURL(join(directory, 'dist/index.html')).href
    : `https://preview.studio.opengeo.tools/organizations/${id(1)}/projects/${id(2)}/source-projects/${id(3)}/builds/${id(4)}/output/index.html`;
  const requests = [], blocked = [], errors = [], consoleErrors = [];
  let browser, page, violations = [], status = 'failed';
  try {
    browser = await chromium.launch({headless:true,
      executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
    const context = await browser.newContext({viewport:{width:390,height:800},serviceWorkers:'block'});
    await context.addInitScript(() => {
      globalThis.__frameworkCspViolations = [];
      addEventListener('securitypolicyviolation', event => globalThis.__frameworkCspViolations.push({
        blockedURI:event.blockedURI.slice(0,300), effectiveDirective:event.effectiveDirective, disposition:event.disposition
      }));
    });
    await context.route(/^https?:\/\//, route => {
      if (!nativeOffline && route.request().url() === url && route.request().method() === 'GET') {
        return route.fulfill({contentType:'text/html',body:html,headers:{
          'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff',
          'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin',
          'Referrer-Policy':'no-referrer'
        }});
      }
      blocked.push(route.request().url()); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on('request', request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text().slice(0,1000));});
    await page.goto(url, {waitUntil:'domcontentloaded'});
    await page.getByText(/Raster 4 × 4; geographic bounds 85, 24, 89, 28/).first().waitFor();
    const dimensions = await page.locator('canvas').evaluate(canvas => [canvas.width, canvas.height]);
    assert.deepEqual(dimensions, [4,4]);
    const initial = await readPixels(page, false);
    assert.equal(initial.length, 64);
    assert(initial.filter((value, index) => index % 4 === 3).every(alpha => alpha === 255));
    assert(new Set(Array.from({length:16}, (_, index) => initial.slice(index * 4, index * 4 + 3).join(','))).size > 1,
      'D3 renders distinct colors from decoded GeoTIFF samples');
    const range = page.locator('form').filter({hasText:'Color ceiling'}).locator('input[type="range"]');
    assert.equal(await range.count(), 1);
    await range.fill('32');
    await page.waitForFunction(initial => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const pixels = canvas.getContext('2d').getImageData(0,0,4,4).data;
      return pixels.some((value, index) => value !== initial[index]);
    }, initial);
    assert.notDeepEqual(await readPixels(page, false), initial, 'Native Observable input reactively changes D3 raster colors');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.observablehq--error').count(), 0);
    assert.equal(await page.locator('iframe').count(), 0);
    violations = await page.evaluate(() => globalThis.__frameworkCspViolations);
    assert.deepEqual(violations, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    assert.deepEqual(blocked, []); assert.deepEqual(requests, nativeOffline ? [] : [url]);
    status = 'passed';
  } finally {
    if (page) {
      try {violations = await page.evaluate(() => globalThis.__frameworkCspViolations ?? []);} catch {}
    }
    console.log(JSON.stringify({status,nativeOutput:directory,reportSchema:report.schemaVersion,
      localizationMode:localizeRetainedNative ? 'current-helper-on-retained-report1-tree' : 'sealed-report2-output',
      invocation5Report2Acceptance:status === 'passed' && !localizeRetainedNative,
      HTMLBytes:file.sizeBytes,HTMLChecksumSha256:checksum,syntheticTIFFBytes:asset.sizeBytes,
      syntheticTIFFChecksumSha256:asset.checksumSha256,providerRequests:0,compilerBuilds:0,
      externalHTTPRequests:blocked.length,HTTPRequests:requests,blockedRequests:blocked,
      pageErrors:errors,consoleErrors,CSPViolations:violations,deliveryPolicy:nativeOffline ? 'offline-file-localized-meta-CSP' : 'saved-preview-build',
      publicDelivery:'Not established; public distribution response headers were not read'}));
    await browser?.close();
  }
}
async function readPixels(target, originalMode = original) {
  const canvas = target.locator('canvas'); await canvas.waitFor({state:'visible'});
  return canvas.evaluate((canvas, originalMode) => {
    const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    if (!originalMode) return Array.from(data);
    const colors = new Set(); let visible = 0, first = null;
    for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3]) {
      visible++; colors.add(`${data[offset]},${data[offset+1]},${data[offset+2]}`);
      if (!first) first = Array.from(data.subarray(offset,offset+4));
    }
    return {width:canvas.width,height:canvas.height,visible,colorCount:colors.size,first};
  }, originalMode);
}
function assertInitialPixels(value, originalMode = original) {
  if (originalMode) {
    assert.equal(value.width,256); assert.equal(value.height,Math.floor(256 * 5713 / 11194));
    assert(value.visible > 0, 'Resized original raster is not blank');
    assert(value.colorCount > 1, 'D3 renders multiple original land-cover colors');
    assert.equal(value.first[3],255);
  } else assert.deepEqual(value, [0,0,255,255, 0,128,0,255, 255,255,0,255, 255,0,0,255]);
}
function assertReactivePixels(value, originalMode = original) {
  if (originalMode) assert.equal(value.first[3],128, 'Reactive opacity changes the original TIFF pixels');
  else assert.deepEqual(value.slice(0,4), [0,128,0,255], 'D3 recolors decoded TIFF pixels after reactive input');
}
async function verifyExistingExport(path) {
  assert(isAbsolute(path), 'Existing export must be an explicit absolute path');
  const size = (await stat(path)).size;
  assert.equal(size,88_347_591, 'Use the already accepted immutable original export');
  // All non-payload HTML is smaller than 2 MiB, so this bounded trailer includes
  // provenance even when the final module is large. Never copy or decode the
  // full 86 MiB payload again in the Node process.
  const file = await open(path,'r'); let trailer;
  try {
    assert(size - 86_550_296 < 2 * 1024 * 1024);
    const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024,size));
    const {bytesRead} = await file.read(buffer,0,buffer.length,size-buffer.length);
    trailer = buffer.subarray(0,bytesRead).toString('utf8');
  } finally {await file.close();}
  const manifestText = trailer.match(/<script type="application\/json" id="opengeo-framework-export">([\s\S]*?)<\/script>/)?.[1];
  assert(manifestText, 'Retained export provenance is present in its trailer');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.mode,'private-standalone'); assert.equal(manifest.outputProfile,'archive-96m');
  assert.equal(manifest.files.length,1); assert.equal(manifest.files[0].sizeBytes,64_912_721);
  assert.equal(manifest.files[0].checksumSha256,'be8e76a41a561faca53384c56c96071982d2ae2b17d40502abbf68acf4a24d45');
  for (const key of ['attachmentId','datasetId','datasetVersionId','dataObjectId']) assert.equal(manifest.files[0][key],undefined);
  let browser;
  try {
    browser = await chromium.launch({headless:true,
      executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
    const context = await browser.newContext({offline:true,viewport:{width:390,height:800}});
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const requests = [], errors = [];
    page.on('request',request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(pathToFileURL(path).href,{waitUntil:'domcontentloaded'});
    await page.locator('#dimensions').getByText('11194 × 5713',{exact:true}).waitFor();
    await page.locator('#attachment').getByText('Attachment ready',{exact:true}).waitFor();
    await page.locator('#source-format').getByText('1 band · 8 bits · nodata 255',{exact:true}).waitFor();
    assertInitialPixels(await readPixels(page,true),true);
    const screenshot = process.env.OPENGEO_FRAMEWORK_EXISTING_EXPORT_SCREENSHOT;
    if (screenshot) {
      const destination = screenshot === '1' ? path.replace(/\.html$/i,'') + '-390.png' : screenshot;
      assert(isAbsolute(destination), 'Screenshot destination must be absolute');
      await page.screenshot({path:destination,fullPage:false});
    }
    await page.locator('input[type="range"]').fill('0.5');
    await page.locator('#reactive').getByText('0.5',{exact:true}).waitFor();
    assertReactivePixels(await readPixels(page,true),true);
    assert.equal(await page.locator('iframe').count(),0);
    assert.equal(await page.locator('.observablehq--error').count(),0);
    assert.deepEqual(errors,[]); assert.deepEqual(requests,[]);
    console.log(JSON.stringify({existingExport:path,HTMLBytes:size,originalTIFFBytes:64_912_721,
      compilerBuilds:0,providerRequests:0,externalHTTPRequests:requests.length,iframeCount:0,
      catalogPins:'none; actual original export does not claim registration acceptance',offlineReactiveD3:true}));
  } finally {await browser?.close();}
}
function createTIFFDiagnostics() {
  let page;
  const started = performance.now(), timings = [];
  let phase = 'fixture', phaseStarted = started;
  const enterPhase = next => {
    const now = performance.now();
    timings.push({phase, milliseconds: Math.round(now - phaseStarted)});
    phase = next; phaseStarted = now;
    console.error(JSON.stringify({frameworkTIFF: 'phase', phase, elapsedMilliseconds: Math.round(now - started), previous: timings.at(-1)}));
  };
  const reportState = async reason => {
    const frames = await Promise.all((page?.frames() ?? []).slice(0, 4).map(async frame => {
      let timer;
      try {
        return await Promise.race([
          frame.evaluate(() => ({
            status: [...document.querySelectorAll('.observablehq--error, .publication-document-preview > p[role="status"], #dimensions, #attachment, #reactive')]
              .slice(0, 8).map(node => node.textContent.slice(0, 300)),
            canvas: [...document.querySelectorAll('canvas')].slice(0, 2).map(node => [node.width, node.height]),
            saves: window.saves, sourceReads: window.sourceReads?.slice(0, 4),
            inventoryReads: window.inventoryReads, tickets: window.tickets
          })),
          new Promise(resolve => {timer = setTimeout(() => resolve({unavailable: 'snapshot timed out'}), 300);})
        ]);
      } catch {return {unavailable: 'frame detached or closed'};}
      finally {clearTimeout(timer);}
    }));
    console.error(JSON.stringify({frameworkTIFF: 'state', reason, phase,
      elapsedMilliseconds: Math.round(performance.now() - started), timings, frames}));
  };
  return {enterPhase, reportState, setPage: value => {page = value;}};
}
const synthetic = !nativeOutput && !existingExport && !original;
let syntheticFixture, syntheticPreparation, syntheticController;
async function prepareTIFFFixture(fixture, signal) {
  const {enterPhase} = fixture.diagnostics;
  const setupStarted = performance.now();
  const checkActive = () => signal?.throwIfAborted();
  checkActive();
  fixture.directory = await mkdtemp(join(tmpdir(), 'opengeo-preview-packages-'));
  checkActive();
  enterPhase('compiler fixture bundles');
  fixture.filename = await buildFrameworkPreview(fixture.directory, {signal});
  checkActive();
  fixture.compiler = await readFile(join(fixture.directory, fixture.filename), {signal});
  checkActive();
  enterPhase('editor fixture bundle');
  fixture.editor = await buildWithSignal({stdin: {contents: `export {PublicationCodeEditor} from './src/components/PublicationCodeEditor.js';
    export {createFrameworkAttachmentReader} from './src/lib/frameworkArchiveInputs.js';`,
    resolveDir: new URL('..', import.meta.url).pathname, loader: 'js'}, bundle: true, format: 'esm', write: false}, signal);
  checkActive();
  enterPhase('Chromium launch');
  fixture.browser = await chromium.launch({headless: true,
    executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync),
    ...(signal ? {timeout: Math.max(1, 15000 - (performance.now() - setupStarted))} : {})});
  checkActive();
  enterPhase('fixture ready');
}
async function cleanupTIFFFixture(fixture) {
  fixture.diagnostics.enterPhase('cleanup');
  try {await fixture.browser?.close();}
  finally {if (fixture.directory) await rm(fixture.directory, {recursive: true, force: true});}
  fixture.diagnostics.enterPhase('complete');
}
// Synthetic setup has its own 15-second bound; the unchanged UI behavior bound
// below remains 18 seconds (33 seconds combined, followed by bounded cleanup).
// Original-file and retained-output modes keep their existing test timeouts.
before(async context => {
  if (!synthetic) return;
  syntheticFixture = {diagnostics: createTIFFDiagnostics()};
  syntheticController = new AbortController();
  const signal = AbortSignal.any([context.signal, syntheticController.signal, AbortSignal.timeout(15000)]);
  const timer = setTimeout(() => void syntheticFixture.diagnostics.reportState('before setup timeout'), 12000);
  timer.unref();
  syntheticPreparation = prepareTIFFFixture(syntheticFixture, signal);
  try {await syntheticPreparation;}
  finally {clearTimeout(timer);}
}, {timeout: 15000});
after(async () => {
  if (!syntheticFixture) return;
  // Cancel compiler contexts before draining interrupted preparation. Each
  // context is disposed before a late browser launch or fixture cleanup.
  syntheticController?.abort(new Error('TIFF fixture cleanup'));
  await syntheticPreparation?.catch(() => {});
  await cleanupTIFFFixture(syntheticFixture);
}, {timeout: 5000});
test(nativeOutput ? localizeRetainedNative
    ? 'current localizer on the retained native tree decodes GeoTIFF and updates D3 under the current preview CSP without network or compilation'
    : 'saved native single HTML decodes GeoTIFF and updates D3 under the current preview CSP without network or compilation'
  : existingExport ? 'retained original standalone HTML renders offline and updates D3 without rebuilding or exporting'
  : original ? 'retained original TIFF renders with D3 and exports one offline HTML with explicit size consent and fixture-only pins'
  : 'unsaved Framework preview decodes a cached TIFF attachment and updates D3 pixels without saving or network', {timeout: nativeOutput ? 25000 : existingExport ? 20000 : original ? 28000 : 18000}, async () => {
  if (nativeOutput) return verifyNativeOutput(nativeOutput);
  if (existingExport) return verifyExistingExport(existingExport);
  const fixture = syntheticFixture ?? {diagnostics: createTIFFDiagnostics()};
  let page, offlineContext;
  const {enterPhase, reportState} = fixture.diagnostics;
  // Capture synthetic UI state before its unchanged 18-second cancellation;
  // each frame snapshot is bounded and never reads source URLs or credentials.
  const diagnosticTimer = original ? null : setTimeout(() => void reportState('before test timeout'), 15000);
  diagnosticTimer?.unref();
  try {
    if (originalExport) assert(isAbsolute(originalExport), 'Retained export destination must be an explicit absolute path');
    // Original mode reads only the exact local file explicitly retained by the
    // parent. All catalog identities below remain synthetic fixture identities.
    const rasterBuffer = original ? await readFile(originalPath) : Buffer.from(writeArrayBuffer([1, 3, 5, 9], {
      width: 2, height: 2, BitsPerSample: [8], SamplesPerPixel: [1]
    }));
    if (original) assert.equal(rasterBuffer.length, 64_912_721, 'Original mode requires the unchanged retained TIFF');
    const checksum = createHash('sha256').update(rasterBuffer).digest('hex');
    if (original) assert.equal(checksum, 'be8e76a41a561faca53384c56c96071982d2ae2b17d40502abbf68acf4a24d45',
      'Original mode requires the exact retained TIFF checksum before launching a browser');
    const raster = original ? null : Array.from(rasterBuffer);
    const archivePath = original ? 'original-retained-fixture.tif' : 'tiny.tif';
    const dimensions = original ? '11194 × 5713' : '2 × 2';
    // The hooks prepare the exact synthetic fixture; original mode still builds
    // the same fixture inside its existing 28-second test boundary.
    console.error(JSON.stringify({frameworkTIFF: 'fixture bundles', nodeVersion: process.version,
      tiffBytes: rasterBuffer.length, tiffChecksumSha256: checksum, bundles:
      ['geotiff', 'jszip', 'd3', 'Framework runtime', 'default and Inputs CSS', 'air CSS', 'near-midnight CSS', 'Framework compiler']}));
    if (!synthetic) await prepareTIFFFixture(fixture);
    const {directory, filename, compiler, editor, browser} = fixture;
    const shell = await readFile(new URL('../../services/observable-preview/authorize/draft.html', import.meta.url), 'utf8');
    // Exact retained CloudFront PublisherDraftHeaders20260915 response policy.
    const draftCsp = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors https://studio.opengeo.tools https://demo.studio.opengeo.tools; frame-src 'none'; form-action 'none'; script-src 'unsafe-inline' data:; script-src-attr 'none'; style-src 'unsafe-inline' data:; font-src data:; img-src data: blob:; connect-src data: blob:; worker-src blob:";
    const external = [], errors = [], origin = 'https://studio.opengeo.tools';
    enterPhase('browser context and routes');
    const context = await browser.newContext({viewport: {width: 390, height: 800}});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.href === 'https://preview.studio.opengeo.tools/authorize/draft.html') {
        return route.fulfill({contentType: 'text/html', body: shell, headers:{'Content-Security-Policy':draftCsp}});
      }
      if (url.origin !== origin) {external.push(url.href); return route.abort();}
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><main></main>'});
      if (url.pathname === '/editor.js') return route.fulfill({contentType: 'text/javascript', body: editor.outputFiles[0].text});
      if (url.pathname === '/editor-assets/manifest.json') return route.fulfill({contentType: 'application/json', body: JSON.stringify({frameworkPreview: filename})});
      if (url.pathname === '/editor-assets/' + filename) return route.fulfill({contentType: 'text/javascript', body: compiler});
      if (original && url.pathname === '/fixture-original.tif') return route.fulfill({contentType: 'image/tiff', body:rasterBuffer,
        headers:{'content-length':String(rasterBuffer.length)}});
      throw Error(`Unexpected request: ${url.pathname}`);
    });
    page = await context.newPage(); fixture.diagnostics.setPage(page);
    page.setDefaultTimeout(original ? 15000 : 4000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    enterPhase('editor open');
    await page.evaluate(async ({raster, checksum, original, sizeBytes, archivePath}) => {
      const {PublicationCodeEditor, createFrameworkAttachmentReader} = await import('/editor.js');
      const textarea = document.createElement('textarea');
      window.saves = 0; window.sourceReads = []; window.inventoryReads = 0; window.tickets = 0;
      const source = original ? '# Retained original land cover\n\n```js\nimport * as GeoTIFF from "npm:geotiff";\nimport * as d3 from "npm:d3";\nconst bytes = await FileAttachment("./original-retained-fixture.tif").arrayBuffer();\nconst image = await (await GeoTIFF.fromArrayBuffer(bytes)).getImage();\nconst imageAspectRatio = image.getWidth() / image.getHeight();\nconst rasterWidth = 256;\nconst rasterHeight = Math.floor(rasterWidth / imageAspectRatio);\nconst values = await image.readRasters({width:rasterWidth, height:rasterHeight, samples:[0], interleave:true});\nconst colors = d3.scaleOrdinal([1,2,3,4,5,6,7,8,9,10,11], ["#006837","#1a9850","#66bd63","#a6d96a","#d9ef8b","#ffffbf","#fee08b","#fdae61","#f46d43","#d73027","#4575b4"]).unknown("#bdbdbd");\n```\n\n```js\nconst opacity = view(Inputs.range([0.25,1], {value:1, step:0.25, label:"Opacity"}));\n```\n\n```js\nconst canvas = DOM.canvas(rasterWidth, rasterHeight);\nconst rgba = new Uint8ClampedArray(values.length * 4);\nfor (let i = 0; i < values.length; i++) {\n  const {r,g,b} = d3.color(colors(values[i])).rgb();\n  rgba.set([r,g,b,values[i] === 255 ? 0 : Math.round(255 * opacity)], i * 4);\n}\ncanvas.getContext("2d").putImageData(new ImageData(rgba,rasterWidth,rasterHeight),0,0);\ndisplay(canvas);\n```\n<p id="dimensions">${image.getWidth()} × ${image.getHeight()}</p><p id="attachment">${bytes.byteLength === 64912721 ? "Attachment ready" : "changed"}</p><p id="reactive">${opacity}</p><p id="source-format">${image.getSamplesPerPixel()} band · ${image.getBitsPerSample(0)} bits · nodata ${image.getGDALNoData()}</p>'
        : '# Unsaved raster\n\n```js\nimport * as GeoTIFF from "npm:geotiff";\nimport * as d3 from "npm:d3";\nconst bytes = await FileAttachment("./tiny.tif").arrayBuffer();\nconst image = await (await GeoTIFF.fromArrayBuffer(bytes)).getImage();\nconst values = await image.readRasters({interleave: true});\nconst duplicateBytes = await FileAttachment("./tiny.tif").arrayBuffer();\nconst colors = d3.scaleThreshold([2, 4, 8], ["#0000ff", "#008000", "#ffff00", "#ff0000"]);\n```\n\n```js\nconst amount = view(Inputs.range([1, 4], {value: 1, step: 1}));\n```\n\n```js\nconst canvas = DOM.canvas(image.getWidth(), image.getHeight());\nconst rgba = Uint8ClampedArray.from(Array.from(values).flatMap(value => {\n  const {r, g, b} = d3.color(colors(value * amount)).rgb();\n  return [r, g, b, 255];\n}));\ncanvas.getContext("2d").putImageData(new ImageData(rgba, image.getWidth(), image.getHeight()), 0, 0);\ndisplay(canvas);\n```\n<p id="dimensions">${image.getWidth()} × ${image.getHeight()}</p><p id="attachment">${bytes.byteLength === duplicateBytes.byteLength ? "Attachment ready" : "changed"}</p><p id="reactive">${values[0] * amount}</p>';
      textarea.value = source;
      const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const record = {id:id(1), sourceProjectId:id(2), datasetId:id(3), datasetVersionId:id(4),
        dataObjectId:id(5), s3VersionId:'fixture-version', checksumSha256:checksum,
        sizeBytes, contentType:'image/tiff', available:true};
      const url = new URL('https://s3.us-east-1.amazonaws.com/opengeo-fixture/' + archivePath);
      for (const [key,value] of Object.entries({'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
        'X-Amz-Credential':'fixture/20261009/us-east-1/s3/aws4_request', 'X-Amz-Date':'20261009T000000Z',
        'X-Amz-Expires':'900', 'X-Amz-SignedHeaders':'host', 'X-Amz-Signature':'a'.repeat(64),
        'response-content-disposition':`attachment; filename="${archivePath}"`, versionId:'fixture-version'})) url.searchParams.set(key,value);
      const adapter = {
        async listObservableDataAttachments(projectId, sourceProjectId) {
          if(projectId !== id(7) || sourceProjectId !== id(2)) throw Error('Unexpected attachment scope');
          window.inventoryReads++; return [record];
        },
        async getCatalogDataset(datasetId) {if(datasetId !== id(3)) throw Error('Unexpected dataset'); return {id:id(3), projectId:id(7)};},
        async requestDatasetDownload(...pins) {
          if (pins.join(',') !== [id(7),id(3),id(4),id(5)].join(',')) throw Error('Unexpected download identity');
          window.tickets++; return {url:url.href, method:'GET', expiresAt:new Date(Date.now()+600000).toISOString()};
        },
        async fetchImplementation(target, options) {
          if(target !== url.href || options.method !== 'GET' || options.credentials !== 'omit') throw Error('Unexpected attachment request');
          window.sourceReads.push(archivePath);
          // The signed fixture URL is never requested. Chromium receives the
          // original Buffer through one intercepted local fixture route.
          return original ? fetch('/fixture-original.tif', {credentials:'omit', signal:options.signal})
            : new Response(Uint8Array.from(raster), {headers:{'content-type':'image/tiff', 'content-length':String(sizeBytes)}});
        }
      };
      const reader = createFrameworkAttachmentReader({adapter, projectId:id(7), sourceProjectId:id(2),
        getBindings:()=>[{attachmentId:id(1), relativePath:archivePath}]});
      window.attachmentReader = reader;
      const editor = PublicationCodeEditor({textarea, onSave: () => window.saves++,
        loadEditor: async () => {throw Error('Use accessible text editor');},
        getSourceContext: () => ({sourceRoot: '', readFile:reader.read,
          readFileMetadata:original ? async () => null : reader.metadata})});
      document.querySelector('main').append(textarea, editor.element, editor.preview, editor.status);
      window.editor = editor;
      await editor.open('index.md', source);
    }, {raster, checksum, original, sizeBytes:rasterBuffer.length, archivePath});
    enterPhase('initial preview');
    // Text edits deliberately retire the outer browsing context. Wait for that
    // exact retirement before asking Playwright to inspect the replacement.
    const frame = page.frameLocator('iframe[title="Framework draft preview"]').frameLocator('iframe[title="Rendered Framework draft"]');
    await frame.locator('#dimensions').getByText(dimensions, {exact: true}).waitFor();
    await frame.locator('#attachment').getByText('Attachment ready', {exact: true}).waitFor();
    if (original) await frame.locator('#source-format').getByText('1 band · 8 bits · nodata 255', {exact:true}).waitFor();
    assertInitialPixels(await readPixels(frame));
    enterPhase('reactive preview');
    const nextInput = original ? '0.5' : '3';
    await frame.locator('input[type="range"]').fill(nextInput);
    await frame.locator('#reactive').getByText(nextInput, {exact: true}).waitFor();
    assertReactivePixels(await readPixels(frame));
    enterPhase('draft frame replacement');
    let editedFrame = frame;
    if (!original) {
      // The unchanged small fixture owns edit/replacement acceptance. Original
      // mode avoids another large decode solely to repeat that accepted check.
      const previousShell = await (await page.locator('iframe[title="Framework draft preview"]').elementHandle()).contentFrame();
      const retired = page.waitForEvent('framedetached', {predicate: detached => detached === previousShell});
      await page.locator('textarea').fill((await page.locator('textarea').inputValue()).replace('# Unsaved raster', '# Edited raster'));
      await retired;
      editedFrame = page.frameLocator('iframe[title="Framework draft preview"]').frameLocator('iframe[title="Rendered Framework draft"]');
      await editedFrame.getByRole('heading', {name: 'Edited raster'}).waitFor();
      await editedFrame.locator('canvas').waitFor();
    }
    assert.equal(await page.evaluate(() => window.saves), 0);
    assert.deepEqual(await page.evaluate(() => window.sourceReads), [archivePath], 'The editor reuses verified attachment bytes');
    assert.equal(await page.evaluate(() => window.inventoryReads), 1);
    assert.equal(await page.evaluate(() => window.tickets), 1);
    assert.equal(await editedFrame.locator('.observablehq--error').count(), 0);
    assert.equal(await page.evaluate(() => {try {document.querySelector('iframe').contentWindow.document; return false;} catch {return true;}}), true);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);

    // Reuse this one compiler and the cached exact attachment; the download is
    // a single local HTML file, opened directly without Studio or a web server.
    enterPhase('standalone export');
    if (original) {
      let prematureDownloads = 0;
      const premature = () => {prematureDownloads++;}; page.on('download', premature);
      await page.getByRole('button', {name:'Download HTML', exact:true}).click();
      await page.locator('.publication-document-preview > p[role="status"]').getByText(/Download unavailable: HTML exceeds 32 MiB/).waitFor();
      assert.equal(prematureDownloads,0, 'Default output refuses the large original before consent');
      page.off('download',premature);
      await page.locator('[name="allow-up-to-96-mib-standalone-html"]').check();
    }
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', {name:'Download HTML', exact:true}).click();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'index.html');
    const standalonePath = originalExport ?? join(directory, 'standalone.html');
    await download.saveAs(standalonePath);
    const standaloneHtml = await readFile(standalonePath, 'utf8');
    assert(Buffer.byteLength(standaloneHtml) <= (original ? 96 : 32) * 1024 * 1024);
    assert(!standaloneHtml.includes('s3.us-east-1.amazonaws.com'));
    assert(!standaloneHtml.includes('X-Amz-'));
    let encoded;
    if (original) {
      const payloadTag = '<script type="application/octet-stream" id="opengeo-framework-file-0">';
      const start = standaloneHtml.indexOf(payloadTag) + payloadTag.length;
      assert(start >= payloadTag.length, 'Original payload exists');
      const end = standaloneHtml.indexOf('</script>',start);
      const payload = standaloneHtml.slice(start,end);
      assert.equal((standaloneHtml.match(/<script type="application\/octet-stream"/g) ?? []).length,1);
      assert.equal(payload.length,86_550_296, 'The full original is encoded exactly once');
      assert.equal(createHash('sha256').update(Buffer.from(payload,'base64')).digest('hex'),checksum);
    } else {
      encoded = Buffer.from(rasterBuffer).toString('base64');
      assert.equal(standaloneHtml.split(encoded).length - 1, 1, 'Original file bytes are embedded only once');
    }
    const pins = JSON.parse(standaloneHtml.match(/<script type="application\/json" id="opengeo-framework-export">([\s\S]*?)<\/script>/)[1]);
    assert.equal(pins.mode, 'private-standalone'); assert.equal(pins.files[0].checksumSha256, checksum);
    assert.equal(pins.files[0].sizeBytes, rasterBuffer.length);
    if (original) {
      for (const key of ['attachmentId','datasetId','datasetVersionId','dataObjectId']) assert.equal(pins.files[0][key],undefined,
        'Original export has no accepted real catalog identity; fixture UUIDs must not become provenance');
    } else {
      assert.equal(pins.files[0].attachmentId, '00000000-0000-4000-8000-000000000001');
      assert.equal(pins.files[0].datasetVersionId, '00000000-0000-4000-8000-000000000004');
    }
    assert.equal(pins.files[0].license, undefined, 'Private download does not invent public distribution rights');
    if (original) console.log(JSON.stringify({originalTIFFBytes:rasterBuffer.length,originalTIFFChecksumSha256:checksum,
      standaloneHTMLBytes:Buffer.byteLength(standaloneHtml),retainedExport:originalExport ?? null,
      renderer:'source-based GeoTIFF decode/resize pipeline adapted to local D3 canvas',
      catalogPins:'reader uses synthetic fixture UUIDs; export omits them; no real registration acceptance'}));
    enterPhase('offline preview and reactive pixels');
    offlineContext = await browser.newContext({offline:true, viewport:{width:390,height:800}});
    const offlineRequests = [], offlineErrors = [];
    const offline = await offlineContext.newPage(); offline.setDefaultTimeout(original ? 15000 : 4000);
    offline.on('request', request => {if (/^https?:/.test(request.url())) offlineRequests.push(request.url());});
    offline.on('pageerror', error => offlineErrors.push(error.message));
    await offline.goto(pathToFileURL(standalonePath).href);
    await offline.locator('#dimensions').getByText(dimensions, {exact:true}).waitFor();
    await offline.locator('#attachment').getByText('Attachment ready', {exact:true}).waitFor();
    if (original) await offline.locator('#source-format').getByText('1 band · 8 bits · nodata 255', {exact:true}).waitFor();
    assertInitialPixels(await readPixels(offline));
    await offline.locator('input[type="range"]').fill(nextInput);
    await offline.locator('#reactive').getByText(nextInput, {exact:true}).waitFor();
    assertReactivePixels(await readPixels(offline));
    assert.deepEqual(offlineErrors, []); assert.deepEqual(offlineRequests, []);
    assert.equal(await offline.locator('iframe').count(), 0, 'The standalone file needs no parent or preview bridge');
    assert.equal(await page.evaluate(() => window.saves), 0);
    assert.deepEqual(await page.evaluate(() => window.sourceReads), [archivePath]);
    assert.equal(await page.evaluate(() => window.inventoryReads), 1); assert.equal(await page.evaluate(() => window.tickets), 1);

    if (!original) {
      enterPhase('corruption rejection');
      const changedRaster = Uint8Array.from(raster); changedRaster[changedRaster.length - 1] ^= 1;
      const tamperedPath = join(directory, 'tampered.html');
      await writeFile(tamperedPath, standaloneHtml.replace(encoded, Buffer.from(changedRaster).toString('base64')));
      const tampered = await offlineContext.newPage(); tampered.setDefaultTimeout(4000);
      const rejected = tampered.waitForEvent('pageerror');
      await tampered.goto(pathToFileURL(tamperedPath).href);
      assert.match((await rejected).message, /Standalone file checksum changed/);
      assert.equal(await tampered.locator('canvas').count(), 0, 'Corrupt bytes are rejected before TIFF rendering');
    }
    await offlineContext.close(); offlineContext = null;
    await page.evaluate(() => {window.editor.dispose(); window.attachmentReader.dispose();});
  } catch (error) {
    await reportState('test failure'); throw error;
  } finally {
    clearTimeout(diagnosticTimer);
    if (!synthetic) {
      try {await offlineContext?.close();}
      finally {await cleanupTIFFFixture(fixture);}
    }
  }
});
