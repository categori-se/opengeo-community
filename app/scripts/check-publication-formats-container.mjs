// Native compiler and browser acceptance only. No AWS, image push or publication.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {chromium} from 'playwright';
import {JSDOM} from 'jsdom';
import {PodmanRunner} from '../../services/observable-coordinator/src/podman-runner.mjs';
import {INVOCATION_SCHEMA, REQUEST_SCHEMA, REQUIRED_SANDBOX, sha256} from '../../services/observable-coordinator/src/contracts.mjs';
import {inspectStaticMapLayers, staticMapDocument} from '../src/lib/staticMapExport.js';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';

const imageDigest = process.argv[2];
assert.match(imageDigest ?? '', /^sha256:[a-f0-9]{64}$/, 'Supply the exact local compiler image ID');
const output = await mkdtemp('/tmp/opengeo-publication-formats-container-');
const limits = {cpuMillis: 1000, memoryMiB: 2048, timeoutSeconds: 120,
  maxInputFiles: 128, maxInputBytes: 16 * 1024 * 1024, maxOutputFiles: 512, maxOutputBytes: 32 * 1024 * 1024};
const media = path => path.endsWith('.md') ? 'text/markdown' : path.endsWith('.html') ? 'text/html'
  : path.endsWith('.ipynb') ? 'application/x-ipynb+json' : path.endsWith('.png') ? 'image/png' : path.endsWith('.txt') ? 'text/plain' : 'application/json';
const results = [];
async function compile(format, entry, files) {
  const inputs = new Map(Object.entries({...files, 'opengeo.publication.json': JSON.stringify({schema: 'opengeo.publication.1', format, entry})})
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, text]) => [path, Buffer.from(text)]));
  const invocation = {schemaVersion: INVOCATION_SCHEMA, buildJobId: randomUUID(),
    requestChecksumSha256: 'b'.repeat(64), inputManifestChecksumSha256: 'c'.repeat(64), entryPath: entry, lockfilePath: null,
    files: [...inputs].map(([path, body]) => ({path, contentType: media(path), sizeBytes: body.length, checksumSha256: sha256(body)})),
    request: {schemaVersion: REQUEST_SCHEMA, sourceProjectId: randomUUID(), sourceRevisionId: randomUUID(),
      sourceRevisionNumber: 1, sourceManifestChecksumSha256: 'c'.repeat(64), purpose: 'preview', compilerImageDigest: imageDigest,
      frameworkVersion: '1.13.4', lockfileFormat: 'npm-package-lock-v3', lockfileChecksumSha256: null,
      networkPolicy: 'deny_all', resourceLimits: limits}};
  const result = await new PodmanRunner().run({invocation, inputs, limits});
  assert.deepEqual(result.sandbox, REQUIRED_SANDBOX);
  assert.equal(result.report.validationReport.publicationAuthorized, false);
  assert(result.outputs.has('dist/index.html'));
  for (const file of result.report.outputManifest.files) {
    const bytes = result.outputs.get(file.path); assert.equal(sha256(bytes), file.checksumSha256);
    const target = join(output, format, file.path); await mkdir(dirname(target), {recursive: true}); await writeFile(target, bytes);
  }
  const html = result.outputs.get('dist/index.html').toString();
  results.push({format, outputTreeChecksumSha256: result.report.outputTreeChecksumSha256, files: result.outputs.size});
  console.log(JSON.stringify(results.at(-1))); return html;
}

const htmlSource = '<!doctype html><title>Field notes</title><h1>Field notes</h1><button onclick="this.textContent=\'Updated\'">Update</button>';
const html = await compile('html', 'index.html', {'index.html': htmlSource});
assert.equal(html, htmlSource);
const candidates = inspectStaticMapLayers({style: {version: 8, sources: {sites: {type: 'geojson', attribution: 'Synthetic acceptance data',
  data: {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [90.4, 27.5]}}]}}},
  layers: [{id: 'sites', type: 'circle', source: 'sites', paint: {'circle-radius': 20, 'circle-color': '#ff3333'}}]},
  layers: [{layerId: 'sites', title: 'Survey points'}], handles: new Map([['sites', {sourceId: 'sites', layerIds: ['sites']}]])});
