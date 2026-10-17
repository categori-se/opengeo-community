import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {NMEA_IMPORT_LIMITS, readNmeaFile, originalNmeaFile} from '../src/lib/nmeaImport.js';
import {readBrowserProjectFile} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';
import {createTemporaryUpload, serializeTemporaryWork, restoreTemporaryWork} from '../src/lib/temporaryAnnotations.js';

const bytes = await readFile(new URL('../../fixtures/gps/source-observations.nmea', import.meta.url));
const input = (value = bytes, name = 'source-observations.nmea') => new File([value], name, {type: 'text/plain'});
const sentence = body => '$' + body + '*' + [...body].reduce((sum, character) => sum ^ character.charCodeAt(0), 0).toString(16).padStart(2, '0').toUpperCase();
const rmc = (changes = {}) => {
  const fields = 'GPRMC,010203.123400,A,2742.0000,N,08518.0000,E,001.50,090.0,161026,,,A'.split(',');
  for (const [index, value] of Object.entries(changes)) fields[index] = value;
  return sentence(fields.join(','));
};
const project = result => JSON.stringify({...emptyMapDefinition(), layers: [{
  layerId: 'observations', datasetId: 'observations', title: 'Observation source',
  sourceType: 'geojson-object', geojson: result.geojson, metadata: {source: result.source}
}], persistence: {mode: 'browser-personal'}});

if (process.env.OPEN_GEO_NMEA_DIST) {await checkNmeaBrowser();process.exit(0);}


