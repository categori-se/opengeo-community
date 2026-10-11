import {validateOpacityMode} from "./layerOpacity.js";
import {validateMapFilter} from "./mapFilter.js";
import {validateLayerStyleReference} from "./layerStyleReference.js";
import {spatialBodyDefinition} from "./spatialBody.js";
import {validateMapFontRef} from "./mapFonts.js";

export const STYLE_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.4.0";
export const MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.3.0";
export const PATH_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.2.0";
export const PROCESSING_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.1.0";
export const LEGACY_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.0.0";

// This extension is a preference, never a native SDK options/credentials object.
export function validateRendererPreference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, "id")
    || !["maplibre", "mapbox", "cesium"].includes(value.id)) {
    throw new Error("map_renderer_preference_invalid");
  }
  return value;
}

export function emptyMapDefinition(overrides = {}) {
  return {
    schemaVersion: MAP_DEFINITION_SCHEMA_VERSION,
    mapViews: [],
    basemaps: [],
    bookmarks: [],
    activeLayerId: null,
    activeProcessingModelId: null,
    models: [],
    processingHistory: [],
    measurements: [],
    spatialBody: spatialBodyDefinition(),
    projection: "mercator",
    colorMode: "dark",
    layers: [],
    ...overrides
  };
}

export function upgradeMapDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("map_definition_invalid");
  }
  const version = definition.schemaVersion;
  if (version !== undefined
    && version !== LEGACY_MAP_DEFINITION_SCHEMA_VERSION
    && version !== PROCESSING_MAP_DEFINITION_SCHEMA_VERSION
    && version !== PATH_MAP_DEFINITION_SCHEMA_VERSION
    && version !== MAP_DEFINITION_SCHEMA_VERSION
    && version !== STYLE_MAP_DEFINITION_SCHEMA_VERSION) {
    throw new Error("map_definition_version_unsupported");
  }
  let upgraded;
  try {
    upgraded = structuredClone(definition);
  } catch {
    throw new Error("map_definition_invalid");
  }
  if (upgraded.extensions !== undefined && (!upgraded.extensions
    || typeof upgraded.extensions !== "object" || Array.isArray(upgraded.extensions))) {
    throw new Error("map_extensions_invalid");
  }
  if (Object.hasOwn(upgraded.extensions ?? {}, "opengeoRenderer")) {
    validateRendererPreference(upgraded.extensions.opengeoRenderer);
  }
  for (const layer of Array.isArray(upgraded.layers) ? upgraded.layers : []) {
    validateOpacityMode(layer);
    if(layer.labels?.drawOrder!==undefined&&!["with-layer","above-data"].includes(layer.labels.drawOrder))throw Error("Invalid label drawing order");
    if(Object.hasOwn(layer,"filter"))validateMapFilter(layer.filter);
    if (Object.hasOwn(layer, "styleReference")) {
      if (version !== STYLE_MAP_DEFINITION_SCHEMA_VERSION) throw new Error("Style reference requires map definition 1.4.0");
      validateLayerStyleReference(layer.styleReference);
    }
    if (Object.hasOwn(layer.labels ?? {}, "fontRef")) validateMapFontRef(layer.labels.fontRef);
  }
  return {
    ...upgraded,
    schemaVersion: version === STYLE_MAP_DEFINITION_SCHEMA_VERSION ? version : MAP_DEFINITION_SCHEMA_VERSION,
    activeProcessingModelId: typeof upgraded.activeProcessingModelId === "string"
      ? upgraded.activeProcessingModelId
      : null,
    models: Array.isArray(upgraded.models) ? upgraded.models : [],
    processingHistory: Array.isArray(upgraded.processingHistory)
      ? upgraded.processingHistory
      : [],
    measurements: Array.isArray(upgraded.measurements)
      ? upgraded.measurements
      : []
  };
}
