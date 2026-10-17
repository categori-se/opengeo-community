import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {BrowserLayerRegistration, browserLayerReviewForProject} from '../src/components/BrowserLayerRegistration.js';
import {readBrowserLayerCatalog, writeBrowserLayerCatalog} from '../src/lib/browserLayerCatalogStore.js';

if(process.env.OPEN_GEO_LAYER_REVIEW_DIST){await checkReviewBrowser();process.exit(0);}

it('catalog reuse preserves nested knowledge and explicit unknown rights through review and reopen', async () => {
  const dom = new JSDOM('<!doctype html>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const layer = {datasetId: 'catalog-one', title: 'Survey', sourceType: 'geojson', metadata: {
      source: {license: 'Provider terms', nested: {rights: ['display'], evidence: 'source-revision-1'}},
      normalized: {schema: {height: {unit: 'm'}}, featureCount: 9},
      curated: {license: null, description: 'Reviewed', ownership: {publisher: 'Survey office'}},
      inferred: {coverage: {confidence: 0.4, method: 'bounds', evidence: ['observation-1']}},
      context: [{relationship: 'derivedFrom', resourceId: 'upstream'}]
    }};
    const before = structuredClone(layer);
    const geojson = {type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [1, 2]}, properties: {}}]};
    let saved;
    const dialog = BrowserLayerRegistration({layer, geojson, source: {license: 'Fallback terms'}, onAdd: async value => {saved = value;}});
    assert.equal(dialog.querySelector('[aria-label="License"]').value, '', 'explicit unknown must not inherit provider terms');
    dialog.querySelector('[aria-label="Description"]').value = 'Updated description';
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(saved.datasetId, layer.datasetId);
    assert.deepEqual(saved.metadata.source, before.metadata.source);
    assert.deepEqual(saved.metadata.inferred, before.metadata.inferred);
    assert.deepEqual(saved.metadata.context, before.metadata.context);
    assert.deepEqual(saved.metadata.normalized.schema, before.metadata.normalized.schema);
    assert.equal(saved.metadata.normalized.featureCount, 1);
    assert.deepEqual(saved.metadata.curated.ownership, before.metadata.curated.ownership);
    assert.equal(saved.metadata.curated.description, 'Updated description');
    assert.equal(saved.metadata.curated.license, null);
    assert.deepEqual(layer, before, 'review must not mutate the reusable input');
    const values = new Map();
    const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
    assert.equal(writeBrowserLayerCatalog(storage, new Map([[saved.datasetId, {layer: saved, geojson}]])), true);
    const restored = readBrowserLayerCatalog(storage).get(saved.datasetId).layer;
    assert.deepEqual(restored, saved, 'the independent catalog retains all knowledge across serialization');
    const reopened = BrowserLayerRegistration({layer: restored, geojson, source: restored.metadata.source, onAdd: async () => {throw new Error('cancel must not add');}});
    assert.equal(reopened.querySelector('[aria-label="License"]').value, '');
    [...reopened.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
    assert.equal(document.querySelector('dialog'), null);
    saved.metadata.source.nested.rights.push('changed');
    assert.deepEqual(layer, before, 'nested evidence must be independently cloned');
  } finally {globalThis.document = previous; dom.window.close();}
});


