import {compilePortableMapArtifact} from "../lib/portableMapArtifact.js";
import {inspectStaticMapLayers} from "../lib/staticMapExport.js";
import {compileDeveloperMapBundle} from "../lib/developerMapBundle.js";
import {compilePublicationMapHandoff} from "../lib/publicationMapHandoff.js";

export function openStaticMapExport({map, layers, handles, title, download, initialMode = "offline", initialFormat = "html", onInsert = null, downloadManifest = null, downloadBundle = null, downloadPublication = null, publicationHref = null, savedProjectOrigin = null}) {
  const origin = savedProjectOrigin ? structuredClone(savedProjectOrigin) : null;
  const dialog = document.createElement("dialog");
  dialog.className = "static-map-export-dialog";
  const heading = document.createElement("h2");
  heading.textContent = "Export interactive map";
  const note = document.createElement("p");
  note.textContent = "Download one HTML file for a static site or iframe. Vector layers contain currently loaded features, not a complete service archive. Filters control display; hidden features remain in the embedded data. Text labels use local fonts. Basemaps, terrain and unsupported layers are excluded. Your Studio account is not included.";
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Edition ";
  const mode = document.createElement("select");
  for (const [value, text] of [["offline", "Offline · embedded vector data"], ["live", "Live · public tiles and embedded vectors"]]) {
    const option = document.createElement("option");
    option.value = value; option.textContent = text; mode.append(option);
  }
  mode.value = initialMode;
  modeLabel.append(mode);
  const formatLabel = document.createElement("label"), format = document.createElement("select");
  format.setAttribute("aria-label", "Format");
  formatLabel.textContent = "Format ";formatLabel.hidden = typeof downloadBundle !== "function" && typeof downloadPublication !== "function";
  for (const [value, label] of [["html", "Interactive HTML"],
    ...(typeof downloadBundle === "function" ? [["developer", "Developer bundle · native JavaScript"]] : []),
    ...(typeof downloadPublication === "function" ? [["publication", "Publish with OpenGeo · source ZIP"]] : [])]) {
    const option = document.createElement("option");option.value = value;option.textContent = label;format.append(option);
  }
  formatLabel.append(format);
  format.value = [...format.options].some(option => option.value === initialFormat) ? initialFormat : "html";
  format.onchange = () => {
    const developer = format.value === "developer", publication = format.value === "publication";
    exportButton.textContent = publication ? "Download publishing ZIP" : developer ? "Download developer ZIP" : "Download HTML";
    note.textContent = publication ? "Prepare this reviewed map for account publishing. Download the source ZIP, then import it in Studio. Your draft starts private; choose when to publish after reviewing its sources and rights."
      : developer
      ? "Download a native map module, viewer assets, preview and Observable Framework example. The map can inherit your page's fonts and colors and exposes filters, selection events and cleanup. Only reviewed loaded data is packaged; filters do not remove hidden features."
      : "Download one HTML file for a static site or iframe. Vector layers contain currently loaded features, not a complete service archive. Filters control display; hidden features remain in the embedded data. Text labels use local fonts. Basemaps, terrain and unsupported layers are excluded. Your Studio account is not included.";
    hint.textContent = publication ? "In Studio Publications, open or create a Map · portable HTML publication. In Files, choose OpenGeo Studio source project ZIP and Use imported source, then save the draft. Preview and Publish are separate deliberate actions."
      : developer
      ? "Unzip and serve preview.html with a static web server. The bundle records included, live and excluded dependencies. Upload deliberately to your chosen host for a public import URL."
      : "Upload this file to your public static-site destination. Use its HTTPS URL in an iframe; neither view requires a Studio session. This download does not publish or change a hosted site.";
  };
  const list = document.createElement("fieldset");
  const consentLabel = document.createElement("label");
  const consent = document.createElement("input");
  consent.type = "checkbox";
  consentLabel.append(consent, " I have reviewed these layers and their Styles and attribution, and may distribute the included data and styling.");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const exportButton = document.createElement("button");
  exportButton.textContent = "Download HTML";
  exportButton.disabled = true;
  const insertButton = document.createElement("button"); insertButton.textContent = "Insert in publication";
  insertButton.hidden = typeof onInsert !== "function"; insertButton.disabled = true;
  const manifestButton = document.createElement("button");
  manifestButton.textContent = "Download last export manifest";
  manifestButton.hidden = typeof downloadManifest !== "function";
  manifestButton.disabled = true;
  let compiled = null;
  manifestButton.onclick = () => {if (compiled) downloadManifest(compiled.manifest);};
  const close = document.createElement("button");
  close.textContent = "Close"; close.onclick = () => dialog.close();
  const hint = document.createElement("p");
  hint.textContent = "Upload this file to your public static-site destination. Use its HTTPS URL in an iframe; neither view requires a Studio session. This download does not publish or change a hosted site.";
  const publishing = document.createElement("a");publishing.textContent = "Continue in Studio Publications ↗";
  publishing.hidden = true;publishing.target = "_blank";publishing.rel = "noopener noreferrer";
  if (publicationHref) publishing.href = publicationHref;
  let candidates = [], choices = [], busy = false;
  function update() {
    insertButton.disabled = exportButton.disabled = busy || !consent.checked || !choices.some(({input}) => input.checked);
    manifestButton.disabled = busy || !compiled;
  }
  function render() {
    candidates = structuredClone(inspectStaticMapLayers({style: map.getStyle(), layers, handles, mode: mode.value}));
    list.replaceChildren(); choices = []; consent.checked = false;
    const legend = document.createElement("legend"); legend.textContent = "Included layers"; list.append(legend);
    for (const item of candidates) {
      const label = document.createElement("label"), input = document.createElement("input");
      input.type = "checkbox"; input.disabled = Boolean(item.reason); input.checked = !item.reason && item.visible;
      input.onchange = update;
      label.append(input, ` ${item.title}${item.reason ? ` — ${item.reason}` : ""}`);
      if (!item.reason) {
        if (item.omittedLabelCount) label.append(document.createTextNode(" · Text labels are omitted from this export."));
        const attribution = document.createElement("small");
        attribution.textContent = ` Attribution: ${String(item.attribution || "not recorded").replace(/<[^>]*>/g, "")}`;
        label.append(attribution);
        if (item.styleReference) {
          const style = document.createElement("small");
          style.textContent = ` Pinned Style · version ${item.styleReference.versionNumber}. Its reference is retained in the Artifact manifest.`;
          label.append(style);
        }
      }
      list.append(label); choices.push({input, item});
    }
    if (!candidates.length) list.append("Add a vector or public raster tile layer to the map first.");
    status.textContent = mode.value === "offline" ? "Only embedded vector data will be included. No network data is captured." : "Live tiles will be fetched from their providers without credentials. No archive fallback.";
    update();
  }
  mode.onchange = render; consent.onchange = update;
  async function generate(insert) {
    if (busy || !consent.checked || !choices.some(({input}) => input.checked)) return;
    busy = true; update(); mode.disabled = format.disabled = true; list.disabled = true; consent.disabled = true;
    try {
      const selectedIds = choices.filter(({input}) => input.checked).map(({item}) => item.id);
      const center = map.getCenter();
      const view = {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
      const developer = !insert && format.value === "developer";
      const publication = !insert && format.value === "publication";
      const [runtimeJs, runtimeCss, runtimeLicense, nativeRuntime] = await Promise.all(["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt", ...(developer ? ["native-map-view.txt"] : [])].map(async path => {
        const response = await fetch(`/export-runtime/${path}`, {credentials: "omit"});
        if (!response.ok) throw Error("The export runtime is unavailable in this Studio release.");
        return response.text();
      }));
      compiled = await compilePortableMapArtifact({title, candidates, selectedIds, mode: mode.value,
        runtimeJs, runtimeCss, runtimeLicense, view, savedProjectOrigin: origin});
      const {html, manifest} = compiled;
      if (!dialog.isConnected) return;
      if (insert) {await onInsert(html, title, manifest); dialog.close();}
      else if (publication) {
        const {blob} = await compilePublicationMapHandoff(compiled);
        if (!dialog.isConnected) return;
        downloadPublication(blob);publishing.hidden = !publicationHref;
        status.textContent = "Publishing ZIP downloaded. Import it in Studio to save a private draft, then review and publish for a hosted URL. Nothing has been uploaded or published.";
      }
      else if (developer) {
        const {blob, manifest: bundleManifest} = await compileDeveloperMapBundle({compiled, candidates, selectedIds, runtimeJs, runtimeCss, runtimeLicense, nativeRuntime});
        if (!dialog.isConnected) return;
        downloadBundle(blob);
        status.textContent = bundleManifest.fullyOffline ? "Downloaded developer bundle. The selected map and viewer are included; open interactive.html directly or serve preview.html for native integration."
          : "Downloaded developer bundle. Its manifest identifies live provider dependencies and excluded content; internet access is required.";
      }
      else {download(html); status.textContent = "Downloaded. Its Artifact manifest records exact bytes, loaded-feature scope and live dependencies. Keep both files for provenance.";}
    } catch (error) {status.textContent = error.message;}
    finally {busy = false; mode.disabled = format.disabled = false; list.disabled = false; consent.disabled = false; update();}
  }
  exportButton.onclick = () => generate(false); insertButton.onclick = () => generate(true);
  dialog.append(heading, note, formatLabel, modeLabel, list, consentLabel, status, insertButton, exportButton, manifestButton, close, hint, publishing);
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog); render();format.onchange();dialog.showModal();
  return dialog;
}
