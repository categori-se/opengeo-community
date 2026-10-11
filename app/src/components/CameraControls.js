// Keep camera controls independent of projection, terrain, and scene visibility.
export function CameraControls(getMap) {
  const root = document.createElement("section");
  root.className = "gis-camera-controls";
  root.setAttribute("aria-label", "Viewing angle");
  let draggingTilt = false;
  let ringDrag = null;
  const view = root.ownerDocument.defaultView;
  const move = (change, duration = 320) => {
    const map = getMap();
    if (!map) return;
    map.stop?.();
    const reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    map.easeTo({...change, duration: reducedMotion ? 0 : duration});
  };
  const bounds = () => ({min: getMap()?.getMinPitch?.() ?? 0, max: Math.min(85, getMap()?.getMaxPitch?.() ?? 60)});
  const north = document.createElement("button");
  north.type = "button";
  north.className = "gis-camera-center";
  north.setAttribute("aria-label", "Reset north and tilt");
  north.textContent = "N";
  north.addEventListener("click", () => {
    move({bearing: 0, pitch: bounds().min});
    update();
  });
  const compass = document.createElement("div");
  compass.className = "gis-camera-compass";
  const ring = document.createElement("div");
  ring.className = "gis-camera-ring";
  ring.tabIndex = 0;
  ring.role = "slider";
  ring.setAttribute("aria-label", "Map heading");
  ring.setAttribute("aria-valuemin", "0");
  ring.setAttribute("aria-valuemax", "359");
  ring.title = "Drag the compass rim to rotate. Arrow keys adjust heading; Home faces north.";
  const marker = document.createElement("span");
  marker.className = "gis-camera-north-marker";
  marker.setAttribute("aria-hidden", "true");
  ring.append(marker);
  const angle = event => {
    const rect = ring.getBoundingClientRect();
    return Math.atan2(event.clientY - rect.top - rect.height / 2, event.clientX - rect.left - rect.width / 2) * 180 / Math.PI;
  };
  ring.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !getMap()) return;
    event.preventDefault(); ring.focus();
    ring.setPointerCapture(event.pointerId);
    getMap().stop?.();
    ringDrag = {id: event.pointerId, previous: angle(event)};
  });
  ring.addEventListener("pointermove", event => {
    if (!ringDrag || ringDrag.id !== event.pointerId) return;
    const current = angle(event);
    const delta = ((current - ringDrag.previous + 540) % 360) - 180;
    ringDrag.previous = current;
    move({bearing: getMap().getBearing() - delta}, 0);
    update();
  });
  const finishRing = () => {
    const id = ringDrag?.id;
    ringDrag = null;
    if (id !== undefined && ring.hasPointerCapture?.(id)) ring.releasePointerCapture(id);
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) ring.addEventListener(event, finishRing);
  ring.addEventListener("keydown", event => {
    if (!getMap() || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    const delta = ["ArrowLeft", "ArrowDown"].includes(event.key) ? -5 : 5;
    move({bearing: event.key === "Home" ? 0 : getMap().getBearing() + delta});
    update();
  });
  compass.append(ring, north);
  const label = document.createElement("label");
  label.className = "gis-camera-tilt";
  const value = document.createElement("span");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.step = "1";
  slider.setAttribute("aria-label", "Viewing tilt in degrees");
  slider.addEventListener("pointerdown", () => {
    draggingTilt = true;
    const view = slider.ownerDocument.defaultView;
    const finish = () => {
      draggingTilt = false;
      view.removeEventListener("pointerup", finish);
      view.removeEventListener("pointercancel", finish);
      update();
    };
    view.addEventListener("pointerup", finish);
    view.addEventListener("pointercancel", finish);
  });
  slider.addEventListener("input", () => {
    const pitch = Number(slider.value);
    value.textContent = `Tilt ${pitch}°`;
    slider.setAttribute("aria-valuetext", `${pitch} degrees from overhead`);
    // Direct manipulation must not animate back through an earlier slider value.
    move({pitch}, 0);
  });
  label.append(value, slider);
  const help = document.createElement("details");
  help.className = "gis-camera-help";
  const summary = document.createElement("summary");
  summary.textContent = "Navigation help";
  const instructions = document.createElement("p");
  instructions.textContent = "Drag the compass to turn; use the tilt slider to look toward the horizon. With the compass focused, arrow keys turn and Home faces north. On the map, right-drag or Ctrl-drag to rotate and tilt. On touchscreens, twist two fingers to rotate, pinch to zoom, or drag two fingers together to tilt. N returns to north and overhead.";
  help.append(summary, instructions);
  root.append(compass, label, help);
  function update() {
    const map = getMap();
    for (const node of [north, slider]) node.disabled = !map;
    const {min, max} = bounds();
    slider.min = String(min);
    slider.max = String(max);
    const pitch = Math.round(map?.getPitch?.() ?? 0);
    if (!draggingTilt) {
      slider.value = String(pitch);
      slider.setAttribute("aria-valuetext", `${pitch} degrees from overhead`);
      value.textContent = `Tilt ${pitch}°`;
    }
    const bearing = map?.getBearing?.() ?? 0;
    ring.setAttribute("aria-disabled", String(!map));
    ring.setAttribute("aria-valuenow", String(Math.round(((bearing % 360) + 360) % 360) % 360));
    ring.setAttribute("aria-valuetext", `${Math.round(((bearing % 360) + 360) % 360) % 360} degrees clockwise from north`);
    ring.style.setProperty("--camera-bearing", `${-bearing}deg`);
    north.dataset.displaced = String(Math.abs(bearing % 360) > 0.5 || pitch > min);
    north.title = `Reset north and tilt · heading ${Math.round(((bearing % 360) + 360) % 360)}°`;
  }
  update();
  return {element: root, update, isInteracting: () => draggingTilt || Boolean(ringDrag)};
}
