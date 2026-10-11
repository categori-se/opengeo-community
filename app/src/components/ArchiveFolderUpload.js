import {collectArchiveFiles, routeArchiveFiles, hashArchivePlan, matchArchiveSelection} from "../lib/archiveUploadPlan.js";
import {runArchiveUpload, readArchivePages, preserveArchiveManifest} from "../lib/archiveUploadSession.js";
import {restoreArchive} from "../lib/archiveRestore.js";

export function ArchiveFolderUpload({state}) {
  const panel = document.createElement("section");
  panel.className = "upload-panel project-upload-form archive-folder-upload";
  panel.append(text("h3", "Archive folders"), text("p",
    "Preserve original files, metadata and scripts in reviewed private S3 destinations. Storage and request charges apply. Browser selection does not preserve Unix permissions, symbolic links or empty directories.", "note"));
  const api = state.adapter.archiveUploads(state.project.id);
  const scope = [state.adapter.baseUrl, state.session.userId, state.organization.id, state.project.id];
  const key = `opengeo.archive-upload.v1:${JSON.stringify(scope)}`;
  let resume = null, selection = null, entries = null, plan = null, destinations = [], controller = null, busy = false;
  const feedback = text("p", "Choose folders and review their storage destinations.");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved && JSON.stringify(saved.scope) === JSON.stringify(scope)) resume = saved;
  } catch {feedback.textContent = "Browser resume storage is unavailable. Enable local storage before uploading.";}
  const picker = document.createElement("input");
  picker.type = "file"; picker.multiple = true;
  picker.setAttribute("webkitdirectory", "");
  picker.setAttribute("aria-label", "Archive folder");
  const inventory = text("p", "No files selected.");
  const preview = document.createElement("pre");
  preview.style.maxHeight = "12rem"; preview.style.overflow = "auto";
  const load = button("Load private destinations", () => task(async () => {
    await assertScope(); destinations = await api.destinations();
    if (!destinations.length) {feedback.textContent = "No private archive destination is configured for this workspace."; return;}
    routes.replaceChildren(); addRoute();
    feedback.textContent = "Assign each folder prefix to a destination. More specific prefixes override broader ones.";
  }));
  const routes = document.createElement("div");
  const add = button("Add destination rule", () => addRoute());
  const review = button("Review files and duplicates", () => task(reviewSelection));
  const upload = button("Upload reviewed originals", () => task(async () => {
    if (!plan) throw Error("Review the selected files first.");
    await assertScope();
    resume ??= {scope, creationKey: crypto.randomUUID(), uploadId: null};
    const manifest = await runArchiveUpload({api, plan, entries, resume, saveResume,
      signal: controller.signal, assertScope, onProgress: progress => {
        feedback.textContent = `${progress.phase}: ${progress.path} · ${bytes(progress.loaded)} / ${bytes(progress.total)} · ${progress.verifiedObjects}/${progress.totalObjects} objects verified`;
      }});
    result = manifest;
    receipt.hidden = false;
    feedback.textContent = `Verified ${plan.files.length} original paths in ${plan.objects.length} stored objects. Download the reconstruction manifest.`;
  }));
  const pause = button("Pause", () => controller?.abort());
  const reopen = button("Resume saved upload", () => task(async () => {
    if (!resume?.uploadId) {
      if (resume?.creationKey) {await reviewSelection(); return;}
      throw Error("There is no saved upload in this workspace.");
    }
    await assertScope();
    const status = await api.status(resume.uploadId);
    if (status.state === "complete") {
      result = {schema: "opengeo-browser-archive/v1", uploadId: resume.uploadId,
        files: await readArchivePages(after => scoped(() => api.manifest(resume.uploadId, after))),
        filesystemLimits: ["Browser selection omits Unix modes, symbolic links and empty directories."]};
      receipt.hidden = false;
      feedback.textContent = "Saved upload is complete. Its reconstruction manifest is ready.";
      return;
    }
    if (!selection) throw Error("Reselect the original folders to resume.");
    if (status.state === "planning") {await reviewSelection(); return;}
    const rows = await readArchivePages(after => scoped(() => api.files(resume.uploadId, after)));
    const existing = {files: rows.map(row => ({path: row.path, sizeBytes: row.size_bytes,
      lastModified: row.modified_milliseconds, sha256: row.sha256, objectIndex: row.ordinal})),
      objects: rows.map(row => ({destinationId: row.destination_id}))};
    entries = matchArchiveSelection(existing, selection);
    plan = await hashArchivePlan(entries, {signal: controller.signal, onProgress: hashProgress});
    showReview();
  }));
  const savedId = document.createElement("input"); savedId.type = "text";
  savedId.setAttribute("aria-label", "Saved archive upload ID");
  savedId.placeholder = "Upload ID from a reconstruction manifest";
  const openSaved = button("Open saved archive", () => task(async () => {
    const id = savedId.value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw Error("Enter the archive upload ID from its reconstruction manifest.");
    }
    await assertScope();
    const status = await api.status(id);
    await assertScope();
    const manifest = status.state === "complete"
      ? {schema: "opengeo-browser-archive/v1", uploadId: id,
        files: await readArchivePages(after => scoped(() => api.manifest(id, after))),
        filesystemLimits: ["Browser selection omits Unix modes, symbolic links and empty directories."]}
      : null;
    await assertScope();
    saveResume({scope, creationKey: crypto.randomUUID(), uploadId: id});
    plan = null; result = manifest; restoreDirectory = null;
    receipt.hidden = !manifest;
    feedback.textContent = manifest
      ? "Saved archive opened. Original bytes are read only when you select Restore archived originals."
      : "Saved upload opened. Reselect its original folders and use Resume saved upload.";
  }));
  const reopenNote = text("p", "Open a saved archive from its upload ID to recover it in another browser. Access is checked in this workspace. Opening the manifest does not download the captured files.", "note");
  let result = null;
  let restoreDirectory = null;
  const receipt = button("Download reconstruction manifest", () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: "application/json"}));
    const link = document.createElement("a"); link.href = url; link.download = "archive-restoration-manifest.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  receipt.hidden = true;
  const preserve = button("Preserve reconstruction records in S3", () => task(async () => {
    if (!result || !resume?.uploadId) throw Error("Complete the originals upload first.");
    const {records, indexes} = await preserveArchiveManifest({api, uploadId: resume.uploadId,
      signal: controller.signal, assertScope,
      onProgress: count => {feedback.textContent = `Preserved ${count} reconstruction records. Storage and request charges apply.`;}});
    result = {...result, archivedRecords: records, archivedIndexes: indexes};
    feedback.textContent = `Preserved ${records.length} reconstruction records in the original private destinations. Verified ${indexes.length} archive indexes. Download the updated manifest for their exact versions.`;
  }));
  const preserveNote = text("p", "After uploading, preserve reconstruction records in S3 so original paths can be recovered independently of Studio. This action adds storage and request charges; repeating it reuses saved receipts.", "note");
  const chooseRestore = button("Choose empty restore folder", async () => {
    try {
      // The picker must run directly inside the user's gesture, before API awaits.
      if (!window.showDirectoryPicker) throw Error("Folder restoration requires a browser with folder-write support, such as Chrome or Edge.");
      restoreDirectory = await window.showDirectoryPicker({mode: "readwrite"});
      feedback.textContent = "Restore folder selected. Restoring downloads archived originals from S3; download and request charges apply.";
      update();
    } catch (error) {if (error.name !== "AbortError") feedback.textContent = describe(error);}
  });
  const restore = button("Restore archived originals", () => task(async () => {
    if (!result || !restoreDirectory) throw Error("Choose an empty restore folder first.");
    const restored = await restoreArchive({api, uploadId: resume.uploadId, files: result.files,
      directory: restoreDirectory, signal: controller.signal, assertScope,
      onProgress: value => {feedback.textContent = `Restoring ${value.path}: ${bytes(value.bytes)} · ${value.completed}/${value.totalFiles} files verified`;}});
    feedback.textContent = `Restored and verified ${restored.files} original paths. Downloaded ${bytes(restored.downloadedBytes)} from S3.`;
    restoreDirectory = null;
  }));
  const restoreNote = text("p", "Restore to an empty folder. S3 download and request charges apply. Files are checksum-verified; duplicate originals reuse local bytes. File times remain in the manifest but are not applied. If interrupted, completed files remain; select a new empty folder to restart.", "note");
  const fresh = button("Start a new archive", () => {
    localStorage.removeItem(key); resume = null; result = null; plan = null;
    receipt.hidden = true; feedback.textContent = "Choose folders and review destinations for the new archive."; update();
  });
  picker.addEventListener("change", () => {
    try {
      // Each chooser action adds another root, preserving the original File handles.
      selection = collectArchiveFiles([...(selection?.entries.map(entry => entry.file) ?? []), ...picker.files]);
      invalidate();
      inventory.textContent = `${selection.entries.length} files · ${bytes(selection.totalBytes)}`;
      preview.textContent = selection.entries.slice(0, 20).map(entry => entry.path).join("\n")
        + (selection.entries.length > 20 ? "\n…" : "");
    } catch (error) {feedback.textContent = describe(error);}
    picker.value = "";
    update();
  });
  const clear = button("Clear selection", () => {
    selection = entries = plan = null;
    inventory.textContent = "No files selected."; preview.textContent = ""; update();
  });
  panel.append(picker, clear, inventory, preview, load, routes, add, review, upload, pause, reopen,
    reopenNote, savedId, openSaved, receipt, preserveNote, preserve, restoreNote, chooseRestore, restore, fresh, feedback);
  const unload = event => {if (busy) {event.preventDefault(); event.returnValue = "";}};
  window.addEventListener("beforeunload", unload);
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {controller?.abort(); observer.disconnect(); window.removeEventListener("beforeunload", unload);}
  });
  observer.observe(document.body, {childList: true, subtree: true});
  update();
  return panel;

  function addRoute() {
    if (!destinations.length) {feedback.textContent = "Load the workspace's private destinations first."; return;}
    const row = document.createElement("div"); row.className = "project-upload-fields";
    const path = document.createElement("input"); path.placeholder = "Folder prefix, e.g. archive/metadata/Bhutan";
    path.setAttribute("aria-label", "Original folder prefix");
    if (!routes.children.length && selection) path.value = selection.entries[0].path.split("/")[0];
    const select = document.createElement("select"); select.setAttribute("aria-label", "Private archive destination");
    select.append(new Option("Choose destination", ""));
    for (const destination of destinations) select.append(new Option(`${destination.title} · s3://${destination.bucket}/${destination.prefix}`, destination.id));
    const remove = button("Remove rule", () => {row.remove(); invalidate();});
    path.addEventListener("input", invalidate); select.addEventListener("change", invalidate);
    row.append(path, select, remove); routes.append(row); invalidate();
  }
  function invalidate() {plan = null; result = null; receipt.hidden = true; update();}
  function update() {
    for (const control of panel.querySelectorAll("input, select, button")) control.disabled = busy;
    pause.disabled = !busy;
    upload.disabled = busy || !plan;
    review.disabled = busy || !selection;
    reopen.disabled = busy || !resume;
    fresh.disabled = busy || !result;
    preserve.disabled = busy || !result;
    chooseRestore.disabled = busy || !result;
    restore.disabled = busy || !result || !restoreDirectory;
  }
  async function assertScope() {
    controller?.signal.throwIfAborted();
    if (!panel.isConnected || JSON.stringify([state.adapter.baseUrl, state.session.userId, state.organization.id, state.project.id]) !== JSON.stringify(scope)
      || await state.adapter.organizationProvider() !== scope[2]) throw Error("archive_scope_changed");
    controller?.signal.throwIfAborted();
  }
  async function task(work) {
    if (busy) return;
    controller = new AbortController(); busy = true; update();
    try {
      const current = await state.adapter.getSession({signal: controller.signal});
      if (current.userId !== scope[1]) throw Error("archive_scope_changed");
      await work();
    } catch (error) {feedback.textContent = error?.name === "AbortError"
      ? "Paused. Verified files remain and uploaded parts can resume. Interrupted restores require a new empty folder." : describe(error);}
    finally {busy = false; update();}
  }
  function saveResume(value) {
    const saved = {...value, scope};
    localStorage.setItem(key, JSON.stringify(saved)); // Refuse to lose recovery identity silently.
    resume = saved;
  }
  async function scoped(work) {await assertScope(); const value = await work(); await assertScope(); return value;}
  function hashProgress(progress) {feedback.textContent = `Checking files: ${progress.hashedFiles}/${progress.totalFiles} · ${bytes(progress.hashedBytes)}`;}
  async function reviewSelection() {
    if (!selection) throw Error("Choose the original folders first.");
    await assertScope();
    const rules = [...routes.children].map(row => ({path: row.querySelector("input").value,
      destinationId: row.querySelector("select").value}));
    entries = routeArchiveFiles(selection, rules, destinations.map(destination => destination.id));
    plan = await hashArchivePlan(entries, {signal: controller.signal, onProgress: hashProgress});
    showReview();
  }
  function showReview() {feedback.textContent = `Reviewed ${plan.files.length} files · ${plan.objects.length} unique objects · ${bytes(plan.uploadBytes)} to store. S3 storage and request charges apply. Select Upload reviewed originals to proceed.`;}
}
function text(tag, value, className) {const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node;}
function button(label, action) {const node = text("button", label, "platform-button secondary"); node.type = "button"; node.addEventListener("click", action); return node;}
function bytes(value) {return `${(value / 1024 / 1024).toLocaleString(undefined, {maximumFractionDigits: 1})} MiB`;}
function describe(error) {
  const messages = {archive_route_required: "Assign a destination to every selected file.",
    archive_route_invalid: "Check destination rules for duplicate prefixes or missing destinations.",
    archive_duplicate_path: "That path is already selected. Clear the selection before choosing replacement folders.",
    archive_selection_changed: "The selected files differ from the saved upload. Reselect the original files.",
    archive_scope_changed: "The signed-in account or workspace changed. Reopen the uploader.",
    archive_multipart_creation_unresolved: "The upload start is still unresolved. Resume later to check the saved transfer."};
  return messages[error?.code ?? error?.message] ?? error?.message ?? "The upload could not continue. Resume to check its saved state.";
}
