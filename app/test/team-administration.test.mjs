import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {renderTeamAdministrationState} from "../src/components/TeamAdministration.js";

let dom;
let previousDocument;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/admin"});
  previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  dom.window.close();
});

function readyState() {
  return {
    status: "ready",
    adapter: {kind: "api"},
    organization: {name: "Demo", callerRole: "admin"},
    projects: [
      {id: "10000000-0000-4000-8000-000000000001", name: "Existing project"},
      {id: "10000000-0000-4000-8000-000000000002", name: "Access check <private>"}
    ],
    selectedProjectId: "10000000-0000-4000-8000-000000000001",
    invitations: [], organizationMembers: [], projectMembers: []
  };
}

function input(root, label) {
  return [...root.querySelectorAll("input, select")].find((element) => element.ariaLabel === label);
}

async function submit(root) {
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it("offers loaded projects and submits the chosen project with guest/viewer access", async () => {
  const root = document.createElement("section");
  const state = readyState();
  const calls = [];
  const refreshed = [];
  state.adapter.createInvitation = async (request) => calls.push(request);
  renderTeamAdministrationState(root, state, async (id) => refreshed.push(id));
  const project = input(root, "Optional access workspace");
  assert.deepEqual([...project.options].map(({value, textContent}) => [value, textContent]), [
    ["", "Organization only"], ...state.projects.map(({id, name}) => [id, name])
  ]);
  assert.equal(root.querySelector("private"), null);
  assert.equal(input(root, "Access workspace role").disabled, true);
  assert.equal(calls.length, 0);
  input(root, "Email").value = "reviewer@example.com";
  input(root, "Display name").value = "Reviewer";
  input(root, "Organization role").value = "guest";
  project.value = state.projects[1].id;
  project.dispatchEvent(new dom.window.Event("change"));
  assert.equal(input(root, "Access workspace role").disabled, false);
  assert.equal(input(root, "Access workspace role").value, "viewer");
  input(root, "Expires").value = "3";
  await submit(root);
  assert.deepEqual(calls, [{
    email: "reviewer@example.com", displayName: "Reviewer", organizationRole: "guest",
    projectId: state.projects[1].id, projectRole: "viewer", expiresInDays: 3
  }]);
  assert.deepEqual(refreshed, [state.projects[1].id]);
});

it("clears project scope when Organization only is deliberately selected", async () => {
  const root = document.createElement("section");
  const state = readyState();
  let request;
  state.adapter.createInvitation = async (value) => { request = value; };
  renderTeamAdministrationState(root, state, async () => {});
  const project = input(root, "Optional access workspace");
  project.value = state.projects[1].id;
  project.dispatchEvent(new dom.window.Event("change"));
  input(root, "Access workspace role").value = "editor";
  project.value = "";
  project.dispatchEvent(new dom.window.Event("change"));
  assert.equal(input(root, "Access workspace role").disabled, true);
  await submit(root);
  assert.equal(request.projectId, null);
  assert.equal(request.projectRole, null);
});

it("preserves the entered scope after an invitation failure without claiming success", async () => {
  const root = document.createElement("section");
  const state = readyState();
  state.adapter.createInvitation = async () => { throw Object.assign(new Error(), {code: "invitation_conflict"}); };
  let refreshed = false;
  renderTeamAdministrationState(root, state, async () => { refreshed = true; });
  input(root, "Optional access workspace").value = state.projects[1].id;
  input(root, "Email").value = "reviewer@example.com";
  await submit(root);
  assert.equal(input(root, "Optional access workspace").value, state.projects[1].id);
  assert.equal(input(root, "Email").value, "reviewer@example.com");
  assert.equal(root.querySelector('button[type="submit"]').disabled, false);
  assert.equal(root.querySelector(".platform-mutation-feedback").dataset.state, "error");
  assert.equal(refreshed, false);
});

it("provides a return route and preserves explicit fixture mode", () => {
  for (const kind of ["api", "fixture"]) {
    const root = document.createElement("section");
    const state = readyState();
    state.adapter.kind = kind;
    renderTeamAdministrationState(root, state, () => {});
    const back = root.querySelector("header a");
    assert.equal(back.textContent, "Back to projects");
    assert.equal(back.getAttribute("href"), kind === "api" ? "/workspaces" : "/workspaces?adapter=fixture");
  }
});
