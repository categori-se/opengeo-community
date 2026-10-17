import {definitionWithPrintLayouts, mmToPx, newProjectPrintLayout, printLayerPresentation,
  projectPrintLayouts, standardPageSizes, validateProjectPrintLayouts} from "../lib/printLayouts.js";
import {mapGraticule} from "../lib/mapGraticule.js";
import {graduatedLegendEntries} from "../lib/thematicStyle.js";
import {canonicalJson} from "../lib/artifactCanonicalJson.js";
import {compileFigurePrintPack} from "../lib/figurePrintPack.js";
import {ensurePointSymbolAssets, normalizePointSymbolStyle, pointSymbolPreviewSvg} from "../lib/pointSymbols.js";

// Layout metadata is saved explicitly. Map images remain an authorized browser capture.
export function ProjectPrintEditor({state, workbench: initialWorkbench, editFrame, canSave = false, onSaved = () => {}, captureMap = capturePrintMap, persistence = "account"}) {
  const root = el("section");root.className = "project-print-studio project-print-editor";root.id = "project-print-studio";
  let mapRecord = state.selectedMap, workbench = initialWorkbench, collection, activeId, frameId;
  let dirty = false, busy = false, disposed = false, uncertain = false, guides = true;
  const captures = new Map(), undo = [], redo = [];
  const status = el("p");status.setAttribute("role", "status");
  root.append(el("h2", "Print Studio"), el("p", mapRecord.name),
    el("p", persistence === "browser"
      ? "Arrange this local Project on a paper-sized page. Capture each map frame, then print or export. Save layout keeps the settings with this browser draft; download a Project backup to keep them."
      : "Arrange the saved Project on a paper-sized page. Edit a map frame, then capture its view and styling. Save layout keeps these settings in this Project."));
  const shell = el("div");shell.className = "print-studio-shell";
  const controls = el("aside");controls.className = "print-studio-controls";
  const stage = el("div");stage.className = "print-stage";
  const mapEditor = el("details"), mapHost = el("div");mapEditor.open = true;mapEditor.append(el("summary", "Map frame · pan, zoom, Layers and styling"), mapHost);
  mapHost.append(workbench);mapHost.style.height = "480px";mapHost.style.minWidth = "0";
  shell.append(controls, stage);root.append(status, shell, mapEditor);
  try {
    collection = projectPrintLayouts(mapRecord);
    if (!collection.layouts.length) collection.layouts.push(newProjectPrintLayout(mapRecord));
    activeId = collection.layouts[0].id;frameId = collection.layouts[0].frames[0].id;
  } catch (error) {status.textContent = error.message;return root;}
  const layout = () => collection.layouts.find(item => item.id === activeId);
  const frame = () => layout().frames.find(item => item.id === frameId) ?? layout().frames[0];
  const key = item => `${activeId}:${item.id}`;
  const current = async () => !disposed && root.isConnected
    && (typeof state.adapter.organizationProvider !== "function" || await state.adapter.organizationProvider() === state.organization.id);
  root.hasUnsavedChanges = () => dirty;
  root.shouldBlockNavigation = () => dirty || busy || uncertain;
  root.checkDraft = () => {status.textContent = "Save the layout or discard its changes before leaving Print Studio.";root.scrollIntoView?.({block: "start"});return true;};
  root.dispose = () => {disposed = true;captures.clear();};
  function change(action) {
    if (busy || uncertain || disposed) return;
    const previous = structuredClone(collection);
    try {
      action();validateProjectPrintLayouts(collection, mapRecord);
      undo.push(previous);if (undo.length > 20) undo.shift();redo.length = 0;dirty = true;
      render();status.textContent = "Layout changes are unsaved.";
    } catch (error) {collection = previous;status.textContent = error.message;}
  }
  async function capture() {
    if (busy || !await current()) return;
    busy = true;render();status.textContent = "Capturing the rendered map…";
    const selected = frame(), selectedKey = key(selected), previous = structuredClone(collection);
    try {
      const context = workbench.getPrintContext?.();
      const captured = await captureMap(context, mapRecord);
      if (!await current() || key(frame()) !== selectedKey) return;
      selected.view = captured.view;selected.presentation = captured.presentation;
      validateProjectPrintLayouts(collection, mapRecord);
      undo.push(previous);redo.length = 0;captures.set(selectedKey, captured);dirty = true;
      status.textContent = `Captured ${selected.title}: ${captured.width} × ${captured.height} map pixels. Capture again after changing its map view or styling.`;
    } catch (error) {collection = previous;status.textContent = error.message;}
    finally {busy = false;if (!disposed) render();}
  }
  async function save() {
    if (busy || uncertain || !canSave || !await current()) return;
    busy = true;render();status.textContent = "Saving layout…";
    try {
      const definition = definitionWithPrintLayouts(mapRecord, collection);
      const saved = await state.adapter.updateMap(state.project.id, mapRecord.id, {expectedVersion: mapRecord.version,
        changes: {definition}, changeMessage: "Save Project print layouts"});
      if (!await current()) return;
      if (saved.id !== mapRecord.id || saved.projectId !== state.project.id || saved.version !== mapRecord.version + 1
        || canonicalJson(projectPrintLayouts(saved)) !== canonicalJson(collection)) throw Error("The saved layout response could not be confirmed. Reload its saved state before another save.");
      mapRecord = saved;dirty = false;undo.length = 0;redo.length = 0;onSaved(saved);
      status.textContent = persistence === "browser"
        ? "Layout saved with this browser draft. Download a Project backup to keep the layout and local data."
        : `Layout saved in Project revision ${saved.version}. Reopen Print Studio to reuse it.`;
    } catch (error) {
      if (error.status === 409) status.textContent = "The Project changed. Your layout draft is retained. Download its JSON before discarding and reopening the current revision.";
      else if (persistence === "browser") status.textContent = "The browser could not save the layout. Your draft is retained. Download its JSON, or discard the changes to return to the map.";
      else {uncertain = true;status.textContent = "The layout save could not be confirmed. Your draft is retained. Download its JSON and reload the saved Project before another save.";}
    } finally {busy = false;if (!disposed) render();}
  }
  function render() {
    if (disposed) return;
    const retained = new Map(collection.layouts.flatMap(item => item.frames.map(frame => [`${item.id}:${frame.id}`, frame])));
    for (const [id, captured] of captures) {
      const savedFrame = retained.get(id);
      if (!savedFrame || captured.signature !== canonicalJson({view: savedFrame.view, presentation: savedFrame.presentation})) captures.delete(id);
    }
    const selected = layout(), selectedFrame = frame();
    controls.replaceChildren();
    controls.append(selectField("Layout", selected.id, collection.layouts.map(item => [item.id, item.title]), id => {
      activeId = id;frameId = layout().frames[0].id;render();
    }), button("New layout", () => change(() => {
      const added = newProjectPrintLayout(mapRecord);collection.layouts.push(added);activeId = added.id;frameId = added.frames[0].id;
    })), inputField("Layout title", selected.title, "text", value => change(() => {layout().title = value;})));
    const paperChoices = [...new Set(standardPageSizes.map(page => page.size))].map(size => [size, size]);
    controls.append(selectField("Paper size", selected.page.size, paperChoices, size => change(() => setPaper(size, selected.page.orientation))),
      selectField("Orientation", selected.page.orientation, [["landscape", "Landscape"], ["portrait", "Portrait"]], orientation => change(() => setPaper(selected.page.size, orientation))));
    for (const [label, property] of [["Page width (mm)", "widthMm"], ["Page height (mm)", "heightMm"], ["Margin (mm)", "marginMm"]]) controls.append(inputField(label, selected.page[property], "number", value => change(() => {
      layout().page[property] = Number(value);if (property !== "marginMm") layout().page.size = "Custom";
    })));
    controls.append(selectField("Output DPI", String(selected.dpi), [["96", "96"], ["150", "150"], ["300", "300"]], value => change(() => {layout().dpi = Number(value);})),
      el("small", "DPI sets page output dimensions. Captured maps retain their original pixel detail."));
    for (const [property, label] of [["legend", "Legend"], ["northArrow", "North arrow / compass"], ["scaleBar", "Scale bar"], ["graticule", "Latitude / longitude grid"], ["sourceNotes", "Source notes"]]) {
      const control = el("label"), input = el("input");input.type = "checkbox";input.checked = selected[property];
      input.onchange = () => change(() => {layout()[property] = input.checked;});control.append(input, ` ${label}`);controls.append(control);
    }
    controls.append(inputField("Caption", selected.caption, "text", value => change(() => {layout().caption = value;})),
      selectField("Map frame", selectedFrame.id, selected.frames.map(item => [item.id, item.title]), id => {frameId = id;render();}));
    for (const [label, property] of [["Frame left (mm)", "xMm"], ["Frame top (mm)", "yMm"], ["Frame width (mm)", "widthMm"], ["Frame height (mm)", "heightMm"]]) controls.append(inputField(label, selectedFrame[property], "number", value => change(() => {frame()[property] = Number(value);})));
    controls.append(button("Edit selected map frame", () => {
      if (busy || uncertain || disposed) return;
      workbench = editFrame(structuredClone(frame()));mapHost.replaceChildren(workbench);mapEditor.open = true;
      status.textContent = "Adjust this frame's map, then Capture map frame to retain its view and styling.";
    }), button("Capture map frame", capture), button("Add inset map", () => change(() => {
      if (layout().frames.length === 2) throw Error("This layout already has an inset.");
      const main = layout().frames[0], inset = structuredClone(main);
      Object.assign(inset, {id: "inset", parentId: main.id, title: "Inset map", xMm: main.xMm + main.widthMm * 0.65,
        yMm: main.yMm + 5, widthMm: main.widthMm * 0.3, heightMm: main.heightMm * 0.3});
      inset.view.zoom = Math.max(-2, main.view.zoom - 3);layout().frames.push(inset);frameId = inset.id;
    })));
    const guide = el("label"), guideInput = el("input");guideInput.type = "checkbox";guideInput.checked = guides;
    guideInput.onchange = () => {guides = guideInput.checked;renderPage();};guide.append(guideInput, " Page margin guides");controls.append(guide);
    controls.append(button("Undo layout change", () => restore(undo, redo)), button("Redo layout change", () => restore(redo, undo)),
      button("Save layout", save, !canSave || busy || uncertain),
      button("Download layout JSON", () => download(new Blob([JSON.stringify(collection, null, 2)], {type: "application/json"}), `${safeName(selected.title)}.layout.json`)),
      button("Discard layout changes", () => {
        if (busy || uncertain) return;
        collection = projectPrintLayouts(mapRecord);if (!collection.layouts.length) collection.layouts.push(newProjectPrintLayout(mapRecord));
        activeId = collection.layouts[0].id;frameId = collection.layouts[0].frames[0].id;dirty = false;captures.clear();undo.length = 0;redo.length = 0;render();status.textContent = "Saved layout settings reopened. Capture each map frame under current access before exporting.";
      }), button("Download paper SVG", () => output("svg")), button("Download page PNG", () => output("png")),
      button("Download figure and print ZIP", () => output("pack")),
      button("Download static web page", () => output("html")), button("Print / Save PDF", () => output("print")),
      button("Export interactive web map…", () => workbench.openPublicationMapExport?.()));
    if (!canSave) controls.append(el("p", "Your current role can compose and export a temporary layout. Project edit access is required to save it."));
    if (busy) for (const control of controls.querySelectorAll("button,input,select")) control.disabled = true;
    renderPage();
  }
  function restore(from, to) {
    if (!from.length || busy || uncertain) return;to.push(structuredClone(collection));collection = from.pop();
    if (!collection.layouts.some(item => item.id === activeId)) activeId = collection.layouts[0].id;
    frameId = layout().frames[0].id;dirty = true;render();
  }
  function setPaper(size, orientation) {
    const previousPage = layout().page;
    const stored = standardPageSizes.find(page => page.size === size && page.orientation === orientation)
      ?? standardPageSizes.find(page => page.size === size);
    if (!stored) throw Error("Choose a supported paper size.");
    const custom = size === "Custom", rotated = orientation !== previousPage.orientation;
    const width = custom ? rotated ? previousPage.heightMm : previousPage.widthMm : orientation === stored.orientation ? stored.widthMm : stored.heightMm;
    const height = custom ? rotated ? previousPage.widthMm : previousPage.heightMm : orientation === stored.orientation ? stored.heightMm : stored.widthMm;
    Object.assign(layout().page, {size, orientation, widthMm: width, heightMm: height});
    for (const [index, item] of layout().frames.entries()) {
      item.widthMm = Math.min(item.widthMm, width - 2 * layout().page.marginMm - (index === 0 && layout().legend ? 55 : 0));
      item.heightMm = Math.min(item.heightMm, height - 2 * layout().page.marginMm - 30);
      item.xMm = Math.max(layout().page.marginMm, Math.min(item.xMm, width - item.widthMm));
      item.yMm = Math.max(layout().page.marginMm, Math.min(item.yMm, height - item.heightMm));
      if (index) {
        const main = layout().frames[0];item.widthMm = Math.min(item.widthMm, main.widthMm * 0.3);item.heightMm = Math.min(item.heightMm, main.heightMm * 0.3);
        item.xMm = main.xMm + main.widthMm - item.widthMm - 4;item.yMm = main.yMm + 4;
      }
    }
  }
  function renderPage() {
    try {stage.replaceChildren(printPageSvg(layout(), captures, activeId, {guides}));}
    catch (error) {stage.replaceChildren(el("p", error.message));}
  }
  async function output(format) {
    if (busy || !await current()) return;
    busy = true;render();
    try {
      const selected = structuredClone(layout());validateProjectPrintLayouts(collection, mapRecord);
      const activeCapture = captures.get(key(frame())), currentLayers = workbench.getPrintContext?.()?.layers;
      const displays = layers => canonicalJson(layers.filter(layer => layer.managedDisplayId).map(layer => [layer.layerId, layer.managedDisplayId]));
      if (activeCapture && currentLayers && displays(activeCapture.presentation) !== displays(currentLayers)) {
        captures.delete(key(frame()));render();
        throw Error("The map's tiled display selection changed. Capture this map frame again before exporting.");
      }
      if (selected.frames.some(item => !captures.has(key(item)))) throw Error("Capture every map frame before exporting this layout.");
      const svg = printPageSvg(selected, captures, activeId), serialized = new root.ownerDocument.defaultView.XMLSerializer().serializeToString(svg);
      const name = safeName(selected.title);
      if (format === "svg") download(new Blob([serialized], {type: "image/svg+xml"}), `${name}.svg`);
      else if (format === "pack") {
        status.textContent = "Preparing page images, paper PDF and figure metadata…";
        const page = await pageImages(serialized, selected);
        if (!await current()) return;
        const {blob} = await compileFigurePrintPack({layout: selected, layoutId: activeId, captures: new Map(captures),
          svg: serialized, html: paperHtml(selected, serialized), ...page});
        if (!await current()) return;
        download(blob, `${name}.figure-print.zip`);
      }
      else if (format === "html" || format === "print") {
        const html = paperHtml(selected, serialized);
        if (format === "html") download(new Blob([html], {type: "text/html"}), `${name}.html`);
        else {
          const frame = el("iframe");frame.title = "Print layout";frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px";
          frame.onload = () => {frame.contentWindow.focus();frame.contentWindow.print();};frame.srcdoc = html;root.append(frame);
          frame.contentWindow?.addEventListener("afterprint", () => frame.remove(), {once: true});
        }
      } else {
        const blob = await pagePng(serialized, selected);if (!await current()) return;download(blob, `${name}.png`);
      }
      status.textContent = "Page output prepared from the captured map frames. Layout settings and source data are unchanged.";
    } catch (error) {status.textContent = error.message;}
    finally {busy = false;if (!disposed) render();}
  }
  render();status.textContent = "Capture each map frame to compose this page. Opening Print Studio does not save a layout or start a render job.";
  return root;
}

