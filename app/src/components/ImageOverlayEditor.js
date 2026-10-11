import {overlayHandlePoint, transformImageOverlay} from "../lib/imageOverlayEditing.js";

export function mountImageOverlayEditor({map, coordinates, opacity, name, onPreview, onCommit, onClose, onError}) {
  let current = coordinates.map((point) => [...point]);
  let currentOpacity = opacity;
  let drag = null;
  const root = document.createElement("div");
  root.className = "gis-image-overlay-editor";
  root.setAttribute("aria-label", `Adjust ${name}`);
  const toolbar = document.createElement("div");
  toolbar.className = "gis-image-overlay-tools";
  const instructions = document.createElement("span");
  instructions.textContent = "Drag handles · Shift: proportions / 15° rotation · arrows: fine adjustment";
  instructions.className = "gis-image-overlay-help";
  const lockLabel = document.createElement("label");
  const lock = document.createElement("input");
  lock.type = "checkbox";
  lockLabel.append(lock, "Keep proportions");
  const opacityLabel = document.createElement("label");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(opacity * 100));
  slider.setAttribute("aria-label", "Image opacity");
  const output = document.createElement("output");
  output.textContent = `${slider.value}%`;
  opacityLabel.append("Opacity", slider, output);
  slider.addEventListener("input", () => {
    currentOpacity = Number(slider.value) / 100;
    output.textContent = `${slider.value}%`;
    onPreview(current, currentOpacity);
  });
  slider.addEventListener("change", () => commit());
  toolbar.append(lockLabel, opacityLabel);
  for (const [label, cancel] of [["Done", false], ["Cancel", true]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => onClose(cancel));
    toolbar.append(button);
  }
  toolbar.append(instructions);
  root.append(toolbar);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("gis-image-overlay-outline");
  const polygon = document.createElementNS(svg.namespaceURI, "polygon");
  svg.append(polygon);
  root.append(svg);
  const buttons = new Map();
  const labels = {nw: "top left", n: "top edge", ne: "top right", e: "right edge", se: "bottom right", s: "bottom edge", sw: "bottom left", w: "left edge", move: "Move image", rotate: "Rotate image"};
  const project = () => current.map((point) => { const value = map.project(point); return [value.x, value.y]; });
  const unproject = (points) => points.map((point) => {
    const value = map.unproject(point);
    if (!Number.isFinite(value.lng) || !Number.isFinite(value.lat) || Math.abs(value.lat) > 90) throw new Error("Move the image within the map");
    return [((value.lng + 180) % 360 + 360) % 360 - 180, value.lat];
  });
  const pointer = (event) => {
    const rect = map.getContainer().getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  function commit() {
    try { onCommit(current, currentOpacity); } catch (error) { onError(error); }
  }
  function finish(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (previous.panEnabled) map.dragPan.enable();
    if (previous.button.hasPointerCapture(previous.pointerId)) previous.button.releasePointerCapture(previous.pointerId);
    if (cancel) {
      current = previous.coordinates;
      onPreview(current, currentOpacity);
      render();
    } else commit();
  }
  for (const [handle, label] of Object.entries(labels)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gis-image-overlay-handle handle-${handle}`;
    button.dataset.overlayHandle = handle;
    button.setAttribute("aria-label", handle === "move" || handle === "rotate" ? label : `Resize image ${label}`);
    button.title = button.getAttribute("aria-label");
    button.textContent = handle === "move" ? "✥" : handle === "rotate" ? "↻" : "";
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({preventScroll: true});
      drag = {button, pointerId: event.pointerId, start: pointer(event), points: project(), coordinates: current.map((point) => [...point]), panEnabled: map.dragPan.isEnabled()};
      map.dragPan.disable();
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      try {
        current = unproject(transformImageOverlay(drag.points, handle, drag.start, pointer(event), {lockAspect: lock.checked || event.shiftKey, snapRotation: event.shiftKey}));
        onPreview(current, currentOpacity);
        render();
      } catch (error) { onError(error); }
    });
    button.addEventListener("pointerup", () => finish());
    button.addEventListener("pointercancel", () => finish(true));
    button.addEventListener("lostpointercapture", () => finish(true));
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.stopPropagation(); finish(true); return; }
      const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const points = project();
        const start = overlayHandlePoint(points, handle);
        let end = start.map((value, axis) => value + direction[axis] * (event.shiftKey ? 10 : 1));
        if (handle === "rotate") {
          const center = overlayHandlePoint(points, "move");
          const angle = (direction[0] || direction[1]) * (event.shiftKey ? 15 : 1) * Math.PI / 180;
          const [dx, dy] = start.map((value, axis) => value - center[axis]);
          end = [center[0] + dx * Math.cos(angle) - dy * Math.sin(angle), center[1] + dx * Math.sin(angle) + dy * Math.cos(angle)];
        }
        current = unproject(transformImageOverlay(points, handle, start, end, {lockAspect: lock.checked || event.shiftKey}));
        onPreview(current, currentOpacity);
        commit();
        render();
      } catch (error) { onError(error); }
    });
    root.append(button);
    buttons.set(handle, button);
  }
  function render() {
    const points = project();
    polygon.setAttribute("points", points.map((point) => point.join(",")).join(" "));
    for (const [handle, button] of buttons) {
      const [x, y] = overlayHandlePoint(points, handle);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
    }
  }
  root.addEventListener("click", (event) => event.stopPropagation());
  root.addEventListener("dblclick", (event) => event.stopPropagation());
  toolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
  map.getContainer().append(root);
  map.on("move", render);
  map.on("resize", render);
  render();
  buttons.get("move").focus({preventScroll: true});
  return () => { finish(true); map.off("move", render); map.off("resize", render); root.remove(); };
}
