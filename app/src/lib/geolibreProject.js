import {emptyMapDefinition} from "./mapDefinition.js";
import {
  convertGeoLibreProcessing,
  normalizeProcessingHistory,
  normalizeProcessingModels
} from "./processingRegistry.js";

const MAX_PROJECT_BYTES = 1_048_576;
const MAX_DEPTH = 40;
const MAX_NODES = 100_000;
const MAX_LAYERS = 200;
const GEOLIBRE_PROJECT_VERSION = "0.2.0";
const GEOLIBRE_RELEASE = Object.freeze({
  product: "geolibre",
  version: "2.6.0",
  commit: "ef1604f66bb19157ea24202d78bdc60aad6e53a3"
});
const GEOLIBRE_RENDERER_RELEASE = Object.freeze({
  product: "geolibre",
  version: "3.0.0",
  commit: "9778da6cbf5c06d5395b0725f24f025a029bc3df"
});
const OPENGEO_RELEASE = Object.freeze({product: "opengeo", version: "0.1.0", commit: null});
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|private[-_]?key|client[-_]?secret)$/i;
const SENSITIVE_QUERY_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|signature|authorization|credential)/i;
const SUPPORTED_VERSIONS = new Set(["0.1.0", GEOLIBRE_PROJECT_VERSION]);
const DIRECT_SOURCE_TYPES = Object.freeze({
  "vector-tiles": "vector-tile-url",
  wmts: "wmts-url",
  arcgis: "arcgis-feature-url",
  cog: "cog-url",
  zarr: "zarr-url",
  "3d-tiles": "three-d-tiles-url",
  raster: "raster-tile-url",
  video: "video-url"
});
const PRESERVED_ROOT_FIELDS = Object.freeze([
  "layerGroups",
  "plugins",
  "legend",
  "storymap",
  "models",
  "processingHistory",
  "widgets",
  "dashboardColumns",
  "mapLayout",
  "secondaryMapViews",
  "primaryMapLabel",
  "styleLibrary",
  "comments"
]);
const ROOT_FIELDS = new Set([
  "id", "version", "name", "mapView", "basemapStyleUrl", "basemapVisible",
  "basemapOpacity", "layers", "selectedLayerId", "styles", "preferences",
  "metadata", "primaryRenderer", ...PRESERVED_ROOT_FIELDS
]);
const NATIVE_ROOT_MAPPINGS = Object.freeze({
  selectedLayerId: "activeLayerId",
  layerGroups: "layerGroups",
  legend: "legend",
  storymap: "storymap",
  models: "models",
  processingHistory: "processingHistory",
  widgets: "widgets",
  dashboardColumns: "dashboardColumns",
  mapLayout: "mapLayout",
  primaryMapLabel: "primaryMapLabel",
  styleLibrary: "styleLibrary",
  comments: "comments"
});
const LAYER_CORE_FIELDS = new Set(["id", "name", "type", "source", "visible", "opacity", "style", "metadata", "geojson", "groupId"]);
const BASIC_STYLE_FIELDS = new Set(["fillColor", "strokeColor", "strokeWidth", "fillOpacity", "circleRadius", "minZoom", "maxZoom", "labels"]);

export const GEOLIBRE_IMPORT_LIMITS = Object.freeze({
  maxProjectBytes: MAX_PROJECT_BYTES,
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxLayers: MAX_LAYERS,
  networkAccess: "disabled"
});

