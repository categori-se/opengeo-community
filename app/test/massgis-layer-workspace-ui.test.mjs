import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {parseKml} from "../src/lib/kmlPlaces.js";
import {massgisDemoPresentation, publicDemoNavigation} from "../src/lib/publicDemoProject.js";

const MASSGIS = JSON.parse(await readFile(
  new URL("../src/data/massgis-enviroscreen.json", import.meta.url),
  "utf8"
));
const CATALOG = JSON.parse(await readFile(
  new URL("../src/data/public-demo-catalog.json", import.meta.url),
  "utf8"
));
const GEOJSON = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: 1,
    properties: {
      OBJECTID: 1,
      NAME: "Test block group",
      EXPpctilePM25: 72,
      EXPpctileOZONE: 48
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[-71.1, 42.3], [-71, 42.3], [-71, 42.4], [-71.1, 42.3]]]
    }
  }]
};

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(async () => {
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("MassGIS multi-layer project workspace", () => {
  it("shows the complete grouped layer stack without duplicating the project catalog", () => {
    const shell = mountMassgisWorkbench();

    assert.equal(shell.querySelectorAll(".gis-layer-row").length, 33);
    assert.equal(shell.querySelectorAll(".gis-layer-tree-group").length, 6);
    assert.equal(shell.querySelector(".gis-example-map-tree"), null);
    assert.match(shell.querySelector(".gis-content-tree-root summary small").textContent, /1\/33 visible/);
    assert.deepEqual(groupSummaries(shell), [
      ["Combined screening layers", "0/3 on"],
      ["Environmental Exposures", "1/8 on"],
      ["Environmental Effects", "0/5 on"],
      ["Climate Risks", "0/4 on"],
      ["Sensitive Populations", "0/8 on"],
      ["Socioeconomic Factors", "0/5 on"]
    ]);
    assert.equal(shell.querySelector(".gis-left-panel-header h2").textContent, "Layers");
    assert.equal(shell.textContent.includes("Top layers draw above lower layers"), false);
  });

  it("gives the layer tree a compact, non-duplicative command surface", () => {
    const shell = mountMassgisWorkbench();

    assert.equal(shell.querySelector(".gis-left-panel-actions"), null);
    assert.equal(shell.querySelector(".gis-left-panel-header").children.length, 2);
    assert.equal(shell.querySelector(".gis-left-panel-modes"), null);
    assert.equal([...shell.querySelectorAll("button")].some(({textContent}) => textContent.trim() === "Places"), false);
    assert.equal([...shell.querySelectorAll("button")].some(({textContent}) => textContent.trim() === "Browser"), false);
    assert.deepEqual(
      [...shell.querySelectorAll(".gis-layer-toolbar button")].map((control) => control.getAttribute("aria-label")),
      ["Add data to project layers", "Show all layers", "Hide all layers", "Expand all layer groups"]
    );
    assert.equal(shell.querySelector(".gis-bookmark-strip")?.open, false);
    assert.equal(shell.querySelector(".gis-search")?.open, false);
    assert.equal(layerRow(shell, "massgis_pm25_concentration").querySelector(":scope > small"), null);
    assert.equal(shell.querySelector(".gis-map").getAttribute("role"), "region");
    assert.equal(shell.querySelector(".gis-map").tabIndex, 0);
    const loading = shell.querySelector(".gis-loading-disclosure");
    assert.equal(loading.getAttribute("role"), "status");
    assert.equal(loading.getAttribute("aria-live"), "polite");
    assert.equal(loading.dataset.pending, "0");
    assert.match(loading.textContent, /Map sources ready/);
    assert.match(
      layerRow(shell, "massgis_pm25_concentration").querySelector(".gis-layer-popover-meta").textContent,
      /Polygon/
    );
    button(shell, "Project").click();
    assert.ok([...shell.querySelectorAll(".gis-menu-dropdown button")]
      .some((control) => control.querySelector("span")?.textContent === "Export current map PNG"));
  });

  it("treats KML as a styled layer with compact source-content controls", () => {
    const parsed = parseKml(`<?xml version="1.0"?>
      <kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Field observations</name>
        <Style id="observed"><IconStyle><color>ff00ff00</color></IconStyle></Style>
        <Placemark><name>Survey point</name><styleUrl>#observed</styleUrl><Point><coordinates>-71.1,42.3</coordinates></Point></Placemark>
      </Document></kml>`, {DOMParser: harness.dom.window.DOMParser});
    const shell = mountMassgisWorkbench([], {
      kmlPlaces: parsed.document,
      kmlInterchangeReport: parsed.report
    });

    assert.equal(layerRow(shell, "kml-places").querySelector(".gis-layer-row-top > button").textContent, "Field observations");
    assert.equal(shell.querySelector(".gis-kml-contents > summary").textContent, "KML content (1)");
    assert.ok(shell.querySelector(".gis-layer-dock .gis-kml-layer-editor"));
    assert.match(shell.querySelector(".gis-kml-layer-editor").textContent, /Shared styles1/);
    assert.equal(shell.querySelector(".gis-left-panel-modes"), null);
  });

  it("moves source discovery into one Add data workflow", () => {
    const shell = mountMassgisWorkbench();

    button(shell, "Add data to project layers").click();
    assert.equal(shell.querySelector(".gis-panel-right .gis-panel-header h2").textContent, "Add data");
    assert.equal(shell.textContent.includes("Data Source Manager"), false);
    assert.equal(shell.textContent.includes("Application home"), false);
    assert.equal(shell.textContent.includes("Workspace manager"), false);
    assert.equal(shell.textContent.includes("AWS project object"), false);
    const sourceType = shell.querySelector('select[aria-label="Source type"]');
    assert.ok(sourceType);
    assert.deepEqual([...sourceType.querySelectorAll("optgroup")].map(({label}) => label), [
      "Files",
      "Web services",
      "Cloud formats",
      "3D and databases"
    ]);
    assert.equal(sourceType.options[0].textContent, "Vector or KML layer");
    sourceType.value = "wms";
    sourceType.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(shell.querySelector('select[aria-label="Source type"]').value, "wms");
    assert.equal(shell.querySelector(".gis-panel-body h3").textContent, "WMS layer");
  });

  it("keeps visibility independent so several layers can be shown together", () => {
    const shell = mountMassgisWorkbench();
    const pm25 = layerRow(shell, "massgis_pm25_concentration");
    const ozone = layerRow(shell, "massgis_ozone_concentration");

    assert.equal(layerVisibility(pm25).checked, true);
    assert.equal(layerVisibility(ozone).checked, false);
    layerVisibility(ozone).checked = true;
    layerVisibility(ozone).dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));

    assert.equal(layerVisibility(layerRow(shell, "massgis_pm25_concentration")).checked, true);
    assert.equal(layerVisibility(layerRow(shell, "massgis_ozone_concentration")).checked, true);
    assert.equal(shell.__opengeoLayers.filter(({visible}) => visible).length, 2);
    assert.match(shell.querySelector(".gis-content-tree-root summary small").textContent, /2\/33 visible/);

    button(shell, "Show all layers").click();
    assert.equal(shell.__opengeoLayers.filter(({visible}) => visible).length, 33);
    button(shell, "Hide all layers").click();
    assert.equal(shell.__opengeoLayers.filter(({visible}) => visible).length, 0);
  });

  it("preserves expanded folders and keeps simple selection from forcing open the inspector", () => {
    const shell = mountMassgisWorkbench();
    const effects = groupDisclosure(shell, "Environmental Effects");
    effects.open = true;
    effects.dispatchEvent(new harness.dom.window.Event("toggle"));

    layerTitle(layerRow(shell, "massgis_pm25_concentration")).click();

    assert.equal(groupDisclosure(shell, "Environmental Effects").open, true);
    assert.equal(shell.classList.contains("right-collapsed"), true);
  });

  it("reorders sibling layers as a real top-to-bottom drawing stack", () => {
    const shell = mountMassgisWorkbench();
    const before = shell.__opengeoLayers.map(({layerId}) => layerId);
    const pm25Before = before.indexOf("massgis_pm25_concentration");
    const ozoneBefore = before.indexOf("massgis_ozone_concentration");
    assert.equal(ozoneBefore, pm25Before + 1);

    button(layerRow(shell, "massgis_pm25_concentration"), "Move PM2.5 concentration down").click();

    const after = shell.__opengeoLayers.map(({layerId}) => layerId);
    assert.equal(after.indexOf("massgis_ozone_concentration"), pm25Before);
    assert.equal(after.indexOf("massgis_pm25_concentration"), ozoneBefore);
    const exposureRows = [...groupDisclosure(shell, "Environmental Exposures").querySelectorAll(".gis-layer-row")];
    assert.equal(exposureRows[0].dataset.layerId, "massgis_ozone_concentration");
    assert.equal(exposureRows[1].dataset.layerId, "massgis_pm25_concentration");
  });

  it("moves complete folders to control the stack between layer groups", () => {
    const shell = mountMassgisWorkbench();
    button(shell, "Move Environmental Exposures group up").click();

    const folders = [...shell.querySelectorAll(".gis-layer-tree-group > summary > strong")]
      .map(({textContent}) => textContent);
    assert.deepEqual(folders.slice(0, 2), ["Environmental Exposures", "Combined screening layers"]);
    assert.deepEqual(shell.__opengeoLayers.slice(0, 3).map(({layerId}) => layerId), [
      "massgis_pm25_concentration",
      "massgis_ozone_concentration",
      "massgis_diesel_particulate_matter"
    ]);
    assert.equal(button(shell, "Move Environmental Exposures group up").disabled, true);
  });

  it("expands every layer group and switches public projects from the project control", () => {
    const selectedPages = [];
    const shell = mountMassgisWorkbench(selectedPages);
    button(shell, "Expand all layer groups").click();
    assert.equal([...shell.querySelectorAll(".gis-layer-tree-group")].every(({open}) => open), true);

    const switcher = shell.querySelector(".gis-workspace-select");
    assert.equal(switcher.disabled, false);
    assert.equal(switcher.getAttribute("aria-label"), "Switch public project or map");
    assert.equal(switcher.options.length, 32);
    assert.equal(switcher.options[0].textContent, "OpenGeo starter map");
    assert.ok([...switcher.options].some(({textContent}) => textContent === "PM2.5 concentration"));
    switcher.value = "community-facilities";
    switcher.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.deepEqual(selectedPages, ["community-facilities"]);
  });
});

