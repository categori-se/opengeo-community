export function validateOpacityMode(layer) {
  if (layer.opacityMode !== undefined && !["feature", "composite"].includes(layer.opacityMode)) throw Error("Invalid opacity blending");
  if (layer.opacityMode === "composite" && !supportsCompositeOpacity(layer)) throw Error("Composite opacity requires a supported line or polygon Layer");
  return layer.opacityMode ?? "feature";
}

export function supportsCompositeOpacity(layer) {
  return ["LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(layer.geometryType)
    && ["governed-dataset", "geojson-object", "arcgis-feature-layer-snapshot"].includes(layer.sourceType);
}

export function opacityPaint(type, paint, opacity, mode = "feature") {
  const result = structuredClone(paint);
  if (type === "symbol") {
    for (const prefix of ["icon", "text"]) {
      if (Object.keys(paint).some(key => key.startsWith(`${prefix}-`))) {
        result[`${prefix}-opacity`] = (paint[`${prefix}-opacity`] ?? 1) * opacity;
      }
    }
    return result;
  }
  const property = `${type}-opacity`;
  if (mode === "composite" && ["fill", "line"].includes(type)) {
    result[property] = paint[property] ?? 1;
    result[`${type}-layer-opacity`] = opacity;
  } else {
    result[property] = (paint[property] ?? 1) * opacity;
    if (type === "circle") result["circle-stroke-opacity"] = (paint["circle-stroke-opacity"] ?? 1) * opacity;
  }
  return result;
}
