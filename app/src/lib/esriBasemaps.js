import {customBasemapDefinition} from "./basemapSource.js";

const IMAGERY_PATH = "/arcgis/rest/services/World_Imagery/MapServer/tile/";
const STATIC_PATH = "/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/";
const IMAGERY_CREDIT = "Powered by Esri · Esri, Vantor, Earthstar Geographics, and the GIS User Community";
const MAP_CREDIT = "Powered by Esri · Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community";

export const ESRI_BASEMAP_OPTIONS = Object.freeze([
  {id: "public-imagery", title: "World Imagery · no key required", requiresKey: false,
    url: `https://services.arcgisonline.com${IMAGERY_PATH}{z}/{y}/{x}`, attribution: IMAGERY_CREDIT, tileSize: 256},
  {id: "imagery", title: "World Imagery · ArcGIS API key", requiresKey: true,
    url: `https://ibasemaps-api.arcgis.com${IMAGERY_PATH}{z}/{y}/{x}`, attribution: IMAGERY_CREDIT, tileSize: 256},
  ...["navigation", "streets", "outdoor", "light-gray", "dark-gray"].map((id) => ({
    id, title: `${id[0].toUpperCase()}${id.slice(1).replaceAll("-", " ")} · ArcGIS API key`, requiresKey: true,
    url: `https://static-map-tiles-api.arcgis.com${STATIC_PATH}${id}/static/tile/{z}/{y}/{x}`,
    attribution: MAP_CREDIT, tileSize: 512
  }))
].map(Object.freeze));

export function esriBasemapDefinition(optionId, basemapId) {
  const option = ESRI_BASEMAP_OPTIONS.find(({id}) => id === optionId);
  if (!option) throw new TypeError("Choose an Esri basemap.");
  return {...customBasemapDefinition({basemapId, sourceType: "raster", title: `Esri ${option.title}`,
    url: option.url, attribution: option.attribution}), tileSize: option.tileSize, maxZoom: 23};
}

export function esriTileConfiguration(url) {
  const option = ESRI_BASEMAP_OPTIONS.find((candidate) => candidate.url === url);
  return option ? {tileSize: option.tileSize, maxZoom: 23} : {};
}

// Deliberately outside map definitions, local drafts, browser storage and API payloads.
// Headers are restricted to these exact Esri tile routes, not arbitrary project URLs.
export function createEsriBasemapSession() {
  let key = "";
  return Object.freeze({
    get configured() { return Boolean(key); },
    configure(value) {
      const next = typeof value === "string" ? value.trim() : "";
      if (!next || next.length > 4096 || /[^A-Za-z0-9._~+\/-]/.test(next)) {
        throw new TypeError("Enter a browser API key without spaces or control characters.");
      }
      key = next;
    },
    clear() { key = ""; },
    transformRequest(url) {
      const request = {url, credentials: "omit"};
      if (!key) return request;
      let parsed;
      try { parsed = new URL(url); } catch { return request; }
      if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return request;
      const imagery = parsed.hostname === "ibasemaps-api.arcgis.com"
        && new RegExp(`^${IMAGERY_PATH}[0-9]+/[0-9]+/[0-9]+$`).test(parsed.pathname);
      const styled = parsed.hostname === "static-map-tiles-api.arcgis.com"
        && new RegExp(`^${STATIC_PATH}(navigation|streets|outdoor|light-gray|dark-gray)/static/tile/[0-9]+/[0-9]+/[0-9]+$`).test(parsed.pathname);
      return imagery || styled ? {...request, headers: {Authorization: `Bearer ${key}`}} : request;
    }
  });
}
