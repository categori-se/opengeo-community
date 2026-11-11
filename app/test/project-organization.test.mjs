import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {afterEach, beforeEach, it} from "node:test";
import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {editLayerFolders, LayerFolders} from "../src/components/LayerFolders.js";
import {normalizeProjectLayerOrder, orderedProjectLayerTree, sortProjectLayerSiblings} from "../src/lib/layerOrder.js";
import {addKmlPlace, createPlacesDocument, exportKml, moveKmlPlace, parseKml, sortKmlPlaceSiblings} from "../src/lib/kmlPlaces.js";
import {addNamedMapView, mapViewsForSave, moveNamedMapView, removeNamedMapView, renameNamedMapView} from "../src/lib/globeView.js";
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

it("KML tree dragging inserts before and after siblings and ordinary Save/reopen/export retain the exact Places", async () => {
  const saved = [], original = kmlDocument();
  const shell = mount({project: project({kmlPlaces: original}), saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  const handle = kmlDragHandle(shell, "apple-2");
  assert.equal(handle.tagName, "BUTTON");
  assert.equal(handle.draggable, true);
  assert.equal(handle.getAttribute("aria-label"), "Drag Apple to move");
  dragKmlPlace(shell, "apple-2", "zulu", 5, "before");
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces.children.map(place => place.id), ["survey", "apple-2", "zulu", "apple"]);
  dragKmlPlace(shell, "apple-2", "apple", 95, "after");
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces.children.map(place => place.id), ["survey", "zulu", "apple", "apple-2"], "moving down must adjust the destination index after removing the dragged sibling");
  dragKmlPlace(shell, "zulu", "apple", 95, "after");
  const expected = {...original, children: [original.children[0], original.children[2], original.children[1], original.children[3]]};
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces, expected);
  button(shell, "Save").click(); await waitFor(() => saved.length === 1);
  assert.deepEqual(saved[0].kmlPlaces, expected);
  const reopened = mount({project: project(saved[0]), layers: saved[0].layers});
  const retained = reopened.getPrintContext().project.kmlPlaces;
  assert.deepEqual(retained, expected);
  assert.deepEqual(parseKml(exportKml(retained), {DOMParser: harness.dom.window.DOMParser}).document, expected);
});

it("KML tree dragging reparents Places and whole folders at the document root without losing content or allowing cycles", () => {
  let original = kmlDocument();
  original = addKmlPlace(original, "survey", {kind: "folder", name: "Field"});
  original = addKmlPlace(original, "field", {kind: "placemark", name: "Observation", description: "Keep this survey record", geometry: {type: "Point", coordinates: [-72, 43, 12]}});
  original.children[0].open = false;
  const shell = mount({project: project({kmlPlaces: original})});
  const current = () => shell.getPrintContext().project.kmlPlaces;
  const content = document => {
    const places = [];
    const visit = place => {const {children, ...fields} = place; places.push(fields); for (const child of children ?? []) visit(child);};
    visit(document); return places.sort((a, b) => a.id.localeCompare(b.id));
  };
  dragKmlPlace(shell, "zulu", "survey", 5, "before");
  assert.deepEqual(current().children.map(place => place.id), ["zulu", "survey", "apple", "apple-2"]);
  dragKmlPlace(shell, "zulu", "survey", 95, "after");
  assert.deepEqual(current().children.map(place => place.id), ["survey", "zulu", "apple", "apple-2"]);
  dragKmlPlace(shell, "zulu", "survey", 50, "inside");
  assert.deepEqual(current().children[0].children.map(place => place.id), ["nested", "field", "zulu"]);
  assert.deepEqual(current().children.map(place => place.id), ["survey", "apple", "apple-2"]);
  const collapsedFolder = shell.querySelector('[data-place-id="survey"] > details');
  assert.equal(collapsedFolder.open, false, "dropping into a folder must preserve its collapsed state");
  assert.equal(document.activeElement, collapsedFolder.querySelector(":scope > summary"), "drop focus must stay visible on the collapsed destination folder");
  const beforeCycle = structuredClone(current());
  dragKmlPlace(shell, "survey", "field", 50);
  assert.deepEqual(current(), beforeCycle, "a folder cannot be inserted inside its descendant");
  dragKmlPlace(shell, "field", "field", 50);
  assert.deepEqual(current(), beforeCycle, "a folder cannot contain itself");
  dragKmlPlace(shell, "field", original.id, 50, "inside");
  assert.deepEqual(current().children.map(place => place.id), ["survey", "apple", "apple-2", "field"]);
  assert.deepEqual(current().children.at(-1), original.children[0].children[1], "moving a folder keeps its full descendant subtree");
  assert.deepEqual(current().children[0].children.map(place => place.id), ["nested", "zulu"]);
  assert.deepEqual(content(current()), content(original), "every Place keeps its ID, metadata and geometry");
});

