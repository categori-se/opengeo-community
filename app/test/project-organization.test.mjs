import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {afterEach, beforeEach, it} from "node:test";
import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {editLayerFolders, LayerFolders} from "../src/components/LayerFolders.js";
import {normalizeProjectLayerOrder, orderedProjectLayerTree, sortProjectLayerSiblings} from "../src/lib/layerOrder.js";
import {addKmlPlace, createPlacesDocument, exportKml, moveKmlPlace, parseKml, sortKmlPlaceSiblings} from "../src/lib/kmlPlaces.js";
import {addNamedMapView, mapViewsForSave, removeNamedMapView, renameNamedMapView} from "../src/lib/globeView.js";
const {JSDOM} = createRequire(new URL("../package.json", import.meta.url))("jsdom");

const ROOT = "50000000-0000-4000-8000-000000000001";
const PROJECT = "51000000-0000-4000-8000-000000000001";
const primary = {id: "primary", title: "Primary view", center: [0, 20], zoom: 2, pitch: 0, bearing: 0};
const savedView = {id: "harbor", title: "Harbor", center: [-71, 42], zoom: 8, pitch: 25, bearing: 45};
let harness;

beforeEach(() => harness = installDom());
afterEach(async () => {
  for (const shell of harness.shells) {shell.dispose?.(); shell.remove();}
  await Promise.resolve();
  harness.restore(); harness.dom.window.close();
});

it("sorts only the chosen sibling list, preserves IDs and agrees with saved/reopened drawing order", () => {
  const layers = [layer("loose-z", "Zoo", 0), layer("loose-a", "Alpha", 1), layer("z", "zebra", 2), layer("a", "Apple", 3), layer("same", "Apple", 4), layer("inside", "Inside", 5)];
  const tree = [{kind: "group", id: "folder", title: "Survey", children: [
    {kind: "layer", layerId: "z"}, {kind: "layer", layerId: "a"}, {kind: "layer", layerId: "same"},
    {kind: "group", id: "nested", title: "Other", children: [{kind: "layer", layerId: "inside"}]}
  ]}];
  const before = structuredClone({tree, layers});
  const sorted = sortProjectLayerSiblings(tree, layers, "folder");
  assert.deepEqual(sorted.tree[0].children.map(node => node.layerId ?? node.id), ["a", "same", "nested", "z"]);
  assert.deepEqual(sorted.layers.map(item => item.layerId), ["loose-z", "loose-a", "a", "same", "inside", "z"]);
  assert.deepEqual(orderedProjectLayerTree(sorted.tree, sorted.layers), sorted.tree);
  assert.deepEqual(normalizeProjectLayerOrder(sorted.layers, sorted.tree), sorted.layers);
  assert.deepEqual({tree, layers}, before, "sort mutated source identities or ordering");
  assert.equal(sorted.layers.find(item => item.layerId === "a"), layers[3]);
  const rootSorted = sortProjectLayerSiblings(sorted.tree, sorted.layers);
  assert.deepEqual(rootSorted.layers.slice(0, 2).map(item => item.layerId), ["loose-a", "loose-z"]);
  assert.deepEqual(rootSorted.tree[0].children, sorted.tree[0].children, "root sorting recursively sorted another folder");
  assert.throws(() => sortProjectLayerSiblings(tree, layers, "missing"), /existing destination/);
  assert.throws(() => sortProjectLayerSiblings(tree, layers, "folder", "random"), /supported sort/);
});

it("KML name sorting and indexed moves retain duplicate-name IDs and unchanged nested contents", () => {
  const original = kmlDocument();
  const nestedIds = original.children[0].children.map(place => place.id);
  const sorted = sortKmlPlaceSiblings(original, original.id, "descending");
  assert.deepEqual(sorted.children.map(place => place.name), ["Zulu", "Survey", "Apple", "Apple"]);
  assert.deepEqual(sorted.children.find(place => place.name === "Survey").children.map(place => place.id), nestedIds);
  assert.deepEqual(sorted.children.filter(place => place.name === "Apple").map(place => place.id), ["apple", "apple-2"]);
  assert.deepEqual(original.children.map(place => place.name), ["Survey", "Zulu", "Apple", "Apple"]);
  const moved = moveKmlPlace(sorted, "apple-2", sorted.id, 0);
  assert.equal(moved.children[0].id, "apple-2");
  const roundTrip = parseKml(exportKml(moved), {DOMParser: harness.dom.window.DOMParser}).document;
  assert.deepEqual(roundTrip.children.map(place => place.id), moved.children.map(place => place.id));
  assert.throws(() => sortKmlPlaceSiblings(original, "apple"), error => error.code === "places_parent_invalid");
});

