import {artifactLeaseResolver} from './artifact-lease-api.mjs';
import {readPublicExact} from "./public-file-transport.mjs";
import {validateGitHubExecution} from "./github-runner.mjs";
import {CoordinatorContractError} from "./contracts.mjs";
import {coordinateBuild} from "./coordinator.mjs";
import {PodmanRunner} from "./podman-runner.mjs";
import {configuredPageCacheStore} from "./page-cache-store.mjs";
import {AwsDependencyError, AwsSigV4Client, boundedResponseBytes} from "./aws-sigv4.mjs";
import {
  AwsExactVersionStorage,
  AwsRdsDataClient,
  ObservableCoordinatorSettings,
  RdsDataBuildRepository
} from "./production-adapters.mjs";

const COMMAND_SCHEMA = "opengeo.observable-build.command.1.0.0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseBuildCommand(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 512) {
    throw new CoordinatorContractError("build_command_invalid");
  }
  let value;
  try { value = JSON.parse(body); }
  catch { throw new CoordinatorContractError("build_command_invalid"); }
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "build_job_id,schema" ||
    value.schema !== COMMAND_SCHEMA || !UUID.test(value.build_job_id ?? "")
  ) {
    throw new CoordinatorContractError("build_command_invalid");
  }
  return Object.freeze({buildJobId: value.build_job_id});
}

export async function processBuildCommand(body, dependencies) {
  const command = parseBuildCommand(body);
  return coordinateBuild({
    buildJobId: command.buildJobId,
    expectedBucket: dependencies.expectedBucket,
    expectedArchiveBucket: dependencies.expectedArchiveBucket ?? dependencies.expectedBucket,
    repository: dependencies.repository,
    storage: dependencies.storage,
    runner: dependencies.runner,
    pageCacheStore: dependencies.pageCacheStore,
    expectedCompilerImageDigest: dependencies.expectedCompilerImageDigest ?? null,
    acceptedCompilerImageDigests: dependencies.acceptedCompilerImageDigests,
    heartbeatIntervalMilliseconds: dependencies.heartbeatIntervalMilliseconds ?? 60_000,
    publicStagingMilliseconds: dependencies.publicStagingMilliseconds
  });
}

export async function handleSqsEvent(event, dependencies) {
  if (
    event === null || typeof event !== "object" || !Array.isArray(event.Records) ||
    event.Records.length < 1 || event.Records.length > 10
  ) {
    throw new CoordinatorContractError("build_event_invalid");
  }
  const failures = [];
  for (const record of event.Records) {
    const messageId = record?.messageId;
    if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 128 || typeof record?.body !== "string") {
      throw new CoordinatorContractError("build_event_invalid");
    }
    try {
      const result = await processBuildCommand(record.body, dependencies);
      if (["pending", "busy", "not_ready"].includes(result.status)) {
        failures.push({itemIdentifier: messageId});
      }
    } catch {
      failures.push({itemIdentifier: messageId});
    }
  }
  return {batchItemFailures: failures};
}

export class AwsSqsBuildQueue {
  constructor({region, queueUrl, client} = {}) {
    let parsed;
    try { parsed = new URL(queueUrl); }
    catch { throw new CoordinatorContractError("queue_configuration_invalid"); }
    if (
      parsed.protocol !== "https:" || parsed.search || parsed.hash ||
      parsed.hostname !== `sqs.${region}.amazonaws.com` ||
      !/^\/\d{12}\/[A-Za-z0-9_-]{1,80}$/.test(parsed.pathname)
    ) {
      throw new CoordinatorContractError("queue_configuration_invalid");
    }
    this.region = region;
    this.queueUrl = parsed.toString().replace(/\/$/, "");
    this.client = client ?? new AwsSigV4Client({region});
  }

