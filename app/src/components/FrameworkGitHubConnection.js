/** Optional explicit source export and immutable receipts, independent of build execution. */
export function FrameworkGitHubConnection({adapter, projectId, sourceProjectId, canManage = false}) {
  const root = element("section", ""); root.className = "framework-github-connection";
  root.append(element("h4", "Optional GitHub source export"));
  root.append(element("p", "Private drafts are saved in OpenGeo. Compiling uses the trusted build service without a GitHub source link. Saving or autosaving a draft never exports it."));
  const status = element("p", ""); status.setAttribute("role", "status");
  const details = element("div", "");
  let busy = false;
  const reload = button("Refresh GitHub connection", () => load());
  root.append(status, details, reload);
  function show(value) {
    if (value.sourceProjectId !== sourceProjectId) throw new Error("source_identity_mismatch");
    details.replaceChildren();
    if (value.connection) {
      const connection = value.connection;
      details.append(element("p", `${connection.repository} · ${connection.enabled ? "authorized private repository" : "connection disabled; no new exports"}`));
      const repository = element("a", "Open private repository");
      repository.href = `https://github.com/${connection.repository}`;
      repository.target = "_blank"; repository.rel = "noopener noreferrer";
      details.append(repository);
      if (!value.revisions.length) details.append(element("p", "No GitHub revision receipt yet. A selected repository is not proof that source was synced or built."));
      for (const revision of value.revisions) {
        const row = element("p", `Studio revision ${revision.revisionNumber} · `);
        const commit = element("a", revision.commitSha.slice(0, 12));
        commit.href = `https://github.com/${connection.repository}/commit/${revision.commitSha}`;
        commit.target = "_blank"; commit.rel = "noopener noreferrer";
        row.append(commit); details.append(row);
      }
      const pending = (value.syncs ?? []).filter(job => job.stage !== "synced" && !value.revisions.some(receipt => receipt.sourceRevisionId === job.sourceRevisionId));
      for (const job of pending) details.append(element("p", `Studio revision ${job.revisionNumber}: GitHub sync ${job.stage}${job.errorCode ? ` (${job.errorCode})` : ""}. Last update: ${job.updatedAt}`));
      const retryIds = new Set(pending.map(job => job.sourceRevisionId));
      if (value.currentRevisionId && !value.revisions.some(receipt => receipt.sourceRevisionId === value.currentRevisionId)) retryIds.add(value.currentRevisionId);
      if (canManage && value.canSync && value.syncConfigured && typeof adapter.syncObservableGitHubRevision === "function") {
        for (const revisionId of retryIds) {
          const sync = button(revisionId === value.currentRevisionId ? "Sync saved revision to GitHub" : `Retry source sync ${revisionId.slice(0, 8)}`, async () => {
            if (busy) return;
            busy = true; reload.disabled = true;
            for (const control of details.querySelectorAll("button")) control.disabled = true;
            try {show(await adapter.syncObservableGitHubRevision(projectId, sourceProjectId, revisionId));}
            catch {details.replaceChildren(); status.textContent = "Source remains saved in OpenGeo. Refresh to check GitHub sync and retry this same revision. No build was requested.";}
            finally {busy = false; reload.disabled = false;}
          });
          details.append(sync);
        }
      }
      status.textContent = value.syncConfigured
        ? "Sync copies only the selected saved revision to this private repository. Connecting and later draft saves do not export source. Build and Publish remain separate explicit actions."
        : "Explicit source export is unavailable on this deployment. Your drafts remain saved in OpenGeo; existing GitHub exports are recorded by the commit receipts below.";
    } else if (canManage && value.canConnect && value.availableConnections.length) {
      const label = element("label", "Choose an authorized private repository ");
      const select = element("select", "");
      for (const connection of value.availableConnections) {
        const option = element("option", connection.repository); option.value = connection.id; select.append(option);
      }
      label.append(select); details.append(label);
      const connect = button("Connect this Framework project", async () => {
        if (busy || !canManage) return;
        busy = true; connect.disabled = select.disabled = reload.disabled = true;
        status.textContent = "Saving this project's repository selection…";
        try {show(await adapter.connectObservableGitHub(projectId, sourceProjectId, select.value));}
        catch {
          details.replaceChildren();
          status.textContent = "The connection result is unknown. Refresh to recover the saved selection before trying again. No build was requested.";
        } finally {busy = false; reload.disabled = false;}
      });
      details.append(connect);
      status.textContent = "Connecting only saves this project's repository selection. Use Sync to export a selected saved revision. Future draft saves do not export source. Connecting does not start a build or publish a site.";
    } else {
      status.textContent = "No authorized private GitHub repository is connected to this project. A deployment administrator must verify a repository grant before it can be selected.";
    }
  }
  async function load() {
    if (busy) return;
    busy = true; reload.disabled = true; details.replaceChildren();
    status.textContent = "Reading this project's GitHub connection…";
    try {show(await adapter.getObservableGitHubStatus(projectId, sourceProjectId));}
    catch {details.replaceChildren(); status.textContent = "GitHub connection status is unavailable. No source was exported and no build was started.";}
    finally {busy = false; reload.disabled = false;}
  }
  if (typeof adapter.getObservableGitHubStatus === "function") void load();
  else {reload.disabled = true; status.textContent = "This deployment cannot yet manage GitHub source connections.";}
  return root;
}
function element(tag, text) {const node = document.createElement(tag); node.textContent = text; return node;}
function button(label, handler) {
  const node = element("button", label); node.type = "button"; node.className = "platform-button secondary";
  node.addEventListener("click", handler); return node;
}
