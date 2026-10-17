import {geoPath, polygonArea} from "d3";

export const PROCESSING_REGISTRY_SCHEMA_VERSION = "opengeo.processing-registry.1.0.0";
export const PROCESSING_RUN_SCHEMA_VERSION = "opengeo.processing-run.1.0.0";
export const PROCESSING_MODEL_SCHEMA_VERSION = "opengeo.processing-model.1.0.0";

export const BROWSER_PROCESSING_LIMITS = Object.freeze({
  maximumFeatures: 50_000,
  maximumCoordinates: 1_000_000,
  maximumModelSteps: 16,
  maximumHistoryEntries: 100,
  maximumLogEntriesPerRun: 20,
  supportedCrs: "CRS:84",
  networkAccess: "disabled"
});

const VECTOR_INPUT = Object.freeze([
  Object.freeze({id: "layer", type: "active-vector-layer", required: true})
]);

export const PROCESSING_TOOLS = Object.freeze([
  browserTool("count", "Browser vector", "Count features", "summary", ["count-features"]),
  browserTool("bounds", "Browser vector", "Calculate bounds", "summary", ["calculate-bounds"]),
  browserTool(
    "bbox-layer",
    "Browser vector",
    "Create bounding-box layer",
    "vector-layer",
    ["bounding-box"]
  ),
  browserTool("centroids", "Browser vector", "Create vertex-mean centers", "vector-layer", ["centroids"]),
  browserTool("geometric-centroids", "Browser vector", "Create planar centroid layer", "vector-layer", []),
  Object.freeze({
    id: "filter-verified",
    version: "1.0.0",
    category: "Browser vector",
    title: "Select verified records",
    engine: "browser",
    executionMode: "browser-view",
    deterministic: true,
    parameters: Object.freeze([
      ...VECTOR_INPUT,
      Object.freeze({id: "field", type: "field", required: false, default: "status"}),
      Object.freeze({id: "value", type: "scalar", required: false, default: "verified"})
    ]),
    output: Object.freeze({kind: "map-filter", durable: false}),
    limits: BROWSER_PROCESSING_LIMITS,
    geolibreToolIds: Object.freeze(["select-by-value"])
  }),
  Object.freeze({
    id: "clear-filter",
    version: "1.0.0",
    category: "Browser vector",
    title: "Clear map filter",
    engine: "browser",
    executionMode: "browser-view",
    deterministic: true,
    parameters: VECTOR_INPUT,
    output: Object.freeze({kind: "map-filter", durable: false}),
    limits: BROWSER_PROCESSING_LIMITS,
    geolibreToolIds: Object.freeze([])
  }),
  durableTool(
    "vector-to-pmtiles",
    "AWS conversion",
    "Vector to PMTiles",
    "opengeo.pmtiles-derivative-request.1.1.0",
    "/projects/{project_id}/datasets/{dataset_id}/versions/{dataset_version_id}/pmtiles-derivatives",
    Object.freeze([
      Object.freeze({id: "datasetVersionId", type: "uuid", required: true}),
      Object.freeze({id: "bounds", type: "crs84-bbox", required: true}),
      Object.freeze({id: "minZoom", type: "integer", required: true, minimum: 0, maximum: 22}),
      Object.freeze({id: "maxZoom", type: "integer", required: true, minimum: 0, maximum: 22}),
      Object.freeze({id: "sourceLayer", type: "identifier", required: true}),
      Object.freeze({id: "options", type: "gdal-pmtiles-options", required: true})
    ]),
    Object.freeze({maximumSourceBytes: 536_870_912, maximumRetainedJobs: 64, maximumActiveJobs: 4})
  ),
  durableTool(
    "raster-to-cog",
    "AWS conversion",
    "Raster to COG",
    "opengeo.coverage-derivative-request.2.0.0",
    "/projects/{project_id}/spatial-services/{service_id}/coverages/{coverage_id}/derivatives",
    Object.freeze([
      Object.freeze({id: "coverageId", type: "uuid", required: true}),
      Object.freeze({id: "subset", type: "source-crs-bbox", required: true}),
      Object.freeze({id: "bands", type: "integer-array", required: false}),
      Object.freeze({id: "targetCrs", type: "epsg-code", required: false}),
      Object.freeze({id: "size", type: "pixel-size", required: false}),
      Object.freeze({id: "resolution", type: "source-crs-resolution", required: false}),
      Object.freeze({
        id: "resampling",
        type: "choice",
        required: true,
        values: Object.freeze(["nearest", "bilinear", "cubic"])
      })
    ]),
    Object.freeze({
      maximumSourceBytes: 536_870_912,
      maximumAxisPixels: 8_192,
      maximumPixels: 16_777_216,
      maximumSamples: 67_108_864,
      maximumRetainedJobs: 64,
      maximumActiveJobs: 4
    })
  ),
  Object.freeze({
    id: "sql-workspace",
    version: "1.0.0",
    category: "Workspace",
    title: "Open SQL workspace",
    engine: "duckdb",
    executionMode: "browser-workspace",
    deterministic: false,
    parameters: Object.freeze([]),
    output: Object.freeze({kind: "workspace", durable: false}),
    limits: Object.freeze({networkAccess: "registered-sources-only"}),
    geolibreToolIds: Object.freeze([])
  }),
  Object.freeze({
    id: "assistant-plan",
    version: "1.0.0",
    category: "Operations",
    title: "Draft auditable operation",
    engine: "audit log",
    executionMode: "plan-only",
    deterministic: false,
    parameters: Object.freeze([]),
    output: Object.freeze({kind: "operation-plan", durable: false}),
    limits: Object.freeze({executesProcessing: false}),
    geolibreToolIds: Object.freeze([])
  })
]);

