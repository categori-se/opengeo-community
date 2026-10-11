import {AccountNavigation} from "./AccountNavigation.js";
import {StudioNavigation} from "./StudioNavigation.js";
import {loadTeamAdministration} from "../lib/platform.js";
import {modeBanner, platformStatePanel} from "./PlatformDirectory.js";
import {
  loadWithWakeRetry,
  platformStartupMessage
} from "../lib/platformLoadRetry.js";

export function TeamAdministration({adapter, auth = null}) {
  const root = document.createElement("section");
  root.className = "platform-surface platform-team-admin";
  root.ariaLive = "polite";
  let selectedProjectId = null;
  void refresh();
  return root;

  async function refresh(projectId = selectedProjectId) {
    renderLoading(root);
    const state = await loadWithWakeRetry(
      () => loadTeamAdministration(adapter, projectId),
      {onRetry: () => renderLoading(root, platformStartupMessage("account"))}
    );
    selectedProjectId = state.selectedProjectId ?? projectId;
    renderTeamAdministrationState(root, state, refresh, auth);
  }
}

export function renderTeamAdministrationState(root, state, refresh, auth = null) {
  root.replaceChildren(StudioNavigation({adapterKind: state.adapter?.kind}), modeBanner(state.adapter));
  if (state.status !== "ready") {
    root.append(platformStatePanel(state, refresh, {auth, autoSignIn: true}));
    return;
  }

  const heading = document.createElement("header");
  heading.className = "platform-heading";
  heading.append(
    block("div",
      text("p", state.organization.name, "platform-eyebrow"),
      text("h2", "People and access"),
      text("p", "Invitations and role changes take effect on the next API request.", "platform-subtitle")
    ),
    text("span", state.organization.callerRole, `badge ${state.organization.callerRole}`)
  );
  const projectsLink = text("a", "Back to projects", "platform-button platform-button-secondary");
  projectsLink.href = state.adapter?.kind === "fixture" ? "/workspaces?adapter=fixture" : "/workspaces";
  heading.append(projectsLink);
  const feedback = document.createElement("div");
  feedback.className = "platform-mutation-feedback";
  feedback.ariaLive = "assertive";

  root.append(
    heading,
    AccountNavigation({adapterKind: state.adapter?.kind, active: "people", admin: state.organization.callerRole === "admin"}),
    feedback,
    invitePanel(state, feedback, refresh),
    invitationsPanel(state, feedback, refresh),
    organizationMembersPanel(state, feedback, refresh),
    projectMembersPanel(state, feedback, refresh)
  );
}

