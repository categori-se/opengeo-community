import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {FrameworkBuildHistory} from "../src/components/FrameworkBuildHistory.js";
import {FrameworkWorkflowStatus} from "../src/components/FrameworkWorkflowStatus.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const job = {id: "build-one", sourceProjectId: "source-one", sourceRevisionNumber: 2, purpose: "preview", state: "pending", attemptCount: 0, updatedAt: "2026-09-10T00:00:00Z", executionAvailable: true};
async function withDocument(run) {
  const dom = new JSDOM("<!doctype html><body></body>"); const before = globalThis.document;
  globalThis.document = dom.window.document;
  try {await run();} finally {globalThis.document = before; dom.window.close();}
}
function button(root, name) {return [...root.querySelectorAll("button")].find(node => node.textContent === name);}

test("completed GitHub runs do not claim the article is unpublished or offer resume", async () => withDocument(async () => {
  const root = FrameworkBuildHistory({adapter: {
    listObservableBuildJobs: async () => [{...job, state: "succeeded"}],
    listObservableGitHubDispatches: async () => [{buildJobId: job.id, stage: "completed", runStatus: "completed"}],
    dispatchObservableBuildJob: async () => assert.fail("Completed builds must not resume"),
    createObservablePreviewCapability: async () => assert.fail("Preview requires a click")
  }, projectId: "project-one", sourceProjectId: "source-one", canManage: true});
  await tick();
  assert.doesNotMatch(root.textContent, /Nothing has been published/);
  assert.match(root.textContent, /Publication status is shown separately/);
  assert.equal(button(root, "Resume queued build").hidden, true);
  assert.equal(button(root, "Open private preview").hidden, false);
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const style = document.createElement("style");
  style.textContent = css.match(/\.platform-button \{[^}]+\}/)[0] +
    css.match(/\.framework-build-history \[hidden\] \{[^}]+\}/)[0];
  document.head.append(style); document.body.append(root);
  const computed = document.defaultView.getComputedStyle;
  assert.equal(computed(button(root, "Resume queued build")).display, "none");
  assert.equal(computed(button(root, "Open private preview")).display, "inline-flex");
}));

test("GitHub startup failures survive reopening and refresh without a replacement build", async () => withDocument(async () => {
  let stage = "dispatched";
  const adapter = {
    listObservableBuildJobs: async () => [job], getObservableBuildJob: async () => job,
    dispatchObservableBuildJob: async () => assert.fail("Never redispatch a registered run"),
    listObservableGitHubDispatches: async () => [{buildJobId: job.id, stage,
      runStatus: stage === "failed" ? "completed" : "queued",
      errorCode: stage === "failed" ? "github_run_startup_failure" : null,
      runUrl: "https://github.com/owner/private/actions/runs/456"}]
  };
  const root = FrameworkBuildHistory({adapter, projectId: "project-one", sourceProjectId: "source-one", canManage: true});
  await tick();
  assert.match(root.textContent, /queued/);
  assert.equal(button(root, "Resume queued build").hidden, true);
  stage = "failed";
  button(root, "Refresh this build").click(); await tick();
  assert.match(root.textContent, /github_run_startup_failure/);
  assert.equal(root.querySelector("a").href, "https://github.com/owner/private/actions/runs/456");
  const reopened = FrameworkBuildHistory({adapter, projectId: "project-one", sourceProjectId: "source-one", canManage: true});
  await tick();
  assert.match(reopened.textContent, /github_run_startup_failure/);
  assert.equal(button(reopened, "Resume queued build").hidden, true);
}));

test("reload reconstructs saved jobs; resuming dispatches the same ID without creating a build", async () => withDocument(async () => {
  const calls = [];
  const adapter = {listObservableBuildJobs: async (...args) => {calls.push(["list", ...args]); return [job];},
    dispatchObservableBuildJob: async (...args) => {calls.push(["dispatch", ...args]); return job;},
    getObservableBuildJob: async () => job,
    createObservableBuildJob: async () => assert.fail("History must never create work")};
  const options = {adapter, projectId: "project-one", sourceProjectId: "source-one", canManage: true};
  const root = FrameworkBuildHistory(options); await tick();
  assert.match(root.textContent, /Revision 2/);
  button(root, "Resume queued build").click(); await tick();
  assert.deepEqual(calls.find(call => call[0] === "dispatch"), ["dispatch", "project-one", "build-one"]);
  const reopened = FrameworkBuildHistory(options); await tick();
  assert.match(reopened.textContent, /build-one/);
  assert.equal(calls.filter(call => call[0] === "dispatch").length, 1);
}));

