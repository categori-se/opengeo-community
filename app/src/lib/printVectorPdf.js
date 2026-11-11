import {canonicalJson} from "./artifactCanonicalJson.js";
import {mapFontSha256, PINNED_MAP_FONT, PINNED_MAP_FONT_STACK} from "./mapFonts.js";
import {registerPrintPdfMaps} from "./printGeoPdf.js";
import {reflowPrintPdfTextFrames} from "./printTextSvg.js";
import {hasPrintMath, preparePrintMath, printMathLegalFiles} from "./printMathSvg.js";
import {PRINT_FONT_FACES, usedPrintFontFaces, printFontFaceAttributes, validatePrintFontFaceAssets} from "./printFontFaces.js";
import {printDocumentLanguage, printPdfUnicode} from "./printAccessibility.js";

const NS = "http://www.w3.org/2000/svg";
const FONT_SHA256 = "8ab4aa561e7db0eb3e1af8b0bed2a315e0a33fe2ed3070e645d1b89f8efc1d5c";
const NOTICE_SHA256 = "50abb8dfaa45dfa4c9167dff20766e459ced61c64ee8f97fcdedafc53e6b6f4a";
const LIMITS = {svgBytes: 16 * 1024 * 1024, pdfBytes: 32 * 1024 * 1024, nodes: 65000, text: 131072, groups: 256, fragmentNodes: 1024 * 1024};
const TAGS = new Set(["svg", "g", "defs", "clipPath", "linearGradient", "stop", "rect", "circle", "path", "polyline", "line", "text", "title", "metadata"]);
const ATTRIBUTES = new Set(["xmlns", "id", "width", "height", "viewBox", "role", "x", "y", "cx", "cy", "r", "x1", "y1", "x2", "y2", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "clip-path", "font-size", "font-family", "font-style", "font-weight", "text-anchor", "paint-order", "color-interpolation", "offset", "stop-color", "stop-opacity", "style", "xml:space", "lang", "xml:lang"]);
const PAINT = new Set(["fill", "stroke", "stop-color"]);
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
let fontSequence = 0;

function fail(message) {throw Error(`${message} Choose Vector Print / Save PDF for the existing browser output.`);}
function bytes(value, maximum, label) {
  const result = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (!result || !result.byteLength || result.byteLength > maximum) fail(`The ${label} bytes are unavailable or exceed their limit.`);
  return result;
}
function binaryString(value) {
  let result = "";for (let offset = 0; offset < value.length; offset += 32768) result += String.fromCharCode(...value.subarray(offset, offset + 32768));
  return result;
}

export async function validatePrintVectorPdfAttribution(fontLicenseBytes, fontNoticeBytes, manifest) {
  const license = bytes(fontLicenseBytes, 32768, "Print font license"), notice = bytes(fontNoticeBytes, 32768, "Print font notice");
  if (await mapFontSha256(license) !== manifest.licenseSha256 || await mapFontSha256(notice) !== NOTICE_SHA256)
    fail("The packaged Print font license or notice failed its checksum check.");
  return [{name: "OpenSans-LICENSE.txt", bytes: license.slice()}, {name: "OpenSans-NOTICE.txt", bytes: notice.slice()}];
}

