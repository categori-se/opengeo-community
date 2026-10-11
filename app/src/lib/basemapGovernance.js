import {REVIEWED_KEY_FREE_BASEMAPS} from "./reviewedBasemapSources.js";

const LIFECYCLE_STATES = new Set(["active", "retired", "disabled"]);
const HEALTH_STATES = new Set(["healthy", "degraded", "not-probed"]);

export const BASEMAP_HEALTH_LIMITS = Object.freeze({
  timeoutMilliseconds: 10_000,
  maximumResponseBytes: 2 * 1024 * 1024
});

/**
 * Operator-reviewed catalog policy. Automated checks publish observations but
 * never change lifecycle, replacements, or project maps. Historic entries stay
 * here so a saved project can explain a removed choice by its exact old id.
 */
export const BASEMAP_GOVERNANCE_REGISTRY = deepFreeze({
  schemaVersion: "opengeo.basemap-governance.1.0.0",
  revision: 2,
  reviewedAt: "2026-08-28",
  sources: [
    activeStyle("openfreemap-liberty", "https://tiles.openfreemap.org/styles/liberty"),
    activeStyle("openfreemap-liberty-3d", "https://tiles.openfreemap.org/styles/liberty"),
    activeStyle("openfreemap-positron", "https://tiles.openfreemap.org/styles/positron"),
    activeStyle("openfreemap-bright", "https://tiles.openfreemap.org/styles/bright"),
    activeStyle("openfreemap-dark", "https://tiles.openfreemap.org/styles/dark"),
    activeStyle("openfreemap-fiord", "https://tiles.openfreemap.org/styles/fiord"),
    ...REVIEWED_KEY_FREE_BASEMAPS.map(activeRaster),
    {
      basemapId: "blank",
      lifecycle: "active",
      probeKind: "network-free",
      probeUrl: null,
      replacementBasemapId: null,
      lifecycleReason: "Blank canvas has no external availability dependency.",
      observation: {
        status: "not-probed",
        observedAt: "2026-08-27",
        summary: "Network-free choice"
      }
    },
    retiredRaster("carto-voyager", "openfreemap-liberty"),
    retiredRaster("carto-positron", "openfreemap-positron"),
    retiredRaster("carto-dark", "openfreemap-dark")
  ]
});

export function validateBasemapGovernanceRegistry(registry = BASEMAP_GOVERNANCE_REGISTRY) {
  if (!registry || registry.schemaVersion !== "opengeo.basemap-governance.1.0.0") {
    throw new TypeError("basemap governance schema is invalid");
  }
  if (!Number.isInteger(registry.revision) || registry.revision < 1) {
    throw new TypeError("basemap governance revision is invalid");
  }
  if (!validDate(registry.reviewedAt) || !Array.isArray(registry.sources)) {
    throw new TypeError("basemap governance review record is invalid");
  }
  const ids = new Set();
  for (const source of registry.sources) {
    if (!source || typeof source.basemapId !== "string" || !source.basemapId.trim()) {
      throw new TypeError("basemap governance source id is invalid");
    }
    if (ids.has(source.basemapId)) throw new TypeError("basemap governance source ids must be unique");
    ids.add(source.basemapId);
    if (!LIFECYCLE_STATES.has(source.lifecycle)) {
      throw new TypeError(`basemap governance lifecycle is invalid for ${source.basemapId}`);
    }
    if (!source.observation || !HEALTH_STATES.has(source.observation.status)
      || !validDate(source.observation.observedAt)
      || typeof source.observation.summary !== "string"
      || !source.observation.summary.trim()) {
      throw new TypeError(`basemap governance observation is invalid for ${source.basemapId}`);
    }
    if (typeof source.lifecycleReason !== "string" || !source.lifecycleReason.trim()) {
      throw new TypeError(`basemap governance reason is invalid for ${source.basemapId}`);
    }
    if (source.probeKind === "maplibre-style" || source.probeKind === "raster-tile") {
      const parsed = safeUrl(source.probeUrl);
      if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password
        || parsed.search || parsed.hash) {
        throw new TypeError(`basemap governance probe URL is invalid for ${source.basemapId}`);
      }
      if (source.probeKind === "raster-tile"
        && (typeof source.expectedContentType !== "string"
          || !source.expectedContentType.startsWith("image/"))) {
        throw new TypeError(`basemap governance raster content type is invalid for ${source.basemapId}`);
      }
    } else if (source.probeKind !== "network-free" && source.probeKind !== "policy-only") {
      throw new TypeError(`basemap governance probe kind is invalid for ${source.basemapId}`);
    }
    if (!["maplibre-style", "raster-tile"].includes(source.probeKind) && source.probeUrl !== null) {
      throw new TypeError(`basemap governance non-network probe must not have a URL for ${source.basemapId}`);
    }
    if (source.lifecycle !== "active" && !source.replacementBasemapId) {
      throw new TypeError(`basemap governance replacement is required for ${source.basemapId}`);
    }
  }
  for (const source of registry.sources) {
    if (source.replacementBasemapId && !ids.has(source.replacementBasemapId)) {
      throw new TypeError(`basemap governance replacement is unknown for ${source.basemapId}`);
    }
    if (source.replacementBasemapId === source.basemapId) {
      throw new TypeError(`basemap governance replacement cannot reference itself for ${source.basemapId}`);
    }
    if (source.replacementBasemapId
      && registry.sources.find(({basemapId}) => basemapId === source.replacementBasemapId)?.lifecycle !== "active") {
      throw new TypeError(`basemap governance replacement must be active for ${source.basemapId}`);
    }
  }
  return registry;
}

