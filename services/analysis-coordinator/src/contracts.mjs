import {createHash} from 'node:crypto';
import {AnalysisRunner, ANALYSIS_LIMITS} from '../../observable-coordinator/src/analysis-runner.mjs';

export const LIMITS = Object.freeze({...ANALYSIS_LIMITS, maximumLayers: 16, maximumBundleBytes: 17 * 1024 * 1024,
  maximumResultJsonBytes: 9 * 1024 * 1024, maximumManifestBytes: 65536});
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export const LANGUAGES = Object.freeze(['python', 'javascript', 'bash']);
export class AnalysisContractError extends Error {
  constructor(code) {super(code);this.name = 'AnalysisContractError';this.code = code;}
}
export const fail = code => new AnalysisContractError(code);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function closed(value, required, optional = [], code = 'analysis_contract_invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw fail(code);
  return value;
}
export function uuid(value) {if (!UUID.test(value ?? '')) throw fail('analysis_identity_invalid');return value;}
export function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail('analysis_contract_invalid');
  return value;
}
export function jsonBytes(value, maximum, code = 'analysis_contract_invalid') {
  let text;
  try {text = JSON.stringify(value, (_key, item) => {if (typeof item === 'number' && !Number.isFinite(item)) throw Error();return item;});}
  catch {throw fail(code);}
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) throw fail(code);
  return Buffer.from(text);
}
export function parseJson(bytes, maximum, code = 'analysis_contract_invalid') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum) throw fail(code);
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));}
  catch {throw fail(code);}
}
export function objectDescriptor(value, {maximum, bucket, key} = {}) {
  closed(value, ['bucket', 'key', 'version_id', 'size_bytes', 'checksum_sha256']);
  if (!BUCKET.test(value.bucket ?? '') || value.bucket !== bucket || value.key !== key
    || typeof value.version_id !== 'string' || !value.version_id || value.version_id === 'null'
    || value.version_id.length > 1024 || /[\x00-\x1f\x7f]/.test(value.version_id)
    || !SHA256.test(value.checksum_sha256 ?? '')) throw fail('analysis_object_invalid');
  integer(value.size_bytes, 1, maximum);return value;
}
export function parseProfiles(profiles, architecture = process.arch === 'x64' ? 'amd64' : process.arch) {
  closed(profiles, [], LANGUAGES, 'analysis_profile_invalid');
  const copy = {};
  for (const [language, profile] of Object.entries(profiles)) {
    closed(profile, ['image', 'interpreter', 'architecture', 'timeout_seconds', 'memory_mib'], [], 'analysis_profile_invalid');
    if (!['amd64', 'arm64'].includes(architecture) || profile.architecture !== architecture) throw fail('analysis_profile_invalid');
    integer(profile.timeout_seconds, 1, 30);
    if (![256, 512].includes(profile.memory_mib)) throw fail('analysis_profile_invalid');
    // Reuse the real runner's closed interpreter/image allowlists, without running code.
    try {new AnalysisRunner({profiles: {[language]: {image: profile.image, interpreter: profile.interpreter}},
      timeoutSeconds: profile.timeout_seconds, memoryMiB: profile.memory_mib});}
    catch {throw fail('analysis_profile_invalid');}
    copy[language] = Object.freeze({...profile});
  }
  return Object.freeze(copy);
}
export function parseManifest(claim, {jobId, token, bucket, profiles, binding}) {
  closed(claim, ['state', 'job_id', 'lease_token', 'manifest_json', 'manifest_sha256', 'attempt_count', 'runtime']);
  if (claim.state !== 'claimed' || claim.job_id !== uuid(jobId) || claim.lease_token !== uuid(token)
    || typeof claim.manifest_json !== 'string' || Buffer.byteLength(claim.manifest_json) > LIMITS.maximumManifestBytes
    || !SHA256.test(claim.manifest_sha256 ?? '') || sha256(claim.manifest_json) !== claim.manifest_sha256) throw fail('analysis_claim_invalid');
  integer(claim.attempt_count, 1, 1);
  closed(claim.runtime, ['window_id', 'stack_id', 'profiles_sha256']);
  if (!binding || Object.keys(binding).some(key => claim.runtime[key] !== binding[key])) throw fail('analysis_runtime_binding_invalid');
  const value = parseJson(Buffer.from(claim.manifest_json), LIMITS.maximumManifestBytes, 'analysis_manifest_invalid');
  closed(value, ['schemaVersion', 'job_id', 'organization_id', 'project_id', 'requestor_id', 'language', 'layer_ids', 'source_bindings', 'input', 'profile', 'output']);
  if (value.schemaVersion !== 'opengeo.analysis.manifest.1' || value.job_id !== jobId || !LANGUAGES.includes(value.language)) throw fail('analysis_manifest_invalid');
  uuid(value.organization_id);uuid(value.project_id);uuid(value.requestor_id);
  if (!Array.isArray(value.layer_ids) || value.layer_ids.length > LIMITS.maximumLayers || new Set(value.layer_ids).size !== value.layer_ids.length
    || value.layer_ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw fail('analysis_manifest_invalid');
  if (!Array.isArray(value.source_bindings) || value.source_bindings.length > value.layer_ids.length) throw fail('analysis_manifest_invalid');
  const bound = new Set();
  for (const binding of value.source_bindings) {
    closed(binding, ['layer_id', 'dataset_id'], ['dataset_version_id', 'source_version', 'feature_generation']);
    if (!value.layer_ids.includes(binding.layer_id) || bound.has(binding.layer_id)) throw fail('analysis_manifest_invalid');
    bound.add(binding.layer_id);uuid(binding.dataset_id);
    if (binding.dataset_version_id !== undefined) uuid(binding.dataset_version_id);
    for (const key of ['source_version', 'feature_generation']) if (binding[key] !== undefined) integer(binding[key], 0, Number.MAX_SAFE_INTEGER);
  }
  const prefix = `organizations/${value.organization_id}/projects/${value.project_id}/analysis/${jobId}/`;
  objectDescriptor(value.input, {maximum: LIMITS.maximumBundleBytes, bucket, key: prefix + 'snapshot.json'});
  closed(value.output, ['bucket', 'key']);
  if (value.output.bucket !== bucket || value.output.key !== prefix + 'result.json') throw fail('analysis_object_invalid');
  const admitted = profiles[value.language];
  if (!admitted || Object.keys(value.profile ?? {}).sort().join(',') !== Object.keys(admitted).sort().join(',')
    || Object.keys(admitted).some(key => value.profile[key] !== admitted[key])) throw fail('analysis_profile_invalid');
  return {...value, manifest_sha256: claim.manifest_sha256};
}
export function parseSnapshot(bytes, manifest) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== manifest.input.size_bytes || sha256(bytes) !== manifest.input.checksum_sha256) throw fail('analysis_snapshot_mismatch');
  const value = parseJson(bytes, LIMITS.maximumBundleBytes, 'analysis_snapshot_invalid');
  closed(value, ['schemaVersion', 'language', 'code', 'layers'], [], 'analysis_snapshot_invalid');
  if (value.schemaVersion !== 'opengeo.analysis.snapshot.1' || value.language !== manifest.language
    || typeof value.code !== 'string' || !value.code.trim() || value.code.includes('\0')
    || Buffer.byteLength(value.code) > LIMITS.maximumCodeBytes || !Array.isArray(value.layers)
    || value.layers.length !== manifest.layer_ids.length) throw fail('analysis_snapshot_invalid');
  let total = 0;
  for (const [index, layer] of value.layers.entries()) {
    closed(layer, ['id', 'title', 'geojson'], [], 'analysis_snapshot_invalid');
    if (layer.id !== manifest.layer_ids[index] || typeof layer.title !== 'string' || layer.title.length > 500
      || layer.geojson?.type !== 'FeatureCollection' || !Array.isArray(layer.geojson.features)) throw fail('analysis_snapshot_invalid');
    total += jsonBytes(layer.geojson, LIMITS.maximumInputBytes, 'analysis_snapshot_invalid').length;
  }
  if (total > LIMITS.maximumInputBytes) throw fail('analysis_snapshot_invalid');
  // AnalysisRunner performs the full geometry/coordinate validation before launch.
  return value;
}
export function validateResult(value, manifest, snapshot) {
  closed(value, ['stdout', 'stderr', 'geojson', 'execution'], [], 'analysis_result_invalid');
  if (typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > LIMITS.maximumLogBytes
    || value.geojson !== null && (value.geojson?.type !== 'FeatureCollection' || !Array.isArray(value.geojson.features))) throw fail('analysis_result_invalid');
  if (value.geojson !== null) jsonBytes(value.geojson, LIMITS.maximumResultBytes, 'analysis_result_invalid');
  const e = value.execution;
  closed(e, ['language', 'runtimeImage', 'interpreter', 'exitCode', 'signal', 'durationMs', 'codeSha256', 'inputSha256', 'limits', 'cleanup', 'network'], [], 'analysis_result_invalid');
  if (e.language !== manifest.language || e.runtimeImage !== manifest.profile.image || e.interpreter !== manifest.profile.interpreter
    || !Number.isInteger(e.exitCode) || e.signal !== null || e.network !== 'none' || e.codeSha256 !== sha256(snapshot.code)
    || !Number.isFinite(e.durationMs) || e.durationMs < 0 || !Array.isArray(e.inputSha256)
    || e.inputSha256.length !== snapshot.layers.length) throw fail('analysis_result_invalid');
  closed(e.cleanup, ['containerRemoved', 'stagingRemoved']);
  if (e.cleanup.containerRemoved !== true || e.cleanup.stagingRemoved !== true) throw fail('analysis_cleanup_failed');
  if (e.limits?.timeoutSeconds !== manifest.profile.timeout_seconds || e.limits?.memoryMiB !== manifest.profile.memory_mib
    || e.limits?.pids !== LIMITS.pids || e.limits?.cpuMillis !== LIMITS.cpuMillis) throw fail('analysis_result_invalid');
  for (const [index, layer] of snapshot.layers.entries()) {
    closed(e.inputSha256[index], ['id', 'checksumSha256']);
    if (e.inputSha256[index].id !== layer.id || e.inputSha256[index].checksumSha256 !== sha256(jsonBytes(layer.geojson, LIMITS.maximumInputBytes))) throw fail('analysis_result_invalid');
  }
  if (e.exitCode !== 0 && value.geojson !== null) throw fail('analysis_result_invalid');
  return {...value, execution: {...e, jobId: manifest.job_id, manifestSha256: manifest.manifest_sha256,
    snapshotSha256: manifest.input.checksum_sha256, inputCustody: 'user-provided-snapshot'}};
}
export function parseCommand(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 512) throw fail('analysis_command_invalid');
  const value = parseJson(Buffer.from(body), 512, 'analysis_command_invalid');
  closed(value, ['schemaVersion', 'analysis_job_id'], [], 'analysis_command_invalid');
  if (value.schemaVersion !== 'opengeo.analysis.command.1') throw fail('analysis_command_invalid');
  return uuid(value.analysis_job_id);
}
