import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {HISTORICAL_IMAGERY_SCHEMA_VERSION} from "../src/lib/historicalImagery.js";

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
