import * as Plot from "@observablehq/plot";
import {mmToPx} from "../lib/printLayouts.js";

export function PlotGeoLayer({mapFrame, layer, geojson}) {
  if (!geojson?.features?.length) return emptyOverlay(layer);

  const color = layer.style?.stroke ?? layer.style?.fill ?? layer.style?.circleColor ?? "#4269d0";
  const width = mmToPx(mapFrame.widthMm);
  const height = mmToPx(mapFrame.heightMm);

  return Plot.plot({
    width,
    height,
    margin: 0,
    axis: null,
    projection: {
      type: mapFrame.projection ?? "mercator",
      domain: geojson
    },
    marks: [
      Plot.geo(geojson, {
        stroke: color,
        strokeWidth: layer.style?.strokeWidth ?? 1.5,
        fill: layer.geometryType === "Polygon" ? (layer.style?.fill ?? color) : "none",
        fillOpacity: layer.geometryType === "Polygon" ? layer.opacity ?? 0.4 : 0,
        r: layer.style?.circleRadius ?? 4
      })
    ],
    style: {
      width: "100%",
      height: "100%",
      background: "transparent"
    }
  });
}

function emptyOverlay(layer) {
  const placeholder = document.createElement("div");
  placeholder.className = "plot-overlay-empty";
  placeholder.textContent = `${layer.title} overlay awaits signed object bytes.`;
  return placeholder;
}
