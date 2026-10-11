// Actual retained Nepal point/line/polygon previews through the built Workbench.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const out = resolve('../.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-small-20260922');
const dist = resolve('dist');
const registration = JSON.parse(await readFile(resolve(out, 'registration.json')));
const inspection = JSON.parse(await readFile(resolve(out, 'inspection/inspection.json')));
assert.equal(inspection.status, 'passed');
const selection = ['gis_osm_transport_free_1', 'gis_osm_traffic_a_free_1', 'gis_osm_railways_free_1'];
const fixtures = await Promise.all(selection.map(async (name) => {
  const record = registration.records.find((r) => r.layer === name);
  assert.ok(record?.datasetVersionId);
  const checked = inspection.records.find((r) => r.layer === name).inspection;
  const artifact = checked.artifacts.find((a) => a.relative_key === 'preview/preview.geojson');
  const body = await readFile(resolve(out, 'inspection', name, 'preview.geojson'));
  assert.equal(createHash('sha256').update(body).digest('hex'), artifact.sha256);
  const data = JSON.parse(body);
  assert.equal(data.features.length, checked.feature_count);
  return {record, checked, data};
}));
const layers = fixtures.map(({record, checked}, i) => ({
  layerId: `nepal-${i}`, datasetId: record.datasetId, datasetVersionId: record.datasetVersionId,
  sourceType: 'governed-dataset', sourceVersion: 1, title: `Nepal ${['points', 'polygons', 'lines'][i]}`,
  geometryType: checked.geometry_type, bbox: checked.extent, visible: false, opacity: 1, order: i,
  style: i === 0 ? {circleColor: '#f97316', circleRadius: 6} : {fill: '#22c55e', stroke: '#15803d', strokeWidth: 3},
  labels: {enabled: false, field: null}
}));
const module = (await readdir(resolve(dist, '_import/components'))).find((x) => /^WorkbenchView\..*\.js$/.test(x));
const browser = await chromium.launch({executablePath: '/usr/bin/chromium-browser', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
const origin = 'https://nepal-preview.invalid';
let externalRequests = 0;
const errors = [];
try {
  const context = await browser.newContext({viewport: {width: 1200, height: 850}, serviceWorkers: 'block'});
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests++; return route.abort(); }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: `<!doctype html>
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/maplibre.css">
      <style>html,body{margin:0}.opengeo-workbench{height:100vh}</style><script type="module">
      import {WorkbenchView} from '/_import/components/${module}';
      const layers=${JSON.stringify(layers)}, fixtures=${JSON.stringify(fixtures).replaceAll('<', '\\u003c')};
      window.reads=0;
      window.shell=WorkbenchView({workspace:{workspaceId:'3fa15fb0-0823-4a9a-94cb-1bbbf10baa5e',title:'Nepal archive'},
        project:{layers,mapViews:[{id:'default',title:'Default',center:[84.1,28.4],zoom:6.5}],
          basemaps:[{basemapId:'blank',title:'Blank canvas',kind:'blank',visible:true}],bookmarks:[],activeLayerId:layers[0].layerId},
        layers,role:'owner',persistenceMode:'api',loadDatasetVersionPreview:async(id,version)=>{
          reads++;const item=fixtures.find(x=>x.record.datasetId===id);
          if(item.record.datasetVersionId!==version)throw Error('Version mismatch');
          return {datasetVersionId:version,mayBeTruncated:false,geojson:item.data};}});
      document.body.append(shell);</script>`});
    const path = url.pathname === '/style.css' ? resolve('src/style.css')
      : url.pathname === '/maplibre.css' ? resolve('node_modules/maplibre-gl/dist/maplibre-gl.css')
      : resolve(dist, '.' + url.pathname);
    try { return route.fulfill({body: await readFile(path), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'}); }
    catch { return route.abort(); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.shell?.__opengeoMap?.isStyleLoaded());
  assert.equal(await page.evaluate(() => reads), 0);
  const results = [];
  for (let i = 0; i < selection.length; i++) {
    const positions = [];
    const collect = (coords) => {
      if (typeof coords[0] === 'number') positions.push(coords);
      else coords.forEach(collect);
    };
    collect(fixtures[i].data.features.find((f) => f.geometry)?.geometry.coordinates);
    assert.ok(positions.length);
    const bbox = [Math.min(...positions.map((p) => p[0])) - 0.0001,
      Math.min(...positions.map((p) => p[1])) - 0.0001,
      Math.max(...positions.map((p) => p[0])) + 0.0001,
      Math.max(...positions.map((p) => p[1])) + 0.0001];
    console.log(JSON.stringify({phase: 'rendering', layer: selection[i], probeBounds: bbox}));
    await page.evaluate((bbox) => shell.__opengeoMap.fitBounds(bbox, {padding: 60, maxZoom: 18, duration: 0}), bbox);
    const toggle = page.getByLabel(`Show ${layers[i].title}`, {exact: true});
    await toggle.check();
    await page.waitForFunction((i) => window.shell.__opengeoData.has(`nepal-${i}`), i);
    assert.equal(await page.evaluate((i) => shell.__opengeoData.get(`nepal-${i}`).features.length, i), fixtures[i].checked.feature_count);
    await page.waitForFunction((i) => {
      const map = shell.__opengeoMap;
      const ids = map.getStyle().layers.filter((l) => l.source === `nepal-${i}-source`).map((l) => l.id);
      return ids.length && map.queryRenderedFeatures({layers: ids}).length > 0;
    }, i);
    await toggle.uncheck();
    await toggle.check();
    assert.equal(await page.evaluate(() => reads), i + 1);
    results.push({datasetId: fixtures[i].record.datasetId, features: fixtures[i].checked.feature_count,
      geometry: fixtures[i].checked.geometry_type, rendered: true});
    await page.screenshot({path: resolve(out, `preview-${i}.png`)});
    await toggle.uncheck();
  }
  assert.deepEqual(errors, []);
  assert.equal(externalRequests, 0);
  await page.screenshot({path: resolve(out, 'preview-browser.png')});
  await writeFile(resolve(out, 'preview-browser.json'), JSON.stringify({status: 'passed',
    scope: 'Built Workbench, three representative actual Nepal archives; intercepted transport, not signed-in hosted acceptance.',
    hiddenMapReads: 0, readsAfterToggle: 3, repeatVisibilityReads: 0, externalRequests, results}, null, 2));
  console.log(JSON.stringify({status: 'passed', results}));
} finally { await browser.close(); }
