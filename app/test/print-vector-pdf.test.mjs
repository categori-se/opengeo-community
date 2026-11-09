import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {PRINT_FONT_FACES, usedPrintFontFaces, printFontFaceAttributes, validatePrintFontFaceAssets, preparePrintFontFaces, assertPrintFontFaceCoverage} from "../src/lib/printFontFaces.js";
import {jsPDF} from "jspdf";
import {compilePrintVectorPdf, preparePrintVectorPdfSvg, printVectorPdfFragments, printPdfCompositeForms,
  registerPrintPdfFontAttribution, registerPrintPdfTextStructure, printPdfTextSemantics,
  validatePrintVectorPdfAttribution, validatePrintVectorPdfFont} from "../src/lib/printVectorPdf.js";
import {registerPrintPdfMaps} from "../src/lib/printGeoPdf.js";

const FONT_ROOT = new URL("../src/assets/render-fonts/opengeo-open-sans-v1/1/", import.meta.url);
const [font, manifest, license, notice] = await Promise.all([readFile(new URL("OpenSans-Regular.ttf", FONT_ROOT)), readFile(new URL("manifest.json", FONT_ROOT)),
  readFile(new URL("LICENSE.txt", FONT_ROOT)), readFile(new URL("NOTICE.txt", FONT_ROOT))]);
function page() {
  const dom = new JSDOM("<!doctype html><body></body>"), doc = dom.window.document, ns = "http://www.w3.org/2000/svg";
  const layout = {id: "layout", title: "Café Ω Москва", page: {widthMm: 297, heightMm: 210}, frames: [{id: "main"}]};
  const node = (name, attributes = {}, text) => {
    const result = doc.createElementNS(ns, name);for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
    if (text !== undefined) result.textContent = text;return result;
  };
  const svg = node("svg", {xmlns: ns, width: "297mm", height: "210mm", viewBox: "0 0 297 210", role: "img", "aria-label": layout.title});
  svg.style.cssText = "background:white;color:#17212b;max-width:none";
  svg.append(node("metadata", {}, JSON.stringify({layout, mapRepresentation: "vector", geographicRegistration: false, captures: [{frameId: "main"}]})),
    node("rect", {width: 297, height: 210, fill: "white", "data-paper-background": "true"}));
  const defs = node("defs"), clip = node("clipPath", {id: "print-map-0"});clip.append(node("rect", {x: 10, y: 30, width: 200, height: 150}));defs.append(clip);
  const gradient = node("linearGradient", {id: "print-continuous-0", x1: "0%", y1: "100%", x2: "0%", y2: "0%", "color-interpolation": "sRGB"});
  gradient.append(node("stop", {offset: 0, "stop-color": "#112233"}), node("stop", {offset: 1, "stop-color": "#445566"}));defs.append(gradient);svg.append(defs);
  const clipped = node("g", {"clip-path": "url(#print-map-0)"}), map = node("g", {"data-print-vector-map": "a".repeat(64), transform: "translate(10 30) scale(0.5 0.5)"});
  const pass = node("g", {"data-print-vector-pass": "fill", opacity: 0.5});
  pass.append(node("rect", {x: 0, y: 0, width: 100, height: 100, fill: "rgb(37 99 235)", "fill-opacity": 0.7}),
    node("path", {d: "M50 50 L150 50 L150 150 Z", fill: "#2563eb", "fill-opacity": 0.7, "fill-rule": "evenodd"}));
  map.append(pass);clipped.append(map);svg.append(clipped,
    node("rect", {x: 230, y: 40, width: 4, height: 40, fill: "url(#print-continuous-0)"}),
    node("text", {x: 10, y: 16, "font-size": 5, "font-family": "system-ui,sans-serif", fill: "#17212b", stroke: "white", "stroke-width": 0.65, "paint-order": "stroke fill"}, layout.title));
  return {dom, svg, layout, node, serialize: value => new dom.window.XMLSerializer().serializeToString(value)};
}

