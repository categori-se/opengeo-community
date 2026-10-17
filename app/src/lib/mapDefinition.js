import {validatePointClustering} from "./pointClustering.js";
import {cogDisplayOptions} from "./cogDisplay.js";
import {validateOpacityMode} from "./layerOpacity.js";
import {validateMapFilter} from "./mapFilter.js";
import {validateLayerStyleReference} from "./layerStyleReference.js";
import {spatialBodyDefinition} from "./spatialBody.js";
import {validateMapFontRef} from "./mapFonts.js";
import {normalizeSavedMeasurements} from "./savedMeasurement.js";

export const STYLE_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.4.0";
export const DISPLAY_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.5.0";
export const SURFACE_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.6.0";
export const MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.3.0";
export const PATH_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.2.0";
export const PROCESSING_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.1.0";
export const LEGACY_MAP_DEFINITION_SCHEMA_VERSION = "opengeo.map-definition.1.0.0";

export function mapDefinitionVersionForLayers(layers, measurements = []) {
  return measurements.some(m => m.kind === "polygon-3d") ? SURFACE_MAP_DEFINITION_SCHEMA_VERSION
    : layers.some(layer => Object.hasOwn(layer, "managedDisplayId")) ? DISPLAY_MAP_DEFINITION_SCHEMA_VERSION
    : layers.some(layer => layer.styleReference) ? STYLE_MAP_DEFINITION_SCHEMA_VERSION : MAP_DEFINITION_SCHEMA_VERSION;
}

/** A saved display is an exact-version preference, never a read ticket or consent. */
export function validateManagedDisplayReference(layer, schemaVersion = DISPLAY_MAP_DEFINITION_SCHEMA_VERSION) {
  if (!Object.hasOwn(layer, "managedDisplayId")) return;
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (![DISPLAY_MAP_DEFINITION_SCHEMA_VERSION, SURFACE_MAP_DEFINITION_SCHEMA_VERSION].includes(schemaVersion) || layer.sourceType !== "governed-dataset"
    || !uuid(layer.managedDisplayId) || !uuid(layer.datasetId) || !uuid(layer.datasetVersionId)
    || !Number.isSafeInteger(layer.sourceVersion) || layer.sourceVersion < 1) {
    throw Error("map_managed_display_reference_invalid");
  }
}

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
    && version !== STYLE_MAP_DEFINITION_SCHEMA_VERSION
    && version !== DISPLAY_MAP_DEFINITION_SCHEMA_VERSION
    && version !== SURFACE_MAP_DEFINITION_SCHEMA_VERSION) {
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
  if(version===SURFACE_MAP_DEFINITION_SCHEMA_VERSION) {
    if(!Array.isArray(upgraded.measurements))throw Error("map_measurements_invalid");
    const normalized=normalizeSavedMeasurements(upgraded.measurements,{spatialBody:spatialBodyDefinition(upgraded.spatialBody?.id)});
    if(normalized.length!==upgraded.measurements.length)throw Error("map_measurements_invalid");
    upgraded.measurements=normalized;
  }
  for (const layer of Array.isArray(upgraded.layers) ? upgraded.layers : []) {
    validateManagedDisplayReference(layer, version);
    validateOpacityMode(layer);
    if (Object.hasOwn(layer, "pointClustering")) validatePointClustering(layer.pointClustering);
    cogDisplayOptions(layer);
    if(layer.labels?.drawOrder!==undefined&&!["with-layer","above-data"].includes(layer.labels.drawOrder))throw Error("Invalid label drawing order");
    if(Object.hasOwn(layer,"filter"))validateMapFilter(layer.filter);
    if (Object.hasOwn(layer, "styleReference")) {
      if (![STYLE_MAP_DEFINITION_SCHEMA_VERSION, DISPLAY_MAP_DEFINITION_SCHEMA_VERSION, SURFACE_MAP_DEFINITION_SCHEMA_VERSION].includes(version)) throw new Error("Style reference requires map definition 1.4.0 or later");
      validateLayerStyleReference(layer.styleReference);
    }
    if (Object.hasOwn(layer.labels ?? {}, "fontRef")) validateMapFontRef(layer.labels.fontRef);
  }
  return {
    ...upgraded,
    schemaVersion: [STYLE_MAP_DEFINITION_SCHEMA_VERSION, DISPLAY_MAP_DEFINITION_SCHEMA_VERSION, SURFACE_MAP_DEFINITION_SCHEMA_VERSION].includes(version) ? version : MAP_DEFINITION_SCHEMA_VERSION,
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
