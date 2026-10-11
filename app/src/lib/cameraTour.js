import {captureMapView, normalizeMapView, normalizeProjection} from "./globeView.js";

export const CAMERA_TOUR_SCHEMA_VERSION = "opengeo.camera-tour.1.0.0";

export const CAMERA_TOUR_LIMITS = Object.freeze({
  maximumKeyframes: 64,
  maximumSerializedBytes: 256 * 1024,
  maximumTitleCharacters: 240,
  maximumKeyframeTitleCharacters: 160,
  maximumTransitionMilliseconds: 60_000,
  maximumHoldMilliseconds: 60_000,
  maximumDurationMilliseconds: 15 * 60_000,
  minimumPlaybackIntervalMilliseconds: 33
});

const EASINGS = new Set(["linear", "smooth"]);

export function createCameraTour({
  title = "Untitled camera tour",
  camera,
  projection = "mercator",
  spatialBodyId = "earth"
} = {}) {
  return normalizeCameraTour({
    schemaVersion: CAMERA_TOUR_SCHEMA_VERSION,
    id: "primary-camera-tour",
    title,
    projection,
    spatialBodyId,
    bindings: {
      mapVersion: null,
      layerVersions: [],
      imageryRevision: null,
      narrationObjectId: null
    },
    keyframes: [{
      id: "view-1",
      title: "Starting view",
      camera,
      transitionMilliseconds: 0,
      holdMilliseconds: 1_000,
      easing: "smooth"
    }]
  });
}

export function normalizeCameraTour(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw tourError("camera_tour_invalid");
  if (value.schemaVersion !== CAMERA_TOUR_SCHEMA_VERSION) throw tourError("camera_tour_version_unsupported");
  if (!Array.isArray(value.keyframes) || !value.keyframes.length) throw tourError("camera_tour_keyframes_required");
  if (value.keyframes.length > CAMERA_TOUR_LIMITS.maximumKeyframes) throw tourError("camera_tour_keyframe_limit");
  const ids = new Set();
  const keyframes = value.keyframes.map((keyframe, index) => normalizeKeyframe(keyframe, index, ids));
  const normalized = {
    schemaVersion: CAMERA_TOUR_SCHEMA_VERSION,
    id: identifier(value.id, "camera_tour_id_invalid"),
    title: boundedText(value.title, CAMERA_TOUR_LIMITS.maximumTitleCharacters, "camera_tour_title_invalid"),
    projection: normalizeProjection(value.projection),
    spatialBodyId: identifier(value.spatialBodyId, "camera_tour_spatial_body_invalid"),
    bindings: normalizeBindings(value.bindings),
    keyframes
  };
  if (cameraTourDurationMilliseconds(normalized) > CAMERA_TOUR_LIMITS.maximumDurationMilliseconds) {
    throw tourError("camera_tour_duration_limit");
  }
  if (utf8Length(JSON.stringify(normalized)) > CAMERA_TOUR_LIMITS.maximumSerializedBytes) {
    throw tourError("camera_tour_serialized_limit");
  }
  return normalized;
}

export function cameraTourForProject(project) {
  try {
    const value = project?.extensions?.cameraTour;
    return value ? normalizeCameraTour(value) : null;
  } catch {
    return null;
  }
}

export function cameraTourForSave(value) {
  return value ? normalizeCameraTour(value) : null;
}

export function captureCameraTourView(map, fallback) {
  const view = captureMapView(map, fallback);
  return normalizeTourCamera(view);
}

export function addCameraTourKeyframe(tour, camera, {
  title,
  transitionMilliseconds = 3_000,
  holdMilliseconds = 1_000,
  easing = "smooth"
} = {}) {
  const normalized = normalizeCameraTour(tour);
  if (normalized.keyframes.length >= CAMERA_TOUR_LIMITS.maximumKeyframes) {
    throw tourError("camera_tour_keyframe_limit");
  }
  const used = new Set(normalized.keyframes.map(({id}) => id));
  let number = normalized.keyframes.length + 1;
  while (used.has(`view-${number}`)) number += 1;
  return normalizeCameraTour({
    ...normalized,
    keyframes: [...normalized.keyframes, {
      id: `view-${number}`,
      title: title ?? `View ${number}`,
      camera,
      transitionMilliseconds,
      holdMilliseconds,
      easing
    }]
  });
}