export function importGeoLibreProject(input) {
  const raw = parseBoundedProject(input);
  validateRoot(raw);
  const reference = raw.primaryRenderer === undefined ? GEOLIBRE_RELEASE : GEOLIBRE_RENDERER_RELEASE;
  const report = createReport("import", raw.name, {
    product: reference.product,
    version: raw.version,
    commit: reference.commit
  }, OPENGEO_RELEASE);
  const project = sanitizeProject(raw, report);
  const processingConversion = convertGeoLibreProcessing(project);
  const mapViews = [openGeoView("map_primary", project.mapView)];
  for (const [index, secondary] of array(project.secondaryMapViews).entries()) {
    if (!isRecord(secondary) || !isRecord(secondary.view)) continue;
    mapViews.push({
      ...openGeoView(stringOr(secondary.id, `secondary-${index}`), secondary.view),
      ...(typeof secondary.label === "string" ? {label: secondary.label} : {}),
      ...(typeof secondary.viewKind === "string" ? {viewKind: secondary.viewKind} : {}),
      ...(isRecord(secondary.layerVisibility) ? {layerVisibility: cloneJson(secondary.layerVisibility)} : {})
    });
  }
  addField(report, "$.mapView", "mapped", "Primary camera mapped to the OpenGeo Studio primary view.", "$.definition.mapViews[0]");
  if (mapViews.length > 1) {
    addField(report, "$.secondaryMapViews", "mapped", "Secondary camera records mapped without changing their layer visibility overrides.", "$.definition.mapViews[1:]");
  }

  const basemaps = [];
  if (typeof project.basemapStyleUrl === "string") {
    basemaps.push({
      basemapId: "geolibre-basemap",
      title: "GeoLibre basemap",
      url: project.basemapStyleUrl || null,
      kind: "maplibre-style",
      visible: project.basemapVisible !== false,
      opacity: clamp(numberOr(project.basemapOpacity, 1), 0, 1)
    });
    addField(report, "$.basemapStyleUrl", "mapped", "MapLibre style reference mapped as a typed basemap record.", "$.definition.basemaps[0]");
  }

  const externalSources = [];
  const embeddedDatasets = [];
  const layers = [];
  for (const [index, layer] of project.layers.entries()) {
    const mapped = importLayer(layer, index, report, externalSources, embeddedDatasets);
    if (mapped) layers.push(mapped);
  }

  const models = normalizeProcessingModels(project.models);
  const processingHistory = normalizeProcessingHistory(project.processingHistory);
  const definition = {
    ...emptyMapDefinition(),
    version: "1.0.0",
    mapViews,
    basemaps,
    bookmarks: [],
    activeLayerId: layers.some(({layerId}) => layerId === project.selectedLayerId)
      ? project.selectedLayerId
      : null,
    activeProcessingModelId: models[0]?.id ?? null,
    models,
    processingHistory,
    projection: project.preferences?.map?.projection === "mercator" ? "mercator" : "globe",
    colorMode: "dark",
    layers,
    styles: cloneJson(project.styles ?? {}),
    preferences: cloneJson(project.preferences ?? {}),
    metadata: cloneJson(project.metadata ?? {}),
    ...(project.layerGroups ? {layerGroups: cloneJson(project.layerGroups)} : {}),
    ...(project.legend ? {legend: cloneJson(project.legend)} : {}),
    ...(project.storymap ? {storymap: cloneJson(project.storymap)} : {}),
    ...(project.widgets ? {widgets: cloneJson(project.widgets)} : {}),
    ...(project.dashboardColumns !== undefined ? {dashboardColumns: project.dashboardColumns} : {}),
    ...(project.mapLayout ? {mapLayout: cloneJson(project.mapLayout)} : {}),
    ...(project.primaryMapLabel ? {primaryMapLabel: project.primaryMapLabel} : {}),
    ...(project.styleLibrary ? {styleLibrary: cloneJson(project.styleLibrary)} : {}),
    ...(project.comments ? {comments: cloneJson(project.comments)} : {}),
    extensions: {
      geolibre: {
        schemaVersion: "1.0.0",
        upstream: cloneJson(reference),
        processingConversion: cloneJson(processingConversion),
        project
      }
    }
  };
  if (project.primaryRenderer === "cesium" || project.primaryRenderer === "maplibre") {
    definition.extensions.opengeoRenderer = {id: project.primaryRenderer};
    addField(report, "$.primaryRenderer", "mapped", "Primary renderer mapped to the saved OpenGeo Studio preference; activation still checks content compatibility.", "$.definition.extensions.opengeoRenderer.id");
  } else if (project.primaryRenderer !== undefined && project.primaryRenderer !== null) {
    addField(report, "$.primaryRenderer", "unsupported", "Unknown primary renderer retained in the source extension; OpenGeo Studio opens with MapLibre.", "$.definition.extensions.geolibre.project.primaryRenderer");
  }
  if (raw.primaryRenderer !== undefined) {
    report.warnings.push("Renderer mapping uses the pinned GeoLibre 3.0.0 source. The file declares its project format, not its producing application release; the reference pin is not file provenance.");
  }
  if (project.preferences?.map?.cesiumBasemap !== undefined || project.preferences?.map?.terrainEnabled === true) {
    addField(report, "$.preferences.map", "preserved_extension", "GeoLibre native basemap and terrain settings are retained as preferences but are not activated by renderer conversion. Review the background and terrain in OpenGeo Studio.", "$.definition.preferences.map");
  }
  addField(report, "$.name", "mapped", "Project name mapped to the OpenGeo Studio map record.", "$.map.name");
  addField(report, "$.styles", "mapped", "Named styles retained in the map definition and the GeoLibre extension.", "$.definition.styles");
  addField(report, "$.metadata", "mapped", "Project metadata retained as structured OpenGeo Studio metadata.", "$.definition.metadata");
  for (const [key, target] of Object.entries(NATIVE_ROOT_MAPPINGS)) {
    if (project[key] !== undefined) addField(report, `$.${key}`, "mapped", `${key} retained as structured OpenGeo Studio project state.`, `$.definition.${target}`);
  }
  for (const model of processingConversion.models) {
    for (const step of model.steps) {
      addField(
        report,
        `$.models.${model.id}.steps.${step.id}`,
        step.status === "mapped" ? "mapped" : "unsupported",
        step.status === "mapped"
          ? `GeoLibre tool ${step.sourceToolId} maps to OpenGeo Studio tool ${step.openGeoToolId}; import remains non-executing.`
          : `GeoLibre tool ${step.sourceToolId} is preserved with an operation-level unsupported result and is never executed during import.`,
        `$.definition.extensions.geolibre.processingConversion.models.${model.id}.steps.${step.id}`
      );
    }
  }
  for (const run of processingConversion.history) {
    addField(
      report,
      `$.processingHistory.${run.id}`,
      run.status === "mapped" ? "mapped" : "unsupported",
      run.status === "mapped"
        ? `GeoLibre history tool ${run.sourceToolId} maps to OpenGeo Studio tool ${run.openGeoToolId}.`
        : `GeoLibre history tool ${run.sourceToolId} remains preserved and cannot be re-run in OpenGeo Studio.`,
      `$.definition.extensions.geolibre.processingConversion.history.${run.id}`
    );
  }
  if (project.secondaryMapViews !== undefined && mapViews.length <= 1) {
    addField(report, "$.secondaryMapViews", "preserved_extension", "Malformed or empty secondary views remain in the GeoLibre extension.");
  }
  if (project.plugins !== undefined) {
    addField(report, "$.plugins", "preserved_extension", "Plugin declarations are retained but never loaded during import.");
  }
  for (const key of Object.keys(project)) {
    if (!ROOT_FIELDS.has(key)) addField(report, `$.${key}`, "preserved_extension", "Unknown safe root field retained in the GeoLibre extension.");
  }
  finishReport(report);
  return {
    schemaVersion: "1.0.0",
    map: {name: project.name, description: null, definition},
    records: {externalSources, embeddedDatasets, processingConversion},
    report
  };
}

