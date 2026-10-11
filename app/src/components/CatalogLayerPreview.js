import {CatalogProjectSave} from "./CatalogProjectSave.js";
import {sourceLinks} from "./SourceDetails.js";
export async function CatalogLayerPreview({record, load, adapter = null, interactive = false, renderMap = async options => {
  const {MapView} = await import("./MapView.js"); return MapView(options);
}}) {
  const result = await load(record);
  const panel = node("section", "", "catalog-layer-preview");
  panel.append(node("h4", `${record.title} · live source preview`));
  if (interactive) panel.append(node("p", "Temporary Layer view. Exploring this map does not change a saved Project."));
  if (result.kind === "xyz") {
    panel.append(await renderMap({xyz: {endpoint: result.endpoint, configuration: result.layer.sourceConfiguration}, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", "Live provider tiles. Choose an area to inspect; no archived images are requested. This display is not an original-data export."));
  } else if (result.kind === "cog") {
    panel.append(await renderMap({cog: result.cog, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", "Bounded current-view raster from the referenced COG. Pan or zoom, then refresh to read another window. Terms: " + (result.cog.configuration.license ?? "not supplied") + "."));
  } else if (result.kind === "features") {
    panel.append(await renderMap({geojson: result.geojson, geometryType: record.geometryType ?? result.geojson.features.find(feature => feature.geometry)?.geometry.type,
      graduated: record.legend?.field ? record.legend : undefined, height: interactive ? "60vh" : "20rem"}));
    panel.append(node("p", `${result.geojson.features.length.toLocaleString()} features${result.complete ? "" : " · bounded sample, not complete coverage"}. ${result.geometryNote}`));
  } else if (interactive) {
    panel.append(await renderMap({imageServer: {endpoint: result.endpoint, metadata: result.metadata, attribution: result.attribution, configuration: result.layer?.sourceConfiguration}, height: "60vh"}));
  } else {
    const image = document.createElement("img");
    image.alt = `${record.title}: provider overview`; image.width = 800; image.height = 450;
    image.referrerPolicy = "no-referrer"; image.crossOrigin = "anonymous";
    const status = node("p", "Loading provider overview…"); status.setAttribute("role", "status");
    image.addEventListener("load", () => {status.textContent = "Provider overview. Open the map to pan, zoom and inspect imagery.";});
    image.addEventListener("error", () => {image.hidden = true; status.textContent = "The provider overview could not load. No archived imagery was substituted.";});
    image.src = result.imageUrl; panel.append(image, status);
  }
  panel.append(node("p", result.attribution));
  if (interactive && adapter && result.layer) panel.append(CatalogProjectSave({adapter, record, layer: result.layer, getView: () => panel.querySelector(".map-frame")?.__view?.()}));
  const access = node("section", "", "catalog-layer-access");
  access.append(node("h4", "Source data and downloads"),
    node("p", "This layer is a view of the source dataset. Provider exports may include other indicator fields."));
  access.append(link("Official service and query options", sourceLinks(result.endpoint).provider));
  if (/^[a-f0-9]{32}$/i.test(result.metadata.serviceItemId ?? "")) {
    access.append(link("Official item and export options", `https://www.arcgis.com/home/item.html?id=${result.metadata.serviceItemId}`));
  }
  if (result.metadata.supportedQueryFormats) {
    access.append(node("p", `Query formats reported by the provider: ${String(result.metadata.supportedQueryFormats).slice(0, 200)}. Hosted download formats may differ.`));
  }
  access.append(node("p", "Archived copies and their access permissions are listed under Metadata and access."));
  panel.append(access);
  return panel;
}
function node(tag, value, className = "") {const element = document.createElement(tag); element.textContent = value; element.className = className; return element;}
function link(label, href) {const element = node("a", label, "platform-button platform-button-secondary"); element.href = href; element.target = "_blank"; element.rel = "noopener noreferrer"; return element;}
