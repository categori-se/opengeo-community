/** Explicit connected capture; inspection never starts provider requests or polling. */
export function CaptureRefresh({adapter, dataset}) {
  const root = el("section"), status = el("p"), details = el("div");
  root.setAttribute("aria-label", "Refresh from connected source"); status.setAttribute("role", "status");
  let disposed = false, busy = false, source, previous, estimate, request, job;
  const basis = input("Rights basis for retaining source data"), attribution = input("Attribution");
  const rights = input("I confirm permission to retain this source data", "checkbox");
  const costs = input("I accept the displayed request, byte and estimated cost limits", "checkbox");
  const load = button("Inspect connected refresh source", async () => {
    await current();
    estimate = null; start.disabled = true; estimateButton.disabled = true;
    const lineage = await adapter.getDatasetVersionLineage(dataset.projectId, dataset.id, dataset.currentVersionId);
    if (lineage.datasetId !== dataset.id || lineage.versionId !== dataset.currentVersionId) throw Error("Layer lineage changed. Reload this page.");
    if (disposed) return;
    const origins = lineage.origins.filter(o => o.kind === "external_source_archive");
    if (origins.length !== 1) throw Error("This version has no single connected capture to refresh. Use a staged file update instead.");
    const origin = origins[0];
    previous = await adapter.getProtectedCopy(dataset.projectId, origin.sourceDatasetId, origin.operationId);
    if (previous.destinationDatasetId !== dataset.id || previous.outputDatasetVersionId !== dataset.currentVersionId
      || previous.sourceDatasetId !== origin.sourceDatasetId || previous.state !== "completed"
      || previous.copyMethod !== "bounded_feature_capture") throw Error("The current version's capture binding is unavailable.");
    source = await adapter.getSource(dataset.projectId, origin.sourceDatasetId);
    if (source.datasetId !== origin.sourceDatasetId || !["arcgis", "wfs"].includes(source.sourceType)) throw Error("This source does not support feature refresh.");
    if (disposed) return;
    basis.value = previous.rightsBasis; attribution.value = previous.attribution;
    details.replaceChildren(el("p", `Refresh ${dataset.name} from ${source.name}, revision ${source.versionNumber}. The current version remains usable until acceptance.`),
      el("pre", JSON.stringify(previous.captureScope, null, 2)));
    status.textContent = "The prior capture area and feature limit will be reused. Review a new estimate before starting.";
    estimateButton.disabled = false; history.disabled = typeof adapter.listProtectedCopies !== "function";
  });
  const estimateButton = button("Review refresh estimate", async () => {
    await current();
    estimate = null; start.disabled = true;
    const latest = await adapter.getSource(dataset.projectId, source.datasetId);
    if (disposed) return;
    if (latest.versionNumber !== source.versionNumber) throw Error("The source revision changed. Inspect the source again.");
    estimate = await adapter.createExternalSourceCopyEstimate(dataset.projectId, source.datasetId, source.versionNumber,
      {sourceType: source.sourceType, scope: previous.captureScope});
    if (estimate.sourceDatasetId !== source.datasetId || estimate.sourceRevisionNumber !== source.versionNumber
      || estimate.projectId !== dataset.projectId || estimate.copyMethod !== "bounded_feature_capture"
      || JSON.stringify(estimate.captureScope) !== JSON.stringify(previous.captureScope)) throw Error("The returned estimate does not match this source.");
    if (!Number.isSafeInteger(estimate.maximumOutputBytes) || estimate.maximumOutputBytes < 0) throw Error("Capture volume is unknown. Review the source size before starting.");
    if (disposed) return;
    request = null; rights.checked = false; costs.checked = false;
    const largeCapture = estimate.maximumOutputBytes > 1_000_000_000;
    costs.setAttribute("aria-label", `${largeCapture ? "I reviewed this capture over 1 GB and potential provider, storage and download charges. " : ""}I accept the displayed request, byte and estimated cost limits`);
    details.replaceChildren(el("p", `${estimate.maximumRequests} requests maximum; ${estimate.maximumOutputBytes} bytes maximum; estimated cost $${estimate.estimatedCostUsd}. Expires ${estimate.expiresAt}.`),
      el("p", `${largeCapture ? "Large capture: the planned maximum exceeds 1 GB (1,000,000,000 bytes). Review this volume before transfer. " : ""}Provider charges are unknown and may apply. Ongoing storage and downloads can incur additional charges; the displayed estimate is not a total bill. Only the selected capture scope will be copied.`),
      el("pre", JSON.stringify(estimate.captureScope, null, 2)), label(basis), label(attribution), label(rights), label(costs));
    start.disabled = false;
    status.textContent = "Review the capture scope, rights and limits. Starting stages a candidate; it does not replace the current version.";
  });
  const start = button("Start source refresh", async () => {
    await current();
    if (!request) {
      if (!rights.checked || !costs.checked || !basis.value.trim() || !attribution.value.trim()) throw Error("Confirm rights and limits, and supply a rights basis and attribution.");
      if (Date.parse(estimate.expiresAt) <= Date.now()) throw Error("The estimate expired. Review a new estimate.");
      request = {idempotencyKey: crypto.randomUUID(),
        estimate: {estimateId: estimate.estimateId, estimateChecksumSha256: estimate.estimateChecksumSha256, accepted: true},
        rights: {confirmed: true, basis: basis.value.trim(), attribution: attribution.value.trim()},
        destination: {name: dataset.name, classification: dataset.classification},
        refreshTarget: {datasetId: dataset.id, baseVersionId: dataset.currentVersionId}};
      recover.disabled = typeof adapter.listProtectedCopies !== "function";
      // A lost response retries this exact request, never a new job identity.
      for (const node of [load, estimateButton, basis, attribution, rights, costs]) node.disabled = true;
    }
    job = await adapter.createProtectedCopy(dataset.projectId, source.datasetId, source.versionNumber, request);
    validateJob(job);
    if (disposed) return;
    start.disabled = true; check.disabled = false;
    showJob();
  });
  const check = button("Check source refresh", async () => {
    job = await adapter.getProtectedCopy(dataset.projectId, source.datasetId, job.jobId);
    validateJob(job); if (!disposed) showJob();
    await showProcessing(job);
  });
  async function showProcessing(capture) {
    if (disposed || capture.state !== "completed" || !capture.outputDatasetVersionId
      || typeof adapter.listDatasetVersions !== "function") return;
    const versions = await adapter.listDatasetVersions(dataset.projectId, dataset.id, {limit: 100});
    if (disposed) return;
    const version = versions.find(value => value.id === capture.outputDatasetVersionId);
    if (!version || version.parentVersionId !== dataset.currentVersionId) {
      status.textContent = "Capture complete. Its processing status could not be established in the latest 100 versions. Reload the Layer to inspect its versions.";
      return;
    }
    status.textContent = version.state === "failed"
      ? "Capture complete, but processing failed. This candidate cannot be accepted. The refresh has not replaced the current version; inspect version quality details for the failure reason."
      : version.state === "active"
      ? "Capture and processing complete. Use Check processing and candidates below to review this version before making it current."
      : `Capture complete; processing status: ${version.state}. Use Check source refresh to check again. The refresh has not replaced the current version.`;
  }
  const history = button("Inspect earlier source refreshes", async () => {
    const values = await adapter.listProtectedCopies(dataset.projectId, source.datasetId, {limit: 100});
    if (disposed) return;
    const records = values.filter(value => value.destinationDatasetId === dataset.id
      && value.sourceDatasetId === source.datasetId && value.outputDatasetVersionId !== dataset.currentVersionId);
    historyDetails.replaceChildren(el("p", "Recent captures for this Layer. Completed captures can be checked in the candidate review below; no new capture is started here."));
    for (const value of records) {
      const record = el("div");
      record.append(el("p", `Source revision ${value.sourceRevisionNumber} · ${value.state} · ${value.createdAt}${value.errorCode ? ` · ${value.errorCode}` : ""}`));
      if (value.errorCode === "source_count_mismatch") record.append(el("p", "The source reported a different feature count than it returned. Capture stopped; the current Layer is unchanged. Review the source before trying again."));
      if (value.state === "completed" && value.outputDatasetVersionId && typeof adapter.listDatasetVersions === "function") {
        record.append(button(`Check captured version ${value.outputDatasetVersionId}`, () => showProcessing(value)));
      }
      historyDetails.append(record);
    }
    status.textContent = records.length ? "Saved capture status loaded. Use this action again to refresh it." : "No other captures for this Layer were found in the latest 100 source requests.";
  });
  const historyDetails = el("div");
  const recover = button("Find submitted refresh", async () => {
    const values = await adapter.listProtectedCopies(dataset.projectId, source.datasetId, {limit: 100});
    const found = values.find(value => value.idempotencyKey === request.idempotencyKey);
    if (!found) throw Error("This request was not found in the latest 100 captures. Retry Start source refresh with the same request.");
    validateJob(found); job = found;
    if (!disposed) {start.disabled = true; check.disabled = false; showJob();}
  });
  const cancel = button("Cancel queued refresh", async () => {
    if (!job?.cancellable) throw Error("This refresh can no longer be cancelled here.");
    const value = await adapter.cancelProtectedCopy(dataset.projectId, source.datasetId, job.jobId);
    validateJob(value); job = value; if (!disposed) showJob();
  });
  function validateJob(value) {
    if (value.destinationDatasetId !== dataset.id || value.sourceDatasetId !== source.datasetId
      || value.sourceRevisionNumber !== source.versionNumber || value.idempotencyKey !== request.idempotencyKey) throw Error("The refresh job identity changed.");
  }
  function showJob() {
    cancel.disabled = !job.cancellable || typeof adapter.cancelProtectedCopy !== "function";
    status.textContent = job.errorCode === "source_count_mismatch"
      ? "The source reported a different feature count than it returned. Capture stopped; the current Layer is unchanged. Review the source before trying again."
      : job.state === "completed"
      ? "Capture complete. Use Check processing and candidates below; review the processed version before making it current."
      : `Source refresh ${job.state}${job.errorCode ? ` (${job.errorCode})` : ""}. The current Layer version is unchanged.`;
  }
  async function current() {
    const value = await adapter.getCatalogDataset(dataset.id);
    if (disposed) throw Error("This Layer view was closed.");
    if (value.id !== dataset.id || value.currentVersionId !== dataset.currentVersionId || !value.capabilities?.edit) throw Error("The Layer version or edit access changed. Reload before continuing.");
  }
  function button(text, action) {
    const node = el("button", text); node.type = "button";
    node.onclick = async () => {
      if (busy || disposed || node.disabled) return;
      busy = true; root.setAttribute("aria-busy", "true"); status.textContent = "Working…";
      try { await action(); } catch (error) { if (!disposed) status.textContent = error.message || "The request failed. Check current status before retrying."; }
      finally { busy = false; root.removeAttribute("aria-busy"); }
    }; return node;
  }
  estimateButton.disabled = true; start.disabled = true; check.disabled = true; recover.disabled = true; cancel.disabled = true; history.disabled = true;
  root.append(el("h3", "Refresh from connected source"), load, estimateButton, details, start, recover, check, cancel, history, historyDetails, status);
  root.dispose = () => { disposed = true; };
  return root;
}
function el(tag, text) { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; }
function input(name, type = "text") {const node = el("input"); node.type = type; node.setAttribute("aria-label", name); return node;}
function label(node) {const wrapper = el("label", `${node.getAttribute("aria-label")} `); wrapper.append(node); return wrapper;}