const TOOL_BY_ID = new Map(PROCESSING_TOOLS.map((tool) => [tool.id, tool]));
const GEOLIBRE_TOOL_TO_OPENGEO = new Map(
  PROCESSING_TOOLS.flatMap((tool) => tool.geolibreToolIds.map((id) => [id, tool.id]))
);

export function processingTool(id) {
  return TOOL_BY_ID.get(id) ?? null;
}

export function openGeoToolIdForGeoLibre(id) {
  return GEOLIBRE_TOOL_TO_OPENGEO.get(id) ?? null;
}

export function processingRegistryDocument() {
  return {
    schemaVersion: PROCESSING_REGISTRY_SCHEMA_VERSION,
    tools: PROCESSING_TOOLS.map((tool) => structuredClone(tool))
  };
}

export function runBrowserProcessingTool({toolId, layerId, layerTitle, geojson, parameters = {}}) {
  const tool = processingTool(toolId);
  if (!tool || tool.executionMode !== "browser-memory") {
    throw processingError("processing_tool_not_executable_in_browser");
  }
  const input = validateFeatureCollection(geojson);
  const title = boundedText(layerTitle, 240, "layer");
  const identity = boundedText(layerId, 160, "layer");
  const bounds = featureCollectionBounds(input.geojson);
  let outputGeojson = null;
  let summary;
  let log;
  if (tool.id === "count") {
    summary = {featureCount: input.featureCount};
    log = `${title}: ${input.featureCount} features.`;
  } else if (tool.id === "bounds") {
    summary = {bounds};
    log = `${title}: ${bounds ? bounds.map((value) => value.toFixed(6)).join(", ") : "no finite bounds"}.`;
  } else if (tool.id === "bbox-layer") {
    if (bounds) outputGeojson = boundingBoxFeatureCollection(bounds, title);
    summary = {bounds, featureCount: outputGeojson?.features.length ?? 0};
    log = `${title}: ${outputGeojson ? "bounding-box layer created" : "no finite bounds"}.`;
  } else if (tool.id === "geometric-centroids") {
    outputGeojson = geometricCentroidFeatureCollection(input.geojson, title);
    summary = {featureCount: outputGeojson.features.length, method: "planar-geometric", crs: "CRS:84"};
    log = `${title}: ${outputGeojson.features.length} planar geometric centroids created in CRS:84.`;
  } else if (tool.id === "centroids") {
    outputGeojson = centroidFeatureCollection(input.geojson, title);
    summary = {featureCount: outputGeojson.features.length};
    log = `${title}: ${outputGeojson.features.length} centroid features created.`;
  } else {
    throw processingError("processing_tool_not_implemented");
  }
  return {
    schemaVersion: PROCESSING_RUN_SCHEMA_VERSION,
    tool: {
      id: tool.id,
      version: tool.version,
      engine: tool.engine,
      deterministic: tool.deterministic
    },
    parameters: safeRecord(parameters),
    input: {
      layerId: identity,
      featureCount: input.featureCount,
      coordinateCount: input.coordinateCount,
      crs: BROWSER_PROCESSING_LIMITS.supportedCrs
    },
    output: {
      kind: tool.output.kind,
      ...summary,
      ...(outputGeojson ? {geojson: outputGeojson} : {})
    },
    logs: [log],
    limits: structuredClone(BROWSER_PROCESSING_LIMITS)
  };
}

