import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {POINT_SYMBOLS, normalizePointSymbolStyle, pointSymbolImages, pointSymbolImageId,
  pointSymbolStyleParts, pointSymbolPreviewSvg} from "../src/lib/pointSymbols.js";
import {WorkbenchView, addMapLayer, removeMapLayer, setLayerOpacity} from "../src/components/WorkbenchView.js";

const geojson = {type: "FeatureCollection", features: ["hospital", "clinic"].map((kind, id) => ({
  type: "Feature", id, properties: {kind}, geometry: {type: "Point", coordinates: [-71 + id / 10, 42]}
}))};
const point = (layerId, extra = {}) => ({layerId, datasetId: `dataset-${layerId}`, title: layerId,
  sourceType: "governed-dataset", geometryType: "Point", visible: true, opacity: .6, order: 0,
  style: {circleColor: "#1166aa", circleRadius: 10}, labels: {}, ...extra});
let dom, previous, shells;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "https://studio.opengeo.tools/workspaces"});
  previous = new Map(); shells = [];
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  for (const [name, value] of Object.entries({document: dom.window.document, location: dom.window.location,
    history: dom.window.history, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
    DOMParser: dom.window.DOMParser, localStorage: dom.window.localStorage, matchMedia: () => media,
    addEventListener: dom.window.addEventListener.bind(dom.window), removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: callback => {callback(); return 1;}, cancelAnimationFrame() {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true})) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
});
afterEach(() => {
  for (const shell of shells) {shell.dispose?.(); shell.remove();}
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
  dom.window.close();
});
function mount(layers = [point("Hospitals")], options = {}) {
  const shell = WorkbenchView({workspace: {workspaceId: "point-workspace", name: "Point workspace"},
    role: "editor", project: {projectId: "point-project", title: "Medical services", layers: []},
    layers, datasets: [], geojsonByLayerId: new Map(layers.map(layer => [layer.layerId, geojson])),
    persistenceMode: "fixture", restoreBrowserDraft: false, ...options});
  document.body.append(shell); shells.push(shell); return shell;
}
function button(root, label) {
  const found = [...root.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  assert.ok(found, `Button ${label}`); return found;
}
function field(root, label) {
  const found = [...root.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent === label);
  assert.ok(found, `Field ${label}`); return found.querySelector("select,input");
}
function change(control, value) {control.value = value; control.dispatchEvent(new dom.window.Event("change", {bubbles: true}));}
function mapState() {
  const layers = new Map(), images = new Map(), sources = new Map();
  const map = {getStyle: () => ({layers: [...layers.values()]}), getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, structuredClone(layer)), removeLayer: id => layers.delete(id),
    getSource: id => sources.get(id), addSource: (id, source) => sources.set(id, source), removeSource: id => sources.delete(id),
    hasImage: id => images.has(id), addImage: (id, pixels, options) => images.set(id, {pixels, options}), removeImage: id => images.delete(id),
    setPaintProperty: (id, property, value) => layers.get(id).paint[property] = value,
    on() {}, off() {}, getCanvas: () => ({style: {}})};
  return {map, layerHandles: new Map(), resolvedLayerStyles: new Map(), archiveTileSessions: new Map(), images, sources, layers};
}

