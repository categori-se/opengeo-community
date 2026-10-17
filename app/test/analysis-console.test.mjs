import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {ANALYSIS_CONSOLE_LIMITS, analysisWorkerMain, analysisSandboxDocument, normalizeAnalysisResult,
  snapshotAnalysisLayers, validateAnalysisGeoJSON, validateAnalysisSource} from '../src/lib/analysisConsole.js';
import {AnalysisConsole} from '../src/components/AnalysisConsole.js';
import {publicationLanguage} from '../src/components/PublicationCodeEditor.js';

const collection = () => ({type: 'FeatureCollection', features: [{type: 'Feature', id: 'p', properties: {name: '<img src=x onerror=alert(1)>'}, geometry: {type: 'Point', coordinates: [85, 28]}}]});
const rows = () => [{id: 'a', title: 'Explicit input', visible: true, geojson: collection(), sourceUrl: 'https://private.invalid', bearer: 'never-copy', inputPin: {sourceVersion: 4, digest: 'frozen'}}];
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('selected snapshots exclude Layer connections and preserve immutable host pins', () => {
  const original = rows(), snapshot = snapshotAnalysisLayers(original);
  assert.deepEqual(Object.keys(snapshot.layers[0]), ['id', 'title', 'geojson']);
  assert.equal(JSON.stringify(snapshot.layers).includes('never-copy'), false);
  assert.equal(JSON.stringify(snapshot.layers).includes('sourceVersion'), false);
  original[0].geojson.features[0].properties.name = 'changed';original[0].inputPin.digest = 'changed';
  assert.match(snapshot.layers[0].geojson.features[0].properties.name, /<img/);
  assert.equal(snapshot.inputPins[0].inputPin.digest, 'frozen');
  assert.equal(Object.isFrozen(snapshot.inputPins[0].inputPin), true);
  assert.throws(() => snapshotAnalysisLayers([...rows(), ...rows()]), /unique/);
  assert.throws(() => snapshotAnalysisLayers(Array.from({length: 17}, (_, i) => ({...rows()[0], id: String(i)}))), /at most 16/);
});

test('closed GeoJSON and execution bounds reject malformed or oversized content', () => {
  const invalid = collection();invalid.features[0].geometry.coordinates = [Infinity, 2];
  assert.throws(() => validateAnalysisGeoJSON(invalid), /finite WGS/);
  assert.throws(() => validateAnalysisGeoJSON({type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {type: 'HTML', coordinates: []}}]}), /unsupported/);
  assert.throws(() => validateAnalysisGeoJSON({type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1]]]}), /closed/);
  assert.throws(() => validateAnalysisSource('x'.repeat(ANALYSIS_CONSOLE_LIMITS.sourceBytes + 1)), /64 KiB/);
  assert.throws(() => normalizeAnalysisResult({stdout: 'x'.repeat(ANALYSIS_CONSOLE_LIMITS.outputBytes + 1)}), /128 KiB/);
  assert.throws(() => validateAnalysisGeoJSON(collection(), 5), /byte limit/);
  assert.equal(normalizeAnalysisResult({execution: {exitCode: 7}}).exitCode, 7);
  assert.throws(() => normalizeAnalysisResult({stdout: {html: '<script>'}}), /Invalid execution/);
});

test('worker executes real asynchronous JavaScript and emits bounded output', async () => {
  const messages = [], context = vm.createContext({self: {postMessage: message => messages.push(structuredClone(message))}, TextEncoder});
  vm.runInContext('(' + analysisWorkerMain.toString() + ')()', context);
  await context.self.onmessage({data: {code: 'const values = await Promise.resolve([2, 3, 5].map(x => x * x)); console.log(values.reduce((a,b) => a+b)); opengeo.emit(opengeo.layers[0].geojson);', layers: snapshotAnalysisLayers(rows()).layers}});
  assert.equal(messages[0].text, '38\n');assert.equal(messages[1].kind, 'result');assert.equal(messages.at(-1).kind, 'done');
  assert.equal(validateAnalysisGeoJSON(JSON.parse(JSON.stringify(messages[1].geojson))).features.length, 1);
  const overflow = [], second = vm.createContext({self: {postMessage: message => overflow.push(message)}, TextEncoder});
  vm.runInContext('(' + analysisWorkerMain.toString() + ')()', second);
  await second.self.onmessage({data: {code: 'console.log("x".repeat(131073))', layers: []}});
  assert.equal(overflow[0].kind, 'error');assert.match(overflow[0].message, /128 KiB/);
});

test('sandbox has no network, same-origin grant, or user source interpolation', () => {
  const html = analysisSandboxDocument();assert.match(html, /default-src 'none'/);assert.match(html, /connect-src 'none'/);
  assert.match(html, /worker-src blob:/);assert.match(html, /event.source !== parent/);assert.match(html, /event.ports.length !== 1/);
  assert.equal(html.includes('allow-same-origin'), false);assert.equal(html.includes('private.invalid'), false);
  assert.equal(publicationLanguage('analysis.py'), 'python');assert.equal(publicationLanguage('analysis.sh'), 'shell');
});

