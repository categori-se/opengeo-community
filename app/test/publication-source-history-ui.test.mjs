import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {PublicationSourceHistory} from "../src/components/PublicationSourceHistory.js";

const projectId = "60000000-0000-4000-8000-000000000001";
const sourceProject = {id: "70000000-0000-4000-8000-000000000001", title: "Survey", routeNamespace: "survey",
  currentRevisionNumber: 0, currentRevisionId: null};
const checksum = "a".repeat(64);
const restorePlan = {revisionCount: 2, totalUploadBytes: 6, maximumUploadRequests: 2, maximumCommitRequests: 2};
const archive = {checksumSha256: checksum, revisions: [{revisionNumber: 1}, {revisionNumber: 2}]};
const receipt = () => ({schemaVersion: "opengeo.source-history-restore.1.0.0", archiveChecksumSha256: checksum,
  sourceProjectId: sourceProject.id, baseRevision: 0, completed: [], pending: null});
const storageKey = `opengeo:source-history-restore:${projectId}:${sourceProject.id}`;
let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools"});
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll("button")].find(item => item.textContent === label);
function mount(options = {}) {
  const root = PublicationSourceHistory({adapter: {}, projectId, sourceProject, ...options});
  document.body.append(root); return root;
}
async function importZip(root) {
  const input = root.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", {configurable: true, value: [new Blob(["history ZIP"])]});
  input.dispatchEvent(new dom.window.Event("change"));
  await tick();
}
function restoreEngine(extra = {}) {
  return {readSourceHistoryBackup: async () => archive, planSourceHistoryRestore: () => restorePlan, ...extra};
}

it("does no startup requests and reviews finite metadata before any saved-file download", async t => {
  const calls = [], plan = {revisionCount: 2, uniqueFiles: [{}, {}], totalBytes: 6, downloadRequests: 2};
  const revisions = [{revisionNumber: 2}, {revisionNumber: 1}];
  t.mock.method(dom.window.HTMLAnchorElement.prototype, "click", function () {calls.push(["download", this.download]);});
  const root = mount({adapter: {listObservableSourceRevisions: async (...args) => {calls.push(["list", ...args]); return revisions;}},
    engine: {planSourceHistoryBackup: args => {calls.push(["plan", args]); return plan;},
      createSourceHistoryBackup: async args => {calls.push(["bytes", args]); return {blob: new Blob(["backup"])};}}});
  assert.deepEqual(calls, []);
  assert.equal(button(root, "Download history ZIP").disabled, true);
  button(root, "Load version history").click(); await tick();
  assert.deepEqual(calls[0], ["list", projectId, sourceProject.id]);
  assert.deepEqual(calls[1], ["plan", {sourceProject, revisions}]);
  assert.equal(calls.length, 2);
  assert.deepEqual([...root.querySelector('[aria-label="Saved draft versions"]').children].map(item => item.textContent),
    ['Version 2', 'Version 1']);
  assert.match(root.textContent, /Saved drafts stay separate from the public version/);
  assert.match(root.textContent, /2 revisions · 2 distinct files · 6 bytes · 2 requests/);
  button(root, "Download history ZIP").click(); await tick();
  assert.equal(calls[2][0], "bytes");
  assert.equal(calls[2][1].plan, plan);
  assert.equal(calls[2][1].isCurrent(), true);
  assert.deepEqual(calls[3], ["download", "survey-source-history.zip"]);
  assert.match(root.textContent, /working draft is unchanged/);
});

it("reviews a ZIP locally, persists Start without a save, and advances only one explicit revision per click", async () => {
  const calls = []; let refreshed = 0;
  const root = mount({onRestored: async () => {++refreshed;}, engine: restoreEngine({
    planSourceHistoryRestore: args => {calls.push(["plan", args]); return restorePlan;},
    restoreSourceHistoryStep: async options => {
      calls.push(["step", options.checkpoint.completed.length]);
      assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)).completed.length,
        options.checkpoint.completed.length);
      const updated = {...options.checkpoint, completed: [...options.checkpoint.completed, {id: `saved-${calls.length}`}], pending: null};
      await options.saveCheckpoint(updated); return updated;
    }
  })});
  await importZip(root);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].checkpoint, null);
  assert.equal(dom.window.localStorage.getItem(storageKey), null);
  assert.match(root.textContent, /at most 2 upload and 2 save requests/);
  button(root, "Start history restore").click(); await tick();
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(storageKey)), receipt());
  assert.equal(calls.length, 1);
  button(root, "Restore next saved revision").click(); await tick();
  assert.deepEqual(calls.at(-1), ["step", 0]);
  assert.equal(refreshed, 0);
  assert.match(root.textContent, /1 of 2 revisions restored/);
  button(root, "Restore next saved revision").click(); await tick();
  assert.deepEqual(calls.at(-1), ["step", 1]);
  assert.equal(refreshed, 1);
  assert.equal(button(root, "Restore next saved revision").disabled, true);
  assert.match(root.textContent, /2 saved revisions restored/);
});

