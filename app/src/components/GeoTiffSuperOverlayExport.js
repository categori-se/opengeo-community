import {exportRasterSuperOverlay} from "../lib/kmlRasterSuperOverlay.js";

export function GeoTiffSuperOverlayExport({download, exporter = exportRasterSuperOverlay,
  available = () => true, assertScope = () => {}, document = globalThis.document} = {}) {
  const details = document.createElement("details");
  details.className = "gis-section";
  details.dataset.rasterSuperOverlay = "export";
  const summary = document.createElement("summary"); summary.textContent = "Export a raster for Google Earth";
  const help = document.createElement("p");
  help.textContent = "Create a portable KMZ image pyramid from a local GeoTIFF. Use WGS84 or Web Mercator, 8-bit gray/RGB/RGBA, up to 64 MiB and 4096 pixels per side. The original file stays unchanged.";
  const fileLabel = document.createElement("label"); fileLabel.textContent = "GeoTIFF file ";
  const file = document.createElement("input"); file.type = "file"; file.accept = ".tif,.tiff,image/tiff"; fileLabel.append(file);
  const creditsLabel = document.createElement("label"); creditsLabel.textContent = "Source attribution and reuse terms ";
  const credits = document.createElement("textarea"); credits.rows = 2; credits.maxLength = 8192;
  creditsLabel.append(credits);
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const run = document.createElement("button"); run.type = "button"; run.textContent = "Download raster KMZ"; run.disabled = true;
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel raster export"; cancel.hidden = true;
  let controller = null, disposed = false;
  const update = () => {
    if (disposed) return;
    const enabled = available();if (!enabled) controller?.abort();
    file.disabled = credits.disabled = !enabled || Boolean(controller);
    run.disabled = !enabled || Boolean(controller) || !file.files?.length;cancel.hidden = !controller;
  };
  file.addEventListener("change", () => {controller?.abort();update();status.textContent = "";});
  cancel.addEventListener("click", () => controller?.abort());
  run.addEventListener("click", async () => {
    const selected = file.files?.[0]; if (disposed || !available() || !selected || controller) return;
    const active = controller = new AbortController();update();
    try {
      const assertCurrent = () => {
        active.signal.throwIfAborted();
        if (disposed || !available() || !details.isConnected || controller !== active) throw new DOMException("The export panel or workspace changed.", "AbortError");
      };
      await assertScope();assertCurrent();
      const result = await exporter(selected, {signal: active.signal, attribution: credits.value,
        assertCurrent, onProgress: message => {if (!disposed && available() && controller === active && !active.signal.aborted) status.textContent = message;}});
      await assertScope();assertCurrent();
      const filename = `${selected.name.replace(/\.tiff?$/i, "")}-overlay.kmz`;
      await download(filename, result.bytes, "application/vnd.google-earth.kmz");
      status.textContent = `Downloaded ${result.report.tiles.length} raster tiles with source credits and a lineage report. Keep the original GeoTIFF; this export may exceed Studio's inline KML import limits.`;
    } catch (error) {
      if (!disposed) status.textContent = error?.name === "AbortError" ? "Raster export cancelled. The original file is unchanged."
        : error?.message ?? "The raster could not be exported.";
    } finally {
      if (controller === active) controller = null;update();
    }
  });
  const actions = document.createElement("div"); actions.className = "gis-action-grid"; actions.append(run, cancel);
  details.append(summary, help, fileLabel, creditsLabel, actions, status);update();
  return Object.assign(details, {element: details, update, dispose() {if (disposed) return;disposed = true;controller?.abort();details.remove();}});
}
