import {ResourceStyleVersionEditor} from "./ResourceStyleVersionEditor.js";
import {ResourceMetadataExchange} from "./ResourceMetadataExchange.js";
// Read existing governed records in place. No backfill or authority promotion.
export function LayerGovernedMetadata({adapter, datasetId, accountId = null}) {
  const root = node("section");
  root.append(node("h2", "Existing governed metadata"), node("p",
    "These records retain their own permissions, revisions and provenance. They are separate from the Layer knowledge assertions; values are not automatically merged."));
  const status = node("p"); status.setAttribute("role", "status");
  const records = node("div");
  let offset = 0, disposed = false;
  const controller = new AbortController();
  root.dispose = () => {disposed = true; controller.abort();};
  async function current() {
    if (disposed) return false;
    const selected = typeof adapter.organizationProvider === "function" ? await adapter.organizationProvider()
      : adapter.selectedOrganizationId;
    if (disposed) return false;
    if (accountId && selected !== undefined && selected !== accountId) {
      root.dispose(); records.replaceChildren();
      status.textContent = "The selected account changed. Reload this Layer to inspect metadata.";
      load.disabled = true;
    }
    return !disposed;
  }
  const load = button("Find metadata records", async () => {
    if (disposed) return;
    load.disabled = true;
    status.textContent = "Loading accessible records…";
    try {
      if (!await current()) return;
      const page = await adapter.listDatasetResources(datasetId, {limit: 50, offset});
      if (!await current()) return;
      if (page.some(record => record.datasetId !== datasetId)) throw Error("Binding changed");
      for (const record of page) records.append(recordPanel(record));
      offset += page.length;
      status.textContent = offset ? `${offset} accessible records loaded.` : "No accessible governed records found for this Layer.";
      load.textContent = "Load more records";
      load.hidden = page.length < 50 || offset > 10_000;
      if (offset > 10_000) status.textContent += " The inspection limit has been reached.";
    } catch {if (!disposed) status.textContent = "Records could not load. Retry, or check access and server availability."; }
    finally {if (!disposed) load.disabled = false; }
  });
  root.append(status, load, records);
  return root;

  function recordPanel(summary) {
    const section = node("section");
    section.append(node("h3", summary.title), node("p", `Record ${summary.id} · listed revision ${summary.versionNumber}`));
    const content = node("div"), message = node("p"); message.setAttribute("role", "status");
    let exchange;
    const inspect = button("Inspect record", async () => {
      if (disposed) return;
      if ([...content.querySelectorAll(".resource-style-version-editor")].some(editor=>editor.hasUnsavedChanges?.())) {
        message.textContent="A Style has unsaved edits or an unresolved save. Finish its version review before reloading this record. Your draft is retained.";
        return;
      }
      inspect.disabled = true;
      exchange?.dispose();
      message.textContent = "Loading record…";
      try {
        if (!await current()) return;
        const record = await adapter.getResource(summary.projectId, summary.id);
        if (!await current()) return;
        if (record.id !== summary.id || record.projectId !== summary.projectId || record.datasetId !== datasetId) throw Error("Binding changed");
        exchange = ResourceMetadataExchange({adapter, projectId: record.projectId, resource: record,
          isCurrent: current, signal: controller.signal});
        content.replaceChildren(node("p", `Current record revision ${record.versionNumber} · recorded ${record.versionCreatedAt} by ${record.versionCreatedBy}`),
          node("p", record.abstract || "Description not recorded."),
          node("p", `License: ${record.license || "Not recorded"}. Attribution: ${record.attribution || "Not recorded"}.`),
          node("p", "These are governed-record statements. Their authority and distribution scope must be read with the retained metadata and provenance."),
          json("Metadata profile and extensions", {profile: record.metadataProfile, extensions: record.metadataExtensions}),
          json("Provenance and identifiers", {provenance: record.provenance, externalIdentifiers: record.externalIdentifiers}),
          exchange, sourcePanel(record), stylesPanel(record));
        message.textContent = record.versionNumber === summary.versionNumber ? "Record loaded." : "The record changed since listing; the current revision is shown.";
      } catch {if (!disposed) {content.replaceChildren(); message.textContent = "Record unavailable. Access or its Layer binding may have changed.";} }
      finally {if (!disposed) inspect.disabled = false; }
    });
    section.append(inspect, message, content);
    return section;
  }

  function stylesPanel(record) {
    const section=node("section"), content=node("div"), feedback=node("p");
    feedback.setAttribute("role","status");
    section.append(node("h4","Styles recorded for this Layer"),node("p",
      "A saved Style has its own identity and version. Inspecting or editing it does not change a map, render profile or publication. Map style selection is not yet available here; format alone does not establish field, geometry or renderer compatibility."));
    const load=button("Inspect saved Styles",async()=>{
      if (disposed) return;
      load.disabled=true;feedback.textContent="Loading accessible Styles…";
      try {
        if (!await current()) return;
        const [styles,capabilities]=await Promise.all([
          adapter.listResourceStyles(record.projectId,record.id),
          typeof adapter.getResourceCapabilities==="function"
            ? adapter.getResourceCapabilities(record.projectId,record.id).catch(()=>({canUpdate:false}))
            : {canUpdate:false}
        ]);
        if (!await current()) return;
        if(styles.some(style=>style.resourceId!==record.id)) throw Error("Style binding changed");
        const entries=styles.map(style=>{
          const item=node("article"), heading=node("h5");
          const identity=updated=>{heading.textContent=`${updated.title} · ${updated.format} · version ${updated.versionNumber}`;};
          identity(style);
          item.append(heading,node("p",`Style ID: ${style.id}`),ResourceStyleVersionEditor({
            adapter,projectId:record.projectId,resourceId:record.id,style,
            canUpdate:capabilities.canUpdate&&record.state!=="archived",onStyleChange:identity
          }));
          return item;
        });
        content.replaceChildren(...entries);
        feedback.textContent=styles.length?`${styles.length} saved Styles. Definitions remain inert until deliberately used by a compatible renderer.`:"No saved Styles on this governed record.";
        // Keep loaded editors in place; reopening does not erase their drafts.
        load.hidden=true;
      }catch{if (!disposed) feedback.textContent="Styles could not load. Check access and retry.";}
      finally{if (!disposed) load.disabled=false;}
    });
    section.append(load,feedback,content);return section;
  }

  function sourcePanel(record) {
    const section = node("section"), status = node("p"), content = node("div");
    status.setAttribute("role", "status");
    const load = button("Inspect retained import source", async () => {
      if (disposed) return;
      load.disabled = true;
      try {
        if (!await current()) return;
        const source = await adapter.getResourceMetadataSource(record.projectId, record.id);
        if (!await current()) return;
        if (source.resourceId !== record.id) throw Error("Source binding changed");
        content.replaceChildren(node("p", `Imported ${source.importedAt} by ${source.importedBy}. Source record version ID: ${source.resourceVersionId}.`),
          node("p", "This is the latest retained import; it may predate the current governed revision. It is not a new provider fetch."),
          node("p", source.checksumBasis === "raw_utf8" ? "Retained UTF-8 source text." : "Retained structured JSON; original provider whitespace is not represented."),
          json("Source identity and checksum", {format: source.sourceFormat, namespace: source.sourceNamespace, identifier: source.sourceIdentifier, version: source.sourceVersion, checksumBasis: source.checksumBasis, sha256: source.sourceSha256}),
          source.checksumBasis === "raw_utf8" ? node("pre", source.document) : json("Retained source document", source.document),
          json("Conversion report", source.conversionReport));
        status.textContent = "Retained import loaded.";
      } catch (error) {
        if (disposed) return;
        content.replaceChildren();
        status.textContent = error?.status === 404 ? "No accessible retained import source was found." : "Import source could not load. Check access and retry.";
      } finally {if (!disposed) load.disabled = false; }
    });
    section.append(load, status, content); return section;
  }
}
function node(tag, text = "") { const element = document.createElement(tag); element.textContent = text; return element; }
function button(text, handler) { const element = node("button", text); element.type = "button"; element.className = "platform-button secondary"; element.addEventListener("click", handler); return element; }
function json(label, value) { const element = node("details"); element.append(node("summary", label), node("pre", JSON.stringify(value, null, 2))); return element; }
