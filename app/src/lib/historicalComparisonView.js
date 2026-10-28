// The second view owns imagery and camera controls only. Project editing stays
// with the primary Workbench map; neither view changes source/date selections.
export function historicalComparisonIdentity(configuration, projection) {
  return JSON.stringify([configuration.sourceId, configuration.sourceRevision, configuration.comparison, projection]);
}

export function createHistoricalComparisonView({container, mainSurface, mainMap, adapter,
  primaryBasemap, comparisonBasemap, projection = "mercator", mode, divider = 50, onDividerChange = () => {}}) {
  const document = container.ownerDocument;
  const surface = document.createElement("div");
  surface.className = "gis-history-compare-surface";
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", `B imagery: ${comparisonBasemap.title}`);
  const canvas = document.createElement("div");
  canvas.className = "gis-renderer-surface";
  surface.append(canvas);
  const labels = document.createElement("div");
  labels.className = "gis-history-compare-labels";
  const createLabel = (letter, basemap) => {
    const label = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${letter}: ${basemap.title}`;
    const credit = document.createElement("span");
    credit.textContent = basemap.attribution;
    label.append(title, credit);
    if (basemap.selection.requestedDate !== basemap.selection.displayedDate) {
      const adjustment = document.createElement("span");
      adjustment.textContent = `Requested ${basemap.selection.requestedDate}; ${basemap.selection.reason}`;
      label.append(adjustment);
    }
    return label;
  };
  labels.append(createLabel("A", primaryBasemap), createLabel("B", comparisonBasemap));
  let primaryLabelIdentity = JSON.stringify(primaryBasemap);
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "Loading B imagery…";
  labels.lastElementChild.append(status);
  const control = document.createElement("label");
  control.className = "gis-history-compare-divider";
  const caption = document.createElement("span");
  caption.textContent = "Swipe divider";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.step = "1";
  range.setAttribute("aria-label", "Imagery swipe divider");
  control.append(caption, range);
  container.append(surface, labels, control);
  const originalWidth = mainSurface.style.getPropertyValue("width");
  const originalPriority = mainSurface.style.getPropertyPriority("width");
  let map = null, observer = null, disposed = false, synchronizing = false;
  let currentMode, currentDivider;
  let imageryFailed = false, imageryUpdatedAfterError = false;
  const camera = map => ({center: map.getCenter(), zoom: map.getZoom(),
    bearing: map.getBearing(), pitch: map.getPitch()});
  const synchronize = (from, to) => {
    if (disposed || synchronizing) return;
    synchronizing = true;
    try { to.jumpTo(camera(from)); } finally { synchronizing = false; }
  };
  const followPrimary = () => synchronize(mainMap, map);
  const followComparison = () => { if (currentMode === "side-by-side") synchronize(map, mainMap); };
  const setImageryStatus = message => { if (status.textContent !== message) status.textContent = message; };
  const recoveredMessage = "B imagery updated; previous tile errors may leave gaps.";
  const failureMessage = "B imagery could not load. A remains available.";
  const loading = () => {
    if (!disposed) setImageryStatus(imageryFailed ? "Loading B imagery; previous tile errors may leave gaps." : "Loading B imagery…");
  };
  const loaded = event => {
    // Metadata or idle alone does not prove recovery. Require a decoded tile
    // from this source, and retain the warning because other tiles may fail.
    if (disposed || !imageryFailed || event?.sourceId !== "imagery"
      || event.tile?.state !== "loaded" || event.tile.aborted) return;
    imageryUpdatedAfterError = true;
    setImageryStatus(recoveredMessage);
  };
  const ready = () => {
    if (!disposed) setImageryStatus(imageryFailed
      ? imageryUpdatedAfterError ? recoveredMessage : failureMessage
      : "B imagery ready; provider gaps and clouds may remain.");
  };
  const failed = () => {
    if (disposed) return;
    imageryFailed = true;
    imageryUpdatedAfterError = false;
    setImageryStatus(failureMessage);
  };
  const resize = () => {
    if (disposed) return;
    mainMap.resize();
    map?.resize();
  };
  const clip = () => {
    surface.style.clipPath = currentMode === "swipe" ? `inset(0 0 0 ${currentDivider}%)` : "none";
    range.value = `${currentDivider}`;
    range.setAttribute("aria-valuetext", `${currentDivider}% A, ${100 - currentDivider}% B`);
  };
  const changeDivider = () => {
    currentDivider = Number(range.value);
    clip();
    onDividerChange(currentDivider);
  };
  const update = ({mode, divider, primaryBasemap}) => {
    if (disposed) return;
    if (primaryBasemap && JSON.stringify(primaryBasemap) !== primaryLabelIdentity) {
      labels.firstElementChild.replaceWith(createLabel("A", primaryBasemap));
      primaryLabelIdentity = JSON.stringify(primaryBasemap);
    }
    const changed = currentMode !== mode;
    currentMode = mode;
    currentDivider = divider;
    const sideBySide = mode === "side-by-side";
    mainSurface.style.setProperty("width", sideBySide ? "50%" : "100%", "important");
    surface.style.left = sideBySide ? "50%" : "0";
    surface.style.pointerEvents = sideBySide ? "auto" : "none";
    surface.inert = !sideBySide;
    control.hidden = sideBySide;
    clip();
    if (changed) resize();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    mainMap.off("move", followPrimary);
    map?.off("move", followComparison);
    map?.off("sourcedataloading", loading);
    map?.off("sourcedata", loaded);
    map?.off("idle", ready);
    map?.off("error", failed);
    observer?.disconnect();
    range.removeEventListener("input", changeDivider);
    adapter.disposeMap(map);
    surface.remove(); labels.remove(); control.remove();
    if (originalWidth) mainSurface.style.setProperty("width", originalWidth, originalPriority);
    else mainSurface.style.removeProperty("width");
    mainMap.resize();
  };
  try {
    map = adapter.createMap({container: canvas, ...camera(mainMap),
      style: {version: 8, projection: {type: projection}, sources: {
        imagery: {type: "raster", tiles: [comparisonBasemap.url], tileSize: comparisonBasemap.tileSize,
          minzoom: comparisonBasemap.minZoom, maxzoom: comparisonBasemap.maxZoom,
          scheme: comparisonBasemap.scheme, attribution: comparisonBasemap.attribution}
      }, layers: [
        // A must never show through B's transparent pixels or unloaded tiles.
        {id: "background", type: "background", paint: {"background-color": "#061526"}},
        {id: "imagery", type: "raster", source: "imagery"}
      ]},
      attributionControl: false,
      transformRequest: url => ({url, credentials: "omit", referrerPolicy: "no-referrer"})
    });
    mainMap.on("move", followPrimary);
    map.on("move", followComparison);
    map.on("sourcedataloading", loading);
    map.on("sourcedata", loaded);
    map.on("idle", ready);
    map.on("error", failed);
    range.addEventListener("input", changeDivider);
    const ResizeObserver = document.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (ResizeObserver) { observer = new ResizeObserver(resize); observer.observe(container); }
    update({mode, divider});
    followPrimary();
  } catch (error) {
    // Constructors can leave a partial canvas behind. Keep A usable on failure.
    dispose();
    throw error;
  }
  return {mainMap, update, dispose};
}
