import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {OZI_IMPORT_LIMITS, readOziFile, originalOziFile} from '../src/lib/oziImport.js';
import {readBrowserProjectFile} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';

const waypointBytes = await readFile(new URL('../../fixtures/gps/source-waypoints.wpt', import.meta.url));
const trackBytes = await readFile(new URL('../../fixtures/gps/source-track.plt', import.meta.url));
const input = (value = waypointBytes, name = 'source-waypoints.wpt') => new File([value], name, {type: 'text/plain'});
const wptHeader = 'OziExplorer Waypoint File Version 1.1\nWGS 84\nReserved\nGarmin\n';
const pltHeader = 'OziExplorer Track Point File Version 2.1\nWGS 84\nAltitude is in Feet\nReserved\n0,2,255,Track,1,0,0,255\n999999\n';
const project = result => JSON.stringify({...emptyMapDefinition(), layers: [{
  layerId: 'ozi-source', datasetId: 'ozi-source', title: 'Ozi source',
  sourceType: 'geojson-object', geojson: result.geojson, metadata: {source: result.source}
}], persistence: {mode: 'browser-personal'}});

if (process.env.OPEN_GEO_OZI_DIST) {await checkOziBrowser();process.exit(0);}

it('maps bounded WPT waypoints with exact source fields, raw dates/feet, rejected rows and unexecuted attachments', async () => {
  const previous = globalThis.fetch;globalThis.fetch = () => {throw Error('Ozi imports must never fetch attachments or sources');};
  try {
    const result = await readOziFile(input()), features = result.geojson.features;
    assert.deepEqual(result.report.counts, {records: 3, positions: 2, features: 2, waypoints: 2, segments: 0, elevations: 1, timestamps: 1});
    assert.deepEqual(features.map(feature => feature.geometry), [
      {type: 'Point', coordinates: [85.3, 27.7]}, {type: 'Point', coordinates: [-151.21, -33.86]}
    ]);
    assert.equal(features[0].properties.name, 'Camp');
    assert.equal(features[0].properties.ozi.fields.length, 24);
    assert.equal(features[0].properties.ozi.fields[21], 'https://example.invalid/do-not-open');
    assert.equal(features[0].properties.ozi.line, waypointBytes.toString('ascii').split('\n')[4]);
    assert.equal(features[0].properties.ozi.record, 5);
    assert.equal(features[0].id, features[0].properties.ozi.rowId);
    assert.equal(features[0].properties.ozi.altitudeFeet, '4758.25');
    assert.equal(features[0].properties.ozi.dateSerial, '46200.5');
    assert.equal(features[1].properties.ozi.fields.length, 4);
    assert.equal(features[1].properties.ozi.altitudeFeet, null);
    assert.equal(features[1].properties.ozi.dateSerial, null);
    assert.equal(result.report.rejectedRecords[0].record, 7);
    assert.equal(result.report.rejectedRecords[0].code, 'invalid-coordinate');
    assert.equal(result.report.rejectedRecords[0].fields[2], '91');
    assert(result.report.rejectedRecords.every(record => record.originalPreserved));
    assert.equal(result.report.headerRecords.length, 4);
    assert.equal(result.report.coordinateReferencePolicy, 'explicit-source-header');
    assert.equal(result.report.sourceDatum, 'WGS 84');
    assert.equal(result.source.format, 'ozi');assert.equal(result.source.variant, 'wpt');
    assert.equal(result.source.sha256, createHash('sha256').update(waypointBytes).digest('hex'));
    assert.deepEqual((await originalOziFile(result.source)).bytes, new Uint8Array(waypointBytes));
  } finally {globalThis.fetch = previous;}
});