export function runBrowserProcessingModel({model, layerId, layerTitle, geojson, signal}) {
  if (!model || typeof model !== "object" || !Array.isArray(model.steps)) {
    throw processingError("processing_model_invalid");
  }
  if (!model.steps.length || model.steps.length > BROWSER_PROCESSING_LIMITS.maximumModelSteps) {
    throw processingError("processing_model_step_count_invalid");
  }
  const modelIdentity = boundedText(model.id, 160, "model");
  const modelName = optionalBoundedText(model.name, 200) ?? modelIdentity;
  const seen = new Set();
  let current = validateFeatureCollection(geojson).geojson;
  const results = [];
  for (const [index, rawStep] of model.steps.entries()) {
    if (signal?.aborted) {
      return modelResult(
        {id: modelIdentity, name: modelName},
        "aborted",
        results,
        current,
        "processing_model_aborted"
      );
    }
    const step = validateModelStep(rawStep, seen);
    const toolId = processingTool(step.toolId) ? step.toolId : openGeoToolIdForGeoLibre(step.toolId);
    if (!toolId) {
      return modelResult(
        {id: modelIdentity, name: modelName},
        "error",
        results,
        current,
        "processing_model_tool_unsupported",
        step
      );
    }
    let receipt;
    try {
      receipt = runBrowserProcessingTool({
        toolId,
        layerId: index === 0 ? layerId : `model:${step.id}`,
        layerTitle: index === 0 ? layerTitle : `${modelName} step ${index}`,
        geojson: current,
        parameters: step.parameters
      });
    } catch (error) {
      return modelResult(
        {id: modelIdentity, name: modelName},
        "error",
        results,
        current,
        error.code ?? "processing_model_failed",
        step
      );
    }
    results.push({step: structuredClone(step), receipt});
    if (receipt.output.geojson) current = receipt.output.geojson;
    else if (index < model.steps.length - 1) {
      return modelResult(
        {id: modelIdentity, name: modelName},
        "error",
        results,
        current,
        "processing_model_previous_step_has_no_layer",
        step
      );
    }
  }
  return modelResult({id: modelIdentity, name: modelName}, "success", results, current, null);
}

export function portableProcessingHistoryEntry(receipt, {
  id = globalThis.crypto?.randomUUID?.(),
  startedAt = new Date().toISOString(),
  durationMs = 0,
  outputLayerNames = []
} = {}) {
  if (!receipt || receipt.schemaVersion !== PROCESSING_RUN_SCHEMA_VERSION) {
    throw processingError("processing_receipt_invalid");
  }
  if (typeof id !== "string" || !id || id.length > 160) {
    throw processingError("processing_history_id_invalid");
  }
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
    throw processingError("processing_history_time_invalid");
  }
  return {
    id,
    kind: "algorithm",
    toolId: receipt.tool.id,
    toolName: processingTool(receipt.tool.id)?.title ?? receipt.tool.id,
    engine: receipt.tool.engine,
    parameters: structuredClone(receipt.parameters),
    inputLayerNames: {[receipt.input.layerId]: receipt.input.layerId},
    ...(outputLayerNames.length ? {outputLayerNames: outputLayerNames.slice(0, 16)} : {}),
    startedAt,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    status: "success",
    opengeo: {
      schemaVersion: PROCESSING_RUN_SCHEMA_VERSION,
      toolVersion: receipt.tool.version,
      deterministic: receipt.tool.deterministic,
      input: structuredClone(receipt.input),
      output: withoutGeojson(receipt.output),
      limits: structuredClone(receipt.limits),
      logs: receipt.logs.slice(0, BROWSER_PROCESSING_LIMITS.maximumLogEntriesPerRun)
    }
  };
}

