import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname, resolve} from "node:path";
import {runBuild, parseInvocation} from "../../observable-builder/src/contract.mjs";
import {localizeFrameworkOutput} from "../../observable-builder/src/framework-standalone.mjs";
import {buildNotebookAssets} from '../../observable-builder/scripts/notebook-assets.mjs';
import {
  COMPILER_REPORT_SCHEMA,
  CoordinatorContractError,
  REQUIRED_SANDBOX,
  REQUEST_SCHEMA,
  SOURCE_MANIFEST_SCHEMA,
  DATA_MANIFEST_SCHEMA,
  REFERENCED_MANIFEST_SCHEMA,
  DISTRIBUTION_REQUEST_SCHEMA,
  LOCALIZED_REQUEST_SCHEMA,
  LOCALIZED_INVOCATION_SCHEMA,
  LOCALIZED_REPORT_SCHEMA,
  LOCALIZED_RESULT_SCHEMA,
  executionLimits,
  maximumOutputFileBytes,
  runnerInvocation,
  parseClaim,
  parseResolvedDataFiles,
  parseCompilerReport,
  jsonbText,
  sha256
} from "../src/contracts.mjs";
import {coordinateBuild} from "../src/coordinator.mjs";
import {podmanArguments, readOutputTree} from "../src/podman-runner.mjs";

const ID = {
  organization: "10000000-0000-4000-8000-000000000451",
  otherOrganization: "10000000-0000-4000-8000-000000000452",
  project: "50000000-0000-4000-8000-000000000451",
  sourceProject: "b0000000-0000-4000-8000-000000000451",
  upload: "c0000000-0000-4000-8000-000000000451",
  object: "d0000000-0000-4000-8000-000000000451",
  revision: "e0000000-0000-4000-8000-000000000451",
  build: "f0000000-0000-4000-8000-000000000451"
};
const BUCKET = "source.opengeo.tools";
const IMAGE = `sha256:${"c".repeat(64)}`;
const SOURCE = Buffer.from("# Exact private preview\n", "utf8");
const OUTPUTS = new Map([
  ["dist/app.css", Buffer.from("body{}\n", "utf8")],
  ["dist/index.html", Buffer.from("<!doctype html><title>Preview</title>\n", "utf8")]
]);

it('accepts packaged dist output while rejecting traversal and private directories', () => {
  const claim = parseClaim(fixtureClaim(), BUCKET);
  const valid = 'dist/_npm/leaflet@1.9.4/dist/leaflet.css';
  assert.doesNotThrow(() => parseCompilerReport(compilerExecution(claim, {
    outputs: new Map([...OUTPUTS, [valid, Buffer.from('body{}')]])
  }).report, claim));
  for (const path of ['dist/_npm/leaflet@1.9.4/dist/../private.css',
    'dist/_npm/leaflet@1.9.4/dist/%2e%2e/private.css',
    ...['node_modules', 'build', 'cache', '.git', '.aws', '.ssh'].map(dir => `dist/_npm/leaflet@1.9.4/dist/${dir}/private.css`),
    'dist/_npm/leaflet@1.9.4/dist/credentials.json']) {
    assert.throws(() => parseCompilerReport(compilerExecution(claim, {
      outputs: new Map([...OUTPUTS, [path, Buffer.from('private')]])
    }).report, claim));
  }
});

function sourceKey(organization = ID.organization) {
  return `organizations/${organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/uploads/${ID.upload}/files/index.md`;
}

function fixtureClaim({path = "index.md", bytes = SOURCE, contentType = "text/markdown"} = {}) {
  const inputManifest = {
    schemaVersion: SOURCE_MANIFEST_SCHEMA,
    sourceProjectId: ID.sourceProject,
    revisionId: ID.revision,
    revisionNumber: 1,
    entryPath: path,
    lockfilePath: null,
    files: [{
      path,
      objectId: ID.object,
      bucket: BUCKET,
      objectKey: sourceKey().replace(/index\.md$/, path),
      s3VersionId: "source-v1",
      etag: "source-etag",
      contentType,
      sizeBytes: bytes.length,
      checksumSha256: sha256(bytes)
    }]
  };
  const inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(inputManifest), "utf8"));
  const request = {
    schemaVersion: REQUEST_SCHEMA,
    sourceProjectId: ID.sourceProject,
    sourceRevisionId: ID.revision,
    sourceRevisionNumber: 1,
    sourceManifestChecksumSha256: inputManifestChecksumSha256,
    purpose: "preview",
    compilerImageDigest: IMAGE,
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
  return {
    claimStatus: "claimed",
    buildJobId: ID.build,
    organizationId: ID.organization,
    projectId: ID.project,
    sourceProjectId: ID.sourceProject,
    sourceRevisionId: ID.revision,
    sourceRevisionNumber: 1,
    purpose: "preview",
    request,
    requestChecksumSha256: sha256(Buffer.from(jsonbText(request), "utf8")),
    inputManifest,
    inputManifestChecksumSha256,
    outputPrefix: `organizations/${ID.organization}/projects/${ID.project}/source-projects/${ID.sourceProject}/builds/${ID.build}/output/`,
    attemptCount: 1
  };
}

