import {DistanceToolbar} from "./DistanceToolbar.js";
import {ExportPanel} from "./ExportPanel.js";
import {LayoutCanvas} from "./LayoutCanvas.js";
import {pageLabel, standardPageSizes} from "../lib/printLayouts.js";

export function PrintStudio({layout, workspace, layers, datasets, geojsonByLayerId, exports}) {
  if (!layout) return missingLayout();

  const layerById = new Map(layers.map((layer) => [layer.layerId, layer]));
  const context = {
    workspace,
    layers,
    datasets,
    layerById,
    geojsonByLayerId,
    basemaps: basemapOptions(layout)
  };

  const shell = document.createElement("div");
  shell.className = "print-studio-shell";

  const controls = document.createElement("aside");
  controls.className = "print-studio-controls";
  controls.append(layoutSummary(layout, workspace, layers), pagePicker(layout), DistanceToolbar({layout}), ExportPanel({layout, exports}));

  const stage = document.createElement("div");
  stage.className = "print-stage";
  stage.append(LayoutCanvas(layout, context));

  shell.append(controls, stage);
  return shell;
}

function layoutSummary(layout, workspace, layers) {
  const summary = document.createElement("div");
  summary.className = "print-summary";
  summary.innerHTML = `<strong>${layout.title}</strong>
    <span>${workspace?.title ?? layout.workspaceId}</span>
    <span>${pageLabel(layout)} · ${layout.classification}</span>
    <span>${layers.length} layer${layers.length === 1 ? "" : "s"}</span>`;
  return summary;
}

function pagePicker(layout) {
  const label = document.createElement("label");
  label.className = "print-field";
  const text = document.createElement("span");
  text.textContent = "Page size";

  const select = document.createElement("select");
  for (const page of standardPageSizes) {
    const option = document.createElement("option");
    option.value = `${page.size}-${page.orientation}`;
    option.textContent = `${page.size} ${page.orientation}`;
    option.selected = page.size === layout.pageSize && page.orientation === layout.orientation;
    select.append(option);
  }

  label.append(text, select);
  return label;
}

function basemapOptions(layout) {
  return [
    {
      basemapId: "openfreemap-positron",
      title: "Positron",
      attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap"
    },
    ...(layout.basemaps ?? [])
  ];
}

function missingLayout() {
  const message = document.createElement("p");
  message.className = "note";
  message.textContent = "Layout not found.";
  return message;
}
