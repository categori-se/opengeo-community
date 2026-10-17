import {randomUUID} from 'node:crypto';
import {AnalysisRunner} from '../../observable-coordinator/src/analysis-runner.mjs';
import {AwsRdsDataClient} from '../../observable-coordinator/src/production-adapters.mjs';
import {AwsSigV4Client, awsEncode, boundedResponseBytes} from '../../observable-coordinator/src/aws-sigv4.mjs';
import {LIMITS, SHA256, BUCKET, closed, fail, integer, jsonBytes, objectDescriptor, parseManifest, parseProfiles, parseSnapshot,
  sha256, uuid, validateResult} from './contracts.mjs';

const TERMINAL_CLAIMS = ['cancelled', 'unauthorized', 'terminal'];
const LIVE_STATES = ['running', 'cancel_requested', 'lease_lost', 'unauthorized'];
function gate(value) {
  closed(value, ['state']);
  if (!LIVE_STATES.includes(value.state)) throw fail('analysis_lease_response_invalid');
  if (value.state !== 'running') throw fail(value.state === 'cancel_requested' ? 'analysis_cancelled'
    : value.state === 'unauthorized' ? 'analysis_authorization_revoked' : 'analysis_lease_lost');
}
function errorCode(error) {
  const code = error?.code ?? '';
  if (['analysis_cancelled', 'analysis_timeout', 'analysis_failed', 'analysis_cleanup_failed', 'analysis_lease_lost',
    'analysis_input_invalid', 'analysis_result_invalid', 'analysis_storage_failed', 'analysis_source_access_changed',
    'analysis_profile_unavailable'].includes(code)) return code;
  if (code === 'analysis_authorization_revoked') return 'analysis_source_access_changed';
  if (code === 'analysis_commit_rejected') return 'analysis_lease_lost';
  if (code === 'analysis_profile_invalid' || code === 'analysis_runtime_binding_invalid') return 'analysis_profile_unavailable';
  if (['analysis_snapshot_unavailable', 'analysis_output_collision', 'analysis_output_write_uncertain'].includes(code)
    || /^(?:s3_|aws_|data_api_)/.test(code)) return 'analysis_storage_failed';
  if (code === 'analysis_result_too_large' || code === 'analysis_output_invalid' || code.startsWith('analysis_logs_')) return 'analysis_result_invalid';
  if (/^analysis_(?:snapshot|manifest|claim|object|identity|contract|script|input)_/.test(code)) return 'analysis_input_invalid';
  return 'analysis_failed';
}

/** Trusted job coordinator only. User code and host credentials never share a process. */
export class AnalysisCoordinator {
  constructor({enabled = false, bucket, profiles, binding, repository, storage, temporaryDirectory,
    runnerFactory = options => new AnalysisRunner(options), heartbeatMilliseconds = 5000, leaseSeconds = 60} = {}) {
    if (typeof enabled !== 'boolean' || !BUCKET.test(bucket ?? '') || typeof runnerFactory !== 'function') throw fail('analysis_configuration_invalid');
    integer(heartbeatMilliseconds, 10, 5000);integer(leaseSeconds, 30, 90);
    closed(binding, ['window_id', 'stack_id', 'profiles_sha256']);uuid(binding.window_id);
    if (typeof binding.stack_id !== 'string' || binding.stack_id.length > 2048 || !SHA256.test(binding.profiles_sha256 ?? '')) throw fail('analysis_configuration_invalid');
    this.enabled = enabled;this.bucket = bucket;this.profiles = parseProfiles(profiles);this.binding = Object.freeze({...binding});
    this.repository = repository;this.storage = storage;this.temporaryDirectory = temporaryDirectory;this.runnerFactory = runnerFactory;
    this.heartbeatMilliseconds = heartbeatMilliseconds;this.leaseSeconds = leaseSeconds;this.busy = false;this.cleanupRequired = false;
  }