it("KML tree dragging rejects foreign payloads, viewers, detached handlers, Layer switches and lost account authority", () => {
  const original = kmlDocument();
  const shell = mount({project: project({kmlPlaces: original})});
  const foreign = mount({project: project({kmlPlaces: original})});
  const viewer = mount({role: "viewer", project: project({kmlPlaces: original})});
  const unchanged = root => assert.deepEqual(root.getPrintContext().project.kmlPlaces, original);
  const external = kmlDataTransfer({"application/x-opengeo-kml-place": "zulu", "text/plain": "zulu"});
  dispatchKmlDrag("dragover", kmlDropTarget(shell, "apple"), external, 5);
  dispatchKmlDrag("drop", kmlDropTarget(shell, "apple"), external, 5);
  unchanged(shell);

  const mismatched = kmlDataTransfer();
  dispatchKmlDrag("dragstart", kmlDragHandle(shell, "zulu"), mismatched);
  mismatched.setData("application/x-opengeo-kml-place", "apple");
  dispatchKmlDrag("drop", kmlDropTarget(shell, "apple"), mismatched, 95);
  unchanged(shell);
  dispatchKmlDrag("dragend", kmlDragHandle(shell, "zulu"), mismatched);

  const crossShell = kmlDataTransfer();
  dispatchKmlDrag("dragstart", kmlDragHandle(shell, "zulu"), crossShell);
  dispatchKmlDrag("drop", kmlDropTarget(foreign, "apple"), crossShell, 95);
  unchanged(shell); unchanged(foreign);
  dispatchKmlDrag("dragend", kmlDragHandle(shell, "zulu"), crossShell);

  const viewerHandle = kmlDragHandle(viewer, "zulu");
  assert.equal(viewerHandle.disabled, true);
  assert.equal(viewerHandle.draggable, false);
  viewerHandle.disabled = false; viewerHandle.draggable = true;
  const denied = kmlDataTransfer();
  dispatchKmlDrag("dragstart", viewerHandle, denied);
  dispatchKmlDrag("drop", kmlDropTarget(viewer, "apple"), denied, 95);
  unchanged(viewer);

  const staleHandle = kmlDragHandle(shell, "zulu"), staleTarget = kmlDropTarget(shell, "apple"), staleTransfer = kmlDataTransfer();
  dispatchKmlDrag("dragstart", staleHandle, staleTransfer);
  button(shell, "Edit Zulu").click();
  assert.equal(staleHandle.isConnected, false);
  dispatchKmlDrag("drop", kmlDropTarget(shell, "apple"), staleTransfer, 95);
  unchanged(shell);
  dispatchKmlDrag("dragstart", staleHandle, staleTransfer);
  dispatchKmlDrag("drop", staleTarget, staleTransfer, 95);
  unchanged(shell);

  const documents = [original, {...structuredClone(original), name: "Second document"}];
  const layers = documents.map((document, index) => ({...layer(`kml-${index}`, `Places ${index + 1}`, index), sourceType: "kml-places", kmlDocument: document}));
  const browser = mount({publicDemo: true, project: project({kmlLayerDocuments: true, kmlPlaces: original, activeLayerId: "kml-0", layers}), layers});
  const contextTransfer = kmlDataTransfer();
  dispatchKmlDrag("dragstart", kmlDragHandle(browser, "zulu"), contextTransfer);
  button(browser, "Select layer Places 2").click();
  dispatchKmlDrag("drop", kmlDropTarget(browser, "apple"), contextTransfer, 95);
  assert.deepEqual(browser.getPrintContext().project.layers.map(layer => layer.kmlDocument), documents, "colliding Place IDs do not authorize a move across KML Layers");

  const revokedTransfer = kmlDataTransfer();
  dispatchKmlDrag("dragstart", kmlDragHandle(shell, "zulu"), revokedTransfer);
  harness.dom.window.dispatchEvent(new harness.dom.window.Event("opengeo:account-navigation"));
  dispatchKmlDrag("drop", kmlDropTarget(shell, "apple"), revokedTransfer, 95);
  unchanged(shell);
});

