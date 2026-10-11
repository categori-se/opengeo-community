import assert from "node:assert/strict";
import {beforeEach, afterEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectLifecycleSettings} from "../src/components/ProjectLifecycleSettings.js";

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
const button = (root, label) => [...root.querySelectorAll("button")].find(item => item.textContent === label);
function state(status = "active") {
  return {organization: {callerRole: "member"}, project: {id: "test-project", name: "Field <survey>", status, callerRole: "owner"}, adapter: {kind: "api"}};
}

it("requires confirmation for the exact project and allows cancellation without writes", async () => {
  const current = state();
  const calls = [];
  current.adapter.updateProject = async (id, change) => { calls.push([id, change]); return {...current.project, ...change}; };
  let refreshes = 0;
  const root = ProjectLifecycleSettings({state: current, refresh: async () => { refreshes++; }});
  document.body.append(root);
  assert.equal(root.querySelector('a').getAttribute('href'), '/workspaces?view=access');
  assert.equal(calls.length, 0);
  button(root, "Archive workspace").click();
  assert.match(root.textContent, /Field <survey>/);
  assert.equal(root.querySelector("survey"), null);
  assert.equal(document.activeElement, button(root, "Confirm archive"));
  button(root, "Cancel").click();
  assert.equal(document.activeElement, button(root, "Archive workspace"));
  assert.equal(calls.length, 0);
  button(root, "Archive workspace").click();
  button(root, "Confirm archive").click();
  assert.equal(button(root, "Confirm archive").disabled, true);
  await tick();
  assert.deepEqual(calls, [["test-project", {status: "archived"}]]);
  assert.equal(root.dataset.projectStatus, "archived");
  assert.equal(refreshes, 1);
});

it("restores without changing any sharing, publication or map fields", async () => {
  const current = state("archived");
  const calls = [];
  current.adapter.updateProject = async (id, changes) => { calls.push([id, changes]); return {...current.project, ...changes}; };
  const root = ProjectLifecycleSettings({state: current, refresh: async () => { throw Error("refresh failed"); }});
  button(root, "Restore workspace").click();
  button(root, "Confirm restore").click();
  await tick();
  assert.deepEqual(calls, [["test-project", {status: "active"}]]);
  assert.match(root.querySelector('[role="status"]').textContent, /Workspace restored.*could not refresh/);
  assert.equal(root.dataset.projectStatus, "active");
});

it("keeps failed updates recoverable and never reports an unverified status as success", async () => {
  for (const update of [async () => { throw Error("private error"); }, async () => ({id: "wrong-project", status: "archived"})]) {
    const current = state();
    current.adapter.updateProject = update;
    const root = ProjectLifecycleSettings({state: current, refresh: () => assert.fail("Unexpected refresh")});
    button(root, "Archive workspace").click();
    button(root, "Confirm archive").click();
    await tick();
    assert.equal(root.dataset.projectStatus, "active");
    assert.doesNotMatch(root.textContent, /private error|Workspace archived\./);
  }
});

it("shows lifecycle actions only to owners and administrators and preserves fixture navigation", () => {
  for (const role of ["viewer", "reviewer", "editor", "owner"]) {
    for (const organizationRole of ["member", "admin"]) {
      const current = state();
      current.project.callerRole = role;
      current.organization.callerRole = organizationRole;
      current.adapter.kind = "fixture";
      const root = ProjectLifecycleSettings({state: current, refresh: () => {}});
      assert.equal(root.querySelectorAll("button").length, role === "owner" || organizationRole === "admin" ? 1 : 0);
      assert.equal(root.querySelector("a").getAttribute("href"), "/workspaces?view=access&adapter=fixture");
    }
  }
});
