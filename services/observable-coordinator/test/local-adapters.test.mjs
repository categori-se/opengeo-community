import assert from "node:assert/strict";
import {test} from "node:test";
import {LocalExactVersionStorage, localDependencies, localPublicationBridge, processLocalBuildQueue,
  processLocalPublicationQueue, boundedLocalPublicationReader}
  from "../src/local-adapters.mjs";
import {RdsDataBuildRepository} from "../src/production-adapters.mjs";
import {sha256,verifyRead,verifyWrite} from "../src/contracts.mjs";

const pin = `sha256:${"a".repeat(64)}`;
const id = "10000000-0000-4000-8000-000000000001";
const command = JSON.stringify({schema: "opengeo.observable-build.command.1.0.0", build_job_id: id});

test("local configuration keeps SQL lease repository and refuses mutable compiler identities", () => {
  assert.throws(() => localDependencies({bridge: async () => {}, compilerImageDigest: "latest"}));
  assert.throws(() => localPublicationBridge("production-api"));
  const dependencies = localDependencies({bridge: async () => {}, compilerImageDigest: pin});
  assert.ok(dependencies.repository instanceof RdsDataBuildRepository);
  assert.equal(dependencies.expectedCompilerImageDigest, pin);
});

test("local Artifact resolution uses the claimed actor and checks each lease through the API repository", async () => {
  const [job, token, organization, user, project, source, revision, input] = Array.from({length: 8},
    (_, index) => `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`);
  const authority = {organizationId: organization, userId: user, projectId: project,
    sourceProjectId: source, inputId: input, manifest: {artifacts: []}};
  const files = [{path: "maps/retained.html"}], resolutions = [];
  let denied = false;
  const bridge = async request => {
    if (request.operation === "sql" && request.sql.includes("claim_observable_build_runtime")) {
      return [["claimed", job, organization, project, source, revision, 1, "preview",
        {schemaVersion: "opengeo.observable-build-request.2.0.0"}, "a".repeat(64), {}, "b".repeat(64), "prefix/", 1]];
    }
    if (request.operation === "sql" && request.sql.includes("read_observable_artifact_lease")) return [[authority]];
    assert.equal(request.operation, "resolve-artifact-lease");
    resolutions.push(request);
    if (denied) throw new Error("publication_artifact_lease_unavailable");
    return files;
  };
  const {repository} = localDependencies({bridge, compilerImageDigest: pin});
  await repository.claim(job, token, 900);
  await assert.rejects(repository.resolveArtifactInputs(job, id), /artifact_staging_unavailable/);
  assert.equal(resolutions.length, 0);
  assert.deepEqual(await repository.resolveArtifactInputs(job, token), files);
  assert.deepEqual(resolutions[0], {operation: "resolve-artifact-lease", buildJobId: job,
    coordinatorToken: token, organizationId: organization, userId: user});
  denied = true;
  await assert.rejects(repository.resolveArtifactInputs(job, token), /publication_artifact_lease_unavailable/);
  assert.equal(resolutions.length, 2, "Retained authority must not cache a prior access decision");
});

test("source staging verifies exact identity, returned size, bytes and checksum", async () => {
  const bytes = Buffer.from("# Saved edition\n");
  const source = {bucket: "local-pilot.invalid", key: "source/index.md", version_id: id,
    etag: "exact-etag", content_type: "text/markdown", size_bytes: bytes.length,
    checksum_sha256: sha256(bytes), body: bytes.toString("base64")};
  const request = {bucket: source.bucket, objectKey: source.key, s3VersionId: id, maximumBytes: bytes.length};
  const storage = new LocalExactVersionStorage(async () => source);
  const stored = await storage.readExact(request);
  assert.deepEqual(verifyRead({...request,etag:source.etag,contentType:source.content_type,
    sizeBytes:source.size_bytes,checksumSha256:source.checksum_sha256},stored),bytes);
  for (const mutation of [{version_id: "other"}, {key: "other"}, {checksum_sha256: "b".repeat(64)},
    {size_bytes: bytes.length + 1}, {body: Buffer.from("changed").toString("base64")}]) {
    await assert.rejects(new LocalExactVersionStorage(async () => ({...source, ...mutation})).readExact(request));
  }
  await assert.rejects(storage.writeExact({bytes, checksumSha256: "b".repeat(64)}));
});

