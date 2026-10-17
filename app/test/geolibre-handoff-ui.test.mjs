import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {exportGeoLibreProject} from "../src/lib/geolibreProject.js";

const PROJECT_ID = "50000000-0000-4000-8000-000000000001";
const MAP_ID = "50000000-0000-4000-8000-000000000002";
const fixture = JSON.parse(readFileSync(new URL("../../parity/fixtures/data/geolibre-2.6-project.geolibre.json", import.meta.url), "utf8"));
fixture.layers = [fixture.layers[0]];
fixture.metadata.opengeo = {...fixture.metadata.opengeo, handoff: {
  schemaVersion: "opengeo.geolibre-handoff.1.0.0", projectId: PROJECT_ID, mapId: MAP_ID, mapVersion: 4
}};
const returnedText = JSON.stringify(fixture);
let harness;

beforeEach(() => {harness = installWorkbenchDom();});
afterEach(async () => {
  harness?.shell?.dispose?.();
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("reviewed GeoLibre handoff", () => {
  it("downloads the checked saved revision and offers a manual workbench link without sending the Project", async () => {
    const calls = [];
    const exported = exportGeoLibreProject({name: "Saved survey", definition: emptyMapDefinition()});
    const shell = mountWorkbench({prepareGeoLibreHandoff: async request => {
      calls.push(request);
      return exported;
    }});
    shell.querySelector(".gis-save-as-command").click();
    const exportDialog = document.querySelector('dialog[aria-label="Save as or export Project"]');
    clickButton(exportDialog, "Open in GeoLibre…");
    const dialog = document.querySelector('dialog[aria-label="Open in GeoLibre"]');
    assert.ok(dialog);
    assert.equal(calls.length, 0, "Opening instructions does not export or persist the Project");
    const link = [...dialog.querySelectorAll("a")].find(candidate => candidate.textContent === "Open GeoLibre workbench");
    assert.ok(link);
    assert.equal(new URL(link.href).origin, "https://web.geolibre.app");
    assert.equal(new URL(link.href).search, "", "No Project or credential is attached to the external link");
    assert.match(dialog.textContent, /local|download|file/i);
    clickButton(dialog, "Download saved revision");
    await waitFor(() => calls.length === 1 && harness.downloads.length === 1);
    assert.equal(calls[0].map.id, MAP_ID);
    assert.equal(calls[0].map.version, 4);
    assert.ok(calls[0].embeddedDataByLayerId instanceof Map);
    assert.equal(await harness.blobs[0].text(), exported.json);
    assert.match(harness.downloads[0].download, /\.geolibre\.json$/);
    assert.equal(location.href, harness.initialUrl);
  });

  it("keeps a failed saved-revision export reviewable and permits an explicit retry", async () => {
    let attempts = 0;
    const shell = mountWorkbench({prepareGeoLibreHandoff: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Save this map before opening it in GeoLibre.");
      return exportGeoLibreProject({name: "Saved survey", definition: emptyMapDefinition()});
    }});
    shell.querySelector(".gis-save-as-command").click();
    clickButton(document.querySelector('dialog[aria-label="Save as or export Project"]'), "Open in GeoLibre…");
    const dialog = document.querySelector('dialog[aria-label="Open in GeoLibre"]');
    clickButton(dialog, "Download saved revision");
    await waitFor(() => !clickableButton(dialog, "Download saved revision").disabled && /Save this map/.test(dialog.textContent));
    assert.equal(harness.downloads.length, 0);
    clickButton(dialog, "Download saved revision");
    await waitFor(() => harness.downloads.length === 1);
    assert.equal(attempts, 2);
  });

  it("shows the base and proposed changes without writing, and Cancel leaves the map intact", async () => {
    const reviewCalls = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => {
      reviewCalls.push(conversion);
      return {conversion, review: reviewFixture()};
    }, applyGeoLibreImport: async () => assert.fail("Inspection must not persist results")});
    const beforeLayers = [...shell.querySelectorAll(".gis-layer-row")].map(row => row.dataset.layerId);
    const dialog = await inspectReturn(shell);
    assert.equal(reviewCalls.length, 1);
    assert.match(dialog.textContent, /Opened revision 4.*current saved revision 4/);
    assert.match(dialog.textContent, /derived-sites/);
    assert.match(dialog.textContent, /public-geojson/);
    assert.match(dialog.textContent, /Unsupported terrain remains preserved/);
    assert.equal(clickableButton(dialog, "Save results to OpenGeo").disabled, false);
    clickButton(dialog, "Cancel");
    assert.equal(document.querySelector('dialog[aria-label="Review GeoLibre results"]'), null);
    assert.equal(location.href, harness.initialUrl);
    assert.deepEqual([...shell.querySelectorAll(".gis-layer-row")].map(row => row.dataset.layerId), beforeLayers);
  });

  it("passes the exact reviewed conversion, source and revision review only after Save", async () => {
    const calls = [];
    let reviewed;
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => {
      reviewed = {conversion, review: reviewFixture()};
      return reviewed;
    }, applyGeoLibreImport: async request => {
      calls.push(request);
      return completedImport();
    }});
    const dialog = await inspectReturn(shell);
    assert.equal(calls.length, 0);
    clickButton(dialog, "Save results to OpenGeo");
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].conversion, reviewed.conversion);
    assert.equal(calls[0].review, reviewed.review);
    assert.equal(calls[0].sourceText, returnedText);
    assert.equal(calls[0].filename, "survey-results.geolibre.json");
    assert.equal(Object.hasOwn(calls[0], "asNewMapName"), false);
  });

  it("blocks overwrite after a revision conflict and saves a deliberately named separate map", async () => {
    const calls = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => ({conversion, review: reviewFixture({conflict: true})}),
      applyGeoLibreImport: async request => {calls.push(request); return completedImport();}});
    const dialog = await inspectReturn(shell);
    const overwrite = clickableButton(dialog, "Save results to OpenGeo");
    assert.equal(overwrite.disabled, true);
    overwrite.click();
    assert.equal(calls.length, 0);
    clickButton(dialog, "Save results as a new map…");
    setField(dialog, "New map name", "Reviewed GeoLibre results");
    clickButton(dialog, "Save new map");
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].asNewMapName, "Reviewed GeoLibre results");
    assert.equal(calls[0].review.conflict, true);
    assert.equal(location.href, harness.initialUrl, "Saving does not replace the currently open map");
  });

  it("retains the same review and source after a save failure for an explicit retry", async () => {
    const calls = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => ({conversion, review: reviewFixture()}),
      applyGeoLibreImport: async request => {
        calls.push(request);
        if (calls.length === 1) throw new Error("Dataset registration is unavailable. Try again.");
        return completedImport();
      }});
    const dialog = await inspectReturn(shell);
    clickButton(dialog, "Save results to OpenGeo");
    await waitFor(() => !clickableButton(dialog, "Save results to OpenGeo").disabled && /registration is unavailable/.test(dialog.textContent));
    assert.equal(dialog.isConnected, true);
    assert.equal(calls.length, 1);
    clickButton(dialog, "Save results to OpenGeo");
    await waitFor(() => calls.length === 2);
    assert.equal(calls[1].conversion, calls[0].conversion);
    assert.equal(calls[1].review, calls[0].review);
    assert.equal(calls[1].sourceText, calls[0].sourceText);
  });

  it("saves explicit output input links only when the user accepts the review", async () => {
    const calls = [];
    let output;
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => {
      output = {layerId: "derived-sites", importRef: "geolibre:return:example", inputLayerIds: [], retention: "retained-output", reproducible: false};
      conversion.map.definition.extensions.opengeoGeoLibreReturn = {
        inputs: [{layerId: "public-geojson", datasetId: "original-dataset"}], outputs: [output]
      };
      return {conversion, review: reviewFixture()};
    }, applyGeoLibreImport: async request => {calls.push(request); return completedImport();}});
    const dialog = await inspectReturn(shell);
    const selector = dialog.querySelector('select[aria-label="Input Layers for derived-sites"]');
    assert.ok(selector?.multiple);
    assert.deepEqual(output.inputLayerIds, []);
    selector.options[0].selected = true;
    selector.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(calls.length, 0);
    assert.deepEqual(output.inputLayerIds, [], "Selecting a link is not a saved declaration");
    clickButton(dialog, "Save results to OpenGeo");
    await waitFor(() => calls.length === 1);
    const savedOutput = calls[0].conversion.map.definition.extensions.opengeoGeoLibreReturn.outputs[0];
    assert.deepEqual(savedOutput.inputLayerIds, ["public-geojson"]);
    assert.equal(savedOutput.inputLinkMethod, "user-declared");
    assert.equal(savedOutput.reproducible, false);
  });

  it("allows a reader to inspect results while keeping both save actions disabled", async () => {
    const shell = mountWorkbench({role: "viewer", reviewGeoLibreReturn: async ({conversion}) => ({conversion, review: reviewFixture({conflict: true})}),
      applyGeoLibreImport: async () => assert.fail("Readers cannot save GeoLibre results")});
    const dialog = await inspectReturn(shell);
    assert.equal(clickableButton(dialog, "Save results to OpenGeo").disabled, true);
    assert.equal(clickableButton(dialog, "Save results as a new map…").disabled, true);
    clickButton(dialog, "Cancel");
  });

  it("saves the reviewed file bytes after another inspection changes the pending source", async () => {
    const calls = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => ({conversion, review: reviewFixture()}),
      applyGeoLibreImport: async request => {calls.push(request); return completedImport();}});
    const originalReview = await inspectReturn(shell);
    const otherProject = structuredClone(fixture);
    otherProject.name = "Other imported Project";
    delete otherProject.metadata.opengeo.handoff;
    const otherText = JSON.stringify(otherProject);
    await chooseProjectFile(shell, otherText, "other-project.geolibre.json");
    const otherReview = document.querySelector('dialog[aria-label="Review Project file"]');
    assert.ok(otherReview);
    clickButton(otherReview, "Cancel");
    clickButton(originalReview, "Save results to OpenGeo");
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].sourceText, returnedText);
    assert.equal(calls[0].filename, "survey-results.geolibre.json");
    assert.notEqual(calls[0].sourceText, otherText);
  });

  it("ignores an older overlapping inspection when the latest file has already been reviewed", async () => {
    const older = deferred(), calls = [];
    let olderStarted = false;
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => {
      if (conversion.map.name === "Older results") {olderStarted = true; await older.promise;}
      return {conversion, review: reviewFixture()};
    }, applyGeoLibreImport: async request => {calls.push(request); return completedImport();}});
    const olderText = JSON.stringify({...fixture, name: "Older results"});
    const latestText = JSON.stringify({...fixture, name: "Latest results"});
    const firstInspection = chooseProjectFile(shell, olderText, "older-results.geolibre.json");
    await waitFor(() => olderStarted);
    await chooseProjectFile(shell, latestText, "latest-results.geolibre.json");
    older.resolve();
    await firstInspection;
    const dialogs = document.querySelectorAll('dialog[aria-label="Review GeoLibre results"]');
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].textContent, /latest-results\.geolibre\.json/);
    assert.doesNotMatch(dialogs[0].textContent, /older-results\.geolibre\.json/);
    clickButton(dialogs[0], "Save results to OpenGeo");
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].sourceText, latestText);
    assert.equal(calls[0].conversion.map.name, "Latest results");
  });

  it("locks the submitted inputs and new-map name through failure and retries the same plan", async () => {
    const pending = deferred(), calls = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => {
      conversion.map.definition.extensions.opengeoGeoLibreReturn = {
        inputs: [{layerId: "original-input", datasetId: "original-dataset"}, {layerId: "other-input", datasetId: "other-dataset"}],
        outputs: [{layerId: "derived-sites", importRef: "geolibre:return:example", inputLayerIds: [], retention: "retained-output", reproducible: false}]
      };
      return {conversion, review: reviewFixture({conflict: true})};
    }, applyGeoLibreImport: async request => {
      calls.push(structuredClone(request));
      if (calls.length === 1) return pending.promise;
      return completedImport();
    }});
    const dialog = await inspectReturn(shell);
    const selector = dialog.querySelector('select[aria-label="Input Layers for derived-sites"]');
    selector.options[0].selected = true;
    clickButton(dialog, "Save results as a new map…");
    setField(dialog, "New map name", "First reviewed results");
    const name = dialog.querySelector('input[aria-label="New map name"]');
    clickButton(dialog, "Save new map");
    assert.equal(calls.length, 1);
    assert.equal(selector.disabled, true);
    assert.equal(name.disabled, true);
    assert.equal(clickableButton(dialog, "Cancel").disabled, true);
    clickableButton(dialog, "Cancel").click();
    assert.equal(dialog.isConnected, true);
    assert.equal(dialog.dispatchEvent(new harness.dom.window.Event("cancel", {cancelable: true})), false);
    assert.equal(dialog.isConnected, true);
    clickableButton(dialog, "Save new map").click();
    assert.equal(calls.length, 1, "Pending submission cannot be duplicated");
    pending.reject(new Error("Registration unavailable. Retry the retained plan."));
    await waitFor(() => /Registration unavailable/.test(dialog.textContent));
    assert.equal(selector.disabled, true);
    assert.equal(name.disabled, true);
    assert.equal(clickableButton(dialog, "Cancel").disabled, false);
    // Programmatic changes cannot turn a retry into a different import after a
    // request may already have committed registrations or a new map.
    selector.options[0].selected = false;
    selector.options[1].selected = true;
    name.value = "Changed after failure";
    clickButton(dialog, "Save new map");
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[1].asNewMapName, "First reviewed results");
    assert.deepEqual(calls[1].conversion.map.definition.extensions.opengeoGeoLibreReturn.outputs[0].inputLayerIds, ["original-input"]);
  });

  it("does not navigate when a submitted import completes after disposing the workbench", async () => {
    const pending = deferred(), navigations = [];
    const shell = mountWorkbench({reviewGeoLibreReturn: async ({conversion}) => ({conversion, review: reviewFixture()}),
      applyGeoLibreImport: async () => pending.promise});
    const dialog = await inspectReturn(shell);
    clickButton(dialog, "Save results to OpenGeo");
    shell.dispose();
    const observedLocation = {};
    Object.defineProperty(observedLocation, "href", {get: () => harness.initialUrl, set: value => navigations.push(value)});
    globalThis.location = observedLocation;
    pending.resolve({...completedImport(), mapId: "50000000-0000-4000-8000-000000000009"});
    await waitFor(() => !dialog.isConnected);
    assert.deepEqual(navigations, []);
    assert.equal(dialog.isConnected, false);
  });
});

