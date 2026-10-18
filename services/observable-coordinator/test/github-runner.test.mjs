import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {GitHubPinnedSourceRunner, validateGitHubExecution} from "../src/github-runner.mjs";
import {runGitHubBuild, githubBuildMain} from "../scripts/run-github-build.mjs";
import {sha256} from "../src/contracts.mjs";

const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const WORKFLOW = "a".repeat(40);
const SOURCE = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const BUILD = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.from("# Exact Studio source\n");
const blobSha = body => createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
const file = {path: "src/index.md", sizeBytes: bytes.length, checksumSha256: sha256(bytes)};

function executionEnvironment() {
  return {GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: WORKFLOW, GITHUB_WORKFLOW_SHA: WORKFLOW,
    GITHUB_REF: `refs/heads/studio-runtime-${WORKFLOW}`, OPEN_GEO_EXPECTED_WORKFLOW_SHA: WORKFLOW,
    OPEN_GEO_BUILD_JOB_ID: BUILD, OPEN_GEO_GITHUB_SOURCE_COMMIT: COMMIT,
    GITHUB_REPOSITORY: "owner/private", GITHUB_REPOSITORY_ID: "123", GITHUB_RUN_ID: "456"};
}

test("GitHub build accepts only the reviewed manual runtime ref", () => {
  const env = executionEnvironment();
  assert.equal(validateGitHubExecution(env).commit, COMMIT);
  assert.equal(validateGitHubExecution(env).sourceMode, "github");
  for (const change of [{GITHUB_EVENT_NAME: "push"}, {GITHUB_REF: "refs/heads/main"},
    {GITHUB_SHA: COMMIT}, {GITHUB_WORKFLOW_SHA: COMMIT}, {OPEN_GEO_GITHUB_SOURCE_COMMIT: "main"}]) {
    assert.throws(() => validateGitHubExecution({...env, ...change}), /github_execution_identity_invalid/);
  }
});

test("OpenGeo source mode keeps the canonical runner without reading a GitHub source token", async () => {
  const environment = {...executionEnvironment(), OPEN_GEO_BUILD_SOURCE_MODE: "opengeo",
    OPEN_GEO_GITHUB_SOURCE_COMMIT: "", GITHUB_REPOSITORY: "owner/public-runtime"};
  Object.defineProperty(environment, "OPEN_GEO_GITHUB_READ_TOKEN", {
    get() {throw Error("Canonical sources must not access a GitHub read token");}
  });
  let compiled = 0;
  const options = {invocation: {request: {sourceProjectId: SOURCE, sourceRevisionId: REVISION}, files: [file]},
    inputs: new Map([[file.path, bytes]])};
  const runner = {async run(received) {assert.equal(received, options);compiled++;return {ok: true};}};
  const dependencies = {runner};
  const {summary} = await runGitHubBuild({environment,
    dependenciesFactory(received, capabilities) {
      assert.equal(received, environment);
      assert.deepEqual(capabilities, {enablePublicFileStaging: true});
      return dependencies;
    },
    async processBuild(body, received) {
      assert.deepEqual(JSON.parse(body), {schema: "opengeo.observable-build.command.1.0.0", build_job_id: BUILD});
      assert.equal(received.runner, runner);
      await received.runner.run(options);
      return {buildJobId: BUILD, status: "succeeded"};
    }
  });
  assert.equal(compiled, 1);
  assert.equal(summary.sourceMode, "opengeo");
  assert.equal(summary.sourceCommit, null);
  delete environment.OPEN_GEO_GITHUB_SOURCE_COMMIT;
  assert.equal(validateGitHubExecution(environment).commit, null);
});