function compilerExecution(claim, {outputs = OUTPUTS, routeManifest} = {}) {
  const files = [...outputs]
    .map(([path, bytes]) => ({
      path,
      contentType: path.endsWith(".html") ? "text/html" : "text/css",
      sizeBytes: bytes.length,
      checksumSha256: sha256(bytes)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    report: {
      schemaVersion: COMPILER_REPORT_SCHEMA,
      buildJobId: claim.buildJobId,
      requestChecksumSha256: claim.requestChecksumSha256,
      compilerImageDigest: claim.request.compilerImageDigest,
      inputManifestChecksumSha256: claim.inputManifestChecksumSha256,
      outputTreeChecksumSha256: sha256(Buffer.from(JSON.stringify(files), "utf8")),
      routeManifest: routeManifest ?? [{path: "/", file: "dist/index.html"}],
      outputManifest: {schemaVersion: "opengeo.observable-local-output.1.0.0", files},
      validationReport: {
        frameworkVersion: "1.13.4",
        entryPath: claim.inputManifest.entryPath,
        lockfileVerified: false,
        fixedBuilderConfig: true,
        prewarmedFrameworkCache: true,
        inputFileCount: 1,
        inputBytes: SOURCE.length,
        outputFileCount: files.length,
        outputBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        publicationAuthorized: false
      }
    },
    outputs: new Map(outputs),
    sandbox: structuredClone(REQUIRED_SANDBOX)
  };
}

function localizedClaim() {
  const claim = fixtureClaim();
  Object.assign(claim.request, {schemaVersion: LOCALIZED_REQUEST_SCHEMA, outputRepresentation: "single-html",
    outputProfile: "default-32m", sizeAcknowledgment: null, distributionApprovalId: null,
    distributionApprovalChecksumSha256: null});
  claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  return claim;
}

function localizedExecution(claim) {
  const nativeFiles = [
    {path: "dist/index.html", contentType: "text/html", bytes: Buffer.from('<!doctype html><title>Native graph</title><script type="module" src="./map.js"></script><img src="./map.svg" alt="Boundary">')},
    {path: "dist/map.js", contentType: "text/javascript", bytes: Buffer.from('export const answer = 42;')},
    {path: "dist/map.svg", contentType: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0L2,0L2,2Z"/></svg>')}
  ].map(file => ({...file, sizeBytes: file.bytes.length, checksumSha256: sha256(file.bytes)}));
  const nativeDescriptors = nativeFiles.map(({bytes, ...file}) => file).sort((a, b) => a.path.localeCompare(b.path));
  const localized = localizeFrameworkOutput({files: nativeFiles});
  const outputs = new Map([["dist/index.html", Buffer.from(localized.html)]]);
  const execution = compilerExecution(claim, {outputs});
  execution.report.schemaVersion = LOCALIZED_REPORT_SCHEMA;
  const manifest = {...localized.manifest,
    sourceOutputTreeChecksumSha256: sha256(Buffer.from(JSON.stringify(nativeDescriptors))),
    output: execution.report.outputManifest.files[0]};
  execution.report.localizedOutput = {manifest, manifestChecksumSha256: sha256(Buffer.from(jsonbText(manifest)))};
  return execution;
}

it("coordinates native single HTML through exact-byte write and retains the sealed representation", async () => {
  const claim = localizedClaim(), parsed = parseClaim(claim, BUCKET), invocation = runnerInvocation(parsed);
  assert.equal(invocation.schemaVersion, LOCALIZED_INVOCATION_SCHEMA);
  assert.deepEqual(invocation.dataFiles, []);
  assert.doesNotThrow(() => parseInvocation(invocation));
  const execution = localizedExecution(parsed);
  const outcome = await coordinate({claim, execution});
  assert.equal(outcome.result.status, "succeeded");
  assert.equal(outcome.calls.write.length, 1);
  assert.equal(outcome.calls.write[0].outputRepresentation, "single-html");
  assert.equal(outcome.calls.write[0].maximumBytes, 32 * 1024 * 1024);
  const result = outcome.calls.complete[0][2];
  assert.equal(result.schemaVersion, LOCALIZED_RESULT_SCHEMA);
  assert.equal(result.outputRepresentation, "single-html");
  assert.deepEqual(result.localizedOutput, execution.report.localizedOutput);
  assert.equal(result.validationReport.publicationAuthorized, false);
  assert.deepEqual(result.routeManifest, [{path: "/", file: "dist/index.html"}]);
  assert.deepEqual(result.networkRequests, []);
});

it("rejects native single HTML report substitution and inconsistent asset or output seals", () => {
  const claim = parseClaim(localizedClaim(), BUCKET), execution = localizedExecution(claim);
  const mutate = edit => {
    const report = structuredClone(execution.report); edit(report);
    if (report.localizedOutput) report.localizedOutput.manifestChecksumSha256 = sha256(Buffer.from(jsonbText(report.localizedOutput.manifest)));
    return report;
  };
  for (const edit of [
    report => {report.schemaVersion = COMPILER_REPORT_SCHEMA;},
    report => {report.localizedOutput.manifest.output.checksumSha256 = "d".repeat(64);},
    report => {report.localizedOutput.manifest.publicationAuthorized = true;},
    report => {report.localizedOutput.manifest.assets[0].checksumSha256 = "d".repeat(64);},
    report => {report.localizedOutput.manifest.assets[0].archivePaths = ["data/unknown.tif"];},
    report => {report.localizedOutput.manifest.inputFiles.push(report.localizedOutput.manifest.inputFiles[0]);},
    report => {report.localizedOutput.manifest.unsupportedLazyImports = ["https://remote.example/module.js"];},
    report => {report.routeManifest = [{path: "/another", file: "dist/index.html"}];}
  ]) assert.throws(() => parseCompilerReport(mutate(edit), claim));
  const unsealed = structuredClone(execution.report); unsealed.localizedOutput.manifest.fontFallback = "system-fonts";
  assert.throws(() => parseCompilerReport(unsealed, claim), /localized_output_invalid/);
  assert.throws(() => parseCompilerReport(execution.report, parseClaim(fixtureClaim(), BUCKET)));
});

it("keeps native single HTML expanded caps bound to exact consent, pins and generated index", () => {
  const claim = localizedClaim();
  assert.equal(maximumOutputFileBytes({path: "dist/index.html"}, claim.request), 32 * 1024 * 1024);
  claim.request.outputProfile = "archive-96m";
  claim.request.sizeAcknowledgment = "allow-up-to-96-mib-output";
  claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  assert.throws(() => parseClaim(claim, BUCKET), /distribution_request_invalid/);
  claim.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
  claim.inputManifest.dataAttachments = [{path: "data/original.tif", attachmentId: ID.object, dataObjectId: ID.object,
    datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1", contentType: "image/tiff",
    sizeBytes: 64_912_721, checksumSha256: "c".repeat(64)}];
  claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
  claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
  claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  const parsed = parseClaim(claim, BUCKET);
  assert.equal(executionLimits(parsed.request).maxOutputBytes, 96 * 1024 * 1024);
  assert.equal(maximumOutputFileBytes({path: "dist/index.html"}, parsed.request), 96 * 1024 * 1024);
  assert.equal(maximumOutputFileBytes({path: "dist/other.html"}, parsed.request), 32 * 1024 * 1024);
  for (const changes of [{sizeAcknowledgment: null}, {outputRepresentation: "asset-tree"},
    {purpose: "release_candidate", distributionApprovalId: null, distributionApprovalChecksumSha256: null}]) {
    const invalid = structuredClone(claim); Object.assign(invalid.request, changes);
    invalid.requestChecksumSha256 = sha256(Buffer.from(jsonbText(invalid.request)));
    assert.throws(() => parseClaim(invalid, BUCKET));
  }
});

it("admits native single HTML source-only release with zero pins and no distribution approval", async () => {
  for (const path of ["index.md", "src/index.md"]) {
    for (const emptyDataManifest of [false, true]) {
      const claim = localizedClaim();
      claim.purpose = claim.request.purpose = "release_candidate";
      claim.inputManifest.entryPath = claim.inputManifest.files[0].path = path;
      claim.inputManifest.files[0].objectKey = sourceKey().replace(/index\.md$/, path);
      if (emptyDataManifest) {
        claim.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
        claim.inputManifest.dataAttachments = [];
      }
      claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
      claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
      claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
      const parsed = parseClaim(claim, BUCKET);
      assert.equal(parsed.inputFileCount, 1);
      assert.equal(parsed.request.distributionApprovalId, null);
      assert.equal(executionLimits(parsed.request).maxOutputBytes, 32 * 1024 * 1024);
      assert.doesNotThrow(() => parseInvocation(runnerInvocation(parsed)));
      const fixture = harness({claim, execution: localizedExecution(parsed)});
      if (emptyDataManifest) {
        fixture.repository.resolveDataAttachments = async () => [];
        fixture.storage.readArchiveExact = async () => assert.fail("A source-only build must not read archive bytes");
      }
      const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET,
        repository: fixture.repository, storage: fixture.storage, runner: fixture.runner});
      const outcome = {...fixture, result};
      assert.equal(outcome.result.status, "succeeded");
      assert.equal(outcome.calls.complete[0][2].validationReport.publicationAuthorized, false);
    }
  }
});

it("requires exact approval for captured-data native single HTML release and paired approval fields", () => {
  const claim = localizedClaim();
  claim.purpose = claim.request.purpose = "release_candidate";
  claim.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
  claim.inputManifest.dataAttachments = [{path: "data/original.tif", attachmentId: ID.object, dataObjectId: ID.object,
    datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1", contentType: "image/tiff",
    sizeBytes: 128, checksumSha256: "c".repeat(64)}];
  claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
  claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
  const seal = value => {value.requestChecksumSha256 = sha256(Buffer.from(jsonbText(value.request))); return value;};
  for (const profile of ["default-32m", "archive-96m"]) {
    claim.request.outputProfile = profile;
    claim.request.sizeAcknowledgment = profile === "archive-96m" ? "allow-up-to-96-mib-output" : null;
    assert.throws(() => parseClaim(seal(claim), BUCKET), /distribution_request_invalid/);
    const approved = structuredClone(claim);
    approved.request.distributionApprovalId = ID.object;
    approved.request.distributionApprovalChecksumSha256 = "e".repeat(64);
    assert.equal(parseClaim(seal(approved), BUCKET).purpose, "release_candidate");
    approved.request.distributionApprovalChecksumSha256 = null;
    assert.throws(() => parseClaim(seal(approved), BUCKET), /distribution_request_invalid/);
  }
});

it("rejects any native single HTML Artifact envelope before reads or compilation", async () => {
  for (const artifactInputs of [null, {}, {artifacts: []}, {artifacts: [{path: "map.html"}]}]) {
    const claim = localizedClaim();
    claim.artifactInputs = artifactInputs;
    assert.throws(() => parseClaim(claim, BUCKET), /artifact_inputs_invalid/);
    const outcome = await coordinate({claim});
    assert.equal(outcome.result.errorCode, "artifact_inputs_invalid");
    assert.equal(outcome.calls.read.length, 0);
    assert.equal(outcome.calls.run.length, 0);
    assert.equal(outcome.calls.write.length, 0);
  }
  for (const checksum of [null, "a".repeat(64)]) {
    const claim = localizedClaim();
    claim.request.artifactInputsChecksumSha256 = checksum;
    claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
    assert.throws(() => parseClaim(claim, BUCKET), /artifact_inputs_invalid/);
  }
});

it("collects only native single HTML index bytes and rejects extra outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "opengeo-localized-output-"));
  const claim = parseClaim(localizedClaim(), BUCKET), invocation = runnerInvocation(claim);
  try {
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Exact output</title>");
    const outputs = await readOutputTree(root, executionLimits(claim.request), invocation);
    assert.deepEqual([...outputs.keys()], ["dist/index.html"]);
    writeFileSync(join(root, "other.css"), "body{}");
    await assert.rejects(readOutputTree(root, executionLimits(claim.request), invocation), /runner_output_tree_invalid/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

function harness({claim = fixtureClaim(), execution, read, write, heartbeat, release, runnerRun} = {}) {
  const calls = {claim: [], heartbeat: [], complete: [], fail: [], release: [], read: [], write: [], run: []};
  const repository = {
    async claim(...args) {
      calls.claim.push(args);
      return structuredClone(claim);
    },
    async heartbeat(...args) {
      calls.heartbeat.push(args);
      return heartbeat ? heartbeat(calls.heartbeat.length) : true;
    },
    async complete(...args) {
      calls.complete.push(args);
      return true;
    },
    async fail(...args) {
      calls.fail.push(args);
      return true;
    },
    async release(...args) {
      calls.release.push(args);
      return release ? release(...args) : "pending";
    }
  };
  const storage = {
    async readExact(args) {
      calls.read.push(args);
      if (read) return read(args);
      const file = claim.inputManifest.files[0];
      return {
        bucket: file.bucket,
        objectKey: file.objectKey,
        s3VersionId: file.s3VersionId,
        etag: file.etag,
        contentType: file.contentType,
        checksumSha256: file.checksumSha256,
        bytes: Buffer.from(SOURCE)
      };
    },
    async writeExact(args) {
      calls.write.push(args);
      if (write) return write(args);
      return {
        bucket: args.bucket,
        objectKey: args.objectKey,
        s3VersionId: `output-v${calls.write.length}`,
        etag: `output-etag-${calls.write.length}`,
        contentType: args.contentType,
        sizeBytes: args.bytes.length,
        checksumSha256: args.checksumSha256
      };
    }
  };
  const runner = {
    async run(args) {
      calls.run.push(args);
      if (runnerRun) return runnerRun(args);
      return execution ?? compilerExecution(claim);
    }
  };
  return {calls, repository, storage, runner};
}

async function coordinate(overrides = {}) {
  const fixture = harness(overrides);
  const result = await coordinateBuild({
    buildJobId: ID.build,
    expectedBucket: BUCKET,
    repository: fixture.repository,
    storage: fixture.storage,
    runner: fixture.runner,
    pageCacheStore: overrides.pageCacheStore,
    expectedCompilerImageDigest: overrides.expectedCompilerImageDigest ?? null,
    acceptedCompilerImageDigests: overrides.acceptedCompilerImageDigests,
    heartbeatIntervalMilliseconds: 10_000
  });
  return {...fixture, result};
}

it("keeps an old pinned job executable only while that exact image is approved", async () => {
  const replacement = `sha256:${"a".repeat(64)}`;
  const transition = await coordinate({expectedCompilerImageDigest: replacement, acceptedCompilerImageDigests: [IMAGE, replacement]});
  assert.equal(transition.result.status, "succeeded");
  assert.equal(transition.calls.run[0].invocation.request.compilerImageDigest, IMAGE);
  const retained = await coordinate({expectedCompilerImageDigest: replacement,
    acceptedCompilerImageDigests: [IMAGE, replacement, `sha256:${"b".repeat(64)}`, `sha256:${"d".repeat(64)}`]});
  assert.equal(retained.result.status, "succeeded");
  assert.equal(retained.calls.run[0].invocation.request.compilerImageDigest, IMAGE);
  const retired = await coordinate({expectedCompilerImageDigest: replacement, acceptedCompilerImageDigests: [replacement]});
  assert.equal(retired.result.errorCode, "compiler_image_mismatch");
  assert.equal(retired.calls.run.length, 0);
  const fixture = harness();
  await assert.rejects(() => coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture,
    expectedCompilerImageDigest: replacement, acceptedCompilerImageDigests: ["*"]}), /compiler_policy_invalid/);
  assert.equal(fixture.calls.run.length, 0);
});

describe("trusted incremental cache admission", () => {
  const body = Buffer.from("trusted compiler cache");
  const cache = {body, checksumSha256: sha256(body)};
  const scope = {organizationId: ID.organization, projectId: ID.project,
    sourceProjectId: ID.sourceProject, compilerImageDigest: IMAGE, frameworkVersion: "1.13.4"};

  it('requests account admission using the claimed lease and falls back when disabled or unavailable', async () => {
    for (const outcome of ['admitted','disabled','unavailable']) {
      const fixture=harness();
      let reads=0, admissionCalls=0;
      fixture.repository.admitPageCache=async(job,token)=>{
        assert.equal(job,ID.build);assert.match(token,/^[a-f0-9-]{36}$/);
        admissionCalls++;
        if(outcome==='unavailable')throw Error('unavailable');
        return outcome==='admitted'?{approved:true}:null;
      };
      const pageCacheStore={requiresAdmission:true,
        authorize(actual, admission, evidence){assert.deepEqual(actual,scope);assert.deepEqual(evidence,{buildJobId:ID.build,sourceRevisionId:ID.revision});return admission!==null;},
        supports(){return true;},async read(){reads++;return null;},async write(){return {status:'disabled'};}};
      const result=await coordinateBuild({buildJobId:ID.build,expectedBucket:BUCKET,...fixture,pageCacheStore});
      assert.equal(result.status,'succeeded');assert.equal(admissionCalls,1);
      assert.equal(reads,outcome==='admitted'?1:0);
    }
  });

  it("loads by verified scope and admits only after the exact build completes", async () => {
    const fixture = harness({execution: {...compilerExecution(fixtureClaim()), incrementalPageCache: cache}});
    let written = false;
    const pageCacheStore = {
      async read(actual) {assert.deepEqual(actual, scope); return cache;},
      async write(actual, value, evidence) {
        assert.deepEqual(actual, scope);
        assert.deepEqual(value, cache);
        assert.equal(fixture.calls.complete.length, 1);
        assert.equal(fixture.calls.write.length, OUTPUTS.size);
        assert.equal(evidence.buildJobId, ID.build);
        assert.equal(evidence.sourceRevisionId, ID.revision);
        assert.equal(evidence.outputTreeChecksumSha256, compilerExecution(fixtureClaim()).report.outputTreeChecksumSha256);
        written = true;
      }
    };
    const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture, pageCacheStore});
    assert.equal(result.status, "succeeded");
    assert.equal(written, true);
    assert.deepEqual(fixture.calls.run[0].incrementalPageCache, cache);
    assert.equal(JSON.stringify(result).includes("trusted compiler cache"), false);
  });

  it("missing or corrupt cache and storage failures preserve normal build completion", async () => {
    for (const previous of [null, {...cache, checksumSha256: "0".repeat(64)}, new Error("unavailable")]) {
      const execution = {...compilerExecution(fixtureClaim()), incrementalPageCache: cache};
      const fixture = await coordinate({execution, pageCacheStore: {
        async read() {if (previous instanceof Error) throw previous; return previous;},
        async write() {throw Error("unavailable");}
      }});
      assert.equal(fixture.result.status, "succeeded");
      assert.deepEqual(fixture.calls.run[0].incrementalPageCache, {});
      assert.equal(fixture.calls.fail.length, 0);
      assert.equal(fixture.calls.complete.length, 1);
      assert.equal(fixture.result.incremental.cacheRead, previous instanceof Error ? "unavailable" : previous ? "invalid" : "miss");
      assert.equal(fixture.result.incremental.cacheWrite, "failed");
      assert.equal(fixture.result.incremental.counts, null);
    }
  });

  it("retains bounded compiler counts and independent cache transport outcomes", async () => {
    for (const [restored, rendered, reused] of [[false, 3, 0], [true, 0, 3], [true, 1, 2]]) {
      const execution = {...compilerExecution(fixtureClaim()), incrementalPageCache: {
        ...cache, stats: {restored, rendered, reused, checksumSha256: cache.checksumSha256}
      }};
      const fixture = await coordinate({execution, pageCacheStore: {
        async read() {return restored ? cache : null;}, async write() {return {status: "written"};}
      }});
      assert.equal(fixture.result.status, "succeeded");
      assert.deepEqual(fixture.result.incremental, {cacheRead: restored ? "hit" : "miss", cacheWrite: "written",
        counts: {restored, renderedPages: rendered, reusedPages: reused}});
      assert.equal(JSON.stringify(fixture.result.incremental).includes(cache.checksumSha256), false);
      assert.equal(Object.hasOwn(fixture.calls.complete[0][2], "incremental"), false);
    }
  });

  it("does not report skipped or conflicting cache writes as stored", async () => {
    for (const status of ["written", "unchanged", "superseded", "not_observed", "private-detail", undefined]) {
      const fixture = await coordinate({execution: {...compilerExecution(fixtureClaim()), incrementalPageCache: cache},
        pageCacheStore: {async read() {return cache;}, async write() {return {status};}}});
      assert.equal(fixture.result.status, "succeeded");
      assert.equal(fixture.result.incremental.cacheWrite,
        ["written", "unchanged", "superseded", "not_observed"].includes(status) ? status : "unavailable");
    }
  });

  it("never admits caches from rejected outputs, lost leases or failed completion", async () => {
    for (const mode of ["output", "sandbox", "lease", "completion"]) {
      const execution = {...compilerExecution(fixtureClaim()), incrementalPageCache: cache};
      if (mode === "output") execution.outputs.set("dist/extra.txt", Buffer.from("unexpected"));
      if (mode === "sandbox") execution.sandbox.networkPolicy = "allow_all";
      const fixture = harness({execution, ...(mode === "lease" ? {heartbeat: count => count < 2} : {})});
      if (mode === "completion") fixture.repository.complete = async () => false;
      let writes = 0;
      const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture,
        pageCacheStore: {async read() {return cache;}, async write() {writes++;}}});
      assert.notEqual(result.status, "succeeded", mode);
      assert.equal(writes, 0, mode);
      assert.equal(Object.hasOwn(result, "incremental"), false, mode);
    }
  });

  it("does not admit a corrupt cache even when its build succeeds", async () => {
    let writes = 0;
    const fixture = await coordinate({execution: {...compilerExecution(fixtureClaim()),
      incrementalPageCache: {...cache, checksumSha256: "0".repeat(64)}}, pageCacheStore: {
      async read() {return null;}, async write() {writes++;}
    }});
    assert.equal(fixture.result.status, "succeeded");
    assert.equal(writes, 0);
  });

  it("does not read a cache when the source fails verification", async () => {
    let reads = 0;
    const fixture = await coordinate({read: async () => ({bytes: Buffer.from("wrong source")}),
      pageCacheStore: {async read() {reads++;}, async write() {}}});
    assert.equal(fixture.result.status, "failed");
    assert.equal(reads, 0);
    assert.equal(fixture.calls.run.length, 0);
  });

  it("rejects unsolicited cache output when the host has not opted in", async () => {
    const fixture = await coordinate({execution: {...compilerExecution(fixtureClaim()), incrementalPageCache: cache}});
    assert.equal(fixture.result.errorCode, "runner_execution_invalid");
    assert.equal(fixture.calls.write.length, 0);
    assert.equal(fixture.calls.complete.length, 0);
  });

  it("leaves projects outside the configured rollout on the unchanged build path", async () => {
    let reads = 0;
    const fixture = await coordinate({pageCacheStore: {supports: () => false,
      async read() {reads++;}, async write() {throw Error("not expected");}}});
    assert.equal(fixture.result.status, "succeeded");
    assert.equal(reads, 0);
    assert.equal(Object.hasOwn(fixture.calls.run[0], "incrementalPageCache"), false);
  });

  for (const [path, contentType] of [['index.html', 'text/html'], ['analysis.ipynb', 'application/x-ipynb+json']]) {
  it(`does not enable Framework page caching for ${path}`, async () => {
    const bytes = OUTPUTS.get("dist/index.html");
    const claim = fixtureClaim({path, bytes, contentType});
    const execution = compilerExecution(claim);
    execution.report.validationReport.inputBytes = bytes.length;
    execution.report.validationReport.prewarmedFrameworkCache = false;
    let reads = 0;
    const fixture = await coordinate({claim, execution, read: async () => {
      const {bucket, objectKey, s3VersionId, etag, contentType, checksumSha256} = claim.inputManifest.files[0];
      return {bucket, objectKey, s3VersionId, etag, contentType, checksumSha256, bytes};
    }, pageCacheStore: {async read() {reads++;}, async write() {throw Error("not expected");}}});
    assert.equal(fixture.result.status, "succeeded", JSON.stringify(fixture.result));
    assert.equal(reads, 0);
    assert.equal(Object.hasOwn(fixture.calls.run[0], "incrementalPageCache"), false);
  });
  }
});

