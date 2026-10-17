import {CogIdentifyResult} from "./CogIdentifyResult.js";
import {
  GOVERNED_IDENTIFY_LIMITS,
  identifyReportSummary,
  identifyUnavailableMessage
} from "../lib/governedIdentify.js";

/** Render an in-memory report; the Workbench owns queries, sampling, focus and selection. */
export function IdentifyResultsPanel({report, running, layers, featureTitle, onSelectFeature}) {
  const panel = document.createElement("div");
  panel.className = "gis-panel-body gis-identify-panel";
  panel.tabIndex = -1;
  panel.setAttribute("aria-label", "Identify Results");
  panel.dataset.identifyState = running
    ? "running"
    : report
      ? "ready"
      : "idle";

  const live = textElement(
    "p",
    running
      ? "Checking visible layers…"
      : report
        ? identifyResultsSummary(report)
        : "Click the map to inspect visible layers."
  );
  live.className = "gis-query-feedback";
  live.role = "status";
  live.ariaLive = "polite";
  panel.append(live);

  if (!report) return panel;
  panel.append(textElement(
    "small",
    `${report.location[0].toFixed(5)}, ${report.location[1].toFixed(5)} · ${report.layers.length
      ? report.layers.some(outcome => outcome.result?.source === "displayed-preview")
        ? `displayed features use a ${GOVERNED_IDENTIFY_LIMITS.renderedPixelTolerance} pixel click tolerance`
        : `${report.bufferMeters} meter selection tolerance`
      : "raster cells from the loaded grid"}`
  ));
  const groups = document.createElement("div");
  groups.className = "gis-identify-groups";
  for (const outcome of report.rasters ?? []) {
    const group = document.createElement("section");group.className = "gis-identify-layer";group.dataset.identifyLayer = outcome.layerId;
    group.append(textElement("h3", outcome.title), CogIdentifyResult(outcome.sample));groups.append(group);
  }
  for (const outcome of report.layers) {
    const group = document.createElement("section");
    group.className = "gis-identify-layer";
    group.dataset.identifyLayer = outcome.layerId;
    group.append(textElement("h3", outcome.title));
    if (outcome.status !== "ready") {
      group.append(textElement("p", identifyUnavailableMessage(outcome.errorCode)));
      groups.append(group);
      continue;
    }
    if (!outcome.result.features.length) {
      group.append(textElement("p", outcome.result.source === "displayed-preview"
        ? "No displayed features at this location." : "No features at this location."));
      groups.append(group);
      continue;
    }
    const layer = layers.find(({layerId}) => layerId === outcome.layerId);
    group.append(textElement(
      "p",
      outcome.result.source === "displayed-preview"
        ? outcome.displayOnly
          ? `${outcome.result.numberReturned} ${outcome.result.numberReturned === 1 ? "feature" : "features"} at this location · From this map`
          : `${outcome.result.numberReturned} displayed features · saved data version ${layer?.sourceVersion ?? "selected"}. Hidden or unloaded features are not searched.`
        : `${outcome.result.numberReturned} of ${outcome.result.numberMatched} matches · generation ${outcome.result.generation}`
    ));
    const results = document.createElement("div");
    results.className = "gis-identify-features";
    outcome.result.features.forEach((feature) => {
      const targetLayer = layer ?? {title: outcome.title, labels: {}};
      const label = featureTitle(feature, targetLayer);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gis-button";
      button.textContent = label;
      button.setAttribute("aria-label", `Open ${label} from ${outcome.title}`);
      button.addEventListener("click", () => onSelectFeature(outcome, targetLayer, feature, label));
      results.append(button);
      const attributes = document.createElement("dl"); attributes.className = "gis-popup";
      for (const [key, value] of Object.entries(feature.properties ?? {}).slice(0, 10)) {
        attributes.append(textElement("dt", String(key).slice(0, 160)),
          textElement("dd", (typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).slice(0, 2000)));
      }
      results.append(attributes);
    });
    group.append(results);
    groups.append(group);
  }
  panel.append(groups);
  return panel;
}

export function identifyResultsSummary(report) {
  return [report.layers.length ? identifyReportSummary(report) : null,
    report.rasters?.length ? `Raster values · ${report.rasters.length} visible ${report.rasters.length === 1 ? "layer" : "layers"}.` : null]
    .filter(Boolean).join(" ");
}

function textElement(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value ?? "";
  return element;
}