export function basemapGovernanceFor(
  basemapId,
  registry = BASEMAP_GOVERNANCE_REGISTRY
) {
  if (typeof basemapId !== "string") return null;
  return registry.sources.find((source) => source.basemapId === basemapId) ?? null;
}

export function applyBasemapGovernance(
  basemaps,
  registry = BASEMAP_GOVERNANCE_REGISTRY
) {
  return (Array.isArray(basemaps) ? basemaps : []).map((basemap) => {
    const governance = basemapGovernanceFor(basemap?.basemapId, registry);
    return governance ? {...basemap, governance} : basemap;
  });
}

export function basemapCatalogAvailability(basemap) {
  const lifecycle = basemap?.governance?.lifecycle;
  if (lifecycle === "retired") return "retired";
  if (lifecycle === "disabled") return "operator-disabled";
  return "available";
}

export function basemapNetworkAllowed(basemap) {
  return basemap?.governance?.lifecycle !== "disabled";
}

export function basemapGovernanceLabel(governance) {
  if (!governance) return null;
  if (governance.lifecycle === "retired") return "Retired";
  if (governance.lifecycle === "disabled") return "Operator disabled";
  if (governance.observation.status === "degraded") return "Degraded";
  if (governance.observation.status === "healthy") return "Healthy";
  return "Network-free";
}

export function basemapGovernanceMessage(basemap, {savedProject = false} = {}) {
  const governance = basemap?.governance;
  if (!governance) return null;
  const title = basemap.title ?? basemap.basemapId;
  const observed = `Last catalog observation: ${governance.observation.observedAt}.`;
  if (governance.lifecycle === "retired") {
    return `${title} was retired from new-project choices. ${governance.lifecycleReason} ${savedProject ? "This project keeps its exact saved source until you explicitly choose a replacement." : ""} ${observed}`.replaceAll(/\s+/g, " ").trim();
  }
  if (governance.lifecycle === "disabled") {
    return `${title} is disabled by an operator. ${governance.lifecycleReason} ${savedProject ? "OpenGeo Studio preserved the saved selection but did not request its network resources." : ""} ${observed}`.replaceAll(/\s+/g, " ").trim();
  }
  if (governance.observation.status === "degraded") {
    return `${title} has a degraded catalog observation. ${governance.observation.summary} Browser-session activation still checks the candidate before switching. ${observed}`;
  }
  return `${basemapGovernanceLabel(governance)} · observed ${governance.observation.observedAt}`;
}

export function basemapReplacement(
  basemap,
  basemaps,
  registry = BASEMAP_GOVERNANCE_REGISTRY
) {
  const governance = basemap?.governance ?? basemapGovernanceFor(basemap?.basemapId, registry);
  if (!governance?.replacementBasemapId) return null;
  return (Array.isArray(basemaps) ? basemaps : [])
    .find(({basemapId}) => basemapId === governance.replacementBasemapId) ?? null;
}

export async function observeBasemapRegistry({
  registry = BASEMAP_GOVERNANCE_REGISTRY,
  fetchImpl = globalThis.fetch,
  observedAt = new Date().toISOString()
} = {}) {
  validateBasemapGovernanceRegistry(registry);
  if (typeof fetchImpl !== "function") throw new TypeError("basemap health fetch implementation is required");
  const byProbe = new Map();
  const observations = [];
  for (const source of registry.sources) {
    if (source.lifecycle !== "active" || !["maplibre-style", "raster-tile"].includes(source.probeKind)) {
      observations.push(Object.freeze({
        basemapId: source.basemapId,
        lifecycle: source.lifecycle,
        status: "not-probed",
        reason: source.lifecycle === "active" ? "network_free" : `policy_${source.lifecycle}`,
        observedAt
      }));
      continue;
    }
    let result = byProbe.get(source.probeUrl);
    if (!result) {
      result = source.probeKind === "raster-tile"
        ? probeRasterTile(source, fetchImpl, observedAt)
        : probeMapLibreStyle(source.probeUrl, fetchImpl, observedAt);
      byProbe.set(source.probeUrl, result);
    }
    observations.push(Object.freeze({
      basemapId: source.basemapId,
      lifecycle: source.lifecycle,
      ...await result
    }));
  }
  const counts = observations.reduce((summary, observation) => {
    summary[observation.status] = (summary[observation.status] ?? 0) + 1;
    return summary;
  }, {});
  return deepFreeze({
    schemaVersion: "opengeo.basemap-health-report.1.0.0",
    registryRevision: registry.revision,
    generatedAt: observedAt,
    counts,
    observations
  });
}

