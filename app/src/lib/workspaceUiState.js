const PANELS = new Set([
  "add", "attributes", "basemap", "catalog", "controls", "help", "processing",
  "flight", "history", "identify", "measure", "query", "settings", "sql", "style", "temporary", "tour"
]);
export function readWorkspaceUiState(projectId, storage = safeSessionStorage()) {
  if (!validProjectId(projectId) || !storage) return null;
  try {
    const value = JSON.parse(storage.getItem(workspaceUiStateKey(projectId)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      activePanel: PANELS.has(value.activePanel) ? value.activePanel : "style",
      // Places and Browser were retired as separate destinations. Retain the
      // field in the stored shape so older sessions upgrade without breaking.
      leftPanelMode: "layers",
      leftOpen: value.leftOpen !== false,
      ...(typeof value.quickToolsOpen === "boolean" ? {quickToolsOpen: value.quickToolsOpen} : {}),
      rightOpen: value.rightOpen === true,
      managementOpen: value.managementOpen === true
    };
  } catch {
    return null;
  }
}

export function writeWorkspaceUiState(projectId, changes, storage = safeSessionStorage()) {
  if (!validProjectId(projectId) || !storage || !changes || typeof changes !== "object") return;
  const current = readWorkspaceUiState(projectId, storage) ?? {
    activePanel: "style",
    leftPanelMode: "layers",
    leftOpen: true,
    rightOpen: false,
    managementOpen: false
  };
  const next = {
    activePanel: PANELS.has(changes.activePanel) ? changes.activePanel : current.activePanel,
    leftPanelMode: "layers",
    leftOpen: typeof changes.leftOpen === "boolean" ? changes.leftOpen : current.leftOpen,
    ...(typeof changes.quickToolsOpen === "boolean" ? {quickToolsOpen: changes.quickToolsOpen}
      : typeof current.quickToolsOpen === "boolean" ? {quickToolsOpen: current.quickToolsOpen} : {}),
    rightOpen: typeof changes.rightOpen === "boolean" ? changes.rightOpen : current.rightOpen,
    managementOpen: typeof changes.managementOpen === "boolean"
      ? changes.managementOpen
      : current.managementOpen
  };
  try {
    storage.setItem(workspaceUiStateKey(projectId), JSON.stringify(next));
  } catch {
    // UI preferences never block authoritative project work.
  }
}

export function workspaceUiStateKey(projectId) {
  if (!validProjectId(projectId)) throw new TypeError("project id is required");
  return `opengeo.workspace-ui.${projectId}`;
}

function validProjectId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
