import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
const code = readFileSync(new URL("../src/assets/imagery-lab.js", import.meta.url), "utf8");
function context() {const dom = new JSDOM("<!doctype html>", {runScripts: "outside-only"}); dom.window.eval(code); return dom;}
function interactive() {
  const dom = context(), w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {get: (target, key) => target[key] ?? (() => {}), set: (target, key, value) => {target[key] = value; return true;}});
  const lab = w.document.createElement("opengeo-imagery-lab"); w.document.body.append(lab);
  const rect = () => ({left: 0, top: 0, width: 800, height: 400}); lab.map.getBoundingClientRect = rect; lab.canvas.getBoundingClientRect = rect;
  for (const el of [lab.canvas, lab.swipeHandle]) {let pointer; el.setPointerCapture = id => {pointer = id;}; el.hasPointerCapture = id => pointer === id; el.releasePointerCapture = () => {pointer = undefined;};}
  return {dom, w, lab};
}
test("comparison divider drags independently, both inputs persist, inspection is opt-in", () => {
  const {dom, w, lab} = interactive(); let inspected = 0; lab.inspect = () => inspected++;
  const before = [...lab.center], event = x => ({clientX: x, clientY: 200, pointerId: 1, button: 0, preventDefault() {}});
  lab.swipeHandle.onpointerdown(event(400)); lab.swipeHandle.onpointermove(event(600)); lab.swipeHandle.onpointerup(event(600));
  assert.equal(lab.swipe.value, "0.75"); assert.equal(lab.swipeHandle.getAttribute("aria-valuenow"), "75"); assert.deepEqual([...lab.center], before);
  lab.canvas.onpointerdown(event(200)); lab.canvas.onpointerup(event(200)); assert.equal(inspected, 0);
  lab.inspectEnabled.checked = true; lab.inspectEnabled.onchange(); lab.canvas.onpointerdown(event(200)); lab.canvas.onpointerup(event(200)); assert.equal(inspected, 1);
  const labels = [...lab.controls.querySelectorAll("label")];
  for (const [name, value] of [["Left image", "cir16"], ["Right image", "rgb16"]]) {const select = labels.find(l => l.textContent.startsWith(name)).querySelector("select"); select.value = value; select.onchange();}
  assert.equal(lab.state().left, "cir16"); assert.equal(lab.state().right, "rgb16");
  const saved = w.document.createElement("opengeo-imagery-lab"); saved.setAttribute("state", JSON.stringify(lab.state())); w.document.body.append(saved);
  assert.equal(saved.left, "cir16"); assert.equal(saved.right, "rgb16"); assert.equal(saved.controls.querySelectorAll("select")[1].value, "rgb16");
  dom.window.close();
});
test("map drag pans, wheel anchors zoom, double click and pinch zoom without inspection", () => {
  const {dom, w, lab} = interactive(), before = [...lab.center], span = lab.span;
  const event = (x, id = 1) => ({clientX: x, clientY: 200, pointerId: id, button: 0, preventDefault() {}});
  lab.canvas.onpointerdown(event(200)); lab.canvas.onpointermove(event(240)); assert.match(lab.canvas.style.transform, /translate/); lab.canvas.onpointerup(event(240));
  assert.equal(lab.center[0], before[0] - 40 / 800 * span); assert.equal(lab.canvas.style.transform, "");
  const center = [...lab.center]; lab.canvas.dispatchEvent(new w.WheelEvent("wheel", {clientX: 400, clientY: 200, deltaY: -100, cancelable: true}));
  assert.ok(lab.span < span); assert.deepEqual([...lab.center], center);
  const wheelSpan = lab.span; lab.canvas.ondblclick(event(400)); assert.equal(lab.span, wheelSpan / 2);
  const pinchSpan = lab.span; lab.canvas.onpointerdown(event(200, 1)); lab.canvas.onpointerdown(event(400, 2)); lab.canvas.onpointermove(event(600, 2)); lab.canvas.onpointerup(event(600, 2)); lab.canvas.onpointerup(event(200, 1));
  assert.equal(lab.span, pinchSpan / 2); dom.window.close();
});
test("NOAA lab arithmetic handles zero denominators and common-grid validation", () => {
  const dom = context(); const api = dom.window.OpenGeoImageryLab;
  assert.equal(api.ndvi(9, 3), .5); assert.ok(Number.isNaN(api.ndvi(0, 0)));
  const a = {bits: 8, width: 128, height: 128, scale: [1, 1, 0], tie: [0, 0, 0, 1, 2, 0]};
  assert.equal(api.paired(a, {...a, bits: 16}), true);
  assert.equal(api.paired(a, {...a, bits: 16, scale: [2, 1, 0]}), false);
  const p = api.unproject(...api.project(-72.09, 41.35)); assert.ok(Math.abs(p[0] + 72.09) < 1e-8); assert.ok(Math.abs(p[1] - 41.35) < 1e-8);
  assert.throws(() => api.decodeTiff(new ArrayBuffer(16)), /TIFF/);
  assert.throws(() => api.decodeTiff(new ArrayBuffer(2_000_001)), /size/); dom.window.close();
});
test("autoload is opt-in and bounded to two simultaneous experiments", async () => {
  const {dom, w, lab} = interactive(), pending = []; let active = 0, peak = 0, calls = 0;
  lab.constructor.prototype.refresh = function () {calls++; active++; peak = Math.max(peak, active); return new Promise(resolve => pending.push(() => {active--; resolve();}));};
  const labs = Array.from({length: 7}, () => {const el = w.document.createElement("opengeo-imagery-lab"); el.setAttribute("autoload", ""); w.document.body.append(el); return el;});
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(calls, 2); assert.equal(peak, 2);
  while (pending.length) {pending.shift()(); await new Promise(resolve => setTimeout(resolve, 0));}
  assert.equal(calls, 7); assert.equal(peak, 2); assert.ok(labs.every(l => l.started)); dom.window.close();
});
test("navigation retains georeferenced imagery and observation, debounces refresh, and blocks stale analysis", async () => {
  const {dom, lab} = interactive(); const image = {close() {throw Error("Navigation must not discard imagery");}};
  lab.started = true; lab.images = {rgb8: image}; lab.displayKeys = ["rgb8"]; lab.renderBounds = lab.bounds(); lab.renderState = JSON.parse(JSON.stringify(lab.state()));
  lab.provenance = {observedAt: "original", bounds: lab.bounds()};
  let refreshed = 0; lab.refresh = async () => {refreshed++;};
  lab.zoom(.8); lab.zoom(.8); assert.equal(lab.images.rgb8, image); assert.equal(lab.provenance.observedAt, "original");
  assert.notDeepEqual(lab.figureRecord().controls, lab.figureRecord().requestedControls); assert.match(lab.caption.textContent, /Previous NOAA view/);
  await lab.inspect(0, 0); assert.match(lab.inspector.textContent, /Wait for the refreshed/);
  await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(refreshed, 1);
  lab.interacting = true; lab.zoom(.8); await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(refreshed, 1);
  lab.images = {}; dom.window.close();
});
test("public component contains no archive, credential or authenticated API request path", () => {
  assert.doesNotMatch(code, /geospatial\.data|storage\.opengeo|localStorage|sessionStorage|document\.cookie|Authorization|\/api\//);
  assert.match(code, /credentials: "omit"/);
  assert.match(code, /esriMosaicLockRaster/);
  assert.match(code, /Mission =/);
  assert.match(code, /No archived imagery was substituted/);
});
test("failed NOAA refresh preserves the prior image and provenance without calling it fresh", async () => {
  const {dom, w, lab} = interactive(); w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  const image = {}; lab.images = {rgb8: image}; lab.displayKeys = ["rgb8"]; lab.renderBounds = lab.bounds(); lab.provenance = {observedAt: "original"};
  lab.resolve = async () => {throw Error("simulated outage");};
  await lab.refresh(); assert.equal(lab.images.rgb8, image); assert.equal(lab.provenance.observedAt, "original");
  assert.equal(lab.stale, true); assert.equal(lab.loading, false); assert.match(lab.status.textContent, /Previous NOAA view remains/);
  lab.images = {}; dom.window.close();
});
