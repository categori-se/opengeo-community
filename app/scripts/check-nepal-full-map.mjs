// All fifteen real Nepal layers through the built managed-vector/Workbench path.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {chromium} from 'playwright';

const root = resolve('..');
const mixed = process.argv.includes('--mixed');
const direct = process.argv.includes('--direct-read-regression');
const out = resolve(root, '.local-archives/nepal-srilanka-catalog-20260921', mixed ? 'nepal-osm-mixed-20260923' : 'nepal-osm-small-20260922');
const dist = resolve('dist');
const plan = JSON.parse(await readFile(resolve(out, 'display-plan.json')));
const registration = JSON.parse(await readFile(resolve(out, 'registration.json')));
const inspection = JSON.parse(await readFile(resolve(out, 'inspection/inspection.json')));
const states = JSON.parse(await readFile(resolve(out, 'processing-state.json')));
const moduleAt = async (folder, prefix) => (await readdir(resolve(dist, folder))).find((n) => n.startsWith(prefix + '.') && n.endsWith('.js'));
const workbench = await moduleAt('_import/components', 'WorkbenchView');
const reader = await moduleAt('_import/lib', 'managedVectorRead');
const modules = await Promise.all([['_import/components', workbench], ['_import/lib', reader]].map(async ([folder, name]) => {
  const path = resolve(dist, folder, name);
  return {path: path.slice(root.length + 1), sha256: createHash('sha256').update(await readFile(path)).digest('hex')};
}));
const fixtures = [];
for (const item of plan.records) {
  const row = registration.records.find((r) => r.layer === item.layer);
  const checked = inspection.records.find((r) => r.layer === item.layer).inspection;
  const source = await readFile(resolve(root, item.path));
  assert.equal(createHash('sha256').update(source).digest('hex'), item.sha256);
  const geometry = JSON.parse(source).features.find((f) => f.geometry)?.geometry;
  const points = [];
  const walk = (c) => typeof c[0] === 'number' ? points.push(c) : c.forEach(walk);
  walk(geometry.coordinates);
  const probeBounds = [Math.min(...points.map((p) => p[0])) - 0.0001, Math.min(...points.map((p) => p[1])) - 0.0001,
    Math.max(...points.map((p) => p[0])) + 0.0001, Math.max(...points.map((p) => p[1])) + 0.0001];
  const original = {id: states.find((s) => s.layer === item.layer).originalObjectId,
    role: 'original', filename: basename(item.path), contentType: 'application/geo+json',
    sizeBytes: item.bytes, checksumSha256: item.sha256};
  fixtures.push({item, row, probeBounds, version: {id: row.datasetVersionId, state: 'active',
    featureCount: item.features, crs: checked.crs, geometryType: checked.geometry_type, objects: [original]}});
}
assert.equal(fixtures.length, mixed ? 6 : 15);
const layers = fixtures.map(({item, row}, i) => ({layerId: `nepal-full-${i}`, datasetId: row.datasetId,
  datasetVersionId: row.datasetVersionId, sourceType: 'governed-dataset', sourceVersion: 1,
  title: item.label, geometryType: item.geometryType, bbox: item.extent, visible: false,
  opacity: 1, order: i, style: item.geometryType.includes('Point') ? {circleColor: '#f97316', circleRadius: 6}
    : {fill: '#22c55e', stroke: '#15803d', strokeWidth: 3}, labels: {enabled: false, field: null}}));