describe("built-in point symbology", {concurrency: false}, () => {
  it("provides deterministic original bounded images and rejects unknown or unsafe definitions", () => {
    assert.deepEqual(POINT_SYMBOLS.slice(0, 6).map(item => item.id), ["circle", "hospital", "clinic", "school", "star", "flag"]);
    const signatures = [];
    for (const {id} of POINT_SYMBOLS.slice(0, 6)) {
      const [{pixels, pixelRatio}] = pointSymbolImages({pointSymbol: id});
      assert.deepEqual([pixels.width, pixels.height, pixels.data.length, pixelRatio], [64, 64, 16384, 2]);
      signatures.push(Buffer.from(pixels.data).toString("base64"));
      assert.equal(pixels.data.some((value, index) => index % 4 === 3 && value), id !== "circle");
      const copy = pointSymbolImages({pointSymbol: id})[0].pixels;
      pixels.data.fill(99); assert.notDeepEqual(copy.data, pixels.data);
    }
    assert.equal(new Set(signatures).size, 6);
    for (const invalid of [{pointSymbol: "https://example.test/icon.svg"}, {circleRadius: Infinity}, {circleRadius: 99},
      {categorySymbols: JSON.parse('{"__proto__":"hospital"}')},
      {categorySymbols: Object.fromEntries(Array.from({length: 49}, (_, i) => [`c${i}`, "hospital"]))}]) {
      assert.throws(() => normalizePointSymbolStyle(invalid));
    }
    const preview = pointSymbolPreviewSvg({pointSymbol: "hospital", circleColor: '" onload="alert(1)'});
    assert.match(preview, /<svg/); assert.doesNotMatch(preview, /onload|script|https:\/\//);
    for (const circleRadius of [1, 32]) {
      const style = {circleRadius, renderer: "category", categoryField: "legacy_".repeat(30), circleColor: "#1166aa"};
      const legacy = point("Legacy circles", {style});
      assert.deepEqual(pointSymbolStyleParts(legacy), []);
      const state = mapState(); addMapLayer(state, legacy, geojson, []);
      assert.equal(state.layers.get("Legacy circles-points").paint["circle-radius"], circleRadius);
      const shell = mount([legacy]); button(shell, "Style Legacy circles").click();
      assert.deepEqual(shell.__opengeoLayers[0].style, style);
    }
  });

  it("renders governed and PMTiles points with preserved category colors, visibility, opacity and shared image ownership", () => {
    const state = mapState();
    const first = point("medical", {style: {renderer: "category", categoryField: "kind", circleColor: "#1166aa", circleRadius: 10,
      pointSymbol: "circle", categorySymbols: {hospital: "hospital", clinic: "clinic"}}});
    const second = point("tiled", {sourceType: "pmtiles-vector", sourceUrl: "https://example.test/medical.pmtiles", sourceLayer: "medical",
      geometryType: "MultiPoint", visible: false, style: {...first.style}});
    addMapLayer(state, first, geojson, []); addMapLayer(state, second, null, []);
    assert.equal(state.layers.get("medical-points").paint["circle-color"][0], "match");
    const overlay = state.layers.get("medical-point-symbol");
    assert.deepEqual(overlay.layout["icon-image"], ["match", ["to-string", ["get", "kind"]],
      "hospital", pointSymbolImageId("hospital"), "clinic", pointSymbolImageId("clinic"), pointSymbolImageId("circle")]);
    assert.equal(overlay.layout["icon-size"], .625); assert.equal(overlay.paint["icon-opacity"], .6);
    assert.equal(state.layers.get("tiled-point-symbol").layout.visibility, "none");
    assert.equal(state.layers.get("tiled-point-symbol")["source-layer"], "medical");
    setLayerOpacity(state, "medical", .25); assert.equal(state.layers.get("medical-point-symbol").paint["icon-opacity"], .25);
    removeMapLayer(state, "medical"); assert.equal(state.images.has(pointSymbolImageId("hospital")), true);
    removeMapLayer(state, "tiled"); assert.equal(state.images.size, 0);
    assert.deepEqual(pointSymbolStyleParts(point("plain")), []);
  });

  it("opens symbology through an accessible swatch while retaining selection and stable tool placement", () => {
    const shell = mount(undefined, {projectSwitcher: {initial: []}}), toolbar = shell.querySelector(".gis-primary-toolbar"), projectPicker = shell.querySelector(".gis-workspace-select");
    assert.ok(toolbar); assert.ok(projectPicker);
    const location = () => ({toolbarParent: shell.querySelector(".gis-primary-toolbar").parentElement.className,
      pickerParent: shell.querySelector(".gis-workspace-select").parentElement.className,
      pickerBeforeTools: Boolean(shell.querySelector(".gis-workspace-select").compareDocumentPosition(shell.querySelector(".gis-primary-toolbar")) & 4)});
    const initialLocation = location();
    const row = shell.querySelector(".gis-layer-row");
    button(row, "Select layer Hospitals").click(); assert.equal(shell.classList.contains("right-collapsed"), true);
    const swatch = button(row, "Style Hospitals"); assert.equal(swatch.type, "button"); swatch.click();
    assert.equal(shell.classList.contains("right-collapsed"), false);
    assert.ok(shell.querySelector('.gis-panel-right [aria-label="Point symbols"]'));
    const symbology = [...shell.querySelectorAll(".gis-panel-right h3")].find(node => node.textContent === "Symbology");
    const filter = [...shell.querySelectorAll(".gis-panel-right h3")].find(node => node.textContent === "Map filter");
    assert.ok(symbology && filter); assert.ok(symbology.compareDocumentPosition(filter) & 4, "Point controls precede the map filter");
    const library = shell.querySelector(".gis-style-library-link"); assert.match(library.href, /view=styles/); assert.equal(library.target, "_blank");
    assert.deepEqual(location(), initialLocation);
    button(shell, "Hospital point symbol").click();
    assert.equal(shell.__opengeoLayers[0].style.pointSymbol, "hospital");
    assert.equal(button(shell, "Hospital point symbol").getAttribute("aria-pressed"), "true");
    const navStyle = [...shell.querySelectorAll('.gis-app-nav a')].find(link => link.textContent === "Styles");
    assert.ok(navStyle, "Studio navigation retains Styles when the Project switcher is active");
    assert.equal(new URL(navStyle.href).searchParams.get("view"), "styles");
    const more = shell.querySelector('.gis-mobile-toolbar [data-primary-command="more"]'); assert.ok(more); more.click();
    const mobileStyle = [...shell.querySelectorAll('.gis-mobile-command-navigation a')].find(link => link.textContent === "Styles");
    assert.ok(mobileStyle, "Mobile Browse navigation includes Styles");
    assert.equal(mobileStyle.href, navStyle.href);
    const demo = mount(undefined, {publicDemo: true, demoSurface: true, persistenceMode: "demo"});
    button(demo, "Style Hospitals").click();
    const demoLibrary = demo.querySelector(".gis-style-library-link");
    assert.equal(demoLibrary.textContent, "Styles library in Studio ↗");
    assert.equal(new URL(demoLibrary.href).origin, "https://studio.opengeo.tools");
    assert.equal(new URL(demoLibrary.href).pathname, "/workspaces");
    assert.equal(new URL(demoLibrary.href).searchParams.get("view"), "styles");
    assert.ok(demo.querySelector('[aria-label="Point symbols"]'), "Demo retains inline point controls");
  });

  it("selects hospital and clinic symbols by category and retains exact settings through deliberate save and reopen", async () => {
    let saved, saves = 0;
    const layers = [point("Facilities", {style: {renderer: "category", categoryField: "kind", circleColor: "#1166aa", circleRadius: 10}})];
    const shell = mount(layers, {saveProject: async definition => {
      saved = structuredClone(definition); saves++; return {id: "point-project", version: 2, updatedAt: new Date().toISOString(), definition};
    }});
    button(shell, "Style Facilities").click();
    change(field(shell, "Symbol for hospital"), "hospital"); change(field(shell, "Symbol for clinic"), "clinic");
    assert.equal(saves, 0);
    button(shell, "Save").click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(saves, 1); assert.deepEqual(saved.layers[0].style.categorySymbols, {hospital: "hospital", clinic: "clinic"});
    const reopened = mount(saved.layers, {project: {...saved, projectId: "point-project"}});
    button(reopened, "Style Facilities").click();
    assert.equal(field(reopened, "Symbol for hospital").value, "hospital"); assert.equal(field(reopened, "Symbol for clinic").value, "clinic");
  });

  it("applies a chosen single-symbol style to selected compatible points without using visibility or replacing a pinned Style", () => {
    const reference = {projectId: "10000000-0000-4000-8000-000000000001", resourceId: "10000000-0000-4000-8000-000000000002",
      styleId: "10000000-0000-4000-8000-000000000003", versionNumber: 1, format: "maplibre", checksumSha256: "a".repeat(64)};
    const shell = mount([point("Hospitals"), point("Clinics", {visible: false}),
      point("Pinned", {styleReference: reference}), point("Boundary", {geometryType: "Polygon"})]);
    button(shell, "Style Hospitals").click(); button(shell, "Hospital point symbol").click();
    const target = shell.querySelector('input[aria-label="Apply point style to Clinics"]'); target.checked = true;
    target.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
    assert.match(shell.querySelector(".gis-point-style-feedback").textContent, /2 compatible/);
    assert.equal(shell.querySelector('input[aria-label="Apply point style to Pinned"]').disabled, true);
    assert.match(shell.querySelector(".gis-point-style-batch").textContent, /Pinned · skipped: saved Style pinned/);
    button(shell, "Apply single-symbol style to selected Layers").click();
    const [first, second, pinned, boundary] = shell.__opengeoLayers;
    assert.equal(first.style.pointSymbol, "hospital"); assert.equal(second.style.pointSymbol, "hospital");
    assert.equal(second.visible, false); assert.deepEqual(pinned.styleReference, reference); assert.equal(boundary.style.pointSymbol, undefined);
  });

  it("keeps hosted viewers read-only even for dispatched control events while allowing local Demo authoring", () => {
    const shell = mount(undefined, {role: "viewer"}); button(shell, "Style Hospitals").click();
    const before = structuredClone(shell.__opengeoLayers[0]);
    const hospital = button(shell, "Hospital point symbol"); assert.equal(hospital.disabled, true);
    hospital.dispatchEvent(new dom.window.MouseEvent("click", {bubbles: true}));
    const renderer = field(shell, "Renderer"); change(renderer, "category");
    assert.deepEqual(shell.__opengeoLayers[0], before);
    const demo = mount(undefined, {role: "viewer", publicDemo: true, demoSurface: true, persistenceMode: "demo"});
    button(demo, "Style Hospitals").click(); button(demo, "Clinic point symbol").click();
    assert.equal(demo.__opengeoLayers[0].style.pointSymbol, "clinic");
  });
});
