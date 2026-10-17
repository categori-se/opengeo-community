import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {createLocalAnalysisBridge, loadLocalAnalysisRunner} from '../scripts/integrated-studio-analysis-runner.mjs';

const origin = 'http://127.0.0.1:9999';
const capabilities = {enabled: true, limits: {timeoutSeconds: 10}};
function exchange({method = 'POST', headers = {}, body} = {}) {
  const request = new PassThrough();
  request.method = method;
  request.headers = {host: '127.0.0.1:9999', origin, 'content-type': 'application/json', ...headers};
  const response = new EventEmitter();
  response.headers = {};response.destroyed = false;response.writableEnded = false;
  response.setHeader = (key, value) => {response.headers[key] = value;return response;};
  response.writeHead = (status, values) => {response.status = status;Object.assign(response.headers, values);return response;};
  response.end = value => {response.body = value;response.writableEnded = true;response.emit('finish');return response;};
  if (body !== undefined) setImmediate(() => request.end(typeof body === 'string' ? body : JSON.stringify(body)));
  return {request, response};
}
test('local profile loading defaults off and accepts only a private operator-staged profile', async () => {
  const work = await mkdtemp(join(tmpdir(), 'opengeo-analysis-bridge-'));
  try {
    assert.equal(loadLocalAnalysisRunner(work).capabilities().enabled, false);
    const path = join(work, 'analysis-profile.json');
    await writeFile(path, JSON.stringify({enabled: true, profiles: {python: {
      image: `sha256:${'a'.repeat(64)}`, interpreter: '/usr/bin/python3'}}}), {mode: 0o600});
    assert.equal(loadLocalAnalysisRunner(work).capabilities().enabled, true);
    await chmod(path, 0o644);
    assert.throws(() => loadLocalAnalysisRunner(work), {code: 'analysis_configuration_invalid'});
  } finally {await rm(work, {recursive: true, force: true});}
});
test('capabilities and execution enforce the exact local host, origin and methods', async () => {
  const bridge = createLocalAnalysisBridge({origin, runner: {capabilities: () => capabilities}});
  for (const [path, options, status] of [
    ['/__local/analysis/capabilities', {method: 'GET', headers: {origin: undefined}}, 200],
    ['/__local/analysis/capabilities', {method: 'GET', headers: {host: 'localhost:9999'}}, 403],
    ['/__local/analysis/capabilities', {method: 'GET', headers: {origin: 'https://other.invalid'}}, 403],
    ['/__local/analysis/run', {headers: {origin: undefined}}, 403],
    ['/__local/analysis/run', {method: 'GET'}, 405]
  ]) {
    const {request, response} = exchange(options);
    assert.equal(await bridge(request, response, path), true);assert.equal(response.status, status);
  }
});
test('run forwards only code and selected layers to the real runner contract without browser credentials', async () => {
  const result = {stdout: 'actual output', stderr: '', geojson: null, execution: {exitCode: 0}};
  let received;
  const bridge = createLocalAnalysisBridge({origin, runner: {capabilities: () => capabilities, run: async input => {received = input;return result;}}});
  const body = {language: 'python', code: "print('actual output')", layers: []};
  const {request, response} = exchange({body, headers: {authorization: 'not-forwarded', cookie: 'not-forwarded'}});
  await bridge(request, response, '/__local/analysis/run');
  assert.equal(response.status, 200);assert.deepEqual(JSON.parse(response.body), result);
  assert.deepEqual({...received, signal: undefined}, {...body, signal: undefined});
  assert.ok(received.signal instanceof AbortSignal);
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('oversize and invalid execution bodies close without launching or exposing diagnostic details', async () => {
  let runs = 0;
  const bridge = createLocalAnalysisBridge({origin, runner: {capabilities: () => capabilities, run: async () => {runs++;throw Error('private path');}}});
  for (const [options, status] of [
    [{headers: {'content-length': String(17 * 1024 * 1024 + 1)}}, 413],
    [{body: 'x'.repeat(17 * 1024 * 1024 + 1)}, 413],
    [{body: {language: 'python', code: 'pass', layers: [], image: 'untrusted'}}, 400],
    [{body: 'invalid json'}, 400],
    [{body: {language: 'python', code: 'pass', layers: []}}, 500]
  ]) {
    const {request, response} = exchange(options);
    await bridge(request, response, '/__local/analysis/run');
    assert.equal(response.status, status);assert.doesNotMatch(response.body, /private path|stack/);
  }
  assert.equal(runs, 1);
});
test('disconnect aborts the runner and waits for its cancellation cleanup promise', async () => {
  let began, cleaned = false;
  const started = new Promise(resolve => {began = resolve;});
  const bridge = createLocalAnalysisBridge({origin, runner: {capabilities: () => capabilities,
    run: ({signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {cleaned = true;reject(Object.assign(Error(), {code: 'analysis_cancelled'}));}, {once: true});
      began();
    })}});
  const {request, response} = exchange({body: {language: 'bash', code: 'sleep 2', layers: []}});
  const running = bridge(request, response, '/__local/analysis/run');
  await started;response.destroyed = true;response.emit('close');await running;
  assert.equal(cleaned, true);assert.equal(response.writableEnded, false);
});
