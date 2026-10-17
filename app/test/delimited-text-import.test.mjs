import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readDelimitedFile,inspectDelimitedText,mapDelimitedText,originalDelimitedFile} from '../src/lib/delimitedTextImport.js';
import {readBrowserProjectFile} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';
import {createTemporaryUpload,serializeTemporaryWork,restoreTemporaryWork} from '../src/lib/temporaryAnnotations.js';

const bytes=await readFile(new URL('../../fixtures/gps/coordinate-survey.csv',import.meta.url));
const read=(value=bytes,name='coordinate-survey.csv')=>readDelimitedFile(new File([value],name));
const options={xColumn:'east',yColumn:'north',sourceProjection:'EPSG:4326',elevationColumn:'height_ft',elevationUnit:'foot',verticalDatum:'Survey datum, supplied by operator'};

if(process.env.OPEN_GEO_DELIMITED_COLORS_DIST){await checkDelimitedColorsBrowser();process.exit(0);}
if(process.env.OPEN_GEO_DELIMITED_DIST){await checkDelimitedBrowser();process.exit(0);}

it('maps explicit CRS/columns/height without blank-to-zero, coercion, lost quoted newlines or silent omission',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw Error('No network for delimited import');};
  try {
    const table=inspectDelimitedText(await read());assert.equal(table.rows.length,3);
    assert.throws(()=>mapDelimitedText(table,options),e=>e.code==='delimited_invalid_rows'&&e.report.rejectedRecords[0].record===4);
    const result=mapDelimitedText(table,{...options,skipInvalid:true});const f=result.geojson.features;
    assert.equal(f.length,2);assert.deepEqual(f[0].geometry.coordinates,[85.3,27.7,30.48]);assert.deepEqual(f[1].geometry.coordinates,[85.31,27.71]);
    assert.equal(f[0].properties.identifier,'00123');assert.equal(f[1].properties.identifier,'9007199254740993');assert.equal(f[1].properties.notes,'=not a formula');
    assert.equal(f[0].properties.notes,'first line\nsecond "quoted" line');assert.equal(f[0].properties.site,'Clinic, 田');assert.equal(f[0].properties.height_ft,'100');
    assert.equal(result.report.elevations,1);assert.equal(result.report.missingElevations,1);assert.equal(result.source.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual((await originalDelimitedFile(result.source)).bytes,new Uint8Array(bytes));
    const saved=JSON.stringify({...emptyMapDefinition(),layers:[{layerId:'survey',datasetId:'survey',title:'Survey',sourceType:'geojson-object',geojson:result.geojson,metadata:{source:result.source}}],persistence:{mode:'browser-personal'}});
    const reopened=readBrowserProjectFile(saved).layers[0];assert.deepEqual(reopened.geojson,result.geojson);assert.deepEqual(reopened.metadata.source,result.source);
    reopened.geojson.features[0].geometry.coordinates[0]=0;assert.deepEqual((await originalDelimitedFile(reopened.metadata.source)).bytes,new Uint8Array(bytes));
    const forged=structuredClone(result.source);forged.originalFile.sha256='a'.repeat(64);await assert.rejects(originalDelimitedFile(forged),e=>e.code==='delimited_original_checksum');
  }finally{globalThis.fetch=previous;}
});

it('reads explicit semicolon/tab/pipe separators and Web Mercator, with both foot units and source strings retained',async()=>{
  for(const delimiter of [';','\t','|']){
    const table=inspectDelimitedText(await read(`\ufeffe${delimiter}n${delimiter}z\r\n1113194.9079327357${delimiter}0${delimiter}100\r\n`,'survey.txt'),delimiter);
    const r=mapDelimitedText(table,{xColumn:'e',yColumn:'n',elevationColumn:'z',sourceProjection:'EPSG:3857',elevationUnit:'us-survey-foot'});
    assert(Math.abs(r.geojson.features[0].geometry.coordinates[0]-10)<1e-10);assert(Math.abs(r.geojson.features[0].geometry.coordinates[1])<1e-10);assert(Math.abs(r.geojson.features[0].geometry.coordinates[2]-100*1200/3937)<=Number.EPSILON*(100*1200/3937));
    assert.equal(r.report.mapping.verticalDatum,null);assert.equal(r.geojson.features[0].properties.e,'1113194.9079327357');
  }
});

it('rejects unsupported CRS, malformed quoting/headers/encoding, out-of-range coordinates and bounded input/output',async()=>{
  for(const raw of ['a,b\n"1,2','a,b\n1"2,3','a,b\n"1"oops,2','a,a\n1,2','__proto__,lat\n1,2',' ,lat\n1,2']) await assert.rejects(async()=>inspectDelimitedText(await read(raw)));
  await assert.rejects(read(new Uint8Array([255])));await assert.rejects(read('a'.repeat(262145)));
  const table=inspectDelimitedText(await read());for(const change of [{sourceProjection:''},{sourceProjection:'EPSG:32645'},{xColumn:'north',yColumn:'north'},{elevationUnit:'fathom'},{skipInvalid:'yes'}]) assert.throws(()=>mapDelimitedText(table,{...options,...change}));
  for(const point of ['181,0','0,91',' ,0','Infinity,0','NaN,0','1','1,2,3']){
    const t=inspectDelimitedText(await read(`x,y\n${point}\n`));assert.throws(()=>mapDelimitedText(t,{xColumn:'x',yColumn:'y',sourceProjection:'EPSG:4326'}));
  }
  await assert.rejects(async()=>inspectDelimitedText(await read('x,y\n'+'1,2\n'.repeat(5001))));
  await assert.rejects(async()=>inspectDelimitedText(await read('x,y,n\n1,2,'+'a'.repeat(8193))));
  const tooMany=inspectDelimitedText(await read('x,y\n'+'1,2\n'.repeat(1001)));assert.throws(()=>mapDelimitedText(tooMany,{xColumn:'x',yColumn:'y',sourceProjection:'EPSG:4326',maximumFeatures:1000}),e=>e.code==='delimited_feature_limit');
});