it("validates static HTML reports without weakening Framework cache requirements", () => {
  const bytes = OUTPUTS.get("dist/index.html");
  const claim = parseClaim(fixtureClaim({path: "index.html", bytes, contentType: "text/html"}), BUCKET);
  const {report} = compilerExecution(claim);
  report.validationReport.inputBytes = bytes.length;
  report.validationReport.prewarmedFrameworkCache = false;
  assert.equal(parseCompilerReport(report, claim).validationReport.prewarmedFrameworkCache, false);
  report.validationReport.prewarmedFrameworkCache = true;
  assert.throws(() => parseCompilerReport(report, claim), /compiler_validation_report_invalid/);
  const framework = parseClaim(fixtureClaim(), BUCKET);
  const frameworkReport = compilerExecution(framework).report;
  frameworkReport.validationReport.prewarmedFrameworkCache = false;
  assert.throws(() => parseCompilerReport(frameworkReport, framework), /compiler_validation_report_invalid/);
});

it("validates a native Jupyter report without claiming Framework compilation", () => {
  const bytes = Buffer.from('{"nbformat":4}');
  const claim = parseClaim(fixtureClaim({path: 'analysis.ipynb', bytes, contentType: 'application/x-ipynb+json'}), BUCKET);
  const {report} = compilerExecution(claim);
  report.validationReport.inputBytes = bytes.length;
  report.validationReport.prewarmedFrameworkCache = false;
  assert.equal(parseCompilerReport(report, claim).validationReport.prewarmedFrameworkCache, false);
  report.validationReport.prewarmedFrameworkCache = true;
  assert.throws(() => parseCompilerReport(report, claim), /compiler_validation_report_invalid/);
});