export async function capturePrintMap(context, mapRecord) {
  const map = context?.map;
  if (context?.renderer !== "maplibre" || !context.ready || !map?.isStyleLoaded?.() || map.areTilesLoaded?.() === false || map.isMoving?.()) throw Error("Wait for the MapLibre map and its visible Layers and Styles to finish loading and moving before capture.");
  const canvas = map.getCanvas(), width = canvas.width, height = canvas.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 20_000_000) throw Error("Map capture exceeds its 20 megapixel limit.");
  const captured = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {map.off?.("render", capture);reject(Error("The map did not produce a capture frame. Try Capture again after it is ready."));}, 3000);
    function capture() {
      clearTimeout(timer);
      try {
        if (map.isMoving?.() || !map.isStyleLoaded() || map.areTilesLoaded?.() === false) throw Error("The map changed while capturing. Wait for it to settle, then capture again.");
        resolve(collectPrintSnapshot(context, mapRecord, canvas));
      } catch (error) {reject(error);}
    }
    map.once("render", capture);map.triggerRepaint();
  });
  await Promise.all(captured.legend.filter(row => row.pointStyle).map(row => ensurePointSymbolAssets(row.pointStyle)));
  const bytes = Uint8Array.from(atob(captured.dataUrl.split(",")[1]), char => char.charCodeAt(0));
  captured.imageSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  return captured;
}

