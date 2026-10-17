import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ANALYSIS_LIMITS} from '../../observable-coordinator/src/analysis-runner.mjs';
import {AwsSigV4Client} from '../../observable-coordinator/src/aws-sigv4.mjs';
import {AnalysisCoordinator, AwsAnalysisStorage, RdsAnalysisRepository} from '../src/coordinator.mjs';
import {LIMITS, parseCommand, sha256} from '../src/contracts.mjs';
import {AnalysisRuntimeSettings, AwsAnalysisQueue, parseProfileEnvelope, runAnalysisQueue} from '../src/runtime.mjs';

const job = '11111111-1111-4111-8111-111111111111';
const org = '22222222-2222-4222-8222-222222222222';
const project = '33333333-3333-4333-8333-333333333333';
const actor = '44444444-4444-4444-8444-444444444444';
const windowId = '55555555-5555-4555-8555-555555555555';
const bucket = 'opengeo-analysis-fixture';
const key = `organizations/${org}/projects/${project}/analysis/${job}/`;
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const profiles = {python: {image: `sha256:${'a'.repeat(64)}`, interpreter: '/usr/bin/python3', architecture, timeout_seconds: 10, memory_mib: 256}};
const binding = {window_id: windowId, stack_id: `arn:aws:cloudformation:us-east-1:123456789012:stack/Analysis/${windowId}`, profiles_sha256: 'b'.repeat(64)};
const geojson = {type: 'FeatureCollection', features: [{type: 'Feature', geometry: {type: 'Point', coordinates: [85, 27]}, properties: {value: 2}}]};
function fixture({stageState = 'running', heartbeatState = 'running', complete = true, run, read} = {}) {
  const snapshot = {schemaVersion: 'opengeo.analysis.snapshot.1', language: 'python', code: 'print(2)', layers: [{id: 'layer-a', title: 'Selected', geojson}]};
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const manifest = {schemaVersion: 'opengeo.analysis.manifest.1', job_id: job, organization_id: org, project_id: project, requestor_id: actor,
    language: 'python', layer_ids: ['layer-a'], source_bindings: [], input: {bucket, key: key + 'snapshot.json', version_id: 'version-1',
      size_bytes: bytes.length, checksum_sha256: sha256(bytes)}, profile: profiles.python, output: {bucket, key: key + 'result.json'}};
  const calls = [];
  const repository = {
    async claim(id, token) {calls.push('claim');const text = JSON.stringify(manifest);return {state: 'claimed', job_id: id, lease_token: token,
      manifest_json: text, manifest_sha256: sha256(text), attempt_count: 1, runtime: binding};},
    async stage() {calls.push('stage');return {state: stageState};},
    async heartbeat() {calls.push('heartbeat');return {state: heartbeatState};},
    async complete(_id, _token, descriptor, receipt) {calls.push('complete');this.descriptor = descriptor;this.receipt = receipt;return complete;},
    async fail(_id, _token, code, cleanup) {calls.push('fail');this.error = {code, cleanup};return true;}
  };
  const storage = {async readSnapshot() {calls.push('read');return read ? read(bytes) : bytes;},
    async writeResult(output, result) {calls.push('write');this.result = JSON.parse(result);return {...output, version_id: 'result-1', size_bytes: result.length, checksum_sha256: sha256(result)};}};
  const factory = options => ({async run(input) {
    calls.push('run');factory.options = options;factory.input = input;
    if (run) return run(input);
    return {stdout: '2\n', stderr: '', geojson, execution: {language: 'python', runtimeImage: profiles.python.image,
      interpreter: profiles.python.interpreter, exitCode: 0, signal: null, durationMs: 12, codeSha256: sha256(snapshot.code),
      inputSha256: [{id: 'layer-a', checksumSha256: sha256(JSON.stringify(geojson))}], limits: ANALYSIS_LIMITS,
      cleanup: {containerRemoved: true, stagingRemoved: true}, network: 'none'}};
  }});
  const coordinator = new AnalysisCoordinator({enabled: true, bucket, profiles, binding, repository, storage, runnerFactory: factory, heartbeatMilliseconds: 10});
  return {coordinator, repository, storage, factory, calls, snapshot, manifest, bytes};
}

