import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {processBuildCommand, productionDependencies} from "../src/runtime.mjs";
import {GitHubPinnedSourceRunner, validateGitHubExecution, githubBuildSummary} from "../src/github-runner.mjs";

export async function runGitHubBuild({environment = process.env,
  dependenciesFactory = productionDependencies, processBuild = processBuildCommand} = {}) {
  const identity = validateGitHubExecution(environment);
  const dependencies = dependenciesFactory(environment, {
    enablePublicFileStaging: identity.sourceMode === "opengeo"
  });
  if (identity.sourceMode === "github") {
    dependencies.runner = new GitHubPinnedSourceRunner({
      ...identity, runner: dependencies.runner, token: environment.OPEN_GEO_GITHUB_READ_TOKEN
    });
  }
  // Canonical-source builds use the existing S3 coordinator and bare Podman
  // runner. The runtime repository supplies no publication source bytes.
  const result = await processBuild(JSON.stringify({
    schema: "opengeo.observable-build.command.1.0.0",
    build_job_id: identity.buildJobId
  }), dependencies);
  return {result, summary: githubBuildSummary(result, identity)};
}

export async function githubBuildMain(options = {}, {stdout = process.stdout, stderr = process.stderr} = {}) {
 try {
  const {result, summary} = await runGitHubBuild(options);
  // Studio's existing database job, not Actions log output, owns the full build
  // result and exact S3 versions. No signed URLs, source bytes or credentials log.
  stdout.write(`${JSON.stringify(summary)}\n`);
  return ["succeeded", "already_succeeded"].includes(result.status) ? 0 : 1;
 } catch (error) {
  stderr.write(`${JSON.stringify({status: "failed", code:
    /^[a-z0-9_]{1,100}$/.test(error?.code ?? "") ? error.code : "github_build_unavailable"
  })}\n`);
  return 1;
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await githubBuildMain();
}