for (const [path, contentType, content, format] of [
  ['index.html', 'text/html', '<!doctype html><h1>Static publication</h1>'],
  ['index.html', 'text/html', '<notebook><title>Reactive publication</title><script id="1" type="text/markdown"># Reactive publication</script></notebook>', 'notebook'],
  ['analysis.ipynb', 'application/x-ipynb+json', JSON.stringify({nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    {cell_type: 'markdown', metadata: {}, source: '# Notebook publication'}]})]
]) {
it(`coordinates an actual ${format ?? path} publication through output verification and completion`, async () => {
  const bytes = Buffer.from(content);
  const claim = fixtureClaim({path, bytes, contentType});
  const sourceBytes = new Map([[claim.inputManifest.files[0].objectKey, bytes]]);
  if (format === 'notebook') {
    const body = Buffer.from(JSON.stringify({schema:'opengeo.publication.1',format,entry:path}));
    const objectKey = sourceKey().replace(/index\.md$/, 'opengeo.publication.json');
    claim.inputManifest.files.push({...claim.inputManifest.files[0], path:'opengeo.publication.json',
      objectId: ID.object.replace(/451$/, '452'), objectKey, contentType:'application/json', sizeBytes:body.length, checksumSha256:sha256(body)});
    sourceBytes.set(objectKey, body);
    claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
    claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
    claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  }
  const root = mkdtempSync(join(tmpdir(), 'opengeo-static-coordinate-'));
  try {
    const notebookAssetsPath = join(root, 'notebook-assets.json');
    if (format === 'notebook') writeFileSync(notebookAssetsPath, JSON.stringify(await buildNotebookAssets(resolve(new URL('../../../app', import.meta.url).pathname))));
    const fixture = await coordinate({claim,
      read: async request => {
        const {bucket, objectKey, s3VersionId, etag, contentType, checksumSha256} = claim.inputManifest.files.find(file => file.objectKey === request.objectKey);
        return {bucket, objectKey, s3VersionId, etag, contentType, checksumSha256, bytes: sourceBytes.get(objectKey)};
      },
      runnerRun: async ({invocation, inputs}) => {
        const inputRoot = join(root, 'input'), workspaceRoot = join(root, 'workspace');
        for (const [path, content] of inputs) {const target = join(inputRoot, path); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, content);}
        const report = runBuild({invocation, inputRoot, workspaceRoot,
          observableCliPath: resolve(new URL('../../../app/node_modules/.bin/observable', import.meta.url).pathname), frameworkCacheRoot: '/not-used', notebookAssetsPath});
        return {report, outputs: new Map(report.outputManifest.files.map(file => [file.path, readFileSync(join(workspaceRoot, file.path))])),
          sandbox: structuredClone(REQUIRED_SANDBOX)};
      }});
    assert.equal(fixture.result.status, 'succeeded', JSON.stringify(fixture.result));
    assert.equal(fixture.calls.complete.length, 1);
    assert.equal(fixture.calls.write.length, 1);
    if (format === 'notebook') assert.match(fixture.calls.write[0].bytes.toString(), /<title>Reactive publication<\/title>/);
    else if (contentType === 'text/html') assert.deepEqual(fixture.calls.write[0].bytes, bytes);
    else assert.match(fixture.calls.write[0].bytes.toString(), /<h1>Notebook publication<\/h1>/);
    assert.equal(fixture.result.result.validationReport.prewarmedFrameworkCache, false);
  } finally {rmSync(root, {recursive: true, force: true});}
});
}

it("admits exact TIFF archive pins within 64 MiB without admitting executable source", () => {
  const claim = fixtureClaim();
  const pin = {path: "data/elevation.tif", attachmentId: ID.object, dataObjectId: ID.object,
    datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1",
    contentType: "image/tiff", sizeBytes: 64_912_721, checksumSha256: "c".repeat(64)};
  const sealed = changes => {
    const value = structuredClone(claim);
    value.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
    value.inputManifest.dataAttachments = [{...pin, ...changes}];
    value.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(value.inputManifest)));
    value.request.sourceManifestChecksumSha256 = value.inputManifestChecksumSha256;
    value.requestChecksumSha256 = sha256(Buffer.from(jsonbText(value.request)));
    return value;
  };
  assert.equal(parseClaim(sealed({}), BUCKET).inputBytes, SOURCE.length + pin.sizeBytes);
  assert.doesNotThrow(() => parseClaim(sealed({path: "data/elevation.TIFF", contentType: "image/geotiff", sizeBytes: 67_108_864}), BUCKET));
  for (const changed of [{sizeBytes: 67_108_865}, {contentType: "text/javascript"},
    {contentType: "application/octet-stream"}, {path: "../elevation.tif"}, {path: "data/run.js"}, {s3VersionId: "null"}]) {
    assert.throws(() => parseClaim(sealed(changed), BUCKET), /archive_manifest_invalid/);
  }
});

const PUBLIC_TIFF = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
function sealClaim(claim) {
  claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
  claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
  claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  return claim;
}
function publicReferenceClaim({localized = false, aliases = false, archives = false} = {}) {
  const claim = localized ? localizedClaim() : fixtureClaim();
  const pin = {kind: "referenced-public-file", custody: "referenced", referenceId: ID.object,
    path: "data/a.tif", datasetId: ID.project, sourceVersion: 1, resourceId: ID.object,
    resourceVersionId: ID.revision, resourceVersionNumber: 1,
    distributionId: "exact-tiff", url: "https://public.example.test/exact.tif",
    contentType: "image/tiff", sizeBytes: PUBLIC_TIFF.length, checksumSha256: sha256(PUBLIC_TIFF)};
  Object.assign(claim.inputManifest, {schemaVersion: REFERENCED_MANIFEST_SCHEMA,
    dataAttachments: archives ? [{path: "data/Z.tif", attachmentId: ID.object, dataObjectId: ID.object,
      datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1",
      contentType: "image/tiff", sizeBytes: PUBLIC_TIFF.length, checksumSha256: sha256(PUBLIC_TIFF)}] : [],
    referencedFiles: [pin, ...(aliases ? [{...pin, referenceId: ID.upload, path: "data/b.tif"}] : [])]});
  return sealClaim(claim);
}
function publicReferenceReleaseClaim({localized = false, ...options} = {}) {
  const claim = publicReferenceClaim({localized, ...options});
  claim.purpose = claim.request.purpose = "release_candidate";
  Object.assign(claim.request, {schemaVersion: localized ? LOCALIZED_REQUEST_SCHEMA : DISTRIBUTION_REQUEST_SCHEMA,
    outputProfile: "default-32m", sizeAcknowledgment: null,
    distributionApprovalId: ID.upload, distributionApprovalChecksumSha256: "a".repeat(64)});
  return sealClaim(claim);
}
function publicReferenceLocalizedExecution(claim) {
  const files = [{path: "dist/index.html", contentType: "text/html",
    bytes: Buffer.from('<!doctype html><img src="./exact.tif" alt="Synthetic TIFF">')},
  {path: "dist/exact.tif", contentType: "application/octet-stream", bytes: PUBLIC_TIFF}]
    .map(file => ({...file, sizeBytes: file.bytes.length, checksumSha256: sha256(file.bytes)}));
  const localized = localizeFrameworkOutput({files, archivePins: runnerInvocation(claim).dataFiles});
  const execution = compilerExecution(claim, {outputs: new Map([["dist/index.html", Buffer.from(localized.html)]])});
  execution.report.schemaVersion = LOCALIZED_REPORT_SCHEMA;
  const nativeDescriptors = files.map(({bytes, ...file}) => file).sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = {...localized.manifest, sourceOutputTreeChecksumSha256: sha256(Buffer.from(JSON.stringify(nativeDescriptors))),
    output: execution.report.outputManifest.files[0]};
  execution.report.localizedOutput = {manifest, manifestChecksumSha256: sha256(Buffer.from(jsonbText(manifest)))};
  return execution;
}
function publicReferenceFixture(claim, {resolve, read, heartbeat, runnerRun, execution: suppliedExecution} = {}) {
  const parsed = parseClaim(claim, BUCKET), execution = suppliedExecution ?? compilerExecution(parsed);
  Object.assign(execution.report.validationReport, {inputBytes: parsed.inputBytes, inputFileCount: parsed.inputFileCount});
  const fixture = harness({claim, execution, heartbeat, runnerRun});
  const archives = claim.inputManifest.dataAttachments.map(pin => ({...pin, bucket: BUCKET,
    objectKey: `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.project}/uploads/${ID.upload}/original/exact.tif`, etag: "archive-etag"}));
  const files = [...archives, ...claim.inputManifest.referencedFiles];
  fixture.calls.publicRead = [];
  fixture.calls.resolutions = [];
  fixture.repository.resolveDataAttachments = async (...args) => {
    fixture.calls.resolutions.push(args);
    return resolve ? resolve(files, fixture.calls.resolutions.length) : structuredClone(files);
  };
  fixture.storage.readArchiveExact = async () => {
    const {sizeBytes, ...file} = archives[0];
    return {bucket: file.bucket, objectKey: file.objectKey, s3VersionId: file.s3VersionId,
      etag: file.etag, contentType: file.contentType, checksumSha256: file.checksumSha256, bytes: PUBLIC_TIFF};
  };
  fixture.storage.readPublicExact = async args => {
    fixture.calls.publicRead.push(args);
    if (read) return read(args, fixture.calls.publicRead.length);
    return {bytes: PUBLIC_TIFF, contentType: "image/tiff", sizeBytes: PUBLIC_TIFF.length, checksumSha256: sha256(PUBLIC_TIFF)};
  };
  return {...fixture, files};
}

