/** Choose a saved map, then use Studio's authorized, read-only export review. */
export function openPublicationMapPicker({adapter, projects, currentProjectId, onInsert,
  loadWorkspace = () => import("./ProjectWorkspacePage.js")}) {
  const dialog = document.createElement("dialog"); dialog.className = "publication-map-picker";
  dialog.setAttribute("aria-label", "Choose a Studio map");
  const heading = document.createElement("h2"); heading.textContent = "Insert a map";
  const note = document.createElement("p");
  note.textContent = "Choose a saved map. Review its layers before adding the map to your current file.";
  const project = document.createElement("select"); project.setAttribute("aria-label", "Workspace");
  for (const item of [...new Map((projects ?? []).map(item => [item.id, item])).values()]
    .sort((a, b) => String(a.name ?? a.title).localeCompare(String(b.name ?? b.title)))) {
    const option = document.createElement("option"); option.value = item.id;
    option.textContent = item.name ?? item.title ?? item.id; project.append(option);
  }
  if ([...project.options].some(item => item.value === currentProjectId)) project.value = currentProjectId;
  const browse = button("Browse other workspaces");
  browse.hidden = typeof adapter.listProjects !== "function";
  const maps = document.createElement("select"); maps.setAttribute("aria-label", "Saved map"); maps.disabled = true;
  const retry = button("Try again"), more = button("More maps"), preview = button("Preview"), insert = button("Insert map"), close = button("Close");
  insert.className = "platform-button";
  retry.hidden = more.hidden = true;
  preview.disabled = insert.disabled = true;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const host = document.createElement("div"); host.className = "publication-map-picker-view"; host.hidden = true;
  let generation = 0, offset = 0, workspace = null, projectOffset = 0, projectRequest = null;
  let mapRequest = null, observer = null, opening = false, pendingInsert = false, reviewOpened = false;
  const updateActions = () => {
    insert.disabled = preview.disabled = !maps.value || Boolean(mapRequest) || opening;
    more.disabled = Boolean(mapRequest) || opening;
  };
  const cancel = () => {
    ++generation; mapRequest?.abort(); mapRequest = null;
    observer?.disconnect(); observer = null;
    workspace?.removeEventListener("publication-map:readiness", reviewWhenReady);
    workspace?.dispose?.(); workspace = null;
    opening = pendingInsert = reviewOpened = false;
    host.replaceChildren(); host.hidden = true; dialog.classList.remove("is-previewing");
    updateActions();
  };
  browse.onclick = async () => {
    if (projectRequest) return;
    const controller = new AbortController(); projectRequest = controller; browse.disabled = true;
    status.textContent = "Loading accessible workspaces…";
    try {
      let context = null;
      if (adapter.tokenProvider && adapter.organizationProvider) {
        const tokenProvider = adapter.tokenProvider, organizationProvider = adapter.organizationProvider;
        context = Object.freeze({tokenProvider, organizationProvider, baseUrl: adapter.baseUrl,
          token: await tokenProvider.call(adapter), organization: String(await organizationProvider.call(adapter)).toLowerCase()});
        await adapter.assertCollectionContext(context);
      }
      const records = await adapter.listProjects({limit: 100, offset: projectOffset, signal: controller.signal, ...(context ? {context} : {})});
      if (context) await adapter.assertCollectionContext(context);
      if (!dialog.isConnected || controller.signal.aborted) return;
      projectOffset += records.length;
      const known = new Set([...project.options].map(item => item.value));
      const hadWorkspace = Boolean(project.value);
      for (const item of records) if (!known.has(item.id)) {
        const option = document.createElement("option"); option.value = item.id;
        option.textContent = item.name ?? item.title ?? item.id; project.append(option); known.add(item.id);
      }
      browse.hidden = records.length < 100; browse.textContent = "More workspaces";
      if (!hadWorkspace && project.value) await list(false);
      else if (!mapRequest && !opening) status.textContent = maps.value ? "Choose a saved map, then Insert map." : "Choose a workspace with saved maps.";
    } catch (error) {
      if (dialog.isConnected && !controller.signal.aborted) status.textContent = "Workspaces could not be loaded. Try Browse other workspaces again.";
    } finally {if (projectRequest === controller) {projectRequest = null; browse.disabled = false;}}
  };
  project.onchange = () => {cancel(); return list(false);};
  maps.onchange = () => {cancel(); status.textContent = "Choose Insert map to review its layers, or Preview to inspect it.";};
  async function list(append) {
    cancel();
    const request = generation, controller = new AbortController();
    if (!append) {offset = 0; maps.replaceChildren(); more.hidden = true;}
    retry.hidden = true;
    if (!project.value) {maps.disabled = true; updateActions(); status.textContent = "No workspace is available. Browse other workspaces to choose one."; return;}
    mapRequest = controller; maps.disabled = true; updateActions();
    status.textContent = "Loading saved maps…";
    try {
      const records = await adapter.listMaps(project.value, {limit: 100, offset, signal: controller.signal});
      if (!dialog.isConnected || controller.signal.aborted || request !== generation) return;
      offset += records.length;
      const known = new Set([...maps.options].map(item => item.value));
      for (const map of records) if (!known.has(map.id)) {
        const option = document.createElement("option"); option.value = map.id;
        option.textContent = map.name ?? map.title ?? map.id; maps.append(option); known.add(map.id);
      }
      maps.disabled = maps.options.length === 0;
      more.hidden = records.length < 100;
      status.textContent = maps.options.length ? "Choose a saved map, then Insert map." : "This workspace has no saved maps. Choose another workspace.";
    } catch (error) {
      if (dialog.isConnected && request === generation && !controller.signal.aborted) {
        retry.hidden = false;
        status.textContent = "Saved maps could not be loaded. Try again or choose another workspace.";
      }
    } finally {if (request === generation) {mapRequest = null; maps.disabled = maps.options.length === 0; updateActions();}}
  }
  retry.onclick = () => list(maps.options.length > 0); more.onclick = () => list(true);
  const reviewWhenReady = () => {
    if (!workspace || !dialog.isConnected) return;
    const ready = workspace.isPublicationMapExportReady?.() === true;
    if (!ready) return;
    opening = false; updateActions();
    if (!pendingInsert || reviewOpened) return;
    // Mark first: opening the review changes the DOM observed below.
    reviewOpened = true; pendingInsert = false;
    if (workspace.openPublicationMapExport?.() !== true) {
      reviewOpened = false;
      status.textContent = "The map is not ready to insert. Check its preview, then try Insert map again.";
    } else status.textContent = "Review the layers and sharing terms to insert this map.";
  };
  async function open(intent) {
    if (insert.disabled) return;
    pendingInsert = intent === "insert";
    reviewOpened = false;
    if (workspace) {reviewWhenReady(); return;}
    const request = ++generation, projectId = project.value, mapId = maps.value;
    opening = true; updateActions();
    status.textContent = intent === "insert" ? "Loading the map for layer review…" : "Loading map preview…";
    host.hidden = false; dialog.classList.add("is-previewing");
    try {
      const {ProjectWorkspacePage} = await loadWorkspace();
      if (!dialog.isConnected || request !== generation) return;
      workspace = ProjectWorkspacePage({adapter, projectId, mapId,
        isCancelled: () => !dialog.isConnected || request !== generation,
        onPublicationMapExport: async (html, title, manifest) => {
          if (!dialog.isConnected || request !== generation) throw Error("The selected map changed. Review it again.");
          await onInsert({blob: new Blob([html], {type: "text/html"}), name: `${title}.html`, manifest});
          dialog.close();
        }});
      workspace.addEventListener("publication-map:readiness", reviewWhenReady);
      observer = new document.defaultView.MutationObserver(reviewWhenReady);
      observer.observe(workspace, {childList: true, subtree: true, attributes: true});
      host.append(workspace); reviewWhenReady();
    } catch (error) {
      if (dialog.isConnected && request === generation) {
        opening = pendingInsert = false; updateActions();
        status.textContent = "The map could not be opened. Choose another map or try Insert map again.";
      }
    }
  }
  preview.onclick = () => open("preview"); insert.onclick = () => open("insert");
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => {projectRequest?.abort(); cancel(); dialog.remove();}, {once: true});
  const controls = document.createElement("div"); controls.className = "publication-map-picker-controls";
  controls.append(field("Workspace", project), browse, field("Saved map", maps), more, retry, preview, insert, close);
  dialog.append(heading, note, controls, status, host); document.body.append(dialog); dialog.showModal();
  void list(false);
  return dialog;
}

function field(title, control) {
  const label = document.createElement("label"); label.className = "publication-map-picker-field";
  const text = document.createElement("span"); text.textContent = title; label.append(text, control); return label;
}
function button(label) {const item = document.createElement("button"); item.type = "button"; item.className = "platform-button secondary"; item.textContent = label; return item;}
