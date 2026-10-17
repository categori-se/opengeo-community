import {directoryHref} from "../lib/applicationRoutes.js";

// Existing team grants cover the complete legacy access workspace.
export function ProjectAccessSettings({state}) {
  const {adapter, project, organization} = state;
  const projectId = project.id;
  const accountId = organization.id;
  const manager = organization.callerRole === "admin" || project.callerRole === "owner";
  const root = node("section"); root.className = "project-access-settings";
  const feedback = node("p"), direct = node("div"), grants = node("div");
  feedback.setAttribute("role", "status");
  const inspect = button("Load current workspace access", () => void reload());
  const form = node("form"), teams = node("select"), role = roles("New team role");
  teams.setAttribute("aria-label", "Team to share this workspace with");
  const add = button("Grant team access"); add.type = "submit";
  form.append(field("Team", teams), field("Workspace role", role), add);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (teams.value) void mutate(() => adapter.createProjectTeamGrant(projectId, teams.value, role.value));
  });
  let disposed = false, busy = false, loaded = false, needsReadback = false;
  const pendingConfirmations = new Set();
  root.append(node("h2", "Shared workspace access"),
    node("p", `Access workspace: ${project.name}`), node("code", projectId),
    node("p", "These roles apply across this access workspace, including its other Projects, Publications and linked Layers. Each Layer and Publication retains its own access checks. Geographic tags record place context separately."),
    node("p", "People can belong to several teams. Their strongest direct or active-team workspace role applies; removing one grant may leave another route to access."),
    inspect, direct, grants, feedback);
  if (manager && typeof adapter.createProjectTeamGrant === "function") root.append(form);
  const people = node("a", organization.callerRole === "admin" ? "Manage direct members and invitations" : "View account teams");
  people.href = organization.callerRole === "admin"
    ? (adapter.kind === "fixture" ? "/admin?adapter=fixture" : "/admin")
    : directoryHref({adapterKind: adapter.kind, view: "teams"});
  root.append(people);
  root.dispose = () => {
    disposed = true; direct.replaceChildren(); grants.replaceChildren(); teams.replaceChildren(); lock();
  };
  root.load = reload;
  teams.addEventListener("change", lock);
  lock();
  return root;

  async function current() {
    if (disposed) return false;
    try {
      const selected = typeof adapter.organizationProvider === "function"
        ? await adapter.organizationProvider() : adapter.selectedOrganizationId;
      if (!disposed && root.isConnected && accountId && selected === accountId) return true;
    } catch { /* Withhold controls when the account cannot be checked. */ }
    root.dispose();
    feedback.textContent = "The selected account changed or this view closed. Reopen workspace settings before changing access.";
    return false;
  }
  function lock() {
    inspect.disabled = disposed || busy;
    for (const control of root.querySelectorAll("select,button")) {
      if (control !== inspect) control.disabled = disposed || busy || !loaded || needsReadback;
    }
    add.disabled ||= !teams.value;
    for (const control of root.querySelectorAll('[data-unavailable="true"]')) control.disabled = true;
  }
  async function readAccess() {
    const [grantResult, memberResult, teamResult] = await Promise.allSettled([
      adapter.listProjectTeamGrants(projectId),
      adapter.listProjectMembers(projectId, {limit: 100}),
      manager && typeof adapter.listTeams === "function" ? adapter.listTeams() : []
    ]);
    if (!await current()) return false;
    if (grantResult.status !== "fulfilled" || grantResult.value.some(item => item.projectId !== projectId)) {
      throw Error("workspace_access_read_unavailable");
    }
    for (const confirmation of pendingConfirmations) confirmation.remove();
    pendingConfirmations.clear();
    direct.replaceChildren(node("h3", "Direct members"));
    if (memberResult.status === "fulfilled") {
      const list = node("ul");
      for (const member of memberResult.value) list.append(node("li", `${member.displayName} · ${member.email} · ${member.role}`));
      direct.append(list, node("p", memberResult.value.length === 100
        ? "Showing the first 100 direct members."
        : memberResult.value.length ? "Direct roles remain in place when team grants change." : "No direct members are listed."));
    } else direct.append(node("p", "Direct members could not load. Their access remains unchanged."));
    const records = grantResult.value;
    grants.replaceChildren(node("h3", "Team grants"));
    if (!records.length) grants.append(node("p", "No team grants are recorded for this workspace."));
    for (const grant of records) {
      const row = node("div"); row.className = "platform-compact-record";
      row.append(node("strong", grant.teamName), node("span", grant.role));
      if (manager) {
        const selection = roles(`${grant.teamName} workspace role`); selection.value = grant.role;
        const save = button("Save team role", () => void mutate(() => adapter.updateProjectTeamGrant(projectId, grant.teamId, selection.value)));
        const revoke = button("Revoke team access", () => {
          if (disposed || busy || needsReadback) return;
          const confirmation = node("div");
          confirmation.append(node("p", `Revoke “${grant.teamName}” from the entire “${project.name}” access workspace? Other grants and direct memberships remain.`),
            button("Confirm revoke", () => void mutate(() => adapter.revokeProjectTeamGrant(projectId, grant.teamId))),
            button("Cancel", () => {confirmation.remove(); pendingConfirmations.delete(confirmation); revoke.focus();}));
          for (const previous of pendingConfirmations) previous.remove();
          pendingConfirmations.clear(); pendingConfirmations.add(confirmation); row.append(confirmation);
          confirmation.querySelector("button").focus();
        });
        if (typeof adapter.updateProjectTeamGrant !== "function") save.dataset.unavailable = "true";
        if (typeof adapter.revokeProjectTeamGrant !== "function") revoke.dataset.unavailable = "true";
        row.append(field("Workspace role", selection), save, revoke);
      }
      grants.append(row);
    }
    if (manager && (typeof adapter.updateProjectTeamGrant !== "function"
      || typeof adapter.revokeProjectTeamGrant !== "function")) {
      grants.append(node("p", "Changing or revoking existing team grants is unavailable in this workspace."));
    }
    teams.replaceChildren(option("", "Choose an active team"));
    const granted = new Set(records.map(item => item.teamId));
    if (teamResult.status === "fulfilled") {
      for (const team of teamResult.value) if (team.status === "active" && !granted.has(team.id)) teams.append(option(team.id, team.name));
    }
    if (manager && teamResult.status !== "fulfilled") grants.append(node("p", "Available teams could not load. Reload access to choose another team."));
    loaded = true; needsReadback = false;
    return true;
  }
  async function reload() {
    if (busy || !await current()) return;
    busy = true; lock(); feedback.textContent = "Loading current workspace access…";
    try {
      if (await readAccess()) { inspect.textContent = "Reload current workspace access"; feedback.textContent = manager
        ? "Current grants loaded. Choose a team and role to change access across this workspace."
        : "Current direct and team grants loaded. A workspace owner or account administrator can change team access."; }
    } catch {
      feedback.textContent = "Workspace access could not load. Reload before changing grants.";
      needsReadback = true;
    } finally {busy = false; lock();}
  }
  async function mutate(operation) {
    if (!manager || busy || !loaded || needsReadback || !await current()) return;
    busy = true; needsReadback = true; lock(); feedback.textContent = "Saving workspace team access…";
    try {
      await operation();
      if (!await current()) return;
      if (await readAccess()) feedback.textContent = "Workspace team access saved; current grants reloaded.";
    } catch {
      if (await current()) feedback.textContent = "The change could not be confirmed. Reload current workspace access before changing it again.";
    } finally {busy = false; lock();}
  }
}

function node(tag, text) {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element;}
function button(text, action) {const element = node("button", text); element.type = "button"; element.className = "platform-button platform-button-secondary"; if (action) element.addEventListener("click", action); return element;}
function option(value, text) {const element = node("option", text); element.value = value; return element;}
function roles(label) {const element = node("select"); element.setAttribute("aria-label", label); for (const role of ["viewer", "reviewer", "editor", "owner"]) element.append(option(role, role)); return element;}
function field(label, control) {const element = node("label", label); element.append(control); return element;}
