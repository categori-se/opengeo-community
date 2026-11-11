import {CompatibilityMapControls} from "../components/CompatibilityMapControls.js";
import {openlayersCanvasCompatibility} from "./openlayersCanvasContent.js";
import {readWorkspaceMode, writeWorkspaceMode, WORKSPACE_MODE_SCHEMA_VERSION} from "./workspaceMode.js";
import {ESRI_BASEMAP_OPTIONS} from "./esriBasemaps.js";

const MODES = new Set(["openlayers-canvas", "data-workspace"]);
const flatView = value => ({center: [wrap(value?.center?.[0] ?? 0), Math.max(-85.05112878, Math.min(85.05112878, value?.center?.[1] ?? 20))],
  zoom: Math.max(-1, Math.min(23, value?.zoom ?? 2)), bearing: wrap(value?.bearing ?? 0), pitch: 0});
function wrap(value) {return ((value + 180) % 360 + 360) % 360 - 180;}
function node(tag, text) {const element = document.createElement(tag);if (text !== undefined) element.textContent = text;return element;}
function button(label, action) {const element = node("button", label);element.type = "button";element.onclick = action;return element;}

// A separate, capability-based workspace. state.map remains a native GL map or
// null; neither Canvas nor data mode simulates MapLibre's paint/source API.
export function createCompatibilityWorkspace(context, actions) {
  const saved = readWorkspaceMode(context.project);
  let runtime = null, surface = null, controls = null, mode = saved?.mode ?? null, pending = null, closed = false;
  let view = flatView(saved?.view ?? context.project?.mapViews?.[0]);
  let basemapId = saved?.basemapId ?? "blank", backgroundExportAllowed = saved?.backgroundExportAllowed ?? false;
  let explicit = Boolean(saved), drawing = false, lastMeasurement = null, contentKey = null, syncing = false, runtimeFault = null;
  context.workspaceMode = mode;
  const objectIds = new WeakMap();let nextObject = 0;
  const objectId = value => {if (!value || typeof value !== "object") return 0;if (!objectIds.has(value)) objectIds.set(value, ++nextObject);return objectIds.get(value);};
  const preference = () => ({schemaVersion: WORKSPACE_MODE_SCHEMA_VERSION, mode, view: {...view, center: [...view.center]}, basemapId, backgroundExportAllowed});
  const basemap = () => basemapId === "esri-public-imagery"
    ? {...ESRI_BASEMAP_OPTIONS.find(item => item.id === "public-imagery"), id: basemapId, maxZoom: 23, scheme: "xyz", exportAllowed: backgroundExportAllowed}
    : null;
  const report = () => runtime?.getCompatibilityReport() ?? openlayersCanvasCompatibility({layers: context.layers, dataByLayerId: context.dataByLayerId, basemap: basemap()});
  const unavailable = () => {
    if (mode === "data-workspace") return "Data workspace has no map image. Choose 2D compatibility or full graphics before capturing.";
    if (!runtime) return "The 2D map is not ready. Your Layers, tables and Project remain available.";
    if (runtimeFault) return runtimeFault;
    const issue = report().layers.find(item => item.visible && item.status === "unavailable");
    if (issue) return `${issue.title}: unavailable in the Canvas image. Hide this Layer or use a compatible renderer before capture.`;
    if (basemap() && !backgroundExportAllowed) return "Confirm permission to export the selected raster background, or use Plain background.";
    if (report().canCapture === false) return "The visible Canvas content cannot currently be captured. Finish drawing and review source permissions or background errors.";
    return null;
  };
  const status = text => {if (!closed) actions.status(text);};
  const draw = result => {
    drawing = false;
    if (closed || !MODES.has(mode)) return;
    if (result.measurement) {
      lastMeasurement = result.measurement;
      actions.measurement?.(result.measurement);
      status("Measurement calculated from the same geographic geometry model used by full graphics. Elevation and accuracy remain separate.");
    } else if (actions.canEdit()) actions.geometry(result);
    else status("This Project is read-only. The drawn geometry was not added.");
  };
  async function select(next) {
    if (closed || context.disposed) return false;
    if (!MODES.has(next) && next !== "maplibre") throw Error("Choose full graphics, 2D compatibility or the data workspace.");
    if (drawing) throw Error("Finish or cancel the current drawing before changing display modes.");
    if (context.state.mapAuthoring || context.state.authoringCoordinateDraft || context.state.shapeEditor || context.state.imageOverlayEditor) {
      throw Error("Finish or cancel the open geometry editor before changing display modes. Its draft remains in the current workspace.");
    }
    if (pending) throw Error("A display mode is opening. Wait or cancel the switch first.");
    if (next === "maplibre") return full();
    if (next === mode && surface && !runtimeFault) return true;
    if (next === "openlayers-canvas" && context.state.spatialBody?.id !== "earth") throw Error("2D compatibility currently supports Earth coordinates. The data workspace keeps this Project's original body and definitions.");
    const controller = new AbortController();pending = controller;
    context.rendererSwitchStatus = {pending: true, message: next === "openlayers-canvas" ? "Opening the Canvas map…" : "Opening the data workspace…"};
    context.render();
    let candidate = null, candidateSurface = null;
    try {
      if (next === "openlayers-canvas") {
        runtimeFault = null;
        actions.hydrateData();
        candidateSurface = node("div");candidateSurface.className = "gis-renderer-surface gis-canvas-surface";
        candidateSurface.inert = true;candidateSurface.setAttribute("aria-hidden", "true");context.mapContainer.append(candidateSurface);
        const factory = context.canvasRuntimeFactory ?? (await import("./openlayersCanvasWorkbench.js")).createOpenLayersCanvasWorkbench;
        candidate = await factory({container: candidateSurface, layers: context.layers, dataByLayerId: context.dataByLayerId,
          view, basemap: basemap(), onViewChange: value => {view = flatView(value);actions.telemetry();},
          onIdentify: actions.identify, onDraw: draw, onError: message => {runtimeFault = `${message} Reopen 2D compatibility or use the data workspace.`;status(`${runtimeFault} Layers and data remain available.`);notify();}});
      }
      if (closed || controller.signal.aborted || context.disposed) return false;
      actions.retainFullCamera();actions.releaseGraphics();
      try {runtime?.dispose();} catch { /* Keep the replacement workspace usable. */ }surface?.remove();
      runtime = candidate;candidate = null;surface = candidateSurface ?? node("div");candidateSurface = null;
      if (!surface.isConnected) context.mapContainer.append(surface);
      surface.className = "gis-renderer-surface gis-canvas-surface";surface.inert = false;surface.removeAttribute("aria-hidden");
      if (context.mapSurface !== surface) context.mapSurface.remove();context.mapSurface = surface;
      mode = next;explicit = true;controls = null;contentKey = null;
      context.workspaceMode = mode;context.rendererAdapter = Object.freeze({id: mode, disposeMap() {}});
      context.state.map = null;context.shell.__opengeoMap = null;context.state.mapInitializationFailed = false;
      context.state.mapOnly = false;context.state.rightOpen = true;context.state.activePanel = mode === "openlayers-canvas" ? "compatibility" : "attributes";
      if (mode === "data-workspace") surface.append(node("h2", "Data workspace"), node("p", "Catalog, loaded tables, evidence, analysis, saving and downloads remain available. An interactive map is not running."));
      status(mode === "openlayers-canvas" ? "2D compatibility is active. Review unavailable Layers and display differences before interpreting or exporting the map." : "Data workspace is active. Your Project, Layers, original views and Styles are retained.");
      return true;
    } catch (error) {
      context.canvasInitializationError = error?.message ?? "Canvas initialization failed";
      status("The selected display mode could not open. Your current workspace and Project are retained.");
      context.rendererSwitchStatus = {message: error.message};return false;
    } finally {
      try {candidate?.dispose();} catch { /* Partial Canvas creation. */ }candidateSurface?.remove();pending = null;
      context.rendererSwitchStatus = {message: context.state.statusMessage};
      if (!closed && !context.disposed) {context.render();notify();}
    }
  }
  async function full() {
    if (!mode) return true;
    const controller = new AbortController();pending = controller;
    const candidateSurface = node("div");candidateSurface.className = "gis-renderer-surface gis-renderer-candidate";
    candidateSurface.inert = true;candidateSurface.setAttribute("aria-hidden", "true");context.mapContainer.append(candidateSurface);
    context.rendererSwitchStatus = {pending: true, message: "Checking full graphics. The current workspace remains available."};context.render();
    let candidate;
    const previousMode = mode, previousSurface = surface, previousAdapter = context.rendererAdapter;
    try {
      candidate = await actions.prepareFull(candidateSurface, controller.signal);
      if (closed || controller.signal.aborted || context.disposed) return false;
      context.workspaceMode = null;context.mapSurface = candidateSurface;
      candidateSurface.inert = false;candidateSurface.removeAttribute("aria-hidden");
      actions.adoptFull(candidate, candidateSurface);
      if (context.state.mapInitializationFailed) throw Error("Full graphics setup failed");
      try {runtime?.dispose();} catch { /* The prepared full renderer is ready. */ }runtime = null;surface?.remove();surface = null;controls = null;mode = null;explicit = true;candidate = null;
      status("Full graphics is active. The original full-graphics camera, Layers and Styles are retained.");return true;
    } catch {
      mode = previousMode;context.workspaceMode = previousMode;context.mapSurface = previousSurface;context.rendererAdapter = previousAdapter;
      context.state.map = null;context.shell.__opengeoMap = null;context.state.mapInitializationFailed = false;
      status("Full graphics could not initialize. The current workspace is still available; its Layers and edits are retained.");return false;
    }
    finally {
      if (candidate) actions.disposeFull(candidate);
      if (mode) candidateSurface.remove();pending = null;context.rendererSwitchStatus = {message: context.state.statusMessage};
      if (!closed && !context.disposed) {context.render();notify();}
    }
  }
  function notify() {context.shell.dispatchEvent(new context.shell.ownerDocument.defaultView.Event("print-context-change", {bubbles: true}));}
  function sync() {
    if (!mode || closed || syncing) return;
    actions.hydrateData();
    const key = JSON.stringify({layers: context.layers.map(layer => [layer.layerId, layer.visible, layer.opacity, layer.style, layer.labels, layer.styleReference, layer.filter,
      layer.featureGeneration, objectId(context.dataByLayerId.get(layer.layerId)), context.dataByLayerId.get(layer.layerId)?.features?.length]), basemapId, backgroundExportAllowed});
    if (key !== contentKey) {
      syncing = true;contentKey = key;
      try {runtime?.setLayers(context.layers, context.dataByLayerId, {basemap: basemap()});controls?.updateReport?.(report());}
      catch {runtimeFault = "The Canvas display could not update. Reopen 2D compatibility or use the data workspace.";status(runtimeFault);}
      finally {syncing = false;notify();}
    }
  }
  function navigate(value) {
    if (!runtime) return;
    const current = runtime.getView();
    if (value.action === "fit-layers") for (const layer of context.layers.filter(item => item.visible !== false)) {
      const data = context.dataByLayerId.get(layer.layerId);if (data?.features?.length) {runtime.fitGeoJSON(data);break;}
    }
    else runtime.setView(value.action === "zoom-in" ? {...current, zoom: current.zoom + 1}
      : value.action === "zoom-out" ? {...current, zoom: current.zoom - 1}
      : value.action === "north" ? {...current, bearing: 0} : {...current, ...value});
    view = flatView(runtime.getView());actions.telemetry();
  }
  function mapControls() {
    if (!controls) controls = CompatibilityMapControls({mode, report: report(), view, canEdit: actions.canEdit(),
      onMode: select, onNavigate: navigate,
      onInteraction: kind => {
        if (!runtime) throw Error("The Canvas map is still opening. Data and saving remain available.");
        if (!["measure-distance", "measure-area"].includes(kind) && !actions.canEdit()) throw Error("Project edit access is required to create geometry.");
        runtime.setInteraction(kind);drawing = true;status("Draw on the 2D map, or use the coordinate form. Finish or cancel before changing modes.");
      }, onGeometry: result => {if (!actions.canEdit()) throw Error("Project edit access is required.");runtime?.cancelInteraction();drawing = false;draw(result);},
      onFinish: () => runtime?.finishInteraction(), onCancel: () => {runtime?.cancelInteraction();drawing = false;status("Drawing canceled. Saved Layers and geometry are unchanged.");}});
    controls.updateReport?.(report());return controls;
  }
  function modePanel() {
    const panel = node("section");panel.className = "gis-compatibility-panel";
    panel.append(node("h3", mode === "data-workspace" ? "Data workspace" : "2D compatibility"),
      node("p", "Analytical inputs, source versions, review history and saved evidence are shared across modes. Map appearance and available tools can differ. The full-graphics camera and basemap stay separate."));
    if (mode === "openlayers-canvas") {
      const label = node("label", "Compatibility background"), select = node("select");select.setAttribute("aria-label", "Compatibility background");
      for (const [id, title] of [["blank", "Plain background · no provider requests"], ["esri-public-imagery", "Esri World Imagery · public raster tiles"]]) {
        const option = node("option", title);option.value = id;select.append(option);
      }
      select.value = basemapId;select.onchange = () => {basemapId = select.value;backgroundExportAllowed = false;contentKey = null;sync();status("Compatibility background changed. Review its terms before exporting.");context.render();};label.append(select);panel.append(label);
      if (basemapId !== "blank") {
        const terms = node("a", "Provider terms and attribution");terms.href = "https://www.esri.com/en-us/legal/terms/full-master-agreement";terms.target = "_blank";terms.rel = "noopener noreferrer";
        const permission = node("label"), input = node("input");input.type = "checkbox";input.checked = backgroundExportAllowed;
        input.onchange = () => {backgroundExportAllowed = input.checked;contentKey = null;sync();};
        permission.append(input, document.createTextNode(" I have permission to include this raster background in exported images."));
        panel.append(terms, permission, node("p", "This records your declaration, not a verification of provider rights. Canvas capture also requires readable CORS-enabled tiles and complete loading."));
      }
    }
    panel.append(node("p", "Initial Canvas profile: loaded WGS84 GeoJSON, simple inline Styles and labels, one raster background, identify, drawing and geographic measurements. Globe, terrain, GPU effects, PMTiles and unmapped sources remain saved but unavailable."));
    if (lastMeasurement) panel.append(node("pre", JSON.stringify(lastMeasurement, null, 2)));
    return panel;
  }
  function stylePanel() {
    const panel = node("section");panel.className = "gis-compatibility-panel";
    const layer = context.layers.find(item => item.layerId === context.state.activeLayerId);
    if (!layer) {panel.append(node("p", "Choose a Layer to review its recorded style and data."));return panel;}
    panel.append(node("h3", layer.title), node("p", "Basic Canvas styling changes the same canonical inline Style. Reusable Style identities and unsupported definitions remain retained."));
    if (layer.styleReference) {panel.append(node("p", "This pinned reusable Style needs a Canvas mapping. Use full graphics to edit its presentation."));return panel;}
    layer.style ??= {};layer.labels ??= {};
    for (const [property, label, type, fallback] of [["fill", "Fill", "color", "#4f8cff"], ["stroke", "Stroke", "color", "#17212b"], ["strokeWidth", "Stroke width", "number", 2], ["circleRadius", "Point radius", "number", 6]]) {
      const field = node("label", label), input = node("input");input.type = type;input.setAttribute("aria-label", label);input.value = layer.style[property] ?? fallback;input.disabled = !actions.canEdit();
      if (type === "number") {input.min = "0";input.max = "128";input.step = "0.5";}
      input.oninput = () => {const value = type === "number" ? Number(input.value) : input.value;if (type === "number" && (!Number.isFinite(value) || value < 0 || value > 128)) return;
        layer.style[property] = value;contentKey = null;sync();status("Inline Style changed. Save the Project to retain it.");};field.append(input);panel.append(field);
    }
    const opacity = node("label", "Opacity"), slider = node("input");slider.type = "range";slider.min = "0";slider.max = "1";slider.step = ".05";slider.value = layer.opacity ?? 1;slider.setAttribute("aria-label", "Opacity");slider.disabled = !actions.canEdit();
    slider.oninput = () => {layer.opacity = Number(slider.value);contentKey = null;sync();};opacity.append(slider);panel.append(opacity);
    const labels = node("label"), check = node("input");check.type = "checkbox";check.checked = layer.labels.enabled === true;check.disabled = !actions.canEdit();
    check.onchange = () => {layer.labels.enabled = check.checked;contentKey = null;sync();};labels.append(check, document.createTextNode(" Labels (system font layout)"));
    const field = node("label", "Label field"), input = node("input");input.type = "text";input.value = layer.labels.field ?? "";input.setAttribute("aria-label", "Label field");input.disabled = !actions.canEdit();
    input.oninput = () => {layer.labels.field = input.value;contentKey = null;sync();};field.append(input);panel.append(labels, field);return panel;
  }
  return {
    get mode() {return mode;}, get initialMode() {return saved?.mode ?? null;}, get runtime() {return runtime;}, get view() {return view;}, get lastMeasurement() {return lastMeasurement;},
    select, report, sync, navigate, mapControls, modePanel, stylePanel,
    cancelSwitch() {pending?.abort();},
    extensions(value) {return explicit ? writeWorkspaceMode(value, mode ? preference() : null) : value;},
    frameDefinition(definition) {const pref = readWorkspaceMode(definition);return pref?.mode === "openlayers-canvas" ? {...definition, extensions: writeWorkspaceMode(definition.extensions, {...pref, view: flatView(definition.mapViews?.[0] ?? pref.view)})} : definition;},
    printContext() {sync();return {map: null, renderer: mode, layers: context.layers, project: actions.definition(),
      ready: mode === "openlayers-canvas" && Boolean(runtime) && !unavailable(), unavailableReason: unavailable(),
      captureCanvas: options => {if (unavailable()) throw Error(unavailable());return runtime.capture(options);},
      getPrintDataSource: actions.printData, getSelectedPrintFeature: actions.printSelection,
      savedProjectOrigin: context.savedProjectOrigin, basemap: basemap()};},
    async exportImage(format = "png") {
      if (!runtime || unavailable()) throw Error(unavailable() ?? "Choose a map mode before exporting.");
      const captured = await runtime.capture();return {dataUrl: captured.dataUrl, metadata: captured.metadata, format};
    },
    resize() {if (!closed) try {runtime?.resize();} catch {runtimeFault = "Canvas resize failed. Choose data workspace or reopen 2D compatibility.";status(`${runtimeFault} Your Layers and data remain available.`);notify();}},
    dispose() {if (closed) return;closed = true;pending?.abort();try {runtime?.dispose();} catch { /* A failed Canvas must not trap its owning dialog. */ }finally {runtime = null;surface?.remove();controls = null;}}
  };
}
