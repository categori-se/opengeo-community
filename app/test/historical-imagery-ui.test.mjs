import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {HISTORICAL_IMAGERY_SCHEMA_VERSION, historicalImageryBasemap, normalizeHistoricalImagery} from "../src/lib/historicalImagery.js";
import {OPEN_TERRAIN_SOURCE} from "../src/lib/terrainView.js";

let harness;

beforeEach(() => harness = installDom());

afterEach(async () => {
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("historical imagery workbench experience", () => {
  it("keeps direct map actions compact with Query and imagery history in menus", () => {
    const shell = mountWorkbench();
    const labels = [...shell.querySelectorAll(".gis-primary-toolbar .gis-primary-command")].map((button) => button.textContent.trim());
    assert.deepEqual(labels, ["Open file", "Add data", "Point", "Path", "Polygon", "Fit", "Identify"]);
    clickButton(shell.querySelector('.gis-menu-wrap[data-menu="controls"]'), "Controls");
    assert.ok(clickableButton(shell.querySelector('.gis-menu-wrap[data-menu="controls"]'), "Imagery history"));
    clickButton(shell.querySelector('.gis-menu-wrap[data-menu="layer"]'), "Layer");
    clickButton(shell.querySelector('.gis-menu-wrap[data-menu="layer"]'), "Query features…");
    assert.ok(shell.querySelector(".gis-panel-right .gis-query-panel"));
  });

  it("explains date meaning and exposes bounded timeline, comparison, and sunlight controls", () => {
    const shell = mountWorkbench({initialPanel: "history"});
    for (const text of [
      "Imagery timeline",
      "MODIS Terra true color",
      "Require the exact date",
      "Previous",
      "View date",
      "Next",
      "Play",
      "Refresh provider dates",
      "Before and after",
      "Set B",
      "Show sunlight guide",
      "provider time-domain dates",
      "Spatial pixel availability is not confirmed"
    ]) assert.match(shell.textContent, new RegExp(text, "i"));
    assert.equal(shell.querySelectorAll(".gis-panel-right .gis-history-panel").length, 1);
    assert.equal(shell.querySelector(".gis-history-panel").dataset.imageryActive, "false");
    assert.match(shell.querySelector(".gis-history-panel").textContent, /No historical imagery is active/);
    assert.doesNotMatch(shell.querySelector(".gis-history-panel").textContent, /Displayed date/);
  });

  it("selects an exact reviewed date and persists source identity without a provider URL", async () => {
    const saved = [];
    const shell = mountWorkbench({
      initialPanel: "history",
      saveProject: async (definition) => {
        saved.push(structuredClone(definition));
        return {version: 2, updatedAt: "2026-08-30T00:00:00Z"};
      }
    });
    const date = shell.querySelector('.gis-history-panel input[type="date"]');
    date.value = "2026-08-20";
    date.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    clickButton(shell, "View date");
    assert.equal(shell.querySelector(".gis-history-panel").dataset.imageryActive, "true");
    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);

    const extension = saved[0].extensions.historicalImagery;
    assert.equal(extension.schemaVersion, HISTORICAL_IMAGERY_SCHEMA_VERSION);
    assert.equal(extension.enabled, true);
    assert.equal(extension.selection.displayedDate, "2026-08-20");
    assert.match(extension.sourceId, /^nasa-gibs-/);
    assert.equal(saved[0].basemaps[0].kind, "temporal-raster");
    assert.equal(saved[0].basemaps[0].selection.displayedDate, "2026-08-20");
    assert.doesNotMatch(JSON.stringify(extension), /https?:\/\//);
    assert.equal(saved[0].schemaVersion, "opengeo.map-definition.1.3.0");
  });

  it("previews a snapped date while dragging and keeps the timeline ahead of source details", () => {
    const shell = mountWorkbench({initialPanel: "history"});
    const panel = shell.querySelector(".gis-history-panel");
    const range = panel.querySelector('input[type="range"]');
    range.value = "0";
    range.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    const readout = panel.querySelector(".gis-history-selected-date");
    assert.equal(readout.textContent, range.getAttribute("aria-valuetext"));
    assert.equal(panel.querySelector('input[type="date"]').value, readout.textContent);
    assert.equal(panel.dataset.imageryActive, "false", "Preview must not claim the basemap has changed");
    assert.equal(panel.querySelectorAll(".gis-history-date-ticks span").length, Number(range.max) + 1);
    const details = [...panel.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Source and date details");
    assert.equal(details.open, false);
    assert.ok(readout.compareDocumentPosition(details) & harness.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const date = panel.querySelector('input[type="date"]');
    date.value = "2000-01-01";
    date.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(date.value, date.min);
    assert.match(readout.textContent, /nearest available to 2000-01-01/);
  });

  it("preserves an uncommitted B date through background rendering without saving it as applied imagery", () => {
    const shell = mountWorkbench({initialPanel: "history"});
    const dateInput = () => shell.querySelectorAll('.gis-history-panel input[type="date"]')[1];
    const typeComparison = value => {
      dateInput().value = value;
      dateInput().dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    };
    const renderInBackground = () => {
      const previousInput = dateInput();
      // Map idle and this event both invoke the full Workbench render path.
      shell.dispatchEvent(new harness.dom.window.Event("workbench:render"));
      assert.equal(previousInput.isConnected, false, "exercise replacement of the inspector, not a retained input");
    };
    clickButton(shell, "View date");
    typeComparison("2026-08-21");
    renderInBackground();
    assert.equal(dateInput().value, "2026-08-21");
    assert.equal(shell.getPrintContext().project.extensions.historicalImagery.comparison, null);
    clickButton(shell, "Set B");
    assert.equal(shell.getPrintContext().project.extensions.historicalImagery.comparison.displayedDate, "2026-08-21");
    assert.equal(dateInput().value, "2026-08-21");
    typeComparison("2026-08-22");
    renderInBackground();
    assert.equal(dateInput().value, "2026-08-22");
    const saved = shell.getPrintContext().project.extensions.historicalImagery;
    assert.equal(saved.comparison.displayedDate, "2026-08-21", "editing the draft does not change B's applied identity");
    assert.doesNotMatch(JSON.stringify(saved), /Draft|2026-08-22/);
    const source = shell.querySelector('.gis-history-panel select');
    source.value = "nasa-gibs-hls-l30-nbar";
    source.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(dateInput().value, dateInput().min, "a deliberate source change resets the previous source's draft");
  });

  it("reflects toggle state in accessible map controls", () => {
    const shell = mountWorkbench();
    shell.querySelector(".gis-controls-command").click();
    for (const mode of ["globe", "terrainEnabled", "openScene3dEnabled", "graticule", "rightOpen"]) {
      assert.match(shell.querySelector(`[data-map-mode="${mode}"]`).getAttribute("aria-pressed"), /^(true|false)$/);
    }
    const before = shell.querySelector('[data-map-mode="graticule"]').getAttribute("aria-pressed");
    shell.querySelector('[data-map-mode="graticule"]').click();
    assert.notEqual(shell.querySelector('[data-map-mode="graticule"]').getAttribute("aria-pressed"), before);
  });

  it("creates and reuses the imagery B map when choosing swipe and side-by-side from Workbench", async () => {
    const maps = [];
    const frames = new Map();
    let frameId = 0;
    globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    const shell = mountWorkbench({initialPanel: "history", rendererAdapter: {
      id: "maplibre", initialize() {}, registerProtocol() {},
      createMap(options) { const map = new HistoryFixtureMap(options); maps.push(map); return map; },
      disposeMap(map) { if (map) map.removed = true; }
    }});
    try {
      await waitFor(() => shell.__opengeoMap && maps[0].listeners.has("click"));
      clickButton(shell, "View date");
      const comparisonDate = shell.querySelectorAll('.gis-history-panel input[type="date"]')[1];
      comparisonDate.value = "2026-08-21";
      comparisonDate.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
      clickButton(shell, "Set B");
      assert.equal(shell.getPrintContext().project.extensions.historicalImagery.compareShowing, "comparison");
      const chooseMode = value => {
        const field = [...shell.querySelectorAll('.gis-history-panel select')]
          .find(select => [...select.options].some(option => option.value === "side-by-side"));
        field.value = value;
        field.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
      };
      chooseMode("swipe");
      assert.equal(shell.getPrintContext().project.extensions.historicalImagery.compareShowing, "primary");
      assert.equal(maps.length, 2, "Workbench creates B's renderer instead of only changing the comparison setting");
      assert.ok(shell.querySelector(".gis-history-compare-surface"), JSON.stringify(maps.map(map => map.eventError)));
      assert.equal(shell.querySelector(".gis-history-compare-surface").inert, true);
      chooseMode("side-by-side");
      assert.equal(maps.length, 2, "presentation switches reuse the existing B renderer");
      assert.equal(shell.querySelector(".gis-history-compare-surface").inert, false);
      assert.equal(shell.__opengeoMap, maps[0], "A remains the Project composition map");
      chooseMode("toggle");
      assert.equal(shell.querySelector(".gis-history-compare-surface"), null);
      assert.equal(maps[1].removed, true);
    } finally { shell.dispose(); }
  });

  it("installs saved imagery before terrain makes the initial style busy without changing camera or source pins", async () => {
    const history = normalizeHistoricalImagery({enabled: true,
      selection: {requestedDate: "2026-08-20", displayedDate: "2026-08-20", policy: "exact"}});
    const imagery = {...historicalImageryBasemap(history), visible: true, opacity: 0.37};
    const view = {id: "primary", title: "Saved view", center: [-71.06, 42.36], zoom: 14, pitch: 45, bearing: 20};
    let map;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    const shell = mountWorkbench({project: {projection: "globe", terrain: {enabled: true, exaggeration: 1.5},
      mapViews: [view], basemaps: [imagery], extensions: {historicalImagery: history}}, rendererAdapter: {
      id: "maplibre", initialize() {}, registerProtocol() {},
      createMap(options) { map = new TerrainLoadingFixtureMap(options); return map; },
      disposeMap() {}
    }});
    try {
      await waitFor(() => map?.listeners.has("load"));
      const camera = structuredClone(map.camera);
      map.emit("load");
      assert.ok(map.getSource("basemap"), "The saved imagery must not be skipped while DEM tiles load");
      assert.deepEqual(map.getSource("basemap").tiles, [imagery.url]);
      assert.equal(map.getLayer("basemap").paint["raster-opacity"], 0.37);
      assert.ok(map.style.layers.findIndex(layer => layer.id === "basemap")
        < map.style.layers.findIndex(layer => layer.id === "retained-labels"));
      assert.ok(map.sourceAdds.indexOf("basemap") < map.sourceAdds.indexOf(OPEN_TERRAIN_SOURCE.sourceId));
      assert.equal(map.isStyleLoaded(), false, "Exercise the pending DEM readiness condition");
      assert.deepEqual(map.getTerrain(), {source: OPEN_TERRAIN_SOURCE.sourceId, exaggeration: 1.5});
      assert.deepEqual(map.camera, camera);
      const saved = shell.getPrintContext().project;
      assert.equal(saved.projection, "globe");
      assert.deepEqual(saved.mapViews[0].center, view.center);
      assert.deepEqual(saved.extensions.historicalImagery, history);
      assert.equal(saved.basemaps.find(basemap => basemap.visible).basemapId, imagery.basemapId);
      assert.equal(saved.terrain.sourceId, OPEN_TERRAIN_SOURCE.sourceId);
      assert.equal(saved.terrain.exaggeration, 1.5);
    } finally { shell.dispose(); }
  });

  it("recovers terrain from native ready-source events while saved imagery remains busy", async () => {
    const history = normalizeHistoricalImagery({enabled: true,
      selection: {requestedDate: "2026-08-20", displayedDate: "2026-08-20", policy: "exact"}});
    const imagery = {...historicalImageryBasemap(history), visible: true, opacity: 0.37};
    let map;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    const shell = mountWorkbench({project: {projection: "globe", terrain: {enabled: true, exaggeration: 1.5},
      basemaps: [imagery], extensions: {historicalImagery: history}}, rendererAdapter: {
      id: "maplibre", initialize() {}, registerProtocol() {},
      createMap(options) { map = new TerrainLoadingFixtureMap(options); return map; },
      disposeMap() {}
    }});
    const originalNow = Date.now;
    let now = originalNow();
    try {
      await waitFor(() => map?.listeners.has("load"));
      map.emit("load");
      shell.querySelector(".gis-controls-command").click();
      const camera = structuredClone(map.camera);
      Date.now = () => now;
      const sourceId = OPEN_TERRAIN_SOURCE.sourceId;
      // MapLibre 6.4.1 emits loaded tiles without sourceDataType; they can
      // establish DEM success independently of an unfinished raster.
      const readyEvents = [
        {sourceId, isSourceLoaded: true, coord: {canonical: {z: 1, x: 0, y: 0}}, tile: {state: "loaded"}},
        {sourceId, isSourceLoaded: true, sourceDataType: "content"}
      ];
      for (const ready of readyEvents) {
        for (let index = 0; index < 3; index += 1) map.emit("error", {sourceId});
        assert.equal(shell.dataset.terrain, "disabled");
        assert.equal(shell.dataset.terrainOutage, "open", "Three failures must still open the circuit");
        now += 61_000;
        const retry = shell.querySelector('[data-map-mode="terrainEnabled"]');
        assert.equal(retry.getAttribute("aria-label"), "Retry 3D terrain");
        retry.click();
        assert.equal(shell.dataset.terrain, "enabled");
        assert.equal(shell.dataset.terrainOutage, "half-open");
        for (const unrelated of [
          {sourceId, isSourceLoaded: true, sourceDataType: "idle"},
          {sourceId, isSourceLoaded: true, sourceDataType: "idle", coord: {}, tile: {state: "errored"}},
          {sourceId, isSourceLoaded: true, sourceDataType: "metadata"},
          {sourceId, isSourceLoaded: true, sourceDataType: "visibility"},
          {sourceId, isSourceLoaded: false, sourceDataType: "content"},
          {sourceId: "basemap", isSourceLoaded: true, sourceDataType: "content"},
          {sourceId, isSourceLoaded: true, coord: {}, tile: {state: "loading"}},
          {sourceId, isSourceLoaded: true, tile: {state: "loaded"}}
        ]) {
          map.emit("sourcedata", unrelated);
          assert.equal(shell.dataset.terrainOutage, "half-open", "Only ready DEM data may complete recovery");
        }
        map.emit("sourcedata", ready);
        assert.equal(shell.dataset.terrainOutage, "closed", "Ready DEM must recover without global map idle");
        assert.equal(map.isStyleLoaded(), false, "The independent imagery load remains unsettled");
        assert.deepEqual(map.camera, camera);
        assert.equal(map.getLayer("basemap").paint["raster-opacity"], 0.37);
        assert.deepEqual(map.getSource("basemap").tiles, [imagery.url]);
        assert.deepEqual(map.getTerrain(), {source: sourceId, exaggeration: 1.5});
      }
    } finally { Date.now = originalNow; shell.dispose(); }
  });

  it("keeps the complete history route in the compact Actions sheet", () => {
    harness.media.matches = true;
    const shell = mountWorkbench({initialPanel: null});
    clickButton(shell, "Actions");
    assert.ok(clickableButton(shell, "Imagery history"));
    assert.ok(clickableButton(shell, "Point"));
    assert.ok(clickableButton(shell, "Path"));
    assert.ok(clickableButton(shell, "Polygon"));
    assert.ok(clickableButton(shell, "Overlay"));
  });
});

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Historical imagery", classification: "internal"},
    role: "owner",
    project: {
      projectId: "51000000-0000-4000-8000-000000000001",
      title: "Historical imagery",
      updatedAt: "2026-08-30T00:00:00Z",
      mapViews: []
    },
    layers: [],
    datasets: [],
    storage: memoryStorage(),
    persistenceMode: "api",
    ...overrides
  });
  harness.dom.window.document.body.append(shell);
  harness.shell = shell;
  return shell;
}

function clickButton(root, text) {
  clickableButton(root, text).click();
}

function clickableButton(root, text) {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected button ${JSON.stringify(text)}`);
  return button;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for historical imagery UI state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=historical-imagery"
  });
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    DOMParser: dom.window.DOMParser,
    File: dom.window.File,
    localStorage: dom.window.localStorage,
    matchMedia: () => media,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    media,
    shell: null,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

function memoryStorage() {
  return {
    provider: "s3",
    bucket: "opengeo-test",
    rootPrefix: "tenants/test/projects",
    immutableInputsPrefix: "inputs",
    scratchPrefix: "scratch",
    outputPrefix: "outputs"
  };
}

class HistoryFixtureMap {
  listeners = new Map();
  constructor(options) {
    this.container = options.container;
    this.camera = {center: {lng: options.center?.[0] ?? options.center?.lng ?? 0,
      lat: options.center?.[1] ?? options.center?.lat ?? 0}, zoom: options.zoom, bearing: options.bearing, pitch: options.pitch};
    this.style = options.style;
  }
  getCenter() { return this.camera.center; }
  getContainer() { return this.container; }
  getZoom() { return this.camera.zoom; }
  getBearing() { return this.camera.bearing; }
  getPitch() { return this.camera.pitch; }
  getLayer() { return null; }
  getSource() { return null; }
  getStyle() { return this.style; }
  isStyleLoaded() { return false; }
  setStyle(style) { this.style = style; }
  resize() {
    // Match native MapLibre resize movement events, including unchanged size.
    for (const type of ["movestart", "move", "resize", "moveend"]) this.emit(type);
  }
  jumpTo(camera) { this.camera = {...camera}; this.emit("move"); this.emit("moveend"); }
  on(type, callback) { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(callback); this.listeners.set(type, listeners); }
  off(type, callback) { const listeners = this.listeners.get(type); listeners?.delete(callback); if (!listeners?.size) this.listeners.delete(type); }
  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) {
      try { callback(event); }
      catch (error) { this.eventError = `${type}: ${error.message}`; throw error; }
    }
  }
}

class TerrainLoadingFixtureMap extends HistoryFixtureMap {
  sources = new Map();
  sourceAdds = [];
  ready = true;
  terrain = null;
  constructor(options) {
    super(options);
    this.style.layers.push({id: "retained-labels", type: "symbol", paint: {"text-opacity": 1}});
  }
  isStyleLoaded() { return this.ready; }
  getSource(id) { return this.sources.get(id); }
  addSource(id, source) {
    this.sources.set(id, source); this.sourceAdds.push(id);
    if (source.type === "raster-dem") this.ready = false;
  }
  removeSource(id) { this.sources.delete(id); }
  getLayer(id) { return this.style.layers.find(layer => layer.id === id); }
  addLayer(layer, before) {
    const index = this.style.layers.findIndex(item => item.id === before);
    this.style.layers.splice(index < 0 ? this.style.layers.length : index, 0, layer);
  }
  removeLayer(id) { this.style.layers = this.style.layers.filter(layer => layer.id !== id); }
  setPaintProperty(id, property, value) { this.getLayer(id).paint[property] = value; }
  setProjection(projection) { this.projection = projection; }
  getProjection() { return this.projection; }
  setTerrain(terrain) { this.terrain = terrain; }
  getTerrain() { return this.terrain; }
}
