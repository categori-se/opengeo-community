import {mapServerTileUrl} from "../lib/mapServer.js";
import {imageServerTileUrl} from "../lib/imageServer.js";
import maplibregl from "../lib/mapRenderer.js";
import {geojsonBounds, geometryPaint} from "../lib/mapLayers.js";
import {graduatedColorExpression} from "../lib/thematicStyle.js";
import {installCogMapLayer} from "../lib/cogMapLayer.js";

export function MapView({geojson, geometryType, height, graduated, imageServer, cog, xyz} = {}) {
  if (!imageServer && !cog && !xyz && !geojson?.features?.length) return emptyMap();

  const container = document.createElement("div");
  container.className = "map-frame";
  if (height) container.style.height = height;

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = "map-preview-status";
  status.textContent = "Loading layer…";
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
    container.__resize = () => map.resize();
    container.__view = () => ({center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()});
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-left");
    map.addControl(new maplibregl.ScaleControl());
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
    map.on("error", () => {failed = true; status.textContent = "Some layer imagery could not load. Pan or zoom to try another area, or reopen the preview.";});
    map.on("dataloading", () => {if (!failed) status.textContent = "Loading visible layer area…";});
    map.on("idle", () => {if (!failed && !cog) status.textContent = xyz && !xyzActive ? "Choose an area to load provider tiles." : "Layer view ready. Pan and zoom to explore.";});

    map.on("load", () => {
      if (xyz) {
        areaButton.disabled = false;
        status.textContent = "Choose an area to load provider tiles.";
        return;
      }
      if (cog) {
        const bounds = cog.configuration.bounds;
        map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {padding: 24, maxZoom: 18, duration: 0});
        const session = installCogMapLayer(map, {sourceId: "preview", layerId: "preview-cog", source: cog,
          onStatus: message => {status.textContent = message;}, onReady: () => {failed = false;}});
        const refresh = document.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh raster window";
        refresh.className = "map-preview-raster-refresh";
        const read = async currentView => {
          refresh.disabled = true;
          try {await session.refresh(currentView ? map.getBounds().toArray().flat() : bounds);}
          catch {failed = true;}
          finally {refresh.disabled = false;}
        };
        refresh.addEventListener("click", () => void read(true)); container.append(refresh);
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
