import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {CAMERA_TOUR_SCHEMA_VERSION} from "../src/lib/cameraTour.js";

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
    assert.match(shell.textContent, /Narration, movie encoding, and KML gx:Tour exchange remain/);

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
});

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