export function exportGeoLibreProject(openGeo, options = {}) {
  if (!isRecord(openGeo)) throw new Error("OpenGeo Studio project must be an object.");
  const inputDefinition = isRecord(openGeo.definition) ? openGeo.definition : openGeo;
  // Workbench snapshots contain unset optional object properties. Match saved
  // JSON's omission of these while still rejecting invalid arrays/values before
  // serialization could silently turn them into null or discard them.
  assertJsonValue(inputDefinition, {nodes: 0, omitUndefinedProperties: true});
  const definition = cloneJson(inputDefinition);
  const base = definition.extensions?.geolibre?.project;
  const renderer = definition.extensions?.opengeoRenderer?.id;
  const hasCategoryStyle = array(definition.layers).some((layer) => layer?.style?.renderer === "category");
  const reference = hasCategoryStyle || renderer === "cesium" || (renderer === undefined && base?.primaryRenderer === "cesium")
    ? GEOLIBRE_RENDERER_RELEASE : GEOLIBRE_RELEASE;
  const report = createReport("export", stringOr(openGeo.name, "opengeo-project"), OPENGEO_RELEASE, reference);
  const project = isRecord(base) ? sanitizeProject(cloneJson(base), report) : {};
  const primaryView = array(definition.mapViews)[0];
  const basemap = array(definition.basemaps).find((entry) => entry?.visible !== false) ?? array(definition.basemaps)[0];
  project.version = GEOLIBRE_PROJECT_VERSION;
  project.name = requiredName(openGeo.name ?? definition.name ?? project.name ?? "OpenGeo Studio project", "OpenGeo Studio project name");
  project.mapView = geoLibreView(primaryView ?? project.mapView);
  project.basemapStyleUrl = typeof basemap?.url === "string" ? basemap.url : stringOr(project.basemapStyleUrl, "");
  project.basemapVisible = basemap ? basemap.visible !== false : project.basemapVisible !== false;
  project.basemapOpacity = basemap ? clamp(numberOr(basemap.opacity, 1), 0, 1) : clamp(numberOr(project.basemapOpacity, 1), 0, 1);
  project.styles = cloneJson(definition.styles ?? project.styles ?? {});
  project.preferences = cloneJson(definition.preferences ?? project.preferences ?? {});
  if (renderer === "cesium") {
    project.primaryRenderer = "cesium";
    addField(report, "$.definition.extensions.opengeoRenderer.id", "mapped", "Primary Cesium preference written using GeoLibre 3.0.0 project semantics.", "$.primaryRenderer");
  } else if (renderer !== undefined) {
    // Clear an imported Cesium preference after a deliberate engine change.
    delete project.primaryRenderer;
    if (renderer === "maplibre") {
      addField(report, "$.definition.extensions.opengeoRenderer.id", "mapped", "MapLibre is the default GeoLibre primary renderer; the non-default field is omitted.", "$.primaryRenderer");
    } else {
      addField(report, "$.definition.extensions.opengeoRenderer.id", "preserved_extension", "This renderer has no native primaryRenderer value in the reviewed GeoLibre format. Its preference remains in OpenGeo Studio metadata; GeoLibre opens its default renderer.", "$.metadata.opengeo.definitionExtensions.opengeoRenderer");
    }
  }
  if (project.primaryRenderer === "cesium") {
    report.warnings.push("Primary Cesium selection requires GeoLibre 3.0.0; older readers may ignore it. Native background, terrain and layer capabilities can differ.");
  }
  for (const [projectKey, definitionKey] of Object.entries(NATIVE_ROOT_MAPPINGS)) {
    if (definition[definitionKey] !== undefined) {
      project[projectKey] = cloneJson(definition[definitionKey]);
    }
  }
  project.metadata = cloneJson(project.metadata ?? {});
  project.metadata.opengeo = {
    schemaVersion: "1.0.0",
    ...(definition.extensions ? {definitionExtensions: cloneJson(definition.extensions)} : {})
  };
  project.selectedLayerId = definition.activeLayerId ?? project.selectedLayerId ?? null;
  const originalLayers = new Map(array(project.layers).filter(isRecord).map((layer) => [layer.id, layer]));
  const embeddedData = options.embeddedDataByLayerId instanceof Map
    ? options.embeddedDataByLayerId
    : new Map(Object.entries(options.embeddedDataByLayerId ?? {}));
  project.layers = array(definition.layers).filter(isRecord).slice(0, MAX_LAYERS).map((layer, index) =>
    exportLayer(layer, index, originalLayers.get(layer.layerId), embeddedData.get(layer.layerId), report)
  );
  // GeoLibre hydrates this override after layer.style. Keep a previously saved
  // override from replacing a deliberately exported category palette/opacity.
  for (const layer of project.layers) {
    if (layer.metadata?.opengeo?.layer?.style?.renderer !== "category" || !isRecord(project.styles[layer.id])) continue;
    for (const key of ["vectorStyleMode", "vectorStyleProperty", "vectorStyleStops", "fillColor", "fillOpacity", "simpleStyleEnabled"]) {
      project.styles[layer.id][key] = cloneJson(layer.style[key]);
    }
  }
  if (options.dropPreservedLayers !== true) {
    const exportedIds = new Set(project.layers.map((layer) => layer.id));
    for (const [id, original] of originalLayers) {
      if (exportedIds.has(id)) continue;
      project.layers.push(cloneJson(original));
      addField(report, `$.extensions.geolibre.project.layers.${id}`, "preserved_extension", "A GeoLibre-only layer remains a native GeoLibre layer on compatibility export.", `$.layers[${project.layers.length - 1}]`);
    }
  }
  addField(report, "$.definition.mapViews[0]", "mapped", "Primary OpenGeo Studio camera mapped to GeoLibre mapView.", "$.mapView");
  addField(report, "$.definition.basemaps", "mapped", "The active OpenGeo Studio basemap mapped to the GeoLibre style reference.", "$.basemapStyleUrl");
  if (definition.models !== undefined) {
    addField(report, "$.definition.models", "mapped", "Saved processing models mapped to GeoLibre native model records.", "$.models");
  }
  if (definition.processingHistory !== undefined) {
    addField(report, "$.definition.processingHistory", "mapped", "Portable processing history mapped to GeoLibre native run records; OpenGeo Studio receipt extensions remain in OpenGeo Studio metadata.", "$.processingHistory");
  }
  addField(report, "$.definition.extensions", "preserved_extension", "OpenGeo Studio extensions are nested under project metadata instead of flattened.", "$.metadata.opengeo.definitionExtensions");
  finishReport(report);
  const sanitized = sanitizeProject(project, report);
  finishReport(report);
  const json = JSON.stringify(sanitized, null, 2);
  if (byteLength(json) > MAX_PROJECT_BYTES) throw new Error(`Exported GeoLibre project exceeds ${MAX_PROJECT_BYTES} bytes.`);
  return {schemaVersion: "1.0.0", project: sanitized, json, report};
}

