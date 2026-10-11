import {declaredCoordinateLayouts, coordinateLayoutNotice} from "../lib/coordinateLayout.js";
import {createManagedUploadSession, MANAGED_FORMATS} from "../lib/managedUpload.js";
import {DatasetVersionComparison} from "./DatasetVersionComparison.js";

const REASONS = {
  source_count_mismatch: "The processed count does not match the captured source. This candidate cannot be accepted.",
  bounded_source_subset: "This capture is limited to the approved number of features; it is not the full source.",
  capture_scope_changed: "The capture area or feature limit changed from the earlier version.",
  source_revision_changed: "The upstream source configuration changed from the earlier capture.",
  capture_count_evidence_unavailable: "This capture has no retained server count evidence.",
  source_count_unavailable: "The source's independent feature count is unknown.",
  coordinate_dimension_changed: "The declared coordinate dimension changed. Review potential Z or M loss.",
  coordinate_dimension_unavailable: "Coordinate dimension is not established for both versions.",
  fetched_count_unavailable: "The processed feature count is unknown.",
  empty_result: "The candidate is empty; the earlier version was not known to be empty.",
  schema_changed: "The recorded attribute schema changed.",
  geometry_type_changed: "The geometry type changed.", geometry_type_unavailable: "Geometry type information is incomplete.",
  crs_changed: "The coordinate reference system changed.", crs_unavailable: "Coordinate reference information is incomplete."
};