test("direct vector PDF admits the owned page, preserves source nodes and makes halos/font/color converter-compatible", () => {
  const value = page();try {
    const before = value.serialize(value.svg), result = preparePrintVectorPdfSvg(value.svg, value.layout);
    assert.equal(value.serialize(value.svg), before, "Preparing a PDF cannot mutate the SVG download or page preview");
    assert.equal(result.text, value.layout.title);assert.equal(result.compositeGroups, 1);
    assert.equal(result.svg.hasAttribute("style"), false);
    assert.equal(result.svg.querySelector('[data-print-vector-pass] rect').getAttribute("fill"), "rgb(37,99,235)");
    const labels = [...result.svg.querySelectorAll("text")];assert.equal(labels.length, 2);
    assert.equal(labels[0].getAttribute("fill"), "none");assert.equal(labels[0].getAttribute("stroke"), "white");
    assert.equal(labels[1].getAttribute("fill"), "#17212b");assert.equal(labels[1].getAttribute("stroke"), "none");
    assert.ok(labels.every(node => node.getAttribute("font-family") === "OpenGeoPrintSans" && !node.hasAttribute("paint-order")));
    assert.equal(result.svg.querySelector('[data-print-vector-pass]').getAttribute("opacity"), "0.5");
    assert.equal(result.svg.querySelector("path").getAttribute("fill-opacity"), "0.7");
  } finally {value.dom.window.close();}
});

test("composite fragments retain paint order, exact ancestor clipping/transforms and one page background", () => {
  const value = page();try {
    const prepared = preparePrintVectorPdfSvg(value.svg, value.layout), parts = printVectorPdfFragments(prepared.svg);
    assert.deepEqual(parts.map(part => part.opacity), [1, 0.5, 1]);
    assert.equal(parts.reduce((sum, part) => sum + part.svg.querySelectorAll("[data-paper-background]").length, 0), 1);
    assert.equal(parts[0].svg.querySelectorAll("[data-paper-background]").length, 1);
    assert.equal(parts[1].svg.querySelectorAll("text").length, 0);
    const pass = parts[1].svg.querySelector("[data-print-vector-pass]");
    assert.equal(pass.getAttribute("opacity"), "1", "Only the wrapper group applies composite alpha");
    assert.equal(pass.querySelector("path").getAttribute("fill-opacity"), "0.7", "Feature alpha remains inside the isolated group");
    assert.equal(pass.parentElement.getAttribute("transform"), "translate(10 30) scale(0.5 0.5)");
    assert.equal(pass.parentElement.parentElement.getAttribute("clip-path"), "url(#print-map-0)");
    assert.ok(parts.every(part => part.svg.querySelector("#print-map-0") && part.svg.querySelector("#print-continuous-0")));
    assert.equal(parts[2].svg.querySelectorAll("text").length, 2);
  } finally {value.dom.window.close();}
});

test("direct PDF refuses images, executable/imported SVG, URLs, CSS, unresolved definitions and changed pages", () => {
  const changes = [
    value => value.svg.append(value.node("image", {href: "data:image/png;base64,AA=="})),
    value => value.svg.append(value.node("image", {href: "data:image/svg+xml,%3Csvg/%3E"})),
    ...["script", "foreignObject", "style", "use", "svg"].map(tag => value => value.svg.append(value.node(tag))),
    value => value.svg.setAttribute("onclick", "alert(1)"),
    value => value.svg.querySelector("path").setAttribute("fill", "url(https://example.invalid/paint.svg#x)"),
    value => value.svg.querySelector("path").setAttribute("fill", "url(#missing)"),
    value => value.svg.querySelector("text").setAttribute("style", "font-family:remote"),
    value => {value.svg.style.backgroundImage = "url(https://example.invalid/image.png)";},
    value => {value.svg.style.setProperty("--custom-page", "1");},
    value => value.svg.querySelector("text").setAttribute("font-weight", "bold"),
    value => value.svg.querySelector("stop").setAttribute("stop-opacity", "0.5"),
    value => value.svg.querySelector("[data-print-vector-pass]").setAttribute("opacity", "NaN"),
    value => value.svg.querySelector("[data-print-vector-pass]").append(value.node("g")),
    value => {value.layout.page.widthMm = 298;},
    value => value.svg.setAttribute("viewBox", "0 0 297 211")
  ];
  for (const change of changes) {
    const value = page();try {change(value);assert.throws(() => preparePrintVectorPdfSvg(value.svg, value.layout), /browser|Print|PDF|vector/i);} finally {value.dom.window.close();}
  }
});

test("font admission checks exact source/manifest bytes and every Unicode scalar without fallback", async () => {
  const accepted = await validatePrintVectorPdfFont(font, manifest, "Café Ω Москва ≥ 42° · License: unknown");
  assert.equal(accepted.manifest.license, "Apache-2.0");
  for (const text of ["東京", "مرحبا", "😀", "hidden\u202Etext", "line\nbreak"]) await assert.rejects(validatePrintVectorPdfFont(font, manifest, text), /does not cover U\+.*browser output/);
  const changedFont = new Uint8Array(font);changedFont[100] ^= 1;
  await assert.rejects(validatePrintVectorPdfFont(changedFont, manifest, "test"), /checksum/);
  const changedManifest = new TextEncoder().encode(JSON.stringify({...JSON.parse(manifest), version: 2}));
  await assert.rejects(validatePrintVectorPdfFont(font, changedManifest, "test"), /checksum/);
  await assert.rejects(validatePrintVectorPdfFont(font, JSON.parse(manifest), "test"), /manifest bytes/);
});