function reviewFixture({conflict = false} = {}) {
  return {
    schemaVersion: "opengeo.geolibre-return-review.1.0.0",
    base: {mapId: MAP_ID, mapVersion: 4, definitionSha256: "a".repeat(64)},
    current: {mapId: MAP_ID, mapVersion: conflict ? 7 : 4},
    conflict,
    added: ["derived-sites"],
    changed: [{layerId: "public-geojson", derivativeLayerId: "derived-sites", changes: ["data", "style"]}],
    removed: ["omitted-boundary"],
    unchanged: [],
    styles: ["public-geojson"],
    limits: ["Unsupported terrain remains preserved."]
  };
}

function completedImport() {
  return {operation: {importId: "completed-import", finalMapVersion: 5}, map: {id: MAP_ID, version: 5, definition: emptyMapDefinition()}};
}

async function inspectReturn(shell) {
  await chooseProjectFile(shell, returnedText, "survey-results.geolibre.json");
  const dialog = document.querySelector('dialog[aria-label="Review GeoLibre results"]');
  assert.ok(dialog, shell.querySelector(".gis-statusbar")?.textContent);
  return dialog;
}

function chooseProjectFile(shell, sourceText, filename) {
  shell.querySelector('.gis-menu-wrap[data-menu="project"] > button').click();
  const command = [...shell.querySelectorAll('.gis-menu-wrap[data-menu="project"] .gis-menu-item')]
    .find(button => button.querySelector("span")?.textContent === "Open Project file…");
  assert.ok(command);
  command.click();
  const input = [...shell.querySelectorAll(".opengeo-project-file-input")].at(-1);
  assert.ok(input);
  Object.defineProperty(input, "files", {value: [{name: filename, size: sourceText.length, text: async () => sourceText}]});
  return input.onchange();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: PROJECT_ID, title: "GeoLibre handoff acceptance", classification: "internal"},
    role: "owner",
    project: {...emptyMapDefinition(), id: MAP_ID, projectId: PROJECT_ID, name: "Saved survey", title: "Saved survey", version: 4},
    workspaces: [], layers: [], datasets: [], storage: memoryStorage(),
    initialPanel: null, persistenceMode: "api", mapVersion: 4,
    savedProjectOrigin: {id: MAP_ID, version: 4},
    saveProject: async () => assert.fail("Handoff inspection must not save the current map"),
    ...overrides
  });
  document.body.append(shell);
  harness.shell = shell;
  return shell;
}

