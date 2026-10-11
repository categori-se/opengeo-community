// Real editor and Framework runtime, with local fixtures and all requests routed.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname,join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {inspectStaticMapLayers, staticMapDocument} from '../src/lib/staticMapExport.js';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';

const root=resolve(new URL('../..',import.meta.url).pathname);
const output=await mkdtemp('/tmp/opengeo-publication-draft-switch-');
const origin='https://studio.opengeo.tools';
const policySource=await readFile(join(root,'infrastructure/lib/studio-web-stack.ts'),'utf8');
const policy=[...policySource.slice(policySource.indexOf('export const STUDIO_CONTENT_SECURITY_POLICY = [')).split('].join')[0]
  .matchAll(/"([^"]+)"/g)].map(match=>match[1]).join('; ');
const edgeSource=await readFile(join(root,'infrastructure/lib/observable-preview-edge.ts'),'utf8');
const draftPolicy=[...edgeSource.slice(edgeSource.indexOf('export const OBSERVABLE_PREVIEW_DRAFT_CSP = [')).split('].join')[0]
  .matchAll(/"([^"]+)"/g)].map(match=>match[1]).join('; ');
const shell=await readFile(join(root,'services/observable-preview/authorize/draft.html'),'utf8');
let shellRequests=0;
const entry=`export {PublicationCodeEditor} from ${JSON.stringify(join(root,'app/src/components/PublicationCodeEditor.js'))};
export {publicationSourceRoot} from ${JSON.stringify(join(root,'app/src/lib/publicationSourceRoot.js'))};`;
const bundled=await build({stdin:{contents:entry,resolveDir:root,loader:'js'},bundle:true,format:'esm',write:false});
const styles=await readFile(join(root,'app/src/style.css'),'utf8');
const errors=[],unexpectedRequests=[],consoleErrors=[];
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),args:['--enable-unsafe-swiftshader']});
try {
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.href==='https://preview.studio.opengeo.tools/authorize/draft.html'){
      assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);shellRequests++;
      return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':draftPolicy},body:shell});
    }
    if(url.origin!==origin){unexpectedRequests.push(url.href);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':policy},body:`<!doctype html><title>Publication preview modes</title>
      <style>:root{--theme-background:#1e1e1e;--theme-background-alt:#181818;--theme-foreground:#ddd;--theme-foreground-muted:#aaa;--theme-foreground-faintest:#444;--sans-serif:system-ui;--monospace:monospace}body{margin:12px;background:#1e1e1e;color:#ddd;font:14px system-ui}[hidden]{display:none!important}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}main>section{min-width:0}select{color:inherit;background:#252525}iframe{width:100%;height:500px;border:0}@media(max-width:700px){main{grid-template-columns:minmax(0,1fr)}}${styles}</style><main></main>`});
    if(url.pathname==='/component.js')return route.fulfill({contentType:'text/javascript',body:bundled.outputFiles[0].text});
    if(url.pathname.startsWith('/editor-assets/')){
      const path=resolve(root,'app/dist','.'+url.pathname);
      assert(path.startsWith(resolve(root,'app/dist/editor-assets')+'/'));
      return route.fulfill({contentType:{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]??'application/octet-stream',body:await readFile(path)});
    }
    unexpectedRequests.push(url.href);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.goto(origin);
  await page.evaluate(async()=>{
    const {PublicationCodeEditor,publicationSourceRoot}=await import('/component.js');
    const textarea=document.createElement('textarea');
    const saved=document.createElement('section');saved.id='saved-build';saved.textContent='Saved project build';
    const source='# Draft analysis\n\n```js\nimport {label} from "../label.js";\nconst amount = view(Inputs.range([1,10],{value:3,step:1}));\nconst rows = await FileAttachment("../data/rows.json").json();\n```\n<section><h2>${label}</h2><p id="computed">${amount * rows[0].value}</p></section>';
    const files={'package.json':'{"type":"module"}','src/methods/index.md':source,
      'src/label.js':'export const label="Nested source dependencies";', 'src/data/rows.json':'[{"value":7}]'};
    window.reads=[];window.saves=0;window.originalSource=source;window.sourceText=textarea;
    const editor=PublicationCodeEditor({textarea,preview:saved,draftPreviewEnabled:true,onSave(){window.saves++;},
      getSourceContext:()=>({sourceRoot:publicationSourceRoot('src/methods/index.md',Object.keys(files)),readFile:async path=>{
        window.reads.push(path);if(window.holdRead)await new Promise(resolve=>{window.releaseRead=resolve;});
        if(!(path in files))throw Error('Unexpected file '+path);
        return new Blob([files[path]],{type:path.endsWith('.json')?'application/json':'text/javascript'});
      }})});
    const sourcePane=document.createElement('section');sourcePane.append(editor.tabs,textarea,editor.element,editor.status);
    document.querySelector('main').append(sourcePane,editor.preview);
    textarea.value=source;await editor.open('src/methods/index.md',source);
    window.openRoot=async nextFiles=>{
      editor.reset();for(const path of Object.keys(files))delete files[path];Object.assign(files,nextFiles);
      textarea.value=files['src/index.md'];await editor.open('src/index.md',textarea.value);
    };
  });
  const mode=page.getByRole('combobox',{name:'Preview mode'});
  await mode.waitFor();assert.equal(await mode.inputValue(),'draft');
  assert.equal(await page.locator('#saved-build').isVisible(),false);
  const frame=page.frameLocator('iframe[title="Framework draft preview"]').frameLocator('iframe[title="Rendered Framework draft"]');
  await frame.getByRole('heading',{name:'Nested source dependencies'}).waitFor();
  await frame.locator('#computed').getByText('21',{exact:true}).waitFor();
  await frame.locator('input[type="range"]').fill('5');
  await frame.locator('#computed').getByText('35',{exact:true}).waitFor();
  assert(await page.evaluate(()=>{try{document.querySelector('iframe').contentWindow.document;return false;}catch{return true;}}));
  assert.deepEqual([...new Set(await page.evaluate(()=>window.reads))].sort(),['src/data/rows.json','src/label.js']);
  const edited=await page.evaluate(()=>window.originalSource.replace('# Draft analysis','# Unsaved analysis'));
  await page.locator('.monaco-editor').click({position:{x:100,y:65}});
  await page.keyboard.press('Control+a');await page.keyboard.insertText(edited);
  await frame.getByRole('heading',{name:'Unsaved analysis'}).waitFor();
  await frame.locator('html').evaluate(element=>{
    const background=getComputedStyle(element).backgroundColor;
    if(background==='rgb(255, 255, 255)' || background==='rgba(0, 0, 0, 0)')throw Error('Dark editor must have a dark draft theme');
  });
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
    await page.screenshot({path:join(output,`draft-${width}.png`),fullPage:true});
  }
  await page.evaluate(()=>{
    document.documentElement.style.setProperty('--theme-background','#fff');
    document.documentElement.style.setProperty('--theme-background-alt','#fff');
  });
  await page.waitForFunction(()=>{
    const note=document.querySelector('.publication-document-preview p');
    return note?.textContent.startsWith('Live draft');
  });
  await frame.locator('html').evaluate(element=>{
    if(getComputedStyle(element).backgroundColor!=='rgb(255, 255, 255)')throw Error('Light editor must have a light draft theme');
  });
  await page.screenshot({path:join(output,'draft-light.png'),fullPage:true});
  await mode.selectOption('saved');
  assert(await page.locator('#saved-build').isVisible());
  assert.equal(await page.evaluate(()=>window.sourceText.value),edited);
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'),null);
  assert.equal(await page.locator('iframe').getAttribute('src'),null);
  // Completing an old draft load must not replace the saved build selection.
  await page.evaluate(()=>{window.holdRead=true;});await mode.selectOption('draft');
  await page.waitForFunction(()=>typeof window.releaseRead==='function');
  await mode.selectOption('saved');
  await page.evaluate(()=>{window.holdRead=false;window.releaseRead();});
  await page.waitForFunction(()=>document.querySelector('#saved-build').hidden===false);
  assert.equal(await mode.inputValue(),'saved');
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'),null);
  assert.equal(await page.locator('iframe').getAttribute('src'),null);
  assert.equal(await page.evaluate(()=>window.saves),0);
  // Use the retained authored homepage, not a synthetic replacement. This checks
  // its imported components and expressions, not full-project configuration.
  const rootFiles={};
  for(const path of ['package.json','src/index.md','src/components/site.js','src/data/site.js']) {
    rootFiles[path]=await readFile(join(root,'.local-archives/studio-discovery-release-20260912/root-original',path),'utf8');
  }
  await page.evaluate(files=>window.openRoot(files),rootFiles);await mode.selectOption('draft');
  await frame.getByRole('heading',{name:'Field-ready workflows for spatial analysis, mapping, and infrastructure screening.'}).waitFor();
  await frame.locator('.site-card').first().waitFor();
  const rootCards=await frame.locator('.site-card').count();assert.equal(rootCards,30);
  assert.equal(await frame.locator('.observablehq--error').count(),0);
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:join(output,'root-draft.png'),fullPage:true});
  const mapRuntime={};
  for(const [key,path] of [['runtimeJs','maplibre-gl.js'],['runtimeCss','maplibre-gl.css'],['runtimeLicense','LICENSE.txt']]) {
    mapRuntime[key]=await readFile(join(root,'app/dist/export-runtime',path),'utf8');
  }
  const candidates=inspectStaticMapLayers({style:{version:8,sources:{sites:{type:'geojson',attribution:'Synthetic survey data',data:{type:'FeatureCollection',features:[
    {type:'Feature',properties:{name:'Survey point'},geometry:{type:'Point',coordinates:[90.4,27.5]}}
  ]}}},layers:[{id:'sites',source:'sites',type:'circle',paint:{'circle-radius':20,'circle-color':'#ff3333'}}]},
    layers:[{layerId:'sites',title:'Survey points'}],handles:new Map([['sites',{sourceId:'sites',layerIds:['sites']}]])});
  const mapHtml=staticMapDocument({...mapRuntime,title:'Draft survey map',view:{center:[90.4,27.5],zoom:8},candidates,selectedIds:['sites']});
  const insertion=publicationMapInsert({entryPath:'src/index.md',name:'survey.html',blob:new Blob([mapHtml],{type:'text/html'})});
  const mapFiles={'package.json':'{"type":"module"}','src/index.md':'# Map draft\n'+insertion.snippet};
  for(const file of insertion.files)mapFiles[file.relativePath]=await file.blob.text();
  await page.evaluate(files=>window.openRoot(files),mapFiles);
  await frame.getByRole('heading',{name:'Map draft'}).waitFor();
  const map=frame.frameLocator('iframe[title="survey"]');
  await map.locator('#status').getByText('Offline edition · selected vector data included',{exact:true}).waitFor({timeout:20000});
  const visible=await map.locator('canvas').screenshot();
  await map.getByLabel('Survey points').uncheck();
  await page.waitForTimeout(400);
  assert.notDeepEqual(await map.locator('canvas').screenshot(),visible,'The inserted map must render and its layer control must change the canvas');
  assert(await map.locator('body').evaluate(()=>{try{parent.document;return false;}catch{return true;}}));
  await page.screenshot({path:join(output,'map-draft.png'),fullPage:true});
  assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
  // Allowing local workers must not give those workers network access. Route
  // interception remains a second boundary if a browser policy regresses.
  const workerNetworkResult=await map.locator('body').evaluate(()=>new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([
      'fetch("https://outside.invalid/worker-probe").then(()=>postMessage("allowed"),()=>postMessage("blocked"));'
    ],{type:'text/javascript'}));
    const worker=new Worker(url);
    const finish=(value,error)=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(null,Error('Worker probe timed out')),5000);
    worker.onmessage=event=>finish(event.data);worker.onerror=()=>finish(null,Error('Worker did not run'));
  }));
  assert.equal(workerNetworkResult,'blocked');
  assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(errors,[]);
  assert(consoleErrors.every(message=>message.includes('outside.invalid/worker-probe') && /Content Security Policy/i.test(message)));
  const receipt={passed:true,draftAndSavedModes:true,reactiveDraft:true,nestedProjectDependencies:true,
    unsavedEditsRetained:true,staleCompletionIgnored:true,opaqueSandbox:true,liveStudioCsp:true,
    widths:[1280,390],sourceSaves:0,buildRequests:0,awsRequests:0,externalRequests:0,
    separatePreviewCsp:true,explicitLightAndDarkThemes:true,retainedRootCards:rootCards,
    insertedStudioMap:true,offlineMapLayerToggle:true,workerNetworkDenied:true,
    fixtureShellRequests:shellRequests,artifactDirectory:output};
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}catch(error){
  await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,errors,consoleErrors,unexpectedRequests},null,2));
  console.error('Failure evidence: '+join(output,'failure.json'));throw error;
}finally{await browser.close();}
