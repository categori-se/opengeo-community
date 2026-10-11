import {planAccountSavedPublicationDownload, createAccountSavedPublicationDownload} from "../lib/accountWorkDownload.js";

// Opening a directory never inventories or downloads account content. Each
// operation belongs to this mounted account surface and can be cancelled.
export function AccountWorkDownload({adapter, accountId, ownerUserId, accountName = "this account",
  isCurrent = () => true, planDownload = planAccountSavedPublicationDownload,
  createDownload = createAccountSavedPublicationDownload, saveDownload = downloadBlob}) {
  const root = document.createElement("div");
  root.className = "platform-account-work-download";
  const open = button("Download work…");
  const dialog = document.createElement("dialog");
  dialog.className = "platform-account-download-dialog";
  dialog.setAttribute("aria-label", "Download saved work");
  const title = document.createElement("h2");
  title.textContent = "Download saved work";
  const description = paragraph(`Package saved publication sources and map definitions you own in ${accountName}. Save current edits in their editor first.`);
  const limits = paragraph("Latest saved versions are included by default. Choose Include saved versions for available earlier versions within the download limits. Maps without confirmed ownership, linked data, compiled pages and unsaved edits are excluded. Catalog records and Collections are excluded unless selected below.");
  limits.className = "platform-note";
  const historyLabel = document.createElement("label");
  historyLabel.className = "platform-labeled-field platform-checkbox-field";
  const history = document.createElement("input");
  history.type = "checkbox";
  const historyText = document.createElement("span");
  historyText.textContent = "Include saved versions";
  historyLabel.append(history, historyText);
  const metadataLabel = document.createElement("label");
  metadataLabel.className = "platform-labeled-field platform-checkbox-field";
  const metadata = document.createElement("input"); metadata.type = "checkbox";
  metadataLabel.append(metadata, document.createTextNode("Include Catalog records and Collections"));
  const metadataNote = paragraph("Selected Catalog records include current recorded metadata and supported registered source references, without credentials or data. Collections must be owned by you; Team and Account ownership are excluded. The ZIP may contain private identities, source URLs and repository locations. References grant no access. Catalog/Collection history and connection/import restoration are excluded.");
  metadataNote.className = "platform-note";
  metadataNote.hidden = true;
  const estimate = paragraph("");
  estimate.setAttribute("role", "status");
  const issues = document.createElement("ul");
  issues.className = "platform-note";
  issues.hidden = true;
  const cost = paragraph("Check inspects up to 200 records using at most 100 calls to OpenGeo Studio for metadata. Database, storage and encryption charges are not estimated. A download includes up to 32 items and 64 MiB of saved content. Selected Catalog/Collection metadata shares these limits and needs fresh checks before and after packing. Collection detail may check each member's access. Reads may incur transfer and encryption charges. Linked datasets stay as references; no GIS data is read or captured and no publication is built.");
  cost.className = "platform-note";
  const actions = document.createElement("div");
  actions.className = "platform-actions";
  const check = button("Check saved work");
  const download = button("Download ZIP");
  download.disabled = true;
  const cancel = button("Cancel");
  cancel.hidden = true;
  const close = button("Close");
  actions.append(check, download, cancel, close);
  dialog.append(title, description, limits, historyLabel, metadataLabel, metadataNote, estimate, issues, cost, actions);
  root.append(open, dialog);
  let disposed = false, controller = null, plan = null;
  const current = () => !disposed && isCurrent();
  const active = request => current() && controller === request && !request.signal.aborted;
  const busy = value => {
    check.disabled = value;
    history.disabled = value;
    metadata.disabled = value;
    download.disabled = value || !plan?.items?.length;
    cancel.hidden = !value;
  };
  const stop = () => {
    controller?.abort();
    controller = null;
    busy(false);
  };
  root.dispose = () => {
    disposed = true;
    stop();
    if (dialog.open) dialog.close();
    plan = null;
  };
  open.addEventListener("click", () => {
    if (!current()) return;
    dialog.showModal();
    check.focus();
  });
  close.addEventListener("click", () => {stop(); dialog.close();});
  dialog.addEventListener("close", () => {stop(); if (current()) open.focus();});
  dialog.addEventListener("cancel", () => stop());
  cancel.addEventListener("click", () => {
    stop();
    estimate.textContent = "Download cancelled. Your saved work is unchanged. Already issued requests may finish; no ZIP will be downloaded.";
  });
  const selectionChanged = () => {
    if (!current() || controller) return;
    metadataNote.hidden = !metadata.checked;
    plan = null;
    busy(false);
    issues.replaceChildren(); issues.hidden = true;
    estimate.textContent = "Selection changed. Check saved work to review the download again.";
  };
  history.addEventListener("change", selectionChanged);
  metadata.addEventListener("change", selectionChanged);
  check.addEventListener("click", async () => {
    if (!current() || controller) return;
    plan = null;
    const request = new AbortController(); controller = request;
    busy(true);
    issues.replaceChildren(); issues.hidden = true;
    estimate.textContent = "Checking saved work you own…";
    try {
      const result = await planDownload({adapter, accountId, ownerUserId, includeSavedMapVersions: history.checked,
        includeSavedPublicationVersions: history.checked,
        includeOwnedMetadata: metadata.checked,
        signal: request.signal, isCurrent: () => active(request)});
      if (!active(request)) return;
      plan = result;
      const mapCount = plan.items.filter(item => item.kind === "project").length;
      const catalogCount = plan.items.filter(item => item.kind === "catalog-record").length;
      const collectionCount = plan.items.filter(item => item.kind === "collection").length;
      const publicationCount = plan.items.length - mapCount - catalogCount - collectionCount;
      const versions = plan.estimate.savedMapVersions ?? mapCount;
      const publicationVersions = plan.estimate.savedPublicationVersions ?? publicationCount;
      estimate.textContent = `${publicationCount} saved publications · ${mapCount} maps · ${catalogCount} Catalog records · ${collectionCount} Collections · ${versions} saved map versions · ${publicationVersions} saved publication versions · ${formatBytes(plan.estimate.sourceBytes)} of saved content · up to ${plan.estimate.fileReads} source file reads and ${plan.estimate.downloadMetadataRequests} other OpenGeo Studio reads to download.`;
      for (const item of plan.unresolved) {
        const row = document.createElement("li");
        row.textContent = `${item.title || resourceLabel(item.kind)}: ${reasonLabel(item.reason)}`;
        issues.append(row);
      }
      issues.hidden = !issues.childElementCount;
      if (!plan.items.length) estimate.textContent += " No saved owned work is available in this selection.";
    } catch (error) {
      if (active(request)) estimate.textContent = error instanceof TypeError
        ? error.message : "Saved work could not be checked. No files were downloaded. Choose Check saved work to try again.";
    } finally {
      if (controller === request) {controller = null; if (current()) busy(false);}
    }
  });
  download.addEventListener("click", async () => {
    if (!current() || controller || !plan?.items?.length) return;
    const selected = plan;
    const request = new AbortController(); controller = request;
    busy(true);
    estimate.textContent = "Reading saved work and selected metadata…";
    try {
      const result = await createDownload({adapter, plan: selected, signal: request.signal,
        isCurrent: () => active(request) && plan === selected,
        onProgress: progress => {
          if (!active(request)) return;
          estimate.textContent = typeof progress === "string" ? progress
            : `Preparing download${progress?.title ? ` · ${progress.title}` : ""}…`;
        }});
      if (!active(request) || plan !== selected) return;
      saveDownload(result.blob, result.filename);
      estimate.textContent = `${selected.items.length} saved work items downloaded. See the ZIP inventory for types, exclusions and unresolved items. Your saved work is unchanged.`;
    } catch (error) {
      if (active(request)) {
        if (error instanceof TypeError) plan = null;
        estimate.textContent = error instanceof TypeError
          ? `${error.message} No ZIP was downloaded.` : "The download could not finish. No partial ZIP was downloaded. Your saved work is unchanged.";
      }
    } finally {
      if (controller === request) {controller = null; if (current()) busy(false);}
    }
  });
  return root;
}

