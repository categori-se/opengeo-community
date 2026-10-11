import assert from "node:assert/strict";
import {beforeEach, afterEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectVersionExport, savedProjectVersionFile} from "../src/components/ProjectVersionExport.js";

const compositionId = "60000000-0000-4000-8000-000000000001";
const summary = version => ({version, definitionBytes: 40, createdBy: "20000000-0000-4000-8000-000000000001",
  createdAt: "2026-10-05T12:00:00Z", changeMessage: `Saved ${version}`});
const definition = {schemaVersion: "opengeo.map-definition.1.0.0", extensions: {inert: {text: "é🌏"}}};
let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll("button")].find(node => node.textContent === label);

it("does no startup work and reads only one selected immutable definition after metadata review", async () => {
  const calls = [];
  const adapter = {listCompositionVersions: async (...args) => {calls.push(["list", ...args]); return [summary(2), summary(1)];},
    getCompositionVersion: async (...args) => {calls.push(["read", ...args]); return {...summary(1), definition};}};
  const root = ProjectVersionExport({adapter, compositionId, currentVersion: 2});
  document.body.append(root);
  assert.deepEqual(calls, []);
  await assert.rejects(root.readSelected(), /Find and choose/);
  button(root, "Find saved versions").click();
  await tick();
  assert.deepEqual(calls, [["list", compositionId, {limit: 25, beforeVersion: null}]]);
  const choices = root.querySelector("select");
  assert.equal(choices.disabled, false);
  choices.value = "1";
  choices.dispatchEvent(new dom.window.Event("change"));
  const retained = await root.readSelected();
  assert.deepEqual(retained.definition, definition);
  assert.deepEqual(calls[1], ["read", compositionId, 1]);
  const packaged = JSON.parse(savedProjectVersionFile(compositionId, retained));
  assert.deepEqual(packaged.definition, definition);
  assert.equal(packaged.projectId, compositionId);
  assert.equal(packaged.version, 1);
  assert.deepEqual(packaged.history, {createdAt: retained.createdAt, createdBy: retained.createdBy, changeMessage: retained.changeMessage});
  assert.equal(packaged.dependenciesBundled, false);
  assert.equal(packaged.accessIncluded, false);
});

it("pages metadata with the exact older cursor and keeps the selected version", async () => {
  const cursors = [];
  const root = ProjectVersionExport({compositionId, currentVersion: 30, adapter: {
    listCompositionVersions: async (id, options) => {cursors.push(options.beforeVersion);
      return options.beforeVersion === null ? Array.from({length: 25}, (_, index) => summary(30 - index)) : [summary(5)];}
  }});
  button(root, "Find saved versions").click(); await tick();
  root.querySelector("select").value = "10";
  assert.equal(button(root, "Older versions").hidden, false);
  button(root, "Older versions").click(); await tick();
  assert.deepEqual(cursors, [null, 6]);
  assert.equal(root.querySelector("select").value, "10");
  assert.equal(button(root, "Older versions").hidden, true);
  assert.equal(root.querySelectorAll("option").length, 27);
});

it("refuses changed scope or substituted saved metadata without producing a file", async () => {
  let current = true, body = {...summary(1), definition};
  const root = ProjectVersionExport({compositionId, currentVersion: 1, isCurrent: () => current, adapter: {
    listCompositionVersions: async () => [summary(1)], getCompositionVersion: async () => body
  }});
  button(root, "Find saved versions").click(); await tick();
  root.querySelector("select").value = "1";
  current = false;
  await assert.rejects(root.readSelected(), /Project changed/);
  current = true;
  for (const change of [{version: 2}, {definitionBytes: 41}, {createdAt: "2026-10-04T12:00:00Z"}, {changeMessage: "Different"}]) {
    body = {...summary(1), definition, ...change};
    await assert.rejects(root.readSelected(), /could not be verified/);
  }
});

it("clears failed metadata and keeps current access denial visible and retryable", async () => {
  let failed = true;
  const root = ProjectVersionExport({compositionId, currentVersion: 1, adapter: {
    listCompositionVersions: async () => {if (failed) throw Object.assign(Error("private details"), {status: 404}); return [summary(1)];},
    getCompositionVersion: async () => {throw Object.assign(Error("revoked"), {status: 404});}
  }});
  button(root, "Find saved versions").click(); await tick();
  assert.match(root.textContent, /Check Project access/);
  assert.doesNotMatch(root.textContent, /private details/);
  assert.equal(root.querySelector("select").disabled, true);
  failed = false;
  button(root, "Find saved versions").click(); await tick();
  root.querySelector("select").value = "1";
  await assert.rejects(root.readSelected(), error => error.status === 404);
  assert.equal(root.querySelector("select").disabled, false);
});
