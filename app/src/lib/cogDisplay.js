// Project appearance only. Provider configuration and raster values stay intact.
export function isCogLayer(layer) {
  return layer?.sourceType === "cog-raster" || layer?.sourceType === "governed-dataset"
    && Boolean(layer.datasetVersionId) && String(layer.geometryType).toLowerCase() === "raster";
}

export function cogDisplayOptions(layer) {
  if (!Object.hasOwn(layer.style ?? {}, "cogDisplay")) return {};
  const value = layer.style.cogDisplay, range = value?.displayRange;
  if (!isCogLayer(layer) || layer.sourceConfiguration?.bands?.length !== 1
    || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["displayRange", "noDataValue"].includes(key))
    || !range || typeof range !== "object" || Array.isArray(range)
    || Object.keys(range).some(key => !["minimum", "maximum"].includes(key))
    || !Number.isFinite(range.minimum) || !Number.isFinite(range.maximum)
    || range.minimum >= range.maximum || !Number.isFinite(range.maximum - range.minimum)
    || value.noDataValue != null && !Number.isFinite(value.noDataValue)) {
    throw Error("Choose a finite minimum below the maximum and an optional finite transparent value for a one-band raster.");
  }
  return {displayRange: {minimum: range.minimum, maximum: range.maximum}, noDataValue: value.noDataValue ?? null};
}
