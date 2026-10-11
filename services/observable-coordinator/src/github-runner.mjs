import {createHash} from "node:crypto";
import {CoordinatorContractError, sha256} from "./contracts.mjs";
import {boundedResponseBytes} from "./aws-sigv4.mjs";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE = /^[a-z0-9_]{1,100}$/;
const blobSha = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export function githubBuildSummary(result, identity) {
  const summary = {buildJobId: result.buildJobId, status: result.status, runId: identity.runId,
    sourceMode: identity.sourceMode ?? "github", sourceCommit: identity.commit ?? null,
    workflowSha: identity.workflowSha,
    ...(result.errorCode ? {errorCode: ERROR_CODE.test(result.errorCode)
      ? result.errorCode : "github_build_unavailable"} : {})};
  const cache = result.incremental;
  if (result.status === "succeeded" && cache &&
      ["hit", "miss", "invalid", "unavailable"].includes(cache.cacheRead) &&
      ["written", "unchanged", "superseded", "not_observed", "failed", "unavailable"].includes(cache.cacheWrite)) {
    const counts = cache.counts;
    summary.incremental = {cacheRead: cache.cacheRead, cacheWrite: cache.cacheWrite, counts: null};
    if (counts && typeof counts.restored === "boolean" &&
        [counts.renderedPages, counts.reusedPages].every(n => Number.isSafeInteger(n) && n >= 0) &&
        counts.renderedPages + counts.reusedPages <= 10_000 && (counts.restored || counts.reusedPages === 0)) {
      summary.incremental.counts = {restored: counts.restored, renderedPages: counts.renderedPages, reusedPages: counts.reusedPages};
    }
  }
  return summary;
}

export function validateGitHubExecution(environment) {
  // Old dispatched jobs omit this field and retain their mirrored-source gate.
  // New canonical-source jobs must explicitly choose opengeo.
  const sourceMode = environment.OPEN_GEO_BUILD_SOURCE_MODE === undefined
    ? "github" : environment.OPEN_GEO_BUILD_SOURCE_MODE;
  const sourceCommit = environment.OPEN_GEO_GITHUB_SOURCE_COMMIT;
  const repositoryId = Number(environment.GITHUB_REPOSITORY_ID);
  if (
    !["github", "opengeo"].includes(sourceMode) ||
    !UUID.test(environment.OPEN_GEO_BUILD_JOB_ID ?? "") ||
    environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !SHA.test(environment.OPEN_GEO_EXPECTED_WORKFLOW_SHA ?? "") ||
    environment.GITHUB_SHA !== environment.OPEN_GEO_EXPECTED_WORKFLOW_SHA ||
    environment.GITHUB_WORKFLOW_SHA !== environment.OPEN_GEO_EXPECTED_WORKFLOW_SHA ||
    environment.GITHUB_REF !== `refs/heads/studio-runtime-${environment.OPEN_GEO_EXPECTED_WORKFLOW_SHA}` ||
    (sourceMode === "github" ? !SHA.test(sourceCommit ?? "")
      : sourceCommit !== undefined && sourceCommit !== "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(environment.GITHUB_REPOSITORY ?? "") ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_REPOSITORY_ID ?? "") ||
    !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? "")
  ) throw new CoordinatorContractError("github_execution_identity_invalid");
  return {
    repository: environment.GITHUB_REPOSITORY,
    repositoryId,
    buildJobId: environment.OPEN_GEO_BUILD_JOB_ID,
    sourceMode,
    commit: sourceMode === "github" ? sourceCommit : null,
    runId: environment.GITHUB_RUN_ID,
    workflowSha: environment.OPEN_GEO_EXPECTED_WORKFLOW_SHA
  };
}

// The host owns the read token; the existing no-network Podman runner receives
// only the verified source bytes and compiler contract, never this token.
export class GitHubPinnedSourceRunner {
  constructor({runner, repository, repositoryId, commit, token, fetchImplementation = fetch}) {
    if (!SHA.test(commit ?? "") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
        !Number.isSafeInteger(repositoryId) || repositoryId < 1 || typeof token !== "string" || !token) {
      throw new CoordinatorContractError("github_source_configuration_invalid");
    }
    Object.assign(this, {runner, repository, repositoryId, commit, token, fetch: fetchImplementation});
  }

  async read(path) {
    let response;
    try {
      response = await this.fetch(`https://api.github.com/repos/${this.repository}${path}`, {
        headers: {Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"},
        redirect: "error", signal: AbortSignal.timeout(15_000)
      });
    } catch { throw new CoordinatorContractError("github_source_unavailable", {retryable: true}); }
    if (!response.ok) throw new CoordinatorContractError("github_source_unavailable", {retryable: true});
    try {
      return JSON.parse(await boundedResponseBytes(response, 2 * 1024 * 1024));
    } catch { throw new CoordinatorContractError("github_source_response_invalid"); }
  }

  async run(options) {
    const {invocation, inputs} = options;
    const repo = await this.read("");
    if (repo.id !== this.repositoryId || repo.private !== true || repo.archived !== false ||
        repo.disabled !== false || repo.full_name?.toLowerCase() !== this.repository.toLowerCase()) {
      throw new CoordinatorContractError("github_source_repository_changed");
    }
    const commit = await this.read(`/git/commits/${this.commit}`);
    if (commit.sha !== this.commit || !SHA.test(commit.tree?.sha ?? "")) {
      throw new CoordinatorContractError("github_source_commit_invalid");
    }
    const tree = await this.read(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new CoordinatorContractError("github_source_tree_invalid");
    }
    const blobs = new Map();
    for (const item of tree.tree) {
      if (item.type === "tree" && item.mode === "040000") continue;
      if (item.type !== "blob" || item.mode !== "100644" || !SHA.test(item.sha ?? "") || blobs.has(item.path)) {
        throw new CoordinatorContractError("github_source_tree_invalid");
      }
      blobs.set(item.path, item.sha);
    }
    const manifestSha = blobs.get(".opengeo/source-revision.json");
    if (!SHA.test(manifestSha ?? "") || blobs.size !== invocation.files.length + 1) {
      throw new CoordinatorContractError("github_source_files_mismatch");
    }
    const document = await this.read(`/git/blobs/${manifestSha}`);
    if (document.encoding !== "base64" || typeof document.content !== "string") {
      throw new CoordinatorContractError("github_source_manifest_invalid");
    }
    const bytes = Buffer.from(document.content, "base64");
    if (bytes.length > 65_536 || blobSha(bytes) !== manifestSha) {
      throw new CoordinatorContractError("github_source_manifest_invalid");
    }
    let manifest;
    try { manifest = JSON.parse(bytes); }
    catch { throw new CoordinatorContractError("github_source_manifest_invalid"); }
    if (manifest.schema !== "opengeo.github-source.1.0.0" ||
        manifest.source_project_id !== invocation.request.sourceProjectId ||
        manifest.revision_id !== invocation.request.sourceRevisionId ||
        !Array.isArray(manifest.files) || manifest.files.length !== invocation.files.length) {
      throw new CoordinatorContractError("github_source_revision_mismatch");
    }
    for (const [index, file] of invocation.files.entries()) {
      const body = inputs.get(file.path);
      const record = manifest.files[index];
      if (!Buffer.isBuffer(body) || body.length !== file.sizeBytes || sha256(body) !== file.checksumSha256 ||
          blobs.get(file.path) !== blobSha(body) || record?.path !== file.path ||
          record.size_bytes !== file.sizeBytes || record.sha256 !== file.checksumSha256) {
        throw new CoordinatorContractError("github_source_bytes_mismatch");
      }
    }
    return this.runner.run(options);
  }
}
