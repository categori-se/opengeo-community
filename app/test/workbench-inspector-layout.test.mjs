import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";

test("expanded attributes reuse the table and retain filtering, selection, scroll and Escape return", async () => {
  await withWorkbench({}, async ({shell, dom}) => {
    button(shell, "Table").click();
    shell.querySelectorAll(".gis-attribute-table tbody tr")[1].click();
    let panel = shell.querySelector(".gis-attributes-panel");
    let filter = panel.querySelector('input[type="search"]');
    filter.value = "Beta";
    filter.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    panel = shell.querySelector(".gis-attributes-panel");
    const table = panel.querySelector("table");
    table.scrollTop = 12;
    table.scrollLeft = 24;
    assert.equal(table.querySelectorAll("tbody tr").length, 1);
    assert.equal(table.querySelector("tbody tr").getAttribute("aria-selected"), "true");
    const expand = button(panel, "Expand table");
    expand.click();
    assert.equal(panel.querySelector("table"), table);
    assert.equal(expand.getAttribute("aria-expanded"), "true");
    assert.equal(panel.classList.contains("gis-attributes-expanded"), true);
    button(panel, "Back to map").click();
    assert.equal(panel.querySelector("table"), table);
    assert.equal(table.scrollTop, 12);
    assert.equal(table.scrollLeft, 24);
    assert.equal(panel.querySelector('input[type="search"]').value, "Beta");
    expand.click();
    filter = panel.querySelector('input[type="search"]');
    filter.focus();
    const escape = new dom.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
    filter.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, expand);
    expand.click();
    filter.value = "";
    filter.dispatchEvent(new dom.window.Event("input", {bubbles: true}));
    panel = shell.querySelector(".gis-attributes-panel");
    assert.equal(panel.classList.contains("gis-attributes-expanded"), true);
    assert.equal(panel.querySelectorAll("tbody tr").length, 2);
    assert.equal(panel.querySelector('tr[data-feature-index="1"]').getAttribute("aria-selected"), "true");
  });
});

test("style disclosures retain each Layer's state through edits without changing presentation", async () => {
  await withWorkbench({}, async ({shell, dom}) => {
    const sections = () => [...shell.querySelectorAll(".gis-style-section")];
    assert.deepEqual(sections().map(section => section.querySelector("summary").textContent),
      ["Basic appearance", "Labels", "Layer identity", "Advanced"]);
    assert.deepEqual(sections().map(section => section.open), [true, false, false, false]);
    const before = structuredClone(shell.__opengeoLayers[0]);
    sections()[0].open = false;
    sections()[1].open = true;
    sections()[3].open = true;
    for (const section of sections()) section.dispatchEvent(new dom.window.Event("toggle"));
    shell.dispatchEvent(new dom.window.Event("workbench:render"));
    assert.deepEqual(sections().map(section => section.open), [false, true, false, true]);
    assert.deepEqual(shell.__opengeoLayers[0], before);
    const name = shell.querySelector('[aria-label="Layer name"]');
    name.value = "Reviewed survey lines";
    name.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
    assert.equal(shell.__opengeoLayers[0].title, "Reviewed survey lines");
    assert.deepEqual(sections().map(section => section.open), [false, true, false, true]);
    assert.equal(shell.__opengeoLayers[0].layerId, before.layerId);
    assert.deepEqual(shell.__opengeoLayers[0].style, before.style);
  });
});

test("style groups keep read-only guards and exact referenced Style semantics", async () => {
  await withWorkbench({role: "viewer"}, async ({shell, dom}) => {
    const labels = shell.querySelectorAll(".gis-style-section")[1];
    labels.querySelector("summary").click();
    assert.equal(labels.open, true, "viewers can inspect collapsed settings without editing them");
    const name = shell.querySelector('[aria-label="Layer name"]');
    assert.equal(name.disabled, true);
    name.value = "Not authorized";
    name.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
    assert.equal(shell.__opengeoLayers[0].title, "Survey lines");
    assert.match(shell.textContent, /View-only Project/);
  });
  const reference = {projectId: "d0000000-0000-4000-8000-000000000002",
    resourceId: "d0000000-0000-4000-8000-000000000002", styleId: "d0000000-0000-4000-8000-000000000002",
    versionNumber: 2, checksumSha256: "1".repeat(64), format: "maplibre"};
  await withWorkbench({styleReference: reference}, async ({shell, dom}) => {
    assert.match(shell.querySelector(".gis-style-section").textContent, /Referenced Style/);
    assert.equal(shell.querySelector('[aria-label="Renderer"]'), null);
    assert.equal(shell.querySelector('[aria-label="Layer name"]'), null);
    assert.ok(button(shell, "Use previous inline styling"));
    for (const section of shell.querySelectorAll(".gis-style-section")) {
      section.open = true;
      section.dispatchEvent(new dom.window.Event("toggle"));
    }
    shell.dispatchEvent(new dom.window.Event("workbench:render"));
    assert.deepEqual(shell.__opengeoLayers[0].styleReference, reference);
    assert.equal(shell.__opengeoLayers[0].style.stroke, "#123456");
  });
});

function button(root, label) {
  const found = [...root.querySelectorAll("button")].find(item => item.textContent.trim() === label);
  assert.ok(found, label);
  return found;
}

async function withWorkbench({role = "owner", styleReference = null}, run) {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"});
  const replacements = {
    document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    DOMParser: dom.window.DOMParser, Node: dom.window.Node, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, MutationObserver: dom.window.MutationObserver,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  let shell;
  try {
    const layer = {layerId: "survey", datasetId: "survey-data", title: "Survey lines", sourceType: "geojson-object",
      geometryType: "LineString", visible: true, style: {stroke: "#123456", strokeWidth: 2}, labels: {enabled: false},
      ...(styleReference ? {styleReference} : {})};
    const geojson = {type: "FeatureCollection", features: ["Alpha", "Beta"].map((name, index) => ({
      type: "Feature", id: name, properties: {name, reading: index},
      geometry: {type: "LineString", coordinates: [[index, 0], [index + 1, 1]]}
    }))};
    shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Inspector"},
      project: emptyMapDefinition(), role, layers: [layer], geojsonByLayerId: new Map([[layer.layerId, geojson]]),
      persistenceMode: "api", restoreBrowserDraft: false, initialPanel: "style"});
    document.body.append(shell);
    await run({shell, dom});
  } finally {
    shell?.dispose();shell?.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
}
