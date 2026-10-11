import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {resolve, extname, join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {buildPublicationEditor} from './build-publication-editor.mjs';
import JSZip from 'jszip';
import {runBuild} from '../../services/observable-builder/src/contract.mjs';
import {buildNotebookAssets} from '../../services/observable-builder/scripts/notebook-assets.mjs';
import {JSDOM} from 'jsdom';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';
import {inspectStaticMapLayers, staticMapDocument} from '../src/lib/staticMapExport.js';

const root = resolve(new URL('../..', import.meta.url).pathname);
const output = await mkdtemp(join(tmpdir(), 'opengeo-notebook-preview-'));
await buildPublicationEditor(output);
const studio = 'https://studio.opengeo.tools';
const policySource = await readFile(resolve(root, 'infrastructure/lib/studio-web-stack.ts'), 'utf8');
const policy = [...policySource.slice(policySource.indexOf('export const STUDIO_CONTENT_SECURITY_POLICY = [')).split('].join')[0].matchAll(/"([^"]+)"/g)].map(m => m[1]).join('; ');
const component = await build({stdin: {contents: 'export {PublicationCodeEditor} from "./components/PublicationCodeEditor.js"; export {publicationMapInsert} from "./lib/publicationMapInsert.js";', resolveDir: resolve(root,'app/src')}, bundle: true, format: 'esm', write: false});
const notebook = '<!doctype html><notebook><title>Spatial analysis</title>' + [
  ['module', 'globalThis.stableRuns=(globalThis.stableRuns??0)+1; const stable=10;'],
  ['module', 'const n = view(Inputs.range([0,10], {label:"Count",value:2,step:1}));'],
  ['module', 'const data = await FileAttachment("rows.json").json();'],
  ['text/html', '<h1>Result ${stable + n + data[0]}</h1>'],
  ['text/markdown', '# Notes'],
  ['module', 'import * as d3 from "d3"; display(d3.sum([1,2]));'],
  ['module', 'display(Plot.plot({width:300,marks:[Plot.dot([{x:1,y:2}],{x:"x",y:"y"})]}));'],
  ['module', 'const archive = await FileAttachment("archive.zip").zip(); display(await archive.file("value.txt").text());']
].map(([type, text], index) => `<script id="${index + 1}" type="${type}">${text}</script>`).join('') + '</notebook>';
const archive = await new JSZip().file('value.txt', 'Archived example').generateAsync({type: 'base64'});
const mapRuntime = {};
for (const [key,path] of [['runtimeJs','dist/maplibre-gl.js'],['runtimeCss','dist/maplibre-gl.css'],['runtimeLicense','LICENSE.txt']]) mapRuntime[key] = await readFile(resolve(root,'app/node_modules/maplibre-gl',path),'utf8');
const mapCandidates = inspectStaticMapLayers({style:{version:8,sources:{sites:{type:'geojson',attribution:'Synthetic survey data',data:{type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[90.4,27.5]}}]}}},layers:[{id:'sites',type:'circle',source:'sites',paint:{'circle-radius':20,'circle-color':'#ff3333'}}]},layers:[{layerId:'sites',title:'Survey points'}],handles:new Map([['sites',{sourceId:'sites',layerIds:['sites']}]])});
const mapHtml = staticMapDocument({...mapRuntime,title:'Survey map',view:{center:[90.4,27.5],zoom:8},candidates:mapCandidates,selectedIds:['sites']});
// Worker source admission currently supports JSON, not ZIP source uploads.
// ZIP parsing is independently covered by the editor/download assertions below.
const workerBase = notebook.replace(/<script id="8"[\s\S]*?<\/script>/, '');
const parsing = new JSDOM('');
const mapInsertion = publicationMapInsert({entryPath:'index.html',name:'survey.html',blob:new Blob([mapHtml],{type:'text/html'}),source:workerBase,parser:new parsing.window.DOMParser()});
parsing.window.close();
const workerSource = workerBase.slice(0,mapInsertion.insertOffset) + mapInsertion.snippet + workerBase.slice(mapInsertion.insertOffset);
const workerInput = join(output, 'worker-input'); await mkdir(workerInput);
const workerFiles = [['index.html', workerSource, 'text/html'],
  ['opengeo.publication.json', JSON.stringify({schema:'opengeo.publication.1',format:'notebook',entry:'index.html'}), 'application/json'],
  ['rows.json', '[3]', 'application/json'], ['maps/survey.html',mapHtml,'text/html']];
