import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {DirectoryLoading} from "../src/components/DirectoryLoading.js";

async function withDocument(test) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {await test();} finally {globalThis.document = previous; dom.window.close();}
}

it("shows actual loading stages, elapsed time and ready project data", () => withDocument(async () => {
  let releaseProjects;
  const adapter = {async getSession() {return {selectedOrganizationId: "org", memberships: []};},
    selectOrganization() {}, async getCurrentOrganization() {return {id: "org"};},
    listProjects() {return new Promise(resolve => {releaseProjects = resolve;});}};
  const loading = DirectoryLoading({adapter, timeoutMs: 1000});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(loading.element.querySelector("progress"));
  assert.equal(loading.element.querySelector("progress").hasAttribute("value"), false, "unknown duration is not a fabricated percentage");
  assert.match(loading.element.textContent, /Account access · ready/);
  assert.match(loading.element.textContent, /Account permissions · ready/);
  assert.match(loading.element.textContent, /Data access · loading/);
  assert.match(loading.element.textContent, /Elapsed: 0s/);
  assert.equal(loading.element.querySelector("a").getAttribute("href"), "/");
  releaseProjects([{id: "project"}]);
  const state = await loading.result;
  assert.equal(state.status, "ready");
  assert.equal(state.projects[0].id, "project");
}));

it("bounds a hung request, aborts its signal, and rejects late organization selection", () => withDocument(async () => {
  let signal, resolveSession, selections = 0;
  const adapter = {getSession(options) {signal = options.signal; return new Promise(resolve => {resolveSession = resolve;});},
    selectOrganization() {selections++;}};
  const loading = DirectoryLoading({adapter, timeoutMs: 10, retryDelays: [0]});
  const result = await loading.result;
  assert.equal(result.code, "directory_load_timeout");
  assert.equal(result.retryable, true);
  assert.equal(signal.aborted, true);
  resolveSession({selectedOrganizationId: "old-org", memberships: []});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(selections, 0);
}));

it("does not retry a denied sign-in", () => withDocument(async () => {
  let calls = 0;
  const loading = DirectoryLoading({adapter: {async getSession() {calls++; throw {status: 401};}}, timeoutMs: 1000});
  assert.equal((await loading.result).status, "unauthenticated");
  assert.equal(calls, 1);
}));