function collectPrintSnapshot(context, mapRecord, canvas) {
  const map = context.map, width = canvas.width, height = canvas.height;
  const center = map.getCenter(), view = {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
  const cssWidth = canvas.clientWidth || width, cssHeight = canvas.clientHeight || height;
  const projection = map.getProjection?.()?.type ?? context.project?.projection ?? "mercator";
  const flat = view.pitch === 0 && projection === "mercator" && (context.project?.spatialBody?.id ?? "earth") === "earth";
  let dataUrl;
  try {dataUrl = canvas.toDataURL("image/png");} catch {throw Error("This map contains imagery that the browser cannot export. Its sources and access remain unchanged.");}
  if (!/^data:image\/png;base64,/.test(dataUrl) || dataUrl.length > 11_184_836) throw Error("The map image exceeds its 8 MiB capture allowance.");
  const presentation = context.layers.map(printLayerPresentation);
  const style = map.getStyle(), legend = [], displayNotes = [];
  for (const layer of context.layers.filter(item => item.visible !== false)) {
    const handle = context.handles.get(layer.layerId);
    const paints = style.layers.filter(item => handle?.layerIds?.includes(item.id) && !handle?.clusterLayerIds?.includes(item.id));
    if (!paints.length) throw Error(`${layer.title} is not installed in the rendered map. Resolve its loading or Style error before capture.`);
    const pointRows = pointSymbolLegendRows(layer, paints, handle);
    if (pointRows) legend.push(...pointRows);
    else if (!layer.styleReference && layer.style?.renderer === "graduated") {
      for (const row of graduatedLegendEntries(layer.style.graduated)) legend.push({label: `${layer.title} · ${row.label}`, color: row.color});
    } else {
      const renderedColor = paints.flatMap(item => [item.paint?.["fill-color"], item.paint?.["line-color"], item.paint?.["circle-color"]]).find(value => typeof value === "string" && !/url\s*\(/i.test(value));
      const inlineColor = !layer.styleReference && (!layer.style?.renderer || layer.style.renderer === "single")
        ? paints.some(item => item.type === "circle") ? layer.style?.circleColor
          : paints.some(item => item.type === "fill") ? layer.style?.fill : layer.style?.stroke : null;
      // Selection/hover expressions may wrap the known single-symbol color.
      const color = renderedColor ?? (typeof inlineColor === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(inlineColor) ? inlineColor : null);
      legend.push({label: layer.title, color});
    }
    if (layer.pointClustering?.enabled) {
      const note = `${layer.title} · Counts group points within ${layer.pointClustering.radius} screen pixels per Layer and change with zoom.`;
      legend.push({label: note});displayNotes.push(note);
    }
  }
  if (legend.length > 40) throw Error("The legend exceeds 40 rows. Reduce the included Layers or classes for this layout.");
  const attribution = [...new Set([context.basemap?.attribution,
    ...context.layers.filter(item => item.visible !== false).flatMap(item => [item.attribution ?? item.sourceConfiguration?.attribution, item.metadata?.curated?.attribution])]
    .filter(value => typeof value === "string" && value.trim()))].map(plainText);
  const lines = [];
  if (flat) {
    const bounds = map.getBounds().toArray().flat();
    for (const feature of mapGraticule(bounds).features) {
      const points = feature.geometry.coordinates.map(coordinate => {const point = map.project(coordinate);return [point.x / cssWidth, point.y / cssHeight];});
      if (points.flat().every(Number.isFinite)) lines.push({points, label: `${Number(feature.properties.value.toFixed(4))}°`});
    }
  }
  let metresPerPixel = null;
  if (flat) {
    const samplePixels = Math.min(1, cssWidth / 1000);
    const a = map.unproject([cssWidth / 2 - samplePixels / 2, cssHeight / 2]), b = map.unproject([cssWidth / 2 + samplePixels / 2, cssHeight / 2]);
    const radians = value => value * Math.PI / 180;
    const dlat = radians(b.lat - a.lat), dlon = radians(b.lng - a.lng);
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dlon / 2) ** 2;
    metresPerPixel = 2 * 6371008.8 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h))) / samplePixels;
  }
  const sourceMetadata = context.layers.filter(layer => layer.visible !== false).map(layer => ({layerId: layer.layerId,
    datasetId: layer.datasetId ?? null, datasetVersionId: layer.datasetVersionId ?? null, sourceVersion: layer.sourceVersion ?? null,
    title: layer.title, license: typeof layer.license === "string" ? layer.license : null,
    sourceAttribution: typeof layer.attribution === "string" ? plainText(layer.attribution) : null,
    curatedAttribution: typeof layer.metadata?.curated?.attribution === "string" ? plainText(layer.metadata.curated.attribution) : null}));
  return {dataUrl, width, height, cssWidth, cssHeight, view, presentation, signature: canonicalJson({view, presentation}), legend, attribution, displayNotes, sourceMetadata, lines, metresPerPixel, flat,
    projectId: mapRecord.id, projectVersion: mapRecord.version};
}

