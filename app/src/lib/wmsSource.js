import {publicSourceUrl} from "./apiResponseContracts.js";

// The same registered, anonymous EPSG:3857 profile is used by Projects and
// temporary Catalog maps. This does not discover capabilities or copy imagery.
export function wmsTileUrl(endpoint, configuration) {
  publicSourceUrl(endpoint, "wms");
  const c = configuration;
  const name = value => typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value);
  if (!c || !["1.3.0", "1.1.1"].includes(c.version) || c.crs !== "EPSG:3857"
    || ![256, 512].includes(c.tileSize) || !["image/png", "image/jpeg"].includes(c.imageFormat)
    || typeof c.transparent !== "boolean" || c.imageFormat === "image/jpeg" && c.transparent
    || !Array.isArray(c.layers) || c.layers.length < 1 || c.layers.length > 32
    || !c.layers.every(name) || new Set(c.layers).size !== c.layers.length
    || !Array.isArray(c.styles) || c.styles.length > 32
    || c.styles.length !== 0 && c.styles.length !== c.layers.length
    || !c.styles.every(value => value === "" || name(value))) {
    throw new TypeError("Unsupported registered WMS configuration");
  }
  const parameters = new URLSearchParams({
    SERVICE: "WMS", REQUEST: "GetMap", VERSION: c.version,
    LAYERS: c.layers.join(","), STYLES: c.styles.join(","),
    FORMAT: c.imageFormat, TRANSPARENT: c.transparent ? "TRUE" : "FALSE",
    WIDTH: String(c.tileSize), HEIGHT: String(c.tileSize),
    BBOX: "{bbox-epsg-3857}", [c.version === "1.3.0" ? "CRS" : "SRS"]: c.crs
  });
  return `${endpoint}?${parameters}`.replaceAll("%7B", "{").replaceAll("%7D", "}");
}
