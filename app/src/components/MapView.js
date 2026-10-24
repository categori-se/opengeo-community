import {mapServerTileUrl} from "../lib/mapServer.js";
import {imageServerTileUrl} from "../lib/imageServer.js";
import maplibregl from "../lib/mapRenderer.js";
import {geojsonBounds, geometryPaint} from "../lib/mapLayers.js";
import {graduatedColorExpression} from "../lib/thematicStyle.js";
import {installCogMapLayer} from "../lib/cogMapLayer.js";
import {CogIdentifyResult} from "./CogIdentifyResult.js";
import {RasterViewshed} from "./RasterViewshed.js";

export function MapView({geojson, geometryType, height, graduated, imageServer, cog, xyz} = {}) {
  if (!imageServer && !cog && !xyz && !geojson?.features?.length) return emptyMap();

  const container = document.createElement("div");
  container.className = "map-frame";
  if (height) container.style.height = height;

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = "map-preview-status";
  status.textContent = "Loading layer…";
  let basemapNote = "";
  const setStatus = message => {status.textContent = basemapNote + message;};
  container.append(status);
  // Allow an asynchronously constructed preview panel to attach before WebGL
  // initialization; a microtask can run before its caller inserts the panel.
  setTimeout(() => {
    if (!container.isConnected) return;
    const map = new maplibregl.Map({
      container,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 0],
      zoom: 1
    });
    container.__opengeoMap = map;
    container.__resize = () => map.resize();
    container.__view = () => ({center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()});
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-left");
    map.addControl(new maplibregl.ScaleControl());
    let previewStarted = false, blankBasemap = false, disposed = false;
    const blank = document.createElement("button");
    blank.type = "button"; blank.className = "platform-button secondary";
    blank.textContent = "Use blank basemap";
    Object.assign(blank.style, {position: "absolute", bottom: "4.5rem", left: ".5rem", zIndex: "3"});
    const useBlankBasemap = unavailable => {
      if (disposed || previewStarted || blankBasemap) return;
      blankBasemap = true; blank.remove();
      basemapNote = unavailable ? "Basemap unavailable. Showing a blank background. " : "Blank basemap selected. ";
      setStatus("Loading layer…");
      map.setStyle({version: 8, sources: {}, layers: [{id: "preview-background", type: "background", paint: {"background-color": "#f3f4f6"}}]}, {diff: false});
    };
    blank.addEventListener("click", () => useBlankBasemap(false));
    container.append(blank);
    let xyzActive = false, areaButton;
    const activateXyz = () => {
      if (map.getSource("preview")) return;
      const c = xyz.configuration;
      map.addSource("preview", {type: "raster", tiles: [xyz.endpoint], tileSize: c.tileSize, scheme: c.scheme,
        minzoom: c.minZoom, maxzoom: c.maxZoom, attribution: c.attribution});
      map.addLayer({id: "preview-image", type: "raster", source: "preview"});
    };
    if (xyz) {
      const form = document.createElement("form"); form.className = "map-preview-area";
      const controls = [
        ["Longitude", -180, 180, 0], ["Latitude", -85, 85, 0],
        ["Zoom", xyz.configuration.minZoom, xyz.configuration.maxZoom, Math.max(1, xyz.configuration.minZoom)]
      ].map(([name, min, max, value]) => {
        const label = document.createElement("label"); label.textContent = name;
        const input = document.createElement("input"); input.type = "number"; input.min = min; input.max = max; input.step = "any"; input.value = value; input.required = true; input.setAttribute("aria-label", name);
        label.append(input); form.append(label); return input;
      });
      const go = document.createElement("button"); go.type = "submit"; go.textContent = "View area"; go.disabled = true; areaButton = go; form.append(go);
      form.addEventListener("submit", event => {
        event.preventDefault(); if (!form.reportValidity()) return;
        const values = controls.map(input => Number(input.value)); if (!values.every(Number.isFinite)) return;
        failed = false; xyzActive = true;
        map.jumpTo({center: values.slice(0, 2), zoom: values[2]}); activateXyz();
      });
      container.append(form);
    }
    let failed = false;
    map.on("error", () => {
      if (disposed) return;
      if (!previewStarted && !blankBasemap) {useBlankBasemap(true); return;}
      failed = true; setStatus("Some layer imagery could not load. Pan or zoom to try another area, or reopen the preview.");
    });
    // The bounded COG reader owns its loading/ready/error state. Canvas source
    // uploads can emit dataloading after it has reported readiness and warnings.
    map.on("dataloading", () => {if (!failed && !cog) setStatus("Loading visible layer area…");});
    map.on("idle", () => {if (!failed && !cog) setStatus(xyz && !xyzActive ? "Choose an area to load provider tiles." : "Layer view ready. Pan and zoom to explore.");});

    map.on("load", () => {
      if (disposed || previewStarted) return;
      previewStarted = true; blank.remove();
      if (xyz) {
        areaButton.disabled = false;
        setStatus("Choose an area to load provider tiles.");
        return;
      }
      if (cog) {
        const bounds = cog.configuration.bounds;
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {padding: 24, maxZoom: 18, duration: 0});
        let inspectedPoint = null, viewshed, observerPick = null;
        const session = installCogMapLayer(map, {sourceId: "preview", layerId: "preview-cog", source: cog,
          onStatus: setStatus, onReady: () => {failed = false;renderSample();viewshed?.updateSource();}});
        const refresh = document.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh raster window";
        refresh.className = "map-preview-raster-refresh";
        refresh.style.position = "static";
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel raster read"; cancel.disabled = true;
        let appliedDisplay = {}, apply;
        const read = async (currentView, display = appliedDisplay) => {
          refresh.disabled = true; cancel.disabled = false; if (apply) apply.disabled = true;
          try {
            const result = await session.refresh(currentView ? map.getBounds().toArray().flat() : bounds, display);
            if (result) appliedDisplay = display;
          }
          catch {failed = true;}
          finally {refresh.disabled = false; cancel.disabled = true; if (apply) apply.disabled = false;}
        };
        refresh.addEventListener("click", () => void read(true));
        cancel.addEventListener("click", () => {session.cancel(); setStatus("Raster read cancelled. The previous view and Layer reference are preserved.");});
        const controls = document.createElement("div"); controls.className = "map-preview-raster-controls";
        controls.append(refresh, cancel); container.append(controls);
        const inspected = document.createElement("section");inspected.setAttribute("aria-label", "Raster values");
        inspected.setAttribute("aria-live", "polite");controls.append(inspected);
        function renderSample() {if (inspectedPoint) inspected.replaceChildren(CogIdentifyResult(session.identify(inspectedPoint.lng, inspectedPoint.lat)));}
        map.on("click", event => {inspectedPoint = event.lngLat.wrap?.() ?? event.lngLat;renderSample();
          if(observerPick){const callback=observerPick;observerPick=null;callback([inspectedPoint.lng,inspectedPoint.lat]);}});
        if (cog.configuration.bands.length === 1) {
          const form = document.createElement("form"), fields = document.createElement("fieldset");
          form.className = "map-preview-raster-display";
          const legend = document.createElement("legend"); legend.textContent = "One-band raster display"; fields.append(legend);
          const inputs = ["Display minimum", "Display maximum", "Transparent value (optional)"].map((name, index) => {
            const label = document.createElement("label"); label.textContent = name;
            const input = document.createElement("input"); input.type = "number"; input.step = "any";
            input.required = index < 2; input.setAttribute("aria-label", name); label.append(input); fields.append(label); return input;
          });
          const note = document.createElement("p");
          note.textContent = "Choose a minimum below the maximum for a grayscale view. Values outside the range use black or white; missing values stay transparent. These choices apply only to this temporary map.";
          fields.append(note);
          apply = document.createElement("button"); apply.type = "submit"; apply.textContent = "Apply display range"; fields.append(apply); form.append(fields);
          form.addEventListener("submit", event => {
            event.preventDefault(); if (!form.reportValidity()) return;
            const [minimum, maximum] = inputs.slice(0, 2).map(input => input.valueAsNumber);
            const noDataValue = inputs[2].value === "" ? null : inputs[2].valueAsNumber;
            if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum
              || !Number.isFinite(maximum - minimum) || noDataValue !== null && !Number.isFinite(noDataValue)) {
              setStatus("Choose a finite minimum below the maximum and a finite transparent value, or leave the transparent value empty.");
              return;
            }
            void read(true, {displayRange: {minimum, maximum}, noDataValue});
          });
          controls.append(form);
        }
        viewshed=RasterViewshed({getGrid:()=>session.grid,initialObserver:()=>map.getCenter().toArray(),
          pickObserver:callback=>{observerPick=callback;return true;},clearPick:()=>{observerPick=null;},
          onDownload:body=>{const url=URL.createObjectURL(new Blob([body],{type:"application/geo+json"}));
            const link=document.createElement("a");link.href=url;link.download="viewshed.geojson";link.click();URL.revokeObjectURL(url);}});
        controls.append(viewshed);map.on("remove",()=>viewshed.dispose());
        container.__cogSession = session; void read(false);
        return;
      }
      if (imageServer) {
        const configuration = imageServer.configuration ?? {serviceKind: "imageserver", tileSize: 512,
          imageFormat: "png32", interpolation: "RSP_BilinearInterpolation", bandIds: []};
        const tile = (configuration.serviceKind === "mapserver" ? mapServerTileUrl : imageServerTileUrl)(imageServer.endpoint, configuration);
        map.addSource("preview", {type: "raster", tiles: [tile], tileSize: configuration.tileSize, attribution: imageServer.attribution,
          maxzoom: 20});
        map.addLayer({id: "preview-image", type: "raster", source: "preview"});
        const extent = imageServer.metadata.initialExtent ?? imageServer.metadata.extent ?? imageServer.metadata.fullExtent;
        const sr = extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid;
        if (extent && [extent.xmin, extent.ymin, extent.xmax, extent.ymax].every(Number.isFinite)) {
          const point = (x, y) => [3857, 102100, 102113].includes(sr)
            ? [x / 6378137 * 180 / Math.PI, Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI] : [x, y];
          if ([4326, 3857, 102100, 102113].includes(sr)) map.fitBounds([
            point(extent.xmin, extent.ymin), point(extent.xmax, extent.ymax)
          ], {padding: 24, maxZoom: 16, duration: 0});
        }
        return;
      }
      map.addSource("preview", {type: "geojson", data: geojson});

      for (const layer of geometryPaint(geometryType)) {
        if (graduated) {
          if (layer.id === "preview-outline") layer.paint = {"line-color": "#ffffff", "line-width": 0.35};
          const property = {fill: "fill-color", circle: "circle-color", line: "line-color"}[layer.type];
          if (property && layer.id !== "preview-outline") {
            layer.paint[property] = graduatedColorExpression(graduated);
            if (layer.type === "fill") layer.paint["fill-opacity"] = 0.8;
          }
        }
        map.addLayer({...layer, source: "preview"});
      }

      const bounds = geojsonBounds(geojson);
      if (bounds) map.fitBounds(bounds, {padding: 48, maxZoom: 18, duration: 0});
    });

    observeDisconnection(container, () => {
      disposed = true;
      delete container.__opengeoMap;
      delete container.__resize;
      delete container.__view;
      container.__cogSession?.dispose(); delete container.__cogSession;
      map.remove();
    });
  }, 0);

  return container;
}

function observeDisconnection(element, dispose) {
  if (typeof MutationObserver === "undefined" || !element.isConnected) return null;
  const observer = new MutationObserver(() => {
    if (element.isConnected) return;
    observer.disconnect();
    dispose();
  });
  observer.observe(element.ownerDocument.documentElement, {childList: true, subtree: true});
  return observer;
}

function emptyMap() {
  const container = document.createElement("div");
  container.className = "map-empty";
  container.textContent = "No spatial preview is available for this dataset.";
  return container;
}
