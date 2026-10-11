// Browser-only review uses the same resource concepts as durable registration.
// Source facts remain separate from the user's edits; missing rights stay unknown.
export function browserLayerReviewForProject(context) {
  const project = context.project;
  const isCurrent = () => !context.disposed && context.shell.isConnected && context.project === project;
  return options => isCurrent() ? BrowserLayerRegistration({...options, isCurrent}) : null;
}

export function BrowserLayerRegistration({layer, geojson, source = {}, onAdd, isCurrent = () => true}) {
  const features = Array.isArray(geojson?.features) ? geojson.features : null;
  const dialog = document.createElement("dialog");
  dialog.className = "browser-layer-registration";
  const form = document.createElement("form");
  const text = (tag, value) => {const node = document.createElement(tag); node.textContent = value; return node;};
  const field = (name, value = "") => {
    const label = text("label", name), input = document.createElement("input");
    input.value = value ?? ""; input.setAttribute("aria-label", name); input.maxLength = 1000;
    label.append(input); form.append(label); return input;
  };
  form.append(text("h2", "Review Layer source"), text("p", "Review the source information before adding this Layer. Local files stay in your browser; remote Layers reference their provider. Nothing is uploaded."));
  const title = field("Layer title", layer.title); title.required = true; title.maxLength = 160;
  const curatedValue = name => Object.hasOwn(layer.metadata?.curated ?? {}, name)
    ? layer.metadata.curated[name] : source[name];
  const description = field("Description", curatedValue("description"));
  const license = field("License", curatedValue("license")); license.placeholder = "Unknown — not supplied by source";
  const attribution = field("Attribution", curatedValue("attribution"));
  const facts = document.createElement("dl");
  for (const [name, value] of Object.entries({Source: source.filename ?? source.url ?? "Catalog reference", Format: source.format ?? layer.sourceType, Features: features ? features.length : "Not inspected", Geometry: features ? [...new Set(features.map(f => f.geometry?.type).filter(Boolean))].join(", ") || "No supported geometry" : layer.geometryType ?? "Unknown", Coordinates: features ? "WGS 84 longitude/latitude (normalized)" : source.configuration?.crs ?? "Provider-defined / not established", Storage: "Browser draft · export to retain; demo resets daily"})) facts.append(text("dt", name), text("dd", String(value)));
  form.append(facts);
  const status = text("p", ""); status.setAttribute("role", "status");
  const add = text("button", "Add Layer to Project"); add.type = "submit";
  const cancel = text("button", "Cancel"); cancel.type = "button";
  const close = () => {dialog.close(); dialog.remove();};
  cancel.onclick = close;
  dialog.addEventListener("cancel", event => {event.preventDefault(); if (!cancel.disabled) close();});
  form.onsubmit = async event => {
    event.preventDefault(); if (add.disabled || !title.value.trim()) return;
    if (!isCurrent()) {
      status.textContent = "The Project has changed. Close this review and choose the Layer from the current Project's catalog.";
      add.disabled = true;
      return;
    }
    add.disabled = cancel.disabled = true;
    try {
      // Reusing a catalog Layer must not discard knowledge outside this small form.
      const prior = structuredClone(layer.metadata ?? {});
      const metadata = {
        ...prior,
        source: prior.source ?? structuredClone(source),
        normalized: {...prior.normalized, ...(features ? {featureCount: features.length, crs: "OGC:CRS84"} : {})},
        curated: {...prior.curated, title: title.value.trim(), description: description.value.trim() || null,
          license: license.value.trim() || null, attribution: attribution.value.trim() || null},
        inferred: prior.inferred ?? {}
      };
      await onAdd({...layer, title: title.value.trim(), metadata}, geojson); close();
    } catch {status.textContent = "The Layer could not be added. Your source and metadata are still here; try again."; add.disabled = cancel.disabled = false;}
  };
  form.append(status, add, cancel); dialog.append(form); document.body.append(dialog); dialog.showModal(); title.focus();
  return dialog;
}
