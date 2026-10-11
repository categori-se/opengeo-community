import {randomUUID} from "node:crypto";
import {verifiedPageCache, verifiedPageCacheStats} from "./page-cache-transport.mjs";
import {approvedCompilerDigests} from "./compiler-policy.mjs";
import {
  CoordinatorContractError,
  buildResult,
  dataInputPins,
  executionLimits,
  maximumOutputFileBytes,
  parseClaim,
  parseCompilerReport,
  parseResolvedDataFiles,
  parseResolvedArtifactFiles,
  runnerInvocation,
  verifyRead,
  verifyPublicRead,
  verifyRunnerExecution,
  verifyRunnerOutputs,
  verifyWrite
} from "./contracts.mjs";

export const LEASE_SECONDS = 900;
export const MAX_ATTEMPTS = 3;
export const PUBLIC_STAGING_MILLISECONDS = 120_000;

export async function coordinateBuild({
  buildJobId,
  expectedBucket,
  expectedArchiveBucket = expectedBucket,
  repository,
  storage,
  runner,
  pageCacheStore,
  expectedCompilerImageDigest = null,
  acceptedCompilerImageDigests,
  heartbeatIntervalMilliseconds = 60_000,
  publicStagingMilliseconds = PUBLIC_STAGING_MILLISECONDS
}) {
  const approved = expectedCompilerImageDigest !== null || acceptedCompilerImageDigests !== undefined
    ? approvedCompilerDigests(expectedCompilerImageDigest, acceptedCompilerImageDigests) : null;
  const coordinatorToken = randomUUID();
  const rawClaim = await repository.claim(buildJobId, coordinatorToken, LEASE_SECONDS);
  if (rawClaim === null || typeof rawClaim !== "object" || Array.isArray(rawClaim)) {
    throw new CoordinatorContractError("claim_response_invalid");
  }
  if (
    !["claimed", "not_ready", "busy", "already_succeeded", "already_failed", "already_cancelled"]
      .includes(rawClaim.claimStatus) ||
    rawClaim.buildJobId !== buildJobId
  ) {
    throw new CoordinatorContractError("claim_response_invalid");
  }
  if (rawClaim.claimStatus !== "claimed") {
    return {status: rawClaim.claimStatus, buildJobId};
  }
  try {
    const claim = parseClaim(rawClaim, expectedBucket);
    if (
      approved !== null && !approved.includes(claim.request.compilerImageDigest)
    ) {
      throw new CoordinatorContractError("compiler_image_mismatch");
    }
    const inputs = new Map();
    const resolveData = async () => {
      if (!claim.inputManifest.dataAttachments) return [];
      if (typeof repository.resolveDataAttachments !== "function"
        || (claim.inputManifest.dataAttachments.length && typeof storage.readArchiveExact !== "function")) {
        throw new CoordinatorContractError("archive_staging_unavailable");
      }
      if (claim.inputManifest.referencedFiles?.length && typeof storage.readPublicExact !== "function") {
        throw new CoordinatorContractError("public_file_staging_unavailable");
      }
      return parseResolvedDataFiles(await repository.resolveDataAttachments(buildJobId, coordinatorToken), claim, expectedArchiveBucket);
    };
    const resolveArtifacts = async () => {
      if (!claim.artifactInputs) return [];
      if (typeof repository.resolveArtifactInputs !== "function" || typeof storage.readArtifactExact !== "function") {
        throw new CoordinatorContractError("artifact_staging_unavailable");
      }
      return parseResolvedArtifactFiles(await repository.resolveArtifactInputs(buildJobId, coordinatorToken), claim, expectedBucket);
    };
    const dataFiles = await resolveData();
    const artifactFiles = await resolveArtifacts();
    const recheckData = async () => {
      const confirmedArtifacts = await resolveArtifacts();
      if (JSON.stringify(confirmedArtifacts) !== JSON.stringify(artifactFiles)) throw new CoordinatorContractError("artifact_resolution_changed");
      const confirmed = await resolveData();
      if (JSON.stringify(confirmed) !== JSON.stringify(dataFiles)) throw new CoordinatorContractError("archive_resolution_changed");
    };
    const requireLease = async () => {
      if (!(await repository.heartbeat(buildJobId, coordinatorToken, LEASE_SECONDS))) {
        throw new CoordinatorContractError("build_lease_lost");
      }
    };
    for (const file of claim.inputManifest.files) {
      const stored = await storage.readExact({
        bucket: file.bucket,
        objectKey: file.objectKey,
        s3VersionId: file.s3VersionId,
        maximumBytes: file.sizeBytes
      });
      inputs.set(file.path, verifyRead(file, stored));
    }
    for (const file of dataFiles.filter(file => file.kind !== "referenced-public-file")) {
      const stored = await storage.readArchiveExact({
        bucket: file.bucket, objectKey: file.objectKey, s3VersionId: file.s3VersionId,
        maximumBytes: file.sizeBytes, organizationId: claim.organizationId, datasetId: file.datasetId
      });
      inputs.set(file.path, verifyRead(file, stored));
    }
    const retainedArtifactReads = new Map();
    for (const file of artifactFiles) {
      const identity = JSON.stringify([file.bucket, file.objectKey, file.s3VersionId]);
      let stored = retainedArtifactReads.get(identity);
      if (!stored) stored = await storage.readArtifactExact({bucket:file.bucket, objectKey:file.objectKey,
        s3VersionId:file.s3VersionId, maximumBytes:file.sizeBytes,
        organizationId:claim.organizationId, artifactId:file.artifactId});
      inputs.set(file.path, verifyRead(file, stored));
      retainedArtifactReads.set(identity, stored);
    }
    const publicFiles = dataFiles.filter(file => file.kind === "referenced-public-file");
    if (publicFiles.length) {
      if (!Number.isSafeInteger(publicStagingMilliseconds) || publicStagingMilliseconds < 1
        || publicStagingMilliseconds > PUBLIC_STAGING_MILLISECONDS) throw new CoordinatorContractError("public_file_staging_limit_invalid");
      const retainedPublicReads = new Map();
      await workWithLease({buildJobId, coordinatorToken, repository, heartbeatIntervalMilliseconds,
        timeoutMilliseconds: publicStagingMilliseconds,
        async work(signal) {
          for (const file of publicFiles) {
            if (signal.aborted) throw new CoordinatorContractError("public_file_staging_cancelled");
            const identity = JSON.stringify([file.url, file.contentType, file.sizeBytes, file.checksumSha256]);
            let stored = retainedPublicReads.get(identity);
            if (!stored) {
              // Resolve the complete pin inventory, including aliases, before
              // every GET. A previous metadata response never grants transport.
              await requireLease();
              await recheckData();
              if (signal.aborted) throw new CoordinatorContractError("public_file_staging_cancelled");
              stored = await storage.readPublicExact({url: file.url, contentType: file.contentType,
                maximumBytes: file.sizeBytes, checksumSha256: file.checksumSha256, signal});
            }
            inputs.set(file.path, verifyPublicRead(file, stored));
            retainedPublicReads.set(identity, stored);
          }
        }
      });
    }
    await recheckData();
    await requireLease();
    const invocation = runnerInvocation(claim);
    // Host-owned storage only; no cache location or checksum is accepted in the
    // source manifest, queue command or browser request. Scope comes from the
    // verified claim, and the compiler additionally checks configuration scope.
    let cacheScope = pageCacheStore && /\.md$/i.test(claim.inputManifest.entryPath) ? {
      organizationId: claim.organizationId, projectId: claim.projectId,
      sourceProjectId: claim.sourceProjectId, compilerImageDigest: claim.request.compilerImageDigest,
      frameworkVersion: claim.request.frameworkVersion
    } : null;
    if (cacheScope && pageCacheStore.requiresAdmission) {
      try {
        const admission = await repository.admitPageCache(buildJobId, coordinatorToken);
        if (!pageCacheStore.authorize(cacheScope, admission, {buildJobId, sourceRevisionId: claim.sourceRevisionId})) cacheScope = null;
      } catch { cacheScope = null; }
    }
    if (cacheScope && typeof pageCacheStore.supports === "function" && !pageCacheStore.supports(cacheScope)) cacheScope = null;
    let incrementalPageCache;
    let cacheRead;
    if (cacheScope) {
      if (typeof pageCacheStore.read !== "function" || typeof pageCacheStore.write !== "function") {
        throw new CoordinatorContractError("page_cache_configuration_invalid");
      }
      try {
        const stored = await pageCacheStore.read(cacheScope);
        const valid = verifiedPageCache(stored);
        incrementalPageCache = valid ?? {};
        cacheRead = valid ? "hit" : stored == null ? "miss" : "invalid";
      }
      catch {incrementalPageCache = {}; cacheRead = "unavailable";}
    }
    const execution = await runWithLease({
      buildJobId,
      coordinatorToken,
      repository,
      runner,
      invocation,
      inputs,
      limits: executionLimits(claim.request),
      incrementalPageCache,
      heartbeatIntervalMilliseconds
    });
    verifyRunnerExecution(execution, {allowPageCache: Boolean(cacheScope)});
    await recheckData();
    const report = parseCompilerReport(execution.report, claim);
    verifyRunnerOutputs(report, execution.outputs);
    if (!(await repository.heartbeat(buildJobId, coordinatorToken, LEASE_SECONDS))) {
      throw new CoordinatorContractError("build_lease_lost");
    }
    const storedFiles = [];
    for (const file of report.outputManifest.files) {
      const bytes = execution.outputs.get(file.path);
      const stored = await storage.writeExact({
        bucket: expectedBucket,
        objectKey: `${claim.outputPrefix}${file.path.slice("dist/".length)}`,
        contentType: file.contentType,
        checksumSha256: file.checksumSha256,
        ...(dataFiles.length || ["opengeo.observable-build-request.3.0.0", "opengeo.observable-build-request.4.0.0"].includes(claim.request.schemaVersion)
          ? {maximumBytes: maximumOutputFileBytes(file, claim.request, dataInputPins(claim), Boolean(dataFiles.length))} : {}),
        ...(claim.request.schemaVersion === "opengeo.observable-build-request.4.0.0" ? {
          outputRepresentation: "single-html", outputProfile: claim.request.outputProfile,
          sizeAcknowledgment: claim.request.sizeAcknowledgment
        } : {}),
        bytes
      });
      if (stored.bucket !== expectedBucket) {
        throw new CoordinatorContractError("stored_output_bucket_mismatch");
      }
      storedFiles.push(verifyWrite(file, claim.outputPrefix, stored));
    }
    const result = buildResult(claim, report, storedFiles);
    await recheckData();
    if (publicFiles.length) await requireLease();
    if (!(await repository.complete(buildJobId, coordinatorToken, result))) {
      throw new CoordinatorContractError("build_lease_lost");
    }
    let incremental;
    if (cacheScope) {
      const cache = verifiedPageCache(execution.incrementalPageCache);
      incremental = {cacheRead, cacheWrite: "unavailable", counts: verifiedPageCacheStats(execution.incrementalPageCache)};
      if (cache) {
        // Admit only after verified output upload, attachment reauthorization
        // and successful completion of this exact leased build. A failed cache
        // write must not turn an already completed build into a failed job.
        try {const saved = await pageCacheStore.write(cacheScope, cache, {
          buildJobId, sourceRevisionId: claim.sourceRevisionId,
          outputTreeChecksumSha256: report.outputTreeChecksumSha256
        }); incremental.cacheWrite = ["written", "unchanged", "superseded", "not_observed"].includes(saved?.status) ? saved.status : "unavailable";}
        catch { incremental.cacheWrite = "failed"; /* The next build can compile cold. */ }
      }
    }
    return {status: "succeeded", buildJobId, result, ...(incremental ? {incremental} : {})};
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.retryable) {
      const status = await repository.release(
        buildJobId,
        coordinatorToken,
        failure.code,
        MAX_ATTEMPTS
      );
      return {status, buildJobId, errorCode: failure.code};
    }
    const failed = await repository.fail(buildJobId, coordinatorToken, failure.code);
    return {status: failed ? "failed" : "lost", buildJobId, errorCode: failure.code};
  }
}