it("retains an ambiguous save and permits only exact-result reconciliation before the next revision", async () => {
  let steps = 0, checks = 0;
  const root = mount({engine: restoreEngine({restoreSourceHistoryStep: async options => {
    ++steps;
    await options.saveCheckpoint({...options.checkpoint, pending: {revisionNumber: 1, checksumSha256: checksum}});
    throw Error("Uncertain transport result containing private details");
  }, reconcileSourceHistoryStep: async options => {
    ++checks;
    assert.equal(options.checkpoint.pending.revisionNumber, 1);
    const updated = {...options.checkpoint, completed: [{id: "saved-1"}], pending: null};
    await options.saveCheckpoint(updated); return updated;
  }})});
  await importZip(root);
  button(root, "Start history restore").click(); await tick();
  button(root, "Restore next saved revision").click(); await tick();
  assert.equal(steps, 1);
  assert.equal(button(root, "Restore next saved revision").hidden, true);
  assert.equal(button(root, "Check pending revision").hidden, false);
  assert.match(root.textContent, /Check the pending revision/);
  assert.doesNotMatch(root.textContent, /private details/);
  button(root, "Check pending revision").click(); await tick();
  assert.equal(checks, 1); assert.equal(steps, 1);
  assert.equal(button(root, "Check pending revision").hidden, true);
  assert.equal(button(root, "Restore next saved revision").hidden, false);
  assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)).pending, null);
});

it("refuses any mutation when the durable checkpoint cannot be saved", async t => {
  let steps = 0;
  const root = mount({engine: restoreEngine({restoreSourceHistoryStep: async () => {++steps; assert.fail("Unsafe save");}})});
  await importZip(root);
  t.mock.method(dom.window.Storage.prototype, "setItem", () => {throw Error("Storage denied");});
  button(root, "Start history restore").click(); await tick();
  assert.equal(steps, 0);
  assert.match(root.textContent, /checkpoint could not be saved/);
  assert.equal(button(root, "Restore next saved revision").hidden, true);
  assert.equal(button(root, "Start history restore").disabled, true);
});

it("resumes a matching checkpoint at an existing destination and rejects a different ZIP", async () => {
  const existing = {...receipt(), completed: [{id: "saved-1"}], pending: {revisionNumber: 2}};
  dom.window.localStorage.setItem(storageKey, JSON.stringify(existing));
  const destination = {...sourceProject, currentRevisionNumber: 1, currentRevisionId: "saved-1"};
  let selected = {...archive, checksumSha256: "b".repeat(64)}, planned = 0;
  const root = mount({sourceProject: destination, engine: restoreEngine({
    readSourceHistoryBackup: async () => selected,
    planSourceHistoryRestore: options => {
      ++planned;
      assert.deepEqual(options.destination, destination);
      assert.deepEqual(options.checkpoint, existing);
      return restorePlan;
    }
  })});
  assert.match(root.textContent, /Restore checkpoint found/);
  assert.equal(button(root, "Check pending revision").disabled, true);
  await importZip(root);
  assert.match(root.textContent, /does not match the saved restore checkpoint/);
  assert.equal(planned, 0);
  assert.equal(button(root, "Check pending revision").disabled, true);
  selected = archive;
  await importZip(root);
  assert.equal(planned, 1);
  assert.equal(button(root, "Start history restore").hidden, true);
  assert.equal(button(root, "Check pending revision").disabled, false);
  assert.equal(button(root, "Restore next saved revision").hidden, true);
});

it("drops late results after the source scope changes and shows access failures without exposing server details", async t => {
  let current = true, finish;
  const root = mount({isCurrent: () => current, engine: restoreEngine({
    readSourceHistoryBackup: () => new Promise(resolve => {finish = resolve;})
  })});
  const importing = importZip(root);
  await tick(); current = false; finish(archive); await importing; await tick();
  assert.equal(button(root, "Start history restore").disabled, true);
  const denied = mount({adapter: {listObservableSourceRevisions: async () => {
    throw Object.assign(Error("Secret database details"), {status: 403});
  }}});
  button(denied, "Load version history").click(); await tick();
  assert.match(denied.textContent, /Check source access/);
  assert.doesNotMatch(denied.textContent, /Secret database/);
  assert.equal(button(denied, "Download history ZIP").disabled, true);
});
