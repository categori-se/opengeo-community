import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {nativeProjectViewRuntime} from "../scripts/build-maplibre-render-bundle.mjs";

it("native grouped controls follow queued/programmatic visibility and apply checkbox changes consistently", async () => {
  const payload = {style: {version: 8, sources: {}, layers: [
    {id: "fill", type: "fill", source: "areas"}, {id: "outline", type: "line", source: "areas"}
  ]}, view: {center: [0,0], zoom: 5, pitch: 0, bearing: 0}, images: [], controls: [{title: "Study areas", ids: ["fill", "outline"], visible: true}]};
  const text = `const artifact={attribution:'Synthetic',license:'CC0'};const publication=${JSON.stringify(payload)};` + await nativeProjectViewRuntime();
  const {createView} = await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
  const dom = new JSDOM("<!doctype html><body></body>");
  class MapPeer {
    constructor(options) {this.options = options;this.events = new Map();this.visibility = new Map();}
    on(type, fn) {this.events.set(type, fn);}off(type) {this.events.delete(type);}addLayer() {}
    setLayoutProperty(id, _key, value) {this.visibility.set(id, value);}remove() {this.removed = true;}
    getCenter() {return {toArray: () => [0,0]};}getZoom() {return 5;}getPitch() {return 0;}getBearing() {return 0;}
  }
  try {
    const view = createView({maplibre: {Map: MapPeer}, document: dom.window.document});dom.window.document.body.append(view);
    const control = view.querySelector('input[type="checkbox"]');assert.equal(control.checked, true);
    view.setLayerVisibility("fill", false);assert.equal(view.map.visibility.size, 0);
    view.map.events.get("load")();assert.equal(control.checked, false);assert.equal(control.indeterminate, true);
    view.setLayerVisibility("outline", false);assert.equal(control.indeterminate, false);assert.equal(control.checked, false);
    // Synchronization during the first paint change must not change the
    // checkbox intent subsequently applied to the rest of the group.
    control.checked = true;control.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual([...view.map.visibility.values()], ["visible", "visible"]);assert.equal(control.checked, true);assert.equal(control.indeterminate, false);
    control.checked = false;control.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual([...view.map.visibility.values()], ["none", "none"]);assert.equal(control.checked, false);
    view.setLayerVisibility("fill", true);assert.equal(control.indeterminate, true);
    view.dispose();assert.equal(view.map.removed, true);assert.equal(view.map.events.size, 0);
    assert.throws(() => view.setLayerVisibility("fill", false), /disposed/);
  } finally {dom.window.close();}
});
