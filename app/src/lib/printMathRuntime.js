import {mathjax} from "@mathjax/src/mjs/mathjax.js";
import {TeX} from "@mathjax/src/mjs/input/tex.js";
import {SVG} from "@mathjax/src/mjs/output/svg.js";
import {liteAdaptor} from "@mathjax/src/mjs/adaptors/liteAdaptor.js";
import {RegisterHTMLHandler} from "@mathjax/src/mjs/handlers/html.js";
import {MathJaxTexFont} from "@mathjax/mathjax-tex-font/mjs/svg.js";
import "@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/mjs/input/tex/newcommand/NewcommandConfiguration.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const MAX_SOURCE = 4000, MAX_NODES = 6000, MAX_SVG = 1000000;
const fail = message => {throw Error(`Print math: ${message}`);};
const rethrow = error => {throw error;};

// This original TeX font contains its outline tables locally. Never turn a
// missing glyph into a dynamic module request, even if MathJax adds a range.
class PrintTexFont extends MathJaxTexFont {
  loadDynamicFile() {fail("This symbol requires an unavailable font extension.");}
  loadDynamicFileSync() {fail("This symbol requires an unavailable font extension.");}
}

/**
 * Typeset one bounded expression, independently of any saved Project or DOM.
 * ViewBox coordinates are MathJax's 1000 units/em; consumers place the detached
 * outlines at the saved point size and apply their closed SVG attribute policy.
 */
export function typesetPrintMath(source) {
  if (typeof source !== "string" || !source.trim() || source.length > MAX_SOURCE
    || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(source))
    fail("Use 1–4,000 characters of TeX without control characters.");
  try {
    // Both parser and document are fresh: definitions in one frame cannot
    // change another frame, a later export or a reopened layout.
    const input = new TeX({packages: ["base", "ams", "newcommand"], maxBuffer: 5000,
      maxMacros: 1000, maxTemplateSubtitutions: 1000, formatError: (_jax, error) => rethrow(error)});
    const output = new SVG({fontData: new PrintTexFont(), fontCache: "none",
      displayOverflow: "overflow", linebreaks: {inline: false}});
    const document = mathjax.document("", {InputJax: input, OutputJax: output,
      compileError: (_document, _math, error) => rethrow(error),
      typesetError: (_document, _math, error) => rethrow(error)});
    const container = document.convert(source, {display: true});
    const roots = adaptor.childNodes(container);
    if (roots.length !== 1 || adaptor.kind(roots[0]) !== "svg")
      fail("This expression has no supported vector layout.");
    const svgNode = roots[0];
    const viewBox = String(adaptor.getAttribute(svgNode, "viewBox") || "").trim().split(/\s+/).map(Number);
    if (viewBox.length !== 4 || !viewBox.every(value => Number.isFinite(value) && Math.abs(value) <= 1000000)
      || viewBox[2] <= 0 || viewBox[3] <= 0)
      fail("This expression exceeds the supported layout bounds.");
    let count = 0, paths = 0;
    const pending = [svgNode];
    while (pending.length) {
      const node = pending.pop(), kind = adaptor.kind(node);
      if (++count > MAX_NODES) fail("This expression exceeds the vector complexity limit.");
      if (!["svg", "g", "path", "rect"].includes(kind))
        fail("This expression contains an unsupported symbol or non-outline content.");
      if (kind === "path") paths++;
      if (adaptor.hasAttribute(node, "data-mjx-error") || adaptor.getAttribute(node, "data-mml-node") === "merror")
        fail("Correct this expression before output.");
      pending.push(...adaptor.childNodes(node));
    }
    if (!paths) fail("Add a supported visible mathematical symbol.");
    const svg = adaptor.outerHTML(svgNode);
    if (svg.length > MAX_SVG) fail("This expression exceeds the vector output limit.");
    return {svg, viewBox, widthEm: viewBox[2] / 1000, heightEm: viewBox[3] / 1000};
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : "This expression cannot be typeset.";
    if (message.startsWith("Print math:")) throw error;
    fail(message.slice(0, 240));
  }
}
