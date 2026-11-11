import {parseAuthoringGeometry} from "../lib/kmlPlaces.js";

let nextControlsId = 0;
const MODES = [["maplibre", "Full graphics (MapLibre)"], ["openlayers-canvas", "2D compatibility"], ["data-workspace", "Data workspace"]];
const CAPABILITIES = {navigation:"Map navigation",identify:"Inspect features",drawing:"Drawing",measurement:"Measurement",
  capture:"Image capture",geojson:"GeoJSON Layers",xyzBasemap:"Raster basemaps",labels:"Labels",featureEditing:"Edit existing features",
  vectorTiles:"Vector tiles",pmtiles:"PMTiles archives",terrain:"Terrain",globe:"Globe",customGPU:"Custom graphics effects",maplibreStyle:"MapLibre Styles"};
const GEOMETRY_ERRORS = {
  kml_point_coordinate_required: "Enter one longitude,latitude position for a Point.",
  kml_line_requires_two_positions: "Enter at least two positions for a Path.",
  kml_polygon_requires_three_positions: "Enter at least three positions for a Polygon.",
  kml_coordinate_invalid: "Use longitude,latitude positions separated by spaces.",
  kml_coordinate_out_of_bounds: "Longitude must be between −180 and 180; latitude between −90 and 90."
};

export function CompatibilityMapControls({mode, report = {}, view = {}, canEdit = true,
  onMode, onNavigate, onInteraction, onGeometry, onFinish, onCancel} = {}) {
  const id = `compatibility-controls-${++nextControlsId}`;
  const section = element("section");
  section.className = "gis-compatibility-controls";
  section.dataset.mode = mode;
  section.setAttribute("role", "group");
  section.setAttribute("aria-label", "Map compatibility controls");
  const status = element("p", mode === "data-workspace"
    ? "Data workspace is active. Your Layers and Project remain available."
    : "2D compatibility is active. Review the Layer report for display limits.");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const invoke = (callback, value, success) => {
    try {
      const result = callback?.(value);
      if (result?.then) result.then(() => {if (success) status.textContent = success;}, error => {status.textContent = error?.message ?? "The action could not finish. Your inputs are retained.";});
      else if (success) status.textContent = success;
    } catch (error) { status.textContent = error?.message ?? "The action could not finish. Your inputs are retained."; }
  };
  const button = (label, action, disabled = false) => {
    const control = element("button", label);control.type = "button";control.disabled = disabled;
    control.addEventListener("click", action);return control;
  };
  const modes = element("div");modes.setAttribute("role", "group");modes.setAttribute("aria-label", "Map display mode");
  for (const [value, label] of MODES) {
    const control = button(label, () => invoke(onMode, value), typeof onMode !== "function");
    control.setAttribute("aria-pressed", String(mode === value));modes.append(control);
  }
  let reportElement = layerReport(report);
  section.append(modes, status, reportElement);
  section.updateReport = value => {const next = layerReport(value);reportElement.replaceWith(next);reportElement = next;};
  if (mode !== "openlayers-canvas") return section;

  const navigation = element("div");navigation.setAttribute("role", "group");navigation.setAttribute("aria-label", "2D map navigation");
  for (const [action, label] of [["zoom-in", "Zoom in"], ["zoom-out", "Zoom out"], ["north", "North up"], ["fit-layers", "Fit Layers"]]) {
    navigation.append(button(label, () => invoke(onNavigate, {action}), typeof onNavigate !== "function"));
  }
  section.append(navigation);
  const locate = element("form");locate.noValidate = true;locate.setAttribute("aria-label", "Locate coordinates");
  const longitude = inputField(locate, `${id}-longitude`, "Longitude", "number", view.center?.[0] ?? 0);
  const latitude = inputField(locate, `${id}-latitude`, "Latitude", "number", view.center?.[1] ?? 0);
  const zoom = inputField(locate, `${id}-zoom`, "Zoom", "number", view.zoom ?? 2);
  for (const field of [longitude, latitude, zoom]) field.step = "any";
  longitude.min = "-180";longitude.max = "180";latitude.min = "-90";latitude.max = "90";zoom.min = "0";zoom.max = "24";
  const locateError = linkedError(locate, `${id}-locate-error`, [longitude, latitude, zoom]);
  const locateButton = element("button", "Locate");locateButton.type = "submit";locateButton.disabled = typeof onNavigate !== "function";
  locate.append(locateButton);
  locate.addEventListener("submit", event => {
    event.preventDefault();
    const values = [longitude, latitude, zoom].map(field => field.value.trim() ? Number(field.value) : NaN);
    const valid = values.every(Number.isFinite) && values[0] >= -180 && values[0] <= 180
      && values[1] >= -90 && values[1] <= 90 && values[2] >= 0 && values[2] <= 24;
    locateError(valid ? "" : "Enter longitude from −180 to 180, latitude from −90 to 90, and zoom from 0 to 24.");
    if (valid) invoke(onNavigate, {center: values.slice(0, 2), zoom: values[2]});
  });
  section.append(locate);

  const interactions = element("div");interactions.setAttribute("role", "group");interactions.setAttribute("aria-label", "2D drawing and measurement");
  for (const [kind, label, editing] of [["Point", "Point", true], ["LineString", "Path", true], ["Polygon", "Polygon", true],
    ["measure-distance", "Measure distance", false], ["measure-area", "Measure area", false]]) {
    interactions.append(button(label, () => invoke(onInteraction, kind), typeof onInteraction !== "function" || (editing && !canEdit)));
  }
  interactions.append(button("Finish", () => invoke(onFinish), typeof onFinish !== "function"),
    button("Cancel", () => invoke(onCancel), typeof onCancel !== "function"));
  section.append(interactions);

  const geometryForm = element("form");geometryForm.setAttribute("aria-label", "Add geometry by coordinates");
  const kindLabel = element("label", "Geometry type"), kind = element("select");kind.id = `${id}-kind`;kindLabel.htmlFor = kind.id;
  for (const [value, label] of [["Point", "Point"], ["LineString", "Path"], ["Polygon", "Polygon"]]) {
    const option = element("option", label);option.value = value;kind.append(option);
  }
  geometryForm.append(kindLabel, kind);
  const name = inputField(geometryForm, `${id}-name`, "Geometry name", "text", "");
  const coordinatesLabel = element("label", "Coordinates (longitude,latitude positions separated by spaces)");
  const coordinates = element("textarea");coordinates.id = `${id}-coordinates`;coordinates.rows = 3;coordinatesLabel.htmlFor = coordinates.id;
  geometryForm.append(coordinatesLabel, coordinates);
  const geometryError = linkedError(geometryForm, `${id}-geometry-error`, [coordinates]);
  const add = element("button", "Add geometry");add.type = "submit";
  for (const field of [kind, name, coordinates, add]) field.disabled = !canEdit || typeof onGeometry !== "function";
  geometryForm.append(add);
  geometryForm.addEventListener("submit", event => {
    event.preventDefault();if (!canEdit || typeof onGeometry !== "function") return;
    let geometry;
    try { geometry = parseAuthoringGeometry(kind.value, coordinates.value); }
    catch (error) { geometryError(GEOMETRY_ERRORS[error.code ?? error.message] ?? "Check the coordinate positions and try again.");return; }
    geometryError("");
    invoke(onGeometry, {mode: kind.value, feature: {type: "Feature", properties: {name: name.value.trim()}, geometry}}, "Geometry added to the working Project. Use Save to retain it.");
  });
  section.append(geometryForm);return section;
}

