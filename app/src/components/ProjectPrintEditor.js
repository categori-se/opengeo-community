import {definitionWithPrintLayouts, mmToPx, newProjectPrintLayout, printLayerPresentation,
  projectPrintLayouts, standardPageSizes, validateProjectPrintLayouts, movePrintFrame,
  resizePrintFrame, alignPrintFrame, printRulerTicks, printCaptureTarget, printCaptureOutputSignature} from "../lib/printLayouts.js";
import {parseContinuousColorExpression} from "../lib/continuousStyle.js";
import {continuousLegendGroups, continuousLegendRows} from "../lib/printContinuousLegend.js";
import {capturePrintRasterLegend, rasterLegendGroups} from "../lib/printRasterLegend.js";
import {layoutFromTemplate, templateFromLayout, validatePrintTemplate} from "../lib/printTemplates.js";
import {exportQgisPrintTemplate, importQgisPrintTemplate} from "../lib/qgisPrintTemplates.js";
import {mapGraticule} from "../lib/mapGraticule.js";
import {graduatedLegendEntries, graduatedColorExpression, normalizeGraduatedStyle} from "../lib/thematicStyle.js";
import {canonicalJson} from "../lib/artifactCanonicalJson.js";
import {compileFigurePrintPack} from "../lib/figurePrintPack.js";
import {ensurePointSymbolAssets, normalizePointSymbolStyle, pointSymbolPreviewSvg} from "../lib/pointSymbols.js";
import {capturePrintDataFrames, printDataSourceFields, assertPrintDataFrameSnapshot} from "../lib/printDataFrames.js";
import {capturePrintVectorScene, assertPrintVectorScene} from "../lib/printVectorScene.js";
import {printMapPlacement, printGeoPdfRegistrations} from "../lib/printGeoPdf.js";
import {appendPrintTextFrames} from "../lib/printTextSvg.js";
import {hasPrintMath, preparePrintMath, printMathReady} from "../lib/printMathSvg.js";

