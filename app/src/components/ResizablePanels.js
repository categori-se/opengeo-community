export function panelExtent(value, total, compact = false) {
  const maximum = compact ? Math.max(120, total - 100) : Math.max(180, Math.min(580, (total - 280) / 2));
  return Math.round(Math.max(Math.min(compact ? 140 : 240, maximum), Math.min(maximum, value)));
}

// Docked panels stay attached to the map. Compact layouts resize the bottom
// sheet vertically instead of squeezing the map between narrow columns.
export function bindResizablePanels({shell, leftPanel, rightPanel, mapColumn, state, render, isCompact, storageKey,
  resizeMap = () => state.map?.resize()}) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"); } catch { /* preferences are optional */ }
  const sizes = {left: Number(saved?.left) || 260, right: Number(saved?.right) || 320};
  const heights = {left: Number(saved?.leftHeight) || 360, right: Number(saved?.rightHeight) || 360};
  let drag = null;
  const root = document.createElement("div");
  root.className = "gis-panel-resizers";
  shell.append(root);
  const controls = ["left", "right"].map((side) => {
    const grip = document.createElement("div");
    grip.className = "gis-panel-resize-grip";
    grip.tabIndex = 0;
    grip.role = "separator";
    grip.setAttribute("aria-label", `Resize ${side === "left" ? "layers" : "inspector"} panel`);
    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.className = "gis-panel-reopen";
    reopen.textContent = side === "left" ? "Layers" : "Inspector";
    reopen.setAttribute("aria-label", `Open ${side === "left" ? "layers" : "inspector"} panel`);
    reopen.addEventListener("click", () => {
      if (isCompact()) state[side === "left" ? "rightOpen" : "leftOpen"] = false;
      state[`${side}Open`] = true;
      render();
    });
    const update = (value) => {
      const compact = isCompact();
      const bound = shell.getBoundingClientRect();
      (compact ? heights : sizes)[side] = panelExtent(value, compact ? mapColumn.clientHeight : bound.width, compact);
      layout();
      resizeMap();
    };
    const persist = () => {
      try { sessionStorage.setItem(storageKey, JSON.stringify({...sizes, leftHeight: heights.left, rightHeight: heights.right})); } catch { /* no data changes */ }
    };
    const end = (cancel = false) => {
      if (!drag || drag.side !== side) return;
      const snapshot = drag;
      drag = null;
      if (cancel) update(snapshot.size);
      if (grip.hasPointerCapture(snapshot.id)) grip.releasePointerCapture(snapshot.id);
      persist();
    };
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      grip.focus({preventScroll: true});
      const panel = side === "left" ? leftPanel : rightPanel;
      drag = {side, id: event.pointerId, compact: isCompact(), x: event.clientX, y: event.clientY, size: isCompact() ? panel.clientHeight : panel.clientWidth};
      grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener("pointermove", (event) => {
      if (!drag || drag.side !== side || drag.id !== event.pointerId) return;
      if (drag.compact !== isCompact()) { end(true); return; }
      update(drag.size + (drag.compact ? drag.y - event.clientY : (event.clientX - drag.x) * (side === "left" ? 1 : -1)));
    });
    grip.addEventListener("pointerup", () => end());
    grip.addEventListener("pointercancel", () => end(true));
    grip.addEventListener("lostpointercapture", () => end(true));
    grip.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { end(true); return; }
      const direction = isCompact() ? {ArrowUp: 1, ArrowDown: -1}[event.key] : {ArrowLeft: side === "left" ? -1 : 1, ArrowRight: side === "left" ? 1 : -1}[event.key];
      if (!direction) return;
      event.preventDefault();
      update((isCompact() ? heights : sizes)[side] + direction * (event.shiftKey ? 40 : 10));
      persist();
    });
    root.append(grip, reopen);
    return {side, grip, reopen, panel: side === "left" ? leftPanel : rightPanel};
  });
  function layout() {
    const bounds = shell.getBoundingClientRect();
    shell.style.setProperty("--gis-map-top", `${mapColumn.getBoundingClientRect().top - bounds.top}px`);
    const compact = isCompact();
    for (const {side, grip, reopen, panel} of controls) {
      const width = panelExtent(sizes[side], bounds.width);
      shell.style.setProperty(`--gis-${side}-width`, `${width}px`);
      const height = panelExtent(heights[side], mapColumn.clientHeight, true);
      shell.style.setProperty(`--gis-${side}-height`, `${height}px`);
      const rect = panel.getBoundingClientRect();
      const open = state[`${side}Open`];
      grip.hidden = !open;
      reopen.hidden = open || compact; // Mobile already has persistent Layers/Tools buttons.
      grip.dataset.compact = String(compact);
      grip.setAttribute("aria-orientation", compact ? "horizontal" : "vertical");
      grip.setAttribute("aria-valuemin", String(panelExtent(0, compact ? mapColumn.clientHeight : bounds.width, compact)));
      grip.setAttribute("aria-valuemax", String(panelExtent(Infinity, compact ? mapColumn.clientHeight : bounds.width, compact)));
      grip.setAttribute("aria-valuenow", String(compact ? height : width));
      Object.assign(grip.style, compact
        ? {left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: "16px"}
        : {left: `${(side === "left" ? rect.right : rect.left) - bounds.left - 5}px`, top: `${rect.top - bounds.top}px`, width: "10px", height: `${rect.height}px`});
      const mapBottom = mapColumn.querySelector(".gis-map")?.getBoundingClientRect().bottom ?? bounds.bottom - 38;
      Object.assign(reopen.style, {left: side === "left" ? "8px" : "auto", right: side === "right" ? "8px" : "auto", bottom: `${Math.max(38, bounds.bottom - mapBottom + 12)}px`});
    }
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(layout) : null;
  observer?.observe(shell); observer?.observe(leftPanel); observer?.observe(rightPanel);
  const mutations = typeof MutationObserver === "function" ? new MutationObserver(layout) : null;
  mutations?.observe(shell, {attributes: true, attributeFilter: ["class"]});
  layout();
  return () => { observer?.disconnect(); mutations?.disconnect(); root.remove(); };
}
