import {resolveLayerStyle} from "../lib/layerStyleReference.js";

// Select a dependency, never copy a Style definition into a composition.
export function LayerStylePicker({adapter, layer, onApply}) {
  const root = document.createElement("section");
  const heading = element("h3", "Use a saved Style");
  const status = element("p", "Choose a governed record, then an exact Style version. Applying changes this composition; save the Project to retain it.");
  status.setAttribute("role", "status");
  const records = element("div"), styles = element("div");
  let offset = 0, busy = false;
  const load = button("Find Styles for this Layer", async () => {
    if (busy) return;
    lock(true);
    try {
      const page = await adapter.listDatasetResources(layer.datasetId, {limit: 50, offset});
      if (!Array.isArray(page) || page.some(record => record.datasetId !== layer.datasetId)) throw Error();
      for (const record of page) {
        records.append(button(`Styles in ${record.title}`, async () => {
          if (busy) return;
          lock(true); styles.replaceChildren();
          try {
            const choices = await adapter.listResourceStyles(record.projectId, record.id);
            if (!Array.isArray(choices) || choices.some(style => style.resourceId !== record.id)) throw Error();
            for (const style of choices) styles.append(choice(record, style));
            status.textContent = choices.length ? "Select a version to verify and apply. Unsupported Styles leave the current presentation unchanged." : "This record has no saved Styles.";
          } catch { status.textContent = "Styles could not load. Check access and retry."; }
          finally { lock(false); }
        }));
      }
      offset += page.length;
      load.textContent = "Load more records";
      load.hidden = page.length < 50 || offset > 10_000;
      status.textContent = offset ? `${offset} accessible records found. Choose one to inspect its Styles.` : "No accessible governed records found for this Layer.";
    } catch { status.textContent = "Records could not load. Check access and retry."; }
    finally { lock(false); }
  });
  root.append(heading, status, load, records, styles);
  return root;

  function lock(value) {
    busy = value;
    for (const control of root.querySelectorAll("button,input")) control.disabled = value;
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
      if (busy) return;
      const number = Number(version.value);
      if (!Number.isSafeInteger(number) || number < 1) { status.textContent = "Enter a positive whole version number."; return; }
      lock(true);
      try {
        const saved = await adapter.getResourceStyleVersion(record.projectId, record.id, style.id, number);
        const reference = {projectId: record.projectId, resourceId: record.id, styleId: style.id,
          versionNumber: number, format: saved.format, checksumSha256: saved.checksumSha256};
        // Reuse this exact read; the resolver still checks identity, bytes and current resource binding.
        const resolved = await resolveLayerStyle({getResource: (...args) => adapter.getResource(...args),
          getResourceStyleVersion: async () => saved}, {...layer, styleReference: reference});
        if (!root.isConnected) return;
        await onApply(reference, resolved);
        status.textContent = `Applied ${saved.title}, version ${number}. Save the Project to retain this selection.`;
      } catch { status.textContent = "That version is unavailable or incompatible. The previous Style selection is unchanged."; }
      finally { lock(false); }
    });
    section.append(label, apply);
    return section;
  }
}
function element(tag, text = "") { const value = document.createElement(tag); value.textContent = text; return value; }
function button(text, callback) { const value = element("button", text); value.type = "button"; value.className = "platform-button secondary"; value.addEventListener("click", callback); return value; }
