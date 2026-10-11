/** Deliberate saved-file history backup and one-revision-at-a-time restore. */
export function PublicationSourceHistory({adapter, projectId, sourceProject,
  destination = sourceProject, isCurrent = () => true, onRestored, engine}) {
  const root = node("details");
  root.className = "publication-source-history";
  root.append(node("summary", "Version history"), node("p",
    "Saved drafts stay separate from the public version. Publishing and sharing are separate actions."));
  const versions = node('ol'); versions.ariaLabel = 'Saved draft versions';
  const backup = node("section"), restore = node("section");
  const backupStatus = status(), restoreStatus = status();
  const reviewHistory = button("Load version history", reviewBackup);
  const download = button("Download history ZIP", downloadBackup);
  const file = node("input");
  file.type = "file"; file.accept = ".zip,application/zip";
  file.setAttribute("aria-label", "Source history ZIP");
  const start = button("Start history restore", startRestore);
  const next = button("Restore next saved revision", () => advance(false));
  const reconcile = button("Check pending revision", () => advance(true));
  backup.append(node("h5", "Backup"),
    node("p", "100 revisions · 128 distinct files · 16 MiB total. Linked data and map history need separate backup and restore support."), download, backupStatus);
  restore.append(node("h5", "Restore"), label("History ZIP", file),
    node("p", `Destination: ${destination.title ?? "New source"}`), start, next, reconcile, restoreStatus);
  const interchange = node('details'); interchange.append(node('summary', 'Backup and restore'), backup, restore);
  root.append(reviewHistory, versions, interchange);
  root.openHistory = () => { root.open = true; reviewHistory.click(); };

  const storageKey = `opengeo:source-history-restore:${projectId}:${destination.id}`;
  let plan = null, archive = null, restorePlan = null, receipt = null;
  let busy = false, storageError = false, enginePromise;
  try {
    const saved = storage().getItem(storageKey);
    if (saved !== null) {
      receipt = JSON.parse(saved);
      if (!receipt || receipt.schemaVersion !== "opengeo.source-history-restore.1.0.0"
        || receipt.sourceProjectId !== destination.id || !Array.isArray(receipt.completed)) {
        throw Error("Invalid restore checkpoint");
      }
      restoreStatus.textContent = "Restore checkpoint found. Reselect its history ZIP to continue.";
    }
  } catch {
    storageError = true;
    restoreStatus.textContent = "A restore checkpoint could not be read. Use a browser with working local storage before restoring.";
  }
  reflect();
  file.addEventListener("change", () => run(async () => {
    archive = null; restorePlan = null;
    const selected = file.files?.[0];
    if (!selected) return;
    restoreStatus.textContent = "Checking history ZIP…";
    const api = await getEngine(), imported = await api.readSourceHistoryBackup(selected);
    assertCurrent();
    if (file.files?.[0] !== selected) throw Error("The selected ZIP changed");
    if (receipt && receipt.archiveChecksumSha256 !== imported.checksumSha256) {
      throw new TypeError("This ZIP does not match the saved restore checkpoint. Select the original history ZIP.");
    }
    const checked = api.planSourceHistoryRestore({archive: imported, destination, checkpoint: receipt});
    assertCurrent();
    archive = imported; restorePlan = checked;
    restoreStatus.textContent = `${restorePlan.revisionCount} revisions · ${bytes(restorePlan.totalUploadBytes)} uploads · at most ${restorePlan.maximumUploadRequests} upload and ${restorePlan.maximumCommitRequests} save requests${Number.isSafeInteger(restorePlan.maximumReadbackRequests) ? ` · ${restorePlan.maximumReadbackRequests} verification reads` : ""}. Rights start as Not reviewed.`;
    if (receipt) describeReceipt();
  }, restoreStatus));

  async function reviewBackup() {
    plan = null; backupStatus.textContent = "Reading saved revision metadata…";
    const revisions = await adapter.listObservableSourceRevisions(projectId, sourceProject.id);
    assertCurrent();
    versions.replaceChildren(...[...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber).map(revision =>
      node('li', `Version ${revision.revisionNumber}${revision.revisionNumber === sourceProject.currentRevisionNumber ? ' · current draft' : ''}${revision.changeSummary ? ' · ' + revision.changeSummary : ''}${revision.createdAt ? ' · ' + revision.createdAt : ''}`)));
    const api = await getEngine();
    assertCurrent();
    plan = api.planSourceHistoryBackup({sourceProject, revisions});
    backupStatus.textContent = `${plan.revisionCount} revisions · ${plan.uniqueFiles.length} distinct files · ${bytes(plan.totalBytes)} · ${plan.downloadRequests} requests. Download to copy the saved bytes.`;
  }

  async function downloadBackup() {
    if (!plan) return;
    const selectedPlan = plan, api = await getEngine();
    assertCurrent();
    const {blob} = await api.createSourceHistoryBackup({adapter, projectId, sourceProject,
      plan: selectedPlan, isCurrent: current, onProgress: message => {
        if (current()) backupStatus.textContent = message;
      }});
    assertCurrent();
    if (plan !== selectedPlan) throw Error("The history selection changed");
    const name = String(sourceProject.routeNamespace ?? "publication")
      .replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "publication";
    const url = URL.createObjectURL(blob), link = node("a");
    link.href = url; link.download = `${name}-source-history.zip`;
    try { root.ownerDocument.body.append(link); link.click(); }
    finally {link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);}
    backupStatus.textContent = `Downloaded ${selectedPlan.revisionCount} saved revisions. Your working draft is unchanged.`;
  }

  async function startRestore() {
    if (!archive || !restorePlan || receipt || storageError) return;
    if (destination.currentRevisionNumber !== 0 || destination.currentRevisionId !== null) {
      throw new TypeError("Choose a new source with no saved revisions before restoring history.");
    }
    await saveCheckpoint({schemaVersion: "opengeo.source-history-restore.1.0.0",
      archiveChecksumSha256: archive.checksumSha256, sourceProjectId: destination.id,
      baseRevision: 0, completed: [], pending: null});
    describeReceipt();
  }

  async function advance(recovery) {
    if (!archive || !receipt || storageError || Boolean(receipt.pending) !== recovery) return;
    const api = await getEngine();
    assertCurrent();
    // Confirm checkpoint storage before a mutation. The engine saves its pending
    // receipt before committing and never replays an ambiguous save.
    await saveCheckpoint(receipt);
    receipt = await api[recovery ? "reconcileSourceHistoryStep" : "restoreSourceHistoryStep"]({
      adapter, projectId, sourceProjectId: destination.id, archive, destination,
      checkpoint: receipt, saveCheckpoint, isCurrent: current,
      onProgress: message => {if (current()) restoreStatus.textContent = message;}
    });
    assertCurrent();
    await saveCheckpoint(receipt);
    describeReceipt();
    if (!receipt.pending && receipt.completed.length === restorePlan.revisionCount && onRestored) {
      await onRestored(receipt);
    }
  }

  async function saveCheckpoint(value) {
    assertCurrent();
    const serialized = JSON.stringify(value);
    try {
      storage().setItem(storageKey, serialized);
      if (storage().getItem(storageKey) !== serialized) throw Error("Restore checkpoint was not saved");
    } catch {
      storageError = true;
      throw new TypeError("The restore checkpoint could not be saved. No further revision will be restored until browser storage works.");
    }
    receipt = JSON.parse(serialized);
  }
  function describeReceipt() {
    const count = receipt.completed.length, total = restorePlan?.revisionCount;
    restoreStatus.textContent = receipt.pending
      ? `${count} of ${total} revisions restored. A save needs checking; check its exact result before continuing.`
      : count === total
        ? `${count} saved revisions restored. Rights need review; preview and publishing are separate.`
        : `${count} of ${total} revisions restored. Restore the next saved revision when ready.`;
  }
  function reflect() {
    reviewHistory.disabled = busy;
    download.disabled = busy || !plan;
    file.disabled = busy;
    start.hidden = Boolean(receipt);
    start.disabled = busy || !archive || !restorePlan || storageError;
    next.hidden = !receipt || Boolean(receipt.pending);
    next.disabled = busy || !archive || !restorePlan || storageError
      || receipt?.completed.length >= restorePlan?.revisionCount;
    reconcile.hidden = !receipt?.pending;
    reconcile.disabled = busy || !archive || !restorePlan || storageError;
  }
  async function run(action, feedback) {
    if (busy || !current()) return;
    busy = true; reflect();
    try {await action();}
    catch (error) {
      if (current()) feedback.textContent = [403, 404].includes(error?.status)
        ? "Saved history is unavailable. Check source access."
        : error instanceof TypeError ? error.message
          : receipt?.pending ? "A save needs checking. Check the pending revision before continuing."
            : "The history action could not finish. Review again before continuing.";
    } finally {busy = false; reflect();}
  }
  function button(title, action) {
    const item = node("button", title); item.type = "button"; item.className = "platform-button secondary";
    item.addEventListener("click", () => run(action, item === reviewHistory || item === download ? backupStatus : restoreStatus));
    return item;
  }
  function current() {return root.isConnected && isCurrent();}
  function assertCurrent() {if (!current()) throw Error("The selected source changed");}
  function storage() {return root.ownerDocument.defaultView.localStorage;}
  function getEngine() {return engine ? Promise.resolve(engine)
    : (enginePromise ??= import("../lib/publicationSourceHistory.js"));}
  return root;
}

function node(tag, text = "") {const item = document.createElement(tag); item.textContent = text; return item;}
function label(title, control) {const item = node("label", title); item.append(control); return item;}
function status() {const item = node("p"); item.className = "project-resource-feedback"; item.setAttribute("role", "status"); return item;}
function bytes(count) {return `${Number(count).toLocaleString()} bytes`;}
