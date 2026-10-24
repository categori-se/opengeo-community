import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {jsPDF} from "jspdf";
import {compilePrintVectorPdf, preparePrintVectorPdfSvg, printVectorPdfFragments, printPdfCompositeForms,
  registerPrintPdfFontAttribution, validatePrintVectorPdfAttribution, validatePrintVectorPdfFont} from "../src/lib/printVectorPdf.js";

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
  const changedFont = font.slice();changedFont[100] ^= 1;
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
  const changed = notice.slice();changed[10] ^= 1;
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