test("retained logs survive reopening as text and are hidden from viewers", async () => withDocument(async () => {
  const adapter = {
    listObservableBuildJobs: async () => [job],
    listObservableGitHubDispatches: async () => [{buildJobId: job.id, stage: "failed", retainedLogs: {
      state: "retained", text: "<script>unsafe()</script>\nCompile failed", truncated: true,
      capturedAt: "2026-09-10T00:00:00Z", checksumSha256: "a".repeat(64)
    }}]
  };
  for (const canManage of [true, true, false]) {
    const root = FrameworkBuildHistory({adapter, projectId: "project-one", sourceProjectId: "source-one", canManage});
    await tick();
    assert.equal(root.querySelectorAll("script").length, 0);
    assert.equal(root.querySelectorAll("pre").length, canManage ? 1 : 0);
    if (canManage) {
      assert.match(root.querySelector("pre").textContent, /<script>/);
      assert.match(root.textContent, /truncated/);
    }
  }
}));

test("history failure removes stale actions and foreign-source results are rejected", async () => withDocument(async () => {
  let response = [job];
  const root = FrameworkBuildHistory({adapter: {listObservableBuildJobs: async () => response, dispatchObservableBuildJob: async () => job}, projectId: "project-one", sourceProjectId: "source-one", canManage: true});
  await tick(); assert.ok(button(root, "Resume queued build"));
  response = [{...job, sourceProjectId: "other"}];
  button(root, "Reload build history").click(); await tick();
  assert.match(root.textContent, /could not be read/);
  assert.equal(button(root, "Resume queued build"), undefined);
}));

test("viewers cannot dispatch and unavailable execution is never described as running", async () => withDocument(async () => {
  for (const canManage of [true, false]) {
    const root = FrameworkBuildHistory({adapter: {listObservableBuildJobs: async () => [{...job, executionAvailable: false}], dispatchObservableBuildJob: async () => assert.fail("No executor")}, projectId: "project-one", sourceProjectId: "source-one", canManage});
    await tick();
    assert.equal(button(root, "Resume queued build").hidden, true);
    assert.match(root.textContent, /will not run until an executor is connected/);
  }
}));

test("failed status observation does not launch a replacement or retain dispatch action", async () => withDocument(async () => {
  const root = FrameworkBuildHistory({adapter: {listObservableBuildJobs: async () => [job], getObservableBuildJob: async () => {throw new Error("offline");}, dispatchObservableBuildJob: async () => job}, projectId: "project-one", sourceProjectId: "source-one", canManage: true});
  await tick(); button(root, "Refresh this build").click(); await tick();
  assert.match(root.textContent, /server state is unknown/);
  assert.equal(button(root, "Resume queued build").hidden, true);
}));

test("a viewer cannot invoke a configured dispatcher through a hidden control", async () => withDocument(async () => {
  const root = FrameworkBuildHistory({adapter: {listObservableBuildJobs: async () => [job], dispatchObservableBuildJob: async () => assert.fail("Viewer must not dispatch")}, projectId: "project-one", sourceProjectId: "source-one"});
  await tick();
  const control = button(root, "Resume queued build");
  assert.equal(control.hidden, true);
  control.click(); await tick();
}));

test("workflow availability distinguishes configuration from health and public activation", async () => withDocument(async () => {
  let fail = false;
  const root = FrameworkWorkflowStatus({adapter: {getObservableWorkflow: async () => {
    if (fail) throw new Error("offline");
    return {projectId: "project-one", configurationOnly: true, sourceStorageConfigured: true, buildDispatchConfigured: false, privatePreviewConfigured: false, publicPromotionAvailable: false};
  }}, projectId: "project-one"});
  await tick();
  assert.match(root.textContent, /Private source storage: configured/);
  assert.match(root.textContent, /Build queue: not configured/);
  assert.match(root.textContent, /not a runtime health check/);
  assert.match(root.textContent, /Framework public activation: not connected/);
  fail = true; button(root, "Check workflow configuration").click(); await tick();
  assert.equal(root.querySelectorAll("li").length, 0);
  assert.match(root.textContent, /Do not assume/);
}));

test("completed-build review exposes exact pins and routes without inventing public links", async () => withDocument(async () => {
  const complete = {...job, state: "succeeded", sourceRevisionId: "revision-two", requestChecksumSha256: "b".repeat(64),
    request: {sourceManifestChecksumSha256: "a".repeat(64), compilerImageDigest: "sha256:" + "c".repeat(64)},
    resultChecksumSha256: "d".repeat(64), result: {outputTreeChecksumSha256: "e".repeat(64),
      outputManifest: {files: [{path: "dist/index.html", sizeBytes: 1234}]}, routeManifest: [{path: "/", file: "dist/index.html"}]}};
  const root = FrameworkBuildHistory({adapter: {listObservableBuildJobs: async () => [complete]}, projectId: "project-one", sourceProjectId: "source-one"});
  await tick();
  assert.match(root.textContent, /revision-two/);
  assert.match(root.textContent, /1 retained output files · 1234 bytes/);
  assert.match(root.textContent, /not live public URLs/);
  assert.equal(root.querySelector("tbody td:last-child").textContent, "dist/index.html");
  assert.equal(root.querySelectorAll("a").length, 0);
  assert.match(root.textContent, new RegExp("e".repeat(64)));
}));
