import {canonicalJson} from "./artifactCanonicalJson.js";

// Use the existing draft signature's precision and ignore navigation-only fields.
export function accountSaveSignature(definition) {
  const {updatedAt, updatedBy, activeLayerId, activeProcessingModelId, ...saved} = definition;
  return canonicalJson(JSON.parse(JSON.stringify(saved, (_key, value) =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : value)));
}

export function workbenchSaveState({mode, dirty, state, hasSavedCopy, version, temporary = false}) {
  const device = mode === "device", destination = device ? "this device"
    : mode === "fixture" ? "simulated Project" : "account Project";
  if (state === "saving") return {state: "saving", label: `Saving to ${destination}…`};
  if (state === "conflict") return {state: "conflict", label: "Save conflict · changes kept"};
  if (state === "error") return {state: "error", label: "Save failed · changes kept"};
  if (dirty || !hasSavedCopy) return {state: "unsaved", label: `Unsaved · ${destination}`};
  if (mode === "fixture") return {state: "simulated", label: `Simulated save · v${version ?? "?"}`};
  if (device) return {state: "saved", label: `Saved on this device · r${version}`};
  return {state: "saved", label: temporary
    ? `Account saved · v${version} · temporary data unsaved`
    : `Saved to account · v${version}`};
}
