import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {AwsSigV4Client, boundedResponseBytes} from '../../observable-coordinator/src/aws-sigv4.mjs';
import {AnalysisCoordinator, AwsAnalysisStorage, RdsAnalysisRepository} from './coordinator.mjs';
import {BUCKET, LANGUAGES, SHA256, closed, fail, integer, parseCommand, parseProfiles, sha256, uuid} from './contracts.mjs';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function parseProfileEnvelope(text, expectedSha256) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384 || !SHA256.test(expectedSha256 ?? '')) throw fail('analysis_profile_invalid');
  let envelope;try {envelope = JSON.parse(text);} catch {throw fail('analysis_profile_invalid');}
  closed(envelope, ['schemaVersion', 'architecture', 'profiles'], [], 'analysis_profile_invalid');
  closed(envelope.profiles, LANGUAGES, [], 'analysis_profile_invalid');
  if (envelope.schemaVersion !== 1 || sha256(canonical(envelope)) !== expectedSha256) throw fail('analysis_profile_invalid');
  const profiles = {};
  for (const language of LANGUAGES) {
    closed(envelope.profiles[language], ['image', 'interpreter'], [], 'analysis_profile_invalid');
    profiles[language] = {...envelope.profiles[language], architecture: envelope.architecture, timeout_seconds: 10, memory_mib: 256};
  }
  return parseProfiles(profiles);
}
export class AnalysisRuntimeSettings {
  static fromEnvironment(env = process.env) {
    const enabled = env.OPEN_GEO_ANALYSIS_ENABLED ?? 'false';
    if (!['true', 'false'].includes(enabled)) throw fail('analysis_configuration_invalid');
    if (enabled === 'false') return {enabled: false};
    return new AnalysisRuntimeSettings({stage: env.OPEN_GEO_ANALYSIS_STAGE, region: env.OPEN_GEO_AWS_REGION,
      databaseClusterArn: env.OPEN_GEO_DATA_API_CLUSTER_ARN, databaseSecretArn: env.OPEN_GEO_DATA_API_SECRET_ARN,
      databaseName: env.OPEN_GEO_DB_NAME ?? 'opengeo', bucket: env.OPEN_GEO_APPLICATION_BUCKET,
      kmsKeyArn: env.OPEN_GEO_APPLICATION_KMS_KEY_ARN, queueUrl: env.OPEN_GEO_ANALYSIS_QUEUE_URL,
      queueArn: env.OPEN_GEO_ANALYSIS_QUEUE_ARN, profilesJson: env.OPEN_GEO_ANALYSIS_PROFILES_JSON,
      profilesSha256: env.OPEN_GEO_ANALYSIS_PROFILES_SHA256, windowId: env.OPEN_GEO_ANALYSIS_WINDOW_ID,
      stackId: env.OPEN_GEO_ANALYSIS_STACK_ID, temporaryDirectory: env.OPEN_GEO_ANALYSIS_WORKSPACE_ROOT,
      maximumHostSeconds: Number(env.OPEN_GEO_ANALYSIS_MAXIMUM_HOST_SECONDS ?? 300)});
  }
  constructor(value) {
    const cluster = /^arn:aws:rds:([a-z0-9-]+):(\d{12}):cluster:[A-Za-z0-9-]+$/.exec(value.databaseClusterArn ?? '');
    const secret = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(value.databaseSecretArn ?? '');
    const kms = /^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]{36}$/.exec(value.kmsKeyArn ?? '');
    const stack = /^arn:aws:cloudformation:([a-z0-9-]+):(\d{12}):stack\/[A-Za-z0-9-]+\/[0-9a-f-]{36}$/.exec(value.stackId ?? '');
    const queue = /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,80})$/.exec(value.queueArn ?? '');
    if (!['dev', 'staging', 'production'].includes(value.stage) || !cluster || !secret || !kms || !stack || !queue
      || [secret, kms, stack, queue].some(match => match[1] !== cluster[1] || match[2] !== cluster[2])
      || cluster[1] !== value.region || value.databaseName !== 'opengeo' || !BUCKET.test(value.bucket ?? '')
      || value.queueUrl !== `https://sqs.${value.region}.amazonaws.com/${queue[2]}/${queue[3]}`
      || typeof value.temporaryDirectory !== 'string' || !value.temporaryDirectory.startsWith('/')
      || /[:,\r\n]/.test(value.temporaryDirectory)) throw fail('analysis_configuration_invalid');
    uuid(value.windowId);integer(value.maximumHostSeconds, 30, 600);
    this.profiles = parseProfileEnvelope(value.profilesJson, value.profilesSha256);
    Object.assign(this, value, {enabled: true});
    this.binding = Object.freeze({window_id: value.windowId, stack_id: value.stackId, profiles_sha256: value.profilesSha256});
  }
}