test('trusted staging verifies exact snapshot and reauthorizes before running and immutable commit', async () => {
  const f = fixture();
  assert.deepEqual(await f.coordinator.run(job), {state: 'succeeded', job_id: job, acknowledge: true});
  assert.deepEqual(f.calls, ['claim', 'read', 'stage', 'run', 'heartbeat', 'write', 'complete']);
  assert.deepEqual(Object.keys(f.factory.input).sort(), ['code', 'language', 'layers', 'signal']);
  assert.equal(f.factory.options.profiles.python.image, profiles.python.image);
  assert.equal(f.storage.result.execution.inputCustody, 'user-provided-snapshot');
  assert.equal(JSON.stringify(f.storage.result).includes('s3://'), false);
  assert.equal(JSON.stringify(f.storage.result).includes(key), false);
  assert.equal(f.repository.descriptor.key, key + 'result.json');
});
test('mismatched content, runtime binding or revoked source authority never starts user code', async () => {
  for (const setup of [
    () => fixture({read: () => Buffer.from('{}')}),
    () => {const f = fixture();f.coordinator.binding = {...binding, profiles_sha256: 'c'.repeat(64)};return f;},
    () => fixture({stageState: 'unauthorized'})
  ]) {
    const f = setup(), result = await f.coordinator.run(job);
    assert.equal(result.state, 'failed');assert.ok(!f.calls.includes('run'));assert.ok(!f.calls.includes('write'));
    assert.equal(f.repository.error.cleanup.cleanup_required, false);
  }
});
test('heartbeat cancellation aborts the actual runner contract and seals only after its cleanup', async () => {
  let aborted = false;
  const f = fixture({heartbeatState: 'cancel_requested', run: ({signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {aborted = true;reject(Object.assign(Error(), {code: 'analysis_cancelled'}));}, {once: true});
  })});
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await f.coordinator.run(job);
    assert.equal(result.state, 'cancelled');assert.equal(aborted, true);assert.equal(f.calls.includes('write'), false);
    assert.deepEqual(f.repository.error.cleanup, {container_removed: true, staging_removed: true, cleanup_required: false});
  } finally {clearTimeout(keepAlive);}
});
test('cleanup uncertainty quarantines this coordinator and retains exact recovery identity', async () => {
  const f = fixture({run: async () => {throw Object.assign(Error(), {code: 'analysis_cleanup_failed', containerName: 'opengeo-analysis-fixture', stagingDirectory: '/private/staged'});}});
  const result = await f.coordinator.run(job);
  assert.equal(result.state, 'cleanup_required');assert.equal(result.acknowledge, false);
  assert.equal(f.repository.error.cleanup.container_name, 'opengeo-analysis-fixture');
  assert.equal(f.repository.error.cleanup.staging_directory, '/private/staged');
  await assert.rejects(f.coordinator.run(job), {code: 'analysis_cleanup_failed'});
  assert.equal(f.calls.filter(x => x === 'claim').length, 1);
});
test('rejected completion preserves an uploaded private output as uncommitted without admitting a result', async () => {
  const f = fixture({complete: false});const result = await f.coordinator.run(job);
  assert.equal(result.state, 'failed');assert.equal(result.error_code, 'analysis_lease_lost');
  assert.equal(f.repository.error.cleanup.output_uncommitted.version_id, 'result-1');
});
test('Data API repository calls only the exact leased analysis functions and serializes bounded receipts', async () => {
  const calls = [], client = {async execute(sql, parameters) {calls.push({sql, parameters});return [[sql.includes('complete_') || sql.includes('fail_') ? true : {state: 'running'}]];}};
  const repo = new RdsAnalysisRepository({}, {client});
  await repo.claim(job, actor, 60);await repo.stage(job, actor, 60);await repo.heartbeat(job, actor, 60);
  await repo.complete(job, actor, {checksum_sha256: 'a'.repeat(64)}, {cleanup: {containerRemoved: true, stagingRemoved: true}});
  await repo.fail(job, actor, 'analysis_cancelled', {cleanup_required: false});
  assert.deepEqual(calls.map(c => c.sql.match(/app\.([a-z_]+)/)[1]), ['claim_analysis_job', 'stage_analysis_job', 'heartbeat_analysis_job', 'complete_analysis_job', 'fail_analysis_job']);
  assert.ok(calls.every(c => c.parameters[0].typeHint === 'UUID' && c.parameters[1].typeHint === 'UUID'));
  await repo.closeWindow(binding, 'idle');
  assert.equal(calls.at(-1).sql, 'SELECT app.close_analysis_host_window(:window, :stack, :profiles, :reason)');
  assert.deepEqual(calls.at(-1).parameters.map(p => p.value.stringValue), [windowId, binding.stack_id, binding.profiles_sha256, 'idle']);
  await assert.rejects(repo.closeWindow({...binding, profiles_sha256: 'wrong'}, 'idle'), {code: 'analysis_contract_invalid'});
  await assert.rejects(repo.closeWindow(binding, 'reopen'), {code: 'analysis_contract_invalid'});
});
test('concrete immutable S3 and SQS adapters use the shared real signer with strict prefixes and bounds', async () => {
  const f = fixture(), requests = [];
  const client = new AwsSigV4Client({region: 'us-east-1', credentials: {load: async () => ({accessKeyId: 'A'.repeat(20), secretAccessKey: 's'.repeat(40)})},
    fetchImplementation: async (url, options) => {
      requests.push({url, options});
      if (options.method === 'GET') return new Response(f.bytes, {headers: {'x-amz-version-id': 'version-1'}});
      if (options.method === 'PUT') return new Response('', {headers: {'x-amz-version-id': 'stored-result', 'x-amz-checksum-sha256': options.headers['x-amz-checksum-sha256']}});
      return new Response(JSON.stringify({Messages: [{MessageId: 'm', ReceiptHandle: 'receipt', Body: JSON.stringify({schemaVersion: 'opengeo.analysis.command.1', analysis_job_id: job})}]}));
    }});
  const settings = {region: 'us-east-1', bucket, kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/' + actor, queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/analysis'};
  const storage = new AwsAnalysisStorage(settings, {client});
  assert.deepEqual(await storage.readSnapshot(f.manifest.input), f.bytes);
  const result = Buffer.from('{}');assert.equal((await storage.writeResult(f.manifest.output, result)).version_id, 'stored-result');
  assert.equal(requests[1].options.headers['if-none-match'], '*');assert.equal(requests[1].options.headers['x-amz-server-side-encryption-bucket-key-enabled'], 'true');
  const uncertain = new AwsAnalysisStorage(settings, {client: {async request() {return new Response('', {headers: {'x-amz-checksum-sha256': Buffer.from(sha256(result), 'hex').toString('base64')}});}}});
  await assert.rejects(uncertain.writeResult(f.manifest.output, result), {code: 'analysis_output_write_uncertain'});
  assert.match(requests[0].url, /versionId=version-1$/);
  assert.ok(requests.every(r => r.options.headers.authorization.startsWith('AWS4-HMAC-SHA256 ')));
  await assert.rejects(storage.readSnapshot({...f.manifest.input, key: key + '../snapshot.json'}), {code: 'analysis_object_invalid'});
  const queue = new AwsAnalysisQueue(settings, {client});assert.equal(parseCommand((await queue.receive()).body), job);
  assert.equal(JSON.parse(requests.at(-1).options.body).VisibilityTimeout, 120);
});
test('daemon is default-off and pins the canonical profile envelope', () => {
  assert.deepEqual(AnalysisRuntimeSettings.fromEnvironment({}), {enabled: false});
  const envelope = {architecture, profiles: {bash: {image: 'sha256:' + 'a'.repeat(64), interpreter: '/bin/bash'},
    javascript: {image: 'sha256:' + 'a'.repeat(64), interpreter: '/usr/bin/node'}, python: {image: 'sha256:' + 'a'.repeat(64), interpreter: '/usr/bin/python3'}}, schemaVersion: 1};
  const canonical = value => value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
  assert.equal(parseProfileEnvelope(JSON.stringify(envelope), sha256(canonical(envelope))).python.architecture, architecture);
  assert.throws(() => parseProfileEnvelope(JSON.stringify(envelope), '0'.repeat(64)), {code: 'analysis_profile_invalid'});
});

