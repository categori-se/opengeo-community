export function WcsSubsetPreparation({state, service, coverage, refresh}) {
  const panel = element("details", "", "project-service-disclosure wcs-subset-preparation");
  panel.append(element("summary", "Prepare a WCS subset"));
  const form = element("form", "", "project-resource-editor-panel");
  const clauses = element("textarea"); clauses.rows = 2; clauses.maxLength = 513;
  const geographic = coverage.crs?.toUpperCase() === "EPSG:4326";
  clauses.placeholder = geographic ? "Long(west,east)\nLat(south,north)" : "x(min,max)\ny(min,max)";
  const label = element("label", "WCS subset clauses · one axis trim or slice per line"); label.append(clauses);
  const preview = element("button", "Preview WCS subset", "platform-button secondary"); preview.type = "submit";
  const prepare = element("button", "Prepare this WCS subset", "platform-button"); prepare.type = "button"; prepare.disabled = true;
  const feedback = element("p", "Preview calculates the exact source grid without creating work. Preparing explicitly queues a new COG; ordinary WCS reads never do.", "project-resource-feedback"); feedback.setAttribute("role", "status");
  const result = element("p");
  const allowed = state.organization.callerRole === "admin" || ["owner", "editor"].includes(state.project.callerRole);
  const available = !service.disabledAt && !coverage.withdrawnAt && !coverage.stale
    && typeof state.adapter.previewWcsSubset === "function";
  preview.disabled = !available;
  let plan = null, revision = 0, controller = null, busy = false;
  function invalidate() {
    revision++; controller?.abort(); plan = null; prepare.disabled = true; result.textContent = "";
    preview.disabled = !available || busy;
  }
  clauses.addEventListener("input", invalidate);
  panel.addEventListener("toggle", () => {if (!panel.open && !busy) invalidate();});
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (!available || busy) return;
    invalidate(); const current = revision;
    const subsets = clauses.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!subsets.length || subsets.length > 2) {feedback.textContent = "Enter one or two axis clauses, using the coverage’s native axis names."; return;}
    controller = new AbortController(); const active = controller;
    const timeout = setTimeout(() => active.abort(), 30_000);
    preview.disabled = true; feedback.textContent = "Calculating the exact WCS subset…";
    try {
      const candidate = await state.adapter.previewWcsSubset(state.project.id, service.slug, coverage.coverageName, subsets, {signal: active.signal});
      if (current !== revision || !panel.isConnected || !panel.open) return;
      if (candidate.coverageId !== coverage.id || candidate.serviceId !== service.id
        || candidate.datasetVersionId !== coverage.datasetVersionId) throw Error("changed target");
      plan = candidate;
      const recipe = plan.derivativeRequest;
      result.textContent = `${recipe.width} × ${recipe.height} pixels · ${recipe.targetCrs} · ${recipe.bandIndexes.length} bands · nearest-neighbor · extent ${recipe.subsetExtent.join(", ")}`;
      feedback.textContent = allowed ? "Preview ready. Prepare this exact subset to make the matching WCS request available. Identical prepared requests are reused."
        : "Preview ready. A project owner or editor must prepare this subset.";
      prepare.disabled = !allowed;
    } catch {
      if (current === revision) feedback.textContent = "The subset could not be previewed. Check axis names, coordinates, connection and coverage access, then retry. Your clauses are retained.";
    } finally {clearTimeout(timeout); if (current === revision) preview.disabled = !available;}
  });
  prepare.addEventListener("click", async () => {
    if (!plan || prepare.disabled || busy || !allowed) return;
    const selected = plan; busy = true; prepare.disabled = preview.disabled = clauses.disabled = true;
    feedback.textContent = "Preparing the exact subset…";
    try {
      const job = await state.adapter.createCoverageDerivative(state.project.id, service.id, coverage.id, selected.derivativeRequest);
      if (job.requestChecksumSha256 !== selected.requestChecksumSha256) throw Error("changed recipe");
      feedback.textContent = "Subset request accepted. Reopen the coverage to follow its progress and use the same WCS clauses when it is ready.";
      await refresh();
    } catch {feedback.textContent = "Preparation could not be confirmed. Your clauses are retained; reload the coverage’s derivative history before retrying.";}
  });
  if (!available) feedback.textContent = "Subset preparation requires a current, active coverage and a connected API that supports preview.";
  form.append(label, preview, result, prepare, feedback); panel.append(form); return panel;
}

function element(tag, text = "", className = "") {const node = document.createElement(tag); node.textContent = text; node.className = className; return node;}