function pointSymbolLegendRows(layer, paints, handle) {
  const source = layer.styleReference ? handle?.boundStyle?.pointSymbolStyle : layer.style;
  if (!["Point", "MultiPoint"].includes(layer.geometryType) || !source
    || (source.pointSymbol === undefined && source.categorySymbols === undefined)) return null;
  const style = normalizePointSymbolStyle(source);
  const circle = paints.find(part => part.type === "circle");
  let color = circle?.paint?.["circle-color"];
  // Ignore temporary selection/hover colors when describing the saved classes.
  while (Array.isArray(color) && color[0] === "case") color = color.at(-1);
  const classes = new Map();
  if (Array.isArray(color) && color[0] === "match") {
    for (let index = 2; index < color.length - 1; index += 2) {
      for (const label of Array.isArray(color[index]) ? color[index] : [color[index]]) classes.set(String(label), color[index + 1]);
    }
    color = color.at(-1);
  }
  const row = (label, symbol, value) => {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw Error("Choose a supported point color before capturing its print legend.");
    return {label, color: value, opacity: layer.opacity ?? 1,
      pointStyle: {pointSymbol: symbol, circleColor: value, circleRadius: style.circleRadius ?? 6}};
  };
  if (style.renderer === "graduated") return graduatedLegendEntries(style.graduated)
    .map(entry => row(`${layer.title} · ${entry.label}`, style.pointSymbol, entry.color));
  if (style.renderer === "category" && style.categoryField) {
    const symbols = style.categorySymbols ?? {};
    const categories = [...new Set([...Object.keys(symbols), ...classes.keys()])];
    if (categories.some(value => value.length > 128)) throw Error("Point category labels exceed the 128 character print limit.");
    if (categories.length) return [
      ...categories.map(value => row(`${layer.title} · ${value}`, Object.hasOwn(symbols, value) ? symbols[value] : style.pointSymbol, classes.get(value) ?? color)),
      row(`${layer.title} · Other values`, style.pointSymbol, color)
    ];
  }
  if ((style.renderer === "status" || style.renderer === undefined) && classes.size) return [
    ...[...classes].map(([label, value]) => row(`${layer.title} · ${label}`, style.pointSymbol, value)),
    row(`${layer.title} · Other values`, style.pointSymbol, color)
  ];
  return [row(layer.title, style.pointSymbol, color)];
}

