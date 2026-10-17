import {loadLayerArchive} from "../lib/layerArchiveRead.js";
import {loadReviewedArchiveTiles} from "../lib/reviewedArchiveTiles.js";
import {matchesReviewedDisplay} from "../lib/reviewedDisplayIdentity.js";

export function LayerArchiveControl({layer, access, onStart, onLoaded, onReturn, onError, returnLabel = null}) {
  const managed = layer.sourceType === "governed-dataset";
  const root = document.createElement("div"); root.className = "gis-layer-archive-control";
  const dialog = document.createElement("dialog"); dialog.className = "gis-layer-archive-dialog";
  dialog.setAttribute("aria-label", `${layer.title}: archived copies`);
  const heading = document.createElement("h3"); heading.textContent = `${layer.title}: ${managed ? "map display" : "live / archived copy"}`;
  const summary = document.createElement("button"); summary.type = "button"; summary.textContent = managed ? "Map display" : "Live / archived copy";
  summary.addEventListener("click", () => dialog.showModal());
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.textContent = managed ? "Choose a reviewed tiled display of this saved dataset version. Save the Project to retain the selection; reopening always requires fresh download consent. Original records stay preserved."
    : "Live connection is the default. Archive use applies only to this open map.";
  const choice = document.createElement("select"); choice.setAttribute("aria-label", `Archived copy for ${layer.title}`);
  const facts = document.createElement("p");
  const consent = document.createElement("input"); consent.type = "checkbox";
  const label = document.createElement("label");
  label.append(consent, " Download the selected copy from S3; storage request and download charges may apply.");
  let preferredDisplayId = managed ? layer.managedDisplayId : null;
  let rows = [], busy = false, mode = preferredDisplayId ? "pending" : "live", controller = null, disposed = false, tileSession = null;
  function button(text, action) {const node = document.createElement("button"); node.type = "button"; node.className = "platform-button secondary"; node.textContent = text; node.addEventListener("click", action); return node;}
  const list = button(managed ? "Review tiled displays" : "Review available archives", () => task(async signal => {
    const result = await access.list(layer, signal);
    if (!matchesReviewedDisplay(result, layer)
      || !Array.isArray(result.archives) || result.archives.length > 20) throw Error("Layer revision changed. Refresh its source first.");
    rows = result.archives;
    choice.replaceChildren(...rows.map(row => new Option(row.title, row.id)));
    if (preferredDisplayId) choice.value = rows.some(row => row.id === preferredDisplayId) ? preferredDisplayId : "";
    consent.checked = false; showFacts();
    status.textContent = preferredDisplayId && !choice.value ? "The saved tiled display is unavailable. Choose another reviewed display or return to saved data."
      : rows.length ? "Select a capture and review the download cost before using it." : "No reviewed, accessible map copy is available.";
  }));
  const use = button(managed ? "Use selected tiled display" : "Use selected archived copy", () => task(async signal => {
    if (!consent.checked || !rows.some(row => row.id === choice.value)) throw Error("Select a copy and acknowledge download costs first.");
    tileSession?.dispose(); tileSession = null;
    mode = "archive"; onStart();
    const record = await access.read(layer, choice.value, signal);
    if (managed && record.format !== "pmtiles") throw Error("This saved version requires a reviewed tiled display.");
    const collection = await (record.format === "pmtiles" ? loadReviewedArchiveTiles : loadLayerArchive)({record, layer, signal, assertScope: access.assertScope,
      onError: error => {if (!disposed && mode === "archive") {status.textContent = error.message; onError();}},
      onProgress: ({downloaded, total}) => {status.textContent = record.format === "pmtiles"
        ? `Verified archive tiles: ${downloaded.toLocaleString()} bytes downloaded this session.`
        : `Verified archive download: ${downloaded.toLocaleString()} / ${total.toLocaleString()} bytes`;}});
    if (collection.kind === "reviewed-archive-tiles") tileSession = collection;
    await access.authorize();
    signal.throwIfAborted();
    if (disposed) return;
    onLoaded(collection, record);
    const unlocated = collection.opengeo?.unlocatedFeatureCount ?? 0;
    status.textContent = `Archived capture ${record.captured_at ?? "(capture date not recorded)"}: ${tileSession ? `${record.feature_count.toLocaleString()} reported tile fragments; this is not a source record count. Visible tiles are downloaded and verified as needed. This viewing session expires after five minutes. ${record.tile_layers.map(layer => `${layer.title}: ${layer.geometry_method}`).join(" ")}` : `${collection.features.length.toLocaleString()} verified features.`} ${record.attribution}`
      + (unlocated ? ` ${unlocated.toLocaleString()} records have no map location; their attributes are retained.` : "");
  }));
  const live = button(returnLabel ?? (managed ? "Return to saved data" : "Return to live"), () => {
    controller?.abort(); tileSession?.dispose(); tileSession = null; mode = "live"; preferredDisplayId = null; consent.checked = false;
    const result = onReturn();
    preferredDisplayId = result?.retainDisplayId ?? null;
    if (preferredDisplayId) mode = "pending";
    status.textContent = result?.message ?? (managed ? "Saved data selected. Enable the layer to load its available preview." : "Live connection selected. Enable the layer to display its current view."); update();
  });
  const pause = button("Cancel archive request", () => controller?.abort());
  const close = button("Close archive selection", () => {if (busy) controller?.abort(); dialog.close();});
  dialog.addEventListener("cancel", () => {if (busy) controller?.abort();});
  choice.addEventListener("change", () => {consent.checked = false; showFacts(); update();});
  consent.addEventListener("change", update);
  function showFacts() {
    const row = rows.find(row => row.id === choice.value);
    facts.textContent = row ? `${row.captured_at ?? "Capture date not recorded"} · ${row.download_bytes.toLocaleString()} ${row.format === "pmtiles" ? "stored bytes; only requested tiles are downloaded (maximum 64 MiB per five-minute session)" : "download bytes"} · ${row.feature_count.toLocaleString()} ${row.format === "pmtiles" ? "reported tile fragments, not source records" : "features"}. License: ${typeof row.rights?.license === "string" ? row.rights.license : "not recorded; review the source terms"}`
      + (row.format === "pmtiles" ? ` ${(row.tile_layers ?? []).map(item => `${item.title}: ${item.geometry_method}`).join(" ")}` : "")
      + (row.raster_overview ? ` ${row.raster_overview.description}` : "") : "";
  }
  function update() {
    list.disabled = busy; choice.disabled = busy || !rows.length; consent.disabled = busy || !rows.length;
    use.disabled = busy || !rows.some(row => row.id === choice.value) || !consent.checked; live.disabled = mode === "live"; pause.disabled = !busy;
  }
  async function task(work) {
    if (busy || disposed) return;
    controller = new AbortController(); const active = controller; busy = true; update();
    try {await access.assertScope(); await work(active.signal);}
    catch (error) {
      if (!disposed && controller === active) {
        status.textContent = active.signal.aborted ? "Archive request cancelled." : error.message;
        if (mode === "archive") {tileSession?.dispose(); tileSession = null; onError();}
      }
    } finally {if (controller === active) {busy = false; update();}}
  }
  dialog.append(heading, status, list, choice, facts, label, use, live, pause, close);
  document.body.append(dialog); root.append(summary); update();
  root.openSelection = displayId => {if (!disposed) {preferredDisplayId = displayId ?? preferredDisplayId;consent.checked = false;dialog.showModal();update();}};
  root.dispose = () => {disposed = true; controller?.abort(); tileSession?.dispose(); tileSession = null; dialog.close(); dialog.remove();};
  return root;
}