test("cancelled PDF output stops before font loading or converter imports", async () => {
  const controller = new AbortController();controller.abort();
  await assert.rejects(compilePrintVectorPdf({signal: controller.signal}), /cancelled/);
});

test("pinned jsPDF forms serialize isolated composite alpha with explicit resolved resources", async () => {
  assert.equal(jsPDF.version, "4.2.1");
  const pdf = new jsPDF({unit: "mm", orientation: "landscape", format: [297, 210], compress: false});
  const composite = printPdfCompositeForms(pdf);
  await composite(null, 0.5, async (_svg, writer) => {
    writer.setGState(new writer.GState({opacity: 0.7}));writer.setFillColor(37, 99, 235);
    writer.rect(10, 20, 30, 40, "F");writer.rect(20, 20, 30, 40, "F");
  }, {width: 297, height: 210});
  const output = pdf.output();
  assert.match(output, /\/Group << \/S \/Transparency \/CS \/DeviceRGB \/I true \/K false >>/);
  assert.match(output, /\/ExtGState << \/GS\d+ \d+ 0 R/);assert.match(output, /\/XObject << \/Xo\d+ \d+ 0 R/);
  assert.match(output, /\/Resources \d+ 0 R\n\/Group/);
  assert.match(output, /\/ca 0\.7/);assert.match(output, /\/ca 0\.5/);
  assert.match(output, /\/OpenGeoPrintComposite0 \d+ 0 R/);assert.match(output, /\/OpenGeoPrintComposite0 Do/);
  assert.equal((output.match(/ re\n?\s*f/g) ?? []).length, 2);assert.doesNotMatch(output, /\/Subtype \/Image/);
  assert.equal(pdf.output(), output, "Repeated serialization keeps valid object identities");
});

