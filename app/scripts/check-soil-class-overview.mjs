// Renderer workload pilot; this does not admit an archive or test hosted authorization.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {chromium} from 'playwright';

const out = resolve('../.local-archives/bhutan-local-20260920/soil-display-maplibre/class-overview-probe');
const receiptPath = resolve(out, 'renderer.json');
assert.ok(!existsSync(receiptPath));
const pilot = JSON.parse(await readFile(resolve(out, 'receipt.json')));
assert.equal(pilot.status, 'pixel-coverage-passed-awaiting-renderer-review');
const tiles = new Map();
for (const t of pilot.tiles) {
  const body = await readFile(resolve(out, t.file));
  assert.equal(createHash('sha256').update(body).digest('hex'), t.sha256);
  tiles.set(`${t.z}/${t.x}/${t.y}`, body);
}
const empty = gzipSync(fromGeojsonVt({overview: {features: []}}, {extent: 8192, version: 2}));
const result = {status: 'running', views: [], requestedBytes: 0, requests: 0,
  externalRequests: 0, errors: [],
  scope: 'Installed MapLibre renderer with five real aggregate MVT pilot tiles over intercepted local transport; not a complete PMTiles archive, Studio selector or hosted acceptance.'};
const origin = 'https://soil-overview-review.invalid';
let browser, page;
try {
  browser = await chromium.launch({headless: true,
    executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { result.externalRequests++; return route.abort(); }
    if (url.pathname.startsWith('/tiles/')) {
      const key = url.pathname.slice(7).replace('.mvt', '');
      const body = gunzipSync(tiles.get(key) ?? empty);
      result.requests++; result.requestedBytes += body.length;
      assert.ok(result.requests <= 100 && result.requestedBytes < 8 * 1024 ** 2);
      // Playwright fulfillment supplies decoded response bytes, as a browser fetch does.
      return route.fulfill({body, contentType: 'application/vnd.mapbox-vector-tile'});
    }
    if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map{margin:0;width:100%;height:100%}</style><div id="map"></div><script src="/maplibre.js"></script><script>
      const colors=['match',['get','gridcode'],1,'#fff7bc',2,'#fec44f',3,'#fe9929',4,'#d95f0e',5,'#993404','#999'];
      window.map=new maplibregl.Map({container:'map',center:[90.45,27.5],zoom:7,
        style:{version:8,sources:{overview:{type:'vector',tiles:['${origin}/tiles/{z}/{x}/{y}.mvt'],minzoom:7,maxzoom:7},intermediate:{type:'vector',tiles:['${origin}/tiles/{z}/{x}/{y}.mvt'],minzoom:10,maxzoom:10}},
        layers:[{id:'background',type:'background',paint:{'background-color':'#16212b'}},
          {id:'overview',source:'overview','source-layer':'overview',type:'fill',maxzoom:10,paint:{'fill-color':colors,'fill-antialias':false}},
          {id:'intermediate',source:'intermediate','source-layer':'overview',type:'fill',minzoom:10,paint:{'fill-color':colors,'fill-antialias':false}}]}});
      window.mapErrors=[];map.on('error',event=>mapErrors.push(event.error.message));
    </script>`});
    const file = url.pathname === '/maplibre.js' ? 'maplibre-gl.js' : 'maplibre-gl.css';
    return route.fulfill({body: await readFile(resolve('node_modules/maplibre-gl/dist', file)),
      contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css'});
  });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', e => result.errors.push(e.message));
  let start = Date.now();
  await page.goto(origin);
  await page.waitForFunction(() => window.map?.loaded() && map.queryRenderedFeatures({layers: ['overview']}).length > 0);
  result.views.push({zoom: 7, elapsedMilliseconds: Date.now() - start,
    features: await page.evaluate(() => map.queryRenderedFeatures({layers: ['overview']}).length)});
  await page.screenshot({path: resolve(out, 'overview.png')});
  const probe = pilot.tiles.find(t => t.z === 10);
  const lng = (probe.x + 0.5) / 1024 * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (probe.y + 0.5) / 1024))) * 180 / Math.PI;
  start = Date.now();
  await page.evaluate(center => map.jumpTo({center, zoom: 10}), [lng, lat]);
  await page.waitForFunction(() => map.loaded() && map.queryRenderedFeatures({layers: ['intermediate']}).length > 0);
  result.views.push({zoom: 10, elapsedMilliseconds: Date.now() - start,
    features: await page.evaluate(() => map.queryRenderedFeatures({layers: ['intermediate']}).length)});
  await page.screenshot({path: resolve(out, 'intermediate.png')});
  assert.deepEqual(await page.evaluate(() => mapErrors), []);
  assert.deepEqual(result.errors, []); assert.equal(result.externalRequests, 0);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = String(error);
  result.diagnostics = await page?.evaluate(() => ({errors: window.mapErrors,
    loaded: window.map?.loaded(), rendered: window.map?.queryRenderedFeatures().length})).catch(() => null);
  await page?.screenshot({path: resolve(out, 'renderer-failure.png'), timeout: 5000}).catch(() => {});
  throw error;
} finally {
  await writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n');
  await browser?.close(); console.log(JSON.stringify(result));
}
