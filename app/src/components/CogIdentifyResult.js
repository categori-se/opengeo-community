/** The numeric sample is already in memory; rendering this table performs no I/O. */
export function CogIdentifyResult(sample) {
  const root = node("section");root.className = "cog-identify-result";root.dataset.sampleStatus = sample.status;
  if (sample.status !== "ready") {
    root.append(node("p", sample.status === "outside-window"
      ? "Outside the loaded raster window. Refresh the raster window to inspect this area."
      : "Load the raster window, then click the map to inspect its values."));
    return root;
  }
  const values = node("dl");values.className = "gis-popup";
  for (const band of sample.samples) {
    const value = band.value === null ? band.nonfinite ?? "Missing" : String(band.value);
    values.append(node("dt", `Band ${band.band}`), node("dd", band.missing === "source-nodata" ? `NoData (${value})` : value));
  }
  root.append(values, node("small", sample.grid.imageIndex === 0
    ? "Main raster grid · loaded window" : `Overview grid · ${sample.grid.width} × ${sample.grid.height} pixels · loaded window`));
  if (sample.missing === "display-mask") root.append(node("p", "This value is hidden by the display's transparent-value setting."));
  const details = node("details"), summary = node("summary", "Sample context"), fields = node("dl");fields.className = "gis-popup";
  for (const [label, value] of [
    ["Location", sample.location.join(", ")], ["Pixel (column, row; zero-based)", `${sample.pixel.column}, ${sample.pixel.row}`],
    ["Grid level", sample.grid.imageIndex], ["Pixel interpretation", sample.grid.interpretation],
    ["CRS", sample.grid.projection], ["Provider version", sample.snapshot.etag ?? "Not reported"],
    ["Snapshot", sample.snapshot.verified ? "ETag checked" : "Unverified"], ["Read method", "Cached decoded source window"]
  ]) fields.append(node("dt", label), node("dd", String(value)));
  details.append(summary, fields);root.append(details);return root;
}

function node(tag, text = "") {const element = document.createElement(tag);element.textContent = text;return element;}