async function runWithLease({
  buildJobId,
  coordinatorToken,
  repository,
  runner,
  invocation,
  inputs,
  limits,
  incrementalPageCache,
  heartbeatIntervalMilliseconds
}) {
  return workWithLease({buildJobId, coordinatorToken, repository, heartbeatIntervalMilliseconds,
    work: signal => runner.run({invocation, inputs, limits, signal,
      ...(incrementalPageCache === undefined ? {} : {incrementalPageCache})})});
}

async function workWithLease({buildJobId, coordinatorToken, repository, heartbeatIntervalMilliseconds,
  timeoutMilliseconds, work}) {
  const controller = new AbortController();
  let leaseLost = false;
  let timedOut = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (leaseLost) return;
      try {
        leaseLost = !(await repository.heartbeat(buildJobId, coordinatorToken, LEASE_SECONDS));
      } catch {
        leaseLost = true;
      }
      if (leaseLost) controller.abort();
    });
  }, heartbeatIntervalMilliseconds);
  timer.unref?.();
  const deadline = timeoutMilliseconds === undefined ? null : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMilliseconds);
  deadline?.unref?.();
  let execution, failure;
  try {
    execution = await work(controller.signal);
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(timer);
    if (deadline !== null) clearTimeout(deadline);
    await heartbeat;
  }
  if (leaseLost) throw new CoordinatorContractError("build_lease_lost");
  if (timedOut) throw new CoordinatorContractError("public_file_staging_timeout");
  if (failure) throw failure;
  return execution;
}

function normalizeFailure(error) {
  if (error instanceof CoordinatorContractError) return error;
  if (error?.retryable === true && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(error.code ?? "")) {
    return new CoordinatorContractError(error.code, {retryable: true});
  }
  return new CoordinatorContractError("observable_build_internal_error");
}