it('splits PLT at code 1 and every malformed gap, retaining singleton Points and one-to-one point source arrays', async () => {
  const result = await readOziFile(input(trackBytes, 'source-track.plt')), features = result.geojson.features;
  assert.deepEqual(result.report.counts, {records: 6, positions: 5, features: 3, waypoints: 0, segments: 3, elevations: 1, timestamps: 2});
  assert.deepEqual(features.map(feature => feature.geometry), [
    {type: 'LineString', coordinates: [[85.3, 27.7], [85.31, 27.71]]},
    {type: 'Point', coordinates: [85.33, 27.73]},
    {type: 'LineString', coordinates: [[85.34, 27.74], [85.35, 27.75]]}
  ]);
  assert.deepEqual(features.map(feature => feature.properties.ozi.points.map(point => point.record)), [[7, 8], [10], [11, 12]]);
  assert.equal(features[0].properties.ozi.points[1].altitudeFeet, '-777');
  assert.equal(features[0].properties.ozi.points[1].dateSerial, '');
  assert.equal(features[0].properties.ozi.points[0].dateText, '16-Oct-26');
  assert.equal(features[0].properties.ozi.points[0].timeText, '12:00:00');
  assert.equal(features[1].properties.ozi.points.length, 1);
  assert(features.flatMap(feature => feature.properties.ozi.points).every(point => point.rowId && point.fields.length === 7 && point.line));
  assert.equal(result.report.rejectedRecords[0].record, 9);
  assert.equal(result.report.rejectedRecords[0].line, 'bad,85.32,0,,,,');
  assert.equal(result.report.headerRecords.length, 6);
  assert.equal(result.report.headerRecords[5].line, '999999');
  assert.equal(result.report.pointCountHeaderIgnored, true);
  const gaps = await readOziFile(input(pltHeader + '0,0,0,,,,\n\n1,1,0,,,,\n2,2,2,,,,\n3,3,0,,,,', 'gaps.plt'));
  assert.deepEqual(gaps.geojson.features.map(feature => feature.geometry), [
    {type: 'Point', coordinates: [0, 0]}, {type: 'Point', coordinates: [1, 1]}, {type: 'Point', coordinates: [3, 3]}
  ]);
  assert.deepEqual(gaps.report.rejectedRecords.map(row => row.code), ['malformed-record', 'unsupported-segment-code']);
  const optionalStyle = pltHeader.replace('0,2,255,Track,1,0,0,255', '0,,,,,0,,').replace('999999', 'ignored nonnumeric count');
  const optional = await readOziFile(input(optionalStyle + '0,0,0,,,,', 'optional.plt'));
  assert.equal(optional.report.counts.positions, 1);
  assert.equal(optional.report.counts.timestamps, 0);
});

