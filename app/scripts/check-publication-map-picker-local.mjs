// Real picker, workspace, feature loader, MapLibre and export dialog; synthetic
// account records only. Every browser request is intercepted. No cloud access.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
const work = await mkdtemp(join(tmpdir(), 'opengeo-saved-map-picker-'));
const origin = 'https://studio.opengeo.tools';
const workerNames=(await readdir(join(root,'app/dist/_file/assets'))).filter(name=>/^maplibre-worker\.[a-f0-9]{8}\.js$/.test(name));
assert.equal(workerNames.length,1,'Reuse the one built renderer worker');
const worker=await readFile(join(root,'app/dist/_file/assets',workerNames[0]));
assert.equal(createHash('sha256').update(worker).digest('hex').slice(0,8),workerNames[0].split('.')[1]);
const bundle = await build({stdin: {resolveDir: join(root, 'app'), contents: `
  import {openPublicationMapPicker} from './src/components/PublicationMapPicker.js';
  import {verifyPortableMapArtifact} from './src/lib/portableMapArtifact.js';
  import {publicationMapInsert} from './src/lib/publicationMapInsert.js';
  import {StyleLibrary} from './src/components/StyleLibrary.js';
  import {PublicationWorkspaceDirectory} from './src/components/PublicationWorkspaceDirectory.js';
  if(location.pathname === '/styles') document.body.append(StyleLibrary({adapter:{kind:'api'},containers:[]}));
  if(location.pathname === '/publications') {
    const records=Array.from({length:32},(_,i)=>{const id='80000000-0000-4000-8000-'+String(i+1).padStart(12,'0');return {
      id,siteId:id,sourceProjectId:id,projectId:'50000000-0000-4000-8000-000000000001',kind:'framework',status:'draft',
      title:i===0?'Bhutan land cover':i===1?'Nepal land cover':'Survey '+i,projectName:'Climate maps',currentRevision:2,
      hostname:'opengeo.tools',mountPath:'/climate/survey-'+i+'/'
    };});
    records.push({...records[0],id:'80000000-0000-4000-8000-000000000100',siteId:'80000000-0000-4000-8000-000000000100',
      sourceProjectId:'80000000-0000-4000-8000-000000000100',title:'Publisher acceptance',projectName:'Publisher acceptance · HTML',mountPath:'/publisher-check/html/'});
    document.body.append(PublicationWorkspaceDirectory({records}));
  }
  const project = {id:'project',name:'Survey project',status:'active',callerRole:'owner'};
  const layer = {layerId:'survey',datasetId:'dataset',title:'Survey points',sourceType:'governed-dataset',
    geometryType:'Point',visible:true,opacity:1,order:0,style:{},labels:{enabled:false}};
  const map = {id:'map',name:'Saved survey',projectId:'project',status:'active',version:3,
    definition:{activeLayerId:'survey',layers:[layer],basemaps:[],bookmarks:[],
      mapViews:[{id:'default',center:[90.4,27.5],zoom:8,pitch:0,bearing:0}]}};
  const original = JSON.stringify(map);
  window.reads=[]; window.writes=[];
  const methods = {
    getSession:()=>({selectedOrganizationId:'org',memberships:[{organizationId:'org'}]}),
    selectOrganization:()=>{}, getCurrentOrganization:()=>({id:'org',name:'Test',callerRole:'admin'}),
    listProjects:()=>[project],getProject:()=>project,listMaps:()=>[map],getMap:()=>map,
    listDatasets:()=>[{id:'dataset',name:'Survey points',sourceType:'upload',format:'geojson',status:'active',
      geometryType:'Point',capabilities:{read:true},tags:[],classification:'internal'}],
    listSources:()=>[],listProjectDatasetConnectionBindings:()=>[],listProjectBasemapConnectionBindings:()=>[],
    listFeatures:()=>({numberMatched:1,numberReturned:1,collection:{generation:1,fields:[]},features:[
      {type:'Feature',properties:{name:'Survey point'},geometry:{type:'Point',coordinates:[90.4,27.5]}}
    ]})
  };
  const adapter = new Proxy({kind:'api'}, {get(target,key){
    if(key in target) return target[key];
    if(key in methods) return async (...args)=>{window.reads.push({method:key,args});return methods[key](...args);};
    if(/^(create|update|save|delete|request|start|cancel)/.test(String(key))) return ()=>{window.writes.push(key);throw Error('Unexpected write '+key);};
  }});
  window.unchanged=()=>JSON.stringify(map)===original;
  document.querySelector('[data-insert-map]')?.addEventListener('click',()=>openPublicationMapPicker({adapter,projects:[project],currentProjectId:'project',
    onInsert:async ({blob,name,manifest})=>{
      await verifyPortableMapArtifact(blob,manifest);
      const result=publicationMapInsert({entryPath:'src/index.md',name,blob,manifest});
      window.inserted={name,html:await blob.text(),manifest,snippet:result.snippet,files:await Promise.all(result.files.map(async file=>({path:file.relativePath,text:await file.blob.text()})))};
    }}));
`}, bundle:true,format:'esm',platform:'browser',write:false,outdir:work,loader:{'.css':'css'},plugins:[{name:'retained-renderer-worker',setup(builder){
  builder.onResolve({filter:/^observablehq:stdlib$/},()=>({path:'local-stdlib',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const FileAttachment=path=>({url:async()=>path.includes('maplibre-worker')?'/worker.js':'/cog-reader.js'});"}));
}}]});
const js = Buffer.from(bundle.outputFiles.find(file=>file.path.endsWith('.js')).contents);
const css = await readFile(join(root,'app/src/style.css'),'utf8');
const policySource = await readFile(join(root,'infrastructure/lib/studio-web-stack.ts'),'utf8');
const policy = [...policySource.split('export const STUDIO_CONTENT_SECURITY_POLICY = [')[1].split('].join')[0]
  .matchAll(/"([^"\n]+)"/g)].map(match=>match[1]).join('; ');
const browser = await chromium.launch({headless:true,executablePath:['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync),
  args:['--enable-unsafe-swiftshader']});
const requests=[];
try {
  const context=await browser.newContext({viewport:{width:1280,height:960}});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url()); requests.push(url.href);
    if(url.origin!==origin) {
      // The saved viewer's public basemap is replaced by an empty local style.
      if(url.hostname==='tiles.openfreemap.org' && url.pathname.includes('/styles/')) return route.fulfill({json:{version:8,sources:{},layers:[]}});
      return route.abort();
    }
    if(url.pathname==='/picker.js') return route.fulfill({contentType:'text/javascript',body:js});
    if(url.pathname==='/style.css') return route.fulfill({contentType:'text/css',body:css});
    if(url.pathname==='/worker.js') return route.fulfill({contentType:'text/javascript',body:worker});
    if(url.pathname.startsWith('/export-runtime/')) {
      const name=url.pathname.slice('/export-runtime/'.length);
      assert(['maplibre-gl.js','maplibre-gl.css','LICENSE.txt'].includes(name));
      return route.fulfill({body:await readFile(join(root,'app/dist/export-runtime',name))});
    }
    if(url.pathname==='/export.html') return route.fulfill({contentType:'text/html',body:await readFile(join(work,'map.html'))});
    if(['/', '/styles', '/publications'].includes(url.pathname)) return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':policy},body:
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{--theme-background:#1e1e1e;--theme-background-alt:#171717;--theme-foreground:#ddd;--theme-foreground-muted:#999;--theme-foreground-focus:#5088ff;--theme-foreground-faintest:#383838}body{font:14px system-ui;background:var(--theme-background);color:var(--theme-foreground)}</style>'+(url.pathname==='/'?'<button data-insert-map>Insert map</button>':'<h1>'+ (url.pathname==='/styles'?'Styles':'Publications')+'</h1>')+'<script type="module" src="/picker.js"></script>'});
    return route.fulfill({status:404,body:'Not found'});
  });
  const page=await context.newPage();
  page.on('pageerror',error=>console.error(error.message));
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000}); await page.getByRole('button',{name:'Insert map',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Saved map"]')?.options.length===1);
  assert.deepEqual(await page.evaluate(()=>reads.map(item=>item.method)),['listMaps'],'The compact selector must only list the first saved-map page');
  const picker=page.locator('.publication-map-picker');
  assert.equal(await picker.getByText('More maps',{exact:true}).isVisible(),false,'Hide pagination for a complete first page');
  assert.equal(await picker.getByText('Try again',{exact:true}).isVisible(),false,'Hide retry until a request fails');
  const chooser=await picker.boundingBox(); assert(chooser.height<400,'The initial chooser must fit its content');
  await page.screenshot({path:join(work,'chooser.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await picker.evaluate(node=>node.scrollWidth<=node.clientWidth),'The phone chooser must not overflow horizontally');
  await page.screenshot({path:join(work,'chooser-phone.png')});
  await page.setViewportSize({width:1280,height:960});
  await picker.getByRole('button',{name:'Insert map',exact:true}).click();
  await page.waitForFunction(()=>reads.some(item=>item.method==='listFeatures'));
  await page.locator('.publication-map-picker canvas').first().waitFor();
  await page.screenshot({path:join(work,'picker.png')});
  const review=page.locator('.static-map-export-dialog');
  await review.waitFor();
  const reviewedLayer=review.getByRole('checkbox',{name:/Survey points/});
  assert.equal(await reviewedLayer.isDisabled(),false,'Layer review must wait for actual source and paint installation');
  assert.equal(await reviewedLayer.isChecked(),true,'The loaded selected layer must be included by default');
  const insert=review.getByRole('button',{name:'Insert in publication',exact:true});
  assert(await insert.isDisabled());
  await review.getByLabel(/I have reviewed these layers/).check();
  await insert.click();
  await page.waitForFunction(()=>Boolean(window.inserted));
  const result=await page.evaluate(()=>({inserted,reads,writes,unchanged:unchanged()}));
  assert.equal(result.inserted.name,'Saved survey.html');
  assert.equal(result.inserted.manifest.output.checksumSha256,createHash('sha256').update(result.inserted.html).digest('hex'));
  assert.equal(result.inserted.manifest.project,null);
  assert.equal(result.inserted.manifest.provenance.originatingProject.id,'map');
  assert.equal(result.inserted.manifest.provenance.originatingProject.version,3);
  assert.equal(result.inserted.manifest.provenance.authoritativeBuild,false);
  assert.equal(result.inserted.manifest.build.inputScope,'reviewed-browser-snapshot');
  assert.equal(result.inserted.files.length,3);
  assert.match(result.inserted.snippet,/import \{createView as mapView\} from "\.\/maps\/Saved-survey.js"/);
  assert.deepEqual(JSON.parse(result.inserted.files[1].text),result.inserted.manifest);
  assert.equal(result.inserted.files[0].text,result.inserted.html);
  assert.deepEqual(result.writes,[]); assert.equal(result.unchanged,true);
  assert.equal(await page.locator('.publication-map-picker').count(),0);
  await writeFile(join(work,'map.html'),result.inserted.html);
  const exported=await context.newPage(); const start=requests.length;
  await exported.goto(origin+'/export.html');
  await exported.locator('#status').getByText(/^Offline edition · selected vector data included/).waitFor();
  assert.equal(await exported.title(),'Saved survey');
  const canvas=exported.locator('canvas'); const sha=body=>createHash('sha256').update(body).digest('hex');
  const visible=sha(await canvas.screenshot());
  await exported.getByLabel('Survey points').uncheck(); await exported.waitForTimeout(350);
  assert.notEqual(sha(await canvas.screenshot()),visible);
  assert.deepEqual(requests.slice(start),[origin+'/export.html'],'The exported map must make no data or runtime requests');
  await exported.screenshot({path:join(work,'export.png')});
  await page.goto(origin+'/styles');
  await page.getByRole('button',{name:'Water preset',exact:true}).waitFor();
  assert.equal(await page.locator('.style-preset-card').count(),5);
  assert.equal(await page.locator('.style-preset-card img').first().evaluate(node=>Math.round(node.getBoundingClientRect().height)),48,'Preset swatches must remain compact');
  await page.getByRole('button',{name:'Forest preset',exact:true}).click();
  assert.equal(await page.getByLabel('Style title',{exact:true}).inputValue(),'Forest');
  assert.equal(await page.getByRole('button',{name:'Forest preset',exact:true}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.evaluate(()=>reads),[],'Viewing and choosing built-in styles must make no account requests');
  assert.deepEqual(await page.evaluate(()=>writes),[]);
  await page.screenshot({path:join(work,'styles.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The phone Styles page must not overflow horizontally');
  await page.screenshot({path:join(work,'styles-phone.png')});
  await page.setViewportSize({width:1280,height:960}); await page.goto(origin+'/publications');
  await page.getByRole('region',{name:'Publications table'}).waitFor();
  assert.equal(await page.locator('tbody tr').count(),32);
  assert.equal(await page.getByText('Load more publications',{exact:true}).isVisible(),false);
  const checkBox=await page.getByLabel('Show testing publications',{exact:true}).boundingBox();
  assert(checkBox.width<=24 && checkBox.height<=24,'Testing filter uses a compact checkbox');
  const tableHeight=await page.locator('tbody tr').first().evaluate(node=>node.getBoundingClientRect().height);
  assert(tableHeight<85,'Publication rows must be compact');
  assert(await page.locator('.publication-workspace-scroll').evaluate(node=>node.scrollHeight>node.clientHeight),'The table must scroll within its bounded region');
  await page.screenshot({path:join(work,'publications.png')});
  await page.getByLabel('Search publications or URLs',{exact:true}).fill('Nepal');
  assert.equal(await page.locator('tbody tr').count(),1);
  await page.getByLabel('Search publications or URLs',{exact:true}).fill('');
  await page.getByLabel('Show testing publications',{exact:true}).check();
  assert.equal(await page.locator('tbody tr').count(),33);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The phone publication table must scroll within its own region');
  await page.screenshot({path:join(work,'publications-phone.png')});
  const receipt={realSavedMapLoader:true,reviewRequired:true,exactByteManifest:true,publicationSidecarRetained:true,sourceMapUnchanged:true,writes:result.writes,
    reads:result.reads.map(item=>item.method),standaloneOfflineMap:true,compactChooser:true,phoneChooser:true,stylePresets:true,phoneStyles:true,compactPublicationTable:true,publicationSearch:true,testingControl:true,phonePublicationTable:true,publicationData:'synthetic; no real ICIMOD publication availability claim',awsRequests:0,artifactDirectory:work};
  await writeFile(join(work,'receipt.json'),JSON.stringify(receipt,null,2)); console.log(JSON.stringify(receipt));
} catch(error) {console.error(JSON.stringify({requests,artifactDirectory:work})); throw error;}
finally {await browser.close();}