function button(label) {
  const result = document.createElement("button");
  result.type = "button";
  result.className = "platform-button platform-button-secondary";
  result.textContent = label;
  return result;
}
function paragraph(value) {
  const result = document.createElement("p"); result.textContent = value; return result;
}
function formatBytes(value) {
  return value < 1024 ? `${value} bytes` : value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
function resourceLabel(kind) {
  if (["catalog-record", "catalog"].includes(kind)) return "Catalog record";
  if (["collection", "collections"].includes(kind)) return "Collection";
  return kind === "project" || kind === "projects" ? "Project" : kind === "workspaces"
    ? "Account inventory" : "Publication";
}
function reasonLabel(reason) {
  return {
    "canonical-project-owner-unavailable": "Ownership information is unavailable; the Project definition is excluded.",
    "canonical-owner-unavailable": "Confirmed ownership is unavailable; this metadata is excluded.",
    "non-user-owner": "Team or Account ownership is outside this personal download.",
    "metadata-read-limit": "Fresh metadata checks would exceed the download read limit; this item is excluded.",
    "metadata-definition-unavailable": "Current metadata is unavailable, changed or exceeds its portable export limit; this item is excluded.",
    "registered-source-unavailable": "Registered source metadata is unavailable or not readable; the Catalog record and knowledge are retained without it.",
    "discovery-limit": "The inventory limit was reached; some work remains unchecked.",
    "metadata-unavailable": "Metadata could not be loaded.",
    "no-saved-revision": "Save a draft in the publication editor first.",
    "item-limit": "The item limit was reached; this item is excluded.",
    "revision-metadata-unavailable": "Saved version information could not be loaded.",
    "source-inventory-over-limit": "The publication inventory exceeds the review limit; its sources are excluded.",
    "revision-inventory-over-limit": "The saved version inventory exceeds the review limit; this source is excluded.",
    "saved-head-unavailable": "The current saved version could not be found.",
    "saved-history-over-limit": "Some saved versions exceed the download size, read or metadata limit and are excluded.",
    "saved-history-unavailable": "Some saved version information could not be loaded and is excluded.",
    "source-size-unavailable-or-over-limit": "The source size is unknown or exceeds a file or publication limit.",
    "byte-or-read-limit": "Including this source would exceed the download size or read limit."
  }[reason] || reason;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.hidden = true;
  document.body.append(link);
  try {link.click();} finally {link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);}
}
