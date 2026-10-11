// Read stored metadata only. Provider observations are not current data versions.
export const ARCGIS_METADATA_PROPERTY = "https://opengeo.tools/ns/arcgisLayerMetadata";
export const ARCHIVE_CAPTURE_PROPERTY = "https://opengeo.tools/ns/archiveCapture";

export function recordedLayerMetadata(knowledge) {
  const document = knowledge?.document;
  const assertions = document?.metadata?.normalized ?? [];
  const observation = [...assertions].reverse().find(item => item.subject === "resource" && item.property === ARCGIS_METADATA_PROPERTY);
  const capture = [...assertions].reverse().find(item => item.subject === "resource" && item.property === ARCHIVE_CAPTURE_PROPERTY)?.value;
  if (observation?.value && typeof observation.value === "object") return {metadata: observation.value, capture, evidence: observation.evidence};
  return {metadata: null, capture};
}

export function metadataCard(title, entries, note = "") {
  const section = el("section", "", "layer-metadata-card");
  section.append(el("h2", title));
  const facts = el("dl", "", "layer-metadata-facts");
  for (const [label, value] of entries) facts.append(el("dt", label), el("dd", display(value)));
  section.append(facts);
  if (note) section.append(el("p", note, "layer-metadata-note"));
  return section;
}

export function LayerMetadataCards({dataset, source, knowledge}) {
  const {metadata: m, capture} = recordedLayerMetadata(knowledge);
  const root = el("div", "", "layer-metadata-grid");
  const extent = m?.extent ?? m?.fullExtent;
  const sr = extent?.spatialReference ?? m?.spatialReference;
  const geometry = dataset.geometryType ?? m?.geometryType ?? source?.configuration?.geometry_type ?? source?.configuration?.geometryType;
  const crs = dataset.crs ?? (source?.sourceType === "geojson" ? "OGC:CRS84 · longitude, latitude" : null) ?? (sr?.latestWkid || sr?.wkid ? `WKID ${sr.latestWkid ?? sr.wkid}${sr.latestWkid && sr.wkid !== sr.latestWkid ? ` (source ${sr.wkid})` : ""}` : sr?.wkt);
  root.append(metadataCard("Geometry and coverage", [
    ["Geometry", geometry?.replace(/^esriGeometry/, "")], ["Coordinate system", crs],
    ["Extent", dataset.extent?.join(", ") ?? source?.configuration?.bounds?.join(", ") ?? (extent ? [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(", ") : null)],
    ["Elevation (Z)", m?.hasZ], ["Measures (M)", m?.hasM],
    ["Current version features", dataset.featureCount],
    ["Captured features", capture?.featureCount ?? source?.configuration?.featureCount ?? source?.configuration?.feature_count], ["Provider count at capture", capture?.providerCount]
  ], "Extent uses the recorded coordinate system. Captured counts describe the archive, not a current server count."));
  root.append(metadataCard("Service and display", [
    ["Provider layer", m?.name], ["Layer type", m?.type ?? source?.sourceType ?? dataset.sourceType],
    ["Object ID", m?.objectIdField ?? source?.configuration?.object_id_field], ["Display field", m?.displayField],
    ["Fields", m?.fields?.length ?? source?.configuration?.fields?.length],
    ["Query formats", m?.supportedQueryFormats], ["Request limit", m?.maxRecordCount],
    ["Visible scales", m ? `${scale(m.minScale)} – ${scale(m.maxScale)}` : null],
    ["Capabilities", m?.capabilities], ["Attachments", m?.hasAttachments]
  ], m ? "Provider settings are retained observations; project visibility and styling are configured separately." : "Connection settings are available; a retained provider observation has not been linked."));
  root.append(metadataCard("Record and access", [
    ["Status", dataset.status], ["Sensitivity", dataset.classification], ["Record owner", dataset.ownerUserId],
    ["Resource ID", dataset.id], ["Data version", dataset.currentVersionNumber],
    ["Connection revision", source?.versionNumber], ["Metadata revision", knowledge?.version],
    ["Updated", dataset.updatedAt]
  ], "OpenGeo Studio ownership and access do not establish upstream ownership or reuse rights."));
  if (m) {
    const description = el("section", "", "layer-metadata-card layer-metadata-wide");
    description.append(el("h2", "Provider description"), el("p", plainText(m.description || m.serviceDescription || "No description supplied.")));
    description.append(metadataCard("Source and provenance", [
      ["Attribution", m.copyrightText || source?.configuration?.attribution], ["Service item", m.serviceItemId],
      ["Observation", capture?.observationKind], ["Capture time", capture?.capturedAt],
      ["Metadata SHA-256", capture?.sha256]
    ], "The original JSON is preserved separately. Missing copyright text does not establish a license."));
    root.append(description);
    if (Array.isArray(m.fields)) root.append(fieldCard(m.fields));
    const details = el("details", "", "layer-metadata-card layer-metadata-wide");
    details.append(el("summary", capture?.metadataSummaryOnly ? "Recorded provider fields · complete JSON preserved in archive" : "Complete recorded provider metadata"), el("pre", JSON.stringify(m, null, 2)));
    if (capture) details.append(el("h3", "Archive evidence"), el("pre", JSON.stringify(capture, null, 2)));
    root.append(details);
  }
  return root;
}

function fieldCard(fields) {
  const section = el("section", "", "layer-metadata-card layer-metadata-wide");
  const details = el("details"); details.open = true;
  details.append(el("summary", `Attribute schema · ${fields.length} fields`));
  const scroll = el("div", "", "layer-schema-scroll"); scroll.tabIndex = 0; scroll.setAttribute("aria-label", "Attribute schema");
  const table = el("table"); const head = el("thead"), row = el("tr");
  for (const label of ["Field / alias", "Type", "Constraints", "Domain / default"]) {const th=el("th", label); th.scope="col"; row.append(th);}
  head.append(row); table.append(head); const body = el("tbody");
  for (const field of fields) {
    const row = el("tr"), name=el("td"); name.append(el("strong", field.name));
    if (field.alias && field.alias !== field.name) name.append(el("small", field.alias));
    const constraints = [field.length ? `Length ${field.length}` : null, field.nullable === false ? "Required" : field.nullable === true ? "Nullable" : null, field.editable === false ? "Read only" : null].filter(Boolean).join(" · ");
    const domain=el("td");
    if (field.domain) {const d=el("details");d.append(el("summary",field.domain.name || field.domain.type || "Domain"),el("pre",JSON.stringify(field.domain,null,2)));domain.append(d);}
    if (field.defaultValue !== undefined && field.defaultValue !== null) domain.append(el("span", `Default: ${display(field.defaultValue)}`));
    row.append(name, el("td", field.type?.replace(/^esriFieldType/, "")), el("td", constraints || "—"), domain); body.append(row);
  }
  table.append(body);scroll.append(table);details.append(scroll);section.append(details);return section;
}
function scale(value) {return value === 0 ? "No limit" : Number.isFinite(value) ? `1:${value.toLocaleString("en-US")}` : "Not recorded";}
function display(value) {return value === null || value === undefined || value === "" ? "Not recorded" : typeof value === "boolean" ? (value ? "Yes" : "No") : typeof value === "object" ? JSON.stringify(value) : String(value);}
function plainText(value) {const parsed = new document.defaultView.DOMParser().parseFromString(String(value), "text/html"); return parsed.body.textContent || "";}
function el(tag, text = "", className = "") {const node=document.createElement(tag);node.textContent=text;node.className=className;return node;}
