// Deliberate, version-pinned preview of a managed archive; no live provider needed.
export function CatalogArchivePreview({dataset, adapter, renderMap = async options => {
  const {MapView} = await import("./MapView.js");
  return MapView(options);
}}) {
  const root = document.createElement("section");
  root.className = "layer-resource-inspection layer-resource-archive-preview";
  root.setAttribute("aria-label", "Archived data preview");
  const action = document.createElement("button");
  action.type = "button";
  action.className = "platform-button";
  action.textContent = "Preview archived data";
  action.setAttribute("aria-expanded", "false");
  const note = document.createElement("p");
  note.className = "layer-metadata-note";
  note.textContent = "Loads a saved preview when selected. Previewing reads archived data; large datasets may show a sample.";
  const content = document.createElement("div");
  content.id = `archive-preview-${dataset.id}`;
  content.hidden = true;
  action.setAttribute("aria-controls", content.id);
  root.append(action, note, content);
  let loaded = false, disposed = false, controller = null, renderedMap = null;
  root.dispose = () => {
    disposed = true;
    controller?.abort();
    renderedMap?.dispose?.();
    renderedMap = null;
    content.replaceChildren();
  };
  action.addEventListener("click", async () => {
    if (disposed) return;
    content.hidden = !content.hidden;
    action.setAttribute("aria-expanded", String(!content.hidden));
    action.textContent = content.hidden ? "Preview archived data" : "Hide preview";
    if (content.hidden) return;
    if (loaded) {content.querySelector(".map-frame")?.__resize?.(); return;}
    action.disabled = true;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "Loading archived preview…";
    content.replaceChildren(status);
    const loadController = new AbortController();
    controller = loadController;
    try {
      const result = await adapter.getDatasetSpatialPreview(dataset.projectId, dataset.id, dataset.currentVersionId, {signal: loadController.signal});
      if (disposed || loadController.signal.aborted) return;
      if (result.datasetVersionId !== dataset.currentVersionId
          || result.geojson?.type !== "FeatureCollection"
          || !Array.isArray(result.geojson.features)
          || result.numberReturned !== result.geojson.features.length) throw Error("Preview identity changed");
      const map = await renderMap({geojson: result.geojson, geometryType: dataset.geometryType, height: "24rem"});
      if (disposed || loadController.signal.aborted) {map.dispose?.(); return;}
      renderedMap = map;
      const count = result.numberReturned.toLocaleString();
      const total = Number.isInteger(result.numberMatched) ? ` of ${result.numberMatched.toLocaleString()}` : "";
      const complete = result.mayBeTruncated === false && result.numberMatched === result.numberReturned;
      status.textContent = `${count}${total} features · ${complete ? "complete preview" : "sample preview, not complete coverage"}${dataset.currentVersionNumber ? ` · archived version ${dataset.currentVersionNumber}` : ""}`;
      content.replaceChildren(status, map);
      loaded = true;
    } catch {
      if (!disposed && !loadController.signal.aborted) status.textContent = "The archived preview could not load. Close and reopen to retry. Your access may have changed, or this file may not have a map preview.";
    } finally {
      if (controller === loadController) controller = null;
      action.disabled = false;
    }
  });
  return root;
}

export function canPreviewCatalogArchive(dataset, adapter) {
  return dataset.status === "active" && dataset.currentVersionState === "active"
    && typeof dataset.currentVersionId === "string" && dataset.capabilities?.read === true
    && dataset.sourceType === "upload"
    && ["geojson", "csv", "shapefile", "geopackage", "geoparquet"].includes(dataset.format)
    && typeof dataset.geometryType === "string"
    && !["document", "image", "raster"].includes(dataset.geometryType.toLowerCase())
    && typeof adapter.getDatasetSpatialPreview === "function";
}