  closeWindow(reason) {
    if (!this.enabled) throw fail('analysis_disabled');
    return this.repository.closeWindow(this.binding, reason);
  }

  async run(jobId, {signal} = {}) {
    uuid(jobId);
    if (!this.enabled) throw fail('analysis_disabled');
    if (this.cleanupRequired) throw fail('analysis_cleanup_failed');
    if (this.busy) return {state: 'busy', job_id: jobId, acknowledge: false};
    if (signal?.aborted) throw fail('analysis_cancelled');
    this.busy = true;
    const token = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort();signal?.addEventListener('abort', abort, {once: true});
    let claimed = false, timer, heartbeat = Promise.resolve(), heartbeatError, outputUncommitted;
    let runnerStarted = false, runnerFinished = false;
    const clearHeartbeat = async () => {clearInterval(timer);await heartbeat;};
    const check = () => {if (heartbeatError) throw heartbeatError;if (controller.signal.aborted) throw fail('analysis_cancelled');};
    const beat = async () => {
      try {gate(await this.repository.heartbeat(jobId, token, this.leaseSeconds));}
      catch (error) {heartbeatError = error;controller.abort();throw error;}
    };
    try {
      const claim = await this.repository.claim(jobId, token, this.leaseSeconds);
      closed(claim, ['state', 'job_id'], ['lease_token', 'manifest_json', 'manifest_sha256', 'attempt_count', 'runtime']);
      if (claim.job_id !== jobId || !['claimed', 'busy', ...TERMINAL_CLAIMS].includes(claim.state)) throw fail('analysis_claim_invalid');
      if (claim.state !== 'claimed') return {state: claim.state, job_id: jobId, acknowledge: TERMINAL_CLAIMS.includes(claim.state)};
      claimed = true;
      const manifest = parseManifest(claim, {jobId, token, bucket: this.bucket, profiles: this.profiles, binding: this.binding});
      timer = setInterval(() => {
        heartbeat = heartbeat.then(() => heartbeatError ? undefined : beat()).catch(() => {});
      }, this.heartbeatMilliseconds);timer.unref?.();
      check();
      const bytes = await this.storage.readSnapshot(manifest.input);
      check();
      const snapshot = parseSnapshot(bytes, manifest);
      // The DB checks the current actor/project/source grants again after download.
      gate(await this.repository.stage(jobId, token, this.leaseSeconds));check();
      const runner = this.runnerFactory({enabled: true, profiles: {[manifest.language]: {
        image: manifest.profile.image, interpreter: manifest.profile.interpreter}},
        timeoutSeconds: manifest.profile.timeout_seconds, memoryMiB: manifest.profile.memory_mib,
        ...(this.temporaryDirectory === undefined ? {} : {temporaryDirectory: this.temporaryDirectory})});
      runnerStarted = true;
      let raw;
      try {raw = await runner.run({language: snapshot.language, code: snapshot.code, layers: snapshot.layers, signal: controller.signal});}
      catch (error) {if (error?.code !== 'analysis_cleanup_failed') runnerFinished = true;throw error;}
      runnerFinished = true;check();
      const result = validateResult(raw, manifest, snapshot);
      const resultBytes = jsonBytes(result, LIMITS.maximumResultJsonBytes, 'analysis_result_too_large');
      // Reauthorization precedes upload; completion repeats it atomically under the lease.
      await beat();check();
      outputUncommitted = {...manifest.output, size_bytes: resultBytes.length, checksum_sha256: sha256(resultBytes)};
      const descriptor = await this.storage.writeResult(manifest.output, resultBytes);
      objectDescriptor(descriptor, {maximum: LIMITS.maximumResultJsonBytes, ...manifest.output});
      if (descriptor.size_bytes !== resultBytes.length || descriptor.checksum_sha256 !== sha256(resultBytes)) throw fail('analysis_output_invalid');
      outputUncommitted = descriptor;
      await clearHeartbeat();check();
      if (!(await this.repository.complete(jobId, token, descriptor, result.execution))) throw fail('analysis_commit_rejected');
      outputUncommitted = undefined;
      return {state: result.execution.exitCode === 0 ? 'succeeded' : 'failed', job_id: jobId, acknowledge: true};
    } catch (original) {
      await clearHeartbeat();
      const error = original?.code === 'analysis_cleanup_failed' ? original : heartbeatError ?? original;
      const code = errorCode(error);
      const uncertainCleanup = code === 'analysis_cleanup_failed' || runnerStarted && !runnerFinished;
      const cleanup = {container_removed: !uncertainCleanup, staging_removed: !uncertainCleanup, cleanup_required: uncertainCleanup,
        ...(error?.containerName ? {container_name: error.containerName} : {}),
        ...(error?.stagingDirectory ? {staging_directory: error.stagingDirectory} : {}),
        ...(outputUncommitted ? {output_uncommitted: outputUncommitted} : {})};
      if (uncertainCleanup) this.cleanupRequired = true;
      let recorded = false;
      if (claimed) try {recorded = await this.repository.fail(jobId, token, code, cleanup) === true;} catch { /* Lease expiry remains a closed, non-reexecution boundary. */ }
      return {state: uncertainCleanup ? 'cleanup_required' : recorded ? code === 'analysis_cancelled' ? 'cancelled' : 'failed' : 'uncertain',
        job_id: jobId, acknowledge: recorded && !uncertainCleanup, error_code: code};
    } finally {
      await clearHeartbeat();signal?.removeEventListener('abort', abort);this.busy = false;
    }
  }
}