it("named views capture an independent camera and retain primary state, identity and the eight-view bound", () => {
  const map = fakeMap();
  const input = [primary];
  const views = addNamedMapView(map, input, "  Harbor  ", "harbor");
  assert.deepEqual(input, [primary]);
  assert.equal(views[0].id, "primary");
  assert.deepEqual(views[1], {...savedView, center: [-70.5, 41.5], zoom: 11, pitch: 30, bearing: 15});
  const renamed = renameNamedMapView(views, "harbor", "Port");
  assert.deepEqual(renamed[1], {...views[1], title: "Port"});
  assert.deepEqual(removeNamedMapView(renamed, "harbor"), [views[0]]);
  assert.throws(() => renameNamedMapView(views, "primary", "No"), /named view/);
  assert.throws(() => removeNamedMapView(views, "primary"), /named view/);
  assert.throws(() => addNamedMapView(map, views, "Duplicate", "harbor"), /unique saved/);
  assert.throws(() => renameNamedMapView(views, "harbor", " "), /view name/);
  let full = views;
  for (let i = 0; i < 6; i++) full = addNamedMapView(map, full, `View ${i}`, `new-${i}`);
  assert.equal(full.length, 8);
  assert.throws(() => addNamedMapView(map, full, "Overflow", "overflow"), /seven named/);
  assert.deepEqual(mapViewsForSave(fakeMap({center: [10, 20]}), full).slice(1), full.slice(1));
});