const invocation = JSON.parse(await readFile(join(root, 'services/observable-builder/test/fixture/invocation.json'), 'utf8'));
invocation.entryPath = 'index.html'; invocation.files = [];
for (const [path, content, contentType] of workerFiles.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
  await mkdir(dirname(join(workerInput,path)),{recursive:true});
  await writeFile(join(workerInput, path), content);
  invocation.files.push({path, contentType, sizeBytes: Buffer.byteLength(content), checksumSha256: createHash('sha256').update(content).digest('hex')});
}
const notebookAssetsPath = join(output, 'worker-assets.json');
await writeFile(notebookAssetsPath, JSON.stringify(await buildNotebookAssets(join(root, 'services/observable-builder'))));
const workerReport = runBuild({invocation, inputRoot:workerInput, workspaceRoot:join(output,'worker'),
  observableCliPath:join(root,'services/observable-builder/node_modules/.bin/observable'), notebookAssetsPath});
await writeFile(join(output,'worker-report.json'), JSON.stringify(workerReport, null, 2));
const browser = await chromium.launch({headless: true, executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync),args:['--enable-unsafe-swiftshader']});
const requests = [], errors = [], consoleErrors = [];
try {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  context.on('page', page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== studio) {requests.push(url.href); return route.abort();}
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', headers: {'Content-Security-Policy': policy},
      body: '<!doctype html><title>Studio notebook preview</title><style>body{margin:20px;background:#1e1e1e;color:#ddd;font:14px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:16px;min-width:0}main>div{min-width:0}.publication-code-editor{height:800px;background:#1e1e1e}iframe{width:100%;height:740px;border:1px solid #444}[hidden]{display:none}</style><main><div id="editor"></div><div id="preview"></div></main>'});
    if (url.pathname === '/component.js') return route.fulfill({contentType: 'text/javascript', body: component.outputFiles[0].text});
    if (url.pathname.startsWith('/editor-assets/')) {
      const file = resolve(output, '.' + url.pathname); assert(file.startsWith(join(output, 'editor-assets') + '/'));
      return route.fulfill({contentType: {'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}[extname(file)] ?? 'application/octet-stream', body: await readFile(file)});
    }
    requests.push(url.href); return route.abort();
  });
  const page = await context.newPage();
  const compiledPage = await context.newPage();
  await compiledPage.setContent(await readFile(join(output, 'worker/dist/index.html'), 'utf8'));
  await compiledPage.getByRole('heading', {name:'Result 15',exact:true}).waitFor();
  await compiledPage.locator('input[type=range]').fill('5'); await compiledPage.locator('input[type=range]').dispatchEvent('input');
  await compiledPage.getByRole('heading', {name:'Result 18',exact:true}).waitFor();
  await compiledPage.locator('svg').first().waitFor();
  await compiledPage.frameLocator('iframe[title="survey"]').getByRole('status').filter({hasText:'Offline edition'}).waitFor();
  await page.goto(studio);
  await page.evaluate(async ({source, archive, mapHtml}) => {
    const {PublicationCodeEditor,publicationMapInsert} = await import('/component.js');
    const textarea = document.createElement('textarea'); textarea.value = source;
    const saved = document.createElement('section'); saved.id = 'saved'; saved.textContent = 'Saved project preview';
    window.rows = '[3]';
    const editor = PublicationCodeEditor({textarea, onSave() {throw Error('Unexpected save');}, preview: saved,
      getSourceContext: () => ({readFile: async path => {
        if (path === 'src/maps/survey.html') return new Blob([mapHtml],{type:'text/html'});
        if (path === 'src/archive.zip') return new Blob([Uint8Array.from(atob(archive), c => c.charCodeAt(0))], {type: 'application/zip'});
        if (path !== 'src/rows.json') throw Error('Unexpected source read'); return new Blob([window.rows], {type: 'application/json'});
      }})});
    document.querySelector('#editor').append(textarea, editor.element);
    document.querySelector('#preview').append(editor.preview);
    await editor.open('src/index.html', source);
    window.insertMapFixture = () => {
      const result = publicationMapInsert({entryPath:'src/index.html',source:textarea.value,name:'survey.html',blob:new Blob([mapHtml],{type:'text/html'})});
      editor.insert(result.snippet,result.insertOffset);
    };
  }, {source: notebook, archive, mapHtml});
  const frame = page.frameLocator('iframe[title="Observable Notebook live preview"]');
  await frame.getByRole('heading', {name: 'Result 15', exact: true}).waitFor({timeout: 15000});
  await frame.locator('svg').first().waitFor();
  await frame.getByText('"Archived example"', {exact: true}).waitFor();
  const child = page.frames().find(f => f !== page.mainFrame());
  assert.equal(await child.evaluate(() => globalThis.stableRuns), 1);
  assert.equal(await child.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  assert.equal(await page.evaluate(() => globalThis.stableRuns), undefined);
  assert(await child.evaluate(() => {try {parent.document; return false;} catch {return true;}}));
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  await frame.locator('input[type=range]').fill('4'); await frame.locator('input[type=range]').dispatchEvent('input');
  await frame.getByRole('heading', {name: 'Result 17', exact: true}).waitFor();
  async function edit(source) {
    await page.locator('.monaco-editor').click({position: {x: 140, y: 60}});
    await page.keyboard.press('Control+a'); await page.keyboard.insertText(source);
  }
  await edit(notebook.replace('# Notes', '# Updated notes'));
  await frame.getByRole('heading', {name: 'Updated notes'}).waitFor();
  assert.equal(await child.evaluate(() => globalThis.stableRuns), 1);
  await frame.getByRole('heading', {name: 'Result 17', exact: true}).waitFor();
  await page.evaluate(() => {window.rows = '[8]';});
  await edit(notebook.replace('# Notes', '# Latest notes'));
  await frame.getByRole('heading', {name: 'Result 22', exact: true}).waitFor();
  assert.equal(await child.evaluate(() => globalThis.stableRuns), 1);
  await page.screenshot({path: join(output, 'reactive-editor.png'), fullPage: true});

  // Insert a real portable map as a new native cell, without disturbing existing inputs.
  await page.evaluate(() => window.insertMapFixture());
  const embeddedMap = frame.frameLocator('iframe[title="survey"]');
  await embeddedMap.getByRole('status').filter({hasText:'Offline edition'}).waitFor();
  await frame.getByRole('heading',{name:'Result 22',exact:true}).waitFor();
  assert.equal(await child.evaluate(() => globalThis.stableRuns),1);
  const visibleMap = await embeddedMap.locator('canvas').screenshot();
  await embeddedMap.getByRole('checkbox',{name:'Survey points'}).uncheck();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await embeddedMap.locator('canvas').screenshot(),visibleMap);
  assert(await child.childFrames()[0].evaluate(() => {try {parent.document;return false;}catch{return true;}}));

  // Export the actual unsaved draft and its current attachments through the UI.
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Download HTML', exact: true}).click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'index.html');
  await download.saveAs(join(output, 'notebook.html'));
  const html = await readFile(join(output, 'notebook.html'), 'utf8');
  const standalone = await context.newPage(); await standalone.setContent(html);
  assert.equal(await standalone.title(), 'Spatial analysis');
  await standalone.getByRole('heading', {name: 'Latest notes'}).waitFor();
  await standalone.getByText('"Archived example"', {exact: true}).waitFor();
  await standalone.getByRole('heading', {name: 'Result 20', exact: true}).waitFor();
  await standalone.locator('input[type=range]').fill('5'); await standalone.locator('input[type=range]').dispatchEvent('input');
  await standalone.getByRole('heading', {name: 'Result 23', exact: true}).waitFor();
  await standalone.frameLocator('iframe[title="survey"]').getByRole('status').filter({hasText:'Offline edition'}).waitFor();
  await edit(notebook.replace('const stable=10;', 'const stable=;'));
  await page.getByText(/Preview unavailable:/).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'), null);
  await edit(notebook);
  await frame.getByRole('heading', {name: 'Result 20', exact: true}).waitFor();
  assert.deepEqual(requests, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({reactiveInput: true,attachmentRefresh: true,unrelatedCellsPreserved: true,plotRendered: true,
    opaquePreview: true,standaloneHtml: true,workerCompiledHtml: true,embeddedStudioMap:true,mapInsertionPreservesCells:true,externalRequests: 0,awsRequests: 0,artifactDirectory: output}));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error('Editor:', (await page.locator('body').innerText()).slice(-2500));
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) console.error('Frame:', (await frame.locator('body').innerText().catch(() => '')).slice(0, 2500));
  }
  console.error({errors, consoleErrors, requests, output});
  throw error;
} finally {await browser.close();}