function importLayer(layer, index, report, externalSources, embeddedDatasets) {
  if (!isRecord(layer)) {
    addField(report, `$.layers[${index}]`, "unsupported", "Non-object layer was retained only in the project extension.");
    return null;
  }
  const id = requiredId(layer.id, `GeoLibre layer ${index} id`);
  const name = requiredName(layer.name ?? id, `GeoLibre layer ${id} name`);
  const type = typeof layer.type === "string" ? layer.type : "unknown";
  const source = isRecord(layer.source) ? layer.source : {};
  const common = {
    layerId: id,
    datasetId: `import:${id}`,
    importRef: `geolibre:${id}`,
    title: name,
    visible: layer.visible !== false,
    opacity: clamp(numberOr(layer.opacity, 1), 0, 1),
    order: index,
    style: openGeoStyle(layer.style),
    labels: openGeoLabels(layer.style?.labels),
    geolibre: {type, ...(typeof layer.groupId === "string" ? {groupId: layer.groupId} : {})}
  };
  reportLayerPreservation(layer, index, report);
  if (report.fields.some((field) => field.outcome === "rejected_sensitive" && field.path.startsWith(`$.layers[${index}].source`))) {
    addField(report, `$.layers[${index}].source`, "unsupported", "A credential-bearing source was sanitized and must be re-registered through a governed secret binding before use.");
    return null;
  }
  if (type === "geojson") {
    if (isFeatureCollection(layer.geojson)) {
      common.sourceType = "geojson-object";
      common.objectId = `pending-import:${id}`;
      common.geometryType = geometryType(layer.geojson);
      common.bbox = validBbox(source.bounds) ? cloneJson(source.bounds) : null;
      embeddedDatasets.push({
        importRef: common.importRef,
        layerId: id,
        name,
        format: "geojson",
        contentType: "application/geo+json",
        data: cloneJson(layer.geojson),
        metadata: cloneJson(layer.metadata ?? {})
      });
      addField(report, `$.layers[${index}]`, "mapped", "Embedded GeoJSON mapped to an ingestion candidate and project layer.", `$.records.embeddedDatasets[${embeddedDatasets.length - 1}]`);
      return common;
    }
    const url = publicHttpsUrl(source.url);
    if (url) {
      common.sourceType = "geojson-url";
      common.sourceUrl = url;
      common.geometryType = null;
      common.bbox = validBbox(source.bounds) ? cloneJson(source.bounds) : null;
      addField(report, `$.layers[${index}]`, "mapped", "External GeoJSON reference mapped without fetching it.", `$.definition.layers[${index}]`);
      return common;
    }
  }
  if (type === "xyz") {
    const url = xyzUrl(source);
    if (url) {
      const draft = {...xyzDraft(name, url, source), importRef: common.importRef};
      externalSources.push(draft);
      Object.assign(common, {sourceType: "xyz-raster", sourceUrl: url, sourceConfiguration: cloneJson(draft.source), tileUrl: url, geometryType: "Raster", bbox: validBbox(source.bounds) ? cloneJson(source.bounds) : null});
      addField(report, `$.layers[${index}]`, "mapped", "XYZ template mapped to a governed external-source candidate without making a request.", `$.records.externalSources[${externalSources.length - 1}]`);
      return common;
    }
  }
  if (type === "wms") {
    const draft = wmsDraft(name, source);
    if (draft) {
      draft.importRef = common.importRef;
      externalSources.push(draft);
      Object.assign(common, {sourceType: "wms-raster", sourceUrl: draft.source.url, sourceConfiguration: cloneJson(draft.source), tileUrl: array(source.tiles)[0], geometryType: "Raster", bbox: validBbox(source.bounds) ? cloneJson(source.bounds) : null});
      addField(report, `$.layers[${index}]`, "mapped", "WMS endpoint and request parameters mapped to a governed external-source candidate without capabilities discovery.", `$.records.externalSources[${externalSources.length - 1}]`);
      return common;
    }
  }
  if (type === "pmtiles") {
    const draft = pmtilesDraft(name, source);
    if (draft) {
      draft.importRef = common.importRef;
      externalSources.push(draft);
      Object.assign(common, {
        sourceType: `pmtiles-${draft.source.tileType}`,
        sourceUrl: draft.source.url,
        sourceConfiguration: cloneJson(draft.source),
        sourceLayer: draft.source.sourceLayer ?? null,
        geometryType: draft.source.geometryType ?? "Raster",
        bbox: validBbox(source.bounds) ? cloneJson(source.bounds) : null
      });
      addField(report, `$.layers[${index}]`, "mapped", "PMTiles archive mapped to a governed external-source candidate without reading archive bytes.", `$.records.externalSources[${externalSources.length - 1}]`);
      return common;
    }
  }
  const directType = DIRECT_SOURCE_TYPES[type];
  const directUrl = publicHttpsUrl(source.url ?? array(source.tiles)[0]);
  if (directType && directUrl) {
    Object.assign(common, {sourceType: directType, sourceUrl: directUrl, geometryType: ["raster", "cog", "video"].includes(type) ? "Raster" : null, bbox: validBbox(source.bounds) ? cloneJson(source.bounds) : null});
    addField(report, `$.layers[${index}]`, "mapped", `${type} URL mapped without dereferencing it.`, `$.definition.layers[${index}]`);
    return common;
  }
  addField(report, `$.layers[${index}]`, "unsupported", `GeoLibre ${type} is retained in the extension but has no safe native OpenGeo Studio mapping in this increment.`);
  return null;
}

