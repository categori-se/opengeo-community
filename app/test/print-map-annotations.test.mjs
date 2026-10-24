import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout} from "../src/lib/printLayouts.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";

function scene() {
  const record = {id: "annotation-map", version: 3, name: "Dark map", definition: {layers: []}};
  const layout = newProjectPrintLayout(record, "annotations");
  layout.graticule = true;layout.sourceNotes = false;layout.legend = false;
  layout.frames.push({...structuredClone(layout.frames[0]), id: "inset", parentId: "main", xMm: 235, yMm: 128, widthMm: 50, heightMm: 40});
  const captures = new Map(layout.frames.map((frame, index) => {
    const view = structuredClone(frame.view), presentation = structuredClone(frame.presentation);
    const meridians = Array.from({length: 7}, (_, i) => ({label: `${(i - 3) * (index ? 10 : 5)}°`,
      points: [[0.025925925925926 + i * 0.158024691358025, 1 + 1e-14], [0.025925925925926 + i * 0.158024691358025, -1e-14]]}));
    const parallels = [-1, 0, 1].map(i => ({label: `${i * (index ? 10 : 5)}°`,
      points: Array.from({length: 14}, (_, j) => [j / 13 - 1e-14, 0.5 - i * 0.2599])}));
    return [`annotations:${frame.id}`, {view, presentation, signature: canonicalJson({view, presentation}),
      width: index ? 591 : 2539, height: index ? 361 : 1551, cssWidth: 720, cssHeight: 440,
      dataUrl: "data:image/png;base64,aW1hZ2U=", imageSha256: "a".repeat(64), flat: true,
      metresPerPixel: index ? 9773.005098740774 : 4886.5025492409, lines: [...meridians, ...parallels],
      legend: [], attribution: ["Original source credit"], sourceMetadata: [{title: "Local survey", license: "CC BY 4.0"}],
      projectId: record.id, projectVersion: record.version}];
  }));
  return {layout, captures};
}

function onPage(action) {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {action();} finally {globalThis.document = previous;dom.window.close();}
}

function bounds(node) {
  const size = Number(node.getAttribute("font-size")), width = node.textContent.length * size * 0.65;
  const anchor = node.getAttribute("text-anchor"), x = Number(node.getAttribute("x")), y = Number(node.getAttribute("y"));
  const left = x - (anchor === "middle" ? width / 2 : anchor === "end" ? width : 0);
  return {left: left - 0.4, right: left + width + 0.4, top: y - size - 0.4, bottom: y + 0.8};
}

test("map annotations retain all inset edge values with halos and separate measured scale endpoints", () => onPage(() => {
  const {layout, captures} = scene(), before = JSON.stringify({layout, captures: [...captures]});
  const page = printPageSvg(layout, captures, layout.id);
  const labels = [...page.querySelectorAll("[data-print-grid-label]")];
  assert.equal(labels.length, 20);assert.equal(page.querySelector("[data-print-grid-notice]"), null);
  for (const node of page.querySelectorAll("[data-print-grid-label], [data-print-north-label], [data-print-scale-label]")) {
    assert.equal(node.getAttribute("fill"), "#17212b");assert.equal(node.getAttribute("stroke"), "white");
    assert.equal(node.getAttribute("stroke-width"), "0.65");assert.equal(node.getAttribute("paint-order"), "stroke fill");
  }
  for (const group of page.querySelectorAll('g[clip-path]')) {
    const grid = [...group.querySelectorAll("[data-print-grid-label]")];
    for (let i = 0; i < grid.length; i++) for (const other of grid.slice(i + 1)) {
      const a = bounds(grid[i]), b = bounds(other);
      assert.ok(a.left >= b.right || a.right <= b.left || a.top >= b.bottom || a.bottom <= b.top, `${grid[i].textContent} overlaps ${other.textContent}`);
    }
  }
  const inset = page.querySelectorAll('g[clip-path]')[1];
  assert.notEqual(inset.querySelector('[data-print-grid-label="20°"]').getAttribute("x"), inset.querySelector('[data-print-grid-label="30°"]').getAttribute("x"));
  const bars = [...page.querySelectorAll('[data-print-scale-bar="full"]')];
  assert.ok(Math.abs(Number(bars[0].getAttribute("width")) - 30.554686926081644) < 1e-10);
  assert.ok(Math.abs(Number(bars[1].getAttribute("width")) - 7.105741145412087) < 1e-10);
  for (const [index, bar] of bars.entries()) {
    const start = page.querySelectorAll('[data-print-scale-label="start"]')[index], end = page.querySelectorAll('[data-print-scale-label="end"]')[index];
    const casing = page.querySelectorAll('[data-print-scale-bar="casing"]')[index];
    assert.equal(start.textContent, "0");assert.equal(start.getAttribute("text-anchor"), "end");
    assert.equal(Number(end.getAttribute("x")), Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")));
    assert.equal(end.textContent, index ? "1000 km" : "500 km");
    assert.equal(casing.getAttribute("width"), bar.getAttribute("width"));assert.equal(casing.getAttribute("stroke"), "white");
  }
  for (const node of [...page.querySelectorAll("text")].filter(node => /source credit|CC BY|Dark map/.test(node.textContent))) assert.equal(node.hasAttribute("stroke"), false);
  assert.equal(JSON.stringify({layout, captures: [...captures]}), before);
  assert.equal(page.outerHTML, printPageSvg(layout, captures, layout.id).outerHTML);
}));

test("crowded map grids retain literal omitted values and visible enlargement guidance", () => onPage(() => {
  const {layout, captures} = scene();layout.frames = [layout.frames[1]];layout.northArrow = false;layout.scaleBar = false;
  const captured = captures.get("annotations:inset");
  captured.lines = Array.from({length: 60}, (_, i) => ({label: `${i}°`, points: [[i / 59, 1], [i / 59, 0]]}));
  const page = printPageSvg(layout, captures, layout.id), paths = [...page.querySelectorAll("[data-print-grid-value]")];
  assert.equal(paths.length, 60);assert.ok(page.querySelectorAll("[data-print-grid-label]").length < paths.length);
  assert.deepEqual(paths.map(node => node.querySelector("title").textContent), captured.lines.map(line => line.label));
  assert.match([...page.querySelectorAll("[data-print-grid-notice]")].map(node => node.textContent).join(" "), /Grid labels omitted; enlarge frame\./);
  assert.equal(page.outerHTML, printPageSvg(layout, captures, layout.id).outerHTML);
}));

test("narrow map scale notes fit inside the captured image without changing metre distances", () => onPage(() => {
  const {layout, captures} = scene();layout.frames = [layout.frames[0]];layout.northArrow = false;layout.graticule = false;
  Object.assign(layout.frames[0], {widthMm: 18, heightMm: 30});captures.get("annotations:main").metresPerPixel = 1;
  const page = printPageSvg(layout, captures, layout.id), image = page.querySelector("image");
  const left = Number(image.getAttribute("x")), right = left + Number(image.getAttribute("width"));
  for (const node of page.querySelectorAll("[data-print-scale-label]")) {
    const box = bounds(node);assert.ok(box.left >= left && box.right <= right);
  }
  assert.equal(page.querySelector('[data-print-scale-label="end"]').textContent, "100 m");
  assert.equal(page.querySelector('[data-print-scale-label="note"]').textContent, "at map center");
  assert.equal(Number(page.querySelector('[data-print-scale-bar="full"]').getAttribute("width")), 2.5);
}));
