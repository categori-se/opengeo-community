import {
  hasSourceArchiveWorkflow, sourceArchiveContext, sourceArchivePlanRequest,
  validateSourceArchivePlan, sourceArchiveStartRequest, sourceArchiveControls
} from "../lib/sourceArchival.js";

/** Project-scoped archive workflow; no direct provider fetches or browser uploads.
 * Mount only when the authenticated adapter exposes the complete API contract.
 */
export function SourceArchivePanel({adapter, context: input}) {
  if (!hasSourceArchiveWorkflow(adapter)) throw new TypeError("The source archive API is not connected.");
  const context = sourceArchiveContext(input);
  const root = document.createElement("section");
  root.className = "project-source-archive";
  root.setAttribute("aria-label", "Source archive");
  const heading = element("h4", "Archive source");
  const body = document.createElement("div");
  const feedback = element("p", "");
  feedback.setAttribute("role", "status");
  root.append(heading, body, feedback);
  let busy = false, plan = null, job = null, request = null, requestId = null;
  const currency = (value) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 4}).format(value);
  async function run(operation) {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    feedback.textContent = "";
    try { await operation(); }
    catch (error) {
      feedback.textContent = error instanceof TypeError ? error.message : "The archive request could not be completed. Your saved progress is unchanged; try again.";
      if (!body.childElementCount) body.append(button("Retry loading captures", () => run(loadHistory)));
    }
    finally { busy = false; root.setAttribute("aria-busy", "false"); }
  }
  function initial(jobs = []) {
    body.replaceChildren(element("p", "Keep a recoverable copy independently of the provider. Reviewing a source does not start a transfer."));
    const label = element("label", "Preserve ");
    const choice = document.createElement("select");
    choice.setAttribute("aria-label", "What to preserve");
    for (const [value, title] of [["metadata", "Metadata and source documents"], ["originals_and_metadata", "All original files and metadata"]]) {
      const option = element("option", title); option.value = value; choice.append(option);
    }
    label.append(choice);
    body.append(label, element("p", "Scope: full source. A map image or the current view is not a backup of the original data."), button("Review size and cost", () => run(async () => {
      request = sourceArchivePlanRequest(context, choice.value);
      plan = validateSourceArchivePlan(await adapter.createSourceArchivePlan(request), request);
      requestId = crypto.randomUUID();
      review();
    })));
    if (jobs.length) {
      body.append(element("h5", "Previous captures"));
      for (const previous of jobs) body.append(button(`${previous.label ?? "Capture"} · ${previous.state}`, () => run(async () => {
        job = await adapter.getSourceArchiveJob({...context, jobId: previous.id});
        progress();
      })));
    }
  }
  function review() {
    const facts = document.createElement("dl");
    for (const [label, value] of [
      ["Scope", "Full source"], ["Files", plan.fileCount.toLocaleString()],
      ["Size", `${(plan.totalBytes / 1e9).toFixed(3)} GB`],
      ["Archive", plan.destination.label], ["Archive access", plan.destination.access],
      ["Estimated execution", currency(plan.estimatedExecutionCostUsd)],
      ["Execution limit", currency(plan.maximumExecutionCostUsd)],
      ["Estimated monthly storage", currency(plan.estimatedMonthlyStorageUsd)]
    ]) facts.append(element("dt", label), element("dd", value));
    const rights = check("I have permission to retain these files.");
    const accepted = check("I accept the archive destination, access and cost limits.");
    body.replaceChildren(facts, element("p", "Archive access is separate from project access. Storage and public downloads can continue to incur charges after capture."), rights.label, accepted.label,
      button("Back", () => initial()), button("Start capture", () => run(async () => {
        const start = sourceArchiveStartRequest(context, plan, {capture: request.capture,
          accepted: accepted.input.checked, rightsConfirmed: rights.input.checked, idempotencyKey: requestId});
        job = await adapter.startSourceArchiveCapture(start);
        progress();
      })));
  }
  function progress() {
    const count = `${job.verifiedFiles} of ${job.totalFiles} files verified`;
    body.replaceChildren(element("strong", count), element("p", `State: ${job.state}`),
      element("p", `${(job.verifiedBytes / 1e9).toFixed(3)} of ${(job.totalBytes / 1e9).toFixed(3)} GB verified`),
      element("p", "The capture runs on the server. Closing this panel or browser does not cancel it. Completed files are retained when you pause or cancel."));
    const labels = {pause: "Pause", resume: "Resume", retry: "Retry failed files", cancel: "Cancel remaining work"};
    for (const action of sourceArchiveControls(job)) body.append(button(labels[action], () => run(async () => {
      job = await adapter.controlSourceArchiveJob({...context, jobId: job.id, expectedRevision: job.revision,
        action, idempotencyKey: crypto.randomUUID()});
      progress();
    })));
    body.append(button("Refresh progress", () => run(async () => {
      job = await adapter.getSourceArchiveJob({...context, jobId: job.id});
      progress();
    })));
    if (job.state === "complete") body.append(element("p", "Capture verified. Keep the source inventory and file receipts with the archive. Rendering from the backup is a separate check."));
  }
  async function loadHistory() { initial(await adapter.listSourceArchiveJobs(context)); }
  void run(loadHistory);
  return root;
}

function element(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, action) {
  const node = element("button", label); node.type = "button";
  node.className = label === "Start capture" ? "platform-button" : "platform-button platform-button-secondary";
  node.addEventListener("click", action); return node;
}
function check(title) {
  const label = document.createElement("label"), input = document.createElement("input");
  label.className = "project-source-archive-consent";
  input.type = "checkbox"; label.append(input, element("span", title)); return {label, input};
}