export function updateCameraTourKeyframe(tour, keyframeId, patch = {}) {
  const normalized = normalizeCameraTour(tour);
  const index = normalized.keyframes.findIndex(({id}) => id === keyframeId);
  if (index < 0) throw tourError("camera_tour_keyframe_not_found");
  const keyframes = structuredClone(normalized.keyframes);
  const allowed = ["title", "camera", "transitionMilliseconds", "holdMilliseconds", "easing"];
  for (const key of allowed) if (Object.hasOwn(patch, key)) keyframes[index][key] = structuredClone(patch[key]);
  return normalizeCameraTour({...normalized, keyframes});
}

export function moveCameraTourKeyframe(tour, keyframeId, direction) {
  const normalized = normalizeCameraTour(tour);
  const index = normalized.keyframes.findIndex(({id}) => id === keyframeId);
  if (index < 0) throw tourError("camera_tour_keyframe_not_found");
  const target = index + (direction < 0 ? -1 : 1);
  if (target < 0 || target >= normalized.keyframes.length) return normalized;
  const keyframes = structuredClone(normalized.keyframes);
  [keyframes[index], keyframes[target]] = [keyframes[target], keyframes[index]];
  keyframes[0].transitionMilliseconds = 0;
  for (const keyframe of keyframes.slice(1)) {
    if (keyframe.transitionMilliseconds === 0) keyframe.transitionMilliseconds = 3_000;
  }
  return normalizeCameraTour({...normalized, keyframes});
}

export function removeCameraTourKeyframe(tour, keyframeId) {
  const normalized = normalizeCameraTour(tour);
  if (normalized.keyframes.length === 1) throw tourError("camera_tour_last_keyframe_required");
  const index = normalized.keyframes.findIndex(({id}) => id === keyframeId);
  if (index < 0) throw tourError("camera_tour_keyframe_not_found");
  const keyframes = normalized.keyframes.filter(({id}) => id !== keyframeId);
  keyframes[0].transitionMilliseconds = 0;
  return normalizeCameraTour({...normalized, keyframes});
}

export function cameraTourDurationMilliseconds(value) {
  const keyframes = Array.isArray(value?.keyframes) ? value.keyframes : [];
  return keyframes.reduce((total, keyframe, index) => (
    total
      + (index ? boundedDuration(keyframe?.transitionMilliseconds, CAMERA_TOUR_LIMITS.maximumTransitionMilliseconds, "camera_tour_transition_invalid") : 0)
      + boundedDuration(keyframe?.holdMilliseconds, CAMERA_TOUR_LIMITS.maximumHoldMilliseconds, "camera_tour_hold_invalid")
  ), 0);
}

export function cameraTourFrameAt(value, requestedElapsedMilliseconds) {
  const tour = normalizeCameraTour(value);
  const durationMilliseconds = cameraTourDurationMilliseconds(tour);
  const elapsedMilliseconds = Math.max(0, Math.min(
    durationMilliseconds,
    Number.isFinite(requestedElapsedMilliseconds) ? requestedElapsedMilliseconds : 0
  ));
  let cursor = 0;
  for (let index = 0; index < tour.keyframes.length; index += 1) {
    const current = tour.keyframes[index];
    if (index > 0) {
      const previous = tour.keyframes[index - 1];
      const transitionEnd = cursor + current.transitionMilliseconds;
      if (elapsedMilliseconds < transitionEnd) {
        const rawProgress = current.transitionMilliseconds
          ? (elapsedMilliseconds - cursor) / current.transitionMilliseconds
          : 1;
        const progress = current.easing === "smooth" ? smoothstep(rawProgress) : rawProgress;
        return {
          camera: interpolateCamera(previous.camera, current.camera, progress),
          elapsedMilliseconds,
          durationMilliseconds,
          keyframeIndex: index,
          phase: "transition",
          progress,
          done: false
        };
      }
      cursor = transitionEnd;
    }
    const holdEnd = cursor + current.holdMilliseconds;
    if (elapsedMilliseconds < holdEnd || (elapsedMilliseconds === durationMilliseconds && index === tour.keyframes.length - 1)) {
      return {
        camera: structuredClone(current.camera),
        elapsedMilliseconds,
        durationMilliseconds,
        keyframeIndex: index,
        phase: elapsedMilliseconds === durationMilliseconds ? "finished" : "hold",
        progress: current.holdMilliseconds ? Math.min(1, (elapsedMilliseconds - cursor) / current.holdMilliseconds) : 1,
        done: elapsedMilliseconds === durationMilliseconds
      };
    }
    cursor = holdEnd;
  }
  const keyframeIndex = tour.keyframes.length - 1;
  return {
    camera: structuredClone(tour.keyframes[keyframeIndex].camera),
    elapsedMilliseconds: durationMilliseconds,
    durationMilliseconds,
    keyframeIndex,
    phase: "finished",
    progress: 1,
    done: true
  };
}

