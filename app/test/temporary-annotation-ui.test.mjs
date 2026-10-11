import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";

const WORKSPACE_ID = "50000000-0000-4000-8000-000000000001";
const PROJECT_ID = "51000000-0000-4000-8000-000000000001";

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

describe("GeoMoose-comparable temporary annotation workflow", () => {
  it("edits a browser copy of sample data without changing the original or calling an API", () => {
    const data = collection([feature("Point", [-71.06, 42.36])]);
    const original = structuredClone(data);
    const layer = {...authoritativeLayer(), sourceType: "geojson-object", fixtureSource: true};
    const shell = mountWorkbench({publicDemo: true, persistenceMode: "demo", layers: [layer], geojsonByLayerId: new Map([[layer.layerId, data]])});
    assert.equal(shell.querySelector('.gis-app-nav a[href="/workspaces"]'), null);
    clickButton(shell, "Edit a copy · Authoritative layer");
    assert.equal(shell.querySelectorAll('[data-persistence="temporary"]').length, 1);
    clickButton(shell, "Edit geometry");
    shell.querySelector('input[data-temporary-coordinate="longitude"]').value = "-70.75";
    shell.querySelector('input[data-temporary-coordinate="latitude"]').value = "42.5";
    clickButton(shell, "Apply coordinate");
    clickButton(shell, "Save geometry changes");
    assert.deepEqual(storedTemporaryGeojson().features[0].geometry.coordinates, [-70.75, 42.5]);
    assert.deepEqual(data, original);
  });

  it("exposes explicit draw/upload controls and marks uploads as expiring non-authoritative layers", async () => {
    const shell = mountWorkbench();

    for (const label of [
      "Draw temporary point",
      "Draw temporary path",
      "Draw temporary polygon",
      "Choose temporary GeoJSON or KML",
      "Save temporary work",
      "Clear temporary work"
    ]) assert.match(shell.textContent, new RegExp(label));

    const file = shell.querySelector('.gis-file-drop input[type="file"]');
    const text = JSON.stringify(collection([feature("Point", [-71.06, 42.36])]));
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [{name: "review-points.geojson", size: new TextEncoder().encode(text).byteLength, text: async () => text}]
    });
    file.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => shell.querySelector('[data-persistence="temporary"]'));

    const row = shell.querySelector('[data-persistence="temporary"]');
    assert.match(row.textContent, /review-points/);
    assert.match(row.textContent, /Temporary · browser only · expires in 24h/);
    assert.equal(shell.__opengeoLayers[0].temporaryWork.authority, "none");
    assert.equal(shell.__opengeoLayers[0].temporaryWork.promotion, "governed-ingest-required");
    assert.match(harness.dom.window.localStorage.key(0), /^opengeo\.temporary-work\./);
  });

  it("opens bounded KML as an isolated temporary layer instead of replacing Places", async () => {
    const shell = mountWorkbench();
    const input = shell.querySelector('.gis-file-drop input[accept^=".geojson"]');
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Review KML</name><Placemark><name>One</name><Point><coordinates>-71.06,42.36</coordinates></Point></Placemark></Document></kml>`;
    const bytes = new TextEncoder().encode(kml);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{name: "review.kml", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer}]
    });
    input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => shell.querySelector('[data-persistence="temporary"]'));

    assert.equal(shell.__opengeoLayers[0].temporaryWork.format, "kml");
    assert.equal(shell.__opengeoLayers[0].sourceType, "geojson-object");
    assert.equal(shell.__opengeoLayers.some(({layerId}) => layerId === "kml-places"), false);
    assert.match(shell.querySelector('[data-persistence="temporary"]').textContent, /review/);
  });

  it("restores temporary work only inside the same project scope", async () => {
    let shell = mountWorkbench();
    await uploadGeojson(shell, "same-project.geojson");
    shell.remove();
    await Promise.resolve();

    shell = mountWorkbench();
    assert.equal(shell.querySelectorAll('[data-persistence="temporary"]').length, 1);
    shell.remove();
    await Promise.resolve();

    shell = mountWorkbench({project: project("51000000-0000-4000-8000-000000000099")});
    assert.equal(shell.querySelectorAll('[data-persistence="temporary"]').length, 0);
  });

  it("moves an existing temporary vertex, saves it in scoped browser storage, and restores it", async () => {
    let shell = mountWorkbench();
    await uploadGeojson(shell, "editable-point.geojson");

    clickButton(shell, "Edit geometry");
    assert.match(shell.textContent, /Edit temporary geometry/);
    assert.match(shell.textContent, /Point/);
    const longitude = shell.querySelector('input[data-temporary-coordinate="longitude"]');
    const latitude = shell.querySelector('input[data-temporary-coordinate="latitude"]');
    assert.equal(longitude.value, "-71.06");
    assert.equal(latitude.value, "42.36");
    longitude.value = "-70.75";
    latitude.value = "42.5";
    clickButton(shell, "Apply coordinate");
    assert.match(shell.querySelector(".gis-statusbar").textContent, /browser-only draft/);
    clickButton(shell, "Save geometry changes");

    assert.deepEqual(storedTemporaryGeojson().features[0].geometry.coordinates, [-70.75, 42.5]);
    assert.match(shell.textContent, /No authoritative dataset or saved map changed/);
    shell.remove();
    await Promise.resolve();

    shell = mountWorkbench();
    clickButton(shell, "Edit geometry");
    assert.equal(shell.querySelector('input[data-temporary-coordinate="longitude"]').value, "-70.75");
    assert.equal(shell.querySelector('input[data-temporary-coordinate="latitude"]').value, "42.5");
  });

  it("keeps a coordinate draft isolated until save and cancels without changing stored work", async () => {
    const shell = mountWorkbench();
    await uploadGeojson(shell, "cancelled-point.geojson");
    const before = storedTemporaryGeojson();

    clickButton(shell, "Edit geometry");
    shell.querySelector('input[data-temporary-coordinate="longitude"]').value = "-69";
    shell.querySelector('input[data-temporary-coordinate="latitude"]').value = "41";
    clickButton(shell, "Apply coordinate");
    clickButton(shell, "Cancel geometry editing");

    assert.deepEqual(storedTemporaryGeojson(), before);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /stored temporary layer was not changed/);
    assert.equal(shell.querySelector('[data-temporary-editor="active"]'), null);
  });

  it("never includes temporary layers in authoritative Save", async () => {
    const saved = [];
    const shell = mountWorkbench({
      layers: [authoritativeLayer()],
      saveProject: async (definition) => {
        saved.push(structuredClone(definition));
        return {version: 2, updatedAt: "2026-08-29T14:00:00Z"};
      }
    });
    await uploadGeojson(shell, "excluded.geojson");

    clickButton(shell, "Save");
    await waitFor(() => saved.length === 1);

    assert.deepEqual(saved[0].layers.map(({layerId}) => layerId), ["authoritative-layer"]);
    assert.equal(saved[0].activeLayerId, "authoritative-layer");
    assert.doesNotMatch(JSON.stringify(saved[0]), /temporaryWork|excluded\.geojson/);
  });

  it("requires a separate reviewed managed-ingest action before promotion", async () => {
    const imports = [];
    const shell = mountWorkbench({
      importLocalFile: async (file, report) => {
        imports.push(file);
        report("verified", "Temporary upload verified.");
        return {dataset: {name: "Governed review points"}, versionNumber: 1};
      }
    });
    await uploadGeojson(shell, "promotion.geojson");

    clickButton(shell, "Review promotion");
    assert.equal(imports.length, 0);
    assert.match(shell.textContent, /Direct map mutationProhibited/);
    assert.match(shell.textContent, /Managed ingest and review/);

    clickButton(shell, "Queue governed ingest for review");
    await waitFor(() => imports.length === 1);
    assert.equal(imports[0].name, "promotion.geojson");
    assert.equal(shell.__opengeoLayers.filter(({temporaryWork}) => temporaryWork).length, 1);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /queued as governed dataset version 1/);
  });

  it("keeps the compact Actions sheet as the route to temporary work", () => {
    harness.media.matches = true;
    const shell = mountWorkbench({initialPanel: null});
    clickButton(shell, "Actions");
    assert.ok(clickableButton(shell, "Temporary annotations and uploads…"));
  });

  it("shows drawing guidance when secondary map controls are hidden", () => {
    const shell = mountWorkbench({initialPanel: null});
    assert.equal(shell.querySelector('.gis-map-control-stack'), null);
    clickButton(shell, "Polygon");
    assert.ok(shell.querySelector('.gis-map-authoring-guide[data-authoring-kind="Polygon"]'));
  });

  it("keeps Publications in the main and mobile navigation when the project switcher is present", () => {
    harness.media.matches = true;
    const shell = mountWorkbench({projectSwitcher: {initial: []}, initialPanel: null});
    const route = "/workspaces?view=publishing";
    assert.equal(shell.querySelector(`.gis-app-nav a[href="${route}"]`)?.textContent, "Publications");
    clickButton(shell, "Actions");
    assert.equal(shell.querySelector(`.gis-mobile-command-navigation a[href="${route}"]`)?.textContent, "Publications");
  });

  it("opens a Project file by content and chooses export formats inside one panel", async () => {
    const shell = mountWorkbench();
    shell.querySelector('.gis-menu-wrap[data-menu="project"] > button').click();
    const menu = shell.querySelector('.gis-menu-wrap[data-menu="project"]');
    assert.match(menu.textContent, /Open Project file…/);
    assert.match(menu.textContent, /Save as \/ export…/);
    assert.doesNotMatch(menu.textContent, /Inspect GeoLibre|Export GeoMoose|Inspect Web Map Context/);
    [...menu.querySelectorAll('.gis-menu-item')].find(button => button.querySelector('span')?.textContent === 'Save as / export…').click();
    const exportDialog = document.querySelector('dialog[aria-label="Save as or export Project"]');
    assert.ok(exportDialog);
    assert.deepEqual([...exportDialog.querySelectorAll('option')].map(option => option.value),
      ['geolibre', 'geomoose', 'wmc', 'png', 'html']);
    clickableButton(exportDialog, "Close").click();

    shell.querySelector('.gis-primary-command[data-primary-command="open-file"]').click();
    const input = shell.querySelector('.opengeo-project-file-input');
    const source = readFileSync(new URL('../../parity/fixtures/data/geomoose-3.15.2-mapbook.xml', import.meta.url), 'utf8');
    Object.defineProperty(input, 'files', {configurable: true, value: [{name: 'project.xml', size: new TextEncoder().encode(source).byteLength, text: async () => source}]});
    input.dispatchEvent(new harness.dom.window.Event('change'));
    const review = await waitFor(() => document.querySelector('dialog[aria-label="Review Project file"]'));
    assert.match(review.textContent, /GeoMoose mapbook/);
    assert.ok(clickableButton(review, 'Open in this Project'));
    clickableButton(review, 'Cancel').click();
  });

  it("reviews a native OpenGeo browser Project before replacing the current draft", async () => {
    const shell = mountWorkbench({publicDemo: true, persistenceMode: "demo"});
    shell.querySelector('.gis-primary-command[data-primary-command="open-file"]').click();
    const input = shell.querySelector('.opengeo-project-file-input');
    const source = JSON.stringify({...emptyMapDefinition(), layers: [], persistence: {mode: "browser-only-demo"}});
    Object.defineProperty(input, 'files', {configurable: true, value: [{name: 'another-project.json', size: source.length, text: async () => source}]});
    input.dispatchEvent(new harness.dom.window.Event('change'));
    const review = await waitFor(() => document.querySelector('dialog[aria-label="Review Project file"]'));
    assert.match(review.textContent, /another-project\.json · OpenGeo browser Project/);
    assert.match(review.textContent, /Opening replaces this browser draft/);
    assert.ok(clickableButton(review, 'Open in this Project'));
    clickableButton(review, 'Cancel').click();
  });

  it("exports one selected saved Project version through the format-neutral chooser without changing the draft", async () => {
    const calls = [], downloads = [];
    const saved = {version: 2, definitionBytes: 200, createdBy: "20000000-0000-4000-8000-000000000001",
      createdAt: "2026-10-05T12:00:00Z", changeMessage: "Retain earlier styling"};
    const definition = {...emptyMapDefinition(), extensions: {earlier: "exact 🌏"}};
    const shell = mountWorkbench({savedProjectOrigin: {id: PROJECT_ID, version: 3, definition: emptyMapDefinition()},
      styleAdapter: {
        listCompositionVersions: async (...args) => {calls.push(["list", ...args]); return [saved];},
        getCompositionVersion: async (...args) => {calls.push(["read", ...args]); return {...saved, definition};}
      }, saveProject: () => assert.fail("Export cannot save the Project")});
    const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = blob => {downloads.push(blob); return "blob:local-test";};
    URL.revokeObjectURL = () => {};
    const anchorClick = harness.dom.window.HTMLAnchorElement.prototype.click;
    harness.dom.window.HTMLAnchorElement.prototype.click = () => {};
    try {
      shell.querySelector('.gis-menu-wrap[data-menu="project"] > button').click();
      const menu = shell.querySelector('.gis-menu-wrap[data-menu="project"]');
      assert.doesNotMatch(menu.textContent, /saved version|GeoLibre Project/);
      [...menu.querySelectorAll('.gis-menu-item')].find(node => node.querySelector('span')?.textContent === 'Save as / export…').click();
      const dialog = document.querySelector('dialog[aria-label="Save as or export Project"]');
      assert.equal(dialog.querySelector('select[aria-label="Project export format"]').value, "opengeo-saved");
      assert.deepEqual(calls, []);
      clickableButton(dialog, "Find saved versions").click();
      await waitFor(() => dialog.querySelector('select[aria-label="Saved Project version"] option[value="2"]'));
      dialog.querySelector('select[aria-label="Saved Project version"]').value = "2";
      clickableButton(dialog, "Export file").click();
      await waitFor(() => downloads.length === 1);
      const exported = JSON.parse(await downloads[0].text());
      assert.equal(exported.projectId, PROJECT_ID);
      assert.equal(exported.version, 2);
      assert.deepEqual(exported.definition, definition);
      assert.equal(exported.dependenciesBundled, false);
      assert.equal(exported.accessIncluded, false);
      assert.deepEqual(calls, [["list", PROJECT_ID, {limit: 25, beforeVersion: null}], ["read", PROJECT_ID, 2]]);
      assert.match(dialog.textContent, /contains its definition and recorded change/);
      clickableButton(dialog, "Close").click();
    } finally {
      URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
      harness.dom.window.HTMLAnchorElement.prototype.click = anchorClick;
    }
  });
});

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: WORKSPACE_ID, title: "Temporary work", classification: "internal"},
    role: "owner",
    project: project(PROJECT_ID),
    layers: [],
    datasets: [],
    storage: memoryStorage(),
    initialPanel: "temporary",
    persistenceMode: "api",
    ...overrides
  });
  harness.dom.window.document.body.append(shell);
  harness.shell = shell;
  return shell;
}

function project(projectId) {
  return {projectId, title: "Temporary work", updatedAt: "2026-08-29T12:00:00Z", mapViews: []};
}

function authoritativeLayer() {
  return {
    layerId: "authoritative-layer",
    datasetId: "70000000-0000-4000-8000-000000000001",
    title: "Authoritative layer",
    sourceType: "governed-dataset",
    geometryType: "Point",
    visible: true,
    opacity: 1,
    order: 0,
    style: {},
    labels: {enabled: false, field: null}
  };
}

async function uploadGeojson(shell, name) {
  const input = shell.querySelector('.gis-file-drop input[accept^=".geojson"]');
  assert.ok(input);
  const text = JSON.stringify(collection([feature("Point", [-71.06, 42.36])]));
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{name, size: new TextEncoder().encode(text).byteLength, text: async () => text}]
  });
  input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
  await waitFor(() => shell.querySelector('[data-persistence="temporary"]'));
}

function collection(features) {
  return {type: "FeatureCollection", features};
}

function feature(type, coordinates) {
  return {type: "Feature", properties: {name: "Review"}, geometry: {type, coordinates}};
}

function storedTemporaryGeojson() {
  const key = [...Array(harness.dom.window.localStorage.length)]
    .map((_, index) => harness.dom.window.localStorage.key(index))
    .find((candidate) => candidate?.startsWith("opengeo.temporary-work."));
  assert.ok(key, "expected project-scoped temporary storage");
  const document = JSON.parse(harness.dom.window.localStorage.getItem(key));
  assert.equal(document.entries.length, 1);
  return document.entries[0].geojson;
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
  assert.fail("timed out waiting for temporary annotation UI state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=temporary-work"
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