function reportLayerPreservation(layer, index, report) {
  const style = isRecord(layer.style) ? layer.style : {};
  addField(report, `$.layers[${index}].style`, "mapped", "Basic symbol and label fields map natively; the complete GeoLibre style remains in the layer extension.", `$.definition.layers[${index}].style`);
  if (Object.keys(style).some((key) => !BASIC_STYLE_FIELDS.has(key))) {
    addField(report, `$.layers[${index}].style.geolibre`, "preserved_extension", "Advanced GeoLibre styling is preserved without claiming native rendering parity.", `$.definition.layers[${index}].style.geolibre`);
  }
  for (const key of Object.keys(layer)) {
    if (!LAYER_CORE_FIELDS.has(key)) {
      addField(report, `$.layers[${index}].${key}`, "preserved_extension", "GeoLibre-only layer semantics remain in the compatibility envelope.");
    }
  }
}

function exportLayer(layer, index, original, embedded, report) {
  const id = requiredId(layer.layerId ?? original?.id ?? `layer-${index}`, `OpenGeo Studio layer ${index} id`);
  const output = isRecord(original) ? cloneJson(original) : {};
  output.id = id;
  output.name = requiredName(layer.title ?? original?.name ?? id, `OpenGeo Studio layer ${id} name`);
  output.visible = layer.visible !== false;
  output.opacity = clamp(numberOr(layer.opacity, 1), 0, 1);
  output.metadata = cloneJson(output.metadata ?? {});
  output.metadata.opengeo = {schemaVersion: "1.0.0", layer: cloneJson(layer)};
  const sourceType = layer.sourceType;
  const embeddedData = embedded?.complete === true ? embedded.data : embedded;
  if (isRecord(embedded) && Object.hasOwn(embedded, "complete") && embedded.complete !== true) {
    throw new Error(`Layer ${id} requires complete data for GeoLibre export.`);
  }
  output.style = geoLibreStyle(layer.style, layer.labels, output.style, embeddedData, report, index);
  if (sourceType === "xyz-raster" || sourceType === "xyz-url") {
    output.type = "xyz";
    output.source = {type: "raster", tiles: [layer.sourceUrl], url: layer.sourceUrl, ...sourceOptions(layer)};
  } else if (sourceType === "wms-raster" || sourceType === "wms-url") {
    const config = layer.sourceConfiguration ?? {};
    output.type = "wms";
    output.source = {type: "raster", tiles: layer.tileUrl ? [layer.tileUrl] : [], url: layer.sourceUrl, layers: arrayOrCsv(config.layers).join(","), styles: arrayOrCsv(config.styles).join(","), format: config.imageFormat ?? config.image_format ?? config.format ?? "image/png", transparent: config.transparent !== false, version: config.version ?? "1.3.0", ...sourceOptions(layer)};
  } else if (sourceType === "pmtiles-vector" || sourceType === "pmtiles-raster") {
    const config = layer.sourceConfiguration ?? {};
    const vector = sourceType === "pmtiles-vector";
    output.type = "pmtiles";
    output.source = {
      url: layer.sourceUrl,
      tileType: vector ? "vector" : "raster",
      sourceLayer: vector ? layer.sourceLayer ?? config.sourceLayer ?? config.source_layer : undefined,
      geometryType: vector ? layer.geometryType ?? config.geometryType ?? config.geometry_type : undefined,
      minzoom: config.minZoom ?? config.min_zoom ?? layer.minZoom ?? 0,
      maxzoom: config.maxZoom ?? config.max_zoom ?? layer.maxZoom ?? 24,
      ...(typeof config.attribution === "string" ? {attribution: config.attribution} : {})
    };
  } else if ((sourceType === "geojson-object"
    || (sourceType === "governed-dataset" && (embedded?.complete === true || original?.type === "geojson"))) && isFeatureCollection(embeddedData)) {
    assertJsonValue(embeddedData);
    output.type = "geojson";
    output.source = {type: "geojson"};
    output.geojson = cloneJson(embeddedData);
    // Browser snapshots also carry their working data inline. Keep one exact
    // native copy instead of duplicating it in the metadata envelope, where a
    // small editable Project could otherwise exceed the same file size limit.
    // Distinct inline content remains preserved as part of the Layer record.
    if (isFeatureCollection(layer.geojson) && JSON.stringify(layer.geojson) === JSON.stringify(embeddedData)) {
      delete output.metadata.opengeo.layer.geojson;
      addField(report, `$.definition.layers[${index}].geojson`, "mapped", "Identical browser Layer data is retained once in native GeoJSON.", `$.layers[${index}].geojson`);
    }
  } else if (sourceType === "geojson-url") {
    output.type = "geojson";
    output.source = {type: "geojson", url: layer.sourceUrl};
    delete output.geojson;
  } else if (isRecord(original)) {
    addField(report, `$.definition.layers[${index}].sourceType`, "preserved_extension", "The original GeoLibre source is retained; the current OpenGeo Studio record is nested in layer metadata.", `$.layers[${index}].metadata.opengeo.layer`);
  } else {
    output.type = "geojson";
    output.source = {type: "geojson"};
    output.geojson = {type: "FeatureCollection", features: []};
    output.visible = false;
    report.losses.push(`Layer ${id} has no GeoLibre source mapping; GeoLibre receives a hidden empty placeholder while the OpenGeo Studio record remains in metadata.`);
    addField(report, `$.definition.layers[${index}].sourceType`, "unsupported", "No GeoLibre source adapter exists; a reversible metadata envelope accompanies a hidden placeholder.", `$.layers[${index}].metadata.opengeo.layer`);
  }
  addField(report, `$.definition.layers[${index}]`, "mapped", "Layer identity, presentation, and supported style fields mapped to GeoLibre.", `$.layers[${index}]`);
  return output;
}

