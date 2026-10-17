import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {createManagedAnalysisRuntime} from '../src/lib/analysisManagedRuntime.js';

const project = '10000000-0000-4000-8000-000000000001', organization = '20000000-0000-4000-8000-000000000002';
const id = '30000000-0000-4000-8000-000000000003', dataset = '40000000-0000-4000-8000-000000000004';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const geojson = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [1, 2]}}]};
function fixture({wait = async () => {}, createUnknown = false, dispatchPending = false, checksumWrong = false,
  cleanupRequired = false, terminalCleanupRequired = false, cancelPendingReads = 0, pending = false} = {}) {
  const calls = [], objects = [];let record, token = 'original-token', account = organization;
  const payload = JSON.stringify({stdout: 'one feature', stderr: '', geojson,
    execution: {exitCode: 0, cleanup: {containerRemoved: true, stagingRemoved: true}}});
  const checksum = createHash('sha256').update(payload).digest('hex');let submits = 0, cancels = 0;
  const apiFetch = async (url, options) => {
    const path = new URL(url).pathname, method = options.method;
    calls.push({path, method, body: options.body && JSON.parse(options.body), token: options.headers.get('authorization'),
      account: options.headers.get('X-OpenGeo-Organization')});
    assert.equal(options.credentials, 'omit');assert.equal(options.redirect, 'error');
    if (path.endsWith('/capabilities')) return json({configured: true, available: true, can_submit: true, languages: ['python']});
    if (path.endsWith('/jobs') && method === 'POST') {
      const descriptor = JSON.parse(options.body);
      record = {job_id: id, request_key: descriptor.request_key, state: 'awaiting_upload', result_available: false,
        cleanup_required: false, upload: {method: 'POST', url: 'https://objects.example.test/input', fields: {key: 'immutable-input', 'x-amz-checksum-sha256': 'bound'}}};
      if (createUnknown) throw Error('Response lost after committed create');return json(record);
    }
    if (path.endsWith('/jobs') && method === 'GET') return record ? json(record) : json({detail: 'analysis_not_found'}, 404);
    if (path.endsWith('/submit')) {
      submits++;record = {...record, state: dispatchPending && submits === 1 ? 'dispatch_pending' : pending ? 'running' : terminalCleanupRequired ? 'failed' : 'succeeded',
        cleanup_required: terminalCleanupRequired, result_available: !pending && !terminalCleanupRequired && !(dispatchPending && submits === 1)};return json(record);
    }
    if (path.endsWith('/cancel')) {cancels++;record = {...record, state: cancels <= cancelPendingReads ? 'cancel_requested' : 'cancelled',
      cleanup_required: cleanupRequired || cancels <= cancelPendingReads};return json(record);}
    if (path.endsWith('/result')) return json({method: 'GET', url: 'https://objects.example.test/result', size_bytes: Buffer.byteLength(payload),
      checksum_sha256: checksumWrong ? 'a'.repeat(64) : checksum});
    if (path.endsWith('/' + id)) return json(record);
    throw Error('Unexpected API path ' + path);
  };
  const objectFetch = async (url, options) => {
    objects.push({url, options});assert.equal(options.credentials, 'omit');assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    if (options.method === 'POST') {assert.equal(options.body.get('key'), 'immutable-input');return new Response(null, {status: 204});}
    return new Response(payload);
  };
  const adapter = {baseUrl: 'https://api.example.test/api', request() {}, fetchImplementation: apiFetch,
    tokenProvider: () => token, organizationProvider: () => account};
  const runtime = createManagedAnalysisRuntime({adapter, projectId: project, organizationId: organization,
    fetch: objectFetch, crypto: webcrypto, wait});
  return {runtime, calls, objects, adapter, changeScope() {token = 'different-token';account = dataset;}};
}
const input = () => ({language: 'python', code: 'print(1)', layers: [{id: 'selected', title: 'Selected', geojson,
  token: 'never-copy', sourceUrl: 'https://private.invalid'}], inputPins: [{id: 'selected', inputPin: {datasetId: dataset,
    sourceVersion: 1, featureGeneration: 1, connectionToken: 'never-copy'}}]});

test('construction and read-only capabilities allocate no job or transfer', async () => {
  const f = fixture();assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.runtime.getManagedCapabilities(), {configured: true, languages: ['python']});
  assert.equal(f.calls.length, 1);assert.ok(f.calls[0].path.endsWith('/capabilities'));assert.equal(f.objects.length, 0);
});