/** Dedicated queue policy and short bounded visibility, using the common signed transport. */
export class AwsAnalysisQueue {
  constructor(settings, {client} = {}) {this.settings = settings;this.client = client ?? new AwsSigV4Client({region: settings.region});}
  async #call(operation, payload) {
    const response = await this.client.request({service: 'sqs', method: 'POST', host: `sqs.${this.settings.region}.amazonaws.com`, path: '/',
      headers: {'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${operation}`},
      body: Buffer.from(JSON.stringify({QueueUrl: this.settings.queueUrl, ...payload})), maximumResponseBytes: 65536});
    const bytes = await boundedResponseBytes(response, 65536);
    if (!response.ok) throw fail('analysis_queue_unavailable');
    let value;try {value = bytes.length ? JSON.parse(bytes) : {};} catch {throw fail('analysis_queue_response_invalid');}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('analysis_queue_response_invalid');return value;
  }
  async receive() {
    const value = await this.#call('ReceiveMessage', {MaxNumberOfMessages: 1, WaitTimeSeconds: 20, VisibilityTimeout: 120});
    if (value.Messages === undefined) return null;
    if (!Array.isArray(value.Messages) || value.Messages.length !== 1) throw fail('analysis_queue_response_invalid');
    const message = value.Messages[0];
    if (typeof message.MessageId !== 'string' || !message.MessageId || message.MessageId.length > 128
      || typeof message.Body !== 'string' || Buffer.byteLength(message.Body) > 512) throw fail('analysis_queue_response_invalid');
    this.#receipt(message.ReceiptHandle);
    return {messageId: message.MessageId, body: message.Body, receiptHandle: message.ReceiptHandle};
  }
  #receipt(value) {if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw fail('analysis_queue_response_invalid');}
  async delete(receipt) {this.#receipt(receipt);await this.#call('DeleteMessage', {ReceiptHandle: receipt});}
  async changeVisibility(receipt, seconds = 120) {this.#receipt(receipt);integer(seconds, 20, 120);await this.#call('ChangeMessageVisibility', {ReceiptHandle: receipt, VisibilityTimeout: seconds});}
}
async function pauseForClaim(signal) {
  try {await delay(5000, undefined, {signal});} catch (error) {if (error.name !== 'AbortError') throw error;}
}
export async function runAnalysisQueue({queue, coordinator, signal, maximumJobs = 4, maximumIdleReceives = 3,
  pause = pauseForClaim} = {}) {
  integer(maximumJobs, 1, 4);integer(maximumIdleReceives, 1, 3);
  if (!signal || typeof signal.aborted !== 'boolean' || typeof pause !== 'function'
    || typeof coordinator?.closeWindow !== 'function') throw fail('analysis_configuration_invalid');
  let processed = 0, idle = 0, windowClosed = false;
  const seen = new Set();
  const closeWindow = async reason => {
    const result = await coordinator.closeWindow(reason);
    closed(result, ['state']);
    if (!['closed', 'busy', 'binding_changed'].includes(result.state)) throw fail('analysis_database_response_invalid');
    if (result.state === 'binding_changed') throw fail('analysis_runtime_binding_invalid');
    if (result.state === 'closed') windowClosed = true;
    return windowClosed;
  };
  try {
    while (!signal.aborted) {
      if (processed >= maximumJobs || idle >= maximumIdleReceives) {
        const reason = processed >= maximumJobs ? 'job_limit' : 'idle';
        // Submission and this close serialize on the same durable control row.
        // A job admitted just before an idle observation keeps its consumer.
        if (await closeWindow(reason)) return {processed, stopped: reason};
        idle = 0;
      }
      const message = await queue.receive();
      if (signal.aborted) break;
      if (message === null) {idle++;continue;}
      idle = 0;const job = parseCommand(message.body);
      let visibility = Promise.resolve(), visibilityError;
      const timer = setInterval(() => {visibility = visibility.then(() => queue.changeVisibility(message.receiptHandle)).catch(error => {visibilityError = error;});}, 60000);timer.unref?.();
      let result;
      try {
        // A booting host may precede CloudFormation/controller readiness. Keep
        // one receipt while waiting; startup must not spend SQS redrive attempts.
        for (let claims = 0; claims < 120 && !signal.aborted && !visibilityError; claims++) {
          result = await coordinator.run(job, {signal});
          if (result.state !== 'busy') break;
          await pause(signal);
        }
      } finally {clearInterval(timer);await visibility;}
      if (signal.aborted) break;
      if (visibilityError || !result?.acknowledge) return {processed, stopped: result?.state ?? 'uncertain', unacknowledged: true};
      if (!seen.has(job)) {seen.add(job);processed++;}
      await queue.delete(message.receiptHandle);
    }
    return {processed, stopped: 'signal'};
  } finally {
    // The local host timeout may precede an operator's longer window. Retire
    // admission before exit in either case; cancellation/cleanup remain durable.
    if (!windowClosed && !(await closeWindow(signal.aborted ? 'signal' : 'failure'))) throw fail('analysis_window_close_failed');
  }
}
export function productionDependencies(settings, {client, dataClient, runnerFactory} = {}) {
  if (settings.enabled !== true) throw fail('analysis_disabled');
  return {queue: new AwsAnalysisQueue(settings, {client}), coordinator: new AnalysisCoordinator({enabled: true,
    bucket: settings.bucket, profiles: settings.profiles, binding: settings.binding, temporaryDirectory: settings.temporaryDirectory,
    repository: new RdsAnalysisRepository(settings, {client: dataClient}), storage: new AwsAnalysisStorage(settings, {client}),
    ...(runnerFactory ? {runnerFactory} : {})})};
}
export async function main(environment = process.env) {
  const settings = AnalysisRuntimeSettings.fromEnvironment(environment);
  if (!settings.enabled) return {processed: 0, stopped: 'disabled'};
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, settings.maximumHostSeconds * 1000);timer.unref?.();
  process.once('SIGTERM', abort);process.once('SIGINT', abort);
  try {return await runAnalysisQueue({...productionDependencies(settings), signal: controller.signal});}
  finally {clearTimeout(timer);process.removeListener('SIGTERM', abort);process.removeListener('SIGINT', abort);}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await main()));}
  catch (error) {console.error(JSON.stringify({error_code: /^analysis_[a-z_]+$/.test(error.code ?? '') ? error.code : 'analysis_runtime_failed'}));process.exitCode = 1;}
}
