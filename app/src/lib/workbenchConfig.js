import {REVIEWED_KEY_FREE_BASEMAPS} from "./reviewedBasemapSources.js";

// Shared workbench vocabulary. Keep these records declarative so menus,
// panels, smoke checks, and future API metadata can depend on the same names.

export const BASEMAPS = [
  {
    basemapId: "openfreemap-liberty",
    title: "Liberty",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "Detailed general-purpose vector map with roads, places, and land cover.",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  {
    basemapId: "openfreemap-liberty-3d",
    title: "Liberty 3D",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "Liberty with a tilted camera and available building extrusion.",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    pitch: 60,
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  {
    basemapId: "openfreemap-positron",
    title: "Positron",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "Quiet light vector map for thematic layers and reports.",
    styleUrl: "https://tiles.openfreemap.org/styles/positron",
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  {
    basemapId: "openfreemap-bright",
    title: "Bright",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "High-contrast vector map with prominent roads and labels.",
    styleUrl: "https://tiles.openfreemap.org/styles/bright",
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  {
    basemapId: "openfreemap-dark",
    title: "Dark",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "Dark vector map for bright thematic overlays.",
    styleUrl: "https://tiles.openfreemap.org/styles/dark",
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  {
    basemapId: "openfreemap-fiord",
    title: "Fiord",
    section: "OpenFreeMap",
    kind: "maplibre-style",
    description: "Muted blue-gray vector map for terrain and environmental work.",
    styleUrl: "https://tiles.openfreemap.org/styles/fiord",
    attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
  },
  ...REVIEWED_KEY_FREE_BASEMAPS,
  {
    basemapId: "blank",
    title: "Blank canvas",
    section: "Other",
    kind: "blank",
    description: "No network basemap; useful for isolated vector work.",
    url: null,
    attribution: "No basemap"
  }
];

export const ADD_DATA_SOURCES = [
  {
    section: "Files",
    sources: [
      ["vector", "Vector or KML layer", "GeoJSON, KML, KMZ, and JSON FeatureCollections"],
      ["csv", "Delimited text layer", "CSV with longitude and latitude columns"],
      ["photos", "Geotagged photos", "EXIF-backed photo points via S3 upload"],
      ["gpx", "GPX layer", "Track and waypoint import"]
    ]
  },
  {
    section: "Web services",
    sources: [
      ["xyz", "XYZ tile layer", "Raster tile URL template"],
      ["wms", "WMS layer", "OGC map service registration"],
      ["wfs", "WFS layer", "OGC feature service registration"],
      ["arcgis", "ArcGIS layer", "FeatureServer or MapServer endpoint"],
      ["mapserver", "ArcGIS map imagery", "Live map images from selected service layers"],
      ["imageserver", "ImageServer imagery", "Live raster imagery, display bands and source metadata"],
      ["stac", "STAC layer", "Catalog item or collection"]
    ]
  },
  {
    section: "Cloud formats",
    sources: [
      ["pmtiles", "PMTiles layer", "S3 or HTTPS PMTiles source"],
      ["geoparquet", "GeoParquet layer", "DuckDB-WASM preview, AWS persistence"],
      ["flatgeobuf", "FlatGeobuf layer", "Streaming vector source"],
      ["zarr", "Zarr layer", "Cloud-native array registration"],
      ["cog", "Cloud optimized GeoTIFF", "Raster preview and processing jobs"]
    ]
  },
  {
    section: "3D and databases",
    sources: [
      ["tiles3d", "3D Tiles layer", "Cesium 3D Tiles metadata"],
      ["model", "3D model (glTF)", "Scene model registration"],
      ["duckdb", "DuckDB SQL workspace", "Browser SQL over registered objects"],
      ["postgres", "PostGIS connection", "Server-side connection profile"]
    ]
  }
];

export {PROCESSING_TOOLS} from "./processingRegistry.js";

export const PLUGINS = [
  ["catalog", "Layer catalog", "Find and reuse Layers"],
  ["field", "Field collection", "Mobile forms and offline submissions"],
  ["offline", "Offline cache", "PMTiles and project package manifest"],
  ["time", "Time slider", "Temporal layer filtering"],
  ["assistant", "Automation", "Auditable command plans"]
];

export const STYLE_PALETTES = [
  ["opengeo", "OpenGeo", ["#2f74f5", "#14b8a6", "#f59e0b", "#ec4899", "#64748b"]],
  ["terrain", "Terrain", ["#2f855a", "#84a98c", "#d9a441", "#8b5e34", "#475569"]],
  ["water", "Water", ["#0369a1", "#0891b2", "#38bdf8", "#0f766e", "#334155"]],
  ["risk", "Risk", ["#16a34a", "#f59e0b", "#f97316", "#dc2626", "#7f1d1d"]],
  ["mono", "Derived", []]
];

export const DEFAULT_STATUS = "Ready";
