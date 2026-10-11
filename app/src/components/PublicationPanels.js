/** Mount each workspace surface once. Switching views must not discard drafts
 * or start background build/status requests for unopened surfaces. */
export function PublicationPanels({label = "Publication workspace", panels, initial = panels[0]?.id, onSelect}) {
  const root = document.createElement("section");
  root.className = "publication-panels";
  const tabs = document.createElement("div");
  tabs.className = "publication-panel-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", label);
  const prefix = `publication-${globalThis.crypto.randomUUID()}`;
  const surfaces = new Map();
  const entries = panels.map(spec => {
    const tab = document.createElement("button");
    tab.type = "button"; tab.textContent = spec.label;
    tab.id = `${prefix}-${spec.id}-tab`;
    tab.setAttribute("role", "tab");
    const key = spec.surface === undefined ? `panel:${spec.id}` : `surface:${spec.surface}`;
    let surface = surfaces.get(key);
    if (!surface) {
      const panel = document.createElement("section");
      panel.id = `${prefix}-${spec.id}`;
      panel.dataset.publicationPanel = spec.id;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      surface = {panel, mounted: false};
      surfaces.set(key, surface);
    }
    tab.setAttribute("aria-controls", surface.panel.id);
    return {spec, tab, surface};
  });
  const select = (id, focus = false) => {
    const chosen = entries.find(entry => entry.spec.id === id) ?? entries[0];
    if (!chosen) return;
    for (const entry of entries) {
      const active = entry === chosen;
      entry.tab.setAttribute("aria-selected", String(active));
      entry.tab.tabIndex = active ? 0 : -1;
    }
    for (const surface of surfaces.values()) surface.panel.hidden = surface !== chosen.surface;
    chosen.surface.panel.setAttribute("aria-labelledby", chosen.tab.id);
    if (!chosen.surface.mounted) {
      chosen.surface.panel.append(chosen.spec.render());
      chosen.surface.mounted = true;
    }
    onSelect?.(chosen.spec.id);
    if (focus) chosen.tab.focus();
  };
  entries.forEach((entry, index) => {
    entry.tab.addEventListener("click", () => select(entry.spec.id));
    entry.tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % entries.length
        : event.key === "ArrowLeft" ? (index - 1 + entries.length) % entries.length
        : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); select(entries[next].spec.id, true);
    });
    tabs.append(entry.tab);
  });
  root.append(tabs, ...[...surfaces.values()].map(surface => surface.panel));
  root.selectPanel = select;
  select(initial);
  return root;
}