describe("public reference preview contracts", () => {
  it("combines exact archive and public pins in C order without exposing custody or URLs", () => {
    for (const localized of [false, true]) {
      const claim = parseClaim(publicReferenceClaim({localized, aliases: true, archives: true}), BUCKET);
      assert.equal(claim.inputBytes, SOURCE.length + PUBLIC_TIFF.length * 3);
      assert.equal(claim.inputFileCount, 4);
      const invocation = runnerInvocation(claim);
      assert.equal(invocation.schemaVersion, `opengeo.observable-runner-invocation.${localized ? 5 : 2}.0.0`);
      assert.deepEqual(invocation.dataFiles.map(file => file.path), ["data/Z.tif", "data/a.tif", "data/b.tif"]);
      assert.doesNotThrow(() => parseInvocation(invocation));
      assert.doesNotMatch(JSON.stringify(invocation), /https:|referenceId|resourceId|datasetId|custody|bucket|objectKey|s3VersionId/);
    }
  });

  it("rejects unsafe URLs, unsealed facts, unapproved release requests and combined resource overruns", () => {
    const invalidUrls = ["http://public.example.test/a.tif", "https://user:pass@public.example.test/a.tif",
      "https://public.example.test/a.tif?token=x", "https://public.example.test/a.tif#x",
      "https://127.0.0.1/a.tif", "https://0x7f000001/a.tif", "https://[::1]/a.tif",
      "https://localhost/a.tif", "https://host.internal/a.tif", "https://host.local/a.tif",
      "https://host.home.arpa/a.tif", "https://public.example.test:8443/a.tif",
      "https://public.example.test\\@localhost/a.tif", "https://public.example.test/a tif"];
    const changes = invalidUrls.map(url => claim => {claim.inputManifest.referencedFiles[0].url = url;});
    changes.push(...[
      claim => {claim.inputManifest.referencedFiles[0].bucket = BUCKET;},
      claim => {claim.inputManifest.referencedFiles[0].custody = "hosted";},
      claim => {claim.inputManifest.referencedFiles[0].contentType = "application/octet-stream";},
      claim => {claim.inputManifest.referencedFiles[0].path = "data/run.js";},
      claim => {claim.inputManifest.referencedFiles[0].sourceVersion = 0;},
      claim => {claim.inputManifest.referencedFiles[0].resourceVersionNumber = 0;},
      claim => {claim.inputManifest.referencedFiles[0].sizeBytes = 67_108_865;},
      claim => {claim.inputManifest.referencedFiles = [];},
      claim => {claim.inputManifest.referencedFiles[0].path = "index.md";},
      claim => {claim.inputManifest.referencedFiles[0].path = "data/Z.tif";},
      claim => {claim.inputManifest.dataAttachments[0].sizeBytes = 67_108_864;},
      claim => {claim.request.resourceLimits.maxInputFiles = 2;},
      claim => {claim.purpose = claim.request.purpose = "release_candidate";},
      claim => {Object.assign(claim.request, {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA,
        outputProfile: "default-32m", sizeAcknowledgment: null, distributionApprovalId: null,
        distributionApprovalChecksumSha256: null});}
    ]);
    for (const edit of changes) {
      const claim = publicReferenceClaim({archives: true}); edit(claim);
      assert.throws(() => parseClaim(sealClaim(claim), BUCKET));
    }
    const exactLimit = publicReferenceClaim(); exactLimit.inputManifest.referencedFiles[0].sizeBytes = 67_108_864;
    assert.equal(parseClaim(sealClaim(exactLimit), BUCKET).inputBytes, SOURCE.length + 67_108_864);
  });

  it("requires verbatim public pins after legacy archive coordinates in the leased resolution", () => {
    const claim = publicReferenceClaim({archives: true}), fixture = publicReferenceFixture(claim), parsed = parseClaim(claim, BUCKET);
    assert.deepEqual(parseResolvedDataFiles(fixture.files, parsed, BUCKET), fixture.files);
    const wrongOrders = [[...fixture.files].reverse(), [fixture.files[0]],
      [fixture.files[0], {...fixture.files[1], bucket: BUCKET}],
      [fixture.files[0], {...fixture.files[1], url: "https://public.example.test/changed.tif"}],
      [fixture.files[0], {...fixture.files[1], resourceVersionNumber: 2}]];
    for (const files of wrongOrders) assert.throws(() => parseResolvedDataFiles(files, parsed, BUCKET));
  });

  it("admits only exact TIFF output pins for request1 archive and public reference previews within the 32 MiB cap", () => {
    const claim = parseClaim(publicReferenceClaim(), BUCKET);
    const reportWithTiff = (targetClaim, media = "image/tiff") => {
      const execution = compilerExecution(targetClaim, {outputs: new Map([...OUTPUTS, ["dist/exact.tif", PUBLIC_TIFF]])});
      Object.assign(execution.report.validationReport, {inputFileCount: targetClaim.inputFileCount, inputBytes: targetClaim.inputBytes});
      execution.report.outputManifest.files.find(file => file.path === "dist/exact.tif").contentType = media;
      execution.report.outputTreeChecksumSha256 = sha256(Buffer.from(JSON.stringify(execution.report.outputManifest.files)));
      return execution.report;
    };
    for (const media of ["image/tiff", "image/geotiff"]) assert.doesNotThrow(() => parseCompilerReport(reportWithTiff(claim, media), claim));
    for (const changes of [{sizeBytes: PUBLIC_TIFF.length + 1}, {checksumSha256: "a".repeat(64)}, {path: "dist/exact.png"}]) {
      const report = reportWithTiff(claim);
      Object.assign(report.outputManifest.files.find(file => file.path === "dist/exact.tif"), changes);
      assert.throws(() => parseCompilerReport(report, claim), /compiler_output_invalid/);
    }
    const legacyArchive = publicReferenceClaim({archives: true});
    legacyArchive.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
    delete legacyArchive.inputManifest.referencedFiles;
    const archive = parseClaim(sealClaim(legacyArchive), BUCKET);
    for (const media of ["image/tiff", "image/geotiff"]) assert.doesNotThrow(() => parseCompilerReport(reportWithTiff(archive, media), archive));
    for (const changes of [{sizeBytes: PUBLIC_TIFF.length + 1}, {checksumSha256: "a".repeat(64)}, {path: "dist/exact.png"}]) {
      const report = reportWithTiff(archive);
      Object.assign(report.outputManifest.files.find(file => file.path === "dist/exact.tif"), changes);
      assert.throws(() => parseCompilerReport(report, archive), /compiler_output_invalid/);
    }
    const sourceOnly = parseClaim(fixtureClaim(), BUCKET);
    assert.throws(() => parseCompilerReport(reportWithTiff(sourceOnly), sourceOnly), /compiler_output_invalid/);
    legacyArchive.inputManifest.dataAttachments[0].sizeBytes = 33 * 1024 * 1024;
    const largeArchive = parseClaim(sealClaim(legacyArchive), BUCKET), archiveReport = reportWithTiff(largeArchive);
    archiveReport.outputManifest.files.find(file => file.path === "dist/exact.tif").sizeBytes = 33 * 1024 * 1024;
    assert.throws(() => parseCompilerReport(archiveReport, largeArchive), /compiler_output_invalid/);
    const large = publicReferenceClaim(); large.inputManifest.referencedFiles[0].sizeBytes = 33 * 1024 * 1024;
    const parsedLarge = parseClaim(sealClaim(large), BUCKET), report = reportWithTiff(parsedLarge);
    report.outputManifest.files.find(file => file.path === "dist/exact.tif").sizeBytes = 33 * 1024 * 1024;
    assert.throws(() => parseCompilerReport(report, parsedLarge), /compiler_output_invalid/);
  });

  it("denies paired distribution approval fields for a request4 public reference preview", () => {
    const claim = publicReferenceClaim({localized: true});
    assert.doesNotThrow(() => parseClaim(claim, BUCKET));
    Object.assign(claim.request, {distributionApprovalId: ID.object, distributionApprovalChecksumSha256: "a".repeat(64)});
    assert.throws(() => parseClaim(sealClaim(claim), BUCKET), /referenced_manifest_invalid/);
  });

  it("retains all exact archive and referenced paths in the single HTML output seal", () => {
    const claim = parseClaim(publicReferenceClaim({localized: true, aliases: true, archives: true}), BUCKET);
    const files = [{path: "dist/index.html", contentType: "text/html",
      bytes: Buffer.from('<!doctype html><img src="./exact.tif" alt="Synthetic TIFF">')},
    {path: "dist/exact.tif", contentType: "application/octet-stream", bytes: PUBLIC_TIFF}]
      .map(file => ({...file, sizeBytes: file.bytes.length, checksumSha256: sha256(file.bytes)}));
    const localized = localizeFrameworkOutput({files, archivePins: runnerInvocation(claim).dataFiles});
    const execution = compilerExecution(claim, {outputs: new Map([["dist/index.html", Buffer.from(localized.html)]])});
    execution.report.schemaVersion = LOCALIZED_REPORT_SCHEMA;
    Object.assign(execution.report.validationReport, {inputBytes: claim.inputBytes, inputFileCount: claim.inputFileCount});
    const nativeDescriptors = files.map(({bytes, ...file}) => file).sort((a, b) => a.path < b.path ? -1 : 1);
    const manifest = {...localized.manifest, sourceOutputTreeChecksumSha256: sha256(Buffer.from(JSON.stringify(nativeDescriptors))),
      output: execution.report.outputManifest.files[0]};
    execution.report.localizedOutput = {manifest, manifestChecksumSha256: sha256(Buffer.from(jsonbText(manifest)))};
    assert.deepEqual(manifest.assets[0].archivePaths, ["data/Z.tif", "data/a.tif", "data/b.tif"]);
    assert.doesNotThrow(() => parseCompilerReport(execution.report, claim));
    manifest.assets[0].archivePaths.pop();
    execution.report.localizedOutput.manifestChecksumSha256 = sha256(Buffer.from(jsonbText(manifest)));
    assert.throws(() => parseCompilerReport(execution.report, claim), /localized_output_invalid/);
  });

  it("authorizes every reference while fetching one exact body per job and keeping the compiler offline", async () => {
    const claim = publicReferenceClaim({aliases: true, archives: true}), fixture = publicReferenceFixture(claim);
    const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture});
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(fixture.calls.publicRead.length, 1);
    const read = fixture.calls.publicRead[0];
    assert.deepEqual(Object.keys(read).sort(), ["checksumSha256", "contentType", "maximumBytes", "signal", "url"]);
    assert.equal(read.maximumBytes, PUBLIC_TIFF.length);
    assert.equal(read.signal.aborted, false);
    assert.equal(fixture.calls.resolutions.length, 5);
    for (const args of fixture.calls.resolutions) assert.equal(args[0], ID.build);
    for (const path of ["data/Z.tif", "data/a.tif", "data/b.tif"]) assert.deepEqual(fixture.calls.run[0].inputs.get(path), PUBLIC_TIFF);
    assert.doesNotMatch(JSON.stringify(fixture.calls.run[0].invocation), /https:|referenceId|resourceId|datasetId|custody|bucket|objectKey|s3VersionId/);
    assert.deepEqual(result.result.networkRequests, []);
    assert.deepEqual(result.result.sandbox, REQUIRED_SANDBOX);
    assert.equal(result.result.validationReport.publicationAuthorized, false);
  });

  it("refuses unavailable transport or changed public bytes before compile or output writes", async () => {
    for (const mode of ["unavailable", "hash", "size", "type", "storage-facts"]) {
      const claim = publicReferenceClaim(), fixture = publicReferenceFixture(claim, {read: async () => ({
        bytes: mode === "hash" ? Buffer.alloc(PUBLIC_TIFF.length) : PUBLIC_TIFF,
        sizeBytes: PUBLIC_TIFF.length + (mode === "size" ? 1 : 0),
        contentType: mode === "type" ? "application/octet-stream" : "image/tiff",
        checksumSha256: sha256(PUBLIC_TIFF), ...(mode === "storage-facts" ? {bucket: BUCKET} : {})
      })});
      if (mode === "unavailable") delete fixture.storage.readPublicExact;
      const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture});
      assert.equal(result.status, "failed", mode);
      assert.equal(fixture.calls.run.length, 0, mode);
      assert.equal(fixture.calls.write.length, 0, mode);
      assert.equal(fixture.calls.complete.length, 0, mode);
      if (mode === "unavailable") assert.equal(fixture.calls.read.length, 0);
    }
  });

  it("rechecks current authority before GET, after staging, after compile and before completion", async () => {
    for (const revokeAt of [2, 3, 4, 5]) {
      const claim = publicReferenceClaim(), fixture = publicReferenceFixture(claim, {
        resolve: (files, count) => count >= revokeAt ? [] : structuredClone(files)
      });
      const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture});
      assert.equal(result.status, "failed", `resolution ${revokeAt}`);
      assert.equal(fixture.calls.complete.length, 0);
      assert.equal(fixture.calls.publicRead.length, revokeAt === 2 ? 0 : 1);
      assert.equal(fixture.calls.run.length, revokeAt <= 3 ? 0 : 1);
      assert.equal(fixture.calls.write.length, revokeAt < 5 ? 0 : OUTPUTS.size);
    }
  });

  it("cancels the active public helper promptly on lease loss and uses one total staging deadline", async () => {
    for (const mode of ["lease", "deadline"]) {
      const claim = publicReferenceClaim({aliases: true});
      let aborted = false;
      const fixture = publicReferenceFixture(claim, {
        heartbeat: count => mode !== "lease" || count === 1,
        read: async ({signal}) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("helper outlived its deadline")), 300);
          signal.addEventListener("abort", () => {
            clearTimeout(timer); aborted = true; reject(Error("cancelled helper"));
          }, {once: true});
        })
      });
      const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture,
        heartbeatIntervalMilliseconds: mode === "lease" ? 5 : 1000, publicStagingMilliseconds: 20});
      assert.equal(result.errorCode, mode === "lease" ? "build_lease_lost" : "public_file_staging_timeout");
      assert.equal(aborted, true);
      assert.equal(fixture.calls.publicRead.length, 1);
      assert.equal(fixture.calls.run.length, 0);
      assert.equal(fixture.calls.write.length, 0);
    }
  });

  it("shares the staging deadline across distinct public bodies instead of restarting it per GET", async () => {
    const claim = publicReferenceClaim({aliases: true});
    claim.inputManifest.referencedFiles[1].url = "https://public.example.test/second.tif";
    sealClaim(claim);
    const signals = [];
    const fixture = publicReferenceFixture(claim, {
      read: async ({signal}, count) => {
        signals.push(signal);
        if (count === 1) {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {bytes: PUBLIC_TIFF, contentType: "image/tiff", sizeBytes: PUBLIC_TIFF.length, checksumSha256: sha256(PUBLIC_TIFF)};
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("helper outlived the job deadline")), 300);
          signal.addEventListener("abort", () => {clearTimeout(timer); reject(Error("cancelled helper"));}, {once: true});
        });
      }
    });
    const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture,
      heartbeatIntervalMilliseconds: 1000, publicStagingMilliseconds: 30});
    assert.equal(result.errorCode, "public_file_staging_timeout");
    assert.equal(fixture.calls.publicRead.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[1].aborted, true);
    assert.equal(fixture.calls.run.length, 0);
  });
});