export function exportCameraTour(value) {
  return `${JSON.stringify(normalizeCameraTour(value), null, 2)}\n`;
}

export function parseCameraTour(text) {
  if (typeof text !== "string") throw tourError("camera_tour_text_required");
  if (utf8Length(text) > CAMERA_TOUR_LIMITS.maximumSerializedBytes) throw tourError("camera_tour_serialized_limit");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw tourError("camera_tour_json_invalid");
  }
  return normalizeCameraTour(value);
}

function normalizeKeyframe(value, index, ids) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw tourError("camera_tour_keyframe_invalid");
  const id = identifier(value.id, "camera_tour_keyframe_id_invalid");
  if (ids.has(id)) throw tourError("camera_tour_keyframe_id_duplicate");
  ids.add(id);
  const transitionMilliseconds = index === 0
    ? 0
    : boundedDuration(value.transitionMilliseconds, CAMERA_TOUR_LIMITS.maximumTransitionMilliseconds, "camera_tour_transition_invalid");
  return {
    id,
    title: boundedText(value.title, CAMERA_TOUR_LIMITS.maximumKeyframeTitleCharacters, "camera_tour_keyframe_title_invalid"),
    camera: normalizeTourCamera(value.camera),
    transitionMilliseconds,
    holdMilliseconds: boundedDuration(value.holdMilliseconds, CAMERA_TOUR_LIMITS.maximumHoldMilliseconds, "camera_tour_hold_invalid"),
    easing: EASINGS.has(value.easing) ? value.easing : "smooth"
  };
}

function normalizeTourCamera(value) {
  if (!Array.isArray(value?.center)
    || value.center.length !== 2
    || !value.center.every(Number.isFinite)
    || value.center[0] < -180
    || value.center[0] > 180
    || value.center[1] < -85.051129
    || value.center[1] > 85.051129
    || !Number.isFinite(value?.zoom)
    || value.zoom < 0
    || value.zoom > 22
    || !Number.isFinite(value?.pitch)
    || value.pitch < 0
    || value.pitch > 85
    || !Number.isFinite(value?.bearing)) {
    throw tourError("camera_tour_camera_invalid");
  }
  const view = normalizeMapView({
    id: "tour-camera",
    title: "Tour camera",
    center: value?.center,
    zoom: value?.zoom,
    pitch: value?.pitch,
    bearing: value?.bearing
  });
  return {center: view.center, zoom: view.zoom, pitch: view.pitch, bearing: view.bearing};
}

function normalizeBindings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const layerVersions = Array.isArray(source.layerVersions) ? source.layerVersions : [];
  if (layerVersions.length > 64) throw tourError("camera_tour_binding_limit");
  return {
    mapVersion: optionalIdentifier(source.mapVersion),
    layerVersions: layerVersions.map((entry) => ({
      layerId: identifier(entry?.layerId, "camera_tour_binding_invalid"),
      sourceVersion: identifier(entry?.sourceVersion, "camera_tour_binding_invalid")
    })),
    imageryRevision: optionalIdentifier(source.imageryRevision),
    narrationObjectId: optionalIdentifier(source.narrationObjectId)
  };
}

function interpolateCamera(start, end, progress) {
  return {
    center: [
      normalizeLongitude(start.center[0] + shortestAngle(start.center[0], end.center[0]) * progress),
      round(start.center[1] + (end.center[1] - start.center[1]) * progress)
    ],
    zoom: round(start.zoom + (end.zoom - start.zoom) * progress),
    pitch: round(start.pitch + (end.pitch - start.pitch) * progress),
    bearing: normalizeBearing(start.bearing + shortestAngle(start.bearing, end.bearing) * progress)
  };
}

function shortestAngle(start, end) {
  return ((end - start + 540) % 360) - 180;
}

function normalizeLongitude(value) {
  const normalized = ((value + 540) % 360) - 180;
  return round(normalized === -180 ? 180 : normalized);
}

function normalizeBearing(value) {
  return round(((value + 540) % 360) - 180);
}

function smoothstep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function boundedDuration(value, maximum, code) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw tourError(code);
  return value;
}

function identifier(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw tourError(code);
  return value;
}

function optionalIdentifier(value) {
  return value === null || value === undefined ? null : identifier(value, "camera_tour_binding_invalid");
}

function boundedText(value, maximum, code) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) throw tourError(code);
  return text;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function round(value) {
  return Number(value.toFixed(9));
}

function tourError(code) {
  return Object.assign(new Error(code), {code});
}
