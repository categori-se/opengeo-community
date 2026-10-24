import {PRINT_TEMPLATE_SCHEMA, validatePrintTemplate} from "./printTemplates.js";

// A deliberately bounded QGIS 3 Layout profile, not a QGIS project loader.
// Native items own geometry/text/columns. Custom properties only retain settings
// for which the portable OpenGeo model has no corresponding native field.
const SETTINGS = "opengeo/print-template", ROLE = "opengeo/role";
const TYPES = {page: "65638", map: "65639", label: "65641", legend: "65642", scale: "65646", tableFrame: "65647", table: "65649"};
const PROFILE = "opengeo.qpt-settings.1";
const bytes = value => new TextEncoder().encode(value).byteLength;
const paper = {Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8], A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189]};
const sourceNotice = "Map extents, CRS, Layer identities, visibility presets and styles are not imported. Applying this source-free template uses the destination Project's current camera and presentation; tables require explicit current-Layer binding and fresh captures.";
const furnitureNotice = "OpenGeo uses fixed positions and styles for title/caption furniture, legends, scale bars, north arrows and source notes. Native furniture positions, fonts and styling are not retained; map, table and positioned text frame geometry is retained.";

/** Export real editable native Layout items; no project sources or captured data. */
export function exportQgisPrintTemplate(template) {
  const value = validatePrintTemplate(template);
  if (value.textFrames?.some(frame => frame.type === "math")) throw Error("QGIS template exchange does not support math frames. Use the JSON template format to preserve LaTeX source, appearance and geometry.");
  if (value.dataFrames?.some(frame => frame.type === "chart")) throw Error("QGIS template exchange does not support bar or line chart slots. Use the JSON template format to preserve every chart setting.");
  // QGIS label expressions run even when htmlState=0. Literal XML escaping alone
  // does not stop [% ... %] expansion in a native QGIS application.
  for (const text of [value.name, value.caption, ...value.frames.map(frame => frame.title), ...(value.dataFrames ?? []).flatMap(frame => [frame.title, ...frame.columns]), ...(value.textFrames ?? []).flatMap(frame => [frame.title, frame.text])]) literal(text);
  const settings = {schemaVersion: PROFILE, id: value.id, page: {size: value.page.size, orientation: value.page.orientation, marginMm: value.page.marginMm},
    ...(Object.hasOwn(value, "legendFormat") ? {legendFormat: value.legendFormat} : {}), ...(Object.hasOwn(value, "dataFrames") ? {dataFramesPresent: true} : {}),
    ...(Object.hasOwn(value, "textFrames") ? {textFramesPresent: true} : {})};
  let sequence = 1;
  const uuid = () => `{00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}}`;
  const occupied = [...value.frames, ...(value.dataFrames ?? [])];
  const nativeItem = (type, uuid, role, frame, extra, content) => {
    if (frame.xMm < 0 || frame.yMm < 0 || frame.widthMm <= 0 || frame.heightMm <= 0 || frame.xMm + frame.widthMm > value.page.widthMm + 0.001 || frame.yMm + frame.heightMm > value.page.heightMm + 0.001)
      throw Error(`QGIS ${role} furniture needs more page space. Move or enlarge the map frame, or turn off that furniture before QGIS export.`);
    if (![TYPES.page, TYPES.map, TYPES.tableFrame].includes(type)) occupied.push(frame);
    return item(type, uuid, role, frame, extra, content);
  };
  const pageUuid = uuid(), mapUuids = Object.fromEntries(value.frames.map(frame => [frame.id, uuid()]));
  const items = [], multis = [], margin = value.page.marginMm;
  const addLabel = (role, text, geometry, fontSize = 10) => items.push(nativeItem(TYPES.label, uuid(), role, geometry, {labelText: text, htmlState: 0, marginX: 0, marginY: 0, halign: 1, valign: 32}, textStyle(fontSize)));
  for (const frame of value.frames) {
    // QGIS 3.44 MapGrid inherits the "show" switch from MapItem. Its geographic
    // CRS is a direct spatialrefsys child, independent of the map's later CRS.
    const grid = value.graticule ? `<ComposerMapGrid${attributes({uuid: uuid(), name: "Latitude / longitude", show: 1, gridStyle: 0, intervalX: 10, intervalY: 10,
      offsetX: 0, offsetY: 0, unit: 0, showAnnotation: 1, annotationFormat: 0, annotationPrecision: 0, leftAnnotationPosition: 0, rightAnnotationPosition: 0, topAnnotationPosition: 0, bottomAnnotationPosition: 0})}><spatialrefsys><srsid>3452</srsid><authid>EPSG:4326</authid><description>WGS 84</description><geographicflag>true</geographicflag></spatialrefsys></ComposerMapGrid>` : "";
    items.push(nativeItem(TYPES.map, mapUuids[frame.id], frame.id, frame, {id: frame.title, keepLayerSet: "true", followPreset: "false", drawCanvasItems: "false", mapRotation: 0},
      `<Extent xmin="0" ymin="0" xmax="${frame.widthMm}" ymax="${frame.heightMm}"/><LayerSet/>${grid}`));
    if (value.northArrow) addLabel(`north-${frame.id}`, "N ↑", {xMm: frame.xMm + frame.widthMm - 15, yMm: frame.yMm + 2, widthMm: 13, heightMm: 14}, 12);
    if (value.scaleBar) {
      const widthMm = Math.min(50, frame.widthMm - 8), maximumBarMm = widthMm - 10;
      if (maximumBarMm < 30) throw Error(`QGIS scale-${frame.id} furniture needs more page space. Widen this map to at least 48 mm, or turn off scale bars before QGIS export.`);
      // FitWidth measures the segment strip, excluding endpoint text. Reserve
      // 10 mm for labels and let native QGIS choose a readable measured distance
      // whenever the destination map extent changes.
      items.push(nativeItem(TYPES.scale, uuid(), `scale-${frame.id}`, {xMm: frame.xMm + 4, yMm: frame.yMm + frame.heightMm - 12, widthMm, heightMm: 10},
        {mapUuid: mapUuids[frame.id], style: "Single Box", unitType: "meters", unitLabel: "m", numSegments: 2, numSegmentsLeft: 0, numUnitsPerSegment: 1, numMapUnitsPerScaleBarUnit: 1,
          segmentSizeMode: 1, labelHorizontalPlacement: 0, labelVerticalPlacement: 0, height: 1.4, labelBarSpace: 1, boxContentSpace: 0, outlineWidth: 0.3,
          minBarWidth: maximumBarMm * 0.65, maxBarWidth: maximumBarMm}, `${textStyle(8)}<fillColor red="0" green="0" blue="0" alpha="255"/><fillColor2 red="255" green="255" blue="255" alpha="255"/>`));
    }
  }
  addLabel("title", value.name, {xMm: margin, yMm: Math.min(4, value.page.heightMm - 10), widthMm: value.page.widthMm - 2 * margin, heightMm: 10}, 14);
  if (value.caption) addLabel("caption", value.caption, {xMm: margin, yMm: value.page.heightMm - 17, widthMm: value.page.widthMm - 2 * margin, heightMm: 12});
  if (value.sourceNotes) addLabel("source-notes", "Source notes: bind destination Project Layers and refresh captures.", {xMm: margin, yMm: value.page.heightMm - 7, widthMm: value.page.widthMm - 2 * margin, heightMm: 6}, 7);
  for (const frame of value.textFrames ?? []) {
    const fill = frame.background === "none" ? "" : `<BackgroundColor${attributes(rgba(frame.background))}/>`;
    items.push(nativeItem(TYPES.label, uuid(), `text-${frame.id}`, frame, {id: frame.title, labelText: frame.text, htmlState: 0, marginX: 1, marginY: 1,
      halign: {left: 1, center: 4, right: 2}[frame.alignment], valign: 32, background: frame.background !== "none", zValue: 2}, `${fill}${textStyle(frame.fontSizePt, frame.color, true)}`));
  }
  if (value.legend) {
    const rectangle = legendRectangle(value.page, value.frames[0], occupied);
    const styles = ["title", "group", "subgroup", "symbol", "symbolLabel"].map(name => `<style${attributes({name, alignment: 1, indent: 0, marginTop: 1, marginBottom: name === "title" ? 2 : 0,
      ...(name === "symbolLabel" ? {marginLeft: 2} : {})})}>${textStyle(name === "title" ? 10 : 8)}</style>`).join("");
    items.push(nativeItem(TYPES.legend, uuid(), "legend", rectangle,
      {map_uuid: mapUuids.main, title: "Legend", columnCount: 1, resizeToContents: 0, symbolWidth: 7, symbolHeight: 4, boxSpace: 2,
        autoWrapLinesAfter: rectangle.widthMm - 13}, `<layer-tree-group name="" checked="Qt::Checked"/><styles>${styles}</styles>`));
  }
  for (const frame of value.dataFrames ?? []) {
    const frameUuid = uuid(), multiUuid = uuid();
    items.push(nativeItem(TYPES.tableFrame, frameUuid, frame.id, frame, {id: frame.title, multiFrame: multiUuid, multiFrameTemplateUuid: multiUuid, sectionX: 0, sectionY: 0,
      sectionWidth: frame.widthMm, sectionHeight: frame.heightMm, hidePageIfEmpty: 0, hideBackgroundIfEmpty: 0}));
    multis.push(`<LayoutMultiFrame${attributes({type: TYPES.table, uuid: multiUuid, templateUuid: multiUuid, source: 0, mapUuid: mapUuids[frame.mapFrameId], maxFeatures: frame.rowLimit,
      resizeMode: 0, headerMode: 0, emptyTableMode: 0, cellMargin: 0, gridStrokeWidth: 0, showGrid: 0, showEmptyRows: 0, filterFeatures: "false", featureFilter: "", showOnlyVisibleFeatures: 0})}>
<childFrame uuid="${frameUuid}" templateUuid="${frameUuid}"/>${layoutObject(frame.id)}<headerTextFormat>${textStyle(10)}</headerTextFormat><contentTextFormat>${textStyle(10)}</contentTextFormat>
<displayColumns>${frame.columns.map(column => `<column${attributes({attribute: `"${column.replaceAll('"', '""')}"`, heading: column, width: frame.widthMm / frame.columns.length, hAlignment: 1, vAlignment: 128, sortOrder: 0, sortByRank: 0})}/>`).join("")}</displayColumns><sortColumns/></LayoutMultiFrame>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Layout${attributes({name: value.name, units: "mm", printResolution: value.dpi, worldFileMap: ""})}>
<PageCollection>${nativeItem(TYPES.page, pageUuid, "page", {xMm: 0, yMm: 0, widthMm: value.page.widthMm, heightMm: value.page.heightMm})}</PageCollection>
${items.join("\n")}\n${multis.join("\n")}\n<customproperties><Option type="Map"><Option${attributes({name: SETTINGS, type: "QString", value: JSON.stringify(settings)})}/></Option></customproperties></Layout>`;
  if (bytes(xml) > 1_048_576) throw Error("QGIS template exceeds the 1 MiB XML limit.");
  return xml;
}

/** Reviewable native QPT conversion. Never resolves native layers, assets or code. */
export function importQgisPrintTemplate(xml, {name, DOMParser: Parser = globalThis.DOMParser} = {}) {
  preflight(xml); // Must finish before invoking a browser XML parser.
  if (typeof Parser !== "function") throw Error("An XML DOMParser is required to import a QGIS template.");
  const document = new Parser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length || document.documentElement?.tagName !== "Layout") throw Error("Choose a well-formed QGIS 3 Layout template.");
  const root = document.documentElement, notices = [sourceNotice, furnitureNotice];
  const settingsText = property(root, SETTINGS), settings = settingsText ? readSettings(settingsText) : null;
  const pages = direct(root, "PageCollection").flatMap(collection => direct(collection, "LayoutItem"));
  if (pages.length !== 1 || pages[0].getAttribute("type") !== TYPES.page) throw Error("QGIS template exchange supports exactly one native Layout page.");
  const [widthMm, heightMm] = measurement(pages[0].getAttribute("size")), page = {size: settings?.page.size ?? paperName(widthMm, heightMm),
    orientation: widthMm === heightMm && settings ? settings.page.orientation : widthMm > heightMm ? "landscape" : "portrait", widthMm, heightMm, marginMm: settings?.page.marginMm ?? 10};
  if (settings && settings.page.orientation !== page.orientation && widthMm !== heightMm) notices.push("Native page dimensions changed the saved page orientation.");
  if (settings && settings.page.size !== "Custom" && !matchesPaper(settings.page.size, widthMm, heightMm)) page.size = paperName(widthMm, heightMm);
  const all = direct(root, "LayoutItem"), maps = all.filter(element => element.getAttribute("type") === TYPES.map);
  const nativeIds = new Set();
  for (const element of [...pages, ...all, ...direct(root, "LayoutMultiFrame")]) {
    for (const id of new Set([element.getAttribute("uuid"), element.getAttribute("templateUuid")].filter(Boolean))) {
      if (nativeIds.has(id)) throw Error("Duplicate native QGIS item identities are unsupported.");nativeIds.add(id);
    }
  }
  if (maps.length < 1 || maps.length > 2) throw Error("QGIS template exchange requires one main map and at most one inset map.");
  const tagged = maps.find(element => property(element, ROLE) === "main"), named = maps.find(element => /^main(?:\b|$)/i.test(element.getAttribute("id") ?? ""));
  const main = tagged ?? named ?? [...maps].sort((a, b) => area(b) - area(a))[0];
  const ordered = [main, ...maps.filter(element => element !== main)], ids = new Map();
  const frames = ordered.map((element, index) => {
    const id = index ? "inset" : "main";for (const key of ["uuid", "templateUuid"]) if (element.getAttribute(key)) ids.set(element.getAttribute(key), id);
    return {id, parentId: index ? "main" : null, title: element.getAttribute("id") || (index ? "Inset" : "Main map"), ...geometry(element)};
  });
  const labels = all.filter(element => element.getAttribute("type") === TYPES.label), captions = [], textLabels = [];
  let northArrow = false, sourceNotes = false;
  for (const label of labels) {
    const role = property(label, ROLE), legacyRole = role ?? label.getAttribute("id"), text = label.getAttribute("labelText") ?? "";
    if (role?.startsWith("text-")) textLabels.push(label);
    else if (/^north-(?:main|inset)$/.test(legacyRole ?? "") || /^(?:N\s*[↑▲]|[↑▲]\s*N)$/.test(text.trim())) northArrow = true;
    else if (legacyRole === "source-notes") sourceNotes = true;
    else if (legacyRole === "caption") captions.push(text);
    else if (legacyRole === "title") {
      const destinationName = name ?? (root.getAttribute("name") || "QGIS template");
      if (text !== destinationName) notices.push(`Native title label “${text}” is normalized to the layout name “${destinationName}”; its distinct text, position and style are not retained.`);
    } else textLabels.push(label);
  }
  if (captions.length > 1) notices.push(`${captions.length} native caption labels are combined in the OpenGeo caption; their individual positions and styles are not retained.`);
  const dpi = numeric(root.getAttribute("printResolution") || 96);
  if (![96, 150, 300].includes(dpi)) throw Error("QGIS template resolution must be 96, 150 or 300 DPI for OpenGeo.");
  const result = {schemaVersion: PRINT_TEMPLATE_SCHEMA, id: settings?.id ?? "qgis-template", name: name ?? (root.getAttribute("name") || "QGIS template"), page, dpi,
    legend: all.some(element => element.getAttribute("type") === TYPES.legend), northArrow, scaleBar: all.some(element => element.getAttribute("type") === TYPES.scale),
    graticule: ordered.some(element => [...element.getElementsByTagName("ComposerMapGrid")].some(grid => enabled(grid.getAttribute("show")))), sourceNotes,
    caption: captions.join("\n"), frames, ...(settings && Object.hasOwn(settings, "legendFormat") ? {legendFormat: settings.legendFormat} : {})};
  if (textLabels.length > 8) throw Error("QGIS template exchange supports at most eight positioned text frames.");
  const textOrder = textLabels.map(label => /^text-text-([1-8])$/.exec(property(label, ROLE) ?? "")?.[1]);
  if (textOrder.every(Boolean) && new Set(textOrder).size === textLabels.length)
    textLabels.sort((a, b) => Number(property(a, ROLE).slice(10)) - Number(property(b, ROLE).slice(10)));
  if (textLabels.length) notices.push("Positioned text uses Open Sans with a 1 mm inner margin and fixed line spacing. Native font availability and substitution can change metrics and wrapping; review text fit after exchange.");
  if (textLabels.length || settings?.textFramesPresent) result.textFrames = textLabels.map((label, index) => nativeTextFrame(label, `text-${index + 1}`, index, notices));
  const tableFrames = all.filter(element => element.getAttribute("type") === TYPES.tableFrame).sort((a, b) => {
    const left = /^data-(\d)$/.exec(property(a, ROLE) ?? ""), right = /^data-(\d)$/.exec(property(b, ROLE) ?? "");
    return left && right ? Number(left[1]) - Number(right[1]) : 0;
  }), multis = direct(root, "LayoutMultiFrame");
  if (tableFrames.length > 4) throw Error("QGIS template exchange supports at most four table slots.");
  if (multis.length !== tableFrames.length) throw Error("Every QGIS table must have exactly one frame; other multi-frame content is unsupported.");
  const claimedTables = new Set();
  if (tableFrames.length || settings?.dataFramesPresent) result.dataFrames = tableFrames.map((element, index) => {
    const frameIds = identities(element), parentIds = [element.getAttribute("multiFrame"), element.getAttribute("multiFrameTemplateUuid")].filter(Boolean);
    // QGIS loadFromTemplate can remint both native identities while retaining old
    // forward multiFrame references. Its saved childFrame links own the restored
    // relationship. Never infer a table from order or from an unrelated source.
    const reciprocal = multis.filter(candidate => direct(candidate, "childFrame").some(child => identities(child).some(id => frameIds.includes(id))));
    if (reciprocal.length !== 1) throw Error("Ambiguous or missing native QGIS table child-frame relationship.");
    const multi = reciprocal[0], forward = multis.filter(candidate => identities(candidate).some(id => parentIds.includes(id)));
    const children = direct(multi, "childFrame");
    if (forward.some(candidate => candidate !== multi) || claimedTables.has(multi)
      || children.some(child => identities(child).some(id => tableFrames.some(other => other !== element && identities(other).includes(id))))) throw Error("Conflicting native QGIS table frame relationships.");
    if (multi.getAttribute("type") !== TYPES.table || children.length !== 1) throw Error("Only single-frame native attribute tables are supported by QGIS template exchange.");
    claimedTables.add(multi);
    if ((multi.getAttribute("source") || "0") !== "0") throw Error("QGIS relation and atlas tables are unsupported; use an unbound attribute table.");
    const columns = direct(multi, "displayColumns").flatMap(node => direct(node, "column")).map(column => literalColumn(column.getAttribute("attribute")));
    const mapFrameId = ids.get(multi.getAttribute("mapUuid"));
    if (!mapFrameId) throw Error("Link each native QGIS attribute table to the main or inset map before import.");
    return {id: `data-${index + 1}`, type: "table", title: element.getAttribute("id") || `Table ${index + 1}`, ...geometry(element), mapFrameId,
      sourceSlot: `source-${index + 1}`, rowLimit: numeric(multi.getAttribute("maxFeatures") || 6), columns};
  });
  if (tableFrames.length) notices.push("Native attribute tables become unbound data slots. Literal columns, row limits, linked maps and frame geometry are retained; native table sources, filtering, sorting and cell styling are not imported.");
  if (result.legend && result.legendFormat && result.legendFormat !== "swatches") notices.push("The OpenGeo classed/continuous legend preference is retained as supplemental settings; QGIS uses its native linked legend styling.");
  if (result.scaleBar || result.northArrow || result.graticule) notices.push("Scale, north and grid values are recomputed from fresh destination captures. QGIS export uses neutral map extents and requires deliberate native Layer/extent binding before cartographic output.");
  if (result.legend || result.scaleBar || result.northArrow || result.graticule) notices.push("Legends use the OpenGeo main map; north, scale and grid switches apply to every map frame. Native furniture links and per-frame differences are not retained.");
  if (result.legend || result.scaleBar) notices.push("QGIS export reserves free paper space for the legend and fits scale strips to their map frames. Check the actual legend content and scale labels after assigning native Layers or changing extents; destination content can need more space.");
  if (northArrow) notices.push("QGIS exchange uses a static literal north annotation. Native map-linked rotation is not transferred; verify north direction after assigning the native map extent.");
  return {template: validatePrintTemplate(result), notices};
}

function geometry(element) {
  if (numeric(element.getAttribute("itemRotation") || 0) !== 0 || numeric(element.getAttribute("referencePoint") || 0) !== 0) throw Error("Rotated items and non-top-left reference points are unsupported by QGIS template exchange.");
  if (element.getAttribute("visibility") === "0" || element.getAttribute("excludeFromExports") === "1") throw Error("Hidden or excluded native items are unsupported by QGIS template exchange.");
  const [xMm, yMm] = measurement(element.getAttribute("positionOnPage") || element.getAttribute("position")), [widthMm, heightMm] = measurement(element.getAttribute("size"));
  return {xMm, yMm, widthMm, heightMm};
}
function nativeTextFrame(element, id, index, notices) {
  const styles = direct(element, "text-style"), fail = detail => {throw Error(`Unsupported native QGIS positioned text ${detail}. Use plain, top-aligned text with a regular point-size font.`);};
  const active = value => value !== null && !["", "0", "false"].includes(value);
  if (styles.length !== 1) fail("font configuration");
  const style = styles[0], alignment = {1: "left", 4: "center", 2: "right"}[element.getAttribute("halign") || "1"];
  if ([...element.children].some(child => !["LayoutObject", "FrameColor", "BackgroundColor", "text-style", "customproperties"].includes(child.tagName))) fail("item configuration");
  const styleFields = ["fontFamily", "fontSize", "fontSizeUnit", "textColor", "allowHtml", "fontWeight", "fontItalic", "forcedBold", "forcedItalic", "fontUnderline", "fontStrikeout",
    "namedStyle", "fontLetterSpacing", "fontWordSpacing", "capitalization", "textOpacity", "blendMode", "textOrientation", "multilineHeight", "multilineHeightUnit", "fontKerning",
    "previewBkgrdColor", "tabStopDistance", "tabStopDistanceUnit", "tabStopDistanceMapUnitScale", "fontSizeMapUnitScale"];
  if ([...style.attributes].some(attribute => !styleFields.includes(attribute.name))
    || [...style.children].some(child => !["families", "text-buffer", "text-mask", "background", "shadow", "dd_properties"].includes(child.tagName))) fail("font configuration");
  if (!alignment || numeric(element.getAttribute("valign") || 32) !== 32) fail("alignment");
  const margins = ["marginX", "marginY"].map(key => numeric(element.getAttribute(key) || 0));
  if (margins.some(value => ![0, 1].includes(value))) fail("margins");
  if (margins.some(value => value !== 1)) notices.push(`Positioned text “${element.getAttribute("id") || `Text ${index + 1}`}” uses a 1 mm inner margin; native text margins are not retained.`);
  if (active(element.getAttribute("frame")) || numeric(element.getAttribute("opacity") || 1) !== 1 || numeric(element.getAttribute("blendMode") || 0) !== 0) fail("border, opacity or blending");
  if ((style.getAttribute("fontSizeUnit") || "Point") !== "Point") fail("font size units");
  for (const key of ["forcedBold", "fontItalic", "forcedItalic", "fontUnderline", "fontStrikeout"]) if (active(style.getAttribute(key))) fail("font weight or style");
  if (style.hasAttribute("fontWeight") && numeric(style.getAttribute("fontWeight")) !== 50) fail("font weight");
  if (style.getAttribute("namedStyle") && !/^(?:Regular|Normal)$/i.test(style.getAttribute("namedStyle"))) fail("named font style");
  for (const key of ["fontLetterSpacing", "fontWordSpacing", "capitalization", "blendMode"]) if (numeric(style.getAttribute(key) || 0) !== 0) fail("font spacing, capitalization or blending");
  if (numeric(style.getAttribute("textOpacity") || 1) !== 1 || (style.getAttribute("textOrientation") || "horizontal") !== "horizontal") fail("font opacity or orientation");
  if ((style.getAttribute("multilineHeightUnit") || "Percentage") !== "Percentage" || numeric(style.getAttribute("fontKerning") || 1) !== 1) fail("line spacing units or font kerning");
  for (const [tag, key] of [["text-buffer", "bufferDraw"], ["text-mask", "maskEnabled"], ["background", "shapeDraw"], ["shadow", "shadowDraw"]]) {
    if (direct(style, tag).some(child => active(child.getAttribute(key)))) fail("buffer, mask, shape or shadow styling");
  }
  const family = style.getAttribute("fontFamily");
  if (family && family !== "Open Sans") notices.push(`Positioned text “${element.getAttribute("id") || `Text ${index + 1}`}” uses Open Sans; native font family “${family}” is not retained.`);
  if (!style.hasAttribute("multilineHeight") || numeric(style.getAttribute("multilineHeight")) !== 1.3)
    notices.push(`Positioned text “${element.getAttribute("id") || `Text ${index + 1}`}” uses OpenGeo line spacing; native multiline spacing is not retained.`);
  const background = element.getAttribute("background");
  if (background && !["true", "false", "1", "0"].includes(background)) fail("background configuration");
  let fill = "none";
  if (enabled(background)) {
    const colors = direct(element, "BackgroundColor");if (colors.length !== 1) fail("background color");
    fill = nativeColor(["red", "green", "blue", "alpha"].map(key => colors[0].getAttribute(key)).join(","));
  }
  return {id, type: "text", title: element.getAttribute("id") || `Text ${index + 1}`, text: element.getAttribute("labelText") ?? "", ...geometry(element),
    fontSizePt: numeric(style.getAttribute("fontSize")), color: nativeColor(style.getAttribute("textColor")), background: fill, alignment};
}
function nativeColor(value) {
  const parts = String(value).split(",");
  if (parts.length < 4 || parts.slice(0, 4).some(part => !/^\d+$/.test(part) || Number(part) > 255) || Number(parts[3]) !== 255)
    throw Error("QGIS positioned text requires opaque RGB text and background colors.");
  return `#${parts.slice(0, 3).map(part => Number(part).toString(16).padStart(2, "0")).join("")}`;
}
function rgba(hex) {return {red: parseInt(hex.slice(1, 3), 16), green: parseInt(hex.slice(3, 5), 16), blue: parseInt(hex.slice(5, 7), 16), alpha: 255};}
function measurement(value) {
  const parts = String(value).split(",");
  if (parts.length !== 3 || !["mm", "cm", "in", "pt", "px"].includes(parts[2])) throw Error("Use explicit mm, cm, in, pt or px native layout units.");
  const factor = {mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96}[parts[2]];
  return parts.slice(0, 2).map(number => numeric(number) * factor);
}
function numeric(value) {if (String(value).trim() === "" || !Number.isFinite(Number(value))) throw Error("Invalid numeric QGIS template field.");return Number(value);}
function area(element) {const [w, h] = measurement(element.getAttribute("size"));return w * h;}
function direct(element, tag) {return [...element.children].filter(child => child.tagName === tag);}
function identities(element) {return [...new Set([element.getAttribute("uuid"), element.getAttribute("templateUuid")].filter(Boolean))];}
function legendRectangle(page, main, occupied) {
  const gap = 3, minimumWidth = 50, heightMm = 40, left = page.marginMm, right = page.widthMm - page.marginMm, bottom = page.heightMm - page.marginMm;
  const preferredX = main.xMm + main.widthMm + gap;
  const xs = [preferredX, ...[...new Set([left, right - minimumWidth, ...occupied.flatMap(item => [item.xMm + item.widthMm + gap, item.xMm - gap - minimumWidth])])].sort((a, b) => a - b)];
  const ys = [main.yMm, ...[...new Set([left, bottom - heightMm, ...occupied.flatMap(item => [item.yMm + item.heightMm + gap, item.yMm - gap - heightMm])])].sort((a, b) => a - b)];
  for (const xMm of xs) for (const yMm of ys) {
    if (xMm < left || yMm < left || yMm + heightMm > bottom) continue;
    let availableRight = right;
    for (const item of occupied) {
      if (yMm >= item.yMm + item.heightMm + gap || yMm + heightMm + gap <= item.yMm || item.xMm + item.widthMm + gap <= xMm) continue;
      availableRight = Math.min(availableRight, item.xMm - gap);
    }
    const widthMm = Math.min(80, availableRight - xMm);
    if (widthMm >= minimumWidth) return {xMm, yMm, widthMm, heightMm};
  }
  throw Error("QGIS legend needs a free paper area at least 50 × 40 mm with 3 mm clearance. Move or resize map/data frames, choose larger paper, or turn off the legend before QGIS export.");
}
function property(element, key) {
  const containers = direct(element, "customproperties").concat(direct(element, "LayoutObject").flatMap(node => direct(node, "customproperties")));
  const matches = containers.flatMap(node => [...node.getElementsByTagName("Option")]).filter(option => option.getAttribute("name") === key);
  if (matches.length > 1) throw Error("Duplicate OpenGeo QGIS template properties are unsupported.");
  return matches[0]?.getAttribute("value");
}
function readSettings(text) {
  if (bytes(text) > 32768) throw Error("QGIS supplemental settings exceed 32 KiB.");
  let value;try {value = JSON.parse(text);} catch {throw Error("Invalid OpenGeo supplemental QGIS settings.");}
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["schemaVersion", "id", "page", "legendFormat", "dataFramesPresent", "textFramesPresent"].includes(key))
    || value.schemaVersion !== PROFILE || typeof value.id !== "string" || !value.page || Object.keys(value.page).sort().join() !== "marginMm,orientation,size"
    || ![...Object.keys(paper), "Custom"].includes(value.page.size) || !["portrait", "landscape"].includes(value.page.orientation)
    || typeof value.page.marginMm !== "number" || (Object.hasOwn(value, "legendFormat") && !["swatches", "classed-bars", "color-bars"].includes(value.legendFormat))
    || (Object.hasOwn(value, "dataFramesPresent") && value.dataFramesPresent !== true) || (Object.hasOwn(value, "textFramesPresent") && value.textFramesPresent !== true)) throw Error("Unsupported OpenGeo supplemental QGIS settings.");
  return value;
}
function paperName(w, h) {return Object.keys(paper).find(size => matchesPaper(size, w, h)) ?? "Custom";}
function matchesPaper(size, w, h) {const dimensions = paper[size];return Boolean(dimensions && Math.abs(Math.min(w, h) - dimensions[0]) < 0.1 && Math.abs(Math.max(w, h) - dimensions[1]) < 0.1);}
function enabled(value) {return value === "1" || value === "true";}
function literal(value) {if (typeof value !== "string" || /\[%|%\]|\u0000/.test(value)) throw Error("QGIS templates accept literal text only; expressions are unsupported.");}
function literalColumn(value) {
  literal(value);
  const quoted = /^"((?:[^"]|"")*)"$/.exec(value);
  if (quoted) return quoted[1].replaceAll('""', '"');
  if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(value)) return value;
  throw Error("QGIS table columns must be literal field names, not expressions.");
}
function escape(value) {return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");}
function attributes(value) {return Object.entries(value).map(([key, value]) => ` ${key}="${escape(value)}"`).join("");}
function layoutObject(role) {return `<LayoutObject><dataDefinedProperties><Option type="Map"><Option name="properties"/></Option></dataDefinedProperties><customproperties><Option type="Map"><Option name="${ROLE}" type="QString" value="${escape(role)}"/></Option></customproperties></LayoutObject>`;}
// The pinned QGIS 3.44.14 build uses Qt 5: Normal=50, Thin=0. Its XML
// reader treats omitted weight as 0, so positioned text declares its regular face.
function textStyle(fontSize, color = "#17212b", positioned = false) {const {red, green, blue} = rgba(color);return `<text-style fontFamily="${positioned ? "Open Sans" : "sans-serif"}" fontSize="${fontSize}" fontSizeUnit="Point" textColor="${red},${green},${blue},255" allowHtml="0"${positioned ? ' fontWeight="50" fontItalic="0" forcedBold="0" forcedItalic="0" fontUnderline="0" fontStrikeout="0" multilineHeight="1.3" multilineHeightUnit="Percentage"' : ""}/>`;}
function item(type, uuid, role, frame, extra = {}, content = "") {
  const position = `${frame.xMm},${frame.yMm},mm`;
  return `<LayoutItem${attributes({type, uuid, templateUuid: uuid, id: role, position, positionOnPage: position, size: `${frame.widthMm},${frame.heightMm},mm`,
    referencePoint: 0, itemRotation: 0, visibility: 1, excludeFromExports: 0, zValue: 1, frame: "false", background: "false", opacity: 1, ...extra})}>${layoutObject(role)}${content}</LayoutItem>`;
}

// Structural/security admission before DOMParser: no external/internal DTDs,
// executable expressions, asset paths, active atlas or unbounded XML trees.
function preflight(xml) {
  if (typeof xml !== "string" || bytes(xml) > 1_048_576 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(xml)) throw Error("QGIS template must be UTF-8 XML below 1 MiB without control characters.");
  let input = xml.replace(/^\uFEFF/, "").replace(/^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i, "");
  input = input.replace(/^\s*<!DOCTYPE\s+Layout\s*>/, "");
  if (/<!DOCTYPE|<!ENTITY|<\?|<!\[CDATA\[/i.test(input)) throw Error("External/internal DTDs, entities and processing instructions are unsupported in QGIS templates.");
  const stack = [], nodes = [];let position = 0, items = 0, roots = 0;
  while (position < input.length) {
    if (input.startsWith("<!--", position)) {const end = input.indexOf("-->", position + 4);if (end < 0) throw Error("Invalid QGIS XML comment.");position = end + 3;continue;}
    if (input[position] !== "<") {
      const end = input.indexOf("<", position), text = input.slice(position, end < 0 ? input.length : end), decoded = decode(text);
      if (/(?:https?:|file:|data:|javascript:)/i.test(decoded)) throw Error("QGIS external reference text is unsupported.");
      if (text.trim() && !/^(?:Layer|authid|wkt|proj4|description|srsid|srid|projectionacronym|ellipsoidacronym|geographicflag)$/.test(stack.at(-1)?.tag ?? "")) throw Error("Unsupported native QGIS element text.");
      position = end < 0 ? input.length : end;continue;
    }
    const match = /^<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)(\/?)>/.exec(input.slice(position));
    if (!match) throw Error("Malformed or unsupported QGIS XML markup.");position += match[0].length;
    const [, closing, tag, raw = "", self] = match;
    if (closing) {if (raw.trim() || self || stack.pop()?.tag !== tag) throw Error("Unbalanced QGIS XML elements.");continue;}
    const attrs = Object.create(null);let rest = raw;
    while (rest.trim()) {
      const attribute = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attribute || Object.hasOwn(attrs, attribute[1]) || Object.keys(attrs).length >= 128) throw Error("Invalid or excessive QGIS XML attributes.");
      attrs[attribute[1]] = decode(attribute[2] ?? attribute[3]);rest = rest.slice(attribute[0].length);
    }
    const node = {tag, attrs, children: []};if (stack.length) stack.at(-1).children.push(node);else if (++roots !== 1 || tag !== "Layout") throw Error("Choose one native QGIS 3 Layout document.");
    nodes.push(node);if (nodes.length > 4096 || stack.length >= 32 || (tag === "LayoutItem" && ++items > 32)) throw Error("QGIS XML exceeds the depth, element or 32-item limit.");
    checkNode(node);if (!self) stack.push(node);
  }
  if (stack.length || roots !== 1) throw Error("Incomplete QGIS XML document.");
  for (const node of nodes) {
    if (/^(?:dataDefinedProperties|data_defined_properties|dd_properties)$/.test(node.tag)) {
      const inspect = element => element.attrs.name === "properties" && (element.children.length || (element.attrs.value ?? "") !== "") || element.children.some(inspect);
      if (node.children.some(inspect)) throw Error("Active QGIS data-defined properties and expressions are unsupported.");
    }
  }
}
function checkNode({tag, attrs}) {
  if (/^(?:script|html|svg|image|iframe|object|embed|foreignObject|LayoutHtml|ComposerHtml|projectlayers|datasource)$/i.test(tag)) throw Error("Scripts, HTML, assets and embedded data sources are unsupported in QGIS templates.");
  if (tag === "LayoutItem" && !Object.values(TYPES).filter(type => type !== TYPES.table).includes(attrs.type)) throw Error("Unsupported native QGIS item (including chart, picture, shape or HTML content). Use JSON for OpenGeo chart slots.");
  if (tag === "LayoutItem" && (attrs.visibility === "0" || attrs.visibility === "false" || attrs.excludeFromExports === "1" || attrs.excludeFromExports === "true")) throw Error("Hidden or excluded native items are unsupported by QGIS template exchange.");
  if (tag === "LayoutMultiFrame" && attrs.type !== TYPES.table) throw Error("Only native attribute-table multi-frames are supported.");
  if (tag === "column" && Object.hasOwn(attrs, "attribute")) literalColumn(attrs.attribute);
  if (/atlas/i.test(tag) && (enabled(attrs.enabled) || enabled(attrs.atlasDriven) || attrs.coverageLayer)) throw Error("Active QGIS atlas content is unsupported.");
  for (const [key, value] of Object.entries(attrs)) {
    if (/^(?:htmlState|allowHtml)$/i.test(key) && value !== "0" && value !== "false") throw Error("HTML labels are unsupported in QGIS templates.");
    if (tag !== "Atlas" && !(tag === "Option" && attrs.name === SETTINGS && key === "value") && /\[%|%\]/.test(value)) throw Error("QGIS text expressions are unsupported.");
    if (/^(?:href|src|url|path|file|filename|svgFile|picturePath|shapeSVGFile|sourceUrl|sourceUri)$/i.test(key) && value) throw Error("QGIS external assets and source URLs are unsupported.");
    if (/^(?:source|datasource)$/i.test(key) && value && !(tag === "LayoutMultiFrame" && value === "0")) throw Error("QGIS embedded sources are unsupported.");
    if (/(?:expression|featureFilter)$/i.test(key) && value && tag !== "Atlas") throw Error("QGIS expressions and feature filters are unsupported.");
    if (tag === "Option" && /^(?:expression|url|path|file|svgFile|picturePath|source|datasource)$/i.test(attrs.name ?? "") && value && key === "value") throw Error("QGIS executable or asset properties are unsupported.");
    if (key !== "labelText" && key !== "name" && key !== "id" && key !== "value" && /(?:https?:|file:|data:|javascript:|\\\\)/i.test(value)) throw Error("QGIS external references are unsupported.");
  }
}
function decode(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(value)) throw Error("Custom XML entities are unsupported in QGIS templates.");
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const names = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'"};if (names[entity]) return names[entity];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (code < 32 && ![9, 10, 13].includes(code) || code >= 0x7f && code <= 0x9f || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw Error("Invalid XML character reference.");
    return String.fromCodePoint(code);
  });
}