test("OpenGeo mode retains common execution checks before dependency initialization", async () => {
  const environment = {...executionEnvironment(), OPEN_GEO_BUILD_SOURCE_MODE: "opengeo", OPEN_GEO_GITHUB_SOURCE_COMMIT: ""};
  let initialized = 0;
  for (const change of [{OPEN_GEO_BUILD_SOURCE_MODE: ""}, {OPEN_GEO_BUILD_SOURCE_MODE: "other"},
    {OPEN_GEO_BUILD_JOB_ID: "../another-build"}, {GITHUB_REPOSITORY_ID: "9007199254740993"},
    {OPEN_GEO_GITHUB_SOURCE_COMMIT: COMMIT}, {GITHUB_EVENT_NAME: "push"},
    {GITHUB_REF: "refs/heads/main"}, {GITHUB_WORKFLOW_SHA: COMMIT}]) {
    await assert.rejects(runGitHubBuild({environment: {...environment, ...change},
      dependenciesFactory() {initialized++;throw Error("No dependencies before identity validation");}
    }), /github_execution_identity_invalid/);
  }
  assert.equal(initialized, 0);
});

test("independent runtime binds canonical mode, repository owner IDs, reviewed SHA and AWS custody before dependencies", async () => {
  const profile = {account: "111111111111", region: "us-east-1", repository: "owner/public-runtime",
    repositoryId: 123, ownerId: 321, runtimeSha: WORKFLOW,
    compilerRepository: "111111111111.dkr.ecr.us-east-1.amazonaws.com/opengeo/compiler"};
  const environment = {...executionEnvironment(), OPEN_GEO_BUILD_SOURCE_MODE: "opengeo", OPEN_GEO_GITHUB_SOURCE_COMMIT: "",
    OPEN_GEO_OBSERVABLE_INDEPENDENT_BUILD_CONFIG: JSON.stringify(profile),
    GITHUB_REPOSITORY: profile.repository, GITHUB_REPOSITORY_OWNER_ID: String(profile.ownerId),
    OPEN_GEO_AWS_REGION: profile.region,
    OPEN_GEO_DATA_API_CLUSTER_ARN: "arn:aws:rds:us-east-1:111111111111:cluster:independent-runtime",
    OPEN_GEO_DATA_API_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:independent/coordinator-AbCd12",
    OPEN_GEO_APPLICATION_KMS_KEY_ARN: "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-4000-8000-000000000001",
    OPEN_GEO_APPLICATION_BUCKET: "independent-source", OPEN_GEO_ARCHIVE_BUCKET: "independent-archive",
    OPEN_GEO_OBSERVABLE_COMPILER_REPOSITORY: profile.compilerRepository};
  assert.equal(validateGitHubExecution(environment).repository, profile.repository);
  let initialized = 0;
  for (const change of [
    {OPEN_GEO_BUILD_SOURCE_MODE: "github", OPEN_GEO_GITHUB_SOURCE_COMMIT: COMMIT},
    {OPEN_GEO_BUILD_SOURCE_MODE: undefined, OPEN_GEO_GITHUB_SOURCE_COMMIT: COMMIT},
    {GITHUB_REPOSITORY: "attacker/public-runtime"}, {GITHUB_REPOSITORY_ID: "124"}, {GITHUB_REPOSITORY_ID: "123\n"},
    {GITHUB_REPOSITORY_OWNER_ID: undefined}, {GITHUB_REPOSITORY_OWNER_ID: "322"},
    {GITHUB_REPOSITORY_OWNER_ID: "0321"}, {GITHUB_WORKFLOW_SHA: COMMIT},
    {OPEN_GEO_EXPECTED_WORKFLOW_SHA: COMMIT, GITHUB_SHA: COMMIT, GITHUB_WORKFLOW_SHA: COMMIT,
      GITHUB_REF: `refs/heads/studio-runtime-${COMMIT}`},
    {GITHUB_REF: `refs/heads/studio-runtime-${WORKFLOW}/extra`},
    {OPEN_GEO_DATA_API_CLUSTER_ARN: environment.OPEN_GEO_DATA_API_CLUSTER_ARN.replace("111111111111", "222222222222")},
    {OPEN_GEO_APPLICATION_BUCKET: "source.opengeo.tools"}
  ]) {
    await assert.rejects(runGitHubBuild({environment: {...environment, ...change},
      dependenciesFactory() {initialized++;throw Error("No AWS or dependency initialization before admission");}}),
      /github_execution_identity_invalid|independent_deployment_environment_invalid/);
  }
  assert.equal(initialized, 0);
});