// Layout metadata is saved explicitly. Map images remain an authorized browser capture.
export function ProjectPrintEditor({state, workbench: initialWorkbench, editFrame, canSave = false, onSaved = () => {}, captureMap = capturePrintMap, persistence = "account"}) {
  const root = el("section");root.className = "project-print-studio project-print-editor";root.id = "project-print-studio";
  let mapRecord = state.selectedMap, workbench = initialWorkbench, collection, activeId, frameId;
  let dirty = false, busy = false, disposed = false, uncertain = false, guides = true;
  let units = "mm", snapping = true, drag = null;
  let templateId = "", templateName = "", templateBindings = {}, outputFormat = "svg", outputRunning = false;
  let pendingQgisImport = null, mathLoadStarted = false;
  let captureController = null;
  let outputController = null;
  const captures = new Map(), undo = [], redo = [];
  const status = el("p");status.setAttribute("role", "status");
  root.append(el("h2", "Print Studio"), el("p", mapRecord.name),
    el("p", persistence === "browser"
      ? "Arrange this local Project on a paper-sized page. Capture each map frame, then print or export. Save layout keeps the settings with this browser draft; download a Project backup to keep them."
      : "Arrange the saved Project on a paper-sized page. Edit a map frame, then capture its view and styling. Save layout keeps these settings in this Project."));
  const shell = el("div");shell.className = "print-studio-shell";
  const controls = el("aside");controls.className = "print-studio-controls";
  const stage = el("div");stage.className = "print-stage";
  stage.tabIndex = 0;stage.setAttribute("role", "group");stage.setAttribute("aria-label", "Print layout canvas");
  const help = el("p", "Select a frame on the page. Drag to move; drag its lower-right handle to resize. Arrow keys move 1 mm; Shift moves 10 mm; Alt moves 0.1 mm. With the resize handle focused, arrows resize instead. Hold Alt while dragging to bypass snapping. Escape cancels a drag. Ctrl/Cmd+Z undoes; Shift+Z redoes.");
  help.id = `print-editing-help-${crypto.randomUUID()}`;help.className = "print-editing-help";
  stage.setAttribute("aria-describedby", help.id);
  const mapEditor = el("details"), mapHost = el("div");mapEditor.open = true;mapEditor.append(el("summary", "Map frame · pan, zoom, Layers and styling"), mapHost);
  mapHost.append(workbench);mapHost.style.height = "480px";mapHost.style.minWidth = "0";
  shell.append(controls, stage);root.append(status, help, shell, mapEditor);
  try {
    collection = projectPrintLayouts(mapRecord);
    if (!collection.layouts.length) collection.layouts.push(newProjectPrintLayout(mapRecord));
    activeId = collection.layouts[0].id;frameId = collection.layouts[0].frames[0].id;
  } catch (error) {status.textContent = error.message;return root;}
  const layout = () => collection.layouts.find(item => item.id === activeId);
  const editableFrames = () => [...layout().frames, ...(layout().dataFrames ?? []), ...(layout().textFrames ?? [])];
  const frame = () => editableFrames().find(item => item.id === frameId) ?? layout().frames[0];
  const mapFrame = () => ["text", "math"].includes(frame().type) ? layout().frames[0] : frame().mapFrameId ? layout().frames.find(item => item.id === frame().mapFrameId) : frame();
  const key = item => `${activeId}:${item.id}`;
  const current = async () => !disposed && root.isConnected
    && (typeof state.adapter.organizationProvider !== "function" || await state.adapter.organizationProvider() === state.organization.id);
  root.hasUnsavedChanges = () => dirty;
  root.shouldBlockNavigation = () => dirty || busy || uncertain || Boolean(drag);
  root.checkDraft = () => {status.textContent = "Save the layout or discard its changes before leaving Print Studio.";root.scrollIntoView?.({block: "start"});return true;};
  root.dispose = () => {finishDrag(false, false);disposed = true;captureController?.abort();outputController?.abort();captures.clear();};
  function remember(previous) {
    undo.push(previous);if (undo.length > 20) undo.shift();redo.length = 0;dirty = true;
  }
  function change(action) {
    if (busy || uncertain || disposed || drag) return;
    const previous = structuredClone(collection), previousActive = activeId, previousFrame = frameId;
    const previousTemplate = {templateId, templateName, templateBindings, pendingQgisImport};
    try {
      action();validateProjectPrintLayouts(collection, mapRecord);
      if (canonicalJson(collection) === canonicalJson(previous)) return;
      remember(previous);
      render();status.textContent = "Layout changes are unsaved.";
    } catch (error) {collection = previous;activeId = previousActive;frameId = previousFrame;
      ({templateId, templateName, templateBindings, pendingQgisImport} = previousTemplate);render();status.textContent = error.message;}
  }
  async function capture() {
    if (busy || drag || !await current()) return;
    captureController = new AbortController();
    busy = true;render();status.textContent = "Rendering the map at Print resolution…";
    const selected = mapFrame(), selectedKey = key(selected), previous = structuredClone(collection);
    try {
      const context = workbench.getPrintContext?.();
      const captured = await captureMap(context, mapRecord, {dataFrames: (layout().dataFrames ?? []).filter(item => item.mapFrameId === selected.id),
        outputFrame: {widthMm: selected.widthMm, heightMm: selected.heightMm, dpi: layout().dpi}, signal: captureController.signal,
        onPhase: message => {if (!disposed) status.textContent = ({rendering: "Rendering the map at Print resolution…", capturing: "Reading rendered map pixels…", restoring: "Restoring the map display…"})[message] ?? message;}});
      if (!await current() || key(mapFrame()) !== selectedKey) return;
      selected.view = captured.view;selected.presentation = captured.presentation;
      validateProjectPrintLayouts(collection, mapRecord);
      captured.outputSignature = printCaptureOutputSignature(selected, layout().dpi);
      remember(previous);captures.set(selectedKey, captured);
      status.textContent = `Captured ${selected.title}: ${captured.width} × ${captured.height} map pixels at ${layout().dpi} DPI within its frame. Capture again after changing its view, styling, dimensions or DPI.`;
    } catch (error) {collection = previous;status.textContent = error.message;}
    finally {captureController = null;busy = false;if (!disposed) render();}
  }
  async function save() {
    if (busy || drag || uncertain || !canSave || !await current()) return;
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
    const retained = new Map(collection.layouts.flatMap(item => item.frames.map(frame => [`${item.id}:${frame.id}`, {frame, dpi: item.dpi}])));
    for (const [id, captured] of captures) {
      const saved = retained.get(id), savedFrame = saved?.frame;
      if (!savedFrame || captured.signature !== canonicalJson({view: savedFrame.view, presentation: savedFrame.presentation})
        || captured.outputSignature !== printCaptureOutputSignature(savedFrame, saved.dpi)) captures.delete(id);
    }
    const selected = layout(), selectedFrame = frame();
    controls.setAttribute("aria-busy", String(busy));
    const templateSectionOpen = controls.querySelector(".print-templates")?.open ?? false;
    controls.replaceChildren();
    controls.append(selectField("Layout", selected.id, collection.layouts.map(item => [item.id, item.title]), id => {
      activeId = id;frameId = layout().frames[0].id;render();
    }), button("New layout", () => change(() => {
      const added = newProjectPrintLayout(mapRecord);collection.layouts.push(added);activeId = added.id;frameId = added.frames[0].id;
    })), inputField("Layout title", selected.title, "text", value => change(() => {layout().title = value;})));
    renderTemplateControls();
    controls.querySelector(".print-templates").open = templateSectionOpen;
    const paperChoices = [...new Set(standardPageSizes.map(page => page.size))].map(size => [size, size]);
    controls.append(selectField("Layout units", units, [["mm", "Millimeters"], ["in", "Inches"]], value => {
      units = value;render();controls.querySelector('[aria-label="Layout units"]').focus();
    }), el("small", "Geometry is stored in millimeters. Inch edits round to 0.001 mm; switching units does not change the layout."));
    controls.append(selectField("Paper size", selected.page.size, paperChoices, size => change(() => setPaper(size, selected.page.orientation))),
      selectField("Orientation", selected.page.orientation, [["landscape", "Landscape"], ["portrait", "Portrait"]], orientation => change(() => setPaper(selected.page.size, orientation))));
    for (const [label, property] of [["Page width", "widthMm"], ["Page height", "heightMm"], ["Margin", "marginMm"]]) controls.append(dimensionField(label, selected.page[property], value => change(() => {
      layout().page[property] = value;if (property !== "marginMm") layout().page.size = "Custom";
    })));
    controls.append(selectField("Output DPI", String(selected.dpi), [["96", "96"], ["150", "150"], ["300", "300"]], value => change(() => {layout().dpi = Number(value);})),
      el("small", "DPI sets page output dimensions. Captured maps retain their original pixel detail."));
    for (const [property, label] of [["legend", "Legend"], ["northArrow", "North arrow / compass"], ["scaleBar", "Scale bar"], ["graticule", "Latitude / longitude grid"], ["sourceNotes", "Source notes"]]) {
      const control = el("label"), input = el("input");input.type = "checkbox";input.checked = selected[property];
      input.onchange = () => change(() => {layout()[property] = input.checked;});control.append(input, ` ${label}`);controls.append(control);
    }
    controls.append(selectField("Main map legend display", selected.legendFormat ?? "swatches", [["swatches", "Swatches"], ["classed-bars", "Classed color bars"], ["color-bars", "Classed and continuous color bars"]], value => change(() => {
      if (value === "swatches") delete layout().legendFormat;else layout().legendFormat = value;
    })), el("small", "Classed bars use equal-height bands. Continuous bars follow a linear saved Style or an explicit one-band raster display range. Source credits and recorded license status remain in every output."));
    controls.append(inputField("Caption", selected.caption, "text", value => change(() => {layout().caption = value;})),
      selectField("Map frame", mapFrame().id, selected.frames.map(item => [item.id, item.title]), id => {frameId = id;render();}));
    if (selected.dataFrames?.length || selected.textFrames?.length) controls.append(selectField("Arrange item", selectedFrame.id,
      editableFrames().map(item => [item.id, `${item.type === "math" ? "Equation" : item.type === "text" ? "Text" : item.type === "table" ? "Table" : item.type === "chart" ? "Chart" : "Map"} · ${item.title}`]), id => {frameId = id;render();}));
    for (const [label, property] of [["Frame left", "xMm"], ["Frame top", "yMm"], ["Frame width", "widthMm"], ["Frame height", "heightMm"]]) controls.append(dimensionField(label, selectedFrame[property], value => change(() => {frame()[property] = value;})));
    controls.append(selectField("Align frame to page margins", "", [["", "Choose alignment"], ["left", "Left margin"],
      ["center", "Horizontal center"], ["right", "Right margin"], ["top", "Top margin"], ["middle", "Vertical center"],
      ["bottom", "Bottom margin"]], value => {if (value) change(() => Object.assign(frame(), alignPrintFrame(layout(), frameId, value)));}));
    controls.append(button("Edit selected map frame", () => {
      if (busy || uncertain || disposed) return;
      workbench = editFrame(structuredClone(mapFrame()));mapHost.replaceChildren(workbench);mapEditor.open = true;
      status.textContent = "Adjust this frame's map, then Capture map frame to retain its view and styling.";
    }), button("Capture map frame", capture), button("Add inset map", () => change(() => {
      if (layout().frames.length === 2) throw Error("This layout already has an inset.");
      const main = layout().frames[0], inset = structuredClone(main);
      Object.assign(inset, {id: "inset", parentId: main.id, title: "Inset map", xMm: main.xMm + main.widthMm * 0.65,
        yMm: main.yMm + 5, widthMm: main.widthMm * 0.3, heightMm: main.heightMm * 0.3});
      inset.view.zoom = Math.max(-2, main.view.zoom - 3);layout().frames.push(inset);frameId = inset.id;
    })));
    controls.append(button("Add source table", () => addDataFrame("table")), button("Add source chart", () => addDataFrame("chart")));
    for (const type of ["text", "math"]) controls.append(button(type === "math" ? "Add equation" : "Add text block", () => change(() => {
      if ((layout().textFrames?.length ?? 0) >= 8) throw Error("A layout supports at most eight text blocks.");
      const page = layout().page, main = layout().frames[0], width = Math.min(70, page.widthMm - 2 * page.marginMm), height = Math.min(24, page.heightMm - 2 * page.marginMm);
      const item = {id: crypto.randomUUID(), type, title: type === "math" ? "Equation" : "Text block", text: type === "math" ? "\\frac{a}{b}" : "Text", xMm: Math.max(0, Math.min(main.xMm + 5, page.widthMm - width)),
        yMm: Math.max(0, Math.min(main.yMm + 5, page.heightMm - height)), widthMm: width, heightMm: height, fontSizePt: 10, color: "#17212b", background: "#ffffff", alignment: "left"};
      (layout().textFrames ??= []).push(item);frameId = item.id;
    })));
    if (selectedFrame.type === "table" || selectedFrame.type === "chart") renderDataFrameControls(selectedFrame);
    if (["text", "math"].includes(selectedFrame.type)) {
      const math = selectedFrame.type === "math", contentLabel = math ? "Equation (LaTeX)" : "Text content";
      controls.append(el("h3", math ? "Equation" : "Text block"), inputField(math ? "Equation title" : "Text block title", selectedFrame.title, "text", value => change(() => {frame().title = value;})));
      const field = el("label", contentLabel), input = el("textarea");field.className = "print-field";input.setAttribute("aria-label", contentLabel);input.rows = 4;input.maxLength = 4000;input.value = selectedFrame.text;
      input.onchange = () => change(() => {frame().text = input.value;});field.append(input);controls.append(field,
        inputField("Text size (pt)", selectedFrame.fontSizePt, "number", value => change(() => {frame().fontSizePt = Number(value);})),
        inputField("Text color", selectedFrame.color, "color", value => change(() => {frame().color = value;})),
        selectField("Text alignment", selectedFrame.alignment, [["left", "Left"], ["center", "Center"], ["right", "Right"]], value => change(() => {frame().alignment = value;})));
      const transparent = el("label"), checkbox = el("input");checkbox.type = "checkbox";checkbox.checked = selectedFrame.background === "none";
      checkbox.onchange = () => change(() => {frame().background = checkbox.checked ? "none" : "#ffffff";});transparent.append(checkbox, " Transparent text background");controls.append(transparent);
      if (selectedFrame.background !== "none") controls.append(inputField("Text background color", selectedFrame.background, "color", value => change(() => {frame().background = value;})));
      controls.append(el("small", math ? "Enter a math expression with fractions, roots, Greek symbols or matrices. Equations export as vector outlines; LaTeX remains in saved layouts and JSON templates. Enlarge the frame if it does not fit. TeX document packages, files and links are unavailable." : "Literal text wraps inside this frame. Enlarge it or reduce text size if it overflows. Direct PDF uses the packaged Open Sans font."), button(math ? "Remove equation" : "Remove text block", () => change(() => {
        layout().textFrames = layout().textFrames.filter(item => item.id !== frameId);if (!layout().textFrames.length) delete layout().textFrames;frameId = layout().frames[0].id;
      })));
    }
    const guide = el("label"), guideInput = el("input");guideInput.type = "checkbox";guideInput.checked = guides;
    guideInput.onchange = () => {guides = guideInput.checked;renderPage();};guide.append(guideInput, " Page margin guides");controls.append(guide);
    const snap = el("label"), snapInput = el("input");snapInput.type = "checkbox";snapInput.checked = snapping;
    snapInput.onchange = () => {snapping = snapInput.checked;};snap.append(snapInput, " Snap to page and frame guides");controls.append(snap);
    controls.append(button("Undo layout change", () => restore(undo, redo), !undo.length || busy || uncertain), button("Redo layout change", () => restore(redo, undo), !redo.length || busy || uncertain),
      button("Save layout", save, !canSave || busy || uncertain),
      button("Download layout JSON", () => download(new Blob([JSON.stringify(collection, null, 2)], {type: "application/json"}), `${safeName(selected.title)}.layout.json`)),
      button("Discard layout changes", () => {
        if (busy || uncertain) return;
        collection = projectPrintLayouts(mapRecord);if (!collection.layouts.length) collection.layouts.push(newProjectPrintLayout(mapRecord));
        activeId = collection.layouts[0].id;frameId = collection.layouts[0].frames[0].id;dirty = false;captures.clear();undo.length = 0;redo.length = 0;render();status.textContent = "Saved layout settings reopened. Capture each map frame under current access before exporting.";
      }));
    renderOutputControls();
    controls.append(button("Export interactive web map…", () => workbench.openPublicationMapExport?.()));
    if (!canSave) controls.append(el("p", "Your current role can compose and export a temporary layout. Project edit access is required to save it."));
    if (busy || drag) for (const control of controls.querySelectorAll("button,input,select,textarea")) control.disabled = true;
    renderPage();
  }
  function renderTemplateControls() {
    const section = el("details");section.className = "print-templates";
    section.append(el("summary", "Reusable Print templates"),
      el("p", "Templates keep paper, furniture and frame settings. Each new layout uses this Project's current map and requires fresh captures. Bind table and chart sources explicitly. Save layout also saves this Project's templates; download a template to reuse it in another Project."));
    const templates = collection.templates ?? [], selected = templates.find(item => item.id === templateId);
    section.append(selectField("Print template", selected?.id ?? "", [["", "Choose a template"], ...templates.map(item => [item.id, item.name])], value => {
      templateId = value;templateName = templates.find(item => item.id === value)?.name ?? "";templateBindings = {};render();
      controls.querySelector(".print-templates").open = true;controls.querySelector('[aria-label="Print template"]').focus();
    }), inputField("Template name", templateName, "text", value => {templateName = value;}),
      button("Save layout as template", () => {
        change(() => {const added = templateFromLayout(layout(), templateName);(collection.templates ??= []).push(added);templateId = added.id;});
        controls.querySelector(".print-templates").open = true;
      }, templates.length >= 8));
    if (selected) {
      for (const [index, slot] of (selected.dataFrames ?? []).entries()) {
        section.append(selectField(`Template source ${index + 1}`, templateBindings[slot.sourceSlot] ?? "",
          [["", `Choose Layer for ${slot.title}`], ...(mapRecord.definition.layers ?? []).filter(layer => layer.visible !== false)
            .map(layer => [layer.layerId, layer.title || layer.layerId])], value => {templateBindings[slot.sourceSlot] = value;}),
          el("small", `Required fields: ${(slot.type === "table" ? slot.columns : [slot.labelField, slot.valueField]).join(", ")}. Only already loaded, complete sources with these fields are available.`));
      }
      section.append(button("Create layout from template", () => {
        change(() => {
          for (const slot of selected.dataFrames ?? []) {
            const layerId = templateBindings[slot.sourceSlot];
            const fields = layerId ? printDataSourceFields(workbench.getPrintContext?.(), layerId) : [];
            if (!layerId || !(slot.type === "table" ? slot.columns : [slot.labelField, slot.valueField]).every(field => fields.includes(field))) {
              throw Error(`Choose a loaded Layer containing the required fields for ${slot.title}. No provider data is requested.`);
            }
          }
          const added = layoutFromTemplate(selected, mapRecord, crypto.randomUUID(), templateBindings);
          collection.layouts.push(added);activeId = added.id;frameId = added.frames[0].id;
        });
      }, collection.layouts.length >= 8), button("Download selected template", () => {
        const checked = validatePrintTemplate(selected);
        download(new Blob([JSON.stringify(checked, null, 2)], {type: "application/json"}), `${safeName(checked.name)}.print-template.json`);
        status.textContent = "Template downloaded with source-free frame settings. Bind data slots and capture the destination Project before output.";
      }), button("Download QGIS template (.qpt)", () => {
        try {
          const checked = validatePrintTemplate(selected), xml = exportQgisPrintTemplate(checked);
          download(new Blob([xml], {type: "application/xml"}), `${safeName(checked.name)}.qpt`);
          status.textContent = "QGIS template downloaded with native page, map and furniture items. Maps and attribute tables need destination Layer bindings; source data and captures are separate.";
        } catch (error) {status.textContent = error.message;}
      }), button("Delete selected template", () => change(() => {
        collection.templates = templates.filter(item => item.id !== selected.id);if (!collection.templates.length) delete collection.templates;
        templateId = "";templateName = "";templateBindings = {};
      })));
    }
    if (pendingQgisImport) {
      const preview = el("section");preview.className = "print-qgis-import-review";
      const {template, notices} = pendingQgisImport;
      preview.append(el("h3", "Review QGIS template"),
        el("p", `${template.name} · ${template.page.widthMm} × ${template.page.heightMm} mm · ${template.frames.length} map frames · ${template.dataFrames?.length ?? 0} data frames`));
      const notes = el("ul");for (const notice of notices) notes.append(el("li", notice));preview.append(notes);
      preview.append(button("Import reviewed QGIS template", () => {
        change(() => {const checked = validatePrintTemplate(template);checked.id = crypto.randomUUID();(collection.templates ??= []).push(checked);
          templateId = checked.id;templateName = checked.name;templateBindings = {};pendingQgisImport = null;});
        controls.querySelector(".print-templates").open = true;
      }, templates.length >= 8), button("Cancel QGIS import", () => {pendingQgisImport = null;render();controls.querySelector(".print-templates").open = true;status.textContent = "QGIS import canceled. Existing layouts and templates are retained.";}));
      section.append(preview);
    }
    const importLabel = el("label", "Import Print template"), input = el("input");input.type = "file";input.accept = ".json,.qpt,.xml,application/json,application/xml,text/xml";input.setAttribute("aria-label", "Import Print template");
    input.onchange = async () => {
      const file = input.files?.[0];if (!file || busy || uncertain || drag || !await current()) return;
      busy = true;pendingQgisImport = null;render();status.textContent = "Reading Print template…";
      try {
        if (file.size > 1048576) throw Error("A QGIS template must be at most 1 MiB; Print JSON must be at most 32 KiB.");
        const text = await file.text();
        if (text.trimStart().startsWith("<")) {
          const converted = importQgisPrintTemplate(text, {DOMParser: root.ownerDocument.defaultView.DOMParser});
          if (!await current()) return;
          pendingQgisImport = converted;status.textContent = "QGIS template read. Review its map, data and furniture settings before importing.";
          return;
        }
        if (file.size > 32768) throw Error("A Print JSON template must be at most 32 KiB.");
        const template = validatePrintTemplate(JSON.parse(text));
        if (!await current()) return;
        busy = false;
        change(() => {template.id = crypto.randomUUID();(collection.templates ??= []).push(template);templateId = template.id;templateName = template.name;templateBindings = {};pendingQgisImport = null;});
      } catch (error) {status.textContent = error.message;}
      finally {busy = false;if (!disposed) {render();controls.querySelector(".print-templates").open = true;}}
    };
    importLabel.append(input);section.append(importLabel);controls.append(section);
  }
  function outputDimensions(selected = layout()) {
    return `${selected.page.widthMm} × ${selected.page.heightMm} mm; ${mmToPx(selected.page.widthMm, selected.dpi)} × ${mmToPx(selected.page.heightMm, selected.dpi)} page pixels at ${selected.dpi} DPI`;
  }
  function renderOutputControls() {
    const section = el("section");section.className = "print-output-controls";section.append(el("h3", "Page output"));
    const dimensions = el("output", outputDimensions());dimensions.setAttribute("aria-label", "Output dimensions");section.append(dimensions);
    const detail = el("ul");detail.setAttribute("aria-label", "Captured map detail");
    for (const item of layout().frames) {
      const capture = captures.get(key(item)), target = printCaptureTarget(item, layout().dpi);
      detail.append(el("li", `${item.title}: up to ${target.maxWidth} × ${target.maxHeight} pixels within the frame; ${capture ? `${capture.width} × ${capture.height} captured map pixels` : "capture required"}`));
      if (capture) detail.append(el("li", `${item.title} vector output: ${capture.vectorScene ? "ready from complete loaded geometry" : capture.vectorUnavailable ?? "capture again to check vector support"}`));
    }
    const descriptions = {
      svg: "Paper-sized SVG with raster map captures, selectable page text and vector furniture.",
      "vector-svg": "Paper-sized SVG with vector maps from complete loaded GeoJSON and supported installed fills, lines and circles. Unsupported visible content requires another output format.",
      "vector-print": "Print the vector page through your browser, including Save PDF. Choose the matching paper size and scale. Browser settings control PDF completion; geographic registration is not included.",
      "vector-pdf": "Download vector PDF with embedded Open Sans page text. Latin, Greek, Cyrillic and the packaged symbols are supported. Use browser Print for other text or fonts.",
      "geospatial-pdf": "Download the vector PDF with separate geographic registration for each captured Mercator map, including its inset. Capture every frame again to retain its geographic control points.",
      png: "One raster page at the dimensions and resolution shown above.",
      pack: "Offline ZIP with PNG, JPEG, raster paper PDF, SVG, HTML, settings, source metadata and file hashes.",
      html: "Self-contained paper-sized HTML. Map frames retain captured pixels.",
      print: "Open the browser print dialog. Choose the matching paper size and scale; the browser controls PDF settings and completion."
    };
    section.append(detail, el("small", "Capture again after changing frame dimensions or DPI. Capture preserves the map's aspect ratio; raster imagery retains its source resolution."),
      selectField("Output format", outputFormat, [["svg", "Paper SVG"], ["vector-svg", "Vector map SVG"], ["vector-pdf", "Vector PDF"], ["geospatial-pdf", "Geospatial PDF"], ["vector-print", "Vector Print / Save PDF"], ["png", "Page PNG"], ["pack", "Figure and print ZIP"], ["html", "Static web page"], ["print", "Print / Save PDF"]], value => {outputFormat = value;render();controls.querySelector('[aria-label="Output format"]').focus();}),
      el("p", descriptions[outputFormat]), button("Prepare selected output", () => output(outputFormat)));
    if (outputRunning) {const progress = el("progress");progress.setAttribute("aria-label", "Preparing Print output");section.append(progress);}
    if (captureController) {const progress = el("progress");progress.setAttribute("aria-label", "Capturing Print map");section.append(progress);}
    const direct = el("details");direct.append(el("summary", "Direct output shortcuts"),
      button("Download paper SVG", () => output("svg")), button("Download page PNG", () => output("png")),
      button("Download figure and print ZIP", () => output("pack")), button("Download static web page", () => output("html")), button("Print / Save PDF", () => output("print")));
    section.append(direct);controls.append(section);
  }
  function restore(from, to) {
    if (!from.length || busy || uncertain || drag || disposed) return;to.push(structuredClone(collection));if (to.length > 20) to.shift();collection = from.pop();
    if (!collection.layouts.some(item => item.id === activeId)) activeId = collection.layouts[0].id;
    if (!editableFrames().some(item => item.id === frameId)) frameId = layout().frames[0].id;
    dirty = true;render();status.textContent = from === undo ? "Undid layout change." : "Redid layout change.";
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
    for (const item of [...(layout().dataFrames ?? []), ...(layout().textFrames ?? [])]) {
      item.widthMm = Math.max(["text", "math"].includes(item.type) ? 10 : 20, Math.min(item.widthMm, width - 2 * layout().page.marginMm));
      item.heightMm = Math.max(["text", "math"].includes(item.type) ? 5 : 20, Math.min(item.heightMm, height - 2 * layout().page.marginMm));
      item.xMm = Math.max(0, Math.min(item.xMm, width - item.widthMm));item.yMm = Math.max(0, Math.min(item.yMm, height - item.heightMm));
    }
  }
  function renderPage() {
    if (hasPrintMath(layout()) && !printMathReady() && !mathLoadStarted) {
      mathLoadStarted = true;preparePrintMath().then(() => {if (!disposed) renderPage();}).catch(error => {if (!disposed) status.textContent = `Equations could not be prepared: ${error.message}`;});
    }
    try {
      const selected = layout(), page = selected.page, grid = el("div");grid.className = "print-paper-grid";
      grid.style.cssText = `grid-template-columns:28px ${page.widthMm}mm;grid-template-rows:28px ${page.heightMm}mm;width:calc(28px + ${page.widthMm}mm)`;
      const corner = el("span", units);corner.className = "print-ruler-corner";corner.setAttribute("aria-hidden", "true");
      const svg = printPageSvg(selected, captures, activeId, {guides, preview: true});svg.setAttribute("role", "group");svg.setAttribute("aria-label", "Page frames");
      const aids = svgNode("g", {"data-print-editing-aids": "", class: "print-editing-aids"});
      for (const item of editableFrames()) {
        const outline = svgNode("rect", {x: item.xMm, y: item.yMm, width: item.widthMm, height: item.heightMm,
          fill: "transparent", class: `print-frame-outline${item.id === frameId ? " selected" : ""}`,
          "data-print-frame": item.id, tabindex: 0, role: "button", "aria-label": `Select ${item.title}`,
          "aria-pressed": String(item.id === frameId), "aria-disabled": String(busy || uncertain), "aria-describedby": help.id});
        aids.append(outline);
      }
      const item = frame(), size = Math.min(10, item.widthMm, item.heightMm);
      aids.append(svgNode("rect", {x: item.xMm + item.widthMm - size, y: item.yMm + item.heightMm - size,
        width: size, height: size, fill: "transparent", class: "print-frame-resize", "data-print-frame": item.id,
        "data-print-resize": "", tabindex: 0, role: "button", "aria-label": `Resize ${item.title}`,
        "aria-disabled": String(busy || uncertain), "aria-describedby": help.id}));
      for (const line of drag?.snapLines ?? []) aids.append(svgNode("line", {
        x1: line.axis === "x" ? line.positionMm : 0, x2: line.axis === "x" ? line.positionMm : page.widthMm,
        y1: line.axis === "y" ? line.positionMm : 0, y2: line.axis === "y" ? line.positionMm : page.heightMm,
        class: "print-snap-line", "aria-hidden": "true"}));
      svg.append(aids);grid.append(corner, ruler(page.widthMm, "horizontal"), ruler(page.heightMm, "vertical"), svg);stage.replaceChildren(grid);
    }
    catch (error) {stage.replaceChildren(el("p", error.message));}
  }
  function dimensionField(label, value, action) {
    const shown = units === "in" ? Number((value / 25.4).toFixed(4)) : value;
    const field = inputField(`${label} (${units})`, shown, "number", value => action(Math.round(Number(value) * (units === "in" ? 25.4 : 1) * 1000) / 1000));
    field.querySelector("input").step = units === "in" ? "0.01" : "0.1";return field;
  }
  function dataSourcePin(layer) {
    return {layerId: layer.layerId, datasetId: layer.datasetId ?? null,
      datasetVersionId: layer.datasetVersionId ?? null, sourceVersion: layer.sourceVersion ?? null};
  }
  function dataSourceLayers(mapItem) {
    const visible = new Set(mapItem.presentation.filter(item => item.visible !== false).map(item => item.layerId));
    return mapRecord.definition.layers.filter(layer => visible.has(layer.layerId));
  }
  function configureDataSource(item, layer) {
    item.source = dataSourcePin(layer);
    const context = workbench.getPrintContext?.(), fields = printDataSourceFields(context, layer.layerId);
    if (item.type === "chart" && fields.length === 1) throw Error("Choose a Layer with distinct chart label and numeric value fields.");
    if (item.type === "table") item.columns = fields.length ? fields.slice(0, 3) : item.columns ?? ["name"];
    else {
      const features = context?.getPrintDataSource?.(layer.layerId)?.geojson?.features ?? [];
      item.valueField = fields.find(field => features.slice(0, 100).some(feature => typeof feature.properties?.[field] === "number" && Number.isFinite(feature.properties[field])))
        ?? fields[1] ?? item.valueField ?? "value";
      item.labelField = fields.find(field => field !== item.valueField && features.slice(0, 100).some(feature => typeof feature.properties?.[field] === "string"))
        ?? fields.find(field => field !== item.valueField) ?? item.labelField ?? "name";
    }
  }
  function addDataFrame(type) {
    change(() => {
      if ((layout().dataFrames?.length ?? 0) >= 4) throw Error("A layout supports at most four data frames.");
      const mapItem = mapFrame(), context = workbench.getPrintContext?.();
      const layer = dataSourceLayers(mapItem).find(layer => printDataSourceFields(context, layer.layerId).length >= (type === "chart" ? 2 : 1));
      if (!layer) throw Error("Load a complete attribute Layer in this map before adding a source table or chart. Tiled, live-view and incomplete inputs remain unchanged.");
      const page = layout().page, widthMm = Math.max(20, Math.min(135, (page.widthMm - 3 * page.marginMm) / 2));
      const heightMm = Math.max(20, Math.min(70, page.heightMm - 2 * page.marginMm - 30));
      const item = {id: crypto.randomUUID(), type, title: `${layer.title} · ${type === "table" ? "Attributes" : "Values"}`,
        xMm: type === "table" ? page.marginMm : page.widthMm - page.marginMm - widthMm,
        yMm: Math.max(0, Math.min(105, page.heightMm - page.marginMm - heightMm - 15)), widthMm, heightMm,
        mapFrameId: mapItem.id, source: dataSourcePin(layer), rowLimit: 5,
        ...(type === "table" ? {columns: []} : {chartType: "bar", labelField: "name", valueField: "value", altText: `Individual recorded values from ${layer.title}`.slice(0, 300)})};
      configureDataSource(item, layer);(layout().dataFrames ??= []).push(item);frameId = item.id;
    });
  }
  function renderDataFrameControls(item) {
    const context = workbench.getPrintContext?.(), linkedMap = layout().frames.find(frame => frame.id === item.mapFrameId);
    controls.append(el("h3", item.type === "table" ? "Source table" : "Source chart"),
      el("small", "Arrange data frames with the same page, drag and size controls. Capture their linked map after changing source fields; rows come only from already loaded attributes, not viewport tiles or provider requests."),
      inputField("Data frame title", item.title, "text", value => change(() => {item.title = value;})),
      selectField("Data map frame", item.mapFrameId, layout().frames.map(frame => [frame.id, frame.title]), value => change(() => {
        const next = layout().frames.find(frame => frame.id === value), sources = dataSourceLayers(next);
        if (!sources.length) throw Error("Choose a map frame with a visible source Layer.");
        item.mapFrameId = value;configureDataSource(item, sources[0]);
      })),
      selectField("Data Layer", item.source.layerId, dataSourceLayers(linkedMap).map(layer => [layer.layerId, layer.title]), value => change(() => {
        configureDataSource(item, mapRecord.definition.layers.find(layer => layer.layerId === value));
      })), inputField("Maximum data rows", item.rowLimit, "number", value => change(() => {item.rowLimit = Number(value);})));
    const current = item.type === "table" ? item.columns : [item.labelField, item.valueField];
    const fields = [...new Set([...printDataSourceFields(context, item.source.layerId), ...current])];
    if (item.type === "table") {
      const label = el("label", "Table columns"), select = el("select");select.multiple = true;select.size = Math.min(6, Math.max(2, fields.length));select.setAttribute("aria-label", "Table columns");
      for (const field of fields) {const option = el("option", field);option.value = field;option.selected = item.columns.includes(field);select.append(option);}
      select.onchange = () => change(() => {item.columns = [...select.selectedOptions].map(option => option.value);});label.append(select);controls.append(label);
    } else controls.append(selectField("Chart type", item.chartType, [["bar", "Bar"], ["line", "Line"]], value => change(() => {item.chartType = value;})),
      selectField("Chart labels", item.labelField, fields.map(field => [field, field]), value => change(() => {item.labelField = value;})),
      selectField("Chart values", item.valueField, fields.map(field => [field, field]), value => change(() => {item.valueField = value;})),
      inputField("Chart description", item.altText, "text", value => change(() => {item.altText = value;})));
    controls.append(button("Remove data frame", () => change(() => {
      layout().dataFrames = layout().dataFrames.filter(frame => frame.id !== item.id);
      if (!layout().dataFrames.length) delete layout().dataFrames;frameId = item.mapFrameId;
    })));
  }
  function ruler(length, direction) {
    const strip = el("div");strip.className = `print-ruler ${direction}`;strip.setAttribute("aria-hidden", "true");
    for (const tick of printRulerTicks(length, units)) {
      const mark = el("span");mark.className = `print-ruler-tick${tick.major ? " major" : ""}`;
      mark.style[direction === "horizontal" ? "left" : "top"] = `${tick.mm / length * 100}%`;
      if (tick.label) mark.append(el("span", tick.label));strip.append(mark);
    }
    return strip;
  }
  function focusFrame(resize = false) {
    [...stage.querySelectorAll("[data-print-frame]")].find(node => node.getAttribute("data-print-frame") === frameId
      && node.hasAttribute("data-print-resize") === resize)?.focus({preventScroll: true});
  }
  function selectFrame(id, resize = false) {
    if (busy || uncertain || disposed || drag || !editableFrames().some(item => item.id === id)) return;
    frameId = id;render();focusFrame(resize);status.textContent = `Selected ${frame().title}. Use the page or frame dimensions to arrange it.`;
  }
  function finishDrag(commit, repaint = true) {
    if (!drag) return;
    const gesture = drag;drag = null;
    try {if (stage.hasPointerCapture?.(gesture.pointerId)) stage.releasePointerCapture(gesture.pointerId);} catch {}
    if (commit) {
      try {
        validateProjectPrintLayouts(collection, mapRecord);
        if (canonicalJson(collection) !== canonicalJson(gesture.previous)) remember(gesture.previous);
        status.textContent = `${frame().title}: left ${frame().xMm} mm, top ${frame().yMm} mm; ${frame().widthMm} × ${frame().heightMm} mm.`;
      } catch (error) {collection = gesture.previous;status.textContent = error.message;}
    } else {collection = gesture.previous;status.textContent = "Frame adjustment canceled.";}
    if (repaint && !disposed) {render();focusFrame(gesture.resize);}
  }
  function updateDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId || disposed) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
    drag.moved = true;
    const dx = (event.clientX - drag.startX) / drag.rect.width * layout().page.widthMm;
    const dy = (event.clientY - drag.startY) / drag.rect.height * layout().page.heightMm;
    try {
      const options = {snap: snapping && !event.altKey, toleranceMm: 6 / drag.rect.width * layout().page.widthMm};
      const value = drag.resize ? resizePrintFrame(layout(), frameId, {...options,
        widthMm: drag.initial.widthMm + dx, heightMm: drag.initial.heightMm + dy})
        : movePrintFrame(layout(), frameId, {...options, xMm: drag.initial.xMm + dx, yMm: drag.initial.yMm + dy});
      for (const property of drag.resize ? ["widthMm", "heightMm"] : ["xMm", "yMm"]) frame()[property] = value[property];
      drag.snapLines = value.snapLines;renderPage();event.preventDefault();
    } catch (error) {finishDrag(false);status.textContent = error.message;}
  }
  stage.onpointerdown = event => {
    const target = event.target.closest?.("[data-print-frame]");
    if (!target || busy || uncertain || disposed || drag || event.button !== 0 || event.isPrimary === false) return;
    const rect = target.ownerSVGElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    frameId = target.getAttribute("data-print-frame");
    drag = {pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect,
      initial: structuredClone(frame()), previous: structuredClone(collection), resize: target.hasAttribute("data-print-resize"), snapLines: []};
    try {stage.setPointerCapture?.(event.pointerId);} catch {}
    event.preventDefault();render();stage.focus({preventScroll: true});
  };
  stage.onpointermove = updateDrag;
  stage.onpointerup = event => {if (drag?.pointerId === event.pointerId) {updateDrag(event);finishDrag(true);}};
  stage.onpointercancel = event => {if (drag?.pointerId === event.pointerId) finishDrag(false);};
  stage.onlostpointercapture = event => {if (drag?.pointerId === event.pointerId) finishDrag(false);};
  stage.onkeydown = event => {
    if (event.key === "Escape" && drag) {event.preventDefault();finishDrag(false);return;}
    if (busy || uncertain || disposed || drag || event.target.closest?.("input,select,textarea,[contenteditable]")) return;
    const command = event.ctrlKey || event.metaKey, lower = event.key.toLowerCase();
    if (command && !event.altKey && (lower === "z" || lower === "y")) {
      event.preventDefault();restore(lower === "y" || event.shiftKey ? redo : undo, lower === "y" || event.shiftKey ? undo : redo);focusFrame(Boolean(event.target.closest?.("[data-print-resize]")));return;
    }
    const target = event.target.closest?.("[data-print-frame]");
    if ((event.key === "Enter" || event.key === " ") && target) {
      event.preventDefault();selectFrame(target.getAttribute("data-print-frame"), target.hasAttribute("data-print-resize"));return;
    }
    if (command || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    if (target) frameId = target.getAttribute("data-print-frame");
    const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    event.preventDefault();change(() => {
      const value = target?.hasAttribute("data-print-resize")
        ? resizePrintFrame(layout(), frameId, {widthMm: frame().widthMm + dx, heightMm: frame().heightMm + dy})
        : movePrintFrame(layout(), frameId, {xMm: frame().xMm + dx, yMm: frame().yMm + dy});
      for (const property of target?.hasAttribute("data-print-resize") ? ["widthMm", "heightMm"] : ["xMm", "yMm"]) frame()[property] = value[property];
    });
    focusFrame(target?.hasAttribute("data-print-resize"));
  };
  async function output(format) {
    if (busy || drag || !await current()) return;
    busy = true;outputRunning = true;render();status.textContent = "Checking current map captures and page bounds…";
    try {
      const selected = structuredClone(layout());validateProjectPrintLayouts(collection, mapRecord);
      const activeCapture = captures.get(key(mapFrame())), currentLayers = workbench.getPrintContext?.()?.layers;
      const displays = layers => canonicalJson(layers.filter(layer => layer.managedDisplayId).map(layer => [layer.layerId, layer.managedDisplayId]));
      if (activeCapture && currentLayers && displays(activeCapture.presentation) !== displays(currentLayers)) {
        captures.delete(key(mapFrame()));render();
        throw Error("The map's tiled display selection changed. Capture this map frame again before exporting.");
      }
      if (selected.frames.some(item => !captures.has(key(item)))) throw Error("Capture every map frame before exporting this layout.");
      if (hasPrintMath(selected)) {status.textContent = "Preparing equations…";await preparePrintMath();if (!await current()) return;}
      status.textContent = `Composing ${outputDimensions(selected)}…`;
      const vector = ["vector-svg", "vector-print", "vector-pdf", "geospatial-pdf"].includes(format);
      const print = format === "print" || format === "vector-print";
      const svg = printPageSvg(selected, captures, activeId, {mapRepresentation: vector ? "vector" : "raster"}), serialized = new root.ownerDocument.defaultView.XMLSerializer().serializeToString(svg);
      const name = safeName(selected.title);
      if (format === "svg" || format === "vector-svg") download(new Blob([serialized], {type: "image/svg+xml"}), `${name}${vector ? ".vector" : ""}.svg`);
      else if (format === "vector-pdf" || format === "geospatial-pdf") {
        outputController = new AbortController();
        const registrations = format === "geospatial-pdf" ? printGeoPdfRegistrations(selected, captures, activeId) : [];
        status.textContent = "Preparing vector PDF and embedding the page font…";
        const [{compilePrintVectorPdf}, {printFontAttachments}] = await Promise.all([import("../lib/printVectorPdf.js"), import("../lib/printFontAttachments.js")]);
        const font = await printFontAttachments();if (!await current()) return;
        const result = await compilePrintVectorPdf({svg, layout: selected, ...font, registrations,
          signal: outputController.signal, onPhase: message => {if (!disposed) status.textContent = message;}});
        if (!await current()) return;
        download(result.blob, `${name}${registrations.length ? ".geospatial" : ".vector"}.pdf`);
      }
      else if (format === "pack") {
        status.textContent = `Rasterizing ${outputDimensions(selected)} for the figure pack…`;
        const page = await pageImages(serialized, selected);
        if (!await current()) return;
        status.textContent = "Packaging page images, paper PDF, source metadata and file hashes…";
        const {blob} = await compileFigurePrintPack({layout: selected, layoutId: activeId, captures: new Map(captures),
          svg: serialized, html: paperHtml(selected, serialized), ...page});
        if (!await current()) return;
        download(blob, `${name}.figure-print.zip`);
      }
      else if (format === "html" || print) {
        const html = paperHtml(selected, serialized);
        if (format === "html") download(new Blob([html], {type: "text/html"}), `${name}.html`);
        else {
          const frame = el("iframe");frame.title = "Print layout";frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px";
          frame.onload = () => {if (!disposed && root.isConnected) {frame.contentWindow.focus();frame.contentWindow.print();status.textContent = `Print dialog requested for ${selected.page.widthMm} × ${selected.page.heightMm} mm. Complete or cancel it in your browser.`;}};frame.srcdoc = html;root.append(frame);
          frame.contentWindow?.addEventListener("afterprint", () => frame.remove(), {once: true});
        }
      } else {
        status.textContent = `Rasterizing ${outputDimensions(selected)}…`;
        const blob = await pagePng(serialized, selected);if (!await current()) return;download(blob, `${name}.png`);
      }
      status.textContent = print ? `Preparing the browser print dialog for ${selected.page.widthMm} × ${selected.page.heightMm} mm…`
        : `Page output prepared: ${outputDimensions(selected)}. Layout settings and source data are unchanged.`;
    } catch (error) {status.textContent = error.message;}
    finally {busy = false;outputRunning = false;outputController = null;if (!disposed) render();}
  }
  render();status.textContent = "Capture each map frame to compose this page. Opening Print Studio does not save a layout or start a render job.";
  return root;
}

