import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {addMapLayer} from "../src/components/WorkbenchView.js";
import {installLoadedMapLayers, isMapLayerHandleInstalled, isCurrentPersistedLayer, persistedLayerSourceIdentity} from "../src/lib/loadedLayerInstallation.js";

function fixture(secondSourceType = "governed-dataset") {
  const upper = {layerId: "upper", sourceType: secondSourceType};
  const lower = {layerId: "lower", sourceType: "governed-dataset"};
  const layers = [upper, lower];
  const map = {ready: true, isStyleLoaded() { return this.ready; },
    on() { assert.fail("Installation must reuse readiness notifications, not add handlers"); }};
  let currentMap = map;
  const dataByLayerId = new Map([["lower", {features: ["lower polygon"]}]]);
  const layerHandles = new Map();
  const installations = [], orders = [];
  const options = {getMap: () => currentMap, layers, dataByLayerId, layerHandles,
    install(layer, data) {
      installations.push({id: layer.layerId, data});
      layerHandles.set(layer.layerId, {});
      // MapLibre reports not style-loaded while this new source is parsing.
      map.ready = false;
    },
    syncOrder() { orders.push([...layers].reverse().filter(layer => layerHandles.has(layer.layerId)).map(layer => layer.layerId)); }};
  return {upper, lower, map, options, installations, orders, setMap(value) { currentMap = value; }};
}

