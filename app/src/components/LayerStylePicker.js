import {resolveLayerStyle} from "../lib/layerStyleReference.js";

// Select a dependency, never copy a Style definition into a composition.
export function LayerStylePicker({adapter, layer, onApply, signal, isCurrent = () => true, onBusy = () => {}}) {
  const root = document.createElement("section");
  const heading = element("h3", "Use a saved Style");
  const status = element("p", "Choose a governed record, then an exact Style version. Applying changes this composition; save the Project to retain it.");
  status.setAttribute("role", "status");
  const records = element("div"), styles = element("div");
  let offset = 0, busy = false, disposed = false;
  root.dispose = () => {
    if (disposed) return;
    disposed = true;
    records.replaceChildren(); styles.replaceChildren();
    lock(true);
    signal?.removeEventListener("abort", root.dispose);
  };
  signal?.addEventListener("abort", root.dispose, {once: true});
  const load = button("Find Styles for this Layer", async () => {
    if (busy || disposed) return;
    lock(true);
    try {
      await current();
      const page = await adapter.listDatasetResources(layer.datasetId, {limit: 50, offset});
      await current();
      if (!Array.isArray(page) || page.some(record => record.datasetId !== layer.datasetId)) throw Error();
      for (const record of page) {
        records.append(button(`Styles in ${record.title}`, async () => {
          if (busy || disposed) return;
          lock(true); styles.replaceChildren();
          try {
            await current();
            const choices = await adapter.listResourceStyles(record.projectId, record.id);
            await current();
            if (!Array.isArray(choices) || choices.some(style => style.resourceId !== record.id)) throw Error();
            for (const style of choices) styles.append(choice(record, style));
            status.textContent = choices.length ? "Select a version to verify and apply. Unsupported Styles leave the current presentation unchanged." : "This record has no saved Styles.";
          } catch { if (await active()) status.textContent = "Styles could not load. Check access and retry."; }
          finally { if (!disposed) lock(false); }
        }));
      }
      offset += page.length;
      load.textContent = "Load more records";
      load.hidden = page.length < 50 || offset > 10_000;
      status.textContent = offset ? `${offset} accessible records found. Choose one to inspect its Styles.` : "No accessible governed records found for this Layer.";
    } catch { if (await active()) status.textContent = "Records could not load. Check access and retry."; }
    finally { if (!disposed) lock(false); }
  });
  root.append(heading, status, load, records, styles);
  if (signal?.aborted) root.dispose();
  return root;

  async function current() {
    if (disposed || signal?.aborted || !root.isConnected) throw new DOMException("Style selection is no longer current", "AbortError");
    if (!await isCurrent()) {
      status.textContent = "The selected account or Layer changed. Reopen this Layer to choose a Style.";
      root.dispose();
      throw new DOMException("Style selection is no longer current", "AbortError");
    }
    if (disposed || signal?.aborted || !root.isConnected) throw new DOMException("Style selection is no longer current", "AbortError");
  }
  async function active() {try {await current(); return true;} catch {return false;}}
  function lock(value) {
    busy = value;
    for (const control of root.querySelectorAll("button,input")) control.disabled = value;
    onBusy(value);
  }
  function choice(record, style) {
    const section = element("div");
    const label = element("label", `${style.title} · ${style.format} · version `);
    const version = document.createElement("input");
    version.type = "number"; version.min = "1"; version.step = "1";
    version.value = String(style.versionNumber);
    version.setAttribute("aria-label", `Version of ${style.title}`);
    label.append(version);
    const apply = button(`Apply ${style.title}`, async () => {
      if (busy || disposed) return;
      const number = Number(version.value);
      if (!Number.isSafeInteger(number) || number < 1) { status.textContent = "Enter a positive whole version number."; return; }
      lock(true);
      try {
        await current();
        const saved = await adapter.getResourceStyleVersion(record.projectId, record.id, style.id, number);
        await current();
        const reference = {projectId: record.projectId, resourceId: record.id, styleId: style.id,
          versionNumber: number, format: saved.format, checksumSha256: saved.checksumSha256};
        // Reuse this exact read; the resolver still checks identity, bytes and current resource binding.
        const resolved = await resolveLayerStyle({getResource: async (...args) => {
          await current();
          const resource = await adapter.getResource(...args);
          await current();
          return resource;
        },
          getResourceStyleVersion: async () => saved}, {...layer, styleReference: reference});
        await current();
        await onApply(reference, resolved);
        await current();
        status.textContent = `Applied ${saved.title}, version ${number}. Save the Project to retain this selection.`;
      } catch { if (await active()) status.textContent = "That version is unavailable or incompatible. The previous Style selection is unchanged."; }
      finally { if (!disposed) lock(false); }
    });
    section.append(label, apply);
    return section;
  }
}
function element(tag, text = "") { const value = document.createElement(tag); value.textContent = text; return value; }
function button(text, callback) { const value = element("button", text); value.type = "button"; value.className = "platform-button secondary"; value.addEventListener("click", callback); return value; }