it('rejects unsupported versions/datums/encodings and enforces input, row, field, feature and complete-output bounds', async () => {
  for (const [value, name, code] of [
    ['', 'empty.wpt', 'ozi_input_limit'], ['x'.repeat(OZI_IMPORT_LIMITS.inputBytes + 1), 'large.wpt', 'ozi_input_limit'],
    [waypointBytes, 'source.rte', 'ozi_variant_unsupported'], [waypointBytes, 'source.pnt', 'ozi_variant_unsupported'], [waypointBytes, 'source.evt', 'ozi_variant_unsupported'],
    [waypointBytes, 'source.csv', 'ozi_extension'], [waypointBytes, 'source.plt', 'ozi_variant_mismatch'],
    [wptHeader.replace('Version 1.1', 'Version 1.0') + '-1,A,0,0', 'old.wpt', 'ozi_version_unsupported'],
    [wptHeader.replace('WGS 84', 'NAD83') + '-1,A,0,0', 'datum.wpt', 'ozi_datum_unsupported'],
    [wptHeader.replace('WGS 84', '') + '-1,A,0,0', 'datum.wpt', 'ozi_datum_unsupported'],
    ['OziExplorer Waypoint File Version 1.1\nWGS 84', 'header.wpt', 'ozi_header'],
    [wptHeader + '-1,Caf\u00e9,0,0', 'encoding.wpt', 'ozi_encoding'],
    [new Uint8Array([255]), 'encoding.wpt', 'ozi_encoding'],
    [wptHeader.replace('Reserved', 'x'.repeat(2049)) + '-1,A,0,0', 'line.wpt', 'ozi_line_limit'],
    [wptHeader + Array(25).fill('0').join(','), 'fields.wpt', 'ozi_field_limit'],
    [wptHeader + '-1,A,0,0\n'.repeat(2001), 'rows.wpt', 'ozi_record_limit'],
    [wptHeader + '-1,A,0,0\n'.repeat(1001), 'features.wpt', 'ozi_feature_limit'],
    [pltHeader.replace('0,2,255,Track,1,0,0,255', '0,2,255,Track,1,0,0') + '0,0,0,,,,', 'style.plt', 'ozi_track_style'],
    [pltHeader.replace('0,2,255,Track,1,0,0,255', '0,2,255,Track,1,10,0,255') + '0,0,0,,,,', 'polygon.plt', 'ozi_track_type_unsupported'],
    [pltHeader.replace('0,2,255,Track,1,0,0,255', '0,2,255,Track,1,20,0,255') + '0,0,0,,,,', 'alarm.plt', 'ozi_track_type_unsupported']
  ]) await assert.rejects(readOziFile(input(value, name)), error => error.code === code && error.report.operation === 'reject');
  for (const row of ['-1,A,,0', '-1,A,1e1,0', '-1,A,NaN,0', '-1,A,Infinity,0', '-1,A,90.1,0', '-1,A,0,-180.1', '-1,A,0', '-1,A,0,0,bad', '-1,A,0,0,,,,,,,,,,bad']) {
    await assert.rejects(readOziFile(input(wptHeader + row)), error => error.code === 'ozi_no_positions' && error.report.rejectedRecords.length === 1);
  }
  for (const row of ['0,0,2,,,,', '0,0,0,,,', '0,0,0,NaN,,,', '0,0,0,,NaN,,']) {
    await assert.rejects(readOziFile(input(pltHeader + row, 'bad.plt')), error => error.code === 'ozi_no_positions' && error.report.rejectedRecords.length === 1);
  }
  const poles = await readOziFile(input(wptHeader.replace('WGS 84', 'WGS84') + '-1,Poles,90,-180,-1.25'));
  assert.deepEqual(poles.geojson.features[0].geometry.coordinates, [-180, 90]);
  assert.equal(poles.geojson.features[0].properties.ozi.dateSerial, '-1.25');
  const oversized = wptHeader + '-1,Valid,0,0\n' + ('-1,' + 'x'.repeat(70) + ',NaN,0\n').repeat(1999);
  assert(Buffer.byteLength(oversized) < OZI_IMPORT_LIMITS.inputBytes);
  await assert.rejects(readOziFile(input(oversized)), error => error.code === 'ozi_output_limit');
});

it('Project reopening and working edits preserve exact BOM/CRLF originals while altered bytes or digests fail verification', async () => {
  const raw = '\ufeff' + waypointBytes.toString('ascii').replace(/\n/g, '\r\n'), file = input(raw, '../source.wpt');
  const result = await readOziFile(file), before = new Uint8Array(await file.arrayBuffer());
  const reopened = readBrowserProjectFile(project(result)).layers[0];
  assert.deepEqual(reopened.geojson, result.geojson);assert.deepEqual(reopened.metadata.source, result.source);
  assert.equal(result.report.sourceEncoding, 'ASCII-with-UTF8-BOM');
  reopened.geojson.features[0].geometry.coordinates[0] = 0;
  reopened.geojson.features[0].properties.ozi.altitudeFeet = 'edited working value';
  reopened.geojson.features[0].properties.ozi.fields[0] = 'edited';
  const original = await originalOziFile(reopened.metadata.source);
  assert.deepEqual(original.bytes, before);assert.equal(original.filename, '.._source.wpt');
  assert.equal(result.geojson.features[0].properties.ozi.altitudeFeet, '4758.25');
  assert.equal(result.geojson.features[0].properties.ozi.fields[0], '-1');
  const shortened = structuredClone(result.source);shortened.originalFile.content = shortened.originalFile.content.slice(4);
  await assert.rejects(originalOziFile(shortened), error => error.code === 'ozi_original_checksum');
  const forged = structuredClone(result.source);forged.originalFile.sha256 = 'a'.repeat(64);
  await assert.rejects(originalOziFile(forged), error => error.code === 'ozi_original_checksum');
  const modified = structuredClone(result.source), content = Buffer.from(modified.originalFile.content, 'base64');content[10] ^= 1;
  modified.originalFile.content = content.toString('base64');
  await assert.rejects(originalOziFile(modified), error => error.code === 'ozi_original_checksum');
  const encoding = structuredClone(result.source);encoding.originalFile.content = '!!!!';
  await assert.rejects(originalOziFile(encoding), error => error.code === 'ozi_original_invalid');
});