test("queue retry reads completed SQL state and acknowledges without executing compiler", async () => {
  const calls = [];
  const bridge = async request => {
    calls.push(request.operation);
    if (request.operation === "receive") return calls.filter(call => call === "receive").length === 1 ? {id, body: command} : null;
    if (request.operation === "sql") {
      assert.match(request.sql, /app\.claim_observable_build_runtime/);
      assert.equal(request.parameters[0].value.stringValue, id);
      return [["already_succeeded", id, ...Array(12).fill(null)]];
    }
    if (request.operation === "acknowledge") return true;
    throw new Error("Unexpected transport operation");
  };
  const result = await processLocalBuildQueue({bridge, compilerImageDigest: pin,
    runner: {run() { throw new Error("Completed output must not compile again"); }}});
  assert.equal(result[0].status, "already_succeeded");
  assert.deepEqual(calls, ["receive", "sql", "acknowledge", "receive"]);
});

test("retained local writes satisfy the production completion manifest contract", async () => {
  const bytes=Buffer.from('<!doctype html><h1>Saved edition</h1>');
  const outputPrefix='organizations/example/builds/edition/output/';
  const file={path:'dist/index.html',contentType:'text/html',sizeBytes:bytes.length,checksumSha256:sha256(bytes)};
  const storage=new LocalExactVersionStorage(async request=>({bucket:request.bucket,key:request.objectKey,
    version_id:id,etag:'exact-etag',content_type:request.contentType,
    size_bytes:bytes.length,checksum_sha256:request.checksumSha256}));
  const written=await storage.writeExact({bucket:'local-pilot.invalid',objectKey:outputPrefix+'index.html',
    contentType:file.contentType,checksumSha256:file.checksumSha256,bytes});
  const pinned=verifyWrite(file,outputPrefix,written);
  assert.equal(pinned.sizeBytes,bytes.length);assert.equal(pinned.s3VersionId,id);
  assert.equal(Object.hasOwn(written,'bytes'),false);
});

test("busy SQL lease stops the batch and preserves queued work", async () => {
  const calls = [];
  const bridge = async request => {
    calls.push(request.operation);
    if (request.operation === "receive") return {id, body: command};
    if (request.operation === "sql") return [["busy", id, ...Array(12).fill(null)]];
    throw new Error("Busy work must not be acknowledged");
  };
  const result = await processLocalBuildQueue({bridge, compilerImageDigest: pin});
  assert.equal(result[0].status, "busy");
  assert.deepEqual(calls, ["receive", "sql"]);
});

const reviewId = "10000000-0000-4000-8000-000000000002";
const publicationCommand = JSON.stringify({schema: "opengeo.framework-publication.command.1.0.0", review_id: reviewId});

test("local publication acknowledges only the deployed approved review in its own queue", async () => {
  const calls = [];
  const bridge = async request => {
    calls.push(request);
    if (request.operation === "receive") return calls.length === 1 ? {id, body: publicationCommand} : null;
    if (request.operation === "publish") return "deployed";
    if (request.operation === "acknowledge") return true;
    throw new Error("Unexpected publication operation");
  };
  assert.deepEqual(await processLocalPublicationQueue({bridge}), [{reviewId, status: "deployed"}]);
  assert.deepEqual(calls, [
    {operation: "receive", queue: "framework-publications"},
    {operation: "publish", reviewId},
    {operation: "acknowledge", queue: "framework-publications", id},
    {operation: "receive", queue: "framework-publications"}
  ]);
});

