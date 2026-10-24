import {canonicalJson} from "./artifactCanonicalJson.js";
import {mapFontSha256, PINNED_MAP_FONT, PINNED_MAP_FONT_STACK} from "./mapFonts.js";
import {registerPrintPdfMaps} from "./printGeoPdf.js";
import {reflowPrintPdfTextFrames} from "./printTextSvg.js";
import {hasPrintMath, preparePrintMath, printMathLegalFiles} from "./printMathSvg.js";

const NS = "http://www.w3.org/2000/svg";
const FONT_SHA256 = "8ab4aa561e7db0eb3e1af8b0bed2a315e0a33fe2ed3070e645d1b89f8efc1d5c";
const NOTICE_SHA256 = "50abb8dfaa45dfa4c9167dff20766e459ced61c64ee8f97fcdedafc53e6b6f4a";
const LIMITS = {svgBytes: 16 * 1024 * 1024, pdfBytes: 32 * 1024 * 1024, nodes: 65000, text: 131072, groups: 256};
const TAGS = new Set(["svg", "g", "defs", "clipPath", "linearGradient", "stop", "rect", "circle", "path", "polyline", "line", "text", "title", "metadata"]);
const ATTRIBUTES = new Set(["xmlns", "id", "width", "height", "viewBox", "role", "x", "y", "cx", "cy", "r", "x1", "y1", "x2", "y2", "d", "points", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "clip-path", "font-size", "font-family", "font-style", "font-weight", "text-anchor", "paint-order", "color-interpolation", "offset", "stop-color", "stop-opacity", "style", "xml:space"]);
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
  const names = ["OpenSans-LICENSE.txt", "OpenSans-NOTICE.txt", "MathJax-LICENSE.txt", "MathJax-NOTICE.txt", "MathJax-TeX-FONT-NOTICE.txt", "SIL-OFL-1.1.txt"];
  if (!Array.isArray(files) || ![2, 6].includes(files.length) || files.some((file, index) => file?.name !== names[index]
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
  let text = "", groups = 0;
  for (const node of nodes) {
    if (node.namespaceURI !== NS || !TAGS.has(node.localName) || node !== copy && node.localName === "svg") fail(`Unsupported ${node.localName} content in direct vector PDF.`);
    if (["metadata", "title", "text"].includes(node.localName) && node.children.length) fail("The composed page contains unsupported nested text or metadata.");
    for (const attribute of [...node.attributes]) {
      const {name, value} = attribute;
      if (!ATTRIBUTES.has(name) && !/^data-[a-z0-9-]+$/.test(name) && !/^aria-[a-z0-9-]+$/.test(name)) fail(`Unsupported ${name} attribute in direct vector PDF.`);
      if (name === "xmlns" && (node !== copy || value !== NS)) fail("The composed page has an unsupported namespace.");
      if (name === "xml:space" && (node.localName !== "text" || value !== "preserve")) fail("Only literal text may preserve whitespace in direct vector PDF.");
      if (name === "id") {if (!ID.test(value) || ids.has(value)) fail("The composed page has an invalid or duplicate definition.");ids.set(value, node);}
      if (name === "style") {
        // Browsers enumerate shorthand background properties differently. Compare
        // their canonical serialization with the same owned style in this DOM.
        const expected = svg.ownerDocument.createElementNS(NS, "svg");
        expected.style.cssText = "background:white;color:#17212b;max-width:none";
        if (node !== copy || node.style.cssText !== expected.style.cssText) fail("External or custom CSS is unsupported in direct vector PDF.");
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
      if (["font-style", "font-weight"].includes(name) && value !== "normal" && value !== "400") fail("This font style needs browser Print.");
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
      node.setAttribute("font-family", family);node.setAttribute("font-style", "normal");node.setAttribute("font-weight", "normal");
      if (node.hasAttribute("paint-order")) {
        // svg2pdf always fills before stroking. Separate identical text runs keep
        // the accepted white halo behind, rather than over, the dark glyph.
        const halo = node.cloneNode(true);halo.removeAttribute("paint-order");halo.setAttribute("fill", "none");
        node.removeAttribute("paint-order");node.setAttribute("stroke", "none");node.before(halo);
      }
    }
  }
  for (const reference of references) if (ids.get(reference.id)?.localName !== reference.type) fail("A Print clip or gradient definition is missing.");
  if (text.length > LIMITS.text) fail("The composed page text exceeds the direct PDF limit.");
  copy.setAttribute("font-family", family);
  return {svg: copy, text, compositeGroups: groups, sourceMetadata: record};
}

// Partition in paint order, preserving each leaf's ancestor transforms/clips.
// A page background is a leaf in the first fragment, never an implicit backdrop.
export function printVectorPdfFragments(svg) {
  const definitions = [...svg.querySelectorAll("defs")].map(node => node.cloneNode(true));
  const fragments = [];let active = null;
  function fragment(opacity = 1) {
    const root = svg.cloneNode(false);root.append(...definitions.map(node => node.cloneNode(true)));
    const result = {svg: root, opacity, parents: new Map([[svg, root]])};fragments.push(result);return result;
  }
  function append(part, node, ancestors) {
    let parent = part.svg;
    for (const ancestor of ancestors) {
      if (!part.parents.has(ancestor)) {const copy = ancestor.cloneNode(false);parent.append(copy);part.parents.set(ancestor, copy);}
      parent = part.parents.get(ancestor);
    }
    parent.append(node);
  }
  function visit(node, ancestors) {
    if (["defs", "metadata", "title"].includes(node.localName)) return;
    if (node.localName === "g" && Number(node.getAttribute("opacity") ?? 1) !== 1) {
      active = null;
      const isolated = fragment(Number(node.getAttribute("opacity"))), copy = node.cloneNode(true);copy.setAttribute("opacity", "1");
      append(isolated, copy, ancestors);return;
    }
    if (node.localName === "g") {for (const child of node.children) visit(child, [...ancestors, node]);return;}
    active ??= fragment();append(active, node.cloneNode(true), ancestors);
  }
  for (const child of svg.children) visit(child, []);
  return fragments.map(({svg, opacity}) => ({svg, opacity}));
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

export async function compilePrintVectorPdf({svg, layout, fontBytes, fontManifest, manifestBytes, fontLicenseBytes, fontNoticeBytes, registrations = [], signal, onPhase} = {}) {
  const start = performance.now(), family = `OpenGeoPrintSans${++fontSequence}`;
  const check = () => {if (signal?.aborted) throw Error("Print PDF preparation was cancelled.");if (performance.now() - start > 60000) fail("Print PDF preparation exceeded its 60 second cooperative limit.");};
  // Limits and cancellation are checked between converter calls. Main-thread SVG
  // conversion cannot be interrupted synchronously; this is not worker isolation.
  check();onPhase?.("Checking vector page and embedded font…");
  if (hasPrintMath(layout)) {await preparePrintMath();check();}
  const prepared = preparePrintVectorPdfSvg(svg, layout, family);
  const {font, manifest} = await validatePrintVectorPdfFont(fontBytes, manifestBytes ?? fontManifest, prepared.text);check();
  if (manifestBytes && fontManifest && !(fontManifest instanceof Uint8Array) && !(fontManifest instanceof ArrayBuffer)
    && canonicalJson(fontManifest) !== canonicalJson(manifest)) fail("The loaded Print font manifest changed.");
  const attribution = await validatePrintVectorPdfAttribution(fontLicenseBytes, fontNoticeBytes, manifest);check();
  for (const file of printMathLegalFiles(layout)) {
    const value = new TextEncoder().encode(file.body);if (!value.length || value.length > 32768 || await mapFontSha256(value) !== file.sha256) fail("The packaged equation license or notice failed its checksum check.");
    attribution.push({name: file.name, bytes: value});
  }
  const view = svg.ownerDocument.defaultView, fonts = svg.ownerDocument.fonts;
  if (typeof view.FontFace !== "function" || !fonts?.add || !fonts?.delete) fail("This browser cannot load the exact embedded Print font.");
  const face = new view.FontFace(family, font.slice().buffer, {style: "normal", weight: "400"});
  await face.load();check();fonts.add(face);
  try {
    if (layout.textFrames?.length) reflowPrintPdfTextFrames(prepared.svg, layout, family);
    onPhase?.("Preparing PDF support…");
    const [{jsPDF}, {svg2pdf}] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);check();
    if (jsPDF.version !== "4.2.1") fail("The PDF converter version changed and needs review.");
    const width = layout.page.widthMm, height = layout.page.heightMm;
    const pdf = new jsPDF({orientation: width >= height ? "landscape" : "portrait", unit: "mm", format: [width, height], putOnlyUsedFonts: true, compress: true, floatPrecision: 12});
    pdf.__private__.setPdfVersion("1.7");
    pdf.addFileToVFS("OpenGeoPrintSans.ttf", binaryString(font));pdf.addFont("OpenGeoPrintSans.ttf", family, "normal");pdf.setFont(family, "normal");
    const embedded = pdf.getFont();
    if (embedded.fontName !== family || typeof embedded.metadata?.characterToGlyph !== "function") fail("The Print font could not be embedded.");
    for (const character of prepared.text) if (!embedded.metadata.characterToGlyph(character.codePointAt(0))) fail("A Print glyph is unavailable in the embedded font.");
    pdf.setProperties({title: layout.title, creator: "OpenGeo.Tools", subject: "Vector Print with embedded Open Sans"});
    registerPrintPdfMetadata(pdf, {schemaVersion: "opengeo.vector-print-pdf.1", ...prepared.sourceMetadata,
      geographicRegistration: registrations.length > 0, font: {id: manifest.id, checksumSha256: FONT_SHA256, license: manifest.license}});
    const fragments = printVectorPdfFragments(prepared.svg), composeGroup = printPdfCompositeForms(pdf);
    for (const [index, part] of fragments.entries()) {
      check();onPhase?.(`Converting vector page section ${index + 1} of ${fragments.length}…`);
      if (part.opacity === 1) await svg2pdf(part.svg, pdf, {width, height, loadExternalStyleSheets: false, loadImages: false});
      else await composeGroup(part.svg, part.opacity, svg2pdf, {width, height});
      check();
    }
    registerPrintPdfMaps(pdf, registrations);
    registerPrintPdfFontAttribution(pdf, attribution);
    onPhase?.("Packaging vector PDF…");check();
    const output = pdf.output("arraybuffer");check();
    if (!(output instanceof ArrayBuffer) || output.byteLength < 100 || output.byteLength > LIMITS.pdfBytes) fail("The vector PDF is empty or exceeds 32 MiB.");
    return {blob: new Blob([output], {type: "application/pdf"}), metadata: {representation: "vector-page", georeferenced: registrations.length > 0,
      font: {id: manifest.id, version: manifest.version, checksumSha256: FONT_SHA256, license: manifest.license},
      fontAttribution: attribution.map(file => file.name),
      compositeGroups: prepared.compositeGroups, page: {widthMm: width, heightMm: height}, converter: {jsPDF: "4.2.1", svg2pdf: "2.8.1"}}};
  } finally {fonts.delete(face);}
}
