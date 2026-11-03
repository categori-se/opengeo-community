import {CatalogProjectSave} from "./CatalogProjectSave.js";
import {sourceLinks} from "./SourceDetails.js";
import {LayerStylePicker} from "./LayerStylePicker.js";
import {resolveLayerStyle} from "../lib/layerStyleReference.js";
export async function CatalogLayerPreview({record, load, adapter = null, interactive = false, signal, renderMap = async options => {
  const {MapView} = await import("./MapView.js"); return MapView(options);
}}) {
  signal?.throwIfAborted();
  const styleMethods = ["listDatasetResources", "listResourceStyles", "getResource", "getResourceStyleVersion"];
  const canChooseStyle = interactive && styleMethods.every(method => typeof adapter?.[method] === "function");
  const context = interactive && (adapter?.tokenProvider || adapter?.organizationProvider) ? await captureStyleContext(adapter) : null;
  signal?.throwIfAborted();
  const result = await load(record, {signal});
  signal?.throwIfAborted();
  const panel = node("section", "", "catalog-layer-preview");
  const layer = result.layer ? structuredClone(result.layer) : null;
  let renderedMap = null, disposed = false, initialStyleTimer = null, stylePicker = null;
  const current = () => !disposed && !signal?.aborted && panel.isConnected && styleContextCurrent(adapter, context);
  const guardNow = () => {if (!current()) throw new DOMException("Catalog account or Layer changed", "AbortError");};
  const guard = async () => {
    guardNow(); if (context) await adapter.assertCollectionContext(context); guardNow();
  };
  // Keep this preview's operations bound to its opening account without changing
  // the shared client. Methods keep their normal parsing and idempotency behavior.
  const scopedAdapter = adapter ? Object.create(adapter) : null;
  if (scopedAdapter) {
    if (typeof adapter.requestResponse === "function") scopedAdapter.requestResponse = async (path, options = {}) => {
      await guard();
      const requestSignal = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal;
      const response = await adapter.requestResponse.call(scopedAdapter, path, {...options,
        ...(context ? {token: context.token, organizationId: context.organization} : {}), signal: requestSignal,
        beforeDispatch: async () => {await guard(); await options.beforeDispatch?.(); await guard();},
        beforeDispatchNow: () => {guardNow(); options.beforeDispatchNow?.(); guardNow();}});
      await guard(); return response;
    };
    for (const method of [...styleMethods, "listCompositions", "listProjects", "getComposition", "attachDataset", "createMap", "updateMap"]) {
      if (typeof adapter[method] === "function") scopedAdapter[method] = async (...args) => {
        await guard(); const value = await adapter[method].apply(scopedAdapter, args); await guard(); return value;
      };
    }
  }
  panel.dispose = () => {
    if (disposed) return;
    disposed = true; clearTimeout(initialStyleTimer); signal?.removeEventListener("abort", panel.dispose);
    stylePicker?.dispose?.();
    renderedMap?.dispose?.(); renderedMap = null;
  };
  signal?.addEventListener("abort", panel.dispose, {once: true});
  const render = async options => {
    signal?.throwIfAborted();
    const map = await renderMap(options);
    if (disposed || signal?.aborted) {map.dispose?.(); throw new DOMException("Layer preview closed", "AbortError");}
    renderedMap = map;
    return map;
  };
  panel.append(node("h4", `${record.title} · ${result.managedArchive ? "archived data preview" : result.referencedArchive ? "referenced archive preview" : "live source preview"}`));
  if (interactive) panel.append(node("p", "Temporary Layer view. Exploring this map does not change a saved Project."));
  if (result.kind === "wms") {
    panel.append(await render({wms: {endpoint: result.endpoint, configuration: result.layer.sourceConfiguration}, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", "Live WMS map images for the selected layers and current area. No archived images are requested. This display does not provide source features or establish reuse rights."));
  } else if (result.kind === "xyz") {
    panel.append(await render({xyz: {endpoint: result.endpoint, configuration: result.layer.sourceConfiguration}, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", "Live provider tiles. Choose an area to inspect; no archived images are requested. This display is not an original-data export."));
  } else if (result.kind === "cog") {
    panel.append(await render({cog: result.cog, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", "Bounded current-view raster from the referenced COG. Pan or zoom, then refresh to read another window. Terms: " + (result.cog.configuration.license ?? "not supplied") + "."));
  } else if (result.kind === "features") {
    panel.append(await render({geojson: result.geojson, geometryType: record.geometryType ?? result.geojson.features.find(feature => feature.geometry)?.geometry.type,
      graduated: record.legend?.field ? record.legend : undefined, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", `${result.geojson.features.length.toLocaleString()} features${result.complete ? "" : " · bounded sample, not complete coverage"}. ${result.geometryNote}`));
  } else if (interactive) {
    panel.append(await render({imageServer: {endpoint: result.endpoint, metadata: result.metadata, attribution: result.attribution, configuration: result.layer?.sourceConfiguration}, height: "60vh"}));
  } else {
    const image = document.createElement("img");
    image.alt = `${record.title}: provider overview`; image.width = 800; image.height = 450;
    image.referrerPolicy = "no-referrer"; image.crossOrigin = "anonymous";
    const status = node("p", "Loading provider overview…"); status.setAttribute("role", "status");
    image.addEventListener("load", () => {status.textContent = "Provider overview. Open the map to pan, zoom and inspect imagery.";});
    image.addEventListener("error", () => {image.hidden = true; status.textContent = "The provider overview could not load. No archived imagery was substituted.";});
    image.src = result.imageUrl; panel.append(image, status);
  }
  panel.append(node("p", result.attribution));
  const geometryFamily = new Map([["Point", "point"], ["MultiPoint", "point"], ["LineString", "line"], ["MultiLineString", "line"], ["Polygon", "polygon"], ["MultiPolygon", "polygon"]]);
  const geometries = result.kind === "features" ? result.geojson.features.map(feature => feature.geometry).filter(geometry => geometry != null).map(geometry => geometry.type) : [];
  const families = new Set(geometries.map(type => geometryFamily.get(type)));
  const family = geometries.length && families.size === 1 ? geometryFamily.get(geometries[0]) : null;
  // Infer only an unclassified provider descriptor from a homogeneous preview.
  // Keep broader declared Multi geometries and the original source record intact.
  if (layer && family && (!layer.geometryType || layer.geometryType === "Raster")) {
    layer.geometryType = geometries.find(type => type.startsWith("Multi")) ?? geometries[0];
  }
  const vector = result.kind === "features" && layer && family && geometryFamily.get(layer.geometryType) === family;
  let saveControls = null, styleBusy = false, styleReady = result.kind !== "features" || !layer?.styleReference;
  const updateSave = () => {if (saveControls) saveControls.disabled = styleBusy || !styleReady;};
  if (interactive && result.kind === "features" && layer && !vector && (canChooseStyle || layer.styleReference)) {
    const status = node("p", "Reusable Styles are unavailable for this preview’s mixed or unsupported geometry.", "catalog-layer-style-status");
    status.setAttribute("role", "status");
    if (layer.styleReference) {
      renderedMap.hidden = true;
      status.textContent += ` The selected Style, version ${layer.styleReference.versionNumber}, could not be rendered. Reopen a compatible Layer before saving this selection to a Project.`;
    }
    panel.append(status);
  }
  if (interactive && vector && (canChooseStyle || layer.styleReference)) {
    const status = node("p", "", "catalog-layer-style-status"); status.setAttribute("role", "status");
    let selectedStyleTitle = null;
    const describePin = () => {status.textContent = layer.styleReference
      ? `${selectedStyleTitle || "Selected Style"} · version ${layer.styleReference.versionNumber}. Save to Project to retain this selection.`
      : "Using this Layer’s current presentation. Choose a saved Style to use an exact version.";};
    describePin(); panel.append(status);
    async function apply(reference, resolved) {
      await guard();
      if (typeof renderedMap?.applyLayerStyle !== "function") throw Error("This preview cannot apply a reusable Style");
      await renderedMap.applyLayerStyle(resolved, layer, {isCurrent: current});
      if (!current()) throw new DOMException("Style selection is no longer current", "AbortError");
      layer.styleReference = structuredClone(reference); styleReady = true;
      selectedStyleTitle = resolved.title;
      renderedMap.hidden = false; renderedMap.__resize?.(); describePin(); updateSave();
    }
    const picker = canChooseStyle ? LayerStylePicker({adapter: scopedAdapter, layer, signal, isCurrent: current,
      onBusy: value => {styleBusy = value; updateSave();}, onApply: apply}) : null;
    stylePicker = picker;
    if (picker) panel.append(picker);
    if (layer.styleReference) {
      renderedMap.hidden = true;
      if (picker) picker.hidden = true;
      styleBusy = true; status.textContent = `Loading the selected Style, version ${layer.styleReference.versionNumber}…`;
      // MapView initializes after attachment. Do not await its readiness before
      // returning the panel to its caller for insertion into the document.
      initialStyleTimer = setTimeout(async () => {
        try {await guard(); const resolved = await resolveLayerStyle(scopedAdapter, layer); await apply(layer.styleReference, resolved);}
        catch {
          if (current()) status.textContent = `The selected Style, version ${layer.styleReference.versionNumber}, is unavailable or incompatible. Check access or choose an accessible Style before saving this Layer to a Project.`;
        } finally {
          styleBusy = false; if (picker) picker.hidden = false; updateSave();
        }
      }, 0);
    }
  }
  if (interactive && typeof adapter?.createMap === "function" && layer) {
    saveControls = node("fieldset", "", "catalog-project-save-controls");
    Object.assign(saveControls.style, {border: "0", padding: "0", margin: "0"});
    saveControls.append(CatalogProjectSave({adapter: scopedAdapter, record, layer, getView: () => renderedMap?.__view?.()}));
    const guardSave = event => {
      if (styleBusy || !styleReady || !current()) {event.preventDefault(); event.stopImmediatePropagation();}
    };
    saveControls.addEventListener("click", guardSave, true); saveControls.addEventListener("submit", guardSave, true);
    updateSave(); panel.append(saveControls);
  }
  const access = node("section", "", "catalog-layer-access");
  if (result.managedArchive) {
    access.append(node("h4", "Archived source"),
      node("p", `Dataset version ${result.managedArchive.datasetVersionId}. This temporary view reads the authorized original without changing a saved Project.`));
    panel.append(access);
    return panel;
  }
  if (result.referencedArchive) {
    const source = result.referencedArchive;
    access.append(node("h4", "Referenced archive"),
      node("p", `Source revision ${source.versionNumber} · GeoJSON archive`),
      link("Referenced GeoJSON archive", source.sourceUrl),
      link("Authoritative source information", source.configuration.authoritativeUrl),
      link("Recorded rights information", source.configuration.rightsUrl));
    panel.append(access);
    return panel;
  }
  if (result.privateSource) {
    const configuration = result.source.configuration;
    access.append(node("h4", "Database source"),
      node("p", `${configuration.schema}.${configuration.relation} · Geometry: ${configuration.geometryColumn} · Key: ${configuration.stableKey}`),
      node("p", `Connection revision ${configuration.connectionRevision} · Source revision ${result.source.versionNumber}`),
      node("p", "The authorized connection reads this bounded view. Source records remain in their database; this preview creates no managed copy."));
    const encodings = Object.entries(result.preview.propertyEncodings);
    if (encodings.length) access.append(node("p", `Exact numeric values are represented as text: ${encodings.map(([column, encoding]) => `${column} (${encoding})`).join(", ")}.`));
    panel.append(access);
    return panel;
  }
  access.append(node("h4", "Source data and downloads"),
    node("p", "This layer is a view of the source dataset. Provider exports may include other indicator fields."));
  access.append(link("Official service and query options", sourceLinks(result.endpoint).provider));
  if (/^[a-f0-9]{32}$/i.test(result.metadata.serviceItemId ?? "")) {
    access.append(link("Official item and export options", `https://www.arcgis.com/home/item.html?id=${result.metadata.serviceItemId}`));
  }
  if (result.metadata.supportedQueryFormats) {
    access.append(node("p", `Query formats reported by the provider: ${String(result.metadata.supportedQueryFormats).slice(0, 200)}. Hosted download formats may differ.`));
  }
  access.append(node("p", "Archived copies and their access permissions are listed under Metadata and access."));
  panel.append(access);
  return panel;
}
async function captureStyleContext(adapter) {
  if (!adapter.tokenProvider && !adapter.organizationProvider) return null;
  const {tokenProvider, organizationProvider, baseUrl} = adapter;
  if (typeof tokenProvider !== "function" || typeof organizationProvider !== "function" || typeof adapter.assertCollectionContext !== "function") {
    throw Error("Sign-in scope is unavailable. Reopen Catalog before choosing a Style.");
  }
  const context = Object.freeze({tokenProvider, organizationProvider, baseUrl,
    token: await tokenProvider.call(adapter), organization: String(await organizationProvider.call(adapter)).toLowerCase()});
  await adapter.assertCollectionContext(context); return context;
}
function styleContextCurrent(adapter, context) {
  if (!context) return true;
  try {
    if (typeof adapter.assertCollectionContextNow === "function") adapter.assertCollectionContextNow(context);
    else if (adapter.tokenProvider !== context.tokenProvider || adapter.organizationProvider !== context.organizationProvider || adapter.baseUrl !== context.baseUrl
      || context.tokenProvider.call(adapter) !== context.token || String(context.organizationProvider.call(adapter)).toLowerCase() !== context.organization) return false;
    return true;
  } catch {return false;}
}
function node(tag, value, className = "") {const element = document.createElement(tag); element.textContent = value; element.className = className; return element;}
function link(label, href) {const element = node("a", label, "platform-button platform-button-secondary"); element.href = href; element.target = "_blank"; element.rel = "noopener noreferrer"; return element;}
