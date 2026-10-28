import assert from "node:assert/strict";
import {test} from "node:test";
import {createGlRendererAdapter, rendererAdapterFor} from "../src/lib/glRendererAdapter.js";

function sdk(name) {
  return {
    getVersion: () => "fixture",
    protocols: [],
    addProtocol(name, handler) { this.protocols.push({name, handler}); },
    Map: class {
      constructor(options) { this.options = options; this.removals = 0; }
      remove() { this.removals++; }
    },
    Popup: class { engine = name; },
    LngLatBounds: class { engine = name; }
  };
}

test("two SDKs retain independent map/protocol ownership and cleanup", () => {
  const first = sdk("first"), second = sdk("second");
  const a = createGlRendererAdapter({id:"first", engine:first});
  const b = createGlRendererAdapter({id:"second", engine:second});
  const handler = () => {};
  for (const adapter of [a, b, a, b]) adapter.registerProtocol("archive", handler);
  assert.equal(first.protocols.length, 1);
  assert.equal(second.protocols.length, 1);
  assert.throws(() => a.registerProtocol("archive", () => {}), /protocol_conflict/);
  const options = {center:[85, 27], zoom:4};
  const mapA = a.createMap(options), mapB = b.createMap(options);
  assert.deepEqual(mapA.options, options);
  assert.equal(rendererAdapterFor(mapB, a).createPopup({}).engine, "second");
  assert.equal(rendererAdapterFor(mapA, b).createBounds().engine, "first");
  assert.throws(() => b.disposeMap(mapA), /owner_mismatch/);
  assert.equal(mapA.removals, 0);
  a.disposeMap(mapA);
  a.disposeMap(mapA);
  assert.equal(mapA.removals, 1);
  assert.equal(mapB.removals, 0);
  b.disposeMap(mapB);
});

test("failed protocol setup can retry without replaying successful registration", () => {
  const engine = sdk("first");
  let reject = true;
  engine.addProtocol = function(name, handler) {
    if (name === "second" && reject) throw new Error("unsupported");
    this.protocols.push({name, handler});
  };
  const adapter = createGlRendererAdapter({id:"first", engine});
  const handler = () => {};
  adapter.registerProtocol("first", handler);
  assert.throws(() => adapter.registerProtocol("second", handler), /unsupported/);
  reject = false;
  adapter.registerProtocol("first", handler);
  adapter.registerProtocol("second", handler);
  assert.deepEqual(engine.protocols.map(p => p.name), ["first", "second"]);
});

test("partial graphics initialization is rejected before resize and failed owned teardown stays idempotent", () => {
  const engine = sdk("partial");let removals = 0, detached = 0, partial;
  engine.Map = class {
    constructor() {partial=this;}
    getCanvas() { return {remove() {detached++;}}; }
    remove() {removals++;throw Error("missing painter");}
  };
  const adapter = createGlRendererAdapter({id:"partial", engine, requiresPainter:true});
  assert.throws(() => adapter.createMap({}), /renderer_graphics_unavailable/);
  assert.equal(Object.hasOwn(partial,"painter"),false,"Actual failed MapLibre constructor never assigns painter");
  assert.equal(removals, 1);assert.equal(detached, 1);

  engine.Map = class {
    painter = {};
    getCanvas() { return {remove() {detached++;}}; }
    remove() {removals++;throw Error("lost context");}
  };
  const map = adapter.createMap({});
  assert.doesNotThrow(() => adapter.disposeMap(map));
  assert.doesNotThrow(() => adapter.disposeMap(map));
  assert.equal(removals, 2);assert.equal(detached, 2);
});