function invitePanel(state, feedback, refresh) {
  const panel = section("Invite a person", "Invite someone to this account and, optionally, a data access workspace.");
  const form = document.createElement("form");
  form.className = "platform-admin-form";
  const email = field("Email", "email", "invitee@example.com");
  email.input.required = true;
  const displayName = field("Display name", "text", "Invitee name");
  displayName.input.required = true;
  const organizationRole = selectField("Organization role", ["member", "guest", "admin"]);
  const project = selectField(
    "Optional access workspace",
    ["", ...state.projects.map((item) => item.id)],
    new Map([["", "Organization only"], ...state.projects.map((item) => [item.id, item.name])])
  );
  const projectRole = selectField("Access workspace role", ["viewer", "reviewer", "editor", "owner"]);
  const expiry = selectField("Expires", ["7", "3", "14", "30"], new Map([
    ["7", "7 days"], ["3", "3 days"], ["14", "14 days"], ["30", "30 days"]
  ]));
  const submit = action("Send invitation", null, "submit");
  projectRole.input.disabled = true;
  project.input.addEventListener("change", () => {
    projectRole.input.disabled = !project.input.value;
  });
  form.append(
    email.label,
    displayName.label,
    organizationRole.label,
    project.label,
    projectRole.label,
    expiry.label,
    submit
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    showFeedback(feedback, "working", "Creating invitation…");
    try {
      await state.adapter.createInvitation({
        email: email.input.value,
        displayName: displayName.input.value,
        organizationRole: organizationRole.input.value,
        projectId: project.input.value || null,
        projectRole: project.input.value ? projectRole.input.value : null,
        expiresInDays: Number(expiry.input.value)
      });
      showFeedback(feedback, "success", `Invitation created for ${email.input.value.trim().toLowerCase()}.`);
      await refresh(project.input.value || state.selectedProjectId);
    } catch (error) {
      showMutationError(feedback, error);
      submit.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

function invitationsPanel(state, feedback, refresh) {
  const panel = section("Invitations", "Pending records can be revoked; accepted, expired, and revoked records remain auditable.");
  if (!state.invitations.length) {
    panel.append(empty("No invitations", "Create an invitation to add the first organization member."));
    return panel;
  }
  const table = tableWithHead(["Person", "Scope", "Status", "Expires", "Action"]);
  for (const invitation of state.invitations) {
    const row = document.createElement("tr");
    const person = document.createElement("td");
    person.append(text("strong", invitation.displayName), text("div", invitation.email, "platform-record-description"));
    const scope = invitation.projectId
      ? `Access workspace: ${projectName(state, invitation.projectId)} · ${invitation.projectRole}`
      : "Organization only";
    const actionCell = document.createElement("td");
    if (invitation.status === "pending") {
      const revoke = action("Revoke", async () => {
        revoke.disabled = true;
        showFeedback(feedback, "working", `Revoking ${invitation.email}…`);
        try {
          await state.adapter.revokeInvitation(invitation.id);
          showFeedback(feedback, "success", `Invitation revoked for ${invitation.email}.`);
          await refresh(state.selectedProjectId);
        } catch (error) {
          showMutationError(feedback, error);
          revoke.disabled = false;
        }
      }, "button", "platform-button-secondary");
      revoke.dataset.action = "revoke-invitation";
      actionCell.append(revoke);
    } else {
      actionCell.textContent = "Final";
    }
    row.append(
      person,
      text("td", `${invitation.organizationRole} · ${scope}`),
      badgeCell(invitation.status),
      text("td", formatDate(invitation.expiresAt)),
      actionCell
    );
    table.tBodies[0].append(row);
  }
  panel.append(table);
  return panel;
}

function organizationMembersPanel(state, feedback, refresh) {
  const panel = section("Organization members", "Only an organization admin can change or revoke these roles.");
  const table = tableWithHead(["Person", "Role", "Actions"]);
  for (const member of state.organizationMembers) {
    const row = document.createElement("tr");
    const person = document.createElement("td");
    person.append(text("strong", member.displayName), text("div", member.email, "platform-record-description"));
    const role = select(["admin", "member", "guest"], member.role, `${member.displayName} organization role`);
    const roleCell = document.createElement("td");
    roleCell.append(role);
    const actions = document.createElement("td");
    const save = action("Save", async () => {
      await mutate(feedback, save, `Updating ${member.email}…`, async () => {
        await state.adapter.updateOrganizationMember(member.userId, role.value);
        await refresh(state.selectedProjectId);
      });
    });
    save.dataset.action = "update-organization-member";
    const revoke = action("Revoke", async () => {
      await mutate(feedback, revoke, `Revoking ${member.email}…`, async () => {
        await state.adapter.revokeOrganizationMember(member.userId);
        await refresh(state.selectedProjectId);
      });
    }, "button", "platform-button-secondary");
    revoke.dataset.action = "revoke-organization-member";
    actions.append(save, revoke);
    row.append(person, roleCell, actions);
    table.tBodies[0].append(row);
  }
  panel.append(table);
  return panel;
}

function projectMembersPanel(state, feedback, refresh) {
  const panel = section("Access workspace members", "Workspace owners and organization admins can manage existing organization members. These grants control data access and are distinct from authored OpenGeo Projects.");
  if (!state.projects.length) {
    panel.append(empty("No access workspaces", "Create an access workspace before assigning its roles."));
    return panel;
  }

  const controls = document.createElement("div");
  controls.className = "platform-controls";
  const project = select(
    state.projects.map((item) => item.id),
    state.selectedProjectId,
    "Access workspace membership scope",
    new Map(state.projects.map((item) => [item.id, item.name]))
  );
  project.addEventListener("change", () => void refresh(project.value));
  controls.append(project);

  const assigned = new Set(state.projectMembers.map((member) => member.userId));
  const candidates = state.organizationMembers.filter((member) => !assigned.has(member.userId));
  if (candidates.length) {
    const candidate = select(
      candidates.map((member) => member.userId),
      candidates[0].userId,
      "Organization member to add",
      new Map(candidates.map((member) => [member.userId, `${member.displayName} · ${member.email}`]))
    );
    const role = select(["viewer", "reviewer", "editor", "owner"], "viewer", "New access workspace role");
    const add = action("Add to workspace", async () => {
      await mutate(feedback, add, "Adding access workspace member…", async () => {
        await state.adapter.createProjectMember(project.value, candidate.value, role.value);
        await refresh(project.value);
      });
    });
    add.dataset.action = "create-project-member";
    controls.append(candidate, role, add);
  }
  panel.append(controls);

  if (!state.projectMembers.length) {
    panel.append(empty("No access workspace members", "Add an organization member to this workspace."));
    return panel;
  }
  const table = tableWithHead(["Person", "Role", "Actions"]);
  for (const member of state.projectMembers) {
    const row = document.createElement("tr");
    const person = document.createElement("td");
    person.append(text("strong", member.displayName), text("div", member.email, "platform-record-description"));
    const role = select(["owner", "editor", "reviewer", "viewer"], member.role, `${member.displayName} access workspace role`);
    const roleCell = document.createElement("td");
    roleCell.append(role);
    const actions = document.createElement("td");
    const save = action("Save", async () => {
      await mutate(feedback, save, `Updating ${member.email}…`, async () => {
        await state.adapter.updateProjectMember(project.value, member.userId, role.value);
        await refresh(project.value);
      });
    });
    save.dataset.action = "update-project-member";
    const revoke = action("Revoke", async () => {
      await mutate(feedback, revoke, `Revoking ${member.email}…`, async () => {
        await state.adapter.revokeProjectMember(project.value, member.userId);
        await refresh(project.value);
      });
    }, "button", "platform-button-secondary");
    revoke.dataset.action = "revoke-project-member";
    actions.append(save, revoke);
    row.append(person, roleCell, actions);
    table.tBodies[0].append(row);
  }
  panel.append(table);
  return panel;
}

async function mutate(feedback, button, workingMessage, operation) {
  button.disabled = true;
  showFeedback(feedback, "working", workingMessage);
  try {
    await operation();
    showFeedback(feedback, "success", "Membership updated.");
  } catch (error) {
    showMutationError(feedback, error);
    button.disabled = false;
  }
}

function showMutationError(feedback, error) {
  const code = error?.code ?? "unexpected_error";
  const request = error?.requestId ? ` Request ID: ${error.requestId}.` : "";
  showFeedback(feedback, "error", `The change was not applied (${code}).${request}`);
}

function showFeedback(feedback, status, message) {
  feedback.className = `platform-mutation-feedback platform-mutation-${status}`;
  feedback.dataset.state = status;
  feedback.textContent = message;
}

function renderLoading(root, message = "Loading members, invitations, and project roles…") {
  const loading = document.createElement("section");
  loading.className = "platform-state platform-state-loading";
  loading.dataset.state = "loading";
  loading.append(text("h2", "Loading"), text("p", message));
  root.replaceChildren(loading);
}

function section(title, description) {
  const panel = document.createElement("section");
  panel.className = "platform-admin-panel";
  panel.append(text("h3", title), text("p", description, "platform-note"));
  return panel;
}

function tableWithHead(labels) {
  const table = document.createElement("table");
  table.className = "data-table platform-admin-table";
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of labels) row.append(text("th", label));
  head.append(row);
  table.append(head, document.createElement("tbody"));
  return table;
}

function badgeCell(value) {
  const cell = document.createElement("td");
  cell.append(text("span", value, `badge ${value}`));
  return cell;
}

function empty(title, detail) {
  const panel = document.createElement("section");
  panel.className = "platform-state platform-state-empty";
  panel.dataset.state = "empty";
  panel.append(text("h3", title), text("p", detail));
  return panel;
}

function field(labelText, type, placeholder) {
  const input = document.createElement("input");
  input.type = type;
  input.placeholder = placeholder;
  input.ariaLabel = labelText;
  const label = document.createElement("label");
  label.append(text("span", labelText), input);
  return {label, input};
}

function selectField(labelText, values, labels = new Map()) {
  const input = select(values, values[0], labelText, labels);
  const label = document.createElement("label");
  label.append(text("span", labelText), input);
  return {label, input};
}

function select(values, selected, label, labels = new Map()) {
  const element = document.createElement("select");
  element.ariaLabel = label;
  for (const value of values) {
    const item = text("option", labels.get(value) ?? value);
    item.value = value;
    item.selected = value === selected;
    element.append(item);
  }
  return element;
}

function action(label, handler, type = "button", className = "") {
  const button = text("button", label, `platform-button ${className}`.trim());
  button.type = type;
  if (handler) button.addEventListener("click", handler);
  return button;
}

function block(tag, ...children) {
  const element = document.createElement(tag);
  element.append(...children);
  return element;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function projectName(state, projectId) {
  return state.projects.find((project) => project.id === projectId)?.name ?? "Restricted project";
}

function formatDate(value) {
  return new Date(value).toLocaleDateString();
}