test('actual API client sends a small descriptor; signed transfer has no API identity and verifies result bytes', async () => {
  const f = fixture(), result = await f.runtime.runManaged(input());
  assert.equal(result.geojson.features.length, 1);assert.equal(result.stdout, 'one feature');
  const create = f.calls.find(call => call.method === 'POST' && call.path.endsWith('/jobs'));
  assert.equal(create.token, 'Bearer original-token');assert.equal(create.account, organization);
  assert.deepEqual(create.body.layer_ids, ['selected']);
  assert.deepEqual(create.body.source_bindings, [{layer_id: 'selected', dataset_id: dataset, source_version: 1, feature_generation: 1}]);
  assert.equal(JSON.stringify(create.body).includes('print(1)'), false);assert.equal(JSON.stringify(create.body).includes('never-copy'), false);
  const bytes = Buffer.from(await f.objects[0].options.body.get('file').arrayBuffer());
  assert.equal(bytes.byteLength, create.body.snapshot.size_bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), create.body.snapshot.checksum_sha256);
  const snapshot = JSON.parse(bytes.toString());assert.deepEqual(Object.keys(snapshot.layers[0]), ['id', 'title', 'geojson']);
  assert.equal(JSON.stringify(snapshot).includes('never-copy'), false);assert.equal(JSON.stringify(snapshot).includes('sourceVersion'), false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/submit')).length, 1);assert.equal(f.objects.length, 2);
});

test('uncertain committed create uses one lookup and never repeats the job write', async () => {
  const f = fixture({createUnknown: true});await f.runtime.runManaged(input());
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/jobs')).length, 1);
  assert.equal(f.calls.filter(call => call.method === 'GET' && call.path.endsWith('/jobs')).length, 1);
});

test('unknown dispatch waits for an explicit same-job Run; input snapshot is uploaded only once', async () => {
  const f = fixture({dispatchPending: true});await assert.rejects(f.runtime.runManaged(input()), /Press Run again/);
  await f.runtime.runManaged(input());
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/jobs')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/submit')).length, 2);
  assert.equal(f.objects.filter(call => call.options.method === 'POST').length, 1);
});

test('a retained uncertain dispatch can be stopped without starting or uploading another run', async () => {
  const f = fixture({dispatchPending: true});await assert.rejects(f.runtime.runManaged(input()), /Press Run again/);
  assert.equal(f.runtime.hasPendingManagedRun(), true);await f.runtime.cancelManaged();
  assert.equal(f.runtime.hasPendingManagedRun(), false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/submit')).length, 1);
  assert.equal(f.objects.filter(call => call.options.method === 'POST').length, 1);
});

test('bad result checksum cannot admit a Layer or start a replacement computation on retry', async () => {
  const f = fixture({checksumWrong: true});
  await assert.rejects(f.runtime.runManaged(input()), /checksum/);
  await assert.rejects(f.runtime.runManaged(input()), /checksum/);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/jobs')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/submit')).length, 1);
});

test('Stop cancels with the original account after the current account changes', async () => {
  const controller = new AbortController();let f;
  f = fixture({pending: true, wait: async (_milliseconds, signal) => {f.changeScope();controller.abort();signal.throwIfAborted();}});
  await assert.rejects(f.runtime.runManaged({...input(), signal: controller.signal}), {name: 'AbortError'});
  const cancel = f.calls.find(call => call.path.endsWith('/cancel'));
  assert.equal(cancel.account, organization);assert.equal(cancel.token, 'Bearer original-token');
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
});

test('a terminal job with unconfirmed native cleanup reports uncertainty rather than Stopped', async () => {
  const controller = new AbortController();
  const f = fixture({pending: true, cleanupRequired: true, wait: async (_milliseconds, signal) => {controller.abort();signal.throwIfAborted();}});
  await assert.rejects(f.runtime.runManaged({...input(), signal: controller.signal}), error => error.cancellationUncertain === true);
});

test('normal terminal status retains the uncertain job and Stop action until cleanup is confirmed', async () => {
  const f = fixture({terminalCleanupRequired: true});
  await assert.rejects(f.runtime.runManaged(input()), error => error.cancellationUncertain === true);
  assert.equal(f.runtime.hasPendingManagedRun(), true);
  await f.runtime.cancelManaged();assert.equal(f.runtime.hasPendingManagedRun(), false);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/jobs')).length, 1);
});

test('cleanup confirmation uses revocation-safe cancellation status with the original identity', async () => {
  const controller = new AbortController();let f;
  f = fixture({pending: true, cancelPendingReads: 2, wait: async (_milliseconds, signal) => {
    if (!controller.signal.aborted) {f.changeScope();controller.abort();signal.throwIfAborted();}
  }});
  await assert.rejects(f.runtime.runManaged({...input(), signal: controller.signal}), {name: 'AbortError'});
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 3);
  assert.equal(f.calls.filter(call => call.path.endsWith('/' + id)).length, 0);
  for (const call of f.calls) assert.equal(call.token, 'Bearer original-token');
});