function parseBoundedProject(input) {
  if (typeof input === "string") {
    if (byteLength(input) > MAX_PROJECT_BYTES) throw new Error(`GeoLibre project exceeds ${MAX_PROJECT_BYTES} bytes.`);
    let parsed;
    try { parsed = JSON.parse(input); } catch { throw new Error("GeoLibre project is not valid JSON."); }
    assertJsonValue(parsed);
    return parsed;
  }
  assertJsonValue(input);
  const text = JSON.stringify(input);
  if (byteLength(text) > MAX_PROJECT_BYTES) throw new Error(`GeoLibre project exceeds ${MAX_PROJECT_BYTES} bytes.`);
  return JSON.parse(text);
}

function validateRoot(project) {
  if (!isRecord(project)) throw new Error("GeoLibre project must be an object.");
  if (!SUPPORTED_VERSIONS.has(project.version)) throw new Error(`Unsupported GeoLibre project version: ${String(project.version)}.`);
  requiredName(project.name, "GeoLibre project name");
  if (!isRecord(project.mapView)) throw new Error("GeoLibre project is missing mapView.");
  if (project.layers !== undefined && !Array.isArray(project.layers)) throw new Error("GeoLibre project layers must be an array.");
  if (array(project.layers).length > MAX_LAYERS) throw new Error(`GeoLibre project exceeds ${MAX_LAYERS} layers.`);
  const ids = new Set();
  for (const [index, layer] of array(project.layers).entries()) {
    if (!isRecord(layer)) continue;
    const id = requiredId(layer.id, `GeoLibre layer ${index} id`);
    if (ids.has(id)) throw new Error(`GeoLibre layer id is duplicated: ${id}.`);
    ids.add(id);
  }
}

function sanitizeProject(project, report) {
  const state = {nodes: 0};
  return sanitizeValue(project, "$", report, state, 0);
}

function sanitizeValue(value, path, report, state, depth) {
  if (++state.nodes > MAX_NODES) throw new Error(`Project exceeds ${MAX_NODES} JSON values.`);
  if (depth > MAX_DEPTH) throw new Error(`Project exceeds maximum JSON depth ${MAX_DEPTH}.`);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeUrlString(value, path, report);
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, `${path}[${index}]`, report, state, depth + 1));
  }
  if (!isRecord(value)) throw new Error(`Project contains a non-JSON object at ${path}.`);
  if (path.endsWith(".preferences.geocoding.apiKeys")) {
    if (Object.keys(value).length) rejectSensitive(report, path, "GeoLibre geocoding API keys are not imported; use a governed secret binding.");
    return {};
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`Project contains forbidden key ${key} at ${path}.`);
    const nextPath = `${path}.${key}`;
    const environmentValue = key === "value" && /\.preferences\.environmentVariables\[\d+\]$/.test(path);
    if (environmentValue || SENSITIVE_KEY.test(key)) {
      rejectSensitive(report, nextPath, "Sensitive value was removed; OpenGeo Studio does not persist imported credentials in project JSON.");
      continue;
    }
    output[key] = sanitizeValue(entry, nextPath, report, state, depth + 1);
  }
  return output;
}

function sanitizeUrlString(value, path, report) {
  if (!/^https?:\/\//i.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { return value; }
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return value;
  rejectSensitive(report, path, "Credentials were removed from a URL; no credential-bearing request will be issued.");
  return url.toString();
}

function assertJsonValue(value, state = {nodes: 0}, depth = 0, path = "$") {
  if (++state.nodes > MAX_NODES) throw new Error(`Project exceeds ${MAX_NODES} JSON values.`);
  if (depth > MAX_DEPTH) throw new Error(`Project exceeds maximum JSON depth ${MAX_DEPTH}.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Project contains a non-finite number at ${path}.`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertJsonValue(entry, state, depth + 1, `${path}[${index}]`);
    return;
  }
  if (!isRecord(value)) throw new Error(`Project contains a non-JSON value at ${path}.`);
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`Project contains forbidden key ${key} at ${path}.`);
    if (entry === undefined && state.omitUndefinedProperties) continue;
    assertJsonValue(entry, state, depth + 1, `${path}.${key}`);
  }
}

function createReport(direction, name, source, target) {
  return {
    $schema: "../schemas/conversion-report.schema.json",
    schemaVersion: "1.0.0",
    conversionId: `geolibre.${direction}.${slug(name)}`,
    direction,
    source: cloneJson(source),
    target: cloneJson(target),
    policy: {networkAccess: "disabled", sensitiveValues: "reject", unknownFields: "preserve_extension", sizeLimitBytes: MAX_PROJECT_BYTES},
    summary: {status: "lossless", mapped: 0, preserved: 0, defaulted: 0, rejected: 0, unsupported: 0},
    fields: [],
    losses: [],
    warnings: []
  };
}