if (process.env.OPEN_GEO_OZI_PILOT === '1') it('one maximum PLT pilot preserves 2000 positions across 1000 two-point segments and reopens the Project', async () => {
  const target = new URL('../../.local-archives/renderer-switch-20260930/ozi-import-20261016/pilot.json', import.meta.url);
  assert(!existsSync(target), 'Reuse the retained maximum Ozi pilot; do not repeat it.');
  const raw = pltHeader + Array.from({length: 2000}, (_, index) => '0,0,' + (index % 2 === 0 ? '1' : '0') + ',,,,').join('\n');
  const started = performance.now(), result = await readOziFile(input(raw, 'maximum.plt')), saved = project(result);
  assert.equal(result.report.counts.positions, 2000);assert.equal(result.report.counts.segments, 1000);
  assert.equal(result.report.counts.features, 1000);assert.equal(result.report.rejectedRecords.length, 0);
  assert(result.geojson.features.every(feature => feature.geometry.type === 'LineString' && feature.properties.ozi.points.length === 2));
  const reopened = readBrowserProjectFile(saved);
  assert.equal(reopened.layers[0].geojson.features.length, 1000);
  assert.deepEqual((await originalOziFile(reopened.layers[0].metadata.source)).bytes, new TextEncoder().encode(raw));
  await writeFile(target, JSON.stringify({status: 'passed-maximum-PLT-and-Project-reopen', positions: 2000, segments: 1000,
    inputBytes: Buffer.byteLength(raw), outputBytes: Buffer.byteLength(JSON.stringify(result)), projectBytes: Buffer.byteLength(saved),
    milliseconds: performance.now() - started, AWS: 0, accountAPI: 0, provider: 0}, null, 2) + '\n');
});