it('scoped account temporary serialization retains source/mapping/labels and never grants authority',async()=>{
  const result=mapDelimitedText(inspectDelimitedText(await read()),{...options,skipInvalid:true});
  const entry=createTemporaryUpload({id:'temporary-csv',fileName:'survey.csv',format:'delimited-text',geojson:result.geojson,byteLength:bytes.length,metadata:{source:result.source},now:1000});entry.layer.labels={enabled:true,field:'site'};
  const saved=serializeTemporaryWork({workspaceId:'account',scopeId:'map',layers:[entry.layer],dataByLayerId:new Map([[entry.layer.layerId,entry.geojson]]),now:1000});
  const r=restoreTemporaryWork(saved,{workspaceId:'account',scopeId:'map',now:2000}).entries[0];assert.deepEqual(r.layer.metadata,entry.layer.metadata);assert.deepEqual(r.layer.labels,entry.layer.labels);assert.equal(r.layer.temporaryWork.authority,'none');
  assert.deepEqual(r.geojson,entry.geojson);assert.equal(restoreTemporaryWork(saved,{workspaceId:'account',scopeId:'other-map',now:2000}).entries.length,0);
});

if(process.env.OPEN_GEO_DELIMITED_PILOT){
  it('measures one maximum-record local pilot including Project-file reopening',async()=>{
    const raw='x,y,id\n'+Array.from({length:5000},(_,i)=>`${i/1000},1,${String(i).padStart(5,'0')}`).join('\n'),start=performance.now();
    const r=mapDelimitedText(inspectDelimitedText(await read(raw)),{xColumn:'x',yColumn:'y',sourceProjection:'EPSG:4326'});
    const file=JSON.stringify({...emptyMapDefinition(),layers:[{layerId:'maximum',title:'Maximum',sourceType:'geojson-object',geojson:r.geojson,metadata:{source:r.source}}],persistence:{mode:'browser-personal'}});
    assert.equal(readBrowserProjectFile(file).layers[0].geojson.features.length,5000);
    const receipt={rows:5000,inputBytes:new TextEncoder().encode(raw).length,outputBytes:new TextEncoder().encode(JSON.stringify(r)).length,projectBytes:new TextEncoder().encode(file).length,milliseconds:performance.now()-start,AWS:0,provider:0};
    await writeFile(new URL('../../.local-archives/renderer-switch-20260930/delimited-import-20261016/pilot.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
  });
}

// The existing sealed-asset peer pattern used by GPX and Esri acceptance.
// This owns one compiled import/storage journey, without a live account/provider.
async function checkDelimitedBrowser(){
  const {chromium}=await import('playwright'),{resolve,dirname,extname}=await import('node:path'),{mkdir,rename}=await import('node:fs/promises');
  const dist=resolve(process.env.OPEN_GEO_DELIMITED_DIST),area=dirname(dirname(dist)),output=resolve(area,'../compiled-browser');await mkdir(output,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(area,'dist/opengeo-studio-build.json'))),files=new Map(manifest.artifactTree.files.map(f=>[f.path,f])),hash=b=>createHash('sha256').update(b).digest('hex');
  const module=name=>'/'+manifest.artifactTree.files.find(f=>f.path.startsWith('_import/'+name+'.')&&f.path.endsWith('.js')).path;
  const entry=await readFile(resolve(dist,'index.html'),'utf8'),styles=[...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
  const html=`<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const receipt={status:'started',limits:{softwareGETs:600,softwareBytes:18874368,seconds:75,personalSaves:1,originalDownloads:1,projectDownloads:1,workingDownloads:1},softwareGETs:0,softwareBytes:0,personalSaves:0,originalDownloads:0,projectDownloads:0,workingDownloads:0,AWS:0,API:0,provider:0,errors:[],themes:[],buildTree:manifest.artifactTree.digest,sourceSHA256:hash(bytes)};
  const priorPath=resolve(output,'attempt-1.json');if((await import('node:fs')).existsSync(priorPath)){const prior=JSON.parse(await readFile(priorPath));assert.equal(prior.buildTree,receipt.buildTree);assert.equal(prior.personalSaves,0);assert.equal(prior.originalDownloads,0);assert.equal(prior.projectDownloads,0);assert.equal(prior.workingDownloads,0);receipt.priorAttempt={softwareGETs:prior.softwareGETs,softwareBytes:prior.softwareBytes,milliseconds:prior.milliseconds,browserClosed:prior.browserClosed};receipt.themes=prior.themes;receipt.limits.softwareGETs-=prior.softwareGETs;receipt.limits.softwareBytes-=prior.softwareBytes;receipt.limits.seconds-=prior.milliseconds/1000;}
  let writes=Promise.resolve();const persist=()=>writes=writes.then(async()=>{await writeFile(resolve(output,'receipt.pending'),JSON.stringify(receipt,null,2)+'\n');await rename(resolve(output,'receipt.pending'),resolve(output,'receipt.json'));});await persist();
  const started=Date.now(),server=await chromium.launchServer({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--enable-unsafe-swiftshader','--opengeo-delimited-acceptance']}),browser=await chromium.connect(server.wsEndpoint());let page,guard;
  const within=()=>assert(Date.now()-started<receipt.limits.seconds*1000,'Local browser time ceiling');
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:true});
    await context.route('**/*',async route=>{try{
      within();const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol))return route.continue();assert.equal(route.request().method(),'GET');
      if(u.hostname==='fonts.googleapis.com'){receipt.optionalFontsAborted=(receipt.optionalFontsAborted??0)+1;return route.abort();}
      if(u.href==='https://tiles.openfreemap.org/styles/positron'){receipt.blankBasemapSubstitutes=(receipt.blankBasemapSubstitutes??0)+1;return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef2f4'}}]})});}
      assert.equal(u.origin,'https://compiled-delimited.test');assert(!u.pathname.startsWith('/api/'));if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      const f=files.get(decodeURIComponent(u.pathname).slice(1));assert(f,'Unexpected software '+u.pathname);assert(++receipt.softwareGETs<=receipt.limits.softwareGETs);receipt.softwareBytes+=f.bytes;assert(receipt.softwareBytes<=receipt.limits.softwareBytes);await persist();
      const body=await readFile(resolve(dist,f.path));assert.equal(hash(body),f.sha256);return route.fulfill({body,contentType:({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.pbf':'application/octet-stream'})[extname(f.path)]??'application/octet-stream'});
    }catch(error){guard??=error;receipt.guardFailure=error.message;await route.abort().catch(()=>{});}});
    const open=async url=>{const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>receipt.errors.push(e.message));await p.goto(url);return p;};
    page=await open('https://compiled-delimited.test/');await page.locator('.start-empty-map').click();await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.isStyleLoaded?.());
    const inspectTheme=async(dialog,mode,step)=>{
      if(receipt.priorAttempt)return; // Reuse accepted exact-build light/dark screenshots and contrast.
      await page.setViewportSize({width:390,height:844});assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      const samples=await dialog.evaluate(root=>{const color=v=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=v;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data];};const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return[root,...['h2','label','select','input','p','th','td','dt','dd','button'].map(s=>root.querySelector(s)).filter(Boolean)].map(n=>{let p=n,bg=color(getComputedStyle(p).backgroundColor);while(bg[3]<255&&p.parentElement){p=p.parentElement;bg=color(getComputedStyle(p).backgroundColor);}const a=lum(color(getComputedStyle(n).color)),b=lum(bg);return{element:n.tagName,foreground:getComputedStyle(n).color,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});});
      receipt.themes.push({mode,step,samples});await persist();assert(samples.every(s=>s.background[3]===255&&s.ratio>=4.5));await page.screenshot({path:resolve(output,`${step}-${mode}-390.png`)});await page.setViewportSize({width:1440,height:1000});
    };
    for(const mode of receipt.priorAttempt?['dark']:['light','dark']){
      const toggle=mode==='light'?'Light':'Dark';if(await page.getByRole('button',{name:toggle,exact:true}).count())await page.getByRole('button',{name:toggle,exact:true}).first().click();
      receipt.stage=`${mode}: real file chooser, coordinate mapping and reviewed omission`;await persist();
      const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Open file',exact:true}).click()]);await chooser.setFiles({name:'coordinate-survey.csv',mimeType:'text/csv',buffer:bytes});
      const mapping=page.locator('.delimited-text-import');await mapping.waitFor();assert.equal(await mapping.getByLabel('Source coordinate system',{exact:true}).inputValue(),'');assert(!/demo/i.test(await mapping.innerText()));
      await mapping.getByLabel('Source coordinate system',{exact:true}).selectOption('EPSG:4326');await mapping.getByLabel('Longitude / easting column',{exact:true}).selectOption('east');await mapping.getByLabel('Latitude / northing column',{exact:true}).selectOption('north');await mapping.getByLabel('Elevation column',{exact:true}).selectOption('height_ft');await mapping.getByLabel('Elevation unit',{exact:true}).selectOption('foot');await mapping.getByLabel('Vertical datum (optional)',{exact:true}).fill(options.verticalDatum);await mapping.getByLabel('Label column',{exact:true}).selectOption('site');
      await mapping.getByRole('button',{name:'Review Layer',exact:true}).click();assert((await mapping.getByRole('status').innerText()).includes('1 of 3'));assert((await mapping.locator('ul').innerText()).includes('Record 4'));assert.equal(await page.evaluate(()=>document.querySelector('.opengeo-workbench').__opengeoLayers.length),0);
      await inspectTheme(mapping,mode,'mapping');await mapping.getByLabel('Omit records that cannot be mapped',{exact:true}).check();await mapping.getByRole('button',{name:'Review Layer',exact:true}).click();
      const review=page.locator('.browser-layer-registration:not(.delimited-text-import)');await review.waitFor();assert((await review.innerText()).includes('2 of 3 mapped · 1 omitted'));await inspectTheme(review,mode,'review');
      if(mode==='light'){await review.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('.opengeo-workbench').__opengeoLayers.length),0);continue;}
      await review.getByLabel('Layer title',{exact:true}).fill('Survey points');await review.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
    }
    await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.length===1&&c.map.areTilesLoaded();});
    const before=await page.evaluate(()=>{const c=document.querySelector('.opengeo-workbench').getPrintContext(),layer=c.layers[0];return{layer,geojson:document.querySelector('.opengeo-workbench').__opengeoData.get(layer.layerId),rendered:c.map.queryRenderedFeatures().filter(f=>f.source===layer.layerId||String(f.layer?.id).startsWith(layer.layerId)).map(f=>f.geometry.type)};});assert(before.rendered.includes('Point'));assert.deepEqual(before.geojson.features.map(f=>f.geometry.coordinates),[[85.3,27.7,30.48],[85.31,27.71]]);assert.equal(before.geojson.features[0].properties.identifier,'00123');assert.equal(before.geojson.features[1].properties.identifier,'9007199254740993');assert.equal(before.layer.labels.enabled,true);assert.equal(before.layer.labels.field,'site');receipt.layerId=before.layer.layerId;receipt.rendered=true;
    receipt.stage='Working export and one actual IndexedDB personal Save';await persist();await page.getByLabel('Layer actions for Survey points',{exact:true}).click();await page.locator('.gis-layer-more[open]').getByRole('button',{name:'Style layer',exact:true}).click();
    let [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download layer',exact:true}).click()]);await download.saveAs(resolve(output,'working.geojson'));receipt.workingDownloads++;const working=JSON.parse(await readFile(resolve(output,'working.geojson')));assert.deepEqual(working.features,before.geojson.features);
    await page.getByRole('button',{name:'Save in browser',exact:true}).click();const title=page.getByRole('dialog',{name:'Save personal Project',exact:true});await title.getByLabel('Personal Project title',{exact:true}).fill('Coordinate field survey');await title.getByRole('button',{name:'Save Project',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.has('localProject'));receipt.personalSaves++;const url=page.url();receipt.localProjectId=new URL(url).searchParams.get('localProject');
    await page.getByRole('button',{name:'Save as',exact:true}).click();const exportDialog=page.getByRole('dialog').filter({has:page.getByLabel('Project export format',{exact:true})});await exportDialog.getByLabel('Project export format',{exact:true}).selectOption('opengeo');[download]=await Promise.all([page.waitForEvent('download'),exportDialog.getByRole('button',{name:'Export file',exact:true}).click()]);await download.saveAs(resolve(output,'project.opengeo-project.json'));receipt.projectDownloads++;
    const saved=readBrowserProjectFile(await readFile(resolve(output,'project.opengeo-project.json'),'utf8'));assert.equal(saved.layers.length,1);assert.deepEqual(saved.layers[0].geojson.features,working.features);assert.equal(saved.layers[0].metadata.source.sha256,hash(bytes));
    receipt.stage='Fresh document reopens actual IndexedDB Project, then original download';await persist();await page.close();page=await open(url);await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.length===1&&c.map.areTilesLoaded();});
    const restored=await page.evaluate(()=>{const c=document.querySelector('.opengeo-workbench').getPrintContext();return{layer:c.layers[0],data:document.querySelector('.opengeo-workbench').__opengeoData.get(c.layers[0].layerId)};});assert.equal(restored.layer.layerId,receipt.layerId);assert.deepEqual(restored.data.features,working.features);assert.deepEqual(restored.layer.metadata,saved.layers[0].metadata);assert.deepEqual(restored.layer.labels,saved.layers[0].labels);receipt.IndexedDBReopen=true;
    await page.getByRole('button',{name:'Catalog',exact:true}).click();await page.locator(`[data-browser-catalog-layer="${restored.layer.datasetId}"]`).getByRole('button').first().click();const review=page.locator('.browser-layer-registration');await review.waitFor();assert((await review.innerText()).includes('Saved on this device'));assert(!/demo/i.test(await review.innerText()));
    [download]=await Promise.all([page.waitForEvent('download'),review.getByRole('button',{name:'Download original delimited file',exact:true}).click()]);await download.saveAs(resolve(output,'reopened-original.csv'));receipt.originalDownloads++;assert.equal(hash(await readFile(resolve(output,'reopened-original.csv'))),hash(bytes));await review.getByRole('button',{name:'Cancel',exact:true}).click();
    assert(!guard,guard?.message);assert.deepEqual(receipt.errors,[]);within();receipt.status='passed-compiled-delimited-mapping-rejection-render-export-IndexedDB-save-fresh-reopen-original-and-themes';
  }catch(error){receipt.status='stopped';receipt.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:resolve(output,'stopped.png')});throw error;}
  finally{await browser.close();await server.close();receipt.browserClosed=true;receipt.milliseconds=Date.now()-started;await persist();}
}

async function checkDelimitedColorsBrowser() {
  const {chromium} = await import('playwright');
  const {resolve, dirname, extname} = await import('node:path');
  const {mkdir, rename} = await import('node:fs/promises');
  const {existsSync} = await import('node:fs');
  const {STYLE_PALETTES} = await import('../src/lib/workbenchConfig.js');
  const dist = resolve(process.env.OPEN_GEO_DELIMITED_COLORS_DIST), area = dirname(dirname(dist));
  const output = resolve(area, '../compiled-browser'), receiptPath = resolve(output, 'receipt.json');
  await mkdir(output, {recursive: true});
  const priorPath = resolve(output, 'attempt-1.json');
  assert(!existsSync(priorPath), 'The single Point-color recovery has already been admitted; no further retry is allowed.');
  let prior = null;
  if (existsSync(receiptPath)) {
    assert.equal(process.env.OPEN_GEO_DELIMITED_COLORS_RECOVERY, 'source-properties-presave', 'Explicit admission is required for the diagnosed pre-save recovery.');
    prior = JSON.parse(await readFile(receiptPath, 'utf8'));
  } else assert(!process.env.OPEN_GEO_DELIMITED_COLORS_RECOVERY, 'Recovery requires the retained first-attempt receipt.');
  const manifest = JSON.parse(await readFile(resolve(area, 'dist/opengeo-studio-build.json')));
  const files = new Map(manifest.artifactTree.files.map(file => [file.path, file]));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const module = name => {
    const file = manifest.artifactTree.files.find(candidate => candidate.path.startsWith('_import/' + name + '.') && candidate.path.endsWith('.js'));
    assert(file, 'Missing compiled module ' + name);return '/' + file.path;
  };
  const entry = await readFile(resolve(dist, 'index.html'), 'utf8');
  const styles = [...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
  const html = `<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const fixture = await readFile(new URL('../../fixtures/gps/colored-points.csv', import.meta.url));
  assert(fixture.length < 1024);assert.equal(fixture.toString('utf8').trimEnd().split('\n').length, 11);
  const water = STYLE_PALETTES.find(([id]) => id === 'water')[2];
  const uniformStyle = {renderer: 'single', circleColor: '#123456', circleRadius: 6, stroke: '#123456', strokeWidth: 2};
  const categoryStyle = {renderer: 'category', circleColor: '#654321', circleRadius: 6, stroke: '#654321', strokeWidth: 2, categoryField: 'risk class', paletteName: 'water', palette: water};
  const categoryColors = [...Array.from({length: 8}, (_, index) => water[index % water.length]), '#654321', '#654321'];
  const origin = 'https://compiled-delimited-colors.test';
  const receipt = {
    status: 'started', limits: {softwareGETs: 450, softwareBytes: 14 * 1024 * 1024, seconds: 60, personalSaves: 1, projectDownloads: 1, originalDownloads: 0, workingDownloads: 0},
    softwareGETs: 0, softwareBytes: 0, personalSaveAttempts: 0, personalSaves: 0, projectDownloadAttempts: 0, projectDownloads: 0, originalDownloads: 0, workingDownloads: 0,
    AWS: 0, API: 0, provider: 0, CI: 0, errors: [], themes: [], renders: [], buildTree: manifest.artifactTree.digest, sourceSHA256: hash(fixture), sourceBytes: fixture.length
  };
  if (prior) {
    assert.equal(prior.status, 'stopped');assert(prior.failure.includes('Expected Point must be rendered at its sampled position'));
    assert.equal(prior.buildTree, receipt.buildTree);assert.equal(prior.sourceSHA256, receipt.sourceSHA256);assert.equal(prior.sourceBytes, receipt.sourceBytes);
    assert.deepEqual(prior.limits, receipt.limits);assert.equal(prior.browserClosed, true);assert.equal(prior.serverClosed, true);assert.deepEqual(prior.errors, []);
    for (const key of ['personalSaveAttempts', 'personalSaves', 'projectDownloadAttempts', 'projectDownloads', 'originalDownloads', 'workingDownloads', 'AWS', 'API', 'provider', 'CI']) assert.equal(prior[key], 0, 'Recovery cannot repeat a prior write/download: ' + key);
    assert(Number.isSafeInteger(prior.softwareGETs) && prior.softwareGETs > 0 && prior.softwareGETs < receipt.limits.softwareGETs);
    assert(Number.isSafeInteger(prior.softwareBytes) && prior.softwareBytes > 0 && prior.softwareBytes < receipt.limits.softwareBytes);
    assert(Number.isFinite(prior.milliseconds) && prior.milliseconds > 0 && prior.milliseconds < receipt.limits.seconds * 1000);
    for (const step of ['mapping', 'review']) {
      assert(prior.themes.some(theme => theme.mode === 'light' && theme.step === step));assert(existsSync(resolve(output, `${step}-light-390.png`)));
    }
    receipt.priorAttempt = {receipt: 'attempt-1.json', softwareGETs: prior.softwareGETs, softwareBytes: prior.softwareBytes, milliseconds: prior.milliseconds, browserClosed: prior.browserClosed, serverClosed: prior.serverClosed, failure: prior.failure};
    receipt.recovery = {attempt: 2, reason: 'Rendered vector-tile hit identity now uses exact source properties, retaining source feature IDs in persistence comparisons.', maximumAttempts: 2, scope: 'No fresh-document replay; reuse accepted CSV/NMEA reopen evidence and verify the new saved IndexedDB row/assets directly.'};
    receipt.softwareGETs = prior.softwareGETs;receipt.softwareBytes = prior.softwareBytes;receipt.themes = prior.themes;
    receipt.reusedScreenshots = ['mapping-light-390.png', 'review-light-390.png'];
    await rename(receiptPath, priorPath);
  }
  const priorMilliseconds = prior?.milliseconds ?? 0;
  let writes = Promise.resolve();
  const persist = () => writes = writes.then(async () => {
    await writeFile(resolve(output, 'receipt.pending'), JSON.stringify(receipt, null, 2) + '\n');
    await rename(resolve(output, 'receipt.pending'), receiptPath);
  });
  await persist();
  const started = Date.now();let server, browser, page, guard, failure;
  const within = () => assert(priorMilliseconds + Date.now() - started < receipt.limits.seconds * 1000, 'Point-color aggregate browser time ceiling');
  const deadline = setTimeout(() => {
    guard ??= Error('Point-color browser time ceiling');receipt.timeLimitReached = true;
    if (browser) void browser.close().catch(() => {});
  }, receipt.limits.seconds * 1000 - priorMilliseconds);
  try {
    server = await chromium.launchServer({headless: true, timeout: 10000, executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--opengeo-delimited-colors-acceptance']});
    receipt.browserPID = server.process().pid;await persist();
    browser = await chromium.connect(server.wsEndpoint(), {timeout: 10000});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'block', acceptDownloads: true});
    await context.route('**/*', async route => {
      try {
        within();const url = new URL(route.request().url());
        if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
        assert.equal(route.request().method(), 'GET');
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
          receipt.optionalFontsAborted = (receipt.optionalFontsAborted ?? 0) + 1;return route.abort();
        }
        if (url.href === 'https://tiles.openfreemap.org/styles/positron') {
          receipt.blankBasemapSubstitutes = (receipt.blankBasemapSubstitutes ?? 0) + 1;
          return route.fulfill({contentType: 'application/json', body: JSON.stringify({version: 8, sources: {}, layers: [{id: 'background', type: 'background', paint: {'background-color': '#eef2f4'}}]})});
        }
        assert.equal(url.origin, origin);assert(!url.pathname.startsWith('/api/'));
        const file = url.pathname === '/' ? null : files.get(decodeURIComponent(url.pathname).slice(1));
        assert(file || url.pathname === '/', 'Unexpected software ' + url.pathname);
        assert(++receipt.softwareGETs <= receipt.limits.softwareGETs, 'Point-color software request ceiling');
        receipt.softwareBytes += file ? file.bytes : Buffer.byteLength(html);
        assert(receipt.softwareBytes <= receipt.limits.softwareBytes, 'Point-color software byte ceiling');await persist();
        if (!file) return route.fulfill({contentType: 'text/html', body: html});
        const body = await readFile(resolve(dist, file.path));assert.equal(hash(body), file.sha256);
        return route.fulfill({body, contentType: ({'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.pbf': 'application/octet-stream'})[extname(file.path)] ?? 'application/octet-stream'});
      } catch (error) {
        guard ??= error;receipt.guardFailure = {url: route.request().url(), message: error.message};await route.abort().catch(() => {});
      }
    });
    const open = async url => {
      within();const current = await context.newPage();current.setDefaultTimeout(10000);
      current.on('pageerror', error => receipt.errors.push(error.message));await current.goto(url);return current;
    };
    const ready = async count => {
      within();await page.waitForFunction(expected => {
        const state = document.querySelector('.opengeo-workbench')?.getPrintContext?.();
        return state?.ready && state.layers.length === expected && state.map?.isStyleLoaded?.() && state.map.areTilesLoaded() && !state.map.isMoving();
      }, count);
    };
    const inspectDialog = async (dialog, mode, step) => {
      if (prior && mode === 'light') return; // Exact-build light controls/review screenshots are already accepted.
      within();await page.setViewportSize({width: 390, height: 844});
      assert(await dialog.evaluate(root => root.scrollWidth <= root.clientWidth + 1));
      if (step === 'mapping') {
        await dialog.getByLabel('Point color', {exact: true}).evaluate(input => input.closest('label').scrollIntoView({block: 'start'}));
        for (const label of ['Point color', 'Color category column', 'Category palette']) {
          const box = await dialog.getByLabel(label, {exact: true}).boundingBox();
          assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 844, label + ' must be visible in the screenshot');
        }
      } else await dialog.locator('dt').filter({hasText: 'Point styling'}).evaluate(node => node.scrollIntoView({block: 'center'}));
      const samples = await dialog.evaluate((root, kind) => {
        const rgba = value => {const canvas = document.createElement('canvas');canvas.width = canvas.height = 1;const context = canvas.getContext('2d');context.fillStyle = value;context.fillRect(0, 0, 1, 1);return [...context.getImageData(0, 0, 1, 1).data];};
        const luminance = color => color.slice(0, 3).map(value => {value /= 255;return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const nodes = kind === 'mapping'
          ? ['Point color', 'Color category column', 'Category palette'].flatMap(label => {const input = root.querySelector(`[aria-label="${label}"]`);return [input.closest('label'), ...(input.type === 'color' ? [] : [input])];})
          : [root, ...[...root.querySelectorAll('dt')].filter(node => node.textContent === 'Point styling').flatMap(node => [node, node.nextElementSibling])];
        return nodes.map(node => {
          let parent = node, background = rgba(getComputedStyle(parent).backgroundColor);
          while (background[3] < 255 && parent.parentElement) {parent = parent.parentElement;background = rgba(getComputedStyle(parent).backgroundColor);}
          const foreground = getComputedStyle(node).color, a = luminance(rgba(foreground)), b = luminance(background), box = node.getBoundingClientRect();
          return {element: node.tagName, label: node.getAttribute('aria-label') ?? node.textContent, disabled: Boolean(node.disabled), foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), box: {x: box.x, y: box.y, width: box.width, height: box.height}};
        });
      }, step);
      receipt.themes.push({mode, step, samples});await persist();
      assert(samples.every(sample => sample.background[3] === 255 && (sample.disabled || sample.ratio >= 4.5)), 'Point-color control/review contrast');
      await page.screenshot({path: resolve(output, `${step}-${mode}-390.png`)});await page.setViewportSize({width: 1440, height: 1000});
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.opengeo-workbench')?.getPrintContext?.()?.map?.getCanvas?.();
        return canvas?.clientWidth > 0 && Math.abs(canvas.width - Math.round(canvas.clientWidth * devicePixelRatio)) <= 2 && Math.abs(canvas.height - Math.round(canvas.clientHeight * devicePixelRatio)) <= 2;
      });
    };
    const pixels = async (title, expectedColors, phase) => {
      within();await ready(title === 'Uniform points' ? 1 : 2);
      await page.waitForFunction(name => {
        const state = document.querySelector('.opengeo-workbench')?.getPrintContext?.(), layer = state?.layers.find(candidate => candidate.title === name);
        return layer && state.map.queryRenderedFeatures().some(feature => feature.geometry.type === 'Point' && String(feature.layer.id).startsWith(layer.layerId));
      }, title);
      const rendering = await page.evaluate(name => new Promise((resolve, reject) => {
        const shell = document.querySelector('.opengeo-workbench'), state = shell.getPrintContext(), map = state.map;
        const layer = state.layers.find(candidate => candidate.title === name), data = shell.__opengeoData.get(layer.layerId);
        const paintLayer = map.getStyle().layers.find(candidate => candidate.id === layer.layerId + '-points');
        if (!paintLayer) return reject(Error('Point paint layer is missing.'));
        const timeout = setTimeout(() => reject(Error('No render callback for Point-color samples.')), 5000);
        map.once('render', () => {
          clearTimeout(timeout);
          try {
            const canvas = map.getCanvas(), copy = document.createElement('canvas');copy.width = canvas.width;copy.height = canvas.height;
            const context = copy.getContext('2d', {willReadFrequently: true});context.drawImage(canvas, 0, 0);
            const scaleX = canvas.width / canvas.clientWidth, scaleY = canvas.height / canvas.clientHeight;
            const pixel = (x, y) => [...context.getImageData(Math.round(x * scaleX), Math.round(y * scaleY), 1, 1).data];
            const samples = data.features.map(feature => {
              const point = map.project(feature.geometry.coordinates);
              if (!(point.x >= 16 && point.y >= 16 && point.x + 16 < canvas.clientWidth && point.y + 16 < canvas.clientHeight)) throw Error('Sample Point is outside the padded map viewport.');
              const hits = map.queryRenderedFeatures([point.x, point.y], {layers: [paintLayer.id]});
              const renderedAtCenter = hits.some(candidate => candidate.properties.identifier === feature.properties.identifier && Object.entries(feature.properties).every(([key, value]) => candidate.properties[key] === value));
              return {id: feature.id, identifier: feature.properties.identifier, category: feature.properties['risk class'], status: feature.properties.status, coordinate: feature.geometry.coordinates, screen: {x: point.x, y: point.y}, rgba: pixel(point.x, point.y), background: pixel(point.x + 14, point.y), renderedAtCenter, queriedSourceProperties: hits.map(candidate => candidate.properties)};
            });
            resolve({layerId: layer.layerId, paintLayerId: paintLayer.id, color: map.getPaintProperty(paintLayer.id, 'circle-color'), opacity: map.getPaintProperty(paintLayer.id, 'circle-opacity'), radius: map.getPaintProperty(paintLayer.id, 'circle-radius'), renderedTypes: [...new Set(map.queryRenderedFeatures({layers: [paintLayer.id]}).map(feature => feature.geometry.type))], samples});
          } catch (error) {reject(error);}
        });
        map.triggerRepaint();
      }), title);
      receipt.renders.push({phase, title, ...rendering});await persist();
      assert.deepEqual(rendering.renderedTypes, ['Point']);assert.equal(rendering.radius, 6);assert.equal(rendering.opacity, .9);assert.equal(rendering.samples.length, 10);
      if (title === 'Uniform points') assert.equal(rendering.color, '#123456');
      else assert.deepEqual(rendering.color, ['match', ['to-string', ['get', 'risk class']], ...'ABCDEFGH'.split('').flatMap((value, index) => [value, water[index % water.length]]), '#654321']);
      for (const [index, sample] of rendering.samples.entries()) {
        assert(sample.renderedAtCenter, 'Expected Point must be rendered at its sampled position');assert.equal(sample.rgba[3], 255);assert.equal(sample.background[3], 255);
        const expected = expectedColors[index].match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16));
        sample.expectedComposite = expected.map((value, channel) => Math.round(value * rendering.opacity + sample.background[channel] * (1 - rendering.opacity)));
        sample.maximumChannelError = Math.max(...sample.expectedComposite.map((value, channel) => Math.abs(value - sample.rgba[channel])));
        assert(sample.maximumChannelError <= 4, `${title} ${sample.category || 'empty'} rendered RGB must match its selected color`);
      }
      await persist();
    };
    page = await open(origin + '/');await page.locator('.start-empty-map').click();await ready(0);
    for (const category of [false, true]) {
      within();const mode = category ? 'dark' : 'light', title = category ? 'Category points' : 'Uniform points';
      const toggle = mode === 'light' ? 'Light' : 'Dark';
      if (await page.getByRole('button', {name: toggle, exact: true}).count()) await page.getByRole('button', {name: toggle, exact: true}).first().click();
      receipt.stage = title + ': normal file chooser and explicit Point-color mapping';await persist();
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', {name: 'Open file', exact: true}).click()]);
      await chooser.setFiles({name: 'colored-points.csv', mimeType: 'text/csv', buffer: fixture});
      const mapping = page.locator('.delimited-text-import');await mapping.waitFor();
      assert.equal(await mapping.getByLabel('Color category column', {exact: true}).inputValue(), '');
      assert(await mapping.getByLabel('Category palette', {exact: true}).isDisabled());
      await mapping.getByLabel('Source coordinate system', {exact: true}).selectOption('EPSG:4326');
      await mapping.getByLabel('Label column', {exact: true}).selectOption('site');
      await mapping.getByLabel('Point color', {exact: true}).fill(category ? '#654321' : '#123456');
      if (category) {
        await mapping.getByLabel('Color category column', {exact: true}).selectOption('risk class');
        await mapping.getByLabel('Category palette', {exact: true}).selectOption('water');
        assert((await mapping.innerText()).includes('eight most frequent nonempty values'));
      }
      await inspectDialog(mapping, mode, 'mapping');await mapping.getByRole('button', {name: 'Review Layer', exact: true}).click();
      const review = page.locator('.browser-layer-registration:not(.delimited-text-import)');await review.waitFor();
      assert((await review.innerText()).includes(category ? 'water palette' : 'One color: #123456'));
      await inspectDialog(review, mode, 'review');await review.getByLabel('Layer title', {exact: true}).fill(title);
      await review.getByRole('button', {name: 'Add Layer to Project', exact: true}).click();await ready(category ? 2 : 1);
      if (category) await page.getByLabel('Show Uniform points', {exact: true}).uncheck();
      await pixels(title, category ? categoryColors : Array(10).fill('#123456'), 'before-save');
    }
    const before = await page.evaluate(() => {
      const shell = document.querySelector('.opengeo-workbench'), state = shell.getPrintContext();
      return state.layers.map(layer => ({layer, geojson: shell.__opengeoData.get(layer.layerId)}));
    });
    assert.equal(before.length, 2);assert.notEqual(before[0].layer.layerId, before[1].layer.layerId);
    for (const retained of before) {
      const category = retained.layer.title === 'Category points';assert.deepEqual(retained.layer.style, category ? categoryStyle : uniformStyle);
      assert.deepEqual(retained.layer.metadata.curated.pointPresentation, {mode: category ? 'category' : 'single', color: category ? '#654321' : '#123456', categoryField: category ? 'risk class' : null, paletteName: category ? 'water' : null});
      assert.equal(retained.layer.labels.enabled, true);assert.equal(retained.layer.labels.field, 'site');assert.equal(retained.geojson.features.length, 10);
      assert.equal(retained.geojson.features[0].properties.identifier, '0001');assert.equal(retained.geojson.features[9].properties['risk class'], '');
      assert.equal(retained.layer.metadata.source.sha256, hash(fixture));assert.deepEqual(Buffer.from(retained.layer.metadata.source.originalFile.content, 'base64'), fixture);
    }
    assert.deepEqual(before[0].layer.metadata.source, before[1].layer.metadata.source);
    const categoryLayer = before.find(retained => retained.layer.title === 'Category points').layer;
    await page.getByLabel('Layer actions for Category points', {exact: true}).click();
    const categoryRow = page.locator(`.gis-layer-row[data-layer-id="${categoryLayer.layerId}"]`), legend = categoryRow.locator('.gis-layer-tree-legend');
    await legend.locator('summary').click();assert(await legend.locator('.gis-style-legend').isVisible());
    receipt.legend = await legend.locator('.gis-style-legend > span').evaluateAll(rows => rows.map(row => ({value: row.querySelector('span').textContent, color: row.querySelector('i').style.backgroundColor})));
    assert.deepEqual(receipt.legend.map(row => row.value), ['A', 'B', 'C', 'D', 'E']);await persist();
    await page.getByLabel('Layer actions for Category points', {exact: true}).click();
    receipt.stage = 'One personal IndexedDB save retaining both Layers';receipt.personalSaveAttempts++;await persist();
    await page.getByRole('button', {name: 'Save in browser', exact: true}).click();
    const save = page.getByRole('dialog', {name: 'Save personal Project', exact: true});
    await save.getByLabel('Personal Project title', {exact: true}).fill('Point colors');await save.getByRole('button', {name: 'Save Project', exact: true}).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has('localProject'));receipt.personalSaves++;
    const url = page.url();receipt.localProjectId = new URL(url).searchParams.get('localProject');await persist();
    receipt.stage = 'Direct read-only IndexedDB row and exact saved asset readback';await persist();
    const persisted = await page.evaluate(id => new Promise((resolve, reject) => {
      const opening = indexedDB.open('opengeo-personal-projects-v1', 1);
      opening.onupgradeneeded = () => {opening.transaction.abort();reject(Error('The personal Project database was not saved.'));};
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result, transaction = database.transaction(['projects', 'assets'], 'readonly');
        const record = transaction.objectStore('projects').get(id), assets = transaction.objectStore('assets').getAll();
        transaction.onabort = transaction.onerror = () => {database.close();reject(transaction.error ?? Error('Saved Project readback failed.'));};
        transaction.oncomplete = async () => {
          database.close();
          try {
            if (!record.result) throw Error('Saved personal Project row is missing.');
            const required = new Set(record.result.references.map(reference => reference.checksum));
            const retained = [];
            for (const asset of assets.result.filter(candidate => required.has(candidate.checksum))) {
              const bytes = new Uint8Array(await asset.blob.arrayBuffer());
              const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
              retained.push({checksum: asset.checksum, actualChecksum: checksum, bytes: asset.bytes, actualBytes: bytes.length, geojson: JSON.parse(new TextDecoder().decode(bytes))});
            }
            resolve({record: record.result, assets: retained});
          } catch (error) {reject(error);}
        };
      };
    }), receipt.localProjectId);
    assert.equal(persisted.record.id, receipt.localProjectId);assert.equal(persisted.record.revision, 1);assert.equal(persisted.record.definition.layers.length, 2);
    for (const retained of before) {
      const layer = persisted.record.definition.layers.find(candidate => candidate.layerId === retained.layer.layerId);assert(layer);
      assert.equal(layer.datasetId, retained.layer.datasetId);assert.deepEqual(layer.style, retained.layer.style);assert.deepEqual(layer.metadata, retained.layer.metadata);assert.deepEqual(layer.labels, retained.layer.labels);
      const reference = persisted.record.references.find(candidate => candidate.layerId === layer.layerId), asset = persisted.assets.find(candidate => candidate.checksum === reference?.checksum);assert(asset);
      assert.equal(asset.actualChecksum, asset.checksum);assert.equal(asset.actualBytes, asset.bytes);assert.deepEqual(asset.geojson, retained.geojson);
    }
    receipt.IndexedDBReadback = {id: persisted.record.id, revision: persisted.record.revision, layers: persisted.record.definition.layers.length, assets: persisted.assets.length};await persist();
    await page.getByRole('button', {name: 'Save as', exact: true}).click();
    const exportDialog = page.getByRole('dialog').filter({has: page.getByLabel('Project export format', {exact: true})});
    await exportDialog.getByLabel('Project export format', {exact: true}).selectOption('opengeo');
    receipt.stage = 'One browser Project export';receipt.projectDownloadAttempts++;await persist();
    const [download] = await Promise.all([page.waitForEvent('download'), exportDialog.getByRole('button', {name: 'Export file', exact: true}).click()]);
    await download.saveAs(resolve(output, 'point-colors.opengeo-project.json'));receipt.projectDownloads++;
    const saved = readBrowserProjectFile(await readFile(resolve(output, 'point-colors.opengeo-project.json'), 'utf8'));assert.equal(saved.layers.length, 2);
    for (const retained of before) {
      const layer = saved.layers.find(candidate => candidate.layerId === retained.layer.layerId);assert(layer);
      assert.equal(layer.datasetId, retained.layer.datasetId);assert.deepEqual(layer.style, retained.layer.style);assert.deepEqual(layer.metadata, retained.layer.metadata);assert.deepEqual(layer.labels, retained.layer.labels);assert.deepEqual(layer.geojson, retained.geojson);
    }
    receipt.layerIds = before.map(retained => retained.layer.layerId);receipt.freshDocumentReopen = {performed: false, reusedEvidence: ['../../delimited-import-20261016/compiled-browser/receipt.json', '../../nmea-import-20261016/compiled-browser/receipt.json'], reason: 'Persistence implementation is unchanged; new style/source state is checked by exact saved IndexedDB row/assets and Project export.'};
    assert(!guard, guard?.message);assert.deepEqual(receipt.errors, []);within();receipt.status = 'passed-compiled-Point-colors-render-pixels-category-cycle-fallback-Project-IndexedDB-readback-and-themes';
  } catch (error) {
    failure = error;receipt.status = 'stopped';receipt.failure = error.stack ?? error.message;
    if (page && !page.isClosed()) await page.screenshot({path: resolve(output, prior ? 'stopped-attempt-2.png' : 'stopped.png'), timeout: 2000}).catch(screenshotError => {receipt.screenshotFailure = screenshotError.message;});
  } finally {
    clearTimeout(deadline);
    try {await browser?.close();receipt.browserClosed = true;} catch (error) {failure ??= error;receipt.browserCloseFailure = error.message;}
    try {await server?.close();receipt.serverClosed = true;} catch (error) {failure ??= error;receipt.serverCloseFailure = error.message;}
    receipt.attemptMilliseconds = Date.now() - started;receipt.milliseconds = priorMilliseconds + receipt.attemptMilliseconds;
    receipt.attemptSoftwareGETs = receipt.softwareGETs - (prior?.softwareGETs ?? 0);receipt.attemptSoftwareBytes = receipt.softwareBytes - (prior?.softwareBytes ?? 0);
    if (failure && receipt.status.startsWith('passed-')) receipt.status = 'stopped-cleanup';await persist();
  }
  if (failure) throw failure;
}
