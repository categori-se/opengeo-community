/* OpenGeo public imagery embed v1. No credentials, account data or archive requests.
 * Classic script so other sites can embed this Studio-hosted component without
 * weakening Studio's frame-ancestors policy or requiring a map server.
 */
function installImageryLab() {
  const ROOT = "https://coast.noaa.gov/arcgis/rest/services/Imagery/";
  const SOURCES = {
    cir8: {service: "3Band_CIR_8Bit_Imagery", title: "CIR 8-bit", mission: "126", bits: 8},
    cir16: {service: "3Band_CIR_16Bit_Imagery", title: "CIR 16-bit", mission: "137", bits: 16},
    rgb8: {service: "3Band_RGB_8Bit_Imagery", title: "RGB 8-bit", mission: "131", bits: 8},
    rgb16: {service: "3Band_RGB_16Bit_Imagery", title: "RGB 16-bit", mission: "122", bits: 16}
  };
  const R = 6378137, GRID = 128;
  const project = (lon, lat) => [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  const unproject = (x, y) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
  const ndvi = (nir, red) => Number.isFinite(nir + red) && nir + red !== 0 ? (nir - red) / (nir + red) : NaN;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const MODES = new Set(["spectral", "depth", "stretch", "infrared", "ndvi", "difference", "threshold"]);
  const analytic = mode => ["ndvi", "difference", "threshold"].includes(mode);
  const autoLoads = [];
  let activeAutoLoads = 0;
  function drainAutoLoads() {
    while (activeAutoLoads < 2 && autoLoads.length) {
      const lab = autoLoads.shift();
      if (!lab.isConnected || !lab.autoQueued) continue;
      lab.autoQueued = false;
      activeAutoLoads++;
      lab.refresh().finally(() => {activeAutoLoads--; drainAutoLoads();});
    }
  }
  const endpoint = key => ROOT + SOURCES[key].service + "/ImageServer";
  const node = (tag, text = "") => {const e = document.createElement(tag); e.textContent = text; return e;};
  function rule(rasterId) {return {mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [rasterId], mosaicOperation: "MT_FIRST"};}
  function decodeTiff(buffer) {
    // Deliberately narrow reader: bounded, uncompressed unsigned NOAA TIFF only.
    // Unsupported formats fail closed instead of interpreting display bytes as data.
    if (buffer.byteLength > 2_000_000 || buffer.byteLength < 8) throw Error("Unexpected TIFF size");
    const v = new DataView(buffer), little = v.getUint16(0) === 0x4949;
    if (!little && v.getUint16(0) !== 0x4d4d) throw Error("NOAA did not return TIFF data");
    const u16 = p => v.getUint16(p, little), u32 = p => v.getUint32(p, little);
    if (u16(2) !== 42) throw Error("Unsupported TIFF variant");
    const offset = u32(4), count = u16(offset), tags = {};
    if (count > 128) throw Error("Excessive TIFF tags");
    const sizes = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8};
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12, id = u16(p), type = u16(p + 2), n = u32(p + 4), size = sizes[type];
      if (!size) continue;
      if (n > 8192) throw Error("Excessive TIFF values");
      const start = n * size <= 4 ? p + 8 : u32(p + 8);
      tags[id] = Array.from({length: n}, (_, j) => {
        const at = start + j * size;
        return type === 12 ? v.getFloat64(at, little) : type === 4 ? u32(at) : type === 3 ? u16(at) : v.getUint8(at);
      });
    }
    const width = tags[256]?.[0], height = tags[257]?.[0], bands = tags[277]?.[0], bits = tags[258]?.[0];
    if (width !== GRID || height !== GRID || bands !== 3 || ![8, 16].includes(bits) ||
      tags[258].some(b => b !== bits) || tags[259]?.[0] !== 1 || (tags[284]?.[0] ?? 1) !== 1 ||
      (tags[339] ?? [1]).some(t => t !== 1)) throw Error("Unsupported analytical TIFF layout");
    const tw = tags[322]?.[0] ?? width, th = tags[323]?.[0] ?? tags[278]?.[0] ?? height;
    const offsets = tags[324] ?? tags[273], lengths = tags[325] ?? tags[279];
    if (!tw || !th || !offsets || offsets.length > 1024 || offsets.length !== lengths?.length) throw Error("Invalid TIFF tiles");
    const data = new Uint16Array(width * height * bands), bytes = bits / 8, columns = Math.ceil(width / tw);
    for (let t = 0; t < offsets.length; t++) {
      const left = t % columns * tw, top = Math.floor(t / columns) * th;
      for (let y = 0; y < th && top + y < height; y++) for (let x = 0; x < tw && left + x < width; x++) for (let b = 0; b < bands; b++) {
        const pos = ((y * tw + x) * bands + b) * bytes;
        if (pos + bytes > lengths[t]) throw Error("Truncated analytical tile");
        data[((top + y) * width + left + x) * bands + b] = bits === 16 ? u16(offsets[t] + pos) : v.getUint8(offsets[t] + pos);
      }
    }
    const scale = tags[33550], tie = tags[33922], geo = tags[34735];
    if (!scale || !tie || !geo || !geo.some((id, i) => i >= 4 && (i - 4) % 4 === 0 && id === 3072 && geo[i + 3] === 3857)) throw Error("Missing EPSG:3857 georeference");
    return {width, height, bands, bits, data, scale, tie};
  }
  function paired(a, b) {
    return a.bits === 8 && b.bits === 16 && a.width === b.width && a.height === b.height &&
      a.scale.every((n, i) => Math.abs(n - b.scale[i]) < 1e-7) && a.tie.every((n, i) => Math.abs(n - b.tie[i]) < 1e-7);
  }
  const STYLE = `:host{display:block;margin:1.2rem 0;color:#e6edf3;font:15px/1.45 system-ui;background:#12202b;border:1px solid #607080;border-radius:10px;overflow:hidden}*{box-sizing:border-box}header,.controls,.info,details{padding:.65rem .85rem}header{font-weight:650;background:#1c3443}.controls{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}button,select,input{font:inherit}button,select{padding:.4rem .6rem;border-radius:5px;border:1px solid #8096a6;background:#203d50;color:inherit}button:disabled{opacity:.55}button{cursor:pointer}label{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap}input[type=range]{width:130px}a{color:#8bd4ff}canvas{display:block;width:100%;height:auto;aspect-ratio:2/1;background:#23343d;touch-action:none;cursor:crosshair}canvas:focus{outline:3px solid #76c8ff;outline-offset:-3px}.info{margin:0;overflow-wrap:anywhere}.status{color:#ffe3a3}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:240px;overflow:auto}details summary{cursor:pointer}.hist{height:95px;aspect-ratio:auto;cursor:default}.hidden{display:none!important}@media(max-width:520px){canvas{aspect-ratio:4/3}.controls{gap:.4rem}input[type=range]{width:95px}}`;
  class ImageryLab extends HTMLElement {
    connectedCallback() {
      if (this.root) {if (this.started) this.schedule(); return;}
      this.mode = MODES.has(this.getAttribute("mode")) ? this.getAttribute("mode") : "spectral";
      this.center = project(-72.0923688, 41.3570701);
      this.span = analytic(this.mode) ? 128 : 2400;
      this.left = this.mode === "spectral" ? "rgb8" : "cir8";
      this.right = "cir16";
      if (this.mode === "spectral") this.right = "cir8";
      if (["stretch", "infrared", "ndvi", "threshold"].includes(this.mode)) this.left = "cir16";
      this.images = {}; this.raw = {}; this.records = {}; this.provenance = {}; this.sequence = 0; this.started = false;
      this.root = this.attachShadow({mode: "open"});
      const style = node("style", STYLE), header = node("header", this.getAttribute("label") || "OpenGeo Studio · NOAA imagery lab");
      style.textContent += `.map{position:relative;overflow:hidden}.map canvas{cursor:grab}.map.panning canvas{cursor:grabbing}.map.inspect canvas{cursor:crosshair}.swipe-handle{position:absolute;top:0;bottom:0;width:32px;transform:translateX(-50%);padding:0;border:0;border-radius:0;background:transparent;cursor:ew-resize;touch-action:none;z-index:1}.swipe-handle:before{content:"";position:absolute;top:0;bottom:0;left:15px;width:2px;background:white;box-shadow:0 0 3px #000}.swipe-handle:after{content:"↔";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:42px;height:42px;border:2px solid white;border-radius:50%;background:#203d50;color:white;font-size:24px;box-shadow:0 1px 5px #000}.swipe-handle:focus-visible:after{outline:3px solid #76c8ff;outline-offset:3px}`;
      this.status = node("p", "Ready. Load this map to request imagery directly from NOAA. No archived imagery is used."); this.status.className = "info status"; this.status.setAttribute("role", "status");
      this.controls = node("div"); this.controls.className = "controls";
      this.loadButton = this.button("Load NOAA map", () => {this.started = true; this.refresh();});
      this.button("−", () => this.zoom(2)).setAttribute("aria-label", "Zoom out");
      this.button("+", () => this.zoom(.5)).setAttribute("aria-label", "Zoom in");
      this.button("Reset location", () => {this.center = project(-72.0923688, 41.3570701); this.span = analytic(this.mode) ? 128 : 2400; this.schedule();});
      this.visible = node("input"); this.visible.type = "checkbox"; this.visible.checked = true;
      this.label("Show imagery", this.visible); this.visible.onchange = () => this.draw();
      this.opacity = this.range("Opacity", 0, 1, .05, 1, () => this.draw());
      this.inspectEnabled = this.label("Inspect pixels", node("input")); this.inspectEnabled.type = "checkbox";
      this.inspectEnabled.onchange = () => {this.map.classList.toggle("inspect", this.inspectEnabled.checked); this.inspector.classList.toggle("hidden", !this.inspectEnabled.checked);};
      const choices = this.mode === "spectral" ? ["rgb8", "rgb16", "cir8", "cir16"] : ["cir8", "cir16"];
      const comparison = ["spectral", "depth"].includes(this.mode);
      if (this.mode !== "difference") this.select(comparison ? "Left image" : "Input", choices.map(key => [key, SOURCES[key].title]), this.left, value => {this.left = value; this.schedule();});
      if (comparison) {
        this.select("Right image", choices.map(key => [key, SOURCES[key].title]), this.right, value => {this.right = value; this.schedule();});
        this.swipe = this.range("Swipe", 0, 1, .01, .5, () => this.draw());
      }
      if (this.mode === "stretch") {
        this.stretch = "percentile"; this.gamma = 1;
        this.select("Stretch", [["minmax", "Minimum–maximum"], ["percentile", "2–98% clip"], ["stddev", "Mean ±2 SD"]], this.stretch, value => {this.stretch = value; this.schedule();});
        this.range("Gamma", .25, 3, .05, 1, value => {this.gamma = Number(value); this.schedule();});
      }
      if (this.mode === "infrared") this.select("Display", [["cir", "CIR composite"], ["nir", "NIR grayscale"], ["rgb", "Natural color RGB"]], "nir", value => {this.infrared = value; this.schedule();});
      this.infrared = "nir";
      this.threshold = .25; this.tolerance = .05;
      if (this.mode === "threshold") this.range("NDVI threshold", -1, 1, .01, this.threshold, v => {this.threshold = Number(v); this.draw();});
      if (this.mode === "difference") this.range("Difference tolerance ±", 0, 1, .01, this.tolerance, v => {this.tolerance = Number(v); this.draw();});
      this.canvas = node("canvas"); this.canvas.width = 800; this.canvas.height = 400; this.canvas.tabIndex = 0;
      this.canvas.setAttribute("aria-label", "Interactive NOAA map. Drag or use arrow keys to pan; scroll, pinch, double-click or plus and minus to zoom. Enable Inspect pixels to inspect a point.");
      this.map = node("div"); this.map.className = "map"; this.map.append(this.canvas);
      if (this.swipe) {
        this.swipeHandle = node("button"); this.swipeHandle.className = "swipe-handle";
        this.swipeHandle.setAttribute("role", "slider"); this.swipeHandle.setAttribute("aria-label", "Imagery comparison divider");
        this.swipeHandle.setAttribute("aria-valuemin", "0"); this.swipeHandle.setAttribute("aria-valuemax", "100");
        this.swipeHandle.setAttribute("aria-orientation", "horizontal"); this.map.append(this.swipeHandle);
      }
      this.caption = node("p"); this.caption.className = "info";
      this.inspector = node("p", "Click the map to inspect NOAA source values, not display colors."); this.inspector.className = "info hidden"; this.inspector.setAttribute("role", "status");
      this.histogram = node("canvas"); this.histogram.width = 800; this.histogram.height = 95; this.histogram.className = "hist hidden";
      this.histogram.setAttribute("aria-label", "Source-value histogram; numerical summary follows");
      this.stats = node("p"); this.stats.className = "info";
      if (["depth", "stretch"].includes(this.mode)) this.button("Read source histograms", () => this.sourceHistograms());
      const details = node("details"); details.append(node("summary", "Source, analysis parameters & reusable embed"));
      this.receipt = node("pre"); details.append(this.receipt);
      const download = node("button", "Download figure state and provenance"); download.onclick = () => this.download(); details.append(download);
      const html = node("button", "Export interactive HTML (NOAA online)"); html.onclick = () => this.exportHtml(); details.append(html);
      const embed = node("pre"); embed.textContent = `<script src="${ImageryLab.scriptUrl}" defer></script>\n<opengeo-imagery-lab autoload mode="${this.mode}" label="NOAA imagery"></opengeo-imagery-lab>`; details.append(embed);
      const links = node("p", "NOAA Office for Coastal Management · "); links.className = "info";
      for (const [label, href] of [["Acquisition & use constraints", "https://www.fisheries.noaa.gov/inport/item/48415"], ["Open in Studio", "https://studio.opengeo.tools/workspaces?project=0fa80698-eb22-44ff-9127-8a31bb479c5e"]]) {
        const a = node("a", label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; links.append(a, " · ");
      }
      this.root.append(style, header, this.controls, this.status, this.map, this.caption, this.histogram, this.stats, this.inspector, details, links);
      this.events(); this.restore(); this.draw();
      if (this.hasAttribute("autoload")) {
        this.started = true; this.autoQueued = true;
        this.status.textContent = "Loading NOAA imagery automatically; waiting for a request slot…";
        this.draw(); autoLoads.push(this); queueMicrotask(drainAutoLoads);
      }
    }
    disconnectedCallback() {this.autoQueued = false; ++this.sequence; this.controller?.abort(); clearTimeout(this.timer); this.clearImages(); this.raw = {}; this.analysisFrame = null; this.renderBounds = null;}
    clearImages() {Object.values(this.images).forEach(image => image.close?.()); this.images = {};}
    button(text, action) {const b = node("button", text); b.onclick = action; this.controls.append(b); return b;}
    label(text, input) {const l = node("label", text + " "); input.setAttribute("aria-label", text); l.append(input); this.controls.append(l); return input;}
    range(text, min, max, step, value, action) {const i = node("input"); Object.assign(i, {type: "range", min, max, step, value}); this.label(text, i); i.oninput = () => action(i.value); return i;}
    select(text, choices, value, action) {const s = node("select"); for (const [v, label] of choices) {const o = node("option", label); o.value = v; s.append(o);} s.value = value; this.label(text, s); s.onchange = () => action(s.value); return s;}
    bounds() {return [this.center[0] - this.span / 2, this.center[1] - this.span / 4, this.center[0] + this.span / 2, this.center[1] + this.span / 4];}
    events() {
      let start, pinch, pinched = false;
      const pointers = new Map();
      const distance = () => {const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y);};
      const resetDrag = () => {start = null; this.canvas.style.transform = ""; this.map.classList.remove("panning");};
      this.canvas.onpointerdown = e => {
        if (e.button !== 0) return;
        this.interacting = true; this.pauseRefresh();
        pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); this.canvas.setPointerCapture(e.pointerId);
        if (pointers.size === 2) {pinch = {distance: distance(), span: this.span}; pinched = true; resetDrag();}
        else if (pointers.size === 1) {pinched = false; start = {x: e.clientX, y: e.clientY, center: [...this.center]};}
      };
      this.canvas.onpointermove = e => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
        if (pinch && pointers.size === 2) {const scale = distance() / Math.max(1, pinch.distance); this.canvas.style.transform = `scale(${scale})`; return;}
        if (!start || pinched) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) >= 6) {this.map.classList.add("panning"); this.canvas.style.transform = `translate(${dx}px,${dy}px)`;}
      };
      this.canvas.onpointerup = e => {
        pointers.delete(e.pointerId);
        this.interacting = pointers.size > 0;
        if (pinch) {const match = this.canvas.style.transform.match(/scale\(([^)]+)\)/); this.span = clamp(pinch.span / Number(match?.[1] || 1), 32, 50000); pinch = null; resetDrag(); this.schedule(); return;}
        if (!start || pinched) {resetDrag(); if (!this.interacting && this.stale) this.schedule(); return;}
        const rect = this.canvas.getBoundingClientRect(), dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) < 6) {if (this.inspectEnabled.checked) {const b = this.bounds(); this.inspect(b[0] + (e.clientX - rect.left) / rect.width * this.span, b[3] - (e.clientY - rect.top) / rect.height * this.span / 2);}}
        else {this.center = [start.center[0] - dx / rect.width * this.span, start.center[1] + dy / rect.height * this.span / 2]; this.schedule();}
        resetDrag();
        if (!this.interacting && this.stale) this.schedule();
      };
      this.canvas.onpointercancel = e => {pointers.delete(e.pointerId); this.interacting = pointers.size > 0; pinch = null; pinched = true; resetDrag(); if (!this.interacting && this.stale) this.schedule();};
      this.canvas.addEventListener("wheel", e => {e.preventDefault(); this.zoomAt(Math.exp(clamp(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1), -240, 240) * .002), e);}, {passive: false});
      this.canvas.ondblclick = e => {e.preventDefault(); this.zoomAt(e.shiftKey ? 2 : .5, e);};
      if (this.swipeHandle) {
        const move = e => {const r = this.map.getBoundingClientRect(); this.swipe.value = clamp((e.clientX - r.left) / r.width, 0, 1); this.draw();};
        this.swipeHandle.onpointerdown = e => {if (e.button !== 0) return; e.preventDefault(); this.swipeHandle.setPointerCapture(e.pointerId); move(e);};
        this.swipeHandle.onpointermove = e => {if (this.swipeHandle.hasPointerCapture(e.pointerId)) move(e);};
        this.swipeHandle.onpointerup = e => {if (this.swipeHandle.hasPointerCapture(e.pointerId)) {move(e); this.swipeHandle.releasePointerCapture(e.pointerId);}};
        this.swipeHandle.onkeydown = e => {const steps = {ArrowLeft: -.02, ArrowRight: .02, Home: -1, End: 1}; if (e.key in steps) {e.preventDefault(); this.swipe.value = clamp(Number(this.swipe.value) + steps[e.key], 0, 1); this.draw();}};
      }
      this.canvas.onkeydown = e => {
        const moves = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]};
        if (moves[e.key]) {e.preventDefault(); this.center = this.center.map((v, i) => v + moves[e.key][i] * this.span / 4); this.schedule();}
        if (["+", "=", "-"].includes(e.key)) {e.preventDefault(); this.zoom(e.key === "-" ? 2 : .5);}
      };
    }
    zoom(factor) {this.span = clamp(this.span * factor, 32, 50000); this.schedule();}
    zoomAt(factor, event) {
      const r = this.map.getBoundingClientRect(), next = clamp(this.span * factor, 32, 50000);
      this.center[0] += ((event.clientX - r.left) / r.width - .5) * (this.span - next);
      this.center[1] -= ((event.clientY - r.top) / r.height - .5) * (this.span - next) / 2;
      this.span = next; this.schedule();
    }
    pauseRefresh() {
      clearTimeout(this.timer);
      if (this.loading) this.stale = true;
      this.controller?.abort(); ++this.sequence; this.loading = false;
    }
    schedule() {
      this.pauseRefresh(); this.stale = true;
      this.histogram.classList.add("hidden"); this.stats.textContent = "";
      this.inspector.textContent = "Wait for the refreshed NOAA view before inspecting pixels.";
      this.status.textContent = this.renderBounds ? "Previous NOAA imagery retained for orientation. Updating after navigation pauses…" : "Loading the requested NOAA view…";
      this.draw();
      if (this.started && !this.autoQueued && !this.interacting) this.timer = setTimeout(() => this.refresh(), 400);
    }
    async json(key, operation, params, signal) {
      const url = endpoint(key) + "/" + operation + "?" + new URLSearchParams({...params, f: "json"});
      const r = await fetch(url, {signal, credentials: "omit"});
      if (!r.ok) throw Error(`NOAA ${operation}: HTTP ${r.status}`);
      const data = await r.json(); if (data.error) throw Error(`NOAA ${operation}: ${data.error.message}`); return {data, url};
    }
    async resolve(key, signal) {
      const params = {geometry: JSON.stringify({x: this.center[0], y: this.center[1], spatialReference: {wkid: 3857}}), geometryType: "esriGeometryPoint", returnFirstValueOnly: "false", outFields: "Name,dataset_id,Year,Resolution,Sensor", interpolation: "RSP_NearestNeighbor"};
      params.mosaicRule = JSON.stringify({where: `Mission = ${SOURCES[key].mission}`, mosaicMethod: "esriMosaicAttribute", mosaicOperation: "MT_FIRST"});
      const {data, url} = await this.json(key, "getSamples", params, signal);
      const record = data.samples?.find(s => Number(s.attributes?.Year) === 2004 && Number(s.attributes?.Resolution) === .5 && /^18T/.test(s.attributes?.Name ?? ""));
      if (!record) throw Error(`No matching 2004, 0.5 m Connecticut source at the center for ${SOURCES[key].title}. Pan back into coverage.`);
      return {...record, observationUrl: url};
    }
    async refresh() {
      if (this.interacting) {this.stale = true; return;}
      clearTimeout(this.timer); this.autoQueued = false; this.started = true;
      this.controller?.abort(); this.controller = new AbortController(); const controller = this.controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), sequence = ++this.sequence;
      this.stale = true; this.loading = true;
      this.stats.textContent = ""; this.histogram.classList.add("hidden"); this.draw();
      this.loadButton.textContent = "Refresh NOAA map"; this.status.textContent = "Checking NOAA contributing rasters…";
      const acquired = [];
      try {
        const keys = this.mode === "difference" ? ["cir8", "cir16"] : ["spectral", "depth"].includes(this.mode) ? [...new Set([this.left, this.right])] : [this.mode === "infrared" && this.infrared === "rgb" ? "rgb8" : this.left];
        const records = await Promise.all(keys.map(async key => [key, await this.resolve(key, signal)]));
        if (sequence !== this.sequence) return;
        const nextRecords = Object.fromEntries(records);
        if (records.length === 2 && records[0][1].attributes.Name !== records[1][1].attributes.Name) throw Error("Contributing tile names differ: comparison stopped. Choose an overlapping area.");
        this.status.textContent = analytic(this.mode) ? "Reading bounded, uncompressed source-value TIFFs from NOAA…" : "Rendering matched imagery directly from NOAA…";
        const bounds = this.bounds(), requests = [];
        const results = await Promise.all(keys.map(async key => {
          const raw = analytic(this.mode), record = nextRecords[key];
          const params = {bbox: bounds.join(","), bboxSR: "3857", imageSR: "3857", size: raw ? `${GRID},${GRID}` : "800,400", adjustAspectRatio: "false", format: raw ? "tiff" : "png32", f: "image", interpolation: "RSP_NearestNeighbor", mosaicRule: JSON.stringify(rule(record.rasterId)), noData: "0", noDataInterpretation: "esriNoDataMatchAll"};
          if (raw) {params.compression = "None"; params.pixelType = SOURCES[key].bits === 16 ? "U16" : "U8"; params.renderingRule = JSON.stringify({rasterFunction: "None"});}
          else if (this.mode === "stretch") params.renderingRule = JSON.stringify({rasterFunction: "Stretch", rasterFunctionArguments: {StretchType: {minmax: 5, percentile: 6, stddev: 3}[this.stretch], MinPercent: 2, MaxPercent: 2, NumberOfStandardDeviations: 2, Gamma: [this.gamma, this.gamma, this.gamma], DRA: true}});
          if (this.mode === "infrared" && this.infrared === "nir") params.bandIds = "0";
          const url = endpoint(key) + "/exportImage?" + new URLSearchParams(params);
          const r = await fetch(url, {signal, credentials: "omit"});
          if (!r.ok) throw Error(`NOAA export: HTTP ${r.status}`);
          const buffer = await r.arrayBuffer();
          if (buffer.byteLength > 4_000_000) throw Error("NOAA export exceeded the bounded preview size");
          const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(b => b.toString(16).padStart(2, "0")).join("");
          requests.push({key, url, sha256: checksum, bytes: buffer.byteLength, parameters: params});
          const image = raw ? decodeTiff(buffer) : await createImageBitmap(new Blob([buffer], {type: "image/png"}));
          if (sequence !== this.sequence || signal.aborted) {image.close?.(); throw Error("Superseded NOAA view");}
          acquired.push(image); return [key, image];
        }));
        if (sequence !== this.sequence) {for (const [, image] of results) image.close?.(); return;}
        const next = Object.fromEntries(results);
        if (this.mode === "difference" && !paired(next.cir8, next.cir16)) throw Error("Analytical grids do not match; difference calculation stopped");
        this.clearImages(); this.images = analytic(this.mode) ? {} : next; this.raw = analytic(this.mode) ? next : {};
        acquired.length = 0; this.records = nextRecords; this.renderBounds = bounds; this.displayKeys = this.swipe ? [this.left, this.right] : keys;
        this.stale = false; this.loading = false;
        this.provenance = {schema: "opengeo.imagery-figure.1", observedAt: new Date().toISOString(), mode: this.mode, sourcePolicy: "NOAA-only; no archive fallback", bounds, crs: "EPSG:3857", sourceRecords: this.records, requests, analyticalGrid: analytic(this.mode) ? [GRID, GRID] : null, mask: "All-zero source pixels and zero NDVI denominators excluded; paired differences use intersection", interpretation: "Processed digital-number ratio, not calibrated reflectance; product differences include processing and nearest-neighbor resampling"};
        this.status.textContent = `NOAA live · checked ${new Date().toLocaleTimeString()} · ${records.map(([k, r]) => `${SOURCES[k].title}: ${r.attributes.Name}`).join(" / ")} · archives not used`;
        this.draw();
      } catch (error) {
        acquired.forEach(image => image.close?.());
        if (controller.signal.aborted || sequence !== this.sequence) return;
        controller.abort(); this.loading = false; this.stale = true; this.draw();
        this.status.textContent = `NOAA request unavailable: ${error.message}. ${this.renderBounds ? "Previous NOAA view remains visible for orientation, not current analysis. " : ""}Retry with Refresh NOAA map. No archived imagery was substituted.`;
      }
    }
    draw() {
      if (!this.canvas) return;
      if (this.swipeHandle) {this.swipeHandle.style.left = `${Number(this.swipe.value) * 100}%`; this.swipeHandle.setAttribute("aria-valuenow", String(Math.round(Number(this.swipe.value) * 100))); this.swipeHandle.classList.toggle("hidden", !this.visible.checked);}
      const c = this.canvas.getContext("2d"), w = this.canvas.width, h = this.canvas.height;
      c.clearRect(0, 0, w, h); c.fillStyle = "#23343d"; c.fillRect(0, 0, w, h);
      c.strokeStyle = "#40515b"; for (let x = 0; x < w; x += 80) {c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();}
      for (let y = 0; y < h; y += 80) {c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();}
      const [lon, lat] = unproject(...this.center);
      this.caption.textContent = `${lon.toFixed(5)}, ${lat.toFixed(5)} · view ${Math.round(this.span * Math.cos(lat * Math.PI / 180))} m wide (approx.) · drag to pan; scroll, pinch, double-click or +/− to zoom.${this.swipe ? " Drag the ↔ divider to compare." : ""} Transparent areas are outside the locked source tile or NoData.`;
      this.receipt.textContent = JSON.stringify(this.figureRecord(), null, 2);
      if (!this.visible.checked) {this.caption.textContent += " Imagery hidden."; return;}
      if (this.stale && this.renderBounds) this.caption.textContent += " Previous NOAA view — waiting for refreshed coverage.";
      c.globalAlpha = Number(this.opacity.value);
      const b = this.bounds(), old = this.renderBounds ?? b;
      const target = [(old[0] - b[0]) / this.span * w, (b[3] - old[3]) / (this.span / 2) * h, (old[2] - old[0]) / this.span * w, (old[3] - old[1]) / (this.span / 2) * h];
      if (analytic(this.mode) && Object.keys(this.raw).length) {
        if (this.stale) {if (this.analysisFrame) c.drawImage(this.analysisFrame, ...target);}
        else {this.analysisFrame = node("canvas"); this.analysisFrame.width = w; this.analysisFrame.height = h; this.drawAnalysis(this.analysisFrame.getContext("2d")); c.drawImage(this.analysisFrame, ...target);}
      }
      else {
        const keys = this.displayKeys ?? []; if (this.images[keys[0]]) c.drawImage(this.images[keys[0]], ...target);
        if (this.images[keys[1]]) {const cut = w * Number(this.swipe?.value ?? .5); c.save(); c.beginPath(); c.rect(cut, 0, w - cut, h); c.clip(); c.drawImage(this.images[keys[1]], ...target); c.restore(); c.fillStyle = "#fff"; c.fillRect(cut - 1, 0, 2, h);}
        if (keys.length) {c.globalAlpha = 1; c.fillStyle = "#102531"; c.fillRect(0, 0, w, 27); c.fillStyle = "#fff"; c.font = "16px system-ui"; c.fillText(keys.map(k => SOURCES[k].title).join("   ← swipe →   "), 12, 19);}
      }
      c.globalAlpha = 1;
      if (!this.renderBounds) {c.fillStyle = "#e6edf3"; c.font = "20px system-ui"; c.fillText(this.started ? "Loading NOAA imagery…" : "Load NOAA map to begin", 24, h / 2);}
      if (!this.stale) this.renderState = JSON.parse(JSON.stringify(this.state()));
      this.receipt.textContent = JSON.stringify(this.figureRecord(), null, 2);
    }
    figureRecord() {return {...this.provenance, controls: this.stale ? this.renderState ?? this.state() : this.state(), requestedControls: this.state(), displayStatus: !this.renderBounds ? "No NOAA observation yet" : this.stale ? "Previous NOAA observation; requested view not yet refreshed" : "Current NOAA observation"};}
    drawAnalysis(context) {
      const a = this.raw[this.mode === "difference" ? "cir8" : this.left]; if (!a) return;
      const b = this.raw.cir16, image = new ImageData(GRID, GRID), values = [];
      let changed = 0, absSum = 0, maxAbs = 0, within = 0;
      for (let i = 0; i < GRID * GRID; i++) {
        const valid = raster => raster && [0, 1, 2].some(band => raster.data[i * 3 + band] !== 0);
        if (!valid(a) || (this.mode === "difference" && !valid(b))) continue;
        let value = ndvi(a.data[i * 3], a.data[i * 3 + 1]);
        if (this.mode === "difference") value = ndvi(b.data[i * 3], b.data[i * 3 + 1]) - value;
        if (!Number.isFinite(value)) continue;
        values.push(value); absSum += Math.abs(value); maxAbs = Math.max(maxAbs, Math.abs(value)); if (Math.abs(value) <= this.tolerance) within++;
        const target = i * 4, above = value >= this.threshold; if (above) changed++;
        let color;
        if (this.mode === "threshold") color = above ? [70, 220, 130] : [70, 80, 95];
        else if (this.mode === "difference") {const k = Math.min(Math.abs(value) / .25, 1); color = value < 0 ? [230 - 180 * k, 230 - 100 * k, 230] : [230, 230 - 140 * k, 230 - 180 * k];}
        else {const k = (clamp(value, -1, 1) + 1) / 2; color = [175 * (1 - k), 75 + 140 * k, 130 * (1 - k)];}
        image.data.set([...color.map(Math.round), 255], target);
      }
      const temp = document.createElement("canvas"); temp.width = temp.height = GRID; temp.getContext("2d").putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false; context.drawImage(temp, 0, 0, 800, 400);
      const latitude = unproject(...this.center)[1] * Math.PI / 180, area = a.scale[0] * a.scale[1] * Math.cos(latitude) ** 2;
      const summary = {validPixels: values.length, gridPixels: GRID * GRID, threshold: this.threshold, classifiedPixels: changed, approximateClassifiedAreaM2: changed * area, meanAbsoluteDifference: values.length ? absSum / values.length : null, maximumAbsoluteDifference: values.length ? maxAbs : null, tolerance: this.tolerance, withinTolerancePercent: values.length ? within / values.length * 100 : null};
      this.provenance.statistics = summary;
      const pct = values.length ? (changed / values.length * 100).toFixed(1) : "0";
      this.stats.textContent = `${values.length} valid pixels / ${GRID * GRID}; nearest-neighbor common EPSG:3857 grid, ${a.scale[0].toFixed(2)} × ${a.scale[1].toFixed(2)} map m/pixel (not native-resolution unless matched). ` + (this.mode === "difference" ? `NDVI16 − NDVI8: mean absolute ${summary.meanAbsoluteDifference?.toFixed(4) ?? "n/a"}, max absolute ${summary.maximumAbsoluteDifference?.toFixed(4) ?? "n/a"}; ${summary.withinTolerancePercent?.toFixed(1) ?? "0"}% within ±${this.tolerance}. Blue negative / white zero / red positive; color saturates at ±0.25.` : this.mode === "threshold" ? `NDVI ≥ ${this.threshold}: ${changed} pixels, ${pct}% of valid AOI, approximately ${(changed * area).toFixed(1)} m². Not a species classification.` : "NDVI color range is fixed −1 (purple) to +1 (green). Calculated from source TIFF values, not the PNG.");
      this.plot(values, this.mode === "difference" ? [-2, 2] : [-1, 1]);
    }
    plot(values, range) {
      this.histogram.classList.remove("hidden"); const c = this.histogram.getContext("2d"), counts = Array(64).fill(0);
      for (const v of values) counts[clamp(Math.floor((v - range[0]) / (range[1] - range[0]) * 64), 0, 63)]++;
      c.clearRect(0, 0, 800, 95); c.fillStyle = "#83d1bb"; const max = Math.max(1, ...counts);
      counts.forEach((n, i) => c.fillRect(i * 12.5, 75 - n / max * 70, 11, n / max * 70));
      c.fillStyle = "#fff"; c.font = "12px system-ui"; c.fillText(`${range[0]}   ← distribution →   ${range[1]} · ${values.length} values`, 8, 91);
    }
    async inspect(x, y) {
      if (!this.started) return;
      if (this.stale) {this.inspector.textContent = "Wait for the refreshed NOAA view before inspecting pixels."; return;}
      const keys = Object.keys(this.records); if (!keys.length) return;
      const sequence = this.sequence;
      this.inspector.textContent = "Reading source pixels from NOAA…";
      try {
        const values = await Promise.all(keys.map(async key => {
          const {data} = await this.json(key, "getSamples", {geometry: JSON.stringify({x, y, spatialReference: {wkid: 3857}}), geometryType: "esriGeometryPoint", returnFirstValueOnly: "true", outFields: "Name,dataset_id,Year,Resolution,Sensor", interpolation: "RSP_NearestNeighbor", mosaicRule: JSON.stringify(rule(this.records[key].rasterId))}, AbortSignal.timeout(20000));
          const sample = data.samples?.[0]; if (!sample) return `${SOURCES[key].title}: NoData`;
          const bands = sample.value.split(/[,\s]+/).map(Number), index = key.startsWith("cir") ? ndvi(bands[0], bands[1]) : NaN;
          return `${SOURCES[key].title} ${key.startsWith("cir") ? "NIR / red / green" : "red / green / blue"}: ${sample.value}; ${Number.isFinite(index) ? `NDVI ${index.toFixed(4)}; ` : ""}${sample.attributes.Name}, ${sample.attributes.Year}, ${sample.attributes.Resolution} m, raster ${sample.rasterId}`;
        }));
        if (sequence === this.sequence) this.inspector.textContent = `${unproject(x, y).map(n => n.toFixed(6)).join(", ")} · ${values.join(" | ")}`;
      } catch (error) {if (sequence === this.sequence) this.inspector.textContent = `NOAA pixel inspection unavailable: ${error.message}. Archives not used.`;}
    }
    async sourceHistograms() {
      if (this.stale) {this.stats.textContent = "Wait for the refreshed NOAA view before reading histograms."; return;}
      const sequence = this.sequence, signal = this.controller?.signal;
      if (!Object.keys(this.records).length || signal?.aborted) {this.stats.textContent = "Load NOAA imagery first."; return;}
      this.stats.textContent = "Reading source-band histograms from NOAA, without the display stretch…";
      try {
        const b = this.bounds(), summaries = [];
        for (const key of Object.keys(this.records)) {
          const parameters = {bbox: b.join(","), bboxSR: "3857", imageSR: "3857", size: `${GRID},${GRID}`, adjustAspectRatio: "false", format: "tiff", compression: "None", pixelType: SOURCES[key].bits === 16 ? "U16" : "U8", f: "image", renderingRule: JSON.stringify({rasterFunction: "None"}), interpolation: "RSP_NearestNeighbor", mosaicRule: JSON.stringify(rule(this.records[key].rasterId)), noData: "0", noDataInterpretation: "esriNoDataMatchAll"};
          const url = endpoint(key) + "/exportImage?" + new URLSearchParams(parameters), response = await fetch(url, {signal, credentials: "omit"});
          if (!response.ok) throw Error(`NOAA histogram input HTTP ${response.status}`);
          const bytes = await response.arrayBuffer(), raster = decodeTiff(bytes);
          const histograms = Array.from({length: 3}, (_, band) => {
            const values = []; for (let i = 0; i < GRID * GRID; i++) if ([0, 1, 2].some(k => raster.data[i * 3 + k] !== 0)) values.push(raster.data[i * 3 + band]);
            const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 0, counts = Array(64).fill(0);
            for (const value of values) counts[Math.min(63, Math.floor((value - min) / (max - min || 1) * 64))]++;
            return {min, max, counts};
          });
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
          summaries.push({source: key, url, parameters, sha256, bytes: bytes.byteLength, grid: [GRID, GRID], scale: raster.scale, tie: raster.tie, histograms});
        }
        if (sequence !== this.sequence) return;
        this.provenance.sourceHistograms = summaries;
        this.draw();
        this.stats.textContent = summaries.map(s => `${SOURCES[s.source].title}: ` + s.histograms.map((h, i) => `band ${i + 1} range ${h.min}–${h.max}, ${h.counts.reduce((a, b) => a + b, 0)} sampled values`).join("; ")).join(" | ") + ". Histograms use bounded 128×128 raw NOAA TIFFs, not display colors or a full-resolution census; complete bins and request checksums are in the figure download.";
        this.histogram.classList.remove("hidden"); const c = this.histogram.getContext("2d"); c.clearRect(0, 0, 800, 95);
        summaries.forEach((s, k) => {const counts = s.histograms[0].counts, max = Math.max(1, ...counts); c.fillStyle = k ? "#ff8bc5" : "#83d1bb"; c.globalAlpha = .6; counts.forEach((n, i) => c.fillRect(i / counts.length * 800, 75 - n / max * 70, Math.max(1, 800 / counts.length), n / max * 70));});
        c.globalAlpha = 1; c.fillStyle = "#fff"; c.font = "12px system-ui"; c.fillText("NIR histogram per source range: first input teal, second pink. Ranges differ; see numerical summary.", 8, 91);
      } catch (error) {if (sequence === this.sequence) this.stats.textContent = `NOAA histogram unavailable: ${error.message}. No display-color histogram substituted.`;}
    }
    state() {return {mode: this.mode, center: this.center, span: this.span, left: this.left, right: this.right, infrared: this.infrared, stretch: this.stretch, gamma: this.gamma, threshold: this.threshold, tolerance: this.tolerance, opacity: Number(this.opacity.value), visible: this.visible.checked, swipe: Number(this.swipe?.value ?? .5)};}
    restore() {
      try {
        const state = JSON.parse(this.getAttribute("state") || "null"); if (!state || state.mode !== this.mode) return;
        if (Array.isArray(state.center) && state.center.length === 2 && state.center.every(v => Number.isFinite(v) && Math.abs(v) < 20037508)) this.center = state.center;
        if (Number.isFinite(state.span)) this.span = clamp(state.span, 32, 50000);
        for (const key of ["left", "right"]) if (SOURCES[state[key]]) this[key] = state[key];
        if (["minmax", "percentile", "stddev"].includes(state.stretch)) this.stretch = state.stretch;
        if (["cir", "nir", "rgb"].includes(state.infrared)) this.infrared = state.infrared;
        if (Number.isFinite(state.gamma)) this.gamma = clamp(state.gamma, .25, 3);
        if (Number.isFinite(state.threshold)) this.threshold = clamp(state.threshold, -1, 1);
        if (Number.isFinite(state.tolerance)) this.tolerance = clamp(state.tolerance, 0, 1);
        this.opacity.value = String(clamp(Number(state.opacity) || 0, 0, 1)); this.visible.checked = state.visible !== false;
        if (this.swipe) this.swipe.value = String(clamp(Number(state.swipe) || 0, 0, 1));
        for (const label of this.controls.querySelectorAll("label")) {
          const input = label.querySelector("select,input[type=range]"); if (!input) continue;
          const key = {Input: "left", "Left image": "left", "Right image": "right", Display: "infrared", Stretch: "stretch", Gamma: "gamma", "NDVI threshold": "threshold", "Difference tolerance ±": "tolerance"}[label.firstChild.textContent.trim()];
          if (key && this[key] !== undefined) input.value = String(this[key]);
        }
      } catch {this.status.textContent = "Saved state is invalid; using the default NOAA view.";}
    }
    exportHtml() {
      const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
      const code = `(${installImageryLab.toString()})();`.replaceAll("<" + "/script", "<\\/script");
      const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenGeo Studio NOAA map</title><body><h1>NOAA imagery · exported from OpenGeo Studio</h1><p>Interactive controls are included. Live data requires NOAA and an internet connection. No archived imagery or credentials are bundled.</p>' +
        `<opengeo-imagery-lab${this.hasAttribute("autoload") ? " autoload" : ""} mode="${this.mode}" state="${escape(JSON.stringify(this.state()))}"></opengeo-imagery-lab>` +
        '<details><summary>Original observation and provenance (not a promise the live source is unchanged)</summary><pre>' + escape(this.receipt.textContent) + '</pre></details><script>' + code + '<' + '/script></body></html>';
      const url = URL.createObjectURL(new Blob([html], {type: "text/html"})), a = node("a"); a.href = url; a.download = `noaa-${this.mode}-interactive.html`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    download() {
      const blob = new Blob([this.receipt.textContent], {type: "application/json"}), url = URL.createObjectURL(blob), a = node("a");
      a.href = url; a.download = `noaa-${this.mode}-figure.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  ImageryLab.scriptUrl = document.currentScript?.src || "";
  // Exposed pure helpers support focused tests without a network or a map server.
  globalThis.OpenGeoImageryLab = Object.freeze({decodeTiff, paired, ndvi, project, unproject});
  if (!customElements.get("opengeo-imagery-lab")) customElements.define("opengeo-imagery-lab", ImageryLab);
}
installImageryLab();
