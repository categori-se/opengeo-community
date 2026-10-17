import {readDelimitedFile, inspectDelimitedText, mapDelimitedText} from "../lib/delimitedTextImport.js";
import {STYLE_PALETTES} from "../lib/workbenchConfig.js";

export async function DelimitedTextImport({file, shell, isCurrent = () => true, maximumFeatures = 5_000, onReview}) {
  const source = await readDelimitedFile(file);
  if (!isCurrent()) return null;
  const dialog = document.createElement("dialog");dialog.className = "browser-layer-registration delimited-text-import";
  const palette = shell.ownerDocument.defaultView.getComputedStyle(shell);
  for (const key of ["--gis-panel-bg", "--gis-ink", "--gis-line"]) dialog.style.setProperty(key, palette.getPropertyValue(key));
  const text = (tag, value) => {const n = document.createElement(tag);n.textContent = value;return n;};
  const form = document.createElement("form");
  const select = (label, entries, required = true) => {
    const wrapper = text("label", label), input = document.createElement("select");input.setAttribute("aria-label", label);input.required = required;
    for (const [value, title] of entries) {const option = text("option", title);option.value = value;input.append(option);}
    wrapper.append(input);return {wrapper, input};
  };
  const delimiter = select("Separator", [[",", "Comma"], ["\t", "Tab"], [";", "Semicolon"], ["|", "Pipe"]]);delimiter.input.value = /\.tsv$/i.test(file.name) ? "\t" : ",";
  const projection = select("Source coordinate system", [["", "Choose the source coordinate system"], ["EPSG:4326", "WGS 84 · longitude / latitude in degrees"], ["EPSG:3857", "Web Mercator · easting / northing in metres"]]);
  const x = select("Longitude / easting column", []), y = select("Latitude / northing column", []), elevation = select("Elevation column", [], false), name = select("Label column", [], false);
  const units = select("Elevation unit", [["meter", "Metres"], ["foot", "International feet"], ["us-survey-foot", "US survey feet"]]);
  const colorLabel = text("label", "Point color"), color = document.createElement("input");color.type = "color";color.value = "#06b6d4";color.setAttribute("aria-label", "Point color");colorLabel.append(color);
  const category = select("Color category column", [], false);
  const categoryPalettes = STYLE_PALETTES.filter(([, , colors]) => colors.length);
  const colors = select("Category palette", categoryPalettes.map(([id, title]) => [id, title]));colors.input.value = "opengeo";colors.input.disabled = true;
  const colorNote = text("p", "One color applies to every point. Source values remain text.");
  const updateColorChoice = () => {
    colors.input.disabled = !category.input.value;
    colorNote.textContent = category.input.value
      ? "The eight most frequent nonempty values use the selected palette; palette colors repeat when needed. Other values use Point color. The legend previews five values. Groups follow the current data."
      : "One color applies to every point. Source values remain text.";
  };
  category.input.onchange = updateColorChoice;
  const datumLabel = text("label", "Vertical datum (optional)"), datum = document.createElement("input");datum.setAttribute("aria-label", "Vertical datum (optional)");datum.maxLength = 240;datumLabel.append(datum);
  const skipLabel = document.createElement("label"), skip = document.createElement("input");skip.type = "checkbox";skip.setAttribute("aria-label", "Omit records that cannot be mapped");skipLabel.append(skip, " Omit records that cannot be mapped");
  const preview = document.createElement("div");preview.className = "delimited-preview";preview.tabIndex = 0;preview.setAttribute("role", "region");preview.setAttribute("aria-label", "Source values preview");
  const status = text("p", "");status.setAttribute("role", "status");
  const issues = document.createElement("ul");issues.setAttribute("aria-label", "Records that cannot be mapped");
  const submit = text("button", "Review Layer");submit.type = "submit";
  const cancel = text("button", "Cancel");cancel.type = "button";
  const close = () => {dialog.close();dialog.remove();};cancel.onclick = close;
  dialog.addEventListener("cancel", event => {event.preventDefault();close();});
  let table;
  const parse = () => {
    try {
      table = inspectDelimitedText(source, delimiter.input.value);status.textContent = `${table.rows.length} records · ${table.columns.length} columns · ${source.bytes} bytes. Source values remain text.`;issues.replaceChildren();
      for (const field of [x, y, elevation, name, category]) {
        field.input.replaceChildren();for (const [i, title] of ["Choose a column", ...table.columns].entries()) {const option = text("option", i ? title : field === category ? "One color" : field === elevation || field === name ? "None" : title);option.value = i ? title : "";field.input.append(option);}
      }
      updateColorChoice();
      const suggestion = (field, pattern) => {const matches = table.columns.filter(c => pattern.test(c.trim()));if (matches.length === 1) field.input.value = matches[0];};
      suggestion(x, /^(lon|lng|longitude|easting|x)$/i);suggestion(y, /^(lat|latitude|northing|y)$/i);
      const grid = document.createElement("table"), head = document.createElement("thead"), tr = document.createElement("tr");for (const title of table.columns) tr.append(text("th", title));head.append(tr);grid.append(head);
      const body = document.createElement("tbody");for (const row of table.rows.slice(0, 5)) {const tr = document.createElement("tr");for (const value of row) tr.append(text("td", value));body.append(tr);}grid.append(body);preview.replaceChildren(grid);submit.disabled = false;
    } catch (error) {table = null;status.textContent = error.message;preview.replaceChildren();submit.disabled = true;}
  };
  delimiter.input.onchange = parse;
  form.onsubmit = event => {
    event.preventDefault();if (submit.disabled || !table) return;
    if (!isCurrent()) {status.textContent = "The Project has changed. Close this import and choose the file again.";submit.disabled = true;return;}
    try {
      const parsed = mapDelimitedText(table, {xColumn: x.input.value, yColumn: y.input.value, sourceProjection: projection.input.value, elevationColumn: elevation.input.value || null, elevationUnit: units.input.value, verticalDatum: datum.value, skipInvalid: skip.checked, maximumFeatures});
      if (!/^#[0-9a-f]{6}$/i.test(color.value)) throw new Error("Choose a valid Point color.");
      const categoryField = category.input.value || null;
      if (categoryField && !table.columns.includes(categoryField)) throw new Error("Choose an available color category column.");
      const selectedPalette = categoryPalettes.find(([id]) => id === colors.input.value);
      if (categoryField && !selectedPalette) throw new Error("Choose a category palette.");
      const style = {renderer: categoryField ? "category" : "single", circleColor: color.value, circleRadius: 6, stroke: color.value, strokeWidth: 2,
        ...(categoryField ? {categoryField, paletteName: selectedPalette[0], palette: [...selectedPalette[2]]} : {})};
      const pointPresentation = {mode: style.renderer, color: color.value, categoryField, paletteName: categoryField ? selectedPalette[0] : null};
      const labelField = name.input.value || null;close();onReview({...parsed, labelField, style, pointPresentation});
    } catch (error) {
      status.textContent = error.message;issues.replaceChildren(...(error.report?.rejectedRecords ?? []).slice(0, 10).map(row => text("li", `Record ${row.record}: ${row.reason}`)));
    }
  };
  form.append(text("h2", "Import delimited coordinates"), text("p", `${source.filename} · Choose columns and the source coordinate system. Preview changes nothing; the next step reviews the Layer. Local files stay in this browser.`), delimiter.wrapper, projection.wrapper, x.wrapper, y.wrapper, elevation.wrapper, units.wrapper, datumLabel, name.wrapper, colorLabel, category.wrapper, colors.wrapper, colorNote, skipLabel, preview, status, issues, submit, cancel);
  dialog.append(form);document.body.append(dialog);parse();dialog.showModal();projection.input.focus();return dialog;
}
