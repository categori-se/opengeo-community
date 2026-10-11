import {shapeVertexGroups, editShapeVertex} from "../lib/shapeEditing.js";

export function mountShapeEditor({map, geometry, onPreview, onCommit, onClose, onError}) {
  let current = structuredClone(geometry);
  let drag = null;
  const root = document.createElement("div");
  root.className = "gis-shape-editor gis-image-overlay-editor";
  const toolbar = document.createElement("div");
  toolbar.className = "gis-image-overlay-tools";
  toolbar.append("Drag vertices · + adds a point · Delete removes a selected vertex · arrows adjust");
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = "Finish shape editing";
  done.addEventListener("click", onClose);
  toolbar.append(done);
  root.append(toolbar);
  const handles = document.createElement("div");
  root.append(handles);
  function position(button, coordinate) {
    const point = map.project(coordinate);
    button.style.left = `${point.x}px`;
    button.style.top = `${point.y}px`;
  }
  function commit() {
    try { onCommit(current); } catch (error) { onError(error); }
  }
  function end(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (previous.panEnabled) map.dragPan.enable();
    if (previous.button.hasPointerCapture(previous.pointerId)) previous.button.releasePointerCapture(previous.pointerId);
    if (cancel) { current = previous.geometry; onPreview(current); } else commit();
    render();
  }
  function render() {
    if (drag) return;
    handles.replaceChildren();
    for (const [groupIndex, group] of shapeVertexGroups(current).entries()) {
      group.points.forEach((coordinate, vertexIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gis-image-overlay-handle gis-shape-vertex";
        button.setAttribute("aria-label", `Part ${groupIndex + 1} vertex ${vertexIndex + 1}`);
        button.dataset.shapeVertex = `${groupIndex}:${vertexIndex}`;
        position(button, coordinate);
        button.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || drag) return;
          event.preventDefault(); event.stopPropagation();
          button.focus({preventScroll: true});
          drag = {button, pointerId: event.pointerId, geometry: structuredClone(current), panEnabled: map.dragPan.isEnabled()};
          map.dragPan.disable(); button.setPointerCapture(event.pointerId);
        });
        button.addEventListener("pointermove", (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const rect = map.getContainer().getBoundingClientRect();
          const value = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
          try {
            current = editShapeVertex(current, groupIndex, vertexIndex, [((value.lng + 180) % 360 + 360) % 360 - 180, value.lat]);
            position(button, [value.lng, value.lat]); onPreview(current);
          } catch (error) { onError(error); }
        });
        button.addEventListener("pointerup", () => end());
        button.addEventListener("pointercancel", () => end(true));
        button.addEventListener("lostpointercapture", () => end(true));
        button.addEventListener("keydown", (event) => {
          if (event.key === "Escape") { event.stopPropagation(); end(true); return; }
          const delta = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
          if (!delta && !["Delete", "Backspace"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          try {
            const value = map.project(coordinate);
            const next = delta ? map.unproject([value.x + delta[0] * (event.shiftKey ? 10 : 1), value.y + delta[1] * (event.shiftKey ? 10 : 1)]) : null;
            current = editShapeVertex(current, groupIndex, vertexIndex, next ? [next.lng, next.lat] : null, delta ? "move" : "delete");
            onPreview(current); commit(); render();
            handles.querySelector(`[data-shape-vertex="${groupIndex}:${Math.min(vertexIndex, shapeVertexGroups(current)[groupIndex].points.length - 1)}"]`)?.focus({preventScroll: true});
          } catch (error) { onError(error); }
        });
        handles.append(button);
        if (group.point || (!group.closed && vertexIndex === group.points.length - 1)) return;
        const next = group.points[(vertexIndex + 1) % group.points.length];
        const a = map.project(coordinate); const b = map.project(next);
        const middle = map.unproject([(a.x + b.x) / 2, (a.y + b.y) / 2]);
        const add = document.createElement("button");
        add.type = "button";
        add.className = "gis-image-overlay-handle gis-shape-midpoint";
        add.textContent = "+";
        add.setAttribute("aria-label", `Add vertex after part ${groupIndex + 1} vertex ${vertexIndex + 1}`);
        position(add, [middle.lng, middle.lat]);
        add.addEventListener("click", () => {
          try { current = editShapeVertex(current, groupIndex, vertexIndex, [middle.lng, middle.lat], "insert"); onPreview(current); commit(); render(); } catch (error) { onError(error); }
        });
        handles.append(add);
      });
    }
  }
  root.addEventListener("click", (event) => event.stopPropagation());
  root.addEventListener("dblclick", (event) => event.stopPropagation());
  toolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
  map.getContainer().append(root);
  map.on("move", render); map.on("resize", render);
  render();
  return () => { end(true); map.off("move", render); map.off("resize", render); root.remove(); };
}
