import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";

let harness;

beforeEach(() => harness = installDom());

afterEach(async () => {
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("flight simulator workbench experience", () => {
  it("presents the bounded Earth-terrain prerequisite before activating input", () => {
    const shell = mountWorkbench({initialPanel: "flight"});
    assert.match(shell.textContent, /Terrain-aware flight/);
    assert.match(shell.textContent, /not a certified flight model/);
    assert.match(shell.textContent, /Maximum session60 minutes/);
    assert.match(shell.textContent, /browser map only/);
    assert.match(shell.textContent, /Wait for the interactive map to finish loading/);
    assert.equal(button(shell, "Start flight").disabled, true);
    assert.equal(button(shell, "Enable globe and governed terrain").disabled, true);
    assert.equal(harness.controllerReads, 0);
  });

  it("uses the shared compact Actions route and disables Earth flight on another spatial body", () => {
    harness.media.matches = true;
    const shell = mountWorkbench({
      initialPanel: null,
      project: project({spatialBody: spatialBodyDefinition("mars")})
    });
    button(shell, "Actions").click();
    const command = button(shell, "Flight simulator");
    assert.equal(command.disabled, true);
    assert.equal(harness.controllerReads, 0);
  });
});

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Flight testing", classification: "internal"},
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
    title: "Flight simulator test",
    updatedAt: "2026-08-30T20:00:00Z",
    projection: "globe",
    terrain: {enabled: true, exaggeration: 1},
    mapViews: [{id: "primary", title: "Primary", center: [-71, 42], zoom: 8, pitch: 60, bearing: 90}],
    ...overrides
  };
}

function button(root, text) {
  const result = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  assert.ok(result, `expected button ${JSON.stringify(text)}`);
  return result;
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=flight-simulator"
  });
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  let controllerReads = 0;
  Object.defineProperty(dom.window.navigator, "getGamepads", {
    configurable: true,
    value: () => {
      controllerReads += 1;
      return [];
    }
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    DOMParser: dom.window.DOMParser,
    File: dom.window.File,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    matchMedia: () => media,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: () => 1,
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
    get controllerReads() { return controllerReads; },
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
