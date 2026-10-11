export const GLOBE_INTERACTION_CONTRACT = Object.freeze({
  requiredHandlers: Object.freeze([
    "dragPan",
    "dragRotate",
    "scrollZoom",
    "keyboard",
    "touchZoomRotate",
    "touchPitch"
  ]),
  restorationTolerance: Object.freeze({
    coordinateDegrees: 0.001,
    zoom: 0.001,
    pitchDegrees: 0.001,
    bearingDegrees: 0.001
  })
});

export function globeInteractionSupport(map) {
  return Object.fromEntries(GLOBE_INTERACTION_CONTRACT.requiredHandlers.map((name) => [
    name,
    handlerEnabled(map?.[name])
  ]));
}

export function globeInteractionSupportAccepted(support) {
  return GLOBE_INTERACTION_CONTRACT.requiredHandlers.every((name) => support?.[name] === true);
}

export function restoredMapViewMatches(saved, restored, tolerance = GLOBE_INTERACTION_CONTRACT.restorationTolerance) {
  if (!validView(saved) || !validView(restored)) return false;
  return saved.center.every((coordinate, index) => (
    Math.abs(coordinate - restored.center[index]) <= tolerance.coordinateDegrees
  ))
    && Math.abs(saved.zoom - restored.zoom) <= tolerance.zoom
    && Math.abs(saved.pitch - restored.pitch) <= tolerance.pitchDegrees
    && angularDistance(saved.bearing, restored.bearing) <= tolerance.bearingDegrees;
}

function handlerEnabled(handler) {
  try {
    return handler?.isEnabled?.() === true;
  } catch {
    return false;
  }
}

function validView(view) {
  return view
    && Array.isArray(view.center)
    && view.center.length === 2
    && [...view.center, view.zoom, view.pitch, view.bearing].every(Number.isFinite);
}

function angularDistance(left, right) {
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}
