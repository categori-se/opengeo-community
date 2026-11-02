import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView, applyCameraTourFrame} from "../src/components/WorkbenchView.js";
import {syncFeatureHalo} from "../src/lib/featureHalo.js";
import {CAMERA_TOUR_SCHEMA_VERSION, CAMERA_TOUR_LAYER_SCHEMA_VERSION} from "../src/lib/cameraTour.js";

let harness;

beforeEach(() => harness = installDom());

afterEach(async () => {
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("camera tour workbench experience", () => {
  it("ignores late KML reads after newer KML, native JSON or cancellation and rejects detached Apply controls", async () => {
    const shell = mountWorkbench({initialPanel: "tour"});clickButton(shell, "Start camera tour");
    const source = name => `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><gx:Tour><name>${name}</name><gx:Playlist><gx:FlyTo><LookAt><range>100000</range></LookAt></gx:FlyTo></gx:Playlist></gx:Tour></kml>`;
    const open = (input, read) => {
      Object.defineProperty(input, "files", {configurable: true, value: [{size: 1000, text: read}]});
      input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    };
    const flush = async () => {await Promise.resolve();await Promise.resolve();};
    let resolveOld;
    open(shell.querySelector('[aria-label="Open KML tour"]'), () => new Promise(resolve => {resolveOld = resolve;}));
    open(shell.querySelector('[aria-label="Open KML tour"]'), async () => source("Newest"));await flush();
    const detachedApply = clickableButton(shell, "Use imported camera tour");
    resolveOld(source("Old"));await flush();
    detachedApply.click();assert.equal(shell.querySelector('input[aria-label="Tour name"]').value, "Newest");
    open(shell.querySelector('[aria-label="Open KML tour"]'), async () => source("Staged"));await flush();
    const staleApply = clickableButton(shell, "Use imported camera tour");
    let rejectLate;
    open(shell.querySelector('[aria-label="Open KML tour"]'), () => new Promise((_resolve, reject) => {rejectLate = reject;}));
    const native = structuredClone(shell.getPrintContext().project.extensions.cameraTour);native.title = "Native wins";
    open(shell.querySelector('input[accept*=".opengeo-tour.json"]'), async () => JSON.stringify(native));await flush();
    staleApply.click();rejectLate(Error("late failure"));await flush();
    assert.equal(shell.querySelector('input[aria-label="Tour name"]').value, "Native wins");
    assert.equal(shell.querySelector('[data-camera-tour-exchange-report]'), null);
    open(shell.querySelector('[aria-label="Open KML tour"]'), async () => source("Cancelable"));await flush();
    let resolveCanceled;
    open(shell.querySelector('[aria-label="Open KML tour"]'), () => new Promise(resolve => {resolveCanceled = resolve;}));
    clickButton(shell, "Cancel KML tour import");resolveCanceled(source("Canceled read"));await flush();
    assert.equal(shell.querySelector('[data-camera-tour-exchange-report]'), null);
    assert.equal(shell.querySelector('input[aria-label="Tour name"]').value, "Native wins");
  });

  it("reviews KML losses before applying, exports through controls and saves/freshly reopens the converted tour", async () => {
    const saved = [], downloads = [];
    const mount = overrides => mountWorkbench({initialPanel: "tour", saveProject: async definition => {saved.push(structuredClone(definition));return {version: 2};}, ...overrides});
    let shell = mount();clickButton(shell, "Start camera tour");
    const original = structuredClone(shell.getPrintContext().project.extensions.cameraTour);
    const source = '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><gx:Tour><name>Imported route</name><gx:Playlist><gx:FlyTo><gx:duration>0</gx:duration><LookAt><longitude>12</longitude><latitude>40</latitude><range>100000</range></LookAt></gx:FlyTo><gx:Wait><gx:duration>2</gx:duration></gx:Wait><gx:SoundCue><href>https://example.invalid/audio.mp3</href></gx:SoundCue></gx:Playlist></gx:Tour></Document></kml>';
    const input = shell.querySelector('[aria-label="Open KML tour"]');
    Object.defineProperty(input, "files", {value: [{size: source.length, text: async () => source}]});
    input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => shell.querySelector('[data-camera-tour-exchange-report]'));
    assert.match(shell.querySelector('[data-camera-tour-exchange-report]').textContent, /SoundCue/);
    assert.deepEqual(shell.getPrintContext().project.extensions.cameraTour, original, "review does not replace the native tour");
    clickButton(shell, "Use imported camera tour");
    assert.equal(shell.querySelector('input[aria-label="Tour name"]').value, "Imported route");
    clickButton(shell, "Save");await waitFor(() => saved.length === 1);
    const retained = saved[0].extensions.cameraTour;
    assert.deepEqual(retained.keyframes[0].camera.center, [12, 40]);assert.equal(retained.keyframes[0].holdMilliseconds, 2000);
    shell.dispose();shell.remove();shell = mount({project: project(saved[0])});
    assert.equal(shell.querySelector('input[aria-label="Tour name"]').value, "Imported route");
    assert.deepEqual(shell.getPrintContext().project.extensions.cameraTour, retained);
    clickButton(shell, "Prepare KML tour export");
    assert.match(shell.querySelector('[data-camera-tour-exchange-report]').textContent, /framing|Framing/);
    const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, oldClick = harness.dom.window.HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => {downloads.push({blob});return "blob:tour-export";};URL.revokeObjectURL = () => {};
    harness.dom.window.HTMLAnchorElement.prototype.click = function () {downloads.at(-1).name = this.download;};
    try {
      clickButton(shell, "Download KML tour");clickButton(shell, "Download KML conversion report");clickButton(shell, "Download tour JSON");
      assert.match(await downloads[0].blob.text(), /<gx:Tour>/);
      assert.ok(JSON.parse(await downloads[1].blob.text()).entries.some(entry => entry.code === "native_metadata_omitted"));
      assert.deepEqual(JSON.parse(await downloads[2].blob.text()), retained);
    } finally {URL.createObjectURL = oldCreate;URL.revokeObjectURL = oldRevoke;harness.dom.window.HTMLAnchorElement.prototype.click = oldClick;}
  });

  it("creates, times, and saves a bounded tour without changing the map-definition schema", async () => {
    const saved = [];
    const shell = mountWorkbench({
      initialPanel: "tour",
      saveProject: async (definition) => {
        saved.push(structuredClone(definition));
        return {version: 2, updatedAt: "2026-08-30T18:00:00Z"};
      }
    });
    assert.match(shell.textContent, /Camera tour/);
    assert.match(shell.textContent, /silent visual tour/);
    assert.match(shell.textContent, /KML gx:Tour exchanges camera views and waits/);

    clickButton(shell, "Start camera tour");
    clickButton(shell, "Add current view");
    const editor = shell.querySelector('[data-camera-tour-editor="view-2"]');
    assert.ok(editor);
    const [transition, hold] = editor.querySelectorAll('input[type="number"]');
    transition.value = "2.5";
    hold.value = "0.5";
    clickButton(editor, "Apply timing");
    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);

    const tour = saved[0].extensions.cameraTour;
    assert.equal(tour.schemaVersion, CAMERA_TOUR_SCHEMA_VERSION);
    assert.equal(tour.keyframes.length, 2);
    assert.equal(tour.keyframes[1].transitionMilliseconds, 2_500);
    assert.equal(tour.keyframes[1].holdMilliseconds, 500);
    assert.equal(saved[0].schemaVersion, "opengeo.map-definition.1.3.0");
  });

  it("keeps the editor in compact Actions and restores a saved extension", () => {
    harness.media.matches = true;
    const shell = mountWorkbench({
      initialPanel: null,
      project: project({
        extensions: {
          cameraTour: {
            schemaVersion: CAMERA_TOUR_SCHEMA_VERSION,
            id: "primary-camera-tour",
            title: "Restored tour",
            projection: "mercator",
            spatialBodyId: "earth",
            bindings: {mapVersion: null, layerVersions: [], imageryRevision: null, narrationObjectId: null},
            keyframes: [{
              id: "view-1",
              title: "Starting view",
              camera: {center: [-71, 42], zoom: 8, pitch: 20, bearing: 0},
              transitionMilliseconds: 0,
              holdMilliseconds: 1_000,
              easing: "smooth"
            }]
          }
        }
      })
    });
    clickButton(shell, "Actions");
    assert.ok(clickableButton(shell, "Camera tour"));
    clickButton(shell, "Camera tour");
    assert.equal(shell.querySelector('.gis-camera-tour-panel input[type="text"]').value, "Restored tour");
    assert.ok(shell.querySelector('[data-camera-tour-timeline="elapsed"]'));
  });

  it("records opposite resident Layer states, scrubs, plays, saves and freshly reopens without loading data", async () => {
    const saved = [];
    let reads = 0;
    const layers = tourLayers();
    const mount = (overrides = {}) => mountWorkbench({initialPanel: "tour", layers,
      geojsonByLayerId: residentTourData(),
      loadDatasetFeatures: async () => { reads += 1; throw new Error("Unexpected tour data request"); },
      loadDatasetVersionPreview: async () => { reads += 1; throw new Error("Unexpected tour preview request"); },
      saveProject: async definition => { saved.push(structuredClone(definition)); return {version: 2}; },
      ...overrides});
    let shell = mount();
    clickButton(shell, "Start camera tour");
    clickButton(shell, "Record Layer visibility");
    clickButton(shell, "Add current view");
    setVisible(shell, "Sites", false);
    setVisible(shell, "Boundaries", true);
    clickButton(shell, "Record Layer visibility");
    const editor = shell.querySelector('[data-camera-tour-editor="view-2"]');
    const [transition, hold] = editor.querySelectorAll('input[type="number"]');
    transition.value = "0";
    hold.value = "0.1";
    clickButton(editor, "Apply timing");

    seek(shell, 0);
    assert.deepEqual(visibleStates(shell), [true, false]);
    seek(shell, 1_100);
    assert.deepEqual(visibleStates(shell), [false, true]);
    clickButton(shell, "Stop tour");
    assert.deepEqual(visibleStates(shell), [true, false]);
    clickButton(shell, "Play tour");
    assert.equal(shell.querySelector('.gis-camera-tour-panel').dataset.playbackState, "playing");
    setVisible(shell, "Sites", false);
    assert.equal(shell.querySelector('.gis-camera-tour-panel').dataset.playbackState, "stopped");
    assert.deepEqual(visibleStates(shell), [false, false]);

    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);
    const retained = saved[0].extensions.cameraTour;
    assert.equal(retained.schemaVersion, CAMERA_TOUR_LAYER_SCHEMA_VERSION);
    assert.deepEqual(retained.keyframes.map(frame => frame.layerVisibility.map(binding => binding.visible)), [[true, false], [false, true]]);
    assert.deepEqual(retained.keyframes[0].camera, retained.keyframes[1].camera);
    shell.dispose(); shell.remove();
    shell = mount({project: project(saved[0]), layers: saved[0].layers});
    seek(shell, 1_100);
    assert.deepEqual(visibleStates(shell), [false, true]);
    seek(shell, 0);
    assert.deepEqual(visibleStates(shell), [true, false]);
    assert.deepEqual(shell.getPrintContext().project.extensions.cameraTour, retained);
    assert.equal(reads, 0);
  });

  it("rejects every missing, duplicate, nonresident or changed binding before changing any Layer or timeline", async () => {
    const saved = [];
    const shell = mountWorkbench({initialPanel: "tour", layers: tourLayers(), geojsonByLayerId: residentTourData(),
      saveProject: async definition => { saved.push(structuredClone(definition)); return {version: 2}; }});
    clickButton(shell, "Start camera tour");
    clickButton(shell, "Record Layer visibility");
    clickButton(shell, "Add current view");
    setVisible(shell, "Sites", false);
    setVisible(shell, "Boundaries", true);
    clickButton(shell, "Record Layer visibility");
    seek(shell, 0);
    const original = shell.__opengeoLayers.map(layer => structuredClone(layer));
    const beforeTime = shell.querySelector('[data-camera-tour-time="elapsed"]').textContent;
    const failures = [
      () => { shell.__opengeoLayers[1].sourceVersion += 1; },
      () => { shell.__opengeoLayers[1].datasetVersionId = "90000000-0000-4000-8000-000000000099"; },
      () => { shell.__opengeoLayers[1].datasetId = "90000000-0000-4000-8000-000000000098"; },
      () => { shell.__opengeoLayers[1].sourceType = "external-feature-reference"; },
      () => { shell.__opengeoLayers.pop(); },
      () => { shell.__opengeoLayers.push(structuredClone(shell.__opengeoLayers[1])); },
      () => { shell.__opengeoData.delete(original[1].layerId); }
    ];
    for (const corrupt of failures) {
      shell.__opengeoLayers.splice(0, shell.__opengeoLayers.length, ...structuredClone(original));
      for (const [id, data] of residentTourData()) shell.__opengeoData.set(id, data);
      corrupt();
      const before = visibleStates(shell);
      seek(shell, 5_000);
      assert.deepEqual(visibleStates(shell), before);
      assert.equal(shell.querySelector('[data-camera-tour-time="elapsed"]').textContent, beforeTime);
      assert.match(shell.textContent, /Tour stopped.*exact version/);
      assert.equal(shell.querySelector('.gis-camera-tour-panel').dataset.playbackState, "stopped");
    }
    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);
    assert.deepEqual(saved[0].extensions.cameraTour.keyframes[1].layerVisibility.map(binding => binding.visible), [false, true]);
  });

  it("preserves an unavailable saved tour when saving unrelated Project state", async () => {
    const raw = {schemaVersion: "opengeo.camera-tour.future", opaque: {important: true}};
    const saved = [];
    const shell = mountWorkbench({initialPanel: "tour", project: project({extensions: {cameraTour: raw}}),
      saveProject: async definition => { saved.push(structuredClone(definition)); return {version: 2}; }});
    assert.match(shell.textContent, /Saving preserves its original data/);
    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);
    assert.deepEqual(saved[0].extensions.cameraTour, raw);
  });

  it("selects and stops at the explicit starting snapshot when zero-duration views share a timestamp", () => {
    const baseline = tourLayers().map(({layerId, datasetId, datasetVersionId, sourceVersion, visible}) =>
      ({layerId, datasetId, datasetVersionId, sourceVersion, visible}));
    const tour = {schemaVersion: CAMERA_TOUR_LAYER_SCHEMA_VERSION, id: "zero-time-tour", title: "Instant stops",
      spatialBodyId: "earth", projection: "mercator", keyframes: [
        {id: "view-1", title: "Start", camera: {center: [-71, 42], zoom: 8, pitch: 20, bearing: 0},
          transitionMilliseconds: 0, holdMilliseconds: 0, easing: "linear", layerVisibility: baseline},
        {id: "view-2", title: "Finish", camera: {center: [-70, 43], zoom: 9, pitch: 30, bearing: 10},
          transitionMilliseconds: 0, holdMilliseconds: 0, easing: "linear", layerVisibility: baseline.map(binding => ({...binding, visible: !binding.visible}))}
      ]};
    const shell = mountWorkbench({initialPanel: "tour", layers: tourLayers(), geojsonByLayerId: residentTourData(),
      project: project({extensions: {cameraTour: tour}})});
    shell.querySelector('[data-camera-tour-keyframe="view-2"]').click();
    assert.deepEqual(visibleStates(shell), [false, true]);
    shell.querySelector('[data-camera-tour-keyframe="view-1"]').click();
    assert.deepEqual(visibleStates(shell), [true, false]);
    shell.querySelector('[data-camera-tour-keyframe="view-2"]').click();
    clickButton(shell, "Stop tour");
    assert.deepEqual(visibleStates(shell), [true, false]);
    assert.equal(shell.querySelector('[data-camera-tour-keyframe="view-1"]').getAttribute("aria-pressed"), "true");
  });

  it("updates the selected Layer halo with visibility events and restores the scene if the renderer throws", () => {
    const layers = tourLayers();
    const style = {layers: layers.map(layer => ({id: `${layer.layerId}-points`, type: "circle",
      source: layer.layerId, layout: {visibility: layer.visible ? "visible" : "none"}, paint: {"circle-radius": 5}}))};
    let camera = {center: [-71, 42], zoom: 8, pitch: 20, bearing: 0}, failNextCamera = false;
    const map = {
      getStyle: () => style, isStyleLoaded: () => true, getLayer: id => style.layers.find(layer => layer.id === id),
      setLayoutProperty(id, property, value) { this.getLayer(id).layout[property] = value; },
      addLayer(layer) { style.layers.push(layer); }, removeLayer(id) { style.layers = style.layers.filter(layer => layer.id !== id); },
      getCenter: () => ({lng: camera.center[0], lat: camera.center[1]}), getZoom: () => camera.zoom,
      getPitch: () => camera.pitch, getBearing: () => camera.bearing,
      jumpTo(value) { if (failNextCamera) { failNextCamera = false; throw new Error("Renderer failed"); } camera = structuredClone(value); }
    };
    const context = {layers, dataByLayerId: residentTourData(), loadingDatasetLayerIds: new Set(), failedDatasetLayerIds: new Set(),
      rendererAdapter: {id: "maplibre"}, shell: document.createElement("section"), render() {},
      state: {map, activeLayerId: layers[0].layerId, featureHaloEnabled: true,
        layerHandles: new Map(layers.map(layer => [layer.layerId, {layerIds: [`${layer.layerId}-points`], paintLayerIds: [`${layer.layerId}-points`]}]))}};
    const snapshot = layers.map(({layerId, datasetId, datasetVersionId, sourceVersion, visible}) =>
      ({layerId, datasetId, datasetVersionId, sourceVersion, visible}));
    const next = snapshot.map(binding => ({...binding, visible: !binding.visible}));
    const originalCamera = structuredClone(camera);
    syncFeatureHalo(context);
    const haloId = `${layers[0].layerId}-visibility-halo`;
    assert.ok(map.getLayer(haloId));
    assert.equal(applyCameraTourFrame(context, {camera: {...camera, zoom: 10}, layerVisibility: next}), true);
    assert.equal(map.getLayer(haloId), undefined);
    assert.equal(camera.zoom, 10);
    assert.equal(applyCameraTourFrame(context, {camera: originalCamera, layerVisibility: snapshot}), true);
    assert.ok(map.getLayer(haloId));
    failNextCamera = true;
    assert.equal(applyCameraTourFrame(context, {camera: {...camera, zoom: 12}, layerVisibility: next}), false);
    assert.deepEqual(layers.map(layer => layer.visible), [true, false]);
    assert.deepEqual(camera, originalCamera);
    assert.ok(map.getLayer(haloId));
    assert.equal(map.getLayer(`${layers[0].layerId}-points`).layout.visibility, "visible");
    assert.match(context.state.statusMessage, /Tour stopped/);
  });
});