test("Legacy source mode still selects the mirrored source gate and requires its token", async () => {
  const environment = executionEnvironment(), runner = {async run() {throw Error("Unused compiler");}};
  await assert.rejects(runGitHubBuild({environment, dependenciesFactory: () => ({runner})}), /github_source_configuration_invalid/);
  environment.OPEN_GEO_GITHUB_READ_TOKEN = "legacy-read-token";
  const {summary} = await runGitHubBuild({environment, dependenciesFactory: (received, capabilities) => {
    assert.equal(received, environment);
    assert.deepEqual(capabilities, {enablePublicFileStaging: false});
    return {runner};
  },
    async processBuild(body, dependencies) {
      assert.equal(JSON.parse(body).build_job_id, BUILD);
      assert(dependencies.runner instanceof GitHubPinnedSourceRunner);
      assert.equal(dependencies.runner.runner, runner);
      return {buildJobId: BUILD, status: "already_succeeded"};
    }
  });
  assert.equal(summary.sourceMode, "github");
  assert.equal(summary.sourceCommit, COMMIT);
});

test("Runtime CLI rejects invalid context without logging supplied private text", async () => {
  const attemptedPrivateText = "PRIVATE_SOURCE_SNIPPET\nhttps://private.example/draft";
  let stdout = "", stderr = "";
  const exitCode = await githubBuildMain({environment: {...executionEnvironment(), OPEN_GEO_BUILD_SOURCE_MODE: "opengeo",
    OPEN_GEO_GITHUB_SOURCE_COMMIT: attemptedPrivateText}}, {
    stdout: {write(value) {stdout += value;}}, stderr: {write(value) {stderr += value;}}
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.deepEqual(JSON.parse(stderr), {status: "failed", code: "github_execution_identity_invalid"});
  assert.equal(stderr.includes("PRIVATE_SOURCE_SNIPPET"), false);
});

test("GitHub revision gate verifies source identity and bytes before invoking compiler", async () => {
  const manifest = Buffer.from(JSON.stringify({schema: "opengeo.github-source.1.0.0",
    source_project_id: SOURCE, revision_id: REVISION,
    files: [{path: file.path, size_bytes: bytes.length, sha256: sha256(bytes)}]}));
  let compiled = 0;
  let privateRepository = true;
  let truncated = false;
  let contentSha = blobSha(bytes);
  const options = {invocation: {request: {sourceProjectId: SOURCE, sourceRevisionId: REVISION},
    files: [file]}, inputs: new Map([[file.path, bytes]])};
  const runner = new GitHubPinnedSourceRunner({
    repository: "owner/private", repositoryId: 123, commit: COMMIT, token: "not-for-the-compiler",
    runner: {async run(received) { assert.equal(received, options); compiled++; return {ok: true}; }},
    async fetchImplementation(url, request) {
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.Authorization, "Bearer not-for-the-compiler");
      const root = "https://api.github.com/repos/owner/private";
      const values = {
        [root]: {id: 123, full_name: "owner/private", private: privateRepository, archived: false, disabled: false},
        [`${root}/git/commits/${COMMIT}`]: {sha: COMMIT, tree: {sha: TREE}},
        [`${root}/git/trees/${TREE}?recursive=1`]: {sha: TREE, truncated, tree: [
          {path: file.path, mode: "100644", type: "blob", sha: contentSha},
          {path: ".opengeo/source-revision.json", mode: "100644", type: "blob", sha: blobSha(manifest)}
        ]},
        [`${root}/git/blobs/${blobSha(manifest)}`]: {encoding: "base64", content: manifest.toString("base64")}
      };
      assert.ok(url in values);
      return new Response(JSON.stringify(values[url]));
    }
  });
  assert.deepEqual(await runner.run(options), {ok: true});
  privateRepository = false;
  await assert.rejects(runner.run(options), /github_source_repository_changed/);
  privateRepository = true;
  truncated = true;
  await assert.rejects(runner.run(options), /github_source_tree_invalid/);
  truncated = false;
  contentSha = "f".repeat(40);
  await assert.rejects(runner.run(options), /github_source_bytes_mismatch/);
  assert.equal(compiled, 1);
});