it('delayed source review remains bound to its originating Project and adds only once', async () => {
  const dom = new JSDOM('<!doctype html><main></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const context = {project: {title: 'First'}, shell: document.querySelector('main')};
    let adds = 0;
    const options = {layer: {title: 'Layer', datasetId: 'source'}, geojson: null, onAdd: async () => {adds++;}};
    const delayed = browserLayerReviewForProject(context);
    context.project = {title: 'New Project'};
    assert.equal(delayed(options), null, 'a late source cannot open review in the new Project');
    assert.equal(document.querySelector('dialog'), null);
    const dialog = browserLayerReviewForProject(context)(options);
    context.project = {title: 'Another Project'};
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    assert.equal(adds, 0);
    assert.match(dialog.querySelector('[role="status"]').textContent, /Project has changed/);
    [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
    const detached = browserLayerReviewForProject(context);
    context.shell.remove();
    assert.equal(detached(options), null);
    document.body.append(context.shell);
    context.disposed = true;
    assert.equal(browserLayerReviewForProject(context)(options), null);
    context.disposed = false;
    let complete;
    const pending = browserLayerReviewForProject(context)({...options, onAdd: () => {adds++; return new Promise(resolve => {complete = resolve;});}});
    const submit = () => pending.querySelector('form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
    submit(); submit();
    assert.equal(adds, 1, 'pending confirmation cannot add twice');
    pending.dispatchEvent(new dom.window.Event('cancel', {cancelable: true}));
    assert.equal(pending.isConnected, true, 'Escape cannot dismiss an in-progress addition');
    complete();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector('dialog'), null);
  } finally {globalThis.document = previous; dom.window.close();}
});

it('source review uses explicit Demo, personal-device and Studio storage context', () => {
  const dom=new JSDOM('<main></main>'),previous=globalThis.document;globalThis.document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  try {
    for(const [state,expected] of [
      [{publicDemo:true,demoSurface:false},'Browser draft · save on this device to keep'],
      [{publicDemo:true,demoSurface:true},'Demo draft · save a personal copy to keep'],
      [{publicDemo:true,demoSurface:true,localProjectRecord:{id:'mine'}},'Saved on this device with your Project'],
      [{publicDemo:false,demoSurface:false},'Temporary browser data · excluded from account Save · expires after 24 hours']
    ]) {
      const context={...state,project:{},shell:document.querySelector('main')};
      const dialog=browserLayerReviewForProject(context)({layer:{title:'GPS'},geojson:null,onAdd:()=>{}});
      assert(dialog.textContent.includes(expected));if(!state.demoSurface)assert(!/demo/i.test(dialog.textContent));
      [...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click();
    }
  }finally{globalThis.document=previous;dom.window.close();}
});

async function checkReviewBrowser(){
  const {readFile,writeFile,mkdir}=await import('node:fs/promises'),{resolve,dirname}=await import('node:path'),{createHash}=await import('node:crypto');
  const {build}=await import('esbuild'),{chromium}=await import('playwright');
  const dist=resolve(process.env.OPEN_GEO_LAYER_REVIEW_DIST),area=dirname(dirname(dist)),output=resolve(area,'../compiled-review-final');await mkdir(output,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(area,'dist/opengeo-studio-build.json'))),find=prefix=>manifest.artifactTree.files.find(f=>f.path.startsWith(prefix)&&f.path.endsWith('.js'));
  const component=find('_import/components/BrowserLayerRegistration.'),css=manifest.artifactTree.files.find(f=>/^_file\/style\.[a-f0-9]+\.css$/.test(f.path)),theme=manifest.artifactTree.files.find(f=>/^_observablehq\/theme-.*\.css$/.test(f.path));
  assert(component&&css&&theme);const saved=JSON.parse(await readFile(resolve(area,'../compiled-browser/project.opengeo-project.json'))),layer=saved.layers[0];
  const source=await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');assert.equal(layer.metadata.source.sha256,hash(source));
  const bundled=await build({stdin:{contents:`import {browserLayerReviewForProject} from ${JSON.stringify(resolve(dist,component.path))};const shell=document.querySelector('main'),project={};window.openReview=mode=>{shell.dataset.colorMode=mode;const layer=window.reviewFixture;return browserLayerReviewForProject({project,shell,publicDemo:true,demoSurface:false,localProjectRecord:{id:'retained-personal-project'}})({layer,geojson:layer.geojson,source:layer.metadata.source,onAdd:()=>{throw Error('Style check must not add or save');}});};`,resolveDir:dist},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent',plugins:[{name:'sealed-local-paths',setup(b){b.onResolve({filter:/^\/(?:_import|_node|_npm|_observablehq)\//},a=>({path:resolve(dist,'.'+a.path)}));}}]});
  const resources=new Map([['/',{type:'text/html',body:Buffer.from('<!doctype html><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/style.css"><main class="opengeo-workbench" data-color-mode="light"></main><script type="module" src="/review.js"></script>')}],['/review.js',{type:'text/javascript',body:Buffer.from(bundled.outputFiles[0].contents)}]]);
  for(const [path,file] of [['/theme.css',theme],['/style.css',css]]){const bytes=await readFile(resolve(dist,file.path));assert.equal(hash(bytes),file.sha256);resources.set(path,{type:'text/css',body:bytes});}
  const receipt={status:'started',limits:{GETs:6,bytes:2097152,seconds:20,originalDownloads:1},GETs:0,bytes:0,AWS:0,API:0,provider:0,saves:0,originalDownloads:0,errors:[],buildTree:manifest.artifactTree.digest,sourceSHA256:hash(source),componentSHA256:component.sha256,CSSSHA256:css.sha256,themeSHA256:theme.sha256,reuses:'Actual personal-Project export, already proved equal to metadata and geometry reopened from IndexedDB; no map/storage/numerical journey replay.'};
  const persist=()=>writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await persist();const start=Date.now(),server=await chromium.launchServer({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--opengeo-gpx-review']}),browser=await chromium.connect(server.wsEndpoint());let page;
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',acceptDownloads:true});await context.addInitScript(layer=>window.reviewFixture=layer,layer);
    await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol))return route.continue();assert.equal(u.origin,'https://review-gpx.test');assert.equal(route.request().method(),'GET');const resource=resources.get(u.pathname);assert(resource);assert(++receipt.GETs<=6);receipt.bytes+=resource.body.length;assert(receipt.bytes<=2097152&&Date.now()-start<20000);await persist();return route.fulfill({body:resource.body,contentType:resource.type});});
    page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>receipt.errors.push(e.message));await page.goto('https://review-gpx.test/');
    for(const mode of ['light','dark']){
      await page.evaluate(mode=>window.openReview(mode),mode);const dialog=page.locator('.browser-layer-registration');await dialog.waitFor();
      assert(!/demo/i.test(await dialog.innerText()));assert((await dialog.innerText()).includes('Saved on this device'));assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      const samples=await dialog.evaluate(root=>{const rgba=v=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=v;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data];};const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return[root,...['h2','label','input','p','dt','dd','button'].map(s=>root.querySelector(s))].map(n=>{let p=n,bg=rgba(getComputedStyle(p).backgroundColor);while(bg[3]<255&&p.parentElement){p=p.parentElement;bg=rgba(getComputedStyle(p).backgroundColor);}const fg=rgba(getComputedStyle(n).color),a=lum(fg),b=lum(bg);return{element:n.tagName,foreground:fg,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});});
      (receipt.themes??=[]).push({mode,samples});await persist();assert(samples.every(s=>s.background[3]===255&&s.ratio>=4.5));await page.screenshot({path:resolve(output,`review-${mode}.png`)});
      if(mode==='light'){const [download]=await Promise.all([page.waitForEvent('download'),dialog.getByRole('button',{name:'Download original GPX',exact:true}).click()]);await download.saveAs(resolve(output,'retained-original.gpx'));assert.equal(hash(await readFile(resolve(output,'retained-original.gpx'))),hash(source));receipt.originalDownloads++;}
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    }
    assert.deepEqual(receipt.errors,[]);assert(Date.now()-start<20000);receipt.status='passed-final-built-GPX-review-light-dark390px-and-retained-original-download';
  }catch(error){receipt.status='stopped';receipt.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:resolve(output,'stopped.png')});throw error;}
  finally{await browser.close();await server.close();receipt.browserClosed=true;receipt.elapsedMilliseconds=Date.now()-start;await persist();}
}