export function registerPrintPdfFontAttribution(pdf, files) {
  const names = ["OpenSans-LICENSE.txt", "OpenSans-NOTICE.txt",
    ...(files?.[2]?.name === "OpenSans-FACES-NOTICE.txt" ? ["OpenSans-FACES-NOTICE.txt"] : []),
    "MathJax-LICENSE.txt", "MathJax-NOTICE.txt", "MathJax-TeX-FONT-NOTICE.txt", "SIL-OFL-1.1.txt"];
  if (!Array.isArray(files) || ![2, 3, 6, 7].includes(files.length) || files.length === 3 && names.length !== 7
    || files.length === 6 && names.length !== 6 || files.length === 7 && names.length !== 7 || files.some((file, index) => file?.name !== names[index]
    || !(file.bytes instanceof Uint8Array) || !file.bytes.length || file.bytes.length > 32768)) fail("The PDF font attribution attachments are invalid.");
  files = files.map(file => ({name: file.name, bytes: file.bytes.slice()})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let tree;
  pdf.internal.events.subscribe("putAdditionalObjects", () => {
    const entries = [];
    for (const file of files) {
      const embedded = pdf.internal.newAdditionalObject(), specification = pdf.internal.newAdditionalObject();
      embedded.content = `<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length ${file.bytes.length} >>\nstream\n${binaryString(file.bytes)}\nendstream`;
      specification.content = `<< /Type /Filespec /F (${file.name}) /UF (${file.name}) /EF << /F ${embedded.objId} 0 R /UF ${embedded.objId} 0 R >> >>`;
      entries.push(`(${file.name}) ${specification.objId} 0 R`);
    }
    tree = pdf.internal.newAdditionalObject();tree.content = `<< /Names [${entries.join(" ")}] >>`;
  });
  pdf.internal.events.subscribe("putCatalog", () => {pdf.internal.write(`/Names << /EmbeddedFiles ${tree.objId} 0 R >>`);});
}

// The manifest remains raw bytes: parsing and reserializing it would lose its seal.
export async function validatePrintVectorPdfFont(fontBytes, fontManifest, text) {
  const font = bytes(fontBytes, 1024 * 1024, "Print font"), manifestBytes = bytes(fontManifest, 128000, "Print font manifest");
  if (await mapFontSha256(manifestBytes) !== PINNED_MAP_FONT.manifestChecksumSha256 || await mapFontSha256(font) !== FONT_SHA256)
    fail("The packaged Print font or manifest failed its checksum check.");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.schema !== "opengeo.glyph-manifest.1.0.0" || manifest.id !== PINNED_MAP_FONT.id || manifest.version !== PINNED_MAP_FONT.version
    || manifest.fontStack !== PINNED_MAP_FONT_STACK || manifest.fontSha256 !== FONT_SHA256 || !Array.isArray(manifest.codepoints)) fail("The packaged Print font manifest is invalid.");
  if (typeof text !== "string" || text.length > LIMITS.text) fail("The page text exceeds the direct PDF limit.");
  const coverage = new Set(manifest.codepoints);
  for (const character of text) if (!coverage.has(character.codePointAt(0)))
    fail(`The embedded Print font does not cover U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}.`);
  return {font, manifest};
}

