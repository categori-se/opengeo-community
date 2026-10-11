export const OPEN_TERRAIN_SOURCE = Object.freeze({
  sourceId: "opengeo-mapterhorn-terrain",
  provider: "Mapterhorn",
  tileUrl: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
  tileJsonUrl: "https://tiles.mapterhorn.com/tilejson.json",
  attribution: "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>",
  attributionUrl: "https://mapterhorn.com/attribution/",
  sourceCatalogUrl: "https://download.mapterhorn.com/attribution.json",
  encoding: "terrarium",
  tileSize: 512,
  maximumZoom: 12,
  bounds: Object.freeze([-180, -85.0511287, 180, 85.0511287]),
  observedAt: "2026-09-09",
  access: "No API key",
  coverage: "Global Web Mercator terrain surface",
  zoom: "0–12",
  termsUrl: "https://mapterhorn.com/attribution/",
  availability: "third-party best-effort service; no OpenGeo.Tools or provider SLA"
});

export const TERRAIN_LIMITS = Object.freeze({
  minimumExaggeration: 0.25,
  maximumExaggeration: 3,
  defaultExaggeration: 1
});

export function normalizeTerrain(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    sourceId: OPEN_TERRAIN_SOURCE.sourceId,
    exaggeration: Number.isFinite(source.exaggeration)
      ? clamp(
          source.exaggeration,
          TERRAIN_LIMITS.minimumExaggeration,
          TERRAIN_LIMITS.maximumExaggeration
        )
      : TERRAIN_LIMITS.defaultExaggeration
  };
}

export function terrainForProject(project) {
  return normalizeTerrain(project?.terrain);
}

export function terrainForSave(enabled, existing) {
  return normalizeTerrain({...existing, enabled: enabled === true});
}

export function terrainSourceSpecification() {
  return {
    type: "raster-dem",
    tiles: [OPEN_TERRAIN_SOURCE.tileUrl],
    encoding: OPEN_TERRAIN_SOURCE.encoding,
    tileSize: OPEN_TERRAIN_SOURCE.tileSize,
    maxzoom: OPEN_TERRAIN_SOURCE.maximumZoom,
    bounds: [...OPEN_TERRAIN_SOURCE.bounds],
    attribution: OPEN_TERRAIN_SOURCE.attribution
  };
}

export function applyOpenTerrain(map, requested, config = {}) {
  const terrain = normalizeTerrain({...config, enabled: requested === true});
  if (!map) return result(terrain.enabled, false, terrain, terrain.enabled);

  try {
    if (!terrain.enabled) {
      map.setTerrain(null);
      return result(false, map.getTerrain() !== null, terrain, map.getTerrain() !== null);
    }
    if (config.activation?.allowed !== true) {
      map.setTerrain(null);
      return result(true, false, terrain, true, config.activation?.status ?? "governance-unavailable");
    }
    if (!map.getSource(OPEN_TERRAIN_SOURCE.sourceId)) {
      map.addSource(OPEN_TERRAIN_SOURCE.sourceId, terrainSourceSpecification());
    } else if (config.activation?.outageState === "half-open") {
      map.refreshTiles?.(OPEN_TERRAIN_SOURCE.sourceId);
    }
    map.setTerrain({
      source: OPEN_TERRAIN_SOURCE.sourceId,
      exaggeration: terrain.exaggeration
    });
    const effective = map.getTerrain()?.source === OPEN_TERRAIN_SOURCE.sourceId;
    return result(true, effective, terrain, !effective, effective ? null : "renderer-rejected");
  } catch {
    try {
      map.setTerrain(null);
    } catch {
      // The caller still receives an explicit disabled fallback result.
    }
    return result(terrain.enabled, false, terrain, terrain.enabled, terrain.enabled ? "renderer-error" : null);
  }
}

function result(requested, effective, terrain, fallback, reason = null) {
  return {
    requested,
    effective,
    fallback,
    sourceId: terrain.sourceId,
    exaggeration: terrain.exaggeration,
    reason
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