function element(tag, text) {
  const node = document.createElement(tag);if (text !== undefined) node.textContent = String(text);return node;
}

function inputField(parent, id, title, type, value) {
  const label = element("label", title), input = element("input");label.htmlFor = id;input.id = id;input.type = type;input.value = value;
  parent.append(label, input);return input;
}

function linkedError(parent, id, fields) {
  const error = element("p");error.id = id;error.hidden = true;error.setAttribute("role", "alert");
  for (const field of fields) field.setAttribute("aria-describedby", id);
  parent.append(error);
  return message => {error.textContent = message;error.hidden = !message;
    for (const field of fields) message ? field.setAttribute("aria-invalid", "true") : field.removeAttribute("aria-invalid");};
}

function layerReport(report) {
  const details = element("details"), summary = element("summary", "Layer display and capabilities");details.append(summary);
  const capabilities = report.capabilities;
  if (capabilities) {
    const entries = Array.isArray(capabilities) ? capabilities : Object.entries(capabilities).map(([name, value]) =>
      `${CAPABILITIES[name] ?? name}: ${value === true ? "available" : value === false ? "unavailable" : value === "system-font-layout" ? "system fonts; placement may differ" : Array.isArray(value) ? value.join(", ") : value}`);
    const list = element("ul");for (const entry of entries) list.append(element("li", typeof entry === "string" ? entry : entry.message ?? entry.title ?? entry.code ?? "Capability reported"));details.append(list);
  }
  const layers = element("ul");
  for (const layer of report.layers ?? []) {
    const item = element("li");item.dataset.layerId = layer.layerId;
    item.append(element("strong", layer.title ?? layer.layerId), document.createTextNode(` — ${layer.status ?? "not displayed"}${layer.visible === false ? " (hidden)" : ""}`));
    if (layer.issues?.length) {const issues = element("ul");
      for (const issue of layer.issues) issues.append(element("li", typeof issue === "string" ? issue : issue.message ?? issue.reason ?? issue.code ?? "Display limitation"));item.append(issues);}
    layers.append(item);
  }
  if (!report.layers?.length) layers.append(element("li", "No Layers in this Project."));details.append(layers);return details;
}
