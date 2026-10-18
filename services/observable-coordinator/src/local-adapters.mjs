import {execFile} from "node:child_process";
import {CoordinatorContractError, sha256} from "./contracts.mjs";
import {RdsDataBuildRepository} from "./production-adapters.mjs";
import {processBuildCommand} from "./runtime.mjs";
import {PodmanRunner} from "./podman-runner.mjs";

// A private stdin channel into the already running local API container. The
// database still authorizes every claim/heartbeat/completion as its dedicated
// coordinator role. No database password or source bytes go in argv or logs.
export function localPublicationBridge(apiContainer) {
  if (!/^opengeo-[a-z0-9-]+-api$/.test(apiContainer ?? "")) {
    throw new CoordinatorContractError("local_container_invalid");
  }
  return async request => new Promise((resolve, reject) => {
    const child = execFile("podman", ["exec", "-i", apiContainer, "python",
      "/repo/scripts/local-publication-bridge.py"], {
      timeout: 30_000, maxBuffer: 150_000_000, encoding: "utf8"
    }, (error, stdout) => {
      if (error) return reject(new CoordinatorContractError("local_transport_unavailable"));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new CoordinatorContractError("local_transport_invalid")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// The local public server reads through the same canonical publication bridge.
// Bound process fanout without caching content or changing read authorization.
export function boundedLocalPublicationReader(bridge) {
  if (typeof bridge !== "function") throw new CoordinatorContractError("local_configuration_invalid");
  let active = 0, outstanding = 0;
  const waiting = [];
  return async request => {
    if (request === null || typeof request !== "object" || Array.isArray(request) ||
        request.operation !== "public-read") {
      throw new CoordinatorContractError("local_publication_read_invalid");
    }
    if (outstanding >= 64) throw new CoordinatorContractError("local_publication_read_busy");
    outstanding++;
    if (active === 4) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await bridge(request); }
    finally {
      outstanding--;
      const next = waiting.shift();
      if (next) next(); // Transfer this permit to the oldest waiting read.
      else active--;
    }
  };
}

function record(value, bytes) {
  return {bucket: value.bucket, objectKey: value.key, s3VersionId: value.version_id,
    etag: value.etag, contentType: value.content_type,
    checksumSha256: value.checksum_sha256,
    ...(bytes === undefined ? {sizeBytes:value.size_bytes} : {bytes})};
}

export class LocalExactVersionStorage {
  constructor(bridge) { this.bridge = bridge; }

  async readExact(pin) {
    const value = await this.bridge({operation: "read", ...pin});
    const bytes = Buffer.from(value.body, "base64");
    if (value.bucket !== pin.bucket || value.key !== pin.objectKey || value.version_id !== pin.s3VersionId ||
        bytes.length !== value.size_bytes || bytes.length > pin.maximumBytes || sha256(bytes) !== value.checksum_sha256) {
      throw new CoordinatorContractError("stored_source_invalid");
    }
    return record(value, bytes);
  }

  readArchiveExact(pin) { return this.readExact(pin); }
  readArtifactExact(pin) { return this.readExact(pin); }

  async writeExact({bytes, ...pin}) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 ||
        bytes.length > (pin.maximumBytes ?? 16_777_216) || sha256(bytes) !== pin.checksumSha256) {
      throw new CoordinatorContractError("stored_output_invalid");
    }
    return record(await this.bridge({operation: "write", ...pin, body: bytes.toString("base64")}));
  }
}

export function localDependencies({bridge, compilerImageDigest, runner = new PodmanRunner()} = {}) {
  if (typeof bridge !== "function" || !/^sha256:[a-f0-9]{64}$/.test(compilerImageDigest ?? "")) {
    throw new CoordinatorContractError("local_configuration_invalid");
  }
  return {expectedBucket: "local-pilot.invalid", expectedCompilerImageDigest: compilerImageDigest,
    repository: new RdsDataBuildRepository({execute: (sql, parameters) => bridge({operation: "sql", sql, parameters})}, {
      artifactResolver: ({buildJobId, coordinatorToken, authority}) => bridge({
        operation: "resolve-artifact-lease", buildJobId, coordinatorToken,
        organizationId: authority.organizationId, userId: authority.userId
      })
    }),
    storage: new LocalExactVersionStorage(bridge), runner};
}

export async function processLocalBuildQueue({bridge, compilerImageDigest, maximumJobs = 4, runner} = {}) {
  if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 4) {
    throw new CoordinatorContractError("local_job_limit_invalid");
  }
  const dependencies = localDependencies({bridge, compilerImageDigest, runner});
  const outcomes = [];
  for (let index = 0; index < maximumJobs; index++) {
    const message = await bridge({operation: "receive"});
    if (message === null) break;
    const outcome = await processBuildCommand(message.body, dependencies);
    outcomes.push(outcome);
    // Preserve pending/busy jobs for deliberate continuation; never spin on a
    // failed lease or replay an already retained compiler result in this batch.
    if (["pending", "busy", "not_ready", "lost"].includes(outcome.status)) break;
    await bridge({operation: "acknowledge", id: message.id});
  }
  return outcomes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function publicationReview(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message) ||
      Object.keys(message).sort().join(",") !== "body,id" ||
      typeof message.id !== "string" || !UUID.test(message.id) ||
      typeof message.body !== "string" || Buffer.byteLength(message.body) > 512) {
    throw new CoordinatorContractError("local_publication_command_invalid");
  }
  let command;
  try { command = JSON.parse(message.body); }
  catch { throw new CoordinatorContractError("local_publication_command_invalid"); }
  if (command === null || typeof command !== "object" || Array.isArray(command) ||
      Object.keys(command).sort().join(",") !== "review_id,schema" ||
      command.schema !== "opengeo.framework-publication.command.1.0.0" ||
      typeof command.review_id !== "string" || !UUID.test(command.review_id)) {
    throw new CoordinatorContractError("local_publication_command_invalid");
  }
  return command.review_id;
}

export async function processLocalPublicationQueue({bridge, maximumJobs = 4} = {}) {
  if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 4) {
    throw new CoordinatorContractError("local_job_limit_invalid");
  }
  if (typeof bridge !== "function") throw new CoordinatorContractError("local_configuration_invalid");
  const outcomes = [];
  for (let index = 0; index < maximumJobs; index++) {
    const message = await bridge({operation: "receive", queue: "framework-publications"});
    if (message === null) break;
    const reviewId = publicationReview(message);
    // Only consume an already approved review. The canonical publisher retains
    // authority checks, destination selection and its 64-file invocation limit.
    const status = await bridge({operation: "publish", reviewId});
    if (typeof status !== "string") throw new CoordinatorContractError("local_publication_result_invalid");
    outcomes.push({reviewId, status});
    // A retry may have checkpointed part of a large output. Leave that exact
    // message queued for deliberate continuation, including busy/failed claims.
    if (status !== "deployed") break;
    await bridge({operation: "acknowledge", queue: "framework-publications", id: message.id});
  }
  return outcomes;
}
