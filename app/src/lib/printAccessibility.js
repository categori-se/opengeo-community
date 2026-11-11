import {assertPrintDataFrameSnapshot} from "./printDataFrames.js";

// Language is authored document metadata, independent of the Studio UI language.
export function printDocumentLanguage(layout) {
  const language = layout.language ?? "en";
  if (typeof language !== "string" || language.length > 63 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) throw Error("Enter a document language tag such as en, fr or pt-BR.");
  try {return new Intl.Locale(language).toString();} catch {throw Error("Enter a document language tag such as en, fr or pt-BR.");}
}

export function printDataReadingCell(frame, snapshot, row, column) {
  const kind = snapshot.cellKinds[row][column];
  if (kind === "null") return "[null]";
  if (kind === "blank") return "[blank]";
  if (kind === "nonnumeric") return `${JSON.stringify(snapshot.rawValues[row])} [nonnumeric; not plotted]`;
  return String(frame.type === "chart" && column === 1 ? snapshot.rawValues[row] : snapshot.rows[row][column]);
}

export function printMapDescriptionStatus(layout) {
  return layout.frames.map(frame => ({frameId: frame.id, supplied: typeof frame.description === "string" && Boolean(frame.description.trim())}));
}

export function printMapReadingContext(layout, capture) {
  const result = [...(capture.displayNotes ?? [])];
  if (Array.isArray(capture.view?.center)) result.push(`Map centre: longitude ${capture.view.center[0]}, latitude ${capture.view.center[1]}. Bearing: ${capture.view.bearing ?? 0} degrees.`);
  if (capture.flat === false) result.push("3D view; compass, measured scale and grid omitted.");
  if (layout.scaleBar && capture.flat && Number.isFinite(capture.metresPerPixel)) result.push(`Captured map resolution: ${capture.metresPerPixel} metres per display pixel.`);
  if (layout.graticule && capture.flat) result.push(...(capture.lines ?? []).map(line => `Grid: ${line.label}.`));
  return result;
}

// The page image remains the complete visual figure. Its alternative carries
// authored interpretation and captured values, never inferred spatial findings.
export function printPageAlternative(layout, captures) {
  const text = [layout.title, layout.caption];
  for (const item of layout.textFrames ?? []) text.push(item.title, item.type === "math" ? `Equation source (LaTeX): ${item.text}` : item.text);
  for (const frame of layout.frames) {
    const capture = captures.get(`${layout.id}:${frame.id}`);
    if (!capture) throw Error("Capture every map frame before exporting reading notes.");
    text.push(frame.title, frame.description?.trim() ? frame.description : "No map description supplied.");
    text.push(...printMapReadingContext(layout, capture));
    text.push(...(capture.legend ?? []).map(row => row.label), ...(capture.attribution ?? []), ...(capture.sourceMetadata ?? []).map(source => `${source.title ?? "Layer"}. License: ${source.license || "not recorded"}.`));
  }
  for (const frame of layout.dataFrames ?? []) {
    const capture = captures.get(`${layout.id}:${frame.mapFrameId}`);
    const snapshot = assertPrintDataFrameSnapshot(frame, capture?.dataFrames?.find(item => item.frameId === frame.id), capture?.presentation);
    text.push(frame.title, frame.altText, snapshot.scopeText, "Map filter applies; map extent does not limit these rows.", ...snapshot.notices);
    snapshot.rows.forEach((row, index) => text.push(row.map((_, column) => `${snapshot.columns[column]}: ${printDataReadingCell(frame, snapshot, index, column)}`).join("; ")));
  }
  const result = text.filter(Boolean).join("\n");
  if (result.length > 131072) throw Error("The page description exceeds the 128 KiB text limit. Reduce captured rows or source notes.");
  return result;
}

// Literal Unicode PDF strings: parentheses, markup and non-Latin text stay inert.
export function printPdfUnicode(value) {
  return `<FEFF${Array.from({length: value.length}, (_, index) => value.charCodeAt(index).toString(16).padStart(4, "0")).join("")}>`;
}