it('keeps mixed RMC/GGA observations separate, with exact fields, hemispheres, invalid fixes and unsupported records', async () => {
  const previous = globalThis.fetch;globalThis.fetch = () => {throw Error('NMEA import must never fetch a resource');};
  try {
    const result = await readNmeaFile(input()), features = result.geojson.features;
    assert.deepEqual(result.report.counts, {records: 10, rmc: 6, gga: 2, positions: 3, elevations: 1, timestamps: 3});
    assert.deepEqual(features.map(feature => feature.geometry), [
      {type: 'Point', coordinates: [85.3, 27.7]}, {type: 'Point', coordinates: [85.3, 27.7]},
      {type: 'Point', coordinates: [-151.21, -33.86]}
    ]);
    assert.equal(new Set(features.map(feature => feature.id)).size, 3);
    assert.deepEqual(features.map(feature => feature.properties.nmea.talker), ['GP', 'GN', 'GL']);
    assert.equal(features[0].properties.nmea.time, '010203.123400');
    assert.equal(features[0].properties.nmea.date, '161026');
    assert.equal(features[0].properties.nmea.speedKnots, '001.50');
    assert.equal(features[0].properties.nmea.fields[0], 'GPRMC');
    assert.equal(features[0].properties.nmea.sentence, bytes.toString('ascii').split('\n')[1]);
    assert.equal(features[1].properties.nmea.altitudeMsl, '1450.25');
    assert.equal(features[1].properties.nmea.geoidSeparation, '-30.5');
    assert.equal(features[1].properties.nmea.altitudeUnit, 'M');
    assert.equal(features[2].properties.nmea.speedKnots, null);
    assert.equal(features[2].properties.nmea.courseDegrees, null);
    assert.deepEqual(result.report.rejectedRecords.map(record => record.code), ['invalid-fix', 'invalid-fix', 'checksum-invalid', 'unsupported-mode', 'checksum-missing']);
    assert.deepEqual(result.report.rejectedRecords.map(record => record.record), [5, 6, 7, 9, 10]);
    assert(result.report.rejectedRecords.every(record => record.originalPreserved));
    assert.deepEqual(result.report.preservedRecords.map(record => record.record), [1, 8]);
    assert.equal(result.report.datumDeclarations[0].datum, 'WGS 84');
    assert.equal(result.report.coordinateReferencePolicy, 'user-confirmation-required');
    assert.equal(result.source.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual((await originalNmeaFile(result.source)).bytes, new Uint8Array(bytes));
  } finally {globalThis.fetch = previous;}
});

it('enforces input/output/record/field bounds, late datum conflicts and malformed coordinate/fix semantics', async () => {
  for (const [value, code] of [
    ['', 'nmea_input_limit'], ['x'.repeat(NMEA_IMPORT_LIMITS.inputBytes + 1), 'nmea_input_limit'],
    ['\u00e9', 'nmea_encoding'], [new Uint8Array([255]), 'nmea_encoding'],
    ['x'.repeat(257), 'nmea_line_limit'], ['x\n'.repeat(2001), 'nmea_record_limit'],
    [sentence('GPTXT,' + Array(32).fill('').join(',')), 'nmea_field_limit'],
    [rmc() + '\n' + sentence('PGRMM,NAD83'), 'nmea_datum_conflict'],
    [rmc() + '\n$PGRMM,NAD83', 'nmea_datum_conflict'],
    [rmc() + '\n' + sentence('GPDTM,W84,,0,N,0,E,0,W84'), 'nmea_datum_unsupported'],
    [rmc() + '\n' + sentence('PGRMC,1,100,101,0'), 'nmea_datum_unsupported'],
    [sentence('GPGSA,A,3'), 'nmea_no_positions']
  ]) await assert.rejects(readNmeaFile(input(value)), error => error.code === code && error.report.operation === 'reject');
  for (const changes of [
    {3: ''}, {3: '2760.0000'}, {3: '9100.0000'}, {3: '9000.0001'}, {4: 'X'},
    {5: '18100.0000'}, {5: '18000.0001'}, {5: '8.5e1'}, {6: ''},
    {2: 'V'}, {12: 'N'}, {12: 'V'}, {12: 'R'}, {12: 'E'}, {13: 'V'},
    {1: '250000'}, {9: '003026'}, {7: 'NaN'}
  ]) await assert.rejects(readNmeaFile(input(rmc(changes))), error => error.code === 'nmea_no_positions' && error.report.rejectedRecords.length === 1);
  const navigation = await readNmeaFile(input(rmc() + '\n' + rmc({13: 'V'})));
  assert.equal(navigation.report.rejectedRecords[0].code, 'unsupported-navigation-status');
  const poles = await readNmeaFile(input(rmc({3: '9000.0000', 5: '18000.0000'})));
  assert.deepEqual(poles.geojson.features[0].geometry.coordinates, [180, 90]);
  const absent = await readNmeaFile(input(rmc({1: '', 7: '', 8: '', 9: '', 12: ''})));
  assert.equal(absent.geojson.features[0].properties.nmea.time, null);
  assert.equal(absent.geojson.features[0].properties.nmea.date, null);
  for (const quality of ['1', '2', '4', '5']) {
    const parsed = await readNmeaFile(input(sentence('GPGGA,,2742,N,08518,E,' + quality + ',08,0.9,,M,,M,,')));
    assert.equal(parsed.geojson.features[0].properties.nmea.altitudeMsl, null);
    assert.equal(parsed.geojson.features[0].geometry.coordinates.length, 2);
  }
  const oversizedReport = rmc() + '\n' + (sentence('GPTXT,' + 'x'.repeat(70)) + '\n').repeat(1999);
  assert(Buffer.byteLength(oversizedReport) < NMEA_IMPORT_LIMITS.inputBytes);
  await assert.rejects(readNmeaFile(input(oversizedReport)), error => error.code === 'nmea_output_limit');
});

it('browser Project-file reopening and working edits retain exact BOM/CRLF original bytes and reject tampering', async () => {
  const raw = '\ufeff' + bytes.toString('ascii').replace(/\n/g, '\r\n'), file = input(raw, 'observations.nmea');
  const result = await readNmeaFile(file), before = new Uint8Array(await file.arrayBuffer());
  const reopened = readBrowserProjectFile(project(result)).layers[0];
  assert.deepEqual(reopened.geojson, result.geojson);assert.deepEqual(reopened.metadata.source, result.source);
  reopened.geojson.features[0].geometry.coordinates[0] = 0;
  reopened.geojson.features[0].properties.nmea.time = 'edited working value';
  assert.deepEqual((await originalNmeaFile(reopened.metadata.source)).bytes, before);
  assert.equal(result.geojson.features[0].properties.nmea.time, '010203.123400');
  const tampered = structuredClone(result.source);tampered.originalFile.content = tampered.originalFile.content.slice(4);
  await assert.rejects(originalNmeaFile(tampered), error => error.code === 'nmea_original_checksum');
  const forged = structuredClone(result.source);forged.originalFile.sha256 = 'a'.repeat(64);
  await assert.rejects(originalNmeaFile(forged), error => error.code === 'nmea_original_checksum');
  const modified = structuredClone(result.source), content = Buffer.from(modified.originalFile.content, 'base64');content[10] ^= 1;
  modified.originalFile.content = content.toString('base64');
  await assert.rejects(originalNmeaFile(modified), error => error.code === 'nmea_original_checksum');
});

it('scoped temporary account serialization retains exact source metadata without granting authority', async () => {
  const result = await readNmeaFile(input()), metadata = {source: result.source, curated: {sourceProjection: 'EPSG:4326', coordinateReferenceMethod: 'user-confirmed'}};
  const entry = createTemporaryUpload({id: 'temporary-nmea', fileName: 'observations.nmea', format: 'nmea', geojson: result.geojson, byteLength: bytes.length, metadata, now: 1000});
  const saved = serializeTemporaryWork({workspaceId: 'account', scopeId: 'map', layers: [entry.layer], dataByLayerId: new Map([[entry.layer.layerId, entry.geojson]]), now: 1000});
  const restored = restoreTemporaryWork(saved, {workspaceId: 'account', scopeId: 'map', now: 2000}).entries[0];
  assert.deepEqual(restored.layer.metadata, metadata);assert.deepEqual(restored.geojson, result.geojson);
  assert.equal(restored.layer.temporaryWork.authority, 'none');
  assert.deepEqual((await originalNmeaFile(restored.layer.metadata.source)).bytes, new Uint8Array(bytes));
  assert.equal(restoreTemporaryWork(saved, {workspaceId: 'account', scopeId: 'other-map', now: 2000}).entries.length, 0);
});

if (process.env.OPEN_GEO_NMEA_PILOT === '1') it('one maximum-observation pilot includes browser Project-file reopening', async () => {
  const target = new URL('../../.local-archives/renderer-switch-20260930/nmea-import-20261016/pilot.json', import.meta.url);
  assert(!existsSync(target), 'Reuse the retained maximum-observation pilot');
  const raw = Array.from({length: 1000}, (_, index) => rmc({7: String(index)})).join('\n');
  const started = performance.now(), result = await readNmeaFile(input(raw)), saved = project(result);
  const reopened = readBrowserProjectFile(saved);
  assert.equal(reopened.layers[0].geojson.features.length, 1000);
  assert.deepEqual((await originalNmeaFile(reopened.layers[0].metadata.source)).bytes, new TextEncoder().encode(raw));
  await writeFile(target, JSON.stringify({observations: 1000, inputBytes: Buffer.byteLength(raw), outputBytes: Buffer.byteLength(JSON.stringify(result)), projectBytes: Buffer.byteLength(saved), milliseconds: performance.now() - started, AWS: 0, API: 0, provider: 0}, null, 2) + '\n');
});

// Reuse the existing exact-asset peer pattern; no external API/provider or account.
async function checkNmeaBrowser() {
  const {chromium} = await import('playwright');
  const {resolve, dirname, extname} = await import('node:path');
  const {mkdir, rename} = await import('node:fs/promises');
  const dist = resolve(process.env.OPEN_GEO_NMEA_DIST), area = dirname(dirname(dist)), output = resolve(area, '../compiled-browser');
  await mkdir(output, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(area, 'dist/opengeo-studio-build.json')));
  const files = new Map(manifest.artifactTree.files.map(f => [f.path, f]));
  const hash = b => createHash('sha256').update(b).digest('hex');
  const module = name => '/' + manifest.artifactTree.files.find(f => f.path.startsWith('_import/' + name + '.') && f.path.endsWith('.js')).path;
  const entry = await readFile(resolve(dist, 'index.html'), 'utf8');
  const styles = [...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
  const html = `<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const original = await readFile(new URL('../../fixtures/gps/source-observations.nmea', import.meta.url));
  const receipt = {status:'started', limits:{GETs:450,bytes:14680064,seconds:60,personalSaves:1,originalDownloads:1,projectDownloads:1,workingDownloads:1}, GETs:0,bytes:0,personalSaves:0,originalDownloads:0,projectDownloads:0,workingDownloads:0,AWS:0,API:0,provider:0,errors:[],themes:[],buildTree:manifest.artifactTree.digest};
  let writes = Promise.resolve();
  const persist = () => writes = writes.then(async () => {await writeFile(resolve(output,'receipt.pending'),JSON.stringify(receipt,null,2)+'\n');await rename(resolve(output,'receipt.pending'),resolve(output,'receipt.json'));});
  await persist();
  const started = Date.now(), server = await chromium.launchServer({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--enable-unsafe-swiftshader','--opengeo-nmea-acceptance']}), browser = await chromium.connect(server.wsEndpoint());
  let page, guard;
  const within = () => assert(Date.now()-started < receipt.limits.seconds*1000, 'Local browser time ceiling');
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:true});
    await context.route('**/*', async route => {try {
      within();const u = new URL(route.request().url());if(['data:','blob:'].includes(u.protocol))return route.continue();
      assert.equal(route.request().method(),'GET');
      if(u.hostname==='fonts.googleapis.com'){receipt.optionalFontsAborted=(receipt.optionalFontsAborted??0)+1;return route.abort();}
      if(u.href==='https://tiles.openfreemap.org/styles/positron'){receipt.blankBasemapSubstitutes=(receipt.blankBasemapSubstitutes??0)+1;return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef2f4'}}]})});}
      assert.equal(u.origin,'https://compiled-nmea.test');assert(!u.pathname.startsWith('/api/'));
      if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      const f=files.get(decodeURIComponent(u.pathname).slice(1));assert(f,'Unexpected software '+u.pathname);
      assert(++receipt.GETs<=receipt.limits.GETs);receipt.bytes+=f.bytes;assert(receipt.bytes<=receipt.limits.bytes);await persist();
      const body=await readFile(resolve(dist,f.path));assert.equal(hash(body),f.sha256);
      return route.fulfill({body,contentType:({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.pbf':'application/octet-stream'})[extname(f.path)]??'application/octet-stream'});
    }catch(error){guard??=error;receipt.guardFailure=error.message;await route.abort().catch(()=>{});}});
    const open=async url=>{const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>receipt.errors.push(e.message));await p.goto(url);return p;};
    const inspect=async(dialog,mode)=>{
      await page.setViewportSize({width:390,height:844});
      const samples=await dialog.evaluate(root=>{
        const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number),lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0), bg=rgb(getComputedStyle(root).backgroundColor);
        return [root,...root.querySelectorAll('h2,label,button')].map(e=>{const c=getComputedStyle(e),fg=rgb(c.color),a=lum(fg),b=lum(bg);return{element:e.tagName,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
      });
      assert(samples.every(s=>s.ratio>=4.5));assert(await dialog.evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth));
      for(const input of await dialog.locator('input[type="checkbox"]').all())assert(await input.evaluate(el=>el.getBoundingClientRect().width<32));
      receipt.themes.push({mode,samples});await page.screenshot({path:resolve(output,`nmea-review-${mode}-390.png`)});await page.setViewportSize({width:1440,height:1000});
    };
    receipt.stage='Normal file chooser and explicit source review';await persist();
    page=await open('https://compiled-nmea.test/');await page.locator('.start-empty-map').click();
    await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.__opengeoMap?.isStyleLoaded?.());
    if(await page.getByRole('button',{name:'Light',exact:true}).count())await page.getByRole('button',{name:'Light',exact:true}).first().click();
    const [choice]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Open file',exact:true}).click()]);
    await choice.setFiles({name:'source-observations.nmea',mimeType:'text/plain',buffer:original});
    let review=page.locator('.browser-layer-registration');await review.waitFor();
    assert((await review.innerText()).includes('3 mapped observations'));assert((await review.innerText()).includes('5 rejected'));
    await review.getByRole('button',{name:'Add Layer to Project',exact:true}).click();assert.equal(await page.evaluate(()=>document.querySelector('.opengeo-workbench').__opengeoLayers.length),0);
    await inspect(review,'light');await review.getByLabel('Layer title',{exact:true}).fill('GPS observations');
    await review.getByLabel('These positions use WGS 84 longitude/latitude.',{exact:true}).check();
    await review.getByLabel('Add the valid observations and retain rejected records in the original file.',{exact:true}).check();
    await review.getByRole('button',{name:'Add Layer to Project',exact:true}).click();
    await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.length===1&&c.map.areTilesLoaded();});
    const before=await page.evaluate(()=>{const s=document.querySelector('.opengeo-workbench'),c=s.getPrintContext(),layer=c.layers[0];return{layer,data:s.__opengeoData.get(layer.layerId),rendered:c.map.queryRenderedFeatures().filter(f=>f.source===layer.layerId||String(f.layer?.id).startsWith(layer.layerId)).map(f=>f.geometry.type)};});
    assert(before.rendered.includes('Point'));assert.deepEqual(before.data.features.map(f=>f.geometry.coordinates),[[85.3,27.7],[85.3,27.7],[-151.21,-33.86]]);
    assert.equal(before.layer.metadata.source.sha256,hash(original));assert.equal(before.layer.metadata.curated.coordinateReferenceMethod,'user-confirmed');receipt.layerId=before.layer.layerId;receipt.rendered=true;
    receipt.stage='Working export and one IndexedDB personal Save';await persist();
    await page.getByLabel('Layer actions for GPS observations',{exact:true}).click();await page.locator('.gis-layer-more[open]').getByRole('button',{name:'Style layer',exact:true}).click();
    let [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download layer',exact:true}).click()]);await download.saveAs(resolve(output,'working.geojson'));receipt.workingDownloads++;
    const working=JSON.parse(await readFile(resolve(output,'working.geojson')));assert.deepEqual(working.features,before.data.features);
    await page.getByRole('button',{name:'Save in browser',exact:true}).click();const save=page.getByRole('dialog',{name:'Save personal Project',exact:true});
    await save.getByLabel('Personal Project title',{exact:true}).fill('NMEA field observations');await save.getByRole('button',{name:'Save Project',exact:true}).click();await page.waitForFunction(()=>new URL(location.href).searchParams.has('localProject'));receipt.personalSaves++;const url=page.url();receipt.localProjectId=new URL(url).searchParams.get('localProject');
    await page.getByRole('button',{name:'Save as',exact:true}).click();const exportDialog=page.getByRole('dialog').filter({has:page.getByLabel('Project export format',{exact:true})});
    await exportDialog.getByLabel('Project export format',{exact:true}).selectOption('opengeo');[download]=await Promise.all([page.waitForEvent('download'),exportDialog.getByRole('button',{name:'Export file',exact:true}).click()]);await download.saveAs(resolve(output,'project.opengeo-project.json'));receipt.projectDownloads++;
    const saved=readBrowserProjectFile(await readFile(resolve(output,'project.opengeo-project.json'),'utf8'));assert.deepEqual(saved.layers[0].geojson.features,working.features);assert.deepEqual(saved.layers[0].metadata,before.layer.metadata);
    receipt.stage='Fresh document reopens exact Project then dark source review/original download';await persist();await page.close();page=await open(url);
    await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.length===1&&c.map.areTilesLoaded();});
    const restored=await page.evaluate(()=>{const s=document.querySelector('.opengeo-workbench'),c=s.getPrintContext();return{layer:c.layers[0],data:s.__opengeoData.get(c.layers[0].layerId)};});
    assert.equal(restored.layer.layerId,receipt.layerId);assert.deepEqual(restored.data.features,working.features);assert.deepEqual(restored.layer.metadata,saved.layers[0].metadata);receipt.IndexedDBReopen=true;
    if(await page.getByRole('button',{name:'Dark',exact:true}).count())await page.getByRole('button',{name:'Dark',exact:true}).first().click();
    await page.getByRole('button',{name:'Catalog',exact:true}).click();await page.locator(`[data-browser-catalog-layer="${restored.layer.datasetId}"]`).getByRole('button').first().click();review=page.locator('.browser-layer-registration');await review.waitFor();assert((await review.innerText()).includes('Saved on this device'));assert(!/demo/i.test(await review.innerText()));await inspect(review,'dark');
    [download]=await Promise.all([page.waitForEvent('download'),review.getByRole('button',{name:'Download original NMEA',exact:true}).click()]);await download.saveAs(resolve(output,'original.nmea'));receipt.originalDownloads++;assert.equal(hash(await readFile(resolve(output,'original.nmea'))),hash(original));await review.getByRole('button',{name:'Cancel',exact:true}).click();
    within();assert(!guard,guard?.message);assert.deepEqual(receipt.errors,[]);receipt.status='passed-compiled-NMEA-review-render-export-IndexedDB-save-fresh-reopen-original-and-themes';
  }catch(error){receipt.status='stopped';receipt.failure=error.message;if(page&&!page.isClosed())await page.screenshot({path:resolve(output,'stopped.png')});throw error;}
  finally{await browser.close();await server.close();receipt.browserClosed=true;receipt.milliseconds=Date.now()-started;await persist();}
}
