import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, extname, join} from 'node:path';
import {chromium} from 'playwright';
import {inspectStaticMapLayers, staticMapDocument} from '../src/lib/staticMapExport.js';
import {publicationMapInsert} from '../src/lib/publicationMapInsert.js';
import {runBuild, INVOCATION_SCHEMA, FRAMEWORK_VERSION} from '../../services/observable-builder/src/contract.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const reused = process.env.OPENGEO_FRAMEWORK_MAP_REUSE_ROOT;
const work = reused ? resolve(reused) : await mkdtemp(join(tmpdir(), 'opengeo-framework-map-'));
const input = join(work, 'input'), workspace = join(work, 'build');
const sha = body => createHash('sha256').update(body).digest('hex');
const runtime = {};
for (const [name, path] of [['runtimeJs','dist/maplibre-gl.js'],['runtimeCss','dist/maplibre-gl.css'],['runtimeLicense','LICENSE.txt']]) {
  runtime[name] = await readFile(resolve(root, 'app/dist/export-runtime', path.replace('dist/', '')), 'utf8');
}
const candidates = inspectStaticMapLayers({
  style: {sources: {sites: {type:'geojson', data:{type:'FeatureCollection',features:[
    {type:'Feature',properties:{name:'Survey point'},geometry:{type:'Point',coordinates:[90.4,27.5]}}
  ]}, attribution:'Example survey data'}}, layers:[{id:'sites',type:'circle',source:'sites',paint:{'circle-radius':18,'circle-color':'#e02929'}}]},
  layers:[{layerId:'sites',title:'Survey points'}], handles:new Map([['sites',{sourceId:'sites',layerIds:['sites']}]])
});
const html = staticMapDocument({...runtime,title:'Bhutan survey map',view:{center:[90.4,27.5],zoom:8},candidates,selectedIds:['sites']});
const inserted = publicationMapInsert({entryPath:'index.md',name:'survey.html',blob:new Blob([html],{type:'text/html'})});
const files = {'index.md':'# Map in a Framework article\n'+inserted.snippet};
for (const file of inserted.files) files[file.relativePath] = await file.blob.text();
const manifest=[];
for (const [path, content] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b))) {
  const target=join(input,path);
  if(reused) assert.equal(await readFile(target,'utf8'),content,'Retained build inputs must match the current insertion');
  else {await mkdir(dirname(target),{recursive:true});await writeFile(target,content);}
  manifest.push({path,contentType:path.endsWith('.md')?'text/markdown':path.endsWith('.js')?'text/javascript':'text/html',sizeBytes:Buffer.byteLength(content),checksumSha256:sha(content)});
}
const invocation={schemaVersion:INVOCATION_SCHEMA,buildJobId:randomUUID(),requestChecksumSha256:'a'.repeat(64),
  inputManifestChecksumSha256:'b'.repeat(64),entryPath:'index.md',lockfilePath:null,files:manifest,
  request:{schemaVersion:'opengeo.observable-build-request.1.0.0',sourceProjectId:randomUUID(),sourceRevisionId:randomUUID(),sourceRevisionNumber:1,
    sourceManifestChecksumSha256:'b'.repeat(64),purpose:'preview',compilerImageDigest:'sha256:'+'c'.repeat(64),frameworkVersion:FRAMEWORK_VERSION,
    lockfileFormat:'npm-package-lock-v3',lockfileChecksumSha256:null,networkPolicy:'deny_all',
    resourceLimits:{cpuMillis:1000,memoryMiB:1024,timeoutSeconds:60,maxInputFiles:128,maxInputBytes:16*1024*1024,maxOutputFiles:512,maxOutputBytes:32*1024*1024}}};
const report=reused?null:runBuild({invocation,inputRoot:input,workspaceRoot:workspace,
  observableCliPath:resolve(root,'app/node_modules/.bin/observable'),frameworkCacheRoot:resolve(root,'app/src/.observablehq/cache')});
if(report) {assert(report.routeManifest.some(route=>route.path==='/' && route.file==='dist/index.html'));
  assert.equal(report.validationReport.publicationAuthorized,false);}
else assert((await readFile(join(workspace,'dist/index.html'),'utf8')).includes('Map in a Framework article'));
async function policy(path,name){
  const source=await readFile(resolve(root,path),'utf8');
  const literal=source.split(`export const ${name} = [`,2)[1].split('].join',1)[0];
  return [...literal.matchAll(/"([^"\n]+)"/g)].map(match=>match[1]).join('; ');
}
const studio='https://studio.opengeo.tools',preview='https://preview.studio.opengeo.tools';
const studioPolicy=await policy('infrastructure/lib/studio-web-stack.ts','STUDIO_CONTENT_SECURITY_POLICY');
const previewPolicy=await policy('infrastructure/lib/observable-preview-edge.ts','OBSERVABLE_PREVIEW_BUILD_CSP');
const browser=await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),
  args:['--enable-unsafe-swiftshader']});
let outsideRequests=0;
try{
  const context=await browser.newContext({viewport:{width:1100,height:900}});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===studio)return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':studioPolicy},
      body:`<!doctype html><iframe title="Framework" sandbox="allow-scripts allow-same-origin" src="${preview}/index.html" style="width:100%;height:850px"></iframe>`});
    if(url.origin!==preview){outsideRequests++;return route.abort();}
    const path=resolve(workspace,'dist','.'+decodeURIComponent(url.pathname));
    assert(path.startsWith(join(workspace,'dist')+'/'));
    try{return route.fulfill({contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream',
      headers:{'Content-Security-Policy':previewPolicy},body:await readFile(path)});}
    catch{return route.fulfill({status:404,body:'Not found'});}
  });
  const page=await context.newPage();
  page.on('console',message=>{if(message.type()==='error')console.error(message.text().slice(0,500));});
  await page.goto(studio);
  const article=page.frameLocator('iframe[title="Framework"]');
  await article.getByRole('heading',{name:'Map in a Framework article'}).waitFor();
  const map=article.frameLocator('iframe[title="survey"]');
  await map.locator('#status').getByText(/^Offline edition · selected vector data included/).waitFor({timeout:20000});
  const canvas=map.locator('canvas');
  const visible=await canvas.screenshot();
  await map.getByLabel('Survey points').uncheck();
  await page.waitForTimeout(400);
  assert.notEqual(sha(await canvas.screenshot()),sha(visible),'The embedded layer control must change the rendered map');
  const articleFrame=page.frames().find(frame=>frame.url()===preview+'/index.html');
  const isolated=articleFrame.childFrames()[0];
  assert(isolated,'The compiled article must contain an embedded map frame');
  assert(await isolated.evaluate(()=>{try{parent.document;return false;}catch{return true;}}));
  assert.equal(outsideRequests,0);
  console.log(JSON.stringify({frameworkBuild:true,realMapLibre:true,offlineLayerToggle:true,opaqueMapFrame:true,
    externalRequests:outsideRequests,awsRequests:0,reusedBuild:Boolean(reused),artifactDirectory:work}));
}finally{await browser.close();}
