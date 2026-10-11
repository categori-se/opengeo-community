import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {FrameworkGitHubConnection} from "../src/components/FrameworkGitHubConnection.js";
import {parseObservableGitHubStatus} from "../src/lib/apiClient.js";

test("connection is selected explicitly and recovered without exporting or building", async () => {
  const dom = new JSDOM("<!doctype html>"); const before = globalThis.document;
  globalThis.document = dom.window.document;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  let selected = null; let writes = 0; let exports = 0; let builds = 0;
  const connection = {id: "connection", repository: "owner/private", enabled: true};
  const value = () => ({sourceProjectId: "source", connection: selected, availableConnections: [connection], canConnect: !selected, revisions: []});
  const adapter = {getObservableGitHubStatus: async () => value(),
    connectObservableGitHub: async (project, source, id) => {
      assert.deepEqual([project, source, id], ["project", "source", "connection"]);
      writes++; selected = connection; return value();
    },
    syncObservableGitHubRevision: async () => {exports++; throw Error("unexpected export");},
    createObservableBuildJob: async () => {builds++; throw Error("unexpected build");}};
  try {
    const root = FrameworkGitHubConnection({adapter, projectId: "project", sourceProjectId: "source", canManage: true});
    await tick(); assert.equal(writes, 0);
    assert.match(root.textContent, /Optional GitHub source export/);
    assert.match(root.textContent, /Private drafts are saved in OpenGeo/);
    assert.match(root.textContent, /trusted build service without a GitHub source link/);
    assert.match(root.textContent, /Connecting only saves this project's repository selection/);
    assert.match(root.textContent, /Future draft saves do not export source/);
    [...root.querySelectorAll("button")].find(b => b.textContent === "Connect this Framework project").click();
    await tick(); assert.equal(writes, 1);
    assert.match(root.textContent, /No GitHub revision receipt yet/);
    const reopened = FrameworkGitHubConnection({adapter, projectId: "project", sourceProjectId: "source", canManage: true});
    await tick(); assert.match(reopened.textContent, /owner\/private/); assert.equal(writes, 1);
    assert.match(reopened.textContent, /Saving or autosaving a draft never exports it/);
    assert.equal(exports, 0); assert.equal(builds, 0);
  } finally {globalThis.document = before; dom.window.close();}
});

test("GitHub receipt parser refuses a foreign project's bookmark", () => {
  const source = "11111111-1111-4111-8111-111111111111";
  const revision = "22222222-2222-4222-8222-222222222222";
  const connection = {id: source, repository: "owner/private", repository_id: 123,
    enabled: true, verified_at: "2026-09-10T00:00:00Z"};
  const value = {source_project_id: source, connection, available_connections: [], can_connect: false,
    revisions: [{source_revision_id: revision, revision_number: 1, commit_sha: "a".repeat(40),
      tree_sha: "b".repeat(40), manifest_sha256: "c".repeat(64),
      git_ref: `heads/studio/sources/${source}/revisions/${revision}`, created_at: connection.verified_at}]};
  assert.equal(parseObservableGitHubStatus(value, source).revisions.length, 1);
  value.revisions[0].git_ref = `heads/studio/sources/${revision}/revisions/${revision}`;
  assert.throws(() => parseObservableGitHubStatus(value, source));
});

test("only explicit Sync exports the selected saved revision; newer drafts and refresh start no exports", async () => {
  const dom = new JSDOM("<!doctype html>"); const before = globalThis.document;
  globalThis.document = dom.window.document;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const exports = [];
  const value = {sourceProjectId: "source", connection: {repository: "owner/private", enabled: true},
    revisions: [], currentRevisionId: "saved-revision", canSync: true, syncConfigured: true,
    syncs: [{sourceRevisionId: "saved-revision", revisionNumber: 1, stage: "pending", updatedAt: "now"}]};
  const adapter = {getObservableGitHubStatus: async () => value,
    syncObservableGitHubRevision: async (project, source, revision) => {
      assert.deepEqual([project, source], ["project", "source"]);
      exports.push(revision);
      value.revisions.push({sourceRevisionId: revision, revisionNumber: exports.length, commitSha: "a".repeat(40)});
      return value;
    }};
  try {
    const root = FrameworkGitHubConnection({adapter, projectId: "project", sourceProjectId: "source", canManage: true});
    await tick(); assert.deepEqual(exports, []); assert.match(root.textContent, /GitHub sync pending/);
    assert.match(root.textContent, /Sync copies only the selected saved revision/);
    assert.match(root.textContent, /Connecting and later draft saves do not export source/);
    [...root.querySelectorAll("button")].find(button => button.textContent === "Sync saved revision to GitHub").click();
    await tick(); assert.deepEqual(exports, ["saved-revision"]);
    assert.equal(root.querySelector('a[href="https://github.com/owner/private/commit/' + "a".repeat(40) + '"]').textContent, "a".repeat(12));
    value.currentRevisionId = "newer-saved-revision";
    [...root.querySelectorAll("button")].find(button => button.textContent === "Refresh GitHub connection").click();
    await tick(); assert.deepEqual(exports, ["saved-revision"]);
    [...root.querySelectorAll("button")].find(button => button.textContent === "Sync saved revision to GitHub").click();
    await tick(); assert.deepEqual(exports, ["saved-revision", "newer-saved-revision"]);
  } finally {globalThis.document = before; dom.window.close();}
});