export async function capturePrintMap(context, mapRecord, {dataFrames = [], outputFrame, signal, onPhase} = {}) {
  let captured;
  if (outputFrame) {
    const target = printCaptureTarget(outputFrame, outputFrame.dpi);
    if (typeof context?.withPrintResolution !== "function") throw Error("This map cannot capture at Print resolution. Reopen its MapLibre view, then capture again.");
    captured = await context.withPrintResolution({...target, signal, onPhase}, temporary => capturePrintCanvas(temporary, mapRecord, dataFrames, temporary.printCaptureSignal ?? signal));
    captured.outputSignature = printCaptureOutputSignature(outputFrame, outputFrame.dpi);
  } else captured = await capturePrintCanvas(context, mapRecord, dataFrames, signal);
  return captured;
}

async function capturePrintCanvas(context, mapRecord, dataFrames, signal) {
  const map = context?.map;
  if (signal?.aborted) throw Error("Map capture canceled.");
  if (context?.renderer !== "maplibre" || !context.ready || !map?.isStyleLoaded?.() || map.areTilesLoaded?.() === false || map.isMoving?.()) throw Error("Wait for the MapLibre map and its visible Layers and Styles to finish loading and moving before capture.");
  const canvas = map.getCanvas(), width = canvas.width, height = canvas.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 20_000_000) throw Error("Map capture exceeds its 20 megapixel limit.");
  const captured = await new Promise((resolve, reject) => {
    const finish = (error, value) => {clearTimeout(timer);map.off?.("render", capture);signal?.removeEventListener("abort", cancel);error ? reject(error) : resolve(value);};
    const cancel = () => finish(Error("Map capture canceled."));
    const timer = setTimeout(() => finish(Error("The map did not produce a capture frame. Try Capture again after it is ready.")), 3000);
    function capture() {
      try {
        if (map.isMoving?.() || !map.isStyleLoaded() || map.areTilesLoaded?.() === false) throw Error("The map changed while capturing. Wait for it to settle, then capture again.");
        finish(null, collectPrintSnapshot(context, mapRecord, canvas, dataFrames));
      } catch (error) {finish(error);}
    }
    signal?.addEventListener("abort", cancel, {once: true});
    map.once("render", capture);map.triggerRepaint();
  });
  await Promise.all(captured.legend.filter(row => row.pointStyle).map(row => ensurePointSymbolAssets(row.pointStyle)));
  const bytes = Uint8Array.from(atob(captured.dataUrl.split(",")[1]), char => char.charCodeAt(0));
  captured.imageSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (signal?.aborted) throw Error("Map capture canceled.");
  return captured;
}

