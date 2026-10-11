const SOURCE_METHODS = Object.freeze({
  arcgis: Object.freeze({method: "bounded_feature_capture", scope: "feature", available: true}),
  "arcgis-map": Object.freeze({method: "bounded_map_capture", scope: "image", available: false}),
  wfs: Object.freeze({method: "bounded_feature_capture", scope: "feature", available: true}),
  wms: Object.freeze({method: "bounded_map_capture", scope: "image", available: true}),
  xyz: Object.freeze({method: "bounded_tile_capture", scope: "tiles", available: false}),
  pmtiles: Object.freeze({method: "exact_object_copy", scope: "object", available: true}),
  postgis: Object.freeze({method: "query_snapshot", scope: "feature", available: false}),
  "s3-object": Object.freeze({method: "exact_object_copy", scope: "object", available: false})
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CAPTURE_TILES = 4_096;
const MAX_CAPTURE_FEATURES = 50_000;
const MAX_FEATURE_PAGE_SIZE = 2_000;
const MAX_FEATURE_REQUESTS = 64;

export const DATA_CUSTODY_MODES = Object.freeze([
  Object.freeze({
    id: "live_reference",
    title: "Keep the live connection",
    description: "Save the exact connection and source revision. OpenGeo Studio does not copy source bytes."
  }),
  Object.freeze({
    id: "live_and_protected_copy",
    title: "Keep the connection and create a protected copy",
    description: "Keep the source link and, after a bounded preview and rights review, save a new immutable managed version."
  })
]);

export function preservationPrompt(sourceType) {
  const source = sourceMethod(sourceType);
  return {
    sourceType,
    question: "Would you also like OpenGeo Studio to keep a protected copy?",
    choices: DATA_CUSTODY_MODES,
    copyMethod: source.method,
    available: source.available,
    requiresDiscovery: source.scope !== "object",
    requiresBoundedScope: source.scope !== "object",
    requiresRightsConfirmation: true,
    refreshPolicy: "manual_new_version"
  };
}

export function createProtectedCopyEstimateRequest(input) {
  exactKeys(input, [
    "projectId",
    "sourceDatasetId",
    "sourceRevisionNumber",
    "sourceType",
    "scope"
  ], "protected copy estimate request");
  const source = executableSourceMethod(input.sourceType);
  return deepFreeze({
    schemaVersion: "opengeo.protected-copy-estimate-request.1.0.0",
    projectId: uuid(input.projectId, "projectId"),
    source: {
      datasetId: uuid(input.sourceDatasetId, "sourceDatasetId"),
      revisionNumber: positiveInteger(input.sourceRevisionNumber, "sourceRevisionNumber"),
      type: input.sourceType
    },
    scope: captureScope(source.scope, input.scope)
  });
}

export function createProtectedCopyRequest(input) {
  exactKeys(input, [
    "idempotencyKey",
    "projectId",
    "sourceDatasetId",
    "sourceRevisionNumber",
    "sourceType",
    "rights",
    "estimateReceipt"
  ], "protected copy request");
  const source = executableSourceMethod(input.sourceType);
  const projectId = uuid(input.projectId, "projectId");
  const sourceDatasetId = uuid(input.sourceDatasetId, "sourceDatasetId");
  const sourceRevisionNumber = positiveInteger(input.sourceRevisionNumber, "sourceRevisionNumber");
  const rights = rightsReview(input.rights);
  const estimateReceipt = acceptedEstimateReceipt(input.estimateReceipt);

  return deepFreeze({
    schemaVersion: "opengeo.protected-copy-request.2.0.0",
    requestType: "external_source_snapshot",
    idempotencyKey: uuid(input.idempotencyKey, "idempotencyKey"),
    projectId,
    source: {
      datasetId: sourceDatasetId,
      revisionNumber: sourceRevisionNumber,
      type: input.sourceType
    },
    copy: {
      method: source.method,
      rights,
      acceptedEstimate: estimateReceipt,
      refreshPolicy: "manual_new_version"
    },
    destination: {
      recordType: "managed_dataset_version",
      objectRole: "original",
      keyAuthority: "server_generated",
      overwrite: false,
      lineageRequired: true
    },
    execution: {
      state: "ready_for_isolated_executor",
      activation: "on_demand",
      idleBehavior: "scale_to_zero",
      networkPolicy: "dns_pinned_https_source_only"
    }
  });
}

export function createPmtilesDerivativeRequest(input) {
  exactKeys(input, [
    "idempotencyKey",
    "projectId",
    "datasetId",
    "datasetVersionId",
    "bounds",
    "minZoom",
    "maxZoom",
    "sourceLayer"
  ], "PMTiles derivative request");
  const projectId = uuid(input.projectId, "projectId");
  const datasetId = uuid(input.datasetId, "datasetId");
  const datasetVersionId = uuid(input.datasetVersionId, "datasetVersionId");
  const bounds = geographicBounds(input.bounds, "bounds");
  const minZoom = integerBetween(input.minZoom, 0, 22, "minZoom");
  const maxZoom = integerBetween(input.maxZoom, 0, 22, "maxZoom");
  if (minZoom > maxZoom) throw new TypeError("minZoom must not exceed maxZoom");
  const sourceLayer = boundedText(input.sourceLayer, 200, "sourceLayer");

  return deepFreeze({
    schemaVersion: "opengeo.pmtiles-derivative-request.1.0.0",
    requestType: "dataset_vector_to_pmtiles",
    idempotencyKey: uuid(input.idempotencyKey, "idempotencyKey"),
    projectId,
    input: {
      datasetId,
      datasetVersionId
    },
    parameters: {
      bounds,
      minZoom,
      maxZoom,
      sourceLayer
    },
    output: {
      format: "pmtiles",
      contentType: "application/vnd.pmtiles",
      objectRole: "tile",
      keyAuthority: "server_generated",
      archivePath: "versions/{dataset_version_id}/derivatives/tiles/custom/{job_id}.pmtiles",
      overwrite: false,
      retainInputVersion: true,
      lineageRequired: true
    },
    execution: {
      activation: "on_demand",
      idleBehavior: "scale_to_zero",
      networkAccess: "disabled"
    }
  });
}

function captureScope(kind, value) {
  if (kind === "object") {
    exactKeys(value, [], "object copy scope");
    return {kind: "exact_object"};
  }
  if (kind === "image") {
    exactKeys(value, ["bounds", "width", "height"], "image capture scope");
    const width = integerBetween(value.width, 1, 4096, "scope.width");
    const height = integerBetween(value.height, 1, 4096, "scope.height");
    if (width * height > 16_777_216) throw new TypeError("image capture scope exceeds the pixel limit");
    return {
      kind: "bounded_image",
      bounds: geographicBounds(value.bounds, "scope.bounds"),
      width,
      height
    };
  }
  if (kind === "tiles") {
    exactKeys(value, ["bounds", "minZoom", "maxZoom", "maximumTiles"], "tile capture scope");
    const minZoom = integerBetween(value.minZoom, 0, 22, "scope.minZoom");
    const maxZoom = integerBetween(value.maxZoom, 0, 22, "scope.maxZoom");
    if (minZoom > maxZoom) throw new TypeError("scope.minZoom must not exceed scope.maxZoom");
    return {
      kind: "bounded_tiles",
      bounds: geographicBounds(value.bounds, "scope.bounds"),
      minZoom,
      maxZoom,
      maximumTiles: integerBetween(value.maximumTiles, 1, MAX_CAPTURE_TILES, "scope.maximumTiles")
    };
  }
  exactKeys(value, ["bounds", "maximumFeatures", "pageSize"], "feature capture scope");
  const maximumFeatures = integerBetween(
    value.maximumFeatures, 1, MAX_CAPTURE_FEATURES, "scope.maximumFeatures"
  );
  const pageSize = integerBetween(value.pageSize, 1, MAX_FEATURE_PAGE_SIZE, "scope.pageSize");
  if (Math.ceil(maximumFeatures / pageSize) > MAX_FEATURE_REQUESTS) {
    throw new TypeError("feature capture scope exceeds the request limit");
  }
  return {
    kind: "bounded_features",
    bounds: geographicBounds(value.bounds, "scope.bounds"),
    maximumFeatures,
    pageSize
  };
}

function rightsReview(value) {
  exactKeys(value, ["confirmed", "basis", "attribution"], "rights review");
  if (value.confirmed !== true) throw new TypeError("rights.confirmed must be true before copying source data");
  return {
    confirmed: true,
    basis: boundedText(value.basis, 500, "rights.basis"),
    attribution: boundedText(value.attribution, 1000, "rights.attribution")
  };
}

function acceptedEstimateReceipt(value) {
  exactKeys(value, ["id", "checksumSha256", "expiresAt", "accepted"], "copy estimate receipt");
  if (value.accepted !== true) throw new TypeError("the bounded size and cost estimate must be accepted");
  const expiresAt = boundedTimestamp(value.expiresAt, "estimateReceipt.expiresAt");
  return {
    id: uuid(value.id, "estimateReceipt.id"),
    checksumSha256: sha256(value.checksumSha256, "estimateReceipt.checksumSha256"),
    expiresAt,
    accepted: true
  };
}

function sourceMethod(value) {
  const source = SOURCE_METHODS[value];
  if (!source) throw new TypeError("sourceType is not supported for protected copies");
  return source;
}

function executableSourceMethod(value) {
  const source = sourceMethod(value);
  if (!source.available) throw new TypeError("sourceType protected-copy execution is not available yet");
  return source;
}

function geographicBounds(value, label) {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError(`${label} must contain west, south, east, and north`);
  const bounds = value.map((item, index) => finiteNumber(item, -180, 180, `${label}[${index}]`));
  const [west, south, east, north] = bounds;
  if (south < -90 || north > 90 || west >= east || south >= north) throw new TypeError(`${label} must be ordered WGS84 bounds`);
  return bounds;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}

function positiveInteger(value, label) {
  return integerBetween(value, 1, Number.MAX_SAFE_INTEGER, label);
}

function integerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is outside the supported range`);
  return value;
}

function finiteNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label} is outside the supported range`);
  return value;
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.trim();
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedTimestamp(value, label) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort().join("\0");
  if (actual !== [...expected].sort().join("\0")) throw new TypeError(`${label} fields are invalid`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