const origin = 'https://nepal-full-map.invalid';
const browser = await chromium.launch({executablePath: '/usr/bin/chromium-browser', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
const reads = [];
const errors = [];
const results = [];
const receipt = {status: 'running', results, modules, externalRequests: 0,
  scope: 'Built Workbench plus built managed-vector reader with all real files and exact registered identities; intercepted API/S3 transport, not hosted sign-in.'};
const save = async () => writeFile(resolve(out, direct ? 'direct-read-browser.json' : 'full-map-browser.json'), JSON.stringify(receipt, null, 2) + '\n');
try {
  const context = await browser.newContext({viewport: {width: 1200, height: 850}, serviceWorkers: 'block'});
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://s3.us-east-1.amazonaws.com') {
      const fixture = fixtures.find((f) => url.pathname === '/' + 'storage.opengeo.tools/' + f.row.key);
      assert.ok(fixture);
      assert.equal(url.searchParams.get('versionId'), fixture.row.put.versionId);
      const body = await readFile(resolve(root, fixture.item.path));
      reads.push({layer: fixture.item.layer, mode: 'original', bytes: body.length});
      return route.fulfill({contentType: 'application/geo+json', headers: {'access-control-allow-origin': '*'}, body});
    }
    if (url.origin !== origin) { receipt.externalRequests++; return route.abort(); }
    if (url.pathname.startsWith('/preview/')) {
      const i = Number(url.pathname.slice('/preview/'.length));
      const fixture = fixtures[i];
      assert.ok(fixture);
      const data = JSON.parse(await readFile(resolve(out, 'inspection', fixture.item.layer, 'preview.geojson')));
      reads.push({layer: fixture.item.layer, mode: 'preview', bytes: Buffer.byteLength(JSON.stringify(data))});
      return route.fulfill({contentType: 'application/json', body: JSON.stringify({datasetVersionId: fixture.row.datasetVersionId,
        numberReturned: data.features.length, numberMatched: fixture.item.features,
        mayBeTruncated: data.features.length !== fixture.item.features, geojson: data})});
    }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css">
      <style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
      import {WorkbenchView} from '/_import/components/${workbench}';
      import {loadManagedVectorData} from '/_import/lib/${reader}';
      const fixtures=${JSON.stringify(fixtures).replaceAll('<', '\\u003c')},layers=${JSON.stringify(layers)};
      window.calls={versions:0,tickets:0,authorizations:0};
      const adapter={listDatasetVersions:async(p,id)=>{calls.versions++;return [fixtures.find(f=>f.row.datasetId===id).version];},
        getDatasetSpatialPreview:async(p,id,version)=>{
          const i=fixtures.findIndex(f=>f.row.datasetId===id);return fetch('/preview/'+i).then(r=>r.json());},
        requestDatasetDownload:async(p,id,version,object)=>{
          if(window.failDownloads)throw Error('Download denied');
          calls.tickets++;const f=fixtures.find(f=>f.row.datasetId===id);
          if(version!==f.version.id||object!==f.version.objects[0].id)throw Error('Wrong identity');
          const url=new URL('https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/'+f.row.key);
          url.searchParams.set('versionId',f.row.put.versionId);url.searchParams.set('X-Amz-Signature','offline-fixture');
          return {method:'GET',url:url.href,expiresAt:new Date(Date.now()+300000).toISOString()};}};
      window.shell=WorkbenchView({workspace:{workspaceId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',title:'Nepal archive'},
        project:{layers,mapViews:[{id:'default',title:'Default',center:[84.1,28.4],zoom:6.5}],
          basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:layers[0].layerId},
        layers,role:'owner',persistenceMode:'api',loadDatasetVersionPreview:(datasetId,versionId,geometryType)=>
          loadManagedVectorData({adapter,projectId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',datasetId,versionId,geometryType,
            assertScope:async()=>{},authorize:async()=>{calls.authorizations++;}})});
      document.body.append(shell);</script>`});
    const path = url.pathname === '/style.css' ? resolve('src/style.css')
      : url.pathname === '/maplibre.css' ? resolve('node_modules/maplibre-gl/dist/maplibre-gl.css') : resolve(dist, '.' + url.pathname);
    try { return route.fulfill({body: await readFile(path), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'}); }
    catch { return route.abort(); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.shell?.__opengeoMap?.isStyleLoaded());
  if (process.argv.includes('--inspect-controls')) {
    const controls = await page.getByRole('checkbox').evaluateAll((nodes) => nodes.map((n) => ({label: n.getAttribute('aria-label'), title: n.getAttribute('title')})));
    await writeFile(resolve(out, 'full-map-controls.json'), JSON.stringify({controls, text: await page.locator('body').innerText()}, null, 2));
    await page.screenshot({path: resolve(out, 'full-map-controls.png')});
    console.log(JSON.stringify({controls}));
    await browser.close();
    process.exit(0);
  }
  assert.equal(reads.length, 0);
  assert.deepEqual(await page.evaluate(() => calls), {versions: 0, tickets: 0, authorizations: 0});
  receipt.hiddenReads = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    console.log(JSON.stringify({phase: 'rendering', layer: fixture.item.layer}));
    await page.evaluate((bbox) => shell.__opengeoMap.fitBounds(bbox, {padding: 60, maxZoom: 18, duration: 0}), fixture.probeBounds);
    const toggle = page.getByLabel(`Show ${layers[i].title}`, {exact: true});
    await toggle.check();
    await page.waitForFunction((i) => shell.__opengeoData.has(`nepal-full-${i}`), i);
    assert.equal(await page.evaluate((i) => shell.__opengeoData.get(`nepal-full-${i}`).features.length, i), fixture.item.features);
    await page.waitForFunction((i) => {
      const map = shell.__opengeoMap;
      const ids = map.getStyle().layers.filter((l) => l.source === `nepal-full-${i}-source`).map((l) => l.id);
      return ids.length && map.queryRenderedFeatures({layers: ids}).length > 0;
    }, i);
    const priorReads = reads.length;
    await toggle.uncheck(); await toggle.check();
    assert.equal(reads.length, priorReads);
    results.push({layer: fixture.item.layer, datasetId: fixture.row.datasetId,
      features: fixture.item.features, complete: true, rendered: true, repeatVisibilityReads: 0});
    await save();
    await toggle.uncheck();
  }
  assert.deepEqual(errors, []);
  assert.equal(receipt.externalRequests, 0);
  const expectedOriginals = direct ? fixtures.length : fixtures.filter(f => f.item.features > 5000 || f.item.bytes > 4 * 1024 ** 2).length;
  assert.equal(reads.filter((r) => r.mode === 'original').length, expectedOriginals);
  assert.equal(reads.filter((r) => r.mode === 'preview').length, fixtures.length - expectedOriginals);
  receipt.status = 'passed'; receipt.reads = structuredClone(reads); receipt.calls = await page.evaluate(() => calls);
  if (direct) {
    // Reproduce the user's Nepal viewport with every Nepal layer enabled,
    // rather than proving isolated features only at synthetic probe locations.
    await page.evaluate(() => shell.__opengeoMap.jumpTo({center:[85.32,27.71],zoom:11}));
    for (let i=0;i<4;i++) await page.getByLabel(`Show ${layers[i].title}`, {exact:true}).check();
    await page.waitForFunction(() => [0,1,2,3].every(i => {
      const map=shell.__opengeoMap;
      const ids=map.getStyle().layers.filter(l=>l.source===`nepal-full-${i}-source`).map(l=>l.id);
      return ids.length && map.queryRenderedFeatures({layers:ids}).length>0;
    }));
    receipt.nepalTogetherRendered = true;
    await page.screenshot({path: resolve(out, 'direct-read-nepal.png')});
    const broken = await context.newPage();
    await broken.addInitScript(() => {
      const original=HTMLCanvasElement.prototype.getContext;
      window.restoreGraphics=()=>{HTMLCanvasElement.prototype.getContext=original;};
      HTMLCanvasElement.prototype.getContext=function(kind,...args){return /webgl/.test(kind)?null:original.call(this,kind,...args);};
    });
    const failures=[];
    broken.on('pageerror',error=>failures.push(error.message));
    const readsBefore=reads.length;
    await broken.goto(origin);
    await broken.getByText('Map graphics unavailable',{exact:true}).waitFor();
    assert.equal(await broken.getByRole('button',{name:'Retry map',exact:true}).count(),1);
    assert.equal(await broken.getByRole('checkbox').count()>=fixtures.length,true);
    assert.equal(reads.length,readsBefore);
    await broken.evaluate(()=>restoreGraphics());
    await broken.getByRole('button',{name:'Retry map',exact:true}).click();
    await broken.waitForFunction(()=>shell.__opengeoMap?.isStyleLoaded());
    assert.deepEqual(failures,[]);
    receipt.graphicsFailureRecovery={uncaughtErrors:0,hiddenReads:reads.length-readsBefore,retrySucceeded:true};
    await broken.close();
    const denied=await context.newPage();
    await denied.addInitScript(()=>{window.failDownloads=true;});
    await denied.goto(origin);
    await denied.waitForFunction(()=>shell.__opengeoMap?.isStyleLoaded());
    const beforeDenied=reads.length;
    const toggle=denied.getByLabel(`Show ${layers[0].title}`,{exact:true});
    await toggle.check();
    await denied.locator('[data-status-field="message"]').filter({hasText:'could not load completely'}).waitFor();
    assert.match(await denied.locator('[data-status-field="loading"]').innerText(),/could not load/);
    assert.equal(reads.length,beforeDenied);
    await denied.evaluate(()=>{window.failDownloads=false;});
    await toggle.uncheck();await toggle.check();
    await denied.waitForFunction(()=>shell.__opengeoData.has('nepal-full-0'));
    receipt.layerFailureRecovery={failedReads:0,errorVisible:true,retrySucceeded:true};
    await denied.close();
  } else await page.screenshot({path: resolve(out, 'full-map-browser.png')});
  await save();
  console.log(JSON.stringify({status: 'passed', layers: results.length, features: results.reduce((s, r) => s+r.features, 0)}));
} catch (error) {
  receipt.status = 'failed'; receipt.error = String(error); receipt.errors = errors;
  await save(); throw error;
} finally { await browser.close(); }