function addField(report, path, outcome, message, targetPath) {
  report.fields.push({path, ...(targetPath ? {targetPath} : {}), outcome, message});
}

function rejectSensitive(report, path, message) {
  addField(report, path, "rejected_sensitive", message);
  report.losses.push(`${path}: sensitive value removed`);
}

function finishReport(report) {
  const counts = {mapped: 0, preserved_extension: 0, defaulted: 0, rejected_sensitive: 0, unsupported: 0};
  for (const field of report.fields) counts[field.outcome] += 1;
  report.summary = {
    status: counts.rejected_sensitive || report.losses.length ? "lossy" : counts.preserved_extension || counts.unsupported ? "preserved_with_extensions" : "lossless",
    mapped: counts.mapped,
    preserved: counts.preserved_extension,
    defaulted: counts.defaulted,
    rejected: counts.rejected_sensitive,
    unsupported: counts.unsupported
  };
}

function openGeoView(id, view) {
  const normalized = geoLibreView(view);
  return {viewId: id, ...normalized};
}

function geoLibreView(view) {
  const source = isRecord(view) ? view : {};
  const center = Array.isArray(source.center) ? source.center : [-100, 40];
  return {
    center: [clamp(numberOr(center[0], -100), -180, 180), clamp(numberOr(center[1], 40), -90, 90)],
    zoom: clamp(numberOr(source.zoom, 2), 0, 24),
    bearing: ((numberOr(source.bearing, 0) % 360) + 360) % 360,
    pitch: clamp(numberOr(source.pitch, 0), 0, 85),
    ...(validBbox(source.bbox) ? {bbox: cloneJson(source.bbox)} : {})
  };
}

function openGeoStyle(style) {
  const source = isRecord(style) ? style : {};
  return {
    fill: stringOr(source.fillColor, "#3b82f6"),
    stroke: stringOr(source.strokeColor, "#1e40af"),
    strokeWidth: numberOr(source.strokeWidth, 2),
    fillOpacity: numberOr(source.fillOpacity, 0.6),
    circleColor: stringOr(source.fillColor, "#3b82f6"),
    circleRadius: numberOr(source.circleRadius, 6),
    minZoom: numberOr(source.minZoom, 0),
    maxZoom: numberOr(source.maxZoom, 24),
    geolibre: cloneJson(source)
  };
}

function openGeoLabels(labels) {
  const source = isRecord(labels) ? labels : {};
  return {enabled: source.enabled === true, field: typeof source.field === "string" && source.field ? source.field : null, geolibre: cloneJson(source)};
}

function geoLibreStyle(style, labels, original, data, report, index) {
  const source = isRecord(style) ? style : {};
  const output = isRecord(original) ? cloneJson(original) : {};
  output.fillColor = stringOr(source.fill, source.fillColor ?? output.fillColor ?? "#3b82f6");
  output.strokeColor = stringOr(source.stroke, source.strokeColor ?? output.strokeColor ?? "#1e40af");
  output.strokeWidth = numberOr(source.strokeWidth, output.strokeWidth ?? 2);
  output.fillOpacity = clamp(numberOr(source.fillOpacityFactor, numberOr(source.fillOpacity, output.fillOpacity ?? 0.6)), 0, 1);
  output.circleRadius = numberOr(source.circleRadius, output.circleRadius ?? 6);
  output.minZoom = numberOr(source.minZoom, output.minZoom ?? 0);
  output.maxZoom = numberOr(source.maxZoom, output.maxZoom ?? 24);
  output.labels = {...(isRecord(output.labels) ? output.labels : {}), ...(isRecord(labels?.geolibre) ? cloneJson(labels.geolibre) : {}), enabled: labels?.enabled === true, field: stringOr(labels?.field, "")};
  if (source.renderer === "category") {
    const stops = geoLibreCategoryStops(source, data);
    output.vectorStyleMode = stops ? "categorized" : "single";
    output.vectorStyleProperty = stops ? source.categoryField : "";
    output.vectorStyleStops = stops ?? [];
    output.simpleStyleEnabled = false;
    addField(report, `$.definition.layers[${index}].style`, stops ? "mapped" : "preserved_extension",
      stops ? "Category values, explicit palette and fill opacity mapped using the pinned GeoLibre 3.0.0 renderer; layer opacity remains separate."
        : "Category styling requires complete embedded data, a non-credential field, an explicit six-digit hex palette and category names without surrounding whitespace. Original styling is retained in metadata; the native layer uses its base fill.",
      `$.layers[${index}].${stops ? "style" : "metadata.opengeo.layer.style"}`);
    if (!stops) report.warnings.push(`Layer ${index + 1}: native categorical styling is unavailable for this source/profile; original settings remain in OpenGeo Studio metadata.`);
  }
  return output;
}