/** Reuses the real signed Data API client with an analysis-only database role. */
export class RdsAnalysisRepository {
  constructor(settings, {client} = {}) {this.client = client ?? new AwsRdsDataClient(settings);}
  async closeWindow(binding, reason) {
    closed(binding, ['window_id', 'stack_id', 'profiles_sha256']);uuid(binding.window_id);
    if (typeof binding.stack_id !== 'string' || binding.stack_id.length > 2048 || !SHA256.test(binding.profiles_sha256 ?? '')
      || !['idle', 'job_limit', 'signal', 'failure'].includes(reason)) throw fail('analysis_contract_invalid');
    const rows = await this.client.execute('SELECT app.close_analysis_host_window(:window, :stack, :profiles, :reason)', [
      {name: 'window', typeHint: 'UUID', value: {stringValue: binding.window_id}},
      {name: 'stack', value: {stringValue: binding.stack_id}},
      {name: 'profiles', value: {stringValue: binding.profiles_sha256}},
      {name: 'reason', value: {stringValue: reason}}
    ]);
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1) throw fail('analysis_database_response_invalid');
    return rows[0][0];
  }
  async #call(name, job, token, extra = []) {
    uuid(job);uuid(token);
    const parameters = [{name: 'job', typeHint: 'UUID', value: {stringValue: job}}, {name: 'token', typeHint: 'UUID', value: {stringValue: token}}, ...extra];
    const placeholders = extra.map(p => p.name === 'lease' ? 'CAST(:lease AS integer)' : p.typeHint === 'JSON' ? `CAST(:${p.name} AS jsonb)` : `:${p.name}`);
    const rows = await this.client.execute(`SELECT app.${name}(:job, :token${placeholders.length ? ', ' + placeholders.join(', ') : ''})`, parameters);
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1) throw fail('analysis_database_response_invalid');
    return rows[0][0];
  }
  #lease(seconds) {integer(seconds, 30, 90);return {name: 'lease', value: {longValue: seconds}};}
  claim(job, token, seconds) {return this.#call('claim_analysis_job', job, token, [this.#lease(seconds)]);}
  stage(job, token, seconds) {return this.#call('stage_analysis_job', job, token, [this.#lease(seconds)]);}
  heartbeat(job, token, seconds) {return this.#call('heartbeat_analysis_job', job, token, [this.#lease(seconds)]);}
  complete(job, token, descriptor, receipt) {
    return this.#call('complete_analysis_job', job, token, [
      {name: 'result', typeHint: 'JSON', value: {stringValue: jsonBytes(descriptor, 8192).toString()}},
      {name: 'receipt', typeHint: 'JSON', value: {stringValue: jsonBytes(receipt, 32768).toString()}}
    ]).then(value => {if (typeof value !== 'boolean') throw fail('analysis_database_response_invalid');return value;});
  }
  fail(job, token, code, cleanup) {
    if (!/^analysis_[a-z_]+$/.test(code)) throw fail('analysis_contract_invalid');
    return this.#call('fail_analysis_job', job, token, [{name: 'error', value: {stringValue: code}},
      {name: 'cleanup', typeHint: 'JSON', value: {stringValue: jsonBytes(cleanup, 32768).toString()}}])
      .then(value => {if (typeof value !== 'boolean') throw fail('analysis_database_response_invalid');return value;});
  }
}

