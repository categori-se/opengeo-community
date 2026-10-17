import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalAnalysisRuntime} from '../src/lib/analysisLocalRuntime.js';

const loopback = new URL('http://127.0.0.1:3000/workspaces');
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
test('constructing the adapter performs no I/O; non-loopback origins cannot request a local runtime', async () => {
  let requests = 0;const fetch = async () => {requests++;throw Error('No external requests');};
  for (const origin of ['https://studio.opengeo.tools', 'http://localhost.attacker.invalid', 'http://127.0.0.1.attacker.invalid', 'https://localhost', 'file:///tmp/map.html']) {
    const runtime = createLocalAnalysisRuntime({location: new URL(origin), fetch});assert.equal(requests, 0);
    assert.deepEqual(await runtime.getNativeCapabilities(), {configured: false, languages: []});
    await assert.rejects(runtime.runNative({language: 'python', code: 'print(1)', layers: []}), /local development/);
    assert.equal(requests, 0);
  }
});

test('explicit capabilities use only the exact same-origin GET with no credentials or redirects', async () => {
  let calls = 0;
  const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async (url, options) => {
    calls++;assert.equal(url.href, loopback.origin + '/__local/analysis/capabilities');
    assert.equal(options.method, 'GET');assert.equal(options.body, undefined);assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');assert.equal(options.cache, 'no-store');
    return json({enabled: true, cleanupRequired: false, languages: [{language: 'python', configured: true}, {language: 'bash', configured: false}]});
  }});
  assert.equal(calls, 0);assert.deepEqual(await runtime.getNativeCapabilities(), {configured: true, languages: ['python']});assert.equal(calls, 1);
});

test('run POST contains only language, code and selected snapshots, without ambient credentials', async () => {
  const layers = [{id: 'selected', title: 'Selected', geojson: {type: 'FeatureCollection', features: []}}];let calls = 0;
  const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async (url, options) => {
    calls++;assert.equal(url.href, loopback.origin + '/__local/analysis/run');assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {language: 'python', code: 'print(1)', layers});
    assert.deepEqual(options.headers, {'Content-Type': 'application/json'});assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');return json({stdout: '1', stderr: '', geojson: null, execution: {exitCode: 0}});
  }});
  const result = await runtime.runNative({language: 'python', code: 'print(1)', layers, bearer: 'never-forward', inputPins: [{id: 'host-only'}]});
  assert.equal(result.stdout, '1');assert.equal(calls, 1);
});

test('caller cancellation reaches the request without a retry', async () => {
  let calls = 0, requestSignal;
  const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async (_url, {signal}) => {
    calls++;requestSignal = signal;return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  }});
  const controller = new AbortController(), pending = runtime.runNative({language: 'bash', code: 'sleep 20', layers: [], signal: controller.signal});
  controller.abort(new DOMException('Stopped', 'AbortError'));await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(requestSignal.aborted, true);assert.equal(calls, 1);
});

test('oversized response is cancelled and rejected at the client byte ceiling', async () => {
  let cancelled = false, calls = 0;
  const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async () => {
    calls++;return new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(10 * 1024 ** 2 + 1));}, cancel() {cancelled = true;}}));
  }});
  await assert.rejects(runtime.runNative({language: 'python', code: 'print(1)', layers: []}), /console limit/);
  assert.equal(cancelled, true);assert.equal(calls, 1);
});

test('unconfigured, cleanup-required and malformed capabilities fail closed', async () => {
  for (const body of [{enabled: true, cleanupRequired: true, languages: []}, {enabled: false, languages: []}, {enabled: true, languages: {}}]) {
    const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async () => json(body)});
    assert.equal((await runtime.getNativeCapabilities()).configured, false);
  }
  const runtime = createLocalAnalysisRuntime({location: loopback, fetch: async () => new Response('missing', {status: 404})});
  await assert.rejects(runtime.runNative({language: 'python', code: 'print(1)', layers: []}), /not configured/);
});