  async receive() {
    const value = await this.#call("ReceiveMessage", {
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 1200,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"]
    });
    if (value.Messages === undefined) return null;
    if (!Array.isArray(value.Messages) || value.Messages.length !== 1) {
      throw new AwsDependencyError("sqs_response_invalid");
    }
    const message = value.Messages[0];
    if (
      typeof message?.MessageId !== "string" || message.MessageId.length > 128 ||
      typeof message?.ReceiptHandle !== "string" || message.ReceiptHandle.length > 4096 ||
      typeof message?.Body !== "string" || Buffer.byteLength(message.Body) > 512
    ) {
      throw new AwsDependencyError("sqs_response_invalid");
    }
    return {messageId: message.MessageId, receiptHandle: message.ReceiptHandle, body: message.Body};
  }

  async delete(receiptHandle) {
    this.#receipt(receiptHandle);
    await this.#call("DeleteMessage", {QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle});
  }

  async changeVisibility(receiptHandle, visibilitySeconds = 1200) {
    this.#receipt(receiptHandle);
    if (!Number.isSafeInteger(visibilitySeconds) || visibilitySeconds < 900 || visibilitySeconds > 3600) {
      throw new CoordinatorContractError("queue_visibility_invalid");
    }
    await this.#call("ChangeMessageVisibility", {
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilitySeconds
    });
  }

  async #call(operation, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const response = await this.client.request({
      service: "sqs",
      method: "POST",
      host: `sqs.${this.region}.amazonaws.com`,
      path: "/",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `AmazonSQS.${operation}`
      },
      body,
      maximumResponseBytes: 65_536
    });
    const bytes = await boundedResponseBytes(response, 65_536);
    if (!response.ok) throw new AwsDependencyError("sqs_unavailable");
    try {
      const value = bytes.length === 0 ? {} : JSON.parse(bytes);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new AwsDependencyError("sqs_response_invalid");
    }
  }

  #receipt(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new CoordinatorContractError("queue_receipt_invalid");
    }
  }
}

export async function runHostQueue({queue, dependencies, maximumIdleReceives = 3, signal} = {}) {
  if (!Number.isSafeInteger(maximumIdleReceives) || maximumIdleReceives < 0 || maximumIdleReceives > 30) {
    throw new CoordinatorContractError("runtime_configuration_invalid");
  }
  let idle = 0;
  let processed = 0;
  while (
    !signal?.aborted &&
    (maximumIdleReceives === 0 || idle < maximumIdleReceives)
  ) {
    const message = await queue.receive();
    if (message === null) {
      idle += 1;
      continue;
    }
    idle = 0;
    let visibilityAvailable = true;
    let visibility = Promise.resolve();
    const timer = setInterval(() => {
      visibility = visibility.then(async () => {
        try { await queue.changeVisibility(message.receiptHandle, 1200); }
        catch { visibilityAvailable = false; }
      });
    }, 300_000);
    timer.unref?.();
    let outcome;
    try {
      outcome = await handleSqsEvent(
        {Records: [{messageId: message.messageId, body: message.body}]},
        dependencies
      );
    } finally {
      clearInterval(timer);
      await visibility;
    }
    if (visibilityAvailable && outcome.batchItemFailures.length === 0) {
      await queue.delete(message.receiptHandle);
    }
    processed += 1;
  }
  return {processed, stopped: signal?.aborted === true ? "signal" : "idle"};
}

export function productionDependencies(environment = process.env, {enablePublicFileStaging = false} = {}) {
  if (typeof enablePublicFileStaging !== "boolean") throw new CoordinatorContractError("production_configuration_invalid");
  if (enablePublicFileStaging && validateGitHubExecution(environment).sourceMode !== "opengeo") {
    throw new CoordinatorContractError("public_file_staging_configuration_invalid");
  }
  const settings = ObservableCoordinatorSettings.fromEnvironment(environment);
  const dataApi = new AwsRdsDataClient(settings);
  return {
    expectedBucket: settings.bucket,
    expectedArchiveBucket: settings.archiveBucket,
    expectedCompilerImageDigest: settings.compilerImageDigest,
    acceptedCompilerImageDigests: settings.compilerImageDigests,
    repository: new RdsDataBuildRepository(dataApi, {
      artifactResolver: artifactLeaseResolver(environment.OPEN_GEO_OBSERVABLE_ARTIFACT_API_ORIGIN)
    }),
    storage: new AwsExactVersionStorage(settings, {
      publicFileReader: enablePublicFileStaging ? readPublicExact : null
    }),
    pageCacheStore: configuredPageCacheStore(settings, environment),
    runner: new PodmanRunner({
      temporaryDirectory: environment.OPEN_GEO_OBSERVABLE_WORKSPACE_ROOT ?? "/tmp",
      imageRepository: environment.OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY
    })
  };
}

export function productionQueue(environment = process.env) {
  const settings = ObservableCoordinatorSettings.fromEnvironment(environment);
  return new AwsSqsBuildQueue({
    region: settings.region,
    queueUrl: environment.OPEN_GEO_OBSERVABLE_BUILD_QUEUE_URL
  });
}