/** Analysis object-key policy; shared SigV4, bounded transport and KMS conventions. */
export class AwsAnalysisStorage {
  constructor(settings, {client} = {}) {
    this.settings = settings;this.client = client ?? new AwsSigV4Client({region: settings.region});
    this.host = `s3.${settings.region}.amazonaws.com`;
  }
  #path(bucket, key, filename) {
    if (bucket !== this.settings.bucket || !BUCKET.test(bucket ?? '')
      || !new RegExp(`^organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/analysis/[0-9a-f-]{36}/${filename}\\.json$`).test(key ?? '')) throw fail('analysis_object_invalid');
    return '/' + [bucket, ...key.split('/')].map(awsEncode).join('/');
  }
  async readSnapshot(input) {
    const path = this.#path(input.bucket, input.key, 'snapshot');
    objectDescriptor(input, {maximum: LIMITS.maximumBundleBytes, bucket: this.settings.bucket, key: input.key});
    const response = await this.client.request({service: 's3', method: 'GET', host: this.host, path,
      query: [['versionId', input.version_id]], maximumResponseBytes: input.size_bytes});
    if (!response.ok) throw fail('analysis_snapshot_unavailable');
    const bytes = await boundedResponseBytes(response, input.size_bytes);
    if (response.headers.get('x-amz-version-id') !== input.version_id || bytes.length !== input.size_bytes
      || sha256(bytes) !== input.checksum_sha256) throw fail('analysis_snapshot_mismatch');
    return bytes;
  }
  async writeResult(output, bytes) {
    const path = this.#path(output.bucket, output.key, 'result');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.maximumResultJsonBytes) throw fail('analysis_result_too_large');
    const checksum = sha256(bytes), base64 = Buffer.from(checksum, 'hex').toString('base64');
    const response = await this.client.request({service: 's3', method: 'PUT', host: this.host, path,
      headers: {'if-none-match': '*', 'content-type': 'application/json', 'x-amz-checksum-sha256': base64,
        'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-bucket-key-enabled': 'true',
        'x-amz-server-side-encryption-aws-kms-key-id': this.settings.kmsKeyArn}, body: bytes, maximumResponseBytes: 65536});
    await boundedResponseBytes(response, 65536);
    if (response.status === 412) throw fail('analysis_output_collision');
    if (!response.ok) throw fail('analysis_output_write_uncertain');
    const descriptor = {...output, version_id: response.headers.get('x-amz-version-id'), size_bytes: bytes.length, checksum_sha256: checksum};
    try {objectDescriptor(descriptor, {maximum: LIMITS.maximumResultJsonBytes, ...output});}
    catch {throw fail('analysis_output_write_uncertain');}
    if (response.headers.get('x-amz-checksum-sha256') !== base64) throw fail('analysis_output_write_uncertain');
    return descriptor;
  }
}
