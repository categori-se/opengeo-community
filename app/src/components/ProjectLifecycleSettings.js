import {directoryHref} from "../lib/applicationRoutes.js";
import {ProjectAccessSettings} from "./ProjectAccessSettings.js";

export function ProjectLifecycleSettings({state, refresh}) {
  const section = document.createElement("section");
  section.className = "project-lifecycle-settings";
  const archived = state.project.status === "archived";
  section.dataset.projectStatus = state.project.status;
  const title = document.createElement("h2");
  title.textContent = "Access workspace status";
  const description = document.createElement("p");
  description.textContent = archived
    ? "This access workspace is archived. Its Projects, data and access records are retained."
    : "Archive a finished access workspace to remove it from Active workspaces. This does not archive or delete its individual Projects, Publications or data.";
  const recovery = document.createElement("p");
  recovery.textContent = "Find it under Access workspaces using the Archived workspaces filter. Workspace status does not revoke access or withdraw a Publication.";
  const projects = document.createElement("a");
  projects.textContent = "View access workspaces";
  projects.className = "platform-button platform-button-secondary";
  projects.href = directoryHref({adapterKind: state.adapter?.kind, view: "access"});
  section.append(title, description, recovery, projects);
  if (typeof state.adapter.listProjectTeamGrants === "function") {
    const access = ProjectAccessSettings({state});
    section.append(access);
    section.dispose = () => access.dispose();
  }
  if (state.organization.callerRole !== "admin" && state.project.callerRole !== "owner") return section;

  const controls = document.createElement("div");
  controls.className = "platform-actions";
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  const prepare = button(archived ? "Restore workspace" : "Archive workspace");
  controls.append(prepare);
  prepare.addEventListener("click", () => {
    const question = document.createElement("p");
    question.textContent = archived
      ? `Restore “${state.project.name}” to Active workspaces? Existing sharing and publication settings still apply.`
      : `Archive “${state.project.name}”? Its records will be retained. Review access and publications separately.`;
    const confirm = button(archived ? "Confirm restore" : "Confirm archive");
    const cancel = button("Cancel");
    controls.replaceChildren(question, confirm, cancel);
    cancel.addEventListener("click", () => {
      controls.replaceChildren(prepare);
      prepare.focus();
    });
    confirm.focus();
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      feedback.textContent = archived ? "Restoring workspace…" : "Archiving workspace…";
      const nextStatus = archived ? "active" : "archived";
      let updated;
      try {
        updated = await state.adapter.updateProject(state.project.id, {status: nextStatus});
      } catch {
        feedback.textContent = "The workspace status could not be updated. Check its current status before trying again.";
        confirm.disabled = false;
        cancel.disabled = false;
        return;
      }
      if (updated.id !== state.project.id || updated.status !== nextStatus) {
        feedback.textContent = "The returned workspace status could not be verified. Reload before trying again.";
        return;
      }
      section.dataset.projectStatus = nextStatus;
      feedback.textContent = archived ? "Workspace restored." : "Workspace archived.";
      try {
        await refresh();
      } catch {
        feedback.textContent += " The page could not refresh. Reload to see the current workspace.";
      }
    });
  });
  section.append(controls, feedback);
  return section;
}

function button(label) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "platform-button";
  element.textContent = label;
  return element;
}
