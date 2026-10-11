import assert from "node:assert/strict";
import {test} from "node:test";
import {githubBuildSummary} from "../src/github-runner.mjs";

test("GitHub summary records aggregate incremental evidence, never cache or result contents", () => {
  const identity = {runId: "123", commit: "a".repeat(40), workflowSha: "b".repeat(40)};
  const incremental = {cacheRead: "hit", cacheWrite: "failed",
    counts: {restored: true, renderedPages: 1, reusedPages: 2, sourcePath: "SECRET"}, body: "SECRET"};
  const result = {buildJobId: "test", status: "succeeded", incremental, result: {signedUrl: "SECRET"}};
  const summary = githubBuildSummary(result, identity);
  assert.deepEqual(summary.incremental, {cacheRead: "hit", cacheWrite: "failed",
    counts: {restored: true, renderedPages: 1, reusedPages: 2}});
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  for (const counts of [null, {restored: false, renderedPages: 1, reusedPages: 2},
    {restored: true, renderedPages: -1, reusedPages: 2},
    {restored: true, renderedPages: 10_000, reusedPages: 1}]) {
    assert.equal(githubBuildSummary({...result, incremental: {...incremental, counts}}, identity).incremental.counts, null);
  }
  for (const status of ["failed", "already_succeeded", "busy"]) {
    assert.equal(Object.hasOwn(githubBuildSummary({...result, status}, identity), "incremental"), false);
  }
  assert.equal(Object.hasOwn(githubBuildSummary({...result, incremental: {...incremental, cacheRead: "SECRET"}}, identity), "incremental"), false);
  const failed = githubBuildSummary({...result, status: "failed", errorCode: "SECRET source bytes\nhttps://private.example/source"}, identity);
  assert.equal(failed.errorCode, "github_build_unavailable");
  assert.equal(JSON.stringify(failed).includes("SECRET"), false);
  assert.equal(githubBuildSummary({...result, status: "failed", errorCode: "compiler_image_mismatch"}, identity).errorCode, "compiler_image_mismatch");
});
