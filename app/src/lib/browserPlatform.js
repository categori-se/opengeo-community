export const BROWSER_PLATFORM_SCHEMA_VERSION = "opengeo.browser-platform.1.0.0";
export const MAP_EXPORT_SCHEMA_VERSION = "opengeo.map-export.1.0.0";

export const BROWSER_PLATFORM_LIMITS = Object.freeze({
  maximumExportWidth: 4096,
  maximumExportHeight: 4096,
  maximumExportPixels: 12_000_000,
  maximumExportBytes: 32 * 1024 * 1024,
  maximumExportLayers: 64,
  maximumExtensionAuditEvents: 100
});

const EXTENSION_POLICIES = Object.freeze({
  catalog: Object.freeze({capabilities: Object.freeze(["catalog:navigate"])}),
  field: Object.freeze({capabilities: Object.freeze(["capture:navigate"])}),
  offline: Object.freeze({capabilities: Object.freeze(["offline-package:navigate"])}),
  time: Object.freeze({capabilities: Object.freeze(["temporal-filter:ui"])}),
  assistant: Object.freeze({capabilities: Object.freeze(["help:navigate"])})
});

export function extensionPolicy(extensionId) {
  const policy = EXTENSION_POLICIES[boundedId(extensionId)];
  if (!policy) throw browserPlatformError("extension_not_registered");
  return policy;
}

export function evaluateExtensionCapability(extensionId, capability) {
  const requestedCapability = boundedCapability(capability);
  let policy;
  try {
    policy = extensionPolicy(extensionId);
  } catch (error) {
    return Object.freeze({
      extensionId: String(extensionId ?? ""),
      capability: requestedCapability,
      allowed: false,
      reason: error.code
    });
  }
  const allowed = policy.capabilities.includes(requestedCapability);
  return Object.freeze({
    extensionId,
    capability: requestedCapability,
    allowed,
    reason: allowed ? "declared_capability" : "capability_not_granted"
  });
}

export function recordExtensionAudit(history, decision, {now = () => new Date()} = {}) {
  const current = Array.isArray(history) ? history : [];
  if (!decision || typeof decision !== "object" || typeof decision.allowed !== "boolean") {
    throw new TypeError("extension decision is invalid");
  }
  const observedAt = now();
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.valueOf())) {
    throw new TypeError("extension audit clock is invalid");
  }
  const next = [...current, {
    schemaVersion: BROWSER_PLATFORM_SCHEMA_VERSION,
    observedAt: observedAt.toISOString(),
    extensionId: String(decision.extensionId),
    capability: String(decision.capability),
    outcome: decision.allowed ? "allowed" : "denied",
    reason: String(decision.reason)
  }];
  return next.slice(-BROWSER_PLATFORM_LIMITS.maximumExtensionAuditEvents);
}

export function browserLoadingSummary({
  loadingDatasetLayerIds,
  liveFeatureRequests,
  layers,
  basemapActivationState
}) {
  const datasetLoads = loadingDatasetLayerIds instanceof Set ? loadingDatasetLayerIds.size : 0;
  const liveLoads = liveFeatureRequests instanceof Map ? liveFeatureRequests.size : 0;
  const basemapLoads = basemapActivationState === "loading" ? 1 : 0;
  const pending = datasetLoads + liveLoads + basemapLoads;
  const layerRecords = Array.isArray(layers) ? layers : [];
  const failed = layerRecords.filter(({liveFeatureState}) => liveFeatureState === "error").length;
  const ready = layerRecords.filter(({liveFeatureState}) => liveFeatureState === "ready").length;
  return Object.freeze({
    schemaVersion: BROWSER_PLATFORM_SCHEMA_VERSION,
    pending,
    ready,
    failed,
    message: pending
      ? `Loading ${pending} map ${pending === 1 ? "source" : "sources"}.`
      : failed
        ? `${failed} live ${failed === 1 ? "source could not load" : "sources could not load"}. Open layer details for the error and retry.`
        : "Map sources ready."
  });
}

export function renderedFeatureHit(map, point, layerIds) {
  if (!map || typeof map.queryRenderedFeatures !== "function" || !point) return false;
  const layers = [...new Set(Array.isArray(layerIds) ? layerIds : [])]
    .filter((layerId) => typeof layerId === "string" && layerId.length > 0)
    .filter((layerId) => typeof map.getLayer !== "function" || map.getLayer(layerId));
  if (!layers.length) return false;
  return map.queryRenderedFeatures(point, {layers}).length > 0;
}

export function accessibleFeaturePopup({title = "Feature", properties = {}} = {}) {
  const section = document.createElement("section");
  section.className = "gis-feature-popup";
  section.role = "dialog";
  section.tabIndex = -1;
  section.setAttribute("aria-label", `${String(title).slice(0, 160)} details`);
  const heading = document.createElement("strong");
  heading.textContent = String(title).slice(0, 160);
  const list = document.createElement("dl");
  list.className = "gis-popup";
  for (const [key, value] of Object.entries(properties ?? {}).slice(0, 10)) {
    const term = document.createElement("dt");
    term.textContent = String(key).slice(0, 160);
    const description = document.createElement("dd");
    description.textContent = String(value ?? "").slice(0, 2_000);
    list.append(term, description);
  }
  section.append(heading, list);
  return section;
}