function mountMassgisWorkbench(selectedPages = [], projectPatch = {}) {
  const presentation = massgisDemoPresentation({
    catalog: CATALOG,
    massgis: MASSGIS,
    geojson: GEOJSON,
    pageId: "massgis-pm25-concentration"
  });
  const navigation = publicDemoNavigation(
    MASSGIS,
    presentation.pageId,
    (pageId) => selectedPages.push(pageId)
  );
  const shell = WorkbenchView({
    workspace: presentation.workspace,
    role: "viewer",
    project: {...presentation.project, ...projectPatch},
    workspaces: [presentation.workspace],
    layers: presentation.layers,
    datasets: presentation.datasets,
    allDatasets: presentation.datasets,
    geojsonByLayerId: presentation.geojsonByLayerId,
    persistenceMode: "demo",
    publicDemo: true,
    projectNavigation: navigation,
    draftScopeId: presentation.draftScopeId
  });
  harness.dom.window.document.body.append(shell);
  harness.shell = shell;
  return shell;
}

function layerRow(root, layerId) {
  const row = root.querySelector(`.gis-layer-row[data-layer-id="${layerId}"]`);
  assert.ok(row, `expected layer row ${layerId}`);
  return row;
}

function layerVisibility(row) {
  return row.querySelector('.gis-layer-row-top > input[type="checkbox"]');
}

function layerTitle(row) {
  return row.querySelector(".gis-layer-row-top > button");
}

function groupDisclosure(root, title) {
  const disclosure = [...root.querySelectorAll(".gis-layer-tree-group")]
    .find((candidate) => candidate.querySelector(":scope > summary strong")?.textContent === title);
  assert.ok(disclosure, `expected group ${title}`);
  return disclosure;
}

function groupSummaries(root) {
  return [...root.querySelectorAll(".gis-layer-tree-group")]
    .map((group) => [
      group.querySelector(":scope > summary strong").textContent,
      group.querySelector(":scope > summary small").textContent
    ]);
}

function button(root, label) {
  const control = root.querySelector(`button[aria-label="${label}"]`)
    ?? [...root.querySelectorAll("button")].find(({textContent}) => textContent.trim() === label);
  assert.ok(control, `expected button ${label}`);
  return control;
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://demo.studio.opengeo.tools/?map=massgis-pm25-concentration"
  });
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    DOMParser: dom.window.DOMParser,
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
    shell: null,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}