// Reuse the retained exact-manifest peer; the only network responses are local build bytes.
async function checkOziBrowser() {
  const {chromium} = await import('playwright');
  const {resolve, dirname, extname} = await import('node:path');
  const {mkdir, rename} = await import('node:fs/promises');
  const dist = resolve(process.env.OPEN_GEO_OZI_DIST), area = dirname(dirname(dist)), output = resolve(area, '../compiled-browser'), target = resolve(output, 'receipt.json');
  assert(!existsSync(target), 'Reuse the retained Ozi compiled receipt; do not repeat or overwrite it.');await mkdir(output, {recursive: true});
  const manifest = JSON.parse(await readFile(resolve(area, 'dist/opengeo-studio-build.json'))), files = new Map(manifest.artifactTree.files.map(file => [file.path, file]));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const module = name => '/' + manifest.artifactTree.files.find(file => file.path.startsWith('_import/' + name + '.') && file.path.endsWith('.js')).path;
  const entry = await readFile(resolve(dist, 'index.html'), 'utf8'), styles = [...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
  const html = `<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const receipt = {status: 'started', stage: 'launch', limits: {GETs: 300, bytes: 10485760, seconds: 45, originalDownloads: 1, ProjectDownloads: 1, personalSaves: 0, workingDownloads: 0, freshDocuments: 0}, GETs: 0, bytes: 0,
    originalDownloadAttempts: 0, originalDownloads: 0, ProjectDownloadAttempts: 0, ProjectDownloads: 0, personalSaves: 0, workingDownloads: 0, freshDocuments: 0, AWS: 0, accountAPI: 0, provider: 0, errors: [], themes: [], buildTree: manifest.artifactTree.digest};
  await writeFile(target, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
  let writes = Promise.resolve(), browser, server, page, guard;
  const persist = () => writes = writes.then(async () => {await writeFile(resolve(output, 'receipt.pending'), JSON.stringify(receipt, null, 2) + '\n');await rename(resolve(output, 'receipt.pending'), target);});
  const started = Date.now(), within = () => assert(Date.now() - started < receipt.limits.seconds * 1000, 'Ozi compiled time ceiling');
  const watchdog = setTimeout(() => {guard ??= Error('Ozi compiled time ceiling');receipt.watchdogExpired = true;void persist();void browser?.close().catch(() => {});void server?.close().catch(() => {});}, receipt.limits.seconds * 1000);
  try {
    server = await chromium.launchServer({headless: true, timeout: 10000, executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--opengeo-ozi-acceptance']});browser = await chromium.connect(server.wsEndpoint(), {timeout: 10000});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'block', acceptDownloads: true});
    await context.route('**/*', async route => {try {
      within();const url = new URL(route.request().url());if (['blob:', 'data:'].includes(url.protocol)) return route.continue();assert.equal(route.request().method(), 'GET');
      if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {receipt.optionalFontsAborted = (receipt.optionalFontsAborted ?? 0) + 1;return route.abort();}
      if (url.href === 'https://tiles.openfreemap.org/styles/positron') {receipt.blankBasemapSubstitutes = (receipt.blankBasemapSubstitutes ?? 0) + 1;return route.fulfill({contentType: 'application/json', body: JSON.stringify({version: 8, sources: {}, layers: [{id: 'background', type: 'background', paint: {'background-color': '#eef2f4'}}]})});}
      assert.equal(url.origin, 'https://compiled-ozi.test');assert(!url.pathname.startsWith('/api/'));
      if (url.pathname === '/') {
        assert(++receipt.GETs <= receipt.limits.GETs);receipt.bytes += Buffer.byteLength(html);assert(receipt.bytes <= receipt.limits.bytes);await persist();
        return route.fulfill({contentType: 'text/html', body: html});
      }
      const file = files.get(decodeURIComponent(url.pathname).slice(1));assert(file, 'Unexpected software ' + url.pathname);
      assert(++receipt.GETs <= receipt.limits.GETs);receipt.bytes += file.bytes;assert(receipt.bytes <= receipt.limits.bytes);await persist();
      const body = await readFile(resolve(dist, file.path));assert.equal(body.length, file.bytes);assert.equal(hash(body), file.sha256);
      return route.fulfill({body, contentType: ({'.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.pbf': 'application/octet-stream'})[extname(file.path)] ?? 'application/octet-stream'});
    } catch (error) {guard ??= error;receipt.guardFailure = error.message;await persist();await route.abort().catch(() => {});}});
    page = await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror', error => receipt.errors.push(error.message));
    await page.goto('https://compiled-ozi.test/');await page.locator('.start-empty-map').click();
    await page.waitForFunction(() => document.querySelector('.opengeo-workbench')?.__opengeoMap?.isStyleLoaded?.());
    const expected = [await readOziFile(input()), await readOziFile(input(trackBytes, 'source-track.plt'))], snapshots = [];
    const inspect = async (dialog, theme) => {
      await page.setViewportSize({width: 390, height: 844});
      const sample = await dialog.evaluate(root => {
        const anchor = [...root.querySelectorAll('dt')].find(node => node.textContent === 'OziExplorer records');
        root.scrollTop += anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
        const rgb = value => value.match(/[\d.]+/g).map(Number), luminance = color => color.slice(0, 3).map(value => {value /= 255;return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const background = rgb(getComputedStyle(root).backgroundColor), children = [...anchor.parentElement.children], nodes = [...children.slice(children.indexOf(anchor)), ...root.querySelectorAll('.source-confirmation, .source-confirmation span, button')];
        const samples = nodes.map(node => {const color = rgb(getComputedStyle(node).color), a = luminance(color), b = luminance(background);return {text: node.textContent.trim(), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), opaque: (color[3] ?? 1) === 1 && getComputedStyle(node).opacity === '1'};});
        const box = root.getBoundingClientRect(), top = Math.max(box.top + 1, anchor.getBoundingClientRect().top), bottom = Math.min(box.bottom - 1, innerHeight);
        return {samples, opaque: (background[3] ?? 1) === 1 && getComputedStyle(root).opacity === '1', noOverflow: box.left >= 0 && box.right <= innerWidth && root.scrollWidth <= root.clientWidth,
          checkboxWidths: [...root.querySelectorAll('input[type="checkbox"]')].map(node => node.getBoundingClientRect().width), clip: {x: box.left, y: top, width: box.width, height: bottom - top}};
      });
      assert(sample.opaque && sample.noOverflow);assert(sample.samples.every(value => value.opaque && value.ratio >= 4.5));assert(sample.checkboxWidths.every(width => width > 0 && width <= 32));assert(sample.clip.height > 0);
      await page.screenshot({path: resolve(output, `ozi-review-${theme}-390.png`), clip: sample.clip});receipt.themes.push({theme, ...sample});await persist();await page.setViewportSize({width: 1440, height: 1000});
    };
    for (const [index, theme] of ['light', 'dark'].entries()) {
      within();receipt.stage = theme + ' normal chooser and review';await persist();
      const themeButton = page.getByRole('button', {name: theme === 'light' ? 'Light' : 'Dark', exact: true});if (await themeButton.count()) await themeButton.first().click();
      const name = index === 0 ? 'source-waypoints.wpt' : 'source-track.plt', bytes = index === 0 ? waypointBytes : trackBytes, title = index === 0 ? 'Ozi waypoints' : 'Ozi tracks';
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', {name: 'Open file', exact: true}).click()]);await chooser.setFiles({name, mimeType: 'text/plain', buffer: bytes});
      const dialog = page.locator('.browser-layer-registration');await dialog.waitFor();assert((await dialog.innerText()).includes('OziExplorer records'));assert((await dialog.innerText()).includes('1 rejected'));
      await dialog.getByLabel('Layer title', {exact: true}).fill(title);await dialog.getByLabel('Description', {exact: true}).fill('Reviewed ' + name);
      await dialog.getByRole('button', {name: 'Add Layer to Project', exact: true}).click();assert.equal(await page.evaluate(() => document.querySelector('.opengeo-workbench').__opengeoLayers.length), index);
      await dialog.getByLabel('Add the valid positions and retain rejected records in the original file.', {exact: true}).check();await inspect(dialog, theme);
      if (index === 1) {
        receipt.stage = 'one original PLT download';assert(++receipt.originalDownloadAttempts <= receipt.limits.originalDownloads);await persist();
        const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', {name: 'Download original OziExplorer file', exact: true}).click()]);await download.saveAs(resolve(output, 'original.plt'));receipt.originalDownloads++;
        assert.equal(hash(await readFile(resolve(output, 'original.plt'))), hash(trackBytes));
      }
      receipt.stage = name + ' actual rendering';await persist();await dialog.getByRole('button', {name: 'Add Layer to Project', exact: true}).click();
      await page.waitForFunction(({title, types}) => {const shell = document.querySelector('.opengeo-workbench'), context = shell?.getPrintContext?.(), layer = context?.layers.find(layer => layer.title === title), map = context?.map;
        if (!context?.ready || !layer || !map.areTilesLoaded() || map.isMoving()) return false;
        const rendered = map.queryRenderedFeatures().filter(feature => feature.source === layer.layerId || String(feature.layer?.id).startsWith(layer.layerId + '-'));return types.every(type => rendered.some(feature => feature.geometry.type === type));
      }, {title, types: index === 0 ? ['Point'] : ['Point', 'LineString']});
      const snapshot = await page.evaluate(title => {const shell = document.querySelector('.opengeo-workbench'), context = shell.getPrintContext(), layer = context.layers.find(layer => layer.title === title);return {layer, data: shell.__opengeoData.get(layer.layerId), rendered: context.map.queryRenderedFeatures().filter(feature => feature.source === layer.layerId || String(feature.layer?.id).startsWith(layer.layerId + '-')).map(feature => ({id: feature.id, type: feature.geometry.type}))};}, title);
      assert.deepEqual(snapshot.data, expected[index].geojson);assert.deepEqual(snapshot.layer.metadata.source, expected[index].source);
      assert.equal(snapshot.layer.style.renderer, 'single');assert.equal(snapshot.layer.style.circleColor, '#06b6d4');assert.equal(snapshot.layer.style.stroke, '#06b6d4');assert.equal(snapshot.layer.metadata.curated.description, 'Reviewed ' + name);
      assert.equal(snapshot.layer.metadata.curated.coordinateReferenceMethod, 'source-header');assert.equal(snapshot.layer.metadata.curated.rejectedRecordPolicy, 'explicit-omit-original-retained');
      // Tile-query IDs can differ from source string IDs; source data and exported IDs are checked exactly above/below.
      assert(snapshot.rendered.every(feature => snapshot.data.features.some(source => source.geometry.type === feature.type)));snapshots.push(snapshot);receipt.layers = snapshots.map(value => ({layerId: value.layer.layerId, title: value.layer.title, rendered: value.rendered}));await persist();
    }
    receipt.stage = 'one normal Project export';assert(++receipt.ProjectDownloadAttempts <= receipt.limits.ProjectDownloads);await persist();await page.getByRole('button', {name: 'Save as', exact: true}).click();
    const exportDialog = page.getByRole('dialog').filter({has: page.getByLabel('Project export format', {exact: true})});await exportDialog.getByLabel('Project export format', {exact: true}).selectOption('opengeo');
    const [download] = await Promise.all([page.waitForEvent('download'), exportDialog.getByRole('button', {name: 'Export file', exact: true}).click()]);await download.saveAs(resolve(output, 'project.opengeo-project.json'));receipt.ProjectDownloads++;
    const saved = readBrowserProjectFile(await readFile(resolve(output, 'project.opengeo-project.json'), 'utf8'));assert.equal(saved.layers.length, 2);
    for (const snapshot of snapshots) {const layer = saved.layers.find(layer => layer.layerId === snapshot.layer.layerId);assert(layer);assert.deepEqual(layer.geojson, snapshot.data);assert.deepEqual(layer.metadata, snapshot.layer.metadata);assert.deepEqual(layer.style, snapshot.layer.style);}
    within();assert(!guard, guard?.message);assert.deepEqual(receipt.errors, []);receipt.status = 'passed-compiled-Ozi-chooser-mixed-render-original-Project-export-and-new-review-themes';
  } catch (error) {receipt.status = 'stopped';receipt.failure = error.message;throw error;}
  finally {
    clearTimeout(watchdog);await browser?.close().then(() => {receipt.browserClosed = true;}).catch(error => {receipt.browserCleanupError = error.message;});
    await server?.close().then(() => {receipt.serverClosed = true;}).catch(error => {receipt.serverCleanupError = error.message;});receipt.milliseconds = Date.now() - started;await persist();
  }
}