export function appendProcessingHistory(history, entry) {
  const source = Array.isArray(history) ? history : [];
  const filtered = source.filter((candidate) => candidate?.id !== entry.id);
  return [...filtered, structuredClone(entry)].slice(-BROWSER_PROCESSING_LIMITS.maximumHistoryEntries);
}

export function normalizeProcessingModels(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  const modelIds = new Set();
  for (const candidate of value.slice(0, 100)) {
    if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.steps)) continue;
    const id = optionalBoundedIdentifier(candidate.id);
    if (!id || modelIds.has(id)) continue;
    const steps = [];
    const stepIds = new Set();
    for (const candidateStep of candidate.steps.slice(0, BROWSER_PROCESSING_LIMITS.maximumModelSteps)) {
      if (!candidateStep || typeof candidateStep !== "object") continue;
      const stepId = optionalBoundedIdentifier(candidateStep.id);
      const toolId = optionalBoundedIdentifier(candidateStep.toolId);
      if (!stepId || !toolId || stepIds.has(stepId)) continue;
      stepIds.add(stepId);
      steps.push({
        id: stepId,
        toolId,
        parameters: recoverableRecord(candidateStep.parameters),
      ...(optionalBoundedIdentifier(candidateStep.inputParam)
          ? {inputParam: optionalBoundedIdentifier(candidateStep.inputParam)}
          : {})
      });
    }
    if (!steps.length) continue;
    modelIds.add(id);
    models.push({id, name: optionalBoundedText(candidate.name, 200) ?? id, steps});
  }
  return models;
}

export function normalizeProcessingHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  const ids = new Set();
  for (const candidate of value.slice(-BROWSER_PROCESSING_LIMITS.maximumHistoryEntries)) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = optionalBoundedIdentifier(candidate.id);
    const toolId = optionalBoundedIdentifier(candidate.toolId);
    if (!id || !toolId || ids.has(id)) continue;
    ids.add(id);
    const startedAt = optionalBoundedText(candidate.startedAt, 40)
      && Number.isFinite(Date.parse(candidate.startedAt))
      ? candidate.startedAt.trim()
      : null;
    const opengeo = normalizeReceiptExtension(candidate.opengeo);
    history.push({
      id,
      kind: optionalBoundedText(candidate.kind, 40) ?? "algorithm",
      toolId,
      toolName: optionalBoundedText(candidate.toolName, 200) ?? toolId,
      engine: optionalBoundedText(candidate.engine, 80) ?? "unknown",
      parameters: recoverableRecord(candidate.parameters),
      ...(boundedLayerNameRecord(candidate.inputLayerNames)
        ? {inputLayerNames: boundedLayerNameRecord(candidate.inputLayerNames)}
        : {}),
      ...(startedAt ? {startedAt} : {}),
      ...(Number.isFinite(candidate.durationMs)
        ? {durationMs: Math.min(86_400_000, Math.max(0, candidate.durationMs))}
        : {}),
      status: candidate.status === "success" ? "success" : "error",
      ...(optionalBoundedText(candidate.error, 500) ? {error: optionalBoundedText(candidate.error, 500)} : {}),
      ...(Array.isArray(candidate.outputLayerNames)
        ? {outputLayerNames: candidate.outputLayerNames
          .map((name) => optionalBoundedText(name, 200))
          .filter(Boolean)
          .slice(0, 16)}
        : {}),
      ...(opengeo ? {opengeo} : {})
    });
  }
  return history;
}

