import * as Plot from "@observablehq/plot";
import {arc, pie} from "d3";
import {
  PROJECT_WIDGET_TYPES, moveNarrativeItem, newDashboardWidget, newStoryChapter, storyLocation
} from "../lib/projectNarrative.js";

function element(document, name, text) {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(document, text, action) {
  const node = element(document, "button", text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function field(document, label, value, update, {multiline = false, type = "text"} = {}) {
  const wrapper = element(document, "label", label);
  const control = element(document, multiline ? "textarea" : "input");
  if (!multiline) control.type = type;
  if (type === "number") control.step = "any";
  control.value = value ?? "";
  control.setAttribute("aria-label", label);
  control.addEventListener("change", () => update(type === "number" ? control.valueAsNumber : control.value));
  wrapper.append(control);
  return wrapper;
}

function choice(document, label, value, options, update) {
  const wrapper = element(document, "label", label);
  const control = element(document, "select");
  control.setAttribute("aria-label", label);
  for (const [key, text] of options) {
    const option = element(document, "option", text);
    option.value = key;
    control.append(option);
  }
  if (value && !options.some(([key]) => key === value)) {
    const preserved = element(document, "option", value + " · preserved");
    preserved.value = value;
    control.append(preserved);
  }
  control.value = value ?? "";
  control.addEventListener("change", () => update(control.value));
  wrapper.append(control);
  return wrapper;
}

function orderButtons(document, items, index, commit) {
  const controls = element(document, "div");
  controls.className = "project-narrative-order";
  const previous = button(document, "Move up", () => commit(moveNarrativeItem(items, index, -1)));
  const next = button(document, "Move down", () => commit(moveNarrativeItem(items, index, 1)));
  previous.disabled = index === 0;
  next.disabled = index === items.length - 1;
  controls.append(previous, next, button(document, "Remove", () => commit(items.filter((_, current) => current !== index))));
  return controls;
}

/** Edits the native storymap record through the existing Project save boundary. */
export function ProjectStoryEditor({storymap, onChange, captureView, previewView, exportStory,
  editable = true, document = globalThis.document}) {
  const story = storymap && typeof storymap === "object" ? storymap : {title: "", chapters: []};
  const chapters = Array.isArray(story.chapters) ? story.chapters : [];
  const root = element(document, "section");
  root.className = "project-story-editor";
  root.setAttribute("aria-label", "Project story");
  const status = element(document, "p");
  status.setAttribute("role", "status");
  const commit = patch => {if (editable) onChange({...story, ...patch});};
  const commitChapters = next => commit({chapters: next});
  const updateChapter = (index, patch) => commitChapters(chapters.map((chapter, current) =>
    current === index ? {...chapter, ...patch} : chapter));
  root.append(element(document, "p", "Chapters and their map views are saved with this Project."));
  for (const [key, label] of [["title", "Story title"], ["subtitle", "Subtitle"], ["byline", "Byline"], ["footer", "Footer"]]) {
    root.append(field(document, label, story[key], value => commit({[key]: value}), {multiline: key === "footer"}));
  }
  root.append(choice(document, "Story theme", story.theme ?? "light", [["light", "Light"], ["dark", "Dark"]],
    value => commit({theme: value})));
  const list = element(document, "div");
  for (const [index, chapter] of chapters.entries()) {
    const card = element(document, "fieldset");
    card.className = "project-story-chapter";
    card.append(element(document, "legend", chapter.title || "Untitled chapter"));
    card.append(field(document, "Chapter title", chapter.title, title => updateChapter(index, {title})));
    card.append(field(document, "Chapter text", chapter.description, description => updateChapter(index, {description}), {multiline: true}));
    card.append(field(document, "Chapter image URL", chapter.image, image => updateChapter(index, {image})));
    card.append(choice(document, "Camera transition", chapter.mapAnimation ?? "flyTo",
      [["flyTo", "Fly"], ["easeTo", "Ease"], ["jumpTo", "Jump"]],
      mapAnimation => updateChapter(index, {mapAnimation})));
    const captured = chapter.location;
    if (captured?.center) {
      const camera = element(document, "div");
      for (const [label, value, patch] of [
        ["Longitude", captured.center[0], number => ({center: [number, captured.center[1]]})],
        ["Latitude", captured.center[1], number => ({center: [captured.center[0], number]})],
        ["Zoom", captured.zoom, zoom => ({zoom})],
        ["Pitch", captured.pitch, pitch => ({pitch})],
        ["Bearing", captured.bearing, bearing => ({bearing})]
      ]) camera.append(field(document, label, value, number => {
        try {updateChapter(index, {location: storyLocation({...captured, ...patch(number)})});}
        catch (error) {status.textContent = error.message;}
      }, {type: "number"}));
      card.append(camera);
    }
    const capture = button(document, "Capture current view", async () => {
      try {updateChapter(index, {location: storyLocation(await captureView())});}
      catch (error) {status.textContent = error.message;}
    });
    capture.disabled = typeof captureView !== "function";
    const preview = button(document, "Preview chapter", async () => {
      try {await previewView(storyLocation(chapter.location), chapter.mapAnimation ?? "flyTo");}
      catch (error) {status.textContent = error.message;}
    });
    preview.disabled = typeof previewView !== "function";
    preview.dataset.projectNarrativeViewAction = "true";
    card.append(capture, preview, orderButtons(document, chapters, index, commitChapters));
    list.append(card);
  }
  root.append(list);
  const add = button(document, "Add chapter from current view", async () => {
    try {commitChapters([...chapters, newStoryChapter(await captureView())]);}
    catch (error) {status.textContent = error.message;}
  });
  add.disabled = typeof captureView !== "function";
  const download = button(document, "Export story HTML", async () => {
    download.disabled = true;
    try {await exportStory(structuredClone(story));}
    catch (error) {status.textContent = error.message;}
    finally {download.disabled = !chapters.length || typeof exportStory !== "function";}
  });
  download.disabled = !chapters.length || typeof exportStory !== "function";
  download.dataset.projectNarrativeViewAction = "true";
  root.append(add, download, status);
  if (!editable) for (const control of root.querySelectorAll("input,select,textarea,button")) {
    if (!control.dataset.projectNarrativeViewAction) control.disabled = true;
  }
  return root;
}

function fieldsFor(data) {
  return [...new Set((data?.features ?? []).flatMap(feature => Object.keys(feature.properties ?? {})))].sort();
}

function pieChart(document, widget, rows, title) {
  const grouped = new Map();
  for (const row of rows) {
    const category = String(row[widget.category] ?? "(missing)");
    const values = grouped.get(category) ?? [];
    values.push(row[widget.valueField]);
    grouped.set(category, values);
  }
  const values = [...grouped].map(([label, entries]) => {
    const numeric = entries.filter(Number.isFinite);
    const total = numeric.reduce((sum, value) => sum + value, 0);
    return {label, value: widget.aggregation === "sum" ? total
      : widget.aggregation === "mean" ? (numeric.length ? total / numeric.length : 0) : entries.length};
  }).filter(item => item.value > 0);
  if (!values.length) throw Error("No positive values are available for this pie chart.");
  const root = element(document, "div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 280 220");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  const shape = arc().innerRadius(0).outerRadius(95);
  const color = widget.color || "#4269d0";
  for (const [index, slice] of pie().sort(null).value(item => item.value)(values).entries()) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", shape(slice));
    path.setAttribute("transform", "translate(140 110)");
    path.setAttribute("fill", color);
    path.setAttribute("fill-opacity", String(.35 + .65 * (index + 1) / values.length));
    const caption = document.createElementNS("http://www.w3.org/2000/svg", "title");
    caption.textContent = slice.data.label + " · " + slice.data.value;
    path.append(caption);
    svg.append(path);
  }
  const legend = element(document, "ul");
  for (const item of values) legend.append(element(document, "li", item.label + " · " + item.value));
  root.append(svg, legend);
  return root;
}

export function renderProjectDashboardWidget(widget, data, {document = globalThis.document} = {}) {
  const rows = (data?.features ?? []).map(feature => feature.properties ?? {});
  if (!rows.length) throw Error("Load this Layer to preview its widget.");
  const title = widget.title || widget.type;
  const color = widget.color || "#4269d0";
  if (widget.type === "pie") return pieChart(document, widget, rows, title);
  let mark;
  const numeric = field => rows.filter(row => Number.isFinite(row[field]));
  if (widget.type === "histogram") {
    mark = Plot.rectY(numeric(widget.field), Plot.binX({y: "count"}, {x: widget.field,
      thresholds: Number.isSafeInteger(widget.bins) && widget.bins > 0 ? widget.bins : 12, fill: color}));
  } else if (widget.type === "scatter") {
    mark = Plot.dot(rows.filter(row => Number.isFinite(row[widget.xField]) && Number.isFinite(row[widget.yField])),
      {x: widget.xField, y: widget.yField, fill: color});
  } else if (widget.type === "bar") {
    mark = Plot.barY(rows, Plot.groupX({y: ["sum", "mean"].includes(widget.aggregation) ? widget.aggregation : "count"},
      {x: widget.category, y: widget.valueField || undefined, fill: color}));
  } else if (widget.type === "line") {
    mark = Plot.lineY(numeric(widget.field), {y: widget.field, stroke: color});
  } else if (widget.type === "box") {
    mark = Plot.boxY(numeric(widget.field), {y: widget.field, fill: color});
  } else throw Error("This imported widget type is preserved. Choose a supported chart type to edit its display.");
  const chart = Plot.plot({document, width: 300, height: 220, marginLeft: 45, marks: [mark],
    style: {maxWidth: "100%", height: "auto", background: "transparent", fontFamily: "inherit"}});
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", title);
  return chart;
}

/** Uses loaded layer data and preserves each native widget identity and fields. */
export function ProjectDashboardEditor({widgets = [], dashboardColumns = 2, layers = [],
  dataByLayerId = new Map(), onChange, editable = true, document = globalThis.document}) {
  const root = element(document, "section");
  root.className = "project-dashboard-editor";
  root.setAttribute("aria-label", "Project dashboard");
  const records = Array.isArray(widgets) ? widgets : [];
  const commit = next => {if (editable) onChange({widgets: next, dashboardColumns});};
  root.append(element(document, "p", "Widgets use loaded Layer features. Save the Project to retain their settings and order."));
  const status = element(document, "p"); status.setAttribute("role", "status");
  const columnsField = field(document, "Dashboard columns", dashboardColumns, columns => {
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > 6) {status.textContent = "Choose between 1 and 6 dashboard columns.";return;}
    if (editable) onChange({widgets: records, dashboardColumns: columns});
  }, {type: "number"});
  const columnsInput = columnsField.querySelector("input"); columnsInput.min = "1"; columnsInput.max = "6"; columnsInput.step = "1";
  root.append(columnsField, status);
  const grid = element(document, "div");
  grid.className = "project-dashboard-grid";
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = `repeat(${Number.isSafeInteger(dashboardColumns) && dashboardColumns >= 1 && dashboardColumns <= 6 ? dashboardColumns : 2},minmax(0,1fr))`;
  grid.style.gap = "1rem";
  for (const [index, widget] of records.entries()) {
    const update = patch => commit(records.map((item, current) => current === index ? {...item, ...patch} : item));
    const card = element(document, "fieldset");
    card.className = "project-dashboard-widget";
    card.style.minWidth = "0";
    card.append(element(document, "legend", widget.title || widget.type));
    card.append(field(document, "Widget title", widget.title, title => update({title})));
    card.append(choice(document, "Widget type", widget.type, PROJECT_WIDGET_TYPES.map(type => [type, type]),
      type => update({type})));
    card.append(choice(document, "Widget Layer", widget.layerId, layers.map(layer => [layer.layerId, layer.title || layer.layerId]),
      layerId => update({layerId})));
    const data = dataByLayerId.get(widget.layerId);
    const fields = fieldsFor(data);
    const selectors = widget.type === "scatter" ? [["xField", "X field"], ["yField", "Y field"]]
      : ["bar", "pie"].includes(widget.type) ? [["category", "Category field"], ["valueField", "Value field"]]
      : [["field", "Numeric field"]];
    for (const [key, label] of selectors) card.append(choice(document, label, widget[key],
      [["", "Choose a field"], ...fields.map(name => [name, name])], value => update({[key]: value})));
    if (["bar", "pie"].includes(widget.type)) card.append(choice(document, "Aggregation", widget.aggregation || "count",
      [["count", "Count"], ["sum", "Sum"], ["mean", "Mean"]], aggregation => update({aggregation})));
    if (widget.type === "histogram") card.append(field(document, "Histogram bins", widget.bins ?? 12, bins => {
      if (Number.isSafeInteger(bins) && bins > 0) update({bins});
    }, {type: "number"}));
    card.append(field(document, "Chart color", widget.color ?? "#4269d0", color => update({color}), {type: "color"}));
    const preview = element(document, "div");
    preview.className = "project-dashboard-preview";
    try {preview.append(renderProjectDashboardWidget(widget, data, {document}));}
    catch (error) {preview.append(element(document, "p", error.message));}
    card.append(preview, orderButtons(document, records, index, commit));
    grid.append(card);
  }
  root.append(grid);
  let newType = PROJECT_WIDGET_TYPES[0], newLayer = layers[0]?.layerId ?? "";
  const add = element(document, "fieldset");
  add.append(element(document, "legend", "Add a widget"));
  add.append(choice(document, "New widget type", newType, PROJECT_WIDGET_TYPES.map(type => [type, type]), value => {newType = value;}));
  add.append(choice(document, "New widget Layer", newLayer, layers.map(layer => [layer.layerId, layer.title || layer.layerId]), value => {newLayer = value;}));
  const create = button(document, "Add widget", () => {
    if (!newLayer) return;
    commit([...records, newDashboardWidget(newType, newLayer, fieldsFor(dataByLayerId.get(newLayer)))]);
  });
  create.disabled = layers.length === 0;
  add.append(create);
  root.append(add);
  if (!editable) for (const control of root.querySelectorAll("input,select,textarea,button")) control.disabled = true;
  return root;
}
