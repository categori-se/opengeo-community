export const GLOBE_TELEMETRY_LIMITS = Object.freeze({
  maximumFrameSamples: 240,
  minimumAcceptanceFrameSamples: 10,
  maximumAcceptedFrameP95Ms: 250,
  maximumAcceptedMapLoadMs: 10_000,
  maximumAcceptedTerrainReadyMs: 10_000,
  maximumAcceptedHeapMiB: 512
});

export function createGlobeTelemetry({now = defaultNow} = {}) {
  return {
    now,
    startedAt: now(),
    lastFrameAt: null,
    frameIntervals: [],
    mapLoadMs: null,
    terrainStartedAt: null,
    terrainReadyMs: null,
    camera: null
  };
}

export function recordGlobeFrame(telemetry) {
  const current = telemetry.now();
  if (Number.isFinite(telemetry.lastFrameAt)) {
    const interval = current - telemetry.lastFrameAt;
    if (interval >= 0.5 && interval <= 1_000) {
      telemetry.frameIntervals.push(interval);
      if (telemetry.frameIntervals.length > GLOBE_TELEMETRY_LIMITS.maximumFrameSamples) {
        telemetry.frameIntervals.shift();
      }
    }
  }
  telemetry.lastFrameAt = current;
}

export function recordGlobeLoad(telemetry) {
  telemetry.mapLoadMs = boundedDuration(telemetry.now() - telemetry.startedAt);
}

export function beginTerrainTiming(telemetry) {
  telemetry.terrainStartedAt = telemetry.now();
  telemetry.terrainReadyMs = null;
}

export function completeTerrainTiming(telemetry) {
  if (!Number.isFinite(telemetry.terrainStartedAt)) return;
  telemetry.terrainReadyMs = boundedDuration(telemetry.now() - telemetry.terrainStartedAt);
  telemetry.terrainStartedAt = null;
}

export function cancelTerrainTiming(telemetry) {
  telemetry.terrainStartedAt = null;
  telemetry.terrainReadyMs = null;
}

export function recordGlobeCamera(telemetry, map) {
  if (!map) return;
  try {
    const center = map.getCenter();
    const values = [center.lng, center.lat, map.getZoom(), map.getPitch(), map.getBearing()];
    if (!values.every(Number.isFinite)) return;
    telemetry.camera = {
      longitude: center.lng,
      latitude: center.lat,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing()
    };
  } catch {
    // Invalid renderer state is omitted rather than exposed as telemetry.
  }
}

export function globeTelemetrySnapshot(telemetry, {usedHeapBytes} = {}) {
  const frames = [...telemetry.frameIntervals].sort((left, right) => left - right);
  const frameP95Ms = percentile(frames, 0.95);
  const frameP50Ms = percentile(frames, 0.5);
  const heapMiB = Number.isFinite(usedHeapBytes) && usedHeapBytes >= 0
    ? round(usedHeapBytes / 1_048_576)
    : null;
  const enoughFrames = frames.length >= GLOBE_TELEMETRY_LIMITS.minimumAcceptanceFrameSamples;
  return {
    frameSamples: frames.length,
    frameP50Ms,
    frameP95Ms,
    frameMaximumMs: frames.length ? round(frames.at(-1)) : null,
    mapLoadMs: telemetry.mapLoadMs,
    terrainReadyMs: telemetry.terrainReadyMs,
    heapMiB,
    camera: telemetry.camera && {...telemetry.camera},
    acceptance: {
      enoughFrames,
      frameP95: enoughFrames
        ? frameP95Ms <= GLOBE_TELEMETRY_LIMITS.maximumAcceptedFrameP95Ms
        : null,
      mapLoad: Number.isFinite(telemetry.mapLoadMs)
        ? telemetry.mapLoadMs <= GLOBE_TELEMETRY_LIMITS.maximumAcceptedMapLoadMs
        : null,
      terrainReady: Number.isFinite(telemetry.terrainReadyMs)
        ? telemetry.terrainReadyMs <= GLOBE_TELEMETRY_LIMITS.maximumAcceptedTerrainReadyMs
        : null,
      heap: heapMiB === null ? null : heapMiB <= GLOBE_TELEMETRY_LIMITS.maximumAcceptedHeapMiB
    }
  };
}

function percentile(sorted, quantile) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index]);
}

function boundedDuration(value) {
  return Number.isFinite(value) && value >= 0 ? round(Math.min(value, 60_000)) : null;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
