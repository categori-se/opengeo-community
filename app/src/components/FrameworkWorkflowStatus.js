/** Configuration is not a health check, completed build, or publication receipt. */
export function FrameworkWorkflowStatus({adapter, projectId}) {
  const root = document.createElement("section");
  root.className = "framework-workflow-status";
  const heading = document.createElement("h4"); heading.textContent = "Hosted workflow availability";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const stages = document.createElement("ul");
  const reload = document.createElement("button"); reload.type = "button";
  reload.className = "platform-button secondary"; reload.textContent = "Check workflow configuration";
  async function load() {
    if (reload.disabled) return;
    reload.disabled = true; stages.replaceChildren();
    status.textContent = "Reading this deployment's configuration…";
    try {
      const configuration = await adapter.getObservableWorkflow(projectId);
      if (configuration.projectId !== projectId || configuration.configurationOnly !== true) throw new Error("workflow_identity_mismatch");
      for (const [label, configured] of [
        ["Private source storage", configuration.sourceStorageConfigured],
        ["Build queue", configuration.buildDispatchConfigured],
        ["Isolated private preview", configuration.privatePreviewConfigured]
      ]) {
        const item = document.createElement("li");
        item.textContent = `${label}: ${configured ? "configured" : "not configured"}.`;
        stages.append(item);
      }
      const publication = document.createElement("li");
      publication.textContent = "Destinations and release status are shown in Publish.";
      stages.append(publication);
      status.textContent = "Build service configuration. Open Preview for build progress or Publish for releases.";
    } catch {
      status.textContent = "Workflow configuration is unavailable. Do not assume build, preview or publication is ready. Your saved source is unchanged.";
    } finally {reload.disabled = false;}
  }
  reload.addEventListener("click", load);
  root.append(heading, status, stages, reload);
  if (typeof adapter.getObservableWorkflow === "function") void load();
  else {reload.disabled = true; status.textContent = "This adapter cannot report hosted Framework availability.";}
  return root;
}
