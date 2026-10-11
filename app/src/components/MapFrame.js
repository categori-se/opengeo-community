import {BasemapCapture} from "./BasemapCapture.js";
import {PlotGeoLayer} from "./PlotGeoLayer.js";

export function MapFrame(element, context) {
  const frame = document.createElement("div");
  frame.className = "layout-map-frame";

  const basemap = context.basemaps.find((candidate) => candidate.basemapId === element.basemapId);
  frame.append(BasemapCapture({mapFrame: element, basemap}));

  const overlays = document.createElement("div");
  overlays.className = "plot-overlays";

  for (const layerId of element.layers ?? []) {
    const layer = context.layerById.get(layerId);
    if (!layer) continue;
    overlays.append(PlotGeoLayer({mapFrame: element, layer, geojson: context.geojsonByLayerId.get(layerId)}));
  }

  frame.append(overlays);

  const attribution = document.createElement("div");
  attribution.className = "map-attribution";
  attribution.textContent = basemap?.title ? `${basemap.title} · OpenStreetMap contributors` : "Basemap attribution required";
  frame.append(attribution);

  return frame;
}
