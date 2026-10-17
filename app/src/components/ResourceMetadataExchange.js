const FORMATS = Object.freeze({
  dcat_3: ["DCAT 3", "jsonld", "application/ld+json"],
  stac_1_1: ["STAC 1.1", "json", "application/json"],
  ogc_records_1_0: ["OGC record 1.0", "geojson", "application/geo+json"],
  iso_19115_3: ["ISO 19115-3", "xml", "application/xml"],
  schema_org_dataset: ["schema.org Dataset 30", "jsonld", "application/ld+json"],
  datacite_4_7: ["DataCite 4.7", "json", "application/vnd.api+json"],
  datacite_4_7_xml: ["DataCite 4.7 XML", "xml", "application/xml"],
  geodcat_ap_3_1: ["GeoDCAT-AP 3.1", "jsonld", "application/ld+json"]
});
const MAPPED = new Set(["mapped", "mapped_with_defaults", "mapped_with_explicit_losses", "mapped_with_preserved_extensions"]);
const STATUS_LABELS = Object.freeze({
  mapped: "Ready",
  mapped_with_defaults: "Ready with default values",
  mapped_with_explicit_losses: "Ready with omitted fields",
  mapped_with_preserved_extensions: "Ready with preserved extensions",
  not_applicable: "Format does not apply to this resource",
  not_exportable_missing_required_metadata: "Required metadata is missing"
});

