import {compilePortableMapArtifact} from "../lib/portableMapArtifact.js";
import {inspectStaticMapLayers} from "../lib/staticMapExport.js";

export function openStaticMapExport({map, layers, handles, title, download, initialMode = "offline", onInsert = null, downloadManifest = null, savedProjectOrigin = null}) {
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
    busy = true; update(); mode.disabled = true; list.disabled = true; consent.disabled = true;
    try {
      const selectedIds = choices.filter(({input}) => input.checked).map(({item}) => item.id);
      const center = map.getCenter();
      const view = {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing()};
      const [runtimeJs, runtimeCss, runtimeLicense] = await Promise.all(["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt"].map(async path => {
        const response = await fetch(`/export-runtime/${path}`, {credentials: "omit"});
        if (!response.ok) throw Error("The export runtime is unavailable in this Studio release.");
        return response.text();
      }));
      compiled = await compilePortableMapArtifact({title, candidates, selectedIds, mode: mode.value,
        runtimeJs, runtimeCss, runtimeLicense, view, savedProjectOrigin: origin});
      const {html, manifest} = compiled;
      if (!dialog.isConnected) return;
      if (insert) {await onInsert(html, title, manifest); dialog.close();}
      else {download(html); status.textContent = "Downloaded. Its Artifact manifest records exact bytes, loaded-feature scope and live dependencies. Keep both files for provenance.";}
    } catch (error) {status.textContent = error.message;}
    finally {busy = false; mode.disabled = false; list.disabled = false; consent.disabled = false; update();}
  }
  exportButton.onclick = () => generate(false); insertButton.onclick = () => generate(true);
  dialog.append(heading, note, modeLabel, list, consentLabel, status, insertButton, exportButton, manifestButton, close, hint);
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog); render(); dialog.showModal();
  return dialog;
}