export function convertGeoLibreProcessing(project) {
  const models = Array.isArray(project?.models) ? project.models : [];
  const history = Array.isArray(project?.processingHistory) ? project.processingHistory : [];
  const convertedModels = [];
  const convertedHistory = [];
  const unsupported = new Set();
  for (const candidate of models.slice(0, 100)) {
    if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.steps)) continue;
    const steps = [];
    for (const step of candidate.steps.slice(0, BROWSER_PROCESSING_LIMITS.maximumModelSteps)) {
      if (!step || typeof step !== "object" || typeof step.toolId !== "string") continue;
      const openGeoToolId = openGeoToolIdForGeoLibre(step.toolId);
      if (!openGeoToolId) unsupported.add(step.toolId);
      const sourceStepId = optionalBoundedText(step.id, 160) ?? `step-${steps.length + 1}`;
      steps.push({
        id: sourceStepId,
        sourceToolId: step.toolId,
        openGeoToolId,
        status: openGeoToolId ? "mapped" : "preserved-unsupported",
        parameters: recoverableRecord(step.parameters)
      });
    }
    const sourceModelId = optionalBoundedText(candidate.id, 160) ?? `model-${convertedModels.length + 1}`;
    convertedModels.push({
      id: sourceModelId,
      name: optionalBoundedText(candidate.name, 200) ?? sourceModelId,
      steps
    });
  }
  for (const run of history.slice(-BROWSER_PROCESSING_LIMITS.maximumHistoryEntries)) {
    if (!run || typeof run !== "object" || typeof run.toolId !== "string") continue;
    const openGeoToolId = openGeoToolIdForGeoLibre(run.toolId);
    if (!openGeoToolId) unsupported.add(run.toolId);
    convertedHistory.push({
      id: optionalBoundedText(run.id, 160) ?? `run-${convertedHistory.length + 1}`,
      sourceToolId: run.toolId,
      openGeoToolId,
      status: openGeoToolId ? "mapped" : "preserved-unsupported",
      parameters: recoverableRecord(run.parameters),
      sourceStatus: run.status === "success" ? "success" : "error"
    });
  }
  return {
    schemaVersion: "opengeo.geolibre-processing-conversion.1.0.0",
    source: {product: "geolibre", version: "2.6.0"},
    registryVersion: PROCESSING_REGISTRY_SCHEMA_VERSION,
    models: convertedModels,
    history: convertedHistory,
    counts: {
      models: convertedModels.length,
      steps: convertedModels.reduce((sum, model) => sum + model.steps.length, 0),
      history: convertedHistory.length,
      unsupportedTools: unsupported.size
    },
    unsupportedToolIds: [...unsupported].sort(),
    policy: "Known deterministic tools map explicitly; every other operation remains preserved with an operation-level unsupported result and never executes during import."
  };
}

function browserTool(id, category, title, outputKind, geolibreToolIds) {
  return Object.freeze({
    id,
    version: "1.0.0",
    category,
    title,
    engine: "browser",
    executionMode: "browser-memory",
    deterministic: true,
    parameters: VECTOR_INPUT,
    output: Object.freeze({kind: outputKind, durable: false}),
    limits: BROWSER_PROCESSING_LIMITS,
    geolibreToolIds: Object.freeze(geolibreToolIds)
  });
}

function durableTool(id, category, title, requestSchemaVersion, endpoint, parameters, limits) {
  return Object.freeze({
    id,
    version: "1.0.0",
    category,
    title,
    engine: "aws job",
    executionMode: "activation-only-server-job",
    deterministic: true,
    parameters,
    output: Object.freeze({kind: "immutable-object", durable: true}),
    limits,
    requestSchemaVersion,
    endpoint,
    ordinaryReadsCreateWork: false,
    geolibreToolIds: Object.freeze([])
  });
}

