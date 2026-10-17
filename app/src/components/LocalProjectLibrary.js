import {LocalProjectStore, LOCAL_PROJECT_LIMITS} from "../lib/localProjectStore.js";

export function localProjectHref(id) {
  const url = new URL(globalThis.location.href);
  for (const key of ["view", "layer", "publication"]) url.searchParams.delete(key);
  url.searchParams.set("localProject", id);
  return `${url.pathname}${url.search}`;
}

export function LocalProjectLibrary({store = new LocalProjectStore(), beforeOpen = () => true, onClose = () => {}} = {}) {
  const root = document.createElement("dialog");root.className = "browser-print-studio local-project-library";
  root.setAttribute("aria-label", "Projects on this device");
  const heading = node("h2", "Projects on this device"), status = node("p", "Loading saved Projects…"), list = node("div"), importReview = node("div");
  status.setAttribute("role", "status");
  let disposed = false, busy = false;
  const close = () => {if (busy) return;disposed = true;root.close?.();root.remove();onClose();};
  const closeButton = button("Back to map", close);
  const file = node("input");file.type = "file";file.accept = ".zip,application/zip";file.setAttribute("aria-label", "Import Project backup");
  root.append(closeButton, heading, node("p", "These Projects stay on this browser and device. They survive sample resets. Download a backup before clearing browser data or moving to another device."), status, list,
    node("h3", "Restore a backup"), file, importReview);
  root.dispose = () => {disposed = true;root.close?.();root.remove();};
  root.addEventListener("cancel", event => {event.preventDefault();close();});
  const run = async action => {
    if (busy || disposed) return;busy = true;
    for (const control of root.querySelectorAll("button,input")) control.disabled = true;
    try {await action();}
    catch (error) {if (!disposed) status.textContent = error.message;}
    finally {busy = false;if (!disposed) for (const control of root.querySelectorAll("button,input")) control.disabled = false;}
  };
  async function refresh() {
    const saved = await store.list();if (disposed) return;
    list.replaceChildren();
    status.textContent = `${saved.projects.length} of ${LOCAL_PROJECT_LIMITS.projects} Projects · ${formatBytes(saved.bytes)} of saved data and definitions · ${saved.assets} shared data assets.`;
    for (const record of saved.projects) {
      const card = node("article");card.className = "local-project-card";
      const open = node("a", "Open Project");open.href = localProjectHref(record.id);
      open.onclick = event => {if (!beforeOpen()) {event.preventDefault();status.textContent = "Save or export the current map before opening another Project.";}};
      card.append(node("h3", record.title), node("small", `Revision ${record.revision} · ${new Date(record.updatedAt).toLocaleString()}`), open,
        button("Download backup", () => run(async () => {
          const blob = await store.backup(record.id);if (disposed) return;
          const link = node("a");link.href = URL.createObjectURL(blob);link.download = `${record.title.replace(/[^a-z0-9]+/gi, "-")}.opengeo-project.zip`;
          link.click();setTimeout(() => URL.revokeObjectURL(link.href), 1000);
          status.textContent = "Project backup prepared with local data, source metadata, styling and saved layouts. Live service dependencies remain references.";
        })), button("Remove…", () => {
          const confirmation = node("div");confirmation.append(node("p", `Remove “${record.title}” from this device? Download its backup first if you need to keep it.`),
            button("Keep Project", () => confirmation.remove()), button("Remove saved Project", () => run(async () => {await store.remove(record.id, record.revision);await refresh();})));
          card.append(confirmation);
        }));list.append(card);
    }
  }
  file.onchange = () => run(async () => {
    const selected = file.files?.[0];if (!selected) return;
    if (selected.size > LOCAL_PROJECT_LIMITS.projectBytes) throw Error("Choose a Project backup ZIP up to 32 MiB.");
    const reviewed = await store.inspectBackup(new Uint8Array(await selected.arrayBuffer()));if (disposed) return;
    importReview.replaceChildren(node("p", `${reviewed.title} · ${reviewed.definition.layers.length} Layers. Restore as a new personal Project; existing Projects stay unchanged.`),
      button("Save imported Project", () => run(async () => {
        await store.save(reviewed);if (disposed) return;importReview.replaceChildren();file.value = "";await refresh();
      })));
  });
  const persist = button("Keep device storage", () => run(async () => {
    const granted = await globalThis.navigator?.storage?.persist?.();
    if (!disposed) status.textContent = granted ? "The browser granted persistent storage. Keep a downloaded backup; browser data can still be cleared." : "The browser did not grant persistent storage. Your Projects remain saved; keep a downloaded backup.";
  }));
  root.append(persist);
  queueMicrotask(() => void run(async () => {
    await refresh();
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!disposed && estimate?.quota) root.append(node("small", `Browser origin storage: ${formatBytes(estimate.usage ?? 0)} used of approximately ${formatBytes(estimate.quota)} available to this site, including cached software.`));
  }));
  return root;
}

function node(tag, text = "") {const element = document.createElement(tag);element.textContent = text;return element;}
function button(label, action) {const element = node("button", label);element.type = "button";element.className = "print-button secondary";element.onclick = action;return element;}
function formatBytes(bytes) {return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;}
