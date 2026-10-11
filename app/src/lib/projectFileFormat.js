const MAX_FILE_BYTES = 2_000_000;
const MAX_XML_BYTES = 256 * 1024;
const WMC_NAMESPACE = "http://www.opengis.net/context";

// Individual and account downloads share this inert saved-definition envelope.
export function savedProjectVersionFile(compositionId, retained) {
  if (typeof compositionId !== "string" || !Number.isSafeInteger(retained?.version) || retained.version < 1
    || !retained.definition || typeof retained.definition !== "object" || Array.isArray(retained.definition)) {
    throw new TypeError("Saved Project version is invalid");
  }
  return JSON.stringify({schemaVersion: "opengeo.project-version.1.0.0", resourceType: "project",
    projectId: compositionId, version: retained.version, definition: retained.definition,
    history: {createdAt: retained.createdAt, createdBy: retained.createdBy, changeMessage: retained.changeMessage},
    content: "saved-definition", dependenciesBundled: false, accessIncluded: false});
}

// A file's original IDs and history are descriptive, never authority or a save target.
export function readSavedProjectVersionFile(source) {
  if (identifyProjectFileFormat(source) !== "opengeo-managed") throw new TypeError("Choose a saved OpenGeo Studio Project snapshot.");
  const snapshot = JSON.parse(source, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Saved Project contains a non-finite number.");
    return value;
  });
  if (snapshot.schemaVersion !== "opengeo.project-version.1.0.0") throw new TypeError("This managed Project file is not a saved snapshot.");
  if (new TextEncoder().encode(JSON.stringify(snapshot.definition)).byteLength > 262_144) {
    throw new TypeError("Saved Project definition exceeds the 256 KiB create limit.");
  }
  return snapshot;
}

// File names are hints to the operating system; content chooses the importer.
export function identifyProjectFileFormat(source, {Parser = globalThis.DOMParser} = {}) {
  if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > MAX_FILE_BYTES) {
    throw new TypeError("Project file exceeds the 2 MB open limit.");
  }
  const content = source.trimStart();
  if (content.startsWith("{")) {
    let value;
    try { value = JSON.parse(content); } catch { throw new TypeError("Project JSON is invalid."); }
    if (!value || Array.isArray(value) || typeof value !== "object") throw new TypeError("Unsupported Project file.");
    if (value.schemaVersion === "opengeo.project-version.1.0.0" && value.resourceType === "project"
      && Number.isSafeInteger(value.version) && value.version > 0 && value.definition && !Array.isArray(value.definition)
      && typeof value.definition === "object" && value.content === "saved-definition"
      && value.dependenciesBundled === false && value.accessIncluded === false) return "opengeo-managed";
    if (value.persistence?.mode === "browser-only-demo") return "opengeo-browser";
    if (value.persistence?.provider || value.persistence?.mode) return "opengeo-managed";
    if (["0.1.0", "0.2.0"].includes(value.version) && Array.isArray(value.layers) && value.mapView) return "geolibre";
    throw new TypeError("Unsupported Project JSON. Choose a supported OpenGeo Studio or GeoLibre Project file.");
  }
  if (content.startsWith("<")) {
    if (new TextEncoder().encode(source).byteLength > MAX_XML_BYTES) throw new TypeError("Project XML exceeds the 256 KiB open limit.");
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new TypeError("Active XML is not supported in Project files.");
    if (typeof Parser !== "function") throw new TypeError("XML inspection is unavailable in this browser.");
    const document = new Parser().parseFromString(source, "application/xml");
    const root = document.documentElement;
    if (document.querySelector?.("parsererror") || root?.localName === "parsererror") throw new TypeError("Project XML is invalid.");
    if (root?.localName === "mapbook" && !root.namespaceURI) return "geomoose";
    if (root?.localName === "ViewContext" && root.namespaceURI === WMC_NAMESPACE) return "wmc";
    throw new TypeError("Unsupported Project XML. Choose a GeoMoose mapbook or OGC Web Map Context file.");
  }
  throw new TypeError("Unsupported Project file. Choose JSON or XML from a supported Project format.");
}
