import {CatalogLayerPreview} from "./CatalogLayerPreview.js";
import {canPreviewCatalogManagedVector, createCatalogPreviewLoader} from "../lib/catalogLayerPreview.js";

const PREVIEW_SOURCES = new Set(["arcgis", "wfs", "imageserver", "mapserver", "cog", "xyz", "geojson", "postgis"]);
let previewSequence = 0;

// Catalog listing is metadata-only. The source and provider are read after a deliberate click.
export function CatalogResourceMapAction({dataset, adapter, load = null, beforeOpen = null, renderMap}) {
  const managed = canPreviewCatalogManagedVector(dataset, adapter);
  if (!managed && (dataset.status !== "active" || !dataset.capabilities?.read || !dataset.projectId
    || !PREVIEW_SOURCES.has(dataset.sourceType) || typeof adapter?.getSource !== "function")) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open map";
  button.className = "platform-button secondary platform-catalog-open-map";
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.id = `catalog-resource-map-${++previewSequence}`;
  panel.className = "platform-catalog-map-container";
  panel.hidden = true;
  button.setAttribute("aria-controls", panel.id);
  const record = {
    datasetId: dataset.id, projectId: dataset.projectId, title: dataset.name,
    geometryType: dataset.geometryType, resourcePreview: true,
    sourceType: dataset.sourceType, bbox: dataset.extent ?? null,
    sourceVersion: managed ? dataset.currentVersionNumber : dataset.preservationSummary?.sourceVersion ?? null,
    ...(managed ? {datasetVersionId: dataset.currentVersionId} : {})
  };
  let loadPreview = load ?? createCatalogPreviewLoader({adapter});
  let loaded = false, preview = null, disposed = false, attemptNumber = 0, activeAttempt = null, retryReady = false;
  const current = attempt => !disposed && activeAttempt === attempt && attempt.id === attemptNumber && !attempt.controller.signal.aborted;
  const dispose = () => {
    disposed = true;attemptNumber++;
    activeAttempt?.controller.abort();activeAttempt = null;
    if (!load) loadPreview?.dispose?.();
    preview?.dispose?.();
    preview = null;
    panel.replaceChildren();
    panel.hidden = true;
    panel.setAttribute("aria-busy", "false");
    button.disabled = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", async () => {
    if (disposed || activeAttempt) return;
    if (panel.hidden) beforeOpen?.();
    panel.hidden = retryReady ? false : !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) return;
    if (loaded) {panel.querySelector(".map-frame")?.__resize?.(); return;}
    const attempt = {id: ++attemptNumber, controller: new AbortController()};
    activeAttempt = attempt;
    loadPreview ??= createCatalogPreviewLoader({adapter});
    button.disabled = true;
    panel.setAttribute("aria-busy", "true");
    const status = document.createElement("p");
    status.textContent = "Loading Layer map… This is a temporary preview; it does not save a Project or retain another copy.";
    status.id = `${panel.id}-status-${attempt.id}`;
    status.setAttribute("role", "status");
    const cancel = document.createElement("button");cancel.type = "button";cancel.className = "platform-button secondary";
    cancel.textContent = "Cancel loading";cancel.setAttribute("aria-describedby", status.id);
    cancel.addEventListener("click", () => {
      if (!current(attempt)) return;
      attemptNumber++;activeAttempt = null;attempt.controller.abort();
      if (!load) {loadPreview.dispose?.();loadPreview = null;}
      retryReady = true;button.disabled = false;button.textContent = "Retry map";
      panel.setAttribute("aria-busy", "false");
      status.textContent = "Map loading cancelled. No saved Project or retained data was changed."
        + (load ? " Other previews may continue using shared Catalog reads." : "");
      panel.replaceChildren(status);
    });
    panel.replaceChildren(status, cancel);
    try {
      const candidate = await CatalogLayerPreview({record, adapter, load: loadPreview, interactive: true, renderMap, signal: attempt.controller.signal});
      if (!current(attempt)) {candidate.dispose?.(); return;}
      preview = candidate;
      panel.replaceChildren(preview);
      loaded = true;retryReady = false;button.textContent = "Open map";
    } catch (error) {
      if (current(attempt)) {
        retryReady = true;button.textContent = "Retry map";
        status.textContent = `${error?.message || "Map preview unavailable"} ${managed || dataset.sourceType === "geojson" ? "No other copy was used." : "No archived copy was used."}`;
        panel.replaceChildren(status);
      }
    } finally {
      if (current(attempt)) {
        activeAttempt = null;button.disabled = false;panel.setAttribute("aria-busy", "false");
      }
    }
  });
  return {button, panel, dispose};
}
