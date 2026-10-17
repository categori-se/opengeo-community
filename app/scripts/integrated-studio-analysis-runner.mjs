import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AnalysisRunner} from '../../services/observable-coordinator/src/analysis-runner.mjs';

const MAXIMUM_BODY_BYTES = 17 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 9 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), {code});

export function loadLocalAnalysisRunner(work) {
  const path = join(work, 'analysis-profile.json');
  if (!existsSync(path)) return new AnalysisRunner();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw fail('analysis_configuration_invalid');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object'
    || Object.keys(config).some(key => !['enabled', 'profiles', 'timeoutSeconds', 'memoryMiB'].includes(key))
    || config.enabled !== true) throw fail('analysis_configuration_invalid');
  return new AnalysisRunner(config);
}

function jsonResponse(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAXIMUM_RESPONSE_BYTES) throw fail('analysis_result_too_large');
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'}).end(body);
}

function readRequest(request, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, finished = false;
    const chunks = [];
    const timer = setTimeout(() => finish(fail('analysis_request_timeout')), 5000);
    timer.unref?.();
    function finish(error, value) {
      if (finished) return;finished = true;clearTimeout(timer);
      request.removeListener('data', data);request.removeListener('end', end);request.removeListener('error', errorEvent);
      signal.removeEventListener('abort', abort);
      if (error) {request.pause();reject(error);} else resolve(value);
    }
    function data(chunk) {
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) return finish(fail('analysis_request_too_large'));
      chunks.push(chunk);
    }
    function end() {
      try {finish(null, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size))));}
      catch {finish(fail('analysis_request_invalid'));}
    }
    const errorEvent = () => finish(fail('analysis_cancelled'));
    const abort = () => finish(fail('analysis_cancelled'));
    request.on('data', data);request.once('end', end);request.once('error', errorEvent);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

/** Same-origin loopback development transport, never an application API endpoint. */
export function createLocalAnalysisBridge({runner, origin}) {
  const host = new URL(origin).host;
  return async function localAnalysisRequest(request, response, path) {
    if (!['/__local/analysis/capabilities', '/__local/analysis/run'].includes(path)) return false;
    if (request.headers.host !== host || request.headers.origin && request.headers.origin !== origin
      || path.endsWith('/run') && request.headers.origin !== origin) {
      jsonResponse(response, 403, {error: 'analysis_origin_denied'});return true;
    }
    if (path.endsWith('/capabilities')) {
      if (request.method !== 'GET') jsonResponse(response, 405, {error: 'analysis_method_invalid'});
      else jsonResponse(response, 200, runner.capabilities());
      return true;
    }
    if (request.method !== 'POST') {jsonResponse(response, 405, {error: 'analysis_method_invalid'});return true;}
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
      || request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      jsonResponse(response, 400, {error: 'analysis_request_invalid'});return true;
    }
    if (request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length'])
      || Number(request.headers['content-length']) > MAXIMUM_BODY_BYTES)) {
      response.setHeader('connection', 'close');jsonResponse(response, 413, {error: 'analysis_request_too_large'});return true;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {if (!response.writableEnded) abort();};
    request.once('aborted', abort);response.once('close', close);
    const timer = setTimeout(abort, runner.capabilities().limits.timeoutSeconds * 1000 + 12000);
    timer.unref?.();
    try {
      const body = await readRequest(request, controller.signal);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['language', 'code', 'layers'].includes(key))) throw fail('analysis_request_invalid');
      const result = await runner.run({...body, signal: controller.signal});
      jsonResponse(response, 200, result);
    } catch (error) {
      const code = /^analysis_[a-z_]+$/.test(error.code ?? '') ? error.code : 'analysis_failed';
      const status = ['analysis_disabled', 'analysis_profile_unavailable', 'analysis_cleanup_failed'].includes(code) ? 503
        : code === 'analysis_busy' ? 409 : code === 'analysis_request_timeout' || code === 'analysis_timeout' ? 504
        : code.endsWith('_too_large') ? 413 : code === 'analysis_cancelled' ? 499 : code === 'analysis_failed' ? 500 : 400;
      response.setHeader('connection', 'close');
      jsonResponse(response, status, {error: code});
    } finally {
      clearTimeout(timer);request.removeListener('aborted', abort);response.removeListener('close', close);
    }
    return true;
  };
}
