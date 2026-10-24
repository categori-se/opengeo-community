import {readCogPreview, cogPreviewCanvas, sampleCogPreview, releaseCogPreview, cogGridView} from "./cogPreview.js";

const sessions = new WeakMap();
// Temporary Catalog maps and saved Projects share this renderer. Canonical
// records contain the provider reference, never a canvas or decoded imagery.
export function installCogMapLayer(map, {sourceId, layerId, source, opacity = 1, visible = true,
  displayOptions = {}, onStatus = () => {}, onReady = () => {}, read = readCogPreview} = {}) {
  const live = sessions.get(map) ?? new Set(); sessions.set(map, live);
  if (live.size >= 4) throw Error("Four COG previews are already active in this map. Other Layer references are preserved.");
  let disposed = false, controller = null, canvas, lastResult, generation = 0;
  let appliedDisplay = structuredClone(displayOptions);
  const handle = {refresh, dispose, cancel() {generation++; controller?.abort();}, setVisible(value) {
    visible = Boolean(value);
    if (!visible) controller?.abort();
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    else if (visible && (!controller || controller.signal.aborted) && !lastResult) void refresh().catch(() => {});
  }, setOpacity(value) {opacity = value; if (map.getLayer(layerId)) map.setPaintProperty(layerId, "raster-opacity", opacity);},
  identify(longitude, latitude) {return !disposed && visible ? sampleCogPreview(lastResult, longitude, latitude) : {status: "unavailable"};},
  get grid() {const view=!disposed&&visible?cogGridView(lastResult):null;
    return view?Object.freeze({...view,active:()=>!disposed&&visible&&view.active()}):null;},
  get loading() {return Boolean(controller && !controller.signal.aborted);}, get result() {return lastResult;}}; live.add(handle);
  map.on("remove", dispose);
  map.on("styledata", styleChanged);
  function styleChanged() {if (canvas && !map.getSource(sourceId)) dispose();}
  async function refresh(bounds = source.configuration.bounds, display = appliedDisplay) {
    const {displayRange = null, noDataValue = null} = display;
    if (disposed || !visible) return;
    controller?.abort(); const request = new AbortController(); controller = request;
    const currentGeneration = ++generation;
    const current = () => !disposed && generation === currentGeneration && !request.signal.aborted;
    try {
      const result = await read(source, {bounds, displayRange, noDataValue, signal: request.signal, onStatus: message => {if (current()) onStatus(message);}});
      if (!current()) {releaseCogPreview(result);return;}
      const next = cogPreviewCanvas(result);
      if (!canvas) {
        canvas = next;
        // MapLibre canvas sources do not expose source attribution. Workbench
        // renders the saved credit as text in its map attribution footer.
        map.addSource(sourceId, {type: "canvas", canvas, coordinates: result.coordinates, animate: false});
        map.addLayer({id: layerId, type: "raster", source: sourceId, layout: {visibility: visible ? "visible" : "none"},
          paint: {"raster-opacity": opacity, "raster-fade-duration": 0}});
      } else {
        const ink = canvas.getContext("2d");
        ink.clearRect(0, 0, canvas.width, canvas.height);
        ink.drawImage(next, 0, 0);
        map.getSource(sourceId)?.setCoordinates(result.coordinates);
      }
      const native = map.getSource(sourceId);
      native?.play(); map.triggerRepaint();
      requestAnimationFrame(() => {if (current()) native?.pause();});
      if (lastResult !== result) releaseCogPreview(lastResult);lastResult = result;
      appliedDisplay = structuredClone(display);
      onStatus(`Raster view ready · ${result.overviewScale > 1 ? "overview" : "full source resolution"}${result.snapshot.verified ? "" : " · snapshot unverified (provider headers hidden)"}. Pan or zoom, then refresh to read another window.`);
      onReady(result);
      return result;
    } catch (error) {
      if (current()) onStatus(`${error.message || "Raster unavailable"} The Layer reference remains preserved.`);
      if (current()) throw error;
    } finally {if (controller === request) controller = null;}
  }
  function dispose() {
    if (disposed) return; disposed = true; generation++; controller?.abort(); live.delete(handle);
    map.off("remove", dispose);
    map.off("styledata", styleChanged);
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch { /* Native removal may already have destroyed the style. */ }
    canvas = null; releaseCogPreview(lastResult);lastResult = null;
  }
  return handle;
}