function tourLayers() {
  return ["Sites", "Boundaries"].map((title, index) => ({
    layerId: `tour-layer-${index + 1}`, title, sourceType: "governed-dataset", geometryType: "Point",
    datasetId: `90000000-0000-4000-8000-00000000000${index + 1}`,
    datasetVersionId: `91000000-0000-4000-8000-00000000000${index + 1}`,
    sourceVersion: 1, visible: index === 0, opacity: 1, order: index, style: {}, labels: {enabled: false}
  }));
}

function residentTourData() {
  return new Map(tourLayers().map(layer => [layer.layerId,
    {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [-71, 42]}}]}]));
}

function visibleStates(shell) { return shell.__opengeoLayers.map(layer => layer.visible); }

function setVisible(shell, title, visible) {
  const checkbox = shell.querySelector(`input[aria-label="Show ${title}"]`);
  assert.ok(checkbox);
  checkbox.checked = visible;
  checkbox.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
}

function seek(shell, milliseconds) {
  const slider = shell.querySelector('[data-camera-tour-timeline="elapsed"]');
  slider.value = String(milliseconds);
  slider.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
}

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Tour testing", classification: "internal"},
    role: "owner",
    project: project(),
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

function project(overrides = {}) {
  return {
    projectId: "51000000-0000-4000-8000-000000000001",
    title: "Camera tour test",
    updatedAt: "2026-08-30T18:00:00Z",
    mapViews: [{id: "primary", title: "Primary", center: [-71, 42], zoom: 8, pitch: 20, bearing: 0}],
    ...overrides
  };
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
  assert.fail("timed out waiting for camera tour UI state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=camera-tour"
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
    sessionStorage: dom.window.sessionStorage,
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
