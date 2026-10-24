import test from "node:test";
import assert from "node:assert/strict";
import {typesetPrintMath} from "../src/lib/printMathRuntime.js";

const paths = result => (result.svg.match(/<path\b/g) || []).length;
function outlines(source) {
  const result = typesetPrintMath(source);
  assert.ok(result.widthEm > 0 && result.heightEm > 0);
  assert.equal(result.widthEm, result.viewBox[2] / 1000);
  assert.equal(result.heightEm, result.viewBox[3] / 1000);
  assert.ok(result.viewBox.every(Number.isFinite));
  assert.ok(paths(result) > 0);
  assert.doesNotMatch(result.svg, /<(?:text|use|image|foreignObject|script|style)\b|(?:href|src)=|url\(/i);
  return result;
}

test("real TeX fractions and superscripts have bounded vector layout", () => {
  const ordinary = outlines("ab");
  const fraction = outlines(String.raw`\frac{a^2}{b}`);
  assert.ok(fraction.heightEm > ordinary.heightEm * 1.5);
  assert.ok(paths(fraction) >= 3);
  assert.match(fraction.svg, /<rect\b/); // The fraction rule is genuine layout.
});

test("Greek, roots, sums and AMS matrices use actual glyph outlines", () => {
  const root = outlines(String.raw`\sqrt{\alpha^2+\beta^2}`);
  assert.ok(paths(root) >= 6);
  const matrix = outlines(String.raw`\sum_{i=1}^{n} x_i=\begin{pmatrix}a&b\\c&d\end{pmatrix}`);
  assert.ok(paths(matrix) >= 12);
  assert.ok(matrix.heightEm > root.heightEm);
});

test("each expression isolates user-defined TeX macros", () => {
  outlines(String.raw`\newcommand{\localmath}{x^2}\localmath`);
  assert.throws(() => typesetPrintMath(String.raw`\localmath`), /Print math/i);
  const before = outlines("x");
  outlines(String.raw`\def\x{y}\x`);
  assert.deepEqual(outlines("x"), before);
});

test("malformed, unknown and remote-capable commands refuse instead of becoming text", () => {
  for (const source of [
    String.raw`\frac{1}{`, String.raw`\unknowncommand{x}`,
    String.raw`\href{https://example.invalid}{x}`, String.raw`\htmlClass{remote}{x}`,
    String.raw`\require{html}`, String.raw`\input{https://example.invalid/tex}`,
    String.raw`\includegraphics{https://example.invalid/image.svg}`,
    String.raw`\def\loop{\loop}\loop`
  ]) assert.throws(() => typesetPrintMath(source), /Print math/i, source);
});

test("input and output bounds reject empty, controlled, excessive or unsupported content", () => {
  for (const source of ["", "  \n ", null, {}, "x\u0000", "x".repeat(4001),
    String.raw`\rule{1000000em}{1em}`, "🙂"])
    assert.throws(() => typesetPrintMath(source), /Print math/i);
});
