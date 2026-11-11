// Browser-exposed controllers only. Device identifiers never leave this session.
export const MAP_CONTROLLER_LIMITS = Object.freeze({
  deadzone: 0.15,
  maximumFrameMilliseconds: 100,
  panPixelsPerSecond: 240,
  zoomPerSecond: 1.5,
  pitchDegreesPerSecond: 50,
  bearingDegreesPerSecond: 60,
  rollDegreesPerSecond: 60
});

export function mapControllerInput(pad, profile = "standard") {
  if (!pad || pad.connected !== true || !Number.isInteger(pad.index) || pad.index < 0) return null;
  const axes = pad.axes;
  const count = profile === "standard" ? 4 : profile === "six-axis" ? 6 : 0;
  if (!count || !Array.isArray(axes) || axes.length < count
    || !axes.slice(0, count).every(value => Number.isFinite(value) && Math.abs(value) <= 1)) return null;
  const axis = index => deadzone(axes[index]);
  if (profile === "six-axis") {
    if (pad.mapping !== "") return null;
    // Explicit translation XYZ, rotation XYZ convention for the selected layout.
    return {panX: axis(0), panY: axis(1), zoom: -axis(2), pitch: -axis(3), roll: axis(4), bearing: axis(5)};
  }
  if (pad.mapping !== "standard") return null;
  const trigger = index => {
    const value = pad.buttons?.[index]?.value ?? 0;
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : NaN;
  };
  const zoom = trigger(7) - trigger(6);
  return Number.isFinite(zoom)
    ? {panX: axis(0), panY: axis(1), zoom: deadzone(zoom), pitch: -axis(3), bearing: axis(2)}
    : null;
}

/** Derive one complete camera before changing the map; no asynchronous travel. */
export function mapControllerCamera(map, input, milliseconds) {
  const seconds = clamp(milliseconds, 0, MAP_CONTROLLER_LIMITS.maximumFrameMilliseconds) / 1000;
  if (!Number.isFinite(seconds) || !input || !Object.values(input).every(Number.isFinite)) {
    throw Error("Controller input is unavailable.");
  }
  const center = map.getCenter();
  const position = map.project(center);
  const next = map.unproject([
    position.x + input.panX * MAP_CONTROLLER_LIMITS.panPixelsPerSecond * seconds,
    position.y + input.panY * MAP_CONTROLLER_LIMITS.panPixelsPerSecond * seconds
  ]);
  const zoom = map.getZoom(), pitch = map.getPitch(), bearing = map.getBearing();
  if (![next?.lng, next?.lat, zoom, pitch, bearing].every(Number.isFinite)) {
    throw Error("Controller navigation is unavailable at this view.");
  }
  const minZoom = map.getMinZoom?.() ?? 0, maxZoom = map.getMaxZoom?.() ?? 22;
  const minPitch = map.getMinPitch?.() ?? 0, maxPitch = Math.min(85, map.getMaxPitch?.() ?? 60);
  if (![minZoom, maxZoom, minPitch, maxPitch].every(Number.isFinite)
    || minZoom > maxZoom || minPitch > maxPitch) throw Error("The map camera limits are unavailable.");
  const useRoll = input.roll !== undefined;
  const roll = useRoll ? map.getRoll?.() : 0;
  if (useRoll && !Number.isFinite(roll)) throw Error("Map roll is unavailable at this view.");
  return {
    center: [wrap(next.lng), clamp(next.lat, -85.051129, 85.051129)],
    zoom: clamp(zoom + input.zoom * MAP_CONTROLLER_LIMITS.zoomPerSecond * seconds, minZoom, maxZoom),
    pitch: clamp(pitch + input.pitch * MAP_CONTROLLER_LIMITS.pitchDegreesPerSecond * seconds, minPitch, maxPitch),
    bearing: wrap(bearing + input.bearing * MAP_CONTROLLER_LIMITS.bearingDegreesPerSecond * seconds),
    ...(useRoll ? {roll: wrap(roll + input.roll * MAP_CONTROLLER_LIMITS.rollDegreesPerSecond * seconds)} : {})
  };
}

