import {OpenGeoApiClient} from './apiClient.js';
import {normalizeAnalysisResult, snapshotAnalysisLayers, validateAnalysisSource} from './analysisConsole.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const STATES = new Set(['awaiting_upload', 'dispatch_pending', 'pending', 'running', 'cancel_requested', ...TERMINAL]);
const SNAPSHOT_BYTES = 17 * 1024 ** 2, RESULT_BYTES = 9 * 1024 ** 2;
const aborted = () => new DOMException('Stopped', 'AbortError');
const digest = async (crypto, bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const positive = value => Number.isSafeInteger(value) && value > 0;
function transportUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Invalid managed transfer address.');
  return url.href;
}
function jobRecord(value, key, id) {
  if (!value || !UUID.test(value.job_id) || value.request_key !== key || id && value.job_id !== id || !STATES.has(value.state)) {
    throw Error('Managed execution returned a different or invalid run.');
  }
  return value;
}
function sourceBindings(pins, ids) {
  const seen = new Set(), bindings = [];
  for (const row of pins ?? []) {
    if (!row || !ids.includes(row.id) || seen.has(row.id)) throw Error('Analysis inputs changed. Refresh the selected Layers.');
    seen.add(row.id);const pin = row.inputPin;
    if (!pin || !UUID.test(pin.datasetId ?? '')) continue;
    const binding = {layer_id: row.id, dataset_id: pin.datasetId};
    if (pin.datasetVersionId != null) {
      if (!UUID.test(pin.datasetVersionId)) throw Error('The input dataset version is invalid.');
      binding.dataset_version_id = pin.datasetVersionId;
    }
    for (const [from, to] of [['sourceVersion', 'source_version'], ['featureGeneration', 'feature_generation']]) {
      if (pin[from] != null) {
        if (!positive(pin[from])) throw Error('The input version is invalid.');
        binding[to] = pin[from];
      }
    }
    bindings.push(binding);
  }
  return bindings;
}
async function pause(milliseconds, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const done = () => {signal?.removeEventListener('abort', stop);resolve();};
    const timer = setTimeout(done, milliseconds);
    const stop = () => {clearTimeout(timer);signal.removeEventListener('abort', stop);reject(signal.reason ?? aborted());};
    signal?.addEventListener('abort', stop, {once: true});
  });
}