function clickableButton(root, label) {
  const button = [...root.querySelectorAll("button")].find(candidate => candidate.textContent.trim() === label);
  assert.ok(button, `expected button ${JSON.stringify(label)}`);
  return button;
}

function clickButton(root, label) {clickableButton(root, label).click();}

function setField(root, label, value) {
  const wrapper = [...root.querySelectorAll("label")].find(candidate => candidate.textContent.startsWith(label));
  const input = wrapper?.querySelector("input");
  assert.ok(input, `expected field ${JSON.stringify(label)}`);
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for GeoLibre handoff UI state");
}

function installWorkbenchDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?composition=geolibre-handoff"
  });
  const downloads = [], blobs = [];
  dom.window.HTMLAnchorElement.prototype.click = function () {downloads.push({href: this.href, download: this.download});};
  const replacements = {
    document: dom.window.document, location: dom.window.location, history: dom.window.history,
    HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  const createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  URL.createObjectURL = blob => {blobs.push(blob); return "blob:opengeo-handoff-test";};
  URL.revokeObjectURL = () => {};
  return {dom, shell: null, downloads, blobs, initialUrl: dom.window.location.href, restore() {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    Object.defineProperty(URL, "createObjectURL", createObjectURL);
    Object.defineProperty(URL, "revokeObjectURL", revokeObjectURL);
  }};
}

function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)};
}