function geoLibreCategoryStops(style, data) {
  const field = style.categoryField, palette = style.palette;
  if (typeof field !== "string" || !field || field !== field.trim() || SENSITIVE_KEY.test(field) || !isFeatureCollection(data)
    || !Array.isArray(palette) || !palette.length || palette.some((color) => typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) return null;
  // Match WorkbenchView's current category ranking and eight-value display cap.
  // GeoLibre trims stop values, so whitespace-bearing keys cannot map exactly.
  const counts = new Map();
  for (const feature of data.features) {
    const value = feature?.properties?.[field];
    if (value === undefined || value === null || value === "") continue;
    const key = String(value);
    if (key !== key.trim()) return null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  return values.length ? values.map(([value], index) => ({value, color: palette[index % palette.length]})) : null;
}

function xyzUrl(source) {
  const value = array(source.tiles)[0] ?? source.url;
  const url = publicHttpsUrl(value, true);
  if (!url) return null;
  const placeholders = [...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  return placeholders.length === 3 && new Set(placeholders).size === 3 && ["z", "x", "y"].every((key) => placeholders.includes(key)) ? url : null;
}

function xyzDraft(name, url, source) {
  return {name, description: "Imported from a GeoLibre 2.6 project without network access.", classification: "internal", tags: ["geolibre", "xyz"], source: {type: "xyz", url, minZoom: clamp(integerOr(source.minzoom, 0), 0, 24), maxZoom: clamp(integerOr(source.maxzoom, 22), 0, 24), tileSize: [256, 512].includes(source.tileSize) ? source.tileSize : 256, scheme: source.scheme === "tms" ? "tms" : "xyz", ...(typeof source.attribution === "string" && source.attribution ? {attribution: source.attribution.slice(0, 1000)} : {})}};
}

function wmsDraft(name, source) {
  const url = publicHttpsUrl(source.url);
  const layers = arrayOrCsv(source.layers).filter((value) => /^[A-Za-z0-9_.:-]{1,200}$/.test(value));
  if (!url || new URL(url).search || !layers.length || layers.length > 32) return null;
  const styles = arrayOrCsv(source.styles);
  if (styles.length && styles.length !== layers.length) return null;
  const imageFormat = ["image/png", "image/jpeg"].includes(source.format) ? source.format : "image/png";
  const transparent = imageFormat === "image/jpeg" ? false : source.transparent !== false;
  return {name, description: "Imported from a GeoLibre 2.6 project without network access.", classification: "internal", tags: ["geolibre", "wms"], source: {type: "wms", url, version: source.version === "1.1.1" ? "1.1.1" : "1.3.0", layers, styles: styles.length ? styles : layers.map(() => ""), imageFormat, transparent, crs: "EPSG:3857", tileSize: [256, 512].includes(source.tileSize) ? source.tileSize : 256, ...(typeof source.attribution === "string" && source.attribution ? {attribution: source.attribution.slice(0, 1000)} : {})}};
}

function pmtilesDraft(name, source) {
  const url = publicHttpsUrl(source.url);
  if (!url || new URL(url).search || new URL(url).hash || !new URL(url).pathname.toLowerCase().endsWith(".pmtiles")) return null;
  const tileType = source.tileType === "vector" || source.tileType === "raster" ? source.tileType : null;
  if (!tileType) return null;
  const sourceLayer = typeof source.sourceLayer === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(source.sourceLayer)
    ? source.sourceLayer
    : null;
  const geometryType = ["Point", "LineString", "Polygon"].includes(source.geometryType)
    ? source.geometryType
    : null;
  if (tileType === "vector" && (!sourceLayer || !geometryType)) return null;
  if (tileType === "raster" && (sourceLayer || geometryType)) return null;
  const minZoom = clamp(integerOr(source.minzoom, 0), 0, 24);
  const maxZoom = clamp(integerOr(source.maxzoom, 24), 0, 24);
  if (minZoom > maxZoom) return null;
  return {
    name,
    description: "Imported from a GeoLibre 2.6 project without network access.",
    classification: "internal",
    tags: ["geolibre", "pmtiles"],
    source: {
      type: "pmtiles",
      url,
      tileType,
      sourceLayer,
      geometryType,
      minZoom,
      maxZoom,
      ...(typeof source.attribution === "string" && source.attribution ? {attribution: source.attribution.slice(0, 1000)} : {})
    }
  };
}

function publicHttpsUrl(value, allowTemplate = false) {
  if (typeof value !== "string" || !value.startsWith("https://") || value.length > 2048) return null;
  if (!allowTemplate && /[{}]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || blockedHostname(url.hostname)) return null;
  for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return null;
  return value;
}

function blockedHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal") || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function sourceOptions(layer) {
  const config = isRecord(layer.sourceConfiguration) ? layer.sourceConfiguration : {};
  return {tileSize: [256, 512].includes(config.tileSize ?? config.tile_size) ? config.tileSize ?? config.tile_size : 256, ...(typeof config.attribution === "string" ? {attribution: config.attribution} : {}), ...(Number.isFinite(config.minZoom ?? config.min_zoom) ? {minzoom: config.minZoom ?? config.min_zoom} : {}), ...(Number.isFinite(config.maxZoom ?? config.max_zoom) ? {maxzoom: config.maxZoom ?? config.max_zoom} : {}), ...(config.scheme === "tms" ? {scheme: "tms"} : {})};
}

function isFeatureCollection(value) { return isRecord(value) && value.type === "FeatureCollection" && Array.isArray(value.features); }
function geometryType(collection) { return [...new Set(collection.features.map((feature) => feature?.geometry?.type).filter((value) => typeof value === "string"))].join("|") || null; }
function validBbox(value) { return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite); }
function array(value) { return Array.isArray(value) ? value : []; }
function arrayOrCsv(value) { return (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map((item) => String(item).trim()).filter(Boolean); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function cloneJson(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function numberOr(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function integerOr(value, fallback) { return Number.isInteger(value) ? value : fallback; }
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
function stringOr(value, fallback) { return typeof value === "string" ? value : fallback; }
function requiredName(value, label) { if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${label} must be 1 to 200 characters.`); return value; }
function requiredId(value, label) { if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error(`${label} must be 1 to 200 characters.`); return value; }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "project"; }
function byteLength(value) { return new TextEncoder().encode(value).byteLength; }
