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

// Shared column sizing for the publication Source explorer, editor and preview.
// These are local presentation preferences, never document or account writes.
export function sourcePanelWidths(total, requested = {}, {explorer = true, editor = true} = {}) {
  const grip = 12, leftMin = explorer ? 160 : 0, rightMin = 240, centerMin = editor ? 280 : 0;
  const grips = Number(explorer) + Number(editor), available = Math.max(0, total - grip * grips);
  const stacked = available < leftMin + rightMin + centerMin;
  if (stacked) return {stacked, left: 0, right: 0, center: 0, grip};
  const numeric = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  let left = explorer ? Math.max(leftMin, Math.min(480, available - rightMin - centerMin, numeric(requested.left, 220))) : 0;
  let right = editor ? Math.max(rightMin, Math.min(available - leftMin - centerMin, numeric(requested.right, 360))) : Math.max(rightMin, available - left);
  const excess = left + right + centerMin - available;
  if (excess > 0) {
    const flexible = left - leftMin + right - rightMin;
    if (flexible > 0) {
      left -= excess * (left - leftMin) / flexible;
      right -= excess * (right - rightMin) / flexible;
    }
  }
  left = Math.floor(Math.max(leftMin, left));
  right = Math.floor(Math.max(rightMin, right));
  return {stacked, left, right, center: available - left - right, grip};
}