function validateFeatureCollection(value) {
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw processingError("processing_input_invalid");
  }
  if (value.features.length > BROWSER_PROCESSING_LIMITS.maximumFeatures) {
    throw processingError("processing_feature_limit_exceeded");
  }
  let coordinateCount = 0;
  for (const feature of value.features) {
    if (
      !feature
      || feature.type !== "Feature"
      || !(
        feature.properties === null
        || (
          typeof feature.properties === "object"
          && !Array.isArray(feature.properties)
        )
      )
    ) {
      throw processingError("processing_feature_invalid");
    }
    coordinateCount += geometryCoordinateCount(feature.geometry);
    if (coordinateCount > BROWSER_PROCESSING_LIMITS.maximumCoordinates) {
      throw processingError("processing_coordinate_limit_exceeded");
    }
  }
  return {geojson: structuredClone(value), featureCount: value.features.length, coordinateCount};
}

function geometryCoordinateCount(geometry) {
  if (geometry === null) return 0;
  if (!geometry || typeof geometry !== "object" || typeof geometry.type !== "string") {
    throw processingError("processing_geometry_invalid");
  }
  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) throw processingError("processing_geometry_invalid");
    return geometry.geometries.reduce((sum, child) => sum + geometryCoordinateCount(child), 0);
  }
  let count = 0;
  const visit = (coordinates) => {
    if (!Array.isArray(coordinates)) throw processingError("processing_geometry_invalid");
    if (coordinates.length >= 2 && coordinates.every(Number.isFinite)) {
      count += 1;
      return;
    }
    for (const child of coordinates) visit(child);
  };
  visit(geometry.coordinates);
  return count;
}

function featureCollectionBounds(geojson) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && value.every(Number.isFinite)) {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  const geometry = (candidate) => {
    if (!candidate) return;
    if (candidate.type === "GeometryCollection") {
      for (const child of candidate.geometries ?? []) geometry(child);
      return;
    }
    visit(candidate.coordinates);
  };
  for (const feature of geojson.features) geometry(feature.geometry);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function boundingBoxFeatureCollection(bounds, title) {
  const [west, south, east, north] = bounds;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {source_layer: title},
      geometry: {
        type: "Polygon",
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
      }
    }]
  };
}

function centroidFeatureCollection(geojson, title) {
  const features = [];
  for (const [index, feature] of geojson.features.entries()) {
    const positions = [];
    collectPositions(feature.geometry, positions);
    if (!positions.length) continue;
    const center = positions.reduce(
      (sum, coordinate) => [sum[0] + coordinate[0], sum[1] + coordinate[1]],
      [0, 0]
    ).map((value) => value / positions.length);
    features.push({
      type: "Feature",
      properties: {source_index: index + 1, source_layer: title},
      geometry: {type: "Point", coordinates: center}
    });
  }
  return {type: "FeatureCollection", features};
}

function collectPositions(geometry, target) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries ?? []) collectPositions(child, target);
    return;
  }
  if (geometry.type === "Point") {
    collectPosition(geometry.coordinates, target);
  } else if (geometry.type === "MultiPoint" || geometry.type === "LineString") {
    collectLine(geometry.coordinates, target, false);
  } else if (geometry.type === "MultiLineString") {
    for (const line of geometry.coordinates) collectLine(line, target, false);
  } else if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) collectLine(ring, target, true);
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) collectLine(ring, target, true);
    }
  } else {
    throw processingError("processing_geometry_invalid");
  }
}

function collectLine(value, target, excludeClosingCoordinate) {
  if (!Array.isArray(value)) throw processingError("processing_geometry_invalid");
  const end = excludeClosingCoordinate && ringIsClosed(value) ? value.length - 1 : value.length;
  for (let index = 0; index < end; index += 1) collectPosition(value[index], target);
}

function collectPosition(value, target) {
  if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) {
    throw processingError("processing_geometry_invalid");
  }
  target.push([value[0], value[1]]);
}

function ringIsClosed(ring) {
  if (ring.length < 2) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Array.isArray(first)
    && Array.isArray(last)
    && first.length >= 2
    && last.length >= 2
    && first[0] === last[0]
    && first[1] === last[1];
}

