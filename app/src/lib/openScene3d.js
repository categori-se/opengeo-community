import {terrainDeploymentClass} from "./terrainGovernance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const OPEN_3D_SCENE_SOURCE = deepFreeze({
  sourceId: "opengeo-openfreemap-3d",
  provider: "OpenFreeMap",
  tileJsonUrl: "https://tiles.openfreemap.org/planet",
  tileUrl: "https://tiles.openfreemap.org/planet/20260906_080001_pt/{z}/{x}/{y}.pbf",
  snapshotVersion: "20260906_080001_pt",
  observedAt: "2026-09-09T11:11:07.527Z",
  attribution: "<a href='https://openfreemap.org'>OpenFreeMap</a> <a href='https://www.openmaptiles.org/'>© OpenMapTiles</a> Data from <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>",
  attributionLinks: Object.freeze([
    Object.freeze({label: "OpenFreeMap", url: "https://openfreemap.org/"}),
    Object.freeze({label: "© OpenMapTiles", url: "https://www.openmaptiles.org/"}),
    Object.freeze({label: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright"})
  ]),
  bounds: Object.freeze([-180, -85.05113, 180, 85.05113]),
  minimumZoom: 0,
  maximumZoom: 14,
  buildingSourceLayer: "building",
  vegetationSourceLayer: "landcover",
  availability: "third-party community service; no OpenGeo.Tools or provider SLA"
});

export const OPEN_3D_SCENE_RECEIPT = Object.freeze({
  schemaVersion: "1.0.0",
  sourceId: OPEN_3D_SCENE_SOURCE.sourceId,
  observedAt: OPEN_3D_SCENE_SOURCE.observedAt,
  tileJsonSha256: "3030217a570803f2ff73b73b1c59948007e31a99bb406841fd71679be8e83b92",
  representativeTileSha256: "893deee5a99803af2fb5b8d01f7dfbadb440bc7332b81424c665b25f0fe1becd"
});

export const OPEN_3D_SCENE_LIMITS = Object.freeze({
  maximumReceiptAgeMs: 7 * DAY_MS,
  maximumFutureClockSkewMs: DAY_MS,
  minimumDetailZoom: 13,
  maximumBuildingHeightMeters: 500,
  defaultBuildingHeightMeters: 9,
  woodlandCanopyHeightMeters: 8
});

export const OPEN_3D_SCENE_LAYERS = Object.freeze({
  buildings: "opengeo-open-buildings-3d",
  woodlandCanopy: "opengeo-open-woodland-canopy-3d"
});

export function normalizeOpenScene3d(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    sourceId: OPEN_3D_SCENE_SOURCE.sourceId,
    snapshotVersion: OPEN_3D_SCENE_SOURCE.snapshotVersion
  };
}

export function openScene3dForProject(project) {
  return normalizeOpenScene3d(project?.openScene3d);
}

export function openScene3dForSave(enabled) {
  return normalizeOpenScene3d({enabled: enabled === true});
}

export function evaluateOpenScene3dGovernance({
  now = Date.now(),
  deploymentClass = terrainDeploymentClass(),
  receipt = OPEN_3D_SCENE_RECEIPT
} = {}) {
  if (!validReceipt(receipt)) return decision(false, "receipt-invalid", deploymentClass, null);
  const ageMs = now - Date.parse(receipt.observedAt);
  if (!Number.isFinite(now) || ageMs < -OPEN_3D_SCENE_LIMITS.maximumFutureClockSkewMs) {
    return decision(false, "clock-invalid", deploymentClass, ageMs);
  }
  // Source preservation is separate from direct, best-effort interactive viewing.
  if (ageMs > OPEN_3D_SCENE_LIMITS.maximumReceiptAgeMs) {
    return decision(true, "source-review-due", deploymentClass, ageMs);
  }
  return decision(true, "fresh-upstream", deploymentClass, ageMs);
}

export function openScene3dSourceSpecification() {
  return {
    type: "vector",
    tiles: [OPEN_3D_SCENE_SOURCE.tileUrl],
    minzoom: OPEN_3D_SCENE_SOURCE.minimumZoom,
    maxzoom: OPEN_3D_SCENE_SOURCE.maximumZoom,
    bounds: [...OPEN_3D_SCENE_SOURCE.bounds],
    attribution: OPEN_3D_SCENE_SOURCE.attribution
  };
}