describe("cached persisted map layer installation", () => {
  for (const sourceType of ["governed-dataset", "geojson-archive"]) {
    it(`installs a cached ${sourceType} after the first source finishes parsing`, () => {
      const view = fixture(sourceType);
      assert.equal(installLoadedMapLayers(view.options), 1);
      view.options.dataByLayerId.set("upper", {features: ["upper polygon"]});
      assert.equal(installLoadedMapLayers(view.options), 0, "Cached data waits while source parsing makes readiness false");
      assert.deepEqual(view.installations.map(({id}) => id), ["lower"]);
      view.map.ready = true; // Existing idle callback invokes the same cache-only installer.
      assert.equal(installLoadedMapLayers(view.options), 1);
      assert.deepEqual(view.installations.map(({id}) => id), ["lower", "upper"]);
      assert.deepEqual(view.orders, [["lower"], ["lower", "upper"]]);
      view.map.ready = true;
      assert.equal(installLoadedMapLayers(view.options), 0);
      assert.equal(view.installations.length, 2, "Repeated readiness never duplicates layers or feature handlers");
    });
  }

  it("uses current layer membership and order when delayed data becomes installable", () => {
    const view = fixture();
    view.options.dataByLayerId.set("upper", {});
    view.map.ready = false;
    assert.equal(installLoadedMapLayers(view.options), 0);
    view.options.layers.reverse();
    view.map.ready = true;
    assert.equal(installLoadedMapLayers(view.options), 1);
    assert.equal(view.installations[0].id, "upper");
    view.options.layers.splice(view.options.layers.indexOf(view.lower), 1);
    view.map.ready = true;
    assert.equal(installLoadedMapLayers(view.options), 0, "Removed layer is not resurrected from its cached data");
  });

  it("retires stale GL handles and restores cached data after sources or paint layers disappear", () => {
    const sources = new Map(), paints = new Map(), handlers = new Set();
    let removedHandlers = 0, installations = 0;
    const map = {ready: true, isStyleLoaded() { return this.ready; },
      getStyle() { return this.styleDocument; },
      getSource: id => sources.get(id), getLayer: id => paints.get(id),
      addSource(id, value) { sources.set(id, value); this.ready = false; },
      addLayer(value) { paints.set(value.id, value); },
      removeSource(id) { sources.delete(id); }, removeLayer(id) { paints.delete(id); },
      on(type, id, handler) { handlers.add(handler); },
      off(type, id, handler) { assert(handlers.delete(handler)); removedHandlers++; }};
    const layer = {layerId: "field-sites", sourceType: "governed-dataset", geometryType: "Point",
      visible: true, opacity: 1, style: {circleColor: "#14b8a6", circleRadius: 7}};
    const data = {type: "FeatureCollection", features: [{type: "Feature", properties: {},
      geometry: {type: "Point", coordinates: [-77.04, 38.91]}}]};
    const state = {map, layerHandles: new Map()};
    const options = {getMap: () => map, layers: [layer], dataByLayerId: new Map([[layer.layerId, data]]),
      layerHandles: state.layerHandles, allowPendingSources: true,
      install(current, cached, options) { assert.equal(cached, data); installations++; addMapLayer(state, current, cached, [], options); },
      syncOrder() {}};
    assert.equal(installLoadedMapLayers(options), 1);
    assert.equal(handlers.size, 3);
    map.ready = true;
    assert.equal(installLoadedMapLayers(options), 0, "Live source/paint identities are reused");

    sources.clear(); paints.clear(); // A replacement style discarded GL content, not the handle.
    map.ready = false;
    assert.equal(installLoadedMapLayers(options), 0, "Wait for the replacement style document");
    map.styleDocument = {version: 8};
    assert.equal(map.isStyleLoaded(), false, "Unrelated sources are still loading");
    assert.equal(installLoadedMapLayers(options), 1, "Install from the cache as soon as the style is writable");
    assert.equal(removedHandlers, 3, "Normal disposal retires stale interaction handlers");
    assert.equal(sources.get("field-sites-source").data, data, "Reuse the same data without another read");
    assert(paints.has("field-sites-points"));

    map.ready = true;
    paints.delete("field-sites-points"); // A surviving source alone does not establish installation.
    assert.equal(installLoadedMapLayers(options), 1);
    assert.equal(removedHandlers, 6);
    assert.equal(handlers.size, 3, "Partial content does not accumulate feature handlers");
    assert.equal(sources.get("field-sites-source").data, data);
    assert(paints.has("field-sites-points"));
    map.ready = true;
    assert.equal(installLoadedMapLayers(options), 0);
    assert.equal(installations, 3, "Each loss repairs once; repeated readiness never reinstalls live content");
    paints.clear();
    assert.equal(isMapLayerHandleInstalled(map, {...state.layerHandles.get(layer.layerId), cog: {}}), true,
      "An asynchronous COG session owns its pending content lifecycle");
    assert.equal(isMapLayerHandleInstalled({isStyleLoaded: () => true}, state.layerHandles.get(layer.layerId)), true,
      "Native adapters without GL accessors keep their existing lifecycle");
  });

  it("stops if the owning map changes and never installs without a current map", () => {
    const view = fixture();
    view.options.dataByLayerId.set("upper", {});
    const install = view.options.install;
    view.options.install = (...args) => { install(...args); view.setMap(null); };
    assert.equal(installLoadedMapLayers(view.options), 1);
    assert.equal(view.installations.length, 1);
    assert.equal(view.orders.length, 0, "No ordering mutation is sent to a replaced map");
    assert.equal(installLoadedMapLayers(view.options), 0);
  });

  it("does not register empty, external, or already-installed sources", () => {
    const view = fixture();
    view.lower.sourceType = "external-feature-reference";
    view.options.dataByLayerId.set("upper", {});
    view.options.layerHandles.set("upper", {});
    assert.equal(installLoadedMapLayers(view.options), 0);
    assert.equal(view.installations.length, 0);
  });

  it("rejects stale preview/archive completions but permits presentation-only changes", () => {
    for (const sourceType of ["governed-dataset", "geojson-archive"]) {
      const layer = {layerId: "layer", sourceType, datasetId: "dataset", datasetVersionId: "v1",
        sourceUrl: "https://archive.invalid/exact", sourceConfiguration: {checksum: "old"}, style: {fill: "#123456"}};
      const context = {layers: [layer], disposed: false};
      const identity = persistedLayerSourceIdentity(layer);
      layer.style.fill = "#654321";
      assert.equal(isCurrentPersistedLayer(context, layer, identity), true);
      context.layerArchiveModes = new Map([[layer.layerId, "loading"]]);
      assert.equal(isCurrentPersistedLayer(context, layer, identity), false, "A late saved-data response must not overwrite selected tiles");
      context.layerArchiveModes.clear();
      layer.datasetVersionId = "v2";
      assert.equal(isCurrentPersistedLayer(context, layer, identity), false);
      layer.datasetVersionId = "v1";
      layer.sourceConfiguration.checksum = "new";
      assert.equal(isCurrentPersistedLayer(context, layer, identity), false);
      layer.sourceConfiguration.checksum = "old";
      context.layers = [{...layer}];
      assert.equal(isCurrentPersistedLayer(context, layer, identity), false);
      context.layers = [layer];
      context.disposed = true;
      assert.equal(isCurrentPersistedLayer(context, layer, identity), false);
    }
  });
});