export function bindResizableSourcePanels({shell, explorer, editor, preview,
  storageKey = "opengeo.publication-source-panel-widths.v1", onResize = () => {}}) {
  const doc = shell.ownerDocument, win = doc.defaultView;
  const requestFrame = win.requestAnimationFrame?.bind(win) ?? (callback => win.setTimeout(callback, 0));
  const cancelFrame = win.cancelAnimationFrame?.bind(win) ?? win.clearTimeout.bind(win);
  let saved;
  try { saved = JSON.parse(win.sessionStorage.getItem(storageKey) ?? "{}"); } catch { /* optional preference */ }
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const requested = {left: finite(saved?.left) ? saved.left : 220, right: finite(saved?.right) ? saved.right : 360};
  const defaults = {left: 220, right: 360};
  let drag = null, disposed = false, resizeFrame = null, connected = shell.isConnected, signature;
  const shield = doc.createElement("div"); shield.className = "source-panel-resize-shield"; shield.hidden = true;
  shell.classList.add("source-editor-resizable");
  const grips = ["left", "right"].map(side => {
    const grip = doc.createElement("div");
    grip.className = `source-panel-resizer source-panel-resizer-${side}`;
    grip.tabIndex = 0; grip.setAttribute("role", "separator"); grip.setAttribute("aria-orientation", "vertical");
    const label = side === "left" ? "Resize Explorer panel" : "Resize preview panel";
    grip.setAttribute("aria-label", label); grip.title = `${label}. Drag, or use Left and Right arrow keys. Home and End use the limits.`;
    const panel = side === "left" ? explorer : preview;
    if (!panel.id) panel.id = `publication-source-${side}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    grip.setAttribute("aria-controls", panel.id);
    grip.addEventListener("pointerdown", event => {
      if (disposed || event.button !== 0 || drag || grip.hidden) return;
      event.preventDefault(); grip.focus({preventScroll: true});
      const widths = layout();
      drag = {side, id: event.pointerId, x: event.clientX, size: widths[side], before: {...requested}};
      if (!explorer.hidden) requested.left = widths.left;
      if (!editor.hidden) requested.right = widths.right;
      shield.hidden = false; shell.classList.add("source-panels-resizing");
      grip.setPointerCapture?.(event.pointerId);
      doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", finishPointer); doc.addEventListener("pointercancel", cancelPointer);
    });
    grip.addEventListener("lostpointercapture", () => end(true));
    grip.addEventListener("keydown", event => {
      if (event.key === "Escape" && drag) {event.preventDefault(); end(true); return;}
      if (grip.hidden || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const widths = layout();
      if (!explorer.hidden) requested.left = widths.left;
      if (!editor.hidden) requested.right = widths.right;
      const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
      const min = Number(grip.getAttribute("aria-valuemin")), max = Number(grip.getAttribute("aria-valuemax"));
      requested[side] = event.key === "Home" ? min : event.key === "End" ? max
        : Math.max(min, Math.min(max, widths[side] + direction * (event.shiftKey ? 40 : 10)));
      layout(); persist();
    });
    grip.addEventListener("dblclick", () => {requested[side] = defaults[side]; layout(); persist();});
    shell.insertBefore(grip, side === "left" ? editor : preview);
    return {side, grip};
  });
  shell.append(shield);
  function persist() {
    try { win.sessionStorage.setItem(storageKey, JSON.stringify(requested)); } catch { /* resizing still works */ }
  }
  function notify() {
    if (resizeFrame !== null || disposed) return;
    resizeFrame = requestFrame(() => {resizeFrame = null; if (!disposed) onResize();});
  }
  function layout() {
    const bounds = shell.getBoundingClientRect(), width = shell.clientWidth || bounds.width, explorerOpen = !explorer.hidden, editorOpen = !editor.hidden;
    const widths = sourcePanelWidths(width, requested, {explorer: explorerOpen, editor: editorOpen});
    const mode = widths.stacked ? "stacked" : editorOpen ? explorerOpen ? "columns" : "editor-preview" : explorerOpen ? "explorer-preview" : "preview";
    if (drag && (widths.stacked || (drag.side === "left" ? !explorerOpen : !editorOpen))) end(true);
    shell.dataset.resizeLayout = mode;
    shell.style.setProperty("--source-explorer-width", `${widths.left}px`);
    shell.style.setProperty("--source-preview-width", `${widths.right}px`);
    for (const {side, grip} of grips) {
      grip.hidden = widths.stacked || (side === "left" ? !explorerOpen : !editorOpen);
      const min = side === "left" ? 160 : 240;
      const max = side === "left" ? Math.max(min, Math.min(480, width - (editorOpen ? 280 : 0) - (editorOpen ? widths.right : 240) - widths.grip * (Number(explorerOpen) + Number(editorOpen))))
        : Math.max(min, width - widths.left - 280 - widths.grip * (Number(explorerOpen) + Number(editorOpen)));
      grip.setAttribute("aria-valuemin", String(min)); grip.setAttribute("aria-valuemax", String(Math.floor(max)));
      grip.setAttribute("aria-valuenow", String(widths[side])); grip.setAttribute("aria-valuetext", `${widths[side]} pixels`);
    }
    const next = [bounds.width, bounds.height, mode, widths.left, widths.right].join(":");
    if (signature !== next) {signature = next; notify();}
    return widths;
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const grip = grips.find(item => item.side === drag.side).grip;
    requested[drag.side] = Math.max(Number(grip.getAttribute("aria-valuemin")), Math.min(Number(grip.getAttribute("aria-valuemax")),
      drag.size + (event.clientX - drag.x) * (drag.side === "left" ? 1 : -1)));
    layout();
  }
  function end(cancel = false) {
    if (!drag) return;
    const previous = drag; drag = null;
    if (cancel) Object.assign(requested, previous.before);
    doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", finishPointer); doc.removeEventListener("pointercancel", cancelPointer);
    const grip = grips.find(item => item.side === previous.side).grip;
    if (grip.hasPointerCapture?.(previous.id)) grip.releasePointerCapture(previous.id);
    shield.hidden = true; shell.classList.remove("source-panels-resizing"); layout();
    if (!cancel) persist();
  }
  const finishPointer = event => {if (drag?.id === event.pointerId) end();};
  const cancelPointer = event => {if (drag?.id === event.pointerId) end(true);};
  const resizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(layout) : null;
  resizeObserver?.observe(shell);
  const mutationObserver = new win.MutationObserver(() => layout());
  mutationObserver.observe(shell, {attributes: true, attributeFilter: ["class"]});
  for (const panel of [explorer, editor]) mutationObserver.observe(panel, {attributes: true, attributeFilter: ["hidden"]});
  const removalObserver = new win.MutationObserver(() => {
    if (!shell.isConnected && connected) dispose();
    else if (shell.isConnected && !connected) {connected = true; layout();}
  });
  removalObserver.observe(doc.body, {childList: true, subtree: true});
  win.addEventListener("resize", layout); layout();
  function dispose() {
    if (disposed) return;
    end(true); disposed = true;
    if (resizeFrame !== null) cancelFrame(resizeFrame);
    resizeObserver?.disconnect(); mutationObserver.disconnect(); removalObserver.disconnect(); win.removeEventListener("resize", layout);
    grips.forEach(({grip}) => grip.remove()); shield.remove(); shell.classList.remove("source-editor-resizable", "source-panels-resizing");
    shell.removeAttribute("data-resize-layout"); shell.style.removeProperty("--source-explorer-width"); shell.style.removeProperty("--source-preview-width");
  }
  return {layout, dispose};
}