export function openScene3dLayerSpecifications() {
  return [
    {
      id: OPEN_3D_SCENE_LAYERS.woodlandCanopy,
      type: "fill-extrusion",
      source: OPEN_3D_SCENE_SOURCE.sourceId,
      "source-layer": OPEN_3D_SCENE_SOURCE.vegetationSourceLayer,
      minzoom: OPEN_3D_SCENE_LIMITS.minimumDetailZoom,
      filter: ["==", ["get", "class"], "wood"],
      paint: {
        "fill-extrusion-color": "#2f6b4f",
        "fill-extrusion-height": OPEN_3D_SCENE_LIMITS.woodlandCanopyHeightMeters,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.58,
        "fill-extrusion-vertical-gradient": true
      }
    },
    {
      id: OPEN_3D_SCENE_LAYERS.buildings,
      type: "fill-extrusion",
      source: OPEN_3D_SCENE_SOURCE.sourceId,
      "source-layer": OPEN_3D_SCENE_SOURCE.buildingSourceLayer,
      minzoom: OPEN_3D_SCENE_LIMITS.minimumDetailZoom,
      filter: ["!", ["boolean", ["get", "hide_3d"], false]],
      paint: {
        "fill-extrusion-color": "#b9c2cc",
        "fill-extrusion-height": [
          "min",
          OPEN_3D_SCENE_LIMITS.maximumBuildingHeightMeters,
          ["max", 0, ["to-number", ["get", "render_height"], OPEN_3D_SCENE_LIMITS.defaultBuildingHeightMeters]]
        ],
        "fill-extrusion-base": [
          "min",
          ["to-number", ["get", "render_height"], OPEN_3D_SCENE_LIMITS.defaultBuildingHeightMeters],
          ["max", 0, ["to-number", ["get", "render_min_height"], 0]]
        ],
        "fill-extrusion-opacity": 0.82,
        "fill-extrusion-vertical-gradient": true
      }
    }
  ];
}

export function applyOpenScene3d(map, requested, {globe = false, activation} = {}) {
  const normalized = normalizeOpenScene3d({enabled: requested === true});
  if (!map) return sceneResult(normalized.enabled, false, normalized, normalized.enabled, "renderer-unavailable");
  if (!normalized.enabled) {
    cleanup(map);
    return sceneResult(false, false, normalized, false, null);
  }
  if (!globe) {
    cleanup(map);
    return sceneResult(true, false, normalized, true, "globe-required");
  }
  if (activation?.allowed !== true) {
    cleanup(map);
    return sceneResult(true, false, normalized, true, activation?.status ?? "governance-unavailable");
  }
  try {
    if (!map.getSource(OPEN_3D_SCENE_SOURCE.sourceId)) {
      map.addSource(OPEN_3D_SCENE_SOURCE.sourceId, openScene3dSourceSpecification());
    }
    for (const layer of openScene3dLayerSpecifications()) {
      if (!map.getLayer(layer.id)) map.addLayer(layer);
    }
    const effective = Object.values(OPEN_3D_SCENE_LAYERS).every((id) => Boolean(map.getLayer(id)));
    if (!effective) cleanup(map);
    return sceneResult(true, effective, normalized, !effective, effective ? null : "renderer-rejected");
  } catch {
    cleanup(map);
    return sceneResult(true, false, normalized, true, "renderer-error");
  }
}

function cleanup(map) {
  try {
    for (const id of Object.values(OPEN_3D_SCENE_LAYERS).reverse()) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(OPEN_3D_SCENE_SOURCE.sourceId)) map.removeSource(OPEN_3D_SCENE_SOURCE.sourceId);
  } catch {
    // The caller still receives an explicit disabled fallback result.
  }
}

function validReceipt(receipt) {
  return receipt?.schemaVersion === OPEN_3D_SCENE_RECEIPT.schemaVersion
    && receipt?.sourceId === OPEN_3D_SCENE_RECEIPT.sourceId
    && receipt?.observedAt === OPEN_3D_SCENE_RECEIPT.observedAt
    && receipt?.tileJsonSha256 === OPEN_3D_SCENE_RECEIPT.tileJsonSha256
    && receipt?.representativeTileSha256 === OPEN_3D_SCENE_RECEIPT.representativeTileSha256;
}

function decision(allowed, status, deploymentClass, ageMs) {
  return {allowed, status, deploymentClass, ageMs: Number.isFinite(ageMs) ? ageMs : null};
}

function sceneResult(requested, effective, scene, fallback, reason) {
  return {
    requested,
    effective,
    fallback,
    reason,
    sourceId: scene.sourceId,
    snapshotVersion: scene.snapshotVersion,
    buildings: effective,
    woodlandCanopy: effective,
    individualTrees: false
  };
}

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return Object.freeze(value);
}
