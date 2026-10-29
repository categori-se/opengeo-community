// The caller supplies import.meta.url from the Workbench module that is running.
// A current server manifest cannot establish which interface an open tab loaded.
export function loadedWorkbenchIdentity(moduleURL) {
  try {
    const url = new URL(moduleURL);
    const match = /\/WorkbenchView\.([a-f0-9]{8,64})\.js$/.exec(url.pathname);
    if (["https:", "http:"].includes(url.protocol) && match) {
      return {fingerprint: match[1], url: url.href};
    }
    return {fingerprint: null, url: null, label: "Development module; build fingerprint unavailable"};
  } catch {
    return {fingerprint: null, url: null, label: "Loaded interface fingerprint unavailable"};
  }
}

export function WorkbenchHelp({publicDemo = false, demoSurface = false, landingMode = false,
  persistenceMode = null, interfaceModuleURL} = {}) {
  const demo = demoSurface, fixture = persistenceMode === "fixture";
  const account = !publicDemo && !demo && !landingMode && persistenceMode === "api";
  const panel = document.createElement("div");panel.className = "gis-panel-body";
  panel.append(text("h3", "OpenGeo Studio workbench"), text("p", demo
    ? "The public Demo uses the same browser-native GIS tools with public data and browser-only drafts. Studio adds authorized account Projects, governed Layers and managed storage."
    : "OpenGeo Studio is a geospatial workspace for inspecting Layers, composing Projects, analyzing data and publishing results."));
  const identity = loadedWorkbenchIdentity(interfaceModuleURL);
  panel.append(values({
    "Interface": demo ? "Public Demo" : fixture ? "OpenGeo Studio · local fixture" : "OpenGeo Studio",
    "Storage in this view": demo ? "Browser-only Demo draft; resets under the Demo policy"
      : fixture ? "Local fixture data; no managed account storage"
      : account ? "Account Project; server saves enforce account and role permissions"
      : "Local browser draft; account storage requires signing in and saving an account Project",
    "Loaded interface fingerprint": identity.fingerprint ?? identity.label
  }));
  if (identity.url) {
    const code = text("code", identity.url);code.style.overflowWrap = "anywhere";
    panel.append(code, text("p", "This URL fingerprints the interface module loaded in this tab and its imported module graph. API and deployment versions are separate."));
  }
  panel.append(values({
    "Add data": "Add Data menu or layer panel Add button",
    "Identify": "Toggle Identify, then click a feature",
    "Measure": "Measure, click along a path, then save it with an optional terrain profile",
    "Navigate globe": "Drag to pan; right-drag or Control-drag to orbit; wheel to zoom; two-finger pinch/rotate/pitch on touch; arrow and Shift+arrow keyboard controls",
    "Save": landingMode ? "Save in browser keeps this draft on this device; it does not save to your account" : demo
      ? "Browser-only draft; resets daily" : "Save updates the selected map; Save As creates a separate map",
    "Persist": demo ? "Open authenticated Studio to save governed team work"
      : fixture ? "Fixture records are local examples; account storage is unavailable"
      : account ? "Server writes enforce tenant and role permissions before writing project and object records"
      : "A local draft stays on this device until deliberately saved to an authorized account Project"
  }));
  const guides = document.createElement("section");guides.className = "gis-task-help";
  guides.append(text("h3", "Task guides and recovery"));
  for (const [title, path] of [
    ["Open, save and reopen a Project", "docs/community-workflow.md"],
    ["Review sources and retain analytical results", "docs/community-baseline.md"],
    ["Synthetic E&S screening example and recovery notes", "examples/esia-screening/README.md"]
  ]) {
    const link = text("a", title);link.href = `https://github.com/categori-se/opengeo-community/blob/main/${path}`;
    link.target = "_blank";link.rel = "noopener noreferrer";guides.append(link);
  }
  for (const message of [
    "Map graphics failed: keep your Layers and edits, use the map's Retry control, and continue Catalog or attribute work where available.",
    "Layer addition reported an error: check the Layer list before adding again; a display failure may follow a successful addition.",
    "Save conflict: export a backup before reloading, then compare the saved version. Resume an interrupted registration instead of uploading another copy.",
    "Print unavailable: capture every frame when the map is ready, inspect the output requirements, or return to the map while keeping your layout."
  ]) guides.append(text("p", message));
  panel.append(guides);return panel;
}

function text(tag, value) {
  const element = document.createElement(tag);element.textContent = value;return element;
}

function values(entries) {
  const list = document.createElement("dl");list.className = "gis-key-values";
  for (const [key, value] of Object.entries(entries)) list.append(text("dt", key), text("dd", value));
  return list;
}