export function createMapController({
  getMap,
  available = () => true,
  onStatus = () => {},
  document: doc = globalThis.document,
  window: view = doc.defaultView,
  getPads = () => view.navigator.getGamepads(),
  requestFrame = callback => view.requestAnimationFrame(callback),
  cancelFrame = id => view.cancelAnimationFrame(id)
}) {
  let running = false, disposed = false, pending = null, selected = null, activeMap = null, previousTime = null;
  const status = (active, message) => onStatus({active, message});
  const stop = (message = "Controller navigation stopped.") => {
    const wasRunning = running;
    running = false;
    if (pending !== null) cancelFrame(pending);
    pending = null;
    selected = activeMap = previousTime = null;
    if (wasRunning) status(false, message);
  };
  const focused = () => doc.visibilityState !== "hidden" && doc.activeElement === activeMap?.getCanvas?.();
  const tick = timestamp => {
    pending = null;
    if (!running || disposed) return;
    try {
      if (getMap() !== activeMap || !available() || !focused()) {
        stop("Controller stopped. Focus the map and enable it again to continue.");
        return;
      }
      const pad = Array.from(getPads() ?? []).find(value => value?.index === selected.index);
      if (!pad || pad.id !== selected.id || pad.mapping !== selected.mapping) {
        stop("Controller disconnected or changed. Enable it again to select a device.");
        return;
      }
      const input = mapControllerInput(pad, selected.profile);
      if (!input || !Number.isFinite(timestamp)) throw Error("Controller input is unavailable.");
      if (previousTime !== null && Object.values(input).some(Boolean)) {
        const camera = mapControllerCamera(activeMap, input, Math.max(0, timestamp - previousTime));
        activeMap.jumpTo(camera);
      }
      previousTime = timestamp;
      pending = requestFrame(tick);
    } catch {
      stop("Controller navigation is unavailable. Use the map controls and enable it again to retry.");
    }
  };
  const start = (profile = "standard") => {
    if (disposed) return false;
    stop();
    try {
      const map = getMap();
      const canvas = map?.getCanvas?.();
      if (!canvas?.isConnected || !available() || doc.visibilityState === "hidden") {
        status(false, "Wait for the interactive map and finish other camera tools before enabling a controller.");
        return false;
      }
      const pad = Array.from(getPads() ?? []).find(value => mapControllerInput(value, profile));
      if (!pad) {
        status(false, "No compatible controller is available. Press a device button, then enable it again.");
        return false;
      }
      if (Object.values(mapControllerInput(pad, profile)).some(Boolean)) {
        status(false, "Release the controller axes and triggers, then enable it again.");
        return false;
      }
      activeMap = map;
      selected = {index: pad.index, id: pad.id, mapping: pad.mapping, profile};
      map.stop?.();
      canvas.focus({preventScroll: true});
      if (!focused()) throw Error("The map cannot receive focus.");
      running = true;
      status(true, "Controller active while the map has focus. Press Escape or Stop controller to finish.");
      pending = requestFrame(tick);
      return true;
    } catch {
      running = false;
      selected = activeMap = previousTime = null;
      status(false, "The browser did not provide controller access. Use the map controls or enable it again to retry.");
      return false;
    }
  };
  const blur = () => stop("Controller stopped when this window lost focus.");
  const hidden = () => { if (doc.visibilityState === "hidden") stop("Controller stopped while the page is hidden."); };
  const key = event => {
    if (!running) return;
    if (event.key === "Escape") event.preventDefault();
    stop(event.key === "Escape" ? undefined : "Controller stopped for keyboard navigation.");
  };
  const pointer = event => {
    if (event.target === activeMap?.getCanvas?.()) stop("Controller stopped for pointer navigation.");
  };
  const disconnect = event => {
    if (running && event.gamepad?.index === selected?.index) stop("Controller disconnected. Enable it again to continue.");
  };
  view.addEventListener("blur", blur);
  view.addEventListener("gamepaddisconnected", disconnect);
  doc.addEventListener("visibilitychange", hidden);
  doc.addEventListener("keydown", key);
  doc.addEventListener("pointerdown", pointer, {passive: true});
  doc.addEventListener("wheel", pointer, {passive: true});
  return {
    start,
    stop,
    get active() { return running; },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      view.removeEventListener("blur", blur);
      view.removeEventListener("gamepaddisconnected", disconnect);
      doc.removeEventListener("visibilitychange", hidden);
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("pointerdown", pointer);
      doc.removeEventListener("wheel", pointer);
    }
  };
}

function deadzone(value) {
  return Math.abs(value) <= MAP_CONTROLLER_LIMITS.deadzone ? 0
    : Math.sign(value) * (Math.abs(value) - MAP_CONTROLLER_LIMITS.deadzone) / (1 - MAP_CONTROLLER_LIMITS.deadzone);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function wrap(value) { return ((value + 180) % 360 + 360) % 360 - 180; }
