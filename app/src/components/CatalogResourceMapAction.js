import {CatalogLayerPreview} from "./CatalogLayerPreview.js";
import {createCatalogPreviewLoader} from "../lib/catalogLayerPreview.js";

const PREVIEW_SOURCES = new Set(["arcgis", "wfs", "imageserver", "mapserver", "cog"]);
let previewSequence = 0;

// Catalog listing is metadata-only. The source and provider are read after a deliberate click.
export function CatalogResourceMapAction({dataset, adapter, load = null, beforeOpen = null}) {
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
    sourceVersion: dataset.preservationSummary?.sourceVersion ?? null
  };
  const loadPreview = load ?? createCatalogPreviewLoader({adapter});
  let loaded = false;
  button.addEventListener("click", async () => {
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
      panel.replaceChildren(await CatalogLayerPreview({record, adapter, load: loadPreview, interactive: true}));
      loaded = true;
    } catch (error) {
      status.textContent = `${error?.message || "Map preview unavailable"} No archived copy was used.`;
    } finally {
      button.disabled = false;
    }
  });
  return {button, panel};
}
