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

function sharedAccessState(role = "owner") {
  const current = state();
  current.organization.id = "selected-account";
  current.project.callerRole = role;
  current.adapter.selectedOrganizationId = current.organization.id;
  const calls = [], writes = [];
  const records = [
    {projectId: current.project.id, teamId: "team-a", teamName: "Regional <research>", role: "editor"},
    {projectId: current.project.id, teamId: "team-b", teamName: "Cartography", role: "viewer"}
  ];
  const members = [{userId: "owner", displayName: "Existing owner", email: "owner@example.test", role: "owner"}];
  current.adapter.listProjectTeamGrants = async id => {calls.push(["grants", id]); return structuredClone(records);};
  current.adapter.listProjectMembers = async id => {calls.push(["members", id]); return structuredClone(members);};
  current.adapter.listTeams = async () => [
    {id: "team-a", name: "Regional <research>", status: "active"},
    {id: "team-b", name: "Cartography", status: "active"},
    {id: "team-c", name: "Reviewers", status: "active"},
    {id: "team-old", name: "Archived", status: "archived"}
  ];
  current.adapter.createProjectTeamGrant = async (projectId, teamId, role) => {
    writes.push(["create", projectId, teamId, role]);
    records.push({projectId, teamId, teamName: "Reviewers", role});
    return structuredClone(records.at(-1));
  };
  current.adapter.updateProjectTeamGrant = async (projectId, teamId, role) => {
    writes.push(["update", projectId, teamId, role]);
    const grant = records.find(item => item.teamId === teamId); grant.role = role;
    return structuredClone(grant);
  };
  current.adapter.revokeProjectTeamGrant = async (projectId, teamId) => {
    writes.push(["revoke", projectId, teamId]);
    records.splice(records.findIndex(item => item.teamId === teamId), 1);
  };
  return {current, calls, writes, records, members};
}

it("reviews and changes several workspace team grants with their full access scope", async () => {
  const {current, calls, writes, records, members} = sharedAccessState();
  const root = ProjectLifecycleSettings({state: current, refresh: () => {}});
  document.body.append(root);
  const access = root.querySelector(".project-access-settings");
  assert.match(access.textContent, /Access workspace: Field <survey>/);
  assert.match(access.textContent, /other Projects, Publications and linked Layers/);
  assert.match(access.textContent, /Geographic tags record place context separately/);
  assert.equal(calls.length, 0);
  button(access, "Load current workspace access").click(); await tick();
  assert.equal(access.querySelectorAll(".platform-compact-record").length, 2);
  assert.equal(access.querySelector("research"), null);
  assert.match(access.textContent, /Existing owner/);
  const team = access.querySelector('[aria-label="Team to share this workspace with"]');
  assert.deepEqual([...team.options].map(item => item.value), ["", "team-c"]);
  team.value = "team-c"; team.dispatchEvent(new dom.window.Event("change"));
  access.querySelector('[aria-label="New team role"]').value = "viewer";
  button(access, "Grant team access").click(); await tick();
  assert.equal(records.length, 3);
  let row = access.querySelector(".platform-compact-record");
  row.querySelector("select").value = "reviewer";
  button(row, "Save team role").click(); await tick();
  row = access.querySelectorAll(".platform-compact-record")[1];
  button(row, "Revoke team access").click();
  assert.match(row.textContent, /entire “Field <survey>” access workspace/);
  button(row, "Cancel").click(); assert.equal(writes.length, 2);
  button(row, "Revoke team access").click(); button(row, "Confirm revoke").click(); await tick();
  assert.deepEqual(writes, [
    ["create", "test-project", "team-c", "viewer"],
    ["update", "test-project", "team-a", "reviewer"],
    ["revoke", "test-project", "team-b"]
  ]);
  assert.equal(members[0].role, "owner");
  assert.equal(records.length, 2);
  assert.match(access.querySelector('[role="status"]').textContent, /saved; current grants reloaded/);
});

it("requires current workspace access readback after an uncertain grant result", async () => {
  const {current, writes, records} = sharedAccessState();
  current.adapter.createProjectTeamGrant = async (projectId, teamId, role) => {
    writes.push([projectId, teamId, role]);
    records.push({projectId, teamId, teamName: "Reviewers", role});
    throw Error("private transport details");
  };
  const root = ProjectLifecycleSettings({state: current, refresh: () => {}});
  document.body.append(root);
  const access = root.querySelector(".project-access-settings");
  button(access, "Load current workspace access").click(); await tick();
  const team = access.querySelector('[aria-label="Team to share this workspace with"]');
  team.value = "team-c"; team.dispatchEvent(new dom.window.Event("change"));
  button(access, "Grant team access").click(); await tick();
  assert.equal(writes.length, 1);
  assert.equal(button(access, "Grant team access").disabled, true);
  assert.equal(button(access, "Save team role").disabled, true);
  assert.doesNotMatch(access.textContent, /private transport details/);
  button(access, "Grant team access").click(); await tick();
  assert.equal(writes.length, 1);
  button(access, "Reload current workspace access").click(); await tick();
  assert.equal(access.querySelectorAll(".platform-compact-record").length, 3);
  assert.equal(button(access, "Save team role").disabled, false);
  assert.equal(writes.length, 1);
});

it("keeps workspace access read only for viewers and withholds late account or closed-view results", async () => {
  const viewer = sharedAccessState("viewer");
  const root = ProjectLifecycleSettings({state: viewer.current, refresh: () => {}});
  document.body.append(root);
  const access = root.querySelector(".project-access-settings");
  button(access, "Load current workspace access").click(); await tick();
  assert.equal(access.querySelectorAll("select").length, 0);
  assert.equal(button(access, "Save team role"), undefined);
  assert.match(access.textContent, /owner or account administrator/);
  assert.equal(viewer.writes.length, 0);
  for (const reason of ["account-change", "closed-view"]) {
    const {current, writes} = sharedAccessState();
    let finish;
    current.adapter.listProjectTeamGrants = () => new Promise(resolve => {finish = resolve;});
    const parent = ProjectLifecycleSettings({state: current, refresh: () => {}});
    document.body.append(parent);
    const panel = parent.querySelector(".project-access-settings");
    button(panel, "Load current workspace access").click(); await tick();
    if (reason === "account-change") current.adapter.selectedOrganizationId = "another-account";
    else parent.remove();
    finish([{projectId: "test-project", teamId: "secret", teamName: "Late private team", role: "owner"}]);
    await tick();
    assert.doesNotMatch(panel.textContent, /Late private team/);
    assert(panel.querySelectorAll("button").length > 0);
    assert([...panel.querySelectorAll("button")].every(item => item.disabled));
    assert.equal(writes.length, 0);
  }
});