function pointLegendSize(row) {
  if (!row.pointStyle) return 0;
  const style = normalizePointSymbolStyle(row.pointStyle);
  if (!/^#[0-9a-f]{6}$/i.test(style.circleColor ?? "")) throw Error("Invalid point legend color.");
  return (style.circleRadius ?? 6) * 2 * 25.4 / 96;
}

export function printPageSvg(layout, captures, layoutId, {guides = false} = {}) {
  const page = layout.page, svg = svgNode("svg", {xmlns: "http://www.w3.org/2000/svg", width: `${page.widthMm}mm`, height: `${page.heightMm}mm`, viewBox: `0 0 ${page.widthMm} ${page.heightMm}`, role: "img", "aria-label": layout.title});
  svg.style.cssText = "background:white;color:#17212b;max-width:none";
  const metadata = svgNode("metadata", {});metadata.textContent = JSON.stringify({layout,
    captures: layout.frames.map(frame => {const captured = captures.get(`${layoutId}:${frame.id}`);return captured ? {frameId: frame.id, projectId: captured.projectId, projectVersion: captured.projectVersion, imageSha256: captured.imageSha256, width: captured.width, height: captured.height} : {frameId: frame.id, captured: false};})});svg.append(metadata);
  svg.append(svgNode("rect", {width: page.widthMm, height: page.heightMm, fill: "white"}));
  svg.append(svgText(layout.title, page.marginMm, 16, 5));
  if (guides) svg.append(svgNode("rect", {x: page.marginMm, y: page.marginMm, width: page.widthMm - 2 * page.marginMm, height: page.heightMm - 2 * page.marginMm, fill: "none", stroke: "#94a3b8", "stroke-width": 0.2, "stroke-dasharray": "2 2"}));
  for (const [frameIndex, frame] of layout.frames.entries()) {
    const captured = captures.get(`${layoutId}:${frame.id}`);
    svg.append(svgNode("rect", {x: frame.xMm, y: frame.yMm, width: frame.widthMm, height: frame.heightMm, fill: "#f1f5f9", stroke: "#17212b", "stroke-width": 0.3}));
    if (!captured) {svg.append(svgText(`${frame.title} · capture map frame`, frame.xMm + 3, frame.yMm + 8, 3));continue;}
    const factor = Math.min(frame.widthMm / captured.width, frame.heightMm / captured.height);
    const w = captured.width * factor, h = captured.height * factor, x = frame.xMm + (frame.widthMm - w) / 2, y = frame.yMm + (frame.heightMm - h) / 2;
    const clip = svgNode("clipPath", {id: `print-map-${frameIndex}`});clip.append(svgNode("rect", {x, y, width: w, height: h}));
    const definitions = svgNode("defs", {});definitions.append(clip);svg.append(definitions);
    const mapContent = svgNode("g", {"clip-path": `url(#print-map-${frameIndex})`});svg.append(mapContent);
    mapContent.append(svgNode("image", {href: captured.dataUrl, x, y, width: w, height: h}));
    if (layout.graticule && !captured.flat) throw Error("Latitude/longitude grids require an unpitched Earth Mercator frame. Adjust the map and capture again.");
    if (layout.graticule) for (const line of captured.lines) {
      const points = line.points.map(point => [x + point[0] * w, y + point[1] * h]);
      mapContent.append(svgNode("polyline", {points: points.map(point => point.join(",")).join(" "), fill: "none", stroke: "#475569", "stroke-width": 0.15, "stroke-dasharray": "1 1"}));
      const label = points.find(point => point[0] >= x && point[0] <= x + w && point[1] >= y && point[1] <= y + h);
      if (label) mapContent.append(svgText(line.label, Math.max(x + 1, Math.min(label[0], x + w - 12)), Math.max(y + 3, Math.min(label[1], y + h - 1)), 2));
    }
    if (layout.northArrow) {
      if (!captured.flat) throw Error("This north arrow requires an unpitched Earth Mercator frame. Adjust the map and capture again.");
      const arrow = svgNode("g", {transform: `translate(${x + w - 9} ${y + 11}) rotate(${-captured.view.bearing})`});
      arrow.append(svgNode("path", {d: "M0 -6 L3 4 L0 2 L-3 4 Z", fill: "#17212b", stroke: "white", "stroke-width": 0.4}), svgText("N", -1.5, -8, 3));svg.append(arrow);
    }
    if (layout.scaleBar) {
      if (!captured.flat || !(captured.metresPerPixel > 0)) throw Error("A measured scale bar requires an unpitched Earth Mercator frame. Adjust the map and capture again.");
      const target = captured.metresPerPixel * captured.cssWidth / 4, magnitude = 10 ** Math.floor(Math.log10(target));
      const metres = [1, 2, 5, 10].map(value => value * magnitude).filter(value => value <= target).at(-1);
      const length = metres / (captured.metresPerPixel * captured.cssWidth) * w;
      svg.append(svgNode("rect", {x: x + 4, y: y + h - 7, width: length, height: 1.4, fill: "white", stroke: "#17212b", "stroke-width": 0.3}),
        svgNode("rect", {x: x + 4, y: y + h - 7, width: length / 2, height: 1.4, fill: "#17212b"}),
        svgText(`0                 ${metres >= 1000 ? `${metres / 1000} km` : `${metres} m`} · at map center`, x + 4, y + h - 9, 2));
    }
  }
  const main = layout.frames[0], mainCapture = captures.get(`${layoutId}:${main.id}`);
  if (layout.legend && mainCapture) {
    const x = main.xMm + main.widthMm + 4, y = main.yMm;
    if (x + 30 > page.widthMm) throw Error("Leave at least 30 mm beside the main frame for its legend, or hide the legend.");
    svg.append(svgText("Legend", x, y + 4, 3.2));
    const swatchWidth = Math.max(4, ...mainCapture.legend.map(row => pointLegendSize(row) + 1));
    let cursor = y + 9;
    for (const row of mainCapture.legend) {
      const size = pointLegendSize(row);
      if (row.pointStyle) {
        if (typeof row.opacity !== "number" || !Number.isFinite(row.opacity) || row.opacity < 0 || row.opacity > 1) throw Error("Invalid point legend opacity.");
        svg.append(svgNode("image", {x, y: cursor - 2, width: size, height: size, opacity: row.opacity,
          href: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pointSymbolPreviewSvg(row.pointStyle))}`,
          "data-point-symbol": row.pointStyle.pointSymbol}));
      } else if (row.color) svg.append(svgNode("rect", {x, y: cursor - 2, width: 3, height: 2.5, fill: row.color, stroke: "#17212b", "stroke-width": 0.1}));
      const lines = wrapWords(row.label, Math.max(8, Math.floor((page.widthMm - page.marginMm - x - swatchWidth) / 1.15)));
      const start = cursor;
      for (const line of lines) {svg.append(svgText(line, x + swatchWidth, cursor, 2.3));cursor += 3.5;}
      cursor = Math.max(cursor, start + size) + 1.5;
    }
    if (cursor > page.heightMm - 10) throw Error("The legend is taller than this page. Choose a larger page or reduce its included Layers/classes.");
  }
  const notes = [...new Set(layout.frames.flatMap(frame => captures.get(`${layoutId}:${frame.id}`)?.attribution ?? [])),
    ...(layout.sourceNotes ? [...new Set(layout.frames.flatMap(frame => captures.get(`${layoutId}:${frame.id}`)?.displayNotes ?? []))] : []),
    ...(layout.sourceNotes && mainCapture ? [`Project ${mainCapture.projectId} · revision ${mainCapture.projectVersion}`] : []), layout.caption].filter(Boolean).join(" · ");
  const maximum = Math.floor((page.widthMm - 2 * page.marginMm) / 1.1);
  const words = notes.split(/\s+/), rows = [];let row = "";
  for (const word of words) {if ((row + " " + word).length > maximum && row) {rows.push(row);row = word;} else row += `${row ? " " : ""}${word}`;}
  if (row) rows.push(row);
  const top = Math.max(...layout.frames.map(frame => frame.yMm + frame.heightMm)) + 5;
  if (top + rows.length * 3 > page.heightMm - 2) throw Error("Source notes need more page space. Reduce map height or use a larger page.");
  rows.forEach((line, index) => svg.append(svgText(line, page.marginMm, top + index * 3, 2.2)));
  return svg;
}

function paperHtml(layout, svg) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeText(layout.title)}</title><style>@page{size:${layout.page.widthMm}mm ${layout.page.heightMm}mm;margin:0}html,body{margin:0;background:white}svg{display:block}@media screen{body{overflow:auto}}</style>${svg}</html>`;
}
async function pagePng(svg, layout) {
  return (await pageImages(svg, layout, false)).png;
}
async function pageImages(svg, layout, includeJpeg = true) {
  const url = URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}));
  try {
    const image = new document.defaultView.Image();await new Promise((resolve, reject) => {image.onload = resolve;image.onerror = () => reject(Error("The composed page could not be rasterized."));image.src = url;});
    const canvas = el("canvas");canvas.width = mmToPx(layout.page.widthMm, layout.dpi);canvas.height = mmToPx(layout.page.heightMm, layout.dpi);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = (type, quality) => new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("Page image export failed. Choose a lower DPI.")), type, quality));
    return {png: await blob("image/png"), ...(includeJpeg ? {jpeg: await blob("image/jpeg", .92)} : {}), width: canvas.width, height: canvas.height};
  } finally {URL.revokeObjectURL(url);}
}
function download(blob, filename) {const url = URL.createObjectURL(blob), link = el("a");link.href = url;link.download = filename;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);}
function safeName(value) {return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "map-layout";}
function plainText(value) {return new document.defaultView.DOMParser().parseFromString(String(value), "text/html").body.textContent || "";}
function escapeText(value) {return String(value).replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));}
function wrapWords(value, maximum) {const lines = [];let line = "";for (const word of String(value).split(/\s+/)) {if ((line + " " + word).length > maximum && line) {lines.push(line);line = word;} else line += `${line ? " " : ""}${word}`;}if (line) lines.push(line);return lines;}
function el(tag, text = "") {const node = document.createElement(tag);node.textContent = text;return node;}
function button(label, action, disabled = false) {const node = el("button", label);node.type = "button";node.className = "print-button secondary";node.disabled = disabled;node.onclick = action;return node;}
function inputField(label, value, type, action) {const field = el("label", label), input = el("input");field.className = "print-field";input.type = type;input.value = value;input.setAttribute("aria-label", label);if (type === "number") input.step = "0.1";input.onchange = () => action(input.value);field.append(input);return field;}
function selectField(label, value, options, action) {const field = el("label", label), input = el("select");field.className = "print-field";input.setAttribute("aria-label", label);for (const [id, title] of options) {const option = el("option", title);option.value = id;input.append(option);}input.value = value;input.onchange = () => action(input.value);field.append(input);return field;}
function svgNode(tag, attributes) {const node = document.createElementNS("http://www.w3.org/2000/svg", tag);for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);return node;}
function svgText(text, x, y, size) {const node = svgNode("text", {x, y, "font-size": size, "font-family": "system-ui,sans-serif", fill: "#17212b"});node.textContent = text;return node;}