function ui(options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');const prior = globalThis.document;globalThis.document = dom.window.document;
  const consoleUI = AnalysisConsole({getLayers: rows, ...options});document.body.append(consoleUI.element);
  return {dom, consoleUI, get: label => consoleUI.element.querySelector(`[aria-label="${label}"]`),
    button: text => [...consoleUI.element.querySelectorAll('button')].find(value => value.textContent === text),
    clean() {consoleUI.dispose();globalThis.document = prior;dom.window.close();}};
}
test('opening never queries runtimes; local/managed are explicit and preserve buffers', async () => {
  let localChecks = 0, managedChecks = 0;
  const u = ui({runNative: async () => ({}), getNativeCapabilities: async () => {localChecks++;return {configured: true, languages: ['python']};},
    getManagedCapabilities: async () => {managedChecks++;return {configured: false, languages: []};}});
  try {
    u.consoleUI.open();assert.equal(localChecks + managedChecks, 0);
    assert.equal(u.consoleUI.element.querySelector('input[type=checkbox]').checked, false);
    u.get('Analysis script').value = 'print("retained")';u.get('Analysis script').dispatchEvent(new u.dom.window.Event('input'));
    u.consoleUI.close();u.consoleUI.open();assert.equal(u.get('Analysis script').value, 'print("retained")');assert.equal(localChecks, 0);
    u.get('Script language').value = 'python';u.get('Script language').dispatchEvent(new u.dom.window.Event('change'));
    assert.equal(u.button('Run').disabled, true);
    u.get('Execution profile').value = 'local';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    assert.equal(localChecks, 1);assert.equal(u.button('Run').disabled, false);
    u.get('Execution profile').value = 'managed';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    assert.equal(managedChecks, 1);assert.equal(u.button('Run').disabled, true);
  } finally {u.clean();}
});

test('local execution passes only selected data and Add to map requires its own click', async () => {
  const calls = [], additions = [];
  const u = ui({getNativeCapabilities: async () => ({configured: true, languages: ['javascript']}),
    runNative: async input => {calls.push(input);return {stdout: '<img src=x>', geojson: collection(), execution: {profile: 'spoofed', exitCode: 0}};},
    onResult: result => additions.push(result)});
  try {
    u.consoleUI.open();u.get('Execution profile').value = 'local';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    const check = u.consoleUI.element.querySelector('input[type=checkbox]');check.checked = true;check.dispatchEvent(new u.dom.window.Event('change'));
    u.button('Run').click();await turn();
    assert.equal(calls.length, 1);assert.deepEqual(Object.keys(calls[0].layers[0]), ['id', 'title', 'geojson']);
    assert.equal(additions.length, 0);assert.equal(u.get('Script output').querySelector('img'), null);
    assert.equal(u.get('Script output').textContent, '<img src=x>');
    u.button('Add result to map').click();await turn();assert.equal(additions.length, 1);
    assert.equal(additions[0].execution.profile, 'local');assert.equal(additions[0].inputPins[0].inputPin.sourceVersion, 4);
  } finally {u.clean();}
});

test('close cancels running work and rejects its late result', async () => {
  let resolve, signal, additions = 0;
  const u = ui({getNativeCapabilities: async () => ({configured: true, languages: ['javascript']}),
    runNative: input => {signal = input.signal;return new Promise(done => {resolve = done;});}, onResult: () => {additions++;}});
  try {
    u.consoleUI.open();u.get('Execution profile').value = 'local';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    u.button('Run').click();await turn();u.consoleUI.close();assert.equal(signal.aborted, true);
    resolve({geojson: collection(), stdout: ''});await turn();u.consoleUI.open();
    assert.equal(u.button('Add result to map').hidden, true);assert.equal(additions, 0);
  } finally {u.clean();}
});

test('an explicitly configured managed callback runs and failed exits cannot add results', async () => {
  let runs = 0;
  const u = ui({getManagedCapabilities: async () => ({configured: true, languages: ['python']}),
    runManaged: async ({language, signal}) => {runs++;assert.equal(language, 'python');assert.equal(signal.aborted, false);
      return {stdout: 'failed', geojson: collection(), execution: {exitCode: 3}};}});
  try {
    u.consoleUI.open();u.get('Script language').value = 'python';u.get('Script language').dispatchEvent(new u.dom.window.Event('change'));
    u.get('Execution profile').value = 'managed';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    assert.equal(u.button('Run').disabled, false);u.button('Run').click();await turn();
    assert.equal(runs, 1);assert.match(u.consoleUI.element.querySelector('[role=status]').textContent, /code 3/);
    assert.equal(u.button('Add result to map').hidden, true);
  } finally {u.clean();}
});

test('managed Stop keeps Run locked until cleanup acknowledges and exposes uncertain cancellation', async () => {
  let reject, request;
  const u = ui({getManagedCapabilities: async () => ({configured: true, languages: ['javascript']}),
    runManaged: input => {request = input;return new Promise((_done, fail) => {reject = fail;});}});
  try {
    u.consoleUI.open();u.get('Execution profile').value = 'managed';u.get('Execution profile').dispatchEvent(new u.dom.window.Event('change'));await turn();
    const checkbox = u.consoleUI.element.querySelector('input[type=checkbox]');checkbox.checked = true;checkbox.dispatchEvent(new u.dom.window.Event('change'));
    u.button('Run').click();await turn();assert.equal(request.inputPins[0].inputPin.sourceVersion, 4);
    assert.equal(Object.hasOwn(request.layers[0], 'inputPin'), false);
    u.button('Stop').click();assert.equal(request.signal.aborted, true);assert.equal(u.button('Run').disabled, true);
    const error = Error('Cancellation could not be confirmed.');error.cancellationUncertain = true;reject(error);await turn();
    assert.match(u.consoleUI.element.querySelector('[role=status]').textContent, /could not be confirmed/);
    assert.equal(u.button('Run').disabled, false);assert.equal(u.button('Add result to map').hidden, true);
  } finally {u.clean();}
});
