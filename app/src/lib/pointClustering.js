import {featureFilter} from "@maplibre/maplibre-gl-style-spec";
import {validateMapFilter, combineMapFilters} from "./mapFilter.js";

export const DEFAULT_POINT_CLUSTERING = Object.freeze({enabled: false, radius: 50, maxZoom: 14});
export function validatePointClustering(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["enabled", "radius", "maxZoom"].includes(key))
    || typeof value.enabled !== "boolean" || !Number.isInteger(value.radius) || value.radius < 16 || value.radius > 100
    || !Number.isInteger(value.maxZoom) || value.maxZoom < 0 || value.maxZoom > 22) throw Error("Invalid point clustering display preference.");
  return value;
}
export function pointClusteringOptions(layer) {
  return layer.pointClustering === undefined ? {...DEFAULT_POINT_CLUSTERING} : validatePointClustering(layer.pointClustering);
}
export function pointClusteringIssue(layer, geojson, {archive = false, renderer = "maplibre"} = {}) {
  if (renderer !== "maplibre") return "Point clustering currently uses MapLibre.";
  if (layer.geometryType !== "Point" || !["governed-dataset", "geojson-object", "geojson-archive", "arcgis-feature-layer-snapshot"].includes(layer.sourceType) || archive)
    return "Clustering requires an ordinary Point GeoJSON Layer; tile, live-view and MultiPoint sources are not supported.";
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features) || geojson.opengeo?.mayBeTruncated)
    return "Load the complete Point Layer before changing clustering.";
  if (geojson.features.some(feature => feature?.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)
    || feature.geometry.coordinates.length < 2 || !feature.geometry.coordinates.slice(0, 2).every(Number.isFinite)))
    return "Every loaded record must have valid Point coordinates.";
  if (geojson.features.some(feature => ["cluster", "cluster_id", "point_count", "point_count_abbreviated"].some(key => Object.hasOwn(feature.properties ?? {}, key))))
    return "This Layer has attributes reserved by the cluster renderer. Original attributes are preserved; clustering is unavailable.";
  return null;
}
export function pointClusterData(layer, geojson) {
  const filter = layer.filter;
  if (!filter) return geojson;
  validateMapFilter(filter);
  const test = featureFilter(filter, "pointClustering.filter").filter;
  return {...geojson, features: geojson.features.filter(feature => test({zoom: 0}, {type: 1, id: feature.id, properties: feature.properties ?? {}}))};
}
export const unclusteredPointFilter = base => combineMapFilters(base, ["!=", ["get", "cluster"], true]);
const prefix = "opengeo-cluster-count-";
const largeCounts = ["100+", "1k+", "10k+", "100k+", "1m+", "10m+", "100m+"];
export function pointClusterCountLabel(count) {
  if (!Number.isSafeInteger(count) || count < 2) throw Error("Invalid display cluster count.");
  if (count < 100) return String(count);
  return largeCounts[Math.min(6, Math.floor(Math.log10(count)) - 2)];
}
export function pointClusterParts(layer) {
  const count = ["get", "point_count"];
  const label = ["step", count, ["to-string", count], 100, "100+", 1000, "1k+", 10000, "10k+", 100000, "100k+", 1000000, "1m+", 10000000, "10m+", 100000000, "100m+"];
  const filter = ["==", ["get", "cluster"], true];
  return [{id: `${layer.layerId}-clusters`, type: "circle", filter,
    paint: {"circle-color": "#075985", "circle-radius": ["step", count, 18, 100, 24, 1000, 30], "circle-opacity": layer.opacity ?? 1,
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 2, "circle-stroke-opacity": layer.opacity ?? 1}},
  {id: `${layer.layerId}-cluster-counts`, type: "symbol", filter,
    layout: {"icon-image": ["concat", prefix, label], "icon-allow-overlap": true, "icon-ignore-placement": true},
    paint: {"icon-opacity": layer.opacity ?? 1}}];
}
// At most 105 reusable count images, with no remote font or sprite request.
const countImageSessions = new WeakMap();
export function installPointClusterCountImages(map, imageIds) {
  imageIds.push(...(map.listImages?.() ?? []).filter(id => id.startsWith(prefix)));
  const handler = event => {
    if (!event.id?.startsWith(prefix)) return;
    const label = event.id.slice(prefix.length);
    if (!largeCounts.includes(label) && !/^(?:[2-9]|[1-9][0-9])$/.test(label)) return;
    if (!imageIds.includes(event.id)) imageIds.push(event.id);
    if (map.hasImage(event.id)) return;
    const canvas = document.createElement("canvas");canvas.width = 120;canvas.height = 48;
    const context = canvas.getContext("2d");if (!context) return;
    context.fillStyle = "#ffffff";context.font = "bold 25px sans-serif";context.textAlign = "center";context.textBaseline = "middle";
    context.fillText(label, 60, 25);
    map.addImage(event.id, context.getImageData(0, 0, 120, 48), {pixelRatio: 2});
  };
  let session = countImageSessions.get(map);
  if (!session) {
    // Pinned MapLibre 6.4.1 exposes the awaited setter but no resolver getter.
    // Retain its exact backing field to chain a host resolver and restore it
    // only while this helper still owns the installed resolver.
    const previous = map._missingStyleImageResolver;
    const handlers = new Set();
    const resolver = async id => {
      for (const resolve of handlers) resolve({id});
      if (!map.hasImage(id) && typeof previous === "function") await previous(id);
    };
    session = {previous, resolver, handlers};countImageSessions.set(map, session);
    map.setMissingStyleImageResolver(resolver);
  }
  session.handlers.add(handler);
  return () => {
    session.handlers.delete(handler);
    if (!session.handlers.size) {
      if (map._missingStyleImageResolver === session.resolver) map.setMissingStyleImageResolver(session.previous ?? null);
      countImageSessions.delete(map);
    }
  };
}