function collectPrintSnapshot(context, mapRecord, canvas, requestedDataFrames) {
  const map = context.map, width = canvas.width, height = canvas.height;
  const center = map.getCenter(), view = {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
  const cssWidth = canvas.clientWidth || width, cssHeight = canvas.clientHeight || height;
  const projection = map.getProjection?.()?.type ?? context.project?.projection ?? "mercator";
  const flat = view.pitch === 0 && projection === "mercator" && (context.project?.spatialBody?.id ?? "earth") === "earth";
  let dataUrl;
  try {dataUrl = canvas.toDataURL("image/png");} catch {throw Error("This map contains imagery that the browser cannot export. Its sources and access remain unchanged.");}
  if (!/^data:image\/png;base64,/.test(dataUrl) || dataUrl.length > 11_184_836) throw Error("The map image exceeds its 8 MiB capture allowance.");
  const presentation = context.layers.map(printLayerPresentation);
  const style = map.getStyle(), legend = [], displayNotes = [], numericLegends = [], continuousLegends = [], rasterLegends = [];
  for (const layer of context.layers.filter(item => item.visible !== false)) {
    const handle = context.handles.get(layer.layerId);
    const paints = style.layers.filter(item => handle?.layerIds?.includes(item.id) && !handle?.clusterLayerIds?.includes(item.id));
    if (!paints.length) throw Error(`${layer.title} is not installed in the rendered map. Resolve its loading or Style error before capture.`);
    const raster = capturePrintRasterLegend(layer, handle, paints);
    const pointRows = pointSymbolLegendRows(layer, paints, handle);
    const referencedRows = referencedNumericLegend(layer, paints, handle);
    if (raster) {
      if (raster.descriptor) rasterLegends.push({start: legend.length, count: raster.rows.length, ...raster.descriptor});
      legend.push(...raster.rows);
      if (raster.descriptor) displayNotes.push(raster.descriptor.note);
    }
    else if (pointRows) legend.push(...pointRows);
    else if (referencedRows) {
      if (referencedRows.intervals) numericLegends.push({start: legend.length, count: referencedRows.rows.length,
        layerId: layer.layerId, title: layer.title, field: referencedRows.field,
        intervals: referencedRows.intervals, note: referencedRows.note});
      if (referencedRows.continuous) continuousLegends.push({start: legend.length, count: referencedRows.rows.length,
        layerId: layer.layerId, title: layer.title, field: referencedRows.field, interpolation: "linear",
        stops: referencedRows.continuous.stops, noData: referencedRows.noData, note: referencedRows.note});
      legend.push(...referencedRows.rows);
      displayNotes.push(referencedRows.note);
    }
    else if (!layer.styleReference && layer.style?.renderer === "graduated") {
      const numeric = inlineNumericLegend(layer, paints);
      const entries = numeric?.entries ?? graduatedLegendEntries(layer.style.graduated);
      if (numeric) numericLegends.push({start: legend.length, count: entries.length, layerId: layer.layerId,
        title: layer.title, field: numeric.field, intervals: entries.filter(row => row.kind === "range")
          .map(({minimum, maximum, color}) => ({minimum, maximum, color})),
        noData: {label: entries.at(-1).label, color: entries.at(-1).color},
        note: "Only numeric values use these classes; missing or nonnumeric values use the separate no-data swatch."});
      for (const row of entries) legend.push({label: `${layer.title} · ${row.label}`, color: row.color});
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
  const dataFrames = capturePrintDataFrames(context, mapRecord, requestedDataFrames, presentation);
  let vectorScene, vectorUnavailable;
  try {vectorScene = capturePrintVectorScene(context, mapRecord);} catch (error) {vectorUnavailable = error.message;}
  return {dataUrl, width, height, cssWidth, cssHeight, view, presentation, signature: canonicalJson({view, presentation}), legend, numericLegends, continuousLegends, dataFrames, attribution, displayNotes, sourceMetadata, lines, metresPerPixel, flat,
    ...(rasterLegends.length ? {rasterLegends} : {}),
    ...(vectorScene ? {vectorScene} : {vectorUnavailable}),
    projectId: mapRecord.id, projectVersion: mapRecord.version};
}

function inlineNumericLegend(layer, paints) {
  if (!["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(layer.geometryType)) return null;
  const type = paints.some(part => part.type === "fill") ? "fill" : "line";
  const colors = paints.filter(part => part.type === type).map(part => part.paint?.[`${type}-color`]);
  const value = colors[0], normalized = normalizeGraduatedStyle(layer.style.graduated);
  // The renderer supplies its single-symbol fallback to the explicit no-data
  // branch. Describe that actual color rather than stale noDataColor metadata.
  if (!Array.isArray(value) || typeof value[3] !== "string"
    || !/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value[3])
    || colors.some(color => canonicalJson(color) !== canonicalJson(graduatedColorExpression(normalized, value[3])))) {
    throw Error(`${layer.title}: displayed numeric styling differs from its classes. Reload it before capturing its legend.`);
  }
  return {field: normalized.field, entries: graduatedLegendEntries({...normalized, noDataColor: value[3]})};
}

function referencedNumericLegend(layer, paints, handle) {
  if (!layer.styleReference || !["Polygon", "MultiPolygon", "LineString", "MultiLineString"].includes(layer.geometryType)) return null;
  const bound = handle?.boundStyle;
  const type = paints.some(part => part.type === "fill") || bound?.parts?.some(part => part.type === "fill") ? "fill" : "line", property = `${type}-color`;
  const colors = paints.filter(part => part.type === type).map(part => part.paint?.[property]);
  const boundColors = bound?.parts?.filter(part => part.type === type).map(part => part.paint?.[property]) ?? [];
  if (!colors.some(Array.isArray) && !boundColors.some(Array.isArray)) return null;
  if (!bound?.reference || !Array.isArray(bound.parts) || canonicalJson(bound.reference) !== canonicalJson(layer.styleReference)) {
    throw Error(`${layer.title}: the pinned Style is not resolved in this view. Reload it before capturing its legend.`);
  }
  if (canonicalJson(colors) !== canonicalJson(boundColors)) {
    throw Error(`${layer.title}: displayed styling differs from the pinned Style. Reload it before capturing its legend.`);
  }
  const unavailable = () => {
    const note = `${layer.title} · A print legend is unavailable for this Style encoding.`;
    return {rows: [{label: note}], note};
  };
  if (new Set(boundColors.map(canonicalJson)).size !== 1) return unavailable();
  const expression = boundColors[0], continuous = parseContinuousColorExpression(expression);
  if (continuous) return {...continuousLegendRows(continuous, layer.title), field: continuous.field, continuous};
  const input = expression?.[1], nullable = input?.[1], get = nullable?.[1];
  // Reusable thematic Styles coerce numeric strings and use -1 for missing or
  // nonnumeric values. That fallback belongs to its real interval, not an
  // invented exclusive no-data class.
  if (!Array.isArray(expression) || expression[0] !== "step" || expression.length < 5 || expression.length > 45 || expression.length % 2 !== 1
    || !Array.isArray(input) || input.length !== 3 || input[0] !== "to-number" || input[2] !== -1
    || !Array.isArray(nullable) || nullable.length !== 3 || nullable[0] !== "coalesce" || nullable[2] !== -1
    || !Array.isArray(get) || get.length !== 2 || get[0] !== "get" || typeof get[1] !== "string") return unavailable();
  const stops = expression.filter((_, index) => index >= 3 && index % 2 === 1);
  const swatches = [expression[2], ...expression.filter((_, index) => index >= 4 && index % 2 === 0)];
  if (!stops.every((stop, index) => Number.isFinite(stop) && (index === 0 || stop > stops[index - 1]))
    || !swatches.every(color => typeof color === "string" && /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(color))) return unavailable();
  const rows = swatches.map((color, index) => {
    const range = index === 0 ? `< ${stops[0]}` : index === swatches.length - 1 ? `≥ ${stops[index - 1]}` : `${stops[index - 1]} – < ${stops[index]}`;
    return {label: `${layer.title} · ${get[1]} ${range}`, color};
  });
  const note = `${layer.title} · ${get[1]} uses numeric conversion; missing values or failed conversions use -1.`;
  rows.push({label: note});
  return {rows, note, field: get[1], intervals: swatches.map((color, index) => ({color,
    minimum: index === 0 ? null : stops[index - 1], maximum: index === swatches.length - 1 ? null : stops[index]}))};
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

function numericGroupsForCapture(capture) {
  const groups = capture.numericLegends ?? [], starts = new Map();
  if (!Array.isArray(groups) || groups.length > 40) throw Error("Invalid captured numeric legends.");
  let end = 0;
  for (const group of groups) {
    const intervals = group?.intervals;
    if (!Number.isInteger(group?.start) || group.start < end || !Number.isInteger(group.count)
      || group.count < 1 || group.start + group.count > capture.legend.length
      || typeof group.layerId !== "string" || typeof group.title !== "string" || group.title.length > 500
      || typeof group.field !== "string" || !group.field.length || group.field.length > 100
      || !Array.isArray(intervals) || intervals.length < 2 || intervals.length > 22 || intervals.length > group.count
      || (group.note !== undefined && (typeof group.note !== "string" || group.note.length > 1000))) throw Error("Invalid captured numeric legends.");
    for (const [index, interval] of intervals.entries()) {
      if (!interval || typeof interval.color !== "string" || !/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(interval.color)
        || (index === 0 ? interval.minimum !== null : !Number.isFinite(interval.minimum) || interval.minimum !== intervals[index - 1].maximum)
        || (index === intervals.length - 1 ? interval.maximum !== null : !Number.isFinite(interval.maximum))
        || (interval.minimum !== null && interval.maximum !== null && interval.minimum >= interval.maximum)
        || capture.legend[group.start + index]?.color !== interval.color) throw Error("Invalid captured numeric intervals.");
    }
    if (group.noData && (typeof group.noData.label !== "string" || group.noData.label.length > 100
      || typeof group.noData.color !== "string" || !/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(group.noData.color)
      || capture.legend[group.start + intervals.length]?.color !== group.noData.color)) throw Error("Invalid captured no-data swatch.");
    starts.set(group.start, group);end = group.start + group.count;
  }
  return starts;
}

function appendClassedColorBar(svg, group, x, y, width) {
  const bar = svgNode("g", {"data-classed-color-bar": group.layerId, role: "img", "aria-label": `${group.title} · ${group.field} classed color bar`});
  svg.append(bar);
  const text = (label, offset = 0, size = 2.3) => {
    for (const line of wrapWords(label, Math.max(8, Math.floor((width - offset) / 1.15)))) {
      bar.append(svgText(line, x + offset, y, size));y += 3.5;
    }
  };
  text(`${group.title} · ${group.field}`, 0, 2.5);
  text("Equal-height class bands");y += 1;
  const labels = group.intervals.map(interval => interval.minimum === null ? `< ${interval.maximum}`
    : interval.maximum === null ? `≥ ${interval.minimum}` : `${interval.minimum} – < ${interval.maximum}`);
  const rows = labels.map(label => wrapWords(label, Math.max(8, Math.floor((width - 6) / 1.15))));
  const height = Math.max(5, ...rows.map(lines => lines.length * 3.5 + 1.5));
  const start = y;
  group.intervals.forEach((interval, index) => {
    const top = start + index * height;
    bar.append(svgNode("rect", {x, y: top, width: 4, height, fill: interval.color, stroke: "#17212b", "stroke-width": 0.15,
      "data-color-bar-interval": index}));
    rows[index].forEach((line, lineIndex) => bar.append(svgText(line, x + 6, top + 3 + lineIndex * 3.5, 2.3)));
  });
  y = start + height * group.intervals.length + 4;
  if (group.noData) {
    bar.append(svgNode("rect", {x, y: y - 2, width: 4, height: 2.5, fill: group.noData.color, stroke: "#17212b", "stroke-width": 0.15,
      "data-color-bar-no-data": "true"}));text(group.noData.label, 6);y += 1.5;
  }
  if (group.note) text(group.note);
  return y + 3;
}

function appendContinuousColorBar(svg, group, x, y, width) {
  // Numeric values remain exact. Reserve a conservative full em per character
  // instead of truncating labels or drawing them outside the available paper.
  if (Math.max(...group.stops.map(stop => String(stop.value).length)) * 2.3 > width - 9) {
    throw Error("Widen the legend area to fit its continuous scale values.");
  }
  const raster = Object.hasOwn(group, "band");
  const bar = svgNode("g", {"data-continuous-color-bar": group.layerId,
    ...(raster ? {"data-raster-color-bar": group.layerId} : {}), role: "img",
    "aria-label": `${group.title} · ${group.field} continuous linear ${raster ? "grayscale display" : "color"} scale`});
  svg.append(bar);
  const text = (label, offset = 0, size = 2.3) => {
    for (const line of wrapWords(label, Math.max(8, Math.floor((width - offset) / 1.15)))) {
      bar.append(svgText(line, x + offset, y, size));y += 3.5;
    }
  };
  text(`${group.title} · ${group.field}`, 0, 2.5);text(raster ? "Continuous grayscale display" : "Continuous linear scale");y += 1;
  const first = group.stops[0].value, last = group.stops.at(-1).value;
  const height = Math.max(32, (group.stops.length - 1) * 4), top = y;
  const gradientId = `print-continuous-${group.start}`;
  const defs = svgNode("defs", {}), gradient = svgNode("linearGradient", {id: gradientId,
    x1: "0%", y1: "100%", x2: "0%", y2: "0%", "color-interpolation": "sRGB"});
  for (const stop of group.stops) gradient.append(svgNode("stop", {
    offset: (stop.value - first) / (last - first), "stop-color": stop.color,
    "data-continuous-stop": stop.value}));
  defs.append(gradient);bar.append(defs,
    svgNode("rect", {x, y: top, width: 4, height, fill: `url(#${gradientId})`, stroke: "#17212b",
      "stroke-width": 0.15, "data-continuous-ramp": "true"}));
  const ticks = [...group.stops].reverse().map(stop => ({value: stop.value,
    y: top + (last - stop.value) / (last - first) * height}));
  // Closely spaced values retain their true tick position. Leader lines place
  // their labels apart without changing the scale or inventing equal intervals.
  const labels = ticks.map(tick => tick.y);
  for (let i = 1; i < labels.length; i++) labels[i] = Math.max(labels[i], labels[i - 1] + 4);
  labels[labels.length - 1] = Math.min(labels.at(-1), top + height);
  for (let i = labels.length - 2; i >= 0; i--) labels[i] = Math.min(labels[i], labels[i + 1] - 4);
  ticks.forEach((tick, index) => {
    bar.append(svgNode("polyline", {points: `${x + 4},${tick.y} ${x + 6},${tick.y} ${x + 8},${labels[index]}`,
      fill: "none", stroke: "#17212b", "stroke-width": 0.2, "data-continuous-tick": tick.value}));
    bar.append(svgText(String(tick.value), x + 9, labels[index] + 0.8, 2.3));
  });
  y = top + height + 6;
  bar.append(svgNode("rect", {x, y: y - 2, width: 4, height: 2.5, fill: group.noData.color,
    stroke: "#17212b", "stroke-width": 0.15, "data-color-bar-no-data": "true"}));
  text(group.noData.label, 6);y += 1.5;text(group.note);
  return y + 3;
}

function printCellLabel(value, kind) {
  if (kind === "missing") return "[missing]";
  if (kind === "blank") return '\"\"';
  return value === null ? "null" : String(value);
}

function appendPrintDataFrame(svg, frame, snapshot, index, sourceTitle) {
  const x = frame.xMm, y = frame.yMm, width = frame.widthMm, height = frame.heightMm;
  if (frame.type === "chart" && width < 60) throw Error(`${frame.title}: give this chart at least 60 mm width.`);
  const clipId = `print-data-frame-${index}`, defs = svgNode("defs", {}), clip = svgNode("clipPath", {id: clipId});
  clip.append(svgNode("rect", {x, y, width, height}));defs.append(clip);svg.append(defs);
  const group = svgNode("g", {"data-print-data-frame": frame.id, "data-print-data-type": frame.type,
    role: frame.type === "chart" ? "img" : "group", "aria-label": frame.type === "chart" ? frame.altText : frame.title,
    "clip-path": `url(#${clipId})`});svg.append(group);
  group.append(svgNode("rect", {x, y, width, height, fill: "white", stroke: "#64748b", "stroke-width": 0.2}));
  const short = (value, space, size = 2.3) => {
    const text = String(value), limit = Math.max(3, Math.floor(space / size));
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  };
  const label = (value, px, py, space, size = 2.3) => {
    const node = svgText(short(value, space, size), px, py, size), title = svgNode("title", {});title.textContent = String(value);node.append(title);group.append(node);return node;
  };
  label(frame.title, x + 3, y + 5, width - 6, 3);
  const context = `Source: ${sourceTitle}. ${snapshot.scopeText} Map filter applies; map extent does not limit these rows.`;
  const contextLines = wrapWords(context, Math.max(8, Math.floor((width - 6) / 2.1)));
  let top = y + 9;
  for (const line of contextLines) {label(line, x + 3, top, width - 6, 2.1);top += 2.8;}
  const noticeText = [...snapshot.notices, frame.type === "table" ? "Long cells may be shortened on paper; captured values remain in the figure pack." : "Values describe individual shown records; unavailable values are gaps."].join(" ");
  const noticeLines = wrapWords(noticeText, Math.max(8, Math.floor((width - 6) / 2.1)));
  const bottom = y + height - 3 - noticeLines.length * 2.8;
  if (bottom - top < (frame.type === "table" ? (snapshot.rows.length + 1) * 4.5 : 22)) throw Error(`${frame.title}: give this data frame more height or show fewer rows.`);
  noticeLines.forEach((line, row) => label(line, x + 3, bottom + 3 + row * 2.8, width - 6, 2.1));
  if (frame.type === "table") {
    const columnWidth = (width - 6) / snapshot.columns.length, rowHeight = 4.5;
    snapshot.columns.forEach((column, col) => label(column, x + 3 + col * columnWidth, top + 3, columnWidth - 1, 2.4));
    group.append(svgNode("line", {x1: x + 3, x2: x + width - 3, y1: top + rowHeight, y2: top + rowHeight, stroke: "#64748b", "stroke-width": 0.2}));
    snapshot.rows.forEach((row, rowIndex) => row.forEach((value, col) => {
      const text = label(printCellLabel(value, snapshot.cellKinds[rowIndex][col]), x + 3 + col * columnWidth,
        top + rowHeight * (rowIndex + 1) + 3, columnWidth - 1);
      text.setAttribute("data-print-cell", `${rowIndex}:${col}`);text.setAttribute("data-cell-kind", snapshot.cellKinds[rowIndex][col]);
    }));
    if (!snapshot.rows.length) label("No matching loaded records.", x + 3, top + 8, width - 6);
    return;
  }
  const values = snapshot.rows.map(row => row[1]), numbers = values.filter(value => typeof value === "number");
  if (!numbers.length) {label("No supported numeric values in these rows.", x + 3, top + 7, width - 6);return;}
  const minimum = Math.min(0, ...numbers), maximum = Math.max(0, ...numbers), span = maximum - minimum || 1;
  if (frame.chartType === "bar") {
    const left = x + Math.min(35, width * 0.3), right = x + width - 18, zero = left + (0 - minimum) / span * (right - left);
    const step = (bottom - top - 7) / snapshot.rows.length;
    if (step < 4) throw Error(`${frame.title}: give this chart more height or show fewer rows.`);
    label(`${frame.valueField}: ${minimum} to ${maximum}`, left, top + 2.5, right - left + 14, 2.1);
    group.append(svgNode("line", {x1: zero, x2: zero, y1: top + 4, y2: bottom - 1, stroke: "#64748b", "stroke-width": 0.2}));
    snapshot.rows.forEach((row, rowIndex) => {
      const py = top + 5 + rowIndex * step, value = row[1];
      label(printCellLabel(row[0], snapshot.cellKinds[rowIndex][0]), x + 3, py + 2.5, left - x - 5);
      if (typeof value !== "number") {label("gap", left + 2, py + 2.5, right - left, 2.1);return;}
      const position = left + (value - minimum) / span * (right - left);
      group.append(svgNode("rect", {x: Math.min(zero, position), y: py, width: Math.abs(position - zero), height: Math.min(3.3, step - 1), fill: "#2563eb", "data-print-bar": rowIndex}));
      label(String(value), right + 2, py + 2.5, x + width - right - 4, 2.1);
    });
  } else {
    const left = x + 12, right = x + width - 4, high = top + 5, low = bottom - 7;
    label(`${frame.valueField} · shown rows`, left, top + 2, right - left, 2.1);
    const py = value => low - (value - minimum) / span * (low - high), px = row => left + row / Math.max(1, snapshot.rows.length - 1) * (right - left);
    group.append(svgNode("line", {x1: left, x2: right, y1: py(0), y2: py(0), stroke: "#64748b", "stroke-width": 0.2}));
    label(String(maximum), x + 2, high + 1, 9, 2);label(String(minimum), x + 2, low, 9, 2);
    let run = [];
    const flush = () => {if (run.length > 1) group.append(svgNode("polyline", {points: run.map(point => point.join(",")).join(" "), fill: "none", stroke: "#2563eb", "stroke-width": 0.5, "data-print-line-run": ""}));run = [];};
    snapshot.rows.forEach((row, rowIndex) => {
      label(printCellLabel(row[0], snapshot.cellKinds[rowIndex][0]), Math.max(left, px(rowIndex) - 5), low + 4, Math.max(6, (right - left) / Math.max(1, snapshot.rows.length)), 2);
      if (typeof row[1] !== "number") {flush();return;}
      const point = [px(rowIndex), py(row[1])];run.push(point);
      group.append(svgNode("circle", {cx: point[0], cy: point[1], r: 0.8, fill: "#2563eb", "data-print-line-point": rowIndex}));
      label(String(row[1]), Math.max(left, point[0] - 3), point[1] - 1.5, Math.min(16, right - Math.max(left, point[0] - 3)), 2);
    });flush();
  }
}

export function printPageSvg(layout, captures, layoutId, {guides = false, preview = false, mapRepresentation = "raster"} = {}) {
  if (!["raster", "vector"].includes(mapRepresentation)) throw Error("Choose raster or vector map output.");
  if (layout.legendFormat !== undefined && !["swatches", "classed-bars", "color-bars"].includes(layout.legendFormat)) throw Error("Invalid print legend format.");
  if (!preview) for (const frame of layout.frames) {
    const captured = captures.get(`${layoutId}:${frame.id}`);
    if (captured && (captured.signature !== canonicalJson({view: frame.view, presentation: frame.presentation})
      || captured.outputSignature !== undefined && captured.outputSignature !== printCaptureOutputSignature(frame, layout.dpi)))
      throw Error("Capture every map frame again after changing its view, styling, dimensions or DPI.");
  }
  const page = layout.page, svg = svgNode("svg", {xmlns: "http://www.w3.org/2000/svg", width: `${page.widthMm}mm`, height: `${page.heightMm}mm`, viewBox: `0 0 ${page.widthMm} ${page.heightMm}`, role: "img", "aria-label": layout.title});
  svg.style.cssText = "background:white;color:#17212b;max-width:none";
  const metadata = svgNode("metadata", {});metadata.textContent = JSON.stringify({layout,
    ...(mapRepresentation === "vector" ? {mapRepresentation: "vector", geographicRegistration: false} : {}),
    captures: layout.frames.map(frame => {const captured = captures.get(`${layoutId}:${frame.id}`);return captured ? {frameId: frame.id, projectId: captured.projectId, projectVersion: captured.projectVersion, imageSha256: captured.imageSha256, width: captured.width, height: captured.height,
      ...(captured.outputSignature !== undefined ? {outputSignature: captured.outputSignature} : {}),
      ...(mapRepresentation === "vector" ? {vectorMap: vectorSceneMetadata(captured)} : {}),
      continuousLegends: [...continuousLegendGroups(captured).values()],
      ...(captured.rasterLegends?.length ? {rasterLegends: [...rasterLegendGroups(captured).values()]} : {}),
      dataFrames: (layout.dataFrames ?? []).filter(item => item.mapFrameId === frame.id).map(item => {
        const snapshot = captured.dataFrames?.find(snapshot => snapshot.frameId === item.id);
        try {return assertPrintDataFrameSnapshot(item, snapshot, captured.presentation);} catch (error) {if (preview) return {frameId: item.id, captured: false};throw error;}
      })} : {frameId: frame.id, captured: false};})});svg.append(metadata);
  svg.append(svgNode("rect", {width: page.widthMm, height: page.heightMm, fill: "white"}));
  svg.append(svgText(layout.title, page.marginMm, 16, 5));
  if (guides) svg.append(svgNode("rect", {x: page.marginMm, y: page.marginMm, width: page.widthMm - 2 * page.marginMm, height: page.heightMm - 2 * page.marginMm, fill: "none", stroke: "#94a3b8", "stroke-width": 0.2, "stroke-dasharray": "2 2"}));
  const annotationText = (value, px, py, size, attributes = {}) => {
    const node = svgText(value, px, py, size);
    for (const [key, value] of Object.entries({stroke: "white", "stroke-width": 0.65, "stroke-linejoin": "round", "paint-order": "stroke fill", ...attributes})) node.setAttribute(key, value);
    return node;
  };
  // Conservative paper-space bounds avoid relying on a connected SVG/font measurement.
  const annotationWidth = (value, size) => String(value).length * size * 0.65;
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const [frameIndex, frame] of layout.frames.entries()) {
    const captured = captures.get(`${layoutId}:${frame.id}`);
    svg.append(svgNode("rect", {x: frame.xMm, y: frame.yMm, width: frame.widthMm, height: frame.heightMm, fill: "#f1f5f9", stroke: "#17212b", "stroke-width": 0.3}));
    if (!captured) {svg.append(svgText(`${frame.title} · capture map frame`, frame.xMm + 3, frame.yMm + 8, 3));continue;}
    const {x, y, width: w, height: h} = printMapPlacement(frame, captured);
    const clip = svgNode("clipPath", {id: `print-map-${frameIndex}`});clip.append(svgNode("rect", {x, y, width: w, height: h}));
    const definitions = svgNode("defs", {});definitions.append(clip);svg.append(definitions);
    const mapContent = svgNode("g", {"clip-path": `url(#print-map-${frameIndex})`});svg.append(mapContent);
    if (mapRepresentation === "vector") mapContent.append(vectorSceneSvg(captured, {x, y, width: w, height: h}));
    else mapContent.append(svgNode("image", {href: captured.dataUrl, x, y, width: w, height: h}));
    const occupied = [], furniture = [];
    if (layout.northArrow) {
      if (!captured.flat) throw Error("This north arrow requires an unpitched Earth Mercator frame. Adjust the map and capture again.");
      const px = x + w - 9, py = y + 11, angle = -captured.view.bearing * Math.PI / 180;
      const corners = [[-3.5, -11.5], [3.5, -11.5], [-3.5, 4.5], [3.5, 4.5]]
        .map(([dx, dy]) => [px + dx * Math.cos(angle) - dy * Math.sin(angle), py + dx * Math.sin(angle) + dy * Math.cos(angle)]);
      occupied.push({left: Math.min(...corners.map(point => point[0])), right: Math.max(...corners.map(point => point[0])), top: Math.min(...corners.map(point => point[1])), bottom: Math.max(...corners.map(point => point[1]))});
      const arrow = svgNode("g", {transform: `translate(${px} ${py}) rotate(${-captured.view.bearing})`});
      arrow.append(svgNode("path", {d: "M0 -6 L3 4 L0 2 L-3 4 Z", fill: "#17212b", stroke: "white", "stroke-width": 0.4}),
        annotationText("N", -1.5, -8, 3, {"data-print-north-label": ""}));furniture.push(arrow);
    }
    if (layout.scaleBar) {
      if (!captured.flat || !(captured.metresPerPixel > 0)) throw Error("A measured scale bar requires an unpitched Earth Mercator frame. Adjust the map and capture again.");
      const target = captured.metresPerPixel * captured.cssWidth / 4, magnitude = 10 ** Math.floor(Math.log10(target));
      const metres = [1, 2, 5, 10].map(value => value * magnitude).filter(value => value <= target).at(-1);
      const length = metres / (captured.metresPerPixel * captured.cssWidth) * w, start = x + 4, end = start + length;
      const distance = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, note = "at map center";
      const distanceSize = Math.min(2, (x + w - 1 - end) / annotationWidth(distance, 1));
      const noteSize = Math.min(2, (w - 2) / annotationWidth(note, 1));
      const noteX = Math.max(x + 1, Math.min(start, x + w - 1 - annotationWidth(note, noteSize)));
      if (!(distanceSize > 0 && noteSize > 0)) throw Error("Give this map frame more width for its scale labels.");
      occupied.push({left: Math.min(noteX, start - annotationWidth("0", 2)) - 0.5, right: Math.max(end + annotationWidth(distance, distanceSize), noteX + annotationWidth(note, noteSize)) + 0.5, top: y + h - 11.5, bottom: y + h - 1.3});
      furniture.push(svgNode("rect", {x: start, y: y + h - 7, width: length, height: 1.4, fill: "none", stroke: "white", "stroke-width": 0.95, "data-print-scale-bar": "casing"}),
        svgNode("rect", {x: start, y: y + h - 7, width: length, height: 1.4, fill: "white", stroke: "#17212b", "stroke-width": 0.3, "data-print-scale-bar": "full"}),
        svgNode("rect", {x: start, y: y + h - 7, width: length / 2, height: 1.4, fill: "#17212b", "data-print-scale-bar": "half"}),
        annotationText("0", start, y + h - 9, 2, {"text-anchor": "end", "data-print-scale-label": "start"}),
        annotationText(distance, end, y + h - 9, distanceSize, {"data-print-scale-label": "end"}),
        annotationText(note, noteX, y + h - 2.5, noteSize, {"data-print-scale-label": "note"}));
    }
    if (layout.graticule && !captured.flat) throw Error("Latitude/longitude grids require an unpitched Earth Mercator frame. Adjust the map and capture again.");
    const grid = [];
    if (layout.graticule) for (const line of captured.lines) {
      const points = line.points.map(point => [x + point[0] * w, y + point[1] * h]);
      const path = svgNode("polyline", {points: points.map(point => point.join(",")).join(" "), fill: "none", stroke: "#475569", "stroke-width": 0.15, "stroke-dasharray": "1 1", "data-print-grid-value": line.label});
      const title = svgNode("title", {});title.textContent = line.label;path.append(title);mapContent.append(path);
      grid.push({label: line.label, points: points.filter(point => point[0] >= x - 1e-6 && point[0] <= x + w + 1e-6 && point[1] >= y - 1e-6 && point[1] <= y + h + 1e-6)});
    }
    const placeGrid = reservations => {
      const bounds = [...reservations], labels = [];
      for (const line of grid) {
        const width = annotationWidth(line.label, 2);
        if (width + 1 > w || h < 5) continue;
        for (const point of line.points) {
          const px = Math.max(x + 0.5 + width / 2, Math.min(point[0], x + w - 0.5 - width / 2));
          const py = Math.max(y + 3, Math.min(point[1], y + h - 1));
          const box = {left: px - width / 2 - 0.4, right: px + width / 2 + 0.4, top: py - 2.4, bottom: py + 0.8};
          if (bounds.some(other => overlaps(box, other))) continue;
          bounds.push(box);labels.push(annotationText(line.label, px, py, 2, {"text-anchor": "middle", "data-print-grid-label": line.label}));break;
        }
      }
      return labels;
    };
    let gridLabels = placeGrid(occupied);
    if (gridLabels.length < grid.length) {
      const noteWidth = Math.max(8, w - (layout.northArrow ? 18 : 2)), noteSize = Math.min(2, (w - 2) / annotationWidth("omitted;", 1));
      const rows = wrapWords("Grid labels omitted; enlarge frame.", Math.max(8, Math.floor(noteWidth / (noteSize * 0.65))));
      const noteBottom = y + 1 + rows.length * noteSize * 1.5;
      gridLabels = placeGrid([...occupied, {left: x, right: x + noteWidth + 2, top: y, bottom: noteBottom + 1}]);
      rows.forEach((row, index) => mapContent.append(annotationText(row, x + 1, y + 1 + (index + 1) * noteSize * 1.5, noteSize, {"data-print-grid-notice": ""})));
    }
    mapContent.append(...gridLabels);svg.append(...furniture);
  }
  const main = layout.frames[0], mainCapture = captures.get(`${layoutId}:${main.id}`);
  let legendBottom = null;
  if (layout.legend && mainCapture) {
    const x = main.xMm + main.widthMm + 4, y = main.yMm;
    if (x + 30 > page.widthMm) throw Error("Leave at least 30 mm beside the main frame for its legend, or hide the legend.");
    svg.append(svgText("Legend", x, y + 4, 3.2));
    const swatchWidth = Math.max(4, ...mainCapture.legend.map(row => pointLegendSize(row) + 1));
    const numericGroups = ["classed-bars", "color-bars"].includes(layout.legendFormat) ? numericGroupsForCapture(mainCapture) : new Map();
    const continuousGroups = layout.legendFormat === "color-bars" ? continuousLegendGroups(mainCapture) : new Map();
    const rasterGroups = layout.legendFormat === "color-bars" ? rasterLegendGroups(mainCapture) : new Map();
    let groupEnd = 0;
    for (const group of [...numericGroups.values(), ...continuousGroups.values(), ...rasterGroups.values()].sort((a, b) => a.start - b.start)) {
      if (group.start < groupEnd) throw Error("Invalid overlapping captured color bars.");
      groupEnd = group.start + group.count;
    }
    let cursor = y + 9;
    if (["classed-bars", "color-bars"].includes(layout.legendFormat) && !numericGroups.size && !continuousGroups.size && !rasterGroups.size) {
      for (const line of wrapWords("No supported numeric color bar; swatches retained.", Math.max(8, Math.floor((page.widthMm - page.marginMm - x) / 1.15)))) {
        svg.append(svgText(line, x, cursor, 2.3));cursor += 3.5;
      }
      cursor += 2;
    }
    for (let index = 0; index < mainCapture.legend.length; index++) {
      const continuous = continuousGroups.get(index) ?? rasterGroups.get(index);
      if (continuous) {cursor = appendContinuousColorBar(svg, continuous, x, cursor, page.widthMm - page.marginMm - x);index += continuous.count - 1;continue;}
      const group = numericGroups.get(index);
      if (group) {cursor = appendClassedColorBar(svg, group, x, cursor, page.widthMm - page.marginMm - x);index += group.count - 1;continue;}
      const row = mainCapture.legend[index];
      const size = pointLegendSize(row);
      if (row.pointStyle) {
        if (typeof row.opacity !== "number" || !Number.isFinite(row.opacity) || row.opacity < 0 || row.opacity > 1) throw Error("Invalid point legend opacity.");
        if (mapRepresentation === "vector") {
          const preview = new document.defaultView.DOMParser().parseFromString(pointSymbolPreviewSvg(row.pointStyle), "image/svg+xml");
          if (preview.querySelector("parsererror")) throw Error("The point legend could not be composed as vector shapes.");
          const glyph = svgNode("g", {transform: `translate(${x} ${cursor - 2}) scale(${size / 64})`,
            opacity: row.opacity, "data-print-point-legend": row.pointStyle.pointSymbol});
          for (const child of preview.documentElement.children) glyph.append(document.importNode(child, true));
          svg.append(glyph);
        } else svg.append(svgNode("image", {x, y: cursor - 2, width: size, height: size, opacity: row.opacity,
          href: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pointSymbolPreviewSvg(row.pointStyle))}`,
          "data-point-symbol": row.pointStyle.pointSymbol}));
      } else if (row.color) svg.append(svgNode("rect", {x, y: cursor - 2, width: 3, height: 2.5, fill: row.color, stroke: "#17212b", "stroke-width": 0.1}));
      const lines = wrapWords(row.label, Math.max(8, Math.floor((page.widthMm - page.marginMm - x - swatchWidth) / 1.15)));
      const start = cursor;
      for (const line of lines) {svg.append(svgText(line, x + swatchWidth, cursor, 2.3));cursor += 3.5;}
      cursor = Math.max(cursor, start + size) + 1.5;
    }
    if (cursor > page.heightMm - 10) throw Error("The legend is taller than this page. Choose a larger page or reduce its included Layers/classes.");
    legendBottom = cursor;
  }
  for (const [index, frame] of (layout.dataFrames ?? []).entries()) {
    if (legendBottom !== null && frame.xMm < page.widthMm - page.marginMm && frame.xMm + frame.widthMm > main.xMm + main.widthMm + 4
      && frame.yMm < legendBottom && frame.yMm + frame.heightMm > main.yMm) {
      if (!preview) throw Error(`${frame.title}: move this data frame away from the map legend.`);
      svg.append(svgNode("rect", {x: frame.xMm, y: frame.yMm, width: frame.widthMm, height: frame.heightMm, fill: "none", stroke: "#c2410c", "stroke-width": 0.4}),
        svgText("Move this data frame away from the legend.", frame.xMm + 2, frame.yMm + 6, 2.2));continue;
    }
    const captured = captures.get(`${layoutId}:${frame.mapFrameId}`), snapshot = captured?.dataFrames?.find(item => item.frameId === frame.id);
    try {assertPrintDataFrameSnapshot(frame, snapshot, captured?.presentation);} catch (error) {
      if (!preview) throw error;
      svg.append(svgNode("rect", {x: frame.xMm, y: frame.yMm, width: frame.widthMm, height: frame.heightMm, fill: "#f8fafc", stroke: "#64748b", "stroke-width": 0.2}),
        svgText(`${frame.title.slice(0, 35)} · capture linked map`, frame.xMm + 2, frame.yMm + 6, 2.3));continue;
    }
    const source = captured.sourceMetadata?.find(source => source.layerId === frame.source.layerId);
    try {appendPrintDataFrame(svg, frame, snapshot, index, source?.title ?? frame.source.layerId);} catch (error) {
      if (!preview) throw error;
      svg.append(svgNode("rect", {x: frame.xMm, y: frame.yMm, width: frame.widthMm, height: frame.heightMm, fill: "#fff7ed", stroke: "#c2410c", "stroke-width": 0.2}),
        svgText("Increase this data frame's height or show fewer rows.", frame.xMm + 2, frame.yMm + 6, 2.2));
    }
  }
  for (const item of layout.textFrames ?? []) if (legendBottom !== null && item.xMm < page.widthMm - page.marginMm
    && item.xMm + item.widthMm > main.xMm + main.widthMm + 4 && item.yMm < legendBottom && item.yMm + item.heightMm > main.yMm)
    throw Error(`${item.title}: move this text block away from the map legend.`);
  appendPrintTextFrames(svg, layout, {preview});
  const licenses = [...new Set(layout.frames.flatMap(frame => captures.get(`${layoutId}:${frame.id}`)?.sourceMetadata ?? [])
    .map(source => `${plainText(source.title ?? "Layer")} · License: ${typeof source.license === "string" && source.license.trim() ? plainText(source.license).trim() : "not recorded"}`))];
  const notes = [...new Set(layout.frames.flatMap(frame => captures.get(`${layoutId}:${frame.id}`)?.attribution ?? [])), ...licenses,
    ...(layout.sourceNotes ? [...new Set(layout.frames.flatMap(frame => captures.get(`${layoutId}:${frame.id}`)?.displayNotes ?? []))] : []),
    ...(layout.sourceNotes && mainCapture ? [`Project ${mainCapture.projectId} · revision ${mainCapture.projectVersion}`] : []), layout.caption].filter(Boolean).join(" · ");
  const maximum = Math.floor((page.widthMm - 2 * page.marginMm) / 1.1);
  const words = notes.split(/\s+/), rows = [];let row = "";
  for (const word of words) {if ((row + " " + word).length > maximum && row) {rows.push(row);row = word;} else row += `${row ? " " : ""}${word}`;}
  if (row) rows.push(row);
  const top = Math.max(...[...layout.frames, ...(layout.dataFrames ?? []), ...(layout.textFrames ?? [])].map(frame => frame.yMm + frame.heightMm)) + 5;
  if (rows.length && legendBottom !== null && legendBottom > top - 2) throw Error("The legend overlaps source notes. Widen the legend area or reduce its included Layers/classes.");
  if (rows.length && top + rows.length * 3 > page.heightMm - 2) throw Error("Source notes need more page space. Reduce map height or use a larger page.");
  rows.forEach((line, index) => svg.append(svgText(line, page.marginMm, top + index * 3, 2.2)));
  return svg;
}

function checkedVectorScene(captured) {
  if (!captured.vectorScene) throw Error(`Vector map output is unavailable. ${captured.vectorUnavailable ?? "Capture this frame again to check its complete loaded geometry."}`);
  return assertPrintVectorScene(captured.vectorScene, captured);
}

function vectorSceneMetadata(captured) {
  const scene = checkedVectorScene(captured);
  return {schemaVersion: scene.schemaVersion, checksumSha256: scene.checksumSha256, sourcePins: scene.sourcePins,
    ...(scene.georeference ? {georeference: scene.georeference} : {}),
    passes: scene.passes.map(pass => ({id: pass.id, type: pass.type, layerId: pass.layerId,
      layerOpacity: pass.layerOpacity, commandCount: pass.commands.length}))};
}

function vectorSceneSvg(captured, {x, y, width, height}) {
  const scene = checkedVectorScene(captured);
  const group = svgNode("g", {"data-print-vector-map": scene.checksumSha256,
    transform: `translate(${x} ${y}) scale(${width / scene.cssWidth} ${height / scene.cssHeight})`});
  for (const pass of scene.passes) {
    const part = svgNode("g", {"data-print-vector-pass": pass.id, opacity: pass.layerOpacity});
    for (const command of pass.commands) {
      const paint = {fill: command.fill ?? "none", "fill-opacity": command.fillOpacity,
        stroke: command.stroke ?? "none", "stroke-opacity": command.strokeOpacity, "stroke-width": command.strokeWidth};
      if (command.kind === "path") {
        const d = command.points.map(points => points.map(([px, py], index) => `${index ? "L" : "M"}${px} ${py}`).join(" ") + (command.closed ? " Z" : "")).join(" ");
        part.append(svgNode("path", {d, ...paint, "fill-rule": "evenodd", "stroke-linecap": command.lineCap,
          "stroke-linejoin": command.lineJoin, "stroke-miterlimit": command.miterLimit}));
      } else if (command.kind === "circle") part.append(svgNode("circle", {cx: command.cx, cy: command.cy, r: command.r, ...paint}));
      else part.append(svgNode("rect", {x: command.x, y: command.y, width: command.width, height: command.height, ...paint}));
    }
    group.append(part);
  }
  return group;
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
