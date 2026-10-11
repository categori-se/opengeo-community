export function catalogSpatialStatus(dataset) {
  if (dataset.spatialSearchAvailable === true) return "Available from recorded extent";
  const reference = dataset.sourceSpatialMetadata?.spatialReference;
  const wkid = reference?.latestWkid ?? reference?.wkid;
  if (wkid || reference?.wkt) return `Provider CRS ${wkid ? `WKID ${wkid}` : "recorded"} · spatial search not indexed`;
  if (dataset.spatialSearchAvailable === false) return "Spatial search not indexed; inspect source metadata";
  return "Not reported";
}