async function probeMapLibreStyle(url, fetchImpl, observedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BASEMAP_HEALTH_LIMITS.timeoutMilliseconds);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {accept: "application/json"},
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal
    });
    if (response.status < 200 || response.status >= 300) {
      return degraded(observedAt, `http_${response.status}`, {httpStatus: response.status});
    }
    const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!contentType.includes("json")) {
      return degraded(observedAt, "unexpected_content_type", {httpStatus: response.status, contentType});
    }
    const bytes = await readBoundedBytes(response);
    const text = new TextDecoder().decode(bytes);
    let style;
    try {
      style = JSON.parse(text);
    } catch {
      return degraded(observedAt, "invalid_json", {httpStatus: response.status, contentType});
    }
    if (style?.version !== 8 || !style.sources || typeof style.sources !== "object" || !Array.isArray(style.layers)) {
      return degraded(observedAt, "invalid_maplibre_style", {httpStatus: response.status, contentType});
    }
    return {
      status: "healthy",
      reason: "valid_maplibre_style",
      observedAt,
      httpStatus: response.status,
      contentType,
      responseBytes: bytes.byteLength
    };
  } catch (error) {
    return degraded(
      observedAt,
      error?.name === "AbortError" ? "timeout" : error?.code === "response_too_large" ? "response_too_large" : "network_error"
    );
  } finally {
    clearTimeout(timer);
  }
}

async function probeRasterTile(source, fetchImpl, observedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BASEMAP_HEALTH_LIMITS.timeoutMilliseconds);
  try {
    const response = await fetchImpl(source.probeUrl, {
      method: "GET",
      headers: {accept: source.expectedContentType},
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal
    });
    if (response.status < 200 || response.status >= 300) {
      return degraded(observedAt, `http_${response.status}`, {httpStatus: response.status});
    }
    const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== source.expectedContentType) {
      return degraded(observedAt, "unexpected_content_type", {httpStatus: response.status, contentType});
    }
    const bytes = await readBoundedBytes(response);
    if (bytes.byteLength < 128) {
      return degraded(observedAt, "empty_or_tiny_image", {
        httpStatus: response.status,
        contentType,
        responseBytes: bytes.byteLength
      });
    }
    return {
      status: "healthy",
      reason: "valid_raster_tile",
      observedAt,
      httpStatus: response.status,
      contentType,
      responseBytes: bytes.byteLength
    };
  } catch (error) {
    return degraded(
      observedAt,
      error?.name === "AbortError" ? "timeout" : error?.code === "response_too_large" ? "response_too_large" : "network_error"
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBytes(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > BASEMAP_HEALTH_LIMITS.maximumResponseBytes) {
    throw healthError("response_too_large");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > BASEMAP_HEALTH_LIMITS.maximumResponseBytes) {
      throw healthError("response_too_large");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > BASEMAP_HEALTH_LIMITS.maximumResponseBytes) {
      await reader.cancel();
      throw healthError("response_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function activeStyle(basemapId, probeUrl) {
  return {
    basemapId,
    lifecycle: "active",
    probeKind: "maplibre-style",
    probeUrl,
    replacementBasemapId: null,
    lifecycleReason: "Key-free OpenFreeMap catalog source retained after source and terms review.",
    observation: {
      status: "healthy",
      observedAt: "2026-08-27",
      summary: "HTTP 200 MapLibre style JSON"
    }
  };
}

function activeRaster(basemap) {
  return {
    basemapId: basemap.basemapId,
    lifecycle: "active",
    probeKind: "raster-tile",
    probeUrl: basemap.sourceReview.probeUrl,
    expectedContentType: basemap.sourceReview.expectedContentType,
    replacementBasemapId: null,
    lifecycleReason: "Key-free raster retained after endpoint, access, terms, attribution, coverage, zoom, and sample-tile review.",
    observation: {
      status: "healthy",
      observedAt: basemap.sourceReview.reviewedAt,
      summary: "Direct HTTPS sample tile returned the declared image type"
    }
  };
}

function retiredRaster(basemapId, replacementBasemapId) {
  return {
    basemapId,
    lifecycle: "retired",
    probeKind: "policy-only",
    probeUrl: null,
    replacementBasemapId,
    lifecycleReason: "The former anonymous CARTO entry was removed when the catalog adopted key-required provider connections.",
    observation: {
      status: "not-probed",
      observedAt: "2026-08-27",
      summary: "Retired by reviewed catalog policy"
    }
  };
}

function degraded(observedAt, reason, details = {}) {
  return {status: "degraded", reason, observedAt, ...details};
}

function healthError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validDate(value) {
  return typeof value === "string" && value.length >= 10 && Number.isFinite(Date.parse(value));
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

validateBasemapGovernanceRegistry();
