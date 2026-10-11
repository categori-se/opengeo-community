import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, extname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const work = await mkdtemp(join(tmpdir(),'opengeo-jupyter-images-'));
const studio = 'https://studio.opengeo.tools';
const policySource = await readFile(resolve(root, 'infrastructure/lib/studio-web-stack.ts'), 'utf8');
const policy = [...policySource.slice(policySource.indexOf('export const STUDIO_CONTENT_SECURITY_POLICY = [')).split('].join')[0].matchAll(/"([^"]+)"/g)].map(match => match[1]).join('; ');
assert(policy.includes('frame-src'));
const selectedDist = process.argv.find(value=>value.startsWith('--dist='))?.slice(7);
const dist = selectedDist ? resolve(selectedDist) : resolve(root,'app/dist');
const componentPath = selectedDist ? '/_import/components/'+(await readdir(resolve(dist,'_import/components'))).find(name=>name.startsWith('PublicationCodeEditor.')&&name.endsWith('.js')) : '/component.js';
const bundled = selectedDist ? null : await build({entryPoints: [resolve(root, 'app/src/components/PublicationCodeEditor.js')], bundle: true, format: 'esm', write: false});
const browser = await chromium.launch({headless: true, executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)});
const errors = [], unexpectedRequests = [];
try {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== studio) {unexpectedRequests.push(url.href); return route.abort();}
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', headers: {'Content-Security-Policy': policy}, body: '<!doctype html><title>Notebook editor test</title><style>body{margin:0}main{max-width:100%;overflow:hidden}.publication-code-editor{height:400px}.publication-code-editor[hidden],[hidden]{display:none}iframe{width:100%;height:450px;border:0}</style><main></main>'});
    if (!selectedDist && url.pathname === '/component.js') return route.fulfill({contentType: 'text/javascript', body: bundled.outputFiles[0].text});
    if (url.pathname.startsWith('/editor-assets/') || (selectedDist && ['/_import/','/_npm/','/_node/','/_observablehq/'].some(prefix=>url.pathname.startsWith(prefix)))) {
      const path = resolve(dist, '.' + url.pathname);
      assert(path.startsWith(dist + '/'));
      return route.fulfill({contentType: {'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}[extname(path)] ?? 'application/octet-stream', body: await readFile(path)});
    }
    unexpectedRequests.push(url.href); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(studio);
  await page.evaluate(async componentPath => {
    const {PublicationCodeEditor} = await import(componentPath);
    const textarea = document.createElement('textarea');
    const saved = document.createElement('section'); saved.id = 'saved-framework'; saved.textContent = 'Saved Framework build';
    const plot=document.createElement('canvas'); plot.width=360; plot.height=180;
    const drawing=plot.getContext('2d'); drawing.fillStyle='#fff'; drawing.fillRect(0,0,360,180);
    drawing.fillStyle='#222'; drawing.font='15px system-ui'; drawing.fillText('Synthetic survey · area by class',15,25);
    for(const [i,label] of ['Forest','Agriculture','Water'].entries()) {
      drawing.fillStyle=['#438b65','#bd964b','#4383bc'][i]; drawing.fillRect(110,45+i*40,[210,150,80][i],24);
      drawing.fillStyle='#222'; drawing.fillText(label,15,62+i*40);
    }
    const imageBlob=await new Promise(resolve=>plot.toBlob(resolve,'image/png'));
    window.imageReads=[];
    const editor = PublicationCodeEditor({textarea, preview: saved, onSave() {throw Error('Unexpected save');},
      getSourceContext:()=>({sourceRoot:'',readFile:async path=>{
        window.imageReads.push(path);
        if(window.holdImage) await new Promise(resolve=>{window.releaseImage=resolve;});
        if(path!=='images/plot.png') throw Error('Unexpected source read');
        return imageBlob;
      }})});
    const source = JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      {cell_type: 'markdown', metadata: {}, source: '# Notebook results\n![Local plot](images/plot.png)'},
      {cell_type: 'code', metadata: {}, source: '1 + 1', execution_count: 1, outputs: [{output_type: 'display_data', data: {'text/html': '<table><tr><td>2</td></tr></table><img src="https://unexpected.invalid/a" onerror="parent.pwned=true"><script>parent.pwned=true</script>'}}]}
    ]});
    document.querySelector('main').append(textarea, editor.element, editor.preview);
    window.openFile = async (path, content) => {textarea.value = content; await editor.open(path, content);};
    window.originalNotebook = source;
    await window.openFile('analysis.ipynb', source);
  }, componentPath);
  const frame = page.frameLocator('iframe[title="Jupyter saved-output preview"]');
  await frame.getByRole('heading', {name: 'Notebook results'}).waitFor({timeout: 15000});
  assert.equal(await frame.locator('td').textContent(), '2');
  await frame.getByAltText('Local plot').evaluate(image=>image.decode());
  assert.equal(await frame.getByAltText('Local plot').evaluate(image=>image.naturalWidth),360);
  await writeFile(join(work,'notebook.html'),await page.locator('iframe').getAttribute('srcdoc'));
  await page.screenshot({path:join(work,'editor.png')});
  assert((await page.evaluate(()=>imageReads)).every(path=>path==='images/plot.png'));
  assert(await page.locator('#saved-framework').isHidden());
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
  assert(await page.locator('.monaco-editor .view-lines span[class*="mtk"]').count() > 5);
  await page.evaluate(async()=>{window.holdImage=true;await window.openFile('second.ipynb',window.originalNotebook);});
  await page.waitForFunction(()=>Boolean(window.releaseImage));
  await page.evaluate(() => window.openFile('src/index.md', '# Framework page'));
  await page.evaluate(()=>{window.holdImage=false;window.releaseImage();});
  assert(await page.locator('#saved-framework').isVisible());
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'), null);
  await page.evaluate(() => window.openFile('analysis.ipynb', window.originalNotebook));
  await frame.getByRole('heading', {name: 'Notebook results'}).waitFor();
  await page.locator('.monaco-editor').click({position: {x: 150, y: 50}});
  await page.keyboard.press('Control+a'); await page.keyboard.insertText('{ invalid JSON');
  await page.getByText(/Preview unavailable:/).waitFor();
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'), null);
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(errors, []);
  const receipt={nativeNotebookPreview: true,localSourceImages:true,staleImageLoadIgnored:true,syntaxHighlighting: true,savedFrameworkPreviewPreserved: true,invalidEditsClearOutput: true,liveStudioCsp: true,externalRequests: 0,artifactDirectory:work,prebuilt:!!selectedDist,componentPath};
  await writeFile(join(work,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
} finally {await browser.close();}