test("local publication preserves retries, unclaimed reviews and failed outcomes without spinning", async () => {
  for (const status of ["retry", "busy", "not_found", "needs_attention", "unknown"]) {
    const calls = [];
    const bridge = async request => {
      calls.push(request.operation);
      if (request.operation === "receive") return {id, body: publicationCommand};
      if (request.operation === "publish") return status;
      throw new Error("Undeployed publication must stay queued");
    };
    assert.deepEqual(await processLocalPublicationQueue({bridge}), [{reviewId, status}]);
    assert.deepEqual(calls, ["receive", "publish"], status);
  }
});

test("malformed publication envelopes and commands never reach the publisher or acknowledgement", async () => {
  const messages = [
    undefined, [], {}, {id: "other", body: publicationCommand},
    {id, body: publicationCommand, queue: "observable-builds"},
    {id, body: {}}, {id, body: " ".repeat(513)}, {id, body: "{"},
    ...[null, [], {}, {schema: "opengeo.observable-build.command.1.0.0", review_id: reviewId},
      {schema: "opengeo.framework-publication.command.1.0.0", review_id: "other"},
      {schema: "opengeo.framework-publication.command.1.0.0", review_id: reviewId, approved: true}]
      .map(value => ({id, body: JSON.stringify(value)}))
  ];
  for (const message of messages) {
    const calls = [];
    await assert.rejects(processLocalPublicationQueue({bridge: async request => {
      calls.push(request.operation);
      return message;
    }}), /local_publication_command_invalid/);
    assert.deepEqual(calls, ["receive"]);
  }
});

test("publication transport failure or unknown result shape leaves the original message queued", async () => {
  for (const result of [null, {status: "deployed"}, new Error("Publisher unavailable")]) {
    const calls = [];
    await assert.rejects(processLocalPublicationQueue({bridge: async request => {
      calls.push(request.operation);
      if (request.operation === "receive") return {id, body: publicationCommand};
      if (result instanceof Error) throw result;
      return result;
    }}), /local_publication_result_invalid|Publisher unavailable/);
    assert.deepEqual(calls, ["receive", "publish"]);
  }
});

test("local publication stops at the default four-job cap and honors a smaller explicit cap", async () => {
  for (const maximumJobs of [undefined, 1]) {
    const queue = Array.from({length: 6}, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      body: publicationCommand
    }));
    let acknowledged = 0;
    const bridge = async request => {
      if (request.operation === "receive") return queue[0] ?? null;
      if (request.operation === "publish") return "deployed";
      if (request.operation === "acknowledge") {
        assert.equal(request.id, queue[0].id);
        queue.shift();
        acknowledged++;
        return true;
      }
      throw new Error("Unexpected publication operation");
    };
    const outcomes = await processLocalPublicationQueue({bridge, maximumJobs});
    assert.equal(outcomes.length, maximumJobs ?? 4);
    assert.equal(acknowledged, maximumJobs ?? 4);
    assert.equal(queue.length, 6 - (maximumJobs ?? 4));
  }
});

