import {previewCapabilityUrl} from './FrameworkProjectPreview.js';

/** Reopen durable jobs, never infer completion or start another build on reload. */
export function FrameworkBuildHistory({adapter, projectId, sourceProjectId, canManage = false}) {
  const root = element("section", "");
  root.className = "framework-build-history";
  root.append(element("h4", "Build history"));
  const feedback = element("p", ""); feedback.setAttribute("role", "status");
  const list = element("div", "");
  let offset = 0, busy = false, generation = 0;
  let githubDispatches = new Map();
  const reload = button("Reload build history", () => load());
  const previous = button("Newer builds", () => load(Math.max(0, offset - 25)));
  const next = button("Older builds", () => load(offset + 25));
  const controls = element("div", ""); controls.className = "platform-actions";
  controls.append(reload, previous, next);
  root.append(feedback, list, controls);
  async function load(requestedOffset = offset) {
    if (busy) return;
    busy = true; const epoch = ++generation;
    reload.disabled = previous.disabled = next.disabled = true;
    list.replaceChildren(); // Do not retain actionable records after a failed authorization check.
    feedback.textContent = "Reading saved build jobs…";
    try {
      const [jobs, github] = await Promise.all([
        adapter.listObservableBuildJobs(projectId, sourceProjectId, {limit: 25, offset: requestedOffset}),
        typeof adapter.listObservableGitHubDispatches === "function"
          ? adapter.listObservableGitHubDispatches(projectId, sourceProjectId, {limit: 25, offset: requestedOffset}).catch(() => null)
          : Promise.resolve([])
      ]);
      if (epoch !== generation) return;
      if (!Array.isArray(jobs) || jobs.length > 25 || jobs.some(job => job.sourceProjectId !== sourceProjectId)) throw new Error("build_history_scope_mismatch");
      offset = requestedOffset;
      githubDispatches = new Map((github ?? []).map(record => [record.buildJobId, record]));
      feedback.textContent = jobs.length ? `Saved builds ${offset + 1}–${offset + jobs.length}. Reopening history does not launch work.` : "No saved builds on this page. Import and commit source before requesting a preview.";
      for (const job of jobs) list.append(jobCard(job, epoch));
      if (github === null) feedback.textContent += " GitHub dispatch status is currently unavailable; reload history to check it.";
      previous.disabled = offset === 0;
      next.disabled = jobs.length < 25;
    } catch (error) {
      feedback.textContent = `Build history could not be read (${error?.code ?? "request_failed"}). No build was started. Retry loading history.`;
    } finally {busy = false; reload.disabled = false;}
  }
  function jobCard(initial, epoch) {
    const card = element("article", "");
    let job = initial, working = false;
    const status = element("p", ""); status.setAttribute("role", "status");
    const summary = element("p", "");
    const details = element("p", "");
    const review = element("details", "");
    review.className = "framework-build-review";
    const check = button("Refresh this build", () => act(async () => {
      const [current, github] = await Promise.all([
        adapter.getObservableBuildJob(projectId, job.id),
        typeof adapter.listObservableGitHubDispatches === "function"
          ? adapter.listObservableGitHubDispatches(projectId, sourceProjectId, {limit: 25, offset})
          : Promise.resolve([])
      ]);
      if (epoch === generation) githubDispatches = new Map(github.map(record => [record.buildJobId, record]));
      return current;
    }));
    const dispatch = button("Resume queued build", () => {
      if (!canManage || dispatch.hidden || dispatch.disabled || epoch !== generation) return;
      return act(() => adapter.dispatchObservableBuildJob(projectId, job.id));
    });
    const preview = button("Open private preview", async () => {
      if (working || preview.hidden || preview.disabled || epoch !== generation) return;
      const popup = globalThis.open('about:blank', '_blank');
      if (!popup) {status.textContent = 'Allow a new window for the private preview, then try again.'; return;}
      popup.opener = null;
      working = true; preview.disabled = true;
      try {
        const capability = await adapter.createObservablePreviewCapability(projectId, job.id);
        if (epoch === generation) popup.location.replace(previewCapabilityUrl(capability, {previewOrigins: adapter.previewOrigins,
          studioOrigin: root.ownerDocument.location?.origin, runtimeProfile: 'local_only'}));
        else popup.close();
      } catch (error) {popup.close(); status.textContent = `Preview unavailable (${error?.code ?? "request_failed"}). Nothing was published.`;}
      finally {working = false; preview.disabled = false;}
    });
    function reflect() {
      summary.textContent = `Revision ${job.sourceRevisionNumber} · ${job.purpose} · ${job.state}`;
      details.textContent = `Build ${job.id} · attempts ${job.attemptCount} · updated ${job.updatedAt}${job.errorCode ? ` · ${job.errorCode}` : ""}`;
      status.textContent = job.executionAvailable ? "Execution service configured. A build is not a published release." : "Execution service is not configured. This saved job will not run until an executor is connected.";
      const github = githubDispatches.get(job.id);
      if (github) {
        const stages = {syncing: "Retaining the exact source revision in GitHub", ready: "Source retained; preparing build dispatch",
          dispatching: "Dispatch requested; reconciling the original run", dispatched: "GitHub run registered",
          completed: "GitHub execution completed; retained output is verified separately", failed: "GitHub execution needs attention"};
        status.textContent = `${stages[github.stage]}${github.runStatus ? ` · ${github.runStatus.replaceAll("_", " ")}` : ""}${github.errorCode ? ` · ${github.errorCode}` : ""}. Publication status is shown separately below; build history does not indicate whether this output is live.`;
        if (github.runUrl) {
          const link = element("a", "Open GitHub progress and logs"); link.href = github.runUrl;
          link.target = "_blank"; link.rel = "noopener noreferrer"; status.append(" ", link);
        }
      }
      dispatch.hidden = !canManage || job.state !== "pending" || !job.executionAvailable ||
        ["dispatched", "completed", "failed"].includes(github?.stage) || typeof adapter.dispatchObservableBuildJob !== "function";
      preview.hidden = job.state !== "succeeded" || job.purpose !== "preview" || typeof adapter.createObservablePreviewCapability !== "function";
      check.disabled = dispatch.disabled = false;
      review.replaceChildren(element("summary", "Review pinned source and built routes"));
      const facts = element("dl", "");
      for (const [label, value] of [
        ["Source revision", job.sourceRevisionId],
        ["GitHub source commit", github?.sourceCommit],
        ["Source manifest SHA-256", job.request?.sourceManifestChecksumSha256],
        ["Compiler image", job.request?.compilerImageDigest],
        ["Build request SHA-256", job.requestChecksumSha256],
        ["Retained result SHA-256", job.resultChecksumSha256],
        ["Output tree SHA-256", job.result?.outputTreeChecksumSha256]
      ]) facts.append(element("dt", label), element("dd", value ?? "Not available"));
      review.append(facts);
      if (canManage && github?.retainedLogs) {
        const logs = github.retainedLogs;
        const logView = element("details", "");
        logView.append(element("summary", "Retained GitHub log excerpt"));
        logView.append(element("p", `Captured ${logs.capturedAt} · ${logs.state}${logs.truncated ? " · truncated" : ""}. Redacted, bounded excerpt; not a complete log archive.`));
        const excerpt = element("pre", logs.text);
        excerpt.style.whiteSpace = "pre-wrap"; excerpt.style.overflowWrap = "anywhere";
        logView.append(excerpt);
        if (logs.checksumSha256) logView.append(element("p", `Excerpt SHA-256: ${logs.checksumSha256}`));
        review.append(logView);
      }
      if (job.state === "succeeded" && job.result) {
        const files = job.result.outputManifest.files;
        review.append(element("p", `${files.length} retained output files · ${files.reduce((total, file) => total + file.sizeBytes, 0)} bytes. These are build-relative routes, not live public URLs.`));
        const table = element("table", "");
        const head = element("thead", ""); const titles = element("tr", "");
        for (const label of ["Route", "Output file"]) titles.append(element("th", label));
        head.append(titles); const body = element("tbody", "");
        for (const route of job.result.routeManifest) {
          const row = element("tr", "");
          row.append(element("td", route.path), element("td", route.file)); body.append(row);
        }
        table.append(head, body); review.append(table);
        review.append(element("p", "Build output and public activation are separate records. Check the publication section below for destination approval and deployment status."));
      } else review.append(element("p", "No completed output is available for review."));
    }
    async function act(operation) {
      if (working || epoch !== generation) return;
      working = true; check.disabled = dispatch.disabled = true;
      try {
        const updated = await operation();
        if (updated.id !== job.id || updated.sourceProjectId !== sourceProjectId) throw new Error("build_identity_mismatch");
        if (epoch !== generation) return;
        job = updated; reflect();
      } catch (error) {
        status.textContent = `Could not observe this build (${error?.code ?? "request_failed"}). Its server state is unknown; no replacement was started.`;
        dispatch.hidden = preview.hidden = true;
      } finally {working = false; check.disabled = false;}
    }
    card.append(summary, details, status, check, dispatch, preview, review); reflect(); return card;
  }
  root.reload = () => load(0);
  if (typeof adapter.listObservableBuildJobs === "function") void load();
  else {feedback.textContent = "Durable build history requires the updated publication API."; reload.disabled = previous.disabled = next.disabled = true;}
  return root;
}
function element(tag, value) {const node = document.createElement(tag); node.textContent = value; return node;}
function button(label, action) {const node = element("button", label); node.type = "button"; node.className = "platform-button secondary"; node.addEventListener("click", action); return node;}