function normalizeColor(node, attribute, value) {
  if (value === "none" || value === "white" || value === "black" || /^#[a-f0-9]{6}$/i.test(value)) return;
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (rgb) {
    const channels = rgb.slice(1).map(Number);
    if (!channels.every(value => Number.isFinite(value) && value >= 0 && value <= 255)) fail("A Print color is invalid.");
    // svg2pdf 2.8.1 accepts CSS3 integer RGB, not the compositor's CSS4 RGB syntax.
    node.setAttribute(attribute, `rgb(${channels.map(Math.round).join(",")})`);return;
  }
  if (/^#[a-f0-9]{8}$/i.test(value)) {
    const alpha = parseInt(value.slice(7), 16) / 255;
    if (attribute === "stop-color" && alpha !== 1) fail("Transparent gradient stops need browser Print to preserve their changing alpha.");
    node.setAttribute(attribute, value.slice(0, 7));
    if (alpha !== 1) {
      const opacity = `${attribute}-opacity`;
      node.setAttribute(opacity, String(alpha * Number(node.getAttribute(opacity) ?? 1)));
    }
    return;
  }
  fail("This Print color needs the browser's color renderer.");
}

// A non-Regular face belongs only to a flat owned literal frame, never a map
// label, inherited group style, or a caller-created SVG text fragment.
function ownedLiteralTextFrame(node, layout, root) {
  if (node.localName !== "text") return null;
  const group = node.parentElement;
  if (!group?.hasAttribute("data-print-text-frame") || group.parentElement !== root) return null;
  const matches = (layout.textFrames ?? []).filter(frame => frame.type === "text" && frame.id === group.getAttribute("data-print-text-frame"));
  if (matches.length !== 1) return null;
  const frame = matches[0], lines = [...group.querySelectorAll("text")];
  if (!lines.length || lines.some((line, index) => line.parentElement !== group || line.getAttribute("data-print-text-line") !== String(index))
    || lines.map(line => line.textContent).join("") !== frame.text.replaceAll("\n", "")) return null;
  return frame;
}

// Admit only the closed page emitted by printPageSvg. This is deliberately not an
// arbitrary SVG import surface; URLs, images, CSS, scripts and embedded HTML refuse.
export function preparePrintVectorPdfSvg(svg, layout, family = "OpenGeoPrintSans") {
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(family)) fail("The embedded Print font name is invalid.");
  const page = layout?.page;
  if (!page || ![page.widthMm, page.heightMm].every(value => Number.isFinite(value) && value >= 50 && value <= 1189)
    || !Array.isArray(layout.frames) || layout.frames.length < 1 || layout.frames.length > 2) fail("Choose a bounded captured Print layout.");
  if (svg?.namespaceURI !== NS || svg.localName !== "svg" || !svg.ownerDocument?.defaultView?.XMLSerializer) fail("Compose the vector Print page before downloading PDF.");
  const serialized = new svg.ownerDocument.defaultView.XMLSerializer().serializeToString(svg);
  if (new TextEncoder().encode(serialized).length > LIMITS.svgBytes) fail("The vector Print page exceeds 16 MiB.");
  const copy = svg.cloneNode(true), nodes = [copy, ...copy.querySelectorAll("*")], ids = new Map(), references = [];
  if (nodes.length > LIMITS.nodes) fail("The vector Print page has too many elements.");
  const metadata = [...copy.children].filter(node => node.localName === "metadata");
  let record;
  try {record = metadata.length === 1 ? JSON.parse(metadata[0].textContent) : null;} catch {fail("The composed vector Print metadata is invalid.");}
  if (record?.mapRepresentation !== "vector" || canonicalJson(record.layout) !== canonicalJson(layout)
    || copy.getAttribute("viewBox") !== `0 0 ${page.widthMm} ${page.heightMm}`
    || copy.getAttribute("width") !== `${page.widthMm}mm` || copy.getAttribute("height") !== `${page.heightMm}mm`
    || copy.querySelectorAll("[data-print-vector-map]").length !== layout.frames.length) fail("The vector Print page does not match this layout.");
  usedPrintFontFaces(layout);
  const artifactText = new WeakSet();
  const titles = [...copy.querySelectorAll("[data-print-page-title]")];
  if (titles.length > 1 || titles.some(node => node.localName !== "text" || node.parentElement !== copy
    || node.getAttribute("data-print-page-title") !== "true" || node.textContent !== layout.title)) fail("The owned Print page title does not match its layout.");
  let text = "", groups = 0;
  const faceText = {};
  for (const node of nodes) {
    if (node.namespaceURI !== NS || !TAGS.has(node.localName) || node !== copy && node.localName === "svg") fail(`Unsupported ${node.localName} content in direct vector PDF.`);
    if (["metadata", "title", "text"].includes(node.localName) && node.children.length) fail("The composed page contains unsupported nested text or metadata.");
    for (const attribute of [...node.attributes]) {
      const {name, value} = attribute;
      if (!ATTRIBUTES.has(name) && !/^data-[a-z0-9-]+$/.test(name) && !/^aria-[a-z0-9-]+$/.test(name)) fail(`Unsupported ${name} attribute in direct vector PDF.`);
      if (name === "xmlns" && (node !== copy || value !== NS)) fail("The composed page has an unsupported namespace.");
      if (["lang", "xml:lang"].includes(name) && (node !== copy || value !== printDocumentLanguage(layout))) fail("The composed page language does not match its layout.");
      if (name === "xml:space" && (node.localName !== "text" || value !== "preserve")) fail("Only literal text may preserve whitespace in direct vector PDF.");
      if (name === "id") {if (!ID.test(value) || ids.has(value)) fail("The composed page has an invalid or duplicate definition.");ids.set(value, node);}
      if (name === "style") {
        // Browsers enumerate shorthand background properties differently. Compare
        // their canonical serialization with the same owned style in this DOM.
        const expected = svg.ownerDocument.createElementNS(NS, "svg");
        expected.style.cssText = "background:white;color:#17212b;max-width:none";
        const literal = ownedLiteralTextFrame(node, layout, copy);
        const synthesisOnly = literal && /^font-synthesis:\s*none;?$/.test(node.getAttribute("style") ?? "");
        if (!synthesisOnly && (node !== copy || node.style.cssText !== expected.style.cssText)) fail("External or custom CSS is unsupported in direct vector PDF.");
        node.removeAttribute("style");
      }
      if (name === "clip-path" || PAINT.has(name) && value.startsWith("url(")) {
        const match = /^url\(#([A-Za-z][A-Za-z0-9_.-]{0,127})\)$/.exec(value);
        if (!match) fail("Only local Print gradient and clip references are supported.");
        references.push({id: match[1], type: name === "clip-path" ? "clipPath" : "linearGradient"});
      } else if (PAINT.has(name)) normalizeColor(node, name, value);
      else if (!name.startsWith("data-") && !name.startsWith("aria-") && /(?:url\s*\(|https?:|javascript:|data:|@import|[<>])/i.test(value) && name !== "xmlns") fail("External content is unsupported in direct vector PDF.");
      if (["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(name)
        && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) fail("The composed page has an invalid opacity.");
      if (name === "stop-opacity" && Number(value) !== 1) fail("Transparent gradient stops need browser Print to preserve their changing alpha.");
      if (name === "paint-order" && (node.localName !== "text" || value !== "stroke fill")) fail("This paint order needs browser Print.");
      if (["font-style", "font-weight"].includes(name)) {
        const literal = ownedLiteralTextFrame(node, layout, copy), face = literal?.fontFace ?? "regular";
        if (face === "regular") {
          if (value !== "normal" && value !== "400") fail("This font style needs browser Print.");
        } else {
          const wanted = printFontFaceAttributes(face)[name];
          if (value !== wanted && !(name === "font-weight" && wanted === "700" && value === "bold")) fail("The Print text face does not match its literal frame.");
        }
      }
    }
    if (node.localName === "g" && Number(node.getAttribute("opacity") ?? 1) !== 1) {
      const mapPass = node.hasAttribute("data-print-vector-pass") && node.parentElement?.hasAttribute("data-print-vector-map");
      const pointLegend = node.hasAttribute("data-print-point-legend") && node.parentElement === copy;
      if ((!mapPass && !pointLegend)
        || [...node.children].some(child => !["path", "rect", "circle"].includes(child.localName)
          || ["fill", "stroke"].some(name => child.getAttribute(name)?.startsWith("url("))) || ++groups > LIMITS.groups)
        fail("Only bounded vector-pass and point-legend composite opacity is supported.");
    }
    if (node.localName === "text") {
      text += node.textContent;
      const literal = ownedLiteralTextFrame(node, layout, copy), face = literal?.fontFace ?? "regular";
      faceText[face] = (faceText[face] ?? "") + node.textContent;
      if (face === "regular") {
        node.setAttribute("font-family", family);node.setAttribute("font-style", "normal");node.setAttribute("font-weight", "normal");
      } else {
        for (const [name, value] of Object.entries(printFontFaceAttributes(face, {family}))) node.setAttribute(name, value);
      }
      if (node.hasAttribute("paint-order")) {
        // svg2pdf always fills before stroking. Separate identical text runs keep
        // the accepted white halo behind, rather than over, the dark glyph.
        const halo = node.cloneNode(true);halo.removeAttribute("paint-order");halo.removeAttribute("data-print-page-title");halo.setAttribute("fill", "none");
        artifactText.add(halo);
        node.removeAttribute("paint-order");node.setAttribute("stroke", "none");node.before(halo);
      }
    }
  }
  for (const reference of references) if (ids.get(reference.id)?.localName !== reference.type) fail("A Print clip or gradient definition is missing.");
  if (text.length > LIMITS.text) fail("The composed page text exceeds the direct PDF limit.");
  copy.setAttribute("font-family", family);
  return {svg: copy, text, faceText, compositeGroups: groups, sourceMetadata: record, artifactText};
}

// Reflow creates fresh literal line nodes. Bind semantics to their final owned
// identities, never to coincident coordinates, duplicate strings or caller tags.
export function printPdfTextSemantics(svg, layout, artifactText = new WeakSet()) {
  const semantics = new WeakMap();
  const maps = [...svg.querySelectorAll("[data-print-vector-map]")];
  if (maps.length !== layout.frames.length) fail("The vector map alternatives do not match this layout.");
  maps.forEach((node, index) => {
    const description = layout.frames[index].description;
    if (description?.trim()) semantics.set(node, {role: "Figure", alt: description, group: `map:${layout.frames[index].id}`});
  });
  for (const node of svg.querySelectorAll("text")) {
    if (node.closest("defs,clipPath,metadata,title") || !node.textContent.trim()) continue;
    if (artifactText.has(node)) {semantics.set(node, {role: "Artifact", text: node.textContent});continue;}
    const frame = ownedLiteralTextFrame(node, layout, svg);
    if (node.hasAttribute("data-print-page-title")) {
      if (node.parentElement !== svg || node.getAttribute("data-print-page-title") !== "true"
        || node.textContent !== layout.title) fail("The owned Print page title does not match its layout.");
      semantics.set(node, {role: "H1", group: "page-title", text: node.textContent});
    } else semantics.set(node, {role: frame ? "P" : "Span", ...(frame ? {group: `frame:${frame.id}`} : {}), text: node.textContent});
  }
  return semantics;
}

// Partition in paint order, preserving each leaf's ancestor transforms/clips.
// A page background is a leaf in the first fragment, never an implicit backdrop.
export function printVectorPdfFragments(svg, semantics) {
  const definitions = [...svg.querySelectorAll("defs")].map(node => node.cloneNode(true));
  const definitionNodes = definitions.reduce((sum, node) => sum + 1 + node.querySelectorAll("*").length, 0);
  const fragments = [];let active = null, copiedNodes = 0;
  const budget = count => {
    copiedNodes += count;
    if (semantics && copiedNodes > LIMITS.fragmentNodes) fail("The tagged Print fragments exceed their bounded conversion work.");
  };
  function fragment(opacity = 1, figure) {
    budget(definitionNodes + 1);
    const root = svg.cloneNode(false);root.append(...definitions.map(node => node.cloneNode(true)));
    const result = {svg: root, opacity, ...(figure ? {figure} : {}), parents: new Map([[svg, root]])};fragments.push(result);return result;
  }
  function append(part, node, ancestors) {
    let parent = part.svg;
    for (const ancestor of ancestors) {
      if (!part.parents.has(ancestor)) {budget(1);const copy = ancestor.cloneNode(false);parent.append(copy);part.parents.set(ancestor, copy);}
      parent = part.parents.get(ancestor);
    }
    parent.append(node);
  }
  function visit(node, ancestors, figure) {
    if (["defs", "metadata", "title"].includes(node.localName)) return;
    const owned = semantics?.get(node);
    if (owned?.role === "Figure") {active = null;figure = owned;}
    if (node.localName !== "g" || Number(node.getAttribute("opacity") ?? 1) !== 1) budget(1 + node.querySelectorAll("*").length);
    if (node.localName === "g" && Number(node.getAttribute("opacity") ?? 1) !== 1) {
      if (semantics && node.querySelector("text")) fail("Composite Print passes must remain text-free.");
      active = null;
      const isolated = fragment(Number(node.getAttribute("opacity")), figure), copy = node.cloneNode(true);copy.setAttribute("opacity", "1");
      append(isolated, copy, ancestors);return;
    }
    if (node.localName === "g") {
      for (const child of node.children) visit(child, [...ancestors, node], figure);
      if (owned?.role === "Figure") active = null;
      return;
    }
    if (semantics && node.localName === "text") {
      active = null;
      const part = fragment();part.semantic = semantics.get(node) ?? {role: "Artifact", text: node.textContent};
      append(part, node.cloneNode(true), ancestors);return;
    }
    if (active?.figure !== figure) active = null;
    active ??= fragment(1, figure);append(active, node.cloneNode(true), ancestors);
  }
  for (const child of svg.children) visit(child, []);
  return fragments.map(({svg, opacity, semantic, figure}) => ({svg, opacity, ...(semantic ? {semantic} : {}), ...(figure ? {figure} : {})}));
}

// jsPDF 4.2.1's ordinary forms have no /Group. Wrap their converter-produced
// streams in isolated transparency groups; all geometry is still svg2pdf output.
export function printPdfCompositeForms(pdf) {
  const forms = [], states = new Map();
  pdf.internal.events.subscribe("addGState", state => {states.set(state.id, state);});
  pdf.internal.events.subscribe("putResources", () => {
    if (!forms.length) return;
    // Composite passes contain only solid geometry. Give the outer group an
    // explicit dictionary for its inner form and all converter graphics states.
    // No font, image or pattern resources occur inside this admitted pass type.
    const resources = pdf.internal.newObject();
    pdf.internal.write(`<< /ExtGState << ${[...states.values()].map(state => `/${state.id} ${state.objectNumber} 0 R`).join(" ")} >> /XObject << ${forms.map(form => `/${form.inner.id} ${form.inner.objectNumber} 0 R`).join(" ")} >> >>`, "endobj");
    for (const form of forms) {
      form.objectId = pdf.internal.newObject();
      pdf.internal.putStream({data: `/${form.inner.id} Do\n`, objectId: form.objectId, additionalKeyValues: [
        {key: "Type", value: "/XObject"}, {key: "Subtype", value: "/Form"},
        {key: "BBox", value: `[0 0 ${form.width} ${form.height}]`},
        {key: "Resources", value: `${resources} 0 R`},
        {key: "Group", value: "<< /S /Transparency /CS /DeviceRGB /I true /K false >>"}
      ]});
      pdf.internal.write("endobj");
    }
  });
  pdf.internal.events.subscribe("putXobjectDict", () => {for (const form of forms) pdf.internal.write(`/${form.name} ${form.objectId} 0 R`);});
  return async (svg, opacity, convert, dimensions) => {
    const width = dimensions.width * pdf.internal.scaleFactor, height = dimensions.height * pdf.internal.scaleFactor;
    pdf.beginFormObject(0, 0, width, height, pdf.unitMatrix);
    await convert(svg, pdf, {width: dimensions.width, height: dimensions.height, loadExternalStyleSheets: false, loadImages: false});
    let inner;
    pdf.internal.events.subscribe("addFormObject", value => {inner = value;}, true);
    pdf.endFormObject(`opengeo-print-pass-${forms.length}`);
    if (!inner?.id || !/^Xo\d+$/.test(inner.id)) fail("The PDF converter's composite form contract changed.");
    const form = {name: `OpenGeoPrintComposite${forms.length}`, inner, width, height};forms.push(form);
    pdf.saveGraphicsState();pdf.setGState(new pdf.GState({opacity, "stroke-opacity": opacity}));
    pdf.internal.write(`/${form.name} Do`);pdf.restoreGraphicsState();
  };
}

// jsPDF escapes XML itself. Pre-escaping would change literal source ampersands.
export function registerPrintPdfMetadata(pdf, record) {
  pdf.addMetadata(JSON.stringify(record), "https://opengeo.tools/ns/print/1.0/");
}

// Content IDs are recorded while real text is painted. Object IDs belong to one
// serialization only: jsPDF rebuilds them on every output(), including repeats.
export function registerPrintPdfTextStructure(pdf) {
  const internal = pdf?.internal;
  if (!internal?.events?.subscribe || typeof internal.newAdditionalObject !== "function"
    || typeof internal.write !== "function" || pdf.getNumberOfPages?.() !== 1) fail("The PDF writer cannot tag this single-page layout.");
  const nodes = [], owners = [], groups = new Map();
  let active = null, state = null, serializationError = null;
  const listen = (name, callback) => internal.events.subscribe(name, (...args) => {
    try {callback(...args);} catch (error) {serializationError ??= error;}
  });
  listen("buildDocument", () => {state = {pageId: null, root: null, complete: false};serializationError = null;});
  listen("putPage", event => {
    if (!state || event.pageNumber !== 1 || !Number.isSafeInteger(event.objId) || pdf.getNumberOfPages() !== 1)
      fail("The tagged PDF page contract changed.");
    state.pageId = event.objId;internal.write("/StructParents 0", "/Tabs /S");
  });
  listen("putAdditionalObjects", () => {
    if (!state?.pageId || active !== null) fail("The tagged PDF content is incomplete.");
    const root = internal.newAdditionalObject(), document = internal.newAdditionalObject(), tree = internal.newAdditionalObject();
    const references = new Map(nodes.map(node => [node, internal.newAdditionalObject()]));
    for (const node of nodes) references.get(node).content = `<< /Type /StructElem /S /${node.role} /P ${document.objId} 0 R /Pg ${state.pageId} 0 R /K [${node.mcids.join(" ")}]${node.alt ? ` /Alt ${printPdfUnicode(node.alt)}` : ""} >>`;
    tree.content = `<< /Nums [0 [${owners.map(node => `${references.get(node).objId} 0 R`).join(" ")}]] >>`;
    document.content = `<< /Type /StructElem /S /Document /P ${root.objId} 0 R /K [${nodes.map(node => `${references.get(node).objId} 0 R`).join(" ")}] >>`;
    root.content = `<< /Type /StructTreeRoot /K [${document.objId} 0 R] /ParentTree ${tree.objId} 0 R /ParentTreeNextKey 1 >>`;
    state.root = root.objId;
  });
  listen("putCatalog", () => {
    if (!state?.root || serializationError) fail("The PDF structure could not be serialized.");
    internal.write(`/StructTreeRoot ${state.root} 0 R`, "/MarkInfo << /Marked true >>");state.complete = true;
  });
  return {
    begin({role, text, group, alt} = {}) {
      if (active !== null || !["H1", "P", "Span", "Figure", "Artifact"].includes(role)) fail("The PDF text role is invalid or nested.");
      if (role === "Artifact") {internal.write("/Artifact BMC");active = role;return;}
      if ((role === "Figure" ? typeof alt !== "string" || !alt.trim() || alt.length > 4000 : typeof text !== "string" || !text.trim() || text.length > LIMITS.text) || owners.length >= LIMITS.nodes
        || group !== undefined && (typeof group !== "string" || !group.length || group.length > 256)) fail("The PDF text run is invalid.");
      let node = group === undefined ? null : groups.get(group);
      if (node && (node.role !== role || node.alt !== alt)) fail("The PDF text group changed its role or alternative.");
      if (!node) {node = {role, mcids: [], ...(role === "Figure" ? {alt} : {})};nodes.push(node);if (group !== undefined) groups.set(group, node);}
      const mcid = owners.length;owners.push(node);node.mcids.push(mcid);
      internal.write(`/${role} << /MCID ${mcid}${role === "Figure" ? "" : ` /ActualText ${printPdfUnicode(text)}`} >> BDC`);active = role;
    },
    end() {
      if (active === null) fail("The PDF text run is not open.");
      internal.write("EMC");active = null;
    },
    assertComplete() {
      if (active !== null || serializationError || !state?.complete) fail("The PDF text structure is incomplete.");
    }
  };
}

export async function compilePrintVectorPdf({svg, layout, fontBytes, fontManifest, manifestBytes, fontLicenseBytes, fontNoticeBytes, fontFaceBytes, fontFacesNoticeBytes, registrations = [], signal, onPhase} = {}) {
  const start = performance.now(), family = `OpenGeoPrintSans${++fontSequence}`;
  const check = () => {if (signal?.aborted) throw Error("Print PDF preparation was cancelled.");if (performance.now() - start > 60000) fail("Print PDF preparation exceeded its 60 second cooperative limit.");};
  // Limits and cancellation are checked between converter calls. Main-thread SVG
  // conversion cannot be interrupted synchronously; this is not worker isolation.
  check();onPhase?.("Checking vector page and embedded font…");
  if (hasPrintMath(layout)) {await preparePrintMath();check();}
  const prepared = preparePrintVectorPdfSvg(svg, layout, family);
  const faceNames = usedPrintFontFaces(layout), styled = faceNames.length > 1;
  const {font, manifest} = await validatePrintVectorPdfFont(fontBytes, manifestBytes ?? fontManifest, styled ? prepared.faceText.regular ?? "" : prepared.text);check();
  const faceAssets = styled ? await validatePrintFontFaceAssets(layout, {
    faceBytes: {regular: font, ...fontFaceBytes}, noticeBytes: fontFacesNoticeBytes}) : null;check();
  if (manifestBytes && fontManifest && !(fontManifest instanceof Uint8Array) && !(fontManifest instanceof ArrayBuffer)
    && canonicalJson(fontManifest) !== canonicalJson(manifest)) fail("The loaded Print font manifest changed.");
  const attribution = await validatePrintVectorPdfAttribution(fontLicenseBytes, fontNoticeBytes, manifest);check();
  if (faceAssets) attribution.push({name: "OpenSans-FACES-NOTICE.txt", bytes: faceAssets.noticeBytes});
  for (const file of printMathLegalFiles(layout)) {
    const value = new TextEncoder().encode(file.body);if (!value.length || value.length > 32768 || await mapFontSha256(value) !== file.sha256) fail("The packaged equation license or notice failed its checksum check.");
    attribution.push({name: file.name, bytes: value});
  }
  const view = svg.ownerDocument.defaultView, fonts = svg.ownerDocument.fonts;
  if (typeof view.FontFace !== "function" || !fonts?.add || !fonts?.delete) fail("This browser cannot load the exact embedded Print font.");
  const installedFaces = [];
  try {
    for (const name of faceNames) {
      const record = PRINT_FONT_FACES[name], source = faceAssets?.faces[name] ?? font;
      const face = new view.FontFace(family, source.slice().buffer, {style: record.style, weight: record.weight});
      await face.load();check();fonts.add(face);installedFaces.push(face);
    }
    if (layout.textFrames?.length) reflowPrintPdfTextFrames(prepared.svg, layout, family);
    onPhase?.("Preparing PDF support…");
    const [{jsPDF}, {svg2pdf}] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);check();
    if (jsPDF.version !== "4.2.1") fail("The PDF converter version changed and needs review.");
    const width = layout.page.widthMm, height = layout.page.heightMm;
    const pdf = new jsPDF({orientation: width >= height ? "landscape" : "portrait", unit: "mm", format: [width, height], putOnlyUsedFonts: true, compress: true, floatPrecision: 12});
    pdf.__private__.setPdfVersion("1.7");
    pdf.addFileToVFS("OpenGeoPrintSans.ttf", binaryString(font));pdf.addFont("OpenGeoPrintSans.ttf", family, "normal");pdf.setFont(family, "normal");
    for (const name of faceNames) {
      const record = PRINT_FONT_FACES[name];
      if (name !== "regular") {
        pdf.addFileToVFS(record.file, binaryString(faceAssets.faces[name]));
        pdf.addFont(record.file, family, record.pdfStyle);
      }
      pdf.setFont(family, record.pdfStyle);
      const embedded = pdf.getFont();
      if (embedded.fontName !== family || embedded.fontStyle !== record.pdfStyle || typeof embedded.metadata?.characterToGlyph !== "function") fail("The Print font face could not be embedded.");
      for (const character of prepared.faceText[name] ?? "") if (!embedded.metadata.characterToGlyph(character.codePointAt(0))) fail(`A Print glyph is unavailable in the embedded ${name} font.`);
    }
    pdf.setFont(family, "normal");
    pdf.setProperties({title: layout.title, creator: "OpenGeo.Tools", subject: "Vector Print with embedded Open Sans"});
    pdf.setLanguage(printDocumentLanguage(layout));pdf.viewerPreferences({DisplayDocTitle: true});
    registerPrintPdfMetadata(pdf, {schemaVersion: "opengeo.vector-print-pdf.1", ...prepared.sourceMetadata,
      geographicRegistration: registrations.length > 0, font: {id: manifest.id, checksumSha256: FONT_SHA256, license: manifest.license}});
    const semantics = printPdfTextSemantics(prepared.svg, layout, prepared.artifactText);
    const fragments = printVectorPdfFragments(prepared.svg, semantics), composeGroup = printPdfCompositeForms(pdf);
    const structure = registerPrintPdfTextStructure(pdf);
    for (const [index, part] of fragments.entries()) {
      check();onPhase?.(`Converting vector page section ${index + 1} of ${fragments.length}…`);
      const originalText = pdf.text;
      pdf.text = function(value, ...args) {
        if (typeof value !== "string") fail("The PDF converter's literal text contract changed.");
        if (!value.trim()) return originalText.call(this, value, ...args);
        if (!part.semantic || part.opacity !== 1) fail("The PDF converter painted text outside its owned page run.");
        structure.begin({...part.semantic, text: value});
        try {return originalText.call(this, value, ...args);} finally {structure.end();}
      };
      if (part.figure) structure.begin(part.figure);
      try {
        if (part.opacity === 1) await svg2pdf(part.svg, pdf, {width, height, loadExternalStyleSheets: false, loadImages: false});
        else await composeGroup(part.svg, part.opacity, svg2pdf, {width, height});
      } finally {if (part.figure) structure.end();pdf.text = originalText;}
      check();
    }
    registerPrintPdfMaps(pdf, registrations);
    registerPrintPdfFontAttribution(pdf, attribution);
    onPhase?.("Packaging vector PDF…");check();
    const output = pdf.output("arraybuffer");structure.assertComplete();check();
    if (!(output instanceof ArrayBuffer) || output.byteLength < 100 || output.byteLength > LIMITS.pdfBytes) fail("The vector PDF is empty or exceeds 32 MiB.");
    return {blob: new Blob([output], {type: "application/pdf"}), metadata: {representation: "vector-page", georeferenced: registrations.length > 0,
      font: {id: manifest.id, version: manifest.version, checksumSha256: FONT_SHA256, license: manifest.license},
      ...(styled ? {fontFaces: faceNames.map(name => ({face: name, checksumSha256: PRINT_FONT_FACES[name].sha256}))} : {}),
      fontAttribution: attribution.map(file => file.name),
      compositeGroups: prepared.compositeGroups, page: {widthMm: width, heightMm: height}, converter: {jsPDF: "4.2.1", svg2pdf: "2.8.1"}}};
  } finally {for (const face of installedFaces) fonts.delete(face);}
}
