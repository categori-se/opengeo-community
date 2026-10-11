import {saveCatalogProject} from "../lib/catalogProjectSave.js";
import {compositionHref} from "../lib/applicationRoutes.js";

export function CatalogProjectSave({adapter, record, layer, getView}) {
  const root = document.createElement("section");
  const open = element("button", "Save to Project…"); open.type = "button";
  root.append(open);
  let dialog;
  open.addEventListener("click", () => {
    if (dialog?.open) return;
    dialog = document.createElement("dialog"); dialog.className = "catalog-project-save";
    dialog.dataset.savePending = "true";
    dialog.dataset.returnTo = root.ownerDocument.defaultView.location.href;
    const heading = element("h2", "Save Layer to a Project");
    const form = document.createElement("form");
    const title = document.createElement("input"); title.value = record.title; title.maxLength = 160;
    const destination = document.createElement("select");
    destination.append(new Option("New Project", ""));
    const workspace = document.createElement("select");
    workspace.append(new Option(record.projectName || "Layer’s source workspace", record.projectId));
    const workspaceControls = document.createElement("section");
    const browseWorkspaces = element("button", "Browse access workspaces"); browseWorkspaces.type = "button";
    workspaceControls.append(label("Access workspace for new Project", workspace), browseWorkspaces,
      element("p", "The access workspace controls who can work on the Project. Layers keep their catalog identity and source permissions."));
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Find an existing Project";
    const find = element("button", "Find Projects"); find.type = "button";
    const more = element("button", "More Projects"); more.type = "button"; more.hidden = true;
    const status = element("p", "Choose a new or existing Project. The Layer remains connected to its catalog source."); status.setAttribute("role", "status");
    const submit = element("button", "Save"); submit.type = "submit";
    const cancel = element("button", "Cancel"); cancel.type = "button";
    const result = document.createElement("div");
    const titleLabel = label("New Project title", title);
    form.append(label("Destination", destination), titleLabel, workspaceControls, label("Search Projects", search), find, more, status, submit, cancel, result);
    dialog.append(heading, form); root.append(dialog);
    let busy = false, offset = 0, query = "", generation = 0, workspaceOffset = 0;
    const creationKey = crypto.randomUUID();
    const occurrenceId = `catalog_${creationKey}`;
    let frozenSave = null;
    const beforeUnload = event => {event.preventDefault(); event.returnValue = "";};
    const browser = root.ownerDocument.defaultView;
    browser.addEventListener("beforeunload", beforeUnload);
    const observer = new MutationObserver(() => {if (!dialog.isConnected) cleanup();});
    observer.observe(root.ownerDocument.documentElement, {childList: true, subtree: true});
    function cleanup() {dialog.dataset.savePending = "false"; generation++; observer.disconnect(); browser.removeEventListener("beforeunload", beforeUnload);}
    function close() {if (busy) return; cleanup(); dialog.close(); dialog.remove();}
    cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", event => {event.preventDefault(); status.textContent = "Use Cancel to leave this save form, or Save to keep your selection.";});
    destination.addEventListener("change", () => {titleLabel.hidden = workspaceControls.hidden = Boolean(destination.value); title.required = !destination.value;});
    title.required = true;
    async function choices(reset) {
      if (busy) return;
      const current = ++generation;
      if (reset) {query = search.value.trim(); offset = 0; destination.replaceChildren(destination.options[0]); titleLabel.hidden = workspaceControls.hidden = false; title.required = true;}
      find.disabled = more.disabled = true;
      status.textContent = "Finding Projects…";
      try {
        const records = await adapter.listCompositions({query, limit: 50, offset});
        if (current !== generation || !dialog.isConnected) return;
        for (const project of records) destination.append(new Option(`${project.name} · ${project.accessContainerName}`, project.id));
        offset += records.length; more.hidden = records.length < 50 || offset >= 1000;
        status.textContent = records.length ? "Choose a Project. Save checks your current edit access." : "No matching Projects. Try another search or create a new Project.";
      } catch {if (current === generation) status.textContent = "Projects could not load. Try Find Projects again.";}
      finally {if (dialog.isConnected && !busy && !frozenSave) find.disabled = more.disabled = false;}
    }
    browseWorkspaces.addEventListener("click", async () => {
      if (busy || frozenSave) return;
      const current = ++generation;
      browseWorkspaces.disabled = true;
      status.textContent = "Finding access workspaces…";
      try {
        const records = await adapter.listProjects({limit: 50, offset: workspaceOffset, signal: AbortSignal.timeout(20_000)});
        if (current !== generation || !dialog.isConnected) return;
        const known = new Set([...workspace.options].map(option => option.value));
        for (const candidate of records) {
          if (candidate.status === "active" && !known.has(candidate.id)) {
            workspace.append(new Option(candidate.name, candidate.id)); known.add(candidate.id);
          }
        }
        workspaceOffset += records.length;
        browseWorkspaces.hidden = records.length < 50 || workspaceOffset >= 1000;
        browseWorkspaces.textContent = "More access workspaces";
        status.textContent = "Choose an access workspace. Save checks your current edit and Layer access permissions.";
      } catch {if (current === generation) status.textContent = "Access workspaces could not load. Retry browsing them.";}
      finally {if (dialog.isConnected && !busy && !frozenSave) browseWorkspaces.disabled = false;}
    });
    find.addEventListener("click", () => void choices(true)); more.addEventListener("click", () => void choices(false));
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy) return;
      const targetId = destination.value || null;
      if (!targetId && !title.value.trim()) {title.focus(); return;}
      busy = true; ++generation;
      for (const input of form.querySelectorAll("input,select,button")) input.disabled = true;
      status.textContent = "Saving Layer reference…";
      try {
        frozenSave ??= {adapter, record, layer, view: getView?.(), title: title.value.trim(), targetId, occurrenceId, creationKey, accessContainerId: workspace.value};
        const saved = await saveCatalogProject(frozenSave);
        status.textContent = "Saved. The Project references this catalog Layer.";
        const link = element("a", "Open saved Project"); link.href = compositionHref(saved.id, {adapterKind: adapter.kind});
        result.replaceChildren(link); cleanup(); cancel.textContent = "Close";
        cancel.disabled = false;
      } catch (error) {
        const uncertain = !targetId && (!error?.status || error.status >= 500);
        status.textContent = `${error?.catalogReferenceLinked ? "The Layer reference was linked to the destination access workspace, but the Project save did not finish. " : ""}${uncertain ? "The response was interrupted. Retry Save to recover the same Project." : "The Project could not be saved. Check your edit access or retry after a version conflict. Your preview remains available."}`;
        for (const input of form.querySelectorAll("input,select,button")) input.disabled = false;
        if (uncertain) {
          for (const input of form.querySelectorAll("input,select,button")) input.disabled = true;
          submit.disabled = cancel.disabled = false;
          submit.textContent = "Retry Save";
        } else {frozenSave = null;}
      } finally {busy = false;}
    });
    dialog.showModal(); title.focus();
  });
  return root;
}
function element(tag, text) {const node = document.createElement(tag); node.textContent = text; return node;}
function label(text, control) {const node = element("label", `${text} `); control.setAttribute("aria-label", text); node.append(control); return node;}