test("invalid local publication configuration fails before receiving work", async () => {
  const bridge = async () => { throw new Error("Invalid configuration must not consume work"); };
  for (const maximumJobs of [0, 5, 1.5, null]) {
    await assert.rejects(processLocalPublicationQueue({bridge, maximumJobs}), /local_job_limit_invalid/);
  }
  await assert.rejects(processLocalPublicationQueue(), /local_configuration_invalid/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test("public reads coalesce assets and preserve ordered results, retained review and missing files", async () => {
  const calls = [];
  const response = Object.freeze({body: "ZXhhY3Q=", content_type: "text/javascript"});
  const read = boundedLocalPublicationReader(async request => {
    calls.push(request);
    return [response, null, response];
  });
  const results = await Promise.all([
    read(Object.freeze({operation: "public-read", path: "/assets/a.js"})),
    read(Object.freeze({operation: "public-read", path: "/missing.js"})),
    read(Object.freeze({operation: "public-read", path: "/index.html", reviewId}))
  ]);
  assert.deepEqual(calls, [{operation: "public-read-batch", requests: [
    {path: "/assets/a.js"}, {path: "/missing.js"}, {path: "/index.html", reviewId}
  ]}]);
  assert.equal(results[0], response);
  assert.equal(results[1], null);
  assert.equal(results[2], response);
});

test("public reads bound physical processes and outstanding assets, then recover after draining", async () => {
  const pending = [], results = [], paths = [];
  let active = 0, peak = 0;
  const read = boundedLocalPublicationReader(async request => {
    active++;
    peak = Math.max(peak, active);
    assert.equal(request.operation, "public-read-batch");
    assert.ok(request.requests.length >= 1 && request.requests.length <= 32);
    paths.push(...request.requests.map(item => item.path));
    try { return await new Promise(resolve => pending.push({request, resolve})); }
    finally { active--; }
  });
  // Separate arrival turns fill all physical slots before a later burst queues.
  for (let index = 0; index < 4; index++) {
    results.push(read({operation: "public-read", path: `/${index}`}));
    await tick();
  }
  for (let index = 4; index < 64; index++) results.push(read({operation: "public-read", path: `/${index}`}));
  await tick();
  assert.equal(pending.length, 4);
  await assert.rejects(read({operation: "public-read", path: "/overflow"}), /local_publication_read_busy/);
  assert.equal(pending.length, 4, "Overflow must not reach the bridge");
  let resolved = 0;
  while (resolved < 64) {
    const batch = pending.shift();
    assert.ok(batch, "Queued reads must make progress without another incoming request");
    resolved += batch.request.requests.length;
    batch.resolve(batch.request.requests.map(item => item.path));
    await tick();
  }
  assert.deepEqual(await Promise.all(results), Array.from({length: 64}, (_, index) => `/${index}`));
  assert.deepEqual(paths, Array.from({length: 64}, (_, index) => `/${index}`));
  assert.equal(peak, 4);
  assert.equal(active, 0);
  const next = read({operation: "public-read", path: "/after-draining"});
  await tick();
  pending.shift().resolve([null]);
  assert.equal(await next, null);
});

test("failed or malformed batches release capacity, retain errors and never retry", async () => {
  const failure = new Error("Canonical publication read failed");
  for (const first of [() => { throw failure; }, async () => { throw failure; },
    async () => null, async () => [], async () => [null]]) {
    let attempts = 0;
    const read = boundedLocalPublicationReader(request => {
      attempts++;
      return attempts === 1 ? first() : request.requests.map(() => null);
    });
    const initial = ["/a", "/b"].map(path => read({operation: "public-read", path}));
    const settled = await Promise.allSettled(initial);
    assert.equal(attempts, 1);
    for (const result of settled) {
      assert.equal(result.status, "rejected");
      assert.ok(result.reason === failure || /local_transport_invalid/.test(result.reason.message));
    }
    assert.deepEqual(await Promise.all(Array.from({length: 64}, () => read({operation: "public-read", path: "/next"}))),
      Array(64).fill(null));
    assert.equal(attempts, 3, "The next 64 assets use two bounded batches; failed reads are not replayed");
  }
});

test("bounded reader rejects invalid requests before they can affect other assets", async () => {
  let calls = 0;
  const read = boundedLocalPublicationReader(request => { calls++; return request.requests.map(() => null); });
  for (const request of [undefined, null, [], {}, {operation: "public-read", path: 1},
    {operation: "public-read", path: "/", bucket: "private"},
    {operation: "public-read", path: "/", reviewId: null},
    {operation: "public-read", path: "/", reviewId: "invalid"},
    ...["sql", "receive", "acknowledge", "publish", "configure-publication"].map(operation => ({operation}))]) {
    await assert.rejects(read(request), /local_publication_read_invalid/);
  }
  assert.equal(calls, 0);
  assert.equal(await read({operation: "public-read", path: "/index.html", reviewId}), null);
  assert.equal(calls, 1);
});
