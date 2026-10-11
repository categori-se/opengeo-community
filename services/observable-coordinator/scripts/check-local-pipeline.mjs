import assert from "node:assert/strict";
import {
  REQUEST_SCHEMA,
  SOURCE_MANIFEST_SCHEMA,
  jsonbText,
  sha256
} from "../src/contracts.mjs";
import {coordinateBuild} from "../src/coordinator.mjs";
import {PodmanRunner} from "../src/podman-runner.mjs";

const id = {
  organization: "10000000-0000-4000-8000-000000000451",
  project: "50000000-0000-4000-8000-000000000451",
  sourceProject: "b0000000-0000-4000-8000-000000000451",
  upload: "c0000000-0000-4000-8000-000000000451",
  object: "d0000000-0000-4000-8000-000000000451",
  revision: "e0000000-0000-4000-8000-000000000451",
  build: "f0000000-0000-4000-8000-000000000451"
};
const bucket = "source.opengeo.tools";
const imageDigest = process.argv[2] ??
  "sha256:e6101203a8fa964733b9d7716b3f90232e66a1c758263bb4df1d01261c31e33e";
const source = Buffer.from(
  "# Coordinator-isolated preview\n\nThis page was compiled with no storage or publication authority.\n",
  "utf8"
);
const objectKey =
  `organizations/${id.organization}/projects/${id.project}/source-projects/${id.sourceProject}/` +
  `uploads/${id.upload}/files/index.md`;
const inputManifest = {
  schemaVersion: SOURCE_MANIFEST_SCHEMA,
  sourceProjectId: id.sourceProject,
  revisionId: id.revision,
  revisionNumber: 1,
  entryPath: "index.md",
  lockfilePath: null,
  files: [{
    path: "index.md",
    objectId: id.object,
    bucket,
    objectKey,
    s3VersionId: "source-v1",
    etag: "source-etag",
    contentType: "text/markdown",
    sizeBytes: source.length,
    checksumSha256: sha256(source)
  }]
};
const inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(inputManifest), "utf8"));
const request = {
  schemaVersion: REQUEST_SCHEMA,
  sourceProjectId: id.sourceProject,
  sourceRevisionId: id.revision,
  sourceRevisionNumber: 1,
  sourceManifestChecksumSha256: inputManifestChecksumSha256,
  purpose: "preview",
  compilerImageDigest: imageDigest,
  frameworkVersion: "1.13.4",
  lockfileFormat: "npm-package-lock-v3",
  lockfileChecksumSha256: null,
  networkPolicy: "deny_all",
  resourceLimits: {
    cpuMillis: 1000,
    memoryMiB: 2048,
    timeoutSeconds: 120,
    maxInputFiles: 128,
    maxInputBytes: 16_777_216,
    maxOutputFiles: 512,
    maxOutputBytes: 33_554_432
  }
};
const outputPrefix =
  `organizations/${id.organization}/projects/${id.project}/source-projects/${id.sourceProject}/` +
  `builds/${id.build}/output/`;
const claim = {
  claimStatus: "claimed",
  buildJobId: id.build,
  organizationId: id.organization,
  projectId: id.project,
  sourceProjectId: id.sourceProject,
  sourceRevisionId: id.revision,
  sourceRevisionNumber: 1,
  purpose: "preview",
  request,
  requestChecksumSha256: sha256(Buffer.from(jsonbText(request), "utf8")),
  inputManifest,
  inputManifestChecksumSha256,
  outputPrefix,
  attemptCount: 1
};

let completed;
const storedOutputs = new Map();
const repository = {
  async claim() { return structuredClone(claim); },
  async heartbeat() { return true; },
  async complete(buildJobId, coordinatorToken, result) {
    assert.equal(buildJobId, id.build);
    assert.match(coordinatorToken, /^[0-9a-f-]{36}$/);
    completed = structuredClone(result);
    return true;
  },
  async fail() { return true; },
  async release() { return "pending"; }
};
const storage = {
  async readExact(facts) {
    assert.deepEqual(facts, {
      bucket,
      objectKey,
      s3VersionId: "source-v1",
      maximumBytes: source.length
    });
    return {
      bucket,
      objectKey,
      s3VersionId: "source-v1",
      etag: "source-etag",
      contentType: "text/markdown",
      checksumSha256: sha256(source),
      bytes: Buffer.from(source)
    };
  },
  async writeExact({bucket: targetBucket, objectKey: targetKey, contentType, checksumSha256, bytes}) {
    assert.equal(targetBucket, bucket);
    assert.equal(targetKey.startsWith(outputPrefix), true);
    assert.equal(sha256(bytes), checksumSha256);
    storedOutputs.set(targetKey, Buffer.from(bytes));
    return {
      bucket: targetBucket,
      objectKey: targetKey,
      s3VersionId: `pipeline-v${storedOutputs.size}`,
      etag: `pipeline-etag-${storedOutputs.size}`,
      contentType,
      sizeBytes: bytes.length,
      checksumSha256
    };
  }
};
const isolatedRunner = new PodmanRunner();
const diagnosticRunner = {
  async run(arguments_) {
    try {
      return await isolatedRunner.run(arguments_);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        runnerErrorName: error?.name ?? "Error",
        runnerErrorCode: error?.code ?? "unclassified",
        runnerErrorMessage: error?.message ?? "unclassified"
      })}\n`);
      throw error;
    }
  }
};

const outcome = await coordinateBuild({
  buildJobId: id.build,
  expectedBucket: bucket,
  repository,
  storage,
  runner: diagnosticRunner,
  heartbeatIntervalMilliseconds: 5_000
});
assert.equal(outcome.status, "succeeded", JSON.stringify(outcome));
assert.deepEqual(outcome.result, completed);
assert.equal(storedOutputs.size, completed.outputManifest.files.length);
assert.ok(completed.outputManifest.files.some(({path}) => path === "dist/index.html"));
assert.deepEqual(completed.routeManifest, [{path: "/", file: "dist/index.html"}]);
assert.equal(completed.validationReport.publicationAuthorized, false);
assert.deepEqual(completed.networkRequests, []);
process.stdout.write(`${JSON.stringify({
  status: outcome.status,
  imageDigest,
  outputFiles: completed.outputManifest.files.length,
  outputBytes: completed.validationReport.outputBytes,
  outputTreeChecksumSha256: completed.outputTreeChecksumSha256,
  networkRequests: completed.networkRequests.length,
  publicationAuthorized: completed.validationReport.publicationAuthorized
})}\n`);