describe("public reference distribution contracts", () => {
  it("requires paired sealed approval pins for request3 and request4 public reference releases", () => {
    for (const localized of [false, true]) {
      const claim = parseClaim(publicReferenceReleaseClaim({localized, aliases: true, archives: true}), BUCKET);
      const invocation = runnerInvocation(claim);
      assert.equal(invocation.schemaVersion, `opengeo.observable-runner-invocation.${localized ? 5 : 4}.0.0`);
      assert.equal(invocation.request.purpose, "release_candidate");
      assert.equal(invocation.request.distributionApprovalId, ID.upload);
      assert.equal(invocation.request.distributionApprovalChecksumSha256, "a".repeat(64));
      assert.deepEqual(invocation.dataFiles.map(file => file.path), ["data/Z.tif", "data/a.tif", "data/b.tif"]);
      assert.doesNotThrow(() => parseInvocation(invocation));
      assert.doesNotMatch(JSON.stringify(invocation), /https:|referenceId|resourceId|datasetId|custody|bucket|objectKey|s3VersionId/);
    }
  });

  it("denies omitted, malformed or unsealed public reference release approvals without a source-only shortcut", () => {
    for (const localized of [false, true]) {
      for (const edit of [
        claim => {delete claim.request.distributionApprovalId;},
        claim => {delete claim.request.distributionApprovalChecksumSha256;},
        claim => {claim.request.distributionApprovalId = null;},
        claim => {claim.request.distributionApprovalChecksumSha256 = null;},
        claim => {Object.assign(claim.request, {distributionApprovalId: null, distributionApprovalChecksumSha256: null});},
        claim => {claim.request.distributionApprovalId = "other-approval";},
        claim => {claim.request.distributionApprovalChecksumSha256 = "not-sha256";},
        claim => {claim.request.distributionApproval = {rights: "approved"};},
        claim => {claim.artifactInputs = {};},
        claim => {claim.request.schemaVersion = REQUEST_SCHEMA;}
      ]) {
        const claim = publicReferenceReleaseClaim({localized}); edit(claim);
        assert.throws(() => parseClaim(sealClaim(claim), BUCKET));
      }
      const unsealed = publicReferenceReleaseClaim({localized});
      unsealed.request.distributionApprovalId = ID.object;
      assert.throws(() => parseClaim(unsealed, BUCKET), /sealed_checksum_mismatch/);
      const checksumTamper = publicReferenceReleaseClaim({localized});
      checksumTamper.request.distributionApprovalChecksumSha256 = "b".repeat(64);
      assert.throws(() => parseClaim(checksumTamper, BUCKET), /sealed_checksum_mismatch/);
    }
  });

  it("admits exact request3 referenced TIFF outputs and applies the sealed default or expanded output budget", () => {
    const reportFor = (claim, sizeBytes, contentType = "image/tiff") => {
      const report = compilerExecution(claim, {outputs: new Map([...OUTPUTS, ["dist/exact.tif", PUBLIC_TIFF]])}).report;
      Object.assign(report.validationReport, {inputBytes: claim.inputBytes, inputFileCount: claim.inputFileCount});
      Object.assign(report.outputManifest.files.find(file => file.path === "dist/exact.tif"), {sizeBytes, contentType});
      report.validationReport.outputBytes = report.outputManifest.files.reduce((total, file) => total + file.sizeBytes, 0);
      report.outputTreeChecksumSha256 = sha256(Buffer.from(JSON.stringify(report.outputManifest.files)));
      return report;
    };
    const ordinary = parseClaim(publicReferenceReleaseClaim(), BUCKET);
    for (const media of ["image/tiff", "image/geotiff"]) assert.doesNotThrow(() => parseCompilerReport(reportFor(ordinary, PUBLIC_TIFF.length, media), ordinary));
    for (const change of [{checksumSha256: "b".repeat(64)}, {sizeBytes: PUBLIC_TIFF.length + 1}, {path: "dist/exact.png"}]) {
      const report = reportFor(ordinary, PUBLIC_TIFF.length);
      Object.assign(report.outputManifest.files.find(file => file.path === "dist/exact.tif"), change);
      assert.throws(() => parseCompilerReport(report, ordinary), /compiler_output_invalid/);
    }
    const large = publicReferenceReleaseClaim();
    large.inputManifest.referencedFiles[0].sizeBytes = 64 * 1024 * 1024;
    const defaultClaim = parseClaim(sealClaim(large), BUCKET);
    assert.throws(() => parseCompilerReport(reportFor(defaultClaim, 64 * 1024 * 1024), defaultClaim), /compiler_output_invalid/);
    Object.assign(large.request, {outputProfile: "archive-96m", sizeAcknowledgment: "allow-up-to-96-mib-output"});
    const expanded = parseClaim(sealClaim(large), BUCKET);
    assert.equal(executionLimits(expanded.request).maxOutputBytes, 96 * 1024 * 1024);
    assert.doesNotThrow(() => parseCompilerReport(reportFor(expanded, 64 * 1024 * 1024), expanded));
    assert.throws(() => parseCompilerReport(reportFor(expanded, 64 * 1024 * 1024 + 1), expanded), /compiler_output_invalid/);
    const legacy = publicReferenceReleaseClaim({archives: true});
    legacy.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA; delete legacy.inputManifest.referencedFiles;
    const parsedLegacy = parseClaim(sealClaim(legacy), BUCKET);
    assert.doesNotThrow(() => parseCompilerReport(reportFor(parsedLegacy, PUBLIC_TIFF.length), parsedLegacy));
  });

  it("coordinates exact public reference releases and rejects current approval or publish-authority withdrawal", async () => {
    for (const localized of [false, true]) {
      for (const mode of ["success", "approval-withdrawn-after-compile", "publish-withdrawn-before-GET", "publish-withdrawn-before-completion"]) {
        const claim = publicReferenceReleaseClaim({localized, aliases: true, archives: true}), parsed = parseClaim(claim, BUCKET);
        const suppliedExecution = localized ? publicReferenceLocalizedExecution(parsed) : compilerExecution(parsed);
        const revokeAt = mode === "publish-withdrawn-before-GET" ? 2 : mode === "approval-withdrawn-after-compile" ? 4 : 5;
        const fixture = publicReferenceFixture(claim, {execution: suppliedExecution,
          resolve: (files, count) => {
            if (mode !== "success" && count >= revokeAt) {
              // The database owns current approval and independent input publish
              // authority. A sealed historical approval does not skip resolution.
              throw new CoordinatorContractError(mode.startsWith("approval-")
                ? "distribution_approval_unavailable" : "referenced_publish_authority_unavailable");
            }
            return structuredClone(files);
          }
        });
        const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture});
        assert.equal(result.status, mode === "success" ? "succeeded" : "failed", `${localized}/${mode}: ${JSON.stringify(result)}`);
        assert.equal(fixture.calls.publicRead.length, mode === "publish-withdrawn-before-GET" ? 0 : 1);
        assert.equal(fixture.calls.run.length, mode === "publish-withdrawn-before-GET" ? 0 : 1);
        assert.equal(fixture.calls.complete.length, mode === "success" ? 1 : 0);
        if (mode === "success") {
          assert.equal(fixture.calls.resolutions.length, 5);
          assert.equal(result.result.schemaVersion, localized ? LOCALIZED_RESULT_SCHEMA : "opengeo.observable-build-result.1.0.0");
          assert.equal(result.result.validationReport.publicationAuthorized, false);
          assert.deepEqual(result.result.networkRequests, []);
          assert.deepEqual(result.result.sandbox, REQUIRED_SANDBOX);
          if (localized) assert.deepEqual(result.result.localizedOutput.manifest.assets[0].archivePaths, ["data/Z.tif", "data/a.tif", "data/b.tif"]);
        } else {
          assert.equal(fixture.calls.write.length, mode === "publish-withdrawn-before-completion" ? (localized ? 1 : OUTPUTS.size) : 0);
        }
        assert.doesNotMatch(JSON.stringify(runnerInvocation(parsed)), /https:|referenceId|resourceId|datasetId|custody|bucket|objectKey|s3VersionId/);
      }
    }
  });
});