function validateModelStep(value, seen) {
  if (!value || typeof value !== "object") throw processingError("processing_model_step_invalid");
  const id = boundedText(value.id, 160, "step");
  const toolId = boundedText(value.toolId, 160, "tool");
  if (seen.has(id)) throw processingError("processing_model_step_duplicate");
  seen.add(id);
  return {id, toolId, parameters: safeRecord(value.parameters)};
}

function modelResult(model, status, steps, output, error, failedStep = null) {
  return {
    schemaVersion: PROCESSING_MODEL_SCHEMA_VERSION,
    model: {id: boundedText(model.id, 160, "model"), name: boundedText(model.name, 200, "model")},
    status,
    steps,
    output: status === "success" ? structuredClone(output) : null,
    ...(error ? {error, failedStepId: failedStep?.id ?? null} : {})
  };
}

function withoutGeojson(output) {
  const copy = structuredClone(output);
  delete copy.geojson;
  return copy;
}

function safeRecord(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw processingError("processing_parameters_invalid");
  }
  return structuredClone(value);
}

function recoverableRecord(value) {
  try {
    return safeRecord(value);
  } catch {
    return {};
  }
}

function optionalBoundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

function optionalBoundedIdentifier(value) {
  const text = optionalBoundedText(value, 160);
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function boundedLayerNameRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = [];
  for (const [key, name] of Object.entries(value).slice(0, 16)) {
    const id = optionalBoundedIdentifier(key);
    const title = optionalBoundedText(name, 200);
    if (id && title) entries.push([id, title]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

function normalizeReceiptExtension(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const logs = Array.isArray(value.logs)
    ? value.logs.map((log) => optionalBoundedText(log, 240)).filter(Boolean).slice(0, 20)
    : [];
  if (
    value.schemaVersion !== PROCESSING_RUN_SCHEMA_VERSION
    || !optionalBoundedText(value.toolVersion, 40)
    || !/^\d+\.\d+\.\d+$/.test(value.toolVersion)
    || typeof value.deterministic !== "boolean"
    || !logs.length
  ) return undefined;
  return {
    schemaVersion: PROCESSING_RUN_SCHEMA_VERSION,
    toolVersion: value.toolVersion,
    deterministic: value.deterministic,
    input: recoverableRecord(value.input),
    output: recoverableRecord(value.output),
    limits: recoverableRecord(value.limits),
    logs
  };
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw processingError(`processing_${label}_invalid`);
  }
  return value.trim();
}

function processingError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}


function geometricCentroidFeatureCollection(geojson, title) {
  const path = geoPath(); // Identity projection: the same planar CRS84 convention as PostGIS geometry.
  const features = [];
  for (const [index, feature] of geojson.features.entries()) {
    const geometry = orientCentroidGeometry(feature.geometry);
    if (!geometry) continue;
    const center = path.centroid(geometry);
    if (!center.every(Number.isFinite)) continue;
    features.push({type: "Feature",
      properties: {source_index: index + 1, source_layer: title},
      geometry: {type: "Point", coordinates: center}});
  }
  return {type: "FeatureCollection", features};
}

function orientCentroidGeometry(geometry) {
  if (!geometry) return null;
  const polygon = (rings) => rings.map((ring, index) => {
    if (ring.length < 4 || !ringIsClosed(ring)) throw processingError("processing_geometry_invalid");
    // Ring position defines shell/hole semantics regardless of input winding.
    const positive = polygonArea(ring) > 0;
    return positive === (index === 0) ? ring : ring.slice().reverse();
  });
  if (geometry.type === "Polygon") return {...geometry, coordinates: polygon(geometry.coordinates)};
  if (geometry.type === "MultiPolygon") {
    return {...geometry, coordinates: geometry.coordinates.map(polygon)};
  }
  if (geometry.type === "GeometryCollection") {
    return {...geometry, geometries: geometry.geometries.map(orientCentroidGeometry)};
  }
  return geometry;
}
