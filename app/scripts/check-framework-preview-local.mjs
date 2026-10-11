import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {buildFrameworkPreview} from './build-framework-preview.mjs';

const selectedDist = process.argv.find(value=>value.startsWith('--dist='))?.slice(7);
const directory = selectedDist ? resolve(selectedDist, 'editor-assets') : await mkdtemp(join(tmpdir(), 'opengeo-framework-preview-'));
const compiler = selectedDist ? JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')).frameworkPreview : await buildFrameworkPreview(directory);
const code = await readFile(join(directory, compiler));
const server = createServer((request, response) => {
  if (request.url === '/compiler.js') {response.writeHead(200, {'Content-Type':'text/javascript'}); response.end(code); return;}
  response.writeHead(200, {'Content-Type':'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data:; style-src 'self' 'unsafe-inline' data:; connect-src 'self' data: blob:; frame-src 'none'"});
  response.end('<!doctype html><iframe sandbox="allow-scripts" style="width:100%;height:900px" title="Framework"></iframe>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true, executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync)});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if(message.type()==='error') console.error(message.text().slice(0,250));});
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  const render = async files => page.evaluate(async files => {
    const {renderFrameworkPreview, resolvePreviewPath} = await import('/compiler.js');
    window.resolvePreviewPath = resolvePreviewPath;
    window.previewResult = await renderFrameworkPreview({path:'src/index.md',content:files['src/index.md'],sourceRoot:'src',
      readFile: async path => {if (!(path in files)) throw Error('Missing '+path); return new Blob([files[path]], {type:path.endsWith('.json')?'application/json':'text/javascript'});}});
    document.querySelector('iframe').srcdoc = window.previewResult.html;
  }, files);
  await render({'src/index.md':'# Preview\n\n```js\nimport {label} from "./label.js";\nconst amount = view(Inputs.range([1,10],{value:3,step:1}));\nconst rows = await FileAttachment("./rows.json").json();\n```\n<section><h2>${label}</h2><p id="computed">${amount * rows[0].value}</p></section>',
    'src/label.js':'export const label = "Reactive result";', 'src/rows.json':'[{"value":7}]'});
  const frame = page.frameLocator('iframe');
  await frame.getByRole('heading',{name:'Reactive result'}).waitFor();
  await frame.locator('#computed').getByText('21',{exact:true}).waitFor();
  await frame.locator('input[type="range"]').fill('5');
  await frame.locator('#computed').getByText('35',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => {try{document.querySelector('iframe').contentWindow.document;return false;}catch{return true;}}), true, 'preview cannot share Studio origin');
  assert.equal(await page.evaluate(() => {try{window.resolvePreviewPath('/index','../private.json');return false;}catch{return true;}}), true);
  const root = '/home/aaron/framework/opengeo.tools';
  const files = {};
  for (const path of ['src/index.md','src/components/site.js','src/data/site.js']) files[path] = await readFile(join(root,path),'utf8');
  await render(files);
  await frame.getByRole('heading',{name:'Field-ready workflows for spatial analysis, mapping, and infrastructure screening.'}).waitFor();
  await frame.locator('.site-card').first().waitFor();
  assert.ok(await frame.locator('.site-card').count() > 5, 'real root expressions render their imported components');
  assert.equal(await frame.locator('.observablehq--error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({reactiveInputs:true,fileAttachment:true,localImports:true,opaqueSandbox:true,rootCards:await frame.locator('.site-card').count(), githubRuns:0, awsRequests:0, prebuilt:!!selectedDist, compiler}));
} finally {await browser.close(); await new Promise(resolve => server.close(resolve));}