export function createMapExportManifest({
  workspace,
  project,
  map,
  canvas,
  layers,
  basemap,
  format = "png",
  observedAt = new Date()
}) {
  if (format !== "png" && format !== "jpeg") throw browserPlatformError("map_export_format_unsupported");
  const dimensions = exportCanvasDimensions(canvas);
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.valueOf())) {
    throw new TypeError("map export timestamp is invalid");
  }
  const visibleLayers = (Array.isArray(layers) ? layers : []).filter(({visible}) => visible !== false);
  if (visibleLayers.length > BROWSER_PLATFORM_LIMITS.maximumExportLayers) {
    throw browserPlatformError("map_export_layer_limit_exceeded");
  }
  const center = map?.getCenter?.();
  const camera = {
    center: [Number(center?.lng ?? center?.[0] ?? 0), Number(center?.lat ?? center?.[1] ?? 0)],
    zoom: finiteNumber(map?.getZoom?.(), 0),
    bearing: finiteNumber(map?.getBearing?.(), 0),
    pitch: finiteNumber(map?.getPitch?.(), 0)
  };
  const attributions = [...new Set([
    basemap?.attribution,
    ...visibleLayers.map(({attribution, sourceConfiguration}) => attribution ?? sourceConfiguration?.attribution)
  ].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
  return {
    schemaVersion: MAP_EXPORT_SCHEMA_VERSION,
    observedAt: observedAt.toISOString(),
    workspaceId: identifier(workspace?.workspaceId ?? workspace?.id),
    projectId: identifier(project?.projectId ?? project?.id ?? workspace?.projectId),
    mapId: identifier(project?.mapId ?? project?.id),
    title: String(project?.name ?? project?.title ?? workspace?.title ?? "OpenGeo Studio map").slice(0, 240),
    classification: String(workspace?.classification ?? "unclassified").slice(0, 64),
    image: {
      mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
      ...dimensions,
      ...(format === "jpeg" ? {background: "#ffffff", quality: 0.92} : {})
    },
    camera,
    basemap: basemap ? {
      basemapId: identifier(basemap.basemapId),
      title: String(basemap.title ?? "Basemap").slice(0, 240),
      kind: String(basemap.kind ?? "unknown").slice(0, 80)
    } : null,
    layers: visibleLayers.map((layer) => ({
      layerId: identifier(layer.layerId),
      datasetId: identifier(layer.datasetId),
      title: String(layer.title ?? "Layer").slice(0, 240),
      sourceType: String(layer.sourceType ?? "unknown").slice(0, 80),
      sourceVersion: positiveVersion(layer.sourceVersion ?? layer.featureGeneration),
      opacity: boundedOpacity(layer.opacity)
    })),
    attribution: attributions,
    authorityIncluded: false,
    sourceUrlsIncluded: false
  };
}

export async function canvasPngBlob(canvas) {
  exportCanvasDimensions(canvas);
  const blob = await encodedCanvasBlob(canvas, "image/png");
  if (blob.type !== "image/png" || blob.size < 8) throw browserPlatformError("map_export_invalid_png");
  if (blob.size > BROWSER_PLATFORM_LIMITS.maximumExportBytes) {
    throw browserPlatformError("map_export_size_exceeded");
  }
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (signature.join(",") !== "137,80,78,71,13,10,26,10") {
    throw browserPlatformError("map_export_invalid_png");
  }
  return blob;
}

export async function canvasJpegBlob(canvas) {
  const {width, height} = exportCanvasDimensions(canvas);
  const ownerDocument = canvas?.ownerDocument ?? globalThis.document;
  if (typeof ownerDocument?.createElement !== "function") throw browserPlatformError("map_export_unavailable");
  const opaqueCanvas = ownerDocument.createElement("canvas");
  opaqueCanvas.width = width;
  opaqueCanvas.height = height;
  const context = opaqueCanvas.getContext?.("2d", {alpha: false});
  if (!context) throw browserPlatformError("map_export_unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(canvas, 0, 0);
  const blob = await encodedCanvasBlob(opaqueCanvas, "image/jpeg", 0.92);
  if (blob.type !== "image/jpeg" || blob.size < 4) throw browserPlatformError("map_export_invalid_jpeg");
  if (blob.size > BROWSER_PLATFORM_LIMITS.maximumExportBytes) {
    throw browserPlatformError("map_export_size_exceeded");
  }
  const start = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const end = new Uint8Array(await blob.slice(-2).arrayBuffer());
  if (start.join(",") !== "255,216,255" || end.join(",") !== "255,217") {
    throw browserPlatformError("map_export_invalid_jpeg");
  }
  return blob;
}

async function encodedCanvasBlob(canvas, mediaType, quality) {
  if (typeof canvas?.toBlob !== "function") throw browserPlatformError("map_export_unavailable");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(browserPlatformError("map_export_timeout")), 5_000);
    try {
      canvas.toBlob((value) => {
        clearTimeout(timer);
        if (!value) reject(browserPlatformError("map_export_unavailable"));
        else resolve(value);
      }, mediaType, quality);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function exportCanvasDimensions(canvas) {
  const width = Number(canvas?.width);
  const height = Number(canvas?.height);
  if (!Number.isSafeInteger(width) || width < 1 || width > BROWSER_PLATFORM_LIMITS.maximumExportWidth
    || !Number.isSafeInteger(height) || height < 1 || height > BROWSER_PLATFORM_LIMITS.maximumExportHeight
    || width * height > BROWSER_PLATFORM_LIMITS.maximumExportPixels) {
    throw browserPlatformError("map_export_dimensions_exceeded");
  }
  return {width, height, pixels: width * height};
}

function identifier(value) {
  return typeof value === "string" && value.length <= 160 ? value : null;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function boundedOpacity(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function boundedId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw browserPlatformError("extension_not_registered");
  }
  return value;
}

function boundedCapability(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw browserPlatformError("extension_capability_invalid");
  }
  return value;
}

function browserPlatformError(code) {
  return Object.assign(new Error(code), {code});
}