it("stages pinned archive bytes and reauthorizes before accepting a private preview", async () => {
  const claim = fixtureClaim();
  const bytes = Buffer.from('{"type":"FeatureCollection","features":[]}');
  const pin = {path: "data/water.geojson", attachmentId: ID.object, dataObjectId: ID.object,
    datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1",
    contentType: "application/geo+json", sizeBytes: bytes.length, checksumSha256: sha256(bytes)};
  claim.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
  claim.inputManifest.dataAttachments = [pin];
  claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
  claim.request.sourceManifestChecksumSha256 = claim.inputManifestChecksumSha256;
  claim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.request)));
  const resolved = {...pin, bucket: BUCKET, objectKey: `organizations/${ID.organization}/projects/${ID.project}/datasets/${ID.project}/uploads/${ID.upload}/original/water.geojson`, etag: "archive-etag"};
  for (const mode of ["success", "changed-bytes", "revoked-after-compile", "wrong-dataset", "missing-resolver", "public-success", "public-revoked-after-compile"]) {
    const currentClaim = structuredClone(claim);
    const publicBuild = mode.startsWith("public-");
    if (publicBuild) {
      currentClaim.purpose = "release_candidate";
      Object.assign(currentClaim.request, {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA, purpose: "release_candidate",
        outputProfile: "default-32m", sizeAcknowledgment: null, distributionApprovalId: ID.object,
        distributionApprovalChecksumSha256: "e".repeat(64)});
      currentClaim.requestChecksumSha256 = sha256(Buffer.from(jsonbText(currentClaim.request)));
    }
    const execution = compilerExecution(currentClaim);
    execution.report.validationReport.inputFileCount = 2;
    execution.report.validationReport.inputBytes += bytes.length;
    const fixture = harness({claim: currentClaim, execution});
    let resolutions = 0;
    if (mode !== "missing-resolver") fixture.repository.resolveDataAttachments = async () => {
      resolutions++;
      return mode.endsWith("revoked-after-compile") && resolutions > 2 ? [] :
        [{...resolved, ...(mode === "wrong-dataset" ? {datasetId: ID.otherOrganization} : {})}];
    };
    fixture.storage.readArchiveExact = async request => {
      assert.equal(request.s3VersionId, "archive-v1");
      assert.equal(request.organizationId, ID.organization);
      assert.equal(request.maximumBytes, bytes.length);
      return {bucket: BUCKET, objectKey: resolved.objectKey, s3VersionId: pin.s3VersionId,
        etag: resolved.etag, contentType: pin.contentType, checksumSha256: pin.checksumSha256,
        bytes: mode === "changed-bytes" ? Buffer.alloc(bytes.length) : bytes};
    };
    const result = await coordinateBuild({buildJobId: ID.build, expectedBucket: BUCKET, ...fixture});
    const succeeded = mode === "success" || mode === "public-success";
    assert.equal(result.status, succeeded ? "succeeded" : "failed");
    if (succeeded) {
      assert.equal(resolutions, 4);
      assert.deepEqual(fixture.calls.run[0].inputs.get(pin.path), bytes);
      assert.equal(fixture.calls.run[0].invocation.schemaVersion, `opengeo.observable-runner-invocation.${publicBuild ? 4 : 2}.0.0`);
      assert.doesNotMatch(JSON.stringify(fixture.calls.run[0].invocation), /bucket|objectKey|s3VersionId|etag/);
    } else {
      assert.equal(fixture.calls.write.length, 0);
      assert.equal(fixture.calls.complete.length, 0);
    }
  }
});

it("seals expanded archive budgets and public approvals while preserving ordinary file and legacy limits", () => {
  const claim = fixtureClaim();
  const pin = {path: "data/elevation.tif", attachmentId: ID.object, dataObjectId: ID.object,
    datasetId: ID.project, datasetVersionId: ID.revision, s3VersionId: "archive-v1",
    contentType: "image/tiff", sizeBytes: 64_912_721, checksumSha256: "c".repeat(64)};
  claim.inputManifest.schemaVersion = DATA_MANIFEST_SCHEMA;
  claim.inputManifest.dataAttachments = [pin];
  claim.inputManifestChecksumSha256 = sha256(Buffer.from(jsonbText(claim.inputManifest)));
  Object.assign(claim.request, {schemaVersion: DISTRIBUTION_REQUEST_SCHEMA, outputProfile: "archive-96m",
    sourceManifestChecksumSha256: claim.inputManifestChecksumSha256, sizeAcknowledgment: "allow-up-to-96-mib-output",
    distributionApprovalId: null, distributionApprovalChecksumSha256: null});
  const sealed = value => {value.requestChecksumSha256 = sha256(Buffer.from(jsonbText(value.request))); return value;};
  const parsed = parseClaim(sealed(claim), BUCKET);
  assert.equal(parsed.request.resourceLimits.maxOutputBytes, 32 * 1024 * 1024);
  assert.equal(executionLimits(parsed.request).maxOutputBytes, 96 * 1024 * 1024);
  const output = {path: "dist/_file/elevation.abcd.tif", sizeBytes: pin.sizeBytes, checksumSha256: pin.checksumSha256};
  assert.equal(maximumOutputFileBytes(output, parsed.request, [pin]), 64 * 1024 * 1024);
  assert.equal(maximumOutputFileBytes({...output, checksumSha256: "d".repeat(64)}, parsed.request, [pin]), 32 * 1024 * 1024);
  assert.equal(maximumOutputFileBytes({...output, path: "dist/index.html"}, parsed.request, [pin]), 32 * 1024 * 1024);
  assert.equal(runnerInvocation(parsed).schemaVersion, "opengeo.observable-runner-invocation.4.0.0");
  const release = structuredClone(claim); release.purpose = release.request.purpose = "release_candidate";
  assert.throws(() => parseClaim(sealed(release), BUCKET), /distribution_request_invalid/);
  Object.assign(release.request, {distributionApprovalId: ID.object, distributionApprovalChecksumSha256: "e".repeat(64)});
  assert.equal(parseClaim(sealed(release), BUCKET).purpose, "release_candidate");
  const reviewedPreview = structuredClone(release); reviewedPreview.purpose = reviewedPreview.request.purpose = "preview";
  assert.equal(parseClaim(sealed(reviewedPreview), BUCKET).purpose, "preview");
  for (const mutate of [value => {value.request.sizeAcknowledgment = null;},
    value => {value.request.resourceLimits.maxOutputBytes = 96 * 1024 * 1024;},
    value => {value.request.distributionApprovalId = ID.object;}]) {
    const changed = structuredClone(claim); mutate(changed);
    assert.throws(() => parseClaim(sealed(changed), BUCKET));
  }
});