/** No requests on construction. Only an explicit Run uploads data or wakes a worker. */
export function createManagedAnalysisRuntime({adapter, projectId, organizationId, assertScope = async () => {},
  fetch = globalThis.fetch, crypto = globalThis.crypto, wait = pause, now = Date.now} = {}) {
  let retained = null, running = false;
  const supported = UUID.test(projectId ?? '') && UUID.test(organizationId ?? '')
    && typeof adapter?.request === 'function' && typeof adapter?.tokenProvider === 'function'
    && typeof adapter?.organizationProvider === 'function';
  async function capture() {
    if (!supported) throw Error('Managed execution requires a signed-in Project.');
    await assertScope();
    const tokenProvider = adapter.tokenProvider, organizationProvider = adapter.organizationProvider, baseUrl = adapter.baseUrl;
    const token = await tokenProvider.call(adapter), organization = await organizationProvider.call(adapter);
    if (!token || organization !== organizationId) throw Error('Your sign-in or selected account changed.');
    const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => token, organizationProvider: () => organization,
      fetchImplementation: adapter.fetchImplementation});
    const current = async () => {
      try {
        await assertScope();
        if (adapter.baseUrl !== baseUrl || adapter.tokenProvider !== tokenProvider || adapter.organizationProvider !== organizationProvider
          || await tokenProvider.call(adapter) !== token || await organizationProvider.call(adapter) !== organization) {
          throw Error('Your sign-in or selected account changed.');
        }
      } catch (cause) {
        const error = Error('Your sign-in or selected account changed.', {cause});error.analysisScopeChanged = true;throw error;
      }
    };
    await current();return {client, current};
  }
  const basePath = `/projects/${projectId}/analysis`;
  async function request(scope, path, {body, signal, cleanup = false} = {}) {
    const timeout = AbortSignal.timeout(15_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (!cleanup) await scope.current();
    return scope.client.request(basePath + path, {method: body === undefined ? 'GET' : 'POST', body, signal: combined,
      ...(!cleanup ? {beforeDispatch: scope.current} : {})});
  }
  async function lookup(run, signal, cleanup = false) {
    try {return jobRecord(await request(run.scope, `/jobs?request_key=${run.key}`, {signal, cleanup}), run.key, run.id);}
    catch (error) {if (error.status === 404 && error.code === 'analysis_not_found') return null;throw error;}
  }
  async function status(run, signal, cleanup = false) {
    return jobRecord(await request(run.scope, `/jobs/${run.id}`, {signal, cleanup}), run.key, run.id);
  }
  async function cancel(run) {
    // This uses the original account and identity even after the workspace switches.
    // The aborted UI signal must never prevent the server cancellation request.
    const signal = AbortSignal.timeout(30_000);
    try {
      if (!run.id) {const found = await lookup(run, signal, true);if (!found) {retained = null;return;}run.id = found.job_id;}
      let record = jobRecord(await request(run.scope, `/jobs/${run.id}/cancel`, {body: {}, signal, cleanup: true}), run.key, run.id);
      for (let read = 0; (!TERMINAL.has(record.state) || record.cleanup_required === true) && read < 6; read++) {
        await wait(2000, signal);
        // This idempotent endpoint exposes only the original actor's cleanup
        // state and remains usable after source/edit revocation. Ordinary job
        // reads deliberately require the revoked authority again.
        record = jobRecord(await request(run.scope, `/jobs/${run.id}/cancel`, {body: {}, signal, cleanup: true}), run.key, run.id);
      }
      if (!TERMINAL.has(record.state) || record.cleanup_required === true) throw Error('Cancellation is awaiting worker cleanup.');
      if (retained === run) retained = null;
    } catch (cause) {
      const error = Error(`Managed run ${run.id ?? run.key} may still be active. Cancellation could not be confirmed.`, {cause});
      error.cancellationUncertain = true;throw error;
    }
  }
  async function upload(run, ticket, bytes, signal) {
    if (ticket?.method !== 'POST' || !ticket.fields || typeof ticket.fields !== 'object' || Array.isArray(ticket.fields)
      || Object.keys(ticket.fields).length > 64) throw Error('Invalid managed upload permission.');
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) {
      if (typeof value !== 'string' || name.length > 256 || value.length > 8192) throw Error('Invalid managed upload fields.');
      form.append(name, value);
    }
    form.append('file', new Blob([bytes], {type: 'application/json'}), 'snapshot.json');
    await run.scope.current();signal.throwIfAborted();run.uploadAttempted = true;
    const response = await fetch(transportUrl(ticket.url), {method: 'POST', body: form, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])});
    if (!response.ok) throw Error('The selected input snapshot could not be uploaded.');
  }
  async function result(run, signal) {
    const ticket = await request(run.scope, `/jobs/${run.id}/result`, {signal});
    if (ticket?.method !== 'GET' || !positive(ticket.size_bytes) || ticket.size_bytes > RESULT_BYTES || !SHA.test(ticket.checksum_sha256)) {
      throw Error('Invalid managed result permission.');
    }
    await run.scope.current();signal.throwIfAborted();
    const response = await fetch(transportUrl(ticket.url), {method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])});
    if (!response.ok || !response.body) throw Error('The managed result could not be downloaded.');
    const reader = response.body.getReader(), chunks = [];let length = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();if (done) break;length += value.byteLength;
        if (length > ticket.size_bytes || length > RESULT_BYTES) throw Error('Managed result exceeds its declared size.');
        chunks.push(value);
      }
    } catch (error) {await reader.cancel();throw error;}
    finally {reader.releaseLock();}
    if (length !== ticket.size_bytes) throw Error('Managed result is incomplete.');
    const bytes = new Uint8Array(length);let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}
    if (await digest(crypto, bytes) !== ticket.checksum_sha256) throw Error('Managed result checksum does not match.');
    await run.scope.current();signal.throwIfAborted();
    return normalizeAnalysisResult(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  }
  return {
    hasPendingManagedRun: () => retained !== null,
    async cancelManaged() {
      if (running) throw Error('Stop the active managed run before cancelling its retained job.');
      if (retained) await cancel(retained);
    },
    async getManagedCapabilities() {
      if (!supported) return {configured: false, languages: []};
      const scope = await capture(), value = await request(scope, '/capabilities');
      return {configured: value?.configured === true && value.available === true && value.can_submit === true,
        languages: Array.isArray(value?.languages) ? value.languages.filter(language => ['python', 'javascript', 'bash'].includes(language)) : []};
    },
    async runManaged({language, code, layers, inputPins = [], signal, onStatus = () => {}}) {
      if (running) throw Error('Wait for the current managed run to finish.');
      if (!['python', 'javascript', 'bash'].includes(language)) throw Error('Choose a supported language.');
      validateAnalysisSource(code);const inputs = snapshotAnalysisLayers(layers).layers;
      const bytes = new TextEncoder().encode(JSON.stringify({schemaVersion: 'opengeo.analysis.snapshot.1', language, code, layers: inputs}));
      if (bytes.byteLength > SNAPSHOT_BYTES) throw Error('The selected input snapshot is too large.');
      const checksum = await digest(crypto, bytes), bindings = sourceBindings(inputPins, inputs.map(row => row.id));
      const fingerprint = JSON.stringify([checksum, bindings]);
      const scope = retained?.scope ?? await capture();signal?.throwIfAborted();
      const controller = new AbortController(), stop = () => controller.abort(signal?.reason ?? aborted());
      signal?.addEventListener('abort', stop, {once: true});if (signal?.aborted) stop();
      const deadline = setTimeout(() => controller.abort(Error('Managed execution reached its waiting limit.')), 360_000);
      let run = retained, record, terminal = false;running = true;
      try {
        await scope.current();
        if (run && run.fingerprint !== fingerprint) throw Error('Resolve the previous managed run before changing its script or inputs.');
        if (run) {record = await lookup(run, controller.signal);if (!record) throw Error('The previous managed run could not be recovered.');}
        else {
          run = {scope, key: crypto.randomUUID(), fingerprint, id: null, uploadAttempted: false};retained = run;
          onStatus('Preparing managed run…');
          try {
            record = jobRecord(await request(scope, '/jobs', {body: {request_key: run.key, language,
              snapshot: {size_bytes: bytes.byteLength, checksum_sha256: checksum}, layer_ids: inputs.map(row => row.id),
              source_bindings: bindings}, signal: controller.signal}), run.key);
          } catch (cause) {
            if (controller.signal.aborted) throw cause;
            if (cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) {
              retained = null;throw cause;
            }
            // Recover an uncertain create once, without repeating the write.
            record = await lookup(run, controller.signal);if (!record) throw cause;
          }
        }
        run.id = record.job_id;
        if (record.state === 'awaiting_upload' && !run.uploadAttempted) {
          onStatus('Uploading selected inputs…');await upload(run, record.upload, bytes, controller.signal);
        }
        if (['awaiting_upload', 'dispatch_pending'].includes(record.state)) {
          onStatus('Starting managed run…');
          record = jobRecord(await request(scope, `/jobs/${run.id}/submit`, {body: {}, signal: controller.signal}), run.key, run.id);
          if (record.state === 'dispatch_pending') throw Error('Run saved; worker dispatch is awaiting confirmation. Press Run again to resume this run.');
        }
        const started = now();
        for (let read = 0; !TERMINAL.has(record.state); read++) {
          if (read >= 48 || now() - started > 360_000) {
            controller.abort(Error('Managed execution reached its waiting limit.'));throw controller.signal.reason;
          }
          onStatus(record.state === 'running' ? 'Running on the managed worker…'
            : record.state === 'cancel_requested' ? 'Waiting for worker cleanup…' : 'Waiting for the managed worker…');
          await wait(read < 12 ? 5000 : 15000, controller.signal);record = await status(run, controller.signal);
        }
        terminal = true;
        if (record.cleanup_required === true) {
          const error = Error(`Managed run ${run.id} is awaiting confirmed worker cleanup.`);error.cancellationUncertain = true;throw error;
        }
        if (record.result_available === true && record.state !== 'cancelled') {
          const value = await result(run, controller.signal);if (retained === run) retained = null;return value;
        }
        if (retained === run) retained = null;
        if (record.state === 'cancelled') throw aborted();
        throw Error(record.state === 'failed' ? 'The managed script failed before a result was available.' : 'The managed run returned no result.');
      } catch (error) {
        if ((controller.signal.aborted || error.analysisScopeChanged) && run && !terminal) {
          onStatus('Stopping managed run…');await cancel(run);throw aborted();
        }
        throw error;
      } finally {clearTimeout(deadline);signal?.removeEventListener('abort', stop);running = false;}
    }
  };
}
