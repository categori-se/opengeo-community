export const WORKSPACE_MODE_SCHEMA_VERSION = "opengeo.workspace-mode.1";

const preferenceKeys = ["schemaVersion", "mode", "view", "basemapId", "backgroundExportAllowed"];
const viewKeys = ["center", "zoom", "bearing", "pitch"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const bounded = (value, minimum, maximum) => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

function validPreference(value) {
  if (!closed(value, preferenceKeys) || value.schemaVersion !== WORKSPACE_MODE_SCHEMA_VERSION
    || !["openlayers-canvas", "data-workspace"].includes(value.mode)
    || !["blank", "esri-public-imagery"].includes(value.basemapId)
    || typeof value.backgroundExportAllowed !== "boolean" || !closed(value.view, viewKeys)) return false;
  const {center, zoom, bearing, pitch} = value.view;
  return Array.isArray(center) && center.length === 2 && Object.keys(center).length === 2
    && bounded(center[0], -180, 180) && bounded(center[1], -85.051129, 85.051129)
    && bounded(zoom, -2, 24) && bounded(bearing, -360, 360) && pitch === 0;
}

// A workspace mode is separate from the canonical GL camera and engine choice.
// Reading an unknown version or malformed preference never repairs its bytes.
export function readWorkspaceMode(project) {
  const preference = project?.extensions?.opengeoWorkspaceMode;
  return validPreference(preference) ? structuredClone(preference) : null;
}

// Call only after a deliberate mode/view/background change. Preserve every other
// extension, including identities and the original full-graphics preference.
export function writeWorkspaceMode(extensions, preference) {
  if (extensions !== undefined && !object(extensions)) throw Error("map_extensions_invalid");
  if (preference !== null && !validPreference(preference)) throw Error("workspace_mode_preference_invalid");
  const result = structuredClone(extensions ?? {});
  if (preference === null) delete result.opengeoWorkspaceMode;
  else result.opengeoWorkspaceMode = structuredClone(preference);
  return result;
}