it("reorders named cameras through controls and preserves order through Save and reopen", async () => {
  const second = {...savedView, id: "hill", title: "Hill", center: [12, 48]};
  const original = [primary, savedView, second];
  const moved = moveNamedMapView(original, "hill", -1);
  assert.deepEqual(moved, [primary, second, savedView]);
  assert.deepEqual(original, [primary, savedView, second]);
  assert.throws(() => moveNamedMapView(original, "primary", 1), /named view/);
  assert.throws(() => moveNamedMapView(original, "harbor", -1), /end of the list/);
  assert.throws(() => moveNamedMapView(original, "hill", 2), /adjacent/);
  const saved = [];
  const shell = mount({project: project({mapViews: original}),
    saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  assert.equal(button(shell, "Move Harbor up").disabled, true);
  const stale = button(shell, "Move Hill up");
  stale.click();
  assert.deepEqual(shell.getPrintContext().project.mapViews, moved);
  stale.click();
  assert.deepEqual(shell.getPrintContext().project.mapViews, moved);
  const draftReopen = mount({project: project({mapViews: original}), restoreBrowserDraft: true});
  assert.deepEqual(draftReopen.getPrintContext().project.mapViews, moved);
  const viewer = mount({role: "viewer", project: project({mapViews: original})});
  const forbidden = button(viewer, "Move Hill up");
  assert.equal(forbidden.disabled, true);
  forbidden.dispatchEvent(new harness.dom.window.Event("click"));
  assert.deepEqual(viewer.getPrintContext().project.mapViews, original);
  button(shell, "Save").click();
  await waitFor(() => saved.length === 1);
  assert.deepEqual(saved[0].mapViews, moved);
  const reopened = mount({project: project(saved[0])});
  assert.deepEqual([...reopened.querySelectorAll("[data-saved-view-id]")].map(row => row.dataset.savedViewId), ["hill", "harbor"]);
  assert.equal(button(reopened, "Move Hill up").disabled, true);
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

it("browser Project reopen keeps one per-Layer KML document when its top-level compatibility alias is present", () => {
  const document = kmlDocument();
  document.children.find(place => place.id === "zulu").view = {
    type: "Camera", longitude: -71, latitude: 42, altitude: 1500, heading: 30, tilt: 45, roll: 45, altitudeMode: "absolute"
  };
  const importedLayer = {...layer("kml-camera", "Camera places", 0), sourceType: "kml-places", kmlDocument: document};
  const saved = project({kmlLayerDocuments: true, kmlPlaces: document, layers: [importedLayer], activeLayerId: importedLayer.layerId});
  const shell = mount({publicDemo: true, project: saved, layers: saved.layers});
  const retained = shell.getPrintContext().project;
  const reopened = mount({publicDemo: true, project: retained, layers: retained.layers});
  for (const mounted of [shell, reopened]) {
    assert.deepEqual(mounted.__opengeoLayers.map(item => item.layerId), ["kml-camera"]);
    const current = mounted.getPrintContext().project;
    assert.equal(current.kmlLayerDocuments, true);
    assert.deepEqual(current.layers.map(item => item.layerId), ["kml-camera"]);
    assert.deepEqual(current.layers[0].kmlDocument, document);
    assert.deepEqual(current.kmlPlaces, document);
    assert.deepEqual(current.layers[0].kmlDocument.children.find(place => place.id === "zulu").view,
      document.children.find(place => place.id === "zulu").view);
  }
});

it("KML view editing retains optional camera fields through Save/reopen/export and recovers invalid drafts without changing the Place", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => globalThis.fetch = originalFetch);
  globalThis.fetch = () => assert.fail("KML view editing must not request providers or APIs");
  const saved = [], original = kmlDocument();
  const place = original.children.find(item => item.id === "zulu");
  place.view = {type: "Camera", longitude: 0, latitude: 42, altitude: 0, heading: 0, tilt: 120, roll: 0, altitudeMode: "gx:relativeToSeaFloor"};
  place.geometry.coordinates.push(120);
  place.altitudeMode = "absolute";
  place.extendedData = {survey: "retained"};
  const shell = mount({project: project({kmlPlaces: original}), saveProject: async value => {saved.push(structuredClone(value)); return {version: 2};}});
  const viewField = (root, key) => root.querySelector(`[data-kml-view-field="${key}"]`);
  const change = (root, key, value) => {
    const input = viewField(root, key); assert.ok(input, `expected KML view field ${key}`);
    input.value = value;
    input.dispatchEvent(new harness.dom.window.Event(input.tagName === "SELECT" ? "change" : "input", {bubbles: true}));
  };
  const retainedPlace = root => root.getPrintContext().project.kmlPlaces.children.find(item => item.id === "zulu");
  button(shell, "Edit Zulu").click();
  assert.match(shell.querySelector('.gis-kml-view-editor').textContent, /Project Save and KML export retain this view.*Fly to opens supported Camera and LookAt views/);
  assert.equal(viewField(shell, "longitude").value, "0");
  assert.equal(viewField(shell, "altitude").value, "0");
  assert.equal(viewField(shell, "altitudeMode").value, "gx:relativeToSeaFloor");
  assert.equal(viewField(shell, "range").disabled, true);
  const staleApply = button(shell, "Apply place edits");
  staleApply.click();
  assert.deepEqual(retainedPlace(shell), place, "Metadata-only Apply must retain the imported camera and other Place fields");
  change(shell, "type", "LookAt");
  assert.equal(viewField(shell, "roll").disabled, true);
  assert.equal(viewField(shell, "range").disabled, false);
  change(shell, "longitude", " ");
  change(shell, "altitude", "");
  change(shell, "tilt", "45");
  change(shell, "range", "0");
  change(shell, "altitudeMode", "gx:clampToSeaFloor");
  change(shell, "latitude", "not a number");
  button(shell, "Apply place edits").click();
  assert.deepEqual(retainedPlace(shell), place);
  assert.equal(viewField(shell, "latitude").value, "not a number");
  assert.equal(viewField(shell, "latitude").getAttribute("aria-invalid"), "true");
  assert.equal(document.activeElement, viewField(shell, "latitude"));
  assert.match(shell.querySelector('[data-status-field="message"]').textContent, /Enter a finite number.*latitude/);
  button(shell, "Edit Zulu").click();
  assert.equal(viewField(shell, "latitude").value, "not a number", "A rerender must keep the recoverable raw draft");
  assert.equal(viewField(shell, "type").value, "LookAt");
  change(shell, "latitude", "91");
  button(shell, "Apply place edits").click();
  assert.deepEqual(retainedPlace(shell), place, "Model validation must leave the existing Place intact");
  assert.match(shell.querySelector('[data-status-field="message"]').textContent, /latitude must be -90 to 90 degrees/);
  assert.equal(document.activeElement, viewField(shell, "latitude"));
  change(shell, "latitude", "0");
  button(shell, "Apply place edits").click();
  const expected = {...place, view: {type: "LookAt", latitude: 0, heading: 0, tilt: 45, range: 0, altitudeMode: "gx:clampToSeaFloor"}};
  assert.deepEqual(retainedPlace(shell), expected, "Blank fields stay absent, zero remains explicit, and Camera roll is omitted");
  staleApply.click();
  assert.deepEqual(retainedPlace(shell), expected, "A detached editor handler must not overwrite the new view");
  button(shell, "Save").click(); await waitFor(() => saved.length === 1);
  assert.deepEqual(saved[0].kmlPlaces.children.find(item => item.id === "zulu"), expected);
  const reopened = mount({project: project(saved[0]), layers: saved[0].layers});
  button(reopened, "Edit Zulu").click();
  assert.equal(viewField(reopened, "type").value, "LookAt");
  assert.equal(viewField(reopened, "longitude").value, "");
  assert.equal(viewField(reopened, "latitude").value, "0");
  const persisted = reopened.getPrintContext().project.kmlPlaces;
  assert.deepEqual(parseKml(exportKml(persisted), {DOMParser: harness.dom.window.DOMParser}).document, persisted);
  change(reopened, "type", "Camera");
  change(reopened, "roll", "0");
  button(reopened, "Apply place edits").click();
  assert.deepEqual(retainedPlace(reopened), {...expected, view: {type: "Camera", latitude: 0, heading: 0, tilt: 45, roll: 0, altitudeMode: "gx:clampToSeaFloor"}});
  change(reopened, "type", "none");
  button(reopened, "Apply place edits").click();
  assert.deepEqual(retainedPlace(reopened), {...expected, view: null}, "Removing a saved KML view is explicit and preserves the rest of the Place");
  assert.equal(parseKml(exportKml(reopened.getPrintContext().project.kmlPlaces), {DOMParser: harness.dom.window.DOMParser}).document.children.find(item => item.id === "zulu").view, null);
});

it("KML navigation exposes document, folder and view-only viewpoints without silently framing unsupported cameras", () => {
  const places = kmlDocument();
  const view = {type: "LookAt", longitude: -71, latitude: 42, altitude: 300, heading: 30, tilt: 45, range: 1200, altitudeMode: "absolute"};
  places.view = structuredClone(view);
  places.children[0].view = structuredClone(view);
  places.children.find(place => place.id === "zulu").view = {...view, altitudeMode: "gx:relativeToSeaFloor"};
  const viewOnly = places.children.find(place => place.id === "apple");
  viewOnly.view = structuredClone(view);viewOnly.geometry = null;
  const shell = mount({project: project({kmlPlaces: places})});
  const before = structuredClone(shell.getPrintContext().project.kmlPlaces);
  for (const label of [`Fly to ${places.name}`, "Fly to Survey", "Fly to Apple", "Fly to Zulu"]) {
    assert.equal(button(shell, label).disabled, false);
  }
  assert.ok(button(shell, "Frame geometry of Zulu"));
  const stale = button(shell, "Fly to Zulu");
  button(shell, "Fly to Apple").click();
  assert.match(shell.querySelector('[data-status-field="message"]').textContent, /map is not ready/);
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces, before);
  button(shell, "Edit Zulu").click();
  const message = shell.querySelector('[data-status-field="message"]').textContent;
  stale.click();
  assert.equal(shell.querySelector('[data-status-field="message"]').textContent, message, "detached navigation must not act on a current map");
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
  const apply = button(shell, "Apply place edits");
  const viewType = shell.querySelector('[data-kml-view-field="type"]');
  assert.equal(apply.disabled, true);
  assert.equal(viewType.disabled, true);
  apply.disabled = false; viewType.disabled = false; viewType.value = "Camera";
  apply.click();
  assert.deepEqual(shell.getPrintContext().project.kmlPlaces, before, "The handler must enforce current edit authority independently of disabled controls");
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
function kmlDragHandle(root, id) {
  const item = root.querySelector(`[data-kml-drag-handle="${id}"]`);
  assert.ok(item, `expected KML drag handle ${id}`); return item;
}
function kmlDropTarget(root, id) {
  const item = root.querySelector(`[data-kml-drop-target="${id}"]`);
  assert.ok(item, `expected KML drop target ${id}`);
  item.getBoundingClientRect = () => ({top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100});
  return item;
}
function kmlDataTransfer(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {effectAllowed: "uninitialized", dropEffect: "none", get types() {return [...data.keys()];},
    setData(type, value) {data.set(type, String(value));}, getData(type) {return data.get(type) ?? "";}, clearData() {data.clear();}};
}
function dispatchKmlDrag(type, target, dataTransfer, clientY = 50) {
  const event = new harness.dom.window.Event(type, {bubbles: true, cancelable: true});
  Object.defineProperties(event, {dataTransfer: {value: dataTransfer}, clientY: {value: clientY}});
  target.dispatchEvent(event); return event;
}
function dragKmlPlace(root, sourceId, targetId, clientY, position) {
  const handle = kmlDragHandle(root, sourceId), target = kmlDropTarget(root, targetId), transfer = kmlDataTransfer();
  dispatchKmlDrag("dragstart", handle, transfer);
  assert.ok(transfer.types.includes("application/x-opengeo-kml-place"), "drag must identify its native KML Place payload");
  const over = dispatchKmlDrag("dragover", target, transfer, clientY);
  if (position) {
    assert.equal(over.defaultPrevented, true, "an accepted native drop must allow dropping");
    assert.equal(target.dataset.kmlDropPosition, position);
  }
  dispatchKmlDrag("drop", target, transfer, clientY);
  dispatchKmlDrag("dragend", handle, transfer);
  assert.equal(root.querySelector("[data-kml-drop-position]"), null, "drop feedback must clear at the end of a drag");
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

it("authors mixed geometry controls and a time range without losing unedited settings through Save/reopen/KML", async t => {
  const originalFetch=globalThis.fetch;t.after(()=>globalThis.fetch=originalFetch);
  globalThis.fetch=()=>assert.fail("Place properties must not request a provider or API");
  const original=kmlDocument(),source=original.children.find(place=>place.id==="zulu"),saved=[];
  source.geometry={type:"GeometryCollection",geometries:[
    {type:"Point",coordinates:[0,0,0],kmlControls:{altitudeMode:"absolute",extrude:true,tessellate:false}},
    {type:"LineString",coordinates:[[0,0,5],[1,1,10]],kmlControls:{altitudeMode:"relativeToGround",extrude:false,tessellate:true}}
  ]};source.altitudeMode="absolute";source.extrude=true;source.tessellate=false;
  const current=root=>root.getPrintContext().project.layers.find(layer=>layer.sourceType==="kml-places").kmlDocument;
  const field=(root,kind,key)=>root.querySelector(`[data-kml-${kind}-field="${key}"]`);
  const change=(root,kind,key,value)=>{const input=field(root,kind,key);assert.ok(input,key);input.value=value;input.dispatchEvent(new harness.dom.window.Event("change",{bubbles:true}));return input;};
  const shell=mount({project:project({kmlPlaces:original}),saveProject:async value=>{saved.push(structuredClone(value));return {version:2};}});
  button(shell,"Edit Zulu").click();const stale=button(shell,"Apply place edits");
  assert.equal(field(shell,"geometry","altitudeMode").value,"mixed");assert.equal(field(shell,"geometry","extrude").value,"mixed");
  shell.querySelector('[data-kml-editing-field="name"]').value="Survey geometry";button(shell,"Apply place edits").click();
  let retained=current(shell).children.find(place=>place.id==="zulu");assert.deepEqual(retained.geometry,source.geometry);
  stale.click();assert.equal(current(shell).children.find(place=>place.id==="zulu").name,"Survey geometry");
  change(shell,"geometry","altitudeMode","absolute");change(shell,"geometry","tessellate","false");
  change(shell,"time","type","TimeSpan");change(shell,"time","begin","2024-02-29");change(shell,"time","end","2024-02-28");
  const unchanged=structuredClone(current(shell));button(shell,"Apply place edits").click();assert.deepEqual(current(shell),unchanged);
  assert.equal(field(shell,"time","end").getAttribute("aria-invalid"),"true");assert.equal(document.activeElement,field(shell,"time","end"));
  assert.match(shell.textContent,/End must not be earlier than Begin/);
  button(shell,"Edit Survey geometry").click();assert.equal(field(shell,"time","begin").value,"2024-02-29");assert.equal(field(shell,"geometry","altitudeMode").value,"absolute");
  change(shell,"time","end","2024-03-01T00:00:00Z");button(shell,"Apply place edits").click();
  retained=current(shell).children.find(place=>place.id==="zulu");
  assert.deepEqual(retained.time,{type:"TimeSpan",begin:"2024-02-29",end:"2024-03-01T00:00:00Z"});
  assert.deepEqual(retained.geometry.geometries.map(geometry=>geometry.kmlControls),[
    {altitudeMode:"absolute",extrude:true,tessellate:false},{altitudeMode:"absolute",extrude:false,tessellate:false}
  ]);assert.deepEqual(retained.geometry.geometries.map(geometry=>geometry.coordinates),source.geometry.geometries.map(geometry=>geometry.coordinates));
  button(shell,"Save").click();await waitFor(()=>saved.length===1);
  assert.equal(saved[0].schemaVersion,"opengeo.map-definition.1.7.0");assert.equal(saved[0].kmlPlaces,null);
  const reopened=mount({project:project(saved[0]),layers:saved[0].layers});assert.equal(reopened.__opengeoLayers.length,1);
  assert.deepEqual(current(reopened),current(shell));
  assert.deepEqual(parseKml(exportKml(current(reopened)),{DOMParser:harness.dom.window.DOMParser}).document,current(reopened));
});

it("edits explicit Point altitude and timestamp, recovers invalid drafts and enforces viewer controls", async () => {
  const original=kmlDocument(),saved=[],current=root=>root.getPrintContext().project.layers.find(layer=>layer.sourceType==="kml-places").kmlDocument;
  const field=(root,kind,key)=>root.querySelector(`[data-kml-${kind}-field="${key}"]`);
  const change=(root,kind,key,value)=>{const input=field(root,kind,key);input.value=value;input.dispatchEvent(new harness.dom.window.Event("change",{bubbles:true}));};
  const shell=mount({project:project({kmlPlaces:original}),saveProject:async value=>{saved.push(structuredClone(value));return {version:2};}});
  button(shell,"Edit Zulu").click();assert.equal(field(shell,"geometry","pointAltitude").value,"");assert.equal(field(shell,"geometry","tessellate"),null);
  const name=shell.querySelector('[data-kml-editing-field="name"]');name.value="x".repeat(8193);button(shell,"Apply place edits").click();
  assert.deepEqual(current(shell),original);assert.equal(field(shell,"time","end").getAttribute("aria-invalid"),null);
  assert.match(shell.querySelector('[data-status-field="message"]').textContent,/kml_text_too_long/);name.value="Zulu";
  change(shell,"time","type","TimeStamp");change(shell,"time","when","2023-02-29");button(shell,"Apply place edits").click();
  assert.deepEqual(current(shell),original);assert.equal(field(shell,"time","when").getAttribute("aria-invalid"),"true");
  change(shell,"time","when","2024-02-29T24:00:00Z");change(shell,"geometry","pointAltitude","not a number");button(shell,"Apply place edits").click();
  assert.deepEqual(current(shell),original);assert.equal(document.activeElement,field(shell,"geometry","pointAltitude"));
  button(shell,"Edit Zulu").click();assert.equal(field(shell,"geometry","pointAltitude").value,"not a number");
  change(shell,"geometry","pointAltitude","0");change(shell,"geometry","altitudeMode","relativeToGround");change(shell,"geometry","extrude","true");button(shell,"Apply place edits").click();
  let place=current(shell).children.find(place=>place.id==="zulu");
  assert.equal(place.geometry.coordinates.length,3);assert.equal(place.geometry.coordinates[2],0);assert.equal(place.altitudeMode,"relativeToGround");assert.equal(place.extrude,true);
  assert.deepEqual(place.time,{type:"TimeStamp",when:"2024-02-29T24:00:00Z"});
  button(shell,"Save").click();await waitFor(()=>saved.length===1);
  const reopened=mount({project:project(saved[0]),layers:saved[0].layers});button(reopened,"Edit Zulu").click();assert.equal(field(reopened,"geometry","pointAltitude").value,"0");
  assert.deepEqual(parseKml(exportKml(current(reopened)),{DOMParser:harness.dom.window.DOMParser}).document,current(reopened));
  change(reopened,"geometry","pointAltitude","");change(reopened,"time","type","none");button(reopened,"Apply place edits").click();
  place=current(reopened).children.find(place=>place.id==="zulu");assert.equal(place.geometry.coordinates.length,2);assert.equal(place.time,null);
  const viewer=mount({role:"viewer",project:project(saved[0]),layers:saved[0].layers});button(viewer,"Edit Zulu").click();
  for(const input of viewer.querySelectorAll('[data-kml-time-field],[data-kml-geometry-field]'))assert.equal(input.disabled,true);
  assert.equal(button(viewer,"Apply place edits").disabled,true);
});