test("PDF carries exact verified plain-text font license/notice with fixed attachment names", async () => {
  const files = await validatePrintVectorPdfAttribution(license, notice, JSON.parse(manifest));
  const changed = new Uint8Array(notice);changed[10] ^= 1;
  await assert.rejects(validatePrintVectorPdfAttribution(license, changed, JSON.parse(manifest)), /checksum/);
  const pdf = new jsPDF({compress: false});registerPrintPdfFontAttribution(pdf, files);
  const output = pdf.output(), embedded = [...output.matchAll(/\/Type \/EmbeddedFile \/Subtype \/text#2Fplain \/Length (\d+) >>\nstream\n/g)];
  assert.equal(embedded.length, 2);
  for (const [index, match] of embedded.entries()) {
    const start = match.index + match[0].length;
    assert.deepEqual(Buffer.from(output.slice(start, start + Number(match[1])), "binary"), [license, notice][index]);
  }
  assert.match(output, /\/Names << \/EmbeddedFiles \d+ 0 R >>/);
  assert.match(output, /\/Filespec \/F \(OpenSans-LICENSE\.txt\)/);
  assert.match(output, /\/Filespec \/F \(OpenSans-NOTICE\.txt\)/);
  assert.doesNotMatch(output, /\/JavaScript|\/Launch|\/URI|\/AA\b/);
  assert.equal(pdf.output(), output, "Attachment object identities reset correctly for repeat output");
  assert.throws(() => registerPrintPdfFontAttribution(new jsPDF(), [{name: "bad) /JS (", bytes: license}]), /invalid/);
});


test("owned point legend opacity uses the same isolated vector fragment path", () => {
  const value = page();try {
    const legend = value.node("g", {"data-print-point-legend": "hospital", opacity: 0.7, transform: "translate(230 85) scale(0.1)"});
    legend.append(value.node("circle", {cx: 32, cy: 32, r: 30, fill: "#2563eb"}),
      value.node("rect", {x: 20, y: 28, width: 24, height: 8, fill: "#ffffff"}));value.svg.append(legend);
    const prepared = preparePrintVectorPdfSvg(value.svg, value.layout), fragments = printVectorPdfFragments(prepared.svg);
    assert.equal(prepared.compositeGroups, 2);const fragment = fragments.find(item => item.opacity === 0.7);
    assert.ok(fragment);assert.equal(fragment.svg.querySelectorAll("circle").length, 1);assert.equal(fragment.svg.querySelectorAll("image").length, 0);
    assert.equal(fragment.svg.querySelector('[data-print-point-legend]').getAttribute("opacity"), "1");
  } finally {value.dom.window.close();}
});


const FACES_ROOT = new URL("../src/assets/print-fonts/open-sans-v1/", import.meta.url);
async function faceAssets() {
  const [bold, italic, bolditalic, noticeBytes] = await Promise.all([
    readFile(new URL("OpenSans-Bold.ttf", FACES_ROOT)), readFile(new URL("OpenSans-Italic.ttf", FACES_ROOT)),
    readFile(new URL("OpenSans-BoldItalic.ttf", FACES_ROOT)), readFile(new URL("FACES-NOTICE.txt", FACES_ROOT))
  ]);
  return {faceBytes: {regular: font, bold, italic, bolditalic}, noticeBytes};
}
function styledPage(face = "bold") {
  const value = page();
  const frame = {id: "literal", type: "text", title: "Real face", text: "OpenGeo office", xMm: 10, yMm: 180,
    widthMm: 120, heightMm: 20, fontSizePt: 18, color: "#17212b", background: "none", alignment: "left", fontFace: face};
  value.layout.textFrames = [frame];
  const record = JSON.parse(value.svg.querySelector("metadata").textContent);record.layout = value.layout;
  value.svg.querySelector("metadata").textContent = JSON.stringify(record);
  const group = value.node("g", {"data-print-text-frame": frame.id});
  const line = value.node("text", {x: 11, y: 187.35, "font-size": 6.35, fill: frame.color,
    "data-print-text-line": 0, "xml:space": "preserve", ...printFontFaceAttributes(face)}, frame.text);
  group.append(line);value.svg.append(group);
  return {...value, group, line};
}

test("only exact owned literal text can select actual PDF bold and italic faces", () => {
  for (const face of ["bold", "italic", "bolditalic"]) {
    const value = styledPage(face);
    try {
      value.line.setAttribute("style", "font-synthesis: none;");
      const prepared = preparePrintVectorPdfSvg(value.svg, value.layout);
      const line = prepared.svg.querySelector('[data-print-text-frame="literal"] text');
      assert.equal(line.getAttribute("font-weight"), PRINT_FONT_FACES[face].weight);
      assert.equal(line.getAttribute("font-style"), PRINT_FONT_FACES[face].style);
      assert.equal(line.hasAttribute("style"), false);
      assert.equal(prepared.faceText[face], "OpenGeo office");
    } finally {value.dom.window.close();}
  }
  for (const change of [
    value => {value.line.textContent = "Unmatched substituted text";},
    value => value.group.setAttribute("data-print-text-frame", "unknown"),
    value => value.line.setAttribute("font-style", "italic"),
    value => value.group.setAttribute("font-weight", "700"),
    value => value.line.setAttribute("style", "font-synthesis: none; fill: red;")
  ]) {
    const value = styledPage();
    try {change(value);assert.throws(() => preparePrintVectorPdfSvg(value.svg, value.layout), /style|CSS|face|Print/);}
    finally {value.dom.window.close();}
  }
});

test("real Print faces have separate pinned bytes and reject changed font or attribution", async () => {
  const layout = {textFrames: ["regular", "bold", "italic", "bolditalic"].map(fontFace => ({type: "text", text: "OpenGeo office", fontFace}))};
  const assets = await faceAssets();
  const prepared = await validatePrintFontFaceAssets(layout, assets);
  assert.deepEqual(usedPrintFontFaces(layout), ["regular", "bold", "italic", "bolditalic"]);
  assert.equal(new Set(Object.values(PRINT_FONT_FACES).map(face => face.sha256)).size, 4);
  assert.equal(Object.keys(prepared.faces).length, 4);
  const changed = new Uint8Array(assets.faceBytes.bold);changed[100] ^= 1;
  await assert.rejects(validatePrintFontFaceAssets(layout, {...assets, faceBytes: {...assets.faceBytes, bold: changed}}), /bold.*checksum/);
  const badNotice = new Uint8Array(assets.noticeBytes);badNotice[10] ^= 1;
  await assert.rejects(validatePrintFontFaceAssets(layout, {...assets, noticeBytes: badNotice}), /notice.*checksum/);
  await assert.rejects(validatePrintFontFaceAssets({textFrames: [{type: "text", text: "東京", fontFace: "bold"}]}, assets), /bold.*does not cover/);
  assert.throws(() => usedPrintFontFaces({textFrames: [{type: "text", fontFace: "synthetic-bold"}]}), /packaged/);
  assert.throws(() => usedPrintFontFaces({textFrames: [{type: "math", fontFace: "bold"}]}), /literal/);
});

test("browser face preparation loads exact used assets, embeds legal text and disposes actual FontFaces", async () => {
  const assets = await faceAssets(), loaded = [], installed = new Set();
  class Face {
    constructor(family, bytes, descriptor) {Object.assign(this, {family, bytes, descriptor});}
    async load() {loaded.push(this);return this;}
  }
  const document = {defaultView: {FontFace: Face}, fonts: {add: face => installed.add(face), delete: face => installed.delete(face)}};
  const prepared = await preparePrintFontFaces({textFrames: [{type: "text", text: "OpenGeo office", fontFace: "bolditalic"}]},
    {document, ...assets, licenseBytes: license, regularNoticeBytes: notice});
  assert.equal(loaded.length, 2, "Regular and the selected real face are loaded; unused faces are not");
  assert.deepEqual(loaded.map(face => face.descriptor), [{style: "normal", weight: "400"}, {style: "italic", weight: "700"}]);
  assert.equal(new Uint8Array(loaded[1].bytes).length, assets.faceBytes.bolditalic.length);
  assert.equal((prepared.css.match(/@font-face\{/g) ?? []).length, 2);
  assert.match(prepared.css, /Apache License/);assert.match(prepared.css, /OpenSans-FACES-NOTICE/);
  assert.match(prepared.css, /font-style:italic;font-weight:700;src:url\(data:font\/ttf;base64,/);
  prepared.dispose();assert.equal(installed.size, 0);
});

test("PDF adds the third faces notice only for new faces and retains two-file Regular attribution", async () => {
  const legal = await validatePrintVectorPdfAttribution(license, notice, JSON.parse(manifest));
  const {noticeBytes} = await faceAssets();
  const pdf = new jsPDF({compress: false});
  registerPrintPdfFontAttribution(pdf, [...legal, {name: "OpenSans-FACES-NOTICE.txt", bytes: noticeBytes}]);
  const output = pdf.output();
  assert.equal((output.match(/\/Type \/EmbeddedFile/g) ?? []).length, 3);
  assert.match(output, /OpenSans-FACES-NOTICE\.txt/);
  assert.equal(legal.length, 2);
});


test("same-face edited text is checked without reloading or hashing cached font assets", () => {
  const frame = {type: "text", fontFace: "bold", text: "OpenGeo office"};
  const layout = {textFrames: [frame]};
  assert.doesNotThrow(() => assertPrintFontFaceCoverage(layout));
  frame.text = "OpenGeo 東京";
  assert.throws(() => assertPrintFontFaceCoverage(layout), /bold.*does not cover U\+6771/);
  frame.text = "Updated café";
  assert.doesNotThrow(() => assertPrintFontFaceCoverage(layout));
});

function pdfObjects(output) {
  return new Map([...output.matchAll(/(?:^|\n)(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj\b/g)]
    .map(match => [Number(match[1]), match[2]]));
}
function pdfReference(object, key) {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R\\b`).exec(object);
  assert.ok(match, `Missing /${key} reference`);return Number(match[1]);
}
function pdfReferences(value) {return [...value.matchAll(/(\d+)\s+0\s+R\b/g)].map(match => Number(match[1]));}

test("semantic ownership promotes only the owned title and literal frames, and halo artifacts require object identity", () => {
  const value = styledPage("regular");try {
    const title = value.svg.querySelector("text");title.setAttribute("data-print-page-title", "true");
    const frame = value.layout.textFrames[0];frame.text = "Wrapped first\nWrapped second";
    value.line.textContent = "Wrapped first";
    const second = value.line.cloneNode(true);second.setAttribute("data-print-text-line", "1");second.setAttribute("y", "194");second.textContent = "Wrapped second";
    value.group.append(second);
    const metadata = JSON.parse(value.svg.querySelector("metadata").textContent);metadata.layout = value.layout;
    value.svg.querySelector("metadata").textContent = JSON.stringify(metadata);
    const spoof = value.node("text", {x: 230, y: 100, "font-size": 3, fill: "black", "data-print-pdf-artifact": "true", "data-print-pdf-role": "H1"}, value.layout.title);
    value.svg.append(spoof);
    const before = value.serialize(value.svg), prepared = preparePrintVectorPdfSvg(value.svg, value.layout);
    assert.equal(value.serialize(value.svg), before);
    const semantics = printPdfTextSemantics(prepared.svg, value.layout, prepared.artifactText);
    const titles = [...prepared.svg.querySelectorAll('[data-print-page-title="true"]')];assert.equal(titles.length, 1);
    const paintedTitle = titles[0], halo = [...prepared.svg.querySelectorAll("text")].find(node => prepared.artifactText.has(node));
    assert.ok(halo);
    assert.equal(semantics.get(halo)?.role, "Artifact");assert.equal(semantics.get(paintedTitle)?.role, "H1");
    assert.ok(prepared.artifactText.has(halo));assert.equal(prepared.artifactText.has(paintedTitle), false);
    const lines = [...prepared.svg.querySelectorAll('[data-print-text-frame="literal"] text')];
    assert.deepEqual(lines.map(line => semantics.get(line)?.role), ["P", "P"]);
    assert.equal(semantics.get(lines[0]).group, semantics.get(lines[1]).group);
    assert.ok(semantics.get(lines[0]).group, "The literal frame owns its wrapped lines");
    const untrusted = prepared.svg.querySelector('[data-print-pdf-artifact="true"]');
    assert.equal(semantics.get(untrusted)?.role, "Span", "Caller data attributes grant no artifact or heading authority");
    const clonedHalo = halo.cloneNode(true);clonedHalo.removeAttribute("data-print-page-title");prepared.svg.append(clonedHalo);
    const recomputed = printPdfTextSemantics(prepared.svg, value.layout, prepared.artifactText);
    assert.notEqual(recomputed.get(clonedHalo)?.role, "Artifact", "Copying halo attributes cannot forge the owned halo identity");
  } finally {value.dom.window.close();}
});

test("tagged fragments keep text paint boundaries, clipping, definitions and composite opacity without changing the ordinary path", () => {
  const value = styledPage("regular");try {
    value.svg.querySelector("text").setAttribute("data-print-page-title", "true");
    const prepared = preparePrintVectorPdfSvg(value.svg, value.layout);
    const semantics = printPdfTextSemantics(prepared.svg, value.layout, prepared.artifactText);
    const ordinary = printVectorPdfFragments(prepared.svg), tagged = printVectorPdfFragments(prepared.svg, semantics);
    assert.deepEqual(ordinary.map(part => part.opacity), [1, 0.5, 1]);
    assert.deepEqual(tagged.filter(part => part.semantic).map(part => part.semantic.role), ["Artifact", "H1", "P"]);
    for (const part of tagged.filter(part => part.semantic)) assert.equal(part.svg.querySelectorAll("text").length, 1,
      "Each semantic converter call paints one text leaf in its original position");
    assert.equal(tagged.reduce((sum, part) => sum + part.svg.querySelectorAll("[data-paper-background]").length, 0), 1);
    const map = tagged.find(part => part.opacity === 0.5), pass = map.svg.querySelector("[data-print-vector-pass]");
    assert.equal(map.semantic, undefined);assert.equal(pass.getAttribute("opacity"), "1");
    assert.equal(pass.parentElement.getAttribute("transform"), "translate(10 30) scale(0.5 0.5)");
    assert.equal(pass.parentElement.parentElement.getAttribute("clip-path"), "url(#print-map-0)");
    assert.equal(pass.querySelector("path").getAttribute("fill-opacity"), "0.7");
    assert.ok(tagged.every(part => part.svg.querySelector("#print-map-0") && part.svg.querySelector("#print-continuous-0")));
    const paintedText = parts => parts.flatMap(part => [...part.svg.querySelectorAll("text")].map(node => node.textContent));
    assert.deepEqual(paintedText(tagged), paintedText(ordinary), "Semantic partitions retain the original leaf paint order");
  } finally {value.dom.window.close();}
});

test("a forged or misplaced owned page-title marker cannot confer heading ownership", () => {
  for (const mutate of [
    value => {const title = value.svg.querySelector("text");title.setAttribute("data-print-page-title", "true");title.textContent = "Forged title";},
    value => {const title = value.svg.querySelector("text");title.setAttribute("data-print-page-title", "true");const group = value.node("g");title.replaceWith(group);group.append(title);}
  ]) {
    const value = page();try {mutate(value);assert.throws(() => preparePrintVectorPdfSvg(value.svg, value.layout), /title|owned|Print|PDF/i);}
    finally {value.dom.window.close();}
  }
});

test("blank source lines create no semantic owner and invalid or unfinished paint scopes fail closed", () => {
  const value = styledPage("regular");try {
    const blank = value.line.cloneNode(true);blank.setAttribute("data-print-text-line", "1");blank.textContent = "";value.group.append(blank);
    const prepared = preparePrintVectorPdfSvg(value.svg, value.layout), semantics = printPdfTextSemantics(prepared.svg, value.layout, prepared.artifactText);
    const lines = prepared.svg.querySelectorAll('[data-print-text-frame="literal"] text');
    assert.equal(semantics.get(lines[0])?.role, "P");assert.equal(semantics.has(lines[1]), false);
  } finally {value.dom.window.close();}
  const pdf = new jsPDF({compress: false}), structure = registerPrintPdfTextStructure(pdf);
  for (const descriptor of [{role: "Figure", text: "unknown"}, {role: "P", text: "   "}, {role: "P", text: "line", group: ""}])
    assert.throws(() => structure.begin(descriptor), /PDF|invalid/i);
  structure.begin({role: "P", text: "Painted", group: "frame"});pdf.text("Painted", 10, 10);
  assert.throws(() => structure.begin({role: "Span", text: "Nested"}), /nested|invalid/i);structure.end();
  assert.throws(() => structure.end(), /not open|PDF/i);
  assert.throws(() => structure.begin({role: "H1", text: "Changed role", group: "frame"}), /role|PDF/i);
  const output = pdf.output();structure.assertComplete();
  assert.equal((output.match(/\/MCID\s+\d+/g) ?? []).length, 1, "Refused and unpainted runs add no phantom MCIDs");
  const brokenPdf = new jsPDF(), broken = registerPrintPdfTextStructure(brokenPdf);
  broken.begin({role: "P", text: "Unclosed"});brokenPdf.text("Unclosed", 10, 10);brokenPdf.output();
  assert.throws(() => broken.assertComplete(), /incomplete|PDF/i, "Serializer hook failures must remain visible after jsPDF catches callbacks");
});

async function paintedStructureFixture(tagged = true) {
  const pdf = new jsPDF({unit: "mm", orientation: "landscape", format: [297, 210], compress: false, putOnlyUsedFonts: true});
  pdf.setFileId("0123456789ABCDEF0123456789ABCDEF");pdf.setCreationDate(new Date("2026-11-09T12:00:00.000Z"));
  pdf.addFileToVFS("OpenGeoPrintSans.ttf", font.toString("binary"));pdf.addFont("OpenGeoPrintSans.ttf", "OpenGeoPrintSans", "normal");
  pdf.setFont("OpenGeoPrintSans", "normal");pdf.setFontSize(12);
  const structure = tagged ? registerPrintPdfTextStructure(pdf) : {begin() {}, end() {}, assertComplete() {}};
  const paint = (semantic, text, x, y) => {structure.begin(semantic);pdf.text(text, x, y);structure.end();};
  paint({role: "Artifact"}, "Owned page title", 10, 16);
  paint({role: "H1", text: "Owned page title", group: "title"}, "Owned page title", 10, 16);
  const composite = printPdfCompositeForms(pdf);
  await composite(null, 0.5, async (_svg, writer) => {
    writer.setGState(new writer.GState({opacity: 0.7}));writer.setFillColor(37, 99, 235);writer.rect(10, 30, 100, 100, "F");
  }, {width: 297, height: 210});
  paint({role: "P", text: "First wrapped line", group: "frame:one"}, "First wrapped line", 10, 145);
  paint({role: "P", text: "Second wrapped line", group: "frame:one"}, "Second wrapped line", 10, 152);
  paint({role: "P", text: "Another literal frame", group: "frame:two"}, "Another literal frame", 10, 166);
  paint({role: "Span", text: "Map credit"}, "Map credit", 10, 200);
  registerPrintPdfMaps(pdf, [{name: "main", pageNumber: 1, crs: "EPSG:3857", bbox: [30, 220, 310, 500],
    lpts: [0, 1, 0, 0, 1, 0, 1, 1], gpts: [45, 10, 40, 10, 40, 20, 45, 20]}]);
  registerPrintPdfFontAttribution(pdf, await validatePrintVectorPdfAttribution(license, notice, JSON.parse(manifest)));
  return {pdf, structure};
}

test("real jsPDF text structure binds painted MCIDs to one Document, title and wrapped paragraphs on repeat output", async () => {
  const {pdf, structure} = await paintedStructureFixture();
  const output = pdf.output();structure.assertComplete();
  assert.equal(pdf.output(), output, "Every serialization rebuilds the same complete structure object identities");structure.assertComplete();

  const objects = pdfObjects(output), find = pattern => {
    const matches = [...objects].filter(([, object]) => pattern.test(object));assert.equal(matches.length, 1, String(pattern));return matches[0];
  };
  const [catalogId, catalog] = find(/\/Type\s+\/Catalog\b/);
  const [rootId, root] = find(/\/Type\s+\/StructTreeRoot\b/);
  const [documentId, document] = find(/\/Type\s+\/StructElem\b[\s\S]*\/S\s+\/Document\b/);
  const [pageId, pageObject] = find(/\/Type\s+\/Page\b/);
  assert.ok(catalogId);assert.equal(pdfReference(catalog, "StructTreeRoot"), rootId);
  assert.match(catalog, /\/MarkInfo\s*<<\s*\/Marked\s+true\s*>>/);
  assert.equal(pdfReference(document, "P"), rootId);assert.ok(pdfReferences(root).includes(documentId));
  assert.match(pageObject, /\/StructParents\s+0\b/);assert.match(pageObject, /\/Tabs\s+\/S\b/);
  const leaves = [...objects].filter(([, object]) => /\/Type\s+\/StructElem\b/.test(object) && !/\/S\s+\/Document\b/.test(object));
  assert.equal(leaves.length, 4, "One H1, one P per literal frame, and one incidental Span");
  assert.deepEqual(leaves.map(([, object]) => /\/S\s+\/(H1|P|Span)\b/.exec(object)?.[1]), ["H1", "P", "P", "Span"]);
  for (const [id, object] of leaves) {
    assert.equal(pdfReference(object, "P"), documentId);assert.equal(pdfReference(object, "Pg"), pageId);
    assert.ok(pdfReferences(document).includes(id), `Document owns text element ${id}`);
  }
  const parentTree = objects.get(pdfReference(root, "ParentTree"));assert.ok(parentTree);
  const nums = /\/Nums\s*\[\s*0\s*\[([^\]]*)\]/.exec(parentTree);assert.ok(nums, "The actual page has a ParentTree array");
  const parentOwners = pdfReferences(nums[1]);
  assert.deepEqual(parentOwners, [leaves[0][0], leaves[1][0], leaves[1][0], leaves[2][0], leaves[3][0]],
    "Each wrapped painted line resolves to its paragraph; separate frames keep separate owners");
  assert.match(leaves[1][1], /\/K\s*\[\s*1\s+2\s*\]/, "The paragraph retains both painted line MCIDs in order");

  const contentObject = objects.get(pdfReference(pageObject, "Contents"));assert.ok(contentObject);
  const stream = /\bstream\r?\n([\s\S]*?)\r?\nendstream\b/.exec(contentObject)?.[1];assert.ok(stream);
  const marked = [...stream.matchAll(/\/(H1|P|Span)\s*<<([\s\S]*?)>>\s*BDC\s*([\s\S]*?)\s*EMC\b/g)];
  assert.equal(marked.length, 5);assert.deepEqual(marked.map(match => match[1]), ["H1", "P", "P", "P", "Span"]);
  assert.deepEqual(marked.map(match => Number(/\/MCID\s+(\d+)/.exec(match[2])?.[1])), [0, 1, 2, 3, 4]);
  const logicalText = marked.map(match => {
    const hex = /\/ActualText\s*<FEFF([0-9a-f]*)>/i.exec(match[2]);assert.ok(hex);
    return hex[1].match(/.{4}/g).map(scalar => String.fromCharCode(parseInt(scalar, 16))).join("");
  });
  assert.deepEqual(logicalText, ["Owned page title", "First wrapped line", "Second wrapped line", "Another literal frame", "Map credit"]);
  for (const match of marked) {
    assert.match(match[2], /\/ActualText\b/);assert.match(match[3], /\bBT\b[\s\S]*\bT[jJ]\b[\s\S]*\bET\b/,
      "Marked content encloses the actual text painting operators on the actual page");
    assert.doesNotMatch(match[3], /\/MCID\b/, "Paint scopes cannot overlap or nest semantic text");
  }
  const artifact = /\/Artifact\s+(?:BMC|<<[\s\S]*?>>\s*BDC)\s*([\s\S]*?)\s*EMC\b/.exec(stream);assert.ok(artifact);
  assert.match(artifact[1], /\bT[jJ]\b/);assert.doesNotMatch(artifact[1], /\/MCID\b/);
  assert.match(pageObject, /\/VP\s*\[/);assert.match(output, /\/Subtype\s+\/GEO\b/);
  assert.match(output, /\/Group << \/S \/Transparency \/CS \/DeviceRGB \/I true \/K false >>/);
  assert.equal((output.match(/\/Type\s+\/EmbeddedFile\b/g) ?? []).length, 2);
  assert.match(output, /\/FontFile2\b/);assert.doesNotMatch(output, /\/Subtype\s+\/Image\b/);
  if (process.env.OPENGEO_PRINT_STRUCTURE_PDF) {
    await writeFile(process.env.OPENGEO_PRINT_STRUCTURE_PDF, Buffer.from(output, "binary"));
    const {pdf: before} = await paintedStructureFixture(false);
    await writeFile(process.env.OPENGEO_PRINT_STRUCTURE_PDF.replace(/(?:\.pdf)?$/, "-before.pdf"), Buffer.from(before.output(), "binary"));
  }
});