it("sorts a project folder through visible controls and saves/reopens the exact hierarchy and stack", async () => {
  const saved = [];
  const layers = [layer("z", "Zulu", 0), layer("a", "Apple", 1)];
  const tree = [{kind: "group", id: "folder", title: "Survey", children: [{kind: "layer", layerId: "z"}, {kind: "layer", layerId: "a"}]}];
  const shell = mount({layers, project: project({layerTree: tree}), saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  shell.querySelector('select[aria-label="Destination folder"]').value = "folder";
  button(shell, "Sort folder by name").click();
  assert.deepEqual(shell.__opengeoLayers.map(item => item.layerId), ["a", "z"]);
  button(shell, "Save").click(); await waitFor(() => saved.length === 1);
  assert.deepEqual(saved[0].layerTree[0].children.map(item => item.layerId), ["a", "z"]);
  assert.deepEqual(saved[0].layers.map(item => [item.layerId, item.order]), [["a", 0], ["z", 1]]);
  const reopened = mount({layers: saved[0].layers, project: project(saved[0])});
  assert.deepEqual(reopened.__opengeoLayers.map(item => item.layerId), ["a", "z"]);
  assert.deepEqual(reopened.getPrintContext().project.layerTree, saved[0].layerTree);
});

it("KML controls save/reopen folder expansion, visibility and place order without changing IDs", async () => {
  const saved = [];
  const shell = mount({project: project({kmlPlaces: kmlDocument()}), saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  button(shell, "Sort KML folder by name").click();
  assert.equal(document.activeElement, button(shell, "Sort KML folder by name"), "sorting lost command focus during render");
  const folder = [...shell.querySelectorAll('[data-place-id]')].find(item => item.dataset.placeId === "survey");
  const details = folder.querySelector("details");
  details.open = false;
  details.dispatchEvent(new harness.dom.window.Event("toggle"));
  const checkbox = [...shell.querySelectorAll('[data-place-id]')].find(item => item.dataset.placeId === "survey").querySelector('input[type="checkbox"]');
  checkbox.checked = false;
  checkbox.dispatchEvent(new harness.dom.window.Event("change"));
  button(shell, "Edit Zulu").click();
  button(shell, "Move Zulu up").click();
  button(shell, "Move Zulu up").click();
  button(shell, "Move Zulu up").click();
  assert.equal(button(shell, "Move Zulu up").disabled, true);
  assert.equal(document.activeElement, button(shell, "Move Zulu down"), "first sibling did not focus its enabled ordering command");
  button(shell, "Move Zulu down").click();
  button(shell, "Move Zulu down").click();
  button(shell, "Move Zulu down").click();
  assert.equal(button(shell, "Move Zulu down").disabled, true);
  assert.equal(document.activeElement, button(shell, "Move Zulu up"), "last sibling did not focus its enabled ordering command");
  button(shell, "Move Zulu up").click();
  button(shell, "Save").click(); await waitFor(() => saved.length === 1);
  const retained = saved[0].kmlPlaces;
  assert.deepEqual(retained.children.map(place => place.id), ["apple", "apple-2", "zulu", "survey"]);
  const survey = retained.children.find(place => place.id === "survey");
  assert.equal(survey.open, false); assert.equal(survey.visibility, false);
  const reopened = mount({project: project(saved[0]), layers: saved[0].layers});
  const restoredFolder = [...reopened.querySelectorAll('[data-place-id]')].find(item => item.dataset.placeId === "survey");
  assert.equal(restoredFolder.querySelector("details").open, false);
  assert.equal(restoredFolder.querySelector('input[type="checkbox"]').checked, false);
  assert.deepEqual(reopened.getPrintContext().project.kmlPlaces, retained);
});

it("renames/removes saved views through project controls and Save/fresh mount preserves the named camera", async () => {
  const saved = [];
  const shell = mount({project: project({mapViews: [primary, savedView]}), saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  const name = shell.querySelector('[data-saved-view-id="harbor"] input');
  name.value = "Port";
  button(shell, "Rename Harbor").click();
  button(shell, "Save").click(); await waitFor(() => saved.length === 1);
  assert.deepEqual(saved[0].mapViews[1], {...savedView, title: "Port"});
  const reopened = mount({project: project(saved[0])});
  assert.equal(reopened.querySelector('[data-saved-view-id="harbor"] input').value, "Port");
  button(reopened, "Remove Port").click();
  assert.deepEqual(reopened.getPrintContext().project.mapViews, [primary]);
  assert.equal(button(reopened, "Save current view").disabled, true, "unavailable map must not save a fallback camera");
});

it("view-only project controls reject mutations while allowing hierarchy inspection", () => {
  const shell = mount({role: "viewer", project: project({mapViews: [primary, savedView], kmlPlaces: kmlDocument()}), layers: [layer("a", "Apple", 0)]});
  assert.equal(button(shell, "Sort folder by name").disabled, true);
  assert.equal(button(shell, "Sort KML folder by name").disabled, true);
  assert.equal(button(shell, "Rename Harbor").disabled, true);
  assert.equal(button(shell, "Remove Harbor").disabled, true);
  assert.equal(shell.querySelector('[data-place-id="survey"] input[type="checkbox"]').disabled, true);
  const before = shell.getPrintContext().project.kmlPlaces;
  const details = shell.querySelector('[data-place-id="survey"] details');
  details.open = false; details.dispatchEvent(new harness.dom.window.Event("toggle"));
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces, before);
  button(shell, "Edit Zulu").click();
  assert.equal(button(shell, "Move Zulu up").disabled, true);
  assert.equal(button(shell, "Move Zulu down").disabled, true);
  let changed = false;
  const standalone = LayerFolders({tree: [], layers: [layer("a", "Apple", 0)], readOnly: true, onApply: () => changed = true});
  standalone.querySelector("form").dispatchEvent(new harness.dom.window.Event("submit", {cancelable: true}));
  assert.equal(changed, false);
});

function layer(layerId, title, order) {
  return {layerId, datasetId: null, title, sourceType: "geojson-object", geometryType: "Point", visible: true, opacity: 1, order, style: {}, labels: {enabled: false, field: null}};
}
function project(overrides = {}) {return {projectId: PROJECT, title: "Organization fixture", mapViews: [primary], ...overrides};}
function kmlDocument() {
  let document = createPlacesDocument();
  document = addKmlPlace(document, document.id, {kind: "folder", name: "Survey"});
  for (const name of ["Zulu", "Apple", "Apple"]) document = addKmlPlace(document, document.id, {kind: "placemark", name, geometry: {type: "Point", coordinates: [-71, 42]}});
  document = addKmlPlace(document, "survey", {kind: "placemark", name: "Nested", geometry: {type: "Point", coordinates: [-70, 41]}});
  return document;
}
function mount(overrides = {}) {
  const shell = WorkbenchView({workspace: {workspaceId: ROOT, title: "Organization fixture", classification: "internal"}, role: "owner", project: project(), layers: [], datasets: [],
    persistenceMode: "api", restoreBrowserDraft: false, storage: {provider: "memory", bucket: "fixture", region: "local", prefix: "fixture"}, ...overrides});
  document.body.append(shell); harness.shells.push(shell); return shell;
}
function button(root, label) {
  const item = [...root.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  assert.ok(item, `expected button ${label}`); return item;
}
function fakeMap({center = [-70.5, 41.5]} = {}) {return {getCenter: () => ({lng: center[0], lat: center[1]}), getZoom: () => 11, getPitch: () => 30, getBearing: () => 15};}
async function waitFor(check) {for (let i = 0; i < 30; i++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 0));} assert.fail("UI callback did not settle");}
function installDom() {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"});
  const values = {document: dom.window.document, location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, DOMParser: dom.window.DOMParser, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}), addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window), requestAnimationFrame: fn => {fn(); return 1;}, cancelAnimationFrame() {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true};
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});}
  return {dom, shells: [], restore() {for (const [key, descriptor] of previous) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}}};
}