// Export projections stay inert. Documents and conversion reports are separate files.
export function ResourceMetadataExchange({adapter, projectId, resource, isCurrent = () => true, signal}) {
  const root = document.createElement("section");
  root.className = "resource-metadata-exchange";
  root.setAttribute("aria-label", "Metadata export");
  const format = document.createElement("select");
  for (const [key, [label]] of Object.entries(FORMATS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    format.append(option);
  }
  const language = document.createElement("input");
  language.value = resource.language ?? "en";
  language.maxLength = 40;
  language.pattern = "[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*";
  language.required = true;
  const languageLabel = label("OGC record language", language);
  languageLabel.hidden = true;
  const prepare = button("Prepare metadata export");
  prepare.disabled = typeof adapter.exportResourceMetadata !== "function";
  const feedback = document.createElement("p");
  feedback.className = "project-resource-feedback";
  feedback.setAttribute("role", "status");
  feedback.textContent = "Export saved server metadata. Unsaved edits are not included; exporting does not publish the resource.";
  const result = document.createElement("div");
  let disposed = false, busy = false;
  root.dispose = () => {
    disposed = true;
    result.replaceChildren();
    prepare.disabled = format.disabled = language.disabled = true;
    signal?.removeEventListener("abort", root.dispose);
  };
  signal?.addEventListener("abort", root.dispose, {once: true});
  if (signal?.aborted) root.dispose();
  const current = async () => {
    if (disposed) return false;
    try {if (await isCurrent() && !disposed && !signal?.aborted) return true;} catch {}
    root.dispose();
    return false;
  };
  const reset = () => {
    result.replaceChildren();
    feedback.textContent = "Prepare the selected format to inspect and download it.";
    languageLabel.hidden = format.value !== "ogc_records_1_0";
  };
  format.addEventListener("change", reset);
  language.addEventListener("input", reset);
  prepare.addEventListener("click", async () => {
    if (disposed || busy) return;
    const target = format.value;
    if (target === "ogc_records_1_0" && !language.reportValidity()) return;
    busy = true;
    prepare.disabled = true;
    format.disabled = true;
    language.disabled = true;
    result.replaceChildren();
    feedback.textContent = "Preparing metadata and its conversion report…";
    try {
      if (!await current()) return;
      const exported = await adapter.exportResourceMetadata(projectId, resource.id, target,
        target === "ogc_records_1_0" ? {language: language.value.trim().toLowerCase()} : undefined);
      if (!await current()) return;
      const artifacts = await metadataExportArtifacts({exported, target, projectId, resourceId: resource.id});
      if (!await current()) return;
      feedback.textContent = `${FORMATS[target][0]} · ${exported.targetVersion} · ${STATUS_LABELS[exported.status]}. ${artifacts.document
        ? "Review the conversion report for defaults, omissions and validation limits."
        : "No metadata document is available; review the report for missing fields or an unsupported resource type."}`;
      if (artifacts.document) {
        result.append(downloadButton("Download metadata", artifacts.document, feedback, current),
          preview("Metadata document", artifacts.document.body));
      }
      result.append(downloadButton("Download conversion report", artifacts.report, feedback, current),
        preview("Conversion report", artifacts.report.body));
    } catch {
      if (await current()) feedback.textContent = "Metadata export could not be prepared. Nothing was downloaded or changed; try again.";
    } finally {
      busy = false;
      if (!disposed) prepare.disabled = format.disabled = language.disabled = false;
    }
  });
  root.append(label("Metadata format", format), languageLabel, prepare, feedback, result);
  return root;
}

export async function metadataExportArtifacts({exported, target, projectId, resourceId}) {
  const format = Object.hasOwn(FORMATS, target) && FORMATS[target];
  if (!format || exported?.target !== target || !record(exported.report)
    || typeof exported.status !== "string" || typeof exported.targetVersion !== "string"
    || typeof resourceId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(resourceId)
    || typeof projectId !== "string") {
    throw new Error("invalid_metadata_export");
  }
  const basename = `${resourceId}-${target.replaceAll("_", "-")}`;
  let document = null;
  if (MAPPED.has(exported.status)) {
    const xml = format[1] === "xml";
    if (xml ? typeof exported.documentText !== "string" || exported.document != null
      : !record(exported.document) || exported.documentText != null) {
      throw new Error("invalid_metadata_document");
    }
    const body = xml ? exported.documentText : JSON.stringify(exported.document, null, 2);
    const bytes = new TextEncoder().encode(body);
    if (!bytes.length || bytes.length > 262_144) throw new Error("metadata_document_too_large");
    const checksumSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    document = {body, filename: `${basename}.${format[1]}`, mediaType: `${format[2]};charset=utf-8`, checksumSha256};
  } else if (!["not_applicable", "not_exportable_missing_required_metadata"].includes(exported.status)
    || exported.document != null || exported.documentText != null) {
    throw new Error("invalid_metadata_export_status");
  }
  const reportBody = JSON.stringify({
    projectId, resourceId, target, targetVersion: exported.targetVersion, status: exported.status,
    document: document ? {filename: document.filename, mediaType: document.mediaType, checksumSha256: document.checksumSha256} : null,
    source: "Server metadata at export time; no immutable resource revision is asserted by this endpoint.",
    report: exported.report
  }, null, 2);
  if (new TextEncoder().encode(reportBody).length > 65_536) throw new Error("metadata_report_too_large");
  return {document, report: {body: reportBody, filename: `${basename}-report.json`, mediaType: "application/json;charset=utf-8"}};
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function label(caption, control) {
  const wrapper = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = caption;
  control.setAttribute("aria-label", caption);
  wrapper.append(text, control);
  return wrapper;
}
function button(caption) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "platform-button secondary";
  control.textContent = caption;
  return control;
}
function preview(caption, body) {
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = caption;
  const source = document.createElement("pre");
  source.className = "project-resource-metadata-export";
  source.tabIndex = 0;
  source.setAttribute("aria-label", caption);
  source.textContent = body;
  disclosure.append(summary, source);
  return disclosure;
}
function downloadButton(caption, artifact, feedback, current) {
  const control = button(caption);
  control.addEventListener("click", async () => {
    if (!await current()) return;
    let url;
    let anchor;
    try {
      url = URL.createObjectURL(new Blob([artifact.body], {type: artifact.mediaType}));
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      document.body.append(anchor);
      anchor.click();
    } catch {
      feedback.textContent = "The download could not be started. The prepared metadata and report remain available; try again.";
    } finally {
      anchor?.remove();
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
  return control;
}