describe("least-authority Observable coordinator", () => {
  it("matches PostgreSQL jsonb text ordering used by sealed checksums", () => {
    assert.equal(
      jsonbText({bb: 2, a: 1, ccc: 3}),
      '{"a": 1, "bb": 2, "ccc": 3}'
    );
  });

  it("pins the compiler image and complete local isolation policy in Podman arguments", () => {
    const args = podmanArguments({
      contract: "/tmp/job/contract",
      input: "/tmp/job/input",
      workspace: "/tmp/job/workspace",
      result: "/tmp/job/result",
      imageDigest: IMAGE,
      limits: fixtureClaim().request.resourceLimits
    });
    assert.equal(args.at(-1), IMAGE);
    for (const expected of [
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=all",
      "--security-opt=no-new-privileges",
      "--user=10001:10001",
      "--pids-limit=128",
      "--memory=2048m",
      "--memory-swap=2048m",
      "--cpus=1.000"
    ]) assert.ok(args.includes(expected), expected);
    assert.equal(args.some((value) => /docker\.sock|AWS_|credential/i.test(value)), false);
  });

  it("reverifies exact inputs and outputs without disclosing storage authority to the runner", async () => {
    const {calls, result} = await coordinate();
    assert.equal(result.status, "succeeded");
    assert.equal(calls.run.length, 1);
    assert.deepEqual(calls.read[0], {
      bucket: BUCKET,
      objectKey: sourceKey(),
      s3VersionId: "source-v1",
      maximumBytes: SOURCE.length
    });
    const serializedInvocation = JSON.stringify(calls.run[0].invocation);
    assert.doesNotMatch(serializedInvocation, /bucket|objectKey|s3VersionId|etag|credential/i);
    assert.deepEqual([...calls.run[0].inputs], [["index.md", SOURCE]]);
    assert.equal(calls.write.length, 2);
    assert.equal(calls.complete.length, 1);
    assert.equal(calls.fail.length, 0);
    assert.deepEqual(result.result.sandbox, {
      credentialMode: "none",
      networkPolicy: "deny_all",
      readOnlyInputs: true,
      readOnlyBaseImage: true,
      unprivilegedUser: true,
      dockerSocket: false
    });
    assert.deepEqual(result.result.networkRequests, []);
    assert.equal(result.result.validationReport.publicationAuthorized, false);
  });

  it("fails a claimed job when an immutable source byte no longer matches", async () => {
    const {calls, result} = await coordinate({
      read(args) {
        const claim = fixtureClaim();
        const file = claim.inputManifest.files[0];
        return {
          bucket: file.bucket,
          objectKey: args.objectKey,
          s3VersionId: file.s3VersionId,
          etag: file.etag,
          contentType: file.contentType,
          checksumSha256: file.checksumSha256,
          bytes: Buffer.from("tampered")
        };
      }
    });
    assert.deepEqual(result, {status: "failed", buildJobId: ID.build, errorCode: "stored_source_mismatch"});
    assert.equal(calls.run.length, 0);
    assert.equal(calls.write.length, 0);
    assert.equal(calls.fail.length, 1);
  });

  it("fails a claimed cross-tenant source key before any storage access", async () => {
    const claim = fixtureClaim();
    claim.inputManifest.files[0].objectKey = sourceKey(ID.otherOrganization);
    const {calls, result} = await coordinate({claim});
    assert.equal(result.errorCode, "source_object_key_invalid");
    assert.equal(calls.read.length, 0);
    assert.equal(calls.run.length, 0);
    assert.equal(calls.fail.length, 1);
  });

  it("fails a claimed record whose sealed JSON checksum is mislabeled", async () => {
    const claim = fixtureClaim();
    claim.requestChecksumSha256 = "0".repeat(64);
    const {calls, result} = await coordinate({claim});
    assert.equal(result.errorCode, "sealed_checksum_mismatch");
    assert.equal(calls.read.length, 0);
    assert.equal(calls.fail.length, 1);
  });

  it("terminally fails the claimed lease when the baked compiler digest differs", async () => {
    const {calls, result} = await coordinate({
      expectedCompilerImageDigest: `sha256:${"d".repeat(64)}`
    });
    assert.deepEqual(result, {
      status: "failed",
      buildJobId: ID.build,
      errorCode: "compiler_image_mismatch"
    });
    assert.equal(calls.read.length, 0);
    assert.equal(calls.run.length, 0);
    assert.equal(calls.fail.length, 1);
  });

  it("rejects extra runner output bytes before upload", async () => {
    const claim = fixtureClaim();
    const execution = compilerExecution(claim);
    execution.outputs.set("dist/unreported.txt", Buffer.from("extra"));
    const {calls, result} = await coordinate({claim, execution});
    assert.equal(result.errorCode, "runner_output_tree_mismatch");
    assert.equal(calls.write.length, 0);
    assert.equal(calls.complete.length, 0);
  });

  it("rejects a runner that cannot attest the required sandbox", async () => {
    const claim = fixtureClaim();
    const execution = compilerExecution(claim);
    execution.sandbox.networkPolicy = "host";
    const {calls, result} = await coordinate({claim, execution});
    assert.equal(result.errorCode, "runner_sandbox_invalid");
    assert.equal(calls.write.length, 0);
  });

  it("derives and enforces the exact route manifest from HTML outputs", async () => {
    const claim = fixtureClaim();
    const execution = compilerExecution(claim, {
      routeManifest: [{path: "/escape", file: "dist/index.html"}]
    });
    const {calls, result} = await coordinate({claim, execution});
    assert.equal(result.errorCode, "route_manifest_invalid");
    assert.equal(calls.write.length, 0);
  });

  it("releases a retryable transport failure under the bounded attempt policy", async () => {
    const {calls, result} = await coordinate({
      read() {
        throw Object.assign(new Error("throttled"), {code: "s3_throttled", retryable: true});
      }
    });
    assert.deepEqual(result, {status: "pending", buildJobId: ID.build, errorCode: "s3_throttled"});
    assert.equal(calls.release.length, 1);
    assert.equal(calls.release[0][3], 3);
    assert.equal(calls.fail.length, 0);
  });

  it("does not act on a busy or terminal claim outcome", async () => {
    const claim = fixtureClaim();
    claim.claimStatus = "busy";
    const {calls, result} = await coordinate({claim});
    assert.deepEqual(result, {status: "busy", buildJobId: ID.build});
    assert.equal(calls.heartbeat.length, 0);
    assert.equal(calls.read.length, 0);
  });

  it("fails closed when the lease is lost before runner execution", async () => {
    const {calls, result} = await coordinate({heartbeat: () => false});
    assert.deepEqual(result, {status: "failed", buildJobId: ID.build, errorCode: "build_lease_lost"});
    assert.equal(calls.run.length, 0);
    assert.equal(calls.fail.length, 1);
  });

  it("aborts an active runner and uploads nothing when a lease heartbeat is lost", async () => {
    const claim = fixtureClaim();
    let runnerObservedAbort = false;
    const fixture = harness({
      claim,
      heartbeat: (count) => count === 1,
      runnerRun({signal}) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            runnerObservedAbort = true;
            resolve(compilerExecution(claim));
          }, {once: true});
        });
      }
    });
    const result = await coordinateBuild({
      buildJobId: ID.build,
      expectedBucket: BUCKET,
      repository: fixture.repository,
      storage: fixture.storage,
      runner: fixture.runner,
      heartbeatIntervalMilliseconds: 5
    });
    assert.equal(result.errorCode, "build_lease_lost");
    assert.equal(runnerObservedAbort, true);
    assert.equal(fixture.calls.write.length, 0);
    assert.equal(fixture.calls.complete.length, 0);
  });

  it("fails when storage reports an output bucket outside the exact authority", async () => {
    const {calls, result} = await coordinate({
      write(args) {
        return {
          bucket: "other.opengeo.tools",
          objectKey: args.objectKey,
          s3VersionId: "output-v1",
          etag: "output-etag",
          contentType: args.contentType,
          sizeBytes: args.bytes.length,
          checksumSha256: args.checksumSha256
        };
      }
    });
    assert.equal(result.errorCode, "stored_output_bucket_mismatch");
    assert.equal(calls.complete.length, 0);
    assert.equal(calls.fail.length, 1);
  });
});

it('stages immutable Artifact bytes through the actual compiler and rechecks before completion', async () => {
  const {compilePortableMapArtifact}=await import('../../../app/src/lib/portableMapArtifact.js');
  const portable=await compilePortableMapArtifact({title:'Retained survey',runtimeJs:'/* synthetic */',runtimeCss:'body{}',runtimeLicense:'BSD',
    candidates:[{id:'sites',sourceId:'sites',title:'Sites',visible:true,paintOrder:{sites:0},
      source:{type:'geojson',data:{type:'FeatureCollection',features:[]}},paints:[{id:'sites',source:'sites',type:'circle'}]}],selectedIds:['sites']});
  const bytes=Buffer.from(portable.html);
  const source=Buffer.from('<!doctype html><title>Survey</title><iframe src="maps/survey.html" sandbox="allow-scripts"></iframe>');
  const raw=fixtureClaim({path:'index.html',bytes:source,contentType:'text/html'});
  raw.artifactInputs={schemaVersion:'opengeo.publication-artifact-inputs.1.0.0',sourceProjectId:ID.sourceProject,
    sourceRevisionId:ID.revision,sourceManifestChecksumSha256:raw.inputManifestChecksumSha256,referenceRevision:1,
    artifacts:[{path:'maps/survey.html',artifactId:ID.object,version:1,outputObjectId:ID.upload,
      manifestChecksumSha256:portable.manifest.manifestChecksumSha256,output:portable.manifest.output}]};
  raw.request.schemaVersion='opengeo.observable-build-request.2.0.0';
  raw.request.artifactInputsChecksumSha256=sha256(Buffer.from(jsonbText(raw.artifactInputs)));
  raw.requestChecksumSha256=sha256(Buffer.from(jsonbText(raw.request)));
  const file={path:'maps/survey.html',artifactId:ID.object,outputObjectId:ID.upload,bucket:BUCKET,
    objectKey:`organizations/${ID.organization}/projects/${ID.project}/artifacts/${ID.object}/uploads/${ID.upload}/map.html`,
    s3VersionId:'artifact-v1',etag:'artifact-etag',contentType:'text/html',sizeBytes:bytes.length,checksumSha256:sha256(bytes)};
  for (const mode of ['success','duplicate','revoked','revoked-after-build','tampered','wrong-artifact']) {
    let reads=0,resolutions=0;
    const selected=structuredClone(raw);
    if(mode==='duplicate') {
      selected.artifactInputs.artifacts.push({...structuredClone(selected.artifactInputs.artifacts[0]),path:'maps/survey2.html'});
      selected.request.artifactInputsChecksumSha256=sha256(Buffer.from(jsonbText(selected.artifactInputs)));
      selected.requestChecksumSha256=sha256(Buffer.from(jsonbText(selected.request)));
    }
    const root=mkdtempSync(join(tmpdir(),'opengeo-coordinator-artifact-'));
    try {
      const fixture=harness({claim:selected,read:async()=>{
        const entry=raw.inputManifest.files[0];
        return {bucket:entry.bucket,objectKey:entry.objectKey,s3VersionId:entry.s3VersionId,etag:entry.etag,
          contentType:entry.contentType,checksumSha256:entry.checksumSha256,bytes:source};
      },runnerRun:async({invocation,inputs})=>{
        const input=join(root,'input');mkdirSync(join(input,'maps'),{recursive:true});
        for (const [path,body] of inputs) writeFileSync(join(input,path),body);
        const report=runBuild({invocation,inputRoot:input,workspaceRoot:join(root,'workspace')});
        const outputs=new Map(report.outputManifest.files.map(f=>[f.path,readFileSync(join(root,'workspace',f.path))]));
        assert.deepEqual(outputs.get('dist/maps/survey.html'),bytes);
        return {report,outputs,sandbox:structuredClone(REQUIRED_SANDBOX)};
      }});
      fixture.repository.resolveArtifactInputs=async()=>{
        resolutions++;
        return selected.artifactInputs.artifacts.map(pin=>({...file,path:pin.path, ...(mode==='wrong-artifact' ? {artifactId:ID.upload}:{}),
          ...(((mode==='revoked' && resolutions>1) || (mode==='revoked-after-build' && resolutions>2)) ? {s3VersionId:'changed'}:{})}));
      };
      fixture.storage.readArtifactExact=async()=>{reads++;return {
        bucket:file.bucket,objectKey:file.objectKey,s3VersionId:file.s3VersionId,etag:file.etag,
        contentType:file.contentType,checksumSha256:file.checksumSha256,
        bytes:mode==='tampered'?Buffer.from('changed'):bytes};};
      const result=await coordinateBuild({buildJobId:ID.build,expectedBucket:BUCKET,...fixture});
      if (mode==='success'||mode==='duplicate') {
        assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(reads,1);assert.equal(resolutions,4);
        assert.equal(fixture.calls.complete.length,1);assert.equal(fixture.calls.run.length,1);
      } else {
        assert.equal(result.status,'failed');assert.equal(fixture.calls.complete.length,0);
        assert.equal(fixture.calls.run.length,mode==='revoked-after-build'?1:0);assert.equal(fixture.calls.write.length,0);
      }
    } finally {rmSync(root,{recursive:true,force:true});}
  }
});