/** Deliberate upload, manual status refresh and exact-evidence acceptance. */
export function DatasetRefresh({adapter, dataset}) {
  const root = el("section"); root.setAttribute("aria-label", "Update Layer data");
  let disposed = false, busy = false, session = null, completed = false, versions = [], review = null;
  const status = el("p"); status.setAttribute("role", "status");
  const file = el("input"); file.type = "file"; file.accept = MANAGED_FORMATS[dataset.format]?.extensions.join(",") ?? "";
  file.setAttribute("aria-label", "Candidate data file");
  const candidates = el("select"); candidates.setAttribute("aria-label", "Staged data version");
  const result = el("div");
  const stage = button("Stage candidate", async () => {
    if (!session) {
      const selected = file.files?.[0]; if (!selected) throw Error("Choose a file first.");
      session = createManagedUploadSession({adapter, projectId: dataset.projectId, file: selected,
        name: dataset.name, classification: dataset.classification, format: dataset.format, tags: [],
        stagedTarget: {datasetId: dataset.id, baseVersionId: dataset.currentVersionId},
        assertCurrentScope: async () => {if (disposed) throw Error("This Layer view was closed.");},
        onStage: (_stage, message) => {if (!disposed) status.textContent = message;}});
    }
    const output = await session.run();
    if (output.dataset.id !== dataset.id) throw Error("The returned Layer identity changed.");
    session = null; file.value = "";
    await loadVersions(output.datasetVersionId);
    status.textContent = "Candidate queued. The current Layer is unchanged. Check processing when ready.";
  });
  const check = button("Check processing and candidates", () => loadVersions(candidates.value));
  const inspect = button("Review selected candidate", async () => {
    if (!candidates.value) throw Error("Choose an active candidate first.");
    review = null; result.replaceChildren();
    const value = await adapter.createDatasetRefreshReview(dataset.id, dataset.currentVersionId, candidates.value);
    if (disposed) return;
    review = value;
    result.append(el("h3", "Review before making this version current"));
    const old = value.evidence.base, next = value.evidence.candidate;
    const summary = el("table");
    for (const [label, before, after] of [["Version", old.versionId, next.versionId], ["Features", old.featureCount, next.featureCount], ["Geometry", old.geometryType, next.geometryType], ["CRS", old.crs, next.crs], ["Declared coordinate dimension", old.coordinateDimension, next.coordinateDimension], ["Declared coordinate layout", declaredCoordinateLayouts(old.schema), declaredCoordinateLayouts(next.schema)]]) {
      const row = el("tr"); row.append(el("th", label), el("td", before ?? "Unknown"), el("td", after ?? "Unknown")); summary.append(row);
    }
    result.append(summary, el("p", coordinateLayoutNotice(old.schema, next.schema)), workingCounts("Current version", old.schema), workingCounts("Candidate version", next.schema));
    if (value.evidence.sourceKind === "staged_source_capture") {
      const capture = next.capture;
      result.append(el("p", `Connected source revision ${capture.sourceRevision}. Counts apply to the approved capture area and limit.`));
      const counts = el("p", `Provider-reported query matches: ${capture.counts?.numberMatched ?? "Unknown"}. Expected in this capture: ${value.evidence.expectedFeatureCount ?? "Unknown"}. Inspected input features: ${next.featureCount ?? "Unknown"}.`);
      result.append(counts);
      const scope = el("details"); scope.append(el("summary", "Capture area and limits"), el("pre", JSON.stringify(capture.scope, null, 2))); result.append(scope);
    }
    for (const reason of value.evidence.reviewReasons) result.append(el("p", REASONS[reason] ?? reason));
    result.append(DatasetVersionComparison({versions: versions.filter(v => [dataset.currentVersionId, candidates.value].includes(v.id))}));
    const exact = el("details"); exact.append(el("summary", "Exact retained evidence"), el("pre", JSON.stringify(value.evidence, null, 2))); result.append(exact);
    if (value.decision === "rejected") {result.append(el("p", "This candidate cannot be accepted.")); return;}
    const acknowledgement = el("input"); acknowledgement.type = "checkbox";
    const label = el("label", "I reviewed the changes and the information that remains unknown. "); label.append(acknowledgement);
    const accept = button("Make this version current", async () => {
      if (!acknowledgement.checked || review !== value) throw Error("Review and acknowledge these changes first.");
      await adapter.acceptDatasetRefreshReview(dataset.id, value);
      if (disposed) return;
      completed = true; review = null; result.replaceChildren(el("p", "The reviewed version is now current. Prior versions and existing map/publication pins are retained. Reload the Layer page to inspect its updated state."));
      status.textContent = "Layer data updated.";
    });
    accept.disabled = true; acknowledgement.onchange = () => {accept.disabled = busy || !acknowledgement.checked;};
    result.append(label, accept);
    status.textContent = "Review ready. No data has been replaced yet.";
  });
  candidates.onchange = () => {review = null; result.replaceChildren();};
  file.onchange = () => {session = null;};
  root.append(el("h2", "Update Layer data"), el("p", `Stage a ${dataset.format} file under this Layer. Processing preserves the current version until you review and accept the candidate. Uploading uses managed storage and processing.`),
    file, stage, check, candidates, inspect, status, result);
  root.dispose = () => {disposed = true;};
  return root;

  async function loadVersions(selected = "") {
    const current = await adapter.getCatalogDataset(dataset.id);
    if (current.currentVersionId !== dataset.currentVersionId) throw Error("The current Layer version changed. Reload this page before continuing.");
    const values = await adapter.listDatasetVersions(dataset.projectId, dataset.id, {limit: 100});
    if (disposed) return;
    versions = values; review = null; result.replaceChildren(); candidates.replaceChildren(el("option", "Choose a candidate")); candidates.firstChild.value = "";
    for (const v of values.filter(v => v.parentVersionId === dataset.currentVersionId && !v.current)) {
      const option = el("option", `Version ${v.versionNumber} · ${v.state}`); option.value = v.id; option.disabled = v.state !== "active"; candidates.append(option);
    }
    if ([...candidates.options].some(v => v.value === selected && !v.disabled)) candidates.value = selected;
    status.textContent = values.length === 100 ? "Showing the latest 100 versions. Older candidates may be outside this page." : "Candidate status updated. Choose an active version to review; queued or failed versions cannot be accepted.";
  }
  function button(title, action) {
    const node = el("button", title); node.type = "button";
    node.onclick = async () => {
      if (busy || completed || disposed) return;
      busy = true;
      const controls = [...root.querySelectorAll("button,input,select")].map(c => [c, c.disabled]);
      controls.forEach(([c]) => {c.disabled = true;});
      try {await action();} catch (error) {
        if (!disposed) {
          review = null; result.replaceChildren();
          status.textContent = error?.status === 409 ? "The Layer or review changed, or this review was already accepted. Reload the Layer to check its current version before continuing."
            : [403,404].includes(error?.status) ? "You no longer have access to update this Layer."
            : error?.message || "The request failed. Check processing before trying again.";
        }
      } finally {busy = false; if (!disposed && !completed) controls.forEach(([c, disabled]) => {c.disabled = disabled;});}
    };
    return node;
  }
}
function el(tag, text = "") {const node = document.createElement(tag); node.textContent = text; return node;}

function workingCounts(title, schema) {
  const section = el("section");
  section.append(el("h4", `${title}: working-file counts`));
  const layers = Array.isArray(schema?.layers) ? schema.layers : [];
  if (!layers.length) section.append(el("p", "Independent working-file counts are unavailable for this version."));
  for (const [index, layer] of layers.entries()) {
    const evidence = layer?.working_count_evidence;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : "Unknown";
    section.append(el("p", `${layer?.name || `Layer ${index + 1}`}: input ${count(evidence?.source_count)}; working file ${count(evidence?.working_count)}. ${evidence?.status === "matched" ? "Recorded count check matched." : "Count verification unavailable."}`));
  }
  section.append(el("p", "Matching counts do not establish feature identity or geometry equivalence. See exact retained evidence for the inspection method."));
  return section;
}
