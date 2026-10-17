// Browser-only review uses the same resource concepts as durable registration.
// Source facts remain separate from the user's edits; missing rights stay unknown.
export function browserLayerReviewForProject(context) {
  const project = context.project;
  const isCurrent = () => !context.disposed && context.shell.isConnected && context.project === project;
  return options => {
    if (!isCurrent()) return null;
    const storageMode = context.publicDemo
      ? context.localProjectRecord ? "personal" : context.demoSurface ? "demo" : "browser"
      : "temporary";
    const dialog = BrowserLayerRegistration({...options, storageMode, isCurrent});
    const palette = context.shell.ownerDocument.defaultView.getComputedStyle(context.shell);
    for (const key of ["--gis-panel-bg", "--gis-ink", "--gis-line"]) {
      const value = palette.getPropertyValue(key);if (value) dialog.style.setProperty(key, value);
    }
    return dialog;
  };
}

export function BrowserLayerRegistration({layer, geojson, source = {}, onAdd, storageMode = "browser", isCurrent = () => true}) {
  const features = Array.isArray(geojson?.features) ? geojson.features : null;
  const dialog = document.createElement("dialog");
  dialog.className = "browser-layer-registration";
  const form = document.createElement("form");
  const text = (tag, value) => {const node = document.createElement(tag); node.textContent = value; return node;};
  const field = (name, value = "") => {
    const label = text("label", name), input = document.createElement("input");
    input.value = value ?? ""; input.setAttribute("aria-label", name); input.maxLength = 1000;
    label.append(input); form.append(label); return input;
  };
  form.append(text("h2", "Review Layer source"), text("p", "Review the source information before adding this Layer. Local files stay in your browser; remote Layers reference their provider. Nothing is uploaded."));
  const title = field("Layer title", layer.title); title.required = true; title.maxLength = 160;
  const curatedValue = name => Object.hasOwn(layer.metadata?.curated ?? {}, name)
    ? layer.metadata.curated[name] : source[name];
  const description = field("Description", curatedValue("description"));
  const license = field("License", curatedValue("license")); license.placeholder = "Unknown — not supplied by source";
  const attribution = field("Attribution", curatedValue("attribution"));
  const facts = document.createElement("dl");
  const storage = ({personal: "Saved on this device with your Project", browser: "Browser draft · save on this device to keep",
    demo: "Demo draft · save a personal copy to keep", temporary: "Temporary browser data · excluded from account Save · expires after 24 hours"})[storageMode];
  for (const [name, value] of Object.entries({Source: source.filename ?? source.url ?? "Catalog reference", Format: source.format ?? layer.sourceType, Features: features ? features.length : "Not inspected", Geometry: features ? [...new Set(features.map(f => f.geometry?.type).filter(Boolean))].join(", ") || "No supported geometry" : layer.geometryType ?? "Unknown", Coordinates: source.format === "nmea" ? "Degree coordinates · WGS 84 confirmation required" : features ? "WGS 84 longitude/latitude (normalized)" : source.configuration?.crs ?? "Provider-defined / not established", Storage: storage ?? "Browser draft"})) facts.append(text("dt", name), text("dd", String(value)));
  if (source.format === "gpx" && source.report?.counts) {
    const counts = source.report.counts;
    facts.append(text("dt", "GPX records"), text("dd", `${counts.waypoints} waypoints · ${counts.routes} routes · ${counts.tracks} tracks · ${counts.segments} segments`),
      text("dt", "Elevation and time"), text("dd", `${counts.elevations} elevations · ${counts.timestamps} timestamps · missing values retained`),
      text("dt", "Original file"), text("dd", `${source.bytes} bytes · SHA-256 ${source.sha256}`));
    if (source.report.rejectedRecords?.length) facts.append(text("dt", "Records without positions"), text("dd", `${source.report.rejectedRecords.length} retained in the original file`));
  }
  if (source.format === "nmea" && source.report?.counts) {
    const {counts, rejectedRecords = [], preservedRecords = []} = source.report;
    facts.append(text("dt", "NMEA observations"), text("dd", `${features?.length ?? 0} mapped observations · ${counts.records} source records · ${rejectedRecords.length} rejected · ${preservedRecords.length} other records preserved`),
      text("dt", "Heights and dates"), text("dd", "Mean-sea-level heights and original time/date fields remain in properties. Working points are XY; dates are not assigned a century."),
      text("dt", "Coordinate reference"), text("dd", "Confirm WGS 84 below before adding. Other datums require conversion."),
      text("dt", "Original file"), text("dd", `${source.bytes} bytes · SHA-256 ${source.sha256}`));
    if (rejectedRecords.length) {
      const details = document.createElement("details"), list = document.createElement("ul");
      for (const row of rejectedRecords.slice(0, 10)) list.append(text("li", `Record ${row.record}: ${row.reason}`));
      details.append(text("summary", "Rejected NMEA records"), list);form.append(details);
    }
  }
  if (source.format === "ozi" && source.report?.counts) {
    const {counts, rejectedRecords = []} = source.report;
    facts.append(text("dt", "OziExplorer records"), text("dd", `${source.variant?.toUpperCase() ?? "OziExplorer"} · ${counts.positions} positions · ${features?.length ?? 0} map features · ${rejectedRecords.length} rejected`),
      text("dt", "Source interpretation"), text("dd", "ASCII · header declares WGS 84 · decimal-degree coordinates"),
      text("dt", "Heights and dates"), text("dd", "Map geometry uses XY. Source feet and Delphi/date/time fields remain in properties without conversion."),
      text("dt", "Source styling"), text("dd", "Source symbols, colors and attachment references are retained without opening attachments. The map uses its Layer style."),
      text("dt", "Original file"), text("dd", `${source.bytes} bytes · SHA-256 ${source.sha256}`));
    if (source.variant === "plt") facts.append(text("dt", "Track runs"), text("dd", `${counts.segments} separate runs · source breaks and rejected positions end a run · single positions remain Points`));
    if (rejectedRecords.length) {
      const details = document.createElement("details"), list = document.createElement("ul");
      for (const row of rejectedRecords.slice(0, 10)) list.append(text("li", `Record ${row.record}: ${row.reason}`));
      details.append(text("summary", "Rejected OziExplorer records"), list);form.append(details);
    }
  }
  if (source.format === "delimited-text" && source.report?.mapping) {
    const {mapping, records, featureCount, rejectedRecords, elevations, missingElevations} = source.report;
    facts.append(text("dt", "Coordinate mapping"), text("dd", `${mapping.xColumn} / ${mapping.yColumn} · ${mapping.sourceProjection} → WGS 84`),
      text("dt", "Source records"), text("dd", `${featureCount} of ${records} mapped · ${rejectedRecords.length} omitted by your choice · original retained`),
      text("dt", "Original file"), text("dd", `${source.bytes} bytes · SHA-256 ${source.sha256}`));
    if (mapping.elevationColumn) facts.append(text("dt", "Elevation mapping"), text("dd", `${mapping.elevationColumn} · ${mapping.elevationUnit} → metres · ${elevations} supplied · ${missingElevations} missing · datum: ${mapping.verticalDatum || "not supplied"}`));
    if (rejectedRecords.length) {
      const details = document.createElement("details"), summary = text("summary", "Omitted source records"), list = document.createElement("ul");
      for (const row of rejectedRecords.slice(0, 10)) list.append(text("li", `Record ${row.record}: ${row.reason}`));
      details.append(summary, list);form.append(details);
    }
  }
  form.append(facts);
  const pointPresentation = layer.metadata?.curated?.pointPresentation;
  if (source.format === "delimited-text" && pointPresentation) {
    facts.append(text("dt", "Point styling"), text("dd", pointPresentation.mode === "category"
      ? `Categories from ${pointPresentation.categoryField} · ${pointPresentation.paletteName} palette · other values: ${pointPresentation.color}. The map uses eight common values; the legend previews five and palette colors can repeat.`
      : `One color: ${pointPresentation.color}`));
  }
  const confirmations = [];
  const confirm = (message, kind) => {
    const label = text("label", ""), input = document.createElement("input");
    label.className = "source-confirmation";input.type = "checkbox";input.required = true;
    input.setAttribute("aria-label", message);input.dataset.sourceConfirmation = kind;
    label.append(input, text("span", message));form.append(label);confirmations.push(input);
  };
  if (source.format === "nmea") {
    confirm("These positions use WGS 84 longitude/latitude.", "coordinates");
    if (source.report?.rejectedRecords?.length) confirm("Add the valid observations and retain rejected records in the original file.", "rejections");
  }
  if (source.format === "ozi" && source.report?.rejectedRecords?.length) {
    confirm("Add the valid positions and retain rejected records in the original file.", "rejections");
  }
  const status = text("p", ""); status.setAttribute("role", "status");
  if (source.format === "gpx" && source.originalFile) {
    const original = text("button", "Download original GPX");original.type = "button";
    original.onclick = async () => {original.disabled = true;try {
      const {downloadOriginalGpx} = await import("../lib/gpxImport.js");await downloadOriginalGpx(source);
    } catch (error) {status.textContent = error.message;} finally {original.disabled = false;}};
    form.append(original);
  }
  if (source.format === "nmea" && source.originalFile) {
    const original = text("button", "Download original NMEA");original.type = "button";
    original.onclick = async () => {original.disabled = true;try {
      const {downloadOriginalNmea} = await import("../lib/nmeaImport.js");await downloadOriginalNmea(source);
    } catch (error) {status.textContent = error.message;} finally {original.disabled = false;}};
    form.append(original);
  }
  if (source.format === "ozi" && source.originalFile) {
    const original = text("button", "Download original OziExplorer file");original.type = "button";
    original.onclick = async () => {original.disabled = true;try {
      const {downloadOriginalOzi} = await import("../lib/oziImport.js");await downloadOriginalOzi(source);
    } catch (error) {status.textContent = error.message;} finally {original.disabled = false;}};
    form.append(original);
  }
  if (source.format === "delimited-text" && source.originalFile) {
    const original = text("button", "Download original delimited file");original.type = "button";
    original.onclick = async () => {original.disabled = true;try {
      const {downloadOriginalDelimitedFile} = await import("../lib/delimitedTextImport.js");await downloadOriginalDelimitedFile(source);
    } catch (error) {status.textContent = error.message;} finally {original.disabled = false;}};
    form.append(original);
  }
  const add = text("button", "Add Layer to Project"); add.type = "submit";
  const cancel = text("button", "Cancel"); cancel.type = "button";
  const close = () => {dialog.close(); dialog.remove();};
  cancel.onclick = close;
  dialog.addEventListener("cancel", event => {event.preventDefault(); if (!cancel.disabled) close();});
  form.onsubmit = async event => {
    event.preventDefault(); if (add.disabled || !title.value.trim()) return;
    if (confirmations.some(input => !input.checked)) {
      status.textContent = source.format === "ozi" ? "Confirm that only valid positions will be added; rejected records remain in the original file." : "Confirm the coordinate reference and any rejected records before adding these observations.";
      return;
    }
    if (!isCurrent()) {
      status.textContent = "The Project has changed. Close this review and choose the Layer from the current Project's catalog.";
      add.disabled = true;
      return;
    }
    add.disabled = cancel.disabled = true;
    try {
      // Reusing a catalog Layer must not discard knowledge outside this small form.
      const prior = structuredClone(layer.metadata ?? {});
      const metadata = {
        ...prior,
        source: prior.source ?? structuredClone(source),
        normalized: {...prior.normalized, ...(features ? {featureCount: features.length, crs: "OGC:CRS84"} : {})},
        curated: {...prior.curated, title: title.value.trim(), description: description.value.trim() || null,
          license: license.value.trim() || null, attribution: attribution.value.trim() || null,
          ...(source.format === "nmea" ? {sourceProjection: "EPSG:4326", coordinateReferenceMethod: "user-confirmed", rejectedRecordPolicy: "explicit-omit-original-retained"} : {}),
          ...(source.format === "ozi" ? {sourceProjection: "EPSG:4326", coordinateReferenceMethod: "source-header", rejectedRecordPolicy: source.report?.rejectedRecords?.length ? "explicit-omit-original-retained" : "all-valid-records"} : {})},
        inferred: prior.inferred ?? {}
      };
      await onAdd({...layer, title: title.value.trim(), metadata}, geojson); close();
    } catch {status.textContent = "The Layer could not be added. Your source and metadata are still here; try again."; add.disabled = cancel.disabled = false;}
  };
  form.append(status, add, cancel); dialog.append(form); document.body.append(dialog); dialog.showModal(); title.focus();
  return dialog;
}
