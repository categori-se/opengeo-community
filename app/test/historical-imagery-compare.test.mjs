import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {createHistoricalComparisonView, historicalComparisonIdentity} from "../src/lib/historicalComparisonView.js";
import {historicalImageryBasemap, historicalImageryForProject, historicalImageryForSave,
  normalizeHistoricalImagery} from "../src/lib/historicalImagery.js";

it("compares two saved dates with a native divider, shared camera and owned disposal", () => {
  const dom = new JSDOM('<div id="map"><div id="primary"></div></div>');
  const container = dom.window.document.querySelector("#map");
  const mainSurface = container.firstElementChild;
  const mainMap = new FixtureMap();
  const configuration = normalizeHistoricalImagery({enabled: true, compareMode: "swipe", compareDivider: 40,
    selection: {displayedDate: "2026-08-20"},
    comparison: {requestedDate: "2026-08-22", displayedDate: "2026-08-21", policy: "previous"}});
  const basemap = selection => historicalImageryBasemap({...configuration, selection});
  let options, comparison, creations = 0;
  const adapter = {
    createMap(value) { creations += 1; options = value; comparison = new FixtureMap(value); return comparison; },
    disposeMap(map) { if (map) map.removed = true; }
  };
  const view = createHistoricalComparisonView({container, mainSurface, mainMap, adapter,
    primaryBasemap: basemap(configuration.selection), comparisonBasemap: basemap(configuration.comparison),
    mode: configuration.compareMode, divider: configuration.compareDivider,
    onDividerChange: value => { configuration.compareDivider = value; }});
  try {
    const surface = container.querySelector(".gis-history-compare-surface");
    const range = container.querySelector('input[type="range"]');
    assert.equal(surface.style.clipPath, "inset(0 0 0 40%)");
    assert.equal(surface.inert, true);
    assert.equal(range.getAttribute("aria-label"), "Imagery swipe divider");
    assert.equal(range.getAttribute("aria-valuetext"), "40% A, 60% B");
    range.value = "65";
    range.dispatchEvent(new dom.window.Event("input"));
    assert.equal(configuration.compareDivider, 65);
    assert.equal(surface.style.clipPath, "inset(0 0 0 65%)");
    assert.match(container.textContent, /A: MODIS Terra true color · 2026-08-20/);
    assert.match(container.textContent, /B: MODIS Terra true color · 2026-08-21/);
    assert.match(container.textContent, /Requested 2026-08-22; adjusted-previous/);
    assert.equal(container.querySelectorAll(".gis-history-compare-labels span")[0].textContent,
      basemap(configuration.selection).attribution);
    assert.deepEqual(options.transformRequest("https://fixture.invalid/tile"),
      {url: "https://fixture.invalid/tile", credentials: "omit", referrerPolicy: "no-referrer"});
    assert.match(options.style.sources.imagery.tiles[0], /\/2026-08-21\//);
    assert.equal(Object.keys(options.style.sources).length, 1, "B owns only imagery");
    assert.equal(options.style.layers[0].type, "background");
    assert.equal(options.style.layers[0].paint["background-color"], "#061526", "B gaps never reveal A");
    const comparisonIdentity = historicalComparisonIdentity(configuration, false);
    configuration.selection = normalizeHistoricalImagery({selection: {displayedDate: "2026-08-23"}}).selection;
    view.update({mode: configuration.compareMode, divider: configuration.compareDivider,
      primaryBasemap: basemap(configuration.selection)});
    assert.equal(historicalComparisonIdentity(configuration, false), comparisonIdentity, "A date is not B map identity");
    assert.notEqual(historicalComparisonIdentity({...configuration, sourceRevision: "changed"}, false), comparisonIdentity);
    assert.notEqual(historicalComparisonIdentity(configuration, true), comparisonIdentity);
    assert.notEqual(historicalComparisonIdentity({...configuration, comparison: configuration.selection}, false), comparisonIdentity);
    assert.equal(creations, 1, "changing A updates its label without recreating B");
    assert.equal(comparison.removed, undefined);
    assert.match(container.textContent, /A: MODIS Terra true color · 2026-08-23/);
    assert.doesNotMatch(container.textContent, /A: MODIS Terra true color · 2026-08-20/);
    assert.match(container.textContent, /B: MODIS Terra true color · 2026-08-21/);
    const status = container.querySelector('[role="status"]');
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(status.getAttribute("aria-atomic"), "true");
    assert.match(container.textContent, /Loading B imagery/);
    comparison.emit("idle");
    assert.match(container.textContent, /B imagery ready/);
    mainMap.jumpTo({center: {lng: 85, lat: 28}, zoom: 7, bearing: 12, pitch: 20});
    assert.deepEqual(comparison.camera, mainMap.camera);
    configuration.compareMode = "side-by-side";
    view.update({mode: configuration.compareMode, divider: configuration.compareDivider});
    assert.equal(mainSurface.style.width, "50%");
    assert.equal(mainSurface.style.getPropertyPriority("width"), "important");
    assert.equal(surface.style.left, "50%");
    assert.equal(surface.style.clipPath, "none");
    assert.equal(surface.inert, false);
    assert.equal(range.parentElement.hidden, true);
    view.update({mode: "swipe", divider: 65});
    assert.equal(mainSurface.style.width, "100%");
    assert.equal(surface.style.left, "0px");
    assert.equal(range.parentElement.hidden, false);
    view.update({mode: "side-by-side", divider: 65});
    assert.equal(creations, 1, "presentation changes reuse the existing comparison map");
    comparison.jumpTo({center: {lng: 86, lat: 29}, zoom: 8, bearing: 2, pitch: 0});
    assert.deepEqual(mainMap.camera, comparison.camera);
    assert.ok(mainMap.jumps < 10, "camera feedback is bounded");
    comparison.emit("error");
    comparison.emit("idle");
    assert.match(container.textContent, /B imagery could not load/);
    for (const event of [{sourceId: "imagery", sourceDataType: "metadata"},
      {sourceId: "other", tile: {state: "loaded"}}, {sourceId: "imagery", tile: {state: "errored"}},
      {sourceId: "imagery", tile: {state: "loaded", aborted: true}}]) {
      comparison.emit("sourcedata", event);
      comparison.emit("idle");
      assert.match(status.textContent, /B imagery could not load/, "metadata, other sources and failed/aborted tiles do not prove recovery");
    }
    comparison.emit("sourcedata", {sourceId: "imagery", tile: {state: "loaded"}});
    comparison.emit("idle");
    assert.equal(status.textContent, "B imagery updated; previous tile errors may leave gaps.");
    assert.doesNotMatch(status.textContent, /ready/, "a successful tile cannot conceal other errors");
    comparison.emit("error");
    comparison.emit("idle");
    assert.match(status.textContent, /B imagery could not load/, "a later error requires another successful tile");
    const saved = historicalImageryForSave(configuration);
    const reopened = historicalImageryForProject({extensions: {historicalImagery: saved}});
    assert.deepEqual(reopened, configuration);
    assert.doesNotMatch(JSON.stringify(saved), /https?:\/\//);
    assert.equal(reopened.selection.displayedDate, "2026-08-23");
    assert.equal(reopened.comparison.displayedDate, "2026-08-21");
    assert.equal(reopened.compareMode, "side-by-side");
    assert.equal(reopened.compareDivider, 65);
  } finally {
    view.dispose();
    view.dispose();
    assert.equal(comparison.removed, true);
    assert.equal(mainMap.listeners.size, 0);
    assert.equal(comparison.listeners.size, 0);
    assert.equal(container.children.length, 1);
    assert.equal(mainSurface.style.width, "");
    dom.window.close();
  }
});

it("cleans a failed comparison constructor and preserves legacy state defaults", () => {
  const dom = new JSDOM('<div id="map"><div id="primary" style="width: 75% !important"></div></div>');
  const container = dom.window.document.querySelector("#map");
  const mainSurface = container.firstElementChild;
  const configuration = normalizeHistoricalImagery({selection: {displayedDate: "2026-08-20"}});
  const basemap = historicalImageryBasemap({...configuration, selection: configuration.selection});
  try {
    assert.throws(() => createHistoricalComparisonView({container, mainSurface, mainMap: new FixtureMap(),
      adapter: {createMap() { throw Error("graphics unavailable"); }, disposeMap() {}},
      primaryBasemap: basemap, comparisonBasemap: basemap, mode: "swipe"}), /graphics unavailable/);
    assert.equal(container.children.length, 1);
    assert.equal(mainSurface.style.width, "75%");
    assert.equal(mainSurface.style.getPropertyPriority("width"), "important");
    assert.equal(configuration.compareMode, "toggle");
    assert.equal(configuration.compareDivider, 50);
    assert.equal(normalizeHistoricalImagery({compareDivider: -100}).compareDivider, 0);
    assert.equal(normalizeHistoricalImagery({compareDivider: 500}).compareDivider, 100);
    assert.equal(normalizeHistoricalImagery({compareMode: "unsupported", compareDivider: "10"}).compareMode, "toggle");
    assert.equal(normalizeHistoricalImagery({compareDivider: "10"}).compareDivider, 50);
  } finally { dom.window.close(); }
});

class FixtureMap {
  listeners = new Map();
  camera = {center: {lng: 0, lat: 0}, zoom: 2, bearing: 0, pitch: 0};
  jumps = 0;
  constructor(options = {}) { for (const key of Object.keys(this.camera)) if (key in options) this.camera[key] = options[key]; }
  getCenter() { return this.camera.center; }
  getZoom() { return this.camera.zoom; }
  getBearing() { return this.camera.bearing; }
  getPitch() { return this.camera.pitch; }
  jumpTo(camera) { this.jumps += 1; this.camera = {...camera}; this.emit("move"); }
  resize() {}
  on(type, callback) { const callbacks = this.listeners.get(type) ?? new Set(); callbacks.add(callback); this.listeners.set(type, callbacks); }
  off(type, callback) { const callbacks = this.listeners.get(type); callbacks?.delete(callback); if (!callbacks?.size) this.listeners.delete(type); }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
}
