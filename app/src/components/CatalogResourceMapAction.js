import {CatalogLayerPreview} from "./CatalogLayerPreview.js";
import {createCatalogPreviewLoader} from "../lib/catalogLayerPreview.js";

const PREVIEW_SOURCES = new Set(["arcgis", "wfs", "imageserver", "mapserver", "cog", "xyz", "geojson", "postgis"]);
let previewSequence = 0;

// Catalog listing is metadata-only. The source and provider are read after a deliberate click.
export function CatalogResourceMapAction({dataset, adapter, load = null, beforeOpen = null, renderMap}) {
  if (dataset.status !== "active" || !dataset.capabilities?.read || !dataset.projectId
    || !PREVIEW_SOURCES.has(dataset.sourceType) || typeof adapter?.getSource !== "function") return null;

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
    sourceVersion: dataset.preservationSummary?.sourceVersion ?? null
  };
  const loadPreview = load ?? createCatalogPreviewLoader({adapter});
  const controller = new AbortController();
  let loaded = false, preview = null;
  const dispose = () => {
    controller.abort();
    if (!load) loadPreview.dispose?.();
    preview?.dispose?.();
    preview = null;
    panel.replaceChildren();
    panel.hidden = true;
    button.disabled = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", async () => {
    if (controller.signal.aborted) return;
    if (panel.hidden) beforeOpen?.();
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) return;
    if (loaded) {panel.querySelector(".map-frame")?.__resize?.(); return;}
    button.disabled = true;
    const status = document.createElement("p");
    status.textContent = "Loading Layer map…";
    status.setAttribute("role", "status");
    panel.replaceChildren(status);
    try {
      preview = await CatalogLayerPreview({record, adapter, load: loadPreview, interactive: true, renderMap, signal: controller.signal});
      if (controller.signal.aborted) {preview.dispose?.(); preview = null; return;}
      panel.replaceChildren(preview);
      loaded = true;
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = `${error?.message || "Map preview unavailable"} ${dataset.sourceType === "geojson" ? "No other copy was used." : "No archived copy was used."}`;
    } finally {
      if (!controller.signal.aborted) button.disabled = false;
    }
  });
  return {button, panel, dispose};
}