const runtime = {};
for (const [key, path] of [['runtimeJs', 'dist/maplibre-gl.js'], ['runtimeCss', 'dist/maplibre-gl.css'], ['runtimeLicense', 'LICENSE.txt']]) {
  runtime[key] = await readFile(new URL(`../node_modules/maplibre-gl/${path}`, import.meta.url), 'utf8');
}
const mapSource = staticMapDocument({...runtime, title: 'Survey map', view: {center: [90.4, 27.5], zoom: 8}, candidates, selectedIds: ['sites']});
const map = await compile('map', 'index.html', {'index.html': mapSource});
assert.equal(map, mapSource);
const framework = await compile('framework', 'index.md', {'index.md': '# Framework article\n\n```js\nconst values = await FileAttachment("values.json").json();\n```\n\n${values[0]}\n', 'values.json': '[42]'});
assert.match(framework, /Framework article/);
const native = '<!doctype html><notebook><title>Reactive field notes</title><script id="1" type="module">const rows = await FileAttachment("rows.json").json();</script><script id="2" type="module">const amount = view(Inputs.range([0, 10], {value: 2, step: 1}));</script><script id="3" type="text/markdown"># Result ${amount + rows[0]}</script></notebook>';
const dom = new JSDOM('');
const inserted = publicationMapInsert({entryPath:'index.html',source:native,name:'survey',blob:new Blob([mapSource],{type:'text/html'}),parser:new dom.window.DOMParser()});
dom.window.close();
const nativeWithMap = native.slice(0,inserted.insertOffset) + inserted.snippet + native.slice(inserted.insertOffset);
const notebook = await compile('notebook', 'index.html', {'index.html': nativeWithMap, [inserted.file.relativePath]:mapSource,
  'rows.json': '[40]', 'private.txt': 'PRIVATE_UNUSED_ACCEPTANCE_SENTINEL'});
assert.doesNotMatch(notebook, /PRIVATE_UNUSED_ACCEPTANCE_SENTINEL/);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const jupyter = await compile('jupyter', 'analysis.ipynb', {'analysis.ipynb': JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
  {cell_type: 'markdown', metadata: {}, source: '# Saved analysis\n![Saved plot](images/plot.png)'},
  {cell_type: 'code', metadata: {}, source: 'raise RuntimeError("Do not execute")', execution_count: 1,
    outputs: [{output_type: 'display_data', data: {'text/html': '<table><tr><td>42</td></tr></table><script>throw Error("unsafe output")</script>'}}]}
]}), 'images/plot.png':image, 'images/private.png':Buffer.from('PRIVATE_UNUSED_IMAGE_SENTINEL'), 'private.txt': 'PRIVATE_UNUSED_ACCEPTANCE_SENTINEL'});
assert.doesNotMatch(jupyter, /PRIVATE_UNUSED_ACCEPTANCE_SENTINEL|unsafe output/);
assert(!jupyter.includes(Buffer.from('PRIVATE_UNUSED_IMAGE_SENTINEL').toString('base64')));

const browser = await chromium.launch({headless: true, executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync), args: ['--enable-unsafe-swiftshader']});
try {
  const context = await browser.newContext({offline: true, viewport: {width: 1000, height: 750}});
  const page = await context.newPage(), requests = [], errors = [];
  page.on('request', request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
  page.on('pageerror', error => errors.push(error.message));
  const open = format => page.goto(`file://${join(output, format, 'dist/index.html')}`);
  await open('html'); await page.getByRole('button', {name: 'Update', exact: true}).click();
  await page.getByRole('button', {name: 'Updated', exact: true}).waitFor();
  await open('map'); await page.getByRole('status').filter({hasText: 'Offline edition'}).waitFor();
  const before = await page.locator('canvas').screenshot();
  await page.getByRole('checkbox', {name: 'Survey points'}).uncheck();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await page.locator('canvas').screenshot(), before);
  await open('notebook'); await page.getByRole('heading', {name: 'Result 42', exact: true}).waitFor();
  await page.locator('input[type=range]').fill('5'); await page.locator('input[type=range]').dispatchEvent('input');
  await page.getByRole('heading', {name: 'Result 45', exact: true}).waitFor();
  const embeddedMap = page.frameLocator('iframe[title="survey"]');
  await embeddedMap.getByRole('status').filter({hasText:'Offline edition'}).waitFor();
  const embeddedBefore = await embeddedMap.locator('canvas').screenshot();
  await embeddedMap.getByRole('checkbox',{name:'Survey points'}).uncheck(); await page.waitForTimeout(300);
  assert.notDeepEqual(await embeddedMap.locator('canvas').screenshot(),embeddedBefore);
  assert(await page.frames()[1].evaluate(()=>{try {parent.document;return false;} catch {return true;}}));
  await page.screenshot({path: join(output, 'notebook.png')});
  await open('jupyter'); await page.getByRole('heading', {name: 'Saved analysis', exact: true}).waitFor();
  await page.getByRole('cell', {name: '42', exact: true}).waitFor();
  await page.getByAltText('Saved plot').evaluate(image=>image.decode());
  assert.equal(await page.getByAltText('Saved plot').evaluate(image=>image.naturalWidth),1);
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  const receipt = {verifiedAt: new Date().toISOString(), imageDigest, sandbox: REQUIRED_SANDBOX,
    results, browserFormats: ['html', 'map', 'notebook', 'jupyter'], notebookMapInsertion:true,jupyterSourceImages:true,
    externalRequests: 0, publicationAuthorized: false};
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({passed: true, output, receipt}));
} finally {await browser.close();}