function queuedMessage(id = job) {
  return {receiptHandle: 'one-receipt', body: JSON.stringify({schemaVersion: 'opengeo.analysis.command.1', analysis_job_id: id})};
}
test('startup keeps one receipt through delayed controller readiness and renews its visibility', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let receives = 0, claims = 0, deletes = 0, renewals = 0;
  const closes = [], controller = new AbortController();
  const queue = {async receive() {receives++;return queuedMessage();}, async delete(receipt) {assert.equal(receipt, 'one-receipt');deletes++;},
    async changeVisibility(receipt, seconds = 120) {assert.equal(receipt, 'one-receipt');assert.equal(seconds, 120);renewals++;}};
  const coordinator = {async run(id) {assert.equal(id, job);return ++claims <= 13 ? {state: 'busy', acknowledge: false} : {state: 'succeeded', acknowledge: true};},
    async closeWindow(reason) {closes.push(reason);return {state: 'closed'};}};
  const result = await runAnalysisQueue({queue, coordinator, signal: controller.signal, maximumJobs: 1,
    pause: async () => {t.mock.timers.tick(5000);await Promise.resolve();}});
  assert.deepEqual(result, {processed: 1, stopped: 'job_limit'});
  assert.equal(receives, 1);assert.equal(claims, 14);assert.equal(deletes, 1);assert.equal(renewals, 1);
  assert.deepEqual(closes, ['job_limit']);
});
test('an idle-close race keeps the consumer for work admitted before the close lock', async () => {
  let receives = 0, runs = 0, deleted = 0;
  const closes = [], controller = new AbortController();
  const queue = {async receive() {return ++receives === 4 ? queuedMessage() : null;}, async delete() {deleted++;}, async changeVisibility() {}};
  const coordinator = {async run() {runs++;return {state: 'succeeded', acknowledge: true};},
    async closeWindow(reason) {closes.push(reason);return {state: closes.length === 1 ? 'busy' : 'closed'};}};
  assert.deepEqual(await runAnalysisQueue({queue, coordinator, signal: controller.signal}), {processed: 1, stopped: 'idle'});
  assert.equal(receives, 7);assert.equal(runs, 1);assert.equal(deleted, 1);assert.deepEqual(closes, ['idle', 'idle']);
});
test('host timeout closes admission without deleting the held startup command', async () => {
  let receives = 0, deleted = 0;
  const closes = [], controller = new AbortController();
  const queue = {async receive() {receives++;return queuedMessage();}, async delete() {deleted++;}, async changeVisibility() {}};
  const coordinator = {async run() {return {state: 'busy', acknowledge: false};},
    async closeWindow(reason) {closes.push(reason);return {state: 'closed'};}};
  assert.deepEqual(await runAnalysisQueue({queue, coordinator, signal: controller.signal, pause: async () => controller.abort()}),
    {processed: 0, stopped: 'signal'});
  assert.equal(receives, 1);assert.equal(deleted, 0);assert.deepEqual(closes, ['signal']);
});
test('cleanup uncertainty closes host admission and retains the message for lifecycle recovery', async () => {
  let deleted = 0;
  const closes = [], controller = new AbortController();
  const queue = {async receive() {return queuedMessage();}, async delete() {deleted++;}, async changeVisibility() {}};
  const coordinator = {async run() {return {state: 'cleanup_required', acknowledge: false};},
    async closeWindow(reason) {closes.push(reason);return {state: 'closed'};}};
  const result = await runAnalysisQueue({queue, coordinator, signal: controller.signal});
  assert.equal(result.unacknowledged, true);assert.equal(result.stopped, 'cleanup_required');
  assert.equal(deleted, 0);assert.deepEqual(closes, ['failure']);
});
